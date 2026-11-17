import { belongsTo, defineAppCollection, str, ts } from './_helpers';

/**
 * serviceArchiveQuerySessions —— 客户查询会话（ARC-V1 / A4）
 *
 * 验证码验证成功后签发一枚**高熵** token（明文只返回给客户一次），
 * 库里只存哈希。会话**绑定门店 + 手机号**：
 *   · 换门店、换手机号、改参数都拿不到数据 —— 因为查询不读请求里的
 *     store/mobile，只读**会话里**的那两个值。
 *
 * 这一条比"校验参数"更强：参数根本不参与查询。
 * 攻击者拿到 token 也只能看到"签发时那个人在那个店"的档案。
 */
export default defineAppCollection({
  name: 'serviceArchiveQuerySessions',
  title: '档案查询会话',
  fields: [
    str('token_hash', '会话令牌哈希', {
      length: 64,
      allowNull: false,
      comment: '🔒 sha256(token)，明文只在签发响应里出现一次',
    }),
    belongsTo('store', '门店', 'stores', 'store_id', { allowNull: false }),
    str('customer_mobile', '客户手机号', { length: 20, allowNull: false }),
    ts('expires_at', '过期时间', { allowNull: false, comment: '30 分钟' }),
    ts('revoked_at', '撤销时间', { allowNull: true }),
    ts('last_seen_at', '最近使用时间', { allowNull: true }),
    str('ip_hash', '签发IP哈希', { length: 64, allowNull: true }),
  ],
  indexes: [
    { fields: ['token_hash'], unique: true },
    { fields: ['store_id', 'customer_mobile'] },
    { fields: ['expires_at'] },
  ],
});
