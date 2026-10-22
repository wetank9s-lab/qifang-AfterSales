/**
 * `pageThemeDrafts` —— **客户 H5 装修草稿**（UX-01D M1）。
 *
 * 为什么需要它（而不是复用 `serviceSettings`）：
 *   · 装修配置是**一份结构化文档**（brand / theme / copy / modules），不是"一键一标量"；
 *     拆成十几个键会让"发布"变成十几次独立写入，中途失败客户会看到**混合态**；
 *   · 需要**草稿 ≠ 线上**这一维度，`serviceSettings` 只有单值、没有"草稿"概念；
 *   · 需要整份快照的**原子发布与回滚**，那要求"版本"是一行不可变记录（见 `pageThemeReleases`）。
 *
 * 边界（用户 M1 裁决）：
 *   · **只一行**：`scope='hq'`（v1 不做门店覆盖），`UNIQUE(scope)` 从结构上保证；
 *   · 只经 `svc:uiTheme*` 受控动作读写；**原型 CRUD 对所有业务角色（含 hq_admin）全关**——
 *     否则"绕过发布审核直接改表"就成了合法路径；
 *   · `revision` 是乐观锁：保存时必须带 `expected_revision`，不一致 ⇒ 409。
 */
import { belongsTo, defineAppCollection, int, json, str } from './_helpers';

export default defineAppCollection({
  name: 'pageThemeDrafts',
  title: '客户页面装修草稿',
  fields: [
    str('scope', '作用域', {
      length: 16,
      allowNull: false,
      defaultValue: 'hq',
      comment: 'v1 只有 hq（总部统一）；预留 store:<code> 但不实现',
    }),
    int('revision', '草稿修订号', {
      allowNull: false,
      defaultValue: 1,
      comment: '每次保存 +1；并发保存用 expected_revision 比较它',
    }),
    int('base_version', '基于的发布版本', {
      allowNull: false,
      defaultValue: 0,
      comment: '0 = 从未发布；发布/回滚后指向新的 release.version',
    }),
    json('doc', '配置文档', {
      allowNull: false,
      comment: '经 services/page-theme.ts 校验后的完整文档（含 schema_version）',
    }),
    belongsTo('updated_by_user', '最后修改人', 'users', 'updated_by_user_id', { allowNull: true }),
    str('request_id', '请求号', {
      length: 64,
      allowNull: true,
      comment: 'X-Request-Id：同号重放回放，同号不同内容 ⇒ 409',
    }),
  ],
  indexes: [
    // 只有一个作用域一行 —— 这条唯一约束是"不会悄悄出现第二份草稿"的结构性保证。
    { fields: ['scope'], unique: true },
    // 幂等兜底：同一请求号最多落一次。
    { fields: ['request_id'], unique: true },
    { fields: ['updated_at'] },
  ],
});
