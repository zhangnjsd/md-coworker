// Monaco editor pane for non-markdown source files, collaborative through y-monaco.
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import {
  MC_FONT_FAMILY,
  MC_FONT_SIZE,
  MC_LINE_HEIGHT,
  MC_THEME,
  createRemoteCursorPainter,
  ensureEditorTheme,
  monaco,
} from "./monaco-shared.js";

// Syntax highlighting is provided by lazily loaded basic-language tokenizers.
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";

const LANG_BY_EXT = {
  rs: "rust",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "javascript",
  jsonc: "javascript",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  env: "ini",
  sql: "sql",
  go: "go",
  java: "java",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  lua: "lua",
  kt: "kotlin",
  swift: "swift",
  dockerfile: "dockerfile",
  bat: "bat",
  cmd: "bat",
  ps1: "powershell",
  md: "markdown",
  markdown: "markdown",
};

export function languageForPath(path) {
  const name =
    String(path || "")
      .split("/")
      .pop() || "";
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return LANG_BY_EXT[ext] || "plaintext";
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
  const {
    parent,
    path,
    ytext,
    awareness,
    onCursor,
    onScroll,
    readOnly = false,
  } = opts;
  const language = languageForPath(path);
  ensureEditorTheme();

  const editor = monaco.editor.create(parent, {
    value: "",
    language,
    theme: MC_THEME,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: MC_FONT_SIZE,
    fontFamily: MC_FONT_FAMILY,
    fontLigatures: true,
    lineHeight: MC_LINE_HEIGHT,
    renderLineHighlight: "all",
    scrollBeyondLastLine: true,
    smoothScrolling: true,
    cursorBlinking: "smooth",
    padding: { top: 12, bottom: 40 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    overviewRulerLanes: 0,
    renderWhitespace: "selection",
    tabSize: 2,
    readOnly,
    wordWrap: "off",
    contextmenu: true,
  });

  const model = monaco.editor.createModel(ytext.toString(), language);
  editor.setModel(model);

  const binding = new MonacoBinding(ytext, model, new Set([editor]), awareness);
  const painter = createRemoteCursorPainter(awareness, ytext.doc.clientID);

  // y-monaco publishes `selection`; `cursor` is what presence and the peer
  // panel read, so both dialects are kept in the awareness state.
  let publishing = false;
  const cursorSub = editor.onDidChangeCursorSelection(() => {
    const sel = editor.getSelection();
    if (!sel) return;
    if (!publishing) {
      publishing = true;
      try {
        awareness.setLocalStateField("cursor", {
          anchor: Y.createRelativePositionFromTypeIndex(
            ytext,
            model.getOffsetAt(sel.getStartPosition()),
          ),
          head: Y.createRelativePositionFromTypeIndex(
            ytext,
            model.getOffsetAt(sel.getEndPosition()),
          ),
        });
        publishing = false;
      } catch {
        publishing = false;
      }
    }
    const pos = sel.getPosition();
    if (onCursor && pos) {
      const selection = Math.abs(
        model.getOffsetAt(sel.getEndPosition()) -
          model.getOffsetAt(sel.getStartPosition()),
      );
      onCursor({ line: pos.lineNumber - 1, ch: pos.column - 1, selection });
    }
  });

  const scrollSub = onScroll
    ? editor.onDidScrollChange(() => {
        const layout = editor.getLayoutInfo();
        const max = editor.getScrollHeight() - layout.height;
        onScroll(
          max > 4 ? Math.min(1, Math.max(0, editor.getScrollTop() / max)) : 0,
        );
      })
    : null;

  return {
    kind: "monaco",
    editor,
    focus() {
      editor.focus();
    },
    cursor() {
      const pos = editor.getPosition();
      return pos
        ? { line: pos.lineNumber - 1, ch: pos.column - 1 }
        : { line: 0, ch: 0 };
    },
    setCursor(pos) {
      if (!pos || typeof pos.line !== "number") return false;
      const lineNumber = Math.min(
        Math.max(1, pos.line + 1),
        Math.max(1, model.getLineCount()),
      );
      const column = Math.min(
        Math.max(1, (pos.ch || 0) + 1),
        model.getLineMaxColumn(lineNumber),
      );
      editor.setPosition({ lineNumber, column });
      editor.revealPositionInCenter({ lineNumber, column });
      editor.focus();
      return true;
    },
    scrollToRatio(ratio) {
      const layout = editor.getLayoutInfo();
      const max = editor.getScrollHeight() - layout.height;
      editor.setScrollTop(max > 0 ? max * Math.min(1, Math.max(0, ratio)) : 0);
    },
    text() {
      return model.getValue();
    },
    layout() {
      editor.layout();
    },
    destroy() {
      cursorSub.dispose();
      scrollSub && scrollSub.dispose();
      painter.destroy();
      try {
        binding.destroy();
      } catch {
        /* ignore */
      }
      try {
        model.dispose();
      } catch {
        /* ignore */
      }
      try {
        if (awareness.getLocalState()) {
          awareness.setLocalStateField("cursor", null);
          awareness.setLocalStateField("selection", null);
        }
      } catch {
        /* ignore */
      }
      editor.dispose();
    },
  };
}
