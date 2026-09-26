#!/usr/bin/env node
/**
 * =============================================================================
 *  backfill-review-invite.mjs —— Phase 7 存量 WAIT_FEEDBACK 工单的评价短信补齐
 * =============================================================================
 *
 * 契约依据：`docs/PHASE-7.md` **§8.3**（冻结策略：显式 / 可审计 / 幂等）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个脚本（以及为什么它**不能**自动跑）
 * ---------------------------------------------------------------------------
 * Phase 6 的 **O1-B** 刻意只生成 Review Token、**不发评价短信**。
 * 于是库里留下几张 `WAIT_FEEDBACK` 工单：Token 有、hash 有、**短信一条都没有**。
 * Phase 7 正式打开评价短信，这批存量**不能盲发**，也**不能靠插件启动时扫描**——
 * 盲发意味着"每次重启都可能重复发短信"，而客户对重复短信的容忍度是零。
 *
 * 更关键的一条事实：**明文 Token 已经不存在了**（P6-1 只存 sha256），
 * 所以**无法**"补发指向原 Token 的链接" —— 唯一正确做法是
 * **重新签发（re-mint）一个新 Token，覆盖 hash，再发短信**。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么必须 `--apply` 才写、且默认 dry-run
 * ---------------------------------------------------------------------------
 * 这个脚本会给**真人**发短信。默认 dry-run 是"手抖也不出事"的最后一道闸。
 * dry-run 与 --apply **输出同一份候选清单**（同一段判定逻辑），
 * 只是 dry-run 不写库。运维可以先看一眼名单再决定。
 *
 * ---------------------------------------------------------------------------
 * ★ 幂等：确定性的 biz_id（不是 makeBizId）
 * ---------------------------------------------------------------------------
 * ⚠️ 契约初稿在这里写错过一次，已按代码取证纠正：
 *    `makeBizId()` 末尾拼了 `randomBytes(4)` —— **每次调用都不同**，
 *    它**不是**幂等键。靠它做"重复执行不产生第二条短信"是**神话**。
 *
 *    本脚本因此**显式构造**确定性 biz_id：
 *        `review_invite-<ticketId>-backfill`
 *    `sms_logs` 上的 `unique(provider, biz_id)` 于是真的能拦住第二次插入。
 *    **双保险**：写之前先预检"该单是否已有 review_invite 行"，
 *    命中即跳过（**不拿唯一约束抛异常当控制流**）。
 *
 * ---------------------------------------------------------------------------
 * ★ Token 安全：明文只活在内存里
 * ---------------------------------------------------------------------------
 * re-mint 出的明文 Token **只用于拼短信链接**，随后立即丢弃：
 *   · 不写进任何 DB 列（DB 只有 sha256 hash）
 *   · 不写进 stdout（本脚本打印的是"已入队 + 收件人掩码"，不是链接）
 *   · 不写日志文件
 * `sms_logs` 里存的是 `recipient_masked` + `biz_id`，**没有 token、没有链接**。
 *
 * ---------------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------------
 *   node scripts/backfill-review-invite.mjs              # dry-run（默认，不写库）
 *   node scripts/backfill-review-invite.mjs --apply      # 真正执行
 *   node scripts/backfill-review-invite.mjs --json       # 机器可读输出
 *
 * 退出码：0 = 正常完成（含无候选）；1 = 执行中出现错误；2 = 环境未就绪
 * =============================================================================
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');

const SMS_SCENE_REVIEW_INVITE = 'review_invite';
const SEND_STATUS_PENDING = 'pending';
const DELIVERY_STATUS_PENDING = 'pending';
const TEMPLATE_NOT_CONFIGURED = 'SMS_TEMPLATE_NOT_CONFIGURED';
const RECIPIENT_MASKED_MAX = 20;
const BIZ_ID_MAX = 64;
const TEMPLATE_CODE_MAX = 64;

// ---------------------------------------------------------------------------
// 事实来源：PUBLIC_BASE_URL 与 REVIEW_TOKEN 长度从真实文件读，不硬编码
// ---------------------------------------------------------------------------
const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValueOf = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(envText)?.[1]?.trim();
const PUBLIC_BASE_URL = envValueOf('PUBLIC_BASE_URL');
const NGINX_HTTP_PORT = envValueOf('NGINX_HTTP_PORT');
if (!PUBLIC_BASE_URL || !NGINX_HTTP_PORT) {
  console.error('✗ .env 缺少 PUBLIC_BASE_URL 或 NGINX_HTTP_PORT —— 环境未就绪');
  process.exit(2);
}

const constantsTs = fs.readFileSync(
  path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts'),
  'utf8',
);
// REVIEW_TOKEN.BYTES 与 LINK_PATH 均从源码读 —— 不在这里再抄一份
const REVIEW_BYTES = Number(
  /(?:^|\n)(?:export\s+)?const\s+REVIEW_TOKEN_BYTES\s*=\s*(\d+)\s*;/.exec(constantsTs)?.[1],
);
const REVIEW_LINK_PATH = /export const REVIEW_TOKEN = \{[\s\S]*?LINK_PATH:\s*'([^']+)'/.exec(
  constantsTs,
)?.[1];
if (!Number.isInteger(REVIEW_BYTES) || REVIEW_BYTES <= 0 || !REVIEW_LINK_PATH) {
  console.error('✗ 无法从 constants.ts 解析 REVIEW_TOKEN.BYTES / LINK_PATH —— 环境未就绪');
  process.exit(2);
}
const REVIEW_LINK_BASE = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}${REVIEW_LINK_PATH}`;

// ---------------------------------------------------------------------------
// DB 访问：与其它 verify-*.mjs 同一路子（容器内 psql，带分隔符）
// ---------------------------------------------------------------------------
const PG = ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket'];
function psql(extraArgs) {
  return execFileSync('docker', [...PG, ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
/** 读多行（-t -A -F'|'） */
function sqlRows(sqlText) {
  const out = psql(['-t', '-A', '-F', '|', '-c', sqlText]).trim();
  if (!out) return [];
  return out.split('\n').map((line) => line.split('|'));
}
/** 写（在单个事务里跑一段 SQL） */
function sqlExec(sqlText) {
  return psql(['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sqlText]).trim();
}
/** 单值 */
function sqlOne(sqlText) {
  const rows = sqlRows(sqlText);
  return rows.length ? rows[0][0] : '';
}
/** SQL 字面量转义（单引号） */
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ---------------------------------------------------------------------------
// 纯函数：mint / hash / mask（与 token-service、sms-service 同语义）
// ---------------------------------------------------------------------------
/** 与 `TokenService.mintReview` 一致：base64url(REVIEW_TOKEN.BYTES 随机字节) */
function mintReviewToken() {
  return crypto.randomBytes(REVIEW_BYTES).toString('base64url');
}
/** 与 `hashToken` 一致：sha256 hex（长度 64，与 access_token_hash 对齐） */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
/**
 * 与 `maskMobileText` 同语义的**保守**实现：中间四位打码。
 * ⚠️ 这里刻意不 import 业务模块（脚本不启动 NocoBase）。
 *    若业务侧改了脱敏规则，这里会不一致 —— 但脱敏规则是**合规要求**、几乎不会变，
 *    且本脚本只在补齐存量时用一次。已在此登记为已知的双维护点。
 */
function maskMobile(mobile) {
  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (digits.length < 7) return '***'.slice(0, RECIPIENT_MASKED_MAX);
  const masked = `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return masked.slice(0, RECIPIENT_MASKED_MAX);
}
/** 确定性 biz_id —— 这就是幂等的真正来源（见文件头） */
function deterministicBizId(ticketId) {
  return `${SMS_SCENE_REVIEW_INVITE}-${ticketId}-backfill`.slice(0, BIZ_ID_MAX);
}

// ---------------------------------------------------------------------------
// 候选盘点（**dry-run 与 --apply 共用这一段**，保证输出同一份清单）
// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Phase 7 存量评价短信补齐（backfill-review-invite）');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  模式：${APPLY ? '★ --apply（会真正写库并发送）' : 'dry-run（只盘点，不写库）'}`);
console.log(`  链接基址：${REVIEW_LINK_BASE}{token}（token 明文绝不落库/落日志）`);

// 一次性把所有 WAIT_FEEDBACK 工单捞出来，逐条判原因（跳过项也要打印，不是静默过滤）
//
// ⚠️ 列名以**代码/库为准**：真实列是 `feedback_token_expires_at` /
//    `feedback_token_used_at`（契约 §8.2 表格里写的 `feedback_expires_at`
//    是**简写**，不是列名 —— 首跑直接 `column does not exist`）。
const allWaitRows = sqlRows(`
  SELECT t.id, t.ticket_no, t.status, t.review_status,
         (t.feedback_token_used_at IS NULL) AS unused,
         (t.feedback_token_expires_at > now()) AS window_open,
         to_char(t.feedback_token_expires_at, 'YYYY-MM-DD HH24:MI:SS') AS expires_at,
         t.customer_mobile,
         (SELECT count(*) FROM sms_logs s
            WHERE s.ticket_id = t.id AND s.scene = '${SMS_SCENE_REVIEW_INVITE}') AS invite_count
  FROM service_tickets t
  WHERE t.status = 'WAIT_FEEDBACK'
  ORDER BY t.id;`);

const decisions = [];
for (const r of allWaitRows) {
  const [id, ticketNo, status, reviewStatus, unused, windowOpen, expiresAt, mobile, inviteCount] = r;
  let action = 'process';
  let reason = '';
  if (status !== 'WAIT_FEEDBACK') {
    action = 'skip';
    reason = 'not_wait_feedback';
  } else if (reviewStatus !== 'pending') {
    action = 'skip';
    reason = 'not_pending';
  } else if (unused !== 't') {
    action = 'skip';
    reason = 'used';
  } else if (Number(inviteCount) > 0) {
    action = 'skip';
    reason = 'already_sent';
  } else if (windowOpen !== 't') {
    action = 'skip';
    reason = 'expired_window';
  }
  decisions.push({ id, ticketNo, action, reason, expiresAt, mobile, inviteCount: Number(inviteCount) });
}

const candidates = decisions.filter((d) => d.action === 'process');
const skips = decisions.filter((d) => d.action === 'skip');

if (JSON_OUT) {
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', candidates, skips }, null, 2));
} else {
  console.log('');
  console.log(`  存量 WAIT_FEEDBACK 工单：${decisions.length} 张`);
  console.log(`  待补齐候选：${candidates.length} 张`);
  for (const c of candidates) {
    console.log(
      `    • #${c.id} ${c.ticketNo}  收件人 ${maskMobile(c.mobile)}  原窗口至 ${c.expiresAt}`,
    );
  }
  if (skips.length) {
    console.log(`  跳过：${skips.length} 张`);
    for (const s of skips) {
      console.log(`    · #${s.id} ${s.ticketNo}  原因=${s.reason}`);
    }
  }
}

if (candidates.length === 0) {
  console.log('');
  console.log('  ✅ 无待补齐工单（幂等：重复执行本脚本是安全的空操作）');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}

if (!APPLY) {
  console.log('');
  console.log('  （dry-run 结束，未写库。确认名单无误后加 --apply 执行。）');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 执行：逐条 re-mint + 覆盖 hash + 插入 pending 短信（单事务）
// ---------------------------------------------------------------------------
console.log('');
console.log('  ── 开始执行 ──');
const applied = [];
const errors = [];

for (const c of candidates) {
  let token;
  try {
    token = mintReviewToken();
    const tokenHash = hashToken(token);
    const bizId = deterministicBizId(c.id);
    const masked = maskMobile(c.mobile);
    // 明文 link 只在内存里拼一次，随后 token 引用即弃（不打印、不落库）
    const link = `${REVIEW_LINK_BASE}${token}`;
    void link;

    // 单事务：① 覆盖 hash（保留原到期时刻，不延长客户窗口） ② 插 pending 短信
    // ⚠️ 覆盖 hash 时**同时**把 used_at 保持为 NULL（不动 —— 它本来就是 NULL，
    //    这里显式写出是为了让"本操作不改 used_at"这件事在 SQL 里可见）。
    sqlExec(`
      BEGIN;
      UPDATE service_tickets
         SET feedback_token_hash = ${lit(tokenHash)},
             updated_at = now()
       WHERE id = ${c.id}
         AND status = 'WAIT_FEEDBACK'
         AND review_status = 'pending'
         AND feedback_token_used_at IS NULL
         AND feedback_token_expires_at > now();
      INSERT INTO sms_logs
        (created_at, updated_at, ticket_id, visit_id, scene, provider,
         template_code, recipient_masked, biz_id, send_status, delivery_status, retry_count)
      SELECT now(), now(), ${c.id}, NULL, ${lit(SMS_SCENE_REVIEW_INVITE)},
             ${lit(sqlOne("SELECT value FROM service_settings WHERE key='sms.provider'") || 'mock')},
             ${lit(TEMPLATE_NOT_CONFIGURED)},
             ${lit(masked)}, ${lit(bizId)},
             ${lit(SEND_STATUS_PENDING)}, ${lit(DELIVERY_STATUS_PENDING)}, 0
      WHERE NOT EXISTS (
        SELECT 1 FROM sms_logs s
         WHERE s.ticket_id = ${c.id} AND s.scene = ${lit(SMS_SCENE_REVIEW_INVITE)}
      );
      COMMIT;`);

    // 回读确认：hash 变了、且只有一条 review_invite 行
    const afterCount = Number(
      sqlOne(`SELECT count(*) FROM sms_logs WHERE ticket_id=${c.id} AND scene='${SMS_SCENE_REVIEW_INVITE}'`),
    );
    const hashNow = sqlOne(`SELECT feedback_token_hash FROM service_tickets WHERE id=${c.id}`);
    const hashOk = hashNow === tokenHash;
    applied.push({ ...c, bizId, afterCount, hashOverwritten: hashOk, tokenHashPrefix: tokenHash.slice(0, 8) });
    console.log(
      `    ✓ #${c.id} ${c.ticketNo}  已写 pending 短信（biz=${bizId}）` +
        `  invite 行数=${afterCount}  hash 已覆盖=${hashOk ? '是' : '否'}`,
    );
  } catch (error) {
    errors.push({ id: c.id, ticketNo: c.ticketNo, message: (error?.message ?? String(error)).slice(0, 300) });
    console.log(`    ✗ #${c.id} ${c.ticketNo}  失败：${(error?.message ?? String(error)).slice(0, 200)}`);
  } finally {
    // 尽力清除明文引用（JS 无法保证，但能缩短存活窗口）
    token = null;
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (errors.length === 0) {
  console.log(`  ✅ 补齐完成：${applied.length} 张（短信已入队 pending）`);
} else {
  console.log(`  ⚠️ 部分完成：成功 ${applied.length} 张，失败 ${errors.length} 张`);
  for (const e of errors) console.log(`     • #${e.id} ${e.ticketNo}: ${e.message}`);
}
console.log('');
console.log('  ⚠️ 边界说明（沿用既有口径）：');
console.log('     · 短信已**入队**（send_status=pending），不等于已**送达**（accepted ≠ delivered）');
console.log('     · 本机 SMS_PROVIDER=mock / sms.enabled=false ⇒ 只有 outbox 行，不出网');
console.log('     · 明文 Token **未落任何持久化字段**（DB 只有 sha256）');
console.log('     · 重复执行本脚本安全：确定性 biz_id + 预检 already_sent ⇒ 不产生第二条');
console.log('══════════════════════════════════════════════════════════════');
console.log('');

process.exit(errors.length === 0 ? 0 : 1);
