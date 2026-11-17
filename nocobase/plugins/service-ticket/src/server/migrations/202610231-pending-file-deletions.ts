import { Migration } from '@nocobase/database';

/**
 * TECH-PHOTO-DELETE-STORAGE-01 · 阶段一：持久化文件清理任务表。
 *
 * 为什么需要这张表：`deletePhoto` 先删 DB 行，文件清理若失败（EACCES/EIO/进程崩溃），
 * 旧实现只打一条日志就完了 ⇒ 文件永久残留。有了任务表，"要删什么"在**事务内**落库，
 * 进程怎么崩都还能被消费者重新捡起来。
 *
 * 幂等：全部 `IF NOT EXISTS`，重复执行安全。
 * ⚠️ 回滚**不要** DROP TABLE（会丢未完成的清理意图）——优先"停消费者、保留表"。
 */
export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS pending_file_deletions (
        id              bigserial PRIMARY KEY,
        storage_key     varchar(512) NOT NULL,
        object_type     varchar(32)  NOT NULL DEFAULT 'technician_photo',
        status          varchar(16)  NOT NULL DEFAULT 'PENDING',
        attempts        integer      NOT NULL DEFAULT 0,
        next_attempt_at timestamptz  NOT NULL DEFAULT now(),
        lease_owner     varchar(64),
        lease_until     timestamptz,
        last_error      varchar(200),
        created_at      timestamptz  NOT NULL DEFAULT now(),
        updated_at      timestamptz  NOT NULL DEFAULT now()
      )
    `);
    // 幂等入队：同一 storage_key 在"未完成"期间只允许一条
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pfd_active_key
        ON pending_file_deletions(storage_key)
        WHERE status IN ('PENDING','PROCESSING','RETRY')
    `);
    await q(`CREATE INDEX IF NOT EXISTS ix_pfd_due ON pending_file_deletions(status, next_attempt_at)`);
  }

  async down(): Promise<void> {
    // 刻意不 DROP：见文件头。只把索引去掉，保留数据供人工核对。
    const q = (sql: string) => this.db.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS ai_pfd_due`).catch(() => undefined);
    await q(`DROP INDEX IF EXISTS ix_pfd_due`).catch(() => undefined);
  }
}
