#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-concurrency-phase2.mjs
 *  —— Phase 2 挂起项的**唯一解除手段**：100 路真实并发取号验收
 * -----------------------------------------------------------------------------
 *  背景
 *  ----
 *  Phase 2 的原始验收门槛是「并发 100 次取号无重复、无空洞」。Phase 2 自身
 *  **没有任何对外接口能触发取号**（唯一入口是 Phase 3 的「创建工单」），
 *  因此该项被登记为**挂起项**，Phase 2 不得标记为 PASS（见 docs/PHASE-2.md §7）。
 *
 *  本脚本依赖 Phase 3 的 `POST /api/public/tickets`。**Phase 3 完成前运行必然失败**，
 *  这不是脚本的问题，而是"环境未就绪"——此时退出码为 **2**（既不是 PASS 也不是 FAIL）。
 *
 *  ⛔ 禁止事项（用户明确要求，写在最前面避免被绕过）
 *  -------------------------------------------------
 *  1. **禁止用 SQL 直连 SequenceService 替代本脚本。**
 *     直接用 SQL 调 upsert 只能证明"PostgreSQL 的行锁是对的"，证明不了
 *     "我们的 GuardService / TicketService / SequenceService 串起来是对的"——
 *     那是自欺欺人的绿灯。
 *  2. **禁止为了让断言变绿而删掉频控/幂等/唯一约束。**
 *     它们是设计特性：本次压测如果被 IP 频控拦住，正确做法是**显式登记为环境未就绪**，
 *     而不是把闸门拆掉。
 *
 *  必须经过的全链路
 *  ----------------
 *    HTTP → nginx(/api 反代) → NocoBase resourcer → GuardService（IP/手机号/重复单/幂等）
 *         → TicketService.create（取号 + 建单 + 写事件，同事务）→ SequenceService → PostgreSQL
 *
 *  8 条断言（契约见 docs/PHASE-2.md §7.2）
 *  ---------------------------------------
 *   1. 100 路并发创建**无 5xx**（含超时/连接重置）
 *   2. 恰好产生 **100 张工单**（不多不少；幂等与频控不能吃掉合法请求）
 *   3. 100 个 `ticket_no` **互不相同**
 *   4. 序号**连续无空洞**（后缀 == 基线+1…基线+100；且 `daily_sequences` 增量 == 100）
 *   5. 唯一索引**不冲突**（无 23505，且无静默吞错——由 2/3/4 的计数共同兜底）
 *   6. `ticketEvents` 条数正确（每张新建工单恰好 1 条 `created` 事件）
 *   7. **重复 `request_id` 不消耗序号**（重放后 `current_value` 不推进）
 *   8. **幂等不产生新单号**（同 `request_id` 第二次调用返回首个工单号，且总数不变）
 *
 *  用法
 *  ----
 *    node scripts/verify-concurrency-phase2.mjs
 *    node scripts/verify-concurrency-phase2.mjs --wait 240
 *    node scripts/verify-concurrency-phase2.mjs --concurrency 100 --store-code S01
 *    node scripts/verify-concurrency-phase2.mjs --ready-marker 'publicTicket'   # 接口名与默认不同
 *    node scripts/verify-concurrency-phase2.mjs --skip-static-gate              # 强制发 HTTP 探测
 *    node scripts/verify-concurrency-phase2.mjs --cleanup                       # 需另开破坏性门闩
 *
 *  退出码
 *  ------
 *    0 = 8 条断言全绿（Phase 2 可补签 PASS）
 *    1 = 有断言失败（真红灯）
 *    2 = 环境未就绪（Phase 3 接口不在 / 被频控拦截 / Docker 不可用）——不是绿灯
 *
 *  ⚠️ 前置条件：并发 100 路 > `.env` 的 IP 频控 30/分钟
 *  ------------------------------------------------
 *    默认配置下 100 路里必然有约 70 路被 429 拦掉。频控是**设计特性**，不是缺陷。
 *    跑通 100 路需由运行者显式调高 `SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT`（建议 300）
 *    并 `docker compose up -d app` 重启，跑完**改回 30**。脚本不会替你拆闸门。
 *    详见 §1「频控可行性预检」。
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ CLI 参数 --
const argv = process.argv.slice(2);
const getOpt = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes(name);

/** 从 .env 读一个键（避免手工传参） */
function envValue(key, fallback = '') {
  const p = path.resolve(ROOT, '.env');
  if (!fs.existsSync(p)) return fallback;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1].trim() : fallback;
}

const PORT = envValue('NGINX_HTTP_PORT', '8080');
const BASE_URL = getOpt('--url', `http://localhost:${PORT}`).replace(/\/$/, '');
const WAIT_SECONDS = Number(getOpt('--wait', '0'));
const CONCURRENCY = Number(getOpt('--concurrency', '100'));
const STORE_CODE = getOpt('--store-code', 'S01');
const DO_CLEANUP = hasFlag('--cleanup');

/**
 * 频控阈值（分钟级 IP 限流）。
 *
 * ⚠️ 这是本脚本最容易踩的"假红灯"：
 *   `.env` 的 `SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT` 默认 **30**，
 *   而我们要发的是 **100 路并发**。也就是说**默认配置下，100 路里必然有 ~70 路被 429 拦掉**，
 *   断言 2（恰好 100 张工单）会失败 —— 但失败的根因是**频控在正常工作**，不是取号有 bug。
 *
 *   正确的处理方式有两种，都必须由运行者**显式**选择，脚本不替他决定：
 *     A) 临时把 `SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT` 调到 ≥ CONCURRENCY（如 300），
 *        `docker compose up -d app` 重启应用后再跑本脚本；跑完**改回 30**。
 *        → 这时 429 数应为 0，断言 2 才有意义。
 *     B) 保持 30 不变，只做"小并发"验证（`--concurrency 30`）—— 但那**不满足**
 *        Phase 2 挂起项的"100 路"要求，不能据此补签 PASS。
 *
 *   本脚本在发压**之前**会把这个冲突打印出来，并在出现 429 时直接以退出码 2
 *   （环境未就绪）收场，绝不把它记成断言失败去误导人。
 */
const IP_MINUTE_LIMIT = Number(envValue('SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT', '30'));
const PHONE_DAILY_LIMIT = Number(envValue('SVC_DEFAULT_SECURITY_TICKET_PHONE_DAILY_LIMIT', '5'));

const PUBLIC_TICKET_PATH = '/api/public/tickets';
const HEALTH_PATH = '/api/svc/health';

// ------------------------------------------------------------------ 断言框架 --
let passed = 0;
const failures = [];
const warnings = [];
const blocked = [];

/**
 * 断言包装。**必须 await**：支持同步与异步（async）断言函数。
 * 若不 await 一个 async 断言，异常会变成 unhandled rejection 而被静默吞掉 ——
 * 所以这里统一 async，并要求调用方 await，杜绝"看起来绿实际没跑"。
 */
async function check(label, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures.push({ label, message: e.message });
    console.log(`  ❌ ${label} — ${e.message}`);
  }
}

function section(title) {
  console.log('');
  console.log(`【${title}】`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 以"环境未就绪"收场：不是绿灯，也不是被验收对象的红灯 */
function block(reason) {
  blocked.push(reason);
}

/** 立即以退出码 2 结束（打印已跑过的结果，避免误导） */
function exitNotReady() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ⏸  环境未就绪 —— 本次**不是**绿灯，也**不是**被验收对象的红灯');
  console.log('══════════════════════════════════════════════════════════════');
  for (const b of blocked) console.log(`  • ${b}`);
  console.log('');
  console.log('  Phase 2 仍为 HOLD：挂起项的解除条件见 docs/PHASE-2.md §7。');
  console.log('');
  process.exit(2);
}

// ------------------------------------------------------------------ 执行封装 --
/** 执行 docker 命令并返回 stdout（失败抛错，附 stderr） */
function docker(args, opts = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      // maxBuffer 与 smoke-test.mjs 同口径：Node 默认 1MB 会把几小时的 app 日志撑爆，
      // 而 catch 里报出来的是日志首行的无关告警，完全指不到真因。
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`docker ${args.join(' ')} 失败：${msg.split('\n')[0] || '未知错误'}`);
  }
}

/** Docker 当前是否可用（不可用 → 环境未就绪，不是红灯） */
function dockerAvailable() {
  try {
    docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTP 请求（返回 {status, body, headers, error, ms}）。
 *
 * 与 smoke-test.mjs 的差别：这里**不抛网络异常**，而是把超时/连接重置记进
 * `error` 字段 —— 断言 1 要断言的正是"无 5xx（含超时/连接重置）"，
 * 若异常直接抛出，就变成"脚本崩了"而不是"这条断言失败了"，定位会失真。
 */
async function http(url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeout ?? 20000),
      headers: opts.headers,
      body: opts.body,
    });
    const text = await res.text();
    return { status: res.status, body: text, headers: res.headers, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, body: '', headers: new Headers(), error: e.message, ms: Date.now() - started };
  }
}

/** 解析 JSON，失败给清晰的错误 */
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} 返回的不是合法 JSON：${text.slice(0, 200)}`);
  }
}

/**
 * 解包 NocoBase 响应信封：resourcer 会把 action 返回值包成 `{ "data": ... }`。
 * 兼容"没有信封"的形态，避免 NocoBase 调整信封时整份脚本失效。
 */
function unwrap(json) {
  if (json && typeof json === 'object' && json.data !== undefined) return json.data;
  return json;
}

const psql = (sql) => {
  const user = envValue('POSTGRES_USER', 'svc_app');
  const db = envValue('POSTGRES_DB', 'service_ticket');
  return docker([
    'exec', 'svc-postgres',
    'psql', '-U', user, '-d', db, '-t', '-A', '-F', '|', '-c', sql,
  ], { timeout: 30000 }).trim();
};

/** psql 原始文本 → 行数组（-t 去表头 / -A 去对齐） */
const psqlRows = (sql) => psql(sql).split('\n').map((s) => s.trim()).filter(Boolean);

/**
 * 取单个标量值。必须只取第一行：`INSERT ... RETURNING` 除了结果行还会打印一行
 * 命令标签（`INSERT 0 1`），整个输出直接 Number() 会得到 NaN。
 */
const psqlScalar = (sql) => psqlRows(sql)[0] ?? '';

/** 生成 N 个互不相同的合规手机号（`/^1[3-9]\d{9}$/`） */
function makeMobiles(n) {
  const out = [];
  const base = 13800000000;
  for (let i = 0; i < n; i += 1) {
    // 138 + 8 位序号，逐位取模保证不越界且互不相同
    const suffix = String((i + 1) % 100000000).padStart(8, '0');
    out.push(`138${suffix}`);
  }
  // 构造后自检：格式与唯一性（避免生成器本身写错，导致"我的测试数据不合法"）
  const re = /^1[3-9]\d{9}$/;
  for (const m of out) {
    if (!re.test(m)) throw new Error(`生成的手机号不合法：${m}`);
  }
  if (new Set(out).size !== n) throw new Error('生成的手机号出现重复');
  return out;
}

/** 生成第 i 个压测请求体（手机号/内容/request_id 全部唯一，避免触发"重复单"与"幂等"） */
function makePayload(i, mobile) {
  return {
    store_code: STORE_CODE,
    source: 'qr',
    ticket_type: 'repair',
    content: `并发取号压测 #${i + 1}：空调不制冷，出风有异味，需上门检查。`,
    customer_name: `压测${String(i + 1).padStart(3, '0')}`,
    customer_mobile: mobile,
    privacy_agreed: true,
  };
}

// ============================================================================
// 0) 前置：Docker / 容器 / 接口是否就绪
// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Phase 2 挂起项验收：100 路真实并发创建工单（取号正确性）');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  目标地址   ${BASE_URL}${PUBLIC_TICKET_PATH}`);
console.log(`  并发数     ${CONCURRENCY}`);
console.log(`  门店       ${STORE_CODE}`);
console.log(`  IP 频控    ${IP_MINUTE_LIMIT} 次/分钟（.env: SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT）`);
console.log(`  手机频控   ${PHONE_DAILY_LIMIT} 次/天（.env: SVC_DEFAULT_SECURITY_TICKET_PHONE_DAILY_LIMIT）`);
console.log('');

if (!dockerAvailable()) {
  block('Docker daemon 不可用。本脚本必须查真实 PostgreSQL（`docker exec svc-postgres psql`），无法在离线状态运行。');
  exitNotReady();
}

if (WAIT_SECONDS > 0) {
  process.stdout.write(`  … 等待应用就绪（最多 ${WAIT_SECONDS}s）`);
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    const r = await http(`${BASE_URL}${HEALTH_PATH}`, { timeout: 5000 });
    if (r.status === 200) {
      ready = true;
      break;
    }
    process.stdout.write('.');
    await sleep(5000);
  }
  console.log(ready ? ' 就绪' : ' 超时');
  if (!ready) {
    block(`等待 ${WAIT_SECONDS}s 后 ${HEALTH_PATH} 仍未返回 200。`);
    exitNotReady();
  }
}

section('0 前置检查');

// ---------------------------------------------------------------------------
// 0.1 静态就绪门（先静态、后联网）
// ---------------------------------------------------------------------------
// 为什么不能一上来就 POST 探测：
//   如果 Phase 3 还没实现，`POST /api/public/tickets` 会让 NocoBase 记下
//   `[Error: public resource does not exist`（level=error）。
//   而 `smoke-test.mjs` 有一条断言是"app 日志中**最近一段窗口内**无 error 级别输出"——
//   于是"跑一次并发脚本"会**污染**"随后跑冒烟"的结果，冒烟出现一条与取号毫无关系的红灯。
//   这类"我的测试工具自己把环境搞脏"的问题，比被测对象的缺陷更浪费时间：
//   查的人会去翻取号代码，而真相是脚本多发了一个必然 404 的请求。
//
// 处理：先用**静态产物检查**判断接口在不在（零副作用），
//       接口不在 → 直接以退出码 2 收场，**一个 HTTP 请求都不发**。
//       接口在   → 才发真实请求（此时路径存在，不会产生 error 日志）。
//
// 标记：默认认 `publicTickets?`（Phase 3 按 docs/API.md §1.2 落地的资源名）。
//       若 Phase 3 用了别的名字，用 `--ready-marker <正则>` 覆盖，不必改脚本。
//       `--skip-static-gate` 可跳过静态门，直接发 HTTP 探测（用于排查"产物里有但路由没生效"）。
const READY_MARKER = getOpt('--ready-marker', 'publicTickets?');
const SKIP_STATIC_GATE = hasFlag('--skip-static-gate');

const PUBLIC_ACTIONS_DIR = path.resolve(
  ROOT, 'nocobase/plugins/service-ticket/src/server/actions/public',
);
const BUNDLE_PATH = path.resolve(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');

/**
 * 去掉 JS 注释（行注释 + 块注释）。
 *
 * ⚠️ 为什么必须去注释（踩过）：
 *   `constants.ts` 里有一段**注释掉的**接口规划示例：
 *     // ['publicTicket', 'create'],    // POST /api/publicTicket:create
 *   其中的 `publicTicket` 会被原样打进 bundle，于是"产物侧含 publicTicket"这个检查
 *   **在接口一行都没实现时就恒为真** —— 门闩形同虚设。
 *   这正是本项目反复出现的那类缺陷：断言写得出来、也一直绿，但它测的不是它声称的东西。
 *
 * 去注释只用于"是否存在"这类存在性判断，不做语义解析，
 * 因此用朴素的状态机即可（不处理正则字面量里的 `//`，对本用途无影响）。
 */
function stripComments(code) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | str1 | str2 | tpl
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") state = 'str1';
      else if (c === '"') state = 'str2';
      else if (c === '`') state = 'tpl';
      out += c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
    } else {
      // 字符串内部：原样保留，遇转义跳过下一个字符
      out += c;
      if (c === '\\') { out += code[i + 1] ?? ''; i += 2; continue; }
      const closer = state === 'str1' ? "'" : state === 'str2' ? '"' : '`';
      if (c === closer) state = 'code';
    }
    i += 1;
  }
  return out;
}

function staticReadiness() {
  const reasons = [];

  // ① 源码侧：public action 目录里除了 health 之外有没有东西
  let srcExtra = [];
  if (fs.existsSync(PUBLIC_ACTIONS_DIR)) {
    srcExtra = fs.readdirSync(PUBLIC_ACTIONS_DIR)
      .filter((f) => f.endsWith('.ts') && !f.startsWith('health'));
  }
  if (srcExtra.length === 0) reasons.push(`源码侧：${path.relative(ROOT, PUBLIC_ACTIONS_DIR)} 下除 health 外无任何 public action`);

  // ② 产物侧：编译后的 bundle（**去掉注释后**）里有没有出现该资源名
  //    源码写了但没 build、或只有注释示例，都应当判定为"没就位"
  let bundleHit = false;
  if (fs.existsSync(BUNDLE_PATH)) {
    const code = stripComments(fs.readFileSync(BUNDLE_PATH, 'utf8'));
    bundleHit = new RegExp(READY_MARKER, 'i').test(code);
  }
  if (!bundleHit) reasons.push(`产物侧：${path.relative(ROOT, BUNDLE_PATH)} 的**代码**（已去注释）中未出现标记 /${READY_MARKER}/i —— 可能是改了源码但没跑 build-plugin.mjs，或只有注释示例`);

  return { ok: srcExtra.length > 0 && bundleHit, reasons, srcExtra, bundleHit };
}

const readiness = staticReadiness();

if (!SKIP_STATIC_GATE && !readiness.ok) {
  block(
    'Phase 3 的「创建工单」接口尚未就位，静态就绪门未通过：\n       ' +
      readiness.reasons.join('\n       '),
  );
  block(
    '本项目**明确禁止**用 SQL 直连 SequenceService 替代真实 HTTP 压测' +
      '（那只能验证 PostgreSQL 的行锁，验证不了我们的代码）。' +
      '因此本次不发任何 HTTP 请求 —— 也顺带避免了给 svc-app 写一条 `public resource does not exist` 的 error 日志' +
      '（那会让随后跑的 smoke-test「最近窗口内无 error」断言误报红灯）。',
  );
  exitNotReady();
}

console.log(
  readiness.ok
    ? `  ✅ 静态就绪门通过（源码 ${readiness.srcExtra.join(', ')}；产物含 /${READY_MARKER}/i）`
    : `  ⚠️  已用 --skip-static-gate 跳过静态就绪门（将直接发 HTTP 探测，若路径不存在会给 svc-app 写 error 日志）`,
);

/** 接口是否已经存在（Phase 3 未完成时这里是 404/405） */
const probePayload = makePayload(0, '13800000000');
const probe = await http(`${BASE_URL}${PUBLIC_TICKET_PATH}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Request-Id': randomUUID() },
  body: JSON.stringify(probePayload),
  timeout: 20000,
});

if (probe.status === 404 || probe.status === 405) {
  block(
    `${PUBLIC_TICKET_PATH} 返回 ${probe.status} —— Phase 3 的「创建工单」接口尚未实现。` +
      '本项目**明确禁止**用 SQL 直连 SequenceService 替代真实 HTTP 压测（那只能验证 PostgreSQL，验证不了我们的代码）。',
  );
  exitNotReady();
}

if (probe.status === 0) {
  block(`无法连通 ${BASE_URL}（${probe.error}）。请确认容器已启动：docker compose up -d。`);
  exitNotReady();
}

await check(`${PUBLIC_TICKET_PATH} 可访问且不返回 5xx`, () => {
  assert(probe.status < 500, `探测请求返回 ${probe.status}：${probe.body.slice(0, 200)}`);
  return `status=${probe.status}`;
});

// 探测请求本身也是一张真实工单：它会消耗 1 个号。为了让"序号连续"口径干净，
// 我们在记录基线**之前**先把它删掉是不行的（脏操作），所以改为：
// **基线在探测请求之后取**，后续 100 路压在基线之上连续推进。
const probeBody = probe.status < 400 ? unwrap(parseJson(probe.body, '探测请求')) : null;
const probeTicketNo = probeBody?.ticket_no ?? null;
if (probeTicketNo) console.log(`     （探测请求已建单 ${probeTicketNo}，将计入基线）`);

// 断言 2 要求"恰好 100 张"：探测请求会多出 1 张。
// 口径处理：压测集合只统计**本次并发发出的 100 个 request_id** 的产物，
// 而不是"当天工单总数"——否则任何历史数据（冒烟脚本、手工点单）都会让断言失真。
// 这样"不多不少"依然是硬断言，且与"当天总数"解耦。

// ============================================================================
// 1) 频控可行性预检（避免把"频控正常工作"误记成"取号有 bug"）
// ============================================================================
section('1 频控可行性预检');

if (CONCURRENCY > IP_MINUTE_LIMIT) {
  console.log(`  ⚠️  并发 ${CONCURRENCY} > IP 频控 ${IP_MINUTE_LIMIT}/分钟 —— 默认配置下必然出现 429。`);
  console.log('');
  console.log('      频控是**设计特性**，不是缺陷。要跑通 100 路真实并发，需由运行者显式选择：');
  console.log(`        A) 临时把 SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT 调到 ≥ ${CONCURRENCY}（建议 300），`);
  console.log('           `docker compose up -d app` 重启应用后再跑本脚本，跑完**务必改回 30**；');
  console.log(`        B) 改成 --concurrency ${IP_MINUTE_LIMIT} 只做小并发验证 —— 但这**不满足**`);
  console.log('           Phase 2 挂起项的"100 路"要求，不能据此补签 PASS。');
  console.log('');
  console.log('      本脚本不去拆频控闸门（那属于"为造绿灯而改被测对象"），');
  console.log('      而是继续发压，把 429 数如实报出来，并在出现 429 时以退出码 2 收场。');
  warnings.push(
    `并发 ${CONCURRENCY} 超过 IP 频控 ${IP_MINUTE_LIMIT}/分钟。若出现 429，请按上述 A 方案调高阈值后重跑。`,
  );
} else {
  console.log(`  ✅ 并发 ${CONCURRENCY} ≤ IP 频控 ${IP_MINUTE_LIMIT}/分钟，频控不会影响本次压测。`);
}

// 手机号频控：本脚本每个 request_id 用**独立手机号**（各 1 次），故不受 daily limit 影响。
// 但若 PHONE_DAILY_LIMIT < 1 则全部会被拦，因此显式检查一下。
await check('手机号频控不会吃掉本次请求（每号 1 次）', () => {
  assert(PHONE_DAILY_LIMIT >= 1, `SVC_DEFAULT_SECURITY_TICKET_PHONE_DAILY_LIMIT=${PHONE_DAILY_LIMIT}，每号 1 次也会被拦`);
  return `每号 1 次 ≤ ${PHONE_DAILY_LIMIT}/天；共需 ${CONCURRENCY} 个独立手机号`;
});

// ============================================================================
// 2) 取基线（序号 / 事件 / 幂等表）
// ============================================================================
section('2 取基线');

/** 日期取自探测请求的工单号（`FW20260920-0001` → 20260920），避免自己算时区出错 */
const datePart = probeTicketNo ? probeTicketNo.slice(2, 10) : null;
if (!datePart) {
  block(
    `无法从探测请求确定取号日期键（探测返回 ${probe.status}：${probe.body.slice(0, 200)}）。` +
      '请先确认 Phase 3 的创建工单接口已按 docs/API.md §1.2 返回 ticket_no。',
  );
  exitNotReady();
}

const SEQ_KEY = `FW-${datePart}`;
const TICKET_PREFIX = `FW${datePart}-`;

const seqBefore = Number(psqlScalar(
  `SELECT current_value FROM daily_sequences WHERE seq_key = '${SEQ_KEY}'`,
) || 0);

const eventsBefore = Number(psqlScalar('SELECT count(*) FROM "ticketEvents"') || 0);
const idemBefore = Number(psqlScalar('SELECT count(*) FROM "idempotencyRecords"') || 0);

console.log(`  取号键        ${SEQ_KEY}`);
console.log(`  基线 current_value  ${seqBefore}`);
console.log(`  基线 ticketEvents   ${eventsBefore} 条`);
console.log(`  基线 idempotencyRecords  ${idemBefore} 条`);
// 记下 app 日志的起始时间，供断言 5 扫"压测窗口内有没有 23505"
const logSince = new Date(Date.now() - 3000).toISOString();

// ============================================================================
// 3) 100 路真实并发
// ============================================================================
section(`3 ${CONCURRENCY} 路真实并发创建工单`);

const mobiles = makeMobiles(CONCURRENCY);
const requestIds = [];
const results = [];

const startedAt = Date.now();
{
  // 先把所有 promise 排出来再 await，保证"同时起飞"而不是"串行等"
  const jobs = mobiles.map((mobile, i) => {
    const rid = randomUUID();
    requestIds.push(rid);
    return http(`${BASE_URL}${PUBLIC_TICKET_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid },
      body: JSON.stringify(makePayload(i, mobile)),
      timeout: 30000,
    });
  });
  const settled = await Promise.all(jobs);
  settled.forEach((r, i) => results.push({ ...r, requestId: requestIds[i], index: i }));
}
const elapsed = Date.now() - startedAt;

const byStatus = new Map();
for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
const statusSummary = [...byStatus.entries()].sort((a, b) => a[0] - b[0])
  .map(([s, n]) => `${s === 0 ? '网络错误' : s}×${n}`).join(', ');

console.log(`  完成：耗时 ${elapsed}ms，状态分布 ${statusSummary}`);
console.log(`  最慢 ${Math.max(...results.map((r) => r.ms))}ms，最快 ${Math.min(...results.map((r) => r.ms))}ms`);

const rate429 = byStatus.get(429) || 0;
if (rate429 > 0) {
  // 频控命中：这是"环境未就绪"，不是取号缺陷。继续把数字查出来供参考，但最终以 2 收场。
  block(
    `${rate429} 路被 IP 频控拦截（HTTP 429，阈值 ${IP_MINUTE_LIMIT}/分钟）。` +
      '频控是设计特性：请按 §1 的 A 方案临时调高 SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT 后重跑。' +
      '本脚本不得据此判定取号失败，也不得拆掉频控来造绿灯。',
  );
}

// 把每路的响应解出来，供后续断言使用
const created = [];
for (const r of results) {
  if (r.status === 0) continue;
  if (r.status >= 400) continue;
  try {
    const body = unwrap(parseJson(r.body, '并发请求'));
    if (body?.ticket_no) created.push({ ticketNo: body.ticket_no, requestId: r.requestId, status: r.status });
  } catch {
    /* 非 JSON 已在断言里体现 */
  }
}

// ============================================================================
// 4) 断言 1 ~ 6
// ============================================================================
section('4 断言 1–6：并发创建的正确性');

await check('断言 1 · 100 路并发无 5xx（含超时/连接重置）', () => {
  const server = results.filter((r) => r.status >= 500);
  const netErr = results.filter((r) => r.status === 0);
  const bad = [...server.map((r) => `${r.status}:${r.body.slice(0, 80)}`), ...netErr.map((r) => `网络错误:${r.error}`)];
  assert(bad.length === 0, `${bad.length} 路失败（前 3 条）：${bad.slice(0, 3).join(' | ')}`);
  return `${CONCURRENCY} 路全部 < 500，且无超时/连接重置`;
});

await check(`断言 2 · 恰好产生 ${CONCURRENCY} 张工单（不多不少）`, () => {
  if (rate429 > 0) throw new Error(`有 ${rate429} 路被 429 拦截，无法判定为"不多不少"（见 §1 频控预检）`);
  const nonOk = results.filter((r) => r.status !== 200 && r.status !== 201);
  assert(nonOk.length === 0, `${nonOk.length} 路非 2xx（前 3 条）：${nonOk.slice(0, 3).map((r) => `${r.status} ${r.body.slice(0, 60)}`).join(' | ')}`);
  assertEq(created.length, CONCURRENCY, '带 ticket_no 的成功响应数');
  return `${created.length} 张，全部 2xx`;
});

await check('断言 3 · 100 个 ticket_no 互不相同', () => {
  const uniq = new Set(created.map((c) => c.ticketNo));
  if (uniq.size !== created.length) {
    const dup = created.map((c) => c.ticketNo).filter((v, i, a) => a.indexOf(v) !== i);
    throw new Error(`出现重复工单号：${[...new Set(dup)].slice(0, 5).join(', ')}`);
  }
  assertEq(uniq.size, CONCURRENCY, '唯一工单号个数');
  return `全部唯一（示例 ${created[0]?.ticketNo} … ${created[created.length - 1]?.ticketNo}）`;
});

await check('断言 4 · 序号连续无空洞（后缀 == 基线+1…基线+N，且取号器增量 == N）', () => {
  const nums = created
    .map((c) => c.ticketNo)
    .filter((no) => no.startsWith(TICKET_PREFIX))
    .map((no) => Number(no.slice(TICKET_PREFIX.length)));
  assertEq(nums.length, CONCURRENCY, `符合 ${TICKET_PREFIX} 前缀的工单号个数`);
  const sorted = [...nums].sort((a, b) => a - b);
  const want = Array.from({ length: CONCURRENCY }, (_, i) => seqBefore + i + 1);
  assertEq(sorted[0], seqBefore + 1, '最小序号（应紧接基线）');
  assertEq(sorted[sorted.length - 1], seqBefore + CONCURRENCY, '最大序号');
  const holes = want.filter((v) => !nums.includes(v));
  assert(holes.length === 0, `出现空洞：${holes.slice(0, 10).join(', ')}`);
  assertEq(new Set(nums).size, CONCURRENCY, '序号去重后个数');

  const seqAfter = Number(psqlScalar(`SELECT current_value FROM daily_sequences WHERE seq_key = '${SEQ_KEY}'`) || 0);
  assertEq(seqAfter - seqBefore, CONCURRENCY, `daily_sequences(${SEQ_KEY}) 增量`);
  return `序号 ${sorted[0]}…${sorted[sorted.length - 1]} 连续，current_value ${seqBefore}→${seqAfter}`;
});

await check('断言 5 · 唯一索引不冲突（压测窗口内无 23505，且无静默吞错）', () => {
  // 客户端侧：无 5xx（唯一约束冲突会以 500 暴露，而不是静默）
  assert(results.filter((r) => r.status >= 500).length === 0, '存在 5xx，可能含唯一约束冲突');
  // 服务端侧：扫压测窗口内的应用日志
  let logs = '';
  try {
    logs = docker(['logs', '--since', logSince, 'svc-app'], { timeout: 30000 });
  } catch (e) {
    throw new Error(`无法读取 svc-app 日志：${e.message}`);
  }
  const hits = logs.split('\n').filter((l) => l.includes('23505') || /duplicate key value/i.test(l));
  assert(hits.length === 0, `压测窗口内出现唯一约束冲突 ${hits.length} 次：${hits[0]?.slice(0, 160)}`);
  // "无静默吞错"：断言 2/3/4 的计数是硬等式，任何被吞掉的失败都会让等式不成立
  return `无 23505 / duplicate key；计数等式（2/3/4）同时成立即排除静默吞错`;
});

await check('断言 6 · ticketEvents 条数正确（每张新建工单恰好 1 条 created 事件）', () => {
  const nos = created.map((c) => `'${c.ticketNo}'`).join(',');
  const rows = psqlRows(
    `SELECT t.ticket_no || '|' || count(a.id) ` +
      `FROM "serviceTickets" t ` +
      `LEFT JOIN "ticketEvents" a ON a.ticket_id = t.id AND a.event_type = 'created' ` +
      `WHERE t.ticket_no IN (${nos}) GROUP BY 1`,
  );
  assertEq(rows.length, CONCURRENCY, '查到的工单行数');
  const bad = rows.filter((r) => Number(r.split('|')[1]) !== 1);
  assert(bad.length === 0, `${bad.length} 张工单的 created 事件数不为 1（前 5 条）：${bad.slice(0, 5).join(', ')}`);
  const totalAfter = Number(psqlScalar('SELECT count(*) FROM "ticketEvents"') || 0);
  return `每张恰好 1 条 created；ticketEvents 总行数 ${eventsBefore}→${totalAfter}`;
});

// ============================================================================
// 5) 断言 7 ~ 8：幂等
// ============================================================================
section('5 断言 7–8：request_id 幂等');

// 幂等验证用**独立**的 request_id（与压测的 100 个不重叠），
// 手机号也要独立，否则会先被"同号同店同类型"重复单规则拦掉，测的就不是幂等了。
const idemMobile = '13900000001';
const idemRequestId = randomUUID();
const idemBody = JSON.stringify({
  store_code: STORE_CODE,
  source: 'qr',
  ticket_type: 'repair',
  content: '幂等验证：同一 request_id 重放，不得产生新工单。',
  customer_name: '幂等验证',
  customer_mobile: idemMobile,
  privacy_agreed: true,
});
const idemHeaders = { 'Content-Type': 'application/json', 'X-Request-Id': idemRequestId };

const idemFirst = await http(`${BASE_URL}${PUBLIC_TICKET_PATH}`, {
  method: 'POST', headers: idemHeaders, body: idemBody, timeout: 20000,
});
const seqAfterFirst = Number(psqlScalar(`SELECT current_value FROM daily_sequences WHERE seq_key = '${SEQ_KEY}'`) || 0);
const ticketsAfterFirst = Number(psqlScalar(`SELECT count(*) FROM "serviceTickets" WHERE ticket_no LIKE '${TICKET_PREFIX}%'`) || 0);

const idemSecond = await http(`${BASE_URL}${PUBLIC_TICKET_PATH}`, {
  method: 'POST', headers: idemHeaders, body: idemBody, timeout: 20000,
});
const seqAfterSecond = Number(psqlScalar(`SELECT current_value FROM daily_sequences WHERE seq_key = '${SEQ_KEY}'`) || 0);
const ticketsAfterSecond = Number(psqlScalar(`SELECT count(*) FROM "serviceTickets" WHERE ticket_no LIKE '${TICKET_PREFIX}%'`) || 0);

const idemNo1 = idemFirst.status < 400 ? unwrap(parseJson(idemFirst.body, '幂等第 1 次'))?.ticket_no : null;
const idemNo2 = idemSecond.status < 400 ? unwrap(parseJson(idemSecond.body, '幂等第 2 次'))?.ticket_no : null;

if (idemFirst.status >= 400 || idemSecond.status >= 400) {
  block(
    `幂等验证请求未成功（第 1 次 ${idemFirst.status} / 第 2 次 ${idemSecond.status}）：` +
      `${idemFirst.body.slice(0, 120)} | ${idemSecond.body.slice(0, 120)}`,
  );
}

await check('断言 7 · 重复 request_id 不消耗序号', () => {
  assert(idemFirst.status < 400, `第 1 次调用失败：${idemFirst.status} ${idemFirst.body.slice(0, 160)}`);
  assert(idemSecond.status < 400, `第 2 次调用失败：${idemSecond.status} ${idemSecond.body.slice(0, 160)}`);
  assertEq(seqAfterSecond - seqAfterFirst, 0, `重放后 daily_sequences(${SEQ_KEY}) 的增量`);
  return `重放前后 current_value 均为 ${seqAfterSecond}（第 1 次建单 ${idemNo1}，取号后为 ${seqAfterFirst}）`;
});

await check('断言 8 · 幂等不产生新单号（返回首个工单号，且总数不变）', () => {
  assert(idemFirst.status < 400 && idemSecond.status < 400, '幂等验证请求未成功');
  assert(idemNo1, '第 1 次未返回 ticket_no');
  assertEq(idemNo2, idemNo1, '第 2 次返回的 ticket_no（应与第 1 次相同）');
  assertEq(ticketsAfterSecond, ticketsAfterFirst, `当天工单数（${TICKET_PREFIX}*）`);
  // 幂等记录只有 1 条（scene=public_ticket, key=request_id）
  const recCount = Number(psqlScalar(
    `SELECT count(*) FROM "idempotencyRecords" WHERE idempotency_key = '${idemRequestId}'`,
  ) || 0);
  assertEq(recCount, 1, '该 request_id 的幂等记录条数');
  return `${idemNo1} 两次一致；工单总数未变；幂等记录 1 条`;
});

// ============================================================================
// 6) 可选的清理（破坏性操作，需显式门闩）
// ============================================================================
if (DO_CLEANUP) {
  section('6 清理本次压测产生的工单（--cleanup）');

  // 与 .probe 下的破坏性探针同一条门槛：必须显式放行，避免误删。
  if (process.env.SVC_PROBE_ALLOW_DESTRUCTIVE !== '1') {
    console.log('  ⛔ 拒绝执行：--cleanup 是破坏性操作，需要显式放行：');
    console.log('     SVC_PROBE_ALLOW_DESTRUCTIVE=1 node scripts/verify-concurrency-phase2.mjs --cleanup');
    warnings.push('--cleanup 被门闩拒绝，本次压测产生的工单未清理（属正常保护行为）。');
  } else {
    const allNos = [...created.map((c) => c.ticketNo), ...(probeTicketNo ? [probeTicketNo] : []), ...(idemNo1 ? [idemNo1] : [])];
    const list = allNos.map((n) => `'${n}'`).join(',');
    console.log(`  将删除 ${allNos.length} 张工单（按 ticket_no 精确匹配，不按时间范围，避免误删他人工单）：`);
    console.log(`    ${allNos.slice(0, 3).join(', ')}${allNos.length > 3 ? ` … 共 ${allNos.length} 张` : ''}`);
    // 先删子表（事件），再删工单；幂等记录按 request_id 精确删
    psql(`DELETE FROM "ticketEvents" WHERE ticket_id IN (SELECT id FROM "serviceTickets" WHERE ticket_no IN (${list}))`);
    psql(`DELETE FROM "serviceTickets" WHERE ticket_no IN (${list})`);
    const ridList = [...requestIds, idemRequestId].map((r) => `'${r}'`).join(',');
    psql(`DELETE FROM "idempotencyRecords" WHERE idempotency_key IN (${ridList})`);
    console.log('  ✅ 已清理（注意：daily_sequences 的 current_value **不回收** ——');
    console.log('     号码一旦发出就作废，这是 SequenceService 的刻意设计，见 sequence-service.ts 顶部注释）');
  }
}

// ============================================================================
// 汇总
// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');

/**
 * 判定优先级：**blocked 先于 failures**。
 *
 * 理由：一旦出现 429 频控拦截，断言 2（"恰好 100 张"）必然失败，但它反映的是
 * "环境没配成能跑 100 路"，不是"取号有 bug"。如果把这种失败当红灯报出去，
 * 运维会去查取号代码，而真正的动作只是调高一个阈值 —— 又是一次"狼来了"。
 * 因此这里以"环境未就绪"收场，并把附带的失败项如实列出、标注需在环境就绪后复核。
 */
if (blocked.length > 0) {
  if (failures.length) {
    console.log(`  ⏸  环境未就绪（另观察到 ${failures.length} 项失败，需在环境就绪后复核，暂不计为红灯）：`);
    for (const f of failures) console.log(`     • ${f.label}\n       ${f.message}`);
  }
  exitNotReady();
}

if (failures.length > 0) {
  console.log(`  ❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`     • ${f.label}\n       ${f.message}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Phase 2 仍为 HOLD。请带着上面每条失败信息回到 docs/PHASE-2.md §7.2 逐条核对。');
  console.log('');
  process.exit(1);
}

if (warnings.length) {
  console.log('  ⚠️  告警：');
  for (const w of warnings) console.log(`     • ${w}`);
  console.log('');
}

console.log(`  ✅ Phase 2 挂起项解除：${passed} 项断言全绿（100 路真实并发取号）`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('  8 条契约全部满足，可据此在 docs/PHASE-2.md §7 把整改项 2 标记为完成，');
console.log('  并把 Phase 2 状态由 HOLD **补签为 PASS**（同时更新 README / CHANGELOG / DEV-PLAN）。');
console.log('');
console.log(`  证据摘要：${CONCURRENCY} 路并发耗时 ${elapsed}ms；`);
console.log(`            ticket_no ${created[0]?.ticketNo ?? '-'} … ${created[created.length - 1]?.ticketNo ?? '-'}；`);
console.log(`            daily_sequences(${SEQ_KEY}) ${seqBefore} → ${seqAfterSecond}；`);
console.log(`            ticketEvents ${eventsBefore} → ${Number(psqlScalar('SELECT count(*) FROM "ticketEvents"') || 0)}。`);
console.log('');
process.exit(0);
