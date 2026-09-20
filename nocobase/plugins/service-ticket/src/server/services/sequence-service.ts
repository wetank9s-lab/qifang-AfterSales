/**
 * SequenceService —— 业务编号原子取号
 *
 * 两个编号体系：
 *   工单号  FW20260920-0001      seq_key = "FW-20260920"   按天重置
 *   上门序号 V-<ticketId>-<NN>   seq_key = "V-<ticketId>"  按工单递增
 *
 * 为什么必须用 upsert 而不是"先 SELECT 再 UPDATE"：
 *   后者在并发下是经典的 lost update —— 两个请求读到同一个 current_value，
 *   各自 +1 写回，得到两个相同编号。工单号重复是**不可修复**的数据事故
 *   （唯一约束会直接让其中一个请求 500，且客户已经收到了短信）。
 *
 * 唯一的原子实现（PG 行锁 + upsert，一条语句搞定）：
 *   INSERT INTO daily_sequences (seq_key, current_value, created_at, updated_at)
 *   VALUES ($1, 1, now(), now())
 *   ON CONFLICT (seq_key)
 *   DO UPDATE SET current_value = daily_sequences.current_value + 1, updated_at = now()
 *   RETURNING current_value;
 *
 * ⚠️ 两条真机实测过的硬约束：
 *   1) 时间戳列是 snake_case 的 created_at / updated_at（本插件全面 underscored: true，
 *      见 DEV-14），**不加双引号**。写成 "updatedAt" 会报 42703 undefined_column。
 *   2) 这两列是 NOT NULL 且**没有 DB 默认值**（NocoBase 在应用层赋值），
 *      所以原生 INSERT 必须显式带上 created_at，否则报 23502 not-null violation。
 *      这也是本文件把 created_at 写进 INSERT 而不是省略的原因。
 *
 * "无空洞"的口径：本方法保证「每成功调用一次，current_value 恰好 +1」。
 *   若调用方所在事务随后回滚，号码会作废（出现空洞）——这是刻意的：
 *   宁可留空洞，也不能因为回滚就把已发出的号码回收再发给另一个人。
 */
import { SEQUENCE_KEY } from '../constants';

export interface SequenceServiceOptions {
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
  /** 唯一键冲突时的重试次数（默认 5）。高并发下 PG 偶发 23505，重试即可。 */
  maxRetries?: number;
}

/** PG 错误码：唯一约束冲突 */
const PG_UNIQUE_VIOLATION = '23505';
/** PG 错误码：not-null 违反（用于把"漏写时间戳列"这类问题指出来） */
const PG_NOT_NULL_VIOLATION = '23502';

export class SequenceService {
  private readonly db: any;
  private readonly logger?: SequenceServiceOptions['logger'];
  private readonly maxRetries: number;

  constructor(db: any, options: SequenceServiceOptions = {}) {
    this.db = db;
    this.logger = options.logger;
    this.maxRetries = options.maxRetries ?? 5;
  }

  /**
   * 取下一个流水号（从 1 开始）。
   *
   * @param seqKey 取号键，如 `FW-20260920` / `V-12`
   */
  async nextValue(seqKey: string): Promise<number> {
    if (!seqKey || typeof seqKey !== 'string') {
      throw new Error('[sequence] seqKey 必须是非空字符串');
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.bump(seqKey);
      } catch (error) {
        lastError = error;

        if (isPgError(error, PG_NOT_NULL_VIOLATION)) {
          // 这类错误重试多少次都没用，且几乎必然是代码写错了列名/漏了列
          throw new Error(
            `[sequence] 取号失败：daily_sequences 有 NOT NULL 列未赋值。` +
              `原生 INSERT 必须显式提供 created_at 与 updated_at（见本文件顶部注释）。` +
              `原始错误：${(error as Error)?.message}`,
          );
        }

        if (isPgError(error, PG_UNIQUE_VIOLATION) && attempt < this.maxRetries) {
          // 并发首次插入同一 seq_key 时，PG 可能让其中一个事务撞唯一约束。
          // 属于正常的并发竞争，退避后重试即可，日志降为 debug。
          this.logger?.debug?.(
            `[sequence] seq_key=${seqKey} 并发冲突，第 ${attempt + 1} 次重试`,
          );
          await this.backoff(attempt);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  /**
   * 取工单号：FW{YYYYMMDD}-{NNNN}
   *
   * @param at 用于取日期的时刻（默认当前）。显式传入是为了可测。
   */
  async nextTicketNo(at: Date = new Date()): Promise<string> {
    const datePart = formatDatePart(at);
    const seqKey = `${SEQUENCE_KEY.TICKET_PREFIX}-${datePart}`;
    const value = await this.nextValue(seqKey);
    return `${SEQUENCE_KEY.TICKET_PREFIX}${datePart}-${pad(value, SEQUENCE_KEY.TICKET_SEQ_WIDTH)}`;
  }

  /**
   * 取上门序号：`<ticketId>-<NN>`
   *
   * 注意返回的是**字符串**（`12-01`），不是纯数字：
   * serviceVisits.visit_no 需要一个"同一工单内唯一"的短标识，
   * 由调用方拼进展示文案。visit_no 本身的唯一性由
   * unique(ticket_id, visit_no) 在数据库层兜底。
   */
  async nextVisitNo(ticketId: number | string): Promise<string> {
    const id = String(ticketId);
    if (!/^\d+$/.test(id)) {
      throw new Error(`[sequence] ticketId 必须为正整数，实际 "${id}"`);
    }
    const seqKey = `${SEQUENCE_KEY.VISIT_PREFIX}-${id}`;
    const value = await this.nextValue(seqKey);
    return pad(value, SEQUENCE_KEY.VISIT_SEQ_WIDTH);
  }

  /**
   * 只读当前值（诊断/后台展示用），**不消耗号码**。
   * 查不到返回 0。
   */
  async peek(seqKey: string): Promise<number> {
    const [rows] = await this.query(
      `SELECT current_value FROM daily_sequences WHERE seq_key = $1`,
      [seqKey],
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return 0;
    const value = Number((row as any).current_value);
    return Number.isFinite(value) ? value : 0;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 单次原子自增，返回 `{ rows }` 形态的原始结果 */
  private async bump(seqKey: string): Promise<number> {
    const [rows] = await this.query(
      `INSERT INTO daily_sequences (seq_key, current_value, created_at, updated_at)
       VALUES ($1, 1, now(), now())
       ON CONFLICT (seq_key)
       DO UPDATE SET current_value = daily_sequences.current_value + 1, updated_at = now()
       RETURNING current_value`,
      [seqKey],
    );

    const row = Array.isArray(rows) ? rows[0] : undefined;
    const value = Number(row && (row as any).current_value);

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `[sequence] seq_key=${seqKey} 未返回有效流水值（实际 ${JSON.stringify(rows)}）`,
      );
    }
    return value;
  }

  /**
   * 统一的原生查询入口。
   *
   * 用 `sequelize.query` 的 **位置参数**（$1/$2 + bind 数组）而不是 replacements：
   * bind 由驱动直接传给 PG 的预处理协议，不存在字符串拼接，天然免疫注入；
   * replacements 是客户端替换，用得不当会把值拼进 SQL 文本。
   */
  private async query(sql: string, bind: unknown[]): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[sequence] db.sequelize.query 不可用，无法取号');
    }
    return (await sequelize.query(sql, { bind })) as [unknown, unknown];
  }

  private async backoff(attempt: number): Promise<void> {
    // 指数退避 + 抖动，避免重试风暴同步打在同一时刻
    const base = Math.min(2 ** attempt, 40);
    const jitter = Math.floor(Math.random() * 10);
    await new Promise((resolve) => setTimeout(resolve, base + jitter));
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 本地时区的 YYYYMMDD（工单号按门店所在时区的日历天重置，不用 UTC） */
export function formatDatePart(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function isPgError(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const original = (error as any).original ?? error;
  return original?.code === code || (error as any).code === code;
}
