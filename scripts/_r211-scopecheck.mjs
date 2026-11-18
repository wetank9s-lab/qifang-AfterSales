// _r211-scopecheck.mjs —— R2.1.1 确认 1：CSS 作用域的正反两向取证
//
// 用户原话：
//   「确认新 CSS 仅作用于本次工单列表区域，不全局覆写其他 Ant Design 表格的宽度规则。
//     在 1440px 下确认操作按钮、创建日期、工单状态完整可见，长文本正常省略且可以通过详情查看。」
//
// 本脚本给三件事：
//   ① 工单列表页：表格是否被标记 data-svc-ticket-list、tblW 是否 == wrapW、操作列按钮数；
//   ② 一张**非**工单列表的含表格页面：同一批规则是否命中（反向证明「不全局覆写」）；
//   ③ 样式表里所有「表格宽度」选择器的实际命中集合（getMatchedRules 语义 + matches() 反查）。
//
// ⚠️ 判定必须双向：只证明「工单列表被改了」不能排除「别的表也被改了」。
//
// 用法：node scripts/_r211-scopecheck.mjs [工单列表uid] [对照uid]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LIST_UID = process.argv[2] || 'tujyw08ec1d';
// 对照页：历史档案（含表格，且**不是**工单列表）。没有的话也会退化成「全站扫一遍」。
const OTHER_UID = process.argv[3] || 'wcsgqh8e71w';  // 历史售后档案：含表格，但不是工单列表

const tokFile = 'storage/tmp/r211/.tok_uat_hqadmin';
const tok = fs.readFileSync(tokFile, 'utf8').trim();
const port = 9973;
const profile = path.join(os.tmpdir(), `r211sc-${Date.now()}`);
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

// ---------------------------------------------------------------- 页面探针
// 在页面上下文里执行：给当前 document 里所有表格出一份「是否被本插件表格规则命中」的报告。
const PROBE = `(() => {
  const RULES = [
    { name: 'table-layout:fixed', sel: '[data-svc-ticket-list] table' },
    { name: 'colgroup col:auto',  sel: '[data-svc-ticket-list] table colgroup > col' },
  ];
  const tables = [...document.querySelectorAll('table')];
  return JSON.stringify(tables.map((t, i) => {
    const wrap = t.closest('.ant-table-content') || t.closest('.ant-table-container') || t.parentElement;
    const thead = [...t.querySelectorAll('thead th')].map((x) => (x.innerText || '').replace(/\\s+/g, '').trim());
    const row = t.querySelector('tbody tr.ant-table-row');
    // 注意：末列是 antd 的 12px 占位列（class 无内容），真正的「操作」列是最后一个**有内容**的 td
    const tds = row ? [...row.children] : [];
    const lastTd = tds.reverse().find((c) => (c.innerText || '').trim() || c.querySelector('button')) || null;
    const markerBox = t.closest('[data-svc-ticket-list]');
    const cs = wrap ? getComputedStyle(wrap) : null;
    const tcs = getComputedStyle(t);
    const ruleHits = RULES.filter((r) => { try { return !!t.matches(r.sel) || !!t.querySelector(r.sel.replace(/^.*?\\s(?=\\.)/, '')); } catch { return false; } });
    return {
      i,
      thead,
      isTicketList: !!markerBox,
      markerTag: markerBox ? markerBox.tagName + '.' + (markerBox.className || '').split(' ')[0] : null,
      tblW: Math.round(t.getBoundingClientRect().width),
      wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
      wrapScrollW: wrap ? wrap.scrollWidth : null,
      tableLayout: tcs.tableLayout,
      colWidths: [...t.querySelectorAll('colgroup col')].slice(0, 3).map((c) => c.style.width || '(auto)'),
      overflowX: cs ? cs.overflowX : null,
      lastCellBtns: lastTd ? lastTd.querySelectorAll('button').length : 0,
      lastCellTxt: lastTd ? (lastTd.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) : '',
    };
  }), null, 1);
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(4000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});true`);
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(13000);
if (String(await ev('location.pathname')).includes('signin')) { console.log('LOGIN FAILED'); done(2); }

const visit = async (uid) => {
  const target = uid.startsWith('/') ? uid : '/admin/' + uid;
  await ev(`history.pushState({},'',${JSON.stringify(target)});window.dispatchEvent(new PopStateEvent('popstate'));true`);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const n = Number(await ev("document.querySelectorAll('table thead th').length"));
    if (n > 0) break;
  }
  await sleep(1200);
  return await ev(PROBE);
};

console.log('══ ① 工单列表页 ' + LIST_UID + ' ══');
console.log(await visit(LIST_UID));

if (OTHER_UID) {
  console.log('\n══ ② 对照页（非工单列表） ' + OTHER_UID + ' ══');
  console.log(await visit(OTHER_UID));
}

console.log('\n══ ③ 页面上「表格宽度」两条规则的命中统计 ══');
console.log(await ev(`(() => {
  const sels = {
    'table-layout:fixed': '[data-svc-ticket-list] table',
    'colgroup col:auto':  '[data-svc-ticket-list] table colgroup > col',
  };
  const out = {};
  for (const [k, s] of Object.entries(sels)) {
    try { out[k] = document.querySelectorAll(s).length; } catch (e) { out[k] = 'ERR ' + e.message; }
  }
  out['页面上 table 总数'] = document.querySelectorAll('table').length;
  out['带标记的容器数'] = document.querySelectorAll('[data-svc-ticket-list]').length;
  // 反向：全站有没有"本不该被标记"却被标记的容器（判据要求 thead 同时含 工单号+工单状态）
  out['误标嫌疑'] = [...document.querySelectorAll('[data-svc-ticket-list]')]
    .filter((b) => {
      const t = b.querySelector('table'); if (!t) return true;
      const h = [...t.querySelectorAll('thead th')].map((x) => (x.innerText||'').replace(/\\s+/g,'').trim());
      return !(h.includes('工单号') && h.includes('状态'));
    }).length;
  return JSON.stringify(out, null, 1);
})()`));

done(0);
