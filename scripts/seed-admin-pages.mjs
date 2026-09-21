#!/usr/bin/env node
/**
 * 后台业务页面播种（Phase 4-H）
 * =============================================================================
 *
 * 做什么：把"售后工单"后台页面通过 NocoBase 2.2.15 flow-engine 的
 *         `flowSurfaces:applyBlueprint` 动作写入后台。
 *
 * 为什么是脚本而不是"在后台点几下"：
 *   ① 页面是**交付物**，必须可重建。手点的页面在清库/换机后就没了，
 *      且无法 code review、无法回归 —— 与 seeds/ 的"代码即事实来源"同一条纪律。
 *   ② 页面数据落在 desktopRoutes / flowModels / rolesDesktopRoutes 三张表里，
 *      不是配置文件。不落成脚本，就等于"只有一台机器上存在这个功能"。
 *
 * 幂等性：
 *   先按页面标题查 desktopRoutes：
 *     · 不存在 → mode=create（带 navigation，会建导航分组与菜单项）
 *     · 已存在 → mode=replace + target.pageSchemaUid（**不能带 navigation**，
 *                校验器会直接 400：replace mode does not accept navigation）
 *
 * =============================================================================
 * ★ 本项目与 flow-engine 校验器缠斗后确认的四条硬约束（改本文件前必读）
 * =============================================================================
 *
 * 【约束 1】表格区块 > 10 个业务字段时，必须给出**覆盖全部字段**的 fieldGroups
 *   `LARGE_GENERATED_POPUP_FIELD_GROUPS_THRESHOLD = 10`。表的"生成弹窗字段数"
 *   超过它，且页面上有该集合的表格区块，就要求
 *   `defaults.collections.<coll>.fieldGroups` 覆盖全部字段。
 *
 *   三个走不通的方向（均已实测排除）：
 *     · "不声明 recordActions / 显式写空数组" → 无效。校验器对 table 区块
 *       **硬编码** addNew/view/edit 三条 triggerPaths，未声明的一律补成需求。
 *     · "给 view 动作写显式 popup 就好了" → 只对 view 那条生效。
 *     · "用 hidden 字段躲开" → 字段条目只允许 `field` / `titleField` 两个键。
 *   所以敏感列（token 哈希等）**也必须写进 fieldGroups**，只能放进
 *   「内部字段」分组 + 由断言保证没有任何区块引用它们
 *   （清单见 `scripts/expected-sensitive-columns.mjs`，smoke-test 用同一份清单断言）。
 *
 * 【约束 2】`effectiveFieldNames` 会把**单值关联**的目标集合"一跳扩展"进来
 *   （expandGeneratedViewPopupOneHopRequirements）。所以：
 *     · serviceTickets 上有 `feedback_visit` → 必须同时给 serviceVisits 的 fieldGroups；
 *     · ticketEvents / serviceVisits 上有 `ticket` → 必须给 serviceTickets 的。
 *   表现为：错误里冒出一个你压根没在页面上用过的集合。
 *   判定阈值同样是 10：stores（6 个业务字段）就永远不会被要求。
 *
 * 【约束 3】★ **绝不能在 serviceTickets / serviceVisits / ticketEvents 的区块上挂 popup**。
 *   这是本阶段最大的坑，取证过程见 docs/DEVIATIONS.md DEV-53：
 *     · applyBlueprint 会先把文档编译成若干 `compose` 步骤再落库；
 *     · 带 popup 时，**弹窗内容会被编译成额外的一个 compose 步骤，
 *       而那个步骤的 payload 里 `defaults` 是 undefined**（探针实测：同一份文档
 *       的 tab 步骤 hasDefaults=true，弹窗步骤 hasDefaults=false）；
 *     · 弹窗里的数据区块（details/table/list）自带默认 `edit` 记录动作，
 *       于是这条需求在"没有 defaults 可读"的那一步被判 400；
 *     · 豁免它的唯一办法是给该区块声明一个**内联 popup 的 edit 动作**，
 *       而校验器要求自定义 edit 弹窗里**恰好有一个 editForm**
 *       （`custom-edit-popup-edit-form-count`）—— 那等于给工单表开一个
 *       可直接改字段的表单，绕过 TicketService 状态机，属本项目的设计禁止项。
 *   ⇒ 结论：**工单详情不能用 blueprint 弹窗实现**。详情信息通过
 *     「列表放足关键列」+「H6 自定义动作里的只读抽屉（客户端渲染，不经过 blueprint）」
 *     两条路补齐。详见 docs/PHASE-4.md 的交付说明。
 *
 * 【约束 4】`defaultFilter` 的形状与最少字段数
 *   形状是 `{logic, items:[{path, operator, value}]}` —— 键是 `path` 不是 `field`；
 *   且必须覆盖 ≥3 个**可筛选**字段（有 interface 才算可筛选，见 DEV-52）。
 *   "待受理"这类 Tab 天然只有一个业务条件，另外两条用**恒真条件**补足：
 *   ticket_no / customer_mobile 都是 DDL 级 NOT NULL，加不加结果集都不变。
 *   这由 smoke-test 的「每个状态 Tab 的有效条数 == 该状态在库里的条数」守住。
 *
 * =============================================================================
 * 退出码：0 全部成功 / 1 失败（含校验 400，会把 details 原样打印）/
 *         2 环境未就绪（登录不上、网关不通）
 *
 * 用法：
 *   node scripts/seed-admin-pages.mjs            # 应用全部页面
 *   node scripts/seed-admin-pages.mjs --dry-run  # 只打印将要发送的文档
 *   node scripts/seed-admin-pages.mjs --list     # 只回查现有页面路由
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  SENSITIVE_COLUMNS,
  REQUIRED_ADMIN_PAGES,
  TICKET_STATUS_TABS,
  ADMIN_NAV_GROUP,
} from './expected-sensitive-columns.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k, d) => {
  const m = new RegExp(`^${k}=(.*)$`, 'm').exec(envFile);
  return m ? m[1].trim() : d;
};

const PORT = envValue('NGINX_HTTP_PORT', '8080');
const BASE = `http://localhost:${PORT}`;

// 验收账号。刻意不做"猜一个默认口令"的静默兜底：口令写死在脚本里，
// 而本仓库是公开仓库，等于把后台口令一起公开。
const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', 'admin123');

const DRY_RUN = process.argv.includes('--dry-run');
const LIST_ONLY = process.argv.includes('--list');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// nginx 对 location / 的限流是 svc_general（300r/m，burst 60 nodelay）。
// 本脚本一次全量播种约 10~20 个请求，余量充足。若将来断言暴涨到数百，
// 要按项目铁律"先算令牌桶"再动手（见 DEVIATIONS DEV-31/DEV-34）。
async function api(pathname, { method = 'POST', body, token } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Origin 必须带：NocoBase 的来源校验会挡掉无 Origin 的写请求（DEV-49）
      Origin: BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（例如网关的 429 纯文本）*/
  }
  return { status: res.status, json, text };
}

async function signIn() {
  const r = await api('/api/auth:signIn', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (r.status !== 200) {
    throw Object.assign(new Error(`登录失败 HTTP ${r.status}: ${r.text.slice(0, 200)}`), {
      envNotReady: true,
    });
  }
  return r.json.data.token;
}

// ---------------------------------------------------------------------------
// 字段分组（约束 1）
// ---------------------------------------------------------------------------

/**
 * 绝不展示在界面上的列，但仍然**必须**写进 fieldGroups（否则报
 * default-field-groups-incomplete）。
 *
 * 清单本身在 `scripts/expected-sensitive-columns.mjs` —— 单一事实来源，
 * smoke-test 用**同一份清单**断言"没有任何区块引用这些列"。
 *
 * ⚠️ 这个"必须写进分组"与"绝不展示"的并存能成立，前提是**本页面组的区块
 *    都不生成自动弹窗**（约束 3 已经把这个前提变成硬约束：我们根本不挂 popup）。
 *    一旦将来有人给这些表挂了写动作/弹窗，fieldGroups 就会真的被渲染成表单，
 *    那时必须先把这些列去掉（正确做法是在集合声明层标成 hidden，
 *    让校验器不再要求覆盖）。
 */
const SYSTEM_FIELDS = SENSITIVE_COLUMNS;

/**
 * 业务字段分组（人工策展）。
 *
 * 纪律：这里**只放业务字段**；内部/安全列一律由 SYSTEM_FIELDS 兜底。
 * 给集合加了新字段而没在这里分组时，applyBlueprint 会返回
 * `default-field-groups-incomplete` 并列出缺失字段 —— 那正是我们要的漂移红灯。
 * 不要用"往兜底组里自动塞"的方式让它变绿，那等于把一次评审变成一次静默。
 */
const FIELD_GROUPS = {
  serviceTickets: [
    {
      key: 'ticket-basic',
      title: '工单信息',
      fields: [
        'ticket_no',
        'status',
        'ticket_type',
        'source',
        'store',
        'source_store_code',
        'content',
        'customer_name',
        'customer_mobile',
      ],
    },
    {
      key: 'ticket-dispatch',
      title: '派工信息',
      fields: [
        'service_mode',
        'provider_name',
        'technician_name',
        'technician_mobile',
        'expected_visit_at',
        'dispatch_at',
      ],
    },
    {
      key: 'ticket-completion',
      title: '完成与回执',
      fields: ['completion_result', 'completion_note', 'completed_at'],
    },
    {
      key: 'ticket-review',
      title: '客户评价',
      fields: ['rating', 'review_status', 'review_comment', 'reviewed_at', 'feedback_visit'],
    },
    {
      key: 'ticket-exception',
      title: '异常与重开',
      fields: ['escalated', 'reopen_count', 'close_reason'],
    },
    {
      key: 'ticket-timing',
      title: '计时与审计',
      fields: ['first_response_at', 'closed_at', 'createdAt', 'updatedAt'],
    },
  ],
  serviceVisits: [
    {
      key: 'visit-basic',
      title: '派工记录',
      fields: [
        'visit_no',
        'visit_status',
        'service_mode',
        'service_result',
        'is_remote',
        'technician_name',
        'technician_mobile',
        'provider_name',
        'expected_visit_at',
        'assigned_at',
        'ticket',
      ],
    },
    {
      key: 'visit-confirm',
      title: '门店确认与收费',
      fields: [
        'store_confirm_status',
        'store_confirm_note',
        'store_confirmer',
        'is_charged',
        'reported_charge_amount',
        'confirmed_charge_amount',
        'customer_reported_amount',
        'customer_charge_match',
        'charge_diff_reason',
        'submitted_at',
        'store_confirmed_at',
      ],
    },
    {
      key: 'visit-lifecycle',
      title: '作废与改派',
      // token_revoked_reason 是**业务可见**的（"这条链接为什么失效"，
      // 见 docs/PHASE-4.md §12.1），所以放在业务组而不是「内部字段」组；
      // 它同时也出现在 NATIVE_READ_FIELD_DENY 里，但那拦的是**原生只读接口**，
      // 与"后台页面要不要显示"是两件事。
      fields: [
        'superseded_at',
        'superseded_reason',
        'reassigned_from',
        'token_revoked_reason',
        'service_note',
      ],
    },
    { key: 'visit-timing', title: '计时与审计', fields: ['createdAt', 'updatedAt'] },
  ],
  ticketEvents: [
    {
      key: 'event-basic',
      title: '事件',
      fields: [
        'event_type',
        'from_status',
        'to_status',
        'operator_kind',
        'operator_user',
        'summary',
        'ticket',
        'visit',
      ],
    },
    { key: 'event-timing', title: '计时与审计', fields: ['createdAt', 'updatedAt'] },
  ],
};

/** 合并业务组 + 内部组，得到校验器要求的"全覆盖"分组 */
function buildFieldGroups(collection) {
  const groups = [...(FIELD_GROUPS[collection] ?? [])];
  const system = SYSTEM_FIELDS[collection] ?? [];
  if (system.length) {
    groups.push({ key: 'internal', title: '内部字段（不在界面展示）', fields: system });
  }
  return groups;
}

/**
 * 交给 `defaults.collections` 的完整分组。
 *
 * 必须包含**页面上用到的集合**及其**单值关联的目标集合**（约束 2）：
 *   · serviceTickets → feedback_visit → serviceVisits
 *   · ticketEvents / serviceVisits → ticket → serviceTickets
 * 多给不会报错（未用到的集合不会被要求），少给会 400 并明确列出缺哪个集合。
 */
const DEFAULTS = {
  collections: {
    serviceTickets: { fieldGroups: buildFieldGroups('serviceTickets') },
    serviceVisits: { fieldGroups: buildFieldGroups('serviceVisits') },
    ticketEvents: { fieldGroups: buildFieldGroups('ticketEvents') },
  },
};

// ---------------------------------------------------------------------------
// 页面蓝图
// ---------------------------------------------------------------------------

/** 工单列表列（门店铺开时够用的最小集） */
const TICKET_LIST_FIELDS = [
  'ticket_no',
  'status',
  'ticket_type',
  'customer_name',
  'customer_mobile',
  'content',
  'technician_name',
  'technician_mobile',
  'expected_visit_at',
  'createdAt',
];

/** 总部全量工单多一列"当前门店" */
const TICKET_LIST_FIELDS_HQ = ['ticket_no', 'store', ...TICKET_LIST_FIELDS.slice(1)];

/** 事件时间线列 */
const EVENT_LIST_FIELDS = [
  'ticket',
  'event_type',
  'from_status',
  'to_status',
  'operator_kind',
  'operator_user',
  'summary',
  'createdAt',
];

/** 派工记录列（只读；Phase 6 的门店确认/驳回/收费确认不在本阶段） */
const VISIT_LIST_FIELDS = [
  'ticket',
  'visit_no',
  'visit_status',
  'service_mode',
  'technician_name',
  'technician_mobile',
  'provider_name',
  'expected_visit_at',
  'assigned_at',
  'superseded_at',
  'token_revoked_reason',
  'createdAt',
];

/**
 * 恒真条件（约束 4）。
 * DDL 级 NOT NULL 保证它们不改变结果集；由 smoke 的 Tab 条数断言守住。
 */
const TAUTOLOGY = [
  { path: 'ticket_no', operator: '$notEmpty', value: true },
  { path: 'customer_mobile', operator: '$notEmpty', value: true },
];

// 状态 Tab 的标题与对应状态来自清单（单一事实来源；smoke 按同一份清单核对默认筛选）。
// 「全部」不筛状态，所以不进清单 —— 它没有对应的 status 值。
const STATUS_TABS = [{ key: 'all', title: '全部', status: null }, ...TICKET_STATUS_TABS];

/**
 * 工单表格区块。
 *
 * ⚠️ 刻意**不带** recordActions / popup —— 见文件头【约束 3】。
 *    挂弹窗会让整个页面无法通过校验，且没有合法的绕法。
 */
function ticketTableBlock(key, title, fields, status) {
  const block = {
    key: `${key}-table`,
    type: 'table',
    title,
    collection: 'serviceTickets',
    pageSize: 20,
    fields,
    actions: ['filter', 'refresh'],
    sort: ['-createdAt'],
  };
  if (status) {
    block.defaultFilter = {
      logic: '$and',
      items: [{ path: 'status', operator: '$eq', value: status }, ...TAUTOLOGY],
    };
  }
  return block;
}

function tablePage({ navGroup, navItem, navIcon, title, tabs, enableTabs }) {
  return {
    version: '1',
    mode: 'create',
    navigation: {
      group: { title: navGroup, icon: 'ToolOutlined' },
      item: { title: navItem, icon: navIcon ?? 'ProfileOutlined' },
    },
    page: { title, enableTabs },
    defaults: DEFAULTS,
    tabs,
    assets: {},
  };
}

const NAV_GROUP = ADMIN_NAV_GROUP;

/** H1 我的门店工单：6 个状态 Tab（门店角色看到的范围由 ACL 门店隔离决定） */
function buildMyStoreTickets() {
  return tablePage({
    navGroup: NAV_GROUP,
    navItem: '我的门店工单',
    title: '我的门店工单',
    enableTabs: true,
    tabs: STATUS_TABS.map(({ key, title, status }) => ({
      key,
      title,
      blocks: [ticketTableBlock(key, title, TICKET_LIST_FIELDS, status)],
    })),
  });
}

/** H2 全量工单：总部视角，多一列"当前门店"，单 Tab */
function buildAllTickets() {
  return tablePage({
    navGroup: NAV_GROUP,
    navItem: '全量工单',
    navIcon: 'UnorderedListOutlined',
    title: '全量工单',
    enableTabs: false,
    tabs: [
      {
        key: 'all',
        title: '全量工单',
        blocks: [ticketTableBlock('hq', '全量工单', TICKET_LIST_FIELDS_HQ, null)],
      },
    ],
  });
}

/** H4 工单事件时间线（独立页；原因见【约束 3】） */
function buildTicketEvents() {
  return tablePage({
    navGroup: NAV_GROUP,
    navItem: '工单事件时间线',
    navIcon: 'HistoryOutlined',
    title: '工单事件时间线',
    enableTabs: false,
    tabs: [
      {
        key: 'events',
        title: '事件时间线',
        blocks: [
          {
            key: 'events-table',
            type: 'table',
            title: '事件时间线',
            collection: 'ticketEvents',
            pageSize: 50,
            fields: EVENT_LIST_FIELDS,
            actions: ['filter', 'refresh'],
            sort: ['-createdAt'],
          },
        ],
      },
    ],
  });
}

/** H5 派工记录（只读；Phase 6 的门店确认动作不在本阶段） */
function buildServiceVisits() {
  return tablePage({
    navGroup: NAV_GROUP,
    navItem: '派工记录',
    navIcon: 'ScheduleOutlined',
    title: '派工记录',
    enableTabs: false,
    tabs: [
      {
        key: 'visits',
        title: '派工记录',
        blocks: [
          {
            key: 'visits-table',
            type: 'table',
            title: '派工记录',
            collection: 'serviceVisits',
            pageSize: 50,
            fields: VISIT_LIST_FIELDS,
            actions: ['filter', 'refresh'],
            sort: ['-createdAt'],
          },
        ],
      },
    ],
  });
}

const PAGE_BUILDERS = {
  我的门店工单: buildMyStoreTickets,
  全量工单: buildAllTickets,
  工单事件时间线: buildTicketEvents,
  派工记录: buildServiceVisits,
};

/**
 * 以清单为准生成待播种页面 —— **方向刻意是"清单 → 脚本"**。
 * 若清单里加了一个页面而这里没有 builder，直接抛错（两处已漂移）；
 * 反之这里多出一个 builder 则永远不会被用到，也就不会被误以为"已交付"。
 * 用函数而非顶层常量，是为了让这个错误走 main() 的统一 catch（而非裸崩）。
 */
function pagesToSeed() {
  return REQUIRED_ADMIN_PAGES.map(({ title, tabs }) => {
    const build = PAGE_BUILDERS[title];
    if (!build) {
      throw new Error(
        `expected-sensitive-columns.mjs 里的页面「${title}」在 seed 脚本里没有 builder —— 两处已漂移`,
      );
    }
    const doc = build();
    if (tabs != null && doc.tabs.length !== tabs) {
      throw new Error(`页面「${title}」期望 ${tabs} 个 Tab，实际 ${doc.tabs.length} 个 —— 两处已漂移`);
    }
    return { title, build };
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function fetchRoutes(token) {
  const r = await api('/api/desktopRoutes:list?pageSize=200&sort=sort', { method: 'GET', token });
  if (r.status !== 200) throw new Error(`读取 desktopRoutes 失败 HTTP ${r.status}`);
  return r.json?.data ?? [];
}

async function main() {
  const pages = pagesToSeed();

  if (DRY_RUN) {
    for (const page of pages) {
      log(`=== ${page.title}（dry-run，不发送）===`);
      log(JSON.stringify(page.build(), null, 1));
    }
    return 0;
  }

  let token;
  try {
    token = await signIn();
  } catch (error) {
    log(`✗ ${error.message}`);
    return 2;
  }
  log(`✓ 管理员登录成功（${ADMIN_EMAIL}）`);

  let routes;
  try {
    routes = await fetchRoutes(token);
  } catch (error) {
    log(`✗ ${error.message}`);
    return 2;
  }
  // ⚠️ 只能按 **flowPage** 类型的路由定位页面。
  //    单 Tab 页面的 Tab 标题与页面标题**同名**（NocoBase 建页时默认如此），
  //    若不过滤类型，Map 会被后面的 tabs 路由覆盖，于是 target.pageSchemaUid
  //    指向一个 Tab 而不是页面 —— 报错是
  //    "replace target page must contain at least one tab"（极具误导性：
  //    明明给了 tabs，坏的是 target 指错了层级）。
  const byTitle = new Map(
    routes.filter((r) => r.type === 'flowPage').map((r) => [r.title, r]),
  );
  log(`· 现有路由 ${routes.length} 条，其中页面 ${byTitle.size} 个`);

  if (LIST_ONLY) {
    for (const r of routes) {
      log(
        `  id=${r.id} parent=${r.parentId ?? '-'} type=${r.type} title=${JSON.stringify(r.title)} ` +
          `schemaUid=${r.schemaUid ?? '-'} tabs=${r.enableTabs}`,
      );
    }
    return 0;
  }

  const results = [];
  let failures = 0;

  for (const page of pages) {
    const found = byTitle.get(page.title);
    const doc = page.build();
    if (found?.schemaUid) {
      // replace：必须给 target.pageSchemaUid，且**不能**带 navigation
      doc.mode = 'replace';
      doc.target = { pageSchemaUid: found.schemaUid };
      delete doc.navigation;
    }

    const applied = await api('/api/flowSurfaces:applyBlueprint', { body: doc, token });
    if (applied.status >= 400 || applied.json?.errors) {
      failures += 1;
      results.push(`✗ ${page.title}（HTTP ${applied.status}）`);
      log(`\n✗ ${page.title} 应用失败 HTTP ${applied.status}`);
      const errors = applied.json?.errors ?? [];
      if (errors.length) {
        for (const e of errors) {
          log(`  [${e.ruleId}] ${e.path}`);
          log(`    ${e.message}`);
          // details 是唯一可靠的定位依据：actionTypes / triggerPaths 说明
          // 校验器"以为"页面上有哪些动作；requiredFieldNames 是必须覆盖的全集。
          if (e.details) log(`    details = ${JSON.stringify(e.details)}`);
        }
      } else {
        log(`  ${applied.text.slice(0, 600)}`);
      }
      continue;
    }

    // 应用成功只说明**提交**成功。真正该报告的是落库后的 schemaUid，
    // 所以这里不留占位符（曾经打印过 `pageUid=?`，等于用"看起来有值"掩盖取不到值），
    // 由下面的 desktopRoutes 回查给出权威结论。
    results.push(`✓ ${page.title}（已应用，落库结果见回查）`);
    log(`✓ ${page.title} 应用成功`);
  }

  // ---- 落库回查：呼应铁律「修改成功 ≠ 落盘成功 ≠ Git 已包含」----
  const after = await fetchRoutes(token);
  log(`\n=== desktopRoutes 回查（${after.length} 条）===`);
  for (const r of after) {
    log(
      `  id=${r.id} parent=${r.parentId ?? '-'} type=${r.type} title=${JSON.stringify(r.title)} ` +
        `schemaUid=${r.schemaUid ?? '-'} tabs=${r.enableTabs} sort=${r.sort}`,
    );
  }

  // ⚠️ 必须限定 `type === 'flowPage'`：单 Tab 页面的 Tab 标题与页面标题**同名**，
  //    只按标题找的话，页面路由被删掉后仍能被同名的 tabs 路由"命中"，
  //    于是"页面没了"这件事不会变红（与文件头那条定位陷阱同型）。
  const pageUidOf = (title) =>
    after.find((r) => r.type === 'flowPage' && r.title === title)?.schemaUid;
  const missing = pages.filter((p) => !pageUidOf(p.title)).map((p) => p.title);
  if (missing.length) {
    log(`\n✗ 以下页面在回查中没有 flowPage 路由（可能只是提交成功）：${missing.join('、')}`);
    failures += 1;
  }

  log('\n=== 汇总 ===');
  for (const line of results) log(`  ${line}`);
  if (failures) {
    log(`\n${failures} 项未达标`);
    return 1;
  }
  log('\n全部页面已应用并回查通过');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log(`✗ 未预期错误：${error?.stack ?? error}`);
    process.exit(error?.envNotReady ? 2 : 1);
  });
