/**
 * native-metadata-guard.ts —— 业务角色的**平台元数据读取边界**（Phase 11 / P11-0 · B-8 收口）
 *
 * ===========================================================================
 * 🔴 为什么最终落在中间件层，而不是 ACL 层（第一手源码取证，2026-10-09）
 * ===========================================================================
 * 原计划是用 `acl.setStrategyResources(<业务集合白名单>)` 把 ① 策略层收紧成
 * "未知资源默认拒绝"。**该机制在本版不成立** —— 容器内
 * `@nocobase/plugin-acl/dist/server/server.js:610-618`：
 *
 * ```js
 * this.db.on("afterDefineCollection", async (collection) => {
 *   if (collection.options.loadedFromCollectionManager || collection.options.asStrategyResource) {
 *     this.app.acl.appendStrategyResource(collection.name);
 *   }
 * });
 * // afterUpdateCollection 同样处理；afterRemoveCollection 才 remove
 * ```
 *
 * ⇒ **框架自己会把"经集合管理器加载的集合"追加进 `strategyResources`**，
 *    所以 `setStrategyResources()` 刚设完就被重新撑大（实测：设了 4 个业务集合、
 *    重启后 `users:list` / `roles:list` / `collections:list` **仍然 200**）。
 *    那不是"我没配对"，而是**该旋钮在本版被框架设计成宽松的**。
 *
 * ⇒ 真正可用的收口点是**中间件 + 能力名**，与既有 `native-export-guard` 完全同型：
 *    · 判 `ctx.action.resourceName` / `ctx.action.actionName`（NocoBase **解析后**的能力名，
 *      换 URL 形态同样命中）；
 *    · 挂在 ACL 之后、handler 之前 ⇒ `root`/`admin` 绕过 ACL 也照样经过这里
 *      （所以本守卫**自己**放行平台角色）；
 *    · **默认拒绝**：不在允许清单里的 (resource, action) 对业务角色一律 403。
 *
 * ===========================================================================
 * 允许清单 = 用户锁定的"业务 collection + 平台 UI 精确 action"
 * ===========================================================================
 *   ① **业务 collection**（`ROLE_NATIVE_READ_RESOURCES` = 4 张）× 只读 action
 *      （`view` / `list` / `get`）—— 后台服务单列表/详情/时间线/通知记录；
 *   ② **平台 UI 精确 action**（`PLATFORM_UI_ACTION_ALLOWLIST`，每项带业务理由）
 *      —— 只放渲染必需的那**几个**，例如 `flowModels:findOne`；
 *   ③ 插件自己的 `svc` 资源：handler 内部自守（`loggedIn` + 服务层判定），
 *      本守卫不再叠加（否则等于把两套判据揉在一起）。
 *
 * ⚠️ **不是黑名单**：清单之外的一切（`users` / `roles` / `collections` 的 `list`,
 *    以及将来 NocoBase 新增的任何平台资源）**默认 403**。
 *    这正是用户 2026-10-09 锁定的"正向允许 / fail-closed"。
 *
 * 🔴 `root` / 平台 `admin` 不受影响；**业务 HQ_ADMIN ≠ 平台 root/admin**
 *    （业务管理员同样受本边界约束）。
 *
 * ⚠️ 匿名请求不经本守卫：匿名能力由"匿名 action 白名单 + handler 内守卫"负责，
 *    两套判据不要混在一起。
 */
import type { Context, Next } from 'koa';

/** 平台角色：它们不受本边界约束（平台维护能力必须完整）。 */
export const PLATFORM_ROLE_NAMES: readonly string[] = ['root', 'admin'];

/** 业务角色在原生接口上的只读 action（与 `ROLE_NATIVE_READ_ACTIONS` 同口径）。 */
const READ_ACTION_NAMES: readonly string[] = ['view', 'list', 'get'];

/** 本插件自己的资源：由 handler 内部自守，不经本守卫二次判定。 */
const SELF_GUARDED_RESOURCES: readonly string[] = ['svc'];

export interface NativeMetadataGuardOptions {
  /**
   * 业务 collection 白名单（可原生只读）。
   * ⚠️ 由调用方传入**单一事实来源**（`ROLE_NATIVE_READ_RESOURCES`），
   *    不在这里再抄一份 —— 两份清单必然漂移。
   */
  businessResources: readonly string[];
  /**
   * 平台 UI 精确授权清单（每项含 resource / action / reason）。
   * 同样由调用方传入 `PLATFORM_UI_ACTION_ALLOWLIST`。
   */
  platformUiActions: ReadonlyArray<{ resource: string; action: string; reason: string }>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
}

/** 当前请求是否属于平台角色（root / admin）。 */
export function hasPlatformRoleIn(ctx: Context): boolean {
  const single = (ctx as any)?.state?.currentRole ? [String((ctx as any).state.currentRole)] : [];
  const multi = Array.isArray((ctx as any)?.state?.currentRoles)
    ? (ctx as any).state.currentRoles.map(String)
    : [];
  const all = new Set([...single, ...multi]);
  for (const r of PLATFORM_ROLE_NAMES) if (all.has(r)) return true;
  return false;
}

/**
 * 纯判定：这笔 (resource, action) 对"已登录的业务角色"是否允许？
 *
 * 抽成纯函数的原因（与 `isNativeExportDenied` 同纪律）：
 * 门禁可以对它**直接断言**，不必起 HTTP；也让"判据"与"中间件"分离，改判据不用动挂载。
 */
export function isBusinessMetadataAllowed(
  resourceName: string | undefined,
  actionName: string,
  options: { businessResources: readonly string[]; platformUiActions: ReadonlyArray<{ resource: string; action: string }> },
): boolean {
  const resource = String(resourceName ?? '');
  const action = String(actionName ?? '');
  if (!resource || !action) return false;

  if (SELF_GUARDED_RESOURCES.includes(resource)) return true;

  // ① 业务 collection × 只读 action
  if (options.businessResources.includes(resource) && READ_ACTION_NAMES.includes(action)) return true;

  // ② 平台 UI 的**精确** resource:action（不是整个 resource）
  for (const item of options.platformUiActions) {
    if (item.resource === resource && item.action === action) return true;
  }

  // ⇒ 其余一律拒绝（正向允许 / fail-closed）
  return false;
}

/**
 * 创建守卫中间件。
 *
 * ⚠️ 挂载位置与 `native-export-guard` 同组序（`after: 'acl'`）：
 *    ACL 之后、handler 之前 ⇒ 即使某天 ACL 又放行了什么，这里仍然是最后一道。
 */
export function createNativeMetadataGuardMiddleware(options: NativeMetadataGuardOptions) {
  const log = options.logger;

  return async function nativeMetadataGuard(ctx: Context, next: Next): Promise<void> {
    // 匿名请求：不归本守卫管（匿名能力由匿名白名单 + handler 守卫负责）
    const hasUser = Boolean((ctx as any)?.state?.currentUser);
    if (!hasUser) return next();

    // 平台角色：完整维护能力
    if (hasPlatformRoleIn(ctx)) return next();

    const resource = (ctx as any)?.action?.resourceName;
    const action = (ctx as any)?.action?.actionName;

    if (isBusinessMetadataAllowed(resource, action, options)) return next();

    // 拒绝：只记能力名，不记任何数据
    log?.debug?.(
      `[svc:native-metadata-guard] 拒绝业务角色访问平台元数据：${String(resource)}:${String(action)}`,
    );
    ctx.throw(403, 'No permissions');
  };
}
