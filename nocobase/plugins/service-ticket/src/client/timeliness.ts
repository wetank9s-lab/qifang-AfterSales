/**
 * 时效展示计算（Phase 4-H3 工单详情抽屉）
 *
 * ⚠️ 范围边界（2026-09-21 复核方明确）：
 *   **只展示时间，不做 SLA 引擎。**
 *   预警阈值、SLA 扫描任务、总部异常看板全部留在 **Phase 9**，
 *   这里不引入"超时了要报警""红灯黄灯"这类判定 —— 一旦引入，
 *   就等于把 Phase 9 的阈值口径提前钉死在一个还没评审的地方。
 *
 * 为什么单独成一个**纯函数**文件（不掺 React、不掺 NocoBase）：
 *   时效文案是"看起来简单、边界极多"的典型（跨天、未来时间、已闭环、
 *   时间缺失…），而它在浏览器里**没有任何断言能覆盖** ——
 *   除非把它抽成可被 Node 直接调用的纯函数。
 *   scripts/verify-plugin-load.mjs 会对这里的每个分支做离线断言，
 *   于是"文案算错"这种只能靠肉眼发现的问题变成了红灯。
 */

/** 一分钟的毫秒数 */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface TimelinessInput {
  /** 报修时间（工单 createdAt） */
  createdAt?: string | number | Date | null;
  /** 首次响应时间 */
  firstResponseAt?: string | number | Date | null;
  /** 预计上门时间 */
  expectedVisitAt?: string | number | Date | null;
  /** 闭环时间（已闭环的工单不再计"已等待"） */
  closedAt?: string | number | Date | null;
  /** 完成时间（师傅提交后同样停止计时） */
  completedAt?: string | number | Date | null;
  /** 当前时间，注入以便测试（默认 Date.now()） */
  now?: number;
}

export interface Timeliness {
  /** 已等待/已耗时的可读文案；工单已闭环时说"总耗时" */
  elapsedText: string;
  /** 首次响应耗时；未响应则为 null */
  firstResponseText: string | null;
  /** 预约时间的绝对描述（含"今天/明天/昨天"） */
  appointmentText: string | null;
  /** 相对预约时间：距预约还有多久 / 已超过多久 */
  relativeText: string | null;
  /** 是否**已超过**预约时间（供 UI 决定用不用醒目色，Phase 4 只做视觉不做判定） */
  overdue: boolean;
}

function toTime(value: string | number | Date | null | undefined): number | null {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 把毫秒差说成人话。
 *
 * 刻意**只到分钟**：工单是人工处理的业务，"已等待 36 分钟"比
 * "已等待 36 分 12 秒"更有用，也不会让人误以为系统在秒级催促。
 */
function humanizeDuration(ms: number): string {
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

/** 日期是否同一天（按本地时区） */
function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 相对今天的天数差：-1 昨天 / 0 今天 / 1 明天 */
function dayDiff(target: number, now: number): number {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(target);
  b.setHours(0, 0, 0, 0);
  // 用 UTC 毫秒差消除夏令时影响（中国无夏令时，但保持健壮）
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
    Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

function clockText(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 计算一张工单的时效文案。
 *
 * 每一处"取不到"都返回 null 而不是假文案 —— 宁可让抽屉里这一行空着，
 * 也不要显示"已等待 0 分钟"去误导售后人员（那会让人以为工单刚建）。
 */
export function computeTimeliness(input: TimelinessInput): Timeliness {
  const now = input.now ?? Date.now();
  const created = toTime(input.createdAt);
  // 已闭环/已完成的工单停止计时：继续说"已等待"会让人以为没人处理
  const stopAt = toTime(input.closedAt) ?? toTime(input.completedAt);
  const end = stopAt ?? now;

  let elapsedText = '—';
  if (created != null) {
    const label = stopAt != null ? '总耗时' : '已等待';
    elapsedText = `${label} ${humanizeDuration(end - created)}`;
  }

  const responded = toTime(input.firstResponseAt);
  let firstResponseText: string | null = null;
  if (created != null && responded != null) {
    firstResponseText = `首次响应 ${humanizeDuration(responded - created)}`;
  } else if (responded == null) {
    firstResponseText = '尚未响应';
  }

  const expected = toTime(input.expectedVisitAt);
  let appointmentText: string | null = null;
  let relativeText: string | null = null;
  let overdue = false;
  if (expected != null) {
    const diff = dayDiff(expected, now);
    const dayLabel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : `${diff} 天后`;
    appointmentText = `预约 ${dayLabel} ${clockText(expected)}`;

    const delta = expected - now;
    if (delta >= 0) {
      relativeText = `距预约还有 ${humanizeDuration(delta)}`;
    } else {
      overdue = true;
      relativeText = `已超过预约 ${humanizeDuration(delta)}`;
    }
  }

  return { elapsedText, firstResponseText, appointmentText, relativeText, overdue };
}
