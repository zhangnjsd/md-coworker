// Collapsible file tree widget.
// Ink & Signal shell pass: mono-weight 1.5px outline icons, 28px rows,
// skeleton loading state, inline retry on failure, keyboard reachable rows.
import { el, clear } from '../util/dom.js'

const EXPANDED_KEY = 'mc.tree.expanded'

// ---------------------------------------------------------------- icon set
// Stroke icons only (1.5px, currentColor). No per-extension rainbow colours:
// the tree speaks in shape, the collaboration dots speak in colour.

const PATHS = {
  'chevron-right': '<path d="M6.25 3.75 10.75 8l-4.5 4.25" />',
  folder:
    '<path d="M2.25 5.4c0-.77.63-1.4 1.4-1.4h2.2c.42 0 .82.19 1.09.51l.71.85h5.9c.77 0 1.4.63 1.4 1.4v4.9c0 .77-.63 1.4-1.4 1.4H3.65c-.77 0-1.4-.63-1.4-1.4z" />',
  'folder-open':
    '<path d="M2.25 5.4c0-.77.63-1.4 1.4-1.4h2.2c.42 0 .82.19 1.09.51l.71.85h5.4c.77 0 1.4.63 1.4 1.4v.94" /><path d="M2.35 13.25 2.25 5.4" /><path d="M2.35 13.25a1 1 0 0 1-.97-1.24l.85-3.1c.15-.55.65-.93 1.22-.93h9.9c.83 0 1.42.8 1.19 1.6l-.98 3.26c-.14.45-.55.76-1.02.76z" />',
  doc: '<path d="M4 2.25h4.6L12 5.65v8.1H4z" /><path d="M8.6 2.25v3.4H12" /><path d="M5.9 8.6h4.2M5.9 10.8h4.2" />',
  code: '<path d="M6.1 4.9 3.1 8l3 3.1M9.9 4.9 12.9 8l-3 3.1" />',
  pencil:
    '<path d="M10.4 2.9a1.25 1.25 0 0 1 1.77 0l.93.93a1.25 1.25 0 0 1 0 1.77L6.4 12.3l-2.9.6.6-2.9z" /><path d="M9.5 3.8 12.2 6.5" />',
  trash:
    '<path d="M2.9 4.6h10.2" /><path d="M6.4 4.6V3.3h3.2v1.3" /><path d="M4.4 4.6l.6 8.1h6l.6-8.1" /><path d="M6.9 7.1v3.6M9.1 7.1v3.6" />',
}

function icon(name, size = 13) {
  return el('span', {
    class: 'tree-svg',
    attrs: { 'aria-hidden': 'true' },
    html: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${
      PATHS[name] || PATHS.doc
    }</svg>`,
  })
}

function extOf(name) {
  const idx = String(name).lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

function containsPath(nodes, path) {
  for (const node of nodes || []) {
    if (node.path === path) return true
    if (node.children && containsPath(node.children, path)) return true
  }
  return false
}

function rowIconName(node, open) {
  if (node.kind === 'dir') return open ? 'folder-open' : 'folder'
  const ext = extOf(node.name)
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'doc'
  if (ext === 'txt') return 'doc'
  return 'code'
}

export class FileTree {
  /**
   * @param {HTMLElement} host
   * @param {{
   *   onOpen?: (path: string) => void,
   *   onSelect?: (node: any) => void,
   *   onRename?: (node: any) => void,
   *   onDelete?: (node: any) => void,
   *   onRetry?: () => void,
   * }} opts
   */
  constructor(host, opts = {}) {
    this.host = host
    this.opts = opts
    this.nodes = []
    this.currentPath = null
    /* Last row the user activated — a file OR a directory. Uploads read it to
     * decide their target directory, so it is tracked separately from
     * currentPath (which only ever holds an opened file). */
    this.selectedPath = null
    this.loading = false
    this.error = ''
    /** @type {Set<string>} */
    this.expanded = new Set(this.#loadExpanded())
    this.host.classList.add('tree')
    this.host.addEventListener('contextmenu', (ev) => ev.preventDefault())
  }

  #loadExpanded() {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY)
      const arr = raw ? JSON.parse(raw) : []
      return Array.isArray(arr) ? arr.filter((v) => typeof v === 'string') : []
    } catch {
      return []
    }
  }

  #saveExpanded() {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...this.expanded]))
    } catch {
      /* ignore quota errors */
    }
  }

  /** Loading state: skeleton rows instead of a spinner. */
  setLoading(on) {
    this.loading = !!on
    if (this.loading) this.error = ''
    this.render()
  }

  /** Failure state: what happened, plus a way out. */
  setError(message) {
    this.error = message || '文件树加载失败'
    this.loading = false
    this.render()
  }

  setTree(nodes) {
    this.nodes = Array.isArray(nodes) ? nodes : []
    this.loading = false
    this.error = ''
    // A reload can delete the row that was selected (the upload target);
    // never keep pointing at something that is gone.
    if (this.selectedPath && !containsPath(this.nodes, this.selectedPath)) this.selectedPath = null
    if (this.currentPath) this.expandTo(this.currentPath, false)
    this.render()
  }

  setCurrent(path) {
    this.currentPath = path
    this.selectedPath = path || null
    if (path) this.expandTo(path, true)
    this.render()
    this.#revealCurrent()
  }

  /** @returns {string|null} file or directory path the user last activated. */
  getSelected() {
    return this.selectedPath
  }

  setSelected(path) {
    const next = path || null
    if (this.selectedPath === next) return
    this.selectedPath = next
    this.render()
  }

  expandTo(path, persist = true) {
    const parts = String(path).split('/')
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      this.expanded.add(prefix)
    }
    if (persist) this.#saveExpanded()
  }

  isExpanded(path) {
    return this.expanded.has(path)
  }

  toggleDir(path) {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else this.expanded.add(path)
    this.#saveExpanded()
    this.render()
  }

  collapseAll() {
    this.expanded.clear()
    this.#saveExpanded()
    this.render()
  }

  render() {
    clear(this.host)
    this.host.setAttribute('role', 'tree')
    this.host.toggleAttribute('aria-busy', this.loading)

    if (this.loading) {
      const widths = ['78%', '64%', '85%', '70%']
      const skeleton = el('div', { class: 'tree-skeleton', attrs: { 'aria-hidden': 'true' } })
      for (const width of widths) {
        skeleton.append(el('div', { class: 'skeleton', style: `width:${width}` }))
      }
      this.host.append(skeleton)
      return
    }

    if (this.error) {
      const state = el(
        'div',
        { class: 'tree-state' },
        el('span', { class: 'tree-state-title', text: '文件树加载失败' }),
        el('span', { class: 'tree-state-error', text: this.error }),
        el('span', { class: 'tree-state-hint', text: '检查网络后重试，或刷新整页。' }),
      )
      if (this.opts.onRetry) {
        state.append(
          el('button', {
            class: 'chrome-btn tree-retry',
            text: '重试加载',
            attrs: { type: 'button' },
            on: { click: () => this.opts.onRetry && this.opts.onRetry() },
          }),
        )
      }
      this.host.append(state)
      return
    }

    if (!this.nodes.length) {
      this.host.append(
        el(
          'div',
          { class: 'tree-state' },
          el('span', { class: 'tree-state-title', text: '还没有文件' }),
          el('span', { class: 'tree-state-hint', text: '用上方 新建文件 创建第一个 .md，或把文件拖进窗口上传' }),
        ),
      )
      return
    }

    this.host.append(this.#renderNodes(this.nodes, 0))
  }

  #renderNodes(nodes, depth) {
    const frag = document.createDocumentFragment()
    for (const node of nodes) {
      frag.append(this.#renderRow(node, depth))
      if (node.kind === 'dir' && this.expanded.has(node.path) && Array.isArray(node.children) && node.children.length) {
        frag.append(this.#renderNodes(node.children, depth + 1))
      }
    }
    return frag
  }

  #rows() {
    return Array.from(this.host.querySelectorAll('.tree-row'))
  }

  #focusRow(row) {
    if (row) row.focus()
  }

  #moveFocus(row, delta) {
    const rows = this.#rows()
    const index = rows.indexOf(row)
    if (index === -1) return
    const next = rows[index + delta]
    if (next) this.#focusRow(next)
  }

  #activate(node) {
    // Selecting a folder is meaningful now (it is the upload target), so the
    // highlight follows every activated row instead of files only.
    this.selectedPath = node.path || null
    if (this.opts.onSelect) this.opts.onSelect(node)
    if (node.kind === 'dir') this.toggleDir(node.path)
    else if (this.opts.onOpen) this.opts.onOpen(node.path)
  }

  #onKeyDown(ev, row, node, isDir, open) {
    switch (ev.key) {
      case 'Enter':
      case ' ':
        ev.preventDefault()
        this.#activate(node)
        break
      case 'ArrowRight':
        if (isDir && !open) {
          ev.preventDefault()
          this.toggleDir(node.path)
        }
        break
      case 'ArrowLeft':
        if (isDir && open) {
          ev.preventDefault()
          this.toggleDir(node.path)
        }
        break
      case 'ArrowDown':
        ev.preventDefault()
        this.#moveFocus(row, 1)
        break
      case 'ArrowUp':
        ev.preventDefault()
        this.#moveFocus(row, -1)
        break
      default:
        break
    }
  }

  #revealCurrent() {
    if (!this.currentPath) return
    const row = this.host.querySelector(`.tree-row[data-path="${this.currentPath.replace(/"/g, '\\"')}"]`)
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' })
    }
  }

  #renderRow(node, depth) {
    const isDir = node.kind === 'dir'
    const open = isDir && this.expanded.has(node.path)
    const active = Boolean(node.path) && node.path === this.selectedPath

    const caret = el(
      'span',
      { class: `tree-caret${open ? ' is-open' : ''}${isDir ? '' : ' is-hidden'}`, attrs: { 'aria-hidden': 'true' } },
      icon('chevron-right', 12),
    )

    const iconWrap = el('span', { class: 'tree-icon', attrs: { 'aria-hidden': 'true' } }, icon(rowIconName(node, open), 13))

    const attrs = {
      title: node.path || node.name,
      'data-path': node.path,
      role: 'treeitem',
      tabindex: '0',
      'data-kind': isDir ? 'dir' : 'file',
    }
    if (isDir) attrs['aria-expanded'] = open ? 'true' : 'false'
    if (active) attrs['aria-selected'] = 'true'

    const row = el(
      'div',
      {
        class: `tree-row${active ? ' active' : ''}${isDir ? ' is-dir' : ''}`,
        style: `padding-left:${8 + depth * 12}px`,
        attrs,
        on: {
          click: (ev) => {
            if (ev.target.closest('.tree-action')) return
            this.#activate(node)
          },
          keydown: (ev) => this.#onKeyDown(ev, row, node, isDir, open),
        },
      },
      caret,
      iconWrap,
      el('span', { class: 'tree-name', text: node.name }),
    )

    const actions = el('div', { class: 'tree-row-actions' })
    if (this.opts.onRename) {
      actions.append(
        el(
          'button',
          {
            class: 'tree-action',
            title: '重命名',
            attrs: { type: 'button', 'aria-label': `重命名 ${node.name}` },
            on: {
              click: (ev) => {
                ev.stopPropagation()
                this.opts.onRename(node)
              },
            },
          },
          icon('pencil', 12),
        ),
      )
    }
    if (this.opts.onDelete) {
      actions.append(
        el(
          'button',
          {
            class: 'tree-action tree-action-danger',
            title: '删除文件',
            attrs: { type: 'button', 'aria-label': `删除 ${node.name}` },
            on: {
              click: (ev) => {
                ev.stopPropagation()
                this.opts.onDelete(node)
              },
            },
          },
          icon('trash', 12),
        ),
      )
    }
    row.append(actions)
    return row
  }

  destroy() {
    clear(this.host)
  }
}
