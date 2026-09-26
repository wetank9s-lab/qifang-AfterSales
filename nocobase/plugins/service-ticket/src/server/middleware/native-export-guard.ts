/**
 * nativeExportGuard —— 关闭 ServiceTicket 数据的**原生导出旁路**（Phase 9 / DEV-91）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这一层（D3 = 闭合，用户 2026-09-26 裁定）
 * ---------------------------------------------------------------------------
 * 导出在本项目里被定义成**一条独立的高风险数据出境路径**：
 *
 * ```
 *   受支持出口：  svc:exportTickets  → 仅 hq_admin → 固定脱敏
 *                                    → CSV injection 防护 → 导出审计
 *   旁路（要关）： serviceTickets:export → root/admin → 原始字段直出
 *                                    （无脱敏、无审计、不裁范围）
 * ```
 *
 * 两条并存 ⇒ 前面那套安全边界**可被"同一个管理员换一个 endpoint"绕开**，
 * 系统出现双轨语义。用户明确否决把它作为"已知风险"长期接受。
 *
 * ---------------------------------------------------------------------------
 * 🔴 为什么必须放在**中间件 + 能力名**这一层，而不是 URL 层或 ACL 层
 * ---------------------------------------------------------------------------
 * ① **不能靠 ACL**：`root` / `admin` 是平台超管，**绕过全部 ACL**。
 *    实证：`admin` 角色的 strategy.actions 里确实含 `export`
 *    （`plugin-action-export` 的 `afterInstall` 主动追加），`root` 更是全放行。
 *    在 ACL 层写"拒绝"对它们无效 —— 除非去改 NocoBase 的全局 root 语义，
 *    而那正是用户明令**不要**做的（"不要让一个导出问题扩张成平台权限模型改造"）。
 *
 * ② **不能只封 URL 字符串**：URL 形态是可变的（`?filter=`、POST body、
 *    `filterByTk`、将来可能的新参数），grep 一个 URL 只能挡住已经见过的那一种。
 *    这里判的是 `ctx.action.actionName` —— NocoBase **解析之后**的能力名，
 *    于是"换一种调用形态"同样命中（门禁 T4 专门验这一条）。
 *
 * ③ **挂载点在 ACL 之后**：resourcer 中间件的执行链是
 *    `[...resourcer.getMiddlewares(), ...action.middlewares, ...preActionHandlers, handler]`
 *    （见 @nocobase/resourcer/lib/action.js），所以本中间件的 `throw` 发生在
 *    **handler 之前**，超管也无法让请求落到 `exportXlsx` 上。
 *
 * ---------------------------------------------------------------------------
 * 取证依据（容器内 `@nocobase/plugin-action-export/dist/server/index.js`）
 * ---------------------------------------------------------------------------
 * ```js
 * dataSource.resourceManager.registerActionHandler("export", exportXlsx.bind(this));
 * dataSource.acl.setAvailableAction("export", {
 *   aliases: ["export", "exportAttachments"],   // 官方声明的第二个名字
 * });
 * ```
 * · handler 注册在 **resourceManager（按数据源）**而不是某个资源上
 *   ⇒ 该数据源下**每个 collection** 都长出了 `export`；
 * · `exportAttachments` 是官方声明的 alias（当前版本实测无 handler，得 404，
 *   但"恰好没实现"不能当作安全前提，一并关闭）。
 *
 * 已实测的旁路（修复前）：`POST /api/serviceTickets:export`
 * body `{ columns: [{dataIndex:['customer_mobile']}], ... }` →
 * **200 + XLSX，含明文手机号**。修复后同一请求由本中间件拦下。
 *
 * ---------------------------------------------------------------------------
 * 失败策略：**拒绝**，且**不调用 next()**
 * ---------------------------------------------------------------------------
 * 抛 `ForbiddenError`（自带 `status = 403`、`logLevel = 'warn'`，与 storeScope
 * 同一形态）⇒ 经 NocoBase 全局错误处理器返回 403，与项目其余越权响应同口径。
 */
import { NATIVE_EXPORT_ACTIONS, NATIVE_EXPORT_DENY_RESOURCES } from '../constants';
import { ForbiddenError } from '../services/permission-service';

export interface NativeExportGuardOptions {
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
  /** 关闭守卫（仅供离线桩/单测使用，**绝不**在任何运行环境开启） */
  disabled?: boolean;
}

/** 取资源名（与 storeScope 同口径：去掉 `.` 之后的数据源前缀） */
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

/**
 * 纯判定：这次 (resource, action) 是否**属于被关闭的原生导出**。
 *
 * 抽成纯函数有三处复用，都是为了"只有一个事实来源"：
 *   ① 中间件本体；
 *   ② 启动期自检（`plugin.assertNativeExportGuard()`）—— 名单与受管资源不一致就启动失败；
 *   ③ 门禁 `scripts/verify-native-export-bypass.mjs` 的离线断言。
 */
export function isNativeExportDenied(resourceName: string | undefined, actionName: string): boolean {
  if (!resourceName) return false;
  if (!NATIVE_EXPORT_DENY_RESOURCES.includes(resourceName)) return false;
  return NATIVE_EXPORT_ACTIONS.includes(actionName);
}

/**
 * 创建资源级中间件。挂到 `app.resourcer.use(..., { group:'native-export-guard', after:'acl' })`。
 *
 * ⚠️ `after: 'acl'` 是硬要求：放在 ACL 之前也能拦住（ACL 会 skip 超管），
 *    但**必须在 ACL 之后**才能保证"403 的原因写的是 NATIVE_EXPORT_FORBIDDEN 而不是
 *    某个更早的粗粒度拒绝"，排障时才看得出到底是谁挡的。
 */
export function createNativeExportGuardMiddleware(
  options: NativeExportGuardOptions = {},
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  const { logger } = options;

  return async function nativeExportGuard(ctx: any, next: () => Promise<void>): Promise<void> {
    if (options.disabled) return next();

    const resourceName = resolveResourceName(ctx);
    const actionName = resolveActionName(ctx);

    if (!isNativeExportDenied(resourceName, actionName)) return next();

    // 记 warn（不是 error）：这是安全模型**正常工作**的产物，但也比 404 更值得看一眼
    // —— 它指向"有人在用原生导出拉数据"或"后台还挂着一个导出按钮"。
    // 与 storeScope 的 NATIVE_RESOURCE_FORBIDDEN 记法完全一致。
    logger?.warn?.(
      `[nativeExportGuard] 拒绝经原生接口导出 ${resourceName}:${actionName}` +
        `（ServiceTicket 批量数据的唯一受支持出口是 /api/svc:${'exportTickets'}）`,
    );

    throw new ForbiddenError(
      'NATIVE_EXPORT_FORBIDDEN',
      `${resourceName} 不支持经原生接口导出，请使用平台提供的导出功能`,
    );
  };
}
