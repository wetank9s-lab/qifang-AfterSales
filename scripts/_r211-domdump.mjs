process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process'; import { readEnv, signIn } from './_b36-lib.mjs';
const BASE = 'http://127.0.0.1:13000'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = readEnv(); const tok = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
const port = 9300 + Math.floor(Math.random() * 50);
const prof = path.join(os.tmpdir(), `r21dd-${Date.now()}`); fs.mkdirSync(prof, { recursive: true });
const ch = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new',
  `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-gpu',
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let u = null;
for (let i = 0; i < 100; i++) { try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { u = p.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
const ws = new WebSocket(u); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `${BASE}/admin/` }); await sleep(2500);
await ev('localStorage.setItem("NOCOBASE_TOKEN",' + JSON.stringify(tok) + ');localStorage.setItem("nocobase-token",' + JSON.stringify(tok) + ');1');
await send('Page.navigate', { url: `${BASE}/admin/` }); await sleep(8000);

const expr = `(() => {
  const hits = [...document.querySelectorAll('.ant-layout-sider *')].filter((n) =>
    (n.innerText || '').trim() === '日常业务' || (n.innerText || '').trim() === '管理与设置');
  if (!hits.length) return { none: true, siderTxt: (document.querySelector('.ant-layout-sider')||{}).innerText };
  return hits.slice(0, 8).map((n) => ({
    tag: n.tagName, cls: String(n.className).replace(/css-[a-z0-9]+/g, '').trim().slice(0, 90),
    id: n.getAttribute('data-menu-id') || '', role: n.getAttribute('role') || '',
  }));
})()`;
const d = await ev(expr);
if (!d || d.err) { console.log('ERR', JSON.stringify(d)); } else if (d.none) { console.log('侧栏文本:', JSON.stringify((d.siderTxt||'').slice(0,300))); } else { for (const r of d) console.log(JSON.stringify(r)); }
ch.kill('SIGKILL'); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
