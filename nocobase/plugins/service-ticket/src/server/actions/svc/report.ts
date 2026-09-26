/**
 * Phase 9：HQ 看板 / 报表 / 导出（I15 · I16 · I17）。
 *
 * 对外路径（`docs/API.md` §4；nginx 折叠成冒号形式）：
 *   · `GET /api/svc/dashboard/summary` → `/api/svc:dashboardSummary`
 *   · `GET /api/svc/reports/kpi`       → `/api/svc:reportKpi`
 *   · `GET /api/svc/export/tickets`    → `/api/svc:exportTickets`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 三条接口的鉴权**刻意不同**，而且差异必须留在 action 层
 * ─────────────────────────────────────────────────────────────────────────────
 *   · dashboardSummary —— **已登录即可**（ACL 走 `loggedIn`）；
 *        数据范围由 `applyScope` 裁（ACL 是"能不能调这个 action"，
 *        它没有"这条数据你能不能看"这个维度）。门店角色因此只看到本店。
 *   · reportKpi        —— `CAPABILITY.PRIVILEGED`（总部售后 / 总部管理员）。
 *   · exportTickets    —— `CAPABILITY.ADMIN`（**仅 hq_admin**）。
 *        ⚠️ 刻意**不是** `PRIVILEGED`：报表是"看"，导出是"带走"。
 *        把两者合成一个能力，等于"能看报表的人就能把整批客户号码带走"。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么三条都只走 `loggedIn` 粗粒度放行（而不是在 `registerAuthenticatedActions` 里细分）
 * ─────────────────────────────────────────────────────────────────────────────
 * 与既有 16 条同构：ACL 只回答"这个身份能不能碰这个接口"，**能力与范围**由
 * PermissionService 在 action 层强制。好处是"谁能做什么"全部收在
 * `CAPABILITY` 一处，而不是一半在 ACL 配置、一半在代码里 —— 那种分裂最难审计。
 */
import { SVC_ACTION } from '../../constants';
import { exportFileName, exportTickets } from '../../services/export-service';
// ⚠️ `CAPABILITY` 的**唯一定义处**是 permission-service（能力模型与判定函数同源），
//    constants.ts 只在注释里引用它。别把它当成"常量集合"的一员从 constants 取。
import { CAPABILITY } from '../../services/permission-service';
import {
  dashboardSummary,
  reportKpi,
  type DashboardResult,
  type KpiResult,
  type ReportDeps,
} from '../../services/report-kpi';
import { slaPortFromServices } from '../../services/sla-scan-scheduler';
import { fail, ok, readRequestId } from './_http';
import {
  createWrapper,
  param,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

export interface ReportActionDeps extends SvcActionDeps {
  /** 聚合 SQL 必须直接下库（见 `report-kpi.ts` 的 `ReportDeps` 说明） */
  db: any;
}

export function createReportActionHandlers(deps: ReportActionDeps): Record<string, ActionHandler> {
  const { services, db, logger } = deps;
  const { permissions } = services;
  const wrap = createWrapper(deps);

  /**
   * 装配 `ReportDeps`。
   *
   * ⚠️ `slaPort` 由 `slaPortFromServices(services)` 现取 —— 它是 Phase 8 暴露的
   *    **窄接口**（只含 SLA 扫描需要的 7 个只读方法）。这里刻意**不把
   *    `services` 整个传进去**：报表只需要"读事实"，拿到整套服务图就会有人
   *    顺手在里面写状态（而 SLA/报表在契约里是**纯读**的）。
   */
  const reportDeps = (): ReportDeps => ({
    db,
    permissions,
    slaPort: slaPortFromServices(services),
    logger,
    readLowScoreThreshold: () => services.config.getInt('feedback.low_score_threshold', 2),
  });

  // -------------------------------------------------------------------------
  // I15 —— HQ 看板聚合
  // -------------------------------------------------------------------------
  const dashboard = wrap(SVC_ACTION.DASHBOARD_SUMMARY, async (ctx, actor) => {
    const result: DashboardResult = await dashboardSummary(reportDeps(), actor, {
      from: param(ctx, 'from'),
      to: param(ctx, 'to'),
      storeId: param(ctx, 'storeId'),
      ticketType: param(ctx, 'ticketType'),
      serviceMode: param(ctx, 'serviceMode'),
      ratingMin: param(ctx, 'ratingMin'),
      overdueKind: param(ctx, 'overdueKind'),
      page: param(ctx, 'page'),
      pageSize: param(ctx, 'pageSize'),
    });
    ok(ctx, result);
  });

  // -------------------------------------------------------------------------
  // I16 —— 12 项 KPI 报表
  // -------------------------------------------------------------------------
  const kpi = wrap(SVC_ACTION.REPORT_KPI, async (ctx, actor) => {
    permissions.assertCapability(actor, CAPABILITY.PRIVILEGED);

    // 契约 §6：`from` / `to` **必填**。
    // ⚠️ 为什么不给"缺省最近 30 天"的兜底：报表是要被**引用/对外**的数字，
    //    "忘了传日期 ⇒ 悄悄按最近 30 天出数"会让一份口径不明的报表看起来很正常。
    //    看板可以兜底（它是"现在什么情况"），报表不行（它是"这段时间怎么样"）。
    const from = param(ctx, 'from');
    const to = param(ctx, 'to');
    if (isBlank(from) || isBlank(to)) {
      fail(ctx, 422, 'MISSING_DATE_RANGE', 'reports/kpi 必须显式传 from 与 to', {
        missing: [...(isBlank(from) ? ['from'] : []), ...(isBlank(to) ? ['to'] : [])],
      });
      return;
    }

    const result: KpiResult = await reportKpi(reportDeps(), actor, {
      from,
      to,
      storeId: param(ctx, 'storeId'),
      ticketType: param(ctx, 'ticketType'),
      status: param(ctx, 'status'),
      serviceMode: param(ctx, 'serviceMode'),
      ratingMin: param(ctx, 'ratingMin'),
    });
    ok(ctx, result);
  });

  // -------------------------------------------------------------------------
  // I17 —— 工单导出（**唯一受支持出口**）
  // -------------------------------------------------------------------------
  const exportCsv = wrap(SVC_ACTION.EXPORT_TICKETS, async (ctx, actor) => {
    // 🔴 只有 hq_admin（平台超管按 PLATFORM_ADMIN_ROLES 的既有口径对待）。
    //    其余一律 403 —— 门店/总部售后/viewer 都拿不到批量数据。
    permissions.assertCapability(actor, CAPABILITY.ADMIN);

    const now = new Date();
    const requestId = readRequestId(ctx);

    const outcome = await exportTickets(reportDeps(), actor, {
      from: param(ctx, 'from'),
      to: param(ctx, 'to'),
      storeId: param(ctx, 'storeId'),
      ticketType: param(ctx, 'ticketType'),
      status: param(ctx, 'status'),
      serviceMode: param(ctx, 'serviceMode'),
      ratingMin: param(ctx, 'ratingMin'),
      requestId,
      now,
    });

    ctx.withoutDataWrapping = true;
    ctx.set?.('Content-Type', 'text/csv; charset=utf-8');
    ctx.set?.('Content-Disposition', `attachment; filename="${exportFileName(outcome.window, now)}"`);
    // 私有内容：既不让中间层缓存，也不写进浏览器磁盘缓存
    ctx.set?.('Cache-Control', 'private, no-store');
    ctx.set?.('X-Content-Type-Options', 'nosniff');
    // 条数写在响应头上：调用方（与门禁）不必去查审计就能核对
    // "CSV 数据行数 == 审计里的 row_count"。
    ctx.set?.('X-Export-Row-Count', String(outcome.rowCount));
    ctx.set?.('X-Export-Engine-Version', outcome.engineVersion);
    ctx.status = 200;
    ctx.body = outcome.csv;
  });

  return {
    [SVC_ACTION.DASHBOARD_SUMMARY]: dashboard,
    [SVC_ACTION.REPORT_KPI]: kpi,
    [SVC_ACTION.EXPORT_TICKETS]: exportCsv,
  };
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}
