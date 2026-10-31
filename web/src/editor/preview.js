// Markdown preview: markdown-it + KaTeX + Mermaid + highlight.js, sanitized by DOMPurify.
import MarkdownIt from "markdown-it";
import katexPluginModule from "@vscode/markdown-it-katex";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";

const katexPlugin =
  katexPluginModule && katexPluginModule.default
    ? katexPluginModule.default
    : katexPluginModule;

const RENDER_THROTTLE_MS = 120;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});

try {
  md.use(katexPlugin, {
    throwOnError: false,
    errorColor: "#f26d6d",
    strict: "ignore",
    trust: false,
    output: "htmlAndMathml",
  });
} catch (err) {
  console.warn("[preview] katex plugin failed to load", err);
}

// Task lists: `- [ ]` / `- [x]` become a disabled checkbox. markdown-it ships no
// plugin for this and pulling one in for 12 lines would be silly.
function taskListRule(state) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "inline") continue;
    const children = tokens[i].children || [];
    const first = children[0];
    if (!first || first.type !== "text") continue;
    const match = /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) continue;
    let li = i - 1;
    while (li >= 0 && tokens[li].type !== "list_item_open") li--;
    if (li < 0) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input class="task-box" type="checkbox" disabled${
      match[1].toLowerCase() === "x" ? " checked" : ""
    }> `;
    children.unshift(box);
    tokens[li].attrJoin("class", "task-item");
  }
}
md.core.ruler.push("task_lists", taskListRule);

let mermaidCounter = 0;

// Mermaid is ~2.7MB, so load it on demand only when ```mermaid really appears in a document.
let mermaidLoader = null;
function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid")
      .then((mod) => {
        const mermaid = mod.default || mod;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          fontFamily:
            "'Geist Variable','PingFang SC','Noto Sans CJK SC',sans-serif",
          themeVariables: {
            background: "#1d2227",
            mainBkg: "#20262c",
            primaryColor: "#20262c",
            primaryTextColor: "#ebeff2",
            primaryBorderColor: "#343b43",
            secondaryColor: "#2a3036",
            tertiaryColor: "#191f25",
            textColor: "#b3b8be",
            lineColor: "#999fa6",
            nodeBorder: "#343b43",
            clusterBkg: "#191f25",
            clusterBorder: "#252b31",
            edgeLabelBackground: "#1d2227",
            noteBkgColor: "#20262c",
            noteTextColor: "#b3b8be",
            noteBorderColor: "#343b43",
          },
        });
        return mermaid;
      })
      .catch((err) => {
        mermaidLoader = null;
        throw err;
      });
  }
  return mermaidLoader;
}

// ---------------------------------------------------------------- rendering

// ------------------------------------------------------- scroll anchors
// Every top-level block carries the source line it starts on (`data-line`), so
// the editor and the preview can link scroll positions by line instead of by
// a document ratio, and so a re-render can put the reader back where they were.
const ANCHOR_TOKENS = new Set([
  "paragraph_open",
  "heading_open",
  "blockquote_open",
  "bullet_list_open",
  "ordered_list_open",
  "list_item_open",
  "table_open",
  "hr",
  "code_block",
  "html_block",
]);

function tagLineAnchors(tokens) {
  for (const token of tokens) {
    if (!token.map || !ANCHOR_TOKENS.has(token.type)) continue;
    token.attrSet("data-line", String(token.map[0] + 1));
  }
}

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  const lang = info.split(/\s+/)[0].toLowerCase();
  const code = token.content;
  const line = token.map ? ` data-line="${token.map[0] + 1}"` : "";

  if (lang === "mermaid") {
    mermaidCounter += 1;
    return `<div class="mermaid-block"${line} data-mermaid="${mermaidCounter}"><div class="mermaid">${escapeHtml(
      code,
    )}</div><div class="mermaid-hint">Mermaid 图表</div></div>`;
  }

  let body;
  let detected = lang;
  if (lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(code, {
        language: lang,
        ignoreIllegals: true,
      }).value;
    } catch {
      body = escapeHtml(code);
    }
  } else {
    const auto = hljs.highlightAuto(code);
    body = auto.value;
    detected = detected || auto.language || "";
  }

  return `<div class="code-block"${line}><div class="code-block-head"><span class="code-lang">${escapeHtml(
    detected || "text",
  )}</span></div><pre class="hljs"><code>${body}</code></pre></div>`;
};

// Uploaded assets live in the workspace, not in the built frontend, so an
// `![](assets/x.png)` has to be pointed at /api/raw. The current document's
// directory is the base for relative paths (set with `setBasePath`).
let basePath = "";

function normalizeRelPath(path) {
  const out = [];
  for (const raw of String(path).split("/")) {
    const part = raw.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// markdown-it hands over a URL it has already percent-encoded, so `Screenshot 1.png`
// arrives as `Screenshot%201.png`. Decode first, re-encode once at the end, otherwise
// the space becomes `%2520` and the request 404s.
function resolveAssetUrl(src) {
  const value = String(src || "").trim();
  if (!value) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return src;
  const cut = value.search(/[?#]/);
  const pathPart = cut >= 0 ? value.slice(0, cut) : value;
  const suffix = cut >= 0 ? value.slice(cut) : "";
  const decoded = decodePath(pathPart);
  // A leading slash means "from the workspace root", because the preview is not
  // served from the workspace and `/foo.png` would otherwise hit the SPA shell.
  const joined = decoded.startsWith("/")
    ? normalizeRelPath(decoded)
    : normalizeRelPath(baseDir() ? `${baseDir()}/${decoded}` : decoded);
  return `/api/raw?path=${encodeURIComponent(joined)}${suffix}`;
}

function baseDir() {
  const slash = basePath.lastIndexOf("/");
  return slash >= 0 ? basePath.slice(0, slash) : "";
}

// A missing asset should say which file is missing and offer the next step,
// instead of leaving the browser's broken-image icon in the middle of the text.
function markBrokenImage(img) {
  if (!img.isConnected || img.dataset.mcMissing === "1") return;
  if (img.naturalWidth > 0) return;
  img.dataset.mcMissing = "1";
  const src = img.getAttribute("src") || "";
  const shown = decodePath(
    src.replace(/^\/api\/raw\?path=/, "").split(/[?#]/)[0],
  );
  const notice = document.createElement("span");
  notice.className = "img-missing";
  notice.textContent = `图片无法加载：${shown || "未知路径"}`;
  if (src) {
    const link = document.createElement("a");
    link.href = src;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "单独打开";
    notice.append(" ", link);
  }
  img.replaceWith(notice);
}

// Links open outside the SPA but never hand the opener over to the target page.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src");
    if (src) node.setAttribute("src", resolveAssetUrl(src));
    node.setAttribute("loading", "lazy");
  }
});

const PURIFY_CONFIG = {
  ADD_ATTR: ["target", "rel", "class", "style", "align", "colspan", "rowspan"],
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick"],
};

/**
 * Render every Mermaid block inside `host`, replacing failures with an error
 * placeholder instead of letting one bad diagram break the whole preview.
 * @param {HTMLElement} host
 */
async function renderMermaid(host) {
  const nodes = [...host.querySelectorAll(".mermaid")];
  if (!nodes.length) return;
  const mermaid = await loadMermaid();
  for (const node of nodes) {
    const source = node.textContent || "";
    if (!source.trim()) continue;
    try {
      await mermaid.run({ nodes: [node], suppressErrors: true });
      node.classList.add("mermaid-rendered");
    } catch (err) {
      const wrap = document.createElement("div");
      wrap.className = "mermaid-error";
      wrap.innerHTML = `<div class="mermaid-error-title">Mermaid 渲染失败</div><pre>${escapeHtml(
        source,
      )}</pre><div class="mermaid-error-msg">${escapeHtml(String(err && err.message ? err.message : err))}</div>`;
      if (node.parentNode) node.parentNode.replaceChild(wrap, node);
    }
  }
}

/**
 * @param {{ container: HTMLElement, onScroll?: (pos: {line: number, frac: number}) => void }} opts
 */
export function createPreview(opts) {
  const { container, onScroll } = opts;
  let pending = null;
  let timer = null;
  let renderToken = 0;
  let mode = "empty";

  // Re-rendering replaces the whole subtree, which resets the scroll box and
  // used to yank the editor along with it. Every programmatic scroll is tagged
  // so it never feeds back into the editor, and a re-render puts the reader
  // back on the block they were looking at.
  let expectedScrollTop = null;
  let lastUserScrollAt = 0;
  let renderGuardUntil = 0;
  /**
   * Bumped whenever something asks for a specific position. A render that
   * started earlier must not drag the reader back to where it was then.
   */
  let syncSeq = 0;
  /** Where the reader "should" be: the last aimed-at position, not a stale capture. */
  let currentAnchor = null;

  const anchors = () => [...container.querySelectorAll("[data-line]")];
  const anchorLine = (el) => Number(el.getAttribute("data-line")) || 0;
  const anchorTop = (el) => {
    const box = container.getBoundingClientRect();
    return el.getBoundingClientRect().top - box.top + container.scrollTop;
  };

  /** Block currently crossing the top edge, plus how far into it we are. */
  const anchorAtTop = () => {
    const scrollTop = container.scrollTop;
    let found = null;
    let first = null;
    for (const el of anchors()) {
      const line = anchorLine(el);
      if (!line) continue;
      const top = anchorTop(el);
      if (!first) first = { el, line, top };
      if (top <= scrollTop + 1) found = { el, line, top };
      else break; // anchors appear in document order, so tops only grow
    }
    const anchor = found || first;
    if (!anchor) return null;
    const height = anchor.el.offsetHeight || 1;
    return {
      el: anchor.el,
      line: anchor.line,
      top: anchor.top,
      frac: Math.min(1, Math.max(0, (scrollTop - anchor.top) / height)),
    };
  };

  /** Block whose source line is `line` (or the closest one above it). */
  const anchorForLine = (line) => {
    let found = null;
    let first = null;
    for (const el of anchors()) {
      const value = anchorLine(el);
      if (!value) continue;
      if (!first) first = el;
      if (value <= line) found = el;
      else break;
    }
    return found || first;
  };

  // Suppress only the echo of our own write: the event carries the exact value
  // we just set, whereas anything else is the reader scrolling.
  const setScrollTop = (value) => {
    const max = container.scrollHeight - container.clientHeight;
    container.scrollTop = max > 0 ? Math.min(max, Math.max(0, value)) : 0;
    expectedScrollTop = container.scrollTop;
  };

  /** Put `line` at the top edge, `frac` of the way into that block. */
  const scrollToLine = (line, frac = 0) => {
    if (mode !== "markdown") return;
    syncSeq += 1;
    const wanted = Math.round(line) || 1;
    currentAnchor = { line: wanted, frac: Math.min(1, Math.max(0, frac)) };
    const el = anchorForLine(wanted);
    if (!el) return;
    const height = el.offsetHeight || 0;
    setScrollTop(anchorTop(el) + currentAnchor.frac * height);
  };

  const restoreAfterRender = (anchor) => {
    if (!anchor) return;
    const el = anchorForLine(anchor.line);
    if (!el) return;
    setScrollTop(anchorTop(el) + anchor.frac * (el.offsetHeight || 0));
  };

  /**
   * Late layout changes (images decoding, diagrams rendering) move the text the
   * reader is looking at. Re-anchor after each of them — but never fight a
   * scroll the user has just made themselves.
   */
  const restoreLater = (anchor) => {
    const wanted = currentAnchor || anchor;
    if (!wanted) return;
    if (performance.now() - lastUserScrollAt < 700) return;
    restoreAfterRender(wanted);
  };

  // Missing assets are reported even when there is no anchor to hold, so the sweep
  // runs for every render; only the re-anchoring needs a saved position.
  const reanchorOnMedia = (anchor) => {
    for (const img of container.querySelectorAll("img")) {
      const settle = () => {
        markBrokenImage(img);
        if (anchor) restoreLater(anchor);
      };
      if (img.complete) {
        settle();
        continue;
      }
      img.addEventListener("load", settle, { once: true });
      img.addEventListener("error", settle, { once: true });
    }
  };

  const flush = () => {
    timer = null;
    if (pending === null) return;
    const source = pending;
    pending = null;
    renderToken += 1;
    const token = renderToken;
    mode = "markdown";
    const keep = anchorAtTop();
    // Swapping the subtree collapses the scroll box and fires its own scroll
    // event; ignore scrolling until the reader is put back.
    renderGuardUntil = performance.now() + 150;
    const seq = syncSeq;

    let html = "";
    try {
      const env = {};
      const tokens = md.parse(source, env);
      tagLineAnchors(tokens);
      html = md.renderer.render(tokens, md.options, env);
    } catch (err) {
      container.innerHTML = `<div class="preview-error">Markdown 渲染失败：${escapeHtml(
        String(err && err.message ? err.message : err),
      )}</div>`;
      return;
    }
    container.innerHTML = DOMPurify.sanitize(html, PURIFY_CONFIG);
    if (seq === syncSeq) currentAnchor = keep;
    restoreAfterRender(currentAnchor || keep);
    reanchorOnMedia(currentAnchor || keep);
    renderMermaid(container)
      .then(() => {
        // Diagrams swap in asynchronously and change the page height, so the
        // reader has to be re-anchored once they land.
        if (token === renderToken) restoreLater(keep);
      })
      .catch((err) => {
        if (token === renderToken)
          console.warn("[preview] mermaid pass failed", err);
      });
  };

  const onScrollEvent = () => {
    if (mode !== "markdown") return;
    if (performance.now() < renderGuardUntil) return;
    if (expectedScrollTop !== null) {
      if (Math.abs(container.scrollTop - expectedScrollTop) <= 2) {
        expectedScrollTop = null;
        return;
      }
      expectedScrollTop = null;
    }
    const anchor = anchorAtTop();
    if (!anchor) return;
    syncSeq += 1;
    currentAnchor = { line: anchor.line, frac: anchor.frac };
    lastUserScrollAt = performance.now();
    if (onScroll) onScroll(currentAnchor);
  };
  container.addEventListener("scroll", onScrollEvent, { passive: true });

  return {
    /**
     * Tell the renderer which document is on screen, so relative image paths
     * resolve inside the workspace. Call it right after opening a file.
     * @param {string} path workspace-relative path of the open document
     */
    setBasePath(path) {
      basePath = String(path || "");
    },
    /** Throttled markdown render. */
    render(source) {
      pending = String(source ?? "");
      if (timer) return;
      timer = setTimeout(flush, RENDER_THROTTLE_MS);
    },
    /** Force an immediate render (file switch). */
    renderNow(source) {
      pending = String(source ?? "");
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    },
    /** Read-only plain text preview for non-markdown files. */
    renderPlain(source, label) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      mode = "plain";
      container.innerHTML = `<div class="plain-wrap">${
        label ? `<div class="plain-label">${escapeHtml(label)}</div>` : ""
      }<pre class="plain-preview">${escapeHtml(String(source ?? ""))}</pre></div>`;
    },
    /** Placeholder used when there is nothing to show. */
    renderEmpty(message, hint) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      mode = "empty";
      container.innerHTML = `<div class="preview-empty"><div class="preview-empty-icon">◍</div><div class="preview-empty-title">${escapeHtml(
        message || "无可预览内容",
      )}</div>${hint ? `<div class="preview-empty-hint">${escapeHtml(hint)}</div>` : ""}</div>`;
    },
    /** Follow the editor: put `line` (1-based) at the top, `frac` into it. */
    scrollToLine,
    destroy() {
      container.removeEventListener("scroll", onScrollEvent);
      if (timer) clearTimeout(timer);
      container.innerHTML = "";
    },
  };
}
