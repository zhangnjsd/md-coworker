//! md-coworker — a real-time collaborative Markdown workspace built on Axum.
//!
//! Usage: `md-coworker <workspace-dir>` (the first argument is the workspace root).

mod admin;
mod api;
mod auth;
mod collab;
mod config;
mod crypto;
mod db;
mod error;
mod files;
mod models;

use anyhow::{Context, Result};
use collab::Hub;
use config::Config;
use crypto::Cipher;
use db::Db;
use models::AppState;
use std::{sync::Arc, time::Duration};
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cfg = Arc::new(Config::from_args()?);
    let cipher = Arc::new(Cipher::from_master(&cfg.master_key));
    let db = Arc::new(Db::open(&cfg.db_path())?);

    bootstrap_admin(&db, &cfg)?;

    let hub = Arc::new(Hub::new(cfg.clone(), cipher.clone()));
    collab::spawn_background_tasks(hub.clone());

    {
        let db = db.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(600));
            loop {
                ticker.tick().await;
                if let Err(err) = db.cleanup() {
                    tracing::warn!(error = %err, "清理过期会话失败");
                }
            }
        });
    }

    let state = AppState {
        cfg: cfg.clone(),
        db,
        cipher,
        hub: hub.clone(),
    };

    if !cfg.static_dir.join("index.html").exists() {
        tracing::warn!(
            dir = %cfg.static_dir.display(),
            "未找到前端构建产物（web/dist/index.html），页面将返回 404；请先执行 `cd web && npm install && npm run build`"
        );
    }

    let app = api::router(state);
    let listener = tokio::net::TcpListener::bind(cfg.bind)
        .await
        .with_context(|| format!("无法监听 {}", cfg.bind))?;
    let local = listener.local_addr()?;

    println!();
    println!("  md-coworker v{} 已启动", env!("CARGO_PKG_VERSION"));
    println!("  监听地址 : http://{local}");
    println!("  工作区   : {}", cfg.workspace.display());
    println!("  数据目录 : {}", cfg.data_dir.display());
    println!("  前端产物 : {}", cfg.static_dir.display());
    println!("  加密方案 : AES-256-GCM（密钥材料 512bit，HKDF-SHA512 派生）");
    println!();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP 服务异常退出")?;

    hub.flush_all();
    tracing::info!("已保存全部待落盘文档，进程退出");
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_env("MC_LOG")
        .unwrap_or_else(|_| EnvFilter::new("md_coworker=info,tower_http=warn,axum=warn"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .init();
}

/// First run: create the admin account, print its private key and drop a copy in
/// `data/bootstrap-admin.key`.
fn bootstrap_admin(db: &Db, cfg: &Config) -> Result<()> {
    if db.count_users()? > 0 {
        return Ok(());
    }
    let (private_key, public_key) = crypto::generate_keypair();
    let user = db.create_user("admin", db::Role::Admin, &public_key)?;

    let key_file = cfg.data_dir.join("bootstrap-admin.key");
    std::fs::write(&key_file, &private_key)
        .with_context(|| format!("写入管理员初始私钥失败: {}", key_file.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&key_file)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&key_file, perms)?;
    }

    let banner = format!(
        "\n\
        ============================================================\n\
         首次启动：已创建管理员账号\n\
         用户名 : {}\n\
         私钥   : {}\n\
        ------------------------------------------------------------\n\
         私钥用于登录（Ed25519 挑战签名），服务端不保存私钥。\n\
         请立即保存到密码管理器，并删除 {} 后妥善保管。\n\
        ============================================================\n",
        user.username,
        private_key,
        key_file.display()
    );
    println!("{banner}");
    tracing::warn!(file = %key_file.display(), "管理员私钥已落盘，请尽快迁移保存");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut sigterm) = signal(SignalKind::terminate()) {
            sigterm.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("收到退出信号，正在收尾…");
}
