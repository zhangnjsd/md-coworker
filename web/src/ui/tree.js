// Collapsible file tree widget.
import { el, svgIcon, clear } from '../util/dom.js'

const EXPANDED_KEY = 'mc.tree.expanded'

const EXT_ICON = {
  md: 'md',
  markdown: 'md',
  mdx: 'md',
  txt: 'txt',
  json: 'json',
  rs: 'rs',
  js: 'js',
  mjs: 'js',
  ts: 'ts',
  tsx: 'ts',
  jsx: 'js',
  toml: 'toml',
  yml: 'yml',
  yaml: 'yml',
  sh: 'sh',
  py: 'py',
  html: 'html',
  css: 'css',
}

function extOf(name) {
  const idx = String(name).lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

export class FileTree {
  /**
   * @param {HTMLElement} host
   * @param {{onOpen: (path: string) => void, onRename?: (path: string) => void, onDelete?: (path: string) => void}} opts
   */
  constructor(host, opts = {}) {
    this.host = host
    this.opts = opts
    this.nodes = []
    this.currentPath = null
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

  setTree(nodes) {
    this.nodes = Array.isArray(nodes) ? nodes : []
    if (this.currentPath) this.expandTo(this.currentPath, false)
    this.render()
  }

  setCurrent(path) {
    this.currentPath = path
    if (path) this.expandTo(path, true)
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
    if (!this.nodes.length) {
      this.host.appendChild(el('div', { class: 'tree-empty', text: '目录为空' }))
      return
    }
    this.host.appendChild(this.#renderNodes(this.nodes, 0))
  }

  #renderNodes(nodes, depth) {
    const frag = document.createDocumentFragment()
    for (const node of nodes) {
      frag.appendChild(this.#renderRow(node, depth))
      if (node.kind === 'dir' && this.expanded.has(node.path) && Array.isArray(node.children) && node.children.length) {
        frag.appendChild(this.#renderNodes(node.children, depth + 1))
      }
    }
    return frag
  }

  #renderRow(node, depth) {
    const isDir = node.kind === 'dir'
    const open = isDir && this.expanded.has(node.path)
    const active = !isDir && node.path === this.currentPath
    const ext = extOf(node.name)

    const caret = el(
      'span',
      { class: `tree-caret ${isDir ? '' : 'hidden'}`.trim() },
      svgIcon(open ? 'chevron-down' : 'chevron-right', 12),
    )

    const iconWrap = el('span', { class: `tree-icon ${isDir ? 'is-dir' : `ext-${EXT_ICON[ext] || 'file'}`}` },
      svgIcon(isDir ? (open ? 'folder-open' : 'folder') : 'file', 13),
    )

    const row = el(
      'div',
      {
        class: `tree-row ${active ? 'active' : ''}`.trim(),
        style: { paddingLeft: `${8 + depth * 14}px` },
        attrs: { title: node.path || node.name, 'data-path': node.path },
        on: {
          click: (ev) => {
            if (ev.target.closest('.tree-action')) return
            if (isDir) this.toggleDir(node.path)
            else this.opts.onOpen && this.opts.onOpen(node.path)
          },
          dblclick: () => {
            if (isDir) this.toggleDir(node.path)
          },
        },
      },
      caret,
      iconWrap,
      el('span', { class: 'tree-name', text: node.name }),
    )

    const actions = el('div', { class: 'tree-row-actions' })
    if (this.opts.onRename) {
      actions.appendChild(
        el(
          'button',
          {
            class: 'tree-action',
            title: '重命名',
            attrs: { type: 'button', 'aria-label': '重命名' },
            on: {
              click: (ev) => {
                ev.stopPropagation()
                this.opts.onRename(node)
              },
            },
          },
          svgIcon('pencil', 12),
        ),
      )
    }
    if (this.opts.onDelete) {
      actions.appendChild(
        el(
          'button',
          {
            class: 'tree-action tree-action-danger',
            title: '删除',
            attrs: { type: 'button', 'aria-label': '删除' },
            on: {
              click: (ev) => {
                ev.stopPropagation()
                this.opts.onDelete(node)
              },
            },
          },
          svgIcon('trash', 12),
        ),
      )
    }
    row.appendChild(actions)
    return row
  }

  destroy() {
    clear(this.host)
  }
}
