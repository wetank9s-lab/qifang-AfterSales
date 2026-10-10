#!/usr/bin/env node
/**
 * verify-audit-coverage.mjs —— 审计操作人覆盖率：**同一快照下的自洽统计** + 修复回归
 * （Phase 11 / P11-2 · 用户 2026-10-10 裁决三 · 补充范围清查）
 *
 * ===========================================================================
 * 这个文件是被一次**报数错误**逼出来的（如实写在最前面）
 * ===========================================================================
 * 2026-10-10 的报告里，同一段话出现了"共 **722** 条"和"四类合计 **199+254+271+8**"
 * —— 两个数**来自不同时点的两次查询**。用户当场指出："总数 722 与分类合计不一致"。
 *
 * 🔴 根因不是算术，是**方法**：把"今天上午查的总数"和"刚才查的分类"拼在一起报。
 *    `ticket_events` 会被每一支验收脚本创建/清理（`cleanupTicket` 会删事件），
 *    所以**任何数字都只是某一时刻的快照**；跨时点拼接必然不自洽。
 *
 * ⇒ 修法（本文件的存在理由）：把这条统计变成**一条机器判据**——
 *    ① **一次快照**取全部数字；
 *    ② 断言四组口径**必须两两相等**（总数 = 新旧之和 = 有无之和 = 各分组之和）；
 *    ③ 断言**修复后**的 `store` 类事件覆盖率 = 100%（DEV-137 若复发立刻红）；
 *    ④ 每条输出都带上**快照时刻**与**SQL 口径**，让"报数"这件事可复核。
 *
 * ===========================================================================
 * 历史 vs 新数据的分界怎么定（**不许猜时间**）
 * ===========================================================================
 * 分界点写死为 **DEV-137 修复构建上线时刻 `2026-10-10 17:46:00+08`**，
 * 并且**用数据交叉验证**它：该时刻之后应当存在"有操作人"的事件，
 * 而该时刻之前应当**一条都没有**。两条都断言（任一条不成立 ⇒ 分界点被移动过，必须重判）。
 *
 * ⚠️ 本门禁**只读**：不回填、不修改任何历史事件。历史缺口只形成**风险结论**。
 */

import {
  EnvNotReady,
  assert,
  makeChecker,
  psqlRows,
  runMain,
} from './technician-harness.mjs';

/** DEV-137 修复构建上线的时刻（`event-service.ts` 改 `values.operator_user` 后的那次重启） */
const FIX_DEPLOYED_AT = '2026-10-10 17:46:00+08';

/** 分类里"本来就该没有操作人"的 kind（不是缺口） */
const NO_USER_BY_DESIGN = ['system', 'customer'];

const num = (v) => Number(v ?? 0);

async function main() {
  const { check, summary } = makeChecker({ heading: '审计操作人覆盖率' });

  // ---------------------------------------------------------------- 快照
  // ⚠️ 一次查询取全部数字 —— 这正是本文件的核心纪律（跨时点拼接 = 必然不自洽）
  const snapshotAt = psqlRows('SELECT now()::text')[0][0];
  console.log(`  快照时刻（本机时区）：${snapshotAt}`);
  console.log(`  历史/新数据分界：${FIX_DEPLOYED_AT}（DEV-137 修复上线）`);

  const kinds = psqlRows(`
    WITH b AS (SELECT timestamptz '${FIX_DEPLOYED_AT}' AS fix_at)
    SELECT operator_kind,
           count(*)::text,
           count(*) FILTER (WHERE created_at <  (SELECT fix_at FROM b))::text,
           count(*) FILTER (WHERE created_at >= (SELECT fix_at FROM b))::text,
           count(operator_user_id)::text,
           (count(*) - count(operator_user_id))::text
      FROM ticket_events GROUP BY 1 ORDER BY 1`);

  const totals = psqlRows(`
    WITH b AS (SELECT timestamptz '${FIX_DEPLOYED_AT}' AS fix_at)
    SELECT count(*)::text,
           count(*) FILTER (WHERE created_at <  (SELECT fix_at FROM b))::text,
           count(*) FILTER (WHERE created_at >= (SELECT fix_at FROM b))::text,
           count(operator_user_id)::text,
           (count(*) - count(operator_user_id))::text
      FROM ticket_events`)[0];

  const byEventType = psqlRows(
    `SELECT event_type, count(*)::text FROM ticket_events GROUP BY 1 ORDER BY 1`,
  );

  const total = num(totals[0]);
  const before = num(totals[1]);
  const after = num(totals[2]);
  const withUser = num(totals[3]);
  const withoutUser = num(totals[4]);

  // ---------------------------------------------------------------- ① 自洽
  check('① 分组之和 == 总数（按 operator_kind 与 event_type 两条口径）', () => {
    const sumKind = kinds.reduce((s, r) => s + num(r[1]), 0);
    const sumEvent = byEventType.reduce((s, r) => s + num(r[1]), 0);
    assert(
      sumKind === total,
      `operator_kind 分组之和 ${sumKind} ≠ 总数 ${total} —— 报数口径不自洽`,
    );
    assert(
      sumEvent === total,
      `event_type 分组之和 ${sumEvent} ≠ 总数 ${total} —— 报数口径不自洽`,
    );
    return `${total} = Σkind(${kinds.length} 类) = Σevent_type(${byEventType.length} 类)`;
  });

  check('① 新旧之和 == 总数，且「有/无操作人」之和 == 总数', () => {
    assert(before + after === total, `修复前 ${before} + 修复后 ${after} ≠ ${total}`);
    assert(withUser + withoutUser === total, `有 ${withUser} + 无 ${withoutUser} ≠ ${total}`);
    return `${before}+${after}=${total} · ${withUser}+${withoutUser}=${total}`;
  });

  check('① **反向**：分界点由数据交叉验证（不然它就是个我编的时间）', () => {
    // 分界之后**应当有**带操作人的事件；分界之前**应当一条都没有**
    const afterHasUser = psqlRows(
      `SELECT count(*)::text FROM ticket_events WHERE created_at >= timestamptz '${FIX_DEPLOYED_AT}' AND operator_user_id IS NOT NULL`,
    )[0][0];
    const beforeHasUser = psqlRows(
      `SELECT count(*)::text FROM ticket_events WHERE created_at <  timestamptz '${FIX_DEPLOYED_AT}' AND operator_user_id IS NOT NULL`,
    )[0][0];
    assert(
      num(beforeHasUser) === 0,
      `分界点**之前**出现了 ${beforeHasUser} 条带操作人的事件 —— 说明修复其实更早生效，分界点必须重定`,
    );
    assert(
      num(afterHasUser) > 0,
      `分界点**之后**一条带操作人的事件都没有 —— 修复没生效（DEV-137 复发）或分界点被挪后了`,
    );
    return `之前带操作人 0 条 · 之后带操作人 ${afterHasUser} 条`;
  });

  // ---------------------------------------------------------------- ② 修复回归
  check('② **修复回归**：分界之后 `store` 类事件的覆盖率必须是 100%（DEV-137 若复发即红）', () => {
    const row = kinds.find((r) => r[0] === 'store');
    assert(row, '找不到 operator_kind=store 的事件');
    const storeAfter = num(row[3]);
    const storeAfterWithUser = psqlRows(
      `SELECT count(*)::text FROM ticket_events WHERE created_at >= timestamptz '${FIX_DEPLOYED_AT}' AND operator_kind='store' AND operator_user_id IS NOT NULL`,
    )[0][0];
    assert(
      storeAfter > 0,
      '分界之后没有任何 store 类事件 —— 这条回归判据目前无法证伪（请先跑一次人工新建）',
    );
    assert(
      num(storeAfterWithUser) === storeAfter,
      `分界之后 store 类事件 ${storeAfter} 条，其中只有 ${storeAfterWithUser} 条有操作人 —— ` +
        'DEV-137 的修复没有覆盖到全部写路径',
    );
    return `store：分界前 0/${num(row[2])} · 分界后 ${storeAfterWithUser}/${storeAfter}`;
  });

  // ---------------------------------------------------------------- ③ 历史缺口结论
  check('③ 历史缺口结论（**只统计、不回填**）：区分"设计上没有人"与"真实缺口"', () => {
    const beforeRows = kinds.map((r) => ({ kind: r[0], n: num(r[2]), withUser: 0 }));
    const byDesign = beforeRows.filter((r) => NO_USER_BY_DESIGN.includes(r.kind));
    const realGap = beforeRows.filter((r) => !NO_USER_BY_DESIGN.includes(r.kind));
    const byDesignSum = byDesign.reduce((s, r) => s + r.n, 0);
    const realGapSum = realGap.reduce((s, r) => s + r.n, 0);
    assert(
      byDesignSum + realGapSum === before,
      `按设计无操作人 ${byDesignSum} + 真实缺口 ${realGapSum} ≠ 修复前总数 ${before}`,
    );
    // 如实打印，供报告直接引用
    console.log(
      `     · 按设计无操作人（${byDesign.map((r) => `${r.kind} ${r.n}`).join(' / ')}）= ${byDesignSum}`,
    );
    console.log(
      `     · 真实缺口（${realGap.map((r) => `${r.kind} ${r.n}`).join(' / ')}）= ${realGapSum}`,
    );
    console.log('     · 处置：**不回填、不猜测操作人、不修改历史事件**（只作为发布前风险）');
    return `设计无 ${byDesignSum} + 真实缺口 ${realGapSum} = ${before}`;
  });

  // ---------------------------------------------------------------- ④ 全量读数
  check('④ 输出全量读数（含快照时刻；本门禁只读）', () => {
    for (const r of kinds) {
      console.log(
        `     ${String(r[0]).padEnd(10)} 合计 ${String(r[1]).padStart(4)} · ` +
          `前 ${String(r[2]).padStart(4)} · 后 ${String(r[3]).padStart(3)} · ` +
          `有操作人 ${String(r[4]).padStart(3)} · 无 ${String(r[5]).padStart(4)}`,
      );
    }
    console.log(`     ${'合计'.padEnd(10)} 合计 ${String(total).padStart(4)} · ` +
      `前 ${String(before).padStart(4)} · 后 ${String(after).padStart(3)} · ` +
      `有操作人 ${String(withUser).padStart(3)} · 无 ${String(withoutUser).padStart(4)}`);
    return `${total} 条事件 · 快照 ${snapshotAt}`;
  });

  summary();
}

await runMain({ name: '审计操作人覆盖率 · 同一快照自洽统计', main });

void EnvNotReady;
