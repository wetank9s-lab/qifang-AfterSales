/**
 * 工单适配器（TicketApiAdapter）
 *
 * ===========================================================================
 * 职责边界
 * ===========================================================================
 *   本文件**只做**三件事：
 *     ① 把服务端字段映射成界面需要的最小子集（并给出强类型）；
 *     ② 把 UI 的筛选意图翻译成 NocoBase 的 filter 语法；
 *     ③ 屏蔽"同一个动作要带 X-Request-Id"这类协议细节。
 *
 *   它**不做**：权限判断、数据裁剪、状态推断。
 *   列表返回什么，由服务端 ACL 与 filter 决定 —— 前端不接受"多查一点再筛"这种做法。
 *
 * ===========================================================================
 * 一个必须记录的坑：状态值大小写
 * ===========================================================================
 *   生产库 `service_tickets.status` 同时存在 `new`(4 条) 与 `NEW`(243 条)。
 *   若筛选只写 `NEW`，那 4 条会在"待受理"分组里凭空消失，
 *   而分组计数（来自服务端的 meta.count）却会把它算进去
 *   ⇒ 界面出现"待受理 247，点进去只有 243 条"的自相矛盾。
 *
 *   ⇒ 所以 `statusIn()` 对**已知会被写错的值**做大小写扩展。
 *     这不是"前端猜数据"，而是把一条已发生的脏数据事实固化在查询里。
 */

import { listRequest, request, qs, type ListResult } from './http';

/** 工单行（服务端 `serviceTickets:list` 的字段子集） */
export interface TicketRow {
  id: number;
  ticket_no: string | null;
  content: string | null;
  customer_name: string | null;
  customer_mobile: string | null;
  status: string;
  ticket_type: string | null;
  appliance_category: string | null;
  service_address: string | null;
  store_id: number | null;
  urgent: boolean | null;
  expected_visit_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  technician_name: string | null;
  next_follow_at: string | null;
  rating: number | null;
  review_status: string | null;
}

/** 详情（`svc:timeline` 返回，服务端已按角色脱敏） */
export interface TicketDetail {
  ticket: TicketRow & {
    handler_user_id?: number | null;
    service_mode?: string | null;
    provider_name?: string | null;
    technician_mobile?: string | null;
    dispatch_at?: string | null;
    completion_result?: string | null;
    completion_note?: string | null;
    completed_at?: string | null;
    review_comment?: string | null;
    reviewed_at?: string | null;
    close_reason?: string | null;
    first_response_at?: string | null;
    closed_at?: string | null;
    escalated?: boolean | null;
    reopen_count?: number | null;
    brand_model?: string | null;
    source?: string | null;
  };
  events: TicketEvent[];
  sms: SmsRow[];
  count: number;
  page: number;
  pageSize: number;
}

export interface TicketEvent {
  id: number;
  event_type: string | null;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  operator_name: string | null;
  created_at: string | null;
}

export interface SmsRow {
  id: number;
  scene: string | null;
  template_code: string | null;
  send_status: string | null;
  delivery_status: string | null;
  created_at: string | null;
}

/** 列表筛选意图（UI 语义，不是数据库语义） */
export interface TicketFilter {
  /** 状态分组；空数组 = 全部 */
  statuses?: string[];
  /** 关键词（工单号 / 客户 / 电话 / 内容） */
  keyword?: string;
  /** 仅看紧急 */
  urgent?: boolean;
  /** 仅看今日到期跟进 */
  dueToday?: boolean;
}

/**
 * 状态 → 查询条件。
 *
 * ⚠️ 大小写扩展只对 `new` 做 —— 因为只有它被实测证实存在两种写法。
 *    对其它状态做同样的扩展是**无根据的猜测**，会让"我以为在修 bug、
 *    实际在制造一个永远不会命中的分支"。
 */
function statusIn(statuses: string[]): unknown {
  const out: unknown[] = [];
  for (const s of statuses) {
    out.push({ status: s });
    if (s === 'NEW') out.push({ status: 'new' });
    if (s === 'new') out.push({ status: 'NEW' });
  }
  return out.length === 1 ? out[0] : { $or: out };
}

function buildFilter(f: TicketFilter): Record<string, unknown> {
  const and: unknown[] = [];

  if (f.statuses && f.statuses.length > 0) {
    and.push(statusIn(f.statuses));
  }

  if (f.urgent) and.push({ urgent: true });

  if (f.dueToday) {
    // 今日到期跟进：next_follow_at 落在今天（本地日界）
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    and.push({ next_follow_at: { $gte: start.toISOString(), $lt: end.toISOString() } });
  }

  const kw = f.keyword?.trim();
  if (kw) {
    // ⚠️ `$includes` 是 PG 的 ILIKE '%x%'。这里**没有**做任何 SQL 拼接，
    //    值走参数化，所以不存在注入。
    and.push({
      $or: [
        { ticket_no: { $includes: kw } },
        { customer_name: { $includes: kw } },
        { customer_mobile: { $includes: kw } },
        { content: { $includes: kw } },
      ],
    });
  }

  if (and.length === 0) return {};
  if (and.length === 1) return and[0] as Record<string, unknown>;
  return { $and: and };
}

function sortParam(sort: string): string {
  return `sort=${encodeURIComponent(sort)}`;
}

/**
 * 工单字段**白名单**（列表与详情共用）。
 *
 * ⚠️ 这是白名单不是黑名单：只列出界面真正要显示的键。
 *    任何服务端新增的字段（尤其 `*_hash` / `*_salt` / `*_secret`）
 *    默认**不会**进入前端状态。见 `detail()` 顶部注释。
 */
const TICKET_KEYS: (keyof TicketRow & string)[] = [
  'id', 'ticket_no', 'content', 'customer_name', 'customer_mobile', 'status',
  'ticket_type', 'appliance_category', 'service_address', 'store_id', 'urgent',
  'expected_visit_at', 'created_at', 'updated_at', 'technician_name',
  'next_follow_at', 'rating', 'review_status',
];

/** 详情额外允许的键（仍然逐个列出，不用 spread） */
const TICKET_DETAIL_EXTRA = [
  'handler_user_id', 'service_mode', 'provider_name', 'technician_mobile',
  'dispatch_at', 'completion_result', 'completion_note', 'completed_at',
  'review_comment', 'reviewed_at', 'close_reason', 'first_response_at',
  'closed_at', 'escalated', 'reopen_count', 'brand_model', 'source',
] as const;

function slimTicket(row: any): any {
  if (!row || typeof row !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const k of [...TICKET_KEYS, ...TICKET_DETAIL_EXTRA]) {
    if (k in row) out[k] = row[k];
  }
  return out;
}

function slimEvent(e: any): TicketEvent {
  return {
    id: Number(e?.id ?? 0),
    event_type: e?.event_type ?? null,
    from_status: e?.from_status ?? null,
    to_status: e?.to_status ?? null,
    note: e?.note ?? null,
    operator_name: e?.operator_name ?? null,
    created_at: e?.created_at ?? null,
  };
}

/**
 * 短信摘要白名单。
 * ⚠️ 不下发 `provider_biz_id` / `provider_request_id` / 收件人号码 ——
 *    界面只需要"发没发、什么场景"。
 */
function slimSms(s: any): SmsRow {
  return {
    id: Number(s?.id ?? 0),
    scene: s?.scene ?? null,
    template_code: s?.template_code ?? null,
    send_status: s?.send_status ?? null,
    delivery_status: s?.delivery_status ?? null,
    created_at: s?.created_at ?? null,
  };
}

export const TicketApiAdapter = {
  /**
   * 列表。`meta.count` 是状态计数的**唯一**来源。
   *
   * ⚠️ `fields` 参数是**显式白名单**：不拉 `feedback_token_hash` 等凭据列。
   *    这既减体积，也让"服务端哪天 ACL 松了"不至于变成前端可见的凭据。
   */
  async list(filter: TicketFilter, page = 1, pageSize = 20): Promise<ListResult<TicketRow>> {
    const f = buildFilter(filter);
    const path = qs('/serviceTickets:list', {
      page,
      pageSize,
      filter: JSON.stringify(f),
      fields: TICKET_KEYS.join(','),
    });
    return listRequest<TicketRow>(`${path}&${sortParam('-created_at,-id')}`);
  },

  /**
   * 各状态计数。
   *
   * ⚠️ 用 `$in` 拿不到**逐状态**数字（`$in` 只给一个合计），所以必须分状态并发查。
   *    每个请求 `pageSize=1`，只读 `meta.count` —— 传输量最小。
   *
   * ⚠️ 不要改成"拉全量到前端数"：543 条时那等于把整张表下载到浏览器，
   *    而且前端数出来的数字与服务端 `count` 一旦不一致，
   *    界面上会出现"分组显示 247、列表只有 243"的自相矛盾。
   */
  async counts(statuses: string[]): Promise<Record<string, number>> {
    const entries = await Promise.all(
      statuses.map(async (s) => {
        const r = await listRequest<TicketRow>(
          qs('/serviceTickets:list', {
            pageSize: 1,
            page: 1,
            filter: JSON.stringify(statusIn([s])),
            fields: 'id',
          }),
        );
        return [s, r.total] as const;
      }),
    );
    return Object.fromEntries(entries);
  },

  /**
   * 详情（时间线）。
   *
   * ⚠️⚠️ 这里必须做**字段白名单收敛**，不能把服务端响应原样透传给界面。
   *
   *   实测（2026-11-12，`.tmp-verify/tl.json`）：`svc:timeline` 的 `ticket`
   *   共 48 个字段，其中**包含**：
   *     progress_token_hash     —— 客户进度查询链接的凭据哈希
   *     progress_code_salt      —— 短码盐
   *     progress_code_hash      —— 短码哈希
   *   （即已登记的缺陷 `P6-API-DTO-SENSITIVE-01`）
   *
   *   这些值**不是明文 Token**，但哈希+盐的组合足以对一枚 22 位短码做离线爆破。
   *   服务端将来收敛它是正解，但**本前端不能等它**：
   *   · 界面根本不需要它们；
   *   · 一旦进了 React state，它们会出现在 devtools、错误上报、
   *     以及"某个同事顺手 console.log(ticket)"里；
   *   · 收窄成本近乎为零。
   *
   *   ⇒ `slimTicket()` 是**白名单**（只保留下面列出的键），不是黑名单。
   *     黑名单会漏 —— 服务端下次再加一个 `xxx_secret` 就自动透传了。
   */
  async detail(id: number | string): Promise<TicketDetail> {
    const raw = await request<TicketDetail>(qs('/svc:timeline', { filterByTk: id, pageSize: 50 }));
    return {
      ticket: slimTicket(raw?.ticket),
      events: Array.isArray(raw?.events) ? raw.events.map(slimEvent) : [],
      sms: Array.isArray(raw?.sms) ? raw.sms.map(slimSms) : [],
      count: Number(raw?.count ?? 0) || 0,
      page: Number(raw?.page ?? 1) || 1,
      pageSize: Number(raw?.pageSize ?? 0) || 0,
    };
  },

  /** 今日待办队列（到期 / 逾期跟进）。 */
  async followUpQueue(limit = 50): Promise<TicketRow[]> {
    const r = await request<any>(qs('/svc:followUpQueue', { limit }));
    const items = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
    return items.map((x: any) => slimTicket(x));
  },

  /** 受理 */
  async accept(id: number, requestId: string): Promise<void> {
    await request(qs('/svc:accept', { filterByTk: id }), {
      method: 'POST',
      body: {},
      withRequestId: true,
      requestId,
    });
  },

  /** 派工：新建 Visit + 签发师傅 Token（服务端会给业主/师傅发短信） */
  async dispatch(
    id: number,
    input: { technician_name: string; technician_mobile: string; expected_visit_at?: string; note?: string },
    requestId: string,
  ): Promise<void> {
    await request(qs('/svc:dispatch', { filterByTk: id }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /** 改派 */
  async reassign(
    id: number,
    input: { technician_name: string; technician_mobile: string; expected_visit_at?: string; reason?: string },
    requestId: string,
  ): Promise<void> {
    await request(qs('/svc:reassign', { filterByTk: id }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /** 改约（不新建 Visit，仅改时间并重签 Token） */
  async reschedule(
    id: number,
    input: { expected_visit_at: string; reason?: string },
    requestId: string,
  ): Promise<void> {
    await request(qs('/svc:reschedule', { filterByTk: id }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /** 门店确认（审核师傅回执） */
  async visitConfirm(id: number, input: { visit_id: number; note?: string }, requestId: string): Promise<void> {
    await request(qs('/svc:visitConfirm', { filterByTk: id }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /** 驳回 */
  async visitReject(id: number, input: { visit_id: number; reason: string }, requestId: string): Promise<void> {
    await request(qs('/svc:visitReject', { filterByTk: id }), {
      method: 'POST',
      body: input,
      withRequestId: true,
      requestId,
    });
  },

  /** 内部备注（纯追加，不改状态） */
  async note(id: number, note: string, requestId: string): Promise<void> {
    await request(qs('/svc:internalNote', { filterByTk: id }), {
      method: 'POST',
      body: { note },
      withRequestId: true,
      requestId,
    });
  },

  /** 派工历史 / Visit 列表 */
  async visits(id: number): Promise<any[]> {
    const r = await request<any>(qs('/svc:visits', { filterByTk: id }));
    return Array.isArray(r?.visits) ? r.visits : Array.isArray(r) ? r : [];
  },
};
