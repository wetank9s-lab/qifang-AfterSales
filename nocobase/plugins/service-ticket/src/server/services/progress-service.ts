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
import { customerEventLabel, deriveProgress } from './progress-stage';

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
    // 时间线：**按事件渲染，不按状态渲染**（UX-PROGRESS-01 真机整改）。
    //
    // 旧实现拿 `to_status` 当标题 ⇒ 派工 / 改派 / 跟进都推 PROCESSING，
    // 于是客户看到多条一模一样的"处理中"；而 to_status 为空的事件
    // 直接渲染成"只有时间没有文字"的空行。
    //
    // 现在：事件类型 → 客户可读事件名（progress-stage 的 CUSTOMER_EVENT_LABEL）；
    //      表里没有的（sms_sent / sms_failed / internal_note / follow_up /
    //      metadata_corrected 等内部事件）**整条不展示**，绝不留空标题。
    //      仍然不取 summary / metadata_json / operator_*。
    const timeline = events
      .map((e: any) => {
        const p: any = typeof e.toJSON === 'function' ? e.toJSON() : { ...e };
        const label = customerEventLabel(p.event_type);
        if (!label) return null;
        const toStatus = String(p.to_status ?? '');
        return {
          event: String(p.event_type ?? ''),
          event_label: label,
          // 兼容旧字段：既有门禁与旧前端只依赖 at / status
          status: toStatus,
          status_label: TICKET_STATUS_LABEL[toStatus as keyof typeof TICKET_STATUS_LABEL] ?? '',
          // DEV-209：NocoBase 的系统时间字段属性名是驼峰（createdAt / updatedAt），
          // 数据库列名才是 created_at。两种写法都兼容（自定义字段不受影响）。
          at: p.createdAt ?? p.created_at,
        };
      })
      .filter(Boolean);

    // ---------------------------------------------------------------- 阶段与师傅
    // UX-PROGRESS-01：客户不能只看到"处理中"，要看到**到哪一步了、现在谁在办**。
    //
    // ⚠️ 这里刻意**不**读 `serviceTickets.technician_name/mobile`：
    //    那是工单级冗余快照，改派后可能落后于最新一次 Visit。
    //    "当前是谁"只认 Visit（且跳过 SUPERSEDED / CANCELLED）。
    // ⚠️ 也刻意**不**从事件里推断当前师傅：事件只有历史，没有"现在"。
    const visits =
      (await this.db.getRepository('serviceVisits').find({
        filter: { ticket_id: ticketId },
        sort: ['visit_no', 'id'],
      })) ?? [];
    const visitRows = visits.map((v: any) => {
      const p: any = typeof v.toJSON === 'function' ? v.toJSON() : { ...v };
      return {
        visit_no: Number(p.visit_no ?? 0),
        visit_status: String(p.visit_status ?? ''),
        technician_name: p.technician_name ?? null,
        // ⚠️ 读进来只用于**判断有没有号码**；是否对客展示由 progress-stage 决定（当前恒不展示）
        technician_mobile: p.technician_mobile ?? null,
        assigned_at: p.assigned_at ?? null,
        submitted_at: p.submitted_at ?? null,
        store_confirmed_at: p.store_confirmed_at ?? null,
        superseded_at: p.superseded_at ?? null,
        expected_visit_at: p.expected_visit_at ?? null,
      };
    });
    const { progress, technician } = deriveProgress({
      ticket: {
        status: String(t.status ?? ''),
        created_at: t.createdAt ?? t.created_at,
        closed_at: t.closed_at ?? null,
        updated_at: t.updatedAt ?? t.updated_at,
      },
      visits: visitRows,
      events: events.map((e: any) => {
        const p: any = typeof e.toJSON === 'function' ? e.toJSON() : { ...e };
        return {
          event_type: p.event_type,
          to_status: p.to_status,
          at: p.createdAt ?? p.created_at,
        };
      }),
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
        // DEV-209：同上 —— 系统时间字段是 `createdAt/updatedAt`；`closed_at` 是**自定义字段**，
        // 属性名保持 snake，所以它一直是对的（这正是根因的反证）。
        created_at: t.createdAt ?? t.created_at,
        updated_at: t.updatedAt ?? t.updated_at,
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
        /**
         * UX-PROGRESS-01：**客户可理解的阶段**（5 个里程碑 + 取消分支）。
         * 只给"到哪一步了、现在等谁"，**不给百分比** —— 百分比没有真实分母，
         * 编一个只会让客户按错误预期等待。
         */
        progress,
        /**
         * 当前服务师傅（最小投影）。
         * 没有有效派工 ⇔ null；有派工但无对客电话 ⇔ phone=null + contact_hint。
         */
        technician,
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
