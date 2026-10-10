#!/usr/bin/env node
/**
 * verify-store-tab-filter.mjs —— **B-15 的真实浏览器验收：状态 Tab 必须服务端筛选**
 *
 * ===========================================================================
 * 为什么必须新写一份，而不是给 smoke-test 加一条断言
 * ===========================================================================
 * B-15 之所以能藏这么久，正是因为 smoke 那条断言的**判据选错了**：
 * 它核对的是库里 `props.defaultFilterValue` 的**内容**，而框架把默认筛选
 * **持久化**了却**从不在加载时应用**。于是"配置在"长期被当成"筛选生效"。
 *
 * 本脚本的判据全部落在**服务端实际返回了什么**：
 *   · 切 Tab 时浏览器发出的请求里，**有没有** filter 参数；
 *   · 请求带回的**记录集合**，是不是真的随 Tab 改变；
 *   · 返回的 `meta.count`，是不是等于**库里**（该门店 + 该状态）的真实条数；
 *   · 界面上看到的每一行，是不是都属于**本门店**。
 * 前两条合起来才能排除"前端只过滤当前 20 行"的伪实现 ——
 * 那种实现的 count 会与库里不符、第 2 页也会露馅，所以第 3 条是它的照妖镜。
 *
 * ===========================================================================
 * 🔴 「筛选生效」与「筛选压根没跑」必须能被区分
 * ===========================================================================
 * 如果 `TicketTabFilterModel` 根本没被实例化，界面表现与"筛选配置写错了"
 * **完全同形**（都是六个 Tab 显示同一批 20 行）。为区分两者，客户端在首次
 * 应用筛选时打一行 `console.info`（见 `src/client/tab-filter.tsx`）。
 * 本脚本把它作为**独立判据**：没有那行日志 ⇒ 直接判红并说明是"模型没跑"，
 * 不许用"请求里没 filter"含糊带过。
 *
 * ===========================================================================
 * 期望值从哪来（不抄第二份）
 * ===========================================================================
 *   · 各 Tab 的标题与状态：`expected-sensitive-columns.mjs` 的 `TICKET_STATUS_TABS`
 *     —— 与 `seed-admin-pages.mjs` 建页用的是**同一份常量**。
 *   · 该门店各状态的真实条数：**直接查库**（`service_tickets` 按 store_id 分组）。
 *   · 请求里应该出现的 filter 形态：由**客户端真实实现** `toRequestFilter()`
 *     算出（esbuild 编译后 require），不在本脚本里重写一遍转换规则。
 *
 * 用法：
 *   node scripts/verify-store-tab-filter.mjs              # 完整浏览器验收
 *   node scripts/verify-store-tab-filter.mjs --selftest   # 只跑转换规则 fixture
 * 退出码：0 全部通过 / 1 有未达标项 / 2 环境未就绪或**验收器自身**异常
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';
import { TICKET_STATUS_TABS } from './expected-sensitive-columns.mjs';

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
const SELFTEST_ONLY = process.argv.includes('--selftest');

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------
function envValue(key, fallback) {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm').exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : fallback;
  } catch {
    return fallback;
  }
}
const STORE_EMAIL = envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
const STORE_PASSWORD = envValue('UAT_STORE_A_PASSWORD', '');

// ---------------------------------------------------------------------------
// 库（唯一真值来源：门店归属与各状态条数）
// ---------------------------------------------------------------------------
function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '\u0001', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}

// ---------------------------------------------------------------------------
// 结果收集：每条都要么绿要么红（铁律：只打印不判 = 没有断言）
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

// ---------------------------------------------------------------------------
// 客户端真实实现（esbuild 编译后 require）—— 期望值不抄第二份
// ---------------------------------------------------------------------------
function loadTabFilterContract() {
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
  if (!esbuild) throw new Error('找不到 esbuild —— 无法加载客户端契约（环境未就绪，exit 2）');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entry = path.join(OUT_DIR, 'tab-filter-entry.ts');
  const outfile = path.join(OUT_DIR, 'tab-filter.cjs');
  fs.writeFileSync(
    entry,
    `export * from '${path.join(CLIENT_DIR, 'tab-filter').replace(/\\/g, '/')}';`,
    'utf8',
  );
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    // ⚠️ 不要静音：编译告警是"契约变了"的唯一早期信号
    logLevel: 'warning',
  });
  return nodeRequire(outfile);
}

/**
 * 状态**展示文案**的唯一来源：`server/constants.ts` 的 `TICKET_STATUS_LABEL`。
 *
 * 🔴 为什么必须编译后 require，而不是在脚本里再写一遍「NEW=待处理」：
 *    2026-10-10 用户裁决把 NEW 的界面文案从「待受理」改成「待处理」。
 *    如果本脚本自己抄一份期望值，那么"改了产品、忘了改脚本"时，
 *    脚本会拿旧期望去比新界面 ⇒ **判红**（假红）；反过来，
 *    脚本和界面同时错着，也会因为两边一致而**判绿**（假绿）。
 *    ⇒ 期望值一律从常量取，界面若与常量不符才是真的不一致。
 */
function loadStatusLabels() {
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
  if (!esbuild) throw new Error('找不到 esbuild —— 无法读取 TICKET_STATUS_LABEL（环境未就绪）');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entry = path.join(OUT_DIR, 'status-labels-entry.ts');
  const outfile = path.join(OUT_DIR, 'status-labels.cjs');
  fs.writeFileSync(
    entry,
    `export { TICKET_STATUS_LABEL } from '${path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server', 'constants').replace(/\\/g, '/')}';`,
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
  return nodeRequire(outfile).TICKET_STATUS_LABEL;
}

/** 当前页面**所有** Tab 的标题（用于"旧文案不得复活"） */
const TAB_TITLES_EXPR = `[...document.querySelectorAll('.ant-tabs-tab')].map((e) => (e.innerText || '').replace(/\\s+/g, ''))`;

// ---------------------------------------------------------------------------
// 【--selftest】转换规则的双向 fixture
//
// 为什么必须有这一层：B-15 的两个坑都出在**转换**上 ——
//   ① 服务端不认 `{logic,items}` 原组形态（实测 500 Invalid value）；
//   ② 无 `value` 的项若被补默认值，会变成 `{"status.$eq":true}` ⇒ 筛出空表。
// 两条都是"看起来什么都没错、请求却错/空"的类型，只能靠 fixture 钉住。
// ---------------------------------------------------------------------------
function runSelftest(toRequestFilter) {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Tab 筛选转换规则 fixture（双向：accept 与 reject 都要能红）');
  console.log('══════════════════════════════════════════════════════════════');
  const st = (v) => JSON.stringify(v);
  const cases = [
    // ---- 应当产出筛选 ----
    {
      name: 'accept · 三条（status + 两条恒真）',
      input: {
        logic: '$and',
        items: [
          { path: 'status', operator: '$eq', value: 'NEW' },
          { path: 'ticket_no', operator: '$notEmpty', value: true },
          { path: 'customer_mobile', operator: '$notEmpty', value: true },
        ],
      },
      want: { $and: [{ 'status.$eq': 'NEW' }, { 'ticket_no.$notEmpty': true }, { 'customer_mobile.$notEmpty': true }] },
    },
    {
      name: 'accept · 单条 ⇒ 不套 $and',
      input: { logic: '$and', items: [{ path: 'status', operator: '$eq', value: 'CLOSED' }] },
      want: { 'status.$eq': 'CLOSED' },
    },
    {
      name: 'accept · $or 逻辑保留',
      input: {
        logic: '$or',
        items: [
          { path: 'status', operator: '$eq', value: 'NEW' },
          { path: 'status', operator: '$eq', value: 'PROCESSING' },
        ],
      },
      want: { $or: [{ 'status.$eq': 'NEW' }, { 'status.$eq': 'PROCESSING' }] },
    },
    {
      name: 'accept · 混有无效项 ⇒ 只保留有效项（不因一条坏项整体失效）',
      input: {
        logic: '$and',
        items: [
          { path: 'status', operator: '$eq', value: 'NEW' },
          { path: 'ticket_no', operator: '$includes' },
        ],
      },
      want: { 'status.$eq': 'NEW' },
    },
    // ---- 必须产出 null（不筛）----
    { name: 'reject · null', input: null, want: null },
    { name: 'reject · undefined', input: undefined, want: null },
    { name: 'reject · 非对象', input: 'x', want: null },
    { name: 'reject · items 为空', input: { logic: '$and', items: [] }, want: null },
    { name: 'reject · 没有 items 键', input: { logic: '$and' }, want: null },
    {
      name: 'reject · 「全部」Tab 的无 value 骨架 ⇒ 绝不能变成 {"status.$eq":true}',
      input: {
        logic: '$and',
        items: [
          { path: 'status', operator: '$eq' },
          { path: 'ticket_no', operator: '$includes' },
          { path: 'source', operator: '$eq' },
          { path: 'ticket_type', operator: '$eq' },
        ],
      },
      want: null,
    },
    {
      name: 'reject · value 为空串（用户清空了筛选框）',
      input: { logic: '$and', items: [{ path: 'ticket_no', operator: '$includes', value: '' }] },
      want: null,
    },
    { name: 'reject · 缺 path', input: { logic: '$and', items: [{ operator: '$eq', value: 'NEW' }] }, want: null },
    { name: 'reject · 缺 operator', input: { logic: '$and', items: [{ path: 'status', value: 'NEW' }] }, want: null },
  ];

  let red = 0;
  for (const c of cases) {
    let got;
    try {
      got = toRequestFilter(c.input);
    } catch (error) {
      got = `<抛出 ${error.message}>`;
    }
    if (st(got) === st(c.want)) {
      console.log(`  ✓ ${c.name}`);
    } else {
      red += 1;
      console.log(`  ✗ ${c.name}\n      实得 ${st(got)}\n      期望 ${st(c.want)}`);
    }
  }

  // ---- 真实源码喂一遍：库里每个状态 Tab 的节点，必须算出 status.$eq；「全部」必须算出 null ----
  const rows = psql(
    `SELECT f.uid, f.options->>'parentId', f.options->'props'->'filterValue' ` +
      `FROM "flowModels" f WHERE f.options->>'use' = 'TicketTabFilterModel'`,
  )
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (rows.length === 0) {
    console.log('  ✗ 库里没有 TicketTabFilterModel 节点 —— 先跑 seed-admin-pages.mjs');
    red += 1;
  } else {
    let withStatus = 0;
    let without = 0;
    for (const line of rows) {
      const [uid, parentId, raw] = line.split('\u0001');
      let value = null;
      try {
        value = raw && raw !== '' ? JSON.parse(raw) : null;
      } catch {
        value = null;
      }
      const got = toRequestFilter(value);
      const hasStatus = JSON.stringify(got ?? '').includes('status.$eq');
      if (hasStatus) withStatus += 1;
      else without += 1;
      void uid;
      void parentId;
    }
    // 「全部」与「全量工单」两张表不该筛状态（它们的筛选项无 value）；
    // 其余 5 个状态 Tab 必须筛。总数由 seed 保证为 7。
    if (withStatus === 5 && without === 2) {
      console.log(`  ✓ 真实库：${withStatus} 个状态 Tab 算出 status.$eq · ${without} 个「全部/全量」算出 null`);
    } else {
      red += 1;
      console.log(
        `  ✗ 真实库：算出 status.$eq 的有 ${withStatus} 个（期望 5）、算出 null 的有 ${without} 个（期望 2）`,
      );
    }
  }

  console.log('');
  return red;
}

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
const PROFILE_DIR = path.join(OUT_DIR, `chrome-profile-tab-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 从请求 URL 里解析出"服务端收到的筛选" —— 不假设参数名，只看哪个参数的值是个筛选结构 */
function filterParamOf(url) {
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
    const raw = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    if (raw === '' || (raw[0] !== '{' && raw[0] !== '[')) continue;
    try {
      const value = JSON.parse(raw);
      const looksLikeFilter =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (Object.prototype.hasOwnProperty.call(value, '$and') ||
          Object.prototype.hasOwnProperty.call(value, '$or') ||
          Object.keys(value).some((k) => k.includes('.$')));
      if (looksLikeFilter) return { key, value };
    } catch {
      /* 不是 JSON，跳过 */
    }
  }
  return null;
}

const SPINNING_EXPR = `document.querySelectorAll('.ant-spin-spinning').length`;

/**
 * 🔴 **NocoBase 会缓存 Tab 面板**：切过的 Tab 其 DOM **留在文档里**（只是不可见）。
 *
 * 血的教训（2026-10-10 首轮实测）：不限定作用域时 `界面行数` 逐 Tab **累加** ——
 * 20 → 40 → 60 → 65 → 82 → 84，恰好是六个 Tab 各自行数之和（20+20+20+5+17+2）。
 * 于是"返回的记录全部是 NEW"这种断言读到的其实是**所有 Tab 的并集**，
 * 每条判据都变红，而**产品其实是对的** —— 一次典型的"验收器比产品错得更隐蔽"。
 *
 * ⇒ 所有 DOM 判据都必须落在**当前激活的 Tab 面板**内。
 *   找不到激活面板时**报出来**（而不是退回整篇文档）—— 退回会让上面那个
 *   累加症状原样复现，而且不会有任何提示。
 */
const PANE_SCOPE_EXPR = `(() => {
  const active = document.querySelector('.ant-tabs-tabpane-active');
  if (active) return { ok: true, how: 'ant-tabs-tabpane-active' };
  const panes = [...document.querySelectorAll('.ant-tabs-tabpane')];
  const shown = panes.filter((p) => !p.classList.contains('ant-tabs-tabpane-hidden'));
  if (shown.length === 1) return { ok: true, how: 'single-visible-pane' };
  return { ok: false, panes: panes.length, shown: shown.length };
})()`;

const ACTIVE_SCOPE_JS = `(() => {
  const active = document.querySelector('.ant-tabs-tabpane-active');
  if (active) return active;
  const panes = [...document.querySelectorAll('.ant-tabs-tabpane')].filter((p) => !p.classList.contains('ant-tabs-tabpane-hidden'));
  return panes.length === 1 ? panes[0] : null;
})()`;

const ROW_KEYS_EXPR = `(() => {
  const scope = ${ACTIVE_SCOPE_JS};
  if (!scope) return null;
  return [...scope.querySelectorAll('.ant-table-tbody tr[data-row-key]')].map((tr) => tr.getAttribute('data-row-key'));
})()`;

/**
 * 读「当前激活面板」里**状态列**每行的显示文本。
 *
 * 为什么按表头文字定位列、而不是写死第几列：
 *   列顺序属于页面配置（`flowModels`），会随 seed 变化；写死列号会在某次
 *   重排后**静默读到另一列**（读到的还是文本，断言照样能过）。
 *   按表头「状态」定位，列序一变就是"找不到表头"⇒ 明确报出来。
 *
 * ⚠️ 它依赖上面的 `ACTIVE_SCOPE_JS`，所以**必须声明在它后面**。
 *    第一版把它放到了文件更靠前的 `loadStatusLabels()` 那块 ⇒ 模块求值期
 *    `ReferenceError: Cannot access 'ACTIVE_SCOPE_JS' before initialization`（TDZ）。
 *    ⇒ 凡"拼进模板字符串里的前置常量"，**声明顺序就是依赖顺序**。
 */
const STATUS_CELLS_EXPR = `(() => {
  const scope = ${ACTIVE_SCOPE_JS};
  if (!scope) return { ok: false, why: 'no-active-pane' };
  const ths = [...scope.querySelectorAll('.ant-table-thead th')];
  const idx = ths.findIndex((th) => (th.innerText || '').replace(/\\s+/g, '') === '状态');
  if (idx < 0) {
    return {
      ok: false,
      why: 'no-status-header',
      headers: ths.map((th) => (th.innerText || '').replace(/\\s+/g, '')),
    };
  }
  const rows = [...scope.querySelectorAll('.ant-table-tbody tr[data-row-key]')];
  const cells = rows.map((tr) => {
    const td = tr.querySelectorAll('td')[idx];
    return (td ? td.innerText : '').replace(/\\s+/g, '');
  });
  return { ok: true, cells };
})()`;

const TOTAL_TEXT_EXPR = `(() => {
  const scope = ${ACTIVE_SCOPE_JS};
  if (!scope) return null;
  return ((scope.querySelector('.ant-pagination-total-text') || {}).innerText || '').trim();
})()`;

/**
 * **正向等待**：等到"当前激活面板"确实已经切到目标 Tab。
 *
 * ===========================================================================
 * 🔴 为什么不能用 sleep 猜（首轮实测的代价）
 * ===========================================================================
 * 第一版是 `sleep(1200) → 等 spinning==0 → sleep(900) → 采样`，结果：
 *   · 「待客户评价」采到 **0 行**，且"最后一条请求"是上一个 Tab 的
 *     —— 因为采样那一刻新表**还没开始转圈**，`spinning==0` 立刻成立，
 *        于是"等完了"其实是"还没开始"；
 *   · 翻页时点到的 `.ant-pagination-next` 是**上一个 Tab 残留**的（disabled）
 *     —— 因为面板并没有真的切过去。
 * 两次都是"看起来等了，其实在等一个尚未发生的负条件"。
 *
 * ⇒ 改成**以该 Tab 的总条数作指纹**：分页总数文案里出现期望条数，
 *    且表格要么有行、要么有空态占位，且不在转圈 ⇒ 这个面板才算是真的切好了。
 *    指纹对不上就**报出来**（带上实际看到什么），不静默往下走。
 */
function tabSwitchedExpr(expectCount) {
  // 🔴 `spinning` **必须**限定在激活面板内。
  //    实测：`.ant-spin-spinning` 会随访问过的 Tab **累积**（2 → 3 → 4 → 5），
  //    于是"全文档转圈数 == 0"这个条件在第二个 Tab 之后**永远不成立**，
  //    四个 Tab 全被判"面板没就位"，而它们的 rows/totalText 其实都已正确。
  //    —— 与行数、分页器同型的"作用域"坑，第三次踩到，故三处一律按面板限定。
  return `(() => {
    const scope = ${ACTIVE_SCOPE_JS};
    if (!scope) return { ready: false, why: 'no-active-pane' };
    const spinning = scope.querySelectorAll('.ant-spin-spinning').length;
    const rows = scope.querySelectorAll('.ant-table-tbody tr[data-row-key]').length;
    const emptyish = scope.querySelectorAll('.ant-empty, .ant-table-placeholder').length;
    const totalText = ((scope.querySelector('.ant-pagination-total-text') || {}).innerText || '').trim();
    const m = /(\\d+)/.exec(totalText);
    const total = m ? Number(m[1]) : null;

    // 🔴 **空 Tab 是合法状态，指纹必须能表达它**（2026-10-10 实测踩到）：
    //    期望 0 条时，antd **不渲染分页器** ⇒ totalText 是空串 ⇒ total = null
    //    ⇒ 用 total === 0 当判据**永远不成立**，于是"面板就位"一直等超时，
    //    报出的是"指纹对不上"，而真相是"这个 Tab 本来就是空的，渲染是对的"。
    //    ⇒ 期望 0 条时，判据换成"没有行 + 有空态占位"（且仍要求不转圈）。
    //      注意**不能**放宽成"total 为 null 就算就位"—— 那会把
    //      "分页器还没渲染出来"误判成"已就位"，正是最初那个 sleep 猜时机的坑。
    //
    //    ⚠️ 注释里**不能出现反引号**：这一整段是外层模板字符串的内容，
    //       写一个反引号就会让模板提前闭合（本项目已记过这条，这次又踩了一次）。
    const totalMatches =
      ${expectCount} === 0 ? total === null : total === ${expectCount};
    return {
      ready:
        spinning === 0 &&
        (${expectCount} === 0 ? rows === 0 && emptyish > 0 : (rows > 0 || emptyish > 0)) &&
        totalMatches,
      spinning, rows, emptyish, totalText, total,
    };
  })()`;
}

/**
 * 展平框架的外层 `$and` 包裹。
 *
 * `resource.getFilter()` 返回 `{$and: [...filterGroups.values()]}` ——
 * 于是**单个**筛选组发到线上是 `{$and:[ <我们的组> ]}`。
 * 首轮验收把这一层当成"筛选形态错误"判红了 5 次，而服务端收到的是**对的**
 * （`{$and:[{$and:[...]}]}` 与 `{$and:[...]}` 语义等价，实测均 200 且 count 正确）。
 * ⇒ 比较前先把"只有一个子项的 $and"展平，使断言比较的是**语义**不是**嵌套层数**。
 */
function normalizeFilter(v) {
  if (!v || typeof v !== 'object') return v ?? null;
  if (Array.isArray(v)) return v.map(normalizeFilter);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '$and' && Array.isArray(v.$and) && v.$and.length === 1) {
    return normalizeFilter(v.$and[0]);
  }
  const out = {};
  for (const k of keys.sort()) out[k] = normalizeFilter(v[k]);
  return out;
}

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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  let contract;
  try {
    contract = loadTabFilterContract();
  } catch (error) {
    console.log(`  ⛔ ${error.message}`);
    return 2;
  }
  const { toRequestFilter } = contract;
  if (typeof toRequestFilter !== 'function') {
    console.log('  ⛔ 客户端契约没有导出 toRequestFilter —— 验收器自身异常');
    return 2;
  }

  if (SELFTEST_ONLY) {
    return runSelftest(toRequestFilter) === 0 ? 0 : 1;
  }

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  B-15 验收：状态 Tab 的服务端筛选（真实门店账号 + 真实浏览器）');
  console.log('══════════════════════════════════════════════════════════════');
  if (!STORE_PASSWORD) {
    console.log('  ⛔ .env 缺 UAT_STORE_A_PASSWORD —— 环境未就绪');
    return 2;
  }

  // ---- 真值：门店归属 + 各状态条数 ----
  const storeId = Number(
    psql(
      `SELECT su.store_id FROM users u JOIN store_users su ON su.user_id = u.id ` +
        `WHERE u.email = '${STORE_EMAIL.replace(/'/g, "''")}' LIMIT 1`,
    ).trim(),
  );
  if (!Number.isInteger(storeId)) {
    console.log(`  ⛔ 查不到 ${STORE_EMAIL} 所属门店 —— 环境未就绪`);
    return 2;
  }
  const countRows = psql(
    `SELECT status, count(*) FROM service_tickets WHERE store_id = ${storeId} GROUP BY status`,
  )
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.split('\u0001'));
  const truth = new Map(countRows.map(([s, c]) => [s, Number(c)]));
  const totalForStore = [...truth.values()].reduce((a, b) => a + b, 0);
  console.log(`  · 门店账号 ${STORE_EMAIL} → store_id=${storeId}`);
  console.log(
    `  · 库里真值：${[...truth.entries()].map(([s, c]) => `${s}=${c}`).join(' / ')} · 合计 ${totalForStore}`,
  );

  // ---- 页面路由 ----
  const pageUid = psql(
    `SELECT "schemaUid" FROM "desktopRoutes" WHERE type = 'flowPage' AND title = '我的门店工单' LIMIT 1`,
  ).trim();
  if (!pageUid) {
    console.log('  ⛔ 找不到「我的门店工单」页面路由 —— 环境未就绪');
    return 2;
  }

  // ---- 各 Tab 的期望筛选（由客户端真实实现算出）----
  const TABS = [
    { title: '全部', status: null, blockKey: 'all' },
    ...TICKET_STATUS_TABS.map((t) => ({ title: t.title, status: t.status, blockKey: t.key })),
  ];
  const nodeRows = psql(
    `SELECT f.options->>'parentId', f.options->'props'->'filterValue', b.options->'stepParams'->'__flowSurfaceMeta'->>'declaredKey' ` +
      `FROM "flowModels" f LEFT JOIN "flowModels" b ON b.uid = f.options->>'parentId' ` +
      `WHERE f.options->>'use' = 'TicketTabFilterModel'`,
  )
    .split('\n')
    .filter((l) => l.trim() !== '');
  const filterByBlockKey = new Map();
  for (const line of nodeRows) {
    const [parentId, raw, declaredKey] = line.split('\u0001');
    if (!declaredKey) continue;
    // declaredKey 形如 `new.new-table` ⇒ 取第一段与 Tab 的 blockKey 对应
    const head = declaredKey.split('.')[0];
    let value = null;
    try {
      value = raw && raw !== '' ? JSON.parse(raw) : null;
    } catch {
      value = null;
    }
    filterByBlockKey.set(head, { parentId, filter: toRequestFilter(value) });
  }

  // ---- 浏览器 ----
  const chrome = spawn(
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

  /** 每个 Tab 观测窗口内捕获的 serviceTickets:list 请求 */
  let listCalls = [];
  /** 全部 /api 请求数（判"请求量是否异常放大"） */
  const calls = [];
  /** 429 计数 —— 限流会让 Tab 取不到数，必须与"筛选不生效"区分开 */
  let count429 = 0;
  let last429Url = '';
  const consoleErrors = [];
  const filterAppliedLogs = [];
  const noBlockResourceLogs = [];
  /** 控制台全量留痕（排障用：区分"模型没打日志"与"我们抓不到控制台"） */
  const allConsole = [];
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
    // ⚠️ 要读响应体（判"服务端返回了哪些记录"），必须给足缓冲区
    await cdp.send('Network.enable', {
      maxResourceBufferSize: 64 * 1024 * 1024,
      maxTotalBufferSize: 256 * 1024 * 1024,
    });

    cdp.on('Network.requestWillBeSent', (p) => {
      const url = p.request?.url ?? '';
      if (!url.includes('/api/')) return;
      calls.push({ url: url.replace(SVC_BASE_URL, ''), requestId: p.requestId, status: null });
      if (url.includes('serviceTickets:list')) {
        listCalls.push({ url: url.replace(SVC_BASE_URL, ''), requestId: p.requestId, status: null, finished: false });
      }
    });
    cdp.on('Network.responseReceived', (p) => {
      const status = p.response?.status ?? null;
      const hit = calls.find((c) => c.requestId === p.requestId);
      if (hit) hit.status = status;
      if (status === 429) {
        count429 += 1;
        last429Url = (p.response?.url ?? '').replace(SVC_BASE_URL, '');
        const hit2 = listCalls.find((c) => c.requestId === p.requestId);
        if (hit2) hit2.status = 429;
      }
      const hit3 = listCalls.find((c) => c.requestId === p.requestId);
      if (hit3) hit3.status = status;
    });
    cdp.on('Network.loadingFinished', (p) => {
      const hit = listCalls.find((c) => c.requestId === p.requestId);
      if (hit) hit.finished = true;
    });
    /**
     * 控制台序列化。
     *
     * ⚠️ 不能只用 `a.value`：首轮实测报出一条内容是单个字母 `J` 的"错误"，
     *    那其实是**函数名/类名**被当成了文本（`a.description`），真实信息在
     *    `preview.properties` 里。只取 value 会让"是什么错了"永远查不出来 ——
     *    与本项目反复踩的"报错看不懂"同型，所以这里沿用既有走查脚本的完整序列化。
     */
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
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args ?? []).map(serializeArg).join(' ').trim();
      // 全量留痕（有上限）：**对照锚点**用得上 ——
      // 若连 index.ts 那行"客户端产物构建标记"都没进来，说明是**抓不到**控制台，
      // 而不是"模型没打日志"。这两者的处置完全相反，不能靠猜。
      if (allConsole.length < 80) allConsole.push({ type: p.type, text: text.slice(0, 220) });
      if (text.includes('[service-ticket] Tab 服务端筛选已应用')) filterAppliedLogs.push(text);
      if (text.includes('拿不到区块资源')) noBlockResourceLogs.push(text);
      if (p.type === 'error' && loggedIn) consoleErrors.push(text.slice(0, 300));
    });

    // ---- 真实登录 ----
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
    try {
      await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪', timeout: 30_000 });
    } catch (e) {
      const diag = await cdp.evaluate(
        `(() => ({ href: location.href, body: (document.body?.innerText ?? '').slice(0, 300) }))()`,
      );
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
      const diag = await cdp.evaluate(
        `(() => ({ href: location.href, body: (document.body?.innerText ?? '').slice(0, 300) }))()`,
      );
      console.log('  ⛔ 登录诊断：' + JSON.stringify(diag));
      throw e;
    }
    loggedIn = true;
    ok('门店售后账号真实登录', STORE_EMAIL);

    // ---- 打开「我的门店工单」----
    await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${pageUid}` });
    try {
      await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length > 0', {
        what: '表格与数据到位',
        timeout: 60_000,
      });
    } catch (e) {
      const diag = await cdp.evaluate(
        `(() => ({
          href: location.href, tables: document.querySelectorAll('.ant-table').length,
          rows: document.querySelectorAll('.ant-table-tbody tr[data-row-key]').length,
          spinning: ${SPINNING_EXPR}, bodyHead: (document.body?.innerText ?? '').slice(0, 400),
        }))()`,
      );
      console.log('  ⛔ 列表页诊断：' + JSON.stringify(diag));
      throw e;
    }
    await cdp.waitFor(`${SPINNING_EXPR} === 0`, { what: '首屏加载结束', timeout: 45_000 });

    // ===================================================================
    // 【判据 0.5】状态**文案**：Tab 标题与状态列都必须与共享常量一致
    // ===================================================================
    // ⚠️ 为什么这条要单独列（不是锦上添花）：
    //    2026-10-10 用户裁决把 NEW 的界面文案从「待受理」改成「待处理」。
    //    字段元数据（`fields.options.uiSchema.enum`）是**已落库**的，
    //    改代码常量**不会**自动更新它 —— 若漏了迁移，Tab 改了、状态列还写着旧词，
    //    而两者"看起来都很正常"，没有任何报错。本判据专门盯这件事。
    const STATUS_LABEL = loadStatusLabels();
    const tabTitles = (await cdp.evaluate(TAB_TITLES_EXPR)) ?? [];
    const expectTabTitles = ['全部', ...TICKET_STATUS_TABS.map((t) => t.title)];
    if (tabTitles.length !== expectTabTitles.length) {
      no('六个状态 Tab + 全部 都在页面上', `实际 ${tabTitles.length} 个：${JSON.stringify(tabTitles)}`);
    } else {
      ok('六个状态 Tab + 全部 都在页面上', JSON.stringify(tabTitles));
    }
    // 🔴 旧文案不得复活：这条对**任何**历史用词都成立，不依赖常量
    const staleTab = tabTitles.filter((t) => t.includes('受理'));
    if (staleTab.length) {
      no('Tab 标题里没有「受理」字样', `出现了：${JSON.stringify(staleTab)}`);
    } else {
      ok('Tab 标题里没有「受理」字样', '（NEW 的界面说法已统一为「待处理」）');
    }

    // ===================================================================
    // 【判据 0】模型真的跑了（区分"筛选生效"与"筛选压根没跑"）
    // ===================================================================
    // ⚠️ 「模型有没有被实例化」这条判据**不能在这里判**：首屏只挂载「全部」一个 Tab，
    //    而「全部」没有状态筛选 ⇒ 模型按设计**不打**自证日志（日志只在真的挂上筛选时打）。
    //    首轮就是把它放错位置，于是"0 条日志"被读成"模型没跑"，而产品其实是好的。
    //    ⇒ 真正的判定放到切完所有 Tab 之后（见 ⑤）。

    // ===================================================================
    // 【判据 ①~④】逐个 Tab
    // ===================================================================
    console.log('\n──── ① 切 Tab 确实改变**服务端返回**的记录（不是前端过滤当前 20 行）────');
    const observed = [];
    let tabFailures = 0;

    for (const tab of TABS) {
      // ---------------------------------------------------------------------
      // 🔴 第一个 Tab（「全部」）**不能**清空观测窗口。
      //
      // 它本来就处于激活态，点一个已激活的 Tab **不会**发出新的 list 请求 ——
      // 本 Tab 展示的数据来自**首屏加载**那一次请求，而我在每轮开头清空窗口，
      // 等于把唯一能证明"服务端 count 是多少"的那条响应丢掉，
      // 于是「全部」的 `meta.count` 必然读不到 ⇒ **假红**。
      // （实测：同一脚本有的轮次过、有的轮次红，红的永远是「全部」这一条，
      //   "0 条已完成请求"这个诊断文案就是线索。）
      // ⇒ 首轮沿用首屏那次请求；其余 Tab 点击必然触发新请求，照常清空。
      // ---------------------------------------------------------------------
      const isFirstTab = tab === TABS[0];
      if (!isFirstTab) listCalls = [];
      const clicked = await cdp.evaluate(clickTabExpr(tab.title));
      if (!clicked?.ok) {
        no(`切到「${tab.title}」`, `找不到该 Tab，页面上的 Tab = ${JSON.stringify(clicked?.seen ?? [])}`);
        tabFailures += 1;
        continue;
      }
      const expectCountForWait = tab.status === null ? totalForStore : (truth.get(tab.status) ?? 0);
      let waited = null;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        waited = await cdp.evaluate(tabSwitchedExpr(expectCountForWait));
        if (waited?.ready) break;
        await sleep(300);
      }
      if (!waited?.ready) {
        no(
          `「${tab.title}」切换后面板就位（以总条数 ${expectCountForWait} 为指纹）`,
          `实际 ${JSON.stringify(waited)}`,
        );
        tabFailures += 1;
        continue;
      }

      const scope = await cdp.evaluate(PANE_SCOPE_EXPR);
      if (!scope?.ok) {
        no(`「${tab.title}」能定位到当前激活的 Tab 面板`, JSON.stringify(scope));
        tabFailures += 1;
        continue;
      }
      const rowKeysRaw = await cdp.evaluate(ROW_KEYS_EXPR);
      if (rowKeysRaw === null) {
        no(`「${tab.title}」能读到当前面板的数据行`, '作用域解析失败');
        tabFailures += 1;
        continue;
      }
      const rowKeys = rowKeysRaw ?? [];
      const totalText = (await cdp.evaluate(TOTAL_TEXT_EXPR)) ?? '';

      // ---- 状态列**文案**：必须等于共享常量里该状态的标签 ----
      // 每条 Tab 都查：有行就逐行核对；0 行则**明说空转**（不静默跳过）。
      const cellSnap = await cdp.evaluate(STATUS_CELLS_EXPR);
      if (!cellSnap?.ok) {
        no(`「${tab.title}」能定位到状态列`, JSON.stringify(cellSnap));
      } else {
        const cells = cellSnap.cells ?? [];
        const expectLabel = tab.status ? STATUS_LABEL[tab.status] : null;
        if (!cells.length) {
          ok(`「${tab.title}」状态列文案（本 Tab 无数据行，未核对）`, `状态列名已定位 · 期望 ${expectLabel ?? '任意授权状态'}`);
        } else if (expectLabel) {
          const wrong = cells.filter((c) => c !== expectLabel);
          if (wrong.length) {
            no(
              `「${tab.title}」状态列逐行显示「${expectLabel}」`,
              `${wrong.length}/${cells.length} 行不符：${JSON.stringify([...new Set(wrong)])}`,
            );
          } else {
            ok(`「${tab.title}」状态列逐行显示「${expectLabel}」`, `${cells.length} 行一致`);
          }
        } else {
          // 「全部」Tab：允许出现任意**已定义的**状态标签，但不允许出现未定义/旧文案
          const allowed = new Set(Object.values(STATUS_LABEL));
          const stray = [...new Set(cells.filter((c) => !allowed.has(c)))];
          if (stray.length) {
            no(`「${tab.title}」状态列只出现已定义的状态标签`, `出现了未定义标签：${JSON.stringify(stray)}`);
          } else {
            ok(`「${tab.title}」状态列只出现已定义的状态标签`, `${cells.length} 行 · 取值 ${JSON.stringify([...new Set(cells)])}`);
          }
        }
        // 旧文案不得复活（对全部 Tab 一律检查，不依赖常量取值）
        const staleCells = [...new Set(cells.filter((c) => c.includes('受理')))];
        if (staleCells.length) {
          no(`「${tab.title}」状态列里没有「受理」字样`, `出现了：${JSON.stringify(staleCells)}`);
        }
      }

      // 取本窗口内**最后一条**已完成的 list 请求 —— 它就是界面当前展示的那批数据的来源。
      // ⚠️ 从新到旧逐个尝试：最后一条可能仍在缓冲/不可读，退回上一条比直接判"读不到"更准。
      const finished = listCalls.filter((c) => c.finished);
      let last = null;
      let body = null;
      let bodyErr = null;
      for (let i = finished.length - 1; i >= 0; i -= 1) {
        try {
          const r = await cdp.send('Network.getResponseBody', { requestId: finished[i].requestId });
          const parsed = r?.body ? JSON.parse(r.body) : null;
          if (parsed) {
            last = finished[i];
            body = parsed;
            break;
          }
        } catch (error) {
          // 留一条错误信息：读不到响应体时若什么都不报，排障就只能猜
          bodyErr = String(error?.message ?? error).slice(0, 140);
        }
      }
      if (!last) last = finished[finished.length - 1] ?? null;
      const sent = last ? filterParamOf(last.url) : null;
      // 缓存命中时本窗口可能一条请求都没有 ⇒ 请求带了什么筛选无从判断，
      // 这时以**界面**为准（行数/总条数/每行状态），并明确标注"未重新请求"。
      const fromCache = finished.length === 0;
      const ids = rowKeys.map(Number).filter(Number.isFinite);
      const rowsFromDb = ids.length
        ? psql(
            `SELECT id, status, store_id FROM service_tickets WHERE id IN (${ids.join(',')})`,
          )
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => l.split('\u0001'))
        : [];
      const statusesPresent = [...new Set(rowsFromDb.map((r) => r[1]))];
      const foreignRows = rowsFromDb.filter((r) => Number(r[2]) !== storeId);

      const expectCount = tab.status === null ? totalForStore : (truth.get(tab.status) ?? 0);
      const expectFilter = filterByBlockKey.get(tab.blockKey)?.filter ?? null;

      const detail = [];
      detail.push(`界面 ${ids.length} 行`);
      if (last) detail.push(`请求 filter=${sent ? JSON.stringify(sent.value) : '<无>'}`);
      else detail.push('请求=<无>（可能命中缓存未重新请求）');
      if (body) detail.push(`服务端 count=${body?.meta?.count ?? '?'}`);
      detail.push(`库里期望 count=${expectCount}`);
      detail.push(`本页状态=${JSON.stringify(statusesPresent)}`);

      console.log(`\n  【${tab.title}】${detail.join(' · ')}`);

      // --- 判据：请求里带着本 Tab 的筛选 ---
      if (expectFilter === null) {
        if (sent) {
          no(`「${tab.title}」不筛状态`, `请求里却带了 filter ${JSON.stringify(sent.value)}`);
          tabFailures += 1;
        } else {
          ok(`「${tab.title}」不筛状态（全部展示）`, '请求里无状态筛选');
        }
      } else if (!sent && fromCache) {
        ok(
          `「${tab.title}」筛选生效（命中缓存未重新请求，以界面为准）`,
          `本页 ${ids.length} 行状态=${JSON.stringify(statusesPresent)} · 总条数「${totalText}」`,
        );
      } else if (!sent) {
        no(
          `「${tab.title}」的请求带上了服务端筛选`,
          '没有任何一条带 filter 的 list 请求 ⇒ Tab 仍是不筛状态（B-15 未修复）',
        );
        tabFailures += 1;
      } else if (
        JSON.stringify(normalizeFilter(sent.value)) !== JSON.stringify(normalizeFilter(expectFilter))
      ) {
        // 比较前展平框架的外层 $and（见 normalizeFilter 的说明）—— 比的是语义不是嵌套层数
        no(
          `「${tab.title}」的筛选形态正确`,
          `实得 ${JSON.stringify(sent.value)} / 期望 ${JSON.stringify(expectFilter)}`,
        );
        tabFailures += 1;
      } else {
        ok(`「${tab.title}」请求携带服务端筛选`, JSON.stringify(sent.value));
      }

      // --- 判据：返回的每行都属于本 Tab 的状态 ---
      if (tab.status !== null) {
        // 🔴 **空 Tab 是合法状态**（2026-10-10 实测：库里 WAIT_STORE_CONFIRM 为 0）。
        //    0 行时 `statusesPresent` 是空数组，"每行都属于该状态"无从谈起 ——
        //    但它**不是**违规。判据要能表达空集，否则"这个 Tab 确实是空的"
        //    会被报成"返回了不属于本状态的记录（实际 []）"，把方向说反了。
        if (ids.length === 0 && expectCount === 0) {
          ok(`「${tab.title}」返回 0 行（库里真值也是 0）`, `空态：${totalText || '无分页器'}`);
        } else if (statusesPresent.length === 1 && statusesPresent[0] === tab.status) {
          ok(`「${tab.title}」返回的记录全部是 ${tab.status}`, `${ids.length} 行`);
        } else {
          no(
            `「${tab.title}」返回的记录全部是 ${tab.status}`,
            `实际出现 ${JSON.stringify(statusesPresent)}`,
          );
          tabFailures += 1;
        }
      }

      // --- 判据：服务端 count == 库里真值（分页/统计口径一致）---
      if (body?.meta?.count === undefined) {
        no(
          `「${tab.title}」能读到服务端 count`,
          `读不到响应体（本窗口 ${finished.length} 条已完成请求${bodyErr ? ` · 最后错误：${bodyErr}` : ''}）`,
        );
        tabFailures += 1;
      } else if (body.meta.count !== expectCount) {
        no(
          `「${tab.title}」服务端 count 与库里真值一致`,
          `服务端 ${body.meta.count} ≠ 库里 ${expectCount} —— 前端过滤当前 20 行就会是这个症状`,
        );
        tabFailures += 1;
      } else {
        ok(`「${tab.title}」服务端 count 与库里真值一致`, `${expectCount}`);
      }

      // --- 判据：分页总数文案与 count 一致 ---
      const m = /(\d+)/.exec(totalText ?? '');
      if (m && Number(m[1]) !== expectCount) {
        no(`「${tab.title}」界面分页总数与真值一致`, `界面「${totalText}」里的 ${m[1]} ≠ ${expectCount}`);
        tabFailures += 1;
      } else if (m) {
        ok(`「${tab.title}」界面分页总数与真值一致`, totalText);
      }

      // --- 判据：跨店不可见 ---
      if (foreignRows.length) {
        no(`「${tab.title}」不含其它门店数据`, `${foreignRows.length} 行来自别的门店：${foreignRows.map((r) => r[0]).join(',')}`);
        tabFailures += 1;
      }

      observed.push({ tab: tab.title, status: tab.status, ids: [...ids].sort((a, b) => a - b), expectCount });
    }

    // ===================================================================
    // 【判据 ⑤】模型真的跑了 —— 区分"筛选生效"与"筛选压根没跑"
    // ===================================================================
    // ⚠️ 必须在切完所有 Tab **之后**判：只有带状态筛选的 Tab 会打自证日志，
    //    而首屏只有「全部」是挂载的（见上面那段的说明）。
    console.log('\n──── ⑤ Tab 筛选模型确实被实例化并应用 ────');
    if (noBlockResourceLogs.length) {
      no(
        '筛选模型拿到了区块资源',
        `${noBlockResourceLogs.length} 条「拿不到区块资源」告警 ⇒ 挂载点不对，模型不会生效`,
      );
      for (const l of noBlockResourceLogs.slice(0, 3)) console.log(`       ${l.slice(0, 220)}`);
    }
    if (filterAppliedLogs.length > 0) {
      ok('筛选模型已应用（客户端自证日志）', `${filterAppliedLogs.length} 条`);
      for (const l of filterAppliedLogs.slice(0, 8)) console.log(`       ${l.slice(0, 200)}`);
    } else {
      // 先排除"我们根本抓不到控制台"：index.ts 登录成功后必打一行构建标记
      // （console.info）。它都没进来 ⇒ 是**采集**的问题，不是产品的问题。
      const sawAnyConsole = allConsole.length > 0;
      const sawBuildLine = allConsole.some((c) => c.text.includes('service-ticket'));
      no(
        '筛选模型已应用（客户端自证日志）',
        !sawAnyConsole
          ? '控制台一条都没采集到 ⇒ 无法判定，需先修采集（不给产品结论）'
          : sawBuildLine
            ? '采集正常，但筛选模型没有打日志 ⇒ 模型可能未被实例化'
            : '采集到的控制台里没有任何 service-ticket 日志 ⇒ 客户端插件可能未加载',
      );
      console.log(`       （控制台共采集 ${allConsole.length} 条，前 12 条如下）`);
      for (const c of allConsole.slice(0, 12)) console.log(`         [${c.type}] ${c.text.slice(0, 160)}`);
    }

    // ===================================================================
    // 【判据 ⑥】各 Tab 的**记录集合确实不同**（否则"切换改变结果"是空话）
    // ===================================================================
    console.log('\n──── ② 各 Tab 的记录集合确实互不相同 ────');
    const comparable = observed.filter((o) => o.status !== null && o.ids.length > 0);
    let distinctPairs = 0;
    for (let i = 0; i < comparable.length; i += 1) {
      for (let j = i + 1; j < comparable.length; j += 1) {
        const a = comparable[i].ids.join(',');
        const b = comparable[j].ids.join(',');
        if (a !== b) distinctPairs += 1;
      }
    }
    const pairs = (comparable.length * (comparable.length - 1)) / 2;
    if (comparable.length < 2) {
      no('至少两个状态 Tab 有数据可供比较', `只有 ${comparable.length} 个 —— 判据空转，按铁律 10 判红`);
    } else if (distinctPairs !== pairs) {
      no(
        '任意两个状态 Tab 的首屏记录集合都不同',
        `${distinctPairs}/${pairs} 对不同 ⇒ 有 Tab 返回了同一批数据`,
      );
    } else {
      ok('任意两个状态 Tab 的首屏记录集合都不同', `${distinctPairs}/${pairs} 对全部不同`);
    }
    // 「全部」必须**不等于**任一状态 Tab（它含有 CANCELLED 等未设 Tab 的状态）
    const all = observed.find((o) => o.status === null);
    if (all) {
      const allKey = all.ids.join(',');
      const same = comparable.filter((o) => o.ids.join(',') === allKey).map((o) => o.tab);
      if (same.length) {
        no('「全部」与状态 Tab 返回不同集合', `与 ${same.join('、')} 完全相同`);
      } else {
        ok('「全部」与状态 Tab 返回不同集合', `全部 ${all.expectCount} 条 > 各状态 Tab`);
      }
    }

    // ===================================================================
    // 【判据 ⑥】翻到第 2 页仍然筛得住（前端过滤的分页在这里必然露馅）
    // ===================================================================
    console.log('\n──── ③ 翻页后仍然筛得住（前端过滤当前 20 行必在此露馅）────');
    const bigTab = observed
      .filter((o) => o.status !== null && o.expectCount > 20)
      .sort((a, b) => b.expectCount - a.expectCount)[0];
    if (!bigTab) {
      no('存在一个超过一页的状态 Tab 可供翻页验证', '数据不足，判据空转 ⇒ 判红');
    } else {
      const clicked = await cdp.evaluate(clickTabExpr(bigTab.tab));
      if (!clicked?.ok) {
        no(`切回「${bigTab.tab}」以翻页`, '找不到该 Tab');
      } else {
        // 同样用"总条数指纹"确认面板真的切过去了 —— 首轮在这里拿 sleep 猜，
        // 结果点到了上一个 Tab 残留的分页器（disabled），还以为是翻页功能坏了。
        let back = null;
        const deadline2 = Date.now() + 45_000;
        while (Date.now() < deadline2) {
          back = await cdp.evaluate(tabSwitchedExpr(bigTab.expectCount));
          if (back?.ready) break;
          await sleep(300);
        }
        if (!back?.ready) {
          no(`切回「${bigTab.tab}」后面板就位`, `实际 ${JSON.stringify(back)}`);
        } else {
        const p1 = (((await cdp.evaluate(ROW_KEYS_EXPR)) ?? []) ?? []).map(Number);
        // ⚠️ 与行数/总数同理：分页控件也**必须**限定在当前激活面板内。
        //    不限定的话点到的可能是上一个 Tab 残留的分页器 —— 于是"翻页"翻的是别人。
        const next = await cdp.evaluate(
          `(() => {
            const scope = ${ACTIVE_SCOPE_JS};
            if (!scope) return { ok: false, why: 'no-active-pane' };
            const el = scope.querySelector('.ant-pagination-next');
            if (!el) return { ok: false, why: 'no-next-button' };
            if (el.classList.contains('ant-pagination-disabled')) return { ok: false, why: 'disabled' };
            el.click(); return { ok: true };
          })()`,
        );
        if (!next?.ok) {
          no(`「${bigTab.tab}」能翻到第 2 页`, JSON.stringify(next));
        } else {
          // 正向等待第 2 页：当前页码变为 2 且不在转圈（不靠 sleep 猜）
          let p2ready = null;
          const dl = Date.now() + 45_000;
          while (Date.now() < dl) {
            p2ready = await cdp.evaluate(`(() => {
              const scope = ${ACTIVE_SCOPE_JS};
              if (!scope) return { ready: false, why: 'no-active-pane' };
              const cur = ((scope.querySelector('.ant-pagination-item-active') || {}).innerText || '').trim();
              // 同样限定在面板内（全文档的转圈数会跨 Tab 累积，永不归零）
              const spinning = scope.querySelectorAll('.ant-spin-spinning').length;
              const rows = scope.querySelectorAll('.ant-table-tbody tr[data-row-key]').length;
              return { ready: spinning === 0 && rows > 0 && cur === '2', cur, spinning, rows };
            })()`);
            if (p2ready?.ready) break;
            await sleep(300);
          }
          if (!p2ready?.ready) {
            no(`「${bigTab.tab}」翻到第 2 页后页码显示为 2`, `实际 ${JSON.stringify(p2ready)}`);
          }
          const p2 = (((await cdp.evaluate(ROW_KEYS_EXPR)) ?? []) ?? []).map(Number);
          const overlap = p2.filter((id) => p1.includes(id));
          const p2rows = p2.length
            ? psql(`SELECT id, status, store_id FROM service_tickets WHERE id IN (${p2.join(',')})`)
                .split('\n')
                .filter((l) => l.trim() !== '')
                .map((l) => l.split('\u0001'))
            : [];
          const wrong = p2rows.filter((r) => r[1] !== bigTab.status || Number(r[2]) !== storeId);
          // 自证现场：重叠这种事**必须先看清数字**再判，不能只报"有重复"
          console.log(
            `       · 第 1 页 ${p1.length} 行 [${p1.slice(0, 3).join(',')} … ${p1.slice(-2).join(',')}]`,
          );
          console.log(
            `       · 第 2 页 ${p2.length} 行 [${p2.slice(0, 3).join(',')} … ${p2.slice(-2).join(',')}]`,
          );
          if (p2.length === 0) {
            no(`「${bigTab.tab}」第 2 页有数据`, '0 行');
          } else if (overlap.length) {
            no(
              `「${bigTab.tab}」第 2 页与第 1 页不重叠`,
              `${overlap.length} 行重复：${overlap.join(',')}`,
            );
          } else if (wrong.length) {
            no(
              `「${bigTab.tab}」第 2 页仍全部是本门店的 ${bigTab.status}`,
              `${wrong.length} 行不符：${wrong.map((r) => `${r[0]}/${r[1]}`).join(' ')}`,
            );
          } else {
            ok(
              `「${bigTab.tab}」第 2 页仍全部是本门店的 ${bigTab.status}`,
              `第 1 页 ${p1.length} 行 + 第 2 页 ${p2.length} 行，无重叠`,
            );
          }
        }
        }
      }
    }

    // ===================================================================
    // 【判据 ⑦】控制台无可解释错误
    // ===================================================================
    console.log('\n──── ④ 无 429 · 无可解释的控制台错误 ────');
    // 🔴 429 必须单独判：限流会让 Tab **取不到数**（实测「待客户评价」因此 0 行），
    //    那种表现与"筛选没生效"完全同形。不单列就会被读成产品缺陷。
    if (count429 > 0) {
      no('全程无 429（限流会让 Tab 取不到数）', `${count429} 个 · 最后一个：${last429Url.slice(0, 160)}`);
    } else {
      ok('全程无 429', `本轮共 ${calls.length} 个 /api 请求`);
    }
    const others = consoleErrors.filter((e) => !(/AxiosError/.test(e) && /403/.test(e)));
    if (others.length) {
      for (const e of others.slice(0, 5)) console.log(`       ${e.slice(0, 220)}`);
      no('控制台无可解释错误', `${others.length} 条`);
    } else {
      ok(
        '控制台无可解释错误',
        consoleErrors.length ? `${consoleErrors.length} 条均为 AxiosError 403（菜单探测的正常 403）` : '0 条',
      );
    }
  } catch (error) {
    no('浏览器验收跑完', `${error?.message ?? error}`);
  } finally {
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  通过 ${passed.length} 项 · 未达标 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log('══════════════════════════════════════════════════════════════');
  return failures.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.log(`✗ 未预期错误：${error?.stack ?? error}`);
    process.exit(2);
  });
