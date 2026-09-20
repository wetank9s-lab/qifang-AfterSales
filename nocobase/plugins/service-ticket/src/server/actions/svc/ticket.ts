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
  CAPABILITY,
  toPlainRows,
  type Actor,
} from '../../services/permission-service';
import { ValidationError } from '../../services/ticket-service';
import type { Services } from '../../services';
import {
  handleError,
  ok,
  readRequestId,
  traceId,
  fail,
  REQUEST_ID_HEADER,
} from './_http';

export interface SvcActionDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
}

/** NocoBase action handler 形态 */
export type ActionHandler = (ctx: any, next: () => Promise<void>) => Promise<void>;

/** 时间线单页上限（与 EventService.clampPageSize 的上限一致，避免两处口径漂移） */
const TIMELINE_MAX_PAGE_SIZE = 200;
/** 时间线里附带展示的短信摘要条数上限 */
const TIMELINE_SMS_LIMIT = 20;

export function createTicketActionHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services, logger } = deps;
  const { permissions, tickets, events } = services;

  /**
   * 统一包装：解析操作者 → 执行 → 错误映射。
   * 把 try/catch 与 traceId 收敛在这里，各 handler 只写业务。
   */
  function wrap(name: string, body: (ctx: any, actor: Actor) => Promise<void>): ActionHandler {
    return async function handler(ctx: any, next: () => Promise<void>): Promise<void> {
      const trace = traceId(ctx);
      ctx.set?.('X-Trace-Id', trace);

      try {
        const actor = await permissions.resolveActor(ctx);
        await body(ctx, actor);
      } catch (error) {
        handleError(ctx, error, logger, trace, name);
      }

      await next();
    };
  }

  /**
   * 写接口的公共前置：必须是带 X-Request-Id 的合法请求。
   * 返回 false 表示已经写过响应体，调用方直接 return。
   */
  function requireRequestId(ctx: any, actionName: string): boolean {
    const id = readRequestId(ctx);
    if (id) return true;

    const raw = ctx?.get?.(REQUEST_ID_HEADER);
    fail(
      ctx,
      422,
      'VALIDATION_FAILED',
      raw
        ? `${REQUEST_ID_HEADER} 不是合法的 UUID v4`
        : `写接口必须携带 ${REQUEST_ID_HEADER} 请求头（UUID v4），用于幂等与链路追踪`,
      { header: REQUEST_ID_HEADER, received: raw ?? null, action: actionName },
    );
    return false;
  }

  // -------------------------------------------------------------------------
  // I1 accept —— NEW → PROCESSING
  // -------------------------------------------------------------------------
  const accept = wrap('accept', async (ctx, actor) => {
    if (!requireRequestId(ctx, 'accept')) return;

    const ticketId = requireTicketId(ctx);
    // 先能力（403）、再归属（404）：viewer 调写接口应当明确是"没权限"，
    // 而不是"工单不存在" —— 后者会让只读用户以为工单被删了。
    await permissions.assertCanWriteTicket(actor, ticketId);

    const result = await tickets.accept(ticketId, {
      userId: actor.userId,
      username: usernameOf(actor),
    });

    logger.info?.(
      `[svc:accept] 工单 ${ticketId} 已受理（操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
    );

    ok(ctx, {
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      event: result.event,
    });
  });

  // -------------------------------------------------------------------------
  // I2 transfer —— 状态不变，只改 store_id（M6）
  // -------------------------------------------------------------------------
  const transfer = wrap('transfer', async (ctx, actor) => {
    if (!requireRequestId(ctx, 'transfer')) return;

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

    const result = await tickets.transfer(
      ticketId,
      targetStore.id,
      String(reason ?? ''),
      { userId: actor.userId, username: usernameOf(actor) },
    );

    logger.info?.(
      `[svc:transfer] 工单 ${ticketId}：门店 ${result.previousStoreId} → ${targetStore.id}` +
        `（操作者 ${actor.userId}，trace=${traceId(ctx)}）`,
    );

    ok(ctx, {
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      event: result.event,
      previous_store_id: result.previousStoreId,
    });
  });

  // -------------------------------------------------------------------------
  // I6 cancel —— NEW / PROCESSING → CANCELLED
  // -------------------------------------------------------------------------
  const cancel = wrap('cancel', async (ctx, actor) => {
    if (!requireRequestId(ctx, 'cancel')) return;

    const ticketId = requireTicketId(ctx);
    await permissions.assertCanWriteTicket(actor, ticketId);

    const result = await tickets.cancel(ticketId, String(param(ctx, 'reason') ?? ''), {
      userId: actor.userId,
      username: usernameOf(actor),
    });

    logger.info?.(`[svc:cancel] 工单 ${ticketId} 已取消（操作者 ${actor.userId}）`);

    ok(ctx, {
      ticket: permissions.maskTicketForActor(result.ticket, actor),
      event: result.event,
    });
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

  return { accept, transfer, cancel, timeline };
}

// ---------------------------------------------------------------------------
// 参数解析（NocoBase 把 query 摊在 params 上、把 body 放在 params.values）
// ---------------------------------------------------------------------------

function paramsOf(ctx: any): Record<string, any> {
  return ctx?.action?.params ?? {};
}

/** 依次尝试 body.values → query → filterByTk */
function param(ctx: any, key: string): unknown {
  const params = paramsOf(ctx);
  const fromBody = params?.values?.[key];
  if (fromBody !== undefined && fromBody !== null && fromBody !== '') return fromBody;
  const fromQuery = params?.[key];
  if (fromQuery !== undefined && fromQuery !== null && fromQuery !== '') return fromQuery;
  return undefined;
}

/**
 * 解析目标工单 ID。
 *
 * 支持三种来源（与 docs/API.md §4 的路径形式 + NocoBase 原生形式对齐）：
 *   · `?filterByTk=<id>`            —— nginx 把 /api/svc/tickets/:id/xxx 重写成这种原生形式
 *   · body `{ ticket_id }`          —— 显式传参
 *   · `?ticket_id=<id>`             —— 查询串
 * 解析不出来直接抛 ValidationError，由 wrap 统一映射成 422。
 */
function requireTicketId(ctx: any): number {
  const raw = param(ctx, 'ticket_id') ?? paramsOf(ctx)?.filterByTk;
  const id = Number(raw);

  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    // 用 ValidationError 语义（422）而不是 404：路径/参数写错是客户端问题。
    // 直接 import 而不是 require()：内联 require 在 esbuild 打包成 CJS 后
    // 会绕开依赖图，既拿不到编译期检查，也让"谁依赖了 ticket-service"变得不可见。
    throw new ValidationError(
      'INVALID_TICKET_ID',
      `ticket_id 必须是正整数（实际 ${JSON.stringify(raw ?? null)}）`,
    );
  }
  return id;
}

function toPageNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.trunc(num);
}

/** 事件 metadata 里记录的"谁干的"，便于审计追溯 */
function usernameOf(actor: Actor): string | undefined {
  const raw = actor.raw;
  const name = raw?.username ?? raw?.nickname ?? raw?.email;
  return name ? String(name) : undefined;
}
