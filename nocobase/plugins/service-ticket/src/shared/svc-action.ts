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
  /**
   * **内部备注**（UX-01A）：往工单时间线追加一条门店内部说明。
   *
   * 🔴 与 `FOLLOW_UP` 是**两个动作**，刻意分开（UX-01A §六 明令）：
   *    · `followUp` 只允许 PROCESSING，且会（可选）改 `next_follow_at`；
   *    · `internalNote` 是**纯追加记录**：不改状态、不重开、不派工、不发短信、
   *      不动 `next_follow_at`、不产生 SLA 待办 —— 任何授权状态的工单都可追加。
   *    放宽 `followUp` 的状态限制去实现它，等于把"记录一次跟进"变成一个能动数据的状态动作。
   */
  INTERNAL_NOTE: 'internalNote',
  /** 工单事件时间线（只读） */
  TIMELINE: 'timeline',
  /**
   * UX-MEDIA-01：**后台查看客户上传的媒体**（只读清单）。
   *
   * 与师傅 H5 的 `customer_media` 是同一批数据，但**不同凭证体系**：
   *   · 师傅端用派工 Token（一次性、按 Visit）；
   *   · 后台用**登录会话 + 门店/角色授权**（不把任何 Token 当后台凭据）。
   * 只回元数据（kind/mime/size/时长/尺寸），**绝不回 storage_key**。
   */
  TICKET_MEDIA: 'ticketMedia',
  /**
   * UX-MEDIA-01：后台读取**单个客户媒体文件**（二进制，支持 Range）。
   *
   * 参数是媒体主键 `id`；授权在 handler 内按「媒体 → 工单 → 门店范围」逐层校验，
   * 越权与不存在统一 404（不给存在性信号）。
   */
  TICKET_MEDIA_FILE: 'ticketMediaFile',
  /** UX-01C：受控读取"可写配置清单"（只读；供设置页渲染 中文名/单位/范围/说明） */
  LIST_SETTING_SPECS: 'listSettingSpecs',
  /** UX-01C：受控写入一个配置项（白名单 + 类型/范围校验 + 并发检测 + 同事务审计） */
  UPDATE_SETTING: 'updateSetting',
  /**
   * UX-01C-R7：读取**单个门店**的可编辑资料（仅 hq_admin）。
   *
   * 为什么不让编辑弹窗直接读原生 `stores:get`：
   *   原生接口的字段集合由 ACL 决定（将来加列会被自动带出），而编辑弹窗需要的
   *   只有 4 个可写字段 + code。走这个受控读模型，字段由代码白名单固定，
   *   也不会把 `sort_order` 这类内部字段带进表单。
   */
  STORE_PROFILE: 'storeProfile',
  /**
   * UX-01C-R7：受控修改门店资料（仅 hq_admin；字段白名单 + 校验 + 乐观并发 + 同事务审计）。
   * `code` **不可写**（签名二维码的输入，改了已印发的码就失效）。
   */
  UPDATE_STORE_PROFILE: 'updateStoreProfile',
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
  // UX-01A：内部备注（同样是「写」——带 X-Request-Id 走幂等，但**不改状态**）
  SVC_ACTION.INTERNAL_NOTE,
  // UX-01C：受控配置写入（带 X-Request-Id；服务端还会校验 hq_admin + 白名单）
  SVC_ACTION.UPDATE_SETTING,
  // UX-01C-R7：门店资料写入（同样带 X-Request-Id 走幂等）
  SVC_ACTION.UPDATE_STORE_PROFILE,
];
