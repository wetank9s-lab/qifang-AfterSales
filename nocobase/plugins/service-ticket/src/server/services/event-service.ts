/**
 * EventService —— ticketEvents 的**唯一**写入口
 *
 * 存在意义（开发文档 §16「任何重要变化都写事件」）：
 *   工单详情页的时间线、审计追溯、SLA 与报表口径，全部依赖 ticketEvents。
 *   如果允许各处随手 create，就会出现"status 变了但没有事件"的孤儿状态 ——
 *   这种数据一旦产生无法事后修补（没人知道当时发生了什么）。
 *   因此这里集中收口：**所有状态变更与业务动作都必须经本服务落事件**，
 *   且调用方应在**同一个事务**里完成"改状态 + 写事件"，两者要么都成，要么都不成。
 *
 * 本服务刻意做三件事之外什么也不做：
 *   1) 校验 event_type / operator_kind 是否在白名单（防拼写错误悄悄落库）
 *   2) 校验"状态变更事件必须带 to_status"，并拒绝 from == to 的无意义迁移记录
 *   3) 写库（支持传入事务）
 * 业务前置校验（权限、状态机、必填字段）属于 TicketService，不在这里。
 */
import { EVENT_TYPE, EVENT_TYPE_VALUES, OPERATOR_KIND, OPERATOR_KIND_VALUES } from '../constants';

/** summary 列的 varchar(255) 上限 */
const SUMMARY_MAX_LENGTH = 255;
/** metadata_json 的软上限（字节）。超了说明塞了不该塞的东西（如整页 HTML）。 */
const METADATA_MAX_BYTES = 8 * 1024;

/**
 * 事件分类：决定"是否必须提供 to_status"。
 *
 * 依据 docs/STATE-MACHINE.md §3 的 M1–M15 表：
 *   - 状态变化的事件：created / accepted / technician_submitted / store_confirmed
 *                     / store_rejected / completed / closed / reopened / cancelled
 *   - 状态不变（同状态内的字段变更）：transferred / dispatched? / rescheduled / reassigned
 *   - 纯通知类：sms_sent / sms_failed
 *
 * 说明两处容易看错的：
 *   · `transferred`（M6）**状态不变**，只改 store_id —— 所以它不属于状态变更事件。
 *   · `dispatched`（M3）从 NEW 或 PROCESSING **都**进入 PROCESSING，
 *     当它发生在 PROCESSING 上时状态确实没变。因此它**不强制**要求 to_status，
 *     由调用方按实际迁移传入（有变化就传，没变化就留空）。
 *   · `reviewed`（M12/M13）只是"评价已提交"的记录，状态变化由随后的
 *     `closed`（M12）或 `reopened`（M13）事件表达 —— 所以它也不强制 to_status。
 */
export const STATUS_CHANGE_EVENTS: string[] = [
  EVENT_TYPE.CREATED,
  EVENT_TYPE.ACCEPTED,
  EVENT_TYPE.TECHNICIAN_SUBMITTED,
  EVENT_TYPE.STORE_CONFIRMED,
  EVENT_TYPE.STORE_REJECTED,
  EVENT_TYPE.COMPLETED,
  EVENT_TYPE.CLOSED,
  EVENT_TYPE.REOPENED,
  EVENT_TYPE.CANCELLED,
];

/**
 * 允许 `from_status` 为空的状态变更事件。
 * 只有 `created` 是"从无到有"，没有原状态。
 */
const EVENTS_ALLOWING_NULL_FROM: string[] = [EVENT_TYPE.CREATED];

export interface WriteEventInput {
  ticketId: number | string;
  eventType: string;
  /** 操作者身份（customer / technician / store / hq / system） */
  operatorKind: string;
  /** 人可读的一句话摘要 */
  summary: string;
  /** 关联的 Visit（与某次上门相关时填） */
  visitId?: number | string | null;
  /** 原状态（状态变更事件必填，`created` 除外） */
  fromStatus?: string | null;
  /** 新状态（状态变更事件必填） */
  toStatus?: string | null;
  /** 操作人（客户/师傅的匿名操作留空） */
  operatorUserId?: number | string | null;
  /** 结构化补充：金额、原因、原/新门店编码、消息 ID 等 */
  metadata?: Record<string, unknown> | null;
  /** NocoBase 事务对象。传了就用，不传则单条自动提交。 */
  transaction?: unknown;
}

export interface EventServiceOptions {
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
}

export class EventService {
  private readonly db: any;
  private readonly logger?: EventServiceOptions['logger'];

  constructor(db: any, options: EventServiceOptions = {}) {
    this.db = db;
    this.logger = options.logger;
  }

  /**
   * 写一条事件。校验不通过直接抛错（调用方在事务里 → 整体回滚，不会留半套状态）。
   */
  async write(input: WriteEventInput): Promise<Record<string, unknown>> {
    this.assertValid(input);

    const values: Record<string, unknown> = {
      ticket_id: normalizeId(input.ticketId, 'ticketId'),
      event_type: input.eventType,
      operator_kind: input.operatorKind,
      summary: clampSummary(input.summary, this.logger),
    };

    if (input.visitId !== undefined && input.visitId !== null) {
      values.visit_id = normalizeId(input.visitId, 'visitId');
    }
    if (input.operatorUserId !== undefined && input.operatorUserId !== null) {
      // NocoBase 的 belongsTo 外键：不能写 operator_user_id 字面量，
      // 必须用关系字段名 operatorUserId 传值（会被映射到 operator_user_id 列）。
      values.operatorUserId = normalizeId(input.operatorUserId, 'operatorUserId');
    }
    if (input.fromStatus !== undefined && input.fromStatus !== null) {
      values.from_status = input.fromStatus;
    }
    if (input.toStatus !== undefined && input.toStatus !== null) {
      values.to_status = input.toStatus;
    }
    if (input.metadata !== undefined && input.metadata !== null) {
      values.metadata_json = input.metadata;
    }

    const repository = this.db.getRepository('ticketEvents');
    const createOptions: Record<string, unknown> = { values };
    if (input.transaction) {
      createOptions.transaction = input.transaction;
    }

    return (await repository.create(createOptions)) as Record<string, unknown>;
  }

  /**
   * 状态迁移专用入口：一次写完 from → to。
   * 让调用点读起来就是一次迁移，避免各处自己拼 from/to 时写反。
   */
  async recordTransition(params: {
    ticketId: number | string;
    fromStatus: string;
    toStatus: string;
    operatorKind: string;
    eventType: string;
    summary: string;
    operatorUserId?: number | string | null;
    visitId?: number | string | null;
    metadata?: Record<string, unknown> | null;
    transaction?: unknown;
  }): Promise<Record<string, unknown>> {
    return this.write({
      ticketId: params.ticketId,
      eventType: params.eventType,
      operatorKind: params.operatorKind,
      operatorUserId: params.operatorUserId ?? null,
      visitId: params.visitId ?? null,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      summary: params.summary,
      metadata: params.metadata ?? null,
      transaction: params.transaction,
    });
  }

  /**
   * 读工单时间线（按时间正序）。
   *
   * 分页用 NocoBase 的 pageSize/page 语义；调用方（action 层）负责权限校验 ——
   * 本方法不做鉴权，因为它只服务已通过 PermissionService 的调用点。
   */
  async listByTicket(
    ticketId: number | string,
    options: { page?: number; pageSize?: number } = {},
  ): Promise<{ rows: any[]; count: number }> {
    const repository = this.db.getRepository('ticketEvents');
    const pageSize = clampPageSize(options.pageSize);
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const filter = { ticket_id: normalizeId(ticketId, 'ticketId') };

    const [rows, count] = await Promise.all([
      repository.find({
        filter,
        sort: ['created_at'],
        offset: (page - 1) * pageSize,
        limit: pageSize,
      }),
      repository.count({ filter }),
    ]);

    return { rows: rows || [], count: Number(count) || 0 };
  }

  /**
   * 统计某工单的事件数。
   * 定向测试「阶段变更必须伴随事件」时用它做断言，比数全表更稳。
   */
  async countByTicket(ticketId: number | string, eventType?: string): Promise<number> {
    const repository = this.db.getRepository('ticketEvents');
    const filter: Record<string, unknown> = { ticket_id: normalizeId(ticketId, 'ticketId') };
    if (eventType) filter.event_type = eventType;
    return Number(await repository.count({ filter })) || 0;
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  private assertValid(input: WriteEventInput): void {
    if (!EVENT_TYPE_VALUES.includes(input.eventType as any)) {
      throw new Error(
        `[event] 非法 event_type "${input.eventType}"。` +
          `事件类型是白名单（constants.ts 的 EVENT_TYPE），新增需走评审。`,
      );
    }

    if (!OPERATOR_KIND_VALUES.includes(input.operatorKind as any)) {
      throw new Error(
        `[event] 非法 operator_kind "${input.operatorKind}"，允许值：${OPERATOR_KIND_VALUES.join(' / ')}`,
      );
    }

    if (!input.summary || String(input.summary).trim() === '') {
      throw new Error('[event] summary 不能为空 —— 时间线里一条没有说明的记录没有审计价值');
    }

    const to = input.toStatus ?? null;
    const from = input.fromStatus ?? null;

    if (STATUS_CHANGE_EVENTS.includes(input.eventType)) {
      if (!to) {
        throw new Error(
          `[event] "${input.eventType}" 是状态变更事件，必须提供 toStatus` +
            `（见 docs/STATE-MACHINE.md §3 的迁移表）`,
        );
      }
      const allowsNullFrom = EVENTS_ALLOWING_NULL_FROM.includes(input.eventType);
      if (!from && !allowsNullFrom) {
        throw new Error(
          `[event] "${input.eventType}" 必须提供 fromStatus；` +
            `只有 ${EVENTS_ALLOWING_NULL_FROM.join('/')} 允许原状态为空`,
        );
      }
    }

    // from == to 的"状态变更"记录是自相矛盾的：要么调用方写错了事件类型，
    // 要么该动作根本不该用状态变更事件表达（如 transfer 应写 transferred）。
    if (from && to && from === to) {
      throw new Error(
        `[event] from_status 与 to_status 相同（${from}）—— ` +
          `同状态内的字段变更请用非状态变更事件（如 transferred / rescheduled / reassigned）`,
      );
    }

    if (input.metadata && input.metadata !== null) {
      const size = byteLength(input.metadata);
      if (size > METADATA_MAX_BYTES) {
        throw new Error(
          `[event] metadata 过大（${size} 字节 > ${METADATA_MAX_BYTES}）。` +
            `结构化补充只放必要的键值，不要把整段文本或对象塞进来。`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function normalizeId(value: number | string, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error(`[event] ${field} 必须是正整数，实际 "${value}"`);
  }
  return num;
}

/**
 * 裁剪 summary。
 *
 * 为什么是截断而不是抛错：summary 里常会拼一段用户输入（如取消原因），
 * 让它把整个业务动作打成 500 不值得。截断 + 保留完整内容到 metadata_json
 * 由调用方决定 —— 需要完整原因时请主动放进 metadata。
 */
function clampSummary(summary: string, logger?: EventServiceOptions['logger']): string {
  const text = String(summary).trim();
  if (text.length <= SUMMARY_MAX_LENGTH) return text;
  logger?.debug?.(`[event] summary 超过 ${SUMMARY_MAX_LENGTH} 字，已截断`);
  return `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…`;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    // 循环引用等不可序列化的情况：直接判为超限，让调用方修掉
    return Number.MAX_SAFE_INTEGER;
  }
}

function clampPageSize(size?: number): number {
  const value = Math.trunc(size ?? 50);
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(value, 200);
}

export { OPERATOR_KIND };
