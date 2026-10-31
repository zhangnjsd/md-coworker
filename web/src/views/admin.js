// Admin view (#/admin): user management, keypair/2FA resets, user creation.
import { api, storeKey } from '../net/api.js'
import { confirmDialog, openModal } from '../ui/modal.js'
import { privateKeyPanel } from '../ui/secret.js'
import { toastError, toastSuccess } from '../ui/toast.js'
import { button, el, fmtDateTime, iconButton } from '../util/dom.js'

const ROLE_LABEL = { admin: 'admin', user: 'user' }

/* Upload limit — the server stores bytes (docs/protocol.md §9.1), the UI speaks
 * MiB, so every value crossing the wire goes through these two helpers. */
const BYTES_PER_MIB = 1048576
const LIMIT_MIN_MIB = 1
const LIMIT_MAX_MIB = 512
const LIMIT_DEFAULT_BYTES = 10 * BYTES_PER_MIB
const LIMIT_RANGE_TEXT = `上限必须在 ${LIMIT_MIN_MIB} 到 ${LIMIT_MAX_MIB} MiB 之间`

const mibToBytes = (mib) => Math.round(mib * BYTES_PER_MIB)
const bytesToMib = (bytes) => Math.round(bytes / BYTES_PER_MIB)

/**
 * @param {HTMLElement} host
 * @param {{ user: any, onBack: () => void, onLogout: () => void }} opts
 */
export function mountAdmin(host, opts) {
  const { user, onBack, onLogout } = opts
  let destroyed = false
  let users = []
  let loading = false
  let loadError = ''

  // Upload-limit panel state (loads independently of the user table).
  let savedLimitBytes = LIMIT_DEFAULT_BYTES
  let limitLoading = false
  let limitSaving = false
  let limitLoadError = ''

  host.innerHTML = ''
  host.className = 'view view-admin'

  const tbody = el('tbody')
  const tableWrap = el('div', { class: 'admin-table-wrap' })
  const summary = el('span', { class: 'admin-summary', text: '—' })

  const usernameInput = el('input', {
    class: 'input mono',
    attrs: {
      type: 'text',
      id: 'admin-new-username',
      placeholder: 'alice',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  })
  const roleSelect = el(
    'select',
    { class: 'input', attrs: { id: 'admin-new-role' } },
    el('option', { attrs: { value: 'user' }, text: 'user · 普通成员' }),
    el('option', { attrs: { value: 'admin' }, text: 'admin · 管理员' }),
  )
  const createBtn = button('创建用户', 'primary', () => createUser())
  createBtn.disabled = true
  createBtn.title = '输入用户名后即可创建'

  usernameInput.addEventListener('input', () => {
    const ok = /^[a-zA-Z0-9_-]{2,32}$/.test(usernameInput.value.trim())
    createBtn.disabled = !ok
    createBtn.title = ok ? '' : '用户名需为 2–32 位字母、数字、下划线或连字符'
  })

  const refreshBtn = iconButton('refresh', '刷新用户列表', () => loadUsers(true))

  const topbar = el(
    'header',
    { class: 'admin-topbar' },
    el(
      'div',
      { class: 'admin-topbar-left' },
      el('span', { class: 'admin-brand', text: 'md-coworker' }),
      el('span', { class: 'admin-topbar-sep' }),
      el('span', { class: 'admin-crumb is-current', text: '管理后台' }),
    ),
    el(
      'div',
      { class: 'admin-topbar-right' },
      summary,
      el(
        'div',
        { class: 'admin-chip' },
        el('span', { class: 'dot', style: { background: user.color || 'var(--accent)' } }),
        el('span', { class: 'admin-chip-name', text: user.username }),
        el('span', { class: 'badge badge-admin', text: ROLE_LABEL[user.role] || 'admin' }),
      ),
      button('返回工作区', 'ghost', () => onBack(), 'btn-sm'),
      button('退出登录', 'ghost', () => onLogout(), 'btn-sm'),
    ),
  )

  const table = el(
    'table',
    { class: 'admin-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: '用户' }),
        el('th', { text: '角色' }),
        el('th', { text: '2FA' }),
        el('th', { text: '创建时间' }),
        el('th', { text: '状态' }),
        el('th', { text: '操作' }),
      ),
    ),
    tbody,
  )
  tableWrap.append(table)

  const createBlock = el(
    'div',
    { class: 'admin-create' },
    el('div', { class: 'admin-create-title', text: '新建用户' }),
    el(
      'div',
      { class: 'admin-create-row' },
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field-label', text: '用户名', attrs: { for: 'admin-new-username' } }),
        usernameInput,
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field-label', text: '角色', attrs: { for: 'admin-new-role' } }),
        roleSelect,
      ),
      createBtn,
    ),
    el('p', {
      class: 'admin-create-hint',
      text: '创建后私钥只显示一次，请立即复制或下载交给该用户。',
    }),
  )

  const panel = el('section', { class: 'admin-panel' }, tableWrap, createBlock)

  // ------------------------------------------------------- upload limit panel

  const limitInput = el('input', {
    class: 'input mono admin-limit-input',
    attrs: {
      type: 'number',
      id: 'admin-upload-limit',
      min: String(LIMIT_MIN_MIB),
      max: String(LIMIT_MAX_MIB),
      step: '1',
      inputmode: 'numeric',
      autocomplete: 'off',
      'aria-describedby': 'admin-upload-limit-hint admin-upload-limit-error',
    },
    on: { input: () => syncLimitForm() },
  })

  // The form owns submission, so Enter in the field saves exactly like a click.
  const limitSaveBtn = button('保存上限', 'primary', {}, 'admin-limit-save')
  limitSaveBtn.type = 'submit'

  const limitNow = el('p', { class: 'admin-limit-now mono' })
  const limitPreview = el('p', { class: 'admin-limit-preview mono', attrs: { 'aria-live': 'polite' }, hidden: true })
  const limitError = el('p', {
    class: 'field-error admin-limit-error',
    attrs: { id: 'admin-upload-limit-error', role: 'alert' },
    hidden: true,
  })

  const limitForm = el(
    'form',
    {
      class: 'admin-limit-form',
      on: {
        submit: (event) => {
          event.preventDefault()
          submitLimit()
        },
      },
    },
    el(
      'div',
      { class: 'admin-limit-row' },
      el(
        'div',
        { class: 'field admin-limit-field' },
        el('label', {
          class: 'field-label',
          text: '上限（MiB）',
          attrs: { for: 'admin-upload-limit' },
        }),
        limitInput,
      ),
      limitSaveBtn,
    ),
    el('div', { class: 'admin-limit-meta' }, limitNow, limitPreview, limitError),
    el('p', {
      class: 'admin-limit-hint',
      attrs: { id: 'admin-upload-limit-hint' },
      text: '填 1 到 512 之间的整数 MiB；1 MiB = 1048576 字节。',
    }),
  )
  limitForm.noValidate = true
  // Nothing to edit until the current value arrives: skeleton first, no flash.
  limitForm.hidden = true

  // The placeholder copies the form's shape (label / field + button / meta line),
  // so the panel does not jump when the real controls arrive.
  const limitSkeleton = el(
    'div',
    { class: 'admin-settings-loading', attrs: { 'aria-hidden': 'true' } },
    el('span', { class: 'skeleton skel-line is-short' }),
    el(
      'div',
      { class: 'admin-limit-skel-row' },
      el('span', { class: 'skeleton admin-limit-skel-input' }),
      el('span', { class: 'skeleton admin-limit-skel-btn' }),
    ),
    el('span', { class: 'skeleton skel-line is-mid' }),
  )

  const limitLoadErrorText = el('p', { class: 'admin-settings-error-text', attrs: { role: 'alert' } })
  const limitLoadErrorBox = el(
    'div',
    { class: 'admin-settings-error', hidden: true },
    limitLoadErrorText,
    button('重试加载', 'ghost', () => loadLimit(), 'btn-sm'),
  )

  const limitPanel = el(
    'section',
    { class: 'admin-panel admin-settings', attrs: { 'aria-labelledby': 'admin-upload-limit-title' } },
    el(
      'header',
      { class: 'admin-settings-head' },
      el('h2', { class: 'admin-settings-title', text: '上传限制', attrs: { id: 'admin-upload-limit-title' } }),
      el('p', { class: 'admin-settings-sub', text: '单个文件的大小上限，对所有人生效。' }),
    ),
    limitSkeleton,
    limitLoadErrorBox,
    limitForm,
  )

  const page = el(
    'div',
    { class: 'admin-page' },
    el(
      'div',
      { class: 'admin-head' },
      el(
        'div',
        { class: 'admin-head-text' },
        el('h1', { class: 'admin-title', text: '用户管理' }),
        el('p', {
          class: 'admin-sub',
          text: '重置密钥、强制关闭 2FA 或删除用户，改动立即生效。',
        }),
      ),
      refreshBtn,
    ),
    panel,
    limitPanel,
  )

  host.append(el('div', { class: 'admin-shell' }, topbar, page))

  // ------------------------------------------------------------------ render

  function stateRow(content) {
    return el('tr', {}, el('td', { class: 'admin-state', attrs: { colspan: '6' } }, content))
  }

  function renderLoading() {
    tbody.innerHTML = ''
    for (let i = 0; i < 4; i += 1) {
      tbody.append(
        el(
          'tr',
          { class: 'is-skeleton' },
          el('td', {}, el('span', { class: 'skeleton skel-line is-mid' })),
          el('td', {}, el('span', { class: 'skeleton skel-line is-short' })),
          el('td', {}, el('span', { class: 'skeleton skel-line is-short' })),
          el('td', {}, el('span', { class: 'skeleton skel-line is-short' })),
          el('td', {}, el('span', { class: 'skeleton skel-line is-short' })),
          el('td', {}, el('span', { class: 'skeleton skel-line is-short' })),
        ),
      )
    }
  }

  function renderState() {
    if (loading) {
      renderLoading()
      return
    }
    tbody.innerHTML = ''
    if (loadError) {
      tbody.append(
        stateRow(
          el(
            'div',
            {},
            el('p', { class: 'admin-state-text admin-state-error', attrs: { role: 'alert' }, text: loadError }),
            el(
              'div',
              { class: 'admin-state-actions' },
              button('重试加载', 'ghost', () => loadUsers(true), 'btn-sm'),
            ),
          ),
        ),
      )
      return
    }
    if (!users.length) {
      tbody.append(
        stateRow(
          el('p', {
            class: 'admin-state-text',
            text: '还没有其他用户。在下方输入用户名并点 创建用户，即可加入第一位同事。',
          }),
        ),
      )
      return
    }
    for (const row of users) tbody.append(renderRow(row))
  }

  function renderRow(row) {
    const isSelf = row.id === user.id

    const actions = el(
      'div',
      { class: 'admin-actions' },
      button('重置密钥', 'ghost', () => resetKeypair(row), 'btn-sm'),
      button('重置 2FA', 'ghost', () => reset2fa(row), 'btn-sm'),
      button('删除用户', 'danger', () => deleteUser(row), 'btn-sm'),
    )
    const deleteBtn = actions.querySelectorAll('button')[2]
    if (isSelf) {
      deleteBtn.disabled = true
      deleteBtn.title = '不能删除当前登录的账号'
    }

    return el(
      'tr',
      { class: isSelf ? 'is-self' : '' },
      el(
        'td',
        {},
        el(
          'div',
          { class: 'admin-user' },
          el('span', { class: 'dot', style: { background: row.color || 'var(--accent)' } }),
          el('span', { class: 'admin-user-name', text: row.username }),
          isSelf ? el('span', { class: 'admin-self-tag', text: '(我)' }) : null,
        ),
      ),
      el(
        'td',
        {},
        el('span', {
          class: `badge badge-${row.role === 'admin' ? 'admin' : 'user'}`,
          text: ROLE_LABEL[row.role] || 'user',
        }),
      ),
      el(
        'td',
        {},
        // Only 2FA being on is a signal; a column of amber "未启用" chips just adds noise.
        row.twofa_enabled
          ? el('span', { class: 'badge badge-ok', text: '已启用' })
          : el('span', { class: 'admin-off', text: '未启用' }),
      ),
      el('td', { class: 'admin-mono', text: fmtDateTime(row.created_at) }),
      el(
        'td',
        {},
        el(
          'span',
          { class: `admin-status${row.online ? ' is-online' : ''}` },
          el('span', { class: 'admin-status-dot' }),
          el('span', { text: row.online ? '在线' : '离线' }),
        ),
      ),
      el('td', {}, actions),
    )
  }

  function renderSummary() {
    const online = users.filter((u) => u.online).length
    summary.textContent = `共 ${users.length} 人 · 在线 ${online} 人`
  }

  async function loadUsers(notify = false) {
    if (loading) return
    loading = true
    loadError = ''
    renderState()
    try {
      const data = await api.adminUsers()
      if (destroyed) return
      users = Array.isArray(data.users) ? data.users : []
      renderSummary()
      if (notify) toastSuccess('用户列表已刷新')
    } catch (err) {
      if (!destroyed) {
        loadError = err.message || '无法加载用户列表，请检查网络后重试'
        if (notify) toastError(loadError)
      }
    } finally {
      loading = false
      if (!destroyed) renderState()
    }
  }

  // ----------------------------------------------------------- upload limit

  /** @returns {number|null} value of the field when it is a whole number of MiB */
  function limitDraftMib() {
    const raw = limitInput.value.trim()
    if (!/^\d+$/.test(raw)) return null
    const mib = Number(raw)
    return Number.isSafeInteger(mib) ? mib : null
  }

  function limitDraftError() {
    const mib = limitDraftMib()
    if (mib === null || mib < LIMIT_MIN_MIB || mib > LIMIT_MAX_MIB) return LIMIT_RANGE_TEXT
    return ''
  }

  function renderLimitSaved() {
    limitNow.textContent = `当前上限 ${bytesToMib(savedLimitBytes)} MiB（${savedLimitBytes} 字节）`
  }

  /** One source of truth for field hint, error text and button state. */
  function syncLimitForm() {
    const error = limitDraftError()
    const invalid = Boolean(error)
    const mib = invalid ? null : limitDraftMib()

    limitInput.setAttribute('aria-invalid', invalid ? 'true' : 'false')
    limitError.hidden = !invalid
    limitError.textContent = invalid ? error : ''

    // Show the byte figure for a typed value only while it differs from what the
    // server already stores — otherwise it would just echo the line above.
    const dirty = !invalid && mibToBytes(mib) !== savedLimitBytes
    limitPreview.hidden = !dirty
    limitPreview.textContent = dirty ? `保存后 ${mib} MiB（${mibToBytes(mib)} 字节）` : ''

    limitSaveBtn.disabled = limitLoading || limitSaving || invalid || Boolean(limitLoadError)
    limitSaveBtn.title = limitLoading
      ? '正在读取当前上限'
      : limitSaving
        ? '正在保存新的上限'
        : invalid
          ? error
          : limitLoadError
            ? '先重试加载当前上限'
            : ''
  }

  function renderLimitState() {
    limitSkeleton.hidden = !limitLoading
    limitLoadErrorBox.hidden = limitLoading || !limitLoadError
    limitForm.hidden = limitLoading || Boolean(limitLoadError)
    if (limitLoadError) limitLoadErrorText.textContent = limitLoadError
    if (!limitLoading && !limitLoadError) renderLimitSaved()
    syncLimitForm()
  }

  async function loadLimit() {
    if (limitLoading) return
    limitLoading = true
    limitLoadError = ''
    renderLimitState()
    try {
      const res = await api.adminSettings()
      if (destroyed) return
      savedLimitBytes = normalizeLimitBytes(res && res.settings && res.settings.max_upload_bytes)
      limitInput.value = String(bytesToMib(savedLimitBytes))
    } catch (err) {
      if (!destroyed) {
        limitLoadError = err && err.message
          ? `没能读取当前上传上限：${err.message}`
          : '没能读取当前上传上限，请检查网络后重试'
      }
    } finally {
      limitLoading = false
      if (!destroyed) renderLimitState()
    }
  }

  function normalizeLimitBytes(value) {
    const bytes = Number(value)
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : LIMIT_DEFAULT_BYTES
  }

  async function submitLimit() {
    if (limitSaving || limitLoading || limitLoadError) return
    const error = limitDraftError()
    if (error) {
      limitError.hidden = false
      limitError.textContent = error
      limitInput.setAttribute('aria-invalid', 'true')
      limitInput.focus()
      return
    }
    const bytes = mibToBytes(limitDraftMib())
    limitSaving = true
    limitSaveBtn.textContent = '保存中…'
    limitSaveBtn.classList.add('is-busy')
    syncLimitForm()
    try {
      const res = await api.updateSettings({ max_upload_bytes: bytes })
      if (destroyed) return
      savedLimitBytes = normalizeLimitBytes(res && res.settings && res.settings.max_upload_bytes)
      limitInput.value = String(bytesToMib(savedLimitBytes))
      renderLimitSaved()
      syncLimitForm()
      toastSuccess(`已把上传上限调整为 ${bytesToMib(savedLimitBytes)} MiB`)
    } catch (err) {
      // Surface the server's own Chinese message (bad_limit / forbidden / …).
      if (!destroyed) toastError(err.message || '没能保存新的上传上限，请重试')
    } finally {
      limitSaving = false
      limitSaveBtn.textContent = '保存上限'
      limitSaveBtn.classList.remove('is-busy')
      if (!destroyed) syncLimitForm()
    }
  }

  // ----------------------------------------------------------------- actions

  async function createUser() {
    const username = usernameInput.value.trim()
    const role = roleSelect.value
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
      toastError('用户名需为 2–32 位字母、数字、下划线或连字符')
      usernameInput.focus()
      return
    }
    createBtn.disabled = true
    createBtn.classList.add('is-busy')
    try {
      const res = await api.adminCreateUser(username, role)
      storeKey(res.user.username, res.private_key)
      usernameInput.value = ''
      await loadUsers()
      showKeyModal({
        title: '用户已创建',
        username: res.user.username,
        privateKey: res.private_key,
        publicKey: res.public_key,
        note: '这是该用户唯一的登录凭据，关闭后无法再次查看。请立刻复制或下载并交付给使用者。',
      })
    } catch (err) {
      toastError(err.message || '创建用户失败，请重试')
    } finally {
      createBtn.classList.remove('is-busy')
      createBtn.disabled = !/^[a-zA-Z0-9_-]{2,32}$/.test(usernameInput.value.trim())
    }
  }

  async function resetKeypair(row) {
    const ok = await confirmDialog({
      title: '重置密钥？',
      message: `用户 ${row.username} 的旧私钥将立即失效，需要用新私钥重新登录。`,
      confirmLabel: '重置密钥',
      danger: true,
    })
    if (!ok) return
    try {
      const res = await api.adminResetKeypair(row.id)
      storeKey(row.username, res.private_key)
      await loadUsers()
      showKeyModal({
        title: '密钥已重置',
        username: row.username,
        privateKey: res.private_key,
        publicKey: res.public_key,
        note: `请把新私钥交给 ${row.username}，旧私钥已失效且无法恢复。`,
      })
    } catch (err) {
      toastError(err.message || '重置密钥失败，请重试')
    }
  }

  async function reset2fa(row) {
    const ok = await confirmDialog({
      title: '强制重置 2FA？',
      message: `用户 ${row.username} 的两步验证将被关闭，之后可用密钥直接登录，需要本人重新绑定验证器。`,
      confirmLabel: '重置 2FA',
      danger: true,
    })
    if (!ok) return
    try {
      await api.adminPatchUser(row.id, { twofa_enabled: false })
      await loadUsers()
      toastSuccess(`已关闭 ${row.username} 的 2FA`)
    } catch (err) {
      toastError(err.message || '重置 2FA 失败，请重试')
    }
  }

  async function deleteUser(row) {
    if (row.id === user.id) {
      toastError('不能删除当前登录的账号')
      return
    }
    const ok = await confirmDialog({
      title: '删除用户？',
      message: `用户 ${row.username} 将被永久删除，无法恢复。其创建的文件不会被删除。`,
      confirmLabel: '删除用户',
      danger: true,
    })
    if (!ok) return
    try {
      await api.adminDeleteUser(row.id)
      await loadUsers()
      toastSuccess(`已删除 ${row.username}`)
    } catch (err) {
      toastError(err.message || '删除用户失败，请重试')
    }
  }

  function showKeyModal({ title, username, privateKey, publicKey, note }) {
    const body = privateKeyPanel({ username, privateKey, publicKey, note })
    const modal = openModal({
      title,
      subtitle: `用户 ${username}`,
      body,
      width: 640,
      actions: [{ label: '我已保存，关闭', kind: 'primary', onClick: () => modal.close() }],
    })
    return modal
  }

  loadUsers()
  loadLimit()

  return () => {
    destroyed = true
    host.innerHTML = ''
  }
}
