// _r211-probe.mjs —— 打开指定内容根页，抓「表格列序 / 行内按钮 / 筛选区高度」并截图。
//
// 两条走过弯路必须记住的事实：
//  ① 点侧栏菜单不会跳转（antd Menu 的 li 不触发 SPA 路由）；
//     **必须** history.pushState + PopStateEvent，这才是真实 SPA 导航。
//  ② 页面渲染是异步的，固定 sleep 会偶发抓到空表；
//     **必须**轮询等 table tbody tr.ant-table-row 出现（最多 N 秒），超时判 TEST INVALID。
//
// 用法：node scripts/_r211-probe.mjs <uid|path> [shot.png]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const SHOT = process.argv[3] || '';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9953;
const profile = path.join(os.tmpdir(), `r211pb-${Date.now()}`);
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
  return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails || r?.result);
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

if (String(await ev('location.pathname')).includes('signin')) {
  console.log('LOGIN FAILED');
  done(2);
}
await ev(`history.pushState({},'',${JSON.stringify(TARGET)});window.dispatchEvent(new PopStateEvent('popstate'));true`);

// 轮询等表格行（最多 40s）—— 固定 sleep 会偶发抓空表，这是已知坑
let rows = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  rows = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
  if (rows > 0) break;
}
console.log('URL', await ev('location.pathname'), '| rows', rows);

const out = await ev(`(() => {
  const NL = String.fromCharCode(10);
  const T = (n) => (n.innerText || '').trim().split(NL).map((s) => s.trim()).filter(Boolean).join(' / ');
  const head = [...document.querySelectorAll('table thead th')].map(T);
  const trs = [...document.querySelectorAll('table tbody tr.ant-table-row')];
  const sample = trs.slice(0, 5).map((tr) => [...tr.querySelectorAll('td')].map((td) => {
    const btns = [...td.querySelectorAll('.ant-btn, a, button')].map((b) => (b.innerText || '').trim()).filter(Boolean);
    return btns.length ? 'BTN[' + btns.join('+') + ']' : T(td).slice(0, 22);
  }));
  const more = [...document.querySelectorAll('table button, table a')]
    .map((b) => (b.innerText || '').trim()).filter((t) => /更多|查看完整|More/.test(t));
  const sizes = [];
  const seen = new Set();
  for (const b of document.querySelectorAll('table tbody .ant-btn')) {
    const t = (b.innerText || '').trim();
    if (seen.has(t)) continue; seen.add(t);
    const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
    sizes.push({ text: t, h: Math.round(r.height), w: Math.round(r.width),
                 radius: cs.borderRadius, bg: cs.backgroundColor, color: cs.color });
  }
  const fb = document.querySelector('.ant-form');
  const ftop = fb ? Math.round(fb.getBoundingClientRect().top) : null;
  return JSON.stringify({
    head, sample, more, sizes,
    filterHeight: fb ? Math.round(fb.getBoundingClientRect().height) : null,
    filterTop: ftop,
    tableTop: trs.length ? Math.round(trs[0].getBoundingClientRect().top) : null,
  }, null, 1);
})()`);
console.log(out);

if (SHOT) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const b = Buffer.from(r.result.data, 'base64');
  fs.writeFileSync(path.join('storage/tmp/r211/shots', SHOT), b);
  console.log('shot', SHOT, b.length, 'B');
}
done(rows > 0 ? 0 : 3);
