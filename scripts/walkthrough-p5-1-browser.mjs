#!/usr/bin/env node
/**
 * walkthrough-p5-1-browser.mjs —— **真实浏览器**闭环走查（P5-1 证据④）
 * =============================================================================
 *
 * 它真的启动一个 Chromium、真的走一遍网络，把师傅在手机上会经历的事做完：
 *
 *   短信短链 /t/{token}  → 302 → 师傅 H5 → 读最小上下文 → 传照片
 *   → 填回执（结果/说明/收费）→ 提交 → 页面显示「已提交，等待门店确认」
 *   → 刷新复核 → 同一 Token 事后不可再进
 *
 * 每一步都留 **截图** 与 **该步实际发出的请求/响应**（JSON 落盘），
 * 存在 `.tmp-verify/evidence/browser/`。
 *
 * -----------------------------------------------------------------------------
 * 为什么不用 `agent-browser` CLI 而是直接走 CDP
 * -----------------------------------------------------------------------------
 * 本机实测：`agent-browser open` 能启动 Chromium，但**守护进程不在命令之间保持
 * 会话**（下一条命令看到的只有 `about:blank`）。这种"每条命令一个新页面"的状态
 * 无法完成"上传→填表→提交"的连续动作。
 * 于是改用 `agent-browser` 自己装好的那份 Chrome（`~/.agent-browser/browsers/`）
 * + DevTools Protocol：同样是**真实浏览器**，而且一个进程跑完整个流程，
 * 中间没有会话漂移。Node 22 自带 WebSocket，所以**零依赖**。
 *
 * ⚠️ 诚实标注：这是**自动化驱动的真实浏览器**，不是"人手逐下点击"。
 *    两者能证明的东西不同（见交付说明），不要把它们混为一谈。
 *
 * 前置：先跑 `node scripts/walkthrough-p5-1.mjs setup` 拿到夹具。
 * 收尾：浏览器关掉之后，再跑 `node scripts/walkthrough-p5-1.mjs verify` 复核库里的事实。
 *
 * 用法 / 退出码：0 通过 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './technician-harness.mjs';

const STATE_FILE = path.join(ROOT, '.tmp-verify', 'evidence', 'walkthrough-state.json');
const OUT_DIR = path.join(ROOT, '.tmp-verify', 'evidence', 'browser');
// ⚠️ 端口与 profile **必须每次运行都不同**（用 pid 区分）。
//    本机实测踩过：两次运行共用同一个 `--user-data-dir` + 调试端口时，
//    后启动的 Chrome 会**直接交给已在运行的实例**，两个脚本就会去驱动同一个浏览器、
//    抢同一个页面 —— 现象是"日志说第一步就超时，可数据库里流程却跑完了"，
//    两边的记录互相矛盾，根本没法当证据用。
const RUN_TAG = `${process.pid}`;
const PROFILE_DIR = path.join(ROOT, '.tmp-verify', 'evidence', `browser-profile-${RUN_TAG}`);
const DEBUG_PORT = 9400 + (process.pid % 500);

// ---------------------------------------------------------------------------
// 处理说明的填写模式（**DEV-82 定向复验**用）
//   filled（默认）—— 与 P5-1 证据④ 一致：写一段说明再提交
//   empty         —— 选「已解决」且**刻意不写说明**，验证"resolved 可留空"
//                    确实能一路走到提交成功（条件必填的**放宽那一侧**）
// 用法：WALKTHROUGH_NOTE=empty node scripts/walkthrough-p5-1-browser.mjs
// ⚠️ 与 `WALKTHROUGH_EXPECT_EMPTY_NOTE=1` 的 `walkthrough-p5-1.mjs verify` 配套使用
//    （那边据此把"说明必须非空"的断言换成"说明必须为空"）。
// ---------------------------------------------------------------------------
const NOTE_MODE = process.env.WALKTHROUGH_NOTE === 'empty' ? 'empty' : 'filled';

class EnvNotReady extends Error {}

const notes = [];
/** 模块作用域：失败路径也要能拿到它们做诊断 */
let cdp = null;
const consoleErrors = [];

function say(line) {
  console.log(line);
  notes.push(line);
}

// ---------------------------------------------------------------------------
// 找到 agent-browser 装好的 Chrome（不写死版本号）
// ---------------------------------------------------------------------------
function findChrome() {
  if (process.env.WALKTHROUGH_CHROME) return process.env.WALKTHROUGH_CHROME;
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agent-browser', 'browsers');
  if (!fs.existsSync(base)) {
    throw new EnvNotReady(`找不到 ${base} —— 先跑一次 \`agent-browser install\``);
  }
  const candidates = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chrome-'))
    .sort()
    .reverse()
    .map((d) => path.join(base, d, 'chrome.exe'))
    .filter((p) => fs.existsSync(p));
  if (!candidates.length) throw new EnvNotReady(`${base} 下没有 chrome-*/chrome.exe`);
  return candidates[0];
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${p.method})`));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new EnvNotReady(`CDP 连接失败：${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30_000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  /** 在页面里求值（默认取回可 JSON 化的值） */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面内异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  /** 轮询直到表达式为真（返回其真值），超时抛错 */
  async waitFor(expression, { timeout = 20_000, what = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(`(() => { try { return ${expression}; } catch (e) { return false; } })()`);
      if (last) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`等待超时：${what}`);
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  /**
   * **真实鼠标点击**（`Input.dispatchMouseEvent`），不是 `element.click()`。
   *
   * 为什么必须区分（本机实测教训）：`HTMLElement.click()` 派发的是
   * `isTrusted: false` 的合成事件，在 Chrome 里**不会**触发 `type="submit"`
   * 按钮的**表单提交**默认行为 —— 于是 `@submit.prevent` 的 handler 根本不跑，
   * 页面不报错、不发请求、字段状态一切正常，只有"什么都没发生"。
   * 用真鼠标点则和师傅的手指是同一路径（含真实的按下/抬起与默认行为）。
   */
  async realClick(selector) {
    const aim = async () =>
      this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        // behavior:'instant' —— 平滑滚动会让 getBoundingClientRect 取到**滚动中途**
        // 的坐标，点下去就落在别处（表现为"点了没反应"，且不报任何错）
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const at = document.elementFromPoint(x, y);
        return {
          x,
          y,
          size: { w: Math.round(r.width), h: Math.round(r.height) },
          hitSelf: !!at && (at === el || el.contains(at) || at.contains(el)),
          hitWhat: at ? at.tagName + '.' + (at.className || '') : null,
        };
      })()`);

    let box = await aim();
    if (!box) throw new Error(`找不到要点的元素：${selector}`);
    await new Promise((r) => setTimeout(r, 300));
    box = await aim(); // 滚动稳定后再取一次坐标
    if (!box.hitSelf) {
      throw new Error(
        `点在 ${selector} 上的坐标 (${box.x},${box.y}) 实际命中的是 ${box.hitWhat} ` +
          `—— 按钮被遮挡或坐标不对，这次点击不会生效`,
      );
    }
    const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    return box;
  }
}

// ---------------------------------------------------------------------------
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

async function pollJsonEndpoint(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new EnvNotReady(`Chrome 调试端口没起来（${url}）`);
}

async function main() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new EnvNotReady(`找不到 ${path.relative(ROOT, STATE_FILE)} —— 先跑 walkthrough-p5-1.mjs setup`);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const { token, shortLink, internalPath, ticketNo } = state;

  const photoFile = path.join(ROOT, '.tmp-verify', 'evidence', 'walkthrough-photo.jpg');
  assert(fs.existsSync(photoFile), `找不到走查照片 ${photoFile}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const chromePath = findChrome();
  say(`  浏览器：${chromePath}`);
  say(`  工单：${ticketNo}（visit=${state.visitId}）`);
  say(`  短链：${shortLink}`);

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=390,844',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const list = await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    assert(page, 'Chrome 没有可用的 page target');
    cdp = await Cdp.attach(page.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOM.enable');

    // 手机视口：这是师傅手上的页面，桌面尺寸看不出真问题
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });

    // ---- 记下页面真实发出的每一条 API 请求与响应 ----
    const calls = [];
    const bodyOf = new Map();
    cdp.on('Network.requestWillBeSent', (p) => {
      const url = p.request?.url ?? '';
      if (!url.includes('/api/')) return;
      calls.push({
        url,
        method: p.request.method,
        // 页面**实际发出去的报文**（提交那一步的逐字段证据就在这里）
        postData: p.request.postData ?? null,
        status: null,
        requestId: p.requestId,
      });
    });
    cdp.on('Network.responseReceived', (p) => {
      const hit = calls.find((c) => c.requestId === p.requestId);
      if (hit) {
        hit.status = p.response?.status ?? null;
        hit.mimeType = p.response?.mimeType;
      }
    });
    cdp.on('Network.loadingFinished', async (p) => {
      const hit = calls.find((c) => c.requestId === p.requestId);
      if (!hit) return;
      try {
        const r = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
        bodyOf.set(hit.url, r.body?.slice(0, 4000) ?? '');
      } catch {
        /* 图片等二进制取不到 body，忽略 */
      }
    });

    /** 响应体是异步抓的，读之前给它一点时间落地（否则会读到空 —— 那就是假绿） */
    const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

    // ---- 页面控制台 / 未捕获异常 ----
    // ⚠️ 必须单独收这里：Vue 把事件处理函数里同步抛出的错误交给 `console.error`，
    //    **不会**触发 `window.onerror`。只看 window 的 error 事件会得出
    //    "页面没报错、就是没发请求"这种没有方向可查的结论。
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'warning') return;
      consoleErrors.push(
        `[console.${p.type}] ` +
          p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400),
      );
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push(
        `[exception] ${(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 400)}`,
      );
    });

    // 供 finally 里无条件落盘用（失败时最需要的就是这份清单）
    globalThis.__calls = calls;
    globalThis.__token = token;

    // =====================================================================
    // ① 打开短信短链 → 必须 302 到 H5 实际路由
    // =====================================================================
    await cdp.send('Page.navigate', { url: shortLink });
    await cdp.waitFor('!!document.querySelector("#app")', { what: 'H5 根节点出现' });
    await cdp.waitFor(
      'document.querySelector("#app").textContent.includes("工单号")',
      { what: '作业页渲染出"工单号"' },
    );
    const landed = await cdp.evaluate('location.href');
    say(`\n  ① 短链落点：${landed}`);
    assert(
      landed.endsWith(internalPath),
      `短链没有 302 到 ${internalPath}，实际落在 ${landed}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'step1-作业页.png'));

    // =====================================================================
    // ② 最小上下文：该有的都有、不该有的一律没有
    // =====================================================================
    const pageText = await cdp.evaluate('document.body.textContent.replace(/\\s+/g, " ").trim()');
    fs.writeFileSync(path.join(OUT_DIR, 'step2-页面文本.txt'), pageText, 'utf8');
    say(`  ② 页面文本（${pageText.length} 字）：`);
    say(`     ${pageText.slice(0, 240)}…`);

    for (const required of [ticketNo, '工单号', '服务门店', '问题描述']) {
      assert(pageText.includes(required), `页面缺少「${required}」—— 最小信息不完整`);
    }
    // 客户资料：手机号形态 + 字段名，一个都不能出现
    const leak = await cdp.evaluate(`(() => {
      const raw = document.body.textContent + document.querySelector('#app').innerHTML;
      return {
        mobile: (document.body.textContent.match(/\\b1[3-9]\\d{9}\\b/) || [null])[0],
        field: (raw.match(/customer_(mobile|name|phone|tel|address)/) || [null])[0],
      };
    })()`);
    assert(!leak.mobile, `页面里出现了手机号：${leak.mobile}`);
    assert(!leak.field, `页面里出现了客户字段名：${leak.field}`);
    say(`     客户资料检查：手机号 ✗ 未出现 · 客户字段名 ✗ 未出现`);

    // 终态红线：P5-1 阶段页面**不得**出现"完成/已关闭"式表述
    const forbidden = await cdp.evaluate(
      'JSON.stringify((document.body.textContent.match(/[^\\s]{0,6}完成[^\\s]{0,4}|已关闭/g) || []))',
    );
    assert(forbidden === '[]', `页面出现终态红线词：${forbidden}`);
    say(`     终态红线检查：✗ 无"完成/已关闭"表述`);

    // 服务端下发的 GET 响应（证明"最小上下文"是服务端给的，不是前端挑的）
    await settle();
    const ctxCall = calls.find((c) => /\/api\/technician\/visits\/[^/]+$/.test(c.url));
    assert(ctxCall, '页面没有发出 GET 作业上下文请求');
    assert(ctxCall.status === 200, `GET 作业上下文应为 200，实际 ${ctxCall.status}`);
    const ctxBody = bodyOf.get(ctxCall.url) ?? '';
    fs.writeFileSync(path.join(OUT_DIR, 'step2-GET上下文响应.json'), ctxBody, 'utf8');
    say(`     GET ${ctxCall.url.replace(token, '<token>')} → ${ctxCall.status}`);
    // ⚠️ 必须按**精确字段名**判，不能用 `/customer_/` 前缀 ——
    //    服务端的处理结果枚举里有一个合法值 `customer_absent`（"客户不在家"），
    //    前缀匹配会把**枚举值**当成客户资料，报出一条假红灯。
    //    这正是本轮反复在修的那类错：判据宽了 → 假红 → 人开始忽略这条检查。
    const CUSTOMER_FIELDS = ['customer_mobile', 'customer_name', 'customer_phone', 'customer_tel', 'customer_address'];
    const leakedField = CUSTOMER_FIELDS.find((f) => ctxBody.includes(`"${f}"`));
    assert(!leakedField, `GET 响应里带了客户资料字段：${leakedField}`);
    // 再兜一道"形态"判据：响应体里不该出现手机号
    const leakedMobile = /\b1[3-9]\d{9}\b/.exec(ctxBody);
    assert(!leakedMobile, `GET 响应里出现了手机号：${leakedMobile?.[0]}`);
    say(`     字段级检查：5 个客户字段名均未出现 · 无手机号形态的值`);

    // =====================================================================
    // ③ 上传照片（真实文件选择 → 真实 multipart）
    // =====================================================================
    const inputObj = await cdp.send('Runtime.evaluate', {
      expression: 'document.querySelector("input[type=file]")',
    });
    assert(inputObj.result?.objectId, '页面上找不到照片 file input');
    await cdp.send('DOM.setFileInputFiles', {
      files: [photoFile],
      objectId: inputObj.result.objectId,
    });

    await cdp.waitFor('document.querySelectorAll(".svc-photo img").length >= 1', {
      what: '照片缩略图出现',
    });
    await settle();
    const uploadCalls = calls.filter((c) => c.url.endsWith('/files'));
    // 一次"选一张照片"**必须**只产生一次上传。多余的上传会白占张数上限
    // （师傅会莫名撞到"已达上限 6 张"），而且是纯粹静默的 —— 所以这里钉死条数。
    say(`     上传请求数：${uploadCalls.length}（一次选文件应恰好 1 次）`);
    assert(uploadCalls.length === 1, `一次选择文件却发出了 ${uploadCalls.length} 次上传请求`);
    const uploadCall = uploadCalls[0];
    assert(uploadCall, '页面没有发出上传请求');
    assert(uploadCall.status === 201, `上传应为 201，实际 ${uploadCall.status}`);
    const uploadBody = bodyOf.get(uploadCall.url) ?? '';
    fs.writeFileSync(path.join(OUT_DIR, 'step3-POST上传响应.json'), uploadBody, 'utf8');
    const uploadedRef = JSON.parse(uploadBody)?.data?.photo?.ref ?? '';
    say(`\n  ③ 上传：POST …/files → ${uploadCall.status}，ref=${uploadedRef}`);
    assert(!/storage_key/.test(uploadBody), '上传响应里泄漏了 storage_key');
    await cdp.screenshot(path.join(OUT_DIR, 'step3-已传照片.png'));

    // 照片是真能读出来的（受控端点 200）
    const imgOk = await cdp.evaluate(`(() => {
      const img = document.querySelector('.svc-photo img');
      return img ? { complete: img.complete, w: img.naturalWidth, src: img.getAttribute('src') } : null;
    })()`);
    assert(imgOk && imgOk.complete && imgOk.w > 0, `照片没渲染出来：${JSON.stringify(imgOk)}`);
    say(`     照片可读：naturalWidth=${imgOk.w}（src 带 token，已设 no-referrer）`);

    // =====================================================================
    // ④ 填回执：结果 / 说明 / 已收费 + 金额
    // =====================================================================
    const picked = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.svc-segment button')]
        .find((b) => b.textContent.trim() && b.textContent.trim() !== '未收费' && b.textContent.trim() !== '已收费');
      if (!btn) return null;
      const label = btn.textContent.trim();
      btn.click();
      return label;
    })()`);
    assert(picked, '找不到"处理结果"的可选项');
    say(`\n  ④ 处理结果选：${picked}`);

    if (NOTE_MODE === 'empty') {
      // —— DEV-82 定向复验：走"说明可留空"的那一侧 ——
      assert(
        picked === '已解决',
        `WALKTHROUGH_NOTE=empty 需要选「已解决」（resolved 才允许留空），实际选到「${picked}」`,
      );
      // 必填标记必须已经切成「（选填）」—— 这是"规则由服务端下发"在**页面上**的可见证据
      const labelHint = await cdp.evaluate(`(() => {
        const el = document.querySelector('#f-note');
        if (!el) return null;
        const field = el.closest('.svc-field') || el.parentElement;
        return { text: (field?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120) };
      })()`);
      assert(labelHint, '找不到处理说明字段容器');
      assert(
        labelHint.text.includes('选填') && !labelHint.text.includes('必填：'),
        `说明字段在「已解决」下应显示「（选填）」且不显示必填提示，实际：${labelHint.text}`,
      );
      say(`     说明：**刻意留空**（字段显示「（选填）」，无必填提示）—— DEV-82 的放宽侧`);
      say(`     字段附近文案：${labelHint.text}`);
    } else {
      await cdp.evaluate(`(() => {
        const ta = document.querySelector('#f-note');
        ta.value = 'P5-1 真实浏览器走查：更换排水泵后试机 30 分钟，无异常。';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    }

    await cdp.evaluate(`(() => {
      const charged = [...document.querySelectorAll('.svc-segment button')].find((b) => b.textContent.trim() === '已收费');
      charged.click();
      return true;
    })()`);
    await cdp.waitFor('!!document.querySelector("#f-amount")', { what: '"已收费"后出现金额输入框' });
    await cdp.evaluate(`(() => {
      const amt = document.querySelector('#f-amount');
      amt.value = '128.50';
      amt.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    say(`     收费：已收费 / 128.50（金额框是"选了收费才出现"的条件渲染）`);
    await cdp.screenshot(path.join(OUT_DIR, 'step4-回执已填.png'));

    // =====================================================================
    // ⑤ 提交
    // =====================================================================
    const canSubmit = await cdp.evaluate(
      '(() => { const b = document.querySelector(".svc-submit"); return { text: b.textContent.trim(), disabled: b.disabled }; })()',
    );
    assert(!canSubmit.disabled, `提交按钮是灰的（${canSubmit.text}）—— 表单没填完就走不到提交`);
    if (NOTE_MODE === 'empty') {
      // —— DEV-82 的核心判据：**说明为空**时按钮仍须可点。
      //    改动前的实现（无条件必填）在这里就会挂：canSubmit 要求说明非空 ⇒ 按钮灰 ⇒ 走不到提交。
      say(
        `     提交按钮：可用（文本「${canSubmit.text}」）—— **在说明为空的情况下**仍可提交，DEV-82 放宽侧成立`,
      );
    }
    // 注入探针：把"submit 事件有没有触发"与"handler 有没有发 fetch"分开。
    // 光看"没有请求"会以为"按钮没点到"，而真实原因可能在中途。
    await cdp.evaluate(`(() => {
      if (window.__probe) return true;
      window.__probe = { submitEvents: 0, fetchCalls: [], errors: [] };
      const form = document.querySelector('form.svc-card');
      form.addEventListener('submit', () => { window.__probe.submitEvents += 1; }, true);
      const orig = window.fetch;
      window.fetch = function (...args) {
        window.__probe.fetchCalls.push(String(args[0]));
        return orig.apply(this, args);
      };
      window.addEventListener('error', (e) => window.__probe.errors.push('err:' + String(e.message)));
      window.addEventListener('unhandledrejection', (e) =>
        window.__probe.errors.push('rej:' + String((e.reason && e.reason.message) || e.reason)));
      return true;
    })()`);

    // 真鼠标点"提交回执"（理由见 realClick 的注释：合成 click 不会触发表单提交）
    await cdp.realClick('.svc-submit');
    await settle(1500);
    let submitCall = calls.find((c) => c.url.endsWith('/submit'));
    if (!submitCall) {
      const diag = await cdp.evaluate(`JSON.stringify({
        probe: window.__probe,
        fieldErrors: [...document.querySelectorAll('.svc-error')].map((e) => e.textContent.trim()),
        btnDisabled: document.querySelector('.svc-submit')?.disabled ?? null,
        alert: document.querySelector('.svc-alert')?.textContent.trim() ?? null,
        noteLen: (document.querySelector('#f-note')?.value ?? '').length,
        amount: document.querySelector('#f-amount')?.value ?? null,
        activeSegments: [...document.querySelectorAll('.svc-segment button.is-active')].map((b) => b.textContent.trim()),
      })`);
      say(`     鼠标点击未触发提交，诊断：${diag}`);
      // 退回表单原生提交路径，让本轮走完；**如实标注**用了哪条路径
      await cdp.evaluate(
        '(() => { document.querySelector("form.svc-card").requestSubmit(); return true; })()',
      );
      await settle(1500);
      submitCall = calls.find((c) => c.url.endsWith('/submit'));
      if (!submitCall) {
        const diag2 = await cdp.evaluate(
          `JSON.stringify({ probe: window.__probe, alert: document.querySelector('.svc-alert')?.textContent.trim() ?? null })`,
        );
        throw new Error(
          `表单原生 requestSubmit() 也没发出请求。首次诊断：${diag}；之后：${diag2}` +
            `\n     页面控制台：\n       ${consoleErrors.join('\n       ') || '(空)'}`,
        );
      }
      say('     ⚠️ 本轮提交走的是 form.requestSubmit()（鼠标点击未触发表单默认提交行为，已如实记录）');
    }
    // ⚠️ 不要只等 `.svc-success`：失败时页面会出一条 `.svc-alert.danger`，
    //    只等成功态的话，现象是"超时"，而真正的原因（后端 4xx/5xx 的文案）
    //    被丢掉了 —— 排查方向会跑偏到"是不是没点到按钮"。
    const outcome = await cdp.waitFor(
      `(() => {
        if (document.querySelector('.svc-success')) return 'success';
        const alert = document.querySelector('.svc-alert.danger');
        if (alert) return 'error: ' + alert.textContent.trim();
        return false;
      })()`,
      { what: '提交结果（成功页或错误条）', timeout: 25_000 },
    );
    if (String(outcome).startsWith('error:')) {
      fs.writeFileSync(
        path.join(OUT_DIR, 'step5-提交失败-页面状态.txt'),
        await cdp.evaluate('document.body.textContent.replace(/\\s+/g," ").trim()'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(OUT_DIR, 'step5-提交失败-网络调用.json'),
        JSON.stringify(calls.map((c) => ({ ...c, requestId: undefined })), null, 2),
        'utf8',
      );
      throw new Error(`提交后页面报错 —— ${String(outcome).slice(7)}（详见 step5-提交失败-*.txt/json）`);
    }
    await cdp.waitFor('!!document.querySelector(".svc-success")', { what: '终态页面出现', timeout: 25_000 });

    const successText = await cdp.evaluate(
      'document.querySelector(".svc-success").textContent.replace(/\\s+/g, " ").trim()',
    );
    say(`\n  ⑤ 终态文案：${successText}`);
    assert(
      successText.includes('等待门店确认'),
      `终态文案没有指向门店确认：${successText}`,
    );
    assert(!/完工|工单已完成|服务已完成|已关闭/.test(successText), `终态文案出现闭环词：${successText}`);
    await cdp.screenshot(path.join(OUT_DIR, 'step5-已提交等待确认.png'));

    await settle();
    assert(submitCall, '页面没有发出提交请求');
    assert(submitCall.status === 200, `提交应为 200，实际 ${submitCall.status}`);
    fs.writeFileSync(
      path.join(OUT_DIR, 'step5-POST提交响应.json'),
      bodyOf.get(submitCall.url) ?? '',
      'utf8',
    );
    const submitBody = bodyOf.get(submitCall.url) ?? '';
    assert(
      /"status"\s*:\s*"WAIT_STORE_CONFIRM"/.test(submitBody),
      `提交响应里没有 WAIT_STORE_CONFIRM：${submitBody.slice(0, 200)}`,
    );
    say(`     POST …/submit → ${submitCall.status}，响应含 WAIT_STORE_CONFIRM ✓`);

    // 请求体逐字段（证明页面发的就是那四个字段；不收费时金额为 null）
    await settle();
    fs.writeFileSync(
      path.join(OUT_DIR, 'step5-提交请求体.json'),
      submitCall.postData ?? '(空)',
      'utf8',
    );
    const submitFields = Object.keys(JSON.parse(submitCall.postData ?? '{}')).sort();
    say(`     提交报文逐字段：${JSON.stringify(submitFields)}`);
    assert(
      submitFields.join(',') === 'is_charged,reported_charge_amount,service_note,service_result',
      `提交报文字段不对：${JSON.stringify(submitFields)}`,
    );
    if (NOTE_MODE === 'empty') {
      // 报文里 `service_note` 必须**仍是字段之一**（契约不变），但值为空串 ——
      // 页面不因为"这次不用填"就把字段整个去掉（后端仍按同一份 DTO 解析）。
      const body = JSON.parse(submitCall.postData ?? '{}');
      assert(
        submitCall.postData.includes('"service_note"'),
        `留空模式下报文体里没有 service_note 字段：${submitCall.postData}`,
      );
      assert(
        !body.service_note,
        `留空模式下 service_note 应为空，实际：${JSON.stringify(body.service_note)}`,
      );
      assert(body.service_result === 'resolved', `留空模式下 service_result 应为 resolved，实际：${body.service_result}`);
      say(
        `     报文内容：service_result=${body.service_result} · service_note=${JSON.stringify(body.service_note)}（空）· is_charged=${body.is_charged}`,
      );
    }

    // =====================================================================
    // ⑥ 刷新复核 + 同一 Token 事后不可再用
    // =====================================================================
    const beforeReload = calls.length;
    await cdp.send('Page.reload');
    await cdp.waitFor('!!document.querySelector(".svc-success") || document.body.textContent.includes("链接不可用")', {
      what: '刷新后页面渲染完成',
    });
    const afterReload = await cdp.evaluate(
      'document.querySelector(".svc-success") ? document.querySelector(".svc-success").textContent.replace(/\\s+/g," ").trim() : "链接不可用"',
    );
    say(`\n  ⑥ 刷新后：${afterReload}`);
    assert(
      !afterReload.includes('链接不可用'),
      '刷新后显示"链接不可用" —— 师傅会以为提交失败，而实际已提交成功',
    );
    assert(afterReload.includes('等待门店确认'), `刷新后文案不对：${afterReload}`);
    await cdp.screenshot(path.join(OUT_DIR, 'step6-刷新后仍显示等待确认.png'));

    // 刷新会再打一次 GET；它必须是 401（Token 已消费），但页面**不该**因此说失败
    await settle(1000);
    const afterGet = calls
      .slice(beforeReload)
      .find((c) => /\/api\/technician\/visits\/[^/]+$/.test(c.url));
    assert(afterGet, '刷新后没有再打 GET —— "Token 已废"这件事没被真实观测到');
    say(`     刷新触发的 GET …/visits/<token> → ${afterGet.status}`);
    assert(afterGet.status === 401, `已提交后 GET 应为 401，实际 ${afterGet.status}`);
    assert(
      !(bodyOf.get(afterGet.url) ?? '').includes('原因'),
      '401 响应体里出现了"原因"字样 —— 失效原因可能被泄漏',
    );

    say('\n  ✅ 真实浏览器闭环走查通过（截图与请求响应已落盘）');
    say('');
  } finally {
    // 网络调用清单**无条件落盘**：失败时它才是最需要看的东西
    try {
      if (globalThis.__calls) {
        fs.writeFileSync(
          path.join(OUT_DIR, 'step0-网络调用清单.json'),
          JSON.stringify(
            globalThis.__calls.map((c) => ({
              ...c,
              url: String(c.url).replace(globalThis.__token ?? '', '<token>'),
              requestId: undefined,
            })),
            null,
            2,
          ),
          'utf8',
        );
      }
      fs.writeFileSync(path.join(OUT_DIR, '走查记录.txt'), notes.join('\n'), 'utf8');
    } catch {
      /* 落盘失败不影响结论 */
    }
    try {
      cdp?.ws.close();
    } catch {
      /* 忽略 */
    }
    chrome.kill();
    // Chrome 的子进程有时比主进程死得慢，留一点时间再删 profile
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch {
      /* profile 删不掉不影响结论 */
    }
  }
}

try {
  console.log('\n=== P5-1 真实浏览器走查（CDP 驱动真实 Chromium）===');
  await main();
} catch (error) {
  if (error instanceof EnvNotReady) {
    console.log(`\n  🟡 环境未就绪（退出码 2）：${error.message}\n`);
    process.exit(2);
  }
  console.log(`\n  ❌ 真红灯（退出码 1）：${error?.message ?? error}\n`);
  console.log(error?.stack ?? '');
  process.exit(1);
}
