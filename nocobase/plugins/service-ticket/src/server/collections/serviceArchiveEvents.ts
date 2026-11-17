import {
  belongsTo,
  defineAppCollection,
  enumStr,
  json,
  str,
  ts,
} from './_helpers';
import { ARCHIVE_EVENT_TYPE_OPTIONS } from './_options';

/**
 * serviceArchiveEvents —— 档案审计事件（ARC-V1 / A1）
 *
 * **只记录能归属到具体档案的事件**（用户 2026-11-09 明确）。
 * 验证码发送、客户查询审计这类"还没有档案"或"跨档案"的事实，
 * 不应强塞进本表 —— 它们属于 A4 的验证码/会话表。硬塞的后果是
 * `archive_id` 变成可空、然后所有按档案聚合的逻辑都要额外处理 NULL，
 * 而这个表的价值恰恰在于"给我这个档案的完整履历"。
 *
 * `actor_role` 存**快照**而不是外键：角色可以改名、用户可以被删，
 * 但"当时是谁以什么身份做的"必须永远可读。
 *
 * `payload_json` **不得含**客户手机号明文、验证码、storage_key。
 * 需要定位对象时存 id。
 */
export default defineAppCollection({
  name: 'serviceArchiveEvents',
  title: '档案事件',
  fields: [
    belongsTo('archive', '所属档案', 'serviceArchives', 'archive_id', {
      allowNull: false,
    }),
    belongsTo('stage', '所属阶段', 'serviceArchiveStages', 'stage_id', {
      allowNull: true,
      comment: '阶段类事件才有值；同样必须与 archive_id 同属一个档案',
    }),
    enumStr('event_type', '事件类型', ARCHIVE_EVENT_TYPE_OPTIONS, {
      allowNull: false,
    }),
    belongsTo('actor_user', '操作人', 'users', 'actor_user_id', { allowNull: true }),
    str('actor_role', '操作人角色', {
      length: 32,
      allowNull: true,
      comment: '快照，不随角色改名而漂移',
    }),
    json('payload_json', '事件数据', {
      allowNull: true,
      comment: '🔒 不含手机号明文/验证码/storage_key',
    }),
    str('note', '备注', { length: 255, allowNull: true }),
    ts('created_at_custom', '发生时间', { allowNull: false }),
  ],
  indexes: [
    { fields: ['archive_id', 'created_at_custom'] },
    { fields: ['stage_id'] },
    { fields: ['event_type'] },
  ],
});
