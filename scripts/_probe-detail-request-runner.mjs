#!/usr/bin/env node
/**
 * _probe-detail-request-runner.mjs —— CDP 抓包 worker（被 probe-detail-request.mjs 调用）
 *
 * 拆成独立文件的理由：这脚本要**生成/内联浏览器上下文里的表达式**。
 * 若把它整体塞进父脚本的一个模板字符串，反斜杠与 `${}` 要穿两层转义 ——
 * 本项目已经在 DEV-66 / DEV-67 上被这件事咬过两次（"探针自己造出来的故障"）。
 * **凡是探针，先把它变成真正的文件。**
 *
 * 输入：环境变量 PROBE_CHROME / PROBE_BASE / PROBE_TARGET / PROBE_EMAIL / PROBE_PASSWORD / PROBE_ROW
 * 输出：stdout 一行 `NETPROBE|{json}`
 */
import { spawn } from 'node:child_process';

const CHROME = process.env.PROBE_CHROME;
const BASE = process.env.PROBE_BASE;
const TARGET = process.env.PROBE_TARGET;
const EMAIL = process.env.PROBE_EMAIL;
const PASSWORD = process.env.PROBE_PASSWORD;
const ROW_INDEX = Number(process.env.PROBE_ROW || '0');
/** 指定工单号时按**工单号定位行**（比行号稳：行的顺序会随排序变） */
const TICKET = process.env.PROBE_TICKET || '';

const PORT = 9800 + Math.floor(Math.random() * 150);
const userDir = `${process.env.TEMP || '/tmp'}\\cdp-netprobe-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

const reqs = new Map(); // requestId -> {url, method, type}
const resps = []; // {requestId,url,method,status,mime}
const consoleMsgs = [];
const pageExceptions = [];

function bail(obj) {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  console.log(`NETPROBE|${JSON.stringify(obj)}`);
  process.exit(0);
}

let ver = null;
for (let i = 0; i < 60; i++) {
  try {
    ver = await httpJson('/json/version');
    break;
  } catch {
    await sleep(500);
  }
}
if (!ver) bail({ ok: false, why: 'CDP 未启动' });

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const mid = ++id;
  const msg = { id: mid, method, params: params ?? {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}

const eventHandlers = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(`${m.method}: ${m.error.message}`));
    else p.res(m.result);
    return;
  }
  if (m.method) {
    for (const h of eventHandlers) {
      try {
        h(m);
      } catch {
        /* 事件处理不得影响主流程 */
      }
    }
  }
});
await new Promise((r) => ws.addEventListener('open', r));

const targets = await send('Target.getTargets', {});
const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
if (!pageTarget) bail({ ok: false, why: '无 page target' });
const { sessionId } = await send('Target.attachToTarget', {
  targetId: pageTarget.targetId,
  flatten: true,
});
const ctx = (method, params) => send(method, params, sessionId);

await ctx('Runtime.enable');
await ctx('Page.enable');
await ctx('Network.enable', {
  maxTotalBufferSize: 200 * 1024 * 1024,
  maxResourceBufferSize: 10 * 1024 * 1024,
});
await ctx('Log.enable').catch(() => {});

eventHandlers.push((m) => {
  if (m.method === 'Network.requestWillBeSent') {
    const p = m.params;
    reqs.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type });
  } else if (m.method === 'Network.responseReceived') {
    const p = m.params;
    const r = reqs.get(p.requestId) || { url: p.response.url, method: '?' };
    resps.push({
      requestId: p.requestId,
      url: p.response.url,
      method: r.method,
      status: p.response.status,
      mime: p.response.mimeType,
    });
  } else if (m.method === 'Network.loadingFailed') {
    const p = m.params;
    const r = reqs.get(p.requestId) || {};
    resps.push({
      requestId: p.requestId,
      url: r.url || '?',
      method: r.method || '?',
      status: 'FAILED',
      mime: p.errorText,
    });
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const p = m.params;
    const text = (p.args || [])
      .map((a) => a.value ?? a.description ?? a.type)
      .join(' ')
      .slice(0, 500);
    consoleMsgs.push({ kind: p.type, text });
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageExceptions.push(String(d?.exception?.description || d?.text || '').slice(0, 500));
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') {
      consoleMsgs.push({ kind: `log:${e.level}`, text: `${e.text || ''} ${e.url || ''}`.slice(0, 500) });
    }
  }
});

async function ev(expression) {
  const r = await ctx('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.result?.subtype === 'error') {
    throw new Error(`evaluate 抛错：${String(r.result.description).split('\n')[0]}`);
  }
  return r?.result?.value;
}

// ---------------------------------------------------------------- 登录
await ctx('Page.navigate', { url: `${BASE}/signin` });
await sleep(18000);
const inputs = await ev("document.querySelectorAll('input').length");
if (inputs < 2) bail({ ok: false, why: `登录页未就绪（inputs=${inputs}）` });

await ev(
  `(() => {
     const ins = [...document.querySelectorAll('input')];
     const set = (el, v) => {
       const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
       s.call(el, v);
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
     };
     set(ins[0], ${JSON.stringify(EMAIL)});
     set(ins[1], ${JSON.stringify(PASSWORD)});
     return ins.slice(0, 2).map((x) => x.value).join('|');
   })()`,
);
await sleep(1200);
const clickedLogin = await ev(
  `(() => {
     const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('登录'));
     if (!b) return 'NOT_FOUND';
     b.click();
     return 'CLICKED';
   })()`,
);
if (clickedLogin !== 'CLICKED') bail({ ok: false, why: '未找到登录按钮' });

{
  const dl = Date.now() + 45000;
  while (Date.now() < dl) {
    await sleep(2000);
    const u = await ev('location.href');
    if (String(u).indexOf('/signin') === -1) break;
  }
}
const afterLoginUrl = await ev('location.href');
if (String(afterLoginUrl).indexOf('/signin') !== -1) {
  bail({ ok: false, why: '登录失败（仍停在 /signin）—— 检查口令' });
}

// ---------------------------------------------------------------- 落地目标页
if (String(afterLoginUrl) !== BASE + TARGET) {
  await ctx('Page.navigate', { url: BASE + TARGET });
  await sleep(15000);
}
{
  const dl = Date.now() + 40000;
  while (Date.now() < dl) {
    const n = await ev("document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length");
    if (Number(n) > 0) break;
    await sleep(2500);
  }
}

const rowInfo = await ev(
  `(() => {
     const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
     return JSON.stringify({
       rows: rows.length,
       texts: rows.map((r) => {
         const t = (r.innerText || '').replace(/\\s+/g, ' ').trim();
         const m = t.match(/FW[0-9]{8}-[0-9]{4}/);
         return (m ? m[0] : '?') + ' | ' + t.slice(0, 90);
       }),
     });
   })()`,
);
const rows = JSON.parse(rowInfo || '{"rows":0,"texts":[]}');

// ---------------------------------------------------------------- 点「详情」
const clickInfo = await ev(
  `(() => {
     const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
     const wanted = ${JSON.stringify(TICKET)};
     const row = wanted
       ? rows.find((r) => (r.innerText || '').indexOf(wanted) !== -1)
       : rows[${ROW_INDEX}];
     if (!row) return 'NO_ROW';
     const b = [...row.querySelectorAll('button, a')].find((x) => ((x.innerText || '').trim()) === '详情');
     if (!b) return 'NO_BTN';
     b.click();
     return 'CLICKED';
   })()`,
);

let drawerText = '';
let drawerSeen = false;
{
  const dl = Date.now() + 25000;
  while (Date.now() < dl) {
    await sleep(2000);
    const t = await ev(
      "(() => { const el = document.querySelector('.ant-drawer'); return el ? (el.innerText || '') : ''; })()",
    );
    if (t && String(t).length > 0) {
      drawerSeen = true;
      drawerText = String(t);
      break;
    }
  }
}
await sleep(3000);

// ---------------------------------------------------------------- 取响应体
const isInteresting = (u) =>
  /svc:|svc\/|timeline|visits|serviceTickets|serviceVisits|\/api\//.test(String(u));
const interesting = resps.filter((r) => isInteresting(r.url));
for (const r of interesting) {
  if (!r.requestId) continue;
  try {
    const b = await ctx('Network.getResponseBody', { requestId: r.requestId });
    r.body = (b.base64Encoded ? '(base64) ' : '') + String(b.body || '').slice(0, 800);
  } catch (e) {
    r.body = `(取不到响应体：${String(e.message).slice(0, 90)})`;
  }
}

child.kill();
console.log(
  `NETPROBE|${JSON.stringify({
    ok: true,
    afterLoginUrl,
    rows,
    clickInfo,
    drawerSeen,
    drawerText: drawerText.slice(0, 600),
    requests: interesting,
    allCount: resps.length,
    consoleMsgs: consoleMsgs.slice(-30),
    pageExceptions: pageExceptions.slice(-10),
  })}`,
);
process.exit(0);
