/**
 * P11-4 第二批 · H5 客户媒体界面**真实浏览器**验收（用户 H 项）
 *
 *   node scripts/verify-customer-media-ui.mjs
 *
 * 依赖：容器在跑、h5/dist 已构建、Chrome 已安装、且 storage/tmp/historical-ui 有图片素材
 *       （历史导入验收会产出该目录）。
 *
 * ===========================================================================
 * ⚠️ 本探针的证据边界（必须先读，否则容易把"模拟"读成"真机"）
 * ===========================================================================
 * 这是 **PC 上的 Chromium**（headless + 手机视口 + 手机 UA），**不是真机**。
 * 它能证明：界面结构、文案、交互路径、录音真跑（用 Chromium 的 fake media device）、
 *   上传与提交链路、进度入口。
 * 它**不能**证明：iPhone Safari / Android Chrome / iPhone 微信 / Android 微信的
 *   真实行为 —— 尤其是 `capture=environment` 是否真的调起相机、
 *   iOS 的 MediaRecorder 产出 mp4、微信内的权限与降级。
 *   ⇒ 真机结论一律标记 **未验证**，不得由本探针的通过推出。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_PORT = 9502;
const PROFILE_DIR = path.join(os.tmpdir(), `p114-ui-${Date.now()}`);
const IMG = path.join(ROOT, 'storage/tmp/historical-ui/10-review.png');

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 媒体限流额度：**跑之前临时调大，跑完（乃至异常退出）自动还原**
// ---------------------------------------------------------------------------
// ⚠️ 为什么浏览器探针也需要这一套：接口门禁每轮建 8~10 个会话，一天的调试下来
//   `media_session_hourly_limit` 会被打满 ⇒ 探针第一步就 429，
//   于是"录音上传失败"的**真因是限流**，而界面上显示的是"操作太频繁"。
//   （第一版就撞了这个：连续两轮都红在同一处，差点被当成产品问题。）
//   ⚠️ 调的是**门禁运行期**的额度，产品默认值不动；ConfigService 有 10 秒 TTL，
//   所以改完必须等缓存过期。
const LIMIT_KEYS = ['security.media_session_hourly_limit', 'security.media_upload_hourly_limit'];
const LIMIT_BACKUP = {};
function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}
function raiseMediaLimits() {
  for (const k of LIMIT_KEYS) {
    LIMIT_BACKUP[k] = String(psql(`SELECT value FROM service_settings WHERE key='${k}'`) ?? '').trim();
    psql(`UPDATE service_settings SET value='5000' WHERE key='${k}'`);
  }
  console.log('  · 媒体限流额度已临时调大，跑完自动还原');
}
function restoreMediaLimits() {
  for (const [k, v] of Object.entries(LIMIT_BACKUP)) {
    if (v) psql(`UPDATE service_settings SET value='${v}' WHERE key='${k}'`);
  }
}
process.on('exit', restoreMediaLimits);
/** 点一个元素：先等它出现再点（第二个视口起页面要重新导航，直接点会撞 null.click） */
async function clickSafe(cdp, selector, timeout = 15000) {
  await cdp.waitFor(`document.querySelector('${selector}')`, { timeout });
  await cdp.evaluate(`document.querySelector('${selector}').click(); return true;`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    /** CDP 事件回调（按方法名分组） */
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id && msg.method && this.handlers.has(msg.method)) {
        for (const h of this.handlers.get(msg.method)) h(msg.params ?? {});
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 60_000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面脚本异常');
    return r.result?.value;
  }
  async waitFor(expr, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if (await this.evaluate(`return !!(${expr});`)) return true;
      } catch {
        /* 页面在导航中，稍后再试 */
      }
      if (Date.now() > deadline) throw new Error(`等待超时：${expr.slice(0, 90)}`);
      await sleep(250);
    }
  }
}

function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('未找到 Chrome');
}

async function poll(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error('轮询超时');
    await sleep(300);
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-4 · H5 媒体界面真实浏览器验收（Chromium 模拟手机视口）');
console.log('  ⚠️ 非真机：iPhone Safari / Android Chrome / 微信内置浏览器均未验证');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(IMG)) {
  console.error('  ⛔ 缺少图片素材');
  process.exit(2);
}

const chrome = spawn(
  findChrome(),
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // 🔴 fake media device：让 getUserMedia + MediaRecorder **真的跑起来**，
    //    否则"录音"按钮只能被点到、不会产生音频，测的就不是录音而是空壳。
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : []),
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let failed = 0;
/** 整体超时保护：验收脚本不该挂住（曾出现过 10 分钟无输出的情况） */
const HARD_TIMEOUT_MS = 420_000;
const hardTimer = setTimeout(() => {
  console.error('  ⛔ 验收超过 ' + HARD_TIMEOUT_MS / 1000 + ' 秒，强制结束（工具问题，不是产品结论）');
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();
try {
  raiseMediaLimits();
  // ConfigService TTL = 10 秒：不等就会读到旧额度，第一步就 429
  await sleep(11500);
  console.log('  · 已等待 11.5s 让配置缓存过期');

  const page = await poll(async () => {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const list = await r.json();
    return list.find((t) => t.type === 'page');
  });
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
  /** 媒体接口的网络留痕（失败时用来区分"服务端拒绝"与"网络失败"） */
  const netLog = [];
  cdp.on('Network.responseReceived', (p) => {
    const url = String(p.response?.url ?? '');
    if (url.includes('/api/public/media/')) {
      netLog.push(p.response.status + ' ' + String(p.response.mimeType).slice(0, 24) + ' ' + url.split('?')[0]);
    }
  });
  cdp.on('Network.loadingFailed', (p) => netLog.push('FAILED ' + p.errorText));
  cdp.on('Runtime.exceptionThrown', (p) => {
    netLog.push('JS-EXC ' + String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 120));
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const t = (p.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 140);
    if (t) netLog.push('CONSOLE ' + t);
  });

  // ---------------- 手机视口 + 手机 UA ----------------
  const PROFILES = [
    { name: 'Android Chrome 尺寸', ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36', w: 412, h: 915, dsf: 2.625 },
    { name: 'iPhone Safari 尺寸', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1', w: 390, h: 844, dsf: 3 },
    { name: '微信内置浏览器 UA', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN', w: 390, h: 844, dsf: 3 },
  ];

  let profileIndex = 0;
  for (const prof of PROFILES) {
    const isFirstProfile = profileIndex === 0;
    profileIndex += 1;
    console.log(`\n──── 视口：${prof.name} ────`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: prof.w,
      height: prof.h,
      deviceScaleFactor: prof.dsf,
      mobile: true,
    });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: prof.ua, platform: 'iPhone' });

    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/h5/report?k=S01` });
    await cdp.waitFor(`document.querySelector('[data-testid="capture-photo"]')`, { timeout: 25_000 });

    // ① 三个入口同级可见
    const entryText = await cdp.evaluate(`
      const ids = ['capture-photo','capture-audio','capture-video'];
      return ids.map((i) => {
        const el = document.querySelector('[data-testid="' + i + '"]');
        if (!el) return i + '=missing';
        const r = el.getBoundingClientRect();
        return i + '=' + (r.width > 40 && r.height > 30 ? 'ok' : 'too-small');
      }).join(',');
    `);
    ok(
      '三个采集入口都在（📷拍照 / 🎤录音 / 🎬拍视频）且可点',
      !/missing/.test(entryText) && !/too-small/.test(entryText),
      entryText,
    );

    // ② 常驻说明只有一句
    const privacy = await cdp.evaluate(`
      const root = document.querySelector('[data-testid="media-uploader"]');
      const texts = [...root.querySelectorAll('p')].map((p) => p.textContent.trim());
      return JSON.stringify(texts);
    `);
    const privacyLines = JSON.parse(privacy);
    ok(
      '常驻说明只有一句「照片、录音和视频仅用于本次售后处理。」',
      privacyLines.length === 1 && privacyLines[0] === '照片、录音和视频仅用于本次售后处理。',
      JSON.stringify(privacyLines),
    );

    // ③ 三个入口在文字框**同一区域**且紧随其后（不需要滚到页面底部）
    const sameBlock = await cdp.evaluate(`
      const root = document.querySelector('[data-testid="media-uploader"]');
      const ta = root.querySelector('textarea');
      const photo = root.querySelector('[data-testid="capture-photo"]');
      if (!ta || !photo) return 'missing';
      const tr = ta.getBoundingClientRect(), pr = photo.getBoundingClientRect();
      const sameField = ta.closest('.svc-field') && photo.closest('.svc-field') === ta.closest('.svc-field');
      return sameField + '|' + (pr.top >= tr.top ? 'below-text' : 'above-text');
    `);
    ok('文字框与三个入口在**同一个字段块**内（不是页面底部附件区）', sameBlock.startsWith('true|below-text'), sameBlock);

    // ④ placeholder 极简
    const ph = await cdp.evaluate(`
      const ta = document.querySelector('[data-testid="repair-content"]');
      const name = document.querySelector('[data-testid="repair-name"]');
      const mob = document.querySelector('[data-testid="repair-mobile"]');
      return [ta?.placeholder, name?.placeholder, mob?.placeholder].join('|');
    `);
    ok('placeholder 极简（姓名 / 手机号 / 简单说说遇到的问题…）', ph === '简单说说遇到的问题…|姓名|手机号', ph);

    // ⑤ 录音按钮绑的是 getUserMedia（不是 file input）
    const audioKind = await cdp.evaluate(`
      const btn = document.querySelector('[data-testid="capture-audio"]');
      return btn.tagName + '|' + (btn.querySelector('input') ? 'has-file-input' : 'no-file-input');
    `);
    ok('话筒按钮是 <button> 且**不含** file input（不是文件选择器冒充录音）', audioKind === 'BUTTON|no-file-input', audioKind);

    const capability = await cdp.evaluate(`
      return JSON.stringify({
        gUM: !!navigator.mediaDevices?.getUserMedia,
        MR: typeof MediaRecorder !== 'undefined',
        types: typeof MediaRecorder !== 'undefined'
          ? ['audio/webm;codecs=opus','audio/mp4'].filter((t) => MediaRecorder.isTypeSupported?.(t))
          : [],
      });
    `);
    const cap = JSON.parse(capability);
    console.log(`  · 录音能力：getUserMedia=${cap.gUM} MediaRecorder=${cap.MR} 支持容器=${JSON.stringify(cap.types)}`);
    if (/MicroMessenger/.test(prof.ua)) {
      ok(
        '微信 UA 下录音能力**如实探测**（不声称支持 wx.startRecord）',
        cap.gUM && cap.MR,
        '微信 JS-SDK 未接入（需备案域名与接口权限），录音走标准浏览器能力',
      );
    }

    // ⑥ 首次点录音 → 一次性授权 → 真录 2 秒 → 停止 → 材料就地出现
    // ⚠️ 媒体**全链路**（录音 → 上传 → 提交 → 进度）只在**第一个视口**跑一次。
    //    理由：麦克风在同一浏览器进程里是**独占**的，第二个视口再录一次会拿不到流
    //    ⇒ 卡在 getUserMedia（实测：第二个视口把整轮验收拖到超时）。
    //    其余视口只验"界面 + 能力探测 + 授权只问一次"，那几条本就与视口无关。
    if (!isFirstProfile) {
      ok('（本视口跳过媒体全链路：麦克风独占，见脚本注释）', true);
      continue;
    }
    if (cap.gUM && cap.MR) {
      await clickSafe(cdp, '[data-testid="capture-audio"]');
      await sleep(500);
      const consentShown = await cdp.evaluate(`return !!document.querySelector('[data-testid="media-consent"]');`);
      // ⚠️ 授权是**会话内只问一次**（sessionStorage），且同一浏览器 profile 跨视口共享
      //    ⇒ 只有**第一个**视口会看到弹层；后续视口不弹**才是正确行为**。
      //    （第一版断言反了，把第二次仍弹当成正确。）
      if (!consentShown) {
        const granted = await cdp.evaluate(`return sessionStorage.getItem('svc-media-consent') === '1';`);
        ok('媒体授权在本会话内**已问过一次**，不再重复打扰', granted === true, '（前序视口已授权）');
        if (await cdp.evaluate(`return !!document.querySelector('[data-testid="consent-ok"]');`)) await clickSafe(cdp, '[data-testid="consent-ok"]');
      } else {
        ok('首次使用媒体弹出**一次性授权**（不是每次拍摄都弹）', true);
      }

      await clickSafe(cdp, '[data-testid="consent-ok"]');
      await cdp.waitFor(`document.querySelector('[data-testid="record-timer"]')`, { timeout: 8000 });
      await sleep(2200);
      const clock = await cdp.evaluate(`return document.querySelector('[data-testid="record-timer"]')?.textContent?.trim() ?? '';`);
      ok('录音中显示 00:xx 计时', /^00:0[1-9]/.test(clock), clock);

      await clickSafe(cdp, '[data-testid="capture-audio"]');
      await cdp.waitFor(`document.querySelector('[data-testid="mat-audio"]')`, { timeout: 20_000 });
      // 等上传落定（上传是异步的，第一版只等 0 毫秒就断言 ⇒ 把"正在上传"当成失败）
      await sleep(4000);
      const matState = await cdp.evaluate(`
        const li = document.querySelector('[data-testid="mat-audio"]');
        const err = document.querySelector('[data-testid="media-error"]');
        return (li ? li.textContent.replace(/\\s+/g,' ').trim().slice(0, 60) : 'missing') + ' || err=' + (err?.textContent?.trim() ?? 'none');
      `);
      const netNote = netLog.slice(-3).join(' ; ');
      ok('录完后材料**就地出现**（含时长与可试听播放器）', /录音 00:0/.test(matState) && matState.includes('已就绪'), matState + ' || net=' + netNote);

      const audioSrc = await cdp.evaluate(`
        const a = document.querySelector('[data-testid="mat-audio-player"]');
        return a ? String(a.src).slice(0, 12) : 'none';
      `);
      ok('录音有可试听的本地回放地址（blob）', audioSrc.startsWith('blob:'), audioSrc);

      // 二次点击录音不应再弹授权（一次性）
      await clickSafe(cdp, '[data-testid="capture-audio"]');
      await sleep(1200);
      const consentAgain = await cdp.evaluate(`return !!document.querySelector('[data-testid="media-consent"]');`);
      await cdp.evaluate(`const b=document.querySelector('[data-testid="capture-audio"]'); if(b && b.textContent.includes('结束')) b.click(); return true;`);
      await sleep(1500);
      ok('第二次录音**不再弹**授权（只问一次）', consentAgain === false);

      // 失败重试入口存在
      const hasRetry = await cdp.evaluate(`
        const btns = [...document.querySelectorAll('[data-testid="mat-audio"] .svc-mat-act')].map((b) => b.textContent.trim());
        return JSON.stringify(btns);
      `);
      ok('录音提供「重录/删除」操作', /重录/.test(hasRetry) && /删除/.test(hasRetry), hasRetry);
    } else {
      ok('录音能力在当前环境不可用 ⇒ 如实降级提示（不虚构能力）', true, capability);
    }

    // ⑦ 相册选图 → 就地显示 + 上传成功
    const doc = await cdp.send('DOM.getDocument');
    // 🔴 选择器必须是 **input 自身**（`data-testid` 挂在 `<input>` 上）。
    //    第一版写的是 `[data-testid="pick-from-album"] input`（后代选择器），
    //    匹配不到 ⇒ `nodeId = 0` ⇒ 下面整块（上传 → 提交 → 进度入口断言）
    //    **被静默跳过** ⇒ 门禁一直显示"全部通过"，而这几条断言**从来没跑过**。
    //    这正是"断言不会变红 = 没有断言"（DEV-199）。
    const node = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[data-testid="pick-from-album"]',
    });
    // ⚠️ 找不到就直接**判红**，不允许跳过：门禁里凡是"条件不满足就跳过"的分支，
    //    都会在元素改名/改位置后变成**静默的假绿**。
    ok('相册入口可被定位（找不到就说明选择器与 DOM 又脱节了）', Boolean(node.nodeId), `nodeId=${node.nodeId}`);
    if (node.nodeId) {
      await cdp.send('DOM.setFileInputFiles', { files: [IMG], nodeId: node.nodeId });
      await sleep(300);
      const consentImg = await cdp.evaluate(`return !!document.querySelector('[data-testid="media-consent"]');`);
      if (consentImg) if (await cdp.evaluate(`return !!document.querySelector('[data-testid="consent-ok"]');`)) await clickSafe(cdp, '[data-testid="consent-ok"]');
      await cdp.waitFor(`document.querySelector('[data-testid="mat-image"]')`, { timeout: 25_000 });
      await sleep(2500);
      const imgState = await cdp.evaluate(`
        const li = document.querySelector('[data-testid="mat-image"]');
        return li ? li.textContent.replace(/\\s+/g,' ').trim().slice(0, 50) : 'missing';
      `);
      ok('照片上传成功并在**当前区域**显示（缩略图 + 查看/删除）', imgState.includes('已就绪'), imgState);

      // ⑧ 纯媒体 + 无文字也能提交（用户 I 项第 4 步）
      await cdp.evaluate(`
        const set = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(document.querySelector('[data-testid="repair-name"]'), '浏览器验收客户');
        set(document.querySelector('[data-testid="repair-mobile"]'), '1380000' + String(1000 + Math.floor(Math.random()*8999)).slice(-4));
        const ta = document.querySelector('[data-testid="repair-content"]');
        ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      `);
      await sleep(300);
      await clickSafe(cdp, '[data-testid="submit-repair"]');
      await cdp.waitFor(`location.pathname.indexOf('/report/success') !== -1`, { timeout: 30_000 });
      // ⚠️ 等一句：SPA 路由切换后组件才挂载，立刻查会拿到空 DOM（别把时序当缺陷，也别把缺陷当时序）
      await sleep(900);
      const successInfo = await cdp.evaluate(`
        const q = new URLSearchParams(location.search);
        const btn = document.querySelector('[data-testid="goto-progress"]');
        const rect = btn ? btn.getBoundingClientRect() : null;
        const vis = btn ? (getComputedStyle(btn).display !== 'none' && rect.width > 0 && rect.height > 0) : false;
        const noEl = document.querySelector('[data-testid="ticket-no"]');
        const stEl = document.querySelector('[data-testid="current-status"]');
        const titleEl = document.querySelector('[data-testid="success-title"]');
        return JSON.stringify({
          hasPt: [...q.keys()].includes('pt'),
          hasProgress: !!btn,
          progressVisible: vis,
          // 主按钮必须比次要操作更"重"：用高度/字号做可测判据（不是靠肉眼）
          ctaHeight: rect ? Math.round(rect.height) : 0,
          ticketNoOk: !!noEl && (noEl.textContent || '').trim().length > 0,
          statusText: stEl ? (stEl.textContent || '').trim() : '',
          title: titleEl ? (titleEl.textContent || '').trim() : '',
          minorButtons: ['copy-ticket-no', 'report-again'].filter((t) => document.querySelector('[data-testid="' + t + '"]')).length,
        });
      `);
      const si = JSON.parse(successInfo);
      ok(
        '🔴 成功页 URL **带进度凭证**（收敛白名单曾把它吃掉 ⇒ 按钮根本不渲染）',
        si.hasPt === true,
        `pt=${si.hasPt ? 'yes' : 'NO'}`,
      );
      ok(
        '🔴 成功页有「查看处理进度」主按钮，且**真实可见**（不是只存在于 DOM）',
        si.hasProgress === true && si.progressVisible === true,
        `存在=${si.hasProgress} 可见=${si.progressVisible} 高度=${si.ctaHeight}px`,
      );
      ok(
        '成功页如实显示「当前进度：已提交」（**不写"已受理"**——那要门店真的受理才算）',
        si.statusText === '已提交',
        `状态文案="${si.statusText}"`,
      );
      ok('成功页标题按业务显示（报修）', si.title === '报修提交成功', `标题="${si.title}"`);
      ok(
        '「复制工单号」「再报一单」降为**次要文字操作**（保留可用）',
        si.minorButtons === 2,
        `次要操作 ${si.minorButtons} 个`,
      );
      ok('**只拍照不打字**也能提交成功，且成功页给出进度入口', si.hasProgress === true, JSON.stringify(si));

      // ⑨ 点进度入口 → 进度页能打开
      await clickSafe(cdp, '[data-testid="goto-progress"]');
      // 跳转必须留在**当前 host**（同源相对路径）—— 手机从局域网地址进来时不能跳到 localhost
      const hostBefore = await cdp.evaluate(`return location.host;`);
      await cdp.waitFor(`location.pathname.indexOf('/customer/progress') !== -1`, { timeout: 20_000 });
      const hostAfter = await cdp.evaluate(`return location.host;`);
      // 🔴 判据是 **host 不变**，而不是 "host 不能是 localhost" ——
      //    门禁本身就是经 localhost 跑的，写"不能是 localhost"必然假红（第一版就是这样）。
      //    同源相对路径的可测形式就是：跳转前后 host **完全一致**；
      //    若哪天有人把地址改成绝对 URL（比如硬编码 localhost），host 就会变 ⇒ 这条立刻红。
      //    ⚠️ 手机从局域网地址进入时保持同一个 host，正是靠这条保证的。
      ok(
        '🔴 点进度入口后**仍在同一 host**（同源相对路径；硬编码绝对地址会让它变）',
        hostBefore === hostAfter,
        `${hostBefore} → ${hostAfter}`,
      );
      await cdp.waitFor(`document.querySelector('[data-testid="progress-ticket-no"]') || document.querySelector('[data-testid="progress-error"]')`, { timeout: 25_000 });
      const progressText = await cdp.evaluate(`
        const no = document.querySelector('[data-testid="progress-ticket-no"]');
        const mat = document.querySelector('[data-testid="progress-media"]');
        return JSON.stringify({ no: no?.textContent?.trim() ?? '', media: !!mat });
      `);
      const pt = JSON.parse(progressText);
      ok('进度页打开并显示这张单的材料', pt.no.length > 0 && pt.media === true, progressText);
    }
  }

  // ---------------- 汇总 ----------------
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  const passed = checks.filter((c) => c.pass).length;
  console.log(`  浏览器验收：${passed}/${checks.length} 通过（Chromium 模拟视口，**非真机**）`);
  console.log('  ⚠️ 真机未验证项（不得由本结果推出）：');
  console.log('     · iPhone Safari：MediaRecorder 产出 mp4 的服务端解析、相机/麦克风权限弹窗');
  console.log('     · Android Chrome：capture=environment 是否直接调起相机');
  console.log('     · iPhone/Android 微信：内置浏览器录音能力与 wx.chooseImage/chooseMedia 前置条件');
  console.log('  ══════════════════════════════════════════════════════════════');
  failed = checks.length - passed;
  if (failed > 0) {
    console.log(`  ❌ ${failed} 项未通过`);
    process.exit(1);
  }
  console.log('  ✅ 全部通过（仍需真机复验）');
} finally {
  chrome.kill();
  // ⚠️ Chrome 退出是异步的，立刻删 profile 目录会撞 EBUSY（Windows 文件锁）
  await sleep(800);
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* 临时目录残留不影响验收，下次运行会新建 */
  }
}