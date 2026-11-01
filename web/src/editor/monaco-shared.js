// Shared Monaco assembly for the two editor panes: the Markdown pane and the
// source pane in code.js. Both must look and behave the same, so the theme, the
// worker wiring, the font stack and the remote-caret painter live here once.
//
// code.js keeps its own copy of this scaffolding on purpose — it has to stay
// working on its own — and every piece below is idempotent, so loading both is
// harmless: `defineTheme` replaces a same-named theme, the worker hook is set
// only when missing, and each painter owns its own <style> element.
import * as monaco from "monaco-editor/esm/vs/editor/edcore.main.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";

export { monaco };

/** Name shared by both panes; redefined with identical values in code.js. */
export const MC_THEME = "mc-dark";

/**
 * One font stack for every pane: the design system ships Geist Mono, and a
 * different fallback on one side would shift line width and wrapping.
 */
export const MC_FONT_FAMILY =
  "'Geist Mono Variable', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Font size and line box shared with code.js, so .md and .rs look alike. */
export const MC_FONT_SIZE = 13.5;
export const MC_LINE_HEIGHT = 23;

// Only the plain editor worker is needed (no TS/JSON/CSS language services).
if (!self.MonacoEnvironment || !self.MonacoEnvironment.getWorker) {
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}

let themeReady = false;

/** Idempotent: `mc-dark` is defined once per page, whoever asks first. */
export function ensureEditorTheme() {
  if (themeReady) return;
  themeReady = true;
  monaco.editor.defineTheme(MC_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "b3b8be" },
      { token: "comment", foreground: "7d848c", fontStyle: "italic" },
      { token: "keyword", foreground: "d5a5eb" },
      { token: "string", foreground: "a1dca2" },
      { token: "number", foreground: "f9c191" },
      { token: "type", foreground: "89dae3" },
      { token: "identifier", foreground: "b3b8be" },
      { token: "delimiter", foreground: "999fa6" },
    ],
    colors: {
      "editor.background": "#11151a",
      "editor.foreground": "#ebeff2",
      "editor.lineHighlightBackground": "#ffffff06",
      "editorLineNumber.foreground": "#6b737b",
      "editorLineNumber.activeForeground": "#b3b8be",
      "editor.selectionBackground": "#65ddbb38",
      "editor.inactiveSelectionBackground": "#65ddbb1f",
      "editorCursor.foreground": "#65ddbb",
      "editorIndentGuide.background1": "#252b31",
      "editorIndentGuide.activeBackground1": "#343b43",
      "editorGutter.background": "#11151a",
      "editor.widget.background": "#20262c",
      "editorWidget.background": "#20262c",
      "editorWidget.border": "#343b43",
      "editorSuggestWidget.background": "#20262c",
      "editorSuggestWidget.border": "#343b43",
      "editorSuggestWidget.selectedBackground": "#23272c",
      "editorHoverWidget.background": "#20262c",
      "editorHoverWidget.border": "#343b43",
      "scrollbarSlider.background": "#343b4380",
      "scrollbarSlider.hoverBackground": "#343b43cc",
      "minimap.background": "#11151a",
      // Folding chevrons: the same muted grey as the line numbers.
      "editorGutter.foldingControlForeground": "#6b737b",
    },
  });
}

// ---------------------------------------------------------------------------
// Remote carets. y-monaco only adds CSS classes; colours and the name label are
// generated here from the awareness states.
const STYLE_ID = "mc-monaco-md-remote-cursors";

function ensureStyleNode() {
  let node = document.getElementById(STYLE_ID);
  if (!node) {
    node = document.createElement("style");
    node.id = STYLE_ID;
    document.head.appendChild(node);
  }
  return node;
}

// Awareness payloads are attacker controlled (any room member can publish any
// colour/name), so nothing from them may reach the stylesheet unvalidated.
const CURSOR_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_CURSOR_COLOR = "#8dcdbb";

/** Only accept a literal #rrggbb, otherwise fall back to the house colour. */
function safeCursorColor(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return CURSOR_COLOR_RE.test(raw) ? raw : DEFAULT_CURSOR_COLOR;
}

function escapeCssText(value) {
  return (
    String(value)
      .replace(/["\\]/g, "\\$&")
      .replace(/\n/g, " ")
      // `}`/`<`/`>`/`;` have no business inside a CSS string and are dropped
      // outright so a crafted name cannot close the rule or the style element.
      .replace(/[<>{};]/g, "")
  );
}

function hexToRgba(hex, alpha) {
  // Callers pass a value that already went through safeCursorColor().
  const value = String(hex || DEFAULT_CURSOR_COLOR).replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const num = parseInt(full.slice(0, 6) || "8dcdbb", 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Per-client remote selection colours and caret labels.
 * @param {import('y-protocols/awareness').Awareness} awareness
 * @param {number} ownClientId
 */
export function createRemoteCursorPainter(awareness, ownClientId) {
  const node = ensureStyleNode();
  let last = "";
  const paint = () => {
    const chunks = [];
    awareness.getStates().forEach((state, clientID) => {
      if (clientID === ownClientId) return;
      const user = state.user || {};
      const color = safeCursorColor(user.color);
      const name = escapeCssText(user.name || "匿名");
      chunks.push(
        `.monaco-editor .yRemoteSelection-${clientID} { background: ${hexToRgba(color, 0.26)}; }`,
        `.monaco-editor .yRemoteSelectionHead-${clientID} { border-left: 2px solid ${color}; }`,
        `.monaco-editor .yRemoteSelectionHead-${clientID}::after { content: "${name}"; background: ${color}; }`,
      );
    });
    const css = chunks.join("\n");
    if (css === last) return;
    last = css;
    node.textContent = css;
  };
  paint();
  // Repaint on every awareness change: `paint` rewrites the <style> element only
  // when the generated CSS actually changed, so plain caret moves cost nothing.
  const handler = () => paint();
  awareness.on("change", handler);
  return {
    destroy() {
      awareness.off("change", handler);
      node.textContent = "";
    },
  };
}
