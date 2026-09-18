use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub kind: String,
    pub mime: Option<String>,
    pub size: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn connect(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(connection)
}

pub fn initialize(path: &Path) -> rusqlite::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| rusqlite::Error::InvalidPath(error.to_string().into()))?;
    }
    let connection = connect(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS items (
            id          INTEGER PRIMARY KEY,
            parent_id   INTEGER REFERENCES items(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            kind        TEXT NOT NULL CHECK(kind IN ('folder', 'file')),
            mime        TEXT,
            content     BLOB,
            revision    INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            CHECK((kind = 'folder' AND content IS NULL) OR
                  (kind = 'file' AND content IS NOT NULL)),
            UNIQUE(parent_id, name)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS root_name_unique
            ON items(name) WHERE parent_id IS NULL;
        CREATE TABLE IF NOT EXISTS preferences (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL CHECK(json_valid(value)),
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE IF NOT EXISTS pending_uploads (
            id          INTEGER PRIMARY KEY,
            content     BLOB NOT NULL
        );
        INSERT OR IGNORE INTO items(id, parent_id, name, kind, content)
            VALUES(1, NULL, '', 'folder', NULL);
        "#,
    )?;
    Ok(())
}

pub fn item(connection: &Connection, id: i64) -> ApiResult<Item> {
    connection
        .query_row(
            "SELECT id, parent_id, name, kind, mime,
                    CASE WHEN kind = 'file' THEN length(content) ELSE 0 END,
                    revision, created_at, updated_at
             FROM items WHERE id = ?1",
            [id],
            item_from_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::NotFound(format!("item {id} does not exist")))
}

pub fn require_folder(connection: &Connection, id: i64) -> ApiResult<()> {
    let kind = connection
        .query_row("SELECT kind FROM items WHERE id = ?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    match kind.as_deref() {
        Some("folder") => Ok(()),
        Some(_) => Err(ApiError::BadRequest(format!("item {id} is not a folder"))),
        None => Err(ApiError::NotFound(format!("folder {id} does not exist"))),
    }
}

pub fn require_file(connection: &Connection, id: i64) -> ApiResult<Item> {
    let value = item(connection, id)?;
    if value.kind != "file" {
        return Err(ApiError::BadRequest(format!("item {id} is not a file")));
    }
    Ok(value)
}

pub fn validate_name(name: &str) -> ApiResult<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().count() > 255
        || name.contains(['/', '\\', '\0'])
    {
        return Err(ApiError::BadRequest("invalid item name".into()));
    }
    Ok(())
}

pub fn map_write_error(error: rusqlite::Error) -> ApiError {
    match &error {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            ApiError::Conflict("an item with that name already exists".into())
        }
        _ => ApiError::Database(error),
    }
}

pub fn insert_folder(connection: &Connection, parent_id: i64, name: &str) -> ApiResult<Item> {
    validate_name(name)?;
    require_folder(connection, parent_id)?;
    connection
        .execute(
            "INSERT INTO items(parent_id, name, kind) VALUES(?1, ?2, 'folder')",
            params![parent_id, name],
        )
        .map_err(map_write_error)?;
    item(connection, connection.last_insert_rowid())
}

pub fn insert_file(
    connection: &Connection,
    parent_id: i64,
    name: &str,
    mime: Option<&str>,
    content: &[u8],
) -> ApiResult<Item> {
    validate_name(name)?;
    require_folder(connection, parent_id)?;
    connection
        .execute(
            "INSERT INTO items(parent_id, name, kind, mime, content)
             VALUES(?1, ?2, 'file', ?3, ?4)",
            params![parent_id, name, mime, content],
        )
        .map_err(map_write_error)?;
    item(connection, connection.last_insert_rowid())
}

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
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
}
