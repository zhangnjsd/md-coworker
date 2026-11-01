import fs from "node:fs";
import puppeteer from "puppeteer-core";
import nacl from "tweetnacl";

const BASE = "http://127.0.0.1:3000";
const key = fs.readFileSync("../data/bootstrap-admin.key", "utf8").trim();
const ch = await (await fetch(`${BASE}/api/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin" }) })).json();
const kp = nacl.sign.keyPair.fromSeed(Buffer.from(key, "base64"));
const sig = Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(ch.nonce, "base64")), kp.secretKey)).toString("base64");
const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id: ch.challenge_id, signature: sig }) });
const cookie = /mc_sid=([^;]+)/.exec((res.headers.getSetCookie?.() || []).join(";"))?.[1];

const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium-browser", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.setCookie({ name: "mc_sid", value: cookie, domain: "127.0.0.1", path: "/" });
await page.goto(`${BASE}/#/app`, { waitUntil: "networkidle2" });
await page.waitForSelector('.tree-row[data-path="README.md"]', { timeout: 30000 });
await page.click('.tree-row[data-path="README.md"]');
await page.waitForSelector(".mermaid-block svg", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  window.__pdf = null;
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => {
    if (b && b.type === "application/pdf") window.__pdf = b;
    return create(b);
  };
  const btn = [...document.querySelectorAll(".pane-head button")].find((b) =>
    b.textContent.includes("导出 PDF"),
  );
  btn.click();
});
for (let i = 0; i < 240; i += 1) {
  if (await page.evaluate(() => !!window.__pdf)) break;
  await new Promise((r) => setTimeout(r, 500));
}
const info = await page.evaluate(() => ({
  pdf: !!window.__pdf,
  toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent.trim()),
  stage: !!document.querySelector(".pdf-stage"),
}));
console.log(JSON.stringify(info));
const bytes = await page.evaluate(async () =>
  window.__pdf ? Array.from(new Uint8Array(await window.__pdf.arrayBuffer())) : null,
);
if (bytes) {
  fs.writeFileSync("/tmp/export3.pdf", Buffer.from(bytes));
  console.log("saved", bytes.length);
} else {
  console.log("no pdf");
}
await browser.close();
