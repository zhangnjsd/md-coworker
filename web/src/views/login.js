// Login view (#/login): Ed25519 challenge/response with an optional TOTP step.
import nacl from 'tweetnacl'
import { api, loadStoredKey, storeKey } from '../net/api.js'
import { b64ToBytes, bytesToB64, parseSeed } from '../util/b64.js'
import { button, el, svgIcon } from '../util/dom.js'
import { toastError, toastSuccess } from '../ui/toast.js'

const FRIENDLY_ERRORS = {
  bad_signature: '签名校验失败：该私钥与用户名不匹配，请确认密钥文件是否正确。',
  unknown_user: '用户不存在，请核对用户名（管理员创建用户时会下发私钥）。',
  bad_totp: '验证码错误或已过期，请重新输入当前 6 位验证码。',
  unauthorized: '登录状态已失效，请重新登录。',
  network_error: '无法连接服务端，请确认后端服务已启动。',
}

function friendlyMessage(err) {
  if (!err) return '登录失败'
  if (err.code && FRIENDLY_ERRORS[err.code]) return FRIENDLY_ERRORS[err.code]
  return err.message || '登录失败'
}

/**
 * @param {HTMLElement} host
 * @param {{ onSuccess: (user: any) => void }} opts
 */
export function mountLogin(host, opts) {
  const { onSuccess } = opts
  let destroyed = false
  let busy = false

  host.innerHTML = ''
  host.className = 'view view-login'

  const errorBox = el('div', { class: 'login-error', style: 'display:none' })
  const usernameInput = el('input', {
    class: 'input mono',
    attrs: { type: 'text', placeholder: '例如 alice', autocomplete: 'username', spellcheck: 'false' },
    on: {
      input: () => {
        errorBox.style.display = 'none'
        const stored = loadStoredKey(usernameInput.value)
        if (stored && keyInput.value !== stored) keyInput.value = stored
      },
    },
  })
  const keyInput = el('textarea', {
    class: 'input mono key-input',
    attrs: { rows: '2', placeholder: '粘贴 base64 私钥（44 字符），或拖入 .key 文件', spellcheck: 'false' },
    on: {
      input: () => {
        errorBox.style.display = 'none'
      },
    },
  })
  const keyFileInput = el('input', {
    class: 'hidden-file',
    attrs: { type: 'file', accept: '.key,.txt,text/plain' },
    on: { change: () => readKeyFile(keyFileInput.files && keyFileInput.files[0]) },
  })

  const submitBtn = button('登录', 'primary', () => submit())
  submitBtn.classList.add('login-submit')

  function showError(message) {
    errorBox.textContent = message
    errorBox.style.display = 'block'
  }

  async function readKeyFile(file) {
    if (!file) return
    try {
      const text = await file.text()
      keyInput.value = text.trim()
      // Common key files are named after the user, use it as a hint.
      const base = (file.name || '').replace(/\.(key|txt)$/i, '').trim()
      if (base && !usernameInput.value) usernameInput.value = base
      if (base) {
        const stored = loadStoredKey(base)
        if (!keyInput.value && stored) keyInput.value = stored
      }
      errorBox.style.display = 'none'
    } catch (err) {
      showError(`读取密钥文件失败：${err.message || err}`)
    }
  }

  const dropZone = el(
    'div',
    {
      class: 'key-file-row',
      on: {
        dragover: (ev) => {
          ev.preventDefault()
          dropZone.classList.add('dragging')
        },
        dragleave: () => dropZone.classList.remove('dragging'),
        drop: (ev) => {
          ev.preventDefault()
          dropZone.classList.remove('dragging')
          const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]
          readKeyFile(file)
        },
      },
    },
    el(
      'button',
      { class: 'btn btn-ghost btn-sm', attrs: { type: 'button' }, on: { click: () => keyFileInput.click() } },
      svgIcon('key', 14),
      el('span', { text: '选择密钥文件' }),
    ),
    el('span', { class: 'key-file-hint', text: '也可直接拖入 .key / .txt 文件' }),
    keyFileInput,
  )

  async function submit() {
    if (busy) return
    const username = usernameInput.value.trim()
    const rawKey = keyInput.value.trim()

    if (!username) {
      showError('请输入用户名。')
      usernameInput.focus()
      return
    }
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
      showError('用户名格式不正确：仅支持字母、数字、下划线和连字符，长度 2–32。')
      usernameInput.focus()
      return
    }
    if (!rawKey) {
      showError('请输入或拖入私钥（base64 编码的 32 字节 seed）。')
      keyInput.focus()
      return
    }

    let seed
    try {
      seed = parseSeed(rawKey)
    } catch (err) {
      showError(err.message || '私钥格式不正确')
      keyInput.focus()
      return
    }

    busy = true
    submitBtn.disabled = true
    submitBtn.classList.add('is-busy')
    try {
      const challenge = await api.challenge(username)
      if (!challenge || !challenge.challenge_id || !challenge.nonce) {
        throw new Error('服务端未返回有效挑战，请稍后重试。')
      }
      const keyPair = nacl.sign.keyPair.fromSeed(seed)
      const signature = nacl.sign.detached(b64ToBytes(challenge.nonce), keyPair.secretKey)
      const result = await api.login(challenge.challenge_id, bytesToB64(signature))

      if (result && result.status === 'mfa_required') {
        storeKey(username, bytesToB64(seed))
        showMfaStep(username, result.ticket, bytesToB64(seed))
        return
      }
      if (result && result.status === 'ok' && result.user) {
        storeKey(username, bytesToB64(seed))
        toastSuccess(`欢迎回来，${result.user.username}`)
        onSuccess(result.user)
        return
      }
      showError('登录响应异常，请稍后重试。')
    } catch (err) {
      const msg = friendlyMessage(err)
      showError(msg)
    } finally {
      busy = false
      if (!destroyed) {
        submitBtn.disabled = false
        submitBtn.classList.remove('is-busy')
      }
    }
  }

  // ------------------------------------------------------------- TOTP step

  function showMfaStep(username, ticket, seedB64) {
    const codeInput = el('input', {
      class: 'input totp-input mono',
      attrs: {
        type: 'text',
        inputmode: 'numeric',
        maxlength: '6',
        placeholder: '000000',
        autocomplete: 'one-time-code',
        spellcheck: 'false',
      },
      on: {
        input: () => {
          codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6)
          mfaError.style.display = 'none'
          if (codeInput.value.length === 6) confirmMfa()
        },
        keydown: (ev) => {
          if (ev.key === 'Enter') confirmMfa()
        },
      },
    })
    const mfaError = el('div', { class: 'login-error', style: 'display:none' })
    const confirmBtn = button('验证并进入', 'primary', () => confirmMfa())
    const backBtn = button('使用其他账号', 'ghost', () => {
      mfaCard.remove()
      credentialsCard.style.display = ''
      usernameInput.focus()
    })

    let mfaBusy = false
    async function confirmMfa() {
      if (mfaBusy) return
      const code = codeInput.value.trim()
      if (code.length !== 6) {
        mfaError.textContent = '请输入 6 位验证码。'
        mfaError.style.display = 'block'
        return
      }
      mfaBusy = true
      confirmBtn.disabled = true
      try {
        const result = await api.mfa(ticket, code)
        if (result && result.status === 'ok' && result.user) {
          storeKey(username, seedB64)
          toastSuccess(`欢迎回来，${result.user.username}`)
          onSuccess(result.user)
          return
        }
        mfaError.textContent = '验证失败，请重试。'
        mfaError.style.display = 'block'
      } catch (err) {
        mfaError.textContent = friendlyMessage(err)
        mfaError.style.display = 'block'
      } finally {
        mfaBusy = false
        confirmBtn.disabled = false
      }
    }

    const mfaCard = el(
      'div',
      { class: 'mfa-card' },
      el('div', { class: 'mfa-title', text: '两步验证' }),
      el('div', {
        class: 'mfa-sub',
        text: `账号 ${username} 已启用 2FA，请输入身份验证器中的 6 位验证码。`,
      }),
      codeInput,
      mfaError,
      el('div', { class: 'mfa-actions' }, confirmBtn, backBtn),
    )

    credentialsCard.style.display = 'none'
    credentialsCard.after(mfaCard)
    codeInput.focus()
  }

  // ------------------------------------------------------------ structure

  const credentialsCard = el(
    'div',
    { class: 'login-card' },
    el('div', { class: 'login-card-head' },
      el('div', { class: 'login-brand' },
        el('div', { class: 'brand-mark', text: 'md' }),
        el('div', {},
          el('div', { class: 'brand-name', text: 'md-coworker' }),
          el('div', { class: 'brand-sub', text: '实时协作 Markdown 工作区' }),
        ),
      ),
    ),
    el('div', { class: 'login-body' },
      el('label', { class: 'field' },
        el('span', { class: 'field-label', text: '用户名' }),
        usernameInput,
      ),
      el('label', { class: 'field' },
        el('span', { class: 'field-label', text: '私钥（base64 seed）' }),
        keyInput,
      ),
      dropZone,
      errorBox,
      submitBtn,
    ),
    el('div', { class: 'login-foot' },
      svgIcon('lock', 13),
      el('span', { text: '本系统仅支持密钥对登录，不提供密码。私钥只保存在本机浏览器中。' }),
    ),
  )

  const side = el('aside', { class: 'login-side' },
    el('h1', { class: 'login-side-title', text: '多人同时编辑同一份 Markdown。' }),
    el('p', { class: 'login-side-text', text: '基于 CRDT 的无冲突协同编辑，文件直接落盘到服务端工作区，无需手动保存。' }),
    el('ul', { class: 'login-side-list' },
      el('li', { text: 'Ed25519 密钥对登录，配合可选 TOTP 二次验证' }),
      el('li', { text: 'CodeMirror / Monaco 双引擎，Markdown 与源码文件皆可协作' }),
      el('li', { text: '按文件隔离的 Yjs 房间，切换文件不串味' }),
      el('li', { text: 'KaTeX 数学公式、Mermaid 图表、代码高亮开箱可用' }),
    ),
  )

  const shell = el('div', { class: 'login-shell' }, side, credentialsCard)
  host.append(shell)

  // Prefill from the last successful login.
  try {
    const last = localStorage.getItem('mc.lastUser') || ''
    if (last) {
      usernameInput.value = last
      const stored = loadStoredKey(last)
      if (stored) keyInput.value = stored
    }
  } catch {
    /* ignore */
  }

  ;(usernameInput.value ? keyInput : usernameInput).focus()

  return () => {
    destroyed = true
    host.innerHTML = ''
  }
}
