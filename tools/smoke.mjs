// md-coworker end-to-end smoke test (HTTP + WebSocket + Yjs sync + 2FA)
// Usage: node tools/smoke.mjs [baseUrl] [bootstrapKeyFile]
import fs from 'node:fs';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import WebSocket from 'ws';
import * as Y from 'yjs';

const BASE = process.env.MC_BASE || process.argv[2] || 'http://127.0.0.1:3000';
const KEY_FILE = process.argv[3] || 'data/bootstrap-admin.key';
const WS_BASE = BASE.replace(/^http/, 'ws');
// Workspace directory under test (used to verify that edits really land on disk)
const WS_ROOT = process.env.MC_WS_ROOT || 'demo-workspace';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.cookie = null;
  }
  async req(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const raw of setCookie) {
      const pair = raw.split(';')[0];
      if (pair.startsWith('mc_sid=') && pair.length > 8) this.cookie = pair;
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: res.status, data };
  }
  async login(username, privateKeyB64, totp) {
    const ch = await this.req('POST', '/api/auth/challenge', { username });
    if (ch.status !== 200) throw new Error(`challenge failed: ${ch.status} ${JSON.stringify(ch.data)}`);
    const nonce = Buffer.from(ch.data.nonce, 'base64');
    const kp = nacl.sign.keyPair.fromSeed(Buffer.from(privateKeyB64, 'base64'));
    const sig = Buffer.from(nacl.sign.detached(new Uint8Array(nonce), kp.secretKey)).toString('base64');
    const res = await this.req('POST', '/api/auth/login', {
      challenge_id: ch.data.challenge_id,
      signature: sig,
    });
    if (res.data?.status === 'mfa_required') {
      if (!totp) return { status: res.data.status, needTotp: true };
      const code = totp();
      const mfa = await this.req('POST', '/api/auth/mfa', { ticket: res.data.ticket, code });
      return { status: mfa.data?.status, res: mfa };
    }
    return { status: res.data?.status, res };
  }
}

// --- TOTP (RFC 6238, SHA1/6/30s) ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}
function totpCode(secretB32, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, '0');
}

// --- WebSocket client ---
class Collab {
  constructor(cookie, username) {
    this.username = username;
    this.messages = [];
    this.waiters = [];
    this.cookie = cookie;
    this.docs = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_BASE + '/ws', { headers: { cookie: this.cookie } });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => {
          if (w.match(msg)) { w.resolve(msg); return false; }
          return true;
        });
      });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(match, timeout = 4000) {
    const found = this.messages.find((m) => match(m));
    if (found) {
      this.messages = this.messages.filter((m) => m !== found);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${match}`)), timeout);
      this.waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- main flow
async function main() {
  console.log('\n=== 1. 基础健康检查 ===');
  const probe = new Client('probe');
  const health = await probe.req('GET', '/api/health');
  check('GET /api/health 返回 ok', health.status === 200 && health.data.ok === true);
  const unauth = await probe.req('GET', '/api/me');
  check('未登录访问 /api/me 返回 401', unauth.status === 401);

  console.log('\n=== 2. 管理员密钥登录 ===');
  const adminKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const admin = new Client('admin');
  const adminLogin = await admin.login('admin', adminKey);
  check('管理员登录成功', adminLogin.status === 'ok', JSON.stringify(adminLogin));
  const me = await admin.req('GET', '/api/me');
  check('/api/me 返回 admin 角色', me.data?.user?.role === 'admin');

  console.log('\n=== 3. 管理员创建用户 ===');
  const suffix = Math.random().toString(36).slice(2, 7);
  const alice = `alice_${suffix}`;
  const bob = `bob_${suffix}`;
  const ca = await admin.req('POST', '/api/admin/users', { username: alice, role: 'user' });
  check('创建用户 alice 返回私钥', ca.status === 200 && !!ca.data.private_key);
  const cb = await admin.req('POST', '/api/admin/users', { username: bob, role: 'user' });
  check('创建用户 bob', cb.status === 200 && !!cb.data.private_key);
  const dup = await admin.req('POST', '/api/admin/users', { username: alice, role: 'user' });
  check('重复用户名返回 409', dup.status === 409);
  const badname = await admin.req('POST', '/api/admin/users', { username: 'a b!', role: 'user' });
  check('非法用户名返回 400', badname.status === 400);

  const users = await admin.req('GET', '/api/admin/users');
  check('用户列表包含 alice/bob', users.data.users.some((u) => u.username === alice) && users.data.users.some((u) => u.username === bob));

  console.log('\n=== 4. 普通用户登录（错误私钥应失败） ===');
  const attacker = new Client('attacker');
  const wrong = await attacker.login(alice, cb.data.private_key);
  check('用别人的私钥登录被拒绝', wrong.res?.status === 401 || wrong.status !== 'ok', JSON.stringify(wrong));
  const aClient = new Client('alice');
  const aLogin = await aClient.login(alice, ca.data.private_key);
  check('alice 用正确私钥登录成功', aLogin.status === 'ok');
  const forbidden = await aClient.req('GET', '/api/admin/users');
  check('普通用户访问管理接口返回 403', forbidden.status === 403);

  console.log('\n=== 5. 文件接口 ===');
  const files = await aClient.req('GET', '/api/files');
  check('文件树返回 README.md', files.status === 200 && JSON.stringify(files.data.tree).includes('README.md'));
  const doc = await aClient.req('GET', '/api/file?path=README.md');
  check('读取 README.md 成功', doc.status === 200 && doc.data.content.includes('md-coworker'));
  const created = await aClient.req('POST', '/api/files', { path: `notes/t-${suffix}.md`, kind: 'file', content: '# 初始内容\n' });
  check('创建文件成功', created.status === 200);
  const escape = await aClient.req('GET', '/api/file?path=../../etc/passwd');
  check('路径穿越被拒绝', escape.status === 400 || escape.status === 404);

  console.log('\n=== 6. 实时协作（两个客户端） ===');
  const fsPath = `notes/t-${suffix}.md`;
  const c1 = new Collab(aClient.cookie, alice);
  await c1.connect();
  const bClient = new Client('bob');
  const bLogin = await bClient.login(bob, cb.data.private_key);
  check('bob 登录成功', bLogin.status === 'ok');
  const c2 = new Collab(bClient.cookie, bob);
  await c2.connect();

  c1.send({ t: 'join', path: fsPath });
  const init1 = await c1.waitFor((m) => m.t === 'init');
  check('客户端1 收到 init 且含现有内容', init1.update && Buffer.from(init1.update, 'base64').length > 0);
  const doc1 = new Y.Doc();
  Y.applyUpdate(doc1, Buffer.from(init1.update, 'base64'), 'remote');
  check('CRDT 内容与磁盘一致', doc1.getText('content').toString().startsWith('# 初始内容'));

  c2.send({ t: 'join', path: fsPath });
  const init2 = await c2.waitFor((m) => m.t === 'init');
  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, Buffer.from(init2.update, 'base64'), 'remote');

  // Client 1 edits
  doc1.getText('content').insert(doc1.getText('content').length, '\n来自 alice 的一行\n');
  const update = Y.encodeStateAsUpdate(doc1);
  c1.send({ t: 'update', path: fsPath, update: Buffer.from(update).toString('base64') });

  const relayed = await c2.waitFor((m) => m.t === 'update');
  check('客户端2 收到 alice 的增量更新', !!relayed.update);
  Y.applyUpdate(doc2, Buffer.from(relayed.update, 'base64'), 'remote');
  check('两端 CRDT 收敛', doc1.getText('content').toString() === doc2.getText('content').toString());
  check('更新作者标记为 alice', relayed.user === alice, String(relayed.user));

  // Client 1 must not receive an echo of its own update
  const echo = c1.messages.find((m) => m.t === 'update');
  check('不向作者回显自己的更新', !echo);

  // Client 2 edits (concurrently)
  doc2.getText('content').insert(0, '> bob 说：你好\n\n');
  c2.send({ t: 'update', path: fsPath, update: Buffer.from(Y.encodeStateAsUpdate(doc2)).toString('base64') });
  const relayed2 = await c1.waitFor((m) => m.t === 'update');
  Y.applyUpdate(doc1, Buffer.from(relayed2.update, 'base64'), 'remote');
  check('并发编辑后两端收敛', doc1.getText('content').toString() === doc2.getText('content').toString());

  // presence
  c1.send({ t: 'presence', path: fsPath, cursor: { line: 3, ch: 5 }, selection: 0 });
  c2.send({ t: 'presence', path: fsPath, cursor: { line: 7, ch: 1 }, selection: 2 });
  const presence = await c2.waitFor(
    (m) =>
      m.t === 'presence' &&
      m.users.some((u) => u.username === alice && u.cursor?.line === 3) &&
      m.users.some((u) => u.username === bob && u.cursor?.line === 7),
    8000,
  );
  check('presence 同时包含两位协作者', presence.users.length >= 2);
  const alicePresence = presence.users.find((u) => u.username === alice);
  check('presence 显示 alice 所在文件', alicePresence?.path === fsPath, JSON.stringify(alicePresence));
  const bobPresence = presence.users.find((u) => u.username === bob);
  check('presence 显示 bob 的光标与选区', bobPresence?.cursor?.line === 7 && bobPresence?.selection === 2, JSON.stringify(bobPresence));

  // Live persist to disk
  const saved = await c1.waitFor((m) => m.t === 'saved', 6000);
  check('收到 saved 帧', !!saved.path);
  await sleep(400);
  const onDisk = fs.readFileSync(`${WS_ROOT}/${fsPath}`, 'utf8');
  check('编辑已实时写入磁盘', onDisk.includes('来自 alice 的一行') && onDisk.includes('bob 说：你好'), JSON.stringify(onDisk.slice(0, 60)));

  console.log('\n=== 7. 重连后状态保持（快照） ===');
  const c3 = new Collab(aClient.cookie, alice);
  await c3.connect();
  c3.send({ t: 'join', path: fsPath });
  const init3 = await c3.waitFor((m) => m.t === 'init');
  const doc3 = new Y.Doc();
  Y.applyUpdate(doc3, Buffer.from(init3.update, 'base64'), 'remote');
  check('新连接拿到完整历史内容', doc3.getText('content').toString() === doc1.getText('content').toString());
  c3.close();

  console.log('\n=== 8. 2FA 全流程 ===');
  const setup = await aClient.req('POST', '/api/me/2fa/setup');
  check('2FA setup 返回 secret 与 otpauth url', setup.status === 200 && !!setup.data.secret && setup.data.otpauth_url.startsWith('otpauth://totp/'));
  const wrongCode = await aClient.req('POST', '/api/me/2fa/enable', { code: '000000' });
  check('错误验证码无法启用 2FA', wrongCode.status === 400);
  const enable = await aClient.req('POST', '/api/me/2fa/enable', { code: totpCode(setup.data.secret) });
  check('正确验证码启用 2FA', enable.status === 200 && enable.data.user.twofa_enabled === true);

  const fresh = new Client('alice2');
  const needsMfa = await fresh.login(alice, ca.data.private_key);
  check('启用 2FA 后登录返回 mfa_required', needsMfa.status === 'mfa_required', JSON.stringify(needsMfa));
  const ch2 = await fresh.req('POST', '/api/auth/challenge', { username: alice });
  const nonce2 = Buffer.from(ch2.data.nonce, 'base64');
  const kp2 = nacl.sign.keyPair.fromSeed(Buffer.from(ca.data.private_key, 'base64'));
  const sig2 = Buffer.from(nacl.sign.detached(new Uint8Array(nonce2), kp2.secretKey)).toString('base64');
  const step2 = await fresh.req('POST', '/api/auth/login', { challenge_id: ch2.data.challenge_id, signature: sig2 });
  const badMfa = await fresh.req('POST', '/api/auth/mfa', { ticket: step2.data.ticket, code: '123456' });
  check('错误 TOTP 被拒绝', badMfa.status === 401);
  const okMfa = await fresh.req('POST', '/api/auth/mfa', { ticket: step2.data.ticket, code: totpCode(setup.data.secret) });
  check('正确 TOTP 登录成功', okMfa.status === 200 && okMfa.data.status === 'ok');

  const disable = await fresh.req('POST', '/api/me/2fa/disable', { code: totpCode(setup.data.secret) });
  check('关闭 2FA 成功', disable.status === 200 && disable.data.user.twofa_enabled === false);

  console.log('\n=== 9. 密钥自助重置 ===');
  const regen = await fresh.req('POST', '/api/me/keypair');
  check('重新生成密钥对返回新私钥', regen.status === 200 && !!regen.data.private_key && regen.data.private_key !== ca.data.private_key);
  const oldKeyLogin = new Client('oldkey');
  const oldTry = await oldKeyLogin.login(alice, ca.data.private_key);
  check('旧私钥立即失效', oldTry.res?.status === 401 || oldTry.status !== 'ok');
  const newKeyLogin = new Client('newkey');
  const newTry = await newKeyLogin.login(alice, regen.data.private_key);
  check('新私钥可以登录', newTry.status === 'ok');

  console.log('\n=== 10. 文件操作 ===');
  const busy = await newKeyLogin.req('POST', '/api/files/rename', { from: `notes/t-${suffix}.md`, to: `notes/t-${suffix}-x.md` });
  check('正在协作中的文件禁止重命名 (409)', busy.status === 409, JSON.stringify(busy.data));
  c1.close();
  c2.close();
  await sleep(600);
  const renamed = await newKeyLogin.req('POST', '/api/files/rename', { from: `notes/t-${suffix}.md`, to: `notes/t-${suffix}-renamed.md` });
  check('离开协作后重命名成功', renamed.status === 200, JSON.stringify(renamed.data));
  const del = await newKeyLogin.req('POST', '/api/files/delete', { path: `notes/t-${suffix}-renamed.md` });
  check('删除文件成功', del.status === 200);
  const missing = await newKeyLogin.req('GET', `/api/file?path=notes/t-${suffix}-renamed.md`);
  check('删除后读取返回 404', missing.status === 404);

  console.log('\n=== 11. 管理员清理 ===');
  const delUser = await admin.req('DELETE', `/api/admin/users/${cb.data.user.id}`);
  check('删除用户成功', delUser.status === 200);
  const delUser2 = await admin.req('DELETE', `/api/admin/users/${ca.data.user.id}`);
  check('删除 alice 成功', delUser2.status === 200);


  console.log(`\n${failures === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${failures} 项失败\x1b[0m`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常终止:', err);
  process.exit(1);
});
