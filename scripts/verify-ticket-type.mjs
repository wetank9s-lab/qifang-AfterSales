#!/usr/bin/env node
/**
 * verify-ticket-type.mjs —— 工单类型**六类**扩展的兼容性 / 隔离 / 冻结边界门禁
 * （Phase 11 / P11-1 · 用户 B 段）
 *
 * ===========================================================================
 * 这一段要防的是什么
 * ===========================================================================
 * 用户 B 段的要求可以拆成**一句话三条红线**：
 *   ① 六类（维修/安装/调试保养/移机拆机/投诉/其他）是**内部工单分类**，
 *      **不是六个客户报修选项** —— 客户 H5 仍只有"我要报修 / 我要投诉"两个入口；
 *   ② 扩展必须**向后兼容**：不能有存量工单查不出来，也不能静默改写历史业务类型；
 *   ③ 不得改动已冻结的六个工单状态，也不得让所有业务类型都强制走师傅上门。
 *
 * 这三条都**不会**因为写错而报错 —— 它们只会安静地变成：
 *   · 匿名面冒出六个选项（客户能自己选"移机"）；
 *   · 存量 `repair` 的含义被改写、或列表按类型筛不出旧单；
 *   · 六类里有一类被悄悄自动派工（或状态机被顺手改了）。
 *
 * ⇒ 所以本文件的判据一律带**反向**（正例 + 反例成对），并且每一条"新写的量法"
 *   都配一个**变异测试**（人为把缺陷放回去，确认判据真的会红）。
 *   没有反向的断言 = 没有断言；不会变红的量法 = 在空转。
 *
 * ===========================================================================
 * 本文件覆盖 / **不**覆盖（诚实边界）
 * ===========================================================================
 * 覆盖：常量层、collection 定义层、DDL 层、`fields` 元数据层、迁移登记 + 产物、
 *      `fieldGroups`、匿名面隔离（真 HTTP）、存量可查（真 HTTP + 真库）、
 *      六类在**建单后形态一致**（真库夹具）、冻结状态未被改动。
 *
 * ⚠️ **不**覆盖：**内部六类端到端建单**。原因是当前代码里
 *    `services.tickets.create()` 的**唯一调用方**就是匿名接口
 *    （`actions/public/ticket.ts`），而匿名面按设计只接受两类 ——
 *    也就是说"内部建一张安装单"这条路径**现在还不存在**（属 §9 / P11-2 门店人工新建）。
 *    所以本文件对这一层的判据是：
 *      · **服务层契约**：`create()` 用 `TICKET_TYPE_VALUES`（六类）做枚举校验，
 *        且方法体内**没有任何按类型分叉**（见 §5 的两条变异测试）；
 *      · **数据形态**：六类夹具在建单后的形态完全一致（不自动派工）。
 *    **不宣称**"六类已端到端打通"。等 §9 落地后由门店侧建单门禁补齐那一段。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';
import {
  EnvNotReady,
  assert,
  envValue,
  http,
  makeChecker,
  psqlExec,
  psqlRows,
  psqlScalar,
  runMain,
  signIn,
} from './technician-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server');
const CONSTANTS_TS = path.join(SRC, 'constants.ts');
const OPTIONS_TS = path.join(SRC, 'collections/_options.ts');
const SERVICE_TICKETS_TS = path.join(SRC, 'collections/serviceTickets.ts');
const TICKET_SERVICE_TS = path.join(SRC, 'services/ticket-service.ts');
const PUBLIC_TICKET_TS = path.join(SRC, 'actions/public/ticket.ts');
const SEED_PAGES_MJS = path.join(ROOT, 'scripts/seed-admin-pages.mjs');
const MIGRATION_TS = path.join(SRC, 'migrations/202610104-ticket-type-six.ts');
const MIGRATION_JS = path.join(
  ROOT,
  'storage/plugins/@local/service-ticket/dist/server/migrations/202610104-ticket-type-six.js',
);

const BASE = SVC_BASE_URL;
const STORE = 'S01';
/** 夹具内容前缀：既是"这是验收数据不是业务数据"的标记，也是清理时的收口条件 */
const FIXTURE_TAG = '[P11-1-B]';

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// 期望值（**手写**，故意不从被测源码派生 —— 从被测源码派生的期望值永远相等）
// ---------------------------------------------------------------------------
/** 六类：key = 常量名、value = 落库码、label = 内部展示名 */
const EXPECT_TYPES = [
  { key: 'REPAIR', value: 'repair', label: '维修' },
  { key: 'INSTALLATION', value: 'installation', label: '安装' },
  { key: 'MAINTENANCE', value: 'maintenance', label: '调试保养' },
  { key: 'RELOCATION', value: 'relocation', label: '移机拆机' },
  { key: 'COMPLAINT', value: 'complaint', label: '投诉' },
  { key: 'OTHER', value: 'other', label: '其他' },
];
/** 匿名面**只允许**这两种（顺序也在判据里：repair 在前） */
const EXPECT_PUBLIC_TYPES = ['repair', 'complaint'];
/** 冻结的六个工单状态（用户 2026-10-10：**不得改动**） */
const EXPECT_FROZEN_STATUS = [
  'NEW',
  'PROCESSING',
  'WAIT_STORE_CONFIRM',
  'WAIT_FEEDBACK',
  'CLOSED',
  'CANCELLED',
];
const EXPECT_FROZEN_STATUS_LABEL = {
  NEW: '待处理',
  PROCESSING: '处理中',
  WAIT_STORE_CONFIRM: '待门店确认',
  WAIT_FEEDBACK: '待客户评价',
  CLOSED: '已闭环',
  CANCELLED: '已取消',
};
const EXPECT_FROZEN_TRANSITIONS = {
  NEW: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['WAIT_STORE_CONFIRM', 'WAIT_FEEDBACK', 'CANCELLED'],
  WAIT_STORE_CONFIRM: ['WAIT_FEEDBACK', 'PROCESSING'],
  WAIT_FEEDBACK: ['CLOSED', 'PROCESSING'],
  CLOSED: ['PROCESSING'],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// 纯函数解析器（**独立、可自测** —— 解析器自己错了比产品错了更隐蔽）
// ---------------------------------------------------------------------------
const j = (v) => JSON.stringify(v);

/** 解析 `export const NAME = { KEY: 'value', ... } as const;` */
function parseConstObject(text, name) {
  const m = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`).exec(text);
  if (!m) throw new Error(`解析不到 export const ${name} = {...} as const;`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Z_][A-Z0-9_]*):\s*'([^']*)'\s*,\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** 解析 `PUBLIC_TICKET_TYPE_VALUES: string[] = [TICKET_TYPE.REPAIR, TICKET_TYPE.COMPLAINT];` */
function parsePublicTypeValues(text, typeMap) {
  const m = /export const PUBLIC_TICKET_TYPE_VALUES[^=]*=\s*\[([^\]]*)\]/.exec(text);
  if (!m) throw new Error('解析不到 PUBLIC_TICKET_TYPE_VALUES 的数组字面量');
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const ref = /^TICKET_TYPE\.([A-Z_]+)$/.exec(token);
      if (ref) {
        if (!(ref[1] in typeMap)) throw new Error(`引用了不存在的 TICKET_TYPE.${ref[1]}`);
        return typeMap[ref[1]];
      }
      const lit = /^'([^']*)'$/.exec(token);
      if (lit) return lit[1];
      throw new Error(`PUBLIC_TICKET_TYPE_VALUES 里有解析不了的项：${token}`);
    });
}

/** 解析 `export const NAME: Record<string, string> = { [TICKET_TYPE.X]: 'label', ... };` */
function parseTypeLabel(text, name, typeMap) {
  const m = new RegExp(`export const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`).exec(
    text,
  );
  if (!m) throw new Error(`解析不到 ${name}`);
  const out = {};
  const re = /\[TICKET_TYPE\.([A-Z_]+)\]:\s*'([^']*)'/g;
  let hit;
  while ((hit = re.exec(m[1]))) {
    const value = typeMap[hit[1]];
    if (!value) throw new Error(`${name} 里引用了不存在的 TICKET_TYPE.${hit[1]}`);
    out[value] = hit[2];
  }
  return out;
}

/** 解析 `_options.ts` 的 `TICKET_TYPE_OPTIONS = [{ label, value }, ...]` */
function parseTypeOptions(text) {
  const m = /export const TICKET_TYPE_OPTIONS = \[([\s\S]*?)\];/.exec(text);
  if (!m) throw new Error('解析不到 TICKET_TYPE_OPTIONS');
  const out = [];
  const re = /\{\s*label:\s*'([^']*)',\s*value:\s*'([^']*)'\s*\}/g;
  let hit;
  while ((hit = re.exec(m[1]))) out.push({ label: hit[1], value: hit[2] });
  return out;
}

/** 解析 `ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = { KEY: ['A','B'], ... };` */
function parseTransitions(text) {
  const m =
    /export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus\[\]> = \{([\s\S]*?)\n\};/.exec(
      text,
    );
  if (!m) throw new Error('解析不到 ALLOWED_TRANSITIONS');
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Z_]+):\s*\[([^\]]*)\],?\s*$/.exec(line);
    if (!kv) continue;
    out[kv[1]] = kv[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^'|'$/g, ''));
  }
  return out;
}

/**
 * 截出类方法体：从 `signature` 起，到**两空格缩进的 `}`** 为止。
 *
 * 用缩进当边界是**刻意**的：类方法都在 2 空格缩进上收尾，而方法体内部的
 * 花括号都在 ≥4 空格 ⇒ 只有方法结尾会命中 `\n  }\n`。
 * 但这不是"永远成立"的假设，所以匹配不到时**报错**而不是静默返回半截
 * （返回半截的后果是"按类型分叉"那条判据看不到后半段 ⇒ 假绿）。
 */
function methodBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error(`找不到方法签名：${signature}`);
  const end = text.indexOf('\n  }\n', start);
  if (end < 0) throw new Error(`找不到 ${signature} 的收尾花括号（缩进约定可能改了）`);
  return text.slice(start, end);
}

/**
 * `create()` 里**允许**出现的 `ticketType` 形态。
 *
 * 判据的意图：六类扩展最容易漏的一处，是某个**二元假设**留在创建路径里
 * （本项目当场就抓到一个：事件摘要写的是 `ticketType === 'complaint' ? '投诉' : '报修'`，
 *  六类里除投诉外统统被说成"报修"）。这类残留**不报错**，只在文案/分派上错。
 * ⇒ 允许清单是**逐条列出**的：新增一处按类型分叉就会红，逼作者来这个文件里
 *   明确"新加的这一处是有意为之"。
 */
const ALLOWED_TICKETTYPE_LINE = [
  /this\.assertEnum\(input\.ticketType,\s*TICKET_TYPE_VALUES,\s*'ticket_type'\)/,
  /^\s*ticketType,?\s*$/,
  /^\s*ticket_type:\s*ticketType,?\s*$/,
  /^\s*summary:\s*`客户提交\$\{TICKET_TYPE_LABEL\[ticketType\]\s*\?\?\s*ticketType\}/,
  /^\s*\/\//,
  /^\s*\*/,
];

/** 返回 create() 里所有**不在允许清单内**的 ticketType 行 */
function disallowedTicketTypeLines(body) {
  return body
    .split('\n')
    .filter((line) => /\bticketType\b/.test(line))
    .filter((line) => !ALLOWED_TICKETTYPE_LINE.some((re) => re.test(line)));
}

// ===========================================================================
// 清理登记表（**模块级**，边造边登记）
// ===========================================================================
/**
 * 🔴 为什么是模块级、且在**造出 id 的当场**就 push，而不是 main() 返回时统一登记：
 *    本项目已经吃过一次亏 —— 断言在"登记"之前抛错，于是清理清单是空的，
 *    两张 `urgent=true` 的走查单被留在生产库里，谁都不知道。
 *    ⇒ 纪律：**先登记 id，再写断言**。任何一步失败，cleanup 都拿得到完整名单。
 */
const registry = { created: [], fixtures: [] };

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  const { check, checkAsync, summary } = makeChecker({ heading: '工单类型六类扩展' });

  const created = registry.created;
  const fixtures = registry.fixtures;

  // -------------------------------------------------------------------------
  console.log('\n── 1 常量 / 共享层（源码逐字 + 反向） ─────────────────────────────');
  // -------------------------------------------------------------------------
  const constantsText = read(CONSTANTS_TS);
  const typeMap = parseConstObject(constantsText, 'TICKET_TYPE');
  const publicTypes = parsePublicTypeValues(constantsText, typeMap);
  const typeLabels = parseTypeLabel(constantsText, 'TICKET_TYPE_LABEL', typeMap);

  check('① 常量层恰好是这六类（key/value 逐个逐字，多一个少一个都红）', () => {
    const expect = {};
    for (const t of EXPECT_TYPES) expect[t.key] = t.value;
    assert(
      j(typeMap) === j(expect),
      `TICKET_TYPE = ${j(typeMap)}，期望 ${j(expect)}`,
    );
    return Object.values(typeMap).join(' / ');
  });

  check('① 内部标签文案六项逐字一致（repair 叫「维修」而不是「报修」）', () => {
    const expect = {};
    for (const t of EXPECT_TYPES) expect[t.value] = t.label;
    assert(j(typeLabels) === j(expect), `TICKET_TYPE_LABEL = ${j(typeLabels)}，期望 ${j(expect)}`);
    return Object.entries(typeLabels).map(([k, v]) => `${k}=${v}`).join(' ');
  });

  check('① 匿名面白名单**只有两类**且顺序为 repair, complaint（不是六个）', () => {
    assert(
      j(publicTypes) === j(EXPECT_PUBLIC_TYPES),
      `PUBLIC_TICKET_TYPE_VALUES = ${j(publicTypes)}，期望 ${j(EXPECT_PUBLIC_TYPES)}`,
    );
    return publicTypes.join(' / ');
  });

  check('① 反向：匿名白名单与内部六类**必须是两个不同的集合**（防"哪天有人把它们合并"）', () => {
    const internal = Object.values(typeMap);
    assert(
      publicTypes.length !== internal.length,
      `匿名白名单与内部六类长度都是 ${internal.length} —— 六类泄漏成客户选项了`,
    );
    assert(
      publicTypes.length === 2,
      `匿名白名单有 ${publicTypes.length} 项，期望 2（客户只有"我要报修/我要投诉"两个入口）`,
    );
    for (const v of publicTypes) {
      assert(internal.includes(v), `匿名白名单里的 ${v} 不在内部六类里 —— 两处定义已经漂移`);
    }
    return `内部 ${internal.length} 类 / 匿名 ${publicTypes.length} 类，且匿名 ⊆ 内部`;
  });

  check('① 匿名接口的枚举集合取自 PUBLIC_TICKET_TYPE_VALUES（不是 TICKET_TYPE_VALUES）', () => {
    const src = read(PUBLIC_TICKET_TS);
    assert(
      /const TYPE_SET: ReadonlySet<string> = new Set<string>\(PUBLIC_TICKET_TYPE_VALUES\)/.test(src),
      'TYPE_SET 不是从 PUBLIC_TICKET_TYPE_VALUES 构造的 —— 匿名面可能直接吃六类',
    );
    // 反向：匿名面源码里**不该**出现对内部六类常量的引用（注释除外）
    const codeLines = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter((line) => /\bTICKET_TYPE_VALUES\b/.test(line));
    assert(
      codeLines.length === 0,
      `匿名接口里出现了对内部六类常量的引用：${codeLines.join(' | ')}`,
    );
    return 'TYPE_SET ← PUBLIC_TICKET_TYPE_VALUES；无内部六类引用';
  });

  // ---- 解析器自测：证明上面几条**真的会红**（在内存里做变异，不碰真实文件）----
  check('① 解析器自测：六项里多一项 / 匿名白名单多一项，都会被解析出来（判据是活的）', () => {
    const mutatedConstants = constantsText.replace(
      /(export const TICKET_TYPE = \{[\s\S]*?)\} as const;/,
      "$1  BOGUS: 'bogus',\n} as const;",
    );
    const mutatedMap = parseConstObject(mutatedConstants, 'TICKET_TYPE');
    assert(
      Object.keys(mutatedMap).length === EXPECT_TYPES.length + 1,
      `给 TICKET_TYPE 塞了第 7 项，解析器只读到 ${Object.keys(mutatedMap).length} 项 —— 解析器在空转`,
    );

    const mutatedPublic = constantsText.replace(
      /export const PUBLIC_TICKET_TYPE_VALUES[^=]*=\s*\[/,
      'export const PUBLIC_TICKET_TYPE_VALUES: string[] = [TICKET_TYPE.OTHER, ',
    );
    const mutatedTypes = parsePublicTypeValues(mutatedPublic, typeMap);
    assert(
      mutatedTypes.length === 3,
      `给匿名白名单塞了第 3 项，解析器只读到 ${mutatedTypes.length} 项 —— 解析器在空转`,
    );
    return '两个解析器都能看见变异';
  });

  // -------------------------------------------------------------------------
  console.log('\n── 2 五层一致性：collection / DDL / fields 元数据 / 迁移登记 / fieldGroups ──');
  // -------------------------------------------------------------------------
  const optionsText = read(OPTIONS_TS);
  const typeOptions = parseTypeOptions(optionsText);
  const ticketsText = read(SERVICE_TICKETS_TS);

  check('② collection 定义层：TICKET_TYPE_OPTIONS 六项，与 TICKET_TYPE_LABEL 逐字对齐', () => {
    const expect = EXPECT_TYPES.map((t) => ({ label: t.label, value: t.value }));
    assert(j(typeOptions) === j(expect), `TICKET_TYPE_OPTIONS = ${j(typeOptions)}，期望 ${j(expect)}`);
    return typeOptions.map((o) => `${o.value}=${o.label}`).join(' ');
  });

  check('② collection 定义层：serviceTickets.ticket_type 用的是 TICKET_TYPE_OPTIONS 且 NOT NULL', () => {
    const re = /enumStr\('ticket_type',\s*'工单类型',\s*([A-Za-z_][\w.]*),\s*\{([^}]*)\}/.exec(
      ticketsText,
    );
    assert(re, '解析不到 serviceTickets 的 ticket_type 定义（enumStr(...)）');
    assert(
      re[1] === 'TICKET_TYPE_OPTIONS',
      `ticket_type 的选项来自 ${re[1]}，期望 TICKET_TYPE_OPTIONS`,
    );
    assert(/allowNull:\s*false/.test(re[2]), `ticket_type 的 allowNull 不是 false：${re[2]}`);
    return `enumStr(ticket_type, TICKET_TYPE_OPTIONS, allowNull:false)`;
  });

  // ---- DDL：真库 ----
  const colRow = psqlRows(
    `SELECT data_type, character_maximum_length, is_nullable, coalesce(column_default,'<NULL>') ` +
      `FROM information_schema.columns WHERE table_name='service_tickets' AND column_name='ticket_type'`,
  )[0];
  check('② DDL 层：ticket_type 是 varchar(255) NOT NULL（不是 PG 原生 enum 类型）', () => {
    assert(colRow, 'service_tickets.ticket_type 列不存在');
    assert(colRow[0] === 'character varying', `列类型是 ${colRow[0]}，期望 character varying`);
    assert(colRow[1] === '255', `长度是 ${colRow[1]}，期望 255`);
    assert(colRow[2] === 'NO', `is_nullable = ${colRow[2]}，期望 NO`);
    return `${colRow[0]}(${colRow[1]}) NOT NULL`;
  });

  check('② DDL 层：若存在 CHECK 约束，必须覆盖全部六类（当前无约束则如实说明）', () => {
    const defs = psqlRows(
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint ` +
        `WHERE conrelid='service_tickets'::regclass AND contype='c'`,
    ).map((r) => r[0]);
    const relevant = defs.filter((d) => /ticket_type/.test(d));
    if (relevant.length === 0) {
      // ⚠️ 这条是**如实记录**，不是"通过"：枚举约束**不在 DDL 上**，
      //    所以"服务层校验"不是可选项 —— 它一旦漏了就没有第二道防线。
      //    下面的 §3 / §5 正是按这个前提去查服务层的。
      return 'DB 侧无 CHECK 约束（枚举约束由服务层 assertEnum 承担，见 §5）';
    }
    for (const d of relevant) {
      for (const t of EXPECT_TYPES) {
        assert(d.includes(`'${t.value}'`), `CHECK 约束漏了 ${t.value}：${d}`);
      }
    }
    return `${relevant.length} 条 CHECK 覆盖六类`;
  });

  // ---- fields 元数据：真库 ----
  const enumText = psqlScalar(
    `SELECT options #>> '{uiSchema,enum}' FROM fields ` +
      `WHERE "collectionName"='serviceTickets' AND name='ticket_type'`,
  );
  check('② fields 元数据层：uiSchema.enum 逐字六项（label 与 value 都要对，含顺序）', () => {
    assert(enumText, 'fields 里查不到 serviceTickets.ticket_type 的 uiSchema.enum');
    const parsed = JSON.parse(enumText);
    const expect = EXPECT_TYPES.map((t) => ({ label: t.label, value: t.value }));
    assert(j(parsed) === j(expect), `uiSchema.enum = ${j(parsed)}，期望 ${j(expect)}`);
    return parsed.map((o) => `${o.value}=${o.label}`).join(' ');
  });

  // ---- 迁移登记 + 产物 ----
  check('② 迁移登记层：migrations 表里有 202610104-ticket-type-six/@local/service-ticket', () => {
    const rows = psqlRows(
      `SELECT name FROM migrations WHERE name LIKE '202610104-ticket-type-six%'`,
    ).map((r) => r[0]);
    assert(
      rows.includes('202610104-ticket-type-six/@local/service-ticket'),
      `migrations 里没有这条登记，实际命中：${rows.join(', ') || '<无>'}`,
    );
    return rows.join(', ');
  });

  check('② 迁移产物层：源 .ts 与挂进容器的 .js 产物都存在（产物路径错=迁移静默不跑）', () => {
    for (const p of [MIGRATION_TS, MIGRATION_JS]) {
      assert(fs.existsSync(p), `缺文件：${path.relative(ROOT, p)}`);
    }
    return `${path.relative(ROOT, MIGRATION_TS)} + ${path.relative(ROOT, MIGRATION_JS)}`;
  });

  check('② 迁移源码自检：只增不减（断言 legacy 值仍在枚举内），且不碰 fields.updated_at', () => {
    const src = read(MIGRATION_TS);
    assert(
      /LEGACY_VALUES\s*=\s*\[[^\]]*'repair'[^\]]*'complaint'[^\]]*\]/.test(src),
      '迁移里没有把 repair/complaint 声明为必须保留的 legacy 值',
    );
    assert(!/updated_at/.test(src.replace(/\/\/.*$/gm, '')), '迁移里又出现了 fields.updated_at（该列不存在，会让整个应用 503）');
    assert(/jsonb_set/.test(src), '迁移不是用 jsonb_set 精确落在 {uiSchema,enum} 上');
    return 'LEGACY 保留 + 无 updated_at + jsonb_set';
  });

  check('② fieldGroups：serviceTickets 的分组字段里有 ticket_type（否则后台列/筛选看不到它）', () => {
    const seed = read(SEED_PAGES_MJS);
    // 只从 `serviceTickets:` 那个集合块里取 `fields: [...]`
    const block = /serviceTickets:\s*\[([\s\S]*?)\n  \]/.exec(seed);
    assert(block, 'seed-admin-pages.mjs 里找不到 serviceTickets 的 FIELD_GROUPS 定义');
    const fields = [];
    const re = /fields:\s*\[([\s\S]*?)\]/g;
    let hit;
    while ((hit = re.exec(block[1]))) {
      for (const token of hit[1].split(',')) {
        const t = token.trim().replace(/^'|'$/g, '');
        if (t) fields.push(t);
      }
    }
    assert(fields.length > 0, 'serviceTickets 的 fieldGroups 里一个字段都没解析出来（解析器在空转）');
    assert(
      fields.includes('ticket_type'),
      `serviceTickets 的分组字段里没有 ticket_type：${fields.join(',')}`,
    );
    return `${fields.length} 个分组字段，含 ticket_type`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 3 匿名面隔离：六类里只有两类能被客户提交（真 HTTP，双向） ────────');
  // -------------------------------------------------------------------------
  // 每个用例一个**互不相同**的手机号：同毫秒内连打 6 次时，用 `Date.now()` 单独算
  // 会撞出同一个号 —— 而"同手机号 + 同门店 + 同类型 + 同内容"是 409 的判据，
  // 一旦撞号，正例会被判成"重复单"，红灯指向的地方与真因（脚本自己）无关。
  let mobileSeq = 0;
  const mobile = () => {
    mobileSeq += 1;
    return `13${String(Date.now() + mobileSeq * 977).slice(-9)}`;
  };

  const beforeCount = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
  const rejectedCounts = {};

  await checkAsync('③ 六类逐一提交：repair/complaint → 201；其余四类 → 422 INVALID_TICKET_TYPE', async () => {
    const results = [];
    for (const t of EXPECT_TYPES) {
      const body = {
        store_code: STORE,
        ticket_type: t.value,
        content: `${FIXTURE_TAG} 匿名面类型隔离走查：${t.value}`,
        customer_name: '类型隔离走查',
        customer_mobile: mobile(),
      };
      // eslint-disable-next-line no-await-in-loop
      const r = await http(`${BASE}/api/public/tickets${storeEntryQuery(STORE)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
        body: JSON.stringify(body),
        timeout: 15000,
      });
      const publicOk = EXPECT_PUBLIC_TYPES.includes(t.value);
      if (publicOk) {
        assert(
          r.status === 201 || r.status === 200,
          `${t.value} 是客户入口类型，却被拒了：HTTP ${r.status} ${String(r.body).slice(0, 160)}`,
        );
        const no = r.json?.data?.ticket_no;
        assert(no, `${t.value} 建单成功但没回单号：${String(r.body).slice(0, 160)}`);
        const id = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${no}'`));
        if (id) created.push(id);
        const dbType = psqlScalar(`SELECT ticket_type FROM service_tickets WHERE ticket_no = '${no}'`);
        assert(dbType === t.value, `${t.value} 落库的 ticket_type 是 ${j(dbType)}`);
        results.push(`${t.value}:${r.status}`);
      } else {
        assert(
          r.status === 422,
          `${t.value} 是内部类型，匿名面必须 422，实际 HTTP ${r.status} ${String(r.body).slice(0, 160)}`,
        );
        const code = r.json?.errors?.[0]?.code;
        assert(code === 'INVALID_TICKET_TYPE', `${t.value} 的 422 错误码是 ${j(code)}`);
        rejectedCounts[t.value] = r.status;
        results.push(`${t.value}:422`);
      }
    }
    return results.join(' ');
  });

  await checkAsync('③ 反向：被拒的四类**一条都没落库**（422 不是"先建后拒"）', async () => {
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    // 正向那两类会各落一条，所以期望增量恰好是 2（不是 0）
    const expectedDelta = EXPECT_PUBLIC_TYPES.length;
    assert(
      after - beforeCount === expectedDelta,
      `工单总数 ${beforeCount} → ${after}（增量 ${after - beforeCount}，期望 ${expectedDelta}）—— ` +
        '被拒的四类里有落库的',
    );
    const leaked = psqlRows(
      `SELECT DISTINCT ticket_type FROM service_tickets ` +
        `WHERE content LIKE '${FIXTURE_TAG} 匿名面类型隔离走查%'`,
    ).map((r) => r[0]);
    const bad = leaked.filter((v) => !EXPECT_PUBLIC_TYPES.includes(v));
    assert(bad.length === 0, `匿名面落库了内部类型：${bad.join(', ')}`);
    return `增量 ${after - beforeCount}（= 两个客户入口类型）；拒绝的 ${Object.keys(rejectedCounts).join('/')} 均未落库`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 4 存量向后兼容：旧值查得出来、含义没被改写（真库 + 真 HTTP） ────');
  // -------------------------------------------------------------------------
  const distinct = psqlRows('SELECT DISTINCT ticket_type FROM service_tickets').map((r) => r[0]);
  check('④ 存量取值全部落在新枚举内（没有任何一条旧单变成"枚举外的孤儿"）', () => {
    assert(distinct.length > 0, 'service_tickets 里一条数据都没有 —— 这条判据在空集上恒真，不算数');
    const internal = Object.values(typeMap);
    const orphans = distinct.filter((v) => !internal.includes(v));
    assert(orphans.length === 0, `存量里出现了枚举外的取值：${orphans.join(', ')}`);
    return `distinct=${distinct.join(', ')}，全部 ⊆ 六类`;
  });

  check('④ 存量计数：repair / complaint 仍按原码存着（没有被迁移改写）', () => {
    const counts = {};
    for (const row of psqlRows(
      'SELECT ticket_type, count(*) FROM service_tickets GROUP BY 1 ORDER BY 1',
    )) {
      counts[row[0]] = Number(row[1]);
    }
    assert(
      Number(counts.repair) > 0,
      `库里 repair 单为 ${counts.repair} —— 存量主类型不见了，迁移可能改写了历史`,
    );
    assert(
      Number(counts.complaint) > 0,
      `库里 complaint 单为 ${counts.complaint} —— 存量投诉单不见了`,
    );
    return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  });

  await checkAsync('④ 存量可查：后台 list 按 ticket_type 过滤，旧值查得出来且过滤真的生效', async () => {
    const email = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
    const password = envValue('SMOKE_ADMIN_PASSWORD');
    if (!password) {
      throw new EnvNotReady('.env 缺 SMOKE_ADMIN_PASSWORD —— 无法用真实会话验证"存量可查"');
    }
    const token = await signIn(email, password);
    if (!token) throw new EnvNotReady(`管理员账号 ${email} 登录失败（口令可能已轮换）`);
    const auth = { Authorization: `Bearer ${token}` };

    const listBy = async (type) => {
      const filter = encodeURIComponent(JSON.stringify({ ticket_type: type }));
      const r = await http(
        `${BASE}/api/serviceTickets:list?pageSize=5&filter=${filter}`,
        { headers: auth, timeout: 15000 },
      );
      return { status: r.status, rows: r.json?.data, body: r.body };
    };

    const details = [];
    for (const type of ['repair', 'complaint']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await listBy(type);
      assert(res.status === 200, `按 ${type} 过滤返回 HTTP ${res.status}：${String(res.body).slice(0, 160)}`);
      assert(Array.isArray(res.rows), `按 ${type} 过滤的 data 不是数组`);
      assert(res.rows.length > 0, `按 ${type} 过滤一行都没返回 —— 存量工单查不出来了`);
      const wrong = res.rows.filter((row) => row.ticket_type !== type);
      assert(
        wrong.length === 0,
        `按 ${type} 过滤却返回了 ${wrong.map((r) => r.ticket_type).join(',')} —— 过滤没生效`,
      );
      details.push(`${type}→${res.rows.length}行`);
    }

    // ---- 反向控制：用一个**枚举外**的值过滤，必须查不到任何东西 ----
    // 没有这一条，"过滤参数被整个忽略、永远返回前 5 行"也能让上面两行全绿。
    const bogus = await listBy('fridge');
    assert(bogus.status === 200, `用枚举外的值过滤返回 HTTP ${bogus.status}`);
    assert(
      Array.isArray(bogus.rows) && bogus.rows.length === 0,
      `用枚举外的值过滤返回了 ${bogus.rows?.length} 行 —— 过滤条件被忽略了（上面两条是假绿）`,
    );

    return `${details.join(' / ')}；反向（ticket_type=fridge）→0 行`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 5 六类不强制走师傅上门（服务层契约 + 真库夹具形态） ──────────────');
  // -------------------------------------------------------------------------
  const serviceText = read(TICKET_SERVICE_TS);
  const createBody = methodBody(serviceText, 'async create(input: CreateTicketInput)');

  check('⑤ 服务层契约：create() 用 TICKET_TYPE_VALUES（六类）做枚举校验', () => {
    assert(
      /this\.assertEnum\(input\.ticketType,\s*TICKET_TYPE_VALUES,\s*'ticket_type'\)/.test(createBody),
      'create() 没有用 TICKET_TYPE_VALUES 校验 ticketType —— 内部建单可能只认两类',
    );
    return 'assertEnum(input.ticketType, TICKET_TYPE_VALUES, ticket_type)';
  });

  check('⑤ create() 里**没有任何按类型分叉**（新增一处就会红，逼人来这里申报）', () => {
    const bad = disallowedTicketTypeLines(createBody);
    assert(
      bad.length === 0,
      `create() 里出现了未申报的 ticketType 用法：\n       ${bad.map((l) => l.trim()).join('\n       ')}`,
    );
    const all = createBody.split('\n').filter((l) => /\bticketType\b/.test(l)).length;
    return `方法内 ${all} 处 ticketType 全部落在允许清单内（枚举校验 / 落库字段 / 摘要标签）`;
  });

  check('⑤ 变异测试：把 TICKET_TYPE_VALUES 换成 PUBLIC_TICKET_TYPE_VALUES → 必须红', () => {
    const mutated = createBody.replace('TICKET_TYPE_VALUES', 'PUBLIC_TICKET_TYPE_VALUES');
    assert(mutated !== createBody, '变异没生效（方法体里找不到 TICKET_TYPE_VALUES）—— 这条自测本身在空转');
    const bad = disallowedTicketTypeLines(mutated);
    assert(
      bad.length > 0,
      '把服务层枚举校验降级成匿名两类之后，判据**没有**变红 —— 等于没有这条判据',
    );
    return `变异被抓住（${bad.length} 行越界）`;
  });

  check('⑤ 变异测试：插入一处 `if (ticketType === ...)` 分叉 → 必须红', () => {
    const mutated = createBody.replace(
      'const ticketType = this.assertEnum',
      "if (ticketType === 'installation') { return null; }\n    const ticketType = this.assertEnum",
    );
    assert(mutated !== createBody, '变异没生效 —— 这条自测本身在空转');
    const bad = disallowedTicketTypeLines(mutated);
    assert(bad.length > 0, '按类型分叉之后判据**没有**变红 —— 等于没有这条判据');
    return `变异被抓住（${bad.length} 行越界）`;
  });

  // ---- 真库夹具：六类在建单后的形态必须**完全一致** ----
  const storeId = Number(psqlScalar(`SELECT id FROM stores WHERE code='${STORE}'`));
  assert(storeId, `门店 ${STORE} 不存在，夹具无处挂`);

  check('⑤ 真库夹具：六类各建一条，状态/派工形态六类完全一致（没有任何一类被自动派工）', () => {
    const stamp = String(Date.now()).slice(-7);
    const shapes = [];
    for (const [i, t] of EXPECT_TYPES.entries()) {
      const no = `TYP${stamp}${i}`;
      const r = psqlExec(
        'INSERT INTO service_tickets ' +
          '(created_at, updated_at, ticket_no, store_id, source_store_code, source, ticket_type, ' +
          ' content, customer_mobile, customer_name, status) ' +
          `VALUES (now(), now(), '${no}', ${storeId}, '${STORE}', 'qr', '${t.value}', ` +
          ` '${FIXTURE_TAG} 六类形态夹具：${t.value}', '13800000000', '类型夹具', 'NEW')`,
      );
      if (!r.ok) throw new Error(`夹具插入失败（${t.value}）：${r.out}`);
      const row = psqlRows(
        `SELECT id, status, coalesce(service_mode,'<NULL>'), urgent::text, ` +
          ` (SELECT count(*) FROM service_visits v WHERE v.ticket_id = t.id), ` +
          ` (SELECT count(*) FROM ticket_events e WHERE e.ticket_id = t.id) ` +
          `FROM service_tickets t WHERE ticket_no = '${no}'`,
      )[0];
      assert(row, `夹具 ${no} 插进去却查不到`);
      fixtures.push(Number(row[0]));
      shapes.push({
        type: t.value,
        status: row[1],
        serviceMode: row[2],
        urgent: row[3],
        visits: Number(row[4]),
        events: Number(row[5]),
      });
    }

    // 六类形态必须逐字段一致 —— 用第一个当基准，任何一个不同都要报出来
    const base = shapes[0];
    const diffs = shapes.filter(
      (s) => s.status !== base.status || s.serviceMode !== base.serviceMode || s.urgent !== base.urgent || s.visits !== base.visits,
    );
    assert(
      diffs.length === 0,
      `六类形态不一致：基准 ${j(base)}，异常 ${j(diffs)} —— 有一类被特殊对待了`,
    );
    assert(base.status === 'NEW', `夹具状态是 ${base.status}，期望 NEW（建单不得自动进入受理/派工）`);
    assert(base.serviceMode === '<NULL>', `service_mode 是 ${base.serviceMode}，期望 NULL（不得自动指定上门形态）`);
    assert(base.urgent === 'false', `urgent 是 ${base.urgent}，期望 false`);
    assert(base.visits === 0, `已产生 ${base.visits} 条上门记录 —— 建单就派工了`);
    return `六类全部 status=NEW · service_mode=NULL · urgent=false · visits=0（${shapes.map((s) => s.type).join('/')}）`;
  });

  await checkAsync('⑤ 真 HTTP：六类夹具都能被后台 list 按类型查回来（含四个内部类型）', async () => {
    if (fixtures.length !== EXPECT_TYPES.length) {
      throw new Error(`夹具只有 ${fixtures.length} 条 —— 上一条判据失败导致本段无法取证`);
    }
    const email = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
    const password = envValue('SMOKE_ADMIN_PASSWORD');
    if (!password) throw new EnvNotReady('.env 缺 SMOKE_ADMIN_PASSWORD');
    const token = await signIn(email, password);
    if (!token) throw new EnvNotReady(`管理员账号 ${email} 登录失败`);

    const hits = [];
    for (const t of EXPECT_TYPES) {
      const filter = encodeURIComponent(
        JSON.stringify({ id: { $in: fixtures }, ticket_type: t.value }),
      );
      // eslint-disable-next-line no-await-in-loop
      const r = await http(`${BASE}/api/serviceTickets:list?pageSize=10&filter=${filter}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      });
      assert(r.status === 200, `按 ${t.value} 查夹具返回 HTTP ${r.status}`);
      const rows = r.json?.data ?? [];
      assert(
        rows.length === 1 && rows[0].ticket_type === t.value,
        `按 ${t.value} 查夹具，命中 ${rows.length} 行（${rows.map((x) => x.ticket_type).join(',') || '空'}）`,
      );
      hits.push(t.value);
    }
    return `${hits.length} 类逐一命中（含 installation/maintenance/relocation/other）`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 6 冻结边界：六个工单状态一个字都没动 ───────────────────────────');
  // -------------------------------------------------------------------------
  const statusMap = parseConstObject(constantsText, 'TICKET_STATUS');
  const transitions = parseTransitions(constantsText);

  check('⑥ 常量层：TICKET_STATUS 逐字等于冻结的六个状态（含顺序）', () => {
    assert(
      j(Object.values(statusMap)) === j(EXPECT_FROZEN_STATUS),
      `TICKET_STATUS = ${j(Object.values(statusMap))}，期望 ${j(EXPECT_FROZEN_STATUS)}`,
    );
    return EXPECT_FROZEN_STATUS.join(' / ');
  });

  check('⑥ 常量层：状态中文名逐字未变（NEW 仍是「待处理」）', () => {
    const labelsText = /export const TICKET_STATUS_LABEL[\s\S]*?\n\};/.exec(constantsText);
    assert(labelsText, '解析不到 TICKET_STATUS_LABEL');
    const labels = {};
    const re = /^\s*([A-Z_]+):\s*'([^']*)',\s*$/gm;
    let hit;
    while ((hit = re.exec(labelsText[0]))) labels[hit[1]] = hit[2];
    assert(
      j(labels) === j(EXPECT_FROZEN_STATUS_LABEL),
      `TICKET_STATUS_LABEL = ${j(labels)}，期望 ${j(EXPECT_FROZEN_STATUS_LABEL)}`,
    );
    return Object.values(labels).join(' / ');
  });

  check('⑥ 常量层：ALLOWED_TRANSITIONS 逐字等于冻结的 M1–M15 表', () => {
    assert(
      j(transitions) === j(EXPECT_FROZEN_TRANSITIONS),
      `ALLOWED_TRANSITIONS = ${j(transitions)}，期望 ${j(EXPECT_FROZEN_TRANSITIONS)}`,
    );
    return `${Object.keys(transitions).length} 个状态的出边全部一致`;
  });

  check('⑥ fields 元数据层：status 的 uiSchema.enum 仍是冻结六项（值 + 新文案）', () => {
    const text = psqlScalar(
      `SELECT options #>> '{uiSchema,enum}' FROM fields ` +
        `WHERE "collectionName"='serviceTickets' AND name='status'`,
    );
    assert(text, 'fields 里查不到 serviceTickets.status 的 uiSchema.enum');
    const parsed = JSON.parse(text);
    const expect = EXPECT_FROZEN_STATUS.map((v) => ({
      label: EXPECT_FROZEN_STATUS_LABEL[v],
      value: v,
    }));
    assert(j(parsed) === j(expect), `status 的 enum = ${j(parsed)}，期望 ${j(expect)}`);
    return parsed.map((o) => o.value).join('/');
  });

  check('⑥ 反向：工单**类型**六类与工单**状态**六项**没有交集**（别把两者搞成一个东西）', () => {
    const overlap = Object.values(typeMap).filter((v) => EXPECT_FROZEN_STATUS.includes(v));
    assert(overlap.length === 0, `类型与状态出现了同名值：${overlap.join(',')}`);
    return `类型 ${Object.values(typeMap).length} 类 / 状态 ${EXPECT_FROZEN_STATUS.length} 项，交集为空`;
  });

  summary();

  // 夹具与自建工单的 id 已经在造出来的**当场**登记进模块级 registry（见文件头），
  // 这里不需要再返回什么 —— `runMain` 的 `finally` 会调 `cleanup()`。
}

// ===========================================================================
// 清理：**无论断言成败都要清**
// ===========================================================================
function cleanup() {
  const ids = [...registry.created, ...registry.fixtures].filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  if (ids.length === 0) {
    console.log('  · 无需清理');
    return;
  }
  // 夹具是 SQL 直插的，没有照片/幂等行；但真 HTTP 建的那两条可能有事件行。
  // 统一按 ticket_id 清事件 + 上门 + 工单，顺序：先子表，后主表。
  for (const id of ids) {
    psqlExec(`DELETE FROM ticket_events WHERE ticket_id = ${id}`);
    psqlExec(`DELETE FROM service_visits WHERE ticket_id = ${id}`);
    psqlExec(`DELETE FROM service_tickets WHERE id = ${id}`);
  }
  const left = Number(
    psqlScalar(`SELECT count(*) FROM service_tickets WHERE id IN (${ids.join(',')})`),
  );
  console.log(
    left === 0
      ? `  · 已清理本轮自建工单 ${ids.length} 张（回查残留 0）`
      : `  ⚠️ 清理后仍有 ${left} 张残留（id=${ids.join(',')}）`,
  );
}

await runMain({
  name: '工单类型六类扩展 · 兼容性 / 隔离 / 冻结边界',
  main,
  cleanup,
});
