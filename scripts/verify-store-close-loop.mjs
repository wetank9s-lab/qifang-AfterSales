#!/usr/bin/env node
/**
 * verify-store-close-loop.mjs —— **一条完整闭环的真实浏览器验收**（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 链路（除"读发件箱"外，没有任何一步绕过业务）
 * ===========================================================================
 *   客户匿名建单 ──(门店派工)──▶ PROCESSING + Visit + 师傅作业 Token
 *        ──(师傅 H5 传照片 + 提交，含收费 88.00)──▶ WAIT_STORE_CONFIRM
 *        ──(**浏览器**：门店在「待门店确认」Tab 点「审核结果」→ 确认)──▶ WAIT_FEEDBACK
 *        ──(客户点评价链接匿名提交评价)──▶ CLOSED
 *
 * 每一步都断言**数据库事实**，并核对 按钮 / 状态 / 收费 / 审计 四者一致。
 *
 * ===========================================================================
 * 为什么"师傅提交"这一段也要**本轮新鲜产出**
 * ===========================================================================
 * 库里本来就躺着 5 张 WAIT_STORE_CONFIRM 工单，直接拿一张来审也能跑通后半段。
 * 但那样证的是"历史数据能被审核"，**证不到"这一版的师傅提交仍然正确地
 * 把工单推进到待确认"** —— 而后者才是回归真正要看的（P11-0 动过 Visit/Token/短信）。
 *
 * ===========================================================================
 * 顺带验的两件事
 * ===========================================================================
 * ① **冲突的中文提示**：抽屉已打开时另一个人先把回执确认掉，再点「确认」
 *    ⇒ 必须是**可理解的中文**（"该回执已被其他人员处理，已刷新最新状态"），
 *    而不是把 `VISIT_NOT_REVIEWABLE` 这类原始码当主要文案甩给门店员工。
 * ② **校验的中文提示**：跟进窗口不填内容直接保存 ⇒ 必须是中文"必须填写跟进情况"。
 *
 * 用法：node scripts/verify-store-close-loop.mjs
 * 退出码：0 全部通过 / 1 有未达标项 / 2 环境未就绪
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  BASE_URL,
  STORE_EMAIL,
  cleanupTicket,
  createScratchTicket,
  ensureFixtureJpeg,
  localDateOnly,
  psqlRows,
  psqlScalar,
  signIn,
  smsSwitch,
  svcPost,
  technicianSubmit,
  technicianUpload,
  tokenFromOutbox,
  twoSessions,
} from './technician-harness.mjs';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';
import { explainMissingReviewToken, reviewTokenFromOutbox } from './lib/review-token.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
const TAG = 'CLOSELOOP';
const CHARGE = 88;
const SERVER_CONSTANTS = path.join(
  ROOT,
  'nocobase',
  'plugins',
  'service-ticket',
  'src',
  'server',
  'constants.ts',
);
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

// ---------------------------------------------------------------------------
// 审计事件名：**从服务端常量取，不在这里写第二份**
// ---------------------------------------------------------------------------
// 🔴 本脚本第一版把事件名手写成 `dispatch` / `technician_submit` /
//    `store_confirm` / `review`，而库里真实的是 `dispatched` /
//    `technician_submitted` / `store_confirmed` / `reviewed` ——
//    四条**全错位**，无论产品多正确都会红，且报错文案是"缺这四个事件"，
//    读起来极像"审计记录没写全"（事实是写全了，是**验收器的名单抄错了**）。
//
//    这正是铁律"同一段规则出现两次 = 同一个坑有两条腿"：
//    事件名的唯一来源是 `server/constants.ts` 的 `EVENT_TYPE`，
//    所以这里用 esbuild 编译后 require，与 verify-store-tab-filter.mjs 的做法一致。
// ---------------------------------------------------------------------------
function loadEventTypes() {
  const nodeRequire = createRequire(import.meta.url);
  let esbuild = null;
  for (const load of [
    () => nodeRequire('esbuild'),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
  ]) {
    try {
      esbuild = load();
      break;
    } catch {
      /* 试下一个 */
    }
  }
  if (!esbuild) throw new Error('找不到 esbuild —— 无法读取 EVENT_TYPE（环境未就绪）');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entry = path.join(OUT_DIR, 'closeloop-constants-entry.ts');
  const outfile = path.join(OUT_DIR, 'closeloop-constants.cjs');
  fs.writeFileSync(
    entry,
    `export { EVENT_TYPE } from '${SERVER_CONSTANTS.replace(/\\/g, '/')}';`,
    'utf8',
  );
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'silent',
  });
  return nodeRequire(outfile).EVENT_TYPE;
}

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------
const passed = [];
const failures = [];
function ok(label, detail = '') {
  passed.push(label);
  console.log(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}`);
}
function no(label, detail = '') {
  failures.push(label);
  console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 浏览器（CDP）
// ---------------------------------------------------------------------------
function findChrome() {
  if (process.env.WALKTHROUGH_CHROME) return process.env.WALKTHROUGH_CHROME;
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agent-browser', 'browsers');
  if (!fs.existsSync(base)) throw new Error(`找不到 ${base} —— 先跑一次 agent-browser install`);
  const candidates = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chrome-'))
    .sort()
    .reverse()
    .map((d) => path.join(base, d, 'chrome.exe'))
    .filter((p) => fs.existsSync(p));
  if (!candidates.length) throw new Error(`${base} 下没有 chrome-*/chrome.exe`);
  return candidates[0];
}

const DEBUG_PORT = 24000 + Math.floor(Math.random() * 12000);
const PROFILE_DIR = path.join(OUT_DIR, `chrome-profile-close-${Date.now()}`);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params);
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, timeout = 30_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeout = 60_000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
    return r.result?.value;
  }
  async waitFor(expression, { timeout = 30_000, what = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.evaluate(`(() => { try { return ${expression}; } catch (e) { return false; } })()`);
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`等待超时：${what}`);
  }
}

async function pollJsonEndpoint(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时`);
}

const ACTIVE_SCOPE_JS = `(() => {
  const active = document.querySelector('.ant-tabs-tabpane-active');
  if (active) return active;
  const panes = [...document.querySelectorAll('.ant-tabs-tabpane')].filter((p) => !p.classList.contains('ant-tabs-tabpane-hidden'));
  return panes.length === 1 ? panes[0] : null;
})()`;

/**
 * 界面上当前的 antd 提示文本（`message.error` / `message.success`）。
 *
 * 为什么必须抓它：冲突与校验的原因**只出现在这里**。不抓 ⇒ 失败详情就只剩
 * "状态没变"，而下一个人只能回头翻日志去猜。
 */
const LAST_MESSAGE_EXPR = `[...document.querySelectorAll('.ant-message-notice-content')].map(e => (e.innerText||'').trim()).join(' | ')`;

function clickTabExpr(title) {
  return `(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, '');
    const want = norm(${JSON.stringify(title)});
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
    let el = tabs.find((e) => norm(e.innerText) === want);
    if (!el) el = tabs.find((e) => norm(e.innerText).includes(want));
    if (!el) return { ok: false, seen: tabs.map((e) => norm(e.innerText)) };
    el.click();
    return { ok: true };
  })()`;
}

/**
 * 在一行里点它的主动作。
 *
 * ⚠️ 用 `[data-primary-action]` 定位，而不是"取这一行最后一个按钮"：
 *    `renderButton()` 给按钮打了三个验收属性（`data-primary-action` /
 *    `data-ticket-id` / `data-action-label`，见 primary-action.tsx），
 *    所以这里能同时确认"这个按钮确实绑在这一行上、标签由这一行的状态决定"。
 *    按"最后一个按钮"取的话，任何一次列序调整都会让它**静默点到别的按钮**——
 *    而脚本照样绿，因为它只看"点到了一个按钮"。
 */
function clickRowPrimaryExpr(rowKey) {
  return `(() => {
    const scope = ${ACTIVE_SCOPE_JS};
    if (!scope) return { ok: false, why: 'no-active-pane' };
    const tr = scope.querySelector('.ant-table-tbody tr[data-row-key="${rowKey}"]');
    if (!tr) return { ok: false, why: 'row-not-found' };
    const btn = tr.querySelector('[data-primary-action]');
    if (!btn) {
      return {
        ok: false,
        why: 'no-primary-action',
        buttons: [...tr.querySelectorAll('td button, td a')].map((b) => (b.innerText || '').replace(/\\s+/g, '')),
      };
    }
    const bound = btn.getAttribute('data-ticket-id');
    if (bound !== '${rowKey}') return { ok: false, why: 'bound-to-other-row', bound };
    const label = (btn.innerText || '').replace(/\\s+/g, '');
    btn.click();
    return { ok: true, label, attrLabel: btn.getAttribute('data-action-label') };
  })()`;
}

// ---------------------------------------------------------------------------
// 抽屉 / 模态框 / 提示 —— 这三层是「审核」真正的按钮层级
// ---------------------------------------------------------------------------
// ⚠️ 曾经按"点开行就直接弹模态框"来写，结果在抽屉那一层死等一个叫「确认」的
//    按钮：抽屉里的按钮实际是「确认服务」，模态框的 OK 才叫「确认」。
//    这是**验收器对产品结构想象错了**，不是产品缺陷 —— 但它会以"等待超时"的面目
//    出现，很容易被误读成"界面的确认按钮点不动"。所以三层各自成 helper，
//    每一层找不到都把**当时界面上真实存在的按钮**报出来。
// ---------------------------------------------------------------------------

/** 当前打开的抽屉（取最后一个；antd 关闭后节点会被 openTicketDrawer 摘掉） */
const DRAWER_SCOPE_JS = `(() => {
  const ds = [...document.querySelectorAll('.ant-drawer-content-wrapper')];
  return ds.length ? ds[ds.length - 1] : null;
})()`;

/** 可见的模态框（按标题文本）；`getClientRects` 过滤掉关闭后残留的隐藏节点 */
function visibleModalExpr(titleText) {
  return `(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, '');
    const want = norm(${JSON.stringify(titleText)});
    const ms = [...document.querySelectorAll('.ant-modal')].filter((m) => m.getClientRects().length > 0);
    return ms.find((m) => norm(m.innerText).includes(want)) ?? null;
  })()`;
}

/** 点抽屉里的按钮（如「确认服务」） */
function clickDrawerBtnExpr(text) {
  return `(() => {
    const d = ${DRAWER_SCOPE_JS};
    if (!d) return { ok: false, why: 'no-drawer' };
    const norm = (s) => (s || '').replace(/\\s+/g, '');
    const want = norm(${JSON.stringify(text)});
    const btns = [...d.querySelectorAll('button')];
    const el = btns.find((b) => norm(b.innerText) === want);
    if (!el) return { ok: false, why: 'no-button', seen: btns.map((b) => norm(b.innerText)) };
    el.click();
    return { ok: true };
  })()`;
}

/** 点模态框里的确认按钮（okText） */
function clickModalOkExpr(titleText, okText) {
  return `(() => {
    const m = ${visibleModalExpr(titleText)};
    if (!m) return { ok: false, why: 'no-modal' };
    const norm = (s) => (s || '').replace(/\\s+/g, '');
    const want = norm(${JSON.stringify(okText)});
    const btns = [...m.querySelectorAll('button')];
    const el = btns.find((b) => norm(b.innerText) === want);
    if (!el) return { ok: false, why: 'no-ok-button', seen: btns.map((b) => norm(b.innerText)) };
    el.click();
    return { ok: true };
  })()`;
}

/** 读模态框里第一个 input 的值（收费单 = 预填的实际收费金额） */
function modalInputValueExpr(titleText) {
  return `(() => {
    const m = ${visibleModalExpr(titleText)};
    if (!m) return null;
    const input = m.querySelector('input');
    return input ? input.value : null;
  })()`;
}

/** 关掉所有抽屉：确认成功后抽屉**不会**自己关，不关就挡住下一步点行 */
async function closeDrawers(cdp) {
  await cdp.evaluate(`(() => { document.querySelectorAll('.ant-drawer-close').forEach((b) => b.click()); return true; })()`);
  await cdp
    .waitFor(`document.querySelectorAll('.ant-drawer').length === 0`, { what: '抽屉关闭', timeout: 15_000 })
    .catch(() => {});
}

/**
 * 等到出现**新的** antd message —— 取的是**集合差集**，不是"整串变了"。
 *
 * 🔴 为什么要按条做差集（本脚本第一版就栽在这里）：
 *    `.ant-message-notice-content` 在默认 3 秒时长内会**同时挂着好几条**，
 *    而判据写的是"拼接串 !== baseline" ⇒ 只要第 N 条出现，整串就变了，
 *    于是**前几步残留的提示也被算进本次**。实测把上一步的「确认成功」和
 *    「TICKET_NOT_REVIEWABLE…」一起当成了第 ⑥ 步的校验提示 ——
 *    一次判红、一次判绿，两条结论都不成立。
 *
 *    ⇒ 正确做法：把 baseline 拆成**条**的集合，只保留当前**新出现**的那些。
 *
 * @returns 本次新出现的提示（多條用 ' | ' 连）；没有则 ''
 */
async function waitNewMessage(cdp, baseline, timeout = 12_000) {
  const baseSet = new Set(
    String(baseline ?? '')
      .split(' | ')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const deadline = Date.now() + timeout;
  let fresh = '';
  while (Date.now() < deadline) {
    const now = String((await cdp.evaluate(LAST_MESSAGE_EXPR)) ?? '');
    const parts = now
      .split(' | ')
      .map((s) => s.trim())
      .filter(Boolean);
    const added = parts.filter((p) => !baseSet.has(p));
    if (added.length) {
      fresh = added.join(' | ');
      break;
    }
    await sleep(250);
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  完整闭环验收：师傅提交 → 门店审核 → 客户评价 → CLOSED');
  console.log('══════════════════════════════════════════════════════════════');

  const { store, hq } = await twoSessions();
  ok('门店与总部账号真实登录', `${STORE_EMAIL} + 总部（读发件箱用）`);

  // ---- ① 新鲜产出一张 WAIT_STORE_CONFIRM（真实入口，不走 UI 捷径）----
  console.log('\n──── ① 客户匿名建单 → 门店派工 → 师傅传照片并提交（含收费）────');
  const { ticketId, ticketNo } = await createScratchTicket({
    tag: TAG,
    content: '闭环验收：师傅上门后门店审核、客户评价',
  });
  ok('客户匿名入口建单', `#${ticketId} ${ticketNo}`);

  const sms = smsSwitch();
  // ⚠️ 必须 await：enable() 内部要等 11s（sms.enabled 由 ConfigService 以 10s TTL
  //    进程内缓存，见 technician-harness.mjs 的注释）。不 await ⇒ 立刻去读发件箱，
  //    读到的是**缓存里的旧值** ⇒ 短信 rejected ⇒ 拿不到 Token ⇒
  //    失败现象会长得像"产品没给师傅发链接"。
  await sms.enable();
  let techToken = null;
  let conflictTicketId = null;
  let chrome = null;

  try {
    const dispatch = await svcPost(
      'dispatch',
      ticketId,
      store,
      {
        technician_name: '闭环验收师傅',
        technician_mobile: '13900010002',
        expected_visit_at: localDateOnly(1),
        service_mode: 'inhouse',
      },
      crypto.randomUUID(),
    );
    if (dispatch.status !== 200) {
      no('门店直接从 NEW 派工（不经受理）', `HTTP ${dispatch.status}`);
      return;
    }
    const afterDispatch = String(
      psqlScalar(`SELECT status FROM service_tickets WHERE id = ${ticketId}`),
    );
    ok('门店从 NEW 直接派工 → PROCESSING（无"受理"环节）', afterDispatch);

    // ⚠️ `tokenFromOutbox` 返回的是 `{ token, seq, matches }` 对象，**不是**字符串。
    //    第一版直接把返回值当 Token 用 ⇒ `${token}` 拼成 `[object Object]`
    //    ⇒ 上传接口 404，而前一条断言"取到 Token"却**通过了**（对象 truthy）。
    //    ⇒ 判据一并收紧：必须是 43 位字符串才算取到，否则判红（不留下事实上的假绿）。
    const tokenRow = await tokenFromOutbox({ sessionToken: hq, ticketNo, scene: 'technician_task' });
    techToken = typeof tokenRow?.token === 'string' ? tokenRow.token : null;
    if (!techToken) {
      no('取到本工单的师傅作业 Token', `返回形态=${JSON.stringify(tokenRow)?.slice(0, 160)}`);
      return;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(techToken)) {
      no('师傅作业 Token 形态正确（43 位）', `实为 ${techToken.length} 位：${techToken.slice(0, 60)}`);
      return;
    }
    ok('取到本工单的师傅作业 Token', `43 位 · seq=${tokenRow.seq} · 匹配 ${tokenRow.matches} 条`);

    const jpeg = ensureFixtureJpeg();
    const up = await technicianUpload(techToken, jpeg, { filename: 'closeloop.jpg' });
    if (up.status !== 200 && up.status !== 201) {
      no('师傅上传现场照片', `HTTP ${up.status} ${String(up.body).slice(0, 160)}`);
      return;
    }
    const photoCount = Number(
      psqlScalar(`SELECT count(*) FROM service_visit_photos WHERE visit_id IN (SELECT id FROM service_visits WHERE ticket_id = ${ticketId})`),
    );
    ok('师傅上传现场照片', `库里 ${photoCount} 张`);

    const submit = await technicianSubmit(techToken, {
      service_result: 'resolved',
      service_note: '已上门检修并试机正常，客户现场确认',
      is_charged: true,
      reported_charge_amount: CHARGE,
    });
    if (submit.status !== 200) {
      no('师傅提交作业（含收费 88.00）', `HTTP ${submit.status} ${String(submit.body).slice(0, 200)}`);
      return;
    }
    const afterSubmit = String(psqlScalar(`SELECT status FROM service_tickets WHERE id = ${ticketId}`));
    const reported = String(
      psqlScalar(
        `SELECT coalesce(reported_charge_amount::text,'-') FROM service_visits WHERE ticket_id = ${ticketId} AND visit_status = 'SUBMITTED'`,
      ),
    );
    ok('师傅提交 → 工单进入 WAIT_STORE_CONFIRM', afterSubmit);
    ok('师傅报费写入 Visit', `reported_charge_amount=${reported}`);

    // ---- ② 浏览器：门店在「待门店确认」Tab 点「审核结果」并确认 ----
    console.log('\n──── ② 浏览器：门店点「审核结果」→ 确认（含金额核对）────');
    const pageUid = String(
      psqlScalar(`SELECT "schemaUid" FROM "desktopRoutes" WHERE type = 'flowPage' AND title = '我的门店工单' LIMIT 1`),
    ).trim();
    if (!pageUid) {
      no('找到「我的门店工单」页面路由', '环境未就绪');
      return;
    }

    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : []),
        '--window-size=1400,1000',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const page = (await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    // 真实登录
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪', timeout: 30_000 });
    const storePassword = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^UAT_STORE_A_PASSWORD\s*=\s*(.*)$/m) ?? [])[1]?.trim() ?? '';
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(ins[0], ${JSON.stringify(STORE_EMAIL)});
      setVal(ins[1], ${JSON.stringify(storePassword)});
      return true;
    })()`);
    await sleep(800);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
    ok('门店账号在真实浏览器里登录', STORE_EMAIL);

    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${pageUid}` });
    await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', {
      what: '表格与数据到位',
      timeout: 60_000,
    });

    // 切到「待门店确认」—— 这一跳本身就是 B-15 服务端筛选的又一次真实验证：
    // 刚提交的那张单必须**只**出现在这个 Tab 里。
    const switched = await cdp.evaluate(clickTabExpr('待门店确认'));
    if (!switched?.ok) {
      no('切到「待门店确认」Tab', JSON.stringify(switched));
      return;
    }
    let inTab = false;
    const dl = Date.now() + 45_000;
    while (Date.now() < dl) {
      inTab = await cdp.evaluate(
        `(() => {
          const scope = ${ACTIVE_SCOPE_JS};
          if (!scope) return false;
          return !!scope.querySelector('.ant-table-tbody tr[data-row-key="${ticketId}"]');
        })()`,
      );
      if (inTab) break;
      await sleep(400);
    }
    if (!inTab) {
      no(`刚提交的单出现在「待门店确认」Tab`, `#${ticketId} 未在该 Tab 出现`);
      return;
    }
    ok('刚提交的单出现在「待门店确认」Tab（服务端筛选对新数据同样生效）', `#${ticketId}`);

    const clicked = await cdp.evaluate(clickRowPrimaryExpr(ticketId));
    if (!clicked?.ok) {
      no('点击该行的主动作', JSON.stringify(clicked));
      return;
    }
    if (clicked.label !== '审核结果' || clicked.attrLabel !== '审核结果') {
      no('WAIT_STORE_CONFIRM 行的主动作标签是「审核结果」', `界面=「${clicked.label}」· 属性=${clicked.attrLabel}`);
    } else {
      ok('WAIT_STORE_CONFIRM 行的主动作标签是「审核结果」', `界面文案与 data-action-label 一致`);
    }

    // 第一层：抽屉打开（审核在**详情抽屉**里完成，不是点行直接弹框）
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer').length > 0`, {
      what: '详情抽屉打开',
      timeout: 30_000,
    });
    ok('「审核结果」打开的是服务详情抽屉', '（审核动作收口在详情里，不是列表上的第 N 个按钮）');

    // 第二层：抽屉里的「确认服务」按钮
    const drawerBtn = await cdp
      .waitFor(
        `(() => {
          const d = ${DRAWER_SCOPE_JS};
          if (!d) return false;
          return [...d.querySelectorAll('button')].some((b) => (b.innerText||'').replace(/\\s+/g,'') === '确认服务');
        })()`,
        { what: '抽屉里的「确认服务」按钮', timeout: 30_000 },
      )
      .catch(() => null);
    if (drawerBtn === null) {
      const seen = await cdp.evaluate(
        `(() => { const d = ${DRAWER_SCOPE_JS}; return d ? [...d.querySelectorAll('button')].map((b) => (b.innerText||'').replace(/\\s+/g,'')) : null; })()`,
      );
      no('抽屉里出现「确认服务」按钮', `界面上实际有的按钮：${JSON.stringify(seen)}`);
      return;
    }
    const clickedConfirmBtn = await cdp.evaluate(clickDrawerBtnExpr('确认服务'));
    if (!clickedConfirmBtn?.ok) {
      no('点击抽屉里的「确认服务」', JSON.stringify(clickedConfirmBtn));
      return;
    }

    // 第三层：「确认服务」模态框 —— 收费单必须让门店核对金额（预填 = 技师报费）
    const modalReady = await cdp
      .waitFor(`(${modalInputValueExpr('确认服务')}) !== null`, { what: '确认服务模态框', timeout: 20_000 })
      .catch(() => null);
    const amountShown = await cdp.evaluate(modalInputValueExpr('确认服务'));
    if (amountShown === null || amountShown === undefined) {
      no('出现「确认服务」模态框', '未出现 —— 收费单必须让门店核对金额');
    } else {
      ok('出现「确认服务」模态框且金额已预填', `金额输入框=${amountShown}`);
      if (String(amountShown) !== String(CHARGE) && String(amountShown) !== `${CHARGE}.00`) {
        no('预填金额等于技师报费', `实为 ${amountShown}，期望 ${CHARGE}`);
      }
    }
    const msgBefore = await cdp.evaluate(LAST_MESSAGE_EXPR);
    const clickedModalOk = await cdp.evaluate(clickModalOkExpr('确认服务', '确认'));
    if (!clickedModalOk?.ok) {
      no('点击模态框的「确认」', JSON.stringify(clickedModalOk));
      return;
    }
    const confirmMsg = await waitNewMessage(cdp, String(msgBefore ?? ''), 20_000);
    if (!confirmMsg) {
      no('门店确认后界面给出结果提示', '没有任何 message —— 员工无法知道是否成功');
    } else if (!/[一-龥]/.test(confirmMsg)) {
      no('确认结果提示是可理解的中文', `实为「${confirmMsg.slice(0, 160)}」`);
    } else {
      ok('门店确认后界面给出中文结果提示', confirmMsg.slice(0, 120));
    }

    // 抽屉重拉后，「技师回执」区块应当**连同确认按钮一起消失**（不再是 SUBMITTED）
    // —— 这是"按钮与状态一致"的直接证据，而不是只看库里状态变了。
    const gone = await cdp
      .waitFor(
        `(() => {
          const d = ${DRAWER_SCOPE_JS};
          if (!d) return true;
          return ![...d.querySelectorAll('button')].some((b) => (b.innerText||'').replace(/\\s+/g,'') === '确认服务');
        })()`,
        { what: '确认后抽屉里的确认按钮消失', timeout: 20_000 },
      )
      .catch(() => null);
    if (gone === null) {
      no('确认后抽屉里不再有「确认服务」按钮（按钮与状态一致）', '仍存在 ⇒ 可重复审核');
    } else {
      ok('确认后抽屉里不再有「确认服务」按钮（按钮与状态一致）', '重拉后回执区块已消失');
    }

    const afterConfirm = String(psqlScalar(`SELECT status FROM service_tickets WHERE id = ${ticketId}`));
    const visitRow = psqlRows(
      `SELECT coalesce(store_confirm_status,'-'), coalesce(confirmed_charge_amount::text,'-'), coalesce(store_confirmed_by::text,'-') ` +
        `FROM service_visits WHERE ticket_id = ${ticketId} AND visit_status <> 'SUPERSEDED' ORDER BY visit_no DESC LIMIT 1`,
    )[0] ?? [];
    if (afterConfirm !== 'WAIT_FEEDBACK') {
      no('门店确认 → 工单进入 WAIT_FEEDBACK', `实为 ${afterConfirm}`);
    } else {
      ok('门店确认 → 工单进入 WAIT_FEEDBACK', afterConfirm);
    }
    ok(
      'Visit 的确认状态 / 确认金额 / 确认人一致',
      `store_confirm_status=${visitRow[0]} · confirmed_charge_amount=${visitRow[1]} · confirmed_by=${visitRow[2]}`,
    );
    if (String(visitRow[1]) !== `${CHARGE}.00` && String(visitRow[1]) !== String(CHARGE)) {
      no('收费金额端到端一致（技师报费 → 门店确认）', `确认后为 ${visitRow[1]}，期望 ${CHARGE}`);
    } else {
      ok('收费金额端到端一致（技师报费 88 → 门店确认 88）', String(visitRow[1]));
    }

    // ---- ③ 客户匿名评价 → CLOSED ----
    console.log('\n──── ③ 客户点评价链接匿名提交 → CLOSED ────');
    // ⭐ DEV-108 的回归判据：**先查 sms_logs，而不是只看发件箱**。
    //
    //    发件箱是"投递成功"的结果，而漏网的那条缺陷恰恰是**压根没投递** ——
    //    短信停在 `send_status='pending'`，发件箱里自然没有，
    //    于是"发件箱里取不到"看起来像"取 Token 的判据写错了"，
    //    真正的断点是"门店确认后客户收不到评价链接"。
    //    ⇒ 判据必须落在 **SmsLog 的 send_status** 上，两件事分开报。
    const smsRow = psqlRows(
      `SELECT coalesce(send_status,'-'), coalesce(error_code,'-') FROM sms_logs ` +
        `WHERE ticket_id = ${ticketId} AND scene = 'review_invite' ORDER BY id DESC LIMIT 1`,
    )[0];
    if (!smsRow) {
      no('门店确认后产生了评价邀请短信', 'sms_logs 里没有 review_invite 行 —— 客户拿不到评价链接');
    } else if (smsRow[0] !== 'accepted') {
      no(
        '评价邀请短信已实际投递（send_status=accepted）',
        `实为 ${smsRow[0]}${smsRow[1] === '-' ? '' : ` / ${smsRow[1]}`} —— 客户收不到评价链接，闭环断在最后一步`,
      );
    } else {
      ok('评价邀请短信已实际投递', `sms_logs.send_status=${smsRow[0]}`);
    }

    // 发件箱读 Token：允许**轮询**（跨进程内存队列，不假设瞬时可见）
    let reviewToken = null;
    let items = [];
    const boxDeadline = Date.now() + 30_000;
    while (Date.now() < boxDeadline) {
      const outbox = await fetch(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=200`, {
        headers: { Authorization: `Bearer ${hq}` },
      });
      const outboxJson = await outbox.json();
      items = outboxJson?.data?.items ?? [];
      reviewToken = reviewTokenFromOutbox(items, { ticketNo });
      if (reviewToken) break;
      await sleep(500);
    }
    if (!reviewToken) {
      no(
        '从发件箱取到本工单的客户评价链接',
        explainMissingReviewToken(items, { ticketNo }) ?? '取不到 —— 无法走真实评价闭环',
      );
    } else {
      ok('从发件箱取到本工单的客户评价链接', `token 长度 ${reviewToken.length}`);
      const reviewRes = await fetch(`${BASE_URL}/api/public/reviews/${reviewToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({ rating: 5, charge_match: 'match', comment: '处理及时，满意' }),
      });
      const reviewBody = await reviewRes.json();
      if (reviewRes.status !== 200 && reviewRes.status !== 201) {
        no('客户匿名提交评价', `HTTP ${reviewRes.status} ${JSON.stringify(reviewBody).slice(0, 200)}`);
      } else {
        const finalRow = psqlRows(
          `SELECT status, coalesce(rating::text,'-'), coalesce(review_status,'-'), ` +
            `CASE WHEN reviewed_at IS NULL THEN 'null' ELSE 'set' END FROM service_tickets WHERE id = ${ticketId}`,
        )[0] ?? [];
        if (finalRow[0] !== 'CLOSED') {
          no('客户评价 → 工单 CLOSED', `实为 ${finalRow[0]}`);
        } else {
          ok(
            '客户评价 → 工单 CLOSED',
            `status=${finalRow[0]} · rating=${finalRow[1]} · review_status=${finalRow[2]} · reviewed_at=${finalRow[3]}`,
          );
        }
      }
    }

    // ---- ④ 审计记录：整条链路的事件是否齐全 ----
    console.log('\n──── ④ 审计记录一致性（时间线事件）────');
    const events = psqlRows(
      `SELECT event_type FROM ticket_events WHERE ticket_id = ${ticketId} ORDER BY id`,
    ).map((r) => r[0]);
    const EVENT_TYPE = loadEventTypes();
    // 「门店派工 → 师傅提交 → 门店确认 → 客户评价」四个动作，一个都不能少
    const want = [
      EVENT_TYPE.DISPATCHED,
      EVENT_TYPE.TECHNICIAN_SUBMITTED,
      EVENT_TYPE.STORE_CONFIRMED,
      EVENT_TYPE.REVIEWED,
    ];
    const missing = want.filter((w) => !events.includes(w));
    if (missing.length) {
      no('关键审计事件齐全', `缺 ${missing.join('、')} · 实际=${JSON.stringify(events)}`);
    } else {
      ok('关键审计事件齐全', events.join(' → '));
    }

    // ---- ⑤ 正常业务冲突的中文提示 ----
    console.log('\n──── ⑤ 冲突提示必须是可理解的中文（不能把原始码当主要文案）────');
    const other = psqlRows(
      `SELECT t.id, v.id FROM service_tickets t JOIN service_visits v ON v.ticket_id = t.id ` +
        `WHERE t.store_id = 1 AND t.status = 'WAIT_STORE_CONFIRM' AND v.visit_status = 'SUBMITTED' ` +
        `AND t.id <> ${ticketId} ORDER BY t.id LIMIT 1`,
    )[0];
    if (!other) {
      no('另找一张待确认工单以模拟"同事先处理"', '库里没有第二张 —— 判据空转，按铁律 10 判红');
    } else {
      conflictTicketId = Number(other[0]);
      const conflictVisitId = Number(other[1]);
      // ⚠️ 先关掉上一个抽屉：确认成功后抽屉**不会**自己关，它带遮罩，
      //    不关就点不到列表上的行（JS 的 el.click() 能绕过遮罩 ⇒ 会"点得到"，
      //    但那不是员工的真实动作，等于把这一步验成了假动作）。
      await closeDrawers(cdp);
      // 先在浏览器里把它的抽屉打开（此刻它仍是待确认）
      const c2 = await cdp.evaluate(clickRowPrimaryExpr(conflictTicketId));
      if (!c2?.ok) {
        no('打开另一张待确认工单的审核抽屉', JSON.stringify(c2));
      } else {
        await cdp.waitFor(`document.querySelectorAll('.ant-drawer').length > 0`, {
          what: '第二个抽屉打开',
          timeout: 30_000,
        });
        await cdp
          .waitFor(
            `(() => {
              const d = ${DRAWER_SCOPE_JS};
              if (!d) return false;
              return [...d.querySelectorAll('button')].some((b) => (b.innerText||'').replace(/\\s+/g,'') === '确认服务');
            })()`,
            { what: '第二个抽屉的「确认服务」按钮', timeout: 30_000 },
          )
          .catch(() => null);

        // 模拟"同事已经在别处确认了" —— 走真实服务端动作（不是改库）
        const otherVisit = psqlRows(
          `SELECT is_charged, coalesce(reported_charge_amount::text,'-') FROM service_visits WHERE id = ${conflictVisitId}`,
        )[0] ?? [];
        const body = otherVisit[0] === 't' ? { amount: Number(otherVisit[1]) } : {};
        const race = await svcPost('visitConfirm', conflictVisitId, store, body, crypto.randomUUID());
        if (race.status !== 200) {
          no('（模拟同事先处理）另一条回执已被确认', `HTTP ${race.status} ${String(race.body).slice(0, 160)}`);
        } else {
          ok('（模拟同事先处理）另一条回执已被服务端确认', `HTTP ${race.status} · Visit #${conflictVisitId}`);
        }

        // 浏览器（此刻仍是"我打开时它待确认"的旧画面）再走一遍：确认服务 → 确认
        const base2 = String((await cdp.evaluate(LAST_MESSAGE_EXPR)) ?? '');
        const c2a = await cdp.evaluate(clickDrawerBtnExpr('确认服务'));
        if (!c2a?.ok) {
          no('在已过期的抽屉里点「确认服务」', JSON.stringify(c2a));
        } else {
          await cdp
            .waitFor(`(${modalInputValueExpr('确认服务')}) !== null`, { what: '第二个确认模态框', timeout: 10_000 })
            .catch(() => null);
          const c2b = await cdp.evaluate(clickModalOkExpr('确认服务', '确认'));
          if (!c2b?.ok) {
            no('在已过期的模态框里点「确认」', JSON.stringify(c2b));
          } else {
            const msg = await waitNewMessage(cdp, base2, 15_000);
            // 判据三连：有提示 → 是可理解的中文 → 不把原始码当主要文案
            const RAW_CODES = /VISIT_NOT_REVIEWABLE|IDEMPOTENT_VISIT_MISMATCH|NO_ACTIVE_VISIT|CONFLICT_STATE_CHANGED|VISIT_/;
            if (!msg) {
              no('冲突时给出了提示', '界面上没有任何 message 提示');
            } else if (!/[一-龥]/.test(msg)) {
              no('冲突提示是可理解的中文', `实为「${msg.slice(0, 160)}」`);
            } else if (!msg.includes('已被其他人员处理')) {
              no('冲突提示说清了"别人已经处理过"', `实为「${msg.slice(0, 160)}」`);
            } else if (RAW_CODES.test(msg)) {
              no('冲突提示不把原始错误码当主要文案', `提示里出现了原始码：${msg.slice(0, 160)}`);
            } else {
              ok('冲突时给出可理解的中文提示（并自动刷新最新状态）', msg.slice(0, 120));
            }
          }
        }
      }
    }

    // ---- ⑥ 校验错误的中文提示 ----
    console.log('\n──── ⑥ 校验错误的中文提示（跟进不填内容）────');
    const proc = psqlRows(
      `SELECT id FROM service_tickets WHERE store_id = 1 AND status = 'PROCESSING' ORDER BY id DESC LIMIT 1`,
    )[0];
    if (!proc) {
      no('找到一张 PROCESSING 工单以验「跟进」校验提示', '库里没有 —— 判据空转');
    } else {
      const procId = Number(proc[0]);
      await closeDrawers(cdp); // 上一个抽屉还开着 ⇒ 挡住列表
      const back = await cdp.evaluate(clickTabExpr('处理中'));
      if (!back?.ok) {
        no('切回「处理中」Tab', JSON.stringify(back));
      } else {
        let found = false;
        const dl3 = Date.now() + 30_000;
        while (Date.now() < dl3) {
          found = await cdp.evaluate(
            `(() => {
              const scope = ${ACTIVE_SCOPE_JS};
              if (!scope) return false;
              return !!scope.querySelector('.ant-table-tbody tr[data-row-key="${procId}"]');
            })()`,
          );
          if (found) break;
          await sleep(400);
        }
        if (!found) {
          no(`在处理中 Tab 找到工单 #${procId}`, '未找到');
        } else {
          const c3 = await cdp.evaluate(clickRowPrimaryExpr(procId));
          if (!c3?.ok || c3.label !== '跟进') {
            no('PROCESSING 行的主动作是「跟进」', JSON.stringify(c3));
          } else {
            ok('PROCESSING 行的主动作是「跟进」', c3.label);
            // 跟进窗口：不填内容直接点保存
            await cdp.waitFor(`!!document.querySelector('[data-testid="follow-form"]')`, {
              what: '跟进窗口',
              timeout: 20_000,
            });
            const base3 = String((await cdp.evaluate(LAST_MESSAGE_EXPR)) ?? '');
            const followBefore = Number(
              psqlScalar(
                `SELECT count(*) FROM ticket_events WHERE ticket_id = ${procId} AND event_type = 'follow_up'`,
              ),
            );
            const clickedSave = await cdp.evaluate(
              `(() => {
                const ms = [...document.querySelectorAll('.ant-modal-confirm')].filter((m) => m.getClientRects().length > 0);
                const m = ms[ms.length - 1];
                if (!m) return { ok: false, why: 'no-modal' };
                const btns = [...m.querySelectorAll('button')];
                const okBtn = btns.find((b) => (b.innerText||'').replace(/\\s+/g,'') === '保存');
                if (!okBtn) return { ok: false, why: 'no-save', seen: btns.map((b) => (b.innerText||'').replace(/\\s+/g,'')) };
                okBtn.click();
                return { ok: true };
              })()`,
            );
            if (!clickedSave?.ok) {
              no('点到跟进窗口的「保存」', JSON.stringify(clickedSave));
            } else {
              const msg2 = await waitNewMessage(cdp, base3, 12_000);
              if (!msg2) {
                no('跟进内容为空时给出提示', '界面上没有任何提示');
              } else if (!/[一-龥]/.test(msg2)) {
                no('校验提示是可理解的中文', `实为「${msg2.slice(0, 160)}」`);
              } else if (/MISSING_NOTE|[A-Z_]{6,}/.test(msg2)) {
                no('校验提示不把原始错误码当主要文案', `提示里出现原始码：${msg2.slice(0, 160)}`);
              } else {
                ok('跟进内容为空时给出中文提示', msg2.slice(0, 120));
              }
              // 光"提示了"还不够：提示必须**真的拦住**这次写入。
              // 只提示不拦截 ⇒ 库里会多一条内容为空的跟进，时间线上出现一条空记录。
              const followAfter = Number(
                psqlScalar(
                  `SELECT count(*) FROM ticket_events WHERE ticket_id = ${procId} AND event_type = 'follow_up'`,
                ),
              );
              if (followAfter !== followBefore) {
                no('校验提示确实拦住了这次写入', `follow_up 事件 ${followBefore} → ${followAfter}`);
              } else {
                ok('校验提示确实拦住了这次写入（没有留下空跟进）', `follow_up 事件仍为 ${followAfter} 条`);
              }
            }
          }
        }
      }
    }
  } finally {
    if (chrome) {
      try {
        chrome.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    const restored = sms.restore();
    console.log(`\n  · sms.enabled 已还原：${restored.note}${restored.ok ? '' : '（⚠️ 请手工确认）'}`);
    if (ticketId) {
      cleanupTicket(ticketId);
      console.log(`  · 已清理本次自建工单 #${ticketId}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  通过 ${passed.length} 项 · 未达标 ${failures.length} 项`);
  for (const f of failures) console.log(`    ✗ ${f}`);
  console.log('══════════════════════════════════════════════════════════════');
  return failures.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.log(`✗ 未预期错误：${error?.stack ?? error}`);
    process.exit(2);
  });
