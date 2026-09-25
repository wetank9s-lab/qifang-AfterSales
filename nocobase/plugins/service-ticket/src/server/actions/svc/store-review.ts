/**
 * Phase 6 · P6-1：门店**写**接口（I12 confirm / I13 reject）。
 *
 * 对外路径（`docs/API.md` §4 的 I12 / I13；`docs/PHASE-6.md` §7）：
 *   · `POST /api/svc/visits/:id/confirm` → nginx 重写成 `/api/svc:visitConfirm?filterByTk=<visitId>`
 *   · `POST /api/svc/visits/:id/reject`  → nginx 重写成 `/api/svc:visitReject?filterByTk=<visitId>`
 *
 * ⚠️ nginx 的两段式 rewrite **必须排在** `/api/svc/visits/:id`（I11 只读）**之前**，
 *    否则会静默打到 I11 上（契约 §2.1 / 门禁 C2）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 本文件刻意**不做**的事
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ① **不发送评价短信、不创建评价 SmsLog**（O1-B，`docs/DEVIATIONS.md` DEV-85）。
 *    代码里**没有**这条路径 —— 不是"配置默认关"，因此谁也打不开（§11.2）。
 * ② **响应体不含评价 Token / 链接**（§11.6）：明文只活在本次调用的内存里，
 *    落库只有 hash。少返回一个字段，就少一条泄漏通道。
 * ③ **不做 UI**：按钮属 P6-2，本阶段只到"接口可用 + 可被脚本验证"。
 *
 * 鉴权链（顺序固定）：登录身份 → resolveActor → Visit→Ticket 归属 →
 * `assertCanWriteTicket`（无写能力 403；跨店/越权 **404 与不存在同形**）→ 业务事务。
 */
import { SVC_ACTION } from '../../constants';
import { setFaultInjectionForTests } from '../../services/ticket-service';
import { fail, ok } from './_http';
import {
  createWrapper,
  param,
  paramsOf,
  replay,
  requireRequestId,
  writeIdempotencyOf,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

/** 409 载荷只保留这些字段（契约 L1：绝不把 ORM 对象整只序列化出去） */
const SAFE_STATE_FIELDS = ['visit_status', 'store_confirm_status', 'ticket_status'];

/** 从重写后的 `filterByTk` 取 Visit id（I12/I13 的 `:id` 是 **Visit id**，不是 ticket id） */
function requireVisitId(ctx: any): number | null {
  const raw = paramsOf(ctx)?.filterByTk ?? param(ctx, 'visit_id');
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createStoreReviewHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services } = deps;
  const { permissions, visits, tickets } = services;
  const wrap = createWrapper(deps);

  /**
   * I12 —— 门店**确认**回执。
   *
   * 金额口径（契约 L3 / O4）：金额由 **Visit 的服务事实 `is_charged`** 定夺，
   * 不是只验"请求里带的金额合不合法"；不收费时落 **NULL**，客户端偷传 amount ⇒ 422。
   * 具体校验在 `VisitService.confirmVisit()`（服务层是权威校验，action 只做取参与编排）。
   */
  const visitConfirm = wrap(SVC_ACTION.VISIT_CONFIRM, async (ctx, actor) => {
    const requestId = requireRequestId(ctx, SVC_ACTION.VISIT_CONFIRM);
    if (!requestId) return;

    const visitId = requireVisitId(ctx);
    if (!visitId) {
      fail(ctx, 422, 'VALIDATION_FAILED', '缺少合法的 Visit id', { field: 'id' });
      return;
    }

    const visit = await visits.findById(visitId);
    if (!visit) {
      fail(ctx, 404, 'VISIT_NOT_FOUND', '上门记录不存在');
      return;
    }
    const ticketId = Number(visit.ticket_id);
    // 跨店/越权 ⇒ 404，与"不存在"同形（契约 C3）
    await permissions.assertCanWriteTicket(actor, ticketId);

    const rawAmount = param(ctx, 'amount');
    const amount =
      rawAmount === undefined || rawAmount === null || rawAmount === ''
        ? null
        : Number(rawAmount);
    if (amount !== null && !Number.isFinite(amount)) {
      fail(ctx, 422, 'VALIDATION_FAILED', 'amount 必须是数字', { field: 'amount' });
      return;
    }
    const noteRaw = param(ctx, 'note');
    const note = typeof noteRaw === 'string' ? noteRaw : null;

    const outcome = await tickets.confirmVisit(ticketId, visitId, actor, { amount, note }, {
      ...writeIdempotencyOf({
        scene: 'svc_confirm',
        ticketId,
        visitId,
        actor,
        requestId,
        responseOf: (value) => ({
          ticket: permissions.maskTicketForActor(value.ticket, actor),
          visit: {
            id: value.visit.id,
            visit_no: value.visit.visit_no,
            visit_status: value.visit.visit_status,
            store_confirm_status: value.visit.store_confirm_status,
            confirmed_charge_amount: value.visit.confirmed_charge_amount ?? null,
          },
          event: { id: value.event?.id ?? null, event_type: value.event?.event_type ?? null },
        }),
      }),
    });

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    ok(ctx, {
      ticket: permissions.maskTicketForActor(outcome.value.ticket, actor),
      visit: {
        id: outcome.value.visit.id,
        visit_no: outcome.value.visit.visit_no,
        visit_status: outcome.value.visit.visit_status,
        store_confirm_status: outcome.value.visit.store_confirm_status,
        confirmed_charge_amount: outcome.value.visit.confirmed_charge_amount ?? null,
      },
      event: {
        id: outcome.value.event?.id ?? null,
        event_type: outcome.value.event?.event_type ?? null,
      },
    });
  });

  /** I13 —— 门店**驳回**回执（与 Review Token 彻底解耦，契约 L4）。 */
  const visitReject = wrap(SVC_ACTION.VISIT_REJECT, async (ctx, actor) => {
    const requestId = requireRequestId(ctx, SVC_ACTION.VISIT_REJECT);
    if (!requestId) return;

    const visitId = requireVisitId(ctx);
    if (!visitId) {
      fail(ctx, 422, 'VALIDATION_FAILED', '缺少合法的 Visit id', { field: 'id' });
      return;
    }

    const reasonRaw = param(ctx, 'reason');
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (reason.length < 1) {
      fail(ctx, 422, 'MISSING_REJECT_REASON', '驳回必须填写原因', { field: 'reason' });
      return;
    }

    const visit = await visits.findById(visitId);
    if (!visit) {
      fail(ctx, 404, 'VISIT_NOT_FOUND', '上门记录不存在');
      return;
    }
    const ticketId = Number(visit.ticket_id);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const outcome = await tickets.rejectVisit(ticketId, visitId, actor, { reason }, {
      ...writeIdempotencyOf({
        scene: 'svc_reject',
        ticketId,
        visitId,
        actor,
        requestId,
        responseOf: (value) => ({
          ticket: permissions.maskTicketForActor(value.ticket, actor),
          visit: {
            id: value.visit.id,
            visit_no: value.visit.visit_no,
            visit_status: value.visit.visit_status,
            store_confirm_status: value.visit.store_confirm_status,
          },
          event: { id: value.event?.id ?? null, event_type: value.event?.event_type ?? null },
        }),
      }),
    });

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    ok(ctx, {
      ticket: permissions.maskTicketForActor(outcome.value.ticket, actor),
      visit: {
        id: outcome.value.visit.id,
        visit_no: outcome.value.visit.visit_no,
        visit_status: outcome.value.visit.visit_status,
        store_confirm_status: outcome.value.visit.store_confirm_status,
      },
      event: {
        id: outcome.value.event?.id ?? null,
        event_type: outcome.value.event?.event_type ?? null,
      },
    });
  });

  return { [SVC_ACTION.VISIT_CONFIRM]: visitConfirm, [SVC_ACTION.VISIT_REJECT]: visitReject };
}

/**
 * **C23 故障注入闸门**（验收设施，非业务接口）。
 *
 * ⚠️ 它只翻转**进程级**的一个开关，业务请求的参数**一律不认**（契约 **C23b**）：
 *    否则任何人只要在请求里多带一个字段，就能人为打挂一次门店确认。
 * 这里的形态与 `guardQuota` 相同：**共享密钥闸**（`X-Svc-Diag-Key` == `SIGN_SECRET`），
 * 不匹配一律 404（对外表现为"不存在"）。
 */
export function createFaultInjectHandler(): ActionHandler {
  return async (ctx: any) => {
    // ⚠️ 与 guardQuota 同一道闸：**共享密钥**（不在请求参数里比对的那种"配置开关"，
    //    而是"有没有密钥"）。且它**不进匿名白名单** ⇒ 必须先登录，再持密钥。
    const expected = String(process.env.SIGN_SECRET ?? '').trim();
    const provided = String(ctx?.get?.('X-Svc-Diag-Key') ?? '').trim();
    if (!expected || provided !== expected) {
      // 与 guardQuota 同口径：语义唯一 —— 对外就是"没有这个接口"
      fail(ctx, 404, 'NOT_FOUND', 'Not Found');
      return;
    }
    const raw = param(ctx, 'enabled');
    const enabled = raw === true || raw === 'true' || raw === '1' || raw === 1;
    setFaultInjectionForTests(enabled);
    ok(ctx, { enabled });
  };
}
