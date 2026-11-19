import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(process.argv[2] || '.probe/mutate-txt');
const PAGE = process.argv[3] || '/h5/technician/visit/TOKENAAAAAAAAAAAAAAAAAA';
const CHROME = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith('/h5/')) p = p.slice(4);
  if (p === '/' || p === '') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    return;
  }
  const ext = path.extname(fp);
  res.writeHead(200, {
    'content-type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html; charset=utf-8',
  });
  res.end(fs.readFileSync(fp));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const PORT = 9911;
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\dbg-${Date.now()}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 40; i++) {
  try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(400); }
}
if (!ver) { console.log('CDP 起不来'); process.exit(1); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const evs = [];
const send = (m, p = {}, s) => {
  const mid = ++id;
  const o = { id: mid, method: m, params: p };
  if (s) o.sessionId = s;
  ws.send(JSON.stringify(o));
  return new Promise((r, j) => pend.set(mid, { r, j }));
};
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.j(new Error(m.error.message)) : p.r(m.result);
    return;
  }
  if (m.method) evs.push(m);
});
await new Promise((r) => ws.addEventListener('open', r));

const t = await send('Target.getTargets');
const pt = t.targetInfos.find((x) => x.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: pt.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');

const base = `http://127.0.0.1:${srv.address().port}`;
await S('Page.navigate', { url: base + PAGE });
await sleep(2600);

for (const e of evs) {
  if (e.method === 'Runtime.exceptionThrown') {
    console.log('EXC:', String(JSON.stringify(e.params.exceptionDetails)).slice(0, 500));
  }
  if (e.method === 'Log.entryAdded') {
    const en = e.params.entry;
    console.log('LOG:', en.level, String(en.text).slice(0, 300));
  }
}
const r1 = await S('Runtime.evaluate', { expression: 'document.body.innerText.length', returnByValue: true });
const r2 = await S('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
const r3 = await S('Runtime.evaluate', { expression: 'document.querySelectorAll("script").length', returnByValue: true });
console.log('bodyLen =', JSON.stringify(r1.result.value));
console.log('href    =', JSON.stringify(r2.result.value));
console.log('scripts =', JSON.stringify(r3.result.value));
child.kill();
srv.close();
process.exit(0);
