// _r211-consoleprobe.mjs —— 抓页面 console，确认插件里的 applyGroupLayout 是否真的跑到
//
// 前几轮一直是"看 DOM 猜"，命中率低。这次直接在页面上挂 Runtime.consoleAPICalled，
// 把插件自己吐的探针日志抓回来 —— 有日志 ⇒ 代码跑了；没日志 ⇒ 代码根本没进。
//
// 用法：node scripts/_r211-consoleprobe.mjs [routeUid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9967;
const profile = path.join(os.tmpdir(), `r211cc-${Date.now()}`);
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

const logs = [];
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ');
    logs.push({ type: m.params.type, txt });
  }
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
logs.length = 0;
await ev(`history.pushState({},'',${JSON.stringify(TARGET)});window.dispatchEvent(new PopStateEvent('popstate'));true`);
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  if (Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) > 0) break;
}
await sleep(1500);

// 先切到「待处理」页签，再看同一份日志
await ev(`(() => { const t = document.querySelectorAll('.ant-tabs-tab')[1];
  t && t.querySelector('.ant-tabs-tab-btn')?.click(); return true; })()`);
await sleep(3000);
const relevant = logs.filter((l) => /svc-probe|service-ticket|FlowEngine|overwritten|R2\.1\.1/i.test(l.txt));
console.log('=== 相关 console（', relevant.length, '条）===');
relevant.slice(0, 40).forEach((l) => console.log(`[${l.type}] ${l.txt}`));

// 顺便报一下当前高度
const h = await ev(`(() => { const f = [...document.querySelectorAll('.ant-form')].filter((x) => x.getClientRects().length)[0];
  return f ? Math.round(f.getBoundingClientRect().height) : -1; })()`);
console.log('\n当前筛选表单高度 =', h);
done(0);
