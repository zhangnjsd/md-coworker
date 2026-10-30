// Settings dialog: TOTP two-factor setup/teardown and keypair rotation.
import QRCode from 'qrcode'
import { api, storeKey } from '../net/api.js'
import { button, el, svgIcon } from '../util/dom.js'
import { confirmDialog, openModal } from '../ui/modal.js'
import { privateKeyPanel } from '../ui/secret.js'
import { toastError, toastSuccess } from '../ui/toast.js'

/**
 * @param {{
 *   user: {id: string, username: string, role: string, color?: string, twofa_enabled?: boolean},
 *   onUserUpdate?: (user: any) => void,
 * }} opts
 */
export function openSettings(opts) {
  const { user, onUserUpdate } = opts

  const body = el('div', { class: 'settings' })

  const modal = openModal({
    title: '设置',
    subtitle: `账号 ${user.username}`,
    body,
    width: '640px',
    actions: [{ label: '关闭', kind: 'ghost', close: true }],
  })

  // ------------------------------------------------------------- account

  function renderAccount() {
    return el(
      'section',
      { class: 'settings-section' },
      el('div', { class: 'settings-head' },
        el('h3', { class: 'settings-title', text: '账号' }),
      ),
      el(
        'div',
        { class: 'kv-list' },
        el('div', { class: 'kv' },
          el('span', { class: 'kv-key', text: '用户名' }),
          el('span', { class: 'kv-val mono', text: user.username }),
        ),
        el('div', { class: 'kv' },
          el('span', { class: 'kv-key', text: '角色' }),
          el('span', { class: `badge badge-${user.role === 'admin' ? 'admin' : 'user'}`, text: user.role }),
        ),
        el('div', { class: 'kv' },
          el('span', { class: 'kv-key', text: '标识色' }),
          el('span', { class: 'kv-val' },
            el('span', { class: 'dot', style: `background:${user.color || '#4f9cf9'}` }),
            el('span', { class: 'mono dim', text: user.color || '#4f9cf9' }),
          ),
        ),
      ),
    )
  }

  // ------------------------------------------------------------- 2FA block

  let qrUrl = null

  function renderTwoFactor() {
    const enabled = !!user.twofa_enabled
    const section = el('section', { class: 'settings-section' },
      el('div', { class: 'settings-head' },
        el('h3', { class: 'settings-title', text: '两步验证（TOTP）' }),
        el('span', {
          class: `badge ${enabled ? 'badge-ok' : 'badge-muted'}`,
          text: enabled ? '已启用' : '未启用',
        }),
      ),
      el('p', {
        class: 'settings-text',
        text: enabled
          ? '登录时除签名外还需要输入身份验证器中的 6 位验证码。'
          : '启用后登录需要额外的 6 位动态验证码，推荐与密钥对一起使用。',
      }),
    )

    const slot = el('div', { class: 'settings-slot' })
    section.append(slot)

    if (enabled) {
      const codeInput = el('input', {
        class: 'input mono',
        attrs: {
          type: 'text',
          inputmode: 'numeric',
          maxlength: '6',
          placeholder: '6 位验证码',
          spellcheck: 'false',
        },
      })
      const disableBtn = button('关闭 2FA', 'danger', async () => {
        const code = codeInput.value.trim()
        if (code.length !== 6) {
          toastError('请输入 6 位验证码')
          return
        }
        try {
          const res = await api.disable2fa(code)
          if (res && res.user) {
            Object.assign(user, res.user)
            onUserUpdate && onUserUpdate(user)
          } else {
            user.twofa_enabled = false
          }
          toastSuccess('已关闭两步验证')
          refresh()
        } catch (err) {
          toastError(err.message || '关闭失败')
        }
      })
      slot.append(
        el('div', { class: 'inline-form' },
          codeInput,
          disableBtn,
        ),
        el('p', { class: 'settings-hint', text: '关闭 2FA 需要输入当前验证码以确认身份。' }),
      )
      return section
    }

    const startBtn = button('启用 2FA', 'primary', async () => {
      startBtn.disabled = true
      try {
        const res = await api.setup2fa()
        qrUrl = res.otpauth_url
        renderQr(res)
      } catch (err) {
        toastError(err.message || '无法获取 2FA 配置')
      } finally {
        startBtn.disabled = false
      }
    })
    slot.append(el('div', { class: 'inline-form' }, startBtn))
    return section

    function renderQr(res) {
      slot.innerHTML = ''
      const canvas = el('canvas', { class: 'qr-canvas', attrs: { width: '188', height: '188' } })
      const secretCode = el('code', { class: 'secret-code mono', text: res.secret })

      QRCode.toCanvas(canvas, res.otpauth_url, {
        margin: 1,
        width: 188,
        color: { dark: '#0b0e13', light: '#ffffff' },
      }).catch((err) => {
        toastError(`二维码生成失败：${err.message || err}`)
      })

      const codeInput = el('input', {
        class: 'input mono',
        attrs: {
          type: 'text',
          inputmode: 'numeric',
          maxlength: '6',
          placeholder: '输入验证码完成启用',
          spellcheck: 'false',
        },
      })

      const confirmBtn = button('确认启用', 'primary', async () => {
        const code = codeInput.value.trim()
        if (code.length !== 6) {
          toastError('请输入 6 位验证码')
          return
        }
        confirmBtn.disabled = true
        try {
          const out = await api.enable2fa(code)
          if (out && out.user) {
            Object.assign(user, out.user)
            onUserUpdate && onUserUpdate(user)
          } else {
            user.twofa_enabled = true
          }
          toastSuccess('两步验证已启用')
          refresh()
        } catch (err) {
          toastError(err.message || '启用失败，请检查验证码')
        } finally {
          confirmBtn.disabled = false
        }
      })

      const cancelBtn = button('取消', 'ghost', () => refresh())

      slot.append(
        el('div', { class: 'qr-panel' },
          el('div', { class: 'qr-side' }, canvas, el('div', { class: 'qr-hint', text: '扫描二维码加入验证器' })),
          el('div', { class: 'qr-main' },
            el('div', { class: 'field' },
              el('span', { class: 'field-label', text: '无法扫码？手动输入密钥' }),
              el('div', { class: 'secret-row' }, secretCode,
                button('复制', 'ghost', () => {
                  navigator.clipboard?.writeText(res.secret).then(
                    () => toastSuccess('已复制密钥'),
                    () => toastError('复制失败，请手动选择'),
                  )
                }, 'btn-sm'),
              ),
            ),
            el('div', { class: 'field' },
              el('span', { class: 'field-label', text: '验证器中的 6 位验证码' }),
              codeInput,
            ),
            el('div', { class: 'inline-form' }, confirmBtn, cancelBtn),
            el('p', { class: 'settings-hint', text: '验证码提交成功后 2FA 立即生效，下次登录起需要一并输入。' }),
          ),
        ),
      )
      codeInput.focus()
    }
  }

  // ------------------------------------------------------------- keypair

  function renderKeypair() {
    const section = el('section', { class: 'settings-section' },
      el('div', { class: 'settings-head' },
        el('h3', { class: 'settings-title', text: '密钥对' }),
      ),
      el('p', {
        class: 'settings-text',
        text: '重新生成会立刻作废旧私钥，并返回一把新的私钥（只显示这一次）。',
      }),
    )
    const slot = el('div', { class: 'settings-slot' })
    const regenBtn = button('重新生成密钥对', 'danger', async () => {
      const ok = await confirmDialog({
        title: '重新生成密钥对？',
        message:
          '当前私钥将立即失效，无法再用它登录。生成后请务必立刻下载或复制新私钥，它只显示一次。',
        confirmLabel: '继续生成',
        danger: true,
      })
      if (!ok) return
      regenBtn.disabled = true
      try {
        const res = await api.regenerateKeypair()
        storeKey(user.username, res.private_key)
        slot.innerHTML = ''
        slot.append(
          privateKeyPanel({
            username: user.username,
            privateKey: res.private_key,
            publicKey: res.public_key,
            note: '旧私钥已作废。请立刻保存新私钥，关闭此窗口后将无法再次查看。',
          }),
        )
        toastSuccess('密钥对已更新，旧私钥已失效')
      } catch (err) {
        toastError(err.message || '生成失败')
      } finally {
        regenBtn.disabled = false
      }
    })
    section.append(slot, el('div', { class: 'inline-form' }, regenBtn))
    return section
  }

  function refresh() {
    body.innerHTML = ''
    body.append(renderAccount(), renderTwoFactor(), renderKeypair())
  }
  refresh()

  return modal
}
