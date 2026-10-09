/**
 * collection-metadata-scope.ts —— `collections:listMeta` 的**结构化正向投影**（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 它解决什么问题
 * ===========================================================================
 * B-8：业务角色能原生读取核心平台元数据。实测 `collections:listMeta` 返回
 * **74314 字节 / 14 个集合的完整字段结构，含 `users` 与 `roles` 的 schema**
 * —— 而 SPA 渲染业务表格只需要它那几张表的元数据。
 *
 * 但它又被 SPA **直接调用**（`dataSourceManager`），deny 会让表格渲染不出来。
 * ⇒ 正解不是"整体放行/整体拒绝"，而是**对响应做结构化收窄**。
 *
 * ===========================================================================
 * 🔴 用户 2026-10-09 锁死的实现规则（逐条对应到代码）
 * ===========================================================================
 *  ① **正向允许 / fail-closed** —— 不是"返回全部再删掉 users/roles"的黑名单。
 *     理由：NocoBase 以后新增 `authenticators` / `apiKeys` 之类平台集合，
 *     黑名单**不会**自动覆盖它们 ⇒ 再次泄漏。这里 `COLLECTION_METADATA_ALLOWLIST`
 *     是白名单，**未知集合默认丢弃**。
 *  ② **必须处理嵌套 association metadata** —— 不能顶层 `users` 没了，
 *     却在 `serviceTickets.handler.options.target` / `targetFields` 里又把 users 结构带回来。
 *     ⇒ 对**每个保留的字段**做**递归**扫描：只要它的 `options` 任意深度出现
 *       非白名单集合引用，**整条字段丢弃**。
 *  ③ **基于解析后的 JSON 结构**，**禁止 regex / string replace** —— 后者会被
 *     缩进、转义、字段顺序、以及"长得像但不是"的值骗过去。
 *  ④ `root` / 平台 `admin` **不经过**本层（返回原始完整 metadata）。
 *     ⚠️ **业务 HQ_ADMIN ≠ NocoBase root/admin**：业务角色一律走投影。
 *
 * ===========================================================================
 * 与 `users` 的关系（用户 2026-10-09 补充锁死，很关键）
 * ===========================================================================
 * 实测页面模型引用 `users ×79`，且有 `serviceTickets.handler → users` 等三条业务关联。
 * ⇒ 存在**元数据依赖**，但这**不等于**必须开放 `users`：
 *    · **数据**（`users:list`）绝不放开 —— 那才是 B-8 的暴露面；
 *    · **元数据**按用户批准的优先级执行：
 *        ① 先**完全不返回** `users` metadata，跑最终 P11 页面；
 *        ② 若只是**即将被 P11-0 删除的旧页面**（处理人/事件表列）坏了，**不**为旧 UI 加回来；
 *        ③ 只有 **Phase 11 最终仍保留的业务界面**确实要展示"处理人/确认人/操作人"时，
 *           才补**为关联渲染专门构造的最小 projection**（id + 显示字段 + 框架必需的最少结构）,
 *           而**不是**"users 原 schema 删掉几个敏感字段"。
 *    ⇒ 本文件当前处于**第 ① 步**：`COLLECTION_METADATA_ALLOWLIST` **不含 users**。
 *      后续是否补、补什么，由真浏览器结果决定（且有门禁盯着"新增依赖待审"）。
 *
 * ⚠️ `roles` / `aiEmployees` / 认证字段 / email / phone / password·token 类字段
 *    及其 association **都不得**因为 users metadata 而重新进入响应。
 *    注意：`users.roles → roles`、`users.aiEmployees → aiEmployees` 这两条依赖
 *    **只挂在 `users` 集合上** ⇒ 不返回 users，就**连带不需要** roles / aiEmployees 的元数据。
 */
import type { Context, Next } from 'koa';

/**
 * 业务角色可见的 collection 元数据白名单（**正向**）。
 *
 * 依据：`scripts/probe-page-collections.mjs` 实测「页面模型真正引用到的集合」。
 * ⚠️ **刻意不把实测次数写成常量**（611/409/87/79/43 会随页面演进失真）；
 *    这里只固定"**集合名**"这一层语义，而"页面是否又引用了新集合"由门禁
 *    `scripts/verify-page-collection-deps.mjs` 提示"新增依赖待审"。
 */
export const COLLECTION_METADATA_ALLOWLIST: readonly string[] = [
  'serviceTickets',
  'serviceVisits',
  'ticketEvents',
  'stores',
];

/** 平台级角色：它们不经过本层收窄（平台维护能力保持完整）。 */
export const PLATFORM_ROLE_NAMES: readonly string[] = ['root', 'admin'];

/** 需要做投影的 action（只处理 listMeta；`list`/`get` 由 ACL 直接拒绝，不在本层）。 */
const SCOPED_RESOURCE = 'collections';
const SCOPED_ACTION = 'listMeta';

/** 在任意深度的对象里，这些键的值若为字符串，就表示"引用了一个集合"。 */
const COLLECTION_REF_KEYS = new Set(['target', 'targetCollection', 'collectionName', 'sourceCollection']);

type Json = unknown;

/** 判断当前请求是否属于平台角色（root / admin）。 */
export function hasPlatformRole(ctx: Context): boolean {
  const roles: string[] = (ctx as any)?.state?.currentRole
    ? [String((ctx as any).state.currentRole)]
    : [];
  const fromState: string[] = Array.isArray((ctx as any)?.state?.currentRoles)
    ? (ctx as any).state.currentRoles.map(String)
    : [];
  const all = new Set([...roles, ...fromState]);
  for (const r of PLATFORM_ROLE_NAMES) if (all.has(r)) return true;
  return false;
}

/**
 * 递归扫描：这个片段里是否**引用了白名单之外**的集合。
 *
 * ⚠️ 为什么是"递归找引用"而不是"看一眼 options.target"：
 *    NocoBase 的字段 options 里可能出现多种引用形态（`target`、`targetFields`、
 *    `targetKey` 指向的集合、嵌套的 `uiSchema`…）。只看一层会漏，
 *    而漏的表现正是用户点名的那一种：**顶层没了、字段里又带回来**。
 */
export function referencesOutsideAllowlist(node: Json, allow: ReadonlySet<string>): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    for (const v of node) if (referencesOutsideAllowlist(v, allow)) return true;
    return false;
  }
  for (const [k, v] of Object.entries(node as Record<string, Json>)) {
    if (typeof v === 'string' && COLLECTION_REF_KEYS.has(k) && !allow.has(v)) {
      return true;
    }
    if (v && typeof v === 'object' && referencesOutsideAllowlist(v, allow)) return true;
  }
  return false;
}

/**
 * 对单个集合的 metadata 做投影。
 *
 * 规则（fail-closed）：
 *   1. 集合名不在白名单 ⇒ 整条丢弃（由调用方过滤）；
 *   2. `fields` 数组里，任何一条字段若**递归**引用了白名单外集合 ⇒ **整条字段丢弃**
 *      （这样 `serviceTickets.handler` → users 的字段会被丢掉，
 *        而不是留在响应里把 users 的结构带出去）；
 *   3. 其余结构原样保留（字段级白名单由既有的后台列白名单机制负责，
 *      本层只负责"元数据边界"）。
 */
export function projectCollection(collection: any, allow: ReadonlySet<string>): any | null {
  if (!collection || typeof collection !== 'object') return null;
  const name = String(collection.name ?? '');
  if (!allow.has(name)) return null;

  const out: any = { ...collection };
  if (Array.isArray(collection.fields)) {
    out.fields = collection.fields.filter((f: any) => !referencesOutsideAllowlist(f?.options ?? f, allow));
  }
  return out;
}

/**
 * 对 listMeta 的响应做整体投影。**保持入参的形状**（数组进、数组出）。
 *
 * 🔴 形状的真相（实测踩到，2026-10-09）：在 resourcer 中间件这一层，
 *    `ctx.body` 拿到的是**数组本身**，不是 `{data: [...]}` ——
 *    NocoBase 的响应包装（`{data: ...}`）发生在**本中间件之后**。
 *
 *    第一版按 `{data: [...]}` 写 ⇒ `Array.isArray(body.data)` 恒为 false
 *    ⇒ 走 fail-closed 分支 `{...数组, data: []}` ⇒ 把数组摊成
 *    `{"0":…,"1":…,"data":[]}` ⇒ 前端拿到形状全错的响应
 *    （页面上报"字段 ticket_no 可能已被删除""数据表 serviceTickets 可能已被删除"）。
 *    诊断日志证据：`before: isArray=true dataType=undefined | after: isArray=false`。
 *
 * ⇒ 这里**两种形态都认**（数组 / `{data: 数组}`），并按**入参的形状**返回；
 *   两种都不认时，按"最保守的同形空值"返回（数组 → `[]`；对象 → `{...body, data: []}`），
 *   绝不放行原样。
 */
export function projectListMetaBody(body: any, allowList: readonly string[]): any {
  const allow = new Set(allowList);
  const project = (list: any[]): any[] =>
    list.map((c: any) => projectCollection(c, allow)).filter((c: any) => c !== null);

  // 形态 A：数组本身（本版本实测就是这个）
  if (Array.isArray(body)) return project(body);

  // 形态 B：`{data: [...]}`（防御性支持：上游若把包装提前，这里仍然正确）
  if (body && typeof body === 'object' && Array.isArray(body.data)) {
    return { ...body, data: project(body.data) };
  }

  // 形态 C：不认识 ⇒ fail-closed。返回**与入参同形**的空值，而不是原样放行，
  //   也不是把一个形状硬塞给另一个形状（那正是上面那次事故）。
  if (body && typeof body === 'object') return { ...body, data: [] };
  return [];
}

/**
 * 创建中间件。
 *
 * ⚠️ 挂载位置：resourcer 中间件链是
 *    `[...resourcer.getMiddlewares(), ...action.middlewares, ...preActionHandlers, handler]`，
 *    所以 `await next()` 之后 `ctx.body` 已经是 handler 产出的结果 —— 在这里改它，
 *    是"改最终响应"，而不是"提前拦截"。这与 `native-export-guard` 的取向相反
 *    （那个是 throw 在 handler 之前），因为二者的目标不同：
 *    一个是"不让它发生"，一个是"让它发生但只给最小结果"。
 */
export function createCollectionMetadataScopeMiddleware(options: {
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  allowList?: readonly string[];
} = {}) {
  const allowList = options.allowList ?? COLLECTION_METADATA_ALLOWLIST;
  const log = options.logger;

  return async function collectionMetadataScope(ctx: Context, next: Next): Promise<void> {
    await next();

    const resourceName = (ctx as any)?.action?.resourceName;
    const actionName = (ctx as any)?.action?.actionName;
    if (resourceName !== SCOPED_RESOURCE || actionName !== SCOPED_ACTION) return;

    // 平台角色：原始完整 metadata（平台维护能力不受影响）
    if (hasPlatformRole(ctx)) return;

    const before = ctx.body;
    const after = projectListMetaBody(before, allowList);
    ctx.body = after;

    // 只记"收窄了什么规模"，不记内容（元数据本身不必进日志）。
    // ⚠️ 形状断言留在日志里：形状被改坏过一次（数组被摊成对象），
    //    如果不打印 `isArray`，下次再坏也只能靠前端报错才发现。
    try {
      const countOf = (v: any): number =>
        Array.isArray(v) ? v.length : Array.isArray(v?.data) ? v.data.length : -1;
      log?.info?.(
        `[svc:${SCOPED_RESOURCE}:${SCOPED_ACTION}] 业务角色元数据投影：` +
          `集合 ${countOf(before)} → ${countOf(after)}（白名单 ${allowList.length} 项；` +
          `形状 ${Array.isArray(before) ? '数组' : '对象'} → ${Array.isArray(after) ? '数组' : '对象'}）`,
      );
    } catch {
      /* 日志失败不影响响应 */
    }
  };
}
