import { belongsTo, defineAppCollection, enumStr, int, json, text } from './_helpers';

/**
 * historicalImportCandidates —— **标准化层**（P11-3 第 3 项）
 *
 * =============================================================================
 * 这一层是"清洗结果"，而且是**分代**的
 * =============================================================================
 * 用户 2026-10-12 第 2 条：
 *   「重新映射必须生成新的可追溯标准化结果，绝不丢失过往清洗的证据。」
 *
 * ⇒ `mapping_version` 每调一次映射就 +1，新结果**另起一批行**写进来，
 *    旧版本的行**一行都不删不改**。于是任何时刻都能回答：
 *      "按 v1 映射清洗时，这一行是什么结果？" 与 "现在 v3 又是什么结果？"
 *
 *    ⚠️ 这不是"为了留痕而多存一份"：映射改错的代价是**整批数据被洗歪**，
 *      而清洗是不可逆的（原始值还在，但"当时清洗成了什么"丢了就没法复盘）。
 *
 * -----------------------------------------------------------------------------
 * 🔴 `disposition` 五态必须**互斥且可求和**
 * -----------------------------------------------------------------------------
 * 用户第 4 条原文列举：可导入候选 / 需人工确认 / 疑似重复 / 非售后排除 / 解析错误。
 *
 * 互斥的实现方式：它是**单个枚举列**，不是五个布尔列 —— 布尔列的组合数是 32，
 * 其中 27 种是自相矛盾的（既"可导入"又"解析错误"）。单个枚举列**结构上**
 * 排除了矛盾，可求和也自然成立：`count(group by disposition)` 之和 == 总行数。
 *
 * ⚠️ 与 `quality_json` 的关系：一个回答"这一行归哪一类"（互斥），
 *    另一个回答"这一行哪里不干净"（一行可命中多项）。**不要**把两者合并 ——
 *    合并的后果就是"售后 3104 行 = 干净 3104 行"这种结论。
 *
 * -----------------------------------------------------------------------------
 * 🔴 东山那 849 行销售/配送记录**不会**因为改了映射就变成售后
 * -----------------------------------------------------------------------------
 * 用户第 4 条：「东山的 849 条销售配送记录，不得因为门店人员重新映射了字段
 *               就变成售后业务。」
 *
 * ⇒ `disposition = 'excluded'` 的判据是**表头结构信号**（有「购机日期」+
 *    销售/配送信号且无任何售后信号），与"某列映射到了什么字段"**无关**。
 *    改映射改的是 `fields_json` 怎么算，改不了 `disposition` 属于哪一类。
 */
export default defineAppCollection({
  name: 'historicalImportCandidates',
  title: '历史导入标准化候选',
  fields: [
    belongsTo('batch', '所属批次', 'historicalImportBatches', 'batch_id', { allowNull: false }),
    belongsTo('row', '对应原始行', 'historicalImportRows', 'row_id', {
      allowNull: false,
      comment: '🔴 每一行标准化结果都必须指回一行原始记录 —— 这是"可追溯"的结构性保证',
    }),
    int('mapping_version', '映射版本', {
      allowNull: false,
      defaultValue: 1,
      comment: '与批次的 mapping_version 对应；**同一 (row_id, version) 只能有一条**',
    }),

    enumStr(
      'disposition',
      '处置分类',
      [
        { label: '可导入候选', value: 'importable' },
        { label: '需人工确认', value: 'needs-confirm' },
        { label: '疑似重复', value: 'duplicate' },
        { label: '非售后排除', value: 'excluded' },
        { label: '解析错误', value: 'parse-error' },
      ],
      {
        allowNull: false,
        defaultValue: 'needs-confirm',
        comment:
          '🔴 **互斥且可求和**：按此列 group by 的计数之和 == 该版本的候选总行数。' +
          '默认值取最保守的 needs-confirm（宁可让人看一眼，也不要静默当成可导入）',
      },
    ),

    json('fields_json', '标准化字段', {
      allowNull: true,
      comment:
        '清洗后的候选值：姓名 / 手机（数组）/ 地址 / 设备 / 日期 / 故障 / 措施 / 师傅 / 回访。' +
        '⚠️ 缺依据的字段是 **null**，不是空串也不是默认值 —— 空串会让"没填"和"填了空"不可分辨',
    }),
    json('raw_refs_json', '原始字段引用', {
      allowNull: true,
      comment:
        '{ customerPhone: { col: 3, raw: "原值" } } —— 每个标准化值都能指回原始单元格；' +
        '没有这一列，"清洗结果可追溯"就是一句空话',
    }),
    json('issues_json', '异常原因', {
      allowNull: true,
      comment:
        '字符串数组，每条都是**给人看的原因**（"电话列为空" / "日期含两位年份，世纪无法确定"），' +
        '不是错误码。门店人员要能看懂，才谈得上人工确认',
    }),

    enumStr(
      'manual_status',
      '人工处理状态',
      [
        { label: '待处理', value: 'pending' },
        { label: '已确认', value: 'confirmed' },
        { label: '已驳回', value: 'rejected' },
      ],
      {
        allowNull: false,
        defaultValue: 'pending',
        comment: '与 disposition 独立：机器分类说"可导入"，人仍然可以驳回',
      },
    ),
    belongsTo('reviewed_by_user', '处理人', 'users', 'reviewed_by_user_id', {
      allowNull: true,
      comment: '留可空 = 尚未处理（与 manual_status=pending 对应）',
    }),
    text('manual_note', '人工备注', { allowNull: true }),

    /**
     * 🔴 **本阶段恒为 NULL**。
     *
     * 与批次的 `store_id` 同一纪律：门店映射确认前，一行历史数据**没有**归属。
     * 单列出来是为了将来"某几行确认归 A 店、另几行归 B 店"时能分别记录 ——
     * 那时它是**逐行**的事实，不能靠批次的 store_id 反推。
     */
    belongsTo('store', '归属门店', 'stores', 'store_id', {
      allowNull: true,
      comment: '🔴 本阶段恒为 NULL（用户第 5 条）；正式归档时才可写',
    }),
  ],
  indexes: [
    { fields: ['batch_id'] },
    { fields: ['row_id'] },
    // 同一原始行在同一映射版本下只能有一条结果
    { fields: ['row_id', 'mapping_version'], unique: true },
    { fields: ['disposition'] },
    { fields: ['manual_status'] },
  ],
});
