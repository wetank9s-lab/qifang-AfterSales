// _r211-filtercheck.mjs —— 只读诊断：筛选区为什么是 176px 而不是 80~100px
//
// 目的不是"再试一次改配置"，而是**先看清 DOM 里到底有什么**。
// 前面几轮的通病：没搞清渲染结构就去写样式/改 Grid，改完"看着对、尺寸没变"。
//
// 本脚本只做三件事（全部只读）：
//   ① 列出筛选区每个可见直系子块的位置/高度，找出"谁在撑高"；
//   ② 统计可见的 .ant-form-item 数量、以及是否存在折叠/展开态按钮；
//   ③ 打印筛选区 innerHTML 的**前 1200 字符**，直接看类名，不猜。
//
// 用法：node scripts/_r211-filtercheck.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tokFile = 'storage/tmp/r211/.tok_uat_hqadmin';
const tok = fs.readFileSync(tokFile, 'utf8').trim();
const port = 9954;
const profile = path.join(os.tmpdir(), `r211fc-${Date.now()}`);
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
  return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails || r?.result);
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

if (String(await ev('location.pathname')).includes('signin')) {
  console.log('LOGIN FAILED');
  done(2);
}
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
  const form = document.querySelector('.ant-form');
  if (!form) return JSON.stringify({ error: 'no .ant-form' }, null, 1);

  const R = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) }; };
  const cls = (el) => (el.className && typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 4).join('.');

  // 1) 筛选区直系子块 —— 找"谁在撑高"
  const kids = [...form.children].map((el) => ({ cls: cls(el), tag: el.tagName, ...R(el) }));

  // 2) 表单行与栅格
  const rowsEls = [...form.querySelectorAll('.ant-row')].map((el) => ({
    cls: cls(el), ...R(el),
    items: el.querySelectorAll('.ant-form-item').length,
  }));

  // 3) 可见表单项 —— **按渲染尺寸判可见**，不按 getBoundingClientRect 的 top/height 全大于 0
  //    ⚠️ 前面的坑：hidden 的 form-item 仍保留 0 宽高的占位元素，
  //       用 "h>0 && w>0" 判会漏掉；用 innerText 里有 label 判会把隐藏项算进去。
  //       这里改成看**计算样式**：display:none / visibility:hidden / opacity:0 / 尺寸为 0 都算不可见。
  const isReallyVisible = (el) => {
    let n = el;
    for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const b = el.getBoundingClientRect();
    return b.width > 4 && b.height > 4;
  };
  const visItems = [...form.querySelectorAll('.ant-form-item')].filter(isReallyVisible).map((el) => {
    const lb = el.querySelector('.ant-form-item-label');
    const ph = el.querySelector('input, .ant-select-selection-placeholder, .ant-picker-input input');
    return {
      label: (lb ? lb.innerText : '').trim().slice(0, 12),
      placeholder: (ph && (ph.placeholder || ph.innerText || '') + '').trim().slice(0, 20),
      ...R(el),
    };
  });

  // 4) 折叠/展开按钮（全页搜，不局限 form —— 折叠动作可能渲染在 form 外）
  const toggles = [...document.querySelectorAll('button, a, span')]
    .map((b) => (b.innerText || '').trim())
    .filter((t) => t && t.length < 8 && /展开|收起|更多|筛选|重置|查询/.test(t))
    .filter((t, i, arr) => arr.indexOf(t) === i);
  const collapseEl = document.querySelector('[class*=collapse], [class*=Collapse]');
  const collapseInfo = collapseEl ? { cls: collapseEl.className.slice(0, 80), ...R(collapseEl) } : null;

  // 5) 外壳：form 的父级链（往上三层），看有没有额外留白
  const chain = [];
  let p = form.parentElement;
  for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
    const cs = getComputedStyle(p);
    chain.push({ cls: cls(p) || p.tagName, ...R(p),
                 pad: cs.padding, mar: cs.margin, gap: cs.rowGap, disp: cs.display });
  }

  return JSON.stringify({
    form: R(form), formCls: cls(form),
    kids, rowsEls, visItemCount: visItems.length, visItems: visItems.slice(0, 12),
    toggles, collapseInfo, chain,
    htmlHead: form.innerHTML.replace(/\\s+/g, ' ').slice(0, 1200),
  }, null, 1);
})()`);
console.log(out);
done(0);
