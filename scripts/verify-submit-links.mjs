/**
 * 真实链路验证：**真实 H5 页面点击提交** + 抓实际请求体
 *
 *   node scripts/verify-submit-links.mjs
 *
 * 覆盖用户要求的**两条最短链路 + 一条反向**：
 *   链路 1 · 只拍照、文字为空  ⇒ 提交成功
 *   链路 2 · 只录音、文字为空  ⇒ 提交成功（录音走真实的 getUserMedia + MediaRecorder）
 *   反向   · 无文字且无媒体    ⇒ 被拒（且**不发请求**，客户端就拦住）
 *
 * 为什么必须用真实页面（前两轮的教训）：
 *   我此前的验证都**手工构造完整 JSON**，完全绕过了 `normalize()` 这一层
 *   ⇒ "draft 里有 media_session、请求里没有" 这个真断点三轮都没被发现。
 *
 * 输出只有：字段名、是否带会话、材料数、文字长度、响应码。
 * **不打印会话 Token、手机号或任何客户内容。**
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// ⚠️ 在 scripts/ 下 ⇒ 仓库根是 '..'（脚本搬家必须重算相对路径，见 DEV-188/196）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8')).entry;
const IMG = path.join(ROOT, 'storage/tmp/historical-ui/10-review.png');
const PORT = 9563;
const PROFILE = path.join(os.tmpdir(), `p114-link-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id && msg.method && this.handlers.has(msg.method)) {
        for (const h of this.handlers.get(msg.method)) h(msg.params ?? {});
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  on(method, h) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(h);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 60000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'exc');
    return r.result?.value;
  }
  async waitFor(expr, timeout = 20000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if (await this.evaluate(`return !!(${expr});`)) return true;
      } catch {
        /* 导航中 */
      }
      if (Date.now() > deadline) throw new Error('等待超时: ' + expr.slice(0, 70));
      await sleep(200);
    }
  }
}

const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--disable-gpu',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors'] : []),
    '--window-size=412,915',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let failed = 1;
try {
  let page;
  for (let i = 0; i < 60; i += 1) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
      if (page) break;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    platform: 'Android',
  });

  const captured = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    if (!String(p.request?.url ?? '').includes('/api/public/tickets')) return;
    const post = String(p.request?.postData ?? '');
    let keys = [];
    let hasMedia = false;
    let contentLen = -1;
    try {
      const j = JSON.parse(post);
      keys = Object.keys(j);
      hasMedia = 'media_session' in j && j.media_session !== null;
      contentLen = String(j.content ?? '').trim().length;
    } catch {
      /* 非 JSON */
    }
    captured.push({ keys, hasMedia, contentLen });
  });
  const consoleLines = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const t = (p.args ?? []).map((a) => String(a.value ?? '')).join(' ').trim();
    if (t.startsWith('[svc-submit]')) consoleLines.push(t);
  });

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  真实链路验证（真实页面点击 + 实际请求体）');
  console.log('══════════════════════════════════════════════════════════════');

  async function openFreshPage() {
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/h5/report?k=${ENTRY}` });
    await cdp.waitFor(`document.querySelector('[data-testid="capture-photo"]')`, { timeout: 30000 });
    await cdp.evaluate(`try { sessionStorage.setItem('svc-media-consent','1'); } catch (e) {} return true;`);
    await cdp.send('Page.reload');
    await cdp.waitFor(`document.querySelector('[data-testid="capture-photo"]')`, { timeout: 30000 });
    await sleep(600);
  }

  async function fillNameMobileOnly() {
    await cdp.evaluate(`
      const set = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('[data-testid="repair-name"]', '链路验证客户');
      set('[data-testid="repair-mobile"]', '1370000' + String(1000 + Math.floor(Math.random() * 8000)).slice(-4));
      const ta = document.querySelector('[data-testid="repair-content"]');
      if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    `);
    await sleep(400);
  }

  async function submitAndReport(label) {
    captured.length = 0;
    consoleLines.length = 0;
    await cdp.evaluate(`document.querySelector('[data-testid="submit-repair"]').click(); return true;`);
    await sleep(4000);
    const okPage = await cdp.evaluate(`return location.pathname.indexOf('/report/success') !== -1;`);
    const banner = await cdp.evaluate(`
      const el = document.querySelector('[data-testid="submit-banner"]');
      return el ? el.textContent.trim().slice(0, 60) : '';
    `);
    const req = captured.at(-1) ?? null;
    console.log('');
    console.log(`  ── ${label} ────────────────────────────────────────`);
    console.log(`  组件诊断 : ${(consoleLines.at(-1) ?? '(无)').slice(0, 130)}`);
    console.log(
      `  实际请求 : ${
        req
          ? `media_session=${req.hasMedia ? 'yes' : 'NO'} 文字长度=${req.contentLen}`
          : '(**没有发出请求** —— 被客户端拦下)'
      }`,
    );
    console.log(`  结果     : ${okPage ? '✅ 提交成功（跳成功页）' : banner ? `❌ ${banner}` : '❌ 未跳成功页'}`);
    return { label, okPage, req, banner };
  }

  const readMat = (kind) => `(() => {
    const li = document.querySelector('[data-testid="mat-${kind}"]');
    return li ? li.textContent.replace(/\\s+/g,' ').trim().slice(0, 40) : 'missing';
  })()`;

  // ---------------- 链路 1 · 只拍照、文字为空 ----------------
  await openFreshPage();
  await cdp.evaluate(`document.querySelector('[data-testid="capture-photo"]').click(); return true;`);
  await sleep(900);
  {
    const d = await cdp.send('DOM.getDocument');
    const f = await cdp.send('DOM.querySelector', {
      nodeId: d.root.nodeId,
      selector: 'body > input[type="file"]',
    });
    if (!f.nodeId) throw new Error('「拍照」未在 body 下创建 input');
    await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId: f.nodeId });
  }
  await cdp.waitFor(`document.querySelector('[data-testid="mat-image"]')`, { timeout: 30000 });
  await sleep(2500);
  console.log(`  · 链路 1 照片状态：${await cdp.evaluate(`return ${readMat('image')};`)}`);
  await fillNameMobileOnly();
  const link1 = await submitAndReport('链路 1 · 只拍照、文字为空');

  // ---------------- 链路 2 · 只录音、文字为空 ----------------
  await openFreshPage();
  await cdp.evaluate(`document.querySelector('[data-testid="capture-audio"]').click(); return true;`);
  await cdp.waitFor(`document.querySelector('[data-testid="record-timer"]')`, { timeout: 15000 });
  await sleep(5000);
  await cdp.evaluate(`document.querySelector('[data-testid="capture-audio"]').click(); return true;`);
  await cdp.waitFor(`document.querySelector('[data-testid="mat-audio"]')`, { timeout: 30000 });
  await sleep(3500);
  console.log(`  · 链路 2 录音状态：${await cdp.evaluate(`return ${readMat('audio')};`)}`);
  await fillNameMobileOnly();
  const link2 = await submitAndReport('链路 2 · 只录音、文字为空');

  // ---------------- 反向 · 无文字且无媒体 ----------------
  await openFreshPage();
  await fillNameMobileOnly();
  const neg = await submitAndReport('反向 · 无文字且无媒体（应被拒）');

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  const p1 = link1.okPage && (link1.req?.hasMedia ?? false);
  const p2 = link2.okPage && (link2.req?.hasMedia ?? false);
  const p3 = !neg.okPage && !neg.req;
  console.log(`  链路 1（只照片免文字）: ${p1 ? '✅ 通过' : '❌ 失败'}`);
  console.log(`  链路 2（只录音免文字）: ${p2 ? '✅ 通过' : '❌ 失败'}`);
  console.log(`  反向（无文字无媒体）  : ${p3 ? '✅ 正确拒绝（且未发请求）' : '❌ 未正确拒绝'}`);
  console.log('══════════════════════════════════════════════════════════════');
  failed = p1 && p2 && p3 ? 0 : 1;
  console.log(failed ? '  ❌ 存在未通过项' : '  ✅ 三条链路全部符合预期');
} finally {
  chrome.kill();
  await sleep(700);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* ignore */
  }
}
process.exit(failed);
