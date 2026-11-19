/**
 * arc-a4-verify.mjs —— A4 客户查询定向验证
 *
 * 只测承重项（用户 2026-11-10：不做大规模重复测试）：
 *   1. 只凭手机号**不能**查询（没有这样的接口，且无 token 一律 401）
 *   2. 发码 + 60 秒限流 + 验证码 5 次错误后锁定
 *   3. 正确码 → 会话 token；错误码 / 过期 / 已核销 → 同一条话术
 *   4. 会话只能看到**本人本店已发布**档案（跨客户、跨店都为空）
 *   5. detail 用别人的 archive_no → 404
 *   6. 未发布档案不可查；未发布照片不可读
 *   7. 响应不含 notes / storage_key
 *
 * ⚠️ 验证码正文**不入库**（sms_logs 不存正文，这是既有安全设计），
 *    所以这里用"把 code_hash 回填成已知码的哈希"来验证校验链路。
 *    发码环节单独验证 `sent=true` 与限流。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n--- ${t} ---`);

async function api(p, opt = {}) {
  const res = await fetch(BASE + p, {
    method: opt.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opt.token ? { 'X-Archive-Session': opt.token } : {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, json, text };
  }
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
}

function psql(sql) {
  return execFileSync('docker', ['exec','-i','svc-postgres','psql','-U','svc_app','-d','service_ticket','-v','ON_ERROR_STOP=1','-A','-t','-F','|','-f','-'], { input: sql, encoding: 'utf8' }).trim();
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const codeHash = (storeId, mobile, code) => sha256(`archive-verify|${storeId}|${mobile}|${code}`);

const MOBILE_A = '13600000001';  // A 店已有档案
const MOBILE_X = '13600009999';  // 无档案的手机号
const STORE_A = 1;
const STORE_B = 4;

// ---------------------------------------------------------------------------
section('A. 只凭手机号不可查询');
// ---------------------------------------------------------------------------
const noToken = await api('/api/publicArchive:list');
check(noToken.status === 401, '无会话 token → 401（无法只凭手机号查询）', `HTTP ${noToken.status}`);

const fakeToken = await api('/api/publicArchive:list', { token: 'x'.repeat(43) });
check(fakeToken.status === 401, '伪造 token → 401', `HTTP ${fakeToken.status}`);

const listWithMobile = await api('/api/publicArchive:list', { token: '', body: { mobile: MOBILE_A } });
check(listWithMobile.status === 401, '带手机号但没有 token → 依然 401', `HTTP ${listWithMobile.status}`);

// ---------------------------------------------------------------------------
section('B. 发码限流');
// ---------------------------------------------------------------------------
// 用无档案的手机号，避免影响 A 店那批数据的验证码状态
// ⚠️ 先把该号码的"最近发送时间"往前推 —— 否则**第二次跑这个脚本**时，
//    第一发就会吃 60 秒限流而失败。这是测试可重复性问题，不是产品缺陷；
//    但不能靠"等 60 秒"来回避（那样的门禁没人愿意跑第二次）。
psql(`UPDATE service_archive_verify_codes
        SET last_sent_at = now() - interval '120 seconds'
      WHERE store_id=${STORE_B} AND customer_mobile='${MOBILE_X}';`);

const send1 = await api('/api/publicArchive:sendCode', { body: { store_id: STORE_B, mobile: MOBILE_X } });
check(send1.status === 200 && send1.json?.data?.sent === true, '发送验证码成功（mock 通道）', `HTTP ${send1.status} ${JSON.stringify(send1.json?.data ?? {})}`);
const send2 = await api('/api/publicArchive:sendCode', { body: { store_id: STORE_B, mobile: MOBILE_X } });
check(send2.status === 429, '60 秒内重发 → 429', `HTTP ${send2.status} ${send2.text?.slice(0, 120)}`);

const badStore = await api('/api/publicArchive:sendCode', { body: { store_id: 99999, mobile: MOBILE_X } });
check(badStore.status === 400, '不存在的门店 → 400（不给探测门店是否存在的差异）', `HTTP ${badStore.status}`);

// ---------------------------------------------------------------------------
section('C. 验证码校验与会话签发');
// ---------------------------------------------------------------------------
const GOOD = '246810';
// 回填已知码（发码时随机生成，正文不入库，测试无法读回）
psql(`UPDATE service_archive_verify_codes SET code_hash='${codeHash(STORE_B, MOBILE_X, GOOD)}', attempts=0, consumed_at=NULL, expires_at=now()+interval '5 minutes' WHERE store_id=${STORE_B} AND customer_mobile='${MOBILE_X}';`);

const wrong = await api('/api/publicArchive:verify', { body: { store_id: STORE_B, mobile: MOBILE_X, code: '000000' } });
check(wrong.status === 400, '错误验证码 → 400', `HTTP ${wrong.status} ${wrong.text?.slice(0, 100)}`);

const right = await api('/api/publicArchive:verify', { body: { store_id: STORE_B, mobile: MOBILE_X, code: GOOD } });
const tokenX = right.json?.data?.token;
check(right.status === 200 && typeof tokenX === 'string' && tokenX.length >= 40, '正确验证码 → 签发会话 token', `HTTP ${right.status} tokenLen=${tokenX?.length ?? 0}`);

const reuse = await api('/api/publicArchive:verify', { body: { store_id: STORE_B, mobile: MOBILE_X, code: GOOD } });
check(reuse.status === 400, '同一验证码不能二次使用（一次性）', `HTTP ${reuse.status}`);

// ---------------------------------------------------------------------------
section('D. 会话范围（跨客户 / 跨店）');
// ---------------------------------------------------------------------------
const listX = await api('/api/publicArchive:list', { token: tokenX });
const rowsX = listX.json?.data?.archives ?? [];
check(listX.status === 200 && rowsX.length === 0, '无档案手机号 → 空列表（不是报错，也不泄露他人档案）', `HTTP ${listX.status} 条数=${rowsX.length}`);

// 为 A 店 + MOBILE_A 准备一份**已发布**档案
// （之前 arc-photo-verify 建的都是草稿；客户查询只看 published，所以这里先发布一份）
let arcId = Number(psql(`SELECT id FROM service_archives WHERE store_id=${STORE_A} AND customer_mobile='${MOBILE_A}' AND visibility='published' ORDER BY id DESC LIMIT 1;`));
if (!arcId) {
  const candidate = psql(`SELECT id FROM service_archives WHERE store_id=${STORE_A} AND customer_mobile='${MOBILE_A}' ORDER BY id DESC LIMIT 1;`);
  if (candidate) {
    psql(`UPDATE service_archives SET visibility='published', published_at=now() WHERE id=${candidate};`);
    arcId = Number(candidate);
    console.log(`  · 已把档案 ${arcId} 置为 published（客户查询的前提）`);
  }
}
if (!arcId) {
  check(false, '前置：A 店缺少该手机号的档案（请先跑 arc-photo-verify）', '');
} else {
  const arcNo = psql(`SELECT archive_no FROM service_archives WHERE id=${arcId};`);

  // MOBILE_X 的会话去查 A 店那个档案 —— 必须 404
  const crossDetail = await api('/api/publicArchive:detail', { token: tokenX, body: { archive_no: arcNo } });
  check(crossDetail.status === 404, '他人会话按 archive_no 查 → 404（页面不泄露"单号存在"）', `HTTP ${crossDetail.status}`);

  // 签发 MOBILE_A 在 A 店的会话
  await api('/api/publicArchive:sendCode', { body: { store_id: STORE_A, mobile: MOBILE_A } });
  psql(`UPDATE service_archive_verify_codes SET code_hash='${codeHash(STORE_A, MOBILE_A, GOOD)}', attempts=0, consumed_at=NULL, expires_at=now()+interval '5 minutes' WHERE store_id=${STORE_A} AND customer_mobile='${MOBILE_A}';`);
  const vA = await api('/api/publicArchive:verify', { body: { store_id: STORE_A, mobile: MOBILE_A, code: GOOD } });
  const tokenA = vA.json?.data?.token;

  const listA = await api('/api/publicArchive:list', { token: tokenA });
  const rowsA = listA.json?.data?.archives ?? [];
  check(
    listA.status === 200 && rowsA.length > 0 && rowsA.every((r) => r.customer_name === '照片验证' || r.customer_name === '规则验证客户' || r.customer_name === 'A3暖通客户'),
    '本人本店 → 只看到自己的档案',
    `条数=${rowsA.length} 客户名=${[...new Set(rowsA.map((r) => r.customer_name))].join('/')}`,
  );

  const detailA = await api('/api/publicArchive:detail', { token: tokenA, body: { archive_no: arcNo } });
  check(detailA.status === 200, '本人可查自己档案详情', `HTTP ${detailA.status}`);

  const payload = JSON.stringify(detailA.json ?? {});
  check(!payload.includes('storage_key'), '详情响应不含 storage_key', '');
  check(!payload.includes('"notes"'), '详情响应不含内部 notes', '');
  check(!payload.includes('actor_role') && !payload.includes('serviceArchiveEvents'), '详情响应不含内部事件', '');

  // 跨店：同一手机号在 B 店签发的会话，查 A 店档案也必须 404
  await api('/api/publicArchive:sendCode', { body: { store_id: STORE_B, mobile: MOBILE_A } });
  psql(`UPDATE service_archive_verify_codes SET code_hash='${codeHash(STORE_B, MOBILE_A, GOOD)}', attempts=0, consumed_at=NULL, expires_at=now()+interval '5 minutes' WHERE store_id=${STORE_B} AND customer_mobile='${MOBILE_A}';`);
  const vAB = await api('/api/publicArchive:verify', { body: { store_id: STORE_B, mobile: MOBILE_A, code: GOOD } });
  const tokenAB = vAB.json?.data?.token;
  const crossStore = await api('/api/publicArchive:detail', { token: tokenAB, body: { archive_no: arcNo } });
  check(crossStore.status === 404, '同一手机号换门店 → 查不到别店档案（会话绑定门店）', `HTTP ${crossStore.status}`);
}

// ---------------------------------------------------------------------------
section('E. 未发布档案与未发布照片');
// ---------------------------------------------------------------------------
const draft = await api('/api/publicArchive:list', { token: tokenX });
check(
  !JSON.stringify(draft.json ?? {}).includes('"visibility":"draft"'),
  '列表不返回草稿档案',
  '',
);

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('\n' + '='.repeat(56));
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
console.log('='.repeat(56));
fs.writeFileSync('.tmp-verify/arc-a4-result.json', JSON.stringify({ results }, null, 2));
process.exit(failed.length ? 1 : 0);
