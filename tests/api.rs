use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use simple_multicast_share::{app, AppState};
use tempfile::TempDir;
use tower::ServiceExt;

fn test_app() -> (axum::Router, TempDir) {
    let directory = tempfile::tempdir().expect("temp directory");
    let state = AppState::new(directory.path().join("share.db")).expect("database");
    (app(state), directory)
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("JSON response")
}

#[tokio::test]
async fn file_browser_crud_text_and_ranges() {
    let (application, _directory) = test_app();
    let response = application
        .clone()
        .oneshot(
            Request::post("/api/folders")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"name":"docs"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let folder_id = json_body(response).await["id"].as_i64().unwrap();

    let response = application
        .clone()
        .oneshot(
            Request::post("/api/folders")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"name":"archive"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let destination_id = json_body(response).await["id"].as_i64().unwrap();

    let content = "hello multicast";
    let response = application
        .clone()
        .oneshot(
            Request::post(format!("/api/files?parent_id={folder_id}&name=hello.txt"))
                .header(header::CONTENT_TYPE, "text/plain")
                .header(header::CONTENT_LENGTH, content.len())
                .body(Body::from(content))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let file = json_body(response).await;
    let file_id = file["id"].as_i64().unwrap();
    let revision = file["revision"].as_i64().unwrap();

    let response = application
        .clone()
        .oneshot(
            Request::get(format!("/api/files/{file_id}/content"))
                .header(header::RANGE, "bytes=6-14")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 6-14/15");
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "multicast"
    );

    let response = application
        .clone()
        .oneshot(
            Request::get(format!("/api/files/{file_id}/content?disposition=inline"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.headers()[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("inline;"));

    let response = application
        .clone()
        .oneshot(
            Request::put(format!("/api/files/{file_id}/text"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"content":"updated","expected_revision":revision}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["revision"], revision + 1);

    let response = application
        .clone()
        .oneshot(
            Request::put(format!("/api/files/{file_id}/text"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"content":"stale","expected_revision":revision}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);

    let response = application
        .clone()
        .oneshot(
            Request::patch(format!("/api/items/{file_id}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{{"parent_id":{destination_id}}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["parent_id"], destination_id);

    let response = application
        .clone()
        .oneshot(
            Request::patch(format!("/api/items/{file_id}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"name":"renamed.txt","parent_id":1}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["name"], "renamed.txt");

    let response = application
        .clone()
        .oneshot(
            Request::delete(format!("/api/items/{folder_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn preferences_round_trip_and_static_fallback() {
    let (application, _directory) = test_app();
    let response = application
        .clone()
        .oneshot(
            Request::put("/api/preferences/theme")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#""dark""#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = application
        .clone()
        .oneshot(
            Request::get("/api/preferences")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(response).await, json!({"theme":"dark"}));

    let response = application
        .oneshot(
            Request::get("/some/client/route")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/html"));
}

#[tokio::test]
async fn database_inspector_lists_and_updates_typed_cells() {
    let (application, _directory) = test_app();
    let response = application
        .clone()
        .oneshot(
            Request::post("/api/files?parent_id=1&name=debug.txt")
                .header(header::CONTENT_TYPE, "text/plain")
                .header(header::CONTENT_LENGTH, 5)
                .body(Body::from("hello"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let file = json_body(response).await;
    let file_id = file["id"].as_i64().unwrap();
    let revision = file["revision"].as_i64().unwrap();

    let response = application
        .clone()
        .oneshot(
            Request::get("/api/debug/database")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let database = json_body(response).await;
    assert!(database["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|table| table["name"] == "items"));
    assert!(database["stats"]["database_bytes"].as_u64().unwrap() > 0);
    assert!(database["stats"]["page_size"].as_u64().unwrap() > 0);

    let response = application
        .clone()
        .oneshot(
            Request::get("/api/debug/database/items/rows")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let rows = json_body(response).await;
    let content_index = rows["columns"]
        .as_array()
        .unwrap()
        .iter()
        .position(|column| column == "content")
        .unwrap();
    let row = rows["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["rowid"] == file_id)
        .unwrap();
    assert_eq!(row["cells"][content_index]["type"], "blob");
    assert_eq!(row["cells"][content_index]["size"], 5);
    assert!(row["cells"][content_index].get("base64").is_none());

    let response = application
        .clone()
        .oneshot(
            Request::put(format!("/api/debug/database/items/rows/{file_id}/content"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"type":"blob","size":0,"base64":"dXBkYXRlZA=="}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["size"], 7);

    let response = application
        .clone()
        .oneshot(
            Request::get(format!("/api/items/{file_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(response).await["revision"], revision + 1);

    let response = application
        .clone()
        .oneshot(
            Request::get("/api/debug/database/sqlite_master/rows")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = application
        .oneshot(
            Request::post("/api/debug/database/compact")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let compacted = json_body(response).await;
    assert!(compacted["before"]["database_bytes"].as_u64().unwrap() > 0);
    assert!(compacted["after"]["database_bytes"].as_u64().unwrap() > 0);
}
