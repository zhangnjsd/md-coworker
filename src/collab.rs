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
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{broadcast, mpsc};
use yrs::{
    Doc, GetString, ReadTxn, StateVector, Text, TextRef, Transact, Update, updates::decoder::Decode,
};

const ROOT_TEXT: &str = "content";
const FLUSH_INTERVAL: Duration = Duration::from_millis(400);
const PRESENCE_INTERVAL: Duration = Duration::from_millis(1000);
const PRESENCE_TTL_MS: i64 = 30_000;

// ---------------------------------------------------------------- 数据

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

/// 广播事件。
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

impl ServerMsg {
    fn path(&self) -> Option<&str> {
        match self {
            ServerMsg::Update { path, .. }
            | ServerMsg::Awareness { path, .. }
            | ServerMsg::Peers { path, .. }
            | ServerMsg::Saved { path, .. } => Some(path),
            ServerMsg::Presence(_) => None,
        }
    }
}

/// 一个协作文件房间。
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
    tx: broadcast::Sender<ServerMsg>,
    conn_seq: AtomicU64,
    last_presence: Mutex<String>,
}

impl Hub {
    pub fn new(cfg: Arc<Config>, cipher: Arc<Cipher>) -> Self {
        let (tx, _rx) = broadcast::channel(1024);
        Self {
            cfg,
            cipher,
            rooms: Mutex::new(HashMap::new()),
            agents: Mutex::new(HashMap::new()),
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

    // ------------------------------------------------------------ 房间

    /// 取得（必要时创建并加载）文档房间。
    pub fn ensure_room(&self, path: &str) -> Result<Arc<Room>, AppError> {
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

        // 只有当快照不比磁盘上的文件旧时才使用它：确保外部修改（API 写入、git checkout、
        // 手工编辑器保存）不会被过期的 CRDT 快照覆盖。
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

    pub fn join(&self, room: &Arc<Room>) -> usize {
        let count = room.members.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.tx.send(ServerMsg::Peers {
            path: room.path.clone(),
            count,
        });
        count
    }

    pub fn leave(&self, room: &Arc<Room>) -> usize {
        let previous = room.members.load(Ordering::Relaxed);
        let count = if previous == 0 { 0 } else { previous - 1 };
        room.members.store(count, Ordering::Relaxed);
        let _ = self.tx.send(ServerMsg::Peers {
            path: room.path.clone(),
            count,
        });
        if count == 0 {
            if let Err(err) = self.flush_room(room) {
                tracing::warn!(path = %room.path, error = %err, "离开房间时落盘失败");
            }
            self.recycle_room(room);
        }
        count
    }

    /// 房间里没有人时把文档从内存中回收（磁盘快照已保存，下次进入会重新加载）。
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

    /// 应用一条 Yjs 更新；返回是否成功。
    pub fn apply_update(&self, room: &Arc<Room>, update_bytes: &[u8]) -> Result<()> {
        let update = Update::decode_v1(update_bytes).context("非法的 Yjs 更新二进制")?;
        room.doc
            .transact_mut()
            .apply_update(update)
            .context("应用 Yjs 更新失败")?;
        room.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// 立即把房间文本写回磁盘并保存加密快照。
    pub fn flush_room(&self, room: &Arc<Room>) -> Result<()> {
        if !room.dirty.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        let content = room.content();

        if let Some(parent) = room.file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建父目录失败: {}", parent.display()))?;
        }
        // 先写临时文件再 rename，避免半截内容被其它工具读到。
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
                    tracing::warn!(path = %room.path, error = %err, "定时落盘失败");
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
                tracing::warn!(path = %room.path, error = %err, "退出前落盘失败");
            }
        }
    }

    /// 删除文件/重命名后清理旧快照。
    pub fn forget_snapshot(&self, path: &str) {
        let snapshot = self.snapshot_path(path);
        if snapshot.exists() {
            let _ = std::fs::remove_file(snapshot);
        }
        self.rooms.lock().expect("rooms 锁被毒化").remove(path);
    }

    // ------------------------------------------------------------ 在线状态

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

    pub fn presence_clear_path(&self, conn: u64) {
        let mut agents = self.agents.lock().expect("agents 锁被毒化");
        if let Some(agent) = agents.get_mut(&conn) {
            agent.path = None;
            agent.cursor = None;
            agent.selection = 0;
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
        // 同一用户可能开了多个标签页：取最近活跃的那条
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

// ---------------------------------------------------------------- 后台任务

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
    auth: AuthUser,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state, auth.user))
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
            let room = hub
                .ensure_room(&path)
                .map_err(|err| format!("无法打开 {}: {}", path, err))?;
            if joined.insert(path.clone()) {
                hub.join(&room);
            }
            // 下发完整状态
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

/// 未使用但保留：把文档内容导出为纯文本（调试/测试用）。
pub fn room_text(room: &Room) -> String {
    room.content()
}

#[allow(dead_code)]
fn _assert_path(_: &Path) {}
