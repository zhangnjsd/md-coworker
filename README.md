# md-coworker

基于 **Axum** 的实时协作 Markdown 工作区：密钥对登录（可选 TOTP 2FA）、左侧编辑 / 右侧预览、
可折叠文件树，以及对任意文本文件使用 Monaco（VSCode 同源编辑器）在线编辑。
协作部分使用 **CRDT（Yjs ⇄ yrs）**，编辑内容实时保存，**无需手动保存**，且撤销只作用于自己的编辑。

```
浏览器 (CodeMirror 6 / Monaco + Yjs)
        │  WebSocket (JSON + base64 二进制帧)
        ▼
Axum (0.8) ── yrs 文档房间 ── 400ms 防抖保存 ──▶ 工作区目录里的 .md / .rs / …
        │
        └── PostgreSQL（sqlx）：用户 / 会话 / 2FA 种子，敏感字段 AES-256-GCM 加密
```

![登录](docs/screenshots/login.png)

![编辑与预览](docs/screenshots/editor.png)

## 快速开始

```bash
# 用 just（推荐）
just install     # 前端 + 测试脚本依赖
just web         # 构建前端产物到 web/dist
just db-up       # 启动项目自带的 PostgreSQL 集群（首次会 initdb + createdb）
just run         # release 构建并启动；第一个参数就是工作区目录

# 或者直接手敲
cd web && npm install && npm run build && cd ..
DATABASE_URL=postgres://md_coworker@127.0.0.1:5433/md_coworker \
  cargo run --release -- ./demo-workspace --bind 127.0.0.1:3000
```

需要一个可用的 PostgreSQL（开发时用 18，14+ 均可）。仓库不内置数据库进程：
`just db-up` 会用 `PG_BIN`（默认 `/usr/lib/postgresql/18/bin`）在 `data/pg` 建一个
**只监听 127.0.0.1:5433、trust 认证、仅供本项目使用**的独立集群；
连自己的数据库只要设 `DATABASE_URL` 或传 `--database-url`，表结构会在启动时自动创建。

首次启动会自动创建 `admin` 账号，把私钥打印在终端并写入 `data/bootstrap-admin.key`
（权限 0600）。**该私钥只出现这一次**，服务端不保存私钥，请立刻转存到密码管理器。

打开 <http://127.0.0.1:3000>，用「用户名 + 私钥」登录即可。

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `<工作区目录>`（位置参数，必填） | 所有文件操作都被限制在该目录内 |
| `--bind <地址>` | 监听地址，默认 `127.0.0.1:3000` |
| `--database-url <URL>` | PostgreSQL 连接串，默认取环境变量 `DATABASE_URL`，再回退 `postgres://md_coworker@127.0.0.1:5433/md_coworker` |
| `--data <目录>` | 主密钥与 CRDT 快照目录，默认 `./data`（数据表在 PostgreSQL 里） |
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
两者都接同一个 Yjs 文档，从而共享同一套协作/保存链路。仅适配桌面端（≥1024px）。

## 协作模型

- 每个文件在服务端对应一个 `yrs::Doc`（Yjs 的 Rust 实现），根 Y.Text 名为 `content`，是全量历史。
- 客户端 `join` 一个文件 → 收到 `init`（当前状态全量更新）→ 之后互发增量更新。
- 服务端 400ms 防抖把文档文本写回磁盘；即使进程崩溃，最多丢 400ms 的输入。
  房间没人时会立刻保存并把文档从内存回收，下次进入从加密快照恢复历史（Undo 不会因重连而错乱）。
- **撤销**：客户端只用 `UndoManager` 跟踪本地来源的编辑（`origin === null`），远端更新带 `origin = 'remote'`，
  因此 `Ctrl/Cmd+Z` 只能撤回自己的编辑，撤回不了别人的。
- **在线感知**（核心功能）：`presence` 帧携带「我在哪个文件 + 光标行列 + 选区长度」，服务端按 1s 汇总广播，
  右侧面板会列出在线用户、其文件与位置，点击可直接跳转；文件树里也会标记「谁在编辑这个文件」。

## 安全说明

- 路径参数一律按工作区根目录解析，拒绝 `..`、绝对路径与符号链接逃逸。
- 参与协作的文件在有人编辑时禁止重命名 / 删除（返回 `409 file_busy`），避免文档与磁盘错位。
- 2FA 种子、CRDT 快照等在磁盘/数据库里都是密文；主密钥 `data/master.key` 权限 0600。
- 会话令牌在数据库里也只存 SHA-256；`sessions` / `challenges` / `mfa_tickets` 都带过期时间，
  过期即失效并由后台任务回收。

### 关于「AES 512」

AES 分组长度固定 128 bit，标准中也不存在 512 位密钥的 AES。本项目按需求把「AES 512」落地为
**512 bit（64 字节）主密钥 + HKDF-SHA512 密钥派生 + AES-256-GCM 加密**：

```
master.key (64B / 512bit, 128 hex 字符)
   └─ HKDF-SHA512(info="md-coworker:v1") ─▶ 32B 数据密钥 ─▶ AES-256-GCM（96bit nonce，128bit tag）
```

也就是说，密钥材料的强度是 512 bit，实际分组算法是 AEAD 的 AES-256-GCM（提供机密性 + 完整性）。
这是标准允许的、且更安全的组合；如需换成 AES-256-CBC 或加倍密钥长度，只需改 `src/crypto.rs`。

### 数据存储

关系型数据在 PostgreSQL，文档内容仍是磁盘上的文件（+ `data/crdt/` 里的加密快照）：

| 表 | 内容 | 清理 |
| --- | --- | --- |
| `users` | 用户名、角色、presence 颜色、公钥、加密的 TOTP 种子 | 管理员删除 |
| `sessions` | 会话令牌的 SHA-256、创建/过期时间 | 过期即失效，后台 10 分钟回收 |
| `challenges` | 登录挑战 nonce（一次性） | 验签后立即删除 |
| `mfa_tickets` | 通过第一因子后签发的 2FA 票据 | 用完即删 / 5 分钟过期 |

表结构由 `src/db.rs` 里的 `CREATE TABLE IF NOT EXISTS` 在启动时保证，`just db-status` 可以随时查看。

## 界面

| 登录 | 工作区（三人在同一份文档里） |
| --- | --- |
| ![登录](docs/screenshots/login.png) | ![工作区](docs/screenshots/editor.png) |

| 代码文件（Monaco） | 设置 | 管理后台 |
| --- | --- | --- |
| ![代码](docs/screenshots/code.png) | ![设置](docs/screenshots/settings.png) | ![后台](docs/screenshots/admin.png) |

## 设计

界面方向叫 **Ink & Signal**：文档是主角，其余都是脚手架；协作用同一套 presence 圆点表达（顶栏、文件树、协作者栏、编辑器光标同色）；技术感来自等宽元信息排版，而不是装饰。

- **字体**：正文/UI 用 **Geist**，标题与品牌用 **Space Grotesk**，代码与元信息用 **Geist Mono**（三者都随前端本地打包，无外部 CDN；中文回退到 PingFang / 思源黑体）。
- **颜色**：全部用 **OKLCH** 定义在 `web/src/styles/tokens.css`，中性色带蓝调（墨蓝 slate，不用纯黑/纯灰），唯一强调色是青玉 `oklch(0.82 0.12 172)`。源码画布比面板深一档、预览画布比面板亮一档，读者的视线自然落到渲染后的文档上。
- **动效**：`cubic-bezier(0.16, 1, 0.3, 1)`，微交互 120–180ms、弹层 320ms，并尊重 `prefers-reduced-motion`。
- **可访问性**：全键盘可达，focus 永久可见（2px 强调色 ring），加载用 skeleton 而不是转圈，错误文案给出下一步。

完整规范（色表、间距、组件、文案、文件归属与验收清单）在 [`docs/design.md`](docs/design.md)；样式按 `tokens / controls / shell / prose / views / overlays` 六个模块拆分在 `web/src/styles/`。

## 项目结构

```
src/
  main.rs      启动、管理员初始化、优雅退出
  config.rs    命令行参数与目录/主密钥
  error.rs     anyhow 封装为 HTTP 响应（统一 {"error":{"code","message"}}）
  crypto.rs    HKDF / AES-256-GCM / Ed25519 / base32 / TOTP
  db.rs        sqlx + PostgreSQL：用户、会话、挑战、2FA 票据（启动时建表）
  auth.rs      登录、2FA、密钥轮换
  admin.rs     用户管理
  files.rs     工作区文件树与读写（安全路径解析）
  collab.rs    WebSocket + yrs 文档房间 + 保存 + presence
  api.rs       路由装配、静态资源托管
web/           前端（Vite + 原生 ES modules）
  src/styles/  六份 CSS：tokens / controls / shell / prose / views / overlays
tools/         端到端冒烟测试（smoke）、真浏览器测试（browser）、截图（shots）
demo-workspace/ 示例工作区
docs/protocol.md 前后端协议契约
docs/design.md   前端视觉/交互规范
```

## 测试

```bash
just test        # 单元测试：HKDF / AES / Ed25519 / base32 / TOTP
just smoke       # 端到端接口 + WebSocket：登录、文件、双客户端协作、presence、2FA、密钥轮换
just browser     # 真浏览器（Chromium）双窗口：登录、预览渲染、实时同步、在线面板、撤销隔离
```

`smoke` / `browser` 需要服务已在 `BIND`（默认 `127.0.0.1:3000`）上运行，
并先 `just install` 装好 `web/` 与 `tools/` 的 npm 依赖（ws / yjs / tweetnacl / puppeteer-core）。

## 常用命令（Just）

本项目用 [just](https://github.com/casey/just) 而不是 Make 管理任务，`just` 或 `just --list` 可看全部：

```bash
just install     # 安装 web/ 与 tools/ 的 npm 依赖
just web         # 构建前端到 web/dist
just release     # release 构建后端
just run         # release 构建并启动（WORKSPACE=... BIND=... just run）
just dev         # debug 构建并启动
just test        # cargo test
just smoke       # 接口冒烟测试
just browser     # 真浏览器测试
just shots       # 重新生成 docs/screenshots
just fmt         # cargo fmt + prettier
just db-up       # 启动本地 PostgreSQL 集群（幂等，缺库时自动 createdb）
just db-down     # 停止本地集群
just db-status   # 看表和用户数
just db-psql     # 连进去手动查
just db-reset    # 丢掉本地集群重建（清空所有用户）
just clean       # 停库 + cargo clean + 删除 web/dist 与 data
```

## 前端体积取舍

首屏只加载入口 chunk（约 1.3MB，gzip 450KB）；Monaco（3.3MB）只有在打开非 Markdown 文件时
才动态 `import()`，Mermaid（约 2.7MB）只有在文档里出现 ```mermaid 代码块时才加载。
`vite.config.js` 里关掉了 `modulePreload`（否则 Vite 会替懒加载 chunk 生成 preload，
浏览器首屏就把它们拉下来），也不再手写 `manualChunks`（手工拆 chunk 容易和懒加载边界
形成循环 chunk 引用，运行时报 `Cannot access 'X' before initialization`）。
