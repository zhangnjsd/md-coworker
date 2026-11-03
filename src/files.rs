//! Workspace filesystem: safe path resolution, directory tree and CRUD.
//!
//! Every path crossing the API is a POSIX path relative to the workspace root and must
//! consist of "normal" components only: absolute paths, `..`, empty segments and hidden
//! (`.`-prefixed) components are rejected. After joining, the real location of the path
//! (symbolic links resolved) is checked against the workspace, so links cannot escape it.

use crate::{
    auth::AuthUser,
    error::{ApiResult, AppError},
    models::AppState,
};
use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

/// Directory names the tree never descends into. Hidden names (`.git`, `.idea`,
/// `.vscode`, ...) are already rejected by `is_hidden`.
const SKIP_DIRS: [&str; 2] = ["node_modules", "target"];

/// Largest file `/api/file` and `/api/raw` will hand to a browser, in bytes.
pub const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;

/// How many directory levels `build_tree` descends (protects against link loops).
const MAX_TREE_DEPTH: usize = 12;
/// How many entries `build_tree` collects before it stops walking.
const MAX_TREE_ENTRIES: usize = 5000;

// ---------------------------------------------------------------- paths

/// A fresh temporary file inside `dir`, kept out of the served workspace so an
/// interrupted write can never show up in the file tree.
pub fn create_temp(dir: &Path) -> Result<(std::fs::File, PathBuf)> {
    std::fs::create_dir_all(dir).with_context(|| format!("创建临时目录失败: {}", dir.display()))?;
    let path = dir.join(format!(".mc-tmp-{}", uuid::Uuid::new_v4()));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| format!("创建临时文件失败: {}", path.display()))?;
    Ok((file, path))
}

/// Flush a directory entry so a completed rename survives a power loss. Directories
/// cannot be opened for writing everywhere, so a failure here is not fatal.
pub fn fsync_dir(dir: &Path) {
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(unix)]
const CROSS_DEVICE: i32 = 18; // EXDEV
#[cfg(windows)]
const CROSS_DEVICE: i32 = 17; // ERROR_NOT_SAME_DEVICE
#[cfg(not(any(unix, windows)))]
const CROSS_DEVICE: i32 = -1;

/// Move `tmp` onto `target` and make the replacement durable.
///
/// `tmp` normally lives in the data directory, which may be a different filesystem than
/// the workspace; in that case the bytes are copied to a sibling temp file first and the
/// rename happens within the target directory.
pub fn commit_temp(tmp: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建父目录失败: {}", parent.display()))?;
    }
    match std::fs::rename(tmp, target) {
        Ok(()) => {}
        Err(err) if err.raw_os_error() == Some(CROSS_DEVICE) => {
            let sibling = target.with_file_name(format!(".mc-tmp-{}", uuid::Uuid::new_v4()));
            std::fs::copy(tmp, &sibling)
                .with_context(|| format!("跨文件系统复制失败: {}", sibling.display()))?;
            if let Ok(handle) = std::fs::File::open(&sibling) {
                let _ = handle.sync_all();
            }
            std::fs::rename(&sibling, target)
                .with_context(|| format!("替换文件失败: {}", target.display()))?;
            let _ = std::fs::remove_file(tmp);
        }
        Err(err) => {
            let _ = std::fs::remove_file(tmp);
            return Err(err).with_context(|| format!("替换文件失败: {}", target.display()));
        }
    }
    if let Some(parent) = target.parent() {
        fsync_dir(parent);
    }
    Ok(())
}

/// Write `bytes` to `target` atomically and durably: temp file, `sync_all`, rename, then
/// an fsync of the parent directory.
pub fn write_atomic(target: &Path, bytes: &[u8], tmp_dir: &Path) -> Result<()> {
    use std::io::Write;

    let (mut file, tmp) = create_temp(tmp_dir)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .with_context(|| format!("写入临时文件失败: {}", tmp.display()));
    drop(file);
    if let Err(err) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    commit_temp(&tmp, target)
}

/// Resolve a relative path into an absolute path inside the workspace.
///
/// Rejects hidden paths (any component starting with `.`), then verifies that the joined
/// path — with symbolic links resolved — is still inside the workspace.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    if rel.contains('\0') {
        return Err(AppError::bad_request("bad_path", "路径包含非法字符"));
    }
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err(AppError::bad_request("bad_path", "必须是相对工作区的路径"));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(name) => {
                if name.to_string_lossy().starts_with('.') {
                    return Err(AppError::bad_request(
                        "bad_path",
                        format!("隐藏路径不可访问: {rel}"),
                    ));
                }
            }
            _ => {
                return Err(AppError::bad_request(
                    "bad_path",
                    "路径不能包含上级目录或根组件",
                ));
            }
        }
    }
    let joined = root.join(candidate);
    ensure_within(root, &joined, rel)?;
    Ok(joined)
}

/// Reject a joined path whose real location leaves the workspace.
///
/// A target that does not exist yet (a file or directory about to be created, the
/// destination of a rename) is resolved through its nearest existing ancestor with the
/// missing tail re-appended, so creation keeps working while every existing symlink is
/// still followed.
fn ensure_within(root: &Path, joined: &Path, rel: &str) -> Result<(), AppError> {
    let root_real = canonicalize_lenient(root)
        .map_err(|err| AppError::internal(anyhow::Error::new(err).context("工作区目录不可访问")))?;
    let real = canonicalize_lenient(joined).map_err(|err| {
        AppError::internal(anyhow::Error::new(err).context("解析文件真实路径失败"))
    })?;
    if real.starts_with(&root_real) {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "bad_path",
            format!("路径超出了工作区范围: {rel}"),
        ))
    }
}

/// Best-effort `canonicalize`: when `path` itself does not exist, canonicalize its
/// nearest existing ancestor and re-append the missing tail.
///
/// This is what keeps "resolve a path that is about to be created" possible without
/// giving up symlink resolution for the part of the path that does exist.
pub fn canonicalize_lenient(path: &Path) -> std::io::Result<PathBuf> {
    if let Ok(real) = path.canonicalize() {
        return Ok(real);
    }
    let mut tail: Vec<OsString> = Vec::new();
    let mut cursor = path;
    while let Some(parent) = cursor.parent() {
        let Some(name) = cursor.file_name() else {
            break;
        };
        tail.push(name.to_os_string());
        if let Ok(mut real) = parent.canonicalize() {
            for part in tail.iter().rev() {
                real.push(part);
            }
            return Ok(real);
        }
        cursor = parent;
    }
    path.canonicalize()
}

/// Normalize into a canonical POSIX relative path.
///
/// Leading `./` and `/`, repeated separators, trailing separators and `.` segments are
/// dropped, so `./a//b/` and `a/b` are the same file — and therefore the same room key.
/// `..` is preserved on purpose: `resolve` rejects it, and silently rewriting it here
/// would hide a malformed request.
pub fn normalize_rel(rel: &str) -> String {
    rel.trim()
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

// ---------------------------------------------------------------- tree

#[derive(Debug, Serialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Node>>,
}

/// How much of the tree one `build_tree` call is still allowed to collect.
#[derive(Default)]
struct TreeBudget {
    entries: usize,
    truncated: bool,
}

impl TreeBudget {
    /// Mark the tree as truncated, warning once about the limit that was hit.
    fn truncate(&mut self, dir: &Path, limit: String) {
        if !self.truncated {
            tracing::warn!(
                dir = %dir.display(),
                entries = self.entries,
                limit,
                "文件树遍历超过上限，已截断"
            );
        }
        self.truncated = true;
    }
}

pub fn build_tree(dir: &Path, prefix: &str) -> Result<Vec<Node>, AppError> {
    let mut budget = TreeBudget::default();
    walk_tree(dir, prefix, 0, &mut budget)
}

fn walk_tree(
    dir: &Path,
    prefix: &str,
    depth: usize,
    budget: &mut TreeBudget,
) -> Result<Vec<Node>, AppError> {
    if depth >= MAX_TREE_DEPTH {
        budget.truncate(dir, format!("depth={MAX_TREE_DEPTH}"));
        return Ok(Vec::new());
    }

    let read = std::fs::read_dir(dir)
        .with_context(|| format!("读取目录失败: {}", dir.display()))
        .map_err(AppError::from)?;

    let mut entries: Vec<(PathBuf, std::fs::Metadata)> = Vec::new();
    for entry in read {
        if budget.entries >= MAX_TREE_ENTRIES {
            budget.truncate(dir, format!("entries={MAX_TREE_ENTRIES}"));
            break;
        }
        let entry = entry.context("读取目录项失败").map_err(AppError::from)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }
        let path = entry.path();
        // `symlink_metadata` does not follow links: anything that is a link is skipped
        // instead of being traversed out of the workspace (or into an endless loop).
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        budget.entries += 1;
        entries.push((path, meta));
    }

    entries.sort_by(|a, b| {
        let a_dir = a.1.is_dir();
        let b_dir = b.1.is_dir();
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.0.file_name().cmp(&b.0.file_name()))
    });

    let mut nodes = Vec::with_capacity(entries.len());
    for (path, meta) in entries {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if meta.is_dir() {
            let children = walk_tree(&path, &rel, depth + 1, budget).unwrap_or_default();
            nodes.push(Node {
                name,
                path: rel,
                kind: "dir",
                size: 0,
                mtime: mtime_ms(&meta),
                children: Some(children),
            });
        } else {
            nodes.push(Node {
                name,
                path: rel,
                kind: "file",
                size: meta.len(),
                mtime: mtime_ms(&meta),
                children: None,
            });
        }
    }
    Ok(nodes)
}

// ---------------------------------------------------------------- language detection

/// Editor language for a workspace path. Unknown / missing extensions fall back to
/// `plaintext` (not `text`) so callers can use this honestly as "is this a language I
/// know?" — see `upload::kind_for`.
pub fn language_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" | "mdx" => "markdown",
        "rs" => "rust",
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" => "typescript",
        "jsx" => "javascript",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "py" => "python",
        "sh" | "bash" => "shell",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "php" => "php",
        "rb" => "ruby",
        "sql" => "sql",
        "xml" => "xml",
        "dockerfile" => "dockerfile",
        "txt" | "log" => "plaintext",
        _ => "plaintext",
    }
}

// ---------------------------------------------------------------- handlers

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: Option<String>,
}

pub async fn list_files(State(state): State<AppState>, _auth: AuthUser) -> ApiResult<Json<Value>> {
    let root = state.cfg.workspace.clone();
    // Walking the tree is blocking I/O over up to `MAX_TREE_ENTRIES` entries; running it
    // on the runtime's worker threads would stall every other request.
    let tree = tokio::task::spawn_blocking(move || build_tree(&root, ""))
        .await
        .context("文件树任务失败")
        .map_err(AppError::from)??;
    Ok(Json(json!({ "tree": tree })))
}

pub async fn read_file(
    State(state): State<AppState>,
    _auth: AuthUser,
    Query(query): Query<FileQuery>,
) -> ApiResult<Json<Value>> {
    let rel = normalize_rel(query.path.as_deref().unwrap_or(""));
    if rel.is_empty() {
        return Err(AppError::bad_request("bad_path", "缺少 path 参数"));
    }
    let abs = resolve(&state.cfg.workspace, &rel)?;
    let meta = std::fs::metadata(&abs)
        .with_context(|| format!("文件不存在: {rel}"))
        .map_err(|_| AppError::not_found("file_not_found", format!("文件不存在: {rel}")))?;
    if !meta.is_file() {
        return Err(AppError::bad_request("not_a_file", "目标不是文件"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(AppError::too_large(
            "too_large",
            "文件超过 100 MiB，无法在浏览器中读取",
        ));
    }
    let raw = std::fs::read(&abs)
        .with_context(|| format!("读取文件失败: {rel}"))
        .map_err(AppError::from)?;
    let content = String::from_utf8(raw).map_err(|_| {
        AppError::new(
            axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media",
            "只支持 UTF-8 文本文件",
        )
    })?;
    Ok(Json(json!({
        "path": rel,
        "content": content,
        "size": meta.len(),
        "lang": language_for(&rel),
        "mtime": mtime_ms(&meta),
    })))
}

#[derive(Deserialize)]
pub struct CreateReq {
    path: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

pub async fn create_entry(
    State(state): State<AppState>,
    _auth: AuthUser,
    Json(req): Json<CreateReq>,
) -> ApiResult<Json<Value>> {
    let rel = normalize_rel(&req.path);
    if rel.is_empty() {
        return Err(AppError::bad_request("bad_path", "缺少 path"));
    }
    let abs = resolve(&state.cfg.workspace, &rel)?;
    if abs.exists() {
        return Err(AppError::conflict("file_exists", "同名文件或目录已存在"));
    }
    let kind = req.kind.as_deref().unwrap_or("file");
    match kind {
        "dir" => {
            std::fs::create_dir_all(&abs)
                .with_context(|| format!("创建目录失败: {rel}"))
                .map_err(AppError::from)?;
        }
        "file" => {
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("创建父目录失败: {}", parent.display()))
                    .map_err(AppError::from)?;
            }
            let content = req.content.unwrap_or_default();
            std::fs::write(&abs, content)
                .with_context(|| format!("创建文件失败: {rel}"))
                .map_err(AppError::from)?;
        }
        other => {
            return Err(AppError::bad_request(
                "bad_request",
                format!("kind 只能是 file 或 dir: {other}"),
            ));
        }
    }
    Ok(Json(json!({ "path": rel })))
}

#[derive(Deserialize)]
pub struct RenameReq {
    from: String,
    to: String,
}

pub async fn rename_entry(
    State(state): State<AppState>,
    _auth: AuthUser,
    Json(req): Json<RenameReq>,
) -> ApiResult<Json<Value>> {
    let from = normalize_rel(&req.from);
    let to = normalize_rel(&req.to);
    if from.is_empty() || to.is_empty() {
        return Err(AppError::bad_request("bad_path", "from/to 不能为空"));
    }
    // Take the write locks first: for as long as they are held, `join`, `ensure_room`
    // and uploads refuse these paths with 409, which closes the TOCTOU window between
    // the "is anybody editing?" check and the rename below.
    let _from_lock = state.hub.lock_path(&from);
    let _to_lock = state.hub.lock_path(&to);
    if state.hub.active_under(&from) || state.hub.active_under(&to) {
        return Err(AppError::conflict(
            "file_busy",
            "该文件正在被协作编辑，请等待所有人离开后再重命名",
        ));
    }
    let abs_from = resolve(&state.cfg.workspace, &from)?;
    let abs_to = resolve(&state.cfg.workspace, &to)?;
    if !abs_from.exists() {
        return Err(AppError::not_found("file_not_found", "源文件不存在"));
    }
    if abs_to.exists() {
        return Err(AppError::conflict("file_exists", "目标路径已存在"));
    }
    // A directory cannot be moved into itself or into one of its own children:
    // `rename` would fail on the second case, and both are meaningless moves.
    if to == from || to.starts_with(&format!("{from}/")) {
        return Err(AppError::bad_request(
            "bad_path",
            "不能把目录移动到它自己或它的子目录里",
        ));
    }
    if let Some(parent) = abs_to.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建父目录失败: {}", parent.display()))
            .map_err(AppError::from)?;
    }
    std::fs::rename(&abs_from, &abs_to)
        .with_context(|| format!("重命名失败: {from} -> {to}"))
        .map_err(AppError::from)?;
    // Both sides lose their snapshots: the source path no longer exists, and a snapshot
    // left behind at the destination would be resurrected by the next join.
    state.hub.forget_snapshot_tree(&from);
    state.hub.forget_snapshot_tree(&to);
    Ok(Json(json!({ "path": to })))
}

#[derive(Deserialize)]
pub struct DeleteReq {
    path: String,
}

pub async fn delete_entry(
    State(state): State<AppState>,
    _auth: AuthUser,
    Json(req): Json<DeleteReq>,
) -> ApiResult<Json<Value>> {
    let rel = normalize_rel(&req.path);
    if rel.is_empty() {
        return Err(AppError::bad_request("bad_path", "缺少 path"));
    }
    // Hold the write lock across the "nobody is editing?" check and the removal, so a
    // connection cannot join the room between the two (TOCTOU).
    let _lock = state.hub.lock_path(&rel);
    if state.hub.active_under(&rel) {
        return Err(AppError::conflict(
            "file_busy",
            "该文件正在被协作编辑，请等待所有人离开后再删除",
        ));
    }
    let abs = resolve(&state.cfg.workspace, &rel)?;
    let meta = std::fs::symlink_metadata(&abs)
        .with_context(|| format!("文件不存在: {rel}"))
        .map_err(|_| AppError::not_found("file_not_found", "文件不存在"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&abs)
            .with_context(|| format!("删除目录失败: {rel}"))
            .map_err(AppError::from)?;
    } else {
        std::fs::remove_file(&abs)
            .with_context(|| format!("删除文件失败: {rel}"))
            .map_err(AppError::from)?;
    }
    state.hub.forget_snapshot_tree(&rel);
    Ok(Json(json!({ "ok": true })))
}

/// Read a file as text; the collaboration layer uses it to seed a CRDT document.
///
/// Binary files are rejected with `415 unsupported_media` rather than a bare 500, so the
/// browser can explain that an image or an archive has no text to collaborate on.
pub fn read_text_lossy(abs: &Path, rel: &str) -> Result<String, AppError> {
    let len = std::fs::metadata(abs)
        .with_context(|| format!("读取文件失败: {}", abs.display()))
        .map_err(AppError::from)?
        .len();
    if len > MAX_READ_BYTES {
        return Err(AppError::too_large(
            "too_large",
            format!(
                "{rel} 超过 {} MiB，无法协作编辑",
                MAX_READ_BYTES / (1024 * 1024)
            ),
        ));
    }
    let raw = std::fs::read(abs).with_context(|| format!("读取文件失败: {}", abs.display()))?;
    String::from_utf8(raw).map_err(|_| {
        AppError::new(
            axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media",
            format!("{rel} 不是 UTF-8 文本文件"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-files-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("创建测试工作区");
        dir
    }

    fn error_code(err: &AppError) -> String {
        let debug = format!("{err:?}");
        debug
            .split("code: \"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn resolve_rejects_hidden_components() {
        let root = temp_workspace("hidden");
        // Note: `data/master.key` has no dot-prefixed component; the "data lives outside
        // the workspace" rule is what protects it.
        for rel in [".env", ".git/config", "notes/.secret", "a/.hidden/b.txt"] {
            let err = resolve(&root, rel).expect_err("隐藏路径应被拒绝");
            assert_eq!(error_code(&err), "bad_path", "{rel}");
            assert!(
                format!("{err:?}").contains("隐藏路径不可访问"),
                "{rel} 的错误信息应说明隐藏路径不可访问"
            );
        }
        assert!(resolve(&root, "notes/a.md").is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_allows_targets_that_do_not_exist_yet() {
        let root = temp_workspace("create");
        // Creating files/directories and rename targets must still resolve before they exist.
        let target = resolve(&root, "notes/sub/deep.md").expect("不存在的目标应可解析");
        assert_eq!(target, root.join("notes/sub/deep.md"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        let root = temp_workspace("escape");
        let outside = temp_workspace("outside");
        std::fs::write(outside.join("secret.txt"), b"top secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let err = resolve(&root, "link/secret.txt").expect_err("符号链接不能逃出工作区");
        assert_eq!(error_code(&err), "bad_path");
        assert!(resolve(&root, "link").is_err(), "链接本身也不可作为目标");

        let _ = std::fs::remove_file(root.join("link"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn language_for_unknown_extension_is_plaintext() {
        assert_eq!(language_for("notes/a.md"), "markdown");
        assert_eq!(language_for("src/main.rs"), "rust");
        assert_eq!(language_for("data.unknownext"), "plaintext");
        assert_eq!(language_for("Makefile"), "plaintext");
    }
}
