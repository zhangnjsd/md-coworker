//! Binary file uploads and raw downloads.
//!
//! `POST /api/files/upload` streams each part straight to a temporary file next to
//! its target, aborts as soon as the configured limit is exceeded, and only then
//! renames it into place — a rejected upload never leaves a half-written file
//! behind. `GET /api/raw` serves the bytes back so the Markdown preview can show
//! uploaded images.

use crate::{
    auth::AuthUser,
    error::{ApiResult, AppError},
    files::{mtime_ms, normalize_rel, resolve},
    models::AppState,
    settings,
};
use anyhow::Context;
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// Percent-encode a query value the way `encodeURIComponent` does: `-._~!*'()`
/// and alphanumerics stay readable, everything else (including `/`) is escaped.
const QUERY_VALUE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// Refuse absurd batches before touching the disk.
const MAX_FILES_PER_REQUEST: usize = 20;
const MAX_FILENAME_BYTES: usize = 200;

// ---------------------------------------------------------------- content types

/// Extension → MIME. Deliberately a short table: we only need to get images, PDFs
/// and plain text right, everything else is served as an opaque download.
fn mime_for(path: &str) -> Option<&'static str> {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" | "markdown" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "zip" => "application/zip",
        _ => return None,
    };
    Some(mime)
}

/// Extensions the editor opens as text even though nobody assigns them a MIME type.
///
/// `mime_for` stays deliberately short, so the "is this text?" decision lives here where
/// the upload list needs it, instead of piggy-backing on `files::language_for`.
fn is_text_ext(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "txt"
            | "log"
            | "md"
            | "markdown"
            | "mdx"
            | "csv"
            | "tsv"
            | "json"
            | "jsonc"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "rs"
            | "py"
            | "js"
            | "mjs"
            | "cjs"
            | "ts"
            | "tsx"
            | "jsx"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "hpp"
            | "go"
            | "java"
            | "kt"
            | "rb"
            | "php"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "sql"
            | "html"
            | "htm"
            | "css"
            | "scss"
            | "xml"
    )
}

/// What the upload list calls this file, so the UI can pick an icon.
fn kind_for(path: &str, mime: Option<&str>) -> &'static str {
    match mime {
        Some(mime) if mime.starts_with("image/") => "image",
        Some(mime) if mime.starts_with("text/") || mime.starts_with("application/json") => "text",
        // Source code and config files have no MIME type of their own; fall back to the
        // extension rather than to a language table.
        _ => {
            if is_text_ext(path) {
                "text"
            } else {
                "other"
            }
        }
    }
}

/// Last-resort sniff for files without a helpful extension.
fn sniff_mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if head.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if head.len() > 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if head.starts_with(b"%PDF") {
        return Some("application/pdf");
    }
    None
}

// ---------------------------------------------------------------- upload

#[derive(Deserialize)]
pub struct UploadQuery {
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    overwrite: Option<String>,
}

fn wants_overwrite(raw: Option<&str>) -> bool {
    matches!(raw, Some("1") | Some("true") | Some("yes"))
}

/// Keep only the last path segment of a client-supplied filename and reject
/// anything that could escape the chosen directory or hide the file from the tree.
fn sanitize_filename(raw: &str) -> Result<String, AppError> {
    let name = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() || name == "." || name == ".." {
        return Err(AppError::bad_request("bad_filename", "文件名不能为空"));
    }
    if name.starts_with('.') {
        return Err(AppError::bad_request("bad_filename", "文件名不能以 . 开头"));
    }
    if name.contains('\0') || name.contains('/') || name.contains('\\') {
        return Err(AppError::bad_request("bad_filename", "文件名包含非法字符"));
    }
    if name.len() > MAX_FILENAME_BYTES {
        return Err(AppError::bad_request(
            "bad_filename",
            format!("文件名过长（上限 {MAX_FILENAME_BYTES} 字节）"),
        ));
    }
    Ok(name)
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn raw_url(rel: &str) -> String {
    let encoded = utf8_percent_encode(rel, QUERY_VALUE).to_string();
    format!("/api/raw?path={encoded}")
}

struct Saved {
    path: String,
    size: i64,
    kind: &'static str,
}

pub async fn upload(
    State(state): State<AppState>,
    _auth: AuthUser,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> ApiResult<Response> {
    let dir = normalize_rel(query.dir.as_deref().unwrap_or(""));
    let overwrite = wants_overwrite(query.overwrite.as_deref());
    let limit = settings::max_upload_bytes(&state).await;

    let dir_abs = resolve(&state.cfg.workspace, &dir)?;
    if dir_abs.exists() && !dir_abs.is_dir() {
        return Err(AppError::bad_request(
            "bad_path",
            format!("{dir} 不是目录，无法作为上传目标"),
        ));
    }
    std::fs::create_dir_all(&dir_abs)
        .with_context(|| format!("创建目录失败: {}", dir_abs.display()))
        .map_err(AppError::from)?;

    let mut saved: Vec<Saved> = Vec::new();
    let mut seen = 0usize;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| AppError::bad_request("bad_multipart", format!("上传数据解析失败: {err}")))?
    {
        let Some(raw_name) = field.file_name().map(|name| name.to_string()) else {
            // Plain form fields carry no file, skip them.
            continue;
        };
        seen += 1;
        if seen > MAX_FILES_PER_REQUEST {
            return Err(AppError::bad_request(
                "too_many_files",
                format!("一次最多上传 {MAX_FILES_PER_REQUEST} 个文件"),
            ));
        }

        let name = sanitize_filename(&raw_name)?;
        let rel = join_rel(&dir, &name);
        let target = resolve(&state.cfg.workspace, &rel)?;

        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() => {
                return Err(AppError::bad_request(
                    "not_a_file",
                    format!("{rel} 是一个目录，不能用文件覆盖"),
                ));
            }
            Ok(_) if !overwrite => {
                return Err(AppError::conflict(
                    "file_exists",
                    format!("{rel} 已存在；如需替换请勾选覆盖"),
                ));
            }
            _ => {}
        }
        if state.hub.is_active(&rel) {
            return Err(AppError::conflict(
                "file_busy",
                format!("{rel} 正在被协作编辑，请等所有人离开后再上传"),
            ));
        }

        let written = stream_to_temp(&mut field, &target, &rel, limit).await?;
        saved.push(Saved {
            path: rel.clone(),
            size: written,
            kind: kind_for(&rel, mime_for(&rel)),
        });
        state.hub.forget_snapshot(&rel);
    }

    if seen == 0 {
        return Err(AppError::bad_request("no_files", "请求里没有文件"));
    }

    let files: Vec<Value> = saved
        .iter()
        .map(|item| {
            json!({
                "path": item.path,
                "size": item.size,
                "kind": item.kind,
                "url": raw_url(&item.path),
            })
        })
        .collect();
    if !saved.is_empty() {
        let names: Vec<&str> = saved.iter().map(|item| item.path.as_str()).collect();
        tracing::info!(dir = %dir, files = ?names, "上传文件");
    }

    Ok((
        StatusCode::CREATED,
        Json(json!({ "dir": dir, "files": files })),
    )
        .into_response())
}

/// Removes an upload temp file unless it was explicitly kept.
///
/// The upload body is streamed: when the client disconnects mid-request the handler
/// future is dropped, so cleanup cannot live on the error branches alone — this guard
/// runs on `Drop` instead, covering cancellation, errors and panics alike.
struct TempGuard {
    path: Option<PathBuf>,
}

impl TempGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    /// Keep the file (it was renamed into place).
    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "清理上传临时文件失败"
                ),
            }
        }
    }
}

/// Stream one part into `<target>.mc-upload-<uuid>` and only rename it into place
/// once the whole part arrived; on any failure — including a client that disappears
/// halfway through — the temporary file is removed.
async fn stream_to_temp(
    field: &mut axum::extract::multipart::Field<'_>,
    target: &Path,
    rel: &str,
    limit: i64,
) -> Result<i64, AppError> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let temp: PathBuf = dir.join(format!(".mc-upload-{}", uuid::Uuid::new_v4()));
    let mut guard = TempGuard::new(temp.clone());

    let mut file = tokio::fs::File::create(&temp)
        .await
        .with_context(|| format!("写入临时文件失败: {}", temp.display()))
        .map_err(AppError::from)?;
    let mut written: i64 = 0;

    loop {
        let chunk = match field.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                return Err(AppError::bad_request(
                    "bad_multipart",
                    format!("上传数据读取失败: {err}"),
                ));
            }
        };
        written += chunk.len() as i64;
        if written > limit {
            return Err(AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "too_large",
                format!(
                    "{rel} 超过上传上限 {}，请联系管理员调整",
                    settings::human_bytes(limit)
                ),
            ));
        }
        if let Err(err) = file.write_all(&chunk).await {
            return Err(AppError::internal(
                anyhow::Error::new(err).context("写入上传文件失败"),
            ));
        }
    }

    if let Err(err) = file.flush().await {
        return Err(AppError::internal(
            anyhow::Error::new(err).context("刷新上传文件失败"),
        ));
    }
    drop(file);

    if let Err(err) = tokio::fs::rename(&temp, target).await {
        return Err(AppError::internal(
            anyhow::Error::new(err).context(format!("重命名上传文件失败: {rel}")),
        ));
    }
    guard.disarm();
    Ok(written)
}

// ---------------------------------------------------------------- raw download

pub async fn raw(
    State(state): State<AppState>,
    _auth: AuthUser,
    Query(query): Query<crate::files::FileQuery>,
) -> ApiResult<Response> {
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
    if meta.len() > crate::files::MAX_READ_BYTES {
        return Err(AppError::too_large(
            "too_large",
            "文件超过 100 MiB，无法在浏览器中读取",
        ));
    }

    let bytes = tokio::fs::read(&abs)
        .await
        .with_context(|| format!("读取文件失败: {rel}"))
        .map_err(AppError::from)?;
    let mime = mime_for(&rel)
        .map(str::to_string)
        .or_else(|| sniff_mime(&bytes).map(str::to_string));
    let content_type = mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let inline = mime
        .as_deref()
        .map(|m| m.starts_with("image/") || m == "application/pdf" || m.starts_with("text/"))
        .unwrap_or(false);
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        utf8_percent_encode(
            Path::new(&rel)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| rel.clone())
                .as_str(),
            QUERY_VALUE
        )
    );

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&content_type).unwrap(),
        )
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, max-age=60")
        .header("x-file-mtime", mtime_ms(&meta));

    // An SVG is a document that can carry script; sandbox it so it cannot reach
    // the SPA's origin or its cookies.
    if content_type == "image/svg+xml" {
        builder = builder.header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        );
    }

    builder
        .body(Body::from(bytes))
        .map_err(|err| AppError::internal(anyhow::Error::new(err).context("构造原始文件响应失败")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_for_classifies_text_image_and_other() {
        for path in [
            "notes/a.txt",
            "run.log",
            "data.csv",
            "conf.json",
            "ci.yaml",
            "Cargo.toml",
            "src/main.rs",
            "tools/x.py",
            "web/src/app.js",
            "README.md",
        ] {
            assert_eq!(kind_for(path, mime_for(path)), "text", "{path} 应是 text");
        }
        for path in ["p.png", "photo.jpeg", "logo.svg"] {
            assert_eq!(kind_for(path, mime_for(path)), "image", "{path} 应是 image");
        }
        for path in ["a.zip", "movie.mp4", "blob.dat", "noext"] {
            assert_eq!(kind_for(path, mime_for(path)), "other", "{path} 应是 other");
        }
        assert_eq!(kind_for("noext", None), "other");
    }
}
