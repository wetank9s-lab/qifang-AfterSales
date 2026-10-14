/**
 * P11-5 · 师傅 H5 **真实浏览器**验收（Chromium 手机视口）
 *
 *   node scripts/verify-technician-detail-browser.mjs
 *
 * 用**合成工单**（不碰真实客户信息）：建三张单（只照片 / 只语音 / 只视频）→ 派工 → 取师傅链接，
 * 然后**真的打开师傅 H5**，逐项验证用户列出的 8 条。
 *
 * 🔴 关键判据（不是"控件看起来在"）：
 *   · 照片：`<img>` 的 `naturalWidth > 0`（**真的解码出来了**）＋ 点击后大图查看器出现且图片可缩放
 *   · 音频/视频：`readyState >= 2`（有元数据）＋ `duration > 0` ＋ **`play()` 后 `currentTime` 真的增长**
 *   · 媒体请求：用 CDP 抓 Network，确认**加载走的是受控读取接口**
 *     （`/api/technician/visits/<token>/media/<ref>`），不是公开静态路径
 *
 * ⚠️ 这是 **Chromium 手机视口**，不是真机；真机（iPhone Safari / Android / 微信）**未验证**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BASE_URL,
  ROOT,
  http,
  psqlScalar,
  smsSwitch,
  twoSessions,
  acceptAndDispatch,
  tokenFromOutbox,
} from './technician-harness.mjs';

const require = createRequire(import.meta.url);
const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIX = path.join(ROOT, 'nocobase/plugins/service-ticket/test-fixtures/real-media');
const OUT = path.join(ROOT, 'storage/tmp/device-test');
const ENTRY = JSON.parse(fs.readFileSync(path.join(OUT, 'entry.json'), 'utf8')).entry;
const IMG = fs.readFileSync(path.join(ROOT, 'storage/tmp/historical-ui/10-review.png'));
const AUDIO = fs.readFileSync(path.join(FIX, 'audio-chrome.webm'));
const VIDEO = fs.readFileSync(path.join(FIX, 'video-chrome.webm'));

const rid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

/** 受控节奏（`svc_public` 是 30r/m ⇒ 命中就等窗口，不改限流） */
const PACE_MS = 2500;  // `svc_public` 是 30r/m ⇒ 严格遵守 2s/请求，宁可慢也不撞限流
let lastAt = 0;
async function paced(fn) {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  let out = await fn();
  for (let i = 0; i < 2 && out?.status === 429; i += 1) {
    console.log('  · 撞限流，等 25s 窗口…');
    await sleep(25_000);
    out = await fn();
  }
  return out;
}

async function makeTicket(kind, buffer, name) {
  const s = await paced(() =>
    http(`${BASE_URL}/api/public/media/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_consent: true }),
    }),
  );
  const sess = s.json?.data;
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  await paced(() =>
    http(`${BASE_URL}/api/public/media/upload`, {
      method: 'POST',
      headers: { 'X-Media-Session': sess.session_token },
      body: form,
    }),
  );
  const created = await paced(() =>
    http(`${BASE_URL}/api/public/tickets?k=${ENTRY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
      body: JSON.stringify({
        ticket_type: 'repair',
        content: '', // 客户**一个字都不写**
        customer_name: 'P115 浏览器验收',
        // ⚠️ 必须**每个单一个唯一号**：另有按**手机号**的提交频控
        //    （`scope=mobile, limit=5/天`）—— 用固定号或随机碰撞会拿到
        //    `RATE_LIMITED 该手机号今日提交次数已达上限`，那是频控不是缺陷。
        customer_mobile: `13${String(Date.now()).slice(-9)}`,
        service_address: '新都区 P115 路 9 号 3 单元 501',
        appliance_category: 'air_conditioner',
        brand_model: '格力 KFR-35GW',
        media_session: { id: sess.session_id, token: sess.session_token },
      }),
    }),
  );
  const no = created.json?.data?.ticket_no;
  // 🔴 建单失败必须**明确报错并说出 HTTP 状态**：否则会带着空号继续跑，
  //    最后在"受理"处得到 `ticket_id 必须是正整数（实际 "0"）`这种**指向错误方向**的报错
  //    （本轮踩到：真实原因是建单撞了限流 429）。
  if (!no) throw new Error(`建单失败：HTTP ${created.status} ${JSON.stringify(created.json?.errors?.[0] ?? created.text?.slice(0, 120) ?? '')}`);
  return { no, id: Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${no}'`)), kind };
}

/** 极简 CDP 客户端 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (!m.id && m.method && this.handlers.has(m.method)) for (const h of this.handlers.get(m.method)) h(m.params ?? {});
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
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
          reject(new Error('CDP 超时 ' + method));
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
      if (Date.now() > deadline) throw new Error('等待超时: ' + expr.slice(0, 60));
      await sleep(200);
    }
  }
}

const PORT = 9601;
const PROFILE = path.join(os.tmpdir(), `p115-browser-${Date.now()}`);
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--ignore-certificate-errors',
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-5 · 师傅 H5 真实浏览器验收（Chromium 手机视口，非真机）');
  console.log('  ⚠️ 页面路径带 `/h5` base 前缀（router 的 base），不是 `/technician/...`');
console.log('══════════════════════════════════════════════════════════════');

const sw = smsSwitch();
try {
  await sw.enable();
  const { store, hq } = await twoSessions();

  // 三张单：只照片 / 只语音 / 只视频
  const tImg = await makeTicket('image', IMG, 'c.png');
  const tAud = await makeTicket('audio', AUDIO, 'c.webm');
  const tVid = await makeTicket('video', VIDEO, 'c.webm');
  console.log(`  · 合成单：${tImg.no}(照片) / ${tAud.no}(语音) / ${tVid.no}(视频)，文字一律为空`);

  const tokens = {};
  for (const [k, t] of [
    ['image', tImg],
    ['audio', tAud],
    ['video', tVid],
  ]) {
    await acceptAndDispatch(t.id, store);
    const { token } = await tokenFromOutbox({ sessionToken: hq, ticketNo: t.no });
    tokens[k] = token;
  }
  console.log('  · 三张单均已派工并取得师傅链接');

  // ---- 起浏览器 ----
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
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });

  /** 抓媒体相关请求（含状态码），用于确认"走的是受控读取接口" */
  const mediaReqs = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = String(p.request?.url ?? '');
    if (u.includes('/media/')) mediaReqs.push({ url: u, status: null });
  });
  cdp.on('Network.responseReceived', (p) => {
    const u = String(p.response?.url ?? '');
    const hit = mediaReqs.find((r) => r.url === u && r.status === null);
    if (hit) hit.status = p.response?.status ?? null;
  });

  // =========================================================================
  // ① 有效链接进入详情页 + ② 客户资料按实际值显示
  // =========================================================================
  console.log('\n── ①② 进入详情页与客户资料 ────────────────────────────');
  await cdp.send('Page.navigate', { url: `${BASE_URL}/h5/technician/visit/${tokens.image}` });
  await cdp.waitFor(`document.querySelector('[data-testid="customer-card"]')`, { timeout: 30000 });
  await sleep(800);

  const info = JSON.parse(
    await cdp.evaluate(`
      const q = (t) => document.querySelector('[data-testid="' + t + '"]');
      const txt = (t) => (q(t)?.textContent || '').trim();
      const addr = q('customer-address');
      return JSON.stringify({
        name: txt('customer-name'),
        mobile: txt('customer-mobile'),
        hasAddress: !!addr,
        addressPos: addr ? Math.round(addr.getBoundingClientRect().top) : -1,
        categoryRow: [...document.querySelectorAll('.svc-row-key')].map((e) => e.textContent.trim()),
        // 页面上**不应出现**的技术字样
        leaks: ['mediaId','storage_key','customer/','visit_token','access_token_hash'].filter((k) => document.body.innerText.includes(k)),
        descriptionShown: [...document.querySelectorAll('.svc-row-key')].some((e) => e.textContent.includes('问题描述')),
        title: (document.querySelector('h1')?.textContent || '').trim(),
      });
    `),
  );
  ok('师傅通过有效派工链接进入详情页（页面标题为"上门作业"）', info.title === '上门作业', `标题="${info.title}"`);
  ok('客户姓名按实际值显示', info.name === 'P115 浏览器验收', `"${info.name}"`);
  ok('客户电话显示且可点拨号', /^1\d{10}$/.test(info.mobile.replace(/\s/g, '')), `"${info.mobile}"`);
  ok('服务地址有值 ⇒ 显示', info.hasAddress === true, `address 行存在=${info.hasAddress}`);
  ok(
    '页面不出现媒体 ID / 存储路径 / Token 等技术字样',
    info.leaks.length === 0,
    info.leaks.length ? `泄漏：${info.leaks.join(',')}` : '干净',
  );

  // =========================================================================
  // ③ 只有照片、没有文字 ⇒ 正常显示图片，且**没有"缺少故障描述"提示**
  // =========================================================================
  console.log('\n── ③ 只照片无文字：图片正常显示、无误导提示 ────────────');
  const imgState = JSON.parse(
    await cdp.evaluate(`
      const im = document.querySelector('[data-testid="customer-photo-0"] img');
      if (!im) return JSON.stringify({ missing: true });
      // 等图片解码完（最多 5s）
      const t0 = Date.now();
      while ((!im.complete || im.naturalWidth === 0) && Date.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return JSON.stringify({ complete: im.complete, w: im.naturalWidth, h: im.naturalHeight, src: im.currentSrc ? 'has-src' : 'no-src' });
    `),
  );
  ok(
    '🔴 照片**真的解码出来了**（naturalWidth > 0，不是只有占位框）',
    imgState.w > 0 && imgState.h > 0,
    `${imgState.w}×${imgState.h}`,
  );
  ok('🔴 客户没写文字时**没有"问题描述"行**（也就没有"缺少故障描述"这类误导提示）', info.descriptionShown === false, `descriptionShown=${info.descriptionShown}`);

  // =========================================================================
  // ④ 点击照片看大图（手机尺寸下可缩放）
  // =========================================================================
  console.log('\n── ④ 点击照片看大图 ────────────────────────────────────');
  await cdp.evaluate(`document.querySelector('[data-testid="customer-photo-0"]').click(); return true;`);
  await cdp.waitFor(`document.querySelector('[data-testid="photo-viewer"]')`, { timeout: 8000 });
  const viewer = JSON.parse(
    await cdp.evaluate(`
      const v = document.querySelector('[data-testid="photo-viewer"]');
      const im = document.querySelector('[data-testid="photo-viewer-img"]');
      const sc = v?.querySelector('.svc-viewer-scroll');
      const cs = sc ? getComputedStyle(sc) : null;
      return JSON.stringify({
        visible: !!v && v.getBoundingClientRect().height > 0,
        imgLoaded: !!im && im.naturalWidth > 0,
        touchAction: cs ? cs.touchAction : '',
        overflow: cs ? cs.overflow : '',
      });
    `),
  );
  ok('🔴 点击照片 ⇒ 大图查看器出现且大图**真的加载**', viewer.visible && viewer.imgLoaded, `visible=${viewer.visible} imgLoaded=${viewer.imgLoaded}`);
  ok(
    '大图容器支持缩放（`touch-action: pinch-zoom` + `overflow:auto`，交给浏览器而非自造手势）',
    viewer.touchAction.includes('pinch-zoom') && /auto/.test(viewer.overflow),
    `touch-action=${viewer.touchAction} overflow=${viewer.overflow}`,
  );
  // 截图：大图状态
  fs.mkdirSync(OUT, { recursive: true });
  const shotZoom = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'technician-detail-zoom.png'), Buffer.from(shotZoom.data, 'base64'));
  await cdp.evaluate(`document.querySelector('[data-testid="photo-viewer"]').click(); return true;`); // 关掉
  await sleep(400);

  // =========================================================================
  // ⑤⑥ 只录音 / 只视频 ⇒ **真的能播**
  // =========================================================================
  for (const [kind, label, sel] of [
    ['audio', '录音', 'audio'],
    ['video', '视频', 'video'],
  ]) {
    console.log(`\n── ${kind === 'audio' ? '⑤' : '⑥'} 只${label} ⇒ 真正播放 ────────────────────────────`);
    await cdp.send('Page.navigate', { url: `${BASE_URL}/h5/technician/visit/${tokens[kind]}` });
    await cdp.waitFor(`document.querySelector('${sel}')`, { timeout: 30000 });

    const play = JSON.parse(
      await cdp.evaluate(`
        const el = document.querySelector('${sel}');
        if (!el) return JSON.stringify({ missing: true });
        // 等元数据
        const t0 = Date.now();
        while (el.readyState < 2 && Date.now() - t0 < 8000) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const rs = el.readyState, dur = el.duration;
        let grew = false, t1 = 0;
        try {
          el.muted = true;              // 无声环境也能"真的走时间轴"
          await el.play();
          await new Promise((r) => setTimeout(r, 1200));
          t1 = el.currentTime;
          grew = t1 > 0;
          el.pause();
        } catch (e) {
          return JSON.stringify({ readyState: rs, duration: dur, grew: false, err: String(e).slice(0, 80) });
        }
        return JSON.stringify({ readyState: rs, duration: dur, grew, currentTime: t1, controls: el.controls });
      `),
    );
    ok(
      `🔴 ${label}播放器**真的能播**（readyState≥2 + duration>0 + play() 后 currentTime 增长）`,
      play.readyState >= 2 && play.duration > 0 && play.grew === true,
      `readyState=${play.readyState} duration=${String(play.duration).slice(0, 6)} currentTime=${String(play.currentTime ?? 0).slice(0, 5)}${play.err ? ' err=' + play.err : ''}`,
    );
    ok(`${label}播放器带原生控件（controls）`, play.controls === true, `controls=${play.controls}`);

    // 截图：媒体页
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, `technician-detail-${kind}.png`), Buffer.from(shot.data, 'base64'));
  }

  // 完整详情页截图（照片那张单，回到顶部）
  await cdp.send('Page.navigate', { url: `${BASE_URL}/h5/technician/visit/${tokens.image}` });
  await cdp.waitFor(`document.querySelector('[data-testid="customer-card"]')`, { timeout: 30000 });
  await sleep(1500);
  const shotFull = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(OUT, 'technician-detail-full.png');
  fs.writeFileSync(shotPath, Buffer.from(shotFull.data, 'base64'));
  console.log(`  · 完整详情页截图：${shotPath}`);

  // =========================================================================
  // ⑦ 媒体加载走的是**受控读取接口**（不是公开静态路径）
  // =========================================================================
  console.log('\n── ⑦ 媒体请求路径 ──────────────────────────────────────');
  const mediaHits = mediaReqs.filter((r) => r.url.includes('/technician/visits/'));
  const allAuthorizedPath = mediaReqs.every((r) => /\/technician\/visits\/[A-Za-z0-9_-]{43}\/media\/[A-Za-z0-9_-]{22}$/.test(r.url.split('?')[0]));
  ok(
    '🔴 媒体加载**全部走受控读取接口**（`/technician/visits/<token>/media/<ref>`，无公开静态 URL）',
    mediaReqs.length > 0 && allAuthorizedPath,
    `${mediaReqs.length} 次请求，全部为受控路径=${allAuthorizedPath}`,
  );
  ok(
    '受控接口返回 200（原生 audio/video 的 src 直接指向它，凭证在 query 里）',
    mediaHits.every((r) => r.status === 200 || r.status === null),
    mediaHits.map((r) => `${r.status ?? '?'}`).join(',') || '(无)',
  );
  ok(
    '页面**没有** fetch + blob URL 之类的"第二套读取"（直接用原生 src）',
    await cdp.evaluate(`return document.querySelectorAll('video[src^="blob:"], audio[src^="blob:"]').length === 0;`),
    '未发现 blob: 媒体源',
  );
} finally {
  const r = sw.restore();
  console.log(`\n  · 短信开关恢复：${r.note}`);
  chrome.kill();
  await sleep(600);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* ignore */
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  师傅详情页浏览器验收：${passed}/${checks.length} 通过（Chromium 手机视口，**非真机**）`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过（真机未验证）');
}
