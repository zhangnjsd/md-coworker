-- V1: initial schema.
--
-- Written idempotently on purpose: a deployment created before schema versioning
-- existed has the same tables but no `_sqlx_migrations` row, and this migration has to
-- adopt it instead of failing. Every later migration is a plain incremental change.

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

-- `token` holds sha256_hex(session token), never the token itself.
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
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL
);

-- Databases created before 0.1.1 had no attempt counter.
ALTER TABLE mfa_tickets ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_mfa_tickets_expiry ON mfa_tickets(expires_at);
