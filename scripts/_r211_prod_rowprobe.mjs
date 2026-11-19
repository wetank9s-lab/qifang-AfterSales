// _r211_prod_rowprobe.mjs —— 生产侧逐行按钮取证（精确定位，避免凭截图误判）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = 'https://sh.scqfls.cn';
const EMAIL = process.env.PROD_EMAIL || 'admin@nocobase.com';
const PASS = process.env.PROD_PASS;
const OUT = 'storage/tmp/r211/prod-after';
fs.mkdirSync(OUT, { recursive: true });

const port = 9977;
const profile = path.join(os.tmpdir(), `r211rp-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--ignore-certificate-errors', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const goto = async (u) => { await send('Page.navigate', { url: u }); for (let i = 0; i < 90; i++) { await sleep(300); if (await js('document.readyState').catch(() => '') === 'complete') return; } };

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

await goto(`${BASE}/admin/tujyw08ec1d`);
await sleep(6000);

const res = await js(`(() => {
  const visPane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
  const scope = visPane || document;
  const tbl = [...scope.querySelectorAll('table')].find(t => t.getBoundingClientRect().width > 0);
  if (!tbl) return { err: 'no table' };
  const box = tbl.closest('.ant-table') || tbl.parentElement;
  const heads = [...tbl.querySelectorAll('thead th')].map(th => (th.innerText||'').replace(/\\s+/g,'').trim());
  const rows = [...tbl.querySelectorAll('tbody tr')];
  const out = [];
  for (let ri = 0; ri < Math.min(rows.length, 25); ri++) {
    const tr = rows[ri];
    const tds = [...tr.querySelectorAll('td')];
    // 第一列是复选框，第二列是序号，第三列是操作，第四列是工单号
    const cellInfo = tds.map((td, ci) => {
      const btns = [...td.querySelectorAll('button')].map(b => ({
        txt: (b.innerText||'').replace(/\\s+/g,'').trim(),
        cls: b.className.slice(0, 80),
        pk: b.getAttribute('data-primary-action') || null,
        vis: b.getBoundingClientRect().width > 0,
      })).filter(b => b.txt || b.pk);
      const txt = (td.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 30);
      return { ci, txt, btns };
    });
    // 操作列定位：含 data-primary-action 或含 处理工单/跟进/审核回执/详情 的 td
    const opCell = cellInfo.find(c => c.btns.length > 0);
    // 工单号：匹配 FW 开头
    const noCell = cellInfo.find(c => /^FW\\d/.test(c.txt.replace(/\\s/g,'')));
    const statusCell = cellInfo.find(c => /^(待处理|处理中|待门店确认|待客户评价|已结束|已取消)$/.test(c.txt));
    out.push({
      row: ri + 1,
      opBtns: opCell ? opCell.btns.map(b => b.txt || b.pk) : [],
      opColIndex: opCell ? opCell.ci : null,
      ticketNo: noCell ? noCell.txt : null,
      status: statusCell ? statusCell.txt : null,
    });
  }
  // 操作列宽度与可见性
  const firstOp = rows[0] ? [...rows[0].querySelectorAll('td')].find(td => td.querySelector('button')) : null;
  let opW = null, opRight = null, boxRight = null, opVisible = null;
  if (firstOp) {
    const r = firstOp.getBoundingClientRect(), b = box.getBoundingClientRect();
    opW = Math.round(r.width); opRight = Math.round(r.right);
    boxRight = Math.round(b.left + box.clientWidth);
    opVisible = r.right <= b.left + box.clientWidth + 1;
  }
  // 工单号列宽度与文本宽度
  const noTh = [...tbl.querySelectorAll('thead th')].find(th => (th.innerText||'').replace(/\\s/g,'') === '工单号');
  const cols = [...tbl.querySelectorAll('colgroup > col')].map(c => c.style.width || getComputedStyle(c).width);
  return { heads, rowCount: rows.length, rows: out, opW, opRight, boxRight, opVisible, noColW: noTh ? Math.round(noTh.getBoundingClientRect().width) : null, cols };
})()`);

fs.writeFileSync(path.join(OUT, 'rowprobe.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 1).slice(0, 4000));
ws.close(); try { child.kill(); } catch {}
process.exit(0);
