/**
 * P11-5 · 师傅"**现场服务照片 1～3 张**"强制规则的针对性验收
 *
 *   node scripts/verify-technician-onsite-photos.mjs
 *
 * 覆盖用户列出的 8 条：
 *   ① 0 张 ⇒ 提交拒绝，且工单**不**进入 WAIT_STORE_CONFIRM
 *   ② 1 张 ⇒ 提交成功
 *   ③ 3 张 ⇒ 提交成功
 *   ④ 第 4 张 ⇒ 上传被拒
 *   ⑤ 删除再拍 ⇒ **服务端记录与接口一致**（不是只隐藏前端缩略图）
 *   ⑥ 客户报修时上传的照片**不能充数**
 *   ⑦ 跨 Visit 删除拒绝
 *   ⑧ 门店审核侧能看到这 1～3 张现场照片
 *
 * 复用既有能力：harness 的 twoSessions / smsSwitch / acceptAndDispatch / tokenFromOutbox /
 * technicianUpload / technicianSubmit；PhotoService / VisitService / Token 认证 / 私有存储。
 *
 * ⚠️ 受控节奏（`svc_public` 30r/m）+ 每个单用**唯一手机号**（另有按手机号的 5 次/天频控）。
 *    为节流，**0 张与"客户照片充数"两个场景共用一张单**（后者在前者失败之后再验一次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BASE_URL,
  ROOT,
  http,
  psqlScalar,
  svcGet,
  smsSwitch,
  twoSessions,
  acceptAndDispatch,
  tokenFromOutbox,
  technicianUpload,
  technicianSubmit,
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

const PACE_MS = 2500;
let lastAt = 0;
async function paced(fn) {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  let out = await fn();
  for (let i = 0; i < 2 && out?.status === 429; i += 1) {
    console.log('  · 撞限流，等 25s 窗口…');
    await sleep(25_000);
    out = await fn();
  }
  return out;
}

const rid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
const uniqMobile = () => `139${String(Date.now()).slice(-8)}`;

/** 建一张（可选带客户媒体的）合成工单 */
async function buildTicket({ withCustomerMedia = false } = {}) {
  let mediaSession = null;
  if (withCustomerMedia) {
    const s = await paced(() =>
      http(`${BASE_URL}/api/public/media/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_consent: true }),
      }),
    );
    const sess = s.json?.data;
    const form = new FormData();
    form.append('file', new Blob([IMG]), 'customer.png');
    await paced(() =>
      http(`${BASE_URL}/api/public/media/upload`, {
        method: 'POST',
        headers: { 'X-Media-Session': sess.session_token },
        body: form,
      }),
    );
    mediaSession = { id: sess.session_id, token: sess.session_token };
  }

  const created = await paced(() =>
    http(`${BASE_URL}/api/public/tickets?k=${ENTRY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
      body: JSON.stringify({
        ticket_type: 'repair',
        content: 'P11-5 现场照片验收',
        customer_name: 'P115 照片验收',
        customer_mobile: uniqMobile(),
        ...(mediaSession ? { media_session: mediaSession } : {}),
      }),
    }),
  );
  const no = created.json?.data?.ticket_no;
  if (!no) throw new Error(`建单失败：HTTP ${created.status} ${JSON.stringify(created.json?.errors?.[0] ?? '')}`);
  return { no, id: Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${no}'`)) };
}

/** 删除一张现场照片（对外路径） */
async function deletePhoto(token, ref) {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const res = await fetch(`${BASE_URL}/api/technician/visits/${token}/photos/${ref}/delete`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, payload: json?.data ?? null, errors: json?.errors ?? [] };
}

const onsiteCount = (visitId) =>
  Number(psqlScalar(`SELECT count(*) FROM service_visit_photos WHERE visit_id=${visitId} AND photo_type='onsite'`));
const ticketStatus = (ticketId) => psqlScalar(`SELECT status FROM service_tickets WHERE id=${ticketId}`);

async function dispatchAndToken(ticketId, ticketNo, store, hq, over = {}) {
  await acceptAndDispatch(ticketId, store, over);
  const { token } = await tokenFromOutbox({ sessionToken: hq, ticketNo });
  return token;
}
const visitIdOf = (token) =>
  Number(psqlScalar(`SELECT id FROM service_visits WHERE access_token_hash='${hashOf(token)}'`));

/** ⚠️ 必须在 Node 侧算：本库没装 pgcrypto，SQL 里的 `digest()` 会报错并被 `psqlExec` 吞掉 */
function hashOf(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-5 · 现场服务照片 1～3 张（强制规则验收）');
console.log('══════════════════════════════════════════════════════════════');

const sw = smsSwitch();
try {
  await sw.enable();
  const { store, hq } = await twoSessions();

  // =========================================================================
  // ①②③④⑤ 同一张单上依次做：0 张 → 1 张 → 3 张 → 第 4 张 → 删除再拍
  // =========================================================================
  const t = await buildTicket();
  const token = await dispatchAndToken(t.id, t.no, store, hq);
  const visitId = visitIdOf(token);
  console.log(`\n  合成单 ${t.no}（visit ${visitId}）`);

  console.log('\n── ① 0 张 ⇒ 提交必须被拒 ───────────────────────────────');
  const s0 = await paced(() => technicianSubmit(token, { service_result: 'resolved', is_charged: false, service_note: 'P11-5 验收' }));
  ok(
    '🔴 没有现场照片 ⇒ 提交被拒（PHOTO_REQUIRED）',
    s0.status === 422 && JSON.stringify(s0.json).includes('PHOTO_REQUIRED'),
    `HTTP ${s0.status} ${String(s0.json?.errors?.[0]?.code ?? '')} ${String(s0.json?.errors?.[0]?.message ?? s0.text ?? '').slice(0, 90)}`,
  );
  ok(
    '🔴 且工单**没有**进入 WAIT_STORE_CONFIRM（状态仍是 PROCESSING）',
    ticketStatus(t.id) === 'PROCESSING',
    `status=${ticketStatus(t.id)}`,
  );

  console.log('\n── ② 1 张 ⇒ 提交成功 ───────────────────────────────────');
  const up1 = await paced(() => technicianUpload(token, IMG, { filename: 'onsite1.png', contentType: 'image/png' }));
  ok('上传 1 张现场照片成功', up1.status === 201 || up1.status === 200, `HTTP ${up1.status}`);
  const ref1 = String(up1.json?.data?.photo?.ref ?? '');
  ok('返回照片句柄（22 位）', /^[A-Za-z0-9_-]{22}$/.test(ref1), `ref 长度=${ref1.length}`);
  ok('服务端记录：该 Visit 的**现场**照片 = 1 张', onsiteCount(visitId) === 1, `onsite=${onsiteCount(visitId)}`);

  // =========================================================================
  // ⑥ 客户报修时上传的照片**不能充数**（本单同时有客户媒体）
  // =========================================================================
  const tc = await buildTicket({ withCustomerMedia: true });
  const tokenC = await dispatchAndToken(tc.id, tc.no, store, hq);
  const visitC = visitIdOf(tokenC);
  const customerMediaCount = Number(
    psqlScalar(`SELECT count(*) FROM customer_medias WHERE ticket_id=${tc.id}`),
  );
  console.log(`\n── ⑥ 客户照片不能充数（该单客户媒体 ${customerMediaCount} 份、师傅现场 0 张）────`);
  const sC = await paced(() => technicianSubmit(tokenC, { service_result: 'resolved', is_charged: false, service_note: 'P11-5 充数检测' }));
  ok(
    '🔴 客户已上传报修照片，但师傅**现场**照片为 0 ⇒ 提交仍被拒',
    customerMediaCount >= 1 && onsiteCount(visitC) === 0 && sC.status === 422,
    `客户媒体=${customerMediaCount} onsite=${onsiteCount(visitC)} submit=${sC.status}`,
  );

  // 继续回到主单：3 张 ⇒ 成功
  console.log('\n── ③ 3 张 ⇒ 提交成功 ───────────────────────────────────');
  const up2 = await paced(() => technicianUpload(token, IMG, { filename: 'onsite2.png', contentType: 'image/png' }));
  const up3 = await paced(() => technicianUpload(token, IMG, { filename: 'onsite3.png', contentType: 'image/png' }));
  ok('再传 2 张共 3 张', up2.status < 300 && up3.status < 300 && onsiteCount(visitId) === 3, `onsite=${onsiteCount(visitId)}`);

  console.log('\n── ④ 第 4 张 ⇒ 必须被拒 ────────────────────────────────');
  const up4 = await paced(() => technicianUpload(token, IMG, { filename: 'onsite4.png', contentType: 'image/png' }));
  ok(
    '🔴 第 4 张现场照片被拒（上限 3）',
    up4.status >= 400 && onsiteCount(visitId) === 3,
    `HTTP ${up4.status} ${up4.json?.errors?.[0]?.code ?? ''} · 库内仍 ${onsiteCount(visitId)} 张`,
  );

  console.log('\n── ⑤ 删除再拍：必须与服务端记录一致 ────────────────────');
  const del = await deletePhoto(token, String(up3.json?.data?.photo?.ref ?? ''));
  const afterDel = onsiteCount(visitId);
  ok(
    '🔴 删除 1 张 ⇒ **服务端记录真的少了**（不是只隐藏前端缩略图）',
    del.status === 200 && afterDel === 2,
    `HTTP ${del.status} 库内=${afterDel} 接口返回 photos_count=${del.payload?.photos_count ?? '?'}`,
  );
  ok('接口返回的计数与库内一致', Number(del.payload?.photos_count ?? -1) === afterDel, `接口=${del.payload?.photos_count} 库=${afterDel}`);

  // 删除后重拍 ⇒ 回到 3 张，且旧 ref 已失效
  const reUp = await paced(() => technicianUpload(token, IMG, { filename: 'onsite3b.png', contentType: 'image/png' }));
  ok('删掉后再拍 1 张 ⇒ 回到 3 张', reUp.status < 300 && onsiteCount(visitId) === 3, `onsite=${onsiteCount(visitId)}`);
  const delAgain = await deletePhoto(token, String(up3.json?.data?.photo?.ref ?? ''));
  ok('用**已删掉**的旧 ref 再删 ⇒ 404（记录已不存在）', delAgain.status === 404, `HTTP ${delAgain.status}`);

  // =========================================================================
  // ⑦ 跨 Visit 删除拒绝
  // =========================================================================
  console.log('\n── ⑦ 跨 Visit 删除拒绝 ─────────────────────────────────');
  const crossDel = await deletePhoto(tokenC, String(ref1 ?? ''));
  ok(
    '🔴 用**另一个 Visit** 的 ref 删本 Visit 的照片 ⇒ 404',
    crossDel.status === 404,
    `HTTP ${crossDel.status}${crossDel.errors?.[0]?.code ? ' ' + crossDel.errors[0].code : ''}`,
  );

  // =========================================================================
  // ⑧ 门店审核侧可见
  // =========================================================================
  console.log('\n── ⑧ 门店审核能看到这 1～3 张照片 ──────────────────────');
  // 先把主单提交掉，让它进入 WAIT_STORE_CONFIRM（门店审核态）
  const submit3 = await paced(() => technicianSubmit(token, { service_result: 'resolved', is_charged: false, service_note: 'P11-5 三张现场照片' }));
  ok(
    '3 张现场照片 ⇒ 提交成功',
    submit3.status === 200 || submit3.status === 201,
    `HTTP ${submit3.status} ${String(submit3.json?.errors?.[0]?.code ?? '')} ${String(submit3.json?.errors?.[0]?.message ?? '').slice(0, 80)}`,
  );
  ok(
    '🔴 提交后工单进入 WAIT_STORE_CONFIRM',
    ticketStatus(t.id) === 'WAIT_STORE_CONFIRM',
    `status=${ticketStatus(t.id)}`,
  );

  const detail = await paced(() => svcGet('visitDetail', visitId, store));
  const detailPhotos = detail.json?.data?.photos ?? detail.json?.data?.visit?.photos ?? null;
  ok(
    '🔴 门店审核接口能读到本次上门的照片（含 ref、类别、数量）',
    detail.status === 200 && Array.isArray(detailPhotos) && detailPhotos.length === 3,
    `HTTP ${detail.status} photos=${Array.isArray(detailPhotos) ? detailPhotos.length : '(无该字段)'}`,
  );
  const afterSubmitDelete = await deletePhoto(token, String(reUp.json?.data?.photo?.ref ?? ''));
  ok(
    '🔴 提交后用旧链接删照片 ⇒ 被拒（Token 已用尽）',
    afterSubmitDelete.status === 401,
    `HTTP ${afterSubmitDelete.status}${afterSubmitDelete.errors?.[0]?.code ? ' ' + afterSubmitDelete.errors[0].code : ''}`,
  );
} finally {
  const r = sw.restore();
  console.log(`\n  · 短信开关恢复：${r.note}`);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  现场照片规则验收：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过');
}
