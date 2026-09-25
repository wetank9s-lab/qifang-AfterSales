/**
 * H3 详情抽屉的**展示语义层**（纯函数：零 React、零 NocoBase、零 DOM）
 *
 * 为什么单独一层：
 *   抽屉要回答的四个问题（客户什么问题 / 处理到哪了 / 现在谁负责、哪天到 /
 *   之前发生了什么）**不是数据库字段的排列组合**，而是一次翻译 ——
 *   把 `visit_status='SUPERSEDED'`、`event_type='reassigned'` 这类
 *   内部枚举翻译成一线售后人员的话。
 *
 *   ⚠️ 把这层翻译留在 .tsx 里，它就只能靠"打开浏览器看一眼"来验证；
 *      抽成纯函数后，`scripts/verify-client-logic.mjs` 能在 Node 里
 *      逐条断言"这个状态到底显示成什么中文"，**且断言与库龄无关**。
 *
 * ⚠️ 三条纪律（都源于第二轮真人走查的实际反馈）：
 *   ① **不出现英文枚举**。取不到中文时给一个中性词（如「工单记录」），
 *      而不是把 `metadata_corrected` 原样打到屏幕上 ——
 *      "读不到中文"是数据问题，不该由一线同事承担。
 *   ② **不出现内部 ID / 凭据**。见 `DETAIL_HIDDEN_FIELDS`。
 *   ③ 同一件事**只说一次**。当前 Visit 归「当前服务」，
 *      历史 Visit 的业务变化只通过时间线表达（不并列一张 Visit 历史表）。
 */
import {
  EVENT_TYPE,
  EVENT_TYPE_LABEL,
  OPERATOR_KIND_LABEL,
  SERVICE_MODE_LABEL,
  VISIT_STATUS,
  VISIT_STATUS_LABEL,
} from '../server/constants';

/**
 * 详情抽屉**默认不展示**的字段清单。
 *
 * 存在的意义不只是"注释"，而是让"隐藏"这件事**可被断言**：
 *   `verify-client-logic.mjs` 会扫描 `ticket-drawer.tsx` 源码，
 *   只要这些标识符出现在渲染路径上就判红。
 *
 * ⚠️ 隐藏 ≠ 删除：完整原始审计数据仍在数据库里，总部未来若需要技术诊断，
 *    另做**折叠的「系统信息」**区块（本轮不做，不扩需求）。
 */
export const DETAIL_HIDDEN_FIELDS = [
  'ticket_id',
  'visit_id',
  'store_id',
  'handler_user_id',
  'reassigned_from_visit_id',
  'access_token_hash',
  'feedback_token_hash',
  'token_revoked_reason',
  'request_id',
  'metadata_json',
] as const;

/** Visit 的**终态**：不再代表"当前服务"，只作为历史存在 */
export const TERMINAL_VISIT_STATUSES: readonly string[] = [
  VISIT_STATUS.SUPERSEDED,
  VISIT_STATUS.CANCELLED,
];

export interface VisitLike {
  id?: number | string;
  visit_no?: number;
  visit_status?: string;
  service_mode?: string | null;
  provider_name?: string | null;
  technician_name?: string | null;
  technician_mobile?: string | null;
  expected_visit_at?: unknown;
  assigned_at?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
}

export interface EventLike {
  id?: number | string;
  event_type?: string;
  to_status?: string | null;
  operator_kind?: string;
  summary?: string | null;
  created_at?: unknown;
  createdAt?: unknown;
}

export interface TimelineEntry {
  key: string;
  /** `9月23日 15:04` */
  at: string;
  /** 操作方（客户 / 师傅 / 门店 / 总部 / 系统） */
  actor: string;
  /** 业务动作的中文名 */
  action: string;
  /** 详情（服务端已写成中文的业务摘要） */
  detail: string;
  /** 是否为"通知类"事件（短信）—— 视觉上降一级，不抢业务动作的注意力 */
  notice: boolean;
}

/** Visit 状态 → 中文（未知状态一律回落成中性词，不暴露枚举） */
export function visitStatusText(status: unknown): string {
  const key = String(status ?? '');
  return VISIT_STATUS_LABEL[key as keyof typeof VISIT_STATUS_LABEL] ?? '状态未知';
}

/** 服务方式 → 中文 */
export function serviceModeText(mode: unknown): string {
  const key = String(mode ?? '');
  if (!key) return '';
  return SERVICE_MODE_LABEL[key] ?? '其他方式';
}

/** 事件类型 → 中文动作名（**绝不回落成英文枚举**） */
export function eventActionText(type: unknown): string {
  const key = String(type ?? '');
  return EVENT_TYPE_LABEL[key] ?? '工单记录';
}

/** 操作者身份 → 中文 */
export function actorText(kind: unknown): string {
  const key = String(kind ?? '');
  return OPERATOR_KIND_LABEL[key] ?? '系统';
}

/** 该事件是否属于"通知类"（短信）—— 只影响视觉层级，不影响是否展示 */
export function isNoticeEvent(type: unknown): boolean {
  const key = String(type ?? '');
  return key === EVENT_TYPE.SMS_SENT || key === EVENT_TYPE.SMS_FAILED;
}

function toTime(value: unknown): number | null {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * `9月23日 15:04` —— 用于**真实发生过的时刻**（事件时间）。
 *
 * ⚠️ 与「预计上门日期」严格区分：这里是真实时间戳，显示到分钟是对客户
 *    "什么时候提交的/什么时候派工的"的准确回答；而预计上门日期是承诺的
 *    **粒度**，只到天。两者不能混用同一个格式化函数。
 */
export function formatStamp(value: unknown): string {
  const t = toTime(value);
  if (t == null) return '—';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 取**当前服务**的那一条 Visit。
 *
 * 判据：`visit_no` 最大且状态不属于终态（SUPERSEDED / CANCELLED）。
 * 为什么按 visit_no 而不是 createdAt 取最大：Append-only 的 Visit 表里
 * visit_no 是业务序号，改派时旧行**一个字段都不改**（见业务硬约束），
 * 因此它比任何"看起来更新的时间戳"都可靠。
 *
 * @returns 没有有效 Visit（未派工 / 全部被取代）时返回 null
 */
export function activeVisitOf(visits: VisitLike[] | null | undefined): VisitLike | null {
  if (!Array.isArray(visits) || visits.length === 0) return null;
  let best: VisitLike | null = null;
  for (const v of visits) {
    if (TERMINAL_VISIT_STATUSES.includes(String(v?.visit_status ?? ''))) continue;
    if (best == null || Number(v?.visit_no ?? 0) > Number(best.visit_no ?? 0)) best = v;
  }
  return best;
}

/**
 * 取**门店审核对象**的那条 Visit —— 即当前 `visit_status = SUBMITTED` 的回执行。
 *
 * ⚠️ 为什么**不能**用"最后一条 Visit"或 `activeVisitOf` 代替：
 *   `docs/PHASE-6.md` §4.1 把审核对象钉死成"**当前 SUBMITTED 的那条 Visit**"。
 *   改派会把旧 Visit 转 `SUPERSEDED` 并**新建**一条，两条并存 ——
 *   顺序（`visit_no` 最大 / `createdAt` 最新）只说明"谁最后被创建"，
 *   不说明"谁在等门店确认"。用顺序猜，会把一条已被取代的历史回执
 *   当成待审核对象展示出去（而它同样是合法的照片归属）。
 *   ⇒ 审核对象**只能由状态决定**。
 *
 * @returns 没有待确认的回执（未提交 / 已确认 / 已驳回）时返回 null
 */
export function submittedVisitOf(visits: VisitLike[] | null | undefined): VisitLike | null {
  if (!Array.isArray(visits)) return null;
  for (const v of visits) {
    if (String(v?.visit_status ?? '') === VISIT_STATUS.SUBMITTED) return v;
  }
  return null;
}

/**
 * 把事件流翻成时间线。
 *
 * 每条原则：**谁 · 什么时候 · 做了什么 · 关键变化**。
 *   - 谁        → `operator_kind` 的中文身份（刻意不显示登录名）
 *   - 什么时候  → `formatStamp`
 *   - 做了什么  → `event_type` 的中文名
 *   - 关键变化  → 服务端写好的 `summary`（已是中文业务语言）
 *
 * 按时间**升序**：读起来是"这张工单是怎么走到今天的"，而不是倒序的流水账。
 * 时间取不到的排在最前（宁可顺序略保守，也不要丢弃一条记录）。
 */
export function buildTimeline(events: EventLike[] | null | undefined): TimelineEntry[] {
  if (!Array.isArray(events)) return [];
  const decorated = events.map((e, index) => ({
    e,
    index,
    t: toTime(e?.created_at ?? e?.createdAt),
  }));
  decorated.sort((a, b) => {
    if (a.t == null && b.t == null) return a.index - b.index;
    if (a.t == null) return -1;
    if (b.t == null) return 1;
    if (a.t !== b.t) return a.t - b.t;
    return a.index - b.index; // 同毫秒时保持服务端返回顺序，避免不稳定排序
  });

  return decorated.map(({ e, index }) => ({
    key: String(e?.id ?? `e${index}`),
    at: formatStamp(e?.created_at ?? e?.createdAt),
    actor: actorText(e?.operator_kind),
    action: eventActionText(e?.event_type),
    detail: String(e?.summary ?? '').trim(),
    notice: isNoticeEvent(e?.event_type),
  }));
}
