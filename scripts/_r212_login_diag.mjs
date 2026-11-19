/**
 * 登录诊断 —— 只回答一个问题：本地环境的登录页长什么样、卡在哪一步。
 * 不写业务代码，只取 DOM + 截图。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:13000';
const OUT = 'storage/tmp/r212/diag';
fs.mkdirSync(OUT, { recursive: true });
const port = 9988;
const profile = path.join(os.tmpdir(), `r212diag-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 160; i++) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* */ }
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};

await send('Page.navigate', { url: `${BASE}/signin` });
await sleep(6000);
const info = await evalJs(`(() => {
  const inputs = [...document.querySelectorAll('input')];
  const btns = [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim());
  return {
    url: location.href, title: document.title,
    inputCount: inputs.length,
    inputs: inputs.map(i => ({ type: i.type, name: i.name, ph: i.placeholder, vis: i.offsetParent !== null })),
    buttons: btns,
    bodyText: (document.body.innerText||'').slice(0, 600),
    sider: !!document.querySelector('.ant-layout-sider'),
  };
})()`);
console.log(JSON.stringify(info, null, 2));

const s = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'signin.png'), Buffer.from(s.result.data, 'base64'));

ws.close(); try { child.kill(); } catch {}
process.exit(0);
