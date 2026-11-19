#!/usr/bin/env node
/**
 * test-data-scope.mjs —— 测试数据清理的**保护范围**工具（R2.2.1 第三节）。
 *
 * ===========================================================================
 * 它解决的具体事故
 * ===========================================================================
 * 2026-11-18：`verify-save-is-publish.mjs` 第一次跑，throw 发生在
 * "拿到 archiveCreate 响应、但还没 parse 出 id" 的那一步。
 * 因为 try 还没进，`finally` **不会执行** —— 库里留下一条
 * `R221PUBLISH验收`（id=370），最后靠手工 SQL 才清掉。
 *
 * 根因不是"忘了写清理"，而是**清理的触发点依赖"已经取到 id"这一前提**，
 * 而事故恰好发生在这个前提之前。
 *
 * ===========================================================================
 * 四条设计决定（对应指令第三节 1–7 条）
 * ===========================================================================
 * ① **运行标记先于数据产生**。`newRunTag()` 在**任何写操作之前**调用，
 *    并立刻写进 `customer_name` / `note` 等可见文本字段。
 *    这样"取不到 id"也能靠标记找回 —— 标记是唯一不依赖 id 的锚。
 *
 * ② **保护范围先于清理**。`openScope()` 返回的对象里固定了 表清单 + 定位字段，
 *    不允许清理时临时决定删什么。
 *
 * ③ **只按 id 或运行标记删**。`cleanup()` 里**没有任何**按手机号/姓名/时间删的分支。
 *    这是硬约束：`13900003401` 这类号码在库里对应**真实业务档案**，
 *    按号码删会误伤历史数据，而且删完不会有任何报错。
 *
 * ④ **清理结果必须回归核对 + 异常必须抛出**。`cleanup()` 返回逐表行数与残留计数，
 *    由调用方断言"残留全 0"；抛出时把运行标记一起打出来，便于人工接管。
 *
 * ===========================================================================
 * 用法
 * ===========================================================================
 *   import { newRunTag, openScope } from '../scripts/lib/test-data-scope.mjs';
 *
 *   const RUN = newRunTag('HVAC');        // 写操作之前
 *   const scope = openScope({ run: RUN, psql });
 *   try {
 *     const id = await create(...);       // 立刻登记
 *     scope.track(id);
 *     ...
 *   } finally {
 *     const r = scope.cleanup();          // 无条件执行
 *     scope.assertClean(r);               // 残留必须为 0
 *   }
 *
 * ⚠️ 这个模块**不做**任何业务判断，只做"记账 + 精确删除 + 核对"。
 *    它不引入新的测试框架，也不接管调用方的断言逻辑。
 */
import crypto from 'node:crypto';

/** 一条档案的关联表（删主表前必须先删这些） */
const ARCHIVE_CHILD_TABLES = [
  'service_archive_photos',
  'service_archive_events',
  'service_archive_stages',
];

/**
 * 生成本次运行的唯一标记。
 *
 * 形如 `R221HVAC7F3A2B` —— 前缀让人一眼看出"这是哪一轮哪个脚本造的"，
 * 随机段保证同一脚本连跑两次不会互相干扰（第 1 条要求）。
 *
 * ⚠️ 标记**只用大写字母与数字**：它会出现在 `customer_name` 里，
 *    带下划线/连字符会让"按标记 LIKE 查询"在自然语言文本里误命中
 *    （例如名字里本来就有 `-` 的情况）。
 */
export function newRunTag(prefix = 'T') {
  const p = String(prefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'T';
  return `R221${p}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * 打开一个清理保护范围。
 *
 * @param {object} opts
 * @param {string} opts.run    运行标记（必须已经写进数据文本字段）
 * @param {(sql:string)=>string} opts.psql  执行 SQL 并返回 stdout（调用方注入，避免本模块绑死 docker）
 * @param {string} [opts.markColumn] 标记所在列，默认 `customer_name`
 */
export function openScope({ run, psql, markColumn = 'customer_name' }) {
  if (!run || String(run).length < 8) {
    throw new Error('openScope 需要一个真实的运行标记（至少 8 位）—— 空标记会让清理范围变成"全表"');
  }
  if (typeof psql !== 'function') throw new Error('openScope 需要注入 psql 执行函数');

  const ids = new Set();
  /** 本次真实的创建记录：id → 说明（第 3 条：记录真正创建了什么） */
  const created = new Map();

  return {
    run,
    /** 登记一条本次创建的档案 id。非正整数直接忽略（拿不到 id 时不要编一个） */
    track(id, note = '') {
      const n = Number(id);
      if (Number.isInteger(n) && n > 0) {
        ids.add(n);
        created.set(n, note);
      }
      return this;
    },
    get ids() {
      return [...ids];
    },
    get createdCount() {
      return ids.size;
    },

    /**
     * 定位：本次 id 集合 ∪ 按运行标记查到的 id。
     *
     * 第二项是"取不到 id"事故的解药 —— 只要标记写进了文本字段，
     * 即使调用方从没成功 track 过任何东西，也能把数据找回来。
     */
    resolve() {
      const found = new Set(ids);
      const byMark = String(
        psql(
          `SELECT coalesce(string_agg(id::text, ','), '') FROM service_archives ` +
            `WHERE ${markColumn} LIKE '%${run}%';`,
        ),
      ).trim();
      for (const s of byMark.split(',')) {
        const n = Number(s);
        if (Number.isInteger(n) && n > 0) found.add(n);
      }
      return [...found];
    },

    /**
     * 精确清理。**只按 id 删**，没有按手机号/姓名/时间的任何分支。
     * @returns {{ids:number[], rows:Record<string,number>}}
     */
    cleanup() {
      const list = this.resolve();
      if (list.length === 0) return { ids: [], rows: {} };
      const inList = list.join(',');
      const rows = {};
      for (const t of ARCHIVE_CHILD_TABLES) {
        rows[t] = Number(
          psql(`WITH d AS (DELETE FROM ${t} WHERE archive_id IN (${inList}) RETURNING 1) SELECT count(*) FROM d;`),
        );
      }
      rows.service_archives = Number(
        psql(`WITH d AS (DELETE FROM service_archives WHERE id IN (${inList}) RETURNING 1) SELECT count(*) FROM d;`),
      );
      return { ids: list, rows };
    },

    /** 清理后回归核对（第 6 条）：逐表残留计数 */
    verify(list) {
      const arr = Array.isArray(list) && list.length ? list : this.resolve();
      if (arr.length === 0) return { archives: 0, photos: 0, events: 0, stages: 0 };
      const inList = arr.join(',');
      const left = { archives: Number(psql(`SELECT count(*) FROM service_archives WHERE id IN (${inList});`)) };
      for (const t of ARCHIVE_CHILD_TABLES) {
        const key = t.replace('service_archive_', '').replace(/s$/, '') + 's';
        left[key === 'photoss' ? 'photos' : key] = Number(
          psql(`SELECT count(*) FROM ${t} WHERE archive_id IN (${inList});`),
        );
      }
      return left;
    },

    /**
     * 清理 + 核对一步到位。抛错时**带上运行标记**（第 7 条：异常必须显式报告）。
     */
    cleanupAndAssert() {
      const { ids: list, rows } = this.cleanup();
      if (list.length === 0) {
        return { ids: [], rows, left: {}, clean: true };
      }
      const left = this.verify(list);
      const clean = Object.values(left).every((n) => n === 0);
      if (!clean) {
        throw new Error(
          `测试数据清理未归零（运行标记 ${run}，ids=${JSON.stringify(list)}，残留=${JSON.stringify(left)}）` +
            ' —— 请按标记人工核对，不要按手机号删。',
        );
      }
      if (rows.service_archives !== list.length) {
        throw new Error(
          `测试数据清理行数不符（运行标记 ${run}）：期望删 ${list.length} 条主档案，实际 ${rows.service_archives} 条`,
        );
      }
      return { ids: list, rows, left, clean };
    },
  };
}
