/**
 * progress-service —— 客户**服务进度查询**（P11-4 · C 条）
 *
 * ===========================================================================
 * 这套凭证与另外两套的关系（用户明令"必须分离"）
 * ===========================================================================
 * ```
 *   师傅作业 Token  /t/{token}   匿名 · 单条 Visit · 改派即废
 *   客户评价 Token  /f/{token}   匿名 · 一次性 · 不可撤销
 *   客户进度 Token  /p/{token}   匿名 · **可重复查** · **可撤销** · 关闭后保留 30 天
 * ```
 * 三者不共用列、不共用常量、不共用短链。共用的后果：
 * "查进度"顺手获得"评价资格"（越权），或"撤销进度"误伤已完成的评价。
 *
 * ===========================================================================
 * 输出裁剪是这份服务的主要工作
 * ===========================================================================
 * 客户**只**能看到：单号、门店名、状态与状态变迁时间、自己提交的内容、
 * 自己上传的媒体、门店留给他的完成说明、评价状态。
 * 客户**看不到**：内部操作人 ID、审计事件全文、师傅 Token、其他客户数据、
 * 内部备注 —— 所以时间线只取 `event_type/from_status/to_status/created_at`，
 * **不取** `summary`（含师傅姓名与改派细节）、`metadata_json`、`operator_*`。
 */
import crypto from 'node:crypto';
import { PROGRESS_TOKEN, TICKET_STATUS_LABEL } from '../constants';

export interface ProgressServiceOptions {
  db: any;
  logger?: any;
  now?: () => Date;
}

export interface MintedProgress {
  token: string;
  /** 强制过期时间（可选；未关闭工单通常为 NULL） */
  expiresAt: Date | null;
}

export type ProgressResult =
  | { ok: true; view: Record<string, unknown> }
  | { ok: false; code: string; status: number; message: string };

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export class ProgressService {
  private readonly db: any;
  private readonly logger: any;
  private readonly now: () => Date;

  constructor(options: ProgressServiceOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- 签发
  /**
   * **只生成**一对 (明文, 哈希)，不写库。
   *
   * 为什么需要这个拆分：匿名建单要把明文放进**响应体**（客户当场拿链接），
   * 而哈希必须与建单**同事务**落库 ⇒ action 层先拿这对值，建单时传哈希，
   * 响应时用明文。若让 mintForTicket 自己写库，action 层就再也拿不到明文。
   */
  mintStandalone(): { token: string; hash: string } {
    const token = crypto.randomBytes(PROGRESS_TOKEN.BYTES).toString('base64url');
    return { token, hash: sha256Hex(token) };
  }

  /**
   * 给一张工单签发进度 Token（提交成功时调用）。
   *
   * 明文**只在这里返回一次**，库里只存 sha256。
   * 已签发过的工单再次调用 ⇒ 返回 null（不轮换：轮换会让已发出去的短信失效，
   * 而"重新签发"应由显式的撤销 + 重发流程做）。
   */
  async mintForTicket(ticketId: number): Promise<MintedProgress | null> {
    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({ filter: { id: Number(ticketId) } });
    if (!ticket) return null;
    const plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };
    if (plain.progress_token_hash) return null;

    const minted = this.mintStandalone();
    await repo.update({
      filter: { id: Number(ticketId) },
      values: { progress_token_hash: minted.hash, progress_token_revoked_at: null },
    });
    this.logger?.info?.(`[progress] 工单 ${ticketId} 已签发进度 Token（hash ${minted.hash.slice(0, 8)}…）`);
    return { token: minted.token, expiresAt: null };
  }

  // ---------------------------------------------------------------- 撤销
  async revoke(ticketId: number, reason: string): Promise<boolean> {
    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({ filter: { id: Number(ticketId) } });
    if (!ticket) return false;
    const plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };
    if (!plain.progress_token_hash || plain.progress_token_revoked_at) return false;
    await repo.update({
      filter: { id: Number(ticketId) },
      values: { progress_token_revoked_at: this.now() },
    });
    this.logger?.info?.(`[progress] 工单 ${ticketId} 的进度 Token 已撤销（原因：${reason}）`);
    return true;
  }

  // ---------------------------------------------------------------- 解析
  /**
   * 明文 Token → 工单 id。
   *
   * 四种失效**都返回 null**（调用方统一回同一个响应，不区分原因）：
   *   ① 不存在 / 格式不对   ② 已撤销   ③ 已过强制过期   ④ 关闭超过保留期
   *
   * ⚠️ "关闭后保留 30 天"按**真实服务端时间**算：
   *    effective = min(progress_token_expires_at, closed_at + 30d)，
   *    未关闭的工单没有第二项 ⇒ 关闭前一直可查。
   */
  async resolveTicketId(token: string): Promise<number | null> {
    const text = String(token ?? '');
    if (!PROGRESS_TOKEN.PATTERN.test(text)) return null;
    const hash = sha256Hex(text);
    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({ filter: { progress_token_hash: hash } });
    if (!ticket) return null;
    const plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };
    if (plain.progress_token_revoked_at) return null;

    const now = this.now().getTime();
    if (plain.progress_token_expires_at && new Date(plain.progress_token_expires_at).getTime() <= now) {
      return null;
    }
    if (plain.closed_at) {
      const retainUntil =
        new Date(plain.closed_at).getTime() + PROGRESS_TOKEN.RETAIN_DAYS_AFTER_CLOSE * 86_400_000;
      if (retainUntil <= now) return null;
    }
    return Number(plain.id);
  }

  /** 供媒体读取侧复用：Token 是否仍指向一个可读工单 */
  async isUsable(token: string): Promise<boolean> {
    return (await this.resolveTicketId(token)) != null;
  }

  // ---------------------------------------------------------------- 查询
  async getProgress(token: string): Promise<ProgressResult> {
    const ticketId = await this.resolveTicketId(token);
    if (ticketId == null) {
      return {
        ok: false,
        code: 'PROGRESS_TOKEN_INVALID',
        status: 401,
        message: '这个查询链接无效、已过期或已被撤销',
      };
    }

    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({
      filter: { id: ticketId },
      appends: ['store'],
    });
    if (!ticket) {
      return { ok: false, code: 'TICKET_NOT_FOUND', status: 404, message: '服务单不存在' };
    }
    const t: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };

    // 时间线：**只取**状态变迁与时间。刻意不取 summary / metadata_json / operator_*。
    const events =
      (await this.db.getRepository('ticketEvents').find({
        filter: { ticket_id: ticketId },
        sort: ['created_at', 'id'],
        limit: 200,
      })) ?? [];
    const timeline = events.map((e: any) => {
      const p: any = typeof e.toJSON === 'function' ? e.toJSON() : { ...e };
      return {
        status: String(p.to_status ?? ''),
        status_label: TICKET_STATUS_LABEL[String(p.to_status ?? '') as keyof typeof TICKET_STATUS_LABEL] ?? String(p.to_status ?? ''),
        at: p.created_at,
      };
    });

    // 媒体：只回客户应见的元信息（id 用于受控读取，kind/mime/size/duration 用于展示）
    const medias =
      (await this.db.getRepository('customerMedias').find({
        filter: { ticket_id: ticketId },
        sort: ['sort_order', 'id'],
      })) ?? [];
    const media = medias.map((m: any) => {
      const p: any = typeof m.toJSON === 'function' ? m.toJSON() : { ...m };
      return {
        id: Number(p.id),
        kind: String(p.media_kind),
        mime: String(p.mime),
        size: Number(p.size),
        duration_ms: p.duration_ms == null ? null : Number(p.duration_ms),
      };
    });

    // 有效期（如实告诉客户"这个链接还能用到什么时候"）
    const closedAt = t.closed_at ? new Date(t.closed_at) : null;
    const retainUntil = closedAt
      ? new Date(closedAt.getTime() + PROGRESS_TOKEN.RETAIN_DAYS_AFTER_CLOSE * 86_400_000)
      : null;

    return {
      ok: true,
      view: {
        ticket_no: String(t.ticket_no ?? ''),
        /** 只回门店**名**，不回 code（内部编码） */
        store_name: String(t.store?.name ?? ''),
        status: String(t.status ?? ''),
        status_label: TICKET_STATUS_LABEL[String(t.status ?? '') as keyof typeof TICKET_STATUS_LABEL] ?? String(t.status ?? ''),
        created_at: t.created_at,
        updated_at: t.updated_at,
        closed_at: t.closed_at ?? null,
        // 客户自己提交的内容（回显，便于确认"我交的是这个"）
        submitted: {
          ticket_type: String(t.ticket_type ?? ''),
          content: String(t.content ?? ''),
          customer_name: t.customer_name ?? null,
          service_address: t.service_address ?? null,
          appliance_category: t.appliance_category ?? null,
          brand_model: t.brand_model ?? null,
        },
        media,
        timeline,
        /** 门店留给客户的完成说明（内部备注不走这里） */
        completion_note: t.completion_note ?? null,
        /** 评价：只回状态。**不给评价 Token**（那套凭证走短信，与本链接分离） */
        review: {
          status: String(t.review_status ?? 'pending'),
          invited_via_sms: true,
        },
        /** 链接有效期：未关闭 ⇒ null（关闭前一直有效）；已关闭 ⇒ 关闭 + 30 天 */
        queryable_until: retainUntil ? retainUntil.toISOString() : null,
        closed: closedAt != null,
      },
    };
  }
}
