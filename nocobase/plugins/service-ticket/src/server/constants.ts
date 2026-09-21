/**
 * 全局常量与枚举。
 *
 * 设计原则（对应开发文档 §16 与 docs/DATA-MODEL.md）：
 *  - 枚举值写死在代码里，数据库只存字符串；任何"新增枚举"都必须改这里 + 走一次评审，
 *    不允许运营在后台随意新增，避免状态机被绕过。
 *  - 阈值/上限/时长等可调参数不放这里，放 serviceSettings 表（见 DEFAULT_SETTINGS）。
 */

/** npm 包名，用于日志、i18n 命名空间、错误信息 */
export const PKG_NAME = '@local/service-ticket';

/** 插件短名（去掉 @local/ 前缀），NocoBase 内部用 */
export const PLUGIN_NAME = 'service-ticket';

// ---------------------------------------------------------------------------
// 工单状态机（6 个主状态）
// ---------------------------------------------------------------------------
export const TICKET_STATUS = {
  /** 客户已提交，待门店受理 */
  NEW: 'NEW',
  /** 门店已受理，处理中（可能包含多次上门） */
  PROCESSING: 'PROCESSING',
  /** 师傅已提交，待门店确认（驳回后回到 PROCESSING） */
  WAIT_STORE_CONFIRM: 'WAIT_STORE_CONFIRM',
  /** 门店已确认，已发出评价邀约，待客户评价 */
  WAIT_FEEDBACK: 'WAIT_FEEDBACK',
  /** 已闭环（评价完成 / 评价超时自动关闭 / 手工关闭） */
  CLOSED: 'CLOSED',
  /** 客户或门店取消 */
  CANCELLED: 'CANCELLED',
} as const;

export type TicketStatus = (typeof TICKET_STATUS)[keyof typeof TICKET_STATUS];

export const TICKET_STATUS_VALUES: TicketStatus[] = Object.values(TICKET_STATUS);

/** 状态中文名，用于后台展示与事件 summary 拼接 */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  NEW: '待受理',
  PROCESSING: '处理中',
  WAIT_STORE_CONFIRM: '待门店确认',
  WAIT_FEEDBACK: '待客户评价',
  CLOSED: '已闭环',
  CANCELLED: '已取消',
};

// ---------------------------------------------------------------------------
// 合法状态迁移（docs/STATE-MACHINE.md 的 M1–M15）
// ---------------------------------------------------------------------------
/**
 * 只列「状态发生变化」的迁移；M4/M5/M6 属于同状态内的字段变更，不在此表。
 * - NEW                → PROCESSING（M2 受理 / M3 派工）、CANCELLED（M7）
 * - PROCESSING         → WAIT_STORE_CONFIRM（M8 师傅提交）、WAIT_FEEDBACK（M11 远程完成）、CANCELLED（M7）
 * - WAIT_STORE_CONFIRM → WAIT_FEEDBACK（M9 确认）、PROCESSING（M10 驳回）
 * - WAIT_FEEDBACK      → CLOSED（M12 正常评价 / M14 评价超时）、PROCESSING（M13 低分或收费不一致重开）
 * - CLOSED             → PROCESSING（M15 总部重开）
 * - CANCELLED          → 终态，无出边
 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['WAIT_STORE_CONFIRM', 'WAIT_FEEDBACK', 'CANCELLED'],
  WAIT_STORE_CONFIRM: ['WAIT_FEEDBACK', 'PROCESSING'],
  WAIT_FEEDBACK: ['CLOSED', 'PROCESSING'],
  CLOSED: ['PROCESSING'],
  CANCELLED: [],
};

/** 判断一次状态迁移是否合法 */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

// ---------------------------------------------------------------------------
// 业务枚举
// ---------------------------------------------------------------------------
export const TICKET_TYPE = {
  REPAIR: 'repair',
  COMPLAINT: 'complaint',
} as const;
export const TICKET_TYPE_VALUES = Object.values(TICKET_TYPE);

/** 工单来源：扫码 / 链接 / 店员代提 */
export const TICKET_SOURCE = {
  QR: 'qr',
  LINK: 'link',
  STAFF: 'staff',
} as const;
export const TICKET_SOURCE_VALUES = Object.values(TICKET_SOURCE);

/** 服务方式：门店自修 / 厂家 / 第三方 / 远程指导 */
export const SERVICE_MODE = {
  INHOUSE: 'inhouse',
  MANUFACTURER: 'manufacturer',
  THIRD_PARTY: 'third_party',
  REMOTE: 'remote',
} as const;
export const SERVICE_MODE_VALUES = Object.values(SERVICE_MODE);

/** 门店侧完成结果 */
export const COMPLETION_RESULT = {
  RESOLVED: 'resolved',
  UNRESOLVED: 'unresolved',
  REFERRED: 'referred',
  CUSTOMER_CANCELLED: 'customer_cancelled',
  OTHER: 'other',
} as const;
export const COMPLETION_RESULT_VALUES = Object.values(COMPLETION_RESULT);

/** 师傅侧服务结果 */
export const SERVICE_RESULT = {
  RESOLVED: 'resolved',
  NEED_FOLLOWUP: 'need_followup',
  UNRESOLVED: 'unresolved',
  CUSTOMER_ABSENT: 'customer_absent',
  OTHER: 'other',
} as const;
export const SERVICE_RESULT_VALUES = Object.values(SERVICE_RESULT);

/** 门店确认状态 */
export const STORE_CONFIRM_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
} as const;
export const STORE_CONFIRM_STATUS_VALUES = Object.values(STORE_CONFIRM_STATUS);

/** 评价状态 */
export const REVIEW_STATUS = {
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  EXPIRED: 'expired',
} as const;
export const REVIEW_STATUS_VALUES = Object.values(REVIEW_STATUS);

/** 客户反馈收费与门店确认金额是否一致 */
export const CHARGE_MATCH = {
  MATCH: 'match',
  MISMATCH: 'mismatch',
  NOT_APPLICABLE: 'not_applicable',
} as const;
export const CHARGE_MATCH_VALUES = Object.values(CHARGE_MATCH);

/** 照片类型 */
export const PHOTO_TYPE = {
  ONSITE: 'onsite',
  COMPLETED: 'completed',
  RECEIPT: 'receipt',
  OTHER: 'other',
} as const;
export const PHOTO_TYPE_VALUES = Object.values(PHOTO_TYPE);

/** 关闭原因 */
export const CLOSE_REASON = {
  REVIEWED: 'reviewed',
  REVIEW_EXPIRED: 'review_expired',
  CANCELLED: 'cancelled',
  MANUAL: 'manual',
} as const;
export const CLOSE_REASON_VALUES = Object.values(CLOSE_REASON);

/** 事件类型白名单（开发文档 §16） */
export const EVENT_TYPE = {
  CREATED: 'created',
  ACCEPTED: 'accepted',
  TRANSFERRED: 'transferred',
  DISPATCHED: 'dispatched',
  RESCHEDULED: 'rescheduled',
  REASSIGNED: 'reassigned',
  TECHNICIAN_SUBMITTED: 'technician_submitted',
  STORE_CONFIRMED: 'store_confirmed',
  STORE_REJECTED: 'store_rejected',
  COMPLETED: 'completed',
  SMS_SENT: 'sms_sent',
  SMS_FAILED: 'sms_failed',
  REVIEWED: 'reviewed',
  REOPENED: 'reopened',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
} as const;
export const EVENT_TYPE_VALUES = Object.values(EVENT_TYPE);

/** 事件操作者身份 */
export const OPERATOR_KIND = {
  CUSTOMER: 'customer',
  TECHNICIAN: 'technician',
  STORE: 'store',
  HQ: 'hq',
  SYSTEM: 'system',
} as const;
export const OPERATOR_KIND_VALUES = Object.values(OPERATOR_KIND);

/** 短信场景（每个场景对应一个供应商模板） */
export const SMS_SCENE = {
  DISPATCH_CUSTOMER: 'dispatch_customer',
  TECHNICIAN_TASK: 'technician_task',
  DISPATCH_UPDATE: 'dispatch_update',
  REVIEW_INVITE: 'review_invite',
  MANUAL_RESEND: 'manual_resend',
} as const;
export const SMS_SCENE_VALUES = Object.values(SMS_SCENE);

export const SMS_SEND_STATUS = {
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  ERROR: 'error',
} as const;
export const SMS_SEND_STATUS_VALUES = Object.values(SMS_SEND_STATUS);

export const SMS_DELIVERY_STATUS = {
  PENDING: 'pending',
  DELIVERED: 'delivered',
  FAILED: 'failed',
} as const;
export const SMS_DELIVERY_STATUS_VALUES = Object.values(SMS_DELIVERY_STATUS);

/** 限流作用域 */
export const GUARD_SCOPE = {
  IP: 'ip',
  MOBILE: 'mobile',
  TOKEN: 'token',
  STORE: 'store',
} as const;
export const GUARD_SCOPE_VALUES = Object.values(GUARD_SCOPE);

/** 幂等场景 */
export const IDEMPOTENCY_SCENE = {
  PUBLIC_TICKET: 'public_ticket',
  TECHNICIAN_SUBMIT: 'technician_submit',
  REVIEW_SUBMIT: 'review_submit',
  STORE_CONFIRM: 'store_confirm',
} as const;

// ---------------------------------------------------------------------------
// 工单号 / 取号键
// ---------------------------------------------------------------------------
/** 工单号前缀，例：FW20260920-0001 */
export const TICKET_NO_PREFIX = 'FW';
/** 工单号：日期段 + 流水段，流水段宽度 */
export const TICKET_NO_SEQ_WIDTH = 4;

/**
 * 取号键（dailySequences.seq_key）的构造规则。
 *
 * seq_key 是「按什么维度重置流水」的载体：
 *   FW-20260920  → 工单号按**天**重置，每天从 0001 开始
 *   V-12         → 上门序号按**工单**递增，永不重置
 *
 * 常量集中在这里而不是散落在 SequenceService 里，是因为 seq_key 一旦变更，
 * 已发出去的号码与库里的历史行就会出现两套命名 —— 属于需要评审的改动。
 */
export const SEQUENCE_KEY = {
  /** 工单号：`<TICKET_PREFIX>-<YYYYMMDD>` */
  TICKET_PREFIX: TICKET_NO_PREFIX,
  /** 上门序号：`<VISIT_PREFIX>-<ticketId>` */
  VISIT_PREFIX: 'V',
  TICKET_SEQ_WIDTH: TICKET_NO_SEQ_WIDTH,
  /** 上门序号宽度（ticket 4-01） */
  VISIT_SEQ_WIDTH: 2,
} as const;

// ---------------------------------------------------------------------------
// PostgreSQL 表名 / 列名（服务层写原生 SQL 时使用）
// ---------------------------------------------------------------------------
/**
 * ⚠️ 这些是**数据库中的真实表名**，与 collections/index.ts 的 EXPECTED_TABLE_NAMES 必须一致。
 *    之所以在下划线命名下，是因为本插件所有 collection 都强制 `underscored: true`
 *    （见 collections/_helpers.ts 与 docs/DEVIATIONS.md DEV-14）。
 *    服务层写原生 SQL 时一律引用这里，不要手写字面量 —— 手写最容易写成驼峰而报 42703。
 */
export const TABLE = {
  STORES: 'stores',
  STORE_USERS: 'store_users',
  SERVICE_TICKETS: 'service_tickets',
  SERVICE_VISITS: 'service_visits',
  SERVICE_VISIT_PHOTOS: 'service_visit_photos',
  TICKET_EVENTS: 'ticket_events',
  SMS_LOGS: 'sms_logs',
  DAILY_SEQUENCES: 'daily_sequences',
  API_GUARDS: 'api_guards',
  IDEMPOTENCY_RECORDS: 'idempotency_records',
  SERVICE_SETTINGS: 'service_settings',
} as const;

/**
 * 时间戳列名。
 *
 * NocoBase 会为每个 collection 自动注入这两个列，且在 `underscored: true` 下
 * 落库为 snake_case。**它们 NOT NULL 且没有 DB 默认值**（NocoBase 在应用层赋值），
 * 所以服务层手写原生 INSERT 时必须显式提供，否则报 23502。
 */
export const CREATED_AT_COLUMN = 'created_at';
export const UPDATED_AT_COLUMN = 'updated_at';

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------
/**
 * 角色名与 docs/API.md §4 的「角色 × 动作矩阵」严格对应。
 *
 * 命名说明：文档正文写 `store_after_sales` 等，此处保持一致；
 * NocoBase 后台的角色 title（中文名）在 seed 时设置。
 */
export const ROLE = {
  /** 门店售后：只看得到被授权门店的数据 */
  STORE_AFTER_SALES: 'store_after_sales',
  /** 总部售后：全量数据，含强制转店/重开 */
  HQ_AFTER_SALES: 'hq_after_sales',
  /** 总部管理员：额外可改参数/用户/门店、可导出 */
  HQ_ADMIN: 'hq_admin',
  /** 只读管理层：全量只读，手机号默认脱敏 */
  VIEWER: 'viewer',
} as const;

export type RoleName = (typeof ROLE)[keyof typeof ROLE];

export const ROLE_VALUES: RoleName[] = Object.values(ROLE);

/** 能看到全量数据的角色（不受 storeUsers 授权表限制） */
export const HQ_ROLES: RoleName[] = [ROLE.HQ_AFTER_SALES, ROLE.HQ_ADMIN, ROLE.VIEWER];

/** 只能看被授权门店数据的角色 */
export const STORE_SCOPED_ROLES: RoleName[] = [ROLE.STORE_AFTER_SALES];

/** 可以执行写操作（受理/派工/取消/确认…）的角色 —— 只读角色不在其中 */
export const WRITE_ROLES: RoleName[] = [
  ROLE.STORE_AFTER_SALES,
  ROLE.HQ_AFTER_SALES,
  ROLE.HQ_ADMIN,
];

/** 拥有跨店特权（强制转店、重开已关闭工单）的角色 */
export const PRIVILEGED_ROLES: RoleName[] = [ROLE.HQ_AFTER_SALES, ROLE.HQ_ADMIN];

/** 手机号默认脱敏的角色（文档 §11「手机号泄露」控制项） */
export const MASK_MOBILE_ROLES: RoleName[] = [ROLE.VIEWER];

/**
 * **平台超管角色**（NocoBase 内置，不属于本系统的业务角色体系）。
 *
 * 为什么不把它们和业务角色混在一起：业务能力只应来自业务角色（API.md §4），
 * 否则"谁能改工单"会变成一句空话。但平台超管是这套系统的主人：
 *   · NocoBase 自己就写着 `acl.allow('*', '*', ctx => currentRoles.includes('root'))`，
 *     root 天然绕过全部 ACL；
 *   · 如果业务层反过来不认它们，交付/运维人员会看到
 *     "能进后台但列表全空、业务按钮全 403" 的怪状态，且无法自证是配置问题。
 *
 * 因此这里显式声明：持有 root / admin 的用户按**总部管理员**对待
 * （数据范围 all + 全部能力）。这是唯一一处"角色之外的授权来源"，
 * 集中在这里声明、集中评审（见 docs/SECURITY.md「平台超管」）。
 */
export const PLATFORM_ADMIN_ROLES: string[] = ['root', 'admin'];

/**
 * serviceTickets 上**不允许**经 NocoBase 原生 update 修改的字段。
 *
 * 依据 docs/API.md §6「状态类变更禁止直调原生 update」：
 * 这些字段一旦被后台表单直接改掉，状态机与事件时间线就失去一致性
 * （status 变了却没有 ticketEvents 行，SLA 与报表全部失真）。
 * 由 seed 脚本把它们在 ACL 里设为只读，业务侧只能走 /api/svc/... action。
 */
export const TICKET_READONLY_FIELDS: string[] = [
  'status',
  'escalated',
  'reopen_count',
  'review_status',
  'feedback_token_hash',
  'feedback_token_expires_at',
  'feedback_token_used_at',
  'dispatch_at',
  'completed_at',
  'closed_at',
  'first_response_at',
  'ticket_no',
];

// ---------------------------------------------------------------------------
// 插件对外的 action 名（resource = svc）
// ---------------------------------------------------------------------------
/**
 * `svc` 资源上的 action 名。
 *
 * ⚠️ 为什么用这些**单段**名字，而不是 `tickets:accept` 这种带冒号的名字：
 *   NocoBase 的 parseRequest 对 `/api/<a>:<b>:<c>` 只做**一次** split(":")
 *   （见 @nocobase/resourcer/lib/utils.js 末尾）：
 *       const [resourceName, actionName] = params.resourceName.split(":");
 *   第三段会被**静默丢弃** —— `svc:tickets:accept` 会被解析成
 *   resource=svc / action=tickets，随后 `getAction('tickets')` 抛
 *   "tickets action does not exist"，被 resourcerMiddleware 的 try/catch 吞掉后
 *   落到 404。因此多段 action 名在 NocoBase 里根本不可达。
 *
 *   对外仍然暴露开发文档约定的 `/api/svc/tickets/:id/<action>`，
 *   由 nginx 内部重写为 `/api/svc:<action>?filterByTk=<id>`
 *   （见 nginx/conf.d/service.conf 的 svc 内部接口段、docs/DEVIATIONS.md DEV-18）。
 */
export const SVC_ACTION = {
  HEALTH: 'health',
  ACCEPT: 'accept',
  TRANSFER: 'transfer',
  CANCEL: 'cancel',
  TIMELINE: 'timeline',
  /**
   * 限流额度只读诊断（Phase 3-E 新增）。
   *
   * 为什么它必须是**匿名可达**的：调用方（并发验收脚本）在"发压之前"要知道
   * 本 IP 在当前分钟窗口已用多少次、阈值多少、还剩多少 —— 而"本 IP 是谁"
   * 只有应用侧知道（nginx 传的 X-Real-IP 是 Docker 网桥地址，脚本猜不到），
   * 所以这个数字只能由应用自己算出来告诉它。
   *
   * 为什么不是"裸匿名"：它虽然走 `acl.allow(...)`（public）放行，但 handler
   * **强制校验 `X-Svc-Diag-Key` == 进程内 SIGN_SECRET**，不匹配一律 404。
   * 于是它对外表现为"不存在"，只有持有服务端密钥的运维/验收脚本能用。
   * 见 actions/svc/guard-quota.ts 与 docs/DEVIATIONS.md DEV-30。
   */
  GUARD_QUOTA: 'guardQuota',
} as const;

export const SVC_ACTION_VALUES: string[] = Object.values(SVC_ACTION);

/**
 * `svc` 资源上**必须登录**的 action。
 *
 * 取值要与 SVC_ACTION 里除 health / guardQuota 之外的项一致，
 * registerSvcResource() 会用它生成 `only` 白名单 ——
 * 这是"svc 资源只暴露这几个 action"的唯一事实来源。
 *
 * ⚠️ guardQuota 刻意**不在**此列：它由 `acl.allow('svc','guardQuota')`（public）
 *    放行后自行校验共享密钥。放进 loggedIn 会让"匿名预检"永远 401。
 */
export const AUTHENTICATED_SVC_ACTIONS: string[] = [
  SVC_ACTION.ACCEPT,
  SVC_ACTION.TRANSFER,
  SVC_ACTION.CANCEL,
  SVC_ACTION.TIMELINE,
];

// ---------------------------------------------------------------------------
// 匿名客户接口（Phase 3）
// ---------------------------------------------------------------------------
/**
 * 匿名接口的**资源名**。
 *
 * 为什么资源名是 `publicStore` / `publicTicket` 这种"单数 + 业务名"：
 *   · NocoBase 的 URL 是 `/api/<resource>:<action>`，资源名即 URL 的一段，
 *     必须与 nginx 重写后的目标逐字一致（见 nginx/conf.d/service.conf）；
 *   · 不能与 NocoBase 核心资源同名（如 `stores` / `tickets`）——
 *     重名会撞进核心 ACL 与原生 CRUD，等于把内部接口暴露成匿名可写。
 *   · 复数与否不影响语义，这里统一用单数，与 docs/PHASE-0.md 的接口规划示例
 *     （`publicStore:list` / `publicTicket:create`）保持一致。
 */
export const PUBLIC_RESOURCE = {
  STORE: 'publicStore',
  TICKET: 'publicTicket',
} as const;

/** 匿名接口上的 action 名（同样必须单段，理由见 SVC_ACTION 注释） */
export const PUBLIC_ACTION = {
  STORE_LIST: 'list',
  TICKET_CREATE: 'create',
} as const;

/**
 * 允许**登录用户**经 NocoBase 原生接口读取的资源（docs/API.md §6）。
 *
 * 为什么是"允许读取"而不是"按角色逐条授权"：
 *   原生接口的 ACL 粒度是「资源 × action」，**没有**数据级维度。
 *   授权读取后真正的隔离由 storeScope 中间件（框架层）与 PermissionService
 *   （对象级）两层完成，且两者的缺省都是 fail-closed —— 角色不可识别时
 *   数据范围是 none（查不到任何行），不是 all。
 *   只放 list/get，**不放** create/update/destroy/export：
 *   create 由 storeScope 直接拒绝（业务写入必须走 /api/svc），
 *   update/destroy/export 在 Phase 2 一律不开放（见 docs/DEVIATIONS.md DEV-19）。
 */
export const NATIVE_READ_ALLOWLIST: Array<[resource: string, actions: string[]]> = [
  ['serviceTickets', ['list', 'get']],
  ['serviceVisits', ['list', 'get']],
  ['ticketEvents', ['list', 'get']],
  ['smsLogs', ['list', 'get']],
];

/**
 * 各业务角色在**原生接口**上被授予的只读 action。
 *
 * ⚠️ 与 NATIVE_READ_ALLOWLIST 的关系（这是本组常量最容易搞错的一点）：
 *   · `NATIVE_READ_ALLOWLIST` 只表达"这四个资源允许被只读访问"这条**设计意图**，
 *     它自己**不会**产生任何授权 —— 早期版本只拿它做启动期自检，
 *     于是真机上出现了一个很难看的状态：
 *     docs/API.md §6 写着「后台列表/详情读取 ✅ 允许」，
 *     而四个业务角色实际全是 `403 {"errors":[{"message":"No permissions"}]}`。
 *     根因是 NocoBase 的判定链有两级，只写一级不够：
 *       ① strategy.actions（dataSourcesRoles.strategy）—— 全局 action 名白名单；
 *       ② **资源级授权**（dataSourcesRolesResources + ...Actions）—— 逐资源放行。
 *     只写 ① 时，任何资源都匹配不到 ② 的授权条目 → 一律 403。
 *   · 本常量与 ROLE_NATIVE_READ_RESOURCES 一起，是**真正落到 ② 的输入**
 *     （见 seeds/roles.ts 的 resourceSeedsOf 与 seeds/apply.ts 的 seedRoles）。
 *
 * 只列只读 action：写操作（create/update/destroy/export/move）**一律不授予任何角色**。
 *   依据 docs/API.md §6「状态类变更 ❌ 禁止直调原生 update」。
 *   这里比文档更严一档 —— 文档允许"仅限非状态字段"的后台修改，
 *   但那需要逐字段白名单，而 NocoBase 的资源级授权只有"整个 action + 字段列表"，
 *   拿它表达"可以改备注但不能改 status"会依赖 fields 的运行时配置（界面一改就没了）。
 *   因此 Phase 2 的口径是：原生写全关，业务写入只走 /api/svc action。
 *   见 docs/DEVIATIONS.md DEV-22。
 */
export const ROLE_NATIVE_READ_ACTIONS: string[] = ['list', 'get'];

/**
 * 需要逐角色授予资源级读取权限的资源清单。
 *
 * 直接取 NATIVE_READ_ALLOWLIST 的资源名，**不另立一份清单** ——
 * 两份清单迟早会漂移，而漂移的表现是"某张表在后台突然打不开"。
 * 这样 NATIVE_READ_ALLOWLIST 就从"一句注释"变成了单一事实来源。
 */
export const ROLE_NATIVE_READ_RESOURCES: string[] = NATIVE_READ_ALLOWLIST.map(
  ([resource]) => resource,
);

/**
 * 原生只读接口上**绝不下发**的列（按资源分组）。
 *
 * 为什么需要它 —— 一次真机取证的结论（"字段白名单"这一级很容易被忽略）：
 *   资源级授权的每条 action 还带一个 `fields` 数组；NocoBase 用它做**字段级**过滤
 *   （plugin-acl 的 `beforeGrantAction` 钩子）：
 *     · `fields` 是**数组** → 响应里只保留这些字段，**并且**强制补上
 *       id / createdAt / updatedAt（主键与时间戳）。所以 `fields: []`
 *       的真实语义不是"不限制"，而是"只给 3 个系统字段、业务列全部挡掉" ——
 *       真机实测：门店角色的 `serviceTickets:list` 只回
 *       `{id, createdAt, updatedAt}`，工单内容一列都看不到。
 *     · `fields` 是 **null / 不存在** → 该 action 不做字段级过滤，**整行下发**。
 *
 *   两条路都不能直接用：`[]` 让接口失去意义，`null` 会把
 *   `feedback_token_hash`（评价 Token 的 sha256，明文不入库，但哈希泄露等于
 *   允许离线爆破/重放构造）与 `access_token_hash`（师傅端一次性 Token）
 *   一并下发。所以这里取第三条路：**枚举集合全部属性 − 本表列出的敏感列**。
 *
 * 为什么用"排除法"而不是写死一份正字段清单：
 *   正清单每加一个业务字段就要同步改一次，漏改的表现是"新字段在后台看不见"，
 *   属于慢性病。排除法只在**新增敏感列**时才需要维护，而新增敏感列
 *   一定会同时改本常量（否则就是安全评审漏项），语义上更贴近"最小暴露"。
 *
 * ⚠️ 本表的列名必须与 **`collection.model.rawAttributes` 的键**逐字一致
 *   （不是列名、也不是 `getFields()` 里的名字）—— ACL 的 `fields` 白名单
 *   比对的就是属性名。好在本插件所有业务字段本身就是 snake_case，
 *   三者一致；只有自动注入的时间戳是 camelCase（createdAt / updatedAt），
 *   而它们从不是敏感列，不进本表。
 *
 * 枚举失败怎么办：见 seeds/apply.ts 的 nativeReadFieldsOf —— 宁可让播种失败
 *   让人看到，也不要静默退化成"整行下发"。
 */
export const NATIVE_READ_FIELD_DENY: Record<string, string[]> = {
  // 评价 Token：客户凭它免登录进入评价页，哈希泄露 = 可离线爆破构造可用链接
  serviceTickets: [
    'feedback_token_hash',
    'feedback_token_expires_at',
    'feedback_token_used_at',
  ],
  // 师傅端一次性 Token（sha256，用后即焚）
  serviceVisits: ['access_token_hash', 'token_expires_at', 'token_used_at'],
  ticketEvents: [],
  smsLogs: [],
};

/** 取某资源在原生只读接口上应被排除的列（未登记的资源按"全排除"从严处理） */
export function nativeReadDenyFields(resource: string): string[] {
  return NATIVE_READ_FIELD_DENY[resource] ?? [];
}

/**
 * 四个业务角色的 `fields` 白名单是**受管（managed）**的：由代码决定，漂移即对齐。
 *
 * 背景（Phase 2.1 验收整改项 4）：
 *   真机验收时 `viewer` 的 `serviceTickets` 两条 action 行被探针改成了 7 列，
 *   而当时的修复逻辑对"非空数组"一律不碰（动机是不覆盖运营配置），
 *   于是**测试残留被永久固化进线上权限**——报告里只能写一句"与其余角色不一致"。
 *   这不是"保护运营配置"，而是把"没人负责的一块安全边界"留在库里。
 *
 * 因此本项目的口径调整为（与 DEV-19 / DEV-22 的理由完全一致）：
 *   **字段白名单是安全边界，不接受后台手工配置，一律由代码单一事实来源决定。**
 *   需要调整某角色的可见字段范围 → 改 `NATIVE_READ_FIELD_DENY` 或表定义，
 *   走代码评审与断言，而不是在后台点几下。
 *
 * 于是修复逻辑的判定顺序变成：
 *   ① 缺 action 行            → 补建（不补则该 action 恒 403）
 *   ② `fields === null`       → 纠正（null = 整行下发，**泄露 token 哈希**）
 *   ③ `fields === []`         → 纠正（空壳，业务列全丢）
 *   ④ 与期望白名单**不同集合** → 对齐（**这是本次新增的第 4 类**，含"列数对但成员错"
 *                              与"成员对但列数不同"两种；**顺序不参与比较**，
 *                              理由见 sameFieldSet 的注释）
 *   ⑤ 与期望白名单同集合       → 不动
 *
 * 逃生开关：确实需要在库里手工调白名单（例如临时给某门店角色放开一列排查问题）时，
 *   显式设置 `SVC_ACL_FIELDS_AUTOFIX=0` 关闭第 ④ 类对齐；
 *   ⚠️ 第 ② ③ 类（`null` / `[]`）**不受开关影响，永远纠正** ——
 *   那是漏洞，不是配置。
 */
export const ACL_FIELDS_AUTOFIX_ENV = 'SVC_ACL_FIELDS_AUTOFIX';

/** 读取"是否允许自动对齐漂移白名单"。默认开启（1/true）；显式 0/false 才关闭。 */
export function aclFieldsAutofixEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env?.[ACL_FIELDS_AUTOFIX_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const value = String(raw).trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

/**
 * 比较两个白名单是否**同集合**（忽略顺序、忽略重复）。
 *
 * 为什么是集合语义、而不是"逐字相同"（**这条来自一次真实的假漂移**）：
 *   ACL 的 `fields` 是**列白名单**，语义上就是集合 —— 顺序只影响 SELECT 的列序，
 *   不影响任何一条鉴权判定。而 NocoBase 自己会在 `list` 动作上**规范化重排**
 *   这个数组（真机取证：同一份白名单，`get` 行保持我们写入的顺序，
 *   `list` 行被重排；集合完全相同、仅顺序不同）。
 *
 *   早先的实现按 `a[i] === b[i]` 逐位比较，于是每次启动都会把 16 条 `list` 行
 *   判成"漂移"并 UPDATE 一次，日志里刷 16 行 warn。危害有两层：
 *     · 表面：每次部署多 16 条无意义写入 + 一片噪声告警；
 *     · 真危害：**狼来了**。一条每次都会报的告警等于没有告警，
 *       它会把真正的漂移（有人把白名单从 33 列改成 7 列）淹掉。
 *
 *   ⚠️ 集合比较**不会**削弱安全断言：探针残留（33 列 → 7 列）是集合层面的差异，
 *   照样被判为漂移并对齐。这里放弃的只是"顺序"这个 NocoBase 自己都不保证的维度。
 */
export function sameFieldSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 角色（NocoBase ACL 侧的落库定义，种子见 seeds/roles.ts）
// ---------------------------------------------------------------------------
/**
 * 角色的中文名（写入 NocoBase `roles.title`，后台角色管理页可见）。
 * roles.title 有唯一约束，四个值必须互不相同。
 */
export const ROLE_TITLE: Record<RoleName, string> = {
  [ROLE.STORE_AFTER_SALES]: '门店售后',
  [ROLE.HQ_AFTER_SALES]: '总部售后',
  [ROLE.HQ_ADMIN]: '总部管理员',
  [ROLE.VIEWER]: '只读管理层',
};

/**
 * 写入 NocoBase ACL 的 strategy.actions（粗粒度）。
 *
 * 只有 view / list / get —— 也就是"能进后台看列表"。
 * 原因（与 docs/API.md §6 一致）：
 *   · 写操作（受理/派工/转店/取消…）一律走 `/api/svc:...`，
 *     由 action 层按 CAPABILITY + 数据范围强制，**不**经原生 update；
 *   · 原生 create/update/destroy 对这四个角色全部关闭，
 *     避免绕过状态机与事件时间线；
 *   · export 不在其中 —— 导出属总部管理员专属能力，
 *     而原生 export 走不到 storeScope 的范围裁剪，放开等于全量泄露。
 *     Phase 6 的导出走自研 `/api/svc/export/tickets`（脱敏 + 写导出事件）。
 */
export const ROLE_ACL_ACTIONS: Record<RoleName, string[]> = {
  [ROLE.STORE_AFTER_SALES]: ['view', 'list', 'get'],
  [ROLE.HQ_AFTER_SALES]: ['view', 'list', 'get'],
  [ROLE.HQ_ADMIN]: ['view', 'list', 'get'],
  [ROLE.VIEWER]: ['view', 'list', 'get'],
};

/** 允许进入 NocoBase 后台配置界面（参数/用户/门店/角色）的角色 */
export const CONFIGURE_ROLES: RoleName[] = [ROLE.HQ_ADMIN];

// ---------------------------------------------------------------------------
// 匿名/公开接口清单（白名单，见 docs/API.md）
// ---------------------------------------------------------------------------
/**
 * 未登录可访问的 action 白名单。
 *
 * 必须与 docs/API.md §0 的「8 个匿名接口」严格一致：每多开一个，
 * 就多一个对外暴露面，故这里集中声明、集中评审。
 * 打开方式见 ServiceTicketPlugin.registerAcl() → app.acl.allow(resource, action)
 * （第三个参数省略即 'public'，NocoBase 会设置 ctx.permission.skip = true）
 */
export const ANONYMOUS_ACTIONS: Array<[resource: string, action: string]> = [
  // 健康检查（运维探针，无业务数据）
  ['svc', SVC_ACTION.HEALTH],
  // 限流额度诊断：ACL 匿名放行，但 handler 校验 X-Svc-Diag-Key（见 SVC_ACTION.GUARD_QUOTA）
  ['svc', SVC_ACTION.GUARD_QUOTA],
  // Phase 3-A：客户 H5 门店下拉（只回 code/name，不回 id/电话/地址）
  [PUBLIC_RESOURCE.STORE, PUBLIC_ACTION.STORE_LIST],
  // Phase 3-B：客户匿名提交报修/投诉（GuardService 四类守卫 + 幂等 + 频控）
  [PUBLIC_RESOURCE.TICKET, PUBLIC_ACTION.TICKET_CREATE],
  // Phase 5/7 起逐步启用（届时本清单随之增长，每一处都必须单独评审）：
  // ['technicianVisit', 'get'],    // GET  /api/technician/visits/:token     师傅打开作业页
  // ['technicianVisit', 'upload'], // POST /api/technician/visits/:token/files 师傅上传照片
  // ['technicianVisit', 'submit'], // POST /api/technician/visits/:token/submit 师傅提交回执
  // ['publicReview', 'get'],       // GET  /api/public/reviews/:token        打开评价页
  // ['publicReview', 'submit'],    // POST /api/public/reviews/:token        提交评价
];

// ---------------------------------------------------------------------------
// Phase 3 守卫（GuardService）
// ---------------------------------------------------------------------------
/**
 * 限流「场景」名。
 *
 * scene 是限流桶的第一维（`api_guards` 唯一索引的第一列），
 * 所以"不同接口共不共用同一个桶"完全由它决定：
 *   · public_ticket —— 提交工单。**必须**叫这个名字：
 *     scripts/verify-concurrency-phase2.mjs 会用 `?scene=public_ticket` 预检额度，
 *     改名会让"发压前确知剩余额度"这道门槛失效。
 *   · public_store  —— 门店下拉。与提交工单**分开计数**：
 *     两者阈值虽同为 `security.ip_minute_limit`，但用途完全不同
 *     （一个进页面前读一次，一个提交一次），共桶会让"打开页面"吃掉提交配额。
 */
export const GUARD_SCENE = {
  PUBLIC_TICKET: 'public_ticket',
  PUBLIC_STORE: 'public_store',
} as const;

/** 限流窗口粒度：按分钟（IP） / 按自然日（手机号） */
export const GUARD_WINDOW = {
  MINUTE: 'minute',
  DAY: 'day',
} as const;

export type GuardWindow = (typeof GUARD_WINDOW)[keyof typeof GUARD_WINDOW];

/**
 * 限流阈值/窗口的**参数键**（取值只从 serviceSettings 读，禁止魔法数）。
 *
 * 只用已有种子键（DEFAULT_SETTINGS 里已存在），不新增配置项 ——
 * 新增键会在已安装实例上产生"库里没有该键"的中间态，
 * 而 seed 是只增不改的（见 DEV-23），运维又要等一次重启。
 */
export const RATE_LIMIT_SETTING_KEY = {
  /** 同一 IP 每分钟匿名请求上限 */
  IP_MINUTE_LIMIT: 'security.ip_minute_limit',
  /** 同一手机号每日提交工单上限 */
  PHONE_DAILY_LIMIT: 'security.ticket_phone_daily_limit',
  /** 重复单判定窗口（分钟）：同手机号 + 同门店 + 同类型 */
  DUPLICATE_WINDOW_MINUTES: 'security.duplicate_window_minutes',
} as const;

/**
 * 诊断接口的共享密钥请求头。
 *
 * 复用一个**已存在**的密钥（SIGN_SECRET）而不是新引入环境变量：
 * 新增变量要同时改 .env / .env.example / verify-config 的交叉一致性检查，
 * 而这里要的只是"证明调用方是运维而不是公网匿名用户"，
 * SIGN_SECRET 恰好已是"服务端独有、不对外下发"的那个值。
 */
export const DIAG_KEY_HEADER = 'x-svc-diag-key';

/**
 * 隐私说明版本号。
 *
 * 客户勾选 `privacy_agreed` 时一并把它写进工单的 `extra_json`，
 * 用于回答"这条工单提交时客户同意的是哪一版说明"——
 * 只记一个布尔值无法应对说明文本本身被修改过的情况。
 * 说明文本变更时必须改这个常量（改后新单记录新版本，旧单仍保留旧值）。
 */
export const PRIVACY_NOTICE_VERSION = '2026-09-20';

// ---------------------------------------------------------------------------
// 可调参数默认值（首次安装写入 serviceSettings，之后在后台改）
// ---------------------------------------------------------------------------
export interface SettingSeed {
  key: string;
  value: string;
  valueType: 'int' | 'bool' | 'string' | 'json';
  description: string;
  /** 对应的环境变量名，用于首次安装时允许用 .env 覆盖默认值 */
  envKey?: string;
}

export const DEFAULT_SETTINGS: SettingSeed[] = [
  // ---- 评价 ----
  {
    key: 'feedback.low_score_threshold',
    value: '2',
    valueType: 'int',
    description: '低评分阈值：评分 ≤ 该值判定为不满意并升级（1–5）',
    envKey: 'SVC_DEFAULT_FEEDBACK_LOW_SCORE_THRESHOLD',
  },
  {
    key: 'feedback.wait_days',
    value: '7',
    valueType: 'int',
    description: '门店确认完成后等待客户评价的天数，超时自动关闭',
    envKey: 'SVC_DEFAULT_FEEDBACK_WAIT_DAYS',
  },
  {
    key: 'feedback.token_expire_days',
    value: '15',
    valueType: 'int',
    description: '评价链接有效期（天）',
    envKey: 'SVC_DEFAULT_FEEDBACK_TOKEN_EXPIRE_DAYS',
  },
  // ---- 师傅 Token ----
  {
    key: 'technician.token_expire_hours',
    value: '72',
    valueType: 'int',
    description: '师傅作业链接有效期（小时）',
    envKey: 'SVC_DEFAULT_TECHNICIAN_TOKEN_EXPIRE_HOURS',
  },
  // ---- SLA ----
  {
    key: 'sla.accept_minutes',
    value: '120',
    valueType: 'int',
    description: '门店受理时效（分钟），超过标记响应超时',
    envKey: 'SVC_DEFAULT_SLA_ACCEPT_MINUTES',
  },
  {
    key: 'sla.appointment_overdue_grace_minutes',
    value: '120',
    valueType: 'int',
    description: '约定上门时间宽限（分钟），超过视为上门超时',
    envKey: 'SVC_DEFAULT_SLA_APPOINTMENT_OVERDUE_GRACE_MINUTES',
  },
  {
    key: 'sla.store_confirm_hours',
    value: '48',
    valueType: 'int',
    description: '门店确认时效（小时），师傅提交后超过则提醒',
    envKey: 'SVC_DEFAULT_SLA_STORE_CONFIRM_HOURS',
  },
  // ---- 短信 ----
  {
    key: 'sms.provider',
    value: 'mock',
    valueType: 'string',
    description: '短信通道：mock / aliyun / tencent',
    envKey: 'SMS_PROVIDER',
  },
  {
    key: 'sms.retry_count',
    value: '1',
    valueType: 'int',
    description: '短信发送失败自动重试次数（文档要求最多 1 次）',
    envKey: 'SMS_RETRY_COUNT',
  },
  // ---- 安全 / 限流 ----
  {
    key: 'security.ip_minute_limit',
    value: '30',
    valueType: 'int',
    description: '同一 IP 每分钟匿名提交上限',
    envKey: 'SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT',
  },
  {
    key: 'security.ticket_phone_daily_limit',
    value: '5',
    valueType: 'int',
    description: '同一手机号每日提交工单上限',
    envKey: 'SVC_DEFAULT_SECURITY_TICKET_PHONE_DAILY_LIMIT',
  },
  {
    key: 'security.duplicate_window_minutes',
    value: '10',
    valueType: 'int',
    description: '重复工单判定窗口（分钟）：同手机号+同门店+同类型',
    envKey: 'SVC_DEFAULT_SECURITY_DUPLICATE_WINDOW_MINUTES',
  },
  {
    key: 'security.technician_token_hourly_limit',
    value: '60',
    valueType: 'int',
    description: '单个师傅 Token 每小时请求上限',
  },
  // ---- 上门照片 ----
  {
    key: 'visit.photo_max_count',
    value: '6',
    valueType: 'int',
    description: '单次上门最多上传照片数',
    envKey: 'UPLOAD_MAX_COUNT',
  },
  {
    key: 'visit.photo_max_size_mb',
    value: '5',
    valueType: 'int',
    description: '单张照片大小上限（MB）',
    envKey: 'UPLOAD_MAX_SIZE_MB',
  },
  // ---- 隐私 ----
  {
    key: 'privacy.retention_months',
    value: '24',
    valueType: 'int',
    description: '工单与照片保留月数，到期归档/清理',
    envKey: 'SVC_DEFAULT_PRIVACY_RETENTION_MONTHS',
  },
];
