import { belongsTo, CREATED_AT_COLUMN, defineAppCollection, enumStr, json, str, ts } from './_helpers';
import { EVENT_TYPE_OPTIONS, OPERATOR_KIND_OPTIONS, TICKET_STATUS_OPTIONS } from './_options';

/**
 * ticketEvents —— 工单事件（业务时间线）
 *
 * 这是本系统可审计性的核心：
 *  - **任何状态变更都必须伴随事件**，且与状态写入在同一个事务内（TicketService 负责）。
 *  - 客户/师傅的匿名操作没有 operator_user_id，用 operator_kind 区分身份。
 *  - summary 是人可读的一句话（门店同事、总部都能看懂）；
 *    metadata_json 存结构化补充（金额、原因、原/新门店编码等），供报表与追溯。
 *
 * 事件表只追加，不修改、不删除。
 */
export default defineAppCollection({
  name: 'ticketEvents',
  title: '工单事件',
  fields: [
    belongsTo('ticket', '所属工单', 'serviceTickets', 'ticket_id', {
      allowNull: false,
    }),
    belongsTo('visit', '关联回执', 'serviceVisits', 'visit_id', {
      allowNull: true,
      comment: '与某次上门相关时填写',
    }),
    enumStr('event_type', '事件类型', EVENT_TYPE_OPTIONS, { allowNull: false }),
    enumStr('from_status', '原状态', TICKET_STATUS_OPTIONS, { allowNull: true }),
    enumStr('to_status', '新状态', TICKET_STATUS_OPTIONS, { allowNull: true }),
    belongsTo('operator_user', '操作人', 'users', 'operator_user_id', {
      allowNull: true,
      comment: '客户提交/评价时为空',
    }),
    enumStr('operator_kind', '操作者身份', OPERATOR_KIND_OPTIONS, { allowNull: false }),
    str('summary', '事件摘要', {
      length: 255,
      allowNull: false,
      comment: '如：改派：王师傅 → 李师傅；上门时间 14:00 → 16:00',
    }),
    json('metadata_json', '结构化补充', {
      allowNull: true,
      comment: '金额、原因、原/新门店编码、消息 ID 等',
    }),
  ],
  indexes: [
    // 工单详情页时间线：WHERE ticket_id = ? ORDER BY created_at
    // 时间戳列必须用 CREATED_AT_COLUMN（NocoBase 注入 camelCase createdAt）
    { fields: ['ticket_id', CREATED_AT_COLUMN] },
    { fields: ['event_type'] },
    { fields: ['operator_user_id'] },
    { fields: [CREATED_AT_COLUMN] },
  ],
});
