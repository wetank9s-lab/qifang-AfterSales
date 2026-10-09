/**
 * 迁移：把 service_visits 三个"责任字段"的**库内元数据**放开为可空（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 为什么必须单独一个迁移（而不是并进 20261009-store-workflow-fields）
 * ===========================================================================
 * 前一个迁移**已经被记录为执行过**，而迁移一经应用就**不可变**
 * —— 改它会造成"文件内容与库里实际跑过的不一致"，下次有人重建库时
 * 得到的东西与现网不同，且没有任何报错。所以新增步骤一律另起一个迁移。
 *
 * ===========================================================================
 * 🔴 这个迁移存在的唯一理由（实测踩到，最费时间的一处）
 * ===========================================================================
 * 前一个迁移已经把 DDL 的 `NOT NULL` 去掉了，但派工仍然报：
 *
 * ```
 * notNull Violation: serviceVisits.technician_mobile cannot be null,
 * notNull Violation: serviceVisits.expected_visit_at cannot be null,
 * notNull Violation: serviceVisits.technician_name cannot be null
 * ```
 *
 * 根因：**NocoBase 的 ORM 模型取自库里的字段元数据**（`fields` 表的
 * `options.allowNull`），**不是**取自我们代码里的 collection 定义。
 * 已存在的集合，代码定义只在 `install` 时被写入库；之后**库里的那份说了算**。
 *
 * ⇒ 只改代码（`collections/serviceVisits.ts`）或只改 DDL，Sequelize 层照样拦。
 *    三者必须一起改：
 *      ① DDL 的 NOT NULL   （前一个迁移）
 *      ② 库里的字段元数据   （本迁移）
 *      ③ 代码里的定义       （`collections/serviceVisits.ts`，供将来全新安装）
 *
 * 本迁移还**就地**放开当前进程已构建的 Sequelize 模型属性 ——
 * 否则要「重启两次」才生效，而"要重启两次"这种事没人记得住。
 */
import { Migration } from '@nocobase/database';

const VISITS_TABLE = 'service_visits';
// NOTE: fields.collectionName stores the LOGICAL collection name (serviceVisits),
// NOT the table name (service_visits). Using the table name matched 0 rows and the
// self-check also used the same wrong name, so '0 rows' was reported as PASS -
// a vacuous green. The self-check now also asserts row count.
const VISITS_LOGICAL_NAME = 'serviceVisits';
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
          'service_visits 的责任字段在 ORM 层仍是必填，provider-only 派工会被拒',
      );
    }

    // ---- ② 库里的字段元数据：allowNull → true ----
    // 只改**当前为 false** 的行（幂等；已经是 true 的不动，避免把运维的调整覆盖掉）。
    //
    // ⚠️ 两处 cast 都是必需的（实测报 `COALESCE could not convert type jsonb to json`）：
    //    · `fields.options` 列的类型是 **json**，而 `jsonb_set` 只吃 jsonb
    //      ⇒ 入参要 `options::jsonb`，出参要再 `::json` 写回；
    //    · 判据也用 `coalesce(options::jsonb->>'allowNull','false')` 统一到文本比较。
    const [result] = await sequelize.query(
      `UPDATE fields
          SET options = (jsonb_set(coalesce(options::jsonb, '{}'::jsonb), '{allowNull}', 'true'::jsonb))::json
        WHERE "collectionName" = '${VISITS_LOGICAL_NAME}'
          AND name IN (${VISIT_NULLABLE_COLUMNS.map((c) => `'${c}'`).join(',')})
          AND coalesce(options::jsonb->>'allowNull', 'false') IS DISTINCT FROM 'true'`,
    );
    const n = Number((result as any)?.rowCount ?? 0);
    log.info?.(`[migration] fields 元数据已放开 ${n} 个字段的 allowNull（ORM 模型取自库元数据）`);

    // ---- ③ 就地放开本进程已构建的模型属性 ----
    // 元数据改动只对**下次启动**建模型时生效；本次启动的模型必须就地改，
    // 否则要重启两次。判据：Sequelize 的字段校验读 `model.rawAttributes[field].allowNull`。
    try {
      const collection: any = db.getCollection?.(VISITS_TABLE);
      for (const col of VISIT_NULLABLE_COLUMNS) {
        const attr = collection?.model?.rawAttributes?.[col];
        if (attr) {
          attr.allowNull = true;
          if (attr.validate) attr.validate.notNull = undefined;
        }
        const fieldObj = collection?.getField?.(col);
        if (fieldObj?.options) fieldObj.options.allowNull = true;
      }
      log.info?.('[migration] 本进程内 Sequelize 模型已就地放开（避免"要重启两次"）');
    } catch (e) {
      log.warn?.(
        '[migration] 就地放开内存模型失败（正确性不受影响，但可能需要再重启一次才生效）：' +
          String((e as Error)?.message ?? e).slice(0, 160),
      );
    }

    // ---- 自检：元数据真的改到了吗 ----
    //
    // 🔴 **必须同时断言"查到了 3 行"**，不能只看"有没有 bad"。
    //    第一版用了错的集合名（表名而非逻辑名）⇒ WHERE 匹配 0 行 ⇒ bad 为空
    //    ⇒ 打印"自检通过"。**一次空过的假绿**：自检什么都没检查到，却说通过。
    //    ⇒ 凡是"按名字查一批行再判断"的自检，都要先断言**行数**。
    const [rows] = await sequelize.query(
      `SELECT name, options->>'allowNull' AS allow_null
         FROM fields
        WHERE "collectionName" = '${VISITS_LOGICAL_NAME}'
          AND name IN (${VISIT_NULLABLE_COLUMNS.map((c) => `'${c}'`).join(',')})`,
    );
    const list = ((rows as any[]) ?? []).filter(Boolean);
    if (list.length !== VISIT_NULLABLE_COLUMNS.length) {
      throw new Error(
        `[migration] 自检查到的字段行数不符：期望 ${VISIT_NULLABLE_COLUMNS.length} 行，实际 ${list.length} 行 —— ` +
          '集合名可能写错（fields.collectionName 用的是**逻辑名** serviceVisits，不是表名 service_visits）。' +
          '这种情况下"没查到坏行"不等于"都是好的"。',
      );
    }
    const bad = list.filter((r) => String(r.allow_null) !== 'true');
    if (bad.length) {
      throw new Error(
        '[migration] 以下字段的 allowNull 仍不是 true，provider-only 派工会被 ORM 拒绝：' +
          bad.map((r) => `${r.name}=${r.allow_null}`).join(', '),
      );
    }
    log.info?.(`[migration] 自检通过：${list.length} 个责任字段在库元数据层已可空`);
  }
}
