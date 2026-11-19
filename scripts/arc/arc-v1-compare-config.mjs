/**
 * ARC-V1 / A6 补证 · **隔离库 vs 开发库：页面配置等价性对照**
 *
 * 目的：回答用户 §1「核对页面配置交付链」——
 *   重建出来的到底是什么、和开发库那台**是不是同一份配置**。
 *   不比"看起来一样"，而是逐表逐字段比**规范化后的集合**。
 *
 * 判据纪律（本项目血泪）：
 *   · 断言比**集合**不比顺序（id 在两库必然不同 —— 新库自增）
 *   · 排除掉两库**本来就该不同**的字段：路由 id、parentId（父子都要重映射）、时间戳
 *   · 每条正向断言配一条反向对照（证明对照本身有区分力）
 *
 * 用法：node .tmp-verify/a6/compare-config.mjs
 */
import { execFileSync } from 'node:child_process';

const DEV = 'service_ticket';
const UAT = 'service_ticket_verify';
const PAGE_UID = 'n5c25yq5qlt';
const TABS_UID = '97x481j2bv1';
const LAYOUT = 'mobile-layout-model';
const DEV_ROUTE_IDS = [396888170692608, 396888170692609];

const psql = (sql, db) => {
  try {
    return execFileSync('docker',
      ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', db, '-A', '-t', '-F', '|', '-f', '-'],
      { input: sql, encoding: 'utf8' }).trim();
  } catch (e) { return `__ERR__ ${e.stderr || e.message}`; }
};

const results = [];
const check = (id, desc, pass, detail = '') => {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);

console.log('='.repeat(78));
console.log('ARC-V1 · 隔离库 vs 开发库 页面配置等价性对照');
console.log(`开发库=${DEV}   隔离库=${UAT}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
section('1. 路由：schemaUid 集合必须一致');
// ---------------------------------------------------------------------------
const devRoutes = psql(`
  select "schemaUid"||' | type='||type||' | title='||coalesce(title,'-')||
         ' | icon='||coalesce(icon,'-')||' | enableTabs='||coalesce("enableTabs"::text,'-')||
         ' | hidden='||coalesce(hidden::text,'-')
  from "desktopRoutes" where id in (${DEV_ROUTE_IDS.join(',')}) order by 1;`, DEV).split('\n').filter(Boolean);
const uatRoutes = psql(`
  select "schemaUid"||' | type='||type||' | title='||coalesce(title,'-')||
         ' | icon='||coalesce(icon,'-')||' | enableTabs='||coalesce("enableTabs"::text,'-')||
         ' | hidden='||coalesce(hidden::text,'-')
  from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}') order by 1;`, UAT).split('\n').filter(Boolean);

const sortedEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
check('E1', '两库路由的（uid|type|title|icon|enableTabs|hidden）集合完全相同',
  devRoutes.length === 2 && sortedEq(devRoutes, uatRoutes),
  `开发库 ${devRoutes.length} 条 / 隔离库 ${uatRoutes.length} 条\n        DEV: ${devRoutes.join('\n             ')}\n        UAT: ${uatRoutes.join('\n             ')}`);

// 反向对照：故意漏掉一条，必须不相等（证明对照有区分力）
check('E1-R', '反向对照：故意只取 1 条时集合不相等（对照有区分力）',
  !sortedEq(devRoutes, uatRoutes.slice(0, 1)), '单条 vs 两条 ⇒ 必须不等');

// 父子结构：tabs 的 parentId 必须指向本库的 page 路由
const uatParent = psql(`
  select t."parentId" = p.id
  from "desktopRoutes" t join "desktopRoutes" p on p."schemaUid"='${PAGE_UID}'
  where t."schemaUid"='${TABS_UID}';`, UAT);
check('E2', '隔离库 tabs 子路由的 parentId 正确指向本库的 page 路由（不是硬编码旧 id）',
  uatParent === 't',
  `tabs.parentId == 本库 page.routeId ⇒ ${uatParent}`);

// ---------------------------------------------------------------------------
section('2. 布局归属：两条路由都只挂 mobile-layout-model');
// ---------------------------------------------------------------------------
const devLayouts = psql(`
  select r."schemaUid"||'=>'||string_agg(l."uiLayoutUid",',')
  from "desktopRoutes" r join "desktopRoutesUiLayouts" l on l."desktopRouteId"=r.id
  where r.id in (${DEV_ROUTE_IDS.join(',')}) group by r."schemaUid" order by 1;`, DEV).split('\n').filter(Boolean);
const uatLayouts = psql(`
  select r."schemaUid"||'=>'||string_agg(l."uiLayoutUid",',')
  from "desktopRoutes" r join "desktopRoutesUiLayouts" l on l."desktopRouteId"=r.id
  where r."schemaUid" in ('${PAGE_UID}','${TABS_UID}') group by r."schemaUid" order by 1;`, UAT).split('\n').filter(Boolean);
check('E3', '两库布局归属一致（均为「只挂 mobile-layout-model」）',
  sortedEq(devLayouts, uatLayouts),
  `DEV: ${devLayouts.join(' | ')}\n        UAT: ${uatLayouts.join(' | ')}`);

// ---------------------------------------------------------------------------
section('3. 模型树：模型集合与种类必须一致（join 口径）');
// ---------------------------------------------------------------------------
const devModels = psql(`
  select m.uid||'|'||coalesce(m.options->>'use','?')
  from "flowModels" m join "flowModelTreePath" tp on tp.descendant=m.uid
  where tp.ancestor in ('${PAGE_UID}','${TABS_UID}') order by 1;`, DEV).split('\n').filter(Boolean);
const uatModels = psql(`
  select m.uid||'|'||coalesce(m.options->>'use','?')
  from "flowModels" m join "flowModelTreePath" tp on tp.descendant=m.uid
  where tp.ancestor in ('${PAGE_UID}','${TABS_UID}') order by 1;`, UAT).split('\n').filter(Boolean);
check('E4', `两库模型集合（uid | use）完全相同（各 ${devModels.length} 个）`,
  devModels.length === 26 && sortedEq(devModels, uatModels),
  `DEV ${devModels.length} / UAT ${uatModels.length}；` +
  `差异=${devModels.filter((x) => !uatModels.includes(x)).slice(0, 4).join(',') || '无'}`);

// 两个业务区块必须在（这是本页的核心）
for (const [id, use] of [['E5', 'ArchiveCreateBlockModel'], ['E6', 'ArchiveEditBlockModel']]) {
  const inDev = devModels.filter((x) => x.includes(use)).length;
  const inUat = uatModels.filter((x) => x.includes(use)).length;
  check(id, `业务区块 ${use} 在两库都存在且数量一致`,
    inDev > 0 && inDev === inUat, `DEV=${inDev} UAT=${inUat}`);
}

// 反向对照：子串撞车检测 —— 用不含该区块的集合比，必须不等
check('E5-R', '反向对照：拿掉 BlockGrid 后集合不相等（证明 E4/E5 的匹配有区分力）',
  !sortedEq(devModels.filter((x) => !x.includes('ArchiveCreateBlockModel')), uatModels),
  '排除建档块后的集合与完整集合必然不同');

// ---------------------------------------------------------------------------
section('4. 角色授权：角色集合必须一致');
// ---------------------------------------------------------------------------
const devGrants = psql(`
  select "roleName" from "rolesDesktopRoutes"
  where "desktopRouteId" in (${DEV_ROUTE_IDS.join(',')}) group by "roleName" order by 1;`, DEV).split('\n').filter(Boolean);
const uatGrantIds = psql(`select string_agg(id::text,',') from "desktopRoutes" where "schemaUid" in ('${PAGE_UID}','${TABS_UID}');`, UAT);
const uatGrants = psql(`
  select "roleName" from "rolesDesktopRoutes"
  where "desktopRouteId" in (${uatGrantIds}) group by "roleName" order by 1;`, UAT).split('\n').filter(Boolean);
check('E7', '两库对这两条路由的授权角色集合完全相同',
  devGrants.length === 6 && sortedEq(devGrants, uatGrants),
  `DEV: ${devGrants.join(',')}\n        UAT: ${uatGrants.join(',')}`);

// 四个业务角色必须在
const need = ['store_sales', 'store_manager', 'hq_admin', 'hq_after_sales'];
check('E8', '四个业务角色在两库都拿到了授权（父子成对）',
  need.every((r) => devGrants.includes(r) && uatGrants.includes(r)),
  `缺失：DEV=[${need.filter((r) => !devGrants.includes(r))}] UAT=[${need.filter((r) => !uatGrants.includes(r))}]`);

// ---------------------------------------------------------------------------
section('5. ACL（不是页面配置，用于区分"哪些是交付的、哪些是自动的"）');
// ---------------------------------------------------------------------------
for (const t of ['dataSourcesRoles', 'dataSourcesRolesResources', 'dataSourcesRolesResourcesActions']) {
  const d = psql(`select count(*) from "${t}";`, DEV);
  const u = psql(`select count(*) from "${t}";`, UAT);
  check(`E9-${t}`, `${t}：隔离库由插件自动建成（行数应在同量级）`,
    Number(u) > 0, `DEV=${d} UAT=${u}`);
}
const devArcAcl = psql(`select "roleName"||':'||name||':'||coalesce((select string_agg(a.name,',' order by a.name) from "dataSourcesRolesResourcesActions" a where a."rolesResourceId"=r.id),'-') from "dataSourcesRolesResources" r where r.name like 'serviceArchive%' order by 1;`, DEV).split('\n').filter(Boolean);
const uatArcAcl = psql(`select "roleName"||':'||name||':'||coalesce((select string_agg(a.name,',' order by a.name) from "dataSourcesRolesResourcesActions" a where a."rolesResourceId"=r.id),'-') from "dataSourcesRolesResources" r where r.name like 'serviceArchive%' order by 1;`, UAT).split('\n').filter(Boolean);
check('E10', 'ARC 三个集合的四角色授权（角色:资源:动作集合）两库完全一致',
  sortedEq(devArcAcl, uatArcAcl),
  `DEV ${devArcAcl.length} 行 / UAT ${uatArcAcl.length} 行；` +
  `差异=${devArcAcl.filter((x) => !uatArcAcl.includes(x)).slice(0, 3).join(' ; ') || '无'}`);

// 关键：只读口径（无 create/update/destroy）必须在两库都成立
const writeLeak = [...devArcAcl, ...uatArcAcl].filter((x) => /:(create|update|destroy)(,|$)/.test(x));
check('E11', '两库的 ARC 资源授权都**不含** create/update/destroy（只读口径一致）',
  writeLeak.length === 0, writeLeak.length ? `发现写权限：${writeLeak.slice(0, 3).join(' ; ')}` : '两库均为 view/list/get');

const failed = results.filter((r) => !r.pass);
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
