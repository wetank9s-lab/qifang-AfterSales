/**
 * 找工单列表页：点菜单「所有工单」，记录点击前后 URL 与最终渲染。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:13000';
const EMAIL = 'uat.hqadmin@svc.local';
const PASS = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!PASS) { console.error('缺少口令：export R212_PASS=<本地 UAT 口令>'); process.exit(1); }
const OUT = 'storage/tmp/r212/diag';
fs.mkdirSync(OUT, { recursive: true });
const port = 9989;
const profile = path.join(os.tmpdir(), `r212nav-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 160; i++) {
  try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()); const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {}
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 200) };
  return r.result?.result?.value;
};
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); };

await send('Page.navigate', { url: `${BASE}/signin` });
for (let i = 0; i < 60; i++) { const n = await ev(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null).length`).catch(() => 0); if (n >= 2) break; await sleep(400); }
await sleep(600);
await ev(`(() => {
  const all = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
  const acc = all.find(i => i.type !== 'password'), pw = all.find(i => i.type === 'password');
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(acc, ${JSON.stringify(EMAIL)}); acc.dispatchEvent(new Event('input', { bubbles: true }));
  s.call(pw, ${JSON.stringify(PASS)}); pw.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(400);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /登录/.test(x.innerText)); if (b) b.click(); return !!b; })()`);
await sleep(6000);
console.log('after login:', await ev('location.href'));

// 菜单项结构
const menu = await ev(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  return [...sider.querySelectorAll('li')].map(li => {
    const a = li.querySelector('a');
    const titleEl = li.querySelector('.ant-menu-title-content');
    return {
      text: (li.textContent||'').trim(),
      titleContent: titleEl ? (titleEl.textContent||'').trim() : null,
      href: a ? a.getAttribute('href') : null,
      parentKey: li.closest('li[data-svc-vgroup]')?.getAttribute('data-svc-vgroup') || null,
      cls: li.className,
    };
  }).filter(x => x.text);
})()`);
console.log('\nMENU:');
for (const m of menu) console.log(JSON.stringify(m));

// 点「所有工单」
const r1 = await ev(`(() => {
  const sider = document.querySelector('.ant-layout-sider');
  const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === '所有工单');
  if (!li) return { ok: false };
  const a = li.querySelector('a');
  if (a) { return { ok: true, href: a.getAttribute('href'), via: 'a.click' }; }
  // 没有 a 就点内层
  const inner = li.querySelector('.ant-menu-title-content') || li;
  inner.click();
  return { ok: true, via: 'inner.click', href: null };
})()`);
console.log('\nclick result:', JSON.stringify(r1));
await sleep(5000);
console.log('url after click:', await ev('location.href'));
const state = await ev(`(() => {
  const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
  const sc = pane || document;
  const tbls = [...sc.querySelectorAll('table')].map(t => ({ w: Math.round(t.getBoundingClientRect().width), rows: t.querySelectorAll('tbody tr').length }));
  return {
    url: location.href,
    tables: tbls,
    primaryBtns: document.querySelectorAll('[data-primary-action]').length,
    tabs: [...document.querySelectorAll('.ant-tabs-tab')].map(t => (t.innerText||'').trim()),
    title: location.pathname,
    bodyStart: (document.body.innerText||'').slice(0, 200).replace(/\\n+/g,' | '),
  };
})()`);
console.log('\nstate:', JSON.stringify(state, null, 2));
await shot('nav-after-all-tickets.png');

ws.close(); try { child.kill(); } catch {}
process.exit(0);
