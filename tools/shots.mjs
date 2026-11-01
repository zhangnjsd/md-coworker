// Regenerates docs/screenshots: boots a real browser, creates two throwaway
// collaborators so presence and remote carets are visible, and captures the
// five screens the README shows. Requires the server to be running (just run).
// Usage: node tools/shots.mjs [outdir]
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import nacl from "tweetnacl";

const BASE = process.env.MC_BASE || "http://127.0.0.1:3000";
const OUT = process.argv[2] || "docs/screenshots";
const KEY_FILE = process.env.MC_KEY_FILE || "data/bootstrap-admin.key";
const CHROME =
  process.env.MC_CHROME ||
  ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"].find(
    (p) => fs.existsSync(p),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adminKey = fs.readFileSync(KEY_FILE, "utf8").trim();
fs.mkdirSync(OUT, { recursive: true });

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

async function loginPage(page, username, key) {
  await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("input.input", { timeout: 15000 });
  await sleep(400);
  await page.type("input.input", username, { delay: 8 });
  await page.click("textarea.key-input");
  await page.type("textarea.key-input", key, { delay: 2 });
  await page.click(".login-submit");
  await page.waitForSelector(".app-shell", { timeout: 20000 });
}

async function openFile(page, path) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    await page.evaluate((p) => {
      const row = document.querySelector(`.tree-row[data-path="${p}"]`);
      if (row && row.getAttribute("data-open") !== "true") row.click();
    }, dir);
    await sleep(220);
  }
  await page.evaluate((p) => {
    document.querySelector(`.tree-row[data-path="${p}"]`)?.click();
  }, path);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: ["--no-sandbox"],
  defaultViewport: { width: 1400, height: 900 },
});

const admin = await apiLogin("admin", adminKey);
const stamp = String(Date.now() % 10000);
const made = [];
for (const name of ["chen_xi", "wei_ru"]) {
  const res = await fetch(`${BASE}/api/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ username: `${name}_${stamp}`, role: "user" }),
  });
  const data = await res.json();
  if (data.private_key)
    made.push({
      id: data.user.id,
      username: data.user.username,
      key: data.private_key,
    });
}

// --- login screen ---
const ctxLogin = await browser.createBrowserContext();
const pLogin = await ctxLogin.newPage();
await pLogin.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
await pLogin.waitForSelector(".login-submit");
await sleep(700);
await pLogin.screenshot({ path: `${OUT}/login.png` });
await ctxLogin.close();

// --- three collaborators on one document ---
const ctxA = await browser.createBrowserContext();
const pA = await ctxA.newPage();
await loginPage(pA, "admin", adminKey);
await openFile(pA, "README.md");
await pA.waitForSelector(".cm-content");

const peers = [];
for (const user of made.slice(0, 2)) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await loginPage(page, user.username, user.key);
  await openFile(page, "README.md");
  await page.waitForSelector(".cm-content");
  peers.push({ ctx, page });
}

// distinct carets, so the presence panel shows real positions
await peers[0].page.click(".cm-content");
for (let i = 0; i < 18; i++) await peers[0].page.keyboard.press("ArrowDown");
await peers[1].page.click(".cm-content");
for (let i = 0; i < 16; i++) await peers[1].page.keyboard.press("ArrowDown");
await sleep(1600);
await pA.screenshot({ path: `${OUT}/editor.png` });

// --- upload drop overlay (same events a desktop drag fires) ---
await pA.evaluate(async () => {
  const dt = new DataTransfer();
  dt.items.add(
    new File(["# 拖进来的文件\n"], "screenshot.md", { type: "text/markdown" }),
  );
  document
    .querySelector(".app-shell")
    .dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }),
    );
  await new Promise((resolve) => setTimeout(resolve, 300));
});
await sleep(400);
await pA.screenshot({ path: `${OUT}/upload.png` });
await pA.evaluate(() => {
  document.querySelector(".app-shell").dispatchEvent(
    new DragEvent("dragleave", {
      bubbles: true,
      dataTransfer: new DataTransfer(),
    }),
  );
  window.dispatchEvent(
    new DragEvent("dragend", {
      bubbles: true,
      dataTransfer: new DataTransfer(),
    }),
  );
});
await sleep(400);

// --- settings dialog ---
await pA.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /设置/.test(b.getAttribute("aria-label") || b.textContent || ""),
  );
  if (btn) btn.click();
});
await sleep(900);
await pA.screenshot({ path: `${OUT}/settings.png` });
await pA.keyboard.press("Escape");
await sleep(500);

// --- code file in Monaco, with a second caret ---
await openFile(peers[0].page, "notes/code-sample.rs").catch(() => {});
await openFile(pA, "notes/code-sample.rs").catch(() => {});
await sleep(2200);
await pA.screenshot({ path: `${OUT}/code.png` });

// --- admin console ---
await pA.evaluate(() => {
  location.hash = "#/admin";
});
await pA
  .waitForFunction(() => document.body.innerText.includes("用户管理"), {
    timeout: 15000,
  })
  .catch(() => {});
await sleep(900);
await pA.screenshot({ path: `${OUT}/admin.png` });

for (const peer of peers) await peer.ctx.close();
await ctxA.close();
await browser.close();

// drop the throwaway users
for (const user of made) {
  await fetch(`${BASE}/api/admin/users/${user.id}`, {
    method: "DELETE",
    headers: { cookie: admin.cookie },
  });
}
console.log(`screenshots written to ${OUT}`);
