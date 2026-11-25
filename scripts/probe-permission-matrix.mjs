/**
 * §六④ 权限对照：授权销售 / 门店负责人 / 无权角色 / 总部 —— 菜单 + 接口双列。
 *
 * 判据纪律（本仓库反复踩过的）：
 *  · `:list` 的 `meta.count` **可能不带数据范围过滤** ⇒ 不能只看 count 判隔离，
 *    必须同时看"能不能读"（status）与"读到几条"（total），并在报告里写清口径；
 *  · 401 `The role does not belong to the user` 是**鉴权前置拒绝**，
 *    不是角色权限结论 ⇒ 本脚本一律用**真实登录**，不用 X-Role 模拟。
 */
import { CREDS } from './probe-creds.mjs';

const BASE = 'https://sh.scqfls.cn';

// ⚠️ 账号一律来自环境变量（见 scripts/probe-creds.mjs 的说明），不写进仓库
const ACCOUNTS = [
  { label: '销售',   role: 'store_sales',       email: CREDS.salesEmail },
  { label: '负责人', role: 'store_manager',     email: CREDS.mgrEmail },
  { label: '门店售后', role: 'store_after_sales', email: CREDS.storeEmail },
].filter((a) => a.email);

const PW = {
  [CREDS.salesEmail]: CREDS.acceptancePassword,
  [CREDS.mgrEmail]: CREDS.acceptancePassword,
  [CREDS.storeEmail]: CREDS.storePassword,
};

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
  return {
    status: res.status,
    code: json?.code ?? json?.errors?.[0]?.code ?? null,
    msg: json?.message ?? json?.errors?.[0]?.message ?? (json ? '' : text.slice(0, 100)),
    total: json?.total ?? json?.meta?.count ?? null,
  };
}

const out = [];

for (const acc of ACCOUNTS) {
  const pw = PW[acc.email];
  if (!pw) { out.push({ label: acc.label, skip: '无口令' }); continue; }

  const si = await api('/api/auth:signIn', { method: 'POST', body: { email: acc.email, password: pw } });
  const token = (await si.json?.data?.token) ?? null;
  // signIn 返回体在 api() 里没取 data.token，重新取一次
  let tok = null;
  {
    const r = await fetch(BASE + '/api/auth:signIn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: acc.email, password: pw }),
    });
    const j = await r.json().catch(() => null);
    tok = j?.data?.token ?? null;
  }
  if (!tok) { out.push({ label: acc.label, role: acc.role, login: 'FAIL' }); continue; }

  // ① 菜单：desktopRoutes:listAccessible
  const menu = await api('/api/desktopRoutes:listAccessible?tree=false', { token: tok });
  const titles = [];
  const walk = (arr) => {
    for (const n of arr || []) {
      if (n.type === 'flowPage') titles.push(n.title);
      if (n.children) walk(n.children);
    }
  };
  walk(menu.json?.data ?? []);

  // ② 接口
  const arc = await api('/api/svc:archiveAdminList?page=1&pageSize=5', { token: tok });
  const native = await api('/api/serviceArchives:list?page=1&pageSize=1', { token: tok });
  const tickets = await api('/api/serviceTickets:list?page=1&pageSize=1', { token: tok });

  out.push({
    label: acc.label,
    role: acc.role,
    login: 'OK',
    menuStatus: menu.status,
    menuPages: titles.length,
    hasArchiveMenu: titles.includes('上门服务档案'),
    archiveMenuNeighbors: titles.filter((t) => String(t).includes('档案')),
    archiveApi: { status: arc.status, code: arc.code, total: arc.total, msg: arc.msg },
    nativeArchive: { status: native.status, total: native.total },
    tickets: { status: tickets.status, total: tickets.total },
  });
}

console.log(JSON.stringify(out, null, 2));
