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

import { SVC_SCHEME, SVC_BASE_URL_PORT, SVC_BASE_URL } from './lib/base-url.mjs';
// P11-1：匿名建单必须带门店签名入口（`?k=…`）；入口值只从这一处来（产品的签名实现）
import { storeEntryQuery } from './lib/store-entry-token.mjs';

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

const PORT = SVC_BASE_URL_PORT;
const BASE_URL = `${SVC_SCHEME}://localhost:${PORT}`;
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

/**
 * 多列查询 → 行数组。分隔符用 `\u0001`（不会出现在业务值里）。
 *
 * ⚠️ 与 `psqlScalar` 并存而不是"拼一个字符串再 split"：
 *    后者在**某个字段为空**（`access_token_hash IS NULL` 这类判据里很常见）
 *    会塌缩分隔符、把列挪位 —— 那是"读到了、但读错了"的经典形状。
 */
function psqlRows(sql) {
  const out = execFileSync(
    'docker',
    [
      'exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
      '-t', '-A', '-F', '\u0001', '-c', sql,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!out) return [];
  return out.split('\n').map((line) => line.split('\u0001'));
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
 *
 * 🔴 **2026-10-10 修订：服务方式必须是 `inhouse`（自有师傅）**，不再是 `manufacturer`。
 *
 *    冻结契约（§7.2）规定：**厂家/第三方（provider-only）不签发师傅 Token**
 *    （没有具体师傅可签发）。而 `reassign` 的语义是"作废当前师傅的链接、给新师傅发新链接"
 *    —— 它**必然**铸一枚新 Token。两者相叠的结论是：
 *      改派只对**自有师傅**成立；改派到厂家/第三方会被服务端拒绝（见下方 A4b）。
 *    旧版本这条用了 `manufacturer`，于是"改派必铸 Token"与"provider-only 不铸 Token"
 *    直接对撞 —— 服务端回 422，而门禁把它读成"改派坏了"，
 *    实际上是**门禁的输入不符合当前契约**。
 *    ⇒ 修订后的 A4 走 inhouse（契约允许的正向路径），
 *      provider-only 的两个方向（不能改派过去 / 不签发 Token）由 A4b / A4c 覆盖。
 */
const APPOINTMENT_DAY = localDateOnly(1);
const REASON_TEXT = '临时有其他急单，改派给李师傅（契约验收）';
const UI_VALUES = {
  technician_name: '李师傅',
  technician_mobile: '13900020002',
  expected_visit_at: APPOINTMENT_DAY,
  service_mode: 'inhouse',
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
/**
 * 本轮自建的**其余**一次性工单（A4c 的厂家派工样本需要自己的一张：
 * 同一张工单不可能同时有两条 ASSIGNED 的 Visit）。
 */
const extraTicketIds = [];
/** 「环境未就绪」的说明文案 —— 在 finally 之后统一 exit(2)，保证清理一定执行 */
let envFailure = '';
const cleanup = () => {
  for (const id of [scratchTicketId, ...extraTicketIds]) {
    if (!id) continue;
    // 只按**自己的** id 精确删除，绝不使用范围条件（不碰走查工单）
    psqlExec(
      [
        `DELETE FROM idempotency_records WHERE resource_id = ${id};`,
        `DELETE FROM sms_logs WHERE ticket_id = ${id};`,
        `DELETE FROM ticket_events WHERE ticket_id = ${id};`,
        `DELETE FROM service_visits WHERE ticket_id = ${id};`,
        `DELETE FROM service_tickets WHERE id = ${id};`,
      ].join(' '),
    );
  }
};

/**
 * 建一张**走真实匿名入口**的一次性工单（供 A4c 用）。
 *
 * ⚠️ 与主样本同一套做法：只回 ticket_no、按 ticket_no 反查 id
 *    （匿名接口刻意不回 id —— 不为了测试方便去改接口）。
 */
async function createProviderOnlyTicket(token) {
  void token; // 签名只需要"有没有带入口"，建单本身是匿名的
  const mobile = `137${String(Date.now() + 7).slice(-8)}`;
  const created = await http(`${BASE_URL}/api/public/tickets${storeEntryQuery('S01')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({
      store_code: 'S01',
      ticket_type: 'repair',
      content: '[P0CONTRACT] provider-only 派工样本（脚本自建，跑完自删）',
      customer_name: 'P0契约验收',
      customer_mobile: mobile,
      privacy_agreed: true,
    }),
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new EnvNotReady(
      `一次性工单（A4c）建单失败 HTTP ${created.status} ${String(created.body).slice(0, 160)}`,
    );
  }
  const ticketNo = String(created.json?.data?.ticket_no ?? '');
  const id = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${ticketNo}'`));
  if (!id) throw new EnvNotReady(`按 ticket_no=${ticketNo} 反查不到工单 id`);
  // 与主样本一样：受理（dispatch 要求 PROCESSING）
  const accepted = await svcPost('accept', id, token, {}, crypto.randomUUID());
  if (accepted.status !== 200) {
    throw new EnvNotReady(`一次性工单（A4c）受理失败 HTTP ${accepted.status} ${errorMessageOf(accepted)}`);
  }
  return id;
}

console.log('\n── A3/A4/A5 联机契约（真打接口）──');

try {
  const token = await signIn(STORE_EMAIL, storePassword);
  if (!token) {
    throw new EnvNotReady(`门店账号 ${STORE_EMAIL} 登录失败（口令可能已轮换）`);
  }

  // ---- 建一张一次性工单（匿名接口，真实入口）----
  const mobile = `137${String(Date.now()).slice(-8)}`;
  const created = await http(`${BASE_URL}/api/public/tickets${storeEntryQuery('S01')}`, {
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
      // ⚠️ 必须是 `inhouse`：改派要"作废旧师傅的链接、给新师傅发新链接"，
      //    而 provider-only 按契约**不签发 Token** ⇒ 那条路上根本没有可作废的链接。
      //    详见 UI_VALUES 上方那段 2026-10-10 修订说明。
      service_mode: 'inhouse',
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
    /**
     * A4b —— **改派到厂家/第三方必须被拒绝**（契约 §7.2 的推论）
     *
     * 这条是 A4 修订后的**反向对照**：正向路径（inhouse）必须成功，
     * 而"改派 → provider-only"这条**契约上不成立**的路必须**明确拒绝**，
     * 不能靠"反正 UI 不会这么点"来回避 —— 服务端才是唯一事实来源。
     *
     * ⚠️ 判据两条一起：
     *   ① 拒绝码是 `TOKEN_NOT_ALLOWED_WITHOUT_TECHNICIAN`（不是含糊的 500/409）；
     *   ② **零副作用**：Visit 数不变、Visit #2 仍是 ASSIGNED、
     *      且**旧师傅的 Token 没有被作废**（否则一次被拒的请求会把在跑的师傅踢出局 ——
     *      那是比"没成功"严重得多的事故）。
     */
    await checkAsync(
      'A4b 改派到厂家/第三方（provider-only）⇒ 422 TOKEN_NOT_ALLOWED_WITHOUT_TECHNICIAN，且旧链接未被作废',
      async () => {
        const visitsBefore = psqlScalar(
          `SELECT count(*)||':'||` +
            `(SELECT visit_status FROM service_visits WHERE ticket_id = ${scratchTicketId} AND visit_no = 2) ` +
            `FROM service_visits WHERE ticket_id = ${scratchTicketId}`,
        );
        const tokenBefore = psqlScalar(
          `SELECT token_revoked_at IS NULL FROM service_visits WHERE ticket_id = ${scratchTicketId} AND visit_no = 2`,
        );

        const res = await svcPost(
          'reassign',
          scratchTicketId,
          token,
          buildReassignPayload({
            technician_name: '海尔售后',
            technician_mobile: '13900030003',
            expected_visit_at: APPOINTMENT_DAY,
            service_mode: 'manufacturer',
            provider_name: '契约验收厂家',
            reason: '厂家上门处理（契约验收：这条必须被拒）',
          }),
          crypto.randomUUID(),
        );

        assert(
          res.status === 422,
          `期望 422，实际 ${res.status} ${errorMessageOf(res)}（契约 §7.2：provider-only 不签发师傅 Token）`,
        );
        eq(errorCodeOf(res), 'TOKEN_NOT_ALLOWED_WITHOUT_TECHNICIAN', '错误码');

        const visitsAfter = psqlScalar(
          `SELECT count(*)||':'||` +
            `(SELECT visit_status FROM service_visits WHERE ticket_id = ${scratchTicketId} AND visit_no = 2) ` +
            `FROM service_visits WHERE ticket_id = ${scratchTicketId}`,
        );
        eq(visitsAfter, visitsBefore, 'Visit 数/状态（被拒的改派不得留下副作用）');
        const tokenAfter = psqlScalar(
          `SELECT token_revoked_at IS NULL FROM service_visits WHERE ticket_id = ${scratchTicketId} AND visit_no = 2`,
        );
        eq(tokenAfter, tokenBefore, '旧师傅链接是否仍有效（被拒的改派不得作废在跑的链接）');
        assert(tokenAfter === 't', `旧师傅的链接已被作废（token_revoked_at 非空）—— 这是不允许的副作用`);
        return `HTTP 422 · ${errorCodeOf(res)} · Visit ${visitsAfter} · 旧链接仍有效`;
      },
    );

    /**
     * A4c —— **厂家/第三方派工本身：Visit 成立、但不签发师傅 Token、且不发师傅短信**
     *
     * 这条覆盖契约 §7.2 的**正向**要求（"provider-only 是合法形态，只是没有 Token"），
     * 与 A4b 合起来把"provider-only 这条边"两侧都钉住：
     *   · 允许：派工给厂家（门店只需知道"报给海尔了"）⇒ 不铸 Token、不发给师傅的短信；
     *   · 禁止：在它上面做改派（A4b）—— 因为改派必然铸 Token。
     *
     * 需要**另起一张工单**（当前那张已有一条 ASSIGNED 的 Visit，不能再派工）。
     */
    await checkAsync(
      'A4c 厂家/第三方派工：Visit 成立但**无 Token**、`technician_mobile` 为空、且不发师傅短信',
      async () => {
        const providerTicketId = await createProviderOnlyTicket(token);
        extraTicketIds.push(providerTicketId);

        const res = await svcPost(
          'dispatch',
          providerTicketId,
          token,
          buildDispatchPayload({
            // provider-only 允许**不填**师傅姓名/手机号（现实里门店常常不知道）
            expected_visit_at: APPOINTMENT_DAY,
            service_mode: 'manufacturer',
            provider_name: '契约验收厂家',
          }),
          crypto.randomUUID(),
        );
        assert(res.status === 200, `厂家派工失败 HTTP ${res.status} ${errorMessageOf(res)}`);

        const row = psqlRows(
          `SELECT visit_no, visit_status, ` +
            `(access_token_hash IS NULL), ` +
            `(token_expires_at IS NULL), ` +
            `coalesce(technician_mobile,'<null>'), coalesce(technician_name,'<null>') ` +
            `FROM service_visits WHERE ticket_id = ${providerTicketId} ORDER BY visit_no DESC LIMIT 1`,
        )[0];
        assert(row, '厂家派工后读不到 Visit（派工没落库？）');
        eq(row[1], 'ASSIGNED', 'Visit 状态');
        eq(row[2], 't', 'access_token_hash 必须为 NULL（无具体师傅 ⇒ 不签发 Token）');
        eq(row[3], 't', 'token_expires_at 必须为 NULL');
        eq(row[4], '<null>', 'technician_mobile（provider-only 允许为空）');

        // 短信：provider-only 不得产生 `technician_task`（收件人是空号、链接也生成不出来）
        const techSms = Number(
          psqlScalar(
            `SELECT count(*) FROM sms_logs WHERE ticket_id = ${providerTicketId} AND scene = 'technician_task'`,
          ),
        );
        eq(techSms, 0, '发给师傅的任务短信条数（provider-only 必须整条跳过）');
        // 正对照：客户侧那条**必须**在（否则"0 条"可能只是因为整个短信链路没跑）
        const custSms = Number(
          psqlScalar(
            `SELECT count(*) FROM sms_logs WHERE ticket_id = ${providerTicketId} AND scene <> 'technician_task'`,
          ),
        );
        assert(custSms > 0, '客户侧短信一条都没有 —— 上面那条"0 条师傅短信"的判据失去意义');
        return `Visit ASSIGNED · 无 Token · 师傅短信 0 条 / 客户短信 ${custSms} 条`;
      },
    );
  }

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
      //    只能盯住"模板入参是怎么来的"这个**唯一入口**。
      //
      // 🔴 2026-10-10 修订：本条此前要求"`expected:` 取值点 ≥2"，实测只剩 1 处而报红。
      //    核查后确认**是判据过时、不是产品退化**：
      //      产品后来把格式化**收敛成一个局部变量**（更好）：
      //        `const expected = formatVisitDate(visit.expected_visit_at);`
      //      两处短信 params 改用**简写属性** `expected,` —— 于是 `^expected\s*:`
      //      一条都匹配不到那两处，计数从 2 掉到 1。
      //    ⇒ 判据改成按**真实形状**覆盖三类位置：
      //       ① 显式赋值 `expected: X`（每个都必须 formatVisitDate 包裹）；
      //       ② 简写 `expected,`（要求同文件里存在 `const expected = formatVisitDate(…)` 定义）；
      //       ③ 专门盯"把原始日期字段直接喂进去"这一种**退化形状**。
      //      计数下限保留（铁律 10：读不到必须变红），但不再是"≥2"这种会被
      //      合理重构误伤的数字 —— 保住的是"至少有一处真的在传"。
      const TYPE_ONLY = /^expected\s*:\s*(string|number|Date|unknown|any)\b/;
      const src = fs.readFileSync(
        path.join(PLUGIN_SRC, 'server/services/ticket-service.ts'),
        'utf8',
      );
      const lines = src.split('\n').map((line, i) => ({ line: line.trim(), no: i + 1 }));

      /** ① 显式 `expected: X`（排除类型标注） */
      const explicit = lines
        .filter((x) => /^expected\s*:/.test(x.line))
        .filter((x) => !TYPE_ONLY.test(x.line));
      /** ② 简写 `expected,`（依赖外层的 const） */
      const shorthand = lines.filter((x) => /^expected,$/.test(x.line));
      /** ③ 退化形状：把原始日期字段直接当 expected 传（必须为 0） */
      const rawLeaks = lines.filter((x) =>
        /^expected\s*:\s*(visit\.expected_visit_at|expectedVisitAt|params\.expectedVisitAt|input\.expectedVisitAt)\b/.test(
          x.line,
        ),
      );

      assert(
        explicit.length + shorthand.length >= 1,
        `一个「把上门日期喂给短信模板」的取值点都没读到（显式 ${explicit.length} / 简写 ${shorthand.length}）` +
          '—— 判据已失效（铁律 10：读到空必须变红，不能静默通过）',
      );
      const bad = explicit.filter((x) => !x.line.includes('formatVisitDate('));
      assert(
        bad.length === 0,
        `有 ${bad.length} 处显式 expected 未经过 formatVisitDate：${bad.map((x) => `L${x.no}`).join(',')}`,
      );
      if (shorthand.length > 0) {
        // 简写形态下"格式化在哪"由那个 const 决定 —— 必须能指出来，否则简写就是逃逸口。
        //
        // ⚠️ 判据**不能**是"所有 `const expected =` 都必须 formatVisitDate"：
        //    同文件里另有一处**同名局部变量** `const expected = Number(visitId)`
        //    （幂等守卫里的"期望 visitId"）—— 它跟上门日期毫无关系，
        //    一刀切会报出一条**假红**（首跑实测就是这条）。
        //    真正要守的性质是：**凡是承载"上门日期"的 expected 定义，都必须过 formatVisitDate**。
        //    所以只对 RHS **引用了日期字段**的定义做要求。
        const DATE_ISH = /(expected_visit_at|expectedVisitAt)/;
        const defs = lines.filter((x) => /^const\s+expected\s*=/.test(x.line));
        const dateDefs = defs.filter((x) => DATE_ISH.test(x.line));
        assert(
          dateDefs.length > 0,
          `有 ${shorthand.length} 处简写 \`expected,\`，但同文件里找不到"由上门日期算出来的" \`const expected =\` 定义` +
            `（共 ${defs.length} 个同名局部变量，无一引用日期字段）—— 值的来源无法追溯`,
        );
        const badDefs = dateDefs.filter((x) => !x.line.includes('formatVisitDate('));
        assert(
          badDefs.length === 0,
          `承载上门日期的 \`const expected =\` 未经过 formatVisitDate：${badDefs.map((x) => `L${x.no}`).join(',')}`,
        );
      }
      // 退化形状必须为 0：这是最可能被"顺手改成直接传日期"的那一种写法
      assert(
        rawLeaks.length === 0,
        `有 ${rawLeaks.length} 处把原始日期字段直接当 expected 传给短信模板：` +
          `${rawLeaks.map((x) => `L${x.no}`).join(',')}（会显示成带时分的完整时间戳）`,
      );
      return `显式 ${explicit.length} 处 + 简写 ${shorthand.length} 处，全部只到天；原始日期直传 0 处`;
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
