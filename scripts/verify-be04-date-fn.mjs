/**
 * verify-be04-date-fn.mjs —— 日期纯函数门禁（与产品**同一份实现**）
 *
 * 覆盖：日 / 月 / 年 / 自定义 / 五个快捷 / 月末 / 闰年 2 月 / 跨年 / 起晚于止。
 * 断言最终 filter 是 `$dateNotBefore` + `$dateBefore`（精确半开，不减 1 秒）。
 *
 * 反向验证：把 `end` 改成 `end - 1s` 或改成当天 23:59:59 ⇒ 本门禁必须红。
 */
import * as D from '../nocobase/plugins/service-ticket/src/client/date-range.mjs';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04-DATE：日期纯函数（Asia/Shanghai 半开区间）');
console.log('══════════════════════════════════════════════════════════════');

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check(
  eq(D.dayRange('2026-10-15'), { start: '2026-10-15T00:00:00+08:00', end: '2026-10-16T00:00:00+08:00' }),
  '按日：2026-10-15 → [15 日 00:00, 16 日 00:00)',
  JSON.stringify(D.dayRange('2026-10-15')),
);

check(
  eq(D.monthRange('2026-10'), { start: '2026-10-01T00:00:00+08:00', end: '2026-11-01T00:00:00+08:00' }),
  '按月：2026-10 → [10-01, 11-01)',
  JSON.stringify(D.monthRange('2026-10')),
);

check(
  eq(D.monthRange('2026-02'), { start: '2026-02-01T00:00:00+08:00', end: '2026-03-01T00:00:00+08:00' }),
  '平年 2026-02 → 结束 03-01（不含 02-28 之后的空档）',
  JSON.stringify(D.monthRange('2026-02')),
);

check(
  eq(D.monthRange('2024-02'), { start: '2024-02-01T00:00:00+08:00', end: '2024-03-01T00:00:00+08:00' }),
  '**闰年 2024-02** → 结束 03-01（2-29 被包含）',
  JSON.stringify(D.monthRange('2024-02')),
);

check(
  eq(D.monthRange('2026-12'), { start: '2026-12-01T00:00:00+08:00', end: '2027-01-01T00:00:00+08:00' }),
  '跨年 2026-12 → 结束 2027-01-01',
  JSON.stringify(D.monthRange('2026-12')),
);

check(
  eq(D.yearRange(2026), { start: '2026-01-01T00:00:00+08:00', end: '2027-01-01T00:00:00+08:00' }),
  '按年：2026 → [2026-01-01, 2027-01-01)',
  JSON.stringify(D.yearRange(2026)),
);

check(
  eq(D.customRange('2026-10-05', '2026-10-07'), {
    start: '2026-10-05T00:00:00+08:00',
    end: '2026-10-08T00:00:00+08:00',
  }),
  '自定义：10-05 ~ 10-07（含末日）→ 结束 10-08 00:00',
  JSON.stringify(D.customRange('2026-10-05', '2026-10-07')),
);

check(D.customRange('2026-10-07', '2026-10-05') === null, '自定义：开始晚于结束 ⇒ null（不静默全量）', '');
check(D.customRange('2026-10-05', '2026-10-05') !== null, '自定义：同一天合法（单日）', '');

// 五个快捷（固定 now = 2026-10-20T10:00+08）
const NOW = Date.parse('2026-10-20T10:00:00+08:00');
check(
  eq(D.preset('today', NOW), D.dayRange('2026-10-20')),
  '快捷「今天」= 2026-10-20',
  JSON.stringify(D.preset('today', NOW)),
);
check(eq(D.preset('yesterday', NOW), D.dayRange('2026-10-19')), '快捷「昨天」= 2026-10-19', '');
check(eq(D.preset('thisMonth', NOW), D.monthRange('2026-10')), '快捷「本月」= 2026-10', '');
check(eq(D.preset('lastMonth', NOW), D.monthRange('2026-09')), '快捷「上月」= 2026-09', '');
check(eq(D.preset('thisYear', NOW), D.yearRange(2026)), '快捷「本年」= 2026', '');
// 1 月的「上月」要跨年
const JAN = Date.parse('2026-01-05T10:00:00+08:00');
check(eq(D.preset('lastMonth', JAN), D.monthRange('2025-12')), '快捷「上月」在 1 月 ⇒ 2025-12（跨年）', '');

// filter 形态
const f = D.toFilter(D.monthRange('2026-10'));
check(
  f.createdAt.$dateNotBefore === '2026-10-01T00:00:00+08:00' &&
    f.createdAt.$dateBefore === '2026-11-01T00:00:00+08:00' &&
    !('$dateOn' in f.createdAt) &&
    !('$dateBetween' in f.createdAt),
  'filter 用 $dateNotBefore + $dateBefore（**不用** $dateOn/$dateBetween）',
  JSON.stringify(f),
);
check(/T00:00:00\+08:00$/.test(f.createdAt.$dateBefore), '结束边界是**次日零点**（不是 23:59:59）', f.createdAt.$dateBefore);

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  日期纯函数：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const x of failed) console.log(`   ❌ ${x.label} — ${x.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
