// Admin view (#/admin): user management, keypair/2FA resets, user creation.
import { api, storeKey } from '../net/api.js'
import { confirmDialog, openModal } from '../ui/modal.js'
import { privateKeyPanel } from '../ui/secret.js'
import { toastError, toastSuccess } from '../ui/toast.js'
import { button, el, fmtDateTime, iconButton } from '../util/dom.js'

const ROLE_LABEL = { admin: 'admin', user: 'user' }

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
        el('span', {
          class: `badge ${row.twofa_enabled ? 'badge-ok' : 'badge-warn'}`,
          text: row.twofa_enabled ? '启用' : '未启用',
        }),
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

  return () => {
    destroyed = true
    host.innerHTML = ''
  }
}
