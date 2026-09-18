# HTTP API contract

The embedded web client uses stable database item IDs for server operations. Paths
are reconstructed client-side for breadcrumbs and are resolved by traversing folder
listings from root item `1`.

Errors are non-2xx responses with `{ "error": "Human-readable explanation" }`.
Conflicting names and stale revisions return `409 Conflict`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Server health |
| `GET` | `/api/items?parent_id=1` | List direct children of a folder |
| `GET` | `/api/items/{id}` | Read item metadata |
| `PATCH` | `/api/items/{id}` | Rename/move with `{ "name"?, "parent_id"? }` |
| `DELETE` | `/api/items/{id}` | Recursively delete a file or folder |
| `POST` | `/api/folders` | Create with `{ "parent_id", "name" }` |
| `POST` | `/api/files?parent_id=1&name=x` | Stream a raw file body into SQLite |
| `GET/HEAD` | `/api/files/{id}/content` | Range-capable attachment response |
| `GET` | `/api/files/{id}/content?disposition=inline&mime=…` | Range-capable browser preview with optional temporary MIME override |
| `PUT` | `/api/files/{id}/content?expected_revision=n` | Stream replacement content |
| `GET` | `/api/files/{id}/text` | Read UTF-8 text and its revision |
| `PUT` | `/api/files/{id}/text` | Save `{ "content", "expected_revision" }` |
| `POST` | `/api/files/{id}/save-as` | Save edited text under a new name |
| `GET` | `/api/files/{id}/archive?format=…` | Guarded ZIP/TAR/TAR.GZ/GZ listing with optional parser-format override |
| `GET` | `/api/preferences` | Read all JSON preference values |
| `PUT/DELETE` | `/api/preferences/{key}` | Set or remove one JSON value |
| `GET` | `/api/debug/database` | List application tables and column schemas |
| `POST` | `/api/debug/database/compact` | Checkpoint WAL, run `VACUUM`, and return before/after storage statistics |
| `GET` | `/api/debug/database/{table}/rows` | List up to 200 typed rows with pagination |
| `GET/PUT` | `/api/debug/database/{table}/rows/{rowid}/{column}` | Read or update one typed SQLite cell |

Upload and replacement bodies require `Content-Length` and are written
incrementally rather than buffered in application memory. There is no configured
application upload-size limit; SQLite's compiled BLOB limit, its incremental BLOB
API range, available disk space, and platform constraints still apply.

The debug API accepts typed `null`, `integer`, `real`, `text`, and Base64-encoded
`blob` values. Internal `sqlite_*` tables and arbitrary SQL execution are not
exposed. BLOB inspection and updates through this debug surface are limited to
16 MiB; ordinary file streaming endpoints retain their separate limits.
