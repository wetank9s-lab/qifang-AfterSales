import { belongsTo, defineAppCollection, enumStr, int, json, str, text, ts } from './_helpers';

/**
 * historicalImportReviews —— 历史导入的**人工核对与裁决审计**
 * （P11-3 第 4 项 · 用户 B 条 + C 条）
 *
 * =============================================================================
 * 它记的是什么：**"某个人，在某个时刻，把这一行的这个字段改成了什么"**
 * =============================================================================
 * 用户 B 条原话：「异常核对操作要记录**真实操作人、时间、原值及新值**。」
 * 用户 C 条原话：「去重结果允许人工确认**保留两条或标记重复**。」
 *
 * ⇒ 两者都是"人对机器结果做的裁决"，形状完全一样（主体 / 动作 / 原值 / 新值 /
 *   操作人 / 时间），所以**共用一张表**，用 `scope` 区分是异常核对还是去重裁决。
 *   分两张表会让"这一行到底被人动过几次、都动了什么"变成要 union 两个查询。
 *
 * -----------------------------------------------------------------------------
 * 🔴 为什么原值与新值都要存（而不是只存"改成了什么"）
 * -----------------------------------------------------------------------------
 * 只存新值的审计回答不了**最关键的那个问题**："原来是错的吗？错成什么样？"
 * —— 而"当初机器算出的是 104 行缺手机号"这类结论，正是本次验收的核心证据。
 * ⇒ `old_value_json` 与 `new_value_json` 成对存在，缺一不可。
 *
 * -----------------------------------------------------------------------------
 * 🔴 这张表**不修改**标准化层
 * -----------------------------------------------------------------------------
 * `candidates.fields_json` 是**机器结果**，本表记的是**人的意见**。
 * 两者分开存（读取时"人工优先于机器"），换来三条保证：
 *   ① 机器结果永远可复现（同一映射版本重算结果不变）；
 *   ② 人的意见永远可追溯（谁、何时、凭什么）；
 *   ③ **不需要**为了"记住人的修正"去改机器那一份 —— 改了就再也说不清
 *      "这是机器算的还是人填的"。
 */
export default defineAppCollection({
  name: 'historicalImportReviews',
  title: '历史导入人工核对',
  fields: [
    belongsTo('batch', '所属批次', 'historicalImportBatches', 'batch_id', { allowNull: false }),
    belongsTo('row', '对应原始行', 'historicalImportRows', 'row_id', {
      allowNull: false,
      comment: '🔴 非空：每一条人工裁决都必须能指回**哪一行原始记录**，否则事后无法复核',
    }),
    int('mapping_version', '映射版本', {
      allowNull: false,
      defaultValue: 1,
      comment: '裁决针对的是**哪一代**机器结果；换映射后旧裁决不会被套用到新结果上',
    }),

    enumStr(
      'scope',
      '裁决类别',
      [
        { label: '异常核对', value: 'anomaly' },
        { label: '去重裁决', value: 'duplicate' },
      ],
      {
        allowNull: false,
        defaultValue: 'anomaly',
        comment: '两类共用一张表（形状相同），但**判据不同**：异常看字段质量，去重看跨文件相似',
      },
    ),

    enumStr(
      'action',
      '动作',
      [
        { label: '确认为可用', value: 'confirm' },
        { label: '修正字段值', value: 'correct' },
        { label: '保持待处理', value: 'keep-pending' },
        { label: '驳回（不进档案）', value: 'reject' },
        { label: '两条都保留', value: 'keep-both' },
        { label: '标记为重复', value: 'mark-duplicate' },
      ],
      {
        allowNull: false,
        comment:
          '🔴 这些动作**都不删除任何东西**：keep-both / mark-duplicate 只是在"人的意见"上做标记，' +
          '原始行与机器结果一律原样保留（用户 C 条：不能自动删除原始记录）',
      },
    ),

    str('field_name', '被修正的字段', {
      length: 48,
      allowNull: true,
      comment: '仅在 action=correct 时有值；其余动作留空',
    }),
    json('old_value_json', '原值', {
      allowNull: true,
      comment: '🔴 机器给的（或上一次人工给的值）**原样**留存 —— 只存新值的审计回答不了"原来错成什么样"',
    }),
    json('new_value_json', '新值', {
      allowNull: true,
      comment: '人工给出的值；`correct` 之外的动作也记（例如 confirm 记下"确认时看到的是什么"）',
    }),
    str('reason', '依据 / 备注', {
      length: 255,
      allowNull: true,
      comment: '人写的一句话依据。⚠️ 不是错误码 —— 写给人看的',
    }),

    belongsTo('operator_user', '操作人', 'users', 'operator_user_id', { allowNull: true }),
    str('operator_username', '操作人账号', {
      length: 64,
      allowNull: true,
      comment: '快照：用户被改名/删除后，审计仍能回答"当时是谁"',
    }),
    ts('operated_at', '操作时刻', { allowNull: false }),
  ],
  indexes: [
    { fields: ['batch_id'] },
    { fields: ['row_id'] },
    { fields: ['row_id', 'scope'] },
    { fields: ['operated_at'] },
    { fields: ['operator_user_id'] },
  ],
});
