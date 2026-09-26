#!/usr/bin/env node
/**
 * verify-store-review-write.mjs —— Phase 6 · P6-1 门店**写**接口（I12 confirm / I13 reject）总门禁
 * =============================================================================
 *
 * 覆盖 `docs/PHASE-6-P6-1-CONTRACT.md` §10 的 C1–C26，重点交付用户点名要的三组证据：
 *
 *   ① **事务矩阵**   confirm / reject 成功时，**每一个**受影响字段的 before→after
 *                    （Visit 5 列 + Ticket 6 列 + Event + 幂等 + 短信）
 *   ② **故障回滚**   C23：在「Review Token 已生成、hash+expiry 已写、Event/幂等未写」
 *                    这一刻强制事务失败 ⇒ 七个子项全部无半写 + 五面泄漏扫描
 *   ③ **真并发+幂等** C26：confirm×confirm / confirm×reject / reject×reject 三组
 *                    **Promise.all 真并发**（不是串行模拟）+ 幂等重放 / 跨 Visit /
 *                    跨 scene / 并发同号四条
 *
 * -----------------------------------------------------------------------------
 * 为什么这些断言必须存在（而不是"看代码就知道对"）
 * -----------------------------------------------------------------------------
 * P6-1 的全部风险都集中在"**代码看着对、事务语义已经漂了**"这一类上，
 * 而这一类的共同特征是：**单看任何一层都是自洽的**。
 *
 *   · 事务矩阵 —— 只看 handler 会以为"写了就对了"；真正会漂的是"哪个字段该写、
 *     哪个字段**不该**写"（reject 碰 feedback_* 就是 L4 的越界），只有 before→after
 *     逐字段比对能咬住它。
 *   · 故障回滚 —— 注入点选在"hash 已写、Event 未写"之间，是因为那正是最容易
 *     **半写**的窗口：Token 换了但事件没留痕，客户拿着新链接、系统里查无此事。
 *   · 真并发 —— 串行模拟会掩盖"条件 UPDATE 与唯一索引谁兜底"的分工；
 *     本项目全仓 0 处行锁（契约 §1-F1），并发范式是**条件 UPDATE + 影响行数**，
 *     这条只有在两个请求真的同时在飞时才被检验。
 *
 * -----------------------------------------------------------------------------
 * 反向验证（`--reverse`，铁律 8："断言不会变红 = 没有断言"）
 * -----------------------------------------------------------------------------
 * 以**故意写错的期望**重放同一组事实，要求**每一条都必须变红**。
 * 若某条反向**通过**了，说明对应用断根本没有区分力 —— 那比红灯更糟。
 *
 * ⚠️ 反向模式**仍然完整跑一遍正向**：反向条目依赖正向制造出来的库内事实
 *    （如"已确认的 Visit"、"svc_confirm 的幂等行"）。只跑反向会让这些条目
 *    因为"事实不存在"而**意外成立**，那是假绿的另一种形态。
 *
 * -----------------------------------------------------------------------------
 * 前置 / 副作用 / 退出码
 * -----------------------------------------------------------------------------
 *   · 需要 `.env` 的 `UAT_STORE_A_PASSWORD` / `UAT_STORE_B_PASSWORD` / `UAT_HQ_PASSWORD`
 *     / `UAT_VIEWER_PASSWORD` / `SIGN_SECRET`（先跑 `node scripts/uat-accounts.mjs --create`）
 *   · **自建自删** 12 张一次性工单（都走真实接口，不直接写库造数据），
 *     跑完在 `finally` 里按**自己的 ticket id 精确删除**。
 *   · ⚠️ **故障注入是进程级开关**：本脚本打开后**必须**关掉（内层 finally 关并回验，
 *     外层 finally 再兜一次），否则后续所有 confirm/reject 都会 500
 *     —— 那是"验收设施污染了被测系统"。
 *   · 证据落 `.tmp-verify/store-review-write-<run_id>.json`（**带 run_id**：
 *     本机 Bash 工具有"同一条命令跑两遍"的历史问题，固定文件名会让第二遍覆盖第一遍）。
 *   · 退出码：0 全绿 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  BASE_URL,
  ROOT,
  EnvNotReady,
  assert,
  createScratchTicket,
  acceptAndDispatch,
  cleanupTicket,
  ensureFixtureJpeg,
  envValue,
  http,
  localDateOnly,
  makeChecker,
  psqlScalar,
  psqlRows,
  runMain,
  signIn,
  smsSwitch,
  svcPost,
  tokenFromOutbox,
  twoSessions,
  technicianSubmit,
  technicianUpload,
  errorCodeOf,
  errorMessageOf,
} from './technician-harness.mjs';

const argv = process.argv.slice(2);
const REVERSE = argv.includes('--reverse');
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

const STORE_B_EMAIL = 'uat.store.b@svc.local';
const VIEWER_EMAIL = 'uat.viewer@svc.local';

const { checkAsync, summary, state } = makeChecker({ heading: 'P6-1 门店确认/驳回写接口' });

// ---------------------------------------------------------------------------
// 源码扫描工具
// ---------------------------------------------------------------------------
const SERVER_DIR = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server');

function readSrc(rel) {
  return fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8');
}

/**
 * 剥注释后再扫关键字。
 *
 * ⚠️ 不剥就会出现"注释里写着『不发送评价短信』却被当成发送点"这类假红
 *    （本项目出现过，代价是让人开始不信任断言）。只剥块注释与整行 `//`，
 *    不剥行尾注释（避免把 `http://` 之类切坏）。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walkTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP：I12 / I13 对外路径（经 nginx 两段式 rewrite）
// ---------------------------------------------------------------------------
async function postReview(visitId, token, { action = 'confirm', body = {}, requestId, headers = {} } = {}) {
  return http(`${BASE_URL}/api/svc/visits/${visitId}/${action}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
      ...headers,
    },
    body: JSON.stringify(body ?? {}),
  });
}

const rid = () => crypto.randomUUID();
const codeOf = (r) => errorCodeOf(r);
const replayHeaderOf = (r) => r?.headers?.get?.('x-idempotent-replay') ?? null;

/** C23 故障注入闸门（已登录 + 共享密钥双闸；**只翻进程级开关**） */
async function setFault(enabled, token) {
  const secret = envValue('SIGN_SECRET');
  if (!secret) throw new EnvNotReady('.env 缺 SIGN_SECRET —— 故障注入闸门需要它（契约 C23/C23b）');
  return http(`${BASE_URL}/api/svc:faultInject`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Svc-Diag-Key': secret,
    },
    body: JSON.stringify({ enabled: enabled === true }),
  });
}

// ---------------------------------------------------------------------------
// 库内快照（**逐字段**，不是 SELECT *）
// ---------------------------------------------------------------------------
const NUL = '<NULL>';

function visitState(visitId) {
  const r = psqlRows(
    `SELECT visit_status, store_confirm_status,` +
      ` coalesce(confirmed_charge_amount::text,'${NUL}'),` +
      ` coalesce(store_confirm_note,'${NUL}'),` +
      ` coalesce(store_confirmed_by::text,'${NUL}'),` +
      ` (store_confirmed_at IS NOT NULL)::text,` +
      ` is_charged::text, coalesce(reported_charge_amount::text,'${NUL}')` +
      ` FROM service_visits WHERE id = ${visitId}`,
  )[0];
  if (!r) return null;
  return {
    visit_status: r[0],
    store_confirm_status: r[1],
    confirmed_charge_amount: r[2],
    store_confirm_note: r[3],
    store_confirmed_by: r[4],
    store_confirmed_at_set: r[5] === 'true',
    is_charged: r[6] === 'true',
    reported_charge_amount: r[7],
  };
}

function ticketState(ticketId) {
  const r = psqlRows(
    `SELECT status, coalesce(review_status,'${NUL}'),` +
      ` coalesce(feedback_token_hash,'${NUL}'),` +
      ` coalesce(feedback_visit_id::text,'${NUL}'),` +
      ` (feedback_token_expires_at IS NOT NULL)::text,` +
      ` (feedback_token_used_at IS NOT NULL)::text,` +
      ` (completed_at IS NOT NULL)::text,` +
      ` coalesce(reopen_count::text,'${NUL}')` +
      ` FROM service_tickets WHERE id = ${ticketId}`,
  )[0];
  if (!r) return null;
  return {
    status: r[0],
    review_status: r[1],
    feedback_token_hash: r[2],
    feedback_visit_id: r[3],
    feedback_expires_set: r[4] === 'true',
    feedback_used_set: r[5] === 'true',
    completed_at_set: r[6] === 'true',
    reopen_count: r[7],
  };
}

function eventsOf(ticketId) {
  return psqlRows(
    `SELECT event_type, coalesce(metadata_json::text,'${NUL}') FROM ticket_events` +
      ` WHERE ticket_id = ${ticketId} ORDER BY id`,
  ).map((r) => ({ event_type: r[0], metadata: r[1] }));
}

function idemRows(ticketId, scene) {
  return psqlRows(
    `SELECT id, resource_type, coalesce(resource_id::text,'${NUL}'),` +
      ` coalesce(response_json::text,'${NUL}')` +
      ` FROM idempotency_records WHERE scene = '${scene}'` +
      ` AND idempotency_key LIKE '${ticketId}:%' ORDER BY id`,
  ).map((r) => ({
    id: Number(r[0]),
    resource_type: r[1],
    resource_id: r[2] === NUL ? null : Number(r[2]),
    response_json: r[3] === NUL ? null : r[3],
  }));
}

function smsScenesOf(ticketId) {
  return psqlRows(
    `SELECT scene, count(*)::text FROM sms_logs WHERE ticket_id = ${ticketId} GROUP BY scene ORDER BY scene`,
  ).map((r) => `${r[0]}=${r[1]}`);
}

function countSms(ticketId, scene) {
  return Number(
    psqlScalar(`SELECT count(*) FROM sms_logs WHERE ticket_id = ${ticketId} AND scene = '${scene}'`),
  );
}

function countEvents(ticketId, eventType) {
  return Number(
    psqlScalar(
      `SELECT count(*) FROM ticket_events WHERE ticket_id = ${ticketId}` +
        (eventType ? ` AND event_type = '${eventType}'` : ''),
    ),
  );
}

// ---------------------------------------------------------------------------
// 泄漏扫描（C12 / C13 / §11.6 条 4）
// ---------------------------------------------------------------------------
/**
 * 找"**明文 Review Token**"。
 *
 * 判据不是"看起来像 Token"，而是 **`sha256(候选) === 库里的 feedback_token_hash`** ——
 * 后者是服务端**唯一**留下的东西。这样扫描不会把师傅作业 Token（同为 43 位 base64url）
 * 误判成评价 Token 泄漏：那正是"粗判据永远为真"的翻版
 * （本项目在"公共目录里有没有图片"上吃过这个亏）。
 */
const TOKEN_CANDIDATE = /[A-Za-z0-9_-]{43}/g;
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}
function leakHits(text, hashHex) {
  if (!hashHex || hashHex === NUL) return [];
  const hits = [];
  for (const m of String(text).matchAll(TOKEN_CANDIDATE)) {
    if (sha256Hex(m[0]) === hashHex) hits.push(m[0]);
  }
  return [...new Set(hits)];
}

function appLogsSince(iso) {
  const r = spawnSync('docker', ['logs', 'svc-app', '--since', iso, '--tail', '2000'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const JPEG = { buffer: null };

/**
 * 夹具之间的**节流**。
 *
 * ⚠️ 为什么非睡不可（2026-09-25 实测踩到）：每张夹具要打两次师傅接口
 *    （上传 + 提交），而 nginx 的 `/api/technician/` 挂在 `svc_upload` 区
 *    （**60r/m**、burst=20）。13 张夹具连着造 ≈ 26 次请求打进几十秒，
 *    第 12 张就吃到 HTTP 429 —— 表现为"脚本异常：师傅提交失败"，
 *    排查方向会完全跑偏到提交逻辑上。
 *
 * 这是**被测系统的真实限流**在起作用（不是缺陷），所以正确做法是让步：
 * 每张夹具之间睡 3.2s（≈0.6 次/秒 < 1 次/秒 的额定速率）。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FIXTURE_THROTTLE_MS = 3200;

/** 造一条「师傅已提交、待门店确认」的审核对象（真实接口，不直接写库） */
async function buildFixture({ tag, storeToken, hqToken, charged, amount }) {
  const { ticketId, ticketNo } = await createScratchTicket({
    tag,
    content: `P6-1 ${tag} 门店确认/驳回验收（脚本自建，跑完自删）`,
  });
  await acceptAndDispatch(ticketId, storeToken);

  const { token } = await tokenFromOutbox({ sessionToken: hqToken, ticketNo });
  if (!token) throw new EnvNotReady(`工单 ${ticketNo} 取不到师傅 Token`);

  // submit 要求 ≥1 张照片（PHOTO_REQUIRED）—— P6-1 不关心照片，但门槛必须满足
  await technicianUpload(token, JPEG.buffer, { filename: `p6-1-${tag}.jpg`, photoType: 'onsite' });

  const submit = await technicianSubmit(token, {
    service_result: 'resolved',
    service_note: `P6-1 ${tag} 验收说明（脚本自建）`,
    is_charged: charged === true,
    reported_charge_amount: charged === true ? amount : null,
  });
  assert(submit.status === 200, `师傅提交失败 HTTP ${submit.status} ${errorMessageOf(submit)}`);

  const row = psqlRows(
    `SELECT id, visit_status FROM service_visits WHERE ticket_id = ${ticketId}` +
      ` ORDER BY visit_no DESC LIMIT 1`,
  )[0];
  assert(row && row[1] === 'SUBMITTED', `夹具 ${tag} 的 Visit 应为 SUBMITTED，实际 ${row?.[1]}`);

  await sleep(FIXTURE_THROTTLE_MS); // 见 FIXTURE_THROTTLE_MS 注释：让开 nginx 的师傅接口限流
  return { tag, ticketId, ticketNo, visitId: Number(row[0]) };
}

function matrix(title, rows) {
  const w = Math.max(...rows.map((r) => [...r[0]].length));
  console.log(`\n  ── ${title} ──`);
  for (const [label, before, after] of rows) {
    const pad = ' '.repeat(Math.max(0, w - [...label].length));
    console.log(`     ${label}${pad}  ${before}  →  ${after}`);
  }
}

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  const viewerPassword = envValue('UAT_VIEWER_PASSWORD');
  const storeBPassword = envValue('UAT_STORE_B_PASSWORD');
  if (!storeBPassword) throw new EnvNotReady('.env 缺 UAT_STORE_B_PASSWORD（跨店 404 需要它）');
  if (!viewerPassword) {
    throw new EnvNotReady(
      '.env 缺 UAT_VIEWER_PASSWORD —— 只读角色 403 这条门禁（C3）需要它；' +
        '先跑 node scripts/uat-accounts.mjs --create',
    );
  }

  const health = await http(`${BASE_URL}/api/svc/health`);
  if (health.status !== 200) throw new EnvNotReady(`应用未就绪（/api/svc/health → ${health.status}）`);

  const { store, hq } = await twoSessions();
  const storeB = await signIn(STORE_B_EMAIL, storeBPassword);
  if (!storeB) throw new EnvNotReady(`跨店账号 ${STORE_B_EMAIL} 登录失败`);
  const viewer = await signIn(VIEWER_EMAIL, viewerPassword);
  if (!viewer) throw new EnvNotReady(`只读账号 ${VIEWER_EMAIL} 登录失败`);

  JPEG.buffer = ensureFixtureJpeg();

  const fixtures = [];
  const sms = smsSwitch();
  let faultOn = false;
  /** 首次 confirm 的**真实**响应（C12-a 要扫它） */
  let firstConfirm = null;
  /** reject 事务矩阵的 before 快照 */
  let rejectBefore = null;
  /** C24 用：第二次派工产生的 Visit id */
  let secondVisitOf = null;

  try {
    if (sms.original !== 'true') {
      console.log(`\n【短信开关】临时开启 sms.enabled（原值 "${sms.original}"），跑完恢复 …`);
      await sms.enable();
    }

    console.log('\n【夹具】自建一次性工单（走真实接口；跑完按 ticket id 精确删除）');
    const mk = async (opts) => {
      const f = await buildFixture({ ...opts, storeToken: store, hqToken: hq });
      fixtures.push(f.ticketId);
      console.log(`  · 夹具 ${f.tag}：ticket=${f.ticketNo}(#${f.ticketId}) visit=#${f.visitId}`);
      return f;
    };

    // ⚠️ 每组用例**各自独立**的夹具（契约 C26）：绝不"复用同一 Visit 再改状态复活"
    const A = await mk({ tag: 'A-confirm', charged: true, amount: 268.0 });
    const B = await mk({ tag: 'B-free', charged: false });
    const C = await mk({ tag: 'C-reject', charged: true, amount: 168.0 });
    const D = await mk({ tag: 'D-amount', charged: true, amount: 268.0 });
    const E = await mk({ tag: 'E-cc', charged: true, amount: 88.0 });
    const F = await mk({ tag: 'F-cr', charged: true, amount: 88.0 });
    const G = await mk({ tag: 'G-rr', charged: true, amount: 88.0 });
    const H = await mk({ tag: 'H-replay', charged: true, amount: 88.0 });
    const I = await mk({ tag: 'I-param', charged: true, amount: 128.0 });
    const I2 = await mk({ tag: 'I2-fault', charged: true, amount: 128.0 });
    const J = await mk({ tag: 'J-same', charged: true, amount: 88.0 });
    const L = await mk({ tag: 'L-visit2', charged: true, amount: 168.0 });
    console.log(`  · 共 ${fixtures.length} 张夹具工单（每组用例一张，互不复用）`);

    // ===================================================================
    // C1 / C2
    // ===================================================================
    console.log('\n【C1/C2】接线与 nginx 两段式 rewrite 顺序');
    await checkAsync('C1 插件源码里 handlerSets 含 storeReviewHandlers（与 handlers 同批接入）', async () => {
      const src = stripComments(readSrc('plugin.ts'));
      assert(src.includes('storeReviewHandlers'), 'plugin.ts 未引用 storeReviewHandlers');
      assert(/const handlerSets[\s\S]{0,240}storeReviewHandlers/.test(src), 'storeReviewHandlers 未进入 handlerSets');
      // ⚠️ VISIT_CONFIRM/REJECT 不逐个挂在 actions 里，而是经 AUTHENTICATED_SVC_ACTIONS
      //    的循环从 handlerSets 取（与 ticket/dispatch 等同一机制）。故只断言"白名单 + 循环"，
      //    真实的 action 可达性由 verify-plugin-load 的运行时断言保证。
      assert(src.includes('AUTHENTICATED_SVC_ACTIONS'), 'plugin.ts 未引用 AUTHENTICATED_SVC_ACTIONS');
      assert(/for \(const actionName of AUTHENTICATED_SVC_ACTIONS\)/.test(src), '未看到按白名单装配 handler 的循环');
      return 'handlerSets + AUTHENTICATED_SVC_ACTIONS 同批';
    });

    await checkAsync('C2 nginx 两段式（confirm/reject）排在 I11 单段式之前（配置顺序）', async () => {
      const conf = fs.readFileSync(path.join(ROOT, 'nginx', 'conf.d', 'service.conf'), 'utf8');
      const iConfirm = conf.indexOf('/api/svc/visits/(?<svc_review_visit_id>');
      const iReject = conf.indexOf('/api/svc/visits/(?<svc_review_visit_id2>');
      const iDetail = conf.indexOf('/api/svc/visits/(?<svc_visit_id>');
      assert(iConfirm > 0 && iReject > 0 && iDetail > 0, '未能在 nginx 配置里定位三条 location');
      assert(
        iConfirm < iDetail && iReject < iDetail,
        `顺序错误：confirm@${iConfirm} / reject@${iReject} 必须在 I11@${iDetail} 之前`,
      );
      return `confirm@${iConfirm} < reject@${iReject} < I11@${iDetail}`;
    });

    await checkAsync('C2b POST /api/svc/visits/:id/confirm 真的落到 visitConfirm（不是只读的 I11）', async () => {
      const r = await postReview(A.visitId, store, { action: 'confirm', requestId: rid(), body: { amount: 268.0 } });
      firstConfirm = r;
      assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
      const d = r.json?.data ?? {};
      // 证据 ①：读模型必然带 photos，confirm 响应**没有** photos
      assert(!('photos' in d), 'confirm 响应含 photos ⇒ 打到了 I11 读模型');
      // 证据 ②：只有 confirm 才会产出 STORE_CONFIRMED
      assert(d?.event?.event_type === 'store_confirmed', `event_type=${d?.event?.event_type}`);
      assert(d?.visit?.store_confirm_status === 'confirmed', `store_confirm_status=${d?.visit?.store_confirm_status}`);
      return 'event_type=store_confirmed 且响应无 photos';
    });

    // ===================================================================
    // ① 事务矩阵 —— confirm
    // ===================================================================
    console.log('\n【① 事务矩阵】confirm 成功（夹具 A：is_charged=true，师傅报费 268）');
    const aVisit = visitState(A.visitId);
    const aTicket = ticketState(A.ticketId);
    const aEvents = eventsOf(A.ticketId);
    const aIdem = idemRows(A.ticketId, 'svc_confirm');
    const aSms = smsScenesOf(A.ticketId);

    matrix('confirm 事务矩阵（夹具 A）', [
      ['Visit.visit_status', 'SUBMITTED', aVisit.visit_status],
      ['Visit.store_confirm_status', 'pending', aVisit.store_confirm_status],
      ['Visit.confirmed_charge_amount', NUL, aVisit.confirmed_charge_amount],
      ['Visit.store_confirmed_by', NUL, aVisit.store_confirmed_by],
      ['Visit.store_confirmed_at', '未设置', String(aVisit.store_confirmed_at_set)],
      ['Ticket.status', 'WAIT_STORE_CONFIRM', aTicket.status],
      ['Ticket.review_status', NUL, aTicket.review_status],
      ['Ticket.feedback_token_hash', NUL, `${String(aTicket.feedback_token_hash).slice(0, 12)}…（64 hex）`],
      ['Ticket.feedback_visit_id', NUL, aTicket.feedback_visit_id],
      ['Ticket.feedback_expires_at', '未设置', String(aTicket.feedback_expires_set)],
      ['Ticket.completed_at', '未设置', String(aTicket.completed_at_set)],
      ['Ticket.reopen_count', aTicket.reopen_count, `${aTicket.reopen_count}（不变）`],
      ['TicketEvent', '—', aEvents.map((e) => e.event_type).join(', ')],
      ['idempotency(svc_confirm)', '—', `${aIdem.length} 行 resource_id=${aIdem[0]?.resource_id}`],
      ['SmsLog', '—', aSms.join(', ') || '（无）'],
    ]);

    await checkAsync('T1 confirm 事务矩阵：Visit 侧 5 列（C5 白名单已放行）', async () => {
      assert(aVisit.visit_status === 'CONFIRMED', `visit_status=${aVisit.visit_status}`);
      assert(aVisit.store_confirm_status === 'confirmed', `store_confirm_status=${aVisit.store_confirm_status}`);
      assert(aVisit.confirmed_charge_amount === '268.00', `confirmed_charge_amount=${aVisit.confirmed_charge_amount}`);
      assert(aVisit.store_confirmed_by !== NUL, 'store_confirmed_by 未落（无法追溯谁确认的）');
      assert(aVisit.store_confirmed_at_set === true, 'store_confirmed_at 未落');
      return 'CONFIRMED / confirmed / 268.00 / 操作者与处置时间均已落';
    });

    await checkAsync('T2 confirm 事务矩阵：Ticket 侧 6 列 + 不碰 reopen_count', async () => {
      assert(aTicket.status === 'WAIT_FEEDBACK', `status=${aTicket.status}`);
      assert(aTicket.review_status === 'pending', `review_status=${aTicket.review_status}`);
      assert(/^[0-9a-f]{64}$/.test(aTicket.feedback_token_hash), `hash 形态异常：${aTicket.feedback_token_hash}`);
      assert(aTicket.feedback_visit_id === String(A.visitId), `feedback_visit_id=${aTicket.feedback_visit_id}`);
      assert(aTicket.feedback_expires_set === true, 'feedback_token_expires_at 未落');
      assert(aTicket.completed_at_set === true, 'completed_at 未落');
      assert(Number(aTicket.reopen_count) === 0, `reopen_count=${aTicket.reopen_count}（confirm 不应增加）`);
      return 'WAIT_FEEDBACK / PENDING / hash+visit+expiry / completed_at / reopen_count 未动';
    });

    await checkAsync('T3 confirm 副作用：恰好 1 条 store_confirmed 事件', async () => {
      const n = countEvents(A.ticketId, 'store_confirmed');
      assert(n === 1, `store_confirmed 事件 ${n} 条，应为 1`);
      return '1 条';
    });

    // ---------------------------------------------------------------------
    // T4'（Phase 7 口径）：评价邀约短信**恰好 1 条**，且**不含明文链接**
    // ---------------------------------------------------------------------
    // ⚠️ P6-1 原文是"**0 条**（O1-B）"。Phase 7 解除 O1-B（DEV-88）后，
    //    正确值是"**恰好 1 条**" —— 不是放任（多了就是重复发送），也不是 0（少了就是没发）。
    //    这条断言在 Phase 7 之后**依然承重**：它同时守住"发"与"不重复发"。
    await checkAsync('T4\' Phase 7：confirm 后评价邀约短信**恰好 1 条**（O1-B 已解除，DEV-88）', async () => {
      const n = countSms(A.ticketId, 'review_invite');
      assert(n === 1, `评价邀请短信 ${n} 条，Phase 7 应为恰好 1 条（0 = 没发；>1 = 重复发送）`);
      // 边界：入队 ≠ 送达（accepted ≠ delivered）
      const row = psqlScalar(
        `SELECT send_status || '|' || delivery_status FROM sms_logs WHERE ticket_id = ${A.ticketId} AND scene = 'review_invite' LIMIT 1`,
      );
      assert(row, '找不到 review_invite 行');
      return `1 条（send_status|delivery_status = ${row}；该工单短信：${smsScenesOf(A.ticketId).join(', ') || '无'}）`;
    });

    // ===================================================================
    // C12 / C13 —— 五面泄漏扫描
    // ===================================================================
    console.log('\n【C12/C13】评价 Token 明文五面泄漏扫描（§11.6）');
    const HASH_A = aTicket.feedback_token_hash;

    await checkAsync('C12-a HTTP 响应体不含明文（首次 confirm 的真实响应）', async () => {
      assert(firstConfirm?.status === 200, '拿不到首次 confirm 响应，无法扫描');
      const body = String(firstConfirm.body ?? '');
      // 只查**明文**（sha256 命中库内 hash），不查字段名 —— 字段名 `feedback_token_hash`
      // 是合法的（下发的只是 hash）；契约 C12 禁的是**明文 Token** 出站。
      assert(leakHits(body, HASH_A).length === 0, '响应体含明文（sha256 命中库内 hash）');
      assert(!/\/f\//.test(body), '响应体含评价链接 /f/');
      return `响应体 ${body.length} 字节，无明文 / 无 /f/ 链接`;
    });

    await checkAsync('C12-b TicketEvent.metadata 不含明文（逐条扫描）', async () => {
      for (const e of aEvents) {
        const hits = leakHits(e.metadata, HASH_A);
        assert(hits.length === 0, `事件 ${e.event_type} 的 metadata 泄漏了明文：${hits[0]}`);
      }
      return `${aEvents.length} 条事件全部干净`;
    });

    await checkAsync('C12-c 幂等 stored response 不含明文（response_json）', async () => {
      const rows = idemRows(A.ticketId, 'svc_confirm');
      assert(rows.length >= 1, '没有 svc_confirm 幂等行，无法扫描');
      for (const r of rows) {
        assert(leakHits(r.response_json ?? '', HASH_A).length === 0, `幂等行 #${r.id} 的 response_json 泄漏了明文`);
      }
      return `${rows.length} 行幂等记录全部干净`;
    });

    await checkAsync('C12-d 应用日志不含明文（docker logs，含 error 级）', async () => {
      const logs = appLogsSince(new Date(Date.now() - 180_000).toISOString());
      const hits = leakHits(logs, HASH_A);
      assert(hits.length === 0, `应用日志泄漏了明文：${hits[0]}`);
      return `${logs.length} 字节日志无命中`;
    });

    await checkAsync('C12-e SmsLog 不含明文（且连"含明文的短信"都不存在）', async () => {
      const rows = psqlRows(
        `SELECT id, coalesce(recipient_masked,'') || ' ' || coalesce(error_message,'') || ' ' ||` +
          ` coalesce(provider_request_id,'') || ' ' || coalesce(biz_id,'')` +
          ` FROM sms_logs WHERE ticket_id = ${A.ticketId}`,
      );
      for (const r of rows) {
        assert(leakHits(r[1], HASH_A).length === 0, `sms_logs #${r[0]} 泄漏了明文`);
      }
      return `${rows.length} 条短信记录全部干净`;
    });

    await checkAsync('C13 库内不存在"等于明文"的列（全列扫描 service_tickets / service_visits）', async () => {
      // ⚠️ 不能用 `SELECT *::text`（PG 不支持整行转 text）；改为把**所有列**拼成一个
      //    字符串 blob 再扫。列名动态取自 information_schema，避免手抄漏列。
      const colsOf = (table) =>
        psqlRows(
          `SELECT column_name FROM information_schema.columns` +
            ` WHERE table_name = '${table}' ORDER BY ordinal_position`,
        ).map((r) => r[0]);
      const blobOf = (table, id) => {
        const cols = colsOf(table);
        const exprs = cols.map((c) => `coalesce(${c}::text,'${NUL}')`).join(" || ' ' || ");
        return psqlScalar(`SELECT ${exprs} FROM ${table} WHERE id = ${id}`);
      };
      const blob = `${blobOf('service_tickets', A.ticketId)} ${blobOf('service_visits', A.visitId)}`;
      const hits = leakHits(blob, HASH_A);
      assert(hits.length === 0, `库内出现了等于明文的列值：${hits[0]}`);
      assert(/^[0-9a-f]{64}$/.test(HASH_A), `feedback_token_hash 不是 sha256 hex：${HASH_A}`);
      return 'hash 为 64 hex，且全表无明文';
    });

    await checkAsync('C12 反向：扫描器**认得出**真明文（否则上面 5 条全是恒绿）', async () => {
      const plain = crypto.randomBytes(32).toString('base64url');
      const h = sha256Hex(plain);
      const fake = `[info] [ticket] confirm ok token=${plain} link=/f/${plain}`;
      assert(leakHits(fake, h).length === 1, '扫描器未识别出真明文 ⇒ C12 五条无区分力');
      assert(leakHits(fake, sha256Hex('other')).length === 0, '扫描器对无关 hash 也命中 ⇒ 判据失效');
      return '真明文命中 1 次 / 无关 hash 命中 0 次';
    });

    // ===================================================================
    // C21 / C19' / C18' / C20'（Phase 7 口径，见上方阶段演进说明）
    // ===================================================================
    console.log('\n【C21/C19/C18/C20】结构性门禁（Phase 7 口径：评价短信唯一调用点 / Token 常量独立 / 提交入口存在但受控 / 邀约恰好 1 条）');

    await checkAsync('C21 Review Token 常量独立：长度与字符集由 BYTES **推导**，无字面量 43', async () => {
      const src = readSrc('constants.ts');
      const block = /const REVIEW_TOKEN_BYTES[\s\S]*?LINK_PATH: '\/f\/',/.exec(src);
      assert(block, '未定位 REVIEW_TOKEN 常量块');
      assert(/Math\.ceil\(\(REVIEW_TOKEN_BYTES \* 4\) \/ 3\)/.test(block[0]), 'LENGTH 不是由 BYTES 推导');
      assert(/PATTERN: new RegExp\(.*REVIEW_TOKEN_LENGTH/.test(block[0]), 'PATTERN 不是由 LENGTH 推导');
      // ⚠️ 只扫**剥注释后的代码**：注释里明明白白写着"base64url = 43"作解释（合法），
      //    只有**代码**里硬编码 43 才是漂移（那正是 C21 要防的"改了 BYTES 忘了改长度"）。
      const codeOnly = stripComments(block[0]);
      assert(!/\b43\b/.test(codeOnly), 'REVIEW_TOKEN **代码**里出现了字面量 43（应全由 BYTES 推导）');
      assert(
        /REVIEW_TOKEN_SAME_SHAPE_AS_TECHNICIAN[\s\S]{0,240}REVIEW_TOKEN\.LENGTH === TECHNICIAN_TOKEN\.LENGTH/.test(src),
        '缺少"当前同形"的可断言对象（C21 要求由门禁证明，不靠人脑推定）',
      );
      return 'BYTES→LENGTH→PATTERN 全推导 + 同形断言对象存在';
    });

    // ---------------------------------------------------------------------
    // C19'（Phase 7 口径）：发评价短信的**调用点**必须被限定在 confirmVisit
    // ---------------------------------------------------------------------
    // ⚠️ P6-1 的原文是"全量 server 源码**不存在** REVIEW_INVITE 引用"（O1-B）。
    //    Phase 7 解除了 O1-B（DEV-88），那条断言**必然变红**——它盯的是"没有"，
    //    而 Phase 7 的本职就是"把它做出来"。
    //    依 DEV-87 的教训改成盯**"有没有挂对地方"**，判据有三条（都比我删掉它更有价值）：
    //      ① `REVIEW_INVITE` 的引用**只允许**出现在
    //         `constants.ts`（声明）、`sms-service.ts`（scene 表）、`ticket-service.ts`（唯一发送点）
    //      ② 在 `ticket-service.ts` 里，它只能出现在 `enqueueReviewInvite` 与
    //         **`confirmVisit` 的入队调用**两处 —— 不允许散落在其它方法
    //      ③ `enqueueReviewInvite` 必须**带 transaction 参数**调用（入队进事务，
    //         这是 §8.1 的硬要求；漏了就会变成"业务提交了但通知没入队"）
    await checkAsync('C19\' Phase 7 口径：评价短信发送点**唯一且受控**（只允许 confirmVisit 入队）', async () => {
      const ALLOWED = new Set([
        'constants.ts',
        path.join('services', 'sms-service.ts'),
        path.join('services', 'ticket-service.ts'),
      ]);
      const offenders = [];
      for (const file of walkTs(SERVER_DIR)) {
        const rel = path.relative(SERVER_DIR, file);
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        if (!src.includes('REVIEW_INVITE') && !src.includes("'review_invite'")) continue;
        if (!ALLOWED.has(rel)) offenders.push(rel);
      }
      assert(
        offenders.length === 0,
        `评价短信引用出现在预期之外的文件（Phase 7 只允许 constants / sms-service / ticket-service）：${offenders.join(', ')}`,
      );

      const ticketSrc = stripComments(readSrc(path.join('services', 'ticket-service.ts')));
      // 在 ticket-service 里，REVIEW_INVITE 只允许出现在 enqueueReviewInvite 的定义与 confirmVisit 的调用
      const confirmStart = ticketSrc.indexOf('async confirmVisit(');
      const rejectStart = ticketSrc.indexOf('async rejectVisit(');
      const enqueueStart = ticketSrc.indexOf('async enqueueReviewInvite(');
      assert(
        confirmStart >= 0 && rejectStart >= 0 && enqueueStart >= 0,
        '未定位 confirmVisit / rejectVisit / enqueueReviewInvite',
      );
      const confirmBlock = ticketSrc.slice(confirmStart, rejectStart);
      const rejectBlock = ticketSrc.slice(
        rejectStart,
        ticketSrc.indexOf('async submitReview(', rejectStart),
      );
      const enqueueBlock = ticketSrc.slice(enqueueStart);
      assert(rejectBlock.length > 0, '未定位 rejectVisit 方法体');
      // 把两个合法出现位置**挖掉**，剩下的部分不允许再出现 REVIEW_INVITE
      // （⚠️ enqueueReviewInvite 是文件里最后一个相关方法 ⇒ slice 到 EOF 安全）
      const residue = ticketSrc.replace(confirmBlock, '').replace(enqueueBlock, '');
      assert(
        !residue.includes('REVIEW_INVITE'),
        'REVIEW_INVITE 出现在 confirmVisit / enqueueReviewInvite 之外的方法里（发送点必须唯一）',
      );
      // ③ 入队必须带 transaction（§8.1：入队进事务、发送在提交后）
      assert(
        /await this\.enqueueReviewInvite\([\s\S]{0,600}?transaction,?\s*\)/.test(confirmBlock),
        'confirmVisit 调用 enqueueReviewInvite 时**没有传 transaction** —— 短信入队会跑在业务事务之外',
      );
      // ④ 反向：rejectVisit 绝不发评价短信（L4：与 Review Token 彻底解耦）
      assert(
        !/REVIEW_INVITE|enqueueReviewInvite/.test(rejectBlock),
        'rejectVisit 里出现了评价短信 —— 违反 L4（驳回与 Review Token 彻底解耦）',
      );
      return '引用仅在 3 个合法文件；ticket-service 内唯一发送点 = confirmVisit（带 transaction）';
    });

    await checkAsync('C19\' 反向：把 REVIEW_INVITE 塞进**不允许的文件**时，C19 必须能识别（否则上条恒绿）', async () => {
      // ⚠️ Phase 7 口径变了：C19' 守的是**"引用只许出现在 3 个合法文件"**，
      //    所以反向体也必须打在"非法文件"上 —— 往 visit-service.ts（合法集合之外）
      //    临时追加一行 REVIEW_INVITE 引用，断言扫描器**把它抓出来**，再还原。
      const target = path.join(SERVER_DIR, 'services', 'visit-service.ts');
      const original = fs.readFileSync(target, 'utf8');
      try {
        fs.writeFileSync(target, `${original}\n// C19' 反向注入（应被识别）\nconst _c19Inject = SMS_SCENE.REVIEW_INVITE;\n`, 'utf8');
        const ALLOWED = new Set([
          'constants.ts',
          path.join('services', 'sms-service.ts'),
          path.join('services', 'ticket-service.ts'),
        ]);
        const offenders = [];
        for (const file of walkTs(SERVER_DIR)) {
          const rel = path.relative(SERVER_DIR, file);
          if (ALLOWED.has(rel)) continue;
          if (stripComments(fs.readFileSync(file, 'utf8')).includes('REVIEW_INVITE')) offenders.push(rel);
        }
        assert(
          offenders.length > 0,
          'C19\' 扫描器没能抓出植入到 visit-service.ts 的 REVIEW_INVITE ⇒ 上条断言恒绿、无区分力',
        );
        return `植入体被识别（${offenders.join(', ')}）`;
      } finally {
        fs.writeFileSync(target, original, 'utf8');
      }
    });

    // ---------------------------------------------------------------------
    // C18'（Phase 7 口径）：评价提交入口**存在且受控**；confirm/reject 仍不写 CLOSED
    // ---------------------------------------------------------------------
    // ⚠️ P6-1 原文"无评价提交 handler/路由"是**阶段内停止线**，Phase 7 解除了它。
    //    改盯三件**Phase 7 之后依然成立**的事：
    //      ① 提交入口**只在匿名白名单的既定条目**里放行（publicReview:submit），
    //         不允许出现"顺带放行了别的动作"（白名单是安全边界）
    //      ② `confirmVisit` 仍然只推进到 `WAIT_FEEDBACK`、**不写 CLOSED**
    //         （评价完成才 CLOSED，那是 submitReview 的事）—— **Phase 6 不变式，Phase 7 不变**
    //      ③ `rejectVisit` 仍然只回 `PROCESSING`、**不写 CLOSED**
    await checkAsync('C18\' Phase 7 口径：提交入口受控（白名单精确）+ confirm/reject 仍不写 CLOSED', async () => {
      const src = stripComments(readSrc('constants.ts'));
      const anon = /export const ANONYMOUS_ACTIONS[\s\S]*?\n\];/.exec(src);
      assert(anon, '未定位 ANONYMOUS_ACTIONS');
      // ⚠️ 白名单是 `[resource, action]` **元组数组**（不是 `res:act` 对象）——
      //    首跑用 `publicReview:(\w+)` 去 match 元组，永远 0 命中（假红）。
      //    正确做法：抓出所有资源名为 `PUBLIC_RESOURCE.REVIEW` 的元组，再核对 action。
      const reviewEntries = [
        ...anon[0].matchAll(/\[\s*PUBLIC_RESOURCE\.REVIEW\s*,\s*PUBLIC_ACTION\.(\w+)\s*\]/g),
      ].map((m) => m[1]);
      const KNOWN = new Set(['REVIEW_GET', 'REVIEW_SUBMIT', 'REVIEW_SWEEP_PROBE']);
      const unknown = reviewEntries.filter((e) => !KNOWN.has(e));
      assert(
        unknown.length === 0,
        `匿名白名单里出现了未知的 publicReview 动作：${unknown.join(', ')}`,
      );
      assert(
        reviewEntries.length > 0,
        '匿名白名单里没有 publicReview 条目 —— Phase 7 的评价接口应已放行（否则客户打不开）',
      );
      // 三次：get / submit / sweepProbe 必须**全部**在（少一条就是某条路径打不开）
      for (const need of KNOWN) {
        assert(reviewEntries.includes(need), `匿名白名单缺少 ${need} —— 对应路径客户会 401/404`);
      }

      const ticketSrc = stripComments(readSrc(path.join('services', 'ticket-service.ts')));
      const confirmStart = ticketSrc.indexOf('async confirmVisit(');
      const rejectStart = ticketSrc.indexOf('async rejectVisit(');
      const submitStart = ticketSrc.indexOf('async submitReview(');
      assert(
        confirmStart >= 0 && rejectStart >= 0 && submitStart >= 0,
        '未定位 confirmVisit / rejectVisit / submitReview 方法签名',
      );
      const confirmBlock = ticketSrc.slice(confirmStart, rejectStart);
      const rejectBlock = ticketSrc.slice(rejectStart, submitStart);
      for (const [name, block] of [['confirmVisit', confirmBlock], ['rejectVisit', rejectBlock]]) {
        assert(!/\bCLOSED\b/.test(block), `${name} 出现了 CLOSED 写路径`);
      }
      assert(/status: TICKET_STATUS\.WAIT_FEEDBACK/.test(confirmBlock), 'confirm 未推进到 WAIT_FEEDBACK');
      assert(/status: TICKET_STATUS\.PROCESSING/.test(rejectBlock), 'reject 未回到 PROCESSING');
      // 反向：CLOSED 必须由 submitReview 负责（否则确认完成就等于评价完成了，语义错位）
      const submitBlock = ticketSrc.slice(submitStart);
      assert(/TICKET_STATUS\.CLOSED/.test(submitBlock), 'submitReview 里没有 CLOSED —— 评价完成应该关闭工单');
      return '匿名白名单仅放行已知 3 动作；confirm→WAIT_FEEDBACK / reject→PROCESSING 不写 CLOSED；CLOSED 只由 submitReview 写';
    });

    // ===================================================================
    // C10 / C11 / C24b —— 幂等
    // ===================================================================
    console.log('\n【C10/C11/C24b】幂等重放 / 跨 scene / resource_id 非空');

    await checkAsync('C24b P6-1 幂等记录 resource_id = visitId 且非空（正向）', async () => {
      const rows = idemRows(A.ticketId, 'svc_confirm');
      assert(rows.length === 1, `svc_confirm 幂等行 ${rows.length} 条，应为 1`);
      assert(rows[0].resource_type === 'serviceVisit', `resource_type=${rows[0].resource_type}`);
      assert(rows[0].resource_id === A.visitId, `resource_id=${rows[0].resource_id}，应为 visit ${A.visitId}`);
      const src = stripComments(readSrc(path.join('actions', 'svc', 'store-review.ts')));
      assert(src.includes('visitId,'), 'handler 未传 visitId（不传 ⇒ 悄悄退化成不校验 Visit 维）');
      return `resource_id=${rows[0].resource_id}（= visitId，不是 ticketId）`;
    });

    const replayRid = rid();
    await checkAsync('C10 幂等重放：同 request-id + 同 Visit + 同 scene → 200 + X-Idempotent-Replay', async () => {
      const r1 = await postReview(H.visitId, store, { action: 'confirm', requestId: replayRid, body: { amount: 88.0 } });
      assert(r1.status === 200, `首次 confirm 失败 HTTP ${r1.status} ${errorMessageOf(r1)}`);
      assert(replayHeaderOf(r1) === null, '首次不应带 replay 头');
      const hash1 = ticketState(H.ticketId).feedback_token_hash;

      const r2 = await postReview(H.visitId, store, { action: 'confirm', requestId: replayRid, body: { amount: 88.0 } });
      assert(r2.status === 200, `重放失败 HTTP ${r2.status} ${errorMessageOf(r2)}`);
      assert(replayHeaderOf(r2) === '1', `重放缺少 X-Idempotent-Replay 头（实际 ${replayHeaderOf(r2)}）`);
      assert(
        JSON.stringify(r2.json?.data) === JSON.stringify(r1.json?.data),
        '重放响应体与首次**逐字节**不一致（幂等的定义就是一致）',
      );
      assert(ticketState(H.ticketId).feedback_token_hash === hash1, '重放换了 Token ⇒ 副作用真的又跑了一次');
      assert(countEvents(H.ticketId, 'store_confirmed') === 1, '重放产生了第二条事件');
      assert(idemRows(H.ticketId, 'svc_confirm').length === 1, '重放产生了第二条幂等记录');
      assert(leakHits(String(r2.body), hash1).length === 0, '重放响应体泄漏了明文');
      return '200 + replay 头 + 响应体一致 + Token 哈希不变 + 事件/幂各 1 条';
    });

    await checkAsync('C11 跨 scene 不互串：把 confirm 的 request-id 用到 reject 上**不得**回放', async () => {
      const r = await postReview(H.visitId, store, {
        action: 'reject',
        requestId: replayRid,
        body: { reason: '跨 scene 用例（不应命中 confirm 的幂等行）' },
      });
      assert(r.status === 409, `HTTP ${r.status}，期望 409（scene 不同 ⇒ 不该命中）`);
      assert(codeOf(r) !== 'IDEMPOTENT_REPLAY_UNAVAILABLE', `错误码 ${codeOf(r)} 说明它把 confirm 的记录当成自己的了`);
      return `409 ${codeOf(r)}（业务冲突，不是 replay）`;
    });

    // ===================================================================
    // C3 / C4 / C17
    // ===================================================================
    console.log('\n【C3/C4/C17】鉴权四边界 / 请求号 / 评审对象必须是 Visit id');

    await checkAsync('C3-a 匿名 → 401', async () => {
      const r = await postReview(C.visitId, null, { action: 'confirm', requestId: rid(), body: {} });
      assert(r.status === 401, `HTTP ${r.status}，期望 401`);
      return '401';
    });

    await checkAsync('C3-b 只读角色（viewer）→ 403（写能力缺失，不是 404/200）', async () => {
      const r = await postReview(C.visitId, viewer, { action: 'confirm', requestId: rid(), body: {} });
      assert(r.status === 403, `HTTP ${r.status}，期望 403（实际 ${errorMessageOf(r)}）`);
      const rj = await postReview(C.visitId, viewer, { action: 'reject', requestId: rid(), body: { reason: '只读角色用例' } });
      assert(rj.status === 403, `reject 也应为 403，实际 ${rj.status}`);
      return 'confirm / reject 均 403';
    });

    await checkAsync('C3-c 跨店（门店 B 打门店 A 的 Visit）→ 404，且与"不存在"同形', async () => {
      const cross = await postReview(C.visitId, storeB, { action: 'confirm', requestId: rid(), body: {} });
      assert(cross.status === 404, `HTTP ${cross.status}，期望 404`);
      const ghostId = Number(psqlScalar('SELECT COALESCE(MAX(id),0) FROM service_visits')) + 5000;
      const ghost = await postReview(ghostId, storeB, { action: 'confirm', requestId: rid(), body: {} });
      assert(ghost.status === 404, `幽灵 Visit 应 404，实际 ${ghost.status}`);
      assert(
        JSON.stringify(cross.json) === JSON.stringify(ghost.json),
        `越权与不存在**响应体不同** ⇒ 存在性探测器：\n${cross.body}\n${ghost.body}`,
      );
      return '404 且响应体逐字节相同';
    });

    await checkAsync('C3-d 有写能力的总部账号 → 200（放行按能力+范围，不是"谁都被挡"）', async () => {
      rejectBefore = { visit: visitState(C.visitId), ticket: ticketState(C.ticketId) };
      const r = await postReview(C.visitId, hq, { action: 'reject', requestId: rid(), body: { reason: '总部账号能力校验（C3-d）' } });
      assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
      return '200（总部具备 write_ticket 能力）';
    });

    await checkAsync('C4 缺 X-Request-Id → 422 VALIDATION_FAILED', async () => {
      const r = await postReview(D.visitId, store, { action: 'confirm', body: { amount: 268.0 } });
      assert(r.status === 422, `HTTP ${r.status}，期望 422`);
      assert(codeOf(r) === 'VALIDATION_FAILED', `错误码 ${codeOf(r)}`);
      return '422 VALIDATION_FAILED';
    });

    await checkAsync('C17 评审对象是 **Visit id**（把 ticket id 当路径段 ⇒ 按 Visit 语义 404）', async () => {
      const asVisit = D.ticketId;
      const exists = Number(psqlScalar(`SELECT count(*) FROM service_visits WHERE id = ${asVisit}`));
      assert(exists === 0, `前提被破坏：visit id ${asVisit} 竟然存在（换张夹具或换 id）`);
      const r = await postReview(asVisit, store, { action: 'confirm', requestId: rid(), body: {} });
      assert(r.status === 404, `HTTP ${r.status}，期望 404`);
      assert(codeOf(r) === 'VISIT_NOT_FOUND', `错误码 ${codeOf(r)}`);
      return '404 VISIT_NOT_FOUND（不是"按工单找当前 Visit"的宽容解析）';
    });

    // ===================================================================
    // C6 / C25 / C7
    // ===================================================================
    console.log('\n【C6/C25/C7】金额矩阵（夹具 D：is_charged=true，师傅报费 268）');

    const amountCases = [
      { name: 'C6-a 收费但**缺** amount', body: {}, code: 'MISSING_CONFIRM_AMOUNT' },
      { name: 'C6-b 收费但 amount=0', body: { amount: 0 }, code: 'INVALID_CONFIRM_AMOUNT' },
      { name: 'C6-c 收费但 amount<0', body: { amount: -1 }, code: 'INVALID_CONFIRM_AMOUNT' },
      { name: 'C6-d 超过上限 99999.99', body: { amount: 100000 }, code: 'CONFIRM_AMOUNT_TOO_LARGE' },
      { name: 'C7  改额（268→300）未填 note', body: { amount: 300 }, code: 'MISSING_CONFIRM_NOTE' },
    ];
    for (const c of amountCases) {
      await checkAsync(`${c.name} → 422 ${c.code}`, async () => {
        const r = await postReview(D.visitId, store, { action: 'confirm', requestId: rid(), body: c.body });
        assert(r.status === 422, `HTTP ${r.status}，期望 422（实际 ${errorMessageOf(r)}）`);
        // ⚠️ 逐条断言 code：**不只断状态码** —— 422 也可能来自别的校验
        assert(codeOf(r) === c.code, `错误码 ${codeOf(r)}，期望 ${c.code}`);
        return `422 ${c.code}`;
      });
    }

    await checkAsync('C6-e 上述 5 次 422 **都没有**留下副作用（Visit 仍 SUBMITTED / 无事件 / 无幂等行）', async () => {
      const v = visitState(D.visitId);
      assert(v.visit_status === 'SUBMITTED', `visit_status=${v.visit_status}`);
      assert(v.store_confirm_status === 'pending', `store_confirm_status=${v.store_confirm_status}`);
      assert(ticketState(D.ticketId).status === 'WAIT_STORE_CONFIRM', '工单被推进了');
      assert(countEvents(D.ticketId, 'store_confirmed') === 0, '产生了 store_confirmed 事件');
      assert(idemRows(D.ticketId, 'svc_confirm').length === 0, '产生了幂等行');
      return '5 次拒绝全部零副作用';
    });

    await checkAsync('C6-f 合法金额（= 师傅报费，未改额）→ 200 并落库', async () => {
      const r = await postReview(D.visitId, store, { action: 'confirm', requestId: rid(), body: { amount: 268.0 } });
      assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
      const v = visitState(D.visitId);
      assert(v.visit_status === 'CONFIRMED' && v.confirmed_charge_amount === '268.00', JSON.stringify(v));
      return '200 / CONFIRMED / 268.00';
    });

    // ===================================================================
    // C22 / C25
    // ===================================================================
    console.log('\n【C22/C25】金额语义 L3：不收费 ⇒ NULL（**不是** 0.00）；偷传金额 ⇒ 422');

    await checkAsync('C25 师傅填报「不收费」却偷偷传 amount ⇒ 422 AMOUNT_NOT_ALLOWED（**不是静默忽略**）', async () => {
      const r = await postReview(B.visitId, store, { action: 'confirm', requestId: rid(), body: { amount: 10 } });
      assert(r.status === 422, `HTTP ${r.status}，期望 422（实际 ${errorMessageOf(r)}）`);
      assert(codeOf(r) === 'AMOUNT_NOT_ALLOWED', `错误码 ${codeOf(r)}，期望 AMOUNT_NOT_ALLOWED`);
      return '422 AMOUNT_NOT_ALLOWED';
    });

    await checkAsync('C22 不收费确认成功 ⇒ confirmed_charge_amount = **NULL**（不是 0.00）', async () => {
      const r = await postReview(B.visitId, store, { action: 'confirm', requestId: rid(), body: {} });
      assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
      const v = visitState(B.visitId);
      assert(v.confirmed_charge_amount === NUL, `confirmed_charge_amount=${v.confirmed_charge_amount}，期望 NULL`);
      const isNull = psqlScalar(`SELECT confirmed_charge_amount IS NULL FROM service_visits WHERE id = ${B.visitId}`);
      assert(isNull === 't', `库内 IS NULL 判定为 ${isNull}`);
      return 'NULL（三值语义：NULL=没收费 / 0.00=自相矛盾 / >0=实际收费）';
    });

    // ===================================================================
    // ② 故障回滚 C23 / C23b
    // ===================================================================
    console.log('\n【② 故障回滚】C23：在「hash+expiry 已写、Event/幂等未写」之间强制事务失败');

    await checkAsync('C23b-a 注入闸门：不带密钥 ⇒ 404（对外就是"没有这个接口"）', async () => {
      const r = await http(`${BASE_URL}/api/svc:faultInject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${store}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert(r.status === 404, `HTTP ${r.status}，期望 404（密钥闸失效）`);
      return '404';
    });

    await checkAsync('C23b-b 业务请求参数**一律不认**：带 fault/inject 参数**不得**触发回滚', async () => {
      const r = await postReview(I.visitId, store, {
        action: 'confirm',
        requestId: rid(),
        body: { amount: 128.0, fault: true, inject: 'true', __fault_inject: 1, 'X-Inject': 1 },
      });
      assert(
        r.status === 200,
        `HTTP ${r.status} ${errorMessageOf(r)} —— 说明请求参数**真的**能开启注入（C23b 被破坏）`,
      );
      return '200（请求体里的 fault/inject 被完全忽略）';
    });

    const before2 = {
      visit: visitState(I2.visitId),
      ticket: ticketState(I2.ticketId),
      events: countEvents(I2.ticketId),
      idem: idemRows(I2.ticketId, 'svc_confirm').length,
    };
    let faultResponse = null;

    try {
      await checkAsync('C23-a 注入开启（已登录 + 共享密钥双闸）', async () => {
        const r = await setFault(true, store);
        assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
        assert(r.json?.data?.enabled === true, `响应 ${String(r.body).slice(0, 120)}`);
        faultOn = true;
        return '已开启（进程级）';
      });

      await checkAsync('C23-b 注入生效：confirm 在写 Event/幂等之前失败 ⇒ 5xx（不是 200/409）', async () => {
        faultResponse = await postReview(I2.visitId, store, { action: 'confirm', requestId: rid(), body: { amount: 128.0 } });
        assert(faultResponse.status >= 500, `HTTP ${faultResponse.status}，期望 5xx（注入点未生效？）`);
        return `HTTP ${faultResponse.status} ${codeOf(faultResponse)}`;
      });

      await checkAsync('C23-c 回滚 ①：Visit 未变（仍 SUBMITTED / pending / 金额与处置时间未落）', async () => {
        const now = visitState(I2.visitId);
        assert(now.visit_status === before2.visit.visit_status, `visit_status ${before2.visit.visit_status} → ${now.visit_status}`);
        assert(now.store_confirm_status === before2.visit.store_confirm_status, 'store_confirm_status 变了');
        assert(now.confirmed_charge_amount === before2.visit.confirmed_charge_amount, '金额被写了');
        assert(now.store_confirmed_at_set === before2.visit.store_confirmed_at_set, '处置时间被写了');
        return `visit_status=${now.visit_status}（未变）`;
      });

      await checkAsync('C23-c 回滚 ②：Ticket 未变（仍 WAIT_STORE_CONFIRM）', async () => {
        const now = ticketState(I2.ticketId);
        assert(now.status === before2.ticket.status, `status ${before2.ticket.status} → ${now.status}`);
        assert(now.review_status === before2.ticket.review_status, 'review_status 被写了');
        assert(now.completed_at_set === before2.ticket.completed_at_set, 'completed_at 被写了');
        return `status=${now.status}（未变）`;
      });

      await checkAsync('C23-c 回滚 ③：**Token 字段未半写**（hash / expiry / visit_id 全为 NULL）', async () => {
        const now = ticketState(I2.ticketId);
        assert(now.feedback_token_hash === NUL, `feedback_token_hash=${now.feedback_token_hash} —— 半写！`);
        assert(now.feedback_expires_set === false, 'feedback_token_expires_at 被写了');
        assert(now.feedback_visit_id === NUL, 'feedback_visit_id 被写了');
        return '三个 feedback_* 全为 NULL（无"换了 Token 却没留痕"的半写）';
      });

      await checkAsync('C23-c 回滚 ④：TicketEvent 无新增', async () => {
        const now = countEvents(I2.ticketId);
        assert(now === before2.events, `事件 ${before2.events} → ${now}`);
        assert(countEvents(I2.ticketId, 'store_confirmed') === 0, '出现了 store_confirmed 事件');
        return `${now} 条（未变）`;
      });

      await checkAsync('C23-c 回滚 ⑤：幂等记录无新增（否则下次同号会被"幽灵重放"）', async () => {
        const now = idemRows(I2.ticketId, 'svc_confirm').length;
        assert(now === before2.idem, `幂等行 ${before2.idem} → ${now}`);
        return `${now} 条（未变）`;
      });

      await checkAsync('C23-c 回滚 ⑥：SmsLog 无新增（评价短信恒为 0）', async () => {
        assert(countSms(I2.ticketId, 'review_invite') === 0, '出现了评价短信');
        return '0 条';
      });

      await checkAsync('C23-c 回滚 ⑦：失败响应体**不含**任何 Token/链接字段', async () => {
        const body = String(faultResponse?.body ?? '');
        assert(!/feedback_token|token_hash|\/f\//.test(body), `失败响应体带出了 Token 相关字段：${body.slice(0, 200)}`);
        assert(codeOf(faultResponse) === 'INTERNAL_ERROR', `错误码 ${codeOf(faultResponse)}`);
        return 'INTERNAL_ERROR，响应体无 Token/链接（5xx 不回内部细节）';
      });
    } finally {
      // ⚠️ 必须关掉：它是**进程级**开关，忘了关会污染后续全部 confirm/reject
      const off = await setFault(false, store);
      faultOn = false;
      if (off.status !== 200 || off.json?.data?.enabled !== false) {
        throw new Error(`故障注入未能关闭（HTTP ${off.status} ${String(off.body).slice(0, 160)}）—— 已污染进程，请重启 app`);
      }
      console.log('  · 故障注入已关闭并回验（进程级开关，绝不残留）');
    }

    await checkAsync('C23-d 关掉注入后**同一条** Visit 仍能正常确认（回滚不留残余状态）', async () => {
      const r = await postReview(I2.visitId, store, { action: 'confirm', requestId: rid(), body: { amount: 128.0 } });
      assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
      assert(visitState(I2.visitId).visit_status === 'CONFIRMED', '回滚后无法再确认 ⇒ 事务留下了残余');
      return '200（同一 Visit 在回滚后仍可正常确认）';
    });

    // ===================================================================
    // ③ 真并发 C26 / C9
    // ===================================================================
    console.log('\n【③ 真并发】C26：三组同时发出（Promise.all），每组**恰好一个** winner');

    const concurrencyTable = [];
    const groups = [
      { name: 'confirm×confirm', fx: E, a: 'confirm', b: 'confirm', body: { amount: 88.0 }, bodyB: { amount: 88.0 } },
      {
        name: 'confirm×reject',
        fx: F,
        a: 'confirm',
        b: 'reject',
        body: { amount: 88.0 },
        bodyB: { reason: '并发用例：驳回' },
      },
      {
        name: 'reject×reject',
        fx: G,
        a: 'reject',
        b: 'reject',
        body: { reason: '并发用例：驳回甲' },
        bodyB: { reason: '并发用例：驳回乙' },
      },
    ];

    for (const g of groups) {
      await checkAsync(`C26 ${g.name}：真并发 → 恰好 1 个成功 + 1 个 409（winner 不固定）`, async () => {
        const v0 = visitState(g.fx.visitId);
        assert(v0.visit_status === 'SUBMITTED', `前提破坏：${v0.visit_status}`);

        const [r1, r2] = await Promise.all([
          postReview(g.fx.visitId, store, { action: g.a, requestId: rid(), body: g.body }),
          postReview(g.fx.visitId, store, { action: g.b, requestId: rid(), body: g.bodyB }),
        ]);
        const okCount = [r1, r2].filter((r) => r.status === 200).length;
        const conflict = [r1, r2].filter((r) => r.status === 409);

        assert(okCount === 1, `成功数 ${okCount}，应为 1（r1=${r1.status} r2=${r2.status}）`);
        assert(conflict.length === 1, `409 数 ${conflict.length}，应为 1`);
        assert(
          codeOf(conflict[0]) === 'VISIT_NOT_REVIEWABLE',
          `loser 错误码 ${codeOf(conflict[0])}，期望 VISIT_NOT_REVIEWABLE（` +
            `**业务冲突**，不是 replay —— 契约 L1）`,
        );

        // ⚠️ L1：409 只回安全业务状态字段，绝不把 ORM 对象整只序列化出去。
        //    `traceId` 是 handleError 全局附加的链路追踪字段（每次请求随机），
        //    **不是业务字段**、不构成泄漏 —— 故从断言里剔除后再比三元组。
        const detail = conflict[0].json?.errors?.[0]?.detail ?? {};
        const keys = Object.keys(detail).filter((k) => k !== 'traceId').sort();
        assert(
          JSON.stringify(keys) === JSON.stringify(['store_confirm_status', 'ticket_status', 'visit_status']),
          `409 detail 字段集 ${JSON.stringify(keys)} 不是安全三元组（完整：${JSON.stringify(Object.keys(detail))}）`,
        );

        // winner 是谁**不固定** ⇒ 断言"库终态与 winner 一致"，不写依赖调度顺序的脆弱断言
        const winnerAction = r1.status === 200 ? g.a : g.b;
        const v1 = visitState(g.fx.visitId);
        const t1 = ticketState(g.fx.ticketId);
        if (winnerAction === 'confirm') {
          assert(v1.visit_status === 'CONFIRMED', `winner=confirm 但 visit=${v1.visit_status}`);
          assert(t1.status === 'WAIT_FEEDBACK', `winner=confirm 但 ticket=${t1.status}`);
        } else {
          assert(v1.visit_status === 'REJECTED', `winner=reject 但 visit=${v1.visit_status}`);
          assert(t1.status === 'PROCESSING', `winner=reject 但 ticket=${t1.status}`);
        }
        const storeEvents =
          countEvents(g.fx.ticketId, 'store_confirmed') + countEvents(g.fx.ticketId, 'store_rejected');
        assert(storeEvents === 1, `STORE_* 事件 ${storeEvents} 条，应为 1`);

        const idem = [
          ...idemRows(g.fx.ticketId, 'svc_confirm'),
          ...idemRows(g.fx.ticketId, 'svc_reject'),
        ];
        assert(idem.length === 1, `幂等行 ${idem.length} 条，应为 1（loser 的事务整体回滚）`);
        assert(
          idem[0].resource_id === g.fx.visitId,
          `并发路径幂等 resource_id=${idem[0].resource_id} ≠ visitId（C24b：并发路径同样守 Visit 维）`,
        );
        // ⚠️ Phase 7（DEV-88 解除 O1-B）：评价邀约短信的正确值是
        //    **"confirm 赢 → 恰好 1 条；confirm 输 → 恰好 0 条"**。
        //    P6-1 原文"并发下 0 条"是因为当时根本不发；Phase 7 必须把它改成
        //    "与 winner 一致" —— 这才真的在守"loser 的事务整体回滚、没有半套副作用"。
        const inviteCount = countSms(g.fx.ticketId, 'review_invite');
        const expectedInvite = winnerAction === 'confirm' ? 1 : 0;
        assert(
          inviteCount === expectedInvite,
          `评价邀约短信 ${inviteCount} 条，winner=${winnerAction} 时应为 ${expectedInvite} 条` +
            '（loser 的事务必须整体回滚，不能留下半套副作用）',
        );

        concurrencyTable.push([
          g.name,
          `${r1.status}/${r2.status}`,
          `winner=${winnerAction}`,
          v1.visit_status,
          t1.status,
          `STORE_*=${storeEvents}`,
          `invite=${inviteCount}`,
          `幂等 resource_id=${idem[0].resource_id}`,
        ]);
        return `winner=${winnerAction} / loser 409 VISIT_NOT_REVIEWABLE / 副作用各 1 套（invite=${inviteCount}）`;
      });
    }

    await checkAsync('C26-d 真并发 + **相同** request-id：仍然只有一套副作用（幂等键碰撞路径）', async () => {
      const shared = rid();
      const [r1, r2] = await Promise.all([
        postReview(J.visitId, store, { action: 'confirm', requestId: shared, body: { amount: 88.0 } }),
        postReview(J.visitId, store, { action: 'confirm', requestId: shared, body: { amount: 88.0 } }),
      ]);
      const okCount = [r1, r2].filter((r) => r.status === 200).length;
      assert(okCount === 1, `成功数 ${okCount}，应为 1（${r1.status}/${r2.status}）`);
      const loser = r1.status === 200 ? r2 : r1;
      assert(loser.status === 409, `loser 应 409，实际 ${loser.status}`);
      assert(countEvents(J.ticketId, 'store_confirmed') === 1, 'store_confirmed 事件 ≠ 1');
      const rows = idemRows(J.ticketId, 'svc_confirm');
      assert(rows.length === 1, `幂等行 ${rows.length} 条，应为 1`);
      assert(rows[0].resource_id === J.visitId, `并发同号路径 resource_id=${rows[0].resource_id} ≠ visitId`);
      return `${r1.status}/${r2.status} → 副作用 1 套，resource_id=${rows[0].resource_id}`;
    });

    await checkAsync('C24 幂等 Visit 维冲突：同 request-id 换到**另一条** Visit ⇒ 409 IDEMPOTENT_VISIT_MISMATCH', async () => {
      const reuseRid = rid();
      // ① 先让这条 request-id 真正**产生**一条幂等记录（指向 Visit#1）
      const first = await postReview(L.visitId, store, { action: 'reject', requestId: reuseRid, body: { reason: '第一次处置（C24 前置）' } });
      assert(first.status === 200, `第一次 reject 应成功，实际 ${first.status} ${errorMessageOf(first)}`);
      const rows = idemRows(L.ticketId, 'svc_reject');
      assert(rows.length === 1 && rows[0].resource_id === L.visitId, '幂等记录未指向 Visit#1');
      assert(ticketState(L.ticketId).status === 'PROCESSING', 'reject 后工单应回到 PROCESSING');

      // ② 再派一次工 ⇒ Visit#2 ⇒ 提交 ⇒ 用**同一个** request-id 打它
      const beforeVisit = Number(
        psqlScalar(`SELECT COALESCE(MAX(id),0) FROM service_visits WHERE ticket_id = ${L.ticketId}`),
      );
      const dispatch = await svcPost('dispatch', L.ticketId, store, {
        technician_name: '孙师傅（二次派工）',
        technician_mobile: '13900040004',
        expected_visit_at: localDateOnly(2),
        service_mode: 'manufacturer',
        provider_name: 'P6-1验收厂家',
      }, rid());
      assert(dispatch.status === 200, `二次派工失败 HTTP ${dispatch.status} ${errorMessageOf(dispatch)}`);

      const ticketNoL = psqlScalar(`SELECT ticket_no FROM service_tickets WHERE id = ${L.ticketId}`);
      const { token } = await tokenFromOutbox({ sessionToken: hq, ticketNo: ticketNoL });
      await sleep(FIXTURE_THROTTLE_MS); // 师傅接口走 svc_upload 区（60r/m），二次派工同样要让开
      await technicianUpload(token, JPEG.buffer, { filename: 'p6-1-l2.jpg', photoType: 'onsite' });
      const submit = await technicianSubmit(token, {
        service_result: 'resolved',
        service_note: 'P6-1 C24：二次派工提交',
        is_charged: true,
        reported_charge_amount: 168.0,
      });
      assert(submit.status === 200, `二次提交失败 HTTP ${submit.status} ${errorMessageOf(submit)}`);

      const visit2 = Number(
        psqlScalar(
          `SELECT id FROM service_visits WHERE ticket_id = ${L.ticketId} AND id > ${beforeVisit}` +
            ` ORDER BY id DESC LIMIT 1`,
        ),
      );
      assert(visit2 > 0, '未取到 Visit#2');
      secondVisitOf = visit2;

      const r = await postReview(visit2, store, { action: 'reject', requestId: reuseRid, body: { reason: '跨 Visit 复用 request-id' } });
      assert(r.status === 409, `HTTP ${r.status}，期望 409`);
      assert(
        codeOf(r) === 'IDEMPOTENT_VISIT_MISMATCH',
        `错误码 ${codeOf(r)}，期望 IDEMPOTENT_VISIT_MISMATCH（绝不能把旧 Visit 的结果回放出去）`,
      );
      return `409 IDEMPOTENT_VISIT_MISMATCH（visit#${L.visitId} → visit#${visit2}）`;
    });

    // ===================================================================
    // C8 / C15 / C16
    // ===================================================================
    console.log('\n【C8/C15/C16】reject 语义：必填原因 / 终态 / 照片仍可读 / 不偷偷派工');

    const rejectAfter = { visit: visitState(C.visitId), ticket: ticketState(C.ticketId) };
    if (rejectBefore) {
      matrix('reject 事务矩阵（夹具 C，Visit#1）', [
        ['Visit.visit_status', rejectBefore.visit.visit_status, rejectAfter.visit.visit_status],
        ['Visit.store_confirm_status', rejectBefore.visit.store_confirm_status, rejectAfter.visit.store_confirm_status],
        ['Visit.confirmed_charge_amount', rejectBefore.visit.confirmed_charge_amount, rejectAfter.visit.confirmed_charge_amount],
        ['Ticket.status', rejectBefore.ticket.status, rejectAfter.ticket.status],
        ['Ticket.feedback_token_hash', rejectBefore.ticket.feedback_token_hash, rejectAfter.ticket.feedback_token_hash],
        ['Ticket.feedback_visit_id', rejectBefore.ticket.feedback_visit_id, rejectAfter.ticket.feedback_visit_id],
        ['Ticket.reopen_count', rejectBefore.ticket.reopen_count, `${rejectAfter.ticket.reopen_count}（不变）`],
        ['TicketEvent', '—', eventsOf(C.ticketId).map((e) => e.event_type).join(', ')],
      ]);
    }

    await checkAsync('C15 reject 事务矩阵：Visit 终态 REJECTED、Ticket=PROCESSING、reopen_count 不变', async () => {
      assert(rejectAfter.visit.visit_status === 'REJECTED', `visit_status=${rejectAfter.visit.visit_status}`);
      assert(rejectAfter.visit.store_confirm_status === 'rejected', `store_confirm_status=${rejectAfter.visit.store_confirm_status}`);
      assert(rejectBefore.ticket.status === 'WAIT_STORE_CONFIRM', `前置状态 ${rejectBefore.ticket.status}`);
      assert(rejectAfter.ticket.status === 'PROCESSING', `status=${rejectAfter.ticket.status}`);
      assert(
        rejectAfter.ticket.reopen_count === rejectBefore.ticket.reopen_count,
        `reopen_count ${rejectBefore.ticket.reopen_count} → ${rejectAfter.ticket.reopen_count}（驳回**不是**重开工单）`,
      );
      assert(
        Number(psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id = ${C.ticketId} AND event_type='store_rejected'`)) === 1,
        'store_rejected 事件 ≠ 1',
      );
      return 'REJECTED / PROCESSING / reopen_count 不变 / 1 条事件';
    });

    await checkAsync('C15b reject **不碰** feedback_*（L4：与 Review Token 彻底解耦）', async () => {
      assert(rejectAfter.ticket.feedback_token_hash === NUL, `reject 却写了 feedback_token_hash`);
      assert(rejectAfter.ticket.feedback_visit_id === NUL, 'reject 却写了 feedback_visit_id');
      assert(rejectAfter.ticket.feedback_expires_set === false, 'reject 却写了 feedback_token_expires_at');
      return '三个 feedback_* 全为 NULL';
    });

    await checkAsync('C15c reject 后照片仍全量可读（I14 未被写动作破坏）', async () => {
      const photoId = Number(
        psqlScalar(
          `SELECT p.id FROM service_visit_photos p JOIN service_visits v ON v.id = p.visit_id` +
            ` WHERE v.ticket_id = ${C.ticketId} ORDER BY p.id LIMIT 1`,
        ),
      );
      assert(photoId > 0, '夹具 C 没有照片');
      const r = await http(`${BASE_URL}/api/svc/photos/${photoId}`, { headers: { Authorization: `Bearer ${store}` } });
      assert(r.status === 200, `驳回后照片应仍 200，实际 ${r.status}`);
      return `photo #${photoId} → 200`;
    });

    await checkAsync('C8 reject 缺/空白 reason → 422 MISSING_REJECT_REASON（夹具 L 的 Visit#2）', async () => {
      const target = secondVisitOf ?? L.visitId;
      const r1 = await postReview(target, store, { action: 'reject', requestId: rid(), body: {} });
      assert(r1.status === 422 && codeOf(r1) === 'MISSING_REJECT_REASON', `HTTP ${r1.status} ${codeOf(r1)}`);
      const r2 = await postReview(target, store, { action: 'reject', requestId: rid(), body: { reason: '   ' } });
      assert(r2.status === 422 && codeOf(r2) === 'MISSING_REJECT_REASON', `空白 reason：HTTP ${r2.status} ${codeOf(r2)}`);
      return '缺与空白均 422 MISSING_REJECT_REASON';
    });

    await checkAsync('C16 reject 后再 `reassign` ⇒ 明确的业务拒绝码（**不是 500**）', async () => {
      const r = await svcPost('reassign', G.ticketId, store, {
        technician_name: '周师傅（改派）',
        technician_mobile: '13900050005',
        expected_visit_at: localDateOnly(3),
        service_mode: 'manufacturer',
        provider_name: 'P6-1验收厂家',
        reason: 'C16：驳回后不应能改派',
      }, rid());
      assert(r.status < 500, `HTTP ${r.status} —— 500 意味着"没人处理这个组合"`);
      // C16 已按实现修正契约（2026-09-25）：NO_ACTIVE_VISIT = 资源状态不允许 reassign，
      // HTTP 409（状态冲突）比 422（参数问题）更合适。
      assert(r.status === 409, `HTTP ${r.status}，期望 409 NO_ACTIVE_VISIT`);
      assert(codeOf(r) === 'NO_ACTIVE_VISIT', `错误码 ${codeOf(r)}，期望 NO_ACTIVE_VISIT`);
      return `409 ${codeOf(r)}（明确拒绝，不是 500）`;
    });

    // ===================================================================
    // 反向验证
    // ===================================================================
    if (REVERSE) {
      console.log('\n【反向验证】以下每条都**必须失败**；若某条通过，说明对应用断没有区分力');
      const reds = [
        {
          name: 'R-C2 反向：断言"nginx 里 I11 单段式排在 confirm 之前"',
          claim: 'C2 的顺序断言有区分力',
          fn: async () => {
            const conf = fs.readFileSync(path.join(ROOT, 'nginx', 'conf.d', 'service.conf'), 'utf8');
            const iConfirm = conf.indexOf('/api/svc/visits/(?<svc_review_visit_id>');
            const iDetail = conf.indexOf('/api/svc/visits/(?<svc_visit_id>');
            assert(iDetail < iConfirm, '反向期望未成立：实际 confirm 在前 —— 这正是 C2 的区分力');
          },
        },
        {
          name: 'R-C22 反向：断言"不收费确认后 confirmed_charge_amount = 0.00"',
          claim: 'C22 的 NULL≠0.00 有区分力',
          fn: async () => {
            const raw = psqlScalar(
              `SELECT coalesce(confirmed_charge_amount::text,'<NULL>') FROM service_visits WHERE id = ${B.visitId}`,
            );
            assert(raw === '0.00', `反向期望未成立：实际 ${raw} —— 这正是 C22 的区分力`);
          },
        },
        {
          name: 'R-T4 反向：断言"confirm 之后评价短信 = 0 条"',
          claim: 'C20\'（Phase 7：恰好 1 条）有区分力',
          fn: async () => {
            const n = countSms(A.ticketId, 'review_invite');
            assert(n === 0, `反向期望未成立：实际 ${n} 条 —— 这正是 C20' 的区分力`);
          },
        },
        {
          name: 'R-C24b 反向：断言"confirm 幂等行 resource_id = ticketId"',
          claim: 'C24b 的 resource_id=visitId 有区分力',
          fn: async () => {
            const rows = idemRows(A.ticketId, 'svc_confirm');
            assert(rows[0]?.resource_id === A.ticketId, `反向期望未成立：实际 ${rows[0]?.resource_id} —— 这正是 C24b 的区分力`);
          },
        },
        {
          name: 'R-C3b 反向：断言"只读角色能确认（200）"',
          claim: 'C3-b 的 403 有区分力',
          fn: async () => {
            const r = await postReview(secondVisitOf ?? C.visitId, viewer, {
              action: 'confirm',
              requestId: rid(),
              body: { amount: 88 },
            });
            assert(r.status === 200, `反向期望未成立：实际 ${r.status} —— 这正是 C3-b 的区分力`);
          },
        },
        {
          name: 'R-C3c 反向：断言"跨店 404 与不存在 404 的响应体**不同**"',
          claim: 'C3-c 的"同形"有区分力',
          fn: async () => {
            const cross = await postReview(C.visitId, storeB, { action: 'confirm', requestId: rid(), body: {} });
            const ghostId = Number(psqlScalar('SELECT COALESCE(MAX(id),0) FROM service_visits')) + 5000;
            const ghost = await postReview(ghostId, storeB, { action: 'confirm', requestId: rid(), body: {} });
            assert(cross.body !== ghost.body, '反向期望未成立：实际两者相同 —— 这正是 C3-c 的区分力');
          },
        },
        {
          name: 'R-C25 反向：断言"不收费却传 amount 会被静默接受（200）"',
          claim: 'C25 的"拒绝而非忽略"有区分力',
          fn: async () => {
            const r = await postReview(B.visitId, store, { action: 'confirm', requestId: rid(), body: { amount: 1 } });
            assert(r.status === 200, `反向期望未成立：实际 ${r.status} —— 这正是 C25 的区分力`);
          },
        },
        {
          name: 'R-C12c 反向：断言"幂等 response_json 里**含**明文 Token"',
          claim: 'C12-c 的"无泄漏"有区分力',
          fn: async () => {
            const rows = idemRows(A.ticketId, 'svc_confirm');
            assert(
              leakHits(rows[0]?.response_json ?? '', HASH_A).length > 0,
              '反向期望未成立：实际不含 —— 这正是 C12-c 的区分力',
            );
          },
        },
        {
          name: 'R-C23 反向：断言"注入失败后 feedback_token_hash 已写入"',
          claim: 'C23 回滚③的"Token 未半写"有区分力',
          fn: async () => {
            // I2 在 C23-d 已被正常确认 ⇒ 此时 hash 非 NULL；反向期望是"回滚当时也写了"
            // 用**另一条**已确认工单 A 作对照：若断言"已确认的工单 hash 为 NULL"必红
            const t = ticketState(A.ticketId);
            assert(t.feedback_token_hash === NUL, '反向期望未成立：A 已确认，hash 非 NULL —— 这正是 C23 回滚③的区分力');
          },
        },
      ];

      for (const item of reds) {
        await checkAsync(item.name, async () => {
          let wentRed = false;
          try {
            await item.fn();
          } catch {
            wentRed = true;
          }
          assert(wentRed, `⚠️ 反向期望竟然**成立**了 —— 说明「${item.claim}」不成立（对应用断没有区分力）`);
          return `已按预期变红（${item.claim}）`;
        });
      }
    }

    if (concurrencyTable.length) {
      console.log('\n  ── ③ 真并发总表 ──');
      for (const row of concurrencyTable) console.log(`     ${row.join('  |  ')}`);
    }
  } finally {
    // 外层兜底：故障注入是**进程级**开关，任何逃逸都必须关掉
    if (faultOn) {
      try {
        const off = await setFault(false, store);
        if (off.status === 200 && off.json?.data?.enabled === false) {
          console.log('  · 外层兜底：故障注入已关闭');
        } else {
          console.log(`  ⚠️ 外层兜底未能关闭故障注入（HTTP ${off.status}）—— 请重启 app`);
        }
      } catch (error) {
        console.log(`  ⚠️ 外层兜底关故障注入失败：${error?.message ?? error}`);
      }
    }
    for (const id of fixtures) {
      try {
        const r = cleanupTicket(id);
        console.log(`  · 已清理 ticket #${id}（删文件 ${r.filesDeleted} / 附件 ${r.attachmentsDeleted}）`);
      } catch (error) {
        console.log(`  ⚠️ 清理 ticket #${id} 失败：${error?.message ?? String(error)}`);
      }
    }
    const restored = sms.restore();
    if (!restored.ok) console.log(`  ⚠️ sms.enabled 恢复失败：${restored.note}`);
  }

  summary();

  const evidenceDir = path.join(ROOT, '.tmp-verify');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `store-review-write-${RUN_ID}.json`);
  fs.writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        run_id: RUN_ID,
        mode: REVERSE ? 'reverse' : 'normal',
        at: new Date().toISOString(),
        base_url: BASE_URL,
        passed: state.passed,
        failed: state.failures.length,
        failures: state.failures,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`  证据：${path.relative(ROOT, evidencePath)}`);
  console.log(`  共 ${state.passed} 通过 / ${state.failures.length} 失败\n`);

  if (state.failures.length > 0) process.exitCode = 1;
}

runMain({
  name: REVERSE
    ? 'verify-store-review-write（反向验证：每条都必须变红）'
    : 'verify-store-review-write（P6-1 门店确认/驳回写接口：C1–C26；C18/C19/C20/C26 的短信相关断言已在 Phase 7 按 DEV-88 改口径）',
  main,
  cleanup: () => {},
});
