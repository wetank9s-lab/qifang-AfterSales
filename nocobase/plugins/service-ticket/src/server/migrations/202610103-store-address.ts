/**
 * 迁移：门店对外资料 —— `stores.address`（Phase 11 / P11-1 · 客户 H5 整改 A1）
 * =============================================================================
 *
 * 来源：用户 2026-10-10 的产品决定 —— H5 的门店信息卡要显示
 * **门店名称 / 门店电话 / 门店地址**三项，并且明确要求
 * 「门店电话、地址需要从**真实门店资料**读取……**不编造**电话和地址」。
 *
 * 核对结果（**如实记录，因为它是本次交付的一部分**）：
 *   · `stores` 表原先**没有地址列** ⇒ 本迁移补上；
 *   · `stores.contact_phone` **列早就有**（Phase 1 起），
 *     但**实测 15 家门店全部为 NULL** —— 也就是说"电话"这一项**当前没有真实数据**。
 *     ⚠️ 我没有、也不会为它编造任何值：页面在没有值时**不渲染该行**（优雅降级），
 *        缺口作为待办交给用户补真实资料。
 *
 * 三层一致（与 `202610102` 同一套纪律，逐层自检且**先断行数**）：
 *   ① DDL（`ALTER TABLE … ADD COLUMN IF NOT EXISTS`）
 *   ② `fields` 元数据（`ON CONFLICT ("collectionName", name) DO UPDATE`）
 *   ③ 集合定义（`collections/stores.ts`，供将来全新安装）
 *   第 ④ 层（页面 `FIELD_GROUPS`）由 `scripts/verify-schema-layers.mjs` 静态盯住。
 *
 * ⚠️ 本次刻意**不动** `contact_phone` 的元数据：它已经存在且形态正确，
 *    改它的 options 属于"顺手扩大变更面"（而"电话当前为空"是**数据**问题，不是元数据问题）。
 */
import { Migration } from '@nocobase/database';

const STORES_COLLECTION = 'stores';
const STORES_TABLE = 'stores';

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function nanoid11(): string {
  let out = '';
  for (let i = 0; i < 11; i += 1) {
    out += KEY_ALPHABET[Math.floor(Math.random() * KEY_ALPHABET.length)];
  }
  return out;
}

const FIELD = {
  name: 'address',
  title: '门店地址',
  comment: '对客户公开的门店地址；H5 门店信息卡展示。留空则页面不显示该行',
  type: 'string',
  pgType: 'character varying',
  ddl: 'varchar(200) NULL',
  interface: 'input',
  component: 'Input',
  allowNull: true,
  sort: 39,
};

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
          'stores.address 未落地，H5 门店信息卡拿不到地址',
      );
    }

    // ---- ① DDL ----
    await sequelize.query(
      `ALTER TABLE ${STORES_TABLE} ADD COLUMN IF NOT EXISTS "${FIELD.name}" ${FIELD.ddl}`,
    );
    log.info?.(`[migration] ${STORES_TABLE}.${FIELD.name} 已就绪（${FIELD.ddl}）`);

    // ---- ② fields 元数据 ----
    const uiSchema = { title: FIELD.title, 'x-component': FIELD.component };
    const options = { uiSchema, allowNull: FIELD.allowNull, comment: FIELD.comment };
    const [result] = await sequelize.query(
      `INSERT INTO fields (key, name, type, interface, "collectionName", options, sort)
       VALUES (:key, :name, :type, :iface, :collection, :options::json, :sort)
       ON CONFLICT ("collectionName", name)
       DO UPDATE SET options = EXCLUDED.options, type = EXCLUDED.type,
                     interface = EXCLUDED.interface, sort = EXCLUDED.sort`,
      {
        replacements: {
          key: nanoid11(),
          name: FIELD.name,
          type: FIELD.type,
          iface: FIELD.interface,
          collection: STORES_COLLECTION,
          options: JSON.stringify(options),
          sort: FIELD.sort,
        },
      },
    );
    log.info?.(
      `[migration] fields 元数据已 upsert ${FIELD.name}（rowCount=${
        Number((result as any)?.rowCount ?? 0) > 0 ? 1 : 0
      }）`,
    );

    // ---- ③ 就地补全本进程的集合字段 ----
    try {
      const collection: any = db.getCollection?.(STORES_COLLECTION);
      if (typeof collection?.addField === 'function' && !collection.getField?.(FIELD.name)) {
        collection.addField(FIELD.name, {
          type: FIELD.type,
          name: FIELD.name,
          interface: FIELD.interface,
          uiSchema,
          allowNull: FIELD.allowNull,
        });
      }
      log.info?.('[migration] 本进程内的 stores 字段对象已就地补全');
    } catch (e) {
      log.warn?.(
        '[migration] 就地补全内存字段对象失败（正确性不受影响，但可能需再重启一次）：' +
          String((e as Error)?.message ?? e).slice(0, 160),
      );
    }

    // ---- ④ 自检：DDL 断行数 + 类型 ----
    const [colRows] = await sequelize.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = '${STORES_TABLE}' AND column_name = '${FIELD.name}'`,
    );
    const cols = ((colRows as any[]) ?? []).filter(Boolean);
    if (cols.length !== 1) {
      throw new Error(
        `[migration] 自检失败：info_schema 里 ${FIELD.name} 查到 ${cols.length} 列（期望 1）—— ` +
          'DDL 没落地。"查不到坏行"不等于"列建对了"，所以这里断言的是**行数**。',
      );
    }
    if (String(cols[0].data_type) !== FIELD.pgType) {
      throw new Error(
        `[migration] 自检失败：${FIELD.name} 的类型是 ${cols[0].data_type}，期望 ${FIELD.pgType}`,
      );
    }
    if (String(cols[0].is_nullable) !== 'YES') {
      throw new Error(
        `[migration] 自检失败：${FIELD.name} 的 is_nullable=${cols[0].is_nullable}，期望 YES —— ` +
          '地址是**选填**资料（缺资料的门店必须还能营业），不允许 NOT NULL',
      );
    }

    // ---- ⑤ 自检：fields 元数据（⚠️ 取值一律用 `#>>`／`->>` 拿文本）----
    // 🔴 这里刻意与 202610102 用同一种取法：`#>` 会返回 jsonb（驱动解码成对象），
    //    把它 `String()` 后再 JSON.parse 会得到 "[object Object]" —— 那条路
    //    曾把整个应用打成维护模式（DEV-124）。
    const [metaRows] = await sequelize.query(
      `SELECT name, type, coalesce(options::jsonb->>'allowNull','') AS allow_null,
              coalesce(options::jsonb #>> '{uiSchema,title}','') AS title
         FROM fields
        WHERE "collectionName" = '${STORES_COLLECTION}' AND name = '${FIELD.name}'`,
    );
    const meta = ((metaRows as any[]) ?? []).filter(Boolean);
    if (meta.length !== 1) {
      throw new Error(
        `[migration] 自检失败：fields 元数据查到 ${meta.length} 行（期望 1）—— ` +
          '缺行意味着该列对 ORM/界面**不存在**（列在库里会让人误以为没问题）。',
      );
    }
    const row = meta[0] as any;
    if (String(row.allow_null) !== 'true') {
      throw new Error(`[migration] 自检失败：allowNull=${row.allow_null}，期望 true`);
    }
    if (String(row.title) !== FIELD.title) {
      throw new Error(
        `[migration] 自检失败：title=${JSON.stringify(row.title)}，期望 ${JSON.stringify(FIELD.title)}`,
      );
    }

    log.info?.(
      `[migration] 自检通过：DDL 1 列 · fields 元数据 1 条 · ${STORES_COLLECTION} 定义已声明 —— address`,
    );
  }
}
