// _r211-actbtn.mjs —— 只读：表格动作区（actions）在 DOM 上留下了哪些标记
//
// 目的：确认 `options.visible=false` 这类"我自己加的键"会不会碰到 DOM。
// 若不会，就只能用**结构锚点**（例如"动作组里第二个按钮"）来写 CSS。
// 本脚本只读，不改任何东西。
//
// 用法：node scripts/_r211-actbtn.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9960;
const profile = path.join(os.tmpdir(), `r211ab-${Date.now()}`);
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
  const txt = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20);
  const R = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) }; };
  // 1) 找「新建服务单」按钮所在的容器（= 表格动作区），把它的祖先链与兄弟结构打出来
  const tbl = document.querySelector('table');
  const tblTop = tbl ? Math.round(tbl.getBoundingClientRect().top) : 0;
  const above = [...document.querySelectorAll('button')].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.top > 0 && r.top < tblTop && (b.innerText || '').trim();
  }).map((b) => ({ t: Math.round(b.getBoundingClientRect().top), text: txt(b) }));
  const btn = [...document.querySelectorAll('button')].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.top > 0 && r.top < tblTop && /新建|刷新|筛选/.test(b.innerText || '');
  }).pop();
  let actBox = null;
  if (btn) {
    let n = btn.parentElement;
    // 往上找到"含 ≥2 个按钮且宽度>300"的容器
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      if (n.querySelectorAll('button').length >= 2 && n.getBoundingClientRect().width > 300) { actBox = n; break; }
    }
  }
  const boxInfo = actBox ? {
    rect: R(actBox),
    attrs: [...actBox.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 60)),
    cls: String(actBox.className).slice(0, 120),
    children: [...actBox.children].map((c) => ({
      tag: c.tagName, cls: String(c.className).slice(0, 90),
      attrs: [...c.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 40)).slice(0, 4),
      btns: [...c.querySelectorAll('button')].map((b) => txt(b)),
      text: txt(c),
    })),
    // 直接子级里能看到的按钮顺序
    flatBtns: [...actBox.querySelectorAll('button')].map((b, i) => ({ i, text: txt(b), ...R(b) })),
  } : null;
  // 2) 整个文档里有没有 data-* 携带模型 uid
  const sample = [...document.querySelectorAll('[data-model-uid], [data-uid]')].slice(0, 8).map((e) => ({
    tag: e.tagName, attrs: [...e.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 30)),
  }));
  return JSON.stringify({ aboveBtns: above, boxInfo, uidAttrSample: sample }, null, 1);
})()`);
console.log(out);
done(0);
