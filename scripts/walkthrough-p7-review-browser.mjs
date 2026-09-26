#!/usr/bin/env node
/**
 * walkthrough-p7-review-browser.mjs —— Phase 7 客户评价页**真实浏览器**走查
 * =============================================================================
 *
 * 用真实 Chromium 走**客户侧**（匿名，无登录）的三条路径：
 *
 *   走查① 正常评价：打开 `/f/{token}` → 302 → H5 评价页 → 选 5 星
 *            → 收费金额选「一致」→ 提交 → 展示「已提交」终态
 *            → 库侧：工单 CLOSED / `reviewed_at` 有值 / `review_status=submitted`
 *   走查② 低分 reopen：打开另一张工单 → 选 2 星 → 提交
 *            → 展示终态 → 库侧：工单 PROCESSING / `escalated=true` / `reopen_count+1`
 *   走查③ 收费不一致 reopen：选 4 星（**高分**）+ 金额「不一致」→ 提交
 *            → 库侧：**高分也 reopen**（金额核对独立触发）
 *
 * 每步留截图 + 该步真实发出的请求/响应，存在
 * `.tmp-verify/evidence/p7-review-browser/`。
 *
 * -----------------------------------------------------------------------------
 * 为什么这条走查不能省（尽管有机器门禁）
 * -----------------------------------------------------------------------------
 * `verify-review-loop.mjs` 覆盖了**接口层**（A~G 组，含真并发）。它证明不了的
 * 是**浏览器里那道 302 真的落到评价页、星级真的能点、提交按钮真的发请求** ——
 * 这条链跨了 nginx(302) → H5(SPA 路由) → 评价页(Vue) → 匿名 API 四层，
 * 任何一层断掉，接口层的绿都不代表"客户能评价"。
 *
 * ⚠️ 诚实标注：这是**自动化驱动的真实浏览器**，不是"人手逐下点击"。
 *    它能证明"页面渲染 + 点得动 + 请求真的发出去 + 状态真的变了"；
 *    最终验收仍以真人走查为准。
 *
 * 前置：本脚本**自建夹具**（直接插一张 WAIT_FEEDBACK + 已提交 Visit 的工单），
 *       跑完按 ticket id 精确清理。不需要手工准备。
 *
 * 用法：node scripts/walkthrough-p7-review-browser.mjs
 *       node scripts/walkthrough-p7-review-browser.mjs --keep   # 跑完不清理（留证据）
 * 退出码：0 通过 / 1 真红灯 / 2 环境未就绪
 * =============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify', 'evidence', 'p7-review-browser');
const RUN_TAG = `${Date.now()}-${process.pid}`;
const PROFILE_DIR = path.join(ROOT, '.tmp-verify', 'evidence', `p7-profile-${RUN_TAG}`);
// ⚠️ 随机高位端口：固定端口 + 残留 Chrome 会把新 URL 转交给旧实例（本项目已踩）
const DEBUG_PORT = 23000 + Math.floor(Math.random() * 20000);
const KEEP = process.argv.includes('--keep');

const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(envText)?.[1]?.trim();
const NGINX_HTTP_PORT = envValue('NGINX_HTTP_PORT');
if (!NGINX_HTTP_PORT) {
  console.error('✗ .env 缺少 NGINX_HTTP_PORT —— 环境未就绪');
  process.exit(2);
}
const BASE = `http://127.0.0.1:${NGINX_HTTP_PORT}`;
// ⚠️ 客户在手机上打开的是 PUBLIC_BASE_URL（可能含 LAN IP / 域名）。
//    走查时**临时**把 host 换成 127.0.0.1:NGINX_HTTP_PORT（只换 host:port，不改 .env）
//    —— 沿用 P5-2 的现场做法。
const REVIEW_TOKEN_BYTES = (() => {
  const ts = fs.readFileSync(
    path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts'),
    'utf8',
  );
  return Number(/(?:^|\n)(?:export\s+)?const\s+REVIEW_TOKEN_BYTES\s*=\s*(\d+)\s*;/.exec(ts)?.[1]);
})();
const REVIEW_LENGTH = Math.ceil((REVIEW_TOKEN_BYTES * 4) / 3);

class EnvNotReady extends Error {}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const notes = [];
const consoleErrors = [];
let cdp = null;
const say = (l) => {
  console.log(l);
  notes.push(l);
};

// ---------------------------------------------------------------------------
// DB 工具（沿用 verify-review-loop 的路子）
// ---------------------------------------------------------------------------
function psql(sqlText) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '|', '-c', sqlText],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}
function sqlOne(sqlText) {
  const out = psql(sqlText);
  return out ? out.split('\n')[0].split('|')[0] : '';
}
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ---------------------------------------------------------------------------
// 夹具：建一张 WAIT_FEEDBACK + hashed token 的工单，返回明文 token 与 id
// ---------------------------------------------------------------------------
let SEQ = 0;
function makeFixture({ charged, amount, label }) {
  const n = ++SEQ;
  const ticketNo = `P7W-${Date.now().toString(36).slice(-6)}${n}`;
  const token = randomBytes(REVIEW_TOKEN_BYTES).toString('base64url');
  const hash = sha256(token);
  const mobile = `1380000${String(1000 + n).slice(-4)}`;
  const ticketId = Number(
    sqlOne(`
      INSERT INTO service_tickets
        (created_at, updated_at, ticket_no, source, ticket_type, content, customer_mobile,
         status, escalated, reopen_count, review_status,
         feedback_token_hash, feedback_token_expires_at, completed_at)
      VALUES (now(), now(), ${lit(ticketNo)}, 'h5', 'repair', ${lit(`${label}（Phase 7 走查夹具）`)},
              ${lit(mobile)}, 'WAIT_FEEDBACK', false, 0, 'pending',
              ${lit(hash)}, now() + interval '7 days', now())
      RETURNING id;`),
  );
  assert(ticketId > 0, '夹具工单未插入');
  // 一张已提交的 Visit（评价针对它，也是收费核对的来源）
  // ⚠️ 真机取证：`service_visits.visit_no` 是 **integer**（不是字符串）
  //    —— 首跑把它写成 'V-xxx' 直接 `invalid input syntax for type integer`。
  const visitNo = Number(sqlOne(`SELECT coalesce(max(visit_no),0)+1 FROM service_visits`));
  const visitId = Number(
    sqlOne(`
      INSERT INTO service_visits
        (created_at, updated_at, ticket_id, visit_no, service_mode, technician_name, technician_mobile,
         expected_visit_at, is_remote, store_confirm_status, visit_status,
         is_charged, confirmed_charge_amount, service_note)
      VALUES (now(), now(), ${ticketId}, ${visitNo}, 'onsite', '走查师傅', '13900000000',
              now(), false, 'confirmed', 'SUBMITTED',
              ${charged ? 'true' : 'false'}, ${charged ? Number(amount).toFixed(2) : 'NULL'}, '走查夹具')
      RETURNING id;`),
  );
  assert(visitId > 0, '夹具 Visit 未插入');
  // ⚠️ **必须**回填 `feedback_visit_id`：匿名 GET 的收费事实（`is_charged` /
  //    `confirmed_charge_amount`）是从 **Visit** 读的（`reviewContextOf` 用
  //    `ticket.feedback_visit_id` 找 Visit）。首跑漏了这一步，页面就一直显示
  //    "门店确认未收费" —— 夹具看起来对、实际缺了因果链的一环。
  psql(`UPDATE service_tickets SET feedback_visit_id = ${visitId} WHERE id = ${ticketId};`);
  return { ticketId, visitId, ticketNo, token, charged, amount };
}

function cleanupFixture(fx) {
  psql(`
    DELETE FROM ticket_events WHERE ticket_id = ${fx.ticketId};
    DELETE FROM sms_logs WHERE ticket_id = ${fx.ticketId};
    DELETE FROM service_visit_photos WHERE visit_id = ${fx.visitId};
    DELETE FROM service_visits WHERE id = ${fx.visitId};
    DELETE FROM service_tickets WHERE id = ${fx.ticketId};`);
}

// ---------------------------------------------------------------------------
// CDP（沿用 walkthrough-p6-2-browser 的实现，已验证可用）
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
      ws.addEventListener('error', () => reject(new EnvNotReady(`CDP 连接失败：${wsUrl}`)), { once: true });
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
  on(m, fn) {
    if (!this.handlers.has(m)) this.handlers.set(m, []);
    this.handlers.get(m).push(fn);
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(
        `页面内异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result.value;
  }
  async waitFor(expression, { timeout = 20_000, what = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.evaluate(`(() => { try { return ${expression}; } catch (e) { return false; } })()`);
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`等待超时：${what}`);
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  async realClick(selector) {
    const aim = () =>
      this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const at = document.elementFromPoint(x, y);
        return { x, y, hitSelf: !!at && (at === el || el.contains(at) || at.contains(el)), hitWhat: at ? at.tagName + '.' + (at.className || '') : null };
      })()`);
    let box = await aim();
    if (!box) throw new Error(`找不到要点的元素：${selector}`);
    await sleep(250);
    box = await aim();
    if (!box.hitSelf) throw new Error(`点在 ${selector} 坐标命中 ${box.hitWhat} —— 被遮挡`);
    const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }
}

function findChrome() {
  const candidates = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  candidates.push(path.join(home, '.agent-browser', 'browsers'));
  const bases = candidates.filter((b) => b && fs.existsSync(b));
  for (const base of bases) {
    for (const dir of fs.readdirSync(base)) {
      const p = path.join(base, dir);
      if (!fs.statSync(p).isDirectory()) continue;
      const nested = fs.readdirSync(p).map((x) => path.join(p, x));
      for (const c of nested) {
        if (/chrome\.exe$/i.test(c) && fs.existsSync(c)) return c;
      }
    }
  }
  for (const c of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]) {
    if (fs.existsSync(c)) return c;
  }
  throw new EnvNotReady('找不到 Chrome —— 装 Google Chrome 或跑一次 agent-browser');
}

async function pollJsonEndpoint(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 未就绪 */
    }
    await sleep(300);
  }
  throw new EnvNotReady(`Chrome 调试端口没起来（${url}）`);
}

/**
 * 在评价页上：选 N 星 → （需要时）选收费核对态 → 提交。
 * ⚠️ 星级与收费核对用**元素定位**（role=radio / button 文案），不靠 innerText 拼接
 *    —— 沿用 P6-2 的教训（antd 两字按钮加空格 / 相邻文本拼接会造假阳性）。
 */
async function fillAndSubmit({ rating, chargeMatch, amount }) {
  // 打开页面前先等表单
  await cdp.waitFor(`!!document.querySelector('[data-review-form]')`, {
    what: '评价表单渲染（data-review-form）',
    timeout: 30_000,
  });

  // 星级：页面上星按钮带 data-star="1..5"
  const starSel = `[data-star="${rating}"]`;
  await cdp.realClick(starSel);
  await sleep(200);
  const selected = await cdp.evaluate(
    `document.querySelector(${JSON.stringify(starSel)})?.getAttribute('aria-checked') === 'true'`,
  );
  assert(selected, `点击 ${rating} 星后未选中（aria-checked 不为 true）`);

  if (chargeMatch) {
    // 收费核对：页面上带 data-charge="match|mismatch"
    // ⚠️ 若这里找不到，通常是 `ctx.is_charged` 为 false（渲染成"未收费"固定文案）。
    //    先把真实上下文 dump 出来，别让"选择器找不到"掩盖真实原因。
    const hasCharge = await cdp.evaluate(`!!document.querySelector('[data-charge="${chargeMatch}"]')`);
    if (!hasCharge) {
      const diag = await cdp.evaluate(
        `JSON.stringify({ hasForm: !!document.querySelector('[data-review-form]'), fixedNote: (document.querySelector('.rv-fixed')||{}).innerText || null, bodyText: (document.querySelector('[data-review-form]')||document.body).innerText.slice(0,400) })`,
      );
      await cdp.screenshot(path.join(OUT_DIR, `diag-${RUN_TAG}-charge缺失.png`));
      throw new Error(`期望的收费核对选择器 [data-charge="${chargeMatch}"] 不存在。诊断：${diag}`);
    }
    await cdp.realClick(`[data-charge="${chargeMatch}"]`);
    await sleep(200);
    if (chargeMatch === 'mismatch' && amount !== undefined) {
      await cdp.waitFor(`!!document.querySelector('[data-charge-amount]')`, {
        what: '不一致时出现金额输入框',
        timeout: 8_000,
      });
      await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-charge-amount]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, ${JSON.stringify(String(amount))});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
    }
  }

  // 提交
  await cdp.realClick('[data-review-submit]');
  // 等终态（已提交 / 或 reopened 终态）
  await cdp.waitFor(
    `!!document.querySelector('[data-review-done]') || !!document.querySelector('[data-review-blocked]')`,
    { what: '提交后展示终态', timeout: 30_000 },
  );
  const done = await cdp.evaluate(
    `(() => {
      const d = document.querySelector('[data-review-done]');
      const b = document.querySelector('[data-review-blocked]');
      return JSON.stringify({ done: !!d, blocked: !!b, text: (d || b || {}).innerText?.slice(0, 300) || '' });
    })()`,
  );
  return JSON.parse(done);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  say('');
  say('══════════════════════════════════════════════════════════════');
  say('  Phase 7 客户评价页 真实浏览器走查');
  say('══════════════════════════════════════════════════════════════');

  const chromePath = findChrome();
  say(`  浏览器：${chromePath}`);

  // 夹具：三张（正常 5 星收费一致 / 低分 2 星 / 高分 4 星但金额不一致）
  const fxNormal = makeFixture({ charged: true, amount: 88, label: '正常评价（收费且一致）' });
  const fxLow = makeFixture({ charged: false, amount: null, label: '低分 reopen（未收费）' });
  const fxMismatch = makeFixture({ charged: true, amount: 88, label: '高分但金额不一致' });
  say(`  夹具：正常=${fxNormal.ticketNo} 低分=${fxLow.ticketNo} 金额不一致=${fxMismatch.ticketNo}`);

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=420,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const calls = [];
  const persist = () => {
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, 'summary.json'),
        JSON.stringify({ notes, consoleErrors, calls: calls.map((c) => ({ ...c, requestId: undefined })) }, null, 2),
        'utf8',
      );
    } catch {
      /* 落盘失败不掩盖主错 */
    }
  };
  globalThis.__persist = persist;

  const results = { walk1: null, walk2: null, walk3: null };

  try {
    // 端口占用检测（防僵尸实例）
    try {
      const pre = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
      if (pre.ok) throw new EnvNotReady(`调试端口 ${DEBUG_PORT} 已被占用（疑似残留 Chrome）—— 换端口重跑`);
    } catch (e) {
      if (e instanceof EnvNotReady) throw e;
    }

    const list = await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    assert(page, 'Chrome 没有 page target');
    cdp = await Cdp.attach(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    cdp.on('Network.requestWillBeSent', (p) => {
      const url = p.request?.url ?? '';
      if (!url.includes('/api/public/reviews/') && !url.startsWith(BASE + '/f/')) return;
      calls.push({ url: url.replace(/\/f\/[A-Za-z0-9_-]{8,}$/, '/f/***'), method: p.request.method, status: null, requestId: p.requestId });
    });
    cdp.on('Network.responseReceived', (p) => {
      const hit = calls.find((c) => c.requestId === p.requestId);
      if (hit) hit.status = p.response?.status ?? null;
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      consoleErrors.push('[console.error] ' + p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
    });

    // ============ 走查① 正常评价（5 星 + 收费一致）============
    say('\n  ── 走查① 正常评价（5 星 + 收费一致）──');
    const url1 = `${BASE}/f/${fxNormal.token}`;
    await cdp.send('Page.navigate', { url: url1 });
    // 302 → H5 评价页：断言落点 URL 已变为 /h5/customer/review/{token}
    await cdp.waitFor(`location.pathname.indexOf('/h5/customer/review/') === 0`, {
      what: '302 后落到 H5 评价页',
      timeout: 30_000,
    });
    const landed = await cdp.evaluate(`location.pathname`);
    say(`    302 落点：${landed.replace(/\/[A-Za-z0-9_-]{20,}$/, '/***')}`);
    assert(landed.includes('/customer/review/'), `302 未落到评价页：${landed}`);
    await cdp.screenshot(path.join(OUT_DIR, 'walk1-01-评价页.png'));

    const r1 = await fillAndSubmit({ rating: 5, chargeMatch: 'match' });
    await cdp.screenshot(path.join(OUT_DIR, 'walk1-02-提交后终态.png'));
    assert(r1.done, `提交后未展示终态（done=${r1.done} blocked=${r1.blocked}）`);
    const t1 = psql(`SELECT status||'|'||review_status||'|'||coalesce(to_char(reviewed_at,'YYYY-MM-DD HH24:MI'),'NULL')||'|'||escalated||'|'||reopen_count FROM service_tickets WHERE id=${fxNormal.ticketId}`);
    say(`    库侧：${t1}`);
    assert(t1.startsWith('CLOSED|submitted|'), `正常评价后应为 CLOSED+submitted，实际 ${t1}`);
    assert(!t1.includes('|NULL|'), `reviewed_at 未写入：${t1}`);
    assert(t1.includes('|false|0'), `正常评价不应 escalate/reopen：${t1}`);
    // 收费"一致"也要真的落到 Visit 上（不只是把工单关掉）——
    // 否则"客户核对过收费"这件事在库里没有痕迹。
    const v1 = psql(`SELECT customer_charge_match||'|'||coalesce(customer_reported_amount::text,'NULL') FROM service_visits WHERE id=${fxNormal.visitId}`);
    say(`    库侧 Visit 金额核对：${v1}`);
    assert(v1 === 'match|NULL', `一致时应记 match 且不带客户金额，实际 ${v1}`);
    results.walk1 = { ok: true, ticket: t1, visit: v1, terminal: r1.text.slice(0, 80) };

    // ============ 走查② 低分 reopen（2 星）============
    say('\n  ── 走查② 低分 reopen（2 星 < 阈值 3）──');
    await cdp.send('Page.navigate', { url: `${BASE}/f/${fxLow.token}` });
    await cdp.waitFor(`location.pathname.indexOf('/h5/customer/review/') === 0`, { what: '302 落点', timeout: 30_000 });
    await cdp.waitFor(`!!document.querySelector('[data-review-form]')`, { what: '评价表单', timeout: 30_000 });
    await cdp.screenshot(path.join(OUT_DIR, 'walk2-01-评价页.png'));
    // 未收费：页面上**不应**出现金额输入框（§5 三态）
    const hasAmount = await cdp.evaluate(`!!document.querySelector('[data-charge-amount]')`);
    assert(!hasAmount, '未收费工单出现了金额输入框（§5 要求未收费不出现金额框）');
    await cdp.realClick('[data-star="2"]');
    await sleep(200);
    // 低分应出现"可能被重新处理"的预告
    const forecast = await cdp.evaluate(
      `(() => { const el = document.querySelector('[data-review-forecast]'); return el ? el.innerText.slice(0,120) : ''; })()`,
    );
    say(`    低分预告文案：${forecast || '(无)'}`);
    await cdp.realClick('[data-review-submit]');
    await cdp.waitFor(`!!document.querySelector('[data-review-done]') || !!document.querySelector('[data-review-blocked]')`, { what: '终态', timeout: 30_000 });
    await cdp.screenshot(path.join(OUT_DIR, 'walk2-02-提交后终态.png'));
    const t2 = psql(`SELECT status||'|'||review_status||'|'||escalated||'|'||reopen_count FROM service_tickets WHERE id=${fxLow.ticketId}`);
    say(`    库侧：${t2}`);
    assert(t2.startsWith('PROCESSING|submitted|'), `低分评价后应为 PROCESSING+submitted，实际 ${t2}`);
    assert(t2.includes('|true|1'), `低分应 escalated=true 且 reopen_count=1，实际 ${t2}`);
    // 未收费 ⇒ 只能 not_applicable，且不得留下金额（NULL ≠ 0.00）
    const v2 = psql(`SELECT customer_charge_match||'|'||coalesce(customer_reported_amount::text,'NULL') FROM service_visits WHERE id=${fxLow.visitId}`);
    say(`    库侧 Visit 金额核对：${v2}`);
    assert(v2 === 'not_applicable|NULL', `未收费应记 not_applicable 且金额为 NULL，实际 ${v2}`);
    results.walk2 = { ok: true, ticket: t2, visit: v2, forecast };

    // ============ 走查③ 高分 + 金额不一致 → 仍 reopen ============
    say('\n  ── 走查③ 高分（4 星）+ 收费金额不一致 → 仍 reopen ──');
    await cdp.send('Page.navigate', { url: `${BASE}/f/${fxMismatch.token}` });
    await cdp.waitFor(`location.pathname.indexOf('/h5/customer/review/') === 0`, { what: '302 落点', timeout: 30_000 });
    await cdp.waitFor(`!!document.querySelector('[data-review-form]')`, { what: '评价表单', timeout: 30_000 });
    await cdp.screenshot(path.join(OUT_DIR, 'walk3-01-评价页.png'));
    await cdp.realClick('[data-star="4"]');
    await sleep(200);
    await cdp.realClick('[data-charge="mismatch"]');
    await sleep(200);
    await cdp.waitFor(`!!document.querySelector('[data-charge-amount]')`, { what: '不一致时出现金额框', timeout: 8_000 });
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-charge-amount]');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, '60');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
    await cdp.screenshot(path.join(OUT_DIR, 'walk3-02-填写后.png'));
    await cdp.realClick('[data-review-submit]');
    await cdp.waitFor(`!!document.querySelector('[data-review-done]') || !!document.querySelector('[data-review-blocked]')`, { what: '终态', timeout: 30_000 });
    await cdp.screenshot(path.join(OUT_DIR, 'walk3-03-提交后终态.png'));
    // ⚠️ 走查脚本自身踩过的坑（已修，非产品缺陷）：
    //   ① `customer_charge_match` 在 **service_visits** 上，不在 service_tickets 上 ——
    //      原先误写在 Ticket 查询里 ⇒ `column "customer_charge_match" does not exist`。
    //   ② 客户实付金额的列名是 **`customer_reported_amount`**（客户实付金额），
    //      与师傅填报的 `reported_charge_amount` 是**两个不同列** —— 原先查错了后者。
    //      两者语义不同：前者=客户说付了多少，后者=师傅填报收了多少。
    const t3 = psql(`SELECT status||'|'||review_status||'|'||escalated||'|'||reopen_count FROM service_tickets WHERE id=${fxMismatch.ticketId}`);
    const v3 = psql(`SELECT coalesce(customer_charge_match,'NULL')||'|'||coalesce(customer_reported_amount::text,'NULL')||'|'||coalesce(charge_diff_reason,'NULL') FROM service_visits WHERE id=${fxMismatch.visitId}`);
    say(`    库侧工单：${t3}`);
    say(`    库侧 Visit 金额核对：${v3}`);
    assert(t3 === 'PROCESSING|submitted|true|1', `高分+不一致应为 PROCESSING|submitted|true|1，实际 ${t3}`);
    // ⚠️ 金额列是 numeric ⇒ 库里回 `60.00` 而非 `60`。断言要比数值不要比字符串字面量。
    assert(v3.startsWith('mismatch|') && Number(v3.split('|')[1]) === 60, `Visit 应记 customer_charge_match=mismatch 且客户实付 60，实际 ${v3}`);
    assert(!v3.endsWith('|NULL'), `Visit 应留下 charge_diff_reason（差在哪），实际 ${v3}`);
    results.walk3 = { ok: true, ticket: t3, visit: v3 };

    say('\n  三条走查全部通过');
    if (consoleErrors.length) {
      say(`  ⚠️ 页面 console 错误 ${consoleErrors.length} 条：`);
      for (const e of consoleErrors.slice(0, 5)) say(`     ${e}`);
    } else {
      say('  页面无 console 错误');
    }
  } finally {
    persist();
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    if (!KEEP) {
      for (const fx of [fxNormal, fxLow, fxMismatch]) {
        try {
          cleanupFixture(fx);
        } catch {
          /* 清理失败不掩盖主错 */
        }
      }
      say('  夹具已清理');
    } else {
      say('  （--keep：夹具保留，便于人工复查）');
    }
  }

  say('');
  say('══════════════════════════════════════════════════════════════');
  say('  ✅ Phase 7 客户评价页浏览器走查全部通过');
  say('══════════════════════════════════════════════════════════════');
  say('');
}

main().catch((e) => {
  try {
    globalThis.__persist?.();
  } catch {
    /* ignore */
  }
  if (e instanceof EnvNotReady) {
    console.error(`\n✗ 环境未就绪：${e.message}\n`);
    process.exit(2);
  }
  console.error(`\n✗ 走查失败：${e.message}\n`);
  process.exit(1);
});
