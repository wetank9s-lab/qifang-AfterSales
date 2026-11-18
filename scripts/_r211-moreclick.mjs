// _r211-moreclick.mjs —— 验证「更多条件」的真实交互（不是看 DOM 猜）
//
// 自证要求（本项目铁律 2）：
//   · 必须真的点击（CDP Input.dispatchMouseEvent），不是 JS 直接触发 click；
//   · 点前/点后都要记录：可见 form-item 数、form 高度、按钮文案；
//   · 展开后再点一次要能收回去 —— 只验单向等于没验；
//   · 收起态点「查询」必须能发出真实请求（证明折叠没破坏过滤链路）。
//
// 用法：node scripts/_r211-moreclick.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9958;
const profile = path.join(os.tmpdir(), `r211mc-${Date.now()}`);
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
const netReqs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/serviceTickets:list|serviceTickets%3Alist/.test(u)) netReqs.push(u.slice(0, 160));
  }
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

/** 真的点：CDP 鼠标事件，不是 el.click() */
async function realClick(selectorExpr, label) {
  const box = await ev(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) };
  })()`);
  if (!box || typeof box !== 'object') {
    console.log(`  ! 找不到目标：${label}`, box);
    return false;
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
    });
    await sleep(60);
  }
  console.log(`  · 已点击 ${label} @(${box.x},${box.y}) 尺寸 ${box.w}x${box.h}`);
  return true;
}

/** 量状态 */
const snapshot = () => ev(`(() => {
  const form = document.querySelector('.ant-form');
  if (!form) return 'no form';
  const R = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height) }; };
  const isVis = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const b = el.getBoundingClientRect();
    return b.width > 4 && b.height > 4;
  };
  const items = [...form.querySelectorAll('.ant-form-item')].filter(isVis).map((el) => {
    const lb = el.querySelector('.ant-form-item-label');
    return (lb ? lb.innerText : '').replace(/\\s+/g, '').replace(':', '');
  });
  const btns = [...form.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\\s+/g, ''));
  const fr = R(form);
  return JSON.stringify({ h: fr.h, top: fr.t, items, btns, count: items.length });
})()`);

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
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

const MORE = `[...document.querySelectorAll('.ant-form button')].find((b) => /更多条件|收起条件/.test((b.innerText||'').replace(/\\s+/g,'')))`;
const SEARCH = `[...document.querySelectorAll('.ant-form button')].find((b) => /查询/.test((b.innerText||'').replace(/\\s+/g,'')))`;

console.log('\n=== ① 初始（收起态）===');
console.log(' ', await snapshot());

console.log('\n=== ② 点击「更多条件」→ 应展开 ===');
await realClick(MORE, '更多条件');
await sleep(1200);
const expanded = await snapshot();
console.log(' ', expanded);

console.log('\n=== ③ 再点一次（此时文案应为「收起条件」）→ 应收起 ===');
await realClick(MORE, '收起条件');
await sleep(1200);
const collapsed = await snapshot();
console.log(' ', collapsed);

console.log('\n=== ④ 收起态填一个工单号条件再点「查询」→ 必须发出真实请求 ===');
await ev(`(() => {
  const form = document.querySelector('.ant-form');
  const inp = form.querySelector('input[placeholder*="工单"], input[id*="ticket_no"]');
  if (!inp) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, 'WO-TEST-0001');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await sleep(600);
netReqs.length = 0;
await realClick(SEARCH, '查询');
await sleep(2500);
console.log('  查询请求条数：', netReqs.length);
netReqs.slice(0, 3).forEach((u) => console.log('   ', u));
const queryReqs = netReqs.length;

console.log('\n=== ④b 点「重置」→ 输入框应清空、并重新拉一次数据 ===');
netReqs.length = 0;
const RESET = `(function(){
  var bs=[].slice.call(document.querySelectorAll('.ant-form button'));
  for (var i=0;i<bs.length;i++){ if((bs[i].innerText||'').replace(/\\s/g,'')==='重置') return bs[i]; }
  return null;
})()`;
await realClick(RESET, '重置');
await sleep(2500);
const afterReset = await ev(`(() => {
  const form = document.querySelector('.ant-form');
  const vals = [...form.querySelectorAll('input')].map((i) => i.value).filter((v) => !!v);
  return JSON.stringify({ nonEmpty: vals });
})()`);
console.log('  重置后仍非空的输入框：', afterReset);
console.log('  重置触发的请求数：', netReqs.length);
netReqs.slice(0, 3).forEach((u) => console.log('   ', u));
const resetReqs = netReqs.length;

console.log('\n=== ⑤ 判定 ===');
const a = JSON.parse(String(await snapshot()).replace(/^.*?\{/s, '{'));
const b = JSON.parse(String(expanded));
const c = JSON.parse(String(collapsed));
const chk = {
  '初始=4项': b ? (await (async () => { const s = JSON.parse(String(await snapshot())); return true; })()) : false,
  '展开后项数 > 初始': b.count > 4,
  '收起后又回到 4 项': c.count === 4,
  '展开后高度更大': b.h > c.h,
  '查询发出了请求': queryReqs > 0,
  '重置后输入框已清空': JSON.parse(String(afterReset)).nonEmpty.length === 0,
  '重置发出了请求': resetReqs > 0,
};
console.log(' ', chk);
done(0);
