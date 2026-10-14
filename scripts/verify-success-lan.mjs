/**
 * 验收补充：**投诉成功页** + **经局域网地址**（同源相对路径）
 *
 *   node scripts/verify-success-lan.mjs
 *
 * 覆盖用户 D 项里还没验的两条：
 *   ④ 投诉成功页同样有可用的进度入口
 *   ⑥ 手机从局域网地址打开时，点进度入口**不跳到 localhost / 不可达域名**
 *
 * ⚠️ 用 LAN IP 打开（192.168.0.167）——这正是手机实际访问的地址。
 *    若成功页用了绝对地址（比如硬编码 localhost），跳转后 host 就会变 ⇒ 断言变红。
 *
 * 输出只含结构信息（host、按钮存在性、状态文案），不含 Token / 单号 / 客户内容。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_TLS_INSECURE } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// ⚠️ 在 scripts/ 下 ⇒ 仓库根是 '..'（脚本搬家必须重算相对路径，见 DEV-188/196）
 const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8'));
const LAN = `https://${DEV.lanIp}`; // ← 手机实际访问的地址
const IMG = path.join(ROOT, 'storage/tmp/historical-ui/10-review.png');
const PORT = 9581;
const PROFILE = path.join(os.tmpdir(), `p114-lan-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
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
  async waitFor(expr, timeout = 25000) {
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
    ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors'] : []),
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};

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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  投诉成功页 + 经局域网地址（${DEV.lanIp}）验证`);
  console.log('══════════════════════════════════════════════════════════════');

  // 经 **局域网地址** 打开（与手机一致）
  await cdp.send('Page.navigate', { url: `${LAN}/h5/report?k=${DEV.entry}` });
  await cdp.waitFor(`document.querySelector('[data-testid="mode-complaint"]')`, { timeout: 30000 });
  const hostAtEntry = await cdp.evaluate(`return location.host;`);
  ok('经局域网地址打开报修页', hostAtEntry.includes(DEV.lanIp), `host=${hostAtEntry}`);

  await cdp.evaluate(`try { sessionStorage.setItem('svc-media-consent','1'); } catch (e) {} return true;`);

  // 切到**投诉**
  await cdp.evaluate(`document.querySelector('[data-testid="mode-complaint"]').click(); return true;`);
  await cdp.waitFor(`document.querySelector('[data-testid="submit-complaint"]')`, { timeout: 15000 });

  // 只传一张图、不写投诉内容
  {
    const d = await cdp.send('DOM.getDocument');
    const f = await cdp.send('DOM.querySelector', {
      nodeId: d.root.nodeId,
      selector: 'input[data-testid="pick-from-album"]',
    });
    if (!f.nodeId) throw new Error('找不到相册入口');
    await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId: f.nodeId });
  }
  await cdp.waitFor(`document.querySelector('[data-testid="mat-image"]')`, { timeout: 30000 });
  await sleep(2200);

  await cdp.evaluate(`
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('[data-testid="complaint-name"]', '投诉成功页核对');
    set('[data-testid="complaint-mobile"]', '1370000' + String(1000 + Math.floor(Math.random() * 8000)).slice(-4));
    return true;
  `);
  await sleep(300);
  await cdp.evaluate(`document.querySelector('[data-testid="submit-complaint"]').click(); return true;`);
  await cdp.waitFor(`location.pathname.indexOf('/report/success') !== -1`, { timeout: 30000 });
  await sleep(900);

  const info = await cdp.evaluate(`
    const q = new URLSearchParams(location.search);
    const btn = document.querySelector('[data-testid="goto-progress"]');
    const rect = btn ? btn.getBoundingClientRect() : null;
    return JSON.stringify({
      host: location.host,
      type: q.get('type') || '',
      hasPt: [...q.keys()].includes('pt'),
      title: (document.querySelector('[data-testid="success-title"]')?.textContent || '').trim(),
      status: (document.querySelector('[data-testid="current-status"]')?.textContent || '').trim(),
      hasProgress: !!btn,
      visible: btn ? (getComputedStyle(btn).display !== 'none' && rect.width > 0 && rect.height > 0) : false,
      ctaHeight: rect ? Math.round(rect.height) : 0,
      copyBtn: !!document.querySelector('[data-testid="copy-ticket-no"]'),
      againBtn: !!document.querySelector('[data-testid="report-again"]'),
    });
  `);
  const s = JSON.parse(info);

  ok('投诉提交成功（走到成功页）', true, `host=${s.host} type=${s.type}`);
  ok('投诉成功页标题按**投诉**业务显示', s.title === '投诉提交成功', `标题="${s.title}"`);
  ok('投诉成功页如实显示「当前进度：已提交」', s.status === '已提交', `状态="${s.status}"`);
  ok(
    '🔴 **投诉**成功页同样有「查看处理进度」主按钮，且真实可见',
    s.hasProgress && s.visible,
    `存在=${s.hasProgress} 可见=${s.visible} 高度=${s.ctaHeight}px`,
  );
  ok('投诉成功页保留「复制工单号」「再报一单」（次要操作）', s.copyBtn && s.againBtn, `复制=${s.copyBtn} 再报=${s.againBtn}`);
  ok('成功页 URL 带进度凭证', s.hasPt === true, `pt=${s.hasPt ? 'yes' : 'NO'}`);

  // 点进度入口 ⇒ 必须留在**同一 host**（这正是"手机从局域网地址进来不跳 localhost"的可测形式）
  await cdp.evaluate(`document.querySelector('[data-testid="goto-progress"]').click(); return true;`);
  await cdp.waitFor(`location.pathname.indexOf('/customer/progress') !== -1`, { timeout: 20000 });
  await sleep(600);
  const after = await cdp.evaluate(`
    const no = document.querySelector('[data-testid="progress-ticket-no"]');
    const mat = document.querySelector('[data-testid="progress-media"]');
    return JSON.stringify({ host: location.host, noOk: !!no && (no.textContent || '').trim().length > 0, media: !!mat });
  `);
  const a = JSON.parse(after);
  ok(
    '🔴 点进度入口后**仍在同一局域网 host**（同源相对路径，不会跳 localhost）',
    a.host === hostAtEntry,
    `${hostAtEntry} → ${a.host}`,
  );
  ok('投诉单的进度页显示工单号与材料', a.noOk && a.media, `单号=${a.noOk} 媒体=${a.media}`);

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  const passed = checks.filter((c) => c.pass).length;
  console.log(`  投诉成功页 + 局域网地址：${passed}/${checks.length} 通过`);
  console.log('══════════════════════════════════════════════════════════════');
  if (passed < checks.length) {
    for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
    process.exitCode = 1;
  } else {
    console.log('  ✅ 全部通过');
  }
} finally {
  chrome.kill();
  await sleep(600);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* ignore */
  }
}