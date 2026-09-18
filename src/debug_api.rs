use axum::{
    extract::{Path, Query, State},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{
    params,
    types::{Value as SqlValue, ValueRef},
    OptionalExtension,
};
use serde::{Deserialize, Serialize};

use crate::{
    db,
    error::{ApiError, ApiResult},
    AppState,
};

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;
const MAX_CELL_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
pub struct DatabaseInfo {
    tables: Vec<TableInfo>,
    stats: DatabaseStats,
}

#[derive(Debug, Serialize)]
pub struct DatabaseStats {
    database_bytes: u64,
    wal_bytes: u64,
    total_disk_bytes: u64,
    page_size: u64,
    page_count: u64,
    free_pages: u64,
    reclaimable_bytes: u64,
}

#[derive(Serialize)]
pub struct CompactResult {
    before: DatabaseStats,
    after: DatabaseStats,
    reclaimed_bytes: u64,
}

#[derive(Serialize)]
pub struct TableInfo {
    name: String,
    columns: Vec<ColumnInfo>,
}

#[derive(Serialize)]
pub struct ColumnInfo {
    name: String,
    data_type: String,
    nullable: bool,
    primary_key: bool,
}

#[derive(Serialize)]
pub struct TableRows {
    table: String,
    columns: Vec<String>,
    rows: Vec<DebugRow>,
    total: i64,
    limit: u32,
    offset: u32,
}

#[derive(Serialize)]
pub struct DebugRow {
    rowid: i64,
    cells: Vec<DebugValue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DebugValue {
    Null,
    Integer {
        value: i64,
    },
    Real {
        value: f64,
    },
    Text {
        value: String,
    },
    Blob {
        size: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        base64: Option<String>,
    },
}

#[derive(Deserialize)]
pub struct RowsQuery {
    #[serde(default = "default_limit")]
    limit: u32,
    #[serde(default)]
    offset: u32,
}

fn default_limit() -> u32 {
    DEFAULT_LIMIT
}

pub async fn database_info(State(state): State<AppState>) -> ApiResult<Json<DatabaseInfo>> {
    let connection = db::connect(&state.db_path)?;
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name",
    )?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let tables = names
        .into_iter()
        .map(|name| {
            Ok(TableInfo {
                columns: columns(&connection, &name)?,
                name,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(DatabaseInfo {
        tables,
        stats: database_stats(&connection, &state.db_path)?,
    }))
}

pub async fn compact_database(State(state): State<AppState>) -> ApiResult<Json<CompactResult>> {
    let _guard = state.maintenance_lock.lock().await;
    let path = (*state.db_path).clone();
    tokio::task::spawn_blocking(move || {
        let connection = db::connect(&path)?;
        let before = database_stats(&connection, &path)?;
        connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(ApiError::Database)?;
        connection.execute_batch("VACUUM")?;
        connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(ApiError::Database)?;
        let after = database_stats(&connection, &path)?;
        let reclaimed_bytes = before
            .total_disk_bytes
            .saturating_sub(after.total_disk_bytes);
        Ok(Json(CompactResult {
            before,
            after,
            reclaimed_bytes,
        }))
    })
    .await
    .map_err(|error| ApiError::Internal(format!("database compaction task failed: {error}")))?
}

pub async fn table_rows(
    State(state): State<AppState>,
    Path(table): Path<String>,
    Query(query): Query<RowsQuery>,
) -> ApiResult<Json<TableRows>> {
    let connection = db::connect(&state.db_path)?;
    require_table(&connection, &table)?;
    let columns = columns(&connection, &table)?;
    let column_names = columns
        .iter()
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();
    let quoted_table = quote_identifier(&table);
    let selected_columns = column_names
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let total =
        connection.query_row(&format!("SELECT count(*) FROM {quoted_table}"), [], |row| {
            row.get(0)
        })?;
    let mut statement = connection.prepare(&format!(
        "SELECT rowid, {selected_columns} FROM {quoted_table}
         ORDER BY rowid LIMIT ?1 OFFSET ?2"
    ))?;
    let rows = statement
        .query_map(params![limit, query.offset], |row| {
            let mut cells = Vec::with_capacity(column_names.len());
            for index in 0..column_names.len() {
                cells.push(value_from_ref(row.get_ref(index + 1)?, false)?);
            }
            Ok(DebugRow {
                rowid: row.get(0)?,
                cells,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(TableRows {
        table,
        columns: column_names,
        rows,
        total,
        limit,
        offset: query.offset,
    }))
}

pub async fn get_cell(
    State(state): State<AppState>,
    Path((table, rowid, column)): Path<(String, i64, String)>,
) -> ApiResult<Json<DebugValue>> {
    let connection = db::connect(&state.db_path)?;
    require_column(&connection, &table, &column)?;
    Ok(Json(read_cell(&connection, &table, rowid, &column)?))
}

pub async fn put_cell(
    State(state): State<AppState>,
    Path((table, rowid, column)): Path<(String, i64, String)>,
    Json(value): Json<DebugValue>,
) -> ApiResult<Json<DebugValue>> {
    let connection = db::connect(&state.db_path)?;
    require_column(&connection, &table, &column)?;
    let sql_value = sql_value(value)?;
    let sql = if table == "items" && column == "content" {
        format!(
            "UPDATE {} SET {} = ?1, revision = revision + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = ?2",
            quote_identifier(&table),
            quote_identifier(&column)
        )
    } else {
        format!(
            "UPDATE {} SET {} = ?1 WHERE rowid = ?2",
            quote_identifier(&table),
            quote_identifier(&column)
        )
    };
    let changed = connection
        .execute(&sql, params![sql_value, rowid])
        .map_err(db::map_write_error)?;
    if changed == 0 {
        return Err(ApiError::NotFound(format!("row {rowid} does not exist")));
    }
    Ok(Json(read_cell(&connection, &table, rowid, &column)?))
}

fn columns(connection: &rusqlite::Connection, table: &str) -> ApiResult<Vec<ColumnInfo>> {
    let mut statement =
        connection.prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))?;
    let values = statement
        .query_map([], |row| {
            Ok(ColumnInfo {
                name: row.get(1)?,
                data_type: row.get(2)?,
                nullable: row.get::<_, i64>(3)? == 0,
                primary_key: row.get::<_, i64>(5)? > 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
}

fn database_stats(
    connection: &rusqlite::Connection,
    path: &std::path::Path,
) -> ApiResult<DatabaseStats> {
    let page_size = connection.query_row("PRAGMA page_size", [], |row| row.get::<_, u64>(0))?;
    let page_count = connection.query_row("PRAGMA page_count", [], |row| row.get::<_, u64>(0))?;
    let free_pages =
        connection.query_row("PRAGMA freelist_count", [], |row| row.get::<_, u64>(0))?;
    let database_bytes = file_size(path)?;
    let wal_bytes = file_size(&std::path::PathBuf::from(format!("{}-wal", path.display())))?;
    Ok(DatabaseStats {
        database_bytes,
        wal_bytes,
        total_disk_bytes: database_bytes.saturating_add(wal_bytes),
        page_size,
        page_count,
        free_pages,
        reclaimable_bytes: page_size.saturating_mul(free_pages),
    })
}

fn file_size(path: &std::path::Path) -> ApiResult<u64> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(ApiError::Internal(format!(
            "could not inspect {}: {error}",
            path.display()
        ))),
    }
}

fn require_table(connection: &rusqlite::Connection, table: &str) -> ApiResult<()> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema
             WHERE type = 'table' AND name = ?1 AND name NOT LIKE 'sqlite_%'",
            [table],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(ApiError::NotFound(format!("table {table} does not exist")))
    }
}

fn require_column(connection: &rusqlite::Connection, table: &str, column: &str) -> ApiResult<()> {
    require_table(connection, table)?;
    if columns(connection, table)?
        .iter()
        .any(|candidate| candidate.name == column)
    {
        Ok(())
    } else {
        Err(ApiError::NotFound(format!(
            "column {column} does not exist in table {table}"
        )))
    }
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn read_cell(
    connection: &rusqlite::Connection,
    table: &str,
    rowid: i64,
    column: &str,
) -> ApiResult<DebugValue> {
    let (value_type, length) = connection
        .query_row(
            &format!(
                "SELECT typeof({0}), length({0}) FROM {1} WHERE rowid = ?1",
                quote_identifier(column),
                quote_identifier(table)
            ),
            [rowid],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?
        .ok_or_else(|| ApiError::NotFound(format!("row {rowid} does not exist")))?;
    if value_type == "blob" && length.unwrap_or_default() > MAX_CELL_BYTES as i64 {
        return Err(ApiError::PayloadTooLarge(
            "debug BLOB inspection is limited to 16 MiB".into(),
        ));
    }
    connection
        .query_row(
            &format!(
                "SELECT {} FROM {} WHERE rowid = ?1",
                quote_identifier(column),
                quote_identifier(table)
            ),
            [rowid],
            |row| value_from_ref(row.get_ref(0)?, true),
        )
        .optional()?
        .ok_or_else(|| ApiError::NotFound(format!("row {rowid} does not exist")))
}

fn value_from_ref(value: ValueRef<'_>, include_blob: bool) -> rusqlite::Result<DebugValue> {
    Ok(match value {
        ValueRef::Null => DebugValue::Null,
        ValueRef::Integer(value) => DebugValue::Integer { value },
        ValueRef::Real(value) => DebugValue::Real { value },
        ValueRef::Text(value) => DebugValue::Text {
            value: String::from_utf8_lossy(value).into_owned(),
        },
        ValueRef::Blob(value) => DebugValue::Blob {
            size: value.len(),
            base64: include_blob.then(|| STANDARD.encode(value)),
        },
    })
}

fn sql_value(value: DebugValue) -> ApiResult<SqlValue> {
    Ok(match value {
        DebugValue::Null => SqlValue::Null,
        DebugValue::Integer { value } => SqlValue::Integer(value),
        DebugValue::Real { value } => SqlValue::Real(value),
        DebugValue::Text { value } => {
            if value.len() > MAX_CELL_BYTES {
                return Err(ApiError::PayloadTooLarge(
                    "debug cell updates are limited to 16 MiB".into(),
                ));
            }
            SqlValue::Text(value)
        }
        DebugValue::Blob { base64, .. } => {
            let encoded =
                base64.ok_or_else(|| ApiError::BadRequest("blob base64 is required".into()))?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|error| ApiError::BadRequest(format!("invalid base64: {error}")))?;
            if bytes.len() > MAX_CELL_BYTES {
                return Err(ApiError::PayloadTooLarge(
                    "debug cell updates are limited to 16 MiB".into(),
                ));
            }
            SqlValue::Blob(bytes)
        }
    })
}
