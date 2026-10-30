# md-coworker 接口契约（前后端冻结版 v1）

> 本文件是前端与后端之间**唯一**的接口约定。任何一方改动都必须先改本文件。
> 所有 HTTP 接口返回 JSON（除静态资源）；所有 HTTP 错误返回
> `{"error":{"code":"...","message":"..."}}` 且带对应 HTTP 状态码。
> 认证：登录成功后服务端下发 HttpOnly Cookie `mc_sid`，之后所有 `/api/*` 与 `/ws`
> 都靠该 Cookie 认证；未登录返回 `401 {"error":{"code":"unauthorized"}}`。
> 前端检测到 401 一律回到登录视图。

## 0. 关键概念

- **工作区目录**：后端启动参数 `argv[1]`，例如 `./md-coworker ./workspace`。
  所有文件 `path` 都是**相对工作区根目录的 POSIX 路径**（`/` 分隔，无前导 `/`，
  不允许 `..`），例如 `notes/a.md`。
- **用户名**：`^[a-zA-Z0-9_-]{2,32}$`，唯一，不区分大小写（统一以小写存比对）。
- **用户角色**：`"admin"` | `"user"`。首个启动时自动创建 `admin` 管理员账号并**在
  stdout 打印一次**其私钥（见 README）。
- **用户对象** `User`：
  ```json
  {"id":"uuid","username":"alice","role":"user","color":"#4f9cf9",
   "twofa_enabled":false,"created_at":"2026-10-30T12:00:00Z","online":false}
  ```
  `online` 仅管理员列表返回，其余场景可省略。

## 1. 认证（密钥对 + 可选 TOTP 2FA，无密码）

私钥格式：**32 字节 Ed25519 seed 的 base64**（44 字符）。公钥：32 字节 base64。
用户端用 `tweetnacl` 的 `nacl.sign.keyPair.fromSeed(seed)` 还原密钥对，
用 `nacl.sign.detached(nonceBytes, keyPair.secretKey)` 生成 64 字节签名。
私钥只在前端 `localStorage`（`mc.key.<username>`）保存。

1. `POST /api/auth/challenge`
   ```json
   {"username":"alice"}
   ```
   → `200 {"challenge_id":"uuid","nonce":"<base64 32B>","expires_in":120}`
   未知用户返回 `404 {"error":{"code":"unknown_user"}}`。

2. `POST /api/auth/login`
   ```json
   {"challenge_id":"uuid","signature":"<base64 64B>"}
   ```
   → 无 2FA：`200 {"status":"ok","user":User}`（并 `Set-Cookie: mc_sid=...`）
   → 有 2FA：`200 {"status":"mfa_required","ticket":"uuid"}`（ticket 5 分钟有效）
   → 签名错误：`401 {"error":{"code":"bad_signature"}}`

3. `POST /api/auth/mfa`
   ```json
   {"ticket":"uuid","code":"123456"}
   ```
   → `200 {"status":"ok","user":User}`（并下发 Cookie）；验证码错误 `401 bad_totp`。

4. `POST /api/auth/logout` → `200 {"ok":true}`（清 Cookie）

5. `GET /api/me` → `200 {"user":User}` / `401`

## 2. 账号自服务

- `POST /api/me/keypair` （重新生成自己的密钥对，旧公钥立即失效）
  → `200 {"private_key":"<base64 32B>","public_key":"<base64 32B>"}`
  前端拿到后立刻覆盖 `localStorage.mc.key.<username>`。
- `POST /api/me/2fa/setup` → `200 {"secret":"<base32>","otpauth_url":"otpauth://totp/..."}`
  （尚未启用，前端用 `qrcode` 渲染二维码 / 展示 secret）
- `POST /api/me/2fa/enable` `{"code":"123456"}` → `200 {"user":User}`（twofa_enabled=true）
- `POST /api/me/2fa/disable` `{"code":"123456"}` → `200 {"user":User}`

## 3. 管理员（role=admin，否则 403 forbidden）

- `GET /api/admin/users` → `200 {"users":[User...]}`
- `POST /api/admin/users` `{"username":"bob","role":"user"}`
  → `200 {"user":User,"private_key":"<base64>","public_key":"<base64>"}`
  **私钥仅此一次返回**，前端必须让管理员复制/下载。
  重名 → `409 {"error":{"code":"user_exists"}}`。
- `POST /api/admin/users/{id}/keypair` → 同上（重置他人密钥对）
- `PATCH /api/admin/users/{id}` `{"role":"admin","twofa_enabled":false}`（字段皆可选）
  → `200 {"user":User}`；`twofa_enabled:false` 表示管理员强制重置 2FA。
- `DELETE /api/admin/users/{id}` → `200 {"ok":true}`（不能删除自己）

## 4. 文件与目录

- `GET /api/files` → `200 {"root":"<工作区绝对路径>","tree":[Node...]}`
  ```json
  {"name":"notes","path":"notes","kind":"dir","mtime":1690000000000,
   "children":[{"name":"a.md","path":"notes/a.md","kind":"file","size":123,"mtime":1690000000000}]}
  ```
  目录在前、按名称排序；忽略以 `.` 开头的隐藏项与 `node_modules`、`target`。
- `GET /api/file?path=notes/a.md` → `200 {"path":"notes/a.md","content":"...","size":123,"lang":"markdown"}`
  （非 UTF-8 / 二进制 → `415 {"error":{"code":"unsupported_media"}}`）
- `POST /api/files` `{"path":"notes/b.md","kind":"file"|"dir","content":"# hi"}`
  → `200 {"path":"notes/b.md"}`；已存在 `409 file_exists`。
- `POST /api/files/rename` `{"from":"notes/b.md","to":"notes/c.md"}` → `200 {"path":"notes/c.md"}`
- `POST /api/files/delete` `{"path":"notes/c.md"}` → `200 {"ok":true}`

## 5. 实时协作 WebSocket

`GET /ws`（Upgrade，Cookie 认证，失败回 401）。**一条连接可同时加入多个文档**。
所有帧为 JSON 文本帧，二进制载荷一律 base64 字符串。

### 客户端 → 服务端

| 帧 | 说明 |
| --- | --- |
| `{"t":"join","path":"notes/a.md"}` | 加入文档房间；服务端回 `init` |
| `{"t":"leave","path":"notes/a.md"}` | 离开文档房间 |
| `{"t":"update","path":"notes/a.md","update":"<b64 Yjs update>"}` | 本地增量更新（`Y.encodeStateAsUpdate` 全量亦可） |
| `{"t":"awareness","path":"notes/a.md","update":"<b64>"}` | `encodeAwarenessUpdate` 字节，服务端原样转发给同房间其他人 |
| `{"t":"presence","path":"notes/a.md","cursor":{"line":12,"ch":4},"selection":3}` | 上报自己当前所在文件与光标（行/列从 0 开始），`selection` 为选中字符数 |
| `{"t":"ping"}` | 心跳，回 `{"t":"pong"}` |

### 服务端 → 客户端

| 帧 | 说明 |
| --- | --- |
| `{"t":"init","path":"notes/a.md","update":"<b64>"}` | 该文档的完整 CRDT 状态（客户端 `Y.applyUpdate(doc, bytes, 'remote')`） |
| `{"t":"update","path":"notes/a.md","update":"<b64>","user":"<userId>"}` | 他人（或自己其他标签页）的更新；`user` 为来源用户名（服务端已按连接去重，正常不会回显给自己） |
| `{"t":"awareness","path":"notes/a.md","update":"<b64>","user":"<userId>"}` | 他人 awareness 更新 |
| `{"t":"peers","path":"notes/a.md","count":3}` | 房间在线人数变化 |
| `{"t":"saved","path":"notes/a.md","ts":1690000000000}` | 已落盘（前端显示"已保存"） |
| `{"t":"presence","users":[PresenceUser...]}` | 全站在线状况快照，每 ~1s 或变化时推送 |
| `{"t":"error","message":"..."}` | 错误提示（不断开连接） |

`PresenceUser`：
```json
{"id":"uuid","username":"alice","color":"#4f9cf9","path":"notes/a.md",
 "cursor":{"line":12,"ch":4},"selection":3,"last_seen":1690000000000}
```
在线但未打开任何文件时 `path` 为 `null`、`cursor` 为 `null`。

### Yjs 约定

- 每个文档固定一个根类型：`Y.Text`，名字 **`content`**。
- 服务端持有权威副本并负责把文本实时写回磁盘文件。
- 客户端本地事务 origin 为 `null` 时才是"自己的编辑"；应用远端更新时 origin 传
  `'remote'`，从而 `Y.UndoManager`（只跟踪 `null` origin）天然实现"只能撤回自己的编辑"。

## 6. 静态资源

- 后端从 `web/dist` 提供前端构建产物：`/` → `index.html`，其余按路径读取，
  找不到时回退 `index.html`（SPA）。前端用 hash 路由：`#/login`、`#/app`、`#/admin`。
- 前端构建：`cd web && npm install && npm run build`，产物输出到 `web/dist`。

## 7. 其他

- `GET /api/health` → `200 {"ok":true,"version":"0.1.0"}`
- 时间戳统一为毫秒整数（`mtime`, `ts`）或 RFC3339 字符串（`created_at`）。
- 所有 mutating 请求要求 `Content-Type: application/json`。
