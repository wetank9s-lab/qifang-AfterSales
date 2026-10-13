import { belongsTo, defineAppCollection, enumStr, int, str, ts } from './_helpers';
import { MEDIA_KIND_OPTIONS } from './_options';

/**
 * customerMedias —— 客户上传的媒体文件（P11-4 · B 条）
 *
 * 安全设计与 `serviceVisitPhotos` **同源**（docs/SECURITY.md）：
 *  1) 文件本体放**私有目录**（`UPLOAD_PRIVATE_DIR`），不在 Web 可直读路径下；
 *  2) 读取只走应用受控端点（按会话 token 或进度 token 校验），**不生成公开 URL**；
 *  3) `storage_key` 是私有存储内的相对路径，**不对外返回**；
 *  4) `mime` 由服务端 **magic bytes** 判定，不信任上传时声明的 Content-Type 与扩展名
 *     —— "伪装类型"（把 .exe 改名成 .jpg）在这一步被拒；
 *  5) 图片走既有重编码管线：按 EXIF Orientation 转正 → 剥离 EXIF/GPS → 重新编码；
 *  6) `upload_ip_hash` 只存 sha256(ip+salt)。
 *
 * 🔴 **与 serviceVisitPhotos 的关键区别**：媒体先挂在**会话**上（提交时随工单绑定），
 *    所以 `session_id` 必填、`ticket_id` 可空；绑定后两者都非空。
 *    这使"未完成上传"可被精确定位（`session_id` 有值而 `ticket_id` 为 NULL）。
 */
export default defineAppCollection({
  name: 'customerMedias',
  title: '客户媒体文件',
  fields: [
    belongsTo('session', '所属会话', 'customerMediaSessions', 'session_id', {
      allowNull: false,
      comment: '上传时就必须有会话；会话过期则不可再写入',
    }),
    /** 绑定工单后回填（提交成功时与会话一起原子更新） */
    belongsTo('ticket', '所属工单', 'serviceTickets', 'ticket_id', {
      allowNull: true,
      comment: 'NULL = 尚未提交；与 session.ticket_id 保持一致',
    }),
    enumStr('media_kind', '媒体类型', MEDIA_KIND_OPTIONS, {
      allowNull: false,
      comment: 'image / audio / video —— 由服务端按 magic bytes 判定，不看扩展名',
    }),
    str('storage_key', '私有存储路径', {
      length: 255,
      allowNull: false,
      comment: '私有目录内相对路径，禁止对外输出',
    }),
    str('mime', 'MIME', {
      length: 64,
      allowNull: false,
      comment: '服务端 magic bytes 判定结果，如 image/jpeg、audio/webm',
    }),
    int('size', '字节数', { allowNull: false }),
    int('duration_ms', '时长(毫秒)', {
      allowNull: true,
      comment: '语音/视频才有；图片为 NULL。语音 ≤60000、视频 ≤30000',
    }),
    int('width', '宽', { allowNull: true, comment: '图片重编码后尺寸' }),
    int('height', '高', { allowNull: true }),
    str('original_name', '原始文件名', {
      length: 255,
      allowNull: true,
      comment: '只用于人工辨认与审计，**不参与任何路径拼接**',
    }),
    int('sort_order', '顺序', { allowNull: false, defaultValue: 0 }),
    ts('uploaded_at', '上传时间', { allowNull: false }),
    str('upload_ip_hash', '上传IP哈希', {
      length: 64,
      allowNull: true,
      comment: 'sha256(ip + SIGN_SECRET)，仅用于风控',
    }),
  ],
  indexes: [
    { fields: ['session_id'] },
    { fields: ['ticket_id'] },
    { fields: ['uploaded_at'] },
    // 🔴 同一会话内同一 storage_key 只能有一条：重复提交（双击/重试）时
    //    服务端按"内容哈希相同"复用既有行，而不是插入第二条。
    { fields: ['session_id', 'storage_key'], unique: true },
  ],
});
