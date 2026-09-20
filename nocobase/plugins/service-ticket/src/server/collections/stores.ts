import { bool, defineAppCollection, int, str } from './_helpers';

/**
 * stores —— 门店
 *
 * H5 报修页的门店下拉、门店人员的数据隔离、报表的门店维度，全部以此表为准。
 * code 是稳定业务编码（如 S01），会印在门店二维码的参数里，**一经使用不可更改**。
 */
export default defineAppCollection({
  name: 'stores',
  title: '门店',
  // 门店数量少（十几家），强制排序保证 H5 下拉顺序稳定
  sortable: true,
  fields: [
    str('code', '门店编码', {
      length: 16,
      allowNull: false,
      unique: true,
      comment: '稳定业务编码，如 S01；用于二维码参数，不可变更',
    }),
    str('name', '门店名称', {
      length: 64,
      allowNull: false,
      comment: '对外展示名称',
    }),
    bool('active', '启用', {
      allowNull: false,
      defaultValue: true,
      comment: 'false 时不出现在客户 H5 的门店下拉中',
    }),
    int('sort_order', '排序', {
      allowNull: false,
      defaultValue: 0,
      comment: 'H5 下拉排序，升序',
    }),
    str('contact_phone', '售后电话', {
      length: 20,
      allowNull: true,
      comment: '门店对外售后电话，展示在 H5 与短信签名位',
    }),
  ],
  indexes: [
    // 客户 H5 门店下拉：WHERE active = true ORDER BY sort_order
    { fields: ['active', 'sort_order'] },
  ],
});
