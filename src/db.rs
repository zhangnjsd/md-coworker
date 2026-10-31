//! PostgreSQL persistence: users, sessions, login challenges and 2FA tickets.
//!
//! Queries run through a `sqlx` pool, so they are `async` and never block the
//! reactor. The schema is created on startup with idempotent `CREATE TABLE IF
//! NOT EXISTS` statements, which keeps a single-binary deployment simple.

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions};
use std::time::Duration;
use uuid::Uuid;

use crate::crypto;

// ---------------------------------------------------------------- roles

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::User => "user",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "admin" => Ok(Role::Admin),
            "user" => Ok(Role::User),
            other => bail!("未知角色: {other}"),
        }
    }

    pub fn is_admin(self) -> bool {
        matches!(self, Role::Admin)
    }
}

// ---------------------------------------------------------------- users

#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub role: Role,
    pub color: String,
    pub public_key: String,
    pub totp_secret_enc: Option<Vec<u8>>,
    pub totp_enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct ChallengeRow {
    pub user_id: String,
    pub nonce: Vec<u8>,
}

/// Flat mirror of a `users` row, so column order lives in exactly one place.
#[derive(FromRow)]
struct UserRecord {
    id: String,
    username: String,
    role: String,
    color: String,
    public_key: String,
    totp_secret_enc: Option<Vec<u8>>,
    totp_enabled: bool,
    created_at: String,
}

impl UserRecord {
    fn into_row(self) -> Result<UserRow> {
        let role = Role::parse(&self.role)
            .with_context(|| format!("用户 {} 的角色字段非法: {}", self.username, self.role))?;
        Ok(UserRow {
            id: self.id,
            username: self.username,
            role,
            color: self.color,
            public_key: self.public_key,
            totp_secret_enc: self.totp_secret_enc,
            totp_enabled: self.totp_enabled,
            created_at: self.created_at,
        })
    }
}

#[derive(FromRow)]
struct ChallengeRecord {
    user_id: String,
    nonce: Vec<u8>,
}

const USER_COLUMNS: &str =
    "id, username, role, color, public_key, totp_secret_enc, totp_enabled, created_at";

/// Same list, qualified for joins: `sessions` also has a `created_at` column.
const USER_COLUMNS_Q: &str = "u.id, u.username, u.role, u.color, u.public_key, u.totp_secret_enc, u.totp_enabled, u.created_at";

// ---------------------------------------------------------------- time

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------- schema

/// Idempotent DDL, re-run on every startup. Migrations are additive.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    username_lc     TEXT NOT NULL UNIQUE,
    role            TEXT NOT NULL,
    color           TEXT NOT NULL,
    public_key      TEXT NOT NULL,
    totp_secret_enc BYTEA,
    totp_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nonce      BYTEA NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mfa_tickets (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_mfa_tickets_expiry ON mfa_tickets(expires_at);
"#;

// ---------------------------------------------------------------- connection

pub struct Db {
    pool: PgPool,
}

impl Db {
    /// Connect to PostgreSQL and make sure the schema exists.
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(url)
            .await
            .with_context(|| format!("连接 PostgreSQL 失败: {url}"))?;
        sqlx::raw_sql(SCHEMA)
            .execute(&pool)
            .await
            .context("初始化数据表失败")?;
        Ok(Self { pool })
    }

    /// Readiness probe for `/api/health`.
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .context("PostgreSQL 探活失败")?;
        Ok(())
    }

    // ------------------------------------------------------------ users

    pub async fn count_users(&self) -> Result<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await?;
        Ok(count)
    }

    pub async fn create_user(
        &self,
        username: &str,
        role: Role,
        public_key: &str,
    ) -> Result<UserRow> {
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let color = self.pick_color(username).await;
        let sql = format!(
            "INSERT INTO users (id, username, username_lc, role, color, public_key, \
             totp_secret_enc, totp_enabled, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, NULL, FALSE, $7)"
        );
        sqlx::query(&sql)
            .bind(&id)
            .bind(username)
            .bind(username.to_lowercase())
            .bind(role.as_str())
            .bind(&color)
            .bind(public_key)
            .bind(&created_at)
            .execute(&self.pool)
            .await
            .map_err(|e| {
                if is_unique_violation(&e) {
                    anyhow!("用户名已被占用")
                } else {
                    anyhow::Error::new(e)
                }
            })?;
        self.get_user(&id).await?.context("刚创建的用户不存在")
    }

    pub async fn get_user(&self, id: &str) -> Result<Option<UserRow>> {
        let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1");
        let record = sqlx::query_as::<_, UserRecord>(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        record.map(UserRecord::into_row).transpose()
    }

    pub async fn find_user_by_username(&self, username: &str) -> Result<Option<UserRow>> {
        let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE username_lc = $1");
        let record = sqlx::query_as::<_, UserRecord>(&sql)
            .bind(username.to_lowercase())
            .fetch_optional(&self.pool)
            .await?;
        record.map(UserRecord::into_row).transpose()
    }

    pub async fn list_users(&self) -> Result<Vec<UserRow>> {
        let sql = format!("SELECT {USER_COLUMNS} FROM users ORDER BY username_lc ASC");
        let records = sqlx::query_as::<_, UserRecord>(&sql)
            .fetch_all(&self.pool)
            .await?;
        records
            .into_iter()
            .map(UserRecord::into_row)
            .collect::<Result<Vec<_>>>()
    }

    pub async fn set_public_key(&self, id: &str, public_key: &str) -> Result<()> {
        let changed = sqlx::query("UPDATE users SET public_key = $2 WHERE id = $1")
            .bind(id)
            .bind(public_key)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            bail!("用户不存在");
        }
        Ok(())
    }

    pub async fn set_role(&self, id: &str, role: Role) -> Result<()> {
        sqlx::query("UPDATE users SET role = $2 WHERE id = $1")
            .bind(id)
            .bind(role.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_totp(
        &self,
        id: &str,
        secret_enc: Option<Vec<u8>>,
        enabled: bool,
    ) -> Result<()> {
        sqlx::query("UPDATE users SET totp_secret_enc = $2, totp_enabled = $3 WHERE id = $1")
            .bind(id)
            .bind(secret_enc)
            .bind(enabled)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_user(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ------------------------------------------------------------ sessions

    pub async fn create_session(&self, user_id: &str, ttl_secs: i64) -> Result<String> {
        let token = crypto::random_token();
        let now = now_ms();
        sqlx::query(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(&token)
        .bind(user_id)
        .bind(now)
        .bind(now + ttl_secs * 1000)
        .execute(&self.pool)
        .await?;
        Ok(token)
    }

    pub async fn session_user(&self, token: &str) -> Result<Option<UserRow>> {
        let sql = format!(
            "SELECT {USER_COLUMNS_Q} FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token = $1 AND s.expires_at > $2"
        );
        let record = sqlx::query_as::<_, UserRecord>(&sql)
            .bind(token)
            .bind(now_ms())
            .fetch_optional(&self.pool)
            .await?;
        record.map(UserRecord::into_row).transpose()
    }

    pub async fn delete_session(&self, token: &str) -> Result<()> {
        sqlx::query("DELETE FROM sessions WHERE token = $1")
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_user_sessions(&self, user_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM sessions WHERE user_id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ------------------------------------------------------------ login challenges

    pub async fn create_challenge(
        &self,
        user_id: &str,
        nonce: &[u8],
        ttl_secs: i64,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO challenges (id, user_id, nonce, expires_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(nonce)
        .bind(now_ms() + ttl_secs * 1000)
        .execute(&mut *tx)
        .await?;
        // Drop expired challenges in the same transaction.
        sqlx::query("DELETE FROM challenges WHERE expires_at <= $1")
            .bind(now_ms())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(id)
    }

    /// Consume a challenge once; it is deleted either way.
    pub async fn consume_challenge(&self, id: &str) -> Result<Option<ChallengeRow>> {
        let mut tx = self.pool.begin().await?;
        let record = sqlx::query_as::<_, ChallengeRecord>(
            "SELECT user_id, nonce FROM challenges WHERE id = $1 AND expires_at > $2",
        )
        .bind(id)
        .bind(now_ms())
        .fetch_optional(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM challenges WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(record.map(|r| ChallengeRow {
            user_id: r.user_id,
            nonce: r.nonce,
        }))
    }

    // ------------------------------------------------------------ 2FA tickets

    pub async fn create_mfa_ticket(&self, user_id: &str, ttl_secs: i64) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO mfa_tickets (id, user_id, expires_at) VALUES ($1, $2, $3)")
            .bind(&id)
            .bind(user_id)
            .bind(now_ms() + ttl_secs * 1000)
            .execute(&self.pool)
            .await?;
        Ok(id)
    }

    /// Look up the user behind a ticket. The ticket is kept so a wrong code can be
    /// retried, and it stops working once it expires.
    pub async fn mfa_ticket_user(&self, ticket: &str) -> Result<Option<UserRow>> {
        let sql = format!(
            "SELECT {USER_COLUMNS_Q} FROM mfa_tickets t JOIN users u ON u.id = t.user_id
             WHERE t.id = $1 AND t.expires_at > $2"
        );
        let record = sqlx::query_as::<_, UserRecord>(&sql)
            .bind(ticket)
            .bind(now_ms())
            .fetch_optional(&self.pool)
            .await?;
        record.map(UserRecord::into_row).transpose()
    }

    pub async fn consume_mfa_ticket(&self, ticket: &str) -> Result<()> {
        sqlx::query("DELETE FROM mfa_tickets WHERE id = $1")
            .bind(ticket)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn cleanup(&self) -> Result<()> {
        let now = now_ms();
        sqlx::query("DELETE FROM sessions WHERE expires_at <= $1")
            .bind(now)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM challenges WHERE expires_at <= $1")
            .bind(now)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM mfa_tickets WHERE expires_at <= $1")
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn pick_color(&self, username: &str) -> String {
        let count = self.count_users().await.unwrap_or(0).max(0) as usize;
        if count == 0 {
            return PALETTE[0].to_string();
        }
        // Spread colours by username hash and user count, so different users rarely collide.
        let hash = username
            .bytes()
            .fold(0u64, |acc, b| acc.wrapping_mul(131).wrapping_add(b as u64));
        PALETTE[(hash as usize + count) % PALETTE.len()].to_string()
    }
}

/// `sqlx` reports unique violations as a database error with SQLSTATE 23505.
fn is_unique_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(db) => db.code().as_deref() == Some("23505"),
        _ => false,
    }
}

// Presence palette: ten desaturated hues at a similar lightness, so a caret or
// avatar dot stays legible on the dark slate UI without shouting over the text.
const PALETTE: [&str; 10] = [
    "#70dbbc", "#80c7f8", "#c9b0fb", "#f89caa", "#f1bd73", "#74d3d8", "#a9d17f", "#dfa8e1",
    "#fba98a", "#9fb0c9",
];
