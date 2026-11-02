//! HTTP route wiring, including static frontend delivery.

use crate::{admin, auth, collab, files, models::AppState, settings, upload};
use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, header};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde_json::json;
use std::sync::LazyLock;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        // --- authentication ---
        .route("/auth/challenge", post(auth::challenge))
        .route("/auth/login", post(auth::login))
        .route("/auth/mfa", post(auth::verify_mfa))
        .route("/auth/logout", post(auth::logout))
        .route("/me", get(auth::me))
        .route("/me/keypair", post(auth::regenerate_own_keypair))
        .route("/me/2fa/setup", post(auth::totp_setup))
        .route("/me/2fa/enable", post(auth::totp_enable))
        .route("/me/2fa/disable", post(auth::totp_disable))
        // --- admin ---
        .route(
            "/admin/users",
            get(admin::list_users).post(admin::create_user),
        )
        .route(
            "/admin/users/{id}",
            patch(admin::patch_user).delete(admin::delete_user),
        )
        .route("/admin/users/{id}/keypair", post(admin::reset_keypair))
        .route(
            "/admin/settings",
            get(settings::admin_get_settings).patch(settings::admin_patch_settings),
        )
        .route("/settings", get(settings::public_settings))
        // --- files ---
        .route("/files", get(files::list_files).post(files::create_entry))
        .route("/file", get(files::read_file))
        .route("/files/rename", post(files::rename_entry))
        .route("/files/delete", post(files::delete_entry))
        .route(
            // Uploads are size-checked while streaming, against the limit an
            // administrator sets, so the body limit must not reject them first.
            "/files/upload",
            post(upload::upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/raw", get(upload::raw));

    let static_dir = state.cfg.static_dir.clone();
    let index = static_dir.join("index.html");
    let serve = ServeDir::new(&static_dir).fallback(ServeFile::new(&index));

    Router::new()
        .nest("/api", api)
        .route("/ws", get(collab::ws_handler))
        .fallback_service(serve)
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

/// Content security policy for the single page app. It is not the strictest possible
/// (`'unsafe-inline'` styles and `blob:` workers are required by KaTeX, Mermaid and
/// Monaco), but it forbids third-party scripts, `eval`, framing by other origins and
/// base-uri rewriting. `connect-src` names the WebSocket schemes because the
/// collaboration channel shares the page origin.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
script-src 'self'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; \
font-src 'self' data:; \
connect-src 'self' ws: wss:; \
worker-src 'self' blob:; \
frame-ancestors 'self'; \
base-uri 'none'; \
form-action 'self'; \
object-src 'none'";

static SECURITY_HEADERS: LazyLock<Vec<(HeaderName, HeaderValue)>> = LazyLock::new(|| {
    vec![
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
        (header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN")),
        (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
        (
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ),
        (
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        ),
    ]
});

/// Overwrite the baseline security headers on every reply: API JSON, the SPA shell
/// and raw file bytes all need the same policy.
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    for (name, value) in SECURITY_HEADERS.iter() {
        headers.insert(name.clone(), value.clone());
    }
    res
}

/// Liveness probe. It also reports whether PostgreSQL answers, so a broken
/// database is visible to a load balancer instead of only in the logs.
async fn health(State(state): State<AppState>) -> Response {
    let db_ok = state.db.ping().await.is_ok();
    let status = if db_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ok": db_ok,
            "name": "md-coworker",
            "version": env!("CARGO_PKG_VERSION"),
            "database": if db_ok { "ok" } else { "unavailable" },
        })),
    )
        .into_response()
}
