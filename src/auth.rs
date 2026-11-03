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
use std::{
    collections::HashMap,
    sync::LazyLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub const COOKIE_NAME: &str = "mc_sid";
const CHALLENGE_TTL_SECS: i64 = 120;
const MFA_TICKET_TTL_SECS: i64 = 300;
/// Rejected TOTP codes a single ticket survives before it is burned; the user has to
/// log in with the private key again.
const MFA_MAX_ATTEMPTS: i32 = 5;

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
            .await
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

/// Whether the session cookie may carry `Secure`: either the operator forced it with
/// `--secure-cookies`, or this request provably arrived over TLS at the reverse proxy.
pub fn cookie_secure(state: &AppState, headers: &HeaderMap) -> bool {
    state.cfg.secure_cookies || forwarded_proto_is_https(headers)
}

fn forwarded_proto_is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("https")
        })
        .unwrap_or(false)
}

/// Build the session cookie.
///
/// `Secure` is set whenever the request came in over HTTPS (directly or through a
/// `X-Forwarded-Proto` proxy) or when `--secure-cookies` is on; `Path` follows
/// `--base-path` so a sub-path deployment gets a correctly scoped cookie. Both are
/// derived from configuration, so no manual step is needed to run behind TLS.
fn session_cookie(token: &str, ttl_secs: u64, secure: bool, path: &str) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={token}; Path={path}; HttpOnly; SameSite=Lax; Max-Age={ttl_secs}{secure}"
    ))
    .expect("会话 Cookie 一定合法")
}

fn clear_cookie(secure: bool, path: &str) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}=; Path={path}; HttpOnly; SameSite=Lax; Max-Age=0{secure}"
    ))
    .expect("清理 Cookie 一定合法")
}

/// Username created on the very first start; its seed is handed out exactly once.
const BOOTSTRAP_USERNAME: &str = "admin";

/// The first-run key file exists only to hand the seed to the operator once. Delete it as
/// soon as that administrator has actually signed in, so a plaintext private key does not
/// stay on disk forever; the operator is told to store it elsewhere by the banner.
fn retire_bootstrap_key(state: &AppState, user: &UserRow) {
    if user.username != BOOTSTRAP_USERNAME || user.role != Role::Admin {
        return;
    }
    let path = state.cfg.data_dir.join("bootstrap-admin.key");
    match std::fs::remove_file(&path) {
        Ok(()) => {
            tracing::info!(file = %path.display(), "管理员首次登录成功，已删除引导私钥文件")
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!(file = %path.display(), error = %err, "删除引导私钥文件失败"),
    }
}

async fn login_response(state: &AppState, user: &UserRow, secure: bool) -> ApiResult<Response> {
    let token = state
        .db
        .create_session(&user.id, state.cfg.session_ttl.as_secs() as i64)
        .await?;
    retire_bootstrap_key(state, user);
    let body = json!({ "status": "ok", "user": UserDto::from(user) });
    let mut response = (StatusCode::OK, Json(body)).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(
            &token,
            state.cfg.session_ttl.as_secs(),
            secure,
            state.cfg.cookie_path(),
        ),
    );
    Ok(response)
}

// ---------------------------------------------------------------- rate limiting

/// Failed sign-in / 2FA attempts tolerated per username within [`AUTH_WINDOW`].
const AUTH_MAX_FAILURES: u32 = 10;
/// Challenges the whole process may hand out within [`CHALLENGE_WINDOW`].
const CHALLENGE_MAX_REQUESTS: u32 = 60;
const AUTH_WINDOW: Duration = Duration::from_secs(60);
const CHALLENGE_WINDOW: Duration = Duration::from_secs(60);

/// A fixed-window counter for one key.
struct Bucket {
    start: Instant,
    count: u32,
}

impl Bucket {
    fn expired(&self, now: Instant, window: Duration) -> bool {
        now.saturating_duration_since(self.start) >= window
    }

    /// Seconds until the window opens again; never zero, so `Retry-After` stays useful.
    fn retry_after(&self, now: Instant, window: Duration) -> u64 {
        window
            .saturating_sub(now.saturating_duration_since(self.start))
            .as_secs()
            .max(1)
    }
}

/// Process-local fixed-window limiter.
///
/// Deliberately in memory: the deployment is a single binary with no extra services,
/// and the limit only has to slow down online guessing, not be exact across restarts.
struct RateLimiter {
    window: Duration,
    limit: u32,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    fn new(window: Duration, limit: u32) -> Self {
        Self {
            window,
            limit,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Reject when `key` already burned its allowance; the attempt is not counted.
    async fn check(&self, key: &str) -> Result<(), AppError> {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().await;
        Self::prune(&mut buckets, now, self.window);
        match buckets.get(key) {
            Some(bucket) if bucket.count >= self.limit => {
                Err(AppError::rate_limited(bucket.retry_after(now, self.window)))
            }
            _ => Ok(()),
        }
    }

    /// Count one attempt and reject when it does not fit in the window any more.
    async fn try_hit(&self, key: &str) -> Result<(), AppError> {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().await;
        Self::prune(&mut buckets, now, self.window);
        let bucket = Self::bucket(&mut buckets, key, now, self.window);
        if bucket.count >= self.limit {
            return Err(AppError::rate_limited(bucket.retry_after(now, self.window)));
        }
        bucket.count += 1;
        Ok(())
    }

    /// Count one failure for `key`; failures never reject by themselves.
    async fn record_failure(&self, key: &str) {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().await;
        Self::prune(&mut buckets, now, self.window);
        let bucket = Self::bucket(&mut buckets, key, now, self.window);
        bucket.count = bucket.count.saturating_add(1);
    }

    /// Forget a key, so a successful login clears the failure window.
    async fn forget(&self, key: &str) {
        self.buckets.lock().await.remove(key);
    }

    /// Get the live bucket for `key`, restarting its window when it is stale.
    fn bucket<'a>(
        buckets: &'a mut HashMap<String, Bucket>,
        key: &str,
        now: Instant,
        window: Duration,
    ) -> &'a mut Bucket {
        let bucket = buckets.entry(key.to_string()).or_insert(Bucket {
            start: now,
            count: 0,
        });
        if bucket.count > 0 && bucket.expired(now, window) {
            bucket.start = now;
            bucket.count = 0;
        }
        bucket
    }

    /// Drop windows that can no longer reject anything, so the map cannot grow forever.
    fn prune(buckets: &mut HashMap<String, Bucket>, now: Instant, window: Duration) {
        buckets.retain(|_, bucket| !bucket.expired(now, window));
    }
}

/// Failed login / 2FA attempts, keyed by (lower-cased) username. Both endpoints share
/// one window so an attacker cannot spend the budget twice by switching step.
static AUTH_FAILURES: LazyLock<RateLimiter> =
    LazyLock::new(|| RateLimiter::new(AUTH_WINDOW, AUTH_MAX_FAILURES));
/// Challenge issue rate, process-wide: every challenge is a database row.
static CHALLENGE_REQUESTS: LazyLock<RateLimiter> =
    LazyLock::new(|| RateLimiter::new(CHALLENGE_WINDOW, CHALLENGE_MAX_REQUESTS));
/// TOTP codes submitted from an authenticated session (`/api/me/2fa/*`,
/// `/api/me/keypair`), keyed like the login window. A six-digit code has a million
/// values, so without this a stolen cookie could brute-force the second factor off.
static TOTP_FAILURES: LazyLock<RateLimiter> =
    LazyLock::new(|| RateLimiter::new(AUTH_WINDOW, AUTH_MAX_FAILURES));

/// Rate-limit key for a username: usernames are case-insensitive, so variants must
/// share one bucket.
fn rate_key(username: &str) -> String {
    username.to_lowercase()
}

/// Short id prefix for logs: enough to correlate lines, not enough to reuse the ticket
/// (which is a bearer credential for the second factor).
fn id_prefix(id: &str) -> String {
    id.chars().take(8).collect()
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
    // Process-wide cap: every challenge writes a database row, so this is also the
    // cheapest way to keep the table from being filled by a crawler.
    CHALLENGE_REQUESTS.try_hit("challenge").await?;

    let username = req.username.trim();
    if username.is_empty() {
        return Err(AppError::bad_request("bad_request", "用户名不能为空"));
    }
    let user = match state.db.find_user_by_username(username).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            tracing::warn!(username = %username, "登录挑战被拒绝：用户不存在");
            // Charge the failure to the requested name: otherwise an attacker could
            // test usernames without ever touching the per-username window.
            AUTH_FAILURES.record_failure(&rate_key(username)).await;
            return Err(AppError::not_found("unknown_user", "用户不存在"));
        }
        Err(err) => return Err(err.into()),
    };

    let nonce = crypto::random_bytes(32);
    let challenge_id = state
        .db
        .create_challenge(&user.id, &nonce, CHALLENGE_TTL_SECS)
        .await?;

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
    headers: HeaderMap,
    Json(req): Json<LoginReq>,
) -> ApiResult<Response> {
    let challenge = state
        .db
        .consume_challenge(&req.challenge_id)
        .await?
        .ok_or_else(|| AppError::unauthorized("challenge_expired", "登录挑战已过期，请重试"))?;

    let user = state
        .db
        .get_user(&challenge.user_id)
        .await?
        .ok_or_else(|| AppError::unauthorized("unknown_user", "用户不存在"))?;

    let key = rate_key(&user.username);
    AUTH_FAILURES.check(&key).await?;

    if !crypto::verify_signature(&user.public_key, &challenge.nonce, &req.signature) {
        AUTH_FAILURES.record_failure(&key).await;
        tracing::warn!(username = %user.username, "登录失败：签名校验未通过");
        return Err(AppError::unauthorized(
            "bad_signature",
            "签名校验失败：私钥与该用户不匹配",
        ));
    }

    AUTH_FAILURES.forget(&key).await;

    if user.totp_enabled {
        let ticket = state
            .db
            .create_mfa_ticket(&user.id, MFA_TICKET_TTL_SECS)
            .await?;
        return Ok(Json(json!({ "status": "mfa_required", "ticket": ticket })).into_response());
    }

    login_response(&state, &user, cookie_secure(&state, &headers)).await
}

#[derive(Deserialize)]
pub struct MfaReq {
    ticket: String,
    code: String,
}

pub async fn verify_mfa(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<MfaReq>,
) -> ApiResult<Response> {
    let ticket = state
        .db
        .mfa_ticket_user(&req.ticket)
        .await?
        .ok_or_else(|| AppError::unauthorized("mfa_expired", "二次验证会话已过期，请重新登录"))?;
    let user = ticket.user;
    if ticket.attempts >= MFA_MAX_ATTEMPTS {
        // Defensive: a ticket already over budget must never open a session, even if a
        // failure path above managed to leave it behind.
        state.db.consume_mfa_ticket(&req.ticket).await?;
        tracing::warn!(
            username = %user.username,
            ticket = %id_prefix(&req.ticket),
            attempts = ticket.attempts,
            "二次验证失败：ticket 已因错误次数过多作废"
        );
        return Err(AppError::bad_request("bad_totp", "动态验证码不正确"));
    }

    let key = rate_key(&user.username);
    AUTH_FAILURES.check(&key).await?;

    let secret = totp_secret(&state.cipher, &user)?;
    if !crypto::verify_totp(&secret, &req.code) {
        let attempts = state.db.bump_mfa_attempts(&req.ticket).await?;
        AUTH_FAILURES.record_failure(&key).await;
        // Burning the ticket after repeated misses forces a fresh private-key login,
        // so a stolen ticket cannot be brute-forced offline of the login limiter.
        let exhausted = attempts >= MFA_MAX_ATTEMPTS;
        if exhausted {
            state.db.consume_mfa_ticket(&req.ticket).await?;
        }
        tracing::warn!(
            username = %user.username,
            ticket = %id_prefix(&req.ticket),
            attempts,
            exhausted,
            "二次验证失败：动态验证码不正确"
        );
        return Err(AppError::bad_request("bad_totp", "动态验证码不正确"));
    }

    state.db.consume_mfa_ticket(&req.ticket).await?;
    AUTH_FAILURES.forget(&key).await;
    login_response(&state, &user, cookie_secure(&state, &headers)).await
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    auth: AuthUser,
) -> ApiResult<Response> {
    state.db.delete_session(&auth.token).await?;
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        clear_cookie(cookie_secure(&state, &headers), state.cfg.cookie_path()),
    );
    Ok(response)
}

pub async fn me(auth: AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "user": UserDto::from(&auth.user) })))
}

// ---------------------------------------------------------------- account self-service

#[derive(Deserialize)]
pub struct KeypairReq {
    #[serde(default)]
    totp: Option<String>,
}

/// `POST /api/me/keypair`: replace the caller's keypair.
///
/// Because the private key is what a human holds to sign in, a successful rotation must
/// not leave other sessions alive: any device holding the old cookie is logged out, and
/// a user with 2FA enabled has to prove a current code first.
pub async fn regenerate_own_keypair(
    State(state): State<AppState>,
    auth: AuthUser,
    body: Option<Json<KeypairReq>>,
) -> ApiResult<Json<Value>> {
    if auth.user.totp_enabled {
        let code = body
            .as_ref()
            .and_then(|Json(req)| req.totp.as_deref())
            .map(str::trim)
            .filter(|code| !code.is_empty())
            .ok_or_else(|| {
                tracing::warn!(username = %auth.user.username, "密钥重置被拒绝：缺少动态验证码");
                AppError::bad_request("mfa_required", "该账号已启用二次验证，请提供当前动态验证码")
            })?;
        verify_totp_checked(&state, &auth, code).await?;
    }

    let (private_key, public_key) = crypto::generate_keypair();
    state.db.set_public_key(&auth.user.id, &public_key).await?;
    state
        .db
        .delete_user_sessions_except(&auth.user.id, &auth.token)
        .await?;
    tracing::info!(user = %auth.user.username, "用户自助重置密钥对，已吊销其它会话");
    Ok(Json(json!({
        "private_key": private_key,
        "private_key_text": crypto::key_text(&private_key).map_err(AppError::from)?,
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
    state
        .db
        .set_totp(&auth.user.id, Some(sealed), false)
        .await?;

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
    verify_totp_checked(&state, &auth, &req.code).await?;
    state
        .db
        .set_totp(&auth.user.id, auth.user.totp_secret_enc.clone(), true)
        .await?;
    let user = state
        .db
        .get_user(&auth.user.id)
        .await?
        .context("用户消失")?;
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
    verify_totp_checked(&state, &auth, &req.code).await?;
    state.db.set_totp(&auth.user.id, None, false).await?;
    let user = state
        .db
        .get_user(&auth.user.id)
        .await?
        .context("用户消失")?;
    tracing::info!(user = %user.username, "关闭 2FA");
    Ok(Json(json!({ "user": UserDto::from(&user) })))
}

/// Verify a TOTP `code` supplied by a signed-in user, counting failures per username.
async fn verify_totp_checked(
    state: &AppState,
    auth: &AuthUser,
    code: &str,
) -> Result<(), AppError> {
    let key = rate_key(&auth.user.username);
    TOTP_FAILURES.check(&key).await?;
    let secret = totp_secret(&state.cipher, &auth.user)?;
    if crypto::verify_totp(&secret, code) {
        TOTP_FAILURES.forget(&key).await;
        Ok(())
    } else {
        TOTP_FAILURES.record_failure(&key).await;
        tracing::warn!(username = %auth.user.username, "动态验证码不正确");
        Err(AppError::bad_request("bad_totp", "动态验证码不正确"))
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderName;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).expect("头名合法"),
                HeaderValue::from_str(value).expect("头值合法"),
            );
        }
        map
    }

    #[test]
    fn forwarded_proto_detects_https_hop_only() {
        assert!(!forwarded_proto_is_https(&headers(&[])));
        assert!(forwarded_proto_is_https(&headers(&[(
            "x-forwarded-proto",
            "https"
        )])));
        assert!(forwarded_proto_is_https(&headers(&[(
            "x-forwarded-proto",
            "HTTPS"
        )])));
        assert!(forwarded_proto_is_https(&headers(&[(
            "x-forwarded-proto",
            "https, http"
        )])));
        assert!(!forwarded_proto_is_https(&headers(&[(
            "x-forwarded-proto",
            "http"
        )])));
        // A proxy chain that terminated TLS further upstream must not turn Secure on.
        assert!(!forwarded_proto_is_https(&headers(&[(
            "x-forwarded-proto",
            "http, https"
        )])));
    }

    #[test]
    fn rate_limiter_rejects_after_limit_and_forgets() {
        let limiter = RateLimiter::new(Duration::from_secs(60), 2);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("测试运行时");
        rt.block_on(async {
            assert!(limiter.try_hit("alice").await.is_ok());
            assert!(limiter.try_hit("alice").await.is_ok());
            assert!(limiter.try_hit("alice").await.is_err());
            // Other keys have their own budget.
            assert!(limiter.try_hit("bob").await.is_ok());
            limiter.forget("alice").await;
            assert!(limiter.check("alice").await.is_ok());
            assert!(limiter.try_hit("alice").await.is_ok());
        });
    }

    #[test]
    fn rate_limiter_prunes_empty_buckets() {
        let limiter = RateLimiter::new(Duration::from_millis(0), 1);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("测试运行时");
        rt.block_on(async {
            limiter.record_failure("carol").await;
            // A zero-length window expires immediately, so the next insert prunes it.
            limiter.record_failure("dave").await;
            assert_eq!(limiter.buckets.lock().await.len(), 1);
        });
    }
}
