// _r211-colprobe.mjs —— 表头/列宽/操作列是否真的有按钮
//
// 截图里看不到操作列（最右那列），而用户明确要求「第一屏直接看到主按钮」。
// 先量清楚：表头有几列、每列多宽、表格总宽 vs 容器宽（判断是否被横向溢出藏掉）、
// 末列里到底有没有 button/a。
//
// 用法：node scripts/_r211-colprobe.mjs [routeUid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9977;
const profile = path.join(os.tmpdir(), `r211cp2-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1440,1100', 'about:blank',
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
  if (r?.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '');
  return r?.result?.result?.value;
};
const done = (code) => {
  child.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力 */ }
  process.exit(code);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(4000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});true`);
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(13000);
if (String(await ev('location.pathname')).includes('signin')) { console.log('LOGIN FAILED'); done(2); }
await ev(`history.pushState({},'',${JSON.stringify(TARGET)});window.dispatchEvent(new PopStateEvent('popstate'));true`);
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  if (Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) > 0) break;
}

const out = await ev(`(() => {
  const tbl = document.querySelector('table');
  if (!tbl) return 'no table';
  const wrap = tbl.closest('.ant-table-content') || tbl.closest('.ant-table-container') || tbl.parentElement;
  const heads = [...tbl.querySelectorAll('thead th')].map((t, i) => ({
    i,
    label: (t.innerText || '').trim().slice(0, 12),
    w: Math.round(t.getBoundingClientRect().width),
  }));
  const rows = [...tbl.querySelectorAll('tbody tr.ant-table-row')].slice(0, 3).map((r) => ({
    cells: [...r.children].map((c, i) => ({
      i,
      w: Math.round(c.getBoundingClientRect().width),
      btns: c.querySelectorAll('button').length,
      links: c.querySelectorAll('a').length,
      txt: (c.innerText || '').trim().slice(0, 14),
    })),
  }));
  return JSON.stringify({
    tblW: Math.round(tbl.getBoundingClientRect().width),
    wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
    wrapScrollW: wrap ? wrap.scrollWidth : null,
    overflowX: wrap ? getComputedStyle(wrap).overflowX : null,
    colCount: heads.length,
    heads,
    rows,
  }, null, 1);
})()`);
console.log(out);
done(0);
