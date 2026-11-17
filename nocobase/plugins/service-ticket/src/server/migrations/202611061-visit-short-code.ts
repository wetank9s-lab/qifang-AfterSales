import { Migration } from '@nocobase/database';

/**
 * BE-03-SMS-TEMPLATE-02：给 `service_visits` 加**师傅短码**两列 + 唯一索引。
 *
 * 背景：师傅短信改用 22 位短链 `/p/t/{code}`。短码与长 Token 是同一张 Visit 上的
 * **两把钥匙**，共用同一套失效判定（过期 / 已用 / 吊销 / Visit 非 ASSIGNED / 工单非进行中），
 * 因此落在同一行上，而不是新开一张映射表 —— 独立表会引入"Visit 没了但映射还在"的悬挂态。
 *
 * 为什么列名不叫 `short_code`：库里**只存 sha256**，明文只在内存与短信里出现一次。
 * 与 `access_token_hash` 同为 `varchar(64)`（sha256 hex）。
 *
 * 为什么 `short_code_expires_at` 单独一列、不复用 `token_expires_at`：
 *   两者**当前**同口径（同一个 `ttlHours`），但短码是**后续补发**的产物 ——
 *   一条 Visit 的长 Token 可能早已签发、短码是几小时后才发的。
 *   复用一个列会让"短码还能用到什么时候"取决于长 Token 的签发时刻，
 *   从而**意外延长**短码有效期（用户明令不得延长）。分开存，边界清楚。
 *
 * 幂等：`ADD COLUMN IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`，可重复执行。
 *
 * ⚠️ 唯一索引必须在这里显式建：NocoBase 会静默丢弃 collection 级索引声明（DEV-16）。
 * ⚠️ `down()` 只删索引与列：短码是可重新签发的凭据，不需要"救回数据"；
 *    但**不要**在回滚时把已发出去的短码当成"还能用"——删列即全部失效，这是预期的。
 */
export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);

    await q(`ALTER TABLE service_visits ADD COLUMN IF NOT EXISTS short_code_hash varchar(64)`);
    await q(
      `ALTER TABLE service_visits ADD COLUMN IF NOT EXISTS short_code_expires_at timestamptz`,
    );

    // 唯一：一个短码只能指向一条 Visit（NULL 不参与唯一约束，未签发的行不受影响）
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_service_visits_short_code_hash
        ON service_visits (short_code_hash)
       WHERE short_code_hash IS NOT NULL
    `);
  }

  async down(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS uq_service_visits_short_code_hash`);
    await q(`ALTER TABLE service_visits DROP COLUMN IF EXISTS short_code_expires_at`);
    await q(`ALTER TABLE service_visits DROP COLUMN IF EXISTS short_code_hash`);
  }
}
