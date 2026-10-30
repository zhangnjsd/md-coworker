// Admin view (#/admin): user management, keypair/2FA resets, user creation.
import { api, storeKey } from '../net/api.js'
import { confirmDialog, openModal } from '../ui/modal.js'
import { privateKeyPanel } from '../ui/secret.js'
import { toastError, toastSuccess } from '../ui/toast.js'
import { button, el, fmtDateTime, iconButton, svgIcon } from '../util/dom.js'

/**
 * @param {HTMLElement} host
 * @param {{ user: any, onBack: () => void, onLogout: () => void }} opts
 */
export function mountAdmin(host, opts) {
  const { user, onBack, onLogout } = opts
  let destroyed = false
  let users = []
  let loading = false

  host.innerHTML = ''
  host.className = 'view view-admin'

  const tbody = el('tbody')
  const tableWrap = el('div', { class: 'admin-table-wrap' })
  const summary = el('span', { class: 'admin-summary', text: '—' })

  const usernameInput = el('input', {
    class: 'input mono',
    attrs: { type: 'text', placeholder: 'alice', autocomplete: 'off', spellcheck: 'false' },
  })
  const roleSelect = el(
    'select',
    { class: 'input' },
    el('option', { attrs: { value: 'user' }, text: 'user · 普通成员' }),
    el('option', { attrs: { value: 'admin' }, text: 'admin · 管理员' }),
  )
  const createBtn = button('创建用户', 'primary', () => createUser())

  const createCard = el(
    'section',
    { class: 'admin-card' },
    el('div', { class: 'admin-card-head' },
      el('h2', { class: 'admin-card-title', text: '新建用户' }),
      el('p', {
        class: 'admin-card-hint',
        text: '创建后私钥仅展示一次，请当场复制或下载，交给使用者本人保管。',
      }),
    ),
    el(
      'div',
      { class: 'admin-create' },
      el('label', { class: 'field' },
        el('span', { class: 'field-label', text: '用户名' }),
        usernameInput,
      ),
      el('label', { class: 'field' },
        el('span', { class: 'field-label', text: '角色' }),
        roleSelect,
      ),
      createBtn,
    ),
  )

  const refreshBtn = iconButton('refresh', '刷新', () => loadUsers(true))

  const topbar = el(
    'header',
    { class: 'topbar' },
    el(
      'div',
      { class: 'topbar-left' },
      el('div', { class: 'brand-wordmark', text: 'md-coworker' }),
      el('span', { class: 'topbar-sep' }),
      el('span', { class: 'crumb crumb-current', text: '管理后台' }),
    ),
    el(
      'div',
      { class: 'topbar-right' },
      summary,
      el('div', { class: 'user-chip' },
        el('span', { class: 'dot', style: `background:${user.color || '#4f9cf9'}` }),
        el('span', { class: 'user-name', text: user.username }),
        el('span', { class: 'badge badge-admin', text: 'admin' }),
      ),
      button('返回工作区', 'ghost', () => onBack(), 'btn-sm'),
      button('退出登录', 'ghost', () => onLogout(), 'btn-sm'),
    ),
  )

  const page = el(
    'div',
    { class: 'admin-page' },
    el('div', { class: 'admin-head' },
      el('div', {},
        el('h1', { class: 'admin-title', text: '用户管理' }),
        el('p', { class: 'admin-sub', text: '重置密钥对、强制关闭 2FA 或删除用户。所有操作立即生效。' }),
      ),
      refreshBtn,
    ),
    el('section', { class: 'admin-card' },
      el('div', { class: 'admin-card-head' },
        el('h2', { class: 'admin-card-title', text: '全部用户' }),
      ),
      tableWrap,
    ),
    createCard,
  )

  host.append(el('div', { class: 'app-shell admin-shell' }, topbar, page))

  // ------------------------------------------------------------------ render

  function renderTable() {
    tbody.innerHTML = ''
    if (!users.length) {
      tbody.append(
        el('tr', {}, el('td', { class: 'admin-empty', attrs: { colspan: '6' }, text: loading ? '加载中…' : '暂无用户' })),
      )
      return
    }
    for (const row of users) {
      const isSelf = row.id === user.id
      const dot = el('span', {
        class: `presence-dot${row.online ? ' is-online' : ''}`,
        attrs: { title: row.online ? '在线' : '离线' },
      })
      const actions = el(
        'div',
        { class: 'admin-actions' },
        button('重置密钥', 'ghost', () => resetKeypair(row), 'btn-sm'),
        button('重置 2FA', 'ghost', () => reset2fa(row), 'btn-sm'),
        button('删除', 'danger', () => deleteUser(row), 'btn-sm'),
      )
      actions.querySelectorAll('button')[2].disabled = isSelf
      if (isSelf) actions.querySelectorAll('button')[2].title = '不能删除自己'

      tbody.append(
        el(
          'tr',
          { class: isSelf ? 'is-self' : '' },
          el('td', {},
            el('div', { class: 'admin-user' },
              dot,
              el('span', { class: 'dot', style: `background:${row.color || '#4f9cf9'}` }),
              el('span', { class: 'mono', text: row.username }),
              isSelf ? el('span', { class: 'peer-tag', text: '我' }) : null,
            ),
          ),
          el('td', {},
            el('span', { class: `badge badge-${row.role === 'admin' ? 'admin' : 'user'}`, text: row.role }),
          ),
          el('td', {},
            el('span', {
              class: `badge ${row.twofa_enabled ? 'badge-ok' : 'badge-muted'}`,
              text: row.twofa_enabled ? '已启用' : '未启用',
            }),
          ),
          el('td', { class: 'dim mono', text: fmtDateTime(row.created_at) }),
          el('td', {},
            el('span', { class: `status-pill ${row.online ? 'is-online' : ''}`, text: row.online ? '在线' : '离线' }),
          ),
          el('td', {}, actions),
        ),
      )
    }
  }

  function renderSummary() {
    const online = users.filter((u) => u.online).length
    summary.textContent = `共 ${users.length} 人 · ${online} 人在线`
  }

  async function loadUsers(notify = false) {
    loading = true
    try {
      const data = await api.adminUsers()
      if (destroyed) return
      users = Array.isArray(data.users) ? data.users : []
      renderTable()
      renderSummary()
      if (notify) toastSuccess('用户列表已刷新')
    } catch (err) {
      if (!destroyed) toastError(err.message || '无法加载用户列表')
    } finally {
      loading = false
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
      toastError(err.message || '创建用户失败')
    } finally {
      createBtn.disabled = false
    }
  }

  async function resetKeypair(row) {
    const ok = await confirmDialog({
      title: '重置密钥对？',
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
        title: '密钥对已重置',
        username: row.username,
        privateKey: res.private_key,
        publicKey: res.public_key,
        note: `请把新私钥交给 ${row.username}，旧私钥已失效且无法恢复。`,
      })
    } catch (err) {
      toastError(err.message || '重置失败')
    }
  }

  async function reset2fa(row) {
    const ok = await confirmDialog({
      title: '强制重置 2FA？',
      message: `用户 ${row.username} 的两步验证将被关闭，之后可用密钥对直接登录，需要本人重新绑定验证器。`,
      confirmLabel: '重置 2FA',
      danger: true,
    })
    if (!ok) return
    try {
      await api.adminPatchUser(row.id, { twofa_enabled: false })
      await loadUsers()
      toastSuccess('已重置该用户的 2FA')
    } catch (err) {
      toastError(err.message || '操作失败')
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
      toastError(err.message || '删除失败')
    }
  }

  function showKeyModal({ title, username, privateKey, publicKey, note }) {
    const body = el('div', { class: 'key-modal' }, privateKeyPanel({ username, privateKey, publicKey, note }))
    const modal = openModal({
      title,
      subtitle: `用户 ${username}`,
      body,
      width: '620px',
      actions: [
        {
          label: '我已保存，关闭',
          kind: 'primary',
          onClick: () => modal.close(),
        },
      ],
    })
    return modal
  }

  tableWrap.append(
    el(
      'table',
      { class: 'admin-table' },
      el('thead', {},
        el('tr', {},
          el('th', { text: '用户名' }),
          el('th', { text: '角色' }),
          el('th', { text: '2FA' }),
          el('th', { text: '创建时间' }),
          el('th', { text: '状态' }),
          el('th', { text: '操作' }),
        ),
      ),
      tbody,
    ),
  )

  usernameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') createUser()
  })

  loadUsers()

  return () => {
    destroyed = true
    host.innerHTML = ''
  }
}
