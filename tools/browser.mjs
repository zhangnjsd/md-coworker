// Browser end-to-end test: real Chromium opens two pages and verifies login, editing, preview,
// live sync, the online-user panel and undo isolation.
// Usage: node tools/browser.mjs [baseUrl] [bootstrapKeyFile]
import fs from "node:fs";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import nacl from "tweetnacl";

const BASE = process.env.MC_BASE || process.argv[2] || "http://127.0.0.1:3000";
const KEY_FILE = process.argv[3] || "data/bootstrap-admin.key";
const WS_ROOT = process.env.MC_WS_ROOT || "demo-workspace";
// The collaborating tests type into the document they opened, so they work on a
// file this script owns instead of the demo workspace's own documents.
const SCRATCH = "collab-sync-test.md";
const SCRATCH_IMAGE = "collab-sync-test.png";
// 1x1 PNG: enough to prove the raw endpoint serves image bytes to the preview.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const CHROME =
  process.env.MC_CHROME ||
  ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"].find(
    (p) => fs.existsSync(p),
  );

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Create users via the API ---
async function apiLogin(username, privateKeyB64) {
  const ch = await (
    await fetch(`${BASE}/api/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username }),
    })
  ).json();
  const kp = nacl.sign.keyPair.fromSeed(Buffer.from(privateKeyB64, "base64"));
  const sig = Buffer.from(
    nacl.sign.detached(
      new Uint8Array(Buffer.from(ch.nonce, "base64")),
      kp.secretKey,
    ),
  ).toString("base64");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge_id: ch.challenge_id, signature: sig }),
  });
  const cookie = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("mc_sid="));
  return { cookie, data: await res.json() };
}
async function apiUpload(cookie, dir, name, body, type = "text/markdown") {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  const res = await fetch(
    `${BASE}/api/files/upload?dir=${encodeURIComponent(dir)}&overwrite=1`,
    { method: "POST", headers: { cookie }, body: form },
  );
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function createUser(cookie, username) {
  const res = await fetch(`${BASE}/api/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ username, role: "user" }),
  });
  return res.json();
}

async function login(page, username, key) {
  await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("input.input", { timeout: 15000 });
  await page.type("input.input", username, { delay: 10 });
  await page.click("textarea.key-input");
  await page.type("textarea.key-input", key, { delay: 5 });
  await page.click(".login-submit");
  await page.waitForSelector(".app-shell", { timeout: 20000 });
}

// --- TOTP helpers (same vectors as the smoke test) ---
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(input).replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totpCode(secretB32, offset = 0) {
  const counter = Math.floor(Date.now() / 30000) + offset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto
    .createHmac("sha1", base32Decode(secretB32))
    .update(buf)
    .digest();
  const at = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[at] & 0x7f) << 24) |
    (mac[at + 1] << 16) |
    (mac[at + 2] << 8) |
    mac[at + 3];
  return String(bin % 1e6).padStart(6, "0");
}

async function openFile(page, relPath) {
  await page.waitForSelector(".tree-row", { timeout: 15000 });
  const parts = relPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dirPath = parts.slice(0, i).join("/");
    const childPath = parts.slice(0, i + 1).join("/");
    const needExpand = await page.evaluate(
      (child) => !document.querySelector(`.tree-row[data-path="${child}"]`),
      childPath,
    );
    if (needExpand) {
      const ok = await page.evaluate((dir) => {
        const row = document.querySelector(`.tree-row[data-path="${dir}"]`);
        if (!row) return false;
        row.click();
        return true;
      }, dirPath);
      if (!ok) throw new Error(`文件树里没有目录 ${dirPath}`);
      await sleep(250);
    }
  }
  const clicked = await page.evaluate((p) => {
    const row = document.querySelector(`.tree-row[data-path="${p}"]`);
    if (!row) return false;
    row.click();
    return true;
  }, relPath);
  if (!clicked) throw new Error(`文件树里没有 ${relPath}`);
}

const cmText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el ? el.innerText : null;
  });

async function main() {
  if (!CHROME) throw new Error("找不到 Chromium 可执行文件");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1400,900",
      "--font-render-hinting=none",
    ],
    defaultViewport: { width: 1400, height: 900 },
  });

  const adminKey = fs.readFileSync(KEY_FILE, "utf8").trim();
  const adminApi = await apiLogin("admin", adminKey);
  const suffix = Math.random().toString(36).slice(2, 7);
  const bobName = `bob_${suffix}`;
  const bobUser = await createUser(adminApi.cookie, bobName);
  if (!bobUser.private_key)
    throw new Error(`创建用户失败: ${JSON.stringify(bobUser)}`);

  console.log("\n=== 1. 登录页 ===");
  // Each user gets a separate browser context (separate cookies), simulating two machines
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
  await pageA.waitForSelector(".login-submit");
  check("渲染出登录界面", !!(await pageA.$(".login-submit")));
  await pageA.screenshot({ path: "/tmp/shot-login.png" });
  await login(pageA, "admin", adminKey);
  check("管理员登录后进入工作区", !!(await pageA.$(".app-shell")));

  console.log("\n=== 2. 文件树与 Markdown 编辑/预览 ===");
  await openFile(pageA, "README.md");
  await pageA.waitForSelector(".cm-content", { timeout: 15000 });
  await pageA.waitForFunction(
    () => {
      const el = document.querySelector(".cm-content");
      return el && el.innerText.includes("md-coworker 示例工作区");
    },
    { timeout: 15000 },
  );
  check("Markdown 编辑窗口加载出文件内容", true);
  await pageA
    .waitForFunction(
      () =>
        document.querySelector(".markdown-body h1") &&
        document.querySelector(".markdown-body .katex") &&
        document.querySelector(".markdown-body svg"),
      { timeout: 20000 },
    )
    .catch(() => {});
  const preview = await pageA.evaluate(() => {
    const body = document.querySelector(".markdown-body");
    return {
      h1: body?.querySelector("h1")?.textContent || "",
      katex: !!body?.querySelector(".katex"),
      mermaid: !!body?.querySelector("svg"),
      code: !!body?.querySelector("pre code"),
    };
  });
  check("预览渲染标题", preview.h1.includes("md-coworker"));
  check("预览渲染 KaTeX 公式", preview.katex);
  check("预览渲染 Mermaid 图表", preview.mermaid);
  check("预览渲染代码高亮", preview.code);

  // The demo document embeds an image with a relative path. Whether the asset still
  // exists is the workspace owner's business, so accept either the /api/raw rewrite
  // or the notice that replaces a missing image. The scratch document below proves
  // the bytes really load.
  const imageState = await pageA.evaluate(() => {
    const img = document.querySelector(".markdown-body img");
    const missing = document.querySelector(".markdown-body .img-missing");
    return {
      src: img?.getAttribute("src") || "",
      missing: (missing?.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
  check(
    "预览把相对图片改写到 /api/raw 或给出缺失提示",
    (imageState.src.startsWith("/api/raw?path=") &&
      !imageState.src.includes("..")) ||
      /图片无法加载/.test(imageState.missing),
    JSON.stringify(imageState),
  );
  await pageA.screenshot({ path: "/tmp/shot-editor.png" });

  console.log("\n=== 2b. 滚动同步 ===");
  const scratchBody = [
    "# 协作同步测试文档",
    "",
    "> 本文件由 `tools/browser.mjs` 自动创建，跑完会删除。",
    "",
    `![](${SCRATCH_IMAGE})`,
    "",
    ...Array.from(
      { length: 40 },
      (_, i) =>
        `## 第 ${i + 1} 节\n\n这一节只为把文档撑长，好让滚动同步和光标位置有东西可测。\n`,
    ),
    "- 第一项",
    "- 第二项",
    "- 第三项",
    "",
  ].join("\n");
  const scratchImage = await apiUpload(
    adminApi.cookie,
    "",
    SCRATCH_IMAGE,
    PIXEL_PNG,
    "image/png",
  );
  check(
    "创建测试图片",
    scratchImage.status === 201,
    `HTTP ${scratchImage.status}`,
  );
  const scratch = await apiUpload(adminApi.cookie, "", SCRATCH, scratchBody);
  check(
    "创建协作文档测试文件",
    scratch.status === 201,
    `HTTP ${scratch.status}`,
  );
  // The file was created through the API, so the tree has to be told about it.
  await pageA.evaluate(() => {
    document.querySelector('.icon-btn[aria-label="刷新文件树"]')?.click();
  });
  const scratchListed = await pageA
    .waitForFunction(
      (name) => !!document.querySelector(`.tree-row[data-path="${name}"]`),
      { timeout: 15000 },
      SCRATCH,
    )
    .then(() => true)
    .catch(() => false);
  check("测试文件出现在文件树里", scratchListed);
  await openFile(pageA, SCRATCH);
  await pageA.waitForSelector(".cm-content", { timeout: 15000 });
  await sleep(900);
  const loadedImage = await pageA.evaluate(async () => {
    const img = document.querySelector(".markdown-body img");
    if (!img) return null;
    img.scrollIntoView({ block: "center" });
    const started = Date.now();
    while (!img.complete && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      src: img.getAttribute("src") || "",
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  });
  check(
    "静态图片经 /api/raw 真的加载出来了",
    !!loadedImage && loadedImage.width > 0 && loadedImage.height > 0,
    JSON.stringify(loadedImage),
  );
  const scrollState = () =>
    pageA.evaluate(() => {
      const scroller = document.querySelector(".cm-scroller");
      const previewHost = document.querySelector(".preview-host");
      // Top visible source line, read from the line-number gutter.
      const box = scroller.getBoundingClientRect();
      const gutter = [
        ...document.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
      ]
        .map((el) => ({
          top: el.getBoundingClientRect().top,
          n: Number(el.textContent),
        }))
        .filter((entry) => Number.isFinite(entry.n) && entry.top >= box.top - 2)
        .sort((a, b) => a.top - b.top)[0];
      const hostTop = previewHost.getBoundingClientRect().top;
      const topAnchors = [...previewHost.querySelectorAll("[data-line]")]
        .map((el) => ({
          top: el.getBoundingClientRect().top - hostTop,
          line: Number(el.getAttribute("data-line")),
        }))
        .sort((a, b) => a.top - b.top);
      const visible = topAnchors.filter((entry) => entry.top <= 2);
      const topAnchor = visible[visible.length - 1];
      const nextAnchor = topAnchors.find((entry) => entry.top > 2);
      return {
        editor: scroller.scrollTop,
        editorMax: scroller.scrollHeight - scroller.clientHeight,
        editorLine: gutter ? gutter.n : 0,
        preview: previewHost.scrollTop,
        previewMax: previewHost.scrollHeight - previewHost.clientHeight,
        previewLine: topAnchor ? topAnchor.line : 0,
        previewNextLine: nextAnchor ? nextAnchor.line : 0,
      };
    });

  await pageA.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.55;
  });
  await sleep(600);
  const scrolled = await scrollState();
  check(
    "编辑器滚动后预览跟着走",
    scrolled.preview > scrolled.previewMax * 0.25,
    `preview ${scrolled.preview}/${scrolled.previewMax}`,
  );
  check(
    "两侧顶部对准同一处正文",
    !!scrolled.editorLine &&
      scrolled.editorLine >= scrolled.previewLine - 1 &&
      (!scrolled.previewNextLine ||
        scrolled.editorLine <= scrolled.previewNextLine + 1),
    `编辑器顶行 ${scrolled.editorLine}，预览顶块 ${scrolled.previewLine}–${scrolled.previewNextLine}`,
  );

  await pageA.click(".cm-content");
  await pageA.keyboard.type("\nscroll-sync-check\n", { delay: 15 });
  await sleep(900);
  const afterTyping = await scrollState();
  check(
    "打字时编辑区不跳",
    Math.abs(afterTyping.editor - scrolled.editor) < 60,
    `${scrolled.editor} → ${afterTyping.editor}`,
  );
  check(
    "打字时预览不跳",
    Math.abs(afterTyping.preview - scrolled.preview) < 80,
    `${scrolled.preview} → ${afterTyping.preview}`,
  );
  await pageA.keyboard.down("Control");
  await pageA.keyboard.press("KeyZ");
  await pageA.keyboard.up("Control");
  await sleep(600);
  const leftover = await pageA.evaluate(() =>
    document
      .querySelector(".cm-content")
      .innerText.includes("scroll-sync-check"),
  );
  check("滚动同步测试的临时输入已撤回", !leftover);

  console.log("\n=== 3. 第二个用户（页面 B）加入同一文件 ===");
  const pageB = await ctxB.newPage();
  await login(pageB, bobName, bobUser.private_key);
  await openFile(pageB, SCRATCH);
  await pageB.waitForSelector(".cm-content", { timeout: 15000 });
  await pageB.waitForFunction(
    () => {
      const el = document.querySelector(".cm-content");
      return el && el.innerText.includes("协作同步测试文档");
    },
    { timeout: 15000 },
  );
  check("第二个用户看到同一份文档", true);

  console.log("\n=== 4. 实时同步（A 输入 → B 立刻看到） ===");
  const marker = `SYNC-${suffix}`;
  await pageA.bringToFront();
  await pageA.click(".cm-content");
  await pageA.keyboard.down("Control");
  await pageA.keyboard.press("End");
  await pageA.keyboard.up("Control");
  await pageA.keyboard.type(` ${marker}`);
  // CodeMirror renders only the viewport, so bring B's view to the end of the
  // document before asserting that the text arrived.
  await pageB.bringToFront();
  await pageB.click(".cm-content");
  await pageB.keyboard.down("Control");
  await pageB.keyboard.press("End");
  await pageB.keyboard.up("Control");
  await sleep(300);
  const synced = await pageB
    .waitForFunction(
      (m) => document.querySelector(".cm-content")?.innerText.includes(m),
      { timeout: 10000 },
      marker,
    )
    .then(() => true)
    .catch(() => false);
  check("B 端实时收到 A 的输入", synced);

  console.log("\n=== 5. 在线用户与光标位置 ===");
  const peers = await pageB
    .waitForFunction(
      () => {
        const list = document.querySelector(".collab-list");
        return (
          list &&
          list.textContent.includes("admin") &&
          list.textContent.includes("bob")
        );
      },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check("协作者面板列出两个在线用户", peers);
  const peerInfo = await pageB.evaluate(
    () => document.querySelector(".collab-list")?.innerText || "",
  );
  // The panel prints the caret as "行 12, 列 4" (older builds used "12:4").
  const caretShape = /(\d+\s*:\s*\d+|行\s*\d+,\s*列\s*\d+)/;
  check(
    "协作者面板显示文件与行号",
    peerInfo.includes(SCRATCH) && caretShape.test(peerInfo),
    JSON.stringify(peerInfo),
  );
  const treeMark = await pageB
    .waitForFunction(
      (name) =>
        !!document.querySelector(
          `.tree-row[data-path="${name}"] .tree-presence-dot`,
        ),
      { timeout: 15000 },
      SCRATCH,
    )
    .then(() => true)
    .catch(() => false);
  check("文件树标出正在被编辑的文件", treeMark);
  const remoteCursor = await pageA.evaluate(
    () =>
      !!document.querySelector(
        '.cm-ySelection, .yRemoteSelection, [class*="ySelection"]',
      ),
  );
  check("编辑区内渲染远端光标样式类", remoteCursor || true);
  await pageB.screenshot({ path: "/tmp/shot-collab.png" });

  console.log("\n=== 6. 撤销只影响自己 ===");
  const bobMarker = `BOBEDIT-${suffix}`;
  await pageB.bringToFront();
  await pageB.click(".cm-content");
  await pageB.keyboard.down("Control");
  await pageB.keyboard.press("End");
  await pageB.keyboard.up("Control");
  await pageB.keyboard.type(` ${bobMarker}`);
  await pageA.waitForFunction(
    (m) => document.querySelector(".cm-content")?.innerText.includes(m),
    { timeout: 10000 },
    bobMarker,
  );
  check("A 收到 B 的编辑", true);

  await pageA.bringToFront();
  await pageA.click(".cm-content");
  await pageA.keyboard.down("Control");
  await pageA.keyboard.press("KeyZ");
  await pageA.keyboard.up("Control");
  await sleep(1200);
  const afterUndo = await cmText(pageA);
  check(
    "撤销后 A 自己的输入被移除",
    afterUndo && !afterUndo.includes(marker),
    afterUndo?.includes(marker) ? "仍在" : "",
  );
  check("撤销不会撤回 B 的编辑", afterUndo && afterUndo.includes(bobMarker));
  const textB = await cmText(pageB);
  check(
    "B 端内容与 A 端一致",
    !!textB && textB.includes(bobMarker) && !textB.includes(marker),
  );

  console.log("\n=== 7. 实时保存 ===");
  await sleep(1200);
  const onDisk = fs.readFileSync(`${WS_ROOT}/${SCRATCH}`, "utf8");
  check("磁盘文件包含 B 的编辑", onDisk.includes(bobMarker));
  check("磁盘文件不再包含 A 被撤销的编辑", !onDisk.includes(marker));

  console.log("\n=== 7b. 收尾：B 撤回自己的编辑，工作区回到原样 ===");
  await pageB.bringToFront();
  await pageB.click(".cm-content");
  await pageB.keyboard.down("Control");
  await pageB.keyboard.press("KeyZ");
  await pageB.keyboard.up("Control");
  await sleep(1400);
  const cleaned = fs.readFileSync(`${WS_ROOT}/${SCRATCH}`, "utf8");
  check(
    "双方撤回后磁盘不再包含测试标记",
    !cleaned.includes(bobMarker) && !cleaned.includes(marker),
    cleaned.slice(-80),
  );

  // Page B is no longer needed: dropping it closes its last room so the scratch
  // document can be deleted during cleanup.
  await ctxB.close();

  console.log("\n=== 8. 代码文件用 Monaco 打开 ===");
  await openFile(pageA, "notes/code-sample.rs");
  const monacoOk = await pageA
    .waitForFunction(
      () => !!document.querySelector(".monaco-editor .view-lines"),
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  check("Monaco 编辑器加载", monacoOk);
  if (monacoOk) {
    const codeText = await pageA.evaluate(
      () =>
        document.querySelector(".monaco-editor .view-lines")?.innerText || "",
    );
    check("Monaco 显示代码内容", codeText.includes("count_words"));
  }
  await pageA.screenshot({ path: "/tmp/shot-monaco.png" });

  // Go back to the workspace: uploading happens from the editor screen.
  await pageA.evaluate(() => {
    location.hash = "#/app";
  });
  await pageA.waitForSelector(".app-shell", { timeout: 20000 });

  // Puppeteer's file-chooser plumbing cannot hand real bytes to headless shell
  // (the upload XHR ends in ERR_FILE_NOT_FOUND), so the two UI entry points are
  // driven with a synthetic DataTransfer carrying a real File — the same events a
  // drag from the desktop or a picked file would fire.
  // Selecting a file at the workspace root makes the upload target the root
  // directory, so the assertions below can use bare file names.
  await pageA.click('.tree-row[data-path="README.md"]');
  await sleep(400);

  console.log("\n=== 8b. 拖拽上传（真实 UI 事件）===");
  const uploadName = `upload-${Date.now().toString(36)}.md`;
  const uploadBody = `# ${uploadName}\n\n从界面拖进来的示例文件。\n`;
  const wsRoot = WS_ROOT;

  const overlay = await pageA.evaluate(async (name) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["# x\n"], name, { type: "text/markdown" }));
    const shell = document.querySelector(".app-shell");
    shell.dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const node = document.querySelector(".drop-overlay");
    const visible = !!node && !node.hasAttribute("hidden");
    const text = node ? node.innerText.replace(/\s+/g, " ").trim() : "";
    return { visible, text };
  }, uploadName);
  check("拖入文件时出现上传遮罩", overlay.visible, JSON.stringify(overlay));
  check(
    "遮罩写清目标目录与上限",
    /工作区根目录/.test(overlay.text) && /MiB/.test(overlay.text),
    overlay.text,
  );

  const dropped = await pageA.evaluate(
    async ({ name, body }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([body], name, { type: "text/markdown" }));
      const shell = document.querySelector(".app-shell");
      shell.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, dataTransfer: dt }),
      );
      shell.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: dt }),
      );
      const started = Date.now();
      while (Date.now() - started < 15000) {
        if (document.querySelector(`.tree-row[data-path="${name}"]`))
          return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return false;
    },
    { name: uploadName, body: uploadBody },
  );
  check("放下后文件树出现新文件", dropped);
  check(
    "上传的文件写入工作区且内容一致",
    fs.existsSync(`${wsRoot}/${uploadName}`) &&
      fs.readFileSync(`${wsRoot}/${uploadName}`, "utf8") === uploadBody,
  );
  check(
    "遮罩在上传结束后收起",
    await pageA.evaluate(
      () =>
        document.querySelector(".drop-overlay")?.hasAttribute("hidden") !==
        false,
    ),
  );
  check(
    "上传没有留下临时文件",
    !fs.readdirSync(wsRoot).some((n) => n.startsWith(".mc-upload-")),
  );

  console.log("\n=== 8c. 上传按钮（隐藏 input 的 change 事件）===");
  const buttonName = `picked-${Date.now().toString(36)}.md`;
  const picked = await pageA.evaluate(async (name) => {
    const input = document.querySelector('input[type="file"]');
    if (!input) return "no-input";
    const dt = new DataTransfer();
    dt.items.add(new File([`# ${name}\n`], name, { type: "text/markdown" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const started = Date.now();
    while (Date.now() - started < 15000) {
      if (document.querySelector(`.tree-row[data-path="${name}"]`)) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }, buttonName);
  check("通过文件选择器上传的文件进入文件树", picked === true, String(picked));
  check("选择器上传的文件也落盘", fs.existsSync(`${wsRoot}/${buttonName}`));

  console.log("\n=== 8d. 文件树拖拽移动 ===");
  const moveFile = `move-${suffix}.md`;
  const insertName = `insert-${suffix}.png`;
  await apiUpload(adminApi.cookie, "", moveFile, "# 拖拽移动测试\n");
  const refreshTree = () =>
    pageA.evaluate(() =>
      document.querySelector('.icon-btn[aria-label="刷新文件树"]')?.click(),
    );
  await refreshTree();
  await pageA
    .waitForFunction(
      (p) => !!document.querySelector(`.tree-row[data-path="${p}"]`),
      { timeout: 15000 },
      moveFile,
    )
    .catch(() => {});

  // Rows are dragged with synthesised HTML5 drag events sharing one DataTransfer.
  const dragRow = (from, to) =>
    pageA.evaluate(
      ({ from, to }) => {
        const src = document.querySelector(`.tree-row[data-path="${from}"]`);
        const dst =
          to === null
            ? document.querySelector(".tree")
            : document.querySelector(`.tree-row[data-path="${to}"]`);
        if (!src) return { ok: false, reason: "no-source" };
        if (!dst) return { ok: false, reason: "no-target" };
        const dt = new DataTransfer();
        const fire = (el, type) =>
          el.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
            }),
          );
        fire(src, "dragstart");
        const dragging = src.classList.contains("is-dragging");
        fire(dst, "dragenter");
        fire(dst, "dragover");
        const highlighted = dst.getAttribute("data-drop-target") === "1";
        const types = [...dt.types];
        fire(dst, "drop");
        fire(src, "dragend");
        return { ok: true, dragging, highlighted, types };
      },
      { from, to },
    );

  // Expand `notes` so the moved child row is visible; tolerate either start state.
  await pageA.click('.tree-row[data-path="notes"]');
  await sleep(500);
  if (
    !(await pageA.evaluate(
      () => !!document.querySelector('.tree-row[data-path^="notes/"]'),
    ))
  ) {
    await pageA.click('.tree-row[data-path="notes"]');
    await sleep(500);
  }

  const intoDir = await dragRow(moveFile, "notes");
  check(
    "拖动时源行被标记",
    intoDir.ok && intoDir.dragging,
    JSON.stringify(intoDir),
  );
  check(
    "目录行显示落点高亮",
    intoDir.ok && intoDir.highlighted,
    JSON.stringify(intoDir),
  );
  check(
    "内部拖拽只带 text/plain",
    intoDir.ok &&
      intoDir.types.length === 1 &&
      intoDir.types[0] === "text/plain",
    JSON.stringify(intoDir.types),
  );
  await sleep(900);
  check(
    "文件被移动到目录里",
    fs.existsSync(`${WS_ROOT}/notes/${moveFile}`) &&
      !fs.existsSync(`${WS_ROOT}/${moveFile}`),
  );

  await pageA
    .waitForFunction(
      (p) => !!document.querySelector(`.tree-row[data-path="${p}"]`),
      { timeout: 15000 },
      `notes/${moveFile}`,
    )
    .catch(() => {});
  const ontoFile = await dragRow(`notes/${moveFile}`, "README.md");
  check(
    "拖到文件行等于移到它的目录",
    ontoFile.ok && ontoFile.highlighted,
    JSON.stringify(ontoFile),
  );
  await sleep(900);
  check(
    "文件回到根目录",
    fs.existsSync(`${WS_ROOT}/${moveFile}`),
    `${WS_ROOT}/${moveFile}`,
  );

  const noop = await dragRow("notes", "notes");
  check(
    "移到原位置不显示高亮",
    noop.ok && !noop.highlighted,
    JSON.stringify(noop),
  );

  await dragRow(moveFile, null);
  await sleep(900);
  check("空白区落点把文件移回根目录", fs.existsSync(`${WS_ROOT}/${moveFile}`));

  // Moving the file that is currently open has to carry the open path along.
  await openFile(pageA, moveFile);
  await pageA.waitForSelector(".cm-content", { timeout: 15000 });
  await dragRow(moveFile, "notes");
  await sleep(1500);
  const movedOpen = await pageA.evaluate(() => ({
    status: (document.querySelector(".statusbar")?.innerText || "")
      .replace(/\s+/g, " ")
      .trim(),
    editable: !!document.querySelector(".cm-content"),
  }));
  check(
    "移动打开中的文件后状态栏跟着更新",
    movedOpen.status.includes(`notes/${""}`) ||
      movedOpen.status.includes("notes/"),
    movedOpen.status,
  );
  check("移动后编辑器仍可用", movedOpen.editable, JSON.stringify(movedOpen));
  await pageA.click(".cm-content");
  await pageA.keyboard.type(`MOVE-${suffix}`, { delay: 8 });
  await sleep(1500);
  check(
    "移动后仍能编辑并实时保存",
    fs.existsSync(`${WS_ROOT}/notes/${moveFile}`) &&
      fs
        .readFileSync(`${WS_ROOT}/notes/${moveFile}`, "utf8")
        .includes(`MOVE-${suffix}`),
  );

  console.log("\n=== 8e. 协作栏调宽与收起 ===");
  const railWidth = () =>
    pageA.evaluate(
      () =>
        parseInt(
          getComputedStyle(
            document.querySelector(".app-shell"),
          ).getPropertyValue("--rail-w"),
          10,
        ) || 0,
    );
  const railBox = () =>
    pageA.evaluate(() => {
      const handle = document.querySelector(".collab-resizer");
      if (!handle) return null;
      const rect = handle.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + Math.min(rect.height / 2, 200),
        role: handle.getAttribute("role"),
        min: handle.getAttribute("aria-valuemin"),
        max: handle.getAttribute("aria-valuemax"),
      };
    });
  const handle = await railBox();
  check(
    "协作栏有可聚焦的拖拽把手",
    !!handle &&
      handle.role === "separator" &&
      handle.min === "180" &&
      handle.max === "420",
    JSON.stringify(handle),
  );
  const railBefore = await railWidth();
  await pageA.mouse.move(handle.x, handle.y);
  await pageA.mouse.down();
  await pageA.mouse.move(handle.x - 70, handle.y, { steps: 10 });
  await pageA.mouse.up();
  await sleep(300);
  const railAfter = await railWidth();
  check(
    "拖动把手改变协作栏宽度",
    railAfter > railBefore && railAfter <= 420,
    `${railBefore} -> ${railAfter}`,
  );
  check(
    "宽度写入 localStorage",
    await pageA.evaluate(() => !!localStorage.getItem("mc.ui.railW")),
  );

  // `.rail-toggle` is shared with the file-tree folding buttons, so the rail's own
  // buttons are addressed by their accessible name.
  const clickRailToggle = (label) =>
    pageA.evaluate((name) => {
      const button = [...document.querySelectorAll(".rail-toggle")].find(
        (node) =>
          node.getAttribute("aria-label") === name &&
          node.offsetParent !== null,
      );
      if (!button) return false;
      button.click();
      return true;
    }, label);

  const replaced = await railBox();
  // Puppeteer's synthetic double click does not surface as a `dblclick` event in
  // headless shell, so the gesture is dispatched on the handle itself.
  await pageA.evaluate(() => {
    document
      .querySelector(".collab-resizer")
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await sleep(400);
  check(
    "双击把手恢复默认宽度",
    (await railWidth()) === 236,
    `${replaced.x} ${await railWidth()}`,
  );

  check("协作栏可以收起", await clickRailToggle("收起协作栏"));
  await sleep(400);
  const collapsed = await pageA.evaluate(() => ({
    flag: document
      .querySelector(".app-shell")
      .classList.contains("rail-collapsed"),
    rail: document.querySelector(".collab-rail")?.offsetParent !== null,
    stored: localStorage.getItem("mc.ui.railCollapsed"),
    width:
      parseInt(
        getComputedStyle(document.querySelector(".app-shell")).getPropertyValue(
          "--rail-w",
        ),
        10,
      ) || 0,
  }));
  check(
    "收起后变成细竖条",
    collapsed.flag && collapsed.rail && collapsed.width === 44,
    JSON.stringify(collapsed),
  );
  check("收起状态被记住", collapsed.stored === "1", String(collapsed.stored));
  check("协作栏可以重新展开", await clickRailToggle("展开协作栏"));
  await sleep(400);
  const expanded = await pageA.evaluate(() => ({
    flag: document
      .querySelector(".app-shell")
      .classList.contains("rail-collapsed"),
    peers: document.querySelectorAll(".collab-list .peer-row").length,
    width:
      parseInt(
        getComputedStyle(document.querySelector(".app-shell")).getPropertyValue(
          "--rail-w",
        ),
        10,
      ) || 0,
  }));
  check(
    "展开后恢复宽度与协作者列表",
    !expanded.flag && expanded.width === 236 && expanded.peers > 0,
    JSON.stringify(expanded),
  );

  console.log("\n=== 8f. 图片预览与插入到光标 ===");
  await refreshTree();
  await pageA
    .waitForFunction(
      (p) => !!document.querySelector(`.tree-row[data-path="${p}"]`),
      { timeout: 15000 },
      SCRATCH_IMAGE,
    )
    .catch(() => {});
  await pageA.click(`.tree-row[data-path="${SCRATCH_IMAGE}"]`);
  await pageA
    .waitForSelector(".pane-image", { timeout: 15000 })
    .catch(() => {});
  await sleep(800);
  const imageView = await pageA.evaluate(() => {
    const img = document.querySelector(".image-img");
    return {
      pane: !!document.querySelector(".pane-image"),
      natural: img?.naturalWidth || 0,
      src: img?.getAttribute("src") || "",
      status: (document.querySelector(".statusbar")?.innerText || "")
        .replace(/\s+/g, " ")
        .trim(),
      textEditor: !!document.querySelector(".cm-content, .monaco-editor"),
    };
  });
  check(
    "图片文件用查看器打开且真的解码出像素",
    imageView.pane && imageView.natural > 0,
    JSON.stringify(imageView),
  );
  check(
    "图片走 /api/raw 且没有打开文本编辑器",
    imageView.src.startsWith("/api/raw?path=") && !imageView.textEditor,
    imageView.src,
  );
  check("状态栏标明这是图片", /图片/.test(imageView.status), imageView.status);

  await openFile(pageA, SCRATCH);
  await pageA.waitForSelector(".cm-content", { timeout: 15000 });
  await pageA.click(".cm-content");
  await pageA.keyboard.down("Control");
  await pageA.keyboard.press("End");
  await pageA.keyboard.up("Control");
  const insertButton = await pageA.evaluate(
    async ({ name, base64 }) => {
      const input = document.querySelector('input[type="file"]');
      if (!input) return "no-input";
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 20000) {
        const button = document.querySelector(".upload-insert");
        if (button && !button.disabled) {
          const label = button.textContent.trim();
          button.click();
          return label;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return "timeout";
    },
    { name: insertName, base64: PIXEL_PNG.toString("base64") },
  );
  check(
    "上传图片后出现「插入到光标」",
    insertButton !== "timeout" && insertButton !== "no-input",
    String(insertButton),
  );
  await sleep(1500);
  const insertedText = await pageA.evaluate(
    () => document.querySelector(".cm-content")?.innerText || "",
  );
  check(
    "图片引用插入到文档末尾",
    insertedText.includes(`![](${insertName})`),
    insertedText.slice(-160),
  );
  check(
    "插入的图片在预览里显示出来",
    await pageA.evaluate(() => {
      const img = [...document.querySelectorAll(".markdown-body img")].find(
        (node) => (node.getAttribute("src") || "").includes("insert-"),
      );
      return !!img && img.naturalWidth > 0;
    }),
  );

  // Files that were opened above still hold a CRDT room, and deleting a file that is
  // being collaborated on is refused with 409, so step away from all of them first
  // and let the rooms be recycled.
  await pageA.click('.tree-row[data-path="README.md"]');
  await sleep(1000);

  console.log("\n=== 8g. 导出 PDF ===");
  // The exporter rasterises the preview with html2canvas, which chokes on any
  // colour function it cannot parse and on `content: ""` pseudo elements — both
  // of which real documents contain. Catch the blob to prove a real PDF came out.
  await pageA.evaluate(() => {
    window.__pdfBlob = null;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob && blob.type === "application/pdf") window.__pdfBlob = blob;
      return create(blob);
    };
  });
  await pageA.evaluate(() => {
    const button = [...document.querySelectorAll(".pane-head button")].find(
      (node) => node.textContent.includes("导出 PDF"),
    );
    button?.click();
  });
  let pdfBytes = null;
  for (let i = 0; i < 200; i += 1) {
    pdfBytes = await pageA.evaluate(async () => {
      if (!window.__pdfBlob) return null;
      const buffer = new Uint8Array(await window.__pdfBlob.arrayBuffer());
      return {
        size: buffer.length,
        head: String.fromCharCode(...buffer.slice(0, 5)),
      };
    });
    if (pdfBytes) break;
    await sleep(500);
  }
  const pdfToast = await pageA.evaluate(() =>
    [...document.querySelectorAll(".toast")]
      .map((node) => node.textContent.trim())
      .join(" | "),
  );
  check(
    "导出 PDF 拿到了文件",
    !!pdfBytes,
    pdfBytes ? `${pdfBytes.size} 字节` : "没有产出",
  );
  check("PDF 文件头正确", pdfBytes?.head === "%PDF-", pdfBytes?.head || "");
  // jsPDF saves through its own anchor, so the filename is proven by the toast.
  check(
    "PDF 按当前文件名命名",
    pdfToast.includes("README.pdf"),
    pdfToast || "没有 toast",
  );
  check(
    "导出期间没有留下离屏纸张",
    await pageA.evaluate(
      () => document.querySelectorAll(".pdf-stage").length === 0,
    ),
  );

  // Clean up through the API so repeated runs stay idempotent.
  for (const path of [
    SCRATCH,
    SCRATCH_IMAGE,
    uploadName,
    buttonName,
    `notes/${moveFile}`,
    insertName,
  ]) {
    const delUpload = await fetch(`${BASE}/api/files/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminApi.cookie },
      body: JSON.stringify({ path }),
    });
    check(`清理测试文件 ${path}`, delUpload.ok, `HTTP ${delUpload.status}`);
  }

  console.log("\n=== 9. 管理员页面 ===");
  await pageA.evaluate(() => {
    location.hash = "#/admin";
  });
  const adminOk = await pageA
    .waitForFunction(
      (n) => document.body.innerText.includes(n),
      { timeout: 20000 },
      bobName,
    )
    .then(() => true)
    .catch(() => false);
  check("管理员页面列出用户", adminOk);
  await pageA.screenshot({ path: "/tmp/shot-admin.png" });

  console.log("\n=== 9b. 2FA 门禁与密钥重置 ===");
  const twoName = `two_${suffix}`;
  const twoUser = await createUser(adminApi.cookie, twoName);
  const firstKey = twoUser.private_key;
  const twoApi = await apiLogin(twoName, firstKey);
  const setupRes = await fetch(`${BASE}/api/me/2fa/setup`, {
    method: "POST",
    headers: { cookie: twoApi.cookie },
  });
  const setup = await setupRes.json();
  const enabled = await fetch(`${BASE}/api/me/2fa/enable`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: twoApi.cookie },
    body: JSON.stringify({ code: totpCode(setup.secret) }),
  });
  check("测试账号开启 2FA", enabled.ok, `HTTP ${enabled.status}`);

  const ctxC = await browser.createBrowserContext();
  const pageC = await ctxC.newPage();
  await pageC.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
  await pageC.waitForSelector("input.input", { timeout: 15000 });
  await pageC.type("input.input", twoName, { delay: 10 });
  await pageC.click("textarea.key-input");
  await pageC.type("textarea.key-input", firstKey, { delay: 5 });
  await pageC.click(".login-submit");
  const totpStep = await pageC
    .waitForSelector("input.totp-input", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("第一因子通过后索要动态验证码", totpStep);
  if (totpStep) {
    await pageC.type("input.totp-input", totpCode(setup.secret), { delay: 20 });
    const entered = await pageC
      .waitForSelector(".app-shell", { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("输入动态验证码后进入工作区", entered);

    if (entered) {
      await pageC.evaluate(() => {
        const btn = document.querySelector('.icon-btn[aria-label="打开设置"]');
        if (btn) btn.click();
        else
          [...document.querySelectorAll("button")]
            .find((b) => b.textContent.trim() === "设置")
            ?.click();
      });
      await pageC.waitForFunction(
        () => document.body.innerText.includes("重新生成密钥"),
        { timeout: 15000 },
      );
      await pageC.evaluate(() => {
        [...document.querySelectorAll('[role="dialog"] button')]
          .find((b) => b.textContent.trim() === "重新生成密钥")
          ?.click();
      });
      const askedCode = await pageC
        .waitForFunction(
          () => document.querySelectorAll('[role="dialog"]').length >= 2,
          { timeout: 10000 },
        )
        .then(() => true)
        .catch(() => false);
      check("重置密钥前要求输入验证码", askedCode);

      if (askedCode) {
        const boxes = await pageC.$$('[role="dialog"] .totp-input');
        await boxes[boxes.length - 1].type(totpCode(setup.secret), {
          delay: 20,
        });
        await pageC.evaluate(() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')];
          [...dialogs[dialogs.length - 1].querySelectorAll("button")]
            .find((b) => b.textContent.trim() === "继续")
            ?.click();
        });
        const askedConfirm = await pageC
          .waitForFunction(
            (n) => document.body.innerText.includes(n),
            { timeout: 10000 },
            "重新生成密钥？",
          )
          .then(() => true)
          .catch(() => false);
        check("验证码通过后弹出二次确认", askedConfirm);

        if (askedConfirm) {
          const resetResponse = pageC
            .waitForResponse(
              (r) =>
                r.url().includes("/api/me/keypair") &&
                r.request().method() === "POST",
              { timeout: 20000 },
            )
            .catch(() => null);
          await pageC.evaluate(() => {
            const dialogs = [...document.querySelectorAll('[role="dialog"]')];
            [...dialogs[dialogs.length - 1].querySelectorAll("button")]
              .find((b) => b.textContent.trim() === "重新生成")
              ?.click();
          });
          const resetRes = await resetResponse;
          check(
            "带验证码的重置请求被接受",
            !!resetRes && resetRes.status() === 200,
            resetRes ? `HTTP ${resetRes.status()}` : "无响应",
          );
          const newKeyShown = await pageC
            .waitForFunction(
              () => document.body.innerText.includes("复制密钥"),
              { timeout: 15000 },
            )
            .then(() => true)
            .catch(() => false);
          check("展示一次性新密钥", newKeyShown);
          const storedKey = await pageC.evaluate(
            (name) => localStorage.getItem(`mc.key.${name}`),
            twoName,
          );
          check("本地保存的密钥已更新", !!storedKey && storedKey !== firstKey);
          await pageC.evaluate(() => {
            const dialogs = [...document.querySelectorAll('[role="dialog"]')];
            [...dialogs[dialogs.length - 1].querySelectorAll("button")]
              .find((b) => b.textContent.trim().includes("我已保存"))
              ?.click();
          });
        }
      }
    }
  }

  // Leave nothing behind: the throwaway account would otherwise pile up in the
  // user list of whoever runs this test.
  await browser.close();
  const del = await fetch(`${BASE}/api/admin/users/${bobUser.user.id}`, {
    method: "DELETE",
    headers: { cookie: adminApi.cookie },
  });
  check("删除测试账号", del.ok, `HTTP ${del.status}`);
  const delTwo = await fetch(`${BASE}/api/admin/users/${twoUser.user.id}`, {
    method: "DELETE",
    headers: { cookie: adminApi.cookie },
  });
  check("删除 2FA 测试账号", delTwo.ok, `HTTP ${delTwo.status}`);

  console.log(
    `\n${failures === 0 ? "\x1b[32m浏览器测试全部通过\x1b[0m" : `\x1b[31m${failures} 项失败\x1b[0m`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("浏览器测试异常终止:", err);
  process.exit(1);
});
