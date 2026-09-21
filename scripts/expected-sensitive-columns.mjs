/**
 * expected-sensitive-columns.mjs —— 「绝不能出现在后台通用界面上」的列清单（单一事实来源）
 *
 * 为什么单独抽一个文件：
 *
 *   Phase 4-H 用 `flowSurfaces:applyBlueprint` 播种后台页面时撞上一条硬校验
 *   （`default-field-groups-incomplete`）：`defaults.collections.<coll>.fieldGroups`
 *   必须覆盖该集合的**全部**字段——包括 `access_token_hash`、`feedback_token_hash`
 *   这类安全列。也就是说：**为了把页面建出来，必须把敏感列写进分组里**。
 *
 *   这本身是矛盾的：写进分组 = 未来某个写动作/弹窗会把它渲染成表单项。
 *   当前能成立，唯一原因是本阶段的页面**一律不挂蓝图弹窗**（见
 *   scripts/seed-admin-pages.mjs 【约束 3】）。这是一个**前提条件**，
 *   而不是一条可以靠"注意一点"维持的纪律 —— 前提一旦被违反，
 *   敏感列就会直接出现在界面表单里，而**任何 HTTP 断言都不会变红**。
 *
 *   所以把清单独立出来，让两处共用它、形成闭环：
 *     1) scripts/seed-admin-pages.mjs —— 把这些列集中放进「内部字段（不在界面展示）」组
 *     2) scripts/smoke-test.mjs       —— 真机导出每页蓝图，断言 **没有任何区块引用这些列**
 *     3) docs/PHASE-4.md              —— 人读的说明（为什么"必须写进分组"与"绝不展示"能并存）
 *
 * 清单来源：`nocobase/plugins/service-ticket/src/server/constants.ts` 的
 * `NATIVE_READ_FIELD_DENY` —— 一列如果敏感到不能通过**原生只读接口**下发，
 * 就更不该出现在后台通用界面上。
 *
 * ⚠️ 新增隐藏列时必须同时补这里，否则 seed 会报 `default-field-groups-incomplete`
 *    （那正是我们要的漂移红灯，不要靠"往兜底组里自动塞"让它变绿 —— 那等于
 *    把一次评审变成一次静默）。
 */

/** 集合 → 绝不能在界面上展示的列 */
export const SENSITIVE_COLUMNS = {
  serviceTickets: [
    'handler',
    'extra_json',
    // 客户评价链接的凭据。库里只有 sha256；泄露它等于泄露匿名评价入口。
    'feedback_token_hash',
    'feedback_token_expires_at',
    'feedback_token_used_at',
  ],
  serviceVisits: [
    // 师傅一次性链接的凭据（Phase 5 H5 用）。同上：绝不进后台页面。
    'access_token_hash',
    'token_expires_at',
    'token_used_at',
    'token_revoked_at',
    //
    // ⚠️ 这里**故意没有** `token_revoked_reason` —— 它虽然也在
    //    「内部字段」那一组里（NATIVE_READ_FIELD_DENY 同时拦了它），
    //    但它是**业务上必须看得见**的：派工记录页要显示"这条链接为什么失效"
    //    （见 docs/PHASE-4.md §12.1）。它的取值是 `REASSIGNED` / `RESCHEDULED`
    //    这类枚举，不含凭据。
    //    判据是"泄露了会不会被利用"，不是"名字里有没有 token"。
  ],
  ticketEvents: [
    // 事件元数据的原始 JSON：可能含内部 id / 供应商原文，不进列表。
    'metadata_json',
  ],
};

/** 拍平成一个 Set，供"区块引用了敏感列吗"这类判定使用 */
export const SENSITIVE_COLUMN_SET = new Set(Object.values(SENSITIVE_COLUMNS).flat());

/** 某集合的敏感列（无则空数组） */
export function sensitiveColumnsOf(collection) {
  return SENSITIVE_COLUMNS[collection] ?? [];
}

/**
 * Phase 4-H 必须存在的后台页面。
 *
 * 为什么把页面标题也放进"清单"：
 *   `desktopRoutes` 里的页面**一旦被删、或播种脚本被误删，库里的数据不会变红** ——
 *   而那正是"后台又变回一片空白"的事故形态（与 DEV-48 同型：
 *   接口全绿、界面全瞎）。把"应该有哪几个页面"写进清单并由 smoke 断言，
 *   是让这类静默消失能被一条命令发现的唯一办法。
 *
 * `collection` 用于与 SENSITIVE_COLUMNS 交叉核对：smoke 会断言
 * 该页面的所有区块字段都**不属于任何**敏感列。
 */
export const REQUIRED_ADMIN_PAGES = [
  { title: '我的门店工单', collection: 'serviceTickets', tabs: 6 },
  { title: '全量工单', collection: 'serviceTickets', tabs: 1 },
  { title: '工单事件时间线', collection: 'ticketEvents', tabs: 1 },
  { title: '派工记录', collection: 'serviceVisits', tabs: 1 },
];

/** 这些页面统一挂在这个导航分组下 */
export const ADMIN_NAV_GROUP = '售后工单';

/**
 * H1「我的门店工单」的状态 Tab。
 *
 * 与 `REQUIRED_ADMIN_PAGES` 同理：Tab 的**标题 + 对应状态**也是交付内容的一部分
 * （"点进去就是那个状态的工单"是 H1 的核心价值）。清单化之后，
 * 播种脚本按它生成 Tab、smoke 按它逐个核对默认筛选 —— 两处不会各写一份。
 */
export const TICKET_STATUS_TABS = [
  { key: 'new', title: '待受理', status: 'NEW' },
  { key: 'processing', title: '处理中', status: 'PROCESSING' },
  { key: 'wait-store', title: '待门店确认', status: 'WAIT_STORE_CONFIRM' },
  { key: 'wait-feedback', title: '待客户评价', status: 'WAIT_FEEDBACK' },
  { key: 'closed', title: '已闭环', status: 'CLOSED' },
];

/**
 * `defaultFilter` 至少覆盖几个可筛选字段。
 * 与 flowSurfaces 校验器的 `FLOW_SURFACE_DEFAULT_FILTER_REQUIRED_FIELD_COUNT` 对齐；
 * smoke 用它断言"状态 Tab 的筛选条件没被悄悄删成一条"。
 */
export const DEFAULT_FILTER_MIN_FIELDS = 3;
