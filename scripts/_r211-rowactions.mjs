// _r211-rowactions.mjs —— 抓「列表行内操作列」的**真实按钮文本**（唯一可信判据）
//
// 为什么不能只看配置：配置里挂的是 TicketPrimaryActionModel，但页面上到底渲染出
// 几个按钮、文案是什么，取决于模型 render() + 状态值。必须看 DOM。
//
// 用法：
//   node scripts/_r211-rowactions.mjs <routePath> [截图文件名]
//   例：node scripts/_r211-rowactions.mjs /admin/qbr4apqripv store-rows.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const routePath = process.argv[2] || '/admin/';
const shotName = process.argv[3] || '';
const tok = fs.readFileSync('storage/tmp/r211/.tok_uat_hqadmin', 'utf8').trim();
const port = 9961;
const profile = path.join(os.tmpdir(), `r211ra-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 100; i++) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 等 Chrome 起来 */ }
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
  return r?.result?.result?.value ?? JSON.stringify(r?.result?.exceptionDetails || r?.result);
};

await send('Page.enable');
await send('Runtime.enable');

// 先落地，再塞 token，再进目标页（顺序反了会被打回 /signin）
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(4000);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});
          localStorage.setItem('nocobase-token',${JSON.stringify(tok)});true`);
// ⚠️ 必须等登录态真正落地（_r211-check.mjs 能成就是因为它在 /admin/ 上等到 SPA 自己跳页）。
//    直接 navigate 到深链有时早于 token 被 SPA 读到 ⇒ 被踢回 /signin。
await send('Page.navigate', { url: 'http://127.0.0.1:13000/admin/' });
await sleep(12000);
const landed = await ev('location.pathname');
if (String(landed).includes('signin')) {
  console.log('LOGIN FAILED ->', landed);
  child.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力 */ }
  process.exit(2);
}
// ⚠️ 直连 /admin/<uid> 会被 SPA 踢回默认页（实测）。改为**点侧栏菜单**，
//    这也更贴近真实用户路径 —— 我们要验的是"员工看到的页面"，不是路由表。
if (routePath && routePath !== '/admin/') {
  const clicked = await ev(`(() => {
    const want = ${JSON.stringify(routePath)};
    const items = [...document.querySelectorAll('.ant-pro-base-menu-inline-menu-item, .ant-layout-sider li, .ant-menu-item, .ant-menu-submenu-title')];
    const hit = items.find(n => (n.innerText || '').trim().startsWith(want));
    if (!hit) return 'NOT_FOUND:' + items.map(n => (n.innerText || '').trim()).slice(0, 20).join('|');
    hit.click();
    return 'CLICKED:' + (hit.innerText || '').trim();
  })()`);
  console.log('nav ->', clicked);
  await sleep(12000);
}

const out = await ev(`(() => {
  const NL = String.fromCharCode(10);
  const T = (n) => (n.innerText || '').trim().split(NL).map(s => s.trim()).filter(Boolean).join(' / ');

  // 行：table tbody tr
  const rows = [...document.querySelectorAll('table tbody tr.ant-table-row')];
  const data = rows.slice(0, 6).map((tr) => {
    const cells = [...tr.querySelectorAll('td')];
    return cells.map((td) => T(td));
  });

  // 操作列真正的按钮：按「单元格内 .ant-btn 或 a」抓，连文案一起
  const actBtn = [];
  for (const tr of rows.slice(0, 3)) {
    const tds = [...tr.querySelectorAll('td')];
    for (const td of tds) {
      const btns = [...td.querySelectorAll('.ant-btn, a')]
        .map((b) => (b.innerText || '').trim())
        .filter(Boolean);
      if (btns.length && btns.every((x) => x.length <= 8)) actBtn.push(btns);
    }
  }

  // 表头顺序（列序判据）
  const head = [...document.querySelectorAll('table thead th')].map(T);

  // 是否存在「更多」类按钮 / 蓝色药丸
  const moreText = [...document.querySelectorAll('button, a')]
    .map((b) => (b.innerText || '').trim())
    .filter((t) => /更多|查看完整|More/.test(t));
  const pills = [...document.querySelectorAll('table tbody .ant-btn-primary, table tbody .ant-btn')]
    .map((b) => {
      const cs = getComputedStyle(b);
      return { text: (b.innerText || '').trim(), h: Math.round(b.getBoundingClientRect().height),
               radius: cs.borderRadius, bg: cs.backgroundColor };
    }).slice(0, 12);

  return JSON.stringify({ url: location.pathname, head, rows: data, actBtn, moreText, pills }, null, 1);
})()`);
console.log(out);

if (shotName) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const b = Buffer.from(r.result.data, 'base64');
  const dst = path.join('storage/tmp/r211/shots', shotName);
  fs.writeFileSync(dst, b);
  console.log('shot', dst, b.length, 'B');
}

child.kill('SIGKILL');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
