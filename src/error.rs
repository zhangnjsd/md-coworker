//! Unified error handling.
//!
//! Internal errors are carried by [`anyhow`] (keeping the full context chain) and are
//! converted at the HTTP boundary by [`AppError`] into `{"error":{"code","message"}}`.
//! For 5xx responses the whole context chain goes to the log, but internal details are
//! never sent back to the client.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// Uniform API return type.
pub type ApiResult<T> = Result<T, AppError>;

/// An error with HTTP semantics, wrapping any [`anyhow::Error`].
#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    code: String,
    message: String,
    cause: Option<anyhow::Error>,
    retry_after: Option<u64>,
}

impl AppError {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            cause: None,
            retry_after: None,
        }
    }

    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message)
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn too_large(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, code, message)
    }

    /// 429 with a `Retry-After` header (seconds) plus the same hint in the message so
    /// clients that only read the body still know how long to wait.
    pub fn rate_limited(retry_after_secs: u64) -> Self {
        let mut error = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            format!("请求过于频繁，请 {retry_after_secs} 秒后再试"),
        );
        error.retry_after = Some(retry_after_secs);
        error
    }

    pub fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error".to_string(),
            message: "服务器内部错误".to_string(),
            cause: Some(error),
            retry_after: None,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} ({}): {}",
            self.status.as_u16(),
            self.code,
            self.message
        )
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_ref().map(|e| e.as_ref() as _)
    }
}

/// Internal error -> 500, preserving the anyhow context chain.
impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        // Errors that already carry HTTP semantics pass straight through (an
        // anyhow::Error may itself wrap an AppError).
        if let Some(http) = error.downcast_ref::<AppError>() {
            return AppError {
                status: http.status,
                code: http.code.clone(),
                message: http.message.clone(),
                cause: http.cause.as_ref().map(|e| anyhow::anyhow!("{:#}", e)),
                retry_after: http.retry_after,
            };
        }
        AppError::internal(error)
    }
}

macro_rules! from_internal {
    ($($ty:ty),* $(,)?) => {
        $(
            impl From<$ty> for AppError {
                fn from(e: $ty) -> Self {
                    AppError::internal(anyhow::Error::new(e))
                }
            }
        )*
    };
}

from_internal!(
    std::io::Error,
    serde_json::Error,
    sqlx::Error,
    std::str::Utf8Error,
);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if self.status.is_server_error() {
            match self.cause.as_ref() {
                Some(cause) => tracing::error!("{} :: {:#}", self.code, cause),
                None => tracing::error!("{} :: {}", self.code, self.message),
            }
        }
        let body = Json(json!({
            "error": { "code": self.code, "message": self.message }
        }));
        let mut response = (self.status, body).into_response();
        if let Some(secs) = self.retry_after
            && let Ok(value) = axum::http::HeaderValue::from_str(&secs.to_string())
        {
            response
                .headers_mut()
                .insert(axum::http::header::RETRY_AFTER, value);
        }
        response
    }
}

/// Convenience macro: build a status-coded error inside a handler.
#[macro_export]
macro_rules! bail_status {
    ($status:expr, $code:literal, $($arg:tt)*) => {
        return Err($crate::error::AppError::new($status, $code, format!($($arg)*)))
    };
}
