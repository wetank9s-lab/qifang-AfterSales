// _r211-tabsverify.mjs —— 验证 6 个页签的筛选区表现一致
//
// 用户裁决里的验收项：
//   · 「展开/收起不丢失查询条件，页签切换后不出现重复筛选框」
//   · 「筛选表单确实比 176px 明显紧凑」
//
// 逐页签记录：form 高度、可见字段数、按钮文案、是否存在第二个 .ant-form（重复筛选框）。
//
// 用法：node scripts/_r211-tabsverify.mjs [uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv[2] || 'tujyw08ec1d';
const TARGET = arg.startsWith('/') ? arg : '/admin/' + arg;
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9960;
const profile = path.join(os.tmpdir(), `r211tv-${Date.now()}`);
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

async function realClick(expr) {
  const box = await ev(`(() => {
    const el = ${expr};
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  if (!box || typeof box !== 'object') return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(60);
  }
  return true;
}

const snap = () => ev(`(() => {
  const forms = [...document.querySelectorAll('.ant-form')];
  // ⚠️ 页签是 AntD Tabs，默认 keep-alive：切走的页签 DOM 还在，只是被隐藏。
  //    所以「有没有重复筛选框」不能数 .ant-form 的总数（那会 1→2→3…），
  //    必须数**可见**的：沿父级查 display/visibility，并且要求尺寸 > 4px。
  const isVis = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const b = el.getBoundingClientRect();
    return b.width > 4 && b.height > 4;
  };
  const visForms = forms.filter((f) => f.querySelector('[data-grid-root]') && isVis(f));
  const form = visForms[0];
  if (!form) return JSON.stringify({ h: 0, n: 0, items: [], btns: [], formCount: forms.length, visFormCount: visForms.length });
  const R = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.height); };
  const items = [...form.querySelectorAll('.ant-form-item')].filter(isVis).map((el) => {
    const lb = el.querySelector('.ant-form-item-label');
    return (lb ? lb.innerText : '').replace(/\\s+/g, '').replace(':', '');
  });
  const btns = [...form.querySelectorAll('button')]
    .filter((b) => isVis(b))
    .map((b) => (b.innerText || '').replace(/\\s+/g, ''));
  return JSON.stringify({
    h: R(form), n: items.length, items, btns,
    formCount: forms.length, visFormCount: visForms.length,
  });
})()`);

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

const TABS = ['全部', '待处理', '处理中', '待门店确认', '待客户评价', '已结束'];
const results = [];
for (const tab of TABS) {
  const ok = await realClick(
    `[...document.querySelectorAll('.ant-tabs-tab')].find((t) => (t.innerText||'').trim() === ${JSON.stringify(tab)})`
  );
  if (!ok) { console.log('  ! 找不到页签', tab); continue; }
  // 等表格与筛选区稳定
  for (let i = 0; i < 25; i++) {
    await sleep(700);
    const n = Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) || 0;
    if (n > 0) break;
  }
  const s = JSON.parse(String(await snap()));
  results.push({ tab, ...s });
  console.log(`  ${tab}: h=${s.h} 字段=${s.n} 按钮=${s.btns.join('/')} 可见form=${s.visFormCount} 总form=${s.formCount}`);
}

console.log('\n=== 判定 ===');
const hs = results.map((r) => r.h);
const ns = results.map((r) => r.n);
const vfcs = results.map((r) => r.visFormCount);
console.log(JSON.stringify({
  '6 个页签全部 ≤100px': hs.every((h) => h > 0 && h <= 100),
  高度分布: hs,
  '全部 4 项': ns.every((n) => n === 4),
  字段数分布: ns,
  '页面同时只显示 1 个筛选框': vfcs.every((n) => n === 1),
  可见form分布: vfcs,
  '按钮含查询/重置/更多条件': results.every((r) => r.btns.includes('查询') && r.btns.includes('重置') && r.btns.includes('更多条件')),
  各页签字段: results.map((r) => r.items.join('+')),
}, null, 1));
done(0);
