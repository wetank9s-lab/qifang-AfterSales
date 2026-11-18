// _r211-itemprobe.mjs —— 拆开单个筛选字段看它内部到底占了多少高度
//
// 160px 卡住不动，说明压的是"外面"（标签/边距），真正的高度在 form-item 内部。
// 这里把一个 form-item 从外到内的每一层盒子尺寸全打出来，找最厚的那层。
//
// 用法：node scripts/_r211-itemprobe.mjs [routeUid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9973;
const profile = path.join(os.tmpdir(), `r211ip-${Date.now()}`);
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
  const form = [...document.querySelectorAll('.ant-form')].filter((f) => f.getClientRects().length)[0];
  if (!form) return 'no form';
  const dump = (el, depth, max) => {
    if (!el || depth > max) return [];
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const line = {
      d: depth,
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 60),
      h: Math.round(r.height),
      w: Math.round(r.width),
      pad: cs.paddingTop + '/' + cs.paddingBottom,
      mar: cs.marginTop + '/' + cs.marginBottom,
      disp: cs.display,
      minH: cs.minHeight,
      lh: cs.lineHeight,
      fs: cs.fontSize,
    };
    const kids = [...el.children].flatMap((c) => dump(c, depth + 1, max));
    return [line, ...kids];
  };
  const item = form.querySelector('.ant-form-item');
  return JSON.stringify({
    formH: Math.round(form.getBoundingClientRect().height),
    gridRootH: (() => { const g = form.querySelector('[data-grid-root]'); return g ? Math.round(g.getBoundingClientRect().height) : null; })(),
    tree: dump(item, 0, 4),
  }, null, 1);
})()`);
console.log(out);
done(0);
