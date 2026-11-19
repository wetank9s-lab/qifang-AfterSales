#!/usr/bin/env node
/**
 * build-prod-like-baseline.mjs —— 在隔离库构造**生产库同形基线**（PROD-HOTFIX-01 专用）
 *
 * 生产库的真实形态（2026-11-12 实测，见 docs/DEPLOY-RUNBOOK.md R1.8）：
 *   · `desktopRoutes` = **34** 条历史业务路由
 *   · **无** ARC 页面（`n5c25yq5qlt` / `97x481j2bv1` 都不存在）
 *   · 角色 9 个（原 7 + 2 个 ARC 角色）
 *
 * 为什么需要它：
 *   重放脚本原来的 S1 判据要求"整库 0/0/0"，而生产有 34 条 ⇒ 对生产**必然假红**。
 *   要证明"改后的脚本能在生产形态下跑通"，就必须先有一个**同形**的隔离库。
 *   拿一个空库去跑只能证明"空库能跑"，证明不了用户关心的那件事。
 *
 * 做法（**不改任何业务数据**）：
 *   1) 把隔离库重置成"空路由 + 空模型"（只动这两张 UI 配置表 + 其关联表）；
 *   2) 从开发库 `service_ticket` 复制 **34 条不含 ARC 的** `desktopRoutes` 行
 *      （连同 `desktopRoutesUiLayouts` 关联），得到"有历史业务页、但没有 ARC"的基线。
 *
 * ⚠️ 顺序/命名空间约束：`desktopRoutes` 与 `flowModels` 共用 uid 命名空间，
 *    所以复制过去的 34 条路由其 uid 在 flowModels 里**可能不存在**（开发库里那些页面的
 *    模型本就不在 flowModels 表里 —— 它们是 svc 页面）。这不影响 ARC 重放，
 *    因为 ARC 的两条 uid 与它们不冲突（脚本的归属判据会证明这一点）。
 *
 * 用法：
 *   node scripts/arc/build-prod-like-baseline.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DRY = process.argv.includes('--dry-run');
const PG = 'svc-postgres';
const PGUSER = 'svc_app';
const DEV = 'service_ticket';
const TARGET = 'service_ticket_verify';
const ARC_UIDS = ['n5c25yq5qlt', '97x481j2bv1'];
const DESIRED = 34;

function psql(sql, db, label = '') {
  try {
    return execFileSync('docker',
      ['exec', '-i', PG, 'psql', '-U', PGUSER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
      { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    const msg = String(e.stderr || e.message || e).slice(0, 500);
    throw new Error(`[${label || db}] psql 失败：${msg}`);
  }
}

console.log('='.repeat(78));
console.log(`构造"生产同形"基线   目标=${TARGET}  来源=${DEV}${DRY ? '   [DRY-RUN]' : ''}`);
console.log('='.repeat(78));

// ---- 0. 目标库自证 ----
const db = psql('select current_database();', TARGET);
if (db !== TARGET) throw new Error(`目标库不符：${db} != ${TARGET}`);
console.log(`OK  current_database()=${db}`);

// ---- 1. 从开发库挑 34 条不含 ARC 的根候选 ----
const devRows = JSON.parse(psql(`
  select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select d.id, d."parentId", d.title, d.tooltip, d.icon, d."schemaUid", d."menuSchemaUid",
           d."tabSchemaName", d.type, d.options, d.sort, d."hideInMenu", d."enableTabs",
           d."enableHeader", d."displayTitle", d.hidden
    from "desktopRoutes" d
    where d."schemaUid" not in ('${ARC_UIDS.join("','")}')
    order by d.id) t;`, DEV, 'dev-routes'));

const devLayouts = JSON.parse(psql(`
  select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select "desktopRouteId", "uiLayoutUid", "createdAt", "updatedAt"
    from "desktopRoutesUiLayouts"
    where "desktopRouteId" in (select id from "desktopRoutes"
      where "schemaUid" not in ('${ARC_UIDS.join("','")}'))) t;`, DEV, 'dev-layouts'));

console.log(`开发库候选：路由 ${devRows.length} 条（排除 ARC 后）/ 布局关联 ${devLayouts.length} 条`);
if (devRows.length < DESIRED) {
  throw new Error(`开发库不足 ${DESIRED} 条候选（只有 ${devRows.length}）—— 无法构造同形基线`);
}

// 取前 34 条（按 id 升序，稳定且可复现）。
// 为免出现"父不在集合内"的孤儿，优先保留 parentId 指向集合内 id 的行：
// 先取前 34，再把 parentId 指向集合外的行删掉并向后补，直到稳定。
let picked = devRows.slice(0, DESIRED);
for (let round = 0; round < 20; round++) {
  const ids = new Set(picked.map((r) => r.id));
  const orphans = picked.filter((r) => r.parentId !== null && r.parentId !== undefined && !ids.has(Number(r.parentId)));
  if (orphans.length === 0) break;
  const dropSet = new Set(orphans.map((r) => r.id));
  // 只丢"孤儿"，并从剩余候选里按顺序补齐到 34
  const rest = devRows.filter((r) => !ids.has(r.id) && !dropSet.has(r.id));
  picked = [...picked.filter((r) => !dropSet.has(r.id)), ...rest.slice(0, orphans.length)];
}
picked = picked.slice(0, DESIRED);
const idSet = new Set(picked.map((r) => r.id));
const stillOrphan = picked.filter((r) => r.parentId !== null && r.parentId !== undefined && !idSet.has(Number(r.parentId)));
console.log(`已选 ${picked.length} 条，父路由缺失 ${stillOrphan.length} 条` +
  `（缺失的 parentId 会在目标库里被置空，只影响"菜单层级"这一视觉属性，不影响 ARC 归属判据）`);

// ---- 2. 清空目标库的 UI 配置（只动这两类表）----
const before = {
  routes: psql('select count(*) from "desktopRoutes";', TARGET),
  models: psql('select count(*) from "flowModels";', TARGET),
  rolesRoutes: psql('select count(*) from "rolesDesktopRoutes";', TARGET),
};
console.log(`目标库清理前：desktopRoutes=${before.routes} flowModels=${before.models} rolesDesktopRoutes=${before.rolesRoutes}`);

if (DRY) {
  console.log('\n[DRY-RUN] 不执行写入。');
  process.exit(0);
}

psql(`
  begin;
  delete from "desktopRoutesUiLayouts";
  delete from "rolesDesktopRoutes";
  delete from "desktopRoutes";
  delete from "flowModels";
  commit;
`, TARGET, 'clean');

// ⚠️ 必须**同事务**清 `flowModelTreePath`，否则会留下**树路径孤儿**：
//    第一次构造时漏了这一步，结果库里残留 1 条以 ARC page uid 为 ancestor 的树路径行，
//    于是重放脚本读到"page=397263571124224 / tabs=397123571124225"这种**幽灵占用**
//    （desktopRoutes 里其实没有这两条），归属判据判 STOP ——
//    这个 STOP 是**对的**（判据确实发现了不一致），但现场是我自己搞脏的。
//    ⇒ 清基线就要清干净：三张表（routes / models / 树路径）必须一起清。
psql(`
  begin;
  delete from "flowModelTreePath";
  commit;
`, TARGET, 'clean-treepath');

// ---- 3. 写入 34 条路由 + 布局关联 ----
// ⚠️ id 冲突不可能发生（目标库刚清空），但仍**保留原 id**：
//    这样 parentId 不需要重映射，构造过程更可控、可复现。
const esc = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
};
// 父路由不在集合内的，parentId 置空（避免违反外键/造成孤儿）
const rows = picked.map((r) => ({
  ...r,
  parentId: r.parentId !== null && r.parentId !== undefined && idSet.has(Number(r.parentId))
    ? Number(r.parentId) : null,
}));
const cols = ['id', 'parentId', 'title', 'tooltip', 'icon', 'schemaUid', 'menuSchemaUid',
  'tabSchemaName', 'type', 'options', 'sort', 'hideInMenu', 'enableTabs', 'enableHeader',
  'displayTitle', 'hidden'];
const values = rows.map((r) => '(' + cols.map((c) => esc(r[c])).join(',') + ')').join(',\n');

psql(`
  begin;
  insert into "desktopRoutes" (${cols.map((c) => `"${c}"`).join(',')}) values
  ${values};
  commit;
`, TARGET, 'insert-routes');

// 布局关联：只保留针对"仍在集合内"的路由的关联
//
// ⚠️ `desktopRoutesUiLayouts` 没有 id 列（复合主键），但有 **非空** 的 `createdAt`/`updatedAt`
//    —— 第一次构造时漏了这两列，直接撞 not-null 约束（见下）。
//    这里从开发库**原样复制**时间戳，而不是用 now()：本脚本的产物是"库形态"，
//    时间戳保留原值更接近真实（也让前后两次构造的结果可比）。
const layoutValues = devLayouts
  .filter((l) => idSet.has(Number(l.desktopRouteId)))
  .map((l) => `(${Number(l.desktopRouteId)}, ${esc(l.uiLayoutUid)}, ${esc(l.createdAt)}, ${esc(l.updatedAt)})`);
if (layoutValues.length) {
  psql(`
    begin;
    insert into "desktopRoutesUiLayouts" ("desktopRouteId","uiLayoutUid","createdAt","updatedAt") values
    ${layoutValues.join(',')}
    on conflict do nothing;
    commit;
  `, TARGET, 'insert-layouts');
}

// ---- 4. 回读自证 ----
const after = {
  routes: psql('select count(*) from "desktopRoutes";', TARGET),
  arcRoutes: psql(`select count(*) from "desktopRoutes" where "schemaUid" in ('${ARC_UIDS.join("','")}');`, TARGET),
  models: psql('select count(*) from "flowModels";', TARGET),
  // ★ 树路径也必须回读：它是"幽灵占用"的唯一藏身处（见上面 clean-treepath 的注释）
  treePath: psql('select count(*) from "flowModelTreePath";', TARGET),
  layouts: psql('select count(*) from "desktopRoutesUiLayouts";', TARGET),
};
console.log(`目标库清理后：desktopRoutes=${after.routes}（其中 ARC=${after.arcRoutes}）flowModels=${after.models} ` +
  `flowModelTreePath=${after.treePath} layouts=${after.layouts}`);

const ok = Number(after.routes) === DESIRED && Number(after.arcRoutes) === 0
  && Number(after.models) === 0 && Number(after.treePath) === 0;
console.log(ok ? `\n✅ 已构造生产同形基线：${DESIRED} 条历史路由、0 条 ARC 路由、0 个模型、0 条树路径`
  : `\n🔴 构造结果不符：期望 ${DESIRED}/0/0/0，实际 ${after.routes}/${after.arcRoutes}/${after.models}/${after.treePath}`);

fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/hotfix01'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp-verify/evidence/hotfix01/prod-like-baseline.json'),
  JSON.stringify({ at: new Date().toISOString(), target: TARGET, desired: DESIRED,
    before, after, selectedIds: [...idSet].sort((a, b) => a - b) }, null, 2));

process.exit(ok ? 0 : 1);
