# md-coworker 接口协议

本文件是前端（`web/`）与后端（`src/`）之间唯一的接口约定，描述 HTTP API、WebSocket 协作
通道以及双方共享的数据格式与限制。协议变更必须同时更新本文件与两侧实现。

- 适用版本：`0.1.1`
- 传输：HTTP/1.1 与 WebSocket，同源部署
- 认证：会话 Cookie `mc_sid`，服务端只保存其 SHA-256 摘要

## 0. 通用约定

### 0.1 路径

`path` 是工作区内的相对路径，采用 POSIX 形式：`/` 分隔、无前导 `/`、不含空字符，且不得
出现 `..` 段。重复的 `/`、尾随 `/` 与 `.` 段属于等价写法，服务端会先折叠再处理；含 `..` 段
或非法字符的路径返回 `400 bad_path`。工作区根目录以空字符串 `""` 表示，且不出现在文件树中。

以 `.` 开头的路径段（隐藏文件与隐藏目录）对 `path` 类接口一律拒绝，返回 `400 bad_path`；
文件树与协作通道同样不暴露隐藏项。

### 0.2 JSON

请求与响应体均为 UTF-8 JSON。除上传外，所有带请求体的接口要求
`Content-Type: application/json`。

时间字段：`mtime` 与 `ts` 为 Unix 毫秒整数，`created_at` 为 RFC 3339 字符串。

### 0.3 错误

非 2xx 响应体统一为：

```json
{ "error": { "code": "bad_path", "message": "路径包含非法字符" } }
```

`code` 供程序判断，`message` 是可直接展示的中文说明。完整错误码见第 9 节。

### 0.4 用户对象

```json
{
  "id": "3f2a…",
  "username": "alice",
  "role": "user",
  "color": "#4f9cf9",
  "twofa_enabled": false,
  "created_at": "2026-01-01T00:00:00Z"
}
```

`role` 为 `admin` 或 `user`；`color` 是服务端分配的展示色（`#rrggbb`）。管理员用户列表额外
返回 `online`（布尔）。用户名规则为 `^[A-Za-z0-9_-]{2,32}$`，比较时不区分大小写。

## 1. 认证

密钥体系为 Ed25519。用户私钥是 32 字节 seed 的 Base64（44 字符），公钥是 32 字节 Base64。
客户端用 `nacl.sign.detached(nonce, secretKey)` 生成签名，服务端用登记的公钥验签。私钥只保存
在浏览器，服务端从不持有。

会话 Cookie `mc_sid` 的属性为 `HttpOnly; SameSite=Lax; Path=/; Max-Age=<会话有效期>`；
当请求带 `X-Forwarded-Proto: https` 或服务端以 `--secure-cookies` 启动时追加 `Secure`。
默认有效期 7 天。退出登录或重置密钥后旧令牌立即失效。

### 1.1 获取挑战

```
POST /api/auth/challenge
{ "username": "alice" }
```

```json
{ "challenge_id": "…", "nonce": "<base64>", "expires_in": 120, "has_2fa": true }
```

`nonce` 为 32 字节随机数，挑战 120 秒有效且一次性使用。`has_2fa` 用于让登录界面提前提示
第二因子，除「是否启用 2FA」外不泄露其他信息。

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `bad_request` | 用户名为空 |
| 404 | `unknown_user` | 用户不存在（同样计入该用户名的失败次数） |
| 429 | `rate_limited` | 触发限流，响应带 `Retry-After` |

### 1.2 登录

```
POST /api/auth/login
{ "challenge_id": "…", "signature": "<base64>" }
```

第一因子通过且账号未启用 2FA 时下发会话 Cookie：

```json
{ "status": "ok", "user": { … } }
```

启用 2FA 时不下发 Cookie，改为返回 300 秒有效的一次性票据：

```json
{ "status": "mfa_required", "ticket": "…" }
```

| 状态 | code | 说明 |
| --- | --- | --- |
| 401 | `challenge_expired` | 挑战不存在、已使用或已过期 |
| 401 | `unknown_user` | 挑战对应的用户已被删除 |
| 401 | `bad_signature` | 签名校验失败 |
| 429 | `rate_limited` | 触发限流，响应带 `Retry-After` |

### 1.3 第二因子

```
POST /api/auth/mfa
{ "ticket": "…", "code": "123456" }
```

成功返回 `{ "status": "ok", "user": { … } }` 并下发会话 Cookie。同一票据连续 5 次验证失败
即作废，需重新登录。

| 状态 | code | 说明 |
| --- | --- | --- |
| 401 | `mfa_expired` | 票据不存在、已作废或已过期 |
| 400 | `bad_totp` | 验证码不正确 |
| 429 | `rate_limited` | 触发限流，响应带 `Retry-After` |

### 1.4 退出与当前用户

| 接口 | 响应 |
| --- | --- |
| `POST /api/auth/logout` | `{ "ok": true }`，同时清除 Cookie 并删除会话 |
| `GET /api/me` | `{ "user": { … } }` |

未认证访问任一受保护接口返回 `401 unauthorized`。

### 1.5 限流

| 对象 | 限额 |
| --- | --- |
| 同一用户名的认证失败（`/challenge` 命中未知用户、`/login` 验签失败、`/mfa` 验证码错误、需验证码的 2FA 操作） | 10 次 / 60 秒 |
| `/api/auth/challenge` 全局 | 60 次 / 60 秒 |
| 已登录后的动态验证码校验 | 10 次 / 60 秒 |

超限统一返回 `429 rate_limited` 并带 `Retry-After`（秒）。

## 2. 账户自服务

以下接口均需登录，且只作用于调用者本人。

| 接口 | 请求体 | 响应 |
| --- | --- | --- |
| `POST /api/me/keypair` | `{ "totp": "123456" }`（可选） | `{ "private_key", "public_key" }` |
| `POST /api/me/2fa/setup` | — | `{ "secret", "otpauth_url" }` |
| `POST /api/me/2fa/enable` | `{ "code": "123456" }` | `{ "user": { … } }` |
| `POST /api/me/2fa/disable` | `{ "code": "123456" }` | `{ "user": { … } }` |

`POST /api/me/keypair` 立即作废旧公钥，并吊销除当前会话外的全部会话；新私钥只在该响应中出现
一次。启用 2FA 的账号必须随请求提交 `totp`。

`POST /api/me/2fa/setup` 生成并加密保存新的 TOTP 种子，返回 Base32 种子与 `otpauth://` 链接；
此时 2FA 尚未启用，账号仍为未启用状态直到 `enable` 成功。

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `mfa_required` | 账号已启用 2FA，但请求缺少 `totp` |
| 400 | `bad_totp` | 验证码不正确 |
| 400 | `totp_missing` | 账号没有可用种子（尚未 setup 或已被重置） |
| 400 | `totp_disabled` | 账号当前未启用 2FA |
| 409 | `totp_enabled` | 账号已启用 2FA |

## 3. 管理员

以下接口要求 `role = admin`，否则返回 `403 forbidden`。

| 接口 | 请求体 | 响应 |
| --- | --- | --- |
| `GET /api/admin/users` | — | `{ "users": [ … ] }`，含 `online` |
| `POST /api/admin/users` | `{ "username", "role" }` | `{ "user", "private_key", "public_key" }` |
| `POST /api/admin/users/{id}/keypair` | — | `{ "private_key", "public_key" }` |
| `PATCH /api/admin/users/{id}` | `{ "role"?, "twofa_enabled"? }` | `{ "user": { … } }` |
| `DELETE /api/admin/users/{id}` | — | `{ "ok": true }` |

- 创建用户时服务端生成密钥对，私钥仅在该响应中出现一次。
- `role` 变更受「至少保留一个管理员」约束。
- `twofa_enabled` 只接受 `false`：管理员可强制关闭他人的 2FA（种子一并清除）；传 `true`
  返回 `400 bad_request`，启用 2FA 只能由用户本人完成。
- 重置他人密钥会吊销其全部会话。

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `bad_username` | 用户名不符合规则 |
| 400 | `bad_role` | 角色不是 `admin` 或 `user` |
| 400 | `self_delete` | 不能删除自己 |
| 400 | `last_admin` | 操作会使系统失去唯一的管理员 |
| 404 | `unknown_user` | 目标用户不存在 |
| 409 | `user_exists` | 用户名已被占用 |

### 3.1 上传上限

| 接口 | 权限 | 响应 |
| --- | --- | --- |
| `GET /api/settings` | 登录 | `{ "max_upload_bytes": 10485760 }` |
| `GET /api/admin/settings` | 管理员 | `{ "settings": { "max_upload_bytes": … } }` |
| `PATCH /api/admin/settings` | 管理员 | 同上 |

`max_upload_bytes` 默认 10485760（10 MiB），允许范围 1024 … 536870912（1 KiB … 512 MiB）。
越界返回 `400 bad_limit`，请求体缺少该字段返回 `400 bad_request`。

## 4. 文件与目录

### 4.1 文件树

```
GET /api/files
```

```json
{
  "tree": [
    { "name": "notes", "path": "notes", "kind": "dir", "size": 0, "mtime": 0,
      "children": [ … ] },
    { "name": "README.md", "path": "README.md", "kind": "file",
      "size": 812, "mtime": 1762000000000 }
  ]
}
```

- 同级条目按名称排序，目录在前。
- `kind` 为 `dir` 或 `file`；`children` 只出现在目录节点上。
- 跳过隐藏项、符号链接，以及 `node_modules`、`target` 目录。
- 递归深度上限 12 层，条目上限 5000；超出部分静默截断，并在服务端记录一条警告。

### 4.2 读取文件

```
GET /api/file?path=notes/a.md
```

```json
{ "path": "notes/a.md", "content": "…", "size": 812,
  "lang": "markdown", "mtime": 1762000000000 }
```

`lang` 由扩展名推断（如 `markdown`、`rust`，未知为 `plaintext`）。

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `bad_path` | 缺少 `path` 或路径非法 |
| 400 | `not_a_file` | 目标是目录 |
| 404 | `file_not_found` | 文件不存在 |
| 413 | `too_large` | 超过 100 MiB |
| 415 | `unsupported_media` | 内容不是 UTF-8 文本 |

### 4.3 新建、改名与删除

| 接口 | 请求体 | 响应 |
| --- | --- | --- |
| `POST /api/files` | `{ "path", "kind": "file" \| "dir", "content"? }` | `{ "path": … }` |
| `POST /api/files/rename` | `{ "from", "to" }` | `{ "path": <to> }` |
| `POST /api/files/delete` | `{ "path" }` | `{ "ok": true }` |

- `kind` 缺省为 `file`。
- `rename` 同时用于移动文件或目录，并自动创建目标端的父目录。
- `delete` 对目录执行递归删除。
- 任一改动都会清理受影响的 CRDT 快照，被删除的内容不会在下次打开时由残留快照恢复。

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `bad_path` | 路径非法，或把目录移动到自身/自身子目录 |
| 400 | `bad_request` | `kind` 不是 `file`/`dir` |
| 404 | `file_not_found` | 源路径不存在 |
| 409 | `file_exists` | 目标已存在 |
| 409 | `file_busy` | 目标或其子路径正在被协作编辑 |

## 5. 上传与原始资源

### 5.1 上传

```
POST /api/files/upload?dir=assets&overwrite=0
Content-Type: multipart/form-data
```

表单字段名固定为 `file`，一次请求最多 20 个文件。`dir` 是目标目录（缺省为工作区根目录，
不存在时自动创建）；`overwrite` 取 `1`/`true`/`yes` 时覆盖同名文件。

文件名取客户端提交文件名的最后一段，需满足：非空、不以 `.` 开头、不含空字符与路径分隔符、
不超过 200 字节。同名文件在未开启覆盖时返回 `409 file_exists`。

响应 `201`：

```json
{
  "dir": "assets",
  "files": [
    { "path": "assets/a.png", "size": 1024, "kind": "image",
      "url": "/api/raw?path=assets%2Fa.png" }
  ]
}
```

`kind` 由扩展名判定：`image`（png/jpg/jpeg/gif/webp/avif/bmp/ico/svg）、`text`（常见文本与
源码扩展名），其余为 `other`。

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `bad_filename` | 文件名为空、隐藏或含非法字符 |
| 400 | `bad_multipart` | 请求体不是合法的 multipart |
| 400 | `bad_path` | `dir` 指向已存在的文件 |
| 400 | `no_files` | 请求里没有任何文件 |
| 400 | `too_many_files` | 超过 20 个文件 |
| 400 | `not_a_file` | 目标路径是同名目录 |
| 409 | `file_exists` | 同名文件已存在且未开启覆盖 |
| 409 | `file_busy` | 目标文件正在被协作编辑 |
| 413 | `too_large` | 单个文件超过 `max_upload_bytes` |

超限或中断的上传不会留下临时文件。上传不经过 CRDT，直接落盘。

### 5.2 原始字节

```
GET /api/raw?path=assets/a.png
```

响应为文件字节，头部固定包含：

| 头 | 值 |
| --- | --- |
| `Content-Type` | 先按扩展名推断，再按内容嗅探，均无法识别时为 `application/octet-stream` |
| `Content-Disposition` | 图片、PDF 与文本为 `inline`，其余为 `attachment` |
| `X-Content-Type-Options` | `nosniff` |
| `Cache-Control` | `private, max-age=60` |
| `x-file-mtime` | 文件修改时间（Unix 毫秒），供前端判断缓存是否过期 |

`image/svg+xml` 额外带
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`。

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `bad_path` | 缺少 `path` 或路径非法 |
| 400 | `not_a_file` | 目标是目录 |
| 404 | `file_not_found` | 文件不存在 |
| 413 | `too_large` | 超过 100 MiB |

## 6. 实时协作

### 6.1 握手

```
GET /ws   (Upgrade: websocket)
```

认证沿用会话 Cookie。握手同时校验 `Origin`：缺失时放行；存在时必须与 `Host` 的主机名与端口
一致，scheme 只能是 `http`/`https`/`ws`/`wss`，否则返回 `403 forbidden_origin`。

连接建立后每 30 秒复验一次会话，失效时服务端发送 `error` 帧并关闭连接。

一条连接可以加入多个文档房间。所有帧都是 JSON 文本帧，二进制帧不支持（收到即回 `error`
帧）。Yjs 数据以标准 Base64 携带。

### 6.2 客户端帧

| `t` | 字段 | 说明 |
| --- | --- | --- |
| `join` | `path` | 加入文档房间，幂等；成功后收到 `init` |
| `leave` | `path` | 离开房间 |
| `update` | `path`, `update` | Yjs 增量更新（Base64），必须先 `join` |
| `awareness` | `path`, `update` | 光标共享状态（Base64），必须先 `join`；服务端只中继不解析 |
| `presence` | `path?`, `cursor?`, `selection?` | 上报所在文档与光标；`path` 缺省表示保持原值，`""` 表示已不编辑任何文档 |
| `ping` | — | 保活，回 `pong` |

`cursor` 为 `{ "line": 0, "ch": 0 }`（均从 0 开始）；`selection` 为当前选中的字符数，无选中
时为 0。

### 6.3 服务端帧

| `t` | 字段 | 说明 |
| --- | --- | --- |
| `init` | `path`, `update`, `peers` | 加入成功；`update` 是文档的完整状态更新，用 `Y.applyUpdate` 应用即可，无需同步步骤。连接级重同步时额外带 `"resync": true` |
| `update` | `path`, `update`, `user` | 其他成员的更新，`user` 为用户名；不回显给发送者 |
| `awareness` | `path`, `update` | 其他成员的光标状态；不回显给发送者 |
| `peers` | `path`, `count` | 房间成员数变化 |
| `saved` | `path`, `ts` | 已写入磁盘，`ts` 为毫秒时间戳 |
| `presence` | `users` | 全局在线状态，约每秒或在变化时推送；空列表表示无人在线 |
| `error` | `message` | 操作失败，`message` 可直接展示 |
| `pong` | — | 对 `ping` 的回应 |

`users` 的元素为：

```json
{
  "id": "3f2a…", "username": "alice", "color": "#4f9cf9",
  "path": "notes/a.md", "cursor": { "line": 12, "ch": 4 },
  "selection": 7, "last_seen": 1762000000000
}
```

同一用户的多标签页只出现一次（取最近心跳）；未打开任何文档时 `path` 与 `cursor` 为 `null`；
30 秒无心跳的用户从列表中移除。

未加入房间时发送 `update` 会收到 `error` 帧且不会被应用，发送 `awareness` 则被静默忽略。加入
房间失败（目标被删除、不是文件、正在被重命名或删除）同样通过 `error` 帧返回。未知的 `t` 静默
忽略。

### 6.4 Yjs 约定

- 文档根类型为 `Y.Text`，名为 `content`，即前端取 `doc.getText("content")`。
- 本地编辑的 origin 为 `null`，远端应用的更新使用 `"remote"`；撤销管理器只跟踪 `null`。
- 服务端为每个房间维护一份 `Y.Doc`，成员数归零后房间被回收。

### 6.5 落盘

房间内容在首次改动后以 400 毫秒防抖写入磁盘：先写临时文件再原子重命名，成功后广播 `saved`。
房间清空与进程退出时立即落盘；写盘失败会保留脏标记并在下一个周期重试。

同时在 `data/crdt/` 维护加密快照，用于服务重启后恢复尚未落盘的内容；快照比磁盘文件旧时视为
过期并丢弃。

## 7. 静态资源与前端路由

后端从 `web/dist` 提供前端产物，未命中的路径回退到 `index.html`（SPA 回退）。前端使用 hash
路由：`#/login`、`#/app`、`#/admin`。

所有响应都带基线安全头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、
`Referrer-Policy: no-referrer`、`Cross-Origin-Opener-Policy: same-origin`，以及一份内容安全策略
（`style-src` 允许 `'unsafe-inline'`，`worker-src` 允许 `blob:`，`connect-src` 允许 `ws:`/`wss:`，
以满足 KaTeX、Mermaid 与 Monaco 的需要）。

## 8. 健康检查

```
GET /api/health
```

```json
{ "ok": true, "name": "md-coworker", "version": "0.1.1", "database": "ok" }
```

数据库不可达时返回 `503`，其中 `ok` 为 `false`、`database` 为 `"unavailable"`。

## 9. 错误码

| code | 典型状态 | 含义 |
| --- | --- | --- |
| `bad_request` | 400 | 请求体字段缺失或取值不允许 |
| `bad_path` | 400 | 路径非法、缺失或指向不允许的位置 |
| `bad_filename` | 400 | 上传文件名非法 |
| `bad_multipart` | 400 | 上传请求体不是合法 multipart |
| `bad_username` | 400 | 用户名不符合规则 |
| `bad_role` | 400 | 角色取值非法 |
| `bad_limit` | 400 | 上传上限超出允许范围 |
| `bad_signature` | 401 | 签名与登记的公钥不匹配 |
| `bad_totp` | 400 | 动态验证码不正确 |
| `challenge_expired` | 401 | 登录挑战已过期或已被使用 |
| `file_busy` | 409 | 目标正在被协作编辑或加锁 |
| `file_exists` | 409 | 目标已存在 |
| `file_not_found` | 404 | 文件不存在 |
| `forbidden` | 403 | 权限不足 |
| `forbidden_origin` | 403 | WebSocket 握手的 Origin 校验失败 |
| `internal_error` | 500 | 服务端内部错误，详情只进日志 |
| `last_admin` | 400 | 操作会使系统失去唯一管理员 |
| `mfa_expired` | 401 | 二次验证票据已过期或作废 |
| `mfa_required` | 400 | 该操作需要当前动态验证码 |
| `no_files` | 400 | 上传请求不含文件 |
| `not_a_file` | 400 | 目标不是文件 |
| `rate_limited` | 429 | 触发限流，响应带 `Retry-After` |
| `self_delete` | 400 | 不能删除自己 |
| `too_large` | 413 | 超过读取或上传上限 |
| `too_many_files` | 400 | 单次上传文件数超限 |
| `totp_disabled` | 400 | 账号未启用 2FA |
| `totp_enabled` | 409 | 账号已启用 2FA |
| `totp_missing` | 400 | 账号没有可用 TOTP 种子 |
| `unauthorized` | 401 | 未登录或会话已失效 |
| `unknown_user` | 404 | 用户不存在 |
| `unsupported_media` | 415 | 内容不是 UTF-8 文本 |
| `user_exists` | 409 | 用户名已被占用 |

## 10. 常量

| 名称 | 值 |
| --- | --- |
| 默认会话有效期 | 604800 秒 |
| `COOKIE_NAME` | `mc_sid` |
| `CHALLENGE_TTL_SECS` | 120 |
| `MFA_TICKET_TTL_SECS` | 300 |
| `MFA_MAX_ATTEMPTS` | 5 |
| `AUTH_MAX_FAILURES` | 10 次 / 60 秒（按用户名） |
| `CHALLENGE_MAX_REQUESTS` | 60 次 / 60 秒（进程级） |
| `MAX_READ_BYTES` | 104857600（100 MiB） |
| `MAX_TREE_DEPTH` | 12 |
| `MAX_TREE_ENTRIES` | 5000 |
| `MAX_FILES_PER_REQUEST` | 20 |
| `MAX_FILENAME_BYTES` | 200 |
| `max_upload_bytes` 默认值 / 范围 | 10485760 / 1024 … 536870912 |
| `FLUSH_INTERVAL` | 400 毫秒 |
| `PRESENCE_INTERVAL` | 1 秒 |
| `PRESENCE_TTL_MS` | 30000 |
| WebSocket 会话复验间隔 | 30 秒 |
| 路径写锁超时 | 5 秒 |
