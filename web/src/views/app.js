// Main workspace view (#/app).
import { api } from '../net/api.js'
import { CollabClient } from '../net/collab.js'
import { FileTree } from '../ui/tree.js'
import { confirmDialog, promptDialog } from '../ui/modal.js'
import { toastError, toastInfo, toastSuccess, toastWarn } from '../ui/toast.js'
import { countWords, el, fmtClock } from '../util/dom.js'
import { createMarkdownEditor } from '../editor/markdown.js'
import { createPreview } from '../editor/preview.js'
import { openSettings } from './settings.js'

// Monaco (3.4MB) loads lazily only for non-Markdown files; first paint uses CodeMirror only.
function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(path || '')
}

const LS = {
  sidebar: 'mc.ui.sidebarCollapsed',
  treeW: 'mc.ui.treeW',
  split: 'mc.ui.split',
  scrollSync: 'mc.ui.scrollSync',
}

const SPLIT_MIN = 0.22
const SPLIT_MAX = 0.85
const TREE_MIN = 200
const TREE_MAX = 460
const TREE_RAIL = 44

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

function baseName(path) {
  const parts = String(path || '').split('/')
  return parts[parts.length - 1] || ''
}

// ---------------------------------------------------------------- icon set
// Stroke icons only: 1.5px, currentColor, aria-hidden. Shell chrome never
// depends on an icon font or on per-file-type colour.

const ICON_PATHS = {
  settings:
    '<path d="M2.6 5.4h10.8M2.6 10.6h10.8" /><circle cx="6.1" cy="5.4" r="1.6" /><circle cx="10.2" cy="10.6" r="1.6" />',
  logout:
    '<path d="M6.2 3.4H4.1c-.6 0-1.1.5-1.1 1.1v7c0 .6.5 1.1 1.1 1.1h2.1" /><path d="M9.3 5.4 11.9 8l-2.6 2.6" /><path d="M11.9 8H6.6" />',
  shield:
    '<path d="M8 2.2 3.6 3.9v3.4c0 2.3 1.7 4.4 4.4 5.6 2.7-1.2 4.4-3.3 4.4-5.6V3.9z" /><path d="M6.1 7.9l1.5 1.4 2.5-2.6" />',
  users:
    '<circle cx="6.2" cy="6" r="2.2" /><path d="M2.5 13.1c0-2 1.7-3.4 3.7-3.4s3.7 1.4 3.7 3.4" /><path d="M10.4 4.1a2 2 0 0 1 0 3.9M11.3 9.8c1.5.4 2.4 1.6 2.4 3.3" />',
  plus: '<path d="M8 3.5v9M3.5 8h9" />',
  'folder-plus':
    '<path d="M2.25 5.4c0-.77.63-1.4 1.4-1.4h2.2c.42 0 .82.19 1.09.51l.71.85h5.9c.77 0 1.4.63 1.4 1.4v4.9c0 .77-.63 1.4-1.4 1.4H3.65c-.77 0-1.4-.63-1.4-1.4z" /><path d="M8 8.5v3M6.5 10h3" />',
  refresh:
    '<path d="M13.1 8A5.1 5.1 0 1 1 11.5 4.3" /><path d="M13.3 2.7v3.1h-3.1" />',
  'panel-left':
    '<rect x="2.4" y="3.1" width="11.2" height="9.8" rx="1.4" /><path d="M6.4 3.1v9.8" />',
  doc: '<path d="M4 2.4h4.7L12 5.7v7.9H4z" /><path d="M8.7 2.4v3.3H12" /><path d="M5.9 8.7h4.2M5.9 10.8h4.2" />',
}

function icon(name, size = 14) {
  return el('span', {
    attrs: { 'aria-hidden': 'true' },
    style: 'display:inline-flex',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${
      ICON_PATHS[name] || ICON_PATHS.doc
    }</svg>`,
  })
}

function iconBtn(name, label, onClick, extraClass = '') {
  return el(
    'button',
    {
      class: `icon-btn${extraClass ? ` ${extraClass}` : ''}`,
      attrs: { type: 'button', title: label, 'aria-label': label },
      on: { click: onClick },
    },
    icon(name, 15),
  )
}

function textBtn(name, label, onClick, extraClass = '') {
  return el(
    'button',
    {
      class: `btn btn-ghost btn-sm${extraClass ? ` ${extraClass}` : ''}`,
      attrs: { type: 'button' },
      on: { click: onClick },
    },
    icon(name, 14),
    el('span', { text: label }),
  )
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
    cursor: null,
    seenPeers: new Set(),
    words: 0,
    treeLoaded: false,
    destroyed: false,
  }

  host.innerHTML = ''
  host.className = 'view view-app'

  // ------------------------------------------------------------------ DOM

  const breadcrumb = el('div', { class: 'breadcrumb' }, el('span', { class: 'crumb-empty', text: '未打开文件' }))

  const connDot = el('span', { class: 'conn-dot' })
  const connText = el('span', { class: 'conn-text', text: '连接中…' })
  const connBadge = el('span', { class: 'conn-badge', attrs: { role: 'status' } }, connDot, connText)

  const saveDot = el('span', { class: 'save-dot' })
  const saveText = el('span', { class: 'save-text', text: '已保存' })
  const saveIndicator = el('span', { class: 'save-indicator', attrs: { role: 'status' } }, saveDot, saveText)

  const userDot = el('span', { class: 'dot', style: `background:${state.user.color || 'var(--fg-3)'}` })
  const userName = el('span', { class: 'user-name', text: state.user.username })
  const userBadge = el('span', {
    class: `badge badge-${state.user.role === 'admin' ? 'admin' : 'user'}`,
    text: state.user.role,
  })
  const userChip = el('div', { class: 'user-chip' }, userDot, userName, userBadge)

  const settingsBtn = iconBtn('settings', '打开设置', () => openSettingsDialog())
  const adminBtn = textBtn('shield', '管理后台', () => onNavigateAdmin())
  if (state.user.role !== 'admin') adminBtn.style.display = 'none'
  const logoutBtn = textBtn('logout', '退出登录', () => doLogout())

  const topbar = el(
    'header',
    { class: 'topbar' },
    el(
      'div',
      { class: 'topbar-left' },
      el('span', { class: 'brand-wordmark', text: 'md-coworker' }),
      el('span', { class: 'topbar-sep' }),
      breadcrumb,
    ),
    el(
      'div',
      { class: 'topbar-right' },
      connBadge,
      saveIndicator,
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
    onRetry: () => reloadTree(true),
  })
  tree.setLoading(true)

  const newFileBtn = iconBtn('plus', '新建文件', () => createEntry('file'))
  const newDirBtn = iconBtn('folder-plus', '新建文件夹', () => createEntry('dir'))
  const refreshBtn = iconBtn('refresh', '刷新文件树', () => reloadTree(true))
  const collapseBtn = iconBtn('panel-left', '收起文件树', () => toggleSidebar(), 'rail-toggle')
  const expandBtn = iconBtn('panel-left', '展开文件树', () => toggleSidebar(), 'rail-toggle')

  const sidebarRail = el(
    'div',
    { class: 'sidebar-rail' },
    expandBtn,
    iconBtn('plus', '新建文件', () => createEntry('file')),
    iconBtn('refresh', '刷新文件树', () => reloadTree(true)),
  )

  const sidebarResizer = el('div', {
    class: 'sidebar-resizer',
    attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '调整文件树宽度', title: '拖拽调整文件树宽度' },
  })

  const sidebar = el(
    'aside',
    { class: 'sidebar' },
    el(
      'div',
      { class: 'sidebar-head' },
      el('span', { class: 'sidebar-title', text: '文件' }),
      el('div', { class: 'sidebar-tools' }, newFileBtn, newDirBtn, refreshBtn, collapseBtn),
    ),
    el('div', { class: 'sidebar-body' }, treeHost),
    sidebarRail,
    sidebarResizer,
  )

  // ---------------------------------------------------------------- editors

  const editorHost = el('div', { class: 'editor-host' })
  const editorEmpty = el(
    'div',
    { class: 'pane-empty' },
    el(
      'div',
      { class: 'pane-empty-inner' },
      el('span', { class: 'pane-empty-icon' }, icon('doc', 28)),
      el('span', { class: 'pane-empty-title', text: '还没有打开文件' }),
      el('span', {
        class: 'pane-empty-hint',
        text: '从左侧文件树选一个文件；没有文件就用上方 新建文件 创建第一个 .md',
      }),
    ),
  )
  const editorMeta = el('span', { class: 'pane-meta', text: '' })
  const editorPane = el(
    'section',
    { class: 'pane pane-editor' },
    el('div', { class: 'pane-head' }, el('span', { class: 'pane-title', text: '编辑' }), editorMeta),
    el('div', { class: 'pane-body' }, editorHost, editorEmpty),
  )

  const previewHost = el('div', { class: 'preview-host markdown-body' })
  const previewMeta = el('span', { class: 'pane-meta', text: '' })
  const syncToggle = el('button', {
    class: 'chip-toggle is-on',
    attrs: { type: 'button', title: '切换预览滚动同步' },
    text: '滚动同步',
    on: { click: () => toggleScrollSync() },
  })
  const previewPane = el(
    'section',
    { class: 'pane pane-preview' },
    el('div', { class: 'pane-head' }, el('span', { class: 'pane-title', text: '预览' }), previewMeta, syncToggle),
    el('div', { class: 'pane-body' }, previewHost),
  )

  const splitter = el('div', { class: 'splitter', attrs: { role: 'separator', 'aria-orientation': 'vertical' } })
  const center = el('div', { class: 'center' }, editorPane, splitter, previewPane)

  // ------------------------------------------------------------ collab panel

  const collabCount = el(
    'span',
    { class: 'collab-count' },
    '在线 ',
    el('span', { class: 'collab-count-num', text: '0' }),
    ' 人',
  )
  const presenceList = el('div', { class: 'collab-list' })

  // You are always in the rail — the list is never empty, and your own
  // cursor position updates live in the same row shape as everyone else's.
  const selfCursor = el('span', { class: 'peer-cursor', text: '行 1, 列 1' })
  const selfFile = el('span', { class: 'peer-file', text: '未打开文件' })
  const selfRow = el(
    'div',
    { class: 'peer-row is-me' },
    el('span', { class: 'peer-dot', style: `background:${state.user.color || 'var(--fg-3)'}` }),
    el(
      'span',
      { class: 'peer-name' },
      state.user.username,
      el('span', { class: 'peer-tag', text: '你' }),
    ),
    selfCursor,
    selfFile,
  )
  const collabPanel = el(
    'aside',
    { class: 'collab-panel' },
    el('div', { class: 'collab-head' }, el('span', { class: 'collab-title', text: '协作' }), collabCount),
    presenceList,
  )

  // -------------------------------------------------------------- status bar

  const statusCursor = el('span', { class: 'status-item', text: '行 1, 列 1' })
  const statusWords = el('span', { class: 'status-item', text: '0 字' })
  const statusOnline = el('span', { class: 'status-item', text: '在线 0 人' })
  const statusFile = el('span', { class: 'status-path', text: '—' })
  const statusSave = el('span', { class: 'status-item', text: '已保存' })
  const statusbar = el(
    'footer',
    { class: 'statusbar' },
    statusFile,
    el('div', { class: 'status-right' }, statusCursor, statusWords, statusOnline, statusSave),
  )

  const shell = el(
    'div',
    { class: 'app-shell' },
    topbar,
    el('div', { class: 'app-body' }, sidebar, center, collabPanel),
    statusbar,
  )
  host.append(shell)

  // ------------------------------------------------------------ collab setup

  const collab = new CollabClient({
    user: state.user,
    onStatus: (status) => {
      if (status === 'open') {
        connText.textContent = '已连接'
        connBadge.classList.add('is-online')
        connBadge.classList.remove('is-offline')
      } else if (status === 'connecting') {
        connText.textContent = '连接中…'
        connBadge.classList.remove('is-online', 'is-offline')
      } else {
        connText.textContent = '已断开'
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
    if (!state.treeLoaded) tree.setLoading(true)
    try {
      const data = await api.files()
      state.tree = Array.isArray(data.tree) ? data.tree : []
      state.treeLoaded = true
      tree.setTree(state.tree)
      paintTreePresence()
      if (notify) toastSuccess('文件列表已刷新')
    } catch (err) {
      tree.setError(err.message || '无法加载文件列表')
      toastError(err.message || '文件树加载失败，请检查网络后重试')
    }
  }

  async function createEntry(kind) {
    const dir = state.currentPath ? parentPath(state.currentPath) : ''
    const result = await promptDialog({
      title: kind === 'file' ? '新建文件' : '新建文件夹',
      subtitle: '路径相对于工作区根目录',
      label: kind === 'file' ? '文件路径' : '文件夹路径',
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
      toastSuccess(kind === 'file' ? `已创建 ${path}` : `已创建文件夹 ${path}`)
    } catch (err) {
      toastError(err.message || '创建失败，请换一个路径后重试')
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
      toastError(err.message || '重命名失败，请检查目标路径是否已存在')
    }
  }

  async function deleteEntry(path) {
    const ok = await confirmDialog({
      title: '删除文件',
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
      toastError(err.message || '删除失败，请确认文件是否仍存在')
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
    previewMeta.textContent = ''
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
    // Re-rendering the tree drops the presence dots; put them back immediately.
    paintTreePresence()

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
      toastError(err.message || '无法打开文件，请稍后重试')
      return
    }
    if (state.destroyed || state.currentPath !== path) return

    const ytext = session.ydoc.getText('content')
    const md = isMarkdownPath(path)
    editorEmpty.style.display = 'none'
    previewMeta.textContent = md ? 'gfm · 只读' : baseName(path)

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
    breadcrumb.innerHTML = ''
    if (!state.currentPath) {
      breadcrumb.append(el('span', { class: 'crumb-empty', text: '未打开文件' }))
      statusFile.textContent = '—'
      return
    }
    const parts = state.currentPath.split('/')
    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1
      breadcrumb.append(el('span', { class: `crumb${isLast ? ' crumb-current' : ''}`, text: part }))
      if (!isLast) breadcrumb.append(el('span', { class: 'crumb-sep', text: '/' }))
    })
    statusFile.textContent = state.currentPath
  }

  function renderSave() {
    const saving = state.saveState === 'saving'
    saveDot.className = `save-dot${saving ? ' is-saving' : ' is-saved'}`
    saveText.textContent = saving ? '保存中…' : '已保存'
    saveIndicator.title = state.saveAt ? `最后保存 ${fmtClock(state.saveAt)}` : '编辑内容已实时保存'
    statusSave.textContent = saving ? '保存中…' : '已保存'
    statusSave.title = state.saveAt ? `最后保存 ${fmtClock(state.saveAt)}` : '编辑内容已实时保存'
  }

  function renderCursor(pos) {
    if (!pos) return
    state.cursor = pos
    const label = `行 ${pos.line + 1}, 列 ${pos.ch + 1}`
    statusCursor.textContent = label
    selfCursor.textContent = label
  }

  function renderWords() {
    statusWords.textContent = `${state.words} 字`
  }

  function renderStatus() {
    statusOnline.textContent = `在线 ${state.online} 人`
    collabCount.replaceChildren('在线 ', el('span', { class: 'collab-count-num', text: String(state.online) }), ' 人')
    statusFile.textContent = state.currentPath || '—'
    if (state.currentPath) {
      selfFile.replaceChildren(
        '正在编辑 ',
        el('span', { class: 'peer-file-name', text: baseName(state.currentPath) }),
      )
    } else {
      selfFile.textContent = '未打开文件'
    }
    renderSave()
    renderWords()
  }

  function renderPresence(users) {
    state.presence = users || []
    state.online = state.presence.length
    presenceList.innerHTML = ''
    presenceList.append(selfRow)

    const others = state.presence.filter((peer) => !(peer.id && state.user.id && peer.id === state.user.id))
    if (!others.length) {
      presenceList.append(
        el(
          'div',
          { class: 'collab-empty' },
          el('span', { class: 'collab-empty-title', text: '现在只有你在线' }),
          el('span', {
            class: 'collab-empty-hint',
            text: '把同一个文件名分享给同事，打开后就能看到彼此的光标',
          }),
        ),
      )
    } else {
      const sorted = [...others].sort((a, b) => {
        const aSame = a.path === state.currentPath ? 0 : 1
        const bSame = b.path === state.currentPath ? 0 : 1
        if (aSame !== bSame) return aSame - bSame
        return String(a.username).localeCompare(String(b.username))
      })
      for (const peer of sorted) {
        presenceList.append(renderPeer(peer, !state.seenPeers.has(peer.id)))
      }
    }
    state.seenPeers = new Set(state.presence.map((peer) => peer.id))
    paintTreePresence()
    renderStatus()
  }

  // Mark "who is editing this file" on the file tree (the second job of live presence)
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
        style: `background:${users[0].color || 'var(--fg-3)'}`,
        attrs: { title: `正在编辑：${users.map((u) => u.username).join('、')}` },
      })
      const actions = row.querySelector('.tree-row-actions')
      if (actions) row.insertBefore(dot, actions)
      else row.append(dot)
    }
  }

  function renderPeer(peer, isNew) {
    const sameFile = peer.path && peer.path === state.currentPath
    const color = peer.color || 'var(--fg-3)'
    const dot = el('span', { class: 'peer-dot', style: `background:${color}` })
    const cursorText = peer.cursor ? `行 ${peer.cursor.line + 1}, 列 ${peer.cursor.ch + 1}` : '—'
    const fileLine = peer.path
      ? el('span', { class: 'peer-file' }, '正在编辑 ', el('span', { class: 'peer-file-name', text: baseName(peer.path) }))
      : el('span', { class: 'peer-file', text: '未打开文件' })
    const row = el(
      'button',
      {
        class: `peer-row${sameFile ? ' is-current' : ''}${isNew ? ' is-new' : ''}`,
        attrs: { type: 'button', title: peer.path ? `打开 ${peer.path}` : `${peer.username} 未打开文件` },
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
      el('span', { class: 'peer-name', text: peer.username || '匿名' }),
      el('span', { class: 'peer-cursor', text: cursorText }),
      fileLine,
    )
    return row
  }

  // ------------------------------------------------------------- interactions

  let sidebarCollapsed = lsGet(LS.sidebar, '0') === '1'
  let treeWidth = Number(lsGet(LS.treeW, '0')) || 0
  if (treeWidth) treeWidth = Math.min(TREE_MAX, Math.max(TREE_MIN, treeWidth))

  function applyTreeWidth() {
    if (sidebarCollapsed) {
      shell.style.setProperty('--tree-w', `${TREE_RAIL}px`)
      return
    }
    if (treeWidth) shell.style.setProperty('--tree-w', `${Math.round(treeWidth)}px`)
    else shell.style.removeProperty('--tree-w')
  }

  function applySidebar() {
    shell.classList.toggle('sidebar-collapsed', sidebarCollapsed)
    lsSet(LS.sidebar, sidebarCollapsed ? '1' : '0')
    applyTreeWidth()
  }
  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed
    applySidebar()
    state.editor && state.editor.layout && state.editor.layout()
  }
  applySidebar()

  // Sidebar width drag with persisted width.
  let resizingTree = false
  const onTreeMove = (ev) => {
    if (!resizingTree) return
    const rect = shell.getBoundingClientRect()
    treeWidth = Math.min(TREE_MAX, Math.max(TREE_MIN, ev.clientX - rect.left))
    applyTreeWidth()
  }
  const onTreeUp = () => {
    if (!resizingTree) return
    resizingTree = false
    sidebarResizer.classList.remove('is-dragging')
    document.body.classList.remove('is-resizing')
    if (treeWidth) lsSet(LS.treeW, String(Math.round(treeWidth)))
    state.editor && state.editor.layout && state.editor.layout()
  }
  sidebarResizer.addEventListener('pointerdown', (ev) => {
    if (sidebarCollapsed) return
    resizingTree = true
    sidebarResizer.classList.add('is-dragging')
    sidebarResizer.setPointerCapture?.(ev.pointerId)
    document.body.classList.add('is-resizing')
  })
  window.addEventListener('pointermove', onTreeMove)
  window.addEventListener('pointerup', onTreeUp)

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
    userDot.style.background = state.user.color || 'var(--fg-3)'
    userName.textContent = state.user.username
    userBadge.className = `badge badge-${state.user.role === 'admin' ? 'admin' : 'user'}`
    userBadge.textContent = state.user.role
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
    window.removeEventListener('pointermove', onTreeMove)
    window.removeEventListener('pointerup', onTreeUp)
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
