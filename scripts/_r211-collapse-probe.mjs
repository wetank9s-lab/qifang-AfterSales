// _r211-collapse-probe.mjs —— 只读：用 React 内部 hook 取 Model 实例，验证
// createModelOptions.pattern（visibleOn）到底管不管用，以及"折叠"能不能稳定落地。
//
// ⚠️ 这是**取证脚本**，不进产品代码。目的只有一个：
//   在改数据库/改源码之前，先确认"这条路真的走得通"，避免再写一版"看着对、页面没变"。
//
// 用它拿实例的手法：在根 fiber 上遍历，找 memoizedState 里带 filterFormGridModel 的，
// 就拿它调 toggleFormFieldsCollapse —— 这同时回答了"折叠方法能不能手动调用成功"。
//
// 用法：node scripts/_r211-collapse-probe.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9958;
const profile = path.join(os.tmpdir(), `r211cp-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1200', 'about:blank',
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
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
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
if (!rows) { console.log('TABLE NOT READY'); done(3); }

const out = await ev(`(() => {
  const seen = new Set();
  const hits = [];
  const rootEl = document.querySelector('#root') || document.body;
  const rootFiberKey = Object.keys(rootEl).find((k) => k.startsWith('__reactContainer'));
  if (!rootFiberKey) return JSON.stringify({ error: 'no react container' }, null, 1);
  const stack = [rootEl[rootFiberKey]];
  let visited = 0;
  while (stack.length && visited < 60000) {
    const f = stack.pop(); visited++;
    if (!f || seen.has(f)) continue;
    seen.add(f);
    let st = f.memoizedState, depth = 0;
    while (st && depth < 30) {
      const v = st.memoizedState;
      if (v && typeof v === 'object' && v.context && v.uid) {
        const use = (v.constructor && v.constructor.name) || '';
        hits.push({ uid: v.uid, ctor: use,
                    hasToggle: typeof v.toggleFormFieldsCollapse === 'function',
                    hasGrid: !!(v.context && v.context.filterFormGridModel) });
      }
      st = st.next; depth++;
    }
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
  }
  // 去重
  const uniq = [];
  const ks = new Set();
  for (const h of hits) { if (ks.has(h.uid)) continue; ks.add(h.uid); uniq.push(h); }
  return JSON.stringify({ visited, count: uniq.length, models: uniq.slice(0, 20) }, null, 1);
})()`);
console.log(out);
done(0);
