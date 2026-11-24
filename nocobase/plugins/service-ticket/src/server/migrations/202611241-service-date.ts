import { Migration } from '@nocobase/database';

/**
 * R2.2.4-rc.2（2026-11-24）：`service_date` —— 普通上门服务的**实际上门日期**。
 *
 * ===========================================================================
 * 为什么要单独一列，而不是复用 completed_at
 * ===========================================================================
 *   用户 §三 的原话：
 *     「原计划 2026-11-28，实际提前上门 2026-11-26 ⇒
 *       planned_date = 2026-11-28、service_date = 2026-11-26」
 *     「两者是独立字段，不能互相覆盖」「不要禁止实际日期早于计划日期」
 *     「实际日期未填写时不伪造为计划日期或当天」
 *
 *   `completed_at` **不能**承担这个角色，原因不是命名问题，是语义耦合：
 *     · 它由 `svc:archiveComplete` 在**完工动作**里写入，同时把 status 推到 completed；
 *     · 它带时分秒（timestamptz），而"哪天上门的"是 dateOnly 业务事实；
 *     · 一旦把它当可编辑字段，就出现"改了它等于做了完工"的歧义 ——
 *       正好是用户明令禁止的「编辑上门日期不等于执行完工操作」。
 *
 *   ⇒ 新列 `service_date`：dateOnly、可空、**只能**由 `svc:archiveUpdate` 修改，
 *     不参与任何状态流转，也不被完工动作自动写入（完工仍走 completed_at）。
 *
 * ===========================================================================
 * 历史数据怎么办：只回填"已完成"的档案
 * ===========================================================================
 *   已完工档案的实际上门日期，最可信的来源就是 `completed_at` ——
 *   那是当时师傅真正完工的那一刻，日期部分即实际服务日。
 *
 *   ⚠️ **只回填 status='completed' 且 service_date IS NULL 的行**：
 *     · 未完工的档案**没有**实际日期，不能凭空填 —— 用户明令"未填写时不伪造"；
 *     · 已有值的行不覆盖（迁移重跑不能改已有业务数据）。
 *
 *   ⚠️ `completed_at` 是 timestamptz，转 date 必须显式指定时区：
 *     用 `AT TIME ZONE 'Asia/Shanghai'` 再取日期。直接 `::date` 会按服务器
 *     时区截断，UTC 下 20:00 完工会被算成第二天 —— 对"哪天上门的"是错的。
 *
 * ===========================================================================
 * 回填能不能失败得响
 * ===========================================================================
 *   与 `202611201-archive-products-backfill.ts` 同一套做法：
 *   **两条 SELECT 夹一条 UPDATE**，判据是"已完工且仍为空的行数必须归零"。
 *   不依赖 `RETURNING`（SQLite 桩不支持，会给出失真读数 —— 那次教训见该文件）。
 */
export default class extends Migration {
  /** 必须 afterLoad：列由插件 loadCollections 建，默认时机会在建表之前跑 */
  on = 'afterLoad';

  async up() {
    const q = this.db.sequelize;

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

    /*
     * ① 回填前：已完工但 service_date 为空的行数。
     *    这个数就是"应当被回填"的量，也是后面判"能不能填"的依据。
     */
    const before = await countOf(
      `SELECT count(*)::int AS n
         FROM service_archives
        WHERE status = 'completed' AND service_date IS NULL`,
    );

    /*
     * ② 回填。
     *
     * `AT TIME ZONE 'Asia/Shanghai'` 不能省：completed_at 是带时区的时间戳，
     * 直接 ::date 会按数据库会话时区截断。业务在中国，统一按东八区取日。
     */
    await q.query(
      `UPDATE service_archives
          SET service_date = (completed_at AT TIME ZONE 'Asia/Shanghai')::date,
              updated_at = now()
        WHERE status = 'completed'
          AND service_date IS NULL
          AND completed_at IS NOT NULL`,
    );

    /* ③ 回填后对账：剩下的必须只剩"completed_at 为空"那批（正常应为 0） */
    const after = await countOf(
      `SELECT count(*)::int AS n
         FROM service_archives
        WHERE status = 'completed' AND service_date IS NULL AND completed_at IS NOT NULL`,
    );

    if (after !== 0) {
      // 失败必须响：留着不一致的库比抛错更危险（后面所有"实际日期"判断都基于它）
      throw new Error(
        `[202611241-service-date] 回填未完成：回填前 ${before} 行待填，回填后仍有 ${after} 行已完工却缺实际日期`,
      );
    }
  }
}
