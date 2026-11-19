/**
 * arc-a4-hardening.mjs —— A4 收尾：四项安全边界核对
 *
 * 只测这四条（用户 2026-11-10：不大量测试、不反复验证）：
 *   1. 多维限流：同手机号小时上限、同 IP 小时上限
 *   2. 并发 verify 不得重复消费同一枚码
 *   3. 签发新会话会撤销旧会话；重发验证码不影响已签发会话
 *   4. 照片读取每次都重新校验会话与可见性
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
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opt.token ? { 'X-Archive-Session': opt.token } : {}),
      ...(opt.ip ? { 'X-Real-IP': opt.ip } : {}),
    },
    body: JSON.stringify(opt.body || {}),
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const t = await res.text();
    let j = null; try { j = JSON.parse(t); } catch { /* ignore */ }
    return { status: res.status, json: j, text: t };
  }
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
}

function psql(sql) {
  return execFileSync('docker', ['exec','-i','svc-postgres','psql','-U','svc_app','-d','service_ticket','-v','ON_ERROR_STOP=1','-A','-t','-F','|','-f','-'], { input: sql, encoding: 'utf8' }).trim();
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const codeHash = (storeId, mobile, code) => sha256(`archive-verify|${storeId}|${mobile}|${code}`);

const STORE_CODE = 'S01';
const STORE_ID = Number(psql(`SELECT id FROM stores WHERE code='${STORE_CODE}';`));
const GOOD = '135790';

async function freshCode(mobile) {
  psql(`UPDATE service_archive_verify_codes SET last_sent_at = now() - interval '2 hours'
         WHERE store_id=${STORE_ID} AND customer_mobile='${mobile}';`);
  psql(`DELETE FROM service_archive_verify_codes WHERE store_id=${STORE_ID} AND customer_mobile='${mobile}';`);
  await api('/api/publicArchive:sendCode', { body: { store_code: STORE_CODE, mobile } });
  psql(`UPDATE service_archive_verify_codes
           SET code_hash='${codeHash(STORE_ID, mobile, GOOD)}', attempts=0, consumed_at=NULL,
               last_sent_at=now()-interval '2 hours',
               expires_at=now()+interval '5 minutes'
         WHERE store_id=${STORE_ID} AND customer_mobile='${mobile}';`);
}

// ---------------------------------------------------------------------------
section('① 多维限流');
// ---------------------------------------------------------------------------
const M_LIMIT = '13600008801';
psql(`DELETE FROM service_archive_verify_codes WHERE customer_mobile='${M_LIMIT}';`);
// 先造 5 条"一小时内已发送"的记录（模拟已经发满）
for (let i = 0; i < 5; i += 1) {
  psql(`INSERT INTO service_archive_verify_codes
          (store_id, customer_mobile, code_hash, expires_at, attempts, max_attempts, last_sent_at, created_at, updated_at)
        VALUES (${STORE_ID}, '${M_LIMIT}', '${'0'.repeat(64)}', now()+interval '5 minutes', 0, 5,
                now() - interval '10 minutes', now(), now());`);
}
const overMobile = await api('/api/publicArchive:sendCode', { body: { store_code: STORE_CODE, mobile: M_LIMIT } });
check(overMobile.status === 429, '同手机号一小时内满 5 条 → 429', `HTTP ${overMobile.status} ${overMobile.text?.slice(0, 120)}`);

// IP 维度：按**服务端实际记下的** ip_hash 造数据。
// ⚠️ 第一版我用 `X-Real-IP` 头伪造来源 IP，结果全部命中同一个真实连接 IP ——
//    这恰恰说明代码没信任客户端自称的 IP（正确行为）。
//    所以这里先发一次码，把服务端落库的 ip_hash 读出来，再按它造满。
const M_PROBE = '13600008898';
psql(`DELETE FROM service_archive_verify_codes WHERE customer_mobile='${M_PROBE}';`);
await api('/api/publicArchive:sendCode', { body: { store_code: STORE_CODE, mobile: M_PROBE } });
const realIpHash = psql(`SELECT ip_hash FROM service_archive_verify_codes WHERE customer_mobile='${M_PROBE}' ORDER BY id DESC LIMIT 1;`);

if (!realIpHash) {
  check(false, 'IP 限流：无法读到真实 ip_hash（前置不足）', '');
} else {
  // 把该 IP 补到 10 条
  const exist = Number(psql(`SELECT count(*) FROM service_archive_verify_codes WHERE ip_hash='${realIpHash}' AND last_sent_at > now()-interval '1 hour';`));
  for (let i = exist; i < 10; i += 1) {
    psql(`INSERT INTO service_archive_verify_codes
            (store_id, customer_mobile, code_hash, expires_at, attempts, max_attempts, ip_hash, last_sent_at, created_at, updated_at)
          VALUES (${STORE_ID}, '136000088${String(10 + i).slice(-2)}', '${'0'.repeat(64)}',
                  now()+interval '5 minutes', 0, 5, '${realIpHash}', now() - interval '5 minutes', now(), now());`);
  }
  const overIp = await api('/api/publicArchive:sendCode', { body: { store_code: STORE_CODE, mobile: '13600008897' } });
  check(overIp.status === 429, '同 IP 一小时内满 10 条 → 429（换号也刷不动）', `HTTP ${overIp.status} ${overIp.text?.slice(0, 120)}`);

  // ⚠️ 必须清场：这条用例把"当前 IP"打到了 10 条上限，
  //    不清的话后面每个用例的 sendCode 都会 429 —— 而失败会表现为
  //    "并发 verify 拿不到会话""新会话签发失败"，看起来像产品坏了。
  //    第一版就是这样连挂三条的。
  psql(`UPDATE service_archive_verify_codes SET last_sent_at = now() - interval '2 hours'
         WHERE ip_hash='${realIpHash}';`);
  psql(`DELETE FROM service_archive_verify_codes WHERE customer_mobile='${M_PROBE}';`);
}

// ---------------------------------------------------------------------------
section('② 并发 verify 不得重复消费');
// ---------------------------------------------------------------------------
const M_RACE = '13600008802';
await freshCode(M_RACE);
const race = await Promise.all(
  Array.from({ length: 5 }, () =>
    api('/api/publicArchive:verify', { body: { store_code: STORE_CODE, mobile: M_RACE, code: GOOD } }),
  ),
);
const okCount = race.filter((r) => r.status === 200 && r.json?.data?.token).length;
const tokens = new Set(race.filter((r) => r.json?.data?.token).map((r) => r.json.data.token));
check(
  okCount === 1 && tokens.size === 1,
  '5 个并发 verify 只有 1 个拿到会话（同一枚码不会被消费两次）',
  `成功=${okCount} 不同token=${tokens.size}`,
);

// ---------------------------------------------------------------------------
section('③ 新会话撤销旧会话 / 重发验证码不影响已签发会话');
// ---------------------------------------------------------------------------
const M_SESS = '13600008803';
await freshCode(M_SESS);
const v1 = await api('/api/publicArchive:verify', { body: { store_code: STORE_CODE, mobile: M_SESS, code: GOOD } });
const t1 = v1.json?.data?.token;
const use1 = await api('/api/publicArchive:list', { token: t1 });
check(use1.status === 200, '第一个会话可用', `HTTP ${use1.status}`);

// 重新验证一次（同店同号）→ 旧会话必须失效
// ⚠️ 必须**重新造一枚码**：上一枚在第一次验证时已被核销（一次性）。
//    第一版没做这一步，第二次 verify 直接 400，看起来像"新会话签发失败"。
await freshCode(M_SESS);
const v2 = await api('/api/publicArchive:verify', { body: { store_code: STORE_CODE, mobile: M_SESS, code: GOOD } });
const t2 = v2.json?.data?.token;
check(v2.status === 200 && !!t2 && t2 !== t1, '第二次验证签发新会话', `HTTP ${v2.status}`);

const use1old = await api('/api/publicArchive:list', { token: t1 });
check(use1old.status === 401, '旧会话被撤销 → 401（不是"两个会话并存到 30 分钟"）', `HTTP ${use1old.status}`);

const use2 = await api('/api/publicArchive:list', { token: t2 });
check(use2.status === 200, '新会话可用', `HTTP ${use2.status}`);

// 服务端会话有效期就是 30 分钟（配置值核对）
const ttlMin = Number(psql(`SELECT round(extract(epoch from (expires_at - now()))/60) FROM service_archive_query_sessions ORDER BY id DESC LIMIT 1;`));
check(ttlMin > 25 && ttlMin <= 30, '会话有效期约 30 分钟', `剩余 ${ttlMin} 分钟`);

// ---------------------------------------------------------------------------
section('④ 照片读取每次重新校验');
// ---------------------------------------------------------------------------
const photoRow = psql(`SELECT id FROM service_archive_photos WHERE published = true ORDER BY id DESC LIMIT 1;`);
if (photoRow) {
  const noTok = await api('/api/publicArchive:photo', { body: { photo_id: Number(photoRow) } });
  check(noTok.status === 401, '无会话读照片 → 401', `HTTP ${noTok.status}`);

  const badTok = await api('/api/publicArchive:photo', { token: 'z'.repeat(43), body: { photo_id: Number(photoRow) } });
  check(badTok.status === 401, '伪造会话读照片 → 401', `HTTP ${badTok.status}`);
} else {
  console.log('  · 无已发布照片，跳过（前置不足）');
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('\n' + '='.repeat(56));
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
console.log('='.repeat(56));
fs.writeFileSync('.tmp-verify/arc-a4-hardening.json', JSON.stringify({ results }, null, 2));
process.exit(failed.length ? 1 : 0);
