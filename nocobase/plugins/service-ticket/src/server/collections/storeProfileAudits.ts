/**
 * `storeProfileAudits` —— 门店资料**变更审计**（UX-01C-R7）。
 *
 * 与 `configChangeAudits` 同型（只增不改、同事务写入、恢复再写一条），
 * 单独建表的原因：门店资料的变更维度是「门店 × 字段」，而配置是「key」；
 * 把两种语义塞进一张表会让查询与约束都变模糊（同 DEV-204/205 的教训：
 * 跨语义复用表，最后没人能一条 SQL 说清"这家门店改过什么"）。
 *
 * ⚠️ 只增不改：本表不提供修改接口；`restore` 也是**新写一条**，
 *    历史必须能完整重建（谁在什么时候把哪个字段从什么改成什么）。
 */
import { belongsTo, defineAppCollection, int, str, text } from './_helpers';

export default defineAppCollection({
  name: 'storeProfileAudits',
  title: '门店资料变更审计',
  fields: [
    int('store_id', '门店 ID', { allowNull: false, comment: 'stores.id（不建外键：门店删除后审计仍需保留）' }),
    str('store_code', '门店编码', { length: 16, allowNull: false, comment: '变更时的门店编码快照' }),
    str('field', '变更字段', {
      length: 32,
      allowNull: false,
      comment: 'name / contact_phone / address / active',
    }),
    text('old_value', '变更前值', { allowNull: true, comment: '统一按字符串存；布尔存 true/false；空存 NULL' }),
    text('new_value', '变更后值', { allowNull: true }),
    belongsTo('operator_user', '操作人', 'users', 'operator_user_id', { allowNull: true }),
    str('operator_name', '操作人显示名', { length: 64, allowNull: true, comment: '昵称/账号名，非 email' }),
    str('scene', '场景', { length: 32, allowNull: true, comment: 'update / restore' }),
    str('request_id', '请求号', { length: 64, allowNull: true, comment: 'X-Request-Id，串联同一请求 / 幂等键' }),
  ],
  // 按门店 + 时间查历史；按字段筛"这个字段被谁改过"
  indexes: [
    { fields: ['store_id'] },
    { fields: ['field'] },
    { fields: ['created_at'] },
    // 幂等兜底：同一请求号 × 门店 × 字段只允许一条审计。
    // 并发重复请求即使同时穿过"先查"这一步，也会在这里被数据库挡住。
    { fields: ['request_id', 'store_id', 'field'], unique: true },
  ],
});
