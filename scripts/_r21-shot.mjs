#!/usr/bin/env node
/**
 * _r21-shot.mjs —— R2.1 后台页面通用截图（只做一件事：把真实页面拍下来）
 *
 * 用法：
 *   node scripts/_r21-shot.mjs --page 9ia6p1dx2wp --out tickets-before
 *   node scripts/_r21-shot.mjs --page 9ia6p1dx2wp --out tickets-after --wait 8000
 *
 * 设计原则（沿用本仓库踩过的坑）：
 *   · **登录态用真实 signIn**，不塞 localStorage（塞 token 会被重定向到 /signin）
 *   · 截图前**确认页面真的到了**（标题可见 + 无 /signin 跳转），否则截出空白转圈
 *   · 不用 `captureBeyondViewport`（会触发重排把 NocoBase 打回 loading 态）
 *   · 输出按「字节数 + sha」区分，旧图不能复用作另一种状态的证据
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { readEnv, signIn } from './_b36-lib.mjs';

const BASE = 'https://127.0.0.1';
const VW = 1440;
const VH = 900;
const OUT = path.resolve('storage/tmp/r21');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const PAGE_UID = arg('page', '9ia6p1dx2wp');
const OUT_NAME = arg('out', 'page');
const WAIT_MS = Number(arg('wait', '6000'));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* noop */ } }
  throw new Error('未找到 chrome.exe');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

const env = readEnv();
let child = null;
let profile = null;
let pass = 0; const fails = [];
const ok = (m) => { pass += 1; console.log(`  ✅ ${m}`); };
const no = (m) => { fails.push(m); console.log(`  ❌ ${m}`); };
const chk = (c, m) => (c ? ok(m) : no(m));

try {
  const hq = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
  ok('登录成功（真实 signIn）');

  const port = 9700 + Math.floor(Math.random() * 200);
  profile = path.join(os.tmpdir(), `r21shot-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  child = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--ignore-certificate-errors', `--window-size=${VW},${VH}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const pg = list.find((t) => t.type === 'page');
      if (pg?.webSocketDebuggerUrl) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('浏览器未就绪');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  const ev = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

  // 先落到 /admin/ 再种 token（顺序反了会被 SPA 打回登录页）
  await cdp.send('Page.navigate', { url: `${BASE}/admin/` });
  await sleep(2500);
  const seeded = await ev(`(() => { try {
    localStorage.setItem('NOCOBASE_TOKEN', ${JSON.stringify(hq)});
    localStorage.setItem('nocobase-token', ${JSON.stringify(hq)});
    return true; } catch (e) { return String(e); } })()`);
  chk(seeded === true, '会话已写入页面存储');

  await cdp.send('Page.navigate', { url: `${BASE}/admin/${PAGE_UID}` });

  // 等真实渲染：不能只看 200，要有内容区文本
  let info = null;
  for (let i = 0; i < 24; i += 1) {
    await sleep(1000);
    info = await ev(`(() => {
      const t = document.body ? (document.body.innerText || '') : '';
      return {
        url: location.pathname,
        onSignin: /signin/i.test(location.pathname),
        len: t.length,
        rows: document.querySelectorAll('.ant-table-row, [data-testid^="pt-banner-row-"], tbody tr').length,
        text: t.replace(/\\s+/g, ' ').slice(0, 500),
      };
    })()`);
    if (info && !info.onSignin && info.len > 200) break;
  }

  console.log(`\n【页面】/admin/${PAGE_UID}`);
  chk(info && !info.onSignin, `未被重定向到登录页（当前 ${info?.url}）`);
  chk(info?.len > 200, `内容区有文本（${info?.len} 字符）`);
  console.log(`  表格行数: ${info?.rows}`);
  console.log(`  正文摘录: ${String(info?.text ?? '').slice(0, 260)}`);

  await sleep(1200);
  fs.mkdirSync(OUT, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.data, 'base64');
  const file = path.join(OUT, `${OUT_NAME}.png`);
  fs.writeFileSync(file, buf);
  const h8 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  chk(buf.length > 5000, `截图有效（${buf.length}B, sha=${h8}）`);
  console.log(`  📸 ${file}`);

  cdp.close();
} catch (e) {
  console.log(`\n  ⚠️ 中断：${String(e?.message ?? e)}`);
  fails.push(String(e?.message ?? e));
} finally {
  try { if (child) child.kill('SIGKILL'); } catch { /* noop */ }
  await sleep(400);
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch { /* noop */ }
}

console.log(`\n  ${fails.length ? `❌ 失败 ${fails.length}` : `✅ 通过 ${pass}`}`);
process.exit(fails.length ? 1 : 0);
