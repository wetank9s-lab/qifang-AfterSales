/**
 * B-36：客户报修页 Banner 的**匿名读接口**（`publicBanner`）。
 *
 * **只有一个动作：`file`** —— 匿名按内容指纹文件名读一张已发布的 Banner 图。
 *
 * =============================================================================
 * 与 `publicMedia`（客户私有附件）的边界（**本轮最要紧的一条**）
 * =============================================================================
 * | | `publicMedia:file` | 本文件 `publicBanner:file` |
 * |---|---|---|
 * | 读什么 | 客户/师傅上传的工单附件 | **仅**平台管理员上传的品牌图 |
 * | 凭证 | 必须 `X-Media-Session` 或 `X-Progress-Token` | **无凭证**（公开资产） |
 * | 数据源 | `customer_medias` + 私有目录 | `store_banners` + 独立公开目录 |
 * | 缓存头 | `private, no-store` | `public, max-age=…, immutable` |
 *
 *   ⇒ 本文件**不 import** `media-store` / `customerMedias` / 私有目录的任何东西。
 *     它只碰 `store_banners` 与 `banner-store`。两条腿在代码层就是分离的。
 *
 * =============================================================================
 * "文件名不是权限"
 * =============================================================================
 *   路径段是内容指纹文件名，但 handler **每次都查库**确认该文件名属于
 *   `status='PUBLISHED' AND revoked_at IS NULL` 的行。
 *   ⇒ 下架后即使有人保存了 URL，也拿到 404（不留"下架了但还能看"的窗口）。
 *   ⇒ 未发布（DRAFT）的行同样取不到。
 */
import { GUARD_SCENE, GUARD_SCOPE, GUARD_WINDOW, RATE_LIMIT_SETTING_KEY } from '../../constants';
import { findPublicBannerByFileName } from '../../services/banner-service';
import { RateLimitedError } from '../../services/guard-service';
import { clientIpOf, handleError, ok, fail, traceId } from '../svc/_http';
import type { ActionHandler } from '../svc/_request';

export interface PublicBannerDeps {
  db: any;
  services: any;
  /** 独立公开 Banner 存储（**不是**客户媒体存储） */
  banners: {
    read(fileName: string): Promise<{ absPath: string; mime: string; size: number } | null>;
  };
  logger: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export function createPublicBannerHandlers(
  deps: PublicBannerDeps,
): Record<string, ActionHandler> {
  const { db, services, banners, logger } = deps;

  /**
   * 匿名读一张已发布 Banner。
   *
   * 有**独立的限流桶**（`public_banner`）：Banner 是图片资源，与方法调用相比
   * "一次首屏可能并发取 1~2 张、命中缓存后不再请求"，与配置 JSON 的量级不同，
   * 共桶会让图片把配置读取的配额吃掉（同 `public_ui` 与 `public_store` 分开的理由）。
   */
  const file: ActionHandler = async (ctx, next) => {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);
    try {
      const limit = await services.config.getInt(RATE_LIMIT_SETTING_KEY.IP_MINUTE_LIMIT);
      const decision = await services.guards.consume({
        scene: GUARD_SCENE.PUBLIC_BANNER,
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

      // 取路径段（NocoBase 单资源约定形态 + 兜底取 URL 最后一段，与 publicMedia:file 同一写法）
      const rawName =
        ctx?.action?.params?.filterByTk ??
        ctx?.action?.params?.fileName ??
        String(ctx?.path ?? ctx?.request?.path ?? '').split('/').filter(Boolean).pop();
      const fileName = String(rawName ?? '').trim();

      // ① **查库确认"这个文件是已发布且未下架的"** —— 这一步才是权限
      const row = await findPublicBannerByFileName(db, fileName);
      if (!row) {
        // 不存在、未发布、已下架、被停用 —— **回同一个响应**（不构成"这个文件名存在吗"的探测器）
        fail(ctx, 404, 'BANNER_NOT_FOUND', '图片不存在或已下架');
        await next();
        return;
      }

      // ② 从**独立公开目录**取文件
      const stored = await banners.read(fileName);
      if (!stored) {
        fail(ctx, 404, 'BANNER_NOT_FOUND', '图片不存在或已下架');
        await next();
        return;
      }

      const fs = await import('node:fs');
      ctx.status = 200;
      // 用**库里记录的** MIME（不是请求声明的，也不是从磁盘重新嗅探的）——
      // 入库时已由 magic bytes 判定，是可信值
      ctx.set('Content-Type', stored.mime);
      ctx.set('Content-Length', String(stored.size));
      /**
       * 🔴 缓存头与客户附件**完全相反**，这是有意为之：
       *    · Banner 是公开营销资产，鼓励缓存（省流量、首屏快）；
       *    · 文件名含内容指纹 ⇒ 内容变则 URL 变 ⇒ 不会拿到旧图，
       *      这正是"用文件名而非 no-store 来保证新鲜度"的做法；
       *    · `immutable` 让浏览器在期限内连条件请求都不发。
       */
      ctx.set('Cache-Control', 'public, max-age=86400, immutable');
      // 防 MIME 嗅探串改：即便被塞了奇怪内容，浏览器也不许改判类型
      ctx.set('X-Content-Type-Options', 'nosniff');
      // 允许被 H5 页面内嵌（同源，其实不需要 CORS，但显式声明不下载）
      ctx.set('Content-Disposition', 'inline');
      ctx.body = fs.createReadStream(stored.absPath);
      await next();
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicBanner:file');
      await next();
    }
  };

  return { file };
}

/** 供路由前缀拼 URL 用（与 H5 侧逐字一致，避免两处各写一份） */
export function bannerPublicPath(fileName: string): string {
  return `/api/public/banner/${encodeURIComponent(fileName)}`;
}

export { ok as __ok }; // 保持与其它 public handler 文件的导出形状一致（无实际用途）
