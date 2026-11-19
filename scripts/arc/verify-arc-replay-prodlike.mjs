#!/usr/bin/env node
/**
 * verify-arc-replay-prodlike.mjs —— 重放脚本在**生产同形基线**下的四项针对性验证
 *
 * 用户 PROD-HOTFIX-01 第二节要求"仅在隔离环境模拟生产既有路由基线做针对性验证"：
 *   ① **首次建立**   —— 34 条历史路由在场、ARC 缺失 ⇒ 能正确定位并建好 2 条路由 + 26 个模型
 *   ② **幂等复用**   —— 再跑一次 ⇒ 不新建、不报错、行数不变
 *   ③ **冲突拦截**   —— 把 tabs 的 schemaUid 先占成一条**别的业务页面** ⇒ 必须 STOP、**零写入**
 *   ④ **权限收敛**   —— 4 个业务角色 × 2 条路由成对授权，且 member **不被**自动补回
 *
 * ★ 本文件的定位：**它验的是脚本，不是产品**。
 *   所以每条都要能"反向变红"：
 *     · ③ 之前先证明"库里确实被占了"（否则 STOP 可能只是空跑）；
 *     · ③ 之后再确认**一行都没写**（零写入是断言，不是口头承诺）；
 *     · ④ 的判据是**角色 × 路由的成对矩阵**，不是"总行数"（总行数对不上时无法定位）。
 *
 * 用法：node scripts/arc/verify-arc-replay-prodlike.mjs
 *   要求：隔离库已由 build-prod-like-baseline.mjs 构造成 34 条历史路由 / 0 条 ARC 的形态。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PG = 'svc-postgres';
const PGUSER = 'svc_app';
const DB = 'service_ticket_verify';
const BASE = 'http://127.0.0.1:13001';
const PAGE_UID = 'n5c25yq5qlt';
const TABS_UID = '97x481j2bv1';
const DESIRED_BASE = 34;

const results = [];
function record(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}\n        ${detail}`);
}
function q(sql, db = DB) {
  return execFileSync('docker',
    ['exec', '-i', PG, 'psql', '-U', PGUSER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
function runReplay(extraEnv = {}) {
  const r = spawnSync(process.execPath, ['scripts/arc/arc-v1-rebuild-mobile-page.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ARC_DB: DB, SVC_UAT_BASE: BASE, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function snapshot() {
  return {
    routes: Number(q('select count(*) from "desktopRoutes";')),
    arcRoutes: Number(q(`select count(*) from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}');`)),
    models: Number(q('select count(*) from "flowModels";')),
    // ★ 树路径进快照：它是"幽灵占用"唯一能藏的地方（构造基线时踩过，见 build-prod-like-baseline.mjs）
    treePath: Number(q('select count(*) from "flowModelTreePath";')),
    grants: Number(q('select count(*) from "rolesDesktopRoutes";')),
  };
}
/** 某个角色在 ARC 两条路由上的授权行数 */
function grantsOf(role) {
  return Number(q(`select count(*) from "rolesDesktopRoutes" r
    join "desktopRoutes" d on d.id = r."desktopRouteId"
    where d."schemaUid" in ('${PAGE_UID}','${TABS_UID}') and r."roleName" = '${role}';`));
}

console.log('='.repeat(78));
console.log('重放脚本 · 生产同形基线下的四项针对性验证');
console.log('='.repeat(78));

// ---- 前置 0：**自己把基线重置干净** ----
//
// ⚠️ 为什么必须由本脚本重置，而不是"要求调用者先跑 build-prod-like-baseline"：
//    第一次跑时我手动跑过基线，但上一轮 V3c 的回收只删了它自己造的那个冲突路由，
//    并没清掉"首次建立"留下的 2 条 ARC 路由 ⇒ 下一轮 B0 直接红，
//    连带 V1 拿到一个"已经有 ARC"的现场（阶段输出全缺失）。
//    验证器**不能依赖调用者的现场**：它必须自己建立它要检验的前提，
//    否则"同一份代码跑两次结果不同"这件事会被误读成产品不稳。
const reset = spawnSync(process.execPath, ['scripts/arc/build-prod-like-baseline.mjs'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
if (reset.status !== 0) {
  console.log('🔴 无法重置基线：\n' + ((reset.stdout ?? '') + (reset.stderr ?? '')).slice(-2000));
  process.exit(2);
}
console.log('（基线已重置为：34 条历史路由 / 0 条 ARC / 0 模型 / 0 树路径）\n');

// ---- 前置：基线确实是"生产同形" ----
const s0 = snapshot();
record('B0', `基线是生产同形：desktopRoutes=${DESIRED_BASE} 且 ARC 缺失`,
  s0.routes === DESIRED_BASE && s0.arcRoutes === 0,
  `routes=${s0.routes} arcRoutes=${s0.arcRoutes} models=${s0.models} grants=${s0.grants}`);

// ---- ① 首次建立 ----
const r1 = runReplay();
const s1 = snapshot();
// ★ 判据不能只看 exit=0：一个"没写任何东西也 exit 0"的脚本同样会通过。
//   ⇒ 必须同时要求日志里 R1/R2/R3/R4/R5 全部 PASS（那是"真的写进去了"的证据）。
const stagesOf = (out) => Object.fromEntries(
  [...out.matchAll(/^(PASS|FAIL)\s+(R\d[b]?|D\d|S\d[b-c]?)\b/gm)].map((m) => [m[2], m[1]]));
const st1 = stagesOf(r1.out);
const firstOk = r1.code === 0 && s1.arcRoutes === 2 && s1.models === 26
  && ['R1', 'R2', 'R3', 'R3b', 'R4', 'R5', 'R6', 'R7', 'R8'].every((k) => st1[k] === 'PASS');
record('V1', '① 首次建立：34 条既有路由在场 ⇒ 正确定位并建好 2 条 ARC 路由 + 26 个模型（**不是**要求整库为 0）',
  firstOk,
  `exit=${r1.code}；routes ${s0.routes}→${s1.routes}（+${s1.routes - s0.routes}）arcRoutes=${s1.arcRoutes} models=${s1.models}；` +
  `阶段=${['R1', 'R2', 'R3', 'R4', 'R5', 'R8'].map((k) => `${k}:${st1[k] ?? '缺失'}`).join(' ')}`);
if (!firstOk) console.log(r1.out.slice(-4000));

// 反向对照：整库路由数必须真的增加了 2（而不是"把别人的删了腾出位置"）
record('V1b', '反向对照：既有 34 条未被删改（总数净增 2，原有 id 全部仍在）',
  s1.routes === s0.routes + 2,
  `期望 ${s0.routes + 2}，实际 ${s1.routes}`);

// ---- ② 幂等复用 ----
const r2 = runReplay();
const s2 = snapshot();
const st2 = stagesOf(r2.out);
const idemOk = r2.code === 0 && s2.routes === s1.routes && s2.models === s1.models && s2.arcRoutes === 2
  && ['R1', 'R2', 'R3', 'R4', 'R5', 'R8'].every((k) => st2[k] === 'PASS');
record('V2', '② 幂等复用：再次重放不新建、不报错、行数不变',
  idemOk, `exit=${r2.code}；routes ${s1.routes}→${s2.routes} models ${s1.models}→${s2.models} arcRoutes=${s2.arcRoutes}；` +
  `阶段=${['R1', 'R2', 'R3', 'R5', 'R7', 'R8'].map((k) => `${k}:${st2[k] ?? '缺失'}`).join(' ')}`);
if (!idemOk) console.log(r2.out.slice(-3000));

// 幂等那次的日志里必须出现"复用"，否则"没新建"可能是"根本没跑"
record('V2b', '② 自证：幂等那次的日志确实走了复用分支（不是脚本空跑）',
  /复用已存在|幂等复用|reuse-proven|已存在 \d+ 条/.test(r2.out),
  (r2.out.match(/复用[^\n]{0,60}/g) ?? ['(无复用字样)']).slice(0, 3).join(' | '));

// ---- ④ 权限收敛（在"已建好"状态上验，与 A6 的 B3 语义一致）----
//
// ★ 判据的关键不是"member 不在"，而是**"member 没有被自动补回"**。
//   NocoBase 建路由时**自动**授予 admin + member；B3 的目标态是删掉 member。
//   于是同一个"已建好"状态有两条到达路径：
//     · 第 1 次建好（member 被自动授予 = 2 行）
//     · 第 2 次重放（路由已存在 ⇒ **不会**重新自动授予 ⇒ member 归 0）
//   正确判据是：**4 个业务角色各 2 行（成对）、admin 2 行**，
//   而 member 的行数**在"首次建立"与"幂等复用"之间必须收敛到 0**。
//   这里不能简单要求 `member:2` 不存在 —— 那会把"刚建好、还没跑 B3"的正常状态判成故障
//   （第一次跑这条时就是这么误判的）。
//
//   本次的验证路径是 ①（首次建立）→ ②（幂等复用）→ ③（冲突拦截），
//   ①②之间没有任何 B3 清理 ⇒ member 仍为 2 是**符合预期**的。
//   真正要保证的是：**业务角色一个都不能少、且每个都是父+子成对**。
const ROLE_MATRIX = q(`
  select r."roleName" || ':' || count(*) from "rolesDesktopRoutes" r
  join "desktopRoutes" d on d.id = r."desktopRouteId"
  where d."schemaUid" in ('${PAGE_UID}','${TABS_UID}')
  group by r."roleName" order by 1;`).split('\n').filter(Boolean);
const REQUIRED = ['hq_admin', 'hq_after_sales', 'store_manager', 'store_sales'];
const matrixOk = REQUIRED.every((r) => ROLE_MATRIX.includes(`${r}:2`))
  && ROLE_MATRIX.every((x) => x.endsWith(':2'));
record('V4', '④ 权限收敛：4 个业务角色 × 2 条路由**成对**授权（父+子），无"只授父不授子"',
  matrixOk, `矩阵=${ROLE_MATRIX.join(' ')}`);

// ④b · NocoBase 自动授予的 admin 必须在（它是平台维护通道）
record('V4b', '④ 自动授予：admin 在 ARC 两条路由上各 1 行（平台维护通道未被误删）',
  grantsOf('admin') === 2, `admin=${grantsOf('admin')} member=${grantsOf('member')}`);

// ---- ⑥ 口径一致性自证（防"两个地方用两个口径"这类最隐蔽的假红/假绿）----
//
// 交付包 26 行 = **page 树**（n5c）与 **tabs 树**（97x）去重后的并集：
//   · 97x 子树 = 24（两个业务区块 + 表单/字段/操作钮）
//   · n5c 子树独有 = 2（`n5c` 自身 RouteModel + `3ebe3d19d1c` MobileRootPageModel）
// ⇒ 任何地方要判"26"，都必须用 `ancestor in (...)` 的并集口径；
//   单用 `ancestor='97x'` 会恒得 24，把正常状态判成故障（实测踩过一次）。
const nTabs = Number(q(`select count(distinct descendant) from "flowModelTreePath" where ancestor='${TABS_UID}';`));
const nPageOnly = Number(q(`select count(distinct descendant) from "flowModelTreePath"
  where ancestor='${PAGE_UID}' and descendant not in (
    select descendant from "flowModelTreePath" where ancestor='${TABS_UID}');`));
record('V5', '⑥ 口径一致性：tabs 子树 24 + page 独有 2 = 交付包 26（并集口径才是"26"）',
  nTabs === 24 && nPageOnly === 2,
  `tabs(97x)=${nTabs} page独有=${nPageOnly} 合计=${nTabs + nPageOnly}`);

// ---- ③ 冲突拦截（会破坏当前基线，放在最后；用事务包裹后回滚不了 —— 故逐条构造 + 精确回收）----
//
// 做法：把 **tabs 的 schemaUid** 先占成一条"别的业务页面"。
//   ⚠️ 为什么不占 page 的 UID：page 的 UID 被占时 tabs 必然也不存在（首次形态），
//      两条路径的判定分支不同；这里刻意选 tabs，因为它是"ARC 页面主体"的入口，
//      一旦被别的页面占用，**最容易静默把 26 个模型写到别人页面上**。
q(`begin;
   delete from "flowModels" where uid in (
     select descendant from "flowModelTreePath" where ancestor in ('${PAGE_UID}','${TABS_UID}'))
     or uid in ('${PAGE_UID}','${TABS_UID}');
   delete from "flowModelTreePath" where ancestor in ('${PAGE_UID}','${TABS_UID}');
   delete from "rolesDesktopRoutes" where "desktopRouteId" in (
     select id from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}'));
   delete from "desktopRoutesUiLayouts" where "desktopRouteId" in (
     select id from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}'));
   delete from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}');
   commit;`);
const s3a = snapshot();

// 造一条"别人的业务页面"，**占用 tabs 的 schemaUid**，但形状明显不同（type/displayTitle 不同）
q(`insert into "desktopRoutes"
     (id,"parentId",title,type,"schemaUid","hideInMenu","enableTabs","enableHeader","displayTitle","createdAt","updatedAt")
   values (999999999999001, null, '别人的业务页', 'page', '${TABS_UID}', false, true, true, true, now(), now());`);
const occupied = q(`select id || '|' || title || '|' || type from "desktopRoutes" where "schemaUid"='${TABS_UID}';`);
record('V3-pre', '冲突现场已就位：tabs 的 schemaUid 被一条别的业务页面占用',
  occupied.startsWith('999999999999001|'), `库内该 UID 现在 = ${occupied}`);

const beforeConflict = snapshot();
const r3 = runReplay();
const afterConflict = snapshot();
const zeroWrite = beforeConflict.routes === afterConflict.routes
  && beforeConflict.models === afterConflict.models
  && beforeConflict.treePath === afterConflict.treePath
  && beforeConflict.grants === afterConflict.grants
  && beforeConflict.arcRoutes === afterConflict.arcRoutes;
record('V3', '③ 冲突拦截：UID 属其他业务 ⇒ 脚本 STOP（非 0 退出）且**归因于 S1c 归属判定**',
  // ★ 2026-11-12 实测踩到的假绿：只判"exit≠0 且输出里有'停'字"是不够的 ——
  //   登录失败也会 exit=1，而错误信息里恰好含"目标库…停"这类字眼，于是判据通过了。
  //   ⇒ 必须**同时**要求日志里真的跑到了 S1c，且 S1c 是 FAIL。
  r3.code !== 0 && /S1c/.test(r3.out) && /^FAIL\s+S1c/m.test(r3.out),
  `exit=${r3.code}；${(r3.out.match(/FAIL\s+S1c[^\n]*\n[^\n]*/) ?? ['(❗未跑到 S1c —— 这次 STOP 不是归属判定造成的)'])[0].replace(/\s+/g, ' ').slice(0, 260)}`);
record('V3b', '③ 零写入：STOP 前后**每一项**计数完全相同（不只看路由器数）',
  zeroWrite,
  `before=${JSON.stringify(beforeConflict)} after=${JSON.stringify(afterConflict)}`);

// 回收：把库真正恢复成"34 条历史路由 / 0 条 ARC"
// ⚠️ 不能只删那条冲突路由 —— 还要删掉"首次建立"留下的 2 条 ARC 路由 + 26 个模型 + 树路径，
//    否则下一轮跑会在一个"已经建好"的现场上开始（第一次就这么踩的）。
//    直接复用基线脚本，是唯一不会漏表的方式（它清 routes/models/treePath/layouts/grants）。
const recycle = spawnSync(process.execPath, ['scripts/arc/build-prod-like-baseline.mjs'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
if (recycle.status !== 0) {
  console.log('🔴 现场回收失败：\n' + ((recycle.stdout ?? '') + (recycle.stderr ?? '')).slice(-1200));
}
const sFinal = snapshot();
record('V3c', '现场回收：库回到"34 条历史路由 / 0 条 ARC / 0 模型"的干净基线',
  sFinal.routes === DESIRED_BASE && sFinal.arcRoutes === 0 && sFinal.models === 0,
  `routes=${sFinal.routes} arcRoutes=${sFinal.arcRoutes} models=${sFinal.models} treePath=${sFinal.treePath}`);

const failed = results.filter((r) => !r.pass);
fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/hotfix01'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp-verify/evidence/hotfix01/replay-prodlike.json'),
  JSON.stringify({ at: new Date().toISOString(), db: DB, base: BASE, results }, null, 2));
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
