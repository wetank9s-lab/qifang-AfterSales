// _r211-uidmap.mjs —— 关键结论验证：Grid / 动作区会不会渲染 data-uid
//
// 用户明确禁止"覆写框架内部逻辑"和"DOM 修补"，但允许"用现有资源的过滤机制"。
// 若 `data-uid={模型uid}` 是框架自己渲染的（不是我们加的），那 CSS 用 `[data-uid="..."]`
// 精确命中就不算 DOM 修补 —— 必须先用证据说清这一点。
//
// 用法：node scripts/_r211-uidmap.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9962;
const profile = path.join(os.tmpdir(), `r211um-${Date.now()}`);
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

const out = await ev(`(() => {
  const WANT = {
    'orb55pbycge': 'FilterFormGrid',
    '1gfakorupt9': 'item 创建日期',
    'f6zhgbcslpo': 'item 当前门店',
    'q5lpnnk1ak0': 'item 工单号',
    'mlnkdf33xcb': 'item 客户手机号',
    '27vivpbm9xz': 'item 工单类型',
    'gg81rp6zsvc': 'item 状态',
    'uicywi61ulo': 'item 客户姓名',
    '7o8d9ilwq64': 'submit 筛选',
    '82fujo7g2uw': 'reset 重置',
    'w1cen6v6y97': 'table FilterAction',
    'bscrh3tmfix': 'table RefreshAction',
    'rg0j4hvp2qg': 'TicketCreateAction',
    '61gqn2l6ag8': 'TableActionsColumn',
    '4c30les7egq': 'TicketTabFilter',
    '5vf45hx13is': 'TableBlock',
    '7wvs3wadc3m': 'FilterFormBlock',
  };
  const res = {};
  for (const [uid, label] of Object.entries(WANT)) {
    const el = document.querySelector('[data-uid="' + uid + '"]');
    if (!el) { res[label] = { uid, found: false }; continue; }
    const b = el.getBoundingClientRect();
    res[label] = {
      uid, found: true, tag: el.tagName,
      cls: String(el.className).slice(0, 70),
      rect: { t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) },
      childUids: [...el.querySelectorAll('[data-uid]')].length,
    };
  }
  // 反向：页面上所有 data-uid 是不是都在我们的 flowModels 里（说明是框架自己打的）
  const all = [...document.querySelectorAll('[data-uid]')].length;
  const sample = [...document.querySelectorAll('[data-uid]')].slice(0, 6).map((e) => e.getAttribute('data-uid') + ':' + e.tagName);
  return JSON.stringify({ res, totalDataUid: all, sample }, null, 1);
})()`);
console.log(out);
done(0);
