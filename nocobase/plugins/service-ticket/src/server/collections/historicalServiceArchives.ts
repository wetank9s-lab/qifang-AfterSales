import { belongsTo, defineAppCollection, enumStr, int, json, str, text, ts } from './_helpers';

/**
 * historicalServiceArchives —— **历史售后档案**（P11-3 第 4 项 · 用户 D 条）
 *
 * =============================================================================
 * 🔴 这是本项最重要的一条边界：档案**不是工单**
 * =============================================================================
 * 用户原话：「实现明确的『确认归档』操作，目标是**独立的历史售后档案**，
 *           不是 `serviceTickets` 的 NEW 工单。」
 * 以及：「保持**历史记录与当前 SLA/KPI 隔离**。」
 *
 * ⇒ 结构上分两张表，而不是"在 serviceTickets 上加一个 isHistorical 标记"。
 *   后者的后果是可预期的、而且很难回退：
 *     · 所有按 status 统计的看板会**自动**把历史档案算进去（SLA 分母被污染）；
 *     · 所有的状态流转（受理/派工/关闭）会**默认**对历史档案可用；
 *     · 而"它其实不是一张在办工单"这件事，只存在于某个注释里。
 *   分表之后，"历史不污染当前"是**结构性的**：SLA 巡检扫的是 `service_tickets`，
 *   它根本看不见本表。
 *
 * -----------------------------------------------------------------------------
 * 🔴 幂等键：重复点击 / 网络重试不产生第二条档案
 * -----------------------------------------------------------------------------
 * 用户 D 条：「保证重复点击、网络重试**不会生成重复档案**。」
 *
 * `idempotency_key = sha256(batch_id | source_key | mapping_version)`
 * 带 **UNIQUE** 索引 ⇒ 同一批次、同一原始行、同一映射版本**只能归档一次**。
 * 重试时第二次插入会撞唯一键，服务层捕获后返回**既有档案**（而不是报错，
 * 也不是新建）—— 这正是"重试安全"的定义。
 *
 * -----------------------------------------------------------------------------
 * 🔴 门店归属：归档时**必须**已经确认，且档案里留下快照
 * -----------------------------------------------------------------------------
 * `store_id` 非空 —— 归档的语义就是"这批历史数据确认属于某家门店"。
 * 而"谁有资格成为这家门店"由 `service_settings` 的
 * `historical.store-identity-confirmations` 决定（见 `archive.ts`）：
 * **当前只有演练用的门店在册**，所以真实历史数据**结构上无法**被归档到任何门店
 * （用户原话：15 家门店 code 尚未全部核定）。
 */
export default defineAppCollection({
  name: 'historicalServiceArchives',
  title: '历史售后档案',
  fields: [
    str('archive_no', '档案号', {
      length: 32,
      allowNull: false,
      unique: true,
      comment: '形如 HA-20261012-XXXX；对外展示与口头核对用（幂等键不适合人念）',
    }),
    str('idempotency_key', '幂等键', {
      length: 64,
      allowNull: false,
      comment:
        'sha256(批次 id|稳定源标识|映射版本)；**UNIQUE** ⇒ ' +
        '重复点击 / 网络重试只会得到同一条档案（用户 D 条）',
    }),

    // ---------------- 来源关联（三条都不能少）----------------
    belongsTo('batch', '来源批次', 'historicalImportBatches', 'batch_id', { allowNull: false }),
    belongsTo('row', '来源原始行', 'historicalImportRows', 'row_id', {
      allowNull: false,
      comment: '🔴 指回**原始行**（而不是标准化候选行）—— 档案必须能回到 Excel 的那一格',
    }),
    int('mapping_version', '映射版本', {
      allowNull: false,
      defaultValue: 1,
      comment: '按哪一代清洗结果归档的；换映射不会改动已归档的档案',
    }),
    str('source_file_name', '来源文件名', {
      length: 255,
      allowNull: true,
      comment: '快照：批次被作废/改名后，档案仍能回答"它来自哪个文件"',
    }),
    str('source_sheet', '来源工作表', { length: 128, allowNull: true }),
    int('source_row', '来源原始行号', {
      allowNull: true,
      comment: 'Excel 里的 **1-based** 行号 —— 人工复核时按它在原文件里定位',
    }),

    // ---------------- 归属（归档必须有门店）----------------
    belongsTo('store', '归属门店', 'stores', 'store_id', {
      allowNull: false,
      comment: '🔴 非空：归档的语义就是"确认属于某家门店"。未确认门店的批次走不到这一步',
    }),
    str('store_code_snapshot', '门店编码快照', {
      length: 32,
      allowNull: false,
      comment: '快照：门店被改名/停用后，档案仍能回答"当时归给哪个 code"',
    }),

    // ---------------- 内容（**归档那一刻**的快照）----------------
    str('customer_name', '客户姓名', { length: 64, allowNull: true }),
    str('customer_mobile', '客户手机号', {
      length: 32,
      allowNull: true,
      comment:
        '⚠️ 明文存储（与 `service_tickets.customer_mobile` 同口径）。' +
        '读取接口一律脱敏；只有授权接口能取到完整值',
    }),
    str('customer_address', '服务地址', { length: 255, allowNull: true }),
    str('device_summary', '家电信息', {
      length: 255,
      allowNull: true,
      comment: '设备型号合并后的可读摘要（原始的多设备结构留在 `fields_json`）',
    }),
    ts('service_date', '业务日期', {
      allowNull: true,
      comment: '从已解析的日期字段里取最早的一个；**解析不出就留空**，不猜',
    }),
    json('fields_json', '标准化字段快照', {
      allowNull: true,
      comment: '归档那一刻的机器结果（原样）；**不随后续映射版本变化**',
    }),
    json('manual_overrides_json', '人工修正快照', {
      allowNull: true,
      comment: '人工修正过的字段（来自 `historicalImportReviews` 的 correct 动作）——与机器值分开存',
    }),
    json('anomaly_snapshot_json', '异常快照', {
      allowNull: true,
      comment: '归档时的异常清单与处理结论；用于事后回答"当时是带着什么问题归档的"',
    }),

    // ---------------- 归档人 / 时间 / 撤销 ----------------
    enumStr(
      'stage',
      '档案状态',
      [
        { label: '已归档', value: 'archived' },
        { label: '已撤销', value: 'revoked' },
      ],
      {
        allowNull: false,
        defaultValue: 'archived',
        comment: '撤销**不删行**（与全库"只增不改"纪律一致），只是不再计入历史统计',
      },
    ),
    belongsTo('archived_by_user', '归档人', 'users', 'archived_by_user_id', { allowNull: true }),
    str('archived_by_username', '归档人账号', { length: 64, allowNull: true }),
    ts('archived_at', '归档时刻', { allowNull: false }),
    text('archive_note', '归档备注', { allowNull: true }),

    /** 「转为当前服务单」的状态 —— 只对**仍需继续处理**的事项使用 */
    enumStr(
      'conversion_state',
      '转单状态',
      [
        { label: '未转', value: 'none' },
        { label: '已转为当前服务单', value: 'converted' },
      ],
      {
        allowNull: false,
        defaultValue: 'none',
        comment: '🔴 默认未转：历史档案**不自动**进入当前工作流（用户 D 条：不得批量自动转单）',
      },
    ),
  ],
  indexes: [
    { fields: ['idempotency_key'], unique: true },
    { fields: ['batch_id'] },
    { fields: ['row_id'] },
    { fields: ['store_id'] },
    { fields: ['stage'] },
    { fields: ['conversion_state'] },
    { fields: ['archived_at'] },
  ],
});
