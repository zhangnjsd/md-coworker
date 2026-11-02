// Tiny DOM helpers: element factory, icon set, formatting, clipboard, download.

/**
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 */
export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === "class" || key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "style" && typeof value === "object")
        Object.assign(node.style, value);
      else if (key === "dataset" && typeof value === "object")
        Object.assign(node.dataset, value);
      else if (key === "on" && typeof value === "object") {
        for (const [evt, fn] of Object.entries(value))
          if (typeof fn === "function") node.addEventListener(evt, fn);
      } else if (key === "attrs" && typeof value === "object") {
        for (const [attr, val] of Object.entries(value)) {
          if (val != null && val !== false)
            node.setAttribute(attr, String(val));
        }
      } else if (key in node && typeof value !== "object") {
        try {
          node[key] = value;
        } catch {
          node.setAttribute(key, String(value));
        }
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

/** @param {Node} node @param {any} children */
export function appendChildren(node, children) {
  for (const child of children.flat(4)) {
    if (child == null || child === false || child === true) continue;
    node.appendChild(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}

/** @param {Element} node */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const ICONS = {
  folder:
    '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.8 2h8A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  "folder-open":
    '<path d="M3 8V6.5A2.5 2.5 0 0 1 5.5 4h3.2l1.8 2h7A2.5 2.5 0 0 1 20 8.5V10"/><path d="M3 10h18l-2.2 7.4A2 2 0 0 1 16.9 19H5.4a2 2 0 0 1-1.9-1.4z"/>',
  file: '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>',
  "chevron-right": '<path d="M9.5 6.5 15 12l-5.5 5.5"/>',
  "chevron-down": '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',
  trash:
    '<path d="M4 6.5h16"/><path d="M9.5 6.5V4.5h5v2"/><path d="M6.5 6.5 7.4 20h9.2l.9-13.5"/>',
  pencil:
    '<path d="M12.5 20.5H21"/><path d="M16.6 3.6a2.1 2.1 0 0 1 3 3L7.5 18.7l-4 1 1-4z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  settings:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M4.5 12H2.1M21.9 12h-2.4M6.4 6.4 4.7 4.7M19.3 19.3l-1.7-1.7M17.6 6.4l1.7-1.7M4.7 19.3l1.7-1.7"/>',
  shield:
    '<path d="M12 3.2 20 6v6.2c0 4.8-3.4 7.8-8 8.9-4.6-1.1-8-4.1-8-8.9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  logout:
    '<path d="M9.5 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3h4"/><path d="M16 16.5l4.5-4.5L16 7.5"/><path d="M20.5 12H9.5"/>',
  users:
    '<path d="M15.5 20v-1.8a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.8a4 4 0 0 0-3-3.87"/><path d="M16.5 4.2a3.5 3.5 0 0 1 0 6.6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2.5 2.5 0 0 0-2.5 2.5V13"/>',
  download:
    '<path d="M12 3.5v11.5"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 20.5h16"/>',
  "panel-left":
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/>',
  check: '<path d="M20 6.5 9.2 17.3 4 12.1"/>',
  alert:
    '<path d="M12 9v4.5"/><path d="M12 17.2h.01"/><path d="M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20.3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11v5.2"/><path d="M12 7.9h.01"/>',
  key: '<circle cx="15.5" cy="8.5" r="4.2"/><path d="m12.4 11.6-8.6 8.6v2.2h2.2v-2.2h2.2v-2.2h2.2l2-2"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h7"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/>',
};

/**
 * @param {keyof typeof ICONS|string} name
 * @param {number} [size]
 */
export function svgIcon(name, size = 14) {
  const body = ICONS[name] || ICONS.file;
  const wrap = document.createElement("span");
  wrap.className = "ico";
  wrap.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return wrap;
}

/** @param {string} name @param {string} label @param {() => void} onClick @param {string} [extraClass] */
export function iconButton(name, label, onClick, extraClass = "") {
  return el(
    "button",
    {
      class: `icon-btn ${extraClass}`.trim(),
      title: label,
      attrs: { type: "button", "aria-label": label },
      on: { click: onClick },
    },
    svgIcon(name, 14),
  );
}

/**
 * @param {string} text
 * @param {string} [type] primary | ghost | danger | subtle
 * @param {Record<string, any>|Function} [extra] props object, or a bare click handler
 * @param {string} [extraClass]
 */
export function button(text, type = "ghost", extra = {}, extraClass = "") {
  const opts =
    typeof extra === "function"
      ? { on: { click: extra } }
      : { ...(extra || {}) };
  const { class: cls, ...rest } = opts;
  return el("button", {
    class: `btn btn-${type} ${cls || ""} ${extraClass || ""}`.trim(),
    attrs: { type: "button" },
    text,
    ...rest,
  });
}

export function fmtClock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

export function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

export function countWords(text) {
  const value = String(text ?? "");
  if (!value.trim()) return 0;
  const cjk = value.match(CJK_RE);
  const rest = value.replace(CJK_RE, " ");
  const latin = rest.match(/[A-Za-z0-9_'’-]+/g);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

/** @param {string} filename @param {string|Blob} data @param {string} [mime] */
export function download(filename, data, mime = "text/plain;charset=utf-8") {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** @param {string} text @returns {Promise<boolean>} */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

