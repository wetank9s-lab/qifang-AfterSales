/**
 * 客户评价接口（Phase 7）
 *
 * 对外路径（nginx 重写后）：
 *   GET  /api/public/reviews/:token   打开评价页 → 最小上下文
 *   POST /api/public/reviews/:token   提交评价
 *
 * ---------------------------------------------------------------------------
 * 为什么这里的错误处理**不**按 HTTP 状态码猜语义
 * ---------------------------------------------------------------------------
 * 后端对"已评价 / 已过期 / 非法链接"给了三个**稳定且不同**的业务码：
 *   409 REVIEW_ALREADY_SUBMITTED · 410 REVIEW_EXPIRED · 404 REVIEW_NOT_FOUND
 * 页面按 `code` 分支即可。状态码只作为兜底（例如网关返回 HTML）。
 * 这与 `utils/` 里其它页面同一口径：**只有一个维度做判定**。
 *
 * ---------------------------------------------------------------------------
 * 为什么提交**不**带 X-Request-Id 幂等键
 * ---------------------------------------------------------------------------
 * 与报修单（`/api/public/tickets`）**刻意不同**。报修是"一次用户意图可能被
 * 重试成两单"（所以要幂等键）；评价的幂等性由**服务端的条件更新**保证 ——
 * 同一枚 Token 只能在
 *   `status='WAIT_FEEDBACK' AND review_status='pending' AND feedback_token_used_at IS NULL`
 * 时成功一次，之后必然 409。也就是说**重复提交天然被拒**，
 * 再加一层幂等键只是多一个可以不一致的状态。
 * 这也解释了为什么后端 POST 不收 `X-Svc-Request-Id`（契约 §3）。
 */
import { request, type ApiError } from './http';

/** 评价页状态（服务端 REVIEW_PAGE_STATE，必须逐字一致） */
export type ReviewPageState = 'pending' | 'submitted' | 'expired';

/** 收费核对三态（服务端 CHARGE_MATCH，必须逐字一致） */
export type ChargeMatch = 'match' | 'mismatch' | 'not_applicable';

/** `GET /api/public/reviews/:token` 的响应（服务端只回最小上下文） */
export interface ReviewContext {
  ticket_no: string;
  /**
   * 门店显示名。
   * ⚠️ 服务端字段名是 `store_display_name`（**不是** `store_name`）——
   *    门店在本项目里没有独立表，显示名是由 `storeDisplayNameOf()` 推导的，
   *    字段名刻意带上 `display` 以区别于"数据库里的门店字段"。
   */
  store_display_name: string;
  /** 服务事项摘要（`{类型}·{前 30 字}`），**不是**报修原文全文 */
  service_summary: string;
  /**
   * 门店最终确认的收费事实。
   * `null` = 本次未收费（≠ 0.00）；客户端据此决定收费核对区怎么渲染。
   * ⚠️ 但这只是**展示用**：真正的规则由服务端裁决（见 `submitReview`），
   *    页面即便渲染错了，服务端也会拒。
   */
  confirmed_charge_amount: number | null;
  review_state: ReviewPageState;
  can_review: boolean;
  /** 是否走"已收费"分支（服务端直接下发，页面不再自己从金额推断） */
  is_charged: boolean;
}

export interface SubmitReviewPayload {
  rating: number;
  comment?: string | null;
  charge_match: ChargeMatch;
  customer_reported_amount?: number | null;
}

export interface SubmitReviewResult {
  ticket_no: string;
  rating: number;
  closed: boolean;
  reopened: boolean;
}

export function fetchReviewContext(token: string, signal?: AbortSignal): Promise<ReviewContext> {
  return request<ReviewContext>(`/api/public/reviews/${encodeURIComponent(token)}`, { signal });
}

export function submitReview(
  token: string,
  payload: SubmitReviewPayload,
  signal?: AbortSignal,
): Promise<SubmitReviewResult> {
  return request<SubmitReviewResult>(`/api/public/reviews/${encodeURIComponent(token)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

/**
 * 把错误码翻成**给客户看的一句话**。
 *
 * ⚠️ 客户不是运维，任何"请重试"只有在**真的值得重试**时才该出现。
 *    下列终局态一律不给重试入口 —— 重试一百次也还是同一个结果，
 *    给了按钮等于让客户怀疑自己操作错了。
 */
export function reviewErrorMessageOf(error: unknown): {
  message: string;
  retryable: boolean;
  terminal: ReviewPageState | null;
} {
  const code = (error as ApiError)?.code ?? '';
  switch (code) {
    case 'REVIEW_NOT_FOUND':
      return { message: '评价链接无效或已失效，请与门店确认后重新获取。', retryable: false, terminal: null };
    case 'REVIEW_EXPIRED':
      return { message: '评价时间已结束，该服务已自动结单。如需帮助请联系门店。', retryable: false, terminal: 'expired' };
    case 'REVIEW_ALREADY_SUBMITTED':
      return { message: '您已提交过评价，感谢您的反馈。', retryable: false, terminal: 'submitted' };
    case 'REVIEW_NOT_AVAILABLE':
      return { message: '当前工单状态不支持评价，请联系门店。', retryable: false, terminal: null };
    case 'CHARGE_MATCH_NOT_APPLICABLE':
      return { message: '本次服务未收费，收费核对请选择「未收费」。', retryable: true, terminal: null };
    case 'CHARGE_MATCH_REQUIRED':
      return { message: '本次服务已收费，请确认金额是否一致。', retryable: true, terminal: null };
    case 'MISSING_CUSTOMER_AMOUNT':
      return { message: '请填写您实际支付的金额。', retryable: true, terminal: null };
    case 'AMOUNT_NOT_ALLOWED':
      return { message: '该选项不需要填写金额。', retryable: true, terminal: null };
    case 'INVALID_CUSTOMER_AMOUNT':
      return { message: '金额格式不正确，请重新填写。', retryable: true, terminal: null };
    case 'INVALID_RATING':
      return { message: '请先选择 1–5 星的评分。', retryable: true, terminal: null };
    case 'INVALID_REVIEW_COMMENT':
      return { message: '评价内容过长，请精简后重试。', retryable: true, terminal: null };
    case 'RATE_LIMITED':
      return { message: '提交过于频繁，请稍等一会儿再试。', retryable: true, terminal: null };
    case 'NETWORK_ERROR':
      return { message: '网络异常，请检查网络后重试。', retryable: true, terminal: null };
    default:
      return { message: '提交失败，请稍后重试；若反复失败请联系门店。', retryable: true, terminal: null };
  }
}
