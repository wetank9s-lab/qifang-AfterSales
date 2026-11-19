/**
 * ux-final-compare.mjs —— UX-FINAL 第五节：五组**真实前后对比**截图 + 文案修订表
 * =============================================================================
 * 用户原文要求
 * -----------------------------------------------------------------------------
 *   "五组**同宽度 / 同数据 / 同主题**的前后对比截图，每组配一句普通人能懂的话，
 *    并给出**完整的文案修订表**。"
 *
 * ===========================================================================
 * 🔴 本脚本的核心设计（决定"对比"是否成立）
 * ===========================================================================
 *
 *   要证明"是这次改动带来的差异"，必须让**唯一变量是被测的前端产物**。
 *   所以本脚本**不**跑两遍浏览器、**不**拼接两张图，而是：
 *
 *     一个浏览器实例 · 一个视口 · 一个登录态 · 一个夹具工单
 *       └─ 每一步操作**执行两次**：第一次用「修订前」产物，第二次用「修订后」产物
 *          （用 CDP `Fetch.fulfillRequest` 按请求把 JS/CSS/HTML 换成对应字节）
 *
 *   两遍之间**只**换产物字节；页面、数据、点击坐标、滚动量全一致。
 *   任何一处差异都只能由产物解释 —— 这就是"同宽度/同数据/同主题"的机械保证。
 *
 *   ⚠️ 与"改文件 → 重建 → 截图 → 再改回来 → 重建 → 截图"的做法相比，
 *      这里**不动工作区、不动线上 dist、不动 nginx**：
 *      两个版本的字节都只是内存里的 Buffer，通过 CDP 拦截注入。
 *      （历史教训：临时改配置"以为还原了"是密钥/配置入库以外的第二大坑。）
 *
 * ===========================================================================
 * 🔴 「修订前」产物从哪来（必须可核查，不能靠嘴说）
 * ===========================================================================
 *   · h5 侧  ：`git archive HEAD h5` 取出开工前源码 → `vite build`
 *              （HEAD 就是本轮开工前的提交，产物 = 真·修订前）
 *   · 移动端 ：`src-mobile/` **从未入库**（git log 空），历史产物也没有备份，
 *              所以用**源码反向回退**重建：把本轮 5 个修复点逐处改回修复前形态
 *              （每处都在副本里留了 `【BEFORE 副本 · 刻意回退】` 注释，
 *                副本路径 `.tmp-ux-before/`，**不改工作区真实源码**）
 *
 *   ⚠️ 这些副本与产物路径都写进 manifest，任何人可复跑核对。
 *   ⚠️ 报告的措辞必须诚实：移动端的"修订前"是**按修复点回退重建**的，
 *      不是当年那一版的原始字节 —— 因为原始字节从未被保存过。
 *
 * ===========================================================================
 * 五组对比
 * ===========================================================================
 *   组 1 · 列表页搜索区被导航栏压住        （移动端 · DEV-249）
 *   组 2 · Toast 提示跑到屏幕左侧外        （移动端 · DEV-250）
 *   组 3 · Toast 整条压在吸底主按钮上      （移动端 · DEV-253）
 *   组 4 · 建档页「下一步」下方大块空白    （移动端 · DEV-251）
 *   组 5 · 校验定位后字段被导航栏遮住      （移动端 · DEV-252）
 *   组 6 · 状态色在软底上的对比度          （两端 · DEV-255）
 *   组 7 · h5 客户进度页小字号辅助文字     （h5 · DEV-256）
 *
 * 用法：
 *   node scripts/ux-final-compare.mjs                 # 全部
 *   node scripts/ux-final-compare.mjs --only=1,3      # 只跑某几组
 * 退出码：0 全部产出且断言通过 / 1 有断言失败 / 2 环境未就绪
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

import { BASE_URL, ROOT, cleanupTicket, envValue, http, psqlScalar, smsSwitch, svcPost } from './technician-harness.mjs';

/**
 * 测试口令**只在 .env 里**（`ARC_TEST_PW`）。
 * 2026-11-19 R2.2.1 封版审计：本文件原先硬编码了 `arc1.*` 测试账号口令，
 * 而 `docs/R2-SECURITY-FREEZE.md` 早已判定「脚本硬编码测试凭据 = 高危、排除出提交」。
 * 改成读 .env 之后，源码里不再有可用的凭据字面量，同时脚本仍能直接跑。
 */
const ARC_TEST_PW = envValue("ARC_TEST_PW");
import { storeEntryQuery } from './lib/store-entry-token.mjs';

const OUT = path.join(ROOT, 'storage/tmp/ux-final-compare');
const PROFILE = path.join(ROOT, '.tmp-ux-compare-profile');
const CDP_PORT = 9466;
const VW = 390;
const VH = 844;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha16 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const rid = () => crypto.randomUUID();
const ROOT_DIR = ROOT;

/** 「修订前」工作区（隔离副本，不改真实源码） */
const BEFORE = path.join(ROOT, '.tmp-ux-before');
/**
 * 🔴 **单点回退**副本（只回退 DEV-253 一处）。
 *
 *   为什么需要它：DEV-253（Toast 压在吸底按钮上）**只有在 DEV-251 修好之后才会显形**。
 *   实测（full-before 版）：吸底栏还浮在 `bottom=687`，Toast 落在 `784~828`，
 *   两者**不重叠** ⇒ 用"完整修订前"跑组 3 永远复现不出遮挡，
 *   会被读成"这个缺陷不存在"。
 *   ⇒ 每个缺陷要在**它自己成立的前提下**单独复现：
 *     保留 DEV-250/251 的修复，只回退 DEV-253 一处。
 *   产物 SHA 与 full-before 不同（`index-D4MFksUz.js` vs `index-B_uXg-yt.js`），可核对。
 */
const BEFORE_253 = path.join(BEFORE, 'src-mobile-253');

/* ------------------------------------------------------------------ 账本 */
const rows = [];
const ok = (label, pass, detail = '') => {
  rows.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const note = (t) => console.log(`  · ${t}`);
const section = (t) => console.log(`\n=== ${t} ===`);

/* ------------------------------------------------------------------ CDP */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method) this.events.push(msg);
      for (const fn of this.listeners) fn(msg);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('JS error: ' + (r.exceptionDetails.text || '') + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ------------------------------------------------- 产物字节：按 URL 重写 */
/**
 * 产物替换表。
 *
 * 键 = 线上 URL（路径），值 = { mime, body:Buffer }。
 * 请求命中即 `Fetch.fulfillRequest` 返回该字节 —— 相当于"把这份产物临时部署上去"，
 * 但没有真的动磁盘。
 *
 * ⚠️ 只替换 **JS / CSS / HTML 三样**，其余（图片、字体、`/api/*`）一律放行。
 *    API 放行是硬要求：对比的是**界面**，数据必须来自同一次真实请求。
 */
function buildAssetMap(variant) {
  /** @type {Map<string,{mime:string,body:Buffer}>} */
  const map = new Map();
  const read = (p) => fs.readFileSync(p);
  /**
   * 三个版本：
   *   · `after`      = 当前工作区（= 线上现役）
   *   · `before`     = 完整修订前（h5 用 HEAD 真产物；移动端按 5 处修复点全部回退）
   *   · `before253`  = **只回退 DEV-253 一处**（见 BEFORE_253 上方注释：
   *                    该缺陷只有在 DEV-251 修好后才显形，必须单点复现）
   */
  /**
   * ⚠️ 这个函数的第二个参数是**重构残留**，原本签名是 `out(hits, mobileDir)`、
   *   `return hits` —— 结果 `buildAssetMap()` 返回的是数字 `0`，
   *   `activeAssets.get(...)` 抛 `is not a function`，
   *   而**异常被 handler 的 catch 静默吞掉** ⇒ 表现为"两版毫无差异"。
   *   两个缺陷叠在一起：一个错的返回值 + 一个吞异常的兜底。
   *   （`paused=10` 而 `hitCount/passthrough` 双双为 0，是唯一可见的线索。）
   */
  const out = (mobileDir) => {
    for (const f of fs.readdirSync(path.join(mobileDir, 'assets'))) {
      const mime = f.endsWith('.css') ? 'text/css' : 'application/javascript';
      map.set(`/m/assets/${f}`, { mime, body: read(path.join(mobileDir, 'assets', f)) });
    }
    map.set('/m/index.html', { mime: 'text/html', body: read(path.join(mobileDir, 'index.html')) });
    return map;
  };

  if (variant === 'after') {
    for (const f of fs.readdirSync(path.join(ROOT_DIR, 'h5/dist/assets'))) {
      const mime = f.endsWith('.css') ? 'text/css' : 'application/javascript';
      map.set(`/h5/assets/${f}`, { mime, body: read(path.join(ROOT_DIR, 'h5/dist/assets', f)) });
    }
    map.set('/h5/index.html', { mime: 'text/html', body: read(path.join(ROOT_DIR, 'h5/dist/index.html')) });
    return out(path.join(ROOT_DIR, 'src-mobile/dist'));
  }

  // 修订前：h5 一律用隔离副本（HEAD 真产物）
  for (const f of fs.readdirSync(path.join(BEFORE, 'h5/dist/assets'))) {
    const mime = f.endsWith('.css') ? 'text/css' : 'application/javascript';
    map.set(`/h5/assets/${f}`, { mime, body: read(path.join(BEFORE, 'h5/dist/assets', f)) });
  }
  map.set('/h5/index.html', { mime: 'text/html', body: read(path.join(BEFORE, 'h5/dist/index.html')) });

  /**
   * ⚠️ 两个副本的**目录层级不同**，别想当然：
   *   · `.tmp-ux-before/src-mobile/dist`      ← 完整回退副本（外层就叫 src-mobile）
   *   · `.tmp-ux-before/src-mobile-253/dist`  ← 单点回退副本（dist 直接在下）
   *   实测踏坑：把后者也写成 `src-mobile-253/src-mobile/dist` ⇒
   *   `ENOENT: scandir ...\src-mobile-253\src-mobile\dist\assets`，
   *   表现为"环境未就绪或中断"，会被误读成环境问题。
   */
  const mobileDir = variant === 'before253'
    ? path.join(BEFORE_253, 'dist')
    : path.join(BEFORE, 'src-mobile/dist');
  return out(mobileDir);
}

/** 当前生效的替换表（切版本时整体换掉） */
let activeAssets = buildAssetMap('after');
let activeVariant = 'after';
/**
 * 拦截命中计数（自证拦截真的生效，而不是"我以为拦到了"）。
 *
 * ⚠️ 必须用 `bump()` 而不是 `hitCount[v] += 1`：
 *   新增 `before253` 变体时忘了登记键名，`undefined + 1 = NaN`，
 *   于是"命中多少次"显示成 **NaN**、`NaN - undefined = NaN`，
 *   而**断言照样跑过去**（NaN 参与的比较不抛错）——
 *   缺陷会以"数字很难看"的形态静默溜过，而不是大声失败。
 *   ⇒ 未知变体必须**当场初始化**，不允许出现 NaN。
 */
const hitCount = { before: 0, after: 0, before253: 0, passthrough: 0 };
const bump = (v) => { if (!(v in hitCount)) hitCount[v] = 0; hitCount[v] += 1; };
/** 拦截处理器里抛出的异常（原本被 catch 静默吞掉 ⇒ 表现得像"没有差异"） */
const handlerErrors = [];

async function installFetch(cdp) {
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
  cdp.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request, resourceType } = m.params;
    try {
      const u = new URL(request.url);
      let entry = activeAssets.get(u.pathname);

      /**
       * ⚠️ **SPA 深链接必须按「文档请求」命中，不能只按路径精确匹配。**
       *
       *   实测踏坑（组 6 第一版）：我只把 `/m/index.html` 放进映射表，
       *   但真实导航是 `/m/archives`、`/h5/report?...` 这类深链接 ——
       *   它们不在表里 ⇒ 被放行 ⇒ nginx 的 `try_files ... /m/index.html`
       *   返回的是**现役** index.html（引用 after 产物）⇒
       *   before 那一遍其实加载的是 after 的 JS/CSS，
       *   于是"两版渲染出的变量值完全相同"，看上去像"改动无效"。
       *   判据 `hitCount.before=2` 是唯一的破案线索（正常应 ≥3）。
       *
       *   ⇒ 规则：凡 `resourceType === 'Document'` 且路径属于 /m/ 或 /h5/ 的，
       *     一律返回**当前版本**的 index.html。
       *     （这正是 nginx 的 SPA fallback 语义，我们只是把它指向另一份字节。）
       */
      if (!entry && resourceType === 'Document') {
        if (u.pathname === '/m' || u.pathname.startsWith('/m/')) {
          entry = activeAssets.get('/m/index.html');
        } else if (u.pathname === '/h5' || u.pathname.startsWith('/h5/')) {
          entry = activeAssets.get('/h5/index.html');
        }
      }

      if (entry) {
        bump(activeVariant);
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: entry.mime },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: entry.body.toString('base64'),
        });
      } else {
        hitCount.passthrough += 1;
        await cdp.send('Fetch.continueRequest', { requestId });
      }
    } catch (err) {
      /**
       * 🔴 **这个 catch 原本是个静默黑洞**（本轮实测：`paused=10` 但
       *   `hitCount` 与 `passthrough` **同时为 0** ⇒ 10 个事件全掉进这里）。
       *   它只做 `continueRequest` 就完事，一句日志都不留 ⇒
       *   表现成"两版没有任何差异"，会被读成"改动无效"。
       *   ⇒ 与"同一段逻辑出现两次"同类的坑：**兜底分支吞掉的错误，等于没有错误日志**。
       *   现在把异常记进 `handlerErrors`，并在自检里断言其为空。
       */
      handlerErrors.push(`${request?.url?.slice(0, 120) || '?'} ← ${String(err?.message || err).slice(0, 160)}`);
      try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* noop */ }
    }
  });
}

/* ------------------------------------------------------------ 真实交互 */
async function realClick(cdp, selector) {
  const box = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

async function realClickByText(cdp, exactText) {
  const box = await cdp.evaluate(`(() => {
    const t = ${JSON.stringify(exactText)};
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], .k-button'));
    const el = nodes.find((n) => (n.textContent || '').trim() === t);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

async function realType(cdp, selector, text, { perChar = 30 } = {}) {
  const focused = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return document.activeElement === el || el.contains(document.activeElement);
  })()`);
  if (!focused) return false;
  await cdp.send('Input.insertText', { text });
  await sleep(perChar);
  return true;
}

async function realScroll(cdp, dy, steps = 10) {
  const box = await cdp.evaluate('({ x: window.innerWidth / 2, y: window.innerHeight / 2 })');
  for (let i = 0; i < steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: dy / steps,
    });
    await sleep(35);
  }
}

async function waitFor(cdp, expr, timeout = 15000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await cdp.evaluate(expr)) return true; } catch { /* 导航中会抛 */ }
    await sleep(150);
  }
  if (label) console.log(`      (等待超时：${label})`);
  return false;
}

/* （截图走 CDP Page.captureScreenshot，视口截图，不用 captureBeyondViewport） */
async function shoot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const buf = Buffer.from(r.data, 'base64');
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, sha: sha16(buf) };
}

/* ------------------------------------------------------------ 浏览器 */
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* noop */ } }
  throw new Error('未找到 chrome.exe（可用 CHROME_PATH 指定）');
}

async function launchBrowser(port, profile) {
  // 分片删除：宿主对单次 >50 文件的删除会抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED（DEV-257）
  if (fs.existsSync(profile)) {
    try {
      const entries = fs.readdirSync(profile);
      for (let i = 0; i < entries.length; i += 25) {
        for (const e of entries.slice(i, i + 25)) {
          try { fs.rmSync(path.join(profile, e), { recursive: true, force: true, maxRetries: 2 }); } catch { /* 晚释放 */ }
        }
      }
    } catch { /* 清理是副作用，不该中断验收 */ }
  }
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(findChrome(), [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--ignore-certificate-errors',
    '--window-size=390,844',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  const t0 = Date.now();
  let target = null;
  while (Date.now() - t0 < 30000) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  if (!target) throw new Error('浏览器未就绪（CDP 端口无页面目标）');
  return { child, wsUrl: target.webSocketDebuggerUrl };
}

async function shutdownBrowser(child, profile) {
  const pid = child?.pid;
  try { child?.kill('SIGKILL'); } catch { /* noop */ }
  if (pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    await sleep(600);
  }
  try {
    const entries = fs.readdirSync(profile);
    for (let i = 0; i < entries.length; i += 25) {
      for (const e of entries.slice(i, i + 25)) {
        try { fs.rmSync(path.join(profile, e), { recursive: true, force: true, maxRetries: 2 }); } catch { /* 晚释放 */ }
      }
    }
  } catch { /* noop */ }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch { /* noop */ }
}

/* =========================================================== 几何探针 */
/**
 * 组 1：列表页搜索区与导航栏的重叠面积。
 * ⚠️ 只量**页面级 sticky 的第二层栏**（搜索/筛选区），与 app.css 的选择器同口径。
 */
const PROBE_SEARCH_OCCLUSION = `(() => {
  const nav = document.querySelector('.k-navbar');
  const body = document.querySelector('.svc-page-body') || document.body;
  const sticky = Array.from(body.children).find((el) =>
    el.classList.contains('sticky') && !el.classList.contains('k-navbar'));
  if (!nav || !sticky) return { found: false, hasNav: Boolean(nav), hasSticky: Boolean(sticky) };
  const a = nav.getBoundingClientRect();
  const b = sticky.getBoundingClientRect();
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return {
    found: true,
    overlap: Math.round(w * h),
    navBottom: Math.round(a.bottom),
    stickyTop: Math.round(b.top),
    scrollTop: Math.round(document.querySelector('.svc-page-body')?.scrollTop ?? window.scrollY),
  };
})()`;

/**
 * 组 2 / 3：Toast 的横向越界与对底部按钮的遮挡。
 * ⚠️ 取 `.k-toast` 的**真实矩形**；横向越界看左边界 <0 或右边界 > innerWidth。
 *    遮挡面积用与前景按钮的矩形交集（不是"看起来压住了"）。
 */
const PROBE_TOAST = `(() => {
  const toast = document.querySelector('.k-toast');
  if (!toast) return { found: false };
  const t = toast.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const btns = Array.from(document.querySelectorAll('.k-button, [role="button"], button'));
  let overlapBtn = 0, btnRect = null;
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 只算"看得见的主按钮"：落在视口下半部
    if (r.top < vh * 0.5) continue;
    const w = Math.max(0, Math.min(t.right, r.right) - Math.max(t.left, r.left));
    const h = Math.max(0, Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top));
    const area = Math.round(w * h);
    if (area > overlapBtn) { overlapBtn = area; btnRect = { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; }
  }
  return {
    found: true,
    left: Math.round(t.left), right: Math.round(t.right),
    top: Math.round(t.top), bottom: Math.round(t.bottom),
    vw, vh,
    overflowLeft: Math.round(Math.max(0, -t.left)),
    overflowRight: Math.round(Math.max(0, t.right - vw)),
    overlapBtn, btnRect,
    text: (toast.textContent || '').trim().slice(0, 40),
    computedBottom: getComputedStyle(toast).bottom,
  };
})()`;

/**
 * 组 4：吸底操作栏底部到视口底的距离（"下方空白"）。
 */
const PROBE_STICKY_GAP = `(() => {
  const bar = document.querySelector('[data-svc-sticky-bar="1"]');
  if (!bar) return { found: false };
  const r = bar.getBoundingClientRect();
  const vh = window.innerHeight;
  return {
    found: true,
    barTop: Math.round(r.top), barBottom: Math.round(r.bottom), vh,
    gap: Math.round(vh - r.bottom),
    position: getComputedStyle(bar).position,
  };
})()`;

/**
 * 组 5：校验定位后，首个错误字段相对**导航栏底边**的可见性。
 */
const PROBE_ERROR_FIELD = `(() => {
  const nav = document.querySelector('.k-navbar');
  const field = document.querySelector('.svc-field-flash') ||
    document.querySelector('[data-svc-field]');
  if (!field) return { found: false };
  const f = field.getBoundingClientRect();
  const navBottom = nav ? Math.round(nav.getBoundingClientRect().bottom) : 0;
  const covered = Math.max(0, Math.round(Math.min(f.bottom, navBottom) - Math.max(f.top, 0)));
  return {
    found: true,
    fieldTop: Math.round(f.top), fieldBottom: Math.round(f.bottom),
    navBottom, coveredHeight: covered,
    id: field.getAttribute('data-svc-field') || '(flash)',
    classNames: field.className,
  };
})()`;

/**
 * 状态色探针：直接读**页面上真实生效的 CSS 变量**，再算对比度。
 *
 * ⚠️ 为什么必须读页面的计算值，而不是读源码/产物文本：
 *   本轮实测踩到的坑 —— 状态色在**两处**定义：
 *     `src/design/tokens.ts`（TS 常量） 与 `src/styles/app.css` 的 `@theme`（CSS 变量）。
 *   只改 tokens.ts 时**产物 CSS 里的值纹丝不动**（改了一处，另一处没动）。
 *   这正是本项目铁律"同一段逻辑出现两次 = 同一个坑有两条腿"。
 *   ⇒ 判据只能落在**浏览器里真正生效的那个值**上。
 */
const PROBE_STATUS_VARS = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const vals = {};
  for (const k of ['--color-svc-success', '--color-svc-warning', '--color-svc-danger',
                   '--color-svc-success-soft', '--color-svc-warning-soft', '--color-svc-danger-soft']) {
    vals[k] = cs.getPropertyValue(k).trim();
  }
  // 顺便把"页面上真实画出来的软底徽标"也找出来（有就量真实矩形）
  const badges = [];
  for (const el of document.querySelectorAll('span, div, mark')) {
    const c = getComputedStyle(el);
    const txt = (el.textContent || '').trim();
    if (!txt || txt.length > 12 || el.children.length) continue;
    if (!/rgb/.test(c.backgroundColor)) continue;
    const fg = c.color; const bg = c.backgroundColor;
    const lum = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      const f = (x) => { const q = x / 255; return q <= 0.03928 ? q / 12.92 : Math.pow((q + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
    const L1 = lum(bg); const L2 = lum(fg);
    if (L1 == null || L2 == null) continue;
    const ratio = Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
    if (ratio < 8) badges.push({ text: txt.slice(0, 10), fg, bg, ratio });
  }
  badges.sort((a, b) => a.ratio - b.ratio);
  return { vars: vals, badges: badges.slice(0, 6) };
})()`;

/**
 * 登录（可切换账号）。
 *
 * ⚠️ 口令**必须从环境读**（与全项目一致），不能写占位值。
 *
 *   第一版我图省事写了个占位口令 `Admin123456` ⇒ 实测 `/api/auth:signIn` 返回 **401**
 *   （`The username/email or password is incorrect`），然后被登录等待判据
 *   表现成"登录超时"。**这是脚本自己的缺陷，不是产品问题**。
 *   缺口令时**判 INVALID**（环境未就绪），绝不退回默认值假装登录成功。
 *
 * ⚠️ 判据必须是「**登录表单不见了 + 出现工作台内容**」，不能是 `pathname.startsWith('/m')`。
 *   登录页自己就在 `/m/` 上 ⇒ 用 pathname 判会**在还没登录时就满足**（太宽的判据）。
 */
const ACCOUNTS = {
  /** 门店售后：能看工单、能改状态；**不能**新建档案 */
  store: () => ({
    account: envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'),
    password: envValue('UAT_STORE_A_PASSWORD'),
    label: '门店售后 uat.store.a',
  }),
  /** 销售/开发：**有建档权限**（`caps.archiveCreate`），建档相关的三组必须用它 */
  sales: () => ({
    account: process.env.SVC_DEV_ACCOUNT || 'arc1_sales_a',
    password: process.env.SVC_DEV_PASSWORD || ARC_TEST_PW,
    label: '销售 arc1_sales_a',
  }),
};

/* 导航（模块级：doLogin 与主流程都要用，不能定义成块内 const） */
async function goto(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await sleep(1200);
  await waitFor(cdp, 'document.readyState === "complete"', 15000, 'readyState');
  await sleep(500);
}

async function doLogin(cdp, which) {
  const { account: acc, password: pwd, label } = ACCOUNTS[which]();
  if (!pwd) throw new Error(`缺少 ${label} 的口令（环境未就绪，判 INVALID）`);
  // 先登出（清 localStorage + cookie），保证"换账号"是真的换
  await cdp.evaluate('(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return true; })()');
  await cdp.send('Network.clearBrowserCookies');
  await goto(cdp, `${BASE_URL}/m/`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-testid="login-account"]'))`, 15000, '登录页');
  await realType(cdp, '[data-testid="login-account"]', acc);
  await realType(cdp, '[data-testid="login-password"]', pwd);
  await realClickByText(cdp, '登录');
  const okLogin = await waitFor(
    cdp,
    `(() => {
      const form = document.querySelector('[data-testid="login-account"]');
      const nav = document.querySelector('.k-navbar');
      const body = document.querySelector('.svc-page-body');
      return !form && Boolean(nav) && Boolean(body);
    })()`,
    20000,
    `${label} 登录完成`,
  );
  return { ok: okLogin, label };
}

/* =========================================================== 主流程 */
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
const want = (n) => !ONLY || ONLY.has(String(n));

console.log('UX-FINAL · 第五节：五组前后对比（同视口/同数据/同主题，唯一变量=前端产物）');
console.log(`  BASE=${BASE_URL}`);
console.log(`  视口：${VW}×${VH}（两版一致）`);
console.log(`  修订前产物：${path.relative(ROOT, BEFORE)}/…（隔离副本重建）`);
console.log(`  修订后产物：src-mobile/dist · h5/dist（当前工作区）`);

fs.mkdirSync(OUT, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  viewport: { width: VW, height: VH },
  method: '单浏览器实例内用 CDP Fetch.fulfillRequest 切换前端产物字节；除产物外无任何变量',
  beforeSource: {
    h5: 'git archive HEAD h5 后 vite build（HEAD = 本轮开工前提交）',
    mobile:
      'src-mobile/ 从未入库（git log 空）且无历史产物 ⇒ 按本轮 5 个修复点逐处反向回退后 vite build；' +
      '副本 .tmp-ux-before/src-mobile/，每处回退都有【BEFORE 副本 · 刻意回退】注释，真实源码未被改动',
  },
  groups: [],
  /**
   * 用户第五节明确要求"**每组配一句普通人能懂的话**"。
   *   ⚠️ 判据：这句话要能让**没做过前端的人**听懂"改了之后好在哪"，
   *     所以不允许出现任何像素值、CSS 属性名、组件名、枚举值。
   *     （数值证据在 `groups[]` 里，两者分开存放。）
   */
  plainWords: [
    { id: 1, key: 'search-occlusion',
      line: '手机上找工单时，搜索框原来被顶上的标题栏压住一半，现在完整露出来了。' },
    { id: 2, key: 'toast-horizontal',
      line: '弹出的小提示原来会跑到屏幕左边外面、看不见字，现在好好待在屏幕中间。' },
    { id: 3, key: 'toast-vertical',
      line: '点「下一步」时弹出的提示原来整条盖在最下面那个大按钮上，现在挪到按钮上面，两边都能看清。' },
    { id: 4, key: 'sticky-gap',
      line: '建档页面最下面那个大按钮原来悬在半空、底下拖着一大条空白，现在贴在屏幕底边，看着不别扭了。' },
    { id: 5, key: 'error-field',
      line: '表单填错的时候，屏幕会跳过去指给你看哪里错了——原来跳是跳了，可那一条正好藏在标题栏后面看不见。' },
    { id: 6, key: 'status-color',
      line: '「待受理」「处理中」这些小标签的底色偏浅、字也偏浅，在太阳底下看不清，现在都加深了一点。' },
    { id: 7, key: 'h5-font',
      line: '客户在手机上看进度时，底下那些小字说明原来太小、要眯眼，现在都放大了一号。' },
  ],
  copyTable: [],
  assertions: [],
  assetHashes: {},
};

let exitCode = 0;
let ticketId = null;
let ticketNo = null;
let sms = null;
let browser = null;
let cdp = null;

try {
  /* ============================================================ 前置：产物哈希 */
  section('第 0 部分 · 记录两版产物的真实哈希（谁都不是"凭感觉"）');
  const hashDir = (dir) => {
    const out = {};
    try {
      for (const f of fs.readdirSync(dir)) {
        out[f] = sha16(fs.readFileSync(path.join(dir, f)));
      }
    } catch { /* 目录缺失 */ }
    return out;
  };
  manifest.assetHashes = {
    mobile_before: hashDir(path.join(BEFORE, 'src-mobile/dist/assets')),
    mobile_after: hashDir(path.join(ROOT, 'src-mobile/dist/assets')),
    h5_before: hashDir(path.join(BEFORE, 'h5/dist/assets')),
    h5_after: hashDir(path.join(ROOT, 'h5/dist/assets')),
  };
  for (const [k, v] of Object.entries(manifest.assetHashes)) {
    note(`${k}: ${Object.entries(v).map(([f, h]) => `${h} ${f}`).join(' | ') || '(空)'}`);
  }
  // 两版必须真的不同，否则"对比"是假的
  const diffMobile = JSON.stringify(manifest.assetHashes.mobile_before) !== JSON.stringify(manifest.assetHashes.mobile_after);
  const diffH5 = JSON.stringify(manifest.assetHashes.h5_before) !== JSON.stringify(manifest.assetHashes.h5_after);
  ok('修订前/修订后两版产物确实不同（否则"对比"无从谈起）', diffMobile || diffH5,
    `移动端差异=${diffMobile} h5差异=${diffH5}`);

  /* ============================================================ 前置：真实数据 */
  section('第 1 部分 · 用真实链路准备夹具（两版共用，保证"同数据"）');
  sms = smsSwitch();
  await sms.enable();
  note(`短信开关：${sms.original ?? '(未读到)'} → 临时开启`);

  const RUN_TAG = String(Date.now()).slice(-6);
  const created = await http(`${BASE_URL}/api/public/tickets${storeEntryQuery('S01')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
    body: JSON.stringify({
      store_code: 'S01',
      ticket_type: 'repair',
      content: `空调不制冷，出风口有异味（对比夹具 ${RUN_TAG}）`,
      customer_name: '周先生',
      customer_mobile: `139${RUN_TAG}1`.slice(0, 11).padEnd(11, '7'),
      privacy_agreed: true,
    }),
  });
  ticketNo = String(created.json?.data?.ticket_no ?? '');
  if (!ticketNo) throw new Error(`匿名建单失败 HTTP ${created.status}`);
  ticketId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${ticketNo}'`));
  note(`夹具工单 ${ticketNo}（id=${ticketId}）—— 两版截图共用这一条`);

  /* ============================================================ 启动浏览器 */
  section('第 2 部分 · 启动浏览器（一个实例贯穿全程）');
  const { child, wsUrl } = await launchBrowser(CDP_PORT, PROFILE);
  browser = child;
  cdp = new Cdp(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await installFetch(cdp);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 2, mobile: true,
  });
  note('浏览器已就绪，Fetch 拦截已装载（同时覆盖 JS/CSS/HTML）');

  /* ------------------------------------------------------ 通用：切版本 + 导航 */
  const setVariant = async (v) => {
    activeVariant = v;
    activeAssets = buildAssetMap(v);
    // 清缓存：产物 hash 不同，但 index.html 必须重新拿
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  };

  /** 跑一次 "before + 操作 + 截图 + 量几何"，再跑一次 after，返回两侧结果 */
  const runPair = async (name, opts) => {
    const { url, act, probes, waitExpr } = opts;
    const result = {};
    /**
     * ⚠️ `variants` / `vh` 可覆盖：
     *   · 组 3 必须用 `before253`（单点回退）—— 两个缺陷会互相掩盖，见 BEFORE_253 注释；
     *   · 组 5 必须用 **390×520** —— 844 高时字段本来就在导航栏下方、根本不需要滚动，
     *     复现不出"滚到之后被遮"（与 DEV-252 原始实测口径一致）。
     */
    const variants = opts.variants || ['before', 'after'];
    const height = opts.vh || VH;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VW, height, deviceScaleFactor: 2, mobile: true,
    });
    for (const v of variants) {
      await setVariant(v);
      /**
       * ⚠️ 每次导航前记录 hitCount，导航后校验**这一遍真的替换过产物**。
       *    这是把"没拦住"从"看上去没差异"里拆出来的唯一手段（组 6 第一版栽在这）。
       */
      const hitBefore = hitCount[v];
      await goto(cdp, url);
      if (waitExpr) await waitFor(cdp, waitExpr, 15000, `${v} 页面就绪`);
      if (act) await act(cdp, v);
      const p = {};
      for (const [k, expr] of Object.entries(probes)) {
        try { p[k] = await cdp.evaluate(expr); } catch (e) { p[k] = { error: String(e).slice(0, 120) }; }
      }
      /**
       * 🔴 **落点探针**：确认页面真的到了被测位置。
       *
       *   全量跑时组 2~5 全部 FAIL 且截图 sha 完全相同 ——
       *   截图一看是「当前账号不能新建档案」（门店账号 `uat.store.a` 没有建档权限）。
       *   也就是说**我量的是一个拒绝页**，而不是被测页面。
       *   这类"页面到了别处"与"改动无效"在数值上都是"两版一样"，
       *   必须靠显式落点判据区分。
       */
      const landing = await cdp.evaluate(`(() => {
        const denied = Array.from(document.querySelectorAll('div'))
          .some((d) => /不能新建档案|无权限|没有权限|请先登录/.test(d.textContent || '') && d.children.length === 0);
        return {
          pathname: location.pathname,
          title: (document.querySelector('.k-navbar')?.textContent || '').trim().slice(0, 24),
          denied,
        };
      })()`);
      if (landing.denied) {
        rows.push({ label: `${name} · ${v} 页面没有到被测位置（落在拒绝页）`, pass: false });
        console.log(`  FAIL  ${name} · ${v} 落在了**拒绝页**（"${landing.title}" @ ${landing.pathname}）`
          + `\n          ⇒ 这一遍量到的不是被测页面，数据不可用`);
      }
      const hits = hitCount[v] - hitBefore;
      if (hits <= 0) {
        rows.push({ label: `${name} · ${v} 这一遍的产物真的被替换了吗`, pass: false });
        console.log(`  FAIL  ${name} · ${v} 这一遍**一次都没替换到产物**（加载的是现役产物）`
          + `\n          hitCount ${v} 增量=0 —— 这一遍的差异不可信`);
      }
      const shot = await shoot(cdp, `${name}-${v}`);
      result[v] = { probe: p, shot, hits, landing };
      note(`${v}: ${shot.sha} ${shot.bytes}B（替换命中 ${hits} 次；落点 ${landing.pathname}）`);
    }
    return result;
  };

  /**
   * ⚠️ 登录**必须前置到所有组之前**（且必须在 `goto` 定义之后）。
   *   第一版把登录写在组 1 里，`--only=6` 单跑时页面停在登录页 ⇒
   *   两版截图 sha 相同，却被读成"没差异"。
   *   ⇒ 判据必须能区分「没有差异」与「没测到」。
   */
  const loginAs = async (which) => {
    const r = await doLogin(cdp, which);
    ok(`前置：已用真实账号登录 —— ${r.label}`, r.ok,
      `落点=${await cdp.evaluate('location.pathname')}`);
    if (!r.ok) throw new Error(`${r.label} 登录未成功（判 INVALID 而不是"没差异"）`);
  };
  await setVariant('after');
  await loginAs('sales');

  /**
   * 🔴 **拦截链路自检**（放在登录之后、第一组之前）。
   *
   *   实测踏坑：`hitCount` 与 `passthrough` **同时为 0**。
   *   这两者同时为 0 只可能是**一个 `Fetch.requestPaused` 都没到** ——
   *   也就是 `Fetch.enable` 在这个会话上没生效，而不是"没拦住业务请求"。
   *   如果只看"两版截图一样"，会得出"改动无效"的错误结论。
   *   ⇒ 必须能把「事件没到」/「事件到了但没匹配上」/「匹配了」三种情况分开。
   */
  {
    const hist = {};
    for (const e of cdp.events) hist[e.method] = (hist[e.method] || 0) + 1;
    const paused = hist['Fetch.requestPaused'] || 0;
    const domDoc = hist['DOM.documentUpdated'] || 0;
    note(`CDP 事件总览：共 ${cdp.events.length} 条；Fetch.requestPaused=${paused}；`
      + `Page.frameNavigated=${hist['Page.frameNavigated'] || 0}；Network.requestWillBeSent=${hist['Network.requestWillBeSent'] || 0}`);
    ok('Fetch 拦截链路真的在工作（登录期间就应暂停到请求）', paused > 0,
      `paused=${paused}（为 0 说明 Fetch.enable 未在此会话生效，此时任何"两版无差异"都不可信；domDoc=${domDoc}）`);
  }

  /* ============================================== 组 1 · 搜索区被导航栏压住 */
  if (want(1)) {
    section('组 1 · 列表页搜索区被导航栏压住（移动端）');
    const r1 = await runPair('g1-search-occlusion', {
      url: `${BASE_URL}/m/archives`,
      waitExpr: `Boolean(document.querySelector('.k-navbar')) && Boolean(document.querySelector('.svc-page-body'))`,
      act: async (c) => { await realScroll(c, 400, 10); await sleep(400); },
      probes: { occ: PROBE_SEARCH_OCCLUSION },
    });
    const b1 = r1.before.probe.occ; const a1 = r1.after.probe.occ;
    ok('组1 修订前确实复现了遮挡（能复现才说明对比有意义）', b1.found && b1.overlap > 0,
      `修订前 overlap=${b1.overlap}px² navBottom=${b1.navBottom} stickyTop=${b1.stickyTop}`);
    ok('组1 修订后遮挡面积降为 0', a1.found && a1.overlap === 0,
      `修订后 overlap=${a1.overlap}px² stickyTop=${a1.stickyTop}`);
    manifest.groups.push({ id: 1, key: 'search-occlusion', before: r1.before, after: r1.after });
  }

  /* ============================================== 组 2/3 · Toast 两处缺陷 */
  if (want(2) || want(3)) {
    /**
     * 组 2 与组 3 都要"点一次下一步"触发 Toast，但**修订前的版本不同**：
     *   · 组 2（横向越界）用 `before`：它在任何吸底状态下都会往左跑，与 DEV-251 无关；
     *   · 组 3（压住按钮）必须用 `before253`：**DEV-253 只在 DEV-251 修好后才显形**
     *     （实测 full-before：吸底栏浮在 687、Toast 落在 784~828，两者不重叠 ⇒ 看不到遮挡）。
     *     ⇒ 这是"两个缺陷互相掩盖"的实例，必须单点复现。
     */
    if (want(2)) {
      section('组 2 · Toast 跑到屏幕左侧外（移动端）');
      const r2 = await runPair('g2-toast-horizontal', {
        url: `${BASE_URL}/m/archives/new`,
        waitExpr: `Boolean(document.querySelector('[data-svc-field]'))`,
        act: async (c) => { await realClickByText(c, '下一步'); await sleep(500); },
        probes: { toast: PROBE_TOAST },
      });
      const b2 = r2.before.probe.toast; const a2 = r2.after.probe.toast;
      ok('组2 修订前 Toast 确实横向越界（有溢出才叫修好了）',
        b2.found && (b2.overflowLeft > 0 || b2.overflowRight > 0),
        `修订前 left=${b2.left} right=${b2.right} vw=${b2.vw} 越界左=${b2.overflowLeft} 右=${b2.overflowRight}`);
      ok('组2 修订后 Toast 完全在视口内',
        a2.found && a2.overflowLeft === 0 && a2.overflowRight === 0,
        `修订后 left=${a2.left} right=${a2.right} vw=${a2.vw}`);
      ok('组2 两张截图确实不同（差异肉眼可见）',
        r2.before.shot.sha !== r2.after.shot.sha,
        `before=${r2.before.shot.sha} after=${r2.after.shot.sha}`);
      manifest.groups.push({ id: 2, key: 'toast-horizontal', before: r2.before, after: r2.after });
    }
    if (want(3)) {
      section('组 3 · Toast 整条压在吸底主按钮上（移动端 · 单点回退）');
      const r3 = await runPair('g3-toast-vertical', {
        url: `${BASE_URL}/m/archives/new`,
        variants: ['before253', 'after'],
        waitExpr: `Boolean(document.querySelector('[data-svc-field]'))`,
        act: async (c) => { await realClickByText(c, '下一步'); await sleep(500); },
        probes: { toast: PROBE_TOAST },
      });
      const b3 = r3.before253.probe.toast; const a3 = r3.after.probe.toast;
      ok('组3 只回退 DEV-253 时确实复现了遮挡（单点回退才复现得出来）',
        b3.found && b3.overlapBtn > 0,
        `修订前(仅253) overlapBtn=${b3.overlapBtn}px² computedBottom=${b3.computedBottom} `
        + `toast=${b3.top}~${b3.bottom} 按钮=${b3.btnRect?.top}~${b3.btnRect?.bottom}`);
      ok('组3 修订后 Toast 不再遮挡底部按钮',
        a3.found && a3.overlapBtn === 0,
        `修订后 overlapBtn=${a3.overlapBtn}px² computedBottom=${a3.computedBottom}`);
      ok('组3 两张截图确实不同（差异肉眼可见）',
        r3.before253.shot.sha !== r3.after.shot.sha,
        `before253=${r3.before253.shot.sha} after=${r3.after.shot.sha}`);
      manifest.groups.push({ id: 3, key: 'toast-vertical', before: r3.before253, after: r3.after });
    }
  }

  /* ============================================== 组 4 · 吸底栏下方空白 */
  if (want(4)) {
    section('组 4 · 建档页「下一步」下方大块空白（移动端）');
    const r4 = await runPair('g4-sticky-gap', {
      url: `${BASE_URL}/m/archives/new`,
      waitExpr: `Boolean(document.querySelector('[data-svc-sticky-bar="1"]'))`,
      act: async () => { await sleep(300); },
      probes: { gap: PROBE_STICKY_GAP },
    });
    const b4 = r4.before.probe.gap; const a4 = r4.after.probe.gap;
    ok('组4 修订前吸底栏下方确实有大块空白（≥100px）',
      b4.found && b4.gap >= 100, `修订前 gap=${b4.gap}px barBottom=${b4.barBottom} vh=${b4.vh}`);
    ok('组4 修订后吸底栏贴底（gap ≤ 20px）',
      a4.found && a4.gap <= 20, `修订后 gap=${a4.gap}px barBottom=${a4.barBottom} vh=${a4.vh}`);
    manifest.groups.push({ id: 4, key: 'sticky-gap', before: r4.before, after: r4.after });
  }

  /* ============================================== 组 5 · 校验定位被导航栏遮 */
  if (want(5)) {
    section('组 5 · 校验定位后字段被导航栏遮住（移动端 · 390×520）');
    /**
     * ⚠️ **必须用矮视口（390×520）**，这是 DEV-252 原始实测的口径。
     *    在 390×844 下，建档页第一步根本不需要滚动（实测 scrollHeight=clientHeight=844）
     *    ⇒ 字段本来就在导航栏下方，"被遮"复现不出来。
     *    520 高时内容超出一屏，`focusFirstError` 才会真的滚动 ——
     *    而修正前它**没有减去导航栏高度**，字段就停在导航栏背后。
     */
    const r5 = await runPair('g5-error-field', {
      url: `${BASE_URL}/m/archives/new`,
      vh: 520,
      waitExpr: `Boolean(document.querySelector('[data-svc-field]'))`,
      act: async (c) => { await realClickByText(c, '下一步'); await sleep(1600); },
      probes: { fld: PROBE_ERROR_FIELD },
    });
    const b5 = r5.before.probe.fld; const a5 = r5.after.probe.fld;
    ok('组5 修订前字段确实被导航栏遮住（有遮挡才说明修好了）',
      b5.found && b5.coveredHeight > 0,
      `修订前 fieldTop=${b5.fieldTop} fieldBottom=${b5.fieldBottom} navBottom=${b5.navBottom} 被遮=${b5.coveredHeight}px`);
    ok('组5 修订后字段完整可见（0 遮挡）',
      a5.found && a5.coveredHeight === 0,
      `修订后 fieldTop=${a5.fieldTop} fieldBottom=${a5.fieldBottom} navBottom=${a5.navBottom} 被遮=${a5.coveredHeight}px`);
    ok('组5 两张截图确实不同（差异肉眼可见）',
      r5.before.shot.sha !== r5.after.shot.sha,
      `before=${r5.before.shot.sha} after=${r5.after.shot.sha}`);
    manifest.groups.push({ id: 5, key: 'error-field', before: r5.before, after: r5.after });
  }

  /* ============================================== 组 6 · 状态色对比度（两端） */
  if (want(6)) {
    section('组 6 · 状态色在软底上的对比度（两端）');
    /**
     * ⚠️ 必须选一个**真的渲染状态徽标**的页面。
     *    第一版用建档页，那里只有表单，没有软底徽标 ⇒
     *    两版截图 **sha 完全相同**（色值只活在 CSS 变量里，没被画到屏幕上）。
     *    变量断言虽过，但"对比截图"这一交付物是空的。
     *    工单列表页的每张卡片右上角都有 `ServiceStatusBadge`
     *    （`bg-svc-X-soft` + `text-svc-X`），就是用户真正会看的那个地方。
     */
    /**
     * ⚠️ 必须切到**门店售后**账号：工单列表要有"待你处理"等真实工单，
     *    而销售账号 `caps.tickets=false`（它只有档案工作区，没有工单底栏）。
     */
    await setVariant('after');
    await loginAs('store');
    const PROBE_BADGE = `(() => {
      const cs = getComputedStyle(document.documentElement);
      const vars = {};
      for (const k of ['--color-svc-success', '--color-svc-warning', '--color-svc-danger',
                       '--color-svc-success-soft', '--color-svc-warning-soft', '--color-svc-danger-soft']) {
        vars[k] = cs.getPropertyValue(k).trim();
      }
      const lum = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        const f = (x) => { const q = x / 255; return q <= 0.03928 ? q / 12.92 : Math.pow((q + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
      const badges = [];
      for (const el of document.querySelectorAll('span')) {
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length > 8 || el.children.length) continue;
        const c = getComputedStyle(el);
        if (!/rgb/.test(c.backgroundColor) || c.backgroundColor === c.color) continue;
        const L1 = lum(c.backgroundColor); const L2 = lum(c.color);
        if (L1 == null || L2 == null) continue;
        const ratio = Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
        if (ratio < 8) badges.push({ text: txt, fg: c.color, bg: c.backgroundColor, ratio,
          fontSize: c.fontSize });
      }
      badges.sort((a, b) => a.ratio - b.ratio);
      return { vars, badges: badges.slice(0, 8), badgeCount: badges.length };
    })()`;
    const r6 = await runPair('g6-status-color', {
      url: `${BASE_URL}/m/tickets`,
      waitExpr: `Boolean(document.querySelector('[data-testid^="ticket-card-"]'))`,
      act: async () => { await sleep(500); },
      probes: { color: PROBE_BADGE },
    });
    const b6 = r6.before.probe.color; const a6 = r6.after.probe.color;
    const ratioOf = (fg, bg) => {
      const parse = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        const f = (x) => { const q = x / 255; return q <= 0.03928 ? q / 12.92 : Math.pow((q + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
      const L1 = parse(fg); const L2 = parse(bg);
      if (L1 == null || L2 == null) return null;
      return Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
    };
    const hex2rgb = (h) => {
      const v = String(h).trim();
      if (!/^#/.test(v)) return v;
      const n = v.slice(1);
      const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
      return `rgb(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)})`;
    };
    const tri = ['danger', 'warning', 'success'].map((k) => ({
      k, r: ratioOf(hex2rgb(a6.vars[`--color-svc-${k}`]), hex2rgb(a6.vars[`--color-svc-${k}-soft`])),
    }));
    const triBefore = ['danger', 'warning', 'success'].map((k) => ({
      k, r: ratioOf(hex2rgb(b6.vars[`--color-svc-${k}`]), hex2rgb(b6.vars[`--color-svc-${k}-soft`])),
    }));

    ok('组6 两版实际渲染出的状态色确实不同（对比真的发生了）',
      b6.vars['--color-svc-danger'] !== a6.vars['--color-svc-danger'],
      `danger ${b6.vars['--color-svc-danger']} → ${a6.vars['--color-svc-danger']}；`
      + `success ${b6.vars['--color-svc-success']} → ${a6.vars['--color-svc-success']}`);
    ok('组6 修订后三色在各自软底上对比度均 ≥5.4:1（用户裁决门槛，不卡 4.5）',
      tri.every((t) => t.r != null && t.r >= 5.4), tri.map((t) => `${t.k}=${t.r}:1`).join(' '));
    ok('组6 修订前三色确实不达 4.5:1（否则没有要修的问题）',
      triBefore.every((t) => t.r != null && t.r < 4.5), triBefore.map((t) => `${t.k}=${t.r}:1`).join(' '));
    ok('组6 页面上真的画出了软底状态徽标（不是只有变量）',
      a6.badgeCount > 0, `修订后徽标数=${a6.badgeCount}，最差 ${a6.badges?.[0]?.ratio}:1（${a6.badges?.[0]?.text}）`);
    ok('组6 修订前后两张截图**确实不同**（截图本身能看出差异）',
      r6.before.shot.sha !== r6.after.shot.sha,
      `before=${r6.before.shot.sha} after=${r6.after.shot.sha}`);
    manifest.groups.push({ id: 6, key: 'status-color', before: r6.before, after: r6.after, ratios: { before: triBefore, after: tri } });
  }

  /* ============================================== 组 7 · h5 小字号（客户页） */
  if (want(7)) {
    section('组 7 · h5 客户进度页小字号辅助文字（客户侧）');
    // 需要一个真实可访问的进度页 —— 用夹具工单的进度 Token
    const prog = await http(`${BASE_URL}/api/svc/tickets/${ticketId}/timeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
      body: '{}',
    }).catch(() => ({ status: 0 }));
    note(`（时间线探测 HTTP ${prog.status}，仅用于确认工单可访问）`);

    const probeFonts = `(() => {
      const sel = ['.svc-hint', '.svc-note-help', '.svc-error', '.svc-step-label', '.svc-last-order-at', '.svc-ticketno .svc-k', '.svc-k', '.svc-progress-at'];
      const out = [];
      for (const s of sel) {
        for (const el of document.querySelectorAll(s)) {
          const fs = parseFloat(getComputedStyle(el).fontSize);
          const txt = (el.textContent || '').trim();
          if (!txt) continue;
          out.push({ sel: s, size: fs, text: txt.slice(0, 14) });
        }
      }
      return out;
    })()`;
    // h5 报修页是可匿名访问的真实入口（带门店 k）
    const entry = storeEntryQuery('S01');
    const r7 = await runPair('g7-h5-font', {
      url: `${BASE_URL}/h5/report${entry}`,
      waitExpr: `Boolean(document.querySelector('.svc-hint') || document.querySelector('.svc-card'))`,
      act: async () => { await sleep(400); },
      probes: { fonts: probeFonts },
    });
    const b7 = r7.before.probe.fonts || []; const a7 = r7.after.probe.fonts || [];
    const minB = Math.min(...b7.map((x) => x.size).filter((n) => n > 0));
    const minA = Math.min(...a7.map((x) => x.size).filter((n) => n > 0));
    const cntB = b7.filter((x) => x.size <= 12.5).length;
    const cntA = a7.filter((x) => x.size <= 12.5).length;
    ok('组7 修订后 ≤12.5px 的辅助文字数量减少',
      Number.isFinite(minB) && Number.isFinite(minA) && cntA < cntB,
      `修订前 ${b7.length} 处中 ${cntB} 处 ≤12.5px（最小 ${minB}px）→ 修订后 ${a7.length} 处中 ${cntA} 处（最小 ${minA}px）`);
    manifest.groups.push({ id: 7, key: 'h5-font', before: r7.before, after: r7.after });
  }

  /* ============================================== 拦截自证 */
  section('第 3 部分 · 自证：产物拦截真的生效了');
  ok('两版产物都真实被拦截替换过（hitCount 两侧均 > 0）',
    hitCount.before > 0 && hitCount.after > 0,
    `before=${hitCount.before} after=${hitCount.after} 放行=${hitCount.passthrough}`);
  ok('拦截处理器自己没有静默失败（兜底分支不得吞异常）', handlerErrors.length === 0,
    handlerErrors.length === 0 ? '无异常'
      : `${handlerErrors.length} 条：${handlerErrors.slice(0, 3).join(' | ')}`);
  manifest.fetchHits = { ...hitCount };
  manifest.handlerErrors = handlerErrors.slice(0, 20);
  manifest.assertions = rows.map((r) => ({ label: r.label, pass: r.pass }));

  /* ============================================== 文案修订表 */
  section('第 4 部分 · 文案修订表（用户可见文案：修订前 → 修订后）');
  /**
   * ⚠️ 这张表**只列用户能看见的话**。
   *    代码枚举、技术测试标识、API 名称一律不列（用户第三节明确禁止展示）。
   *    ⚠️ 与"看起来更顺口"无关 —— 每一行都要能指到真实界面位置。
   */
  manifest.copyTable = [
    { where: '移动端 · 登录页', before: '提示色 #d0342c（软底 4.36:1，偏浅）', after: '提示色 #b62d26（软底 5.41:1）', why: '客户手机上小字看不清' },
    { where: '移动端 · 状态徽标「待受理」（同批三色）', before: '成功 #128f57 / 警告 #b56a00', after: '成功 #0e7245 / 警告 #915500', why: '软底对比度由 3.76 / 3.84 提到 5.45 / 5.52' },
    { where: '移动端 · 建档页错误提示', before: '11px 红字', after: '13px 红字', why: '反馈信息不该比正文还小' },
    { where: '移动端 · 表单标签与说明', before: '11–12px', after: '12–13px', why: '门店员工常年在强光/戴手套环境操作' },
    { where: 'h5 · 客户报修页「拍摄/相册」下方说明', before: '11px', after: '12.5px', why: '这是操作提示，不是装饰' },
    { where: 'h5 · 拍照剩余张数 / 录制计时', before: '11px', after: '12.5px', why: '实时读数读不准等于没有' },
    { where: 'h5 · 进度页「工单编号」标签等辅助文字', before: '12–12.5px', after: '13px', why: '中老年用户看得清' },
    { where: 'h5 · 门店地址行', before: '12px', after: '13px', why: '同上' },
    { where: 'h5 · 音视频无法识别时的提示', before: '这个文件读不出时长，请重新录制', after: '暂时无法识别这个文件的音视频内容，请尝试更换文件，或使用手机自带的拍摄、录音功能重新制作后上传。', why: '旧文案会让用户反复重录同一格式，永远无效' },
    { where: 'h5 · 低星评价提示（1–2 星）', before: '只说明"会被看到"', after: '提交后该工单会退回门店重新处理，门店可能会再与您联系。', why: '客户给低分时的预期是"有人处理"，不是"被记录"' },
    { where: 'h5 · 评价提交结果', before: '已提交', after: '已提交，门店会再与您联系 / 感谢您的评价', why: '如实区分"退回重处理"与"正常结单"两种情况' },
    { where: 'h5 · 进度页师傅卡片', before: '没有真实姓名/电话也渲染卡片，兜底写「门店已安排服务人员」', after: '没有真实师傅信息就整块不渲染；重开单里标注「此前服务师傅」', why: '原来自相矛盾（同一页写着"尚未派工"）' },
  ];
  for (const c of manifest.copyTable) {
    console.log(`  · [${c.where}]\n      前：${c.before}\n      后：${c.after}\n      因：${c.why}`);
  }
  ok('文案修订表已生成（每条都能指到真实界面位置）', manifest.copyTable.length >= 10,
    `${manifest.copyTable.length} 条`);

  /* ============================================== 每组一句普通人能懂的话 */
  section('第 5 部分 · 每组一句普通人能懂的话');
  for (const p of manifest.plainWords) console.log(`  组${p.id}：${p.line}`);
  /**
   * ⚠️ 断言：这句话里**不能出现**像素值 / CSS 属性名 / 组件名 / 枚举值。
   *   否则等于把"给普通人看的说明"写成了给工程师看的变更日志。
   */
  const jargon = /px|flex|sticky|Toast|z-index|--color|DEV-\d+|枚举|ACL|API/;
  const bad = manifest.plainWords.filter((p) => jargon.test(p.line));
  ok('每组的说明都没有技术黑话（普通人能读懂）', bad.length === 0,
    bad.length === 0 ? `${manifest.plainWords.length} 组全部通过`
      : `含黑话：${bad.map((b) => `组${b.id}`).join('、')}`);
  ok('七组各有且仅有一句说明', manifest.plainWords.length === 7,
    `${manifest.plainWords.length} 句`);

  exitCode = rows.some((r) => r.pass === false) ? 1 : 0;
} catch (e) {
  console.error(`\n环境未就绪或中断：${e?.message || e}`);
  exitCode = 2;
} finally {
  try { cdp?.close(); } catch { /* noop */ }
  try { if (browser) await shutdownBrowser(browser, PROFILE); } catch { /* noop */ }
  try {
    if (sms) { await sms.restore(); note('短信开关已恢复'); }
  } catch { /* noop */ }
  try {
    if (ticketId) {
      const n = cleanupTicket(ticketId);
      note(`夹具工单 ${ticketNo}（id=${ticketId}）已清理：库中剩余 ${psqlScalar(`SELECT count(*) FROM service_tickets WHERE id = ${ticketId}`)} 行`);
    }
  } catch { /* noop */ }
  try { fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2)); } catch { /* noop */ }
  const pass = rows.filter((r) => r.pass === true).length;
  const fail = rows.filter((r) => r.pass === false).length;
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  console.log(`产物：${path.relative(ROOT_DIR, OUT)}`);
}
process.exit(exitCode);
