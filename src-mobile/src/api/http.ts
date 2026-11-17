/**
 * 统一请求层 —— 所有业务适配器的**唯一**出口。
 *
 * ===========================================================================
 * 为什么必须有这一层，而不是每个页面自己 fetch
 * ===========================================================================
 *   本项目的工作台页面要调用 20+ 个接口，它们共享四件必须一致的事：
 *
 *     ① **登录态**：Bearer Token 从哪来、放哪个头；
 *     ② **X-Request-Id**：全部 svc 写动作都要求合法 UUID v4，
 *        它同时是幂等键 —— 少了它服务端直接 422，而 422 的提示语
 *        看起来像"参数错了"，会把排查引向完全错误的方向；
 *     ③ **错误归一**：服务端的错误码散落在 `errors[].code` /
 *        `errors[].message` / 裸 404 / HTML 403 页（Nginx 拦的）四种形态里；
 *     ④ **401 处理**：登录过期必须跳到登录页，而不是让每个页面各自弹"请求失败"。
 *
 *   这四件事只要有**一处**没做对，症状都是"某个页面偶发失败"，
 *   而那种失败最难复现也最难归因。
 *
 * ===========================================================================
 * 安全边界：本层**不做任何权限判断**
 * ===========================================================================
 *   前端不决定"能不能看某条工单"。所有数据范围由服务端 ACL 裁剪。
 *   本层只负责"把请求正确发出去、把响应正确读回来"。
 *   任何"前端过滤一遍更安全"的想法都是错觉 —— 数据已经到浏览器了。
 */

/** 会话 token 的存储键。与 NocoBase 后台的 localStorage 前缀**刻意不同**： */
const TOKEN_KEY = 'svc.mobile.token';

/** 请求超时。10s 是"用户还愿意等"的上界；再长就该给取消按钮了 */
const TIMEOUT_MS = 10_000;

/** RFC4122 v4 UUID */
export function newRequestId(): string {
  // crypto.randomUUID 在 iOS 15.4+ / Chrome 92+ 可用；本项目不兼容旧 iPhone
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 兜底：非安全上下文（http://192.168.x.x 调试时）randomUUID 不可用
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 归一化后的错误。**页面只处理这一种形态**，不要去看 axios/fetch 的原始结构 */
export class ApiError extends Error {
  constructor(
    /** HTTP 状态码；网络层失败时为 0 */
    readonly status: number,
    /** 服务端业务错误码，如 `ARCHIVE_FORBIDDEN`；取不到时为 `HTTP_<status>` */
    readonly code: string,
    /** 面向用户的中文消息 */
    readonly userMessage: string,
    /** 附加字段（如 429 的 retry_after_seconds） */
    readonly detail?: Record<string, unknown>,
  ) {
    super(userMessage);
    this.name = 'ApiError';
  }

  /** 网络不可达 / 超时 —— 页面应给"重试"而不是"这个功能坏了" */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
  /** 登录态失效 —— 由 http 层统一跳登录，页面不必各自处理 */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  /** 无权限（服务端明确拒绝） */
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** 不存在或越权 —— 本项目刻意把两者统一成 404，页面**不应**尝试区分 */
  get isNotFound(): boolean {
    return this.status === 404;
  }
  /** 触发限流 */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  /** 版本冲突（乐观锁）—— 页面应提示"数据已被修改，请刷新" */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

/** 401 时的统一回调。由 session 模块注册，避免 http 层依赖 UI */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // 隐私模式 / 存储被禁用
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 存不了就只在内存里活着（下面 memoryToken 兜底） */
  }
  memoryToken = token;
}

/** localStorage 不可用时的内存兜底（页面刷新后会丢，但那比"直接不能用"好） */
let memoryToken: string | null = null;

function authToken(): string | null {
  return getToken() ?? memoryToken;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON body。**不要**在此传 FormData —— 见 upload() */
  body?: unknown;
  /** 额外头（如 `X-Role`） */
  headers?: Record<string, string>;
  /** 请求超时覆盖 */
  timeoutMs?: number;
  /** 是否自动带 X-Request-Id（写动作**必须**带） */
  withRequestId?: boolean;
  /** 已在外层生成的请求号（同一用户操作跨多次调用时复用，保证幂等） */
  requestId?: string;
  /** 跳过 401 自动跳转（登录接口自身用） */
  skipAuthRedirect?: boolean;
}

/** NocoBase 的 API 根。同源部署，所以是相对路径 */
const API = '/api';

/**
 * 把服务端的四种错误形态归一成一个 ApiError。
 *
 * 形态①：`{ errors: [{ message, code }] }`（NocoBase 标准）
 * 形态②：`{ error: { message, code } }`（部分中间件）
 * 形态③：Nginx 的 HTML 403/404 页（`<html>...` 而不是 JSON）
 * 形态④：空 body（502/504 之类）
 */
function normalizeError(status: number, text: string): ApiError {
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON —— 大概率是 Nginx 的 HTML 错误页 */
  }

  const first = json?.errors?.[0] ?? json?.error ?? null;
  const rawCode = String(first?.code ?? '').trim();
  const rawMsg = String(first?.message ?? '').trim();
  const detail = first?.detail && typeof first.detail === 'object' ? first.detail : undefined;

  // 服务端消息是**中文**且面向用户的（本项目后端一直如此写），
  // 所以优先直接展示；只有拿不到时才用兜底文案。
  const fallback = (() => {
    if (status === 0) return '网络连接失败，请检查网络后重试';
    if (status === 401) return '登录已过期，请重新登录';
    if (status === 403) return '没有权限执行此操作';
    if (status === 404) return '内容不存在或已被移除';
    if (status === 409) return '数据已被修改，请刷新后重试';
    if (status === 413) return '文件太大，无法上传';
    if (status === 422) return '提交的内容格式不正确';
    if (status === 429) return '操作太频繁，请稍后再试';
    if (status === 502 || status === 503 || status === 504) return '服务暂时不可用，请稍后重试';
    if (status >= 500) return '服务异常，请稍后重试';
    return `请求失败（${status}）`;
  })();

  return new ApiError(
    status,
    rawCode || `HTTP_${status}`,
    // ⚠️ 只信任"看起来是给人看的"消息。Nginx 的 HTML 页里没有 message，
    //    如果把 HTML 塞进 userMessage，界面上会出现一大段标签。
    rawMsg && !rawMsg.startsWith('<') ? rawMsg : fallback,
    detail,
  );
}

/**
 * 发一个请求。返回**解包后**的 `data`（NocoBase 用 dataWrapping 包了层 `{data: ...}`）。
 *
 * ⚠️ 解包规则要写清：
 *   · 业务接口：`{ data: X }` → 返回 `X`；
 *   · 列表接口：`{ data: [...], meta: {...} }` → 返回 `{ rows, meta }`（见 listRequest）。
 *   这两种形态混在一起是 NocoBase 前端最容易写错的地方，所以这里分开两个函数。
 */
export async function request<T = unknown>(path: string, opt: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('/') ? `${API}${path}` : `${API}/${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opt.headers ?? {}),
  };

  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = {
    method: opt.method ?? 'GET',
    headers,
    // ⚠️ 同源部署下 `same-origin` 是默认值，显式写出来是为了让人看见"这是刻意的"：
    //    本应用**不需要** Cookie，登录态走 Bearer。
    credentials: 'same-origin',
  };

  if (opt.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opt.body);
  }

  if (opt.withRequestId) {
    headers['X-Request-Id'] = opt.requestId ?? newRequestId();
  }

  // 超时：AbortController + setTimeout。
  // ⚠️ 一定要区分"用户主动取消"与"超时"，否则用户退出页面时会看到一条假的网络错误。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), opt.timeoutMs ?? TIMEOUT_MS);
  init.signal = ctrl.signal;

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    clearTimeout(timer);
    // AbortError 但**不是**我们主动 abort 的（页面卸载）时也归为网络错误
    const msg = (e as Error)?.message ?? '';
    return Promise.reject(
      new ApiError(0, 'NETWORK_ERROR', msg === 'timeout' ? '请求超时，请重试' : '网络连接失败，请检查网络后重试'),
    );
  }
  clearTimeout(timer);

  const text = await res.text();

  if (!res.ok) {
    const err = normalizeError(res.status, text);
    if (err.isUnauthorized && !opt.skipAuthRedirect) {
      // 统一清 token 并通知上层跳登录。**不在每个页面重复这件事**。
      setToken(null);
      onUnauthorized?.();
    }
    return Promise.reject(err);
  }

  // 204 / 空 body
  if (!text) return undefined as T;

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // 200 但不是 JSON —— 通常是 Nginx 把请求转到了 SPA（配置错），
    // 它会返回 200 + index.html。这种"成功"比失败更危险，必须显式报错。
    return Promise.reject(
      new ApiError(res.status, 'BAD_RESPONSE', '服务返回了非预期的内容（可能配置有误）'),
    );
  }

  return (json?.data ?? json) as T;
}

/**
 * 列表请求。
 *
 * ⚠️ 单独一个函数是因为列表的响应形态是 `{ data: [...], meta: { count, page, pageSize } }`，
 *    而 `request()` 会把 `data` 解出来丢掉 `meta`。**`meta.count` 是本项目
 *    "状态分组计数"的唯一来源**（服务端算好的，前端不要自己数当前页）。
 */
export interface ListResult<T> {
  rows: T[];
  /** 满足条件的**总条数**（不是当前页条数） */
  total: number;
  page: number;
  pageSize: number;
}

export async function listRequest<T = unknown>(
  path: string,
  opt: RequestOptions = {},
): Promise<ListResult<T>> {
  const url = path.startsWith('/') ? `${API}${path}` : `${API}/${path}`;
  const headers: Record<string, string> = { Accept: 'application/json', ...(opt.headers ?? {}) };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), opt.timeoutMs ?? TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opt.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    return Promise.reject(new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'));
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    const err = normalizeError(res.status, text);
    if (err.isUnauthorized) {
      setToken(null);
      onUnauthorized?.();
    }
    return Promise.reject(err);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return Promise.reject(new ApiError(res.status, 'BAD_RESPONSE', '服务返回了非预期的内容'));
  }

  // 两种可能的包裹形态：`{data:[...], meta}` 或 `{data:{data:[...], meta}}`
  const inner = json?.data;
  const rows = Array.isArray(inner)
    ? inner
    : Array.isArray(inner?.data)
      ? inner.data
      : [];
  const meta = json?.meta ?? inner?.meta ?? {};

  return {
    rows: rows as T[],
    total: Number(meta?.count ?? rows.length) || 0,
    page: Number(meta?.page ?? 1) || 1,
    pageSize: Number(meta?.pageSize ?? rows.length) || rows.length,
  };
}

/**
 * multipart 上传。
 *
 * ⚠️ **必须**单独一个函数，不能复用 `request()`：
 *    手写 `Content-Type: multipart/form-data` 会让浏览器不再自动生成 boundary，
 *    服务端 multer 解析失败，报的错是"没有 file 字段"（NO_FILE 422）——
 *    看起来像"我没选文件"，实际是"头写错了"。
 *    ⇒ 这里**绝对不设 Content-Type**，交给 fetch 自己算。
 *
 * ⚠️ 也不支持"上传进度"：fetch 没有 progress 事件。
 *    本应用的照片都是单张 <5MB，用"整体 loading"足够；
 *    要真进度就得换 XHR —— 而那会引入本项目已经踩过的
 *    "fetch 与 XHR 两条通道被混淆"的坑。这里明确只用 fetch。
 */
export async function upload<T = unknown>(
  path: string,
  form: FormData,
  opt: { requestId?: string; timeoutMs?: number; onUnauthorized?: () => void } = {},
): Promise<T> {
  const url = path.startsWith('/') ? `${API}${path}` : `${API}/${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  headers['X-Request-Id'] = opt.requestId ?? newRequestId();
  // 刻意不设 Content-Type

  const ctrl = new AbortController();
  // 上传给更长的超时：手机网络上传 3MB 照片，10s 经常不够
  const timer = setTimeout(() => ctrl.abort('timeout'), opt.timeoutMs ?? 45_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    return Promise.reject(new ApiError(0, 'NETWORK_ERROR', '上传失败，请检查网络后重试'));
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    const err = normalizeError(res.status, text);
    if (err.isUnauthorized) {
      setToken(null);
      onUnauthorized?.();
    }
    return Promise.reject(err);
  }
  if (!text) return undefined as T;
  const json = JSON.parse(text);
  return (json?.data ?? json) as T;
}

/**
 * 取二进制（私有照片）。
 *
 * ⚠️ 这是"私有媒体必须带登录态"的**唯一**正确做法：
 *    `<img src="/api/svc:photo?...">` 无法带 Authorization 头 ⇒ 必然 401。
 *    必须用带 token 的 fetch 取成 Blob，再 `URL.createObjectURL`。
 *
 * ⚠️ 调用方**必须**在组件卸载时 `URL.revokeObjectURL` ——
 *    每张照片泄漏一个 objectURL 意味着整页图片常驻内存，
 *    在低端安卓机上会表现为"翻十张图后开始卡"。
 */
export async function fetchBlob(path: string, opt: RequestOptions = {}): Promise<Blob> {
  const url = path.startsWith('/') ? `${API}${path}` : `${API}/${path}`;
  const headers: Record<string, string> = { ...(opt.headers ?? {}) };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), opt.timeoutMs ?? 20_000);

  let res: Response;
  try {
    res = await fetch(url, { headers, credentials: 'same-origin', signal: ctrl.signal });
  } catch {
    clearTimeout(timer);
    return Promise.reject(new ApiError(0, 'NETWORK_ERROR', '图片加载失败'));
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text();
    const err = normalizeError(res.status, text);
    if (err.isUnauthorized) {
      setToken(null);
      onUnauthorized?.();
    }
    return Promise.reject(err);
  }
  return res.blob();
}

/** 构造带查询串的路径（自动 encode） */
export function qs(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}
