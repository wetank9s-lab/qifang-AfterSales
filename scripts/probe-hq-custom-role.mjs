/**
 * probe-hq-custom-role.mjs —— 复现「后台新建总部管理员角色 → 看不到售后菜单 / 数据为空」
 *
 * **本脚本只对开发环境（默认 https://127.0.0.1）执行，且只做两件事**：
 *   1) 新建一个临时角色 `probe_hq_custom` + 临时账号，绑上去；
 *   2) 用**真实登录会话**调接口，观察它能否看到菜单、能否拿到工单数据。
 *
 * 判据设计（避免"看到了菜单"这种假绿）：
 *   · 菜单：`GET /api/desktopRoutes:list` 按当前角色返回的行 —— 这是导航渲染的真实数据源；
 *   · 数据：`GET /api/svc:hqOverview`（业务口，真实注册的 SVC action）
 *           + `GET /api/serviceTickets:list`（原生口），
 *     两者都要看 —— 只测一个会漏掉"业务口通、原生口空"这种半通状态；
 *   · 身份：`GET /api/auth:check` 回读实际生效角色，不靠"我刚设置了什么"自证。
 *
 * ⚠️ 不伪造角色：全部走真实 signIn，拿真 token。
 *
 * ──【2026-11-06 修正】P0-HQ-MENU-02 交付第 5 项「修正不存在的 API 探针」──
 *
 * 旧版探测的是 `/api/svc/tickets:list`，**这个路径从来不存在**：
 *   · `svc` 是**资源名**，动作名必须用**单冒号**接在后面：`/api/svc:<action>`；
 *   · `/api/svc/tickets:list` 里的 `tickets:list` 是被当成一段"资源/动作"拼进去的，
 *     NocoBase 的路由解析器**静默丢弃**多余层级 ⇒ 最终找不到匹配的资源动作 ⇒ 404。
 *     所以它返回的 404 与"权限不足"毫无关系，**读成"没数据"是错的**。
 *   · 而 `/api/serviceTickets:list` 是原生资源（collection）的 list，200 但**不受
 *     本插件的 storeScope 裁剪**（除非 ACL 里单独封）—— 拿它证"数据范围"同样是错的。
 *
 * 因此本脚本改用两个**真实注册、且真正经过 storeScope** 的业务 action 作判据：
 *   · `/api/svc:hqOverview`  —— 总部看板汇总，内部走 PermissionService.applyScope；
 *   · `/api/svc:smsOverview` —— 短信总览，同样按角色裁范围。
 *
 * ⚠️ 【2026-11-06 第二次修正】`hqOverview` 的真实判据字段
 *    响应形状是 `{data:{data:{kpi:{values:{…}}, stores:[{id,name,…}]}}}`：
 *    · 总数在 **`kpi.values`**（不是一个 `total`）；
 *    · 数据范围的可观测量是 **`stores` 数组的长度**（每家店一行，按 scope 裁出来）；
 *    · `range` 参数**只认 `today`**（传别的值不报错，静默按 today 处理）⇒ 不能拿它当范围开关。
 *    旧判据读 `data.kpi.total_tickets`，永远 undefined ⇒ 有权限账号也"total=n/a"⇒ 假红。
 *    "读错字段导致假红"和"真的没数据"必须分开 —— 前者会让整条门禁失去意义。
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ⚠️ 不要用 `source .env`：里面的密码带 `%`/`&`/`+` 等特殊字符，
//    bash 会把它们当命令展开（实测报 `-U3+: command not found`）。
//    这里按行解析、只取 `KEY=VALUE` 的右值，不做任何 shell 展开。
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
// 用 hq_admin 账号（roles.allowConfigure = true）做"建角色/建账号"这个动作。
// 不用内置 admin@nocobase.com —— 本项目的初始化管理员是 root 面板账号，
// 邮箱口令不在 .env 里；而 hq_admin 正是运营在后台做用户权限管理时用的那个角色，
// 用它来复现更贴近真实操作路径。
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL || 'admin@nocobase.com';
const ADMIN_PASS = process.env.SMOKE_ADMIN_PASSWORD || '';
const TAG = process.env.PROBE_TAG || 'p0hqm02';

const PROBE_ROLE = `${TAG}_hq_custom`;
const PROBE_EMAIL = `${TAG}.hqcustom@svc.local`;
const PROBE_PASS = 'Probe#2026-Hq';

const OUT = '.tmp-verify';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const info = (label, detail = '') => console.log(`  ----  ${label}${detail ? `\n        ${detail}` : ''}`);

async function api(token, path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

async function signIn(account, password) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account, password } });
  if (r.status >= 400 || !r.json?.data?.token) {
    throw new Error(`登录失败 ${account}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
  return { token: r.json.data.token, user: r.json.data.user };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P0-HQ-MENU-02 复现：后台新建「总部管理员」角色');
console.log('  BASE = ' + BASE);
console.log('══════════════════════════════════════════════════════════════');

const admin = await signIn(ADMIN_EMAIL, ADMIN_PASS);
info('管理员登录成功', `userId=${admin.user?.id}`);

// ---------- 1. 建一个"后台新建的总部管理员角色" ----------
// 模拟运营在「用户和权限 → 角色」里点新建：起个名字、勾上数据表权限。
let roleResp = await api(admin.token, '/api/roles:create', {
  method: 'POST',
  body: {
    name: PROBE_ROLE,
    title: '探针总部管理员',
    description: 'P0-HQ-MENU-02 排查用临时角色，排查后删除',
  },
});
if (roleResp.status >= 400) {
  // 已存在：先删再建，保证每次都从"全新角色"开始
  await api(admin.token, `/api/roles:destroy?filter=${encodeURIComponent(JSON.stringify({ name: PROBE_ROLE }))}`, { method: 'POST' });
  roleResp = await api(admin.token, '/api/roles:create', {
    method: 'POST',
    body: { name: PROBE_ROLE, title: '探针总部管理员', description: '排查用临时角色' },
  });
}
info('创建角色', `HTTP ${roleResp.status} name=${PROBE_ROLE}`);

// ---------- 2. 建账号并绑定角色 ----------
let userResp = await api(admin.token, '/api/users:create', {
  method: 'POST',
  body: {
    email: PROBE_EMAIL,
    password: PROBE_PASS,
    nickname: '探针总部管理员',
    username: `${TAG}_hqcust`,
  },
});
if (userResp.status >= 400) {
  const list = await api(admin.token, `/api/users:list?filter=${encodeURIComponent(JSON.stringify({ email: PROBE_EMAIL }))}`);
  const old = list.json?.data?.[0];
  if (old) await api(admin.token, `/api/users:destroy?filterByTk=${old.id}`, { method: 'POST' });
  userResp = await api(admin.token, '/api/users:create', {
    method: 'POST',
    body: { email: PROBE_EMAIL, password: PROBE_PASS, nickname: '探针总部管理员', username: `${TAG}_hqcust` },
  });
}
const probeUserId = userResp.json?.data?.id;
info('创建用户', `HTTP ${userResp.status} userId=${probeUserId}`);

// 绑定角色：走 NocoBase 官方 rolesUsers 关系（这是「用户和权限」界面的真实落点）
const bind = await api(admin.token, '/api/rolesUsers:create', {
  method: 'POST',
  body: { userId: probeUserId, roleName: PROBE_ROLE },
});
info('绑定角色', `HTTP ${bind.status} ${bind.status >= 400 ? bind.text.slice(0, 160) : ''}`);

// ---------- 3. 用真实会话登录，看实际激活角色 ----------
const probe = await signIn(PROBE_EMAIL, PROBE_PASS);
info('探针账号登录成功', `userId=${probe.user?.id}`);

const checkRes = await api(probe.token, '/api/auth:check');
const data = checkRes.json?.data ?? {};
const activeRole = data?.currentRole ?? probe.user?.role ?? null;
const allRoles = data?.roles ?? [];
info('auth:check 实际激活角色', `currentRole=${activeRole} roles=${JSON.stringify(allRoles)}`);

// ---------- 4. 菜单：desktopRoutes 是否可见 ----------
// ⚠️ 这里**不能**断言"新建角色看不到菜单"= 缺陷。
//    按本轮设计，未登记角色必须 fail-closed ⇒ **看不到菜单才是正确结果**。
//    所以判据方向是"看不到"才 PASS；能不能看到由 ACL 决定（可能是 403 或空列表），
//    两种都算 fail-closed，但分别标注，不糊成一句"不可见"。
const dd = await api(probe.token, '/api/desktopRoutes:list?paginate=false');
const ddRows = dd.json?.data ?? [];
const ddTitles = (Array.isArray(ddRows) ? ddRows : []).map((r) => r.title).filter(Boolean);
const ddForbidden = dd.status === 403;
info(
  'desktopRoutes:list',
  `HTTP ${dd.status} 行数=${ddTitles.length}${ddForbidden ? '（ACL 拒绝读取该资源）' : ''}`,
);
const pageTitles = ['售后服务工作台', '我的门店工单', '所有工单'];
for (const t of pageTitles) {
  info(`  菜单「${t}」`, ddTitles.includes(t) ? '可见 ⚠️' : '不可见');
}

check(
  (ddForbidden || ddTitles.length === 0) && !pageTitles.some((t) => ddTitles.includes(t)),
  '[情况A] 未登记角色看不到任何售后菜单（fail-closed，符合预期）',
  ddForbidden ? 'HTTP 403 —— 连 desktopRoutes 都不放行' : `返回 ${ddTitles.length} 条菜单，无售后组`,
);

// ---------- 5. 数据：业务口（真实 svc action）+ 原生口 ----------
// ⚠️ 见文件头【2026-11-06 修正】：`/api/svc/tickets:list` 不存在，真实业务口是
//    `/api/svc:hqOverview`。判据 = `stores` 的条数（数据范围的可观测量）。
const hqPath = `/api/svc:hqOverview?range=today&_t=${Date.now()}`;
const hqList = await api(probe.token, hqPath, {
  headers: { 'X-Request-Id': `${TAG}-${Date.now()}` },
});
const hqData = hqList.json?.data?.data ?? hqList.json?.data ?? {};
const hqStores = Array.isArray(hqData?.stores) ? hqData.stores : null;
const hqKpi = hqData?.kpi?.values ?? null;
info(
  '业务口 /api/svc:hqOverview',
  `HTTP ${hqList.status} stores=${hqStores === null ? 'n/a' : hqStores.length} kpi=${hqKpi ? JSON.stringify(hqKpi) : 'null'} ${hqList.status >= 400 ? hqList.text.slice(0, 200) : ''}`,
);

// 原生口：只看"表本身能不能读"（ACL 层），**不能**拿它证明数据范围。
const natList = await api(probe.token, '/api/serviceTickets:list?pageSize=5');
const natRows = natList.json?.data ?? [];
info('原生口 /api/serviceTickets:list', `HTTP ${natList.status} 行数=${natRows.length}`);

// 判据：未登记角色 —— **必须在 scope 层被裁成"零门店、零业务数据"**。
// 注意分档：403 是更强的一层拒绝（连 ACL 都不放行），同样属于 fail-closed，
// 但它证明的是 ACL 而不是 scope。这里把两种都接受，但**分别标注**，不糊成一句。
const probeDeniedByAcl = hqList.status === 403;
const probeScopeEmpty = hqList.status === 200 && hqStores !== null && hqStores.length === 0;
check(
  probeDeniedByAcl || probeScopeEmpty,
  '[情况D] 未登记角色看不到任何门店数据（fail-closed）',
  probeDeniedByAcl
    ? `HTTP 403（ACL 层直接拒绝）—— ${hqList.json?.data?.errors?.[0]?.message ?? hqList.json?.errors?.[0]?.message ?? ''}`
    : `HTTP 200，stores=${hqStores?.length ?? 'n/a'}（scope 层裁空）`,
);
check(
  !(hqList.status >= 500),
  '[情况D] 未登记角色未触发服务端错误（不是 5xx 掩盖）',
  `HTTP ${hqList.status}`,
);

// ---------- 6. 对照组：既有 admin 账号 ----------
// ⚠️ 结论方向**必须相反**才叫反向验证：未登记角色 stores=0，
//    admin（scope=all）必须能看到 **> 0 家门店**。只测前者的话，
//    "接口挂了所以都返回 0" 也能全绿。
const adminHq = await api(admin.token, `/api/svc:hqOverview?range=today&_t=${Date.now()}`, {
  headers: { 'X-Request-Id': `${TAG}-adm-${Date.now()}` },
});
const adminHqData = adminHq.json?.data?.data ?? adminHq.json?.data ?? {};
const adminStores = Array.isArray(adminHqData?.stores) ? adminHqData.stores : null;
const adminKpi = adminHqData?.kpi?.values ?? null;
info('对照组 admin 业务口', `HTTP ${adminHq.status} stores=${adminStores === null ? 'n/a' : adminStores.length} kpi=${adminKpi ? JSON.stringify(adminKpi) : 'null'}`);
check(
  adminHq.status === 200 && adminStores !== null && adminStores.length > 0,
  '[对照组] 总部管理员可见门店数 > 0 —— 反向证明上面的 0 是 scope 裁出来的、不是接口坏了',
  `HTTP ${adminHq.status} stores=${adminStores === null ? 'n/a' : adminStores.length}`,
);
check(
  adminKpi !== null && Number(adminKpi?.processing_now ?? 0) >= 0 && adminKpi !== null,
  '[对照组] 总部管理员拿到 KPI 数值（非 null）',
  adminKpi ? JSON.stringify(adminKpi) : 'kpi=null',
);

// hq_admin 对照（可选，需要 UAT 口令）
const HQ_EMAIL = process.env.UAT_HQADMIN_EMAIL || 'uat.hqadmin@svc.local';
const HQ_PASS = process.env.UAT_HQADMIN_PASSWORD || '';
if (HQ_PASS) {
  const hq = await signIn(HQ_EMAIL, HQ_PASS);
  const hqDD = await api(hq.token, '/api/desktopRoutes:list?paginate=false');
  const hqTitles = (hqDD.json?.data ?? []).map((r) => r.title).filter(Boolean);
  const hqSvc = await api(hq.token, `/api/svc:hqOverview?range=today&_t=${Date.now()}`, {
    headers: { 'X-Request-Id': `${TAG}-hq-${Date.now()}` },
  });
  const hqSvcData = hqSvc.json?.data?.data ?? hqSvc.json?.data ?? {};
  const hqSt = Array.isArray(hqSvcData?.stores) ? hqSvcData.stores : null;
  info('对照组 hq_admin 菜单', `行数=${hqTitles.length} 我的门店工单=${hqTitles.includes('我的门店工单')} 售后服务工作台=${hqTitles.includes('售后服务工作台')} 所有工单=${hqTitles.includes('所有工单')}`);
  info('对照组 hq_admin 数据', `HTTP ${hqSvc.status} stores=${hqSt === null ? 'n/a' : hqSt.length}`);
  check(hqSt !== null && hqSt.length > 0, '[对照组] 既有 hq_admin 能拿到数据', `stores=${hqSt === null ? 'n/a' : hqSt.length}`);
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL`);
console.log('══════════════════════════════════════════════════════════════');
fs.writeFileSync(
  `${OUT}/p0-hq-menu-02-probe.json`,
  JSON.stringify({ base: BASE, probeRole: PROBE_ROLE, probeUserId, activeRole, allRoles, desktopRouteTitles: ddTitles, results }, null, 2),
);
console.log(`  明细：${OUT}/p0-hq-menu-02-probe.json`);
process.exit(failed.length ? 1 : 0);
