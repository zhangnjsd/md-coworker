# 生产部署与运维

本目录是 md-coworker 的部署资产：systemd 单元、nginx 反向代理片段、备份脚本。
本文说明拓扑、安装、升级、备份恢复与几条**不可绕过的边界**。

| 文件 | 用途 |
| --- | --- |
| `deploy/md-coworker.service` | systemd 单元（前台运行、自动重启、加固项） |
| `deploy/nginx.conf` | `server { }` 片段：TLS 终止 + `/ws` 的 Upgrade + 上传与超时设置 |
| `deploy/backup.sh` | 一次性备份 PostgreSQL + 工作区 + `data/`（含 `master.key`） |
| `deploy/README.md` | 本文 |

---

## 1. 部署拓扑

```text
浏览器（Monaco + Yjs）
      │  HTTPS / WSS
      ▼
nginx（终止 TLS，唯一对外入口）
      │  http://127.0.0.1:3001
      ▼
md-coworker 单进程（systemd 托管）
      ├─ workspace/     用户文档，明文文件，由后端直接读写
      ├─ data/crdt/     Yjs 加密快照（崩溃恢复用）
      ├─ data/master.key  快照加密主密钥（hex，0600）
      └─ PostgreSQL     用户 / 会话 / 挑战 / mfa_tickets / settings
```

### 1.1 三条硬性边界

1. **只能跑一个实例。** 协作房间、presence、广播全部在进程内存里，房间之间靠 broadcast channel 与
   路径写锁协作。因此不支持水平扩容，也不要为了「高可用」起两个副本共享同一个 `workspace/`——
   两个进程各自持有一份房间状态，会把同一份文件写坏。要更高的并发，调大单机资源。
2. **建议部署在独立子域。** 会话 Cookie `mc_sid` 是 `Path=/; HttpOnly; SameSite=Lax`，同源共享。
   若与 WordPress 等同源应用挤在一个域下，任何一处同源 XSS 都能带着这个 Cookie 调用本服务 API
   （`HttpOnly` 只防读取，不防被使用）。用 `cowork.example.com` 这类独立子域可以把风险隔离开。
3. **生产必须自行备份。** 数据分散在三处（工作区明文、`data/` 加密快照、PostgreSQL），
   仓库不提供托管备份服务。请用 `deploy/backup.sh` 做定期备份（见第 9 节）。

### 1.2 为什么需要 TLS 反向代理

程序自身只讲 HTTP，不实现 TLS：默认监听 `127.0.0.1:3000`，对外暴露时请放在 nginx 之后，
并让代理发出 `X-Forwarded-Proto: https`（或给后端加 `--secure-cookies`），
否则会话 Cookie 不会带 `Secure`，会在明文 HTTP 上被回传。

---

## 2. 目录布局与权限

```text
/srv/md-coworker/
  md-coworker          二进制（755，cowork:cowork）
  deploy/              本目录（service / nginx.conf / backup.sh）
  web/dist/            前端构建产物（后端直接从磁盘提供，SPA 回退 index.html）
  workspace/           用户文档（明文，cowork 可读写）
  data/                数据目录（后端会强制设成 0700）
    master.key         快照加密主密钥（0600）
    crdt/              Yjs 加密快照
    tmp/               上传等临时文件（保证进程被中断也不往工作区里留垃圾）
```

`--data` **必须**位于工作区之外，否则后端拒绝启动（主密钥与快照不能通过文件接口被下载）。

```bash
# 专用系统用户（不要用 root 跑）
sudo useradd --system --home /srv/md-coworker --shell /usr/sbin/nologin cowork

# 目录骨架
sudo install -d -o cowork -g cowork -m 750 /srv/md-coworker
sudo install -d -o cowork -g cowork -m 750 /srv/md-coworker/workspace
sudo install -d -o cowork -g cowork -m 700 /srv/md-coworker/data
sudo install -d -o cowork -g cowork -m 755 /srv/md-coworker/web
```

---

## 3. 构建与安装

```bash
git clone <repo> md-coworker && cd md-coworker

# 后端
cargo build --release
sudo install -m 755 target/release/md-coworker /srv/md-coworker/md-coworker

# 前端（产物必须和二进制一起换，见第 8 节升级）
cd web && npm install && npm run build && cd ..
sudo install -d -o cowork -g cowork -m 755 /srv/md-coworker/web/dist
sudo rsync -a --delete web/dist/ /srv/md-coworker/web/dist/

# 部署资产
sudo install -d -o cowork -g cowork -m 750 /srv/md-coworker/deploy
sudo install -m 644 deploy/md-coworker.service deploy/nginx.conf deploy/README.md /srv/md-coworker/deploy/
sudo install -m 755 deploy/backup.sh /srv/md-coworker/deploy/
```

---

## 4. PostgreSQL

可以用任意一个可用的 PostgreSQL（含托管服务），也可以照 `justfile` 里 `db-*` 的方式起一个
**只监听 127.0.0.1:5433、trust 认证、仅供本项目使用**的独立集群。表结构由 `migrations/`
下的版本化迁移在启动时自动应用（`_sqlx_migrations` 记录已应用版本），不需要手工迁移。

```sql
CREATE ROLE md_coworker LOGIN;
CREATE DATABASE md_coworker OWNER md_coworker;
```

连接串通过 `--database-url`、环境变量 `DATABASE_URL` 或默认值（`postgres://md_coworker@127.0.0.1:5433/md_coworker`）
提供。生产建议把带口令的 DSN 放进 `/etc/md-coworker/env`（`chmod 600`，root 可读），
在单元里用 `EnvironmentFile=` 引入，而不是写死在命令行里。

---

## 5. 安装 systemd 单元

```bash
sudo cp deploy/md-coworker.service /etc/systemd/system/
# 改掉占位符：User/Group、WorkingDirectory、ExecStart、ReadWritePaths
sudo systemctl daemon-reload
sudo systemctl enable --now md-coworker
systemctl status md-coworker
journalctl -u md-coworker -f
```

单元里已经设好的关键点：

- `Type=simple`、`Restart=always`、`RestartSec=3`：进程退出即重启。
- `ExecStart=... --bind 127.0.0.1:3001 --secure-cookies`：只监听回环地址，Cookie 恒带 `Secure`。
- `ProtectSystem=strict` + `ReadWritePaths=/srv/md-coworker/workspace /srv/md-coworker/data`：
  整个文件系统只读，只有这两个目录可写。**换路径时这里必须同步改**，否则服务会以 EROFS 失败。
- `PrivateTmp`、`NoNewPrivileges`、`RestrictAddressFamilies`、`SystemCallFilter=@system-service` 等加固项。
- `LimitNOFILE=65536`、`UMask=0077`。

---

## 6. nginx 反向代理

把 `deploy/nginx.conf` 里的 `server { }` 放进 nginx 的 `http { }`，改掉 `server_name` 与证书路径：

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/md-coworker.conf
sudo nginx -t && sudo systemctl reload nginx
```

几处不能省：

| 设置 | 原因 |
| --- | --- |
| `proxy_set_header X-Forwarded-Proto $scheme` | 后端据此给 `mc_sid` 加 `Secure`；漏了 Cookie 会以明文下发 |
| `location /ws` 里的 `Upgrade` / `Connection` 头 | WebSocket 握手必需 |
| `/ws` 的 `proxy_read_timeout 3600s` | presence 心跳约 1s 一次，读超时必须远大于它，否则空闲连接被掐断、前端反复重连 |
| `proxy_request_buffering off` | 上传是流式写入临时文件的，别让 nginx 先缓存整个请求体 |
| `client_max_body_size 32m` | 后端上传上限默认 10 MiB（`settings.max_upload_bytes`，范围 1 KiB–512 MiB）；代理上限必须 ≥ 后端当前设置，否则大文件在反代层就 413 |
| `proxy_set_header Host $host` | `/ws` 握手会校验 `Origin` 与 `Host` 一致 |

**子路径部署**（`https://example.com/cowork/`）：需要给后端加 `--base-path /cowork`
（**需 v0.2 起提供**），并把 `location /` 换成 `location /cowork/` + `proxy_pass http://127.0.0.1:3001/`
（末尾斜杠剥掉前缀），WebSocket 随之变成 `/cowork/ws`，Cookie 的 `Path` 会自动变成 `/cowork`。
`deploy/nginx.conf` 末尾有对应的注释示例。

**前端走 CDN / 由 nginx 直出静态资源**也是可行的（`web/dist` 就是普通静态文件），
但静态域必须与站点同源——本项目没有跨域 API，跨源会拿不到 Cookie。`index.html` 不要设长缓存。

---

## 7. 首次启动与管理员私钥

第一次启动会自动创建 `admin` 账号，把私钥打印在日志里（只出现这一次）并写入
`data/bootstrap-admin.key`：

```bash
journalctl -u md-coworker -n 200 --no-pager     # 找打印私钥的那几行
sudo cat /srv/md-coworker/data/bootstrap-admin.key
```

私钥是带校验码的 `mc1-<base64>-<crc32>` 形式，登录时整段粘贴即可（前端会先校验长度与校验码）。
立刻把它转存到密码管理器，然后用它登录 <https://cowork.example.com>（用户名 `admin` + 私钥），
再在「用户管理」里给真人建号。`admin` 第一次登录成功后服务端会自动删除该文件；如果升级前就有
旧版本留下的副本，也建议手工清掉：

```bash
sudo shred -u /srv/md-coworker/data/bootstrap-admin.key 2>/dev/null || true
```

> 私钥只在客户端用于 Ed25519 签名，服务端只存公钥。`admin` 的私钥丢了就只能重建账号库。

### 健康检查

```bash
curl -fsS http://127.0.0.1:3001/api/health
# {"ok":true,"name":"md-coworker","version":"0.1.1","database":"ok"}
curl -fsS https://cowork.example.com/api/health      # 走一遍 TLS + 反代
```

返回 503 表示数据库不可用（进程活着但连不上 PostgreSQL），其它 `database` 值同理。

---

## 8. 升级

顺序固定：停服务 → 备份 → 换二进制 → 重建前端 → 起服务 → 探活。

```bash
cd /path/to/md-coworker
git fetch --tags
git switch --detach <新版本标签>

# 1) 停服务（在线用户会断线，重连后自动恢复）
sudo systemctl stop md-coworker

# 2) 先备份：升级前的那一份最值钱
sudo -u cowork BACKUP_DIR=/var/backups/md-coworker \
  WORKSPACE_DIR=/srv/md-coworker/workspace \
  DATA_DIR=/srv/md-coworker/data \
  DATABASE_URL='postgres://md_coworker@127.0.0.1:5433/md_coworker' \
  ./deploy/backup.sh

# 3) 后端
cargo build --release
sudo install -m 755 target/release/md-coworker /srv/md-coworker/md-coworker

# 4) 前端（必须与二进制配套）
cd web && npm install && npm run build && cd ..
sudo rsync -a --delete web/dist/ /srv/md-coworker/web/dist/

# 5) 起服务并探活
sudo systemctl start md-coworker
curl -fsS http://127.0.0.1:3001/api/health
```

要点：

- **二进制与 `web/dist` 必须一起换。** 前端资源带内容哈希，只换一半会出现白屏或接口 404。
- 重启不丢内容：编辑按 400ms 防抖落盘，协作房间在内存里但在重连时从 `data/crdt/` 快照恢复。
- 表结构由启动时的 `migrations/*.sql` 迁移保证，已应用的版本记在 `_sqlx_migrations` 里。
  升级前仍请先备份：迁移只做加法，但回滚到旧二进制时新列不会自动消失。
- 新版引入的参数（例如 `--base-path`，**需 v0.2 起提供**）要同步写进单元的 `ExecStart`。
- 回滚 = 装回旧二进制 + 恢复升级前的备份（数据库与 `workspace/`、`data/` 一起回到那个时间点）。

---

## 9. 备份

备份必须同时覆盖三处数据，缺一处就会丢东西：

| 数据 | 内容 | 备份方式 |
| --- | --- | --- |
| `workspace/` | 用户文档（明文） | `tar` |
| `data/` | `master.key` + `crdt/` 加密快照（`pg/`、`tmp/` 不打包） | `tar` |
| PostgreSQL | 用户、会话、挑战、`mfa_tickets`、`settings` | `pg_dump -Fc` |

```bash
cd /srv/md-coworker
sudo -u cowork BACKUP_DIR=/var/backups/md-coworker \
  WORKSPACE_DIR=/srv/md-coworker/workspace \
  DATA_DIR=/srv/md-coworker/data \
  DATABASE_URL='postgres://md_coworker@127.0.0.1:5433/md_coworker' \
  ./deploy/backup.sh
```

产出（文件名带 UTC 时间戳）：

```text
/var/backups/md-coworker/
  md-coworker-db-20261103T030017Z.dump
  md-coworker-workspace-20261103T030017Z.tar.gz
  md-coworker-data-20261103T030017Z.tar.gz
  md-coworker-manifest-20261103T030017Z.txt      # 大小、sha256、master.key 指纹、文件计数
```

定时执行（示例：每天 UTC 03:17）：

```cron
17 3 * * * /srv/md-coworker/deploy/backup.sh >> /var/log/md-coworker-backup.log 2>&1
```

注意事项：

- 把 `BACKUP_DIR` 设到工作区或 `data/` 里面时，脚本会**直接报错退出**（工作区是对外可下载的）。
- `data/pg`（`just db-up` 起的本地集群）与 `data/tmp`（上传临时文件）不会被塞进 tar：
  前者是活的数据库目录、由 `pg_dump` 负责，后者只是可重建的临时垃圾。
- 备份里含 `master.key`，脚本会打印醒目警告。拿到备份 = 能解开全部快照，
  请按机密数据保管，建议 `gpg -c` 加密后异地存放。
- 工作区是明文文档，压缩包不加密，同样按机密对待。
- 数据库是 `-Fc` 自定义格式，恢复用 `pg_restore`，不能直接 `psql -f`。

---

## 10. 恢复

顺序别换：先停服务，再恢复数据库，最后恢复文件。

```bash
# 0) 先停服务，恢复期间不要有写入
sudo systemctl stop md-coworker

# 1) 数据库
pg_restore --clean --if-exists --no-owner \
  -d 'postgres://md_coworker@127.0.0.1:5433/md_coworker' \
  /var/backups/md-coworker/md-coworker-db-20261103T030017Z.dump

# 2) 工作区明文文件（建议先把现有目录挪走留档）
sudo tar -C /srv/md-coworker/workspace -xzf \
  /var/backups/md-coworker/md-coworker-workspace-20261103T030017Z.tar.gz

# 3) data/：master.key 与 crdt/ 必须来自同一次备份
sudo tar -C /srv/md-coworker/data -xzf \
  /var/backups/md-coworker/md-coworker-data-20261103T030017Z.tar.gz

# 4) 权限修回来，再起服务
sudo chown -R cowork:cowork /srv/md-coworker/workspace /srv/md-coworker/data
sudo chmod 700 /srv/md-coworker/data
sudo chmod 600 /srv/md-coworker/data/master.key
sudo systemctl start md-coworker
curl -fsS http://127.0.0.1:3001/api/health
```

关键语义：

- **`master.key` 与 `crdt/` 快照必须配套。** 用另一把主密钥去解这批快照，快照打不开，
  后端会按「该文件没有历史」处理——协作历史（Undo 栈、Yjs 结构）丢失。
- **只恢复工作区明文也能拿回文档内容。** 明文文件是最终真相来源，最坏只丢最后一次
  400ms 防抖窗口内的改动；此时把 `data/crdt/` 清空反而更干净（否则快照与文件内容对不上）。
- 每 400ms 一次落盘意味着运行中直接 `tar` 工作区可能抓到正在写的文件；
  想更严格就在备份时短暂停服务，或接受「最后一瞬可能不完整」这一前提。

---

## 11. 保密：不要把 `data/` 与 `workspace/` 提交或打进镜像

- **不要进 git。** 仓库的 `.gitignore` 已排除 `/data`、`/workspace`、`/backups`；
  新增部署目录时（比如把 `data/` 挪到仓库里）务必同步加排除规则。
  `workspace/` 是用户文档，`data/` 里是主密钥与可解密快照，两者泄露都等于数据泄露。
- **不要进公开镜像层。** Dockerfile 里 `COPY . .` 会把它们带进层；即使后续 `RUN rm` 删除，
  层里依然留着可被拉取的字节。用 `.dockerignore` 排除，或干脆挂载卷。
  CI 缓存、构建产物归档同理。
- **不要在工单、日志、截图里贴 `master.key` 或 `bootstrap-admin.key`。**
- 权限基线：`data/` 0700、`master.key` 0600、服务用户非 root、`UMask=0077`。

---

## 12. 排错

| 现象 | 常见原因 |
| --- | --- |
| 服务起不来，日志报 EROFS / 无法写入 | `ProtectSystem=strict` 下没在 `ReadWritePaths` 放行 workspace 与 data |
| 启动即退出，提示 `--data` 必须放在工作区之外 | `--data` 指向了工作区内部，改路径 |
| 上传大文件 413 | 反代 `client_max_body_size` 小于后端 `settings.max_upload_bytes` |
| WebSocket 反复重连 / 显示离线 | `/ws` 缺 `Upgrade` 头，或 `proxy_read_timeout` 太短 |
| 登录后立刻掉登录 | 反代没发 `X-Forwarded-Proto: https` 且后端没 `--secure-cookies` |
| `curl /api/health` 返回 503 | PostgreSQL 不可用（进程在、数据库连不上） |
| 两个标签页内容互相覆盖、文件被写坏 | 起了多个实例共享同一 `workspace/`，回到单实例 |
| 恢复后没有 Undo 历史 | `data/crdt/` 与 `master.key` 不配套，或只恢复了工作区 |
