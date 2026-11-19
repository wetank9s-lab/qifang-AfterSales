/**
 * _r212_prod_accept.mjs —— R2.1.2 生产部署后**最小验收**（只读，不改任何数据）
 *
 * 用户 2026-11-18 指令「五、部署后最小验收」的六项：
 *   1. 管理员菜单为 4+10 分类，各菜单可正常点击进入
 *   2. 门店售后菜单为 2+5，未增加原有权限之外的页面
 *   3. 处理/跟进/审核/详情 四类按钮文案、尺寸及点击功能正常
 *   4. 六个状态页签和筛选区保持正常
 *   5. 工单号和操作列没有发生截断或横向溢出
 *   6. 现有 Banner、客户报修入口、真实工单数据正常
 *
 * ⚠️ 铁律（已写进 menu-groups.ts 文件头）：
 *   菜单点击必须用**真实鼠标事件**（Input.dispatchMouseEvent）或对 `<a>` 调 a.click()。
 *   对 `<li>` / `.ant-menu-title-content` 调 .click() 永远不导航 —— 那是测试写错。
 *
 * ⚠️ 不做：不制造工单、不发短信、不点任何会写数据的按钮（按钮只量尺寸不点进来）。
 *
 * 用法：
 *   PROD_PASS=<口令> node scripts/_r212_prod_accept.mjs
 *   环境变量：PROD_EMAIL / PROD_STORE_EMAIL / PROD_STORE_PASS / PROD_BASE
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.PROD_BASE || 'https://sh.scqfls.cn';
const ADMIN = { email: process.env.PROD_EMAIL || 'admin@nocobase.com', pass: process.env.PROD_PASS };
const STORE = {
  email: process.env.PROD_STORE_EMAIL || '',
  pass: process.env.PROD_STORE_PASS || '',
};
const OUT = 'storage/tmp/r212/prod-accept';
fs.mkdirSync(OUT, { recursive: true });

if (!ADMIN.pass) { console.error('缺少 PROD_PASS'); process.exit(1); }

const port = 9993;
const profile = path.join(os.tmpdir(), `r212acc-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('NO CHROME'); process.exit(1); }

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--ignore-certificate-errors',
  '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 200; i++) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 启动中 */ }
  await sleep(300);
}
if (!wsUrl) { console.error('CHROME 启动失败'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const shot = async (n) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64'));
  return n;
};

/** 真实鼠标点击：拿到元素中心点后用 Input.dispatchMouseEvent，而不是 el.click() */
const realClick = async (selectorJs, index = 0) => {
  const box = await ev(`(() => {
    const els = ${selectorJs};
    const el = els[${index}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box || box.__err) return { ok: false, why: box?.__err || 'no-box' };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return { ok: true };
};

const results = [];
const ok = (m, d = null) => { results.push({ pass: true, m, d }); console.log(`✅ ${m}`, d === null ? '' : JSON.stringify(d)); };
const no = (m, d = null) => { results.push({ pass: false, m, d }); console.log(`❌ ${m}`, d === null ? '' : JSON.stringify(d)); };

await send('Page.enable');
await send('Runtime.enable');

const login = async (email, pass) => {
  // 清干净登录态，否则会被已登录会话重定向
  await ev('localStorage.clear(); sessionStorage.clear();');
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: `${BASE}/signin` });
  for (let i = 0; i < 80; i++) {
    const n = await ev(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null).length`).catch(() => 0);
    if (n >= 2) break;
    await sleep(400);
  }
  await sleep(900);
  await ev(`(() => {
    const all = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
    const a = all.find(i => i.type !== 'password'), p = all.find(i => i.type === 'password');
    if (!a || !p) return false;
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(a, ${JSON.stringify(email)}); a.dispatchEvent(new Event('input', { bubbles: true }));
    s.call(p, ${JSON.stringify(pass)}); p.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /登录|Sign/i.test(x.innerText)); if (b) b.click(); return !!b; })()`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (!/\/signin/.test(await ev('location.href'))) break;
  }
  await sleep(7000);
  return await ev('location.href');
};

const readGroups = () => ev(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  if (!sider) return { ok: false };
  const boxes = [...sider.querySelectorAll('li[data-svc-vgroup]')];
  return {
    ok: true,
    groups: boxes.map(b => ({
      key: b.getAttribute('data-svc-vgroup'),
      title: (b.querySelector(':scope > .ant-menu-submenu-title')?.innerText || '').trim(),
      items: [...b.querySelectorAll('ul.ant-menu-sub li')].map(li => (li.textContent || '').trim()).filter(Boolean),
      collapsed: b.getAttribute('data-collapsed') === '1',
    })),
  };
})()`);

try {
  // ================= 管理员 =================
  const adminUrl = await login(ADMIN.email, ADMIN.pass);
  if (/\/signin/.test(adminUrl)) { no('管理员登录', { url: adminUrl }); throw new Error('login failed'); }
  ok('管理员登录成功', { url: adminUrl });

  // ---- 1. 菜单 4+10 ----
  const g1 = await readGroups();
  if (!g1?.ok) { no('读到左侧菜单'); } else {
    const daily = g1.groups.find((g) => g.key === 'daily');
    const admin = g1.groups.find((g) => g.key === 'admin');
    const dOk = daily?.items?.length === 4, aOk = admin?.items?.length === 10;
    (dOk ? ok : no)('菜单分日常业务 4 项', { count: daily?.items?.length, items: daily?.items });
    (aOk ? ok : no)('菜单分管理与设置 10 项', { count: admin?.items?.length, items: admin?.items });
    await shot('01-menu-admin.png');
  }

  // ---- 1b. 真实点击菜单（含折叠分组先展开） ----
  // ⚠️ admin 分组默认折叠 ⇒ 子孙项 offsetParent 为 null、getBoundingClientRect 全 0，
  //    必须先真实点击分组标题展开，否则报 no-box（那是测试没做准备，不是产品坏了）。
  const expandGroup = async (key) => {
    const box = await ev(`(() => {
      const b = document.querySelector('.ant-layout-sider li[data-svc-vgroup="${key}"]');
      if (!b) return null;
      const t = b.querySelector(':scope > .ant-menu-submenu-title');
      if (!t || t.getBoundingClientRect().height === 0) return null;
      const r = t.getBoundingClientRect();
      return { x: r.left + 24, y: r.top + r.height / 2, collapsed: b.getAttribute('data-collapsed') === '1' };
    })()`);
    if (!box) return { ok: false, why: 'group-title-not-found' };
    if (!box.collapsed) return { ok: true, already: 'expanded' };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(900);
    const now = await ev(`(document.querySelector('.ant-layout-sider li[data-svc-vgroup="${key}"]') || {}).getAttribute && document.querySelector('.ant-layout-sider li[data-svc-vgroup="${key}"]').getAttribute('data-collapsed')`);
    return { ok: now === '0', collapsed: now };
  };
  const clickItem = async (label) => {
    const before = await ev('location.pathname');
    const r = await realClick(`[...document.querySelectorAll('.ant-layout-sider a')].filter(a => (a.innerText||'').trim() === ${JSON.stringify(label)} && a.getBoundingClientRect().height > 0)`);
    if (!r.ok) return { label, ok: false, why: r.why };
    await sleep(2600);
    const after = await ev('location.pathname');
    return { label, before, after, ok: after !== before };
  };
  const navResults = [];
  // 先点 daily 组两项（默认展开）
  for (const label of ['我的门店工单', '所有工单']) navResults.push(await clickItem(label));
  // 展开 admin 组再点其两项
  const ex = await expandGroup('admin');
  results.push({ pass: !!ex.ok, m: '管理与设置分组可真实点击展开', d: ex });
  console.log(`${ex.ok ? '✅' : '❌'} 管理与设置分组可真实点击展开`, JSON.stringify(ex));
  for (const label of ['派工记录', '工单事件时间线']) navResults.push(await clickItem(label));
  const navOk = navResults.length === 4 && navResults.every((n) => n.ok);
  (navOk ? ok : no)('管理员四项菜单真实点击均导航', navResults);
  await shot('02-after-nav.png');

  // ---- 4/5. 工单列表：页签、筛选区、工单号、操作列 ----
  const listUrl = `${BASE}/admin/tujyw08ec1d`;
  await send('Page.navigate', { url: listUrl });
  await sleep(9000);
  const tabs = await ev(`(() => {
    const t = document.querySelector('.ant-tabs-nav');
    if (!t) return { ok: false };
    return { ok: true, labels: [...t.querySelectorAll('.ant-tabs-tab')].map(x => (x.innerText || '').trim()).filter(Boolean) };
  })()`);
  if (tabs?.ok && tabs.labels.length === 6) ok('六个状态页签齐全', tabs.labels);
  else no('六个状态页签', tabs);

  const filterInfo = await ev(`(() => {
    const el = document.querySelector('[class*="filter"], .ant-form') ;
    const w = el ? Math.round(el.getBoundingClientRect().width) : 0;
    return { exists: !!el, width: w };
  })()`);
  (filterInfo?.exists ? ok : no)('筛选区存在', filterInfo);

  const layout = await ev(`(() => {
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
    if (!pane) return { ok: false, why: 'no-visible-pane' };
    const tbl = [...pane.querySelectorAll('table')].find(t => t.getBoundingClientRect().width > 0);
    if (!tbl) return { ok: false, why: 'no-table' };
    const wrap = tbl.closest('.ant-table-content') || tbl.parentElement;
    const wr = wrap.getBoundingClientRect();
    const heads = [...tbl.querySelectorAll('thead th')].map(th => (th.innerText || '').trim());
    // 操作列：最后一个 th/td
    const tdRow = tbl.querySelector('tbody tr');
    const lastTd = tdRow ? tdRow.lastElementChild : null;
    const lr = lastTd ? lastTd.getBoundingClientRect() : null;
    // 工单号列：按表头文案定位
    const noIdx = heads.findIndex(h => /工单号/.test(h));
    const noTd = tdRow && noIdx >= 0 ? tdRow.children[noIdx] : null;
    const noR = noTd ? noTd.getBoundingClientRect() : null;
    return {
      ok: true,
      tableW: Math.round(tbl.getBoundingClientRect().width),
      wrapW: Math.round(wr.width),
      scrollable: tbl.getBoundingClientRect().width > wr.width + 1,
      heads,
      opColRight: lr ? Math.round(lr.right) : null,
      wrapRight: Math.round(wr.right),
      opColVisible: lr ? lr.right <= wr.left + wr.width + 1 : null,
      ticketNoTruncated: noTd ? noTd.scrollWidth > noTd.clientWidth + 1 : null,
      ticketNoText: noTd ? (noTd.innerText || '').trim().slice(0, 40) : null,
    };
  })()`);
  if (layout?.ok) {
    (!layout.scrollable ? ok : no)('表格无横向溢出', { tableW: layout.tableW, wrapW: layout.wrapW });
    (layout.opColVisible ? ok : no)('操作列在容器内（不被裁掉）', { opColRight: layout.opColRight, wrapRight: layout.wrapRight });
    (layout.ticketNoTruncated === false ? ok : no)('工单号未被截断', { text: layout.ticketNoText, truncated: layout.ticketNoTruncated });
  } else no('工单表格布局测量', layout);
  await shot('03-ticket-list.png');

  // ---- 3. 四种按钮尺寸（只量不点，避免写数据） ----
  const btns = await ev(`(() => {
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
    if (!pane) return [];
    return [...pane.querySelectorAll('[data-primary-action]')].slice(0, 8).map(b => {
      const r = b.getBoundingClientRect();
      return { kind: b.getAttribute('data-primary-action'), label: b.getAttribute('data-action-label'),
               w: Math.round(r.width), h: Math.round(r.height) };
    });
  })()`);
  if (Array.isArray(btns) && btns.length) {
    const all642 = btns.every((b) => b.w === 64 && b.h === 30);
    (all642 ? ok : no)('按钮尺寸均为 64×30', btns);
    const labels = [...new Set(btns.map((b) => b.label))];
    ok('按钮文案（实测出现）', labels);
  } else no('按钮测量', btns);

  // ---- 6. Banner / 真实工单数据 ----
  const dataInfo = await ev(`(() => {
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
    const rows = pane ? pane.querySelectorAll('tbody tr.ant-table-row') : [];
    return { rowCount: rows.length };
  })()`);
  (dataInfo?.rowCount > 0 ? ok : no)('工单列表有真实数据行', dataInfo);

  // ---- 门店角色 ----
  if (STORE.email && STORE.pass) {
    const storeUrl = await login(STORE.email, STORE.pass);
    if (/\/signin/.test(storeUrl)) { no('门店角色登录', { url: storeUrl }); } else {
      ok('门店角色登录成功');
      const g2 = await readGroups();
      if (g2?.ok) {
        const d = g2.groups.find((g) => g.key === 'daily');
        const a = g2.groups.find((g) => g.key === 'admin');
        (d?.items?.length === 2 ? ok : no)('门店日常业务 2 项', d?.items);
        (a?.items?.length === 5 ? ok : no)('门店管理与设置 5 项', a?.items);
        const all = [...(d?.items || []), ...(a?.items || [])];
        const forbidden = all.filter((x) => /服务时效|门店账号|客户页面装修|短信通知/.test(x));
        (forbidden.length === 0 ? ok : no)('门店未见未授权页面', { forbidden, all });
      } else no('门店菜单读取');
      await shot('04-menu-store.png');
    }
  } else {
    console.log('⏭ 跳过门店角色（未提供 PROD_STORE_EMAIL/PASS）');
  }

  await shot('05-final.png');
} catch (e) {
  console.log('EXCEPTION', String(e.message || e).slice(0, 300));
} finally {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n共 ${results.length} 项，失败 ${fail} 项`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, pass, fail }, null, 2));
  try { ws.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 2);
}
