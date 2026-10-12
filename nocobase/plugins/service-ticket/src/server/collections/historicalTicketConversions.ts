import { belongsTo, defineAppCollection, json, str, text, ts } from './_helpers';

/**
 * historicalTicketConversions —— 「**转为当前服务单**」的来源关联与创建审计
 * （P11-3 第 4 项 · 用户 D 条后半段）
 *
 * =============================================================================
 * 用户原话
 * =============================================================================
 *  「**只有明确仍需继续处理的历史事项**，才允许由授权员工通过**单独的**
 *    『转为当前服务单』操作进入当前工作流。该操作必须**保留历史来源关联和创建审计**，
 *    **不得批量自动转单**。」
 *
 * =============================================================================
 * 为什么单独一张表（而不是在工单上挂一列）
 * =============================================================================
 * 工单侧要回答的是"这张工单是不是由历史转来的、从哪一条来的"；
 * 档案侧要回答的是"这条历史事项后来变成了哪张工单、谁转的、为什么"。
 * 两个方向都需要，但**只有一处**能是事实来源。
 *
 * ⇒ 本文档唯一事实来源放在**转换记录**这一侧：
 *    · 一条档案**最多**转一次（`archive_id` UNIQUE + `idempotency_key` UNIQUE）
 *      ⇒ "不得批量自动转单"与"重复点击不重复建单"同时成立；
 *    · 工单侧通过本表反查即可，**不需要动 `service_tickets`** ——
 *      这一点是刻意的：`service_tickets` 是已冻结的模型，
 *      为了一个可反查的关系去改它，收益小、回归风险大。
 *
 * ⚠️ **它与 `historicalServiceArchives.conversion_state` 是同一事实的两面**：
 *    转换成功后两者在**同一个事务语义**里更新（先写本表，成功后再改状态），
 *    门禁断言两者一致 —— 不允许出现"记录里转过了、档案上还说没转"的漂移。
 */
export default defineAppCollection({
  name: 'historicalTicketConversions',
  title: '历史转当前服务单审计',
  fields: [
    belongsTo('archive', '来源历史档案', 'historicalServiceArchives', 'archive_id', {
      allowNull: false,
      comment: '🔴 非空：每一次转换都必须能回答"从哪条历史档案转来的"',
    }),
    belongsTo('batch', '来源批次', 'historicalImportBatches', 'batch_id', { allowNull: false }),
    belongsTo('row', '来源原始行', 'historicalImportRows', 'row_id', { allowNull: false }),

    str('idempotency_key', '幂等键', {
      length: 64,
      allowNull: false,
      comment: 'sha256("convert|" + 档案 id)；**UNIQUE** ⇒ 同一条档案只能转出一张工单',
    }),

    // ---------------- 生成的工单 ----------------
    belongsTo('ticket', '生成的服务单', 'serviceTickets', 'ticket_id', { allowNull: true }),
    str('ticket_no', '服务单号', {
      length: 32,
      allowNull: true,
      comment: '快照：即便工单被清理，审计里仍能看到"当时建的是哪一张"',
    }),

    str('reason', '转单原因', {
      length: 255,
      allowNull: false,
      comment:
        '🔴 **必填**："仍需继续处理"是人工判断，必须留下判断依据 —— ' +
        '一个没有理由的转单请求，事后无法复核它是否真的该转',
    }),
    text('note', '备注', { allowNull: true }),

    belongsTo('converted_by_user', '转单人', 'users', 'converted_by_user_id', { allowNull: true }),
    str('converted_by_username', '转单人账号', { length: 64, allowNull: true }),
    ts('converted_at', '转单时刻', { allowNull: false }),

    json('snapshot_json', '转单时的历史快照', {
      allowNull: true,
      comment: '转单那一刻的档案关键字段；用于回答"转过去的时候，历史那边写的是什么"',
    }),
  ],
  indexes: [
    { fields: ['idempotency_key'], unique: true },
    { fields: ['archive_id'], unique: true },
    { fields: ['batch_id'] },
    { fields: ['ticket_id'] },
    { fields: ['converted_at'] },
  ],
});
