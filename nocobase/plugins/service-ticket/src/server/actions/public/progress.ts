/**
 * 客户**服务进度查询**的匿名接口（P11-4 · C 条）
 *
 * 路径（对外）：`GET /api/publicProgress:get/<token>`
 * 短链：`{PUBLIC_BASE_URL}/p/{token}` → 302 → `/h5/customer/progress/<token>`
 *       （与 `/t/` `/f/` 完全同构：302 / access_log off / 严格 shape / 畸形 404）
 *
 * ===========================================================================
 * 这个接口**不**做的事（用户明令）
 * ===========================================================================
 * ① 不要求客户账号 —— Token 本身就是凭证；
 * ② 不给评价 Token、不给师傅 Token、不给内部操作人 ID、不给审计细节；
 * ③ 不区分"Token 不存在 / 已撤销 / 已过期"（同一个 401，不构成探测器）；
 * ④ 不写任何发送逻辑 —— 短信走既有 outbox（`services.sms.enqueue`）。
 */
import { PROGRESS_TOKEN } from '../../constants';

export type ActionHandler = (ctx: any, next: () => Promise<void>) => Promise<void>;

export interface PublicProgressDeps {
  progress: {
    getProgress(token: string): Promise<
      | { ok: true; view: Record<string, unknown> }
      | { ok: false; code: string; status: number; message: string }
    >;
  };
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

// 复用 svc 的 _http.ts（理由见 media.ts：不写第二份响应约定）
import { fail } from '../svc/_http';

/**
 * 从请求里取 Token。
 *
 * **只认路径**，不认 query —— 与师傅/评价接口同一理由：
 * nginx 对 `/p/` 段做了 `access_log off`，Token 只出现在 path 上才受这条保护。
 * 若允许 `?token=...`，它就绕过了那条规则，落进 access log。
 */
function readToken(ctx: any): string {
  const candidates = [
    ctx?.action?.params?.token,
    ctx?.action?.params?.progressToken,
    ctx?.params?.token,
  ];
  for (const c of candidates) {
    const text = String(c ?? '').trim();
    if (text) return text;
  }
  // 兜底：URL path 的最后一段（nginx 重写后形如 /api/publicProgress:get/<token>）
  const path = String(ctx?.path ?? ctx?.request?.path ?? '');
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return last;
}

export function createPublicProgressHandlers(deps: PublicProgressDeps): Record<string, ActionHandler> {
  const publicProgressGet = async (ctx: any, _next: () => Promise<void>): Promise<void> => {
    const token = readToken(ctx);

    // 形状先判：不为合法形状的输入**不查库**（与 TokenService 的校验同序）
    if (!PROGRESS_TOKEN.PATTERN.test(token)) {
      fail(ctx, 401, 'PROGRESS_TOKEN_INVALID', '这个查询链接无效、已过期或已被撤销');
      return;
    }

    const result = await deps.progress.getProgress(token);
    if (!result.ok) {
      fail(ctx, result.status, result.code, result.message);
      return;
    }

    // 🔴 禁缓存：响应里含客户姓名、地址、媒体清单。
    ctx.set?.('Cache-Control', 'private, no-store, max-age=0');
    ctx.set?.('X-Content-Type-Options', 'nosniff');
    // NocoBase 的 dataWrapping 会包成 { data: ... }，这里**只给 payload**
    ctx.body = result.view;
  };

  return {
    'publicProgress:get': publicProgressGet,
  };
}
