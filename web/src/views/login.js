// Login view (#/login): Ed25519 challenge/response with an optional TOTP step.
import nacl from "tweetnacl";
import { api, loadStoredKey, storeKey } from "../net/api.js";
import { b64ToBytes, bytesToB64, parseSeed } from "../util/b64.js";
import { button, el, svgIcon } from "../util/dom.js";
import { toastSuccess } from "../ui/toast.js";

const FRIENDLY_ERRORS = {
  bad_signature: "密钥与该用户不匹配，请粘贴完整私钥或重新选择 .key 文件",
  unknown_user: "用户不存在，请核对用户名或向管理员索取该账号的私钥文件",
  bad_totp: "验证码错误或已过期，请重新输入当前 6 位验证码",
  // docs/protocol.md §10.1: auth endpoints are token-bucket limited now.
  rate_limited: "尝试过于频繁，请稍后再试",
  unauthorized: "登录状态已失效，请重新登录",
  network_error: "无法连接服务端，请确认后端服务已启动",
};

function friendlyMessage(err) {
  if (!err) return "登录失败，请重试";
  if (err.code && FRIENDLY_ERRORS[err.code]) return FRIENDLY_ERRORS[err.code];
  return err.message || "登录失败，请重试";
}

/**
 * @param {HTMLElement} host
 * @param {{ onSuccess: (user: any) => void }} opts
 */
export function mountLogin(host, opts) {
  const { onSuccess } = opts;
  let destroyed = false;
  let busy = false;

  host.innerHTML = "";
  host.className = "view view-login";

  // ---------------------------------------------------------------- fields

  const errorBox = el("div", {
    class: "login-error",
    attrs: { role: "alert" },
    style: { display: "none" },
  });

  const usernameInput = el("input", {
    class: "input mono",
    attrs: {
      type: "text",
      id: "login-username",
      name: "username",
      placeholder: "例如 alice",
      autocomplete: "username",
      spellcheck: "false",
    },
    on: {
      input: () => {
        hideError();
        const stored = loadStoredKey(usernameInput.value);
        if (stored && keyInput.value !== stored) keyInput.value = stored;
      },
    },
  });

  const keyInput = el("textarea", {
    class: "input key-input",
    attrs: {
      id: "login-key",
      name: "private-key",
      rows: "2",
      placeholder: "粘贴 base64 私钥（44 字符），或把 .key 文件拖到下方",
      spellcheck: "false",
      autocomplete: "off",
    },
    on: {
      input: () => hideError(),
    },
  });

  const keyFileInput = el("input", {
    class: "hidden-file",
    attrs: {
      type: "file",
      accept: ".key,.txt,text/plain",
      "aria-label": "选择密钥文件",
    },
    on: {
      change: () => readKeyFile(keyFileInput.files && keyFileInput.files[0]),
    },
  });

  const submitBtn = button("用密钥登录", "primary", () => submit());
  submitBtn.classList.add("login-submit");
  submitBtn.type = "submit";
  submitBtn.disabled = true;
  submitBtn.title = "填写用户名与私钥后即可登录";

  function refreshSubmitState() {
    const ready = Boolean(usernameInput.value.trim() && keyInput.value.trim());
    if (busy) return;
    submitBtn.disabled = !ready;
    submitBtn.title = ready ? "" : "填写用户名与私钥后即可登录";
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = "";
  }

  function hideError() {
    if (errorBox.style.display !== "none") {
      errorBox.style.display = "none";
      errorBox.textContent = "";
    }
    refreshSubmitState();
  }

  async function readKeyFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      keyInput.value = text.trim();
      // Key files are named after the user, so use the name as a hint.
      const base = (file.name || "").replace(/\.(key|txt)$/i, "").trim();
      if (base && !usernameInput.value) usernameInput.value = base;
      hideError();
    } catch (err) {
      showError(
        `读取密钥文件失败：${err.message || err}。请改用粘贴方式导入私钥`,
      );
    }
  }

  const dropZone = el(
    "div",
    {
      class: "key-file-row",
      on: {
        dragover: (ev) => {
          ev.preventDefault();
          dropZone.classList.add("dragging");
        },
        dragleave: () => dropZone.classList.remove("dragging"),
        drop: (ev) => {
          ev.preventDefault();
          dropZone.classList.remove("dragging");
          const file =
            ev.dataTransfer &&
            ev.dataTransfer.files &&
            ev.dataTransfer.files[0];
          readKeyFile(file);
        },
      },
    },
    el(
      "button",
      {
        class: "btn btn-sm",
        attrs: { type: "button" },
        on: { click: () => keyFileInput.click() },
      },
      svgIcon("key", 13),
      el("span", { text: "选择密钥文件" }),
    ),
    el("span", { class: "key-file-hint", text: "也可直接拖入 .key / .txt" }),
    keyFileInput,
  );

  async function submit() {
    if (busy) return;
    const username = usernameInput.value.trim();
    const rawKey = keyInput.value.trim();

    if (!username) {
      showError("请输入用户名，即管理员创建账号时使用的名字");
      usernameInput.focus();
      return;
    }
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
      showError("用户名只支持字母、数字、下划线和连字符，长度 2–32");
      usernameInput.focus();
      return;
    }
    if (!rawKey) {
      showError("请粘贴私钥（44 字符 base64），或选择 .key 文件");
      keyInput.focus();
      return;
    }

    let seed;
    try {
      seed = parseSeed(rawKey);
    } catch (err) {
      showError(err.message || "私钥格式不正确，请粘贴完整的 44 字符私钥");
      keyInput.focus();
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    submitBtn.classList.add("is-busy");
    try {
      const challenge = await api.challenge(username);
      if (!challenge || !challenge.challenge_id || !challenge.nonce) {
        throw new Error("服务端未返回有效挑战，请重试登录");
      }
      const keyPair = nacl.sign.keyPair.fromSeed(seed);
      const signature = nacl.sign.detached(
        b64ToBytes(challenge.nonce),
        keyPair.secretKey,
      );
      const result = await api.login(
        challenge.challenge_id,
        bytesToB64(signature),
      );

      if (result && result.status === "mfa_required") {
        storeKey(username, bytesToB64(seed));
        showMfaStep(username, result.ticket, bytesToB64(seed));
        return;
      }
      if (result && result.status === "ok" && result.user) {
        storeKey(username, bytesToB64(seed));
        toastSuccess(`欢迎回来，${result.user.username}`);
        onSuccess(result.user);
        return;
      }
      showError("登录响应异常，请重试登录");
    } catch (err) {
      showError(friendlyMessage(err));
    } finally {
      busy = false;
      if (!destroyed) {
        submitBtn.classList.remove("is-busy");
        refreshSubmitState();
      }
    }
  }

  // ------------------------------------------------------------- TOTP step

  function showMfaStep(username, ticket, seedB64) {
    const codeInput = el("input", {
      class: "input totp-input",
      attrs: {
        type: "text",
        inputmode: "numeric",
        maxlength: "6",
        placeholder: "000000",
        autocomplete: "one-time-code",
        spellcheck: "false",
        "aria-label": "6 位验证码",
      },
      on: {
        input: () => {
          codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
          mfaError.style.display = "none";
          confirmBtn.disabled = codeInput.value.length !== 6;
          if (codeInput.value.length === 6) confirmMfa();
        },
        keydown: (ev) => {
          if (ev.key === "Enter") confirmMfa();
        },
      },
    });
    const mfaError = el("div", {
      class: "login-error",
      attrs: { role: "alert" },
      style: { display: "none" },
    });
    const confirmBtn = button("验证并登录", "primary", () => confirmMfa());
    confirmBtn.disabled = true;
    confirmBtn.title = "输入 6 位验证码后即可验证";
    const backBtn = button("返回上一步", "ghost", () => {
      mfaCard.remove();
      credentialsCard.style.display = "";
      usernameInput.focus();
    });

    let mfaBusy = false;
    async function confirmMfa() {
      if (mfaBusy) return;
      const code = codeInput.value.trim();
      if (code.length !== 6) {
        mfaError.textContent = "请输入 6 位验证码";
        mfaError.style.display = "";
        return;
      }
      mfaBusy = true;
      confirmBtn.disabled = true;
      confirmBtn.classList.add("is-busy");
      try {
        const result = await api.mfa(ticket, code);
        if (result && result.status === "ok" && result.user) {
          storeKey(username, seedB64);
          toastSuccess(`欢迎回来，${result.user.username}`);
          onSuccess(result.user);
          return;
        }
        mfaError.textContent = "验证失败，请重新输入当前验证码";
        mfaError.style.display = "";
      } catch (err) {
        mfaError.textContent = friendlyMessage(err);
        mfaError.style.display = "";
      } finally {
        mfaBusy = false;
        if (!destroyed) {
          confirmBtn.classList.remove("is-busy");
          confirmBtn.disabled = codeInput.value.trim().length !== 6;
        }
      }
    }

    const mfaCard = el(
      "div",
      { class: "mfa-card" },
      el("div", { class: "mfa-title", text: "两步验证" }),
      el("div", {
        class: "mfa-sub",
        text: `账号 ${username} 已开启 2FA，请输入身份验证器中的 6 位验证码。`,
      }),
      codeInput,
      mfaError,
      el("div", { class: "mfa-actions" }, confirmBtn, backBtn),
    );

    credentialsCard.style.display = "none";
    stack.appendChild(mfaCard);
    codeInput.focus();
  }

  // ------------------------------------------------------------- structure

  const credentialsCard = el(
    "div",
    { class: "login-card" },
    el(
      "div",
      { class: "login-card-head" },
      el("div", { class: "brand-name", text: "md-coworker" }),
      el("div", { class: "brand-sub", text: "实时协作 Markdown 工作区" }),
    ),
    el(
      "form",
      {
        class: "login-body",
        attrs: { novalidate: "" },
        on: {
          submit: (ev) => {
            ev.preventDefault();
            submit();
          },
        },
      },
      el(
        "div",
        { class: "field" },
        el("label", {
          class: "field-label",
          text: "用户名",
          attrs: { for: "login-username" },
        }),
        usernameInput,
      ),
      el(
        "div",
        { class: "field" },
        el("label", {
          class: "field-label",
          text: "私钥",
          attrs: { for: "login-key" },
        }),
        keyInput,
      ),
      dropZone,
      errorBox,
      submitBtn,
    ),
  );

  const stack = el("div", { class: "login-stack" }, credentialsCard);
  host.append(el("div", { class: "login-shell" }, stack));

  usernameInput.addEventListener("input", refreshSubmitState);
  keyInput.addEventListener("input", refreshSubmitState);

  // Prefill from the last successful login.
  try {
    const last = localStorage.getItem("mc.lastUser") || "";
    if (last) {
      usernameInput.value = last;
      const stored = loadStoredKey(last);
      if (stored) keyInput.value = stored;
    }
  } catch {
    /* ignore */
  }
  refreshSubmitState();
  (usernameInput.value ? keyInput : usernameInput).focus();

  return () => {
    destroyed = true;
    host.innerHTML = "";
  };
}
