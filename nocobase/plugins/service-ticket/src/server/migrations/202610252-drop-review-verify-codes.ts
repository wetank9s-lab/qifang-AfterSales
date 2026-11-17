import { Migration } from '@nocobase/database';

/**
 * P6-E-MIGRATION-02：取消 OTP 后的**向前**补偿迁移。
 *
 * 背景：`202610251-review-verify-codes` 的 `up()` 仍然会建表（历史不改），
 * 于是全新部署（插件启用）时会把它建出来。本迁移在其后把这张**已废弃**的表清掉。
 *
 * 安全底线（不是一句 DROP TABLE IF EXISTS 就算完）：
 *   ① 只认 `public.review_verify_codes`，且**结构必须与已取消的 OTP 表完全一致**
 *      （多一列/少一列都视为"不是我认识的那张表" ⇒ 拒绝）；
 *   ② **表内有任何行 ⇒ fail-closed 抛错**，绝不静默删数据；
 *      （被删掉的数据无法从 `down()` 恢复 —— 见下）
 *   ③ 无 CASCADE：不会连带删索引之外的东西，也不会牵动其它表；
 *   ④ 表不存在 ⇒ 正常跳过（no-op），保证已有环境可重复执行。
 *
 * ⚠️ `down()` **不具备恢复能力**：被 DROP 的数据不可重建。这里刻意不写"重建空表"
 *    之类的假可逆逻辑 —— 那只会让人误以为回滚能救回数据。
 */
const EXPECTED_COLUMNS = [
  'auth_consumed_at',
  'auth_expires_at',
  'auth_token_hash',
  'attempts',
  'code_hash',
  'consumed_at',
  'created_at',
  'expires_at',
  'id',
  'ticket_id',
];

export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const query = (sql: string, options?: any) => this.db.sequelize.query(sql, options);

    // ① 结构探测（限定 schema）
    const [rows] = await query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'review_verify_codes'
        ORDER BY column_name`,
    );
    const columns: string[] = (Array.isArray(rows) ? rows : []).map((r: any) => String(r.column_name));

    if (columns.length === 0) {
      // 表不存在 ⇒ 正常跳过（已有环境重复执行也是 no-op）
      return;
    }

    const missing = EXPECTED_COLUMNS.filter((c) => !columns.includes(c));
    const extra = columns.filter((c) => !EXPECTED_COLUMNS.includes(c));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `[migration 202610252] public.review_verify_codes 的结构与已取消的 OTP 表不一致` +
          `（缺少 ${missing.join(',') || '-'}；多出 ${extra.join(',') || '-'}）—— 拒绝删除`,
      );
    }

    // ② 数据探测：只要有一行就不动
    const [countRows] = await query(
      `SELECT count(*)::int AS n FROM public.review_verify_codes`,
    );
    const n = Number((Array.isArray(countRows) ? countRows[0] : null)?.n ?? -1);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('[migration 202610252] 无法确认 review_verify_codes 行数 —— 拒绝删除');
    }
    if (n > 0) {
      throw new Error(
        `[migration 202610252] review_verify_codes 仍有 ${n} 行数据（可能含需保留的测试证据）` +
          ' —— fail-closed，拒绝删除。请人工确认后再处理',
      );
    }

    // ③ 事务内 DROP（无 CASCADE）
    const trx = await this.db.sequelize.transaction();
    try {
      await query('DROP TABLE public.review_verify_codes', { transaction: trx });
      await trx.commit();
    } catch (error) {
      await trx.rollback().catch(() => undefined);
      throw error;
    }
  }

  async down(): Promise<void> {
    // ⚠️ 不可逆：被删除的表与数据无法恢复，这里不做任何"看起来能回滚"的事。
  }
}
