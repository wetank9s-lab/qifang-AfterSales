/**
 * date-range.mjs —— 「所有工单」日期筛选的**纯函数**（Asia/Shanghai 自然周期）
 *
 * 为什么单独成文件：
 *   · 产品组件与门禁**共用同一份实现**，避免"测试一套、产品一套"（这是本项目反复踩过的坑）；
 *   · 不依赖运行环境时区：全部用**显式 `+08:00`** 拼字符串 / `Date.UTC` 计算，
 *     容器或浏览器 TZ 改了也不会漂。
 *
 * 语义（与 `verify-be04-date-semantics` 的 SQL 基准一致）：
 *   `[start, end)` —— 含开始、**不含**结束；结束 = 下一自然日/月/年零点，**不减 1 秒**。
 */

const TZ = '+08:00';
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → 当天零点（+08:00） */
export function dayStart(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error(`日期格式应为 YYYY-MM-DD：${day}`);
  return `${day}T00:00:00${TZ}`;
}

/** 日历加减（用 UTC 算，避免本地时区参与） */
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 某天 → [当天零点, 次日零点) */
export function dayRange(day) {
  return { start: dayStart(day), end: dayStart(addDays(day, 1)) };
}

/** 'YYYY-MM' → [本月 1 日零点, 次月 1 日零点)；自动处理 12 月→次年 1 月、闰年 2 月 */
export function monthRange(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym))) throw new Error(`月份格式应为 YYYY-MM：${ym}`);
  const [y, m] = ym.split('-').map(Number);
  if (m < 1 || m > 12) throw new Error(`月份越界：${ym}`);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    start: dayStart(`${y}-${pad(m)}-01`),
    end: dayStart(`${nextY}-${pad(nextM)}-01`),
  };
}

/** 年份 → [1/1 零点, 次年 1/1 零点) */
export function yearRange(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1970 || y > 2999) throw new Error(`年份不合法：${year}`);
  return { start: dayStart(`${y}-01-01`), end: dayStart(`${y + 1}-01-01`) };
}

/** 当前「上海今天」的 YYYY-MM-DD（不依赖本地时区） */
export function shanghaiToday(now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000); // 用 UTC 字段读"上海时间"
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 五个快捷入口 */
export function preset(name, now = Date.now()) {
  const today = shanghaiToday(now);
  const [y, m] = today.split('-').map(Number);
  switch (name) {
    case 'today':
      return dayRange(today);
    case 'yesterday':
      return dayRange(addDays(today, -1));
    case 'thisMonth':
      return monthRange(`${y}-${pad(m)}`);
    case 'lastMonth': {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return monthRange(`${ly}-${pad(lm)}`);
    }
    case 'thisYear':
      return yearRange(y);
    default:
      throw new Error(`未知快捷项：${name}`);
  }
}

/** 自定义区间；开始晚于/等于结束时返回 null（由调用方显示错误，**不静默全量**） */
export function customRange(startDay, endDayInclusive) {
  if (!startDay || !endDayInclusive) return null;
  if (startDay > endDayInclusive) return null;
  return { start: dayStart(startDay), end: dayStart(addDays(endDayInclusive, 1)) };
}

/** 转成后端 filter（精确半开，使用 $dateNotBefore + $dateBefore） */
export function toFilter(range) {
  if (!range) return null;
  return { createdAt: { $dateNotBefore: range.start, $dateBefore: range.end } };
}
