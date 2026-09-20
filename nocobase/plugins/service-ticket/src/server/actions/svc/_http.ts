/**
 * 内部 action 的 HTTP 约定。
 *
 * 三件事集中在这里，避免每个 handler 各写一套：
 *  1) **错误信封**。docs/API.md §0 规定失败响应是
 *     `{ "errors": [ { "code": "...", "message": "...", "detail": {...} } ] }`。
 *     NocoBase 默认会把 ctx.body 包成 `{ data: ... }`，所以失败路径必须显式
 *     关掉包装（`ctx.withoutDataWrapping = true`），否则前端拿到的是
 *     `{ data: { errors: [...] } }` —— 与文档差一层，且错误码不在顶层。
 *  2) **X-Request-Id**。文档要求所有写接口都带 UUID v4。Phase 2 先用它做链路
 *     追踪与事件留痕（真正的幂等去重在 Phase 3 的 IdempotencyRecords）。
 *  3) **异常 → HTTP 状态码**的统一映射。映射表就是 docs/API.md §0 那张表。
 */
import { ForbiddenError, NotFoundError } from '../../services/permission-service';
import { StateConflictError, ValidationError } from '../../services/ticket-service';

/** 请求 ID 头名（小写，Koa 的 ctx.get 大小写不敏感） */
export const REQUEST_ID_HEADER = 'x-request-id';

/** RFC 4122 UUID v4 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HttpErrorBody {
  code: string;
  message: string;
  detail?: unknown;
}

/** 成功响应：交给 NocoBase 的 dataWrapping 包成 `{ data }`（与文档一致） */
export function ok(ctx: any, payload: unknown, status = 200): void {
  ctx.status = status;
  ctx.body = payload;
}

/** 失败响应：自行产出文档规定的 `{ errors: [...] }`，不参与 dataWrapping */
export function fail(
  ctx: any,
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): void {
  ctx.withoutDataWrapping = true;
  ctx.status = status;
  const error: HttpErrorBody = { code, message };
  if (detail !== undefined) error.detail = detail;
  ctx.body = { errors: [error] };
}

/** 客户端（nginx / 上游）带来的 traceId，没有就现造一个，便于串日志 */
export function traceId(ctx: any): string {
  const fromHeader = ctx?.get?.('x-trace-id');
  if (fromHeader) return String(fromHeader);
  return `svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 取并校验 X-Request-Id。
 * 非法/缺失返回 null，调用方据此回 422 —— 不在这里直接抛错，
 * 是因为有的 action（如 timeline）并不强制要求它。
 */
export function readRequestId(ctx: any): string | null {
  const raw = ctx?.get?.(REQUEST_ID_HEADER);
  if (!raw) return null;
  const value = String(raw).trim();
  return UUID_V4.test(value) ? value : null;
}

/**
 * 业务异常 → HTTP（docs/API.md §0）。
 *
 * 注意顺序：NotFoundError 必须先于 ForbiddenError 之外判断，
 * 因为"越权"在 PermissionService 里**故意**表现为 NotFoundError（404），
 * 目的是不让响应码成为工单存在性的探测器。
 */
export function statusOf(error: unknown): { status: number; code: string; message: string } {
  const message = String((error as Error)?.message ?? '未知错误');

  if (error instanceof NotFoundError) {
    return { status: 404, code: error.code, message };
  }

  if (error instanceof StateConflictError) {
    return { status: 409, code: error.code, message };
  }

  if (error instanceof ValidationError) {
    // NOT_FOUND 是 ValidationError 里唯一的 404（transfer 内部按 ID 找不到工单）
    if (error.code === 'NOT_FOUND') return { status: 404, code: error.code, message };
    return { status: 422, code: error.code, message };
  }

  if (error instanceof ForbiddenError) {
    // 未登录 → 401；其余（能力不足、跨店、目标门店停用…）→ 403
    return {
      status: error.code === 'UNAUTHENTICATED' ? 401 : 403,
      code: error.code,
      message,
    };
  }

  return { status: 500, code: 'INTERNAL_ERROR', message: '服务端异常，请稍后重试' };
}

/**
 * 统一的 action 错误出口。
 *
 * 500 只回稳定文案、**不回堆栈**（文档要求：日志里记 traceId，响应里不暴露内部信息），
 * 原始错误写进应用日志。
 *
 * ⚠️ 这里的级别口径必须与 permission-service.ts 里错误类的 `logLevel` 一致：
 *    404 → 不记（框架层只能记 debug，见 NotFoundError.logLevel）
 *    403/409 → warn，5xx → error
 * 两处不一致就会出现"同一个越权行为，走 /api/svc 不记、走 /api/serviceTickets 记 error"
 * 的怪现象，运维断言随之失真。
 */
export function handleError(
  ctx: any,
  error: unknown,
  logger: { warn?: (m: string) => void; error?: (m: string) => void },
  trace: string,
  actionName: string,
): void {
  const mapped = statusOf(error);

  if (mapped.status >= 500) {
    logger?.error?.(
      `[svc:${actionName}] 未预期异常（trace=${trace}）：${(error as Error)?.stack ?? String(error)}`,
    );
  } else if (mapped.status === 403 || mapped.status === 409) {
    // 越权尝试与并发冲突都是"值得看"的事件，但不是系统故障
    logger?.warn?.(
      `[svc:${actionName}] ${mapped.status} ${mapped.code}（trace=${trace}）：${mapped.message}`,
    );
  }

  fail(ctx, mapped.status, mapped.code, mapped.message, { traceId: trace });
}
