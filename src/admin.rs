//! Admin endpoints: create a user (with a one-time key pair), reset a key pair,
//! change a role, force-disable 2FA, and delete a user.

use crate::{
    auth::{AdminUser, parse_role, validate_username},
    crypto,
    db::Role,
    error::{ApiResult, AppError},
    models::{AppState, UserDto},
};
use anyhow::Context;
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

pub async fn list_users(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Value>> {
    let users = state.db.list_users()?;
    let online = state.hub.online_user_ids();
    let dtos: Vec<UserDto> = users
        .iter()
        .map(|user| {
            let mut dto = UserDto::from(user);
            dto.online = Some(online.contains(&user.id));
            dto
        })
        .collect();
    Ok(Json(json!({ "users": dtos })))
}

#[derive(Deserialize)]
pub struct CreateUserReq {
    username: String,
    #[serde(default)]
    role: Option<String>,
}

pub async fn create_user(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(req): Json<CreateUserReq>,
) -> ApiResult<Json<Value>> {
    let username = req.username.trim().to_string();
    validate_username(&username)?;
    let role = match req.role.as_deref() {
        None => Role::User,
        Some(value) => parse_role(value)?,
    };

    if state.db.find_user_by_username(&username)?.is_some() {
        return Err(AppError::conflict("user_exists", "用户名已被占用"));
    }

    let (private_key, public_key) = crypto::generate_keypair();
    let user = state
        .db
        .create_user(&username, role, &public_key)
        .context("创建用户失败")?;
    tracing::info!(user = %user.username, role = user.role.as_str(), "管理员创建用户");

    // 私钥只在这里出现一次，之后无法再取回。
    Ok(Json(json!({
        "user": UserDto::from(&user),
        "private_key": private_key,
        "public_key": public_key,
    })))
}

pub async fn reset_keypair(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = state
        .db
        .get_user(&user_id)?
        .ok_or_else(|| AppError::not_found("unknown_user", "用户不存在"))?;

    let (private_key, public_key) = crypto::generate_keypair();
    state.db.set_public_key(&user.id, &public_key)?;
    // 失效该用户既有会话（管理员重置自己时保留当前会话）
    if admin.0.user.id != user.id {
        state.db.delete_user_sessions(&user.id)?;
    }
    tracing::info!(actor = %admin.0.user.username, target = %user.username, "管理员重置密钥对");

    Ok(Json(json!({
        "user": UserDto::from(&state.db.get_user(&user.id)?.context("用户消失")?),
        "private_key": private_key,
        "public_key": public_key,
    })))
}

#[derive(Deserialize)]
pub struct PatchUserReq {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    twofa_enabled: Option<bool>,
}

pub async fn patch_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(user_id): Path<String>,
    Json(req): Json<PatchUserReq>,
) -> ApiResult<Json<Value>> {
    let user = state
        .db
        .get_user(&user_id)?
        .ok_or_else(|| AppError::not_found("unknown_user", "用户不存在"))?;

    if let Some(role) = req.role.as_deref() {
        let role = parse_role(role)?;
        if user.role.is_admin() && !role.is_admin() && admin_count(&state)? <= 1 {
            return Err(AppError::bad_request(
                "last_admin",
                "系统至少需要保留一个管理员",
            ));
        }
        state.db.set_role(&user.id, role)?;
    }

    if let Some(false) = req.twofa_enabled {
        state.db.set_totp(&user.id, None, false)?;
        tracing::info!(actor = %admin.0.user.username, target = %user.username, "管理员强制重置 2FA");
    }

    let updated = state.db.get_user(&user.id)?.context("用户消失")?;
    Ok(Json(json!({ "user": UserDto::from(&updated) })))
}

pub async fn delete_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    if admin.0.user.id == user_id {
        return Err(AppError::bad_request("self_delete", "不能删除自己"));
    }
    let user = state
        .db
        .get_user(&user_id)?
        .ok_or_else(|| AppError::not_found("unknown_user", "用户不存在"))?;
    if user.role.is_admin() && admin_count(&state)? <= 1 {
        return Err(AppError::bad_request(
            "last_admin",
            "系统至少需要保留一个管理员",
        ));
    }
    state.db.delete_user(&user.id)?;
    tracing::info!(actor = %admin.0.user.username, target = %user.username, "删除用户");
    Ok(Json(json!({ "ok": true })))
}

fn admin_count(state: &AppState) -> ApiResult<i64> {
    let users = state.db.list_users()?;
    Ok(users.iter().filter(|u| u.role.is_admin()).count() as i64)
}
