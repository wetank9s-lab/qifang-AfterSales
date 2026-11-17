import {
  belongsTo,
  bool,
  defineAppCollection,
  enumStr,
  int,
  str,
  ts,
} from './_helpers';
import { BANNER_STATUS_OPTIONS } from './_options';
import { BANNER_STATUS } from '../constants';

/**
 * `store_banners` —— 客户报修页顶部的**公开**横幅（B-36 · R2 最后一项）
 *
 * =============================================================================
 * 与客户私有附件（`customer_medias` / `service_visit_photos`）是**两套东西**
 * =============================================================================
 *   它们是**相反**的授权模型，绝不能合并：
 *
 *   | | 客户附件 / 师傅照片 | 本表 Banner |
 *   |---|---|---|
 *   | 可见性 | **只有该工单的人**（会话/进度 Token） | **所有匿名访客** |
 *   | 缓存 | `private, no-store`（含家庭住址画面） | **公开可缓存**（营销资产） |
 *   | 目录 | `UPLOAD_PRIVATE_DIR`（nginx docroot 之外） | 独立公开目录（见 banner-store.ts） |
 *   | 内容 | 客户拍摄的任意现场图 | **仅**平台管理员上传的品牌图 |
 *
 *   ⇒ 本轮**不**改动 `publicMedia` / `/storage/uploads/` / 进度 Token 的任何规则；
 *     本表走一条**全新的、只服务已发布 Banner 的**公开读路径。
 *
 * =============================================================================
 * 发布模型：与 `pageThemeReleases` 同源的"草稿 + 已发布"两态，但更简
 * =============================================================================
 *   · `status` 只有 `DRAFT`（草稿，客户看不到）/ `PUBLISHED`（已发布，客户可见）
 *     / `REVOKED`（已下架，客户**立刻**看不到，但行保留供审计）；
 *   · `revoked_at` 有值 = 已下架。公开读的过滤条件是
 *     `status='PUBLISHED' AND revoked_at IS NULL` —— **两个条件都要**，
 *     只判 status 会让"下架过的再发布"绕过下架留痕这一层。
 *   · `store_id` 为空 = **总部通用 Banner**（所有门店的回退项）。
 *     这是"门店没配就用总部"的落地方式：一个 NULL 表达"通用"，
 *     不需要额外的 `is_default` 布尔位（两个字段表达同一件事会漂移）。
 */
export default defineAppCollection({
  name: 'storeBanners',
  title: '客户页 Banner',
  fields: [
    /**
     * 适用门店。**NULL = 总部通用**（所有门店的回退项）。
     *
     * ⚠️ 只有 hq_admin 能创建 `store_id IS NULL` 的通用 Banner；
     *    门店管理员只能创建"自己授权门店"的 Banner（服务层 `assertStoreInScope`）。
     *    这条约束数据库表达不了，必须由服务层守住。
     */
    belongsTo('store', '适用门店', 'stores', 'store_id', {
      allowNull: true,
      comment: 'NULL = 总部通用（门店无专属 Banner 时回退到它）',
    }),

    /**
     * 内容指纹文件名（如 `banner-3f9a…c21.jpg`）。
     *
     * 🔴 **必须带指纹**：URL 固定时，管理员换了同一张位置的 Banner 后
     *    浏览器/中间层仍拿旧图 —— 表现是"后台明明换了、客户还是看旧的"，
     *    而这类问题只在"换了图"时出现，验收时极易漏掉。
     *    指纹取**内容 sha256 前 16 位**，内容变则 URL 变 ⇒ 缓存自然失效。
     */
    str('file_name', '文件名', {
      length: 128,
      allowNull: false,
      comment: '含内容指纹；公开 URL 的最后一段',
    }),
    /** 私有目录内的相对路径（**永不对外**，公开 URL 只暴露 file_name） */
    str('storage_key', '存储路径', {
      length: 255,
      allowNull: false,
      comment: '🔒 公开目录内相对路径，禁止对外输出（含错误信息与日志）',
    }),
    str('mime', 'MIME', {
      length: 64,
      allowNull: false,
      comment: '服务端 magic bytes 判定结果；只允许 jpeg/png/webp',
    }),
    int('byte_size', '字节数', { allowNull: false }),
    int('width', '宽', { allowNull: true }),
    int('height', '高', { allowNull: true }),
    /** 内容 sha256（完整 64 位十六进制）—— 同时用于去重与"这张图换没换"的判据 */
    str('content_hash', '内容哈希', {
      length: 64,
      allowNull: false,
      comment: 'sha256 全量；file_name 里的指纹是它的前 16 位',
    }),

    enumStr('status', '状态', BANNER_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: BANNER_STATUS.DRAFT,
      comment: 'DRAFT=客户不可见；PUBLISHED=已发布；REVOKED=已下架（保留行供审计）',
    }),
    ts('published_at', '发布时间', { allowNull: true }),
    ts('revoked_at', '下架时间', { allowNull: true, comment: '有值 = 已下架' }),

    belongsTo('uploaded_by_user', '上传人', 'users', 'uploaded_by_user_id', { allowNull: true }),
    belongsTo('published_by_user', '发布人', 'users', 'published_by_user_id', { allowNull: true }),
    ts('uploaded_at', '上传时间', { allowNull: false }),
    str('request_id', '请求号', {
      length: 64,
      allowNull: true,
      comment: 'X-Request-Id：同号重放回放，同号不同内容 ⇒ 409',
    }),

    /**
     * 无障碍替代文本。**不强制**（允许空）—— 强填会逼管理员写无意义的字符串；
     * 但只要有值就会渲染成 `alt`，空则退化为品牌名（见 H5 侧）。
     */
    str('alt_text', '替代文本', { length: 120, allowNull: true }),

    bool('enabled', '启用', {
      allowNull: false,
      defaultValue: true,
      comment: '与 status 正交：停用开关用于临时摘除（不改发布状态）',
    }),
  ],
  indexes: [
    // 公开读的唯一查询形状：按门店取"已发布且未下架"的最新一条。
    // ⚠️ 声明成复合索引而不是给 store_id/status 各建一条：公开接口每次打开页面都会查，
    //    单列索引会退化成两次位图扫描 + 排序。
    { fields: ['store_id', 'status'] },
    { fields: ['status', 'revoked_at'] },
    // 幂等：同一 request_id 只允许一条
    { fields: ['request_id'], unique: true },
    // 同店同内容只存一份（重复上传同一张图复用既有行）
    { fields: ['store_id', 'content_hash'], unique: true },
  ],
});
