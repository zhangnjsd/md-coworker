// Entry point: hash router + authentication gate.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/space-grotesk'
import './styles/index.css'
import { api, setUnauthorizedHandler } from './net/api.js'
import { toastError } from './ui/toast.js'
import { mountLogin } from './views/login.js'
import { mountApp } from './views/app.js'
import { mountAdmin } from './views/admin.js'

const root = document.getElementById('app-root')

let cleanup = null
let currentUser = null
let booting = false

function routeName() {
  const hash = (location.hash || '').replace(/^#/, '')
  if (hash.startsWith('/app')) return 'app'
  if (hash.startsWith('/admin')) return 'admin'
  return 'login'
}

function setHash(path) {
  const target = `#${path}`
  if (location.hash === target) render()
  else location.hash = target
}

function clearView() {
  if (cleanup) {
    try {
      cleanup()
    } catch (err) {
      console.warn('[main] view cleanup failed', err)
    }
    cleanup = null
  }
  root.innerHTML = ''
}

function goLogin(message) {
  currentUser = null
  clearView()
  if (routeName() !== 'login') {
    location.hash = '#/login'
  } else {
    render()
  }
  if (message) toastError(message)
}

function handleLogout() {
  currentUser = null
  try {
    localStorage.removeItem('mc.lastPath')
  } catch {
    /* ignore */
  }
  setHash('/login')
}

function onLoginSuccess(user) {
  currentUser = user
  try {
    localStorage.setItem('mc.lastUser', user.username)
  } catch {
    /* ignore */
  }
  setHash('/app')
}

function render() {
  if (booting) return
  clearView()

  const name = routeName()

  if (!currentUser) {
    if (name !== 'login') {
      location.hash = '#/login'
      return
    }
    cleanup = mountLogin(root, { onSuccess: onLoginSuccess })
    return
  }

  if (name === 'login') {
    location.hash = '#/app'
    return
  }

  if (name === 'admin') {
    if (currentUser.role !== 'admin') {
      toastError('仅管理员可以访问管理后台')
      location.hash = '#/app'
      return
    }
    cleanup = mountAdmin(root, {
      user: currentUser,
      onBack: () => setHash('/app'),
      onLogout: handleLogout,
    })
    return
  }

  cleanup = mountApp(root, {
    user: currentUser,
    onLogout: handleLogout,
    onNavigateAdmin: () => setHash('/admin'),
    onUserUpdate: (next) => {
      currentUser = { ...currentUser, ...next }
    },
  })
}

setUnauthorizedHandler(() => {
  // A 401 while booting just means "no session yet" — don't shout at the user.
  if (booting) return
  goLogin('登录状态已失效，请重新登录')
})

window.addEventListener('hashchange', () => render())

async function boot() {
  booting = true
  try {
    const res = await api.me()
    currentUser = (res && res.user) || null
  } catch {
    currentUser = null
  } finally {
    booting = false
  }
  // No session: always land on the (visible) login route.
  if (!currentUser && location.hash !== '#/login') {
    location.hash = '#/login'
    return
  }
  render()
}

boot()
