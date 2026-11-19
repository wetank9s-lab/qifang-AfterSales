// _r211-selfprove.mjs —— 只读自证：筛选区折叠为什么没生效
//
// 不猜。逐层取证：
//   ① 插件产物是否真的到了浏览器（console 里的构建标记）；
//   ② 引擎里 `SvcCompactFilterBlockModel` / `SvcFilterMoreActionModel` 是否注册；
//   ③ 目标 block 的实例是否是我们的子类（`instanceof` / 方法是否存在）；
//   ④ `renderComponent` 到底被调了几次（打桩计数，只观测不改变行为）；
//   ⑤ 7 个 item 的 `hidden` 现值与 `fieldPath`。
//
// 用法：node scripts/_r211-selfprove.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9955;
const profile = path.join(os.tmpdir(), `r211sp-${Date.now()}`);
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
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (txt) logs.push(`[${m.params.type}] ${txt}`);
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.text || '') + ' ' + (r.result.exceptionDetails.exception?.description || '');
  return r?.result?.result?.value;
};
const done = (code) => {
  child.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力 */ }
  process.exit(code);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(4000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});true`);
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(13000);

if (String(await ev('location.pathname')).includes('signin')) {
  console.log('LOGIN FAILED'); done(2);
}

// ① 构建标记
console.log('=== ① 控制台里的插件标记 ===');
logs.filter((l) => l.includes('service-ticket')).slice(-6).forEach((l) => console.log('  ', l));

// ② 引擎注册情况
console.log('\n=== ② 引擎里的模型类 ===');
console.log(await ev(`(() => {
  const out = {};
  const eng = window.__nocobase_flow_engine__ || window.flowEngine || null;
  out.hasGlobalEngine = !!eng;
  // 从任意已注册模型反查 flowEngine 实例：用 React fiber 太脆，改为找 app
  const app = window.__nocobase_app__ || window.app || null;
  out.hasApp = !!app;
  const fe = app && app.flowEngine;
  out.hasFlowEngine = !!fe;
  if (fe && typeof fe.getModelClass === 'function') {
    ['FilterFormBlockModel','FilterFormActionModel','SvcCompactFilterBlockModel','SvcFilterMoreActionModel']
      .forEach((n) => { out[n] = !!fe.getModelClass(n); });
  }
  return JSON.stringify(out, null, 1);
})()`));

await ev(`history.pushState({},'',${JSON.stringify(TARGET)});window.dispatchEvent(new PopStateEvent('popstate'));true`);
let rows = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  rows = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
  if (rows > 0) break;
}
console.log('\nURL', await ev('location.pathname'), '| rows', rows);

// ③④⑤ 从 DOM 反查模型实例
console.log('\n=== ③④⑤ 模型实例与 hidden 现值 ===');
console.log(await ev(`(() => {
  const res = { steps: [] };
  // 用 React fiber 从 .ant-form 往上找 model prop —— 只读，不改任何东西
  const form = document.querySelector('.ant-form');
  if (!form) return 'no .ant-form';
  const KEY = Object.keys(form).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  res.hasFiber = !!KEY;
  if (!KEY) return JSON.stringify(res, null, 1);

  const seen = new Set();
  const models = [];
  const walk = (f, depth) => {
    for (let n = f, i = 0; n && i < 40; n = n.return, i++) {
      const p = n.memoizedProps;
      if (!p) continue;
      const m = p.model;
      if (m && m.uid && !seen.has(m.uid)) {
        seen.add(m.uid);
        models.push({
          uid: m.uid,
          ctor: m.constructor && m.constructor.name,
          hasToggle: typeof m.toggleSvcMore === 'function',
          managed: typeof m.isSvcManaged === 'function' ? m.isSvcManaged() : null,
          hasRenderComponent: typeof m.renderComponent === 'function',
          declaredKey: m.stepParams && m.stepParams.__flowSurfaceMeta && m.stepParams.__flowSurfaceMeta.declaredKey,
        });
      }
    }
  };
  walk(form[KEY].return || form[KEY], 0);
  res.models = models.slice(0, 12);

  // ⑤ 每个 grid item 的 hidden 与 fieldPath
  res.items = [...document.querySelectorAll('[data-grid-item-uid]')].map((el) => ({
    uid: el.getAttribute('data-grid-item-uid'),
    h: Math.round(el.getBoundingClientRect().height),
  }));
  return JSON.stringify(res, null, 1);
})()`));

// 按钮现状
console.log('\n=== ⑥ 表单底部按钮 ===');
console.log(await ev(`(() => {
  const btns = [...document.querySelectorAll('.ant-form button, .ant-form a.ant-btn')];
  return JSON.stringify(btns.map((b) => ({ t: (b.innerText||'').trim().slice(0,10), h: Math.round(b.getBoundingClientRect().height), cls: b.className.split(' ').filter(c=>c.startsWith('ant-btn')).join('.') })), null, 1);
})()`));

console.log('\n=== ⑦ 控制台告警（含 service-ticket）===');
logs.filter((l) => /service-ticket|紧凑|筛选/.test(l)).slice(-8).forEach((l) => console.log('  ', l));
done(0);
