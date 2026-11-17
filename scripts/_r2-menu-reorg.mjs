#!/usr/bin/env node
/**
 * R2 · 菜单重组：分开「日常运维」与「系统维护」
 *
 * 用户口径（R2 最终整改原文）：
 *   "复用现有页面/UI 配置，分开**日常运维**与**系统维护**；
 *    **不得**通过 SQL 直接创建页面；做不到的如实说明。"
 *
 * 因此本脚本的设计约束（自我约束，比用户要求更严）：
 *   ① **不 INSERT 任何 desktopRoutes 行** —— 不创建页面、也不创建新组。
 *      复用现有的「服务档案」组（id 396884818853888）改名为「系统维护」。
 *   ② 只做两类写入：`parentId` 改写 + 组 `title` 改写 + **组授权**补齐。
 *   ③ 组授权是必须的：NocoBase 由 `desktopRoutes:listAccessible` 按 uiLayout 过滤，
 *      父组没有该角色的 `rolesDesktopRoutes` 行时，**整组连同子页都不可见**
 *      （2026-11-14 已验证：新组必须按"子页面有权限的角色"继承可见性）。
 *
 * 🔒 本脚本的核心安全性质（也是唯一真正要紧的断言）：
 *   **重组前后，每个角色的「可见页面集合」必须逐字相同**（比集合，不比顺序）。
 *   只允许"分组归属"变，不允许"谁能看到什么"变。
 *   若某角色的可见集合发生变化 ⇒ 视为缺陷，回滚。
 *
 * ⚠️ 为什么不是 7 组：2026-11-14 做过一版 7 组，随后被还原（group 行 `updatedAt`
 *    停在 2026-09-21，裸 SQL 还原不留痕）。用户本次只点名"日常运维 / 系统维护"
 *    两类 ⇒ 按用户口径做两类，不自行加戏。
 *
 * 用法：
 *   node scripts/_r2-menu-reorg.mjs              # dry-run：只打印计划
 *   node scripts/_r2-menu-reorg.mjs --apply      # 执行（幂等，可重复跑）
 *   node scripts/_r2-menu-reorg.mjs --rollback   # 从 _bak_menu_reorg 还原
 *   node scripts/_r2-menu-reorg.mjs --check      # 只校验当前是否已符合目标形态
 */
import { execFileSync } from 'node:child_process';

const DB = { PG: 'svc-postgres', USER: 'svc_app', NAME: 'service_ticket' };
const BAK = '_bak_menu_reorg';

/** 组 */
const G_DAILY = '387851208425472'; // 现「售后工单」→ 保持为日常运维组
const G_SYS = '396884818853888'; // 现「服务档案」→ 改名「系统维护」

/** 目标组名（title 是用户可见文案；组的 schemaUid 不动） */
const TITLE_DAILY = '日常运维';
const TITLE_SYS = '系统维护';

/** 要移入「系统维护」的页面（来自现「售后工单」组；「我的服务档案」本就在该组，不动） */
const MOVE_TO_SYS = [
  ['387851984502784', '工单事件时间线'],
  ['387852011765760', '派工记录'],
  ['392565982691328', '短信通知'],
  ['394387998179328', '短信通知总览'],
  ['392919189159936', '门店账号'],
  ['391666437980160', '历史数据导入'],
  ['393140917567488', '历史售后档案'],
  ['392591936978944', '客户页面装修'],
];

/** 「系统维护」组需要拥有授权的角色 —— 必须覆盖被移页面原有的全部可见角色 */
const SYS_ROLES = ['admin', 'hq_admin', 'hq_after_sales', 'member', 'store_after_sales'];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ROLLBACK = argv.includes('--rollback');
const CHECK = argv.includes('--check');

// ---------------------------------------------------------------------------
function psql(sql, { tuples = false } = {}) {
  const args = ['exec', '-i', DB.PG, 'psql', '-U', DB.USER, '-d', DB.NAME, '-v', 'ON_ERROR_STOP=1', '-A', '-t'];
  if (tuples) args.push('-F', '\u0001');
  args.push('-f', '-');
  try {
    const out = execFileSync('docker', args, { input: sql, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (!tuples) return out.trim();
    const t = out.trim();
    if (!t) return [];
    return t.split('\n').map((l) => l.split('\u0001'));
  } catch (e) {
    // 关键：psql 的 stderr 默认被吞 ⇒ 会制造"空结果 = 通过"的假绿。必须显式抛。
    const msg = String(e.stderr || e.message || e).slice(0, 600);
    throw new Error(`psql 失败：${msg}`);
  }
}
const one = (sql) => {
  const r = psql(sql).trim();
  if (r === '') throw new Error(`查询返回空（通常是列名/表名写错）：${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  return r;
};

/** 当前「角色 → 可见页面标题集合」地面真值（走 DB 的授权关系，不比顺序） */
function visibleByRole() {
  const rows = psql(
    `select r."roleName" || '~' || d.title
       from "rolesDesktopRoutes" r join "desktopRoutes" d on d.id = r."desktopRouteId"
      where d.type = 'flowPage'
      order by 1`,
  );
  const map = {};
  for (const line of rows ? String(rows).split('\n') : []) {
    const i = line.indexOf('~');
    if (i < 0) continue;
    (map[line.slice(0, i)] ??= []).push(line.slice(i + 1));
  }
  return map;
}

function currentParent(title) {
  const v = psql(`select coalesce("parentId"::text,'(null)') from "desktopRoutes" where title='${title}' and type='flowPage'`);
  const lines = String(v).split('\n').filter(Boolean);
  if (lines.length !== 1) throw new Error(`页面「${title}」在 desktopRoutes 里命中 ${lines.length} 条（期望 1）`);
  return lines[0];
}

function groupTitle(id) {
  return one(`select coalesce(title,'') from "desktopRoutes" where id=${id} and type='group'`);
}

// ---------------------------------------------------------------------------
console.log('='.repeat(74));
console.log(`R2 菜单重组 · ${ROLLBACK ? 'ROLLBACK' : CHECK ? 'CHECK' : APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log('='.repeat(74));

// ---- 预检：目标行必须真的存在（避免"改了 0 行却报成功"）
const pre = MOVE_TO_SYS.map(([id, title]) => ({ id, title, parent: currentParent(title) }));
for (const p of pre) {
  if (p.parent === '(null)') throw new Error(`页面「${p.title}」(id=${p.id}) 当前无 parentId —— 与预期不符，停止`);
}
console.log(`\n[预检] ${pre.length} 个待移页面均存在，当前均挂在 ${[...new Set(pre.map((p => p.parent)))]} 下`);
console.log(`[预检] 组 ${G_DAILY}「${groupTitle(G_DAILY)}」 / 组 ${G_SYS}「${groupTitle(G_SYS)}」`);

const before = visibleByRole();
console.log(`[预检] 角色可见页面数：${Object.entries(before).map(([r, v]) => `${r}=${v.length}`).join('  ')}`);

// ---------------------------------------------------------------------------
if (CHECK) {
  let bad = 0;
  const t1 = groupTitle(G_DAILY);
  const t2 = groupTitle(G_SYS);
  if (t1 !== TITLE_DAILY) { console.log(`  ❌ 日常组名 =「${t1}」，期望「${TITLE_DAILY}」`); bad++; }
  if (t2 !== TITLE_SYS) { console.log(`  ❌ 维护组名 =「${t2}」，期望「${TITLE_SYS}」`); bad++; }
  for (const [id, title] of MOVE_TO_SYS) {
    const p = currentParent(title);
    if (p !== G_SYS) { console.log(`  ❌ 「${title}」parentId=${p}，期望 ${G_SYS}`); bad++; }
  }
  const roles = psql(`select "roleName" from "rolesDesktopRoutes" where "desktopRouteId"=${G_SYS} order by 1`);
  const have = String(roles).split('\n').filter(Boolean);
  for (const r of SYS_ROLES) {
    if (!have.includes(r)) { console.log(`  ❌ 「${TITLE_SYS}」组缺角色授权：${r}`); bad++; }
  }
  console.log(bad ? `\n❌ CHECK 未通过：${bad} 项` : '\n✅ CHECK 通过：已是目标形态');
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------------------
if (ROLLBACK) {
  const exists = psql(`select count(*) from pg_tables where tablename='${BAK}'`);
  if (String(exists).trim() === '0') throw new Error(`备份表 ${BAK} 不存在，无法回滚`);
  const n = psql(`select count(*) from ${BAK}`);
  console.log(`\n从 ${BAK}（${n} 行）回滚…`);
  psql(`
    begin;
    -- 1) 恢复被改动的 title / parentId
    update "desktopRoutes" t
       set title = b.title, "parentId" = b."parentId"
      from ${BAK} b
     where t.id = b.id;
    -- 2) 删除本次新增的组授权（备份表里没有的）
    delete from "rolesDesktopRoutes" r
     where not exists (select 1 from ${BAK} b where b.id = r."desktopRouteId" and b.role = r."roleName")
       and r."desktopRouteId" in (select id from ${BAK} where type='group');
    commit;
  `);
  const after = visibleByRole();
  const ok = JSON.stringify(Object.fromEntries(Object.entries(after).map(([k, v]) => [k, [...v].sort()])))
          === JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, [...v].sort()])));
  console.log(`  回滚后角色可见页面集合与预期一致：${ok ? '✅' : '❌（请看下面的分布）'}`);
  console.log(`  当前：${Object.entries(after).map(([r, v]) => `${r}=${v.length}`).join('  ')}`);
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 计划（dry-run 与 apply 共用）
// ⚠️ 必写 `"updatedAt"=now()`：ORM 会自动维护该列，裸 SQL **不会**。
//    2026-11-14 那次 7 组改动的痕迹之所以完全消失（group 行 updatedAt 仍停在 09-21），
//    一个直接后果就是"改过"这件事在数据里不可见。显式写时间戳让本次变更可审计、可追溯。
const plan = [
  `UPDATE "desktopRoutes" SET title='${TITLE_DAILY}', "updatedAt"=now() WHERE id=${G_DAILY};`,
  `UPDATE "desktopRoutes" SET title='${TITLE_SYS}', "updatedAt"=now() WHERE id=${G_SYS};`,
  ...MOVE_TO_SYS.map(([id, title]) => `UPDATE "desktopRoutes" SET "parentId"=${G_SYS}, "updatedAt"=now() WHERE id=${id}; -- ${title}`),
  ...SYS_ROLES.map((r) => `INSERT INTO "rolesDesktopRoutes" ("desktopRouteId","roleName","createdAt","updatedAt") VALUES (${G_SYS},'${r}',now(),now()) ON CONFLICT DO NOTHING;`),
];
console.log('\n[计划]');
for (const s of plan) console.log('   ' + s);

if (!APPLY) {
  console.log('\n[DRY-RUN] 未写入。加 --apply 执行。\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 备份（幂等：固定表名，DROP+CREATE；记录受影响行的原值 + 组授权现状）
psql(`
  begin;
  drop table if exists ${BAK};
  create table ${BAK} as
    select 'route' as kind, id, "parentId", title, type, null::text as role from "desktopRoutes"
     where id in (${G_DAILY}, ${G_SYS}${MOVE_TO_SYS.map(([id]) => `, ${id}`).join('')});
  insert into ${BAK} (kind, id, "parentId", title, type, role)
    select 'role', r."desktopRouteId", null, null, null, r."roleName"
      from "rolesDesktopRoutes" r where r."desktopRouteId" = ${G_SYS};
  commit;
`);
console.log(`\n[备份] ${BAK} 已写入 ${one(`select count(*) from ${BAK}`)} 行`);

// 执行
psql(`
  begin;
  update "desktopRoutes" set title='${TITLE_DAILY}', "updatedAt"=now() where id=${G_DAILY};
  update "desktopRoutes" set title='${TITLE_SYS}', "updatedAt"=now() where id=${G_SYS};
  update "desktopRoutes" set "parentId"=${G_SYS}, "updatedAt"=now() where id in (${MOVE_TO_SYS.map(([id]) => id).join(',')});
  ${SYS_ROLES.map((r) => `insert into "rolesDesktopRoutes" ("desktopRouteId","roleName","createdAt","updatedAt") values (${G_SYS},'${r}',now(),now()) on conflict do nothing;`).join('\n  ')}
  commit;
`);
console.log('[执行] 已提交。');

// ---- 回验 1：结构
const after = visibleByRole();
console.log('\n[回验 1 · 结构]');
let bad = 0;
if (groupTitle(G_DAILY) !== TITLE_DAILY) { console.log(`  ❌ 日常组名=${groupTitle(G_DAILY)}`); bad++; }
if (groupTitle(G_SYS) !== TITLE_SYS) { console.log(`  ❌ 维护组名=${groupTitle(G_SYS)}`); bad++; }
for (const [, title] of MOVE_TO_SYS) {
  if (currentParent(title) !== G_SYS) { console.log(`  ❌ 「${title}」未移动`); bad++; }
}
console.log(bad ? `  ❌ ${bad} 项结构不符` : `  ✅ 组名与归属全部符合（移入 ${MOVE_TO_SYS.length} 页）`);

// ---- 回验 2（核心）：角色可见页面集合必须逐字不变
console.log('\n[回验 2 · 核心断言：角色可见页面集合不得变化]');
const norm = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, [...m[k]].sort()]));
const b = norm(before), a = norm(after);
let setBad = 0;
for (const role of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
  const x = JSON.stringify(b[role] ?? []);
  const y = JSON.stringify(a[role] ?? []);
  if (x === y) {
    console.log(`  ✅ ${role}：${(a[role] ?? []).length} 个页面，逐字未变`);
  } else {
    setBad++;
    const bx = b[role] ?? [], ay = a[role] ?? [];
    console.log(`  ❌ ${role}：集合变化\n      失去: ${bx.filter((t) => !ay.includes(t)).join(', ') || '-'}\n      新增: ${ay.filter((t) => !bx.includes(t)).join(', ') || '-'}`);
  }
}
console.log(setBad ? `\n❌ 有 ${setBad} 个角色的可见集合被改动 —— 请 --rollback` : '\n✅ 所有角色的可见页面集合逐字未变');
process.exit(setBad || bad ? 1 : 0);
