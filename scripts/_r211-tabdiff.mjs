// _r211-tabdiff.mjs —— 只读取证：为什么"全部"94px、其余页签 226px
//
// 同样 4 个字段、同样 3 个按钮，高度差一倍多 ⇒ 结构一定不同。
// 取三个东西对比：
//   ① 筛选卡片的父级链与卡片高度；
//   ② 每个 form-item 的位置/尺寸（看是横排还是竖排）；
//   ③ 页签面板容器（tabpane）的样式。
//
// 用法：node scripts/_r211-tabdiff.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9961;
const profile = path.join(os.tmpdir(), `r211td-${Date.now()}`);
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
  if (r?.result?.exceptionDetails) {
    return 'EXC: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '');
  }
  return r?.result?.result?.value;
};
const done = (code) => {
  child.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力 */ }
  process.exit(code);
};

async function clickTab(name) {
  const box = await ev(`(() => {
    const el = [...document.querySelectorAll('.ant-tabs-tab')].find((t) => (t.innerText||'').trim() === ${JSON.stringify(name)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  if (!box || typeof box !== 'object') return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(60);
  }
  return true;
}

const detail = () => ev(`(() => {
  const forms = [...document.querySelectorAll('.ant-form')];
  const isVis = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const b = el.getBoundingClientRect();
    return b.width > 4 && b.height > 4;
  };
  const form = forms.find((f) => f.querySelector('[data-grid-root]') && isVis(f));
  if (!form) return 'no visible form';
  const R = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
  const items = [...form.querySelectorAll('.ant-form-item')].filter(isVis).map((el) => {
    const lb = el.querySelector('.ant-form-item-label');
    return { label: (lb ? lb.innerText : '').replace(/\\s+/g, '').replace(':', ''), ...R(el) };
  });
  // 父级链：看卡片、tabpane 各自多高
  const chain = [];
  let n = form;
  for (let i = 0; i < 7 && n; i++, n = n.parentElement) {
    const cs = getComputedStyle(n);
    chain.push({ cls: String(n.className).split(/\\s+/).filter(Boolean).slice(0, 3).join('.'), ...R(n), disp: cs.display, pad: cs.padding });
  }
  return JSON.stringify({
    form: R(form),
    gridRoot: (() => { const g = form.querySelector('[data-grid-root]'); return g ? R(g) : null; })(),
    rows: [...form.querySelectorAll('.ant-row[data-grid-row-id]')].filter(isVis).map((r) => ({ id: r.getAttribute('data-grid-row-id'), ...R(r) })),
    cells: [...form.querySelectorAll('[data-grid-column-row-id]')].filter(isVis).map((c) => ({
      row: c.getAttribute('data-grid-column-row-id'),
      idx: c.getAttribute('data-grid-column-index'),
      cls: String(c.className).split(/\\s+/).filter((x) => x.startsWith('ant-col')).join(' '),
      ...R(c),
    })),
    items, chain,
  }, null, 1);
})()`);

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
let rows = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  rows = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
  if (rows > 0) break;
}

for (const tab of ['全部', '待处理']) {
  await clickTab(tab);
  for (let i = 0; i < 25; i++) {
    await sleep(700);
    const n = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
    if (n > 0) break;
  }
  console.log(`\n########## ${tab} ##########`);
  console.log(await detail());
}
done(0);
