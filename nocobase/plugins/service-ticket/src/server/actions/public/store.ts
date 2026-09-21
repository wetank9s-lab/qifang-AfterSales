/**
 * 匿名客户接口 —— 门店下拉（docs/API.md §1.1）
 *
 * 路径（对外）：`GET /api/public/stores`
 * 应用实现路径：`GET /api/publicStore:list`
 *   （nginx 把对外路径重写过来，同 DEV-18 的做法：NocoBase 的 URL 形态是
 *    `/api/<resource>:<action>`，没有冒号的多段路径无法寻址到 action）
 *
 * ⚠️ 输出裁剪是**本接口唯一的实质工作**。
 *    门店表里有 `id` / `contact_phone` / `active` / `sort_order` —— 一个都不能出。
 *    原因（docs/API.md §1.1 明文）：客户 H5 是**无认证**页面，
 *    返回内部主键等于把"可枚举的实体 ID"送给任何人；门店电话则会被
 *    爬虫收入号码库用于骚扰。因此这里按 DTO 逐字段取值，
 *    **不是** `fields` 裁剪 —— 用 ORM 取全行再删字段，等于把敏感值读进内存再"记得删掉"，
 *    迟早有人加个日志把它打出来。
 *
 * ⚠️ 匿名 ≠ 不设防：本接口同样消耗 `security.ip_minute_limit`
 *    （scene = `public_store`，与提交工单分开计桶，见 constants.GUARD_SCENE）。
 *    为什么要限流一个只读接口：它是"进页面前必调"的接口，
 *    不限流就等于给了一个免费的、可无限打的数据库查询入口。
 */
import { GUARD_SCENE, GUARD_SCOPE, GUARD_WINDOW, RATE_LIMIT_SETTING_KEY } from '../../constants';
import { RateLimitedError, type Services } from '../../services';
import { clientIpOf, handleError, ok, traceId } from '../svc/_http';

export interface PublicStoreDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
}

export type ActionHandler = (ctx: any, next: () => Promise<void>) => Promise<void>;

/** 门店下拉的场景名（与提交工单分开计桶） */
const SCENE = GUARD_SCENE.PUBLIC_STORE;

export function createPublicStoreHandler(deps: PublicStoreDeps): ActionHandler {
  const { services, logger } = deps;

  return async function publicStoreList(ctx: any, next: () => Promise<void>): Promise<void> {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);

    try {
      // ---------------- ① IP 频控（消费式，与提交工单同阈值但不同桶） ----------------
      const limit = await services.config.getInt(RATE_LIMIT_SETTING_KEY.IP_MINUTE_LIMIT);
      const decision = await services.guards.consume({
        scene: SCENE,
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

      // ---------------- ② 只取必要字段（DTO 白名单，见文件头） ----------------
      const repository = (ctx.app as any).db.getRepository('stores');
      const rows = await repository.find({
        filter: { active: true },
        sort: ['sort_order', 'code'],
        // 只 SELECT 这两列 + 排序键：连 `id` 都不进内存
        fields: ['code', 'name', 'sort_order'],
      });

      const stores = (rows || []).map((row: any) => ({
        code: String(row.code),
        name: String(row.name),
      }));

      logger.debug?.(`[public:stores] 返回 ${stores.length} 家启用门店（trace=${trace}）`);
      ok(ctx, stores);
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicStore:list');
    }

    await next();
  };
}
