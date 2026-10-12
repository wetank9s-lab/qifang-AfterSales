import { belongsTo, CREATED_AT_COLUMN, defineAppCollection, int, json, str, text, enumStr, ts } from './_helpers';

/**
 * historicalImportBatches —— 历史 Excel 导入**批次**（P11-3 第 3 项）
 *
 * =============================================================================
 * 它是什么：**一次上传**的事实，不是业务数据
 * =============================================================================
 * 一次上传 = 一个批次。批次里记的是"这个文件是什么、谁传的、解析出了什么"，
 * 而**不是**客户数据本体（那在 `historicalImportRows` 里）。
 *
 * -----------------------------------------------------------------------------
 * 🔴 本阶段唯一不可退让的约束：**未确认归属的数据不得写入 store_id**
 * -----------------------------------------------------------------------------
 * 用户 2026-10-12 第 5 条原话：
 *   「15 家真实门店与系统编码的对应尚未完全确认。允许上传进入隔离暂存区，
 *     但**不得因为文件名或地名就写入 store_id**。暂存数据必须绑定授权上传者与
 *     明确的可见范围；未确认归属的数据不得对全部门店开放。
 *     正式归档到具体门店必须在门店映射确认 + 权限校验 + 人工确认之后。」
 *
 * 落到字段上就是三条：
 *   · `store_id`  **允许为 NULL**，且本阶段**恒为 NULL**（`attribution_state` 为
 *     `unconfirmed` 时，写入 store_id 会被服务层直接拒绝）；
 *   · `attribution_state` 是**独立的一列**，不靠"store_id 是否为空"反推 ——
 *     因为"已确认不归属任何门店"和"还没确认"是两件事，用 NULL 表达会混为一谈；
 *   · `visibility_scope` 决定谁能看见：`uploader`（仅上传者 + 总部）或 `hq`（仅总部）。
 *     未确认归属时**不允许**取"全部门店可见"——根本没有这个枚举值。
 *
 * -----------------------------------------------------------------------------
 * 为什么 `file_hash` 是去重的唯一依据
 * -----------------------------------------------------------------------------
 * 用户第 6 条：「同一文件重复上传必须能被识别，不能产生无限个相同批次。」
 * 判据只能是**字节内容的哈希**（SHA-256），不能是文件名 —— 门店发来的文件
 * 名字常常是 `新建 Microsoft Excel 工作表.xlsx` 或带日期后缀，同名不代表同内容，
 * 不同名也不代表不同内容。
 *
 * ⚠️ 哈希**只用于识别重复**，不用于"跨文件相似即合并"：跨文件相似**只能**标记
 *    疑似重复（`historicalImportCandidates.disposition = 'duplicate'`），
 *    **绝不**自动合并不同客户的记录。
 */
export default defineAppCollection({
  name: 'historicalImportBatches',
  title: '历史导入批次',
  fields: [
    str('batch_no', '批次号', {
      length: 32,
      allowNull: false,
      unique: true,
      comment: '形如 HI-20261012-XXXX；去重与人工核对时的口头锚点（哈希不适合人念）',
    }),

    // ---------------- 文件事实 ----------------
    str('file_name', '文件名', {
      length: 255,
      allowNull: false,
      comment:
        '⚠️ 仅作展示与回溯，**绝不**用于推断门店归属（用户明令：不得因文件名/地名写 store_id）',
    }),
    str('file_hash', '文件内容哈希', {
      length: 64,
      allowNull: false,
      comment: 'SHA-256（小写十六进制）；重复上传识别的**唯一**依据，不用文件名判重',
    }),
    int('file_bytes', '文件字节数', {
      allowNull: false,
      defaultValue: 0,
      comment: '实际读入的字节数；超过 IMPORT_LIMITS.MAX_FILE_BYTES 的文件根本进不了这一层',
    }),
    str('detected_kind', '实际文件类型', {
      length: 16,
      allowNull: false,
      comment: '按**魔数**判定（xlsx/xls）；伪造扩展名不会改变它',
    }),
    str('parser_name', '解析器', { length: 32, allowNull: true, defaultValue: 'xlsx' }),
    str('parser_version', '解析器版本', {
      length: 32,
      allowNull: true,
      comment:
        '运行时实际加载的 xlsx 版本；低于 0.20.2 时解析会**直接被拒** ⇒ 本列有值即证明当时的版本是安全的',
    }),

    // ---------------- 归属（本阶段恒为未确认）----------------
    enumStr(
      'attribution_state',
      '归属状态',
      [
        { label: '未确认', value: 'unconfirmed' },
        { label: '已确认', value: 'confirmed' },
        { label: '已驳回', value: 'rejected' },
      ],
      {
        allowNull: false,
        defaultValue: 'unconfirmed',
        comment:
          '🔴 与 store_id **相互独立**：unconfirmed 时 store_id 必须为 NULL，' +
          '服务层对此有硬校验（不靠"看是不是空"反推）',
      },
    ),
    belongsTo('store', '归属门店', 'stores', 'store_id', {
      allowNull: true,
      comment:
        '🔴 本阶段恒为 NULL：门店映射确认前写入它即违反用户第 5 条。' +
        '留可空是结构上的必然（未确认时无值可写），不是"可以随便写"',
    }),
    enumStr(
      'visibility_scope',
      '可见范围',
      [
        { label: '仅上传者与总部', value: 'uploader' },
        { label: '仅总部', value: 'hq' },
      ],
      {
        allowNull: false,
        defaultValue: 'uploader',
        comment:
          '未确认归属的数据**不得**对全部门店开放 ⇒ 枚举里根本没有"全员可见"这一项',
      },
    ),
    enumStr(
      'stage',
      '所处阶段',
      [
        { label: '隔离暂存', value: 'staging' },
        { label: '已归档', value: 'archived' },
        { label: '已作废', value: 'voided' },
      ],
      {
        allowNull: false,
        defaultValue: 'staging',
        comment:
          '🔴 本阶段**不提供**"转成当前 NEW 工单"的路径 —— 那是 P11-3 后续项的事',
      },
    ),

    // ---------------- 上传者（绑定授权人）----------------
    belongsTo('uploader_user', '上传者', 'users', 'uploader_user_id', {
      allowNull: true,
      comment: '留可空仅为兼容用户被删除后的历史记录；正常路径必然有值（接口要求已登录）',
    }),
    str('uploader_username', '上传者账号', {
      length: 64,
      allowNull: true,
      comment: '快照：用户被改名/删除后仍能回答"当时是谁传的"',
    }),
    ts('uploaded_at', '上传时刻', { allowNull: false }),

    // ---------------- 映射与结果 ----------------
    int('mapping_version', '当前映射版本', {
      allowNull: false,
      defaultValue: 1,
      comment:
        '每次调整映射**递增**。标准化结果按版本号分代存放 —— ' +
        '旧版本**不删不改**，所以"上次是怎么清洗的"永远可追溯',
    }),
    json('mapping_json', '列映射', {
      allowNull: true,
      comment:
        '{ sheetName: { headerRow, fields: { 逻辑字段: 列下标 } } }；' +
        '⚠️ **每份文件一份**，不强求七份文件的列顺序一致（用户第 3 条）',
    }),
    json('totals_json', '汇总计数', {
      allowNull: true,
      comment: 'dataRows / serviceRows / salesOrDeliveryRows / needsReviewRows …',
    }),
    json('ledger_json', '互斥台账', {
      allowNull: true,
      comment:
        '逐工作表：物理行 = 表头 + 重复表头 + 空行 + 售后 + 排除 + 待判（balance 必须为 0）',
    }),
    json('quality_json', '字段质量异常', {
      allowNull: true,
      comment: '多手机号 / 含糊日期 / 缺手机号 / 异常服务结果（与台账分开统计）',
    }),
    json('warnings_json', '解析告警', {
      allowNull: true,
      comment:
        '⚠️ 只放**结构性**告警（扩展名不符、1904 日期制、合并单元格…）；' +
        '解析异常里的客户信息一律不落库（用户第 6 条）',
    }),
    text('note', '备注', { allowNull: true }),
  ],
  indexes: [
    { fields: ['file_hash'] },
    { fields: ['stage'] },
    { fields: ['attribution_state'] },
    { fields: ['uploader_user_id'] },
    { fields: [CREATED_AT_COLUMN] },
  ],
});
