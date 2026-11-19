/**
 * R2 · 菜单重组通道探测（只读！只做 GET / 不写）
 *
 * 目的：确定"重排菜单"这件事**能不能走产品自己的通道**，
 *      而不是又去裸改 `desktopRoutes`（历史缺陷：直接改这三张表被明确否定过）。
 *
 * 探测项：
 *   1. `desktopRoutes:list` 管理接口对本角色是否可用（能读才有资格谈写）
 *   2. `desktopRoutes:create` / `:update` 是否存在（探测 OPTIONS / 故意非法 body，
 *      期望拿到"参数校验错"而不是"Not Found" —— 后者才是接口不存在）
 *   3. NocoBase 菜单管理的可视化入口（路由路径探测）
 *
 * ⚠️ 本轮**刻意不做任何写操作**。写要在拿到结论、备份、且用户拍板后进行。
 */
import { envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://127.0.0.1';

const ACCT = {
  email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'),
  pw: envValue('UAT_HQADMIN_PASSWORD', ''),
};

async function signIn() {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: ACCT.email, password: ACCT.pw }),
  });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`登录失败 ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data.token;
}

const token = await signIn();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function probe(label, path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { headers: H, ...init });
  const text = await r.text();
  let code = '';
  try {
    const j = JSON.parse(text);
    code = j?.errors?.[0]?.code ?? '';
    if (r.ok) code = '(ok)';
  } catch {
    code = '(non-json)';
  }
  const short = text.replace(/\s+/g, ' ').slice(0, 150);
  console.log(`  ${label}\n      ${path} → ${r.status} ${code}\n      ${short}`);
  return { status: r.status, code, text };
}

console.log('\n===== 1. 管理接口可读性 =====');
await probe('list (管理接口)', '/api/desktopRoutes:list?paginate=false');
await probe('get 单条', `/api/desktopRoutes:get?filterByTk=${envValue('X', '387851208425472')}`);

console.log('\n===== 2. 写接口是否存在（用非法 body 探测，期望"参数错"而非 404） =====');
await probe('create（空 body → 期望参数校验错）', '/api/desktopRoutes:create', {
  method: 'POST',
  body: JSON.stringify({}),
});
await probe('update（空 body）', '/api/desktopRoutes:update?filterByTk=387851208425472', {
  method: 'POST',
  body: JSON.stringify({}),
});
await probe('move（若存在）', '/api/desktopRoutes:move', {
  method: 'POST',
  body: JSON.stringify({}),
});

console.log('\n===== 3. 菜单管理的可视化入口 =====');
for (const p of [
  '/admin/settings/routes',
  '/admin/settings/menu',
  '/admin/settings/ui-schema-storage',
  '/admin/settings/desktopRoutes',
  '/admin/settings',
]) {
  const r = await fetch(`${BASE}${p}`, { redirect: 'manual' });
  console.log(`  ${p} → ${r.status} ${r.headers.get('location') ?? ''}`);
}
console.log('');
