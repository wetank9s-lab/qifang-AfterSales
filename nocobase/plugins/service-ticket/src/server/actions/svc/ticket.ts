/**
 * 内部业务 action：受理 / 转店 / 取消 / 时间线（docs/API.md §4 的 I1 / I2 / I6 / I10）
 *
 * 每个 handler 的执行顺序是**固定**的四步，顺序本身就是安全约定：
 *
 *   1) 解析操作者（PermissionService.resolveActor）→ 未登录即 401
 *   2) **能力校验**（角色矩阵）→ 只读角色 403
 *   3) **对象级校验**（能访问/能写这条工单吗）→ 越权与不存在统一 404
 *   4) 调服务层写库（状态 + 事件同事务）
 *
 * 之所以把 1~3 放在 action 层而不是服务层：TicketService 会被系统侧调用
 * （定时任务、短信回调），那里没有"用户"，把鉴权塞进去会把两类调用的边界弄糊。
 * 见 ticket-service.ts 顶部第 3 条。
 *
 * JSON 响应契约（成功）：
 *   accept   → { data: { ticket, event } }
 *   transfer → { data: { ticket, event, previous_store_id } }
 *   cancel   → { data: { ticket, event } }
 *   timeline → { data: { ticket, events, sms, count, page, pageSize } }
 *
 * ⚠️ 返回给前端的工单一律经 `maskTicketForActor` 脱敏 ——
 *    只读角色看不到完整手机号（文档 §4 角色矩阵「看完整手机号」列）。
 */
import { INTERNAL_WRITE_SCENE } from '../../constants';
import {
  CAPABILITY,
  toPlainRows,
  type Actor,
} from '../../services/permission-service';
import { fail, ok, traceId } from './_http';
import { maskVisitForActor } from './_mask';
import {
  createWrapper,
  param,
  requireRequestId,
  requireTicketId,
  replay,
  toPageNumber,
  usernameOf,
  writeIdempotencyOf,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

/** 时间线单页上限（与 EventService.clampPageSize 的上限一致，避免两处口径漂移） */
const TIMELINE_MAX_PAGE_SIZE = 200;
/** 时间线里附带展示的短信摘要条数上限 */
const TIMELINE_SMS_LIMIT = 20;

export function createTicketActionHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services, logger } = deps;
  const { permissions, tickets, events } = services;

  /**
   * 统一的"解析操作者 → 执行 → 错误映射"包装。
   * 实现见 _request.ts 的 createWrapper —— 与 dispatch.ts 共用同一份，
   * 避免两个 action 文件各写一套而漏掉某一边的安全/错误处理。
   */
  const wrap = createWrapper(deps);

  // -------------------------------------------------------------------------
  // I1 accept —— NEW → PROCESSING
  // -------------------------------------------------------------------------
  const accept = wrap('accept', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'accept');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    // 先能力（403）、再归属（404）：viewer 调写接口应当明确是"没权限"，
    // 而不是"工单不存在" —— 后者会让只读用户以为工单被删了。
    await permissions.assertCanWriteTicket(actor, ticketId);

    const responseOf = (result: any) => ({
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      event: result.event,
    });

    const outcome = await tickets.accept(ticketId, {
      userId: actor.userId,
      username: usernameOf(actor),
    }, writeIdempotencyOf({
      scene: INTERNAL_WRITE_SCENE.ACCEPT,
      ticketId,
      actor,
      requestId,
      // ⚠️ responseOf 必须能重跑第二遍：首次用它写进去的是**首次响应**，
      //    重放时原样取回 —— 所以它只能依赖入参，绝不能读"当前状态"。
      responseOf,
    }));

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    logger.info?.(
      `[svc:accept] 工单 ${ticketId} 已受理（操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
    );

    ok(ctx, responseOf(outcome.value));
  });

  // -------------------------------------------------------------------------
  // I2 transfer —— 状态不变，只改 store_id（M6）
  // -------------------------------------------------------------------------
  const transfer = wrap('transfer', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'transfer');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    const reason = param(ctx, 'reason');
    const targetCode = param(ctx, 'target_store_code') ?? param(ctx, 'targetStoreCode');

    if (!targetCode) {
      fail(ctx, 422, 'MISSING_TARGET_STORE', '必须提供 target_store_code', {
        field: 'target_store_code',
      });
      return;
    }

    const storeRepository = (ctx.app as any).db.getRepository('stores');
    const targetStore = await storeRepository.findOne({
      filter: { code: String(targetCode).trim() },
    });

    if (!targetStore) {
      // 目标门店编码不存在属于请求错误（不是越权），门店编码本身不是秘密
      fail(ctx, 422, 'TARGET_STORE_NOT_FOUND', `目标门店编码 ${targetCode} 不存在`, {
        target_store_code: String(targetCode),
      });
      return;
    }

    // 能力 + 归属 + "能否转到该门店"（门店角色只能转给自己被授权的门店）
    await permissions.assertCanTransferTo(actor, ticketId, targetStore.id);

    const responseOf = (result: any) => ({
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      event: result.event,
      previous_store_id: result.previousStoreId,
    });

    const outcome = await tickets.transfer(
      ticketId,
      targetStore.id,
      String(reason ?? ''),
      { userId: actor.userId, username: usernameOf(actor) },
      writeIdempotencyOf({
        scene: INTERNAL_WRITE_SCENE.TRANSFER,
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

    logger.info?.(
      `[svc:transfer] 工单 ${ticketId}：门店 ${outcome.value.previousStoreId} → ${targetStore.id}` +
        `（操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
    );

    ok(ctx, responseOf(outcome.value));
  });

  // -------------------------------------------------------------------------
  // I6 cancel —— NEW / PROCESSING → CANCELLED
  // -------------------------------------------------------------------------
  const cancel = wrap('cancel', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'cancel');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const responseOf = (result: any) => ({
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      event: result.event,
    });

    const outcome = await tickets.cancel(ticketId, String(param(ctx, 'reason') ?? ''), {
      userId: actor.userId,
      username: usernameOf(actor),
    }, writeIdempotencyOf({
      scene: INTERNAL_WRITE_SCENE.CANCEL,
      ticketId,
      actor,
      requestId,
      responseOf,
    }));

    if (outcome.replay) {
      replay(ctx, outcome.response);
      return;
    }

    logger.info?.(`[svc:cancel] 工单 ${ticketId} 已取消（操作者 ${actor.userId}）`);

    ok(ctx, responseOf(outcome.value));
  });

  // -------------------------------------------------------------------------
  // I10 timeline —— 工单时间线（事件 + 短信摘要）
  // -------------------------------------------------------------------------
  const timeline = wrap('timeline', async (ctx, actor) => {
    const ticketId = requireTicketId(ctx);
    // 只读角色也能看（范围在 assertCanAccessTicket 里裁剪）
    const ticket = await permissions.assertCanAccessTicket(actor, ticketId);

    const page = toPageNumber(param(ctx, 'page'), 1);
    const pageSize = Math.min(toPageNumber(param(ctx, 'pageSize'), 50), TIMELINE_MAX_PAGE_SIZE);

    const { rows, count } = await events.listByTicket(ticketId, { page, pageSize });
    const sms = await loadSmsSummaries(ctx, ticketId, actor);

    ok(ctx, {
      ticket: permissions.maskTicketForActor(ticket, actor),
      // ⚠️ 必须归一化成纯对象：listByTicket 返回的是 Sequelize Model 实例，
      //    直接序列化会把 dataValues/_previousDataValues/_changed/_options…
      //    这些 ORM 内部属性一起吐给客户端（见 permission-service.ts 的 toPlainRow）。
      events: toPlainRows(rows),
      sms,
      count,
      page,
      pageSize,
      // 只读角色会看到 masked=true，前端据此隐藏"查看完整号码"入口
      mobile_masked: !permissions.can(actor, CAPABILITY.VIEW_RAW_MOBILE),
    });
  });

  /**
   * 取该工单最近的短信摘要。
   *
   * 刻意只回**脱敏后的接收号**与状态字段，不回短信正文 ——
   * 正文里可能带评价链接（含 Token），回给后台列表等于把凭证撒得到处都是。
   * 失败不抛错：短信表还没建好/为空时，时间线仍应可用。
   */
  async function loadSmsSummaries(ctx: any, ticketId: number, actor: Actor): Promise<any[]> {
    try {
      const repository = (ctx.app as any).db.getRepository('smsLogs');
      const rows = await repository.find({
        filter: { ticket_id: ticketId },
        sort: ['-created_at'],
        limit: TIMELINE_SMS_LIMIT,
        fields: [
          'id',
          'scene',
          'template_code',
          'recipient_masked',
          'send_status',
          'delivery_status',
          'retry_count',
          'sent_at',
          'delivered_at',
          'created_at',
        ],
      });

      return toPlainRows(rows).map((summary: any) => {
        // recipient_masked 理论上已是脱敏值；但历史数据可能是明文（早期写入未脱敏），
        // 因此这里再按角色脱敏一次，作为"最后一公里"的兜底（fail-safe 而非 fail-open）。
        if (summary?.recipient_masked) {
          summary.recipient_masked = permissions.maskMobile(summary.recipient_masked, actor);
        }
        return summary;
      });
    } catch (error) {
      logger.warn?.(`[svc:timeline] 读取短信摘要失败（忽略）：${(error as Error)?.message}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // I11 visits —— 某张工单的**派工历史**（Phase 4-H3 工单详情抽屉）
  // -------------------------------------------------------------------------
  /**
   * 为什么必须是一个**独立 action**，而不是让前端用 `serviceVisits` 的
   * 原生 list 接口自己加 `filter[ticket_id]`：
   *
   *   ① 原生接口的范围裁剪不认"这张工单属于谁" —— 前端老实传过滤条件是
   *      **自觉**，换成拼 URL 就能拉到别人工单的 Visit。这里走
   *      `assertCanAccessTicket()`，越权与不存在**统一 404**，
   *      与项目其余接口同口径（双层门店隔离的最后一道）。
   *   ② "下载全量再过滤"会把整张 Visit 表拖进浏览器，
   *      师傅手机号、Token 到期时间这些字段先落地一次再被丢弃，
   *      既浪费带宽也凭空扩大暴露面。
   *   ③ 抽屉要显示"这条链接为什么失效"（`token_revoked_reason`），
   *      而凭据列必须**在服务端**就删掉 —— 只有在这里统一脱敏，
   *      "该删的没删"才会是一个能被断言的事实（见 smoke §4e）。
   *
   * 只读：不写任何状态。只读角色同样可用（能看到哪些由数据范围决定）。
   */
  const visits = wrap('visits', async (ctx, actor) => {
    const ticketId = requireTicketId(ctx);
    const ticket = await permissions.assertCanAccessTicket(actor, ticketId);

    const rows = await services.visits.listByTicket(ticketId);

    ok(ctx, {
      // 只回定位用的最小字段：前端用它核对"查的是不是同一张单"，
      // 完整工单信息走 svc:timeline（那边带脱敏后的客户信息与事件）。
      ticket: { id: ticket.id, ticket_no: ticket.ticket_no, status: ticket.status },
      visits: toPlainRows(rows).map((row) =>
        maskVisitForActor(permissions, row, actor, { keepRevokedReason: true }),
      ),
      count: rows.length,
    });
  });

  return { accept, transfer, cancel, timeline, visits };
}
