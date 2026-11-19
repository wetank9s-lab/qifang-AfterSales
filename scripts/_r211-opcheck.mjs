// _r211-opcheck.mjs —— 只读核实：操作列到底渲染了没有、长什么样
//
// 上一张截图（1440x1100）右边缘正好切掉操作列，导致"按钮样式已定义"和
// "按钮真的渲染出来"这两件事无法区分。用户明确要求：
//   **不能因为 CSS 里已定义按钮样式就宣布完成**。
//
// 所以本脚本不看样式表，只看**真实 DOM**：
//   ① 表头有哪几列、`colgroup` 里每列实际宽度、表格总宽度 vs 容器宽度；
//   ② 每个数据行里 action 列的 `<td>` 是否存在、其 innerText / 按钮 rect；
//   ③ 若被横向裁切，把容器横向滚到最右再截一张，证明内容真的在；
//   ④ 逐个状态 + 其按钮文案，做**状态↔按钮**配对核对（不是"页面上出现了处理工单"）。
//
// 用法：node scripts/_r211-opcheck.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9956;
const profile = path.join(os.tmpdir(), `r211op-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1400', 'about:blank',
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const b = Buffer.from(r.result.data, 'base64');
  fs.writeFileSync(path.join('storage/tmp/r211/shots', name), b);
  console.log('  shot', name, b.length, 'B');
};
const done = (code) => {
  child.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力 */ }
  process.exit(code);
};

await send('Page.enable');
await send('Runtime.enable');
// 1600 宽：先证明"宽屏下操作列确实渲染"，再回到 1440 说明被裁
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1400, deviceScaleFactor: 1, mobile: false });

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
if (!rows) { console.log('TABLE NOT READY'); done(3); }

const out = await ev(`(() => {
  const NL = String.fromCharCode(10);
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };

  const tbl = document.querySelector('table');
  const heads = [...tbl.querySelectorAll('thead th')];
  const headInfo = heads.map((th, i) => ({
    i, text: (th.innerText || '').trim().slice(0, 20), ...R(th),
    cls: (th.className || '').split(' ').filter(c => c && !c.startsWith('css-')).slice(0, 3).join('.'),
  }));

  const cols = [...tbl.querySelectorAll('colgroup col')].map((c, i) => ({ i, w: c.style.width || c.getAttribute('width') || '' }));

  const scrollWrap = tbl.closest('.ant-table-content, .ant-table-body') || tbl.parentElement;
  const wrapInfo = scrollWrap ? { ...R(scrollWrap), sw: scrollWrap.scrollWidth, cw: scrollWrap.clientWidth } : null;

  // 逐行：状态 + 操作列(最后一个 td)里真实存在的按钮
  const trs = [...tbl.querySelectorAll('tbody tr.ant-table-row')];
  const pair = trs.slice(0, 12).map((tr) => {
    const tds = [...tr.querySelectorAll('td')];
    const statusTd = tds.find((td) => /待处理|处理中|待门店确认|待客户评价|已结束|已取消/.test(td.innerText || ''));
    const last = tds[tds.length - 1];
    const btns = [...last.querySelectorAll('button, a')]
      .filter((b) => (b.innerText || '').trim())
      .map((b) => {
        const cs = getComputedStyle(b);
        return { text: (b.innerText || '').trim(), ...R(b),
                 radius: cs.borderRadius, bg: cs.backgroundColor, color: cs.color,
                 action: b.getAttribute('data-primary-action') || '' };
      });
    return {
      no: (tds[1] ? tds[1].innerText : '').trim().slice(0, 20),
      status: statusTd ? (statusTd.innerText || '').trim() : '',
      tds: tds.length,
      lastTdRect: last ? R(last) : null,
      btns,
    };
  });

  return JSON.stringify({ tableW: Math.round(tbl.getBoundingClientRect().width), headInfo, cols, wrapInfo, pair }, null, 1);
})()`);
console.log(out);

await shot('op-1600.png');

// 回到 1440（目标口径），并记录操作列是否落在可视区内
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await sleep(2500);
const at1440 = await ev(`(() => {
  const tbl = document.querySelector('table');
  const ths = [...tbl.querySelectorAll('thead th')];
  const last = ths[ths.length - 1];
  const wrap = tbl.closest('.ant-table-content, .ant-table-body') || tbl.parentElement;
  const b = last.getBoundingClientRect();
  return JSON.stringify({
    actionColLeft: Math.round(b.left), actionColRight: Math.round(b.right),
    viewportW: window.innerWidth,
    scrollLeft: Math.round(wrap.scrollLeft), scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth,
  });
})()`);
console.log('1440:', at1440);
await shot('op-1440.png');
done(0);
