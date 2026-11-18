// _r211-cellprobe.mjs —— 网格里每个 item 的包裹结构
//
// 「全部」页签 4 项一行，其余 5 个页签即使把 props.rows 写成同一行，运行时仍被拆成
// 每项独占一行（sizes 全是 [24]）。差别只能在 item 节点自己身上。
// 这里把 model / fiber 两层的 props 与 options 全部打出来做差分对照。
//
// 用法：node scripts/_r211-cellprobe.mjs [routeUid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9963;
const profile = path.join(os.tmpdir(), `r211cp-${Date.now()}`);
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

const PROBE = `(() => {
  const form = [...document.querySelectorAll('.ant-form')].filter((f) => f.getClientRects().length)[0];
  if (!form) return 'no form';
  const KEY = Object.keys(form).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  let grid = null;
  for (let n = form[KEY], i = 0; n && i < 80; n = n.return, i++) {
    const p = n.memoizedProps;
    if (p && p.model && p.model.uid && p.model.subModels && p.model.subModels.grid) { grid = p.model.subModels.grid; break; }
    if (p && p.model && p.model.uid && p.model.constructor && /GridModel/.test(p.model.constructor.name)) { grid = p.model; break; }
  }
  if (!grid) return 'no grid';
  const items = (grid.subModels && grid.subModels.items) || [];
  return JSON.stringify({
    gridUid: grid.uid,
    gridOptKeys: Object.keys(grid.options || {}),
    gridProps: grid.props,
    itemSample: items.slice(0, 2).map((m) => ({
      uid: m.uid,
      ctor: m.constructor && m.constructor.name,
      optKeys: Object.keys(m.options || {}),
      subKey: m.subKey,
      subType: m.subType,
      props: m.props,
      parent: m.parent && m.parent.uid,
      hasParent: !!m.parent,
    })),
    // grid 模型身上是否有 cell 级 API
    gridApi: Object.getOwnPropertyNames(Object.getPrototypeOf(grid)).filter((k) => /cell|row|layout|item/i.test(k)),
    // 每个 item 的 fiber key 是否存在（决定是否是独立渲染单元）
    renderListRole: (() => {
      const root = document.querySelector('[data-grid-uid="' + grid.uid + '"]') || null;
      const rowsEl = document.querySelectorAll('.ant-form .ant-row');
      return { rowsElCount: rowsEl.length };
    })(),
  }, null, 1);
})()`;

const names = ['全部', '待处理'];
for (let i = 0; i < names.length; i++) {
  if (i > 0) {
    await ev(`(() => { const t = document.querySelectorAll('.ant-tabs-tab')[${i}];
      t && t.querySelector('.ant-tabs-tab-btn')?.click(); return true; })()`);
    await sleep(2500);
  }
  console.log(`\n##### ${i} ${names[i]}`);
  console.log(await ev(PROBE));
}
done(0);
