/**
 * 生产只读探针 C：用**真实账号**测角色边界（§四 问题 A / 问题 B 的正式判据）。
 *
 * 为什么必须真实登录：`X-Role` 头只有在"该角色确实绑定在账号上"时才生效，
 * 否则服务端在鉴权阶段就回 401 `The role does not belong to the user`，
 * 拿到的是"账号没这个角色"，**不是**"这个角色没有权限"。
 *
 * 只读：全部走 `:list` 与 `roles:check`，不做任何写操作。
 */
const BASE = 'https://sh.scqfls.cn';

const ACCOUNTS = [
  {
    label: 'store_after_sales',
    email: process.env.PROD_STORE_EMAIL,
    password: process.env.PROD_STORE_PASSWORD,
  },
  {
    label: 'hq',
    email: 'admin@nocobase.com',
    password: process.env.PROD_ADMIN_PASSWORD,
  },
].filter((a) => a.email && a.password);

async function signIn(email, password) {
  const res = await fetch(BASE + '/api/auth:signIn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json().catch(() => null);
  return { status: res.status, token: j?.data?.token ?? null, raw: j };
}

async function get(path, token) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* ignore */ }
  return {
    status: res.status,
    code: j?.errors?.[0]?.code ?? null,
    msg: j?.errors?.[0]?.message ?? '',
    count: j?.meta?.count ?? null,
  };
}

const out = [];

for (const acc of ACCOUNTS) {
  const si = await signIn(acc.email, acc.password);
  if (!si.token) {
    out.push({ account: acc.label, step: 'signIn', status: si.status, ok: false, msg: si.raw?.errors?.[0]?.message ?? '' });
    continue;
  }
  out.push({ account: acc.label, step: 'signIn', status: si.status, ok: true });

  // 账号实际持有的角色
  const rc = await get('/api/roles:check', si.token);
  out.push({ account: acc.label, step: 'roles:check', status: rc.status, ...rc });

  // 工单四表（§四 问题 A）
  for (const t of ['serviceTickets', 'serviceVisits', 'ticketEvents', 'smsLogs']) {
    const r = await get(`/api/${t}:list?page=1&pageSize=1`, si.token);
    out.push({ account: acc.label, step: `tickets/${t}`, status: r.status, count: r.count, msg: r.msg });
  }

  // 档案入口（§二 / §三）
  const al = await get('/api/svc:archiveAdminList?page=1&pageSize=1', si.token);
  out.push({ account: acc.label, step: 'archives/archiveAdminList', status: al.status, count: al.count, code: al.code, msg: al.msg });

  const na = await get('/api/serviceArchives:list?page=1&pageSize=1', si.token);
  out.push({ account: acc.label, step: 'archives/serviceArchives:list', status: na.status, count: na.count, code: na.code, msg: na.msg });
}

console.log(JSON.stringify(out, null, 1));
