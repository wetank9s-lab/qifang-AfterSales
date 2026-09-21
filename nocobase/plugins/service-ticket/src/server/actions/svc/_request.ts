/**
 * svc action 层的**公共请求处理**（ticket.ts 与 dispatch.ts 共用）。
 *
 * 为什么要把它们从 ticket.ts 里搬出来：
 *   Phase 4 新增了 5 个 action（dispatch / reassign / reschedule / tokenCheck / smsOutbox），
 *   而"解析操作者 → 执行 → 统一错误映射"这一段在每个 handler 上都必须一模一样。
 *   复制一份到新文件，看起来当下没问题，但它埋的是**安全语义漂移**：
 *   某天有人只在一个文件里加了"未登录直接 401"的处理，另一个文件就留下了缺口，
 *   而两个文件各自的测试都是绿的。
 *
 * 因此这里保留唯一实现，两个 action 文件都从这里 import。
 */
import type { Actor } from '../../services/permission-service';
import type { Services } from '../../services';
import { ValidationError } from '../../services/ticket-service';
import { handleError, readRequestId, traceId, fail, REQUEST_ID_HEADER } from './_http';

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

/** handler 体：已解析出操作者，只需写业务 */
export type ActionBody = (ctx: any, actor: Actor) => Promise<void>;

/**
 * 统一包装：解析操作者 → 执行 → 错误映射。
 *
 * 把 try/catch 与 traceId 收敛在这里有两个效果：
 *   ① 各 handler 只写业务，读起来就是"这件事做了什么"；
 *   ② **不可能出现"某个 handler 忘了映射错误"** —— 那类缺陷的表现是
 *      业务校验失败被报成 500（客户端拿不到可行动的错误码）。
 */
export function createWrapper(deps: SvcActionDeps): (name: string, body: ActionBody) => ActionHandler {
  const { permissions } = deps.services;
  const { logger } = deps;

  return function wrap(name: string, body: ActionBody): ActionHandler {
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
  };
}

/**
 * 写接口的公共前置：必须是带 X-Request-Id 的合法请求。
 * 返回 false 表示已经写过响应体，调用方直接 return。
 *
 * 为什么写接口都要它：`X-Request-Id` 既是链路追踪的锚点，也是
 * `idempotencyRecords` 的幂等键。少了它，"门店同事连点两次派工"就无法去重。
 */
export function requireRequestId(ctx: any, actionName: string): boolean {
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

// ---------------------------------------------------------------------------
// 参数解析（NocoBase 把 query 摊在 params 上、把 body 放在 params.values）
// ---------------------------------------------------------------------------

export function paramsOf(ctx: any): Record<string, any> {
  return ctx?.action?.params ?? {};
}

/** 依次尝试 body.values → query → filterByTk */
export function param(ctx: any, key: string): unknown {
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
export function requireTicketId(ctx: any): number {
  const raw = param(ctx, 'ticket_id') ?? paramsOf(ctx)?.filterByTk;
  return requirePositiveInt(raw, 'ticket_id');
}

/** 解析可选的正整数参数（如 visit_id / since_seq）；非法一律 422 而不是"当成没传" */
export function requirePositiveInt(raw: unknown, field: string): number {
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    // 用 ValidationError 语义（422）而不是 404：路径/参数写错是客户端问题。
    // 直接 import 而不是 require()：内联 require 在 esbuild 打包成 CJS 后
    // 会绕开依赖图，既拿不到编译期检查，也让"谁依赖了 ticket-service"变得不可见。
    // 错误码沿用历史的 INVALID_TICKET_ID（既有验收脚本按它断言），其余字段用通用码。
    throw new ValidationError(
      field === 'ticket_id' ? 'INVALID_TICKET_ID' : 'INVALID_ID',
      `${field} 必须是正整数（实际 ${JSON.stringify(raw ?? null)}）`,
    );
  }
  return id;
}

export function toPageNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.trunc(num);
}

/** 事件 metadata 里记录的"谁干的"，便于审计追溯 */
export function usernameOf(actor: Actor): string | undefined {
  const raw = actor.raw;
  const name = raw?.username ?? raw?.nickname ?? raw?.email;
  return name ? String(name) : undefined;
}
