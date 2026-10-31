// Generic modal dialog + confirm / prompt helpers.
import { el, svgIcon, clear } from '../util/dom.js'

let openStack = []
let modalSeq = 0

function lockScroll(on) {
  document.body.classList.toggle('modal-open', on)
}

/**
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   body?: any,
 *   actions?: Array<{label: string, kind?: 'primary'|'ghost'|'danger', onClick?: (api: any) => any, close?: boolean, id?: string}>,
 *   width?: number,
 *   dismissable?: boolean,
 *   onClose?: () => void,
 * }} opts
 */
export function openModal(opts) {
  const { title, subtitle = '', body = null, actions = [], width = 520, dismissable = true, onClose } = opts

  const titleId = `modal-title-${++modalSeq}`
  const titleNode = el('h2', { class: 'modal-title', text: title, attrs: { id: titleId } })
  const subtitleNode = subtitle ? el('p', { class: 'modal-subtitle', text: subtitle }) : null
  const bodyWrap = el('div', { class: 'modal-body' })
  if (body) bodyWrap.appendChild(body instanceof Node ? body : document.createTextNode(String(body)))
  const footWrap = el('div', { class: 'modal-foot' })

  const closeBtn = el(
    'button',
    { class: 'icon-btn modal-close', attrs: { type: 'button', 'aria-label': '关闭' }, on: { click: () => close() } },
    svgIcon('close', 14),
  )

  const card = el(
    'div',
    {
      class: 'modal',
      style: { width: `min(${width}px, calc(100vw - 64px))` },
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    },
    el('div', { class: 'modal-head' }, el('div', { class: 'modal-head-text' }, titleNode, subtitleNode), closeBtn),
    bodyWrap,
    footWrap,
  )
  const backdrop = el('div', { class: 'modal-backdrop' }, card)

  /** @type {{close: () => void, card: HTMLElement, body: HTMLElement, setTitle: Function, setSubtitle: Function, setActions: Function, setBody: Function}} */
  const api = {
    card,
    body: bodyWrap,
    close,
    setTitle(text) {
      titleNode.textContent = text
    },
    setSubtitle(text) {
      if (!subtitleNode) return
      subtitleNode.textContent = text
    },
    setBody(node) {
      clear(bodyWrap)
      if (node != null) bodyWrap.appendChild(node instanceof Node ? node : document.createTextNode(String(node)))
    },
    setActions(next) {
      clear(footWrap)
      for (const action of next) footWrap.appendChild(makeAction(action))
    },
  }

  function makeAction(action) {
    const kind = action.kind || 'ghost'
    const btn = el('button', {
      class: `btn btn-${kind}`,
      attrs: { type: 'button' },
      text: action.label,
      on: {
        click: async () => {
          if (!action.onClick) {
            if (action.close !== false) close()
            return
          }
          btn.disabled = true
          try {
            const result = await action.onClick(api)
            if (result !== false && action.close !== false) close()
          } finally {
            btn.disabled = false
          }
        },
      },
    })
    return btn
  }

  api.setActions(actions)

  function onKeydown(ev) {
    if (ev.key === 'Escape' && dismissable) {
      ev.stopPropagation()
      close()
    }
  }

  function close() {
    if (!backdrop.isConnected || backdrop.classList.contains('out')) return
    document.removeEventListener('keydown', onKeydown, true)
    backdrop.classList.remove('in')
    backdrop.classList.add('out')
    openStack = openStack.filter((item) => item !== api)
    if (!openStack.length) lockScroll(false)
    setTimeout(() => backdrop.remove(), 320)
    // hand focus back to whatever opened the dialog
    if (!openStack.length && lastFocus && lastFocus.isConnected) {
      try {
        lastFocus.focus()
      } catch {
        /* ignore */
      }
    }
    try {
      onClose && onClose()
    } catch {
      /* ignore */
    }
  }

  const lastFocus = document.activeElement

  backdrop.addEventListener('mousedown', (ev) => {
    if (dismissable && ev.target === backdrop) close()
  })
  document.addEventListener('keydown', onKeydown, true)

  document.body.appendChild(backdrop)
  openStack.push(api)
  lockScroll(true)
  requestAnimationFrame(() => backdrop.classList.add('in'))

  // initial focus: first field in the body, else the primary action, else the card
  const focusTarget =
    bodyWrap.querySelector('input:not([type="hidden"]), textarea, select, [contenteditable="true"]') ||
    footWrap.querySelector('.btn-primary, .btn-danger') ||
    card
  setTimeout(() => focusTarget.focus(), 30)

  return api
}

/** @returns {Promise<boolean>} */
export function confirmDialog({ title, message, confirmLabel = '确定', cancelLabel = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const modal = openModal({
      title,
      body: el('p', { class: 'modal-text', text: message }),
      width: 440,
      actions: [
        { label: cancelLabel, kind: 'ghost', onClick: () => finish(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => finish(true) },
      ],
      onClose: () => finish(false),
    })
    // keep a handle so callers can force-close from elsewhere
    modal.card.dataset.confirm = '1'
  })
}

/**
 * Single-line text prompt used by the file tree (create / rename).
 * @returns {Promise<string|null>}
 */
export function promptDialog({
  title,
  subtitle = '',
  label = '',
  value = '',
  placeholder = '',
  hint = '',
  confirmLabel = '确定',
  validate,
}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const inputId = `modal-input-${++modalSeq}`
    const input = el('input', {
      class: 'input',
      attrs: { type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off', id: inputId },
    })
    const errorNode = el('p', { class: 'field-error', style: { display: 'none' } })
    const body = el(
      'div',
      { class: 'field' },
      label ? el('label', { class: 'field-label', text: label, attrs: { for: inputId } }) : null,
      input,
      hint ? el('p', { class: 'field-hint', text: hint }) : null,
      errorNode,
    )
    const submit = () => {
      const raw = input.value.trim()
      const problem = validate ? validate(raw) : !raw ? '不能为空' : null
      if (problem) {
        errorNode.textContent = problem
        errorNode.style.display = ''
        input.focus()
        return
      }
      finish(raw)
      modal.close()
    }
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        submit()
      }
    })
    const modal = openModal({
      title,
      subtitle,
      body,
      width: 460,
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => finish(null) },
        { label: confirmLabel, kind: 'primary', onClick: submit, close: false },
      ],
      onClose: () => finish(null),
    })
  })
}
