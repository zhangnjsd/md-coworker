# md-coworker

基于 **Axum** 的实时协作 Markdown 工作区：密钥对登录（可选 TOTP 2FA）、左侧编辑 / 右侧预览、
可折叠文件树，以及对任意文本文件使用 Monaco（VSCode 同源编辑器）在线编辑。
协作部分使用 **CRDT（Yjs ⇄ yrs）**，编辑内容实时落盘，**无需手动保存**，且撤销只作用于自己的编辑。

```
浏览器 (CodeMirror 6 / Monaco + Yjs)
        │  WebSocket (JSON + base64 二进制帧)
        ▼
Axum (0.8) ── yrs 文档房间 ── 400ms 防抖落盘 ──▶ 工作区目录里的 .md / .rs / …
        │
        └── rusqlite（用户 / 会话 / 2FA 种子，敏感字段 AES-256-GCM 加密）
```

## 快速开始

```bash
# 1. 构建前端（产物进入 web/dist，由后端静态托管）
cd web && npm install && npm run build && cd ..

# 2. 构建并启动后端；第一个参数就是工作区目录
cargo run --release -- ./demo-workspace --bind 127.0.0.1:3000
```

首次启动会自动创建 `admin` 账号，把私钥打印在终端并写入 `data/bootstrap-admin.key`
（权限 0600）。**该私钥只出现这一次**，服务端不保存私钥，请立刻转存到密码管理器。

打开 <http://127.0.0.1:3000>，用「用户名 + 私钥」登录即可。

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `<工作区目录>`（位置参数，必填） | 所有文件操作都被限制在该目录内 |
| `--bind <地址>` | 监听地址，默认 `127.0.0.1:3000` |
| `--data <目录>` | 数据库、主密钥、CRDT 快照目录，默认 `./data` |
| `--static <目录>` | 前端产物目录，默认 `web/dist` |
| `--session-ttl <小时>` | 会话有效期，默认 168 |

环境变量 `MC_LOG` 可调日志级别（默认 `md_coworker=info`）。

## 账号与登录

- **没有密码**。登录是 Ed25519 挑战签名：服务端下发随机 nonce，客户端用私钥签名，服务端用公钥验签。
- 私钥是 32 字节种子（base64），只存在于用户手里；服务端只保存公钥。
- 管理员在「用户管理」里创建用户，创建成功后私钥**只显示一次**（可下载 `.key` 文件）。
- 任何用户都可以在设置里**重新生成密钥对**，旧私钥立即失效。
- 用户可自行开启 TOTP 2FA（扫码或手输密钥），开启后登录需要「私钥签名 + 6 位动态码」两步。
- 会话保存在 HttpOnly Cookie（`mc_sid`，SameSite=Lax）里，服务端只存其 SHA-256。

## 编辑器

| 文件类型 | 编辑器 | 说明 |
| --- | --- | --- |
| `.md` / `.markdown` | CodeMirror 6 + y-codemirror | 左编辑、右预览，预览支持 **KaTeX 公式**、**Mermaid 图表**、代码高亮，HTML 经 DOMPurify 过滤 |
| 其它文本文件 | Monaco（`vs-dark`）+ y-monaco | 即 VSCode 的开源编辑器内核；只在桌面端加载，按需动态引入 |

取舍：没有引入完整 VS Code 工作台（`code-server` 需要 Node 服务端与更重的资源占用），
而是用 VSCode 的编辑器内核 Monaco 承担代码编辑，Markdown 用更轻的 CodeMirror 6，
两者都接同一个 Yjs 文档，从而共享同一套协作/落盘链路。仅适配桌面端（≥1024px）。

## 协作模型

- 每个文件在服务端对应一个 `yrs::Doc`（Yjs 的 Rust 实现），根 Y.Text 名为 `content`，是全量历史。
- 客户端 `join` 一个文件 → 收到 `init`（当前状态全量更新）→ 之后互发增量更新。
- 服务端 400ms 防抖把文档文本写回磁盘；即使进程崩溃，最多丢 400ms 的输入。
  房间没人时会立刻落盘并把文档从内存回收，下次进入从加密快照恢复历史（Undo 不会因重连而错乱）。
- **撤销**：客户端只用 `UndoManager` 跟踪本地来源的编辑（`origin === null`），远端更新带 `origin = 'remote'`，
  因此 `Ctrl/Cmd+Z` 只能撤回自己的编辑，撤回不了别人的。
- **在线感知**（核心功能）：`presence` 帧携带「我在哪个文件 + 光标行列 + 选区长度」，服务端按 1s 汇总广播，
  右侧面板会列出在线用户、其文件与位置，点击可直接跳转；文件树里也会标记「谁在编辑这个文件」。

## 安全说明

- 路径参数一律按工作区根目录解析，拒绝 `..`、绝对路径与符号链接逃逸。
- 参与协作的文件在有人编辑时禁止重命名 / 删除（返回 `409 file_busy`），避免文档与磁盘错位。
- 2FA 种子、CRDT 快照等在磁盘上都是密文；主密钥 `data/master.key` 权限 0600。

### 关于「AES 512」

AES 分组长度固定 128 bit，标准中也不存在 512 位密钥的 AES。本项目按需求把「AES 512」落地为
**512 bit（64 字节）主密钥 + HKDF-SHA512 密钥派生 + AES-256-GCM 加密**：

```
master.key (64B / 512bit, 128 hex 字符)
   └─ HKDF-SHA512(info="md-coworker:v1") ─▶ 32B 数据密钥 ─▶ AES-256-GCM（96bit nonce，128bit tag）
```

也就是说，密钥材料的强度是 512 bit，实际分组算法是 AEAD 的 AES-256-GCM（提供机密性 + 完整性）。
这是标准允许的、且更安全的组合；如需换成 AES-256-CBC 或加倍密钥长度，只需改 `src/crypto.rs`。

## 项目结构

```
src/
  main.rs      启动、管理员初始化、优雅退出
  config.rs    命令行参数与目录/主密钥
  error.rs     anyhow 封装为 HTTP 响应（统一 {"error":{"code","message"}}）
  crypto.rs    HKDF / AES-256-GCM / Ed25519 / base32 / TOTP
  db.rs        rusqlite：用户、会话、挑战、2FA 票据
  auth.rs      登录、2FA、密钥轮换
  admin.rs     用户管理
  files.rs     工作区文件树与读写（安全路径解析）
  collab.rs    WebSocket + yrs 文档房间 + 落盘 + presence
  api.rs       路由装配、静态资源托管
web/           前端（Vite + 原生 ES modules）
tools/         端到端冒烟测试
demo-workspace/ 示例工作区
docs/protocol.md 前后端协议契约
```

## 测试

```bash
cargo test                 # 单元测试：HKDF / AES / Ed25519 / base32 / TOTP
node tools/smoke.mjs       # 端到端：登录、文件、双客户端协作、presence、2FA、密钥轮换
```
