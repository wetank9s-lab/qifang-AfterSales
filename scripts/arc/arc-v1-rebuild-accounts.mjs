/**
 * ARC-V1 / A6 补证 · **隔离环境业务账号准备**（用户 §2 验证的前提）
 *
 * 为什么需要它：隔离库是全新初始化的，只有 root 一个账号（`admin@nocobase.com`）；
 *   而 §2 要求"销售可打开录入页 / 负责人·总部管理员·总部售后可打开只读页"。
 *   四个业务角色在隔离库里**已自动建好**（`roles` / `dataSourcesRoles` 都在），
 *   缺的只是"账号 → 角色 → 门店"这三层绑定。
 *
 * 复用既有机制（**不自研**）：建号/绑角色/绑门店三步全部照搬 `scripts/arc-a1-accounts.mjs`
 *   的做法 —— 走官方 `users:create` / `rolesUsers:create` / `storeUsers:create`，
 *   **不直插数据库**（本项目踩过：直插 `rolesUsers` 后 `X-Role` 报 `ROLE_NOT_FOUND_FOR_USER`）。
 *
 * 幂等：三步全部"先查后建"，重复执行不产生重复行。
 *
 * 用法：UAT_ROOT_PASSWORD=... node .tmp-verify/a6/rebuild-accounts.mjs
 */
import crypto from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_UAT_BASE || 'http://127.0.0.1:13001';

const ROOT = { email: process.env.UAT_ROOT_EMAIL, password: process.env.UAT_ROOT_PASSWORD };

// 🔴 R1-READY（2026-11-11）密钥审计修正：**口令一律只从环境变量读，绝不写死在脚本里**。
//   本节与该文件的交付声明（docs/ARC-V1-DELIVERY-FILES.md「口令只走环境变量」）原本自相矛盾：
//   旧版这里硬编码了明文口令，一旦随交付进公开仓库，等于把隔离环境四个业务账号的口令公开。
//   为什么隔离环境的口令也当密钥处理：它是**与开发库同形**的账号口径，
//   同一套口令往往被沿用到其它环境；"反正是测试库"是最容易导致生产口令外泄的那类推理。
const PW = process.env.ARC_ACCOUNT_PASSWORD;
if (!PW) {
  throw new Error('缺少 ARC_ACCOUNT_PASSWORD（本脚本刻意只读环境变量，不读凭据文件、不写默认口令）');
}

/** 与开发库同形：销售A(1店) / 负责人A(1店) / 总部管理员 / 总部售后 */
const ACCOUNTS = [
  { email: 'arc1.sales.a@svc.local', username: 'arc1_sales_a', nickname: 'A店销售', role: 'store_sales', stores: [1] },
  { email: 'arc1.mgr.a@svc.local', username: 'arc1_mgr_a', nickname: 'A店负责人', role: 'store_manager', stores: [1] },
  { email: 'uat.hqadmin@svc.local', username: 'uat_hqadmin', nickname: 'UAT-HA', role: 'hq_admin', stores: [] },
  { email: 'uat.hq@svc.local', username: 'uat_hq', nickname: 'UAT-HQ', role: 'hq_after_sales', stores: [] },
];

const results = [];
// ⚠️ 箭头函数没有 arguments 绑定 —— 必须用 rest 参数做参数个数校验
//    （rebuild-mobile-page.mjs 用的是 function，那里 arguments 可用）
const record = (...args) => {
  const [id, desc, pass, detail] = args;
  if (args.length !== 4) throw new Error(`record 参数个数错误：${id}`);
  if (typeof pass !== 'boolean') throw new Error(`record 第3参必须是 boolean：${id}`);
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`);
};

const api = async (token, p, opt = {}) => {
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Data-Source': 'main',
      'X-Request-Id': crypto.randomUUID(),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};

console.log('='.repeat(78));
console.log(`ARC-V1 · 隔离环境业务账号准备   实例=${BASE}`);
console.log('='.repeat(78));

const tk = (await api(null, '/api/auth:signIn', {
  method: 'POST', body: { account: ROOT.email, password: ROOT.password },
})).json?.data?.token;
if (!tk) { console.error('root 登录失败'); process.exit(1); }
console.log('root 登录完成\n');

// 门店 1 必须存在（账号要绑到它）
const stores = (await api(tk, '/api/stores:list?pageSize=5')).json?.data || [];
record('A0', '隔离库已有门店数据（15 家由插件 seed 建好）',
  stores.length > 0, `门店数=${stores.length}${stores[0] ? `；示例=${stores[0].name}` : ''}`);

let created = 0, bound = 0, boundStore = 0, removedMember = 0;
for (const acc of ACCOUNTS) {
  const found = await api(tk, `/api/users:list?filter=${encodeURIComponent(JSON.stringify({ email: acc.email }))}`);
  let userId = found.json?.data?.[0]?.id;
  if (!userId) {
    const c = await api(tk, '/api/users:create', {
      method: 'POST',
      body: { email: acc.email, username: acc.username, nickname: acc.nickname, password: PW },
    });
    if (c.status >= 400) { console.log(`  ✗ 建号失败 ${acc.email}: ${c.status} ${c.text.slice(0, 140)}`); continue; }
    userId = c.json?.data?.id; created++;
    console.log(`  ✓ 建号 ${acc.email} id=${userId}`);
  } else {
    console.log(`  · 已存在 ${acc.email} id=${userId}`);
  }

  const hasRole = await api(tk, `/api/rolesUsers:list?filter=${encodeURIComponent(JSON.stringify({ userId, roleName: acc.role }))}`);
  if ((hasRole.json?.data ?? []).length === 0) {
    const r = await api(tk, '/api/rolesUsers:create', { method: 'POST', body: { userId, roleName: acc.role } });
    if (r.status < 400) { bound++; console.log(`    ✓ 绑角色 ${acc.role}`); }
    else console.log(`    ✗ 绑角色失败 ${r.status} ${r.text.slice(0, 140)}`);
  } else console.log(`    · 角色已绑 ${acc.role}`);

  /**
   * ⚠️ 必须清掉多余的 `member` 角色。
   *    `users:create` 建的账号会**自动带 member**（NocoBase 默认角色）。
   *    而开发库这 15 个业务账号**都是单一角色**（实测：15 个账号各 1 个角色，
   *    `member` 全库只绑 1 个、且不是业务账号）。
   *    带着 member 的后果不是"多一个角色"这么轻：
   *    浏览器会话会选中 member（`roles:check` 返回 role=member、
   *    `strategy.actions=["view:own"]`）⇒ 业务集合一律 403 ⇒
   *    **页面能打开但正文显示"列表加载失败 No permissions"**，
   *    真机验收会被误读成"权限没配好"。
   */
  /**
   * ⚠️ 删除口径：`rolesUsers` 主键是**复合键 (roleName, userId)**，**没有 id 列**
   *    ⇒ `filterByTk=<row.id>` 会报 `Invalid SQL column or table reference`。
   *    必须按复合键 filter 删除。`storeUsers` 同理（(user_id, store_id)），
   *    但它有自增 id 列，所以两种写法都能用 —— 这里统一用复合键更稳。
   */
  const memberRows = (await api(tk, `/api/rolesUsers:list?filter=${encodeURIComponent(JSON.stringify({ userId, roleName: 'member' }))}`)).json?.data ?? [];
  for (const row of memberRows) {
    const d = await api(tk, `/api/rolesUsers:destroy?filter=${encodeURIComponent(JSON.stringify({ userId, roleName: 'member' }))}`, { method: 'POST' });
    if (d.status < 400) { removedMember++; console.log(`    ✓ 移除多余角色 member`); }
    else console.log(`    ✗ 移除 member 失败 ${d.status} ${d.text.slice(0, 120)}`);
  }

  for (const sid of acc.stores) {
    const has = await api(tk, `/api/storeUsers:list?filter=${encodeURIComponent(JSON.stringify({ user_id: userId, store_id: sid }))}`);
    if ((has.json?.data ?? []).length === 0) {
      /**
       * 🔴 字段名陷阱（本机实测）：
       *    `storeUsers` 集合 `underscored: true`，且两个字段是 **belongsTo 关系**，
       *    其 API 名是**关系名 `user` / `store`**（`foreignKey` 才是 `user_id` / `store_id`）。
       *    传 `{ userId, storeId }` 不会报错，但会被**静默丢弃**写成 NULL 行
       *    （既有脚本 arc-a1-accounts.mjs 就是这么写的 —— 它没验证回读，所以没发现）。
       *    ⇒ 必须传 `{ user, store }`，并**回读校验非空**。
       */
      const r = await api(tk, '/api/storeUsers:create', { method: 'POST', body: { user: userId, store: sid } });
      const row = r.json?.data;
      const okRow = r.status < 400 && row && (row.userId ?? row.user_id) && (row.storeId ?? row.store_id);
      if (okRow) { boundStore++; console.log(`    ✓ 绑门店 ${sid}（回读 user_id=${row.userId ?? row.user_id} store_id=${row.storeId ?? row.store_id}）`); }
      else console.log(`    ✗ 绑门店 ${sid} 未生效：${r.status} ${r.text.slice(0, 140)}`);
    } else console.log(`    · 门店已绑 ${sid}`);
  }
}

// ---- 自证：四个账号能真实登录，且角色正确 ----
console.log('\n--- 自证：四个账号真实登录 ---');
let loginOk = 0;
const loginDetail = [];
for (const acc of ACCOUNTS) {
  const r = await api(null, '/api/auth:signIn', { method: 'POST', body: { account: acc.email, password: PW } });
  const t = r.json?.data?.token;
  if (t) {
    const me = await api(t, '/api/auth:check');
    const roles = (me.json?.data?.roles || []).map((x) => x.name);
    loginOk++;
    loginDetail.push(`${acc.email}→[${roles.join(',')}]`);
  } else loginDetail.push(`${acc.email}→登录失败(${r.status})`);
}
record('A1', '四个业务账号全部能真实登录（密码已生效）',
  loginOk === ACCOUNTS.length, `${loginOk}/${ACCOUNTS.length}；${loginDetail.join(' | ')}`);

const roleOk = loginDetail.every((d, i) => d.includes(ACCOUNTS[i].role));
record('A2', '每个账号的角色与预期一致（销售/负责人/总部管理员/总部售后）',
  roleOk, loginDetail.join(' | '));

// ---- 自证：门店绑定必须**真的非空**（防"传错字段名写成 NULL 行"） ----
const { execFileSync } = await import('node:child_process');
const psql = (sql) => execFileSync('docker',
  ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket_verify',
    '-A', '-t', '-F', '|', '-f', '-'], { input: sql, encoding: 'utf8' }).trim();
const storeBind = psql(`select u.email||'→'||coalesce(su.store_id::text,'NULL')
  from users u left join store_users su on su.user_id=u.id
  where u.email in ('arc1.sales.a@svc.local','arc1.mgr.a@svc.local') order by 1;`).split('\n').filter(Boolean);
const nullRows = psql(`select count(*) from store_users where user_id is null or store_id is null;`);
record('A3', '门店绑定真实落到 user_id/store_id（无 NULL 空行）',
  storeBind.length === 2 && storeBind.every((x) => !x.endsWith('→NULL')) && Number(nullRows) === 0,
  `${storeBind.join(' | ')}；全表 NULL 行=${nullRows}`);

// ---- 自证：四个业务账号**只有业务角色**，没有多余的 member ----
//   与开发库对齐（开发库 15 个业务账号各恰好 1 个角色）。
//   留着 member 会让浏览器选中 member ⇒ 页面正文"No permissions"。
const roleCounts = psql(`select u.email||'='||count(*)
  from users u join "rolesUsers" ru on ru."userId"=u.id
  where u.email in ('arc1.sales.a@svc.local','arc1.mgr.a@svc.local','uat.hq@svc.local','uat.hqadmin@svc.local')
  group by u.email order by 1;`).split('\n').filter(Boolean);
record('A4', '四个业务账号都恰好 1 个角色（与开发库口径一致，无多余 member）',
  roleCounts.length === 4 && roleCounts.every((x) => x.endsWith('=1')),
  `${roleCounts.join(' | ')}；本次移除 member ${removedMember} 条`);

console.log('\n本次新建账号 %d 个、新绑角色 %d 条、新绑门店 %d 条', created, bound, boundStore);
const failed = results.filter((r) => !r.pass);
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
