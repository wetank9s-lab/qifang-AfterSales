# Phase 11：产品化升级

> **产品契约**：[`docs/PHASE-11-REQUIREMENTS.md`](PHASE-11-REQUIREMENTS.md)（`P11-FROZEN-1`，2026-10-09）。
> 本文是该契约在本仓库内的**阶段文档**：开工前 preflight、实施计划、逐步交付记录。
> **产品范围已冻结**；本文不重新开放产品决策，只记录事实与落地方式。
>
> **本文件与契约冲突时以契约为准**；契约与**源码事实**冲突时，按契约 §0.1.5 / §40 回报而不擅自改产品。

---

## §0 冻结基线与纪律

### §0.1 当前状态（2026-10-09）

| 项 | 状态 |
|---|---|
| **Phase 11** | **IN PROGRESS** |
| **P11-0** | **IN PROGRESS** |
| `dfecff5` | **ACCEPTED**（P11-0 的第二个有效推进提交） |
| `e71f222` | ACCEPTED（P11-0 的第一个有效推进提交） |

> ⚠️ **现在不能写 `P11-0 PASS`**：ACL 真正收口、业务最小接口、工作流去「受理」与按钮墙重构
> **都还没落完**。已验收的只是"边界查清 + 取证工装 + 回归门"，不是功能完成。

### §0.2 冻结基线与纪律

| 项 | 值 |
|---|---|
| Phase 11 开工前代码冻结点 | `4cf6638` |
| 状态文档提交 | `f418ed9` |
| Phase 10 状态 | **RELEASE HOLD**（Phase 11 期间**不得**改成 PASS，见契约 §38） |
| 实施单元 | 只允许 **P11-0 ~ P11-7**；不开 P11-D / P11-X 之类临时阶段 |
| 提交纪律 | 一 slice 一 commit；每 slice 顺序 = migration/service → API → UI → 测试 → 文档 |
| 不停的条件 | 只有"真实源码 / 数据库 / NocoBase 机制证明某项无法安全落地，或会破坏已冻结的安全/状态机不变量"才停 |

---

## §1 开工前 read-only preflight（契约 §0.1 第 3 条）

只记录"源码事实与本契约是否一致"。**未改动任何代码。**

### 1.1 已核对为**一致**的契约主张

| 契约主张 | 源码事实 | 判定 |
|---|---|---|
| 业务 UI 存在"受理 / 派工 / 改派 / 改约"按钮墙（§5.1 要求取消） | `scripts/ticket-page-actions.mjs:76-80` 恰为 详情/受理/派工/改派/改约 五个 ActionModel | ✅ 一致 |
| `current_store_entered_at` 需新增（§5.4） | 全插件 **0 个文件**命中 | ✅ 一致（确不存在） |
| `first_response_at` / `handler_user_id` 已存在（§5.3 保留字段、调语义） | 分别 5 / 4 个文件命中 | ✅ 一致 |
| 服务类型当前只有报修/投诉（§8.1 要求扩到 6 种） | `collections/_options.ts:43-46` 仅 `repair` / `complaint` | ✅ 一致 |
| 报修正文当前要求 ≥5 字（§8.1 要求取消） | `actions/public/ticket.ts:125` `CONTENT_MIN = 5`，`:538` 强制校验 | ✅ 一致 |
| 弱网文案当前向用户断言"没有提交成功"（§13.2 要求改写） | `h5/src/pages/Report/index.vue:249` = `'网络异常，工单没有提交成功，请检查网络后重试。'`（`:245` 还留有当时的理由注释） | ✅ 一致 |
| 隐私说明需升级且存在 `**` 直显问题（§28） | 隐私文案散布在 `h5/src/api/http.ts` / `pages/Report/index.vue` / `pages/Technician/Visit.vue` / `styles/base.css` | ✅ 存在 |
| `privacy.retention_months` 类配置"有配置无消费者"（§27.2） | 与 Phase 8/10 已登记的"参数有种子但零消费"同型风险 | ✅ 一致（待 P11-7 落实真任务时逐条核） |

### 1.2 已核对为**不一致 / 需特别处理**的两项（重点）

#### ① B-8（核心集合越权读取）——**可修，且修法比 backlog 预想的轻**（第一手源码取证）

契约 §16.1 要求 P11-0 把 B-8 提升为安全硬门。Preflight 取证到的事实：

| 事实 | 证据 |
|---|---|
| NocoBase ACL 判定**分两级**，② 资源级无条目时**不是 deny**，而是回退 ① 策略 | 项目自己已在 `constants.ts` 的 `ROLE_NATIVE_READ_ACTIONS` 注释里取证过（DEV-65） |
| ① 策略层的资源门是 `strategyResources`；`null` 时**对任何资源成立** | 容器内 `@nocobase/acl/lib/acl.js:241`：`if (this.strategyResources === null \|\| this.strategyResources.has(resource))` |
| **`setStrategyResources()` 在这一版真实存在且确有消费点** | `acl.js:108` 定义；`:241` 消费。⚠️ 全仓唯一消费者就在 `acl.js` 内（其它包零引用）⇒ **可以，但只有这一条路** |
| 不在白名单时的行为是**明确 deny**（无二次回退） | `acl.js:240-253`：条件不成立 ⇒ `roleStrategyParams` 保持 undefined ⇒ 走到 `return null` |
| `root` **不受影响** | `acl.js:202` 在策略分支**之前**对 `role === 'root'` 提前返回 |
| 显式 `acl.allow()` 条目在策略分支**之前**判定 | 插件的 `svc:*`（`loggedIn`）与匿名 public 授权都是显式条目 |
| 四个业务角色的 strategy **确实不带 `resources`** | `seeds/roles.ts:130-132` `strategyOf()` 只返回 `{ actions: [...] }` |
| 项目**已经有一份原生只读资源白名单**，且 ② 资源级授权**已按它种好** | `constants.ts:1509` `NATIVE_READ_ALLOWLIST` = 4 张业务表 × `['list','get']`；`ROLE_NATIVE_READ_RESOURCES` 由它派生；`seeds/roles.ts:79` `resourceSeedsOf()` 逐资源授权 |
| 健康检查已在核对"角色 × 资源"授权行数 | `actions/public/health.ts:513` |

⇒ **修法形状**：调用 `acl.setStrategyResources(ROLE_NATIVE_READ_RESOURCES)`，
让 ① 策略层的资源范围与 ② 已经种好的那份白名单**变成同一份**。
这不是重新设计 ACL，而是把"本该一致的两级"接上（`constants.ts:1570` 已写明"两份清单迟早会漂移"）。

> ⚠️ **但有一个必须先实测的连带风险**：当前 `strategyResources === null` ⇒ **任何资源都放行**，
> 于是后台 UI 对**白名单之外**资源的原生读取依赖是**不可见的**，只在收紧后才暴露。
> 白名单目前**只含 4 张业务表**，而：
> - `stores`（门店下拉）**不在**白名单里 ⇒ 若后台列表的门店下拉走原生读取，收紧后**会 403**；
> - `users`（处理人姓名 / 派工对象）**不在**白名单里 ⇒ 同上。
>
> ⇒ P11-0 的正确顺序（**先测后改**）：
> 1. 以门店账号真实登录，**逐接口探测** + 检查列表/详情/派工下拉的渲染，列出"后台实际依赖的原生读取"；
> 2. 把**业务自有**资源（如 `stores`）纳入白名单；
> 3. **人事数据（`users`）不得加进白名单** —— 加进去等于 B-8 没关；
>    按契约 §16.1 改为**受控的最小业务接口**（如 `svc:staffOptions`，只回本门店可见范围的最小字段）；
> 4. 收紧后**复跑 Phase 2~9 全部门禁 + 一次真人后台走查**（backlog 已明确要求这一步，见 `docs/BACKLOG.md` B-8）。

#### ② 师傅 H5 展示客户姓名 / 完整手机号 —— **契约反转了一处既有"刻意设计"**

| 项 | 内容 |
|---|---|
| 契约要求（§14 / §3.5） | 师傅 H5 应展示：客户姓名、**完整手机号**、`tel:` 一键拨号、服务地址、报修正文、客户照片/语音/视频 |
| 当前源码事实 | `h5/src/pages/Technician/Visit.vue:72` / `:251` **刻意不渲染**客户姓名与手机号，注释写明理由：「师傅联系客户走门店，不由本页派号」 |
| 判定 | **不是契约无法成立**，而是**产品决策变更**（Phase 11 已明确选择"要给师傅完整联系方式"）。按契约 §0.1.4 执行，不重开产品决策 |
| 执行时必须同时落地契约 §33.2 的补偿控制 | 只有**当前有效** Visit Token；最小字段返回；改派/取消/转店**立即失效**；路径 Token 与完整手机号**不进日志**；媒体不产生永久公开 URL；`Cache-Control` 不允许长期公共缓存 |
| 附带影响 | 已核实：**没有**门禁断言强制"师傅 H5 不得展示客户手机号"（全仓只有 `Visit.vue:251` 一处**代码注释**）。⇒ 无需改门禁；但该注释与 Phase 11 实现将**直接相反**，P11-5 落地时必须**同步改掉注释**（本项目纪律：不留与实现相反的注释） |

### 1.3 Preflight 结论

- 契约与源码事实**总体一致**；未发现"契约无法成立"的项。
- 两项需特别处理：**B-8 的修法已取证到行号**（可修、范围可控、root 不受影响），
  但其**连带影响必须用真机先测**；**师傅 H5 客户信息**是产品决策变更，按契约执行并落实补偿控制。
- ⇒ **不触发 §0.1.5 的停止条件**，可按 P11-0 → P11-7 连续实施。

---

## §2 Slice 计划（契约 §31）

| Slice | 内容 | 状态 |
|---|---|---|
| **P11-0** | 门店工作流重构：取消受理 / 单一主动作矩阵 / 去原生噪音 / 转店·取消可用 / `first_response_at` 与 handler 口径 / `current_store_entered_at` / `remoteComplete` / 厂家 provider-only / **关闭 B-8** / 服务详情重组初版 | ⬜ 未开始 |
| P11-1 | 服务单模型升级：6 类服务类型 / 家电类型 / 地址 / 品牌型号 / 紧急 / 跟进记录 / `next_follow_at` / `progress_ref` / evidence hold / Visit 条件必填重构 / 迁移索引 ACL 白名单同步 | ⬜ |
| P11-2 | 门店人工新建（`＋新建服务单` / 保存并处理 / 先保存 / staff 来源 / 代传媒体 / 客户历史提示 / 幂等） | ⬜ |
| P11-3 | 历史数据中心（3 张新表 / `.xls + .xlsx` / Sheet / 映射 / 样本预览 / forward-fill / warning / 重复检测 / 导入报告 / 手工补录 / 一键转服务单） | ⬜ |
| P11-4 | 客户多媒体 H5 + 进度查询（upload session / 图片 1–3 / 语音 ≤60s / 视频 ≤30s / 进度 Token / 成功页 / 确认短信 / 弱网文案 / 隐私升级） | ⬜ |
| P11-5 | 师傅 H5 信息升级（姓名 / 完整手机号 / `tel:` / 地址 / 报修内容 / 媒体 / 不回归既有上传提交） | ⬜ |
| P11-6 | 门店 / HQ 管理 + 时效待办（售后首页双视角 / 门店管理 / 人员与门店权限 / 服务时效 5 类 / `serviceAlerts` / 超时与异常 / 通知联系人 / 复用 Dashboard-KPI） | ⬜ |
| P11-7 | 生命周期 + 真人 UAT（24h 未提交清理 / 180 天媒体清理 / evidence hold / 任务可观测 / 三类真人 UAT / 三浏览器 / Excel 真文件演练 / closure sweep） | ⬜ |

### 每 slice 的完成门槛（契约 §36）

不以断言数量为主，重点证明：工作流唯一入口 · 权限（B-8 真关不是藏 UI）· 多媒体安全 ·
匿名进度 Token · 提醒幂等 · 历史导入可重放 · **历史隔离不污染当前 KPI** ·
媒体清理（hold 不删）· 客户端动作矩阵 · **关键回归**（评价 / 师傅提交 / 门店确认 /
低分重开 / 收费不一致 / 短信回执**继续保持原冻结语义**）。

反向门验证"判据真的会红"，但**不为每个普通 UI 字段造重型 reverse gate**。

---

## §3 交付记录

### P11-0-k · TypeScript 静态检查门禁的**能力边界**（表述纪律，2026-10-09）

> ⚠️ **本节是为了防止把这条门禁说成"类型安全已通过"。**
> 用户 2026-10-09 明确要求：文档须写明它**当前只对 TS2304/TS2552 实施阻断**。

**门禁**：`node scripts/verify-types.mjs`
（配置 `nocobase/plugins/service-ticket/tsconfig.check.json`；宿主包声明见
`nocobase/plugins/service-ticket/types/ambient-stubs.d.ts`）

| 项 | 事实 |
|---|---|
| **判红判据** | **仅 TS2304 **（Cannot find name）** / TS2552**（Cannot find name, did you mean）⇒ 未声明标识符 |
| 为什么只锁这一类 | 这类**必然**在运行时变成 `ReferenceError` —— 正是"esbuild 构建绿、真机崩"的那一类（本轮已真实踩到两次：`SERVICE_MODE`、`ACL_FIELDS_AUTOFIX_ENV`） |
| 其它诊断 | **如实打印数量与前 5 条**，但**不判红**（当前约 101 条，属已知积压） |
| 为什么不一起判红 | 插件**不声明依赖、不带 `node_modules`**，`@nocobase/*` / `react` / `antd` 构建时被标为 **external**，由 stub 成 `any` ⇒ 会产生大量（TS2339/TS2307/TS2694…）**与本仓库代码质量无关**的噪音。全判红 ⇒ 这条门禁一天内就会被 `|| true` 掉，等于没有 |
| **明确不能声称的** | ❌「类型安全已通过」❌「类型检查全绿」❌「tsc 无错误」。**只能说**：「**未声明标识符为 0**」 |

**能力边界（如实记录）**：
- ✅ 能挡：漏 import 的常量 / 拼错的变量名 / 用了未声明的标识符（**运行时必崩**那一类）；
- ❌ 挡不住：与宿主包类型相关的错误（stub 掉了内部类型）、值层面的类型不匹配、
  null/undefined 收窄问题、以及那 101 条既有积压。

**遇到 TS2552 时的判别纪律**（写进 stub 文件里）：
先分清是「**代码真漏了 import**」还是「**门禁缺了一个全局声明**」
（实测踩到：`URL` / `Blob` / `AbortController` 因 `lib` 不含 DOM 而被报 TS2552，
而该码必须判红 ⇒ 会把**正常代码**判成"运行时必然 ReferenceError"）。
**不要为了让门禁变绿去改产品代码。**

**后续收敛既有积压**：那 101 条需要**单独排期**（补宿主包真实类型、或改用带完整依赖图的
容器内 tsc），**不属 P11-0 范围**，也不得被当作 P11-0 的完成条件。


### P11-0-a · 开工第一发现：**P10-B 的限流收紧把后台 SPA 打挂了**（2026-10-09）

> 这是本阶段最有价值的一条：**它证明了「所有门禁全绿」并不等于「后台能用」** ——
> 因为在此之前，**没有任何一支门禁用真浏览器加载过后台**。

| 项 | 内容 |
|---|---|
| 现象 | 真浏览器（headless Chrome + 真实门店账号）打开后台：登录页永远停在 `Loading...`；`/api/flowModels:findOne` 返回 **429**；页面显示 `应用错误 Request failed with status code 429` |
| 取证 | nginx 日志：`limiting requests, excess: 60.605 by zone "svc_general"`，被限的请求是 `/static/plugins/@nocobase/<plugin>/dist/client/index.js` 与 `flowModels:findOne` |
| 根因 | P10-B「每个反代 location 都显式限流」时，`/static/plugins/` 与 `location /` 用的都是 `svc_general`（**300r/m，burst=60**）。而**一次后台页面加载的真实规模**经实测是 **静态资源 171 个 + 业务接口 49 个** ⇒ burst=60 当场溢出 ⇒ 静态资源/接口 503·429 ⇒ SPA 起不来 |
| 为什么门禁没抓到 | 没有任何门禁**用真浏览器完整加载后台**。smoke 里那条「客户端 AMD 依赖可解析」只验**单个** bundle 可达，不验整页加载的请求规模 |
| 修法 | ① 新增 `svc_static` 档（`1200r/m` / burst `400`）承载静态资源，与业务接口**分桶**；② `svc_general` 按实测重新取值（`600r/m` / burst `400`）—— 它的旧值是按**门禁流量形态**定的，**从未按真实客户端校验过**；③ 两者都由 `scripts/expected-rate-limits.mjs` 钉住 |
| ⚠️ 没有做的事 | `svc_public` 的 `30r/m`（对客承诺）**一字未动**；也**没有**把任何 location 改成"不限流"（P10-B 的「每个反代 location 都显式限流」不变量保留） |
| 新增回归门 | `scripts/probe-store-ui-native-reads.mjs`：真浏览器 + 真登录 + 真渲染，断言「表格有数据 / 全程零 429 / 登录后控制台零错误」，并把**各限流区必须承载的真实规模**打出来 —— 这就是补掉"没有门禁加载过后台"那个缺口的东西 |
| 顺带修的一条 | `verify-config-falsegreen-reverse` 的反例 8 用 `.replace(/…/m)` **没有 `g`** ⇒ 我在 nginx.conf 新增一处 `expected-rate-limits.mjs` 引用后，"删指针"只删掉旧的、新的还在 ⇒ 反向门如实报"这条断言是假闸门"。**修的是验证器**（改 `gm`，覆盖缺陷的全部形态），不是产品 |

### P11-0-b · B-8 真机依赖清单（**推翻了朴素修法**）

取证工装：`scripts/probe-native-read-deps.mjs`（真实门店账号 + 真实 HTTP）
与 `scripts/probe-store-ui-native-reads.mjs`（真实浏览器抓 Network）。

**改前基线（资源级）**：核心集合仍可读 **3 个** —— `users`（返回 `email` / `phone` /
`nickname` 等列）、`roles`、`collections`；业务集合 **4/4** 可读；
对照资源 `storages` **403**、不存在的资源 **404**（⇒ 探针有效，不是恒绿）。

**UI 真实依赖（浏览器抓取，一次页面加载）**：`/api` 请求 **49 个**、静态资源 **171 个**，
去重后 **40 个** `resource:action`。其中包含一大批**平台资源**：`flowModels:findOne`、
`blockTemplates:list`、`desktopRoutes:listAccessible`、`uiSchemaTemplates:list`、
`themeConfig:list`、`pm:listEnabled`、`systemSettings:get`、`dataSources:listEnabled`、
`authenticators:publicList`、`auth:*`、`app:getInfo` 等。

🔴 **结论：朴素的「白名单只留 4 张业务表」修法是错的** —— 那样会让上述平台资源全线 403，
**整个后台直接不可用**。这正是「改前必须先做真机依赖清单」的价值所在。

同时命中的两个**敏感但被 UI 依赖**的动作（注意是 action 而不是 resource）：

| UI 依赖 | 说明 | 处理方向 |
|---|---|---|
| `roles:check` | SPA 每次加载都用它计算"我有哪些权限" | 它只回**当前用户自己**的权限，不泄露他人 ⇒ 以**显式窄授权**单独放行 |
| `collections:listMeta` | 渲染表格需要集合/字段元数据 | 需要；但**不得**放行 `collections:list`（整份集合定义直出）⇒ 只放 `listMeta` |

⇒ 收口形状（P11-0 下一步落地）：`strategyResources` = **UI 实测依赖的最小资源集**
（**排除** `users` / `roles` / `collections`）+ 对 `roles:check` / `collections:listMeta` 的
**显式窄授权**。`users` 一律不放开（含 `list`/`get`），人事资料按契约 §16.1 走受控最小业务接口。

### P11-0-c · 跨门禁污染：**当时的处置是重启**（⚠️ **已被 P11-0-f 取代**，保留原文以备追溯）

新探针故意触发 403/404 才能做有效性对照，而 NocoBase 的 error-handler 把 403 记成 **error 级**。
实测增量（用增量而非总数 —— `docker compose restart` **不清 `docker logs`**）：
API 资源探针 **+2** 条 error；浏览器探针 **+0**（干净）。
而 `smoke-test.mjs` 的「无 error 级别输出」窗口是"最近一次健康检查由失败转成功之后"（≈2.5 分钟）
⇒ 会被这 2 条打红。

⚠️ **没有给 smoke 加豁免** —— 契约 §0.2 明令「不允许为了全绿扩大豁免名单」。
改为**消除噪声源**：跑完探针后 `docker compose restart app` 再跑 smoke（重启把旧日志移出窗口），
并把这条顺序**打印在探针自己的输出里**（机器可见，不靠人记得）。

> 按 slice 追加。历史阶段原文不重写；新阶段已履行的条件用批注说明。

_（待 P11-0 起逐条追加）_

### P11-0-d · ACL 授权粒度取证（决定 B-8 的收口形状）

用户提出的关键问题：「**浏览器 Network 出现某 platform resource ≠ 整个 resource 可以加入
`strategyResources`**；先确认 `strategyResources` 对 action 的实际授权粒度。」—— 取证结论：

| 层 | 实现位置 | 粒度 | 证据 |
|---|---|---|---|
| ① 策略层 | `@nocobase/acl/lib/acl.js:241` 的 `strategyResources.has(resource)` | **资源级** | 只看资源名；不在白名单 ⇒ 直接 `return null`（deny） |
| ② 资源级授权 | `dataSourcesRolesResources` + `...Actions` | **`(role, resource, action)`** | 项目已在用（DEV-65 曾手工插 `(store_after_sales, serviceTickets, view)` 后 `roles:check` 键数 +1） |

🔴 **最关键的一条**：`acl-available-strategy.js:87` 的

```js
allow(resourceName, actionName) {
  return this.matchAction(this.acl.resolveActionAlias(actionName));
}
```

**完全忽略 `resourceName`**，只按 action 名匹配 ⇒ **某资源一旦进入 `strategyResources`，
该资源上"策略里列出的动作"全部放行**（对本项目四个角色 = `view`/`list`/`get`）。
⇒ **`strategyResources` 无法做 per-action 授权**，用户担心的"整个 resource 被一起放开"是成立的。

⇒ **收口形状（据此确定）**：

- **业务 collections** → 走 ①（`strategyResources`），配合既有字段白名单与 `storeScope`；
- **平台 UI 资源** → **一律走 ②**，按精确 `resource:action` 授权（不用 ①，避免整组放开）；
- `users` → **不加入任何一层**；人事资料按契约 §16.1 走受控最小业务接口；
- `stores` → 用 `svc:storeOptions`（用户明令：不把 stores 加进 `NATIVE_READ_ALLOWLIST`）。

### P11-0-e · 敏感动作的响应体最小性取证

用户要求：「对 `roles:check`、`collections:listMeta` 先实取响应体确认最小性，
并验证相邻非必需 read actions 仍拒绝。」工装：`scripts/probe-acl-minimality.mjs`。

| 动作 | 实测 | 最小性判定 |
|---|---|---|
| `roles:check` | 200 · **5827 B** · 只回**当前用户自己**的 `roles` / `strategy` / `actions`（含自身字段白名单）/ `snippets` / `availableActions` 等 14 个键 | ✅ **最小** —— 无他人账号、邮箱、手机号（`/email`、`/phone`、`@域名` 三种判据全部未命中） |
| `collections:listMeta` | 200 · **74314 B** · **14 个集合的完整字段结构**，**含 `users` 与 `roles` 的 schema**、`unavailableActions`、`dumpRules`、`model` 等 | ❌ **越界** —— SPA 只需要它渲染的那几张表的元数据，却拿到全库 schema |

⇒ 结论（改变了原计划）：

- `roles:check`：可以**显式窄授权**单独放行（它只回自己的权限，是客户端渲染权限的必要输入）。
- `collections:listMeta`：**不能整体放行**。但它被 SPA 直接调用，deny 会让**表格渲染不出来**。
  ⇒ 正解是**在插件中间件里对响应做范围收窄**（只保留业务集合的元数据），
  与既有 `native-export-guard` 同型 —— 既让 SPA 能渲染，又不把 `users`/`roles` 的 schema 递出去。
- 相邻非必需 read actions 的**改前现状**（改后必须拒绝）：
  `roles:list` **200** · `collections:list` **200** · `users:list` **200**。

### P11-0-f · 跨门禁污染：**改为 watermark，不再依赖 restart**（用户裁定）

用户明令：「probe → restart app → smoke **不得固化为正式方案**；改成日志 watermark /
精确测试窗口，使每个 gate 只审计自己产生的日志；不加宽错误豁免，也不依赖 restart 清场。」

落地：

- 新增 `scripts/lib/log-window.mjs`（watermark 的单一实现）。
- `smoke-test.mjs` 的错误断言改为**只审计本门禁 watermark 之后**的日志；
  "应用就绪推算窗口"降级为**仅打印的诊断**（出现争议时一眼看出该条 error 落在谁的窗口里）。
- 🔴 **毫秒精度**：第一版用 `--since <unix 秒>`，实测踩到**同一秒竞态** ——
  上一支探针恰在同一秒结束，它的 2 条 error 被下一支门禁算进窗口。
  改为 `--since <RFC3339 毫秒>` 后消除。
- 实测验证：**先制造污染（探针故意 403/404）→ 立刻跑 smoke（同秒边界、不重启）→ 124/124 全绿**。
- 探针里那句"跑完请 restart app"的提示已删除（它不再是必需步骤）。

### P11-0-g · 真浏览器冷启动回归门（永久纳入）

用户要求：「把真实浏览器冷启动永久纳入 P11-0 回归门：冷缓存登录、正常业务导航、
**双 Tab** 均须零 429；同时保留一个**真正超限会 429 的反向验证**；
**不要把当前 171/49 请求数写死成产品阈值**。」

`scripts/probe-store-ui-native-reads.mjs` 已按此扩展（每次运行用全新 `user-data-dir` ⇒ 冷缓存）：

| 断言 | 判据 |
|---|---|
| 冷缓存登录 + 列表渲染 | 表格 ≥1 且行 ≥1 |
| 全程零 429 | 采集 `/api/` 与 `/static/` 两类，全部无 429 |
| 业务导航 | **点行 → 详情面真的展开**（`.ant-drawer`/`.ant-modal`/`.ant-card` 出现），不是"点了一下" |
| **双 Tab 并发** | 第二个标签页也渲染出表格（多 Tab 共享同一限流桶，是"单 Tab 过、双 Tab 挂"的典型场景） |
| **反向验证** | 循环打同一个受限期（`svc_upload`）**直到出现 429**（上限 60 次，**不写死第几次**）⇒ 证明限流器是活的，而不是"零 429"另有原因 |
| 反向验证的副作用管理 | 打完后等待桶恢复再退出，并**断言等待后不再是 429**（不把 429 留给下一支门禁） |
| 规模 | **只打印**（本次 257 静态 / 74 业务接口，双 Tab 会翻倍）—— 明示"仅作参考，不是阈值" |

> ⚠️ 为什么"零 429"必须配一条反向验证：零 429 有两种达成方式 —— ①额度真的够；
> **②限流器根本没生效**。只测前者等于把"限流器坏了"判成通过。

### P11-0-h · 页面依赖的 collection 元数据实测（`collections:listMeta` 正向 allowlist 的输入）

用户锁死的第一条要求`collections:listMeta` 的收窄必须**正向允许 / fail-closed**
（不能是"返回全部再删掉 users/roles/collections"的黑名单 —— NocoBase 以后新增
`authenticators` / `apiKeys` 之类平台集合时会**再次泄漏**）。
⇒ 先实测「页面真正需要哪些 collection metadata」。工装：`scripts/probe-page-collections.mjs`。

**口径（可复算）**：① `collections` 表 = NocoBase 注册的全部逻辑集合名（= `listMeta` 的取值域）；
② 页面 schema 存在 **`flowModels`** 表（不在 `desktopRoutes.options`，第一版口径就是错的）；
③ 用 ① 的名字扫 ② 的 JSON 文本 ⇒ 页面真的引用了哪些集合；
④ 再把被引用集合的关联字段目标展开一层（关联目标在 `fields.options` JSON 里，
`fields` 表**没有** `target` 列 —— 第二版口径也是错的，两处都已在脚本注释里留痕）。

**实测结果（页面/区块模型引用）**

| 集合 | 出现次数 | 性质 |
|---|---|---|
| `serviceVisits` | 611 | 业务 |
| `serviceTickets` | 409 | 业务 |
| `ticketEvents` | 87 | 业务 |
| **`users`** | **79** | ⚠️ **平台** |
| `stores` | 43 | 业务 |

**被引用集合的关联目标（一层）**

```
serviceTickets.feedback_visit → serviceVisits
serviceTickets.handler        → users      ← 处理人（列表/详情必须显示）
serviceTickets.store          → stores
serviceVisits.reassigned_from → serviceVisits
serviceVisits.store_confirmer → users
serviceVisits.ticket          → serviceTickets
ticketEvents.operator_user    → users
ticketEvents.ticket           → serviceTickets
ticketEvents.visit            → serviceVisits
users.aiEmployees → aiEmployees    users.createdBy → users
users.roles       → roles          users.updatedBy → users
```

🔴 **关键结论（改变了收口方案的细节）**：业务 UI **真的需要 `users` 的元数据** ——
不是"顺手能看"，而是三条**业务关联字段**（处理人 / 门店确认人 / 事件操作人）的渲染需要它。
这与「`users` 不入任何读取边界」在**元数据 vs 数据**两个轴上是可调和的：
- **数据**（`users:list`）**绝不放开** —— 那才是 B-8 的暴露面（email/phone 全员可枚举）；
- **元数据**是否必须包含 `users`，**由实测决定**：先按 fail-closed 做（不含 users），
  跑真浏览器回归看"处理人"列是否还能渲染；**只有被真实渲染证明必需**，才补进去，
  且补的是**字段级收窄**（只留渲染所需字段，剥掉 email/phone/password* 等）。

顺带：`users.roles → roles` / `users.aiEmployees → aiEmployees` 这两条说明 ——
**若把 `users` 整体排除，就**不需要** `roles` / `aiEmployees` 的元数据**。
⇒ 排除一个平台集合会连带减少它对其它平台集合的依赖，这也是"正向允许"比"黑名单"更稳的原因之一。

### P11-0-i · 实现契约（用户 2026-10-09 锁死的四条，落地时逐条对照）

1. **`collections:listMeta` 收窄中间件**：正向 allowlist / fail-closed；未知集合默认移除；
   必须处理**嵌套 association metadata**（不能顶层删了 `users`、却在关联展开里又带回来）；
   过滤基于**解析后的 JSON 结构**，**禁止 regex / string replace**；
   `root` / `admin` **不经过**这层业务收窄；**业务 HQ_ADMIN ≠ NocoBase root/admin**。
2. **平台 UI 依赖**：业务 collection → `strategyResources`；平台 resource → **精确 `resource:action`**。
   门禁必须同时证明：`roles:check` **200** / `roles:list` **403** / `collections:listMeta` **200（已收窄）**
   / `collections:list` **403** / `users:list` **403**；每个新增显式 action 至少配一个
   **相邻 action 仍拒绝**的证据；代码旁维护最小的 `PLATFORM_UI_ACTION_ALLOWLIST`，**每项带一句业务理由**
   （避免半年后没人敢删）。
3. **429 反向门收紧**：开始前先证明**桶已恢复**；出现 429 时必须由 **Nginx 日志确认是目标 zone**，
   而不是应用层其它 429；恢复后**再次断言 2xx**。完整证据链：
   `起点 2xx → 高频请求 → nginx 日志 limiting requests … zone "xxx" → HTTP 429 → 等待恢复 → 再次 2xx`。
4. **health / plugin-load 的 ACL 检查**：匿名 live/health **保持冻结的最小响应**，
   **不暴露任何 ACL 清单**；认证态最多给布尔 `aclBoundary: ok/degraded`；
   精确 allowlist、一层/二层一致性、反向删除测试放在 `verify-plugin-load` / 专项 ACL gate。

### P11-0-j · ACL **真正收口**：三处机制级发现（2026-10-09）

用户批准"先 fail-closed → 真浏览器验证 → 只补被证明必要的最小部分"后进入收口。
过程中**三处原定做法被第一手证据否掉**，最终落在一个可用的形态上。

#### 发现 ①：`strategyResources` 在本版**不是可用的"默认拒绝"旋钮**

`@nocobase/plugin-acl/dist/server/server.js:610-618`：

```js
this.db.on("afterDefineCollection", async (collection) => {
  if (collection.options.loadedFromCollectionManager || collection.options.asStrategyResource) {
    this.app.acl.appendStrategyResource(collection.name);
  }
});
// afterUpdateCollection 同样处理；只有 afterRemoveCollection 才 remove
```

**框架自己会把"经集合管理器加载的集合"追加进 `strategyResources`** ⇒
我们 `setStrategyResources([4 个业务集合])` 刚设完就被撑大。
**实测**：设了 4 个业务集合、重启后 `users:list` / `roles:list` / `collections:list` **仍然 200**。

**而且它还会误伤**：`app` / `auth` 这类**不是 collection** 的资源不会被追加 ⇒ 失去策略回退
⇒ 连登录页的匿名请求都被拒（实测 `app:getLang → 401 EMPTY_TOKEN`、SPA 停在 Loading、
**后台根本打不开**）。⇒ 该调用**既拦不住、又误伤**，已**删除**并在原处留下这段反证说明
（避免后来人照着"看起来对"的思路加回去）。

#### 发现 ②：`acl.allow(resource, action, 'loggedIn')` 会**覆盖**已有的 public

`@nocobase/acl/lib/allow-manager.js:60-61`：

```js
actionMap.set(actionName, condition || true);   // actionMap 是 (resource → action → condition) 的 Map
```

⇒ **给同一个 (resource, action) 再补一个条件会覆盖前一个**。
我把框架**本就是 public** 的 `app:getLang` / `app:getInfo` / `pm:listEnabled` 补成 `loggedIn`
⇒ 它们被**静默改成"需要登录"** ⇒ 登录页 `app:getLang → 401 EMPTY_TOKEN`、**SPA 停住**。

⇒ 判据（写进常量注释）：**"当前缺不缺"由实测决定** —— 把清单清空跑一遍真浏览器，
`app:getLang` / `app:getInfo` / `pm:listEnabled` / `themeConfig:list` /
`systemSettings:get` / `authenticators:publicList` **仍然 200** ⇒ 它们本来就是 public，
**一律不列进清单**。

#### 发现 ③：resourcer 中间件里 `ctx.body` 是**数组本身**，不是 `{data: [...]}`

投影中间件第一版按 `{data: [...]}` 写 ⇒ `Array.isArray(body.data)` 恒 false
⇒ 走 fail-closed 分支把**数组摊成了对象**（`{"0":…,"1":…,"data":[]}`）
⇒ 前端拿到形状全错的响应，页面上报
「**字段 ticket_no 可能已被删除**」「**数据表 serviceTickets 可能已被删除**」。

诊断证据（临时日志，已删）：`before: isArray=true dataType=undefined | after: isArray=false`。
⇒ 修正：投影函数**两种形态都认**（数组 / `{data: 数组}`），并按**入参的形状**返回；
两者都不认时返回**同形空值**，绝不原样放行。
另外把"形状"也写进那条 info 日志（`形状 数组 → 数组`）—— 形状坏过一次，不打印就只能靠前端才发现。

#### 最终形态

| 件 | 作用 |
|---|---|
| `middleware/native-metadata-guard.ts` | **真正的边界**：中间件 + 解析后的能力名（`after: acl`），**清单之外默认 403**；`root`/`admin` 不受限；匿名不经它；`svc` 自守 |
| `constants.PLATFORM_UI_ACTION_ALLOWLIST` | 平台 UI 的**精确 `resource:action`**（14 项，**每项带业务理由**）；并显式记录"**刻意不列**"的三类及理由 |
| `middleware/collection-metadata-scope.ts` | `collections:listMeta` 的**结构化正向投影**：集合白名单 + 逐字段**递归**检查 association target；形状保持 |

#### 实测结果（真机）

**边界断言 `probe-native-read-deps --assert`：15/15 通过**

```
users 403 · roles 403 · collections 403 · storages 403 · attachments 403
serviceTickets 200 · serviceVisits 200 · ticketEvents 200 · smsLogs 200
不存在的资源 404（探针有效性对照）
admin 仍可读 users:list / roles:list / collections:list（平台维护不受影响）
```

**`collections:listMeta` 投影对照（`probe-listmeta-projection.mjs`）**

```
平台管理员 14 个集合（原始） → 业务角色 4 个（stores, serviceTickets, serviceVisits, ticketEvents）
被整体移除 10 个：roles, users, storeUsers, serviceVisitPhotos, smsLogs,
                  dailySequences, apiGuards, idempotencyRecords, serviceSettings, exportAudits
递归关联检查**精确丢掉 3 个字段**：serviceTickets.handler · serviceVisits.store_confirmer ·
                  ticketEvents.operator_user  ← 正是那三条指向 users 的
```

⇒ **`users` 的结构无法从字段 options 里被偷偷带回来** —— 这是用户点名要求验证的那一条。

**真浏览器回归门（ACL 收口后）**

```
✅ 冷缓存登录 + 列表真实渲染（表格 1 · 行 20）
✅ 业务导航（点行 → 详情面展开）
✅ 双 Tab 并发加载（第二标签页同样渲染出表格）
✅ 全程零 429
✅ 反向验证：第 22 次请求触发 429（svc_upload 限额生效）→ 等待恢复 → 不再是 429
✅ 控制台错误**分类核验**：1 条错误全部是 403，与本次 3 条 403 请求对应
   —— 被拒的是 `environmentVariables:list`（**刻意不放行**：该资源可能含真实密钥）
```

> ⚠️ 最后一条是**分类，不是豁免**：判据要求"每条被容忍的错误**恰好**是 403"、
> "本次**确有**对应 403 请求"、"**条数封顶**（错误数 ≤ 403 请求数）"。
> 任何非 403 的错误（JS 异常 / 500 / TypeError）照常红灯。

#### 仍未做（P11-0 后续）

- `svc:storeOptions`（门店下拉改走它）与 **HQ 人员/门店分配最小接口**（按用户要求：
  只回 用户 ID / 显示名称 / 当前业务角色 / 当前已负责门店，**手机号邮箱非必需则不返回**）。
- `users` 元数据**是否**补最小 projection：按用户批准的优先级 ——
  **只有在 Phase 11 最终保留的业务界面确实要展示"处理人/确认人/操作人"时才补**，
  且补的是**为关联渲染专门构造的最小 projection**，不是"原 schema 删几个字段"。
  当前旧页面那三列会缺；若只是**即将被 P11-0 删除的旧列**坏了，**不为它加回来**。
- 「新增依赖待审」长期门禁：断言"当前业务页面引用的 collection / association target
  必须是已知且被安全策略覆盖的集合"，未知则提示待审（**不把 611/409/87/79/43 写成常量**）。
- 匿名 health 的 `aclBoundary: ok/degraded` 布尔（精确一致性放 plugin-load / 专项 ACL gate）。

