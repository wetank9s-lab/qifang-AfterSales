/**
 * **前后端共享**的写请求契约（X-Request-Id）
 *
 * 零依赖纯模块，理由与 service-mode.ts 相同：服务端、浏览器端、离线断言脚本
 * 三处共用同一份定义，不可能各自漂移。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须显式发这个头（2026-09-21 复核方裁定）：
 *
 *   服务端六个内部写动作（accept / transfer / cancel / dispatch / reassign /
 *   reschedule）都要求合法的 UUID v4 的 `X-Request-Id`，缺失即 422。
 *   而客户端统一请求器原先只发 `url / method / data`，没有任何东西保证这个头存在
 *   —— NocoBase 是否有全局拦截器自动代劳，**仓库里没有任何证据**。
 *   赌框架隐式行为的代价是：真机上一按按钮就 422，而本地静态审查稳定全绿。
 *
 *   因此这里取显式立场：**客户端自己生成，自己发送**。
 *
 * ---------------------------------------------------------------------------
 * `X-Request-Id` 在**本项目**里的两个用途（不是泛泛的链路追踪规范）：
 *
 *   ① 链路追踪锚点：写进事件 metadata 与日志。
 *   ② **幂等键**：同一个「动作 + 工单 + 操作者 + request_id」的重放，
 *      服务端按首次结果回放，不产生第二条 Visit / 第二个 Token / 第二封短信
 *      （真正的落库实现见 TicketService 的 runIdempotentWrite，方案 A）。
 *
 * ⚠️ 「一次**逻辑操作**」= 一个 request id。网络层重试必须**复用同一个号**，
 *    每次重试换个号就等于把幂等这条防线自己拆掉（服务端会当成两次新请求）。
 */
/** 幂等/追踪请求头名 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 服务端在**命中幂等回放**时回写的响应头（body 仍与首次完全一致） */
export const IDEMPOTENCY_REPLAY_HEADER = 'X-Idempotent-Replay';

/** RFC 4122 UUID v4 */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 是否为合法 UUID v4（服务端用的是同一条正则，不存在"客户端宽松服务端严"） */
export function isUuidV4(value: unknown): boolean {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value.trim());
}

/**
 * 生成一个随机 UUID v4。
 *
 * ⚠️ 拿不到随机数源时**抛错**，而不是退化成 `Date.now()` 之类的弱随机数：
 *    request id 同时是幂等键，两个不同操作撞号会让后一个被误判成重放
 *    （表现为"点了按钮什么都没发生"）—— 那是比报错难查得多的一类缺陷。
 */
export function newRequestId(): string {
  const webCrypto: any = (globalThis as any)?.crypto;
  if (webCrypto?.randomUUID) return String(webCrypto.randomUUID());

  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    // RFC 4122 §4.4：第 7 字节高 4 位置 0100（v4），第 9 字节高 2 位置 10（variant）
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`
    );
  }

  throw new Error(
    '当前运行环境不提供 crypto.getRandomValues，无法生成幂等请求号' +
      '（浏览器请在 localhost 或 HTTPS 下访问后台）',
  );
}

// ---------------------------------------------------------------------------
// svc 写请求
// ---------------------------------------------------------------------------

/** 统一请求器形态（浏览器里由 index.ts 注入，离线断言里由测试桩注入） */
export type SvcRequester = (
  url: string,
  method: string,
  body?: unknown,
  options?: { headers?: Record<string, string> },
) => Promise<any>;

export interface SvcRequestConfig {
  url: string;
  method: string;
  data: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * 组装一个 svc 写请求。
 *
 * `filterByTk` 而不是路径参数：NocoBase 的多段 action 名不可达
 * （`svc:tickets:accept` 的第三段会被静默丢弃），对外路径由 nginx 重写成
 * `/api/svc:<action>?filterByTk=<id>`（见 docs/DEVIATIONS.md DEV-18）。
 */
export function buildSvcRequest(params: {
  action: string;
  ticketId?: number | string | null;
  body?: Record<string, unknown>;
  requestId: string;
}): SvcRequestConfig {
  const { action, ticketId, body, requestId } = params;
  const query = ticketId === undefined || ticketId === null || ticketId === ''
    ? ''
    : `?filterByTk=${ticketId}`;
  return {
    url: `svc:${action}${query}`,
    method: 'post',
    data: body ?? {},
    headers: { [REQUEST_ID_HEADER]: requestId },
  };
}

/**
 * 是否为"网络层没拿到响应"的失败。
 *
 * 判定刻意从严：**只有拿不到 HTTP status 时才重试**。
 * 服务端给了明确状态码（409/422/500）时，重放与否应该由调用方决定（通常是给人看），
 * 而不是悄悄再来一次 —— 500 可能意味着已经写了一部分（那是幂等键要兜的底）。
 */
export function isNetworkFailure(error: unknown): boolean {
  const anyError = error as any;
  // `== null` 同时覆盖 undefined 与 null：axios 在请求根本没发出去时两条都不给
  return anyError?.response == null && anyError?.status == null;
}

/**
 * 发一个 svc 写请求，并在**网络层失败**时复用同一个 request id 重试一次。
 *
 * 为什么要重试：弱网/断网重连时"点了一次没反应"是后台最常见的一类抱怨，
 * 而这正是幂等要覆盖的场景 —— 请求可能已经到达服务端并写完了库。
 *
 * 为什么最多 1 次重试：再多就是放大流量，且人会在这期间自己去点，
 * 反而制造更多重复（而 UI 上我们已经 disable 了提交按钮）。
 */
export async function sendSvcRequest(
  request: SvcRequester,
  params: {
    action: string;
    ticketId?: number | string | null;
    body?: Record<string, unknown>;
    requestId: string;
    attempts?: number;
  },
): Promise<any> {
  const attempts = params.attempts && params.attempts > 0 ? params.attempts : 2;
  const { url, method, data, headers } = buildSvcRequest(params);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request(url, method, data, { headers });
    } catch (error) {
      lastError = error;
      // ⚠️ 同一个 requestId 全程复用（额外重试不换号），这是幂等的前提
      if (attempt >= attempts || !isNetworkFailure(error)) throw error;
    }
  }
  throw lastError;
}
