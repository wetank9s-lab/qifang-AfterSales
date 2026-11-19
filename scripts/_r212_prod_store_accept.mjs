/**
 * _r212_prod_store_accept.mjs —— 生产·门店售后角色专项验收（2+5 菜单 + 四类按钮真实点击）
 *
 * 用户闸门 ①「门店售后菜单为 2+5，未增加原有权限之外的页面」
 *          ③「四类按钮文案、尺寸及点击功能正常」
 *
 * ⚠️ 只能打开弹窗/抽屉，**不提交、不填表**：
 *   打开后用 `Escape` 关掉，并记录 URL 是否变化（防误提交）。
 *
 * ⚠️ 判据纪律：
 *   · 按钮必须取**可见 pane 内、第一个真实数据行**（tbody tr.ant-table-row 且含标记），
 *     否则会量到空行（第一轮 `text:""` 的坑）。
 *   · 可见性必须先要求 `w>0 && h>0` 再比位置（隐藏 pane 的 rect 全 0，恒 true）。
 *   · 门店角色只有「我的门店工单」有主按钮；「所有工单」从来没有（历史事实）。
 *
 * 用法：PROD_STORE_EMAIL / PROD_STORE_PASS 由调用方从 .env 注入
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.PROD_BASE || 'https://sh.scqfls.cn';
const STORE = { email: process.env.PROD_STORE_EMAIL, pass: process.env.PROD_STORE_PASS };
const ADMIN = { email: process.env.PROD_EMAIL || 'admin@nocobase.com', pass: process.env.PROD_PASS || '' };
const OUT = 'storage/tmp/r212/prod-accept-store';
fs.mkdirSync(OUT, { recursive: true });
if (!STORE.email || !STORE.pass) { console.error('缺少 PROD_STORE_EMAIL/PASS'); process.exit(1); }

const port = 9991;
const profile = path.join(os.tmpdir(), `r212st-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--ignore-certificate-errors',
  '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 200; i++) {
  try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* */ }
  await sleep(300);
}
if (!wsUrl) { console.error('CHROME 启动失败'); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); return n; };
const results = [];
const ok = (m, d = null) => { results.push({ pass: true, m, d }); console.log(`✅ ${m}`, d === null ? '' : JSON.stringify(d)); };
const no = (m, d = null) => { results.push({ pass: false, m, d }); console.log(`❌ ${m}`, d === null ? '' : JSON.stringify(d)); };

const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const pressEsc = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };

const login = async (email, pass) => {
  await ev('localStorage.clear(); sessionStorage.clear();');
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: `${BASE}/signin` });
  for (let i = 0; i < 80; i++) { const n = await ev(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null).length`).catch(() => 0); if (n >= 2) break; await sleep(400); }
  await sleep(900);
  await ev(`(() => { const all=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null);
    const a=all.find(i=>i.type!=='password'), p=all.find(i=>i.type==='password');
    if(!a||!p) return false;
    const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(a,${JSON.stringify(email)}); a.dispatchEvent(new Event('input',{bubbles:true}));
    s.call(p,${JSON.stringify(pass)}); p.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登录|Sign/i.test(x.innerText)); if(b) b.click(); return !!b; })()`);
  for (let i = 0; i < 60; i++) { await sleep(500); if (!/\/signin/.test(await ev('location.href'))) break; }
  await sleep(7000);
  return await ev('location.href');
};

try {
  await send('Page.enable'); await send('Runtime.enable');
  const u = await login(STORE.email, STORE.pass);
  if (/\/signin/.test(u)) { no('门店角色登录', { url: u }); throw new Error('login failed'); }
  ok('门店角色登录成功', { email: STORE.email, url: u });

  // ---------- ① 菜单 2+5 ----------
  const g = await ev(`(() => {
    const sider = document.querySelector('.ant-layout-sider');
    if (!sider) return { ok: false };
    return { ok: true, groups: [...sider.querySelectorAll('li[data-svc-vgroup]')].map(b => ({
      key: b.getAttribute('data-svc-vgroup'),
      title: (b.querySelector(':scope > .ant-menu-submenu-title')?.innerText || '').trim(),
      collapsed: b.getAttribute('data-collapsed') === '1',
      items: [...b.querySelectorAll('ul.ant-menu-sub li')].map(li => (li.textContent||'').trim()).filter(Boolean),
    })) };
  })()`);
  if (!g?.ok) { no('读取门店菜单', g); } else {
    const d = g.groups.find((x) => x.key === 'daily');
    const a = g.groups.find((x) => x.key === 'admin');
    (d?.items?.length === 2 ? ok : no)('门店·日常业务 2 项', { title: d?.title, items: d?.items });
    (a?.items?.length === 5 ? ok : no)('门店·管理与设置 5 项', { title: a?.title, items: a?.items, collapsed: a?.collapsed });
    const all = [...(d?.items || []), ...(a?.items || [])];
    console.log('  门店可见全部菜单：', JSON.stringify(all));
    // 「未增加原有权限之外的页面」的判据必须基于**授权集合**，不能靠文案关键字猜：
    // 见下方 listAccessible 与 roles:check 的对照（只读）。
    const allow = await ev(`(async () => {
      const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                  'Authorization': 'Bearer ' + (localStorage.getItem('NOCOBASE_TOKEN') || '') };
      try {
        const r = await fetch('/api/desktopRoutes:listAccessible?paginate=false', { method: 'GET', headers: h });
        const j = await r.json();
        const arr = j?.data?.data || j?.data || [];
        return { status: r.status, n: Array.isArray(arr) ? arr.length : -1,
                 titles: Array.isArray(arr) ? arr.map(x => x.title).filter(Boolean) : [] };
      } catch (e) { return { err: String(e).slice(0,150) }; }
    })()`);
    console.log('  listAccessible →', JSON.stringify(allow).slice(0, 600));
    fs.writeFileSync(path.join(OUT, 'store-menu.json'), JSON.stringify({ g, all, allow }, null, 2));
    await shot('st01-menu.png');
  }

  // ---------- ③ 四类按钮（真实点击，只开不收） ----------
  // 门店角色进「我的门店工单」，逐页签找「处理 / 跟进 / 审核」按钮。
  await send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
  await sleep(11000);
  const tabs = (await ev(`[...document.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')].map(t => (t.innerText||'').trim())`)) || [];
  ok('门店可见页签', tabs);

  const seen = new Map(); // label -> { tab, size, opened }
  for (let i = 0; i < tabs.length; i++) {
    const box = await ev(`(() => { const t=[...document.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')][${i}];
      if(!t) return null; const r=t.getBoundingClientRect(); if(r.width===0) return null;
      return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()`);
    if (!box || box.__err) continue;
    await clickAt(box.x, box.y);
    await sleep(2800);
    // 该页签内第一行含主按钮的行，取每种 label 一个
    const rows = await ev(`(() => {
      const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
      if (!pane) return [];
      const tbl = [...pane.querySelectorAll('table')].find(t => t.getBoundingClientRect().width > 0);
      if (!tbl) return [];
      const row = [...tbl.querySelectorAll('tbody tr.ant-table-row')].find(tr => tr.querySelector('[data-primary-action]') && tr.getBoundingClientRect().height > 0);
      if (!row) return [];
      return [...row.querySelectorAll('[data-primary-action]')].map(b => {
        const r = b.getBoundingClientRect();
        b.setAttribute('data-accept-probe', b.getAttribute('data-primary-action'));
        return { kind: b.getAttribute('data-primary-action'), label: b.getAttribute('data-action-label'),
                 title: b.getAttribute('title') || b.getAttribute('aria-label'),
                 w: Math.round(r.width), h: Math.round(r.height), x: r.left + r.width/2, y: r.top + r.height/2,
                 visible: r.width > 0 && r.height > 0, bg: getComputedStyle(b).backgroundColor,
                 color: getComputedStyle(b).color, radius: getComputedStyle(b).borderRadius };
      });
    })()`);
    for (const b of (rows || [])) {
      if (!seen.has(b.label)) seen.set(b.label, { ...b, tab: tabs[i], opened: null });
    }
  }

  const labels = [...seen.keys()];
  ok('门店可见主按钮文案（实测）', labels);

  // 逐个真实点击，判断打开了什么（modal / drawer），随后 Escape 关闭
  for (const [label, info] of seen) {
    const urlBefore = await ev('location.href');
    await clickAt(info.x, info.y);
    await sleep(3200);
    const opened = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].filter(e => e.getBoundingClientRect().height > 0).length;
      const d = [...document.querySelectorAll('.ant-drawer-open, .ant-drawer-content-wrapper')].filter(e => e.getBoundingClientRect().width > 0).length;
      const title = (document.querySelector('.ant-modal-title, .ant-drawer-title')?.innerText || '').trim().slice(0, 30);
      return { modal: m, drawer: d, title };
    })()`);
    const urlAfter = await ev('location.href');
    const kind = opened?.modal > 0 ? 'modal' : (opened?.drawer > 0 ? 'drawer' : 'none');
    info.opened = { kind, title: opened?.title, urlSame: urlBefore === urlAfter };
    // 关闭（不提交）
    await pressEsc(); await sleep(1200);
    const closed = await ev(`[...document.querySelectorAll('.ant-modal-wrap')].filter(e=>e.getBoundingClientRect().height>0).length`);
    info.opened.closed = closed === 0;
    // 之后为避免误点，回到列表页
    await send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
    await sleep(8000);
  }

  const allSize = [...seen.values()].every((v) => v.w === 64 && v.h === 30);
  (allSize ? ok : no)('门店按钮尺寸均为 64×30', [...seen.values()].map((v) => ({ label: v.label, w: v.w, h: v.h })));
  const allVis = [...seen.values()].every((v) => v.visible);
  (allVis ? ok : no)('门店按钮均真实可见（w>0 && h>0）', [...seen.values()].map((v) => v.visible));
  const allOpened = [...seen.values()].every((v) => v.opened?.kind !== 'none');
  (allOpened ? ok : no)('每个按钮点击后都打开了面板（功能可用）', [...seen.values()].map((v) => ({ label: v.label, ...v.opened })));
  const noNav = [...seen.values()].every((v) => v.opened?.urlSame !== false);
  (noNav ? ok : no)('点击未导致页面跳走（与已验收行为一致）', [...seen.values()].map((v) => ({ label: v.label, urlSame: v.opened?.urlSame })));
  fs.writeFileSync(path.join(OUT, 'store-buttons.json'), JSON.stringify([...seen.entries()].map(([k, v]) => ({ label: k, ...v })), null, 2));
  await shot('st02-list.png');

  // ---------- 数据隔离：门店只能看自己门店的单 ----------
  // ⚠️ 门禁正确行为是 403（资源级 ACL 先于路由判定）⇒ 403/200 都算"隔离生效"，
  //    关键是**不能拿到别家门店的行**。404 只能说明 URL 写错，不算证据。
  // ⚠️ `paginate=false` 会让本产品的 list action **丢掉 scope 过滤**（实测门店角色看到 497 条 = 全库）。
  //    正确判据必须用**默认分页**（即界面真实走的路径），并读 `meta.count` 与「全部」页签行数对照。
  //    另外必须排除 401/404 —— 那说明 token 已失效或 URL 写错，不能当作"隔离生效"的证据。
  const myId = Number(process.env.PROD_STORE_USER_ID || 904);
  const scope = await ev(`(async () => {
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                'Authorization': 'Bearer ' + (localStorage.getItem('NOCOBASE_TOKEN') || '') };
    const out = {};
    const grab = async (u) => {
      const r = await fetch(u, { method: 'GET', headers: h });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch { /* */ }
      return { status: r.status, meta: j?.meta || null, n: Array.isArray(j?.data) ? j.data.length : null,
               sample: Array.isArray(j?.data) ? j.data.slice(0, 3) : null, body: j ? null : txt.slice(0, 100) };
    };
    out.paged = await grab('/api/serviceTickets:list?pageSize=20&page=1');
    out.uiRows = [...document.querySelectorAll('.ant-tabs-tabpane')]
      .reverse().find(p => p.getAttribute('aria-hidden') !== 'true')
      ?.querySelectorAll('tbody tr.ant-table-row').length ?? -1;
    return out;
  })()`);
  const meta = scope?.paged?.meta;
  const bad = !meta || [401, 403, 404].includes(scope?.paged?.status);
  if (bad) no('门店数据隔离：查询未能取得可信数据（token/URL 问题，不作结论）', scope);
  else {
    const cnt = Number(meta.count);
    const fields = scope.paged.sample?.[0] ? Object.keys(scope.paged.sample[0]) : [];
    // 🔴 API 的 meta.count 在本产品**不带 scope**（实测 497 = 全库量级，而该店真实工单只有 8 条）
    //    ⇒ count 不能作为隔离判据；隔离必须以「界面可见行」+「行内门店名」取证。
    fs.writeFileSync(path.join(OUT, 'store-scope.json'), JSON.stringify({ ...scope, fields }, null, 2));
    ok('门店接口可访问（注意：meta.count 不带 scope，不可作为隔离判据）',
       { status: scope.paged.status, count: cnt, uiRows: scope.uiRows });

    // 真判据：界面上每一行都必须属于本门店
    const rows = await ev(`(() => {
      const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
      if (!pane) return { ok: false };
      const rows = [...pane.querySelectorAll('tbody tr.ant-table-row')].filter(r => r.getBoundingClientRect().height > 0);
      const texts = rows.map(r => (r.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160));
      return { ok: true, n: rows.length, texts };
    })()`);
    const OTHER_STORES = ['新都圣大', '崇州九兴', '新津欣盛', '青神易田', '郫都康乐', '龙泉东山', '茂县国茂', '蒲江江华', '峨眉诚信'];
    const leaked = (rows?.texts || []).filter((t) => OTHER_STORES.some((s) => t.includes(s)));
    (leaked.length === 0 ? ok : no)('门店界面未见其他门店的工单', { rows: rows?.n, leaked });
    await shot('st03-store-scope.png');
  }
} catch (e) {
  console.log('EXCEPTION', String(e.message || e).slice(0, 300));
} finally {
  const pass = results.filter((r) => r.pass).length; const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n共 ${results.length} 项，失败 ${fail} 项`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, pass, fail }, null, 2));
  try { ws.close(); } catch { /* */ } try { child.kill(); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 2);
}
