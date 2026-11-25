/**
 * 给两个验收账号补绑门店（用户 2026-11-25 授权新建验收账号的配套动作）。
 *
 * 为什么需要单独一步：`users:create` 建出的用户不带任何门店绑定，
 * 而 `ArchiveService` 的门店范围靠 `store_users` 判定 ⇒ 不绑店就永远只能看到 0 条，
 * 测出来的 "200 / total=0" 是**假阳性**（看起来通了，其实什么都没读到）。
 *
 * 边界（按用户约束收窄）：
 *   · 只给 `r224acc.*` 这两个账号插入 `store_users`；
 *   · 只绑一家真实门店；**不删、不改**任何既有绑定；
 *   · 走原始 SQL 而不是业务接口：`storeAccounts` 只支持改授权门店且需要门店上下文，
 *     建绑定的最小动作就是插一行。
 *   · ⚠️ 直插 `store_users` **不影响角色 ACL**（角色已在 `rolesUsers` 里，
 *     且上面已验证 `roles:check` 即时生效）⇒ 不需要重启应用。
 */
const BASE = 'https://sh.scqfls.cn';

const ADMIN_EMAIL = 'admin@nocobase.com';
const ADMIN_PW = process.env.PROD_ADMIN_PASSWORD;
const STORE_ID = Number(process.env.REHEAR_STORE_ID || 1);

if (!ADMIN_PW) { console.error('缺少 PROD_ADMIN_PASSWORD'); process.exit(2); }

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

// 先用管理员确认两个账号 id（不猜）
const login = await api('/api/auth:signIn', {
  method: 'POST',
  body: { email: ADMIN_EMAIL, password: ADMIN_PW },
});
const token = login.json?.data?.token;
if (!token) { console.error('管理员登录失败'); process.exit(1); }

const found = await api(
  `/api/users:list?filter=${encodeURIComponent(JSON.stringify({ email: { $startsWith: 'r224acc.' } }))}&pageSize=10`,
  { token },
);
const users = found.json?.data ?? [];
console.log(JSON.stringify(users.map((u) => ({ id: u.id, email: u.email, nickname: u.nickname })), null, 2));
console.log('目标门店 id =', STORE_ID, '（补绑脚本需在服务器端执行 SQL 部分）');
