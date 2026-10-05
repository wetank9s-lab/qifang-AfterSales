/**
 * requestLogRedaction —— 请求日志的**接管**层（Phase 10 / RB-1）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（取证事实，不是推测）
 * ---------------------------------------------------------------------------
 * NocoBase 的请求日志实现在 `@nocobase/logger/lib/request-logger.js`，
 * 由 `@nocobase/server/lib/helper.js:125` 装配：
 *
 * ```js
 * app.use(requestLogger(app.name, app.requestLogger, options.logger?.request), { tag: 'logger' })
 * ```
 *
 * 它对**每个请求写两行**，且两行的可配置性完全不同：
 *
 * | 行 | 内容 | 能否用 options 关掉 |
 * |---|---|---|
 * | `request <METHOD> <url>` | `req: pick(ctx.request.toJSON(), requestWhitelist)` + 原始 `ctx.action` | ⚠️ 部分可（`requestWhitelist`） |
 * | `response <url>` | `action: **omit**(ctx.action.toJSON(), defaultActionBlackList)` | 🔴 **不能** |
 *
 * 🔴 关键事实：`defaultActionBlackList` 是 `request-logger.js:47-52` 的
 * **模块级硬编码常量**，只去掉 `password` / `confirmPassword` / `oldPassword` /
 * `newPassword` 四个字段。也就是说 —— **`action.params.values`（整个请求体）
 * 一定会被写进 `response` 行**，用任何 `options` 都关不掉。
 *
 * 且 `response` 行按状态码三分支（`:98-104`）：
 * ```
 * 5xx → error({ ...info, res: ctx.body?.errors || ctx.body })   // res = 整个响应体
 * 4xx → warn ({ ...info, res: ctx.body?.errors || ctx.body })   // res = 整个响应体
 * 2xx → info (info)                                             // res = { status }
 * ```
 *
 * 两行的 `message` 都含 `${ctx.url}` —— **含 query string**。
 *
 * ⇒ 结论：**只改 `requestWhitelist` 是假绿**（它只管 request 行的 `req` 字段，
 * 而泄漏的大头在 response 行的 `action` 与 4xx/5xx 的 `res`）。
 * 必须在**插件层接管 `app.requestLogger` 本身**。
 *
 * ---------------------------------------------------------------------------
 * 接管机制：为什么是"接管"而不是"又加一层安全日志"
 * ---------------------------------------------------------------------------
 * 装配点传的是 `app.requestLogger` 这个**对象引用**，而中间件内部调用形式是
 * `requestLogger2.info(payload)` —— **每次调用都做一次属性查找**。
 * 因此在本模块里给该对象的 `info` / `warn` / `error` 装上**自有属性**包装器，
 * 框架中间件的每一次写日志都会经过本模块 —— 这不是"旁边再加一个 logger"
 * （那会留下旧 logger 继续旁路泄漏），而是**唯一那条写请求日志的通路被换掉**。
 *
 * 已验证（容器内实测，非推断）：
 * ```text
 * own_prop_info = false      // winston 的 level 方法在原型上
 * frozen        = false      // 对象未冻结
 * l.info = fn → l.info({...}) 命中的是新函数
 * ```
 *
 * ⚠️ 本模块**不修改 node_modules**（与 Phase 10 / D5「immutable image」一致）。
 *
 * ---------------------------------------------------------------------------
 * 收敛策略：**正向白名单**，不是"先记全量再删敏感字段"
 * ---------------------------------------------------------------------------
 * 为什么不能走 denylist（用户在 P10 裁决里明确否决"全 body 结构化脱敏"）：
 * 本系统的 body 天然包含姓名、手机号、故障描述、评价内容、收费信息，
 * 且**会随 API 演进不断新增字段**。维护"目前已知敏感字段"的名单，
 * 必然在某次加字段时静默失效。
 *
 * ⇒ 因此 `sanitizeRequestLogPayload()` 的输出是**从零构造的对象**：
 *   只复制 `REQUEST_LOG_SAFE_KEYS` 里列出的键，其余（`path` / `req` / `res` /
 *   `action` 以及任何未知键）**一律不出现**。新增字段默认**不被记录**。
 *
 * 已实测的泄漏路径（`storage/logs/main/request_*.log`，token 作为**整字段值**）：
 * ```
 * .action.params.token              2098
 * .action.params.values.token        703
 * .action.params.filterByTk          343   ← 评价 Token（nginx 把 token 留在 path）
 * .action.params.resourceIndex       343   ← 同一个评价 Token 的第二处副本
 * ```
 * 以上四条全部落在被丢弃的 `action` 子树里 ⇒ 白名单天然清零。
 *
 * ---------------------------------------------------------------------------
 * 🔴 第二处泄漏点：`ctx.log` 的 `submodule`（同一份取证实测出来的）
 * ---------------------------------------------------------------------------
 * 只接管 `app.requestLogger` **不足以**证明"接管"——实测发现 `system_*.log`
 * 里还有 **345 条真实 Token**（`publicReview:get` 171 + `publicReview:submit` 174）。
 *
 * 来源是框架**同一条中间件的另一句代码**（`request-logger.js:57-58`）：
 * ```js
 * const path = /^\/api\/(.+):(.+)/.exec(ctx.path);
 * const contextLogger = ctx.app.log.child({ reqId, module: path?.[1], submodule: path?.[2] });
 * ctx.logger = ctx.log = contextLogger;
 * ```
 * 由于评价 Token **按 Phase 7 冻结语义留在 path 里**（它充当 NocoBase 的资源 ID），
 * 于是 `submodule` = `get/<43 位 Token 明文>`，而被设为 `ctx.log` 的这个 child logger
 * 会被**任何**业务代码使用 —— 实测触发者是 NocoBase 自己的工作流前置钩子：
 * ```text
 * {"level":"warn","message":"[Workflow pre-action]: collection \"publicReview\" not found",
 *  "module":"publicReview","submodule":"get/<43 位 Token 明文>", ...}
 * ```
 *
 * ⚠️ 这条通路与 `app.requestLogger` **完全无关**（写的是 `app.log`），
 *    所以只包装 requestLogger 会留下"新日志安全了、旁边还有一路在漏"的典型假绿。
 *
 * ⚠️ 为什么不改 nginx 把 Token 挪到 query（那样 path 就干净了）：
 *    `actions/public/review.ts#tokenOf()` **刻意不读 query**（文件头有理由），
 *    挪位置会改掉 Phase 7 冻结的路由语义。⇒ 正确的修法是**归一化日志元数据**，
 *    而不是改路由：见下方 `createContextLogNormalizer()`。
 *
 * ---------------------------------------------------------------------------
 * 🔴 第三处泄漏点：`ctx.log` 的**消息参数**（归一化之后才被门禁抓出来的）
 * ---------------------------------------------------------------------------
 * 上述两处修完后跑 `scripts/verify-log-redaction.mjs`，**仍然红**：
 * 驱动一条 5xx（`X-Data-Source: <唯一 canary>`）后，
 * `storage/logs` 与 `docker logs svc-app` 里各出现 1 处 canary 原文：
 * ```text
 * {"level":"error","message":"data source <CANARY> does not exist",
 *  "extra":{"method":"error-handler",
 *           "err":"InternalServerError: data source <CANARY> does not exist\n    at ..."}}
 * ```
 * 来源（**回代码核实，非推断**）：
 * `@nocobase/plugin-error-handler/dist/server/error-handler.js:76`
 * ```js
 * ctx.log[logMethod](err.message, { method: "error-handler", err: err.stack, cause: err.cause });
 * ```
 * ⇒ 即**同一个 `ctx.log`**，只不过泄漏不在它的 child binding（`submodule`，
 *   那是第二处），而在它的**第一个实参**：`err.message`。
 *   框架自己的错误处理器会把**请求派生文本**（这里是被 echo 的请求头值）
 *   原样拼进 message 与 stack，再交给 `ctx.log` 落盘。
 *
 * ⇒ 结论：`ctx.log` 有**两个**泄漏面，必须成对封堵；只封 `submodule` 会留下
 *   "元数据干净了、消息还在漏"的假绿。第二条通路用**请求污点脱敏**封闭：
 *   见 `collectRequestTaints()` / `createScrubbingContextLogger()`。
 *
 * ⚠️ 为什么是"污点替换"而不是"给 message 加白名单"：
 *   `message` 是自由文本，任何白名单都只能是"事后列举已知危险词"，
 *   而危险词来自**本次请求**、逐请求不同 —— 这正好是 denylist 的失效模式。
 *   反过来问"这条文本里有哪些片段来自本次请求"，答案是可枚举的（请求就是全集），
 *   因此按**请求派生值**做替换是完备且随请求自更新的。
 */
import { PKG_NAME } from '../constants';

// ---------------------------------------------------------------------------
// 白名单与判定（纯函数，离线可测）
// ---------------------------------------------------------------------------

/**
 * **允许**出现在请求日志里的字段（唯一事实来源）。
 *
 * 判断标准是"这条信息本身能否用于定位一次请求，而不携带任何业务值"：
 *   · `reqId`         —— 请求关联 ID（框架生成的 UUID），排障的锚点；
 *   · `method`        —— HTTP 方法；
 *   · `route`         —— **归一化**路由 `${resource}:${action}`（不含 ID/Token）；
 *   · `status`/`cost` —— 响应码与耗时；
 *   · `errorCode`     —— 业务错误码**枚举值**（不含 message 自由文本）；
 *   · `userId`/`username` —— 安全标识（谁发起的），契约 §2.2 明确允许；
 *   · `app`           —— 应用名（多应用部署时区分）；
 *   · `bodySize`      —— 体积（不含内容）。
 *
 * 🔴 **不要**往这个数组里加任何"可能包含用户输入"的键。
 */
export const REQUEST_LOG_SAFE_KEYS = [
  'method',
  'route',
  'status',
  'cost',
  'errorCode',
  'userId',
  'username',
  'app',
  'reqId',
  'requestSource',
  'bodySize',
] as const;

/** 包装标记：挂在 logger 对象上的非枚举自有属性，用于幂等与启动自检 */
export const REQUEST_LOG_MARKER = '__svcRequestLogRedacted';

/** 框架中间件实际使用的三个 level（见 request-logger.js:66/99/101/103） */
export const REQUEST_LOG_LEVELS = ['info', 'warn', 'error'] as const;

export type RequestLogLevel = (typeof REQUEST_LOG_LEVELS)[number];

/**
 * 归一化路由：`${resource}:${action}`。
 *
 * ⚠️ 为什么**必须**做二次防御（`split('/')[0]`）：
 *    nginx 的 `/api/public/reviews/{token}` 重写目标是 `/api/publicReview:get/{token}`
 *    —— **token 留在 path 里**（它充当 NocoBase 的资源 ID）。
 *    若框架某次把 `actionName` 解析成 `get/{token}`，直接回填就会把 token
 *    写进"看起来安全"的 `route` 字段。实测当前版本解析结果是干净的 `get`
 *    （token 落在 `params.filterByTk`），但**不能把"当前恰好干净"当作安全前提**。
 */
export function normalizeRoute(action: unknown): string {
  const a = (action ?? {}) as Record<string, any>;
  const resource = a.resourceName ?? a.resource?.name ?? a.resource?.resourceName;
  const name = a.actionName ?? a.name;
  if (!resource || !name) return 'unknown';
  const res = String(resource).split('.')[0];
  const act = String(name).split('/')[0];
  return `${res}:${act}`;
}

/**
 * 从响应体里取**业务错误码**。
 *
 * 形状实测（`storage/logs/main/request_2026-09-26.log`）：
 * ```
 * 404 → [{"message": "工单 2742 不存在", "code": "NOT_FOUND"}]
 * 500 → [{"code": "INTERNAL_ERROR", "message": "...", "detail": {"traceId": "..."}}]
 * ```
 * ⇒ `res` 是**列表**；只取 `code`，`message`（可能含业务值，如"工单 2742 不存在"）
 *   与 `detail` 一律丢弃。
 */
export function extractErrorCode(res: unknown): string | undefined {
  const list = Array.isArray(res) ? res : [res];
  for (const item of list) {
    const code = (item as Record<string, any> | null | undefined)?.code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * **纯函数**：把框架要写的那条 payload 收敛成白名单形态。
 *
 * 必须保持"从零构造"的性质 —— 任何形式的"复制原对象再删键"都会在
 * 字段新增时重新引入泄漏。
 */
export function sanitizeRequestLogPayload(payload: unknown): Record<string, unknown> {
  // 非对象（含数组）：不尝试理解它，直接给出可辨识的替换值。
  // 这里刻意**不回显原值**，避免"未知形状先原样落盘"这种兜底变成新漏洞。
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { message: `request-log-redaction: dropped non-object payload (${typeof payload})` };
  }

  const src = payload as Record<string, any>;
  const isResponse = typeof src.message === 'string' && src.message.startsWith('response ');

  const route = normalizeRoute(src.action);

  // message 重写：原始 message 是 `request <METHOD> <url>` / `response <url>`，
  // **含完整 URL（query + path token）** ⇒ 不能透传，改成只含 method/route/status 的安全串。
  // 保留"request/response 二分"是为了让人读日志时仍能区分两行、且便于 grep。
  const message = isResponse
    ? `response ${String(src.method ?? '?')} ${route}` +
      (src.status === undefined ? '' : ` ${String(src.status)}`)
    : `request ${String(src.method ?? '?')} ${route}`;

  const candidate: Record<string, unknown> = {
    message,
    route,
    // 逐键从白名单复制（**不**用展开运算符，避免将来有人把 src 展开进来）
    method: typeof src.method === 'string' ? src.method : undefined,
    status: isResponse ? src.status : undefined,
    cost: isResponse ? src.cost : undefined,
    errorCode: isResponse ? extractErrorCode(src.res) : undefined,
    userId: src.userId,
    username: src.username,
    app: src.app,
    reqId: src.reqId,
    requestSource: src.requestSource,
    bodySize: isResponse ? src.bodySize : undefined,
  };

  return stripUndefined(candidate);
}

// ---------------------------------------------------------------------------
// 接管
// ---------------------------------------------------------------------------

export interface RequestLoggerLike {
  [key: string]: any;
}

export interface InstallResult {
  installed: boolean;
  alreadyInstalled: boolean;
  reason?: string;
}

/**
 * 判断接管是否已装在 `app.requestLogger` 上。
 *
 * ⚠️ 同时校验**两个**条件，缺一不可：
 *   ① 标记属性存在；
 *   ② 三个 level 方法都是**自有属性**（而不是原型上的框架实现）。
 * 只查标记会被"标记在但方法被换回原型"绕过。
 */
export function isRequestLogRedactionInstalled(app: any): boolean {
  const logger: RequestLoggerLike | undefined = app?.requestLogger;
  if (!logger || !logger[REQUEST_LOG_MARKER]) return false;
  const proto = Object.getPrototypeOf(logger);
  return REQUEST_LOG_LEVELS.every(
    (level) =>
      typeof logger[level] === 'function' &&
      Object.prototype.hasOwnProperty.call(logger, level) &&
      logger[level] !== proto?.[level],
  );
}

/**
 * 把 `app.requestLogger` 的 `info` / `warn` / `error` 换成白名单包装器。
 *
 * 幂等：重复调用（`app.reload()` 会重跑 `load()`）不会叠加包装。
 * **不抛错** —— 失败由调用方（`plugin.assertRequestLogRedaction`）决定如何处置，
 * 这样离线环境/框架桩也能复用本函数。
 */
export function installRequestLogRedaction(
  app: any,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void },
): InstallResult {
  const reqLogger: RequestLoggerLike | undefined = app?.requestLogger;

  if (!reqLogger || typeof reqLogger.info !== 'function') {
    return {
      installed: false,
      alreadyInstalled: false,
      reason: 'app.requestLogger 不可用（框架版本变更？）',
    };
  }

  if (isRequestLogRedactionInstalled(app)) {
    return { installed: true, alreadyInstalled: true };
  }

  for (const level of REQUEST_LOG_LEVELS) {
    const original = reqLogger[level];
    if (typeof original !== 'function') {
      // 某个 level 不存在：不静默跳过 —— 那会让"以为接管了、其实漏了一档"。
      return {
        installed: false,
        alreadyInstalled: false,
        reason: `app.requestLogger.${level} 不是函数（框架 logger 形状异常）`,
      };
    }
    // ⚠️ 必须 bind：winston 的 level 方法依赖 this（内部走 this.write）。
    const bound = original.bind(reqLogger);
    Object.defineProperty(reqLogger, level, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function redactedRequestLog(payload: unknown, ...rest: unknown[]): unknown {
        try {
          return bound(sanitizeRequestLogPayload(payload), ...rest);
        } catch (error) {
          // 收敛失败**绝不回退到原样落盘**（那正好制造 RB-1 要消除的泄漏）。
          // 落一条结构化的"我失败了"记录，让它在门禁/巡检里可见。
          const msg = error instanceof Error ? error.message : String(error);
          logger?.warn?.(`[${PKG_NAME}] request-log 收敛失败：${msg}`);
          try {
            return bound({ message: 'request-log-redaction: sanitize failed' });
          } catch {
            return undefined;
          }
        }
      },
    });
  }

  Object.defineProperty(reqLogger, REQUEST_LOG_MARKER, {
    configurable: true,
    writable: false,
    enumerable: false,
    value: true,
  });

  logger?.info?.(
    `[${PKG_NAME}] 请求日志已接管（request/response 两行均不再记录 body / url / token；` +
      `保留字段：${REQUEST_LOG_SAFE_KEYS.join(', ')}）`,
  );

  return { installed: true, alreadyInstalled: false };
}

/**
 * 启动自检：接管未生效就**抛错**。
 *
 * 与 `assertNativeExportGuard()` 同一纪律 —— RB-1 的失效**没有任何运行期症状**
 * （接口全绿、功能正常，只是明文 PII 悄悄落盘），
 * 因此不能靠"日志里看一眼"发现，必须让它在启动期就阻断。
 */
export function assertRequestLogRedaction(app: any): void {
  const reqLogger: RequestLoggerLike | undefined = app?.requestLogger;

  if (!reqLogger) {
    throw new Error(
      `[${PKG_NAME}] app.requestLogger 不存在 —— 请求日志接管未生效。` +
        '框架请求日志会把请求体与响应体写进 request 日志（含明文手机号 / 姓名 / 匿名 Token）。',
    );
  }

  if (!isRequestLogRedactionInstalled(app)) {
    throw new Error(
      `[${PKG_NAME}] 请求日志接管未生效（${REQUEST_LOG_MARKER} 缺失或 level 方法仍是原型实现）。` +
        '这会静默漏出请求体与匿名 Token，必须阻断启动。',
    );
  }

  // 反向自检：白名单里**不得**混入任何已知泄漏路径的键名。
  // 这条守的是"某天有人为了方便把 path/req/res/action 加回白名单"。
  const forbidden = ['path', 'req', 'res', 'action', 'url', 'params', 'values'];
  const leaked = (REQUEST_LOG_SAFE_KEYS as readonly string[]).filter((k) =>
    forbidden.includes(k),
  );
  if (leaked.length > 0) {
    throw new Error(
      `[${PKG_NAME}] REQUEST_LOG_SAFE_KEYS 混入了禁止键：${leaked.join(', ')}` +
        '（这些键承载请求体 / URL / Token，必须保持正向白名单）',
    );
  }
}

// ---------------------------------------------------------------------------
// 第二处：`ctx.log` 的 module / submodule 归一化
// ---------------------------------------------------------------------------

// ⚠️ 这里**刻意不放** `__svcContextLogNormalized` 这类标记属性。
//    上一版把它 `defineProperty` 到真实的 child logger 上（污染框架对象），
//    且一个"能读到的标记"很容易被后续代码当成"接管已生效"的证据 ——
//    而它能证明的只是"我给自己盖了个章"。
//    接管是否生效一律**看落盘结果**（门禁扫 `storage/logs` + `docker logs`），
//    进程内的代理身份由 `isContextLogScrubbingInstalled()`（WeakSet）回答。

export interface ContextLogMeta {
  module: string;
  submodule: string;
}

/**
 * 纯函数：**框架**如何从 `ctx.path` 推 module / submodule。
 *
 * 逐字复刻 `request-logger.js:57`（`/^\/api\/(.+):(.+)/` 贪婪匹配），
 * 存在的唯一目的是让"反向自检"能证明泄漏**确实来自这里**，
 * 而不是靠人读注释相信。
 *
 * ⚠️ 本函数**只用于断言与取证**，绝不用来处理真正要落盘的日志。
 */
export function frameworkContextLogMeta(path: unknown): ContextLogMeta | null {
  const m = /^\/api\/(.+):(.+)/.exec(String(path ?? ''));
  if (!m) return null;
  return { module: m[1], submodule: m[2] };
}

/**
 * 纯函数：归一化后的 module / submodule。
 *
 * 与 `frameworkContextLogMeta` 的唯一差别：把**第一段之前**的部分留下，
 * 丢掉后面的 path 残段（资源 ID / 匿名 Token）。
 * ```text
 * /api/publicReview:get/<43>        → publicReview : get      （丢掉 Token）
 * /api/publicReview:submit/<43>     → publicReview : submit   （丢掉 Token）
 * /api/svc:tickets:get/2742         → svc:tickets  : get      （丢掉工单 ID）
 * /api/technicianVisit:upload       → technicianVisit : upload（本来就干净）
 * ```
 * 注意 `module` 也要切：贪婪匹配下 `/api/svc:tickets:get/1` 的 `module` 是
 * `svc:tickets`，而 `/api/foo/bar:baz` 的 `module` 会是 `foo/bar` —— 后者含 `/`，
 * 同样必须切掉，否则"资源名里带路径"这种形态会从 module 一侧漏。
 */
export function normalizeContextLogMeta(path: unknown): ContextLogMeta {
  const raw = frameworkContextLogMeta(path);
  if (!raw) return { module: '', submodule: '' };
  return {
    module: raw.module.split('/')[0],
    submodule: raw.submodule.split('/')[0],
  };
}

/**
 * 纯函数：这个 path 的框架 meta 里**是否含路径残段**（即是否真的需要替换）。
 *
 * 只有"归一化确实会改变结果"时才动手替换 `ctx.log` —— 这样对
 * `/api/svc:health` 这类本来就干净的路由**零行为变化**，
 * 把改动面严格限制在泄漏路径上。
 */
export function needsContextLogNormalization(path: unknown): boolean {
  const raw = frameworkContextLogMeta(path);
  if (!raw) return false;
  return raw.module.includes('/') || raw.submodule.includes('/');
}

/** 归一化是否已经跑过至少一次（进程级，用于"确实执行了"的运行期证据） */
let contextLogNormalizedOnce = false;

/** 仅供门禁/测试复位探针标记 */
export function resetContextLogNormalizationProbe(): void {
  contextLogNormalizedOnce = false;
}

export function isContextLogNormalizationProven(): boolean {
  return contextLogNormalizedOnce;
}

// ---------------------------------------------------------------------------
// 第三处：`ctx.log` 的**消息参数**脱敏（请求污点替换）
// ---------------------------------------------------------------------------

/** 替换后的占位符（单一常量，便于门禁 grep 与统计） */
export const REDACTED = '[REDACTED]';

/**
 * 参与脱敏的**最短**请求派生字符串长度。
 *
 * 取 11 的理由是**量化**而非感觉：中国大陆手机号 11 位是本系统里最短的
 * "仍然必须保护的请求报文片段"（评价 Token 43 位、canary 21 位、
 * 姓名通常 6~15 字）。低于这个长度的值（`S01`、`main`、`get`、`processing`）
 * 当作脱敏词会大面积误伤正常日志，而它们本身不携带可直接识别的个人信息。
 *
 * ⚠️ 这是一条**权衡下界**，不是"短值安全"的论断：若将来引入短凭证
 *    （如 8 位取件码），必须同时下调此常量并重跑门禁。
 */
export const TAINT_MIN_LENGTH = 11;

/**
 * 含 CJK 字符的值走**更低**的下限。
 *
 * 为什么需要第二条下限（不是"把 11 改成 2"就完事）：
 *   单一长度下限无法同时满足两个要求 ——
 *   ① 中文姓名 2~4 字（`张三`、`李四`）是本系统最典型的个人信息，**必须**脱敏；
 *   ② `main` / `S01` / `get` / `json` 这类结构性短值若参与替换，
 *      会把正常日志打成 `[REDACTED]`（假报障的源头）。
 *
 * 而这两类在**字符集**上是天然可分的：中文/假名/韩文出现在英文 JSON 日志里
 * 几乎只可能是用户数据（姓名、地址、故障描述、评价内容），
 * 结构性词汇则清一色是 ASCII。
 * ⇒ 按"是否含 CJK"分档，比单纯调低长度下限安全得多。
 *
 * ⚠️ 这仍是一条**启发式**：ASCII 的短个人信息（如 8 位取件码）
 *    落在两条下限之间，不在脱敏范围内。已在 `docs/PHASE-10.md` 记录为
 *    本阶段的**已知残留**，不做"已完全覆盖"的宣称。
 */
export const TAINT_MIN_LENGTH_CJK = 2;

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F\uAC00-\uD7AF]/;

/** 纯函数：某个请求派生值适用哪条长度下限 */
export function minTaintLength(value: string): number {
  return CJK_RE.test(value) ? TAINT_MIN_LENGTH_CJK : TAINT_MIN_LENGTH;
}

const TAINT_MAX_ITEMS = 300;
const TAINT_MAX_TEXT_LENGTH = 4096;
const TAINT_MAX_DEPTH = 5;
const TAINT_MAX_KEYS = 300;

/**
 * **结构性** header 名单：其值来自客户端软件栈/HTTP 协议本身，而非用户内容，
 * 且高频出现在正常排障文本里（`application/json`、`localhost:8080`、`gzip, deflate`）。
 * 把它们当脱敏词会把正常日志打成 `[REDACTED]`，而它们不是凭证载体。
 *
 * 🔴 `authorization` / `cookie` / `referer` / 全部 `x-*`（含 `x-data-source`、
 *    `x-request-source`）**不在**此列 —— 它们承载凭证或租户输入，必须参与脱敏。
 *    `referer` 尤其不能放行：短链落地页的 referer 里带 43 位 Token。
 */
const TAINT_HEADER_SKIP = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'host',
  'pragma',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'transfer-encoding',
  'user-agent',
  'if-modified-since',
  'if-none-match',
]);

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 纯函数：从**本次请求**里收集"必须脱敏的原文片段"。
 *
 * 刻意**不做逐请求缓存**：本函数在每次写日志时现算。
 * 原因是时序 —— 中间件挂载点在 body parser 之后、业务之前，
 * 但 `ctx.request.body` 是否已解析取决于 parser 的注册位置；
 * 而框架 error-handler 是在**整条栈之外**捕获异常的，它写日志时 body 必然已解析。
 * 现算 ⇒ 任何时刻拿到的都是"此刻可见的最全请求面"。
 *
 * ⚠️ 不收 **键名**（JSON 字段名来自 API 契约、不是用户内容；
 *    把 `description` 这类字段名当脱敏词会造成大面积误伤）。
 *
 * ⚠️ 不收整个 `ctx.url` / `ctx.path`：那会把 `/api/svc:health` 这种
 *    正常路由也变成脱敏词。**路径残段**（第 ③ 项）已经覆盖 Token 所在的那一段。
 */
export function collectRequestTaints(ctx: any): string[] {
  const out = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    if (out.size >= TAINT_MAX_ITEMS) return;
    const s = value.trim();
    if (s.length < minTaintLength(s) || s.length > TAINT_MAX_TEXT_LENGTH) return;
    out.add(s);
  };

  const addDeep = (value: unknown, depth: number) => {
    if (depth > TAINT_MAX_DEPTH) return;
    if (typeof value === 'string') {
      add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, TAINT_MAX_KEYS)) addDeep(item, depth + 1);
      return;
    }
    if (isPlainObjectLike(value)) {
      for (const key of Object.keys(value).slice(0, TAINT_MAX_KEYS)) {
        addDeep(value[key], depth + 1);
      }
    }
    // 其余形状（Date / Buffer / 类实例）**原样跳过**：
    // 不可枚举的类实例没有稳定的"文本面"，硬展开只会制造形状漂移。
  };

  // ① header（结构性 header 除外）
  try {
    const headers = ctx?.request?.headers ?? ctx?.headers;
    if (headers && typeof headers === 'object') {
      for (const name of Object.keys(headers)) {
        if (TAINT_HEADER_SKIP.has(String(name).toLowerCase())) continue;
        addDeep((headers as Record<string, unknown>)[name], 0);
      }
    }
  } catch {
    /* 污点收集失败不得影响请求：宁可能少收，也不抛出 */
  }

  // ② query string（`?token=<43>` 这类形态：值本身就是凭证）
  try {
    addDeep(ctx?.query ?? ctx?.request?.query, 0);
    const qs = ctx?.querystring ?? ctx?.request?.querystring;
    if (typeof qs === 'string') {
      for (const pair of qs.split('&')) {
        const eq = pair.indexOf('=');
        add(eq >= 0 ? pair.slice(eq + 1) : pair);
      }
    }
  } catch {
    /* 同上 */
  }

  // ③ path 残段（评价 Token 按 Phase 7 冻结语义留在 path 里充当资源 ID）
  try {
    const p = ctx?.path ?? ctx?.request?.path;
    if (typeof p === 'string') {
      for (const seg of p.split('/')) add(seg);
    }
  } catch {
    /* 同上 */
  }

  // ④ 请求体（含手机号 / 姓名 / 故障描述 / 评价内容）
  try {
    addDeep(ctx?.request?.body, 0);
  } catch {
    /* 同上 */
  }

  return [...out];
}

/** 进程级探针：脱敏**确实发生过**（用于运行期证据，不只是配置存在） */
let contextLogScrubHitCount = 0;
let contextLogScrubEvidenceLogged = false;

export function getContextLogScrubHitCount(): number {
  return contextLogScrubHitCount;
}

export function resetContextLogScrubProbe(): void {
  contextLogScrubHitCount = 0;
  contextLogScrubEvidenceLogged = false;
}

/** 纯函数：把一段文本里所有请求派生片段替换成 `[REDACTED]` */
export function scrubLogText(text: string, taints: readonly string[]): string {
  if (taints.length === 0) return text;
  let out = text;
  for (const taint of taints) {
    if (!out.includes(taint)) continue;
    out = out.split(taint).join(REDACTED);
    contextLogScrubHitCount += 1;
  }
  return out;
}

/**
 * 纯函数：递归脱敏一个日志实参。
 *
 * · `string`  → 直接替换；
 * · `Error`   → 返回**新的** Error（脱敏 message + stack），不修改原对象
 *                —— 原对象可能还被调用方持有；
 * · 数组/纯对象 → 递归（深度与键数都有上界）；
 * · 其它（Date / Buffer / 类实例 / 原始值）→ 原样返回。
 */
export function scrubLogValue(value: unknown, taints: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return scrubLogText(value, taints);
  if (depth >= TAINT_MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubLogValue(item, taints, depth + 1));
  }

  if (value instanceof Error) {
    const next = new Error(scrubLogText(value.message, taints));
    next.name = value.name;
    next.stack = typeof value.stack === 'string' ? scrubLogText(value.stack, taints) : value.stack;
    return next;
  }

  if (isPlainObjectLike(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, TAINT_MAX_KEYS)) {
      out[key] = scrubLogValue(value[key], taints, depth + 1);
    }
    return out;
  }

  return value;
}

/** 纯函数：脱敏一整组实参（无污点时**原样返回**，不做任何对象重建） */
export function scrubLogArgs(args: unknown[], taints: readonly string[]): unknown[] {
  if (taints.length === 0) return args;
  return args.map((arg) => scrubLogValue(arg, taints));
}

/** 真被替换过的 logger 集合（幂等 / 自检用；WeakSet 不阻止 GC） */
const scrubbingLoggers = new WeakSet<object>();

export function isContextLogScrubbingInstalled(logger: unknown): boolean {
  return !!logger && typeof logger === 'object' && scrubbingLoggers.has(logger as object);
}

export const CONTEXT_LOG_SCRUB_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export interface ScrubbingLoggerOptions {
  /** 首次真正发生脱敏时回调一次（用于落一条可 grep 的运行期证据） */
  onFirstScrub?: () => void;
}

/**
 * 把任意 child logger 包成"写之前先脱敏"的代理。
 *
 * 为什么用 Proxy 而不是逐个改写方法：`ctx.log` 被框架与第三方插件当作
 * 普通 logger 使用（会读 `level`、会 `child()`）。Proxy 对**未拦截**的属性
 * 一律透传（`Reflect.get(target, prop, target)`，receiver 用 target
 * 以免依赖 `this` 的 getter 被打偏），因此是**形状保持**的接管。
 *
 * 🔴 失败时**绝不回退到原样落盘**（那等于 RB-1 没做）：
 *    改为写一条固定文案，并丢掉本次 payload。
 */
export function createScrubbingContextLogger(backing: any, ctx: any, options: ScrubbingLoggerOptions = {}): any {
  const { onFirstScrub } = options;

  const reportFirstScrub = () => {
    if (contextLogScrubHitCount > 0 && !contextLogScrubEvidenceLogged) {
      contextLogScrubEvidenceLogged = true;
      try {
        onFirstScrub?.();
      } catch {
        /* 证据记录失败不得影响业务 */
      }
    }
  };

  const proxy = new Proxy(backing, {
    get(target, prop) {
      if (typeof prop === 'string' && (CONTEXT_LOG_SCRUB_LEVELS as readonly string[]).includes(prop)) {
        const fn = Reflect.get(target, prop, target);
        if (typeof fn === 'function') {
          return function svcScrubbedLog(...args: unknown[]): unknown {
            const before = contextLogScrubHitCount;
            try {
              const taints = collectRequestTaints(ctx);
              const scrubbed = scrubLogArgs(args, taints);
              if (contextLogScrubHitCount > before) reportFirstScrub();
              return fn.apply(target, scrubbed);
            } catch (error) {
              const name = error instanceof Error ? error.name : 'Error';
              try {
                return fn.call(target, `[${PKG_NAME}] ctx.log 脱敏失败，本条 payload 已丢弃（${name}）`);
              } catch {
                return undefined;
              }
            }
          };
        }
      }

      const value = Reflect.get(target, prop, target);

      if (prop === 'child' && typeof value === 'function') {
        return function svcScrubbedChild(...args: unknown[]): unknown {
          const child = value.apply(target, args);
          if (child && typeof child === 'object') {
            return createScrubbingContextLogger(child, ctx, options);
          }
          return child;
        };
      }

      return value;
    },
  });

  scrubbingLoggers.add(proxy);
  return proxy;
}

export interface ContextLogNormalizerOptions {
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  /** 离线测试用：置 true 则完全不动 `ctx.log` */
  disabled?: boolean;
}

/**
 * koa 级中间件：把框架派生出的 `ctx.log` / `ctx.logger` 换成**归一化 + 脱敏**过的 logger。
 *
 * 挂载位置必须是 `after: 'logger'` —— 框架的 `ctx.log` 是在 logger 中间件里
 * 被赋值的（`request-logger.js:58`），早于它执行时 `ctx.log` 还不存在。
 *
 * ⚠️ 为什么这是"接管"而不是"又加一层"：
 *    我们不写任何日志，只是**把 `ctx.log` 这个引用换掉**。此后
 *    所有 `ctx.log.*` 调用（含 NocoBase 自己的工作流钩子、框架 error-handler、
 *    任何第三方插件）都落进归一化 + 脱敏后的 logger —— 旧的那条通路**不再存在**。
 *
 * 两个动作的适用条件**不同**，不要合并：
 *   · **元数据归一化**只在 `needsContextLogNormalization(path)` 为真时做
 *     （即框架派生结果里真的含 path 残段）⇒ 干净路由零行为变化；
 *   · **消息脱敏**只要本次请求有可收集的污点就做 ⇒ 覆盖到 5xx 这类
 *     路径本来干净、但错误消息回显了请求内容的场景。
 *
 * 失败时**不改动 `ctx.log`**（宁可保留框架行为，也不给出半个对象），
 * 并落一条 warn 让它在巡检里可见；真正的门禁是启动自检 + 落盘扫描。
 */
export function createContextLogNormalizer(options: ContextLogNormalizerOptions = {}) {
  const { logger, disabled } = options;

  return async function svcContextLogNormalizer(ctx: any, next: any): Promise<void> {
    if (disabled) return next();

    try {
      const rawPath = ctx?.path ?? ctx?.request?.path;
      const app = ctx?.app;
      const existing = ctx?.log;

      let base = existing;
      let normalizedMeta: ContextLogMeta | null = null;

      if (needsContextLogNormalization(rawPath)) {
        const canChild =
          existing && typeof existing.child === 'function' && typeof app?.log?.child === 'function';

        if (canChild) {
          normalizedMeta = normalizeContextLogMeta(rawPath);
          base = app.log.child({
            reqId: ctx.reqId,
            module: normalizedMeta.module,
            submodule: normalizedMeta.submodule,
          });
        } else {
          logger?.warn?.(
            `[${PKG_NAME}] ctx.log 归一化跳过：ctx.log 或 app.log 不可用（框架版本变更？）`,
          );
        }
      }

      if (base && typeof base === 'object') {
        const wrapped = createScrubbingContextLogger(base, ctx, {
          onFirstScrub: () => {
            logger?.info?.(
              `[${PKG_NAME}] ctx.log 消息脱敏已生效（首例：请求派生文本在落盘前被替换为 ${REDACTED}）`,
            );
          },
        });

        ctx.log = wrapped;
        ctx.logger = wrapped;

        if (normalizedMeta && !contextLogNormalizedOnce) {
          contextLogNormalizedOnce = true;
          logger?.info?.(
            `[${PKG_NAME}] ctx.log 元数据已归一化（首例：module=${normalizedMeta.module} / ` +
              `submodule=${normalizedMeta.submodule}；path 残段不再进入日志）`,
          );
        }
      }
    } catch (error) {
      logger?.warn?.(
        `[${PKG_NAME}] ctx.log 归一化 / 脱敏失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return next();
  };
}

/**
 * 启动自检：归一化逻辑必须真的"去掉 path 残段"。
 *
 * 这里做的是**成对断言**（正向 + 反向），与 `assertNativeExportGuard()` 同一纪律：
 *   · 正向：归一化结果里不得出现任何 43 位 token / 路径分隔残段；
 *   · 反向：**框架派生的 meta 必须真的含 token** —— 否则说明这条断言
 *     已经在验一个不存在的缺陷（样本本身就干净），那它就不再是证据。
 *     这一条防的是"将来有人把样本改干净了，断言还绿着"。
 */
export function assertContextLogNormalization(): void {
  const token = 'T'.repeat(43);

  const samples: Array<[string, ContextLogMeta]> = [
    [`/api/publicReview:get/${token}`, { module: 'publicReview', submodule: 'get' }],
    [`/api/publicReview:submit/${token}`, { module: 'publicReview', submodule: 'submit' }],
    ['/api/svc:tickets:get/2742', { module: 'svc:tickets', submodule: 'get' }],
    ['/api/technicianVisit:upload', { module: 'technicianVisit', submodule: 'upload' }],
  ];

  for (const [path, expected] of samples) {
    const actual = normalizeContextLogMeta(path);

    if (actual.module !== expected.module || actual.submodule !== expected.submodule) {
      throw new Error(
        `[${PKG_NAME}] ctx.log 归一化结果不符：${path} → ` +
          `${actual.module}/${actual.submodule}，期望 ${expected.module}/${expected.submodule}`,
      );
    }

    // 正向：结果里不得残留任何 43 位 token，也不得含 '/' 残段。
    const serialized = `${actual.module}/${actual.submodule}`;
    if (/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/.test(serialized)) {
      throw new Error(`[${PKG_NAME}] ctx.log 归一化后仍含 43 位 Token：${path}`);
    }
    if (actual.module.includes('/') || actual.submodule.includes('/')) {
      throw new Error(`[${PKG_NAME}] ctx.log 归一化后仍含路径残段：${path}`);
    }
  }

  // 反向①：框架派生结果**必须**含 token（证明缺陷真实存在，断言才有意义）。
  const leaky = frameworkContextLogMeta(`/api/publicReview:get/${token}`);
  if (!leaky || !leaky.submodule.includes(token)) {
    throw new Error(
      `[${PKG_NAME}] ctx.log 归一化的反向自检失败：框架派生 meta 未含 path 里 Token。` +
        '这通常意味着框架的路径解析规则变了（request-logger.js:57），' +
        '本断言已不再覆盖真实缺陷，需要重新取证。',
    );
  }

  // 反向②：本来就干净的路由，**元数据归一化**不得触发（不替换 = 零行为变化）。
  // ⚠️ 注意这只约束"归一化"这一个动作。消息脱敏是**另一条**适用条件
  //    （只要本次请求有污点就做），因此干净路由的 `ctx.log` 仍会被包成脱敏代理 ——
  //    这正是 5xx（路径干净、错误消息回显请求内容）那条通路所需要的。
  for (const clean of ['/api/svc:health', '/api/publicStore:list', '/api/app:getInfo']) {
    if (needsContextLogNormalization(clean)) {
      throw new Error(
        `[${PKG_NAME}] ctx.log 元数据归一化误伤干净路由 ${clean}` +
          '（无路径残段时不得替换其 module/submodule，否则扩大改动面）',
      );
    }
  }
}

/**
 * 启动自检：请求污点脱敏必须真的能**改掉**泄漏文本，且不误伤正常文本。
 *
 * 样本全部是**合成值**（不是任何真实凭证），符合"取证材料也是凭证副本"
 * 的工程纪律 —— 自检代码里出现真 Token 等于把凭证又抄了一份。
 *
 * 成对断言（正向 + 反向）：
 *   ① 正向：请求里的 canary / 手机号 / 姓名 / 43 位 Token / Bearer 值都被收进污点集；
 *   ② 正向：框架那条真实泄漏文本（含 canary）脱敏后**不再含 canary**；
 *   ③ 反向：正常句子**逐字不变**（证明不是"见字符串就抹"）；
 *   ④ 反向：结构性 header（`content-type: application/json`）**不得**进污点集
 *      （否则正常日志会被打成 `[REDACTED]`）；
 *   ⑤ 反向：短值（低于 `TAINT_MIN_LENGTH`）不得进污点集；
 *   ⑥ 无污点时 `scrubLogArgs` **原样返回同一个数组**（零开销路径确实存在）。
 */
export function assertContextLogScrubbing(): void {
  const token = 'T'.repeat(43);
  const phone = '13800138000';
  const canary = 'RB1CANARY0123456789AB';
  const bearer = 'Bearer abcdefghijklmnop0123456789';
  const longName = '张测试用户甲乙丙丁戊';
  // 🔴 2 字中文名：长度远低于 ASCII 下限 11，但**必须**被收集 ——
  //    它守的是"中文姓名走 CJK 低下限"这条规则本身。
  const shortName = '张三';

  const stub = {
    reqId: 'req-stub',
    path: `/api/publicReview:get/${token}`,
    query: { token },
    request: {
      headers: {
        'content-type': 'application/json',
        'x-data-source': canary,
        authorization: bearer,
      },
      body: { phone, customer_name: longName, contact: shortName },
    },
  };

  const taints = collectRequestTaints(stub);
  const missing = [canary, phone, longName, shortName, token, bearer].filter((v) => !taints.includes(v));
  if (missing.length > 0) {
    throw new Error(
      `[${PKG_NAME}] 请求污点收集不全，缺失 ${missing.length} 项` +
        `（长度 ${missing.map((m) => m.length).join('/')}）—— ` +
        '框架 error-handler 回显的请求内容会重新落盘（Phase 10 / RB-1 第三处）。',
    );
  }

  // ④ 结构性 header 不得进污点集
  if (taints.includes('application/json')) {
    throw new Error(
      `[${PKG_NAME}] 污点集混入了结构性 header 值（application/json）—— 正常日志会被大面积误伤`,
    );
  }

  // ⑤ 两条下限都必须真的生效（ASCII 高、CJK 低）
  if (minTaintLength('main') !== TAINT_MIN_LENGTH || minTaintLength('S01') !== TAINT_MIN_LENGTH) {
    throw new Error(`[${PKG_NAME}] ASCII 短值未走 ${TAINT_MIN_LENGTH} 字符下限`);
  }
  if (minTaintLength(shortName) !== TAINT_MIN_LENGTH_CJK) {
    throw new Error(
      `[${PKG_NAME}] 含 CJK 的值未走 ${TAINT_MIN_LENGTH_CJK} 字符下限 —— 2~4 字中文姓名不会被脱敏`,
    );
  }
  if (TAINT_MIN_LENGTH_CJK >= TAINT_MIN_LENGTH) {
    throw new Error(`[${PKG_NAME}] CJK 下限（${TAINT_MIN_LENGTH_CJK}）必须**低于** ASCII 下限（${TAINT_MIN_LENGTH}）`);
  }

  // 反向：ASCII 短值不得进污点集（否则正常日志被大面积误伤）
  const shortAscii = collectRequestTaints({
    request: { headers: { 'x-src': 'S01' }, body: { s: 'main', t: 'json' } },
  });
  if (shortAscii.length > 0) {
    throw new Error(
      `[${PKG_NAME}] 污点集混入低于 ${TAINT_MIN_LENGTH} 字符的 ASCII 短值：${JSON.stringify(shortAscii)}`,
    );
  }

  // ② 框架真实泄漏形态的脱敏
  const leakedMessage = `data source ${canary} does not exist`;
  const leakedStack = `InternalServerError: ${leakedMessage}\n    at dataSourceManager (/app/nocobase/app.js:1:1)`;
  const scrubbed = scrubLogArgs([leakedMessage, { method: 'error-handler', err: leakedStack, cause: undefined }], taints) as any[];

  if (typeof scrubbed[0] !== 'string' || scrubbed[0].includes(canary) || !scrubbed[0].includes(REDACTED)) {
    throw new Error(`[${PKG_NAME}] ctx.log 消息脱敏未生效：${String(scrubbed[0])}`);
  }
  if (typeof scrubbed[1]?.err !== 'string' || scrubbed[1].err.includes(canary)) {
    throw new Error('[${PKG_NAME}] ctx.log 的 stack（第二实参）未被脱敏');
  }
  // 审计可用性：脱敏只换掉请求派生片段，句子的其余部分必须保留
  if (!scrubbed[0].includes('data source') || !scrubbed[0].includes('does not exist')) {
    throw new Error(`[${PKG_NAME}] ctx.log 脱敏过度：句子的非请求部分也被抹掉了 —— ${String(scrubbed[0])}`);
  }

  // ③ 正常文本逐字不变
  const clean = 'response GET svc:health 200 cost=27';
  if (scrubLogText(clean, taints) !== clean) {
    throw new Error(`[${PKG_NAME}] ctx.log 脱敏误伤正常文本：${scrubLogText(clean, taints)}`);
  }

  // ⑥ 无污点：原样返回同一引用
  const args = ['a', { b: 'c' }];
  if (scrubLogArgs(args, []) !== args) {
    throw new Error(`[${PKG_NAME}] 无污点时 scrubLogArgs 不应重建实参（零开销路径被破坏）`);
  }

  // Error 实例：脱敏 message 与 stack，且不改动入参
  const original = new Error(leakedMessage);
  original.stack = leakedStack;
  const scrubbedError = scrubLogValue(original, taints) as Error;
  if (!(scrubbedError instanceof Error) || scrubbedError.message.includes(canary) || !String(scrubbedError.stack).includes(REDACTED)) {
    throw new Error(`[${PKG_NAME}] ctx.log 脱敏未覆盖 Error 实例`);
  }
  if (!original.message.includes(canary)) {
    throw new Error(`[${PKG_NAME}] 脱敏修改了入参 Error 对象（必须返回副本，调用方可能仍持有它）`);
  }
}

// ---------------------------------------------------------------------------
// 挂载位置自检（实测踩到的坑，见下）
// ---------------------------------------------------------------------------

export interface NormalizerPlacement {
  present: boolean;
  index: number;
  /** 所有 group 为 `dataSource` 的节点在栈里的最早位置（-1 = 没找到） */
  dataSourceIndex: number;
  beforeDataSource: boolean;
  stack: string[];
}

/**
 * 读活栈，检查归一化中间件是否**真的会执行**。
 *
 * ⚠️ 为什么需要这个自检（不是洁癖）：
 *    `app.use(fn, {after: 'logger'})` 里的 `after` 只是**下界**。
 *    `@hapi/topo` 的拓扑排序在同层用 `seq`（注册序号）决胜，
 *    而我们是在**最后一个插件**里注册的 ⇒ `seq` 最大 ⇒ 被排到栈尾。
 *    实测首跑就是这么翻车的：节点确实进了栈（`stack=23 index=22`），
 *    但 `dataSource`（承载 resourcer 派发）排在它前面，
 *    而 resourcer 命中 action 后**不再 `await next()`** ⇒
 *    我们的中间件**永远不会执行** —— 日志里一条都没有，
 *    可栈序看起来"注册成功了"，是典型的假绿。
 *    ⇒ 因此必须显式声明 `before: 'dataSource'`，并且**在启动期断言位置**。
 */
export function inspectNormalizerPlacement(app: any, mw: unknown): NormalizerPlacement {
  const nodes: any[] = app?.middleware?.nodes ?? [];
  const items: any[] = app?.middleware?._items ?? [];

  const dataSourceNodes = items.filter((it) => it?.group === 'dataSource').map((it) => it?.node);
  const index = nodes.indexOf(mw as any);
  const dataSourceIndex = nodes.findIndex((n) => dataSourceNodes.includes(n));

  return {
    present: index >= 0,
    index,
    dataSourceIndex,
    beforeDataSource: index >= 0 && (dataSourceIndex < 0 || index < dataSourceIndex),
    stack: nodes.map((n: any) => n?.name || 'anon'),
  };
}

/**
 * 启动自检：归一化中间件必须在 `dataSource` **之前**。
 *
 * 失败即抛错（阻断启动）——这条自检守的是"改了等于没改"：
 * 位置错了不会报错、不会有症状，只是 Token 继续进 system 日志。
 */
export function assertNormalizerPlacement(app: any, mw: unknown): NormalizerPlacement {
  const placement = inspectNormalizerPlacement(app, mw);

  if (!placement.present) {
    throw new Error(
      `[${PKG_NAME}] ctx.log 归一化中间件不在 koa 栈里（注册被后续 init() 清掉了？）。` +
        '评价 Token 会重新进入 system_* 日志（Phase 10 / RB-1）。',
    );
  }

  if (!placement.beforeDataSource) {
    throw new Error(
      `[${PKG_NAME}] ctx.log 归一化中间件排在 dataSource 之后（index=${placement.index}，` +
        `dataSource=${placement.dataSourceIndex}）—— resourcer 命中 action 后不再调用 next()，` +
        '该中间件不会执行，等于没挂。必须显式声明 before: "dataSource"。' +
        `\n实际栈序：${placement.stack.join(' > ')}`,
    );
  }

  return placement;
}
