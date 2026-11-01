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
  window.__log = [];
  const orig = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    window.__log.push({ canvas: [this.width, this.height], cw: document.documentElement.clientWidth });
    return orig.apply(this, args);
  };
  const origAdd = HTMLCanvasElement.prototype.getContext;
  window.__pdf = null;
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { if (b && b.type === "application/pdf") window.__pdf = b; return create(b); };
  const btn = [...document.querySelectorAll(".pane-head button")].find((b) => b.textContent.includes("导出 PDF"));
  btn.click();
});
// sample the stage geometry mid-export
const geo = [];
for (let i = 0; i < 40; i += 1) {
  const g = await page.evaluate(() => {
    const stage = document.querySelector(".pdf-stage");
    if (!stage) return null;
    const paper = stage.querySelector(".pdf-paper");
    const pr = paper.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    return { stage: [Math.round(sr.left), Math.round(sr.width), Math.round(sr.height)], paper: [Math.round(pr.left), Math.round(pr.width), Math.round(pr.height)] };
  });
  if (g) geo.push(g);
  await new Promise((r) => setTimeout(r, 250));
}
for (let i = 0; i < 240; i += 1) {
  if (await page.evaluate(() => !!window.__pdf)) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log("geometry samples:", JSON.stringify(geo.slice(0, 3)));
console.log("canvas log:", JSON.stringify(await page.evaluate(() => window.__log.slice(0, 4))));
await browser.close();
