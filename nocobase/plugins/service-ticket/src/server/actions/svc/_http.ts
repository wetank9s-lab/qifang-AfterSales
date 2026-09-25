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
import { VisitValidationError } from '../../services/visit-service';
import { ORIENTATION_UNAVAILABLE_TEXT, OrientationUnavailableError } from '../../services/photo-orient';

/**
 * 请求 ID 头名与 UUID 判定的**单一事实来源**在 `src/shared/svc-request.ts`
 * —— 客户端请求器、服务端 handler、离线断言脚本读的是同一个常量与同一条正则。
 *
 * 为什么要刻意这么做：客户端曾经压根没发这个头，而服务端照常在注释里宣称
 * "X-Request-Id 是幂等键"；两边各有一份定义（写 constant 的 vs 写文档的）
 * 正是这类缺陷能长期存活的原因。
 */
import { REQUEST_ID_HEADER, UUID_V4_PATTERN } from '../../../shared/svc-request';
export { REQUEST_ID_HEADER };

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
  return UUID_V4_PATTERN.test(value) ? value : null;
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

  if (error instanceof VisitValidationError) {
    // ---------------------------------------------------------------- DEV-75
    // 这一条曾经**不存在**（既有潜伏缺陷，P5-1 的照片上传第一次踩出来）。
    //
    // `VisitValidationError extends Error` —— 它**不是** `ValidationError` 的子类
    // （本文件第 22 行一直 import 着它，却没有任何分支用它）。
    // 于是它一路落到末尾的 500，表现是：
    //   · 上传超过张数上限 → 500「服务端异常，请稍后重试」，而不是 422 PHOTO_LIMIT_REACHED
    //   · 上传非图片       → 500，而不是 415
    //   · 上传超大文件     → 500，而不是 413
    // 全都**不报错、不崩、只是码不对**，师傅看到"服务端异常"会去重试而不是换张照片。
    //
    // 它为什么能潜伏两个阶段：`VisitService` 此前只被 `dispatch`/`reschedule` 这类
    // **后台**动作调用，而那条路上的业务拒绝抛的是 `ValidationError`
    // （如 `SAME_RESPONSIBLE_PARTY`）；`VisitValidationError` 需要
    // "匿名接口 + Visit 侧校验失败"同时成立才会浮现，P5-1 是第一例。
    //
    // ⚠️ 别再往 `statusOf()` 里加类型而不加分支。`ticket-service.ts:149` 与
    //    `guard-quota.ts:204` 的注释都预言过这个坑。现在有结构性闸门盯着：
    //    `scripts/verify-plugin-load.mjs` 的「每个自定义 Error 都有 statusOf 分支」。
    //    同 `ValidationError` 的口径：status 由实例自带，不在这里按 code 二次判定。
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

  if (error instanceof OrientationUnavailableError) {
    // ---------------------------------------------------------------- DEV-84
    // 照片方向归一化所需的原生解码器不可用（`@napi-rs/canvas` 被升级/改名弄丢）。
    //
    // ⚠️ 这条分支在**正常路径上走不到**：`PhotoService.save()` 已经先把它捕获、
    //    转成带 503 的 `VisitValidationError`（并把"不可用"的原始原因写进应用日志）。
    //    留在这里是**结构性兜底**，而不是"可能用得上"的摆设 ——
    //    与 DEV-75 同一个教训：往 `statusOf()` 里加错误类型而不加分支，
    //    错误会被静默映射成 500，前端看到"服务端异常"就只会去重试。
    //
    // 文案刻意**不取 error.message**：那句话里带着内部依赖名与 require 的错误文本
    // （anonymous 接口不该看到这些）。原始原因由 `handleError` 按 5xx 规则进日志。
    return { status: error.status, code: error.code, message: ORIENTATION_UNAVAILABLE_TEXT };
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
    // ⚠️⚠️ 这里**必须**打 `message`，不能只打 `stack`（2026-09-25 实测踩到）。
    //
    //   现象：一条 DB 层故障（`RAISE EXCEPTION`）在日志里长这样 ——
    //     `[svc:technician:submit] 未预期异常（trace=...）：Error
    //        at Query.run (/app/.../sequelize/lib/dialects/postgres/query.js:50:25)`
    //   **正文一个字都没有**，只能看出"发生在某次查询"，看不出到底为什么失败。
    //
    //   根因（读容器内源码取证）：`postgres/query.js` 的 `Query.run` 里有一句
    //     `const errForStack = new Error();`，然后
    //     `throw this.formatError(error, errForStack.stack)` ——
    //   sequelize **故意**用它自己造的那个**空 Error 的 stack** 去覆盖真实错误的 stack，
    //   好让堆栈落在"发起查询的那一帧"。代价是：
    //     **`error.stack` 的第一行永远是 `Error`，而真正的 PG 报错文本只在 `error.message` 上。**
    //   ⇒ 只打 stack = 把唯一能诊断的线索丢掉，把一次可定位的 500 变成一次盲猜。
    //
    //   为什么顺带打 `parent.message`：sequelize 的 `DatabaseError` 把驱动原始错误
    //   挂在 `parent` 上，某些方言/包装下 message 会被归一化，原始文本留在 parent。
    const err = error as any;
    const detail =
      [err?.message, err?.parent?.message].filter(
        (s: unknown): s is string => typeof s === 'string' && s.length > 0,
      )[0] ?? String(error);
    logger?.error?.(
      `[svc:${actionName}] 未预期异常（trace=${trace}）：${detail}` +
        `\n${err?.stack ?? ''}`,
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
