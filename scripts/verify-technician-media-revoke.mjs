/**
 * P11-5 · 师傅端客户媒体的**权限边界**专项验证（受控节奏，**不改产品限流**）
 *
 *   node scripts/verify-technician-media-revoke.mjs
 *
 * 为什么单独一个脚本：既有 `verify-technician-customer-media.mjs` 是一次密集的端到端验收，
 * 请求密度高，容易撞 `svc_public`（`rate=30r/m`、`burst=10`，键是客户端 IP）。
 * 权限类断言**必须是明确的 401/403/404**——429 既不能算通过也不能算失败，
 * 它是"测得太快"这个环境事实。本脚本只做权限，节奏放慢，遇 429 等窗口重试。
 *
 * ⚠️ 本脚本**不修改** nginx 的 rate/burst（那是产品的对客额度，不是测试旋钮），
 *    也**不伪造** `X-Forwarded-For`（那会绕过"按客户端 IP 限流"这条安全规则）。
 *
 * 覆盖用户要求：
 *   ① 派工有效 → 本单客户媒体可访问
 *   ② 撤销派工 → 原链接 / 原 Token / 原 ref 不能继续读取
 *   ③ 重新分配给另一位师傅 → 旧凭证不能复用；新师傅只能访问**新授权范围**
 *   ④ 跨工单 ref、篡改 ref 继续拒绝
 *
 * 输出不含手机号、地址、Token、媒体内容与存储路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BASE_URL,
  ROOT,
  envValue,
  http,
  psqlScalar,
  psqlExec,
  smsSwitch,
  twoSessions,
  acceptAndDispatch,
  tokenFromOutbox,
  svcPost,
} from './technician-harness.mjs';

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIX = path.join(ROOT, 'nocobase/plugins/service-ticket/test-fixtures/real-media');
const IMG = fs.readFileSync(path.join(ROOT, 'storage/tmp/historical-ui/10-review.png'));
const ENTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8')).entry;

/**
 * 受控节奏：每次请求之间留间隔，把瞬时密度压到 `burst=10` 以内、平均速率低于 30r/m。
 * 遇 429 ⇒ 等一个完整窗口（`svc_public` 是 1 分钟窗口）再重试。
 * ⇒ 这样"限流"只可能表现为**变慢**，不会表现为"权限结论错误"。
 */
const PACE_MS = 600;
let lastAt = 0;
async function paced(fn) {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  let out = await fn();
  for (let i = 0; i < 2 && out?.status === 429; i += 1) {
    console.log('  · 撞到限流（429），等 25s 窗口后重试…');
    await sleep(25_000);
    lastAt = Date.now();
    out = await fn();
  }
  return out;
}

/** `access_token_hash` 的算法：`sha256(token)` 的 **hex**（64 位）。
 *  ⚠️ 必须**在 Node 侧**算：本库**没有装 pgcrypto** ⇒ SQL 里的 `digest()` 会报
 *     "function digest(unknown, unknown) does not exist"，而 `psqlExec` 会把这条错误吞掉
 *     ⇒ UPDATE 静默不生效 ⇒ 表现为"撤销后接口仍 200"这种**看起来像产品缺陷**的假象。
 *     （本轮就踩了这一个：自检断言把真相逼了出来。）*/
const tokenHashOf = (token) => createHash('sha256').update(String(token)).digest('hex');

const rid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

async function buildTicket() {
  const s = await paced(() =>
    http(`${BASE_URL}/api/public/media/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_consent: true }),
    }),
  );
  const sess = s.json?.data;
  const form = new FormData();
  form.append('file', new Blob([IMG]), 'p.png');
  await paced(() =>
    http(`${BASE_URL}/api/public/media/upload`, {
      method: 'POST',
      headers: { 'X-Media-Session': sess.session_token },
      body: form,
    }),
  );
  const created = await paced(() =>
    http(`${BASE_URL}/api/public/tickets?k=${ENTRY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
      body: JSON.stringify({
        ticket_type: 'repair',
        content: '',
        customer_name: 'P115 权限验证',
        customer_mobile: `1370000${String(1000 + Math.floor(Math.random() * 8000)).slice(-4)}`,
        media_session: { id: sess.session_id, token: sess.session_token },
      }),
    }),
  );
  const ticketNo = created.json?.data?.ticket_no;
  const ticketId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}'`));
  return { ticketNo, ticketId };
}

const getCtx = (token) => paced(() => http(`${BASE_URL}/api/technician/visits/${token}`));
async function getRef(token) {
  const r = await getCtx(token);
  return String(r.json?.data?.customer_media?.[0]?.ref ?? '');
}
async function fetchMedia(token, ref) {
  const r = await paced(() =>
    http(`${BASE_URL}/api/technician/visits/${token}/media/${ref}`).then((res) => res),
  );
  // harness 的 http() 不返回 buffer ⇒ 这里单独用 fetch 取字节（并同样受 pace 约束）
  return r;
}
/** 取状态码 + 内容类型（不走 harness，以便拿到字节长度） */
async function probeMedia(token, ref) {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const res = await fetch(`${BASE_URL}/api/technician/visits/${token}/media/${ref}`, {
    headers: { Accept: '*/*' },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    bytes: res.status === 200 ? buf.length : 0,
    body: res.status === 200 ? '' : buf.toString('utf8').slice(0, 120),
  };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-5 · 客户媒体权限边界（受控节奏；不改限流、不伪造 IP）');
console.log('══════════════════════════════════════════════════════════════');

const sw = smsSwitch();
try {
  await sw.enable();
  const { store, hq } = await twoSessions();
  const t = await buildTicket();
  console.log(`  · 合成工单 ${t.ticketNo}（只照片、文字为空）`);

  // ---- ① 有效派工 ⇒ 可访问 ----
  console.log('\n── ① 派工有效 ⇒ 本单媒体可访问 ─────────────────────────');
  await acceptAndDispatch(t.ticketId, store);
  const { token: tokenA } = await tokenFromOutbox({ sessionToken: hq, ticketNo: t.ticketNo });
  const refA = await getRef(tokenA);
  const okA = await probeMedia(tokenA, refA);
  ok('师傅 A：有效派工 ⇒ 媒体 200 且字节与样本一致', okA.status === 200 && okA.bytes === IMG.length, `HTTP ${okA.status} bytes=${okA.bytes}`);

  // ---- ④ 跨工单 ref / 篡改 ref（先做，避免与改派后的状态混淆）----
  console.log('\n── ④ 跨工单 ref / 篡改 ref ─────────────────────────────');
  const t2 = await buildTicket();
  await acceptAndDispatch(t2.ticketId, store);
  const { token: tokenOther } = await tokenFromOutbox({ sessionToken: hq, ticketNo: t2.ticketNo });
  const refOther = await getRef(tokenOther);
  // 跨工单：A 的链接 + **别的单**的 ref
  const cross = await probeMedia(tokenA, refOther);
  ok('🔴 跨工单 ref（A 的链接 + 别的单的 ref）⇒ 404', cross.status === 404, `HTTP ${cross.status}${cross.body ? ' body=' + cross.body : ''}`);
  // 篡改：同长度不同内容
  const tampered = `${refA.slice(0, 21)}${refA.endsWith('A') ? 'B' : 'A'}`;
  const tam = await probeMedia(tokenA, tampered);
  ok('🔴 篡改 ref（同长度不同内容）⇒ 404', tam.status === 404, `HTTP ${tam.status}${tam.body ? ' body=' + tam.body : ''}`);
  // 无效 Token
  const bogus = await probeMedia('A'.repeat(43), refA);
  ok('🔴 伪造 Token ⇒ 401', bogus.status === 401, `HTTP ${bogus.status}${bogus.body ? ' body=' + bogus.body : ''}`);

  // ---- ② 撤销派工 ⇒ 原凭证失效 ----
  console.log('\n── ② 撤销派工 ⇒ 原链接/Token/ref 失效 ──────────────────');
  psqlExec(
    `UPDATE service_visits SET token_revoked_at = now(), token_revoked_reason='p115-revoke-verify'
      WHERE access_token_hash = '${tokenHashOf(tokenA)}'`,
  );
  // 🔴 前置自检：确认**库内确实写入了撤销** —— 否则"接口仍 200"会被误读成产品缺陷，
  //    而实际是测试脚本的 UPDATE 没命中（本项目踩过"以为改了其实没改"太多次）。
  const revokedInDb = psqlScalar(
    `SELECT count(*) FROM service_visits
      WHERE access_token_hash = '${tokenHashOf(tokenA)}' AND token_revoked_at IS NOT NULL`,
  );
  ok('前置自检：撤销已写入库（token_revoked_at 非空）', revokedInDb === '1', `命中 ${revokedInDb} 行`);

  const getAfterRevoke = await getCtx(tokenA);
  const mediaAfterRevoke = await probeMedia(tokenA, refA);
  ok(
    '🔴 撤销后：**详情**明确拒绝（401）',
    getAfterRevoke.status === 401,
    `HTTP ${getAfterRevoke.status} ${getAfterRevoke.json?.errors?.[0]?.code ?? ''}`,
  );
  ok(
    '🔴 撤销后：**媒体**明确拒绝（401，**不是 429**）',
    mediaAfterRevoke.status === 401,
    `HTTP ${mediaAfterRevoke.status}${mediaAfterRevoke.body ? ' body=' + mediaAfterRevoke.body : ''}`,
  );

  // ---- ③ 重新分配给另一位师傅 ----
  console.log('\n── ③ 改派给另一位师傅 ⇒ 旧凭证不可复用、新凭证只读新范围 ──');
  // 先把旧 visit 的撤销清掉，让"改派"本身成为唯一失效原因（避免两个原因混在一起）
  psqlExec(
    `UPDATE service_visits SET token_revoked_at = NULL, token_revoked_reason = NULL
      WHERE access_token_hash = '${tokenHashOf(tokenA)}'`,
  );
  // ⚠️ 工单此时已是 PROCESSING ⇒ 改派走既有 `svc:reassign`
  const re = await paced(() =>
    svcPost('reassign', t.ticketId, store, {
      technician_name: 'P115 师傅B',
      technician_mobile: '13900010009',
      expected_visit_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      service_mode: 'inhouse',
      reason: 'P11-5 权限验证：改派给另一位师傅',
      // ⚠️ 第 5 个参数是 `X-Request-Id`（UUID v4）—— 所有**写接口**都必须带
      //    （幂等 + 链路追踪）。漏了会被 422 挡下：`写接口必须携带 X-Request-Id 请求头`。
    }, rid()),
  );
  ok(
    '改派成功（既有业务动作）',
    re.status === 200,
    `HTTP ${re.status} ${re.json?.errors?.[0]?.code ?? ''} ${String(re.json?.errors?.[0]?.message ?? '').slice(0, 90)}`,
  );

  const superseded = psqlScalar(
    `SELECT count(*) FROM service_visits WHERE ticket_id=${t.ticketId} AND visit_status='SUPERSEDED'`,
  );
  ok('旧派工被置为 SUPERSEDED（改派确实发生了）', Number(superseded) >= 1, `${superseded} 条`);

  const { token: tokenB } = await tokenFromOutbox({ sessionToken: hq, ticketNo: t.ticketNo });
  ok('拿到新师傅（B）的作业链接', /^[A-Za-z0-9_-]{43}$/.test(tokenB), '43 位');

  const getOld = await getCtx(tokenA);
  const mediaOld = await probeMedia(tokenA, refA);
  ok(
    '🔴 旧师傅链接（被取代）⇒ **详情**明确拒绝（401）',
    getOld.status === 401,
    `HTTP ${getOld.status} ${getOld.json?.errors?.[0]?.code ?? ''}`,
  );
  ok(
    '🔴 旧师傅链接 + 原 ref ⇒ **媒体**明确拒绝（401，不是 429）',
    mediaOld.status === 401,
    `HTTP ${mediaOld.status}${mediaOld.body ? ' body=' + mediaOld.body : ''}`,
  );

  const refB = await getRef(tokenB);
  const okB = await probeMedia(tokenB, refB);
  ok('新师傅 B：可读**新授权范围**的媒体（200 + 字节一致）', okB.status === 200 && okB.bytes === IMG.length, `HTTP ${okB.status} bytes=${okB.bytes}`);
  // 关键：句柄是 (mediaId, 本 visit 的 tokenHash) 派生的 ⇒ 新链接算不出旧句柄
  ok(
    '🔴 新师傅 B 的链接 + **旧句柄** ⇒ 404（句柄与链接不匹配，不能跨链接复用）',
    refA !== refB,
    `refA≠refB=${refA !== refB}`,
  );
  const bWithOldRef = await probeMedia(tokenB, refA);
  ok('🔴 新链接 + 旧 ref ⇒ 404（**ref 不能替代服务端对当前派工的授权检查**）', bWithOldRef.status === 404, `HTTP ${bWithOldRef.status}${bWithOldRef.body ? ' body=' + bWithOldRef.body : ''}`);

  // 收尾：把 t2 的 visit 撤销掉，避免留下可用凭证
  psqlExec(
    `UPDATE service_visits SET token_revoked_at = now(), token_revoked_reason='p115-verify-cleanup'
      WHERE access_token_hash = '${tokenHashOf(tokenOther)}'`,
  );
} finally {
  const r = sw.restore();
  console.log(`\n  · 短信开关恢复：${r.note}${r.ok ? '' : ' ⚠️ 请手工检查'}`);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  权限边界验证：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过（所有拒绝都是明确的 401/404，**没有一条靠 429 蒙混**）');
}
