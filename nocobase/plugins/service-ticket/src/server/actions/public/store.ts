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
// P11-1：门店专属入口的解析（签名校验的唯一实现）
import { resolveStoreEntry } from '../../services/store-entry';
// 入口值由 nginx 从路径注入成 query 参数 ⇒ 需要能读 query 的参数读取器
import { param } from '../svc/_request';
import { ValidationError } from '../../services/ticket-service';
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

/**
 * `GET /api/public/stores/<entry>` —— **按专属入口解析出门店**（Phase 11 / P11-1）。
 *
 * 客户的 H5 报修页用它做两件事：
 *   ① 拿到**该显示哪个门店名**（req 3：页面醒目显示门店名称）；
 *   ② 确认这个入口是**有效的**（签名校验过、门店启用），否则当场告诉客户"链接不可用"，
 *      而不是等填完一整张表单再在提交时被拒。
 *
 * 🔴 只回 `{ code, name, provenance }`：**没有 id、没有电话、没有内部字段** ——
 *    这是匿名接口，输出裁剪是它唯一的实质工作（与 `list` 同一纪律）。
 *
 * ⚠️ `provenance` 会**如实下发**：`legacy` 表示这是旧二维码（无签名防篡改）。
 *    页面据此显示对应的提示 —— 不得把两种入口说得一样安全（req 5）。
 */
export function createPublicStoreEntryHandler(deps: PublicStoreDeps): ActionHandler {
  const { services, logger } = deps;

  return async function publicStoreEntry(ctx: any, next: () => Promise<void>): Promise<void> {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);

    try {
      // 与 `list` **同一个限流桶**：两者都是"进页面前必调"的匿名读接口，
      // 分开计桶等于给了两倍的免费查询额度。
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

      const secret = String(process.env.SIGN_SECRET ?? '').trim();
      const entry = resolveStoreEntry(param(ctx, 'k') ?? param(ctx, 'entry'), secret);
      if (!entry.ok) {
        // ⚠️ 三种失败给**同一句话**：对外不必区分"签名错"与"编码不存在" ——
        //    区分它们等于告诉探测者"这个编码是存在的，只是签名不对"。
        //    但服务端日志里保留精确原因（排障要用）。
        logger.warn?.(`[public:storeEntry] 入口无效（${entry.error}，trace=${trace}）`);
        throw new ValidationError('STORE_ENTRY_INVALID', '门店报修入口无效或已停用，请重新扫描门店二维码', 404);
      }

      const store = await (ctx.app as any).db
        .getRepository('stores')
        .findOne({ filter: { code: entry.code }, fields: ['code', 'name', 'active'] });

      // 不存在与停用**对外同形**（都 404）：停用门店的入口与"不存在的入口"
      // 在客户眼里是同一件事（打不开就是打不开），而区分它们会暴露门店状态。
      if (!store || store.active !== true) {
        logger.warn?.(
          `[public:storeEntry] 门店 ${entry.code} ${store ? '已停用' : '不存在'}（trace=${trace}）`,
        );
        throw new ValidationError('STORE_ENTRY_INVALID', '门店报修入口无效或已停用，请重新扫描门店二维码', 404);
      }

      ok(ctx, {
        code: String(store.code),
        name: String(store.name),
        provenance: entry.provenance,
      });
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicStore:entry');
    }

    await next();
  };
}

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
