/**
 * 迁移：`sms_logs` 增加 **供应商回执 ID**（Phase 10 / RB-8 · SMS delivery callback）。
 *
 * 新增列：
 *   provider_biz_id   varchar(64) NULL
 * 新增索引：
 *   sms_logs_provider_provider_biz_id
 *
 * ---------------------------------------------------------------------------
 * 🔴 为什么必须有这一列（这是本次迁移存在的**唯一**理由）
 * ---------------------------------------------------------------------------
 * 我们提交短信时把自己的 `biz_id` 作为 `OutId` 传给阿里云，所以 `biz_id` 是**我方**流水。
 * 而阿里云官方回执报文里**没有 OutId**：
 *
 *   · 官方 SMS webhook / SmsReport 报文字段（已抓取官方文档核对，见 docs/DEVIATIONS.md DEV-100）：
 *       To / Status / MessageId / SmsSize / TaskId / SendDate / ReceiveDate / ErrorCode / ErrorDescription
 *     —— **没有 OutId**；
 *   · 回执里的 `MessageId` 是阿里云自己的 **`BizId`**。官方 QuerySendDetails 文档原文：
 *       「BizId：发送回执 ID。即发送流水号，调用 SendSms 或 SendBatchSms 发送短信时，
 *         返回值中的 BizId 字段」。
 *
 * 而 `provider_request_id` 存的是 `RequestId`（API 调用追踪号）—— 与 `BizId` **不是同一个值**。
 *
 * ⇒ 如果不新增这一列，回执匹配只能拿 `biz_id` 或 `provider_request_id` 去比，
 *   **两者都永远匹配不上**。表现是"回执链路已上线、delivered 永远停在 pending" ——
 *   一种没有任何报错、只看数据发现不了的静默失效。
 *
 * ---------------------------------------------------------------------------
 * 为什么这一列**可空**、且不需要数据回填
 * ---------------------------------------------------------------------------
 * · 可空：历史行的 `provider_biz_id` 本来就无从得知（发送时没存），填任何值都是编造；
 *   缺这一列的行只能靠 `sent_at` 之后的新发送来补齐 —— 这是**诚实的空洞**，不是缺陷。
 * · 不回填：新列只对新发送生效，**没有可推导的历史值**。
 *   ⚠️ 与 `20260921-visit-lifecycle.ts` 不同：那一列能用历史 `service_result` 等字段**推导**，
 *      所以必须回填；这一列推导不出来，硬填等于造假。
 *
 * ---------------------------------------------------------------------------
 * 两条执行路径必须收敛到同一结果（与另三个迁移一致）
 * ---------------------------------------------------------------------------
 *   路径 A 全新实例：sync 按 collection 定义建列建索引 → 本迁移 DDL 全部 no-op。
 *   路径 B 既有实例：sync 补列 + 补索引（`ensure-indexes.ts` 也会对账）→ 本迁移 DDL 同样 no-op。
 *   ⇒ `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 在这里是**幂等保险**，
 *      保留理由与 visit-lifecycle 一致：显式写清期望形态，防 NocoBase 改默认行为。
 *
 * 索引名必须与 NocoBase 生成规则逐字一致（`<table>_<col1>_<col2>`），
 * 否则新装实例上会建出重复索引（visit-lifecycle 已踩过，见其文件头注释）。
 *
 * 失败语义：**抛出**。被 umzug 记为完成的迁移若静默失败，回执将永远匹配不上。
 */
import { Migration } from '@nocobase/database';

const TABLE = 'sms_logs';

const NEW_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'provider_biz_id', ddl: 'varchar(64)' },
];

const NEW_INDEXES: Array<{ name: string; ddl: string }> = [
  { name: `${TABLE}_provider_provider_biz_id`, ddl: `provider, provider_biz_id` },
];

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
        '[service-ticket/migration] 无法取得 db.sequelize（迁移上下文不完整），' +
          'sms_logs.provider_biz_id 未补写 —— 短信回执将无法匹配（RB-8）',
      );
    }

    for (const col of NEW_COLUMNS) {
      await sequelize.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${col.name}" ${col.ddl}`);
      log.info?.(`[migration] ${TABLE}.${col.name} 已就绪（${col.ddl}）`);
    }

    for (const idx of NEW_INDEXES) {
      await sequelize.query(`CREATE INDEX IF NOT EXISTS "${idx.name}" ON ${TABLE} (${idx.ddl})`);
      log.info?.(`[migration] 索引 ${idx.name} 已就绪（${idx.ddl}）`);
    }

    // ⚠️ 刻意**不回填** provider_biz_id：历史发送时没有存这个值，
    //    任何回填都是编造。缺失的行只能靠新发送自然补齐。
    //    这里显式记一笔，避免后来人以为"忘了回填"而加一段造假逻辑。
    const [pending] = await sequelize.query(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE provider_biz_id IS NULL AND send_status = 'accepted'`,
    );
    const rows = (pending as any)?.[0] ?? pending;
    const orphan = Number(rows?.n ?? 0);
    if (orphan > 0) {
      log.warn?.(
        `[migration] ${TABLE} 有 ${orphan} 条 accepted 但 provider_biz_id 为空的历史行 —— ` +
          '这些行永远收不到回执（发送时未记录 BizId），只能由新发送补齐。' +
          '如需补齐，只能重发一次短信，不能凭空回填。',
      );
    }
  }
}
