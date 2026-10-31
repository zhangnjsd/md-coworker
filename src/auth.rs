//! Authentication: Ed25519 challenge-response login, optional TOTP second factor,
//! session cookies, and the self-service account endpoints.
//!
//! There are no passwords anywhere: the server only stores public keys, and a private
//! key is handed to the client exactly once when a user is created or reset.

use crate::{
    crypto::{self, Cipher},
    db::{Role, UserRow},
    error::{ApiResult, AppError},
    models::{AppState, UserDto},
};
use anyhow::Context;
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::Deserialize;
use serde_json::{Value, json};

pub const COOKIE_NAME: &str = "mc_sid";
const CHALLENGE_TTL_SECS: i64 = 120;
const MFA_TICKET_TTL_SECS: i64 = 300;

// ---------------------------------------------------------------- extractors

/// An authenticated user.
pub struct AuthUser {
    pub user: UserRow,
    pub token: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = cookie_value(&parts.headers, COOKIE_NAME)
            .ok_or_else(|| AppError::unauthorized("unauthorized", "未登录，请先使用密钥登录"))?;
        let user = state
            .db
            .session_user(&token)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::unauthorized("unauthorized", "会话不存在或已过期"))?;
        Ok(Self { user, token })
    }
}

/// An administrator.
pub struct AdminUser(pub AuthUser);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth = AuthUser::from_request_parts(parts, state).await?;
        if !auth.user.role.is_admin() {
            return Err(AppError::forbidden("forbidden", "需要管理员权限"));
        }
        Ok(AdminUser(auth))
    }
}

// ---------------------------------------------------------------- cookie helpers

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let mut kv = part.trim().splitn(2, '=');
        let key = kv.next()?.trim();
        let value = kv.next()?.trim();
        (key == name && !value.is_empty()).then(|| value.to_string())
    })
}

fn session_cookie(token: &str, ttl_secs: u64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={ttl_secs}"
    ))
    .expect("会话 Cookie 一定合法")
}

fn clear_cookie() -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    ))
    .expect("清理 Cookie 一定合法")
}

fn login_response(state: &AppState, user: &UserRow) -> ApiResult<Response> {
    let token = state
        .db
        .create_session(&user.id, state.cfg.session_ttl.as_secs() as i64)?;
    let body = json!({ "status": "ok", "user": UserDto::from(user) });
    let mut response = (StatusCode::OK, Json(body)).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(&token, state.cfg.session_ttl.as_secs()),
    );
    Ok(response)
}

// ---------------------------------------------------------------- login flow

#[derive(Deserialize)]
pub struct ChallengeReq {
    username: String,
}

pub async fn challenge(
    State(state): State<AppState>,
    Json(req): Json<ChallengeReq>,
) -> ApiResult<Json<Value>> {
    let username = req.username.trim();
    if username.is_empty() {
        return Err(AppError::bad_request("bad_request", "用户名不能为空"));
    }
    let user = state
        .db
        .find_user_by_username(username)?
        .ok_or_else(|| AppError::not_found("unknown_user", "用户不存在"))?;

    let nonce = crypto::random_bytes(32);
    let challenge_id = state
        .db
        .create_challenge(&user.id, &nonce, CHALLENGE_TTL_SECS)?;

    Ok(Json(json!({
        "challenge_id": challenge_id,
        "nonce": B64.encode(&nonce),
        "has_2fa": user.totp_enabled,
        "expires_in": CHALLENGE_TTL_SECS,
    })))
}

#[derive(Deserialize)]
pub struct LoginReq {
    challenge_id: String,
    signature: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> ApiResult<Response> {
    let challenge = state
        .db
        .consume_challenge(&req.challenge_id)?
        .ok_or_else(|| AppError::unauthorized("challenge_expired", "登录挑战已过期，请重试"))?;

    let user = state
        .db
        .get_user(&challenge.user_id)?
        .ok_or_else(|| AppError::unauthorized("unknown_user", "用户不存在"))?;

    if !crypto::verify_signature(&user.public_key, &challenge.nonce, &req.signature) {
        return Err(AppError::unauthorized(
            "bad_signature",
            "签名校验失败：私钥与该用户不匹配",
        ));
    }

    if user.totp_enabled {
        let ticket = state.db.create_mfa_ticket(&user.id, MFA_TICKET_TTL_SECS)?;
        return Ok(Json(json!({ "status": "mfa_required", "ticket": ticket })).into_response());
    }

    login_response(&state, &user)
}

#[derive(Deserialize)]
pub struct MfaReq {
    ticket: String,
    code: String,
}

pub async fn verify_mfa(
    State(state): State<AppState>,
    Json(req): Json<MfaReq>,
) -> ApiResult<Response> {
    let user = state
        .db
        .mfa_ticket_user(&req.ticket)?
        .ok_or_else(|| AppError::unauthorized("mfa_expired", "二次验证会话已过期，请重新登录"))?;

    let secret = totp_secret(&state.cipher, &user)?;
    if !crypto::verify_totp(&secret, &req.code) {
        return Err(AppError::unauthorized("bad_totp", "动态验证码不正确"));
    }
    state.db.consume_mfa_ticket(&req.ticket)?;
    login_response(&state, &user)
}

pub async fn logout(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Response> {
    state.db.delete_session(&auth.token)?;
    let mut response = Json(json!({ "ok": true })).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, clear_cookie());
    Ok(response)
}

pub async fn me(auth: AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "user": UserDto::from(&auth.user) })))
}

// ---------------------------------------------------------------- account self-service

pub async fn regenerate_own_keypair(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Value>> {
    let (private_key, public_key) = crypto::generate_keypair();
    state.db.set_public_key(&auth.user.id, &public_key)?;
    tracing::info!(user = %auth.user.username, "用户自助重置密钥对");
    Ok(Json(json!({
        "private_key": private_key,
        "public_key": public_key,
    })))
}

pub async fn totp_setup(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<Value>> {
    if auth.user.totp_enabled {
        return Err(AppError::conflict(
            "totp_enabled",
            "2FA 已启用，如需更换请先关闭",
        ));
    }
    let secret_b32 = crypto::generate_totp_secret();
    let secret_raw = crypto::base32_decode(&secret_b32)?;
    let sealed = state
        .cipher
        .seal(totp_aad(&auth.user.id).as_bytes(), &secret_raw)
        .context("加密 TOTP 种子失败")?;
    state.db.set_totp(&auth.user.id, Some(sealed), false)?;

    Ok(Json(json!({
        "secret": secret_b32,
        "otpauth_url": crypto::otpauth_url("md-coworker", &auth.user.username, &secret_b32),
    })))
}

#[derive(Deserialize)]
pub struct TotpCodeReq {
    code: String,
}

pub async fn totp_enable(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<TotpCodeReq>,
) -> ApiResult<Json<Value>> {
    if auth.user.totp_enabled {
        return Err(AppError::conflict("totp_enabled", "2FA 已启用"));
    }
    let secret = totp_secret(&state.cipher, &auth.user)?;
    if !crypto::verify_totp(&secret, &req.code) {
        return Err(AppError::bad_request("bad_totp", "动态验证码不正确"));
    }
    state
        .db
        .set_totp(&auth.user.id, auth.user.totp_secret_enc.clone(), true)?;
    let user = state.db.get_user(&auth.user.id)?.context("用户消失")?;
    tracing::info!(user = %user.username, "启用 2FA");
    Ok(Json(json!({ "user": UserDto::from(&user) })))
}

pub async fn totp_disable(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<TotpCodeReq>,
) -> ApiResult<Json<Value>> {
    if !auth.user.totp_enabled {
        return Err(AppError::bad_request("totp_disabled", "2FA 未启用"));
    }
    let secret = totp_secret(&state.cipher, &auth.user)?;
    if !crypto::verify_totp(&secret, &req.code) {
        return Err(AppError::bad_request("bad_totp", "动态验证码不正确"));
    }
    state.db.set_totp(&auth.user.id, None, false)?;
    let user = state.db.get_user(&auth.user.id)?.context("用户消失")?;
    tracing::info!(user = %user.username, "关闭 2FA");
    Ok(Json(json!({ "user": UserDto::from(&user) })))
}

// ---------------------------------------------------------------- internal helpers

pub fn totp_aad(user_id: &str) -> String {
    format!("totp:{user_id}")
}

pub fn totp_secret(cipher: &Cipher, user: &UserRow) -> Result<Vec<u8>, AppError> {
    let sealed = user
        .totp_secret_enc
        .as_ref()
        .ok_or_else(|| AppError::bad_request("totp_missing", "该用户尚未配置 2FA"))?;
    cipher
        .open(totp_aad(&user.id).as_bytes(), sealed)
        .context("解密 TOTP 种子失败")
        .map_err(AppError::from)
}

/// Username rule: 2-32 characters, ASCII letters, digits, `_` and `-`.
pub fn validate_username(username: &str) -> Result<(), AppError> {
    let len = username.chars().count();
    if !(2..=32).contains(&len) {
        return Err(AppError::bad_request(
            "bad_username",
            "用户名长度需在 2-32 个字符之间",
        ));
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AppError::bad_request(
            "bad_username",
            "用户名只能包含字母、数字、下划线和连字符",
        ));
    }
    Ok(())
}

/// Admins may pass a role string.
pub fn parse_role(input: &str) -> Result<Role, AppError> {
    Role::parse(input).map_err(|_| AppError::bad_request("bad_role", "角色只能是 admin 或 user"))
}
