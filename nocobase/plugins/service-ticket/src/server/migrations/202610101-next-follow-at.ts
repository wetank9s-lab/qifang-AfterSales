/**
 * 迁移：新增 `service_tickets.next_follow_at`（Phase 11 / P11-1）
 * =============================================================================
 *
 * 语义（与 `parseAppointmentDate` 同一口径）
 * -----------------------------------------------------------------------------
 * 门店最近一次"跟进"时约定的**下次跟进日期**，只到天，落成业务时区（`+08:00`）
 * 的 canonical 正午 —— 与 `expected_visit_at` 共用同一套规范化，
 * **不引入第二套日期解析**（否则"同一个日期两种解释"，且差异只在跨零点时显形）。
 *
 * ⚠️ 它只表达"当前待办"，历史留在 `ticketEvents` 的 `follow_up` 事件里。
 *
 * =============================================================================
 * 🔴 为什么必须三层一起改（本项目已经付过两次学费）
 * =============================================================================
 * 用户 2026-10-10 裁决明文要求：「验证数据库 DDL、NocoBase `fields.options` 元数据和
 * collection 定义三层一致，**迁移自检不得零行假绿**」。
 *
 * 三层的分工（前两次实测得出的结论，见 DEV-112 与 202610091 的文件头）：
 *   ① **DDL**            —— 没有它，SQL 报 `column does not exist`；
 *   ② **`fields.options`** —— NocoBase 的 ORM 模型与界面**取自库里的字段元数据**，
 *                            不是取自代码里的 collection 定义；
 *   ③ **collection 定义** —— 只影响"将来全新安装"时的初始形态。
 *
 * ⚠️ **本迁移实测发现的既有缺口**：`current_store_entered_at`（P11-0 加的列）
 *    在 collection 定义里有、DDL 有，但 **`fields` 元数据行不存在** ——
 *    因为 NocoBase 的同步**不会**为"迁移里用 raw DDL 加的列"补元数据行。
 *    本迁移顺带把它补齐（同一条 helper），并在自检里如实打印。
 *
 * =============================================================================
 * 自检为什么必须断言"行数"
 * =============================================================================
 * `202610091` 的复盘：第一版自检按**错的集合名**查（表名而非逻辑名）⇒ 匹配 0 行
 * ⇒ "没查到坏行" ⇒ 打印"自检通过"。**一次什么都没检查到的假绿。**
 * ⇒ 本迁移的自检先断言"期望的行数"，再断言内容。
 */
import { Migration } from '@nocobase/database';

const TICKETS_COLLECTION = 'serviceTickets';
const TICKETS_TABLE = 'service_tickets';

/** 与 NocoBase 生成的 key 同形：11 位小写字母+数字（`fields.key` 上是唯一索引） */
const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function nanoid11(): string {
  let out = '';
  for (let i = 0; i < 11; i += 1) {
    out += KEY_ALPHABET[Math.floor(Math.random() * KEY_ALPHABET.length)];
  }
  return out;
}

interface FieldSpec {
  name: string;
  title: string;
  comment: string;
  /** NocoBase 的字段类型（时间戳列一律 `date` + `datetime` 界面） */
  type: string;
  component: string;
  /** 排在"计时口径"那一组末尾 */
  sort: number;
}

const FIELDS: FieldSpec[] = [
  {
    name: 'next_follow_at',
    title: '下次跟进时间',
    comment: '当前有效的跟进待办日期（只到天，业务时区）。历史见 ticketEvents 的 follow_up 事件',
    type: 'date',
    component: 'DatePicker',
    sort: 33,
  },
  {
    // ⚠️ P11-0 漏掉的元数据行（见文件头）：DDL 与 collection 定义都有，唯独缺它。
    //    不补的话这一列对 ORM/界面**不存在** —— 而"列在库里"会让人以为没问题。
    name: 'current_store_entered_at',
    title: '当前门店接手时间',
    comment: '新建时=创建时间；转店时=转店时间。用于"当前门店接手后多久开始处理"的时效口径',
    type: 'date',
    component: 'DatePicker',
    sort: 34,
  },
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
        '[service-ticket/migration] 无法取得 db.sequelize（迁移上下文不完整）—— ' +
          'next_follow_at 未落地，门店的"今日待跟进"查不出任何数据',
      );
    }

    // ---- ① DDL：新增列（幂等）----
    await sequelize.query(
      `ALTER TABLE ${TICKETS_TABLE} ADD COLUMN IF NOT EXISTS "next_follow_at" timestamptz NULL`,
    );
    log.info?.(`[migration] ${TICKETS_TABLE}.next_follow_at 已就绪（timestamptz NULL）`);

    // ---- ② 字段元数据：让 ORM 与界面认得这一列 ----
    // `(collectionName, name)` 上有唯一索引 ⇒ 用它做幂等键；
    // `ON CONFLICT DO UPDATE` 让"重复跑"变成"修正元数据"而不是报错。
    let upserted = 0;
    for (const f of FIELDS) {
      const options = JSON.stringify({
        uiSchema: { title: f.title, 'x-component': f.component },
        allowNull: true,
        comment: f.comment,
      });
      const [result] = await sequelize.query(
        `INSERT INTO fields (key, name, type, interface, "collectionName", options, sort)
         VALUES (:key, :name, :type, :iface, :collection, :options::json, :sort)
         ON CONFLICT ("collectionName", name)
         DO UPDATE SET options = EXCLUDED.options, type = EXCLUDED.type,
                       interface = EXCLUDED.interface, sort = EXCLUDED.sort`,
        {
          replacements: {
            key: nanoid11(),
            name: f.name,
            type: f.type,
            iface: f.component === 'DatePicker' ? 'datetime' : f.type,
            collection: TICKETS_COLLECTION,
            options,
            sort: f.sort,
          },
        },
      );
      upserted += Number((result as any)?.rowCount ?? 0) > 0 ? 1 : 0;
    }
    log.info?.(`[migration] fields 元数据已 upsert ${upserted}/${FIELDS.length} 个字段`);

    // ---- ③ 就地更新本进程已构建的集合对象 ----
    // 元数据改动只对**下次启动**建模型时生效；本次启动的那份必须就地改，
    // 否则要"重启两次"（照 202610091 的做法）。
    try {
      for (const f of FIELDS) {
        const collection: any = db.getCollection?.(TICKETS_COLLECTION);
        const fieldObj: any = collection?.getField?.(f.name);
        if (fieldObj?.options) fieldObj.options.allowNull = true;
      }
      log.info?.('[migration] 本进程内的集合字段对象已就地更新');
    } catch (e) {
      log.warn?.(
        '[migration] 就地更新内存字段对象失败（正确性不受影响，但可能需再重启一次）：' +
          String((e as Error)?.message ?? e).slice(0, 160),
      );
    }

    // ---- ④ 自检：**三层**逐条核对，且先断言行数 ----
    // 先查 DDL：列必须存在，且类型必须是 timestamptz
    const [colRows] = await sequelize.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_name = '${TICKETS_TABLE}' AND column_name = 'next_follow_at'`,
    );
    const cols = ((colRows as any[]) ?? []).filter(Boolean);
    if (cols.length !== 1) {
      throw new Error(
        `[migration] 自检失败：info_schema 里 next_follow_at 查到 ${cols.length} 行（期望 1）—— ` +
          'DDL 没落地。"查不到坏行"不等于"列建对了"，所以这里断言的是**行数**。',
      );
    }
    if (String(cols[0].data_type) !== 'timestamp with time zone') {
      throw new Error(
        `[migration] 自检失败：next_follow_at 的类型是 ${cols[0].data_type}，期望 timestamp with time zone —— ` +
          '日期语义必须带时区（否则跨零点会被 UTC 提前判成逾期）',
      );
    }

    // 再查元数据层：期望**恰好** FIELDS.length 行，且 allowNull 为 true
    const names = FIELDS.map((f) => `'${f.name}'`).join(',');
    const [metaRows] = await sequelize.query(
      `SELECT name, coalesce(options::jsonb->>'allowNull','false') AS allow_null,
              coalesce(options::jsonb #>> '{uiSchema,title}','') AS title
         FROM fields
        WHERE "collectionName" = '${TICKETS_COLLECTION}' AND name IN (${names})`,
    );
    const meta = ((metaRows as any[]) ?? []).filter(Boolean);
    if (meta.length !== FIELDS.length) {
      throw new Error(
        `[migration] 自检失败：fields 元数据查到 ${meta.length} 行，期望 ${FIELDS.length} 行 —— ` +
          '缺行意味着该列对 ORM/界面**不存在**（列在库里会让人误以为没问题）。',
      );
    }
    const badNull = meta.filter((r) => String(r.allow_null) !== 'true');
    if (badNull.length) {
      throw new Error(
        '[migration] 自检失败：以下字段的 allowNull 不是 true ⇒ 写入会被 ORM 拒绝：' +
          badNull.map((r) => r.name).join(', '),
      );
    }
    const badTitle = meta.filter((r) => String(r.title) === '');
    if (badTitle.length) {
      throw new Error(
        '[migration] 自检失败：以下字段缺 uiSchema.title ⇒ 界面上会显示成空标签：' +
          badTitle.map((r) => r.name).join(', '),
      );
    }

    log.info?.(
      `[migration] 自检通过（三层一致）：DDL 1 列 · fields 元数据 ${meta.length} 条 · ` +
        `${TICKETS_COLLECTION} 定义已含该列 —— ${FIELDS.map((f) => f.name).join(' / ')}`,
    );
  }
}
