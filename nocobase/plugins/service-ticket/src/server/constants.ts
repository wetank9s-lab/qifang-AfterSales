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
/**
 * ⚠️ service_mode 的取值、可派工集合、中文名、provider_name 条件必填规则
 *    **全部来自 `src/shared/service-mode.ts`**（前后端共享的单一事实来源）。
 *
 *    2026-09-21 前，**客户端手写了一份不一样的下拉选项**（`self` / `third_party`），
 *    于是"选自营 → 422 INVALID_ENUM"、"厂家永远写不进库"这类缺陷
 *    只能靠真人点一下才会暴露。现在这里只做 re-export，
 *    服务端其余代码与本文件的使用方都不受影响，但**不可能再有第二份定义**。
 */
import {
  APPOINTMENT_CANONICAL_TIME,
  APPOINTMENT_TIMEZONE_OFFSET,
  DISPATCHABLE_SERVICE_MODES,
  SERVICE_MODE,
  SERVICE_MODE_LABEL,
  SERVICE_MODE_VALUES,
} from '../shared/service-mode';

export {
  SERVICE_MODE,
  SERVICE_MODE_VALUES,
  SERVICE_MODE_LABEL,
  DISPATCHABLE_SERVICE_MODES,
  // 「预计上门日期」的规范化常量：客户端出口用它拼载荷，**服务端入口用它兜底**
  // （两端读同一个值，"同一天"才不会因为入口不同而落到两个时刻）
  APPOINTMENT_CANONICAL_TIME,
  APPOINTMENT_TIMEZONE_OFFSET,
};

export const TICKET_TYPE = {
  REPAIR: 'repair',
  COMPLAINT: 'complaint',
} as const;
export const TICKET_TYPE_VALUES = Object.values(TICKET_TYPE);

/** 工单类型中文名（短信预览文案与事件 summary 拼接用，避免各处各写一遍） */
export const TICKET_TYPE_LABEL: Record<string, string> = {
  [TICKET_TYPE.REPAIR]: '报修',
  [TICKET_TYPE.COMPLAINT]: '投诉',
};

/** 工单来源：扫码 / 链接 / 店员代提 */
export const TICKET_SOURCE = {
  QR: 'qr',
  LINK: 'link',
  STAFF: 'staff',
} as const;
export const TICKET_SOURCE_VALUES = Object.values(TICKET_SOURCE);

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

/**
 * 服务结果的中文标签。**唯一事实来源**（P5-1 新增）。
 *
 * 为什么要提到 constants：这个标签有两个消费方 ——
 *   ① 后台/H5 的下拉选项（`collections/_options.ts` 从这里派生）；
 *   ② 事件摘要（`technician_submit` 的 summary「师傅已提交处理结果：已解决」）。
 * 两处各写一份的后果不是"难看"，而是**同一份数据在时间线上被叫成两个名字**
 * （下拉选"需再次上门"、时间线显示"需回访"），门店审核时对不上。
 */
export const SERVICE_RESULT_LABEL: Record<string, string> = {
  [SERVICE_RESULT.RESOLVED]: '已解决',
  [SERVICE_RESULT.NEED_FOLLOWUP]: '需再次上门',
  [SERVICE_RESULT.UNRESOLVED]: '未解决',
  [SERVICE_RESULT.CUSTOMER_ABSENT]: '客户不在家',
  [SERVICE_RESULT.OTHER]: '其他',
};

/**
 * 「处理说明可以留空」的处理结果 —— **唯一事实来源**（用户 2026-09-25 真人 UAT 后拍板）。
 *
 * 规则：**只有 `resolved` 允许不填说明**；其余结果（含**将来新增的枚举值**）一律必填。
 *
 * ⚠️ 取"**可选**名单"而不是"必填名单"是故意的 —— 失败安全：
 *    新增一个枚举值若忘了登记，默认按 **必填** 处理，而不是悄悄变成"可以不填"。
 *    `isServiceNoteRequired()` 用 `!includes()` 实现这一点，别改成"必填名单"。
 *
 * 为什么 `resolved` 可以留空：结构化结果本身已表达"已解决"，再强迫写一段文字，
 * 容易产出"已处理""完成"这类**无信息量**内容；照片 + 结果已能形成基础服务记录。
 * 为什么其余四种必填：`need_followup` / `unresolved` 必须知道**为什么还没解决**；
 * `customer_absent` 要说明上门时是什么情况；`other` 不写说明，
 * 门店审核时**基本无法理解发生了什么**。
 */
export const SERVICE_RESULT_NOTE_OPTIONAL: readonly string[] = [SERVICE_RESULT.RESOLVED];

/** 处理说明是否必填（未登记在"可留空"名单里的一律必填） */
export function isServiceNoteRequired(serviceResult: string): boolean {
  return !SERVICE_RESULT_NOTE_OPTIONAL.includes(serviceResult);
}

/** 门店确认状态 */
export const STORE_CONFIRM_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
} as const;
export const STORE_CONFIRM_STATUS_VALUES = Object.values(STORE_CONFIRM_STATUS);

/**
 * ServiceVisit 自身的生命周期状态（Phase 4-A 新增）。
 *
 * 为什么要给 Visit 独立的 `visit_status`，而不是继续用 `store_confirm_status`：
 *
 *   模型口径（Phase 4 用户裁定，见 docs/DEV-PLAN.md §Phase 4）：
 *     ServiceTicket = 一次客户售后事项（6 个主状态不变）
 *     ServiceVisit  = **一次「具体执行责任的派工尝试」**
 *
 *   只要执行责任人变化，就**新建一条 Visit**，绝不修改旧 Visit 的师傅字段 ——
 *   于是"改派"这件事本身必须能表达成一种 Visit 状态，而 `store_confirm_status`
 *   （pending/confirmed/rejected）只描述"门店审核回执"这一段，
 *   无法表达"这条派工已被另一条派工取代"。缺了这个状态，改派就只能靠覆盖旧行，
 *   历史必然丢失。
 *
 *   六个值互斥且构成**唯一**生命周期（不再与 store_confirm_status 各自成一套状态机）：
 *
 *     ASSIGNED    ── 已派给师傅，等待上门/提交      （新建 Visit 的初始态）
 *        ├── technicianSubmit → SUBMITTED
 *        ├── reassign         → SUPERSEDED        （被新 Visit 取代，历史保留）
 *        └── cancel           → CANCELLED
 *     SUBMITTED
 *        ├── confirm          → CONFIRMED
 *        └── reject           → REJECTED          （随后由门店开新 Visit 继续处理）
 *
 *   ⚠️ `store_confirm_status` **保留但降级为派生字段**（由 visit_status 同步），
 *      仅为兼容 Phase 2/3 已落库的数据与既有断言。新代码一律以 visit_status 为准。
 *      两者不得各自推进 —— 这是本文件把它们放在一起、并写清映射的原因。
 */
export const VISIT_STATUS = {
  ASSIGNED: 'ASSIGNED',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
  CANCELLED: 'CANCELLED',
} as const;
export const VISIT_STATUS_VALUES = Object.values(VISIT_STATUS);

export type VisitStatus = (typeof VISIT_STATUS)[keyof typeof VISIT_STATUS];

/**
 * Visit 状态的**一线可视文案**。
 *
 * ⚠️ 用的是"**下一步该谁动**"的口径，不是"刚发生了什么"。
 *    `SUBMITTED` 原本写的是「师傅已提交」—— 那是**过去时**，描述师傅做过什么；
 *    而门店同事打开详情要判断的是"**现在轮到我了吗**"。
 *    同一个状态，站在门店视角就是「待门店确认」（Phase 4-I 第二轮走查整改）。
 *
 *    ⚠️ 这条文案会被后台 Visit 列的枚举下拉复用（见 `collections/_options.ts`），
 *    改它会同时改变后台列显示 —— 这正是"单一事实来源"该有的效果。
 */
export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  ASSIGNED: '已派工',
  SUBMITTED: '待门店确认',
  CONFIRMED: '门店已确认',
  REJECTED: '门店已驳回',
  SUPERSEDED: '已被改派取代',
  CANCELLED: '已取消',
};

/**
 * visit_status ←→ store_confirm_status 的**唯一**映射表。
 *
 * 存在的意义：让"两个字段不得各自推进"这条约束有可执行的定义，
 * 而不是靠调用方记得同时改两处。`syncLegacyConfirmStatus()` 与迁移回填都读它。
 */
export const VISIT_STATUS_TO_CONFIRM_STATUS: Record<VisitStatus, string> = {
  [VISIT_STATUS.ASSIGNED]: STORE_CONFIRM_STATUS.PENDING,
  [VISIT_STATUS.SUBMITTED]: STORE_CONFIRM_STATUS.PENDING,
  [VISIT_STATUS.CONFIRMED]: STORE_CONFIRM_STATUS.CONFIRMED,
  [VISIT_STATUS.REJECTED]: STORE_CONFIRM_STATUS.REJECTED,
  // 历史行（被取代/取消）不代表"待审核"，映射成 pending 会让它出现在待办里；
  // 因此这两态沿用其**发生前**的审核语义：未被门店处置过，即 pending。
  // 真正的"这条不再需要处理"由 visit_status 表达，不是 store_confirm_status 的职责。
  [VISIT_STATUS.SUPERSEDED]: STORE_CONFIRM_STATUS.PENDING,
  [VISIT_STATUS.CANCELLED]: STORE_CONFIRM_STATUS.PENDING,
};

/**
 * 允许被 `reassign` 取代的 Visit 状态 —— **唯一**白名单。
 *
 * 只有 ASSIGNED 可以改派。其余状态都被明确禁止，理由各不相同：
 *   · SUBMITTED —— 师傅已上门并提交了照片/结果/收费，覆盖它等于抹掉已发生的服务事实；
 *                  此时只能走"门店确认/驳回"。
 *   · CONFIRMED —— 门店已审核通过，业务流程已继续（评价 Token 已发）。
 *   · REJECTED  —— 已驳回，正确做法是**新建**下一条 Visit，而不是把被驳回的这条改派掉。
 *   · SUPERSEDED / CANCELLED —— 已是历史记录，不可再变。
 */
export const REASSIGNABLE_VISIT_STATUSES: string[] = [VISIT_STATUS.ASSIGNED];

/**
 * Visit 的合法状态迁移 —— 与 §7.1 的迁移图逐条对应，**唯一**路径。
 *
 * 为什么要写成一张表而不是散在各处的 if：
 *   改派这件事有两层效果（旧行 → SUPERSEDED、同时新建一行），
 *   很容易写成"直接 UPDATE 旧行换师傅"——那会静默丢掉历史，
 *   而丢掉的历史**无法事后重建**（没人知道当时是谁上的门）。
 *   把迁移表固化下来之后，"改派"这条路径在代码里就只剩一种实现方式。
 *
 * 终态（CONFIRMED / REJECTED / SUPERSEDED / CANCELLED）没有出边：
 *   · CONFIRMED/REJECTED —— 门店已审核，后续返工应**新建** Visit；
 *   · SUPERSEDED/CANCELLED —— 已是历史记录，任何改动都是篡改。
 */
export const ALLOWED_VISIT_TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  [VISIT_STATUS.ASSIGNED]: [
    VISIT_STATUS.SUBMITTED,
    VISIT_STATUS.SUPERSEDED,
    VISIT_STATUS.CANCELLED,
  ],
  [VISIT_STATUS.SUBMITTED]: [VISIT_STATUS.CONFIRMED, VISIT_STATUS.REJECTED],
  [VISIT_STATUS.CONFIRMED]: [],
  [VISIT_STATUS.REJECTED]: [],
  [VISIT_STATUS.SUPERSEDED]: [],
  [VISIT_STATUS.CANCELLED]: [],
};

/** 判断一次 Visit 状态迁移是否合法（同状态视为"字段变更"，由调用方另作判断） */
export function canVisitTransition(from: string, to: string): boolean {
  return (ALLOWED_VISIT_TRANSITIONS[from as VisitStatus] || []).includes(to as VisitStatus);
}

/** 中国大陆手机号（唯一实现，TicketService 与 VisitService 共用，避免两处漂移） */
export const MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 是否为合法的大陆手机号 */
export function isMobile(value: unknown): boolean {
  return MOBILE_PATTERN.test(String(value ?? '').trim());
}

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

/** 照片类型的中文标签（唯一事实来源；H5 的上传分类选择与后台展示共用） */
export const PHOTO_TYPE_LABEL: Record<string, string> = {
  [PHOTO_TYPE.ONSITE]: '现场',
  [PHOTO_TYPE.COMPLETED]: '完工',
  [PHOTO_TYPE.RECEIPT]: '收费凭证',
  [PHOTO_TYPE.OTHER]: '其他',
};

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
  /**
   * 纯文本纠错（Phase 4 新增）。
   *
   * 场景：师傅姓名录入时写错别字（"王师付" → "王师傅"），而
   * **technician_mobile 与 provider / service_mode 都没变** ——
   * 执行责任主体没有变化，因此**不是**改派，不应新建 Visit。
   *
   * 这类修改必须写事件：Visit 上的快照字段被就地改了，如果时间线没有记录，
   * 事后无法区分"当时就是这个名字"与"后来被谁改过"。
   * 判据见 docs/DEV-PLAN.md §Phase 4：责任主体 = technician_mobile + provider + service_mode，
   * **姓名不在其中**。
   */
  METADATA_CORRECTED: 'metadata_corrected',
} as const;
export const EVENT_TYPE_VALUES = Object.values(EVENT_TYPE);

/**
 * 事件类型的中文名（Phase 4-I 第二轮走查整改）。
 *
 * ⚠️ 为什么必须补这一张表：
 *   在此之前 `_options.ts` 用的是 `plain(EVENT_TYPE_VALUES)` —— label 直接等于
 *   **英文枚举值本身**。于是后台事件列表里显示的是 `accepted` / `reassigned` /
 *   `technician_submitted`，而工单详情抽屉此前也把 `event_type` 原样打在时间线上。
 *   对一线售后人员来说，这等于**让他读代码**。
 *
 *   这张表是**唯一事实来源**：后台枚举下拉、详情抽屉时间线、以后的总部导出
 *   全部读它，不允许任何一处自己再写一份中文。
 *
 * 💡 文案口径：站在**门店同事**的视角写「发生了什么业务动作」，
 *    而不是翻译 enum。例如 `store_rejected` 是「门店已驳回」，
 *    `sms_sent` 是「已通知客户（短信）」—— 后者刻意点明"通知了谁"，
 *    因为门店真正关心的是"客户到底收没收到"。
 */
export const EVENT_TYPE_LABEL: Record<string, string> = {
  [EVENT_TYPE.CREATED]: '客户已报修',
  [EVENT_TYPE.ACCEPTED]: '门店已受理',
  [EVENT_TYPE.TRANSFERRED]: '已转派',
  [EVENT_TYPE.DISPATCHED]: '门店已派工',
  [EVENT_TYPE.RESCHEDULED]: '已调整上门日期',
  [EVENT_TYPE.REASSIGNED]: '门店已改派',
  [EVENT_TYPE.TECHNICIAN_SUBMITTED]: '师傅已提交处理结果',
  [EVENT_TYPE.STORE_CONFIRMED]: '门店已确认',
  [EVENT_TYPE.STORE_REJECTED]: '门店已驳回',
  [EVENT_TYPE.COMPLETED]: '服务已完成',
  [EVENT_TYPE.SMS_SENT]: '已通知客户（短信）',
  [EVENT_TYPE.SMS_FAILED]: '短信通知失败',
  [EVENT_TYPE.REVIEWED]: '客户已评价',
  [EVENT_TYPE.REOPENED]: '工单已重开',
  [EVENT_TYPE.CLOSED]: '工单已闭环',
  [EVENT_TYPE.CANCELLED]: '工单已取消',
  [EVENT_TYPE.METADATA_CORRECTED]: '派工信息已更正',
};

/** 事件操作者身份 */
export const OPERATOR_KIND = {
  CUSTOMER: 'customer',
  TECHNICIAN: 'technician',
  STORE: 'store',
  HQ: 'hq',
  SYSTEM: 'system',
} as const;
export const OPERATOR_KIND_VALUES = Object.values(OPERATOR_KIND);

/**
 * 事件操作者的中文身份（Phase 4-I 第二轮走查整改）。
 *
 * 时间线要回答的第一个问题是「**谁**做的」—— 而 `customer` / `technician` /
 * `store` 这些值对一线同事没有意义。同样只在这里定义一份。
 *
 * ⚠️ 刻意**不**显示具体用户名（`uat_store_a` 这类登录名）：
 *    一线同事要区分的是"客户 / 师傅 / 门店 / 总部 / 系统"这五类身份，
 *    登录名既不解决这个问题，又会把内部账号体系泄露到界面上。
 */
export const OPERATOR_KIND_LABEL: Record<string, string> = {
  [OPERATOR_KIND.CUSTOMER]: '客户',
  [OPERATOR_KIND.TECHNICIAN]: '师傅',
  [OPERATOR_KIND.STORE]: '门店',
  [OPERATOR_KIND.HQ]: '总部',
  [OPERATOR_KIND.SYSTEM]: '系统',
};

/**
 * 短信场景（每个场景对应一个供应商模板）。
 *
 * ⚠️ **收件人不同 = 必须不同 scene**。
 *    客户、师傅、原师傅三者的模板文案、合规提示（退订/署名）都不同，
 *    混用一个 scene 会让"同一模板发两类人"这种错误在代码里看起来完全正常，
 *    直到有人收到读不通的短信才发现。
 *
 * 收件人映射（Phase 4 新增后）：
 *   dispatch_customer                  → 客户（**仅首次派工**）
 *   technician_task                    → **新**师傅（含作业链接；首次与改派共用一套模板）
 *   technician_assignment_cancelled    → **原**师傅（改派 / 取消 / 转店的取消通知）
 *   dispatch_update                    → 客户（改约 / 改派后的信息更新）
 *   review_invite                      → 客户
 *   manual_resend                      → 由门店手工指定，转发上述任一场景
 *
 * ⚠️ 上面这一行曾写成 `technician_assignment`（与 SMS_SCENE 的实际取值不符）。
 *    常量取值是 `technician_task`（模板环境变量后缀 `ALIYUN_SMS_TPL_TECHNICIAN_TASK`
 *    也依赖它），照注释去配模板会配出一个永远匹配不到的名字。
 *    —— 规格与代码不一致时，**以代码为准并改注释**，这是本项目的一贯口径。
 */
export const SMS_SCENE = {
  DISPATCH_CUSTOMER: 'dispatch_customer',
  TECHNICIAN_TASK: 'technician_task',
  /**
   * 原师傅的"任务已取消/已改派"通知（Phase 4 新增）。
   *
   * 为什么必须有它：改派后旧 Token 会立即失效，但**师傅本人不知道**。
   * 只失效 Token 而不通知，王师傅仍可能按原预约时间跑到客户家 ——
   * 系统里"这条任务已经没了"，现场却来了个人，这是最糟的错配。
   * 因此在改派事务里必须同时产生一条发给原师傅的取消短信。
   *
   * 保留 `TECHNICIAN_TASK` 不变是为了兼容已配置的供应商模板；
   * 两者的区别只在**触发时机与收件人**，不在文案结构。
   */
  TECHNICIAN_ASSIGNMENT_CANCELLED: 'technician_assignment_cancelled',
  DISPATCH_UPDATE: 'dispatch_update',
  REVIEW_INVITE: 'review_invite',
  MANUAL_RESEND: 'manual_resend',
} as const;
export const SMS_SCENE_VALUES = Object.values(SMS_SCENE);

/**
 * 短信通道名。**与 smsLogs.provider 的取值域严格一致**（smsLogs 的 uiSchema 也列这三个）。
 *
 * 为什么要有这个常量而不是各处写 'mock' / 'aliyun' 字面量：
 *   ① `smsLogs.unique(provider, biz_id)` 是回执幂等的唯一手段，
 *      只要有一处把 'mock' 写成 'Mock'，同一封短信就会产生两条日志、两次状态变化；
 *   ② 本项目"只允许 mock / aliyun 真实发送，tencent 未实现"这条边界
 *      需要一个可被断言的名字（见 sms-provider.ts 的 createSmsProvider）。
 */
export const SMS_PROVIDER_NAME = {
  MOCK: 'mock',
  ALIYUN: 'aliyun',
  /** 预留：环境变量已留位，但**本版本未实现**（工厂会退化成"响亮失败"，不静默降级） */
  TENCENT: 'tencent',
} as const;
export type SmsProviderName = (typeof SMS_PROVIDER_NAME)[keyof typeof SMS_PROVIDER_NAME];

/**
 * 短信**提交**状态（我们与供应商之间那一步，与"客户收到没有"是两件事）。
 *
 * `pending` 是 Phase 4 新增的第四类，也是本项目唯一一个"已入队但还没发"的状态。
 * 它的存在理由不是好看，而是**事务边界的必然产物**：
 *
 *   派工要发两条短信，但发短信要调外部 HTTP（阿里云），绝不能放进数据库事务里 ——
 *   外部调用可能耗时数秒，会把工单行的锁与连接一直占着；更关键的是，
 *   外部失败**不应该回滚派工**（师傅已经派出去了，这是既成事实）。
 *   于是顺序只能是：事务内落库 → 提交 → 再调供应商。
 *
 *   而这个顺序留了一个缺口：**提交完成到调用供应商之间进程被杀**，短信就永远不发，
 *   且库里连一条记录都没有（事后无从发现，更无从补发）。
 *   解法就是标准的事务性发件箱（transactional outbox）：
 *     ① 事务内写一条 `pending` 的 SmsLog（含 scene / 模板 / 脱敏收件人 / biz_id）；
 *     ② 提交后再发，把状态改成 accepted / rejected / error；
 *     ③ Phase 8 的 `smsRetry` 定时任务额外扫描"停留 pending 超过阈值"的行补发。
 *   `pending` 这个枚举值现在就加进来，是为了 Phase 8 接任务时**不需要再改一次表结构**。
 *
 * ⚠️ `accepted` 只表示"供应商已受理"，**绝不等于送达** ——
 *    送达是 `delivery_status`（pending → delivered/failed），只能由供应商回执更新。
 *    把 accepted 写成 delivered 是本项目明令禁止的一类错误：它会让"客户没收到短信"
 *    这类投诉永远查不出来（报表上全是送达）。
 */
export const SMS_SEND_STATUS = {
  /** 已入队，尚未提交供应商（事务性发件箱标记，Phase 4） */
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  ERROR: 'error',
} as const;
export const SMS_SEND_STATUS_VALUES = Object.values(SMS_SEND_STATUS);

/**
 * 短信收件人**身份**（不是手机号）。
 *
 * 存在的唯一目的：让"客户短信与师傅短信必须是两个独立 scene"从一句评审纪律
 * 变成一处**运行期断言**。`SmsService.send()` 会拿 scene 查本表，
 * 与调用方声明的收件人身份比对，不一致直接抛错。
 *
 * 为什么需要这么一道看起来多余的检查：混用 scene 不会报任何错 ——
 * 供应商只认模板 CODE，模板变量个数对得上就发得出去。于是"用客户模板发给师傅"
 * 在代码里完全正常，直到有师傅收到一条写着"您报修的空调已受理"的短信。
 * 这类缺陷只有真的有人看短信才会发现，所以必须在代码里拦掉。
 */
export const SMS_RECIPIENT_KIND = {
  CUSTOMER: 'customer',
  TECHNICIAN: 'technician',
} as const;
export type SmsRecipientKind = (typeof SMS_RECIPIENT_KIND)[keyof typeof SMS_RECIPIENT_KIND];

/** `manual_resend` 由门店手工指定转发目标，因此豁免收件人身份比对（唯一豁免项） */
export const SMS_RECIPIENT_ANY = 'any';

/**
 * scene → 收件人身份。**与 SMS_SCENE 一一对应，缺项在启动期即报错**
 * （见 sms-service.ts 的 assertSceneTableComplete）。
 */
export const SMS_SCENE_RECIPIENT: Record<string, string> = {
  [SMS_SCENE.DISPATCH_CUSTOMER]: SMS_RECIPIENT_KIND.CUSTOMER,
  [SMS_SCENE.TECHNICIAN_TASK]: SMS_RECIPIENT_KIND.TECHNICIAN,
  [SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED]: SMS_RECIPIENT_KIND.TECHNICIAN,
  [SMS_SCENE.DISPATCH_UPDATE]: SMS_RECIPIENT_KIND.CUSTOMER,
  [SMS_SCENE.REVIEW_INVITE]: SMS_RECIPIENT_KIND.CUSTOMER,
  [SMS_SCENE.MANUAL_RESEND]: SMS_RECIPIENT_ANY,
};

/**
 * scene → 供应商模板的**环境变量后缀**。
 *
 * 完整键名 = `<PROVIDER 前缀> + 后缀`，例：`ALIYUN_SMS_TPL_TECHNICIAN_TASK`。
 * 这些键全部已存在于 `.env.example` 的「6. 短信适配层」段，本表只是把
 * "scene 与模板 CODE 的对应关系"从注释变成可断言的常量。
 *
 * ⚠️ 新增 scene 必须同时：① 加进 SMS_SCENE；② 加进本表；
 *    ③ 在 `.env.example` 与 `.env` 里各加一行模板 CODE（`verify-config` 会比对两文件键集合）。
 *    漏第 ③ 步的表现是"派工成功但短信落 rejected"，不会报错。
 */
export const SMS_TEMPLATE_ENV_SUFFIX: Record<string, string> = {
  [SMS_SCENE.DISPATCH_CUSTOMER]: 'DISPATCH_CUSTOMER',
  [SMS_SCENE.TECHNICIAN_TASK]: 'TECHNICIAN_TASK',
  [SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED]: 'TECHNICIAN_ASSIGNMENT_CANCELLED',
  [SMS_SCENE.DISPATCH_UPDATE]: 'DISPATCH_UPDATE',
  [SMS_SCENE.REVIEW_INVITE]: 'REVIEW_INVITE',
};

/** 供应商 → 模板 CODE 环境变量前缀 */
export const SMS_TEMPLATE_ENV_PREFIX: Record<string, string> = {
  aliyun: 'ALIYUN_SMS_TPL_',
  tencent: 'TENCENT_SMS_TPL_',
};

/**
 * 短信**预览**文案（真实发送时供应商用自己审核过的模板，本表只用于：
 *  ① mock 通道把内容落进内存发件箱，供本地联调/验收取链接；
 *  ② 出错时打日志，让运维一眼看出"这条本该发什么"）。
 *
 * ⚠️ **本表与运营商模板是两处必须人工对齐的文本** —— 这是本项目唯一一处
 *    刻意保留的"双维护点"，因为运营商模板在对方系统里、改不了也读不到。
 *    因此这里只写"结构"（有哪些变量、大致什么语气），
 *    真正的合规文案以运营商审核通过的版本为准。
 *    两者不一致**不会导致程序报错**，所以每次改模板都要在这里同步 —— 已在
 *    docs/DEVIATIONS.md 登记为已知双维护点。
 */
export const SMS_TEMPLATE_TEXT: Record<string, string> = {
  [SMS_SCENE.DISPATCH_CUSTOMER]:
    '【{sign}】您的{label}（{ticket_no}）已由{store}受理，师傅{technician}将于{expected}与您联系上门。',
  [SMS_SCENE.TECHNICIAN_TASK]:
    '【{sign}】{store}派单：{ticket_no} 客户{contact}，预约{expected}。' +
    '作业链接（{hours}小时内有效）：{link}',
  [SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED]:
    '【{sign}】{store}取消派单：{ticket_no}（原定{expected}）已改派他人，请勿上门。',
  [SMS_SCENE.DISPATCH_UPDATE]:
    '【{sign}】您的{label}（{ticket_no}）上门时间已更新为{expected}，师傅{technician}。',
  [SMS_SCENE.REVIEW_INVITE]:
    '【{sign}】您的{label}（{ticket_no}）已处理完成，请点击评价：{link}',
  [SMS_SCENE.MANUAL_RESEND]: '【{sign}】{scene_label}（{ticket_no}）：{raw_text}',
};

/**
 * 供应商模板 CODE 的**占位前缀**。
 *
 * `.env.example` 里模板 CODE 默认留空 —— 这是刻意的（真实 CODE 由运营商下发，
 * 不同账号不同）。但"留空"必须有一个**可断言的表现**，否则谁把
 * `SMS_PROVIDER` 改成 `aliyun` 而没填模板，系统会拿空 CODE 去调供应商，
 * 得到一个语焉不详的失败，或者更糟：被供应商用默认模板发出去。
 *
 * 因此约定：非 mock 通道下，模板 CODE 解析不出（空/缺失）时
 * `SmsService` 不发送，直接落 `rejected` + `error_code=SMS_TEMPLATE_NOT_CONFIGURED`，
 * 并写 `sms_failed` 事件。**宁可通知失败被看见，也不要发错内容。**
 */
export const SMS_TEMPLATE_NOT_CONFIGURED = 'SMS_TEMPLATE_NOT_CONFIGURED';

/** 短信正文预览的软上限（运营商单条普遍 ~500 字，超了要拆分计费） */
export const SMS_PREVIEW_MAX_LENGTH = 500;

/**
 * `confirmed_charge_amount` 的**业务**上限（P6-1 · O4 裁决：¥99,999.99）。
 *
 * 为什么不用列宽（`numeric(12,2)` ⇒ 可到 99,999,999.99）当校验：
 * 多写一个 0 是金额字段最常见的人为错误，而列宽的职责是"存得下"，
 * 不是"这个值合理"。列宽不该被当作业务校验来用。
 */
export const CONFIRMED_AMOUNT_MAX = 99999.99;

/**
 * Phase 7 评价相关的**业务错误码**（对外契约，前后端各写一份即会漂移）。
 *
 * 为什么集中在这里而不是在 handler 里写字面量：
 *   这些码会被 H5（判断分支）、门禁脚本（断言）、以及运维排障三处引用。
 *   一旦某处改成 `REVIEW_EXPIRED` 而另一处写 `REVIEW_TOKEN_EXPIRED`，
 *   表现是"H5 把过期走成了未知错误分支"，而两边各自的测试都是绿的
 *   （与 `REQUEST_ID_HEADER` 收进 `shared/svc-request.ts` 同一个理由）。
 *
 * ⚠️ 语义稳定性（用户明令"语义必须稳定且前后端一致"）：
 *   · `REVIEW_EXPIRED`        —— Token 对应的评价窗口**已过期**（HTTP **410**）
 *   · `REVIEW_ALREADY_SUBMITTED` —— 该 Token **已成功使用过**（HTTP **409**）
 *   · `REVIEW_NOT_AVAILABLE`  —— 其他不可评价态（工单已取消等）（HTTP **409**）
 *   · `REVIEW_NOT_FOUND`      —— 形状非法或 hash 查不到（**同响应**，HTTP **404**）
 *
 * ⚠️ 为什么过期是 **410** 而不是 404：410 Gone 的语义就是"这个东西存在过、现在没了"，
 *    正是"评价窗口关了"。但它**不构成存在性泄露** —— 410 的前提是**Token 形状合法
 *    且 hash 命中了真实行**；形状非法/查不到一律 404，两者不同响应不会被用来
 *    探测"某个 Token 是否存在"（能拿到 410 的人本来就已经持有合法 Token）。
 */
export const REVIEW_ERROR = {
  NOT_FOUND: 'REVIEW_NOT_FOUND',
  EXPIRED: 'REVIEW_EXPIRED',
  ALREADY_SUBMITTED: 'REVIEW_ALREADY_SUBMITTED',
  NOT_AVAILABLE: 'REVIEW_NOT_AVAILABLE',
  /** 收费核对三态被违反（金额规则由服务端独裁，不依赖 H5 显隐） */
  CHARGE_MATCH_NOT_APPLICABLE: 'CHARGE_MATCH_NOT_APPLICABLE',
  CHARGE_MATCH_REQUIRED: 'CHARGE_MATCH_REQUIRED',
  MISSING_CUSTOMER_AMOUNT: 'MISSING_CUSTOMER_AMOUNT',
  AMOUNT_NOT_ALLOWED: 'AMOUNT_NOT_ALLOWED',
  INVALID_CUSTOMER_AMOUNT: 'INVALID_CUSTOMER_AMOUNT',
  /** 评分不在 1–5 */
  INVALID_RATING: 'INVALID_RATING',
  /** 评价内容超长 */
  INVALID_REVIEW_COMMENT: 'INVALID_REVIEW_COMMENT',
  /** body 里出现白名单外的键（**拒绝**，不做"忽略"） */
  UNEXPECTED_FIELD: 'UNEXPECTED_FIELD',
  /** 非对象 body / 缺必填键 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
} as const;

/** 评分取值范围（含端点）。服务端最终权威的不变量之一。 */
export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;

/** 评价内容上限（与 §10 契约一致） */
export const REVIEW_COMMENT_MAX = 500;

/**
 * GET 评价页时对外暴露的**评价状态**（比内部 `REVIEW_STATUS` 多一个语义层）。
 *
 * 为什么不复用 `REVIEW_STATUS` 直接下发：内部枚举只有 `pending/submitted/expired`，
 * 而 H5 需要区分"**已评价**"与"**动作太快、提交中**"这两件对客户体验完全不同的事。
 * 更重要的是：H5 **绝不应该**据内部枚举自己推导业务结论（那是服务端的活），
 * 它只消费 "can_review + 一句状态话术" 就够了。因此这里给出的是**面向展示**的
 * 稳定三态，与内部枚举之间由服务端做映射（唯一定义点：`reviewStateOf()`）。
 */
export const REVIEW_PAGE_STATE = {
  /** 可评价（窗口内、未提交） */
  PENDING: 'pending',
  /** 已评价过 */
  SUBMITTED: 'submitted',
  /** 评价窗口已过期 */
  EXPIRED: 'expired',
} as const;

/**
 * 师傅作业 Token（Phase 4）。
 *
 * 生命周期与失效规则见 docs/STATE-MACHINE.md §5；
 * 生成算法是**唯一**的：`randomBytes(BYTES).toString('base64url')`，入库前 sha256。
 */
export const TECHNICIAN_TOKEN = {
  /** 随机字节数：32 字节 → base64url 43 字符，熵 256 位 */
  BYTES: 32,
  /** 只存哈希，明文只在短信里出现一次 */
  ALGORITHM: 'sha256',
  /** 明文长度（base64url(32B) = 43）。校验时先比长度，避免为格式非法的输入查库 */
  LENGTH: 43,
  /** base64url：A-Z a-z 0-9 - _ */
  PATTERN: /^[A-Za-z0-9_-]{43}$/,
  /** 作业链接路径：`{PUBLIC_BASE_URL}/t/{token}` */
  LINK_PATH: '/t/',
} as const;

/**
 * 师傅作业链接的**两层路径**（Phase 5，方案 A —— 已拍板）。
 *
 * 这套划分的目的**不是**把 URL 缩短几个字符，而是把
 * **对外契约**（短信里那个链接）与**前端部署结构**（H5 挂在哪个路径）解耦。
 *
 * ```
 *   短信长期只认：   {PUBLIC_BASE_URL}/t/{token}        ← 稳定入口（对外契约）
 *                          │ nginx 302（非 301，见下）
 *                          ▼
 *   今天的真实页面： /h5/technician/visit/{token}        ← 内部实现路径，可随时改
 * ```
 *
 * 于是将来把 H5 挪到 `/technician/{token}` 或 `/h5/v2/technician/{token}` 时：
 * 短信模板、已经发出去的链接、`TokenService.LINK_PATH` 与 `mint()` **都不用动** ——
 * 只改 nginx 那一条 302。
 *
 * ⚠️ **必须是 302/307，不能用 301**：301 会被浏览器与中间层**长期缓存**，
 * 而"真实 H5 路由将来可能再调整"正是本方案的出发点 —— 用 301 等于把
 * 一个随时可能变的目标钉死在各家客户端缓存里，且回滚时要等缓存过期。
 *
 * ⚠️ 命名上把 `/t/` 理解为**入口**而不是**文件路径**：它不指向任何静态资源，
 * 只做一次跳转。因此它既不由 H5 的 `base` 生成，也不随 H5 重新构建而改变。
 */
export const TECHNICIAN_LINK = {
  /**
   * 对外稳定短链前缀（短信里出现的就是它）。
   * **派生自** `TECHNICIAN_TOKEN.LINK_PATH` —— 那里才是唯一事实来源。
   * 不各写一份字面量的理由：两处不同值时会出现"短信发的是 A、nginx 只认 B"，
   * 而两边各自的测试都是绿的（`verify-technician-routing.mjs` 另有一条守卫断言）。
   */
  SHORT_PREFIX: TECHNICIAN_TOKEN.LINK_PATH,
  /** H5 侧的真实路由前缀（内部实现路径，可随时调整 —— 改它只需同步 nginx 的 302 目标） */
  H5_PATH_PREFIX: '/h5/technician/visit/',
  /** 短链跳转必须用临时重定向（理由见上） */
  REDIRECT_CODE: 302,
} as const;

/**
 * 评价 Token（Phase 6 · P6-1）。
 *
 * ⚠️ **事实来源必须是它自己** —— 不要因为 `TECHNICIAN_TOKEN` 当前恰好是
 * `randomBytes(32) → base64url 43 字符`，就在实现里沿用那边的常量、或把"43"
 * 硬编码进 `/f/` 的校验。两侧是**两套独立的凭证**，生命周期与失效条件完全不同：
 * 作业 Token 改派/改约即废，**评价 Token 可重新签发**（契约 §7.4，且新旧切换必须原子）。
 *
 *    ⇒ 长度由 `BYTES` **推导**（base64url 无 padding：`ceil(bytes*4/3)`），
 *      `PATTERN` 由长度推导 —— 于是"改了 BYTES 而忘了改长度"这类漂移不可能发生。
 *    ⇒ 若两侧最终取值相同（**当前确实相同**），那是由**门禁证明"当前一致"**
 *      （`docs/PHASE-6-P6-1-CONTRACT.md` §10 的 **C21**），而不是靠人脑推定。
 *
 * ⚠️ **P6-1 只生成、不发送**（**O1-B**，见 `docs/DEVIATIONS.md` **DEV-85**）：
 * confirm 时生成明文 → 库里只存 sha256 → 落 `feedback_token_expires_at`；
 * **不创建任何评价短信 / SmsLog**，也**不实现** `/f/` 的 nginx 路由
 * （契约 §11.3：route + 评价 H5 + 发送开关**三者同时上线**，避免出现"302 到不存在的页面"）。
 */
const REVIEW_TOKEN_BYTES = 32;
/** base64url 无 padding ⇒ `ceil(32*4/3) = 43` */
const REVIEW_TOKEN_LENGTH = Math.ceil((REVIEW_TOKEN_BYTES * 4) / 3);

export const REVIEW_TOKEN = {
  /** 随机字节数：32 字节 = 256 位熵 */
  BYTES: REVIEW_TOKEN_BYTES,
  /** 只存哈希，明文只在链接里出现一次 */
  ALGORITHM: 'sha256',
  /** 明文长度（**由 BYTES 推导**，不手写 43） */
  LENGTH: REVIEW_TOKEN_LENGTH,
  /** base64url：A-Z a-z 0-9 - _（**由 LENGTH 推导**，不手写 43） */
  PATTERN: new RegExp(`^[A-Za-z0-9_-]{${REVIEW_TOKEN_LENGTH}}$`),
  /**
   * 评价入口的对外稳定短链路径：`{PUBLIC_BASE_URL}/f/{token}`。
   * 与 `/t/` 同取"稳定外部短链"原则（302 禁 301 / 严格 shape / 畸形 404 /
   * token URL 不进 access log），但**路由不在 P6-1 实现**，见上。
   */
  LINK_PATH: '/f/',
} as const;

/**
 * 评价 Token 与师傅 Token **当前**是否同形（长度 + 字符集）。
 *
 * 存在的唯一理由：给门禁一个**可断言的对象**（契约 §10 的 C21）——
 * 它证明的是"此刻二者恰好一致"，**不是**"二者永远一致"。
 * 因此任何实现都不许反过来用它去省掉 `REVIEW_TOKEN.*` 的引用。
 */
export const REVIEW_TOKEN_SAME_SHAPE_AS_TECHNICIAN =
  REVIEW_TOKEN.LENGTH === TECHNICIAN_TOKEN.LENGTH &&
  REVIEW_TOKEN.PATTERN.source === TECHNICIAN_TOKEN.PATTERN.source;

/**
 * 师傅作业接口的**资源名**（Phase 5）。
 *
 * 与 `publicStore` / `publicTicket` 同一命名习惯：业务名单数形式，且刻意避开
 * `serviceVisits` 等核心/自有集合名 —— `resourcer.define()` 会**整体替换**同名资源的定义，
 * 且不报任何错（详见 `registerPublicResources` 的注释与 `publicStore` 的由来）。
 *
 * 为什么叫 `technicianVisit` 而不是 `technician`：
 *   ① 资源名一旦叫 `technician`，NocoBase 会把 `/api/technician/visits/xxx` 解析成
 *      resourceName=`technician` + 后续路径段，而不是我们想要的 `/api/<resource>:<action>`；
 *      虽然对外路径由 nginx 重写（见 DEV-18），但**内部名与对外名不一致**会让
 *      "库里/日志里看到的资源名"与"文档里写的接口名"对不上，排查时先要翻译一遍。
 *   ② `technicianVisit` 精确描述了这个资源**就是一张 Visit 的师傅视角投影**。
 */
export const TECHNICIAN_RESOURCE = {
  VISIT: 'technicianVisit',
} as const;

/** 匿名接口上的 action 名（同样必须单段，理由见 `SVC_ACTION` 注释） */
export const TECHNICIAN_ACTION = {
  /** `GET  /api/technician/visits/:token` —— 打开作业页，取最小工单上下文 */
  GET: 'get',
  /** `POST /api/technician/visits/:token/files` —— 上传现场照片 */
  UPLOAD: 'upload',
  /** `POST /api/technician/visits/:token/submit` —— 提交回执 */
  SUBMIT: 'submit',
  /**
   * `GET /api/technician/visits/:token/photos/:ref` —— **受控读取**单张照片。
   *
   * 为什么照片读取也必须走师傅资源而不是复用 NocoBase 的 `/files/`：
   *   `/files/` 是**登录态**受控端点（后台用户按角色取文件），
   *   而师傅永远匿名、凭证是 Token。把它挂进 `/files/` 就需要
   *   "让匿名请求通过登录态校验"，那正是 `docs/SECURITY.md` 明令禁止的做法。
   *   挂在本资源下的另一个好处：它与上传/提交共用同一套
   *   `withTechnicianAuth()` 与同一个 nginx 限流区，安全语义只有一份。
   */
  PHOTO: 'photo',
} as const;


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

/**
 * **内部写动作**的幂等场景（2026-09-21 新增，见 docs/DEVIATIONS.md DEV-58）。
 *
 * 为什么要给六个内部写动作各开一个 scene，而不是共用一个 `svc_write`：
 *   scene 是幂等键的第一维。共用一个的话，同一个 request id 被误用在两个不同动作上
 *   （例如前端某个重试 bug 把"改约"的重放打到了"改派"），
 *   第二个动作会直接**回放成第一个动作的结果** —— 客户端拿到 200，
 *   库里却什么都没做，这是最难查的一类"成功了但没生效"。
 *   分开后，跨动作的误用会落到各自的业务校验上（409/422），而不是静默成功。
 *
 * 幂等键的形状：`${ticketId}:${actorUserId}:${X-Request-Id}`。
 * 为什么要把**操作者**也揉进去（而不是只用工单 + request id）：
 *   idempotency_records 里缓存的是**首次响应体**，它按当时的操作者做过脱敏
 *   （见 PermissionService.maskTicketForActor）。若甲发起的请求能被乙回放，
 *   乙就能拿到一份"甲视角"的响应；反过来也让"同一个人重试"的语义变模糊。
 *   同一个 request id 本来就该属于同一个操作者，这一维不会削弱任何真实场景。
 */
export const INTERNAL_WRITE_SCENE = {
  ACCEPT: 'svc_accept',
  TRANSFER: 'svc_transfer',
  CANCEL: 'svc_cancel',
  DISPATCH: 'svc_dispatch',
  REASSIGN: 'svc_reassign',
  RESCHEDULE: 'svc_reschedule',
  /**
   * 门店确认 / 驳回（Phase 6 · P6-1）。
   *
   * ⚠️ **两个动作必须各有一个 scene**：共用一个的话，同一个 `request id`
   * 被误用在"确认"与"驳回"之间会**静默回放成另一个动作的结果**（DEV-58 的原教训）。
   * 另见契约 O7：幂等键还要**再加一维 `visitId`** —— 防止同一 request id
   * 在**错误的 Visit** 上被静默回放。
   */
  CONFIRM: 'svc_confirm',
  REJECT: 'svc_reject',
} as const;

export const INTERNAL_WRITE_SCENE_VALUES: string[] = Object.values(INTERNAL_WRITE_SCENE);

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

  // ---- Phase 4：派工三动作（M3 / M4 / M5）----
  /** 首次派工：新建 Visit #1 + 签发师傅 Token + 双短信 */
  DISPATCH: 'dispatch',
  /** 改派：旧 Visit → SUPERSEDED（原样保留），新建 Visit + 新 Token + 三条短信 */
  REASSIGN: 'reassign',
  /** 改约：**不新建 Visit**，仅改预约时间并重签 Token + 两条短信 */
  RESCHEDULE: 'reschedule',

  /**
   * 师傅 Token 校验探针（Phase 4，**仅 mock 短信通道可用**）。
   *
   * 存在的理由：Phase 4 的硬门槛之一是「改派后旧 Token 必须立即失效」，
   * 而这条必须能**在 HTTP 层**被证明，不能只在单测里调一下 service 就算数。
   * 但 Phase 4 并不交付师傅端页面（那是 Phase 5），
   * 为一条验收断言提前开一个**匿名资源**又会永久扩大对外暴露面。
   *
   * 因此这里取第三条路：一个**已登录 + 总部特权**的探针 action，
   * 它调用与未来师傅端接口**完全相同**的 `TokenService.verify()`，
   * 并且**只在 `sms.provider = mock` 时存在** —— 一旦切到真实通道，
   * 它自行返回 404（见 actions/svc/dispatch.ts 的 assertMockChannelOnly）。
   *
   * 换句话说：它不是一个"忘了删的调试接口"，而是一个**自带生产环境自毁**
   * 的验收设施。Phase 5 交付 `/api/technician/visits/:token` 后，
   * 本探针仍保留（它验证的是"token 没通过"这一侧，正是匿名接口不该暴露的细节）。
   */
  TOKEN_CHECK: 'tokenCheck',

  /**
   * mock 短信发件箱（Phase 4，**仅 mock 短信通道可用**，总部特权）。
   *
   * 为什么必须有它：师傅作业链接里带着 Token，而 Token 明文**只出现在短信里**
   * （库里只有 sha256）。若没有任何取回通道，本地联调与验收就永远拿不到
   * 那个链接，"师傅打开链接"这条链路无法被真正走一遍，
   * 只能退化成"直接读库里的哈希"——那等于测试自己伪造凭证。
   *
   * 与 TOKEN_CHECK 同一道自毁闸：非 mock 通道下返回 404。
   * 返回体**只含脱敏收件人**，不含明文手机号（内存里保留明文只为断言收件人正确）。
   */
  SMS_OUTBOX: 'smsOutbox',

  /**
   * 某张工单的**派工历史**（Phase 4-H3 工单详情抽屉用）。
   *
   * 为什么单独开一个 action，而不是让前端拿 `serviceVisits` 列表接口自己过滤：
   *
   *   ① 数据范围必须由服务端裁 —— 前端即便老老实实传了 `filter[ticket_id]`，
   *      也只是"自觉"，换成拼 URL 就能拉到别人工单的 Visit。这里走
   *      `assertCanAccessTicket()`：越权与不存在**统一 404**，与项目其余接口同口径。
   *   ② 前端"下载全量再过滤"会把整张表拖到浏览器 —— 师傅手机号、Token 到期
   *      时间这些字段会先落地一次再被丢弃，既浪费又扩大暴露面。
   *   ③ 返回体在这里统一脱敏（去掉 `access_token_hash` 等凭据列），
   *      与 `svc:timeline` 的 `maskTicketForActor` 同一层保障。
   *
   * 只读：不写任何状态，只读角色同样可用（能不能看由数据范围决定）。
   */
  VISITS: 'visits',

  /**
   * 门店审核读模型（Phase 6 · P6-0，`docs/API.md` I11；对外路径 `/api/svc/visits/:id`）。
   *
   * ⚠️ **不能**复用 `VISITS` 这个名字：它已经被"按 ticketId 列该工单派工历史"占用，
   *    语义是"一条工单的 Visit 列表"；而这里是"**按 visitId 取单条 Visit 的审核读模型**"。
   *    两者共用 action 名会导致同名不同义 —— 对外路径仍按 I11 写 `/api/svc/visits/:id`，
   *    由 nginx 重写成 `/api/svc:visitDetail?filterByTk=<visitId>`。
   *
   * 只读，且**只给门店审核需要的字段**：消费 Phase 5 写入的技师回执
   * （service_result / service_note / is_charged / reported_charge_amount / submitted_at）
   * + 照片的**安全展示元数据**（不含 storage_key / file_id / 路径）。
   * 取图另走 `PHOTO`（I14）。授权：`assertCanAccessTicket(visit.ticket_id)`，越权与不存在统一 404。
   */
  VISIT_DETAIL: 'visitDetail',

  /**
   * 私有照片**受控读取**（Phase 6 · P6-0，`docs/API.md` I14；对外路径 `/api/svc/photos/:photoId`）。
   *
   * 为什么必须由应用层新开一个 action，而不是把 `serviceVisitPhotos` 加进原生读取白名单：
   *   · 该表含 `storage_key` / `upload_ip_hash` 等**存储实现信息**，开放原生 `list/get`
   *     就要长期维护字段 denylist，将来新增敏感列还可能出现"能读、只是忘了禁字段"；
   *   · 因此照片**有意不进** `storeScope` / `NATIVE_READ_ALLOWLIST`（`docs/SECURITY.md` §2.3），
   *     只能经 I11 / I14 两个业务端点访问。
   *
   * 鉴权链（固定顺序，见 `actions/svc/visit-review.ts`）：
   *   登录身份 → resolveActor → Photo→Visit→Ticket 归属 → assertCanAccessTicket → 流式返回。
   * **不签发任何签名 URL / 短期凭证**：每次取图都经过当前登录身份（`docs/PHASE-6.md` §4.3a）。
   */
  PHOTO: 'photo',

  /**
   * 门店**确认**回执（Phase 6 · P6-1，`docs/API.md` I12；对外 `POST /api/svc/visits/:id/confirm`）。
   *
   * ⚠️ action 名不得与既有冲突：`visits`（按工单列派工历史）与 `visitDetail`（I11 读模型）
   *    **都已占用** ⇒ 用 `visitConfirm` / `visitReject`（契约 §2.1）。
   *
   * ⚠️ **nginx 重写顺序是硬约束**：`/api/svc/visits/:id/confirm` 与 `/:id/reject` 必须
   *    **排在** `/api/svc/visits/:id`（I11）**之前** —— 否则两段式路径会被单段式规则先吃掉，
   *    confirm/reject 会**静默打到只读的 I11 上**（表现是 405 或奇怪的 200，而不是明显报错）。
   *    契约 §10 的 C2 要求有一条断言/用例专门钉住这个顺序（含反向）。
   */
  /**
   * 门店**确认**回执（P6-1，`docs/API.md` I12；对外 `POST /api/svc/visits/:id/confirm`）。
   *
   * ⚠️ action 名不得与既有冲突：`visits`（按工单列派工历史）与 `visitDetail`（I11 读模型）
   *    **都已占用** ⇒ 用 `visitConfirm` / `visitReject`（契约 §2.1）。
   *
   * ⚠️ **nginx 重写顺序是硬约束**：`/api/svc/visits/:id/confirm` 与 `/:id/reject` 必须
   *    **排在** `/api/svc/visits/:id`（I11）**之前** —— 否则两段式会被单段式规则先吃掉，
   *    confirm/reject 会**静默打到只读的 I11**（表现是 405 或奇怪的 200，不是明显报错）。
   */
  VISIT_CONFIRM: 'visitConfirm',

  /** 门店**驳回**回执（P6-1，`docs/API.md` I13；对外 `POST /api/svc/visits/:id/reject`）。 */
  VISIT_REJECT: 'visitReject',

  /**
   * **C23 故障注入闸门**（验收设施，不是业务接口）。
   *
   * 为什么它是独立 action 而不是给 confirm 加一个请求参数：
   *   后者等于给内部 API 留了一个"人为制造 500 / 强制回滚"的入口 —— 任何人只要
   *   会在请求里多带一个字段就能打挂一次门店确认（契约 **C23b**）。
   *   因此这里与 `guardQuota` 同一形态：**共享密钥闸**（`X-Svc-Diag-Key` == `SIGN_SECRET`），
   *   且它只翻转**进程级**的一个开关；业务请求的参数**一律不认**。
   */
  FAULT_INJECT: 'faultInject',
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
  SVC_ACTION.DISPATCH,
  SVC_ACTION.REASSIGN,
  SVC_ACTION.RESCHEDULE,
  SVC_ACTION.TOKEN_CHECK,
  SVC_ACTION.SMS_OUTBOX,
  SVC_ACTION.VISITS,
  SVC_ACTION.VISIT_DETAIL,
  SVC_ACTION.PHOTO,
  // ---- P6-1：门店 confirm / reject（与 handlers 同批接入）----
  SVC_ACTION.VISIT_CONFIRM,
  SVC_ACTION.VISIT_REJECT,
  /**
   * FAULT_INJECT：**已登录 + 共享密钥**双闸（`acl.allow('svc','faultInject','loggedIn')`
   * + handler 内校验 `X-Svc-Diag-Key` == `SIGN_SECRET`）。
   *
   * ⚠️ 它**刻意不进匿名白名单**（比 guardQuota 严一档）：guardQuota 泄露的只是限流额度，
   *    而这个闸门能人为打挂一次门店确认。
   *
   * ⚠️ 2026-09-25 修过一处"三份说法都不算数"的漂移：本文件旧注释写的是
   *    "像 guardQuota 一样 public+密钥"，`store-review.ts` 写的是"已登录+密钥"，
   *    而它**两个名单都不在** ⇒ 实际只有 root/admin 能调到（普通登录用户 403）。
   *    现按更严的那一档落到名单里，让"能调它"变成一件**被声明过**的事。
   */
  SVC_ACTION.FAULT_INJECT,
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
  /**
   * 匿名**客户评价**资源（Phase 7）。
   *
   * 命名沿用同一习惯（业务名单数 + `public` 前缀，避开 `serviceTickets` 等核心/自有集合名）。
   * 名字取 `publicReview` 而不是 `publicFeedback`：`feedback_*` 是本项目**列名**的那套
   * 前缀（`feedback_token_hash` / `feedback_visit_id`），而对外领域词是"评价"。
   * 两者混用会让"库里看到的资源名"与"文档里的接口名"对不上，排查时要先翻译一遍。
   */
  REVIEW: 'publicReview',
} as const;

/** 匿名接口上的 action 名（同样必须单段，理由见 SVC_ACTION 注释） */
export const PUBLIC_ACTION = {
  STORE_LIST: 'list',
  TICKET_CREATE: 'create',
  /** `GET  /api/public/reviews/:token` —— 打开评价页，取最小上下文（Phase 7） */
  REVIEW_GET: 'get',
  /** `POST /api/public/reviews/:token` —— 提交评价（Phase 7） */
  REVIEW_SUBMIT: 'submit',
  /**
   * `POST /api/public/reviews/_probe/sweep` —— 手动触发一轮「评价超时扫描」（Phase 7 探针）。
   *
   * ⚠️ 它**不是业务接口**，只给门禁/排障用：内部调 `runReviewExpirySweep`，
   *    与 cron 任务 onTick 完全同一条代码路径（否则门禁验证的是自己那份谓词）。
   * ⚠️ 自带自毁闸：短信通道非 mock ⇒ 404（与 `svc:tokenCheck` 同口径）。
   *    它**只回计数**，不回任何客户数据。
   */
  REVIEW_SWEEP_PROBE: 'sweepProbe',
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
 *
 * ⚠️⚠️ `view` 必须在这里 —— 它**不是**可选的美化项（DEV-65，Phase 4-I 走查阻塞项）：
 *   症状：三个 UAT 账号在浏览器里**只看到搜索框与 6 个 Tab 标题，表格整块不渲染**；
 *         `admin` 看同一个页面却一切正常；接口 `serviceTickets:list` 一直 200 且有数据。
 *   根因链（逐层取证，.probe-*.mjs 系列）：
 *     · 页面骨架、Tab、搜索框都在，`document.querySelectorAll('.ant-table').length === 0`；
 *     · 无任何 JS 异常、无 4xx，说明不是渲染崩溃；
 *     · 从 React fiber 读到 `BlockGridModel.subModels.items` 里**两个区块都在**
 *       （FilterFormBlockModel + TableBlockModel），grid 的 `layout.rows` 也有 row2；
 *     · 但两个区块实例的 `hidden` 不同：FilterForm `hidden=false`、**Table `hidden=true`**；
 *     · 前端 `normalizeLayoutFromSource()` 的可见性过滤会把 `hidden===true` 的 item
 *       从格子里剔除，剔除后 row2 变空行 → **整行被删** → 表格消失。
 *   谁把 `hidden` 置成 true 的（客户端 bundle 内 `aclCheck` 动作原文）：
 *     `e.actionName && (a || (e.model.hidden = true, e.model.forbidden = {actionName}, e.exitAll()))`
 *     其中 `a = await e.aclCheck({ resourceName, actionName: 'view', ... })`。
 *     ⇒ **表格区块在用 `view` 做 ACL 探针**，而 FilterForm 不用。
 *   为什么 `view` 判不过：本常量此前只有 `['list','get']`，于是资源级授权里
 *     压根没有 `serviceTickets:view` 这一行；NocoBase 的两级判定**两级都要过**，
 *     ① strategy.actions 里写了 `view` 也无济于事（见 ROLE_ACL_ACTIONS）。
 *   反证（已验证，非推断）：手工向 `dataSourcesRolesResourcesActions` 插入
 *     `(store_after_sales, serviceTickets, view, <与 list 同白名单>)` 并重启应用后，
 *     同一会话的 `roles:check` 从 8 个键变成含 `serviceTickets:view` 的 9 个键，
 *     浏览器里 `tables: 1 / rows: 4`，表格与数据全部出现。
 *   为什么 `view` 不放宽任何写权限：`view` 是**原生只读动作**（详情弹窗/查看按钮用），
 *     与 `list`/`get` 同级，仍在"只读 action"语义内；`fields` 白名单逐 action 存，
 *     所以 `view` 同样带上那份排除敏感列的列白名单，不会多暴露一列。
 *     它**不在** create/update/destroy/export/move 之列，故不违反 DEV-22。
 */
export const ROLE_NATIVE_READ_ACTIONS: string[] = ['view', 'list', 'get'];

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
  // Phase 5（P5-0）：师傅作业接口。**三条都是匿名**，因为师傅永远不登录 ——
  // Token 本身就是访问该条 Visit 的认证凭证（见 TECHNICIAN_RESOURCE 注释与 docs/SECURITY.md）。
  // ACL 只做到"这一步不用登录"，**真正的鉴权在 handler 里**：
  // 每个 handler 第一步都调 `authenticateTechnician()`，失败一律 401 TOKEN_INVALID。
  //
  // ⚠️ 与 `svc:guardQuota` 同一模式（ACL 匿名 + handler 自守），但**风险等级更高**：
  //    guardQuota 泄露的只是"限流额度"，这三条能读到工单内容、能写 Visit。
  //    因此每加一条都必须单独评审，并同步 `verify-plugin-load.mjs` 的匿名白名单枚举断言。
  [TECHNICIAN_RESOURCE.VISIT, TECHNICIAN_ACTION.GET],
  [TECHNICIAN_RESOURCE.VISIT, TECHNICIAN_ACTION.UPLOAD],
  [TECHNICIAN_RESOURCE.VISIT, TECHNICIAN_ACTION.SUBMIT],
  // 受控读取单张照片（P5-1）。同样先过 handler 里的 Token 认证 +
  // "照片属于该 Visit"的属主校验 —— 匿名 ACL 只说明"这一步不用登录"。
  [TECHNICIAN_RESOURCE.VISIT, TECHNICIAN_ACTION.PHOTO],
  // ---- Phase 7：客户评价（两条都是匿名，Token 即凭证） ----
  // ⚠️ 与师傅接口同模式（ACL 匿名 + handler 自守），但**读写的敏感面不同**：
  //    · GET 只能拿到**最小上下文**（单号 / 门店名 / 事项摘要 / 收费事实），
  //      不返回 id、手机号、Token hash、事件 —— 见 `actions/public/review.ts` 的 DTO；
  //    · POST 会**真的改核心状态**（CLOSED / reopen），因此它的真正闸门是
  //      §1.1 的条件更新（`WAIT_FEEDBACK + review_status='pending'`），
  //      而不是 ACL。
  //    每加一条都必须单独评审，并同步 `verify-plugin-load.mjs` 的匿名白名单枚举断言。
  [PUBLIC_RESOURCE.REVIEW, PUBLIC_ACTION.REVIEW_GET],
  [PUBLIC_RESOURCE.REVIEW, PUBLIC_ACTION.REVIEW_SUBMIT],
  // Phase 7 探针（非业务接口，自毁闸见 PUBLIC_ACTION.REVIEW_SWEEP_PROBE）
  [PUBLIC_RESOURCE.REVIEW, PUBLIC_ACTION.REVIEW_SWEEP_PROBE],
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
  // ---- Phase 5（P5-1）师傅作业接口 ----
  // ⚠️ 与客户侧**分开计桶**（scene 是限流桶的第一维）。合成一个桶的后果是
  //    "某个门店的客户报修量把师傅的上传额度挤掉"，而两类流量的正常量级
  //    完全不同（客户侧日级、师傅侧分钟级），混在一起阈值无法定。
  TECHNICIAN_UPLOAD: 'technician_upload',
  TECHNICIAN_SUBMIT: 'technician_submit',
  // ---- Phase 7 客户评价接口 ----
  // ⚠️ 与上面四者**各自分开计桶**，理由同上，且这里多一层：
  //    评价 Token 是**一次性**凭证，一个 Token 的生命周期内 GET 可能只调 1~2 次。
  //    与 `public_ticket` 共桶会让"客户打开评价页"吃掉"另一个客户提交报修"的配额
  //    （两者阈值同为 `security.ip_minute_limit`，但用途与正常量级完全不同）。
  //    读（GET 渲染页面）与写（POST 提交评价）也分开：读便宜、写贵，
  //    共桶会让刷页面把提交额度耗掉。
  REVIEW_VIEW: 'review_view',
  REVIEW_SUBMIT: 'review_submit',
} as const;

/**
 * 限流窗口粒度。
 *
 * `HOUR` 是 P5-1 新增的：师傅侧的上限语义天然是"每小时"——
 * `security.technician_token_hourly_limit`（默认 60）从 Phase 4 播种起就叫这个名字。
 * 用日窗口会把 60 次铺满一整天（师傅现场连续传 6 张照片可能就被挡），
 * 用分钟窗口则失去"防长时间刷"的意义。
 */
export const GUARD_WINDOW = {
  MINUTE: 'minute',
  HOUR: 'hour',
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
 * 师傅端（Phase 5）用到的参数键。
 *
 * 为什么要提成常量：这三个键原先只以**字符串字面量**出现在 `DEFAULT_SETTINGS` 里，
 * 而 Phase 5 的 `GET /api/technician/visits/:token` 要**回显**其中两个
 * （`max_photos` / `max_photo_size_mb`）让页面知道还能传几张、单张多大。
 * 一旦 handler 里手抄一遍字符串，就会出现"播种的键改了、handler 还在读旧键"——
 * 表现是接口**一直回退到兜底值**，不报错、也不影响其它功能，
 * 只是限值悄悄与后台配置脱钩。故此处提为常量，播种与读取共用同一份。
 *
 * ⚠️ 键名本身**不得更改**（`DEFAULT_SETTINGS` 是 afterLoad **只增不改**的种子，
 *    改键名等于让已有部署读不到旧值）。这里只是把字面量提出来复用。
 */
export const TECHNICIAN_SETTING_KEY = {
  /** 单次上门最多上传照片数（默认 6） */
  PHOTO_MAX_COUNT: 'visit.photo_max_count',
  /** 单张照片大小上限 MB（默认 5） */
  PHOTO_MAX_SIZE_MB: 'visit.photo_max_size_mb',
  /** 单个师傅 Token 每小时请求上限（默认 60；Phase 5 的 token 维度频控用它） */
  TOKEN_HOURLY_LIMIT: 'security.technician_token_hourly_limit',
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
    /**
     * 短信**就绪开关**（Phase 4 新增）。
     *
     * 为什么它必须是一个参数、而不是"有 provider 就发"：
     *   供应商账号/签名/模板的审批是**站外**流程，代码上线时它往往还没批下来。
     *   此时若照发，会得到一批语焉不详的失败，且每次派工都试一次。
     *   显式关掉后，SmsLog 一律记 `rejected` + `error_code=SMS_DISABLED`：
     *   业务照常推进（派工是既成事实），**通知缺失被如实记录并可一眼查出**。
     *
     * ⚠️ 默认 `false` 是刻意的安全默认值：新装实例在没人配置之前不会尝试真实发送。
     *    本地联调要看到 mock 发件箱（`/api/svc:smsOutbox`）必须显式设为 true。
     */
    key: 'sms.enabled',
    value: 'false',
    valueType: 'bool',
    description: '短信通道就绪开关：false 时短信一律记为 rejected（业务不失败）',
    envKey: 'SMS_ENABLED',
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
    key: TECHNICIAN_SETTING_KEY.TOKEN_HOURLY_LIMIT,
    value: '60',
    valueType: 'int',
    description: '单个师傅 Token 每小时请求上限',
  },
  // ---- 上门照片 ----
  {
    key: TECHNICIAN_SETTING_KEY.PHOTO_MAX_COUNT,
    value: '6',
    valueType: 'int',
    description: '单次上门最多上传照片数',
    envKey: 'UPLOAD_MAX_COUNT',
  },
  {
    key: TECHNICIAN_SETTING_KEY.PHOTO_MAX_SIZE_MB,
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
