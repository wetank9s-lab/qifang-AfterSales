/**
 * 时效展示计算（Phase 4-H3 工单详情抽屉）
 *
 * ⚠️ 范围边界（2026-09-21 复核方明确，2026-09-23 收紧）：
 *   **只展示"当前这一步"的时间信息，不做 SLA 引擎，也不做指标墙。**
 *   预警阈值、SLA 扫描任务、总部异常看板全部留在 **Phase 9**，
 *   这里不引入"超时了要报警""红灯黄灯"这类判定 —— 一旦引入，
 *   就等于把 Phase 9 的阈值口径提前钉死在一个还没评审的地方。
 *
 * ⚠️ 2026-09-23 收紧的原因（第二轮真人走查）：原实现一次吐出
 *    `elapsedText / firstResponseText / appointmentText / relativeText` **四行**，
 *   抽屉里就成了一个小仪表盘 —— 售后同事要自己判断"哪一行才是我现在该看的"。
 *   现在改成 **`statusTimelinessLine()` 只产出**一句话，
 *   内容是"**当前状态对应的那一个时间事实**"：
 *
 *     待受理        → 等待受理 2 小时
 *     处理中        → 预计 9月24日 上门
 *     待门店确认    → 等待门店确认 3 小时
 *     待客户评价    → 等待客户评价 1 天
 *     已闭环        → 完成于 9月23日 · 总耗时 2 天
 *
 * 为什么单独成一个**纯函数**文件（不掺 React、不掺 NocoBase）：
 *   时效文案是"看起来简单、边界极多"的典型（跨天、未来时间、已闭环、
 *   时间缺失…），而它在浏览器里**没有任何断言能覆盖** ——
 *   除非把它抽成可被 Node 直接调用的纯函数。
 *   `scripts/verify-client-logic.mjs` 会对这里的每个分支做离线断言，
 *   于是"文案算错"这种只能靠肉眼发现的问题变成了红灯。
 */
import { TICKET_STATUS, TICKET_STATUS_LABEL } from '../server/constants';

/** 一分钟的毫秒数 */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface TimelinessInput {
  /** 工单当前状态（决定"这一条"该说什么） */
  status?: string | null;
  /** 报修时间（工单 createdAt） */
  createdAt?: string | number | Date | null;
  /** 预计上门**日期**（取当前 active Visit 的，没有则退到工单主表） */
  expectedVisitAt?: string | number | Date | null;
  /** 闭环时间 */
  closedAt?: string | number | Date | null;
  /** 完成时间 */
  completedAt?: string | number | Date | null;
  /**
   * 事件流（**可选**）。
   *
   * 用于算"等待门店确认 / 等待评价多久了" —— 这两个状态的计时起点是
   * **进入该状态的那一刻**，而那个时刻只有事件里有（工单主表只有一个
   * 被反复覆盖的 `updated_at`，拿它计时会随任何一次无关修改而重置）。
   */
  events?: Array<{ event_type?: string; to_status?: string | null; created_at?: unknown; createdAt?: unknown }>;
  /** 当前时间，注入以便测试（默认 Date.now()） */
  now?: number;
}

function toTime(value: unknown): number | null {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 把毫秒差说成人话。
 *
 * 刻意**只到分钟**：工单是人工处理的业务，"已等待 36 分钟"比
 * "已等待 36 分 12 秒"更有用，也不会让人误以为系统在秒级催促。
 */
export function humanizeDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return '不到 1 分钟';
  const minutes = Math.floor(abs / MINUTE);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/** 相对今天的天数差：-1 昨天 / 0 今天 / 1 明天 */
function dayDiff(target: number, now: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(target);
  b.setHours(0, 0, 0, 0);
  // 用 UTC 毫秒差消除夏令时影响（中国无夏令时，但保持健壮）
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86400000,
  );
}

/**
 * 「预计上门日期」的**只到天**表达（`今天` / `明天` / `9月24日`）。
 *
 * ⚠️ 绝不输出时分：存储层为了满足 datetime 字段，把「预计上门日期」
 * 统一规范化成**当日正午**（见 `shared/service-mode.ts` 的
 * `APPOINTMENT_CANONICAL_TIME`），那个 12:00 **不是真实承诺时刻**。
 * 一旦在界面上把 12:00 显示出来，它就会被当成"师傅中午到"——
 * 凭空制造一个项目根本没有能力支撑的精度。
 *
 * 同理**刻意不提供**任何输出 `HH:mm` 的函数：只要界面上没有这个能力，
 * "把固定时分当真实时间"就不可能发生。
 *
 * @returns 取不到（空值/非法值）时返回 `''`，由调用方决定这一行显不显示
 */
export function formatAppointmentDate(
  value: unknown,
  now: number = Date.now(),
): string {
  const t = toTime(value);
  if (t == null) return '';
  const diff = dayDiff(t, now);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 找出"进入当前状态"的时刻 —— 取**最后一条 to_status 等于当前状态**的事件。
 *
 * 为什么不用工单的 `updated_at`：那个字段被任何一次写操作覆盖（改备注、
 * 换师傅…），拿它算"等待门店确认多久了"会随无关修改归零，
 * 属于"看起来有值、实际是错的"的那类假数据。
 */
function enteredStatusAt(
  events: TimelinessInput['events'],
  status: string,
): number | null {
  if (!Array.isArray(events)) return null;
  let found: number | null = null;
  for (const e of events) {
    if (String(e?.to_status ?? '') !== status) continue;
    const t = toTime(e?.created_at ?? e?.createdAt);
    if (t != null) found = t; // 事件按时间升序返回 → 最后一个命中的就是"最近一次进入"
  }
  return found;
}

/** 状态 → 该说哪一句话的判定表（判据是**状态机里的状态值**，不是中文名） */
const WAITING_STATUSES: Record<string, string> = {
  [TICKET_STATUS.NEW]: '等待受理',
  [TICKET_STATUS.WAIT_STORE_CONFIRM]: '等待门店确认',
  [TICKET_STATUS.WAIT_FEEDBACK]: '等待客户评价',
};

/**
 * 产出**当前状态下唯一一条**时效文案。
 *
 * 每一处"取不到"都退化成一句**不撒谎**的话（例如"已受理，尚未派工"），
 * 而不是显示"已等待 0 分钟"去误导售后同事（那会让人以为工单刚建）。
 *
 * @returns 一行文案；`status` 缺失时返回 `''`
 */
export function statusTimelinessLine(input: TimelinessInput): string {
  const now = input.now ?? Date.now();
  const status = String(input.status ?? '');
  if (!status) return '';

  const statusText = TICKET_STATUS_LABEL[status as keyof typeof TICKET_STATUS_LABEL] ?? status;
  const nowText = (t: number | null, prefix: string): string =>
    t == null ? '' : `${prefix} ${humanizeDuration(now - t)}`;

  // ① 终态：闭环给"完成时间 + 总耗时"，取消只说明已取消
  if (status === TICKET_STATUS.CLOSED) {
    const finishedAt = toTime(input.closedAt) ?? toTime(input.completedAt);
    const startedAt = toTime(input.createdAt);
    const parts: string[] = [];
    if (finishedAt != null) parts.push(`完成于 ${formatAppointmentDate(finishedAt, now) || '—'}`);
    if (finishedAt != null && startedAt != null) {
      parts.push(`总耗时 ${humanizeDuration(finishedAt - startedAt)}`);
    }
    return parts.length ? parts.join(' · ') : '已闭环';
  }
  if (status === TICKET_STATUS.CANCELLED) return '工单已取消';

  // ② 处理中：唯一有意义的是"预计哪天上门"
  if (status === TICKET_STATUS.PROCESSING) {
    const dateText = formatAppointmentDate(input.expectedVisitAt, now);
    if (dateText) return `预计 ${dateText} 上门`;
    return '已受理，尚未派工';
  }

  // ③ 等待类：说"等了多久"。计时起点 = 进入该状态的时刻（事件），
  //    事件缺失（老数据/只读接口没回事件）时退到 createdAt，并说明是"已等待"。
  const prefix = WAITING_STATUSES[status];
  if (prefix) {
    const since =
      enteredStatusAt(input.events, status) ?? (status === TICKET_STATUS.NEW ? toTime(input.createdAt) : null);
    if (since == null) return `${statusText}`;
    return nowText(since, prefix);
  }

  // ④ 兜底：不认识的状态只回中文名，绝不把英文枚举丢到界面上
  return statusText;
}
