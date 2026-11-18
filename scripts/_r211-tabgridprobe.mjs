// _r211-tabgridprobe.mjs —— 六个页签各自的 Grid 模型到底算出了什么布局
//
// 背景：SQL 已把 5 个页签的 props / stepParams 都改成 4+3，但页面仍是 292px（4 行）。
// 说明「库里写的」和「运行时拿到的」之间还有一层。这里不再从 DOM 猜，也不猜 block uid：
// 逐个页签点开，从 fiber 里反查 FilterFormBlockModel，再顺着 subModels 找 grid，
// 直接调 getVisibleLayout() 并把模型上的 rows/sizes 原样打出来。
//
// 用法：node scripts/_r211-tabgridprobe.mjs [routeUid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9961;
const profile = path.join(os.tmpdir(), `r211tg-${Date.now()}`);
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
let rows = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  rows = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
  if (rows > 0) break;
}
console.log('URL', await ev('location.pathname'), '| rows', rows);

// 从当前可见的 .ant-form 出发反查 block 模型 -> grid 模型
const PROBE = `(() => {
  const forms = [...document.querySelectorAll('.ant-form')].filter((f) => f.offsetParent !== null || f.getClientRects().length);
  const form = forms[0];
  if (!form) return 'no visible .ant-form';
  const KEY = Object.keys(form).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (!KEY) return 'no fiber';
  let block = null;
  for (let n = form[KEY], i = 0; n && i < 80; n = n.return, i++) {
    const p = n.memoizedProps;
    if (p && p.model && p.model.uid && typeof p.model.getSvcExpanded === 'function') { block = p.model; break; }
    if (p && p.model && p.model.uid && p.model.subModels && p.model.subModels.grid && p.model.subModels.grid.subModels && p.model.subModels.grid.subModels.items) { block = p.model; break; }
  }
  if (!block) return 'no block model in fiber chain';
  const grid = block.subModels && block.subModels.grid;
  const out = { blockUid: block.uid, ctor: block.constructor && block.constructor.name,
                expanded: typeof block.getSvcExpanded === 'function' ? block.getSvcExpanded() : null,
                gridUid: grid && grid.uid, gridCtor: grid && grid.constructor && grid.constructor.name };
  if (grid) {
    out.modelRows = grid.props && grid.props.rows;
    out.modelSizes = grid.props && grid.props.sizes;
    out.modelRowOrder = grid.props && grid.props.rowOrder;
    out.hasModelLayout = !!(grid.props && grid.props.layout);
    out.stepGrid = grid.stepParams && grid.stepParams.gridSettings && grid.stepParams.gridSettings.grid;
    const items = (grid.subModels && grid.subModels.items) || [];
    out.items = items.map((m) => ({ uid: m.uid, hidden: !!m.hidden,
      fp: m.stepParams && m.stepParams.fieldSettings && m.stepParams.fieldSettings.init && m.stepParams.fieldSettings.init.fieldPath }));
    try {
      const L = grid.getVisibleLayout();
      out.visible = { rows: L.rows, sizes: L.sizes, layoutRows: L.layout && L.layout.rows };
    } catch (e) { out.visible = 'EXC ' + e.message; }
  }
  out.formH = Math.round(form.getBoundingClientRect().height);
  return JSON.stringify(out);
})()`;

const tabNames = ['全部', '待处理', '处理中', '待门店确认', '待客户评价', '已结束'];
for (let i = 0; i < tabNames.length; i++) {
  if (i > 0) {
    const ok = await ev(`(() => {
      const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
      const t = tabs[${i}];
      if (!t) return false;
      t.querySelector('.ant-tabs-tab-btn')?.click();
      return true;
    })()`);
    if (!ok) { console.log(`\n##### ${tabNames[i]} ：找不到页签`); continue; }
    await sleep(2500);
  }
  const r = await ev(PROBE);
  console.log(`\n##### ${i} ${tabNames[i]}`);
  try {
    const o = JSON.parse(r);
    console.log(JSON.stringify({
      blockUid: o.blockUid, gridUid: o.gridUid, expanded: o.expanded, formH: o.formH,
      modelSizes: o.modelSizes, hasModelLayout: o.hasModelLayout,
      stepGridSizes: o.stepGrid && o.stepGrid.sizes,
      visibleSizes: o.visible && o.visible.sizes,
      layoutRows: o.visible && o.visible.layoutRows,
      itemCount: (o.items || []).length,
      hiddenCount: (o.items || []).filter((x) => x.hidden).length,
    }, null, 1));
  } catch { console.log(r); }
}
done(0);
