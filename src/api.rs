//! HTTP route wiring, including static frontend delivery.

use crate::{admin, auth, collab, files, models::AppState};
use axum::http::{HeaderName, HeaderValue, header};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde_json::json;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
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
        // --- files ---
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
        .layer(security_headers())
        .with_state(state)
}

/// Baseline security headers. No CSP is set on purpose: the frontend needs a Monaco
/// blob worker and KaTeX / Mermaid inject inline styles, so a strict policy would have
/// to allow-list each of them. The demo keeps it permissive instead.
type SecurityHeaders = tower::layer::util::Stack<
    SetResponseHeaderLayer<HeaderValue>,
    tower::layer::util::Stack<
        SetResponseHeaderLayer<HeaderValue>,
        tower::layer::util::Stack<
            SetResponseHeaderLayer<HeaderValue>,
            tower::layer::util::Stack<
                SetResponseHeaderLayer<HeaderValue>,
                tower::layer::util::Identity,
            >,
        >,
    >,
>;

fn security_headers() -> SecurityHeaders {
    tower::ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("SAMEORIGIN"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .into_inner()
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
