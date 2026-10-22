/**
 * 客户 H5 的**装修配置接口**（UX-01D M1）。
 *
 * 两个接口，注意它们的安全语义完全不同：
 *
 * | 接口 | 凭证 | 读什么 | 缓存 |
 * |---|---|---|---|
 * | `GET  /api/publicUiTheme:get` | 无（公开） | **最新已发布**快照（无发布 ⇒ 默认值，version=0） | ETag + no-cache |
 * | （预览不再走匿名接口） | —— | 草稿由受控动作 `svc:uiThemePreviewDoc` 取，后台 iframe 只收内容 | —— |
 *
 * ⚠️ 预览凭证**绝不放进 URL**：URL 会被 nginx access log 原样记录、会进 `Referer`、
 *    也会被"复制链接"带出去。因此这里刻意用 POST + body。
 */
import { request, ApiError } from './http';

/** 带超时的请求包装：装修配置**不允许拖慢首屏**（拿不到就用默认值） */
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    window.clearTimeout(timer);
  }
}

export interface UiConfigResponse {
  version: number;
  schema_version: number;
  brand: { name: string; subtitle: string };
  theme: { preset: string };
  copy: { media_help: string };
  modules: { media_help: boolean };
}

export interface UiPreviewStore {
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
}

export interface UiPreviewResponse {
  preview: true;
  revision: number;
  expires_at: string;
  store: UiPreviewStore;
  doc: UiConfigResponse;
}

/**
 * 读已发布配置。
 *
 * `entry` 目前不参与服务端判定（v1 只有总部一套），但**必须**由调用方传进来：
 * 将来做门店覆盖时，解析顺序是 store → hq，接口形状不需要再改一次。
 */
export async function fetchUiConfig(entry?: string): Promise<UiConfigResponse> {
  const qs = entry ? `?k=${encodeURIComponent(entry)}` : '';
  return withTimeout(4000, (signal) =>
    request<UiConfigResponse>(`/api/publicUiTheme:get${qs}`, { signal }),
  );
}

export { ApiError };
