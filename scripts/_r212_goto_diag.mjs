/**
 * 直接 goto 工单列表 URL，验证列表本身是否正常（绕开菜单点击）。
 * 这一步的目的是把「菜单点击失效」与「列表渲染坏掉」两个问题**分开**。
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
const port = 9991;
const profile = path.join(os.tmpdir(), `r212g-${Date.now()}`);
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
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 250) }; return r.result?.result?.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); };

await send('Page.navigate', { url: `${BASE}/signin` });
for (let i = 0; i < 60; i++) { const n = await ev(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null).length`).catch(() => 0); if (n >= 2) break; await sleep(400); }
await sleep(600);
await ev(`(() => { const all=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null); const a=all.find(i=>i.type!=='password'), p=all.find(i=>i.type==='password'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(a,${JSON.stringify(EMAIL)}); a.dispatchEvent(new Event('input',{bubbles:true})); s.call(p,${JSON.stringify(PASS)}); p.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(400);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登录/.test(x.innerText)); if(b)b.click(); return !!b; })()`);
await sleep(6000);

const TARGET = '/admin/9ia6p1dx2wp';   // 所有工单
await send('Page.navigate', { url: `${BASE}${TARGET}` });
await sleep(8000);

const st = await ev(`(() => {
  const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
  const sc = pane || document;
  const tbl = [...sc.querySelectorAll('table')].find(t => t.getBoundingClientRect().width > 0);
  const rows = tbl ? [...tbl.querySelectorAll('tbody tr')] : [];
  const firstRow = rows[0] || null;
  return {
    url: location.href,
    tabTitles: [...document.querySelectorAll('.ant-tabs-tab')].map(t => (t.innerText||'').trim()),
    tableW: tbl ? Math.round(tbl.getBoundingClientRect().width) : null,
    rowCount: rows.length,
    primaryBtnTotal: document.querySelectorAll('[data-primary-action]').length,
    firstRowBtns: firstRow ? [...firstRow.querySelectorAll('[data-primary-action]')].map(b => ({
      kind: b.getAttribute('data-primary-action'),
      text: (b.innerText||'').trim(),
      title: b.getAttribute('title'),
      w: Math.round(b.getBoundingClientRect().width),
      h: Math.round(b.getBoundingClientRect().height),
    })) : null,
    firstRowText: firstRow ? (firstRow.innerText||'').replace(/\\n+/g,' | ').slice(0,150) : null,
    hasSvcList: document.querySelectorAll('[data-svc-ticket-list]').length,
  };
})()`);
console.log(JSON.stringify(st, null, 2));
await shot('goto-all-tickets.png');
ws.close(); try { child.kill(); } catch {}
process.exit(0);
