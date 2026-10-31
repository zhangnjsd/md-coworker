//! Shared application state and the DTOs exposed over the API.

use crate::{collab::Hub, config::Config, crypto::Cipher, db::Db};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: Arc<Db>,
    pub cipher: Arc<Cipher>,
    pub hub: Arc<Hub>,
}

#[derive(Debug, Serialize)]
pub struct UserDto {
    pub id: String,
    pub username: String,
    pub role: crate::db::Role,
    pub color: String,
    pub twofa_enabled: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

impl From<&crate::db::UserRow> for UserDto {
    fn from(user: &crate::db::UserRow) -> Self {
        Self {
            id: user.id.clone(),
            username: user.username.clone(),
            role: user.role,
            color: user.color.clone(),
            twofa_enabled: user.totp_enabled,
            created_at: user.created_at.clone(),
            online: None,
        }
    }
}
