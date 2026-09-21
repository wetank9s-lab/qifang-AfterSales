/**
 * 字段构造辅助函数。
 *
 * 目的：让 collection 定义读起来接近 docs/DATA-MODEL.md 的表格，
 * 同时统一 UI 元信息（下拉枚举、标题、组件类型），避免每张表重复写长长的 uiSchema。
 *
 * 注意：这些函数只做对象拼装，不做任何校验；真正的业务校验在
 *      services/ 层（Phase 2 起）与 DTO schema（Phase 3 起）里。
 */
import { defineCollection } from '@nocobase/database';

// ---------------------------------------------------------------------------
// collection 统一入口
// ---------------------------------------------------------------------------

/**
 * 本插件**所有** collection 必须经由此函数定义（不要直接调 defineCollection）。
 *
 * 它只做一件事：强制 `underscored: true`，但这一件事决定了整个数据模型能否落地。
 *
 * 背景（这是 Phase 1 真机启动时踩到的坑，详见 docs/DEVIATIONS.md DEV-14）：
 *   NocoBase 的 `underscored` 默认是 **false**。在这个默认值下：
 *     · 表名    serviceTickets     → 实际建库为 "serviceTickets"（驼峰，需加双引号）
 *     · 时间戳  自动注入 createdAt/updatedAt → 实际列名也是驼峰
 *   而 docs/DATA-MODEL.md、PHASE-0/1 的表结构清单、scripts/smoke-test.mjs
 *   以及本插件的 EXPECTED_TABLE_NAMES **全部**按下划线命名书写
 *   （service_tickets / created_at / updated_at）。
 *   两边对不上会直接导致：
 *     ① index 里写 ['created_at'] → PG 报 42703 undefined_column
 *        → db.sync() 抛错 → 应用启动失败，/api/* 持续 503；
 *     ② smoke-test 按下划线查表全部查不到。
 *
 * 开启 `underscored: true` 后（源码依据 @nocobase/database）：
 *   · database.js `beforeDefineCollection` 会 snakeCase 化 collection 名 → 表名
 *     service_tickets / daily_sequences / idempotency_records …
 *   · collection.js:479 会把时间戳字段映射为 created_at / updated_at
 *   · database.js `beforeDefineCollection` 还会**自动 snakeCase 化 indexes[].fields**，
 *     所以索引里写 'created_at' 或 'createdAt' 都能落到 created_at
 *     （本插件统一写 CREATED_AT_COLUMN 常量，见下）。
 *
 * 本插件的业务字段本来就是显式 snake_case（ticket_no / customer_mobile / store_id …），
 * snakeCase() 对它们幂等，不受影响。
 *
 * `uiManageable: true` 是 Phase 4-H 补上的，同样是"少一个就静默半瘫"的关键开关。
 *
 *   背景：后台要在这 11 张表上做原生区块（表格 / 详情 / 列表），
 *   而 NocoBase 后台的"可选数据表"列表来自
 *     GET /api/dataSources/main/collections:list
 *   ——它读的是 **collection-manager 元数据仓库**（PG 里的 "collections" / "fields" 两张表），
 *   不是运行期的 db.collections。而**只有声明了 `uiManageable` 的 collection**
 *   才会被 `plugin-data-source-main` 收进 `db2cmCollections` 并同步到仓库：
 *
 *     db.on('afterDefineCollection', c => {
 *       if (c?.options?.uiManageable) this.db2cmCollections.push(c.name);
 *     });                                        // plugin-data-source-main/server.js
 *
 *   不加这个开关的后果（本次真机取证）：
 *     · `serviceTickets:list` 这类**业务接口全部正常**（运行期集合在），
 *     · 但后台"选择数据表"里**一张业务表都看不到**，页面上根本建不出区块。
 *   属于典型的"接口全绿、后台全瞎"，且没有任何报错。
 *
 * 顺带得到的第二个作用：`uiManageable` 同时是**删除保护**——
 *   plugin-data-source-main 会对它抛出
 *     `Cannot remove a UI manageable collection` / `Cannot remove a UI manageable field`
 *   即后台无法把插件声明的表或字段删掉。对"代码即事实来源"的集合来说这是必要的护栏
 *   （否则一次误点就会让表结构与 EXPECTED_TABLE_NAMES 永久漂移）。
 *
 * ⚠️ `collections.options` 落库时会带上 `from: "db2cm"`，**且 db2cm 是"存在即返回"**：
 *   元数据行一旦写入，后续启动不会覆盖它 —— 运营在后台改过的字段标题不会被部署冲掉。
 *   这与本项目"只增不改"的种子纪律一致（见 seeds/apply.ts）。
 */
export function defineAppCollection(options: Record<string, any>) {
  return defineCollection({ ...options, underscored: true, uiManageable: true });
}

/**
 * 索引里引用时间戳列时**统一**用这两个常量，不要手写字符串。
 *
 * 值之所以是 snake_case，是因为本插件所有 collection 都经由 defineAppCollection
 * 启用了 underscored: true，NocoBase 会把自动注入的 createdAt / updatedAt
 * 落库为 created_at / updated_at —— 与 docs/DATA-MODEL.md 完全一致。
 */
export const CREATED_AT_COLUMN = 'created_at';
export const UPDATED_AT_COLUMN = 'updated_at';

export interface EnumOption {
  label: string;
  value: string;
}

/** 普通短字符串字段 */
export function str(name: string, title: string, extra: Record<string, any> = {}) {
  return { type: 'string', name, uiSchema: { title }, ...extra };
}

/** 枚举字段：DB 里存字符串，后台渲染成下拉 */
export function enumStr(
  name: string,
  title: string,
  options: EnumOption[],
  extra: Record<string, any> = {},
) {
  return {
    type: 'string',
    name,
    interface: 'select',
    uiSchema: {
      title,
      type: 'string',
      'x-component': 'Select',
      enum: options,
    },
    ...extra,
  };
}

/** 长文本 */
export function text(name: string, title: string, extra: Record<string, any> = {}) {
  return { type: 'text', name, uiSchema: { title, 'x-component': 'Input.TextArea' }, ...extra };
}

/** 整数 */
export function int(name: string, title: string, extra: Record<string, any> = {}) {
  return { type: 'integer', name, uiSchema: { title, 'x-component': 'InputNumber' }, ...extra };
}

/** 布尔 */
export function bool(name: string, title: string, extra: Record<string, any> = {}) {
  return { type: 'boolean', name, uiSchema: { title, 'x-component': 'Checkbox' }, ...extra };
}

/**
 * 金额：DECIMAL(10,2)。
 * precision/scale 显式传入，Phase 2 会用 \d+ 核对 PG 里的实际 DDL 类型。
 */
export function money(name: string, title: string, extra: Record<string, any> = {}) {
  return {
    type: 'decimal',
    name,
    precision: 10,
    scale: 2,
    uiSchema: { title, 'x-component': 'InputNumber', 'x-component-props': { precision: 2 } },
    ...extra,
  };
}

/**
 * 时间戳：PG 落 timestamptz。
 * NocoBase 的 date 字段 → Sequelize DataTypes.DATE → PG timestamptz，
 * 与 docs/DATA-MODEL.md 的约定一致。
 */
export function ts(name: string, title: string, extra: Record<string, any> = {}) {
  return { type: 'date', name, uiSchema: { title, 'x-component': 'DatePicker' }, ...extra };
}

/** JSONB */
export function json(name: string, title: string, extra: Record<string, any> = {}) {
  return { type: 'json', name, uiSchema: { title }, ...extra };
}

/**
 * 多对一外键（属于关系）。
 * FK 列名显式写死为 snake_case（xxx_id），与 docs/DATA-MODEL.md 完全一致，
 * 不依赖 NocoBase 的命名推导（不同版本下划线策略可能变化）。
 */
export function belongsTo(
  name: string,
  title: string,
  target: string,
  foreignKey: string,
  extra: Record<string, any> = {},
) {
  return {
    type: 'belongsTo',
    name,
    target,
    foreignKey,
    targetKey: 'id',
    uiSchema: { title, 'x-component': 'AssociationField' },
    ...extra,
  };
}

