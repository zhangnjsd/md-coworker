// CodeMirror 6 editor for markdown files, collaborative through y-codemirror.next.
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  scrollPastEnd,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--fg)",
      backgroundColor: "var(--bg-editor)",
      fontSize: "var(--fs-code)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.7",
      overflow: "auto",
    },
    "&.cm-focused": {
      outline: "none",
      boxShadow: "inset 0 0 0 1px var(--accent-line)",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      padding: "var(--sp-3) 0 var(--sp-8)",
    },
    ".cm-line": { padding: "0 var(--sp-5)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-editor)",
      color: "var(--fg-3)",
      border: "none",
      borderRight: "1px solid var(--line-soft)",
      paddingRight: "var(--sp-1)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 var(--sp-2) 0 var(--sp-3)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--fg)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in oklab, var(--fg) 3.5%, transparent)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
      {
        backgroundColor: "color-mix(in oklab, var(--accent) 22%, transparent)",
      },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--bg-2)",
      color: "var(--fg-2)",
      border: "1px solid var(--line)",
      borderRadius: "var(--r-xs)",
      padding: "0 var(--sp-1)",
    },
    ".cm-panels": { backgroundColor: "var(--bg-1)", color: "var(--fg)" },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in oklab, var(--warn) 26%, transparent)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "color-mix(in oklab, var(--warn) 46%, transparent)",
    },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "color-mix(in oklab, var(--accent) 22%, transparent)",
      outline: "1px solid var(--accent-line)",
    },
    ".cm-placeholder": { color: "var(--fg-3)" },
  },
  { dark: true },
);

/* Syntax palette mirrors the preview's hljs colours (styles/prose.css). */
const markdownHighlight = HighlightStyle.define([
  {
    tag: tags.heading1,
    fontSize: "1.5em",
    fontWeight: "600",
    color: "var(--fg)",
    letterSpacing: "-0.02em",
  },
  {
    tag: tags.heading2,
    fontSize: "1.28em",
    fontWeight: "600",
    color: "var(--fg)",
    letterSpacing: "-0.015em",
  },
  {
    tag: tags.heading3,
    fontSize: "1.14em",
    fontWeight: "600",
    color: "var(--fg)",
  },
  {
    tag: [tags.heading4, tags.heading5, tags.heading6],
    fontWeight: "600",
    color: "var(--fg-2)",
  },
  { tag: tags.strong, fontWeight: "700", color: "var(--fg)" },
  { tag: tags.emphasis, fontStyle: "italic", color: "var(--fg-2)" },
  {
    tag: tags.strikethrough,
    textDecoration: "line-through",
    color: "var(--fg-3)",
  },
  { tag: tags.link, color: "var(--accent)", textDecoration: "underline" },
  {
    tag: tags.url,
    color: "color-mix(in oklab, var(--accent) 70%, var(--fg-3))",
  },
  {
    tag: tags.monospace,
    color: "color-mix(in oklab, var(--accent) 80%, var(--fg))",
    fontFamily: "var(--font-mono)",
  },
  { tag: tags.quote, color: "var(--fg-2)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--fg-3)" },
  { tag: tags.processingInstruction, color: "var(--fg-3)" },
  { tag: tags.list, color: "var(--fg-2)" },
  { tag: tags.contentSeparator, color: "var(--line)", fontWeight: "700" },
  { tag: tags.keyword, color: "#d5a5eb" },
  { tag: tags.string, color: "#a1dca2" },
  { tag: tags.number, color: "#f9c191" },
  { tag: tags.comment, color: "var(--fg-3)" },
  { tag: tags.typeName, color: "#89dae3" },
  { tag: tags.function(tags.variableName), color: "#9bccff" },
]);

/**
 * @param {{
 *   parent: HTMLElement,
 *   ytext: Y.Text,
 *   awareness: import('y-protocols/awareness').Awareness,
 *   onCursor?: (pos: {line: number, ch: number}) => void,
 *   onScroll?: (pos: {line: number, frac: number}) => void,
 *   onDocChange?: () => void,
 *   readOnly?: boolean,
 * }} opts
 */
export function createMarkdownEditor(opts) {
  const {
    parent,
    ytext,
    awareness,
    onCursor,
    onScroll,
    onDocChange,
    readOnly = false,
  } = opts;
  const undoManager = new Y.UndoManager(ytext);
  let publishing = false;

  /** Publish the cursor in both awareness dialects so Monaco peers can render it. */
  const publish = (view) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const pos = { line: line.number - 1, ch: head - line.from };
    ytext.doc &&
      awareness.setLocalStateField("selection", {
        anchor: Y.createRelativePositionFromTypeIndex(
          ytext,
          view.state.selection.main.anchor,
        ),
        head: Y.createRelativePositionFromTypeIndex(ytext, head),
      });
    onCursor && onCursor(pos);
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      // ySync does not seed the view: the state must start from the shared text.
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        scrollPastEnd(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(markdownHighlight),
        editorTheme,
        cmPlaceholder("开始输入…"),
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        keymap.of([
          // y-codemirror's undo manager only ever undoes *our own* edits.
          ...yUndoManagerKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        yCollab(ytext, awareness, { undoManager }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onDocChange && onDocChange();
          if ((update.docChanged || update.selectionSet) && !publishing) {
            publishing = true;
            try {
              publish(update.view);
            } finally {
              publishing = false;
            }
          }
        }),
        EditorState.readOnly.of(!!readOnly),
      ],
    }),
  });

  // Scroll linking is line based: a document ratio drifts badly once the source
  // and the rendered page have different proportions, so both sides exchange
  // (line, fraction-into-that-line) instead.
  // Only the echo of our own write is ignored: the event carries the exact value
  // we just set, while anything else is the reader scrolling.
  let expectedScrollTop = null;

  const topLine = () => {
    const dom = view.scrollDOM;
    const block = view.lineBlockAtHeight(dom.scrollTop);
    const height = block.height || 1;
    const frac = Math.min(1, Math.max(0, (dom.scrollTop - block.top) / height));
    return { line: view.state.doc.lineAt(block.from).number, frac };
  };

  const onScrollEvent = () => {
    if (expectedScrollTop !== null) {
      if (Math.abs(view.scrollDOM.scrollTop - expectedScrollTop) <= 2) {
        expectedScrollTop = null;
        return;
      }
      expectedScrollTop = null;
    }
    if (onScroll) onScroll(topLine());
  };
  view.scrollDOM.addEventListener("scroll", onScrollEvent, { passive: true });

  const api = {
    view,
    kind: "codemirror",
    focus() {
      view.focus();
    },
    cursor() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number - 1, ch: head - line.from };
    },
    /** Best effort jump to a remote collaborator position (0-based). */
    setCursor(pos) {
      if (!pos || typeof pos.line !== "number") return false;
      const lineNo = Math.min(Math.max(1, pos.line + 1), view.state.doc.lines);
      const line = view.state.doc.line(lineNo);
      const offset =
        line.from + Math.min(Math.max(0, pos.ch || 0), line.length);
      view.dispatch({
        selection: { anchor: offset, head: offset },
        effects: EditorView.scrollIntoView(offset, { y: "center" }),
        scrollIntoView: false,
      });
      view.focus();
      return true;
    },
    /** Follow the preview: put `line` (1-based) at the top, `frac` into it. */
    scrollToLine(line, frac = 0) {
      const total = view.state.doc.lines;
      const lineNo = Math.min(Math.max(1, Math.round(line) || 1), total);
      const block = view.lineBlockAt(view.state.doc.line(lineNo).from);
      const target =
        block.top + Math.min(1, Math.max(0, frac)) * (block.height || 0);
      const dom = view.scrollDOM;
      const max = dom.scrollHeight - dom.clientHeight;
      dom.scrollTop = max > 0 ? Math.min(max, Math.max(0, target)) : 0;
      expectedScrollTop = dom.scrollTop;
    },

    /**
     * Insert `text` at the caret. It travels through the collaboration binding like
     * any other edit, so collaborators see the insertion and the author can undo it
     * with their own undo stack.
     */
    insertAtCursor(text) {
      const value = String(text ?? "");
      if (!value) return false;
      const range = view.state.selection.main;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: value },
        selection: { anchor: range.from + value.length },
      });
      view.focus();
      return true;
    },

    text() {
      return view.state.doc.toString();
    },
    destroy() {
      view.scrollDOM.removeEventListener("scroll", onScrollEvent);
      try {
        undoManager.destroy();
      } catch {
        /* ignore */
      }
      try {
        if (awareness.getLocalState())
          awareness.setLocalStateField("selection", null);
      } catch {
        /* ignore */
      }
      view.destroy();
    },
  };

  // Announce the initial cursor once the view is live.
  publish(view);
  return api;
}
