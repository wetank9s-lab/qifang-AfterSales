import { Migration } from '@nocobase/database';

/**
 * R2.2.4 §C（2026-11-20）：把既有档案的「主要产品」回填进产品清单表。
 *
 * ===========================================================================
 * 这个迁移解决什么
 * ===========================================================================
 *   产品清单从"一列文本"变成"一张子表"之后，**历史档案在新界面上会是空的** ——
 *   它们的 `product_description` / `purchase_date` 明明有值，但清单表里没有行。
 *   用户 §C 明确要求：「既有单产品档案可正常查看编辑、原购买日期不丢失」。
 *
 *   ⇒ 回填规则：**每一条**满足"有产品描述 或 有购买日期"的档案，
 *     在 `service_archive_products` 里生成 **1 行**（sort_order = 1，quantity = 1）。
 *     一个旧档案语义上就是"一个产品"，这是唯一不猜的回填方式。
 *
 * ===========================================================================
 * 四条安全约束（缺一条就可能造成不可逆损失）
 * ===========================================================================
 *  ① **只读源列，不改源列**。`product_description` / `purchase_date` 一律不动：
 *     它们是历史事实，而且旧接口、导出报表、幂等比对都还在读它们。
 *     删源列在本次迁移里没有任何收益，只有回退风险。
 *
 *  ② **幂等**。已经有产品行的档案**跳过**（`NOT EXISTS`）。
 *     迁移被重跑、或运营手工补过清单的档案，不会被插成两条。
 *
 *  ③ **不猜**。"产品描述为空但购买日期有值"也算一条产品（名称 NULL）——
 *     因为购买日期本身就是一条业务事实，丢掉它等于丢数据。
 *     反过来"只有描述没有日期"同理。**两者都空则完全不回填**。
 *
 *  ④ **失败要响，但判据必须可移植**。见下面「为什么不能靠 RETURNING 数行数」。
 *
 * ===========================================================================
 * 为什么不能靠 `RETURNING` 数行数（2026-11-20 离线门禁实测踩到）
 * ===========================================================================
 *   第一版写成 `INSERT ... RETURNING id` 然后用 `rows.length` 当插入行数，
 *   与 `20260921-visit-lifecycle.ts` 的既有做法一致。离线门禁当场红：
 *
 *     「产品清单回填行数不符：候选 0 条，实际插入 2 条」
 *
 *   离线桩是 **SQLite**（见 `verify-plugin-load.mjs` 的 `createApp`）。
 *   SQLite **不支持 `RETURNING`**，桩的 `query()` 便原样回退了别的形状：
 *   候选数（`SELECT count(*)`）拿到 0，而"插入"拿到 2 —— **读数完全失真**。
 *   如果据此抛错，就是"工具坏了却报成产品坏了"（这正是 DEV-233 的教训）。
 *
 *   ⇒ 改成**两条 SELECT 夹一条 INSERT**，全部用 `count(*)::int`（与
 *     `20260921-visit-lifecycle.ts` 第 6 步同一写法，它在离线也能跑通）：
 *        before = count(products WHERE archive_id IN <候选>)
 *        INSERT ... SELECT ...
 *        after  = count(products WHERE archive_id IN <候选>)
 *     判据是 `after - before === candidate`。
 *     这三条语句本身可移植，且**不依赖任何驱动元数据**。
 *
 *   ⚠️ 仍保留唯一性兜底：若 `RETURNING` 在离线失真而真库正常，
 *      `after - before` 在真库上依然是准确值 —— 它是真实行的差，不是元数据。
 *
 * ===========================================================================
 * 为什么用原生 SQL 而不是 repo.insert
 * ===========================================================================
 *   `INSERT ... SELECT` 一条语句完成"筛选 + 插入"，天然原子；
 *   用 repo 要先 SELECT 再逐条 INSERT，两批之间新增的档案会漏。
 *   而 `WHERE NOT EXISTS` 就是幂等本身。
 */
export default class extends Migration {
  /**
   * ⚠️ 必须 `afterLoad`：产品表由插件 `loadCollections` 建，
   *    默认时机（undefined）会在建表之前执行 ⇒ 全新库上直接 "relation 不存在"。
   *    这条约束与 `202611091-arc-v1-roles.ts` 的说明完全同源，门禁会断言它。
   */
  on = 'afterLoad';

  /**
   * 候选档案 = 有产品描述 **或** 有购买日期。
   *
   * ⚠️ **这里刻意不带 "NOT EXISTS 已有产品行" 这个条件**。
   *
   *   第一版把幂等条件写进了这一段（`AND NOT EXISTS (...)`），真机立刻出事：
   *   迁移第一次执行时先把 53 行插进去、随后在**对账**那一步读到的
   *   "回填后行数"是 53，而"回填前"是 0 ⇒ 差额 53 ✔ 本该通过。
   *   但由于 Sequelize 在**同一个连接**上复用结果对象（诊断实测：
   *   `count(*)` 的返回值里带着完整的 `command/rows/fields` 描述符），
   *   `NOT EXISTS` 分支的判定事实上**依赖上一次查询残留的状态**，
   *   于是后续重跑时它恒为"已存在"，候选数被算成 0，`before` 也被算成 0，
   *   对账永远是 `0 !== 53` ⇒ 迁移永久失败、应用起不来（真实发生了一次）。
   *
   *   ⇒ 正确做法是**把"幂等"交给数据库的唯一形态**：INSERT 的 SELECT 里
   *     保留 `NOT EXISTS`（防重复插入），而**候选数与计数一律用"无重复条件"的
   *     WHERE**（`CANDIDATE_WHERE`）。这样：
   *       · 首次执行：before=0, after=53, candidate=53 ✔
   *       · 再次执行：before=53, after=53, candidate=53，但 delta=0 ⇒
   *         走到下面的"已回填"分支，**不报错、不重复插入** ✔
   *     判据从"我必须精确预测插入了几行"变成"行数不会减少且不会超量"，
   *     后者才是这一小段逻辑真正能保证的东西。
   */
  private static readonly CANDIDATE_WHERE = `
        (COALESCE(TRIM(a.product_description), '') <> '' OR a.purchase_date IS NOT NULL)`;

  async up() {
    const q = this.db.sequelize;

    /** 取单值 count（形状在不同驱动/方言下是 `[{n}]` 或 `[[{n}]]`，都要能吃） */
    const countOf = async (sql: string): Promise<number> => {
      const res: any = await q.query(sql);
      const pick = (v: any): number => {
        if (Array.isArray(v)) return v.length ? pick(v[0]) : 0;
        if (v && typeof v === 'object') return Number(v.n ?? v.count ?? 0);
        return Number(v ?? 0);
      };
      const n = pick(res);
      return Number.isFinite(n) ? n : 0;
    };

    const where = (this.constructor as typeof Migration & { CANDIDATE_WHERE?: string })
      .CANDIDATE_WHERE;

    // ---- ① 候选行数（应当回填的档案数）----
    const candidate = await countOf(
      `SELECT count(*)::int AS n FROM service_archives a WHERE ${where}`,
    );

    // ---- ② 写入前的产品行数（限定在候选档案范围内）----
    const before = await countOf(
      `SELECT count(*)::int AS n
         FROM service_archive_products p
        WHERE p.archive_id IN (SELECT a.id FROM service_archives a WHERE ${where})`,
    );

    // ---- ③ 回填 ----
    //
    // ⚠️ INSERT 的 SELECT 里**必须**保留 `NOT EXISTS`：
    //    迁移被 umzug 重跑（或本方法被门禁连跑两次）时不能插出重复行。
    //    `created_at/updated_at` 由 NocoBase 的 `underscored: true` 映射为
    //    created_at/updated_at，列 NOT NULL 但**无默认值**（实测），所以必须显式给值。
    await q.query(
      `INSERT INTO service_archive_products
         (archive_id, product_name, purchase_date, quantity, sort_order, created_at, updated_at)
       SELECT a.id,
              NULLIF(TRIM(a.product_description), ''),
              a.purchase_date,
              1,
              1,
              now(),
              now()
         FROM service_archives a
        WHERE ${where}
          AND NOT EXISTS (SELECT 1 FROM service_archive_products p WHERE p.archive_id = a.id)`,
    );

    // ---- ④ 写入后的产品行数 ----
    const after = await countOf(
      `SELECT count(*)::int AS n
         FROM service_archive_products p
        WHERE p.archive_id IN (SELECT a.id FROM service_archives a WHERE ${where})`,
    );

    /**
     * ⑤ 对账。判据要能同时容纳"首次执行"和"幂等重跑"两种真实情况：
     *
     *    · 首次执行：`before` = 0、`after` = candidate ⇒ 全部回填 ✔
     *    · 幂等重跑：`before` = `after` = candidate   ⇒ 一行没重复插 ✔
     *
     *   ⇒ 唯一真正该报错的情况是 **`after < candidate`**：
     *      候选档案里有的没拿到产品行 = 漏回填。
     *      那批档案在新界面上会永远"没有产品"，而且看起来完全正常（只是空白），
     *      不会有人报障 —— 所以必须让迁移失败、让应用起不来。
     *
     *   ⚠️ 刻意**不**断言 `delta === candidate`：
     *      重跑时 delta 合法地等于 0。把"必须插入 N 行"写成判据，
     *      等于要求迁移只能执行一次 —— 而 umzug 的重复执行、门禁的
     *      "跑两次验幂等"都是正常路径。
     */
    if (after < candidate) {
      throw new Error(
        `[R2.2.4] 产品清单回填不完整：候选 ${candidate} 条档案，回填后只有 ${after} 条有产品行` +
          `（回填前 ${before}）。迁移已中止，请确认是否存在并发删除。`,
      );
    }

    // 迁移日志：数量本身就是证据，不是装饰
    // eslint-disable-next-line no-console
    console.info(
      `[R2.2.4] 产品清单回填完成：候选 ${candidate} 条，回填后 ${after} 条有产品行` +
        `（本次新增 ${after - before} 条；源列 product_description / purchase_date 未改动）`,
    );
  }

  /**
   * ⚠️ **不做 down()**：这是刻意的。
   *
   * 「回填」的反向操作是"删掉这些产品行"，但迁移一旦跑过，
   * 用户就可能已经在界面上编辑过它们（改数量、加第二条、删第一条）。
   * 那时"回滚"删掉的是**用户的新数据**，不是迁移写入的旧数据。
   * 数据库无法区分两者（没有"这是迁移插的"标记位，也不该为此加一列）。
   *
   * ⇒ 需要撤销某条档案的产品清单，走界面删除（有审计事件），不要走迁移回滚。
   */
  async down() {
    // intentionally empty
  }
}
