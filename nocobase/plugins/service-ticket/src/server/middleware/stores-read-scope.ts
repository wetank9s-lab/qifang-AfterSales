/**
 * stores-read-scope.ts —— 「门店报修入口」页的**门店主数据行级收窄**（UX-01C-R6 / B-18）
 *
 * ===========================================================================
 * 它解决什么问题
 * ===========================================================================
 * 「门店报修入口」是一张 `stores` 原生表格。B-18 的现象是：
 *   业务角色没有 `stores` 的资源级只读授权 ⇒ `stores:list` 403 ⇒ 页面「渲染失败」。
 * 但**不能**因此把 `stores` 塞进全局 `NATIVE_READ_ALLOWLIST` —— 那会对四个角色
 * 一起放开，且 NocoBase 的资源授权**没有行级维度**：门店账号会看到 15 家门店。
 *
 * ⇒ 权限分两层：
 *   ① 资源 × 角色：`native-metadata-guard` 按 `roleScopedResources` 放行（见 constants
 *      `STORES_READ_ROLES`，与后台菜单矩阵同源）；
 *   ② **行**：本中间件对门店角色注入 `id ∈ 授权门店`，其余角色按 `scopeOf` 原样。
 *
 * ===========================================================================
 * 为什么按 `scopeOf(actor)` 而不是自己查授权表
 * ===========================================================================
 * `store_users` 的解析、停用门店、多门店账号等规则已经在 `PermissionService.scopeOf()`
 * 里实现并有既有门禁。这里再写一份 = 第二套事实来源（本项目反复付代价的坑）。
 *
 * 行为：
 *   · 平台 root/admin：不经过本层（维护能力完整）；
 *   · 匿名：交给 ACL（`stores` 不在匿名白名单，必然 401）；
 *   · 非只读 action：一律 403（门店主数据只读，写入只走后续受控端点）；
 *   · `list`：注入 `id IN (storeIds)`；无授权门店 ⇒ `id = -1`（恒空，fail-closed）；
 *   · `get`：主键必须在授权门店内，否则 **404**（与"不存在"同形，不给存在性信号）；
 *   · `view`：无主键时视为 ACL 能力探针（放行，无数据）；带主键时同上校验。
 *
 * ⚠️ 字段白名单不在这里：由 ACL 的 `fields`（`NATIVE_READ_FIELD_DENY.stores`）负责。
 */
import type { Context, Next } from 'koa';

import { STORES_READ_RESOURCE, STORES_READ_ROLES } from '../constants';
import type { PermissionService } from '../services/permission-service';

const READ_ACTIONS = new Set(['list', 'get', 'view']);
const PLATFORM_ROLE_NAMES = ['root', 'admin'];

export interface StoresReadScopeOptions {
  permissions: PermissionService;
  /** 便于门禁反向验证；缺省用 `STORES_READ_ROLES`（与菜单矩阵同源） */
  allowedRoles?: readonly string[];
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
}

function roleNamesOf(ctx: Context): string[] {
  const single = (ctx as any)?.state?.currentRole ? [String((ctx as any).state.currentRole)] : [];
  const multi = Array.isArray((ctx as any)?.state?.currentRoles)
    ? (ctx as any).state.currentRoles.map(String)
    : [];
  return [...new Set([...single, ...multi])];
}

function isPlatform(ctx: Context): boolean {
  const roles = roleNamesOf(ctx);
  return PLATFORM_ROLE_NAMES.some((r) => roles.includes(r));
}

/** 从 `filterByTk` / `filter.id` 里取主键（只接受正整数）。 */
function targetIdOf(ctx: Context): number | null {
  const params = (ctx as any)?.action?.params ?? {};
  const raw = params.filterByTk ?? params.filter?.id;
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
  return id;
}

export function createStoresReadScopeMiddleware(options: StoresReadScopeOptions) {
  const log = options.logger;
  const allowedRoles = options.allowedRoles ?? STORES_READ_ROLES;

  return async function storesReadScope(ctx: Context, next: Next): Promise<void> {
    if (String((ctx as any)?.action?.resourceName ?? '') !== STORES_READ_RESOURCE) return next();

    // 平台角色：维护能力完整
    if (isPlatform(ctx)) return next();

    // 匿名：ACL 已拒；这里不重复判定（匿名资源白名单里没有 stores）
    if (!(ctx as any)?.state?.currentUser) return next();

    const action = String((ctx as any)?.action?.actionName ?? '');

    // 门店主数据对业务角色**只读**：写动作一律拒绝（即便某天 ACL 被放宽）
    if (!READ_ACTIONS.has(action)) {
      log?.warn?.(`[svc:stores-read-scope] 拒绝 stores:${action}（只允许只读）`);
      ctx.throw(403, 'No permissions');
    }

    // 角色清单与后台菜单矩阵同源；不在清单里的角色不因"菜单隐藏"而仍有 API 权限
    const roles = roleNamesOf(ctx);
    if (!roles.some((r) => allowedRoles.includes(r))) {
      log?.warn?.(`[svc:stores-read-scope] 拒绝未授权角色读取 stores：${roles.join(',') || '无'}`);
      ctx.throw(403, 'No permissions');
    }

    // 数据范围：门店角色 = 授权门店；总部 / viewer = all（由 scopeOf 统一裁决）
    let scope: { kind: string; storeIds?: number[] };
    try {
      const actor = await options.permissions.resolveActor(ctx);
      scope = options.permissions.scopeOf(actor as any);
    } catch {
      // 解析不出身份 ⇒ fail-closed（不把"解析失败"当成"全量可见"）
      log?.warn?.('[svc:stores-read-scope] 身份解析失败，拒绝');
      ctx.throw(403, 'No permissions');
    }

    if (scope.kind === 'all') return next();

    const ids = scope.kind === 'stores' ? (scope.storeIds ?? []) : [];

    const actionObj = (ctx as any).action;
    const params = actionObj?.params ?? {};

    // get：主键必须在范围内（越权与不存在同形 404）
    if (action === 'get') {
      const id = targetIdOf(ctx);
      if (id === null || !ids.includes(id)) {
        log?.warn?.(`[svc:stores-read-scope] get #${String(params.filterByTk)} 不在授权门店内，拒绝`);
        ctx.throw(404, '记录不存在');
      }
      return next();
    }

    // view：无主键 = ACL 能力探针（放行，无数据）；有主键 = 同 get 校验
    if (action === 'view') {
      const id = targetIdOf(ctx);
      if (id === null) return next();
      if (!ids.includes(id)) {
        log?.warn?.('[svc:stores-read-scope] view 目标不在授权门店内，拒绝');
        ctx.throw(404, '记录不存在');
      }
      return next();
    }

    // list：注入行范围（$and 叠加，不能用 filter 挤掉）
    const scopeFilter = ids.length > 0 ? { id: { $in: ids } } : { id: -1 };
    const original = params.filter;
    const merged = original ? { $and: [original, scopeFilter] } : scopeFilter;
    if (typeof actionObj?.mergeParams === 'function') {
      actionObj.mergeParams({ filter: merged });
    } else {
      (ctx as any).action.params = { ...params, filter: merged };
    }

    log?.debug?.(`[svc:stores-read-scope] stores:list 收窄为 ${ids.length} 家门店`);
    return next();
  };
}
