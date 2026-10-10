#!/usr/bin/env node
/**
 * verify-schema-layers.mjs —— 新增字段的**三层一致性**验收（真库侧）
 * =============================================================================
 *
 * 为什么要有这个文件（不是"又多一支脚本"）
 * -----------------------------------------------------------------------------
 * 本项目在"新增字段"这件事上已经踩过**三次同一个坑**：
 *   `current_store_entered_at`、`next_follow_at`，以及更早的一次 ——
 *   表现都是 **`applyBlueprint` 报 `default-field-groups-incomplete` 并整页 400**，
 *   而"库里列建好了、接口能读能写"**全都正常**。根因是三层里漏了最容易被忘的那层。
 *
 * 而 `scripts/verify-plugin-load.mjs` 的迁移检查**离线跑不到**这几条迁移：
 * 它的假库不建模 `fields` 元数据表，也不建模 DDL 探测。它现在把这几条
 * **显式归类**为"离线不覆盖"，并指向本文件。
 *   ⇒ **本文件就是那个承诺的兑现**：在**真库**上逐字段核对三层，
 *     而不是在假库上再模拟一遍数据库（模拟得再像，也不如直接去问真库）。
 *
 * -----------------------------------------------------------------------------
 * 五层判据（缺一层都会出现"看着没事、实际某一侧没生效"）
 * -----------------------------------------------------------------------------
 * | # | 层次 | 判据 | 漏了会怎样 |
 * |---|---|---|---|
 * | ① | **PostgreSQL DDL** | `information_schema.columns` 有该列，且**类型/可空性**与期望一致 | 列不存在 ⇒ 接口 500；类型不符 ⇒ 写进去被截断/报错 |
 * | ② | **NocoBase `fields` 元数据** | 恰好 1 行，且 `type` / `options.allowNull` / `uiSchema.title` 与期望一致 | 列在库里但 ORM/界面**当它不存在** ⇒ 后端写不进、界面看不到 |
 * | ③ | **插件 collection 定义** | `src/server/collections/*.ts` 里**确实声明**了该字段 | 下次 `sync()` 可能把列改回去 / 新环境装出来没有这一列 |
 * | ④ | **迁移已登记** | 真库 `migrations` 表里有这条迁移（umzug 只在 `up()` **成功**后登记） | "迁移写了但没跑"—— 新环境少一列，且当时不报错 |
 * | ⑤ | **页面 fieldGroups** | `scripts/seed-admin-pages.mjs` 的 `FIELD_GROUPS[集合]` 覆盖了该字段 | **整页 400**（本坑已被踩三次） |
 *
 * ⚠️ ⑤ 是**静态**检查（读源码），但它挡的正是最容易复发的那一类 ——
 *    而且它必须在 `applyBlueprint` **之前**就能判：等到 seed 跑出 400 才发现已经是事后。
 *    本文件与 `seed-admin-pages.mjs` 用**同一个集合键**，构造上不会两边各说一套。
 *
 * 用法：
 *   node scripts/verify-schema-layers.mjs            # 完整核对（需要 docker + 真库）
 *   node scripts/verify-schema-layers.mjs --list     # 只打印清单
 *   node scripts/verify-schema-layers.mjs --selftest # 只跑"判据有牙齿"的自证（不需要数据库）
 * 退出码：0 全部通过 / 1 有未达标项 / 2 环境未就绪或验收器自身异常
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN_SRC = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server');
const COLLECTIONS_DIR = path.join(PLUGIN_SRC, 'collections');
const SEED_SRC = path.join(ROOT, 'scripts/seed-admin-pages.mjs');

const LIST_ONLY = process.argv.includes('--list');
const SELFTEST_ONLY = process.argv.includes('--selftest');

// ---------------------------------------------------------------------------
// 清单：**新增字段必须登记在这里**（否则本文件对它一言不发 —— 那是最坏的空白）
// ---------------------------------------------------------------------------
/**
 * 每条 = 一个字段在五个层次上的**期望值**。
 *
 * ⚠️ 期望值一律**逐字**写死（类型、可空、标题、迁移名）。
 *    允许"从源码推导期望"会让两侧同时错还互相印证 —— 那是本项目最忌讳的假绿形状。
 *    这里的期望是**人工策展的契约**，源/库/元数据都必须与它对齐。
 */
const FIELDS = [
  {
    // P11-1 · B-16 / P11-1-b：当前跟进待办
    collection: 'serviceTickets',
    table: 'service_tickets',
    column: 'next_follow_at',
    ddl: { dataType: 'timestamp with time zone', nullable: 'YES' },
    meta: { type: 'date', allowNull: 'true', title: '下次跟进时间' },
    migration: '202610101-next-follow-at',
    note: 'P11-1 待跟进队列的"约定要发生的时间"',
  },
  {
    // P11-0：当前门店接手时间（与 first_response_at 成对）
    collection: 'serviceTickets',
    table: 'service_tickets',
    column: 'current_store_entered_at',
    ddl: { dataType: 'timestamp with time zone', nullable: 'YES' },
    meta: { type: 'date', allowNull: 'true', title: '当前门店接手时间' },
    migration: '20261009-store-workflow-fields',
    note: 'P11-0 契约 §5.4：区分"全局首次响应"与"当前门店接手后多久开始处理"',
  },
  // ---------------------------------------------------------------------------
  // Phase 11 / P11-1 服务单模型升级（§8.1 / §9.1）
  // ---------------------------------------------------------------------------
  {
    collection: 'serviceTickets',
    table: 'service_tickets',
    column: 'service_address',
    ddl: { dataType: 'character varying', nullable: 'YES' },
    meta: { type: 'string', allowNull: 'true', title: '服务地址' },
    migration: '202610102-ticket-model-fields',
    note: '§8.1 服务地址（客户提交选填；安排上门前由门店补全）',
  },
  {
    collection: 'serviceTickets',
    table: 'service_tickets',
    column: 'appliance_category',
    ddl: { dataType: 'character varying', nullable: 'YES' },
    meta: { type: 'string', allowNull: 'true', title: '家电类型' },
    migration: '202610102-ticket-model-fields',
    note: '§8.2 家电分类（固定枚举 7 项；不建 ERP 商品档案）',
  },
  {
    collection: 'serviceTickets',
    table: 'service_tickets',
    column: 'brand_model',
    ddl: { dataType: 'character varying', nullable: 'YES' },
    meta: { type: 'string', allowNull: 'true', title: '品牌/型号' },
    migration: '202610102-ticket-model-fields',
    note: '§8.1 品牌/型号（**单个**自由文本字段，不是两列）',
  },
  {
    collection: 'serviceTickets',
    table: 'service_tickets',
    column: 'urgent',
    ddl: { dataType: 'boolean', nullable: 'NO' },
    meta: { type: 'boolean', allowNull: 'false', title: '紧急' },
    migration: '202610102-ticket-model-fields',
    note: '§8.1 是否紧急（提示性标记；不改变状态机与 SLA 口径 ⇒ 非空、默认 false）',
  },
];

// ---------------------------------------------------------------------------
// psql
// ---------------------------------------------------------------------------
function psql(sql) {
  const r = spawnSync(
    'docker',
    [
      'exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
      '-t', '-A', '-F', '\u0001', '-c', sql,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    const err = `${r.stdout || ''}${r.stderr || ''}`.trim();
    const e = new Error(`psql 执行失败：${err.slice(0, 300)}`);
    e.envNotReady = true;
    throw e;
  }
  const out = String(r.stdout || '').trim();
  return out === '' ? [] : out.split('\n').map((line) => line.split('\u0001'));
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const state = { passed: 0, skipped: 0, failures: [] };
function ok(name, detail = '') {
  state.passed += 1;
  console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
}
function no(name, detail = '') {
  state.failures.push({ name, detail });
  console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 66 - title.length))}`);
}

// ---------------------------------------------------------------------------
// 采集器（真库）
// ---------------------------------------------------------------------------
function readDdl(entry) {
  const rows = psql(
    `SELECT data_type, is_nullable FROM information_schema.columns ` +
      `WHERE table_name = '${entry.table}' AND column_name = '${entry.column}'`,
  );
  if (rows.length === 0) return { exists: false };
  return { exists: true, dataType: rows[0][0], nullable: rows[0][1] };
}

function readMeta(entry) {
  const rows = psql(
    `SELECT type, coalesce(options::jsonb->>'allowNull',''), ` +
      `coalesce(options::jsonb#>>'{uiSchema,title}','') ` +
      `FROM fields WHERE "collectionName" = '${entry.collection}' AND name = '${entry.column}'`,
  );
  return rows.map((r) => ({ type: r[0], allowNull: r[1], title: r[2] }));
}

function readMigrationRows(name) {
  return psql(
    `SELECT name FROM migrations WHERE name LIKE '${name}%@local/service-ticket'`,
  );
}

// ---------------------------------------------------------------------------
// 比较器：**抽成纯函数**，这样"判据有没有牙齿"可以离线自证（见 --selftest）
// ---------------------------------------------------------------------------
function compareDdl(entry, actual) {
  const problems = [];
  if (!actual.exists) {
    problems.push('列在库里不存在（DDL 没落地）—— 接口会 500');
    return problems;
  }
  if (actual.dataType !== entry.ddl.dataType) {
    problems.push(`类型 ${actual.dataType} ≠ 期望 ${entry.ddl.dataType}`);
  }
  if (actual.nullable !== entry.ddl.nullable) {
    problems.push(`is_nullable=${actual.nullable} ≠ 期望 ${entry.ddl.nullable}`);
  }
  return problems;
}

function compareMeta(entry, rows) {
  const problems = [];
  // 🔴 先断言行数：`fields` 里**没有这一行**时，"字段都在、属性都对"这种判据会**空过**
  if (rows.length !== 1) {
    problems.push(`fields 元数据 ${rows.length} 行（期望恰好 1 行）—— 缺行意味着 ORM/界面当它不存在`);
    return problems;
  }
  const r = rows[0];
  if (r.type !== entry.meta.type) problems.push(`type=${r.type} ≠ ${entry.meta.type}`);
  if (r.allowNull !== entry.meta.allowNull) {
    problems.push(`allowNull=${r.allowNull} ≠ ${entry.meta.allowNull}`);
  }
  if (r.title !== entry.meta.title) problems.push(`title=${JSON.stringify(r.title)} ≠ ${JSON.stringify(entry.meta.title)}`);
  return problems;
}

function compareCollection(entry, declarations) {
  if (declarations.length === 0) {
    return [`collections/*.ts 里没有任何文件声明 ${entry.column}`];
  }
  if (declarations.length > 1) {
    return [
      `${entry.column} 在多个集合文件里出现：${declarations.join(', ')} —— 同名双份，迟早漂移`,
    ];
  }
  return [];
}

function compareMigration(entry, rows) {
  if (rows.length === 0) {
    return [
      `migrations 表里没有 ${entry.migration} 的登记 —— 迁移没跑成功（umzug 只在 up() 成功后才登记）`,
    ];
  }
  return [];
}

/**
 * 静态读 `seed-admin-pages.mjs` 的 `FIELD_GROUPS`。
 *
 * ⚠️ 与 `verify-plugin-load` 读 `constants.ts` 用的是**同一种手法**（正则切块 + 严格匹配行），
 *    理由也相同：那份文件不是 JSON，不能在 Node 里 require（它是 ESM 且带副作用）。
 *    但这里**只**解析字段名，不试图理解别的语义 —— 解析面越窄，误判越少。
 */
function readFieldGroups() {
  const src = fs.readFileSync(SEED_SRC, 'utf8');
  const block = /const FIELD_GROUPS = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('未能在 seed-admin-pages.mjs 中定位 FIELD_GROUPS');
  const body = block[1];
  /** @type {Map<string, Set<string>>} */
  const byCollection = new Map();
  // 每个集合：`  <collection>: [ … ],`
  const collectionRe = /^ {2}([a-zA-Z][A-Za-z0-9_]*): \[([\s\S]*?)^ {2}\],$/gm;
  let m;
  while ((m = collectionRe.exec(body)) !== null) {
    const fields = new Set(
      [...m[2].matchAll(/^\s*'([A-Za-z0-9_]+)',/gm)].map((x) => x[1]),
    );
    byCollection.set(m[1], fields);
  }
  return byCollection;
}

function readCollectionDeclarations(column) {
  const out = [];
  for (const name of fs.readdirSync(COLLECTIONS_DIR)) {
    if (!name.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(COLLECTIONS_DIR, name), 'utf8');
    if (new RegExp(`'${column}'`).test(src)) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// --selftest：判据必须有牙齿（离线，不需要数据库）
// ---------------------------------------------------------------------------
/**
 * 反证方式：把**采集到的真实值**故意改坏一位，断言比较器**必须**报出问题。
 *
 * ⚠️ 为什么不用"造一份假数据"：假数据只能证明"比较器能比出差异"，
 *    而这里要证明的是"**我的期望**与**真实情况**对得上时它安静、对不上时它吵"。
 *    所以自证用真值 + 一位扰动，最贴近真实误配。
 */
function selftest() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  判据自证：把真实值扰动一位，比较器必须报错（离线，不需要库）');
  console.log('══════════════════════════════════════════════════════════════');
  const entry = FIELDS[0];
  let faults = 0;

  const cases = [
    {
      label: 'DDL · 类型改名后必须报错',
      run: () =>
        compareDdl(entry, { exists: true, dataType: 'timestamp without time zone', nullable: 'YES' }),
    },
    {
      label: 'DDL · 列不存在必须报错',
      run: () => compareDdl(entry, { exists: false }),
    },
    {
      label: 'DDL · 可空性反了必须报错',
      run: () => compareDdl(entry, { exists: true, dataType: entry.ddl.dataType, nullable: 'NO' }),
    },
    {
      label: 'DDL · 全对时必须**安静**（否则判据恒红＝没有判据）',
      run: () => compareDdl(entry, { exists: true, ...entry.ddl }),
      expectSilent: true,
    },
    {
      label: '元数据 · 行数为 0 必须报错（"没查到"不得当成"都对"）',
      run: () => compareMeta(entry, []),
    },
    {
      label: '元数据 · 行数为 2 必须报错（重复行）',
      run: () => compareMeta(entry, [{ ...entry.meta }, { ...entry.meta }]),
    },
    {
      label: '元数据 · title 被改必须报错',
      run: () => compareMeta(entry, [{ ...entry.meta, title: '别的标题' }]),
    },
    {
      label: '元数据 · 全对时必须安静',
      run: () => compareMeta(entry, [{ ...entry.meta }]),
      expectSilent: true,
    },
    {
      label: 'collection · 没有任何文件声明必须报错',
      run: () => compareCollection(entry, []),
    },
    {
      label: 'collection · 两个文件声明同名必须报错',
      run: () => compareCollection(entry, ['a.ts', 'b.ts']),
    },
    {
      label: '迁移 · 未登记必须报错',
      run: () => compareMigration(entry, []),
    },
    {
      label: '迁移 · 已登记时必须安静',
      run: () => compareMigration(entry, [['x']]),
      expectSilent: true,
    },
  ];

  for (const c of cases) {
    const problems = c.run();
    const silent = problems.length === 0;
    const good = c.expectSilent ? silent : !silent;
    if (good) {
      console.log(`  ✓ ${c.label}`);
    } else {
      console.log(`  ✗ ${c.label}${c.expectSilent ? '（期望安静却有报错）' : '（期望报错却安静）'}`);
      faults += 1;
    }
  }
  if (faults) {
    console.log(`\n  ❌ ${faults} 条自证未达标 —— 判据的牙齿不齐，不能据此宣布通过`);
    return 1;
  }
  console.log('\n  ✅ 判据自证全部达标。');
  return 0;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  if (FIELDS.length === 0) {
    throw Object.assign(new Error('清单为空 —— 没有可核对的字段，本门禁会永远"通过"'), {
      envNotReady: true,
    });
  }

  if (LIST_ONLY) {
    for (const e of FIELDS) {
      console.log(`${e.collection}.${e.column} → ${e.table}.${e.column} · 迁移 ${e.migration}`);
    }
    return 0;
  }

  const fieldGroups = readFieldGroups();
  console.log(`清单 ${FIELDS.length} 个字段；FIELD_GROUPS 解析出 ${fieldGroups.size} 个集合`);

  for (const entry of FIELDS) {
    section(`${entry.collection}.${entry.column} · ${entry.note ?? ''}`);

    // ① DDL
    const ddl = readDdl(entry);
    const ddlProblems = compareDdl(entry, ddl);
    if (ddlProblems.length) no('① PostgreSQL DDL', ddlProblems.join('；'));
    else ok('① PostgreSQL DDL', `${ddl.dataType} · is_nullable=${ddl.nullable}`);

    // ② fields 元数据
    const metaRows = readMeta(entry);
    const metaProblems = compareMeta(entry, metaRows);
    if (metaProblems.length) no('② NocoBase fields 元数据', metaProblems.join('；'));
    else ok('② NocoBase fields 元数据', `${metaRows[0].type} · allowNull=${metaRows[0].allowNull} · 「${metaRows[0].title}」`);

    // ③ collection 定义
    const decls = readCollectionDeclarations(entry.column);
    const declProblems = compareCollection(entry, decls);
    if (declProblems.length) no('③ 插件 collection 定义', declProblems.join('；'));
    else ok('③ 插件 collection 定义', `声明于 ${decls[0]}`);

    // ④ 迁移已登记
    const migRows = readMigrationRows(entry.migration);
    const migProblems = compareMigration(entry, migRows);
    if (migProblems.length) no('④ 迁移已登记', migProblems.join('；'));
    else ok('④ 迁移已登记', migRows[0][0]);

    // ⑤ 页面 fieldGroups
    const group = fieldGroups.get(entry.collection);
    if (!group) {
      no('⑤ 页面 fieldGroups', `FIELD_GROUPS 里没有集合 ${entry.collection}`);
    } else if (!group.has(entry.column)) {
      no(
        '⑤ 页面 fieldGroups',
        `${entry.collection} 的分组里没有 ${entry.column} —— applyBlueprint 会报 ` +
          '`default-field-groups-incomplete` 并**整页 400**（本坑已踩三次）',
      );
    } else {
      ok('⑤ 页面 fieldGroups', `${entry.collection} 分组已覆盖`);
    }
  }

  // ---- 反向：FIELD_GROUPS 里不得出现"库里不存在"的字段名（幽灵字段）----
  // 幽灵字段同样会让 applyBlueprint 报错（列名对不上），而它很难被正向判据发现。
  section('反向：FIELD_GROUPS 不得包含不存在的列');
  {
    const ghosts = [];
    for (const [collection, fields] of fieldGroups) {
      if (collection === 'stores') continue; // stores 是既有集合，由 smoke 的页面断言覆盖
      const rows = psql(
        `SELECT name FROM fields WHERE "collectionName" = '${collection}'`,
      ).map((r) => r[0]);
      if (rows.length === 0) {
        // 读到空不能当成"没有幽灵"（铁律 10）
        ghosts.push(`${collection}: fields 元数据 0 行 —— 集合名可能写错`);
        continue;
      }
      const known = new Set(rows);
      for (const f of fields) {
        if (!known.has(f)) ghosts.push(`${collection}.${f}`);
      }
    }
    if (ghosts.length === 0) ok('FIELD_GROUPS 的每个字段名都能在 fields 元数据里找到');
    else no('FIELD_GROUPS 里存在幽灵字段名', ghosts.slice(0, 8).join(', '));
  }

  return state.failures.length ? 1 : 0;
}

if (SELFTEST_ONLY) {
  process.exit(selftest());
}

let code = 0;
try {
  code = main();
} catch (error) {
  if (error?.envNotReady) {
    console.log(`\n  🟡 环境未就绪（退出码 2）：${error.message}\n`);
    process.exit(2);
  }
  console.log(`\n  ❌ 脚本异常：${error?.stack ?? error}\n`);
  process.exit(2);
}

console.log(`\n=== 汇总：通过 ${state.passed} 项 / 未达标 ${state.failures.length} 项 ===`);
for (const f of state.failures) console.log(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
process.exit(code);
