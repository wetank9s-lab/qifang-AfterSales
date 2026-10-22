# UX-01D M1 实施与真实浏览器验收报告

> 日期：2026-10-17 · 状态：**UX-01D M1 已实施，待用户验收** · UX-01C 三大模块 PASS/FROZEN · UX-MEDIA-01 PASS/FROZEN · P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · **Release HOLD**
>
> **未 commit / 未 push。** 未进入 M2（C1/C2/C4、D2/D3、门店覆盖、Logo 均未做）。
>
> 本轮范围**严格按裁决**：平台名称 · 平台副标题 · 三种主题预设 · 媒体帮助文案 · 媒体帮助条显隐，
> 外加配套的保存草稿 / 并发保护 / 预览 / 发布差异确认 / 原子发布 / 发布历史 / 回滚 / 安全默认值。

---

## 一、变更文件与新增数据模型

### 1.1 新增（12 个代码/脚本文件）

| 文件 | 作用 |
|---|---|
| `server/collections/pageThemeDrafts.ts` | 草稿表（每 scope 一行，`revision` 乐观锁） |
| `server/collections/pageThemeReleases.ts` | 发布版本表（不可变、只追加） |
| `server/services/page-theme.ts` | 默认值 / 白名单校验 / 差异 / 发布与回滚事务 / 预览凭证（**唯一事实来源**） |
| `server/actions/svc/ui-theme.ts` | 6 个受控动作（draft / save / preview / publish / rollback / releases），仅 `hq_admin` |
| `server/actions/public/ui-theme.ts` | `publicUiTheme:get`（只读已发布）与 `publicUiTheme:preview`（凭证读草稿） |
| `client/page-theme-model.tsx` | 后台「客户页面装修」区块：表单 + 真实 iframe 预览 + 发布差异 + 历史回滚 |
| `h5/src/ui-defaults.ts` | H5 内置默认值（与服务端默认值**逐字段一致**，门禁比对） |
| `h5/src/ui-state.ts` | 配置状态 + `applyUiDoc`（只改变量/文案，**不重建表单**） |
| `h5/src/api/ui.ts` | 两个接口的客户端（4s/6s 超时，失败静默回退） |
| `scripts/verify-ux-01d-config.mjs` | 默认值 / 白名单 / 草稿隔离 / 权限 / 原生 CRUD / 缓存 |
| `scripts/verify-ux-01d-publish.mjs` | 并发 / 幂等 / 原子失败 / 回滚 |
| `scripts/verify-ux-01d-h5.mjs` | 三视口 / 主题 / 长名称 / 输入保留 / 预览零副作用 / 凭证 / 回退 |

### 1.2 修改（15 个）

服务端：`collections/index.ts`（注册 2 表，20→24 张）· `constants.ts`（6 个 svc action、2 个匿名动作、`GUARD_SCENE.PUBLIC_UI`）· `plugin.ts`（注册资源/动作/匿名形态）。

后台：`client/index.ts`（注册 `PageThemeModel`）· `scripts/seed-admin-pages.mjs`（建页 + 换区块 `use`）。

H5：`pages/Report/index.vue`（品牌/副标题/帮助文案/开关 + 预览态）· `components/MediaUploader.vue`（`helpText`/`showHelp`/`disabled` 三个 props，**上传逻辑未改**）· `pages/Report/Success.vue` · `pages/Customer/Progress.vue`（主题跟随）· `styles/base.css`（3 组主题变量 + 深色变体 + 次要文字对比度）。

门禁与清单：`verify-store-entry.mjs`（平台名断言改为"等于生效配置"）· `verify-plugin-load.mjs`（匿名白名单 18→20）· `expected-indexes.mjs` · `expected-sensitive-columns.mjs`（页面契约 + `hq_admin` 菜单）。

### 1.3 数据模型

```sql
page_theme_drafts   (id, scope UNIQUE, revision, base_version, doc jsonb,
                     updated_by_user_id, request_id UNIQUE, created_at, updated_at)
page_theme_releases (id, scope, version, doc jsonb, published_by_user_id, published_at,
                     note, rolled_back_from, request_id UNIQUE, UNIQUE(scope, version))
```

`doc` 结构：`{ schema_version:1, brand:{name,subtitle}, theme:{preset}, copy:{media_help}, modules:{media_help} }`

**为什么是两张独立表**（而不是 `serviceSettings` 的十几个键）：发布必须整份快照原子切换；需要草稿/已发布/版本/回滚四个维度；一次发布要成为**一条**可追溯记录。详见 `docs/DATA-MODEL.md` §17。

---

## 二、门禁结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `verify-ux-01d-config.mjs`（新） | **26 / 26** | 默认值等价、白名单、草稿隔离、四角色权限、原生 CRUD、ETag/304 |
| `verify-ux-01d-publish.mjs`（新） | **29 / 29** | 并发保存/发布、幂等回放、同号不同内容、原子失败、回滚 |
| `verify-ux-01d-h5.mjs`（新） | **61 / 61** | 三视口 × 四页面、主题、长名称、输入保留、预览零副作用、凭证语义、回退 |
| `verify-plugin-load.mjs` | **82 / 82** | 24 张表、匿名白名单 20 条、索引声明一致 |
| `verify-store-entry.mjs`（冻结） | **93 / 0** | 平台名断言已按裁决改写，仍正向断言 |
| `verify-ux-01c-settings-auth.mjs`（冻结） | **29 / 0** | 服务时效未回归 |
| `verify-ux-01c-store-profile.mjs`（冻结） | **71 / 0** | 门店资料未回归（见 §九 B-24 的环境处置） |
| `verify-ux-media-01.mjs`（冻结） | **58 / 0** | 客户媒体后台可见未回归 |
| `verify-ux-01c-pages.mjs` | **26 / 0** | 后台页面契约 |
| `verify-success-buttons.mjs` | **15 / 15** | 成功页按钮未回归 |

> `verify-customer-media-ui.mjs` 有 **3 条红**（三个视口各 1 条），但**与本轮无关**：
> 它要求媒体区唯一的 `<p>` 是「照片、录音和视频仅用于本次售后处理。」，而该句现在在**首次授权弹层**里、
> 媒体区内一直是帮助条文案。这是更早轮次的门禁漂移，本轮未改该文案默认值。已登记 **B-25**。

---

## 三、真实浏览器截图

目录：`.tmp-verify/ux01d-m1/`（全部来自真实 Chrome，非设计稿）

### 3.1 后台（1600×950）

| 文件 | 内容 |
|---|---|
| `admin-01-initial.png` | 装修页初始态：状态条（草稿 vN / 线上 vN）、五项表单、右侧 iframe 预览 |
| `admin-02-edited-dirty.png` | 改了名称/副标题/主题后：`有未保存修改` 标签出现、发布按钮禁用 |
| `admin-03-saved.png` | 保存草稿后：修订号 +1、差异计数出现 |
| `admin-04-preview.png` | **真实 H5 预览**：右侧 iframe 显示草稿内容（红主题、副标题、禁用提交） |
| `admin-05-publish-diff.png` | 发布确认弹窗：逐项列出「旧 → 新」（名称 / 副标题） |
| `admin-06-published.png` | 发布后：线上版本 +1，历史多一行 |
| `admin-07-rollback-confirm.png` | 回滚确认：「以 v48 快照再发布一个新版本，历史不会被改写」 |
| `admin-08-rolled-back.png` | 回滚后：历史出现「回滚自 v48」的新行 |

### 3.2 客户 H5

| 文件 | 内容 |
|---|---|
| `report-default-390.png` | 默认配置（与改造前逐字一致） |
| `report-variant-390.png` | 品牌红 + 副标题 + 帮助条隐藏 |
| `report-longname-375.png` | 20 字最长名称在 375px 下换行、不溢出 |
| `report-375/390/420.png` · `complaint-375/390/420.png` | 报修/投诉三视口 |
| `success-375/390/420.png` · `progress-375/390/420.png` | 成功页/进度页三视口（主题跟随） |
| `preview-frame.png` | 预览 iframe：预览横幅、合成门店、禁用按钮 |
| `report-fallback-390.png` | 配置接口被阻断时回退默认值，页面照常可用 |

---

## 四、权限与原生 CRUD 绕过

| 检查 | 结果 |
|---|---|
| 匿名读草稿 `svc:uiThemeDraft` | **401** |
| `hq_after_sales` / `store_A` / `viewer`：读/存/预览/发布/历史 | **全部 403**（5×3 = 15 条逐一断言） |
| `pageThemeDrafts:list/create` 对四角色（含 `hq_admin`） | **403/404** |
| `pageThemeReleases:list/update` 对四角色 | **403/404** |
| 匿名读已发布配置 | 200（设计如此，最小投影：无内部 id、无操作人） |
| 菜单可见性 | 仅 `hq_admin` 出现「客户页面装修」；其它角色不可见且直访 404 |

> 两张新表**没有**任何原生只读授权 —— 读也只走 `svc:uiTheme*`，避免"绕过发布审核直接看/改表"。

---

## 五、草稿与已发布隔离

- 保存草稿（名称/主题都改）前后，公开接口的 `version` 与 `doc` **逐字段不变**（`verify-ux-01d-config` C 段）；
- 公开接口只读 `page_theme_releases` 的**最大 version** 整份快照；草稿只经预览凭证可见；
- 预览凭证绑定 `revision`：草稿被改过后，旧凭证返回 **409 `PREVIEW_STALE`**，且**不返回任何草稿内容**。

---

## 六、并发 / 幂等 / 原子性 / 回滚

| 场景 | 实测 |
|---|---|
| 两会话同时保存（同一 `expected_revision`） | **200 + 409** |
| 两会话同时发布（同一 `expected_revision`） | **200 + 409**（修复前是 200/200，见 §八 DEV-210） |
| 同 `request_id` + 同内容保存/发布 | **回放**（`replayed=true`），修订号不推进、版本行不新增 |
| 同 `request_id` + **不同内容** | **409 `IDEMPOTENT_PAYLOAD_MISMATCH`** |
| 发布事务中途失败（DB 触发器 `RAISE EXCEPTION`） | **500**，线上版本不变、公开内容不变、草稿 revision 不变 |
| 回滚 | 新版本号 +1、`rolled_back_from` 指向来源；**旧版本 jsonb 逐字未变**；新版本 doc 与旧快照逐字相等 |

> 并发/原子性验证用的是**真实 PostgreSQL 事务与触发器**，不是桩。
> 条件更新沿用"把旧值压进 WHERE 并检查 affectedCount"的写法（DEV-203 的反面教训）。

---

## 七、预览零副作用与凭证语义

- 预览页**不调用** `store-entry`；门店卡是**合成门店**（"示例门店（预览）"），全程不查 `stores`；
- 提交按钮与四个媒体入口**禁用**；即使脚本强行 `.click()`，`onSubmit` 第一分支直接返回；
- 预览期间 `service_tickets` / `customer_media_sessions` / `sms_logs` 计数**完全不变**（472/695/762 → 472/695/762）；
- 输入保留：在预览里输入文字后刷新凭证，**值与 DOM 节点都保留**（自定义标记仍在）→ 证明"应用配置不重建表单"；
- 报修/投诉切换走 `postMessage`，**不重载页面**；
- 凭证：过期（签名有效）→ **401**；篡改 → **401**；iframe `src` 中**没有凭证**（`/h5/report?uiPreview=1`）；
- 凭证只经同源 `postMessage` + **POST body** 传输 ⇒ 不进 URL / access log / Referer。

---

## 八、失败与恢复场景

| 场景 | 结果 |
|---|---|
| 发布事务中途失败 | 500，线上与草稿都不变；后台提示失败并保留 diff |
| 配置接口不可用（CDP 阻断 `publicUiTheme:get`） | H5 回退**内置默认值**，表单可用、不白屏 |
| 草稿在预览期间被他人修改 | 409，预览页提示"草稿已更新，请在后台重新打开" |
| 保存/发布并发冲突 | 409，后台自动刷新到最新修订号 |
| 回滚到不存在的版本 | 404（服务端校验，不静默） |

---

## 九、本轮新登记的问题（不随 M1 通过而关闭）

| 编号 | 内容 | 处置 |
|---|---|---|
| **DEV-210** | 同一版草稿曾被连续发布两次（200/200） | **已修**：发布/回滚改为条件推进 `revision`（WHERE 带旧值），并补断言 |
| **B-24** | `verify-ux-01c-store-profile` 用固定手机号建夹具，同日重跑 >5 次必 429 | 未改门禁；本轮清理了 `api_guards` 的手机号日限计数（3395 行历史测试计数）后复跑 71/0 |
| **B-25** | `verify-customer-media-ui` 的"常驻说明"断言已过期（预存在红） | 未修（属 UX-01B 范围） |
| **B-26** | 4 枚媒体图标是蓝色系，品牌红/石墨灰下不协调 | 未改（用户明确不得重画）；v2 建议出 `currentColor` 版 |

### 环境说明（如实）

- UAT 库的 `page_theme_releases` 现在有 **51 个版本**（v1–v51）：这是反复执行门禁/变异测试产生的**测试发布**。
  **没有删除**（设计要求历史不可改写）。生产环境首次发布从 v1 开始，不受影响。
- 进度页夹具 `FW20261017-0074` / `0075` 均按 ID 清理（tickets/events/sms 全 0）；未发送真实短信。
- 为继续验证，本轮清过一次 `api_guards` 的手机号维度计数（见 B-24）；未改任何产品配置。

---

## 十、反向验证（证明门禁真的会红）

| 变异 | 期望红的断言 | 实测 |
|---|---|---|
| 公开接口改成读**草稿** | 草稿隔离 | **红**：`公开接口的 version 与内容均未变化`（25/26） |
| 回滚后**改写旧版本**快照 | 回滚不改历史 | **红**：`旧版本 v1 的快照未被改写`（28/29） |
| H5 预览去掉"提交禁用 + onSubmit 拦截" | 预览侧闸门 | **红**：`提交按钮禁用`（60/61） |
| 去掉发布时的 `revision` 推进 | 并发发布 200+409 | **红**：`一个 200 + 一个 409`（修复前实测 200/200） |

> 第三条的补充说明（诚实）：把 UI 闸门拿掉后，"工单计数不变"这条仍然通过 ——
> 因为预览页没有合法 `entry`，服务端本来就会拒绝建单。⇒ **计数断言是兜底，不是主检**；
> 真正守住"预览不可提交"的是 `disabled` 与 `onSubmit` 早退这两条断言。

---

## 十一、H5 未回归证明

| 项 | 证据 |
|---|---|
| 报修/投诉字段与校验 | 表单结构、`data-testid`、必填与长度校验**未改动**；`verify-ticket-type` / `verify-store-entry` 全绿 |
| 媒体上传能力 | `verify-ux-media-01` **58/0**（含三类媒体、Range、四角色）；`MediaUploader` 只加了 3 个 props |
| 输入不丢 | 主题变化时输入值 + DOM 节点均保留（H5 门禁 E 段） |
| 成功页 | `verify-success-buttons` **15/15** |
| 冻结的后台配置 | settings 29/0、store-profile 71/0、pages 26/0 |
| 默认外观 | 默认配置下品牌名/文案/主色与改造前一致；唯一主动变化是**次要文字对比度**（3.22→5.80，用户批准） |

---

## 十二、Git 与密钥审计

- **未 commit / 未 push**；暂存区为空；`git diff --check` 无空白错误。
- 本轮新增 12 个文件、修改 15 个（另有设计/审计/状态文档更新）。
- 密钥审计：新增文件无任何硬编码口令/密钥；两个门禁脚本从 `.env` 读 `SIGN_SECRET` / 验收账号口令
  （仅用于**构造过期凭证**与登录，不打印、不落盘）。
- 未新增环境变量；预览凭证复用 `SIGN_SECRET` 并加域前缀 `ui-preview:`（与门店入口签名隔离）。

---

## 十三、结论与仍 PENDING

**M1 的功能与安全边界已用真实库、真实事务、真实浏览器验证**：草稿隔离、发布原子、并发互斥、
幂等、回滚不改历史、预览零副作用、权限与原生 CRUD 全关。**是否 PASS 由你裁决。**

仍 PENDING（不在 M1 范围）：

1. M2：C1 报修引导 / C2 投诉引导 / C4 成功说明 / D2 补充信息默认展开 / D3 复制工单号显隐；
2. 门店级覆盖（D1 已定 v1 不做；如要做需先解决进度页 scope，跨阶段）；
3. Logo 上传（D2 已定 v2，需独立公开资源通道）；
4. 真机（iPhone/Android）上的实际观感与软键盘行为 —— 本轮只用 Chrome 设备模拟，**不宣称真机通过**；
5. B-26 图标配色（v2 出主题化图标后一并复验）；
6. Release 门禁（真实短信通道联调、公网入口）**仍 HOLD**，与本轮无关。
