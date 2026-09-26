/**
 * report-kpi.ts —— Phase 9：HQ 看板聚合（I15）与 12 项 KPI（I16）。
 *
 * =============================================================================
 * 本文件的**唯一职责**：把已经存在的事实**读出来并算清楚**，不发明任何口径
 * =============================================================================
 * 契约 `docs/PHASE-9.md` §2 冻结：**全仓不允许出现第二处 overdue 谓词**。
 * 因此本文件里的"超时"数字**一律**来自 Phase 8 的
 *   · `runSlaScan`（计数）
 *   · `slaPortFromServices`（同一 port）
 *   · `appointmentOverdueFrom`（同一纯函数）
 *   · `APPOINTMENT_ACTIVE_TICKET_STATUSES`（同一状态白名单）
 * 本文件**写不出一个 overdue**：它连一条 `expected_visit_at < now` 都没有。
 *
 * =============================================================================
 * ⚠️ 为什么明细不直接消费 `runSlaScan().facts[]`（一个必须写下来的坑）
 * =============================================================================
 * `facts[]` 的填充顺序是 **acceptance → store_confirm → appointment**，且最后
 * 统一 `slice(0, detailLimit)`（读 `sla-scan-scheduler.ts` 的 `runSlaScan` 即可验证）：
 *   · 若待受理超时本身就 ≥ detailLimit 条，`facts` 被它填满 ⇒
 *     **appointment 明细恒为空**，而 `appointmentOverdue` 计数却可能是 5；
 *   · 于是"看板显示预约逾期 5 条，点开明细一条都没有"。
 *
 * ⇒ 明细改由 **同一个 port + 同一个纯函数**重建（`listXxxOverdue` /
 *   `listAppointmentCandidates` + `appointmentOverdueFrom` + `hasConfirmedVisit`），
 *   谓词零新增。`facts[]` 在语义上只服务"本轮扫到的样例"，不承担"按 kind 分页"的职责。
 *
 * 🔴 防漂移闸门：`scripts/verify-report-kpi.mjs` 断言
 *   **明细计数 == `runSlaScan` 计数**（global actor 场景）。两边哪天分叉，门禁立刻转红。
 *
 * =============================================================================
 * 日期窗口语义（契约 §3「日期范围一律按 created_at 落在窗口」的落地）
 * =============================================================================
 * 入参 `from` / `to` 是**日期**（`YYYY-MM-DD`），语义是**按天闭区间**，
 * 实现为**半开 datetime 区间**：
 *
 *     created_at ∈ [ from 00:00:00.000(+08:00) , (to + 1天) 00:00:00.000(+08:00) )
 *
 * ⚠️ 为什么 `to` 要 +1 天：若直接 `created_at < to 00:00`，"查 9/1~9/30"会把
 *    **9/30 整天排除在外** —— 最典型的"报表少一天"缺陷，只在看月底时暴露。
 *    保留"半开区间"这个**实现形态**是为了让边界只有一个方向（`$lt`），
 *    避免 `<= 23:59:59.999` 那种毫秒尾巴。
 * 传完整 ISO（含 `T`）时按**精确时刻**处理，不做 +1 天。
 * `window.fromIso` / `window.toIso` 在响应里回显 ⇒ 口径自证，不靠注释。
 */
import {
  CHARGE_MATCH,
  REVIEW_STATUS,
  SERVICE_MODE_VALUES,
  SMS_SEND_STATUS,
  TICKET_STATUS,
  TICKET_STATUS_VALUES,
  TICKET_TYPE_VALUES,
} from '../constants';
import { APPOINTMENT_TIMEZONE_OFFSET } from '../../shared/service-mode';
import type { Actor, DataScope, PermissionService } from './permission-service';
import { ValidationError } from './ticket-service';
import {
  APPOINTMENT_ACTIVE_TICKET_STATUSES,
  appointmentOverdueFrom,
  endOfLocalDay,
  runSlaScan,
  slaPortFromServices,
  type SlaOverdueFact,
  type SlaScanResult,
} from './sla-scan-scheduler';

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------
/**
 * ⚠️ 为什么显式注入 `db` 而不是从 `services` 上取：
 *    `createServices()` 的返回值**刻意不包含 db**（服务层不该是个"随便拿 db 用"的袋子）。
 *    但聚合 SQL 必须直接下到数据库（12 项 KPI 里有 8 项是 `AVG/SUM/FILTER`，
 *    NocoBase 的 repository filter 表达不了）。⇒ 由 action 层把 `this.db` 传进来，
 *    依赖关系写在类型里，而不是靠 `(services as any).db` 这种运行时猜。
 */
export interface ReportDeps {
  db: any;
  permissions: PermissionService;
  /** 与 `services` 同批构造的窄接口（SLA port 需要它） */
  slaPort: ReturnType<typeof slaPortFromServices>;
  logger?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  /** 低分阈值读取（`feedback.low_score_threshold`，默认 2） */
  readLowScoreThreshold?: () => Promise<number>;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 口径基准：判定/聚合一律走 **DB 字段**（契约 §4 C3）。展示口径是前端的事。 */
export const KPI_BASIS_FIELD = 'field' as const;

export const DASHBOARD_PAGE_SIZE_DEFAULT = 20;
export const DASHBOARD_PAGE_SIZE_MAX = 100;

/**
 * 明细取数的**下限**。
 *
 * 契约 §5 指定 `detailLimit = (page-1)*pageSize + pageSize`；这里再抬一个下限，
 * 既避免 pageSize 很小时候选查询不够用，也让 `listAppointmentCandidates`
 * 的内部上限（与 `limit*4` 挂钩）不至于把明细卡死。
 */
export const DETAIL_FETCH_FLOOR = 200;

/** 默认窗口长度（天）：不传 from/to 时取"最近 30 天（含今天）" */
export const DEFAULT_WINDOW_DAYS = 30;

/** `overdueKind` 取值（与 `SlaOverdueFact.kind` 逐字一致） */
export const OVERDUE_KINDS = ['acceptance', 'appointment', 'store_confirm'] as const;
export type OverdueKind = (typeof OVERDUE_KINDS)[number];

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

export interface ReportWindow {
  /** 规范化后的日期区间（`YYYY-MM-DD`，**两端都含**） */
  from: string;
  to: string;
  /** 实际使用的半开区间边界（ISO +08:00）—— 口径自证 */
  fromIso: string;
  toIso: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function offsetMs(): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(APPOINTMENT_TIMEZONE_OFFSET);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

/** 该时刻在 **Asia/Shanghai** 的日历日期（`YYYY-MM-DD`） */
export function localDateOf(at: Date): string {
  return new Date(at.getTime() + offsetMs()).toISOString().slice(0, 10);
}

/** 日期字符串 + n 天（纯日历运算，不涉及时区） */
export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → 当地当天 00:00:00.000（+08:00） */
function localDayStart(date: string): Date {
  const at = new Date(`${date}T00:00:00.000${APPOINTMENT_TIMEZONE_OFFSET}`);
  if (Number.isNaN(at.getTime())) {
    throw new ValidationError('INVALID_DATE_RANGE', `无法解析日期：${date}`);
  }
  return at;
}

/** 单个边界：日期形态（按天）或精确时刻形态 */
function parseBound(raw: string, field: 'from' | 'to'): { at: Date; exact: boolean } {
  if (DATE_ONLY.test(raw)) return { at: localDayStart(raw), exact: false };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new ValidationError(
      'INVALID_DATE_RANGE',
      `${field} 必须是 YYYY-MM-DD 或合法 ISO 时刻（实际 ${JSON.stringify(raw)}）`,
    );
  }
  return { at, exact: true };
}

/** 规范化日期窗口（缺省 = 最近 30 天）。非法一律 422，不静默兜底。 */
export function normalizeWindow(fromRaw: unknown, toRaw: unknown, now: Date): ReportWindow {
  const today = localDateOf(now);

  const toRawText = isBlank(toRaw) ? today : String(toRaw).trim();
  const fromRawText = isBlank(fromRaw) ? addDays(toRawText, -(DEFAULT_WINDOW_DAYS - 1)) : String(fromRaw).trim();

  const from = parseBound(fromRawText, 'from');
  const to = parseBound(toRawText, 'to');

  // ⚠️ 日期形态 ⇒ 上界取 to 的**次日** 00:00（见文件头）；精确时刻形态 ⇒ 原样。
  const toExclusive = to.exact ? to.at : localDayStart(addDays(localDateOf(to.at), 1));
  const fromInclusive = from.at;

  if (fromInclusive.getTime() >= toExclusive.getTime()) {
    throw new ValidationError(
      'INVALID_DATE_RANGE',
      `from 必须早于 to（解析结果 ${fromInclusive.toISOString()} → ${toExclusive.toISOString()}）`,
    );
  }

  return {
    from: localDateOf(fromInclusive),
    to: localDateOf(new Date(toExclusive.getTime() - 1)),
    fromIso: fromInclusive.toISOString(),
    toIso: toExclusive.toISOString(),
  };
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

// ---------------------------------------------------------------------------
// 过滤维度
// ---------------------------------------------------------------------------

export interface ReportFilters {
  storeId?: number;
  ticketType?: string;
  status?: string;
  serviceMode?: string;
  ratingMin?: number;
}

/** 取出并**逐个校验**筛选维度（非法一律 422，不静默忽略成"没筛"） */
export function readFilters(raw: {
  storeId?: unknown;
  ticketType?: unknown;
  status?: unknown;
  serviceMode?: unknown;
  ratingMin?: unknown;
}): ReportFilters {
  const filters: ReportFilters = {};

  const storeId = optionalInt(raw.storeId, 'storeId');
  if (storeId !== undefined) filters.storeId = storeId;

  const ticketType = optionalEnum(raw.ticketType, 'ticketType', TICKET_TYPE_VALUES);
  if (ticketType !== undefined) filters.ticketType = ticketType;

  const status = optionalEnum(raw.status, 'status', TICKET_STATUS_VALUES);
  if (status !== undefined) filters.status = status;

  const serviceMode = optionalEnum(raw.serviceMode, 'serviceMode', SERVICE_MODE_VALUES);
  if (serviceMode !== undefined) filters.serviceMode = serviceMode;

  const ratingMin = optionalInt(raw.ratingMin, 'ratingMin');
  if (ratingMin !== undefined) filters.ratingMin = ratingMin;

  return filters;
}

function optionalInt(raw: unknown, field: string): number | undefined {
  if (isBlank(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError('INVALID_FILTER', `${field} 必须是整数（实际 ${JSON.stringify(raw)}）`);
  }
  return value;
}

function optionalEnum(raw: unknown, field: string, allowed: readonly string[]): string | undefined {
  if (isBlank(raw)) return undefined;
  const value = String(raw).trim();
  if (!allowed.includes(value)) {
    throw new ValidationError(
      'INVALID_FILTER',
      `${field} 非法（允许 ${allowed.join(' / ')}，实际 ${JSON.stringify(raw)}）`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// SQL 构造
// ---------------------------------------------------------------------------

/**
 * 极简 WHERE 构造器。
 *
 * ⚠️ 只接受**位置参数模板**（模板里的 `?` 顺序替换成 `$1,$2…`），值一律绑定 ——
 *    本文件里**不存在**任何字符串拼接出来的值。理由不是洁癖：报表的筛选维度
 *    全部来自 query string，拼字符串就是 SQL 注入。
 */
class SqlBuilder {
  private readonly conditions: string[] = [];
  private readonly binds: unknown[] = [];
  private frozen = 0;

  /** 追加一个条件（模板里的 `?` 按顺序绑定） */
  add(template: string, ...values: unknown[]): void {
    let index = this.binds.length;
    const sql = template.replace(/\?/g, () => `$${++index}`);
    this.binds.push(...values);
    this.conditions.push(sql);
  }

  /**
   * 冻结"WHERE 段"的绑定数。
   *
   * ⚠️ 为什么必须有这一步：CTE 的 WHERE 用 `$1..$k`，而外面每条 SELECT 又各自追加
   *    参数。**每条查询只能拿到自己的绑定** —— 把用不到的多余参数一并发给
   *    Postgres 会直接报
   *    `bind message supplies N parameters, but prepared statement requires M`
   *    （参数化查询里"多给的绑定"不是宽容，是错误）。
   *    所以：WHERE 段用 `whereBinds`，每条 SELECT 用 `resetLocal()` 重新开始编号，
   *    再用 `localBinds` 取它自己那几个。
   */
  freeze(): void {
    this.frozen = this.binds.length;
  }

  /** 丢弃上一条查询的局部参数，让下一条的编号继续从 `$k+1` 开始 */
  resetLocal(): void {
    this.binds.length = this.frozen;
  }

  /** 追加一个**局部**绑定（用于 CTE 之外的 SELECT 表达式），返回其占位符 */
  param(value: unknown): string {
    this.binds.push(value);
    return `$${this.binds.length}`;
  }

  get where(): string {
    return this.conditions.length > 0 ? this.conditions.join(' AND ') : 'TRUE';
  }

  get whereBinds(): unknown[] {
    return this.binds.slice(0, this.frozen);
  }

  get localBinds(): unknown[] {
    return this.binds.slice(this.frozen);
  }
}

/**
 * 把 `applyScope()` 的产出翻译成 SQL 条件。
 *
 * ⚠️ 为什么消费的是 **`applyScope` 的返回值**而不是自己判角色：
 *    看板的数据裁剪必须与导出（`svc:exportTickets`）**同源**，否则会出现
 *    "看板看得见、导出导不出"（或反过来）的漂移。`applyScope` 产出的是
 *    NocoBase filter 对象（聚合 SQL 用不了），所以这里只做**形态翻译**，
 *    判定仍然全部来自它：
 *      · `{id: -1}`              → `FALSE`（none / 请求了未授权门店）
 *      · `{store_id: {$in:[…]}}` → `store_id = ANY($n::int[])`
 *      · 标量 `store_id`         → 等值条件
 */
function applyScopeToSql(
  permissions: PermissionService,
  actor: Actor,
  builder: SqlBuilder,
  storeId?: number,
): void {
  const scoped = permissions.applyScope(actor, storeId !== undefined ? { store_id: storeId } : {}) as any;

  if (Number(scoped?.id) === -1) {
    builder.add('FALSE');
    return;
  }

  const store = scoped?.store_id;
  if (store === undefined || store === null) return;

  if (typeof store === 'object' && Array.isArray(store.$in)) {
    const ids = store.$in.map(Number).filter((n: number) => Number.isFinite(n));
    if (ids.length === 0) {
      builder.add('FALSE');
      return;
    }
    builder.add('store_id = ANY(?::int[])', ids);
    return;
  }

  const scalar = Number(store);
  if (!Number.isFinite(scalar)) {
    builder.add('FALSE');
    return;
  }
  builder.add('store_id = ?', scalar);
}

/** 窗口 + 范围 + 筛选维度 ⇒ 样本工单集 */
function buildSample(
  permissions: PermissionService,
  actor: Actor,
  window: ReportWindow,
  filters: ReportFilters,
): SqlBuilder {
  const builder = new SqlBuilder();
  builder.add('created_at >= ?::timestamptz', window.fromIso);
  builder.add('created_at < ?::timestamptz', window.toIso);

  applyScopeToSql(permissions, actor, builder, filters.storeId);

  if (filters.ticketType !== undefined) builder.add('ticket_type = ?', filters.ticketType);
  if (filters.status !== undefined) builder.add('status = ?', filters.status);
  if (filters.serviceMode !== undefined) builder.add('service_mode = ?', filters.serviceMode);
  if (filters.ratingMin !== undefined) {
    // `ratingMin` = "只看评分 ≥ N 的工单"。未评分（NULL）不满足 —— 显式写出来，
    // 免得"NULL 参与比较得 NULL ⇒ 被静默丢掉"这层隐含语义没人知道。
    builder.add('rating IS NOT NULL AND rating >= ?', filters.ratingMin);
  }

  builder.freeze();
  return builder;
}

/**
 * 对**外部**（`export-service.ts`）暴露的窗口 + 范围 + 筛选 ⇒ WHERE 片段。
 *
 * ⚠️ 为什么要暴露：看板、报表、导出三处的"哪些工单算在内"必须**逐字相同**
 *    （契约 §7 明确要求"导出字段与筛选条件对齐"）。让导出自己再写一遍
 *    `applyScope + created_at 区间`，就等于把"范围裁剪"这条安全边界复制成两份 ——
 *    而两份迟早会漂移，且漂移方向通常是"导出那份更松"。
 */
export function buildTicketScope(
  permissions: PermissionService,
  actor: Actor,
  window: ReportWindow,
  filters: ReportFilters,
): { where: string; binds: unknown[] } {
  const builder = buildSample(permissions, actor, window, filters);
  return { where: builder.where, binds: builder.whereBinds };
}

const SAMPLE_CTE = `WITH sample AS (
  SELECT id, ticket_no, status, store_id, service_mode, ticket_type,
         created_at, first_response_at, closed_at,
         review_status, rating, reopen_count
    FROM service_tickets
   WHERE `;

async function queryRows(db: any, sql: string, binds: unknown[]): Promise<any[]> {
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw new Error('[report] db.sequelize.query 不可用');
  }
  const [rows] = (await sequelize.query(sql, { bind: binds })) as [unknown, unknown];
  return Array.isArray(rows) ? (rows as any[]) : [];
}

// ---------------------------------------------------------------------------
// KPI 通用工具
// ---------------------------------------------------------------------------

export type KpiUnit = 'minutes' | 'ratio' | 'score' | 'count' | 'CNY';

export interface KpiItem {
  key: string;
  label: string;
  /** 指标值；**无样本时是 `null`，不是 0**（理由见 `ratio()`） */
  value: number | null;
  unit: KpiUnit;
  /** 分母（契约 §6：每项必须带分母，口径才能自证） */
  denominator: number;
  /** 口径基准：恒为 `field`（DB 字段口径，契约 §4 C3） */
  basis: typeof KPI_BASIS_FIELD;
  /** 来源字段（写出来，方便报表被人核对；"注释不是证据"的反面：这里给的是可复算的字段名） */
  source: string;
  /** 补充事实：子口径、被排除条数、分布明细等 */
  extra?: Record<string, unknown>;
}

/**
 * 🔴 **分母为 0 时返回 `null`，不是 `0`**。
 *
 * 这是本项目 DEV-89（`Number(null) === 0`）那条教训在报表上的同类形态：
 * "本月没有评价"与"本月评价全是差评（低分率 100%）"在 UI 上必须长得不一样，
 * `0` 会让前者被渲染成"0%"，与"确实是 0%"无法区分。
 * ⇒ 统一：**没有样本 ⇒ null**（前端渲染成"—"）。
 */
function ratio(numerator: number, denominator: number, digits = 4): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return round(numerator / denominator, digits);
}

function round(value: unknown, digits: number): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function secondsToMinutes(seconds: unknown, digits = 1): number | null {
  const num = Number(seconds);
  if (!Number.isFinite(num)) return null;
  return round(num / 60, digits);
}

function intOf(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

const KPI_LABELS = {
  FIRST_RESPONSE: '首次响应时长',
  CLOSE_DURATION: '闭环时长',
  ACCEPTANCE_OVERDUE_RATE: '待受理超时率',
  APPOINTMENT_OVERDUE: '预约逾期未回执数',
  STORE_PENDING: '待门店处置数',
  REVIEW_PARTICIPATION: '评价参与率',
  AVG_RATING: '平均评分',
  REOPEN_RATE: '重开率',
  SMS_SUBMIT_SUCCESS: '短信提交成功率',
  CONFIRMED_CHARGE: '确认收费金额',
  SERVICE_MODE_DIST: '处理方式分布',
  CHARGE_MISMATCH: '收费不一致率',
} as const;

/** 12 项的 key 清单（唯一事实来源；门禁断言它恰好 12 项且顺序稳定） */
export const KPI_KEYS: string[] = [
  'firstResponseMinutes',
  'closeDurationMinutes',
  'acceptanceOverdueRate',
  'appointmentOverdueCount',
  'storePendingCount',
  'reviewParticipationRate',
  'avgRating',
  'reopenRate',
  'smsSubmitSuccessRate',
  'confirmedChargeAmount',
  'serviceModeDistribution',
  'chargeMismatchRate',
];

export interface KpiResult {
  window: ReportWindow;
  filters: ReportFilters;
  kpis: KpiItem[];
  /** 样本工单数（12 个数字的共同参照；比率型分母的上界） */
  sampleSize: number;
}

// ---------------------------------------------------------------------------
// I16 —— 报表 KPI
// ---------------------------------------------------------------------------

/**
 * 12 项 KPI（契约 §3 逐行实现；口径变更必须先改契约）。
 *
 * 样本集合 = **窗口内工单（`created_at` 落在窗口）∩ actor 范围 ∩ 筛选维度**；
 * 关联的 Visit / 评价字段 / 短信记录都通过该集合限定
 * ⇒ 同一份报表里 12 个数字的分母是同一个"这批工单"，不会各算各的。
 */
export async function reportKpi(
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
    now?: Date;
  },
): Promise<KpiResult> {
  const now = params.now ?? new Date();
  const window = normalizeWindow(params.from, params.to, now);
  const filters = readFilters(params);

  const builder = buildSample(deps.permissions, actor, window, filters);
  const cte = `${SAMPLE_CTE}${builder.where})`;
  const lowThreshold = await readLowScore(deps);

  /**
   * 开一条查询的局部参数：**重置编号**并返回这组值的占位符。
   *
   * ⚠️ 占位符必须先算好、再拼进模板字符串。写成 `$${builder.localBinds.length}`
   *    这种"拼到一半再回头数下标"的写法，会在**同一个模板里出现两次且中间又 push 了新参数**
   *    时静默错位（曾在本文件初稿里踩到：`reopen_count` 那一段引用了错误的 `$n`）。
   */
  const useParams = (...values: unknown[]): string[] => {
    builder.resetLocal();
    return values.map((value) => builder.param(value));
  };
  const bindsOf = (): unknown[] => [...builder.whereBinds, ...builder.localBinds];

  // ---- ① 工单侧：样本量 / 首响 / 闭环 / 评价 / 重开 ----
  const [pCancelled, pClosed, pSubmitted, pLowScore] = useParams(
    TICKET_STATUS.CANCELLED,
    TICKET_STATUS.CLOSED,
    REVIEW_STATUS.SUBMITTED,
    lowThreshold,
  );
  const [ticketAgg] = await queryRows(
    deps.db,
    `${cte}
     SELECT
       COUNT(*)::int AS tickets,
       COUNT(*) FILTER (WHERE status <> ${pCancelled})::int AS not_cancelled_n,
       COUNT(*) FILTER (WHERE first_response_at IS NOT NULL)::int AS fr_n,
       AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)))
         FILTER (WHERE first_response_at IS NOT NULL) AS fr_avg_s,
       COUNT(*) FILTER (WHERE status = ${pClosed})::int AS closed_n,
       COUNT(*) FILTER (WHERE status = ${pClosed} AND closed_at IS NOT NULL)::int AS closed_ts_n,
       AVG(EXTRACT(EPOCH FROM (closed_at - created_at)))
         FILTER (WHERE status = ${pClosed} AND closed_at IS NOT NULL) AS cd_avg_s,
       COUNT(*) FILTER (WHERE review_status IS NOT NULL)::int AS invited_n,
       COUNT(*) FILTER (WHERE review_status = ${pSubmitted})::int AS submitted_n,
       COUNT(*) FILTER (WHERE review_status = ${pSubmitted} AND rating IS NOT NULL)::int AS rated_n,
       AVG(rating) FILTER (WHERE review_status = ${pSubmitted} AND rating IS NOT NULL) AS avg_rating,
       COUNT(*) FILTER (
         WHERE review_status = ${pSubmitted} AND rating IS NOT NULL AND rating <= ${pLowScore}
       )::int AS low_rating_n,
       COUNT(*) FILTER (WHERE review_status = ${pSubmitted} AND reopen_count > 0)::int AS reopened_n
     FROM sample`,
    bindsOf(),
  );

  // ---- ② 处理方式分布（无局部参数）----
  //
  // ⚠️ 这里**必须**显式 `useParams()` 清空局部绑定 —— 它一条也不引用。
  //    若直接复用上一条查询留下的 `builder.localBinds`，传给 Postgres 的参数
  //    会比语句里出现的占位符**多**，而参数化查询对"多给的绑定"不是宽容而是报错：
  //    `bind message supplies 4 parameters, but prepared statement "" requires 0`。
  //    `useParams()` 就是把局部编号归零 —— 空参数调用是它的合法用法。
  useParams();
  const modeRows = await queryRows(
    deps.db,
    `${cte} SELECT service_mode, COUNT(*)::int AS n FROM sample
      GROUP BY service_mode ORDER BY n DESC, service_mode ASC`,
    bindsOf(),
  );

  // ---- ③ Visit 侧：处置时长 / 收费金额 / 收费一致性 ----
  const [pMatch, pMismatch] = useParams(CHARGE_MATCH.MATCH, CHARGE_MATCH.MISMATCH);
  const [visitAgg] = await queryRows(
    deps.db,
    `${cte}
     SELECT
       COUNT(*) FILTER (WHERE v.store_confirmed_at IS NOT NULL)::int AS handled_n,
       AVG(EXTRACT(EPOCH FROM (v.store_confirmed_at - v.submitted_at)))
         FILTER (WHERE v.store_confirmed_at IS NOT NULL AND v.submitted_at IS NOT NULL) AS handle_avg_s,
       COUNT(*) FILTER (WHERE v.customer_charge_match IN (${pMatch}, ${pMismatch}))::int AS charge_decided_n,
       COUNT(*) FILTER (WHERE v.customer_charge_match = ${pMismatch})::int AS mismatch_n,
       COALESCE(SUM(v.confirmed_charge_amount) FILTER (WHERE v.is_charged = true), 0) AS charged_sum
     FROM sample s
     JOIN service_visits v ON v.ticket_id = s.id`,
    bindsOf(),
  );

  // ---- ④ 短信侧：提交成功率（**不是**送达率 —— 契约 §4 C4 / DEV-93）----
  const [pAccepted, pRejected, pError] = useParams(
    SMS_SEND_STATUS.ACCEPTED,
    SMS_SEND_STATUS.REJECTED,
    SMS_SEND_STATUS.ERROR,
  );
  const [smsAgg] = await queryRows(
    deps.db,
    `${cte}
     SELECT
       COUNT(*) FILTER (WHERE l.send_status IN (${pAccepted}, ${pRejected}, ${pError}))::int AS submitted_n,
       COUNT(*) FILTER (WHERE l.send_status = ${pAccepted})::int AS accepted_n
     FROM sample s
     JOIN sms_logs l ON l.ticket_id = s.id`,
    bindsOf(),
  );

  // ---- ⑤ 超时（**只消费 Phase 8**）----
  const sla = await runSlaScanQuiet(deps, DETAIL_FETCH_FLOOR, now);

  const tickets = intOf(ticketAgg?.tickets);
  const notCancelled = intOf(ticketAgg?.not_cancelled_n);
  const closedN = intOf(ticketAgg?.closed_n);
  const invitedN = intOf(ticketAgg?.invited_n);
  const submittedN = intOf(ticketAgg?.submitted_n);
  const ratedN = intOf(ticketAgg?.rated_n);
  const frN = intOf(ticketAgg?.fr_n);

  const modeDistribution: Record<string, number> = {};
  for (const row of modeRows) {
    modeDistribution[String(row.service_mode ?? 'unknown')] = intOf(row.n);
  }

  const kpis: KpiItem[] = [
    {
      key: 'firstResponseMinutes',
      label: KPI_LABELS.FIRST_RESPONSE,
      value: secondsToMinutes(ticketAgg?.fr_avg_s),
      unit: 'minutes',
      denominator: frN,
      basis: KPI_BASIS_FIELD,
      source: 'service_tickets.first_response_at - created_at',
      extra: { excluded: tickets - frN, excludedReason: 'first_response_at IS NULL' },
    },
    {
      key: 'closeDurationMinutes',
      label: KPI_LABELS.CLOSE_DURATION,
      value: secondsToMinutes(ticketAgg?.cd_avg_s),
      unit: 'minutes',
      denominator: closedN,
      basis: KPI_BASIS_FIELD,
      source: 'service_tickets.closed_at - created_at',
      extra: {
        closedWithTimestamp: intOf(ticketAgg?.closed_ts_n),
        // ⚠️ 取消也写 closed_at（ticket-service.ts:1043）⇒ 分母**必须**限定 status='CLOSED'，
        //    否则"取消"会混进闭环时长（契约 §3 #2）。
        excludedOtherStatus: tickets - closedN,
      },
    },
    {
      key: 'acceptanceOverdueRate',
      label: KPI_LABELS.ACCEPTANCE_OVERDUE_RATE,
      value: ratio(sla.acceptanceOverdue, notCancelled),
      unit: 'ratio',
      denominator: notCancelled,
      basis: KPI_BASIS_FIELD,
      source: 'SLA_SOURCE.acceptance（Phase 8 单一事实源）',
      extra: {
        numerator: sla.acceptanceOverdue,
        acceptMinutes: sla.thresholds.acceptMinutes,
        numeratorScope: 'global-current',
        // 这条 caveat 必须留着：分子是"当前状态"，分母是"窗口建单" —— 两者时间基准
        // 在窗口 != 至今时不同。写出来，免得下一个人把它当 bug 改成第二套谓词。
        caveat:
          '分子是**当前全量**超时计数（Phase 8 单一事实源，不允许按窗口/按角色另算第二套谓词），' +
          '分母是窗口内建单数；窗口不是"至今"时两者时间基准不同，属已知口径。',
      },
    },
    {
      key: 'appointmentOverdueCount',
      label: KPI_LABELS.APPOINTMENT_OVERDUE,
      value: sla.appointmentOverdue,
      unit: 'count',
      // 计数型指标没有分母（契约 §3 #4 明写「—（计数）」）
      denominator: 0,
      basis: KPI_BASIS_FIELD,
      source: 'SLA_SOURCE.appointment（DEV-71 日期语义 + grace）',
      extra: {
        graceMinutes: sla.thresholds.graceMinutes,
        activeTicketStatuses: APPOINTMENT_ACTIVE_TICKET_STATUSES,
        caveat:
          '`expected_visit_at` 的业务语义只到天，禁止用 `expected_visit_at < now` 复算（DEV-71 / DEV-94）',
      },
    },
    {
      key: 'storePendingCount',
      label: KPI_LABELS.STORE_PENDING,
      value: sla.storeConfirmOverdue,
      unit: 'count',
      denominator: 0,
      basis: KPI_BASIS_FIELD,
      source: 'SLA_SOURCE.storeConfirm（Visit 侧）',
      extra: {
        // 「待门店**处置**」含确认与驳回（契约 §4 C2）：`store_confirmed_at` 在两条路径
        // 上都会写（visit-service.ts:641 确认 / :696 驳回），所以口径不能只叫"确认"。
        handleMinutes: secondsToMinutes(visitAgg?.handle_avg_s),
        handledDenominator: intOf(visitAgg?.handled_n),
        storeConfirmHours: sla.thresholds.storeConfirmHours,
      },
    },
    {
      key: 'reviewParticipationRate',
      label: KPI_LABELS.REVIEW_PARTICIPATION,
      value: ratio(submittedN, invitedN),
      unit: 'ratio',
      denominator: invitedN,
      basis: KPI_BASIS_FIELD,
      source: 'service_tickets.review_status',
      extra: {
        numerator: submittedN,
        note:
          '分母取"已发出邀约（review_status IS NOT NULL）"而非"曾进入 WAIT_FEEDBACK（事件口径）" —— ' +
          '契约 §3 可复议项，当前先冻结。',
      },
    },
    {
      key: 'avgRating',
      label: KPI_LABELS.AVG_RATING,
      value: round(ticketAgg?.avg_rating, 2),
      unit: 'score',
      denominator: ratedN,
      basis: KPI_BASIS_FIELD,
      source: 'service_tickets.rating（review_status=submitted）',
      extra: {
        lowRatingRate: ratio(intOf(ticketAgg?.low_rating_n), ratedN),
        lowRatingThreshold: lowThreshold,
        lowRatingNumerator: intOf(ticketAgg?.low_rating_n),
      },
    },
    {
      key: 'reopenRate',
      label: KPI_LABELS.REOPEN_RATE,
      value: ratio(intOf(ticketAgg?.reopened_n), submittedN),
      unit: 'ratio',
      denominator: submittedN,
      basis: KPI_BASIS_FIELD,
      source: 'service_tickets.reopen_count（唯一自增点 ticket-service.ts:2598）',
      extra: {
        numerator: intOf(ticketAgg?.reopened_n),
        note:
          '分母取"已提交评价"而非"所有发过邀约的工单"（后者含 expired，会稀释重开率）—— ' +
          '契约 §3 可复议项，当前先冻结。',
      },
    },
    {
      key: 'smsSubmitSuccessRate',
      label: KPI_LABELS.SMS_SUBMIT_SUCCESS,
      value: ratio(intOf(smsAgg?.accepted_n), intOf(smsAgg?.submitted_n)),
      unit: 'ratio',
      denominator: intOf(smsAgg?.submitted_n),
      basis: KPI_BASIS_FIELD,
      source: 'sms_logs.send_status',
      extra: {
        numerator: intOf(smsAgg?.accepted_n),
        // 🔴 这段必须留着：它解释了为什么**没有**送达率。
        note:
          '本项是**提交成功率**（供应商已受理），不是送达率：`delivery_status` 在代码里恒为 pending' +
          '（无回执入口，且 `sms-provider.ts:54` 在类型层禁止声称 delivered）⇒ DEV-93。',
      },
    },
    {
      key: 'confirmedChargeAmount',
      label: KPI_LABELS.CONFIRMED_CHARGE,
      value: round(visitAgg?.charged_sum, 2),
      unit: 'CNY',
      denominator: 0,
      basis: KPI_BASIS_FIELD,
      source: 'service_visits.confirmed_charge_amount（is_charged=true）',
      extra: {
        isChargedOnly: true,
        note: '金额列在 service_visits，不在 service_tickets ⇒ 必须 join Visit',
      },
    },
    {
      key: 'serviceModeDistribution',
      label: KPI_LABELS.SERVICE_MODE_DIST,
      value: tickets,
      unit: 'count',
      denominator: tickets,
      basis: KPI_BASIS_FIELD,
      source: 'service_tickets.service_mode',
      extra: { distribution: modeDistribution, distinctModes: Object.keys(modeDistribution).length },
    },
    {
      key: 'chargeMismatchRate',
      label: KPI_LABELS.CHARGE_MISMATCH,
      value: ratio(intOf(visitAgg?.mismatch_n), intOf(visitAgg?.charge_decided_n)),
      unit: 'ratio',
      denominator: intOf(visitAgg?.charge_decided_n),
      basis: KPI_BASIS_FIELD,
      source: 'service_visits.customer_charge_match',
      extra: {
        numerator: intOf(visitAgg?.mismatch_n),
        note: '分母**排除** not_applicable（未涉及收费的 Visit 不该进分母）',
      },
    },
  ];

  return { window, filters, kpis, sampleSize: tickets };
}

// ---------------------------------------------------------------------------
// I15 —— HQ 看板
// ---------------------------------------------------------------------------

export interface DashboardTotals {
  tickets: number;
  new: number;
  processing: number;
  waitStoreConfirm: number;
  waitFeedback: number;
  closed: number;
  cancelled: number;
}

export interface DashboardOverdue {
  acceptance: number;
  appointment: number;
  storeConfirm: number;
  scannedAt: string;
  thresholds: SlaScanResult['thresholds'];
  /**
   * ⚠️ 这三个计数是**全局当前事实**（契约 §5：不得另写谓词）。
   * 显式标出来，免得门店角色以为"这些数字是我的店的"。
   */
  countsScope: 'global';
}

export interface DashboardOverdueDetail {
  kind: OverdueKind;
  page: number;
  pageSize: number;
  /** 可见总数；global actor 为精确值（同 SLA 计数），其余为"可见条数下界" */
  total: number;
  totalBasis: 'sla-count' | 'visible-items';
  /** 取数已顶到上限 ⇒ 可能还有更多（客户端据此提示"细化筛选"而不是"就这么多"） */
  capped: boolean;
  items: SlaOverdueFact[];
}

export interface DashboardResult {
  window: ReportWindow;
  filters: ReportFilters;
  totals: DashboardTotals;
  overdue: DashboardOverdue;
  overdueDetail?: DashboardOverdueDetail;
  breakdown: {
    serviceMode: Record<string, number>;
    store: Record<string, number>;
  };
}

/**
 * HQ 看板聚合（I15）。
 *
 * 鉴权：**已登录即可**；数据范围由 `applyScope` 裁剪（ACL 没有数据维度）。
 * 越权不在这里判 —— 门店角色天然只查得到本店（`applyScope` 注入 filter），
 * 且明细再按范围过滤一遍（`filterFactsByScope`）。
 */
export async function dashboardSummary(
  deps: ReportDeps,
  actor: Actor,
  params: {
    from?: unknown;
    to?: unknown;
    storeId?: unknown;
    ticketType?: unknown;
    serviceMode?: unknown;
    ratingMin?: unknown;
    overdueKind?: unknown;
    page?: unknown;
    pageSize?: unknown;
    now?: Date;
  },
): Promise<DashboardResult> {
  const now = params.now ?? new Date();
  const window = normalizeWindow(params.from, params.to, now);
  const filters = readFilters(params);

  const builder = buildSample(deps.permissions, actor, window, filters);
  const cte = `${SAMPLE_CTE}${builder.where})`;

  // 一次往返拿三个维度的分组（status / service_mode / store）
  const dimRows = await queryRows(
    deps.db,
    `${cte}
     SELECT 'status' AS dim, status::text AS key, COUNT(*)::int AS n FROM sample GROUP BY status
     UNION ALL
     SELECT 'service_mode' AS dim, service_mode::text AS key, COUNT(*)::int AS n FROM sample GROUP BY service_mode
     UNION ALL
     SELECT 'store' AS dim, store_id::text AS key, COUNT(*)::int AS n FROM sample GROUP BY store_id`,
    builder.whereBinds,
  );

  const counts: Record<string, number> = {};
  const serviceMode: Record<string, number> = {};
  const store: Record<string, number> = {};
  let tickets = 0;

  for (const row of dimRows) {
    const n = intOf(row.n);
    const key = String(row.key ?? 'unknown');
    if (row.dim === 'status') {
      counts[key] = n;
      tickets += n;
    } else if (row.dim === 'service_mode') {
      serviceMode[key] = n;
    } else {
      store[key] = n;
    }
  }

  // ⚠️ 超时数字：**直接取 Phase 8 产出**，本文件不写任何 overdue 谓词。
  const sla = await runSlaScanQuiet(deps, DETAIL_FETCH_FLOOR, now);

  const result: DashboardResult = {
    window,
    filters,
    totals: {
      tickets,
      new: counts[TICKET_STATUS.NEW] ?? 0,
      processing: counts[TICKET_STATUS.PROCESSING] ?? 0,
      waitStoreConfirm: counts[TICKET_STATUS.WAIT_STORE_CONFIRM] ?? 0,
      waitFeedback: counts[TICKET_STATUS.WAIT_FEEDBACK] ?? 0,
      closed: counts[TICKET_STATUS.CLOSED] ?? 0,
      cancelled: counts[TICKET_STATUS.CANCELLED] ?? 0,
    },
    overdue: {
      acceptance: sla.acceptanceOverdue,
      appointment: sla.appointmentOverdue,
      storeConfirm: sla.storeConfirmOverdue,
      scannedAt: sla.scannedAt,
      thresholds: sla.thresholds,
      countsScope: 'global',
    },
    breakdown: { serviceMode, store },
  };

  const kind = readOverdueKind(params.overdueKind);
  if (kind) {
    const page = positiveIntOrDefault(params.page, 1);
    const pageSize = clampPageSize(params.pageSize);
    const scope = deps.permissions.scopeOf(actor);

    // 契约 §5：`detailLimit = (page-1)*pageSize + pageSize`（再抬一个下限）。
    const fetchLimit = Math.max((page - 1) * pageSize + pageSize, DETAIL_FETCH_FLOOR);
    const facts = await buildOverdueDetail(deps, kind, fetchLimit, now, sla);

    const visible = await filterFactsByScope(deps.db, facts, scope);
    const offset = (page - 1) * pageSize;

    const exact = slaTotalOf(sla, kind);
    const totalIsExact = scope.kind === 'all';

    result.overdueDetail = {
      kind,
      page,
      pageSize,
      total: totalIsExact ? exact : visible.length,
      totalBasis: totalIsExact ? 'sla-count' : 'visible-items',
      capped: visible.length >= fetchLimit,
      items: visible.slice(offset, offset + pageSize),
    };
  }

  return result;
}

function slaTotalOf(sla: SlaScanResult, kind: OverdueKind): number {
  if (kind === 'acceptance') return sla.acceptanceOverdue;
  if (kind === 'appointment') return sla.appointmentOverdue;
  return sla.storeConfirmOverdue;
}

function readOverdueKind(raw: unknown): OverdueKind | null {
  if (isBlank(raw)) return null;
  const value = String(raw).trim();
  if (!(OVERDUE_KINDS as readonly string[]).includes(value)) {
    throw new ValidationError(
      'INVALID_FILTER',
      `overdueKind 非法（允许 ${OVERDUE_KINDS.join(' / ')}，实际 ${JSON.stringify(raw)}）`,
    );
  }
  return value as OverdueKind;
}

function positiveIntOrDefault(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function clampPageSize(raw: unknown): number {
  return Math.min(positiveIntOrDefault(raw, DASHBOARD_PAGE_SIZE_DEFAULT), DASHBOARD_PAGE_SIZE_MAX);
}

/**
 * 构造某一类 overdue 的明细。
 *
 * 三条分支都只走 Phase 8 的 port / 纯函数 / 状态白名单 —— 本函数**没有**任何
 * 自己写的超时条件（契约 §2「全仓不得出现第二处谓词」的落点）。
 */
async function buildOverdueDetail(
  deps: ReportDeps,
  kind: OverdueKind,
  limit: number,
  now: Date,
  sla: SlaScanResult,
): Promise<SlaOverdueFact[]> {
  const rows: SlaOverdueFact[] = [];

  if (kind === 'acceptance') {
    const before = new Date(now.getTime() - sla.thresholds.acceptMinutes * 60_000);
    const list = await deps.slaPort.listAcceptanceOverdue(before, limit);
    for (const row of list) {
      rows.push({
        kind: 'acceptance',
        ticketId: row.id,
        ticketNo: row.ticket_no || null,
        visitId: null,
        dueFrom: before.toISOString(),
      });
    }
  } else if (kind === 'store_confirm') {
    const before = new Date(now.getTime() - sla.thresholds.storeConfirmHours * 3600_000);
    const list = await deps.slaPort.listStoreConfirmOverdue(before, limit);
    for (const row of list) {
      rows.push({
        kind: 'store_confirm',
        ticketId: row.ticketId,
        ticketNo: row.ticketNo,
        visitId: row.visitId,
        dueFrom: before.toISOString(),
      });
    }
  } else {
    // appointment：候选（粗筛）→ `appointmentOverdueFrom` 精判 → 终态谓词。
    // 与 `runSlaScan` 第三步**同一套调用顺序**（同一 port 方法、同一纯函数）。
    const yesterdayEnd = endOfLocalDay(new Date(now.getTime() - 24 * 3600_000));
    const candidates = await deps.slaPort.listAppointmentCandidates(
      APPOINTMENT_ACTIVE_TICKET_STATUSES,
      yesterdayEnd,
      now,
      Math.max(limit * 4, DETAIL_FETCH_FLOOR),
    );
    for (const row of candidates) {
      if (rows.length >= limit) break;
      const dueFrom = appointmentOverdueFrom(row.expected_visit_at, sla.thresholds.graceMinutes);
      if (!dueFrom) continue;
      if (dueFrom.getTime() >= now.getTime()) continue;
      if (await deps.slaPort.hasConfirmedVisit(row.id)) continue;
      rows.push({
        kind: 'appointment',
        ticketId: row.id,
        ticketNo: row.ticket_no || null,
        visitId: null,
        dueFrom: dueFrom.toISOString(),
      });
    }
  }

  return sortFacts(rows);
}

/**
 * 按 actor 范围过滤明细。
 *
 * ⚠️ 为什么必须做：`SlaOverdueFact` **不含 store_id**（Phase 8 冻结形态），
 *    所以这里补一次查表。不做的话，门店角色能通过明细看到**别店工单号**
 *    —— 那正是 `AT-15.7`「越权样本必须为空」要挡的。
 */
async function filterFactsByScope(
  db: any,
  facts: SlaOverdueFact[],
  scope: DataScope,
): Promise<SlaOverdueFact[]> {
  if (scope.kind === 'all') return facts;
  if (scope.kind === 'none') return [];
  if (facts.length === 0) return [];

  const allowed = new Set(scope.storeIds);
  const ids = [...new Set(facts.map((fact) => fact.ticketId))];
  const rows = await queryRows(
    db,
    'SELECT id, store_id FROM service_tickets WHERE id = ANY($1::int[])',
    [ids],
  );
  const storeOf = new Map<number, number>();
  for (const row of rows) storeOf.set(Number(row.id), Number(row.store_id));

  return facts.filter((fact) => allowed.has(storeOf.get(fact.ticketId) ?? -1));
}

/**
 * 明细排序（**确定性**，契约 §5 实现约束 2）。
 *
 * ⚠️ 为什么不直接用 `runSlaScan().facts[]` 的顺序：同类 `dueFrom` **完全相同**
 *    （都等于该类阈值时刻），单靠 `dueFrom` 排不出稳定序。
 *    这里补 `kind` / `ticketId` / `visitId` 三个 tiebreak，
 *    保证"同一份数据、任意两次请求，分页结果一致"。
 */
function sortFacts(facts: SlaOverdueFact[]): SlaOverdueFact[] {
  return [...facts].sort((a, b) => {
    if (a.dueFrom !== b.dueFrom) return a.dueFrom < b.dueFrom ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.ticketId !== b.ticketId) return a.ticketId - b.ticketId;
    return (a.visitId ?? 0) - (b.visitId ?? 0);
  });
}

// ---------------------------------------------------------------------------
// 与 Phase 8 的桥接
// ---------------------------------------------------------------------------

/**
 * 跑一轮 SLA 扫描，**quiet**。
 *
 * ⚠️ `quiet: true` 是刻意的：看板是**用户请求**触发的实时计算，不是定时任务。
 *    若不 quiet，每刷一次看板就会往 `TaskRegistry` 写一次"任务跑了一轮"并产生业务日志 ——
 *    那会让"任务观测"被人的点击行为污染
 *    （health 探针路径出于同一理由也是 quiet，见 `sla-scan-scheduler.ts`）。
 */
async function runSlaScanQuiet(
  deps: ReportDeps,
  detailLimit: number,
  now: Date,
): Promise<SlaScanResult> {
  return runSlaScan({
    port: deps.slaPort,
    logger: deps.logger ?? {},
    detailLimit,
    now: () => now,
    quiet: true,
  });
}

/** 低分阈值（`feedback.low_score_threshold`，默认 2；与 constants 的参数种子同键） */
async function readLowScore(deps: ReportDeps): Promise<number> {
  try {
    if (deps.readLowScoreThreshold) return await deps.readLowScoreThreshold();
    return 2;
  } catch {
    return 2;
  }
}
