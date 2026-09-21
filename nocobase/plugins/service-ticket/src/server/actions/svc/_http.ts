/**
 * action 层的 HTTP 约定（**svc 与 public 两组资源共用**）。
 *
 * 三件事集中在这里，避免每个 handler 各写一套：
 *  1) **错误信封**。docs/API.md §0 规定失败响应是
 *     `{ "errors": [ { "code": "...", "message": "...", "detail": {...} } ] }`。
 *     NocoBase 默认会把 ctx.body 包成 `{ data: ... }`，所以失败路径必须显式
 *     关掉包装（`ctx.withoutDataWrapping = true`），否则前端拿到的是
 *     `{ data: { errors: [...] } }` —— 与文档差一层，且错误码不在顶层。
 *  2) **X-Request-Id**。文档要求所有写接口都带 UUID v4。Phase 2 先用它做链路
 *     追踪与事件留痕；Phase 3 起它同时是 `public_ticket` 的幂等键。
 *  3) **异常 → HTTP 状态码**的统一映射。映射表就是 docs/API.md §0 那张表。
 *
 * ⚠️ 为什么 public 组也复用本文件而不是各写一份：
 *    错误码到状态码的映射是**对外契约**（docs/API.md §0），
 *    两份实现迟早漂移，表现是"同一个错误在两组接口上返回不同的 status"，
 *    而客户端只能按一种写。因此这里只保留一份，两个资源组都从它 import。
 */
import { RateLimitedError } from '../../services/guard-service';
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

/**
 * 取客户端真实 IP（**唯一实现点**，svc 与 public 两组资源共用）。
 *
 * 取值优先级与理由：
 *   1) `X-Real-IP`            —— nginx 用 `proxy_set_header X-Real-IP $remote_addr` 写入，
 *                                **不可被客户端伪造**（客户端自带的同名头会被 nginx 覆盖）。
 *   2) `X-Forwarded-For` 首段 —— 只在直连（绕过 nginx 调试）时出现；
 *                                它**可被伪造**，所以只作为兜底，且只取第一段
 *                                （`X-Forwarded-For` 是 "client, proxy1, proxy2" 形态）。
 *   3) socket 远端地址        —— 容器内直连（健康检查、单元测试桩）。
 *   4) `'unknown'`            —— 全都取不到时的**固定串**：
 *                                频控会把所有"取不到 IP"的请求聚成同一个桶（fail-closed），
 *                                比"每个请求各自一个新桶"（等于不限流）安全得多。
 *
 * ⚠️ 为什么不放在各 handler 里各写一份：
 *    频控的维度哈希 = sha256(IP + SIGN_SECRET)，IP 口径不一致 = 桶不一致，
 *    现象是"限流看起来生效，但两个接口之间可以互相绕过配额"，且只在真机存在反代时复现。
 */
export function clientIpOf(ctx: any): string {
  const fromHeader = ctx?.get?.('x-real-ip') ?? ctx?.request?.headers?.['x-real-ip'];
  if (fromHeader) return String(fromHeader).trim();

  const forwarded = ctx?.get?.('x-forwarded-for') ?? ctx?.request?.headers?.['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }

  const socket = ctx?.req?.socket?.remoteAddress ?? ctx?.socket?.remoteAddress;
  return socket ? String(socket) : 'unknown';
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

  // 频控（Phase 3-E）。**放在最前**：它的 code 是 RATE_LIMITED，
  // 与 ValidationError 的 422 语义完全不同，靠后判断容易被更宽的类型先截胡。
  if (error instanceof RateLimitedError) {
    return { status: 429, code: error.code, message };
  }

  if (error instanceof NotFoundError) {
    return { status: 404, code: error.code, message };
  }

  if (error instanceof StateConflictError) {
    return { status: 409, code: error.code, message };
  }

  if (error instanceof ValidationError) {
    // ⚠️ 用 error 自带的 status，而不是在这里再判一次 code ——
    //    早期写法是「NOT_FOUND → 404，其余 → 422」，与 ValidationError 构造函数里的
    //    判定重复。两处一旦不同步（例如新增一个 400 的 DTO 错误），
    //    现象是"错误类自己说 400、响应却是 422"，而两边都不会报错。
    //    ValidationError.status 是唯一事实来源（见 ticket-service.ts）。
    return { status: error.status, code: error.code, message };
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
  } else if (mapped.status === 429) {
    // 限流是**预期内**的拒绝，而且往往成批出现。记点信息便于回答
    // "到底是我们限得太紧，还是真有人在刷"；但绝不记 error，
    // 否则"app 日志无 error"这条运维断言会被正常流量击穿。
    logger?.warn?.(`[svc:${actionName}] 429 ${mapped.code}（trace=${trace}）：${mapped.message}`);
  }

  // `detail` 由抛错方给出（如限流的剩余额度、重复单的原单号）。
  // 它与 traceId 一起进 detail，客户端据此可以直接展示原因而不是干等。
  const detail: Record<string, unknown> = { traceId: trace };
  const extra = (error as { detail?: unknown })?.detail;
  if (extra && typeof extra === 'object') Object.assign(detail, extra as Record<string, unknown>);

  fail(ctx, mapped.status, mapped.code, mapped.message, detail);
}
