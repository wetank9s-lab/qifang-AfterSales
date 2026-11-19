#!/usr/bin/env node
/**
 * verify-test-data-scope.mjs —— 验证 `scripts/lib/test-data-scope.mjs` 本身。
 *
 * ===========================================================================
 * 为什么验证器也要被验证
 * ===========================================================================
 * 这个模块的作用是"保证测试数据能被干净清掉"。如果它自己有洞，
 * 后果不是"多一条断言变红"，而是**测试数据悄悄留在库里** ——
 * 而那正是本轮要消除的那一类风险。
 *
 * 判据分两组：
 *
 * 【静态组】读源码，确认危险形态**不存在**
 *   Q1  源码里没有 `customer_mobile` 出现在任何 DELETE 的 WHERE 里
 *   Q2  源码里没有 `DELETE FROM service_archives` 后面直接跟 `;`（无 WHERE 的裸删）
 *   Q3  `openScope` 拒绝空运行标记（空标记会让 LIKE '%%' 命中全表）
 *
 * 【运行组】用**内存里的假 psql** 跑真实流程
 *   Q4  `track()` 收到 undefined/0/负数/字符串 一律忽略，不产生脏 id
 *   Q5  **取不到 id 也能找回**：只用运行标记就能定位并删干净（id=370 事故的正解）
 *   Q6  清理后残留非 0 时 `cleanupAndAssert()` **抛错**，且错误信息里带运行标记
 *   Q7  清理行数不符时抛错（防止"删了但删的不是本次的"）
 *   Q8  空范围（本次没产生数据）不报错、不删任何东西
 *
 * ⚠️ 全程**不连真库**：psql 是内存桩。这条验证跑在 CI 里也不该有副作用。
 *
 * 用法：node scripts/verify-test-data-scope.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { newRunTag, openScope } from './lib/test-data-scope.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'scripts/lib/test-data-scope.mjs');

const out = [];
const rec = (id, ok, d) => {
  out.push({ id, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${id} ${d}`);
};

/** 剥注释后再扫，避免说明文字造成假红/假绿 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * 内存桩 psql：记录所有执行的 SQL，并按预设"库内状态"回答 count 查询。
 * 这样 Q5/Q6 才能在**不碰真库**的前提下验证真实分支。
 */
function makeFakePsql(state) {
  const log = [];
  const fn = (sql) => {
    log.push(sql);
    const s = String(sql);
    // 按标记定位
    if (/SELECT coalesce\(string_agg\(id::text/.test(s)) {
      return state.byMark.join(',');
    }
    // 子表 DELETE
    const del = s.match(/DELETE FROM (service_archive_\w+) WHERE archive_id IN \(([^)]+)\)/);
    if (del) {
      const ids = del[2].split(',').map(Number);
      return String(state.childRows[del[1]] ? ids.length * state.childRows[del[1]] : 0);
    }
    // 主表 DELETE
    const delMain = s.match(/DELETE FROM service_archives WHERE id IN \(([^)]+)\)/);
    if (delMain) {
      const ids = delMain[1].split(',').map(Number);
      if (state.stubborn) return '0'; // 模拟"删不掉"
      return String(ids.length);
    }
    // 残留核对
    if (/SELECT count\(\*\) FROM service_archives WHERE id IN/.test(s)) return String(state.leftArchives);
    const leftChild = s.match(/SELECT count\(\*\) FROM (service_archive_\w+) WHERE archive_id IN/);
    if (leftChild) return String(state.leftChild ?? 0);
    return '0';
  };
  return { fn, log };
}

function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const code = stripComments(src);

  // ── Q1 不得按手机号删 ────────────────────────────────────────────────────
  // 找所有 DELETE 语句，看 WHERE 里是否出现手机号/姓名
  const deletes = [...code.matchAll(/DELETE\s+FROM[\s\S]{0,200}?;/gi)].map((m) => m[0]);
  const phoneDeletes = deletes.filter((d) => /customer_mobile|customer_name\s*=/.test(d));
  rec('Q1-no-delete-by-phone', phoneDeletes.length === 0,
    `DELETE 语句 ${deletes.length} 条，其中按手机号/姓名条件删的=${phoneDeletes.length}（须 0 —— 那会误伤真实业务档案）`);

  // ── Q2 不得有无 WHERE 的裸删 ─────────────────────────────────────────────
  const bareDelete = /DELETE\s+FROM\s+\w+\s*;/i.test(code);
  rec('Q2-no-bare-delete', !bareDelete, `存在无 WHERE 的裸删=${bareDelete}（须 false）`);

  // ── Q3 空标记被拒绝 ──────────────────────────────────────────────────────
  const { fn: dummy } = makeFakePsql({ byMark: [], childRows: {}, leftArchives: 0 });
  let rejected = 0;
  for (const bad of ['', null, undefined, 'abc']) {
    try {
      openScope({ run: bad, psql: dummy });
    } catch {
      rejected += 1;
    }
  }
  rec('Q3-reject-empty-tag', rejected === 4,
    `空/过短标记被拒 ${rejected}/4（空标记会让 LIKE '%%' 命中全表 —— 那是最危险的一种"清理范围"）`);

  // ── Q4 track 只接受正整数 ────────────────────────────────────────────────
  {
    const { fn } = makeFakePsql({ byMark: [], childRows: {}, leftArchives: 0 });
    const sc = openScope({ run: newRunTag('T'), psql: fn });
    for (const v of [undefined, null, 0, -3, 'abc', NaN, 12.7, '42']) sc.track(v);
    rec('Q4-track-guards', JSON.stringify(sc.ids) === '[42]',
      `传入 [undefined,null,0,-3,'abc',NaN,12.7,'42'] 后登记到=${JSON.stringify(sc.ids)}（须只有 [42]）`);
  }

  // ── Q5 取不到 id 也能靠标记找回 ──────────────────────────────────────────
  {
    const { fn, log } = makeFakePsql({
      byMark: [370, 371],
      childRows: { service_archive_photos: 1 },
      leftArchives: 0,
    });
    const run = newRunTag('HVAC');
    const sc = openScope({ run, psql: fn }); // 注意：**一次 track 都没调**
    const r = sc.cleanupAndAssert();
    const usedMark = log.some((s) => s.includes(`LIKE '%${run}%'`));
    rec('Q5-recover-by-tag-without-id', r.clean && r.ids.length === 2 && usedMark,
      `未 track 任何 id 时靠标记找回 ${JSON.stringify(r.ids)}，clean=${r.clean}，SQL 里用了标记 LIKE=${usedMark}`);
  }

  // ── Q6 残留非 0 必须抛错且带标记 ─────────────────────────────────────────
  {
    const { fn } = makeFakePsql({ byMark: [500], childRows: {}, leftArchives: 1 });
    const run = newRunTag('BAD');
    const sc = openScope({ run, psql: fn });
    let msg = '';
    try {
      sc.cleanupAndAssert();
    } catch (e) {
      msg = String(e?.message ?? '');
    }
    rec('Q6-throws-on-residue', msg.includes(run) && msg.includes('未归零'),
      `残留时抛出=${msg ? '是' : '否'}，错误信息含运行标记=${msg.includes(run)}（须都成立）`);
  }

  // ── Q7 行数不符必须抛错 ──────────────────────────────────────────────────
  {
    const { fn } = makeFakePsql({ byMark: [601, 602], childRows: {}, leftArchives: 0, stubborn: true });
    const run = newRunTag('CNT');
    const sc = openScope({ run, psql: fn });
    let msg = '';
    try {
      sc.cleanupAndAssert();
    } catch (e) {
      msg = String(e?.message ?? '');
    }
    rec('Q7-throws-on-count-mismatch', /行数不符/.test(msg) && msg.includes(run),
      `主档案删除行数不符时抛出=${/行数不符/.test(msg)}（防止"删了但删的不是本次的"）`);
  }

  // ── Q8 空范围不报错不删 ──────────────────────────────────────────────────
  {
    const { fn, log } = makeFakePsql({ byMark: [], childRows: {}, leftArchives: 0 });
    const sc = openScope({ run: newRunTag('EMPTY'), psql: fn });
    const r = sc.cleanupAndAssert();
    const anyDelete = log.some((s) => /DELETE FROM/i.test(s));
    rec('Q8-empty-scope-safe', r.clean && r.ids.length === 0 && !anyDelete,
      `本次无数据时 clean=${r.clean} ids=${JSON.stringify(r.ids)} 发出了 DELETE=${anyDelete}（须 false）`);
  }

  const fail = out.filter((r) => !r.ok);
  console.log(`\n汇总：PASS ${out.length - fail.length} / ${out.length}`);
  if (fail.length) {
    console.log('未通过：' + fail.map((f) => f.id).join(', '));
    process.exitCode = 1;
  }
}

main();
