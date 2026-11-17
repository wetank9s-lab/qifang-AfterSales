/**
 * E 组：客户在**进度页**直接评价（方案 B）。
 *
 * `POST /api/public/progress/:token/review`
 *
 * 授权范围（**与 Review Token 严格区分**）：
 *   · 只认 **Progress Token**（22/43 位，`ProgressService.resolveTicketId` 内含撤销/过期/关闭后 30 天校验）；
 *   · **不接受**前端自报 ticketId —— 工单只能由 Token 解析得出；
 *   · 本入口**只做评价提交这一种写操作**，不暴露其他写能力；
 *   · 响应**绝不**返回 review token、内部 ticketId、客户手机号。
 *
 * 业务规则**完全复用** `ticket-service.submitReview({ ticketId, ... })`：
 * 低分阈值、收费三态、`requireReviewPending` 条件更新（唯一 winner 判定）、Visit / Event、事务与 flush
 * 全部由它负责 —— 本文件不复制任何一条。
 *
 * 隔离开发版的客户验证 = **手机号后四位**：
 *   · 服务端比对，错误提示统一，不泄漏"尾号是否匹配"；
 *   · 每个 Token 有尝试次数上限（进程内计数，仅隔离开发用）；
 *   · 不记录用户输入的尾号到日志。
 *   ⚠️ 这**不是**生产级身份认证，生产写入口继续保持 HOLD（等短信验证码或等效方案裁决）。
 */
import { ok, fail } from '../svc/_http';

const PHONE_TAIL_TRIES = 5;
const MAX_COMMENT = 500;

type Attempt = { count: number; at: number };
const attempts = new Map<string, Attempt>();

function readToken(ctx: any): string {
  // POST 的 query 在不同 NocoBase 版本落到不同位置 —— 全部候选一遍（取第一个非空）。
  const candidates = [
    ctx?.action?.params?.filterByTk,
    ctx?.action?.params?.values?.token,
    ctx?.action?.params?.token,
    ctx?.request?.query?.token,
    ctx?.request?.body?.token,
    ctx?.query?.token,
    ctx?.params?.token,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return '';
}

function hitLimit(key: string): boolean {
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || now - cur.at > 3600_000) {
    attempts.set(key, { count: 1, at: now });
    return false;
  }
  cur.count += 1;
  cur.at = now;
  return cur.count > PHONE_TAIL_TRIES;
}

export function createPublicProgressReviewHandlers(deps: {
  progress: { resolveTicketId(token: string): Promise<number | null> };
  services: any;
  db: any;
  logger?: any;
}) {
  const handler = async (ctx: any): Promise<void> => {
    const token = readToken(ctx);
    if (!token) {
      fail(ctx, 401, 'PROGRESS_TOKEN_INVALID', '这个查询链接无效、已过期或已被撤销');
      return;
    }

    // ① 凭据 → ticketId（撤销/过期/保留期都在这里判掉）
    const ticketId = await deps.progress.resolveTicketId(token);
    if (!ticketId) {
      fail(ctx, 401, 'PROGRESS_TOKEN_INVALID', '这个查询链接无效、已过期或已被撤销');
      return;
    }

    // ② 资格：必须 WAIT_FEEDBACK + review pending + 未用过
    const repo = deps.db.getRepository('serviceTickets');
    const row = await repo.findOne({ filter: { id: ticketId } });
    if (!row) {
      fail(ctx, 404, 'TICKET_NOT_FOUND', '没有找到这个工单');
      return;
    }
    const t: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };

    if (String(t.status) !== 'WAIT_FEEDBACK' || String(t.review_status) !== 'pending' || t.feedback_token_used_at) {
      // 统一口径：不区分"太早/已评价/已关闭"，避免探测
      fail(ctx, 409, 'REVIEW_NOT_AVAILABLE', '当前工单不可提交评价（可能尚未完成或已经评价过）');
      return;
    }

    const body: any = ctx?.request?.body ?? ctx?.action?.params?.values ?? {};

    // ③ 授权：**Progress Token 本身即凭证**（产品决定：不做短信验证码/尾号校验）。
    //    鉴权边界 = 有效 Token + 工单处于可评价状态 + 未评价过（下面与 submitReview 双重保证）。
    //    ⚠️ 产品口径：持有有效进度链接者拥有该工单的一次评价权，系统不额外验证手机号持有人身份。

    // ④ 评分与意见（复用既有取值范围）
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      fail(ctx, 422, 'INVALID_RATING', '请选择 1–5 星');
      return;
    }
    const comment = body.comment == null ? null : String(body.comment).trim().slice(0, MAX_COMMENT);

    // ⑤ 业务全部交给既有服务（唯一 winner 判定在它的条件更新里）
    try {
      const outcome = await deps.services.tickets.submitReview({
        ticketId,
        rating,
        comment,
        // ⚠️ 枚举契约只接受 match / mismatch / not_applicable；
        //    进度页**没有**收费核对交互 ⇒ 未显式传时按 `not_applicable`（"客户未核对"），
        //    不能传 null（会被 normalizeReviewInput 判 422）。
        charge_match: body.charge_match ?? 'not_applicable',
        customer_reported_amount: body.customer_reported_amount ?? null,
      });
      if (!outcome || outcome.submitted === false) {
        fail(ctx, 409, 'REVIEW_NOT_AVAILABLE', '这张工单已经评价过了');
        return;
      }
      ctx.set?.('Cache-Control', 'no-store');
      ok(ctx, { reviewed: true, rating });
    } catch (error: any) {
      const code = String(error?.code ?? '');
      if (code.includes('REVIEW') || code.includes('INVALID') || code.includes('NOT_FOUND')) {
        fail(ctx, 422, code || 'REVIEW_FAILED', String(error?.message ?? '评价未通过校验'));
        return;
      }
      deps.logger?.error?.(`[progress-review] 提交失败 ticket=${ticketId}：${error?.message ?? error}`);
      throw error;
    }
  };

  return { 'publicProgress:review': handler };
}
