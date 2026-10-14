/**
 * 成功页次要按钮的**视觉与交互**聚焦验收（P11-4 第七轮 · 纯 UI 优化）
 *
 *   node scripts/verify-success-buttons.mjs
 *
 * 只验用户列出的 5 条：
 *   ① iPhone 宽度下两个次要按钮**横向排列、等宽**，文字不挤压不溢出
 *   ② 点「复制工单号」能复制**正确单号**（读剪贴板比对，不靠"点到了"就算过）
 *   ③ 点「再报一单」进入**正确门店**的干净表单（带 k、不带上一单的媒体/凭证/状态）
 *   ④ 主按钮「查看处理进度」保持可见可用
 *   ⑤ 报修 / 投诉**共用**成功页，两边的样式都没回归
 *
 * 另产出**手机尺寸截图**（390×844，2x）供人眼确认。
 *
 * ⚠️ 不改媒体 / 上传 / Token / 后端；本脚本只做**页面内**的量测与点击。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_TLS_INSECURE } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8'));
const BASE = `https://${DEV.lanIp}`; // 用手机实际访问的地址
const IMG = path.join(ROOT, 'storage/tmp/historical-ui/10-review.png');
const OUT = path.join(ROOT, 'storage/tmp/device-test');
const PORT = 9591;
const PROFILE = path.join(os.tmpdir(), `p114-btn-${Date.now()}`);
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
    // iPhone 14 Pro 逻辑尺寸：390×844（与用户设备量级一致）
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

/** 走一遍「只传一张图 → 提交」，落在成功页 */
async function submitAndReachSuccess(cdp, mode) {
  await cdp.send('Page.navigate', { url: `${BASE}/h5/report?k=${DEV.entry}` });
  await cdp.waitFor(`document.querySelector('[data-testid="capture-photo"]')`, { timeout: 30000 });
  await cdp.evaluate(`try { sessionStorage.setItem('svc-media-consent','1'); } catch (e) {} return true;`);
  if (mode === 'complaint') {
    await cdp.evaluate(`document.querySelector('[data-testid="mode-complaint"]').click(); return true;`);
    await cdp.waitFor(`document.querySelector('[data-testid="submit-complaint"]')`, { timeout: 15000 });
  }
  const d = await cdp.send('DOM.getDocument');
  const f = await cdp.send('DOM.querySelector', {
    nodeId: d.root.nodeId,
    selector: 'input[data-testid="pick-from-album"]',
  });
  if (!f.nodeId) throw new Error('找不到相册入口');
  await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId: f.nodeId });
  await cdp.waitFor(`document.querySelector('[data-testid="mat-image"]')`, { timeout: 30000 });
  await sleep(2000);
  const pre = mode === 'complaint' ? 'complaint' : 'repair';
  await cdp.evaluate(`
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('[data-testid="${pre}-name"]', '按钮验收');
    set('[data-testid="${pre}-mobile"]', '1370000' + String(1000 + Math.floor(Math.random() * 8000)).slice(-4));
    return true;
  `);
  await sleep(300);
  await cdp.evaluate(`document.querySelector('[data-testid="submit-${pre}"]').click(); return true;`);
  await cdp.waitFor(`location.pathname.indexOf('/report/success') !== -1`, { timeout: 30000 });
  await sleep(1000);
}

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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });
  // 允许读取剪贴板（用于校验"复制的是不是正确单号"）
  await cdp.send('Browser.grantPermissions', {
    origin: BASE,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });

  /**
   * 🔴 复制校验用**测试侧打桩**，不用 `navigator.clipboard.readText()`。
   *    headless 里页面不聚焦 ⇒ readText 抛 `NotAllowedError: Document is not focused`，
   *    而"让页面聚焦"依赖环境，容易变成**偶发假红**。
   *
   *    桩**只记录产品传进来的值，并直接当作复制成功**（不调真实 writeText）：
   *    因为真实 writeText 在未聚焦的 headless 页面同样会**拒绝**，
   *    于是产品走 catch 分支 ⇒ 反馈不显示 —— 那是**环境限制，不是产品缺陷**
   *    （真实 iPhone 上页面已聚焦且是 HTTPS，writeText 会成功）。
   *    ⚠️ 因此本脚本验证的是"**复制成功后产品会显示什么、有没有把正确单号写进剪贴板**"；
   *       "剪贴板在真机上确实被写入"由真机复测确认。
   */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const c = navigator.clipboard;
        if (!c) return;
        window.__svcCopied = null;
        c.writeText = async (v) => { window.__svcCopied = String(v); };
      })();
    `,
  });

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  成功页次要按钮 · 视觉与交互聚焦验收（iPhone 390pt 宽）');
  console.log('══════════════════════════════════════════════════════════════');

  await submitAndReachSuccess(cdp, 'repair');
  const ticketNo = await cdp.evaluate(
    `return (document.querySelector('[data-testid="ticket-no"]')?.textContent || '').trim();`,
  );

  // ---- ① 几何：横排、等宽、高度、不溢出、无下划线 ----
  const geo = JSON.parse(
    await cdp.evaluate(`
      const a = document.querySelector('[data-testid="copy-ticket-no"]');
      const b = document.querySelector('[data-testid="report-again"]');
      const cta = document.querySelector('[data-testid="goto-progress"]');
      if (!a || !b) return JSON.stringify({ missing: true });
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), rc = cta.getBoundingClientRect();
      const cs = (el) => getComputedStyle(el);
      const inner = (el) => { const s = el.querySelector('span'); const r = s.getBoundingClientRect(); return { w: r.width, h: r.height }; };
      return JSON.stringify({
        sameRow: Math.abs(ra.top - rb.top) < 2,
        wA: Math.round(ra.width), wB: Math.round(rb.width),
        hA: Math.round(ra.height), hB: Math.round(rb.height),
        ctaH: Math.round(rc.height),
        // 不溢出：两个按钮的右边界都不超过视口
        noOverflow: rb.right <= window.innerWidth + 0.5 && ra.left >= -0.5,
        // 文字不挤压：按钮内文字宽度明显小于按钮宽度（有余量）
        textFitsA: inner(a).w + 8 < ra.width && inner(a).h < ra.height,
        textFitsB: inner(b).w + 8 < rb.width && inner(b).h < rb.height,
        underlineA: cs(a).textDecorationLine,
        underlineB: cs(b).textDecorationLine,
        animationA: cs(a).animationName,
        radiusA: cs(a).borderRadius,
        borderA: cs(a).borderTopWidth + ' ' + cs(a).borderTopColor,
        bgA: cs(a).backgroundColor,
        hasIconA: !!a.querySelector('svg'),
        hasIconB: !!b.querySelector('svg'),
        ctaVisible: rc.width > 0 && rc.height > 0,
      });
    `),
  );
  ok(
    '① 两个次要按钮**横向排列**（同一行）',
    geo.sameRow === true,
    `top 差 < 2px`,
  );
  ok(
    '① 两个按钮**等宽**（1fr 1fr）',
    Math.abs(geo.wA - geo.wB) <= 1,
    `${geo.wA}px vs ${geo.wB}px`,
  );
  ok(
    '① 高度 ≥ 44px（iPhone 触控下限）',
    geo.hA >= 44 && geo.hB >= 44,
    `${geo.hA}px / ${geo.hB}px`,
  );
  ok('① 两按钮都不溢出视口、文字不挤压', geo.noOverflow && geo.textFitsA && geo.textFitsB, `overflow=${!geo.noOverflow}`);
  ok(
    '① 无下划线、无动画（按要求）',
    geo.underlineA === 'none' && geo.underlineB === 'none' && geo.animationA === 'none',
    `underline=${geo.underlineA} animation=${geo.animationA}`,
  );
  ok(
    '① 复用既有风格：圆角 12px + 浅灰边框 + 白底',
    geo.radiusA.startsWith('12px') && /1px/.test(geo.borderA) && /rgb\(255, 255, 255\)/.test(geo.bgA),
    `radius=${geo.radiusA} border=${geo.borderA} bg=${geo.bgA}`,
  );
  ok('① 两个按钮都带图标', geo.hasIconA && geo.hasIconB, `copy=${geo.hasIconA} again=${geo.hasIconB}`);
  ok(
    '① 视觉层级低于主按钮（高度更小）',
    geo.hA < geo.ctaH,
    `次要 ${geo.hA}px < 主 ${geo.ctaH}px`,
  );

  // ---- 截图（手机尺寸，供人眼确认）----
  // ⚠️ 必须在**点击复制之前**截：点完会多出一条「已复制」提示，那不是客户刚提交完看到的样子。
  fs.mkdirSync(OUT, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(OUT, 'success-page-390.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`  · 截图已保存（未点击任何按钮的初始状态）：${shotPath}`);

  // ---- ② 复制：必须真复制到**正确单号** ----
  await cdp.evaluate(`document.querySelector('[data-testid="copy-ticket-no"]').click(); return true;`);
  await sleep(700);
  const clip = await cdp.evaluate(`return window.__svcCopied ?? '';`);
  const alertText = await cdp.evaluate(
    `return (document.querySelector('.svc-alert')?.textContent || '').trim();`,
  );
  ok(
    '② 点「复制工单号」复制到**正确单号**（记录产品实际写入剪贴板的值并比对）',
    clip === ticketNo && ticketNo.length > 0,
    `写入长度=${clip.length} 单号长度=${ticketNo.length} 一致=${clip === ticketNo}`,
  );
  ok('② 给出简短反馈「已复制」', alertText === '已复制', `反馈="${alertText}"`);

  // ---- ③ 再报一单：回到**正确门店**的干净表单 ----
  await cdp.evaluate(`document.querySelector('[data-testid="report-again"]').click(); return true;`);
  await cdp.waitFor(`location.pathname.indexOf('/report') !== -1 && location.pathname.indexOf('success') === -1`, {
    timeout: 20000,
  });
  await sleep(1200);
  const again = JSON.parse(
    await cdp.evaluate(`
      const q = new URLSearchParams(location.search);
      const keys = [...q.keys()];
      const storeEl = document.querySelector('.svc-store-name, [data-testid="store-name"]');
      return JSON.stringify({
        keys,
        hasK: keys.includes('k'),
        carriesOld: keys.includes('pt') || keys.includes('no') || keys.includes('at'),
        hasMediaList: !!document.querySelector('[data-testid="media-list"]'),
        contentEmpty: (document.querySelector('[data-testid="repair-content"]')?.value || '').length === 0,
      });
    `),
  );
  ok('③ 「再报一单」回到报修表单且**保留门店入口**（?k=）', again.hasK === true, `query=[${again.keys.join(',')}]`);
  ok(
    '③ **不携带**上一单的媒体/凭证/已提交状态',
    again.carriesOld === false && again.hasMediaList === false && again.contentEmpty === true,
    `pt/no/at=${again.carriesOld} 材料列表=${again.hasMediaList} 文字为空=${again.contentEmpty}`,
  );

  // ---- ④ 主按钮仍可见可用 ----
  await submitAndReachSuccess(cdp, 'repair');
  const cta = JSON.parse(
    await cdp.evaluate(`
      const b = document.querySelector('[data-testid="goto-progress"]');
      const r = b ? b.getBoundingClientRect() : null;
      return JSON.stringify({ ok: !!b && r.width > 0 && r.height > 0 && !b.disabled, h: r ? Math.round(r.height) : 0 });
    `),
  );
  ok('④ 主按钮「查看处理进度」保持可见可用', cta.ok === true, `高度 ${cta.h}px`);

  // ---- ⑤ 投诉共用成功页：样式不回归 ----
  await submitAndReachSuccess(cdp, 'complaint');
  const cm = JSON.parse(
    await cdp.evaluate(`
      const a = document.querySelector('[data-testid="copy-ticket-no"]');
      const b = document.querySelector('[data-testid="report-again"]');
      const cta = document.querySelector('[data-testid="goto-progress"]');
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const cs = getComputedStyle(a);
      return JSON.stringify({
        title: (document.querySelector('[data-testid="success-title"]')?.textContent || '').trim(),
        sameRow: Math.abs(ra.top - rb.top) < 2,
        equal: Math.abs(ra.width - rb.width) <= 1,
        h: Math.round(ra.height),
        radius: cs.borderRadius,
        ctaVisible: !!cta && cta.getBoundingClientRect().height > 0,
      });
    `),
  );
  ok('⑤ 投诉成功页标题仍按投诉业务显示', cm.title === '投诉提交成功', `标题="${cm.title}"`);
  ok(
    '⑤ 投诉成功页两个次要按钮样式一致（横排/等宽/≥44px/圆角 12px），主按钮仍在',
    cm.sameRow && cm.equal && cm.h >= 44 && cm.radius.startsWith('12px') && cm.ctaVisible,
    `横排=${cm.sameRow} 等宽=${cm.equal} 高=${cm.h}px 圆角=${cm.radius}`,
  );

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  const passed = checks.filter((c) => c.pass).length;
  console.log(`  成功页按钮验收：${passed}/${checks.length} 通过`);
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