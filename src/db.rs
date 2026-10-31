//! SQLite persistence: users, sessions, login challenges and 2FA tickets.
//!
//! `rusqlite` (bundled SQLite) is used through its synchronous API behind a
//! `Mutex<Connection>`. For a single-node, small-team deployment these queries take
//! microseconds, so no connection pool is introduced.

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};
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

// ---------------------------------------------------------------- time

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------- connection

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("打开 SQLite 失败: {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS users (
                id              TEXT PRIMARY KEY,
                username        TEXT NOT NULL,
                username_lc     TEXT NOT NULL UNIQUE,
                role            TEXT NOT NULL,
                color           TEXT NOT NULL,
                public_key      TEXT NOT NULL,
                totp_secret_enc BLOB,
                totp_enabled    INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS challenges (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                nonce      BLOB NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mfa_tickets (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
            "#,
        )
        .context("初始化数据表失败")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("SQLite 连接互斥量被毒化")
    }

    // ------------------------------------------------------------ users

    pub fn count_users(&self) -> Result<i64> {
        let conn = self.conn();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
        Ok(count)
    }

    pub fn create_user(&self, username: &str, role: Role, public_key: &str) -> Result<UserRow> {
        let id = Uuid::new_v4().to_string();
        let created_at = now_rfc3339();
        let color = pick_color(&self.conn(), username);
        {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO users (id, username, username_lc, role, color, public_key, totp_enabled, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
                params![id, username, username.to_lowercase(), role.as_str(), color, public_key, created_at],
            )
            .map_err(|e| {
                if is_unique_violation(&e) {
                    anyhow!("用户名已被占用")
                } else {
                    anyhow::Error::new(e)
                }
            })?;
        }
        self.get_user(&id)?.context("刚创建的用户不存在")
    }

    pub fn get_user(&self, id: &str) -> Result<Option<UserRow>> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT id, username, role, color, public_key, totp_secret_enc, totp_enabled, created_at
                 FROM users WHERE id = ?1",
                params![id],
                map_user,
            )
            .optional()?;
        Ok(row)
    }

    pub fn find_user_by_username(&self, username: &str) -> Result<Option<UserRow>> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT id, username, role, color, public_key, totp_secret_enc, totp_enabled, created_at
                 FROM users WHERE username_lc = ?1",
                params![username.to_lowercase()],
                map_user,
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_users(&self) -> Result<Vec<UserRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, username, role, color, public_key, totp_secret_enc, totp_enabled, created_at
             FROM users ORDER BY username_lc ASC",
        )?;
        let rows = stmt.query_map([], map_user)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_public_key(&self, id: &str, public_key: &str) -> Result<()> {
        let conn = self.conn();
        let changed = conn.execute(
            "UPDATE users SET public_key = ?2 WHERE id = ?1",
            params![id, public_key],
        )?;
        if changed == 0 {
            bail!("用户不存在");
        }
        Ok(())
    }

    pub fn set_role(&self, id: &str, role: Role) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "UPDATE users SET role = ?2 WHERE id = ?1",
            params![id, role.as_str()],
        )?;
        Ok(())
    }

    pub fn set_totp(&self, id: &str, secret_enc: Option<Vec<u8>>, enabled: bool) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "UPDATE users SET totp_secret_enc = ?2, totp_enabled = ?3 WHERE id = ?1",
            params![id, secret_enc, enabled as i64],
        )?;
        Ok(())
    }

    pub fn delete_user(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------------------------------------------------------ sessions

    pub fn create_session(&self, user_id: &str, ttl_secs: i64) -> Result<String> {
        let token = crypto::random_token();
        let now = now_ms();
        let conn = self.conn();
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![token, user_id, now, now + ttl_secs * 1000],
        )?;
        Ok(token)
    }

    pub fn session_user(&self, token: &str) -> Result<Option<UserRow>> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT u.id, u.username, u.role, u.color, u.public_key, u.totp_secret_enc,
                        u.totp_enabled, u.created_at
                 FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token = ?1 AND s.expires_at > ?2",
                params![token, now_ms()],
                map_user,
            )
            .optional()?;
        Ok(row)
    }

    pub fn delete_session(&self, token: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM sessions WHERE token = ?1", params![token])?;
        Ok(())
    }

    pub fn delete_user_sessions(&self, user_id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM sessions WHERE user_id = ?1", params![user_id])?;
        Ok(())
    }

    // ------------------------------------------------------------ login challenges

    pub fn create_challenge(&self, user_id: &str, nonce: &[u8], ttl_secs: i64) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let conn = self.conn();
        conn.execute(
            "INSERT INTO challenges (id, user_id, nonce, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, user_id, nonce, now_ms() + ttl_secs * 1000],
        )?;
        // Also drop expired challenges.
        conn.execute(
            "DELETE FROM challenges WHERE expires_at <= ?1",
            params![now_ms()],
        )?;
        Ok(id)
    }

    /// Consume a challenge once; it is deleted either way.
    pub fn consume_challenge(&self, id: &str) -> Result<Option<ChallengeRow>> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT user_id, nonce FROM challenges WHERE id = ?1 AND expires_at > ?2",
                params![id, now_ms()],
                |row| {
                    Ok(ChallengeRow {
                        user_id: row.get(0)?,
                        nonce: row.get(1)?,
                    })
                },
            )
            .optional()?;
        conn.execute("DELETE FROM challenges WHERE id = ?1", params![id])?;
        Ok(row)
    }

    // ------------------------------------------------------------ 2FA tickets

    pub fn create_mfa_ticket(&self, user_id: &str, ttl_secs: i64) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let conn = self.conn();
        conn.execute(
            "INSERT INTO mfa_tickets (id, user_id, expires_at) VALUES (?1, ?2, ?3)",
            params![id, user_id, now_ms() + ttl_secs * 1000],
        )?;
        Ok(id)
    }

    /// Look up the user behind a ticket. The ticket is kept so the code can be
    /// retried, and it stops working once it expires.
    pub fn mfa_ticket_user(&self, ticket: &str) -> Result<Option<UserRow>> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT u.id, u.username, u.role, u.color, u.public_key, u.totp_secret_enc,
                        u.totp_enabled, u.created_at
                 FROM mfa_tickets t JOIN users u ON u.id = t.user_id
                 WHERE t.id = ?1 AND t.expires_at > ?2",
                params![ticket, now_ms()],
                map_user,
            )
            .optional()?;
        Ok(row)
    }

    pub fn consume_mfa_ticket(&self, ticket: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM mfa_tickets WHERE id = ?1", params![ticket])?;
        Ok(())
    }

    pub fn cleanup(&self) -> Result<()> {
        let conn = self.conn();
        let now = now_ms();
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])?;
        conn.execute(
            "DELETE FROM challenges WHERE expires_at <= ?1",
            params![now],
        )?;
        conn.execute(
            "DELETE FROM mfa_tickets WHERE expires_at <= ?1",
            params![now],
        )?;
        Ok(())
    }
}

fn map_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRow> {
    let role: String = row.get(2)?;
    Ok(UserRow {
        id: row.get(0)?,
        username: row.get(1)?,
        role: Role::parse(&role).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, e.into())
        })?,
        color: row.get(3)?,
        public_key: row.get(4)?,
        totp_secret_enc: row.get(5)?,
        totp_enabled: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
    })
}

fn is_unique_violation(error: &rusqlite::Error) -> bool {
    match error {
        rusqlite::Error::SqliteFailure(inner, _) => {
            inner.code == rusqlite::ErrorCode::ConstraintViolation
        }
        _ => false,
    }
}

// Presence palette: ten desaturated hues at a similar lightness, so a caret or
// avatar dot stays legible on the dark slate UI without shouting over the text.
const PALETTE: [&str; 10] = [
    "#70dbbc", "#80c7f8", "#c9b0fb", "#f89caa", "#f1bd73", "#74d3d8", "#a9d17f", "#dfa8e1",
    "#fba98a", "#9fb0c9",
];

fn pick_color(conn: &Connection, username: &str) -> String {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
        .unwrap_or(0);
    if count <= 0 {
        return PALETTE[0].to_string();
    }
    // Spread colours by username hash and user count, so different users rarely collide.
    let hash = username
        .bytes()
        .fold(0u64, |acc, b| acc.wrapping_mul(131).wrapping_add(b as u64));
    PALETTE[((hash as usize) + count as usize) % PALETTE.len()].to_string()
}
