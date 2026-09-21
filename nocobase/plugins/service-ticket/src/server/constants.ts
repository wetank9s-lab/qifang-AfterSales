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

export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  ASSIGNED: '已派工',
  SUBMITTED: '师傅已提交',
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
