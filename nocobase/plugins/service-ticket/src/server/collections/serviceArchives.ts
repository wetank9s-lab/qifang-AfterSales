import {
  belongsTo,
  defineAppCollection,
  enumStr,
  int,
  str,
  text,
  ts,
} from './_helpers';
import {
  ARCHIVE_SERVICE_TYPE_OPTIONS,
  ARCHIVE_STATUS_OPTIONS,
  ARCHIVE_TYPE_OPTIONS,
  ARCHIVE_VISIBILITY_OPTIONS,
} from './_options';

/**
 * serviceArchives —— 服务档案主表（ARC-V1 / A1）
 *
 * 业务契约：`docs/ARC-V1-A0.md` §7.1 + 执行令 A1 四条修正。
 *
 * 三条与本项目其它表**刻意不同**的设计：
 *
 * 1. **`status` 与 `visibility` 分两列**（用户 2026-11-09 明确要求）。
 *    `status` 是业务进度（待安排/已预约/服务中/已完成/已验收）；
 *    `visibility` 是客户可见性（草稿/已发布/作废）。
 *    合成一列的后果：作废一份已完成的档案时，那个"已完成"事实会被覆盖掉，
 *    审计再也答不出"它曾经做完过吗"。
 *
 * 2. **`notes`（内部）与 `public_note`（对外）分两列**。
 *    `notes` 永不进客户查询投影；`public_note` 才允许。放在一列里靠"查询时过滤"
 *    是做不到的——备注正文里会混进内部判断，过滤只能滤字段、滤不掉内容。
 *
 * 3. **`version` 乐观锁**。两个销售同时编辑时，后提交者必须拿到 409 而不是静默覆盖。
 *    只用 `updated_at` 比较不可靠（同一秒内的两次写入会相等）。
 *
 * ⚠️ `customer_mobile` **不唯一**：同一手机号可以多次购买、多项工程。
 *    唯一约束只在 `archive_no` 上。查询索引是 `(store_id, customer_mobile)`。
 */
export default defineAppCollection({
  name: 'serviceArchives',
  title: '服务档案',
  fields: [
    str('archive_no', '档案号', {
      length: 32,
      allowNull: false,
      unique: true,
      comment: 'DA-YYYYMMDD-XXXX，服务端生成，不信任前端',
    }),
    belongsTo('store', '所属门店', 'stores', 'store_id', {
      allowNull: false,
      comment: '所有读写的数据范围判据；只引用实际存在的 stores.id（不假设 ID 连续）',
    }),
    enumStr('archive_type', '档案类型', ARCHIVE_TYPE_OPTIONS, {
      allowNull: false,
      comment: 'service=上门服务 / hvac=暖通工程；决定走哪套完工规则',
    }),

    // ---- 客户信息（敏感） ----
    str('customer_name', '客户姓名', { length: 64, allowNull: false }),
    str('customer_mobile', '客户手机号', {
      length: 20,
      allowNull: false,
      comment: '不唯一：同号可多次购买/多项工程',
    }),
    str('service_address', '服务地址', {
      length: 255,
      allowNull: false,
      comment: '敏感；客户查询接口必须返回，但仅限本人+本店会话',
    }),

    // ---- 业务描述 ----
    text('product_description', '产品/机型描述', { allowNull: true }),
    text('package_description', '套餐说明', { allowNull: true }),
    /** 只存日期，不存时间：业务语义是"哪一天"，时区带来的偏移是噪音 */
    {
      type: 'dateOnly',
      name: 'purchase_date',
      interface: 'date',
      uiSchema: { title: '购买日期', type: 'string', 'x-component': 'DatePicker', 'x-component-props': { dateOnly: true } },
      allowNull: true,
    },
    {
      type: 'dateOnly',
      name: 'planned_date',
      interface: 'date',
      uiSchema: { title: '计划上门日期', type: 'string', 'x-component': 'DatePicker', 'x-component-props': { dateOnly: true } },
      allowNull: true,
    },
    /**
     * 实际服务日期（R2.2.4-rc.2）
     *
     * 🔴 与 `planned_date` 是**两个独立字段**，谁都不覆盖谁：
     *    用户例子「原计划 11-28，实际提前 11-26」⇒ planned=11-28、service=11-26。
     *    「提前调整计划」则是把 planned 改成 11-26、service 仍为空。
     *    ⇒ 任何一处"顺手同步另一个"的写法都是错的。
     *
     * 🔴 与 `completed_at` 分开：
     *    `completed_at` 由完工动作写入（带时分秒，且推进 status）；
     *    本列是 dateOnly 的业务事实，**可独立修改且不触发任何状态变化** ——
     *    这正是用户「编辑上门日期不等于执行完工操作」的落点。
     *
     * 允许早于 `planned_date`：用户明令「不要禁止实际日期早于计划日期」。
     * 未填写时保持 NULL，**不**用 planned_date 或当天兜底。
     */
    {
      type: 'dateOnly',
      name: 'service_date',
      interface: 'date',
      uiSchema: { title: '实际服务日期', type: 'string', 'x-component': 'DatePicker', 'x-component-props': { dateOnly: true } },
      allowNull: true,
    },
    enumStr('service_type', '服务类型', ARCHIVE_SERVICE_TYPE_OPTIONS, {
      allowNull: true,
      comment: '六类；仅 archive_type=service 时有值（暖通恒为 NULL）',
    }),
    str('assigned_worker', '上门人员', {
      length: 64,
      allowNull: true,
      comment: '仅记姓名，不建独立账号（执行令：安装人员不建立独立录入账号）',
    }),
    belongsTo('sales_user', '销售', 'users', 'sales_user_id', {
      allowNull: true,
    }),

    // ---- 说明（内部 / 对外分开） ----
    text('notes', '内部备注', {
      allowNull: true,
      comment: '🔒 永不进入客户查询投影',
    }),
    text('public_note', '对客户说明', {
      allowNull: true,
      comment: '✅ 唯一允许下发给客户的自由文本字段',
    }),

    // ---- 两个正交维度 ----
    enumStr('status', '服务进度', ARCHIVE_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: 'pending',
    }),
    enumStr('visibility', '客户可见性', ARCHIVE_VISIBILITY_OPTIONS, {
      allowNull: false,
      defaultValue: 'draft',
      comment: '草稿/已发布/作废；与 status 正交',
    }),

    // ---- 时间与并发 ----
    ts('completed_at', '完成时间', { allowNull: true }),
    ts('published_at', '首次发布时间', { allowNull: true }),
    ts('voided_at', '作废时间', { allowNull: true }),
    int('version', '版本号', {
      allowNull: false,
      defaultValue: 1,
      comment: '乐观锁；并发写入用 WHERE version=? 判定',
    }),

    belongsTo('created_by_user', '创建人', 'users', 'created_by', { allowNull: true }),
    belongsTo('updated_by_user', '最后修改人', 'users', 'updated_by', { allowNull: true }),
  ],
  indexes: [
    // 执行令点名要求：按 store_id + customer_mobile 查询
    { fields: ['store_id', 'customer_mobile'] },
    { fields: ['store_id', 'visibility', 'status'] },
    { fields: ['customer_mobile'] },
    // ⚠️ 2026-11-11 R0-FREEZE 修复：此处原本还有一条
    //      `{ fields: ['archive_no'], unique: true }`
    //    **与字段级 `archive_no: { unique: true }`（见上方字段定义）重复** ——
    //    真机 PG 上会落下两枚同义索引：
    //      · `service_archives_archive_no`      （collection 级）
    //      · `service_archives_archive_no_key`  （字段级 UNIQUE CONSTRAINT）
    //    这正是 DEV-17 明令禁止的形态（同列两枚索引 = 双倍写放大 + 冗余唯一约束）。
    //    对照：`service_tickets.ticket_no` 只有字段级那一枚，是本仓库的正确样式。
    //    ⇒ 唯一性由字段级承担（PG UNIQUE CONSTRAINT 更强），删掉这一条声明。
    //    ⚠️ 门禁的「无重复同义索引」断言**看不见**这种跨层重复（它只扫 collection.indexes
    //       数组内部），所以这条是靠真机 `pg_indexes` 对照 + 与 service_tickets 比对发现的。
    { fields: ['updated_at'] },
  ],
});
