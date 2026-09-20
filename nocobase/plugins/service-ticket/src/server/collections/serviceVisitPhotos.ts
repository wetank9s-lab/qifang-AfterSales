import { belongsTo, defineAppCollection, enumStr, int, str, ts } from './_helpers';
import { PHOTO_TYPE_OPTIONS } from './_options';

/**
 * serviceVisitPhotos —— 现场照片
 *
 * 安全设计（docs/SECURITY.md）：
 *  1) 文件本体放在**私有目录**（.env 的 UPLOAD_PRIVATE_DIR），不在 Web 可直读路径下。
 *  2) 读取必须走应用受控端点：校验登录态/门店权限，或校验短时 HMAC 签名 URL。
 *     nginx 侧禁止用 alias 暴露该目录（见 nginx/conf.d/service.conf 注释）。
 *  3) `storage_key` 是私有存储内的相对路径，**不对外返回**。
 *  4) `mime` 由服务端 magic bytes 判定，不信任上传时声明的 Content-Type 与扩展名。
 *  5) 重编码时剥离 EXIF/GPS；`upload_ip_hash` 只存 sha256(ip+salt)，不存明文 IP。
 */
export default defineAppCollection({
  name: 'serviceVisitPhotos',
  title: '现场照片',
  fields: [
    belongsTo('visit', '所属回执', 'serviceVisits', 'visit_id', {
      allowNull: false,
      comment: '挂在 Visit 上而不是 Ticket，避免多次上门互相覆盖',
    }),
    enumStr('photo_type', '照片类型', PHOTO_TYPE_OPTIONS, {
      allowNull: false,
      defaultValue: 'onsite',
    }),

    // NocoBase 内置附件表记录（用于后台预览与管理）
    belongsTo('file', '附件记录', 'attachments', 'file_id', {
      allowNull: false,
      comment: 'NocoBase File Collection',
    }),

    str('storage_key', '私有存储路径', {
      length: 255,
      allowNull: false,
      comment: '私有目录内相对路径，禁止对外输出',
    }),
    str('mime', 'MIME', {
      length: 64,
      allowNull: false,
      comment: '服务端 magic bytes 判定结果，如 image/jpeg',
    }),
    int('size', '字节数', { allowNull: false }),
    int('width', '宽', { allowNull: true, comment: '去 EXIF 重编码后尺寸' }),
    int('height', '高', { allowNull: true }),
    int('sort_order', '顺序', { allowNull: false, defaultValue: 0 }),
    ts('uploaded_at', '上传时间', { allowNull: false }),
    str('upload_ip_hash', '上传IP哈希', {
      length: 64,
      allowNull: true,
      comment: 'sha256(ip + SIGN_SECRET)，仅用于风控',
    }),
  ],
  indexes: [
    { fields: ['visit_id'] },
    { fields: ['file_id'], unique: true },
    { fields: ['uploaded_at'] },
  ],
});
