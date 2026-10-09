/**
 * 迁移：Phase 11 / P11-0 —— 责任形态放宽 + 当前门店接手时间
 *
 * 本迁移做两件事，分别对应契约的两条硬要求：
 *
 * ## ① `service_visits`：技师三项**放宽为可空**（契约 §8.3）
 *
 * 原假设是「技师姓名 / 手机 / 预计上门日期**永远非空**」，并把它固化成了
 * 数据库的 `NOT NULL`。但现实业务允许：
 *
 * > 门店只知道"已报给海尔售后 / 美的售后 / 某第三方服务商"，**不知道具体师傅**。
 *
 * 在 `NOT NULL` 下，门店为了过校验只能**编一个假姓名 / 假手机号**，
 * 而假数据会污染后续的对账、追责、回访 —— 用户明确要求
 * 「**不得为了过校验逼员工填假姓名 / 假手机号**」。
 *
 * 三种责任形态（与 `TicketService.assertDispatchInput` / `VisitService.create`
 * 里的**条件校验同一口径**，三处必须一致）：
 *
 * | service_mode | technician_name | technician_mobile | expected_visit_at | Token |
 * |---|---|---|---|---|
 * | `inhouse` | 必填 | 必填且合法 | 必填 | 必须有 |
 * | `manufacturer` / `third_party` | 可空 | 可空 | 可空 | **为空** |
 * | `remote` | 为空 | 为空 | 为空 | **为空** |
 *
 * ⚠️ 放宽 `NOT NULL` 只是**允许**为空；"什么时候必须填"由服务层的条件校验保证。
 *    把规则留在**一处**（服务层）而不是散在 DDL 与代码两处，是刻意的：
 *    DDL 表达不了"按 service_mode 分支"。
 *
 * ## ② `service_tickets`：新增 `current_store_entered_at`（契约 §5.4）
 *
 * 语义：
 *   · 新建服务单 → 等于创建时间
 *   · 转入新门店 → 更新为**转店时间**
 *   · `first_response_at` **不因转店重置**（它记整个生命周期的首次真实响应）
 *
 * 为什么要这一列：转店后总部要能分别分析
 *   「**全局**首次响应」与「**当前门店**接手后多久开始处理」。
 * 只有一个 `first_response_at` 时，一家新接手的门店会因为"上一家早就响应过"
 * 而在时效看板上显示得**很好看** —— 而它其实一直没人动。
 *
 * ## 回填说明（为什么这次回填是**如实的**，不是编造）
 *
 * `current_store_entered_at` 对历史行回填为 `created_at`：
 *   历史工单**从未发生转店**（转店是本次才引入的语义），所以"当前门店接手时间"
 *   在事实上**就是创建时间**。这不是猜测，是这段历史的真实内容。
 *   （对照：`provider_biz_id` 那次**刻意不回填**，因为那个值当时压根没记录，
 *    任何回填都是编造。两次的区别是"事实是否存在"，不是"能不能填"。）
 */
// ⚠️ 必须从 `@nocobase/database` 导入 `Migration`（**不是** `@nocobase/server`）：
//    `build-plugin.mjs` 的产物自检会拦下错误来源 —— 实测报
//    「迁移产物 … 未以外部依赖方式引用 @nocobase/database（Migration 基类）」。
//    从 `@nocobase/server` 导入时，esbuild 会把整个 server 包内联进产物，
//    于是运行时可能拿到**与宿主不同的第二个 Migration 基类实例**，
//    表现为"迁移被静默跳过"（类不在宿主的 instanceof 体系里）—— 没有报错，只是不执行。
import { Migration } from '@nocobase/database';

const TICKETS_TABLE = 'service_tickets';
const VISITS_TABLE = 'service_visits';

/** 要放宽为可空的列（契约 §8.3） */
const VISIT_NULLABLE_COLUMNS = ['technician_name', 'technician_mobile', 'expected_visit_at'];

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
          'P11-0 的责任形态放宽与 current_store_entered_at 未落地',
      );
    }

    // ---- ① 放宽 service_visits 的三列 ----
    // `DROP NOT NULL` 本身幂等（对已可空的列是空操作），无需 IF NOT EXISTS 判别。
    //
    // ⚠️ **只改 DDL 是不够的**（实测踩到：DDL 已放宽，派工仍报
    //    `notNull Violation: serviceVisits.technician_mobile cannot be null`）：
    //    NocoBase 的 ORM 模型取自**库里的字段元数据**（`fields.options.allowNull`），
    //    而不是我们代码里的 collection 定义。该补齐由**下一个迁移**
    //    `20261009b-visit-fields-allow-null.ts` 负责。
    //    为什么不补在本文件里：本迁移**已经被记录为执行过**，
    //    改它会造成"文件内容与库里实际跑过的不一致"（迁移不可变），
    //    所以新增步骤一律另起一个迁移。
    for (const col of VISIT_NULLABLE_COLUMNS) {
      await sequelize.query(`ALTER TABLE ${VISITS_TABLE} ALTER COLUMN "${col}" DROP NOT NULL`);
      log.info?.(`[migration] ${VISITS_TABLE}.${col} 已放宽为可空（provider-only / remote 形态）`);
    }

    // ---- ② 新增 current_store_entered_at ----
    await sequelize.query(
      `ALTER TABLE ${TICKETS_TABLE} ADD COLUMN IF NOT EXISTS "current_store_entered_at" timestamptz NULL`,
    );
    log.info?.(`[migration] ${TICKETS_TABLE}.current_store_entered_at 已就绪（timestamptz NULL）`);

    // 回填：历史工单从未转店 ⇒ 当前门店接手时间**就是**创建时间。
    // 只填 NULL 行（幂等），且**不覆盖**已由转店写入的值。
    //
    // ⚠️ 列名是 `created_at`（snake_case）**不是** `createdAt`：
    //    本仓库的集合都开 `underscored: true`，时间戳列落成 snake_case。
    //    第一版按 NocoBase 默认的 `"createdAt"` 写 ⇒ 迁移在**这一句**上报
    //    `column "createdAt" does not exist`，于是"前三句成功了、回填没做"——
    //    一种**半完成**的迁移（列有了、数据还是 NULL），比整句失败更难发现。
    //    ⇒ 迁移脚本里的列名必须按**本仓库实际 DDL**写，不能照抄框架默认命名。
    const [, affected] = await sequelize.query(
      `UPDATE ${TICKETS_TABLE}
          SET current_store_entered_at = created_at
        WHERE current_store_entered_at IS NULL`,
    );
    const n = Number((affected as any)?.rowCount ?? (affected as any) ?? 0);
    log.info?.(
      `[migration] current_store_entered_at 回填 ${Number.isFinite(n) ? n : '若干'} 行` +
        '（依据：这批工单从未转店 ⇒ 当前门店接手时间就是创建时间；**不是**猜测性回填）',
    );

    // 索引：总部"当前门店接手后多久没动"的排序/筛选会用到
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS "${TICKETS_TABLE}_current_store_entered_at_idx"
         ON ${TICKETS_TABLE} (current_store_entered_at)`,
    );

    // 自检：放宽是否真的生效（DDL 没落地时**必须报错**，不能让服务层以为可以传 null）
    const [rows] = await sequelize.query(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = '${VISITS_TABLE}'
          AND column_name IN (${VISIT_NULLABLE_COLUMNS.map((c) => `'${c}'`).join(',')})`,
    );
    const list = (rows as any[]) ?? [];
    const stillNotNull = list.filter((r) => String(r.is_nullable).toUpperCase() === 'NO');
    if (stillNotNull.length) {
      throw new Error(
        `[migration] 以下列仍然 NOT NULL，provider-only 形态会被数据库拒绝：` +
          stillNotNull.map((r) => r.column_name).join(', '),
      );
    }
    log.info?.(`[migration] 自检通过：${VISIT_NULLABLE_COLUMNS.join(', ')} 均已可空`);
  }
}
