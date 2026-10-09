/**
 * 门店服务单列表的**行级主动作矩阵**（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 为什么单独一个文件，而不是改 `action-matrix.ts`
 * ===========================================================================
 * `action-matrix.ts` 是 H6 的**能力矩阵**（"某状态下哪些动作在语义上可用"），
 * 它被客户端模型与 `verify-client-logic.mjs` 共同引用，且记录的是**能力**而非**摆放**。
 * 本次变更的性质不同：**摆放**——"列表每行只放一个按钮，且标签随状态变"。
 * 两者混在一个文件里，会让"改了摆放"看起来像"改了能力"（本项目最忌的语义混淆）。
 *
 * ⚠️ 因此这里**只声明"怎么摆"**；真正的裁决仍在服务端
 *    （能力 + 对象级 + 状态机），前端原样展示服务端的 409/422 错误码。
 *
 * ===========================================================================
 * 摆放规则（用户 2026-09-20 冻结）
 * ===========================================================================
 * | 状态 | 主动作 | 点击后 |
 * |---|---|---|
 * | `NEW` | **处理** | 打开「处理」窗口：五种现实处理方式 |
 * | `PROCESSING` | **跟进** | 记录跟进情况（+ 可选下次跟进日期） |
 * | `WAIT_STORE_CONFIRM` | **审核结果** | 确认 / 驳回 |
 * | `WAIT_FEEDBACK` / `CLOSED` / `CANCELLED` | **查看** | 服务详情 |
 *
 * 未登记状态（含空值）**不给主动作**：不认识的状态不摆按钮 ——
 * 宁可让人点行看详情，也不要给一个点了必然失败的按钮。
 */

/** 主动作的**能力类型**：决定点击后打开哪个窗口。 */
export const PRIMARY_ACTION = {
  HANDLE: 'handle',
  FOLLOW: 'follow',
  REVIEW: 'review',
  VIEW: 'view',
} as const;

export type PrimaryActionKind = (typeof PRIMARY_ACTION)[keyof typeof PRIMARY_ACTION];

export interface PrimaryAction {
  kind: PrimaryActionKind;
  /** 按钮文案（界面与门禁断言**共用同一份**，避免"界面改了断言没改"） */
  label: string;
}

/** 状态 → 主动作（**唯一事实来源**；门禁对六种状态逐一断言） */
export function primaryActionOf(status?: string | null): PrimaryAction | null {
  switch (status ?? '') {
    case 'NEW':
      return { kind: PRIMARY_ACTION.HANDLE, label: '处理' };
    case 'PROCESSING':
      return { kind: PRIMARY_ACTION.FOLLOW, label: '跟进' };
    case 'WAIT_STORE_CONFIRM':
      return { kind: PRIMARY_ACTION.REVIEW, label: '审核结果' };
    case 'WAIT_FEEDBACK':
    case 'CLOSED':
    case 'CANCELLED':
      return { kind: PRIMARY_ACTION.VIEW, label: '查看' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 「处理」窗口的五种现实处理方式
// ---------------------------------------------------------------------------

export const HANDLE_CHOICE = {
  INHOUSE: 'inhouse',
  EXTERNAL: 'external',
  REMOTE: 'remote',
  TRANSFER: 'transfer',
  CANCEL: 'cancel',
} as const;

export type HandleChoiceKey = (typeof HANDLE_CHOICE)[keyof typeof HANDLE_CHOICE];

export interface HandleChoice {
  key: HandleChoiceKey;
  label: string;
  /** 一句话说明"什么时候选它" —— 售后同事的决策依据 */
  hint: string;
}

/**
 * 顺序即展示顺序（按现实使用频次排：上门 → 厂家 → 电话 → 转店 → 取消）。
 *
 * 🔴 每一种都必须接通**已实现的真实服务**（用户明令"不能只做界面演示"）：
 *   · 安排上门         → `svc:dispatch`（service_mode=inhouse），必填 师傅姓名/手机/预计上门日期
 *   · 交厂家·第三方     → `svc:dispatch`（manufacturer / third_party），**只需服务商名称**
 *   · 电话·门店直接解决 → `svc:remoteComplete`，必填 处理结果（+说明/是否收费/金额）
 *   · 转给其他门店     → `svc:transfer`，目标门店来自 `svc:transferTargets`，必填 原因
 *   · 客户取消         → `svc:cancel`，必填 原因
 */
export const HANDLE_CHOICES: readonly HandleChoice[] = [
  { key: HANDLE_CHOICE.INHOUSE, label: '安排上门', hint: '自有师傅上门处理' },
  { key: HANDLE_CHOICE.EXTERNAL, label: '交厂家 / 第三方处理', hint: '只填服务商名称即可，不必知道具体师傅' },
  { key: HANDLE_CHOICE.REMOTE, label: '电话 / 门店直接解决', hint: '已电话解决或客户到店当场解决' },
  { key: HANDLE_CHOICE.TRANSFER, label: '转给其他门店', hint: '客户地址不属于本店辖区' },
  { key: HANDLE_CHOICE.CANCEL, label: '客户取消', hint: '客户明确不再需要服务' },
] as const;

// ---------------------------------------------------------------------------
// 界面**不得再出现**的行按钮
// ---------------------------------------------------------------------------

/**
 * 这些动作**不得作为列表行内按钮出现**（用户 2026-09-20 裁定的按钮墙）。
 *
 * ⚠️ 这份清单的用途是**门禁的"必须不存在"断言**：
 *    用户明确要求 —— 验收器不能只把"预期模型数 5"改成"预期模型数 1"，
 *    **还必须验证旧危险动作确实不存在**。
 *
 *   · `accept`（受理）：产品口径已取消 —— 第一次真实处理动作**就是**受理，
 *     不需要先点"受理"再选处理方式（契约 §5.1）；
 *   · `dispatch` / `reassign` / `reschedule`：**仍然存在**，但只在
 *     「处理」窗口或服务详情**内部**操作，不再作为列表行按钮；
 *   · `detail`：行本身可点击进详情，按钮是冗余的第二入口；
 *   · 原生 `view` / `edit` / `delete`：NocoBase 默认动作，是按钮墙的主因。
 */
export const FORBIDDEN_ROW_ACTIONS: readonly string[] = [
  'accept',
  'dispatch',
  'reassign',
  'reschedule',
  'detail',
  'view',
  'edit',
  'delete',
];

/** 对应的自定义模型类名（seed 的 `use` 必须逐字匹配才有意义） */
export const FORBIDDEN_ROW_ACTION_USES: readonly string[] = [
  'TicketAcceptActionModel',
  'TicketDispatchActionModel',
  'TicketReassignActionModel',
  'TicketRescheduleActionModel',
  'TicketDetailActionModel',
];

/** 允许出现在行内的**唯一**模型（每行一个） */
export const PRIMARY_ROW_ACTION_USE = 'TicketPrimaryActionModel';
