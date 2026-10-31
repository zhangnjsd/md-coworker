//! Runtime settings an administrator can change without restarting.
//!
//! Today that is a single knob: the per-file upload size limit. Values live in the
//! `settings` key/value table so they survive restarts, and `GET /api/settings`
//! exposes the ones every client needs to know.

use crate::{
    auth::{AdminUser, AuthUser},
    error::{ApiResult, AppError},
    models::AppState,
};
use axum::{Json, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};

/// Database key holding the upload limit in bytes.
pub const MAX_UPLOAD_KEY: &str = "max_upload_bytes";

/// 10 MiB — large enough for a screenshot, small enough to stay polite.
pub const DEFAULT_MAX_UPLOAD_BYTES: i64 = 10 * 1024 * 1024;
pub const MIN_MAX_UPLOAD_BYTES: i64 = 1024;
pub const MAX_MAX_UPLOAD_BYTES: i64 = 512 * 1024 * 1024;

/// Read the effective upload limit, falling back to the default when unset or broken.
pub async fn max_upload_bytes(state: &AppState) -> i64 {
    match state.db.get_setting(MAX_UPLOAD_KEY).await {
        Ok(Some(raw)) => match raw.trim().parse::<i64>() {
            Ok(value) if (MIN_MAX_UPLOAD_BYTES..=MAX_MAX_UPLOAD_BYTES).contains(&value) => value,
            _ => {
                tracing::warn!(value = %raw, "上传上限取值异常，回退到默认值");
                DEFAULT_MAX_UPLOAD_BYTES
            }
        },
        Ok(None) => DEFAULT_MAX_UPLOAD_BYTES,
        Err(err) => {
            tracing::warn!(error = %err, "读取上传上限失败，回退到默认值");
            DEFAULT_MAX_UPLOAD_BYTES
        }
    }
}

/// `10485760` → `10 MiB`, for messages the user actually reads.
pub fn human_bytes(bytes: i64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= MIB {
        let mib = value / MIB;
        if (mib - mib.round()).abs() < 0.05 {
            format!("{} MiB", mib.round() as i64)
        } else {
            format!("{mib:.1} MiB")
        }
    } else if value >= KIB {
        format!("{} KiB", (value / KIB).round() as i64)
    } else {
        format!("{bytes} 字节")
    }
}

// ---------------------------------------------------------------- handlers

/// Anything a client needs to render upload UI (limit, plus room to grow).
pub async fn public_settings(
    State(state): State<AppState>,
    _auth: AuthUser,
) -> ApiResult<Json<Value>> {
    let limit = max_upload_bytes(&state).await;
    Ok(Json(json!({ "max_upload_bytes": limit })))
}

pub async fn admin_get_settings(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Value>> {
    let limit = max_upload_bytes(&state).await;
    Ok(Json(json!({ "settings": { "max_upload_bytes": limit } })))
}

#[derive(Deserialize)]
pub struct PatchSettingsReq {
    #[serde(default)]
    max_upload_bytes: Option<i64>,
}

pub async fn admin_patch_settings(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(req): Json<PatchSettingsReq>,
) -> ApiResult<Json<Value>> {
    let Some(limit) = req.max_upload_bytes else {
        return Err(AppError::bad_request(
            "bad_request",
            "请求里没有 max_upload_bytes",
        ));
    };
    if !(MIN_MAX_UPLOAD_BYTES..=MAX_MAX_UPLOAD_BYTES).contains(&limit) {
        return Err(AppError::bad_request(
            "bad_limit",
            format!(
                "上限必须在 {} 到 {} 之间",
                human_bytes(MIN_MAX_UPLOAD_BYTES),
                human_bytes(MAX_MAX_UPLOAD_BYTES)
            ),
        ));
    }

    state
        .db
        .set_setting(MAX_UPLOAD_KEY, &limit.to_string())
        .await?;
    tracing::info!(actor = %admin.0.user.username, limit, "管理员修改上传上限");
    Ok(Json(json!({ "settings": { "max_upload_bytes": limit } })))
}
