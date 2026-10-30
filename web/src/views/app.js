// Main workspace view (#/app).
import { api } from '../net/api.js'
import { CollabClient } from '../net/collab.js'
import { FileTree } from '../ui/tree.js'
import { confirmDialog, promptDialog } from '../ui/modal.js'
import { toastError, toastInfo, toastSuccess, toastWarn } from '../ui/toast.js'
import { button, countWords, el, fmtClock, iconButton, svgIcon } from '../util/dom.js'
import { colorLight } from '../util/color.js'
import { createMarkdownEditor } from '../editor/markdown.js'
import { createPreview } from '../editor/preview.js'
import { openSettings } from './settings.js'

// Monaco（3.4MB）只在真正打开非 Markdown 文件时才动态加载，首屏只走 CodeMirror。
function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(String(path || ''))
}

const LS = {
  sidebar: 'mc.ui.sidebarCollapsed',
  split: 'mc.ui.split',
  scrollSync: 'mc.ui.scrollSync',
}

const SPLIT_MIN = 0.22
const SPLIT_MAX = 0.85

function lsGet(key, fallback = null) {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value
  } catch {
    return fallback
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name
}

function hasPath(nodes, path) {
  for (const node of nodes || []) {
    if (node.path === path) return true
    if (node.children && hasPath(node.children, path)) return true
  }
  return false
}

function parentPath(path) {
  const idx = String(path).lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   user: any,
 *   onLogout: () => void,
 *   onNavigateAdmin: () => void,
 *   onUserUpdate?: (user: any) => void,
 * }} opts
 */
export function mountApp(host, opts) {
  const { user, onLogout, onNavigateAdmin, onUserUpdate } = opts

  const state = {
    user,
    tree: [],
    currentPath: null,
    editor: null,
    editorObserver: null,
    saveState: 'idle',
    saveAt: 0,
    online: 0,
    peers: 0,
    presence: [],
    words: 0,
    destroyed: false,
  }

  host.innerHTML = ''
  host.className = 'view view-app'

  // ------------------------------------------------------------------ DOM

  const breadcrumb = el('div', { class: 'breadcrumb' }, el('span', { class: 'crumb-empty', text: '未打开文件' }))
  const saveDot = el('span', { class: 'save-dot' })
  const saveText = el('span', { class: 'save-text', text: '已保存' })
  const connBadge = el('span', { class: 'conn-badge', text: '连接中…' })
  const userDot = el('span', { class: 'dot', style: `background:${state.user.color || '#4f9cf9'}` })
  const userChip = el(
    'div',
    { class: 'user-chip' },
    userDot,
    el('span', { class: 'user-name', text: state.user.username }),
    el('span', { class: `badge badge-${state.user.role === 'admin' ? 'admin' : 'user'}`, text: state.user.role }),
  )

  const settingsBtn = iconButton('settings', '设置', () => openSettingsDialog())
  const adminBtn = button('管理员', 'ghost', () => onNavigateAdmin(), 'btn-sm')
  adminBtn.prepend(svgIcon('shield', 14))
  if (state.user.role !== 'admin') adminBtn.style.display = 'none'
  const logoutBtn = button('退出登录', 'ghost', () => doLogout(), 'btn-sm')
  logoutBtn.prepend(svgIcon('logout', 14))

  const topbar = el(
    'header',
    { class: 'topbar' },
    el(
      'div',
      { class: 'topbar-left' },
      el('div', { class: 'brand-wordmark', text: 'md-coworker' }),
      el('span', { class: 'topbar-sep' }),
      breadcrumb,
    ),
    el(
      'div',
      { class: 'topbar-right' },
      connBadge,
      el('div', { class: 'save-indicator' }, saveDot, saveText),
      userChip,
      settingsBtn,
      adminBtn,
      logoutBtn,
    ),
  )

  // ------------------------------------------------------------------- tree

  const treeHost = el('div', { class: 'tree-scroll' })
  const tree = new FileTree(treeHost, {
    onOpen: (path) => openFile(path),
    onRename: (node) => renameEntry(node.path),
    onDelete: (node) => deleteEntry(node.path),
  })

  const newFileBtn = iconButton('plus', '新建文件', () => createEntry('file'))
  const newDirBtn = iconButton('folder', '新建目录', () => createEntry('dir'))
  const refreshBtn = iconButton('refresh', '刷新文件列表', () => reloadTree(true))
  const railButtons = el(
    'div',
    { class: 'rail-actions' },
    iconButton('plus', '新建文件', () => createEntry('file')),
    iconButton('refresh', '刷新', () => reloadTree(true)),
  )

  const sidebar = el(
    'aside',
    { class: 'sidebar' },
    el(
      'div',
      { class: 'sidebar-head' },
      el('span', { class: 'sidebar-title', text: '文件' }),
      el('div', { class: 'sidebar-tools' }, newFileBtn, newDirBtn, refreshBtn),
      iconButton('panel-left', '收起文件树', () => toggleSidebar()),
    ),
    el('div', { class: 'sidebar-body' }, treeHost),
    railButtons,
  )

  const railToggle = el(
    'button',
    {
      class: 'rail-toggle',
      attrs: { type: 'button', title: '展开文件树', 'aria-label': '展开文件树' },
      on: { click: () => toggleSidebar() },
    },
    svgIcon('panel-left', 15),
  )
  railButtons.prepend(el('div', { class: 'rail-brand', text: 'md' }), railToggle)

  // ---------------------------------------------------------------- editors

  const editorHost = el('div', { class: 'editor-host' })
  const editorEmpty = el(
    'div',
    { class: 'pane-empty' },
    el('div', { class: 'pane-empty-icon', text: '⌘' }),
    el('div', { class: 'pane-empty-title', text: '未打开文件' }),
    el('div', { class: 'pane-empty-hint', text: '在左侧文件树中选择一个文件开始协作编辑' }),
  )
  const editorMeta = el('span', { class: 'pane-meta', text: '' })
  const editorPane = el('section', { class: 'pane pane-editor' },
    el('div', { class: 'pane-head' },
      el('span', { class: 'pane-title', text: '编辑' }),
      editorMeta,
    ),
    el('div', { class: 'pane-body' }, editorHost, editorEmpty),
  )

  const previewHost = el('div', { class: 'preview-host markdown-body' })
  const syncToggle = el('button', {
    class: 'chip-toggle is-on',
    attrs: { type: 'button', title: '滚动同步' },
    text: '滚动同步',
    on: { click: () => toggleScrollSync() },
  })
  const previewPane = el('section', { class: 'pane pane-preview' },
    el('div', { class: 'pane-head' },
      el('span', { class: 'pane-title', text: '预览' }),
      syncToggle,
    ),
    el('div', { class: 'pane-body' }, previewHost),
  )

  const splitter = el('div', { class: 'splitter', attrs: { role: 'separator', 'aria-orientation': 'vertical' } })
  const center = el('div', { class: 'center' }, editorPane, splitter, previewPane)

  // ------------------------------------------------------------ collab panel

  const onlineCount = el('span', { class: 'collab-count', text: '在线 0 人' })
  const presenceList = el('div', { class: 'collab-list' })
  const collabPanel = el(
    'aside',
    { class: 'collab-panel' },
    el('div', { class: 'collab-head' }, svgIcon('users', 14), onlineCount),
    presenceList,
  )

  // -------------------------------------------------------------- status bar

  const statusCursor = el('span', { class: 'status-item mono', text: '行 1，列 1' })
  const statusWords = el('span', { class: 'status-item', text: '0 字' })
  const statusOnline = el('span', { class: 'status-item', text: '在线 0 人' })
  const statusFile = el('span', { class: 'status-item status-path', text: '—' })
  const statusSave = el('span', { class: 'status-item', text: '已保存' })
  const statusbar = el(
    'footer',
    { class: 'statusbar' },
    statusFile,
    el('div', { class: 'status-right' }, statusCursor, statusWords, statusOnline, statusSave),
  )

  const shell = el('div', { class: 'app-shell' }, topbar, el('div', { class: 'app-body' }, sidebar, center, collabPanel), statusbar)
  host.append(shell)

  // ------------------------------------------------------------ collab setup

  const collab = new CollabClient({
    user: state.user,
    onStatus: (status) => {
      if (status === 'open') {
        connBadge.textContent = '已连接'
        connBadge.classList.add('is-online')
        connBadge.classList.remove('is-offline')
      } else if (status === 'connecting') {
        connBadge.textContent = '连接中…'
        connBadge.classList.remove('is-online', 'is-offline')
      } else {
        connBadge.textContent = '重连中…'
        connBadge.classList.add('is-offline')
        connBadge.classList.remove('is-online')
      }
    },
    onPresence: (users) => renderPresence(users),
    onPeers: (path, count) => {
      if (path === state.currentPath) {
        state.peers = count
        renderStatus()
      }
    },
    onSaved: (path, ts) => {
      if (path !== state.currentPath) return
      if (saveFallbackTimer) {
        clearTimeout(saveFallbackTimer)
        saveFallbackTimer = null
      }
      state.saveState = 'saved'
      state.saveAt = ts
      renderSave()
    },
    onError: (message) => toastError(message),
  })

  // ------------------------------------------------------------- preview api

  let scrollSyncOn = lsGet(LS.scrollSync, '1') !== '0'
  let syncingScroll = false

  const preview = createPreview({
    container: previewHost,
    onScroll: (ratio) => {
      if (!scrollSyncOn || syncingScroll || !state.editor) return
      if (!isMarkdownPath(state.currentPath)) return
      syncingScroll = true
      state.editor.scrollToRatio(ratio)
      requestAnimationFrame(() => {
        syncingScroll = false
      })
    },
  })

  function renderSyncToggle() {
    syncToggle.classList.toggle('is-on', scrollSyncOn)
    syncToggle.textContent = scrollSyncOn ? '滚动同步' : '同步已关'
  }
  renderSyncToggle()

  function toggleScrollSync() {
    scrollSyncOn = !scrollSyncOn
    lsSet(LS.scrollSync, scrollSyncOn ? '1' : '0')
    renderSyncToggle()
    toastInfo(scrollSyncOn ? '已开启预览滚动同步' : '已关闭预览滚动同步')
  }

  // ------------------------------------------------------------------ tree IO

  async function reloadTree(notify = false) {
    try {
      const data = await api.files()
      state.tree = Array.isArray(data.tree) ? data.tree : []
      tree.setTree(state.tree)
      paintTreePresence()
      if (notify) toastSuccess('文件列表已刷新')
    } catch (err) {
      toastError(err.message || '无法加载文件列表')
    }
  }

  async function createEntry(kind) {
    const dir = state.currentPath ? parentPath(state.currentPath) : ''
    const result = await promptDialog({
      title: kind === 'file' ? '新建文件' : '新建目录',
      subtitle: '路径相对于工作区根目录',
      label: kind === 'file' ? '文件路径' : '目录路径',
      value: dir ? `${dir}/` : '',
      placeholder: kind === 'file' ? 'notes/todo.md' : 'notes',
      confirmLabel: '创建',
      validate: (value) => {
        const path = value.trim().replace(/^\/+/, '')
        if (!path) return '请输入路径'
        if (path.includes('..')) return '路径不能包含 ..'
        if (kind === 'file' && path.endsWith('/')) return '文件路径不能以 / 结尾'
        return null
      },
    })
    if (result === null) return
    const path = result.trim().replace(/^\/+/, '')
    try {
      await api.createEntry(path, kind, kind === 'file' ? '' : '')
      await reloadTree()
      if (kind === 'file') await openFile(path)
      toastSuccess(kind === 'file' ? `已创建 ${path}` : `已创建目录 ${path}`)
    } catch (err) {
      toastError(err.message || '创建失败')
    }
  }

  async function renameEntry(path) {
    const result = await promptDialog({
      title: '重命名',
      subtitle: '可以连同目录一起移动',
      label: '新路径',
      value: path,
      confirmLabel: '重命名',
      validate: (value) => {
        const next = value.trim().replace(/^\/+/, '')
        if (!next) return '请输入新路径'
        if (next.includes('..')) return '路径不能包含 ..'
        if (next === path) return '新路径与原路径相同'
        return null
      },
    })
    if (result === null) return
    const next = result.trim().replace(/^\/+/, '')
    try {
      await api.renameEntry(path, next)
      const wasOpen = state.currentPath === path || (state.currentPath || '').startsWith(`${path}/`)
      if (wasOpen) {
        const target = state.currentPath === path ? next : next + state.currentPath.slice(path.length)
        collab.dropSession(state.currentPath)
        await closeEditor()
        state.currentPath = null
        await reloadTree()
        await openFile(target)
      } else {
        collab.dropSession(path)
        await reloadTree()
      }
      toastSuccess('重命名完成')
    } catch (err) {
      toastError(err.message || '重命名失败')
    }
  }

  async function deleteEntry(path) {
    const ok = await confirmDialog({
      title: '删除确认',
      message: `确定删除 ${path} 吗？目录会被递归删除，此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteEntry(path)
      const affected = state.currentPath === path || (state.currentPath || '').startsWith(`${path}/`)
      if (affected) {
        collab.dropSession(state.currentPath)
        await closeEditor()
        state.currentPath = null
        renderBreadcrumb()
        renderStatus()
      }
      collab.dropSession(path)
      await reloadTree()
      toastSuccess('已删除')
    } catch (err) {
      toastError(err.message || '删除失败')
    }
  }

  // ------------------------------------------------------------------ editor

  async function closeEditor() {
    if (state.editorObserver) {
      const { ytext, fn } = state.editorObserver
      try {
        ytext.unobserve(fn)
      } catch {
        /* ignore */
      }
      state.editorObserver = null
    }
    if (state.editor) {
      try {
        state.editor.destroy()
      } catch (err) {
        console.warn('[app] editor destroy failed', err)
      }
      state.editor = null
    }
    editorHost.innerHTML = ''
    editorEmpty.style.display = ''
    preview.renderEmpty('无可预览内容', '打开一个 Markdown 文件即可实时预览')
  }

  function setEditorMeta(text) {
    editorMeta.textContent = text || ''
  }

  /** @param {string} path */
  async function openFile(path) {
    if (!path) return
    if (state.currentPath === path && state.editor) {
      tree.setCurrent(path)
      return
    }
    const previous = state.currentPath
    tree.setCurrent(path)

    if (previous && previous !== path) collab.leaveFile(previous)
    await closeEditor()

    state.currentPath = path
    state.saveState = 'idle'
    renderBreadcrumb()
    renderStatus()

    let session
    try {
      const joined = await collab.joinFile(path)
      session = joined.session
      if (joined.timedOut) {
        toastWarn('实时会话连接较慢，正在继续尝试同步…')
      }
    } catch (err) {
      toastError(err.message || '无法打开文件')
      return
    }
    if (state.destroyed || state.currentPath !== path) return

    const ytext = session.ydoc.getText('content')
    const md = isMarkdownPath(path)
    editorEmpty.style.display = 'none'

    try {
      if (md) {
        state.editor = createMarkdownEditor({
          parent: editorHost,
          ytext,
          awareness: session.awareness,
          onCursor: (pos) => {
            renderCursor(pos)
            collab.reportPresence(pos, 0)
          },
          onScroll: (ratio) => {
            if (!scrollSyncOn || syncingScroll) return
            syncingScroll = true
            preview.scrollToRatio(ratio)
            requestAnimationFrame(() => {
              syncingScroll = false
            })
          },
          onDocChange: () => markSaving(),
        })
      } else {
        const { createCodeEditor } = await import('../editor/code.js')
        state.editor = createCodeEditor({
          parent: editorHost,
          path,
          ytext,
          awareness: session.awareness,
          onCursor: (pos) => {
            renderCursor(pos)
            collab.reportPresence(pos, 0)
          },
        })
      }
    } catch (err) {
      console.error('[app] editor init failed', err)
      toastError('编辑器初始化失败，请刷新页面重试')
      return
    }

    collab.setCurrentPath(path)
    setEditorMeta(md ? 'CodeMirror · Markdown' : `Monaco · ${path.split('.').pop()}`)

    // Realtime preview / word count from the shared text.
    const updateText = () => {
      const text = ytext.toString()
      if (md) preview.render(text)
      else
        preview.renderPlain(
          text.length > 400000 ? `${text.slice(0, 400000)}\n\n… 文件过大，仅显示前 400000 个字符` : text,
          `${path}（只读预览）`,
        )
      state.words = countWords(text)
      renderWords()
    }
    const observer = (event, transaction) => {
      if (transaction && transaction.origin !== 'remote') markSaving()
      updateText()
    }
    ytext.observe(observer)
    state.editorObserver = { ytext, fn: observer }

    if (md) preview.renderNow(ytext.toString())
    else updateText()

    const pos = state.editor.cursor ? state.editor.cursor() : { line: 0, ch: 0 }
    renderCursor(pos)
    collab.reportPresence(pos, 0)
    renderStatus()
  }

  let saveFallbackTimer = null
  function markSaving() {
    state.saveState = 'saving'
    renderSave()
    // Safety net: never leave the indicator spinning if the server stays silent.
    if (saveFallbackTimer) clearTimeout(saveFallbackTimer)
    saveFallbackTimer = setTimeout(() => {
      saveFallbackTimer = null
      if (state.saveState !== 'saving') return
      state.saveState = 'saved'
      state.saveAt = state.saveAt || Date.now()
      renderSave()
    }, 2500)
  }

  // ---------------------------------------------------------------- rendering

  function renderBreadcrumb() {
    if (!state.currentPath) {
      breadcrumb.innerHTML = ''
      breadcrumb.append(el('span', { class: 'crumb-empty', text: '未打开文件' }))
      statusFile.textContent = '—'
      return
    }
    const parts = state.currentPath.split('/')
    breadcrumb.innerHTML = ''
    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1
      breadcrumb.append(
        el('span', { class: `crumb${isLast ? ' crumb-current' : ''}`, text: part }),
      )
      if (!isLast) breadcrumb.append(el('span', { class: 'crumb-sep', text: '/' }))
    })
    statusFile.textContent = state.currentPath
  }

  function renderSave() {
    const saving = state.saveState === 'saving'
    saveDot.className = `save-dot${saving ? ' is-saving' : ' is-saved'}`
    saveText.textContent = saving ? '保存中…' : '已保存'
    statusSave.textContent = saving
      ? '保存中…'
      : state.saveAt
        ? `已保存 ${fmtClock(state.saveAt)}`
        : '已保存'
  }

  function renderCursor(pos) {
    if (!pos) return
    statusCursor.textContent = `行 ${pos.line + 1}，列 ${pos.ch + 1}`
  }

  function renderWords() {
    statusWords.textContent = `${state.words} 字`
  }

  function renderStatus() {
    statusOnline.textContent = `在线 ${state.online} 人`
    onlineCount.textContent = `在线 ${state.online} 人`
    statusFile.textContent = state.currentPath || '—'
    renderSave()
    renderWords()
  }

  function renderPresence(users) {
    state.presence = users || []
    state.online = state.presence.length
    presenceList.innerHTML = ''

    if (!state.online) {
      presenceList.append(
        el('div', { class: 'collab-empty' },
          el('div', { class: 'collab-empty-title', text: '暂无其他在线成员' }),
          el('div', { class: 'collab-empty-hint', text: '邀请同伴登录后即可看到实时光标' }),
        ),
      )
    } else {
      const sorted = [...state.presence].sort((a, b) => {
        const aSame = a.path === state.currentPath ? 0 : 1
        const bSame = b.path === state.currentPath ? 0 : 1
        if (aSame !== bSame) return aSame - bSame
        return String(a.username).localeCompare(String(b.username))
      })
      for (const peer of sorted) {
        presenceList.append(renderPeer(peer))
      }
    }
    paintTreePresence()
    renderStatus()
  }

  // 在文件树上标出"谁正在编辑这个文件"（实时 presence 的第二个作用）
  function paintTreePresence() {
    const byPath = new Map()
    for (const peer of state.presence) {
      if (!peer.path) continue
      const list = byPath.get(peer.path) || []
      list.push(peer)
      byPath.set(peer.path, list)
    }
    for (const row of treeHost.querySelectorAll('.tree-row')) {
      const path = row.getAttribute('data-path')
      const users = byPath.get(path) || []
      row.classList.toggle('is-editing', users.length > 0)
      for (const old of row.querySelectorAll('.tree-presence-dot')) old.remove()
      if (!users.length) {
        row.removeAttribute('data-editors')
        continue
      }
      row.setAttribute('data-editors', users.map((u) => u.username).join('、'))
      const dot = el('span', {
        class: 'tree-presence-dot',
        style: `background:${users[0].color || '#4f9cf9'}`,
        attrs: { title: `正在编辑：${users.map((u) => u.username).join('、')}` },
      })
      row.append(dot)
    }
  }

  function renderPeer(peer) {
    const sameFile = peer.path && peer.path === state.currentPath
    const isSelf = peer.id && user.id && peer.id === user.id
    const color = peer.color || '#4f9cf9'
    const dot = el('span', {
      class: 'peer-dot',
      style: `background:${color};box-shadow:0 0 0 3px ${colorLight(color, 0.18)}`,
    })
    const cursorText = peer.cursor
      ? `${peer.cursor.line + 1}:${peer.cursor.ch + 1}`
      : '未在编辑'
    const row = el(
      'button',
      {
        class: `peer-row${sameFile ? ' is-current' : ''}${isSelf ? ' is-self' : ''}`,
        attrs: { type: 'button' },
        on: {
          click: async () => {
            if (!peer.path) {
              toastInfo(`${peer.username} 当前未打开任何文件`)
              return
            }
            await openFile(peer.path)
            if (peer.cursor && state.editor && state.editor.setCursor) {
              state.editor.setCursor(peer.cursor)
            }
          },
        },
      },
      dot,
      el(
        'div',
        { class: 'peer-main' },
        el(
          'div',
          { class: 'peer-line1' },
          el('span', { class: 'peer-name', text: peer.username || '匿名' }),
          isSelf ? el('span', { class: 'peer-tag', text: '我' }) : null,
        ),
        el('div', { class: 'peer-line2 mono', text: peer.path || '—' }),
      ),
      el('span', { class: 'peer-cursor mono', text: cursorText }),
    )
    return row
  }

  // ------------------------------------------------------------- interactions

  let sidebarCollapsed = lsGet(LS.sidebar, '0') === '1'
  function applySidebar() {
    shell.classList.toggle('sidebar-collapsed', sidebarCollapsed)
    lsSet(LS.sidebar, sidebarCollapsed ? '1' : '0')
  }
  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed
    applySidebar()
  }
  applySidebar()

  // Splitter drag with persisted ratio.
  let splitRatio = Number(lsGet(LS.split, '0.52'))
  if (!Number.isFinite(splitRatio)) splitRatio = 0.52
  splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, splitRatio))
  function applySplit() {
    center.style.setProperty('--split', `${(splitRatio * 100).toFixed(2)}%`)
  }
  applySplit()

  let dragging = false
  const onSplitMove = (ev) => {
    if (!dragging) return
    const rect = center.getBoundingClientRect()
    if (!rect.width) return
    const ratio = (ev.clientX - rect.left) / rect.width
    splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio))
    applySplit()
  }
  const onSplitUp = () => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('is-resizing')
    lsSet(LS.split, String(splitRatio))
    state.editor && state.editor.layout && state.editor.layout()
  }
  splitter.addEventListener('pointerdown', (ev) => {
    dragging = true
    splitter.setPointerCapture?.(ev.pointerId)
    document.body.classList.add('is-resizing')
  })
  window.addEventListener('pointermove', onSplitMove)
  window.addEventListener('pointerup', onSplitUp)

  // Ctrl/Cmd+S is meaningless here: the server persists every change.
  const onKeyDown = (ev) => {
    const mod = ev.ctrlKey || ev.metaKey
    if (mod && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault()
      toastInfo('已开启实时保存，编辑内容会自动同步到服务端')
    }
  }
  window.addEventListener('keydown', onKeyDown, true)

  // Keep Monaco sized with its pane.
  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (state.editor && state.editor.layout) state.editor.layout()
        })
      : null
  if (resizeObserver) resizeObserver.observe(editorHost)

  function applyUser(next) {
    state.user = { ...state.user, ...next }
    userDot.style.background = state.user.color || '#4f9cf9'
    userChip.querySelector('.user-name').textContent = state.user.username
    const badge = userChip.querySelector('.badge')
    badge.className = `badge badge-${state.user.role === 'admin' ? 'admin' : 'user'}`
    badge.textContent = state.user.role
    adminBtn.style.display = state.user.role === 'admin' ? '' : 'none'
    onUserUpdate && onUserUpdate(state.user)
  }

  function openSettingsDialog() {
    openSettings({ user: state.user, onUserUpdate: (next) => applyUser(next) })
  }

  async function doLogout() {
    const ok = await confirmDialog({
      title: '退出登录',
      message: '确定要退出当前账号吗？未同步的本地改动将丢失（正常情况下服务端已实时保存）。',
      confirmLabel: '退出登录',
      danger: true,
    })
    if (!ok) return
    try {
      await api.logout()
    } catch {
      /* logging out locally is enough */
    }
    onLogout()
  }

  // ------------------------------------------------------------------ boot

  renderSave()
  renderStatus()
  preview.renderEmpty('无可预览内容', '打开一个 Markdown 文件即可实时预览')
  // Restore the file the user had open last time (only if it still exists).
  reloadTree().then(() => {
    if (state.destroyed) return
    const lastPath = lsGet('mc.lastPath', '')
    if (lastPath && hasPath(state.tree, lastPath)) openFile(lastPath).catch(() => {})
  })

  return () => {
    state.destroyed = true
    if (saveFallbackTimer) {
      clearTimeout(saveFallbackTimer)
      saveFallbackTimer = null
    }
    if (state.currentPath) {
      lsSet('mc.lastPath', state.currentPath)
      collab.leaveFile(state.currentPath)
    }
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('pointermove', onSplitMove)
    window.removeEventListener('pointerup', onSplitUp)
    resizeObserver && resizeObserver.disconnect()
    try {
      if (state.editorObserver) state.editorObserver.ytext.unobserve(state.editorObserver.fn)
    } catch {
      /* ignore */
    }
    state.editor && state.editor.destroy && state.editor.destroy()
    state.editor = null
    preview.destroy()
    collab.destroy()
    tree.destroy && tree.destroy()
    host.innerHTML = ''
  }
}
