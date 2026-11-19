/**
 * ARC-V1 · 最小权限修复：剔除 `member` 对 ARC 页面路由的**自动授权**
 *
 * 问题（A6 实测，详见 docs/DEPLOY-RUNBOOK.md A5）：
 *   `desktopRoutes:create` 会自动授予 `admin` + `member`。member 的策略是
 *   `{"actions":["view:own"]}`，业务数据对它全 403（**数据没越界**），
 *   但它**能打开 ARC 页面**（`listAccessible` 200、页面渲染出标题），
 *   正文显示"列表加载失败 No permissions" —— 即 DEV-222 的形态。
 *   ⇒ 不符合最小权限：member 不该看到这个页面。
 *
 * 修复：删掉 member 对 ARC 两条路由的授权行。
 *   只删 member；**admin 与四个业务角色的授权一个字都不动**。
 *
 * 为什么可持续：插件源码 `grep -rn rolesDesktopRoutes src/` **零命中** ——
 *   自愈（repairRoleResources）只重写 `dataSourcesRolesResources`，不碰路由授权表。
 *   重启实测：删掉之后仍为 0，未被加回。
 *
 * 🔴 默认 **--dry-run（只读）**。要真正执行必须显式加 `--apply`。
 *    这是刻意的：本工具会改数据，不该"顺手跑一下就生效"。
 *
 * 用法：
 *   UAT_ROOT_EMAIL=... UAT_ROOT_PASSWORD=... node scripts/arc/arc-v1-fix-member-route-grant.mjs
 *   UAT_ROOT_EMAIL=... UAT_ROOT_PASSWORD=... node scripts/arc/arc-v1-fix-member-route-grant.mjs --apply
 *
 * 环境变量：SVC_UAT_BASE（默认 http://127.0.0.1:13001）
 */
import crypto from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_UAT_BASE || 'http://127.0.0.1:13001';
const APPLY = process.argv.includes('--apply');
const ARC_UIDS = ['n5c25yq5qlt', '97x481j2bv1'];
const MOBILE_ACC = '/api/desktopRoutes:listAccessible?layout=mobile-layout-model';
const uuid = () => crypto.randomUUID();

const ROOT = { email: process.env.UAT_ROOT_EMAIL, password: process.env.UAT_ROOT_PASSWORD };
if (!ROOT.email || !ROOT.password) {
  throw new Error('缺少 UAT_ROOT_EMAIL / UAT_ROOT_PASSWORD（本脚本刻意只读环境变量，不读凭据文件）');
}

async function signIn(account, password) {
  const r = await fetch(BASE + '/api/auth:signIn', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': uuid() },
    body: JSON.stringify({ account, password }),
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, token: j && j.data && j.data.token };
}
async function api(token, p, opt) {
  opt = opt || {};
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-Data-Source': 'main', 'X-Request-Id': uuid() },
      token ? { Authorization: 'Bearer ' + token } : {}, opt.role ? { 'X-Role': opt.role } : {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t.slice(0, 200) };
}

const out = [];
const rec = function (id, desc, pass, detail) {
  out.push({ id: id, desc: desc, pass: pass, detail: detail });
  console.log((pass === true ? 'PASS  ' : pass === false ? 'FAIL  ' : 'INFO  ') + id + '  ' + desc + (detail ? '\n        ' + detail : ''));
};

console.log('模式：' + (APPLY ? '⚠️  --apply（会真正写入）' : '✅ --dry-run（只读，不写入）'));
console.log('目标：' + BASE + '\n');

const s = await signIn(ROOT.email, ROOT.password);
rec('S0', '目标环境登录', s.status === 200 && !!s.token, 'status=' + s.status);
if (!s.token) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }
const tk = s.token;

// 定位 ARC 两条路由
const dr = await api(tk, '/api/desktopRoutes:list?paginate=false');
const routes = ((dr.json && dr.json.data) || []).filter(function (r) { return ARC_UIDS.indexOf(r.schemaUid) >= 0; });
const ids = routes.map(function (r) { return r.id; });
rec('S1', '定位 ARC 两条路由', ids.length === 2,
  routes.map(function (r) { return r.schemaUid + '#' + r.id; }).join(' , ') + '（注意：id 是目标库自己的，别照抄开发库）');
if (ids.length !== 2) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }

// 基线：member 是否真的可见（判据必须带 layout，否则恒 0、无区分力）
//
// 🔴 2026-11-11 修正（R0-CHG-01 §六）：
//    旧版把"S2 基线必须为 true"当成了通过条件，于是**一个本来就没有
//    member 授权的环境（= 更安全的目标状态）会被判成 FAIL**，
//    进而诱惑操作者去"制造一个含 ARC 的基线"再清理 —— 把发布逼向危险方向。
//
//    现在的语义是**三分支**，只有第三种才算问题：
//      ① 基线含 ARC、也有待删行  ⇒ 正常清理路径（旧版唯一的合法路径）
//      ② 基线不含 ARC、也无可删行 ⇒ **已经是目标状态**，跳过清理，PASS
//      ③ 基线含 ARC、却没有可删行（或反之）⇒ **状态自相矛盾**，FAIL
//         （说明判据本身在说谎：要么 listAccessible 读的不是同一份数据，
//           要么 rolesDesktopRoutes 的查询条件写错了）
const before = await api(tk, MOBILE_ACC, { role: 'member' });
const beforeArr = (before.json && before.json.data) || [];
const seesBefore = Array.isArray(beforeArr) && beforeArr.some(function (r) { return ARC_UIDS.indexOf(r.schemaUid) >= 0; });

// 待删行
const toDelete = [];
for (const rid of ids) {
  const q = await api(tk, '/api/rolesDesktopRoutes:list?filter=' + encodeURIComponent(JSON.stringify({ roleName: 'member', desktopRouteId: rid })));
  const rows = (q.json && q.json.data) || [];
  if (rows.length) toDelete.push(rid);
}

const baseDetail = 'status=' + before.status
  + ' 可见路由数=' + (Array.isArray(beforeArr) ? beforeArr.length : 'n/a')
  + ' 含 ARC=' + seesBefore
  + ' 待删行=' + toDelete.length;

if (seesBefore === false && toDelete.length === 0) {
  rec('S2', '基线：member 在 mobile 布局下**已不含** ARC（已是目标状态，无需清理）', true,
    baseDetail + '\n        ⇒ 走"跳过清理"分支：不要加 --apply；本步只需留证。');
} else if (seesBefore === true && toDelete.length > 0) {
  rec('S2', '基线：member 在 mobile 布局下可见 ARC，且有对应授权行可清理', true,
    baseDetail + '\n        ⇒ 走"定向清理"分支：确认后加 --apply。');
} else {
  rec('S2', '基线自相矛盾：可见性与授权行不一致（判据本身不可信）', false,
    baseDetail + '\n        ⇒ 先查清 listAccessible 与 rolesDesktopRoutes 为何不一致，不要 --apply。');
}

rec('S3', '清理动作：' + (toDelete.length ? '需删除 ' + toDelete.length + ' 行' : '无需删除（基线即目标状态）'),
  toDelete.length > 0 ? true : null,
  '涉及路由 id=' + (toDelete.join(',') || '(无)') + ' 行数=' + toDelete.length);

// 保护项：确认不会误删 admin / 业务角色
const adminQ = await api(tk, '/api/rolesDesktopRoutes:list?filter=' + encodeURIComponent(JSON.stringify({ roleName: 'admin', desktopRouteId: ids[0] })));
rec('S4', '保护项：admin 授权存在（本工具不动它）', !!((adminQ.json && adminQ.json.data) || []).length, 'admin 行数=' + (((adminQ.json && adminQ.json.data) || []).length));

const NEED_APPLY = toDelete.length > 0;

if (!APPLY) {
  rec('S5', 'dry-run 结束：未做任何写入', null,
    NEED_APPLY ? '如确认无误，加 --apply 重新运行。'
      : '⚠️ 本环境**无需清理**（member 本就不含 ARC 授权）⇒ **不要**加 --apply，'
        + '把 S2 的留证记入发布记录即可，然后继续 S6-C。');
  console.log('\n=== JSON ===');
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// 执行删除（无可删行时直接跳过，--apply 不会变成"误删点什么"）
const delStatus = [];
for (const rid of toDelete) {
  const r = await api(tk, '/api/rolesDesktopRoutes:destroy?filter=' + encodeURIComponent(JSON.stringify({ roleName: 'member', desktopRouteId: rid })), { method: 'POST' });
  delStatus.push(r.status);
}
rec('S6', '删除 member 授权（官方接口，复合键 filter）',
  delStatus.length === 0 ? null : delStatus.every(function (x) { return x < 400; }),
  delStatus.length === 0 ? '本次无可删行（基线即目标状态）' : 'statuses=' + delStatus.join(','));

// 复验：无论走哪个分支，**最终都必须不可见**
const after = await api(tk, MOBILE_ACC, { role: 'member' });
const afterArr = (after.json && after.json.data) || [];
const seesAfter = Array.isArray(afterArr) && afterArr.some(function (r) { return ARC_UIDS.indexOf(r.schemaUid) >= 0; });
rec('S7', '终态：member 在 mobile 布局下**不含** ARC（最终必须为 0）', seesAfter === false,
  'status=' + after.status + ' 可见路由数=' + (Array.isArray(afterArr) ? afterArr.length : 'n/a') + ' 含 ARC=' + seesAfter);

// 留证：member × ARC 的授权行数必须为 0（两种分支都要成立）
const finalRows = [];
for (const rid of ids) {
  const q = await api(tk, '/api/rolesDesktopRoutes:list?filter=' + encodeURIComponent(JSON.stringify({ roleName: 'member', desktopRouteId: rid })));
  finalRows.push(((q.json && q.json.data) || []).length);
}
rec('S7b', '留证：member × ARC 授权行数 = 0', finalRows.every(function (n) { return n === 0; }),
  '各路由行数=' + finalRows.join(','));

// 反向对照：业务角色仍可见（证明没删错）
// 🔴 必须用**真实持有 store_sales 角色的账号**登录，不能拿 root + X-Role: store_sales
//    —— root 不持有该角色，X-Role 会返回 401（ROLE_NOT_FOUND_FOR_USER），
//    那样得到的"不可见"是**账号不对**，不是"授权被删"，属假红。
// 🔴 R1-READY（2026-11-11）密钥审计修正：**去掉明文口令兜底**。
//   旧版把 `ARC_SALES_PASSWORD` 的兜底值写成了一个**明文口令常量** —— 那个兜底正是"口令进仓库"的入口：
//   正常路径读环境变量，一旦环境变量缺失就**静默回落到公开仓库里的常量**，
//   于是任何人 clone 后都能用这个口令登录（且没人会察觉它是从代码里来的）。
//   现在的语义：**要口令就得显式给**，给不出就明确报错。
//   （此处刻意**不复述**旧明文值：注释也会被密钥扫描器与 grep 命中，
//      "只在注释里留一份"等于没删 —— 本项目在 DEV-227/228 已吃过同类亏。）
const ARC_SALES_PASSWORD = process.env.ARC_SALES_PASSWORD;
if (!ARC_SALES_PASSWORD) {
  throw new Error('缺少 ARC_SALES_PASSWORD（反向对照需要真实持有 store_sales 的账号；本脚本不提供默认口令）');
}
const SALES = { email: process.env.ARC_SALES_EMAIL || 'arc1.sales.a@svc.local', password: ARC_SALES_PASSWORD };
const sS = await signIn(SALES.email, SALES.password);
let salesSees = false; let salesDetail = 'sales 登录失败 status=' + sS.status;
if (sS.token) {
  const sales = await api(sS.token, MOBILE_ACC);
  const salesArr = (sales.json && sales.json.data) || [];
  salesSees = Array.isArray(salesArr) && salesArr.some(function (r) { return ARC_UIDS.indexOf(r.schemaUid) >= 0; });
  salesDetail = 'status=' + sales.status + ' 可见路由数=' + (Array.isArray(salesArr) ? salesArr.length : 'n/a') + ' 含 ARC=' + salesSees;
}
rec('S8', '反向对照：store_sales 仍可见该页（证明只删了 member）', salesSees === true, salesDetail);

console.log('\n=== JSON ===');
console.log(JSON.stringify(out, null, 2));
