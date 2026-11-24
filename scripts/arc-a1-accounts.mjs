/**
 * arc-a1-accounts.mjs —— ARC-V1 / A1：开发环境最小测试账号
 *
 * 只做三件事（**全部在开发环境**）：
 *   1. 建 4 个测试账号（A 店销售 / B 店销售 / A 店负责人 / 跨店销售）
 *   2. 绑角色（store_sales / store_manager）
 *   3. 绑门店（store_users）
 *
 * 纪律：
 *   · 不碰生产；BASE 默认 https://127.0.0.1
 *   · 不修改任何既有账号的绑定（含 904 的 10 店绑定）
 *   · store_users 只"补"不"改"：已存在的关系跳过
 *   · 用真实 API（rolesUsers / store_users），不直插数据库 ——
 *     本项目踩过"直插 rolesUsers 后 X-Role 报 ROLE_NOT_FOUND_FOR_USER"（2026-10-26）
 *
 * 用法：
 *   node scripts/arc-a1-accounts.mjs --dry-run
 *   node scripts/arc-a1-accounts.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadDotEnv();

const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const APPLY = process.argv.includes('--apply');
const TAG = 'arc1';

/** 测试账号矩阵：正好覆盖 4 种授权形态 */
const ACCOUNTS = [
  { email: `${TAG}.sales.a@svc.local`,  username: `${TAG}_sales_a`,  nickname: 'A店销售',   role: 'store_sales',   stores: [1],    note: 'A 店(1) 读写' },
  { email: `${TAG}.sales.b@svc.local`,  username: `${TAG}_sales_b`,  nickname: 'B店销售',   role: 'store_sales',   stores: [4],    note: 'B 店(4) 读写' },
  { email: `${TAG}.mgr.a@svc.local`,    username: `${TAG}_mgr_a`,    nickname: 'A店负责人', role: 'store_manager', stores: [1],    note: 'A 店(1) 只读' },
  { email: `${TAG}.sales.multi@svc.local`, username: `${TAG}_sales_multi`, nickname: '跨店销售', role: 'store_sales', stores: [1, 4], note: '绑 2 店 → 必须 fail closed' },
];
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

const PASSWORD = ARC_TEST_PW;

async function api(token, p, opt = {}) {
  const res = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opt.headers || {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

async function signIn(account, password) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account, password } });
  if (!r.json?.data?.token) throw new Error(`登录失败 ${account}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
  return r.json.data.token;
}

const admin = await signIn(
  process.env.UAT_HQADMIN_EMAIL || 'uat.hqadmin@svc.local',
  process.env.UAT_HQADMIN_PASSWORD || '',
);
console.log(`管理员登录成功（${process.env.UAT_HQADMIN_EMAIL || 'uat.hqadmin@svc.local'}）`);
console.log(APPLY ? '模式：APPLY（会写库）' : '模式：DRY-RUN（只读）');

const summary = [];

for (const acc of ACCOUNTS) {
  // ---- 1. 找或建用户 ----
  const found = await api(admin, `/api/users:list?filter=${encodeURIComponent(JSON.stringify({ email: acc.email }))}`);
  let userId = found.json?.data?.[0]?.id;

  if (!userId) {
    if (!APPLY) {
      console.log(`[dry] 将创建用户 ${acc.email}`);
      summary.push({ ...acc, userId: null, action: 'would-create' });
      continue;
    }
    const created = await api(admin, '/api/users:create', {
      method: 'POST',
      body: { email: acc.email, username: acc.username, nickname: acc.nickname, password: PASSWORD },
    });
    if (created.status >= 400) {
      console.log(`✗ 建用户失败 ${acc.email}: HTTP ${created.status} ${created.text.slice(0, 160)}`);
      continue;
    }
    userId = created.json?.data?.id;
    console.log(`✓ 创建用户 ${acc.email} id=${userId}`);
  } else {
    console.log(`· 用户已存在 ${acc.email} id=${userId}`);
  }

  // ---- 2. 绑角色（幂等）----
  const hasRole = await api(admin, `/api/rolesUsers:list?filter=${encodeURIComponent(JSON.stringify({ userId, roleName: acc.role }))}`);
  if ((hasRole.json?.data ?? []).length === 0) {
    if (APPLY) {
      const r = await api(admin, '/api/rolesUsers:create', { method: 'POST', body: { userId, roleName: acc.role } });
      console.log(r.status < 400 ? `  ✓ 绑角色 ${acc.role}` : `  ✗ 绑角色失败 HTTP ${r.status} ${r.text.slice(0, 140)}`);
    } else {
      console.log(`  [dry] 将绑角色 ${acc.role}`);
    }
  } else {
    console.log(`  · 角色已绑 ${acc.role}`);
  }

  // ---- 3. 绑门店（幂等，只补不改）----
  for (const storeId of acc.stores) {
    const has = await api(admin, `/api/storeUsers:list?filter=${encodeURIComponent(JSON.stringify({ userId, storeId }))}`);
    if ((has.json?.data ?? []).length === 0) {
      if (APPLY) {
        const r = await api(admin, '/api/storeUsers:create', { method: 'POST', body: { userId, storeId } });
        console.log(r.status < 400 ? `  ✓ 绑门店 ${storeId}` : `  ✗ 绑门店 ${storeId} 失败 HTTP ${r.status} ${r.text.slice(0, 140)}`);
      } else {
        console.log(`  [dry] 将绑门店 ${storeId}`);
      }
    } else {
      console.log(`  · 门店已绑 ${storeId}`);
    }
  }

  summary.push({ ...acc, userId, action: 'ok' });
}

console.log('\n=== 汇总 ===');
for (const s of summary) {
  console.log(`  ${s.email.padEnd(34)} role=${s.role.padEnd(14)} stores=[${s.stores.join(',')}]  ${s.note}`);
}
console.log(`\n口令统一为：${PASSWORD}（仅开发环境）`);

