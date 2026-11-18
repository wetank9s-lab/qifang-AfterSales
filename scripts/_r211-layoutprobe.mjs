// _r211-layoutprobe.mjs —— 只读取证：直接问 Grid 模型"你算出来的布局是什么"
//
// 前几轮一直从 DOM 反推（每行几项、多宽），只能看到结果看不到中间量，
// 于是每次改完都在猜"为什么还是 2 项一行"。
// 这里改为直接调 Grid 模型的 `getVisibleLayout()`，把 rows / sizes 原样打出来。
//
// 用法：node scripts/_r211-layoutprobe.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9956;
const profile = path.join(os.tmpdir(), `r211lp-${Date.now()}`);
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

// 从 fiber 找到 grid 模型（uid 已知：orb55pbycge），直接调 getVisibleLayout()
const out = await ev(`(() => {
  const form = document.querySelector('.ant-form');
  if (!form) return 'no .ant-form';
  const KEY = Object.keys(form).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (!KEY) return 'no fiber';

  const seen = new Map();
  const all = [];
  for (let n = form[KEY], i = 0; n && i < 60; n = n.return, i++) {
    const p = n.memoizedProps;
    if (p && p.model && p.model.uid) { seen.set(p.model.uid, p.model); all.push([p.model.uid, p.model.constructor && p.model.constructor.name]); }
    // 子级也可能带 model
    const ch = p && p.children;
    if (ch) {
      const stack = Array.isArray(ch) ? [...ch] : [ch];
      while (stack.length) {
        const c = stack.pop();
        if (!c || typeof c !== 'object') continue;
        if (c.props) {
          if (c.props.model && c.props.model.uid) seen.set(c.props.model.uid, c.props.model);
          const cc = c.props.children;
          if (cc) Array.isArray(cc) ? stack.push(...cc) : stack.push(cc);
        }
      }
    }
  }

  const res = { found: [], gridLayout: null, gridProps: null, itemHidden: [] };
  res.found = all.slice(0, 40);

  const GRID_UID = 'hqjutml8qtn';
  const grid = seen.get(GRID_UID);
  const block = (grid && grid.parent && grid.parent.uid) ? grid.parent : null;
  if (block) res.blockUid = block.uid;
  if (block) {
    res.blockInfo = {
      expanded: typeof block.getSvcExpanded === 'function' ? block.getSvcExpanded() : null,
      collapsed: typeof block.getSvcCollapsedUids === 'function' ? block.getSvcCollapsedUids() : null,
    };
    const items = block.subModels && block.subModels.grid && block.subModels.grid.subModels && block.subModels.grid.subModels.items || [];
    res.itemHidden = items.map((m) => ({ uid: m.uid, hidden: !!m.hidden, fp: m.stepParams && m.stepParams.fieldSettings && m.stepParams.fieldSettings.init && m.stepParams.fieldSettings.init.fieldPath }));
  }
  if (grid) {
    res.gridProps = {
      rows: grid.props && grid.props.rows,
      sizes: grid.props && grid.props.sizes,
      rowOrder: grid.props && grid.props.rowOrder,
      hasLayout: !!(grid.props && grid.props.layout),
    };
    try {
      const L = grid.getVisibleLayout();
      res.gridLayout = {
        rows: L.rows,
        sizes: L.sizes,
        layoutVersion: L.layout && L.layout.version,
        layoutRows: L.layout && L.layout.rows,
      };
    } catch (e) {
      res.gridLayout = 'EXC ' + e.message;
    }
  }
  return JSON.stringify(res, null, 1);
})()`);
console.log('\n=== Grid 实测布局 ===');
console.log(out);
done(0);
