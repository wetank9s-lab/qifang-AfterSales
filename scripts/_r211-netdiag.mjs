process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnv, signIn } from './_b36-lib.mjs';

const BASE = process.env.R21_BASE || 'http://127.0.0.1:13000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = readEnv();
const tok = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);

const port = 9820 + Math.floor(Math.random() * 60);
const profile = path.join(os.tmpdir(), `r211diag-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
  `--window-size=1440,900`, 'about:blank'], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 100; i += 1) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let id = 0; const pend = new Map(); const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  events.push(m);
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Network.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: `${BASE}/admin/` });
await sleep(3000);
await send('Runtime.evaluate', { expression: `localStorage.setItem('NOCOBASE_TOKEN', ${JSON.stringify(tok)});localStorage.setItem('nocobase-token', ${JSON.stringify(tok)});true` });
await send('Page.navigate', { url: `${BASE}/admin/wz4qkejuvd6` });
await sleep(9000);

const reqs = events.filter((e) => e.method === 'Network.responseReceived').map((e) => {
  const r = e.params.response; return { s: r.status, u: r.url.replace(BASE, '') };
});
const bad = reqs.filter((r) => r.s >= 400);
console.log('请求总数', reqs.length, '非2xx', bad.length);
for (const b of bad.slice(0, 20)) console.log('  ', b.s, b.u.slice(0, 110));
const cons = events.filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Runtime.exceptionThrown');
for (const c of cons.slice(0, 10)) {
  const p = c.params;
  const txt = p.args ? p.args.map((a) => a.value ?? a.description ?? '').join(' ') : (p.exceptionDetails?.text ?? '');
  console.log('  [log]', String(txt).slice(0, 160));
}
const r = await send('Runtime.evaluate', { expression: 'document.body.innerHTML.length', returnByValue: true });
console.log('body innerHTML 长度', r.result?.result?.value);
child.kill('SIGKILL');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(0);
