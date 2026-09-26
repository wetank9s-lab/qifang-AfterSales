/**
 * export-service.ts —— Phase 9：工单导出（I17）的**唯一实现**。
 *
 * =============================================================================
 * 🔴 它是 ServiceTicket 批量数据的**唯一受支持出口**（D3 = 闭合，用户 2026-09-26 裁定）
 * =============================================================================
 * NocoBase 原生 `<资源>:export` 对**任何角色（含 root/admin）**都不再是导出通路
 * （能力层守卫见 `middleware/native-export-guard.ts` / DEV-91）。
 * 于是本文件承担了整条"数据出境路径"的全部安全义务，四件事缺一不可：
 *
 *   ① `applyScope` 裁范围（不是靠前端筛选）
 *   ② **逐列白名单**（不是黑名单：`TICKET_READONLY_FIELDS` 是"后台不可改"，
 *      **不是不可见** ⇒ 直出整行会带出 `escalated` / `reopen_count` / …
 *      以及凭据列）
 *   ③ **固定脱敏**（D3-a：手机号一律脱敏，**不随** `VIEW_RAW_MOBILE` 放开）
 *   ④ CSV injection 防护 + **一条导出审计**
 *
 * =============================================================================
 * ⚠️ 三处刻意的"收紧"，都写在这里，免得后来人当成 bug 改回去
 * =============================================================================
 *
 * **① 手机号一律脱敏（D3-a）**
 *   `maskTicketForActor` 对 `hq_admin` 会**放行**原始号码（hq_admin 不属
 *   `MASK_MOBILE_ROLES`）。但导出是"批量带走"：若一个 admin 一次导出就能拿到
 *   整个窗口期的全部客户号码，那"导出 = 数据出境路径"这个前提就不成立。
 *   ⇒ 本文件在 `maskTicketForActor` 之后**再显式脱敏一次**两列手机号。
 *   需要看某个客户号码时走**工单详情**（已有 ACL + 审计），而不是批量带走。
 *
 * **② 自由文本里的手机号也要打码**
 *   `content`（报修内容）/ `service_note` / `review_comment` 等是自由文本，
 *   客户完全可能把号码写在里面（"打 13800008220 找我"）。
 *   只脱敏"手机号列"而不管自由文本，会让 ① 的承诺落空。
 *   ⇒ `maskMobilesInText()` 对自由文本列做**精确**的 11 位手机号打码
 *   （`(?<!\d)1[3-9]\d{9}(?!\d)`，前后不许再有数字，避免误伤长订单号）。
 *
 * **③ 审计先落库，再发数据**
 *   契约 §7 写的是"流式输出"。实现改成**有界一次性查询 + 审计先落库**，
 *   理由是这两条在实现上互相冲突，而后者是硬要求：
 *   · 若边流边写审计，则在"审计写库失败"时数据已经出站 ⇒ 出现**无审计的导出**，
 *     而这正是 D3 要消灭的那类状态（"谁能带走、带走了多少"事后答不上来）；
 *   · 改为：先取数（**上限显式**：`EXPORT_MAX_ROWS`，超限直接 413 拒绝，不截断）
 *     → **审计提交成功** → 才发送响应体。内存最大 ≈ 上限 × 单行字节数，
 *     有界且与"一次性载入全表"完全无关（查询本身带 `LIMIT 上限+1`）。
 *   若将来真需要十万级导出，正确做法是**导出让位给异步任务**，而不是把
 *   审计变成"尽力而为"。
 *
 * =============================================================================
 * 审计只记"必要事实"（用户原话：不要制造第二份敏感数据副本）
 * =============================================================================
 * 记：操作者（id/账号/角色）· 导出时刻 · 筛选与日期范围 · 条数 · requestId ·
 *     规则版本 · **列名清单**
 * 不记：任何**被导出的值**、整份 CSV
 * 落点：独立集合 `export_audits`（不复用 `ticket_events` —— 那张表的
 *      `ticket_id` 是 `allowNull:false`，而导出是**跨工单**事件）。
 */
import { EXPORT_AUDIT_COLLECTION, NATIVE_READ_FIELD_DENY, VISIT_STATUS } from '../constants';
import { maskMobileText } from './permission-service';
import type { Actor } from './permission-service';
import { ValidationError } from './ticket-service';
import {
  buildTicketScope,
  normalizeWindow,
  readFilters,
  type ReportDeps,
  type ReportFilters,
  type ReportWindow,
} from './report-kpi';

/**
 * 导出规则版本 —— 进审计。
 *
 * 安全规则会演进（今天脱敏手机号，明天可能连姓名一起脱敏）。只记"导出了 N 条"
 * 而不记"按哪版规则导的"，事后无法判断某次历史导出**当时**是否符合**当时**的规则。
 * 改动本文件的脱敏/防注入规则 ⇒ 必须**递增**此版本号。
 */
export const EXPORT_ENGINE_VERSION = 'p9-1';

/**
 * 单次导出的**显式上限**（契约 §7「上限阈值须显式（超限拒绝或分片）」）。
 *
 * 取"拒绝"而不是"截断"：静默截断会让人以为"这个窗口就这么多数据"，
 * 而导出的用途（对账 / 客诉取证）恰恰最不能容忍少数据。
 */
export const EXPORT_MAX_ROWS = 5000;

/** CSV 列分隔与行结束（导出给对方 Excel 用，保持 CRLF —— RFC 4180） */
const CSV_EOL = '\r\n';

// ---------------------------------------------------------------------------
// 列白名单
// ---------------------------------------------------------------------------

export type ExportColumn = {
  /** 输出列名（CSV 表头，也是审计里记录的"列名清单"元素） */
  key: string;
  /** 中文表头（给人看） */
  label: string;
  /** 取值来源：工单表 or 当前有效派工 */
  from: 'ticket' | 'visit';
  /** 是否自由文本（需要做手机号打码 —— 见文件头"收紧 ②"） */
  freeText?: boolean;
  /** 是否手机号列（需要固定脱敏 —— 见文件头"收紧 ①"） */
  mobile?: boolean;
};

/**
 * 导出列白名单（**唯一的导出列事实来源**）。
 *
 * 为什么是"逐列列举"而不是"整行 − 敏感列"：
 *   排除法的漏项是**新增列**（新列默认会被导出去，而没人会想起来同步这里）；
 *   列举法的漏项是**新列导不出去**（一眼可见，且不构成泄漏）。
 *   在"数据出境路径"上，两种失败的代价不对称 ⇒ 选列举法。
 *   （这与 `NATIVE_READ_FIELD_DENY` 的取舍**刻意相反**：那里排除法更合适，
 *    因为它的目的是"让后台列表能看见新业务列"。两处的判据不同，不是不一致。）
 *
 * ⚠️ 刻意**不在**名单内的列（每一条都有理由，不要顺手加）：
 *   · `feedback_token_hash` / `feedback_token_expires_at` / `feedback_token_used_at`
 *     —— 凭据列（`NATIVE_READ_FIELD_DENY`），哈希泄露 = 可离线爆破构造可用链接；
 *   · `handler_user_id` / `feedback_visit_id` —— 内部外键，对人无意义；
 *   · `extra_json` —— **自由形态的内部袋子**，内容未经评审 ⇒ 不进导出面；
 *   · Visit 的 `access_token_hash` / `token_expires_at` / `token_used_at` /
 *     `token_revoked_at` / `token_revoked_reason` —— 凭据列。
 * 底部 `assertExportColumnsSafe()` 会在**模块加载时**再验一次前两组，
 * 并在启动自检里被调用（`plugin.assertExportColumnSafety`）。
 */
export const TICKET_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'id', label: '工单ID', from: 'ticket' },
  { key: 'ticket_no', label: '工单号', from: 'ticket' },
  { key: 'store_id', label: '门店ID', from: 'ticket' },
  { key: 'source_store_code', label: '来源门店编码', from: 'ticket' },
  { key: 'source', label: '来源', from: 'ticket' },
  { key: 'ticket_type', label: '工单类型', from: 'ticket' },
  { key: 'content', label: '报修/投诉内容', from: 'ticket', freeText: true },
  { key: 'customer_name', label: '客户姓名', from: 'ticket' },
  { key: 'customer_mobile', label: '客户手机号', from: 'ticket', mobile: true },
  { key: 'status', label: '状态', from: 'ticket' },
  { key: 'service_mode', label: '服务方式', from: 'ticket' },
  { key: 'provider_name', label: '厂家/第三方名称', from: 'ticket' },
  { key: 'technician_name', label: '师傅姓名', from: 'ticket' },
  { key: 'technician_mobile', label: '师傅手机号', from: 'ticket', mobile: true },
  { key: 'expected_visit_at', label: '预计上门日期', from: 'ticket' },
  { key: 'dispatch_at', label: '首次派工时间', from: 'ticket' },
  { key: 'completion_result', label: '完成结果', from: 'ticket' },
  { key: 'completion_note', label: '完成说明', from: 'ticket', freeText: true },
  { key: 'completed_at', label: '完成时间', from: 'ticket' },
  { key: 'rating', label: '评分', from: 'ticket' },
  { key: 'review_comment', label: '评价内容', from: 'ticket', freeText: true },
  { key: 'reviewed_at', label: '评价时间', from: 'ticket' },
  { key: 'review_status', label: '评价状态', from: 'ticket' },
  { key: 'escalated', label: '异常升级', from: 'ticket' },
  { key: 'reopen_count', label: '重开次数', from: 'ticket' },
  { key: 'close_reason', label: '关闭原因', from: 'ticket' },
  { key: 'first_response_at', label: '首次响应时间', from: 'ticket' },
  { key: 'closed_at', label: '关闭时间', from: 'ticket' },
];

/**
 * Visit 侧导出列（**当前有效派工**的那一条，见 `latestVisitSql`）。
 *
 * 收费相关列都在 Visit 上（契约 §7：必须 join Visit）。
 */
export const VISIT_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'visit_no', label: '上门次序', from: 'visit' },
  { key: 'visit_status', label: '派工状态', from: 'visit' },
  { key: 'service_result', label: '服务结果', from: 'visit' },
  { key: 'service_note', label: '处理说明', from: 'visit', freeText: true },
  { key: 'is_charged', label: '是否收费', from: 'visit' },
  { key: 'reported_charge_amount', label: '师傅填报金额', from: 'visit' },
  { key: 'confirmed_charge_amount', label: '门店确认金额', from: 'visit' },
  { key: 'submitted_at', label: '师傅提交时间', from: 'visit' },
  { key: 'store_confirm_status', label: '门店处置状态', from: 'visit' },
  { key: 'store_confirm_note', label: '驳回/改额原因', from: 'visit', freeText: true },
  { key: 'store_confirmed_at', label: '处置时间', from: 'visit' },
  { key: 'customer_charge_match', label: '收费一致性', from: 'visit' },
  { key: 'customer_reported_amount', label: '客户实付金额', from: 'visit' },
  { key: 'charge_diff_reason', label: '收费差异说明', from: 'visit', freeText: true },
];

export const EXPORT_COLUMNS: ExportColumn[] = [...TICKET_EXPORT_COLUMNS, ...VISIT_EXPORT_COLUMNS];

/**
 * 导出列 ∩ 凭据列 = ∅ —— 这条断言的价值在于**它会在启动时跑**。
 *
 * 若哪天有人往白名单里加了一列凭据（复制粘贴最容易发生），
 * 应用**起不来**，而不是安静地把 Token 哈希导进 CSV。
 */
export function exportColumnSafetyViolations(): string[] {
  const denied = new Set<string>([
    ...(NATIVE_READ_FIELD_DENY.serviceTickets ?? []),
    ...(NATIVE_READ_FIELD_DENY.serviceVisits ?? []),
  ]);
  const violations: string[] = [];
  for (const column of EXPORT_COLUMNS) {
    if (denied.has(column.key)) violations.push(column.key);
  }
  return violations;
}

/** 违规即抛（模块加载期与启动自检都会调到） */
export function assertExportColumnsSafe(): void {
  const violations = exportColumnSafetyViolations();
  if (violations.length > 0) {
    throw new Error(
      `[export] 导出列白名单含凭据列：${violations.join(', ')} —— 这是安全边界，不允许出现在导出面`,
    );
  }
}

assertExportColumnsSafe();

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * CSV injection（公式注入）危险前缀。
 *
 * 用户 2026-09-26 明确要求验这一条：`=` `+` `-` `@` 等危险单元格必须被转义。
 * `\t` / `\r` 一并挡掉 —— 它们是"看起来不是公式、但会被表格软件当作行首"的形态。
 */
const CSV_DANGER_PREFIX = /^[=+\-@\t\r]/;

/** 单元格 → CSV 文本（先防注入加前缀，再按需加引号转义） */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  if (CSV_DANGER_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * 自由文本里的手机号打码（见文件头"收紧 ②"）。
 *
 * ⚠️ 正则的 `(?<!\d)` / `(?!\d)` 是**必要的**：没有它们，
 *    一个 13 位订单号 `2026092613800` 里的 `13800…` 片段会被误打码成
 *    `2026092613****800`，把业务数据改坏。
 * 只在 `maskMobileText` 的同一口径下工作（前 3 后 4）。
 */
export function maskMobilesInText(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return value;
  return value.replace(/(?<!\d)(1[3-9]\d{9})(?!\d)/g, (match) => maskMobileText(match));
}

/** 值 → 该列的输出文本（应用 ① 固定脱敏 / ② 自由文本打码） */
function projectValue(column: ExportColumn, raw: unknown): unknown {
  if (column.mobile) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    // 固定脱敏：**不看角色**（D3-a）。`maskTicketForActor` 的放行在这里被覆盖。
    return maskMobileText(String(raw));
  }
  if (column.freeText) return maskMobilesInText(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface ExportOutcome {
  csv: string;
  rowCount: number;
  columns: string[];
  window: ReportWindow;
  filters: ReportFilters;
  engineVersion: string;
  /** 写入的审计行 id（失败/拒绝时**不会**有它 —— 不伪造成功审计） */
  auditId: number | null;
}

/**
 * 查询：样本工单（有界）LEFT JOIN LATERAL 取**当前有效派工**。
 *
 * `ORDER BY (visit_status <> 'SUPERSEDED') DESC, visit_no DESC` 的语义：
 *   ① 优先非 SUPERSEDED（被改派取代的旧 Visit 不是"当前"的）；
 *   ② 同组内取 visit_no 最大（最近一次）。
 * 为什么只导"当前有效派工"：导出是**工单维度**（一行一单），
 * `row_count` 才能等于"导出了多少张单"；历史派工留在 `svc:visits` 详情里可追溯。
 */
function exportSql(params: {
  where: string;
  limitPlaceholder: string;
  supersededPlaceholder: string;
  ticketCols: string[];
  visitCols: string[];
}): string {
  const ticketCols = params.ticketCols.join(', ');
  const visitCols = params.visitCols.map((col) => `v.${col}`).join(', ');
  const lateralCols = params.visitCols.join(', ');
  return `WITH sample AS (
            SELECT ${ticketCols}
              FROM service_tickets
             WHERE ${params.where}
             ORDER BY id ASC
             LIMIT ${params.limitPlaceholder}
          )
          SELECT s.*, ${visitCols}
            FROM sample s
            LEFT JOIN LATERAL (
              SELECT ${lateralCols}
                FROM service_visits
               WHERE ticket_id = s.id
               ORDER BY (visit_status <> ${params.supersededPlaceholder}) DESC, visit_no DESC
               LIMIT 1
            ) v ON TRUE
           ORDER BY s.id ASC`;
}

/**
 * 工单导出主流程。
 *
 * 顺序是**安全语义**的一部分，不要重排：
 *   鉴权（在 action 层）→ 范围裁剪 → 有界取数（超限 413）→ 投影与脱敏
 *   → 生成 CSV → **写审计** → 返回。
 * 任何一步抛错 ⇒ 没有审计行、也没有响应体（`不伪造成功审计`）。
 */
export async function exportTickets(
  deps: ReportDeps,
  actor: Actor,
  params: {
    from?: unknown;
    to?: unknown;
    storeId?: unknown;
    ticketType?: unknown;
    status?: unknown;
    serviceMode?: unknown;
    ratingMin?: unknown;
    requestId?: string | null;
    now?: Date;
    /** 测试注入用（默认 `EXPORT_MAX_ROWS`） */
    maxRows?: number;
  },
): Promise<ExportOutcome> {
  const now = params.now ?? new Date();
  const window = normalizeWindow(params.from, params.to, now);
  const filters = readFilters(params);
  const maxRows =
    Number.isFinite(Number(params.maxRows)) && Number(params.maxRows) > 0
      ? Math.trunc(Number(params.maxRows))
      : EXPORT_MAX_ROWS;

  const scope = buildTicketScope(deps.permissions, actor, window, filters);
  const ticketCols = TICKET_EXPORT_COLUMNS.map((column) => column.key);
  const visitCols = VISIT_EXPORT_COLUMNS.map((column) => column.key);

  // 绑定顺序：WHERE 段（$1..$k）→ LIMIT（$k+1）→ SUPERSEDED（$k+2）
  const binds = [...scope.binds, maxRows + 1, VISIT_STATUS.SUPERSEDED];
  const limitPlaceholder = `$${scope.binds.length + 1}`;
  const supersededPlaceholder = `$${scope.binds.length + 2}`;

  const rows = await queryRows(
    deps.db,
    exportSql({
      where: scope.where,
      limitPlaceholder,
      supersededPlaceholder,
      ticketCols,
      visitCols,
    }),
    binds,
  );

  if (rows.length > maxRows) {
    // 显式拒绝（不静默截断：对账/取证场景最不能容忍少数据）
    throw new ValidationError(
      'EXPORT_TOO_LARGE',
      `本次筛选结果超过单次导出上限 ${maxRows} 条，请缩小日期范围或增加筛选条件`,
      413,
    );
  }

  const header = EXPORT_COLUMNS.map((column) => column.label);
  const lines: string[] = [header.map(csvCell).join(',')];

  for (const row of rows) {
    const cells = EXPORT_COLUMNS.map((column) =>
      csvCell(projectValue(column, row[column.key])),
    );
    lines.push(cells.join(','));
  }

  // Excel 打开 UTF-8 CSV 的既有坑：没有 BOM 就按本地编码解，中文全乱。
  const csv = `\uFEFF${lines.join(CSV_EOL)}${CSV_EOL}`;

  // ---- 审计（只记事实；**不记**任何被导出的值）----
  const auditId = await writeExportAudit(deps, actor, {
    window,
    filters,
    rowCount: rows.length,
    columns: EXPORT_COLUMNS.map((column) => column.key),
    requestId: params.requestId ?? null,
    at: now,
  });

  return {
    csv,
    rowCount: rows.length,
    columns: EXPORT_COLUMNS.map((column) => column.key),
    window,
    filters,
    engineVersion: EXPORT_ENGINE_VERSION,
    auditId,
  };
}

/**
 * 写一条导出审计。
 *
 * 🔴 这里**失败会让整次导出失败**（异常向上抛 ⇒ 没有 CSV 出站）。
 *    理由：一条"能把客户数据批量带走"的路径，如果允许"审计写不进去也照样带走"，
 *    那审计就只是装饰 —— 而 D3 的核心诉求正是"事后能回答谁带走了多少"。
 *    （对照：Phase 8 的短信重试是"失败不回滚业务"，因为那条路径**不影响**安全边界。）
 */
async function writeExportAudit(
  deps: ReportDeps,
  actor: Actor,
  input: {
    window: ReportWindow;
    filters: ReportFilters;
    rowCount: number;
    columns: string[];
    requestId: string | null;
    at: Date;
  },
): Promise<number | null> {
  const repository = deps.db?.getRepository?.(EXPORT_AUDIT_COLLECTION);
  if (!repository || typeof repository.create !== 'function') {
    throw new Error(`[export] 无法写入审计集合 ${EXPORT_AUDIT_COLLECTION}，导出已中止`);
  }

  const username =
    actor.raw?.username ?? actor.raw?.nickname ?? actor.raw?.email ?? null;

  const created = await repository.create({
    values: {
      channel: 'svc:exportTickets',
      engine_version: EXPORT_ENGINE_VERSION,
      operator_user_id: actor.userId > 0 ? actor.userId : null,
      operator_username: username ? String(username) : null,
      operator_roles: actor.roles.length > 0 ? actor.roles.join(',') : null,
      exported_at: input.at,
      filter_json: {
        from: input.window.from,
        to: input.window.to,
        fromIso: input.window.fromIso,
        toIso: input.window.toIso,
        ...input.filters,
      },
      row_count: input.rowCount,
      columns_json: input.columns,
      request_id: input.requestId,
    },
  });

  const id = Number(created?.id ?? created?.get?.('id'));
  return Number.isFinite(id) ? id : null;
}

/** 与 `report-kpi.ts` 同口径的取值助手（避免两处各写一遍 sequelize 调用形态） */
async function queryRows(db: any, sql: string, binds: unknown[]): Promise<any[]> {
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw new Error('[export] db.sequelize.query 不可用');
  }
  const [rows] = (await sequelize.query(sql, { bind: binds })) as [unknown, unknown];
  return Array.isArray(rows) ? (rows as any[]) : [];
}

/** 导出用的 `Content-Disposition` 文件名（**不含**任何筛选值之外的隐私信息） */
export function exportFileName(window: ReportWindow, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `service-tickets_${window.from}_${window.to}_${stamp}.csv`;
}
