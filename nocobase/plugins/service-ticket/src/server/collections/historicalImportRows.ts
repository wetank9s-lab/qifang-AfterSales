import { belongsTo, defineAppCollection, int, json, str } from './_helpers';

/**
 * historicalImportRows —— **原始层**（P11-3 第 3 项）
 *
 * =============================================================================
 * 这一层的唯一职责：**把 Excel 里看到的东西原样存下来，永远不动它**
 * =============================================================================
 * 用户 2026-10-12 第 2 条原话：
 *   「原始层记录文件 id / 哈希、工作表名、原始行号、原始列与值、上传者、上传时间；
 *     标准化层记录映射版本、转换后的候选字段、原始字段引用、异常原因、人工处理状态。
 *     **不得覆盖原始数据**；重新映射必须生成新的可追溯标准化结果，
 *     绝不丢失过往清洗的证据。」
 *
 * ⇒ 所以本表是**只追加**的：
 *     同一批次重复解析 ⇒ 不是 UPDATE，而是**不允许**（批次唯一）；
 *     调整映射 ⇒ 动的是 `historicalImportCandidates`，本表**一行都不改**。
 *   这条纪律由 `source_key` 的唯一约束兜住：同一（文件 + 表 + 行号）只能有一条。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ `cells_json` 里存的是**客户数据本体**——这是全库敏感面最大的一列
 * -----------------------------------------------------------------------------
 * 用户第 6 条：「完整原始数据只能经授权接口访问；日志、解析异常、普通统计响应
 *               都不得输出完整客户手机号等个人信息。」
 *
 * ⇒ 本表**不设**任何对外匿名接口；读取一律走 `svc:` 已登录动作，且：
 *     · 门店角色只能读**自己上传**的批次（`visibility_scope` + `uploader_user_id` 双条件）；
 *     · 列表/统计响应里的手机号一律 `maskPhone()` 后再出；
 *     · 原始值只在"查看详情"这一条路径上出现，且同样受上面两条约束。
 *
 * -----------------------------------------------------------------------------
 * `source_key`：稳定源标识
 * -----------------------------------------------------------------------------
 * 用户第 6 条：「同一文件 + 同一工作表 + 同一原始行号 = 稳定源标识。」
 * ⇒ `sha256(fileHash|sheetName|sourceRow)`，长度固定 64 位。
 *   它让"这一行到底来自哪个文件的哪张表的哪一行"在任何时候都能被回答，
 *   也是跨批次判重（同内容文件被改名后再传）的依据。
 */
export default defineAppCollection({
  name: 'historicalImportRows',
  title: '历史导入原始行',
  fields: [
    belongsTo('batch', '所属批次', 'historicalImportBatches', 'batch_id', {
      allowNull: false,
      comment: '🔴 非空：一行原始记录必须能回答"它属于哪次上传"，否则无从追溯',
    }),
    str('sheet_name', '工作表名', { length: 128, allowNull: false }),
    int('sheet_index', '工作表序号', { allowNull: false, defaultValue: 0 }),
    int('source_row', 'Excel 原始行号', {
      allowNull: false,
      comment: '**1-based**，与 Excel 里看到的行号一致；回溯时用它定位，不用数据库 id',
    }),
    int('header_row', '表头所在行', {
      allowNull: true,
      comment: '该表探测到的表头行号；重复解析同一文件时用于核对是否同一结构',
    }),
    str('classification', '工作表分类', {
      length: 32,
      allowNull: true,
      comment: 'service-install / service-repair / sales-or-delivery / needs-review',
    }),
    json('cells_json', '原始单元格', {
      allowNull: false,
      comment:
        '{ c0: "原值", c1: null, … } —— **原样**保存（含空格、含前导等号、含一格多号）。' +
        '🔴 含客户个人信息：只能经授权接口访问，日志与统计响应里不得整列输出',
    }),
    json('header_json', '该表表头', {
      allowNull: true,
      comment: '该工作表的表头原值（每行都存一份是**刻意**的：表头可在人工映射阶段被改）',
    }),
    str('source_key', '稳定源标识', {
      length: 64,
      allowNull: false,
      comment: 'sha256(文件哈希|工作表名|原始行号) —— 跨批次判重的锚，也是"这一行从哪来"的答案',
    }),
  ],
  indexes: [
    { fields: ['batch_id'] },
    // 同一批次内：同一张表的同一原始行号只能有一条
    { fields: ['batch_id', 'sheet_name', 'source_row'], unique: true },
    { fields: ['source_key'] },
    { fields: ['classification'] },
  ],
});
