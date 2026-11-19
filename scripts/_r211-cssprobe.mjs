// _r211-cssprobe.mjs —— 只读取证：筛选区的 32px 规则为什么没生效
//
// 常见原因有三个，逐个查清而不是猜：
//   ① 选择器根本没匹配上（:where 降优先级 + .ant-card 层级不对）；
//   ② 匹配上了但被 AntD CSS-in-JS 的更具体规则压掉；
//   ③ 撑高的不是控件，是别的东西。
//
// 用法：node scripts/_r211-cssprobe.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9959;
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
let rows = 0;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  rows = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
  if (rows > 0) break;
}
console.log('URL', await ev('location.pathname'), '| 表格行', rows);

console.log('\n=== ① 样式标签是否存在 ===');
console.log(await ev(`(() => {
  const el = document.getElementById('svc-admin-r2-style');
  return el ? ('存在，长度 ' + el.textContent.length + '，含 32px: ' + el.textContent.includes('min-height: 32px')) : '不存在';
})()`));

console.log('\n=== ② 选择器是否匹配 ===');
console.log(await ev(`(() => {
  const sels = [
    ':where(body:has(.ant-table)) .ant-card .ant-form .ant-form-item-control-input',
    ':where(body:has(.ant-table)) .ant-form-item-control-input',
    '.ant-card .ant-form .ant-form-item-control-input',
    '.ant-form .ant-form-item-control-input',
  ];
  return JSON.stringify(sels.map((s) => {
    try { return { s, n: document.querySelectorAll(s).length }; } catch (e) { return { s, err: e.message }; }
  }), null, 1);
})()`));

console.log('\n=== ③ 实际生效的高度与来源 ===');
console.log(await ev(`(() => {
  const form = document.querySelector('.ant-form');
  if (!form) return 'no form';
  const item = form.querySelector('.ant-form-item');
  const ctrl = form.querySelector('.ant-form-item-control-input');
  const inp = form.querySelector('.ant-form-item-control-input-content .ant-input, .ant-form-item-control-input-content .ant-picker, .ant-form-item-control-input-content .ant-select-selector');
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { h: Math.round(b.height), minH: cs.minHeight, height: cs.height, mb: cs.marginBottom, pt: cs.paddingTop, pb: cs.paddingBottom, lineH: cs.lineHeight }; };
  const label = form.querySelector('.ant-form-item-label');
  return JSON.stringify({
    form: R(form), item: R(item), ctrl: R(ctrl), input: R(inp), label: R(label),
    labelInner: R(label && label.querySelector('label')),
    cardBody: R(form.closest('.ant-card-body')),
    space: R(form.querySelector('.ant-space')),
  }, null, 1);
})()`));

console.log('\n=== ④ AntD 注入的相关规则（看谁压过了谁）===');
console.log(await ev(`(() => {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      const t = r.cssText || '';
      if (/form-item-control-input|form-item-label|\\\\.ant-form-item\\\\s*\\\\{/.test(t) && /min-height|height|margin-bottom|padding-bottom/.test(t)) {
        out.push(t.slice(0, 220));
      }
    }
  }
  return JSON.stringify(out.slice(0, 14), null, 1);
})()`));
done(0);
