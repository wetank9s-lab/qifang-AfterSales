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
 *  3. **禁止为了跑通而关闭手机号防刷。** 可重复运行必须靠"每轮独立测试数据"解决
 *     （见下方 run_id），不是靠关掉防刷。
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
 *  ★ 可重复运行（run_id）
 *  ---------------------
 *  本脚本可以在同一天反复运行。每次运行生成一个 `RUN_ID`，并据此派生**本轮独立**的：
 *    · 100 个合法手机号（`13` + 6 位 run nonce + 3 位序号）
 *    · 唯一的报修内容文本（内含 RUN_ID）
 *    · 幂等专项测试用的手机号
 *  nonce 生成后会**回查数据库**（`service_tickets.customer_mobile` 与
 *  `api_guards` 的手机号哈希）确认未被历史运行占用，占用则换 nonce 重试。
 *
 *  为什么必须这样做：若沿用固定的 `13800000001…100`，第二次运行会被
 *    · 手机号日频控（`security.ticket_phone_daily_limit`，按天计数）
 *    · 重复单窗口（`security.duplicate_window_minutes`）
 *    · `api_guards` 里上一次运行遗留的计数行
 *  三重拦截，于是"回归失败"其实与代码无关。这类假红灯比真红灯更浪费时间。
 *
 *  ★ IP 频控真实剩余额度预检
 *  -------------------------
 *  发压**之前**先问应用：本 IP 在当前分钟窗口已用了多少次、阈值多少、还剩多少。
 *  剩余不足以覆盖本次所需（100 并发 + 1 探测 + 2 幂等）时直接 `exit 2 = ENV_NOT_READY`，
 *  **不先发请求再靠 429 判断**。
 *
 *  预检接口为 `GET /api/svc:guardQuota?scene=public_ticket`（只读诊断，不计入限流）。
 *  用应用自己算，而不是脚本本地复算：IP 取值（X-Real-IP）、密钥哈希（sha256(key+SIGN_SECRET)）
 *  都由 `GuardService` 唯一决定，脚本复算一遍就多一份会漂移的实现。
 *
 *  验收环境允许临时放宽 IP 阈值（如 300/500），**但测试结束后必须恢复生产默认值**；
 *  脚本在结尾会显式提醒（`--limit-restore-to` 可指定生产默认值）。
 *
 *  ⚠️ 放宽阈值必须**两层一起改**，而且应用层要**改库**（改 .env 无效）：
 *     A) 应用层：`UPDATE service_settings SET value='300' WHERE key='security.ip_minute_limit'`
 *        —— `seedSettings` 是「存在即跳过」，.env 只决定**首次**种子值，运行期以库为准；
 *        改库后 ConfigService 的 10s TTL 到期即生效，**不需要重启应用**。
 *     B) nginx 层：`svc_public` rate 30r/m 与 `/api/public/` 的 burst、以及整站的
 *        `limit_conn svc_conn 96`，否则约 60 路会被网关 429（现象与应用层频控无法区分）。
 *     详见脚本内 `limitSteps()`。`docs/PHASE-2.md` §7.2 早期写法只写了改 .env，是错的。
 *
 *  用法
 *  ----
 *    node scripts/verify-concurrency-phase2.mjs
 *    node scripts/verify-concurrency-phase2.mjs --wait 240
 *    node scripts/verify-concurrency-phase2.mjs --concurrency 100 --store-code S01
 *    node scripts/verify-concurrency-phase2.mjs --run-id 20260920T204800-a3f1   # 复现某一轮
 *    node scripts/verify-concurrency-phase2.mjs --limit-restore-to 30
 *    node scripts/verify-concurrency-phase2.mjs --skip-static-gate              # 排查用
 *    node scripts/verify-concurrency-phase2.mjs --skip-quota-precheck           # 排查用
 *    node scripts/verify-concurrency-phase2.mjs --cleanup                       # 需另开破坏性门闩
 *
 *  退出码
 *  ------
 *    0 = 8 条断言全绿（Phase 2 可补签 PASS）
 *    1 = 有断言失败（真红灯）
 *    2 = 环境未就绪（接口不在 / 额度不足 / 诊断接口缺失 / Docker 不可用）——不是绿灯
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
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
 * IP 分钟限流阈值的**生产默认值**（用于结尾提醒"记得改回去"）。
 *
 * ⚠️ 真正的判定阈值不从这里读，而是从 `/api/svc:guardQuota` 拿 ——
 *   见文件头「IP 频控真实剩余额度预检」。这里的值只用于提示语。
 */
const IP_MINUTE_LIMIT_CONFIGURED = Number(envValue('SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT', '30'));
const LIMIT_RESTORE_TO = Number(getOpt('--limit-restore-to', String(IP_MINUTE_LIMIT_CONFIGURED)));
const PHONE_DAILY_LIMIT = Number(envValue('SVC_DEFAULT_SECURITY_TICKET_PHONE_DAILY_LIMIT', '5'));

/**
 * 「临时放宽 / 恢复」IP 阈值的**正确操作步骤**（三处提示复用同一段文案，避免过时）。
 *
 * ⚠️ 这里纠正了 `docs/PHASE-2.md` §7.2 早期写法的一个**事实错误**：
 *    改 `.env` 的 `SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT` 再 `docker compose up -d app`
 *    **不会**改变生效阈值。`seedSettings`（seeds/apply.ts）是「存在即跳过」——
 *    `.env` 只决定**首次**种进 `service_settings` 的值，之后运行期一律以库里的行为准
 *    （ConfigService 优先读库，只有库里没有该行时才回退代码默认值）。
 *    照旧文档操作的现象是：改完重启、阈值纹丝不动、429 依旧 —— 一次纯环境问题
 *    会被误读成"频控有 bug"或"取号有 bug"，是最浪费时间的一类假红灯。
 *
 * 正确做法是直接改库，而且 ConfigService 有 10s TTL 缓存，**连重启都不需要**。
 *
 * ⚠️ 还有**第二层**闸门在 nginx：`limit_req_zone svc_public`（默认 30r/m，站点侧 burst=10）
 *    与整站的 `limit_conn svc_conn 96`。只放宽应用层 → 约 60 路被 nginx 以 429 拦掉，
 *    现象与"应用层频控生效"一模一样。两层必须**一起放宽、一起恢复**。
 *
 * @param target  要放宽到的值（应 > 并发数）
 * @param restore 跑完要恢复到的生产值
 */
function limitSteps(target, restore) {
  return [
    `         A) 应用层（唯一真正起作用的一层，直接改库、无需重启）：`,
    `              docker exec svc-postgres psql -U svc_app -d service_ticket -c \\`,
    `                "UPDATE service_settings SET value='${target}', updated_at=now() WHERE key='security.ip_minute_limit'"`,
    `              （ConfigService 有 10s TTL 缓存，改完等 10s 再发压）`,
    `         B) nginx 层（只放宽 A 会被网关 429，现象与 A 生效无法区分）：`,
    `              nginx/nginx.conf 的 svc_public rate=30r/m → ${target}r/m`,
    `              nginx/conf.d/service.conf 的 /api/public/ burst=10 同步放大`,
    `              nginx/conf.d/service.conf 的 limit_conn svc_conn 96 → 256`,
    `              然后 docker exec svc-nginx nginx -s reload`,
    `         跑完**两层都要恢复**（应用层恢复为 ${restore}）。`,
  ].join('\n');
}

const PUBLIC_TICKET_PATH = '/api/public/tickets';
const HEALTH_PATH = '/api/svc/health';
const GUARD_QUOTA_PATH = '/api/svc:guardQuota';

/**
 * guardQuota 的共享密钥（请求头 `X-Svc-Diag-Key`）。
 *
 * ⚠️ **不带它，这个接口一律 404**，而且 404 就是它的设计行为：
 *   `/api/svc:guardQuota` 挂在匿名白名单上（调用它的运维脚本没有登录态），
 *   代价用两道闸门补回来 ——
 *     ① 必须带 `X-Svc-Diag-Key` 且等于**进程内**的 `SIGN_SECRET`
 *        （比较走 `crypto.timingSafeEqual`，定长、不逐字节短路）；
 *     ② `SIGN_SECRET` 为空时，服务端对一切请求 404（fail-closed）。
 *   不匹配时一律 404 而**不是** 401/403：对外它就应该"不存在"，
 *   回 401 等于承认"这里有个受保护的接口"，可以被用来确认部署形态。
 *
 * 为什么脚本要主动从 .env 读 SIGN_SECRET：让"预检接口 404"这件事**可分辨**。
 *   否则"我忘了带头"与"Phase 3 根本没做这个接口"会得到完全一样的现象，
 *   而两者的处置方式相反（前者改脚本，后者说明还没到 I 步）。
 *   可用 `--diag-key <值>` 覆盖（例如密钥不在 .env 而由编排注入时）。
 */
const DIAG_KEY = getOpt('--diag-key', envValue('SIGN_SECRET', ''));

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
  console.log('  ⏸  环境未就绪 ENV_NOT_READY —— 本次**不是**绿灯，也**不是**被验收对象的红灯');
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

// ============================================================================
// 表名常量 —— ⚠️ 本插件的表是 **snake_case**（`underscored: true`，见 DEV-14）
// ============================================================================
/**
 * 为什么把这几个名字抽成常量、并在启动时验证存在性：
 *
 *   本脚本早期版本按 NocoBase **核心**集合的风格写了 `"ticketEvents"`、
 *   `"serviceTickets"`（带引号的驼峰）。而本插件的表实际是
 *   `ticket_events` / `service_tickets` —— 带引号的驼峰标识符在 PG 里
 *   是**另一个名字**，查询会直接报 `relation does not exist`。
 *
 *   危险之处不在于报错本身，而在于**它只在 Phase 3-I 才第一次被执行到**：
 *   静态门会提前退出，所以这个 bug 在 Phase 2 全程"看起来是绿的"，
 *   一到真跑就变成一条像是"取号有问题"的失败。
 *   因此这里既抽常量，又在 §0 加一条**表名存在性自检**：
 *   名字写错会得到"表名不对"的精确结论，而不是一处莫名其妙的查询失败。
 */
const T = {
  tickets: 'service_tickets',
  events: 'ticket_events',
  idem: 'idempotency_records',
  guards: 'api_guards',
  sequences: 'daily_sequences',
};

// ============================================================================
// 0) 前置：Docker / 容器 / 表名 / 静态就绪 / 接口探测
// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Phase 2 挂起项验收：100 路真实并发创建工单（取号正确性）');
console.log('══════════════════════════════════════════════════════════════');
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
// 0.0 表名自检（把"表名写错"变成精确的早期结论）
// ---------------------------------------------------------------------------
await check('脚本依赖的 5 张表真实存在（snake_case 表名自检）', () => {
  const list = Object.values(T).map((t) => `'${t}'`).join(',');
  const rows = psqlRows(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN (${list})`,
  );
  const missing = Object.values(T).filter((t) => !rows.includes(t));
  assert(
    missing.length === 0,
    `缺失表：${missing.join(', ')}。` +
      '本插件使用 underscored:true，表名是 snake_case；' +
      '写成带引号的驼峰（如 "serviceTickets"）在 PG 里是另一个名字，会报 relation does not exist。',
  );
  return Object.values(T).join(', ');
});

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
// 所以先做零副作用的静态检查，不通过就直接退出、一个 HTTP 请求都不发。
//
// ★ 为什么不能只看"public actions 目录里有没有非 health 的 .ts 文件"：
//   Phase 3 是 A→I 分步落地的。做到 A 时目录里已经有 `stores.ts` 了，
//   于是"目录里有文件"这个条件会**在 B（创建工单）还没做的时候就成立**，
//   门闩放行 → 脚本发出 POST → 404 → 又污染日志。
//   因此收紧为两道**针对 ticket create 本身**的检查：
//     ① 源码侧：`actions/public/ticket.ts` 这个具体文件存在
//     ② 产物侧：编译 bundle 里同时出现 **资源名** 与 **create action** 两个标记
//   任一不满足 → 判定"未就绪"。
const READY_MARKER = getOpt('--ready-marker', 'publicTickets?');
const READY_ACTION_MARKER = getOpt('--ready-action-marker', 'create');
const REQUIRE_SOURCE = getOpt('--require-source', 'nocobase/plugins/service-ticket/src/server/actions/public/ticket.ts');
const SKIP_STATIC_GATE = hasFlag('--skip-static-gate');

const SOURCE_PATH = path.resolve(ROOT, REQUIRE_SOURCE);
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
  const ok = {};

  // ① 源码侧：创建工单的 action 源文件**具体存在**（不是"目录里有别的文件"）
  ok.source = fs.existsSync(SOURCE_PATH);
  if (!ok.source) {
    reasons.push(
      `源码侧：${REQUIRE_SOURCE} 不存在 —— 创建工单 action 尚未实现。` +
        `（仅"目录里存在非 health 的 .ts"不算就绪：Phase 3-A 只做 stores 时该条件就会成立）`,
    );
  }

  // ② 产物侧：bundle（去注释后）里**同时**出现资源名与 create action 标记
  const code = fs.existsSync(BUNDLE_PATH) ? stripComments(fs.readFileSync(BUNDLE_PATH, 'utf8')) : null;
  if (code === null) {
    reasons.push(`产物侧：${path.relative(ROOT, BUNDLE_PATH)} 不存在（先跑 node scripts/build-plugin.mjs）`);
    ok.resourceMarker = false;
    ok.actionMarker = false;
  } else {
    ok.resourceMarker = new RegExp(READY_MARKER, 'i').test(code);
    ok.actionMarker = new RegExp(READY_ACTION_MARKER, 'i').test(code);
    if (!ok.resourceMarker) {
      reasons.push(
        `产物侧：bundle 的**代码**（已去注释）中未出现资源标记 /${READY_MARKER}/i —— ` +
          `可能是改了源码但没跑 build-plugin.mjs，或只有注释示例`,
      );
    }
    if (!ok.actionMarker) {
      reasons.push(
        `产物侧：bundle 的**代码**（已去注释）中未出现 action 标记 /${READY_ACTION_MARKER}/i —— ` +
          `资源可能已注册但没有 create action`,
      );
    }
  }

  const gateOk = ok.source && ok.resourceMarker && ok.actionMarker;
  return { ok: gateOk, reasons, ok0: ok };
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
    ? `  ✅ 静态就绪门通过（源码 ${REQUIRE_SOURCE}；产物含 /${READY_MARKER}/i 与 /${READY_ACTION_MARKER}/i）`
    : `  ⚠️  已用 --skip-static-gate 跳过静态就绪门（将直接发 HTTP 探测，若路径不存在会给 svc-app 写 error 日志）`,
);

// ---------------------------------------------------------------------------
// 0.2 生成本轮独立测试数据（run_id）
// ---------------------------------------------------------------------------
/**
 * RUN_ID 形如 `20260920T204800-a3f1`（20 字符）。
 * 可用 `--run-id` 传入以复现某一轮（此时 nonce 由 run_id 决定，数据完全一致）。
 */
function makeRunId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${ts}-${randomBytes(2).toString('hex')}`;
}
const RUN_ID = getOpt('--run-id', makeRunId());

/**
 * 由 run_id 派生 6 位 nonce（100000–999999），作为本轮手机号段。
 * 用 sha256 而不是"解析 run_id 尾部的十六进制"：后者只有 4 位（65536 种），
 * 同一天跑几十轮就可能撞上；sha256 前缀映射到 90 万区间，撞车概率可以忽略，
 * 且仍然由 run_id 唯一决定（`--run-id` 复现时数据一致）。
 */
function nonceFromRunId(runId, salt = 0) {
  const h = createHash('sha256').update(`${runId}#${salt}`).digest('hex');
  return 100000 + (parseInt(h.slice(0, 12), 16) % 900000);
}

/**
 * 计算手机号的限流维度哈希（与 apiGuards 的约定一致：sha256(值 + SIGN_SECRET)）。
 * 用于回查"这个号是否已被历史运行用过"，避免撞上日频控。
 */
function mobileGuardHash(mobile) {
  const secret = envValue('SIGN_SECRET', '');
  return createHash('sha256').update(`${mobile}${secret}`).digest('hex');
}

/**
 * 生成 N 个互不相同、且**未被历史运行占用**的合规手机号。
 *
 * 格式：`13` + 6 位 nonce + 3 位序号（共 11 位）→ 满足 /^1[3-9]\d{9}$/。
 *
 * 占用检测查两处，缺一不可：
 *   · `service_tickets.customer_mobile` —— 上次运行真的建了单（明文列）
 *   · `api_guards`（scope=mobile）的哈希 —— 上次运行的计数行可能还在（按天窗口）
 * 只查前者会漏掉"上次被频控拦掉、没建单但有计数行"的情况。
 */
function buildMobiles(nonce, n) {
  const out = [];
  // 三个号段互不重叠（n ≤ 997）：
  //   …000 … n-1  压测的 N 个合法请求
  //   …998         探测请求（**必须独立**，见下面注释）
  //   …999         幂等专项
  //
  // ⚠️ 探测请求**不能**复用 `mobiles[0]`。早期写法就是这么写的，后果是：
  //    探测请求先用 `13{nonce}000` 在"同门店 + 同类型"下落了一张单，
  //    紧接着的并发批次里那个用同一手机号的请求会被**重复单规则**正确地拦成
  //    409 DUPLICATE_TICKET —— 于是断言 2/3/4（"恰好 100 张"）全部失败。
  //    频控与重复单都是**设计特性**，所以这 100% 是脚本的缺陷，不是产品缺陷。
  //    这类"脚本自己造出冲突，再把红灯算到产品头上"的假红灯最难查，
  //    因为它看起来完全像"并发下有请求被吃掉了"。
  const probe = `13${nonce}998`;
  const idem = `13${nonce}999`;
  for (let i = 0; i < n; i += 1) out.push(`13${nonce}${String(i).padStart(3, '0')}`);

  const re = /^1[3-9]\d{9}$/;
  for (const m of [...out, probe, idem]) {
    if (!re.test(m)) throw new Error(`生成的手机号不合法：${m}`);
  }
  if (new Set(out).size !== n) throw new Error('生成的手机号出现重复');
  if (out.includes(probe) || out.includes(idem) || probe === idem) {
    throw new Error(`探测/幂等专用号与压测号段重叠（n=${n}，三段必须互不相交）`);
  }
  return { mobiles: out, probeMobile: probe, idemMobile: idem };
}

/** 回查这批号是否已被占用（返回被占用的列表） */
function findTakenMobiles(list) {
  const inList = list.map((m) => `'${m}'`).join(',');
  const taken = new Set();

  for (const m of psqlRows(
    `SELECT customer_mobile FROM ${T.tickets} WHERE customer_mobile IN (${inList})`,
  )) {
    taken.add(m);
  }

  const hashes = list.map((m) => `'${mobileGuardHash(m)}'`).join(',');
  for (const h of psqlRows(`SELECT guard_key FROM ${T.guards} WHERE guard_key IN (${hashes})`)) {
    // 反查回手机号只为输出可读（哈希本身不还原，这里用一次线性匹配）
    const hit = list.find((m) => mobileGuardHash(m) === h);
    if (hit) taken.add(hit);
  }
  return [...taken];
}

let nonce = nonceFromRunId(RUN_ID);
let { mobiles, probeMobile, idemMobile } = buildMobiles(nonce, CONCURRENCY);
{
  const MAX_TRY = 5;
  for (let attempt = 1; attempt <= MAX_TRY; attempt += 1) {
    // 专用号（探测 / 幂等）也要一起做占用回查：它们同样会打 api_guards 的手机号桶
    const taken = findTakenMobiles([...mobiles, probeMobile, idemMobile]);
    if (taken.length === 0) break;
    if (attempt === MAX_TRY) {
      block(
        `连续 ${MAX_TRY} 次生成的手机号段都被历史数据占用（最后一批冲突 ${taken.length} 个：${taken.slice(0, 3).join(', ')}）。` +
          '请用 --run-id 指定一个不同的 run_id 重试。',
      );
      exitNotReady();
    }
    console.log(`     （nonce ${nonce} 与历史数据冲突 ${taken.length} 个，换段重试 ${attempt}/${MAX_TRY}）`);
    nonce = nonceFromRunId(RUN_ID, attempt);
    ({ mobiles, probeMobile, idemMobile } = buildMobiles(nonce, CONCURRENCY));
  }
}

/** 生成第 i 个压测请求体：手机号 / 内容 / 姓名全部带 RUN_ID，互不重复 */
function makePayload(i, mobile) {
  return {
    store_code: STORE_CODE,
    source: 'qr',
    ticket_type: 'repair',
    content: `[并发压测 run=${RUN_ID} #${i + 1}] 空调不制冷，出风有异味，需上门检查。`,
    customer_name: `测${RUN_ID}-${String(i + 1).padStart(3, '0')}`,
    customer_mobile: mobile,
    privacy_agreed: true,
  };
}

console.log(`  RUN_ID     ${RUN_ID}`);
console.log(`  手机号段   13${nonce}xxx（共 ${CONCURRENCY} 个，已确认未被历史运行占用）`);
console.log(`  探测专用号 ${probeMobile}（**独立于**压测号段，否则会被重复单规则正确拦成 409）`);
console.log(`  幂等专用号 ${idemMobile}`);
console.log(`  目标地址   ${BASE_URL}${PUBLIC_TICKET_PATH}`);
console.log(`  并发数     ${CONCURRENCY}`);
console.log(`  门店       ${STORE_CODE}`);
// ⚠️ 这里刻意不再宣称"IP 阈值是 .env 里的 30"—— 那是**错的**（见下面 §1 的预检）。
//    `seedSettings` 是"存在即跳过"：.env 只决定**首次**种进 service_settings 的值，
//    之后运行期一律以库里的行为准。改 .env + 重启**不会**改变生效阈值，
//    这曾让"按文档调高阈值却仍然 429"变成一个看起来像产品缺陷的假象。
console.log(
  `  IP 频控    .env 的 SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT=${IP_MINUTE_LIMIT_CONFIGURED}（仅首次种子）；` +
    '运行期真实阈值以本机预检为准',
);
console.log(`  手机频控   ${PHONE_DAILY_LIMIT} 次/天（每号 1 次，不受影响）`);

// ---------------------------------------------------------------------------
// 0.3 真实 POST 探测（仅在静态门通过后）
// ---------------------------------------------------------------------------
/** 接口是否已经存在（Phase 3 未完成时这里是 404/405） */
// 探测用**专用手机号**（…998），不复用 mobiles[0] —— 理由见 buildMobiles 的注释。
const probePayload = makePayload(0, probeMobile);
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

// 探测请求本身也是一张真实工单：它会消耗 1 个号。
// 为了让"序号连续"口径干净，不能先建单再删（脏操作），
// 所以改为：**基线在探测请求之后取**，后续 100 路压在基线之上连续推进。
const probeBody = probe.status < 400 ? unwrap(parseJson(probe.body, '探测请求')) : null;
const probeTicketNo = probeBody?.ticket_no ?? null;
if (probeTicketNo) console.log(`     （探测请求已建单 ${probeTicketNo}，计入基线）`);

// 断言 2 要求"恰好 100 张"：探测请求会多出 1 张。
// 口径处理：压测集合只统计**本次并发发出的 100 个 request_id** 的产物，
// 而不是"当天工单总数"——否则任何历史数据（冒烟脚本、手工点单、上一轮压测）都会让断言失真。
// 这样"不多不少"依然是硬断言，且与"当天总数"解耦。

// ============================================================================
// 1) IP 频控真实剩余额度预检（★ 不发压之前的硬门槛）
// ============================================================================
section('1 IP 频控剩余额度预检');

/**
 * 本次测试从**同一个 IP** 发出的请求数：
 *   1 探测 + CONCURRENCY 并发 + 2 幂等（首次 + 重放）
 * 幂等重放也计入 IP 限流（它仍是一次请求），故必须算进来。
 */
const REQUIRED_REQUESTS = 1 + CONCURRENCY + 2;

let quota = null;
let skipQuota = hasFlag('--skip-quota-precheck');

if (!skipQuota) {
  const q = await http(`${BASE_URL}${GUARD_QUOTA_PATH}?scene=public_ticket`, {
    timeout: 15000,
    headers: DIAG_KEY ? { 'X-Svc-Diag-Key': DIAG_KEY } : undefined,
  });

  if (q.status === 404 || q.status === 405 || q.status === 0) {
    block(
      `预检接口 ${GUARD_QUOTA_PATH} 不可用（${q.status === 0 ? q.error : `HTTP ${q.status}`}）。` +
        (q.status === 404
          ? '404 有**两种**根因，先排掉第一种再怀疑接口缺失：' +
            '① 请求没带（或带错了）`X-Svc-Diag-Key` —— 该接口要求它等于进程内的 SIGN_SECRET，' +
            '且 SIGN_SECRET 为空时服务端对一切请求 404（fail-closed）；本次' +
            (DIAG_KEY
              ? '已从 .env 读到 SIGN_SECRET 并带上请求头，若仍是 404，重点查 ② 。'
              : '**没有**从 .env 读到 SIGN_SECRET（或写成空值），请先补上或改用 --diag-key 传入。') +
            '② 接口确实不存在 —— 那说明 Phase 3 未到 I 步。'
          : '') +
        '本脚本要求**发压前**确知剩余额度，不允许"先发请求再用 429 事后判断"。' +
        '（排查时可加 --skip-quota-precheck 跳过，但此时 429 无法提前排除。）',
    );
    exitNotReady();
  }

  if (q.status >= 500) {
    block(`预检接口返回 ${q.status}：${q.body.slice(0, 200)}`);
    exitNotReady();
  }

  try {
    const data = unwrap(parseJson(q.body, '预检接口'));
    quota = {
      scene: data.scene,
      scope: data.scope,
      windowStart: data.window_start,
      windowSeconds: data.window_seconds,
      windowResetsInSeconds: data.window_resets_in_seconds,
      used: Number(data.used),
      limit: Number(data.limit),
      remaining: Number(data.remaining),
      ipKeyHash: data.ip_key_hash,
    };
    if (![quota.used, quota.limit, quota.remaining].every((v) => Number.isFinite(v))) {
      throw new Error(`字段缺失或非数字：${q.body.slice(0, 200)}`);
    }
  } catch (e) {
    block(`预检接口响应无法解析：${e.message}`);
    exitNotReady();
  }

  console.log(`  窗口         ${quota.windowStart}（${quota.windowSeconds}s，${quota.windowResetsInSeconds}s 后重置）`);
  console.log(`  本 IP 哈希   ${quota.ipKeyHash}（应用侧算得，脚本不复算）`);
  console.log(`  已用 / 阈值  ${quota.used} / ${quota.limit}`);
  console.log(`  剩余额度     ${quota.remaining}`);
  console.log(`  本次所需     ${REQUIRED_REQUESTS}（1 探测 + ${CONCURRENCY} 并发 + 2 幂等）`);
  console.log('');

  await check('IP 分钟窗口剩余额度足以覆盖本次测试', () => {
    assert(
      quota.remaining >= REQUIRED_REQUESTS,
      `剩余 ${quota.remaining} < 所需 ${REQUIRED_REQUESTS}（已用 ${quota.used} / 阈值 ${quota.limit}，` +
        `${quota.windowResetsInSeconds}s 后重置）。\n` +
        `       这不是代码缺陷：频控在正常工作。请择一处理：\n` +
        `         A) 等窗口重置（${quota.windowResetsInSeconds}s）后重跑；\n` +
        `         B) 验收环境临时放宽（**两层**都要改）：\n` +
        limitSteps(Math.max(quota.limit, REQUIRED_REQUESTS + 50), LIMIT_RESTORE_TO),
    );
    return `剩余 ${quota.remaining} ≥ 所需 ${REQUIRED_REQUESTS}`;
  });

  if (quota.remaining < REQUIRED_REQUESTS) {
    block(
      `IP 频控剩余额度不足（剩余 ${quota.remaining} < 所需 ${REQUIRED_REQUESTS}）。` +
        '本次不发任何压测请求 —— 频控是设计特性，不得为造绿灯而关闭它。',
    );
    exitNotReady();
  }

  if (quota.limit > LIMIT_RESTORE_TO) {
    warnings.push(
      `IP 阈值当前为 ${quota.limit}（高于生产默认 ${LIMIT_RESTORE_TO}）—— 属验收环境临时放宽，` +
        `测试结束后请**两层一起**恢复（只改 .env 无效，生效值在 service_settings 表里）。`,
    );
  }
} else {
  console.log('  ⚠️  已用 --skip-quota-precheck 跳过额度预检。');
  console.log('      无法提前排除 429；若出现 429 本次将以 ENV_NOT_READY 收场。');
  warnings.push('本次跳过了 IP 额度预检，无法提前排除 429 干扰。');
}

// 手机号频控：本脚本每个 request_id 用**独立手机号**（各 1 次），故不受 daily limit 影响。
// 但若 PHONE_DAILY_LIMIT < 1 则全部会被拦，因此显式检查一下。
await check('手机号频控不会吃掉本次请求（每号 1 次）', () => {
  assert(PHONE_DAILY_LIMIT >= 1, `SVC_DEFAULT_SECURITY_TICKET_PHONE_DAILY_LIMIT=${PHONE_DAILY_LIMIT}，每号 1 次也会被拦`);
  return `每号 1 次 ≤ ${PHONE_DAILY_LIMIT}/天；共需 ${CONCURRENCY + 1} 个独立手机号`;
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
  `SELECT current_value FROM ${T.sequences} WHERE seq_key = '${SEQ_KEY}'`,
) || 0);

const eventsBefore = Number(psqlScalar(`SELECT count(*) FROM ${T.events}`) || 0);
const idemBefore = Number(psqlScalar(`SELECT count(*) FROM ${T.idem}`) || 0);

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
    `${rate429} 路被 IP 频控拦截（HTTP 429，阈值 ${quota ? quota.limit : '未知'}/分钟）。` +
      '频控是设计特性，**不得拆掉它来造绿灯**。请先确认是哪一层拦的（应用层与 nginx 层都返回 429）：' +
      '应用层看 `docker logs svc-app | grep 429`，nginx 层看 `docker logs svc-nginx`。\n' +
      '       临时放宽（两层一起，只改 .env 无效）：\n' +
      limitSteps(REQUIRED_REQUESTS + 50, LIMIT_RESTORE_TO),
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

  const seqAfter = Number(psqlScalar(`SELECT current_value FROM ${T.sequences} WHERE seq_key = '${SEQ_KEY}'`) || 0);
  assertEq(seqAfter - seqBefore, CONCURRENCY, `${T.sequences}(${SEQ_KEY}) 增量`);
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
      `FROM ${T.tickets} t ` +
      `LEFT JOIN ${T.events} a ON a.ticket_id = t.id AND a.event_type = 'created' ` +
      // ⚠️ 必须 `GROUP BY t.ticket_no`，**不能**写 `GROUP BY 1`：
      //    PG 的序号 GROUP BY 解析的是"第 1 个选择项表达式"，
      //    而第 1 项里含 count(a.id) —— 于是报
      //    "aggregate functions are not allowed in GROUP BY"。
      //    这个错只有在断言真正跑到底时才出现（早期每次都在额度预检就 exit 2），
      //    所以它躲过了语法自检，属于"第一次真跑才会暴露"的脚本缺陷。
      `WHERE t.ticket_no IN (${nos}) GROUP BY t.ticket_no`,
  );
  assertEq(rows.length, CONCURRENCY, '查到的工单行数');
  const bad = rows.filter((r) => Number(r.split('|')[1]) !== 1);
  assert(bad.length === 0, `${bad.length} 张工单的 created 事件数不为 1（前 5 条）：${bad.slice(0, 5).join(', ')}`);
  const totalAfter = Number(psqlScalar(`SELECT count(*) FROM ${T.events}`) || 0);
  return `每张恰好 1 条 created；${T.events} 总行数 ${eventsBefore}→${totalAfter}`;
});

// ============================================================================
// 5) 断言 7 ~ 8：幂等
// ============================================================================
section('5 断言 7–8：request_id 幂等');

// 幂等验证用**独立**的 request_id 与手机号（`13{nonce}999`）：
// 与压测的 100 个都不重叠，否则会先被"同号同店同类型"重复单规则拦掉，测的就不是幂等了。
// 手机号每轮独立（同 run_id nonce），因此重复运行不会撞上历史计数。
const idemRequestId = randomUUID();
const idemBody = JSON.stringify({
  store_code: STORE_CODE,
  source: 'qr',
  ticket_type: 'repair',
  content: `[幂等验证 run=${RUN_ID}] 同一 request_id 重放，不得产生新工单。`,
  customer_name: `幂等-${RUN_ID}`,
  customer_mobile: idemMobile,
  privacy_agreed: true,
});
const idemHeaders = { 'Content-Type': 'application/json', 'X-Request-Id': idemRequestId };

const idemFirst = await http(`${BASE_URL}${PUBLIC_TICKET_PATH}`, {
  method: 'POST', headers: idemHeaders, body: idemBody, timeout: 20000,
});
const seqAfterFirst = Number(psqlScalar(`SELECT current_value FROM ${T.sequences} WHERE seq_key = '${SEQ_KEY}'`) || 0);
const ticketsAfterFirst = Number(psqlScalar(`SELECT count(*) FROM ${T.tickets} WHERE ticket_no LIKE '${TICKET_PREFIX}%'`) || 0);

const idemSecond = await http(`${BASE_URL}${PUBLIC_TICKET_PATH}`, {
  method: 'POST', headers: idemHeaders, body: idemBody, timeout: 20000,
});
const seqAfterSecond = Number(psqlScalar(`SELECT current_value FROM ${T.sequences} WHERE seq_key = '${SEQ_KEY}'`) || 0);
const ticketsAfterSecond = Number(psqlScalar(`SELECT count(*) FROM ${T.tickets} WHERE ticket_no LIKE '${TICKET_PREFIX}%'`) || 0);

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
  assertEq(seqAfterSecond - seqAfterFirst, 0, `重放后 ${T.sequences}(${SEQ_KEY}) 的增量`);
  return `重放前后 current_value 均为 ${seqAfterSecond}（第 1 次建单 ${idemNo1}）`;
});

await check('断言 8 · 幂等不产生新单号（返回首个工单号，且总数不变）', () => {
  assert(idemFirst.status < 400 && idemSecond.status < 400, '幂等验证请求未成功');
  assert(idemNo1, '第 1 次未返回 ticket_no');
  assertEq(idemNo2, idemNo1, '第 2 次返回的 ticket_no（应与第 1 次相同）');
  assertEq(ticketsAfterSecond, ticketsAfterFirst, `当天工单数（${TICKET_PREFIX}*）`);
  // 幂等记录只有 1 条（scene=public_ticket, key=request_id）
  const recCount = Number(psqlScalar(
    `SELECT count(*) FROM ${T.idem} WHERE idempotency_key = '${idemRequestId}'`,
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
    psql(`DELETE FROM ${T.events} WHERE ticket_id IN (SELECT id FROM ${T.tickets} WHERE ticket_no IN (${list}))`);
    psql(`DELETE FROM ${T.tickets} WHERE ticket_no IN (${list})`);
    const ridList = [...requestIds, idemRequestId].map((r) => `'${r}'`).join(',');
    psql(`DELETE FROM ${T.idem} WHERE idempotency_key IN (${ridList})`);
    console.log('  ✅ 已清理（注意：daily_sequences 的 current_value **不回收** ——');
    console.log('     号码一旦发出就作废，这是 SequenceService 的刻意设计，见 sequence-service.ts 顶部注释）');
  }
}

// ============================================================================
// 7) 结尾提醒：恢复生产阈值
// ============================================================================
if (quota && quota.limit > LIMIT_RESTORE_TO) {
  section('7 ⚠️ 收尾：恢复 IP 频控生产阈值');
  console.log(`  当前阈值 ${quota.limit} 是**验收环境临时放宽**的值，不属于生产配置。`);
  console.log('  ⚠️ 只改 .env 是无效的（.env 仅决定首次种子，生效值在 service_settings 表里）。');
  console.log('  请**两层一起**恢复：');
  console.log(
    `    A) 应用层：docker exec svc-postgres psql -U svc_app -d service_ticket -c \\\n` +
      `         "UPDATE service_settings SET value='${LIMIT_RESTORE_TO}', updated_at=now() WHERE key='security.ip_minute_limit'"`,
  );
  console.log(
    '    B) nginx ：svc_public rate 改回 30r/m、/api/public/ burst 改回 10、' +
      'limit_conn svc_conn 改回 96，然后 docker exec svc-nginx nginx -s reload',
  );
  console.log('  否则线上将长期处于"限流形同虚设"的状态。');
}

// ============================================================================
// 汇总
// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');

/**
 * 判定优先级：**blocked 先于 failures**。
 *
 * 理由：一旦出现 429 频控拦截或额度不足，断言 2（"恰好 100 张"）必然失败，
 * 但它反映的是"环境没配成能跑 100 路"，不是"取号有 bug"。如果把这种失败当红灯报出去，
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

console.log(`  ✅ Phase 2 挂起项解除：${passed} 项断言全绿（${CONCURRENCY} 路真实并发取号）`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('  8 条契约全部满足，可据此在 docs/PHASE-2.md §7 把整改项 2 标记为完成，');
console.log('  并把 Phase 2 状态由 HOLD **补签为 PASS**（同时更新 README / CHANGELOG / DEV-PLAN）。');
console.log('');
console.log(`  RUN_ID：${RUN_ID}`);
console.log(`  证据摘要：${CONCURRENCY} 路并发耗时 ${elapsed}ms；`);
console.log(`            ticket_no ${created[0]?.ticketNo ?? '-'} … ${created[created.length - 1]?.ticketNo ?? '-'}；`);
console.log(`            ${T.sequences}(${SEQ_KEY}) ${seqBefore} → ${seqAfterSecond}；`);
console.log(`            ${T.events} ${eventsBefore} → ${Number(psqlScalar(`SELECT count(*) FROM ${T.events}`) || 0)}。`);
if (quota) {
  console.log(`            IP 额度：已用 ${quota.used}/${quota.limit}（预检时）`);
}
console.log('');
process.exit(0);
