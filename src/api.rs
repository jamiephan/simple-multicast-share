use std::{
    collections::BTreeMap,
    io::{Read, Seek, SeekFrom, Write},
    path::Path as FsPath,
};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{
        header::{self, HeaderMap, HeaderValue},
        Method, Response, StatusCode,
    },
    Json,
};
use futures_util::StreamExt;
use rusqlite::{blob::ZeroBlob, params, DatabaseName};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    archive, db,
    error::{ApiError, ApiResult},
    AppState,
};

const MAX_TEXT_SIZE: i64 = 16 * 1024 * 1024;
const STREAM_CHUNK: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
}

pub async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default = "root_id")]
    parent_id: i64,
}

fn root_id() -> i64 {
    1
}

pub async fn list_items(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<Vec<db::Item>>> {
    let connection = db::connect(&state.db_path)?;
    db::require_folder(&connection, query.parent_id)?;
    let mut statement = connection.prepare(
        "SELECT id, parent_id, name, kind, mime,
                CASE WHEN kind = 'file' THEN length(content) ELSE 0 END,
                revision, created_at, updated_at
         FROM items WHERE parent_id = ?1
         ORDER BY kind = 'file', name COLLATE NOCASE, id",
    )?;
    let values = statement
        .query_map([query.parent_id], |row| {
            Ok(db::Item {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                mime: row.get(4)?,
                size: row.get(5)?,
                revision: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(values))
}

pub async fn get_item(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<db::Item>> {
    let connection = db::connect(&state.db_path)?;
    Ok(Json(db::item(&connection, id)?))
}

#[derive(Deserialize)]
pub struct FolderInput {
    #[serde(default = "root_id")]
    parent_id: i64,
    name: String,
}

pub async fn create_folder(
    State(state): State<AppState>,
    Json(input): Json<FolderInput>,
) -> ApiResult<(StatusCode, Json<db::Item>)> {
    let connection = db::connect(&state.db_path)?;
    let value = db::insert_folder(&connection, input.parent_id, &input.name)?;
    Ok((StatusCode::CREATED, Json(value)))
}

#[derive(Deserialize)]
pub struct UpdateItem {
    name: Option<String>,
    parent_id: Option<i64>,
}

pub async fn update_item(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<UpdateItem>,
) -> ApiResult<Json<db::Item>> {
    if id == 1 {
        return Err(ApiError::BadRequest(
            "the root folder cannot be changed".into(),
        ));
    }
    if input.name.is_none() && input.parent_id.is_none() {
        return Err(ApiError::BadRequest("no changes were supplied".into()));
    }
    let mut connection = db::connect(&state.db_path)?;
    let transaction = connection.transaction()?;
    let current = db::item(&transaction, id)?;
    let name = input.name.as_deref().unwrap_or(&current.name);
    db::validate_name(name)?;
    let parent_id = input
        .parent_id
        .or(current.parent_id)
        .ok_or_else(|| ApiError::BadRequest("only the root folder may have no parent".into()))?;
    db::require_folder(&transaction, parent_id)?;
    if current.kind == "folder" {
        let creates_cycle: bool = transaction.query_row(
            "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM items WHERE id = ?1
                UNION ALL
                SELECT items.id FROM items JOIN descendants ON items.parent_id = descendants.id
             )
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![id, parent_id],
            |row| row.get(0),
        )?;
        if creates_cycle {
            return Err(ApiError::BadRequest(
                "a folder cannot be moved into itself or its descendants".into(),
            ));
        }
    }
    transaction
        .execute(
            "UPDATE items SET name = ?1, parent_id = ?2, revision = revision + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?3",
            params![name, parent_id, id],
        )
        .map_err(db::map_write_error)?;
    transaction.commit()?;
    Ok(Json(db::item(&connection, id)?))
}

pub async fn delete_item(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    if id == 1 {
        return Err(ApiError::BadRequest(
            "the root folder cannot be deleted".into(),
        ));
    }
    let connection = db::connect(&state.db_path)?;
    if connection.execute("DELETE FROM items WHERE id = ?1", [id])? == 0 {
        return Err(ApiError::NotFound(format!("item {id} does not exist")));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct UploadQuery {
    #[serde(default = "root_id")]
    parent_id: i64,
    name: String,
    mime: Option<String>,
}

#[derive(Deserialize)]
pub struct ReplaceQuery {
    mime: Option<String>,
    expected_revision: Option<i64>,
}

#[derive(Default, Deserialize)]
pub struct DownloadQuery {
    disposition: Option<String>,
    mime: Option<String>,
}

pub async fn create_file(
    State(state): State<AppState>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<(StatusCode, Json<db::Item>)> {
    db::validate_name(&query.name)?;
    let mime = query
        .mime
        .or_else(|| header_string(&headers, header::CONTENT_TYPE));
    let upload_id = stage_upload(&state, &headers, body).await?;
    let result = (|| {
        let connection = db::connect(&state.db_path)?;
        db::require_folder(&connection, query.parent_id)?;
        connection
            .execute(
                "INSERT INTO items(parent_id, name, kind, mime, content)
                 SELECT ?1, ?2, 'file', ?3, content FROM pending_uploads WHERE id = ?4",
                params![query.parent_id, query.name, mime, upload_id],
            )
            .map_err(db::map_write_error)?;
        db::item(&connection, connection.last_insert_rowid())
    })();
    cleanup_upload(&state.db_path, upload_id);
    Ok((StatusCode::CREATED, Json(result?)))
}

pub async fn replace_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<ReplaceQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<db::Item>> {
    let connection = db::connect(&state.db_path)?;
    db::require_file(&connection, id)?;
    drop(connection);
    let mime = query
        .mime
        .or_else(|| header_string(&headers, header::CONTENT_TYPE));
    let upload_id = stage_upload(&state, &headers, body).await?;
    let result = (|| {
        let connection = db::connect(&state.db_path)?;
        let changed = connection.execute(
            "UPDATE items
             SET content = (SELECT content FROM pending_uploads WHERE id = ?1),
                 mime = COALESCE(?2, mime), revision = revision + 1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?3 AND kind = 'file'
               AND (?4 IS NULL OR revision = ?4)",
            params![upload_id, mime, id, query.expected_revision],
        )?;
        if changed == 0 {
            if db::item(&connection, id).is_err() {
                return Err(ApiError::NotFound(format!("file {id} does not exist")));
            }
            return Err(ApiError::Conflict("file revision has changed".into()));
        }
        db::item(&connection, id)
    })();
    cleanup_upload(&state.db_path, upload_id);
    Ok(Json(result?))
}

async fn stage_upload(state: &AppState, headers: &HeaderMap, body: Body) -> ApiResult<i64> {
    let length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ApiError::BadRequest("Content-Length is required for uploads".into()))?;
    let blob_length = i32::try_from(length).map_err(|_| {
        ApiError::PayloadTooLarge(
            "file exceeds the SQLite incremental BLOB API's platform limit".into(),
        )
    })?;
    let connection = db::connect(&state.db_path)?;
    connection.execute(
        "INSERT INTO pending_uploads(content) VALUES(?1)",
        [ZeroBlob(blob_length)],
    )?;
    let upload_id = connection.last_insert_rowid();
    drop(connection);

    let write_result: ApiResult<u64> = async {
        let mut stream = body.into_data_stream();
        let mut offset = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|error| ApiError::BadRequest(format!("upload stream failed: {error}")))?;
            let next = offset
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| ApiError::PayloadTooLarge("upload size overflow".into()))?;
            if next > length {
                return Err(ApiError::BadRequest(
                    "request body exceeds Content-Length".into(),
                ));
            }
            let db_path = (*state.db_path).clone();
            let bytes = chunk.to_vec();
            tokio::task::spawn_blocking(move || -> ApiResult<()> {
                let connection = db::connect(&db_path)?;
                let mut blob = connection.blob_open(
                    DatabaseName::Main,
                    "pending_uploads",
                    "content",
                    upload_id,
                    false,
                )?;
                blob.seek(SeekFrom::Start(offset))
                    .map_err(|error| ApiError::Internal(error.to_string()))?;
                blob.write_all(&bytes)
                    .map_err(|error| ApiError::Internal(error.to_string()))?;
                Ok(())
            })
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))??;
            offset = next;
        }
        Ok(offset)
    }
    .await;
    let offset = match write_result {
        Ok(offset) => offset,
        Err(error) => {
            cleanup_upload(&state.db_path, upload_id);
            return Err(error);
        }
    };
    if offset != length {
        cleanup_upload(&state.db_path, upload_id);
        return Err(ApiError::BadRequest(format!(
            "request body contained {offset} bytes, expected {length}"
        )));
    }
    Ok(upload_id)
}

fn cleanup_upload(path: &FsPath, upload_id: i64) {
    if let Ok(connection) = db::connect(path) {
        let _ = connection.execute("DELETE FROM pending_uploads WHERE id = ?1", [upload_id]);
    }
}

pub async fn download_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<DownloadQuery>,
    method: Method,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    let connection = db::connect(&state.db_path)?;
    let item = db::require_file(&connection, id)?;
    let (start, end, partial) = match headers.get(header::RANGE) {
        Some(value) => {
            let value = value
                .to_str()
                .map_err(|_| ApiError::RangeNotSatisfiable("invalid Range header".into()))?;
            let (start, end) = parse_range(value, item.size as u64)?;
            (start, end, true)
        }
        None => (0, item.size.saturating_sub(1) as u64, false),
    };
    let response_length = if item.size == 0 { 0 } else { end - start + 1 };
    let content_type = query
        .mime
        .as_deref()
        .or(item.mime.as_deref())
        .unwrap_or("application/octet-stream");
    let content_type = HeaderValue::from_str(content_type)
        .map_err(|_| ApiError::BadRequest("invalid preview MIME type".into()))?;
    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, response_length)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "{}; filename=\"{}\"",
                if query.disposition.as_deref() == Some("inline") {
                    "inline"
                } else {
                    "attachment"
                },
                safe_header_filename(&item.name)
            ),
        )
        .header(header::ETAG, format!("\"{}-{}\"", item.id, item.revision));
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", item.size),
        );
    }

    let body = if method == Method::HEAD || item.size == 0 {
        Body::empty()
    } else {
        let path = (*state.db_path).clone();
        Body::from_stream(async_stream::stream! {
            let mut position = start;
            while position <= end {
                let amount = (end - position + 1).min(STREAM_CHUNK) as usize;
                let db_path = path.clone();
                let result = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
                    let connection = db::connect(&db_path).map_err(std::io::Error::other)?;
                    let mut blob = connection
                        .blob_open(DatabaseName::Main, "items", "content", id, true)
                        .map_err(std::io::Error::other)?;
                    blob.seek(SeekFrom::Start(position))?;
                    let mut bytes = vec![0; amount];
                    blob.read_exact(&mut bytes)?;
                    Ok(bytes)
                })
                .await;
                match result {
                    Ok(Ok(bytes)) => {
                        position += bytes.len() as u64;
                        yield Ok::<Vec<u8>, std::io::Error>(bytes);
                    }
                    Ok(Err(error)) => {
                        yield Err(error);
                        break;
                    }
                    Err(error) => {
                        yield Err(std::io::Error::other(error));
                        break;
                    }
                }
            }
        })
    };
    builder
        .body(body)
        .map_err(|error| ApiError::Internal(error.to_string()))
}

fn parse_range(value: &str, size: u64) -> ApiResult<(u64, u64)> {
    let range = value
        .strip_prefix("bytes=")
        .ok_or_else(|| ApiError::RangeNotSatisfiable("only byte ranges are supported".into()))?;
    if range.contains(',') || size == 0 {
        return Err(ApiError::RangeNotSatisfiable(
            "range is not satisfiable".into(),
        ));
    }
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| ApiError::RangeNotSatisfiable("invalid byte range".into()))?;
    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .map_err(|_| ApiError::RangeNotSatisfiable("invalid byte range".into()))?;
        if suffix == 0 {
            return Err(ApiError::RangeNotSatisfiable(
                "range is not satisfiable".into(),
            ));
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| ApiError::RangeNotSatisfiable("invalid byte range".into()))?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| ApiError::RangeNotSatisfiable("invalid byte range".into()))?
                .min(size - 1)
        };
        (start, end)
    };
    if start >= size || start > end {
        return Err(ApiError::RangeNotSatisfiable(
            "range is not satisfiable".into(),
        ));
    }
    Ok((start, end))
}

fn safe_header_filename(name: &str) -> String {
    name.chars()
        .map(|character| match character {
            '"' | '\\' | '\r' | '\n' => '_',
            value => value,
        })
        .collect()
}

#[derive(Serialize)]
pub struct TextFile {
    id: i64,
    content: String,
    revision: i64,
}

pub async fn get_text(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<TextFile>> {
    let connection = db::connect(&state.db_path)?;
    let item = db::require_file(&connection, id)?;
    if item.size > MAX_TEXT_SIZE {
        return Err(ApiError::PayloadTooLarge(
            "text editing is limited to 16 MiB".into(),
        ));
    }
    let bytes: Vec<u8> =
        connection.query_row("SELECT content FROM items WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    let content = String::from_utf8(bytes)
        .map_err(|_| ApiError::Unsupported("file content is not valid UTF-8".into()))?;
    Ok(Json(TextFile {
        id,
        content,
        revision: item.revision,
    }))
}

#[derive(Deserialize)]
pub struct PutText {
    content: String,
    expected_revision: i64,
    mime: Option<String>,
}

pub async fn put_text(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<PutText>,
) -> ApiResult<Json<db::Item>> {
    if input.content.len() as i64 > MAX_TEXT_SIZE {
        return Err(ApiError::PayloadTooLarge(
            "text editing is limited to 16 MiB".into(),
        ));
    }
    let connection = db::connect(&state.db_path)?;
    let changed = connection.execute(
        "UPDATE items SET content = ?1, mime = COALESCE(?2, mime),
                revision = revision + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?3 AND kind = 'file' AND revision = ?4",
        params![
            input.content.as_bytes(),
            input.mime,
            id,
            input.expected_revision
        ],
    )?;
    if changed == 0 {
        db::require_file(&connection, id)?;
        return Err(ApiError::Conflict("file revision has changed".into()));
    }
    Ok(Json(db::item(&connection, id)?))
}

#[derive(Deserialize)]
pub struct SaveAs {
    #[serde(default = "root_id")]
    parent_id: i64,
    name: String,
    content: String,
    mime: Option<String>,
}

pub async fn save_as(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<SaveAs>,
) -> ApiResult<(StatusCode, Json<db::Item>)> {
    if input.content.len() as i64 > MAX_TEXT_SIZE {
        return Err(ApiError::PayloadTooLarge(
            "text editing is limited to 16 MiB".into(),
        ));
    }
    let connection = db::connect(&state.db_path)?;
    let source = db::require_file(&connection, id)?;
    let mime = input.mime.as_deref().or(source.mime.as_deref());
    let value = db::insert_file(
        &connection,
        input.parent_id,
        &input.name,
        mime,
        input.content.as_bytes(),
    )?;
    Ok((StatusCode::CREATED, Json(value)))
}

#[derive(Default, Deserialize)]
pub struct ArchiveQuery {
    format: Option<String>,
}

pub async fn list_archive(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<ArchiveQuery>,
) -> ApiResult<Json<archive::ArchiveListing>> {
    let connection = db::connect(&state.db_path)?;
    let item = db::require_file(&connection, id)?;
    if item.size > 100 * 1024 * 1024 {
        return Err(ApiError::PayloadTooLarge(
            "archives larger than 100 MiB cannot be inspected".into(),
        ));
    }
    let bytes: Vec<u8> =
        connection.query_row("SELECT content FROM items WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    let name = query
        .format
        .map(|format| format!("preview.{format}"))
        .unwrap_or(item.name);
    let listing = tokio::task::spawn_blocking(move || archive::list(&name, bytes))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))??;
    Ok(Json(listing))
}

pub async fn get_preferences(
    State(state): State<AppState>,
) -> ApiResult<Json<BTreeMap<String, Value>>> {
    let connection = db::connect(&state.db_path)?;
    let mut statement = connection.prepare("SELECT key, value FROM preferences ORDER BY key")?;
    let pairs = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let values = pairs
        .into_iter()
        .map(|(key, value)| {
            serde_json::from_str(&value)
                .map(|value| (key, value))
                .map_err(|error| ApiError::Internal(error.to_string()))
        })
        .collect::<ApiResult<_>>()?;
    Ok(Json(values))
}

pub async fn put_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(value): Json<Value>,
) -> ApiResult<Json<Value>> {
    if key.is_empty() || key.len() > 128 {
        return Err(ApiError::BadRequest("invalid preference key".into()));
    }
    let encoded =
        serde_json::to_string(&value).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let connection = db::connect(&state.db_path)?;
    connection.execute(
        "INSERT INTO preferences(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![key, encoded],
    )?;
    Ok(Json(value))
}

pub async fn delete_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> ApiResult<StatusCode> {
    let connection = db::connect(&state.db_path)?;
    connection.execute("DELETE FROM preferences WHERE key = ?1", [key])?;
    Ok(StatusCode::NO_CONTENT)
}

fn header_string(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}
