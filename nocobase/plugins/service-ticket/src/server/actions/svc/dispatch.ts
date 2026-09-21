/**
 * 内部业务 action：派工三动作 + 两个**仅 mock 通道存在**的验收探针
 *
 *   POST /api/svc:dispatch?filterByTk=<id>    M3 首次派工
 *   POST /api/svc:reassign?filterByTk=<id>    M4 改派（旧 Visit 原样保留 + 新建）
 *   POST /api/svc:reschedule?filterByTk=<id>  M5 改约（不新建 Visit，仅换发 Token）
 *   POST /api/svc:tokenCheck                 师傅 Token 校验探针（mock 通道专属）
 *   GET  /api/svc:smsOutbox                  mock 短信发件箱（mock 通道专属）
 *
 * handler 的执行顺序与 ticket.ts 完全一致，**顺序本身就是安全约定**：
 *   1) 解析操作者（未登录 → 401）
 *   2) **能力校验**（只读角色 → 403）
 *   3) **对象级校验**（能写这条工单吗；越权与不存在统一 404）
 *   4) 调服务层写库（工单状态 + Visit + Token + 事件同事务；短信提交后发送）
 *
 * 两个探针为什么要"自带生产环境自毁"：
 *   `tokenCheck` 与 `smsOutbox` 存在的唯一理由是让 Phase 4 的硬门槛
 *   （**改派后旧 Token 必须立即失效**）能在 HTTP 层被证明，并让联调能取回
 *   短信里的作业链接（Token 明文只在短信里，库里只有 sha256）。
 *   它们能做的最坏的事是"拿着一个 Token 问它有效吗"以及"读 mock 发件箱"。
 *   一旦 `sms.provider` 不是 mock，它们立刻返回 **404** ——
 *   不是"忘了删"，而是"在真实通道下不存在"。见 docs/DEVIATIONS.md DEV-41。
 */
import { CAPABILITY } from '../../services/permission-service';
import { INTERNAL_WRITE_SCENE } from '../../constants';
import { ValidationError } from '../../services/ticket-service';
import { fail, ok } from './_http';
// Visit 脱敏与 svc:visits（工单详情抽屉）共用一份，见 _mask.ts 顶部说明
import { maskVisitForActor } from './_mask';
import {
  createWrapper,
  param,
  requireRequestId,
  requirePositiveInt,
  requireTicketId,
  replay,
  usernameOf,
  writeIdempotencyOf,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

/** 发件箱默认返回条数与上限（联调看增量，不做分页） */
const OUTBOX_DEFAULT_LIMIT = 20;
const OUTBOX_MAX_LIMIT = 100;

export function createDispatchActionHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services, logger } = deps;
  const { permissions, tickets, tokens, sms } = services;

  const wrap = createWrapper(deps);

  /**
   * 解析派工类请求的公共入参。
   *
   * 字段名同时接受 **snake_case 与 camelCase**：对外契约（docs/API.md）是 snake_case，
   * 而 NocoBase 后台的自定义动作表单习惯用 camelCase。
   * 只认一种会得到"文档里写着的字段传了却没生效"这种最难查的问题。
   */
  function dispatchInputOf(ctx: any): {
    serviceMode: string;
    providerName: string | null;
    technicianName: string;
    technicianMobile: string;
    expectedVisitAt: string;
    note: string | null;
    reason: string;
  } {
    const pick = (...keys: string[]): unknown => {
      for (const key of keys) {
        const value = param(ctx, key);
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return undefined;
    };

    return {
      serviceMode: String(pick('service_mode', 'serviceMode') ?? '').trim(),
      providerName: (pick('provider_name', 'providerName') as string | undefined) ?? null,
      technicianName: String(pick('technician_name', 'technicianName') ?? '').trim(),
      technicianMobile: String(pick('technician_mobile', 'technicianMobile') ?? '').trim(),
      expectedVisitAt: String(pick('expected_visit_at', 'expectedVisitAt') ?? '').trim(),
      note: (pick('note') as string | undefined) ?? null,
      reason: String(pick('reason') ?? '').trim(),
    };
  }

  // -------------------------------------------------------------------------
  // M3 dispatch
  // -------------------------------------------------------------------------
  const dispatch = wrap('dispatch', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'dispatch');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const responseOf = (result: any) => ({
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      visit: maskVisitForActor(permissions, result.visit, actor),
      event: result.event,
      sms: result.sms,
    });

    const outcome = await tickets.dispatch(ticketId, dispatchInputOf(ctx), {
      userId: actor.userId,
      username: usernameOf(actor),
    }, writeIdempotencyOf({
      scene: INTERNAL_WRITE_SCENE.DISPATCH,
      ticketId,
      actor,
      requestId,
      // responseOf 只依赖 result，因此可以安全地跑两遍（首次与重放取同一形状）
      responseOf,
    }));

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    const result = outcome.value;
    logger.info?.(
      `[svc:dispatch] 工单 ${ticketId} 派工：visit=${result.visit.id} ` +
        `（第 ${result.visit.visit_no} 次，操作者 ${actor.userId}）`,
    );

    ok(ctx, responseOf(result));
  });

  // -------------------------------------------------------------------------
  // M4 reassign
  // -------------------------------------------------------------------------
  const reassign = wrap('reassign', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'reassign');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const input = dispatchInputOf(ctx);
    if (!input.reason) {
      // 改派必须写原因：Visit 的 superseded_reason 直接取它，
      // 空原因的"历史不可覆盖"等于只有时间没有理由，事后无法复盘。
      fail(ctx, 422, 'MISSING_REASON', '改派必须填写原因', { field: 'reason' });
      return;
    }

    const responseOf = (result: any) => ({
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      visit: maskVisitForActor(permissions, result.visit, actor),
      event: result.event,
      sms: result.sms,
    });

    const outcome = await tickets.reassign(ticketId, input, {
      userId: actor.userId,
      username: usernameOf(actor),
    }, writeIdempotencyOf({
      scene: INTERNAL_WRITE_SCENE.REASSIGN,
      ticketId,
      actor,
      requestId,
      responseOf,
    }));

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    const result = outcome.value;
    logger.info?.(
      `[svc:reassign] 工单 ${ticketId} 改派：visit=${result.visit.id} ` +
        `（第 ${result.visit.visit_no} 次，操作者 ${actor.userId}）`,
    );

    ok(ctx, responseOf(result));
  });

  // -------------------------------------------------------------------------
  // M5 reschedule
  // -------------------------------------------------------------------------
  const reschedule = wrap('reschedule', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'reschedule');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const input = dispatchInputOf(ctx);
    if (!input.expectedVisitAt) {
      fail(ctx, 422, 'MISSING_FIELD', '改约必须提供新的上门时间', {
        field: 'expected_visit_at',
      });
      return;
    }
    if (!input.reason) {
      fail(ctx, 422, 'MISSING_REASON', '改约必须填写原因', { field: 'reason' });
      return;
    }

    const responseOf = (result: any) => ({
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      visit: maskVisitForActor(permissions, result.visit, actor),
      event: result.event,
      sms: result.sms,
    });

    const outcome = await tickets.reschedule(
      ticketId,
      { expectedVisitAt: input.expectedVisitAt, reason: input.reason },
      { userId: actor.userId, username: usernameOf(actor) },
      writeIdempotencyOf({
        scene: INTERNAL_WRITE_SCENE.RESCHEDULE,
        ticketId,
        actor,
        requestId,
        responseOf,
      }),
    );

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    const result = outcome.value;
    logger.info?.(
      `[svc:reschedule] 工单 ${ticketId} 改约：visit=${result.visit.id}` +
        `（第 ${result.visit.visit_no} 次，未新建 Visit；操作者 ${actor.userId}）`,
    );

    ok(ctx, responseOf(result));
  });

  // -------------------------------------------------------------------------
  // 探针 1：师傅 Token 校验（仅 mock 通道）
  // -------------------------------------------------------------------------
  const tokenCheck = wrap('tokenCheck', async (ctx, actor) => {
    // 只有总部角色能问"这个 Token 有效吗"：它是排障设施，不是业务流程的一环。
    permissions.assertCapability(actor, CAPABILITY.PRIVILEGED, 'Token 校验探针仅总部角色可用');
    if (!(await assertMockChannel(ctx))) return;

    const raw = String(param(ctx, 'token') ?? '').trim();
    if (!raw) {
      fail(ctx, 422, 'MISSING_TOKEN', '必须提供 token', { field: 'token' });
      return;
    }

    const result = await tokens.verify(raw);

    if (!result.ok) {
      // ⚠️ 对外**只回 code**，不回 reason —— 区分"过期/已用/被改派"等于
      //    给攻击者一个可枚举的探测接口（见 TokenService 文件头第 2 条）。
      //    reason 已经写进应用日志，排障时去那里看。
      ok(ctx, { valid: false, code: result.code });
      return;
    }

    const visit = result.visit;
    ok(ctx, {
      valid: true,
      visit: {
        id: Number(visit.id),
        ticket_id: Number(visit.ticket_id),
        visit_no: Number(visit.visit_no),
        visit_status: String(visit.visit_status),
        service_mode: String(visit.service_mode),
        // ⚠️ 刻意**不回** technician_mobile / 姓名：探针的用途是回答"有效吗"，
        //    多回一个字段就多一份"它被当成业务接口用"的可能。
      },
    });
  });

  // -------------------------------------------------------------------------
  // 探针 2：mock 短信发件箱（仅 mock 通道）
  // -------------------------------------------------------------------------
  const smsOutbox = wrap('smsOutbox', async (ctx, actor) => {
    permissions.assertCapability(actor, CAPABILITY.PRIVILEGED, '短信发件箱仅总部角色可用');
    if (!(await assertMockChannel(ctx))) return;

    const outbox = await sms.mockOutbox();
    if (!outbox) {
      // 理论上不可达（assertMockChannel 已经拦了），保留是为了"取不到实例"时
      // 给出明确失败，而不是抛 TypeError 变成 500。
      fail(ctx, 404, 'NOT_FOUND', '当前短信通道不是 mock，发件箱不存在');
      return;
    }

    const limit = clampLimit(param(ctx, 'limit'));
    const sinceSeq = Number(param(ctx, 'since_seq') ?? param(ctx, 'sinceSeq') ?? 0) || 0;
    const summarized = summarizeOutbox(outbox.list(limit, sinceSeq));

    ok(ctx, {
      provider: 'mock',
      /** 只返回 `seq > since_seq` 的增量，避免历史噪声干扰验收断言 */
      since_seq: sinceSeq,
      last_seq: outbox.lastSeq,
      count: summarized.count,
      items: summarized.items,
    });
  });

  /**
   * 统一的"仅 mock 通道"闸门。
   *
   * 返回 false 表示已经写过 404；调用方直接 return。
   * 用 404 而不是 403 是刻意的：对外表现是"这个接口不存在"，
   * 与"它在这里但从没被授权"相比，前者不给任何"生产环境里有个调试入口"的信号。
   */
  async function assertMockChannel(ctx: any): Promise<boolean> {
    if (await sms.isMockChannel()) return true;
    fail(ctx, 404, 'NOT_FOUND', '接口不存在');
    return false;
  }

  return { dispatch, reassign, reschedule, tokenCheck, smsOutbox };
}

// ---------------------------------------------------------------------------
// 响应装配
// ---------------------------------------------------------------------------

/**
 * Visit 对外脱敏。
 *
 * 师傅手机号按角色脱敏（与工单一视同仁：只有非只读角色能看到完整号码）；
 * 而 **Token 相关列一律剥离** —— 它们在 NATIVE_READ_FIELD_DENY 里被挡，
 * 说明"这两处口径应当一致"：任何走 HTTP 出去的地方都不该带哈希。
 */
function summarizeOutbox(items: any[]): { count: number; items: any[] } {
  return {
    count: items.length,
    items: items.map((entry) => ({
      seq: entry.seq,
      at: entry.at,
      scene: entry.scene,
      recipient_kind: entry.recipientKind,
      recipient_masked: entry.recipientMasked,
      template_code: entry.templateCode || null,
      // ⚠️ preview / params 里含作业链接（内含 Token 明文）—— 这正是本探针存在的理由。
      //    它只在 mock 通道下可达，且需要总部角色（见文件头）。
      preview: entry.preview,
      params: entry.params,
      accepted: entry.accepted,
      biz_id: entry.bizId,
    })),
  };
}

function clampLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return OUTBOX_DEFAULT_LIMIT;
  return Math.min(Math.trunc(num), OUTBOX_MAX_LIMIT);
}
