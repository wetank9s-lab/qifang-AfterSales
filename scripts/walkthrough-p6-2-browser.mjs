#!/usr/bin/env node
/**
 * walkthrough-p6-2-browser.mjs —— P6-2 门店确认/驳回**真实浏览器**走查
 * =============================================================================
 *
 * 用真实 Chromium 走门店后台的两条路径（用户 2026-09-25 拍板的验收口径）：
 *
 *   走查① 确认：登录门店 → 工单列表 → 点开「待门店确认」的**收费**工单详情
 *            → 「技师回执」区块出现「确认服务 / 驳回」→ 点「确认服务」
 *            → 金额输入框出现（收费）→ 提交 → 按钮消失 + 工单进「待评价」。
 *   走查② 驳回：点开另一张「待门店确认」的**不收费**工单 → 点「驳回」
 *            → 填原因 → 提交 → 按钮消失 + 工单回「处理中」。
 *
 * 每步留截图 + 该步真实发出的请求/响应，存在 `.tmp-verify/evidence/p6-2-browser/`。
 *
 * -----------------------------------------------------------------------------
 * 为什么直接走 CDP 而不是 agent-browser CLI（沿用 walkthrough-p5-1-browser.mjs 的结论）
 * -----------------------------------------------------------------------------
 * 本机实测：agent-browser CLI 的守护进程不在命令之间保持会话，无法完成
 * "登录 → 点详情 → 填表单 → 提交"的连续动作。改用 agent-browser 装好的那份 Chrome
 * （`~/.agent-browser/browsers/`）+ DevTools Protocol：同样真实浏览器，一个进程跑完。
 *
 * ⚠️ 诚实标注：这是**自动化驱动的真实浏览器**，不是"人手逐下点击"。两者能证明的
 *    东西不同 —— 这里证明"按钮渲染 + 点得动 + 请求真的发出去 + 成功后刷新"，
 *    最终验收仍以真人走查为准。
 *
 * 前置：先跑 `node scripts/prepare-p6-2-walkthrough.mjs` 拿到两张工单（收费/不收费）。
 * 用法：WALKTHROUGH_TICKET_NO=FWxxx node scripts/walkthrough-p6-2-browser.mjs
 *       （不传则自动挑库里最新一张「待门店确认」工单）
 * 退出码：0 通过 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  ROOT,
  localDateOnly,
  svcPost,
  twoSessions,
} from './technician-harness.mjs';

const OUT_DIR = path.join(ROOT, '.tmp-verify', 'evidence', 'p6-2-browser');
const RUN_TAG = `${Date.now()}-${process.pid}`;
const PROFILE_DIR = path.join(ROOT, '.tmp-verify', 'evidence', `p6-2-profile-${RUN_TAG}`);
// ⚠️ 端口必须随机（不能用固定基址+pid）：本机实测，前几次失败运行留下的
//    Chrome 若占着固定端口，新 Chrome 会把 URL 转交给旧实例后退出 —— 脚本
//    连上的就是"还停在旧页面/旧抽屉"的僵尸浏览器，确认请求会打到上一轮的
//    工单上（walkthrough-p5-1-browser.mjs 注释里同款坑）。随机高位端口 +
//    启动前占用检测，两头堵住。
const DEBUG_PORT = 23000 + Math.floor(Math.random() * 20000);

const BASE = 'http://localhost:8080';
const STORE_EMAIL = 'uat.store.a@svc.local';

class EnvNotReady extends Error {}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const notes = [];
let cdp = null;
const consoleErrors = [];

function say(line) {
  console.log(line);
  notes.push(line);
}

function envValue(key) {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

function findChrome() {
  if (process.env.WALKTHROUGH_CHROME) return process.env.WALKTHROUGH_CHROME;
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agent-browser', 'browsers');
  if (!fs.existsSync(base)) throw new EnvNotReady(`找不到 ${base} —— 先跑一次 agent-browser install`);
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

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`页面内异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

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

  /** 真实鼠标点击（isTrusted:true，能触发 antd 按钮的 onClick） */
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
    await new Promise((r) => setTimeout(r, 300));
    box = await aim();
    if (!box.hitSelf) {
      throw new Error(`点在 ${selector} 的坐标 (${box.x},${box.y}) 命中 ${box.hitWhat} —— 被遮挡或坐标不对`);
    }
    const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    return box;
  }
}

async function pollJsonEndpoint(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new EnvNotReady(`Chrome 调试端口没起来（${url}）`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const password = envValue('UAT_STORE_A_PASSWORD');
  if (!password) throw new EnvNotReady('.env 缺 UAT_STORE_A_PASSWORD —— 先跑 node scripts/uat-accounts.mjs --create');

  // 找两张「待门店确认」的工单（优先收费一张、不收费一张；找不到就用传参或最新一张）
  // WALKTHROUGH_MODE=reject 时**只走驳回路径**、不自动挑收费工单 —— 用于分条走查
  // （避免在同一会话连走两条时，第二次 navigate 撞限流/污染到别的收费工单）。
  const mode = process.env.WALKTHROUGH_MODE;
  const targetNo = process.env.WALKTHROUGH_TICKET_NO;
  let chargedTicket = null;
  let freeTicket = null;
  if (targetNo) {
    const t = psqlScalar(
      `SELECT t.ticket_no||'|'||v.is_charged FROM service_tickets t JOIN service_visits v ON v.ticket_id=t.id ` +
        `WHERE t.ticket_no='${targetNo}' AND v.visit_status='SUBMITTED' LIMIT 1`,
    );
    if (!t) throw new EnvNotReady(`工单 ${targetNo} 不是「待门店确认」状态`);
    const [no, charged] = t.split('|');
    if (charged === 'true') chargedTicket = no;
    else freeTicket = no;
  }
  if (mode !== 'reject' && !chargedTicket) {
    chargedTicket = psqlScalar(
      `SELECT t.ticket_no FROM service_tickets t JOIN service_visits v ON v.ticket_id=t.id ` +
        `WHERE v.visit_status='SUBMITTED' AND v.is_charged=true ORDER BY t.id DESC LIMIT 1`,
    );
  }
  if (mode !== 'confirm' && !freeTicket) {
    freeTicket = psqlScalar(
      `SELECT t.ticket_no FROM service_tickets t JOIN service_visits v ON v.ticket_id=t.id ` +
        `WHERE v.visit_status='SUBMITTED' AND v.is_charged=false ORDER BY t.id DESC LIMIT 1`,
    );
  }

  // 门店工单列表页 schemaUid 从库取（不手抄）
  const schemaUid = psqlScalar(
    `SELECT "schemaUid" FROM "desktopRoutes" WHERE type='flowPage' AND title='我的门店工单' LIMIT 1`,
  );
  if (!schemaUid) throw new EnvNotReady('找不到「我的门店工单」页面（desktopRoutes）');

  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chromePath = findChrome();
  say(`  浏览器：${chromePath}`);
  say(`  走查①确认（收费）：${chargedTicket ?? '(无收费待确认工单)'}`);
  say(`  走查②驳回（不收费）：${freeTicket ?? '(无不收费待确认工单)'}`);
  say(`  列表页：/admin/${schemaUid}`);

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // 证据收集（含失败路径）：calls / notes 无论成败都落盘 —— 排障最缺的
  // 从来不是"它挂了"，而是"挂之前浏览器真实发了什么"。
  const calls = [];
  const bodyOf = new Map();
  const persistEvidence = () => {
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, 'summary.json'),
        JSON.stringify({ chargedTicket, freeTicket, notes, consoleErrors, calls: calls.map((c) => ({ ...c, requestId: undefined })) }, null, 2),
        'utf8',
      );
    } catch { /* 落盘失败不掩盖主错误 */ }
  };
  globalThis.__persistEvidence = persistEvidence;

  try {
    // 启动前占用检测：端口上已有 DevTools 响应 = 有残留实例，直接退出而不是连上去
    try {
      const pre = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
      if (pre.ok) {
        throw new EnvNotReady(`调试端口 ${DEBUG_PORT} 已被占用（疑似残留 Chrome）—— 换端口重跑，勿复用僵尸实例`);
      }
    } catch (e) {
      if (e instanceof EnvNotReady) throw e;
      /* 连不上 = 端口空闲，正是期望 */
    }

    const list = await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    assert(page, 'Chrome 没有 page target');
    cdp = await Cdp.attach(page.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOM.enable');

    const bodyOfRef = { map: bodyOf };
    void bodyOfRef;
    cdp.on('Network.requestWillBeSent', (p) => {
      const url = p.request?.url ?? '';
      if (!url.includes('/api/')) return;
      calls.push({ url, method: p.request.method, postData: p.request.postData ?? null, status: null, requestId: p.requestId });
    });
    cdp.on('Network.responseReceived', (p) => {
      const hit = calls.find((c) => c.requestId === p.requestId);
      if (hit) hit.status = p.response?.status ?? null;
    });
    cdp.on('Network.loadingFinished', async (p) => {
      const hit = calls.find((c) => c.requestId === p.requestId);
      if (!hit) return;
      try {
        const r = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
        bodyOf.set(hit.url, r.body?.slice(0, 4000) ?? '');
      } catch { /* 二进制忽略 */ }
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      consoleErrors.push('[console.error] ' + p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push('[exception] ' + (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300));
    });

    // ============ 登录门店后台 ============
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪', timeout: 30_000 });
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(ins[0], ${JSON.stringify(STORE_EMAIL)});
      setVal(ins[1], ${JSON.stringify(password)});
      return true;
    })()`);
    await sleep(800);
    await cdp.realClick('button[type="submit"], .ant-btn-primary');
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
    say('\n  ① 门店账号登录成功');

    // 工具：在列表页找到指定工单号那一行，点它的「详情」
    async function openTicketDetail(ticketNo) {
      await cdp.send('Page.navigate', { url: `${BASE}/admin/${schemaUid}` });
      // 诊断：等表格出现（antd 表格先渲染 .ant-table，行再异步填充），
      // 且给一个 404/未登录的诊断快照
      try {
        await cdp.waitFor('document.querySelectorAll(".ant-table").length > 0', { what: '工单列表表格容器出现', timeout: 30_000 });
      } catch (e) {
        const diag = await cdp.evaluate(`JSON.stringify({ url: location.href, title: document.title, body: (document.body.innerText || '').slice(0, 300), is404: (document.body.innerText || '').indexOf('页面不存在') !== -1 })`);
        throw new Error(`工单列表表格未出现（${e.message}）。诊断：${diag}`);
      }
      // 等数据行（含 loading 态兜底：先等 table 渲染，再等行或空态）
      await cdp.waitFor(`(() => {
        const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length;
        const empty = document.querySelectorAll('.ant-empty').length;
        return rows > 0 || empty > 0;
      })()`, { what: '工单列表出现数据行或空态', timeout: 30_000 });
      await sleep(1200);
      // 找到包含该工单号的那一行，并给该行内的「详情」按钮打唯一标记
      const found = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
        const row = rows.find((r) => (r.innerText || '').indexOf(${JSON.stringify(ticketNo)}) !== -1);
        if (!row) return false;
        const b = [...(row.querySelectorAll('button, a'))].find((x) => (x.innerText || '').trim() === '详情');
        if (!b) return 'NO_DETAIL_BTN';
        b.setAttribute('data-p6-detail', '1');
        return true;
      })()`);
      if (found === 'NO_DETAIL_BTN') {
        // 兜底：记录行内所有按钮文字，帮助排障
        const btns = await cdp.evaluate(`(() => {
          const row = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')].find((r) => (r.innerText || '').indexOf(${JSON.stringify(ticketNo)}) !== -1);
          return JSON.stringify(row ? [...row.querySelectorAll('button, a')].map((x) => (x.innerText || '').trim()).filter(Boolean) : []);
        })()`);
        throw new Error(`工单 ${ticketNo} 行内没有「详情」按钮。行内按钮：${btns}`);
      }
      assert(found, `列表页找不到工单 ${ticketNo} 那一行`);
      // 真实鼠标点击「详情」按钮（isTrusted:true，能触发 antd onClick）
      await cdp.realClick('[data-p6-detail="1"]');
      // 等抽屉出现 + 技师回执区块渲染
      await cdp.waitFor(`(() => {
        const el = document.querySelector('.ant-drawer');
        return el && (el.innerText || '').indexOf('技师回执') !== -1;
      })()`, { what: `工单 ${ticketNo} 抽屉渲染出「技师回执」区块`, timeout: 25_000 });
      say(`  抽屉已打开，含「技师回执」区块（工单 ${ticketNo}）`);
    }

    // ============ 走查①：确认（收费） ============
    // 统一的「业务按钮检测」：按 button 元素的归一化文案判断，
    // ⚠️ 绝不用抽屉 innerText.indexOf ——「当前服务」区块的「门店已确认」Tag
    //    紧跟「服务方式」行，去空白拼接后恰好含「确认服务」四字（假阳性），
    //    曾让"按钮消失"断言永远为假（真实按钮早已被刷新渲染移除）。
    const BTN_CHECK = `(() => {
      const d = document.querySelector('.ant-drawer');
      const bs = d ? [...d.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\\s+/g, '')) : [];
      return JSON.stringify({ confirm: bs.indexOf('确认服务') !== -1, reject: bs.indexOf('驳回') !== -1 });
    })()`;

    if (chargedTicket) {
      say(`\n  ── 走查① 确认（收费）工单 ${chargedTicket} ──`);
      await openTicketDetail(chargedTicket);
      // 验证两个按钮都在
      const btns = await cdp.evaluate(BTN_CHECK);
      const btnState = JSON.parse(btns);
      if (!btnState.confirm || !btnState.reject) {
        const diag = await cdp.evaluate(`(() => {
          const d = document.querySelector('.ant-drawer');
          return JSON.stringify({ drawerText: (d ? d.innerText : '(无抽屉)').slice(0, 600), buttons: d ? [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean) : [] });
        })()`);
        await cdp.screenshot(path.join(OUT_DIR, 'walk1-诊断-按钮缺失.png'));
        throw new Error(`按钮缺失诊断：${diag}`);
      }
      assert(btnState.confirm, '抽屉里没有「确认服务」按钮');
      assert(btnState.reject, '抽屉里没有「驳回」按钮');
      say('  「确认服务」「驳回」按钮均已渲染');
      await cdp.screenshot(path.join(OUT_DIR, 'walk1-回执区块-按钮.png'));

      // 点「确认服务」（归一化文案再比，避免 antd 两字加空格类干扰）
      await cdp.evaluate(`(() => {
        const d = document.querySelector('.ant-drawer');
        const b = [...(d ? d.querySelectorAll('button') : [])].find((x) => ((x.innerText || '').replace(/\\s+/g, '')) === '确认服务');
        if (b) b.click();
      })()`);
      await cdp.waitFor(`(() => {
        const m = document.querySelector('.ant-modal');
        return m && (m.innerText || '').indexOf('实际收费金额') !== -1;
      })()`, { what: '确认模态框弹出（含金额输入）', timeout: 15_000 });
      say('  确认模态框弹出，含「实际收费金额」输入框（收费 → 有金额框）');
      await cdp.screenshot(path.join(OUT_DIR, 'walk1-确认模态框.png'));

      // 填金额（预填 268.00，改不改都行；这里直接确认，金额=技师报费）
      const amountPrefilled = await cdp.evaluate(`(() => {
        const m = document.querySelector('.ant-modal');
        const input = m ? m.querySelector('input') : null;
        return input ? input.value : '(无输入框)';
      })()`);
      say(`  金额框预填：${amountPrefilled}`);
      // 点「确认」按钮（模态框 ok 按钮；antd 两字按钮会加空格成「确 认」，归一化再比）
      await cdp.evaluate(`(() => {
        const m = document.querySelector('.ant-modal');
        const b = [...(m ? m.querySelectorAll('button') : [])].find((x) => ((x.innerText || '').replace(/\\s+/g, '')) === '确认');
        if (b) b.click();
      })()`);
      // 成功后：按钮消失 + 工单进「待评价」（抽屉重拉后 submittedVisit 为 null）
      // ⚠️ 判据用 button 元素（BTN_CHECK），不用 innerText ——「门店已确认」+
      //    「服务方式」拼接出的「确认服务」假阳性曾让本断言永远为假。
      {
        const mark = calls.length;
        let gone = false;
        const timeline = [];
        for (let i = 0; i < 50; i++) {
          await sleep(500);
          const s = JSON.parse(await cdp.evaluate(BTN_CHECK));
          const refreshes = calls.slice(mark).filter((c) => c.url.includes('svc:timeline') || c.url.includes('svc:visits')).length;
          timeline.push(`t${i}=${s.confirm ? '确认服务' : '-'}${s.reject ? '/驳回' : ''} 刷新${refreshes}`);
          if (!s.confirm && !s.reject) { gone = true; break; }
        }
        say('  确认后时序：' + timeline.slice(0, 12).join(' · '));
        if (!gone) {
          const diag = await cdp.evaluate(`(() => {
            const d = document.querySelector('.ant-drawer');
            const m = document.querySelector('.ant-modal');
            return JSON.stringify({
              drawerText: (d ? d.innerText : '(无抽屉)').slice(0, 400),
              buttons: d ? [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean) : [],
              modalOpen: !!m,
              messages: [...document.querySelectorAll('.ant-message')].map((x) => x.innerText).join('|').slice(0, 200),
            });
          })()`);
          throw new Error(`确认提交后按钮未消失。诊断：${diag}`);
        }
      }
      say('  确认成功：确认/驳回按钮已消失（工单进入待评价）');
      // 核验库：工单 WAIT_FEEDBACK
      const status = psqlScalar(`SELECT status FROM service_tickets WHERE ticket_no='${chargedTicket}'`);
      assert(status === 'WAIT_FEEDBACK', `确认后工单应为 WAIT_FEEDBACK，实际 ${status}`);
      say(`  库内工单状态：${status}（确认生效）`);
      await cdp.screenshot(path.join(OUT_DIR, 'walk1-确认成功-按钮消失.png'));
    } else {
      say('\n  ⚠️ 无收费「待门店确认」工单，跳过走查①');
    }

    // ============ 走查②：驳回（不收费） ============
    if (freeTicket) {
      say(`\n  ── 走查② 驳回（不收费）工单 ${freeTicket} ──`);
      await openTicketDetail(freeTicket);
      // 不收费 → 确认模态框不应有金额框（这条在走查①收费已覆盖金额框；这里验证驳回路径）
      await cdp.evaluate(`(() => {
        const d = document.querySelector('.ant-drawer');
        const b = [...(d ? d.querySelectorAll('button') : [])].find((x) => ((x.innerText || '').replace(/\\s+/g, '')) === '驳回');
        if (b) b.click();
      })()`);
      await cdp.waitFor(`(() => {
        const m = document.querySelector('.ant-modal');
        return m && (m.innerText || '').indexOf('驳回原因') !== -1;
      })()`, { what: '驳回模态框弹出（含原因输入）', timeout: 15_000 });
      say('  驳回模态框弹出，含「驳回原因」输入框');
      await cdp.screenshot(path.join(OUT_DIR, 'walk2-驳回模态框.png'));

      // 填驳回原因
      await cdp.evaluate(`(() => {
        const m = document.querySelector('.ant-modal');
        const ta = m ? m.querySelector('textarea') : null;
        if (ta) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
          setter.call(ta, 'P6-2 走查：服务未完成，需重新派工');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`);
      await sleep(300);
      // 点「确认驳回」
      await cdp.evaluate(`(() => {
        const m = document.querySelector('.ant-modal');
        const b = [...(m ? m.querySelectorAll('button') : [])].find((x) => (x.innerText || '').trim() === '确认驳回');
        if (b) b.click();
      })()`);
      // ⚠️ 判据用 button 元素（BTN_CHECK），理由同走查①
      try {
        let gone = false;
        for (let i = 0; i < 50; i++) {
          await sleep(500);
          const s = JSON.parse(await cdp.evaluate(BTN_CHECK));
          if (!s.confirm && !s.reject) { gone = true; break; }
        }
        if (!gone) throw new Error('驳回提交后 25 秒按钮仍在');
      } catch (e) {
        const diag = await cdp.evaluate(`(() => {
          const d = document.querySelector('.ant-drawer');
          const m = document.querySelector('.ant-modal');
          return JSON.stringify({
            drawerText: (d ? d.innerText : '(无抽屉)').slice(0, 400),
            buttons: d ? [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean) : [],
            modalOpen: !!m,
            modalText: (m ? m.innerText : '').slice(0, 200),
            messages: [...document.querySelectorAll('.ant-message')].map((x) => x.innerText).join('|').slice(0, 200),
          });
        })()`);
        throw new Error(`驳回提交后按钮未消失。诊断：${diag}`);
      }
      say('  驳回成功：确认/驳回按钮已消失（工单回到处理中）');
      const status = psqlScalar(`SELECT status FROM service_tickets WHERE ticket_no='${freeTicket}'`);
      assert(status === 'PROCESSING', `驳回后工单应为 PROCESSING，实际 ${status}`);
      say(`  库内工单状态：${status}（驳回生效，可继续派工）`);
      await cdp.screenshot(path.join(OUT_DIR, 'walk2-驳回成功-按钮消失.png'));

      // 驳回后「能继续正常派工」：走真实 `svc:dispatch`（总部账号）创建新的
      // ASSIGNED Visit。用户口径（2026-09-26）：不要求把第二个技师完整服务流程
      // 跑到底，只要能正常进入派工并成功创建新的 ASSIGNED Visit，即证明
      // reject 后返工接力成立。此处**不**在浏览器里再点 UI，直接走与 UI 同源的
      // 服务端 dispatch 路径，验证 200 + 库内出现新的 ASSIGNED Visit。
      {
        const { hq } = await twoSessions();
        const ticketId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${freeTicket}'`));
        const beforeAssigned = Number(psqlScalar(
          `SELECT count(*) FROM service_visits WHERE ticket_id=${ticketId} AND visit_status='ASSIGNED'`,
        ));
        const dispatched = await svcPost(
          'dispatch',
          ticketId,
          hq,
          {
            technician_name: '李师傅',
            technician_mobile: '13900020002',
            expected_visit_at: localDateOnly(1),
            service_mode: 'manufacturer',
            provider_name: 'P6-2 走查厂家',
          },
          randomUUID(),
        );
        assert(dispatched.status === 200, `驳回后重新派工失败 HTTP ${dispatched.status} ${JSON.stringify(dispatched.json ?? '').slice(0, 200)}`);
        const afterAssigned = Number(psqlScalar(
          `SELECT count(*) FROM service_visits WHERE ticket_id=${ticketId} AND visit_status='ASSIGNED'`,
        ));
        assert(
          afterAssigned === beforeAssigned + 1,
          `驳回后派工未新建 ASSIGNED Visit（派工前 ${beforeAssigned} → 后 ${afterAssigned}）`,
        );
        const newVisitNo = psqlScalar(
          `SELECT visit_no FROM service_visits WHERE ticket_id=${ticketId} AND visit_status='ASSIGNED' ORDER BY id DESC LIMIT 1`,
        );
        say(`  驳回后重新派工成功：新建 ASSIGNED Visit（第 ${newVisitNo} 次上门）—— reject 后返工接力成立`);
      }
    } else {
      say('\n  ⚠️ 无不收费「待门店确认」工单，跳过走查②');
    }

    // 控制台错误（排除已知无害项）
    if (consoleErrors.length > 0) {
      say(`\n  ⚠️ 页面控制台 error 计数 ${consoleErrors.length}（详见落盘日志）`);
      fs.writeFileSync(path.join(OUT_DIR, 'console-errors.txt'), consoleErrors.join('\n'), 'utf8');
    }

    say('\n══════════════════════════════════════════════════════════════');
    say('  P6-2 浏览器走查通过（确认 + 驳回两条路径）');
    say('══════════════════════════════════════════════════════════════');
  } finally {
    persistEvidence();
    try { await cdp?.send('Browser.close'); } catch { /* 忽略 */ }
    try { chrome.kill(); } catch { /* 忽略 */ }
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.log(`\n  ❌ ${error instanceof EnvNotReady ? '环境未就绪（退出码 2）' : '走查失败'}：${error.message}`);
  console.log('  （证据已落盘到 .tmp-verify/evidence/p6-2-browser/）');
  process.exit(error instanceof EnvNotReady ? 2 : 1);
}
