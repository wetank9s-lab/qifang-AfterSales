import { belongsTo, defineAppCollection, enumStr, int, str, ts } from './_helpers';
import { MEDIA_KIND_OPTIONS, MEDIA_SESSION_STATUS_OPTIONS } from './_options';

/**
 * customerMediaSessions —— 客户媒体**上传会话**（P11-4 · B 条）
 *
 * ===========================================================================
 * 为什么需要"会话"这一层，而不是让客户直传工单
 * ===========================================================================
 * 客户提交工单与上传媒体是**两个时刻**：先选好照片/录好音，再点"提交"。
 * 若没有会话，媒体就只能先挂在一个**还不存在的工单**上 ⇒ 要么允许"无主媒体"
 * （匿名可创建、无人能清理 ⇒ 正是用户禁止的"未完成上传"），要么等工单建好再传
 * （提交时网络失败就丢媒体）。
 *
 * ⇒ 会话把"我这次要交的材料"变成一个**有主、可过期、可作废**的实体：
 *   · 匿名创建（只凭一个随机会话 token，不暴露任何客户信息）；
 *   · 有 TTL（过期即不可用，超期的由清理任务物理删除文件）；
 *   · 提交时**原子绑定**到工单；未使用的会话到期作废。
 *
 * 🔴 会话 token 与进度 Token / 评价 Token 是**三套独立凭证**：
 *    它只授权"往这个会话里写文件"，**不能**用来读工单进度（那会越权）。
 */
export default defineAppCollection({
  name: 'customerMediaSessions',
  title: '客户媒体上传会话',
  fields: [
    str('session_token_hash', '会话Token哈希', {
      length: 64,
      allowNull: false,
      unique: true,
      comment: 'sha256(base64url token)；明文只在创建响应里出现一次，永不入库',
    }),
    enumStr('status', '会话状态', MEDIA_SESSION_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: 'open',
      comment: 'open=可上传 · bound=已绑定工单 · expired=超期作废 · voided=主动作废',
    }),
    enumStr('media_kind', '媒体种类', MEDIA_KIND_OPTIONS, {
      allowNull: false,
      defaultValue: 'mixed',
      comment: '本次会话允许的种类：mixed=图片+语音+视频（投诉单也走这个）',
    }),
    ts('expires_at', '会话到期', {
      allowNull: false,
      comment: '创建时刻 + MEDIA_SESSION_TTL_MINUTES；过期后不可再上传',
    }),
    int('upload_count', '已上传数量', { allowNull: false, defaultValue: 0 }),
    int('upload_bytes', '已上传字节', { allowNull: false, defaultValue: 0 }),
    str('upload_ip_hash', '上传IP哈希', {
      length: 64,
      allowNull: true,
      comment: 'sha256(ip + SIGN_SECRET)，仅风控，不存明文 IP',
    }),
    /** 绑定后的工单（提交成功时原子写入；未提交恒为 NULL） */
    belongsTo('ticket', '所属工单', 'serviceTickets', 'ticket_id', {
      allowNull: true,
      comment: 'NULL = 还没提交；绑定后会话状态转 bound',
    }),
    ts('bound_at', '绑定时间', { allowNull: true }),
  ],
  indexes: [
    { fields: ['status'] },
    { fields: ['expires_at'] },
    { fields: ['ticket_id'] },
  ],
});
