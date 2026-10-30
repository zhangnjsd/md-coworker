// Markdown preview: markdown-it + KaTeX + Mermaid + highlight.js, sanitized by DOMPurify.
import MarkdownIt from 'markdown-it'
import katexPluginModule from '@vscode/markdown-it-katex'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark-dimmed.css'

const katexPlugin = katexPluginModule && katexPluginModule.default ? katexPluginModule.default : katexPluginModule

const RENDER_THROTTLE_MS = 120

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
})

try {
  md.use(katexPlugin, {
    throwOnError: false,
    errorColor: '#f26d6d',
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml',
  })
} catch (err) {
  console.warn('[preview] katex plugin failed to load', err)
}

let mermaidCounter = 0

// Mermaid 体积约 2.7MB，只有在文档里真的出现 ```mermaid 时才按需加载。
let mermaidLoader = null
function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid')
      .then((mod) => {
        const mermaid = mod.default || mod
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
          fontFamily: "'Inter', 'Noto Sans SC', system-ui, sans-serif",
          themeVariables: {
            background: '#11151b',
            primaryColor: '#1c2532',
            primaryTextColor: '#dbe3ee',
            primaryBorderColor: '#334155',
            lineColor: '#7c8ca1',
            secondaryColor: '#1a2331',
            tertiaryColor: '#141b24',
          },
        })
        return mermaid
      })
      .catch((err) => {
        mermaidLoader = null
        throw err
      })
  }
  return mermaidLoader
}

// ---------------------------------------------------------------- rendering

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const info = (token.info || '').trim()
  const lang = info.split(/\s+/)[0].toLowerCase()
  const code = token.content

  if (lang === 'mermaid') {
    mermaidCounter += 1
    return `<div class="mermaid-block" data-mermaid="${mermaidCounter}"><div class="mermaid">${escapeHtml(
      code,
    )}</div><div class="mermaid-hint">Mermaid 图表</div></div>`
  }

  let body
  let detected = lang
  if (lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      body = escapeHtml(code)
    }
  } else {
    const auto = hljs.highlightAuto(code)
    body = auto.value
    detected = detected || auto.language || ''
  }

  return (
    `<div class="code-block"><div class="code-block-head"><span class="code-lang">${escapeHtml(
      detected || 'text',
    )}</span></div><pre class="hljs"><code>${body}</code></pre></div>`
  )
}

// Links open outside the SPA but never hand the opener over to the target page.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const PURIFY_CONFIG = {
  ADD_ATTR: ['target', 'rel', 'class', 'style', 'align', 'colspan', 'rowspan'],
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
}

/**
 * Render every Mermaid block inside `host`, replacing failures with an error
 * placeholder instead of letting one bad diagram break the whole preview.
 * @param {HTMLElement} host
 */
async function renderMermaid(host) {
  const nodes = [...host.querySelectorAll('.mermaid')]
  if (!nodes.length) return
  const mermaid = await loadMermaid()
  for (const node of nodes) {
    const source = node.textContent || ''
    if (!source.trim()) continue
    try {
      await mermaid.run({ nodes: [node], suppressErrors: true })
      node.classList.add('mermaid-rendered')
    } catch (err) {
      const wrap = document.createElement('div')
      wrap.className = 'mermaid-error'
      wrap.innerHTML = `<div class="mermaid-error-title">Mermaid 渲染失败</div><pre>${escapeHtml(
        source,
      )}</pre><div class="mermaid-error-msg">${escapeHtml(String(err && err.message ? err.message : err))}</div>`
      if (node.parentNode) node.parentNode.replaceChild(wrap, node)
    }
  }
}

/**
 * @param {{ container: HTMLElement, onScroll?: (ratio: number) => void }} opts
 */
export function createPreview(opts) {
  const { container, onScroll } = opts
  let pending = null
  let timer = null
  let renderToken = 0
  let mode = 'empty'

  const flush = () => {
    timer = null
    if (pending === null) return
    const source = pending
    pending = null
    renderToken += 1
    const token = renderToken
    mode = 'markdown'

    let html = ''
    try {
      html = md.render(source)
    } catch (err) {
      container.innerHTML = `<div class="preview-error">Markdown 渲染失败：${escapeHtml(
        String(err && err.message ? err.message : err),
      )}</div>`
      return
    }
    container.innerHTML = DOMPurify.sanitize(html, PURIFY_CONFIG)
    renderMermaid(container).catch((err) => {
      if (token === renderToken) console.warn('[preview] mermaid pass failed', err)
    })
  }

  const onScrollEvent = () => {
    if (!onScroll || mode !== 'markdown') return
    const max = container.scrollHeight - container.clientHeight
    onScroll(max > 4 ? Math.min(1, Math.max(0, container.scrollTop / max)) : 0)
  }
  container.addEventListener('scroll', onScrollEvent, { passive: true })

  return {
    /** Throttled markdown render. */
    render(source) {
      pending = String(source ?? '')
      if (timer) return
      timer = setTimeout(flush, RENDER_THROTTLE_MS)
    },
    /** Force an immediate render (file switch). */
    renderNow(source) {
      pending = String(source ?? '')
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      flush()
    },
    /** Read-only plain text preview for non-markdown files. */
    renderPlain(source, label) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
      mode = 'plain'
      container.innerHTML = `<div class="plain-wrap">${
        label ? `<div class="plain-label">${escapeHtml(label)}</div>` : ''
      }<pre class="plain-preview">${escapeHtml(String(source ?? ''))}</pre></div>`
    },
    /** Placeholder used when there is nothing to show. */
    renderEmpty(message, hint) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
      mode = 'empty'
      container.innerHTML = `<div class="preview-empty"><div class="preview-empty-icon">◍</div><div class="preview-empty-title">${escapeHtml(
        message || '无可预览内容',
      )}</div>${hint ? `<div class="preview-empty-hint">${escapeHtml(hint)}</div>` : ''}</div>`
    },
    scrollToRatio(ratio) {
      const max = container.scrollHeight - container.clientHeight
      container.scrollTop = max > 0 ? max * Math.min(1, Math.max(0, ratio)) : 0
    },
    destroy() {
      container.removeEventListener('scroll', onScrollEvent)
      if (timer) clearTimeout(timer)
      container.innerHTML = ''
    },
  }
}
