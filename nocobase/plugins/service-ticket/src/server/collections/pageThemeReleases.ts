/**
 * `pageThemeReleases` —— **客户 H5 装修的已发布版本**（UX-01D M1）。
 *
 * 关键性质：**不可变、只追加**。
 *   · 每一行是**一份完整快照**（`doc`），不是"相对上一版的补丁"——
 *     否则任意一条历史缺失都会让"回滚到 v3"变成一次推理；
 *   · `version` 按 scope 单调递增（`UNIQUE(scope, version)` 是结构性保证，
 *     多实例并发时靠它兜底，而不是靠"先查再插"）；
 *   · 公开接口只读**最大 version** 的那一行 ⇒ 客户永远看到"完整且已提交"的配置，
 *     不可能读到草稿，也不可能出现"新品牌 + 旧文案"的字段混合；
 *   · 回滚 = **以旧快照再发一版**（`rolled_back_from` 记录来源版本），
 *     **不删除、不改写**任何历史行。
 *
 * 边界：与草稿表一样，只经 `svc:uiTheme*` 受控动作读写，原生 CRUD 对业务角色全关。
 */
import { belongsTo, defineAppCollection, int, json, str, ts } from './_helpers';

export default defineAppCollection({
  name: 'pageThemeReleases',
  title: '客户页面装修发布版本',
  fields: [
    str('scope', '作用域', {
      length: 16,
      allowNull: false,
      defaultValue: 'hq',
      comment: 'v1 只有 hq',
    }),
    int('version', '版本号', {
      allowNull: false,
      comment: '按 scope 从 1 单调递增；公开接口读最大者',
    }),
    json('doc', '配置快照', {
      allowNull: false,
      comment: '完整快照（不可变）：brand / theme / copy / modules + schema_version',
    }),
    belongsTo('published_by_user', '发布人', 'users', 'published_by_user_id', { allowNull: true }),
    ts('published_at', '发布时间', { allowNull: false }),
    str('note', '发布说明', { length: 200, allowNull: true, comment: '如「换主题」「回滚到 v2」' }),
    int('rolled_back_from', '回滚来源版本', {
      allowNull: true,
      comment: '普通发布为 null；回滚时记录"从哪一版抄过来的"',
    }),
    str('request_id', '请求号', {
      length: 64,
      allowNull: true,
      comment: 'X-Request-Id：同号重放回放，同号不同内容 ⇒ 409',
    }),
  ],
  indexes: [
    // 版本号在 scope 内唯一 —— 并发发布不会产生两个 v5。
    // ⚠️ 这条唯一索引**同时**是公开接口的查询形状（WHERE scope=? ORDER BY version DESC LIMIT 1），
    //    不要再声明一条非唯一的同列索引：DEV-17 的同义索引会拖慢写入，且门禁会判"重复声明"。
    { fields: ['scope', 'version'], unique: true },
    { fields: ['request_id'], unique: true },
  ],
});
