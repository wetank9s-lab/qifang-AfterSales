// _r211_prod_opcol.mjs —— 精确测量操作列可见性（用户点名的验收项）
// 判据（DEV-267 教训）：td.right <= 容器.left + 容器.clientWidth
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = 'https://sh.scqfls.cn';
const EMAIL = process.env.PROD_EMAIL || 'admin@nocobase.com';
const PASS = process.env.PROD_PASS;
const TABS = ['全部', '待处理', '处理中', '待门店确认', '待客户评价', '已结束'];
const OUT = 'storage/tmp/r211/prod-after';

const port = 9988;
const profile = path.join(os.tmpdir(), `r211oc-${Date.now()}`);
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
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value; };
const goto = async u => { await send('Page.navigate', { url: u }); for (let i = 0; i < 90; i++) { await sleep(300); if (await js('document.readyState').catch(() => '') === 'complete') return; } };

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

const results = [];
for (const tab of TABS) {
  await goto(`${BASE}/admin/tujyw08ec1d`);
  await sleep(5000);
  await js(`(() => { const ts=[...document.querySelectorAll('.ant-tabs-tab')];
    const t=ts.find(x=>(x.innerText||'').trim()===${JSON.stringify(tab)})||ts.find(x=>(x.innerText||'').includes(${JSON.stringify(tab)}));
    if(t) t.click(); return !!t; })()`);
  await sleep(3500);

  const r = await js(`(() => {
    const pane=[...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p=>p.getAttribute('aria-hidden')!=='true');
    const scope=pane||document;
    const tbl=[...scope.querySelectorAll('table')].find(t=>t.getBoundingClientRect().width>0);
    if(!tbl) return {err:'no table'};
    const box=tbl.closest('.ant-table')||tbl.parentElement;
    const content=tbl.closest('.ant-table-content')||tbl.parentElement;
    const b=box.getBoundingClientRect();
    const c=content.getBoundingClientRect();
    const clampR=b.left+box.clientWidth;
    const clampC=c.left+content.clientWidth;
    // 找操作列的 th 与首行 td（用语义属性，不用序号）
    const thOp=tbl.querySelector('thead th[data-svc-col="op"]');
    const tdOp=tbl.querySelector('tbody td[data-svc-col="op"]');
    const thNo=tbl.querySelector('thead th[data-svc-col="no"]');
    const tdNo=tbl.querySelector('tbody td[data-svc-col="no"]');
    const rect=e=>{ if(!e) return null; const q=e.getBoundingClientRect(); return {l:Math.round(q.left),r:Math.round(q.right),w:Math.round(q.width)}; };
    const rOp=rect(tdOp), rThOp=rect(thOp), rNo=rect(tdNo), rThNo=rect(thNo);
    // 列语义标记计数
    const markedTh=[...tbl.querySelectorAll('thead th[data-svc-col]')].map(e=>e.getAttribute('data-svc-col'));
    const markedTd=[...tbl.querySelectorAll('tbody td[data-svc-col]')].length;
    // 工单号文本是否被裁：内层 span 宽度 vs td 内容宽
    let noTrunc=null, noTextW=null;
    if(tdNo){ const sp=tdNo.querySelector('a,span')||tdNo; noTextW=Math.round(sp.getBoundingClientRect().width); noTrunc=noTextW<=rNo.w+1; }
    // 横向是否可滚动
    const scrollable = content.scrollWidth > content.clientWidth+1;
    return {
      tab: ${JSON.stringify(tab)},
      markedTh, markedTdCount: markedTd,
      thOp:rThOp, tdOp:rOp, thNo:rThNo, tdNo:rNo,
      boxLeft:Math.round(b.left), boxClamp:Math.round(clampR), boxClientW:box.clientWidth,
      contentClamp:Math.round(clampC), contentClientW:content.clientWidth,
      opVisibleInBox: rOp ? (rOp.r <= clampR+1) : null,
      opVisibleInContent: rOp ? (rOp.r <= clampC+1) : null,
      noTextW, noTrunc, scrollable,
      tableW: Math.round(tbl.getBoundingClientRect().width),
    };
  })()`);
  results.push(r);
  console.log(`[${tab}]`, JSON.stringify(r));
}

fs.writeFileSync(path.join(OUT, 'opcol.json'), JSON.stringify(results, null, 2));
ws.close(); try { child.kill(); } catch {}
process.exit(0);
