# UX-01D 第一轮 · 现状审计（AUDIT）

> 日期：2026-10-17 · 状态：**UX-01D 设计与审计（本轮不实施）** · UX-01C 三大模块 PASS/FROZEN · P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD
>
> **本轮只读**：未改任何产品代码、未建表、未跑迁移、未改页面种子、未改任何配置值、未 commit / 未 push。
> 唯一一次「写」是**为截进度页而自建的 1 张夹具工单**（详见 §1.3），已按 ID 清理干净。
>
> 本文回答两个问题：**现在客户 H5 到底长什么样、数据从哪来**；**要让它"可装修"，缺的是什么**。
> 产品方案与实施顺序见 [`UX-01D-DESIGN.md`](UX-01D-DESIGN.md)。

---

## 0. 一屏结论

**客户 H5 目前是"整页写死"的**：平台名、主题色、四个媒体卡片、全部提示文案、成功页与进度页的措辞，
**没有任何一项来自后台配置**；后台能改的只有**门店资料（名称/电话/地址/启停）**与**服务端限额**，
而这两类都**不改变页面外观**。

| # | 问题（用户 §十 的 8 问） | 答案 | 详见 |
|---|---|---|---|
| 1 | 现在到底有哪些页面可以配置？ | **0 个"外观页面"**。后台 6 个菜单里与"配置"沾边的只有 3 个：服务时效、短信通知、门店报修入口（含门店资料）；其余是工单列表/事件/派工记录，以及门店侧工作台（`hq_admin` 直访被路由拒绝，实测 404） | §2、§3.6 |
| 2 | 哪些是已有数据，哪些要新增？ | 已有：门店名称/电话/地址/启停、媒体限额、状态文案。**要新增：品牌名、副标题、主题预设、5 段提示文案、3 个模块开关** | §4、§7 |
| 3 | 管理员真正能装修哪些部分？ | 建议仅"品牌 + 主题 + 提示文案 + 非关键模块显隐"这四类；字段、校验、隐私、二维码、媒体能力**一律不可装修** | DESIGN §3 |
| 4 | 哪些必须冻结？ | 采集字段与校验、服务端规则、媒体上传能力、"文字或媒体"提交规则、隐私告知、状态机、二维码归属、进度 Token、固定提交按钮 | DESIGN §2/§4 |
| 5 | 怎样预览、发布和回滚？ | 草稿行 + 不可变发布版本行；预览用 10 分钟一次性 Token（合成门店、不可提交）；发布=插入新版本；回滚=以旧版快照再发一版 | DESIGN §6 |
| 6 | 总部/门店数据怎么隔离？ | v1 **只做总部统一**；门店级覆盖列为待决策项（且永不涉及二维码归属） | DESIGN §3.5 |
| 7 | 需要投入哪些开发？ | 2 张新表 + 1 个服务 + 6 个受控动作 + 1 个后台区块 + H5 5 个文件 + 3 个新门禁；**不新增页面构建器** | §8、DESIGN §9 |
| 8 | 第一版最小可交付？ | **M1：品牌名/副标题 + 3 个主题预设 + 2 段文案 + 草稿/预览/发布/回滚**（不含门店覆盖、不含 Logo 上传） | DESIGN §9 |

---

## 1. 审计边界与方法

### 1.1 读的是什么

- **源码**：`h5/src/**`（4 个页面 + 1 个组件 + 样式/工具）、`h5/index.html`、后端 `actions/public/*`、
  `services/progress-service.ts`、`actions/svc/config-settings.ts`、`client/*.tsx`、`scripts/seed-admin-pages.mjs`。
- **运行态**：`h5/dist` 由 nginx 只读挂载（`docker-compose.yml` 的 `./h5/dist:/usr/share/nginx/html/h5:ro`），
  构建产物 mtime（2026-10-17 09:56）**晚于**所有 `h5/src` 文件 ⇒ 截图反映的就是当前源码（mtime 级证据，非逐字节比对）。
- **数据库**：只读查询 `stores` / `service_settings` / `sms_logs` / 表结构。

### 1.2 真实浏览器截图

CDP + Chrome headless，`Emulation.setDeviceMetricsOverride` 精确设成 375/390/420（DPR 2、`mobile: true`），
全页截图；后台用 1440×900。清单与读数见 **§10**。

### 1.3 关于那次「写」

进度页需要**真实 Token** 才能看到正常态，而库里只存哈希（设计如此）。因此：
用公开接口自建 **1 张** 夹具工单（`customer_name=UX01D审计`、`customer_mobile=13000000999`、
正文带 `[UX01D-AUDIT]` 标记）→ 截图 → **按 ID 删除**。
实测清理：`FW20261017-0072 (id=6730)`，清理前 `tickets=1 / events=1 / sms=1` → 清理后 **全部 0**。
另有一次字段核对用的 `FW20261017-0073 (id=6731)`，同样已清理（`left 0`）。
副作用仅有：**工单号序列被推进 2 个**（编号不回收，这是设计使然）；`mock` 通道产生并已删除 1 条进度短信记录，
**未发送任何真实短信**。

### 1.4 没有做的事（如实声明）

- **没有**跑已冻结模块的全量门禁（用户明确不要求；本轮无代码变更，跑了也不产生新信息）。
- **没有**验证真实手机（无真机；UX-01B 的 PENDING 项不因本轮关闭）。
- **没有**评估 Logo 图片上传的存储方案细节（v1 不做，见 DESIGN §3.4）。

---

## 2. 页面清单（真实路由 / 源码 / 产物）

| 页面 | 真实路由（浏览器） | 源码 | 渲染条件 |
|---|---|---|---|
| 客户报修 / 投诉 | `/h5/report?k=<入口>`（旧码 `?store=S01`） | `h5/src/pages/Report/index.vue`（804 行） | `App.vue` 按 `route.path === '/report'` |
| 提交成功 | `/h5/report/success?no=…&store=…&at=…&type=repair\|complaint&pt=…&k=…` | `h5/src/pages/Report/Success.vue`（266 行） | 同页组件按 `type` 切换文案，**不另建投诉成功页** |
| 客户进度 | `/h5/customer/progress/<token>`（外部 `/p/<token>` 302 至此） | `h5/src/pages/Customer/Progress.vue`（262 行） | 命名路由 `customer-progress` |
| 媒体组件 | —— | `h5/src/components/MediaUploader.vue`（830 行） | 报修与投诉各持一个实例、各自独立上传会话 |
| 全局样式 | —— | `h5/src/styles/base.css`（715 行） | 单文件，`:root` 变量集中 |
| HTML 外壳 | —— | `h5/index.html`（21 行） | `<title>` / `theme-color` / viewport |

> ⚠️ **没有独立的"投诉页"文件**：投诉是 `/report` 的第二个 `mode`（`mode: 'repair' | 'complaint'`）。
> 这件事对 UX-01D 很关键 —— **装修一份配置就同时作用于报修与投诉**，不存在"只装修投诉页"的可能，
> 除非将来给投诉加独立的差异化字段（本设计不建议，见 DESIGN §3.3）。

---

## 3. 逐页源码事实

### 3.1 报修 / 投诉页（`Report/index.vue`）

| 位置 | 事实 | 可配置性 |
|---|---|---|
| L5-7 | `<header class="svc-header"><h1>四川七方连锁售后服务平台</h1></header>` —— **平台名写死在模板里** | ❌ 硬编码 |
| L44-57 | 门店卡：`store.name` / `store.phone`（`tel:` 链接，空则不渲染）/ `store.address`（空则不渲染）—— **全部来自后端** | ✅ 已可配置（门店资料） |
| L60-81 | 报修/投诉切换条（两个 `button`，`role=tab`） | ⚠️ 文案写死；**结构不可装修**（业务分叉点） |
| L84-212 | 报修表单：姓名\* / 手机号\* / 故障描述（含媒体）/ 「补充信息（选填）」折叠 / 吸底提交 | ❌ 字段与校验全部写死 |
| L147-200 | `<details>` 里三个选填：家电类别（下拉，选项来自 `utils/appliance.ts`）/ 品牌型号 / 服务地址 | ❌ 写死（与后端常量双份，由 `verify-phase3-h5` 比对） |
| L202-211 | 提交按钮 `.svc-submit-fixed`，文案 `提交报修` / `正在提交` | ❌ 写死（**受保护**，见 DESIGN §2） |
| L215-285 | 投诉表单：姓名\* / 手机号\* / 投诉内容（含媒体）/ 提交 | ❌ 写死 |
| L296-302 | 隐私页脚：「提交即表示您已阅读并同意《个人信息处理说明》…」 | ❌ 写死（**法律含义，受保护**） |
| L305-315 | 隐私说明弹层：`PRIVACY_NOTICE_SECTIONS` + `PRIVACY_NOTICE_VERSION='2026-09-20'` | ❌ 写死（版本号须与后端常量逐字一致） |
| L414 | 默认 `mode = 'repair'` | —— |
| L589-601 | 成功页参数：`no / pt / store / at / type / k` | —— |
| L687-721 | 提交载荷按当前模式构造（投诉**结构上不含**报修字段） | ❌ 不可装修 |

**关键结论**：这一页可"装修"的只有 **最上面那行平台名**，以及"**门 店卡上方要不要加一句引导说明**"这类
**新增空位**。其余全是业务契约。

### 3.2 媒体组件（`MediaUploader.vue`）

| 位置 | 事实 | 可配置性 |
|---|---|---|
| L38-99 | 2×2 四张卡片：拍照 / 相册 / 录音 / 拍视频；**图标是用户提供的 4 枚双色 SVG**（`h5/src/assets/media-icons/*.svg`） | ⚠️ 图标不换（UX-01B 第四轮已定稿，复用即可） |
| L48-50 | 副标题「现场拍摄」 | ❌ 写死 |
| L56-57 | 副标题「选择已有照片」 | ❌ 写死 |
| L78-82 | 「录音」/「最长 60 秒」——**60 秒是字面量，不是从限额来的** | ⚠️ 与限额可能漂移（见 §6 G8） |
| L95-96 | 「拍视频」/「最长 30 秒」——同上 | ⚠️ 同上 |
| L102 | 整行帮助条「也可直接填写文字，任选一种即可说明问题。」 | ❌ 写死（**建议列入可配置**，DESIGN §3.3） |
| L159-169 | 首次授权弹层：「照片、录音和视频仅用于本次售后处理…」 | ❌ 写死（**隐私用途告知，受保护**） |
| L218-224 | `DEFAULT_LIMITS`（8MB / 5 个 / 3 张 / 60s / 30s）作为**兜底**，真实值由建会话响应 `limits` 覆盖 | ✅ 服务端驱动（`visit.photo_max_count` 等） |
| L255-258 | 「照片已满 3 张」——**硬编码 3**，不是 `limits.image_max_count` | ⚠️ 同上 G8 |

### 3.3 成功页（`Report/Success.vue`）

| 位置 | 事实 | 可配置性 |
|---|---|---|
| L3 | 绿色 ✓ 圆标（纯 CSS，无图片） | ⚠️ 可随主题微调，不建议配置 |
| L4 | 标题「报修提交成功」/「投诉提交成功」（按 `type`） | ⚠️ 业务文案，建议**受保护** |
| L6-9 / L18-21 | 工单号 + 「当前进度 已提交」（**不请求接口**，只读 URL） | ❌ 受保护 |
| L23-30 | 服务门店 / 提交时间 | ❌ 数据来自 URL |
| L44-52 | 主按钮「查看处理进度」（无 `pt` 则不渲染） | ❌ 受保护 |
| L66-86 | 次要双按钮「复制工单号」「再报一单」 | ⚠️ 可允许显隐（DESIGN §3.4 D4） |
| —— | **页面无任何"辅助说明"位置** | 🕳 缺口：成功页没有可配置文案的落点（需新增一行） |

### 3.4 进度页（`Customer/Progress.vue`）

| 位置 | 事实 | 可配置性 |
|---|---|---|
| L9-11 | 头部「服务进度」 | ❌ 写死 |
| L24-28 | 工单号 + 状态徽标（`.svc-progress-status`，底色 `#fff2e8`、文字 `--svc-primary`） | ❌ 写死；**样式有缺陷**见 §11 |
| L30-43 | 门店名 / 提交时间 / 家电 / 地址 | 数据来自服务端 |
| L46-66 | 我提交的说明 + 材料按钮 | ❌ 受保护 |
| L69-81 | 处理时间线（只含状态与时间） | ❌ 受保护 |
| L83-85 | 「本单尚未关闭，关闭后 30 天内仍可查询。」（`expiryText`） | ❌ 写死 |
| L116-119 | `expiryText` 三分支文案 | ❌ 写死（涉及对客承诺，受保护） |

### 3.5 全局样式与 HTML 外壳

- `base.css` **`:root` 只有 12 个变量**（L14-26）：`--svc-bg/card/text/text-weak/border/primary/primary-weak/danger/warn/ok/radius`。
  ⇒ **主题化的技术条件已经具备**：改这一组变量即可整体换色，不需要动任何组件。
- 头部高度：`.svc-header h1` 两处定义（L56-65 的 21px 被 L154-160 的 18px 覆盖）——
  **同一属性两处定义**，做主题时要注意以**后者**为准（这也是"顶部不过高"的现状来源）。
- 吸底 CTA：`.svc-submit-fixed`（L256-263）+ `.svc-page.has-fixed-cta` 的 100px 底部占位（L360-362）。
- 深色模式：`@media (prefers-color-scheme: dark)` 只覆盖了 **6 个变量 + 少量组件**（L675-715），
  **`--svc-primary` 没有深色值** ⇒ 深色下主按钮仍是亮蓝。做主题预设时必须一并定义深色变体。
- `index.html`：`<title>` 静态（L15）、`theme-color #f5f6f8` 静态（L14）、`robots noindex`（L11-12）。

### 3.6 后台现有设置页与客户端动作机制

| 事实 | 证据 |
|---|---|
| 后台侧边栏现只有 6 项：全量工单 / 工单事件时间线 / 派工记录 / 门店报修入口 / 服务时效 / 短信通知 | 截图 `admin-tickets.png`、`admin-sms.png` |
| 页面**不是手搭**的，而是 `scripts/seed-admin-pages.mjs` 的 `PAGE_BUILDERS`（L809-818）用**蓝图**建，再 `flowModels:save` 落库 | 同上文件 |
| 蓝图只支持 `table / filterForm / markdown` **没有自定义 React 区块** ⇒ 现有做法是：**先用 markdown 占位建页，落库后把该区块节点的 `use` 换成客户端注册的模型**（`seedSmsCenterBlock()` / `seedWorkbenchBlock()`） | `buildSmsNoticePage()` L788-798、`buildStoreWorkbenchPage()` L735-745 |
| 客户端模型全部**派生宿主模型**（`MarkdownBlockModel` / `ActionModel` / `DisplayTextFieldModel`），**不自建页面系统** | `client/index.ts` L43-64 |
| 受控写入的成熟范式：规格表 `SETTING_EDIT_SPECS`（`type: int\|bool\|enum` + `min/max/options` + `consumer` + `supported`）、`expected_value` 并发控制、`configChangeAudits` + `(request_id,key)` 唯一索引做幂等、审计与更新**同事务** | `actions/svc/config-settings.ts` L31-46、L232-243、L278-348 |
| 门店资料编辑同理：逐字段原子条件更新 + `storeProfileAudits(request_id,store_id,field)` 唯一索引 | `actions/svc/store-profile.ts` |
| 原生 CRUD 对业务角色**全关**；页面只用 `svc:*` 动作 | UX-01C R5/R7/R8 门禁 |

> ⇒ **UX-01D 不需要发明新机制**：页面种子、自定义模型、受控动作、审计、幂等、并发冲突，全部有现成范式可抄。
> 需要**新增**的只有：**"草稿 / 发布版本"这一维度**（现有 `serviceSettings` 是单值，没有版本概念）。

---

## 4. 数据来源三分表

### 4.1 现在写死在前端（改一次要发一次 H5）

| 内容 | 位置 |
|---|---|
| 平台名「四川七方连锁售后服务平台」 | `Report/index.vue` L6；`index.html` L15（`<title>`） |
| 主题色/圆角/背景等 12 个设计变量 | `base.css` L14-26（+ 深色 L675-690） |
| 报修/投诉切换文案、全部字段标签与 placeholder | `Report/index.vue` L69-79、L86-199、L217-260 |
| 媒体四卡片文案与帮助条 | `MediaUploader.vue` L48-57、L78-82、L95-96、L102 |
| 授权弹层用途告知 | `MediaUploader.vue` L161-163 |
| 隐私页脚句 + 说明全文 + 版本号 | `Report/index.vue` L296-302、`utils/privacy.ts` |
| 成功页标题/进度口径/按钮文案 | `Success.vue` L4、L18-21、L51、L84 |
| 进度页标题/有效期承诺/状态徽标样式 | `Progress.vue` L10、L116-119、L180-188 |
| 媒体时长/张数提示（60s/30s/3 张） | `MediaUploader.vue` L82、L96、L257 |
| 家电类别选项 | `utils/appliance.ts`（与后端双份，门禁比对） |

### 4.2 现在**已经从后端读取**

| 内容 | 接口 | 备注 |
|---|---|---|
| 门店 name / phone / address | `GET /api/public/store-entry?k=` | 只回 4 个字段（`store.ts` L110-140）；`phone/address` 空 ⇒ `null` ⇒ 页面不渲染该行 |
| 门店有效性（签名 / 启停） | 同上 | 坏签名 404；停用与不存在**同形** |
| 媒体限额 | `POST /api/public/media/sessions` 响应的 `limits` | 覆盖 `DEFAULT_LIMITS` |
| 工单状态文案 | `GET /api/public/progress/<token>` 的 `status_label` | 服务端 `TICKET_STATUS_LABEL` |
| 进度内容/时间线/材料 | 同上 | ⚠️ 时间字段有缺陷，见 §11 DEV-209 |
| 退款/评价等 | 其他匿名接口 | 与本设计无关 |

### 4.3 现在**本来就可以配置**（但不是"装修"）

| 配置 | 入口 | 影响 |
|---|---|---|
| 门店名称 / 电话 / 地址 / 启停 | 后台「门店报修入口」→ 行内「门店资料」（UX-01C R7） | **立即**反映到客户 H5 门店卡（无缓存层，因为 store-entry 不缓存） |
| `sort_order` | 库/集合管理 | H5 门店下拉顺序（本次页面已不用下拉） |
| 媒体张数/大小/时长、限流、SMS、SLA、评价 | `serviceSettings`（受管键，仅部分有编辑入口） | 服务端行为；**不改变外观** |

> 🔴 **必须说清的现状**：15 家门店里 **14 家没有电话、12 家没有地址**（库内实测）。
> 所以今天的门店卡**大多数只有一行店名**。这不是装修能解决的问题，是**资料完整度**问题
> —— UX-01D 不应把"页面不好看"归因于"不能配置主题"。

---

## 5. 已有可复用能力（不要重新发明）

| # | 能力 | 证据 | 在 UX-01D 里怎么用 |
|---|---|---|---|
| 1 | 受控写入 + 规格白名单 + 类型/范围校验 | `SETTING_EDIT_SPECS`（int/bool/enum） | 主题 schema 的**字段白名单与枚举校验**照此实现 |
| 2 | 并发控制（`expected_value` ⇒ 409） | `config-settings.ts` L278-303 | 草稿保存用 `expected_revision` ⇒ 409，防"两人同改互相覆盖" |
| 3 | 幂等（`request_id` + 唯一索引 + 回放） | `configChangeAudits(request_id,key)` | 发布/回滚同样用 `request_id`，双击不会发两版 |
| 4 | 审计（old/new/operator/scene/request_id，同事务） | 同上 L340-348 | 发布记录 = 不可变版本行（比审计更强，见 DESIGN §7） |
| 5 | 自定义后台区块（markdown 占位 → 换 `use`） | `SmsCenterModel` + `seedSmsCenterBlock()` | 「客户页面装修」页用同一手法 |
| 6 | 页面种子的幂等重建 | `seed-admin-pages.mjs` `PAGE_BUILDERS` / `mode: 'create'` | 新增一页只需加一个 builder + 菜单项 |
| 7 | 匿名接口"最小投影"纪律 | `store.ts` 只回 4 字段；`trace` + 限流桶 | 新 `ui-config` 只回**白名单字段**，不带内部 id / 不带门店 code |
| 8 | 主题变量的单一收口 | `base.css` `:root` 12 变量 | 换主题 = 在 `<html>` 上加 `data-theme` 覆盖变量，**组件零改动** |
| 9 | 缓存策略已就绪 | nginx `/h5/` = `no-store, must-revalidate`；`/h5/assets/` = 30d immutable（带 hash） | 主题是**运行期数据**，发布后下次打开即生效，**无需重新构建 H5** |

---

## 6. 缺口清单（G1–G12）

| # | 缺口 | 影响 | 严重度 |
|---|---|---|---|
| G1 | 没有"UI 配置"的存储位置（`serviceSettings` 只能存单值字符串） | 品牌/主题/文案无处安放 | 阻塞 |
| G2 | 没有**草稿 vs 已发布**的概念 | 管理员一改就影响全部客户 | 阻塞 |
| G3 | 没有版本/回滚 | 改坏了无法一键还原 | 阻塞 |
| G4 | 平台名在两处（模板 + `<title>`），改一处会出现"页签与页头不一致" | 装修必须**同时**处理两处 | 高 |
| G5 | 没有预览入口（后台无法看到 H5 效果） | 管理员"盲改" | 高 |
| G6 | 成功页**没有可放辅助文案的位置**（纯结构化） | 文案类配置少一个落点 | 中 |
| G7 | 没有 ETag/version 协商 | 只能靠 `no-store` 暴力不缓存（可接受，但多花流量） | 中 |
| G8 | 媒体提示硬编码 60s/30s/3 张，不读 `limits` | 改限额后**提示与实际不符** | 中 |
| G9 | 隐私/法律文案与普通提示文案**混在同一批字符串里** | 配置化时有误改法律文本的风险 | 高（靠白名单规避） |
| G10 | 后台没有装修入口 | —— | 阻塞（本轮设计） |
| G11 | 无 Logo 上传/托管能力（现有私有媒体流是**鉴权**的，不能直接给匿名页用） | v1 不做图片；v2 需单独的公开资源通道 | 中（可延后） |
| G12 | 进度页 URL **不带门店入口**（只有 token） | 门店级主题在进度页**无法解析** ⇒ v1 不做门店覆盖的直接理由 | 高（决定范围） |

---

## 7. 配置项 ↔ 消费点映射（现状 → 拟新增）

| 拟新增配置 | 消费点（精确到文件/行） | 生效方式 | 现状 |
|---|---|---|---|
| `brand.name` | `Report/index.vue` L6（h1）+ `document.title`（替代 `index.html` L15 的静态值） | 运行时 fetch → 渲染 | ❌ 新增 |
| `brand.subtitle` | `Report/index.vue` L5-7 内新增 `<p>`（`.svc-header p` 样式已存在，L67-71） | 同上 | ❌ 新增 |
| `theme.preset` | `base.css` `:root` 12 变量（L14-26）+ 深色（L675-690） | `<html data-theme="…">` | ❌ 新增 |
| `copy.report_intro` | 门店卡与切换条之间（L57 之后）新增一行 | 同上 | ❌ 新增 |
| `copy.complaint_intro` | 同上（按 `mode` 取） | 同上 | ❌ 新增 |
| `copy.media_help` | `MediaUploader.vue` L102（改为 prop，缺省=现文案） | 同上 | ❌ 新增 |
| `copy.success_note` | `Success.vue` L21 之后新增一行 | 同上 | ❌ 新增 |
| `modules.media_help` | 控制 L102 是否渲染 | 同上 | ❌ 新增 |
| `modules.extra_open` | `Report/index.vue` L147 的 `<details :open>` | 同上 | ❌ 新增 |
| `modules.success_copy_no` | `Success.vue` L67-79 | 同上 | ❌ 新增 |
| 门店名/电话/地址 | `store-entry` → `Report/index.vue` L44-57 | **已在用** | ✅ 已有 |
| 媒体限额 | 建会话响应 `limits` → `MediaUploader.vue` L544 | **已在用** | ✅ 已有（提示文案仍需跟着修，G8） |

---

## 8. 需要改动的代码位置（仅登记，不在本轮实施）

> 下表中标注「（新）」的文件/表/动作**当前尚不存在**，是实施阶段的拟新增项；
> 其余是现有文件，行号以本轮审计时的源码为准。

### 8.1 服务端

| 文件 | 改动 | 说明 |
|---|---|---|
| `server/collections/pageThemeDrafts.ts`（新） | 新表 | 草稿（每 scope 一行，`revision` 乐观锁） |
| `server/collections/pageThemeReleases.ts`（新） | 新表 | 不可变版本（`unique(scope, version)`） |
| `server/collections/index.ts` | 注册两张表 | 与 `DATA-MODEL.md` 同步 |
| `server/services/page-theme-service.ts`（新） | schema 校验/归一/差异/发布/回滚/解析 | **唯一事实来源**（H5 默认值也从这里导出一份 JSON 供门禁比对） |
| `server/actions/svc/ui-theme.ts`（新） | 6 个动作：`uiThemeDraft` / `uiThemeDraftSave` / `uiThemePublish` / `uiThemeRollback` / `uiThemeReleases` / `uiThemePreviewToken` | 全部 `hq_admin` |
| `server/actions/public/ui-config.ts`（新） | `GET /api/public/ui-config?k=` + `GET /api/public/ui-preview/:token` | 最小投影 + 限流桶 + `ETag` |
| `server/constants.ts` | `SVC_ACTION` 追加 6 个、`AUTHENTICATED_SVC_ACTIONS`、主题枚举 | 与前端共用 |
| `server/seeds/roles.ts` | `hq_admin` 资源追加两张新表（**只读**，写走 svc 动作） | 沿用 UX-01C `extras` 机制 |
| `server/plugin.ts` | 注册新集合/动作/公开资源；启动自检 schema 版本 | —— |

### 8.2 后台客户端

| 文件 | 改动 |
|---|---|
| `client/page-theme-model.tsx`（新） | 派生 `MarkdownBlockModel` 的装修区块：分区表单 + 右侧预览 + 状态条 |
| `client/page-theme-preview.tsx`（新） | 375/390/420 三档 iframe 预览容器 |
| `client/index.ts` | 注册两个模型 |
| `scripts/seed-admin-pages.mjs` | `buildPageThemePage()` + `PAGE_BUILDERS['客户页面装修']` + `seedPageThemeBlock()` |
| `scripts/expected-sensitive-columns.mjs` | `REQUIRED_ADMIN_PAGES` 增加该页（否则 pages 门禁不认） |

### 8.3 客户 H5

| 文件 | 改动 | 注意 |
|---|---|---|
| `h5/src/api/ui.ts`（新） | `fetchUiConfig(entry?)` + 默认值与容错 | 失败 ⇒ **静默用默认值**，不得白屏 |
| `h5/src/theme.ts`（新） | `applyTheme(doc)`：写 `data-theme` + CSS 变量 + `document.title` | 只接受白名单枚举 |
| `h5/src/pages/Report/index.vue` | 品牌名/副标题/两段引导/`extra_open` | **不动字段、校验、提交** |
| `h5/src/components/MediaUploader.vue` | `helpText`/`showHelp` props | **不动上传逻辑** |
| `h5/src/pages/Report/Success.vue` | `success_note` 一行 + `copy_no` 显隐 | —— |
| `h5/src/pages/Customer/Progress.vue` | 仅接主题（无门店入口 ⇒ HQ 配置） | **修 DEV-209 属另一轮**，不在装修里做 |
| `h5/src/styles/base.css` | 增加 `[data-theme="…"]` 变量组（含深色） | **不允许**任何运行期 CSS 注入 |
| `h5/index.html` | `<title>` 保留兜底值 | 运行期由 JS 覆盖 |

### 8.4 门禁（新）

| 文件 | 断言什么 |
|---|---|
| `scripts/verify-ux-01d-config.mjs` | 默认值与 H5 内置默认**逐字节相同**；白名单外的键被拒；超长/控制字符/`<` 被拒；枚举非法被拒 |
| `scripts/verify-ux-01d-publish.mjs` | 草稿不影响线上；发布后读到的版本变化；409 并发；幂等回放；回滚产生新版本且内容等于旧版；失败不改线上 |
| `scripts/verify-ux-01d-h5.mjs` | 三视口渲染、无横向滚动、对比度、点击区 ≥44px、预览态**不能提交**、配置接口 500 时页面仍可用 |

### 8.5 会被"文案可配置"影响的现有门禁（必须同步改，不能装作没影响）

| 门禁 | 现有断言 | 改法 |
|---|---|---|
| `scripts/verify-store-entry.mjs` **L2497** | `head.h1.trim() === '四川七方连锁售后服务平台'` | 改为「等于**当前生效配置**的名字，未发布时等于默认值」——**不能删掉这条断言**，否则"品牌名渲染"从此无人守 |

> 其余 H5 门禁走 `data-testid`（`mode-repair` / `submit-repair` / `goto-progress` 等），
> **不依赖文案**，已核实不会因装修而假红。

---

## 9. 权限与发布安全风险

| # | 风险 | 现状 | 设计要求 |
|---|---|---|---|
| R1 | **XSS**：文案被当 HTML 渲染 | H5 全部用 `{{ }}` 插值，无 `v-html`；nginx **未设 CSP**（后台是低代码动态渲染，见 `service.conf` L153-156） | 只存纯文本、渲染只用插值；服务端**拒绝** `<` `>` 与控制字符；**永不** `v-html` |
| R2 | **CSS 注入**：管理员写任意 CSS | 无此能力 | **只允许预设枚举**（`preset/button/card`），不接受任何 CSS 字符串；不提供"自定义颜色"输入 |
| R3 | **发布越权**：门店账号改总部外观 | UX-01C 已把原生写全关 | 6 个 `svc:uiTheme*` 仅 `hq_admin`；其余角色 403；原生 CRUD 对新表 **fail-closed** |
| R4 | **草稿泄漏**：匿名客户读到未发布内容 | 无 | 公开接口**只读最新 release**；草稿只能通过**短时预览 Token** 读取 |
| R5 | **预览副作用**：预览页产生真实工单/短信 | —— | 预览用**合成门店**（不发真实 entry）、提交与媒体入口**禁用**；预览 Token 10 分钟、不落库 |
| R6 | **缓存导致的"发布了但没生效"** | `/h5/` HTML 已 `no-store` | 配置接口 `no-cache` + `ETag: "<scope>-<version>"`；发布即换 ETag ⇒ 下次打开立即生效 |
| R7 | **二维码归属被装修污染** | 归属由 HMAC 签名入口决定（`store-entry.ts`） | 装修配置**不参与**入口解析；门店覆盖**不得**携带/改写 `k`；红线条文见 DESIGN §4 |
| R8 | **法律文本被改** | 隐私页脚+说明写死 | 列入**受保护白名单**，不在可配置 schema 内；改它仍须走"改代码 + 升版本号 + 门禁比对" |
| R9 | **配置膨胀**：15 家门店 × 20 项 = 300 个孤立参数 | —— | v1 **只做总部一套**；门店级覆盖若启用，只允许 4 个字段且**必须继承**（未覆盖=继承，不存副本） |
| R10 | **JSON 结构漂移**：以后加字段，老版本读不懂 | —— | `doc.schema_version`；发布行**存整份快照**，读取端按版本兼容；未知键忽略、缺失键补默认 |

---

## 10. 截图基线

位置：`.tmp-verify/ux01d/`（未入库）。**全部为真实浏览器渲染**，非设计稿。

### 10.1 客户 H5（三视口）

| 文件 | 尺寸 | 关键读数 |
|---|---|---|
| `report-repair-375.png` / `-390` / `-420` | 375×1017 / 390×1017 / 420×995 | 平台名 18px；门店卡只有店名+地址（**无电话**，库内 S01 电话为空）；两个 tab 各占一半；媒体 2×2 卡片 74px 高；帮助条整行；页脚告知在按钮下方 |
| `report-complaint-375.png` / `-390` / `-420` | 375×954 / 390×954 / 420×954 | 结构与报修**完全同构**，仅标签变「投诉内容」；**无**家电/地址等选填区 ⇒ 首屏更短 |
| `success-375.png` / `-390` / `-420` | 375×812 / 390×844 / 420×900 | 标题 20px；工单号 24px 等宽数字；主 CTA 高 48+；两个次要按钮严格等宽 |
| `progress-375.png` / `-390` / `-420` | 375×812 / 390×844 / 420×900 | **提交时间显示「—」**（DEV-209）；状态徽标**被拉成整行**（B-20） |

### 10.2 后台（1440×900）

| 文件 | 内容 |
|---|---|
| `admin-sla.png` | 服务时效：3 行；配置键与说明列**被截断**（B-22） |
| `admin-sms.png` | 短信通知：通道能力表 3 行 + 3 项配置 + 最近记录；右上角 `No permissions` toast（**B-17**，与本页无关） |
| `admin-store-entry.png` | 门店报修入口：15 行，行内「查看 / 报修入口 / 门店资料」 |
| `admin-tickets.png` | 全量工单列表（导航与筛选样式基线） |
| `admin-workbench.png` | **404** —— 该页面属**门店角色**菜单，`hq_admin` 直访被路由拒绝（这是权限隔离的正常表现，不是缺陷） |

### 10.3 两个必须说明的截图伪影（避免误判为缺陷）

1. **吸底 CTA 出现在页面中部**：全页截图时 `position: fixed` 元素按**视口底部**绘制，
   而页面内容继续向下延伸 ⇒ 视觉上"按钮压住了补充信息/privacy 文案"。
   真实滚动时它固定在屏幕底部，`.svc-page.has-fixed-cta` 已预留 100px 占位（`base.css` L360-362）。
2. **后台页面在 `clip + captureBeyondViewport` 下截出空白**（DOM 已渲染、文本 2856 字，截图只有 spinner）。
   改用"把视口拉到内容高度后普通截屏"才正常 —— 这是**取证工具**的问题，不是产品问题。

---

## 11. 本轮发现并单独登记的缺陷（不在 UX-01D 修）

| 编号 | 现象 | 根因（已取证） | 落点 |
|---|---|---|---|
| **DEV-209** | 客户进度页「提交时间」与时间线时间**恒显示「—」** | `progress-service.ts` L216 读 `t.created_at`，但 NocoBase 系统时间字段的属性名是 **`createdAt` / `updatedAt`**（`toJSON()` 输出也是驼峰）⇒ 取到 `undefined`，被 `JSON.stringify` 丢弃。接口实测返回键里**有 `closed_at`、没有 `created_at`** | `docs/DEVIATIONS.md` DEV-209 |
| **B-20** | 进度页状态徽标（「待处理」）被**拉成整行**，橙底 + 蓝字 | `.svc-progress-hero` 是 `flex-direction: column` 且未设 `align-items` ⇒ 子项按 `stretch` 拉伸，`.svc-progress-status` 的 `inline-block` 失效；底色 `#fff2e8` 与文字 `var(--svc-primary)` 不协调 | `docs/BACKLOG.md` B-20 |
| **B-21** | 隐私说明正文出现**字面星号** `**不需要注册账号**` | `utils/privacy.ts` 里写了 Markdown 加粗语法，但模板用 `{{ para }}` 纯文本插值，不做 Markdown 解析 | `docs/BACKLOG.md` B-21 |
| **B-22** | 服务时效表格「配置键」「说明」列被截断（`sla.store_confirm_h…`） | 列宽自适应不足，未设最小宽度/省略号提示 | `docs/BACKLOG.md` B-22 |
| **B-23** | 客户 H5 次要文字对比度 **3.22:1**（AA 需 4.5:1），中老年可读性不达标 | `--svc-text-weak: #8a9099` 用于 11–13px 提示文字；白底 3.22、页面底 2.97（实测计算） | `docs/BACKLOG.md` B-23 |

> 五条都**只登记、不修改**：UX-01C 已冻结、UX-01D 本轮只做设计。
> B-23 与"主题化"直接相关 —— 每个主题预设的文字/底色组合**必须逐对达标**，否则等于把不达标固化成"可选项"。

---

## 12. 可行性判断

### 12.1 技术上已具备的条件

1. **主题化成本极低**：`base.css` 的 12 个变量是唯一收口，组件里没有散落的硬编码主色（除进度徽标那处缺陷）。
2. **后台装修界面不必从零造**：`SmsCenterModel` 已证明"自定义区块 + 服务端动作 + 表格/表单"这条路可用。
3. **发布不必重新构建 H5**：`/h5/` HTML 是 `no-store`，配置是运行期数据 ⇒ "管理员改完点发布，客户下次打开就是新的"。
4. **权限与审计范式齐备**：受控动作 + 409 + 幂等 + 审计同事务，照抄即可。

### 12.2 真正的难点（不是写代码）

| 难点 | 为什么难 | 应对 |
|---|---|---|
| **划清"可装修"与"契约"的边界** | 文案一改就可能踩到承诺/法律（"30 天内可查询"、"仅用于本次售后"） | 白名单 + 受保护清单（DESIGN §2/§4） |
| **预览不能有副作用** | 真实页面一打开就会解析入口、拉门店、甚至允许提交 | 合成门店 + 禁用提交 + 短时 Token |
| **门店覆盖会带来一致性裂缝** | 进度页没有入口参数（G12），同一门店两个页面可能不同主题 | v1 不做；若要做，先解决 scope 传递 |
| **文案可配置 vs 现有门禁** | 至少 1 条门禁硬断言平台名（`verify-store-entry.mjs` L2497） | 改成"等于生效配置/默认值"，**不得删断言** |
| **默认值必须与今天像素级一致** | 否则"没装修"的存量门店会突然变样 | 默认值 = 现有字符串/变量，逐字节比对进 M1 门禁 |

### 12.3 不建议做的事（本轮的否定结论）

- ❌ **不做通用页面构建器**：拖拽/脚本/任意区块，会同时打破"安全"与"可维护"两条线。
- ❌ **不开放任意 CSS / HTML / 外部脚本**：没有 CSP 兜底（后台是低代码），等于开门。
- ❌ **不把装修配置塞进 `serviceSettings`**：单值字符串 + 无版本维度 ⇒ 无法原子发布（详见 DESIGN §7）。
- ❌ **不在本轮顺便修 DEV-209 / B-20 / B-21 / B-22**：会污染"只做审计"的边界。
- ❌ **不用"门店资料已经可配置"冒充"页面可装修"**：前者只改数据，不改外观。
