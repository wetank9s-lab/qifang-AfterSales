/**
 * TicketService —— 工单状态的**唯一**写入入口（docs/STATE-MACHINE.md）
 *
 * Phase 2 实现 4 个动作（M1 / M2 / M6 / M7）：
 *   create   M1  — → NEW
 *   accept   M2  NEW → PROCESSING
 *   transfer M6  NEW/PROCESSING → **状态不变**（只改 store_id）
 *   cancel   M7  NEW/PROCESSING → CANCELLED
 * 其余动作（dispatch/reassign/reschedule/technicianSubmit/confirm/reject/
 * remoteComplete/review/autoClose/hqReopen）分别属于 Phase 4–7，接口位置已预留。
 *
 * 三条不能妥协的设计：
 *
 * 1) **乐观并发用"条件 UPDATE + 影响行数为 0 即冲突"**（文档 §4）。
 *    不先 SELECT 再判断状态再 UPDATE —— 那是 check-then-act 竞态：
 *    两个门店同事同时点"受理"，都会读到 NEW，都会通过校验，然后都写。
 *    正确做法是把状态条件写进 WHERE，让数据库替我们做互斥：
 *      UPDATE ... SET status='PROCESSING' WHERE id=$1 AND status='NEW'
 *    返回 0 行就说明别人先动了手，抛 CONFLICT_STATE_CHANGED，**不产生第二条短信/事件**。
 *
 * 2) **状态与事件必须在同一个事务里**。
 *    否则会出现"状态变了但没有事件"（审计断链）或"有事件但状态没变"（时间线说谎）。
 *    两者任一都比"操作失败"更糟 —— 失败可以重试，脏数据无法自动修复。
 *
 * 3) **不在本服务里做权限判断**（改由 PermissionService 在调用前完成）。
 *    原因：本服务会被系统侧调用（定时任务、短信回调），那里没有"用户"。
 *    把鉴权混进来会让这两种调用的边界变得含糊。
 */
import {
  CLOSE_REASON,
  EVENT_TYPE,
  OPERATOR_KIND,
  TICKET_SOURCE,
  TICKET_SOURCE_VALUES,
  TICKET_STATUS,
  TICKET_TYPE_VALUES,
  canTransition,
} from '../constants';
import type { EventService } from './event-service';
import type { SequenceService } from './sequence-service';

/** 允许出现在条件 UPDATE 的 SET 子句里的列（白名单，防列名注入） */
const UPDATABLE_COLUMNS = new Set([
  'status',
  'handler_user_id',
  'first_response_at',
  'store_id',
  'source_store_code',
  'service_mode',
  'provider_name',
  'technician_name',
  'technician_mobile',
  'customer_mobile',
  'expected_visit_at',
  'dispatch_at',
  'completion_result',
  'completion_note',
  'completed_at',
  'close_reason',
  'closed_at',
  'escalated',
  'reopen_count',
  'review_status',
]);

/** 允许转移工单的来源状态（M6：只有 NEW / PROCESSING 可以转店） */
const TRANSFERABLE_STATUSES = [TICKET_STATUS.NEW, TICKET_STATUS.PROCESSING];
/** 允许取消的来源状态（M7） */
const CANCELLABLE_STATUSES = [TICKET_STATUS.NEW, TICKET_STATUS.PROCESSING];

/** 内容长度（M1 前置校验） */
const CONTENT_MIN = 5;
const CONTENT_MAX = 500;
/** 中国大陆手机号 */
const MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 状态竞争：调用方应把它映射为 HTTP 409 */
export class StateConflictError extends Error {
  readonly code = 'CONFLICT_STATE_CHANGED';
  /**
   * 自带 HTTP 状态码，口径与 actions/svc/_http.ts 的 statusOf 一致。
   * 原因：中间件层（storeScope）抛出的错误不经过 action 层的映射表，
   * 会直接落到 NocoBase 的全局错误处理器，那里只看 `error.status`。
   * 不带这个字段时越权/冲突会被报成 500（真机实测过），
   * 既违反 docs/API.md §0，也让"app 日志无 error"的运维断言产生噪声。
   */
  readonly status = 409;
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'StateConflictError';
  }
}

/** 业务校验失败：映射为 HTTP 422（`NOT_FOUND` 除外，见 _http.statusOf） */
export class ValidationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    // NOT_FOUND 是 ValidationError 里唯一的 404（transfer 内部按 ID 找不到工单），
    // 与 actions/svc/_http.ts 的 statusOf 保持同一口径。
    this.status = code === 'NOT_FOUND' ? 404 : 422;
    this.statusCode = this.status;
  }
}

export interface CreateTicketInput {
  /** 门店 ID（与 storeCode 二选一） */
  storeId?: number | string;
  /** 门店业务编码（如 S01），H5 扫码入口带的就是它 */
  storeCode?: string;
  ticketType: string;
  content: string;
  customerName?: string | null;
  customerMobile: string;
  source?: string;
  /** 操作者：客户匿名提交时为 null */
  operatorUserId?: number | string | null;
  operatorKind?: string;
  /** 结构化补充（request_id、入口来源等） */
  metadata?: Record<string, unknown> | null;
}

export interface TicketServiceOptions {
  events: EventService;
  sequences: SequenceService;
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void; info?: (msg: string) => void };
  /** ticket_no 撞唯一约束时的重试次数（取号原子，理论不会撞；留作兜底） */
  maxTicketNoRetries?: number;
}

export class TicketService {
  private readonly db: any;
  private readonly events: EventService;
  private readonly sequences: SequenceService;
  private readonly logger?: TicketServiceOptions['logger'];
  private readonly maxTicketNoRetries: number;

  constructor(db: any, options: TicketServiceOptions) {
    this.db = db;
    this.events = options.events;
    this.sequences = options.sequences;
    this.logger = options.logger;
    this.maxTicketNoRetries = options.maxTicketNoRetries ?? 3;
  }

  // -------------------------------------------------------------------------
  // M1 —— 创建工单
  // -------------------------------------------------------------------------

  /**
   * M1 createTicket：— → NEW
   *
   * 同事务副作用：取 ticket_no → 建单 → 写 `created` 事件。
   *
   * ⚠️ 限流（IP/手机号）、request_id 幂等、重复工单检测**不在本方法内**，
   *    它们属于匿名入口的前置守卫（Phase 3 的 GuardService）。
   *    本方法只保证"给我的输入，我建出一张一致的工单"。
   */
  async create(input: CreateTicketInput): Promise<{ ticket: any; event: any }> {
    const store = await this.resolveStore(input);
    const ticketType = this.assertEnum(input.ticketType, TICKET_TYPE_VALUES, 'ticket_type');
    const source = this.assertEnum(
      input.source ?? TICKET_SOURCE.QR,
      TICKET_SOURCE_VALUES,
      'source',
    );
    const content = String(input.content ?? '').trim();
    if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
      throw new ValidationError(
        'INVALID_CONTENT',
        `报修内容需 ${CONTENT_MIN}–${CONTENT_MAX} 字，当前 ${content.length} 字`,
      );
    }

    const mobile = String(input.customerMobile ?? '').trim();
    if (!MOBILE_PATTERN.test(mobile)) {
      throw new ValidationError('INVALID_MOBILE', '手机号格式不正确');
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxTicketNoRetries; attempt += 1) {
      const ticketNo = await this.sequences.nextTicketNo();

      try {
        return await this.withTransaction(async (transaction) => {
          const repository = this.db.getRepository('serviceTickets');

          const ticket = await repository.create({
            values: {
              ticket_no: ticketNo,
              // belongsTo 的外键列直接赋值（列名 = _helpers.belongsTo 的 foreignKey）
              store_id: Number(store.id),
              source_store_code: store.code,
              source,
              ticket_type: ticketType,
              content,
              customer_name: input.customerName ? String(input.customerName).trim() : null,
              customer_mobile: mobile,
              // 显式设 NEW，不依赖 defaultValue —— 状态机的起点必须写在代码里
              status: TICKET_STATUS.NEW,
            },
            transaction,
          });

          const event = await this.events.write({
            ticketId: ticket.id,
            eventType: EVENT_TYPE.CREATED,
            operatorKind: input.operatorKind ?? OPERATOR_KIND.CUSTOMER,
            operatorUserId: input.operatorUserId ?? null,
            toStatus: TICKET_STATUS.NEW,
            summary: `客户提交${ticketType === 'complaint' ? '投诉' : '报修'}（${store.name}）`,
            metadata: {
              store_code: store.code,
              store_name: store.name,
              ticket_type: ticketType,
              source,
              ...(input.metadata ?? {}),
            },
            transaction,
          });

          return { ticket, event };
        });
      } catch (error) {
        lastError = error;
        if (isTicketNoConflict(error) && attempt < this.maxTicketNoRetries - 1) {
          this.logger?.warn?.(
            `[ticket] ticket_no ${ticketNo} 撞唯一约束，重新取号（第 ${attempt + 1} 次）`,
          );
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  // -------------------------------------------------------------------------
  // M2 —— 受理
  // -------------------------------------------------------------------------

  /**
   * M2 accept：NEW → PROCESSING
   *
   * 同事务副作用：`handler_user_id`（仅首次）、`first_response_at`（仅首次）、写 `accepted`。
   *
   * 「仅首次」用 COALESCE 在 SQL 里完成，而不是先在 JS 里判断 ——
   * 后者在并发下会丢失先到者的时间戳。
   */
  async accept(
    ticketId: number | string,
    actor: { userId: number; username?: string },
  ): Promise<{ ticket: any; event: any }> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');

    return this.withTransaction(async (transaction) => {
      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: [TICKET_STATUS.NEW],
        set: {
          status: TICKET_STATUS.PROCESSING,
          // 已经是别人的工单时不抢归属，只补 first_response_at
          handler_user_id: sql`COALESCE(handler_user_id, ${operatorUserId})`,
          first_response_at: sql`COALESCE(first_response_at, now())`,
        },
        transaction,
      });

      if (!updated) {
        await this.throwStateConflict(id, [TICKET_STATUS.NEW], '受理');
      }

      const event = await this.events.recordTransition({
        ticketId: id,
        fromStatus: TICKET_STATUS.NEW,
        toStatus: TICKET_STATUS.PROCESSING,
        eventType: EVENT_TYPE.ACCEPTED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        summary: `门店受理，开始处理`,
        metadata: { operator_username: actor.username ?? null },
        transaction,
      });

      return { ticket: stripInternal(updated), event };
    });
  }

  // -------------------------------------------------------------------------
  // M6 —— 转店（状态不变）
  // -------------------------------------------------------------------------

  /**
   * M6 transfer：NEW / PROCESSING → **状态不变**，只改 store_id。
   *
   * 两个容易写错的点：
   *   · `source_store_code` **保持不变** —— 它记录"客户当初是扫哪家店进来的"，
   *     转店后这仍是审计线索（M6 明确要求）。
   *   · 事件类型是 `transferred` 而非状态变更事件 —— 所以**不带 from/to status**，
   *     否则 EventService 会因为 from == to 而报错（这是刻意的互相卡位）。
   *
   * ⚠️ 权限（能否转到目标门店、是否需要总部特权）由调用方经 PermissionService 完成。
   */
  async transfer(
    ticketId: number | string,
    targetStoreId: number | string,
    reason: string,
    actor: { userId: number; username?: string },
  ): Promise<{ ticket: any; event: any; previousStoreId: number }> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const targetId = toPositiveInt(targetStoreId, 'targetStoreId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');
    const reasonText = this.assertReason(reason, '转店');

    return this.withTransaction(async (transaction) => {
      const repository = this.db.getRepository('serviceTickets');
      const before = await repository.findOne({ filter: { id }, transaction });
      if (!before) {
        throw new ValidationError('NOT_FOUND', `工单 ${id} 不存在`);
      }

      const previousStoreId = Number(before.store_id);
      if (previousStoreId === targetId) {
        throw new ValidationError('SAME_STORE', '目标门店与当前门店相同');
      }

      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: TRANSFERABLE_STATUSES,
        set: { store_id: targetId },
        transaction,
      });

      if (!updated) {
        await this.throwStateConflict(id, TRANSFERABLE_STATUSES, '转店');
      }

      const storeName = await this.loadStoreName(targetId, transaction);

      const event = await this.events.write({
        ticketId: id,
        eventType: EVENT_TYPE.TRANSFERRED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        summary: `转店：${before.source_store_code ?? previousStoreId} → ${storeName}`,
        metadata: {
          reason: reasonText,
          from_store_id: previousStoreId,
          to_store_id: targetId,
          // 刻意保留原始来源门店：它不随转店变化
          source_store_code: before.source_store_code ?? null,
          operator_username: actor.username ?? null,
        },
        transaction,
      });

      return { ticket: stripInternal(updated), event, previousStoreId };
    });
  }

  // -------------------------------------------------------------------------
  // M7 —— 取消
  // -------------------------------------------------------------------------

  /**
   * M7 cancel：NEW / PROCESSING → CANCELLED（终态）
   */
  async cancel(
    ticketId: number | string,
    reason: string,
    actor: { userId: number; username?: string },
  ): Promise<{ ticket: any; event: any }> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');
    const reasonText = this.assertReason(reason, '取消');

    return this.withTransaction(async (transaction) => {
      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: CANCELLABLE_STATUSES,
        set: {
          status: TICKET_STATUS.CANCELLED,
          close_reason: CLOSE_REASON.CANCELLED,
          closed_at: sql`now()`,
        },
        transaction,
      });

      if (!updated) {
        await this.throwStateConflict(id, CANCELLABLE_STATUSES, '取消');
      }

      const event = await this.events.recordTransition({
        ticketId: id,
        fromStatus: String(updated.__from_status),
        toStatus: TICKET_STATUS.CANCELLED,
        eventType: EVENT_TYPE.CANCELLED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        summary: `工单取消：${reasonText}`,
        metadata: { reason: reasonText, operator_username: actor.username ?? null },
        transaction,
      });

      return { ticket: stripInternal(updated), event };
    });
  }

  // -------------------------------------------------------------------------
  // 查询辅助（只读，不做鉴权 —— 调用方须先过 PermissionService）
  // -------------------------------------------------------------------------

  /** 按 ID 取工单 */
  async findById(ticketId: number | string, transaction?: unknown): Promise<any | null> {
    const repository = this.db.getRepository('serviceTickets');
    const options: Record<string, unknown> = { filter: { id: toPositiveInt(ticketId, 'ticketId') } };
    if (transaction) options.transaction = transaction;
    return repository.findOne(options);
  }

  // -------------------------------------------------------------------------
  // 内部：条件更新
  // -------------------------------------------------------------------------

  /**
   * 条件 UPDATE（乐观并发）。
   *
   * 返回更新后的行（含内部字段 `__from_status` = 更新前的状态，供写事件用）；
   * 影响 0 行返回 null，由调用方抛 StateConflictError。
   *
   * 为什么用 `RETURNING *` 而不是看 rowCount：
   *   sequelize 对 UPDATE 的 metadata 在各方言下形态不一致（PG 给 rowCount，
   *   MySQL 给 affectedRows），而 RETURNING 是 PG 的强项且语义最直白：
   *   **返回了行就是更新成功了**。本系统只支持 PostgreSQL，用满它的能力。
   */
  private async conditionalUpdate(params: {
    ticketId: number;
    fromStatuses: string[];
    set: Record<string, unknown>;
    transaction?: unknown;
  }): Promise<any | null> {
    const { ticketId, fromStatuses, set, transaction } = params;

    const columns = Object.keys(set);
    for (const column of columns) {
      if (!UPDATABLE_COLUMNS.has(column)) {
        throw new Error(`[ticket] 列 "${column}" 不在允许更新白名单内（防列名注入）`);
      }
    }

    const bind: unknown[] = [ticketId, fromStatuses];
    const assignments: string[] = [];

    // 参数序号从 $3 开始（$1=id，$2=状态数组）
    columns.forEach((column, index) => {
      const value = set[column];
      if (value instanceof RawSql) {
        // 原生片段：内部构造，绝不接受外部输入
        assignments.push(`${column} = ${value.inline(bind)}`);
      } else {
        bind.push(value);
        assignments.push(`${column} = $${bind.length}`);
      }
    });

    // updated_at 是 NOT NULL 且无 DB 默认值，必须显式赋值
    assignments.push(`updated_at = now()`);

    const sqlText =
      `UPDATE service_tickets SET ${assignments.join(', ')} ` +
      `WHERE id = $1 AND status = ANY($2::text[]) ` +
      `RETURNING *`;

    const [rows] = await this.rawQuery(sqlText, bind, transaction);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;

    // 记下更新前的状态：并发下我们无法再 SELECT 一次（状态已经变了）
    const changed = { ...(row as Record<string, unknown>) };
    changed.__from_status = resolveChangedFrom(fromStatuses, String(changed.status));
    return changed;
  }

  /**
   * 影响 0 行时，查一次真实状态好把冲突信息说清楚（日志/前端提示用）。
   * 注意：这里读了库但**不用于决策**，决策已经由 UPDATE 完成。
   */
  private async throwStateConflict(
    ticketId: number,
    expected: string[],
    action: string,
  ): Promise<never> {
    const current = await this.findById(ticketId);
    const currentStatus = current ? String(current.status) : '(不存在)';
    const message =
      `工单 ${ticketId} 当前状态为 ${currentStatus}，` +
      `不满足「${action}」要求的 ${expected.join('/')} —— 可能已被他人操作`;
    this.logger?.warn?.(`[ticket] ${message}`);
    throw new StateConflictError(message);
  }

  // -------------------------------------------------------------------------
  // 内部：事务与查询
  // -------------------------------------------------------------------------

  /**
   * 开事务执行。
   *
   * 若宿主没有 sequelize.transaction（离线桩环境），退化为"直接执行、不传事务"，
   * 这样服务层在桩环境下仍可被单测覆盖 —— 桩环境本来就验不了事务语义，
   * 硬报错只会让整批用例变红而掩盖真正的问题。
   */
  private async withTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') {
      this.logger?.debug?.('[ticket] sequelize.transaction 不可用，本次操作未使用事务');
      return fn(undefined);
    }
    return sequelize.transaction(fn);
  }

  private async rawQuery(
    sqlText: string,
    bind: unknown[],
    transaction?: unknown,
  ): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[ticket] db.sequelize.query 不可用');
    }
    const options: Record<string, unknown> = { bind };
    if (transaction) options.transaction = transaction;
    return (await sequelize.query(sqlText, options)) as [unknown, unknown];
  }

  // -------------------------------------------------------------------------
  // 内部：校验
  // -------------------------------------------------------------------------

  private async resolveStore(input: CreateTicketInput): Promise<{ id: number; code: string; name: string }> {
    const repository = this.db.getRepository('stores');
    const filter: Record<string, unknown> = {};

    if (input.storeId !== undefined && input.storeId !== null) {
      filter.id = toPositiveInt(input.storeId, 'storeId');
    } else if (input.storeCode) {
      filter.code = String(input.storeCode).trim();
    } else {
      throw new ValidationError('MISSING_STORE', '必须提供 storeId 或 storeCode');
    }

    const store = await repository.findOne({ filter });
    if (!store) {
      throw new ValidationError('STORE_NOT_FOUND', '门店不存在');
    }
    if (store.active !== true) {
      // M1 前置校验：门店必须 active
      throw new ValidationError('STORE_INACTIVE', `门店「${store.name}」已停用，暂不能报修`);
    }

    return { id: Number(store.id), code: String(store.code), name: String(store.name) };
  }

  private async loadStoreName(storeId: number, transaction?: unknown): Promise<string> {
    const repository = this.db.getRepository('stores');
    const options: Record<string, unknown> = { filter: { id: storeId } };
    if (transaction) options.transaction = transaction;
    const store = await repository.findOne(options);
    return store ? `${store.name}(${store.code})` : String(storeId);
  }

  private assertEnum(value: unknown, allowed: readonly string[], field: string): string {
    const text = String(value ?? '').trim();
    if (!allowed.includes(text)) {
      throw new ValidationError(
        'INVALID_ENUM',
        `${field} 必须是 ${allowed.join(' / ')} 之一，实际 "${text}"`,
      );
    }
    return text;
  }

  private assertReason(reason: unknown, action: string): string {
    const text = String(reason ?? '').trim();
    if (text.length === 0) {
      throw new ValidationError('MISSING_REASON', `${action}必须填写原因`);
    }
    if (text.length > 200) {
      throw new ValidationError('REASON_TOO_LONG', `${action}原因不能超过 200 字`);
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// 原生 SQL 片段（内部专用）
// ---------------------------------------------------------------------------

/**
 * 包一层原生 SQL 片段，让 `COALESCE(handler_user_id, $3)` 这类表达式
 * 能安全地混进参数化语句。
 *
 * ⚠️ 这个类**只允许在 TicketService 内部构造**，绝不接受来自请求的值 ——
 *    一旦把外部字符串塞进来，参数化就形同虚设。
 */
class RawSql {
  constructor(private readonly build: (bind: unknown[]) => string) {}
  inline(bind: unknown[]): string {
    return this.build(bind);
  }
}

const sql = (strings: TemplateStringsArray, ...values: unknown[]): RawSql =>
  new RawSql((bind: unknown[]) => {
    let out = '';
    strings.forEach((chunk, index) => {
      out += chunk;
      if (index < values.length) {
        bind.push(values[index]);
        out += `$${bind.length}`;
      }
    });
    return out;
  });

function resolveChangedFrom(fromStatuses: string[], currentStatus: string): string {
  // 条件更新命中的原状态：优先取"唯一候选"，否则取条件里那个不等于当前值的
  if (fromStatuses.length === 1) return fromStatuses[0];
  return fromStatuses.find((status) => status !== currentStatus) ?? fromStatuses[0];
}

function stripInternal<T extends Record<string, unknown>>(row: T): Omit<T, '__from_status'> {
  const { __from_status: _drop, ...rest } = row;
  return rest;
}

function toPositiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError('INVALID_ID', `${field} 必须是正整数`);
  }
  return num;
}

function isTicketNoConflict(error: unknown): boolean {
  const anyError = error as any;
  const original = anyError?.original ?? anyError;
  const code = original?.code ?? anyError?.code;
  if (code !== '23505') return false;
  const detail = String(original?.constraint ?? original?.detail ?? '');
  return detail.includes('ticket_no');
}

/** 供 action 层把状态机判定前移到 DTO 校验用（不改数据，纯查询） */
export function describeTransition(from: string, to: string): { allowed: boolean; reason?: string } {
  if (from === to) return { allowed: true, reason: '同状态内的字段变更' };
  if (canTransition(from as any, to as any)) return { allowed: true };
  return { allowed: false, reason: `状态机不允许 ${from} → ${to}（见 docs/STATE-MACHINE.md §3）` };
}
