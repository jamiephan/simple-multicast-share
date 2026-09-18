pub mod api;
pub mod archive;
pub mod db;
pub mod debug_api;
pub mod error;
pub mod web;

use std::{path::PathBuf, sync::Arc};

use axum::{
    routing::{get, post, put},
    Router,
};
use tower_http::{catch_panic::CatchPanicLayer, compression::CompressionLayer, trace::TraceLayer};

#[derive(Clone)]
pub struct AppState {
    pub db_path: Arc<PathBuf>,
    pub maintenance_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    pub fn new(db_path: PathBuf) -> Result<Self, rusqlite::Error> {
        db::initialize(&db_path)?;
        Ok(Self {
            db_path: Arc::new(db_path),
            maintenance_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(api::health))
        .route("/api/items", get(api::list_items))
        .route(
            "/api/items/{id}",
            get(api::get_item)
                .patch(api::update_item)
                .delete(api::delete_item),
        )
        .route("/api/folders", post(api::create_folder))
        .route("/api/files", post(api::create_file))
        .route(
            "/api/files/{id}/content",
            get(api::download_file)
                .head(api::download_file)
                .put(api::replace_file),
        )
        .route(
            "/api/files/{id}/text",
            get(api::get_text).put(api::put_text),
        )
        .route("/api/files/{id}/save-as", post(api::save_as))
        .route("/api/files/{id}/archive", get(api::list_archive))
        .route("/api/preferences", get(api::get_preferences))
        .route(
            "/api/preferences/{key}",
            put(api::put_preference).delete(api::delete_preference),
        )
        .route("/api/debug/database", get(debug_api::database_info))
        .route(
            "/api/debug/database/compact",
            post(debug_api::compact_database),
        )
        .route(
            "/api/debug/database/{table}/rows",
            get(debug_api::table_rows),
        )
        .route(
            "/api/debug/database/{table}/rows/{rowid}/{column}",
            get(debug_api::get_cell).put(debug_api::put_cell),
        )
        .fallback(get(web::static_asset))
        .with_state(state)
        .layer(CompressionLayer::new())
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
}
