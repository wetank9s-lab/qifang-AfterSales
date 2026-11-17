/**
 * _b36-browser-scenarios.mjs —— B-36 **真实浏览器**验证（用户 §五 的三个场景）
 *
 * =============================================================================
 * 🔴 为什么必须有这一支（用户原话）
 * =============================================================================
 *   「只验证三个实际场景：① 后台上传并发布后，客户报修页可以看到图片；
 *     ② 切换门店时，只显示有权适用的 Banner 或总部通用 Banner；
 *     ③ 下架后客户端不再显示，原有客户私有附件仍不可匿名读取。
 *     **不得把脚本 PASS 代替真实浏览器效果。**」
 *
 *   ⇒ 接口层已由 `_b36-banner-e2e.mjs`（55 项）覆盖；本脚本回答的是**另一个问题**：
 *     「人在浏览器里**看到**了什么」。接口 200 只证明后端有数据；
 *     **渲染出来的 DOM/像素**才证明客户真的看得到图。
 *
 * =============================================================================
 * 三个场景各自"看见"的定义（每条都要能变红）
 * =============================================================================
 *   ① 上传并发布 ⇒ 用**门店签名入口**打开 H5 报修页，DOM 里存在
 *      `[data-testid="top-banner-img"]`，且它的 `src` 指向那张图，
 *      且图片**真的加载成功**（`naturalWidth > 0`，不是 404 的空框）。
 *   ② 门店匹配 ⇒ 用**不同门店的入口**各开一次：S01 看到 S01 的图、
 *      S04 看到总部通用图（或自己的），两者指纹**不同**；且不遮挡
 *      「我要报修 / 我要投诉」与联系人输入（几何相交判定）。
 *   ③ 下架 ⇒ 同一入口再开一次，`top-banner` **不存在**（不是空白占位）；
 *      并现场验证客户私有附件接口在**无凭证**下仍被拒（隔离未被破坏）。
 *
 * =============================================================================
 * 🔴 证据形态（防止"拍到了同一张图"这类假绿）
 * =============================================================================
 *   · 每张截图记 **字节数 + sha256**，用哈希区分不同状态 ——
 *     本项目有过"两张不同文件名的图 md5 相同"的假证据；
 *   · 截图用**视口截图**（不带 `captureBeyondViewport`）：超长截图会触发重排、
 *     把页面打回 loading（项目已踩过）；
 *   · 每张图必须 > 5KB，否则判"空白图"。
 *
 * 用法：node scripts/_b36-browser-scenarios.mjs
 * 退出码：0 全绿 / 1 产品红 / 2 环境未就绪
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';

import {
  CONFIG_TTL_WAIT_MS,
  createRateLimitGate,
  purgeBanners,
  readEnv,
  signIn,
  makeApi,
  fingerprintOf,
  sha16,
  uuid,
} from './_b36-lib.mjs';
import { storeEntryToken } from './lib/store-entry-token.mjs';

// ⚠️ H5 挂在 nginx 的 **443**（`/h5/` location），不是 8080 —— 8080 是 80 端口，
//    对 `/h5/*` 一律 301 到 https（实测），headless 里跟这个跳转只会白等。
//    实测可达：`https://127.0.0.1/h5/report` = 200。
const H5_BASE = 'https://127.0.0.1';
const API_BASE = 'https://127.0.0.1';
const OUT = path.resolve('storage/tmp/b36-browser');
const VW = 390;
const VH = 844;
const DPR = 2;
const env = readEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ Chrome */
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

/** 一次性 Chrome + 严格 390 视口（手机仿真），返回句柄与截图/取值函数 */
async function launch({ label }) {
  const port = 9800 + Math.floor(Math.random() * 300);
  const profile = path.join(os.tmpdir(), `b36-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: DPR, mobile: true });

  const close = () => {
    try { cdp.close(); } catch { /* noop */ }
    try { child.kill('SIGKILL'); } catch { /* noop */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 晚释放 */ } }, 300);
  };
  return { cdp, close, profile };
}

/** 打开 URL 并等到页面稳定（readyState + 一点 Vue 渲染余量） */
async function open(cdp, url, budget = 12000) {
  await cdp.send('Page.navigate', { url });
  const t = Date.now();
  while (Date.now() - t < budget) {
    const st = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
      .then((r) => r.result?.value).catch(() => null);
    if (st === 'complete') break;
    await sleep(200);
  }
  await sleep(1500);
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

/** 视口截图 + 字节数/sha256 自证 */
async function shot(cdp, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(file, buf);
  const pngW = buf.readUInt32BE(16);
  return { file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16), pngW };
}

/* ------------------------------------------------------------------- 断言 */
let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log(`  ✅ ${m}`); };
const no = (m) => { fails.push(m); console.log(`  ❌ ${m}`); };
const chk = (c, m) => (c ? ok(m) : no(m));

/**
 * 从 DOM 里读"客户看到了什么"。
 * ⚠️ 用 `data-testid` 而不是文案：文案会变，testid 是契约。
 * ⚠️ 图片加载态必须看 `naturalWidth`：`<img>` 在 404 时**仍然存在**且
 *    `getBoundingClientRect()` 可能有尺寸（有 CSS 高度），只看"元素在不在"
 *    会把一张裂图判成"显示成功"。
 */
const READ_EXPR = `(() => {
  const box = document.querySelector('[data-testid="top-banner"]');
  const img = document.querySelector('[data-testid="top-banner-img"]');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  // 「我要报修 / 我要投诉」与联系人输入：按**可见文案**找（它们是既有 UI，没有 testid）
  const hits = [];
  for (const el of document.querySelectorAll('button, input, textarea, [role="button"]')) {
    const t = ((el.textContent || '') + ' ' + (el.getAttribute('placeholder') || '')).trim();
    if (/我要报修|我要投诉|联系人|手机号|您的姓名/.test(t)) hits.push({ tag: el.tagName, text: t.slice(0, 20), rect: rect(el) });
  }
  return {
    hasBannerBox: !!box,
    hasImgEl: !!img,
    imgSrc: img ? img.getAttribute('src') : null,
    imgNaturalW: img ? img.naturalWidth : null,
    imgNaturalH: img ? img.naturalHeight : null,
    imgComplete: img ? img.complete : null,
    bannerRect: rect(box),
    ctas: hits,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    bodyText: (document.body.innerText || '').slice(0, 300),
  };
})()`;

/* --------------------------------------------------------------------- main */
console.log('\n══════════════════════════════════════════════════════════');
console.log('  B-36 真实浏览器验证（§五 三个场景）');
console.log('══════════════════════════════════════════════════════════');

const gate = createRateLimitGate();
const note = gate.note;
const api = makeApi(API_BASE, note);
let browser = null;

try {
  gate.raise();
  console.log(`  ⏳ 等配置 TTL（${CONFIG_TTL_WAIT_MS}ms）…`);
  await sleep(CONFIG_TTL_WAIT_MS);

  const clean = await purgeBanners([1, 4], 'browser 前置');
  if (!clean) throw new Error('前置清理未归零 ⇒ 环境未就绪');
  ok('前置：门店 1/4 的 Banner 已清零');

  const hq = await signIn(API_BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
  ok('总部管理员登录成功');

  // 造两张**肉眼可分辨**的图：
  //   A = 蓝紫系（门店 1 专属）  B = 橙红系（总部通用）
  // 色系不同 ⇒ 截图里一眼能看出"换了图"，而不是靠哈希自证。
  const pngA = makePng(1280, 400, [[30, 60, 180], [80, 120, 240], [140, 90, 220]]);
  const pngB = makePng(1280, 400, [[230, 120, 20], [250, 190, 40], [200, 60, 60]]);
  const fpA = sha16(pngA);
  const fpB = sha16(pngB);
  chk(fpA !== fpB, `两张素材指纹不同（A=${fpA} 蓝紫系 / B=${fpB} 橙红系）`);

  browser = await launch({ label: 'b36' });
  const { cdp } = browser;

  // ══════════════════════════════ 场景 ① 后台上传并发布 ⇒ 客户页看得到
  console.log('\n【场景①】后台上传并发布 ⇒ 客户报修页**真的显示图片**');
  {
    // 走**后台真实上传接口**（与 BannerManager 完全同一条路）
    const fd = new FormData();
    fd.append('banner', new Blob([pngA], { type: 'image/png' }), 'scenario-a.png');
    const upRes = await fetch(`${API_BASE}/api/svc:bannerUpload?store_id=1&alt_text=${encodeURIComponent('门店1横幅')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${hq}`, 'X-Request-Id': uuid() }, body: fd,
    });
    const upJson = await upRes.json().catch(() => null);
    note(upRes.status, JSON.stringify(upJson ?? {}));
    chk(upRes.status === 200, `后台上传 HTTP 200（实际 ${upRes.status}）`);
    const idA = upJson?.data?.id;
    chk(Number.isInteger(idA), `上传返回 Banner id=${idA}`);
    chk(upJson?.data?.status === 'DRAFT', `上传后是草案状态（实际 ${upJson?.data?.status}）`);
    if (!Number.isInteger(idA)) throw new Error('上传未返回 id ⇒ 无法继续');

    // 草案：客户页必须**看不到**（这也是"发布才有用"的反证）
    const entryA = storeEntryToken('S01');
    await open(cdp, `${H5_BASE}/h5/report?k=${encodeURIComponent(entryA)}`);
    const draftRead = await evaluate(cdp, READ_EXPR);
    chk(!draftRead.hasImgEl, '草案（未发布）⇒ 客户页**没有** Banner 图（发布前不生效）');

    // 发布
    const pub = await api(hq, '/api/svc:bannerPublish', {
      method: 'POST', json: { banner_id: idA }, headers: { 'X-Request-Id': uuid() },
    });
    chk(pub.status === 200, `后台发布 HTTP 200（实际 ${pub.status}）`);

    // 客户页再看一次
    await open(cdp, `${H5_BASE}/h5/report?k=${encodeURIComponent(entryA)}`);
    const read = await evaluate(cdp, READ_EXPR);
    chk(read.hasBannerBox, '发布后：客户页 DOM 里出现 `top-banner` 容器');
    chk(read.hasImgEl, '发布后：`top-banner-img` 元素存在');
    chk(typeof read.imgSrc === 'string' && read.imgSrc.includes('/api/public/banner/'), `图片 src 指向公开接口（实际 ${read.imgSrc}）`);
    chk(fingerprintOf({ url: read.imgSrc }) === fpA, `显示的是**刚上传的那张**（指纹 ${fingerprintOf({ url: read.imgSrc })} == ${fpA}）`);
    // ★ 关键：图**真的加载出来了**（元素在 ≠ 图出来了）
    chk(read.imgNaturalW > 0, `图片真实加载成功（naturalWidth=${read.imgNaturalW}，非 0 说明不是裂图）`);
    chk(read.bodyText.length > 0, '页面有正文（不是空白页）');

    const s1 = await shot(cdp, 's1-published');
    chk(s1.bytes > 5000, `场景①截图有内容（${s1.bytes}B, sha=${s1.sha256}）`);
    chk(s1.pngW === VW * DPR, `场景①截图宽度正确（${s1.pngW} == ${VW}×${DPR}）`);

    // ══ ④ 不遮挡（用户明写："不遮挡我要报修/我要投诉和联系人输入"）
    console.log('\n【场景①附】Banner **不遮挡**报修/投诉按钮与联系人输入');
    chk(Array.isArray(read.ctas) && read.ctas.length > 0, `页面上找到 ${read.ctas?.length ?? 0} 个关键控件（报修/投诉/联系人）`);
    if (read.bannerRect && Array.isArray(read.ctas)) {
      const br = read.bannerRect;
      const overlaps = read.ctas.filter((c) => c.rect && !(
        c.rect.bottom <= br.y || c.rect.y >= br.bottom ||
        c.rect.x + c.rect.w <= br.x || c.rect.x >= br.x + br.w
      ));
      chk(overlaps.length === 0, `与 Banner 容器**几何不相交**（相交 ${overlaps.length} 个）${overlaps.length ? '：' + overlaps.map((o) => o.text).join('/') : ''}`);
    } else {
      no('拿不到 Banner 或控件的几何，无法判遮挡');
    }
    chk(read.scrollW <= read.innerW + 1, `无横向溢出（scrollW=${read.scrollW} innerW=${read.innerW}）`);
    // 高度受限（用户要求"限制手机端高度"）：不能吃掉半个屏
    if (read.bannerRect) {
      const ratio = read.bannerRect.h / VH;
      chk(ratio <= 0.35, `Banner 高度受控（${read.bannerRect.h}px = 视口 ${(ratio * 100).toFixed(1)}% ≤ 35%）`);
    }

    // ══════════════════════════════ 场景 ② 切换门店
    console.log('\n【场景②】切换门店 ⇒ 只显示**有权适用**的 Banner 或总部通用');
    {
      // 现在：S01 有自己的图（A）。给"总部通用"也放一张（B）。
      const hqUp = await (async () => {
        const fd2 = new FormData();
        fd2.append('banner', new Blob([pngB], { type: 'image/png' }), 'scenario-hq.png');
        return fetch(`${API_BASE}/api/svc:bannerUpload?alt_text=${encodeURIComponent('总部通用横幅')}`, {
          method: 'POST', headers: { Authorization: `Bearer ${hq}`, 'X-Request-Id': uuid() }, body: fd2,
        });
      })();
      const hqJson = await hqUp.json().catch(() => null);
      note(hqUp.status, JSON.stringify(hqJson ?? {}));
      chk(hqUp.status === 200, `总部通用图上传 HTTP 200（实际 ${hqUp.status}）`);
      const idHq = hqJson?.data?.id;
      const hqPub = await api(hq, '/api/svc:bannerPublish', {
        method: 'POST', json: { banner_id: idHq }, headers: { 'X-Request-Id': uuid() },
      });
      chk(hqPub.status === 200, `总部通用图发布 HTTP 200（实际 ${hqPub.status}）`);

      // S01（有自己的图）⇒ 必须看到**自己的** A，不是总部通用的 B
      const entryA2 = storeEntryToken('S01');
      await open(cdp, `${H5_BASE}/h5/report?k=${encodeURIComponent(entryA2)}`);
      const rA = await evaluate(cdp, READ_EXPR);
      const fpSeenA = fingerprintOf({ url: rA.imgSrc });
      chk(fpSeenA === fpA, `S01 看到**自己的**图（指纹 ${fpSeenA} == ${fpA}），没被总部通用顶掉`);

      // S04（没有自己的图）⇒ 必须回退到**总部通用** B
      const entryB = storeEntryToken('S04');
      await open(cdp, `${H5_BASE}/h5/report?k=${encodeURIComponent(entryB)}`);
      const rB = await evaluate(cdp, READ_EXPR);
      const fpSeenB = fingerprintOf({ url: rB.imgSrc });
      chk(fpSeenB === fpB, `S04 回退到**总部通用**（指纹 ${fpSeenB} == ${fpB}）`);
      chk(fpSeenA !== fpSeenB, `两家门店看到的是**不同**的图（S01=${fpSeenA} S04=${fpSeenB}）—— 切换门店真的换了图`);
      chk(rB.imgNaturalW > 0, `S04 的图真实加载成功（naturalWidth=${rB.imgNaturalW}）`);

      const s2 = await shot(cdp, 's2-store-switch');
      chk(s2.bytes > 5000, `场景②截图有内容（${s2.bytes}B, sha=${s2.sha256}）`);
      chk(s2.sha256 !== s1.sha256, `场景②截图与场景①**不是同一张**（sha 不同）`);

      // ══ 场景 ③ 下架
      console.log('\n【场景③】下架 ⇒ 客户端**不再显示**，且私有附件仍不可匿名读');
      const revA = await api(hq, '/api/svc:bannerRevoke', {
        method: 'POST', json: { banner_id: idA }, headers: { 'X-Request-Id': uuid() },
      });
      chk(revA.status === 200, `下架 S01 的 Banner HTTP 200（实际 ${revA.status}）`);

      await open(cdp, `${H5_BASE}/h5/report?k=${encodeURIComponent(entryA2)}`);
      const rAfter = await evaluate(cdp, READ_EXPR);
      const fpAfter = fingerprintOf({ url: rAfter.imgSrc });
      chk(fpAfter === fpB, `S01 下架后**改回总部通用**（指纹 ${fpAfter} == ${fpB}）`);
      chk(fpAfter !== fpA, `已下架的图**不再出现**（${fpAfter} != ${fpA}）`);

      // 连总部通用也下架 ⇒ 彻底不显示（且**不留空白占位**）
      const revHq = await api(hq, '/api/svc:bannerRevoke', {
        method: 'POST', json: { banner_id: idHq }, headers: { 'X-Request-Id': uuid() },
      });
      chk(revHq.status === 200, `下架总部通用 Banner HTTP 200（实际 ${revHq.status}）`);

      await open(cdp, `${H5_BASE}/h5/report?k=${encodeURIComponent(entryA2)}`);
      const rNone = await evaluate(cdp, READ_EXPR);
      chk(!rNone.hasBannerBox, '全都没配 ⇒ `top-banner` 容器**根本不渲染**（不是留一块空白）');
      chk(!rNone.hasImgEl, '全都没配 ⇒ 没有 img 元素');
      chk(rNone.bodyText.includes('报修') || rNone.bodyText.includes('投诉'), '页面主体仍在（报修页正常，只是没有 Banner）');

      const s3 = await shot(cdp, 's3-revoked');
      chk(s3.bytes > 5000, `场景③截图有内容（${s3.bytes}B, sha=${s3.sha256}）`);
      chk(s3.sha256 !== s1.sha256 && s3.sha256 !== s2.sha256, '场景③截图与①②都不同（三张图互不相同）');

      // ══ 隔离：客户私有附件仍不可匿名读（用户点名要验）
      console.log('\n【隔离】原有客户私有附件**仍不可匿名读取**');
      const priv = await fetch(`${API_BASE}/api/public/media/1`).catch(() => null);
      chk(priv && (priv.status === 401 || priv.status === 403 || priv.status === 404),
        `` + `客户私有附件无凭证被拒（HTTP ${priv?.status}）`);
      // 已下架的 Banner URL 也必须读不到（不是"只是不显示"）
      const oldUrl = `${API_BASE}/api/public/banner/banner-${fpA}.png`;
      const oldRes = await fetch(oldUrl).catch(() => null);
      chk(oldRes && oldRes.status === 404, `已下架的 Banner 公开 URL 直接访问 ⇒ 404（实际 ${oldRes?.status}）`);
    }
  }
} catch (error) {
  console.log(`\n  ⚠️ 中断：${String(error?.message ?? error)}`);
  fails.push(`中断：${String(error?.message ?? error)}`);
} finally {
  try { if (browser) browser.close(); } catch { /* noop */ }
  try {
    const cleaned = await purgeBanners([1, 4], 'browser 收尾');
    if (!cleaned) console.log('  ⚠️ 收尾清理未归零');
  } catch { /* noop */ }
}

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  截图目录：${OUT}`);
if (gate.state.sawRateLimit) {
  console.log('  ⚠️ 环境未就绪：撞到限流（429）—— 本结论不作数');
  process.exit(2);
}
if (fails.length) {
  console.log(`  ❌ 真实浏览器验证：通过 ${pass} / 失败 ${fails.length}`);
  console.log('  失败项：');
  for (const f of fails) console.log(`    - ${f}`);
  process.exit(1);
}
console.log(`  ✅ 三个场景全部通过：${pass} 项`);
process.exit(0);

/* ---------------------------------------------------- 纯 Node PNG 编码器 */
/**
 * 造一张 PNG。
 *
 * ⚠️ `palette` 必须显式给：首版用 `seed` 做算术生成颜色，
 *    结果 seed=2001 与 2002 算出的 RGB 只差 20 上下 ⇒ 两张图**肉眼几乎一样**。
 *    那样截出来的"换门店前后"两张图，人**看不出区别** —— 证据等于没有。
 *    （本项目的假绿教训：两张不同文件名的图 md5 相同；这里是它的近亲：
 *     两张图**确实不同**、但**看起来一样**，同样无法作为"换了图"的证据。）
 *    ⇒ 改成显式调色板，让两张图在**色系**上就分得开。
 */
function makePng(width, height, palette) {
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const band = Math.min(palette.length - 1, Math.floor((x * palette.length) / width));
      const [r, g, b] = palette[band];
      // 斜条纹：让"图真的被渲染"一眼可辨（纯色块看不出缩放/裁剪）
      const stripe = (x + y) % 40 < 20 ? 22 : 0;
      const o = rowStart + 1 + x * 3;
      raw[o] = Math.min(255, r + stripe);
      raw[o + 1] = Math.min(255, g + stripe);
      raw[o + 2] = Math.min(255, b + stripe);
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
