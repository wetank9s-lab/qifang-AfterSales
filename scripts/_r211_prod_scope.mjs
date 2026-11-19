// _r211_prod_scope.mjs —— 生产侧作用域反向验证 + 关键功能点检
// ① 历史售后档案页（有表但不是工单列表）必须零命中
// ② 工单详情只读打开（不改状态）
// ③ 菜单分组、Banner、H5 入口
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = 'https://sh.scqfls.cn';
const EMAIL = process.env.PROD_EMAIL || 'admin@nocobase.com';
const PASS = process.env.PROD_PASS;
const OUT = 'storage/tmp/r211/prod-after';

const port = 9999;
const profile = path.join(os.tmpdir(), `r211sc-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--ignore-certificate-errors', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 160; i++) {
  try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {}
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const net = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Network.responseReceived') { const s = m.params?.response?.status, u = m.params?.response?.url || '';
    if (s >= 400 && !/favicon|aiEmployees|aiConversations/.test(u)) net.push({ s, u: u.slice(0, 130) }); } });
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value; };
const goto = async u => { await send('Page.navigate', { url: u }); for (let i = 0; i < 90; i++) { await sleep(300); if (await js('document.readyState').catch(() => '') === 'complete') return; } };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); return n; };

await goto(`${BASE}/signin`);
for (let i = 0; i < 80; i++) { if (await js('document.querySelectorAll("input").length').catch(() => 0) >= 2) break; await sleep(500); }
await js(`(() => { const all=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null);
  const acc=all.find(i=>i.type!=='password')||all[0]; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(acc, ${JSON.stringify(EMAIL)}); acc.dispatchEvent(new Event('input',{bubbles:true})); acc.dispatchEvent(new Event('change',{bubbles:true}));
  const pw=[...document.querySelectorAll('input[type="password"]')].find(i=>i.offsetParent!==null);
  s.call(pw, ${JSON.stringify(PASS)}); pw.dispatchEvent(new Event('input',{bubbles:true})); pw.dispatchEvent(new Event('change',{bubbles:true}));
  [...document.querySelectorAll('button')].find(b=>/登录/.test(b.innerText))?.click(); return true; })()`);
for (let i = 0; i < 40; i++) { await sleep(500); if (!/signin/.test(await js('location.href'))) break; }
await sleep(2500);

const rep = { at: new Date().toISOString() };

// ---------- ① 作用域反向验证：历史售后档案（wcsgqh8e71w）----------
await goto(`${BASE}/admin/wcsgqh8e71w`);
await sleep(6500);
rep.archiveScope = await js(`(() => {
  const tbls=[...document.querySelectorAll('table')].filter(t=>t.getBoundingClientRect().width>0);
  const info=tbls.map(t=>{
    const heads=[...t.querySelectorAll('thead th')].map(th=>(th.innerText||'').replace(/\\s+/g,'').trim()).filter(Boolean);
    const box=t.closest('.ant-table')||t.parentElement;
    return { heads: heads.slice(0,8), marked: box?.hasAttribute('data-svc-ticket-list')||false,
             layout: getComputedStyle(t).tableLayout, colMarks: t.querySelectorAll('[data-svc-col]').length,
             w: Math.round(t.getBoundingClientRect().width) };
  });
  return { tableCount: tbls.length, info,
           markedBoxes: document.querySelectorAll('[data-svc-ticket-list]').length,
           anyColMark: document.querySelectorAll('[data-svc-col]').length };
})()`);
await shot('scope-archive.png');

// ---------- ② 工单详情（只读打开，不改状态）----------
await goto(`${BASE}/admin/tujyw08ec1d`);
await sleep(5500);
await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='详情'); if(b){b.click();return true;} return false; })()`);
await sleep(4500);
rep.detailDrawer = await js(`(() => {
  const dlg=document.querySelector('.ant-drawer-content, .ant-modal-content');
  if(!dlg) return {opened:false};
  const txt=(dlg.innerText||'').replace(/\\s+/g,' ').slice(0,400);
  const btns=[...dlg.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,12);
  return { opened:true, textHead: txt.slice(0,220), btns,
           hasReview: /客户评价|评价/.test(txt), hasTicketNo: /FW\\d/.test(txt) };
})()`);
await shot('detail-drawer.png');

// 关闭抽屉
await js(`(() => { const c=document.querySelector('.ant-drawer-close, .ant-modal-close'); if(c){c.click();return true;} return false; })()`);
await sleep(1200);

// ---------- ③ 菜单分组 ----------
await goto(`${BASE}/admin`);
await sleep(6000);
rep.menu = await js(`(() => {
  const groups=[...document.querySelectorAll('[data-svc-vgroup]')].map(g=>g.getAttribute('data-svc-vgroup'));
  const items=[...document.querySelectorAll('.ant-menu-item')].map(i=>(i.innerText||'').trim()).filter(Boolean);
  return { groups, itemCount: items.length, items: items.slice(0,20) };
})()`);
await shot('menu-admin.png');

// ---------- ④ H5 客户报修入口（匿名可达）----------
rep.netErrors = net.slice(0, 25);
fs.writeFileSync(path.join(OUT, 'scope.json'), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep, null, 1).slice(0, 3500));
ws.close(); try { child.kill(); } catch {}
process.exit(0);
