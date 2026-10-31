//! Workspace filesystem: safe path resolution, directory tree and CRUD.
//!
//! Every path crossing the API is a POSIX path relative to the workspace root and must
//! consist of "normal" components only: absolute paths, `..` and empty segments are
//! rejected, so nothing can escape the workspace.

use crate::{
    auth::AuthUser,
    error::{ApiResult, AppError},
    models::AppState,
};
use anyhow::{Context, Result, anyhow};
use axum::{
    Json,
    extract::{Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

const SKIP_DIRS: [&str; 5] = [".git", "node_modules", "target", ".idea", ".vscode"];

// ---------------------------------------------------------------- paths

/// Resolve a relative path into an absolute path inside the workspace.
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
            Component::Normal(_) => {}
            _ => {
                return Err(AppError::bad_request(
                    "bad_path",
                    "路径不能包含上级目录或根组件",
                ));
            }
        }
    }
    Ok(root.join(candidate))
}

/// Normalize into a POSIX relative path (strips leading `./` and `/`).
pub fn normalize_rel(rel: &str) -> String {
    let trimmed = rel.trim().trim_start_matches("./").trim_start_matches('/');
    trimmed.to_string()
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

pub fn build_tree(_root: &Path, dir: &Path, prefix: &str) -> Result<Vec<Node>, AppError> {
    let mut entries: Vec<(PathBuf, std::fs::Metadata)> = Vec::new();
    let read = std::fs::read_dir(dir)
        .with_context(|| format!("读取目录失败: {}", dir.display()))
        .map_err(AppError::from)?;
    for entry in read {
        let entry = entry.context("读取目录项失败").map_err(AppError::from)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        entries.push((entry.path(), meta));
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
            let children = build_tree(_root, &path, &rel).unwrap_or_default();
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
        "txt" | "log" => "text",
        _ => "text",
    }
}

// ---------------------------------------------------------------- handlers

#[derive(Deserialize)]
pub struct FileQuery {
    path: Option<String>,
}

pub async fn list_files(State(state): State<AppState>, _auth: AuthUser) -> ApiResult<Json<Value>> {
    let root = state.cfg.workspace.clone();
    let tree = build_tree(&root, &root, "")?;
    Ok(Json(json!({
        "root": root.display().to_string(),
        "tree": tree,
    })))
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
    if state.hub.is_active(&from) {
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
    if let Some(parent) = abs_to.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建父目录失败: {}", parent.display()))
            .map_err(AppError::from)?;
    }
    std::fs::rename(&abs_from, &abs_to)
        .with_context(|| format!("重命名失败: {from} -> {to}"))
        .map_err(AppError::from)?;
    state.hub.forget_snapshot(&from);
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
    if state.hub.is_active(&rel) {
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
    state.hub.forget_snapshot(&rel);
    Ok(Json(json!({ "ok": true })))
}

/// Read a file as text; the collaboration layer uses it to seed a CRDT document.
pub fn read_text_lossy(abs: &Path) -> Result<String> {
    let raw = std::fs::read(abs).with_context(|| format!("读取文件失败: {}", abs.display()))?;
    let text = String::from_utf8(raw).map_err(|_| anyhow!("文件不是合法的 UTF-8 文本"))?;
    Ok(text)
}
