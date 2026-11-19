/**
 * A6 收口 · 第 1 项取证：`member` 角色的**真实能力边界**
 *
 * 方法（刻意不建任何账号、不写任何业务数据）：
 *   拿 root（id=1，本身同时持有 member/admin/root 三个角色）的 token，
 *   用 `X-Role: member` 精确切到 member 视角 —— 等价于"一个只有 member 的新用户"，
 *   但不产生任何新数据，隔离库保持干净。
 *
 * 用法：SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... node .tmp-verify/a6/probe-member-scope.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_UAT_BASE || 'http://127.0.0.1:13001';
const uuid = () => crypto.randomUUID();

async function signIn(account, password) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': uuid() },
    body: JSON.stringify({ account, password }),
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, token: j?.data?.token, user: j?.data?.user, raw: t.slice(0, 160) };
}

async function api(token, p, opt = {}) {
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opt.role ? { 'X-Role': opt.role } : {}),
      ...(opt.role ? { 'X-Authenticator': 'basic' } : {}),
      'X-Data-Source': 'main',
      'X-Request-Id': uuid(),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t.slice(0, 220) };
}

const out = [];
const rec = (id, desc, detail) => { out.push({ id, desc, detail }); console.log(`[${id}] ${desc}\n     ${detail}`); };

const email = process.env.SMOKE_ADMIN_EMAIL || 'admin@nocobase.com';
const rs = await signIn(email, process.env.SMOKE_ADMIN_PASSWORD);
rec('S0', 'root 登录', `status=${rs.status} hasToken=${!!rs.token} raw=${rs.raw}`);
if (!rs.token) { console.log('\n无法登录，凭证未就绪'); process.exit(1); }
const tk = rs.token;

// member 视角的能力清单（每个角色一份，用 X-Role 切换）
for (const role of ['member', 'store_sales', 'hq_admin']) {
  const rc = await api(tk, '/api/roles:check', { role });
  const d = rc.json?.data;
  rec(`S1[${role}]`, `roles:check（X-Role=${role}）`, `status=${rc.status} role=${d?.role ?? '?'} strategy=${JSON.stringify(d?.strategy ?? d?.strategyActions ?? null).slice(0,120)}`);
}

// 核心：member 能看到的页面路由
const dr = await api(tk, '/api/desktopRoutes:list?paginate=false', { role: 'member' });
const routes = Array.isArray(dr.json?.data) ? dr.json.data : [];
rec('S2', 'member 可见 desktopRoutes', `status=${dr.status} count=${routes.length} 取样=${routes.map(r=>r.schemaUid).slice(0,10).join(',') || dr.text.slice(0,140)}`);

// 核心：member 对 ARC 业务集合的读写
for (const p of ['serviceArchives', 'serviceArchiveStages', 'serviceArchivePhotos']) {
  const l = await api(tk, `/api/${p}:list?paginate=false`, { role: 'member' });
  const c = await api(tk, `/api/${p}:create`, { method: 'POST', body: { status: 'draft' }, role: 'member' });
  const u = await api(tk, `/api/${p}:update?filterByTk=1`, { method: 'POST', body: { status: 'draft' }, role: 'member' });
  const x = await api(tk, `/api/${p}:destroy?filterByTk=1`, { method: 'POST', role: 'member' });
  rec('S3', `member 对 ${p}`, `list=${l.status} create=${c.status} update=${u.status} destroy=${x.status}`);
}

// 反向对照：同 token 切 store_sales 看同一集合（应 200）
const pos = await api(tk, '/api/serviceArchives:list?paginate=false', { role: 'store_sales' });
rec('S4', '反向对照：同 token 切 X-Role=store_sales 读 serviceArchives', `status=${pos.status}（应为 200）`);

// 反向对照 2：member 是否连 flowModels 都读不到（若读到 = 页面配置泄露）
const fm = await api(tk, '/api/flowModels:list?paginate=false', { role: 'member' });
rec('S5', '反向对照：member 读 flowModels（页面配置）', `status=${fm.status} count=${Array.isArray(fm.json?.data)?fm.json.data.length:'n/a'}`);

console.log('\n=== JSON ===');
console.log(JSON.stringify(out, null, 2));
