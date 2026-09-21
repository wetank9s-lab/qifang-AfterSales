/**
 * H6 的 **UI 状态矩阵**（纯函数，零依赖）
 *
 * 为什么单独成文件、且不 import 任何 React / NocoBase 模块：
 *   这是四个业务按钮"该不该出现"的唯一事实来源，也是 Phase 4-I 真人走查前
 *   唯一能被自动验证的部分。若它混在 .tsx 里，就只能靠人打开浏览器点一遍 ——
 *   而"NEW 状态下没有受理按钮"这种错误，走查时未必会被点到。
 *   抽成零依赖模块后，scripts/verify-client-logic.mjs 可以对每个状态做断言。
 *
 * ⚠️ 再次强调（复核方原话）：**这只是 UX，不是权限控制。**
 *   按钮隐藏/禁用不能替代鉴权；真正的裁决在服务端
 *   （PermissionService 能力校验 + 对象级校验 + 状态机）。
 *   所以服务端返回 409/422 时，前端必须**原样展示服务端的错误码**，
 *   而不是自己编一句"操作失败"。
 */

/** 四个业务动作（与 /api/svc:<name> 一一对应） */
export const TICKET_ACTION = {
  ACCEPT: 'accept',
  DISPATCH: 'dispatch',
  REASSIGN: 'reassign',
  RESCHEDULE: 'reschedule',
} as const;

export type TicketActionName = (typeof TICKET_ACTION)[keyof typeof TICKET_ACTION];

/** 按钮文案（界面与断言共用一份） */
export const TICKET_ACTION_LABEL: Record<TicketActionName, string> = {
  accept: '受理',
  dispatch: '派工',
  reassign: '改派',
  reschedule: '改约',
};

export interface ActionAvailabilityInput {
  status?: string | null;
  /**
   * 是否已派过工（工单上有 `dispatch_at` 即视为已派）。
   *
   * ⚠️ 客户端**看不到**当前 Visit 的状态（那需要额外请求），
   *    所以这一维是**尽力提示**：误判的代价只是"点了之后服务端说不行"。
   */
  dispatched?: boolean;
}

/**
 * 某状态下应该出现哪些按钮。
 *
 * 矩阵（2026-09-21 复核方给定，按字面实现）：
 *   NEW                                 → 受理、派工
 *   PROCESSING 且尚未派工               → 派工
 *   PROCESSING 且已派工                 → 改派、改约
 *   WAIT_STORE_CONFIRM                  → 不显示（师傅已提交，等门店确认）
 *   WAIT_FEEDBACK / CLOSED / CANCELLED  → 不显示
 *
 * 未登记的状态（含空值）一律返回空数组：**不认识的状态不给出按钮**，
 * 宁可让人去点详情看，也不要摆一个点了必然失败的按钮。
 */
export function availableActionsOf(input: ActionAvailabilityInput): TicketActionName[] {
  const status = input.status ?? '';
  switch (status) {
    case 'NEW':
      return [TICKET_ACTION.ACCEPT, TICKET_ACTION.DISPATCH];
    case 'PROCESSING':
      return input.dispatched
        ? [TICKET_ACTION.REASSIGN, TICKET_ACTION.RESCHEDULE]
        : [TICKET_ACTION.DISPATCH];
    default:
      return [];
  }
}

/** 某动作在当前状态下是否可用（供按钮 disabled 判定） */
export function isActionAvailable(
  input: ActionAvailabilityInput,
  action: TicketActionName,
): boolean {
  return availableActionsOf(input).includes(action);
}
