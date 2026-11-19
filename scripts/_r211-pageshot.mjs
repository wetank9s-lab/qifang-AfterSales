process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readEnv, signIn } from './_b36-lib.mjs';

const BASE = process.env.R21_BASE || 'http://127.0.0.1:13000';
const PAGE = process.argv.find((a) => a.startsWith('--page='))?.split('=')[1] || '';
const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] || 'shot';
const NAVTEXT = process.argv.find((a) => a.startsWith('--nav='))?.split('=')[1] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = readEnv();
const tok = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
fs.mkdirSync('storage/tmp/r211/shots', { recursive: true });

const port = 9990 + Math.floor(Math.random() * 60);
const profile = path.join(os.tmpdir(), `r21ps-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 100; i += 1) {
  try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* wait */ }
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/admin/` });
await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN', ${JSON.stringify(tok)});localStorage.setItem('nocobase-token', ${JSON.stringify(tok)});true`);
await send('Page.navigate', { url: `${BASE}/admin/${PAGE || ''}` });
await sleep(7000);

if (NAVTEXT) {
  // 通过菜单点击进入（比直接拼 URL 可靠：有些页面路由要走前端状态）
  const clicked = await ev(`(() => {
    // 只点【侧边栏菜单】里的项：不加范围会把工作台正文里的"FW2026..."链接
    // 或同名文字当成菜单项（上一版就点错了，截出的是工作台）。
    const scope = document.querySelector('.ant-layout-sider, aside, [class*=sider], [class*=menu]');
    if (!scope) return 'no-sider';
    const el = [...scope.querySelectorAll('.ant-menu-item, .ant-menu-submenu-title, li, a')]
      .find(n => (n.innerText || '').trim() === ${JSON.stringify(NAVTEXT)});
    if (!el) return 'not-found';
    el.click(); return 'clicked'; })()`);
  console.log('菜单点击', NAVTEXT, '->', clicked);
  await sleep(6000);
}

const info = await ev(`(() => {
  const heads = [...document.querySelectorAll('.ant-table-thead th')].map(n => (n.innerText||'').trim()).filter(Boolean);
  const filterBoxes = [...document.querySelectorAll('.ant-form, [class*=filter], [class*=FilterForm]')].length;
  const filterH = (() => {
    const el = document.querySelector('[class*=filterForm], .ant-form');
    return el ? Math.round(el.getBoundingClientRect().height) : null;
  })();
  const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length;
  return { url: location.pathname, heads, rows, filterH, txtLen: (document.body.innerText||'').length,
           txt: (document.body.innerText||'').replace(/\s+/g,' ').slice(0, 400) };
})()`);
console.log('URL', info.url);
console.log('表头', JSON.stringify(info.heads));
console.log('数据行', info.rows, '| 筛选区高度', info.filterH, 'px');
console.log('正文', info.txt.slice(0, 260));

const shot = await send('Page.captureScreenshot', { format: 'png' });
const b = Buffer.from(shot.result.data, 'base64');
const f = `storage/tmp/r211/shots/${OUT}.png`;
fs.writeFileSync(f, b);
console.log('截图', f, b.length + 'B sha=' + crypto.createHash('sha256').update(b).digest('hex').slice(0, 12));
child.kill('SIGKILL');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
