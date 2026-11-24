/**
 * listCountScopeGuard —— 列表总数（`meta.count`）与列表行**同源同范围**的守卫（R2.2.3）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这一层（P6-API-DTO-SENSITIVE-01 的另一半，2026-11-24 核实后落地）
 * ---------------------------------------------------------------------------
 * 核实结论先说清楚，否则这层的存在理由会被误读成"修一个已经坏了的东西"：
 *
 *   · **在 NocoBase 2.2.15 + 本项目中间件顺序下，`meta.count` 目前是正确的**。
 *     实证（本地隔离环境，工单 store1=519 / store2=28 / store4=5）：
 *       store_sales@store1  无 filter            → count=519  rows 全为 store1
 *       store_sales@store1  filter $or[1,4]      → count=519  （他店部分被范围裁掉）
 *       store_sales@store1  filter $or[2,4]      → count=0
 *       门店账号           serviceVisits   → count=309  = SQL 309
 *       门店账号           ticketEvents    → count=2042 = SQL 2042
 *       门店账号           smsLogs         → count=877  = SQL 877
 *     生产复验同结论：门店账号 `$or[1,2]` → 457（= store1 全量），`$or[2,3]` → 0。
 *
 *   · 但"现在正确"依赖三条**都不在我们手里**的假设：
 *       ① `listWithPagination` 用 `findArgs(ctx)` 取 `ctx.action.params.filter`；
 *       ② `findAndCount` 的 `count()` 与 `find()` 吃**同一份** options；
 *       ③ storeScope 的 `mergeParams({filter})` 在 ACL 之后、handler 之前落进 params。
 *     ② 是框架实现细节（`repository.findAndCount`），①③ 是"改写的人得记得"。
 *     任何一条被上游改动，症状都是**静默**的：行被裁了、总数没被裁 ——
 *     界面上表现为"共 529 条，只有 1 页能翻"，而**没有任何报错**。
 *
 *   · 真正**丢总数**的形态确实存在，且正是用户点名的那条（**已 A/B 实测确认**）：
 *     `paginate=false` 走 `listWithNonPaged`，`ctx.body = rows`（裸数组），
 *     dataWrapping 只把数组包成 `{data}`，**meta 根本没有**。
 *     实测（本地隔离环境，R2.2.2 基线产物、守卫未注册）：
 *       serviceTickets?paginate=false → data=list 519 条  meta.count=None
 *       smsLogs       ?paginate=false → data=list 877 条  meta.count=None
 *       stores        ?paginate=false → data=list   1 条  meta.count=None   （非受管资源同样 None）
 *       同上三条的分页形态            → meta.count = 519 / 877 / 1        （分页分支正常）
 *     对照组很关键：**受管与非受管都一样是 None** ⇒ 这不是 scope 跑到别处去了，
 *     而是这一支压根不产出 meta。它不是"count 算错"，而是"count 直接不存在"——
 *     前端拿到 `undefined` 后如果自己兜底成"不限条数"，翻页就会跨库。
 *
 * ⇒ 本层做两件事，都是**加法**（不依赖任何一条假设成立）：
 *     A. **有 meta.count 时**：拿同一份 handler 参数（同 scope/同 filter/同状态）
 *        再数一次，不一致就**以范围内的数覆盖**并记 warning。
 *        恒等时零输出、零改写 —— 与现在行为逐字节一致。
 *     B. **paginate=false 时**：不发裸数组，改发与分页分支**同结构**的
 *        `{count, rows, page, pageSize, totalPage}`，让 dataWrapping 照常产出 meta。
 *        这样"总数"在任何情况下都存在，前端不需要兜底（兜底就是隐患本身）。
 *        实测效果（同一环境、同一账号）：
 *          serviceTickets?paginate=false → 519 条  meta.count 由 **None → 519**
 *          smsLogs       ?paginate=false → 877 条  meta.count 由 **None → 877**
 *          stores        ?paginate=false → 1 条    meta.count 仍为 None（有意不动）
 *
 * ---------------------------------------------------------------------------
 * 🔴 为什么"再数一次"不会引入新的越权面
 * ---------------------------------------------------------------------------
 * 复核查询用 `ctx.getCurrentRepository()` —— 与 list action **同一个** repository，
 * 并且 `filter` 直接取 `ctx.action.params.filter`（**已经过** storeScope 注入）。
 * 也就是说复核的输入是"ACL + storeScope + 用户 filter"三者合并后的结果，
 * 不可能比 handler 自己算得更宽：
 *   · 它不会**放宽**：scope 条件在我们复核时已经躺在那份 filter 里；
 *   · 它也不会**收紧**成假 0：任一步抛错 ⇒ 原样保留框架给的 count（fail-open
 *     到"不改写"），并记 warning —— 复核失败不应该让业务看不到数据。
 *
 * 反过来，如果哪天 scope 真的丢了，`rowFilter`（原框架 filter）与
 * `scopedFilter`（含 scope）会不一样：此时**只覆盖 count，不动 rows**，
 * 于是页面变成"总数比能翻到的多"，而不是"翻出去看到别家门店的单"。
 * 这是刻意选的失败方向：多出来的数字是可见的 bug，翻出去的数据是看不见的事故。
 *
 * ---------------------------------------------------------------------------
 * 挂载点
 * ---------------------------------------------------------------------------
 * `after: 'store-scope'`（`plugin.ts` 里紧随 `registerStoreScope()` 注册）。
 * 必须在 storeScope 之后 —— 否则 `ctx.action.params.filter` 里还没有范围条件，
 * 复核就等于拿"用户的 filter"去数，那才是真的丢掉 scope。
 * 本层内部是 `await next()` 之后改 `ctx.body`，所以只要排在 storeScope **之后**，
 * handler 与 dataWrapping 的先后都不影响正确性。
 */
import { SCOPED_RESOURCES } from './store-scope';

export interface ListCountScopeGuardOptions {
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
  /** 关闭守卫（仅供离线桩/单测使用，**绝不**在任何运行环境开启） */
  disabled?: boolean;
  /**
   * 复核上限：超过这个数量的表把 `count` 改成估算（与框架 `simplePaginate`
   * 同一阈值 3e5）；未超过时走精确 `count`。
   */
  exactLimit?: number;
}

/** 与框架 `SIMPLE_PAGINATION_LIMIT` 同值，避免我们自己造一个"多少条算大数据"的口径 */
const DEFAULT_EXACT_LIMIT = 300000;

function resolveResourceName(ctx: any): string | undefined {
  const raw =
    ctx?.action?.resourceName ?? ctx?.resource?.name ?? ctx?.action?.resource?.name ?? undefined;
  if (!raw) return undefined;
  return String(raw).split('.')[0];
}

function resolveActionName(ctx: any): string {
  return String(ctx?.action?.actionName ?? ctx?.action?.name ?? 'unknown');
}

/** `paginate=false` 在框架里有 `false` 与 `'false'` 两种写法，两边都认 */
function isNonPaged(ctx: any): boolean {
  const p = ctx?.action?.params?.paginate;
  return p === false || p === 'false';
}

/** 把一次 list 请求里"决定查到哪些行"的参数原样抄出来 */
function buildCountArgs(ctx: any): Record<string, unknown> {
  const params = ctx?.action?.params ?? {};
  const args: Record<string, unknown> = { context: ctx };
  // filter 是范围的主体；没有 filter 时不传，避免 `filter: undefined` 被当成空对象
  if (params.filter !== undefined) args.filter = params.filter;
  // 关联筛选（关系路径 `ticket.store_id` / `archive.store_id`）依赖这些字段参与解析
  if (params.fields !== undefined) args.fields = params.fields;
  if (params.appends !== undefined) args.appends = params.appends;
  if (params.except !== undefined) args.except = params.except;
  if (params.tree !== undefined) args.tree = params.tree;
  return args;
}

export function createListCountScopeGuard(
  options: ListCountScopeGuardOptions = {},
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  const { logger } = options;
  const exactLimit = options.exactLimit ?? DEFAULT_EXACT_LIMIT;

  return async function listCountScopeGuard(ctx: any, next: () => Promise<void>): Promise<void> {
    if (options.disabled) return next();

    const resourceName = resolveResourceName(ctx);
    const actionName = resolveActionName(ctx);

    // 只处理受管资源的 list —— 其它资源的总数与业务隔离无关，
    // 多查一次只是白付一次 SQL。
    if (actionName !== 'list' || !resourceName || !SCOPED_RESOURCES[resourceName]) {
      return next();
    }

    const nonPaged = isNonPaged(ctx);

    await next();

    // handler 已经把结果写进 ctx.body：分页分支是对象，`paginate=false` 是裸数组
    const body = ctx.body;

    // ---- B. paginate=false：补出与分页分支同结构的外壳 ----
    if (nonPaged) {
      if (!Array.isArray(body)) return; // 已被别的中间件改写过，失配时不强行改造
      const rows = body;
      ctx.body = {
        count: rows.length,
        rows,
        page: 1,
        pageSize: rows.length,
        totalPage: 1,
      };
      // 框架此时会把 ctx.paginate 置为 false，dataWrapping 仍会按
      // “有 rows 就当列表”处理 —— 保持 paginate=false 语义（没有下一页），
      // 但 meta.count 从此存在。这一行是"补总数"，不是"打开分页"。
      logger?.debug?.(
        `[listCount] ${resourceName}:list paginate=false ⇒ 补出 meta.count=${rows.length}（不再返回裸数组）`,
      );
      return;
    }

    // ---- A. 分页分支：复核 count 与 rows 是否同源 ----
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    if (typeof body.count !== 'number' || !Array.isArray(body.rows)) {
      // `simplePaginate` 分支只有 {rows, hasNext, page, pageSize}，没有 count ——
      // 那一支框架本来就不给总数，我们没有"覆盖"的对象，也不该凭空造一个。
      return;
    }

    let repository: any;
    try {
      repository = ctx.getCurrentRepository?.();
    } catch {
      repository = undefined;
    }
    if (!repository || typeof repository.count !== 'function') {
      // 拿不到同一个 repository ⇒ 不可能保证"同源"，那就**不改写**。
      logger?.warn?.(
        `[listCount] ${resourceName}:list 无法取得 current repository，跳过 count 复核（保留框架值）`,
      );
      return;
    }

    const countArgs = buildCountArgs(ctx);

    let scopedCount: number | null = null;
    try {
      const estimated =
        typeof repository.getEstimatedRowCount === 'function'
          ? Number(await repository.getEstimatedRowCount())
          : 0;
      if (estimated > exactLimit) {
        // 大表：精确 count 会拖慢首屏。与框架 simplePaginate 同一取舍，
        // 但**不写库改 collection.options**（框架那一支会 update collections，
        // 那是全局副作用，不该由一个计数守卫触发）。
        logger?.debug?.(
          `[listCount] ${resourceName}:list 表估算 ${estimated} > ${exactLimit}，跳过精确复核`,
        );
        return;
      }
      scopedCount = Number(await repository.count(countArgs));
    } catch (error) {
      // 复核失败 ⇒ 保留框架值。理由见文件头「反过来的失败方向」：
      // 复核是我们加的保险，保险坏了不该让业务看不到数据。
      logger?.warn?.(
        `[listCount] ${resourceName}:list count 复核失败，保留框架值 ${body.count}：` +
          (error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    if (!Number.isFinite(scopedCount) || scopedCount < 0) return;

    if (scopedCount === body.count) return; // 恒等：零改写、零日志噪声

    const pageSize = Number(body.pageSize) || (body.rows.length || 1);
    logger?.warn?.(
      `[listCount] ${resourceName}:list meta.count 与范围不一致：框架=${body.count} 复核=${scopedCount}` +
        ` ⇒ 以复核值覆盖（rows 不动，共 ${body.rows.length} 行）`,
    );
    ctx.body = {
      ...body,
      count: scopedCount,
      totalPage: Math.ceil(scopedCount / pageSize),
    };
  };
}
