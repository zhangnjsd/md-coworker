// Monaco editor pane for markdown files, collaborative through y-monaco.
//
// The pane used to be CodeMirror 6. Markdown now runs on the same engine as
// source files, so both halves of the workspace share one theme, one font
// metric, one folding UI and one remote-caret renderer. What does not change is
// the contract with the preview pane: the two sides exchange a single fractional
// source line (`12.5` = half way through line 12) and each side swallows the echo
// of its own writes by position, which is what keeps scroll linking still.
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

const PADDING_TOP = 12;
const PADDING_BOTTOM = 40;

/**
 * Markdown edits and reads one text file.
 * @param {{
 *   parent: HTMLElement,
 *   ytext: Y.Text,
 *   awareness: import('y-protocols/awareness').Awareness,
 *   onCursor?: (pos: {line: number, ch: number}) => void,
 *   onScroll?: (pos: {line: number}) => void, // fractional source line, 1-based
 *   onDocChange?: () => void,
 *   readOnly?: boolean,
 * }} opts
 * @returns {Promise<object>} the same editor API the source pane exposes
 */
export async function createMarkdownEditor(opts) {
  const {
    parent,
    ytext,
    awareness,
    onCursor,
    onScroll,
    onDocChange,
    readOnly = false,
  } = opts;

  ensureEditorTheme();

  // The factory is async, so a fast switch between two markdown files can have a
  // second call arrive while the first one is still resolving. Whichever call is
  // later owns the host: retire the editor an earlier call left behind instead
  // of stacking two Monaco instances (and two bindings) in the same pane.
  const previous = parent.__mcMarkdownEditor;
  if (previous && typeof previous.destroy === "function") previous.destroy();

  const editor = monaco.editor.create(parent, {
    value: "",
    language: "markdown",
    theme: MC_THEME,
    // app.js already drives layout() from a ResizeObserver; automaticLayout
    // would measure the container on every animation frame instead.
    automaticLayout: false,
    minimap: { enabled: false },
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    showFoldingControls: "always",
    wordWrap: "on",
    wrappingIndent: "same",
    wrappingStrategy: "simple",
    fontSize: MC_FONT_SIZE,
    fontFamily: MC_FONT_FAMILY,
    fontLigatures: true,
    lineHeight: MC_LINE_HEIGHT,
    padding: { top: PADDING_TOP, bottom: PADDING_BOTTOM },
    scrollBeyondLastLine: false,
    // Scroll linking writes absolute positions. An eased scroll would emit a
    // burst of intermediate positions, each of which looks like a reader scroll.
    smoothScrolling: false,
    renderLineHighlight: "line",
    cursorBlinking: "smooth",
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    overviewRulerLanes: 0,
    renderWhitespace: "selection",
    tabSize: 2,
    stickyScroll: { enabled: false },
    readOnly,
    contextmenu: true,
  });

  // The shared text seeds the model; the binding then keeps the two in step.
  const model = monaco.editor.createModel(ytext.toString(), "markdown");
  editor.setModel(model);

  const binding = new MonacoBinding(ytext, model, new Set([editor]), awareness);

  // Local edits are transacted with the binding as origin, and remote updates
  // arrive with origin "remote". Tracking only the first is what makes Ctrl+Z
  // own-edits-only: a peer's text is never on our stack to begin with.
  const undoManager = new Y.UndoManager(ytext, {
    trackedOrigins: new Set([null, binding]),
  });

  const painter = createRemoteCursorPainter(awareness, ytext.doc.clientID);

  // ------------------------------------------------------------- cursor sync
  let publishing = false;

  /** y-monaco publishes `selection`; `cursor` is what presence and the peer
   * panel read, so both dialects are kept in the awareness state. */
  const publishCursor = () => {
    const sel = editor.getSelection();
    if (!sel) return;
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
    } catch {
      /* the document may be mid-update; the next move publishes again */
    }
  };

  const cursorSub = editor.onDidChangeCursorSelection(() => {
    if (publishing) return;
    publishing = true;
    try {
      publishCursor();
      const pos = editor.getPosition();
      if (pos && onCursor) {
        const sel = editor.getSelection();
        const selection = sel
          ? Math.abs(
              model.getOffsetAt(sel.getEndPosition()) -
                model.getOffsetAt(sel.getStartPosition()),
            )
          : 0;
        onCursor({ line: pos.lineNumber - 1, ch: pos.column - 1, selection });
      }
    } finally {
      publishing = false;
    }
  });

  // ---------------------------------------------------------- document state
  // React to the shared text, not the model: the ytext transaction tells a local
  // edit (origin = binding, or the undo manager) from a peer's (origin remote).
  const ytextObserver = (_event, transaction) => {
    if (transaction && transaction.origin === "remote") return;
    if (onDocChange) onDocChange();
  };
  ytext.observe(ytextObserver);

  // ------------------------------------------------------------ scroll link
  // See the header comment: a fractional line travels between the panes and our
  // own writes are recognised by the line they land on, never by pixels — near
  // the end of a document Monaco clamps scrollTop, so a pixel comparison would
  // read our own clamped write as the reader scrolling.
  let aimedLine = null;
  let ready = false;
  requestAnimationFrame(() => {
    ready = true;
  });

  /** Vertical extent of one source line (a wrapped line is taller than 23px). */
  const lineSpan = (lineNumber) => {
    const total = model.getLineCount();
    const n = Math.min(Math.max(1, Math.floor(lineNumber)), total);
    const top = editor.getTopForLineNumber(n);
    const next =
      n < total ? editor.getTopForLineNumber(n + 1) : top + MC_LINE_HEIGHT;
    return { top, next: Math.max(next, top + 1) };
  };

  /** Fractional 1-based line sitting at `scrollTop` (12.5 = line 12, half way). */
  const fractionalLineAt = (scrollTop) => {
    const total = model.getLineCount();
    let lo = 1;
    let hi = total;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (editor.getTopForLineNumber(mid) <= scrollTop) lo = mid;
      else hi = mid - 1;
    }
    const { top, next } = lineSpan(lo);
    const frac = Math.min(1, Math.max(0, (scrollTop - top) / (next - top)));
    return lo < total ? lo + frac : lo;
  };

  const scrollSub = editor.onDidScrollChange((event) => {
    if (!ready || !event.scrollTopChanged) return;
    const line = fractionalLineAt(editor.getScrollTop());
    if (aimedLine !== null && Math.abs(line - aimedLine) <= 0.75) {
      aimedLine = null;
      return;
    }
    aimedLine = null;
    if (onScroll) onScroll({ line });
  });

  // ------------------------------------------------------------- undo / redo
  const runHistory = (direction) => {
    try {
      if (direction === "undo") undoManager.undo();
      else undoManager.redo();
    } catch {
      /* an empty stack is not an error */
    }
    editor.focus();
  };

  // Monaco's own Ctrl+Z works on the model history, which would also replay a
  // peer's edits; these dynamic keybindings take precedence over it.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () =>
    runHistory("undo"),
  );
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
    () => runHistory("redo"),
  );
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () =>
    runHistory("redo"),
  );

  publishCursor();

  let disposed = false;

  const api = {
    kind: "monaco",
    editor,
    model,

    focus() {
      editor.focus();
    },

    cursor() {
      const pos = editor.getPosition();
      return pos
        ? { line: pos.lineNumber - 1, ch: pos.column - 1 }
        : { line: 0, ch: 0 };
    },

    /** Best effort jump to a collaborator position (0-based). */
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

    /** Follow the preview: put the fractional source line `line` at the top. */
    scrollToLine(line) {
      const target = Number(line);
      if (!Number.isFinite(target)) return;
      const total = model.getLineCount();
      const lineNo = Math.min(Math.max(1, Math.floor(target)), total);
      const frac = Math.min(1, Math.max(0, target - lineNo));
      const { top, next } = lineSpan(lineNo);
      const wanted = top + frac * (next - top);
      const layout = editor.getLayoutInfo();
      const lowest = Math.max(0, editor.getScrollHeight() - layout.height);
      editor.setScrollTop(Math.min(Math.max(0, wanted), lowest));
      // Remember the line the editor actually reached, not the one requested:
      // at the end of the document the request is clamped as well, and the echo
      // has to be recognised from the value the scroll event will report.
      aimedLine = fractionalLineAt(editor.getScrollTop());
    },

    /**
     * Insert `text` at the caret. It travels through the model like typed text,
     * so the binding publishes it to the room and the author's own undo stack
     * owns the change.
     */
    insertAtCursor(text) {
      const value = String(text ?? "");
      if (!value || readOnly) return false;
      const sel = editor.getSelection();
      if (!sel) return false;
      editor.executeEdits("mc-insert", [
        { range: sel, text: value, forceMoveMarkers: true },
      ]);
      editor.pushUndoStop();
      editor.focus();
      return true;
    },

    text() {
      return model.getValue();
    },

    layout() {
      editor.layout();
    },

    destroy() {
      // app.js may destroy us twice (closeEditor, then teardown, or a later
      // factory call retiring a stale instance), so this must be idempotent.
      if (disposed) return;
      disposed = true;
      if (parent.__mcMarkdownEditor === api) parent.__mcMarkdownEditor = null;
      try {
        cursorSub.dispose();
      } catch {
        /* ignore */
      }
      try {
        scrollSub.dispose();
      } catch {
        /* ignore */
      }
      try {
        ytext.unobserve(ytextObserver);
      } catch {
        /* ignore */
      }
      painter.destroy();
      try {
        undoManager.destroy();
      } catch {
        /* ignore */
      }
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

  parent.__mcMarkdownEditor = api;
  return api;
}
