/**
 * _r212_cred_status.mjs —— 核对被泄露的 UAT 口令是否仍有效（**只输出状态，不打印口令**）
 *
 * 三个受影响的账号（本地库 users 表实测存在）：
 *   537  uat.hqadmin@svc.local      → hq_admin
 *   7781 uat.r211.hq@svc.local      → hq_after_sales
 *   7782 uat.r211.store@svc.local   → store_after_sales
 *
 * 判据：POST /api/auth:signIn 是否返回 200 且带 token。
 * 输出只有 ACTIVE / REVOKED-BY-ROTATION / NOT-FOUND。
 *
 * 用法：
 *   node scripts/_r212_cred_status.mjs --pass <口令>          # 测本地
 *   node scripts/_r212_cred_status.mjs --pass <口令> --base <url>
 */
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const BASE = argOf('base', process.env.SVC_BASE || 'http://127.0.0.1:13000');
const PASS = argOf('pass', process.env.R212_OLD_PASS || '');
if (!PASS) { console.error('用法：--pass <待测口令>'); process.exit(1); }

const ACCOUNTS = [
  { id: 537, email: 'uat.hqadmin@svc.local', role: 'hq_admin' },
  { id: 7781, email: 'uat.r211.hq@svc.local', role: 'hq_after_sales' },
  { id: 7782, email: 'uat.r211.store@svc.local', role: 'store_after_sales' },
];

const out = [];
for (const a of ACCOUNTS) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: a.email, password: PASS }),
  }).catch((e) => ({ status: 0, err: String(e.message || e) }));
  const j = r.status === 200 ? await r.json().catch(() => null) : null;
  const hasToken = !!(j && j.data && j.data.token);
  out.push({
    userId: a.id,
    email: a.email,
    role: a.role,
    httpStatus: r.status,
    verdict: hasToken ? 'ACTIVE（口令仍可用）' : r.status === 200 ? 'NO-TOKEN' : 'REVOKED（口令已失效）',
  });
}
console.log(JSON.stringify({ base: BASE, checked: out }, null, 2));
const anyActive = out.some((o) => o.verdict.startsWith('ACTIVE'));
process.exit(anyActive ? 1 : 0);
