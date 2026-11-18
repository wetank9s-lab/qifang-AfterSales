/**
 * 门店售后角色（uat.r211.store）的**可访问页面集合**是否与整改前一致。
 *
 * 判据（不能只看菜单文字）：直接读 `listAccessible` 返回的路由树，
 * 得到该角色**真实可访问**的页面集合；再与「分组定义里它能看到的项」对齐。
 * 分组只是视觉容器 ⇒ 两者的交集必须等于交集本身（不减不增）。
 */
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:13000';
const ACCOUNTS = [
  { label: '门店售后', email: 'uat.r211.store@svc.local' },
  { label: '总部售后', email: 'uat.r211.hq@svc.local' },
  { label: '总部管理', email: 'uat.hqadmin@svc.local' },
];
const PW = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!PW) { console.error('缺少口令：export R212_PASS=<本地 UAT 口令>'); process.exit(1); }

// 分组定义（与 menu-groups.ts 必须一致）
const DAILY = ['售后服务工作台', '我的门店工单', '所有工单', '总部售后工作台'];
const ADMIN = ['派工记录', '工单事件时间线', '门店报修入口', '服务时效', '客户页面装修', '门店账号', '短信通知', '短信通知总览', '历史数据导入', '历史售后档案'];
const GROUPED = new Set([...DAILY, ...ADMIN]);

const out = { at: new Date().toISOString(), roles: [] };

for (const acc of ACCOUNTS) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: acc.email, password: PW }),
  });
  const j = await r.json().catch(() => null);
  const token = j?.data?.token;
  if (!token) { out.roles.push({ ...acc, error: 'signin failed ' + r.status }); continue; }

  const res = await fetch(`${BASE}/api/desktopRoutes:listAccessible?paginate=false&tree=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => null);
  const arr = body?.data || [];

  // 递归收集 title（title 在 data 里；子节点在 children）
  const titles = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n?.title) titles.push(String(n.title).trim());
      if (n?.children) walk(n.children);
    }
  };
  walk(arr);

  // 排除分组容器自己的标题（tabs 类型的父节点一般与子页同名，本地存在「所有工单」tabs + flowPage 重名）
  const uniq = [...new Set(titles)];

  out.roles.push({
    ...acc,
    httpStatus: res.status,
    count: uniq.length,
    titles: uniq,
    // 分组后菜单里**看得见**的 = 它可访问集合 ∩ 分组定义
    visibleInGroups: uniq.filter(t => GROUPED.has(t)),
    // 不在任何分组里的（原样留在原位，不消失）
    ungrouped: uniq.filter(t => !GROUPED.has(t)),
    // 分组定义里有、但它本来就没权限的（必须为零影响：这些就是"它看不到"，与改前一致）
    notPermitted: [...GROUPED].filter(t => !uniq.includes(t)),
  });
}

fs.mkdirSync('storage/tmp/r212', { recursive: true });
fs.writeFileSync('storage/tmp/r212/roles.json', JSON.stringify(out, null, 2));

for (const role of out.roles) {
  console.log(`\n=== ${role.label} (${role.email}) HTTP ${role.httpStatus} 共 ${role.count} 条 ===`);
  if (role.error) { console.log('  ERROR', role.error); continue; }
  console.log('  可访问：', role.titles.join(' / '));
  console.log('  分到组：', role.visibleInGroups.join(' / '));
  console.log('  未分组（保持原位）：', role.ungrouped.join(' / ') || '（无）');
  console.log('  无权限（本就不该看到）：', role.notPermitted.length, '项');
}
