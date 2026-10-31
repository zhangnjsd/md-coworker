import nacl from "tweetnacl";
import WebSocket from "ws";
import * as Y from "yjs";
import fs from "node:fs";
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:3000";
const ROOT = process.env.MC_ROOT || process.cwd();
const key = fs.readFileSync(ROOT + "/data/bootstrap-admin.key", "utf8").trim();
const ch = await (
  await fetch(BASE + "/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin" }),
  })
).json();
const kp = nacl.sign.keyPair.fromSeed(Buffer.from(key, "base64"));
const sig = Buffer.from(
  nacl.sign.detached(
    new Uint8Array(Buffer.from(ch.nonce, "base64")),
    kp.secretKey,
  ),
).toString("base64");
const res = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ challenge_id: ch.challenge_id, signature: sig }),
});
const cookie = res.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .find((c) => c.startsWith("mc_sid="));

const ws = new WebSocket("ws://127.0.0.1:3000/ws", { headers: { cookie } });
const doc = new Y.Doc();
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ t: "join", path: "README.md" }));
await new Promise((r) =>
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "init") {
      Y.applyUpdate(doc, Buffer.from(m.update, "base64"), "remote");
      r();
    }
  }),
);
doc.getText("content").insert(0, "SHUTDOWN-FLUSH-MARK\n");
ws.send(
  JSON.stringify({
    t: "update",
    path: "README.md",
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
  }),
);
// Send SIGTERM right away to verify graceful shutdown flushes unsaved content to disk
await new Promise((r) => setTimeout(r, 120));
try {
  execSync("pkill -f md-coworker", { stdio: "ignore" });
} catch (e) {
  console.log("pkill:", e.status);
}
await new Promise((r) => setTimeout(r, 1500));
const disk = fs.readFileSync(ROOT + "/demo-workspace/README.md", "utf8");
console.log(
  disk.startsWith("SHUTDOWN-FLUSH-MARK")
    ? "✓ 优雅退出已落盘"
    : "✗ 内容丢失: " + disk.slice(0, 40),
);
const snaps = fs.readdirSync(ROOT + "/data/crdt");
const raw = fs.readFileSync(ROOT + "/data/crdt/" + snaps[0]);
console.log(
  "快照文件:",
  snaps[0],
  raw.length,
  "bytes；明文泄漏?",
  raw.includes(Buffer.from("SHUTDOWN-FLUSH-MARK")),
);
process.exit(0);
