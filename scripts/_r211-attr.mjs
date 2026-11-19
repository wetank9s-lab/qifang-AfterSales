// _r211-attr.mjs —— 只读：Grid 的 props 会不会变成 DOM 属性
//
// 背景：`options.hidden` 在 2.2.15 不生效（DEV-266 已实证）。要在**不写 JS、不碰 DOM**的前提下
// 用 CSS 精确命中，就得先确定 Grid 模型 props 的哪个键会落到 DOM 上。
// 本脚本只回答一个问题：`data-grid-root` 元素身上有哪些 attribute。
//
// 用法：node scripts/_r211-attr.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9956;
const profile = path.join(os.tmpdir(), `r211at-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1100', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 120; i++) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 等 Chrome */ }
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails || r?.result);
};
const done = (code) => {
  child.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力 */ }
  process.exit(code);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(4000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});true`);
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(13000);
if (String(await ev('location.pathname')).includes('signin')) { console.log('LOGIN FAILED'); done(2); }
await ev(`history.pushState({},'',${JSON.stringify(TARGET)});window.dispatchEvent(new PopStateEvent('popstate'));true`);

let rows = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  rows = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
  if (rows > 0) break;
}
console.log('URL', await ev('location.pathname'), '| rows', rows);
if (!rows) { console.log('TABLE NOT READY'); done(3); }

const out = await ev(`(() => {
  const g = document.querySelector('.ant-form [data-grid-root]');
  if (!g) return JSON.stringify({ error: 'no [data-grid-root]' }, null, 1);
  const attrs = [...g.attributes].map((a) => ({ n: a.name, v: String(a.value).slice(0, 160) }));
  const R = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) }; };
  const labelOf = (itemEl) => { const l = itemEl.querySelector('.ant-form-item-label'); return (l ? l.innerText : '').replace(/\\s+/g, '').slice(0, 10); };
  // 每一行、每个 cell 里有哪些 form-item，各自什么标签、什么尺寸
  const gridRows = [...g.querySelectorAll(':scope > [data-grid-row-id]')].map((rEl) => ({
    rowId: rEl.getAttribute('data-grid-row-id'), ...R(rEl),
    cells: [...rEl.querySelectorAll(':scope > [data-grid-column-row-id]')].map((c) => ({
      idx: c.getAttribute('data-grid-column-index'), ...R(c),
      items: [...c.querySelectorAll('[data-grid-item-uid]')].map((it) => ({
        uid: it.getAttribute('data-grid-item-uid'),
        label: labelOf(it), ...R(it),
      })),
    })),
  }));
  const form = document.querySelector('.ant-form');
  return JSON.stringify({
    gridAttrs: attrs,
    gridRect: R(g),
    formRect: form ? R(form) : null,
    gridRows,
  }, null, 1);
})()`);
console.log(out);
done(0);
