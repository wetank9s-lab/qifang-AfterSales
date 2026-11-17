import { Migration } from '@nocobase/database';

/**
 * BE-03-MANUAL-TECH-LINK（2026-11-07）：给 `service_visits` 加 **门店手动转发码**的四个列
 * 与它的人工码唯一索引。
 *
 * ===========================================================================
 * 为什么需要这一步（为什么不复用 short_code_hash）
 * ===========================================================================
 * 门店经常需要自己把作业链接发给师傅（电话里说、微信里发），而 `short_code_hash`
 * 里存的只是 sha256 —— 已发出的短信链接**在原理上取不回来**（"明文只活一次"是本项目的硬约束）。
 *
 * 若让门店点一下「复制」就**重新签发**一枚短信短码，结果是覆盖那一列 ⇒
 * **师傅手机里那条短信立刻失效**。用户 2026-11-07 明令禁止：
 * "门店查看、复制手动链接，不影响原短信链接有效性。"
 *
 * ⇒ 只能并存第三套凭据：可**重算**（salt + epoch → HMAC），因此重复查看恒得同一枚码，
 *   而它自己的失效又完全复用 Visit 上那一套状态（改派/取消/已用/过期）。
 *
 * ===========================================================================
 * 为什么四列都要（少一列就少一条性质）
 * ===========================================================================
 *   · `manual_code_salt`       —— **生成输入**。没有它就无法重算出同一枚码，
 *                                "复制十次得到同一条链接"就退化成"每次换一条"；
 *   · `manual_code_hash`       —— **查询键**。没有它，`/p/t/<code>` 只能全表逐行 HMAC，
 *                                那是容量缺陷（DEV-207 在客户进度码上已经踩过：5000 行 14.5ms 且线性）；
 *   · `manual_code_expires_at` —— **独立 TTL**。短信短码过期不该连带手动码，
 *                                反之亦然；但两者都取 `min(token_expires_at, 自己)` ⇒ 不延长授权；
 *   · `manual_code_epoch`      —— **族级撤销**。重新签发手动码时 +1，只影响这一族。
 *
 * ===========================================================================
 * ⚠️ 唯一索引为什么在这里建、而不是靠 `unique: true`
 * ===========================================================================
 * 两个原因，都来自已经付过代价的事故：
 *
 *  ① **DEV-208**：NocoBase 的 `sync-runner.handleUniqueIndex()` 会遍历**所有单字段唯一索引**，
 *     只要该属性在集合定义里没有声明 `unique: true` 就 `removeIndex()`。
 *     反向地，若声明在字段级，索引是否存活就受"集合定义与迁移谁先说"的版本差异影响 ——
 *     而它**丢失时不会报错**，只会让查询退化成 Seq Scan。
 *  ② 本列**必须允许 NULL 且允许大量 NULL**（未签发的 Visit 全是 NULL）。
 *     PG 的唯一索引对 NULL 是"互不相等"，所以多行 NULL 合法 ——
 *     但这一点只有写在**建索引的同一处**才看得见。
 *
 * ⇒ 迁移里显式建，且 `up()` **每次都自我修复**（先查 `pg_indexes`，缺了就建）。
 *   这条纪律来自 2026-11-06 的事故：迁移已登记为"执行过"就**永不重跑**，
 *   于是"第一次因数据问题跳过"会变成**永久缺失**，而日志里只留一句"按预期未创建"。
 *
 * 不做回填：历史 Visit 从没有过手动码，NULL 才是真实语义。
 * 首次 `ensureManualCode()` 会就地写入盐与 hash（自愈），因此本迁移是 O(1) 的 DDL。
 */
export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);

    // ---- 1) 加列（IF NOT EXISTS ⇒ 幂等，可重复执行）----
    await q(`ALTER TABLE service_visits ADD COLUMN IF NOT EXISTS manual_code_salt varchar(64)`);
    await q(`ALTER TABLE service_visits ADD COLUMN IF NOT EXISTS manual_code_hash varchar(64)`);
    await q(`ALTER TABLE service_visits ADD COLUMN IF NOT EXISTS manual_code_expires_at timestamptz`);
    await q(`ALTER TABLE service_visits ADD COLUMN IF NOT EXISTS manual_code_epoch integer DEFAULT 0`);

    // ---- 2) 唯一索引（自愈式：先查存在性，缺了才建）----
    //
    // ⚠️ 为什么不直接 `CREATE UNIQUE INDEX IF NOT EXISTS` 就完事：
    //    那样也幂等，但**无法区分"本来就有"与"刚补上"**，日志里看不出发生过修复。
    //    先查再建，让"这条索引曾经丢过"成为一条可观测的事实（与 DEV-208 的教训一致）。
    const [existing] = (await q(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'service_visits'
         AND indexname = 'service_visits_manual_code_hash_key'
    `)) as unknown as [Array<{ indexname: string }>];

    if (!existing || existing.length === 0) {
      await q(`
        CREATE UNIQUE INDEX service_visits_manual_code_hash_key
          ON service_visits (manual_code_hash)
      `);
      console.log('[migration 202611065] 已创建唯一索引 service_visits_manual_code_hash_key');
    } else {
      console.log('[migration 202611065] 唯一索引 service_visits_manual_code_hash_key 已存在，跳过');
    }

    // ---- 3) 反向验证用的一次性检查：列必须真的在（不抛错，只留痕）----
    //
    // 为什么这里要"再查一遍刚加过的列"：本轮出过"日志说建好了、实际没建"的事故
    // （2026-11-06 DEV-208：迁移声称"按预期未创建"，索引确实不存在）。
    // 读回来一条事实比相信 DDL 返回码更可靠。
    const [cols] = (await q(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'service_visits'
         AND column_name IN ('manual_code_salt','manual_code_hash','manual_code_expires_at','manual_code_epoch')
       ORDER BY column_name
    `)) as unknown as [Array<{ column_name: string }>];
    console.log(
      `[migration 202611065] service_visits 手动码列：${(cols ?? []).map((c) => c.column_name).join(', ') || '(无)'}`,
    );
  }

  async down(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);
    // 先删索引再删列（列被索引引用时 PG 会拒绝）
    await q(`DROP INDEX IF EXISTS service_visits_manual_code_hash_key`);
    await q(`ALTER TABLE service_visits DROP COLUMN IF EXISTS manual_code_epoch`);
    await q(`ALTER TABLE service_visits DROP COLUMN IF EXISTS manual_code_expires_at`);
    await q(`ALTER TABLE service_visits DROP COLUMN IF EXISTS manual_code_hash`);
    await q(`ALTER TABLE service_visits DROP COLUMN IF EXISTS manual_code_salt`);
  }
}
