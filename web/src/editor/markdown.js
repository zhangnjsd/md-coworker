// CodeMirror 6 editor for markdown files, collaborative through y-codemirror.next.
import * as Y from 'yjs'
import { EditorState } from '@codemirror/state'
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
} from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { undo, redo, yCollab } from 'y-codemirror.next'

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--fg)',
      backgroundColor: 'var(--bg-editor)',
      fontSize: '13.5px',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.65',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0 40px' },
    '.cm-line': { padding: '0 14px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-editor)',
      color: 'var(--fg-dim)',
      border: 'none',
      borderRight: '1px solid var(--border-soft)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(79,156,249,0.28)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--bg-raised)',
      color: 'var(--fg-dim)',
      border: '1px solid var(--border)',
      borderRadius: '3px',
      padding: '0 4px',
    },
    '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--fg)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(245,196,81,0.28)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(245,196,81,0.5)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(79,156,249,0.25)' },
    '.cm-placeholder': { color: 'var(--fg-faint)' },
  },
  { dark: true },
)

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700', color: '#e8eef8' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '700', color: '#e8eef8' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600', color: '#e8eef8' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '600', color: '#dbe3ee' },
  { tag: tags.strong, fontWeight: '700', color: '#ffffff' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#d6e4f7' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--fg-dim)' },
  { tag: tags.link, color: '#6fb1ff', textDecoration: 'underline' },
  { tag: tags.url, color: '#5f9bb8' },
  { tag: tags.monospace, color: '#f0a868', fontFamily: 'var(--font-mono)' },
  { tag: tags.quote, color: '#9fb3c8', fontStyle: 'italic' },
  { tag: tags.meta, color: 'var(--fg-faint)' },
  { tag: tags.processingInstruction, color: 'var(--fg-faint)' },
  { tag: tags.list, color: '#8fb6dd' },
  { tag: tags.contentSeparator, color: 'var(--fg-dim)', fontWeight: '700' },
  { tag: tags.keyword, color: '#c792ea' },
  { tag: tags.string, color: '#a5d6a7' },
  { tag: tags.number, color: '#f2c17b' },
  { tag: tags.comment, color: '#6b7a8d', fontStyle: 'italic' },
  { tag: tags.typeName, color: '#7fd1c1' },
  { tag: tags.function(tags.variableName), color: '#8ab4f8' },
])

/**
 * @param {{
 *   parent: HTMLElement,
 *   ytext: Y.Text,
 *   awareness: import('y-protocols/awareness').Awareness,
 *   onCursor?: (pos: {line: number, ch: number}) => void,
 *   onScroll?: (ratio: number) => void,
 *   onDocChange?: () => void,
 *   readOnly?: boolean,
 * }} opts
 */
export function createMarkdownEditor(opts) {
  const { parent, ytext, awareness, onCursor, onScroll, onDocChange, readOnly = false } = opts
  const undoManager = new Y.UndoManager(ytext)
  let publishing = false

  /** Publish the cursor in both awareness dialects so Monaco peers can render it. */
  const publish = (view) => {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const pos = { line: line.number - 1, ch: head - line.from }
    ytext.doc &&
      awareness.setLocalStateField('selection', {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, view.state.selection.main.anchor),
        head: Y.createRelativePositionFromTypeIndex(ytext, head),
      })
    onCursor && onCursor(pos)
  }

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
        cmPlaceholder('开始输入…'),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        keymap.of([
          // Only y-codemirror's undo touches the CRDT (own edits only).
          { key: 'Mod-z', run: () => undo(view), preventDefault: true },
          { key: 'Mod-Shift-z', run: () => redo(view), preventDefault: true },
          { key: 'Mod-y', run: () => redo(view), preventDefault: true },
          ...foldKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        yCollab(ytext, awareness, { undoManager }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onDocChange && onDocChange()
          if ((update.docChanged || update.selectionSet) && !publishing) {
            publishing = true
            try {
              publish(update.view)
            } finally {
              publishing = false
            }
          }
        }),
        EditorState.readOnly.of(!!readOnly),
      ],
    }),
  })

  const onScrollEvent = () => {
    if (!onScroll) return
    const dom = view.scrollDOM
    const max = dom.scrollHeight - dom.clientHeight
    onScroll(max > 4 ? Math.min(1, Math.max(0, dom.scrollTop / max)) : 0)
  }
  view.scrollDOM.addEventListener('scroll', onScrollEvent, { passive: true })

  const api = {
    view,
    kind: 'codemirror',
    focus() {
      view.focus()
    },
    cursor() {
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      return { line: line.number - 1, ch: head - line.from }
    },
    /** Best effort jump to a remote collaborator position (0-based). */
    setCursor(pos) {
      if (!pos || typeof pos.line !== 'number') return false
      const lineNo = Math.min(Math.max(1, pos.line + 1), view.state.doc.lines)
      const line = view.state.doc.line(lineNo)
      const offset = line.from + Math.min(Math.max(0, pos.ch || 0), line.length)
      view.dispatch({
        selection: { anchor: offset, head: offset },
        effects: EditorView.scrollIntoView(offset, { y: 'center' }),
        scrollIntoView: false,
      })
      view.focus()
      return true
    },
    scrollToRatio(ratio) {
      const dom = view.scrollDOM
      const max = dom.scrollHeight - dom.clientHeight
      dom.scrollTop = max > 0 ? max * Math.min(1, Math.max(0, ratio)) : 0
    },
    text() {
      return view.state.doc.toString()
    },
    destroy() {
      view.scrollDOM.removeEventListener('scroll', onScrollEvent)
      try {
        undoManager.destroy()
      } catch {
        /* ignore */
      }
      try {
        if (awareness.getLocalState()) awareness.setLocalStateField('selection', null)
      } catch {
        /* ignore */
      }
      view.destroy()
    },
  }

  // Announce the initial cursor once the view is live.
  publish(view)
  return api
}
