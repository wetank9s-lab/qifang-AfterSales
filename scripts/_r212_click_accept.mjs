/**
 * _r212_click_accept.mjs —— R2.1.2 真实点击验收（用户指令 四）
 *
 * ⚠️ 铁律（本轮踩过并已写入 menu-groups.ts 文件头）：
 *   菜单点击**必须**用真实鼠标事件（Input.dispatchMouseEvent pressed/released），
 *   或对 `<a>` 调 a.click()。对 `<li>` / `.ant-menu-title-content` 调 .click()
 *   **永远不导航**（React 事件目标不是 <a>），那不是产品缺陷。
 *
 * 验收项：
 *   1. 管理员点「我的门店工单」→ 导航
 *   2. 管理员点「所有工单」→ 导航
 *   3. 展开「管理与设置」，点「派工记录」「工单事件时间线」→ 导航
 *   4. 前进/后退/刷新后菜单可用，当前页高亮正确
 *   5. 门店售后角色只能打开原本已授权的页
 *   6. 四种按钮仍 64×30，点击功能不变
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.SVC_BASE || 'http://127.0.0.1:13000';
const OUT = 'storage/tmp/r212/click';
fs.mkdirSync(OUT, { recursive: true });

// 🔴 口令一律从环境变量取，**不入库**（本仓库是 public）。
//    取法：.env 里的 UAT_HQADMIN_PASSWORD / UAT_STORE_A_PASSWORD，
//    或临时 export R212_PASS=<口令>（本地 UAT 账号共用同一口令）。
const PASS = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!PASS) { console.error('缺少口令：export R212_PASS=<本地 UAT 口令>'); process.exit(1); }
const ROLES = {
  admin: { email: process.env.R212_ADMIN || 'uat.hqadmin@svc.local', pass: PASS },
  store: { email: process.env.R212_STORE || 'uat.r211.store@svc.local', pass: PASS },
};

const port = 9997;
const profile = path.join(os.tmpdir(), `r212click-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('NO CHROME'); process.exit(1); }

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 200; i++) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* */ }
  await sleep(300);
}
if (!wsUrl) { console.error('NO CDP'); process.exit(1); }

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

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const shot = async (n) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64'));
};

const R = { at: new Date().toISOString(), base: BASE, checks: [], steps: [] };
const chk = (name, ok, detail) => {
  R.checks.push({ name, ok: !!ok, detail });
  const d = detail === undefined ? '' : JSON.stringify(detail);
  console.log(`${ok ? '✅' : '❌'} ${name}${d ? '  ' + d : ''}`);
};

async function login(acc, pass) {
  // ⚠️ 先清掉上一个账号的登录态：直接 navigate 到 /signin 会被已登录会话**重定向走**，
  //    于是"门店角色"这一轮实际还是管理员，后面的断言全错（本轮踩过）。
  await send('Page.navigate', { url: `${BASE}/signin` });
  await sleep(1500);
  await ev(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true; })()`);
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
    s.call(a, ${JSON.stringify(acc)}); a.dispatchEvent(new Event('input', { bubbles: true }));
    s.call(p, ${JSON.stringify(pass)}); p.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /登录/.test(x.innerText)); if (b) b.click(); return !!b; })()`);
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    if (!/\/signin/.test(await ev('location.href'))) break;
  }
  await sleep(5500);
  return !/\/signin/.test(await ev('location.href'));
}

/** 真实鼠标点击某个菜单项的可见文字区域 */
async function realClickMenu(title) {
  const box = await ev(`(() => {
    const sider = document.querySelector('.ant-layout-sider');
    if (!sider) return { err: 'no-sider' };
    const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(title)});
    if (!li) {
      return { err: 'not-found', avail: [...sider.querySelectorAll('li')].map(x => (x.textContent||'').trim()).filter(Boolean) };
    }
    const t = li.querySelector('.ant-menu-title-content') || li;
    const r = t.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { err: 'zero-size' };
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
  })()`);
  if (box?.err) return { ok: false, ...box };

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(3600);
  return { ok: true };
}

/** 把「管理与设置」通过**真实鼠标**展开（如果已折叠） */
async function expandAdmin() {
  const info = await ev(`(() => {
    const box = document.querySelector('li[data-svc-vgroup="admin"]');
    if (!box) return { err: 'no-admin-group' };
    if (box.getAttribute('data-collapsed') !== '1') return { already: true };
    const head = box.querySelector(':scope > .ant-menu-submenu-title');
    const r = head.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
  })()`);
  if (info?.err) return info;
  if (info?.already) return { ok: true, already: true };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
  await sleep(1400);
  const collapsed = await ev(`document.querySelector('li[data-svc-vgroup="admin"]')?.getAttribute('data-collapsed')`);
  return { ok: collapsed === '0', collapsed };
}

// =====================================================================
// 管理员
// =====================================================================
chk('管理员登录成功', await login(ROLES.admin.email, ROLES.admin.pass), null);

// ---- 1/2. 我的门店工单、所有工单 ----
for (const [idx, title] of [[1, '我的门店工单'], [2, '所有工单']]) {
  const before = await ev('location.href');
  const click = await realClickMenu(title);
  const after = await ev('location.href');
  R.steps.push({ role: 'admin', title, before, after, click });
  chk(`管理员点「${title}」导航成功`, click.ok && before !== after, { before: before.replace(BASE, ''), after: after.replace(BASE, '') });
  await shot(`admin-${idx}-${title}.png`);
}

// ---- 3. 展开管理与设置，点派工记录 / 工单事件时间线 ----
const exp = await expandAdmin();
chk('「管理与设置」可通过点击展开', exp.ok, exp);
await shot('admin-admin-expanded.png');

for (const [idx, title] of [[1, '派工记录'], [2, '工单事件时间线']]) {
  const before = await ev('location.href');
  const click = await realClickMenu(title);
  const after = await ev('location.href');
  R.steps.push({ role: 'admin', title, before, after, click });
  chk(`管理员点「${title}」导航成功`, click.ok && before !== after, { before: before.replace(BASE, ''), after: after.replace(BASE, '') });
  await shot(`admin-3-${idx}-${title}.png`);
}

// ---- 4. 前进 / 后退 / 刷新 后菜单仍可用，高亮正确 ----
// 先回到「我的门店工单」，再点「所有工单」，形成有历史的一对
await realClickMenu('我的门店工单');
const urlA = await ev('location.href');
await expandAdmin();
await realClickMenu('所有工单');
const urlB = await ev('location.href');

// 后退
await ev('history.back()');
await sleep(4000);
const urlBack = await ev('location.href');
const hiliteBack = await ev(`(() => {
  const sel = document.querySelector('.ant-layout-sider li.ant-menu-item-selected');
  return sel ? (sel.textContent||'').trim() : null;
})()`);
chk('浏览器后退回到上一页', urlBack === urlA, { expect: urlA.replace(BASE, ''), got: urlBack.replace(BASE, '') });
chk('后退后菜单高亮 = 我的门店工单', hiliteBack === '我的门店工单', { hilite: hiliteBack });

// 前进
await ev('history.forward()');
await sleep(4000);
const urlFwd = await ev('location.href');
const hiliteFwd = await ev(`(() => {
  const sel = document.querySelector('.ant-layout-sider li.ant-menu-item-selected');
  return sel ? (sel.textContent||'').trim() : null;
})()`);
chk('浏览器前进回到下一页', urlFwd === urlB, { expect: urlB.replace(BASE, ''), got: urlFwd.replace(BASE, '') });
chk('前进后菜单高亮 = 所有工单', hiliteFwd === '所有工单', { hilite: hiliteFwd });
await shot('admin-4-after-history.png');

// 刷新（整页 reload）后菜单仍可点、分组仍在、高亮正确
await send('Page.reload');
await sleep(9000);
const afterReloadUrl = await ev('location.href');
const hiliteReload = await ev(`(() => {
  const sel = document.querySelector('.ant-layout-sider li.ant-menu-item-selected');
  return sel ? (sel.textContent||'').trim() : null;
})()`);
chk('刷新后停留在原页面', afterReloadUrl === urlB, { expect: urlB.replace(BASE, ''), got: afterReloadUrl.replace(BASE, '') });
chk('刷新后菜单高亮正确', hiliteReload === '所有工单', { hilite: hiliteReload });

const groupsAfterReload = await ev(`(() => {
  const boxes = [...document.querySelectorAll('.ant-layout-sider li[data-svc-vgroup]')];
  return boxes.map(b => ({
    key: b.getAttribute('data-svc-vgroup'),
    title: (b.querySelector(':scope > .ant-menu-submenu-title')?.innerText||'').trim(),
    count: b.querySelectorAll('ul.ant-menu-sub li').length,
    collapsed: b.getAttribute('data-collapsed') === '1',
  }));
})()`);
chk('刷新后分组仍为 4+10', (() => {
  const d = groupsAfterReload.find(g => g.key === 'daily');
  const a = groupsAfterReload.find(g => g.key === 'admin');
  return d && a && d.count === 4 && a.count === 10;
})(), groupsAfterReload.map(g => `${g.key}:${g.count}${g.collapsed ? '(折叠)' : ''}`));

// 刷新后再真实点一次（证明确实还能用）
const reopen = await realClickMenu('售后服务工作台');
const urlReopen = await ev('location.href');
chk('刷新后仍可真实点击菜单导航', reopen.ok && urlReopen !== afterReloadUrl, { after: urlReopen.replace(BASE, '') });
await shot('admin-4-after-reload.png');

// ---- 6. 四种按钮 64×30 + 点击功能 ----
await send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
await sleep(7000);

const btnSpec = [];
for (const tabName of ['待处理', '处理中', '待门店确认', '已结束']) {
  await ev(`(() => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => (x.innerText||'').trim() === ${JSON.stringify(tabName)});
    if (t) t.click(); return !!t;
  })()`);
  await sleep(2800);
  const spec = await ev(`(() => {
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
    const sc = pane || document;
    let b = null;
    for (const t of sc.querySelectorAll('table')) {
      for (const tr of t.querySelectorAll('tbody tr')) {
        const c = tr.querySelector('[data-primary-action]');
        if (c) { b = c; break; }
      }
      if (b) break;
    }
    if (!b) return { ok: false };
    const r = b.getBoundingClientRect();
    return { ok: true, kind: b.getAttribute('data-primary-action'), text: (b.innerText||'').trim(),
             w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10, title: b.getAttribute('title') };
  })()`);
  if (spec.ok) btnSpec.push(spec);
}
chk('四种按钮均 64×30', btnSpec.length === 4 && btnSpec.every(b => b.w === 64 && b.h === 30),
  btnSpec.map(b => `${b.text}:${b.w}x${b.h}`));

// 点击功能：每种按钮点一次，看是否进入对应区域
const clickResults = [];
for (const tabName of ['待处理', '处理中', '待门店确认', '已结束']) {
  await ev(`(() => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => (x.innerText||'').trim() === ${JSON.stringify(tabName)});
    if (t) t.click(); return !!t;
  })()`);
  await sleep(2600);
  const kind = await ev(`(() => {
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
    const sc = pane || document;
    for (const t of sc.querySelectorAll('table')) {
      for (const tr of t.querySelectorAll('tbody tr')) {
        const c = tr.querySelector('[data-primary-action]');
        if (c) {
          c.click();
          return { kind: c.getAttribute('data-primary-action'), text: (c.innerText||'').trim() };
        }
      }
    }
    return null;
  })()`);
  await sleep(2800);
  const shown = await ev(`(() => {
    const modals = [...document.querySelectorAll('.ant-modal-wrap')].filter(m => m.getBoundingClientRect().width > 0);
    const drawers = [...document.querySelectorAll('.ant-drawer-content')].filter(d => d.getBoundingClientRect().width > 0);
    return {
      modal: modals.length,
      modalTitle: modals.length ? (modals[0].querySelector('.ant-modal-title')?.innerText||'').trim() : null,
      drawer: drawers.length,
      drawerTitle: drawers.length ? (drawers[0].querySelector('.ant-drawer-title')?.innerText||'').trim() : null,
    };
  })()`);
  clickResults.push({ tab: tabName, kind, shown });
  await shot(`admin-6-click-${tabName}.png`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(1000);
}
const okClicks =
  clickResults.find(c => c.kind?.kind === 'handle')?.shown.modal >= 1 &&
  clickResults.find(c => c.kind?.kind === 'follow')?.shown.modal >= 1 &&
  clickResults.find(c => c.kind?.kind === 'review')?.shown.drawer >= 1 &&
  clickResults.find(c => c.kind?.kind === 'view')?.shown.drawer >= 1;
chk('四种按钮点击功能未退化', okClicks, clickResults.map(c => `${c.kind?.text}→${c.shown.modal ? 'modal' : c.shown.drawer ? 'drawer' : 'nothing'}`));
R.clickResults = clickResults;
R.btnSpec = btnSpec;

// =====================================================================
// 门店售后角色（指令 5）
// =====================================================================
chk('门店角色登录成功', await login(ROLES.store.email, ROLES.store.pass), null);

const storeMenu = await ev(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  const boxes = [...sider.querySelectorAll('li[data-svc-vgroup]')];
  return boxes.map(b => ({
    key: b.getAttribute('data-svc-vgroup'),
    title: (b.querySelector(':scope > .ant-menu-submenu-title')?.innerText||'').trim(),
    items: [...b.querySelectorAll('ul.ant-menu-sub li')].map(li => (li.textContent||'').trim()).filter(Boolean),
  }));
})()`);
R.storeMenu = storeMenu;
await shot('store-menu.png');

// 门店角色只应看到：日常业务 2 项（工作台、我的门店工单）+ 管理与设置 5 项
const storeDaily = storeMenu.find(g => g.key === 'daily');
const storeAdmin = storeMenu.find(g => g.key === 'admin');
chk('门店角色看到的分组只含已授权页',
  !!storeDaily && !!storeAdmin &&
  storeDaily.items.length === 2 &&
  storeAdmin.items.length === 5,
  storeMenu.map(g => `${g.key}:${g.items.length}[${g.items.join('|')}]`));

// 逐个真实点击门店角色菜单项，全部必须能导航
const storeExp = await expandAdmin();
const storeClicks = [];
for (const t of (storeDaily?.items || []).concat(storeAdmin?.items || [])) {
  const before = await ev('location.href');
  const click = await realClickMenu(t);
  const after = await ev('location.href');
  // ⚠️ 「点完后 URL 没变」有两种含义，必须分开：
  //    ① 点的是**当前正在看的页** ⇒ URL 不变是**正确**行为（导航到同一路由不会再变）；
  //    ② 点的是**别的页**却没变 ⇒ 才是真缺陷。
  //    只判 `before !== after` 会把门店登录后的默认落地页（售后服务工作台）误报成 FAIL。
  const selBefore = await ev(`(() => {
    const s = document.querySelector('.ant-layout-sider li.ant-menu-item-selected');
    return s ? (s.textContent||'').trim() : null;
  })()`);
  const sameAsCurrent = t === selBefore && before === after;
  storeClicks.push({
    title: t,
    before: before.replace(BASE, ''),
    after: after.replace(BASE, ''),
    alreadyOnThisPage: sameAsCurrent,
    ok: click.ok && (before !== after || sameAsCurrent),
  });
  await sleep(300);
}
chk('门店角色每个授权菜单项都能真实点击导航',
  storeClicks.length > 0 && storeClicks.every(c => c.ok),
  storeClicks.map(c => `${c.title}:${c.ok ? (c.alreadyOnThisPage ? 'OK(当前页)' : 'OK') : 'FAIL'}`));
R.storeClicks = storeClicks;
await shot('store-after-clicks.png');

// 反向：未授权页必须不在它的可访问集合里
// ⚠️ localStorage 里存的是**裸 JWT**，不是 JSON 对象；按 JSON.parse 会抛
//    "Unexpected token 'e'"（eyJhbGciOi... 是 JWT 头）。本轮踩过一次。

// 反向：未授权页必须不在它的可访问集合里
// ⚠️ localStorage 存的是**裸 JWT**，不是 JSON 对象；按 JSON.parse 会抛
//    "Unexpected token 'e'"（eyJhbGciOi... 是 JWT 头）。本轮踩过一次。
const forbidden = await ev(`(async () => {
  const raw = localStorage.getItem('NOCOBASE_TOKEN') || '';
  const token = raw.startsWith('{') ? (JSON.parse(raw).token || '') : raw;
  if (!token) return { err: 'no-token', rawHead: raw.slice(0, 20) };
  const r = await fetch('/api/desktopRoutes:listAccessible?paginate=false&tree=true', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const j = await r.json().catch(() => null);
  const titles = [];
  const walk = (ns) => { for (const n of ns || []) { if (n?.title) titles.push(String(n.title).trim()); if (n?.children) walk(n.children); } };
  walk(j?.data || []);
  return { status: r.status, titles };
})()`);
chk('门店角色未获授权「服务时效」/「门店账号」',
  Array.isArray(forbidden?.titles) &&
    forbidden.titles.length > 0 &&
    !forbidden.titles.includes('服务时效') &&
    !forbidden.titles.includes('门店账号'),
  { status: forbidden?.status, count: forbidden?.titles?.length,
    hasServiceSla: forbidden?.titles?.includes?.('服务时效'),
    hasStoreAccount: forbidden?.titles?.includes?.('门店账号') });
R.storeAccessible = forbidden;

// =====================================================================
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(R, null, 2));
const failed = R.checks.filter(c => !c.ok);
console.log('\n=== 汇总 ===');
console.log(`共 ${R.checks.length} 项，失败 ${failed.length} 项`);
if (failed.length) console.log('失败:', failed.map(f => f.name).join(' / '));
console.log('报告:', path.join(OUT, 'report.json'));

ws.close();
try { child.kill(); } catch {}
process.exit(failed.length ? 1 : 0);
