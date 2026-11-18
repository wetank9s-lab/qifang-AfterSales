// _r211-finalshot.mjs —— 最终验收截图（1440px，四态各一张）
//
// 用户要求截图同时展示：140px 筛选区、更多条件入口、完整表头、
// 四类状态的实际操作按钮、创建日期列、没有重复筛选入口。
//
// ⚠️ 每张图都同时落一份「判据 JSON」，避免"图看着对、实际不对"。
// ⚠️ 必须用视口截图（captureBeyondViewport 会触发重排把 NocoBase 打回 loading）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const TABS = [
  { key: 'all', title: '全部', uid: 'wz4qkejuvd6' },
  { key: 'new', title: '待处理', uid: '2syydawk24g' },
  { key: 'processing', title: '处理中', uid: 'pac49kftubs' },
  { key: 'wait-store', title: '待门店确认', uid: 'kszn4iloqfr' },
  { key: 'wait-feedback', title: '待客户评价', uid: '9ajzm018g82' },
  { key: 'closed', title: '已结束', uid: 'w08qtr5mplq' },
];
const PAGE = 'tujyw08ec1d';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const OUT = 'storage/tmp/r211/shots';
fs.mkdirSync(OUT, { recursive: true });

const port = 9955;
const profile = path.join(os.tmpdir(), `r211fs-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1440,1000', 'about:blank',
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(4000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});true`);
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(14000);
if (String(await ev('location.pathname')).includes('signin')) { console.log('LOGIN FAILED'); done(2); }

await ev(`history.pushState({},'',${JSON.stringify('/admin/' + PAGE)});window.dispatchEvent(new PopStateEvent('popstate'));true`);
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  if (Number(await ev("document.querySelectorAll('table tbody tr.ant-table-row').length")) > 0) break;
}
await sleep(2500);

// 真实点击页签（不靠路由推）：NocoBase 的页签切换会换 tab 内容
const clickTab = async (title) => {
  return await ev(`(() => {
    const els = [...document.querySelectorAll('.ant-tabs-tab, [role="tab"]')];
    const hit = els.find((e) => (e.innerText || '').replace(/\\s+/g, '') === ${JSON.stringify(title)});
    if (!hit) return 'NOT_FOUND';
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'CLICKED';
  })()`);
};

const METRICS = `(() => {
  // 🔴 口径修正（2026-11-18）：NocoBase 的 Tabs 切页签**不销毁旧 pane**，
  //    只给它加 aria-hidden=true（实测切 4 次后 DOM 里有 4 个 form / 4 张表，
  //    但只有 1 个尺寸非零）。若按 document 全局统计，会得出
  //    「筛选按钮 0→1→2→3 递增 = 重复筛选入口」的**假故障**。
  //    ⇒ 一切判据只在**当前可见 pane** 内统计。
  const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse()
    .find((p) => p.getAttribute('aria-hidden') !== 'true') || document;
  const form = pane.querySelector('.ant-card .ant-form');
  const card = pane.querySelector('.ant-card');
  const tbl = pane.querySelector('table');
  const wrap = tbl ? (tbl.closest('.ant-table-content') || tbl.parentElement) : null;
  const items = [...pane.querySelectorAll('.ant-card .ant-form .ant-form-item')]
    .filter((e) => e.getBoundingClientRect().height > 0);
  const filterH = form ? Math.round(form.getBoundingClientRect().height) : null;
  const thead = tbl ? [...tbl.querySelectorAll('thead th')].map((t) => (t.innerText || '').replace(/\s+/g, '').trim()).filter(Boolean) : [];
  const row = tbl ? tbl.querySelector('tbody tr.ant-table-row') : null;
  const cells = row ? [...row.children] : [];
  const opCell = cells.slice().reverse().find((c) => c.querySelector('button'));
  const opBtns = opCell ? [...opCell.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean) : [];
  // 重复筛选入口：只看可见 pane（页面级「筛选」按钮若存在也会落在 pane 外，故两处都查）
  const scanBtns = (root) => [...root.querySelectorAll('button, .ant-btn')]
    .filter((b) => b.getBoundingClientRect().height > 0)
    .map((b) => (b.innerText || '').replace(/\s+/g, ''));
  const paneBtnTexts = scanBtns(pane);
  const filterBtnsInPane = paneBtnTexts.filter((t) => /^(筛选|条件筛选|高级筛选)$/.test(t));
  const filterBtnsGlobal = scanBtns(document).filter((t) => /^(筛选|条件筛选|高级筛选)$/.test(t));
  const moreBtn = paneBtnTexts.find((t) => t === '更多条件' || t === '收起条件');
  const wr = wrap ? wrap.getBoundingClientRect() : null;
  const tr = tbl ? tbl.getBoundingClientRect() : null;
  return JSON.stringify({
    filterFormH: filterH,
    visibleItems: items.length,
    activeTab: (pane.querySelector('.ant-tabs-tab-active')?.innerText || document.querySelector('.ant-tabs-tab-active')?.innerText || '').replace(/\s+/g, ''),
    thead,
    hasCreatedAtCol: thead.includes('创建日期'),
    hasOpCol: thead.includes('操作'),
    opBtns,
    opVisible: (wr && opCell) ? (opCell.getBoundingClientRect().right <= wr.left + wrap.clientWidth + 1) : null,
    tableW: tr ? Math.round(tr.width) : null,
    wrapW: wr ? Math.round(wr.width) : null,
    filterBtnsInPane,
    filterBtnsGlobalCount: filterBtnsGlobal.length,
    moreBtn: moreBtn || null,
    statusText: cells[2] ? (cells[2].innerText || '').trim() : null,
  }, null, 1);
})()`;

const report = [];
for (const t of TABS) {
  const c = await clickTab(t.title);
  await sleep(2200);
  let m = await ev(METRICS);
  // 再点一次「更多条件」看展开态（截图只拍收起态，数据两态都留）
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const b64 = shot?.result?.data;
  let file = null;
  let sha = null;
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    file = path.join(OUT, `r211-final-${t.key}.png`);
    fs.writeFileSync(file, buf);
    sha = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  }
  report.push({ tab: t.title, click: c, metrics: JSON.parse(m), shot: file, bytes: b64 ? Buffer.from(b64, 'base64').length : 0, sha });
  console.log(`── ${t.title} (${c}) ──`);
  console.log(m);
}
fs.writeFileSync(path.join(OUT, 'r211-final-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('\n报告：' + path.join(OUT, 'r211-final-report.json'));
done(0);
