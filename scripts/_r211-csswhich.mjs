// _r211-csswhich.mjs —— 反查：某条 computed 值到底来自哪条规则
//
// 本轮踩到：把 table-layout:fixed 的选择器收窄后，target 页面仍报 fixed，
// 说明**还有第二条规则在命中**。光看"值对不对"分不清是谁给的，
// 必须把 document.styleSheets 里所有能匹配该元素的规则逐条列出来，
// 并标明「谁赢了」（!important + 选择器优先级 + 源码顺序）。
//
// 用法：node scripts/_r211-csswhich.mjs [routeUid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9971;
const profile = path.join(os.tmpdir(), `r211cw-${Date.now()}`);
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
await ev(`history.pushState({},'',${JSON.stringify(TARGET)});window.dispatchEvent(new PopStateEvent('popstate'));true`);
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  if (Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) > 0) break;
}
await sleep(1500);

// 逐条列出所有命中 table 且声明了 table-layout / width 的规则
const out = await ev(`(() => {
  const t = document.querySelector('table');
  if (!t) return 'no table';
  const hits = [];
  const seenSheets = new Set();
  const walk = (rules, href) => {
    for (const r of rules) {
      try {
        if (r.cssRules) { walk(r.cssRules, href); continue; }
        if (!r.selectorText) continue;
        const st = r.style;
        if (!st) continue;
        const decls = [];
        if (st.getPropertyValue('table-layout')) decls.push('table-layout:' + st.getPropertyValue('table-layout') + (st.getPropertyPriority('table-layout') ? ' !imp' : ''));
        if (st.getPropertyValue('width')) decls.push('width:' + st.getPropertyValue('width') + (st.getPropertyPriority('width') ? ' !imp' : ''));
        if (!decls.length) return;
        let matched = false;
        try { matched = t.matches(r.selectorText); } catch { matched = false; }
        if (!matched) return;
        hits.push({ href: (href || 'inline').slice(0, 70), sel: r.selectorText.slice(0, 110), decls });
      } catch { /* 跨域 / 不支持 */ }
    }
  };
  for (const s of document.styleSheets) {
    if (seenSheets.has(s)) continue;
    seenSheets.add(s);
    let rules;
    try { rules = s.cssRules; } catch { continue; }
    if (rules) walk(rules, s.href);
  }
  // 追加：本插件 style 标签的 id 是否在世
  const pluginStyle = document.getElementById('svc-admin-r2-style');
  return JSON.stringify({
    tableTag: t.tagName,
    computedTableLayout: getComputedStyle(t).tableLayout,
    pluginStylePresent: !!pluginStyle,
    pluginStyleLen: pluginStyle ? pluginStyle.textContent.length : 0,
    pluginStyleHasScopedSel: pluginStyle ? pluginStyle.textContent.includes('[data-svc-ticket-list]') : null,
    hitCount: hits.length,
    hits,
  }, null, 1);
})()`);
console.log(out);
done(0);
