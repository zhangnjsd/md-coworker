// Monaco editor pane for non-markdown source files, collaborative through y-monaco.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'

// Only the plain editor worker is needed (no TS/JSON/CSS language services).
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

// Syntax highlighting is provided by lazily loaded basic-language tokenizers.
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'

monaco.editor.defineTheme('mc-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7a8d', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'string', foreground: 'a5d6a7' },
    { token: 'number', foreground: 'f2c17b' },
    { token: 'type', foreground: '7fd1c1' },
  ],
  colors: {
    'editor.background': '#11151b',
    'editor.foreground': '#dbe3ee',
    'editor.lineHighlightBackground': '#ffffff09',
    'editorLineNumber.foreground': '#4b5766',
    'editorLineNumber.activeForeground': '#98a6b8',
    'editor.selectionBackground': '#4f9cf947',
    'editorCursor.foreground': '#4f9cf9',
    'editorIndentGuide.background1': '#1e2530',
    'editorGutter.background': '#11151b',
    'editorWidget.background': '#161c24',
    'editorSuggestWidget.background': '#161c24',
  },
})

const LANG_BY_EXT = {
  rs: 'rust',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'javascript',
  jsonc: 'javascript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  sql: 'sql',
  go: 'go',
  java: 'java',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  lua: 'lua',
  kt: 'kotlin',
  swift: 'swift',
  dockerfile: 'dockerfile',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  md: 'markdown',
  markdown: 'markdown',
}

export function languageForPath(path) {
  const name = String(path || '').split('/').pop() || ''
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  const ext = lower.includes('.') ? lower.split('.').pop() : ''
  return LANG_BY_EXT[ext] || 'plaintext'
}

export function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(String(path || ''))
}

// ---------------------------------------------------------------------------
// Remote cursor styling: y-monaco only adds CSS classes, the colours and name
// labels have to be generated from the awareness states.
const STYLE_ID = 'mc-monaco-remote-cursors'
function ensureStyleNode() {
  let node = document.getElementById(STYLE_ID)
  if (!node) {
    node = document.createElement('style')
    node.id = STYLE_ID
    document.head.appendChild(node)
  }
  return node
}

function escapeCssText(value) {
  return String(value).replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')
}

/**
 * @param {import('y-protocols/awareness').Awareness} awareness
 * @param {number} ownClientId
 */
function createCursorPainter(awareness, ownClientId) {
  const node = ensureStyleNode()
  let last = ''
  const paint = () => {
    const chunks = []
    awareness.getStates().forEach((state, clientID) => {
      if (clientID === ownClientId) return
      const user = state.user || {}
      const color = user.color || '#4f9cf9'
      const name = escapeCssText(user.name || '匿名')
      chunks.push(
        `.monaco-editor .yRemoteSelection-${clientID} { background: ${hexToRgba(color, 0.26)}; }`,
        `.monaco-editor .yRemoteSelectionHead-${clientID} { border-left: 2px solid ${color}; }`,
        `.monaco-editor .yRemoteSelectionHead-${clientID}::after { content: "${name}"; background: ${color}; }`,
      )
    })
    const css = chunks.join('\n')
    if (css === last) return
    last = css
    node.textContent = css
  }
  paint()
  const handler = (_changes, origin) => {
    if (origin) paint()
  }
  awareness.on('change', handler)
  return {
    destroy() {
      awareness.off('change', handler)
      node.textContent = ''
    },
  }
}

function hexToRgba(hex, alpha) {
  const value = String(hex || '').replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const num = parseInt(full.slice(0, 6) || '4f9cf9', 16)
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * @param {{
 *   parent: HTMLElement,
 *   path: string,
 *   ytext: Y.Text,
 *   awareness: import('y-protocols/awareness').Awareness,
 *   onCursor?: (pos: {line: number, ch: number}) => void,
 *   onScroll?: (ratio: number) => void,
 *   readOnly?: boolean,
 * }} opts
 */
export function createCodeEditor(opts) {
  const { parent, path, ytext, awareness, onCursor, onScroll, readOnly = false } = opts
  const language = languageForPath(path)

  const editor = monaco.editor.create(parent, {
    value: '',
    language,
    theme: 'mc-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13.5,
    fontFamily:
      "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: 22,
    renderLineHighlight: 'all',
    scrollBeyondLastLine: true,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    padding: { top: 10, bottom: 24 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    overviewRulerLanes: 0,
    renderWhitespace: 'selection',
    tabSize: 2,
    readOnly,
    wordWrap: 'off',
    contextmenu: true,
  })

  const model = monaco.editor.createModel(ytext.toString(), language)
  editor.setModel(model)

  const binding = new MonacoBinding(ytext, model, new Set([editor]), awareness)
  const painter = createCursorPainter(awareness, ytext.doc.clientID)

  // y-monaco publishes `selection`; mirror it as `cursor` for CodeMirror peers.
  let publishing = false
  const cursorSub = editor.onDidChangeCursorSelection(() => {
    const sel = editor.getSelection()
    if (!sel) return
    if (!publishing) {
      publishing = true
      try {
        awareness.setLocalStateField('cursor', {
          anchor: Y.createRelativePositionFromTypeIndex(
            ytext,
            model.getOffsetAt(sel.getStartPosition()),
          ),
          head: Y.createRelativePositionFromTypeIndex(
            ytext,
            model.getOffsetAt(sel.getEndPosition()),
          ),
        })
        publishing = false
      } catch {
        publishing = false
      }
    }
    const pos = sel.getPosition()
    onCursor && onCursor({ line: pos.lineNumber - 1, ch: pos.column - 1 })
  })

  const scrollSub = onScroll
    ? editor.onDidScrollChange(() => {
        const layout = editor.getLayoutInfo()
        const max = editor.getScrollHeight() - layout.height
        onScroll(max > 4 ? Math.min(1, Math.max(0, editor.getScrollTop() / max)) : 0)
      })
    : null

  return {
    kind: 'monaco',
    editor,
    focus() {
      editor.focus()
    },
    cursor() {
      const pos = editor.getPosition()
      return pos ? { line: pos.lineNumber - 1, ch: pos.column - 1 } : { line: 0, ch: 0 }
    },
    setCursor(pos) {
      if (!pos || typeof pos.line !== 'number') return false
      const lineNumber = Math.min(
        Math.max(1, pos.line + 1),
        Math.max(1, model.getLineCount()),
      )
      const column = Math.min(Math.max(1, (pos.ch || 0) + 1), model.getLineMaxColumn(lineNumber))
      editor.setPosition({ lineNumber, column })
      editor.revealPositionInCenter({ lineNumber, column })
      editor.focus()
      return true
    },
    scrollToRatio(ratio) {
      const layout = editor.getLayoutInfo()
      const max = editor.getScrollHeight() - layout.height
      editor.setScrollTop(max > 0 ? max * Math.min(1, Math.max(0, ratio)) : 0)
    },
    text() {
      return model.getValue()
    },
    layout() {
      editor.layout()
    },
    destroy() {
      cursorSub.dispose()
      scrollSub && scrollSub.dispose()
      painter.destroy()
      try {
        binding.destroy()
      } catch {
        /* ignore */
      }
      try {
        model.dispose()
      } catch {
        /* ignore */
      }
      try {
        if (awareness.getLocalState()) {
          awareness.setLocalStateField('cursor', null)
          awareness.setLocalStateField('selection', null)
        }
      } catch {
        /* ignore */
      }
      editor.dispose()
    },
  }
}
