/**
 * 迁移：服务单模型升级 —— 服务地址 / 家电分类 / 品牌型号 / 紧急（Phase 11 / P11-1）
 * =============================================================================
 *
 * 来源：`docs/PHASE-11-REQUIREMENTS.md` §8.1「新字段」与 §9.1「表单」。
 *
 * ===========================================================================
 * 为什么另起一个迁移（而不是并进 202610101-next-follow-at）
 * ===========================================================================
 * 迁移一经应用就**不可变**：改一个已经跑过的迁移，会造成"文件内容与库里实际跑过的
 * 不一致"，下次有人重建库时得到的东西与现网不同，**且没有任何报错**。
 * ⇒ 新增步骤一律另起一个文件（这条纪律在本仓库已写过三次，此处照旧）。
 *
 * ===========================================================================
 * 为什么"集合里已经声明了"还要写迁移
 * ===========================================================================
 * 新增列时 NocoBase 的 `sync()` 通常会把列与 `fields` 元数据一起补上 ——
 * 但那是**install / 全新库**的路径。已存在的实例上，"库里那份说了算"（P11-0 的实测结论），
 * 而且本项目已经因为"漏了元数据层 / 漏了分组"整整卡过三次。
 * ⇒ 本迁移把三层**显式**写成一致，并**逐层自检**：
 *      ① DDL（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）
 *      ② `fields` 元数据（`ON CONFLICT ("collectionName", name) DO UPDATE`）
 *      ③ 集合定义（`collections/serviceTickets.ts`，供将来全新安装）
 *    第 ④ 层（页面 `FIELD_GROUPS`）由 `scripts/verify-schema-layers.mjs` 静态盯住 ——
 *    因为漏了它 `applyBlueprint` 会报 `default-field-groups-incomplete` 并**整页 400**。
 *
 * ===========================================================================
 * 🔴 自检必须先断**行数**
 * ===========================================================================
 * 照抄 202610091 的教训：只查"有没有坏行"的自检，在**集合名写错 ⇒ 匹配 0 行**时
 * 会打印"自检通过"—— 一次什么都没检查到的假绿。所以这里每一层都先断言行数。
 */
import { Migration } from '@nocobase/database';

const TICKETS_COLLECTION = 'serviceTickets';
const TICKETS_TABLE = 'service_tickets';

/** 与 `fields` 表既有行同一形态的 11 位 key（照 202610101 的做法） */
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
  /** `fields.type` */
  type: string;
  /** `information_schema.columns.data_type` 期望值（**逐字**） */
  pgType: string;
  /** DDL 片段（`ADD COLUMN IF NOT EXISTS` 之后的部分） */
  ddl: string;
  interface: string;
  component: string;
  allowNull: boolean;
  /** 仅 `enumStr` 形态有 */
  enumOptions?: Array<{ label: string; value: string }>;
  /** 仅 boolean 形态有 */
  defaultValue?: unknown;
  sort: number;
}

/**
 * ⚠️ `sort` 从 35 起：`202610101` 用了 33/34。
 *    与既有字段的可视顺序有关；**不要**复用别人的号段（重复 sort 会让后台列序不稳定）。
 *
 * ⚠️ `appliance_category` 的枚举在此**逐字重复**一份（而不是 import 共享契约）：
 *    迁移是**历史快照**，它必须永远描述"当时那一刻写了什么"。
 *    若它 import 共享文件，将来有人给共享枚举加一项，这个已应用的迁移的语义就**悄悄变了**
 *    （而库里已经按旧值写过数据）。整条共享契约的漂移由
 *    `scripts/verify-schema-layers.mjs` 在真库上核对 —— 那才是该响的地方。
 */
const FIELDS: FieldSpec[] = [
  {
    name: 'service_address',
    title: '服务地址',
    comment: '客户提交选填；安排上门前应补全（§8.1）',
    type: 'string',
    pgType: 'character varying',
    ddl: 'varchar(200) NULL',
    interface: 'input',
    component: 'Input',
    allowNull: true,
    sort: 35,
  },
  {
    name: 'appliance_category',
    title: '家电类型',
    comment: '固定枚举（§8.2）；不建立 ERP 商品档案',
    type: 'string',
    pgType: 'character varying',
    ddl: 'varchar(32) NULL',
    interface: 'select',
    component: 'Select',
    allowNull: true,
    enumOptions: [
      { label: '空调', value: 'air_conditioner' },
      { label: '冰箱', value: 'refrigerator' },
      { label: '洗衣机', value: 'washer' },
      { label: '电视', value: 'tv' },
      { label: '厨卫电器', value: 'kitchen_bath' },
      { label: '小家电', value: 'small_appliance' },
      { label: '其他', value: 'other' },
    ],
    sort: 36,
  },
  {
    name: 'brand_model',
    title: '品牌/型号',
    comment: '自由文本，选填（§8.1 明确为单个字段）',
    type: 'string',
    pgType: 'character varying',
    ddl: 'varchar(64) NULL',
    interface: 'input',
    component: 'Input',
    allowNull: true,
    sort: 37,
  },
  {
    name: 'urgent',
    title: '紧急',
    comment: '是否紧急（提示性标记，不改变状态机与 SLA 口径）',
    type: 'boolean',
    pgType: 'boolean',
    // ⚠️ `NOT NULL DEFAULT false`：既有行会被回填成 false（PG 的 ADD COLUMN + DEFAULT 会
    //    把默认值写进所有既存行），语义正是"历史工单都不是紧急单"。
    ddl: 'boolean NOT NULL DEFAULT false',
    interface: 'checkbox',
    component: 'Checkbox',
    allowNull: false,
    defaultValue: false,
    sort: 38,
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
          '服务单的地址/家电类型/品牌型号/紧急四列未落地，客户报修会丢字段',
      );
    }

    // ---- ① DDL：新增四列（幂等）----
    for (const f of FIELDS) {
      await sequelize.query(
        `ALTER TABLE ${TICKETS_TABLE} ADD COLUMN IF NOT EXISTS "${f.name}" ${f.ddl}`,
      );
    }
    log.info?.(
      `[migration] ${TICKETS_TABLE} 已就绪四列：${FIELDS.map((f) => f.name).join(' / ')}`,
    );

    // ---- ② fields 元数据：让 ORM 与界面认得这四列 ----
    let upserted = 0;
    for (const f of FIELDS) {
      const uiSchema: Record<string, unknown> = {
        title: f.title,
        'x-component': f.component,
      };
      if (f.enumOptions) uiSchema.enum = f.enumOptions;
      const options: Record<string, unknown> = {
        uiSchema,
        allowNull: f.allowNull,
        comment: f.comment,
      };
      if (f.defaultValue !== undefined) options.defaultValue = f.defaultValue;

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
            iface: f.interface,
            collection: TICKETS_COLLECTION,
            options: JSON.stringify(options),
            sort: f.sort,
          },
        },
      );
      upserted += Number((result as any)?.rowCount ?? 0) > 0 ? 1 : 0;
    }
    log.info?.(`[migration] fields 元数据已 upsert ${upserted}/${FIELDS.length} 个字段`);

    // ---- ③ 就地更新本进程已构建的集合对象 ----
    // 新增列对本进程的模型不是"必填变化"，通常是安全的；但仍显式补一遍字段，
    // 免得出现"要重启两次才生效"（照 202610091 / 202610101 的做法）。
    try {
      const collection: any = db.getCollection?.(TICKETS_COLLECTION);
      for (const f of FIELDS) {
        if (typeof collection?.addField === 'function' && !collection.getField?.(f.name)) {
          const uiSchema: Record<string, unknown> = { title: f.title, 'x-component': f.component };
          if (f.enumOptions) uiSchema.enum = f.enumOptions;
          collection.addField(f.name, {
            type: f.type,
            name: f.name,
            interface: f.interface,
            uiSchema,
            allowNull: f.allowNull,
            ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
          });
        }
      }
      log.info?.('[migration] 本进程内的集合字段对象已就地补全');
    } catch (e) {
      log.warn?.(
        '[migration] 就地补全内存字段对象失败（正确性不受影响，但可能需再重启一次）：' +
          String((e as Error)?.message ?? e).slice(0, 160),
      );
    }

    // ---- ④ 自检：DDL 逐列**断行数** ----
    const [colRows] = await sequelize.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = '${TICKETS_TABLE}'
          AND column_name IN (${FIELDS.map((f) => `'${f.name}'`).join(',')})`,
    );
    const cols = ((colRows as any[]) ?? []).filter(Boolean);
    if (cols.length !== FIELDS.length) {
      throw new Error(
        `[migration] 自检失败：info_schema 里查到 ${cols.length} 列，期望 ${FIELDS.length} —— ` +
          'DDL 没落地。"查不到坏行"不等于"列建对了"，所以这里断言的是**行数**。',
      );
    }
    const byName = new Map(cols.map((c: any) => [String(c.column_name), c]));
    for (const f of FIELDS) {
      const actual = byName.get(f.name);
      if (String(actual.data_type) !== f.pgType) {
        throw new Error(
          `[migration] 自检失败：${f.name} 的类型是 ${actual.data_type}，期望 ${f.pgType}`,
        );
      }
    }
    // `urgent` 的 NOT NULL 必须**真的**在库里（这是它与另外三列唯一的差别）
    const urgentNullable = String((byName.get('urgent') as any).is_nullable);
    if (urgentNullable !== 'NO') {
      throw new Error(
        `[migration] 自检失败：urgent 的 is_nullable=${urgentNullable}，期望 NO —— ` +
          '紧急标记必须有确定值（NULL 会让"是否紧急"变成三态）',
      );
    }

    // ---- ⑤ 自检：fields 元数据逐条核对 ----
    //
    // 🔴 取证教训（2026-10-10 首次启动即踩到，应用直接进维护模式 503）：
    //    `#> '{uiSchema,enum}'` 取出来的是 **jsonb 类型**，pg 驱动会把它**解码成 JS 对象**；
    //    我却在自检里写 `JSON.parse(String(row.enum ?? '[]'))` ⇒ 拿到的是
    //    `"[object Object]"` ⇒ `JSON.parse` 抛
    //    `Unexpected token 'o', "[object Obj"... is not valid JSON`。
    //    而迁移自检抛错会被 NocoBase 当成**启动失败** —— 整个应用挂起在维护模式，
    //    所有接口 503。也就是说：**一行自检写错，代价是全站不可用**。
    //    ⇒ 取"要当文本比较"的值一律用 `#>>`（**双箭头**，返回 text），
    //      不要用 `#>`（单箭头，返回 jsonb）。同文件里 allowNull/title 用的是 `->>`/`#>>`，
    //      这也是它们没出问题的原因 —— 一处用了单箭头，就炸了。
    const [metaRows] = await sequelize.query(
      `SELECT name, type, coalesce(options::jsonb->>'allowNull','') AS allow_null,
              coalesce(options::jsonb #>> '{uiSchema,title}','') AS title,
              coalesce(options::jsonb #>> '{uiSchema,enum}','[]') AS enum_text
         FROM fields
        WHERE "collectionName" = '${TICKETS_COLLECTION}'
          AND name IN (${FIELDS.map((f) => `'${f.name}'`).join(',')})`,
    );
    const meta = ((metaRows as any[]) ?? []).filter(Boolean);
    if (meta.length !== FIELDS.length) {
      throw new Error(
        `[migration] 自检失败：fields 元数据查到 ${meta.length} 行，期望 ${FIELDS.length} 行 —— ` +
          '缺行意味着该列对 ORM/界面**不存在**（列在库里会让人误以为没问题）。',
      );
    }
    const metaByName = new Map(meta.map((r: any) => [String(r.name), r]));
    for (const f of FIELDS) {
      const row = metaByName.get(f.name) as any;
      if (String(row.allow_null) !== String(f.allowNull)) {
        throw new Error(
          `[migration] 自检失败：${f.name} 的 allowNull=${row.allow_null}，期望 ${f.allowNull}`,
        );
      }
      if (String(row.title) !== f.title) {
        throw new Error(
          `[migration] 自检失败：${f.name} 的 title=${JSON.stringify(row.title)}，期望 ${JSON.stringify(f.title)}` +
            '（缺 title 界面会显示空标签）',
        );
      }
      if (f.enumOptions) {
        // `enum_text` 现在是**文本**（`#>>`），可以安全 JSON.parse
        let actual: unknown;
        try {
          actual = JSON.parse(String(row.enum_text || '[]'));
        } catch (e) {
          throw new Error(
            `[migration] 自检失败：${f.name} 的 uiSchema.enum 不是合法 JSON：` +
              `${String(row.enum_text).slice(0, 80)}`,
          );
        }
        if (JSON.stringify(actual) !== JSON.stringify(f.enumOptions)) {
          throw new Error(
            `[migration] 自检失败：${f.name} 的枚举与契约不一致（实际 ${
              Array.isArray(actual) ? actual.length : '非数组'
            } 项，期望 ${f.enumOptions.length} 项）`,
          );
        }
      }
    }

    log.info?.(
      `[migration] 自检通过：DDL ${cols.length} 列 · fields 元数据 ${meta.length} 条 · ` +
        `${TICKETS_COLLECTION} 定义已声明 —— ${FIELDS.map((f) => f.name).join(' / ')}`,
    );
  }
}
