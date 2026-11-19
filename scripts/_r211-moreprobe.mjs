// _r211-moreprobe.mjs —— 只读取证：「更多条件」按钮为什么不出现
//
// 已知：模型已注册（block=true more=true moreFlow=true），库里也挂了
//       `efabd986c30@7wvs3wadc3m`。但页面上找不到它。
// 所以问题出在「模型树建出来没有」这一环，不在按钮渲染。
//
// 依次查：引擎里有没有这个模型实例 → 它的 hidden → block.subModels.actions 里有没有它。
//
// 用法：node scripts/_r211-moreprobe.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9957;
const profile = path.join(os.tmpdir(), `r211mp-${Date.now()}`);
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

console.log('\n=== block 的 subModels.actions ===');
console.log(await ev(`(() => {
  const form = document.querySelector('.ant-form');
  const KEY = form && Object.keys(form).find((k) => k.startsWith('__reactFiber$'));
  if (!KEY) return 'no fiber';
  const seen = new Map();
  for (let n = form[KEY], i = 0; n && i < 60; n = n.return, i++) {
    const p = n.memoizedProps;
    if (p && p.model && p.model.uid) seen.set(p.model.uid, p.model);
  }
  const block = seen.get('7wvs3wadc3m');
  if (!block) return 'no block model; found=' + [...seen.keys()].join(',');

  const res = { actions: [], subModelKeys: Object.keys(block.subModels || {}) };
  const acts = (block.subModels && block.subModels.actions) || [];
  res.actionCount = Array.isArray(acts) ? acts.length : (acts && typeof acts === 'object' ? Object.keys(acts).length : -1);
  (Array.isArray(acts) ? acts : []).forEach((a) => {
    res.actions.push({
      uid: a.uid,
      use: a.use || (a.constructor && a.constructor.name),
      hidden: !!a.hidden,
      title: a.title,
      hasToggle: typeof a.onSvcToggle === 'function',
    });
  });

  // 引擎里是否建出了 efabd986c30
  const eng = block.flowEngine;
  res.hasMoreInEngine = !!(eng && typeof eng.getModel === 'function' && eng.getModel('efabd986c30'));
  res.moreClass = !!(eng && eng.getModelClass && eng.getModelClass('SvcFilterMoreActionModel'));
  return JSON.stringify(res, null, 1);
})()`));

console.log('\n=== 按钮区 HTML（OnFinish 那个 space）===');
console.log(await ev(`(() => {
  const form = document.querySelector('.ant-form');
  const space = form && form.querySelector('.ant-space');
  if (!space) return 'no space';
  return space.outerHTML.replace(/\\s+/g, ' ').slice(0, 1400);
})()`));
done(0);
