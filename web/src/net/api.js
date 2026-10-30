// HTTP client for the md-coworker backend (see docs/protocol.md).
// Every call is cookie authenticated; any 401 outside the auth endpoints
// clears the client state and sends the user back to #/login.

const CODE_MESSAGES = {
  unauthorized: '登录状态已失效，请重新登录',
  unknown_user: '用户不存在',
  bad_signature: '签名校验失败：私钥与该用户名不匹配',
  bad_totp: '验证码错误或已过期',
  forbidden: '没有权限执行该操作',
  user_exists: '用户名已存在',
  not_found: '资源不存在',
  file_exists: '同名文件或目录已存在',
  unsupported_media: '该文件不是 UTF-8 文本，无法在编辑器中打开',
  invalid_path: '路径不合法（不允许绝对路径或 ..）',
  bad_request: '请求参数不正确',
  internal: '服务端内部错误',
  network_error: '无法连接服务端，请确认后端已启动',
}

const STATUS_MESSAGES = {
  400: '请求参数不正确',
  401: '登录状态已失效，请重新登录',
  403: '没有权限执行该操作',
  404: '资源不存在',
  409: '操作冲突：目标已存在',
  415: '该文件不是 UTF-8 文本，无法在编辑器中打开',
  500: '服务端内部错误',
  502: '网关错误',
  503: '服务暂不可用',
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || CODE_MESSAGES[code] || STATUS_MESSAGES[status] || `请求失败（HTTP ${status}）`)
    this.name = 'ApiError'
    this.status = status
    this.code = code || 'http_error'
  }
}

let onUnauthorized = null
let unauthorizedFired = false

/** @param {null | (() => void)} fn */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
  unauthorizedFired = false
}

export function resetUnauthorizedGuard() {
  unauthorizedFired = false
}

function handleUnauthorized() {
  if (unauthorizedFired) return
  unauthorizedFired = true
  try {
    onUnauthorized && onUnauthorized()
  } finally {
    setTimeout(() => {
      unauthorizedFired = false
    }, 1500)
  }
}

async function request(method, url, body) {
  /** @type {RequestInit} */
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(url, init)
  } catch {
    throw new ApiError(0, 'network_error', CODE_MESSAGES.network_error)
  }

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!res.ok) {
    const err = (data && data.error) || {}
    const error = new ApiError(
      res.status,
      err.code || 'http_error',
      err.message ? mapServerMessage(err.code, err.message) : undefined,
    )
    const isAuthEndpoint = url.startsWith('/api/auth/')
    if (res.status === 401 && !isAuthEndpoint) handleUnauthorized()
    throw error
  }

  return data
}

function mapServerMessage(code, message) {
  // Prefer the localized client copy for well known codes so the UI stays Chinese.
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  return message
}

const post = (url, body) => request('POST', url, body === undefined ? {} : body)

export const api = {
  // --- auth ---
  challenge: (username) => post('/api/auth/challenge', { username }),
  login: (challenge_id, signature) => post('/api/auth/login', { challenge_id, signature }),
  mfa: (ticket, code) => post('/api/auth/mfa', { ticket, code }),
  logout: () => post('/api/auth/logout', {}),
  me: () => request('GET', '/api/me'),

  // --- account self service ---
  regenerateKeypair: () => post('/api/me/keypair', {}),
  setup2fa: () => post('/api/me/2fa/setup', {}),
  enable2fa: (code) => post('/api/me/2fa/enable', { code }),
  disable2fa: (code) => post('/api/me/2fa/disable', { code }),

  // --- admin ---
  adminUsers: () => request('GET', '/api/admin/users'),
  adminCreateUser: (username, role) => post('/api/admin/users', { username, role }),
  adminResetKeypair: (id) => post(`/api/admin/users/${encodeURIComponent(id)}/keypair`, {}),
  adminPatchUser: (id, patch) => request('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, patch),
  adminDeleteUser: (id) => request('DELETE', `/api/admin/users/${encodeURIComponent(id)}`),

  // --- files ---
  files: () => request('GET', '/api/files'),
  file: (path) => request('GET', `/api/file?path=${encodeURIComponent(path)}`),
  createEntry: (path, kind, content = '') => post('/api/files', { path, kind, content }),
  renameEntry: (from, to) => post('/api/files/rename', { from, to }),
  deleteEntry: (path) => post('/api/files/delete', { path }),

  health: () => request('GET', '/api/health'),
}

/** localStorage key holding the Ed25519 seed of a user. */
export function keyStorageKey(username) {
  return `mc.key.${String(username || '').trim().toLowerCase()}`
}

export function loadStoredKey(username) {
  try {
    return localStorage.getItem(keyStorageKey(username)) || ''
  } catch {
    return ''
  }
}

export function storeKey(username, seedB64) {
  try {
    localStorage.setItem(keyStorageKey(username), seedB64)
  } catch {
    /* ignore quota errors */
  }
}
