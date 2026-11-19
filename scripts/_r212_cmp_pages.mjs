/**
 * 对比「我的门店工单」/admin/tujyw08ec1d 与「所有工单」/admin/9ia6p1dx2wp
 * 目的：确认四类主按钮**哪一页有**、页面结构差异在哪。
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
const port = 9992;
const profile = path.join(os.tmpdir(), `r212c-${Date.now()}`);
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

const PAGES = [
  { key: 'mytickets', uid: '/admin/tujyw08ec1d', name: '我的门店工单' },
  { key: 'alltickets', uid: '/admin/9ia6p1dx2wp', name: '所有工单' },
];

for (const pg of PAGES) {
  await send('Page.navigate', { url: `${BASE}${pg.uid}` });
  await sleep(9000);
  const st = await ev(`(() => {
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')].map(t => (t.innerText||'').trim());
    const tbl = [...document.querySelectorAll('table')].find(t => t.getBoundingClientRect().width > 0);
    const rows = tbl ? [...tbl.querySelectorAll('tbody tr')] : [];
    const kinds = {};
    for (const b of document.querySelectorAll('[data-primary-action]')) {
      const k = b.getAttribute('data-primary-action');
      const r = b.getBoundingClientRect();
      kinds[k] = kinds[k] || { n: 0, text: (b.innerText||'').trim(), title: b.getAttribute('title'), w: Math.round(r.width), h: Math.round(r.height) };
      kinds[k].n += 1;
    }
    return {
      url: location.href,
      heading: (document.querySelector('.ant-pro-page-container-warp h1, h1')?.innerText || '').trim(),
      tabs,
      tableRows: rows.length,
      primaryKinds: kinds,
      primaryTotal: document.querySelectorAll('[data-primary-action]').length,
      filterFormH: (() => { const f = document.querySelector('.ant-card .ant-form'); return f ? Math.round(f.getBoundingClientRect().height) : null; })(),
    };
  })()`);
  console.log(`\n===== ${pg.name} (${pg.uid}) =====`);
  console.log(JSON.stringify(st, null, 2));
  await shot(`cmp-${pg.key}.png`);
}

ws.close(); try { child.kill(); } catch {}
process.exit(0);
