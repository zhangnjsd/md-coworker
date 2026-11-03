// One-time private key panel: shown once after creation / regeneration.
import { el, copyText, download } from "../util/dom.js";
import { b64ToBytes, formatKeyTextLines } from "../util/b64.js";
import { toastError, toastSuccess } from "../ui/toast.js";

/** Turn a bare base64 seed into the `mc1-…` form; unknown input is shown unchanged. */
function printableKey(seedB64) {
  try {
    return formatKeyTextLines(b64ToBytes(seedB64));
  } catch {
    return seedB64;
  }
}

/**
 * @param {{username: string, privateKey: string, publicKey?: string, note?: string}} opts
 * @returns {HTMLElement}
 */
export function privateKeyPanel({
  username,
  privateKey,
  publicKey = "",
  note = "",
}) {
  const safeName = String(username || "user").replace(/[^a-zA-Z0-9_-]/g, "_");

  // Show and hand out the printable form (`mc1-<seed>-<crc32>`): the checksum lets the
  // client verify a copy before trying to sign in with a damaged key.
  const keyText = printableKey(privateKey);
  const keyBox = el("pre", { class: "key-box", text: keyText });
  const pubBox = publicKey
    ? el("pre", { class: "key-box key-box-dim", text: publicKey })
    : null;

  const copyKeyBtn = el("button", {
    class: "btn btn-ghost",
    attrs: { type: "button" },
    text: "复制密钥",
    on: {
      click: async () => {
        const ok = await copyText(keyText);
        ok
          ? toastSuccess("密钥已复制到剪贴板")
          : toastError("复制失败，请手动选择文本复制");
      },
    },
  });

  const downloadKeyBtn = el("button", {
    class: "btn btn-ghost",
    attrs: { type: "button" },
    text: "下载 .key 文件",
    on: {
      click: () => {
        download(`${safeName}.key`, keyText, "text/plain;charset=utf-8");
        toastSuccess(`已下载 ${safeName}.key`);
      },
    },
  });

  const copyPubBtn = publicKey
    ? el("button", {
        class: "btn btn-ghost",
        attrs: { type: "button" },
        text: "复制公钥",
        on: {
          click: async () => {
            const ok = await copyText(publicKey);
            ok
              ? toastSuccess("公钥已复制")
              : toastError("复制失败，请手动选择文本复制");
          },
        },
      })
    : null;

  return el(
    "div",
    { class: "key-panel" },
    el(
      "div",
      { class: "key-warning" },
      el("strong", { text: "仅显示这一次" }),
      el("span", {
        text:
          note ||
          "私钥关闭后无法再次查看。请立刻复制或下载并妥善保存，泄露后任何人都能以此身份登录。",
      }),
    ),
    el("div", { class: "key-label", text: `私钥（${username}）` }),
    keyBox,
    pubBox ? el("div", { class: "key-label", text: "公钥" }) : null,
    pubBox,
    el("div", { class: "key-actions" }, copyKeyBtn, downloadKeyBtn, copyPubBtn),
  );
}
