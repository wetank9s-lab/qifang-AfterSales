# 家电门店售后服务平台 · UX 差距与整改实施报告

> 审计日期：2026-10-15 · 阶段：Phase 11 IN PROGRESS / P11-5 PASS（已冻结）/ P11-4 IN PROGRESS（本轮暂停推进）
> 文档性质：**整改设计报告（仅审计与设计，未改动任何产品代码 / 数据库 / 页面配置）**
> 配套纪律：禁止重复造轮子 · 不做不必要哈希校验 · 小改动不做全量回归

---

## 0. 审计方法论与范围

**方法**：实际读取当前仓库源码与种子脚本，不依据任何既往开发报告推断运行页面。覆盖：

- 门店侧：`src/client/*`（tab-filter / row-action-matrix / action-matrix / primary-action / ticket-drawer / ticket-display / ticket-create-action / ticket-store-review / store-entry-action）、`src/server/actions/svc/*`、`src/server/collections/ticketEvents.ts`、`src/server/services/*`、`src/server/migrations/202610101-next-follow-at.ts`。
- 配置/权限/种子：`src/server/collections/serviceSettings.ts`、`src/server/services/config-service.ts`、`src/server/seeds/*`、`src/server/migrations/20260920-baseline-seed.ts`、`scripts/seed-admin-pages.mjs`、`scripts/expected-sensitive-columns.mjs`、`sms-receipt-config.ts`、`smsLogs.ts`、`sla-scan-scheduler.ts`、`roles.ts`、`permission-service.ts`。
- 客户 H5：`h5/src/pages/*`（Report / Customer/Progress / Review / Report/Success）、`h5/src/components/MediaUploader.vue`、`h5/src/api/*`、`h5/src/utils/*`、`h5/src/styles/base.css`、以及 `src/server/actions/public/*`。

**说明**：本报告以「源码定义 + 种子脚本」为权威当前态。运行实例的可视页面由 `scripts/seed-admin-pages.mjs`（`flowSurfaces:applyBlueprint`）与客户端组件共同决定，已逐一核对源码，未做可视化渲染截图（环境不渲染 NocoBase 实例）。所有结论均附 `file:line` 证据。

---

## 1. 角色与最高原则

| 角色 | 关注点 | 核心诉求 |
|---|---|---|
| 客户 | 扫码报修 / 查进度 / 评价 | 30 秒内完成报修，过程透明、有反馈 |
| 门店售后员工 | 接单 / 派工 / 跟进 / 审核 / 备注 | 登录即知「今天该做什么」，动作清晰、不误触系统字段 |
| 总部售后 | 全量工单 / 转店 / 重开 / 历史事件 | 跨店追溯、批量处置 |
| 总部管理员 | SLA / 短信 / 配置 / 页面装修 | 后台可维护，不碰代码 |

**最高原则**：客户能快速报修；门店员工能立即知道该做什么；所有业务操作清晰易懂。**技术上完整但业务人员难理解 ≠ 合格。**

---

## 2. 差距总览（编号 / 模块 / 分类 / 优先级 / 范围）

分类图例：
- **A** 已有能力但入口缺失
- **B** 已有能力但操作不便
- **C** 实际缺少业务能力
- **D** 可配置解决
- **E** 必须开发解决

| 编号 | 模块 | 一句话差距 | 分类 | 优先级 | 范围 |
|---|---|---|---|---|---|
| G1 | 门店首页 | 无工作台首页，登录直接进状态分页列表，缺概览/待办/快捷新建 | A | P1 | 中 |
| G2 | 门店行操作 | NEW 主按钮即「处理」，缺显式「先查看」入口 | B | P2 | 小 |
| G3 | 闭环备注 | 已闭环工单无法追加内部备注/跟进（无 INTERNAL_NOTE 事件） | C | P1 | 中 |
| G4 | 跟进队列 | `followUpQueue` 接口存在但无客户端页面消费 | A | P1 | 小~中 |
| G5 | 新建表单 | 六类表单虽按类型显隐，但仍有可进一步精简/渐进披露空间 | B | P1 | 小~中 |
| G6 | 动作矩阵 | 两套矩阵并存（`action-matrix.ts` 旧 / `row-action-matrix.ts` 新），有漂移风险 | B | P2 | 小 |
| G7 | 门店二维码 | 旧入口链接仍以文本展示在后台（与「UI 不再展示旧入口」要求不符） | B/D | P1 | 小 |
| G8 | 配置·保留期 | `privacy.retention_months` 声明但永不消费（假设置） | D | P2 | 小 |
| G9 | 配置·孤儿键 | `historical.unreplayable-batches`/`test-artifacts.purge.audit` 仅为过测存在 | D | P2 | 小 |
| G10 | SLA 管理 | SLA 阈值无 HQ 专用维护 UI，改错无护栏 | B/D | P1 | 中 |
| G11 | 短信管理 | 无短信通道/状态专用后台页（`smsLogs` 未播种页面） | A/D | P1 | 中 |
| G12 | 短信枚举 | `tencent` 未实现却被枚举/描述列出→静默全拒；`smsbao` 已实现却不在枚举 | D | P1 | 小 |
| G13 | 页面种子 | 重跑页面种子以 `mode:'replace'` 覆盖后台手工装修 | E | P2 | 小（流程） |
| G14 | H5 配置 | HQ 无法在后台维护 H5 站点名/品类/字数上限/隐私文案/主题，需发版 | D/E | P2 | 中~大 |
| G15 | 客户首屏 | 首屏过长（门店卡+模式 tab+整张表单堆叠），无分步/折叠 | B | P1 | 中 |
| G16 | 客户键盘 | 软键盘遮挡无聚焦滚动补偿，小屏提交按钮被盖 | B | P1 | 小 |
| G17 | 媒体校验 | 无「至少 1 张图」硬要求（与 1~3 张规格措辞不符，需产品确认） | C | P2 | 小 |
| G18 | 媒体反馈 | 单项上传失败无「重试」按钮，只能删后重加 | B | P2 | 小 |
| G19 | 弱网反馈 | 整表单弱网仅顶部 banner，无整体遮罩/重试进度 | B | P2 | 小~中 |
| G20 | 成功页 | 「复制工单号」在 clipboard 不可用时直接隐藏，无降级 | B | P2 | 小 |
| G21 | 进度页 | Token 失效即不可恢复，无重新输入/联系门店补救入口 | B | P2 | 小 |
| G22 | 死代码 | `fetchStores`（门店下拉）已不再使用，保留为死代码 | B | P2 | 小 |
| G23 | 状态词汇 | 状态标签/动作标签整体一致，但需统一「审核结果/门店确认」等边界用语 | B | P3 | 小 |

---

## 3. 门店侧

### 3.1 门店首页草图（当前 → 推荐）

**当前结构**（实际：登录后落在「售后工单 → 我的门店工单」单表，6 个 Tab：待处理/处理中/待门店确认/待客户评价/已闭环/搜索）

```
┌─────────────────────────────┐
│ 我的门店工单（标题）          │
│ [待处理][处理中][待门店确认] │
│ [待客户评价][已闭环][搜索]   │
│ ─────────────────────────── │
│ 工单表格（状态分页）          │
│ [新建服务单]                  │
└─────────────────────────────┘
```

**推荐结构**（工作台首页，概览 + 待办 + 快捷 + 查询）

```
┌─────────────────────────────┐
│ 早安，{门店名} · 今日 {日期}   │
├─────────────────────────────┤
│ [待处理 N] [处理中 N] [待确认 N] [待评价 N]   ← 概览卡（点进对应状态）│
├─────────────────────────────┤
│ 今日待跟进 / 已逾期  (来自 followUpQueue)     │
│  · 工单 FWxxx  预计 14:00 上门  [去跟进]      │
├─────────────────────────────┤
│ [＋ 新建服务单]   [🔍 记录查询]              │
├─────────────────────────────┤
│ 最近工单（最近 10 条，行内主行动按钮）        │
└─────────────────────────────┘
```

证据：`seed-admin-pages.mjs:588` 仅播种单表；`expected-sensitive-columns.mjs:111` 状态 Tab 定义；`followUpQueue` 接口存在但客户端无页面（`primary-action.tsx` / `ticket-drawer.tsx` 均未引用）。

### 3.2 工单列表 / 状态筛选 / 行操作

- 状态筛选通过服务端 `addFilterGroup` 生效（`tab-filter.tsx:143`），分页/计数正确；拿不到区块资源时仅 `console.warn` 静默降级（`tab-filter.tsx:163`）→ **建议**：降级时界面给出「筛选未生效」提示而非无声。
- 行按钮墙已拆除，每行唯一主行动（`row-action-matrix.ts:46`）。✅ 良好，保留。

### 3.3 全状态可见动作矩阵（覆盖既有状态）

| 工单状态 | 行主按钮 | 打开 | 窗口/抽屉内可做的动作 | 备注 |
|---|---|---|---|---|
| NEW（待处理） | 处理 | 处理窗口 | 安排上门 / 交厂家·第三方 / 电话·门店直接解决 / 客户取消 | 处理后→PROCESSING 或 CANCELLED |
| PROCESSING（处理中） | 跟进 | 跟进窗口 | 记跟进 `note`（必填）+ `next_follow_at`（设定/清空/不变 三态） | 可进「今日待跟进/已逾期」队列 |
| WAIT_STORE_CONFIRM（待门店确认） | 审核结果 | 门店审核窗口 | 确认 / 驳回（带原因） | `store-review` |
| WAIT_FEEDBACK（待客户评价） | 查看 | 只读详情抽屉 | 仅查看 | 评价由客户 H5 完成 |
| CLOSED（已闭环） | 查看 | 只读详情抽屉 | 仅查看 ⚠️ **不能加内部备注/跟进** | 缺口 G3 |
| CANCELLED（已取消） | 查看 | 只读详情抽屉 | 仅查看 | — |

证据：`row-action-matrix.ts:46-61`、`action-matrix.ts:59-71`（旧）、`primary-action.tsx:548`、`ticket-service.ts:264`（FOLLOWABLE_STATUSES 仅 PROCESSING）、`constants.ts:550-582`（EVENT_TYPE 无 INTERNAL_NOTE）。

### 3.4 新建工单六类表单精简

当前 `TYPE_CONFIG` 已按 `repair/installation/maintenance/relocation/complaint/other` 显隐字段（`ticket-create-action.tsx:62`），`store_code` 取自受控 `svc:storeOptions`（`:192`），提交体**不含**任何系统级字段（`:278`）→ **系统级字段未暴露，符合「禁止员工随意改系统字段」**。

仍可优化（G5）：
- 投诉/其他类隐藏家电与地址后，剩余字段仍一次性铺开；建议**渐进披露**：先必填（联系人/手机号/事项），选填（地址/家电/品牌）折叠。
- `urgent` 紧急标记文案已清晰，保留。

### 3.5 详情 / 跟进 / `next_follow_at`

- 「先查看后处理」：点击行打开只读详情抽屉（`ticket-drawer.tsx`），NEW 态主按钮为「处理」但查看可达（G2：建议 NEW 也加显式「查看」）。
- 处理中跟进完整支持（`primary-action.tsx:439`），`next_follow_at` 已由迁移 `202610101-next-follow-at.ts` 落地。
- 闭环后：无任何内部备注/跟进通道（G3）。

### 3.6 闭环工单内部备注（能力缺失，G3）

- `constants.ts:550` 的 `EVENT_TYPE` 白名单**无** `INTERNAL_NOTE`；`event-service.ts:217` 对非法类型硬拒。
- `followUp` 在 PROCESSING 之外一律状态冲突拒绝（`ticket-service.ts:1531`）。
- **结论**：门店想在闭环单上补一句内部说明（如「已电话回访客户满意」），当前只能重开（受状态机约束，非门店自由操作）→ 与「已完成可添加内部备注」要求冲突。属 **C 实际缺少业务能力**。

### 3.7 门店二维码与旧入口（G7）

- 新入口：后台可复制签名链接 + 下载 SVG 二维码，标注「已签名防篡改」（`store-entry.ts:77`、`store-entry-action.tsx:214`）。
- 旧入口：`resolveStoreEntry` 仍接受裸门店编码（后端兼容保留 ✅）；但后台弹窗**显式列出旧入口链接文本 + 防篡改警告**（`store-entry-action.tsx:214`），旧二维码图不提供下载。
- **与要求不符**：用户要求「门店二维码管理界面**不再展示**旧二维码和旧入口链接，但必须保留旧二维码的后端兼容性」。当前旧链接文本仍可见 → 应**从 UI 移除旧入口链接展示**，仅保留服务端解析兼容（G7，分类 B/D，范围小）。

---

## 4. 客户 H5

### 4.1 首屏草图（当前 → 推荐）

**当前结构**（`Report/index.vue:1-80`，`/report` 同时承担落地+报修）

```
┌─────────────────────────────┐
│ 四川七方连锁售后服务平台        │  ← 硬编码平台名
│ [门店名] [☎电话] [地址]        │
│ [我要报修] [我要投诉]           │
│ ── 报修表单 ──                │
│ 联系人 / 手机号 / 故障描述+媒体 │
│ 家电类别 / 品牌型号 / 服务地址  │
│ [提交报修]                     │  ← 需下滑才见
└─────────────────────────────┘
```

**推荐结构**（精简首屏 + 固定 CTA + 防遮挡）

```
┌─────────────────────────────┐
│ {门店名} 报修                  │  ← 门店名即标题，平台名仅页脚
│ [我要报修] [我要投诉]           │
│ 联系人 ___________             │
│ 手机号 ___________             │
│ 故障描述 ___________ [＋媒体]  │  ← 媒体后置，先填文字
│ [提交报修]  ← 固定底部，不被键盘盖 │
│ ── 选填（点开）────────       │
│ 家电类别 / 品牌型号 / 服务地址  │
└─────────────────────────────┘
```

证据：首屏 6 字段+媒体+模式 tab 全部纵向堆叠（`Report/index.vue:1-80`）；键盘遮挡仅底部安全区、无聚焦滚动（`base.css:53`、`Report/index.vue:647` 仅校验失败才 scrollIntoView）。

### 4.2 媒体 / 进度 / 成功页反馈

- 媒体：`MediaUploader.vue:33` 拍照/录音/视频；上传有进度条与错误文案（`:133`）；**但单项失败无「重试」按钮**（G18，须删后重加）；弱网仅顶部 banner（G19）。
- 成功页：`Success.vue:1` ✓ 图标/工单号/进度「已提交」/查看进度/复制/再报一单；**复制按钮在 `clipboard` 不可用时直接隐藏**（G20，无长按降级）。
- 进度页：`Progress.vue:13` loading/error 三态齐全；**Token 失效即不可恢复，无重新输入入口**（G21）。
- 死代码：`fetchStores`（`api/public.ts:16`）已不用（G22）。

---

## 5. 配置与设置中心

### 5.1 设置项清单（键 → 消费点 → 是否真消费）

来源：`serviceSettings`（26 键）+ `config-service.ts` + 全仓 grep。下表仅列关键项，完整 26 键见 `constants.ts:2807`。

| 设置键 | 消费点（file:line） | 控制行为 | 状态 |
|---|---|---|---|
| `sla.accept_minutes` / `appointment_overdue_grace_minutes` / `store_confirm_hours` | `sla-scan-scheduler.ts:226-228` | SLA 三阈值 | ✅ 真消费 |
| `sms.provider` / `sms.enabled` / `sms.retry_count` | `sms-service.ts:296/509/510` | 短信通道/开关/重试 | ✅ 真消费 |
| `feedback.*` / `technician.token_expire_*` | `ticket-service.ts` / `review-expiry-scheduler.ts` | 评价/链接时效 | ✅ 真消费 |
| `security.*`（7 项） | `review.ts`/`ticket.ts`/`media.ts`/`technician/visit.ts` | 限流/防刷 | ✅ 真消费 |
| `visit.photo_*` | `technician/visit.ts:230-231` | 上门照片数/大小 | ✅ 真消费 |
| `privacy.retention_months` | **无任何读取点** | （应控制保留期） | ⚠️ **假设置（G8）** |
| `historical.unreplayable-batches` | 仅 `DEFAULT_SETTINGS` 声明 | — | ⚠️ **真孤儿（G9）** |
| `test-artifacts.purge.audit` | 仅 `DEFAULT_SETTINGS` 声明 | — | ⚠️ **真孤儿（G9）** |
| `*.audit` 类（official-list / file-name-repair / dedup-backfill） | 仅迁移写入 | 审计 JSON | 写-only（低风险） |

**结论**：`privacy.retention_months` 与 2 个孤儿键属于「无人读取的假设置项」，**违反本轮「禁止创建无人读取的假设置项」**。整改：要么实现保留作业消费它，要么从 `DEFAULT_SETTINGS` 移除并补 smoke 判据（G8/G9，D 可配置/清理，范围小）。

### 5.2 NocoBase 后台原生配置 vs 独立客户 H5 自定义配置

| 维度 | NocoBase 后台原生（HQ 可维护） | 独立客户 H5（当前需发版） |
|---|---|---|
| 站点/平台名、`<title>` | — | `Report/index.vue:5`、`h5/index.html:11` 写死 |
| 家电类别枚举 | 后端 `shared/appliance-category.ts` | `h5/src/utils/appliance-options.ts:13` 双副本 |
| 字段字数/格式上限 | — | `h5/src/utils/validate.ts`、`appliance.ts` 写死 |
| 隐私告知全文+版本 | `PRIVACY_NOTICE_VERSION` 常量 | `h5/src/utils/privacy.ts` 双副本（须逐字一致） |
| 媒体默认限制 | 服务端 `limits` 下发（权威） | `MediaUploader.vue:196` 仅兜底默认值 |
| 主题色/提示文案 | — | `base.css`、`Report/index.vue` 写死 |

**关键结论**：**不存在「独立客户 H5 自定义配置表」**。H5 与后台共用 `serviceSettings`，但 H5 侧大量展示配置（命名/品类/字数/隐私文案/主题）是**前端硬编码双副本**，HQ 后台改不了，必须改 `h5/` 重新构建发布（G14）。建议：引入一组 `h5.*` 设置键（站点名、品类列表、字段上限、隐私文案版本）供 H5 启动时拉取，保留双副本门禁，避免每次品牌调整都发版。

### 5.3 SLA / 短信管理 UI 缺口（G10/G11/G12）

- **SLA**：阈值来自 `serviceSettings`，但**无 HQ 专用维护页**，只能改通用参数表，改错无校验护栏（G10）。
- **短信**：`sms.provider/enabled/retry_count` 可改但无专用页；`smsLogs` 在原生只读白名单却**未播种页面**（`seed-admin-pages.mjs` 仅播 5 页）→ HQ 看不到短信状态（G11）。
- **枚举漂移**：`serviceSettings` 描述写 `tencent` 可选，但 `createSmsProvider` 仅实现 `mock/aliyun/smsbao`，`tencent` 落入 `default`→`NotImplementedSmsProvider`→**静默全拒**（G12，危险误配）。须统一三处枚举/描述。

---

## 6. 角色权限复核（无越权确认）

| 角色 | 数据范围 | 写工单 | 跨店读 | 全局配置 |
|---|---|---|---|---|
| `store_after_sales` | 仅授权门店（fail-closed） | ✅ | ❌ | ❌（`allowConfigure:false`） |
| `hq_after_sales` | all | ✅ | ✅（受控转店） | ❌ |
| `hq_admin` | all | ✅ | ✅ | ✅ |
| `viewer` | all | ❌ | ❌（脱敏） | ❌ |

证据：`constants.ts:1513`、`permission-service.ts:350`（fail-closed）、`roles.ts:69`（`NO_PM_SNIPPETS`）。**结论**：门店角色无跨店读、无全局配置权限，符合「不得让普通门店员工拥有全局设置或跨店数据权限」。受控转店是单点写权限、不扩展读范围，非越权。✅

---

## 7. 差距明细（每项 9 要素 + 分类）

> 字段：① 当前位置 ② 实际问题与证据 ③ 既有能力可复用 ④ 推荐交互/字段规则 ⑤ 新接口/迁移/页面模型 ⑥ 涉及状态机/权限/安全/历史 ⑦ 范围 ⑧ 优先级 ⑨ 验收条件 ｜ 分类

**G1 门店工作台首页缺失**
① `seed-admin-pages.mjs:588`、`expected-sensitive-columns.mjs:111` ② 登录即进单状态表，无概览/待办/快捷新建卡片，员工不知「今天该做什么」③ 状态 Tab、`followUpQueue` 接口、`新建服务单` 按钮均已存在 ④ 新增工作台首页：概览卡（待处理/处理中/待确认/待评价计数）+ 今日跟进队列 + 快捷新建 + 记录查询 ⑤ 需新页面蓝图（`applyBlueprint`）+ 客户端首页组件 ⑥ 不涉及状态机；权限沿用门店范围 ⑦ 中 ⑧ P1 ⑨ 登录后见工作台；四个概览卡可点进对应状态；今日跟进队列显示 `followUpQueue` 数据并可「去跟进」；新建/查询入口可达 ｜ A

**G2 NEW 态缺显式查看入口**
① `row-action-matrix.ts:46`、`primary-action.tsx:197` ② NEW 主按钮为「处理」，虽点行可开只读抽屉，但无显式「查看」③ 只读详情抽屉已存在 ④ NEW 行增加次按钮「查看」或直接点行即开抽屉 ⑤ 无 ⑥ 无 ⑦ 小 ⑧ P2 ⑨ NEW 工单可先查看再处理，不强制进入处理窗口 ｜ B

**G3 闭环工单无法加内部备注**
① `constants.ts:550`（无 INTERNAL_NOTE）、`ticket-service.ts:1531`、`event-service.ts:217` ② 闭环后既不能跟进也不能追记门店内部说明 ③ `follow_up` 事件机制 + `ticketEvents` 集合可复用 ④ 新增 `INTERNAL_NOTE` 事件类型 + 闭环态「添加内部备注」动作（仅写 `ticketEvents`，**不重开/不重新派工/不触发短信**）⑤ 改 `EVENT_TYPE` 白名单 + 新增 server action + 客户端入口（小）⑥ 涉及历史事件集合；**明确不触发状态机/短信** ⑦ 中 ⑧ P1 ⑨ 闭环工单可见「添加内部备注」入口；提交后写入 `ticketEvents` 且状态保持 CLOSED；不发送任何短信、不改变 `status` ｜ C

**G4 跟进队列无页面消费**
① `followUpQueue` 接口存在，`primary-action.tsx`/`ticket-drawer.tsx` 均未引用 ② 门店看不到「今日待跟进/已逾期」③ 接口已存在 ④ 在工作台首页（G1）渲染队列 ⑤ 无（复用接口）⑥ 无 ⑦ 小~中 ⑧ P1 ⑨ 首页队列展示且有「去跟进」直达跟进窗口 ｜ A

**G5 新建表单进一步精简**
① `ticket-create-action.tsx:62/192/278` ② 字段按类型显隐但仍一次性铺开 ③ 现有按类型显隐机制 ④ 渐进披露：必填前置，选填（地址/家电/品牌）折叠；`urgent` 保留 ⑤ 无（纯前端）⑥ 无（系统字段已不暴露，符合冻结要求）⑦ 小~中 ⑧ P1 ⑨ 投诉/其他类不问卷家电；选填可折叠；提交体仍不含系统字段 ｜ B

**G6 两套动作矩阵并存**
① `action-matrix.ts:59`（旧 H6）、`row-action-matrix.ts`（新）② 旧矩阵 `NEW→[accept,dispatch]` 若误接回行按钮会与现「处理窗口」文案冲突 ③ `row-action-matrix.ts` 为新唯一来源 ④ 删除/废弃 `action-matrix.ts` 的 `availableActionsOf` 行按钮用法，仅保留门禁引用并加注释 ⑤ 无 ⑥ 无 ⑦ 小 ⑧ P2 ⑨ 仅一处定义行按钮矩阵；grep 无第二处影响行按钮 ｜ B

**G7 旧入口链接仍在 UI 展示**
① `store-entry-action.tsx:214` ② 后台弹窗展示旧入口链接文本（含防篡改警告），与「UI 不再展示旧入口」不符 ③ 后端 `resolveStoreEntry` 裸码兼容已保留（删除展示不影响兼容）④ 从后台界面移除旧入口链接文本展示，仅保留服务端解析兼容 + 内部注释说明 ⑤ 无 ⑥ 安全：服务端兼容保留（不删 `legacy_url` 解析）⑦ 小 ⑧ P1 ⑨ 后台报修入口界面不再出现旧入口链接；旧码扫码仍可进 H5（后端验证）｜ B/D

**G8 假设置 `privacy.retention_months`**
① `constants.ts:2956`，全仓无读取点 ② 管理员可改但无任何行为变化，误以为已配置保留期 ③ `serviceSettings` 机制 ④ 二选一：实现保留作业消费该键 / 或移出 `DEFAULT_SETTINGS` 并修正 smoke 判据 ⑤ 若实现需新调度器（中）；若移除仅改常量（小）⑥ 无 ⑦ 小 ⑧ P2 ⑨ 该键要么被某作业真实消费，要么从设置表消失；不准存在「可改不生效」项 ｜ D

**G9 真孤儿键**
① `constants.ts:3006/3014` ② 仅为过 smoke「逐键一致」判据存在，无读写 ③ — ④ 移除并调整 smoke 判据允许省略测试占位键 ⑤ 无 ⑥ 无 ⑦ 小 ⑧ P2 ⑨ grep 全仓除声明外无引用；smoke 判据不再强依赖 ｜ D

**G10 SLA 无专用维护 UI**
① `sla-scan-scheduler.ts:216`、`timeliness.ts:163` ② 阈值仅通用参数表可改，无向导/校验 ③ `serviceSettings` + 扫描调度已存在 ④ 新增「SLA/时效规则」维护页（或直接复用参数页并加说明/范围校验）⑤ 新页面蓝图（小）或参数页增强 ⑥ 无 ⑦ 中 ⑧ P1 ⑨ HQ 可在后台查看并修改三阈值，且输入有合法范围校验 ｜ B/D

**G11 短信无专用后台页**
① `smsLogs.ts:22`（原生只读白名单）、`seed-admin-pages.mjs`（未播种 smsLogs 页）② HQ 看不到短信状态/通道 ③ `smsLogs` 集合 + `serviceSettings(sms.*)` 已存在 ④ 播种 `smsLogs` 只读页 + 「短信配置」入口（provider/enabled/retry）⑤ 新页面蓝图（中）⑥ 权限：仅 HQ 可见 ⑦ 中 ⑧ P1 ⑨ HQ 后台可见短信列表（状态/回执/重试）并可改通道配置 ｜ A/D

**G12 短信枚举漂移**
① `constants.ts:2869`（描述 tencent）、`sms-provider.ts:641`（无 tencent 分支）、`smsLogs.ts:39`（枚举 tencent）② 设 `tencent` 静默全拒；`smsbao` 已实现却不在列表 ③ `createSmsProvider` 已实现 mock/aliyun/smsbao ④ 统一三处枚举/描述：要么实现 tencent，要么从描述/枚举移除并补 `smsbao` ⑤ 无（改常量/描述）⑥ 安全：避免误配导致全拒 ⑦ 小 ⑧ P1 ⑨ 描述/枚举/工厂三者一致；设未实现值时报明确错误而非静默拒绝 ｜ D

**G13 页面种子覆盖手工装修**
① `seed-admin-pages.mjs:1779`（`mode:'replace'`）② 重跑脚本覆盖后台对 5 个页面的手工装饰 ③ 参数/角色种子是「只增不改」(无此风险) ④ 变更管理：页面视为代码交付物，手工改须改脚本重跑；或加 `protect` 标志跳过重写 ⑤ 流程 + 可选脚本改造 ⑥ 无 ⑦ 小（流程）⑧ P2 ⑨ 文档化「页面不可手工改、改脚本重跑」；或实现保护合并，重跑不丢手工装饰 ｜ E

**G14 H5 配置不可后台维护**
① `Report/index.vue:5`、`appliance-options.ts:13`、`validate.ts`、`privacy.ts`、`base.css` ② HQ 改品牌/品类/字数/隐私文案需发版 ③ 后端已有 `serviceSettings` 与双副本门禁机制 ④ 引入 `h5.*` 设置键（站点名/品类/字段上限/隐私文案版本）由 H5 启动拉取；保留双副本门禁 ⑤ 新增 `h5.*` 设置键 + H5 启动拉取 + 可选后台页 ⑥ 无 ⑦ 中~大 ⑧ P2 ⑨ HQ 后台可改站点名/品类/字段上限且 H5 即时生效；双副本门禁仍校验一致 ｜ D/E

**G15 客户首屏过长**
① `Report/index.vue:1-80` ② 门店卡+模式 tab+整张表单堆叠，中老年客户多次下滑 ③ 现有表单/媒体组件 ④ 见 §4.1 推荐结构：门店名为标题、必填前置、选填折叠、CTA 固定 ⑤ 纯前端重构 ⑥ 安全：保持现有校验/匿名边界 ⑦ 中 ⑧ P1 ⑨ 首屏无需下滑即可见门店名+核心字段+提交按钮；选填可展开 ｜ B

**G16 软键盘遮挡**
① `base.css:53`、`Report/index.vue:647`（仅失败滚动）② 输入聚焦不滚到可视区，小屏提交按钮被盖 ③ — ④ 聚焦时 `scrollIntoView` + `interactive-widget=resizes-content` 或底部安全区上移 ⑤ 纯前端 ⑥ 无 ⑦ 小 ⑧ P1 ⑨ 任意输入框聚焦时提交按钮不被键盘遮挡，可见可点 ｜ B

**G17 媒体最少 1 图校验**
① `Report/index.vue:579`（文字或媒体任一即可）、`MediaUploader.vue:196`（image_max_count:3 为上限）② 无「至少 1 张图」硬要求，与 1~3 张规格措辞不一 ③ 现有媒体校验 ④ **需产品确认**：若要求至少 1 图，加 `imageCount>=1` 校验；否则调整规格措辞 ⑤ 若实施仅前端+后端双校验（小）⑥ 无 ⑦ 小 ⑧ P2 ⑨ 规格与实现一致：要么强制≥1 图，要么文档明确「图非必填」 ｜ C

**G18 媒体单项失败无重试**
① `MediaUploader.vue:547/582` ② 失败项仅文案，须删后重加 ③ 上传函数可复用 ④ 失败项加「重试」按钮调用同一上传 ⑤ 无 ⑥ 无 ⑦ 小 ⑧ P2 ⑨ 单项上传失败可一键重试且成功进入列表 ｜ B

**G19 弱网整表单反馈弱**
① `Report/index.vue:496` ② 弱网仅顶部 banner，无整体遮罩/重试进度 ③ 上传进度条已存在 ④ 提交时全屏遮罩 + 失败可重试；Token 防重复提交 ⑤ 无 ⑥ 安全：保持幂等/防重 ⑦ 小~中 ⑧ P2 ⑨ 弱网提交有可见遮罩与重试；不丢输入 ｜ B

**G20 复制工单号无降级**
① `Success.vue:138`（`canCopy` 控制显隐）② clipboard 不可用时按钮直接隐藏 ③ — ④ 不可用时降级为长按复制提示或「手动记录」文案 ⑤ 无 ⑥ 无 ⑦ 小 ⑧ P2 ⑨ 任意环境均可获得工单号（显式文案或降级交互）｜ B

**G21 进度页 Token 失效不可恢复**
① `Progress.vue:17/149` ② Token 失效仅提示「从成功页进入」，无重新输入/联系门店 ③ 入口解析已存在 ④ 错误态加「重新输入进度码」输入或「联系门店」按钮 ⑤ 无（前端）⑥ 安全：进度码仍匿名、不泄露 ⑦ 小 ⑧ P2 ⑨ Token 失效时客户有补救路径（重输或联系门店）｜ B

**G22 死代码 `fetchStores`**
① `api/public.ts:16` ② 门店下拉接口已不用，保留为死代码 ③ — ④ 删除未用调用与接口（或显式保留并注释）⑤ 无 ⑥ 无 ⑦ 小 ⑧ P2 ⑨ 无死代码引用；如保留须有注释说明 ｜ B

**G23 状态/动作用词统一**
① `row-action-matrix.ts:46`、`expected-sensitive-columns.mjs:111` ② 整体一致，但「审核结果/门店确认」等边界用语宜统一 ③ 现有标签 ④ 维护一份用语词表，状态标签与动作标签对齐 ⑤ 无 ⑥ 无 ⑦ 小 ⑧ P3 ⑨ 全站状态/动作用词一致且无歧义 ｜ B

---

## 8. 冻结与安全边界遵守声明

本轮仅产出设计报告，**未修改任何产品代码 / 数据库 / 页面配置**，并承诺：

- ❌ 不重做已通过的 P11-5（师傅 H5 / 客户媒体受控查看 / Range 修复 / 冻结测试均不动）。
- ❌ 不重新设计现有核心状态机（NEW→PROCESSING→WAIT_STORE_CONFIRM→WAIT_FEEDBACK→CLOSED/CANCELLED 不变）。
- ❌ 不把闭环工单的内部备注误作重开/重新派工/重新触发短信（G3 明确「只写 `ticketEvents`，不改 `status`，不触发短信」）。
- ❌ 不把所有数据库字段直接开放门店编辑（G5 确认系统字段已不暴露；保持）。
- ❌ 不删除旧二维码服务端兼容路径（G7 仅隐藏 UI 展示，保留 `resolveStoreEntry` 裸码解析）。
- ❌ 不让普通门店员工拥有全局设置或跨店数据权限（G6 权限复核已确认 fail-closed）。
- ❌ 不把短信模拟发送成功包装为真实送达（现状 `MockSmsProvider` 回 `deliveryStatus:'pending'`，不伪装 delivered，已确认）。
- ❌ 不引入大型 BPM/ERP/全套页面装修引擎等无关模块。
- ✅ 继续遵守：禁止重复造轮子 · 不做不必要哈希校验 · 小改动不做全量回归。

---

## 9. 优先级汇总与下一步

**P0（无，本轮无阻断性安全事故）**

**P1（本轮应优先整改，且多数为小~中范围）**
- 门店工作台首页（G1）+ 跟进队列落地（G4）
- 闭环工单内部备注能力（G3，C 类必须开发）
- 新建表单精简（G5）+ 旧入口 UI 隐藏（G7）
- SLA 维护 UI（G10）+ 短信状态/配置页（G11）+ 短信枚举统一（G12）
- 客户首屏精简（G15）+ 键盘遮挡（G16）

**P2（可后续排期）**
- 假设置清理（G8/G9）、页面种子覆盖流程（G13）、H5 配置后台化（G14）
- 媒体反馈增强（G18/G19/G20/G21）、死代码（G22）、用词统一（G23）
- 媒体最少 1 图（G17，需产品确认）

**P2 单列 P3**：G23 状态用词统一。

**建议推进顺序（最小改动、集中整改）**：先收口 P1 中「纯前端/小范围」项（G7 旧入口隐藏、G16 键盘、G5 表单精简、G2 查看入口、G6 矩阵合并），再做「需新页面/小开发」项（G1 首页、G3 内部备注、G10/G11 配置页、G15 首屏），最后处理配置治理（G8/G9/G12/G14）。

**当前项目状态保持不变**：P11-5 = PASS / FROZEN；P11-4 = IN PROGRESS（暂停推进）；Phase 11 = IN PROGRESS；Release = HOLD。本轮**未宣布任何新功能 PASS**。
