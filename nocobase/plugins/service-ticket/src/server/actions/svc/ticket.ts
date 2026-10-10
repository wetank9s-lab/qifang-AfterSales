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
import {
  INTERNAL_WRITE_SCENE,
  TICKET_STATUS,
  // P11-1：撤销跨店转单后统一的拒绝码（`svc:transfer` / `svc:transferTargets` 共用）
  TRANSFER_DISABLED_CODE,
} from '../../constants';
// P11-1：三态意图的**纯函数**（规则只有这一处，可直接单测）
import {
  FOLLOW_UP_TODO_FIELDS,
  canonicalizeAppointmentDate,
  resolveNextFollowIntent,
} from '../../services/ticket-service';
// P11-1：逾期判定的**唯一判据**（纯函数，签名里没有"当前时间"）
import {
  FOLLOW_UP_WINDOW,
  businessDayOf,
  followUpWindowOf,
} from '../../../shared/follow-up-window';
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
  paramPresence,
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
/**
 * 撤销跨店转单后**统一**的拒绝文案。
 *
 * ⚠️ 两个接口共用（`svc:transfer` 与 `svc:transferTargets`）—— 它们是**同一个能力的
 *    两个面**（一个是动作、一个是它的下拉数据源），文案分开写会漂移成两种说法，
 *    而一线同事只会觉得"系统前后不一致"。
 */
const TRANSFER_DISABLED_MESSAGE =
  '门店独立运营：跨店转单能力已撤销，本单请在当前门店内处理' +
  '（可改为安排上门 / 交厂家·第三方 / 电话·门店直接解决 / 客户取消）';

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
    // 🔴 能力已被撤销（Phase 11 / P11-1，用户 2026-10-10 产品裁决：**门店完全独立运营，
    //   取消跨店转单**）。该规则**优先于**此前允许 `svc:transfer` 跨店的决定。
    //
    // ⚠️ 判定放在 handler 的**第一行**，在一切参数校验之前：
    //   否则"没带 target_store_code"会先撞 422 —— 那会让人以为**参数补全了就能转**，
    //   而真相是这条路已经没有了。能力撤销必须先于输入校验发声。
    //
    // ⚠️ 这里覆盖**全部角色**（普通门店 / 总部业务角色 / 管理员）—— 不做角色分支：
    //   撤销的是能力本身，不是某个角色的权限。
    //   服务层的 `TicketService.transfer()` 已被整体删除（见该文件里的撤销说明），
    //   ⇒ 没有任何代码路径能变更已有工单的所属门店（要求 B4）。
    fail(ctx, 403, TRANSFER_DISABLED_CODE, TRANSFER_DISABLED_MESSAGE);
    return;
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

  // -------------------------------------------------------------------------
  // I22 transferTargets —— 转店的**合法目标门店**（Phase 11 / P11-0）
  // -------------------------------------------------------------------------

  /**
   * 转店时的目标门店下拉。
   *
   * 🔴 为什么**不能**复用 `storeOptions`（用户 2026-09-20 指出的衔接问题）：
   *    `storeOptions` 回的是"**我被授权管理**的门店" —— 那适合"新建服务单"（只能建在自己店里），
   *    但**不适合转店**：门店人员本来就要能把单子转给**自己没被授权管理**的其他门店
   *    （客户地址不在本店辖区是常态）。用 `storeOptions` 会导致下拉里**看不到该转去的门店**。
   *
   * ## 与 `storeOptions` 的关键差别（两者不可互相替代）
   *    · `storeOptions`   ：**我是谁** ⇒ 我被授权管理的门店（新建用）；
   *    · `transferTargets`：**这张单能转去哪** ⇒ 除当前门店外的**全部启用门店**（转店用）。
   *
   * ## 安全边界（用户明令）
   *    · **必须关联具体服务单**（`filterByTk` 带 ticketId）并**先校验来源工单的操作权限**
   *      —— 不是"任何登录用户都能列全部门店"；
   *    · 排除**当前门店**（转给自己无意义）；
   *    · 只回 `code` + `name`（选择器所需），只回**启用**门店；
   *    · **这不会扩大 `storeScope`** —— 它只是"可选项列表"，
   *      真正的转店裁决仍由 `svc:transfer` 独立完成（含状态/目标启用/非同店等全部条件）。
   *      换句话说：**看到 ≠ 能转**，看到只是省去一次无效尝试。
   */
  const transferTargets = wrap('transferTargets', async (ctx, actor) => {
    // 🔴 能力已被撤销（Phase 11 / P11-1，用户 2026-10-10 产品裁决：**门店完全独立运营，
    //   取消跨店转单**）。该规则**优先于**此前允许 `svc:transfer` 跨店的决定。
    //
    // ⚠️ 判定放在 handler 的**第一行**，在一切参数校验之前：
    //   否则"没带 target_store_code"会先撞 422 —— 那会让人以为**参数补全了就能转**，
    //   而真相是这条路已经没有了。能力撤销必须先于输入校验发声。
    //
    // ⚠️ 这里覆盖**全部角色**（普通门店 / 总部业务角色 / 管理员）—— 不做角色分支：
    //   撤销的是能力本身，不是某个角色的权限。
    //   服务层的 `TicketService.transfer()` 已被整体删除（见该文件里的撤销说明），
    //   ⇒ 没有任何代码路径能变更已有工单的所属门店（要求 B4）。
    fail(ctx, 403, TRANSFER_DISABLED_CODE, TRANSFER_DISABLED_MESSAGE);
    return;
  });

  // -------------------------------------------------------------------------
  // I23 followUp —— 记录跟进（Phase 11 / P11-0）
  // -------------------------------------------------------------------------

  /**
   * 「跟进」：把进度记成一条**不可变的业务记录**（`ticketEvents`，event_type=`follow_up`），
   * 而不是往某个文本列里继续拼"3号…5号…7号…"（契约 §6.2 明文禁止）。
   *
   * 鉴权与其它写动作一致：登录 + `assertCanWriteTicket` + `X-Request-Id` 幂等。
   * 状态约束在服务层（只有 PROCESSING 可跟进）。
   */
  const followUp = wrap('followUp', async (ctx, actor) => {
    const requestId = requireRequestId(ctx, 'followUp');
    if (!requestId) return;

    const ticketId = requireTicketId(ctx);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const responseOf = (result: any) => ({ event: result.event });

    // 🔴 用 `paramPresence`（**不是** `param`）：后者把 `null` 与 `''` 都当成"没传"，
    //    于是"未传（保持不变）"与"传 null（明确清空）"会塌缩成同一件事 ——
    //    那正是需求里点名要避免的"无意清除已有安排"。
    const nextPresence = paramPresence(ctx, ['next_follow_at', 'nextFollowAt']);
    const nextFollow = resolveNextFollowIntent({
      present: nextPresence.present,
      raw: nextPresence.raw,
    });

    const outcome = await tickets.followUp(
      ticketId,
      {
        note: String(param(ctx, 'note') ?? param(ctx, 'follow_up') ?? '').trim(),
        nextFollow,
      },
      { userId: actor.userId, username: usernameOf(actor) },
      writeIdempotencyOf({
        scene: INTERNAL_WRITE_SCENE.FOLLOW_UP,
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

    logger.info?.(`[svc:followUp] 工单 ${ticketId} 记录跟进（操作者 ${actor.userId}）`);
    ok(ctx, responseOf(outcome.value));
  });

  // -------------------------------------------------------------------------
  // I24 followUpQueue —— 「今日待跟进 / 已逾期」队列（Phase 11 / P11-1）
  // -------------------------------------------------------------------------

  /**
   * 门店在**自己的授权范围**内查"今天要跟进"与"已经逾期"的服务单，按日期升序。
   *
   * 🔴 三个必须在服务端成立的性质（需求 5 原文）：
   *   ① **storeScope 在服务端裁**，不是浏览器过滤 ——
   *      范围由 `permissions.applyScope()` 产生，直接进查询的 WHERE；
   *      浏览器拿到的**本来就只是它看得见的那部分**（前端过滤只能"少显示"，不能"防越权"）；
   *   ② **日期语义与业务时区一致**：`today` 取的是 `canonicalizeAppointmentDate(now)`
   *      —— 与写入时**同一个函数**。若在这里自己 `new Date()` 比大小，
   *      在 UTC 下 08:00 之前的"今天"会被算成昨天 ⇒ **提前一天报逾期**（需求 7）；
   *   ③ **只认仍可跟进的状态**：即使某条历史数据漏了清理（比如上线前的旧行），
   *      已关闭/取消的单也不会冒进队列 —— 这是队列侧的第二道闸。
   *
   * ⚠️ 它**只读**、不扫描、不发短信：完整的超时与异常工作台留到 P11-6
   *（需求 8：不另造第二套 SLA 扫描体系）。
   */
  const followUpQueue = wrap('followUpQueue', async (ctx, actor) => {
    const limit = toPageNumber(param(ctx, 'limit'), 100);
    // 与写入同源的"今天"（业务时区 canonical 正午）—— 不引入第二套日期口径
    const today = canonicalizeAppointmentDate(new Date(), 'next_follow_at');

    // ① 先裁范围，再把范围当成**查询条件**（不是查询完再过滤）
    const filter = permissions.applyScope(actor, {
      status: TICKET_STATUS.PROCESSING,
      // 🔴 用 `$gt: epoch` 表达"**有**安排"，**不能**用 `$ne: null`。
      //
      //    实测（2026-10-10）：`$ne: null` 经 NocoBase 翻译后落到 SQL 是
      //    `next_follow_at != NULL` —— 而 SQL 里**任何**与 NULL 的比较结果都是 NULL，
      //    于是它不是"排除空值"而是"谁都不要"（实测同一条件在库里返回 0 行）。
      //    用下界时间戳就没这个问题：`next_follow_at > '1970-01-01'` 对 NULL 求值为
      //    NULL ⇒ 不被选中，语义恰好是我们要的"确实安排了日期"。
      next_follow_at: { $gt: new Date(0), $lte: today },
    });

    const rows = await tickets.listFollowUpTodos(filter, limit);
    // 第二道闸（与上面的下界重复是**刻意**的）：队列的语义是"有明确安排的待办"，
    // 这里再挡一次空值，免得将来有人改了 filter 而让空行混进来。
    // 🔴 **掩码之后仍要按白名单逐字段构造**（实测踩到，详见下方注释）。
    //
    //    第一版只写 `.map((row) => permissions.maskTicketForActor(row, actor))`，
    //    以为"查询时传了 `fields` 白名单"就够了。实测响应里多出一个
    //    **`technician_mobile: null`** —— 来源不是查询（那一列压根没被选中），
    //    而是 `maskTicketForActor()` 自己：它无条件执行
    //    `masked.technician_mobile = this.maskMobile(...)`，而 `maskMobile(undefined)`
    //    返回 `null` ⇒ **凭空补出一个键**，JSON 又保留 `null` ⇒ 它出现在响应里。
    //
    //    ⇒ 教训（与"取整行再 delete"同型，只是换了个方向）：
    //      **"声明了什么"必须由"构造出什么"来保证**，不能靠"查询时限制了"或
    //      "事后删掉多余的" —— 前者的生效范围由框架决定（会变），后者会漏。
    //      这里改成：先掩码（拿到脱敏值），再**只按白名单取值**构造输出。
    //      于是"声明的字段集"与"下发的字段集"**恒等**，多一个键都不可能。
    const masked = rows
      .filter((row) => row?.next_follow_at != null)
      .map((row) => {
        const safe = permissions.maskTicketForActor(row, actor);
        const out: Record<string, unknown> = {};
        for (const key of FOLLOW_UP_TODO_FIELDS) {
          const value = safe?.[key];
          // 只跳过 undefined；**保留 null**（例如"没有预计上门日期"是有意义的信息）
          if (value !== undefined) out[key] = value;
        }
        return out;
      });

    // 🔴 分窗口用**共享纯函数**，不在这里自己比时间戳。
    //
    //    判据只依赖两个**业务日**（待办日 / 今天的业务日），**签名里拿不到"现在几点"**
    //    ⇒ 结构上不可能出现"今天 12:00:01 就把今天的待办判成逾期"。
    //    这正是用户 2026-10-10 点名核对的那一条
    //    （详见 shared/follow-up-window.ts 的文件头）。
    const todayDay = businessDayOf(today) as string;
    const todayRows = masked.filter(
      (r) => followUpWindowOf(r.next_follow_at, todayDay) === FOLLOW_UP_WINDOW.TODAY,
    );
    const overdueRows = masked.filter(
      (r) => followUpWindowOf(r.next_follow_at, todayDay) === FOLLOW_UP_WINDOW.OVERDUE,
    );

    ok(ctx, {
      /** 业务时区的"今天"（ISO）—— 让调用方能自证口径一致，而不是猜服务端用了哪个时区 */
      today: today.toISOString(),
      todayCount: todayRows.length,
      overdueCount: overdueRows.length,
      /** 逾期在前（更急），组内按日期升序 */
      items: [...overdueRows, ...todayRows],
      trace: traceId(ctx),
    });
  });

  return {
    accept,
    transfer,
    cancel,
    remoteComplete,
    timeline,
    storeOptions,
    transferTargets,
    followUp,
    followUpQueue,
    staffDisplay,
    visits,
  };
}
