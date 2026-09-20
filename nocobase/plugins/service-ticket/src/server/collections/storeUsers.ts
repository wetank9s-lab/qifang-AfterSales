import { belongsTo, defineAppCollection } from './_helpers';

/**
 * storeUsers —— 用户 ↔ 门店（多对多中间表）
 *
 * 数据隔离的唯一依据：门店角色用户能看到的工单，范围 = 本表中其被授权的 store_id。
 * 总部角色**不写这张表**，由 ACL 放行全量数据。
 *
 * 一个售后人员可负责多个门店；一个门店可有多个售后人员。
 */
export default defineAppCollection({
  name: 'storeUsers',
  title: '门店人员授权',
  fields: [
    belongsTo('user', '系统用户', 'users', 'user_id', {
      allowNull: false,
      comment: 'NocoBase 内置用户',
    }),
    belongsTo('store', '授权门店', 'stores', 'store_id', {
      allowNull: false,
      comment: '被授权的门店',
    }),
  ],
  indexes: [
    // 同一用户不能被重复授权同一门店
    { fields: ['user_id', 'store_id'], unique: true },
    // 登录后根据 user_id 一次性取出其全部门店
    { fields: ['user_id'] },
    // 按门店查售后人员（派工提醒用）
    { fields: ['store_id'] },
  ],
});
