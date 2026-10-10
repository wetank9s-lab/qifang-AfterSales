/**
 * `svc:*` 的**动作名**——前后端共用的唯一事实来源（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 为什么必须有这个文件
 * ===========================================================================
 * 在此之前，动作名只存在于 `src/server/constants.ts` 的 `SVC_ACTION` 里。
 * 客户端要用它们拼 `svc:dispatch` 这类 URL，就只能在客户端**再抄一份字符串**。
 *
 * 抄一份的代价在本轮（2026-10-09）当场兑现：`primary-action.tsx` 里手写的
 * `/api/svc:dispatch?filterByTk=…` 与共享层的真实拼法**对不上**（多写了 `/api/`、
 * 且把 `sendSvcRequest` 的 params 对象写成了位置参数）⇒ 五个处理动作
 * **全部静默打到不存在的端点**，工单状态纹丝不动，而构建与结构断言全绿。
 *
 * ⇒ 收敛到本文件：客户端**只能**从这里取名，服务端 `SVC_ACTION` 也从这里取值。
 *   两边对着同一个对象，就不存在"改名只改了一边"这种漂移。
 *
 * ===========================================================================
 * 只放**客户端会调用**的动作
 * ===========================================================================
 * 服务端还有一批仅内部/运维使用的动作（health / live / guardQuota / tokenCheck /
 * smsOutbox / …），它们不该出现在客户端产物里 —— 那等于把探针清单写进公开 JS。
 * 所以这里只列前台业务动作。
 */
export const SVC_ACTION = {
  /** M3 首次派工（自有上门 / 厂家 / 第三方都走它，`service_mode` 区分） */
  DISPATCH: 'dispatch',
  /** M4 改派 */
  REASSIGN: 'reassign',
  /** M5 改约 */
  RESCHEDULE: 'reschedule',
  /** M11 电话 / 门店直接解决 */
  REMOTE_COMPLETE: 'remoteComplete',
  /** 工单转店 */
  TRANSFER: 'transfer',
  /** 客户取消 */
  CANCEL: 'cancel',
  /**
   * 门店**人工新建**服务单（Phase 11 / P11-2）。
   *
   * 🔴 它是**内部**动作：六类工单分类只在后台可选 ——
   *    匿名客户面仍然只有 `repair` / `complaint` 两类白名单
   *    （`PUBLIC_TICKET_TYPE_VALUES`），本动作**不放宽**那条边界。
   */
  CREATE_TICKET: 'createTicket',
  /** 调整已有工单的紧急标记（P11-2）：详情抽屉里的「设为紧急 / 取消紧急」 */
  SET_URGENT: 'setUrgent',
  /** 门店可转入的目标门店选项（只读，受控） */
  TRANSFER_TARGETS: 'transferTargets',
  /** 门店选项（只读，受控） */
  STORE_OPTIONS: 'storeOptions',
  /** 处理人 / 确认人显示名（只读，受控，仅供详情） */
  STAFF_DISPLAY: 'staffDisplay',
  /** PROCESSING 的跟进记录（追加写事件） */
  FOLLOW_UP: 'followUp',
  /** 工单事件时间线（只读） */
  TIMELINE: 'timeline',
} as const;

export type SvcActionName = (typeof SVC_ACTION)[keyof typeof SVC_ACTION];

/** 这些是**写**动作（要带幂等号、要走状态机）；其余是只读 */
export const SVC_WRITE_ACTIONS: readonly SvcActionName[] = [
  // P11-2：门店人工新建（它也是「写」——同样要带 X-Request-Id 走幂等）
  SVC_ACTION.CREATE_TICKET,
  SVC_ACTION.SET_URGENT,
  SVC_ACTION.DISPATCH,
  SVC_ACTION.REASSIGN,
  SVC_ACTION.RESCHEDULE,
  SVC_ACTION.REMOTE_COMPLETE,
  SVC_ACTION.TRANSFER,
  SVC_ACTION.CANCEL,
  SVC_ACTION.FOLLOW_UP,
];
