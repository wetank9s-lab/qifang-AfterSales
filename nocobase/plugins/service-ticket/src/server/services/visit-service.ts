/**
 * VisitService —— `serviceVisits` 的**唯一**写入入口
 *
 * 模型口径（Phase 4 用户裁定，见 docs/DEVIATIONS.md DEV-38）：
 *
 *   ServiceTicket = 一次客户售后事项
 *   ServiceVisit  = **一次「具体执行责任的派工尝试」**
 *
 * 本服务存在的全部意义，是让下面这句话成为**结构事实**而不是评审纪律：
 *
 *   > **只要执行责任人变化，就产生新的 Visit；旧 Visit 的师傅身份永不修改。**
 *
 * 责任主体的判据 = `technician_mobile` + `provider_name` + `service_mode`
 * （**姓名不在其中** —— 只纠正姓名错别字仍是同一责任人）。
 *
 * 因此本服务**刻意不提供** `updateTechnician()` 这类方法。
 * 想让换人这件事发生，只有一条路：`supersede()` 旧行 + `create()` 新行。
 * "忘了用哪条路"于是不再是一种可能 —— 没有那条路。
 *
 * 三个方法的调用关系（都在调用方的同一个事务里）：
 *   create()      ← dispatch（首次）/ reassign（新建第 N 条）
 *   supersede()   ← reassign（旧行 → SUPERSEDED）/ transfer（转店后原派工作废）
 *   cancelActive()← cancel（工单取消，进行中的派工一并作废）
 *
 * 状态迁移白名单见 constants.ALLOWED_VISIT_TRANSITIONS（§7.1 的唯一路径）。
 */
import {
  ALLOWED_VISIT_TRANSITIONS,
  CONFIRMED_AMOUNT_MAX,
  SERVICE_MODE_VALUES,
  SERVICE_RESULT_LABEL,
  SERVICE_RESULT_VALUES,
  STORE_CONFIRM_STATUS,
  VISIT_STATUS,
  VISIT_STATUS_TO_CONFIRM_STATUS,
  VISIT_STATUS_VALUES,
  canVisitTransition,
  isMobile,
  isServiceNoteRequired,
  type VisitStatus,
} from '../constants';
import type { SequenceService } from './sequence-service';

/** 同一工单内 visit_no 撞唯一约束时的重试次数（取号已原子，撞号理论不发生；留作兜底） */
const DEFAULT_MAX_VISIT_NO_RETRIES = 3;

/**
 * 允许经条件 UPDATE 写入的列（白名单，防列名注入）。
 *
 * ⚠️ 2026-09-23（P5-1）修正：本集合原先**只声明、从未被任何方法使用** ——
 *    所有写入方法都直接写死 SQL 片段。那种状态比没有白名单更糟：
 *    读代码的人以为"写库有列白名单把关"，于是不会去检查
 *    `assignments.push(...)` 里拼进来的东西。同一时期 `ticket-service` 的
 *    同名集合是**真的**在 `conditionalUpdate()` 里逐列断言的。
 *    现在 `submit()` 走 `assertColumnsAllowed()`，两边语义一致：
 *    白名单存在 ⇒ 它必须真的挡在写之前。
 */
const UPDATABLE_COLUMNS = new Set([
  'expected_visit_at',
  'access_token_hash',
  'token_expires_at',
  'token_used_at',
  'token_revoked_at',
  'token_revoked_reason',
  'visit_status',
  'store_confirm_status',
  'superseded_at',
  'superseded_reason',
  'technician_name',
  // ---- P5-1：回执字段（`submit()` 写入，见下）----
  'service_result',
  'service_note',
  'is_charged',
  'reported_charge_amount',
  'submitted_at',
  // ---- P6-1：门店 confirm / reject 写入（见 confirmVisit / rejectVisit）----
  'confirmed_charge_amount',
  'store_confirm_note',
  'store_confirmed_by',
  // ⚠️ 2026-09-25 补：confirmVisit / rejectVisit 都会写 `store_confirmed_at`（"处置时间"），
  //    但漏在白名单里 —— 门禁 C5 第一次真跑就把这条咬了出来（"列不在白名单"→500）。
  //    这正说明"白名单存在 ⇒ 它必须真的挡在写之前"，而不是写代码时顺手记全。
  'store_confirmed_at',
  // ---- Phase 7：客户提交评价时写入的收费核对三态（见 applyCustomerChargeCheck）----
  // ⚠️ 与门店侧的 `confirmed_charge_amount` **不是同一个语义**：
  //    那个是"门店确认收多少"，这三个是"客户说收到的账单是多少 / 一致不一致"。
  //    两者都要保留：`charge_diff_reason` 就是给门店看"差在哪"的那句话。
  'customer_charge_match',
  'customer_reported_amount',
  'charge_diff_reason',
]);

/** 写库前的列白名单断言。**唯一实现点**，别在别的写方法里手写 if */
function assertColumnsAllowed(columns: string[]): void {
  for (const column of columns) {
    if (!UPDATABLE_COLUMNS.has(column)) {
      // 与 ticket-service 的同类断言同一形态：列名由内部构造、绝不来自输入，
      // 因此真触发就是代码 bug，直接抛错而不是回 422。
      throw new Error(`[visit] 列 "${column}" 不在允许更新白名单内（防列名注入）`);
    }
  }
}


export interface CreateVisitInput {
  ticketId: number | string;
  serviceMode: string;
  providerName?: string | null;
  technicianName: string;
  technicianMobile: string;
  /** 预计上门时间（Date 或可被 Date 解析的字符串） */
  expectedVisitAt: Date | string;
  /** 师傅 Token 的 sha256（由 TokenService.mint() 产生，明文不入库） */
  accessTokenHash?: string | null;
  tokenExpiresAt?: Date | string | null;
  /** 被本条取代的那条 Visit（改派时必填；首次派工为空） */
  reassignedFromVisitId?: number | string | null;
  /** 派工时刻；缺省取数据库 now()（测试与回放时可显式传入） */
  assignedAt?: Date | string | null;
}

/**
 * 师傅提交回执的入参（P5-1）。
 *
 * 为什么字段与 `serviceVisits` 的列名**同名**（不是驼峰）：
 *   这一组值会原样进 SQL 的 SET 子句，走 `assertColumnsAllowed()` 的列白名单。
 *   中间加一层驼峰映射，等于让"白名单里的列名"与"调用方看到的字段名"两套并存，
 *   映射写错时表现为**静默写进错误的列**（或漏写），而白名单断言查不出来。
 */
export interface SubmitReceiptInput {
  visitId: number | string;
  /** `SERVICE_RESULT` 枚举值（校验在 action 层做，服务层做枚举与条件必填校验） */
  service_result: string;
  /**
   * 服务说明。**条件必填**：`resolved` 可空，其余结果必填
   * （规则唯一事实来源见 `constants.SERVICE_RESULT_NOTE_OPTIONAL`）。
   * 空说明以 `null` 落库；Phase 6 门店审核要看的就是它。
   */
  service_note: string | null;
  /** 是否收费 */
  is_charged: boolean;
  /** 上报收费金额；`is_charged=false` 时必须为 null（口径见 action 层） */
  reported_charge_amount: number | null;
}

/**
 * P6-1 · I12 门店确认（契约 §11.4-L3：金额由 **Visit 的 `is_charged`** 定夺）。
 *
 * ⚠️ `amount` 的"传 / 不传"本身就是语义，因此类型上是 `number | null | undefined`：
 *    `is_charged=false` 时**传了**就 422（不是静默忽略）；`is_charged=true` 时缺失也 422。
 */
export interface ConfirmVisitInput {
  visitId: number | string;
  /** 确认金额。`is_charged=false` 时必须为 null/undefined，否则 422 AMOUNT_NOT_ALLOWED */
  amount?: number | null;
  /** 改额原因（金额与师傅填报不一致时必填，§3.3） */
  note?: string | null;
  /** 操作者用户 id（落 `store_confirmed_by`） */
  operatorUserId?: number | string | null;
}

/** P6-1 · I13 门店驳回（契约 §11.4-L4：与 Review Token 彻底解耦） */
export interface RejectVisitInput {
  visitId: number | string;
  /** 驳回原因，必填且非空白 */
  reason: string;
  operatorUserId?: number | string | null;
}

/**
 * 客户端收费核对三态（Phase 7 / §5）。
 *
 * 值域由**服务层**判定（`ticket-service.validateChargeCheck`）后才传进来 ——
 * 本方法只负责"把它写进库"，不再重复校验收费事实（事实在 Ticket/Visit 侧，
 * 二次校验会让同一规则有两个实现点）。字段名与列名同名，理由见 `SubmitReceiptInput`。
 */
export interface CustomerChargeCheckInput {
  visitId: number | string;
  /** `CHARGE_MATCH` 枚举值：`match` / `mismatch` / `not_applicable` */
  customer_charge_match: string;
  /** 客户反馈的实际金额；仅 `mismatch` 时有值，其余为 null */
  customer_reported_amount?: number | null;
  /** 差异说明（服务端拼出的可读文本，给门店看"差在哪"） */
  charge_diff_reason?: string | null;
}

export interface VisitServiceOptions {
  sequences: SequenceService;
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void; info?: (msg: string) => void };
  maxVisitNoRetries?: number;
}

/** 业务校验失败（与 ticket-service.ValidationError 同形：自带 code 与 status） */
export class VisitValidationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = 'VisitValidationError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

export class VisitService {
  private readonly db: any;
  private readonly sequences: SequenceService;
  private readonly logger?: VisitServiceOptions['logger'];
  private readonly maxVisitNoRetries: number;

  constructor(db: any, options: VisitServiceOptions) {
    this.db = db;
    this.sequences = options.sequences;
    this.logger = options.logger;
    this.maxVisitNoRetries = options.maxVisitNoRetries ?? DEFAULT_MAX_VISIT_NO_RETRIES;
  }

  // -------------------------------------------------------------------------
  // 新建
  // -------------------------------------------------------------------------

  /**
   * 新建一条 Visit（= 一次新的执行责任）。
   *
   * `visit_no` 在**事务内**取号。为什么不取 `SELECT max(visit_no)+1`：
   *   那是经典的 check-then-act —— 两个门店同事同时改派会读到同一个 max，
   *   各自 +1 得到同一个号。`dailySequences` 的 upsert 是原子的（见 SequenceService），
   *   而 `unique(ticket_id, visit_no)` 是最后一道防线。两者都要有：
   *   前者避免重试，后者保证绝不重复。
   */
  async create(input: CreateVisitInput, transaction?: unknown): Promise<any> {
    const ticketId = toPositiveInt(input.ticketId, 'ticketId');
    const serviceMode = this.assertEnum(input.serviceMode, SERVICE_MODE_VALUES, 'service_mode');
    const technicianName = this.assertText(input.technicianName, 'technician_name', 1, 32);
    const technicianMobile = String(input.technicianMobile ?? '').trim();
    if (!isMobile(technicianMobile)) {
      // 与 TicketService 共用 isMobile（constants 里唯一实现），
      // 避免"派工收了 13800138000，而客户建单拒绝同一个号"这种不一致。
      throw new VisitValidationError('INVALID_TECHNICIAN_MOBILE', '师傅手机号格式不正确');
    }
    const expectedVisitAt = toValidDate(input.expectedVisitAt, 'expected_visit_at');
    const providerName = input.providerName ? String(input.providerName).trim() : null;

    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxVisitNoRetries; attempt += 1) {
      const visitNo = await this.sequences.nextVisitNoValue(ticketId);

      const values: Record<string, unknown> = {
        ticket_id: ticketId,
        visit_no: visitNo,
        // 生命周期起点。**显式写明**而不是依赖列默认值 ——
        // "新建的 Visit 一定是 ASSIGNED"是模型语义，不该藏在 DDL 默认值里。
        visit_status: VISIT_STATUS.ASSIGNED,
        assigned_at: input.assignedAt ? toValidDate(input.assignedAt, 'assigned_at') : new Date(),
        service_mode: serviceMode,
        provider_name: providerName,
        technician_name: technicianName,
        technician_mobile: technicianMobile,
        expected_visit_at: expectedVisitAt,
        // 派生字段：只由 visit_status 推出，禁止两处各写各的
        store_confirm_status: derivedConfirmStatus(VISIT_STATUS.ASSIGNED),
        is_remote: false,
      };

      if (input.accessTokenHash) {
        values.access_token_hash = String(input.accessTokenHash);
      }
      if (input.tokenExpiresAt) {
        values.token_expires_at = toValidDate(input.tokenExpiresAt, 'token_expires_at');
      }
      if (input.reassignedFromVisitId) {
        // ⚠️ 用**外键列名**赋值（与 TicketService.create 的 `store_id` 同一写法）。
        //    这是本插件在真机上验证过的路径；改成关系名 `reassignedFrom` 也能work，
        //    但两处风格不一致会让人以为其中一个是对的、另一个是错的。
        values.reassigned_from_visit_id = toPositiveInt(
          input.reassignedFromVisitId,
          'reassignedFromVisitId',
        );
      }

      try {
        return await this.createRow(values, transaction);
      } catch (error) {
        lastError = error;
        if (isVisitNoConflict(error) && attempt < this.maxVisitNoRetries - 1) {
          this.logger?.warn?.(
            `[visit] ticket=${ticketId} visit_no=${visitNo} 撞唯一约束，重新取号（第 ${attempt + 1} 次）`,
          );
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  private async createRow(values: Record<string, unknown>, transaction?: unknown): Promise<any> {
    const repository = this.db.getRepository('serviceVisits');
    const options: Record<string, unknown> = { values };
    if (transaction) options.transaction = transaction;
    const row = await repository.create(options);
    this.logger?.debug?.(
      `[visit] 新建 visit=${row?.id} ticket=${values.ticket_id} no=${values.visit_no} ` +
        `status=${values.visit_status}`,
    );
    return row;
  }

  // -------------------------------------------------------------------------
  // 作废（旧行原样保留，只改状态与吊销位）
  // -------------------------------------------------------------------------

  /**
   * 把进行中的 Visit 标记为 `SUPERSEDED`（被改派/转店取代）。
   *
   * 三条硬约束：
   *  1) **条件 UPDATE**（`WHERE visit_status = 'ASSIGNED'`）。
   *     返回 null 说明别人先动了手（比如师傅刚提交了回执），
   *     调用方必须抛冲突而不是继续 —— 覆盖一条已提交的 Visit 等于抹掉已发生的服务事实。
   *  2) **只改状态与吊销位，一个快照字段都不碰**。
   *     师傅姓名/手机号/预约时间/照片全部原样留着，这正是"历史不可覆盖"的落地方式。
   *  3) 同一个事务里同时作废 Token。分两步做（先改状态、再吊销）是错的：
   *     中间失败会留下"Visit 已作废但链接还能打开"的状态，
   *     而师傅会按原预约时间真的跑到客户家 —— 见下面的返回值说明。
   *
   * @param opts.code `token_revoked_reason` 的稳定短标识（`reassigned` / `transferred`）。
   *                  **不是**给人看的句子：这一列会被统计与过滤。
   * @param opts.note `superseded_reason`（可读原因，改派时填操作者输入的原因）
   * @returns 更新后的**旧行**（含师傅快照），调用方据此给原师傅发取消短信。
   *          返回 `null` 表示状态不匹配（冲突），调用方应抛 409。
   */
  async supersede(
    visitId: number | string,
    opts: { code: string; note?: string | null },
    transaction?: unknown,
  ): Promise<any | null> {
    return this.transitionToTerminal({
      visitId,
      to: VISIT_STATUS.SUPERSEDED,
      note: opts.note ?? null,
      revokedReason: String(opts.code),
      transaction,
    });
  }

  /** 把进行中的 Visit 标记为 `CANCELLED`（工单取消）。语义与 supersede 完全一致，只是终态不同。 */
  async cancelActive(
    visitId: number | string,
    opts: { code: string; note?: string | null },
    transaction?: unknown,
  ): Promise<any | null> {
    return this.transitionToTerminal({
      visitId,
      to: VISIT_STATUS.CANCELLED,
      note: opts.note ?? null,
      revokedReason: String(opts.code),
      transaction,
    });
  }

  private async transitionToTerminal(params: {
    visitId: number | string;
    to: VisitStatus;
    /** 可读原因（写入 superseded_reason；null 表示无需记录） */
    note: string | null;
    /** 稳定短标识（写入 token_revoked_reason） */
    revokedReason: string;
    transaction?: unknown;
  }): Promise<any | null> {
    const id = toPositiveInt(params.visitId, 'visitId');

    if (!canVisitTransition(VISIT_STATUS.ASSIGNED, params.to)) {
      // 迁移表白名单不认这个目标态：说明调用方写错了方法，不是业务冲突。
      throw new Error(
        `[visit] ASSIGNED 不能迁移到 ${params.to}（允许：${ALLOWED_VISIT_TRANSITIONS[
          VISIT_STATUS.ASSIGNED
        ].join('/')}）`,
      );
    }

    const assignments = [
      'visit_status = $2',
      // 派生字段跟着走一次，由映射表决定，不手写字面量
      'store_confirm_status = $3',
      'updated_at = now()',
      'token_revoked_at = COALESCE(token_revoked_at, now())',
      'token_revoked_reason = COALESCE(token_revoked_reason, $4)',
    ];
    const bind: unknown[] = [
      id,
      params.to,
      derivedConfirmStatus(params.to),
      params.revokedReason,
    ];

    if (params.to === VISIT_STATUS.SUPERSEDED) {
      assignments.push('superseded_at = COALESCE(superseded_at, now())');
      // 没有可读原因时退回用稳定码，保证 superseded_reason 永不为空
      // （后台只读 Visit 表时也要能看到"为什么被取代"）
      bind.push(params.note ?? params.revokedReason);
      assignments.push(`superseded_reason = COALESCE(superseded_reason, $${bind.length})`);
    }

    const [rows] = await this.rawQuery(
      `UPDATE service_visits SET ${assignments.join(', ')} ` +
        `WHERE id = $1 AND visit_status = '${VISIT_STATUS.ASSIGNED}' ` +
        `RETURNING *`,
      bind,
      params.transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      this.logger?.warn?.(
        `[visit] visit=${id} 不处于 ASSIGNED，无法迁移到 ${params.to}（可能已被他人/师傅操作）`,
      );
      return null;
    }

    this.logger?.debug?.(
      `[visit] visit=${id} → ${params.to}（${params.revokedReason}），Token 同步作废`,
    );
    return plain(row);
  }

  // -------------------------------------------------------------------------
  // 改约（不改责任人，只改时间）
  // -------------------------------------------------------------------------

  /**
   * 改约：只改 `expected_visit_at`。
   *
   * **不新建 Visit** —— 执行责任人没变（见 §7.4 的区别表）。
   * 也**不动**任何师傅快照字段：改的是时间，不是人。
   *
   * 同样用条件 UPDATE（仅 ASSIGNED 可改）：师傅已提交回执后再改时间是没有意义的，
   * 那条 Visit 已经进入审核流程（M8→M9/M10）。
   */
  async reschedule(
    visitId: number | string,
    expectedVisitAt: Date | string,
    transaction?: unknown,
  ): Promise<any | null> {
    const id = toPositiveInt(visitId, 'visitId');
    const at = toValidDate(expectedVisitAt, 'expected_visit_at');

    const [rows] = await this.rawQuery(
      `UPDATE service_visits
          SET expected_visit_at = $2, updated_at = now()
        WHERE id = $1 AND visit_status = '${VISIT_STATUS.ASSIGNED}'
        RETURNING *`,
      [id, at],
      transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      this.logger?.warn?.(`[visit] visit=${id} 不处于 ASSIGNED，改约被拒`);
      return null;
    }
    return plain(row);
  }

  // -------------------------------------------------------------------------
  // 提交回执（P5-1：师傅在 H5 上完成一次上门作业）
  // -------------------------------------------------------------------------

  /**
   * `ASSIGNED` → `SUBMITTED`：写入回执并结束本次作业。
   *
   * 三条与 `supersede()` 同源的硬约束：
   *
   *  1) **条件 UPDATE**（`WHERE visit_status = 'ASSIGNED'`）。
   *     返回 `null` = 状态不匹配，调用方**必须**抛冲突而不是继续。
   *     这是"一次性"的物理保证：同一 Visit 不可能提交两次 ——
   *     第二次 UPDATE 影响 0 行。**不要**改成"先 SELECT 判断再 UPDATE"，
   *     那是 check-then-act：两个并发的提交请求会双双通过判断。
   *
   *  2) **必须由调用方提供事务**（本方法自己不 `withTransaction`）。
   *     回执的落账要和 Token 失效、工单状态、事件**同一笔事务**，
   *     否则会出现"Visit 已 SUBMITTED，但 Token 还能用"或
   *     "Visit 已 SUBMITTED，工单还停在 PROCESSING" —— 前者让匿名入口活着，
   *     后者让门店看不到这张单。事务的边界属于**编排层**
   *     （`TicketService.technicianSubmit`），本方法只负责"这一步本身是否有原子性"。
   *
   *  3) `store_confirm_status` 由映射表派生（`STORE_CONFIRM_STATUS.PENDING`）。
   *     `SUBMITTED` 的审核语义就是"待门店处置"，两列不得各自推进。
   *
   * `submitted_at` 用**数据库时钟**（`now()`）：时间戳是审核与时效的基准，
   * 不能取应用进程的钟（多实例/时区/手工改时间都会让它不可信）。
   */
  async submit(input: SubmitReceiptInput, transaction?: unknown): Promise<any | null> {
    const id = toPositiveInt(input.visitId, 'visitId');
    const serviceResult = this.assertEnum(
      input.service_result,
      SERVICE_RESULT_VALUES,
      'service_result',
    );
    // 处理说明：**条件必填**（用户 2026-09-25 拍板）。
    // 服务层**再断一次**而不是只信 action 层 —— 理由同下面的金额口径：
    // 这是"门店审核时能不能看懂发生了什么"的最后一道，将来若加后台补录入口也得过这里。
    // 长度上限不分结果一律生效；空说明以 null 落库。
    const noteText = this.assertText(input.service_note, 'service_note', 0, 500);
    if (isServiceNoteRequired(serviceResult) && noteText.length < 1) {
      throw new VisitValidationError(
        'MISSING_SERVICE_NOTE',
        `处理结果为"${SERVICE_RESULT_LABEL[serviceResult] ?? serviceResult}"时必须填写处理说明`,
      );
    }
    const serviceNote = noteText.length > 0 ? noteText : null;
    const isCharged = input.is_charged === true;

    // 金额口径：不收费时必须为空。**在服务层再断一次**而不是只信 action 层 ——
    // 这条规则决定"门店看到多少钱"，两个入口（将来可能还有后台补录）都要过。
    let amount: number | null = null;
    if (isCharged) {
      const raw = Number(input.reported_charge_amount);
      if (!Number.isFinite(raw) || raw <= 0) {
        throw new VisitValidationError('INVALID_CHARGE_AMOUNT', '已选择收费时必须填写大于 0 的金额');
      }
      // 保留两位小数（金额列是 numeric(12,2)）；不四舍五入到整数，
      // 因为"上门费 30.50"是真实存在的。
      amount = Math.round(raw * 100) / 100;
    }

    const set: Record<string, unknown> = {
      visit_status: VISIT_STATUS.SUBMITTED,
      store_confirm_status: derivedConfirmStatus(VISIT_STATUS.SUBMITTED),
      service_result: serviceResult,
      service_note: serviceNote,
      is_charged: isCharged,
      reported_charge_amount: amount,
      submitted_at: new Date(),
    };

    const columns = Object.keys(set);
    assertColumnsAllowed(columns);

    const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
    const bind: unknown[] = [id, ...columns.map((column) => set[column])];

    const [rows] = await this.rawQuery(
      `UPDATE service_visits SET ${assignments.join(', ')}, updated_at = now() ` +
        `WHERE id = $1 AND visit_status = '${VISIT_STATUS.ASSIGNED}' ` +
        `RETURNING *`,
      bind,
      transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      this.logger?.warn?.(
        `[visit] visit=${id} 不处于 ASSIGNED，提交被拒（可能已提交过、已被改派或已取消）`,
      );
      return null;
    }

    this.logger?.info?.(
      `[visit] visit=${id} → ${VISIT_STATUS.SUBMITTED}（result=${serviceResult} ` +
        `charged=${isCharged}${amount === null ? '' : ` amount=${amount}`}）`,
    );
    return plain(row);
  }

  // -------------------------------------------------------------------------
  // P6-1：门店 confirm / reject（**领域原语**）
  //
  // 这两个方法**只做 Visit 这一侧的条件 UPDATE**。Ticket 侧状态推进、
  // Review Token、事件与幂等由 `ticket-service` 在**同一个事务**里编排。
  // 分开的理由：Visit 的列白名单与状态机归这里，别处不许手写 Visit 的 UPDATE。
  // -------------------------------------------------------------------------

  /**
   * 门店**确认**一次上门回执（I12）。
   *
   * 返回值语义（**契约 §11.4-L1**）：
   *   · 返回行  ⇒ 本次确认生效；
   *   · 返回 **`null`** ⇒ **条件 UPDATE 影响行数 = 0** ⇒ 调用方必须**重读真实状态**
   *     后回 **409**。这是**业务冲突**，**不是**幂等 replay ——
   *     ⚠️ 不得因为"第二个请求恰好也是 confirm"就把它包装成"已经确认 ⇒ 算成功"；
   *     只有**相同幂等键的合法 replay** 才返回首次的原始成功结果。
   *
   * 金额口径（**契约 §11.4-L3**）：由 **Visit 的服务事实**（`is_charged`）定夺，
   * 而不是只验证"请求里带的金额合不合法"：
   *   · `is_charged = false` 却传了 amount ⇒ **422 拒绝**（**不是静默忽略** ——
   *     忽略会让"前端传了但没生效"变成一处**没有任何信号**的静默分歧）；
   *   · `is_charged = true` ⇒ 必填、`> 0`、`≤ CONFIRMED_AMOUNT_MAX`（O4）；
   *   · 与师傅填报不一致 ⇒ 必须填 `note`（§3.3「改额必须留痕」）。
   */
  async confirmVisit(input: ConfirmVisitInput, transaction?: unknown): Promise<any | null> {
    const id = toPositiveInt(input.visitId, 'visitId');
    const visit = await this.findById(id, transaction);
    if (!visit) {
      throw new VisitValidationError('VISIT_NOT_FOUND', '上门记录不存在');
    }

    const isCharged = visit.is_charged === true;
    let amount: number | null = null;

    if (!isCharged) {
      // 服务事实 = 不收费 ⇒ 落 NULL（**不是 0.00**，O4/O5 配套）；偷传金额一律拒绝
      if (input.amount !== null && input.amount !== undefined) {
        throw new VisitValidationError('AMOUNT_NOT_ALLOWED', '师傅填报为「不收费」，确认时不得提交金额');
      }
    } else {
      const raw = Number(input.amount);
      if (input.amount === null || input.amount === undefined || !Number.isFinite(raw)) {
        throw new VisitValidationError('MISSING_CONFIRM_AMOUNT', '师傅填报为「收费」，确认时必须填写金额');
      }
      if (raw <= 0) {
        throw new VisitValidationError('INVALID_CONFIRM_AMOUNT', '确认金额必须大于 0');
      }
      if (raw > CONFIRMED_AMOUNT_MAX) {
        throw new VisitValidationError(
          'CONFIRM_AMOUNT_TOO_LARGE',
          `确认金额不得超过 ${CONFIRMED_AMOUNT_MAX}`,
        );
      }
      amount = Math.round(raw * 100) / 100;
    }

    const reported = visit.reported_charge_amount === null ? null : Number(visit.reported_charge_amount);
    const changed = reported !== null && amount !== null && Math.abs(reported - amount) > 0.004;
    const noteText = typeof input.note === 'string' ? input.note.trim() : '';
    if (changed && noteText.length < 1) {
      // §3.3：改额必须留痕 —— 否则"门店为什么把 300 改成 80"事后无从复盘
      throw new VisitValidationError('MISSING_CONFIRM_NOTE', '调整了金额时必须填写原因');
    }

    const set: Record<string, unknown> = {
      visit_status: VISIT_STATUS.CONFIRMED,
      // 派生字段**必须**经映射表写，禁止两套状态各自推进
      store_confirm_status: derivedConfirmStatus(VISIT_STATUS.CONFIRMED),
      confirmed_charge_amount: amount,
      store_confirm_note: noteText.length > 0 ? noteText : null,
      store_confirmed_by: input.operatorUserId ?? null,
      store_confirmed_at: new Date(),
    };

    const columns = Object.keys(set);
    assertColumnsAllowed(columns);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
    const bind: unknown[] = [id, ...columns.map((column) => set[column])];

    // ⚠️ 并发范式 = **条件 UPDATE + 影响行数**（本项目全仓 0 处行锁，见契约 §1-F1）：
    //    WHERE 把"当前处于待审"钉死，影响行数 0 ⇒ 有人先动了 ⇒ loser。
    const [rows] = await this.rawQuery(
      `UPDATE service_visits SET ${assignments.join(', ')}, updated_at = now() ` +
        `WHERE id = $1 AND visit_status = '${VISIT_STATUS.SUBMITTED}' ` +
        `AND store_confirm_status = '${STORE_CONFIRM_STATUS.PENDING}' ` +
        `RETURNING *`,
      bind,
      transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      this.logger?.warn?.(
        `[visit] visit=${id} 不处于待确认状态，确认未生效（并发冲突 / 已被驳回 / 已被改派）`,
      );
      return null;
    }

    this.logger?.info?.(
      `[visit] visit=${id} → ${VISIT_STATUS.CONFIRMED}` +
        `${amount === null ? '（不收费）' : `（确认金额 ${amount}）`}`,
    );
    return plain(row);
  }

  /**
   * 门店**驳回**一次上门回执（I13）。
   *
   * **契约 §11.4-L4**：reject 与 Review Token **彻底解耦** ——
   * 这里**刻意不碰**任何 `feedback_*` 字段、不生成/刷新 Token、不建评价 SmsLog、
   * 也**不偷偷创建下一条 Visit**（下一次派工仍由正常 `dispatch` 明确触发）。
   * `reopen_count` 的增量同样不在本方法内（由编排方按契约 §8.2 处理：驳回**不增**）。
   *
   * 返回 `null` 的语义与 `confirmVisit` 相同（条件 UPDATE 影响行数 0 ⇒ 业务冲突）。
   */
  async rejectVisit(input: RejectVisitInput, transaction?: unknown): Promise<any | null> {
    const id = toPositiveInt(input.visitId, 'visitId');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 1) {
      throw new VisitValidationError('MISSING_REJECT_REASON', '驳回必须填写原因');
    }

    const set: Record<string, unknown> = {
      visit_status: VISIT_STATUS.REJECTED,
      store_confirm_status: derivedConfirmStatus(VISIT_STATUS.REJECTED),
      // `store_confirmed_at` 语义已泛化为"**处置**时间"（O5：驳回也写，只改注释不改字段）
      store_confirmed_at: new Date(),
      store_confirm_note: reason,
      store_confirmed_by: input.operatorUserId ?? null,
    };

    const columns = Object.keys(set);
    assertColumnsAllowed(columns);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
    const bind: unknown[] = [id, ...columns.map((column) => set[column])];

    const [rows] = await this.rawQuery(
      `UPDATE service_visits SET ${assignments.join(', ')}, updated_at = now() ` +
        `WHERE id = $1 AND visit_status = '${VISIT_STATUS.SUBMITTED}' ` +
        `AND store_confirm_status = '${STORE_CONFIRM_STATUS.PENDING}' ` +
        `RETURNING *`,
      bind,
      transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      this.logger?.warn?.(`[visit] visit=${id} 不处于待确认状态，驳回未生效（并发冲突 / 已被处置）`);
      return null;
    }

    this.logger?.info?.(`[visit] visit=${id} → ${VISIT_STATUS.REJECTED}（原因 ${reason.length} 字）`);
    return plain(row);
  }

  /**
   * 写入**客户端**的收费核对三态（Phase 7 / §5）。
   *
   * ⚠️ 与前两个方法的关键区别：**它不校验 `visit_status`**。
   *    客户提交评价时，这条 Visit 已经是 `CONFIRMED`（门店确认过），
   *    而收费核对是**评价阶段**的信息，不是"处置动作"—— 因此它不该被
   *    "必须处于待审"这个前提卡住。
   *
   * ✅ 但它**带幂等谓词**：`customer_charge_match IS NULL`。
   *    理由（契约 §1.2）：Ticket 侧的 winner 判定与 Visit 侧的写入是两步，
   *    万一有别的路径已经把核对写进去了，这里必须 0 行 ⇒ 抛错回滚，
   *    而不是覆盖别人的结果（"保留原评价事实"是 §6 的硬约束之一）。
   *
   * 返回 `null` = 谓词未命中（调用方据此**回滚整个事务**，见 `submitReview`）。
   */
  async applyCustomerChargeCheck(
    input: CustomerChargeCheckInput,
    transaction?: unknown,
  ): Promise<any | null> {
    const id = toPositiveInt(input.visitId, 'visitId');

    const set: Record<string, unknown> = {
      customer_charge_match: input.customer_charge_match,
      customer_reported_amount: input.customer_reported_amount ?? null,
      charge_diff_reason: input.charge_diff_reason ?? null,
    };

    const columns = Object.keys(set);
    assertColumnsAllowed(columns);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
    const bind: unknown[] = [id, ...columns.map((column) => set[column])];

    const [rows] = await this.rawQuery(
      `UPDATE service_visits SET ${assignments.join(', ')}, updated_at = now() ` +
        `WHERE id = $1 AND customer_charge_match IS NULL ` +
        `RETURNING *`,
      bind,
      transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      this.logger?.warn?.(
        `[visit] visit=${id} 已有收费核对结果，客户评价的核对未写入（并发 / 重复提交）`,
      );
      return null;
    }

    this.logger?.info?.(
      `[visit] visit=${id} 客户收费核对 = ${String(input.customer_charge_match)}` +
        `${input.customer_reported_amount ? `（客户报 ${input.customer_reported_amount}）` : ''}`,
    );
    return plain(row);
  }

  /**
   * 某次上门已上传的照片（按 `sort_order` 正序，同序按 id 稳定排序）。
   *
   * ⚠️ 这里**不返回 `storage_key`**：它是私有目录内的相对路径，
   * 按 `docs/SECURITY.md` §3 的口径"禁止对外输出"。剔除放在**最靠近数据的一层**
   * （而不是等到 action 层再挑字段），因为读取端点是匿名的 ——
   * 一旦有人在 action 层直接 `ok(ctx, rows)`，泄漏就是一次性的、无人察觉的。
   * 内部需要路径的地方（受控读取 handler）自己有 `findPhotoById()`。
   */
  async listPhotos(visitId: number | string, transaction?: unknown): Promise<any[]> {
    const repository = this.db.getRepository('serviceVisitPhotos');
    const options: Record<string, unknown> = {
      filter: { visit_id: toPositiveInt(visitId, 'visitId') },
      sort: ['sort_order', 'id'],
    };
    if (transaction) options.transaction = transaction;
    const rows = (await repository.find(options)) || [];
    return rows.map((row: any) => {
      const plainRow = plain(row);
      delete plainRow.storage_key;
      delete plainRow.upload_ip_hash;
      return plainRow;
    });
  }

  /** 照片张数。上传前判上限用；`count` 不会把行取进内存 */
  async countPhotos(visitId: number | string, transaction?: unknown): Promise<number> {
    const repository = this.db.getRepository('serviceVisitPhotos');
    const options: Record<string, unknown> = {
      filter: { visit_id: toPositiveInt(visitId, 'visitId') },
    };
    if (transaction) options.transaction = transaction;
    return Number(await repository.count(options)) || 0;
  }

  /** 取单张照片的**完整行**（含 `storage_key`）—— 仅供服务端受控读取使用 */
  async findPhotoById(photoId: number | string, transaction?: unknown): Promise<any | null> {
    const repository = this.db.getRepository('serviceVisitPhotos');
    const options: Record<string, unknown> = { filter: { id: toPositiveInt(photoId, 'photoId') } };
    if (transaction) options.transaction = transaction;
    return (await repository.findOne(options)) ?? null;
  }

  // -------------------------------------------------------------------------
  // 查询（只读，不做鉴权 —— 调用方须先过 PermissionService）
  // -------------------------------------------------------------------------

  async findById(visitId: number | string, transaction?: unknown): Promise<any | null> {
    const repository = this.db.getRepository('serviceVisits');
    const options: Record<string, unknown> = { filter: { id: toPositiveInt(visitId, 'visitId') } };
    if (transaction) options.transaction = transaction;
    return (await repository.findOne(options)) ?? null;
  }

  /** 最近一条 Visit（按 visit_no 倒序），不区分状态 —— 后台详情页的默认展示项 */
  async latestByTicket(ticketId: number | string, transaction?: unknown): Promise<any | null> {
    const repository = this.db.getRepository('serviceVisits');
    const options: Record<string, unknown> = {
      filter: { ticket_id: toPositiveInt(ticketId, 'ticketId') },
      sort: ['-visit_no'],
      limit: 1,
    };
    if (transaction) options.transaction = transaction;
    const rows = await repository.find(options);
    return (rows && rows[0]) || null;
  }

  /**
   * 当前**进行中**的派工（`visit_status = ASSIGNED`）。
   *
   * 为什么它是"最多一条"：`create()` 之前总会先 `supersede()` 旧的，
   * 所以同一工单在正常情况下至多一条 ASSIGNED。真出现两条，
   * 说明有人绕过 VisitService 改了库 —— 那时取最新一条继续跑，
   * 并在日志里留下 warn（比直接 500 好：业务能继续，问题可见）。
   */
  async findActiveByTicket(ticketId: number | string, transaction?: unknown): Promise<any | null> {
    const repository = this.db.getRepository('serviceVisits');
    const options: Record<string, unknown> = {
      filter: { ticket_id: toPositiveInt(ticketId, 'ticketId'), visit_status: VISIT_STATUS.ASSIGNED },
      sort: ['-visit_no'],
      limit: 2,
    };
    if (transaction) options.transaction = transaction;
    const rows = (await repository.find(options)) || [];

    if (rows.length > 1) {
      this.logger?.warn?.(
        `[visit] ticket=${ticketId} 存在 ${rows.length} 条 ASSIGNED 的 Visit（期望至多 1 条）——` +
          '说明有代码绕过 VisitService 直接写库；本次取 visit_no 最大的一条',
      );
    }
    return rows[0] ?? null;
  }

  /** 某工单的全部 Visit（按 visit_no 正序），后台"派工历史"区块用 */
  async listByTicket(ticketId: number | string, transaction?: unknown): Promise<any[]> {
    const repository = this.db.getRepository('serviceVisits');
    const options: Record<string, unknown> = {
      filter: { ticket_id: toPositiveInt(ticketId, 'ticketId') },
      sort: ['visit_no'],
    };
    if (transaction) options.transaction = transaction;
    const rows = await repository.find(options);
    return (rows || []).map((row: any) => plain(row));
  }

  /** 统计某工单的 Visit 数（验收脚本断言"改派后历史仍在"时用它，比数全表稳） */
  async countByTicket(ticketId: number | string, visitStatus?: string): Promise<number> {
    const repository = this.db.getRepository('serviceVisits');
    const filter: Record<string, unknown> = { ticket_id: toPositiveInt(ticketId, 'ticketId') };
    if (visitStatus) filter.visit_status = visitStatus;
    return Number(await repository.count({ filter })) || 0;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async rawQuery(
    sqlText: string,
    bind: unknown[],
    transaction?: unknown,
  ): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[visit] db.sequelize.query 不可用');
    }
    const options: Record<string, unknown> = { bind };
    if (transaction) options.transaction = transaction;
    return (await sequelize.query(sqlText, options)) as [unknown, unknown];
  }

  private assertEnum(value: unknown, allowed: readonly string[], field: string): string {
    const text = String(value ?? '').trim();
    if (!allowed.includes(text)) {
      throw new VisitValidationError(
        'INVALID_ENUM',
        `${field} 必须是 ${allowed.join(' / ')} 之一，实际 "${text}"`,
      );
    }
    return text;
  }

  private assertText(value: unknown, field: string, min: number, max: number): string {
    const text = String(value ?? '').trim();
    if (text.length < min) {
      throw new VisitValidationError('MISSING_FIELD', `${field} 不能为空`);
    }
    if (text.length > max) {
      throw new VisitValidationError('FIELD_TOO_LONG', `${field} 不能超过 ${max} 字`);
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * `visit_status` → `store_confirm_status` 的派生。
 *
 * 走的是 constants 里的映射表，**不是**本文件里的 switch ——
 * 这张表还被迁移回填与后台展示引用，任何一处手写映射都会让
 * "两个字段描述同一件事"的承诺失效（见 VISIT_STATUS_TO_CONFIRM_STATUS 注释）。
 */
export function derivedConfirmStatus(visitStatus: string): string {
  const mapped = VISIT_STATUS_TO_CONFIRM_STATUS[visitStatus as VisitStatus];
  if (!mapped) {
    throw new Error(
      `[visit] visit_status "${visitStatus}" 不在映射表内（允许：${VISIT_STATUS_VALUES.join('/')}）`,
    );
  }
  return mapped;
}

/** 断言一个状态确实是合法的 visit_status（供后台/迁移工具与离线校验复用） */
export function assertVisitStatus(value: unknown, field = 'visit_status'): string {
  const text = String(value ?? '').trim();
  if (!VISIT_STATUS_VALUES.includes(text as VisitStatus)) {
    throw new VisitValidationError(
      'INVALID_ENUM',
      `${field} 必须是 ${VISIT_STATUS_VALUES.join(' / ')} 之一，实际 "${text}"`,
    );
  }
  return text;
}

function toValidDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
    throw new VisitValidationError('INVALID_DATETIME', `${field} 不是合法时间`);
  }
  const text = String(value ?? '').trim();
  if (!text) {
    throw new VisitValidationError('MISSING_FIELD', `${field} 不能为空`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new VisitValidationError('INVALID_DATETIME', `${field} 不是合法时间："${text}"`);
  }
  return parsed;
}

function toPositiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new VisitValidationError('INVALID_ID', `${field} 必须是正整数`);
  }
  return num;
}

function plain(row: any): any {
  if (row && typeof row.toJSON === 'function') {
    try {
      return row.toJSON();
    } catch {
      /* 落到下面 */
    }
  }
  if (row && typeof row === 'object' && row.dataValues && typeof row.dataValues === 'object') {
    return { ...row.dataValues };
  }
  return { ...(row as Record<string, unknown>) };
}

/**
 * `unique(ticket_id, visit_no)` 冲突识别。判定逻辑与 ticket-service 完全一致
 * （按 PG 错误 detail 里的**带括号键名**匹配），此处只做列名绑定 ——
 * 不复制实现，直接复用 `isUniqueViolationOn`。
 */
function isVisitNoConflict(error: unknown): boolean {
  const anyError = error as any;
  const original = anyError?.original ?? anyError;
  if ((original?.code ?? anyError?.code) !== '23505') return false;

  const detail = String(original?.detail ?? '');
  const keyed = /Key\s*\(([^)]*)\)/.exec(detail);
  if (keyed) {
    const keys = keyed[1].split(',').map((s) => s.trim());
    return keys.includes('ticket_id') && keys.includes('visit_no');
  }
  const constraint = String(original?.constraint ?? anyError?.constraint ?? '');
  if (!constraint) return false;
  return constraint.includes('ticket_id') && constraint.includes('visit_no');
}
