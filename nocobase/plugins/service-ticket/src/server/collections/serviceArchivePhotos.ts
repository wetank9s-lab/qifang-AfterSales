import {
  belongsTo,
  bool,
  defineAppCollection,
  enumStr,
  int,
  str,
  ts,
} from './_helpers';
import { ARCHIVE_PHOTO_TYPE_OPTIONS } from './_options';

/**
 * serviceArchivePhotos —— 档案照片（ARC-V1 / A1）
 *
 * 安全设计**照抄** `serviceVisitPhotos`（已验证过的私有照片范式），
 * 不引入对象存储、不开放 File Manager 匿名列表：
 *
 *  1) 文件本体在私有目录，不在 Web 可直读路径下；
 *  2) 读取走受控端点，校验"会话 + 门店 + 档案归属"三重；
 *  3) `storage_key` **永不对外返回**（服务层做白名单投影）；
 *  4) `mime` 由服务端 magic bytes 判定，不信扩展名与 Content-Type；
 *  5) 重编码剥离 EXIF/GPS；不存明文 IP，只存哈希。
 *
 * ⚠️ `stage_id` 与 `archive_id` 必须指向**同一档案**（执行令 A1 第 8 条）。
 *    数据库无法表达这种跨行一致性，必须由服务层在写入前校验：
 *    `stage.archive_id === photo.archive_id`，否则一张 A 档案的阶段照片
 *    会被挂到 B 档案上——那是最难发现、后果最严重的一类越权。
 */
export default defineAppCollection({
  name: 'serviceArchivePhotos',
  title: '档案照片',
  fields: [
    belongsTo('archive', '所属档案', 'serviceArchives', 'archive_id', {
      allowNull: false,
    }),
    belongsTo('stage', '所属阶段', 'serviceArchiveStages', 'stage_id', {
      allowNull: true,
      comment: '暖通阶段照片必填；普通上门服务为 NULL（用 photo_type 区分前后）',
    }),
    enumStr('photo_type', '照片类型', ARCHIVE_PHOTO_TYPE_OPTIONS, {
      allowNull: false,
      comment: 'before/after=普通服务；stage=暖通阶段',
    }),

    str('storage_key', '私有存储路径', {
      length: 255,
      allowNull: false,
      comment: '🔒 私有目录内相对路径，禁止对外输出（含错误信息与日志）',
    }),
    belongsTo('file', '附件记录', 'attachments', 'file_id', {
      allowNull: true,
      comment: 'NocoBase File Collection，仅作溯源；可为空',
    }),
    str('mime', 'MIME', {
      length: 64,
      allowNull: false,
      comment: '服务端 magic bytes 判定结果',
    }),
    int('byte_size', '字节数', { allowNull: false }),
    int('width', '宽', { allowNull: true }),
    int('height', '高', { allowNull: true }),
    bool('exif_stripped', '已剥离EXIF', {
      allowNull: false,
      defaultValue: true,
    }),

    /**
     * 是否可对客户公开。
     *
     * ⚠️ 单靠它**不够**：真正对外可见 = `published=true` **且** 所属档案
     *    `visibility=published` **且**（阶段照片时）阶段已 done。
     *    把三个条件中的任意两个写成"数据字段默认值"，都会漏掉第三个组合。
     */
    bool('published', '可对客户公开', { allowNull: false, defaultValue: false }),

    belongsTo('uploaded_by_user', '上传人', 'users', 'uploaded_by', { allowNull: true }),
    ts('uploaded_at', '上传时间', { allowNull: false }),
    str('upload_ip_hash', '上传IP哈希', {
      length: 64,
      allowNull: true,
      comment: 'sha256(ip + SIGN_SECRET)，仅风控用',
    }),
  ],
  indexes: [
    { fields: ['archive_id', 'photo_type'] },
    { fields: ['stage_id'] },
    { fields: ['uploaded_at'] },
  ],
});
