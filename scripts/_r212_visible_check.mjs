/**
 * 只查一件事：操作列/主按钮**是否在可视容器内**。
 *
 * ⚠️ 为什么单独写：验收脚本里 visible 报了 false，但我知道表格 1174 = 容器 1174、
 *    scrollable=false，理论上按钮应该可见。先弄清是"真不可见"还是"判据用错了容器"。
 *    判据必须用**横向滚动容器**（.ant-table-content / .ant-table-body），
 *    不是 .ant-table（它自身不是裁剪者，getBoundingClientRect 更宽）。
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
const port = 9993;
const profile = path.join(os.tmpdir(), `r212v-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 160; i++) { try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()); const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) }; return r.result?.result?.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); };

await send('Page.navigate', { url: `${BASE}/signin` });
for (let i = 0; i < 60; i++) { const n = await ev(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null).length`).catch(() => 0); if (n >= 2) break; await sleep(400); }
await sleep(600);
await ev(`(() => { const all=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null); const a=all.find(i=>i.type!=='password'), p=all.find(i=>i.type==='password'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(a,${JSON.stringify(EMAIL)}); a.dispatchEvent(new Event('input',{bubbles:true})); s.call(p,${JSON.stringify(PASS)}); p.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(400);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登录/.test(x.innerText)); if(b)b.click(); return !!b; })()`);
await sleep(6000);
await send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
await sleep(8000);

const res = await ev(`(() => {
  // 切到「待处理」（handle 蓝底按钮最直观）
  const tab = [...document.querySelectorAll('.ant-tabs-tab')].find(t => (t.innerText||'').trim() === '待处理');
  if (tab) tab.click();
  return true;
})()`);
await sleep(3500);

const info = await ev(`(() => {
  const b = document.querySelector('[data-primary-action]');
  if (!b) return { ok: false };
  const r = b.getBoundingClientRect();
  // 依次找横向滚动容器
  const chain = [];
  let el = b.parentElement;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    chain.push({
      cls: (el.className||'').toString().slice(0, 60),
      overflowX: cs.overflowX,
      clientW: el.clientWidth,
      scrollW: el.scrollWidth,
      left: Math.round(el.getBoundingClientRect().left),
      right: Math.round(el.getBoundingClientRect().right),
    });
    el = el.parentElement;
  }
  const content = b.closest('.ant-table-content') || b.closest('.ant-table-body') || b.closest('.ant-table');
  const cr = content ? content.getBoundingClientRect() : null;
  return {
    ok: true,
    btn: { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height), text: (b.innerText||'').trim() },
    viewportW: window.innerWidth,
    contentCls: content ? (content.className||'').toString() : null,
    contentRect: cr ? { left: Math.round(cr.left), right: Math.round(cr.right), clientW: content.clientWidth, scrollW: content.scrollWidth } : null,
    // 正确判据：按钮右边界 <= 裁剪容器左边界 + clientWidth
    visibleByContent: cr ? (r.right <= cr.left + content.clientWidth + 1) : null,
    visibleByViewport: r.right <= window.innerWidth + 1 && r.left >= 0,
    chain: chain.slice(0, 8),
  };
})()`);
console.log(JSON.stringify(info, null, 2));
await shot('visible-check.png');
ws.close(); try { child.kill(); } catch {}
process.exit(0);
