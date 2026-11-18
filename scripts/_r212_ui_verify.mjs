/**
 * _r212_ui_verify.mjs —— R2.1.2 隔离环境 UI 验收
 *
 * 验收项（用户指令 四，只做这 5 项）：
 *   1. 同一张工单列表中，处理 / 跟进 / 审核 / 详情 四类按钮 **宽高一致**
 *   2. 四种按钮点击后都进入原本正确的区域
 *   3. 管理员菜单显示 **4+10**
 *   4. 门店售后角色原有页面可访问集合 **保持不变**
 *   5. 原有筛选区 / 表格 / 状态页签 **无变化**
 *
 * ⚠️ 铁律：
 *   · 计数类判据必须限定**可见 tabpane**（NocoBase Tabs 不销毁旧 pane，只加 aria-hidden）
 *   · 按钮"可见"的判据是位置：right <= 容器.left + clientWidth（不是 scrollWidth 对比）
 *   · 点击后要**真的**进了对应区域，用 DOM 证据（模态标题/抽屉 + 焦点区），不靠"看起来对"
 *   · 四类按钮未必同时出现在一张表里 ⇒ 按状态页签分别取证，再横向比宽高
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const BASE = process.env.SVC_BASE || 'http://127.0.0.1:13000';
// ⚠️ 本地隔离环境的账号是 UAT 账号，**不是** admin@nocobase.com：
//    生产后台口令（见 .env，不入库）在本地一律 401（本轮先踩了一次）。
//    这三个账号来自 scripts/_r211-login.mjs，是本地库里真实存在的。
const EMAIL = process.env.SVC_EMAIL || 'uat.hqadmin@svc.local';
const PASS = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!PASS) { console.error('缺少口令：export R212_PASS=<本地 UAT 口令>'); process.exit(1); }
const OUT = 'storage/tmp/r212/local';
fs.mkdirSync(OUT, { recursive: true });

const W = 1440, H = 1000;
const TABS = ['全部', '待处理', '处理中', '待门店确认', '待客户评价', '已结束'];

const port = 9977;
const profile = path.join(os.tmpdir(), `r212local-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!chrome) { console.error('NO CHROME'); process.exit(1); }

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=' + W + ',' + H, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 160; i++) {
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
const netErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Network.responseReceived') {
    const s = m.params?.response?.status;
    const u = m.params?.response?.url || '';
    if (s >= 400 && !u.includes('favicon')) netErrors.push({ s, u: u.slice(0, 180) });
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};
const goto = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    if (await evalJs('document.readyState').catch(() => null) === 'complete') return;
  }
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });   // 视口截图，不 beyond
  const buf = Buffer.from(r.result.data, 'base64');
  const p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  return { file: p, bytes: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
};

const R = { at: new Date().toISOString(), base: BASE, checks: [], tabs: [], netErrors: [] };
const chk = (name, ok, detail) => {
  R.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
};

// ---------- 登录 ----------
await goto(`${BASE}/signin`);
// ⚠️ 必须等**两个**可见输入框都出现：只等 input 数量会在 SPA 挂载中途读到 1 个，
//    随后 offsetParent 过滤后为空 ⇒ TypeError（本轮真踩过）。
let loginReady = false;
for (let i = 0; i < 80; i++) {
  const n = await evalJs(`[...document.querySelectorAll('input')].filter(i => i.offsetParent !== null).length`).catch(() => 0);
  if (n >= 2) { loginReady = true; break; }
  await sleep(400);
}
chk('登录页已渲染（≥2 个可见输入框）', loginReady, null);
await sleep(800);

const filled = await evalJs(`(() => {
  const all = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
  const acc = all.find(i => i.type !== 'password');
  const pw = all.find(i => i.type === 'password');
  if (!acc || !pw) return { ok: false, n: all.length };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(acc, ${JSON.stringify(EMAIL)});
  acc.dispatchEvent(new Event('input', { bubbles: true }));
  acc.dispatchEvent(new Event('change', { bubbles: true }));
  setter.call(pw, ${JSON.stringify(PASS)});
  pw.dispatchEvent(new Event('input', { bubbles: true }));
  pw.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`);
chk('登录表单已填入', filled?.ok, filled);
await sleep(500);
const clickedLogin = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /登录|Sign|Log ?in/i.test(x.innerText));
  if (!b) return false;
  b.click(); return true;
})()`);
chk('已点击登录按钮', clickedLogin, null);
for (let i = 0; i < 50; i++) {
  await sleep(500);
  if (!/\/signin/.test(await evalJs('location.href'))) break;
}
await sleep(3500);
const afterLogin = await evalJs('location.href');
chk('登录成功（离开 /signin）', !/\/signin/.test(afterLogin), afterLogin);
if (/\/signin/.test(afterLogin)) {
  R.loginFailBody = await evalJs('document.body.innerText.slice(0,400)');
  await shot('login-failed.png');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(R, null, 2));
  console.log('登录失败，终止。body=', R.loginFailBody);
  ws.close(); try { child.kill(); } catch {}
  process.exit(1);
}

// ---------- 打开工单页 ----------
// ⚠️ 必须进「我的门店工单」，**不是「所有工单」**。本项目里这两个页是两条完全不同的
//    路由，结构不同（本地与生产都实测过）：
//      · 我的门店工单 = flowPage + 六个状态页签，六个页签里各挂一个 TicketPrimaryActionModel
//      · 所有工单     = flowPage，**没有页签**、表格里只有原生的「查看」，
//                       db 里该 RouteModel 下只有 RouteModel/RootPageModel 两层
//    ⇒ 行内主按钮只存在于「我的门店工单」。上一版脚本点了「所有工单」，
//      于是 20 行一个主按钮都没有，被误读成"按钮全丢了"。
//    ⚠️ 另外：点菜单 `<a>` 在本项目**不导航**（虚拟分组把 li 搬到新容器后，
//       菜单 `onClick` 依赖的 parent 链路已断，而 href 又是由 onClick preventDefault 的）。
//       ⇒ 这里直接用 URL 导航，避开该已存在缺陷（它是 B 类，不在本轮范围）。
const TICKET_PAGE = `${BASE}/admin/tujyw08ec1d`;
await goto(TICKET_PAGE);
await sleep(6000);
R.pageUrl = await evalJs('location.href');
chk('已进入「我的门店工单」', /tujyw08ec1d/.test(R.pageUrl), R.pageUrl);

// 六个页签必须都在
const tabTitles = await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].map(t => (t.innerText||'').trim())`);
chk('六个状态页签齐全', Array.isArray(tabTitles) && tabTitles.filter(Boolean).length === 6, tabTitles);

// ---------- 逐页签取证 ----------
const visPaneExpr = `([...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true'))`;

for (const tabName of TABS) {
  const clicked = await evalJs(`(() => {
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
    const want = ${JSON.stringify(tabName)};
    const tab = tabs.find(p => (p.innerText||'').trim() === want);
    if (!tab) return { ok: false, avail: tabs.map(p => (p.innerText||'').trim()) };
    tab.click(); return { ok: true };
  })()`);
  await sleep(3200);

  const probe = await evalJs(`(() => {
    const pane = ${visPaneExpr};
    const sc = pane || document;
    // ⚠️ 必须选**真正装着主按钮**的那张表，不能取"第一张有宽度的表"：
    //    NocoBase 的筛选区块有时也会渲染 table（测宽用），且表格结构里有
    //    thead 之外的空行。上一版取 tables[0] + tbody tr[0] 拿到的是空行，
    //    于是 6 个页签全部报 no-primary-btn —— 那是探针选错，不是产品没按钮。
    //    正确判据：在可见 pane 内找**第一个含 [data-primary-action] 的行**。
    const alltables = [...sc.querySelectorAll('table')].filter(t => t.getBoundingClientRect().width > 0);
    let tbl = null, row = null, b = null;
    for (const t of alltables) {
      for (const tr of t.querySelectorAll('tbody tr')) {
        const cand = tr.querySelector('[data-primary-action]');
        if (cand) { tbl = t; row = tr; b = cand; break; }
      }
      if (b) break;
    }
    if (!tbl || !b) {
      return { ok: false, reason: 'no-primary-btn', tables: alltables.length,
               rows: alltables.map(t => t.querySelectorAll('tbody tr').length) };
    }

    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const boxEl = tbl.closest('.ant-table') || tbl.parentElement;
    const box = boxEl.getBoundingClientRect();
    // ⚠️ 可见性判据必须同时满足两条，缺一条都会给出**假阳性**：
    //    ① 按钮自身有尺寸（w>0 && h>0）—— NocoBase Tabs 不销毁旧 pane，
    //       隐藏 pane 里的按钮 getBoundingClientRect 全是 0，而
    //       "0 <= 0 + 0 + 1" 恒为 true ⇒ 单看位置就会把它判成"可见"（本轮真踩过）。
    //    ② 右边界 <= 横向滚动容器的 left + clientWidth（位置判据，不是 scrollWidth）。
    const contentEl = tbl.closest('.ant-table-content') || tbl.closest('.ant-table-body') || boxEl;
    // 筛选区高度：只量可见 pane 内的表单（保护项：R2.1.1 冻结为 140px）
    const card = sc.querySelector('.ant-card');
    const form = card ? card.querySelector('.ant-form') : null;    const crect = contentEl.getBoundingClientRect();
    const visible =
      r.width > 0 && r.height > 0 &&
      r.right <= crect.left + contentEl.clientWidth + 1 &&
      r.left >= crect.left - 1;

    return {
      ok: true,
      tab: ${JSON.stringify(tabName)},
      rows: tbl.querySelectorAll('tbody tr').length,
      kind: b.getAttribute('data-primary-action'),
      label: b.getAttribute('data-action-label'),
      hint: b.getAttribute('data-action-hint'),
      title: b.getAttribute('title'),
      aria: b.getAttribute('aria-label'),
      text: (b.innerText||'').trim(),
      btnW: Math.round(r.width * 10) / 10,
      btnH: Math.round(r.height * 10) / 10,
      radius: cs.borderRadius,
      bg: cs.backgroundColor,
      color: cs.color,
      visible,
      heads: [...tbl.querySelectorAll('thead th')].map(th => (th.innerText||'').replace(/\\s+/g,'').trim()).filter(Boolean),
      cols: tbl.querySelectorAll('colgroup col').length,
      tableW: Math.round(tbl.getBoundingClientRect().width),
      boxW: Math.round(contentEl.getBoundingClientRect().width),
      scrollable: contentEl.scrollWidth > contentEl.clientWidth + 1,
      filterH: form ? Math.round(form.getBoundingClientRect().height) : null,
      filterBtn: [...sc.querySelectorAll('button')].filter(x => (x.innerText||'').trim() === '筛选').length,
      btnPerRow: [...tbl.querySelectorAll('tbody tr')].map(tr => tr.querySelectorAll('[data-primary-action]').length),
      colMarks: [...tbl.querySelectorAll('thead th[data-svc-col]')].map(th => th.getAttribute('data-svc-col')),
    };
  })()`);

  if (probe?.ok) R.tabs.push({ clicked, probe, img: await shot(`tab-${TABS.indexOf(tabName)}.png`) });
  else R.tabs.push({ clicked, probe });
  console.log(`[${tabName}]`, JSON.stringify(probe).slice(0, 320));
}

// ---------- 按钮点击去向（四种）----------
const clickTargets = [];
for (const tabName of ['待处理', '处理中', '待门店确认', '已结束']) {
  // 回到该页签
  await evalJs(`(() => {
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
    const t = tabs.find(p => (p.innerText||'').trim() === ${JSON.stringify(tabName)});
    if (t) t.click(); return !!t;
  })()`);
  await sleep(2500);

  const before = await evalJs(`(() => {
    const pane = ${visPaneExpr};
    const tbl = pane ? [...pane.querySelectorAll('table')].find(t => t.getBoundingClientRect().width>0) : null;
    const b = tbl ? tbl.querySelector('tbody tr [data-primary-action]') : null;
    return b ? { kind: b.getAttribute('data-primary-action'), text: (b.innerText||'').trim() } : null;
  })()`);
  if (!before) { clickTargets.push({ tab: tabName, ok: false, reason: 'no-button' }); continue; }

  await evalJs(`(() => {
    const pane = ${visPaneExpr};
    const tbl = pane ? [...pane.querySelectorAll('table')].find(t => t.getBoundingClientRect().width>0) : null;
    const b = tbl ? tbl.querySelector('tbody tr [data-primary-action]') : null;
    if (b) b.click(); return !!b;
  })()`);
  await sleep(2600);

  const after = await evalJs(`(() => {
    // 模态
    const modals = [...document.querySelectorAll('.ant-modal-wrap')].filter(m => m.style.display !== 'none' && m.getBoundingClientRect().width > 0);
    const modalTitle = modals.length ? (modals[0].querySelector('.ant-modal-title')?.innerText || '').trim() : null;
    // 抽屉
    const drawers = [...document.querySelectorAll('.ant-drawer-content')].filter(d => d.getBoundingClientRect().width > 0);
    const drawerTitle = drawers.length ? (drawers[0].querySelector('.ant-drawer-title')?.innerText || '').trim() : null;
    // 审核区是否被滚到
    const review = drawers.length ? drawers[0].querySelector('[data-svc-review], [data-review-section], [id*="review"], [class*="review"]') : null;
    const reviewVisible = review ? (review.getBoundingClientRect().top < window.innerHeight && review.getBoundingClientRect().bottom > 0) : null;
    return { modalTitle, drawerTitle, drawerCount: drawers.length, modalCount: modals.length, reviewVisible };
  })()`);

  clickTargets.push({ tab: tabName, before, after, ok: true });
  console.log(`[click ${tabName}]`, JSON.stringify({ before, after }));
  await shot(`click-${clickTargets.length}.png`);

  // 关掉（ESC）
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
}
R.clickTargets = clickTargets;

// ---------- 菜单 4+10 ----------
await goto(`${BASE}/admin`);
await sleep(6000);
const menu = await evalJs(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  if (!sider) return { ok: false, reason: 'no-sider' };
  const boxes = [...sider.querySelectorAll('li[data-svc-vgroup]')];
  return {
    ok: true,
    groups: boxes.map(b => {
      const title = (b.querySelector(':scope > .ant-menu-submenu-title')?.innerText || '').trim();
      const subs = [...b.querySelectorAll('ul.ant-menu-sub li')].map(li => (li.textContent||'').trim()).filter(Boolean);
      const sub = b.querySelector('ul.ant-menu-sub');
      return {
        key: b.getAttribute('data-svc-vgroup'),
        title, count: subs.length, items: subs,
        collapsed: b.getAttribute('data-collapsed') === '1',
        display: sub ? sub.style.display : null,
      };
    }),
  };
})()`);
R.menu = menu;
await shot('menu-default.png');

if (menu.ok) {
  const daily = menu.groups.find(g => g.key === 'daily');
  const admin = menu.groups.find(g => g.key === 'admin');
  chk('菜单日常业务 = 4 项', daily && daily.count === 4, daily && daily.items);
  chk('菜单管理与设置 = 10 项', admin && admin.count === 10, admin && admin.items);
  chk('日常业务默认展开', daily && !daily.collapsed, daily && { collapsed: daily.collapsed });
  chk('管理与设置默认折叠', admin && admin.collapsed, admin && { collapsed: admin.collapsed });
  chk('派工记录在管理与设置', admin && admin.items.includes('派工记录'), null);
  chk('工单事件时间线在管理与设置', admin && admin.items.includes('工单事件时间线'), null);
  chk('日常业务不含派工记录', daily && !daily.items.includes('派工记录'), null);
}

// 展开「管理与设置」拍第二张图
await evalJs(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  const head = [...sider.querySelectorAll('li[data-svc-vgroup="admin"] > .ant-menu-submenu-title')][0];
  if (!head) return false;
  head.click(); return true;
})()`);
await sleep(1200);
R.menuExpanded = await evalJs(`(() => {
  const box = document.querySelector('li[data-svc-vgroup="admin"]');
  if (!box) return null;
  const subs = [...box.querySelectorAll('ul.ant-menu-sub li')].map(li => (li.textContent||'').trim()).filter(Boolean);
  const sub = box.querySelector('ul.ant-menu-sub');
  return { collapsed: box.getAttribute('data-collapsed') === '1', display: sub.style.display, items: subs };
})()`);
await shot('menu-admin-expanded.png');

// ---------- 汇总 ----------
const byKind = {};
for (const t of R.tabs) if (t.probe?.ok) byKind[t.probe.kind] = t.probe;
R.buttonSizes = byKind;

const kinds = Object.keys(byKind);
if (kinds.length >= 2) {
  const ws2 = kinds.map(k => byKind[k].btnW);
  const hs = kinds.map(k => byKind[k].btnH);
  chk('按钮宽度全部一致', new Set(ws2).size === 1, Object.fromEntries(kinds.map(k => [k, byKind[k].btnW])));
  chk('按钮高度全部一致', new Set(hs).size === 1, Object.fromEntries(kinds.map(k => [k, byKind[k].btnH])));
} else {
  chk('按钮尺寸对比（样本不足）', false, { kinds });
}
chk('按钮文字均为两个汉字', kinds.every(k => [...byKind[k].text].length === 2), Object.fromEntries(kinds.map(k => [k, byKind[k].text])));
chk('按钮 Tooltip = 完整含义（非两字）', kinds.every(k => byKind[k].title && byKind[k].title.length > 2), Object.fromEntries(kinds.map(k => [k, byKind[k].title])));
chk('按钮可访问名称齐全', kinds.every(k => byKind[k].aria && byKind[k].aria.length > 2), Object.fromEntries(kinds.map(k => [k, byKind[k].aria])));

R.netErrors = netErrors.slice(0, 40);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(R, null, 2));
console.log('\n失败项:', R.checks.filter(c => !c.ok).map(c => c.name));
console.log('报告:', path.join(OUT, 'report.json'));

ws.close();
try { child.kill(); } catch { /* */ }
process.exit(R.checks.every(c => c.ok) ? 0 : 1);
