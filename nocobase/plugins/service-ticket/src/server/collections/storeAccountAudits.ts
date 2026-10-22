/**
 * `storeAccountAudits` —— 门店账号**授权门店变更审计**（SEC-STORE-01）。
 *
 * 为什么单独一张表（不复用 `storeProfileAudits` / `configChangeAudits`）：
 *   · `storeProfileAudits` 的主键语义是「门店 × 字段」（改的是门店资料）；
 *   · `configChangeAudits` 的主键语义是「配置键」；
 *   · 本表的主键语义是「**用户 × 一次授权集合变更**」（旧集合 → 新集合）。
 *   三者查询维度不同，混表会让"这个账号被谁改过、改成了哪些门店"变成一次字符串解析。
 *
 * 只增不改：撤销/恢复都**再写一条**，历史可重建。
 */
import { belongsTo, defineAppCollection, json, str } from './_helpers';

export default defineAppCollection({
  name: 'storeAccountAudits',
  title: '门店账号授权审计',
  fields: [
    belongsTo('user', '被授权的账号', 'users', 'user_id', { allowNull: false }),
    str('user_email', '账号邮箱', { length: 128, allowNull: true, comment: '便于按人检索（非敏感口令）' }),
    json('old_store_ids', '变更前门店 ID 集合', { allowNull: true }),
    json('new_store_ids', '变更后门店 ID 集合', { allowNull: true }),
    belongsTo('operator_user', '操作人', 'users', 'operator_user_id', { allowNull: true }),
    str('operator_name', '操作人显示名', { length: 64, allowNull: true }),
    str('scene', '场景', { length: 32, allowNull: true, comment: 'update / restore' }),
    str('request_id', '请求号', { length: 64, allowNull: true }),
  ],
  indexes: [
    { fields: ['user_id'] },
    { fields: ['created_at'] },
    // 幂等兜底：同一请求号最多一条审计
    { fields: ['request_id'], unique: true },
  ],
});
