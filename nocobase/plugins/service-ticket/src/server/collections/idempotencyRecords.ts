import { CREATED_AT_COLUMN, defineAppCollection, int, json, str } from './_helpers';

/**
 * idempotencyRecords —— 幂等记录
 *
 * 解决三类"重复提交"：
 *  1) 客户在 H5 连点提交按钮 → 客户端生成 request_id（UUID），服务端以
 *     unique(scene, idempotency_key) 拦截，第二次直接回放首次响应。
 *  2) 师傅弱网下重复提交回执 → key 由 visit_id + 状态派生。
 *  3) 门店重复点"确认" → key 由 visit_id + 动作派生。
 *
 * `response_json` 保存首次执行的响应体，重放时原样返回，
 * 保证前端两次调用拿到完全一致的 ticket_no / visit_no。
 *
 * 记录保留 30 天后由 guardCleanup 清理（窗口已远大于业务重试周期）。
 */
export default defineAppCollection({
  name: 'idempotencyRecords',
  title: '幂等记录',
  fields: [
    str('scene', '场景', {
      length: 32,
      allowNull: false,
      comment: 'public_ticket / technician_submit / review_submit / store_confirm',
    }),
    str('idempotency_key', '幂等键', {
      length: 64,
      allowNull: false,
      comment: '客户端 request_id，或服务端派生的确定性指纹',
    }),
    str('resource_type', '产物类型', {
      length: 32,
      allowNull: false,
      comment: 'serviceTicket / serviceVisit',
    }),
    int('resource_id', '产物ID', {
      allowNull: false,
      comment: '首次执行产生的记录 ID（仅内部使用）',
    }),
    json('response_json', '首次响应', {
      allowNull: true,
      comment: '重放时原样返回给客户端',
    }),
  ],
  indexes: [
    { fields: ['scene', 'idempotency_key'], unique: true },
    // guardCleanup 定时任务扫描：WHERE created_at < now() - 30d
    // 列名必须用 CREATED_AT_COLUMN（NocoBase 注入的是 camelCase createdAt）
    { fields: [CREATED_AT_COLUMN] },
  ],
});
