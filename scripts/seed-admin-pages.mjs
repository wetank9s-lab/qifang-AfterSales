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
  MANAGED_MENU_ROLES,
  visiblePagesOf,
} from './expected-sensitive-columns.mjs';

import {
  TICKET_ACTION_MODELS,
  TICKET_ACTION_USES,
  actionRow,
} from './ticket-page-actions.mjs';

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
// ⚠️ 刻意**没有**默认口令 fallback：本仓库是公开仓库，写死 fallback 等于公开后台口令。
//    取不到就拦在"环境未就绪"（exit 2），而不是拿一个猜的密码去撞 ——
//    撞失败会被误读成"权限/ACL 出问题"，把一次配置缺失伪装成一次产品缺陷。
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', '');

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
  if (!ADMIN_PASSWORD) {
    throw Object.assign(
      new Error(
        'SMOKE_ADMIN_PASSWORD 未配置 —— 无法登录管理员。' +
          '请在 .env 里设置（本仓库为公开仓库，**不要**把口令写进任何被提交的文件）',
      ),
      { envNotReady: true },
    );
  }
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

/**
 * 工单搜索框（Phase 4-I 走查要求补的显眼搜索入口）。
 *
 * 为什么需要它：原来的 `actions: ['filter']` 只渲染成一个**图标按钮**，
 * 走查人（门店售后 UAT-A）在 234 张工单里找不到目标单，反馈"没有搜索功能"。
 * 所以这里用 `filterForm` 区块做一个**常驻可见**的输入框。
 *
 * 三条实测得到的约束（改这里前必读）：
 *  ① 动作键是公开键 `submit` / `reset`（**不是** `filterFormSubmit`）。
 *     写错会 400 `addAction only supports registered action types/uses`。
 *  ② 区块的 `layout` 只能写在 tab 上，不能写在 block 上
 *     （`block-layout-unsupported`）。校验器**硬性要求**
 *     `filterForm` 独占 tab 布局的第 0 行（`block-layout-filter-must-lead`），
 *     所以 table 必须落在第 1 行 —— 见 `tabsWithSearch()`。
 *  ③ 表单字段只需要声明 `fields`，连接关系（"搜谁"）由校验器自动推导：
 *     它会按字段名匹配同 tab 内的数据区块，并自动生成
 *     `filterManager: [{targetId: <table uid>, filterPaths: [...]}]`。
 *     实测不要手写连接，手写反而容易对不上。
 *
 * 搜的是 `ticket_no`（走查人最自然的入口："我搜 FW 开头的单号"），
 * 算子用 `$includes` 支持"只记得号段"的情形（服务端已验证可用）。
 */
function ticketSearchBlock(key, title) {
  return {
    key: `${key}-search`,
    type: 'filterForm',
    title,
    collection: 'serviceTickets',
    fields: ['ticket_no'],
    actions: ['submit', 'reset'],
  };
}

/**
 * 把一个 tab 的区块组织成"搜索框在上、内容在下"的显式布局。
 *
 * `filterForm` 必须**独占第 0 行**是校验器的硬规则，不能靠"按数组顺序猜"，
 * 必须显式给 `layout.rows`。这里统一由一个函数产出，避免两个页面各写一遍漂移。
 */
function tabWithSearch(key, title, extraBlocks) {
  const search = ticketSearchBlock(key, '搜索工单');
  return {
    key,
    title,
    blocks: [search, ...extraBlocks],
    layout: { rows: [[search.key], extraBlocks.map((b) => b.key)] },
  };
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
    tabs: STATUS_TABS.map(({ key, title, status }) =>
      tabWithSearch(key, title, [ticketTableBlock(key, title, TICKET_LIST_FIELDS, status)]),
    ),
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
      tabWithSearch('all', '全量工单', [
        ticketTableBlock('hq', '全量工单', TICKET_LIST_FIELDS_HQ, null),
      ]),
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
// Phase 4-I：把自定义动作挂到页面实例上（DEV-68 的正面实现）
// ---------------------------------------------------------------------------

/**
 * 读出全库 flowModels 节点表（uid → node）。
 *
 * ⚠️⚠️ 这里有一个**踩过的坑**，改这段前必读：
 *   第一版实现是"从页面 uid 逐层 `findOne?parentId=` 递归建树"。它在生产环境上
 *   **一行都没找到**，却打印了"全部工单表已挂齐五个自定义动作" —— 典型的
 *   **假绿**（"读到空"是最坏的假绿，见铁律 10）。两个原因叠加：
 *     ① `findOne?parentId=X`（不带 subKey）返回的是 **parentId === X 的那一条子节点**，
 *        不是 X 自己 —— 递归的第一步就把"子"当成了"自己"，树从根上就歪了；
 *     ② 它**只回一条**，无法枚举同一父节点下的多个兄弟
 *        （一个 TableBlock 有 11 个 columns + 5 个 actions），所以永远走不深。
 *   ⇒ 结论：**枚举全库节点就用 `list?paginate=false`**。实测它 200 且 1486 条里
 *     **七个 TableBlockModel 全在、`use` 与 `parentId` 都完整**。
 *     （早前记录的"全量列表不含深层节点的 use"只对最外层 RouteModel 成立，
 *      不能据此放弃这条路 —— 那正是上面那次假绿的借口。）
 *
 * ⚠️ `list?filter={"parentId":...}` 会 **400**（parentId 不可过滤）；
 *    按 uid 单查 `filter={"uid":...}` 才 200。所以"取全量 + 本地建索引"是正解。
 */
async function fetchAllFlowModels(token) {
  const r = await api('/api/flowModels:list?paginate=false', { method: 'GET', token });
  if (r.status >= 400) throw new Error(`读取 flowModels 失败 HTTP ${r.status}`);
  const rows = r.json?.data ?? [];
  if (!rows.length) {
    // 不允许"读到空"静默通过 —— 那会让下面的遍历断言全部空转。
    throw new Error('flowModels 返回 0 条 —— 环境异常，拒绝继续（读到空是最坏的假绿）');
  }
  const byUid = new Map(rows.map((n) => [n.uid, n]));
  const childrenOf = new Map();
  for (const n of rows) {
    if (!n.parentId) continue;
    if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
    childrenOf.get(n.parentId).push(n);
  }
  return { rows, byUid, childrenOf };
}

/**
 * 找出 H1/H2 里所有 `serviceTickets` 的 `TableBlockModel`，**并配对它的行操作列**。
 *
 * ⚠️⚠️ **行级动作（`scene:'record'`）必须挂在 `TableActionsColumnModel` 下，
 *    不是挂在 TableBlock 的 `actions` 下** —— 这是本轮花了一轮才定位到的关键事实。
 *    第一版把五个自定义动作挂到了 `TableBlock` 的 `actions`（与 filter/refresh 同级），
 *    库里 35 行齐齐全全、断言全绿，**但页面上一个业务按钮都没有**；
 *    无头浏览器实测 H1 只渲染出 `筛选 / 重置 / 查看 / 编辑 / 删除`。
 *    对照内置动作立刻看出真相：`ViewActionModel`/`EditActionModel`/`DeleteActionModel`
 *    的 parentId **清一色是 `TableActionsColumnModel`**（实测 `6hcklnd98ex` 等 9 个），
 *    它们的 `subKey` 也是 `actions`，但**父是"操作列"而不是"表格"**。
 *    ⇒ 教训：**"库里写对了"与"界面上出现"是两件事**。结构断言必须配一次真实渲染验证。
 *
 * 配对方式：每个 `TableActionsColumnModel` 的
 * `stepParams.__flowSurfaceMeta.declaredKey` 形如 `<表declaredKey>.actionsColumn`
 * （实测 `all.hq-table.actionsColumn` 等 9 个，与 9 张表一一对应）。
 * 用**字符串前缀**配对，比递归找父子关系稳 —— 全量列表里多数节点**不带 `parentId`**
 * （实测 157/1498 条无 parentId），靠 parentId 建树会静默丢节点。
 */
function findTicketTableBlocks({ rows }) {
  const blocks = [];
  for (const node of rows) {
    if (node.use !== 'TableBlockModel') continue;
    const bag = JSON.stringify(node.stepParams ?? {}) + JSON.stringify(node.props ?? {});
    if (!bag.includes('serviceTickets')) continue;
    const declaredKey = node.stepParams?.__flowSurfaceMeta?.declaredKey;
    if (!declaredKey) continue; // 野区块（手工测试遗留）不碰

    // 配对行操作列：declaredKey 恰好是 `<表key>.actionsColumn`
    const actionColumn = rows.find(
      (c) =>
        c.use === 'TableActionsColumnModel' &&
        c.stepParams?.__flowSurfaceMeta?.declaredKey === `${declaredKey}.actionsColumn`,
    );

    blocks.push({
      uid: node.uid,
      declaredKey,
      parentId: node.parentId,
      actionColumnUid: actionColumn?.uid ?? null,
    });
  }
  return blocks.sort((a, b) => a.declaredKey.localeCompare(b.declaredKey));
}

/**
 * 给一张工单表的**行操作列**挂五个自定义动作（**幂等**）。
 *
 * ⚠️ 挂载点是 `TableActionsColumnModel`（不是 `TableBlock`）—— 见
 *    `findTicketTableBlocks()` 上方那段血泪说明。挂错父节点时库里一切正常、
 *    页面上一片空白。
 *
 * 幂等四条（用户硬要求）如何保证：
 *  ① **不产生重复按钮** —— uid 由 `<actionColumnUid>.<actionKey>` 稳定派生；
 *     角色上已有"对账"步骤把任何非期望实例（含孤儿）删掉，使总行数恒为 表数 × 5。
 *  ② **不改变既有 action uid** —— uid 是纯函数；重跑同值，只 update 内容不换 uid。
 *  ③ **不产生重复 ActionGroup** —— 本实现**不创建任何 ActionGroup**，
 *     五个动作平铺挂在操作列的 `actions` 下（与内置 查看/编辑/删除 同级）。
 *  ④ **不恢复原生 edit/delete/addNew** —— 本实现**只增自定义 use**，
 *     从不写 `edit`/`delete`/`addNew`/`bulkDelete`/`updateRecord`；也不删既有行。
 *
 * ⚠️ 每一步之间**主动让路**（`await pace()`）：一次全量播种要发上百个请求
 *    （8 张表 × 5 个动作 × 探测+写入，外加每张表回读），而 nginx 的
 *    `location /` 限流是 svc_general（300r/m，burst 60 nodelay）。实测裸跑
 *    会在第 6 张表附近开始 **429 TOO_MANY_REQUESTS**，且 429 会让
 *    "创建失败"与"探测失败"混在一起，很难判断到底挂上没有。
 *
 * 🔴🔴🔴 **写入必须用 `flowModels:save` + 「扁平」payload** —— 本轮第二个致命坑：
 *
 *   服务端 `save` 的实现是（`plugin-flow-engine/dist/server/server.js`）：
 *     `save: async (ctx) => { const { values } = ctx.action.params;
 *                            const uid = await repository.upsertModel(values); }`
 *   而 `upsertModel` → `modelToSingleNodes(model)` 的第一行是：
 *     `const { uid, async, subModels, ...rest } = cloneDeep(model);`
 *   也就是说 **`values` 本身就是那个 model 对象**，除 `uid`/`async`/`subModels`
 *   之外的所有字段会被**原样摊平**进节点行。
 *
 *   第一版我传的是 `{ values: {...} }`（多包了一层），结果服务端 `values` =
 *   `{values:{...}, parentId, subKey...}`，落库行长这样：
 *     `{"values":{"use":"TicketDetailActionModel",...},"parentId":"...","subKey":"actions"}`
 *   ——**`use` 被埋在 `values` 里面，顶层没有 `use`**。于是：
 *     · 页面树响应里这个节点的 `use` 是 `undefined`（实测 `use=undefined`）
 *     · 客户端拿不到 `use` → 无法解析模型类 → **静默不渲染**
 *     · 但库里"确实有这行"，所有只数行数的断言**全绿** —— 最阴的一类假绿
 *
 *   正确形状（与内置 `ViewActionModel` 逐字段同构，已实测对齐）：
 *     `{ uid, use, parentId, subKey, subType, props, decoratorProps, stepParams, flowRegistry }`
 *   修正后同一个 `all.all-table` 操作列上，无头浏览器立刻渲染出 `详情` 按钮
 *   （`btns:["筛 选","重 置","查看","编辑","删除","详情"]`）。
 *
 *   教训：**"库里写对了"与"界面上出现了"是两件事**。结构断言的判据应该是
 *   **`use` 字段在不在顶层**（客户端就靠它），而不是"这个 uid 的行存不存在"。
 *
 * ✅ 用 `save` 而不是 `create` 的另一个理由：`create` 走裸 insert，**不触发
 *    `flowModels.afterInsert` 钩子**（该钩子负责 `insertNewSchema` → 写
 *    `flowModelTreePath` 祖先链）。不建祖先链的节点，UI 读树时**完全看不见**。
 *    `save` 内部走 `updateSingleNode`/`insertSingleNode`，路径由钩子维护。
 *
 * ✅ 幂等：`save` 本身就是 upsert（存在则 update、不存在则 insert），
 *    所以"探测存在性"这一步不需要了 —— 一次调用同时覆盖"新建"与"修正"。
 *
 * @returns {{created:number, repaired:number, failed:number}}
 */
async function seedTicketPageActions(token, actionColumnUid, index, existingUids = null) {
  let created = 0;
  let repaired = 0;
  let failed = 0;

  if (!actionColumnUid) {
    // 没有操作列 = 行级动作无处安放。这必须是硬失败，不能跳过。
    return { created: 0, repaired: 0, failed: TICKET_ACTION_MODELS.length };
  }

  for (const [i, model] of TICKET_ACTION_MODELS.entries()) {
    const row = actionRow(actionColumnUid, model, 90 + i);
    const existed = existingUids ? existingUids.has(row.uid) : false;

    // save = upsert。**必须传扁平的 row**（值就是 model 本身），不能再包一层 values。
    const sv = await api('/api/flowModels:save', { body: row, token });
    await pace();
    if (sv.status === 429) {
      failed += 1;
      log(`    ✗ ${model.label} 写入被限流（429）—— 请降低播种频率后重跑`);
      continue;
    }
    if (sv.status >= 400) {
      failed += 1;
      log(`    ✗ ${model.label} 写入失败 HTTP ${sv.status} ${sv.text.slice(0, 140)}`);
      continue;
    }
    // 服务端返回的是它实际落库的 uid；若不等于期望 uid 说明被别的东西改写过，报出来。
    const got = typeof sv.json?.data === 'string' ? sv.json.data : row.uid;
    if (got !== row.uid) {
      failed += 1;
      log(`    ✗ ${model.label} 写入返回了非预期 uid（期望 ${row.uid}，实得 ${got}）`);
      continue;
    }
    if (existed) repaired += 1;
    else created += 1;
  }
  void index;

  return { created, repaired, failed };
}

/**
 * **对账**：把"库里所有自定义动作行"收敛到"恰好等于活着的工单表 × 5"。
 *
 * ⚠️⚠️ 为什么必须有这一步（本轮实测踩出来的**真缺陷**）：
 *   `applyBlueprint(mode='replace')` 在**每次**执行时都会**重建** TableBlock，
 *   并且给它**新的 uid**。于是"uid 由 tableUid 派生"这个设计的前提（表 uid 稳定）
 *   根本不成立 —— 每跑一次播种，上一批动作行就全变成**孤儿**
 *   （parentId 指向已不存在的表），实测三次播种后累计 **100 行、其中 65 行是孤儿**。
 *
 *   注意：孤儿行**不会**渲染成界面上的重复按钮（父节点没了，前端不会去读它），
 *   所以它**不会**被"数一数页面上有几个按钮"这类断言发现。但它是实打实的脏数据：
 *   库会无限膨胀、`declaredKey` 溯源会指向一堆幽灵、将来"按 use 统计动作"的
 *   任何断言都会被它污染。用户明确要求"重复执行播种必须不产生重复按钮"，
 *   行数失控是对这条要求的直接违背。
 *
 *   对账规则（幂等收敛，不是"尽量少"）：
 *     · 活着的工单表（本次 `findTicketTableBlocks` 的结论）× 5 个动作 → **必须有**
 *     · 其它任何 `Ticket*ActionModel` 行 → **一律删除**（孤儿 / 野实例）
 *     跑 N 次之后库里的行数恒为 `7 × 5 = 35`，与跑几次无关。
 *
 * ⚠️ 删除用 `flowSurfaces:removeNode`（`removeAction`/`deleteAction` 都是 404），
 *    并且**必须逐个删**：`removeNode` 只删给定 uid，**不会**级联到已失去父节点的子行动作。
 *
 * @returns {{removed:number, failed:number, live:number, total:number}}
 */
async function reconcileTicketActions(token, liveBlocks) {
  const tree = await fetchAllFlowModels(token);
  const liveUids = new Set(liveBlocks.map((b) => b.actionColumnUid).filter(Boolean));

  // 期望存在的 uid 全集（活着的操作列 × 5 个动作）
  const wanted = new Set();
  for (const b of liveBlocks) {
    if (!b.actionColumnUid) continue;
    for (const m of TICKET_ACTION_MODELS) wanted.add(actionRow(b.actionColumnUid, m, 0).uid);
  }

  let removed = 0;
  let failed = 0;
  for (const node of tree.rows) {
    // ⚠️ 这里用"顶层 use 命中自定义集合"，**只对形状正确的行**生效。
    //    `{values:{...}}` 双包装写入的行顶层没有 use，`TICKET_ACTION_USES.includes(undefined)`
    //    为假 → 会被这一轮漏掉。所以下面额外按 uid 前缀再兜一遍（见 malformed 段）。
    if (!TICKET_ACTION_USES.includes(node.use)) continue;
    if (wanted.has(node.uid) && liveUids.has(node.parentId)) continue;
    const r = await api('/api/flowSurfaces:removeNode', { body: { target: { uid: node.uid } }, token });
    await pace();
    if (r.status >= 400) {
      failed += 1;
      log(`    ✗ 清理孤儿动作失败 ${node.uid}（${node.use}，parent=${node.parentId}）HTTP ${r.status}`);
    } else {
      removed += 1;
    }
  }

  // ---- 兜底：清理"顶层无 use"的病态行（uid 命中期望集合但形状不对）----
  // 病因见 seedTicketPageActions() 上方那段：`{values:{...}}` 双包装。
  // 这类行**不会**被上面的 use 过滤命中，但同样是脏数据，且会污染 declaredKey 溯源。
  for (const node of tree.rows) {
    if (TICKET_ACTION_USES.includes(node.use)) continue;
    if (!wanted.has(node.uid)) continue;
    const r = await api('/api/flowSurfaces:removeNode', { body: { target: { uid: node.uid } }, token });
    await pace();
    if (r.status >= 400) {
      failed += 1;
      log(`    ✗ 清理病态动作失败 ${node.uid}（顶层 use=${node.use ?? '<无>'}）HTTP ${r.status}`);
    } else {
      removed += 1;
    }
  }

  const after = await fetchAllFlowModels(token);
  const total = after.rows.filter((n) => TICKET_ACTION_USES.includes(n.use)).length;
  const orphans = after.rows.filter(
    (n) => TICKET_ACTION_USES.includes(n.use) && !after.byUid.has(n.parentId),
  ).length;

  return { removed, failed, live: wanted.size, total, orphans };
}

/**
 * 回读确认某张表上**五个自定义动作一个不少**，且**没有**通用写路径。
 *
 * 这条是本轮的关键：它读的是**真实 flowModels**，不是源码/bundle。
 * 判定用"集合"而非顺序（铁律 2 / 6）。
 *
 * ⚠️⚠️ **必须传"写入之后"重新拉的树**，不能复用写入前的快照。
 *    踩过：第一版把写入前读的 tree 传进来，于是刚创建成功的动作在快照里
 *    当然不存在 → 五张表全部报"缺失五个动作"。**断言对象是快照还是现值**，
 *    是这类假红/假绿的常见分水岭。
 *
 * ⚠️ **不能把 `AddNewActionModel`/`BulkDeleteActionModel` 判成"通用写路径违规"**。
 *    实测它们是 `default-block-actions.js` 里 `FLOW_SURFACE_DEFAULT_BLOCK_ACTIONS.table`
 *    **自动注入**的默认动作（见 DEV-68 附带发现），任何 table 区块都有，
 *    且**无法通过蓝图移除**（DEV-53 坑 2）。把它们判成违规 = 断言永远为红 = 没有断言。
 *    真正该盯的是"**自定义动作实例**在不在"（下面按 declaredKey `svc.*` 数）。
 *
 * 🔴 **判据必须是「顶层 `use` 字段」而不是「uid 的行存在」**：本轮踩过
 *    `{values:{...}}` 双包装写入 —— 行确实在库里、只数行数的断言全绿，
 *    但顶层 `use` 是 `undefined`，客户端解析不出模型类，**页面静默不渲染**。
 *    所以下面两处都显式断言 `use` 命中期望值（铁律 10：读到空是最坏的假绿）。
 */
async function assertTicketActions(token, block) {
  const tree = await fetchAllFlowModels(token);
  const target = block.actionColumnUid;
  if (!target) {
    return { found: [], missing: [...TICKET_ACTION_USES], customCount: 0, malformed: [] };
  }
  const children = tree.childrenOf.get(target) ?? [];
  const actions = children.filter((c) => c.subKey === 'actions');

  const found = new Set();
  const malformed = [];
  for (const model of TICKET_ACTION_MODELS) {
    const uid = actionRow(target, model, 0).uid;
    const node = tree.byUid.get(uid);
    if (!node) continue;
    if (node.parentId !== target) continue;
    if (node.use !== model.use) {
      // 顶层 use 缺失/错位 —— 正是"库里看着对、页面不渲染"的病征。必须单独报出来。
      malformed.push(`${uid}:${node.use ?? '<顶层无 use>'}`);
      continue;
    }
    found.add(node.use);
  }
  const missing = TICKET_ACTION_USES.filter((u) => !found.has(u));

  // 自定义动作实例总数 —— 用于幂等断言"重跑不增加"。
  const customRows = actions.filter((c) => TICKET_ACTION_USES.includes(c.use));

  return { found: [...found], missing, customCount: customRows.length, malformed };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function log(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * 主动限速：本脚本在动作挂载阶段要发上百个请求，而 nginx 的 `location /`
 * 只给 svc_general（300r/m，burst 60 nodelay）。实测裸跑会在第 6 张表附近
 * 开始 429。这里每个请求后固定让路 120ms —— 全量播种约多花 15s，
 * 换来"不会把 429 和真实失败混在一起"。
 */
const PACE_MS = 120;
const pace = () => new Promise((resolve) => setTimeout(resolve, PACE_MS));

async function fetchRoutes(token) {
  const r = await api('/api/desktopRoutes:list?pageSize=200&sort=sort', { method: 'GET', token });
  if (r.status !== 200) throw new Error(`读取 desktopRoutes 失败 HTTP ${r.status}`);
  return r.json?.data ?? [];
}

// ---------------------------------------------------------------------------
// 角色 → 菜单可见性（2026-09-21 复核方要求补的验收缺口）
// ---------------------------------------------------------------------------

/**
 * 读全部「角色 → 路由」授权行。
 *
 * ⚠️ 这张表是**复合主键** (desktopRouteId, roleName)，没有单一 id 列：
 *   · 重复 create 会 400（"desktopRouteId already exists"），所以必须**先查后建**；
 *   · `destroy?filterByTk=<id>` 会 400（Invalid SQL column），
 *     只有 `destroy?filter=<urlencoded json>` 可用（实测返回 {"data":1}）。
 */
async function fetchRoleGrants(token) {
  const r = await api('/api/rolesDesktopRoutes:list?pageSize=500', { method: 'GET', token });
  if (r.status !== 200) throw new Error(`读取 rolesDesktopRoutes 失败 HTTP ${r.status}`);
  return r.json?.data ?? [];
}

/**
 * 某页面的整棵子树 id（页面自己 + 它下面的 Tab）。
 *
 * 为什么要连 Tab 一起授权：NocoBase 建页时给**每一条**路由（group / page / tab）
 * 各建一行授权；只授页面不授 Tab，菜单能出来但 Tab 会缺。
 * 与其猜哪些必须授，不如和平台默认行为保持一致 —— 整棵子树。
 *
 * @returns {Set<number>} 找不到该页面时返回 null —— **交给调用方报错**，
 *   绝不退化成"跳过"（页面不存在是本脚本最该报的红，不是可以忽略的空）。
 */
function subtreeIdsOf(routes, pageTitle) {
  const page = routes.find((r) => r.type === 'flowPage' && r.title === pageTitle);
  if (!page) return null;
  const ids = new Set([page.id]);
  for (const r of routes) if (r.parentId === page.id) ids.add(r.id);
  return ids;
}

/**
 * 按 `ROLE_MENU_MATRIX` 精确纠偏（多退少补）。
 *
 * 「精确」是关键：只补不删的话，哪天矩阵改了（比如总部不再看某个页面），
 * 旧授权会永远留着，而"菜单多了"这种事不会让任何接口变红。
 */
async function syncRoleMenus(token, routes, grants) {
  const group = routes.find((r) => r.type === 'group' && r.title === ADMIN_NAV_GROUP);
  if (!group) throw new Error(`找不到导航分组「${ADMIN_NAV_GROUP}」，无法维护菜单可见性`);

  // 受管路由全集 = 导航组 + 四张页面的整棵子树。
  // 删除范围**严格限定**在这里头：就算别处还有这些角色的授权也不动，
  // 免得脚本的手伸得太长。
  const managed = new Set([group.id]);
  for (const page of REQUIRED_ADMIN_PAGES) {
    const ids = subtreeIdsOf(routes, page.title);
    if (!ids) throw new Error(`页面「${page.title}」不存在，无法维护菜单可见性`);
    for (const id of ids) managed.add(id);
  }

  const report = [];
  let added = 0;
  let removed = 0;
  let failures = 0;

  for (const role of MANAGED_MENU_ROLES) {
    const expected = new Set([group.id]);
    for (const title of visiblePagesOf(role) ?? []) {
      const ids = subtreeIdsOf(routes, title);
      if (!ids) {
        log(`  ✗ ${role}：矩阵里写了页面「${title}」，但库里没有该页面`);
        failures += 1;
        continue;
      }
      for (const id of ids) expected.add(id);
    }

    const current = new Set(
      grants
        .filter((g) => g.roleName === role && managed.has(g.desktopRouteId))
        .map((g) => g.desktopRouteId),
    );

    const toAdd = [...expected].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !expected.has(id));

    for (const id of toAdd) {
      const r = await api('/api/rolesDesktopRoutes:create', {
        body: { desktopRouteId: id, roleName: role },
        token,
      });
      if (r.status >= 400) {
        log(`  ✗ ${role} → route ${id} 授权失败 HTTP ${r.status} ${r.text.slice(0, 160)}`);
        failures += 1;
      } else {
        added += 1;
      }
    }

    for (const id of toRemove) {
      // ⚠️ filter 必须放 **query** 上：实测 body 里的 filter / filterByTk
      //    都会被 destroy 当成"没给参数"（500 "filter or filterByTk is required"）。
      const filter = encodeURIComponent(JSON.stringify({ desktopRouteId: id, roleName: role }));
      const r = await api(`/api/rolesDesktopRoutes:destroy?filter=${filter}`, { token });
      if (r.status >= 400) {
        log(`  ✗ ${role} → route ${id} 撤权失败 HTTP ${r.status} ${r.text.slice(0, 160)}`);
        failures += 1;
      } else if (r.json?.data !== 1) {
        // 删了 0 行也算异常：说明 filter 没命中，那这行授权其实还在
        log(`  ✗ ${role} → route ${id} 撤权未生效（data=${JSON.stringify(r.json?.data)}）`);
        failures += 1;
      } else {
        removed += 1;
      }
    }

    const pages = (visiblePagesOf(role) ?? []).join('、') || '（无）';
    report.push(`  ${role}：可见 ${pages}（新增 ${toAdd.length} / 撤除 ${toRemove.length}）`);
  }

  return { added, removed, failures, report };
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

  // ---- Phase 4-I：给工单表挂自定义动作（蓝图做不到，见 DEV-68）----
  // 必须放在"页面已落库"之后：动作要挂到**已存在**的 TableBlock uid 上。
  if (!missing.length) {
    log('\n=== 工单表自定义动作挂载（受理 / 派工 / 改派 / 改约 / 详情）===');
    try {
      const tree = await fetchAllFlowModels(token);
      const blocks = findTicketTableBlocks(tree);

      // ⚠️ **必须显式断言找到了区块**。上一版这里没有断言，遍历了 0 个区块
      //    却打印"全部工单表已挂齐五个自定义动作" —— 一次彻头彻尾的假绿
      //    （铁律 10：读到空是最坏的假绿，遍历断言必须断言 checked > 0）。
      if (!blocks.length) {
        log('  ✗ 一张 serviceTickets 表格区块都没找到 —— 播种逻辑或环境已异常，拒绝报通过');
        failures += 1;
      } else {
        log(`  · 定位到 ${blocks.length} 张工单表格区块`);
        // 写入前先记录"已存在哪些动作 uid"，仅用于区分"新建"与"修正"的计数显示。
        const existingUids = new Set(tree.rows.filter((n) => TICKET_ACTION_USES.includes(n.use)).map((n) => n.uid));
        let actionFailures = 0;
        for (const [index, block] of blocks.entries()) {
          if (!block.actionColumnUid) {
            log(`  ✗ ${block.declaredKey}（${block.uid}）：**没有找到行操作列**，行级动作无处安放`);
            actionFailures += 1;
            continue;
          }
          const r = await seedTicketPageActions(token, block.actionColumnUid, index, existingUids);
          actionFailures += r.failed;
          const verdict = await assertTicketActions(token, block);
          const ok = verdict.missing.length === 0 && r.failed === 0 && verdict.malformed.length === 0;
          log(
            `  ${ok ? '✓' : '✗'} ${block.declaredKey}（操作列 ${block.actionColumnUid}）：` +
              `新建 ${r.created} / 修正 ${r.repaired} / 自定义动作实例 ${verdict.customCount}`,
          );
          if (verdict.missing.length) log(`      **缺失自定义动作：${verdict.missing.join('、')}**`);
          // 顶层无 use = 页面一定不渲染。单独点名，避免又被"行数对了"掩盖。
          if (verdict.malformed.length) {
            log(`      **顶层 use 缺失/错位（页面不会渲染）：${verdict.malformed.join('、')}**`);
          }
          if (!ok) actionFailures += 1;
        }
        if (actionFailures) {
          log(`\n✗ 自定义动作挂载有 ${actionFailures} 项未达标`);
          failures += actionFailures;
        } else {
          log(`  · ${blocks.length} 张工单表已挂齐五个自定义动作，且回读确认无缺失`);
        }

        // ---- 对账：删掉所有孤儿/野实例，使总行数恒为 表数 × 5 ----
        // 见 reconcileTicketActions() 上方的说明：blueprint replace 会重建表并换 uid，
        // 所以"每轮新建 5 个 + 上一轮变孤儿"是常态，必须靠对账收敛。
        log('\n=== 自定义动作对账（消除孤儿行）===');
        const rec = await reconcileTicketActions(token, blocks);
        log(`  · 清理孤儿/野实例 ${rec.removed} 行${rec.failed ? `，失败 ${rec.failed} 行` : ''}`);
        log(`  · 现存自定义动作行 ${rec.total}（期望 ${rec.live}）· 孤儿 ${rec.orphans}`);
        // 两条硬断言：孤儿必须归零；总行数必须恰好等于 活表 × 5。
        // 只打印不判断 = 把"库在膨胀"变成一个长期无人发现的观察项。
        if (rec.failed) {
          log(`  ✗ 有 ${rec.failed} 行孤儿清理失败`);
          failures += rec.failed;
        }
        if (rec.orphans > 0) {
          log(`  ✗ 清理后仍有 ${rec.orphans} 行孤儿（parentId 指向不存在的节点）`);
          failures += 1;
        }
        if (rec.total !== rec.live) {
          log(`  ✗ 自定义动作行数 ${rec.total} ≠ 期望 ${rec.live}（有重复或残留实例）`);
          failures += 1;
        }
      }
    } catch (error) {
      log(`  ✗ 自定义动作挂载失败：${error.message}`);
      failures += 1;
    }
  }

  // ---- 角色 → 菜单可见性（页面存在 ≠ 该看到的人能看到）----  // 只有四张页面都建好了才谈得上"谁能看见它们"，所以放在回查之后。
  if (!missing.length) {
    log('\n=== 角色菜单可见性纠偏 ===');
    try {
      const grants = await fetchRoleGrants(token);
      const sync = await syncRoleMenus(token, after, grants);
      for (const line of sync.report) log(line);
      log(`  · 新增 ${sync.added} 条 / 撤除 ${sync.removed} 条授权`);
      failures += sync.failures;

      // 落盘回查：与页面同理，"create 返回 200"不等于库里真的那样。
      // 这里再读一遍，把每个角色的最终可见页面打印出来 —— 这是 I 走查前
      // 唯一能证明"门店员工不会同时看到两个长得一样的菜单"的证据。
      const finalGrants = await fetchRoleGrants(token);
      log('\n  === 落库回查（各业务角色实际可见的页面）===');
      for (const role of MANAGED_MENU_ROLES) {
        const ids = new Set(
          finalGrants.filter((g) => g.roleName === role).map((g) => g.desktopRouteId),
        );
        const seen = after
          .filter((r) => r.type === 'flowPage' && ids.has(r.id))
          .map((r) => r.title);
        const want = [...(visiblePagesOf(role) ?? [])].sort();
        const got = [...seen].sort();
        const ok = want.length === got.length && want.every((t, i) => t === got[i]);
        log(`  ${ok ? '✓' : '✗'} ${role}：${got.join('、') || '（无）'}`);
        if (!ok) {
          log(`      期望：${want.join('、')}`);
          failures += 1;
        }
      }
    } catch (error) {
      log(`  ✗ 菜单可见性维护失败：${error.message}`);
      failures += 1;
    }
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
