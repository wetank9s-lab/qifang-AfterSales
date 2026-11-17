/**
 * 持久化文件清理任务的消费者（TECH-PHOTO-DELETE-STORAGE-01 阶段二）。
 *
 * 认领模型：
 *   · `FOR UPDATE SKIP LOCKED` 只在一个**短事务**里认领，绝不跨越文件 I/O；
 *   · 认领即写 lease_owner + lease_until（2 分钟租约），到期可被他人重新认领；
 *   · 更新状态用 lease_owner 做 **fencing**：过期消费者的写会被 WHERE 挡掉（0 行受影响），
 *     因此不会覆盖新认领者的结果。
 *
 * 结果语义（来自 PhotoService.removeByStorageKey）：
 *   deleted / absent → COMPLETED（absent = 文件本来就不在，幂等成功）
 *   skipped          → RETRY（仍有引用，不宣称物理清理成功）
 *   throw            → attempts 已 +1；<5 次 RETRY（退避），否则 FAILED
 *
 * 故障注入：FILE_DELETE_CRASH_AFTER_UNLINK=1 时，在 unlink 成功后、写 COMPLETED 前
 * 直接 process.exit(1)，用于验证「文件已删、任务未标记」的中断场景（S12）。
 * ⚠️ 该开关只在隔离环境使用，生产默认不设。
 */
const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [60, 300, 900, 3600, 21600];

export interface SweepDeps {
  db: any;
  photos: { removeByStorageKey(key: string): Promise<'deleted' | 'absent' | 'skipped'> };
  logger?: { info?: Function; warn?: Function; error?: Function };
}

export async function runFileDeletionSweep(
  deps: SweepDeps,
  options: { batch?: number; owner?: string } = {},
) {
  const { db, photos, logger } = deps;
  const owner = options.owner ?? `consumer-${process.pid}-${Date.now()}`;
  const batch = Math.max(1, Math.min(50, options.batch ?? 10));

  // ① 短事务认领（SKIP LOCKED + 租约过期可重新认领）
  const [rows] = await db.sequelize.query(
    `WITH due AS (
       SELECT id FROM pending_file_deletions
        WHERE (status IN ('PENDING','RETRY') AND next_attempt_at <= now())
           OR (status = 'PROCESSING' AND lease_until < now())
        ORDER BY next_attempt_at
        LIMIT :batch
        FOR UPDATE SKIP LOCKED
     )
     UPDATE pending_file_deletions p
        SET status = 'PROCESSING',
            lease_owner = :owner,
            lease_until = now() + interval '${LEASE_SECONDS} seconds',
            attempts = p.attempts + 1,
            updated_at = now()
       FROM due
      WHERE p.id = due.id
     RETURNING p.id, p.storage_key, p.attempts`,
    { replacements: { owner, batch } },
  );
  const claimed = (rows ?? []) as Array<{ id: string; storage_key: string; attempts: number }>;
  if (!claimed.length) return { owner, claimed: 0, completed: 0, retried: 0, failed: 0 };

  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (const row of claimed) {
    let outcome: string;
    try {
      outcome = await photos.removeByStorageKey(String(row.storage_key));
    } catch (error) {
      const attempts = Number(row.attempts) || 1;
      const summary = `storage_error: ${String((error as Error)?.message ?? '').slice(0, 120)}`;
      if (attempts >= MAX_ATTEMPTS) {
        await guardedUpdate(db, owner, row.id, Number(row.attempts), { status: 'FAILED', last_error: summary });
        failed += 1;
        logger?.error?.(`[file-deletion] FAILED id=${row.id}（已 ${attempts} 次）`);
      } else {
        const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
        await guardedUpdate(db, owner, row.id, Number(row.attempts), {
          status: 'RETRY',
          last_error: summary,
          next_attempt_at_sql: `now() + interval '${delay} seconds'`,
        });
        retried += 1;
      }
      continue;
    }

    if (outcome === 'skipped') {
      await guardedUpdate(db, owner, row.id, Number(row.attempts), {
        status: 'RETRY',
        last_error: 'referenced_by_active_record',
        next_attempt_at_sql: `now() + interval '1 hour'`,
      });
      retried += 1;
      continue;
    }

    // deleted / absent ⇒ 物理目标已达成
    // S12 的崩溃注入已按令**移除**：正式产物不含任何 process.exit 测试路径。
    //   需要复现"文件已删、任务未完成"时，用 chmod 目录制造 EACCES 即可，不靠代码后门。
    const changed = await guardedUpdate(db, owner, row.id, Number(row.attempts), {
      status: 'COMPLETED',
      last_error: null,
    });
    if (changed) completed += 1;
  }

  logger?.info?.(
    `[file-deletion] owner=${owner} claimed=${claimed.length} done=${completed} retry=${retried} failed=${failed}`,
  );
  return { owner, claimed: claimed.length, completed, retried, failed };
}

/** fencing：只有当前认领者能改状态（过期消费者 0 行受影响） */
async function guardedUpdate(
  db: any,
  owner: string,
  id: string,
  attempts: number,
  patch: { status: string; last_error?: string | null; next_attempt_at_sql?: string },
): Promise<number> {
  const sets = ['status = :status', 'updated_at = now()'];
  const replacements: Record<string, unknown> = { id, owner, attempts, status: patch.status };
  if (patch.last_error !== undefined) {
    sets.push('last_error = :last_error');
    replacements.last_error = patch.last_error;
  }
  if (patch.next_attempt_at_sql) sets.push(`next_attempt_at = ${patch.next_attempt_at_sql}`);
  // fencing 三重：id + 认领者 + **attempts（单调版本）**。
  //   attempts 在每次认领时 +1，天然是"第几次认领"的版本号；
  //   过期消费者手里的 attempts 已过期 ⇒ 0 行受影响，无法覆盖新轮次。
  const [, affected] = await db.sequelize.query(
    `UPDATE pending_file_deletions SET ${sets.join(', ')}
      WHERE id = :id AND lease_owner = :owner AND status = 'PROCESSING'
        AND attempts = :attempts`,
    { replacements },
  );
  return Number(affected ?? 0);
}
