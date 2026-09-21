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
  SERVICE_MODE_VALUES,
  STORE_CONFIRM_STATUS,
  VISIT_STATUS,
  VISIT_STATUS_TO_CONFIRM_STATUS,
  VISIT_STATUS_VALUES,
  canVisitTransition,
  isMobile,
  type VisitStatus,
} from '../constants';
import type { SequenceService } from './sequence-service';

/** 同一工单内 visit_no 撞唯一约束时的重试次数（取号已原子，撞号理论不发生；留作兜底） */
const DEFAULT_MAX_VISIT_NO_RETRIES = 3;

/** 允许经条件 UPDATE 写入的列（白名单，防列名注入） */
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
]);

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
