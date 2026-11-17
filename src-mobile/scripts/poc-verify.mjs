/**
 * PoC 真机级验收（CDP 驱动 Chrome headless，390×844 iPhone 尺寸）
 *
 * 判据设计原则：**只看 DOM 有没有元素 = 没有断言**。
 *   要么量到一个真实数值（computed style / 尺寸 / 网络），
 *   要么就不算通过。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.resolve('.tmp-verify/mobile-poc');
fs.mkdirSync(OUT, { recursive: true });

const PORT = 9333;
const results = [];
function ck(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  <- ' + detail : ''}`);
}

// ---------- 极简 CDP 客户端 ----------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 8000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

const BASE_URL = process.env.POC_URL || 'http://127.0.0.1:4173/m/poc';

// ---------- 启动 ----------
const userData = path.resolve('.tmp-verify/chrome-profile-poc');
fs.rmSync(userData, { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

process.on('exit', () => {
  try { chrome.kill(); } catch { /* ignore */ }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

let targets = null;
await waitFor(async () => {
  try {
    targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    return targets.some((t) => t.type === 'page');
  } catch { return false; }
}, 12000);

if (!targets) {
  console.error('Chrome 未能启动');
  process.exit(2);
}

const page = targets.find((t) => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.ready;

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
// 记录所有失败请求 —— "页面看起来正常"不代表没有 404 资源
await cdp.send('Log.enable');

console.log('\n== PoC 真机级验收 ==');
console.log(`   尺寸 390×844 · ${BASE_URL}\n`);

const nav = await cdp.send('Page.navigate', { url: BASE_URL });
if (nav.errorText) {
  console.error('导航失败：', nav.errorText);
  process.exit(3);
}

// 等 React 挂载
const mounted = await waitFor(async () =>
  (await cdp.eval('!!document.querySelector("[data-testid=poc-count]")')), 10000);
ck('React 应用挂载成功（PoC 計数元素出现）', mounted);

if (!mounted) {
  const html = await cdp.eval('document.body.innerHTML.slice(0,600)');
  console.log('  body:', html);
}

// ---- 1. 双 React 检测 ----
const reactInfo = await cdp.eval(`(() => {
  const w = window;
  return {
    hasReactGlobal: typeof w.React !== 'undefined',
    hooksBroken: /Invalid hook call/i.test(document.body.innerText || ''),
  };
})()`);
ck('页面无 "Invalid hook call"（双 React 的典型症状）', reactInfo.hooksBroken === false, JSON.stringify(reactInfo));

// ---- 2. Konsta 主题真实生效（量 computed style）----
const themeProbe = await cdp.eval(`(() => {
  const btn = document.querySelector('[data-testid=poc-inc]');
  const card = document.querySelector('.k-card') || document.querySelector('[class*="rounded-3xl"]');
  const cs = btn ? getComputedStyle(btn) : null;
  const cardCs = card ? getComputedStyle(card) : null;
  return {
    btnFound: !!btn,
    btnRadius: cs ? cs.borderRadius : null,
    btnHeight: cs ? cs.height : null,
    btnBg: cs ? cs.backgroundColor : null,
    cardFound: !!card,
    cardRadius: cardCs ? cardCs.borderRadius : null,
    rootClass: document.documentElement.className,
    cssVars: {
      brand: getComputedStyle(document.documentElement).getPropertyValue('--color-svc-brand').trim(),
      surface: getComputedStyle(document.documentElement).getPropertyValue('--color-svc-surface').trim(),
      fontIos: getComputedStyle(document.documentElement).getPropertyValue('--font-ios').trim(),
    },
  };
})()`);
ck('Konsta Button 渲染并带圆角（主题生效）',
  themeProbe.btnFound && themeProbe.btnRadius && themeProbe.btnRadius !== '0px',
  `radius=${themeProbe.btnRadius} h=${themeProbe.btnHeight}`);
ck('Konsta Card 渲染并带圆角',
  themeProbe.cardFound && themeProbe.cardRadius && themeProbe.cardRadius !== '0px',
  `radius=${themeProbe.cardRadius}`);
ck('业务 token 注入成功（--color-svc-brand 有值）',
  !!themeProbe.cssVars.brand, themeProbe.cssVars.brand);
ck('Konsta --font-ios 变量存在（iOS 材质生效）',
  !!themeProbe.cssVars.fontIos, themeProbe.cssVars.fontIos.slice(0, 40));

// ---- 3. 交互真实性：点击后计数必须变 ----
const before = await cdp.eval('document.querySelector("[data-testid=poc-count]").textContent.trim()');
const box = await cdp.eval(`(() => {
  const r = document.querySelector('[data-testid=poc-inc]').getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await new Promise((r) => setTimeout(r, 250));
const after = await cdp.eval('document.querySelector("[data-testid=poc-count]").textContent.trim()');
ck('点击真实生效（React 状态更新）', before !== after, `${before} -> ${after}`);

// 触摸目标：同时检查 medium 与 large 两档，防止"只修了一个按钮"
const touch = await cdp.eval(`(() => {
  const h = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect().height : null;
  };
  return { medium: h('[data-testid=poc-inc]'), large: h('[data-testid=poc-large]') };
})()`);
ck('medium 按钮触摸目标 >= 44px（设计系统强制，Konsta 默认为 34px）',
  touch.medium !== null && touch.medium >= 44, `medium=${touch.medium?.toFixed(1)}px`);
ck('large 按钮触摸目标 >= 44px',
  touch.large !== null && touch.large >= 44, `large=${touch.large?.toFixed(1)}px`);

// ---- 4. 深色模式 ----
await cdp.eval(`document.querySelector('[data-testid=poc-dark]').click()`);
await new Promise((r) => setTimeout(r, 300));
const darkProbe = await cdp.eval(`(() => {
  const hasDark = document.documentElement.classList.contains('dark');
  const bg = getComputedStyle(document.body).backgroundColor;
  return { hasDark, bg, brand: getComputedStyle(document.documentElement).getPropertyValue('--color-svc-brand').trim() };
})()`);
ck('深色模式类切换生效', darkProbe.hasDark === true, darkProbe.bg);
ck('深色下 token 变量被覆盖（值变化）',
  darkProbe.brand !== themeProbe.cssVars.brand,
  `light=${themeProbe.cssVars.brand} dark=${darkProbe.brand}`);

// 切回浅色截图
await cdp.eval(`document.querySelector('[data-testid=poc-dark]').click()`);
await new Promise((r) => setTimeout(r, 300));

// ---- 5. 横向溢出（多宽度）----
for (const width of [360, 390, 430]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await new Promise((r) => setTimeout(r, 250));
  const ov = await cdp.eval(`({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  })`);
  ck(`宽度 ${width}px 无横向溢出`, ov.scrollW <= ov.clientW + 1, `scrollW=${ov.scrollW} clientW=${ov.clientW}`);
}

// ---- 6. 网络与资源 ----
const failedReqs = cdp.events
  .filter((e) => e.method === 'Network.loadingFailed')
  .map((e) => e.params);
const responses = cdp.events
  .filter((e) => e.method === 'Network.responseReceived')
  .map((e) => ({ url: e.params.response.url, status: e.params.response.status }));
const bad = responses.filter((r) => r.status >= 400);
ck('无失败请求（Network.loadingFailed = 0）', failedReqs.length === 0, `count=${failedReqs.length}`);
ck('无 4xx/5xx 资源', bad.length === 0, bad.map((b) => `${b.status} ${b.url.split('/').pop()}`).join(', ') || '0');

const cssCount = responses.filter((r) => r.url.endsWith('.css')).length;
const jsCount = responses.filter((r) => r.url.endsWith('.js')).length;
ck('CSS 与 JS 资源均加载', cssCount >= 1 && jsCount >= 1, `css=${cssCount} js=${jsCount}`);

// ---- 7. 截图（浅色 + 深色，两张不同状态）----
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await new Promise((r) => setTimeout(r, 300));
const shotLight = await cdp.send('Page.captureScreenshot', { format: 'png' });
const lightPath = path.join(OUT, 'poc-light-390.png');
fs.writeFileSync(lightPath, Buffer.from(shotLight.data, 'base64'));

await cdp.eval(`document.querySelector('[data-testid=poc-dark]').click()`);
await new Promise((r) => setTimeout(r, 350));
const shotDark = await cdp.send('Page.captureScreenshot', { format: 'png' });
const darkPath = path.join(OUT, 'poc-dark-390.png');
fs.writeFileSync(darkPath, Buffer.from(shotDark.data, 'base64'));

const crypto = await import('node:crypto');
const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const hl = h(lightPath), hd = h(darkPath);
ck('深色截图与浅色截图**内容不同**（不是复用同一张图）', hl !== hd, `light=${hl} dark=${hd}`);
ck('截图非空白（体积 > 10KB）',
  fs.statSync(lightPath).size > 10240 && fs.statSync(darkPath).size > 10240,
  `light=${fs.statSync(lightPath).size}B dark=${fs.statSync(darkPath).size}B`);

console.log('\n证据：');
console.log(`  ${lightPath}`);
console.log(`  ${darkPath}`);

const fails = results.filter((r) => !r.ok);
console.log(`\n结论：${fails.length === 0 ? '全部 PASS' : 'FAIL ' + fails.map((f) => f.name).join(' | ')}`);
console.log(`共 ${results.length} 项，通过 ${results.length - fails.length} 项`);

cdp.ws.close();
chrome.kill();
process.exit(fails.length === 0 ? 0 : 1);
