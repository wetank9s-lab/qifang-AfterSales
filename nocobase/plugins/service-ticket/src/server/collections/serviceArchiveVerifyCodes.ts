import { belongsTo, defineAppCollection, int, str, ts } from './_helpers';

/**
 * serviceArchiveVerifyCodes —— 客户档案查询验证码（ARC-V1 / A4）
 *
 * 三条硬约束（执行令）：
 *   ① **不存明文码**，只存 `sha256(store_id|mobile|code|salt)`；
 *   ② 有效期 / 错误次数 / 重发间隔都在**服务端**判，不信任前端倒计时；
 *   ③ 码**绑定门店 + 手机号** —— 同一串数字在 A 店有效、在 B 店无效。
 *
 * 为什么 `customer_mobile` 存明文而 `code` 存哈希：
 *   查询要按"门店 + 手机号"定位档案，手机号必须是可检索的键；
 *   而验证码是**一次性凭证**，泄露一次就能冒领，所以只能存哈希。
 *   手机号本身在 `service_archives.customer_mobile` 里已经是明文（业务要求按号检索），
 *   这里再加密只会让"同一份数据两种形态"更难对账，不带来实质收益。
 *
 * 不物理删除：过期/用尽的记录保留（审计需要"某号码何时请求过验证码"），
 * 由保留期策略统一清理。
 */
export default defineAppCollection({
  name: 'serviceArchiveVerifyCodes',
  title: '档案查询验证码',
  fields: [
    belongsTo('store', '门店', 'stores', 'store_id', { allowNull: false }),
    str('customer_mobile', '客户手机号', {
      length: 20,
      allowNull: false,
      comment: '检索键；与 store_id 组成防跨店/跨人的边界',
    }),
    str('code_hash', '验证码哈希', {
      length: 64,
      allowNull: false,
      comment: '🔒 sha256(store_id|mobile|code|salt)，**绝不存明文**',
    }),
    ts('expires_at', '过期时间', { allowNull: false, comment: '5 分钟' }),
    int('attempts', '已尝试次数', { allowNull: false, defaultValue: 0 }),
    int('max_attempts', '最大尝试次数', { allowNull: false, defaultValue: 5 }),
    ts('consumed_at', '核销时间', { allowNull: true, comment: '成功或次数用尽后置位' }),
    str('ip_hash', '请求IP哈希', { length: 64, allowNull: true }),
    str('sms_log_id', '短信日志ID', {
      length: 32,
      allowNull: true,
      comment: '关联 sms_logs，便于"客户说没收到"时定位',
    }),
    ts('last_sent_at', '最近发送时间', {
      allowNull: true,
      comment: '重发间隔（60 秒）判据',
    }),
  ],
  indexes: [
    // ⚠️ 只用**两列**。写成 `['store_id','customer_mobile','created_at']` 时，
    //    NocoBase 自动生成的索引名会超过 PG 的 63 字符上限被截断，
    //    而截断后的名字与"另一条三列索引"撞车 ⇒ 启动报
    //    `relation "..._created_a" already exists`。
    //    2026-11-09 实测踩到；两列已足够支撑"按门店+手机号取最近一条"。
    { fields: ['store_id', 'customer_mobile'] },
    { fields: ['expires_at'] },
  ],
});
