/**
 * 网络层：统一请求号（X-Request-Id）、统一错误形状、统一 JSON 解析。
 *
 * ---------------------------------------------------------------------------
 * 为什么请求号在**前端**生成而不是后端
 * ---------------------------------------------------------------------------
 * 后端把 `X-Request-Id` 当作幂等键：同一个号重复提交 → 回放首次响应，
 * 不新建工单（docs/API.md §1.2 / Phase 3-D）。
 * 这就要求"号"必须在**第一次尝试之前**就确定，而不是每次请求现生成 ——
 * 后者等于每次重试都是一次全新的提交，"重试"和"再报一单"再也分不开。
 * 所以号的归属是**一次用户意图**（一次提交动作），由前端持有并复用。
 *
 * ---------------------------------------------------------------------------
 * 错误形状
 * ---------------------------------------------------------------------------
 * 后端所有错误都是 `{ errors: [{ code, message, detail }] }`（docs/API.md §0）。
 * 这里统一拍平成 `ApiError`，让页面只面对 `code` 一个维度：
 * 页面按 code 决定 UI（400 高亮隐私框 / 409 跳原单 / 429 倒计时 / 422 定位字段），
 * 不按 HTTP 状态码猜语义 —— 状态码只用来兜底。
 */
import { newRequestId } from '../utils/uuid';

/** 与后端 `actions/svc/_http.ts` 的 REQUEST_ID_HEADER 保持一致（HTTP 头名大小写不敏感） */
export const REQUEST_ID_HEADER = 'x-request-id';

export interface ApiFieldError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(status: number, error: ApiFieldError) {
    super(error.message || `请求失败（HTTP ${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code || 'UNKNOWN';
    this.detail = error.detail;
  }

  /** 网络断了 / 域名打不开 / 被中断：没有 HTTP 状态码可用 */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 幂等键。写接口**必须**传（后端缺失即 422），读接口可不传 */
  requestId?: string;
  signal?: AbortSignal;
  /** 便于验收脚本注入受控实现；生产走全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 后端响应体：成功 `{data}`，失败 `{errors:[...]}` */
interface Envelope<T> {
  data?: T;
  errors?: ApiFieldError[];
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, requestId, signal, fetchImpl } = options;
  const doFetch = fetchImpl ?? globalThis.fetch;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (requestId) headers[REQUEST_ID_HEADER] = requestId;

  let response: Response;
  try {
    response = await doFetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // 网络层失败（离线、DNS、连接被重置）。**不伪造** code：
    // 页面据此提示"网络异常，请稍后重试"，绝不能提示成"提交成功"。
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: (error as Error)?.message || '网络异常，请检查网络后重试',
    });
  }

  let payload: Envelope<T> | null = null;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    // 网关/代理返回了 HTML（如 nginx 502 页面）。不要把 HTML 当数据往下传。
    throw new ApiError(response.status, {
      code: 'BAD_GATEWAY_RESPONSE',
      message: `服务返回了非 JSON 内容（HTTP ${response.status}）`,
    });
  }

  if (!response.ok || payload?.errors?.length) {
    const first = payload?.errors?.[0];
    throw new ApiError(
      response.status,
      first ?? { code: 'UNKNOWN', message: `请求失败（HTTP ${response.status}）` },
    );
  }
  // 后端成功一律包一层 data；没有 data 视为协议违约，而不是"空成功"
  if (payload?.data === undefined) {
    throw new ApiError(response.status, {
      code: 'MALFORMED_RESPONSE',
      message: '服务响应缺少 data 字段',
    });
  }
  return payload.data;
}

export { newRequestId };
