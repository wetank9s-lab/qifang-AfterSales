/**
 * 在**生产 R2.1.1**（https://sh.scqfls.cn）上用真实浏览器点击左侧菜单，
 * 确认「点菜单不导航」这个 B 类问题是否也存在于线上。
 *
 * ⚠️ 只点菜单，不点任何会改数据的按钮。
 * ⚠️ 判据是 **点击后 URL 是否变化 + 页面标题是否切换**，不是"看起来渲染了什么"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = 'https://sh.scqfls.cn';
const EMAIL = process.env.PROD_EMAIL || 'admin@nocobase.com';
const PASS = process.env.PROD_PASS;
const OUT = 'storage/tmp/r212/prod-nav';
fs.mkdirSync(OUT, { recursive: true });

const port = 9995;
const profile = path.join(os.tmpdir(), `r212prodnav-${Date.now()}`);
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

// ---------- 登录 ----------
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
  s.call(a, ${JSON.stringify(EMAIL)}); a.dispatchEvent(new Event('input', { bubbles: true }));
  s.call(p, ${JSON.stringify(PASS)}); p.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(400);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /登录|Sign/i.test(x.innerText)); if (b) b.click(); return !!b; })()`);
for (let i = 0; i < 50; i++) {
  await sleep(500);
  if (!/\/signin/.test(await ev('location.href'))) break;
}
await sleep(6000);
const afterLogin = await ev('location.href');
console.log('登录后 URL:', afterLogin);
if (/\/signin/.test(afterLogin)) { console.error('登录失败'); ws.close(); try { child.kill(); } catch {} process.exit(1); }

// ---------- 菜单结构（先确认分组是否生效） ----------
const menuInfo = await ev(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  if (!sider) return { ok: false };
  const boxes = [...sider.querySelectorAll('li[data-svc-vgroup]')];
  return {
    ok: true,
    groups: boxes.map(b => ({
      key: b.getAttribute('data-svc-vgroup'),
      title: (b.querySelector(':scope > .ant-menu-submenu-title')?.innerText || '').trim(),
      items: [...b.querySelectorAll('ul.ant-menu-sub li')].map(li => (li.textContent||'').trim()).filter(Boolean),
      collapsed: b.getAttribute('data-collapsed') === '1',
    })),
  };
})()`);
console.log('分组:', JSON.stringify(menuInfo.groups, null, 1));
await shot('prod-menu.png');

// ---------- 逐个点击菜单项，看 URL 是否变化 ----------
async function clickMenu(title) {
  const before = await ev('location.href');
  const pre = await ev(`(() => {
    const sider = document.querySelector('.ant-layout-sider');
    const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(title)});
    if (!li) return { found: false };
    const a = li.querySelector('a');
    return { found: true, href: a ? a.getAttribute('href') : null,
             inGroup: li.closest('li[data-svc-vgroup]')?.getAttribute('data-svc-vgroup') || null };
  })()`);
  // 用**真实鼠标事件**点中心点，而不是 el.click()：更接近员工实际操作
  const box = await ev(`(() => {
    const sider = document.querySelector('.ant-layout-sider');
    const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(title)});
    if (!li) return null;
    const t = li.querySelector('.ant-menu-title-content') || li;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!box || !box.w) return { title, clicked: false, reason: 'not-visible', pre };

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(3500);

  const after = await ev('location.href');
  const heading = await ev(`(document.querySelector('.ant-pro-page-container-warp h1, h1')?.innerText || '').trim()`);
  return { title, clicked: true, before, after, navigated: before !== after, heading, pre };
}

const results = [];
for (const t of ['我的门店工单', '所有工单', '售后服务工作台']) {
  const r = await clickMenu(t);
  results.push(r);
  console.log(`\n[点击 ${t}]`, JSON.stringify(r, null, 1));
  await shot(`prod-click-${t}.png`);
}

// 展开管理与设置后点两项
await ev(`(() => {
  const h = document.querySelector('li[data-svc-vgroup="admin"] > .ant-menu-submenu-title');
  if (h) h.click(); return !!h;
})()`);
await sleep(1500);

for (const t of ['派工记录', '工单事件时间线']) {
  const r = await clickMenu(t);
  results.push(r);
  console.log(`\n[点击 ${t}]`, JSON.stringify(r, null, 1));
  await shot(`prod-click-${t}.png`);
}

fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ at: new Date().toISOString(), menuInfo, results }, null, 2));
const failed = results.filter(r => r.clicked && !r.navigated);
console.log('\n=== 结论 ===');
console.log('点击但未导航的菜单项:', failed.map(r => r.title).join(' / ') || '（无）');
ws.close();
try { child.kill(); } catch {}
process.exit(0);
