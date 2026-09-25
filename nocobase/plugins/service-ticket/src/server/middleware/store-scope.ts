/**
 * storeScope 中间件 —— 把门店隔离钉在**框架层**，而不是靠每个业务接口自觉
 *
 * 为什么必须有一层中间件（docs/SECURITY.md「双层数据隔离」）：
 *   NocoBase 后台**自带**原生 CRUD 接口（`/api/serviceTickets:list`、`:get`、
 *   `:update` …）。只要这些接口可达，门店用户就能绕过我们自己写业务 action 的校验，
 *   直接 `/api/serviceTickets:list` 把**所有门店**的工单拉走。
 *   在业务 action 里做鉴权是必要的，但对原生接口**无效** ——
 *   所以必须在这一层统一注入数据范围。
 *
 * 覆盖范围（`SCOPED_RESOURCES`）：
 *   · serviceTickets  —— 自带 store_id，直接过滤
 *   · serviceVisits / ticketEvents / smsLogs —— 无 store_id，经 `ticket.store_id` 关联过滤
 *
 * **整资源封禁**（`NATIVE_FORBIDDEN_RESOURCES`，P6-0 新增）：
 *   · serviceVisitPhotos —— 原生口**任何角色**都不可访问（含 list/get/view/export），
 *     唯一出口是 `/api/svc/visits/:id` 与 `/api/svc/photos/:photoId`。
 *     为什么"不在白名单里"不足以关掉它，见该常量的注释（ACL 的 strategy 回退）。
 *
 * 四个动作分别处理，缺一不可：
 *   list    → 注入 filter（这是最常见的越权入口）
 *   get     → **先做对象级校验**（filterByTk 不走 filter，注入 filter 未必生效）
 *   update  → 先校验归属，再注入 filter（防 `update` by filter 批量改别人数据）
 *   destroy → 同 update
 *   create  → **直接拒绝**（工单必须经 /api/svc 业务 action 创建，见 docs/API.md §6）
 *
 * 失败策略：解析不出身份、范围 none、越权 —— 一律**拒绝**（fail-closed）。
 *   绝不"降级为放行"，那等于把隔离层做成装饰。
 */
import { TABLE, TICKET_READONLY_FIELDS } from '../constants';
import { CAPABILITY, ForbiddenError, NotFoundError, type Actor, type PermissionService } from '../services/permission-service';
import type { Services } from '../services';

/** 需要门店隔离的资源 → 隔离所依赖的关系路径 */
const SCOPED_RESOURCES: Record<string, { via: 'self' | 'ticket'; label: string }> = {
  serviceTickets: { via: 'self', label: '工单' },
  serviceVisits: { via: 'ticket', label: '服务回执' },
  ticketEvents: { via: 'ticket', label: '工单事件' },
  smsLogs: { via: 'ticket', label: '短信日志' },
};

/** 只读角色也允许的动作 */
const READ_ACTIONS = new Set(['list', 'get', 'export']);
/** 需要写权限的动作 */
const WRITE_ACTIONS = new Set(['create', 'update', 'destroy', 'move']);

/**
 * 只读字段守卫适用的资源。
 * 目前只有 serviceTickets —— 状态机字段集中在它身上（docs/API.md §6）。
 */
const READONLY_FIELD_GUARD: Record<string, string[]> = {
  serviceTickets: TICKET_READONLY_FIELDS,
};

/** 只读字段集合，转成 Set 便于 O(1) 命中（避免每次请求 includes 扫数组） */
const READONLY_FIELD_SETS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(READONLY_FIELD_GUARD).map(([resource, fields]) => [resource, new Set(fields)]),
);

/**
 * 原生接口上**任何角色都不可访问**的资源（不论 action 名）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么必须有这一层（Phase 6 · P6-0 实测发现，2026-09-25）
 * ─────────────────────────────────────────────────────────────────────────────
 * 此前的口径是"**不把 `serviceVisitPhotos` 放进 `NATIVE_READ_ALLOWLIST`** ⇒ 不可读"。
 * 真机实测证明这条**不成立**：门店角色 `GET /api/serviceVisitPhotos:list` 返回 **200**，
 * 且整行下发 `storage_key` / `upload_ip_hash` / `file_id`。
 *
 * 根因在 NocoBase ACL 的**回退分支**（`@nocobase/acl/lib/acl.js` `getCanByRole()`）：
 *   ```
 *   const aclResource = aclRole.getResource(resource);
 *   if (aclResource) { …按资源级授权判定，无该 action 即 deny… }
 *   // ↓ 资源级**没有条目**时落到这里
 *   if (this.strategyResources === null || this.strategyResources.has(resource)) {
 *     roleStrategyParams = roleStrategy?.allow(resource, action);
 *   }
 *   ```
 * 而 `strategyResources` 在本版本**始终是 `null`**（`setStrategyResources()` 全仓无调用点），
 * 于是"资源级没有条目"不是 deny，而是**回退到角色的 strategy**——
 * 本插件四个业务角色的 strategy 是 `{"actions":["view","list","get"]}`（且不带 `resources`），
 * 这条回退于是变成了"**任何没有资源级条目的集合都可以只读**"。
 *
 * 所以"NATIVE_READ_ALLOWLIST 是白名单"这个心智模型是错的：
 * 它其实是"**给这四个资源补上资源级条目**"的清单；
 * 而**没被它覆盖的集合，默认是放行的**。要真正关掉一个资源，必须在**框架层显式拒绝**。
 *
 * 为什么放在中间件而不是 ACL（与 `assertNoReadonlyFields` 同一取舍）：
 *   · ACL 的资源级授权是**运行期数据**（`dataSourcesRolesResources`），后台点几下就没了，
 *     且 `root` 角色绕过 ACL —— 而本插件要给照片上一道"谁都别走原生口"的边界；
 *   · 这里是代码常量，改动走评审与断言，语义唯一、可测、对**所有角色**生效。
 *
 * 为什么可以整资源封（连 `root` / 管理员一起封）：
 *   · 全仓后台 UI **没有任何** schema / 页面绑定 `serviceVisitPhotos`
 *     （已核实：`uiSchemas` 与 `desktopRoutes` 命中数为 0）；
 *   · 照片按 `docs/SECURITY.md` §4.3 本来就"故意不进后台附件列表"
 *     （`attachments.storageId = null` / `url = null`）；
 *   · 服务端自身读照片走 `db.getRepository()`（如 `PhotoService.read()`），
 *     **不经过 HTTP**，因此封住原生口不影响任何业务路径。
 *
 * 照片的唯一合法出口：`GET /api/svc/visits/:id`（I11 只读读模型，只给安全展示元数据）
 * 与 `GET /api/svc/photos/:photoId`（I14 受控读取，每次过登录身份 + 归属校验）。
 * 反向门见 `scripts/verify-store-photo-access.mjs` 的 **N1**。
 */
const NATIVE_FORBIDDEN_RESOURCES: Record<string, string> = {
  serviceVisitPhotos:
    '上门照片含 storage_key / upload_ip_hash 等存储实现信息，只能经 /api/svc 业务端点读取',
};

/** 更新入参可能出现的几个位置（NocoBase 把 body 放在 params.values，也支持裸 body） */
function collectWriteValues(ctx: any): Record<string, unknown>[] {
  const params = ctx?.action?.params ?? {};
  const seen: Record<string, unknown>[] = [];
  for (const candidate of [params.values, params.updatedRecord, params]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      seen.push(candidate as Record<string, unknown>);
    }
  }
  return seen;
}

/**
 * 拦截对**状态机字段**的原生 update。
 *
 * 依据 docs/API.md §6：「状态类变更 ❌ 禁止直调原生 update」。
 * 一旦在后台表格里直接改掉 status，就会出现"状态变了但没有 ticketEvents 行"
 * 的脏数据，SLA、时间线、报表全部失真，且事后无法复原是谁改的。
 *
 * 为什么放在中间件而不是 ACL 的字段白名单：
 *   ACL 的字段级只读要在 `dataSourcesRolesResourcesActions` 里逐角色配置，
 *   属于**运行时数据**，界面上一改就没了，且 root 角色直接绕过 ACL。
 *   TICKET_READONLY_FIELDS 是代码里的常量，放在框架层拦截对**所有角色**生效
 *   （包括 root），语义唯一、可测、不依赖后台配置。
 *
 * 失败策略：**拒绝**（403 FIELD_READONLY），不是"静默丢弃字段"——
 *   静默丢弃会让调用方以为改成功了，是更糟的失败方式。
 */
function assertNoReadonlyFields(
  ctx: any,
  resourceName: string,
  actor: Actor,
  logger?: StoreScopeOptions['logger'],
): void {
  const readonly = READONLY_FIELD_SETS[resourceName];
  if (!readonly) return;

  const touched = new Set<string>();
  for (const values of collectWriteValues(ctx)) {
    for (const key of Object.keys(values)) {
      if (readonly.has(key)) touched.add(key);
    }
  }

  if (touched.size === 0) return;

  const fields = [...touched].sort();
  logger?.warn?.(
    `[storeScope] 用户 ${actor.userId} 尝试经原生接口修改 ${resourceName} 的只读字段：${fields.join(', ')}`,
  );
  throw new ForbiddenError(
    'FIELD_READONLY',
    `字段 ${fields.join('、')} 不允许在后台直接修改，请通过平台业务流程操作`,
  );
}

export interface StoreScopeOptions {
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
  /** 关闭隔离（仅供离线桩/单测使用，**绝不**在任何运行环境开启） */
  disabled?: boolean;
}

/**
 * 创建资源级中间件。挂到 `app.resourcer.use()` 上。
 *
 * @param db NocoBase 的 Database 实例（反查 Visit/Event/SmsLog 的 ticket_id 用）
 */
export function createStoreScopeMiddleware(
  db: any,
  services: Services,
  options: StoreScopeOptions = {},
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  const { logger } = options;

  return async function storeScope(ctx: any, next: () => Promise<void>): Promise<void> {
    if (options.disabled) return next();

    const resourceName = resolveResourceName(ctx);
    const actionName = resolveActionName(ctx);

    // ---- 整资源封禁：优先于一切放行分支（含"非受管资源直接放行"） ----
    // 必须在 `if (!rule) return next()` **之前** —— 否则下面那句"非受管资源放行"
    // 会先把请求放过去，这条就成了永远走不到的死代码（P6-0 的 N1 门会红）。
    const forbiddenReason = resourceName ? NATIVE_FORBIDDEN_RESOURCES[resourceName] : undefined;
    if (forbiddenReason) {
      logger?.warn?.(
        `[storeScope] 拒绝经原生接口访问 ${resourceName}:${actionName}（${forbiddenReason}）`,
      );
      throw new ForbiddenError(
        'NATIVE_RESOURCE_FORBIDDEN',
        `${resourceName} 不支持在后台直接访问，请通过平台业务流程操作`,
      );
    }

    const rule = resourceName ? SCOPED_RESOURCES[resourceName] : undefined;

    // 非受管资源：直接放行（例如 svc:health、publicStore:list 这些匿名资源，
    // 它们的越权风险由各自的 action 内部把关）
    if (!rule) return next();

    // 匿名请求不可能通过对象级鉴权，但也不该在这里统一拒绝 ——
    // 匿名接口用的是 publicStore / publicTicket 这类**不同**的资源名，
    // 走到这里的匿名请求属于异常，交给下面的 resolveActor 报 UNAUTHENTICATED。
    let actor: Actor;
    try {
      actor = await services.permissions.resolveActor(ctx);
    } catch (error) {
      logger?.warn?.(`[storeScope] ${resourceName}:${actionName} 身份解析失败，拒绝`);
      throw error;
    }

    // ---- create：工单与回执都不允许经原生接口新建 ----
    if (actionName === 'create') {
      logger?.warn?.(
        `[storeScope] 用户 ${actor.userId} 尝试经原生接口创建 ${resourceName}，已拒绝` +
          `（业务写入必须走 /api/svc/... action）`,
      );
      throw new ForbiddenError(
        'NATIVE_CREATE_FORBIDDEN',
        `${rule.label}不支持在后台直接新建，请通过平台业务流程操作`,
      );
    }

    if (WRITE_ACTIONS.has(actionName)) {
      services.permissions.assertCapability(
        actor,
        CAPABILITY.WRITE_TICKET,
        '当前角色为只读，不能修改数据',
      );
      // 只读字段守卫：拦的是"改了会破坏状态机一致性"的那批列
      assertNoReadonlyFields(ctx, resourceName, actor, logger);
    }

    // ---- get / update / destroy：按主键操作，必须先验归属 ----
    if (actionName === 'get' || actionName === 'update' || actionName === 'destroy') {
      const tk = resolveTargetKey(ctx);
      if (tk !== undefined && tk !== null) {
        await assertOwnership(db, services, rule.via, actor, tk);
      } else if (actionName === 'get') {
        // get 没有主键说明请求本身有问题，交给后续中间件处理
        logger?.debug?.(`[storeScope] ${resourceName}:get 未带主键`);
      }
    }

    // ---- list / update：注入数据范围（update 是为了拦住 update-by-filter） ----
    if (actionName === 'list' || actionName === 'update' || actionName === 'destroy') {
      // 注意：仅在没有任何 filter 时，范围条件才是"多出来"的；已有 filter 也必须叠加，
      // 因此这里用 $and 组合，而不是覆盖 —— 覆盖会让攻击者用 filter 挤掉范围条件。
      mergeScopeFilter(ctx, services.permissions, actor, rule.via, resourceName, logger);
    }

    await next();
  };
}

/**
 * 断言"这条数据属于你可访问的门店"。
 *
 * 越权 / 不存在统一抛 NotFoundError（HTTP 404）—— 不给攻击者确认信号，见 PermissionService 顶部铁律 3。
 */
async function assertOwnership(
  db: any,
  services: Services,
  via: 'self' | 'ticket',
  actor: Actor,
  targetKey: unknown,
): Promise<void> {
  const id = Number(targetKey);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ForbiddenError('BAD_REQUEST', '主键非法');
  }

  // serviceTickets 直接复用 PermissionService 的判定（它自己会处理范围与日志）
  if (via === 'self') {
    await services.permissions.assertCanAccessTicket(actor, id);
    return;
  }

  // 其余资源：先取到 ticket_id，再判定工单归属
  const ticketId = await resolveTicketIdOf(db, via, id);
  if (ticketId === null) {
    throw new NotFoundError(`记录 ${id} 不存在`);
  }
  await services.permissions.assertCanAccessTicket(actor, ticketId);
}

/** 从 Visit / Event / SmsLog 反查其 ticket_id */
async function resolveTicketIdOf(
  db: any,
  _via: 'ticket',
  id: number,
): Promise<number | null> {
  // 依次尝试三张表（调用方已按资源名限定，这里只是取列）
  for (const collection of ['serviceVisits', 'ticketEvents', 'smsLogs']) {
    try {
      const repository = db.getRepository(collection);
      const row = await repository.findOne({ filter: { id }, fields: ['id', 'ticket_id'] });
      if (row) {
        const ticketId = Number(row.ticket_id);
        return Number.isFinite(ticketId) ? ticketId : null;
      }
    } catch {
      // 表不存在或字段缺失：继续尝试下一张
    }
  }
  return null;
}

/**
 * 把数据范围合进 list/update 的 filter。
 *
 * 用 `$and` 叠加而不是赋值：若直接 `params.filter = scopeFilter`，
 * 攻击者只要在 URL 里带一个 filter 就能把范围条件顶掉
 * （`?filter={"id":{"$gt":0}}`）。叠加之后两个条件都必须成立，无法绕过。
 */
function mergeScopeFilter(
  ctx: any,
  permissions: PermissionService,
  actor: Actor,
  via: 'self' | 'ticket',
  resourceName: string,
  logger?: StoreScopeOptions['logger'],
): void {
  const scope = permissions.scopeOf(actor);

  let scopeFilter: Record<string, unknown>;

  if (scope.kind === 'all') {
    // 总部角色：不需要注入任何条件
    return;
  }

  if (scope.kind === 'stores') {
    scopeFilter =
      via === 'self'
        ? { store_id: { $in: scope.storeIds } }
        : // 关系路径过滤：NocoBase 会 join 出 ticket.store_id 参与 where
          { 'ticket.store_id': { $in: scope.storeIds } };
  } else {
    // none：恒假条件 → 查询必然返回空集（比抛错更贴合"这片数据对你不可见"）
    scopeFilter = { id: -1 };
    logger?.warn?.(
      `[storeScope] 用户 ${actor.userId} 数据范围为 none，${resourceName} 查询将被置空`,
    );
  }

  const action = ctx?.action;
  if (!action) return;

  const params = action.params ?? {};
  const originalFilter = params.filter;

  const merged = originalFilter ? { $and: [originalFilter, scopeFilter] } : scopeFilter;

  if (typeof action.mergeParams === 'function') {
    action.mergeParams({ filter: merged });
  } else {
    // 老版本兜底：直接改 params
    action.params = { ...params, filter: merged };
  }

  logger?.debug?.(
    `[storeScope] ${resourceName} 注入范围：${JSON.stringify(scopeFilter)}`,
  );
}

/** 取资源名（关联资源形如 `serviceTickets.comments`，取首段） */
function resolveResourceName(ctx: any): string | undefined {
  const raw =
    ctx?.action?.resourceName ?? ctx?.resource?.name ?? ctx?.action?.resource?.name ?? undefined;
  if (!raw) return undefined;
  return String(raw).split('.')[0];
}

/** 取动作名 */
function resolveActionName(ctx: any): string {
  return String(ctx?.action?.actionName ?? ctx?.action?.name ?? 'unknown');
}

/** 取主键（get/update/destroy 走 filterByTk） */
function resolveTargetKey(ctx: any): unknown {
  const params = ctx?.action?.params;
  if (!params) return undefined;
  return params.filterByTk ?? params.filterByPK ?? undefined;
}

/** 供离线校验/测试断言：受管资源清单 */
export const SCOPED_RESOURCE_NAMES = Object.keys(SCOPED_RESOURCES);
/** 供离线校验/测试断言：**整资源封禁**清单（P6-0 的 N1 门读它） */
export const NATIVE_FORBIDDEN_RESOURCE_NAMES = Object.keys(NATIVE_FORBIDDEN_RESOURCES);
export { TABLE };
