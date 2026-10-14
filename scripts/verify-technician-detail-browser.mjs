/**
 * P11-5 · 师傅 H5 **真实浏览器**验收（Chromium 手机视口，**非真机**）
 *
 *   node scripts/verify-technician-detail-browser.mjs
 *
 * 做法（按用户要求收敛）：
 *   · **只建 1 张单、带 3 种媒体**（客户照片 + 录音 + 视频），文字一律为空；
 *   · 开页面前**等一个完整限流窗口**，然后以**一次正常访问**打开详情页（不反复导航）；
 *   · 记录页面自己发出的请求：**数量、状态码、是否重复、是否 429、是否带 Range**。
 *
 * 判据（不是"控件看起来在"）：
 *   · 照片：`naturalWidth > 0`（真的解码）+ 点击后大图查看器出现且大图加载；
 *   · 音频/视频：`readyState ≥ 2` + `duration > 0` + **`play()` 后 `currentTime` 真的增长**；
 *   · 媒体请求**全部走受控读取接口**（`/technician/visits/<token>/media/<ref>`），无公开静态路径；
 *   · 页面**不存在** `blob:` 媒体源（即没有"第二套读取"）。
 *
 * ⚠️ Chromium 手机视口通过 **只能称"浏览器验收通过"**；无真实设备不提真机结论。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/** 受控节奏：`svc_public` 是 30r/m ⇒ 2.5s/请求，遇 429 等一个完整窗口 */
const PACE_MS = 2500;
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

/** 一张单、三种媒体（同一 media session 上传三个文件） */
async function buildTicketWithThreeMedia() {
  const s = await paced(() =>
    http(`${BASE_URL}/api/public/media/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_consent: true }),
    }),
  );
  const sess = s.json?.data;
  if (!sess) throw new Error(`建媒体会话失败 HTTP ${s.status}`);
  for (const [buf, name] of [
    [IMG, 'c.png'],
    [AUDIO, 'c.webm'],
    [VIDEO, 'c.webm'],
  ]) {
    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    const up = await paced(() =>
      http(`${BASE_URL}/api/public/media/upload`, {
        method: 'POST',
        headers: { 'X-Media-Session': sess.session_token },
        body: form,
      }),
    );
    if (up.status !== 200) throw new Error(`上传 ${name} 失败 HTTP ${up.status}`);
  }
  const created = await paced(() =>
    http(`${BASE_URL}/api/public/tickets?k=${ENTRY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
      body: JSON.stringify({
        ticket_type: 'repair',
        content: '',
        customer_name: 'P115 浏览器验收',
        customer_mobile: `13${String(Date.now()).slice(-9)}`,
        service_address: '新都区 P115 路 9 号 3 单元 501',
        appliance_category: 'air_conditioner',
        brand_model: '格力 KFR-35GW',
        media_session: { id: sess.session_id, token: sess.session_token },
      }),
    }),
  );
  const no = created.json?.data?.ticket_no;
  if (!no) throw new Error(`建单失败：HTTP ${created.status} ${JSON.stringify(created.json?.errors?.[0] ?? '')}`);
  return { no, id: Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${no}'`)) };
}

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

const PORT = 9631;
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
console.log('  ⚠️ 页面路径带 `/h5` base 前缀；1 张单 + 3 种媒体；开页前等限流窗口');
console.log('══════════════════════════════════════════════════════════════');

const sw = smsSwitch();
try {
  await sw.enable();
  const { store, hq } = await twoSessions();

  const t = await buildTicketWithThreeMedia();
  console.log(`  · 合成单 ${t.no}（客户上传：照片 + 录音 + 视频；文字为空）`);
  await acceptAndDispatch(t.id, store);
  const { token } = await tokenFromOutbox({ sessionToken: hq, ticketNo: t.no });
  console.log('  · 已派工并取得师傅链接');

  let page;
  for (let i = 0; i < 60; i += 1) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
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

  /** 页面自己发出的 /api/ 请求 */
  const pageReqs = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = String(p.request?.url ?? '');
    if (!u.includes('/api/')) return;
    pageReqs.push({
      url: u,
      method: String(p.request?.method ?? ''),
      range: p.request?.headers?.Range ?? p.request?.headers?.range ?? null,
      status: null,
    });
  });
  cdp.on('Network.responseReceived', (p) => {
    const u = String(p.response?.url ?? '');
    const hit = [...pageReqs].reverse().find((r) => r.url === u && r.status === null);
    if (hit) {
      hit.status = p.response?.status ?? null;
      hit.acceptRanges = p.response?.headers?.['Accept-Ranges'] ?? p.response?.headers?.['accept-ranges'] ?? null;
      hit.contentRange = p.response?.headers?.['Content-Range'] ?? p.response?.headers?.['content-range'] ?? null;
    }
  });

  // ---- 等窗口，然后**只打开一次** ----
  console.log('  · 等 65s 让限流窗口完全恢复，再以一次正常访问打开页面…');
  await sleep(65_000);

  await cdp.send('Page.navigate', { url: `${BASE_URL}/h5/technician/visit/${token}` });
  await cdp.waitFor(`document.querySelector('[data-testid="customer-card"]')`, { timeout: 45000 });
  await sleep(2500);

  // =========================================================================
  // ①② 详情页 + 客户资料
  // =========================================================================
  console.log('\n── ①② 详情页与客户资料 ───────────────────────────────');
  const info = JSON.parse(
    await cdp.evaluate(`
      const q = (t) => document.querySelector('[data-testid="' + t + '"]');
      const txt = (t) => (q(t)?.textContent || '').trim();
      const keys = [...document.querySelectorAll('.svc-row-key')].map((e) => e.textContent.trim());
      return JSON.stringify({
        title: (document.querySelector('h1')?.textContent || '').trim(),
        name: txt('customer-name'),
        mobile: txt('customer-mobile'),
        hasAddress: !!q('customer-address'),
        keys,
        leaks: ['mediaId','storage_key','customer/','access_token_hash'].filter((k) => document.body.innerText.includes(k)),
        descRow: keys.some((k) => k.includes('问题描述')),
      });
    `),
  );
  ok('师傅通过有效派工链接进入详情页', info.title === '上门作业', `标题="${info.title}"`);
  ok('客户姓名 / 电话按实际值显示', info.name === 'P115 浏览器验收' && /^1\d{10}$/.test(info.mobile), `${info.name} / ${info.mobile}`);
  ok('服务地址有值 ⇒ 显示', info.hasAddress === true);
  ok('页面不出现 mediaId / 存储路径 / Token', info.leaks.length === 0, info.leaks.join(',') || '干净');
  ok('🔴 客户没写文字 ⇒ 没有"问题描述"行（无效导提示）', info.descRow === false, `keys=${info.keys.join('/')}`);

  // =========================================================================
  // ③④ 照片：真实加载 + 点击大图
  // =========================================================================
  console.log('\n── ③④ 照片加载与大图 ───────────────────────────────────');
  const imgState = JSON.parse(
    await cdp.evaluate(`
      const im = document.querySelector('[data-testid="customer-photo-0"] img');
      if (!im) return JSON.stringify({ missing: true });
      const t0 = Date.now();
      while ((!im.complete || im.naturalWidth === 0) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
      return JSON.stringify({ complete: im.complete, w: im.naturalWidth, h: im.naturalHeight });
    `),
  );
  ok('🔴 客户照片**真的解码出来了**', imgState.w > 0, `${imgState.w}×${imgState.h}`);

  await cdp.evaluate(`document.querySelector('[data-testid="customer-photo-0"]').click(); return true;`);
  await cdp.waitFor(`document.querySelector('[data-testid="photo-viewer"]')`, { timeout: 8000 });
  const viewer = JSON.parse(
    await cdp.evaluate(`
      const v = document.querySelector('[data-testid="photo-viewer"]');
      const im = document.querySelector('[data-testid="photo-viewer-img"]');
      const sc = v?.querySelector('.svc-viewer-scroll');
      return JSON.stringify({
        visible: !!v && v.getBoundingClientRect().height > 0,
        imgLoaded: !!im && im.naturalWidth > 0,
        touchAction: sc ? getComputedStyle(sc).touchAction : '',
        overflow: sc ? getComputedStyle(sc).overflow : '',
      });
    `),
  );
  ok('🔴 点击照片 ⇒ 大图查看器出现且大图**真的加载**', viewer.visible && viewer.imgLoaded, `visible=${viewer.visible} imgLoaded=${viewer.imgLoaded}`);
  ok('大图支持缩放（pinch-zoom + overflow:auto，交给浏览器）', viewer.touchAction.includes('pinch-zoom') && /auto/.test(viewer.overflow), `touch-action=${viewer.touchAction}`);
  fs.mkdirSync(OUT, { recursive: true });
  const shotZoom = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'technician-detail-zoom.png'), Buffer.from(shotZoom.data, 'base64'));
  await cdp.evaluate(`document.querySelector('[data-testid="photo-viewer"]').click(); return true;`);
  await sleep(500);

  // =========================================================================
  // ⑤⑥ 同页：录音 / 视频**真的能播**
  // =========================================================================
  console.log('\n── ⑤⑥ 录音与视频真实播放（同一页面）────────────────────');
  for (const [sel, label] of [
    ['audio', '录音'],
    ['video', '视频'],
  ]) {
    const play = JSON.parse(
      await cdp.evaluate(`
        const el = document.querySelector('${sel}');
        if (!el) return JSON.stringify({ missing: true });
        const t0 = Date.now();
        while (el.readyState < 2 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
        const rs = el.readyState, dur = el.duration;
        let grew = false, t1 = 0, err = '';
        try {
          el.muted = true;
          await el.play();
          await new Promise((r) => setTimeout(r, 1500));
          t1 = el.currentTime;
          grew = t1 > 0;
          el.pause();
        } catch (e) { err = String(e).slice(0, 90); }
        return JSON.stringify({ readyState: rs, duration: dur, grew, currentTime: t1, controls: el.controls, src: (el.currentSrc || '').split('?')[0] });
      `),
    );
    ok(
      `🔴 ${label}**真的能播**（readyState≥2 + duration>0 + play() 后 currentTime 增长）`,
      play.readyState >= 2 && play.duration > 0 && play.grew === true,
      `readyState=${play.readyState} duration=${String(play.duration).slice(0, 6)} currentTime=${String(play.currentTime ?? 0).slice(0, 5)}${play.err ? ' err=' + play.err : ''}`,
    );
    ok(
      `${label}带原生控件且源是**受控接口**`,
      play.controls === true && /\/technician\/visits\//.test(String(play.src)),
      `src=${String(play.src).replace(/[A-Za-z0-9_-]{43}/, '<token>').replace(/[A-Za-z0-9_-]{22}/, '<ref>')}`,
    );
  }

  // =========================================================================
  // ⑦ 网络：数量 / 状态 / 重复 / Range / 受控路径
  // =========================================================================
  console.log('\n── ⑦ 页面请求与 Range ──────────────────────────────────');
  const apiReqs = pageReqs.filter((r) => r.url.includes('/api/'));
  const mediaReqs = apiReqs.filter((r) => r.url.includes('/media/'));
  const dupMap = new Map();
  for (const r of apiReqs) dupMap.set(r.url, (dupMap.get(r.url) ?? 0) + 1);
  const dups = [...dupMap.entries()].filter(([, n]) => n > 1);
  const statusDist = [...new Set(apiReqs.map((r) => r.status))].map(
    (s) => `${s}×${apiReqs.filter((r) => r.status === s).length}`,
  );
  console.log(`  · 页面共发出 ${apiReqs.length} 个 /api/ 请求；其中媒体 ${mediaReqs.length} 个`);
  console.log(`  · 状态分布：${statusDist.join(' · ')}`);
  console.log(
    `  · 重复请求：${dups.length ? dups.map(([u, n]) => `${u.replace(/[A-Za-z0-9_-]{43}/, '<t>').replace(/[A-Za-z0-9_-]{22}/, '<r>')}×${n}`).join(' · ') : '无'}`,
  );
  const ranged = mediaReqs.filter((r) => r.range);
  const acceptRanges = mediaReqs.find((r) => r.acceptRanges)?.acceptRanges ?? '(该响应头未出现)';
  console.log(`  · 带 Range 的媒体请求：${ranged.length ? ranged.map((r) => r.range).join(' | ') : '无'}`);
  console.log(`  · 媒体响应 Accept-Ranges：${acceptRanges}`);

  ok('🔴 页面**没有任何 429**（正常使用一次不会撞限流）', apiReqs.every((r) => r.status !== 429), apiReqs.filter((r) => r.status === 429).length ? '出现 429 ⇒ 需定位' : '无 429');
  ok('页面请求数量合理（远低于 30r/m 窗口额度）', apiReqs.length <= 20, `${apiReqs.length} 个`);
  ok(
    '🔴 媒体请求**全部**走受控读取接口（无公开静态路径）',
    mediaReqs.length >= 3 && mediaReqs.every((r) => /\/api\/technician\/visits\/[A-Za-z0-9_-]{43}\/media\/[A-Za-z0-9_-]{22}$/.test(r.url.split('?')[0])),
    `${mediaReqs.length} 个媒体请求`,
  );
  ok('页面**没有** `blob:` 媒体源（未自造第二套读取）', await cdp.evaluate(`return document.querySelectorAll('video[src^="blob:"], audio[src^="blob:"], video[src^="blob:"]').length === 0;`), '未发现 blob: 源');
  ok('Range 支持情况已记录', true, `Accept-Ranges=${acceptRanges}；客户端 Range 请求=${ranged.length}`);

  const shotFull = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(OUT, 'technician-detail-full.png');
  fs.writeFileSync(shotPath, Buffer.from(shotFull.data, 'base64'));
  console.log(`\n  · 完整详情页截图：${shotPath}`);
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
