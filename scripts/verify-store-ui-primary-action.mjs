#!/usr/bin/env node
/**
 * verify-store-ui-primary-action.mjs —— **门店列表主动作的真实浏览器验收**（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 为什么这份验收不能换成"读库 + 数行数"
 * ===========================================================================
 * 上一轮已经证明：库里 7 张表 × 1 个主动作、断言全绿，**但那不能说明页面长什么样**。
 * 本项目在这个位置已经栽过三次同类跟头：
 *   · `{values:{…}}` 双包装 —— 行在库里、顶层没有 `use` ⇒ 页面**静默不渲染**；
 *   · 五个动作挂在 TableBlock 的 `actions` 而不是操作列 ⇒ 库里 35 行、界面 0 个按钮；
 *   · `this.record` 取不到行 ⇒ 按钮有、点了没反应。
 * 三次的共性是：**结构断言全绿，行为全是空的**。
 * ⇒ 所以这里全部判据都落在"真实浏览器里看得见、点得动、点了有结果"。
 *
 * ===========================================================================
 * ✅ 关于"状态 Tab"：B-15 已修复（2026-10-10），**服务端筛选**已生效
 * ===========================================================================
 * 修复前（2026-10-09 抓 Network 实测）：切到各状态 Tab 时只发一条
 * `serviceTickets:list?...` 且**不带 filter 参数**，六个 Tab 渲染同一批 20 行。
 * 根因：框架会把区块默认筛选**持久化**到 FilterActionModel 的 `props.defaultFilterValue`，
 * 但**从不在加载时应用**（只有点「确定」/「重置」才 `addFilterGroup`）。
 *
 * 修复：`TicketTabFilterModel`（`src/client/tab-filter.tsx`）在 `onInit`/`onMount`
 * 把该 Tab 的筛选交给 `resource.addFilterGroup()` ⇒ **随请求下到服务端**。
 * 由 `scripts/verify-store-tab-filter.mjs` 守着（30 项判据，含 count 与库里真值对齐）。
 *
 * ⚠️ 但**本脚本仍然刻意不依赖 Tab 去"挑状态"**：它要验的是"主动作在每个状态下
 *    的行为"，用分页扫描定位目标行对状态分布没有依赖 —— 不把两件事耦在一起，
 *    任何一侧坏了都不会互相掩盖。
 *
 * ===========================================================================
 * 判据（对应用户 2026-10-09 的九条验收要求）
 * ===========================================================================
 *   ① 每行**只有一个**按钮，且**不是 CSS 隐藏**（隐藏的按钮也一并点名）
 *   ② 六个状态各自显示正确标签（UI 文本 vs 库里状态，逐行交叉核对）
 *   ③ 点击**永远作用于当前行**（抽屉工单号必须等于该行工单号）
 *   ④ NEW → 「处理」窗口给出五种选择，且**真的执行**业务写操作
 *   ⑤ PROCESSING → 「跟进」能保存（库里出现 follow_up 事件）
 *   ⑥ WAIT_STORE_CONFIRM → 「审核结果」进得去
 *   ⑦ 全程 **0 个 429**、无可解释的控制台错误、无"一直 loading"
 *   ⑧ 旧按钮墙（受理/派工/改派/改约/详情 + 原生查看/编辑/删除）界面上**不存在**
 *   ⑨ 每一步失败都要**自证现场**（挂之前页面是什么、API 返回了什么）
 *
 * ===========================================================================
 * 「已闭环」数据怎么来的（刻意不造库，全部走真实路径）
 * ===========================================================================
 * 状态机里 CLOSED 只能由"客户评价 / 评价超时"进入。本机的客户评价链接
 * 只发到手机，而短信正文**刻意不进库**（它含评价 Token 明文），
 * 只存在于 mock 通道的**内存发件箱**（`svc:smsOutbox`，真实通道无此接口）。
 * ⇒ 本脚本的做法：浏览器里做一次「电话/门店直接解决」（真实门店动作，
 *    签发真实评价 Token 并入队短信）→ 从发件箱读出客户会收到的链接 →
 *    以**匿名**身份提交评价（与客户点链接完全同一条接口）→ CLOSED。
 *    除"读发件箱"这一步之外，没有任何一步是绕过业务的。
 *
 * 用法：node scripts/verify-store-ui-primary-action.mjs
 * 退出码：0 全部通过 / 1 有未达标项 / 2 环境未就绪
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';
// P11-1：⑥ 的夹具改为**自建** —— 复用共享夹具，不再另抄一份"取 Token / 上传"的实现
import {
  cleanupTicket,
  createScratchTicket,
  ensureFixtureJpeg,
  signIn,
  svcPost,
  technicianSubmit,
  technicianUpload,
  tokenFromOutbox,
} from './technician-harness.mjs';
import { explainMissingReviewToken, reviewTokenFromOutbox } from './lib/review-token.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');
const CLIENT_DIR = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'client');
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

/**
 * 「状态 → 标签」的期望值**必须来自客户端契约本身**，不能在本脚本里再抄一份。
 *
 * 抄一份的后果在本项目已经发生过：界面改了、断言没改 ⇒ 断言永远绿。
 * 所以沿用 `verify-client-logic.mjs` 的路子：用 esbuild 把零依赖的
 * `row-action-matrix.ts` 编译成 CJS 再 require。
 */
function loadRowActionMatrix() {
  const nodeRequire = createRequire(import.meta.url);
  let esbuild = null;
  for (const load of [
    () => nodeRequire('esbuild'),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
  ]) {
    try { esbuild = load(); break; } catch { /* 试下一个 */ }
  }
  if (!esbuild) throw new Error('找不到 esbuild —— 无法加载客户端契约（环境未就绪，exit 2）');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entry = path.join(OUT_DIR, 'row-action-matrix-entry.ts');
  const outfile = path.join(OUT_DIR, 'row-action-matrix.cjs');
  fs.writeFileSync(
    entry,
    `export * from '${path.join(CLIENT_DIR, 'row-action-matrix').replace(/\\/g, '/')}';`,
    'utf8',
  );
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'warning',
  });
  return nodeRequire(outfile);
}

let PRIMARY_LABELS = [];
const ALL_SIX = ['NEW', 'PROCESSING', 'WAIT_STORE_CONFIRM', 'WAIT_FEEDBACK', 'CLOSED', 'CANCELLED'];
try {
  const m = loadRowActionMatrix();
  PRIMARY_LABELS = [...new Set(ALL_SIX.map((s) => m.primaryActionOf(s)?.label).filter(Boolean))];
  if (PRIMARY_LABELS.length === 0) throw new Error('契约里六个状态都没有主动作标签 —— 契约异常');
} catch (error) {
  console.log(`  ⛔ ${error.message}`);
  process.exit(2);
}

/** 界面上**不得**出现的行内按钮文案（旧按钮墙 + 原生写路径） */
const FORBIDDEN_LABELS = ['受理', '派工', '改派', '改约', '详情', '编辑', '删除'];

/**
 * 本轮**真实操作**造出来的工单 id（模块级）。
 *
 * ⚠️ 刻意放在 `run()` 外面：写操作在浏览器里做，而"用它推进到 CLOSED"这一步
 *    在浏览器**之外**做（要读 mock 发件箱）。若放在 `run()` 内部，
 *    跨阶段读取会直接 `created is not defined` —— 本轮第一次跑就炸在这里。
 */
const created = { cancelledId: null, remoteId: null };

export function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* 落到 process.env */ }
  return process.env[key] ?? fallback;
}

export const STORE_EMAIL = envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
const STORE_PASSWORD = envValue('UAT_STORE_A_PASSWORD');
const HQ_EMAIL = envValue('UAT_HQ_EMAIL', 'uat.hq@svc.local');
const HQ_PASSWORD = envValue('UAT_HQ_PASSWORD');

/** ⑥ 自建的待确认夹具工单（跑完按 id 精确删除；见 ⑥ 处的说明） */
let uipaFixtureTicketId = null;

/**
 * ===========================================================================
 * 测试数据隔离闸（2026-10-17，UX-MEDIA-01 验收后整改）
 * ===========================================================================
 * 事故：本脚本的 ④（处理/取消）、⑤（跟进）原来是**按状态挑任意行**写入。
 *   合成工单 `FW20261017-0015` 恰好是最新的 NEW 行，于是被 ④-b 当成了
 *   "客户取消"的靶子 —— 一张与本次测试无关的工单被改了状态。
 *
 * 🔴 规则（用户 2026-10-17 裁决）：
 *   ① 写操作**只允许**命中本次运行自己创建的工单；
 *   ② 操作前核对**精确 id**（不看顺序、不看状态）；
 *   ③ 没有合格夹具 ⇒ **判环境阻塞**，绝不退而选真实客户工单；
 *   ④ 真实客户工单只做**无副作用的只读**验证；
 *   ⑤ 跑完按 id 清理；⑥ 不放宽任何既有业务断言。
 *
 * 实现：`writableFixtures` 是**唯一**的写白名单；`assertWritableFixture()`
 *   在每次点击/保存前调用 —— 不是"记得别选错"，而是"选错就写不下去"。
 */
const writableFixtures = new Set();

/** 登记一个本次创建的夹具（唯一写白名单来源）。 */
function registerFixture(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`夹具 id 非法：${id}`);
  writableFixtures.add(n);
  return n;
}

/** 写操作前的硬闸：id 不在本次夹具白名单里就直接失败（绝不落到真实工单）。 */
function assertWritableFixture(id, step) {
  const n = Number(id);
  if (!writableFixtures.has(n)) {
    throw new Error(
      `[fixture-guard] ${step} 试图写入 #${n}，但它不是本次运行创建的夹具。` +
        '按纪律：不得写入真实客户工单（见文件头"测试数据隔离闸"）。',
    );
  }
  return n;
}

/** 跑完/异常时按 id 精确清理所有夹具（不删任何白名单外的工单）。 */
function cleanupAllFixtures() {
  for (const id of [...writableFixtures]) {
    try {
      cleanupTicket(id);
      writableFixtures.delete(id);
      console.log(`  · 已清理自建夹具工单 #${id}`);
    } catch (error) {
      console.log(`  · 清理夹具 #${id} 失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
}

export function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '\u0001', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}
export function psqlRows(sql) {
  return psql(sql)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.split('\u0001'));
}

// ---------------------------------------------------------------------------
// 结果收集：每一条都要么绿要么红，不允许"只打印不判"
// ---------------------------------------------------------------------------
const passed = [];
const failures = [];
function ok(label, detail = '') {
  passed.push(label);
  console.log(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}`);
}
function no(label, detail = '') {
  failures.push({ label, detail });
  console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  门店列表主动作 · 真实浏览器验收（Phase 11 / P11-0）');
console.log('══════════════════════════════════════════════════════════════');

if (!STORE_PASSWORD || !HQ_PASSWORD) {
  console.log('  ⛔ .env 缺 UAT_STORE_A_PASSWORD / UAT_HQ_PASSWORD —— 环境未就绪');
  process.exit(2);
}

const schemaUid = psql(
  `SELECT "schemaUid" FROM "desktopRoutes" WHERE type='flowPage' AND title='我的门店工单' LIMIT 1`,
).trim();
if (!schemaUid) {
  console.log('  ⛔ 找不到「我的门店工单」页面路由 —— 环境未就绪');
  process.exit(2);
}
console.log(`  · 门店账号 ${STORE_EMAIL} · 六个状态期望标签 ${JSON.stringify(PRIMARY_LABELS)}`);

/** 门店 S01 的工单（id → 单号 + 状态），作为"UI 文本"的对照真值 */
function ticketMap() {
  const m = new Map();
  for (const [id, no, status] of psqlRows(
    `SELECT t.id, t.ticket_no, t.status FROM service_tickets t
       JOIN stores s ON s.id = t.store_id WHERE s.code = 'S01'`,
  )) {
    m.set(Number(id), { ticketNo: no, status });
  }
  return m;
}
function statusOfId(id) {
  return psql(`SELECT status FROM service_tickets WHERE id = ${Number(id)}`).trim();
}
function countFollowUp(id) {
  return Number(
    psql(`SELECT count(*) FROM ticket_events WHERE ticket_id = ${Number(id)} AND event_type = 'follow_up'`).trim(),
  );
}

// ---------------------------------------------------------------------------
// 无头浏览器（CDP）
// ---------------------------------------------------------------------------
export function findChrome() {
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
const PROFILE_DIR = path.join(OUT_DIR, `chrome-profile-pa-${Date.now()}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
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
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`轮询失败：${url}`);
}

// ---------------------------------------------------------------------------
/** 可见性判据（**只用在行内元素上**；弹层见 VISIBLE_OVERLAY_EXPR） */
const IS_VISIBLE_SRC =
  `const isVisible = (el) => { const r = el.getBoundingClientRect(); ` +
  `return r.height > 0 && r.width > 0 && el.offsetParent !== null; };`;

/**
 * 当前**可见表格**的逐行快照。
 *
 * 🔴 必须按可见性过滤：切 Tab 后旧 Tab 的表格仍挂载在 DOM 里（NocoBase 缓存 Tab 面板）。
 *    2026-10-09 实测：切到「待处理」后 querySelectorAll 数出 **40 行**，
 *    而当前 Tab 只有 20 行 —— 多出的 20 行来自上一个 Tab 那张**已隐藏**的表。
 *    不按可见性过滤 ⇒ 会对着一张看不见的表做断言。
 */
const SNAPSHOT_EXPR = `(() => {
  ${IS_VISIBLE_SRC}
  const table = [...document.querySelectorAll('.ant-table')]
    .filter(isVisible)
    .find(t => t.querySelector('.ant-table-tbody tr[data-row-key]'));
  if (!table) return { rows: [], headers: [], tableCount: 0 };
  const headers = [...table.querySelectorAll('.ant-table-thead th')].map(th => th.innerText.trim());
  let actionsIdx = headers.findIndex(h => h === '操作');
  if (actionsIdx < 0) actionsIdx = headers.length - 1;
  // 状态列：按表头「状态」定位。**不写死列号** —— 列序属于页面配置，
  // 写死会在某次重排后静默读到另一列（读到的还是文本，断言照样能过）。
  const statusIdx = headers.findIndex(h => h === '状态');
  const rows = [...table.querySelectorAll('.ant-table-tbody tr[data-row-key]')].map(tr => {
    const tds = [...tr.children];
    const actionCell = tds[actionsIdx];
    const buttons = actionCell ? [...actionCell.querySelectorAll('button, a[role="button"]')] : [];
    return {
      rowKey: tr.getAttribute('data-row-key'),
      actionsIdx,
      statusIdx,
      /** 行内**状态列**的显示文本（用于与详情抽屉逐字比对） */
      statusText: statusIdx >= 0 && tds[statusIdx] ? (tds[statusIdx].innerText || '').trim() : '',
      buttons: buttons.map(b => ({
        text: (b.innerText || b.textContent || '').trim(),
        // 🔴 关键：隐藏的按钮也要抓出来。offsetParent === null 即 display:none 链上的元素，
        //    "用 CSS 藏起来的按钮墙"会表现为 offsetParent=null 但 text 非空。
        //    ⚠️ 这段字符串是外层模板字面量的内容 —— **里面不能出现反引号**，
        //       否则模板会提前闭合（第一次写就踩了，报错指向下一行的 identifier）。
        visible: b.offsetParent !== null && b.getBoundingClientRect().width > 0,
        primary: b.getAttribute('data-primary-action'),
        ticketId: b.getAttribute('data-ticket-id'),
      })),
      // UX-01A / A2：工单号列是否渲染成"可点击链接"（派生字段模型 TicketNoLinkModel）
      ticketNoLink: (() => {
        const a = tr.querySelector('[data-testid="ticket-no-link"]');
        if (!a) return null;
        return { text: (a.innerText || a.textContent || '').trim(), ticketId: a.getAttribute('data-ticket-id') };
      })(),
      // UX-01A §四：行内只读「查看」文本链接（非 button ⇒ 不计入"每行一个按钮"）
      viewLink: (() => {
        const a = tr.querySelector('[data-testid="row-view-link"]');
        if (!a) return null;
        return {
          text: (a.innerText || a.textContent || '').trim(),
          ticketId: a.getAttribute('data-ticket-id'),
          focusable: Number(a.tabIndex) >= 0,
        };
      })(),
    };
  });
  return { rows, headers, actionsIdx, tableCount: [...document.querySelectorAll('.ant-table')].filter(isVisible).length };
})()`;

/** 表格是否还在加载（"一直 loading" 的判据） */
export const SPINNING_EXPR = `document.querySelectorAll('.ant-spin-spinning').length`;

/**
 * 可复用的"起一个无头 Chrome + 连上 CDP"（第九轮抽出，供独立验收脚本复用）。
 * ⚠️ 主门禁 `run()` 仍用它**自己那份内联**启动流程 —— 本函数**不改变**主门禁行为。
 */
export async function launchCdp({ port = DEBUG_PORT + 20, label = 'final' } = {}) {
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE_DIR}-${label}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : []),
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const page = (await pollJsonEndpoint(`http://127.0.0.1:${port}/json/list`)).find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome 没有 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  return {
    chrome,
    ws,
    cdp,
    close: () => {
      try { ws.close(); } catch { /* noop */ }
      try { chrome.kill('SIGKILL'); } catch { /* noop */ }
    },
  };
}

/**
 * 弹层（抽屉 / 弹窗）是否**真的可见**。
 *
 * 🔴 不能沿用行内元素那套 `offsetParent !== null`：
 *    antd 的 drawer / modal 外层是 `position: fixed`，而 **fixed 元素的 `offsetParent`
 *    恒为 null** —— 用它判断会得出"抽屉没打开"，于是断言恒红，还会把一次
 *    **功能其实正常**的运行报成失败（本项目最忌的假红）。
 *    （2026-10-09 实测踩到：抽屉确实打开了，`.ant-drawer` 有 1 个，
 *     但 offsetParent 判据把它读成了未打开。）
 */
const VISIBLE_OVERLAY_EXPR = `(() => {
  const el = [...document.querySelectorAll('.ant-drawer, .ant-modal')].find((d) => {
    const r = d.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(d);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  });
  return el ? (el.innerText || '').slice(0, 1200) : null;
})()`;

/**
 * 关掉当前可见弹层（抽屉 / 弹窗），避免挡住后续步骤。
 *
 * ⚠️ 为什么还要退到「取消」按钮：`Modal.confirm` 默认**没有**关闭 X
 *    （实测 2026-10-09：跟进窗口关不掉，于是一路挡住了后面的 ⑥，
 *     ⑥ 读到的"抽屉文本"其实是那个没关掉的跟进窗口）。
 * ⚠️ 按钮文案要**先去掉空白再比**：antd 会给两个汉字的按钮插空格
 *    （界面上是 `取 消` / `保 存`，`innerText` 取出来也带空格）——
 *    直接 `=== '取消'` 会永远匹配不上，于是"关不掉"和"找不到保存"同时发生。
 */
const squashed = `(el) => (el.innerText || '').replace(/\\s+/g, '')`;

const CLOSE_OVERLAY_EXPR = `(() => {
  const sq = ${squashed};
  const el = [...document.querySelectorAll('.ant-drawer, .ant-modal')].find((d) => {
    const r = d.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(d).display !== 'none';
  });
  if (!el) return { closed: false, reason: 'no-overlay' };
  const close = el.querySelector('.ant-drawer-close, .ant-modal-close');
  if (close) { close.click(); return { closed: true, via: 'close-button' }; }
  const cancel = [...el.querySelectorAll('button')].find((b) => sq(b) === '取消');
  if (cancel) { cancel.click(); return { closed: true, via: 'cancel-button' }; }
  return { closed: false, reason: 'no-close-no-cancel', buttons: [...el.querySelectorAll('button')].map(sq) };
})()`;

/**
 * 点某一行的主动作 —— **只在可见表格里找行**。
 *
 * 🔴 为什么不能 `document.querySelector('tr[data-row-key="X"]')`：
 *    隐藏面板里可能也有同一个 rowKey；而 JS 的 `.click()` **不做命中测试**，
 *    点到隐藏面板里的按钮同样返回 true —— 于是"点了"是真话，"点了当前行"是假的。
 *    ⇒ 这里按可见表格逐张找，并返回**实际点到的按钮上的 data**，供调用方核对。
 */
const clickPrimaryExpr = (rowKey) => `(() => {
  ${IS_VISIBLE_SRC}
  for (const table of [...document.querySelectorAll('.ant-table')].filter(isVisible)) {
    const tr = table.querySelector('.ant-table-tbody tr[data-row-key="${rowKey}"]');
    if (!tr || !isVisible(tr)) continue;
    const btn = tr.querySelector('[data-primary-action]');
    if (!btn) continue;
    btn.click();
    return { ok: true, label: btn.getAttribute('data-action-label'), ticket: btn.getAttribute('data-ticket-id') };
  }
  return { ok: false, reason: 'no-visible-row-or-button' };
})()`;

/** 跳到分页的第 N 页（antd Pagination 的页码项带 `title`） */
const gotoPageExpr = (n) => `(() => {
  const item = [...document.querySelectorAll('.ant-pagination-item')]
    .find(el => el.getAttribute('title') === ${JSON.stringify(String(n))} || (el.innerText || '').trim() === ${JSON.stringify(String(n))});
  if (!item) return { ok: false, reason: 'no-page-item' };
  item.click();
  return { ok: true };
})()`;

/** 当前总页数（分页器最后一页的页码） */
const TOTAL_PAGES_EXPR = `(() => {
  const items = [...document.querySelectorAll('.ant-pagination-item')].map(el => Number(el.getAttribute('title') || (el.innerText||'').trim()));
  return items.length ? Math.max(...items.filter(Number.isFinite)) : 1;
})()`;

async function run() {
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      // 🔴 只在**自签演练**模式下忽略证书错误（与既有走查脚本同一纪律）。
      ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : []),
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  /** 所有 /api/ 请求（判 429 用） */
  const calls = [];
  const consoleErrors = [];
  let loggedIn = false;

  try {
    const page = (await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome 没有 page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    cdp.on('Network.requestWillBeSent', (p) => {
      const url = p.request?.url ?? '';
      if (!url.includes('/api/')) return;
      calls.push({ url: url.replace(SVC_BASE_URL, ''), requestId: p.requestId, status: null });
    });
    cdp.on('Network.responseReceived', (p) => {
      const hit = calls.find((c) => c.requestId === p.requestId);
      if (hit) hit.status = p.response?.status ?? null;
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      const serializeArg = (a) => {
        if (a == null) return '';
        if (a.value !== undefined && a.value !== null) {
          return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
        }
        if (a.preview?.properties?.length) {
          const label = a.preview.description ?? a.preview.subtype ?? 'object';
          const props = a.preview.properties.map((x) => `${x.name}=${x.value}`).join(' ');
          return `${label}{${props}}`;
        }
        if (a.unserializableValue) return String(a.unserializableValue);
        return a.description ?? a.type ?? '';
      };
      const text = p.args.map(serializeArg).join(' ').trim().slice(0, 300);
      if (loggedIn) consoleErrors.push(text);
    });

    // ---- 真实登录 ----
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
    try {
      await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪', timeout: 30_000 });
    } catch (e) {
      const diag = await cdp.evaluate(`(() => ({
        href: location.href, inputs: document.querySelectorAll('input').length,
        bodyHead: (document.body?.innerText ?? '').slice(0, 300),
      }))()`);
      console.log('  ⛔ 登录页诊断：' + JSON.stringify(diag));
      throw e;
    }
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(ins[0], ${JSON.stringify(STORE_EMAIL)});
      setVal(ins[1], ${JSON.stringify(STORE_PASSWORD)});
      return true;
    })()`);
    await sleep(800);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    try {
      await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
    } catch (e) {
      const diag = await cdp.evaluate(`(() => ({ href: location.href, body: (document.body?.innerText ?? '').slice(0, 300) }))()`);
      console.log('  ⛔ 登录诊断：' + JSON.stringify(diag));
      for (const c of calls.slice(-10)) console.log(`     ${c.status ?? '-'}  ${c.url}`);
      throw e;
    }
    loggedIn = true;
    ok('门店售后账号真实登录', `${STORE_EMAIL} · 登录阶段 ${calls.length} 个 /api 请求`);

    // =====================================================================
    // 【A1 · UX-01A】门店登录**默认落地**「售后服务工作台」，且真的渲染业务数据
    //   —— 这是本段的核心：不靠"菜单里有个入口"，而是**登录后就在工作台**。
    // =====================================================================
    console.log('\n──── A1 门店登录默认落地工作台（真实浏览器）────');
    const LAND_EXPR = `(() => ({ href: location.href, hasWb: !!document.querySelector('[data-testid="store-workbench"]') }))()`;
    let land = await cdp.evaluate(LAND_EXPR);
    for (let i = 0; i < 12 && !land.hasWb; i++) {
      await sleep(2000);
      land = await cdp.evaluate(LAND_EXPR);
    }
    if (!land.hasWb) {
      no('A1 登录后默认落地「售后服务工作台」', `未渲染工作台 · href=${land.href}`);
    } else {
      ok('A1 登录后默认落地「售后服务工作台」', `href=${land.href}`);
      await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '工作台加载完成', timeout: 30_000 }).catch(() => {});
      const wb = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('[data-testid="wb-stat-card"]')];
        return {
          labels: cards.map(c => (c.querySelector('div')?.innerText || '').trim()),
          values: cards.map(c => (c.querySelector('[data-testid="wb-stat-value"]')?.innerText || '').trim()),
          quickCreate: !!document.querySelector('[data-testid="wb-quick-create"]'),
          quickQuery: !!document.querySelector('[data-testid="wb-quick-query"]'),
          recentRows: document.querySelectorAll('[data-testid="wb-recent-row"]').length,
          todoRows: document.querySelectorAll('[data-testid="wb-todo-row"]').length,
        };
      })()`);
      const wantLabels = ['待处理', '已处理（累计）', '处理中', '待门店确认', '待客户评价'];
      const missingLabels = wantLabels.filter((l) => !wb.labels.includes(l));
      if (missingLabels.length) no('A1 概览卡齐全（待处理/已处理累计/处理中/待门店确认/待客户评价）', `缺：${missingLabels.join('、')}`);
      else ok('A1 概览卡齐全', wb.labels.join(' / '));
      const badVals = wb.values.filter((v) => !/^[0-9]+$/.test(v));
      if (badVals.length) no('A1 概览卡数值为真实数字（非占位）', `异常值：${JSON.stringify(badVals)}`);
      else ok('A1 概览卡数值为真实数字', wb.values.join(' / '));
      if (!wb.quickCreate || !wb.quickQuery) no('A1 快捷操作（新建服务单 / 记录查询）存在', JSON.stringify(wb));
      else ok('A1 快捷操作存在', '新建服务单 + 记录查询');
      if (wb.recentRows < 1) no('A1 最近服务单渲染', `rows=${wb.recentRows}`);
      else ok('A1 最近服务单渲染', `rows=${wb.recentRows}`);

      // 卡片点击 → 筛选结果；**卡片值与同一 filter 的列表行数一致**（口径一致的自证）
      const newIdx = wb.labels.indexOf('待处理');
      const newVal = newIdx >= 0 ? Number(wb.values[newIdx]) : NaN;
      await cdp.evaluate(
        `(() => { const c=[...document.querySelectorAll('[data-testid="wb-stat-card"]')].find(x => (x.querySelector('div')?.innerText||'').trim()==='待处理'); if(c) c.click(); return !!c; })()`,
      );
      let gotRows = -1;
      try {
        await cdp.waitFor(`!!document.querySelector('[data-testid="wb-list-rows"], .ant-modal .ant-empty, [data-testid="wb-list-error"]')`, {
          what: '待处理卡片打开的筛选结果',
          timeout: 20_000,
        });
        gotRows = await cdp.evaluate(`document.querySelectorAll('[data-testid="wb-list-rows"] [data-testid="wb-list-ticketno"]').length`);
      } catch {
        gotRows = -1;
      }
      if (gotRows < 0) no('A1 概览卡可点击并打开筛选结果', '未出现结果弹窗');
      else if (newVal > 0 && gotRows === 0) no('A1 卡片值与列表口径一致（待处理）', `卡片=${newVal} 但列表 0 行`);
      else ok('A1 概览卡可点击且与列表口径一致', `待处理 卡片=${newVal} · 列表首屏 ${gotRows} 行（列表按页展示）`);
      // 【P1-①】列表弹窗 = **服务端分页**（默认 10/页 · 总数 · 翻页 · 每页切换）＋【P0 回归】
      const LIST_STATE = `(() => { const el=document.querySelector('[data-testid="wb-list"]'); if(!el) return null; return { page:+el.getAttribute('data-page'), size:+el.getAttribute('data-page-size'), total:el.getAttribute('data-total'), info:(document.querySelector('[data-testid="wb-page-info"]')?.innerText||'').trim(), rows:document.querySelectorAll('[data-testid="wb-list-row"]').length, first:(document.querySelector('[data-testid="wb-list-ticketno"]')?.innerText||'').trim() }; })()`;
      let p0 = await cdp.evaluate(LIST_STATE);
      for (let i = 0; i < 10 && (!p0 || p0.rows === 0); i += 1) {
        await sleep(700);
        p0 = await cdp.evaluate(LIST_STATE);
      }
      if (!p0) no('P1-① 列表弹窗渲染（服务端分页）', '未找到 [data-testid="wb-list"]');
      else {
        if (p0.size !== 10) no('P1-① 默认每页 10 条', `size=${p0.size}`);
        else ok('P1-① 默认每页 10 条', `「${p0.info}」本页 ${p0.rows} 行`);
        const totalNum = Number(p0.total);
        if (!Number.isFinite(totalNum) || totalNum <= 0) no('P1-① 总数来自服务端 meta.count', `total=${p0.total}`);
        else ok('P1-① 总数来自服务端 meta.count', `共 ${totalNum} 条（首屏 ${p0.rows} 行）`);
        // 翻到第 2 页（内容必须变化）
        const firstP1 = p0.first;
        await cdp.evaluate(`document.querySelector('[data-testid="wb-next"]').click()`);
        let p2 = null;
        for (let i = 0; i < 12; i += 1) {
          await sleep(700);
          p2 = await cdp.evaluate(LIST_STATE);
          if (p2 && p2.page === 2 && p2.rows > 0) break;
        }
        if (!p2 || p2.page !== 2) no('P1-① 翻到第 2 页', JSON.stringify(p2));
        else if (p2.first === firstP1) no('P1-① 第 2 页内容与第 1 页不同', `首行同为 ${p2.first}`);
        else ok('P1-① 翻到第 2 页且内容变化', `第2页首行=${p2.first}`);
        // 每页切 20 ⇒ 回到第 1 页
        await cdp.evaluate(`(() => { const s=document.querySelector('[data-testid="wb-page-size"]'); s.value='20'; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        let p20 = null;
        for (let i = 0; i < 12; i += 1) {
          await sleep(700);
          p20 = await cdp.evaluate(LIST_STATE);
          if (p20 && p20.size === 20 && p20.page === 1) break;
        }
        if (!p20 || p20.size !== 20 || p20.page !== 1) no('P1-① 切每页 20 条并回到第 1 页', JSON.stringify(p20));
        else ok('P1-① 切每页 20 条并回到第 1 页', `size=${p20.size} page=${p20.page} rows=${p20.rows}`);
        // 【P0 回归】当前（分页后）页点工单号 → 详情在最上层；关闭后仍在本页
        const rowNo = await cdp.evaluate(`(document.querySelector('[data-testid="wb-list-ticketno"]')?.innerText||'').trim()`);
        await cdp.evaluate(`document.querySelector('[data-testid="wb-list-ticketno"]').click()`);
        let d = null;
        for (let i = 0; i < 12; i += 1) {
          await sleep(800);
          d = await cdp.evaluate(`(() => {
            const dr = document.querySelector('.ant-drawer');
            if (!dr) return null;
            const r = dr.getBoundingClientRect();
            const el = document.elementFromPoint(Math.round(r.left + 30), Math.round(r.top + 16));
            const wrap = document.querySelector('.ant-modal-wrap');
            return { drawerZ: getComputedStyle(dr).zIndex, modalZ: wrap ? getComputedStyle(wrap).zIndex : null, topIsDrawer: !!(el && dr.contains(el)), topTag: el ? (el.className || el.tagName) : null };
          })()`);
          if (d && d.topIsDrawer) break;
        }
        if (!d) no('P0 列表弹窗 → 工单号 → 详情在最上层', '抽屉未出现');
        else if (!d.topIsDrawer) no('P0 列表弹窗 → 工单号 → 详情在最上层', `**被遮挡**：drawerZ=${d.drawerZ} · modalZ=${d.modalZ} · 命中「${d.topTag}」`);
        else ok('P0 列表弹窗 → 工单号 → 详情在最上层', `drawerZ=${d.drawerZ} · modalZ=${d.modalZ}`);
        const title = String(await cdp.evaluate(`(document.querySelector('.ant-drawer-title')?.innerText||'').trim()`));
        if (rowNo && title.includes(rowNo)) ok('P1-① 分页后点工单号打开的是本行详情', `「${title}」`);
        else if (rowNo) no('P1-① 分页后点工单号打开的是本行详情', `title=「${title}」期望含「${rowNo}」`);
        await cdp.evaluate(`(() => { const b=document.querySelector('.ant-drawer-close'); if(b) b.click(); return true; })()`);
        await sleep(500);
        const afterClose = await cdp.evaluate(LIST_STATE);
        if (afterClose && afterClose.page === 1 && afterClose.size === 20) ok('P1-① 关闭详情后列表保持原页码/筛选', `page=${afterClose.page} size=${afterClose.size}`);
        else no('P1-① 关闭详情后列表保持原页码/筛选', JSON.stringify(afterClose));
      }
      await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.ant-modal button')].find(x=>(x.innerText||'').trim()==='关闭'); if(b) b.click(); return true; })()`);
      await sleep(500);

      // 最近工单工单号 → 打开既有只读详情抽屉
      const recentNo = await cdp.evaluate(
        `(document.querySelector('[data-testid="wb-recent-ticketno"]')?.innerText || '').trim()`,
      );
      if (!recentNo) {
        no('A1 最近工单可直接打开详情', '无最近工单可点');
      } else {
        await cdp.evaluate(`document.querySelector('[data-testid="wb-recent-ticketno"]').click()`);
        let opened = false;
        try {
          // ⚠️ 抽屉标题在**数据回来之前**是 `工单 #<id>`（ticket_no 还没到）——
          //    必须等它**含本行工单号**，否则会把"还在加载"误判成"打开了错的单"。
          await cdp.waitFor(
            `(document.querySelector('.ant-drawer-title')?.innerText||'').includes(${JSON.stringify(recentNo)})`,
            { what: '工作台打开的只读详情（含本行工单号）', timeout: 25_000 },
          );
          opened = true;
        } catch { opened = false; }
        const title = String(await cdp.evaluate(`(document.querySelector('.ant-drawer-title')?.innerText||'').trim()`));
        if (opened && title.includes(recentNo)) ok('A1 最近工单直接打开本行只读详情', `「${title}」`);
        else no('A1 最近工单直接打开本行只读详情', `title=「${title}」期望含「${recentNo}」`);
        await cdp.evaluate(`(() => { const b=document.querySelector('.ant-drawer-close'); if(b) b.click(); return true; })()`);
        await sleep(400);
      }

      // =====================================================================
      // 【判据 P1-③ · UX-01A §三】工作台首页紧凑布局：五卡同行 / ≤5 条 / 查看全部
      // =====================================================================
      console.log('\n──── P1-③ 工作台首页紧凑布局（真实浏览器）────');
      const layout = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('[data-testid="wb-stat-card"]')];
        const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
        return {
          cards: cards.length,
          sameRow: tops.length >= 5 && (Math.max(...tops) - Math.min(...tops)) < 8,
          todo: document.querySelectorAll('[data-testid="wb-todo-row"]').length,
          recent: document.querySelectorAll('[data-testid="wb-recent-row"]').length,
          todoAll: !!document.querySelector('[data-testid="wb-todo-all"]'),
          recentAll: !!document.querySelector('[data-testid="wb-recent-all"]'),
          quickCreate: !!document.querySelector('[data-testid="wb-quick-create"]'),
          quickQuery: !!document.querySelector('[data-testid="wb-quick-query"]'),
        };
      })()`);
      if (layout.cards !== 5) no('P1-③ 五张概览卡', `cards=${layout.cards}`);
      else if (!layout.sameRow) no('P1-③ 五卡同一行（桌面宽度）', '不在同一行');
      else ok('P1-③ 五卡同一行（桌面宽度）', '5 张卡 top 一致');
      if (layout.todo > 5 || layout.recent > 5) no('P1-③ 今日待办/最近服务单各 ≤5 条', `todo=${layout.todo} recent=${layout.recent}`);
      else ok('P1-③ 今日待办/最近服务单各 ≤5 条', `todo=${layout.todo} recent=${layout.recent}`);
      if (!layout.todoAll || !layout.recentAll) no('P1-③ 「查看全部」入口存在', JSON.stringify(layout));
      else ok('P1-③ 「查看全部」入口存在', '今日待办 + 最近服务单');
      if (!layout.quickCreate || !layout.quickQuery) no('P1-③ 两个快捷入口存在', JSON.stringify(layout));
      else ok('P1-③ 两个快捷入口存在', '新建服务单 + 记录查询');
      // 「查看全部」→ 完整列表（服务端分页）
      await cdp.evaluate(`document.querySelector('[data-testid="wb-recent-all"]').click()`);
      let allList = null;
      for (let i = 0; i < 10; i += 1) {
        await sleep(700);
        allList = await cdp.evaluate(`(() => { const el=document.querySelector('[data-testid="wb-list"]'); return el?{total:+el.getAttribute('data-total'), page:+el.getAttribute('data-page')}:null; })()`);
        if (allList) break;
      }
      if (!allList) no('P1-③ 「查看全部」进入完整列表', '未出现分页列表');
      else ok('P1-③ 「查看全部」进入完整列表', `共 ${allList.total} 条 · 第 ${allList.page} 页`);
      await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('.ant-modal button')].find(x=>(x.innerText||'').trim()==='关闭'); if(b) b.click(); return true; })()`);
      await sleep(400);
      // 真实截图（桌面 + 窄屏），并验证窄屏无横向溢出
      const shotDir = path.join(ROOT, '.tmp-verify');
      try {
        fs.mkdirSync(shotDir, { recursive: true });
        const desk = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (desk?.data) {
          fs.writeFileSync(path.join(shotDir, 'ux01a-workbench-desktop.png'), Buffer.from(desk.data, 'base64'));
          ok('P1-③ 桌面截图已保存', '.tmp-verify/ux01a-workbench-desktop.png');
        } else no('P1-③ 桌面截图', 'captureScreenshot 无数据');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(900);
        const overflow = await cdp.evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
        const narrow = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (narrow?.data) {
          fs.writeFileSync(path.join(shotDir, 'ux01a-workbench-narrow.png'), Buffer.from(narrow.data, 'base64'));
          ok('P1-③ 窄屏截图已保存', '.tmp-verify/ux01a-workbench-narrow.png');
        }
        if (Number(overflow) > 4) no('P1-③ 窄屏无横向溢出', `scrollWidth 超出 ${overflow}px`);
        else ok('P1-③ 窄屏无横向溢出', `420px 宽下不溢出（超出 ${overflow}px）`);
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await sleep(500);
      } catch (e) {
        no('P1-③ 截图/窄屏检查', String(e?.message ?? e).slice(0, 140));
      }
    }

    // ---- 打开「我的门店工单」----
    let tickets = ticketMap();
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${schemaUid}` });
    try {
      await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', {
        what: '表格与数据到位',
        timeout: 60_000,
      });
    } catch (e) {
      const diag = await cdp.evaluate(`(() => ({
        href: location.href, title: document.title,
        tables: document.querySelectorAll('.ant-table').length,
        rows: document.querySelectorAll('.ant-table-tbody tr[data-row-key]').length,
        spinning: document.querySelectorAll('.ant-spin-spinning').length,
        bodyHead: (document.body?.innerText ?? '').slice(0, 400),
      }))()`);
      console.log('  ⛔ 列表页诊断：' + JSON.stringify(diag));
      for (const c of calls.slice(-12)) console.log(`     ${c.status ?? '-'}  ${c.url}`);
      throw e;
    }
    await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '首次加载结束', timeout: 45_000 });
    ok('列表页打开并完成首屏渲染（无一直 loading）');

    const snapshot = async () => (await cdp.evaluate(SNAPSHOT_EXPR)) ?? { rows: [], headers: [] };

    /**
     * 界面上当前的 antd 提示文本。
     *
     * 为什么必须抓它：写操作失败时，服务端给的中文原因（含 code）只出现在
     * `message.error` 里。不抓 ⇒ 失败详情只有"状态没变"，排障要回头翻日志。
     */
    const lastMessage = async () =>
      (await cdp.evaluate(
        `[...document.querySelectorAll('.ant-message-notice-content')].map(e => (e.innerText||'').trim()).join(' | ')`,
      )) ?? '';

    /** 关掉任何残留弹层 —— 否则它会一路挡住后面的每一个 Tab/分页点击 */
    const closeOverlay = async () => {
      await cdp.evaluate(CLOSE_OVERLAY_EXPR);
      await sleep(900);
    };

    /** 等表格刷新完（每次写操作之后都要走一遍） */
    async function settle() {
      await sleep(1500);
      try {
        await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '操作后表格刷新结束', timeout: 45_000 });
      } catch { /* 有的操作不触发 spinning；下面按现值核对即可 */ }
      await sleep(800);
    }

    /**
     * 按**精确 id** 在分页里找到某一行（夹具定位专用）。
     *
     * ⚠️ 为什么不能继续用 `findRowByStatus('NEW')`：它返回"第一个该状态的行"——
     *    在 424 张真实工单里，那就是**任意一张真实客户工单**。2026-10-17 的
     *    `FW20261017-0015` 就是这么被"客户取消"用例改掉的（UX-MEDIA-01 验收发现）。
     *    夹具必须按 id 找，找不到就是环境阻塞，不许退回按状态挑。
     */
    async function findRowById(id, { maxPages = 12 } = {}) {
      const want = Number(id);
      const totalPages = Math.min(Number(await cdp.evaluate(TOTAL_PAGES_EXPR)) || 1, maxPages);
      for (let p = 1; p <= totalPages; p += 1) {
        if (p > 1) {
          const r = await cdp.evaluate(gotoPageExpr(p));
          if (!r?.ok) break;
          await settle();
        }
        const snap = await snapshot();
        const row = (snap.rows ?? []).find((r) => Number(r.rowKey) === want);
        if (row) return { row, t: tickets.get(want), page: p };
      }
      return null;
    }

    /**
     * 在分页里找到**第一个**处于指定状态的行。
     *
     * ⚠️ 为什么必须按库里状态找而不是按 Tab 找：见文件头"状态 Tab 并不筛状态"那段实测。
     * ⚠️ 找不到时必须**报出来**而不是静默跳过 —— 跳过会让后面的断言空转成假绿。
     * ⚠️ 本函数**只用于只读断言**（六个状态的标签矩阵）。任何写操作必须走
     *    `openHandleOnNew()` / 自建夹具 + `assertWritableFixture()`（见文件头隔离闸）。
     */
    async function findRowByStatus(status, { maxPages = 30, diag = null } = {}) {
      // ⚠️ 原实现 maxPages=10（=200 行），且失败时一律报"库里没有" —— 那是**假性数据缺失**：
      //    数据库里明明有（S01 有 117 张 PROCESSING），只是没在前 10 页里被扫到。
      //    2026-10-16 实测：门店账号仅授权 S01、S01 共 424 张、其中 PROCESSING 117 张；
      //    最新一张 PROCESSING 仅比最新 9 张单旧 ⇒ 应在前几页内。⇒ 提高页数上限并**带诊断**失败。
      const totalPages = Math.min(Number(await cdp.evaluate(TOTAL_PAGES_EXPR)) || 1, maxPages);
      let scanned = 0;
      for (let p = 1; p <= totalPages; p += 1) {
        if (p > 1) {
          const r = await cdp.evaluate(gotoPageExpr(p));
          if (!r?.ok) break;
          await settle();
        }
        const snap = await snapshot();
        for (const row of snap.rows ?? []) {
          scanned += 1;
          const t = tickets.get(Number(row.rowKey));
          if (diag && t) diag.byStatus.set(t.status, (diag.byStatus.get(t.status) ?? 0) + 1);
          if (t && t.status === status) return { row, t, page: p };
        }
      }
      if (diag) {
        diag.scanned = scanned;
        diag.totalPages = totalPages;
      }
      return null;
    }

    // =======================================================================
    // 【判据 ①】每行只有一个按钮，且不是 CSS 隐藏；旧按钮墙不存在
    // =======================================================================
    console.log('\n──── ① 每行只有一个按钮（非 CSS 隐藏）· 旧按钮墙必须不存在 ────');
    let snap = await snapshot();
    if (!snap.rows.length) {
      no('列表有数据行', '0 行 —— 后续判据全部空转，按铁律 10 直接判红');
    } else {
      // 🔴 判据是「操作列里**总共**只有 1 个按钮」，不是"只有 1 个带主动作标记的"。
      //    只数主动作标记时，2026-10-09 的真实浏览器里出现过这样的页面：
      //    操作列两个按钮 —— 原生「查看」在前、我们的主动作在后，
      //    而主动作为「查看」的三个状态会显示**两个一模一样的「查看」**。
      //    那一次所有"主动作数量"断言全绿，是浏览器把它抓出来的。
      const multi = snap.rows.filter((r) => r.buttons.length !== 1);
      if (multi.length) {
        no(
          '每行操作列**总共**只有一个按钮',
          `${multi.length} 行不满足：` +
            multi.slice(0, 3).map((r) => `row#${r.rowKey}=[${r.buttons.map((b) => b.text || '<空>').join(',')}]`).join('、'),
        );
      } else {
        ok('每行操作列**总共**只有一个按钮', `${snap.rows.length} 行全部为 1`);
      }

      const notPrimary = snap.rows.filter((r) => r.buttons.length === 1 && !r.buttons[0].primary);
      if (notPrimary.length) {
        no('这唯一的按钮就是主动作', notPrimary.slice(0, 3).map((r) => `row#${r.rowKey}:${r.buttons[0].text}`).join('、'));
      } else {
        ok('这唯一的按钮就是主动作', `${snap.rows.length} 行均带 data-primary-action`);
      }

      const hidden = [];
      for (const r of snap.rows) {
        for (const b of r.buttons) if (!b.visible && b.text) hidden.push(`row#${r.rowKey}:${b.text}`);
      }
      if (hidden.length) no('操作列里没有 CSS 隐藏按钮', `${hidden.length} 个：${hidden.slice(0, 6).join('、')}`);
      else ok('操作列里没有 CSS 隐藏按钮（不是把按钮墙藏起来）', `共检查 ${snap.rows.length} 行`);

      const wall = [];
      for (const r of snap.rows) {
        for (const b of r.buttons) if (FORBIDDEN_LABELS.some((f) => b.text === f)) wall.push(`row#${r.rowKey}:${b.text}`);
      }
      if (wall.length) no('界面上不存在旧按钮墙（受理/派工/改派/改约/详情/编辑/删除）', wall.slice(0, 8).join('、'));
      else ok('界面上不存在旧按钮墙（受理/派工/改派/改约/详情/编辑/删除）', `${snap.rows.length} 行操作列全部核对`);

      // =====================================================================
      // 【判据 ①b · UX-01A】工单号是**可点击链接**：独立于"处理/跟进"，指向本行，点击打开本行详情。
      //   行操作列仍只有一个按钮（①已证）；查看入口落在**工单号列**上。
      // =====================================================================
      console.log('\n──── ①b 工单号是可点击链接（独立于处理/跟进；指向本行；点击打开详情）────');
      const linkRows = snap.rows.filter((r) => r.ticketNoLink && r.ticketNoLink.ticketId);
      if (linkRows.length !== snap.rows.length) {
        no(
          '①b 每行工单号是可点击链接',
          `${snap.rows.length - linkRows.length}/${snap.rows.length} 行缺少 [data-testid=ticket-no-link]`,
        );
      } else {
        ok('①b 每行工单号是可点击链接', `${linkRows.length} 行均有`);
      }
      const linkMismatch = linkRows.filter((r) => String(r.ticketNoLink.ticketId) !== String(r.rowKey));
      if (linkMismatch.length) {
        no(
          '①b 工单号链接指向**本行**工单',
          linkMismatch.slice(0, 3).map((r) => `row#${r.rowKey}→${r.ticketNoLink.ticketId}`).join('、'),
        );
      } else if (linkRows.length) {
        ok('①b 工单号链接指向**本行**工单', `${linkRows.length} 行 data-ticket-id 与行号一致`);
      }
      if (linkRows.length) {
        const first = linkRows[0];
        await cdp.evaluate(
          `(() => { const a=[...document.querySelectorAll('[data-testid="ticket-no-link"]')].find(x=>x.offsetParent!==null); if(a) a.click(); return !!a; })()`,
        );
        let opened = false;
        try {
          await cdp.waitFor(`!!document.querySelector('.ant-drawer-title')`, {
            what: '工单号链接打开的只读详情抽屉',
            timeout: 15000,
          });
          opened = true;
        } catch {
          opened = false;
        }
        const title = opened
          ? String(await cdp.evaluate(`(document.querySelector('.ant-drawer-title')?.innerText || '').trim()`))
          : '';
        if (opened && title.includes(String(first.ticketNoLink.text))) {
          ok('①b 点击工单号打开**本行**只读详情', `抽屉标题「${title}」含「${first.ticketNoLink.text}」`);
        } else {
          no(
            '①b 点击工单号打开**本行**只读详情',
            `抽屉未打开或标题不符：title=「${title}」期望含「${first.ticketNoLink.text}」`,
          );
        }
        await cdp.evaluate(
          `(() => { const b=document.querySelector('.ant-drawer-close'); if(b) b.click(); return true; })()`,
        );
        await new Promise((r) => setTimeout(r, 400));
      }

      // =====================================================================
      // 【判据 ①c · UX-01A §四】非「查看」主按钮的行，有**只读「查看」文本链接**
      //   —— 键盘可达、指向本行、点击打开本行详情；且它**不是 button**（判据① 不受影响）。
      // =====================================================================
      console.log('\n──── ①c 非查看态的行有只读「查看」链接（键盘可达、指向本行）────');
      /**
       * 🔴 2026-10-17：不能只看第 1 页。
       *    第 1 页恰好全是「查看」态（终态）时，`needView` 为 0 ⇒ 下面两条断言
       *    **整段不执行**（63 项 vs 65 项），看起来"全绿"，实际少验了两件事。
       *    ⇒ 只读翻页找到至少一行非「查看」态；找不到才允许跳过（并明确打印原因）。
       */
      let cSnap = snap;
      let cPage = 1;
      let needView = cSnap.rows.filter((r) => r.buttons[0]?.primary && r.buttons[0]?.text !== '查看');
      const cMax = Math.min(Number(await cdp.evaluate(TOTAL_PAGES_EXPR)) || 1, 15);
      while (needView.length === 0 && cPage < cMax) {
        cPage += 1;
        const r = await cdp.evaluate(gotoPageExpr(cPage));
        if (!r?.ok) break;
        await settle();
        cSnap = await snapshot();
        needView = cSnap.rows.filter((r2) => r2.buttons[0]?.primary && r2.buttons[0]?.text !== '查看');
      }
      if (needView.length) {
        console.log(`  · 非「查看」态行位于第 ${cPage} 页（共找到 ${needView.length} 行）`);
      } else {
        console.log(`  · 扫描 ${cPage} 页仍无非「查看」态行 —— ①c 的键盘/点击断言本轮未验到（按纪律不写成通过）`);
      }
      const badLink = needView.filter((r) => !r.viewLink || String(r.viewLink.ticketId) !== String(r.rowKey));
      if (badLink.length) {
        no('①c 非查看态的行有「查看」链接（指向本行）', badLink.slice(0, 3).map((r) => `row#${r.rowKey}:${JSON.stringify(r.viewLink)}`).join('、'));
      } else ok('①c 非查看态的行有「查看」链接（指向本行）', `${needView.length} 行`);
      const notFocusable = needView.filter((r) => r.viewLink && !r.viewLink.focusable);
      if (notFocusable.length) no('①c 「查看」链接可键盘聚焦', `${notFocusable.length} 行 tabIndex < 0`);
      else if (needView.length) ok('①c 「查看」链接可键盘聚焦', 'tabIndex ≥ 0（非空 <a>）');
      // 「查看」态的行**不重复**加链接
      const viewRows = cSnap.rows.filter((r) => r.buttons[0]?.primary && r.buttons[0]?.text === '查看');
      const dup = viewRows.filter((r) => r.viewLink);
      if (dup.length) no('①c 「查看」态行不重复加链接', `${dup.length} 行多了一个「查看」`);
      else if (viewRows.length) ok('①c 「查看」态行不重复加链接', `${viewRows.length} 行均为单主按钮`);
      // 点第一行的「查看」链接 → 打开**本行**详情
      if (needView.length) {
        const target = needView[0];
        const expectNo = tickets.get(Number(target.rowKey))?.ticketNo ?? '';
        await cdp.evaluate(
          `(() => { const a=[...document.querySelectorAll('[data-testid="row-view-link"]')].find(x => x.closest('tr[data-row-key]')?.getAttribute('data-row-key') === '${target.rowKey}'); if(a) a.click(); return !!a; })()`,
        );
        let opened = false;
        try {
          await cdp.waitFor(`(document.querySelector('.ant-drawer-title')?.innerText||'').includes(${JSON.stringify(expectNo)})`, {
            what: '行内「查看」链接打开的详情',
            timeout: 25_000,
          });
          opened = true;
        } catch { opened = false; }
        if (opened) ok('①c 行内「查看」链接打开**本行**详情', `工单 ${expectNo}`);
        else no('①c 行内「查看」链接打开**本行**详情', `未打开或不是本行（期望 ${expectNo}）`);
        await cdp.evaluate(`(() => { const b=document.querySelector('.ant-drawer-close'); if(b) b.click(); return true; })()`);
        await new Promise((r) => setTimeout(r, 400));
      }
      // ①c 若曾翻页，恢复到第 1 页：后续 ③ 用的是 `snap`（第 1 页快照），
      // DOM 必须与快照一致，否则"按 rowKey 找按钮"会找不到（假红）。
      if (cPage !== 1) {
        await cdp.evaluate(gotoPageExpr(1));
        await settle();
      }

      const badLabel = [];
      for (const r of snap.rows) {
        for (const b of r.buttons) if (b.primary && !PRIMARY_LABELS.includes(b.text)) badLabel.push(`row#${r.rowKey}:${b.text}`);
      }
      if (badLabel.length) no('主动作标签都属于契约集合', badLabel.slice(0, 6).join('、'));
      else ok('主动作标签都属于契约集合', PRIMARY_LABELS.join('/'));
    }

    // =======================================================================
    // 【判据 ③】点击永远作用于当前行
    // =======================================================================
    console.log('\n──── ③ 点击作用于**当前行**（抽屉工单号必须等于该行工单号）────');

    /**
     * ⚠️ 这一条原来取的是 `(snap.rows ?? [])[0]` —— **第一行**，
     *    然后断言"点击后打开的抽屉里含本行工单号"。
     *
     *    这个断言隐含了一个没写出来的前提：**「点主动作 ⇒ 打开详情抽屉」**。
     *    但按契约只有三种状态满足它：
     *      · WAIT_STORE_CONFIRM → 「审核结果」 → 详情抽屉
     *      · WAIT_FEEDBACK / CLOSED / CANCELLED → 「查看」 → 详情抽屉
     *    而 NEW → 「处理」打开的是**处理窗口**、PROCESSING → 「跟进」打开的是
     *    **记录跟进弹窗**，两者都不展示工单号 —— 命中这两种状态时，
     *    这条断言会红，而**产品是对的**（失败文案却是"抽屉文本未包含工单号"，
     *    读起来像"点错了行"，会把排障方向整个带偏）。
     *
     *    它此前一直是绿的，只因为列表按 `-createdAt` 排序、而首行恰好长期是
     *    打开抽屉的那几种状态 —— 是**数据依赖的正确**，不是判据正确。
     *    2026-10-10 首行变成 PROCESSING（验收脚本新建的单排在前面）⇒ 立刻暴露。
     *
     * ⇒ 改为**显式**挑一个"主动作 = 打开详情抽屉"的状态；找不到就明说，不空转。
     */
    const DRAWER_STATUSES = ['WAIT_STORE_CONFIRM', 'WAIT_FEEDBACK', 'CLOSED', 'CANCELLED'];
    let picked = null;
    for (const st of DRAWER_STATUSES) {
      // eslint-disable-next-line no-await-in-loop
      const found = await findRowByStatus(st);
      if (found) {
        picked = found;
        break;
      }
    }
    const anyRow = picked?.row ?? null;
    if (!anyRow) {
      no(
        '③ 找到一个"主动作=打开详情"的行用于"点击不错行"核对',
        `${DRAWER_STATUSES.join(' / ')} 在当前门店列表里都没有（判据空转 ⇒ 按铁律 10 判红）`,
      );
    } else {
      const t = tickets.get(Number(anyRow.rowKey));
      const clickRes = await cdp.evaluate(clickPrimaryExpr(anyRow.rowKey));
      if (!clickRes?.ok) {
        no('③ 点到了可见表格里的主动作按钮', JSON.stringify(clickRes));
      } else if (clickRes.ticket !== String(anyRow.rowKey)) {
        no('③ 点到的按钮属于当前行', `按钮 data-ticket-id=${clickRes.ticket}，期望 ${anyRow.rowKey}`);
      } else {
        ok('③ 点到的按钮属于当前行', `data-ticket-id=${clickRes.ticket} · 标签 ${clickRes.label}`);
      }
      await sleep(2500);
      const drawer = await cdp.evaluate(VISIBLE_OVERLAY_EXPR);
      if (!drawer) {
        no('③ 点击主动作打开了服务详情', '没有出现可见的抽屉/弹窗');
      } else if (t && drawer.includes(t.ticketNo)) {
        ok('③ 点击作用于当前行', `抽屉含本行工单号 ${t.ticketNo}（row#${anyRow.rowKey}）`);

        // ---------------------------------------------------------------------
        // 【Phase 11 / P11-1 §6.1】服务详情必须展示这四个字段的行
        // ---------------------------------------------------------------------
        // §6.1 规定详情首页的字段顺序，包含：服务地址（客户块）、家电类型与品牌型号（服务事项块）。
        //
        // ⚠️ 这里断言的是**标签存在**，不是值 —— 夹具工单的这四个字段多半是空的，
        //    而"空值也要显示那一行"正是 §6.1 的要求（缺行会让一线人员以为系统没这个字段）。
        //    值的正确性由 `verify-store-entry` §8/§10 在真库上核对（那条链更硬）。
        // ⚠️ 顶部「紧急」标记**不在此列**：它只在为真时渲染（刻意不给每张单挂灰标签），
        //    所以对一张非紧急的夹具单断言它"存在"会是一条**恒红**断言。
        // ⚠️ 本段注释里**不能出现** `星号+斜杠` 的相邻组合（那会提前闭合块注释，
        //    让后面的中文变成代码 —— 实际报的是 `Unexpected token ')'`，
        //    指向的却是"字段列表那一行"，与真实原因毫无关系）。
        const REQUIRED_LABELS = ['客户', '联系电话', '服务地址', '所属门店', '家电类型', '品牌/型号', '问题描述'];
        const missingLabels = REQUIRED_LABELS.filter((l) => !String(drawer).includes(l));
        if (missingLabels.length === 0) {
          ok('③ 详情按 §6.1 展示服务事项字段', REQUIRED_LABELS.join(' / '));
        } else {
          no(
            '③ 详情按 §6.1 展示服务事项字段',
            `缺标签：${missingLabels.join(' / ')} —— 缺行会让一线人员以为系统没有这个字段`,
          );
        }
        // ---------------------------------------------------------------------
        // 【文案一致性】同一张单的**状态**在"列表状态列"与"详情抽屉"里必须逐字相同。
        //
        // 为什么这样比"断言抽屉里写着「待处理」"更强：不需要再维护第三份标签表。
        // 两个界面都从共享常量渲染 ⇒ 只要有一处漏改（例如只改了 Tab、
        // 忘了库里的字段元数据），这两处就会当场不一致。
        //
        // 2026-10-10 的真实动机：NEW 的文案从「待受理」改成「待处理」时，
        // 字段元数据是**已落库**的（`fields.options.uiSchema.enum`），
        // 改代码常量不会自动更新它 —— 于是很容易出现"Tab 改了、状态列没改"。
        // ---------------------------------------------------------------------
        const drawerText = String(drawer).replace(/\s+/g, '');
        const rowStatus = String(anyRow.statusText ?? '').replace(/\s+/g, '');
        if (!rowStatus) {
          no('③ 能读到本行状态列文本', `状态列表头定位结果 statusIdx=${anyRow.statusIdx}`);
        } else if (!drawerText.includes(rowStatus)) {
          no(
            '③ 列表状态列与详情抽屉的状态文案一致',
            `列表写「${rowStatus}」，抽屉里找不到该文案（抽屉开头：${String(drawer).replace(/\s+/g, ' ').slice(0, 140)}）`,
          );
        } else {
          ok('③ 列表状态列与详情抽屉的状态文案一致', `两处都是「${rowStatus}」`);
        }
        // 旧文案不得复活 —— 判据**精确到被禁的那个词**：`待受理`。
        //
        // ⚠️ 第一版写的是"抽屉里不出现『受理』"，实测**判红**，而红的是判据自己：
        //    抽屉底部「处理记录」会渲染**历史事件名**，其中
        //    `constants.ts` 的 `[EVENT_TYPE.ACCEPTED]: '门店已受理'` 含「受理」二字。
        //    那是"这张单**过去真的发生过**受理"的如实记载（历史事实，
        //    不能因为现在流程改了就把历史抹掉 —— 本项目的硬纪律）。
        //    用户 2026-10-10 的裁决范围是 **NEW 的状态文案**：
        //    「统一显示为『待处理』，不再出现『待受理』」。
        //    ⇒ 判据收窄到 `待受理`，既不放过真问题，也不把历史记载误判成违规。
        if (/待受理/.test(drawerText)) {
          no('③ 详情抽屉里没有「待受理」字样', `抽屉文本出现了「待受理」`);
        } else {
          ok('③ 详情抽屉里没有「待受理」字样', '（NEW 的状态文案已统一为「待处理」）');
        }
      } else {
        no(
          '③ 点击作用于当前行',
          `抽屉文本未包含本行工单号 ${t?.ticketNo}（该行状态 ${t?.status ?? '?'}，` +
            `按钮标签「${clickRes?.label ?? '?'}」）；打开的东西开头：` +
            `${String(drawer).replace(/\s+/g, ' ').slice(0, 160)}`,
        );
      }
      await cdp.evaluate(CLOSE_OVERLAY_EXPR);
      await sleep(900);
    }

    // =======================================================================
    // 【判据 ④】NEW → 「处理」窗口五种选择 + 真实执行
    // =======================================================================
    console.log('\n──── ④ NEW → 「处理」窗口五种选择 · 且真的执行业务写操作 ────');

    /**
     * 为 ④ 准备一张**本轮自建**的 NEW 工单并点开「处理」窗口。
     *
     * 🔴 2026-10-17 整改（UX-MEDIA-01 验收发现的事故）：
     *    原实现是"先找库里任意一张 NEW，找不到才自建"。于是它每天都会
     *    **拿一张真实客户工单去做取消/电话解决** —— 只要那张单恰好是列表里最新的 NEW。
     *    实测受害者：`FW20261017-0015`（为视频验收创建的合成单）被 ④-b 改成 CANCELLED。
     *    ⇒ 现在**无条件自建**，并只用 `findRowById()` 定位自己那张。
     *    自建走真实匿名入口（`createScratchTicket`），带唯一手机号与 `[UIPA-NEW]` 标记。
     */
    async function openHandleOnNew(tag = 'UIPA-NEW') {
      let made;
      try {
        made = await createScratchTicket({
          tag,
          content: '主动作门禁：本轮自建待处理单（仅本脚本写入，跑完按 id 清理）',
        });
      } catch (error) {
        // 建不出来 = 环境阻塞：**报红并停止这条用例**，不回退到任何既有工单
        no('④ 自建 NEW 夹具', `环境阻塞：${String(error?.message ?? error).slice(0, 200)}`);
        return null;
      }
      registerFixture(made.ticketId);

      // 新单不在已加载页面，也不在脚本手里的 tickets 快照里 ⇒ 两样都要刷新
      tickets = ticketMap();
      await closeOverlay();
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${schemaUid}` });
      await cdp.waitFor(
        'document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0',
        { what: '自建 NEW 后表格到位', timeout: 60_000 },
      );
      await settle();

      const found = await findRowById(made.ticketId);
      if (!found) {
        no('④ 自建 NEW 夹具可在列表定位', `已建 #${made.ticketId} ${made.ticketNo}，但列表里找不到`);
        return null;
      }
      const clickRes = await cdp.evaluate(clickPrimaryExpr(found.row.rowKey));
      if (!clickRes?.ok) return { ...found, clickRes, clickFailed: true };
      await cdp.waitFor(`document.querySelectorAll('[data-testid="handle-choices"]').length > 0`, {
        what: '处理窗口的五种选择出现',
        timeout: 20_000,
      });
      console.log(`  · ④ 使用本轮自建夹具 #${made.ticketId}（${made.ticketNo}）`);
      return { ...found, clickRes };
    }

    let target = await openHandleOnNew('UIPA-NEW-1');
    if (!target) {
      no('④ 找到 NEW 工单并打开「处理」窗口', '本轮自建夹具不可用（环境阻塞，不回退到真实工单）');
    } else if (target.clickFailed) {
      no('④ 点到了可见的主动作按钮', JSON.stringify(target.clickRes));
    } else if (target.clickRes?.ticket !== String(target.row.rowKey)) {
      no('④ 点到的按钮属于当前行', `按钮 data-ticket-id=${target.clickRes?.ticket}，期望 ${target.row.rowKey}`);
    } else {
      const choices = await cdp.evaluate(
        `[...document.querySelectorAll('[data-testid="handle-choices"] [data-choice]')]
           .map(b => ({ key: b.getAttribute('data-choice'), text: (b.innerText || '').trim().split('\\n')[0] }))`,
      );
      // 🔴 **四种**（Phase 11 / P11-1，用户 2026-10-10 裁决：门店独立运营、取消跨店转单）。
      //    第五种 `transfer` 已随能力撤销一起移除 —— 所以这里**必须**同时断言"它不在"：
      //    只断言"四种都在"的话，将来有人把它加回来也不会报警。
      const KEYS = ['inhouse', 'external', 'remote', 'cancel'];
      const hasAll = KEYS.every((k) => choices.some((c) => c.key === k));
      if (choices.length === KEYS.length && hasAll) {
        ok('④ 「处理」窗口给出四种选择', choices.map((c) => `${c.key}=${c.text}`).join('、'));
      } else {
        no('④ 「处理」窗口的四种选择不全', `实际 ${JSON.stringify(choices)}`);
      }
      if (choices.some((c) => c.key === 'transfer')) {
        no('④ 「转给其他门店」选项**不得**再出现', '跨店转单能力已撤销，界面不得提供入口');
      } else {
        ok('④ 「转给其他门店」选项已移除（不是隐藏，是能力撤销）', '界面上没有 transfer 选项');
      }

      // ---------------------------------------------------------------------
      // ④-c 【裁决 C】弹窗必须**能关掉**：右上角有一个清晰可点击的 ×
      //
      // 🔴 这一组断言的由来：E11-P0 的走查发现「处理」弹窗用的是
      //    `Modal.info({ footer: null })` —— antd 的 `Modal.method` 系列
      //    **默认 `closable: false`**，也就是**没有 ×**。员工面对一整张表单时
      //    没有任何"放弃"的入口。当时只是加了个「取消」按钮绕过，没真修。
      //    修法是换成受控弹窗 kit（`closable: true`），而**是否真的渲染出 ×
      //    并真的能关掉，只能由真实浏览器回答** —— 就是这里。
      //
      // ⚠️ 判据必须落在"点下去之后 DOM 里没了"而不是"存在 `.ant-modal-close` 元素"：
      //    元素可能存在但被 CSS 隐藏 / 被遮罩挡住 —— 那属于"看起来有、其实点不到"。
      // ---------------------------------------------------------------------
      const closeBtn = await cdp.evaluate(
        `(() => {
          const el = [...document.querySelectorAll('.ant-modal')].find((d) => {
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(d).display !== 'none';
          });
          if (!el) return { ok: false, why: 'no-visible-modal' };
          const btn = el.querySelector('.ant-modal-close');
          if (!btn) return { ok: false, why: 'no-close-button' };
          const r = btn.getBoundingClientRect();
          const cs = getComputedStyle(btn);
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            ok: true,
            visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
            // 命中测试：点在这个坐标上，真正收到点击的必须是 × 本身或它的子节点
            clickable: !!hit && (hit === btn || btn.contains(hit)),
            size: [Math.round(r.width), Math.round(r.height)],
          };
        })()`,
      );
      if (!closeBtn?.ok) {
        no('④-c 「处理」弹窗有右上角关闭按钮（×）', JSON.stringify(closeBtn));
      } else if (!closeBtn.visible || !closeBtn.clickable) {
        no(
          '④-c 关闭按钮可见且可点击',
          `visible=${closeBtn.visible} clickable=${closeBtn.clickable} size=${closeBtn.size} —— ` +
            '存在但点不到等于没有',
        );
      } else {
        ok('④-c 「处理」弹窗有可见可点击的右上角 ×', `尺寸 ${closeBtn.size.join('×')}`);
      }

      // 点它，并断言**弹窗与遮罩都消失**（残留遮罩会让整页点不动，比"关不掉"更糟）
      const closedByX = await cdp.evaluate(CLOSE_OVERLAY_EXPR);
      await sleep(600);
      const residual = await cdp.evaluate(
        `(() => ({
          modals: [...document.querySelectorAll('.ant-modal-wrap, .ant-modal-mask')].filter((d) => {
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(d).display !== 'none';
          }).length,
        }))()`,
      );
      if (closedByX?.via !== 'close-button') {
        no(
          '④-c 关闭按钮真的执行了关闭',
          `CLOSE_OVERLAY 走的不是 ×（via=${closedByX?.via ?? 'none'}）—— 说明 × 不存在或不可点`,
        );
      } else if (Number(residual?.modals) !== 0) {
        no('④-c 关闭后不残留遮罩', `仍可见 ${residual?.modals} 个 modal wrap/mask —— 页面会点不动`);
      } else {
        ok('④-c 点 × 后弹窗关闭且无残留遮罩', `via=close-button · 残留 ${residual?.modals} 个`);
      }

      // 重新打开 ⇒ 页面仍然可用（"关掉只是把页面弄死"是另一种失败）
      const reopen = await cdp.evaluate(clickPrimaryExpr(target.row.rowKey));
      if (!reopen?.ok) {
        no('④-c 关闭后能重新打开「处理」', JSON.stringify(reopen));
      } else {
        await sleep(900);
        const reopened = await cdp.evaluate(
          `document.querySelectorAll('[data-testid="handle-choices"] [data-choice]').length`,
        );
        if (Number(reopened) !== 4) no('④-c 重新打开后仍是四种选择', `实际 ${reopened}`);
        else ok('④-c 关闭后能重新打开且内容完整', `四种选择都在（遮挡与状态都没有残留）`);
      }

      // --- ④-b 真的执行：客户取消 ---
      // 🔴 写闸：只允许命中本轮自建夹具（用户 2026-10-17 裁决 §一）
      assertWritableFixture(target.row.rowKey, '④-b 客户取消');
      await cdp.evaluate(`document.querySelector('[data-choice="cancel"]').click()`);
      await sleep(700);
      await cdp.waitFor(
        `document.querySelectorAll('[data-testid="handle-form"] [data-field="reason"]').length > 0`,
        { what: '取消原因输入框出现', timeout: 15_000 },
      );
      await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-testid="handle-form"] [data-field="reason"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, 'P11-0 浏览器验收：客户明确不再需要服务');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(400);
      await cdp.evaluate(`document.querySelector('[data-testid="handle-form"] [data-action="save"]').click()`);
      await sleep(3000);
      const afterCancel = statusOfId(target.row.rowKey);
      const msgCancel = await lastMessage();
      if (afterCancel === 'CANCELLED') {
        ok('④ 客户取消真的写库', `工单 #${target.row.rowKey}（${target.t.ticketNo}）→ CANCELLED`);
        created.cancelledId = Number(target.row.rowKey);
      } else {
        no(
          '④ 客户取消真的写库',
          `工单 #${target.row.rowKey} 状态 ${afterCancel || '<空>'}（期望 CANCELLED）` +
            `；界面提示：${msgCancel || '<无>'}`,
        );
      }
      await closeOverlay();
      await settle();
      tickets = ticketMap();
    }

    // --- ④-c 真的执行：电话 / 门店直接解决（顺便为「已闭环」铺路）---
    // ⚠️ 同样**无条件自建**第二张夹具：第一张已被 ④-b 改成 CANCELLED，
    //    不能回头再去"找一张 NEW"，那又会落到真实工单上。
    target = await openHandleOnNew('UIPA-NEW-2');
    if (!target) {
      no('④-c 自建第二张 NEW 夹具', '本轮自建夹具不可用（环境阻塞，不回退到真实工单）');
    } else if (target.clickFailed || target.clickRes?.ticket !== String(target.row.rowKey)) {
      no('④-c 点到当前行的主动作', JSON.stringify(target.clickRes));
    } else {
      assertWritableFixture(target.row.rowKey, '④-c 电话解决');
      await cdp.evaluate(`document.querySelector('[data-choice="remote"]').click()`);
      await sleep(700);
      await cdp.waitFor(`document.querySelectorAll('[data-testid="handle-form"]').length > 0`, {
        what: '电话解决表单出现',
        timeout: 15_000,
      });
      await cdp.evaluate(`(() => {
        const el = document.querySelector('[data-field="completion_note"]');
        if (el) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, 'P11-0 浏览器验收：电话指导客户已解决');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })()`);
      await sleep(400);
      await cdp.evaluate(`document.querySelector('[data-testid="handle-form"] [data-action="save"]').click()`);
      await sleep(3500);
      const afterRemote = statusOfId(target.row.rowKey);
      const msgRemote = await lastMessage();
      if (afterRemote === 'WAIT_FEEDBACK') {
        ok('④ 电话/门店直接解决真的写库', `工单 #${target.row.rowKey}（${target.t.ticketNo}）→ WAIT_FEEDBACK`);
        created.remoteId = Number(target.row.rowKey);
      } else {
        no(
          '④ 电话/门店直接解决真的写库',
          `工单 #${target.row.rowKey} 状态 ${afterRemote || '<空>'}（期望 WAIT_FEEDBACK）` +
            `；界面提示：${msgRemote || '<无>'}`,
        );
      }
      await closeOverlay();
      await settle();
      tickets = ticketMap();
    }

    // =======================================================================
    // 【判据 ⑤】PROCESSING → 「跟进」能保存
    // =======================================================================
    console.log('\n──── ⑤ PROCESSING → 「跟进」保存（库里必须出现 follow_up 事件）────');

    /**
     * 🔴 2026-10-17 整改：**自建** PROCESSING 夹具，不再"按状态挑一张"。
     *
     * 原实现切到「处理中」Tab 后取**第一张** PROCESSING —— 那是一张真实客户工单，
     * 而"跟进"会往它的事件时间线里写一条 follow_up（有业务副作用）。
     * 用户裁决：所有写操作只能用本次创建的工单。
     *
     * 造法走真实服务端路径（与门店 UI 的「安排上门」同一条）：建单 → `svc:dispatch`，
     * 工单即进入 PROCESSING；不伪造状态、不直接 UPDATE。
     */
    let procFixture = null;
    try {
      const made = await createScratchTicket({
        tag: 'UIPA-PROC',
        content: '主动作门禁：本轮自建处理中单（仅本脚本写跟进，跑完按 id 清理）',
      });
      registerFixture(made.ticketId);
      const storeTok = await signIn(STORE_EMAIL, STORE_PASSWORD);
      const disp = await svcPost(
        'dispatch',
        made.ticketId,
        storeTok,
        {
          technician_name: '主动作验收师傅',
          technician_mobile: '13900010008',
          expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
          service_mode: 'inhouse',
        },
        crypto.randomUUID(),
      );
      if (disp.status !== 200) throw new Error(`派工失败 HTTP ${disp.status} ${String(disp.body).slice(0, 140)}`);
      const st = statusOfId(made.ticketId);
      if (st !== 'PROCESSING') throw new Error(`派工后状态是「${st}」，期望 PROCESSING`);
      procFixture = made;
      // 新单不在已加载页面里 ⇒ 重新加载 + 刷新快照
      tickets = ticketMap();
      await closeOverlay();
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${schemaUid}` });
      await cdp.waitFor(
        'document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0',
        { what: '自建 PROCESSING 后表格到位', timeout: 60_000 },
      );
      await settle();
      console.log(`  · ⑤ 使用本轮自建夹具 #${made.ticketId}（${made.ticketNo}）`);
    } catch (error) {
      no(
        '⑤ 自建 PROCESSING 夹具',
        `环境阻塞：${String(error?.message ?? error).slice(0, 220)}（不回退到真实工单）`,
      );
    }

    // 切到「处理中」Tab：让服务端把范围筛成 PROCESSING，避免脆弱的分页定位
    const clickedTab = await cdp.evaluate(
      `(() => { const t=[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.innerText||'').trim()==='处理中'); if(t){ t.click(); return true; } return false; })()`,
    );
    if (clickedTab) {
      await sleep(1500);
      await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '切到「处理中」Tab', timeout: 20_000 }).catch(() => {});
    } else {
      console.log('  · 未找到「处理中」Tab，按 id 直接定位');
    }
    const proc = procFixture ? await findRowById(procFixture.ticketId) : null;
    if (!proc) {
      no(
        '⑤ 找到 PROCESSING 夹具',
        procFixture
          ? `夹具 #${procFixture.ticketId} 建成了，但列表里定位不到（环境阻塞，不回退）`
          : '夹具未建成（环境阻塞，不回退到真实工单）',
      );
    } else {
      const label = proc.row.buttons.find((b) => b.primary)?.text;
      if (label !== '跟进') no('⑤ PROCESSING 行的主动作标签为「跟进」', `实际「${label}」`);
      else ok('⑤ PROCESSING 行的主动作标签为「跟进」', `工单 #${proc.row.rowKey}（第 ${proc.page} 页）`);

      // 🔴 写闸：跟进的保存只允许写到本轮自建夹具
      assertWritableFixture(proc.row.rowKey, '⑤ 跟进');
      const before = countFollowUp(proc.row.rowKey);
      const clickRes = await cdp.evaluate(clickPrimaryExpr(proc.row.rowKey));
      if (!clickRes?.ok) {
        no('⑤ 点到了主动作按钮', JSON.stringify(clickRes));
      } else {
        await cdp.waitFor(`document.querySelectorAll('[data-testid="follow-form"]').length > 0`, {
          what: '跟进窗口出现',
          timeout: 20_000,
        });
        await cdp.evaluate(`(() => {
          const el = document.querySelector('[data-testid="follow-form"] [data-field="note"]');
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, 'P11-0 浏览器验收：已联系客户，约明天上午上门');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await sleep(400);
        const clickedSave = await cdp.evaluate(`(() => {
          // ⚠️ 文案要先去空白再比：antd 把两字按钮渲染成中间带空格的形式（保 存）。
          //    （这段字符串在外层模板字面量里 —— **注释中不能出现反引号**。）
          const sq = ${squashed};
          const btns = [...document.querySelectorAll('.ant-modal-footer button, .ant-modal-confirm-btns button, .ant-modal button')];
          const hit = btns.find(b => sq(b) === '保存');
          if (hit) hit.click();
          return { ok: !!hit, saw: btns.map(sq).slice(0, 8) };
        })()`);
        if (!clickedSave?.ok) no('⑤ 找得到跟进窗口的「保存」按钮', `看到的按钮：${JSON.stringify(clickedSave?.saw ?? null)}`);
        await sleep(3000);
        const after = countFollowUp(proc.row.rowKey);
        const msgFollow = await lastMessage();
        if (after === before + 1) {
          ok('⑤ 「跟进」真的写入一条 follow_up 事件', `工单 #${proc.row.rowKey}：${before} → ${after}`);
        } else {
          no(
            '⑤ 「跟进」真的写入一条 follow_up 事件',
            `工单 #${proc.row.rowKey}：${before} → ${after}（期望 +1）；界面提示：${msgFollow || '<无>'}`,
          );
        }
        await closeOverlay();
        await settle();
      }
    }

    // =======================================================================
    // 【判据 ⑥】WAIT_STORE_CONFIRM → 「审核结果」进得去
    // =======================================================================
    console.log('\n──── ⑥ WAIT_STORE_CONFIRM → 「审核结果」进入服务详情 ────');

    // 🔴 **自建夹具**，不去"库里找一张现成的"（2026-10-10，与闭环门禁 DEV-116 同型）。
    //
    //    原来这一步依赖"库里恰好有一张 WAIT_STORE_CONFIRM 的工单"。
    //    而**没有任何一步会生产它**（本脚本前面只做 NEW / PROCESSING 的行），
    //    它依赖的是**上一轮别的验收留下的残渣**。残渣被清掉（或本来就没有）时，
    //    这条断言就红，而失败文案"库里没有待门店确认的工单"看起来像环境问题。
    //    ⇒ 走真实业务路径自己造一张：建单 → 派工 → 师傅提交 ⇒ WAIT_STORE_CONFIRM。
    // ⚠️ 这个夹具**需要短信通道是开的**：师傅作业 Token 只出现在短信里
    //    （正文含明文、刻意不入库），而本机 `sms.enabled=false` ⇒ 连"入队"都不走
    //    ⇒ 派工后拿不到 Token ⇒ 造不出 WAIT_STORE_CONFIRM。
    //    本脚本原先只在**很后面**（评价链接那一段）才临时开它。
    //    ⇒ 在这里**局部**开关一次并立即还原，不改变后一段的既有语义
    //      （后一段会重新读原值，看到还是 false，照旧启用+还原）。
    const fxSmsOrig = psql(`SELECT value FROM service_settings WHERE key = 'sms.enabled'`).trim();
    const fxSetSms = (v) =>
      psql(`UPDATE service_settings SET value = '${v}', updated_at = now() WHERE key = 'sms.enabled'`);
    try {
      fxSetSms('true');
      // 等 ConfigService 的 TTL 过期，否则服务端仍读缓存里的 false（实测踩过）
      await sleep(11_000);

      const fxStore = await signIn(STORE_EMAIL, STORE_PASSWORD);
      const fxHq = await signIn(HQ_EMAIL, HQ_PASSWORD);
      const t = await createScratchTicket({
        tag: 'UIPA-CONFIRM',
        content: '主动作门禁：自建的待门店确认单',
      });
      uipaFixtureTicketId = registerFixture(t.ticketId);
      const d = await svcPost(
        'dispatch',
        t.ticketId,
        fxStore,
        {
          technician_name: '主动作验收师傅',
          technician_mobile: '13900010007',
          expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
          service_mode: 'inhouse',
        },
        crypto.randomUUID(),
      );
      if (d.status !== 200) throw new Error(`派工失败 HTTP ${d.status} ${String(d.body).slice(0, 140)}`);
      const tok = await tokenFromOutbox({
        sessionToken: fxHq,
        ticketNo: t.ticketNo,
        scene: 'technician_task',
      });
      if (typeof tok?.token !== 'string') throw new Error('取不到师傅 Token');
      await sleep(1500); // 师傅接口走独立限流区，上传前让开
      const up = await technicianUpload(tok.token, ensureFixtureJpeg(), { filename: 'uipa.jpg' });
      if (up.status !== 200 && up.status !== 201) throw new Error(`上传失败 HTTP ${up.status}`);
      const sub = await technicianSubmit(tok.token, {
        service_result: 'resolved',
        service_note: '主动作门禁：自建夹具，用于进入审核详情',
        is_charged: false,
      });
      if (sub.status !== 200) throw new Error(`提交失败 HTTP ${sub.status} ${String(sub.body).slice(0, 140)}`);
      // ⚠️ `psql()` **不做 trim**（本脚本的约定是调用点自己 trim）——
      //    不 trim 时值是 `WAIT_STORE_CONFIRM\n`，与字面量比较**必然不等**，
      //    而报错文案里两者看起来一模一样 —— 这正是最难查的那类假红。
      const st = psql(`SELECT status FROM service_tickets WHERE id = ${t.ticketId}`).trim();
      if (st !== 'WAIT_STORE_CONFIRM') throw new Error(`提交后状态是「${st}」`);

      // ⚠️ 新造的单**不在已加载的页面快照里** ⇒ 必须重新加载再找行。
      await closeOverlay();
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${schemaUid}` });
      await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', {
        what: '重新加载后表格到位',
        timeout: 60_000,
      });
      // 🔴 `findRowByStatus()` 查的是**本脚本手里那张 tickets 快照**（由 ticketMap() 构建），
      //    不是现场查库。刚造出来的单不在快照里 ⇒ 即使它在页面上也"找不到"
      //    （第一版就是这样：夹具造成功了，⑥ 却说"仍找不到"）。
      //    脚本自己在 ④/⑤ 之后也各刷新过一次（见 tickets = ticketMap()），此处同理。
      tickets = ticketMap();
      ok('自建 WAIT_STORE_CONFIRM 夹具（不再依赖库里存量残渣）', `#${t.ticketId} ${t.ticketNo}`);
    } catch (error) {
      no('自建 WAIT_STORE_CONFIRM 夹具', String(error?.message ?? error).slice(0, 220));
    } finally {
      // 如实还原（还原的是**原值**，不是硬编码 false），并回验
      try {
        fxSetSms(fxSmsOrig === '' ? 'false' : fxSmsOrig);
        const back = psql(`SELECT value FROM service_settings WHERE key = 'sms.enabled'`).trim();
        if (back !== fxSmsOrig) {
          console.log(`  · ⚠️ sms.enabled 还原后回验不符：期望 ${fxSmsOrig}，实际 ${back}`);
        }
      } catch (error) {
        console.log(`  · ⚠️ sms.enabled 还原失败：${String(error?.message ?? error).slice(0, 120)}`);
      }
    }

    const confirm = await findRowByStatus('WAIT_STORE_CONFIRM');
    if (!confirm) {
      no('⑥ 找到 WAIT_STORE_CONFIRM 工单', '自建之后仍找不到 —— 不伪造数据补绿');
    } else {
      const label = confirm.row.buttons.find((b) => b.primary)?.text;
      if (label !== '审核结果') no('⑥ WAIT_STORE_CONFIRM 行的主动作标签为「审核结果」', `实际「${label}」`);
      else ok('⑥ WAIT_STORE_CONFIRM 行的主动作标签为「审核结果」', `工单 #${confirm.row.rowKey}（第 ${confirm.page} 页）`);

      const clickRes = await cdp.evaluate(clickPrimaryExpr(confirm.row.rowKey));
      if (!clickRes?.ok) {
        no('⑥ 点到了主动作按钮', JSON.stringify(clickRes));
      } else {
        await sleep(2500);
        const drawer = await cdp.evaluate(VISIBLE_OVERLAY_EXPR);
        if (drawer && confirm.t && drawer.includes(confirm.t.ticketNo)) {
          ok('⑥ 「审核结果」打开了**本行**的服务详情', `抽屉含工单号 ${confirm.t.ticketNo}`);
        } else {
          no('⑥ 「审核结果」打开了本行的服务详情', `抽屉文本：${String(drawer).replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        await cdp.evaluate(CLOSE_OVERLAY_EXPR);
        await sleep(800);
      }
    }

    // =======================================================================
    // 【判据 ⑦】429 / 控制台错误 / 一直 loading
    // =======================================================================
    console.log('\n──── ⑦ 无 429 · 无可解释的控制台错误 · 无一直 loading ────');
    const code429 = calls.filter((c) => c.status === 429);
    if (code429.length === 0) ok('全程 0 个 429', `${calls.length} 个 /api 请求全部核对`);
    else no('全程 0 个 429', `${code429.length} 个：${[...new Set(code429.map((c) => c.url))].slice(0, 5).join('、')}`);

    const nowSpinning = await cdp.evaluate(SPINNING_EXPR);
    if (Number(nowSpinning) === 0) ok('当前不存在"一直 loading"的转圈', 'spinning = 0');
    else no('当前不存在"一直 loading"的转圈', `spinning = ${nowSpinning}`);

    // ⚠️ 与既有走查同一纪律：**只容忍** AxiosError 403 且数量不超过真实的 403 请求数。
    const err403 = calls.filter((c) => c.status === 403).length;
    const others = consoleErrors.filter((e) => !(/AxiosError/.test(e) && /403/.test(e)));
    if (others.length === 0) {
      ok('登录后控制台无不可解释的错误', consoleErrors.length ? `${consoleErrors.length} 条均为 AxiosError 403（≤ ${err403} 个真实 403）` : '0 条');
    } else {
      no('登录后控制台有不可解释的错误', `${others.length} 条，前 3 条：${others.slice(0, 3).join(' | ').slice(0, 320)}`);
    }

    await cdp.send('Browser.close').catch(() => {});
    ws.close();
  } finally {
    try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
    // ⚠️ 夹具**不在这里清理**：④-c 产出的 WAIT_FEEDBACK 夹具还要用于下面的
    //    客户评价闭环（同一张单），提前删掉会让那一步拿不到评价 Token。
    //    清理统一在 `cleanupAllFixtures()`（评价之后 / 异常路径）。
  }

  // =======================================================================
  // 浏览器之外的最后一步：以**真实客户评价**把工单推进到「已闭环」
  //   · 上面 ④-c 已经用浏览器做出一张 WAIT_FEEDBACK（评价 Token 已签发、短信已入队）
  //   · 从 mock 发件箱读出客户会收到的链接，以**匿名**身份提交评价
  //   · 同一份接口 = 客户点短信链接走的接口；唯一本机特有的一步是"读发件箱"
  // =======================================================================
  console.log('\n──── 补充：以真实客户评价把工单推进到「已闭环」────');
  if (!created.remoteId) {
    console.log('  · ④-c 未产出 WAIT_FEEDBACK 工单 —— 跳过（不伪造数据补绿）');
  } else {
    // ---- 临时打开 mock 短信通道（本机 `sms.enabled=false` ⇒ 发件箱恒空）----
    //
    // 为什么必须临时改这一项：评价链接只发到手机，而短信正文**刻意不进库**
    // （含 Token 明文），只存在于 mock 通道的内存发件箱。
    // `sms.enabled=false` 时连"入队"这一步都不走 ⇒ 发件箱 0 条 ⇒ 拿不到链接。
    //
    // 🔴 三条纪律：
    //   ① 只改 `sms.enabled` 一项，不动 provider（保持 mock，不会真发短信）；
    //   ② **无论成功失败都必须还原**，并回验还原结果（不回验 = 没还原）；
    //   ③ 记下原值，还原的是**原值**而不是硬编码 false。
    const before = psql(`SELECT value FROM service_settings WHERE key = 'sms.enabled'`).trim();
    let restoreOk = null;
    const setSmsEnabled = (v) =>
      psql(`UPDATE service_settings SET value = '${v}', updated_at = now() WHERE key = 'sms.enabled'`);
    try {
      if (before === 'true') {
        console.log(`  · sms.enabled 原值 ${before || '<空>'}（本就开启，不改）`);
      } else {
        setSmsEnabled('true');
        const now = psql(`SELECT value FROM service_settings WHERE key = 'sms.enabled'`).trim();
        if (now !== 'true') throw new Error(`临时开启短信失败（现值 ${now}）`);
        console.log(`  · 临时开启 mock 短信通道（原值 ${before || '<空>'}），仅用于取得客户评价链接`);
      }
    } catch (e) {
      no('临时开启 mock 短信通道', e.message);
    }

    // 评价链接是在**入队**时生成的。④-c 若发生在 `sms.enabled=false` 期间，
    // 短信没入队 ⇒ 需要重做一次「电话解决」。这条重做**只能作用于本轮自建夹具**：
    // 🔴 2026-10-17 整改：原实现是 `ORDER BY id DESC LIMIT 1` 从 NEW/PROCESSING 里挑一张
    //    —— 那又是一条"随时可能落到真实客户工单"的路（本次恰好挑中了自建夹具，
    //    但那是运气，不是保证）。现在改成：优先复用 ④-c 的夹具；否则只在
    //    `writableFixtures` 里挑；都没有 ⇒ 环境阻塞，不回退。
    try {
      const storeRes = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: new URL(SVC_BASE_URL).origin },
        body: JSON.stringify({ email: STORE_EMAIL, password: STORE_PASSWORD }),
      });
      const storeJson = await storeRes.json().catch(() => null);
      const storeToken = storeJson?.data?.token;
      if (!storeToken) throw new Error(`门店账号登录失败 HTTP ${storeRes.status}`);

      let candId = null;
      if (created.remoteId && statusOfId(created.remoteId) === 'WAIT_FEEDBACK') {
        candId = Number(created.remoteId);
        console.log(`  · 复用 ④-c 的夹具 #${candId}（已 WAIT_FEEDBACK，无需重做电话解决）`);
      } else {
        const ids = [...writableFixtures];
        const rows = ids.length
          ? psqlRows(
              `SELECT id FROM service_tickets WHERE id IN (${ids.join(',')}) ` +
                `AND status IN ('NEW','PROCESSING') ORDER BY id DESC LIMIT 1`,
            )
          : [];
        if (!rows.length) {
          throw new Error('本轮没有可用于评价闭环的自建夹具（不回退到真实工单）');
        }
        candId = Number(rows[0][0]);
        assertWritableFixture(candId, '评价闭环前的电话解决');
        const rid = crypto.randomUUID();
        const r = await fetch(`${SVC_BASE_URL}/api/svc:remoteComplete?filterByTk=${candId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: new URL(SVC_BASE_URL).origin,
            Authorization: `Bearer ${storeToken}`,
            'X-Request-Id': rid,
          },
          body: JSON.stringify({ completion_result: 'resolved', completion_note: 'P11-0 验收：电话解决', is_charged: false }),
        });
        if (r.status >= 400) throw new Error(`remoteComplete HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      }
      const st = statusOfId(candId);
      if (st !== 'WAIT_FEEDBACK') throw new Error(`remoteComplete 后状态 ${st}（期望 WAIT_FEEDBACK）`);
      created.remoteId = candId;
      console.log(`  · 以门店账号重做一次「电话解决」（短信此时已入队）：工单 #${candId} → ${st}`);
    } catch (e) {
      no('重做「电话/门店直接解决」以便短信入队', e.message);
    }

    const hqRes = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(SVC_BASE_URL).origin },
      body: JSON.stringify({ email: HQ_EMAIL, password: HQ_PASSWORD }),
    });
    const hqJson = await hqRes.json().catch(() => null);
    const hqToken = hqJson?.data?.token;
    if (!hqToken) {
      no('从 mock 发件箱取评价链接', `HQ 登录失败 HTTP ${hqRes.status}`);
    } else {
      const boxRes = await fetch(`${SVC_BASE_URL}/api/svc:smsOutbox`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${hqToken}`, Origin: new URL(SVC_BASE_URL).origin },
      });
      const box = await boxRes.json().catch(() => null);
      const items = box?.data?.items ?? [];
      // 🔴 判据**必须**走共享实现 `scripts/lib/review-token.mjs`，不得在这里内联。
      //    2026-10-09 这里红过一次，而红的是**判据自己**：内联版读
      //    `content ?? body ?? text`，可发件箱条目给的是 `preview` 与 `params.link`
      //    ⇒ 恒定取到 '' ⇒ 这条断言**永远绿不了**，而失败文案却像"产品没发短信"。
      //    现已抽成唯一实现，并由 `verify-outbox-review-token-selftest.mjs`
      //    用双向 fixture（含当天真实抓包样本 + 旧判据的变异对照）钉住。
      //
      // 🔴 第二层：**必须按工单号认领**。发件箱是**累积**的 —— 之前跑过的邀请仍躺在里面，
      //    "取第一条 review_invite" 会拿到**上一次那枚** Token（属于另一张工单）
      //    ⇒ 评价提交 404，而现象看起来又是"产品没发短信"（DEV-105 的同型第二次）。
      //    2026-10-09 的实测触发：一枚旧 Token 因安全处置被吊销后仍留在发件箱里。
      const wantTicketNo = psql(
        `SELECT ticket_no FROM service_tickets WHERE id = ${Number(created.remoteId)}`,
      ).trim();
      const reviewToken = reviewTokenFromOutbox(items, { ticketNo: wantTicketNo });
      if (!reviewToken) {
        no('从 mock 发件箱取评价链接', explainMissingReviewToken(items, { ticketNo: wantTicketNo }));
      } else {
        ok('从 mock 发件箱取到客户评价链接', `${reviewToken.slice(0, 8)}…（发件箱 ${items.length} 条）`);
        const revRes = await fetch(`${SVC_BASE_URL}/api/public/reviews/${reviewToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: new URL(SVC_BASE_URL).origin },
          body: JSON.stringify({ rating: 5, charge_match: 'not_applicable', comment: 'P11-0 验收：客户评价' }),
        });
        if (revRes.status < 400) {
          const st = statusOfId(created.remoteId);
          if (st === 'CLOSED') ok('匿名客户评价把工单推进到 CLOSED', `工单 #${created.remoteId} → CLOSED`);
          else no('匿名客户评价把工单推进到 CLOSED', `评价 HTTP ${revRes.status}，工单状态 ${st}`);
        } else {
          no('匿名客户评价把工单推进到 CLOSED', `HTTP ${revRes.status} ${(await revRes.text()).slice(0, 200)}`);
        }
      }
    }

    // ---- 还原 `sms.enabled`（**必须**回验，不回验 = 没还原）----
    try {
      setSmsEnabled(before === '' ? 'false' : before);
      const now = psql(`SELECT value FROM service_settings WHERE key = 'sms.enabled'`).trim();
      restoreOk = now === (before === '' ? 'false' : before);
      if (restoreOk) ok('还原 sms.enabled 并回验', `现值 ${now}（原值 ${before || '<空>'}）`);
      else no('还原 sms.enabled', `现值 ${now}，期望 ${before || 'false'}`);
    } catch (e) {
      no('还原 sms.enabled', e.message);
    }
    void restoreOk;
  }

  // =======================================================================
  // 【判据 ②】六个状态 → 正确标签（**全量扫描分页**，UI 文本 vs 库里状态）
  // =======================================================================
  console.log('\n──── ② 六个状态 → 正确标签（全量翻页，UI 文本与库里状态逐行交叉核对）────');
  {
    const finalTickets = ticketMap();
    const seen = new Map(); // status -> Set(标签)
    const chrome2 = spawn(
      findChrome(),
      ['--headless=new', `--remote-debugging-port=${DEBUG_PORT + 1}`, `--user-data-dir=${PROFILE_DIR}-scan`,
        '--no-first-run', '--disable-gpu', ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors'] : []),
        '--window-size=1400,1000', 'about:blank'],
      { stdio: 'ignore' },
    );
    try {
      const list = await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT + 1}/json/list`);
      const page = list.find((t) => t.type === 'page');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
      const cdp = new Cdp(ws);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
      await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
      await cdp.evaluate(`(() => {
        const ins = [...document.querySelectorAll('input')];
        const setVal = (el, val) => {
          const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          s.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(ins[0], ${JSON.stringify(STORE_EMAIL)});
        setVal(ins[1], ${JSON.stringify(STORE_PASSWORD)});
        return true;
      })()`);
      await sleep(800);
      await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
      await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${schemaUid}` });
      await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', { what: '数据到位', timeout: 60_000 });
      await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '首屏', timeout: 45_000 });

      const totalPages = Number(await cdp.evaluate(TOTAL_PAGES_EXPR)) || 1;
      let scannedPages = 0;
      let scannedRows = 0;
      for (let p = 1; p <= totalPages; p += 1) {
        if (p > 1) {
          const r = await cdp.evaluate(gotoPageExpr(p));
          if (!r?.ok) break;
          await sleep(1600);
        }
        const s = await cdp.evaluate(SNAPSHOT_EXPR);
        if (!s?.rows?.length) break;
        scannedPages += 1;
        scannedRows += s.rows.length;
        for (const row of s.rows) {
          const t = finalTickets.get(Number(row.rowKey));
          if (!t) continue;
          const primary = row.buttons.find((b) => b.primary);
          if (!primary) continue;
          if (!seen.has(t.status)) seen.set(t.status, new Set());
          seen.get(t.status).add(primary.text);
          // 顺带把"每行只有一个按钮"在全量行上一并核对（不只在首页核对）
          if (row.buttons.length !== 1) {
            no('② 扫描中发现某行操作列按钮数 ≠ 1', `row#${row.rowKey}（第 ${p} 页）= ${row.buttons.length}`);
          }
        }
      }
      console.log(`  · 扫描 ${scannedPages} 页 / ${scannedRows} 行`);
      if (scannedRows === 0) {
        no('② 扫描到数据行', '0 行 —— 判据空转');
      }
      for (const status of ALL_SIX) {
        const expect = loadRowActionMatrix().primaryActionOf(status)?.label ?? null;
        const got = seen.get(status);
        if (!got || got.size === 0) {
          // 数据没覆盖到 —— **不是**通过，是"本轮没验到"（与既有 skip 纪律一致）
          console.log(`  · ${status}：库里无数据（未验到，不算通过）`);
          continue;
        }
        const labels = [...got];
        if (expect && labels.length === 1 && labels[0] === expect) {
          ok(`${status} → 「${expect}」`, `${labels.join('/')}`);
        } else {
          no(`${status} 标签错误`, `期望「${expect}」，实际 ${labels.join(' / ')}`);
        }
      }
      const missingStatuses = ALL_SIX.filter((s) => !seen.has(s));
      if (missingStatuses.length) {
        console.log(`  · 未覆盖状态：${missingStatuses.join('、')}（按纪律记为"未验到"，不写成通过）`);
      }
      await cdp.send('Browser.close').catch(() => {});
      ws.close();
    } catch (e) {
      no('② 全量扫描完成', e.message);
    } finally {
      try { chrome2.kill('SIGKILL'); } catch { /* noop */ }
    }
  }

  // =======================================================================
  // 夹具收尾：所有断言跑完后，按 id 精确清理（白名单之外一个都不碰）
  //   · 放在 ② 之后：② 的"UI 文本 vs 库里状态"对照需要这些夹具仍在库里
  //   · 只删 `writableFixtures`（= 本次 `createScratchTicket` 创建的 id）
  // =======================================================================
  cleanupAllFixtures();

  // =======================================================================
  // 汇总
  // =======================================================================
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  if (failures.length === 0) {
    console.log(`  ✅ 全部通过：${passed.length} 项`);
    console.log('══════════════════════════════════════════════════════════════\n');
    process.exit(0);
  }
  console.log(`  ❌ 通过 ${passed.length} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`     • ${f.label}\n       ${f.detail}`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(1);
}

// ⚠️ **仅当直接执行本文件时**跑主门禁；被 `verify-ux-01a-final.mjs` 等 import 时**不自动运行**
//    （第九轮：把 CDP/查询等机制**开放复用**，避免在别处再抄一份 CDP 实现）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => {
    console.log(`\n  ⛔ 验收中断：${e.message}`);
    // 异常路径也必须收尾：否则一次中断会把自建夹具留在库里（且没有任何台账）
    try {
      cleanupAllFixtures();
    } catch { /* 清理失败不掩盖原始错误 */ }
    process.exit(1);
  });
}
