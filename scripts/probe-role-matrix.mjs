/**
 * 生产只读探针 B：工单四表不回归 + 档案接口按角色对照。
 *
 * §四 问题 A 的正式取证方式：
 *   生产**没有** store_manager 账号、store_sales 唯一账号无邮箱口令未知
 *   ⇒ 不能靠"登录三个真实账号"来测。
 *   改用平台管理员令牌 + `X-Role` 头切换角色 —— 这是 NocoBase 的**官方角色切换通道**，
 *   服务端按该角色做完整裁决（ACL + scope），与真实登录同一个判定函数。
 *
 *   ⚠️ 但它测的是"**该角色被真正使用时**的裁决结果"，不能反过来证明
 *      "某账号登录后默认用哪个角色"。后者由 `roles:check` 的 roles 列表决定。
 */
const BASE = 'https://sh.scqfls.cn';
const EMAIL = 'admin@nocobase.com';
const PASS = process.env.PROD_ADMIN_PASSWORD;
if (!PASS) { console.error('缺少 PROD_ADMIN_PASSWORD'); process.exit(2); }

async function api(path, { token, role, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (role) headers['X-Role'] = role;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return {
    status: res.status,
    code: json?.errors?.[0]?.code ?? json?.code ?? null,
    msg: json?.errors?.[0]?.message ?? json?.message ?? (json ? '' : text.slice(0, 120)),
    count: json?.meta?.count ?? null,
  };
}

const login = await fetch(BASE + '/api/auth:signIn', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
});
const lj = await login.json();
const token = lj?.data?.token;
if (!token) { console.error('登录失败', JSON.stringify(lj).slice(0, 300)); process.exit(1); }

const TICKET_TABLES = ['serviceTickets', 'serviceVisits', 'ticketEvents', 'smsLogs'];
const ROLES = ['store_after_sales', 'store_sales', 'store_manager', 'hq_after_sales', 'hq_admin', 'viewer'];

const rows = [];

// ① 基线：不带 X-Role（管理员默认角色）
for (const t of TICKET_TABLES) {
  const r = await api(`/api/${t}:list?page=1&pageSize=1`, { token });
  rows.push({ group: 'tickets', table: t, role: '(default)', status: r.status, msg: r.msg });
}

// ② 按角色切换读工单四表
for (const role of ROLES) {
  for (const t of TICKET_TABLES) {
    const r = await api(`/api/${t}:list?page=1&pageSize=1`, { token, role });
    rows.push({ group: 'tickets', table: t, role, status: r.status, msg: r.msg });
  }
}

// ③ 档案后台列表按角色切换
for (const role of ['(default)', ...ROLES]) {
  const r = await api('/api/svc:archiveAdminList?page=1&pageSize=1', {
    token,
    role: role === '(default)' ? undefined : role,
  });
  rows.push({ group: 'archives', table: 'archiveAdminList', role, status: r.status, count: r.count, msg: r.msg });
}

// ④ 档案原生读接口按角色切换（问题 B 的直接判据）
for (const role of ROLES) {
  const r = await api('/api/serviceArchives:list?page=1&pageSize=1', { token, role });
  rows.push({ group: 'archives', table: 'serviceArchives:list', role, status: r.status, count: r.count, msg: r.msg });
}

console.log(JSON.stringify(rows, null, 1));
