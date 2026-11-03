//! HTTP route wiring, including static frontend delivery.

use crate::{admin, auth, collab, files, models::AppState, settings, upload};
use axum::extract::Request;
use axum::http::{Extensions, HeaderMap, HeaderName, HeaderValue, Version, header};
use axum::{
    Json, Router,
    extract::OriginalUri,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde_json::json;
use std::sync::LazyLock;
use tower_http::{
    compression::CompressionLayer,
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

    // Unmatched API paths must answer JSON, never the SPA shell: a typo like
    // `/api/filesz` used to come back as `200 text/html` and fail in `JSON.parse`.
    let api = api.fallback(api_not_found);

    let static_dir = state.cfg.static_dir.clone();
    let index = static_dir.join("index.html");
    let base_path = state.cfg.base_path.clone();

    // The frontend uses hash routing, so only `/` needs the SPA shell; every other path
    // that is not a real file is genuinely missing. Serving the shell for those would turn
    // broken asset URLs into 200 HTML responses.
    let app = Router::new()
        .nest("/api", api)
        .route("/ws", get(collab::ws_handler))
        .route("/", axum::routing::get_service(ServeFile::new(&index)))
        .fallback_service(ServeDir::new(&static_dir));
    let app = if base_path.is_empty() {
        app
    } else {
        // `nest` exposes the mount point itself as `/cowork` but hands `/cowork/`
        // (trailing slash, the form browsers send) down as an empty path, so the shell
        // route has to be registered outside the nested router as well.
        Router::new()
            .route(
                &format!("{base_path}/"),
                axum::routing::get_service(ServeFile::new(&index)),
            )
            .nest(&base_path, app)
    };

    app.layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(state.clone(), cache_headers))
        .layer(middleware::from_fn(security_headers))
        .layer(compression_layer())
        .with_state(state)
}

/// Unknown API path: a JSON 404 instead of an empty body or the SPA shell.
async fn api_not_found(OriginalUri(uri): OriginalUri) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": { "code": "not_found", "message": format!("接口不存在: {}", uri.path()) }
        })),
    )
        .into_response()
}

/// Compression for text responses. `206 Partial Content` replies (video, PDF ranges) and
/// images are left alone: re-compressing a byte range breaks byte-offset seeking.
fn compression_layer() -> CompressionLayer<impl tower_http::compression::predicate::Predicate> {
    CompressionLayer::new().compress_when(
        |status: StatusCode, _version: Version, headers: &HeaderMap, _ext: &Extensions| {
            if status != StatusCode::OK || headers.contains_key(header::CONTENT_RANGE) {
                return false;
            }
            !headers
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|mime| mime.starts_with("image/") || mime.starts_with("video/"))
        },
    )
}

/// Caching policy: hashed bundles are immutable, everything else revalidates, and API
/// payloads carrying user data are never stored. `/api/raw` sets its own policy because
/// attachment caching is per-file.
async fn cache_headers(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let raw = req.uri().path().to_string();
    let path = raw
        .strip_prefix(state.cfg.base_path.as_str())
        .unwrap_or(&raw)
        .to_string();
    let mut res = next.run(req).await;
    let value = if path.starts_with("/api/") {
        if path.starts_with("/api/raw") {
            None
        } else {
            Some("no-store")
        }
    } else if path.contains("/assets/") {
        Some("public, max-age=31536000, immutable")
    } else {
        Some("no-cache")
    };
    if let Some(value) = value {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    res
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
        (
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("SAMEORIGIN"),
        ),
        (
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ),
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
