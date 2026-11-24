import { belongsTo, defineAppCollection, int, str } from './_helpers';

/**
 * serviceArchiveProducts —— 档案的**产品清单**（R2.2.4 §C）
 *
 * ===========================================================================
 * 为什么必须是独立表，而不是"把多条塞进 product_description"
 * ===========================================================================
 *   用户 §C 第 3 条写得很死：「采用可靠一对多记录方案（不拼接成单文本字段）」。
 *
 *   拼接的实际后果（不是洁癖问题）：
 *     · 「格力 3 匹 / 2024-03-01 / ×1；美的 1.5 匹 / 2023-11-20 / ×2」
 *       存成一段文本后，**没有任何字段可以查询、排序、校验**；
 *     · 日期变成字符串 ⇒ 时区/格式各写一套，导出 Excel 时排序全乱；
 *     · 数量是"文案的一部分" ⇒ 想统计"这家门店卖了 37 台设备"需要正则解析；
 *     · 想删掉第二条，只能字符串手术 —— 那是唯一一种"保存后可能更糟"的编辑。
 *
 * ===========================================================================
 * 与旧字段的关系（**只增不删，增量兼容**）
 * ===========================================================================
 *   `service_archives.product_description` / `purchase_date` **保持不动**。
 *   原因有三条，缺一条都会造成不可逆损失：
 *     ① 生产库里已有真实数据（只读核对：本地 15 条有产品描述、43 条有购买日期）；
 *     ② 有一批历史档案早于产品清单，迁移脚本若"删源列"就没有回退依据；
 *     ③ 幂等比对（`svc:archiveCreate` 的 `resolveExisting`）读的是这两列。
 *
 *   ⇒ 新建档案：产品清单写入本表，**同时**把第一条镜像回填到那两个列
 *     （`product_description` = 第一条的产品/型号；`purchase_date` = 第一条的购买日期）。
 *     这样旧接口、旧报表、旧导出**零改动**依然能取到"主要产品"。
 *   ⇒ 编辑档案：产品清单是权威来源；两个旧列只作为"第一条的镜像"同步，
 *     且**绝不在清单为空时把它们清空**（见 `archive-product-service.ts` 的三条铁律）。
 *
 * ===========================================================================
 * 字段口径
 * ===========================================================================
 *   `product_name` 允许为空 —— 但"整行全空"的条目在服务层会被丢弃，
 *      不入库（用户 §C：不保存完全空白条目）。所以本表里不存在"三列全空"的行。
 *   `purchase_date` 用 **dateOnly**，与主表 `purchase_date` 同口径：
 *      业务语义是"哪一天"，存时间戳只会带来时区偏移的噪音。
 *   `quantity` 默认 1、必须为正整数（服务层校验，不依赖前端）。
 *   `sort_order` 是**用户的填写顺序**（不是 id 顺序，也不是修改时间）：
 *      重新编辑后顺序不应自己变。判据一律 `ORDER BY sort_order, id`。
 */
export default defineAppCollection({
  name: 'serviceArchiveProducts',
  title: '档案产品清单',
  fields: [
    belongsTo('archive', '所属档案', 'serviceArchives', 'archive_id', {
      allowNull: false,
      comment: '级联只在服务层做（与阶段行同构），不做数据库级 ON DELETE CASCADE',
    }),
    str('product_name', '产品 / 型号', {
      length: 255,
      allowNull: true,
      comment: '与旧列 product_description 同义；空值行不入库（服务层过滤）',
    }),
    /**
     * 购买日期 —— 与 `serviceArchives.purchase_date` **同口径**的 dateOnly。
     *
     * ⚠️ `_helpers.ts` 没有 dateOnly 工厂（全项目只有两处用到，都是内联写的）。
     *    这里沿用主表的写法而不是新造一个 helper：新造 helper 会让"某个 dateOnly
     *    漏了 uiSchema"变成可能，而这类漏法门禁看不见。
     */
    {
      type: 'dateOnly',
      name: 'purchase_date',
      interface: 'date',
      uiSchema: {
        title: '购买日期',
        type: 'string',
        'x-component': 'DatePicker',
        'x-component-props': { dateOnly: true },
      },
      allowNull: true,
    },
    int('quantity', '数量', {
      allowNull: false,
      defaultValue: 1,
      comment: '正整数；服务层校验 quantity >= 1 且为整数',
    }),
    int('sort_order', '排序号', {
      allowNull: false,
      defaultValue: 1,
      comment: '用户填写顺序（1 起）；重排不改业务含义，只影响显示顺序',
    }),
    /**
     * ⚠️ **不要在这里声明 `created_at` / `updated_at`**（2026-11-20 实测踩到）。
     *
     * `defineAppCollection` 已开启 `underscored: true`，NocoBase 会自己给每张表
     * 加 `createdAt`/`updatedAt` 并映射成 `created_at`/`updated_at`（见 `_helpers.ts`
     * 的 `CREATED_AT_COLUMN` / `UPDATED_AT_COLUMN`）。若这里再显式声明一遍，
     * 自动加的默认值与本处 `defaultValue` **互相覆盖**，真机落下的建表 SQL 变成：
     *
     *   `"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT 'Invalid date'`
     *
     * ⇒ `invalid input syntax for type timestamp with time zone: "Invalid date"`，
     *   整张表建不出来，应用起不来。而离线门禁（SQLite 桩）**看不见**这条 ——
     *   它不执行真实 DDL。这是"离线全绿、真机起不来"的典型形态。
     *
     * 同理 `id` 也不必声明：NocoBase 会自动加 BIGSERIAL 主键。
     */
  ],
  indexes: [
    // 列表查询永远是"某档案的全部产品，按填写顺序"
    { fields: ['archive_id', 'sort_order'] },
  ],
});
