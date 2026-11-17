import { Migration } from '@nocobase/database';

/**
 * DEV-207（2026-11-06）：给 `service_tickets` 加 **`progress_code_hash`** —— 派生短码的查询索引键。
 *
 * ===========================================================================
 * 为什么需要这一步
 * ===========================================================================
 * A4 第一版把"派生码 → 工单"实现成扫描：
 *   取所有 `progress_code_salt IS NOT NULL` 的行 → 逐行重算 HMAC → 定长比对。
 * 上界 `DERIVE_SCAN_CAP = 5000`，实测 5000 行 ≈ 14.5ms 且线性增长。
 * 后果：工单量逼近 5000 后，**派生码会整体变成 401**，而且与"码真的错了"无法区分。
 * 这是容量硬上限，不能带进生产。
 *
 * 修法：额外存 `sha256(派生码)`，建唯一索引 ⇒ 解析退化为 B-tree 等值查找，O(log N)。
 * **不存明文**：sha256 单向，与 `progress_token_hash` 同一纪律。
 *
 * ===========================================================================
 * 为什么 salt 与 hash 两个都要留（不是冗余）
 * ===========================================================================
 *   · `progress_code_salt` = **生成输入** ⇒ 服务端能随时重算出同一条链接（可重发性）
 *   · `progress_code_hash` = **查询键**   ⇒ 给定一枚码能直接定位（可查找性）
 * 只有 hash 没有 salt ⇒ 发不出"和上次一模一样"的链接，进展通知会每次换码；
 * 只有 salt 没有 hash ⇒ 只能扫描。
 *
 * ===========================================================================
 * 回填策略（用户验收第 5 条："已有派生码必须无损迁移"）
 * ===========================================================================
 * "无损"的含义是：**回填前后，同一张工单的派生码必须完全一样**。
 * 因此回填**不能**重新生成 salt，只能用已有的 (id, salt, epoch) 重算 —— 这正是
 * `ProgressService.deriveCode()` 的确定性所在。若这里另造一套算法，旧链接立刻全废。
 *
 * 三条设计约束：
 *   ① **分批**（BACKFILL_BATCH = 500）：生产可能有数万条带 salt 的行，
 *      一次性 UPDATE 会长时间持锁 + 巨量 WAL，阻塞线上写入。
 *   ② **幂等可续跑**：只处理 `progress_code_hash IS NULL` 的行。
 *      中断后重跑不会重复处理，也不会写错已有值。
 *   ③ **单行失败不拖垮整批**：某一行的 salt 非法（历史上可能有人手工改过库）时，
 *      只跳过该行并记录，不抛错 —— 否则一条脏数据会让整个迁移卡死。
 *      这些行在下次 `ensureDerivedCode()` 被调用时会自动补齐（就地自愈）。
 *
 * ⚠️ **SIGN_SECRET 必须与"当初派生时"一致**：
 *    回填算的是 `HMAC(SIGN_SECRET, "progress-code|id|salt|epoch")`。
 *    若此刻环境里的密钥与旧链接签发时不同，回填出来的 hash 对应的是**新码**，
 *    而客户手里的是**旧码** ⇒ 旧链接查不到（401）。
 *    这是**预期行为**：密钥轮换本来就意味着旧派生码失效（见报告 §10）。
 *    未做回填的行不会更好 —— 它们在索引里根本不存在，同样查不到。
 *    所以迁移不会"因为密钥不对而破坏原本能用的东西"，只是没有额外救回旧码的能力。
 */

/** 与 `PROGRESS_DERIVE.BACKFILL_BATCH` 保持一致；这里写死是为了不引入运行时 import 依赖 */
const BATCH = 500;

/** 与 `PROGRESS_DERIVE.DOMAIN` 一致 */
const DOMAIN = 'progress-code';

export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);

    await q(`ALTER TABLE service_tickets ADD COLUMN IF NOT EXISTS progress_code_hash varchar(64)`);

    // 唯一索引 —— 与字段级 `unique: true` 生成的名字一致（`<table>_<col>_key`）。
    //
    // ⚠️ 为什么这里要写、而 `progress_code_salt` 的索引不用写：
    //    DEV-206 的教训是"集合定义和 migration 各写一遍同一列的索引 ⇒ 重复"。
    //    但两者情形不同：
    //      · `db.sync()` 只给**已声明的字段**建索引；本迁移**先**加列，
    //        此刻集合定义里已有该字段 ⇒ sync 会建。
    //    因此这里的 IF NOT EXISTS 是**幂等的兜底**：若 sync 已建则什么都不做，
    //    若因版本差异没建（或本次是先跑迁移后 sync）则补上。
    //    验收里有一条专门断言"该列只有 1 条索引"，防止这个兜底反而制造重复。
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS service_tickets_progress_code_hash_key
        ON service_tickets (progress_code_hash)
    `);

    // ---- 分批回填 ----
    const secret = String(process.env.SIGN_SECRET ?? '').trim();
    if (!secret) {
      // 没有密钥就**不能**回填。不抛错（否则整个应用起不来），
      // 而是留痕：这些行的 hash 保持 NULL，等 `ensureDerivedCode()` 在下一次使用时自愈。
      console.log(
        '[migration 202611063] SIGN_SECRET 缺失，跳过 progress_code_hash 回填；' +
          '相关工单将在下次派生时自动补齐',
      );
      return;
    }

    // 延迟 require：迁移文件被 esbuild 打进同一个 bundle，这里直接 require crypto 即可
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('node:crypto') as typeof import('node:crypto');

    const derive = (id: number, salt: string, epoch: number): string => {
      const message = `${DOMAIN}|${id}|${salt}|${epoch}`;
      const digest = crypto.createHmac('sha256', secret).update(message).digest();
      return digest.subarray(0, 16).toString('base64url');
    };
    const hashOf = (code: string): string =>
      crypto.createHash('sha256').update(code).digest('hex');

    let total = 0;
    let skipped = 0;
    for (;;) {
      // 只取"有盐但没 hash"的行 —— 幂等：已回填的不会重复出现
      const [rows] = (await q(`
        SELECT id, progress_code_salt, progress_code_epoch
          FROM service_tickets
         WHERE progress_code_salt IS NOT NULL
           AND progress_code_hash IS NULL
         ORDER BY id
         LIMIT ${BATCH}
      `)) as unknown as [Array<{ id: string | number; progress_code_salt: string; progress_code_epoch: number }>];

      if (!rows || rows.length === 0) break;

      const pairs: Array<{ id: number; hash: string }> = [];
      for (const r of rows) {
        const id = Number(r.id);
        const salt = String(r.progress_code_salt ?? '').trim();
        const epoch = Number.isFinite(Number(r.progress_code_epoch))
          ? Math.max(0, Math.trunc(Number(r.progress_code_epoch)))
          : 0;
        if (!Number.isFinite(id) || id <= 0 || !salt) {
          skipped += 1;
          continue;
        }
        pairs.push({ id, hash: hashOf(derive(id, salt, epoch)) });
      }

      // 逐行 UPDATE（而不是一条大 CASE）—— 每行独立，一行脏数据不会连累同批的其它行
      for (const p of pairs) {
        await q(
          `UPDATE service_tickets SET progress_code_hash = ${quote(p.hash)} WHERE id = ${p.id}`,
        );
      }
      total += pairs.length;

      console.log(
        `[migration 202611063] 已回填 progress_code_hash ${total} 行（本批 ${pairs.length}，跳过 ${skipped}）`,
      );

      // 本批取到的不够一个整批 ⇒ 已经到底了
      if (rows.length < BATCH) break;
    }

    console.log(
      `[migration 202611063] progress_code_hash 回填完成：共 ${total} 行` +
        (skipped > 0 ? `，跳过 ${skipped} 行（salt 非法或 id 异常，等下次派生自愈）` : ''),
    );
  }

  async down(): Promise<void> {
    const q = (sql: string) => this.db.sequelize.query(sql);
    // 先删索引再删列（列被索引引用时 PG 会拒绝）
    await q(`DROP INDEX IF EXISTS service_tickets_progress_code_hash_key`);
    await q(`ALTER TABLE service_tickets DROP COLUMN IF EXISTS progress_code_hash`);
  }
}

/** 只用于生成本迁移内部的字面量；hash 是 16 进制，理论上无需转义，仍做一次保险 */
function quote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
