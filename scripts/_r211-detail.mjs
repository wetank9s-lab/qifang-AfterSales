process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnv, signIn } from './_b36-lib.mjs';
const BASE = 'http://127.0.0.1:13000';
const PAGE = process.argv.find(a => a.startsWith('--page='))?.split('=')[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = readEnv();
const tok = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
const port = 9100 + Math.floor(Math.random() * 80);
const prof = path.join(os.tmpdir(), `r21d-${Date.now()}`); fs.mkdirSync(prof, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const ch = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let u = null;
for (let i = 0; i < 100; i++) { try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { u = p.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
const ws = new WebSocket(u); await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/admin/` }); await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN',${JSON.stringify(tok)});localStorage.setItem('nocobase-token',${JSON.stringify(tok)});1`);
await send('Page.navigate', { url: `${BASE}/admin/${PAGE}` }); await sleep(8000);

const d = await ev(`(() => {
  const th = [...document.querySelectorAll('.ant-table-thead th')];
  const cols = th.map(n => (n.innerText||'').trim() || '(空)');
  const thW = th.map(n => Math.round(n.getBoundingClientRect().width));
  const row1 = document.querySelector('.ant-table-tbody tr.ant-table-row');
  const cells = row1 ? [...row1.querySelectorAll('td')].map(n => (n.innerText||'').replace(/\s+/g,' ').trim().slice(0,26)) : [];
  const actions = row1 ? [...row1.querySelectorAll('button, a')].map(n => (n.innerText||'').trim()).filter(Boolean) : [];
  // 筛选区：找所有带 label 的表单项
  const items = [...document.querySelectorAll('.ant-form-item')].map(n => {
    const lb = n.querySelector('.ant-form-item-label, label');
    return lb ? (lb.innerText||'').replace(/[:：]\s*$/,'').trim() : null;
  }).filter(Boolean);
  const btns = [...document.querySelectorAll('button')].map(n => (n.innerText||'').trim()).filter(Boolean);
  return { cols, thW, cells, actions, items, btns };
})()`);
console.log('列头  :', JSON.stringify(d.cols));
console.log('列宽  :', JSON.stringify(d.thW));
console.log('首行  :', JSON.stringify(d.cells));
console.log('行内按钮:', JSON.stringify(d.actions));
console.log('筛选项:', JSON.stringify(d.items));
console.log('页面按钮:', JSON.stringify(d.btns.slice(0, 14)));
ch.kill('SIGKILL'); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
