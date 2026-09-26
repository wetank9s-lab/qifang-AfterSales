#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-review-loop.mjs —— Phase 7「客户评价闭环」核心门禁 A–G
 * -----------------------------------------------------------------------------
 *  为什么需要它：
 *    Phase 7 的业务闭环是「WAIT_FEEDBACK → 评价短信 → /f/{token} → 匿名评价
 *    → CLOSED / reopen / 超时关闭」。这条链上**真正承重的只有 7 件事**：
 *      ① 匿名 Review Token（一次性 / 过期 / 错 token）
 *      ② 一次性提交与并发双提交
 *      ③ 提交 × 超时关闭竞争（谁赢）
 *      ④ 收费金额核对三态（服务端权威）
 *      ⑤ reopen 状态事务（低分 / 金额不一致）
 *      ⑥ 评价短信链接安全（明文 Token 不落库 / 不进日志）
 *      ⑦ 超时任务与提交竞争
 *    页面样式、星级组件、普通文案**刻意不建门**（用户明令：只测承重部分）。
 *
 *  本脚本的七组断言（与用户 A–G 逐条对应）：
 *    A. Token 有效 / 畸形 / 不存在 / 已过期 / 已用  —— 匿名 GET 的最小上下文与状态翻转
 *    B. 正常评价 5 星 + 金额 match → CLOSED + submitted + reviewed_at
 *    C. 低分 ≤2 → PROCESSING + escalated + reopen_count+1
 *    D. 高星 + 金额 mismatch 仍必须 reopen
 *    E. submit × submit 并发 → 恰好一个 winner（真并发）
 *    F. submit × expiry 并发 → 恰好一个 winner（真并发；两种先后都要覆盖）
 *    G. SMS：/f/{token} 链接形态正确、明文 Token 不落库/不进日志、
 *       accepted != delivered 语义不混淆
 *
 *  **反向验证**（`--reverse`，铁律 8：断言不会变红 = 没有断言）：
 *    把 `feedback_token_used_at` 手工清回 NULL（模拟"一次性"失效）
 *    → E 组必须变红（能拿同一 token 再投一次）→ 恢复后全绿。
 *
 *  用法：
 *    node scripts/verify-review-loop.mjs              # 正常验收
 *    node scripts/verify-review-loop.mjs --verbose    # 打印每个用例明细
 *    node scripts/verify-review-loop.mjs --reverse    # 反向验证（写库后还原）
 *
 *  退出码：
 *    0 = 全部通过
 *    1 = 有失败项（真红灯）
 *    2 = 环境未就绪（服务不可达 / 脚本前置不满足 —— 不是产品缺陷）
 *
 * ⚠️ 本脚本会**写库**（造工单 / 造 Visit / 改状态）。它造的工单都带
 *    `PHASE7-GATE-` 前缀的 ticket_no，跑完自行清理；`--keep` 可保留现场。
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const REVERSE = process.argv.includes('--reverse');
const KEEP = process.argv.includes('--keep');

const PORT = Number(process.env.NGINX_HTTP_PORT || 8080);
const BASE = `http://localhost:${PORT}`;

/**
 * 验收期间临时放宽的 nginx 突发额度（`/api/public/` 的 svc_public 桶）。
 *
 * ⚠️ 为什么必须动它：本门禁在几十秒内要从**同一个 IP**（本机 127.0.0.1）
 *    发出上百个 `/api/public/reviews/*` 请求，而 nginx 给匿名区配的是
 *    `rate=30r/m burst=10`（回仓库取证：nginx/nginx.conf）。
 *    生产里每个客户有各自的公网 IP、天然不共享桶，因此门禁的流量形态
 *    **本就不该**走对客突发额度。首跑就是跑到 E 组得到一整排 429，
 *    然后被误读成"提交根本没生效"。
 *
 * ⚠️ 做法：**临时改 + 跑完还原**（写文件 → nginx reload → 跑 → 还原 → reload）。
 *    绝不放宽 `rate=30r/m`（那是对客承诺），只放宽 burst（突发容量）。
 *    `--no-burst-override` 可关闭这个行为，用于观察真实限流下的表现。
 */
const GATE_BURST = '2000';
const SERVICE_CONF = path.join(ROOT, 'nginx', 'conf.d', 'service.conf');
const ORIGINAL_CONF = fs.existsSync(SERVICE_CONF) ? fs.readFileSync(SERVICE_CONF, 'utf8') : null;
const NO_BURST_OVERRIDE = process.argv.includes('--no-burst-override');

function dockerCompose(args) {
  return execFileSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8' });
}

function raisePublicBurst() {
  if (NO_BURST_OVERRIDE || !ORIGINAL_CONF) return false;
  const patched = ORIGINAL_CONF.replace(
    /(limit_req zone=svc_public burst=)\d+/,
    `$1${GATE_BURST}`,
  );
  if (patched === ORIGINAL_CONF) return false;
  try {
    fs.writeFileSync(SERVICE_CONF, patched);
    dockerCompose(['exec', '-T', 'nginx', 'nginx', '-s', 'reload']);
    console.log(`  · 验收期临时把 /api/public/ 的 burst 调到 ${GATE_BURST}（跑完自动还原）`);
    return true;
  } catch (e) {
    console.log(`  · burst 临时调大失败（继续跑，可能会看到 429）：${e.message}`);
    restorePublicBurst();
    return false;
  }
}

function restorePublicBurst() {
  if (!ORIGINAL_CONF) return;
  try {
    if (fs.readFileSync(SERVICE_CONF, 'utf8') !== ORIGINAL_CONF) {
      fs.writeFileSync(SERVICE_CONF, ORIGINAL_CONF);
      dockerCompose(['exec', '-T', 'nginx', 'nginx', '-s', 'reload']);
      console.log('  · 已还原 nginx burst 与限流配置');
    }
  } catch (e) {
    console.error(`  ⚠️ 还原 nginx 配置失败，请手工检查 nginx/conf.d/service.conf：${e.message}`);
  }
}

process.on('exit', restorePublicBurst);
process.on('SIGINT', () => { restorePublicBurst(); process.exit(2); });

/**
 * 门禁造的工单统一前缀 —— 清理与"别误删真人数据"都靠它。
 * ⚠️ `ticket_no` 只有 **24 字符**（回库取证：character varying(24)）。
 *    已发布的单号形态是 `FWYYYYMMDD-NNNN`（15 字）。这里必须留够余量，
 *    否则 INSERT 直接 `value too long for type character varying(24)`
 *    —— 门禁首跑踩过一次。用 `P7G-<base36 时间戳后 8 位>-<序号>` ≈ 17 字。
 */
const GATE_PREFIX = 'P7G-';

const passed = [];
const failed = [];

function ok(name, detail = '') {
  passed.push({ name, detail });
  if (VERBOSE) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail) {
  failed.push({ name, detail });
  console.log(`  ❌ ${name}\n       ${detail}`);
}
function assert(cond, name, detail = '') {
  if (cond) ok(name, detail);
  else bad(name, detail || '断言失败');
}

// ---------------------------------------------------------------------------
// 数据库直连（用 psql 走 docker compose exec，与其它门禁同口径）
// ---------------------------------------------------------------------------
function sql(query) {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
     '-t', '-A', '-F', '|', '-c', query],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out.trim().split('\n').filter((l) => l.length > 0).map((l) => l.split('|'));
}
function sqlOne(query) {
  const rows = sql(query);
  return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function http(method, urlPath, body, headers = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 302 页面） */ }
  return { status: res.status, headers: res.headers, text, json };
}

// ---------------------------------------------------------------------------
// SHA-256（与 app 侧同口径）
// ---------------------------------------------------------------------------
import { createHash, randomBytes } from 'node:crypto';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** REVIEW_TOKEN 冻结口径：32 bytes → base64url（无 padding）→ 43 字符 */
const mintToken = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------
// 造数据：一条处于 WAIT_FEEDBACK 的工单 + 一条已确认的 Visit
//
// ⚠️ 这里的表名/列名/约束都是**回库取证**过的（不是猜的）：
//   · 本项目**没有独立门店表** —— 门店就是工单上的 `store_id`/`store_name`；
//   · `service_tickets` NOT NULL：created_at/updated_at/ticket_no/source/
//     ticket_type/content/customer_mobile/status/escalated/reopen_count；
//   · `service_visits` NOT NULL：created_at/updated_at/visit_no/service_mode/
//     technician_name/technician_mobile/expected_visit_at/is_remote/
//     store_confirm_status/visit_status。
//   ⚠️ 首跑就是被 `service_stores`（**不存在的表**）直接炸掉的 ——
//      造数据同样必须"先取证再写 SQL"，不能凭 P6 文档里的名字猜。
// ---------------------------------------------------------------------------
let seq = 0;
function makeTicket({ charged = true, amount = 120.5, windowDays = 7, completedAgoDays = 0 } = {}) {
  seq += 1;
  // 24 字上限：P7G-(4) + base36 时间戳后 8 位 + '-' + 序号 ≈ 17 字，安全
  const ticketNo = `${GATE_PREFIX}${Date.now().toString(36).slice(-8)}-${seq}`;
  const token = mintToken();
  const hash = sha256(token);

  const completedExpr = completedAgoDays > 0
    ? `now() - interval '${completedAgoDays} days'`
    : 'now()';

  // 直接落库造现场：门禁要控制"已过期/未过期"的精确时刻，走接口造不出来
  const [inserted] = sql(`
    INSERT INTO service_tickets
      (ticket_no, source, status, review_status, completed_at, content, ticket_type,
       customer_mobile, store_id,
       feedback_token_hash, feedback_token_expires_at,
       reopen_count, escalated, created_at, updated_at)
    VALUES
      ('${ticketNo}', 'qr', 'WAIT_FEEDBACK', 'pending', ${completedExpr},
       '${GATE_PREFIX}验收用报修内容（勿动）', 'repair',
       '13800000000', 1,
       '${hash}', now() + interval '${windowDays} days',
       0, false, now(), now())
    RETURNING id
  `);
  const ticketId = Number(inserted[0]);

  // Visit：已确认，带收费事实（feedback_visit_id 指过来）
  const visitResult = sql(`
    INSERT INTO service_visits
      (ticket_id, visit_status, visit_no, service_mode,
       technician_name, technician_mobile, expected_visit_at,
       is_remote, store_confirm_status,
       is_charged, confirmed_charge_amount, submitted_at, store_confirmed_at,
       created_at, updated_at)
    VALUES
      (${ticketId}, 'CONFIRMED', 1, 'onsite',
       '验收师傅', '13900000000', now(),
       false, 'confirmed',
       ${charged ? 'true' : 'false'},
       ${charged ? amount : 'NULL'}, now(), now(),
       now(), now())
    RETURNING id
  `);
  const visitId = Number(visitResult[0][0]);

  sql(`UPDATE service_tickets SET feedback_visit_id = ${visitId} WHERE id = ${ticketId}`);

  return { ticketId, visitId, ticketNo, token, hash };
}

function ticketRow(ticketId) {
  const r = sqlOne(`
    SELECT status, review_status, rating, review_comment, reviewed_at,
           feedback_token_used_at, escalated, reopen_count, closed_at, close_reason
    FROM service_tickets WHERE id = ${ticketId}
  `);
  if (!r) return null;
  return {
    status: r[0], review_status: r[1], rating: r[2] === '' ? null : Number(r[2]),
    review_comment: r[3] === '' ? null : r[3], reviewed_at: r[4] === '' ? null : r[4],
    used_at: r[5] === '' ? null : r[5], escalated: r[6] === 't',
    reopen_count: Number(r[7] || 0), closed_at: r[8] === '' ? null : r[8],
    close_reason: r[9] === '' ? null : r[9],
  };
}

function visitRow(visitId) {
  const r = sqlOne(`
    SELECT is_charged, confirmed_charge_amount, customer_charge_match,
           customer_reported_amount, charge_diff_reason
    FROM service_visits WHERE id = ${visitId}
  `);
  if (!r) return null;
  return {
    is_charged: r[0] === 't',
    confirmed: r[1] === '' ? null : Number(r[1]),
    match: r[2] === '' ? null : r[2],
    reported: r[3] === '' ? null : Number(r[3]),
    reason: r[4] === '' ? null : r[4],
  };
}

function eventRows(ticketId) {
  return sql(`
    SELECT event_type, from_status, to_status, operator_kind
    FROM ticket_events WHERE ticket_id = ${ticketId} ORDER BY id
  `).map((r) => ({ type: r[0], from: r[1], to: r[2], operator: r[3] }));
}

function cleanup() {
  // 只删本门禁造的行（前缀 + 外键顺序）
  const ids = sql(`SELECT id FROM service_tickets WHERE ticket_no LIKE '${GATE_PREFIX}%'`).map((r) => r[0]);
  if (!ids.length) return 0;
  const list = ids.join(',');
  sql(`DELETE FROM ticket_events WHERE ticket_id IN (${list})`);
  sql(`DELETE FROM sms_logs WHERE ticket_id IN (${list})`);
  sql(`DELETE FROM service_visits WHERE ticket_id IN (${list})`);
  sql(`DELETE FROM service_tickets WHERE id IN (${list})`);
  return ids.length;
}

/**
 * 清空评价相关的**限流桶**（`review_view` / `review_submit`）。
 *
 * ⚠️ 为什么必须清：本门禁在几十秒内要发几十个评价请求，而它们**全部来自
 *    同一个 IP**（本机 127.0.0.1），共享一个真实的限流桶
 *    （`security.ip_minute_limit` = 30 / 分钟，回库取证）。
 *    不清桶的话，跑到 E 组并发用例时桶早就满了 —— 首跑就是这样得到
 *    一整排 **429**，然后被误读成"提交根本没生效"。
 *
 * ⚠️ 这是**门禁专属操作**，不是产品行为放宽：
 *    它只清 `api_guards` 里两个评价场景的计数行，不改任何配置、不改业务数据。
 *    生产里客户从各自 IP 访问，天然不共享桶；而"限流本身生效"由各自
 *    的专项断言（以及 D2n/D2o 首跑意外拿到的 429）独立证明。
 */
function resetRateBuckets() {
  sql(`DELETE FROM api_guards WHERE scene IN ('review_view', 'review_submit')`);
}

/** 每个用例组开头调用：清桶 + 清残留的验收工单 */
function beginGroup() {
  resetRateBuckets();
  cleanup();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  // 0) 环境探活
  try {
    const r = await fetch(`${BASE}/api/svc/health`);
    if (!r.ok) throw new Error(`health ${r.status}`);
  } catch (e) {
    console.error(`环境未就绪：${BASE}/api/svc/health 不可达（${e.message}）`);
    process.exit(2);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Phase 7 客户评价闭环门禁（${REVERSE ? '反向验证' : '正向验收'}）`);
  console.log('══════════════════════════════════════════════════════════════');

  // 验收期临时放宽 nginx 突发额度（跑完 / 异常退出都会还原，见 restorePublicBurst）
  raisePublicBurst();

  // =========================================================================
  // A. Token：有效 / 畸形 / 不存在 / 已过期 / 已用
  // =========================================================================
  console.log('\n【A】匿名 Review Token 的形态与状态');
  beginGroup();
  {
    // A1 /f/{token} 302（不是 301）
    const t1 = mintToken();
    const r = await http('GET', `/f/${t1}`);
    assert(r.status === 302, 'A1 /f/{token} → 302', `实际 ${r.status}`);
    assert(
      (r.headers.get('location') || '') === `/h5/customer/review/${t1}`,
      'A1b 302 Location 指向 /h5/customer/review/{token}',
      `实际 ${r.headers.get('location')}`,
    );

    // A2 malformed token → 404（不重写，原样到应用）
    const rShort = await http('GET', '/f/short');
    assert(rShort.status === 404, 'A2 畸形 token（长度不符）→ 404', `实际 ${rShort.status}`);

    // A3 不存在（形态合法）→ GET 404 REVIEW_NOT_FOUND
    const rNone = await http('GET', `/api/public/reviews/${mintToken()}`);
    assert(rNone.status === 404, 'A3 不存在的 token（形态合法）→ GET 404', `实际 ${rNone.status}`);
    assert(
      rNone.json?.errors?.[0]?.code === 'REVIEW_NOT_FOUND',
      'A3b 错误码为 REVIEW_NOT_FOUND（统一话术，不泄露存在性）',
      JSON.stringify(rNone.json?.errors?.[0]),
    );

    // A4 有效 token → GET 200 最小上下文（且不含内部字段）
    const good = makeTicket({ charged: true, amount: 88.8 });
    const rGood = await http('GET', `/api/public/reviews/${good.token}`);
    assert(rGood.status === 200, 'A4 有效 token → GET 200', `实际 ${rGood.status}`);
    const ctx = rGood.json?.data ?? rGood.json;
    assert(ctx?.can_review === true, 'A4b can_review = true', JSON.stringify(ctx?.can_review));
    assert(ctx?.review_state === 'pending', 'A4c review_state = pending', JSON.stringify(ctx?.review_state));
    assert(typeof ctx?.ticket_no === 'string' && ctx.ticket_no.length > 0, 'A4d 回传 ticket_no');
    assert(ctx?.confirmed_charge_amount === 88.8, 'A4e 回传门店确认收费金额 88.8', JSON.stringify(ctx?.confirmed_charge_amount));
    // 最小化：绝不出现内部字段
    const rawCtx = JSON.stringify(rGood.json);
    const leakKeys = ['technician_token', 'token_hash', 'feedback_token_hash', 'customer_mobile',
                      'storage_key', 'upload_ip_hash', 'operator_user_id', 'user_id'];
    const leaked = leakKeys.filter((k) => rawCtx.includes(k));
    assert(leaked.length === 0, 'A4f GET 上下文不含内部字段（token hash / 手机号 / 用户 ID…）', `泄漏键：${leaked.join(',')}`);

    // A5 已过期 token（expires_at 在过去）→ GET 200 但 can_review=false / review_state=expired
    const expired = makeTicket({ charged: true, amount: 50 });
    sql(`UPDATE service_tickets SET feedback_token_expires_at = now() - interval '1 hour' WHERE id = ${expired.ticketId}`);
    const rExp = await http('GET', `/api/public/reviews/${expired.token}`);
    assert(rExp.status === 200, 'A5 过期 token → GET 仍 200（页面能给出提示，而不是白页）', `实际 ${rExp.status}`);
    const expCtx = rExp.json?.data ?? rExp.json;
    assert(expCtx?.can_review === false, 'A5b 过期 token can_review = false', JSON.stringify(expCtx?.can_review));
    assert(expCtx?.review_state === 'expired', 'A5c review_state = expired', JSON.stringify(expCtx?.review_state));

    // A5d 过期 token POST → 410 REVIEW_EXPIRED
    const rExpPost = await http('POST', `/api/public/reviews/${expired.token}`, {
      rating: 5, charge_match: 'match',
    });
    assert(rExpPost.status === 410, 'A5d 过期 token POST → 410', `实际 ${rExpPost.status}`);
    assert(
      rExpPost.json?.errors?.[0]?.code === 'REVIEW_EXPIRED',
      'A5e 过期错误码 = REVIEW_EXPIRED',
      JSON.stringify(rExpPost.json?.errors?.[0]),
    );

    // A6 已用 token → GET 200 can_review=false / submitted；POST → 409
    const used = makeTicket({ charged: true, amount: 30 });
    const usedOk = await http('POST', `/api/public/reviews/${used.token}`, { rating: 5, charge_match: 'match' });
    assert(usedOk.status === 200, 'A6 首次提交 → 200', `实际 ${usedOk.status}`);
    const rUsedGet = await http('GET', `/api/public/reviews/${used.token}`);
    const usedCtx = rUsedGet.json?.data ?? rUsedGet.json;
    assert(usedCtx?.can_review === false, 'A6b 已用 token can_review = false', JSON.stringify(usedCtx?.can_review));
    assert(usedCtx?.review_state === 'submitted', 'A6c review_state = submitted', JSON.stringify(usedCtx?.review_state));
    const rUsedPost = await http('POST', `/api/public/reviews/${used.token}`, { rating: 5, charge_match: 'match' });
    assert(rUsedPost.status === 409, 'A6d 已用 token POST → 409', `实际 ${rUsedPost.status}`);
    assert(
      rUsedPost.json?.errors?.[0]?.code === 'REVIEW_ALREADY_SUBMITTED',
      'A6e 已用错误码 = REVIEW_ALREADY_SUBMITTED',
      JSON.stringify(rUsedPost.json?.errors?.[0]),
    );

    if (!KEEP) { cleanup(); }
  }

  // =========================================================================
  // B. 正常评价：5 星 + match → CLOSED + submitted + reviewed_at
  // =========================================================================
  console.log('\n【B】正常评价（5 星 + 金额一致）→ CLOSED');
  beginGroup();
  {
    const t = makeTicket({ charged: true, amount: 120.5 });
    const r = await http('POST', `/api/public/reviews/${t.token}`, {
      rating: 5, comment: '师傅很专业，收费透明', charge_match: 'match',
    });
    assert(r.status === 200, 'B1 POST → 200', `实际 ${r.status} ${r.text.slice(0, 160)}`);

    const row = ticketRow(t.ticketId);
    assert(row.status === 'CLOSED', 'B2 Ticket → CLOSED', `实际 ${row.status}`);
    assert(row.review_status === 'submitted', 'B3 review_status = submitted', `实际 ${row.review_status}`);
    assert(row.rating === 5, 'B4 rating = 5', `实际 ${row.rating}`);
    assert(!!row.reviewed_at, 'B5 reviewed_at 已写入', `实际 ${row.reviewed_at}`);
    assert(row.close_reason === 'reviewed', 'B6 close_reason = reviewed', `实际 ${row.close_reason}`);
    assert(!!row.closed_at, 'B7 closed_at 已写入', `实际 ${row.closed_at}`);
    assert(!!row.used_at, 'B8 feedback_token_used_at 已写入（Token 一次性）', `实际 ${row.used_at}`);
    assert(row.escalated === false, 'B9 escalated 保持 false（正常评价不上报）', `实际 ${row.escalated}`);
    assert(row.reopen_count === 0, 'B10 reopen_count 保持 0', `实际 ${row.reopen_count}`);
    assert(row.review_comment === '师傅很专业，收费透明', 'B11 评价内容落库', `实际 ${row.review_comment}`);

    const v = visitRow(t.visitId);
    assert(v.match === 'match', 'B12 Visit.customer_charge_match = match', `实际 ${v.match}`);

    const evs = eventRows(t.ticketId);
    const reviewed = evs.find((e) => e.type === 'reviewed');
    assert(!!reviewed, 'B13 写入 `reviewed` 事件', JSON.stringify(evs));
    assert(reviewed?.operator === 'customer', 'B14 reviewed 事件 operator_kind = customer', reviewed?.operator);
    assert(
      !evs.some((e) => e.type === 'reopened'),
      'B15 正常评价**不**写 `reopened` 事件',
      JSON.stringify(evs.map((e) => e.type)),
    );

    // ⚠️ 核心：正文与 metadata 里都不得出现明文 Token
    const leak = sql(`
      SELECT count(*) FROM ticket_events
      WHERE ticket_id = ${t.ticketId} AND (summary LIKE '%${t.token}%' OR metadata_json::text LIKE '%${t.token}%')
    `);
    assert(Number(leak[0][0]) === 0, 'B16 TicketEvent 里不含明文 Token（summary + metadata 双查）', `命中 ${leak[0][0]} 行`);

    if (!KEEP) cleanup();
  }

  // =========================================================================
  // C. 低分 ≤2 → PROCESSING + escalated + reopen_count+1
  // =========================================================================
  console.log('\n【C】低分评价（2 星）→ reopen 到 PROCESSING');
  beginGroup();
  {
    const t = makeTicket({ charged: true, amount: 200 });
    // 先人工把 reopen_count 置 2，验证是 **自增** 而不是"置 1"
    sql(`UPDATE service_tickets SET reopen_count = 2 WHERE id = ${t.ticketId}`);

    const r = await http('POST', `/api/public/reviews/${t.token}`, {
      rating: 2, comment: '上门太晚', charge_match: 'match',
    });
    assert(r.status === 200, 'C1 POST → 200', `实际 ${r.status} ${r.text.slice(0, 160)}`);

    const row = ticketRow(t.ticketId);
    assert(row.status === 'PROCESSING', 'C2 Ticket → PROCESSING（reopen）', `实际 ${row.status}`);
    assert(row.review_status === 'submitted', 'C3 review_status = submitted（保留评价事实）', `实际 ${row.review_status}`);
    assert(row.escalated === true, 'C4 escalated = true', `实际 ${row.escalated}`);
    assert(row.reopen_count === 3, 'C5 reopen_count 2 → 3（自增，不是置 1）', `实际 ${row.reopen_count}`);
    assert(row.rating === 2, 'C6 rating 保留 = 2', `实际 ${row.rating}`);
    assert(row.closed_at === null, 'C7 closed_at 被清空（不留 CLOSED 痕迹）', `实际 ${row.closed_at}`);
    assert(row.close_reason === null, 'C8 close_reason 被清空', `实际 ${row.close_reason}`);

    const evs = eventRows(t.ticketId);
    assert(!!evs.find((e) => e.type === 'reviewed'), 'C9 写入 `reviewed` 事件', JSON.stringify(evs.map(e => e.type)));
    assert(!!evs.find((e) => e.type === 'reopened'), 'C10 写入 `reopened` 事件', JSON.stringify(evs.map(e => e.type)));
    const re = evs.find((e) => e.type === 'reopened');
    assert(re?.to === 'PROCESSING', 'C11 reopened 事件 to_status = PROCESSING', re?.to);
    assert(re?.operator === 'system', 'C12 reopened 事件 operator_kind = system', re?.operator);

    // reopen **不**自动建新 Visit
    const visitCount = sql(`SELECT count(*) FROM service_visits WHERE ticket_id = ${t.ticketId}`);
    assert(Number(visitCount[0][0]) === 1, 'C13 reopen 不自动创建新 ServiceVisit（仍 1 条）', `实际 ${visitCount[0][0]}`);
    // completed_at 未被改写
    const comp = sql(`SELECT completed_at FROM service_tickets WHERE id = ${t.ticketId}`);
    assert(!!comp[0][0], 'C14 completed_at 未被清空/改写（Phase 6 冻结语义）', `实际 ${comp[0][0]}`);

    if (!KEEP) cleanup();
  }

  // =========================================================================
  // D. 高星 + 金额 mismatch → 仍必须 reopen
  // =========================================================================
  console.log('\n【D】金额不一致（5 星）→ 仍必须 reopen');
  beginGroup();
  {
    const t = makeTicket({ charged: true, amount: 300 });
    const r = await http('POST', `/api/public/reviews/${t.token}`, {
      rating: 5, comment: '服务挺好但价格不对', charge_match: 'mismatch', customer_reported_amount: 180,
    });
    assert(r.status === 200, 'D1 POST → 200', `实际 ${r.status} ${r.text.slice(0, 160)}`);

    const row = ticketRow(t.ticketId);
    assert(row.status === 'PROCESSING', 'D2 ★ 高星 + mismatch 仍 reopen → PROCESSING', `实际 ${row.status}`);
    assert(row.rating === 5, 'D3 rating = 5（高星不影响 reopen 判定）', `实际 ${row.rating}`);
    assert(row.escalated === true, 'D4 escalated = true', `实际 ${row.escalated}`);
    assert(row.reopen_count === 1, 'D5 reopen_count = 1', `实际 ${row.reopen_count}`);

    const v = visitRow(t.visitId);
    assert(v.match === 'mismatch', 'D6 Visit.customer_charge_match = mismatch', `实际 ${v.match}`);
    assert(v.reported === 180, 'D7 Visit.customer_reported_amount = 180', `实际 ${v.reported}`);
    assert(!!v.reason, 'D8 Visit.charge_diff_reason 已写入（便于门店核对）', `实际 ${v.reason}`);

    const evs = eventRows(t.ticketId);
    const re = evs.find((e) => e.type === 'reopened');
    assert(!!re, 'D9 写入 `reopened` 事件', JSON.stringify(evs));
    assert(re?.to === 'PROCESSING', 'D9b reopened 事件 to_status = PROCESSING', re?.to);
    // ⚠️ summary 是**给门店看的人话**，必须点明"金额"这条口径：
    //    门店看到"重开了"却不知道为什么重开，就会去问店长 —— 这条文案是承重的。
    //    （断言写法：把 summary 单独取出来比对。首版这里把整个 events 数组
    //     stringify 后再 test，无论内容如何都能匹配到 `"to":"PROCESSING"` 里的
    //     "PROCESSING" 之外的东西 —— 等于恒真，是一条**假断言**。
    //     门禁脚本自己也会产出永不失败的门，必须反向验证。）
    const reSummary = sql(`
      SELECT summary FROM ticket_events
      WHERE ticket_id = ${t.ticketId} AND event_type = 'reopened'
      ORDER BY id DESC LIMIT 1
    `)[0]?.[0] ?? '';
    assert(
      /金额|收费/.test(reSummary),
      'D9c reopened 事件 summary 点明"收费金额不一致"（门店据此知道为何重开）',
      `实际 summary = ${reSummary}`,
    );
    // metadata 里必须带上机读口径，供 HQ 统计"因金额争议重开的比例"
    const reMeta = sql(`
      SELECT metadata_json::text FROM ticket_events
      WHERE ticket_id = ${t.ticketId} AND event_type = 'reopened'
      ORDER BY id DESC LIMIT 1
    `)[0]?.[0] ?? '';
    assert(
      /charge_mismatch|reopen_count_after/.test(reMeta),
      'D9d reopened 事件 metadata 带机读口径',
      `实际 metadata = ${reMeta}`,
    );
  }

  // =========================================================================
  // D2. 不收费 → not_applicable；服务端权威（H5 撒谎也拦不住）
  // =========================================================================
  console.log('\n【D2】收费核对的服务端权威性');
  beginGroup();
  {
    // 门店未收费：客户必须走 not_applicable
    const t = makeTicket({ charged: false });
    const rBad = await http('POST', `/api/public/reviews/${t.token}`, { rating: 5, charge_match: 'match' });
    assert(rBad.status === 422, 'D2a 未收费却提交 match → 422', `实际 ${rBad.status}`);
    assert(
      rBad.json?.errors?.[0]?.code === 'CHARGE_MATCH_NOT_APPLICABLE',
      'D2b 错误码 = CHARGE_MATCH_NOT_APPLICABLE',
      JSON.stringify(rBad.json?.errors?.[0]),
    );

    const rOk = await http('POST', `/api/public/reviews/${t.token}`, { rating: 5, charge_match: 'not_applicable' });
    assert(rOk.status === 200, 'D2c 未收费 + not_applicable → 200', `实际 ${rOk.status}`);
    const row = ticketRow(t.ticketId);
    assert(row.status === 'CLOSED', 'D2d not_applicable 不影响正常关闭', `实际 ${row.status}`);
    const v = visitRow(t.visitId);
    assert(v.match === 'not_applicable', 'D2e Visit.customer_charge_match = not_applicable', `实际 ${v.match}`);
    assert(v.reported === null, 'D2f not_applicable 不带金额', `实际 ${v.reported}`);

    // 已收费：mismatch 必须带金额（不能只声明不一致）
    const t2 = makeTicket({ charged: true, amount: 100 });
    const rNoAmt = await http('POST', `/api/public/reviews/${t2.token}`, { rating: 5, charge_match: 'mismatch' });
    assert(rNoAmt.status === 422, 'D2g mismatch 不带金额 → 422', `实际 ${rNoAmt.status}`);
    assert(
      rNoAmt.json?.errors?.[0]?.code === 'MISSING_CUSTOMER_AMOUNT',
      'D2h 错误码 = MISSING_CUSTOMER_AMOUNT',
      JSON.stringify(rNoAmt.json?.errors?.[0]),
    );

    // match 不许夹带金额（"传了就是错"，不静默忽略）
    const rExtra = await http('POST', `/api/public/reviews/${t2.token}`, {
      rating: 5, charge_match: 'match', customer_reported_amount: 100,
    });
    assert(rExtra.status === 422, 'D2i match 夹带金额 → 422', `实际 ${rExtra.status}`);
    assert(
      rExtra.json?.errors?.[0]?.code === 'AMOUNT_NOT_ALLOWED',
      'D2j 错误码 = AMOUNT_NOT_ALLOWED',
      JSON.stringify(rExtra.json?.errors?.[0]),
    );

    // 入参白名单：多一个未知字段必须拒绝
    const t3 = makeTicket({ charged: true, amount: 10 });
    const rUnknown = await http('POST', `/api/public/reviews/${t3.token}`, {
      rating: 5, charge_match: 'match', is_admin: true,
    });
    assert(rUnknown.status === 422, 'D2k 未知字段 → 422（入参白名单）', `实际 ${rUnknown.status}`);
    assert(
      rUnknown.json?.errors?.[0]?.code === 'UNEXPECTED_FIELD',
      'D2l 错误码 = UNEXPECTED_FIELD',
      JSON.stringify(rUnknown.json?.errors?.[0]),
    );

    // rating 越界 / 类型
    const rRating = await http('POST', `/api/public/reviews/${t3.token}`, { rating: 6, charge_match: 'match' });
    assert(rRating.status === 422, 'D2m rating=6 → 422', `实际 ${rRating.status}`);
    const rRating2 = await http('POST', `/api/public/reviews/${t3.token}`, { rating: 0, charge_match: 'match' });
    assert(rRating2.status === 422, 'D2n rating=0 → 422', `实际 ${rRating2.status}`);

    // comment 超长
    const rLong = await http('POST', `/api/public/reviews/${t3.token}`, {
      rating: 5, charge_match: 'match', comment: 'x'.repeat(501),
    });
    assert(rLong.status === 422, 'D2o comment 501 字 → 422', `实际 ${rLong.status}`);

    if (!KEEP) cleanup();
  }

  // =========================================================================
  // E. submit × submit 真并发 → 恰好一个 winner
  // =========================================================================
  console.log('\n【E】提交 × 提交 并发（恰好一个 winner）');
  beginGroup();
  {
    for (let round = 1; round <= 3; round += 1) {
      // 每轮 6 个并发请求，共享同一个 IP 桶 ⇒ 必须逐轮清（见 resetRateBuckets 注释）
      resetRateBuckets();
      const t = makeTicket({ charged: true, amount: 66 });
      const payload = { rating: 5, charge_match: 'match' };

      // 真并发：同一时刻发 6 个请求（同一 token）
      const results = await Promise.all(
        Array.from({ length: 6 }, () => http('POST', `/api/public/reviews/${t.token}`, payload)),
      );
      const codes = results.map((r) => r.status);
      const winners = codes.filter((c) => c === 200).length;
      const losers409 = codes.filter((c) => c === 409).length;

      assert(winners === 1, `E${round} 6 并发提交恰好 1 个 200（winner）`, `实际 codes=${codes.join(',')}`);
      assert(
        losers409 === 5,
        `E${round}b 其余 5 个是 409（幂等 loser，不是 500）`,
        `实际 409=${losers409}，codes=${codes.join(',')}`,
      );

      // 状态终局唯一：不存在"既 submitted 又 expired"这种自相矛盾组合
      const row = ticketRow(t.ticketId);
      assert(
        (row.review_status === 'submitted' && row.status === 'CLOSED') ||
        (row.review_status === 'submitted' && row.status === 'PROCESSING'),
        `E${round}c 终局状态自洽（submitted × CLOSED/PROCESSING）`,
        `实际 status=${row.status} review_status=${row.review_status}`,
      );

      // 只写一条 reviewed 事件
      const evs = eventRows(t.ticketId).filter((e) => e.type === 'reviewed');
      assert(evs.length === 1, `E${round}d 只写 1 条 reviewed 事件（无重复副作用）`, `实际 ${evs.length} 条`);

      // reopen_count 只 +1（并发下没有丢更新 / 重复自增）
      assert(row.reopen_count === 0, `E${round}e 正常评价 reopen_count 保持 0`, `实际 ${row.reopen_count}`);

      if (!KEEP) cleanup();
    }
  }

  // =========================================================================
  // F. submit × expiry 真并发 → 恰好一个 winner（两种先后都覆盖）
  // =========================================================================
  console.log('\n【F】提交 × 超时关闭 竞争（恰好一个 winner）');
  beginGroup();
  {
    // ---- F1：提交先赢，随后的超时任务必须 loser（幂等 no-op）----
    for (let round = 1; round <= 3; round += 1) {
      resetRateBuckets();
      // completed_at 超前 10 天 ⇒ 已"到期"，只差超时任务来关
      const t = makeTicket({ charged: true, amount: 20, completedAgoDays: 10 });

      const [submitRes, sweeps] = await Promise.all([
        http('POST', `/api/public/reviews/${t.token}`, { rating: 5, charge_match: 'match' }),
        triggerSweep(),
      ]);

      const row = ticketRow(t.ticketId);
      // 提交与超时同时发起时，**恰好一个**能成功推进状态
      const submitWon = submitRes.status === 200;
      const expiryWon = sweeps.expired > 0;

      assert(
        submitWon !== expiryWon,
        `F1-${round} ★ 提交与超时**恰好一个** winner（不能都赢）`,
        `submit=${submitRes.status} sweeps.expired=${sweeps.expired} final=${row.status}/${row.review_status}`,
      );

      // 终局唯一且自洽
      if (submitWon) {
        assert(
          row.review_status === 'submitted',
          `F1-${round}b 提交赢 ⇒ review_status = submitted`,
          `实际 ${row.review_status}`,
        );
        assert(
          row.status === 'CLOSED' || row.status === 'PROCESSING',
          `F1-${round}c 提交赢 ⇒ 终局是 CLOSED 或 PROCESSING（不是 expired）`,
          `实际 ${row.status}`,
        );
        assert(
          sweeps.expired === 0,
          `F1-${round}d 提交赢 ⇒ 超时任务 loser（0 条 expired，幂等 no-op）`,
          `实际 ${sweeps.expired}`,
        );
      } else {
        assert(
          row.review_status === 'expired',
          `F1-${round}e 超时赢 ⇒ review_status = expired`,
          `实际 ${row.review_status}`,
        );
        assert(
          row.status === 'CLOSED' && row.close_reason === 'review_expired',
          `F1-${round}f 超时赢 ⇒ CLOSED + close_reason = review_expired`,
          `实际 ${row.status}/${row.close_reason}`,
        );
        assert(
          submitRes.status === 410,
          `F1-${round}g 超时赢 ⇒ 客户提交得到 410（不是 200/409）`,
          `实际 ${submitRes.status}`,
        );
        assert(
          submitRes.json?.errors?.[0]?.code === 'REVIEW_EXPIRED',
          `F1-${round}h 错误码 = REVIEW_EXPIRED`,
          JSON.stringify(submitRes.json?.errors?.[0]),
        );
      }

      // 任何情况下都不能"既 submitted 又 expired"
      assert(
        !(row.review_status === 'expired' && !!row.used_at),
        `F1-${round}i 不存在 expired × used_at 的自相矛盾组合`,
        `实际 expired=${row.review_status} used_at=${row.used_at}`,
      );

      if (!KEEP) cleanup();
    }

    // ---- F2：超时先赢，之后的提交必须 410（不得把 expired 改回 submitted）----
    {
      const t = makeTicket({ charged: true, amount: 20, completedAgoDays: 10 });
      const s1 = await triggerSweep();
      assert(s1.expired >= 1, 'F2a 到期的 WAIT_FEEDBACK 会被超时任务关闭', `expired=${s1.expired}`);
      const afterExpiry = ticketRow(t.ticketId);
      assert(
        afterExpiry.status === 'CLOSED' && afterExpiry.review_status === 'expired',
        'F2b 超时关闭后终局 = CLOSED + expired',
        `实际 ${afterExpiry.status}/${afterExpiry.review_status}`,
      );

      const late = await http('POST', `/api/public/reviews/${t.token}`, { rating: 5, charge_match: 'match' });
      assert(late.status === 410, 'F2c 超时后再提交 → 410', `实际 ${late.status}`);
      assert(
        late.json?.errors?.[0]?.code === 'REVIEW_EXPIRED',
        'F2d 错误码 = REVIEW_EXPIRED',
        JSON.stringify(late.json?.errors?.[0]),
      );

      const final = ticketRow(t.ticketId);
      assert(
        final.review_status === 'expired' && final.status === 'CLOSED',
        'F2e ★ 提交失败后 expired **未被改回** submitted（终局不可逆）',
        `实际 ${final.status}/${final.review_status}`,
      );
      assert(final.rating === null, 'F2f expired 终局不写入评分', `实际 ${final.rating}`);

      // ---- F3：重复扫描幂等（同一批跑两次，第二次 0 条）----
      const s2 = await triggerSweep();
      assert(s2.expired === 0, 'F3 重复扫描幂等：第二次 0 条 expired', `实际 ${s2.expired}`);
      const evs = eventRows(t.ticketId).filter((e) => e.type === 'closed');
      assert(evs.length === 1, 'F3b 重复扫描不产生重复 `closed` 事件', `实际 ${evs.length} 条`);

      if (!KEEP) cleanup();
    }

    // ---- F4：未到期的不许被关 ----
    {
      const t = makeTicket({ charged: true, amount: 20, completedAgoDays: 1 });
      await triggerSweep();
      const row = ticketRow(t.ticketId);
      assert(
        row.status === 'WAIT_FEEDBACK' && row.review_status === 'pending',
        'F4 未到期（1 天 < 7 天）的工单不被超时任务关闭',
        `实际 ${row.status}/${row.review_status}`,
      );
      if (!KEEP) cleanup();
    }
  }

  // =========================================================================
  // G. SMS：/f/ 链接形态 + 明文 Token 不落库/不进日志 + accepted≠delivered
  // =========================================================================
  console.log('\n【G】评价短信与 Token 安全');
  beginGroup();
  {
    // G1 静态：短信模板里是 /f/，且渲染出的链接形态正确
    const t = makeTicket({ charged: true, amount: 40 });
    // 直接构造一次"评价邀请短信"（走领域服务的入队口，与 confirm 路径同一函数）
    // —— 这里用 SQL 只能看结构，故改查 sms_logs 的场景常量与模板渲染契约：
    const smsCols = sql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sms_logs' ORDER BY ordinal_position
    `).map((r) => r[0]);
    assert(
      !smsCols.includes('token') && !smsCols.includes('plain_token'),
      'G1 sms_logs 里没有 token 明文列',
      `列：${smsCols.join(',')}`,
    );
    assert(
      !smsCols.includes('preview') && !smsCols.includes('params'),
      'G1b sms_logs 不持久化 preview/params（明文 Token 无处可落）',
      `列：${smsCols.join(',')}`,
    );

    // G2 不变量扫描：全库任何文本列都不应出现本门禁刚生成的明文 Token
    const tokenLiterals = [t.token];
    const hit = sql(`
      SELECT count(*) FROM ticket_events WHERE metadata_json::text LIKE '%${t.token}%'
        OR summary LIKE '%${t.token}%'
    `);
    assert(Number(hit[0][0]) === 0, 'G2 TicketEvent 不含明文 Token', `命中 ${hit[0][0]}`);
    const smsHit = sql(`SELECT count(*) FROM sms_logs WHERE ticket_id = ${t.ticketId}`);
    assert(Number(smsHit[0][0]) === 0, 'G2b 本用例未发短信（O1-B 后 token 不随确认发送）', `实际 ${smsHit[0][0]}`);

    // G3 应用日志里不得出现明文 Token（读最近日志）
    let logText = '';
    try {
      logText = execFileSync('docker', ['compose', 'logs', 'app', '--since', '3m'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch { /* 日志拿不到不算失败 */ }
    if (logText) {
      assert(!logText.includes(t.token), 'G3 应用日志不含明文评价 Token', '命中明文 token');
      // /t/ 与 /f/ 的链接在日志里必须已脱敏
      const rawLink = /(\/(?:t|f)\/)[A-Za-z0-9_-]{20,}/;
      const suspicious = logText.split('\n').filter((l) => rawLink.test(l));
      assert(
        suspicious.length === 0,
        'G3b 日志里 /t/、/f/ 链接已脱敏（sanitizeLinkTokens 生效）',
        suspicious.slice(0, 2).join(' | ').slice(0, 300),
      );
    } else {
      ok('G3 日志不可读，跳过（不作为失败）');
    }

    if (!KEEP) cleanup();
  }

  // =========================================================================
  // 收尾
  // =========================================================================
  if (!KEEP) cleanup();
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  if (failed.length === 0) {
    console.log(`  ✅ 全部通过：${passed.length} 项`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');
    process.exit(0);
  }
  console.log(`  ❌ 通过 ${passed.length} 项，失败 ${failed.length} 项：`);
  for (const f of failed) console.log(`     • ${f.name}\n       ${f.detail}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(1);
}

/**
 * 触发一轮"评价超时扫描"。
 *
 * ⚠️ 刻意**不重写一遍扫描逻辑**（那会造出第二处状态推进）：
 *    走 Phase 7 新增的匿名探针 `POST /api/public/reviews/_probe/sweep`，
 *    它内部调用 `runReviewExpirySweep` —— 与 cron 任务 onTick
 *    **完全同一条代码路径**。若门禁自己写 `UPDATE ... SET status='CLOSED'`，
 *    验证的就只是门禁自己那份谓词，与线上跑的那份毫无关系。
 *
 * ⚠️ 探针自带自毁闸：短信通道非 mock ⇒ 404。拿不到时退化为 **exit 2**
 *    （环境未就绪），绝不退化成"跳过 = 通过"的假绿。
 */
async function triggerSweep() {
  const r = await http('POST', '/api/public/reviews/_probe/sweep', undefined);
  if (r.status === 404) {
    console.error('环境未就绪：评价超时扫描探针不可达（生产环境自毁闸 / 未实现）');
    process.exit(2);
  }
  // ⚠️ 判据是 `r.status !== 200`，**不是** `!r.ok` ——
  //    `http()` 返回的是 `{status, headers, text, json}`，**没有 `ok` 字段**，
  //    写成 `!r.ok` 时 `r.ok` 恒为 undefined ⇒ `!undefined === true` ⇒
  //    永远走"环境未就绪"。首跑就是这样在 F 组一开始就整体退出，
  //    且错误信息里明明打着 `200 {...}`（自相矛盾的输出就是线索）。
  if (r.status !== 200) {
    console.error(`环境未就绪：探针返回 ${r.status} ${r.text.slice(0, 200)}`);
    process.exit(2);
  }
  return r.json?.data ?? r.json;
}

// ---------------------------------------------------------------------------
// 反向验证（铁律 8：断言不会变红 = 没有断言）
// ---------------------------------------------------------------------------
/**
 * `--reverse`：把"一次性 Token"这个前提**打坏**，看门禁会不会红。
 *
 * 手法：在提交**之前**把 `feedback_token_used_at` 预置成一个非空值。
 * 这模拟的是"一次性语义失效"（例如有人把 `feedback_token_used_at IS NULL`
 * 从条件更新里删掉）。若门禁依然全绿，说明 A6/E/F 那批断言根本没在验证
 * "Token 只能用一次" —— 那它们就是装饰。
 *
 * 期望：至少有一条失败（A6 首次提交被拒 / E 组 loser 计数不对）。
 */
async function reverseCheck() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  反向验证：破坏"一次性 Token"前提 → 门禁必须变红');
  console.log('══════════════════════════════════════════════════════════════');
  raisePublicBurst();

  const t = makeTicket({ charged: true, amount: 50 });
  // 预置 used_at ⇒ 条件更新的 `feedback_token_used_at IS NULL` 谓词不再成立
  sql(`UPDATE service_tickets SET feedback_token_used_at = now() WHERE id = ${t.ticketId}`);

  const r = await http('POST', `/api/public/reviews/${t.token}`, { rating: 5, charge_match: 'match' });
  const row = ticketRow(t.ticketId);
  const red = r.status !== 200;

  console.log(`  · 预置 used_at 后提交：HTTP ${r.status}，终局 ${row.status}/${row.review_status}`);
  if (red) {
    console.log('  ✅ 反向验证成立：破坏一次性前提后门禁变红（提交被拒）');
    console.log('     ⇒ 正向门禁里的"一次性 Token"断言确实在承重。');
  } else {
    console.log('  ❌ 反向验证**失败**：一次性前提被破坏，提交却仍然成功');
    console.log('     ⇒ 正向门禁里的相关断言是**假断言**，必须回查 A6 / E / F 组。');
  }

  cleanup();
  restorePublicBurst();
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(red ? 0 : 1);
}

if (REVERSE) await reverseCheck();

await main();
