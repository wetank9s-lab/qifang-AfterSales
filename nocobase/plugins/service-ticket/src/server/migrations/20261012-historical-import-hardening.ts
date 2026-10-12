/**
 * 迁移：历史导入的**两项数据收口**（P11-3 第 4 项 · 用户 A.2 / A.3 条）
 * =============================================================================
 *
 * 这一段处理的是**已经躺在库里的历史行**，不是新逻辑。两件事：
 *
 *  ① **中文文件名乱码修复**（用户 A.3 条）
 *     现象：`æ±å®¶çµ9æœˆåŽŸå§‹æ°æ®.xlsx`（multipart 的 filename 被按 latin1 解释）。
 *     修法：`Buffer.from(name,'latin1').toString('utf8')`。
 *     🔴 只在**可逆**时修：还原结果里出现替换字符 U+FFFD，说明原串本来就是合法
 *        UTF-8（不该再转一次），跳过并如实记数。
 *     🔴 **不静默改历史**：每一条的 before/after 都写进审计
 *        （`service_settings` 的 `historical.file-name-repair.audit`）。
 *
 *  ② **去重键回填 + 重复批次作废**（用户 A.2 条）
 *     新逻辑要求 `dedup_key = sha256(文件哈希|上传者 id)` 唯一。
 *     历史行没有这个键，且**确实存在重复**（此前 `findOne({file_hash})` 的写法
 *     在"被变异的构建跑过"等情况下会产生同内容多批次 —— 本项目实测到了）。
 *     处理原则：
 *       · 同一 (hash, uploader) 分组内**保留 id 最小**的那条（最早），补上 dedup_key；
 *       · 其余的 **`stage='voided'` + dedup_key=NULL + note 记原因** ——
 *         **不删除**（原始层行仍在，可追溯），只是不再占用去重键。
 *
 * ⚠️ 本迁移**不碰**任何客户数据（`historical_import_rows.cells_json` 一个字节都不动）。
 *    它只动批次的**元数据**（文件名 / 去重键 / 阶段标记）。
 */
import { Migration } from '@nocobase/database';

const BATCHES = 'historical_import_batches';
const SETTINGS = 'service_settings';
const FILENAME_AUDIT_KEY = 'historical.file-name-repair.audit';
const DEDUP_AUDIT_KEY = 'historical.dedup-backfill.audit';

interface BatchRow {
  id: number;
  batch_no: string;
  file_name: string;
  file_hash: string;
  uploader_user_id: number | null;
  stage: string;
  dedup_key: string | null;
}

export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;
    const log = {
      info: (m: string) => app?.log?.info?.(m),
      warn: (m: string) => app?.log?.warn?.(m),
    };

    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error(
        '[service-ticket/migration] 无法取得 db.sequelize（迁移上下文不完整）—— ' +
          '历史导入的文件名与去重键未收口',
      );
    }

    const [rows] = await sequelize.query(
      `SELECT id, batch_no, file_name, file_hash, uploader_user_id, stage, dedup_key
         FROM ${BATCHES} ORDER BY id`,
    );
    const batches = ((rows as BatchRow[]) ?? []).filter(Boolean);
    if (batches.length === 0) {
      log.info?.('[migration] 历史导入批次表为空（全新库）—— 本迁移无事可做');
      return;
    }

    // -------------------------------------------------------------------------
    // ① 文件名乱码修复
    // -------------------------------------------------------------------------
    const fileNameRepairs: Array<{ id: number; batchNo: string; before: string; after: string }> = [];
    let fileNameSkipped = 0;

    for (const b of batches) {
      const before = String(b.file_name ?? '');
      if (!before) continue;
      const after = decodeLatin1AsUtf8(before);
      if (after === null || after === before) {
        fileNameSkipped += 1;
        continue;
      }
      await sequelize.query(`UPDATE ${BATCHES} SET file_name = $1 WHERE id = $2`, {
        bind: [after, b.id],
      });
      fileNameRepairs.push({ id: b.id, batchNo: String(b.batch_no), before, after });
    }

    if (fileNameRepairs.length > 0) {
      await writeAudit(sequelize, FILENAME_AUDIT_KEY, {
        repairedAt: new Date().toISOString(),
        repaired: fileNameRepairs.length,
        skipped: fileNameSkipped,
        // ⚠️ 只记**文件名**（它本身就是业务元数据，不含客户信息）；
        //    这里刻意不记 file_hash / 上传者，避免把审计变成第二份索引。
        items: fileNameRepairs,
      });
      log.info?.(
        `[migration] 中文文件名乱码修复：修好 ${fileNameRepairs.length} 条，跳过 ${fileNameSkipped} 条` +
          `（跳过的含义是"本来就是合法 UTF-8"，不是失败）`,
      );
    } else {
      log.info?.('[migration] 没有需要修复的文件名（非乱码或已修过）');
    }

    // -------------------------------------------------------------------------
    // ② 去重键回填 + 重复批次作废
    // -------------------------------------------------------------------------
    // ⚠️ 回填用的是**同一个算法**（`sha256(hash|uploader)`），但迁移里不能 import
    //    服务层代码（迁移在构建后独立执行，且不该依赖业务模块的演进）。
    //    ⇒ 这里用 node:crypto 重算一遍；两处的**一致性由验收脚本断言**
    //      （比较迁移回填的 dedup_key 与服务层现算的值），而不是靠"记得同步"。
    const { createHash } = await import('node:crypto');
    const buildKey = (hash: string, uploader: number | null): string =>
      createHash('sha256')
        .update(`${hash}|${uploader == null ? 'anonymous' : String(uploader)}`)
        .digest('hex');

    /** 已经处理过的键（同一事务内查重，避免依赖数据库的唯一索引是否已建好） */
    const claimed = new Set<string>();
    // 先把库里**已有** dedup_key 的行登记为已占用
    for (const b of batches) {
      if (b.stage !== 'voided' && b.dedup_key) claimed.add(String(b.dedup_key));
    }

    const voided: Array<{ id: number; batchNo: string; keptBatchNo: string }> = [];
    let backfilled = 0;

    for (const b of batches) {
      if (b.stage === 'voided') continue; // 已作废的不参与
      const key = buildKey(String(b.file_hash), b.uploader_user_id);

      if (b.dedup_key === key) continue; // 已经是正确的键

      if (claimed.has(key) && b.dedup_key !== key) {
        // 这个键已被更早的批次占用 ⇒ 本行是重复的，作废（**不删**）
        await sequelize.query(
          `UPDATE ${BATCHES} SET stage = 'voided', dedup_key = NULL,
             note = COALESCE(note, '') || $1 WHERE id = $2`,
          {
            bind: [
              `[migration:20261012] 与更早的同内容批次重复（同 file_hash + 同上传者），` +
                `保留最早一条，本条作废（原始行保留，未删除）`,
              b.id,
            ],
          },
        );
        voided.push({ id: b.id, batchNo: String(b.batch_no), keptBatchNo: '' });
        continue;
      }

      await sequelize.query(`UPDATE ${BATCHES} SET dedup_key = $1 WHERE id = $2`, {
        bind: [key, b.id],
      });
      claimed.add(key);
      backfilled += 1;
    }

    if (backfilled > 0 || voided.length > 0) {
      await writeAudit(sequelize, DEDUP_AUDIT_KEY, {
        appliedAt: new Date().toISOString(),
        backfilled,
        voided: voided.length,
        voidedItems: voided,
      });
      log.info?.(
        `[migration] 去重键回填 ${backfilled} 条；作废重复批次 ${voided.length} 条` +
          `（作废 ≠ 删除：原始行仍在，可在审计里查到是哪几条）`,
      );
    } else {
      log.info?.('[migration] 去重键无需回填');
    }

    // -------------------------------------------------------------------------
    // ③ 自检：作废的行必须**仍能查到**（"不删除"这件事要有断言，不能只写在注释里）
    // -------------------------------------------------------------------------
    const [stillThere] = await sequelize.query(
      `SELECT count(*)::int AS n FROM ${BATCHES} WHERE stage = 'voided'`,
    );
    const voidedCount = Number((stillThere as any)?.[0]?.n ?? 0);
    if (voidedCount !== voided.length && voided.length > 0) {
      // 库里本来可能就有 voided（人工作废的），所以只要求"不少于本次作废数"
      if (voidedCount < voided.length) {
        throw new Error(
          `[migration] 自检失败：本次作废 ${voided.length} 条，但库里只剩 ${voidedCount} 条 voided —— 疑似被删除`,
        );
      }
    }

    // ④ 自检：没有两行**在用**批次占用同一个 dedup_key
    const [dupKeys] = await sequelize.query(
      `SELECT dedup_key, count(*)::int AS n FROM ${BATCHES}
        WHERE stage <> 'voided' AND dedup_key IS NOT NULL
        GROUP BY dedup_key HAVING count(*) > 1`,
    );
    if (((dupKeys as any[]) ?? []).length > 0) {
      throw new Error(
        `[migration] 自检失败：仍有 ${(dupKeys as any[]).length} 个去重键被多个在用批次占用 —— ` +
          '唯一索引将无法建立',
      );
    }
  }

}

/** 供上面的方法体简写引用（TS 里 `this` 在类方法外不可用，故用具名包装） */
async function writeAudit(sequelize: any, key: string, payload: unknown): Promise<void> {
  const desc =
    key === FILENAME_AUDIT_KEY
      ? '中文文件名乱码修复审计（P11-3 第 4 项 · 用户 A.3 条）'
      : '去重键回填与重复批次作废审计（P11-3 第 4 项 · 用户 A.2 条）';
  await sequelize.query(
    `INSERT INTO ${SETTINGS} (created_at, updated_at, key, value, value_type, description, updated_by)
     VALUES (now(), now(), $1, $2, 'json', $3, 'migration:20261012')
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    { bind: [key, JSON.stringify(payload), desc] },
  );
}

/**
 * `latin1 → utf8` 还原。
 *
 * 判据（**必须双向**，否则会把本来正常的名字改坏）：
 *   ① 还原后的字符串**不含** U+FFFD（含则说明原串本就是合法 UTF-8）；
 *   ② 还原前后的**字节数**要能对上（`latin1` 编码回去应等于原串的字符数）；
 *   ③ 还原结果里**要有非 ASCII 字符**（全 ASCII 的名字根本不需要转，
 *      转了也只是幂等 —— 但仍然返回 null 以避免无意义写库）。
 *
 * @returns 修好的名字；不需要修 / 无法安全修时返回 `null`
 */
export function decodeLatin1AsUtf8(raw: string): string | null {
  if (!raw) return null;
  // 纯 ASCII：不可能有编码问题，跳过（顺便避免无意义 UPDATE）
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(raw)) return null;

  let decoded = '';
  try {
    decoded = Buffer.from(raw, 'latin1').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\uFFFD')) return null;
  // 还原后应出现真正的中文（否则说明这次转换没有产生可读文本）
  if (!/[\u4e00-\u9fa5]/.test(decoded)) return null;
  // 双向校验：把结果按 utf8 编码回去，应当与原串的 latin1 字节完全一致
  const roundTrip = Buffer.from(decoded, 'utf8').toString('latin1');
  if (roundTrip !== raw) return null;
  return decoded;
}
