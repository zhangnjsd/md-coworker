// Settings dialog: account summary, TOTP two-factor setup/teardown, key rotation.
import QRCode from "qrcode";
import { api, storeKey } from "../net/api.js";
import { button, copyText, el, fmtDateTime } from "../util/dom.js";
import { confirmDialog, openModal } from "../ui/modal.js";
import { privateKeyPanel } from "../ui/secret.js";
import { toastError, toastSuccess } from "../ui/toast.js";

/**
 * @param {{
 *   user: {id: string, username: string, role: string, color?: string, twofa_enabled?: boolean, created_at?: string},
 *   onUserUpdate?: (user: any) => void,
 * }} opts
 */
export function openSettings(opts) {
  const { user, onUserUpdate } = opts;

  const body = el("div", { class: "settings" });

  const modal = openModal({
    title: "设置",
    subtitle: `账号 ${user.username}`,
    body,
    width: 560,
    actions: [{ label: "关闭", kind: "ghost", close: true }],
  });

  function section(title, extra) {
    return el(
      "section",
      { class: "settings-section" },
      el(
        "div",
        { class: "settings-head" },
        el("h3", { class: "settings-title", text: title }),
        extra || null,
      ),
    );
  }

  function kvRow(key, valueNode) {
    return el(
      "div",
      { class: "kv" },
      el("span", { class: "kv-key", text: key }),
      el("span", { class: "kv-val" }, valueNode),
    );
  }

  // ------------------------------------------------------------- account

  function renderAccount() {
    const node = section("账号");
    const list = el("div", { class: "kv-list" });
    list.append(
      kvRow("用户名", el("span", { class: "mono", text: user.username })),
      kvRow(
        "角色",
        el("span", {
          class: `badge badge-${user.role === "admin" ? "admin" : "user"}`,
          text: user.role,
        }),
      ),
      kvRow(
        "标识色",
        el(
          "span",
          { class: "settings-swatch" },
          el("span", {
            class: "dot",
            style: { background: user.color || "var(--accent)" },
          }),
          el("span", {
            class: "settings-hint",
            text: "协作光标与在线标识使用该颜色",
          }),
        ),
      ),
      user.created_at
        ? kvRow(
            "创建时间",
            el("span", {
              class: "settings-mono",
              text: fmtDateTime(user.created_at),
            }),
          )
        : null,
    );
    node.append(list);
    return node;
  }

  // ------------------------------------------------------------- 2FA block

  function renderTwoFactor() {
    const enabled = !!user.twofa_enabled;
    const node = section(
      "二次验证",
      el("span", {
        class: `badge ${enabled ? "badge-ok" : "badge-muted"}`,
        text: enabled ? "已开启" : "未开启",
      }),
    );

    node.append(
      el("p", {
        class: "settings-text",
        text: enabled
          ? "登录时除密钥签名外，还需要输入身份验证器中的 6 位验证码。"
          : "开启后登录需要额外输入 6 位动态验证码，密钥泄露时仍有一道防线。",
      }),
    );

    const slot = el("div", { class: "settings-slot" });
    node.append(slot);

    if (enabled) {
      const codeInput = el("input", {
        class: "input totp-input",
        attrs: {
          type: "text",
          inputmode: "numeric",
          maxlength: "6",
          placeholder: "000000",
          spellcheck: "false",
          "aria-label": "当前 6 位验证码",
        },
      });
      const disableBtn = button("关闭 2FA", "danger", async () => {
        const code = codeInput.value.trim();
        if (code.length !== 6) {
          toastError("请输入身份验证器中的 6 位验证码");
          codeInput.focus();
          return;
        }
        disableBtn.disabled = true;
        disableBtn.classList.add("is-busy");
        try {
          const res = await api.disable2fa(code);
          if (res && res.user) {
            Object.assign(user, res.user);
            onUserUpdate && onUserUpdate(user);
          } else {
            user.twofa_enabled = false;
          }
          toastSuccess("已关闭二次验证");
          refresh();
        } catch (err) {
          toastError(err.message || "关闭 2FA 失败，请检查验证码");
        } finally {
          disableBtn.classList.remove("is-busy");
          disableBtn.disabled = false;
        }
      });
      slot.append(
        el("div", { class: "inline-form" }, codeInput, disableBtn),
        el("p", {
          class: "settings-hint",
          text: "关闭 2FA 需要输入当前验证码确认身份。",
        }),
      );
      return node;
    }

    const startBtn = button("开启 2FA", "primary", async () => {
      startBtn.disabled = true;
      startBtn.classList.add("is-busy");
      try {
        const res = await api.setup2fa();
        renderSetup(res);
      } catch (err) {
        toastError(err.message || "无法获取 2FA 配置，请重试");
      } finally {
        startBtn.classList.remove("is-busy");
        startBtn.disabled = false;
      }
    });
    slot.append(el("div", { class: "inline-form" }, startBtn));
    return node;

    function renderSetup(res) {
      slot.innerHTML = "";

      const canvas = el("canvas", {
        class: "qr-canvas",
        attrs: { width: "188", height: "188" },
      });
      QRCode.toCanvas(canvas, res.otpauth_url, { margin: 1, width: 188 }).catch(
        (err) => {
          toastError(`二维码生成失败：${err.message || err}，请用手动密钥绑定`);
        },
      );

      const secretCode = el("code", { class: "secret-code", text: res.secret });
      const copyBtn = button(
        "复制密钥",
        "ghost",
        async () => {
          const ok = await copyText(res.secret);
          ok
            ? toastSuccess("已复制手动密钥")
            : toastError("复制失败，请手动选择文本复制");
        },
        "btn-sm",
      );

      const codeInput = el("input", {
        class: "input totp-input",
        attrs: {
          type: "text",
          inputmode: "numeric",
          maxlength: "6",
          placeholder: "000000",
          spellcheck: "false",
          "aria-label": "验证器中的 6 位验证码",
        },
      });

      const confirmBtn = button("启用 2FA", "primary", async () => {
        const code = codeInput.value.trim();
        if (code.length !== 6) {
          toastError("请输入验证器中的 6 位验证码");
          codeInput.focus();
          return;
        }
        confirmBtn.disabled = true;
        confirmBtn.classList.add("is-busy");
        try {
          const out = await api.enable2fa(code);
          if (out && out.user) {
            Object.assign(user, out.user);
            onUserUpdate && onUserUpdate(user);
          } else {
            user.twofa_enabled = true;
          }
          toastSuccess("二次验证已开启");
          refresh();
        } catch (err) {
          toastError(err.message || "启用 2FA 失败，请检查验证码后重试");
        } finally {
          confirmBtn.classList.remove("is-busy");
          confirmBtn.disabled = false;
        }
      });

      slot.append(
        el(
          "div",
          { class: "qr-panel" },
          el(
            "div",
            { class: "qr-side" },
            canvas,
            el("div", { class: "qr-hint", text: "用身份验证器扫描" }),
          ),
          el(
            "div",
            { class: "qr-main" },
            el(
              "div",
              { class: "field" },
              el("span", { class: "field-label", text: "无法扫码时手动输入" }),
              el("div", { class: "secret-row" }, secretCode, copyBtn),
            ),
            el("p", {
              class: "settings-hint",
              text: "系统不提供一次性恢复码：请在验证器内备份该条目，丢失设备后只能请管理员重置 2FA。",
            }),
            el(
              "div",
              { class: "field" },
              el("span", {
                class: "field-label",
                text: "验证器中的 6 位验证码",
              }),
              codeInput,
            ),
            el(
              "div",
              { class: "inline-form" },
              confirmBtn,
              button("取消", "ghost", () => refresh()),
            ),
          ),
        ),
      );
      codeInput.focus();
    }
  }

  // ------------------------------------------------------------- totp prompt

  /**
   * Ask for the current 6-digit TOTP code before a sensitive self-service call.
   * Reuses the generic modal plus the `.totp-input` control already used by the
   * 2FA section, so no new widget/component library is introduced.
   * @returns {Promise<string | null>} the code, or null when the user cancels.
   */
  function promptTotpCode() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const codeInput = el("input", {
        class: "input totp-input",
        attrs: {
          type: "text",
          inputmode: "numeric",
          autocomplete: "one-time-code",
          maxlength: "6",
          placeholder: "000000",
          spellcheck: "false",
          "aria-label": "当前 6 位验证码",
        },
      });
      const errorNode = el("p", {
        class: "field-error",
        style: { display: "none" },
      });

      codeInput.addEventListener("input", () => {
        const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
        if (digits !== codeInput.value) codeInput.value = digits;
      });

      const body = el(
        "div",
        { class: "field" },
        el("span", { class: "field-label", text: "当前 6 位验证码" }),
        codeInput,
        el("p", {
          class: "settings-hint",
          text: "该账号已开启二次验证，重新生成密钥前需要先确认是本人操作。",
        }),
        errorNode,
      );

      const submit = () => {
        const code = codeInput.value.trim();
        if (!/^\d{6}$/.test(code)) {
          errorNode.textContent = "请输入身份验证器中的 6 位数字验证码";
          errorNode.style.display = "";
          codeInput.focus();
          return;
        }
        finish(code);
        modal.close();
      };

      codeInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          submit();
        }
      });

      const modal = openModal({
        title: "输入验证码",
        subtitle: `账号 ${user.username}`,
        body,
        width: 440,
        actions: [
          { label: "取消", kind: "ghost", onClick: () => finish(null) },
          { label: "继续", kind: "primary", onClick: submit, close: false },
        ],
        onClose: () => finish(null),
      });
      codeInput.focus();
    });
  }

  // ------------------------------------------------------------- keypair

  function renderKeypair() {
    const needsTotp = !!user.twofa_enabled;
    const node = section("登录密钥");
    node.append(
      el("p", {
        class: "settings-text",
        text: needsTotp
          ? "重新生成后旧密钥立即失效，其他设备会被登出；因为已开启二次验证，需要先输入当前 6 位验证码。"
          : "重新生成后旧密钥立即失效，请把新密钥保存到安全位置。",
      }),
    );
    const regenBtn = button("重新生成密钥", "danger", async () => {
      let totp = null;
      if (needsTotp) {
        totp = await promptTotpCode();
        if (totp === null) return;
      }
      const ok = await confirmDialog({
        title: "重新生成密钥？",
        message:
          "当前私钥将立即失效，无法再用它登录。新私钥只显示一次，请立刻复制或下载保存。",
        confirmLabel: "重新生成",
        danger: true,
      });
      if (!ok) return;
      regenBtn.disabled = true;
      regenBtn.classList.add("is-busy");
      try {
        const res = await api.regenerateKeypair({ totp });
        storeKey(user.username, res.private_key);
        toastSuccess("密钥已重新生成，旧密钥已失效");
        const keyModal = openModal({
          title: "新密钥已生成",
          subtitle: `账号 ${user.username}`,
          body: privateKeyPanel({
            username: user.username,
            privateKey: res.private_key,
            publicKey: res.public_key,
            note: "旧密钥已立即失效，其他设备会被登出。关闭此窗口后无法再次查看，请立刻保存到安全位置。",
          }),
          width: 640,
          actions: [
            {
              label: "我已保存，关闭",
              kind: "primary",
              onClick: () => keyModal.close(),
            },
          ],
        });
      } catch (err) {
        const code = err && err.code;
        if (code === "mfa_required") {
          toastError("需要输入当前的 6 位验证码才能重新生成密钥");
        } else if (code === "bad_totp") {
          toastError("验证码错误或已过期，请重新输入当前 6 位验证码");
        } else {
          toastError(err.message || "生成密钥失败，请重试");
        }
      } finally {
        regenBtn.classList.remove("is-busy");
        regenBtn.disabled = false;
      }
    });
    node.append(el("div", { class: "settings-danger" }, regenBtn));
    return node;
  }

  function refresh() {
    body.innerHTML = "";
    body.append(renderAccount(), renderTwoFactor(), renderKeypair());
  }
  refresh();

  return modal;
}
