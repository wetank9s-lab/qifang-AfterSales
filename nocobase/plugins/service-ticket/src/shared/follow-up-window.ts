/**
 * follow-up-window —— 「这条跟进待办算不算逾期」的**唯一判据**（Phase 11 / P11-1）
 * =============================================================================
 *
 * 🔴 为什么单独一个**零依赖**的共享模块（而不是写在 action 里）
 * -----------------------------------------------------------------------------
 * 用户 2026-10-10 的目标核对点名了这一条：
 *
 * > `next_follow_at` 使用中国业务日期语义：**今天整天均属"今天跟进"**，
 * > 下一自然日才标记逾期，**不得因为日期规范化为中午 12 点而在当天中午
 * > 产生错误的超时判断**。
 *
 * 这句话的失效方式非常隐蔽：只要判据里出现"**现在几点**"，
 * 一条"今天跟进"的待办就会在**今天 12:00:01** 突然变成"已逾期"——
 * 而它本该整整一天都算"今天"。上午跑验收是绿的、下午跑是红的，
 * 且没人会想到"是中午那一秒"造成的。
 *
 * ⇒ 把判据做成纯函数，并让它的**签名里没有"当前时间"**。
 *   这不是风格选择，是**结构性保证**：函数**拿不到** now ⇒ 它不可能用时/分/秒比较。
 *   它只看两个**日期**：(这条待办的业务日, 今天的业务日)。
 *
 * ⚠️ 与"UTC 提前一天"是同一族问题的另一面：
 *    · 那一面是"日期算错了一天"（时区口径不统一）；
 *    · 这一面是"同一天里按小时切"（粒度用错）。
 *    两者都用"**业务日 key**"这一种表示法同时挡住。
 */
import { APPOINTMENT_TIMEZONE_OFFSET } from './service-mode';

/** 一条待办相对"今天"的位置 */
export const FOLLOW_UP_WINDOW = {
  /** 待办日 **就是**今天 ⇒ 今天整天都算它 */
  TODAY: 'today',
  /** 待办日 **早于**今天 ⇒ 从**下一个自然日**起才是逾期 */
  OVERDUE: 'overdue',
  /** 待办日在今天之后 */
  FUTURE: 'future',
  /** 没有待办（空值） */
  NONE: 'none',
} as const;

export type FollowUpWindow = (typeof FOLLOW_UP_WINDOW)[keyof typeof FOLLOW_UP_WINDOW];

/** `+08:00` → 毫秒（只支持这一种形态；与 ticket-service 的 timezoneOffsetMs 同一口径） */
function offsetMsOf(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`[follow-up-window] 非法时区偏移：${offset}`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

/**
 * 把任意时刻折算成它所属的**业务日**（`YYYY-MM-DD`）。
 *
 * ⚠️ 只用"年-月-日"三要素，**不带时分秒** —— 这正是"整天都算今天"的实现方式：
 *    两个今天内不同时刻的值，会得到**同一个** key。
 * ⚠️ 实现是"加偏移后读 UTC 字段"，因此**不依赖容器时区**（TZ 改了结果不变）。
 */
export function businessDayOf(value: unknown, offset = APPOINTMENT_TIMEZONE_OFFSET): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + offsetMsOf(offset));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * 一条跟进待办落在哪个窗口。
 *
 * ⚠️ **签名刻意不接受"当前时间"**：判定只需要（待办日, 今天的业务日）。
 *    调用方负责用 `businessDayOf(new Date())` 算出"今天是哪一天"——
 *    那一步才需要时钟，而且它只产出**一个日期**，不产出"第几秒"。
 *
 * @param dueAt 待办日期（ISO 串 / Date / 空）
 * @param todayDay 今天的**业务日** key（由 `businessDayOf(new Date())` 得到）
 */
export function followUpWindowOf(dueAt: unknown, todayDay: string): FollowUpWindow {
  const dueDay = businessDayOf(dueAt);
  if (!dueDay) return FOLLOW_UP_WINDOW.NONE;
  // 两个 key 都是 `YYYY-MM-DD` ⇒ 字典序即时间序（定长、零填充）
  if (dueDay === todayDay) return FOLLOW_UP_WINDOW.TODAY;
  return dueDay < todayDay ? FOLLOW_UP_WINDOW.OVERDUE : FOLLOW_UP_WINDOW.FUTURE;
}
