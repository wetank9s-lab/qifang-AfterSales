// _r211-visibleprobe.mjs —— 直接问 Grid 模型：你算出来的可见布局到底是什么形状
//
// 上一轮已确认 props.rows 被写进去了（日志 afterWrite 正确），但页面仍是 4 行。
// 说明 getVisibleLayout() 读的不是 props，或者读完后又按别的源重排。
// 这里在页面上**就地**改 props 再调一次 getVisibleLayout()，把两次结果对比出来。
//
// 用法：node scripts/_r211-visibleprobe.mjs [routeUid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9969;
const profile = path.join(os.tmpdir(), `r211vp-${Date.now()}`);
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
await ev(`history.pushState({},'',${JSON.stringify(TARGET)});window.dispatchEvent(new PopStateEvent('popstate',''))`).catch(() => {});
await ev(`window.dispatchEvent(new PopStateEvent('popstate'));true`);
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  if (Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) > 0) break;
}

// 先切到「待处理」，问题页签
await ev(`(() => { const t = document.querySelectorAll('.ant-tabs-tab')[1];
  t && t.querySelector('.ant-tabs-tab-btn')?.click(); return true; })()`);
await sleep(3000);

const out = await ev(`(() => {
  const form = [...document.querySelectorAll('.ant-form')].filter((f) => f.getClientRects().length)[0];
  if (!form) return 'no form';
  const KEY = Object.keys(form).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  let block = null;
  for (let n = form[KEY], i = 0; n && i < 80; n = n.return, i++) {
    const p = n.memoizedProps;
    if (p && p.model && p.model.uid && p.model.subModels && p.model.subModels.grid) { block = p.model; break; }
  }
  if (!block) return 'no block';
  const grid = block.subModels.grid;
  const shape = (L) => !L ? null : {
    rowCount: (L.layout && L.layout.rows ? L.layout.rows.length : 0),
    rowsSizes: L.sizes,
    layoutRowSizes: L.layout && L.layout.rows && L.layout.rows.map((r) => ({ id: r.id, cells: r.cells.length, sizes: r.sizes })),
  };
  const before = { propsRows: grid.props && grid.props.rows, vl: shape(grid.getVisibleLayout()) };

  // 就地改 props 再算一次
  const rows0 = grid.props && grid.props.rows;
  const items = (grid.subModels && grid.subModels.items) || [];
  const visible = items.filter((i) => !i.hidden).map((i) => i.uid);
  const next = { row1: [visible.filter((u) => ['7io8qzt1cjy','1y5xxqgm3kv','lrub8hhinrw','vf1k1qkrqrr'].includes(u))] };
  grid.props = Object.assign({}, grid.props, {
    rows: next,
    sizes: { row1: next.row1[0].map(() => 6) },
    rowOrder: ['row1'],
  });
  const after = { propsRows: grid.props.rows, vl: shape(grid.getVisibleLayout()) };
  return JSON.stringify({ blockUid: block.uid, gridUid: grid.uid, visibleItems: visible, before, after }, null, 1);
})()`);
console.log(out);
done(0);
