// Top-right toast notifications (never window.alert).
import { el, svgIcon } from '../util/dom.js'

let host = null

function ensureHost() {
  if (host && host.isConnected) return host
  host = document.querySelector('.toast-host')
  if (!host) {
    host = el('div', { class: 'toast-host', attrs: { role: 'status', 'aria-live': 'polite' } })
    document.body.appendChild(host)
  }
  return host
}

const ICON_FOR = { info: 'info', success: 'check', error: 'alert', warn: 'alert' }

/**
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error'|'warn', duration?: number, detail?: string}} [opts]
 */
export function toast(message, opts = {}) {
  const { type = 'info', duration = 3200, detail = '' } = opts
  const node = el(
    'div',
    { class: `toast toast-${type}` },
    svgIcon(ICON_FOR[type] || 'info', 15),
    el('div', { class: 'toast-text' }, el('span', { text: String(message) }), detail ? el('small', { text: detail }) : null),
  )
  ensureHost().appendChild(node)
  requestAnimationFrame(() => node.classList.add('in'))
  const kill = () => {
    node.classList.remove('in')
    node.classList.add('out')
    setTimeout(() => node.remove(), 220)
  }
  const timer = setTimeout(kill, Math.max(1200, duration))
  node.addEventListener('click', () => {
    clearTimeout(timer)
    kill()
  })
  return node
}

export const toastInfo = (m, d) => toast(m, { type: 'info', duration: d })
export const toastSuccess = (m, d) => toast(m, { type: 'success', duration: d })
export const toastWarn = (m, d) => toast(m, { type: 'warn', duration: d })
export const toastError = (m, d) => toast(m, { type: 'error', duration: d || 4600 })

/** Error objects coming from src/net/api.js already carry Chinese messages. */
export function toastFromError(err, fallback = '操作失败') {
  const message = err && err.message ? err.message : fallback
  return toastError(message)
}
