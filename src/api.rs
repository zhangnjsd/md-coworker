//! HTTP 路由装配。

use crate::{
    admin, auth, collab, files,
    models::AppState,
};
use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde_json::json;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        // --- 认证 ---
        .route("/auth/challenge", post(auth::challenge))
        .route("/auth/login", post(auth::login))
        .route("/auth/mfa", post(auth::verify_mfa))
        .route("/auth/logout", post(auth::logout))
        .route("/me", get(auth::me))
        .route("/me/keypair", post(auth::regenerate_own_keypair))
        .route("/me/2fa/setup", post(auth::totp_setup))
        .route("/me/2fa/enable", post(auth::totp_enable))
        .route("/me/2fa/disable", post(auth::totp_disable))
        // --- 管理员 ---
        .route("/admin/users", get(admin::list_users).post(admin::create_user))
        .route("/admin/users/{id}", patch(admin::patch_user).delete(admin::delete_user))
        .route("/admin/users/{id}/keypair", post(admin::reset_keypair))
        // --- 文件 ---
        .route("/files", get(files::list_files).post(files::create_entry))
        .route("/file", get(files::read_file))
        .route("/files/rename", post(files::rename_entry))
        .route("/files/delete", post(files::delete_entry));

    let static_dir = state.cfg.static_dir.clone();
    let index = static_dir.join("index.html");
    let serve = ServeDir::new(&static_dir).fallback(ServeFile::new(&index));

    Router::new()
        .nest("/api", api)
        .route("/ws", get(collab::ws_handler))
        .fallback_service(serve)
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "name": "md-coworker",
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
        .into_response()
}
