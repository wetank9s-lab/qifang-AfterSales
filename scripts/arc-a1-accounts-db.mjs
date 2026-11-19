import fs from 'node:fs';
/**
 * arc-a1-accounts-db.mjs —— ARC-V1 / A1：开发环境最小测试账号（数据库路径）
 *
 * 为什么不用 API：
 *   `users:create` 需要平台管理员（root/admin），而本会话只握有 `hq_admin` 的凭据，
 *   它对 `users` 资源是 403（项目刻意不让总部管理员直接建账号）。
 *   `storeAccounts` 业务接口只支持"改授权门店"，不支持建号。
 *
 * ⚠️ 直插数据库的已知坑（2026-10-26 生产踩过）：
 *   直插 `rolesUsers` 后 `X-Role` 会报 `ROLE_NOT_FOUND_FOR_USER` —— 因为 ACL 的角色
 *   在内存里，数据库写入不会自动刷新。**修法是重启应用**，不是改数据。
 *   本脚本因此以 `--after-restart` 分两段：先写库，重启后再自检。
 *
 * 只动开发库；生产 `store_users` 的悬空绑定（user 194 → store 2）一概不碰。
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PG = 'svc-postgres';
const DB = 'service_ticket';
const USER = 'svc_app';
const PASSWORD = ARC_TEST_PW;

const ACCOUNTS = [
  { email: 'arc1.sales.a@svc.local',     username: 'arc1_sales_a',     nickname: 'A店销售',   role: 'store_sales',   stores: [1],    note: 'A 店(1) 读写' },
  { email: 'arc1.sales.b@svc.local',     username: 'arc1_sales_b',     nickname: 'B店销售',   role: 'store_sales',   stores: [4],    note: 'B 店(4) 读写' },
  { email: 'arc1.mgr.a@svc.local',       username: 'arc1_mgr_a',       nickname: 'A店负责人', role: 'store_manager', stores: [1],    note: 'A 店(1) 只读' },
  { email: 'arc1.sales.multi@svc.local', username: 'arc1_sales_multi', nickname: '跨店销售',   role: 'store_sales',   stores: [1, 4], note: '绑 2 店 → 必须 fail closed' },
  // 用户 2026-11-09 点名的第 4 条：绑 [1, 2]，而 store_id=2 在 stores 里**不存在**。
  // 期望**仍然拒绝**（不是"忽略 2 号店、按 1 号店放行"）。
  { email: 'arc1.sales.bad@svc.local',   username: 'arc1_sales_bad',   nickname: '无效门店销售', role: 'store_sales', stores: [1, 2], note: '含不存在门店(2) → 必须 fail closed' },
];

/** NocoBase 口令格式：salt(16 hex) + scrypt(password, salt, 24) 的 hex，共 64 字符 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(8).toString('hex'); // 16 hex
  const derived = crypto.scryptSync(plain, salt, 24).toString('hex'); // 48 hex
  return salt + derived;
}

function psql(sql) {
  const out = execFileSync(
    'docker',
    ['exec', '-i', PG, 'psql', '-U', USER, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  );
  return out.trim();
}

const mode = process.argv.includes('--after-restart') ? 'verify' : 'write';

if (mode === 'write') {
  const lines = [];
  for (const a of ACCOUNTS) {
    const hash = hashPassword(PASSWORD);
    // 用户：存在则跳过（只增不改）
    lines.push(`INSERT INTO users (email, username, nickname, password, "createdAt", "updatedAt")
SELECT '${a.email}', '${a.username}', '${a.nickname}', '${hash}', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = '${a.email}');`);

    // 角色关联：走 NocoBase 的 rolesUsers（复合主键 roleName+userId，无 id 列）
    lines.push(`INSERT INTO "rolesUsers" ("userId", "roleName", "createdAt", "updatedAt")
SELECT id, '${a.role}', now(), now() FROM users WHERE email = '${a.email}'
  AND NOT EXISTS (SELECT 1 FROM "rolesUsers" r JOIN users u ON u.id = r."userId"
                  WHERE u.email = '${a.email}' AND r."roleName" = '${a.role}');`);

    // 门店绑定
    for (const sid of a.stores) {
      lines.push(`INSERT INTO store_users (user_id, store_id, created_at, updated_at)
SELECT id, ${sid}, now(), now() FROM users WHERE email = '${a.email}'
  AND NOT EXISTS (SELECT 1 FROM store_users s JOIN users u ON u.id = s.user_id
                  WHERE u.email = '${a.email}' AND s.store_id = ${sid});`);
    }
  }

  const out = psql(lines.join('\n'));
  console.log('写入完成（INSERT ... WHERE NOT EXISTS，幂等）：');
  console.log(out || '(无输出)');

  const rows = psql(`
    SELECT u.id || ' | ' || u.email || ' | ' || r."roleName" || ' | stores=' ||
           coalesce((SELECT string_agg(s.store_id::text, ',' ORDER BY s.store_id)
                     FROM store_users s WHERE s.user_id = u.id), '-')
    FROM users u JOIN "rolesUsers" r ON r."userId" = u.id
    WHERE u.email LIKE 'arc1.%' ORDER BY u.id;`);
  console.log('\n=== 落库核对 ===');
  console.log(rows);
  console.log('\n⚠️ 下一步必须重启应用（直插 rolesUsers 不会刷新内存 ACL）：');
  console.log('   docker compose restart app');
  console.log('   然后 node scripts/arc-a1-accounts-db.mjs --after-restart');
} else {
  const rows = psql(`
    SELECT u.id || ' | ' || u.email || ' | ' || r."roleName" || ' | stores=' ||
           coalesce((SELECT string_agg(s.store_id::text, ',' ORDER BY s.store_id)
                     FROM store_users s WHERE s.user_id = u.id), '-')
    FROM users u JOIN "rolesUsers" r ON r."userId" = u.id
    WHERE u.email LIKE 'arc1.%' ORDER BY u.id;`);
  console.log('=== 重启后核对 ===');
  console.log(rows);
  const n = psql(`SELECT count(*) FROM users WHERE email LIKE 'arc1.%';`);
  console.log(`\n账号数 = ${n}（期望 4）`);
}
// 测试口令只在 .env（`ARC_TEST_PW`）：源码不留凭据字面量（见 docs/R2-SECURITY-FREEZE.md 第 2 项）
const ARC_TEST_PW = (() => {
  try {
    const t = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^ARC_TEST_PW=(.*)$/m.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

