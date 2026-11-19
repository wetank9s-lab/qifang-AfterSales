// _r211-toolbar.mjs —— 只读探针：表格上方那个「筛选」按钮到底是什么
//
// 现状（实测）：
//   ① 筛选卡片底部有「筛选 / 重置」两个 action —— 这是 FilterFormBlock 自带的 submit/reset；
//   ② 表格上方还有一枚「🔍 筛选」—— 用户指令明确要求删掉"重复的筛选按钮"。
// 所以必须先弄清 ② 是哪个模型，再决定怎么删。**不改任何东西，只看结构。**
//
// 判据：从按钮 DOM 往上找最近的 flowModel 容器，读它的 uid，
//       再回库查该 uid 的 options.use —— 才知道它是 FilterFormBlockModel 还是别的。
//
// 用法：node scripts/_r211-toolbar.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9957;
const profile = path.join(os.tmpdir(), `r211tb-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1200', 'about:blank',
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
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
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
if (!rows) { console.log('TABLE NOT READY'); done(3); }

const out = await ev(`(() => {
  const R = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height) }; };
  // 页面上所有带「筛选」/「重置」/「展开」文本的可点元素
  const hits = [...document.querySelectorAll('button, a, [role=button]')]
    .map((b) => ({ el: b, text: (b.innerText || '').trim() }))
    .filter((x) => x.text && x.text.length < 8 && /筛选|重置|收起|展开|查询/.test(x.text));

  const describe = ({ el, text }) => {
    const cs = getComputedStyle(el);
    // 往上找最近的带 data-flow-model 的容器（框架用它标模型边界；没有就往上找 6 层记类名）
    let anc = el.parentElement, modelUid = '', chain = [];
    for (let i = 0; i < 8 && anc; i++, anc = anc.parentElement) {
      for (const a of anc.attributes || []) {
        if (/^data-/.test(a.name) && /model/i.test(a.name)) { modelUid = modelUid || a.value; }
      }
      chain.push((anc.className || anc.tagName || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.'));
    }
    return { text, ...R(el), bg: cs.backgroundColor, color: cs.color,
             cls: (el.className || '').toString().split(' ').filter(c => !c.startsWith('css-')).slice(0, 3).join('.'),
             modelUid, chain };
  };

  // 表格上方卡片 / 下方卡片 —— 用 top 坐标粗分
  const tbl = document.querySelector('table');
  const tblTop = tbl ? Math.round(tbl.getBoundingClientRect().top) : 0;
  const above = hits.filter((h) => R(h.el).t < tblTop).map(describe);
  const below = hits.filter((h) => R(h.el).t >= tblTop).map(describe);

  return JSON.stringify({ tblTop, above, below }, null, 1);
})()`);
console.log(out);
done(0);
