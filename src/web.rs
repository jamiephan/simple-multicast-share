use axum::{
    extract::OriginalUri,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

pub async fn static_asset(OriginalUri(uri): OriginalUri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let requested = if path.is_empty() { "index.html" } else { path };
    let (asset, served_path) = match embedded_asset(requested) {
        Some(asset) => (asset, requested),
        None if !requested.starts_with("api/") => match embedded_asset("index.html") {
            Some(asset) => (asset, "index.html"),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    (
        [
            (
                header::CONTENT_TYPE,
                mime_guess::from_path(served_path)
                    .first_or_octet_stream()
                    .as_ref(),
            ),
            (
                header::CACHE_CONTROL,
                if served_path == "index.html" {
                    "no-cache"
                } else {
                    "public, max-age=31536000, immutable"
                },
            ),
        ],
        asset,
    )
        .into_response()
}
