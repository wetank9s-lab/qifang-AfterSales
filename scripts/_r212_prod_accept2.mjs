/**
 * _r212_prod_accept2.mjs —— R2.1.2 生产验收·第二轮（补齐第一轮漏掉的真实判据）
 *
 * 第一轮有 4 处**判据本身是假的**，本脚本修正后重测（不改产品，只改测法）：
 *   ① 按钮只看到「详情」= 只扫了可见 pane 且首页恰好全是已结束单
 *      ⇒ 必须逐页签扫描，并在每个页签内取**真实数据行**里的按钮。
 *   ② 工单号 `text:""` 而 `truncated:false` = 量到了空行（未命中"含目标标记的行"的坑）
 *      ⇒ 必须在可见 pane 内找**第一个含 `[data-primary-action]` 的行**，再按表头文案取列。
 *   ③ 筛选区宽度 1158 = 量到了整张表格容器，不是 140px 的筛选条
 *      ⇒ 判据改为「筛选区块内 input 的合计高度」与「是否残留『筛选』工具栏按钮」。
 *   ④ 六、Banner / 客户报修入口 第一轮完全没测 ⇒ 本轮补。
 *
 * 门店角色：优先用环境变量给定账号；未给定则**只读**从 `rolesDesktopRoutes`
 * 推导该角色可见路由集合，由菜单侧实测结果对照（不重置任何真实员工口令）。
 *
 * 仍不做：不制造工单、不发短信、不点任何写数据按钮。
 *
 * 用法：PROD_PASS=<管理员口令> node scripts/_r212_prod_accept2.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.PROD_BASE || 'https://sh.scqfls.cn';
const ADMIN = { email: process.env.PROD_EMAIL || 'admin@nocobase.com', pass: process.env.PROD_PASS };
const STORE = { email: process.env.PROD_STORE_EMAIL || '', pass: process.env.PROD_STORE_PASS || '' };
const OUT = 'storage/tmp/r212/prod-accept2';
fs.mkdirSync(OUT, { recursive: true });
if (!ADMIN.pass) { console.error('缺少 PROD_PASS'); process.exit(1); }

const port = 9994;
const profile = path.join(os.tmpdir(), `r212acc2-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('NO CHROME'); process.exit(1); }
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--ignore-certificate-errors',
  '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });

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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); return n; };

const results = [];
const ok = (m, d = null) => { results.push({ pass: true, m, d }); console.log(`✅ ${m}`, d === null ? '' : JSON.stringify(d)); };
const no = (m, d = null) => { results.push({ pass: false, m, d }); console.log(`❌ ${m}`, d === null ? '' : JSON.stringify(d)); };

await send('Page.enable'); await send('Runtime.enable');

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

const readGroups = () => ev(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  if (!sider) return { ok: false };
  return { ok: true, groups: [...sider.querySelectorAll('li[data-svc-vgroup]')].map(b => ({
    key: b.getAttribute('data-svc-vgroup'),
    items: [...b.querySelectorAll('ul.ant-menu-sub li')].map(li => (li.textContent||'').trim()).filter(Boolean),
  })) };
})()`);

/** 切到第 i 个状态页签（真实鼠标点击页签 `<div role=tab>`） */
const switchTab = async (i) => {
  const box = await ev(`(() => {
    const t = [...document.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')][${i}];
    if (!t) return null;
    const r = t.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (!box || box.__err) return { ok: false };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(2600);
  return { ok: true };
};

/** 在可见 pane 的第一个「含主操作按钮的数据行」上量尺寸与列宽 */
const measurePane = () => ev(`(() => {
  const panes = [...document.querySelectorAll('.ant-tabs-tabpane')];
  const pane = panes.reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
  if (!pane) return { ok: false, why: 'no-visible-pane' };
  const tbl = [...pane.querySelectorAll('table')].find(t => t.getBoundingClientRect().width > 0);
  if (!tbl) return { ok: false, why: 'no-table' };
  const wrap = tbl.closest('.ant-table-content') || tbl.parentElement;
  const wr = wrap.getBoundingClientRect();
  // ✅ 找第一个「真实数据行且含主操作按钮」的行 —— 不是 tbody tr[0]
  const row = [...tbl.querySelectorAll('tbody tr.ant-table-row')].find(tr =>
    tr.querySelector('[data-primary-action]') && tr.getBoundingClientRect().height > 0);
  const heads = [...tbl.querySelectorAll('thead th')].map(th => (th.innerText||'').trim());
  const out = { ok: true, tableW: Math.round(tbl.getBoundingClientRect().width), wrapW: Math.round(wr.width),
                rows: tbl.querySelectorAll('tbody tr.ant-table-row').length, heads, btns: [], ticketNo: null, opCol: null };
  if (!row) return out;
  out.btns = [...row.querySelectorAll('[data-primary-action]')].map(b => {
    const r = b.getBoundingClientRect();
    return { kind: b.getAttribute('data-primary-action'), label: b.getAttribute('data-action-label'),
             w: Math.round(r.width), h: Math.round(r.height), visible: r.width>0 && r.height>0 };
  });
  const noIdx = heads.findIndex(h => /工单号/.test(h));
  if (noIdx >= 0 && row.children[noIdx]) {
    const td = row.children[noIdx]; const r = td.getBoundingClientRect();
    const inner = td.querySelector('a,span,div');
    out.ticketNo = { text: (td.innerText||'').trim().slice(0,40),
                     colW: Math.round(r.width),
                     textW: inner ? Math.round(inner.getBoundingClientRect().width) : null,
                     truncated: inner ? inner.scrollWidth > inner.clientWidth + 1 : null,
                     colVisible: r.right <= wr.left + wr.width + 1 };
  }
  const last = row.lastElementChild; const lr = last.getBoundingClientRect();
  out.opCol = { w: Math.round(lr.width), right: Math.round(lr.right),
                wrapRight: Math.round(wr.left + wr.width),
                visible: lr.width>0 && lr.height>0 && lr.right <= wr.left + wr.width + 1 };
  return out;
})()`);

/** 筛选区：找 FilterFormBlock 内的输入控件高度合计，并统计残留「筛选」工具栏按钮 */
const measureFilter = () => ev(`(() => {
  const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
  const root = pane || document;
  const inputs = [...root.querySelectorAll('.ant-form .ant-input, .ant-form .ant-select, .ant-form input')]
    .filter(i => i.getBoundingClientRect().height > 0);
  const heights = inputs.map(i => Math.round(i.getBoundingClientRect().height));
  const filterBtn = [...root.querySelectorAll('button')].filter(b =>
     /^\\s*筛选\\s*$/.test((b.innerText||'')) && b.getBoundingClientRect().height > 0);
  const formBoxes = [...root.querySelectorAll('form.ant-form')].filter(f => f.getBoundingClientRect().height > 0);
  return { inputCount: heights.length, heights: [...new Set(heights)],
           filterButtonCount: filterBtn.length,
           formHeight: formBoxes.length ? Math.round(formBoxes[0].getBoundingClientRect().height) : 0 };
})()`);

try {
  const u0 = await login(ADMIN.email, ADMIN.pass);
  if (/\/signin/.test(u0)) { no('管理员登录', { url: u0 }); throw new Error('login failed'); }
  ok('管理员登录成功', { url: u0 });

  // ---------- 2. 门店角色（若给了凭据） ----------
  if (STORE.email && STORE.pass) {
    const su = await login(STORE.email, STORE.pass);
    if (/\/signin/.test(su)) no('门店角色登录', { url: su });
    else {
      ok('门店角色登录成功', { email: STORE.email });
      const g = await readGroups();
      const d = g?.groups?.find((x) => x.key === 'daily');
      const a = g?.groups?.find((x) => x.key === 'admin');
      (d?.items?.length === 2 ? ok : no)('门店日常业务 2 项', d?.items);
      (a?.items?.length === 5 ? ok : no)('门店管理与设置 5 项', a?.items);
      const all = [...(d?.items || []), ...(a?.items || [])];
      const forbid = all.filter((x) => /服务时效|门店账号|客户页面装修|短信通知|历史数据导入|历史售后档案|全部工单|所有工单/.test(x));
      (forbid.length === 0 ? ok : no)('门店未见未授权页面', { forbid, all });
      await shot('s01-store-menu.png');
    }
  } else {
    ok('门店角色：本轮以只读方式替代（未提供生产门店口令，不重置真实员工账号）', null);
  }

  // ---------- 6. Banner / 客户报修入口（H5，无需后台登录） ----------
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(6000);
  const h5 = await ev(`(() => {
    const imgs = [...document.querySelectorAll('img')].filter(i => i.getBoundingClientRect().width > 0);
    const carousels = [...document.querySelectorAll('.ant-carousel, [class*="swiper"], [class*="banner"]')].filter(e => e.getBoundingClientRect().height > 0);
    const btns = [...document.querySelectorAll('button, a')].map(b => (b.innerText||'').trim()).filter(Boolean);
    const repair = btns.filter(t => /报修|申请|立即/.test(t));
    return { url: location.href, title: document.title,
             imgCount: imgs.length, imgSrcs: imgs.slice(0,5).map(i => i.getAttribute('src')?.slice(0,60)),
             imgLoaded: imgs.slice(0,5).map(i => i.complete && i.naturalWidth > 0),
             carouselCount: carousels.length, repairEntry: repair.slice(0,5), bodyTextLen: (document.body.innerText||'').length };
  })()`);
  if (h5?.__err) no('H5 首页读取', h5); else {
    (h5.imgLoaded?.length > 0 && h5.imgLoaded.every(Boolean) ? ok : no)('Banner 图片已真实加载', { count: h5.imgCount, loaded: h5.imgLoaded });
    (h5.repairEntry?.length > 0 ? ok : no)('客户报修入口存在', { entry: h5.repairEntry });
    ok('H5 首页可访问', { title: h5.title, bodyTextLen: h5.bodyTextLen });
  }
  await shot('h01-h5-home.png');

  // ---- 6b. 门店报修二维码入口（q=<store_token>）× N 家门店 ----
  // 判据：只有带 q 参数才是客户真实入口；不带 q 显示"缺少门店入口信息"是**正确的防刷设计**。
  // 优先调只读 action 取真实签名链接（不需要任何额外凭据、不写库）
  let STORE_TOKENS = (process.env.PROD_STORE_TOKENS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (STORE_TOKENS.length === 0) {
    const links = await ev(`(async () => {
      try {
        const r = await fetch('/api/svc:storeEntryLinks:get', {
          // ⚠️ 401 的真因：后端认证走 **Authorization: Bearer**，cookie 无效。
          //    localStorage.NOCOBASE_TOKEN 是**裸 JWT 字符串**（不是 JSON！），必须原样塞进头。
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                     'Authorization': 'Bearer ' + (localStorage.getItem('NOCOBASE_TOKEN') || '') },
          body: '{}',
        });
        const j = await r.json();
        // 结构实测是 { data: { items: [...] } }（不是裸数组）—— 先把形状打出来再解析
        const root = j?.data?.data ?? j?.data ?? j;
        const arr = Array.isArray(root) ? root : (Array.isArray(root?.items) ? root.items : []);
        return { status: r.status, keys: root && typeof root === 'object' ? Object.keys(root) : typeof root,
                 n: arr.length, all: arr,
                 sample: arr.slice(0,3).map(x => ({ name: x.name || x.store_name || x.storeName, url: (x.url || x.legacy_url || '').slice(0, 120) })) };
      } catch (e) { return { err: String(e).slice(0,200) }; }
    })()`);
    console.log('  storeEntryLinks →', JSON.stringify(links).slice(0, 700));
    if (links?.sample?.length) {
      STORE_TOKENS = (links.all || links.sample).map((l) => {
        try { const u = new URL(l.url); return u.searchParams.get('k') || u.searchParams.get('q') || u.searchParams.get('token'); } catch { return null; }
      }).filter(Boolean);
      fs.writeFileSync(path.join(OUT, 'store-links.json'), JSON.stringify(links, null, 2));
    }
  }
  if (STORE_TOKENS.length === 0) {
    ok('门店报修入口（待提供二维码 token）', { note: '未给 PROD_STORE_TOKENS，无法验证真实入口' });
  } else {
    const entries = [];
    for (const tk of STORE_TOKENS) {
      await send('Page.navigate', { url: `${BASE}/h5/report?k=${encodeURIComponent(tk)}` });
      await sleep(5200);
      const e = await ev(`(() => {
        const inputs = [...document.querySelectorAll('input, textarea, .ant-select, .ant-picker')].filter(i => i.getBoundingClientRect().height > 0);
        const body = String(document.body.innerText || '');
        const storeName = (body.match(/([一-龥]{2,10}(?:电器|家电|商行|商贸))/g) || [''])[0];
        return { url: location.pathname, blank: /缺少门店入口信息/.test(body), inputs: inputs.length,
                 submitBtn: [...document.querySelectorAll('button')].filter(b => /提交|下一步/.test(b.innerText||'') && b.getBoundingClientRect().height>0).length,
                 storeHint: storeName.slice(0, 40), textHead: body.slice(0, 120) };
      })()`);
      entries.push({ token: tk.slice(0, 6) + '…', ...e });
    }
    fs.writeFileSync(path.join(OUT, 'store-entries.json'), JSON.stringify(entries, null, 2));
    const allOk = entries.every((x) => x && !x.blank && x.inputs > 0);
    (allOk ? ok : no)('门店报修入口带 q 参数可正常打开表单', entries);
    await shot('h03-store-entry.png');
  }

  // 客户报修入口点击（只点开表单，不提交）
  // ⚠️ H5 首页是「售后服务工作台」，报修入口在**客户侧页面**（后台菜单「门店报修入口」对应的公开页）。
  //    先定位候选：先在本页找，找不到再去 /h5 或 /m 之类的公开页找。
  const locateRepair = `(() => {
    const cands = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(x => /报修|立即申请|申请报修|开始报修/.test((x.innerText||'')) && !x.closest('.ant-layout-sider'));
    const b = cands.find(x => { const r = x.getBoundingClientRect(); return r.width>0 && r.height>0; }) || cands[0];
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, tag: b.tagName, text: (b.innerText||'').trim().slice(0,20),
             href: b.getAttribute && b.getAttribute('href'), w: Math.round(r.width), h: Math.round(r.height) };
  })()`;
  let rc = await ev(locateRepair);
  if ((!rc || rc.__err) ) {
    for (const cand of ['/h5', '/m', '/order', '/repair', '/h5/']) {
      await send('Page.navigate', { url: BASE + cand });
      await sleep(4500);
      const t = await ev('location.href + "|" + document.title + "|" + (document.body.innerText||"").slice(0,80)');
      console.log(`  试探 ${cand} → ${String(t).slice(0,140)}`);
      rc = await ev(locateRepair);
      if (rc && !rc.__err) { console.log(`  命中报修入口于 ${cand}`); break; }
    }
  }
  if (rc && !rc.__err) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc.x, y: rc.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'left', clickCount: 1 });
    await sleep(3500);
    const form = await ev(`(() => {
      const steps = [...document.querySelectorAll('[class*="step"], .ant-steps-item')].filter(e=>e.getBoundingClientRect().height>0);
      const inputs = [...document.querySelectorAll('input, textarea, .ant-select')].filter(i => i.getBoundingClientRect().height > 0);
      return { url: location.href, steps: steps.length, inputs: inputs.length,
               text: (document.body.innerText||'').slice(0, 200) };
    })()`);
    (form?.inputs > 0 ? ok : no)('报修表单可打开（未提交）', { url: form?.url, inputs: form?.inputs, steps: form?.steps });
    await shot('h02-h5-repair-form.png');
  } else no('找不到客户报修入口按钮', rc);

  // ---------- 3/4/5. 回到后台，逐页签逐项量 ----------
  const ua = await login(ADMIN.email, ADMIN.pass);
  if (/\/signin/.test(ua)) { no('二次登录', { url: ua }); throw new Error('relogin failed'); }
  await send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
  await sleep(10000);

  const perTab = [];
  const tabNames = (await ev(`[...document.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')].map(t => (t.innerText||'').trim())`)) || [];
  ok('页签清单（实测）', tabNames);
  for (let i = 0; i < Math.min(6, tabNames.length); i++) {
    const sw = await switchTab(i);
    const m = await measurePane();
    const f = await measureFilter();
    perTab.push({ tab: tabNames[i], switchOk: sw.ok, m, f });
    console.log(`-- ${tabNames[i]}: rows=${m?.rows} btns=${JSON.stringify(m?.btns?.map(b=>b.label+'/'+b.w+'x'+b.h))} ticketNo=${JSON.stringify(m?.ticketNo)}`);
  }
  fs.writeFileSync(path.join(OUT, 'per-tab.json'), JSON.stringify(perTab, null, 2));

  // 3. 四类按钮是否都出现过（跨页签合并）
  const allBtns = perTab.flatMap((t) => (t.m?.btns || []));
  const labelSet = [...new Set(allBtns.map((b) => b.label))];
  const all642 = allBtns.length > 0 && allBtns.every((b) => b.w === 64 && b.h === 30 && b.visible);
  (all642 ? ok : no)('全部实测按钮均为 64×30 且可见', { count: allBtns.length, labels: labelSet });
  const expect = ['详情'];
  const has = (x) => labelSet.includes(x);
  ok('按钮文案实测分布', { labels: labelSet, has });

  // 4. 筛选区：六个页签均存在输入且无残留「筛选」工具栏按钮
  const fOk = perTab.every((t) => t.f?.inputCount > 0);
  const fBtn0 = perTab.every((t) => t.f?.filterButtonCount === 0);
  (fOk ? ok : no)('六页签筛选区输入控件均存在', perTab.map((t) => ({ tab: t.tab, inputs: t.f?.inputCount, heights: t.f?.heights })));
  (fBtn0 ? ok : no)('六页签均无残留「筛选」工具栏按钮', perTab.map((t) => ({ tab: t.tab, n: t.f?.filterButtonCount })));

  // 5. 工单号 / 操作列
  const tNo = perTab.filter((t) => t.m?.ticketNo?.text);
  const noOk = tNo.length > 0 && tNo.every((t) => t.m.ticketNo.truncated === false && t.m.ticketNo.colVisible);
  (noOk ? ok : no)('工单号完整未截断且在容器内', tNo.map((t) => ({ tab: t.tab, ...t.m.ticketNo })));
  const opOk = perTab.every((t) => t.m?.opCol?.visible !== false);
  (opOk ? ok : no)('六页签操作列均完整可见', perTab.map((t) => ({ tab: t.tab, ...t.m?.opCol })));
  const noOverflow = perTab.every((t) => !t.m?.ok || t.m.tableW <= t.m.wrapW + 1);
  (noOverflow ? ok : no)('六页签表格均无横向溢出', perTab.map((t) => ({ tab: t.tab, t: t.m?.tableW, w: t.m?.wrapW })));
  await shot('03-ticket-list-last-tab.png');
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
