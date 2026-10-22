/**
 * `configChangeAudits` —— 总部**配置变更审计**（UX-01C §二/§三）。
 *
 * 为什么需要它（而不是复用既有表）：
 *   · `ticketEvents.ticket_id` 是 `allowNull:false` ⇒ 装不下"与工单无关"的配置变更；
 *   · `exportAudits` 是导出专用（DEV-91），语义不同。
 *   ⇒ 按最小原则新增这一张**只增不改**的审计表，记录每次配置变更的
 *      **操作人 / 时间 / 变更前后值 / 场景 / 请求号**，与配置更新**同事务**写入（见 actions/svc/config-settings.ts）。
 *
 * ⚠️ 只增不改：本表不提供"改内容"的接口；恢复（restore）也**再写一条**新审计，
 *    而不是回改旧行 —— 历史必须可重建。
 */
import { belongsTo, defineAppCollection, str, text } from './_helpers';

export default defineAppCollection({
  name: 'configChangeAudits',
  title: '配置变更审计',
  fields: [
    str('key', '配置键', { length: 64, allowNull: false, comment: '如 sla.accept_minutes' }),
    text('old_value', '变更前值', { allowNull: true }),
    text('new_value', '变更后值', { allowNull: true }),
    belongsTo('operator_user', '操作人', 'users', 'operator_user_id', { allowNull: true }),
    str('operator_name', '操作人显示名', { length: 64, allowNull: true, comment: '昵称/账号名，非 email' }),
    str('scene', '场景', { length: 32, allowNull: true, comment: 'update / restore' }),
    str('request_id', '请求号', { length: 64, allowNull: true, comment: 'X-Request-Id，串联同一请求' }),
    str('note', '备注', { length: 255, allowNull: true }),
  ],
  // 按 key 查历史；不建唯一约束（同 key 多条）。
  indexes: [
    { fields: ['key'] },
    { fields: ['created_at'] },
    // UX-01C-R8：幂等兜底 —— 同一请求号 + 同一配置键最多一条审计。
    // 重试/重复提交即使并发穿过"先查是否已回放"，也会被数据库挡住。
    { fields: ['request_id', 'key'], unique: true },
  ],
});
