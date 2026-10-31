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

/// 统一 API 返回类型。
pub type ApiResult<T> = Result<T, AppError>;

/// 带 HTTP 语义的错误。包装了任意 [`anyhow::Error`]。
#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    code: String,
    message: String,
    cause: Option<anyhow::Error>,
}

impl AppError {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            cause: None,
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

    pub fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error".to_string(),
            message: "服务器内部错误".to_string(),
            cause: Some(error),
        }
    }

    /// 附加/替换底层原因，便于在 `?` 之后补充上下文。
    pub fn with_cause(mut self, error: anyhow::Error) -> Self {
        self.cause = Some(error);
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn code(&self) -> &str {
        &self.code
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

/// 内部错误 → 500。保留 anyhow context 链。
impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        // 已经带 HTTP 语义的错误直接透传（anyhow::Error 内部也可能包着 AppError）。
        if let Some(http) = error.downcast_ref::<AppError>() {
            return AppError {
                status: http.status,
                code: http.code.clone(),
                message: http.message.clone(),
                cause: http.cause.as_ref().map(|e| anyhow::anyhow!("{:#}", e)),
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
    rusqlite::Error,
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
        (self.status, body).into_response()
    }
}

/// 便捷宏：在 handler 里构造带状态码的错误。
#[macro_export]
macro_rules! bail_status {
    ($status:expr, $code:literal, $($arg:tt)*) => {
        return Err($crate::error::AppError::new($status, $code, format!($($arg)*)))
    };
}
