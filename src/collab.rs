//! Real-time collaboration layer: document rooms (authoritative Yjs CRDT copies),
//! live presence, and the WebSocket protocol.
//!
//! * Every open file maps to one [`Room`] holding a `yrs::Doc` (the Rust port of Yjs).
//! * Incremental Yjs updates from a client are applied to the room document and then
//!   fanned out to the other connections in that room.
//! * Room text is flushed to disk every 400ms (continuous saving), and an encrypted
//!   snapshot is written to `data/crdt/`.
//! * Workspace-wide presence (who is online, which file they edit, where their cursor
//!   is) is broadcast through presence frames.

use crate::{
    auth::AuthUser, config::Config, crypto::Cipher, db::UserRow, error::AppError, files,
    models::AppState,
};
use anyhow::{Context, Result};
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc};
use yrs::{
    Doc, GetString, ReadTxn, StateVector, Text, TextRef, Transact, Update, updates::decoder::Decode,
};

const ROOT_TEXT: &str = "content";
const FLUSH_INTERVAL: Duration = Duration::from_millis(400);
const PRESENCE_INTERVAL: Duration = Duration::from_millis(1000);
const PRESENCE_TTL_MS: i64 = 30_000;
/// How long a rename/delete waits for another writer of the same path before giving up
/// on ordering and proceeding (the operations it guards take microseconds).
const PATH_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------- data

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
pub struct Cursor {
    #[serde(default)]
    pub line: u32,
    #[serde(default)]
    pub ch: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PresenceUser {
    pub id: String,
    pub username: String,
    pub color: String,
    pub path: Option<String>,
    pub cursor: Option<Cursor>,
    pub selection: usize,
    pub last_seen: i64,
}

#[derive(Debug, Clone)]
struct Agent {
    user_id: String,
    username: String,
    color: String,
    path: Option<String>,
    cursor: Option<Cursor>,
    selection: usize,
    last_seen: i64,
}

/// Broadcast events.
#[derive(Debug, Clone)]
pub enum ServerMsg {
    Update {
        path: String,
        update: Vec<u8>,
        from_conn: u64,
        from_user: String,
    },
    Awareness {
        path: String,
        update: Vec<u8>,
        from_conn: u64,
    },
    Peers {
        path: String,
        count: usize,
    },
    Saved {
        path: String,
        ts: i64,
    },
    Presence(Vec<PresenceUser>),
}

/// Cowork room.
pub struct Room {
    pub path: String,
    pub file: PathBuf,
    pub doc: Doc,
    pub text: TextRef,
    pub members: AtomicUsize,
    pub dirty: AtomicBool,
    pub last_saved_ms: AtomicI64,
}

impl Room {
    pub fn content(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }
}

// ---------------------------------------------------------------- Hub

pub struct Hub {
    cfg: Arc<Config>,
    cipher: Arc<Cipher>,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    agents: Mutex<HashMap<u64, Agent>>,
    /// Paths currently being renamed or deleted. While a path sits in here, `ensure_room`
    /// and a WebSocket `join` refuse it with `file_busy` instead of opening a room on a
    /// file that is about to move or disappear.
    path_locks: Mutex<HashSet<String>>,
    path_locks_cv: Condvar,
    tx: broadcast::Sender<ServerMsg>,
    conn_seq: AtomicU64,
    last_presence: Mutex<String>,
}

/// Exclusive write lock on one workspace path, released when dropped.
///
/// Taken by callers that must "check nobody is collaborating, then mutate the
/// filesystem" as one step; dropping the guard (normal return, early `?`, panic) releases
/// the path for the next writer and wakes anyone waiting on it.
pub struct PathLock<'a> {
    locks: &'a Mutex<HashSet<String>>,
    cv: &'a Condvar,
    path: String,
}

impl Drop for PathLock<'_> {
    fn drop(&mut self) {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.remove(&self.path);
        self.cv.notify_all();
    }
}

impl Hub {
    pub fn new(cfg: Arc<Config>, cipher: Arc<Cipher>) -> Self {
        let (tx, _rx) = broadcast::channel(1024);
        Self {
            cfg,
            cipher,
            rooms: Mutex::new(HashMap::new()),
            agents: Mutex::new(HashMap::new()),
            path_locks: Mutex::new(HashSet::new()),
            path_locks_cv: Condvar::new(),
            tx,
            conn_seq: AtomicU64::new(1),
            last_presence: Mutex::new(String::new()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMsg> {
        self.tx.subscribe()
    }

    pub fn next_conn(&self) -> u64 {
        self.conn_seq.fetch_add(1, Ordering::Relaxed)
    }

    fn snapshot_path(&self, path: &str) -> PathBuf {
        let digest = {
            use sha2::Digest;
            sha2::Sha256::digest(path.as_bytes())
        };
        self.cfg
            .snapshots_dir()
            .join(format!("{}.bin", crate::config::hex_encode(&digest)))
    }

    // ------------------------------------------------------------ rooms

    /// Get the room for a path, creating and loading it when necessary.
    pub fn ensure_room(&self, path: &str) -> Result<Arc<Room>, AppError> {
        if self.is_locked(path) {
            return Err(AppError::conflict(
                "file_busy",
                "该文件正在被重命名或删除，请稍后重试",
            ));
        }
        {
            let rooms = self.rooms.lock().expect("rooms 锁被毒化");
            if let Some(room) = rooms.get(path) {
                return Ok(room.clone());
            }
        }

        let abs = files::resolve(&self.cfg.workspace, path)?;
        let meta = std::fs::metadata(&abs)
            .map_err(|_| AppError::not_found("file_not_found", format!("文件不存在: {path}")))?;
        if !meta.is_file() {
            return Err(AppError::bad_request("not_a_file", "只能协作编辑文件"));
        }

        let doc = Doc::new();
        let text = doc.get_or_insert_text(ROOT_TEXT);
        let snapshot = self.snapshot_path(path);

        // Only reuse the snapshot when it is not older than the file on disk, so that
        // external edits (API writes, git checkout, saves from another editor) are never
        // overwritten by a stale CRDT snapshot.
        let snapshot_is_fresh = if snapshot.exists() {
            match (
                std::fs::metadata(&snapshot).and_then(|m| m.modified()),
                std::fs::metadata(&abs).and_then(|m| m.modified()),
            ) {
                (Ok(snap_time), Ok(file_time)) => snap_time >= file_time,
                _ => true,
            }
        } else {
            false
        };

        let loaded_snapshot = if snapshot_is_fresh {
            match std::fs::read(&snapshot)
                .map_err(anyhow::Error::from)
                .and_then(|sealed| self.cipher.open(path.as_bytes(), &sealed))
            {
                Ok(plain) => match Update::decode_v1(&plain) {
                    Ok(update) => match doc.transact_mut().apply_update(update) {
                        Ok(_) => true,
                        Err(err) => {
                            tracing::warn!(path, error = %err, "CRDT 快照应用失败，回退到磁盘内容");
                            false
                        }
                    },
                    Err(err) => {
                        tracing::warn!(path, error = %err, "CRDT 快照解码失败，回退到磁盘内容");
                        false
                    }
                },
                Err(err) => {
                    tracing::warn!(path, error = %err, "CRDT 快照解密失败，回退到磁盘内容");
                    false
                }
            }
        } else {
            false
        };

        if !loaded_snapshot {
            if snapshot.exists() {
                tracing::info!(path, "CRDT 快照已过期，按磁盘内容重建");
                let _ = std::fs::remove_file(&snapshot);
            }
            let content = files::read_text_lossy(&abs)
                .with_context(|| format!("读取初始内容失败: {path}"))?;
            if !content.is_empty() {
                let mut txn = doc.transact_mut();
                text.insert(&mut txn, 0, &content);
            }
        }

        let room = Arc::new(Room {
            path: path.to_string(),
            file: abs,
            doc,
            text,
            members: AtomicUsize::new(0),
            dirty: AtomicBool::new(false),
            last_saved_ms: AtomicI64::new(crate::db::now_ms()),
        });

        if self.is_locked(path) {
            return Err(AppError::conflict(
                "file_busy",
                "该文件正在被重命名或删除，请稍后重试",
            ));
        }
        let mut rooms = self.rooms.lock().expect("rooms 锁被毒化");
        Ok(rooms.entry(path.to_string()).or_insert(room).clone())
    }

    pub fn room(&self, path: &str) -> Option<Arc<Room>> {
        self.rooms
            .lock()
            .expect("rooms 锁被毒化")
            .get(path)
            .cloned()
    }

    pub fn is_active(&self, path: &str) -> bool {
        self.room(path)
            .map(|room| room.members.load(Ordering::Relaxed) > 0)
            .unwrap_or(false)
    }

    /// Take the exclusive write lock for `path`, waiting (bounded) while another writer
    /// holds it. The lock is released by dropping the returned guard.
    ///
    /// Callers use this to make "nobody is collaborating?" and the filesystem mutation
    /// that follows it one critical section.
    pub fn lock_path(&self, path: &str) -> PathLock<'_> {
        let key = files::normalize_rel(path);
        let deadline = Instant::now() + PATH_LOCK_TIMEOUT;
        let mut locks = self
            .path_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while locks.contains(&key) {
            let now = Instant::now();
            if now >= deadline {
                tracing::warn!(path = %key, "等待路径写锁超时，继续执行");
                break;
            }
            let (guard, _) = self
                .path_locks_cv
                .wait_timeout(locks, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locks = guard;
        }
        locks.insert(key.clone());
        PathLock {
            locks: &self.path_locks,
            cv: &self.path_locks_cv,
            path: key,
        }
    }

    /// Is a rename/delete currently holding the write lock for `path`?
    pub fn is_locked(&self, path: &str) -> bool {
        let key = files::normalize_rel(path);
        self.path_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(&key)
    }

    pub fn join(&self, room: &Arc<Room>) -> usize {
        let count = room.members.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.tx.send(ServerMsg::Peers {
            path: room.path.clone(),
            count,
        });
        count
    }

    pub fn leave(&self, room: &Arc<Room>) -> usize {
        // Decrement atomically: with a load/store pair, two connections dropping at the
        // same time could both read 1 and store 0 (or interleave into a stale value),
        // leaving the counter permanently non-zero and the file forever `file_busy`.
        let previous = room
            .members
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                Some(current.saturating_sub(1))
            })
            .unwrap_or(0);
        let count = previous.saturating_sub(1);
        let _ = self.tx.send(ServerMsg::Peers {
            path: room.path.clone(),
            count,
        });
        if count == 0 {
            if let Err(err) = self.flush_room(room) {
                tracing::warn!(path = %room.path, error = %err, "离开房间时保存失败");
            }
            self.recycle_room(room);
        }
        count
    }

    /// Drop an empty room from memory (its snapshot is already on disk and is reloaded on
    /// the next join).
    fn recycle_room(&self, room: &Arc<Room>) {
        let mut rooms = self.rooms.lock().expect("rooms 锁被毒化");
        let removable = rooms
            .get(&room.path)
            .map(|existing| {
                Arc::ptr_eq(existing, room) && existing.members.load(Ordering::Relaxed) == 0
            })
            .unwrap_or(false);
        if removable {
            rooms.remove(&room.path);
            tracing::debug!(path = %room.path, "没有协作者了，回收内存文档");
        }
    }

    /// Apply one Yjs update.
    pub fn apply_update(&self, room: &Arc<Room>, update_bytes: &[u8]) -> Result<()> {
        let update = Update::decode_v1(update_bytes).context("非法的 Yjs 更新二进制")?;
        room.doc
            .transact_mut()
            .apply_update(update)
            .context("应用 Yjs 更新失败")?;
        room.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Flush the room text to disk right now and store an encrypted snapshot.
    pub fn flush_room(&self, room: &Arc<Room>) -> Result<()> {
        if !room.dirty.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        let content = room.content();

        if let Some(parent) = room.file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建父目录失败: {}", parent.display()))?;
        }
        // Write a temp file and rename it, so other tools never observe a half-written file.
        let tmp = room.file.with_file_name(format!(
            ".{}.mc-tmp",
            room.file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "doc".into())
        ));
        std::fs::write(&tmp, content.as_bytes())
            .with_context(|| format!("写入临时文件失败: {}", tmp.display()))?;
        std::fs::rename(&tmp, &room.file)
            .with_context(|| format!("替换文件失败: {}", room.file.display()))?;

        let state = room
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let sealed = self
            .cipher
            .seal(room.path.as_bytes(), &state)
            .context("加密 CRDT 快照失败")?;
        let snapshot = self.snapshot_path(&room.path);
        std::fs::write(&snapshot, sealed)
            .with_context(|| format!("写入 CRDT 快照失败: {}", snapshot.display()))?;

        let ts = crate::db::now_ms();
        room.last_saved_ms.store(ts, Ordering::Relaxed);
        let _ = self.tx.send(ServerMsg::Saved {
            path: room.path.clone(),
            ts,
        });
        Ok(())
    }

    fn flush_dirty(&self) {
        let rooms: Vec<Arc<Room>> = self
            .rooms
            .lock()
            .expect("rooms 锁被毒化")
            .values()
            .cloned()
            .collect();
        for room in rooms {
            if room.dirty.load(Ordering::Relaxed) {
                if let Err(err) = self.flush_room(&room) {
                    tracing::warn!(path = %room.path, error = %err, "定时保存失败");
                }
            }
        }
    }

    pub fn flush_all(&self) {
        let rooms: Vec<Arc<Room>> = self
            .rooms
            .lock()
            .expect("rooms 锁被毒化")
            .values()
            .cloned()
            .collect();
        for room in rooms {
            if let Err(err) = self.flush_room(&room) {
                tracing::warn!(path = %room.path, error = %err, "退出前保存失败");
            }
        }
    }

    /// Drop the snapshot of a file that was renamed or deleted.
    pub fn forget_snapshot(&self, path: &str) {
        let snapshot = self.snapshot_path(path);
        if snapshot.exists() {
            let _ = std::fs::remove_file(snapshot);
        }
        self.rooms.lock().expect("rooms 锁被毒化").remove(path);
    }

    // ------------------------------------------------------------ presence

    pub fn presence_register(&self, conn: u64, user: &UserRow) {
        let mut agents = self.agents.lock().expect("agents 锁被毒化");
        agents.insert(
            conn,
            Agent {
                user_id: user.id.clone(),
                username: user.username.clone(),
                color: user.color.clone(),
                path: None,
                cursor: None,
                selection: 0,
                last_seen: crate::db::now_ms(),
            },
        );
    }

    pub fn presence_update(
        &self,
        conn: u64,
        path: Option<String>,
        cursor: Option<Cursor>,
        selection: usize,
    ) {
        let mut agents = self.agents.lock().expect("agents 锁被毒化");
        if let Some(agent) = agents.get_mut(&conn) {
            if path.is_some() {
                agent.path = path;
            }
            agent.cursor = cursor;
            agent.selection = selection;
            agent.last_seen = crate::db::now_ms();
        }
    }

    pub fn presence_remove(&self, conn: u64) {
        self.agents.lock().expect("agents 锁被毒化").remove(&conn);
    }

    pub fn online_user_ids(&self) -> HashSet<String> {
        self.agents
            .lock()
            .expect("agents 锁被毒化")
            .values()
            .map(|agent| agent.user_id.clone())
            .collect()
    }

    fn presence_snapshot(&self) -> Vec<PresenceUser> {
        let now = crate::db::now_ms();
        let agents = self.agents.lock().expect("agents 锁被毒化");
        // One user may have several tabs open: keep the most recently active one.
        let mut by_user: HashMap<&str, &Agent> = HashMap::new();
        for agent in agents.values() {
            if now - agent.last_seen > PRESENCE_TTL_MS {
                continue;
            }
            by_user
                .entry(agent.user_id.as_str())
                .and_modify(|existing| {
                    if agent.last_seen > existing.last_seen {
                        *existing = agent;
                    }
                })
                .or_insert(agent);
        }
        let mut users: Vec<PresenceUser> = by_user
            .into_values()
            .map(|agent| PresenceUser {
                id: agent.user_id.clone(),
                username: agent.username.clone(),
                color: agent.color.clone(),
                path: agent.path.clone(),
                cursor: agent.cursor,
                selection: agent.selection,
                last_seen: agent.last_seen,
            })
            .collect();
        users.sort_by(|a, b| a.username.cmp(&b.username));
        users
    }

    fn broadcast_presence_if_changed(&self) {
        let users = self.presence_snapshot();
        let encoded = serde_json::to_string(&users).unwrap_or_default();
        {
            let mut last = self.last_presence.lock().expect("presence 锁被毒化");
            if *last == encoded {
                return;
            }
            *last = encoded;
        }
        let _ = self.tx.send(ServerMsg::Presence(users));
    }
}

// ---------------------------------------------------------------- background tasks

pub fn spawn_background_tasks(hub: Arc<Hub>) {
    let flush_hub = hub.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            flush_hub.flush_dirty();
        }
    });

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(PRESENCE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            hub.broadcast_presence_if_changed();
        }
    });
}

// ---------------------------------------------------------------- WebSocket

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
    auth: AuthUser,
) -> Result<Response, AppError> {
    // Reject a cross-site handshake *before* upgrading: once the socket is open the
    // browser has already sent the cookies it holds for this origin.
    check_origin(&headers)?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state, auth.user)))
}

/// Split an `host[:port]` authority into a lowercase host and a port, falling back to
/// `default_port` when the authority carries none.
fn split_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    let authority = authority.trim();
    if authority.is_empty() {
        return None;
    }
    // IPv6 literal, e.g. `[::1]:3198`.
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = match tail.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => default_port,
        };
        return Some((format!("[{}]", host.to_ascii_lowercase()), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            Some((host.to_ascii_lowercase(), port.parse().ok()?))
        }
        _ => Some((authority.to_ascii_lowercase(), default_port)),
    }
}

/// Validate the `Origin` header of a WebSocket handshake against `Host`.
///
/// Browsers always send `Origin`; a missing header is accepted so scripts and the test
/// suite keep working. When it is present, the origin's host and port (with `http`/`https`
/// default ports normalised) must match the `Host` the request was addressed to.
fn check_origin(headers: &HeaderMap) -> Result<(), AppError> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let origin = origin
        .to_str()
        .map_err(|_| AppError::forbidden("forbidden_origin", "Origin 头不是合法的 ASCII"))?
        .trim();
    if origin.is_empty() {
        return Ok(());
    }
    let Some((scheme, authority)) = origin.split_once("://") else {
        return Err(AppError::forbidden(
            "forbidden_origin",
            format!("无法解析的 Origin: {origin}"),
        ));
    };
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "http" | "ws" => 80,
        "https" | "wss" => 443,
        other => {
            return Err(AppError::forbidden(
                "forbidden_origin",
                format!("不支持的 Origin 协议: {other}"),
            ));
        }
    };
    let Some((origin_host, origin_port)) = split_authority(authority, default_port) else {
        return Err(AppError::forbidden(
            "forbidden_origin",
            format!("无法解析的 Origin: {origin}"),
        ));
    };
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return Err(AppError::forbidden(
            "forbidden_origin",
            "缺少 Host 头，无法校验 Origin",
        ));
    };
    let Some((host_name, host_port)) = split_authority(host, default_port) else {
        return Err(AppError::forbidden(
            "forbidden_origin",
            format!("无法解析的 Host: {host}"),
        ));
    };
    if host_name == origin_host && host_port == origin_port {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "forbidden_origin",
            format!("跨站 WebSocket 被拒绝（Origin: {origin}, Host: {host}）"),
        ))
    }
}

#[derive(Debug, Deserialize)]
struct ClientMsg {
    t: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    update: Option<String>,
    #[serde(default)]
    cursor: Option<Cursor>,
    #[serde(default)]
    selection: Option<usize>,
}

async fn handle_socket(socket: WebSocket, state: AppState, user: UserRow) {
    let hub = state.hub.clone();
    let conn = hub.next_conn();
    hub.presence_register(conn, &user);
    hub.broadcast_presence_if_changed();

    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(512);

    let writer = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let mut events = hub.subscribe();
    let mut joined: HashSet<String> = HashSet::new();

    let send = |payload: Value| {
        let text = payload.to_string();
        let tx = out_tx.clone();
        async move {
            let _ = tx.send(Message::Text(text.into())).await;
        }
    };

    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = out_tx.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Binary(_))) => {
                        send(json!({"t":"error","message":"只接受 JSON 文本帧"})).await;
                    }
                    Some(Ok(Message::Text(text))) => {
                        let parsed: ClientMsg = match serde_json::from_str(&text) {
                            Ok(msg) => msg,
                            Err(err) => {
                                send(json!({"t":"error","message":format!("消息格式错误: {err}")})).await;
                                continue;
                            }
                        };
                        if let Err(err) = handle_client_msg(
                            &state, &hub, conn, &user, parsed, &mut joined, &out_tx,
                        ).await {
                            send(json!({"t":"error","message":err})).await;
                        }
                    }
                }
            }
            event = events.recv() => {
                match event {
                    Ok(msg) => {
                        if let Some(payload) = encode_event(&msg, conn, &joined) {
                            if out_tx.send(Message::Text(payload.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "WebSocket 广播积压，丢弃部分事件");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    for path in joined {
        if let Some(room) = hub.room(&path) {
            hub.leave(&room);
        }
    }
    hub.presence_remove(conn);
    hub.broadcast_presence_if_changed();
    drop(out_tx);
    let _ = writer.await;
}

async fn handle_client_msg(
    state: &AppState,
    hub: &Arc<Hub>,
    conn: u64,
    user: &UserRow,
    msg: ClientMsg,
    joined: &mut HashSet<String>,
    out_tx: &mpsc::Sender<Message>,
) -> Result<(), String> {
    let send_text = |value: Value| {
        let tx = out_tx.clone();
        async move {
            let _ = tx.send(Message::Text(value.to_string().into())).await;
        }
    };

    match msg.t.as_str() {
        "join" => {
            let raw_path = msg.path.unwrap_or_default();
            let path = files::normalize_rel(&raw_path);
            if hub.is_locked(&path) {
                return Err("file_busy: 该文件正在被重命名或删除，请稍后重试".into());
            }
            let room = hub
                .ensure_room(&path)
                .map_err(|err| format!("无法打开 {}: {}", path, err))?;
            if joined.insert(path.clone()) {
                hub.join(&room);
            }
            // Send the full document state.
            let state_update = room
                .doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            send_text(json!({
                "t": "init",
                "path": path,
                "update": B64.encode(state_update),
                "peers": room.members.load(Ordering::Relaxed),
            }))
            .await;
            tracing::debug!(user = %user.username, path = %path, "加入协作房间");
        }
        "leave" => {
            let path = files::normalize_rel(msg.path.as_deref().unwrap_or(""));
            if joined.remove(&path) {
                if let Some(room) = hub.room(&path) {
                    hub.leave(&room);
                }
            }
        }
        "update" => {
            let path = files::normalize_rel(msg.path.as_deref().unwrap_or(""));
            let Some(update_b64) = msg.update else {
                return Err("update 帧缺少 update 字段".into());
            };
            if !joined.contains(&path) {
                return Err("尚未加入该文档房间".into());
            }
            let room = hub
                .room(&path)
                .ok_or_else(|| format!("文档房间不存在: {path}"))?;
            let bytes = B64
                .decode(&update_b64)
                .map_err(|err| format!("base64 解码失败: {err}"))?;
            hub.apply_update(&room, &bytes)
                .map_err(|err| format!("应用更新失败: {err:#}"))?;
            let _ = hub.tx.send(ServerMsg::Update {
                path,
                update: bytes,
                from_conn: conn,
                from_user: user.username.clone(),
            });
        }
        "awareness" => {
            let path = files::normalize_rel(msg.path.as_deref().unwrap_or(""));
            let Some(update_b64) = msg.update else {
                return Err("awareness 帧缺少 update 字段".into());
            };
            if !joined.contains(&path) {
                return Ok(());
            }
            let bytes = B64
                .decode(&update_b64)
                .map_err(|err| format!("base64 解码失败: {err}"))?;
            let _ = hub.tx.send(ServerMsg::Awareness {
                path,
                update: bytes,
                from_conn: conn,
            });
        }
        "presence" => {
            let path = msg
                .path
                .map(|value| files::normalize_rel(&value))
                .filter(|value| !value.is_empty());
            hub.presence_update(conn, path, msg.cursor, msg.selection.unwrap_or(0));
            hub.broadcast_presence_if_changed();
        }
        "ping" => {
            send_text(json!({ "t": "pong" })).await;
        }
        other => {
            tracing::debug!(kind = other, "忽略未知客户端消息");
        }
    }
    let _ = state;
    Ok(())
}

fn encode_event(msg: &ServerMsg, self_conn: u64, joined: &HashSet<String>) -> Option<String> {
    match msg {
        ServerMsg::Presence(users) => Some(json!({ "t": "presence", "users": users }).to_string()),
        ServerMsg::Update {
            path,
            update,
            from_conn,
            from_user,
        } => {
            if !joined.contains(path) || *from_conn == self_conn {
                return None;
            }
            Some(
                json!({
                    "t": "update",
                    "path": path,
                    "update": B64.encode(update),
                    "user": from_user,
                })
                .to_string(),
            )
        }
        ServerMsg::Awareness {
            path,
            update,
            from_conn,
        } => {
            if !joined.contains(path) || *from_conn == self_conn {
                return None;
            }
            Some(
                json!({
                    "t": "awareness",
                    "path": path,
                    "update": B64.encode(update),
                })
                .to_string(),
            )
        }
        ServerMsg::Peers { path, count } => {
            if !joined.contains(path) {
                return None;
            }
            Some(json!({ "t": "peers", "path": path, "count": count }).to_string())
        }
        ServerMsg::Saved { path, ts } => {
            if !joined.contains(path) {
                return None;
            }
            Some(json!({ "t": "saved", "path": path, "ts": ts }).to_string())
        }
    }
}

/// * Test use.
#[allow(dead_code)]
pub fn room_text(room: &Room) -> String {
    room.content()
}

#[allow(dead_code)]
fn _assert_path(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn handshake(origin: Option<&str>, host: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        if let Some(host) = host {
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        }
        headers
    }

    #[test]
    fn origin_absent_is_allowed() {
        // 脚本 / 测试客户端不带 Origin，必须放行。
        assert!(check_origin(&handshake(None, Some("127.0.0.1:3198"))).is_ok());
        assert!(check_origin(&handshake(None, None)).is_ok());
    }

    #[test]
    fn origin_matching_host_is_allowed() {
        for (origin, host) in [
            ("http://127.0.0.1:3198", "127.0.0.1:3198"),
            ("https://example.com", "example.com"),
            ("https://example.com:443", "example.com"),
            ("http://example.com", "example.com:80"),
            ("http://[::1]:3198", "[::1]:3198"),
            ("http://Example.COM:3198", "example.com:3198"),
        ] {
            assert!(
                check_origin(&handshake(Some(origin), Some(host))).is_ok(),
                "{origin} vs {host} 应当通过"
            );
        }
    }

    #[test]
    fn origin_mismatch_is_rejected() {
        for (origin, host) in [
            ("https://evil.example", "md.example"),
            ("http://127.0.0.1:3000", "127.0.0.1:3198"),
            ("https://example.com", "example.com:3000"),
            ("null", "example.com"),
            ("http://example.com:8080", "example.com"),
        ] {
            let err = check_origin(&handshake(Some(origin), Some(host)))
                .expect_err("跨站 Origin 必须被拒绝");
            assert!(
                format!("{err:?}").contains("forbidden_origin"),
                "{origin} vs {host} 的错误码应为 forbidden_origin"
            );
        }
        // Host 缺失时不能证明同源，同样拒绝。
        assert!(check_origin(&handshake(Some("http://example.com"), None)).is_err());
    }

    #[test]
    fn split_authority_normalises_ports() {
        assert_eq!(
            split_authority("example.com", 443),
            Some(("example.com".to_string(), 443))
        );
        assert_eq!(
            split_authority("example.com:8080", 443),
            Some(("example.com".to_string(), 8080))
        );
        assert_eq!(
            split_authority("[::1]", 80),
            Some(("[::1]".to_string(), 80))
        );
        assert_eq!(split_authority("", 80), None);
    }
}
