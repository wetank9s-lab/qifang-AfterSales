/**
 * 内部业务 action：**调整已有工单的紧急标记**（Phase 11 / P11-2 · 用户 2026-10-10 第 3 项）
 *
 *   POST /api/svc:setUrgent?filterByTk=<ticketId>
 *   body: { "urgent": true|false, "reason": "（终态工单必填）" }
 *
 * ===========================================================================
 * 用户原话与落点
 * ===========================================================================
 * 「尚未看到"授权门店员工可以**调整已有服务单**的 urgent"…… 请在服务详情中提供
 *   简洁的紧急/普通调整入口，**按原有门店写权限裁决**，记录**原值、新值及操作者**。
 *   不得为此增加列表按钮墙；**跨店调整必须拒绝**，**终态工单不得无依据修改**。」
 *
 * | 要求 | 落点 |
 * |---|---|
 * | 按原有门店写权限裁决 | `permissions.assertCanWriteTicket(actor, ticketId)` —— **复用**那一条路径，不另写判断 |
 * | 跨店必须拒绝 | 同上：门店范围不在 `storeIds` 里 ⇒ **404**（与"不存在"同形，不泄露存在性） |
 * | 记录原值 / 新值 / 操作者 | 服务层写事件：`metadata {field,from,to,reason}` + `operator_user_id` = 真实操作人 |
 * | 终态不得无依据修改 | 服务层：`CLOSED`/`CANCELLED` 下缺 `reason` ⇒ 422 `MISSING_REASON` |
 * | 不增加列表按钮墙 | 入口在**服务详情抽屉**里（见客户端 `ticket-drawer.tsx`），列表行内动作**一个字不加** |
 *
 * ⚠️ 越权与不存在**同形**（都 404）是本项目读侧的既有纪律；
 *    写侧的 `svc:createTicket` 用 403 是因为那是"操作意图"（见其文件头）。
 *    本动作针对**一个已存在的对象**，所以沿用 404 —— 与 `accept`/`cancel` 一致。
 */
import { INTERNAL_WRITE_SCENE, SVC_ACTION } from '../../constants';
import { fail, ok } from './_http';
import {
  createWrapper,
  param,
  replay,
  requireRequestId,
  requireTicketId,
  usernameOf,
  writeIdempotencyOf,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

export function createTicketUrgentHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services } = deps;
  const { permissions, tickets } = services;
  const wrap = createWrapper(deps);

  const setUrgent = wrap('setUrgent', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'setUrgent');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);

    // ① **原有门店写权限裁决**：能力（只读角色 403）+ 门店范围（跨店 404）
    await permissions.assertCanWriteTicket(actor, ticketId);

    // ② 入参：`urgent` 必须是**真布尔**（`"true"` 这类字符串一律 422，防"悄悄变真"）
    const rawUrgent = param(ctx, 'urgent');
    if (typeof rawUrgent !== 'boolean') {
      fail(
        ctx,
        422,
        'INVALID_URGENT',
        `urgent 必须是布尔（true / false），实际 ${JSON.stringify(rawUrgent ?? null)}`,
        { field: 'urgent' },
      );
      return;
    }
    const rawReason = param(ctx, 'reason');

    const responseOf = (v: { ticket: any; event: any | null; changed: boolean }) => ({
      ticket_id: Number(v.ticket?.id ?? ticketId),
      ticket_no: String(v.ticket?.ticket_no ?? ''),
      urgent: v.ticket?.urgent === true,
      status: String(v.ticket?.status ?? ''),
      // ⚠️ `changed=false` 是**正常结果**（新旧一致）：不写事件、不伪造审计
      changed: v.changed === true,
      event_id: v.event ? Number(v.event.id) : null,
    });

    const outcome = await tickets.setUrgentFlag(
      ticketId,
      { urgent: rawUrgent, reason: rawReason as string | undefined },
      { userId: actor.userId, username: usernameOf(actor) },
      writeIdempotencyOf({
        scene: INTERNAL_WRITE_SCENE.SET_URGENT,
        ticketId,
        actor,
        requestId,
        // ⚠️ responseOf 必须能重跑第二遍：只依赖入参，绝不读"当前状态"
        responseOf: (value: any) => responseOf(value),
      }),
    );

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    ok(ctx, responseOf(outcome.value));
  });

  return { [SVC_ACTION.SET_URGENT]: setUrgent };
}
