/**
 * arc-b1-nonarc-page-probe.mjs —— R0-FREEZE · B1 取证
 *
 * 用户要求：
 *   「构造一个**非 ARC 业务页面**，使其同样满足 total≥20、grid≥1、createBlk≥1、
 *     editBlk≥1。验证该页面**不会被判定为 ARC**。」
 *
 * 为什么要真造而不是编 fixture
 * -----------------------------------------------------------------------------
 * 现有的反向对照（`pac49kftubs`：49 行 / grid=1 / **create=0 / edit=0**）有个**致命缺口**：
 * 它的 create/edit 都是 0，所以"判否"的原因可能只是"缺了那两个标记"。
 * 它**没有**回答用户真正问的问题 ——
 *   「一个同样含 create+edit 标记、但不是 ARC 的页面，会不会被判成 ARC？」
 * 这正是判据最可能出错的方向（假阳 ⇒ 静默把 ARC 配置写进业务页）。
 *
 * 做法（不碰产品代码、不碰开发库、只用隔离库）
 * -----------------------------------------------------------------------------
 *   1. 在隔离库 `service_ticket_verify` 里**真实插入**一个"干扰页面"的模型子树：
 *      · 结构上凑齐 BlockGrid + ArchiveCreateBlockModel + ArchiveEditBlockModel（满足四条数值条件）
 *      · 但**集合绑定不同**（fieldSettings.init.collectionName = 'serviceVisits' 而非 'serviceArchives'）
 *        —— 模拟"某个别的插件/别的人建了一个也用这两个块的页面"
 *   2. 用**重放脚本里同一段 SQL**（pageFingerprint）读它的指纹；
 *   3. 喂给**同一个** `isArcTabsFingerprint` 判据；
 *   4. 记录判据结论。
 *
 * 结果分两种，两种都是有价值的结论：
 *   · 判 false ⇒ 判据在这条反例上有区分力（当前判据通过本反例）
 *   · 判 true  ⇒ **判据存在假阳**：光靠 4 个数字不足以证明"这就是 ARC 页"，
 *                需要按用户 §B 补"实际集合绑定 / 模型层级 / 预期页面结构"的校验
 *
 * ★ 无论哪种结果，本脚本都**不留残余**：结束后把插入的模型与树路径全部删除并核对。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isArcTabsFingerprint, describeFingerprint, decideUidOwnership, UID_OWNERSHIP }
  from '../lib/arc-uid-ownership.mjs';

const DB = 'service_ticket_verify';            // 隔离库
const DEV_DB = 'service_ticket';               // 只读对照
const PROBE_UID = 'probe_nonarc_b1';           // 干扰页面根 UID
const ARC_UID = '97x481j2bv1';                 // 真 ARC tabs

function psql(sql, db = DB) {
  return execFileSync('docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** 与 arc-v1-rebuild-mobile-page.mjs 里的 pageFingerprint **逐字相同**的判据 SQL */
function pageFingerprint(uid, db = DB) {
  const row = psql(`select count(*)
      ||'|'|| count(*) filter (where m.options::text like '%BlockGridModel%')
      ||'|'|| count(*) filter (where m.options::text like '%ArchiveCreateBlockModel%')
      ||'|'|| count(*) filter (where m.options::text like '%ArchiveEditBlockModel%')
    from "flowModels" m join "flowModelTreePath" tp on tp.descendant=m.uid
    where tp.ancestor='${uid}';`, db);
  const [total, grid, createBlk, editBlk] = row.split('|').map(Number);
  return { total, grid, createBlk, editBlk };
}

const results = [];
const record = (id, desc, pass, detail = '') => {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `\n        ${detail}` : ''}`);
};

console.log('='.repeat(78));
console.log('R0-FREEZE · B1 取证：构造"非 ARC 但满足四条数值条件"的页面并实测判据');
console.log('='.repeat(78));

/* ---------------------------------------------------------------------------
 * 0. 前置：确认只动隔离库
 * ------------------------------------------------------------------------- */
record('B0', '目标库是隔离库（不是开发库）',
  psql('select current_database();') === DB && DB !== DEV_DB,
  `current_database=${psql('select current_database();')}；开发库仅作只读对照`);

/* ---------------------------------------------------------------------------
 * 1. 基线：先看清 ARC 页面与已有对照页的指纹
 * ------------------------------------------------------------------------- */
const arcFp = pageFingerprint(ARC_UID);
const bizFpDev = pageFingerprint('pac49kftubs', DEV_DB);
record('B1-0a', '正例基线：ARC tabs 指纹满足四条数值条件',
  isArcTabsFingerprint(arcFp) === true, `ARC tabs = ${describeFingerprint(arcFp)}`);
record('B1-0b', '★ 现有反向对照的**缺口**：pac49kftubs 的 create/edit 都是 0',
  bizFpDev.createBlk === 0 && bizFpDev.editBlk === 0,
  `pac49kftubs = ${describeFingerprint(bizFpDev)} ⇒ 它判否的原因只是"缺标记"，` +
  `并未回答"同样含 create+edit 的非 ARC 页会不会被误判"`);

/* ---------------------------------------------------------------------------
 * 2. 构造干扰页面：结构凑齐四条，但**集合绑定不同**
 * ------------------------------------------------------------------------- */
psql(`DELETE FROM "flowModelTreePath" WHERE descendant LIKE '${PROBE_UID}%' OR ancestor LIKE '${PROBE_UID}%';`);
psql(`DELETE FROM "flowModels" WHERE uid LIKE '${PROBE_UID}%';`);

const NODE = (uid, use, extra = {}) =>
  `INSERT INTO "flowModels" (uid, options) VALUES ('${uid}', '${JSON.stringify({ use, ...extra }).replace(/'/g, "''")}'::json);`;

/** 造 22 个叶子 FormItem：每个都绑定 collectionName = serviceVisits（**非** serviceArchives） */
function leafInserts(prefix, n, parent, collName) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const uid = `${prefix}_leaf${i}`;
    rows.push(NODE(uid, 'FormItemModel', {
      parentId: parent, subKey: 'items', subType: 'array', props: {},
      stepParams: { fieldSettings: { init: { dataSourceKey: 'main', collectionName: collName, fieldPath: `f${i}` } } },
    }));
    rows.push(`INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}', '${uid}', 4, 'items', ${i});`);
    rows.push(`INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${uid}', '${uid}', 0, 'items', ${i});`);
  }
  return rows.join('\n');
}

psql([
  NODE(PROBE_UID, 'BlockGridModel', { parentId: null, subKey: 'grid', subType: 'object', sortIndex: 0 }),
  `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}', '${PROBE_UID}', 0, 'grid', 0);`,
  // 两个 Archive 块：块类型与 ARC **完全相同**（这正是"结构判据"看不清的地方）
  NODE(`${PROBE_UID}_create`, 'ArchiveCreateBlockModel', { parentId: PROBE_UID, subKey: 'items', subType: 'array', sortIndex: 1 }),
  `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}', '${PROBE_UID}_create', 1, 'items', 1);`,
  `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}_create', '${PROBE_UID}_create', 0, 'items', 1);`,
  NODE(`${PROBE_UID}_edit`, 'ArchiveEditBlockModel', { parentId: PROBE_UID, subKey: 'items', subType: 'array', sortIndex: 2 }),
  `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}', '${PROBE_UID}_edit', 1, 'items', 2);`,
  `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}_edit', '${PROBE_UID}_edit', 0, 'items', 2);`,
  NODE(`${PROBE_UID}_grid`, 'FormGridModel', { parentId: `${PROBE_UID}_edit`, subKey: 'items', subType: 'array', sortIndex: 1 }),
  `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}', '${PROBE_UID}_grid', 2, 'items', 3);`,
  `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${PROBE_UID}_grid', '${PROBE_UID}_grid', 0, 'items', 3);`,
  // ★ 关键：集合绑定 = serviceVisits（**不是** serviceArchives）
  leafInserts(PROBE_UID, 22, `${PROBE_UID}_grid`, 'serviceVisits'),
].join('\n'));

const probeFp = pageFingerprint(PROBE_UID);
record('B1-1', `干扰页面已真实构造：结构上满足全部四条数值条件`,
  probeFp.total >= 20 && probeFp.grid >= 1 && probeFp.createBlk >= 1 && probeFp.editBlk >= 1,
  `干扰页 = ${describeFingerprint(probeFp)}（期望 total≥20/grid≥1/create≥1/edit≥1）；` +
  `用途：让它**不是** ARC（集合绑定 = serviceVisits）`);

/* 反向自证：干扰页确实**不是** ARC —— 用集合绑定证明，而不是靠"我觉得"
 * ⚠️ PG 不允许在聚合里直接用 set-returning function（regexp_matches）：
 *    必须先在 LATERAL 子查询里展开，外层再 string_agg。
 *    （第一版写成 `string_agg(distinct (regexp_matches(...))[1], ',')` ⇒ 报
 *      "aggregate function calls cannot contain set-returning function calls"。） */
const collSql = (uid) => `select coalesce(string_agg(distinct c, ','), '') from (
    select (regexp_matches(m.options::text, '"collectionName":"([^"]+)"', 'g'))[1] as c
      from "flowModels" m
      join "flowModelTreePath" tp on tp.descendant = m.uid
     where tp.ancestor = '${uid}'
  ) s where c is not null;`;
const probeColl = psql(collSql(PROBE_UID));
const arcColl = psql(collSql(ARC_UID));
record('B1-2', '干扰页与真 ARC 页在**集合绑定**上确实不同（这才让它"不是 ARC"）',
  probeColl === 'serviceVisits' && arcColl === 'serviceArchives',
  `干扰页 collectionName=${probeColl}；真 ARC collectionName=${arcColl}`);

/* ---------------------------------------------------------------------------
 * 3. ★ 核心：三组反例，分别回答"用户原意"与"判据盲区"
 * ---------------------------------------------------------------------------
 * 必须区分两类页面，否则结论会被夸大：
 *   P1 用户原意的反例：**普通的**非 ARC 业务页面 —— 它的 create/edit 块是
 *      `CreateFormModel` / `EditFormModel`（普通表单块），不是 ARC 专属块。
 *      现实中这才是"另一个业务页面"的样子。
 *   P2 判据盲区的反例：用了 ARC 专属块（ArchiveCreate/EditBlockModel），
 *      但**集合绑定不是 serviceArchives**。这需要有人把 ARC 块拖到别的页面上，
 *      现实中不会自然发生，但它暴露了判据"只看块名、不看绑定"的盲区。
 *   二者都测，报告里分开说，不能把 P2 当成"普通业务页会被误判"来吓人。
 * ------------------------------------------------------------------------- */
const P1_UID = 'probe_biz_p1';
const P2_UID = 'probe_arcblk_p2';

function buildPage(rootUid, createUse, editUse, collName, leaves) {
  const stmts = [
    NODE(rootUid, 'BlockGridModel', { parentId: null, subKey: 'grid', subType: 'object', sortIndex: 0 }),
    `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}', '${rootUid}', 0, 'grid', 0);`,
    NODE(`${rootUid}_create`, createUse, { parentId: rootUid, subKey: 'items', subType: 'array', sortIndex: 1 }),
    `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}', '${rootUid}_create', 1, 'items', 1);`,
    `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}_create', '${rootUid}_create', 0, 'items', 1);`,
    NODE(`${rootUid}_edit`, editUse, { parentId: rootUid, subKey: 'items', subType: 'array', sortIndex: 2 }),
    `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}', '${rootUid}_edit', 1, 'items', 2);`,
    `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}_edit', '${rootUid}_edit', 0, 'items', 2);`,
    NODE(`${rootUid}_grid`, 'FormGridModel', { parentId: `${rootUid}_edit`, subKey: 'items', subType: 'array', sortIndex: 1 }),
    `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}', '${rootUid}_grid', 2, 'items', 3);`,
    `INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}_grid', '${rootUid}_grid', 0, 'items', 3);`,
  ];
  for (let i = 0; i < leaves; i += 1) {
    const uid = `${rootUid}_leaf${i}`;
    stmts.push(NODE(uid, 'FormItemModel', {
      parentId: `${rootUid}_grid`, subKey: 'items', subType: 'array', props: {},
      stepParams: { fieldSettings: { init: { dataSourceKey: 'main', collectionName: collName, fieldPath: `f${i}` } } },
    }));
    stmts.push(`INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${rootUid}', '${uid}', 4, 'items', ${i});`);
    stmts.push(`INSERT INTO "flowModelTreePath" (ancestor, descendant, depth, type, "sort") VALUES ('${uid}', '${uid}', 0, 'items', ${i});`);
  }
  return stmts.join('\n');
}
const dropPage = (uid) => {
  psql(`DELETE FROM "flowModelTreePath" WHERE descendant LIKE '${uid}%' OR ancestor LIKE '${uid}%';`);
  psql(`DELETE FROM "flowModels" WHERE uid LIKE '${uid}%';`);
};

/* ---- P1：用户口径 —— 普通非 ARC 业务页面（普通 Create/Edit 表单块）---- */
dropPage(P1_UID);
psql(buildPage(P1_UID, 'CreateFormModel', 'EditFormModel', 'serviceVisits', 22));
const p1Fp = pageFingerprint(P1_UID);
const p1Verdict = isArcTabsFingerprint(p1Fp);
const p1Dec = decideUidOwnership({ preId: 397110182019073, tabsFingerprint: p1Fp });
record('B1-3', '★【用户口径】普通业务页（≥20 模型 + grid + 普通 Create/Edit 块）**未被**判定为 ARC',
  p1Verdict === false,
  `P1 = ${describeFingerprint(p1Fp)}（块类型 CreateFormModel/EditFormModel，绑定 serviceVisits）⇒ ` +
  `isArcTabsFingerprint=${p1Verdict}；归属结论=${p1Dec.verdict}`);
record('B1-3b', '★【用户口径】该普通业务页的归属结论 = 不可复用（不会被静默写入）',
  p1Dec.verdict === UID_OWNERSHIP.STOP && p1Dec.reusable === false,
  `verdict=${p1Dec.verdict} reusable=${p1Dec.reusable}`);

/* ---- P2：判据盲区 —— 用了 ARC 专属块但绑别的集合 ---- */
dropPage(P2_UID);
psql(buildPage(P2_UID, 'ArchiveCreateBlockModel', 'ArchiveEditBlockModel', 'serviceVisits', 22));
const p2Fp = pageFingerprint(P2_UID);
const p2Verdict = isArcTabsFingerprint(p2Fp);
const p2Dec = decideUidOwnership({ preId: 397110182019073, tabsFingerprint: p2Fp });
const p2Coll = psql(collSql(P2_UID));
record('B1-4', '★【判据盲区】用 ARC 专属块但绑定 serviceVisits 的页面 ⇒ 判据**判 true**（假阳）',
  p2Verdict === true,
  `P2 = ${describeFingerprint(p2Fp)}（块类型与 ARC 相同，绑定=${p2Coll}）⇒ ` +
  `isArcTabsFingerprint=${p2Verdict}；归属结论=${p2Dec.verdict}（reusable=${p2Dec.reusable}）`);
record('B1-4b', '★【判据盲区】该页面集合绑定**不是** serviceArchives，却仍被判为"证属本次重放"',
  p2Coll === 'serviceVisits' && p2Dec.verdict === UID_OWNERSHIP.REUSE_PROVEN,
  `绑定=${p2Coll}（ARC 真值应为 serviceArchives）⇒ 判据只数块名、**不校验集合绑定**`);

/* ---- P3：真 ARC 结构（对照，必须判 true）---- */
dropPage('probe_arc_true_p3');
psql(buildPage('probe_arc_true_p3', 'ArchiveCreateBlockModel', 'ArchiveEditBlockModel', 'serviceArchives', 22));
const p3Fp = pageFingerprint('probe_arc_true_p3');
const p3Verdict = isArcTabsFingerprint(p3Fp);
record('B1-4c', '【对照】块类型 + 集合绑定都与 ARC 一致 ⇒ 判 true（说明 red 的是"缺绑定校验"，不是函数坏了）',
  p3Verdict === true,
  `P3 = ${describeFingerprint(p3Fp)} 绑定=serviceArchives ⇒ ${p3Verdict}`);

/* ---- 交叉判据：集合绑定能否补上这个盲区 ---- */
record('B1-5', '★ 交叉判据（集合绑定）对 P1/P2/P3 有**完全区分力**',
  (p2Coll !== 'serviceArchives') && (arcColl === 'serviceArchives'),
  `P2 绑定=${p2Coll}（非 ARC）· 真 ARC 绑定=${arcColl} ⇒ ` +
  `加一条"子树内 collectionName 必须含 serviceArchives"即可挡下 P2`);

/* ---------------------------------------------------------------------------
 * 5. 清理 + 核对无残余
 * ------------------------------------------------------------------------- */
dropPage(PROBE_UID);
dropPage(P1_UID);
dropPage(P2_UID);
dropPage('probe_arc_true_p3');
const leftModels = psql(`select count(*) from "flowModels" where uid like 'probe_%';`);
const leftPaths = psql(`select count(*) from "flowModelTreePath" where descendant like 'probe_%' or ancestor like 'probe_%';`);
const afterModels = psql('select count(*) from "flowModels";');
record('B1-6', '（清理）四个探针页面已完全撤除，隔离库回到构造前状态',
  leftModels === '0' && leftPaths === '0' && afterModels === '26',
  `残余模型=${leftModels} 残余树路径=${leftPaths}；隔离库 flowModels=${afterModels}（期望 26）`);

/* 开发库只读确认未被触碰：用**构造前**就取到的值对照，而不是写死一个数字
 * （第一版写死 36 ⇒ 判红，实际开发库有 2481 行 —— 那是个**过期期望**，
 *   正是本轮 A4 一直在修的那类错误，这里不能自己再犯一次。） */
const devModels = psql('select count(*) from "flowModels";', DEV_DB);
const devProbeLeft = psql(`select count(*) from "flowModels" where uid like 'probe_%';`, DEV_DB);
record('B1-7', '（旁证）开发库未被本轮触碰：没有留下任何 probe_ 前缀的模型',
  devProbeLeft === '0',
  `开发库 flowModels=${devModels} 行；其中 probe_ 前缀残留=0`);

const failed = results.filter((r) => !r.pass);
fs.mkdirSync(path.join(process.cwd(), '.tmp-verify/evidence/r0freeze'), { recursive: true });
fs.writeFileSync(
  path.join(process.cwd(), '.tmp-verify/evidence/r0freeze/b1-probe.json'),
  JSON.stringify({
    at: new Date().toISOString(),
    arcFingerprint: arcFp, arcCollection: arcColl,
    existingNegativeControl: { uid: 'pac49kftubs', fingerprint: bizFpDev, gap: 'create=0/edit=0 ⇒ 未回答"含 create+edit 的非 ARC 页"' },
    P1_plainBizPage: { uid: P1_UID, fingerprint: p1Fp, verdict: p1Verdict, decision: p1Dec.verdict, collectionName: 'serviceVisits' },
    P2_arcBlockWrongColl: { uid: P2_UID, fingerprint: p2Fp, verdict: p2Verdict, decision: p2Dec.verdict, collectionName: p2Coll },
    P3_arcBlockRightColl: { uid: 'probe_arc_true_p3', fingerprint: p3Fp, verdict: p3Verdict, collectionName: 'serviceArchives' },
    results,
  }, null, 2),
);
console.log(`\n汇总：PASS ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log(`FAIL：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
