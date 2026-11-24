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
export const SCOPED_RESOURCES: Record<string, { via: 'self' | 'ticket' | 'archive'; label: string }> = {
  serviceTickets: { via: 'self', label: '工单' },
  serviceVisits: { via: 'ticket', label: '服务回执' },
  ticketEvents: { via: 'ticket', label: '工单事件' },
  smsLogs: { via: 'ticket', label: '短信日志' },
  // ARC-V1：档案主表自身带 store_id ⇒ via 'self'，与工单同构。
  serviceArchives: { via: 'self', label: '服务档案' },
  // ARC-V1 子表：没有 store_id，隔离靠 "archive_id → archive.store_id" 两跳 ⇒ via 'archive'。
  //
  // ───────────────────────────────────────────────────────────────────────────
  // 2026-11-10（A5-D）补入：`serviceArchiveEvents` 曾**完全不受门店隔离**
  // ───────────────────────────────────────────────────────────────────────────
  // 原注释写的是"这三张表的范围校验在业务层 assertArchiveAccess 完成" ——
  // **但那个函数在全仓并不存在**。于是实际状态是：
  //   · 它在 `ARCHIVE_NATIVE_READ_RESOURCES` 里 ⇒ 门店角色**有**原生读权限；
  //   · 它又不在本表里 ⇒ 中间件不为它注入任何范围 ⇒ **读得到全部门店的事件**。
  // 实测：B 店销售 `list?filter[archive_id]=130`（A 店档案）→ **200 + 完整事件行**
  // （含 actor_user_id / 操作时间线）。
  //
  // ⚠️ 阶段表 (`serviceArchiveStages`) 与照片表 (`serviceArchivePhotos`) 当前**没有**这个问题：
  //   · 照片表不在 `ARCHIVE_NATIVE_READ_RESOURCES` 里，ACL 直接 403（实测）；
  //   · 阶段表虽在名单里，但实测 B 店读 A 店阶段返回 `[]`（库里没有 A 店阶段数据，
  //     属"恰好为空"而非"被拦住"）⇒ **未验证，不能算安全**。
  //     两者都一并纳入本表：范围由服务端强制附加，不依赖"恰好没数据"。
  serviceArchiveEvents: { via: 'archive', label: '档案事件' },
  serviceArchiveStages: { via: 'archive', label: '档案阶段' },
};

/**
 * 受管资源 → 真实 collection 名。
 *
 * 目前两者一一相同（`serviceTickets` / `serviceArchives` …），保留这张表是为了：
 *   · 让"资源名 ≠ collection 名"的情况**只在这里改一处**；
 *   · 显式表达"self 型资源要按自己的表读那一行"，而不是默认去查工单表
 *     —— 后者正是 `serviceArchives` 读不到（全 404）的成因。
 */
const RESOURCE_TABLE: Record<string, string> = {
  serviceTickets: 'serviceTickets',
  serviceArchives: 'serviceArchives',
  serviceArchiveEvents: 'serviceArchiveEvents',
  serviceArchiveStages: 'serviceArchiveStages',
};

/** 只读角色也允许的动作 */
const READ_ACTIONS = new Set(['list', 'get', 'export']);/** 需要写权限的动作 */
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
        await assertOwnership(db, services, rule.via, actor, tk, resourceName, logger);
      } else if (actionName === 'get') {
        // ⚠️ **绝不能放行**。对 `get` 来说"解析不出主键"意味着请求用了我们没识别的
        //    定位写法（`filter[id]=` 曾正是这样绕过归属校验的，2026-11-10 实测越权）。
        //
        //    为什么不直接 403：`get` 不解析主键时可能被框架其它逻辑使用，
        //    一律拒绝有误伤风险。这里选择**把范围条件注入成恒假**——
        //    效果是"查询必然返回 null/空"，越权者拿不到任何数据，也拿不到
        //    "这条数据存在但你没权限"的信号（与 PermissionService 的反枚举口径一致）。
        logger?.warn?.(
          `[storeScope] ${resourceName}:get 未能解析主键，注入恒假范围（fail-closed）`,
        );
        const action = ctx?.action;
        if (action && typeof action.mergeParams === 'function') {
          // 用 `$and` 而不是直接覆盖：原 filter 里可能带 `{id: 170}`，
          // 直接写 `{id: -1}` 只会**改写**它（结果反而取决于合并顺序）。
          // 把原 filter 一起放进 `$and`，保证与原条件求交集 ⇒ 必然为空。
          const orig = (ctx?.action?.params as any)?.filter;
          action.mergeParams({
            filter: orig ? { $and: [orig, { id: -1 }] } : { id: -1 },
          });
        }
      }
    }

    // ---- list / get / update / destroy：注入数据范围 ----
    //
    // `get` 也在这里，是**第二道防线**（2026-11-10 A5-D 补）。
    // 理由：上面的 `assertOwnership` 是"查到这一行再判断归属"，属于**对象级**校验；
    //   而 `get` 的 `proxyToRepository` 把 `filterByTk` 与 `filter` **一起**交给 `findOne`
    //   （`lodash.pick(['filterByTk','fields','appends','except','filter'])`）。
    //   也就是说"最终查到哪一行"由这两个参数的合并结果决定 ——
    //   若哪天 `filter` 的优先级压过 `filterByTk`，`assertOwnership` 验的是 A 行、
    //   实际返回的却可以是 B 行。加一道范围查询条件，让 SQL 本身不可能命中别家门店。
    // 双保险的成本是一次 `$and` 拼接；漏掉的成本是"校验通过但返回别人的数据"。
    if (
      actionName === 'list' ||
      actionName === 'get' ||
      actionName === 'update' ||
      actionName === 'destroy'
    ) {
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
  via: 'self' | 'ticket' | 'archive',
  actor: Actor,
  targetKey: unknown,
  resourceName: string,
  logger?: StoreScopeOptions['logger'],
): Promise<void> {
  const id = Number(targetKey);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ForbiddenError('BAD_REQUEST', '主键非法');
  }

  // ⚠️ `via: 'self'` 不等于"都是工单"。
  //    2026-11-10 修复：旧实现把 self 一律交给 `assertCanAccessTicket()`，
  //    而它查的是 **serviceTickets** 表。`serviceArchives` 也是 `via: 'self'`，
  //    于是"用档案 id 去工单表找"⇒ 任何人（含 admin）读档案都 404。
  //    正确口径：self 表示"本表自带 store_id"，所以按**资源对应的表**读那一行。
  if (via === 'self' || via === 'archive') {
    // `SCOPED_RESOURCES` 的 key 就是 collection 名，`db.getRepository()` 直接吃它。
    // 保留映射表只是为了让"资源名 ≠ collection 名"这种情况以后能一处改完。
    const tableName = RESOURCE_TABLE[resourceName] ?? resourceName;
    const repository = db.getRepository(tableName);

    // ---- archive 型：本行没有 store_id，要再跳一次到所属档案 ----
    // 必须显式取 archive_id，并把它解析成档案的 store_id；解析不出就 404（fail closed）。
    if (via === 'archive') {
      const row = await repository.findOne({ filter: { id }, fields: ['id', 'archive_id'] });
      if (!row) throw new NotFoundError(`记录 ${id} 不存在`);

      const archiveId = Number((row as any).archive_id);
      if (!Number.isFinite(archiveId) || archiveId <= 0) {
        // 子行没有归属档案 ⇒ 无法判定，一律拒绝（不能因为"不知道属于谁"就放行）
        logger?.warn?.(`[storeScope] ${resourceName} ${id} 的 archive_id 非法，拒绝访问`);
        throw new NotFoundError(`记录 ${id} 不存在`);
      }
      await assertOwnership(db, services, 'self', actor, archiveId, 'serviceArchives', logger);
      return;
    }

    const row = await repository.findOne({ filter: { id } });

    // 不存在 / 越权统一 404（不给攻击者确认信号，与 PermissionService 铁律 3 一致）
    if (!row) {
      throw new NotFoundError(`记录 ${id} 不存在`);
    }

    const scope = services.permissions.scopeOf(actor);
    if (scope.kind === 'all') return;

    if (scope.kind === 'stores') {
      const storeId = Number(row.store_id);
      if (!scope.storeIds.includes(storeId)) {
        // 越权尝试是安全事件，留痕；对外仍只说"不存在"
        logger?.warn?.(
          `[storeScope] 越权访问被拒：用户 ${actor.userId}（授权门店 [${scope.storeIds.join(',')}]）` +
            `尝试访问门店 ${storeId} 的 ${resourceName} ${id}`,
        );
        throw new NotFoundError(`记录 ${id} 不存在`);
      }
      return;
    }

    logger?.warn?.(
      `[storeScope] 用户 ${actor.userId} 数据范围为 none，拒绝访问 ${resourceName} ${id}`,
    );
    throw new NotFoundError(`记录 ${id} 不存在`);
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
  via: 'self' | 'ticket' | 'archive',
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
    if (via === 'self') {
      scopeFilter = { store_id: { $in: scope.storeIds } };
    } else if (via === 'archive') {
      // 两跳：子表 → archive.store_id。
      //
      // 用**关系路径**过滤（NocoBase 会 join 出 archive.store_id 参与 where），
      // 而不是先把门店的档案 id 全查出来再 `archive_id IN (...)`：
      //   · 后者在"某店上千条档案"时会把一个巨大的 IN 列表塞进每条 SQL；
      //   · 且它是**两次查询**，两次之间新产生的档案不在集合里（新数据被误挡）。
      // 关系路径的好处是一次 SQL 完成，语义为"这行挂在哪个档案上"。
      // ⚠️ 关系路径能否生效取决于 NocoBase 的查询构造器，**必须实测**
      //    （`.tmp-verify/a5d/verify-read-entry.mjs` 的 §1.6 会双向验证）。
      scopeFilter = { 'archive.store_id': { $in: scope.storeIds } };
    } else {
      // 关系路径过滤：NocoBase 会 join 出 ticket.store_id 参与 where
      scopeFilter = { 'ticket.store_id': { $in: scope.storeIds } };
    }
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
/**
 * 从请求里解析"这条请求针对哪一条记录"。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-11-10 修复：`filter[id]=` 曾经是**越权读取的缺口**
 * ─────────────────────────────────────────────────────────────────────────────
 * 旧实现只读 `filterByTk` / `filterByPK`。而 NocoBase 的 `get` 还有一条等价写法
 * —— `?filter[id]=170`（`get` 上 filter 命中唯一一行时直接返回该对象，不返回数组）。
 * 这种请求里 `filterByTk` 是 **undefined**，于是：
 *   · `assertOwnership()` 被整个跳过；
 *   · 原代码只打一条 `debug` 日志就 **继续 next()** —— 等于 fail-open。
 * 实测后果（B 店销售、档案 170 属 A 店）：`list?filter[id]=170` 正确返回 `[]`，
 * 但 `get?filter[id]=170` 返回 **200 + 完整档案内容**（含客户姓名/手机号/地址）。
 *
 * 修法两条，缺一不可：
 *   ① 从 `filter` 里识别**唯一主键形态**（`{id: x}` 或 `{id: {$eq: x}}`）；
 *   ② `get` 解析不出主键时**不再放行**，直接 400（见下方调用处）。
 *      因为对 `get` 来说"没主键"本身就是非法请求，放行只会变成默认可达。
 */
function resolveTargetKey(ctx: any): unknown {
  const params = ctx?.action?.params;
  if (!params) return undefined;

  const direct = params.filterByTk ?? params.filterByPK;
  if (direct !== undefined && direct !== null) return direct;

  // ---- filter 形态：只在能**唯一确定一行**时才算主键 ----
  const filter = params.filter;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return undefined;

  const idCond = (filter as Record<string, unknown>).id;
  if (idCond === undefined || idCond === null) return undefined;

  // 允许 `{id: 170}` 与 `{id: {$eq: 170}}` 两种写法；其余（$in / $gt / 数组）一律不算
  if (typeof idCond === 'number' || typeof idCond === 'string') return idCond;
  if (typeof idCond === 'object' && !Array.isArray(idCond)) {
    const eq = (idCond as Record<string, unknown>).$eq;
    if (typeof eq === 'number' || typeof eq === 'string') return eq;
  }
  return undefined;
}

/** 供离线校验/测试断言：受管资源清单 */
export const SCOPED_RESOURCE_NAMES = Object.keys(SCOPED_RESOURCES);
/** 供离线校验/测试断言：**整资源封禁**清单（P6-0 的 N1 门读它） */
export const NATIVE_FORBIDDEN_RESOURCE_NAMES = Object.keys(NATIVE_FORBIDDEN_RESOURCES);
export { TABLE };
