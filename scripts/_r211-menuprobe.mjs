process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnv, signIn } from './_b36-lib.mjs';

const BASE = process.env.R21_BASE || 'http://127.0.0.1:13000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = readEnv();
const tok = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);

const port = 9900 + Math.floor(Math.random() * 60);
const profile = path.join(os.tmpdir(), `r211menu-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 100; i += 1) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/admin/` });
await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN', ${JSON.stringify(tok)});localStorage.setItem('nocobase-token', ${JSON.stringify(tok)});true`);
await send('Page.navigate', { url: `${BASE}/admin/` });
await sleep(9000);
// 侧边栏可能默认收起，先把 sider 撑开，否则截出来只有一条窄栏
// 只在【已收起】时才点展开按钮，避免把本来展开的栏点成收起（上一版就点反了）
const sid = await ev(`(() => {
  const s = document.querySelector('.ant-layout-sider');
  if (!s) return 'no-sider';
  const collapsed = s.classList.contains('ant-layout-sider-collapsed');
  const trig = document.querySelector('.ant-layout-sider-trigger');
  if (collapsed && trig) trig.click();
  return collapsed ? 'was-collapsed' : 'expanded';
})()`);
console.log('侧栏初始状态:', sid);
await sleep(1500);

// 点开两个分组，让子页真正出现在 DOM 里。
// 限定在 .ant-menu-submenu-title 内找：在全文档里按文本找会把正文里的同名文字点掉。
for (const g of ['日常业务', '管理与设置']) {
  const r = await ev(`(() => {
    const el = [...document.querySelectorAll('.ant-menu-submenu-title')]
      .find(n => (n.innerText || '').trim() === ${JSON.stringify(g)});
    if (!el) return 'not-found';
    el.click(); return 'clicked'; })()`);
  console.log('展开分组', g, '->', r);
  await sleep(1600);
}
const state = await ev(`(() => {
  const txt = document.body.innerText || '';
  const items = [...document.querySelectorAll('.ant-menu-item')].map(n => (n.innerText || '').trim()).filter(Boolean);
  const subs = [...document.querySelectorAll('.ant-menu-submenu-title')].map(n => (n.innerText || '').trim()).filter(Boolean);
  const openSubs = [...document.querySelectorAll('.ant-menu-submenu-open > .ant-menu-submenu-title')].map(n => (n.innerText||'').trim());
  return { subs, openSubs, items, txtLen: txt.length, txt: txt.slice(0, 700) };
})()`);
console.log('分组:', JSON.stringify(state.subs), '| 已展开:', JSON.stringify(state.openSubs));
console.log('页面项:', JSON.stringify(state.items));
await send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  const b = Buffer.from(r.result.data, 'base64');
  const f = 'storage/tmp/r211/shots/00-menu-expanded.png';
  fs.writeFileSync(f, b);
  console.log('截图', f, b.length + 'B');
});
child.kill('SIGKILL');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
