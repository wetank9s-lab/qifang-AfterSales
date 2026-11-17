/**
 * ⚠️ **已撤销（CANCELLED，2026-10-25）**：短信验证码方案被产品裁决撤销（P6-E-NO-OTP-01）。
 *    该迁移**保留在历史里**（隔离库已执行，不能假装从未发生）；
 *    表 `review_verify_codes` 暂不 DROP，等数据清理授权。
 *    代码侧不再引用此表（ReviewVerifyService 已删除）。
 */
import { Migration } from '@nocobase/database';

/**
 * P6-E-OTP-01：客户评价短信验证码 + 短时一次性评价授权。
 *
 * 一行 = 一次「申请验证码 → 校验 → 授权」的完整生命周期：
 *   code_hash         —— 6 位验证码的 sha256（**不存明文**）
 *   attempts          —— 已尝试次数（≥5 即作废，防爆破）
 *   expires_at        —— 验证码有效期（默认 5 分钟）
 *   consumed_at       —— 验证码被成功校验的时间（一次性）
 *   auth_token_hash   —— 校验通过后签发的**短时一次性评价授权**（sha256）
 *   auth_expires_at   —— 授权有效期（默认 5 分钟）
 *   auth_consumed_at  —— 授权被评价提交消费的时间（原子消费，防重放）
 *
 * 幂等：全部 IF NOT EXISTS，重复执行安全。
 * ⚠️ 回滚不要 DROP：未消费的授权会丢，优先"停服务、留表"。
 */
export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS review_verify_codes (
        id                bigserial PRIMARY KEY,
        ticket_id         bigint      NOT NULL,
        code_hash         varchar(64) NOT NULL,
        attempts          integer     NOT NULL DEFAULT 0,
        expires_at        timestamptz NOT NULL,
        consumed_at       timestamptz,
        auth_token_hash   varchar(64),
        auth_expires_at   timestamptz,
        auth_consumed_at  timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS ix_rvc_ticket ON review_verify_codes(ticket_id, created_at DESC)`);
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rvc_auth
        ON review_verify_codes(auth_token_hash)
        WHERE auth_token_hash IS NOT NULL
    `);
  }

  async down(): Promise<void> {
    // 刻意不 DROP TABLE（见文件头）：只删索引。
    const q = (sql: string) => this.db.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS ix_rvc_ticket`).catch(() => undefined);
    await q(`DROP INDEX IF EXISTS uq_rvc_auth`).catch(() => undefined);
  }
}
