/**
 * 生产只读探针：确认「上门服务档案」入口与档案接口的真实状态。
 *
 * 只读约束：
 *   · 只调 `:list` / `:get` / `:listAccessible` 一类读取动作，不做任何写操作；
 *   · 不新建账号、不改口令、不动真实门店绑定。
 */
import fs from 'node:fs';

const BASE = 'https://sh.scqfls.cn';
const EMAIL = 'admin@nocobase.com';
const PASS = process.env.PROD_ADMIN_PASSWORD;

if (!PASS) {
  console.error('缺少 PROD_ADMIN_PASSWORD');
  process.exit(2);
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text: json ? '' : text.slice(0, 200) };
}

const out = [];

// ① 登录
const login = await api('/api/auth:signIn', {
  method: 'POST',
  body: { email: EMAIL, password: PASS },
});
const token = login.json?.data?.token;
out.push({ step: 'signIn', status: login.status, hasToken: !!token });
if (!token) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
}

// ② 桌面路由可见列表（管理员视角）
const acc = await api('/api/desktopRoutes:listAccessible?tree=false', { token });
const items = acc.json?.data ?? [];
const flat = [];
const walk = (arr, depth) => {
  for (const n of arr || []) {
    flat.push({ id: n.id, type: n.type, title: n.title, depth });
    if (n.children) walk(n.children, depth + 1);
  }
};
walk(items, 0);
out.push({
  step: 'listAccessible',
  status: acc.status,
  totalLeaves: flat.filter((x) => x.type === 'flowPage').length,
  hasArchivesPage: flat.some((x) => x.title === '上门服务档案'),
  archivesEntries: flat.filter((x) => String(x.title || '').includes('档案')),
});

// ③ 档案后台列表（受控 action）
const adm = await api('/api/svc:archiveAdminList?page=1&pageSize=1', { token });
out.push({
  step: 'archiveAdminList',
  status: adm.status,
  code: adm.json?.code ?? adm.json?.error?.code ?? null,
  total: adm.json?.total ?? null,
  hasRows: Array.isArray(adm.json?.rows),
  canEdit: adm.json?.can_edit ?? null,
  msg: adm.json?.message ?? adm.json?.error?.message ?? adm.text,
});

// ④ 产品清单接口（验证缺失表时的真实表现）
if (Array.isArray(adm.json?.rows) && adm.json.rows.length > 0) {
  const id = adm.json.rows[0].id;
  const p = await api(`/api/svc:archiveProductList?filterByTk=${id}`, { token });
  out.push({
    step: 'archiveProductList',
    archiveId: id,
    status: p.status,
    code: p.json?.code ?? p.json?.error?.code ?? null,
    msg: p.json?.message ?? p.json?.error?.message ?? p.text,
  });
}

// ⑤ 原生 serviceArchives:list（后台角色应有的表现）
const native = await api('/api/serviceArchives:list?page=1&pageSize=1', { token });
out.push({
  step: 'serviceArchives:list(native)',
  status: native.status,
  count: native.json?.meta?.count ?? null,
});

console.log(JSON.stringify(out, null, 2));
