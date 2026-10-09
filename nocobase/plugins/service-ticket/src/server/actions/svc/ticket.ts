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
  // I7 remoteComplete —— 电话 / 门店直接解决（Phase 11 / P11-0）
  // -------------------------------------------------------------------------

  /**
   * 门店在电话里把客户问题解决（或客户到店当场解决）后，**直接登记最终结果**。
   *
   * 与上门服务的区别（产品口径，详见 `TicketService.remoteComplete`）：
   *   上门 = 师傅提交 → 门店审核（两方，要独立核对收费）
   *   电话 = 登记人**本身就是**被授权的门店人员 ⇒ 不需要"审核自己"，直接进待评价
   *
   * ⚠️ 这一点**不削弱**上门服务的规则：师傅提交仍必须经 confirm / reject。
   *
   * 鉴权与其余写动作**完全一致**（不因为是"电话解决"就放松）：
   *   ① 登录（`AUTHENTICATED_SVC_ACTIONS` 保证）+ 见 `wrap`；
   *   ② `assertCanWriteTicket` —— 只能动自己有写权限的工单；
   *   ③ `X-Request-Id` 必带（幂等键）。
   */
  const remoteComplete = wrap('remoteComplete', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'remoteComplete');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const responseOf = (result: any) => ({
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      // 远端服务记录（含收费）—— 门店要在详情里看到自己刚登记的结果
      visit: result.visit,
    });

    const outcome = await tickets.remoteComplete(
      ticketId,
      {
        // 对外契约是 snake_case；这里兼容 camelCase（后台自定义动作表单习惯用后者）
        serviceResult: String(param(ctx, 'completion_result') ?? param(ctx, 'service_result') ?? '').trim(),
        serviceNote: (param(ctx, 'completion_note') ?? param(ctx, 'service_note') ?? null) as string | null,
        isCharged: (param(ctx, 'is_charged') ?? param(ctx, 'isCharged')) === true,
        amount: (param(ctx, 'amount') ?? null) as number | string | null,
      },
      {
        userId: actor.userId,
        username: usernameOf(actor),
      },
      writeIdempotencyOf({
        scene: INTERNAL_WRITE_SCENE.REMOTE_COMPLETE,
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
      `[svc:remoteComplete] 工单 ${ticketId} 已登记电话/门店直接解决（visit=${outcome.value.visit?.id}，操作者 ${actor.userId}）`,
    );

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

  // -------------------------------------------------------------------------
  // I20 storeOptions —— 门店选择器（Phase 11 / P11-0）
  // -------------------------------------------------------------------------

  /**
   * 给「转给其他门店」「门店管理」等界面用的**门店选择器**。
   *
   * 🔴 为什么不能直接用原生 `stores:list`：
   *    P11-0 的平台元数据边界把业务角色的原生枚举收紧了（B-8 收口）。
   *    但门店下拉**必须**能用 ⇒ 按契约 §16.1 走**受控最小业务接口**。
   *
   * ## 最小披露（只回"选择器需要的字段"）
   *    · 回：`code`（提交时要用的键）+ `name`（给人看）
   *    · **不回**：门店地址、售后电话、内部 id、创建人、停用原因…
   *      —— 选择器不需要它们，而多回一个字段就是多一份泄漏面。
   *    · 只回**启用中**的门店（停用门店本就不该出现在下拉里）。
   *
   * ## 范围
   *    · 门店角色 ⇒ 只看到**自己被授权**的门店（`scope.storeIds`）。
   *      ⚠️ 这不是"限制能不能转店"，而是"下拉里能出现哪些"；
   *      转店的目标校验由 `assertCanTransferTo` 单独负责。
   *    · 总部角色 ⇒ 全量启用门店。
   *    · 无数据权限 ⇒ 403（fail-closed，不返回空集当"成功"）。
   */
  const storeOptions = wrap('storeOptions', async (ctx, actor) => {
    const scope = permissions.scopeOf(actor);
    if (scope.kind === 'none') {
      fail(ctx, 403, 'FORBIDDEN', '无数据权限');
      return;
    }

    const filter: Record<string, unknown> = { active: true };
    if (scope.kind === 'stores') {
      // ⚠️ `scope.storeIds` 是**门店主键 id**（`serviceTickets.store_id` 同源），
      //    不是门店编码 —— 两者混用会让下拉静默变空。
      filter.id = { $in: scope.storeIds };
    }

    const repository = (ctx.app as any).db.getRepository('stores');
    const rows = await repository.find({ filter, sort: 'sort', fields: ['code', 'name'] });

    ok(ctx, {
      options: (rows ?? []).map((row: any) => ({
        code: String(row.code ?? ''),
        name: String(row.name ?? ''),
      })),
    });
  });

  // -------------------------------------------------------------------------
  // I21 staffDisplay —— 处理人 / 确认人显示名（受控最小读，Phase 11 / P11-0）
  // -------------------------------------------------------------------------

  /**
   * 把**某一张工单上真实出现过的用户 id** 换成显示名。
   *
   * 🔴 为什么需要它：`collections:listMeta` 的正向投影把 `users` 关联字段
   *    （`serviceTickets.handler` / `serviceVisits.store_confirmer` / `ticketEvents.operator_user`）
   *    从业务角色可见的元数据里移除了（否则 users 的 schema 会从字段 options 里漏出去）。
   *    用户裁决：**最终服务详情仍须展示处理人/确认人的显示名**，但**不得**恢复完整 users schema。
   *    ⇒ 就是这个接口：**受控、最小、按单取**。
   *
   * ## 三条硬约束（缺一条就退化成"另一个 users:list"）
   *    ① **不是列表接口**：必须带 `ticket_id`，且先过 `assertCanAccessTicket`
   *       —— 看不到这张单，就一个名字也拿不到；
   *    ② **只能是这张单上被引用到的 id**：从工单 + 上门记录 + 事件里**收集** id，
   *       再用 `id ∈ 收集到的集合` 反查。**不接受客户端传任意 id 进来**；
   *    ③ **只回 id + 显示名**：`nickname`（无则 `username`）。
   *       **不返回** `email` / `phone` / 角色 / 语言 / 系统设置等任何其它列。
   *       ⚠️ 这些字段在 B-8 里是"业务角色不得枚举"的核心资产 ——
   *       这里出现一个 `email`，整条收口的意义就没了。
   */
  const staffDisplay = wrap('staffDisplay', async (ctx, actor) => {
    const ticketId = requireTicketId(ctx);
    // 只读角色也能看（范围在 assertCanAccessTicket 里裁剪）——与 timeline 同一口径
    await permissions.assertCanAccessTicket(actor, ticketId);

    const db = (ctx.app as any).db;
    const ids = new Set<number>();

    const ticket = await db
      .getRepository('serviceTickets')
      .findOne({ filter: { id: ticketId }, fields: ['id', 'handler_user_id'] });
    if (ticket?.handler_user_id) ids.add(Number(ticket.handler_user_id));

    const visits = await db
      .getRepository('serviceVisits')
      .find({ filter: { ticket_id: ticketId }, fields: ['store_confirmed_by'] });
    for (const v of visits ?? []) {
      if (v?.store_confirmed_by) ids.add(Number(v.store_confirmed_by));
    }

    const events = await db
      .getRepository('ticketEvents')
      .find({ filter: { ticket_id: ticketId }, fields: ['operator_user_id'] });
    for (const e of events ?? []) {
      if (e?.operator_user_id) ids.add(Number(e.operator_user_id));
    }

    // 集合为空 ⇒ 明确回空数组（**不回全量**）。这是 fail-closed：
    // "没收集到 id" 的正确结果是"没有名字要显示"，不是"那就列一遍用户"。
    if (ids.size === 0) {
      ok(ctx, { users: [] });
      return;
    }

    const users = await db
      .getRepository('users')
      .find({ filter: { id: { $in: [...ids] } }, fields: ['id', 'nickname', 'username'] });

    ok(ctx, {
      users: (users ?? []).map((u: any) => ({
        id: Number(u.id),
        // `nickname` 是给同事看的名；缺省退回账号名（**都不是 email**）
        name: String(u.nickname || u.username || ''),
      })),
    });
  });

  return { accept, transfer, cancel, remoteComplete, timeline, storeOptions, staffDisplay, visits };
}
