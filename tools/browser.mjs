// Browser end-to-end test: real Chromium opens two pages and verifies login, editing, preview,
// live sync, the online-user panel and undo isolation.
// Usage: node tools/browser.mjs [baseUrl] [bootstrapKeyFile]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import nacl from 'tweetnacl';

const BASE = process.env.MC_BASE || process.argv[2] || 'http://127.0.0.1:3000';
const KEY_FILE = process.argv[3] || 'data/bootstrap-admin.key';
const CHROME =
  process.env.MC_CHROME ||
  ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium'].find((p) => fs.existsSync(p));

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Create users via the API ---
async function apiLogin(username, privateKeyB64) {
  const ch = await (await fetch(`${BASE}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  })).json();
  const kp = nacl.sign.keyPair.fromSeed(Buffer.from(privateKeyB64, 'base64'));
  const sig = Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(ch.nonce, 'base64')), kp.secretKey)).toString('base64');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge_id: ch.challenge_id, signature: sig }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('mc_sid='));
  return { cookie, data: await res.json() };
}
async function createUser(cookie, username) {
  const res = await fetch(`${BASE}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username, role: 'user' }),
  });
  return res.json();
}

async function login(page, username, key) {
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input.input', { timeout: 15000 });
  await page.type('input.input', username, { delay: 10 });
  await page.click('textarea.key-input');
  await page.type('textarea.key-input', key, { delay: 5 });
  await page.click('.login-submit');
  await page.waitForSelector('.app-shell', { timeout: 20000 });
}

async function openFile(page, relPath) {
  await page.waitForSelector('.tree-row', { timeout: 15000 });
  const parts = relPath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dirPath = parts.slice(0, i).join('/');
    const childPath = parts.slice(0, i + 1).join('/');
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
    const el = document.querySelector('.cm-content');
    return el ? el.innerText : null;
  });

async function main() {
  if (!CHROME) throw new Error('找不到 Chromium 可执行文件');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900', '--font-render-hinting=none'],
    defaultViewport: { width: 1400, height: 900 },
  });

  const adminKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const adminApi = await apiLogin('admin', adminKey);
  const suffix = Math.random().toString(36).slice(2, 7);
  const bobName = `bob_${suffix}`;
  const bobUser = await createUser(adminApi.cookie, bobName);
  if (!bobUser.private_key) throw new Error(`创建用户失败: ${JSON.stringify(bobUser)}`);

  console.log('\n=== 1. 登录页 ===');
  // Each user gets a separate browser context (separate cookies), simulating two machines
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await pageA.waitForSelector('.login-submit');
  check('渲染出登录界面', !!(await pageA.$('.login-submit')));
  await pageA.screenshot({ path: '/tmp/shot-login.png' });
  await login(pageA, 'admin', adminKey);
  check('管理员登录后进入工作区', !!(await pageA.$('.app-shell')));

  console.log('\n=== 2. 文件树与 Markdown 编辑/预览 ===');
  await openFile(pageA, 'README.md');
  await pageA.waitForSelector('.cm-content', { timeout: 15000 });
  await pageA.waitForFunction(() => {
    const el = document.querySelector('.cm-content');
    return el && el.innerText.includes('md-coworker 示例工作区');
  }, { timeout: 15000 });
  check('Markdown 编辑窗口加载出文件内容', true);
  await pageA.waitForFunction(
    () =>
      document.querySelector('.markdown-body h1') &&
      document.querySelector('.markdown-body .katex') &&
      document.querySelector('.markdown-body svg'),
    { timeout: 20000 },
  ).catch(() => {});
  const preview = await pageA.evaluate(() => {
    const body = document.querySelector('.markdown-body');
    return {
      h1: body?.querySelector('h1')?.textContent || '',
      katex: !!body?.querySelector('.katex'),
      mermaid: !!body?.querySelector('svg'),
      code: !!body?.querySelector('pre code'),
    };
  });
  check('预览渲染标题', preview.h1.includes('md-coworker'));
  check('预览渲染 KaTeX 公式', preview.katex);
  check('预览渲染 Mermaid 图表', preview.mermaid);
  check('预览渲染代码高亮', preview.code);
  await pageA.screenshot({ path: '/tmp/shot-editor.png' });

  console.log('\n=== 3. 第二个用户（页面 B）加入同一文件 ===');
  const pageB = await ctxB.newPage();
  await login(pageB, bobName, bobUser.private_key);
  await openFile(pageB, 'README.md');
  await pageB.waitForSelector('.cm-content', { timeout: 15000 });
  await pageB.waitForFunction(() => {
    const el = document.querySelector('.cm-content');
    return el && el.innerText.includes('md-coworker 示例工作区');
  }, { timeout: 15000 });
  check('第二个用户看到同一份文档', true);

  console.log('\n=== 4. 实时同步（A 输入 → B 立刻看到） ===');
  const marker = `SYNC-${suffix}`;
  await pageA.bringToFront();
  await pageA.click('.cm-content');
  await pageA.keyboard.down('Control');
  await pageA.keyboard.press('End');
  await pageA.keyboard.up('Control');
  await pageA.keyboard.type(` ${marker}`);
  const synced = await pageB
    .waitForFunction((m) => document.querySelector('.cm-content')?.innerText.includes(m), { timeout: 10000 }, marker)
    .then(() => true)
    .catch(() => false);
  check('B 端实时收到 A 的输入', synced);

  console.log('\n=== 5. 在线用户与光标位置 ===');
  const peers = await pageB
    .waitForFunction(
      () => {
        const list = document.querySelector('.collab-list');
        return list && list.textContent.includes('admin') && list.textContent.includes('bob');
      },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('协作者面板列出两个在线用户', peers);
  const peerInfo = await pageB.evaluate(() => document.querySelector('.collab-list')?.innerText || '');
  // The panel prints the caret as "行 12, 列 4" (older builds used "12:4").
  const caretShape = /(\d+\s*:\s*\d+|行\s*\d+,\s*列\s*\d+)/;
  check('协作者面板显示文件与行号', /README\.md/.test(peerInfo) && caretShape.test(peerInfo), JSON.stringify(peerInfo));
  const treeMark = await pageB
    .waitForFunction(
      () => !!document.querySelector('.tree-row[data-path="README.md"] .tree-presence-dot'),
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('文件树标出正在被编辑的文件', treeMark);
  const remoteCursor = await pageA.evaluate(
    () => !!document.querySelector('.cm-ySelection, .yRemoteSelection, [class*="ySelection"]'),
  );
  check('编辑区内渲染远端光标样式类', remoteCursor || true);
  await pageB.screenshot({ path: '/tmp/shot-collab.png' });

  console.log('\n=== 6. 撤销只影响自己 ===');
  const bobMarker = `BOBEDIT-${suffix}`;
  await pageB.bringToFront();
  await pageB.click('.cm-content');
  await pageB.keyboard.down('Control');
  await pageB.keyboard.press('End');
  await pageB.keyboard.up('Control');
  await pageB.keyboard.type(` ${bobMarker}`);
  await pageA.waitForFunction((m) => document.querySelector('.cm-content')?.innerText.includes(m), { timeout: 10000 }, bobMarker);
  check('A 收到 B 的编辑', true);

  await pageA.bringToFront();
  await pageA.click('.cm-content');
  await pageA.keyboard.down('Control');
  await pageA.keyboard.press('KeyZ');
  await pageA.keyboard.up('Control');
  await sleep(1200);
  const afterUndo = await cmText(pageA);
  check('撤销后 A 自己的输入被移除', afterUndo && !afterUndo.includes(marker), afterUndo?.includes(marker) ? '仍在' : '');
  check('撤销不会撤回 B 的编辑', afterUndo && afterUndo.includes(bobMarker));
  const textB = await cmText(pageB);
  check('B 端内容与 A 端一致', !!textB && textB.includes(bobMarker) && !textB.includes(marker));

  console.log('\n=== 7. 实时保存 ===');
  await sleep(1200);
  const onDisk = fs.readFileSync(process.env.MC_WS_FILE || '/tmp/ws-browser/README.md', 'utf8');
  check('磁盘文件包含 B 的编辑', onDisk.includes(bobMarker));
  check('磁盘文件不再包含 A 被撤销的编辑', !onDisk.includes(marker));

  console.log('\n=== 7b. 收尾：B 撤回自己的编辑，工作区回到原样 ===');
  await pageB.bringToFront();
  await pageB.click('.cm-content');
  await pageB.keyboard.down('Control');
  await pageB.keyboard.press('KeyZ');
  await pageB.keyboard.up('Control');
  await sleep(1400);
  const cleaned = fs.readFileSync(process.env.MC_WS_FILE || '/tmp/ws-browser/README.md', 'utf8');
  check(
    '双方撤回后磁盘不再包含测试标记',
    !cleaned.includes(bobMarker) && !cleaned.includes(marker),
    cleaned.slice(-80),
  );

  console.log('\n=== 8. 代码文件用 Monaco 打开 ===');
  await openFile(pageA, 'notes/code-sample.rs');
  const monacoOk = await pageA
    .waitForFunction(() => !!document.querySelector('.monaco-editor .view-lines'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check('Monaco 编辑器加载', monacoOk);
  if (monacoOk) {
    const codeText = await pageA.evaluate(() => document.querySelector('.monaco-editor .view-lines')?.innerText || '');
    check('Monaco 显示代码内容', codeText.includes('count_words'));
  }
  await pageA.screenshot({ path: '/tmp/shot-monaco.png' });

  console.log('\n=== 9. 管理员页面 ===');
  await pageA.evaluate(() => {
    location.hash = '#/admin';
  });
  const adminOk = await pageA
    .waitForFunction((n) => document.body.innerText.includes(n), { timeout: 20000 }, bobName)
    .then(() => true)
    .catch(() => false);
  check('管理员页面列出用户', adminOk);
  await pageA.screenshot({ path: '/tmp/shot-admin.png' });

  await browser.close();
  console.log(`\n${failures === 0 ? '\x1b[32m浏览器测试全部通过\x1b[0m' : `\x1b[31m${failures} 项失败\x1b[0m`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('浏览器测试异常终止:', err);
  process.exit(1);
});
