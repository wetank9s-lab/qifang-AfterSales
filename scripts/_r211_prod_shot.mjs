// _r211_prod_shot.mjs —— 生产侧（sh.scqfls.cn）六页签实拍取证
// 用途：① 部署前基线  ② 部署后验收对比
//
// ⚠️ 只读：不点任何会改数据的按钮，只切页签、读 DOM、截图。
// ⚠️ 视口截图（captureBeyondViewport 会触发重排，把 NocoBase 打回 loading）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PHASE = process.argv[2] || 'before';   // before | after
const BASE = 'https://sh.scqfls.cn';
const EMAIL = process.env.PROD_EMAIL || 'admin@nocobase.com';
const PASS = process.env.PROD_PASS;

const TABS = [
  { key: 'all', title: '全部', uid: 'wz4qkejuvd6' },
  { key: 'new', title: '待处理', uid: '2syydawk24g' },
  { key: 'processing', title: '处理中', uid: 'pac49kftubs' },
  { key: 'wait-store', title: '待门店确认', uid: 'kszn4iloqfr' },
  { key: 'wait-feedback', title: '待客户评价', uid: '9ajzm018g82' },
  { key: 'closed', title: '已结束', uid: 'w08qtr5mplq' },
];

const OUT = `storage/tmp/r211/prod-${PHASE}`;
fs.mkdirSync(OUT, { recursive: true });

const port = 9966;
const profile = path.join(os.tmpdir(), `r211prod-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!chrome) { console.error('NO CHROME'); process.exit(1); }

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--ignore-certificate-errors', '--window-size=1440,1000', 'about:blank',
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
    if (s >= 400 && !u.includes('favicon')) netErrors.push({ s, u: u.slice(0, 160) });
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

const goto = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    const st = await evalJs('document.readyState').catch(() => null);
    if (st === 'complete') return;
  }
};

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.result.data, 'base64');
  const p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return { file: p, bytes: buf.length, sha: h };
};

const report = { phase: PHASE, base: BASE, at: new Date().toISOString(), tabs: [], netErrors: [] };

const waitInputs = async (need = 1, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const n = await evalJs('document.querySelectorAll("input").length').catch(() => 0);
    if (n >= need) return n;
    await sleep(500);
  }
  return 0;
};

// ---------- 登录 ----------
await goto(`${BASE}/signin`);
const nInputs = await waitInputs(2, 80);
await sleep(800);
await shot('00-signin.png');

const loginInfo = await evalJs(`(() => {
  const inputs = [...document.querySelectorAll('input')];
  return { url: location.href, inputs: inputs.map(i => ({ name: i.name, type: i.type, ph: i.placeholder })) };
})()`);
report.signinDom = loginInfo;

const doLogin = async () => {
  // 用 antd 表单：找账号/密码输入框，逐字输入触发 React onChange
  const setVal = async (selector, value) => {
    const ok = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    return ok;
  };
  // 实测 placeholder 是「用户名/邮箱」；用全部 input 里的顺序定位更稳（第 0 个账号、password 那个密码）
  const a = await evalJs(`(() => {
    const all = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
    const acc = all.find(i => i.type !== 'password') || all[0];
    if (!acc) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(acc, ${JSON.stringify(EMAIL)});
    acc.dispatchEvent(new Event('input', { bubbles: true }));
    acc.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const b = await evalJs(`(() => {
    const pw = [...document.querySelectorAll('input[type="password"]')].find(i => i.offsetParent !== null);
    if (!pw) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(pw, ${JSON.stringify(PASS)});
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    pw.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const clicked = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /登录|Sign|Log ?in/i.test(b.innerText));
    if (!btn) return false;
    btn.click(); return true;
  })()`);
  return { userInput: a, passInput: b, clicked };
};
report.inputsFound = nInputs;
report.login = await doLogin();
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const u = await evalJs('location.href');
  if (!/\/signin/.test(u)) break;
}
await sleep(2500);
report.afterLoginUrl = await evalJs('location.href');
await shot('01-after-login.png');

// ---------- 逐个页签 ----------
const PAGE = '/admin/tujyw08ec1d';   // 工单页 flowPage（六页签所在页面；wz4qkejuvd6 是 RouteModel 不是路由）
for (const t of TABS) {
  const url = `${BASE}${PAGE}`;
  await goto(url);
  await sleep(4000);

  // 切到目标页签：页签文本匹配
  const clicked = await evalJs(`(() => {
    const panes = [...document.querySelectorAll('.ant-tabs-tab')];
    const want = ${JSON.stringify(t.title)};
    const tab = panes.find(p => (p.innerText || '').trim() === want)
             || panes.find(p => (p.innerText || '').includes(want));
    if (!tab) return { ok: false, avail: panes.map(p => (p.innerText||'').trim()) };
    tab.click(); return { ok: true };
  })()`);
  await sleep(3500);

  const probe = await evalJs(`(() => {
    const visiblePane = [...document.querySelectorAll('.ant-tabs-tabpane')]
      .reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
    const scopes = visiblePane || document;
    // 可见表格
    const tables = [...scopes.querySelectorAll('table')].filter(t => t.getBoundingClientRect().width > 0);
    const tbl = tables[0] || null;
    const heads = tbl ? [...tbl.querySelectorAll('thead th')].map(th => (th.innerText||'').replace(/\\s+/g,'').trim()).filter(Boolean) : [];
    // 工单列表标记
    const marked = [...document.querySelectorAll('[data-svc-ticket-list]')].filter(el => el.getBoundingClientRect().width > 0);
    // 筛选区高度
    const card = scopes.querySelector('.ant-card');
    const form = card ? card.querySelector('.ant-form') : null;
    const filterH = form ? Math.round(form.getBoundingClientRect().height) : null;
    // 「筛选」按钮（工具栏）
    const btns = [...scopes.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(Boolean);
    const filterBtnCount = btns.filter(t => t === '筛选').length;
    // 操作列
    const tableBox = tbl ? (tbl.closest('.ant-table') || tbl.parentElement) : null;
    let opCol = null, opVisible = null;
    if (tbl) {
      const firstRow = tbl.querySelector('tbody tr');
      if (firstRow) {
        const tds = [...firstRow.querySelectorAll('td')];
        const last = tds.reverse().find(c => (c.innerText||'').trim() || c.querySelector('button'));
        if (last && tableBox) {
          const r = last.getBoundingClientRect(), box = tableBox.getBoundingClientRect();
          opCol = Math.round(r.width);
          opVisible = r.right <= box.left + tableBox.clientWidth + 1;
        }
      }
    }
    return {
      tab: ${JSON.stringify(t.title)},
      heads, headCount: heads.length,
      hasTicketNo: heads.includes('工单号'),
      hasStatus: heads.includes('状态'),
      isTicketList: marked.length > 0,
      tableLayout: tbl ? getComputedStyle(tbl).tableLayout : null,
      tableW: tbl ? Math.round(tbl.getBoundingClientRect().width) : null,
      boxW: tableBox ? tableBox.clientWidth : null,
      filterH, filterBtnCount,
      opColW: opCol, opVisible,
      actionBtns: btns.filter(x => ['处理工单','跟进','审核回执','详情'].includes(x)),
    };
  })()`);

  const img = await shot(`tab-${t.key}.png`);
  report.tabs.push({ tab: t.title, clicked, probe, img });
  console.log(`[${t.title}]`, JSON.stringify({ heads: probe.headCount, filterH: probe.filterH, fbtn: probe.filterBtnCount, op: probe.opColW, vis: probe.opVisible, act: probe.actionBtns }));
}

// ---------- 构建标记 ----------
report.buildStamp = await evalJs(`(() => {
  return window.__SVC_LAST_BUILD__ || null;
})()`).catch(() => null);

// Console 里的构建标记：重新加载一次抓 console
const consoleLines = [];
const onConsole = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (/service-ticket|构建/.test(txt)) consoleLines.push(txt);
  }
};
ws.addEventListener('message', onConsole);
await goto(`${BASE}/admin`);
await sleep(6000);
report.consoleBuild = consoleLines.slice(0, 10);

report.netErrors = netErrors.slice(0, 40);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n报告:', path.join(OUT, 'report.json'));
console.log('Console 构建标记:', report.consoleBuild);

ws.close();
try { child.kill(); } catch { /* */ }
process.exit(0);
