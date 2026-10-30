//! 启动配置：工作区目录、数据目录、监听地址、主密钥。

use anyhow::{Context, Result, bail};
use rand::RngCore;
use std::{
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

pub const USAGE: &str = "\
md-coworker —— 实时协作 Markdown 工作区

用法:
    md-coworker <工作区目录> [选项]

选项:
    --bind <ADDR>      监听地址，默认 127.0.0.1:3000
    --data <DIR>       数据目录（SQLite / CRDT 快照 / 主密钥），默认 ./data
    --static <DIR>     前端构建产物目录，默认 ./web/dist
    --session-ttl <秒> 会话有效期，默认 604800（7 天）
    -h, --help         显示本帮助
";

#[derive(Debug, Clone)]
pub struct Config {
    /// 工作区根目录（启动参数第一个位置参数，已 canonicalize）。
    pub workspace: PathBuf,
    /// 数据目录。
    pub data_dir: PathBuf,
    /// 前端静态资源目录。
    pub static_dir: PathBuf,
    /// 监听地址。
    pub bind: SocketAddr,
    /// 512 bit（64 字节）主密钥材料，用于派生 AES-256 数据密钥。
    pub master_key: Vec<u8>,
    /// 会话有效期。
    pub session_ttl: Duration,
}

impl Config {
    pub fn from_args() -> Result<Self> {
        let mut workspace: Option<String> = None;
        let mut bind: Option<String> = None;
        let mut data_dir: Option<String> = None;
        let mut static_dir: Option<String> = None;
        let mut session_ttl: Option<u64> = None;

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

        let workspace = workspace.context("必须把工作区目录作为第一个参数\n\n补一个: md-coworker ./workspace")?;
        let workspace = std::fs::canonicalize(&workspace)
            .with_context(|| format!("工作区目录不存在或不可访问: {workspace}"))?;

        let data_dir = PathBuf::from(data_dir.unwrap_or_else(|| "data".into()));
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("无法创建数据目录 {}", data_dir.display()))?;
        std::fs::create_dir_all(data_dir.join("crdt"))
            .with_context(|| format!("无法创建 CRDT 快照目录 {}", data_dir.join("crdt").display()))?;
        let data_dir = std::fs::canonicalize(&data_dir)?;

        let static_dir = PathBuf::from(static_dir.unwrap_or_else(|| "web/dist".into()));
        let bind: SocketAddr = bind
            .unwrap_or_else(|| "127.0.0.1:3000".into())
            .parse()
            .context("监听地址格式错误，例如 127.0.0.1:3000")?;

        let master_key = load_or_create_master_key(&data_dir)?;

        Ok(Self {
            workspace,
            data_dir,
            static_dir,
            bind,
            master_key,
            session_ttl: Duration::from_secs(session_ttl.unwrap_or(7 * 24 * 3600)),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("md-coworker.sqlite3")
    }

    pub fn snapshots_dir(&self) -> PathBuf {
        self.data_dir.join("crdt")
    }
}

/// 读取（或首次生成）512 bit 主密钥。文件权限 0600。
fn load_or_create_master_key(data_dir: &Path) -> Result<Vec<u8>> {
    let path = data_dir.join("master.key");
    if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("读取主密钥失败: {}", path.display()))?;
        let bytes = hex_decode(raw.trim())
            .with_context(|| format!("主密钥格式非法（应为 128 位 hex）: {}", path.display()))?;
        if bytes.len() != 64 {
            bail!("主密钥长度应为 64 字节（512 bit），实际 {} 字节", bytes.len());
        }
        return Ok(bytes);
    }

    let mut key = vec![0u8; 64];
    rand::rngs::OsRng.fill_bytes(&mut key);
    std::fs::write(&path, hex_encode(&key))
        .with_context(|| format!("写入主密钥失败: {}", path.display()))?;
    let mut perms = std::fs::metadata(&path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(&path, perms)?;
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
