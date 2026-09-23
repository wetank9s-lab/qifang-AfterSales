#!/usr/bin/env node
/**
 * verify-reassign-contract.mjs —— 改派 `reason` 契约的**端到端**验收
 * =============================================================================
 *
 * 为什么单独有它（Phase 4-I 第二轮真人走查的 P0 缺陷）：
 *
 *   真人在页面上**填写了"改派原因"**，服务端却回 `MISSING_REASON`。
 *   根因不在服务端，也不在 ACL，而在**客户端载荷的白名单**：
 *
 *     UI 表单字段名       `reason`                     ✅ 收集到了
 *     antd 必填校验       `reason`                     ✅ 拦住了空值
 *     client payload      `buildDispatchPayload` 只遍历
 *                         `DISPATCH_FORM_FIELDS`（**不含 reason**）  ❌ 静默丢弃
 *     /api/svc:reassign   —— 没有 reason               ❌
 *     dispatchInputOf()   读出 '' → 422 MISSING_REASON ✅ 服务端正确
 *
 *   教训：**「表单里有这个字段」≠「payload 里有这个字段」**。
 *   只要载荷是按白名单挑字段构造的，新增字段就必须**同时进白名单**，
 *   否则它会被无声吞掉 —— UI 上表现为"填了没用"，服务端表现为"缺参数"，
 *   **两边都不报错**。所以这类缺陷必须由"**真的打一次接口**"的断言盯住。
 *
 * -----------------------------------------------------------------------------
 * 断言清单（对应复核方 2026-09-23 的五条要求）
 * -----------------------------------------------------------------------------
 *   A1【静态】UI reason 非空 ⇒ `buildReassignPayload` 的载荷**含**正确 reason
 *   A2【静态】reason 为空 ⇒ 客户端两道都拦：`missingReassignFields` 点名 +
 *             载荷构造器**丢掉**该字段（于是"空 reason 的请求不可能正常提交"）
 *   A2b【静态·结构守卫】`buildDispatchPayload` **不得**含 reason
 *             —— 这条是专门盯着本缺陷的形状：派工与改派各有自己的白名单。
 *   A3【联机】绕过客户端、直接缺 reason 请求服务端 ⇒ 仍 422 `MISSING_REASON`
 *             （证明"修复方式不是把服务端校验放宽"）
 *   A4【联机】用**与 UI 完全一致**的载荷 + X-Request-Id 真打一次 reassign ⇒ 200，
 *             且 Visit #1=SUPERSEDED / Visit #2=ASSIGNED / Visit 数=2
 *   A5【联机】成功后 `ticketEvents` 里**保留改派原因**（metadata.reason + summary）
 *   A6【联机·P1 证据】「预计上门日期」规范化：UI 传 `YYYY-MM-DD` ⇒ 落库为当天
 *             12:00（统一固定时刻），且该时分**不出现在任何面向用户的文案里**
 *   A7【联机·H3 数据源】`svc:visits`（详情抽屉的 Visit 来源）：严格按 `ticket_id`
 *             服务端查询、**不含**任何凭据列、但**保留** `token_revoked_reason`，
 *             且被改派作废的历史 Visit 仍读得到。
 *             ⚠️ 这条原本只在 `smoke-test` 里、且因洁净基线（Visit=0）而**被跳过** ——
 *             挂到这里是因为**本脚本自带 Visit 夹具**，判据不再依赖"库里碰巧有数据"。
 *
 * 反向验证（`--reverse`，铁律 8"断言不会变红 = 没有断言"）：
 *   用**修复前**的构造器（`buildDispatchPayload`，即丢掉 reason）去打同一个接口，
 *   断言必须变红（422 MISSING_REASON）**且 Visit 数不变**（没有半途写入）。
 *   这证明 A3/A4 这两条判据真的会红，而不是恒绿。
 *
 * -----------------------------------------------------------------------------
 * 环境与副作用
 * -----------------------------------------------------------------------------
 *   · 需要 .env 的 `UAT_STORE_A_PASSWORD`（门店 A 账号，与真人走查同一身份）
 *   · 会**自建一张一次性工单**（匿名接口提交，客户名 = 虚构的"P0契约验收"），
 *     跑完在 finally 里**按自己的 ticket id 精确删除**，可独立重复运行
 *   · 任何情况下都**不会**碰走查用的 35 / 886 / 1039 / 1040
 *
 * 用法：
 *   node scripts/verify-reassign-contract.mjs            # 常规
 *   node scripts/verify-reassign-contract.mjs --reverse  # 反向验证（判据必须变红）
 *   node scripts/verify-reassign-contract.mjs --static-only  # 只跑离线部分（不需要环境）
 *
 * 退出码：0 全绿 / 1 失败 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN_SRC = path.join(ROOT, 'nocobase/plugins/service-ticket/src');
const SHARED_DIR = path.join(PLUGIN_SRC, 'shared');
const TMP = path.join(ROOT, '.tmp-verify');
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

const argv = process.argv.slice(2);
const REVERSE = argv.includes('--reverse');
const STATIC_ONLY = argv.includes('--static-only');

function envValue(key, fallback = '') {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return fallback;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1].trim() : fallback;
}

const PORT = envValue('NGINX_HTTP_PORT', '8080');
const BASE_URL = `http://localhost:${PORT}`;
/** 与 uat-preflight.mjs / uat-accounts.mjs 同一约定：邮箱固定，口令在 .env */
const STORE_EMAIL = 'uat.store.a@svc.local';

// ---------------------------------------------------------------------------
// 断言框架（与 verify-client-logic / verify-ticket-actions 同风格）
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  ❌ ${name} — ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  ❌ ${name} — ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}：实际 ${a}，期望 ${e}`);
}

// ---------------------------------------------------------------------------
// 编译前后端共享契约（与 verify-client-logic 同一套 esbuild 兜底顺序）
// ---------------------------------------------------------------------------
function loadEsbuild() {
  const nodeRequire = createRequire(import.meta.url);
  const candidates = [
    () => nodeRequire('esbuild'),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild')),
    () => nodeRequire(path.join(NODE_WORKSPACE, 'node_modules', 'esbuild', 'lib', 'main.js')),
  ];
  for (const load of candidates) {
    try {
      return load();
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

async function compileSharedContract(esbuild) {
  fs.mkdirSync(TMP, { recursive: true });
  const outfile = path.join(TMP, 'reassign-contract.cjs');
  const entry = path.join(TMP, 'reassign-contract-entry.ts');
  const reexport = (mod) =>
    `export * from '${path.join(SHARED_DIR, mod).replace(/\\/g, '/')}';`;
  fs.writeFileSync(
    entry,
    [reexport('service-mode'), reexport('svc-request')].join('\n'),
    'utf8',
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    logLevel: 'warning',
  });
  return import(`file://${outfile}`);
}

// ---------------------------------------------------------------------------
// 联机工具
// ---------------------------------------------------------------------------
function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

function psqlExec(sql) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function http(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 交给调用方断言 */
  }
  return { status: res.status, json, body: text };
}

async function signIn(email, password) {
  const r = await http(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (r.status !== 200) return null;
  return r.json?.data?.token ?? null;
}

/** POST 一个 svc 动作。**请求号由调用方给**，便于证明"一次逻辑操作一个号"。 */
async function svcPost(action, ticketId, token, body, requestId) {
  const url = `${BASE_URL}/api/svc:${action}?filterByTk=${ticketId}`;
  return http(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function svcGet(action, ticketId, token) {
  return http(`${BASE_URL}/api/svc:${action}?filterByTk=${ticketId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

const errorCodeOf = (r) => r?.json?.errors?.[0]?.code;
const errorMessageOf = (r) => r?.json?.errors?.[0]?.message ?? String(r?.body ?? '').slice(0, 160);

/**
 * 「环境未就绪」哨兵（退出码 2）。
 *
 * ⚠️⚠️ 为什么不能在这些分支里直接 `process.exit(2)`：
 *   `process.exit()` 会**立刻终止进程**，`finally` **不会执行** ——
 *   于是"建单成功、但随后环境有问题"的路径会把一次性工单**留在库里**。
 *   实测踩过：一次 exit(2) 之后库里多了一张 NEW 工单（id=1528），
 *   而走查基线要求"每店只有一张 UAT 单"。
 *   ⇒ 凡是"已经产生了副作用之后的失败路径"，都必须走异常回到 `finally`。
 *   （这条与工程铁律 5"测试工具会污染环境"是同一件事。）
 */
class EnvNotReady extends Error {}

/** 本地日期 YYYY-MM-DD（**按本地时区**，与 UI 的 <input type="date"> 同口径） */
function localDateOnly(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// 静态断言
// ---------------------------------------------------------------------------
console.log(`\n═══ 改派 reason 契约验收${REVERSE ? '（反向验证）' : ''} ═══\n`);

const esbuild = loadEsbuild();
if (!esbuild) {
  console.log('  ❌ 环境未就绪：找不到 esbuild（无法编译共享契约）');
  process.exit(2);
}
const contract = await compileSharedContract(esbuild);
const {
  buildDispatchPayload,
  buildReassignPayload,
  buildReschedulePayload,
  missingReassignFields,
  missingDispatchFields,
} = contract;

/**
 * **与 UI 完全一致的取值**（`ticket-actions.tsx` 的 antd 表单产出）。
 *
 * ⚠️ 关键点：`expected_visit_at` 的形态就是 `<input type="date">` 的 `YYYY-MM-DD`
 *    —— 不是 ISO datetime。若断言的输入比真实 UI"更规范"，
 *    就等于在测一个用户不会产生的请求。
 */
const APPOINTMENT_DAY = localDateOnly(1);
const REASON_TEXT = '临时有其他急单，改派给李师傅（契约验收）';
const UI_VALUES = {
  technician_name: '李师傅',
  technician_mobile: '13900020002',
  expected_visit_at: APPOINTMENT_DAY,
  service_mode: 'manufacturer',
  provider_name: '契约验收厂家',
  reason: REASON_TEXT,
};

console.log('── A1/A2 静态契约（离线，不需要环境）──');

check('A1 UI reason 非空 ⇒ 载荷含**正确字段名**的 reason', () => {
  const payload = buildReassignPayload(UI_VALUES);
  assert('reason' in payload, `载荷里没有 reason：${JSON.stringify(Object.keys(payload))}`);
  eq(payload.reason, REASON_TEXT, 'reason 内容');
  // 同时必须把派工字段一个不少地带出去（修复不能以"丢别的字段"为代价）
  for (const key of ['technician_name', 'technician_mobile', 'expected_visit_at', 'service_mode']) {
    assert(key in payload, `载荷缺 ${key}`);
  }
  return `字段 = ${Object.keys(payload).join(',')}`;
});

check('A2 reason 为空 ⇒ 必填复核点名 + 载荷不含该字段（客户端两道都拦）', () => {
  const empty = { ...UI_VALUES, reason: '   ' };
  const missing = missingReassignFields(empty);
  assert(missing.includes('reason'), `必填复核未点名 reason（返回 ${JSON.stringify(missing)}）`);
  const payload = buildReassignPayload(empty);
  assert(!('reason' in payload), '空 reason 竟然进了载荷 —— 会被服务端判成"填了空原因"');
  return `missing=${missing.join(',')} · 载荷 keys=${Object.keys(payload).length}`;
});

check('A2b 结构守卫：派工与改派**各有**白名单（reason 只能进改派）', () => {
  // ⚠️ 这一条专门盯本缺陷的形状。
  //    若有人图省事把 REASSIGN_FORM_FIELDS 改回 DISPATCH_FORM_FIELDS，
  //    或把两个构造器合并，这里立刻变红。
  const dispatch = buildDispatchPayload(UI_VALUES);
  assert(
    !('reason' in dispatch),
    'buildDispatchPayload 里出现了 reason —— 说明两个白名单被合并，缺陷会复发',
  );
  const reassign = buildReassignPayload(UI_VALUES);
  assert('reason' in reassign, 'buildReassignPayload 里没有 reason');
  const reschedule = buildReschedulePayload({ expected_visit_at: APPOINTMENT_DAY, reason: '客户要求改期' });
  eq(Object.keys(reschedule).sort(), ['expected_visit_at', 'reason'], '改约载荷字段');
  return '派工 5 字段 / 改派 6 字段 / 改约 2 字段，互不污染';
});

check('A6a 日期规范化：UI 的 YYYY-MM-DD ⇒ 当天 12:00（统一固定时刻）', () => {
  const payload = buildReassignPayload(UI_VALUES);
  eq(payload.expected_visit_at, `${APPOINTMENT_DAY}T12:00:00+08:00`, '规范化后的预计上门值');
  // 已经带时分的输入也必须归一到同一个值（"同一天"永远落到同一时刻）
  const withTime = buildReassignPayload({ ...UI_VALUES, expected_visit_at: `${APPOINTMENT_DAY}T09:37:00+08:00` });
  eq(withTime.expected_visit_at, `${APPOINTMENT_DAY}T12:00:00+08:00`, '带时分输入归一化');
  return `${APPOINTMENT_DAY} → 12:00:00+08:00（固定时刻，非真实承诺）`;
});

if (STATIC_ONLY) {
  console.log('\n  （--static-only：跳过联机部分）');
  console.log(
    `\n  静态结果：${failures.length ? `❌ ${failures.length} 项失败` : `✅ 全部通过：${passed} 项`}\n`,
  );
  process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// 联机断言
// ---------------------------------------------------------------------------
const storePassword = envValue('UAT_STORE_A_PASSWORD');
if (!storePassword) {
  console.log('\n  ❌ 环境未就绪：.env 缺 UAT_STORE_A_PASSWORD —— 先跑 node scripts/uat-accounts.mjs --create');
  process.exit(2);
}

let scratchTicketId = 0;
/** 「环境未就绪」的说明文案 —— 在 finally 之后统一 exit(2)，保证清理一定执行 */
let envFailure = '';
const cleanup = () => {
  if (!scratchTicketId) return;
  // 只按**自己的** id 精确删除，绝不使用范围条件（不碰走查工单）
  psqlExec(
    [
      `DELETE FROM idempotency_records WHERE resource_id = ${scratchTicketId};`,
      `DELETE FROM sms_logs WHERE ticket_id = ${scratchTicketId};`,
      `DELETE FROM ticket_events WHERE ticket_id = ${scratchTicketId};`,
      `DELETE FROM service_visits WHERE ticket_id = ${scratchTicketId};`,
      `DELETE FROM service_tickets WHERE id = ${scratchTicketId};`,
    ].join(' '),
  );
};

console.log('\n── A3/A4/A5 联机契约（真打接口）──');

try {
  const token = await signIn(STORE_EMAIL, storePassword);
  if (!token) {
    throw new EnvNotReady(`门店账号 ${STORE_EMAIL} 登录失败（口令可能已轮换）`);
  }

  // ---- 建一张一次性工单（匿名接口，真实入口）----
  const mobile = `137${String(Date.now()).slice(-8)}`;
  const created = await http(`${BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({
      store_code: 'S01',
      ticket_type: 'repair',
      content: '[P0CONTRACT] 改派 reason 契约验收专用（脚本自建，跑完自删）',
      customer_name: 'P0契约验收',
      customer_mobile: mobile,
      privacy_agreed: true,
    }),
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new EnvNotReady(
      `匿名建单失败 HTTP ${created.status} ${String(created.body).slice(0, 160)}`,
    );
  }
  // ⚠️ 匿名接口**刻意不回工单 id**（最小披露）：只回 ticket_no / 门店名 / 时间。
  //    所以这里按 ticket_no 反查 id —— 不要为了测试方便去改接口回 id。
  const ticketNo = String(created.json?.data?.ticket_no ?? '');
  if (!ticketNo) {
    throw new EnvNotReady(`匿名建单未返回 ticket_no（${String(created.body).slice(0, 160)}）`);
  }
  scratchTicketId = Number(
    psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${ticketNo}'`),
  );
  if (!scratchTicketId) {
    throw new EnvNotReady(`按 ticket_no=${ticketNo} 反查不到工单 id`);
  }
  console.log(`  · 一次性工单 ${ticketNo}（id=${scratchTicketId}，跑完自删）`);

  // ---- 受理 + 首次派工（**走共享契约的载荷构造器**，与 UI 同一条路径）----
  const acceptRes = await svcPost('accept', scratchTicketId, token, {}, crypto.randomUUID());
  assert(acceptRes.status === 200, `受理失败 HTTP ${acceptRes.status} ${errorMessageOf(acceptRes)}`);

  const dispatchRes = await svcPost(
    'dispatch',
    scratchTicketId,
    token,
    buildDispatchPayload({
      technician_name: '王师傅',
      technician_mobile: '13900010001',
      expected_visit_at: localDateOnly(1),
      service_mode: 'manufacturer',
      provider_name: '契约验收厂家',
    }),
    crypto.randomUUID(),
  );
  assert(
    dispatchRes.status === 200,
    `首次派工失败 HTTP ${dispatchRes.status} ${errorMessageOf(dispatchRes)}`,
  );

  const visitsAfterDispatch = Number(
    psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id = ${scratchTicketId}`),
  );
  assert(visitsAfterDispatch === 1, `派工后 Visit 数应为 1，实际 ${visitsAfterDispatch}`);

  // ---- A3：绕过客户端，直接缺 reason ----
  await checkAsync('A3 绕过客户端直接缺 reason ⇒ 服务端仍 422 MISSING_REASON', async () => {
    const res = await svcPost(
      'reassign',
      scratchTicketId,
      token,
      buildDispatchPayload(UI_VALUES), // ⚠️ 故意用**不含 reason** 的派工载荷
      crypto.randomUUID(),
    );
    assert(res.status === 422, `期望 422，实际 ${res.status} ${errorMessageOf(res)}`);
    eq(errorCodeOf(res), 'MISSING_REASON', '错误码');
    const visits = Number(
      psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id = ${scratchTicketId}`),
    );
    assert(visits === 1, `被拒的请求不应产生 Visit，实际 ${visits}`);
    return `HTTP 422 · ${errorCodeOf(res)} · Visit 数未变`;
  });

  // ---- A4 / A5 / A6：与 UI 一致的载荷，真打一次 ----
  let reassignOk = false;
  await checkAsync(
    REVERSE
      ? 'R1【反向】用修复前的载荷（丢 reason）打真实 reassign ⇒ 判据必须变红且无副作用'
      : 'A4 与 UI 完全一致的载荷 + X-Request-Id ⇒ 200，Visit #1 SUPERSEDED / #2 ASSIGNED',
    async () => {
      const reqId = crypto.randomUUID();
      // ⚠️ 反向验证时**故意退回修复前的行为**（用派工构造器 = 丢掉 reason），
      //    期望服务端拒绝 —— 若这里返回 200，说明断言恒绿、根本没有防守。
      const payload = REVERSE ? buildDispatchPayload(UI_VALUES) : buildReassignPayload(UI_VALUES);
      const res = await svcPost('reassign', scratchTicketId, token, payload, reqId);

      if (REVERSE) {
        assert(
          res.status === 422 && errorCodeOf(res) === 'MISSING_REASON',
          `反向验证失败：期望 422 MISSING_REASON，实际 ${res.status} ${errorMessageOf(res)}`,
        );
        // ⚠️ 被拒的请求**不许留下任何副作用**：Visit 数必须还是派工后的 1 条。
        //    （反向验证最容易写成"只看状态码"，那样即使服务端半途插入了一行脏数据也发现不了）
        const visits = Number(
          psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id = ${scratchTicketId}`),
        );
        assert(visits === visitsAfterDispatch, `反向请求留下了副作用：Visit ${visitsAfterDispatch} → ${visits}`);
        return '判据确实会红（422 MISSING_REASON）且无副作用 —— 断言不是恒绿';
      }

      assert(res.status === 200, `改派失败 HTTP ${res.status} ${errorMessageOf(res)}`);
      reassignOk = true;

      const rows = psqlScalar(
        `SELECT visit_no||':'||visit_status FROM service_visits WHERE ticket_id = ${scratchTicketId} ORDER BY visit_no`,
      );
      const parts = rows.split('\n');
      eq(parts.length, 2, 'Visit 数');
      eq(parts[0], '1:SUPERSEDED', 'Visit #1 状态');
      eq(parts[1], '2:ASSIGNED', 'Visit #2 状态');
      return `Visit #1=SUPERSEDED · #2=ASSIGNED · 请求号 ${reqId.slice(0, 8)}…`;
    },
  );

  if (!REVERSE) {
    await checkAsync('A5 成功后 ticketEvents 保留改派原因（metadata.reason + summary）', async () => {
      assert(reassignOk, '上一步改派未成功，无法核对事件');
      const timeline = await svcGet('timeline', scratchTicketId, token);
      assert(timeline.status === 200, `时间线 HTTP ${timeline.status}`);
      const events = timeline.json?.data?.events ?? [];
      const ev = events.find((e) => e.event_type === 'reassigned');
      assert(ev, `时间线里没有 reassigned 事件：${events.map((e) => e.event_type).join(',')}`);
      const meta = ev.metadata_json ?? {};
      eq(meta.reason, REASON_TEXT, '事件 metadata.reason');
      assert(
        String(ev.summary ?? '').includes(REASON_TEXT),
        `事件 summary 里没有原因：${ev.summary}`,
      );
      // 顺手确认文案是"谁 → 谁"而不是"第 N 次"（详情抽屉的时间线直接用它）
      assert(
        String(ev.summary).includes('→') && !String(ev.summary).includes('第 '),
        `事件文案不符合"谁 → 谁"口径：${ev.summary}`,
      );
      return String(ev.summary).slice(0, 60);
    });

    await checkAsync('A6b 日期规范化真的落库（当天 12:00），且事件里只到天', async () => {
      const stored = psqlScalar(
        `SELECT to_char(expected_visit_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') ` +
          `FROM service_visits WHERE ticket_id = ${scratchTicketId} AND visit_no = 2`,
      );
      eq(stored, `${APPOINTMENT_DAY} 12:00`, 'Visit #2 的预计上门（经统一规范化）');

      // ⚠️ 反向纪律：那个 12:00 是**规范化产物**，绝不能出现在面向用户的文案里。
      //    只要它出现在 summary / 短信正文，就会被读成"师傅中午到"。
      const leaks = psqlScalar(
        `SELECT count(*) FROM ticket_events WHERE ticket_id = ${scratchTicketId} ` +
          `AND summary LIKE '%12:00%'`,
      );
      eq(Number(leaks), 0, '把固定时分写进事件文案的条数');
      return `落库 ${stored} · 事件文案 0 处泄露时分`;
    });

    check('A6c 短信模板拿到的上门值必须经过"只到天"的格式化（源码口径）', () => {
      // ⚠️ 为什么用源码断言：短信正文**刻意不入库**（sms_logs 只存状态与脱敏收件人，
      //    不存正文 —— 正文里可能带评价 Token）。所以无法从库里核对文案，
      //    只能盯住"模板入参是怎么来的"这个**唯一入口**：
      //    所有 `expected:`（发给短信模板的预计上门字段）都必须经过 formatVisitDate()。
      //
      // ⚠️ 第一版写宽了：`^expected\s*:` 会命中**函数形参的类型标注**
      //    （`private async throwStateConflict(id, expected: string[], action)`），
      //    于是报出一处假红。判据要区分"属性赋值"与"类型标注" ——
      //    这正是铁律 2"会误报的检查比没检查更糟"说的那种情况。
      const TYPE_ONLY = /^expected\s*:\s*(string|number|Date|unknown|any)\b/;
      const src = fs.readFileSync(
        path.join(PLUGIN_SRC, 'server/services/ticket-service.ts'),
        'utf8',
      );
      const sites = src
        .split('\n')
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter((x) => /^expected\s*:/.test(x.line))
        .filter((x) => !TYPE_ONLY.test(x.line)); // 排除类型标注，只看真正的取值
      // 目前实有 2 处「把上门日期喂给短信模板」的取值点
      // （改派时通知被换下的师傅、取消时通知师傅）。要求 ≥2 是为了让
      // "断言读到 0 处"这种**最坏的假绿**当场变红（铁律 10：遍历断言必须显式断言 checked > 0）。
      assert(
        sites.length >= 2,
        `短信模板的 expected 取值点只有 ${sites.length} 处（至少 2）—— 断言可能已失效`,
      );
      const bad = sites.filter((x) => !x.line.includes('formatVisitDate('));
      assert(
        bad.length === 0,
        `有 ${bad.length} 处 expected 未经过 formatVisitDate：${bad.map((x) => `L${x.no}`).join(',')}`,
      );
      return `${sites.length} 处 expected 全部只到天`;
    });

    await checkAsync('A6d 服务端入口兜底：直接传带时分的值 ⇒ 仍归一到 12:00', async () => {
      // ⚠️ 这条盯的是"**不只客户端**在规范化"。
      //    服务端会被 curl / 脚本 / 旧产物直接调用，若只在客户端规范化，
      //    "同一天"就会因入口不同落成两个时刻（12:00 与 09:37），
      //    而那个时分毫无业务含义（项目不采集到达时间）。
      const weirdDay = localDateOnly(3);
      const res = await svcPost(
        'reschedule',
        scratchTicketId,
        token,
        { expected_visit_at: `${weirdDay}T09:37:00+08:00`, reason: '契约验收：故意带时分' },
        crypto.randomUUID(),
      );
      assert(res.status === 200, `改约失败 HTTP ${res.status} ${errorMessageOf(res)}`);
      const stored = psqlScalar(
        `SELECT to_char(expected_visit_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') ` +
          `FROM service_visits WHERE ticket_id = ${scratchTicketId} AND visit_no = 2`,
      );
      eq(stored, `${weirdDay} 12:00`, '带时分输入经服务端规范化后的落库值');
      // 改约**不新建 Visit**：数量必须仍是 2（这是改约与改派的分界）
      const visits = Number(
        psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id = ${scratchTicketId}`),
      );
      eq(visits, 2, '改约后的 Visit 数');
      return `09:37 → 落库 ${stored} · Visit 数仍为 2`;
    });

    await checkAsync(
      'A7 H3 抽屉的 Visit 数据源：按 ticket_id 服务端查 + 不带凭据列 + 保留失效原因',
      async () => {
        // ⚠️ 这条**为什么挂在这个脚本上，而不是留给 smoke-test**：
        //    smoke 里有一条同主题断言，但它需要"库里恰好有一条 Visit"才成立；
        //    而走查洁净基线把 Visit 清成了 0 —— 于是它在标准入口里走的是**显式跳过**
        //    分支，等价于**完全没有覆盖**（更糟的是跳过在 smoke 的汇总里被算成"通过"）。
        //    而 `svc:visits` 正是 H3 详情抽屉的数据源，本轮刚在它旁边修过 P0 级缺陷
        //    （请求路径多一层 `/api` → 404）。所以它必须挂在一个**自带 Visit 夹具**的
        //    脚本上：本脚本此刻的临时工单正好有 2 条 Visit（#1 SUPERSEDED / #2 ASSIGNED）。
        //    ⇒ 判据要与夹具同生命周期，不能依赖"库里碰巧有数据"。
        const res = await svcGet('visits', scratchTicketId, token);
        assert(res.status === 200, `svc:visits HTTP ${res.status} ${errorMessageOf(res)}`);
        const visits = res.json?.data?.visits ?? [];
        assert(
          visits.length >= 1,
          `工单 ${scratchTicketId} 明明有 Visit，svc:visits 却返回 0 条 —— 接口没按 ticket_id 查`,
        );

        // ① 严格 ticket 作用域：一条别的工单的 Visit 都不许混进来
        const foreign = visits.filter((v) => v.ticket_id !== scratchTicketId);
        assert(
          foreign.length === 0,
          `返回了别的工单的 Visit（${foreign.map((v) => v.ticket_id).join(',')}）—— 过滤失效`,
        );

        // ② 凭据列必须**根本不出现**（判据用 `in`，好把"键不存在"与"值为 null"分开）
        const forbidden = [
          'access_token_hash',
          'token_expires_at',
          'token_used_at',
          'token_revoked_at',
        ];
        const leaked = forbidden.filter((col) => visits.some((v) => col in v));
        assert(leaked.length === 0, `svc:visits 泄露了凭据列：${leaked.join(', ')}`);

        // ③ 失效原因反过来**必须**保留 —— 抽屉要靠它解释"这条链接为什么失效"
        assert(
          visits.some((v) => 'token_revoked_reason' in v),
          'visits 里没有 token_revoked_reason —— 抽屉无法显示"链接为什么失效"',
        );

        // ④ 被改派作废的那条历史 Visit 仍必须读得到（抽屉"处理记录"要显示它）
        //    ⚠️ 字段名是 `visit_status`（不是 `status`）—— Phase 4-A 起它才是
        //    生命周期的唯一事实来源，老的 `status` 已降级为派生字段。
        //    这里**实测踩过**：按 `status` 判会拿到 `undefined`，断言报出
        //    "读不到 SUPERSEDED 的历史 Visit："（后面空空如也）——
        //    凡是要断言某个字段，先确认它真的是接口返回的那个键名。
        const superseded = visits.find((v) => v.visit_status === 'SUPERSEDED');
        assert(
          superseded,
          `读不到 SUPERSEDED 的历史 Visit：${visits
            .map((v) => `${v.visit_no}:${v.visit_status ?? '(无 visit_status)'}`)
            .join(' / ')}`,
        );
        assert(
          superseded.superseded_reason != null && superseded.superseded_reason !== '',
          'SUPERSEDED 的 Visit 没有 superseded_reason —— 抽屉说不清"为什么作废"',
        );
        return `${visits.length} 条（含 #${superseded.visit_no} SUPERSEDED）· 0 个凭据列 · 保留失效原因`;
      },
    );
  }
} catch (error) {
  if (error instanceof EnvNotReady) {
    envFailure = error.message;
  } else {
    // 联机前置条件（受理/首次派工）失败 → 记成一条红灯，而不是抛栈崩掉：
    // 崩掉的输出没人看得出"到底哪一步没成立"，而红灯会点名。
    failures.push({ name: '联机前置条件（受理/首次派工）', message: error.message });
    console.log(`  ❌ 联机前置条件（受理/首次派工） — ${error.message}`);
  }
} finally {
  cleanup();
  const left = scratchTicketId
    ? Number(psqlScalar(`SELECT count(*) FROM service_tickets WHERE id = ${scratchTicketId}`))
    : 0;
  console.log(`  · 已清理一次性工单（残留 ${left} 行）`);
}

if (envFailure) {
  console.log(`\n  ❌ 环境未就绪：${envFailure}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
if (failures.length) {
  console.log(`  ❌ 失败 ${failures.length} 项 —— 改派 reason 契约仍不完整`);
  for (const f of failures) console.log(`     · ${f.name}：${f.message}`);
  console.log('═'.repeat(66) + '\n');
  process.exit(1);
}
console.log(
  REVERSE
    ? `  ✅ 反向验证通过：判据确实会变红（${passed} 项）—— 不是恒绿断言`
    : `  ✅ 全部通过：${passed} 项 —— reason 从 UI 到事件全程不丢，服务端防线未放宽`,
);
console.log('═'.repeat(66) + '\n');
