/**
 * UX-01D M1：客户 H5 装修配置的**匿名读接口**（`publicUiTheme`）。
 *
 * **只有一个动作：`get`** —— 匿名只读**最新已发布**快照。
 *
 * 预览（读草稿）**刻意不在匿名面**：它已改为受控动作 `svc:uiThemePreviewDoc`
 * （登录 + hq_admin + 签发者绑定 + revision 绑定）。理由：匿名接口只能验 HMAC，
 * 凭证被复制到别处仍可用，也无法回答"是谁在看"。
 *
 * =============================================================================
 * 两条必须守住的线
 * =============================================================================
 *   1. **绝不读草稿到公开面**：`get` 只走 `readPublishedUiTheme()`；
 *      草稿只能由 `svc:uiThemePreviewDoc`（登录 + hq_admin + 签发者本人 + revision 未变）取。
 *   2. **匿名响应只含白名单字段**：没有内部 id、没有操作人、没有门店 code；
 *      预览返回的"门店"是**合成门店**，预览链路**不查 `stores`**。
 *
 * 缓存：`get` 用 `ETag: W/"hq-<version>"` + `Cache-Control: no-cache`。
 *   · `/h5/` 的 HTML 已经是 `no-store`（nginx），所以配置不会随页面被缓存；
 *   · 未发布/未变化时回 304（省流量），发布后 ETag 变化 ⇒ 下次打开立刻生效。
 */
import { GUARD_SCENE, GUARD_SCOPE, GUARD_WINDOW, RATE_LIMIT_SETTING_KEY } from '../../constants';
import {
  DEFAULT_UI_DOC,
  publicPayloadOf,
  readPublishedUiTheme,
  UI_THEME_SCOPE,
} from '../../services/page-theme';
import { RateLimitedError } from '../../services/guard-service';
import { clientIpOf, handleError, ok, traceId } from '../svc/_http';
import type { ActionHandler } from '../svc/_request';

export interface PublicUiThemeDeps {
  db: any;
  services: any;
  logger: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export function createPublicUiThemeHandlers(
  deps: PublicUiThemeDeps,
): Record<string, ActionHandler> {
  const { db, services, logger } = deps;

  /**
   * 匿名读已发布配置。
   *
   * 有独立的限流桶（`public_ui`）：它每次打开页面都要调一次，
   * 与 `store-entry` 共用桶会让"打开一次页面"吃掉两倍的门店入口配额。
   */
  const get: ActionHandler = async (ctx, next) => {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);
    try {
      const limit = await services.config.getInt(RATE_LIMIT_SETTING_KEY.IP_MINUTE_LIMIT);
      const decision = await services.guards.consume({
        scene: GUARD_SCENE.PUBLIC_UI,
        scope: GUARD_SCOPE.IP,
        value: clientIpOf(ctx),
        limit,
        window: GUARD_WINDOW.MINUTE,
      });
      if (!decision.allowed) {
        ctx.set?.('Retry-After', String(decision.windowResetsInSeconds));
        throw new RateLimitedError('请求过于频繁，请稍后再试', {
          scope: decision.scope,
          window: decision.window,
          limit: decision.limit,
          used: decision.used,
          window_resets_in_seconds: decision.windowResetsInSeconds,
        });
      }

      const published = await readPublishedUiTheme(db, UI_THEME_SCOPE);
      const version = published?.version ?? 0;
      const etag = `W/"${UI_THEME_SCOPE}-${version}"`;

      ctx.set?.('Cache-Control', 'no-cache');
      ctx.set?.('ETag', etag);
      const inm = String(ctx.get?.('if-none-match') ?? '').trim();
      if (inm && inm === etag) {
        // 304：内容没变。**不带 body**（带 body 的 304 会被部分代理改写成 200，很难查）。
        ctx.withoutDataWrapping = true;
        ctx.status = 304;
        ctx.body = null;
        await next();
        return;
      }

      ok(ctx, publicPayloadOf(version, published?.doc ?? DEFAULT_UI_DOC));
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicUi:get');
    }
    await next();
  };

  return { get };
}

