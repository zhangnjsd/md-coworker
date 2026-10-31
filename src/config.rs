//! Startup configuration: workspace directory, data directory, database URL, bind
//! address and the master key.

use anyhow::{Context, Result, bail};
use rand::RngCore;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};

/// Default DSN of the project-local cluster (`just db-up` starts it on port 5433).
pub const DEFAULT_DATABASE_URL: &str = "postgres://md_coworker@127.0.0.1:5433/md_coworker";

pub const USAGE: &str = "\
md-coworker

用法:
    md-coworker <工作区目录> [选项]

选项:
    --bind <ADDR>           监听地址，默认 127.0.0.1:3000
    --database-url <URL>    PostgreSQL 连接串，默认读环境变量 DATABASE_URL，
                            再回退到 postgres://md_coworker@127.0.0.1:5433/md_coworker
    --data <DIR>            数据目录（CRDT 快照 / 主密钥），默认 ./data；
                            必须位于工作区之外
    --static <DIR>          前端构建产物目录，默认 ./web/dist
    --session-ttl <秒>      会话有效期，默认 604800（7 天）
    --secure-cookies        即使没有 TLS 终止代理，也强制给会话 Cookie 加 Secure
                            （用于直接反代到 HTTPS 的部署；等价于环境变量 SECURE_COOKIES=1）
    -h, --help              显示本帮助
";

#[derive(Debug, Clone)]
pub struct Config {
    /// Workspace root (first positional argument, already canonicalized).
    pub workspace: PathBuf,
    /// Data directory.
    pub data_dir: PathBuf,
    /// PostgreSQL connection string.
    pub database_url: String,
    /// Frontend build output directory.
    pub static_dir: PathBuf,
    /// Bind address.
    pub bind: SocketAddr,
    /// 512-bit (64-byte) master key material; the AES-256 data key is derived from it.
    pub master_key: Vec<u8>,
    /// Session lifetime.
    pub session_ttl: Duration,
    /// Force the `Secure` attribute on the session cookie even when the request arrived
    /// over plain HTTP (the browser still sends it back over HTTPS).
    pub secure_cookies: bool,
}

impl Config {
    pub fn from_args() -> Result<Self> {
        let mut workspace: Option<String> = None;
        let mut bind: Option<String> = None;
        let mut data_dir: Option<String> = None;
        let mut static_dir: Option<String> = None;
        let mut database_url: Option<String> = None;
        let mut session_ttl: Option<u64> = None;
        let mut secure_cookies = env_flag("SECURE_COOKIES");

        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "-h" | "--help" => {
                    println!("{USAGE}");
                    std::process::exit(0);
                }
                "--bind" => bind = Some(args.next().context("--bind 缺少参数")?),
                "--data" => data_dir = Some(args.next().context("--data 缺少参数")?),
                "--static" => static_dir = Some(args.next().context("--static 缺少参数")?),
                "--secure-cookies" => secure_cookies = true,
                "--database-url" => {
                    database_url = Some(args.next().context("--database-url 缺少参数")?)
                }
                "--session-ttl" => {
                    let value = args.next().context("--session-ttl 缺少参数")?;
                    session_ttl = Some(value.parse().context("--session-ttl 需要整数秒")?);
                }
                other if other.starts_with('-') => bail!("未知选项: {other}\n\n{USAGE}"),
                other => {
                    if workspace.is_some() {
                        bail!("只能指定一个工作区目录\n\n{USAGE}");
                    }
                    workspace = Some(other.to_string());
                }
            }
        }

        let workspace = workspace
            .context("必须把工作区目录作为第一个参数\n\n补一个: md-coworker ./workspace")?;
        let workspace = std::fs::canonicalize(&workspace)
            .with_context(|| format!("工作区目录不存在或不可访问: {workspace}"))?;

        let data_dir = PathBuf::from(data_dir.unwrap_or_else(|| "data".into()));
        // Refuse a data directory inside the workspace *before* creating anything: the
        // workspace is served over HTTP, so a master key or CRDT snapshot stored under it
        // would be downloadable.
        ensure_data_outside_workspace(&workspace, &data_dir)?;
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("无法创建数据目录 {}", data_dir.display()))?;
        std::fs::create_dir_all(data_dir.join("crdt")).with_context(|| {
            format!("无法创建 CRDT 快照目录 {}", data_dir.join("crdt").display())
        })?;
        let data_dir = std::fs::canonicalize(&data_dir)?;
        restrict_to_owner(&data_dir)?;

        let static_dir = PathBuf::from(static_dir.unwrap_or_else(|| "web/dist".into()));
        let bind: SocketAddr = bind
            .unwrap_or_else(|| "127.0.0.1:3000".into())
            .parse()
            .context("监听地址格式错误，例如 127.0.0.1:3000")?;

        let database_url = database_url
            .or_else(|| std::env::var("DATABASE_URL").ok())
            .unwrap_or_else(|| DEFAULT_DATABASE_URL.to_string());

        let master_key = load_or_create_master_key(&data_dir)?;

        Ok(Self {
            workspace,
            data_dir,
            database_url,
            static_dir,
            bind,
            master_key,
            session_ttl: Duration::from_secs(session_ttl.unwrap_or(7 * 24 * 3600)),
            secure_cookies,
        })
    }

    pub fn snapshots_dir(&self) -> PathBuf {
        self.data_dir.join("crdt")
    }
}

/// Is an environment switch set to something affirmative (`1`, `true`, `yes`, `on`)?
fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Reject a data directory that lives inside the workspace (or is the workspace).
///
/// Both sides are compared by real path, so `./data` versus a workspace reached through a
/// symlink cannot slip through. A data directory that does not exist yet is resolved
/// through its nearest existing ancestor, which lets the check run before creation.
fn ensure_data_outside_workspace(workspace: &Path, data_dir: &Path) -> Result<()> {
    let data_abs = if data_dir.is_absolute() {
        data_dir.to_path_buf()
    } else {
        std::env::current_dir()
            .context("无法获取当前工作目录")?
            .join(data_dir)
    };
    let data_real = crate::files::canonicalize_lenient(&data_abs)
        .with_context(|| format!("无法解析数据目录的真实路径: {}", data_dir.display()))?;
    if data_real.starts_with(workspace) {
        bail!(
            "--data 必须放在工作区之外：{} 位于工作区 {} 之内，\
             主密钥与 CRDT 快照不能通过文件接口暴露",
            data_real.display(),
            workspace.display()
        );
    }
    Ok(())
}

/// Make the data directory owner-only (it holds the master key and every CRDT snapshot).
#[cfg(unix)]
fn restrict_to_owner(dir: &Path) -> Result<()> {
    let mut perms = std::fs::metadata(dir)?.permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(dir, perms)
        .with_context(|| format!("设置数据目录权限失败: {}", dir.display()))?;
    Ok(())
}

/// Non-Unix platforms have no POSIX mode bits to tighten.
#[cfg(not(unix))]
fn restrict_to_owner(_dir: &Path) -> Result<()> {
    Ok(())
}

/// Read (or generate on first run) the 512-bit master key. File mode is 0600.
fn load_or_create_master_key(data_dir: &Path) -> Result<Vec<u8>> {
    let path = data_dir.join("master.key");
    if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("读取主密钥失败: {}", path.display()))?;
        let bytes = hex_decode(raw.trim())
            .with_context(|| format!("主密钥格式非法（应为 128 位 hex）: {}", path.display()))?;
        if bytes.len() != 64 {
            bail!(
                "主密钥长度应为 64 字节（512 bit），实际 {} 字节",
                bytes.len()
            );
        }
        return Ok(bytes);
    }

    let mut key = vec![0u8; 64];
    rand::rngs::OsRng.fill_bytes(&mut key);
    std::fs::write(&path, hex_encode(&key))
        .with_context(|| format!("写入主密钥失败: {}", path.display()))?;
    #[cfg(unix)]
    {
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)?;
    }
    tracing::info!("已生成新的 512bit 主密钥: {}", path.display());
    Ok(key)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub fn hex_decode(text: &str) -> Result<Vec<u8>> {
    if text.len() % 2 != 0 {
        bail!("hex 字符串长度必须为偶数");
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for chunk in bytes.chunks(2) {
        let hi = (chunk[0] as char).to_digit(16).context("非法 hex 字符")? as u8;
        let lo = (chunk[1] as char).to_digit(16).context("非法 hex 字符")? as u8;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-config-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        std::fs::canonicalize(&dir).expect("解析临时目录")
    }

    #[test]
    fn data_directory_inside_workspace_is_rejected() {
        let workspace = temp_dir("ws-inside");
        std::fs::create_dir_all(workspace.join("data")).unwrap();

        // Equality and nesting (existing or not yet created) must both be rejected.
        assert!(ensure_data_outside_workspace(&workspace, &workspace).is_err());
        assert!(ensure_data_outside_workspace(&workspace, &workspace.join("data")).is_err());
        assert!(ensure_data_outside_workspace(&workspace, &workspace.join("new-data")).is_err());

        let err = ensure_data_outside_workspace(&workspace, &workspace.join("data"))
            .expect_err("工作区内的数据目录必须被拒绝");
        assert!(
            format!("{err:#}").contains("--data 必须放在工作区之外"),
            "错误信息应说明 --data 必须放在工作区之外: {err:#}"
        );

        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn data_directory_outside_workspace_is_accepted() {
        let workspace = temp_dir("ws-outside");
        let sibling =
            std::env::temp_dir().join(format!("mc-config-outside-{}", std::process::id()));
        std::fs::create_dir_all(&sibling).unwrap();
        let sibling = std::fs::canonicalize(&sibling).unwrap();

        assert!(ensure_data_outside_workspace(&workspace, &sibling).is_ok());
        assert!(ensure_data_outside_workspace(&workspace, &sibling.join("data")).is_ok());

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&sibling);
    }
}
