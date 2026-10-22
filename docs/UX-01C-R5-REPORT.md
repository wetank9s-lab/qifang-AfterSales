# UX-01C 第五轮：服务时效「功能 + 安全闭环」交付报告

> 日期：2026-10-17 · 前序：`docs/UX-01C-R4-REPORT.md`
> 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · **UX-01C IN PROGRESS（服务时效已可用，等待验收裁决）**
> **本轮未提交、未推送。**

---

## 一、结论速览

`hq_admin` 现在能**真实打开并操作**「服务时效」：读到 3 个真实 SLA 参数、改动落到库、
审计留痕、范围错误有明确提示、并发冲突只允许一个成功、重启后配置与授权仍在。

| 门禁 | 结果 | 覆盖 |
|---|---|---|
| `verify-ux-01c-settings-auth.mjs` | **29 / 0** | 只读授权 + 行级收窄 + 对抗性 filter + 写入口 403/404 + 四角色隔离 |
| `verify-ux-01c-settings-ui.mjs` | **21 / 0** | 真实浏览器：打开 → 修改 → 保存 → 422 → 恢复 → 刷新 |
| `verify-ux-01c-settings-effect.mjs` | **17 / 0** | 阈值**被消费**（5→228 / 1440→216 / 120→216）+ 3 次重启后仍在 |
| `verify-ux-01c-pages.mjs` | **20 / 0** | hq_admin 全部 5 个后台页 + **侧边栏菜单点进**（含 1 条已知遗留的双向编码） |
| `verify-ux-01c-settings-conflict-ui.mjs` | **9 / 0** | 真浏览器：页面停在旧值 → 他人改值 → 保存 409 → **页面重读** |
| `verify-plugin-load.mjs` | **82 / 0** | 离线：21 张表 / 中间件 5 组 / 授权行数 / 迁移路径 |
| `probe-native-read-deps.mjs --assert` | **19 / 0** | B-8 边界：四个业务角色仍读不到平台元数据 |
| `verify-store-ui-primary-action.mjs` | **65 / 0** | UX-01A 门店工作台/主动作全量回归（本轮未回归） |
| `verify-acl-boundary-reverse.mjs` | **断开⇒7 红 / 还原⇒全绿** | 证明 B-8 那几条断言**真的在观测边界**（细节见 §六） |

⚠️ 本轮**发现并修掉一个会让整轮结论作废的实现缺陷**（见 §七 DEV-203），
另**发现一处非本轮引入的遗留**（见 §八）。两条都写在报告里，没有埋在代码注释里。

---

## 二、方案 A：只给 `hq_admin` 补必要授权（代码变更）

| 文件 | 变更 | 为什么必须这样 |
|---|---|---|
| `constants.ts` | 新增 `HQ_ADMIN_EXTRA_READ_RESOURCES = ['serviceSettings']` | **不**塞进全局 `NATIVE_READ_ALLOWLIST`（那份清单四个角色共用，会把门店账号一起放开） |
| `seeds/roles.ts` | `resourceSeedsOf(extras)`，仅 `hq_admin` 传 extras | 资源授权是**按角色存的行**；其余三个角色拿到的仍是 4 张业务表 |
| `middleware/native-metadata-guard.ts` | 新增 `roleScopedResources`（第 4 参 `roleNames`） | 守卫按**角色**放行，而不是按资源全局放行；缺省行为不变（既有调用方零改动） |
| `middleware/settings-read-scope.ts`（新） | `list/view` 注入 `key ∈ 3 个 SLA 键`（`$and` 合并）+ 字段白名单；`get` 逐行校验；**业务角色**的写动作一律 403（平台 `root`/`admin` 不经过本层，维护能力保持完整） | NocoBase 的资源级授权**没有行级维度**；只读 ≠ 能读整表 |
| `plugin.ts` | 挂载 `settings-read-scope`（`after: 'acl'`）+ 守卫传角色 + 启动期断言"额外资源不得与全局白名单重复" | 单点声明、启动即失败，避免"悄悄放宽成四个角色都能读" |

**授权落库实测**（`dataSourcesRolesResources`）：
```
hq_admin / serviceSettings / view · list · get   （3 行，8 列字段白名单）
其余三角色：仍只有 serviceTickets / serviceVisits / ticketEvents / smsLogs
```

### 行级边界（§二 要求"不能把 defaultFilter 当安全边界"）
| 请求 | 结果 |
|---|---|
| `list?pageSize=50` | 200 · **count=3**（仅 3 个 SLA 键） |
| `list?filter={"key":{"$eq":"sms.provider"}}` | 200 · **0 行**（不是覆盖 filter，而是 `$and` 叠加） |
| `list?filter={"key":{"$in":["security.ip_minute_limit"]}}` | 200 · **0 行** |
| `list?filter={"key":{"$ne":"sla.accept_minutes"}}` | 200 · **2 行**（取反也拿不到范围外的键） |
| `get?filterByTk=<sms.provider 的主键>` | **403** |
| `get?filterByTk=999999` | **403**（不给存在性信号） |
| `update / destroy / create`（主键 & filter 两种形态） | **全部 403**，且值、行数、审计条数**均未变** |
| `upsert` / `bulkUpdate` | **404**（端点不存在，"这条路压根没有门"；与"存在但被拒"是两件事） |
| `hq_after_sales` / `store_after_sales` / `viewer` → list | **403** |
| 平台 `admin` → list | 200 · count=26（维护能力未被误伤） |

---

## 三、真实浏览器全流程（hq_admin）

```
① 登录           uat.hqadmin@svc.local
② 点侧边栏菜单   「服务时效」→ /admin/orm5rz0ojnd（菜单项存在且可点，不是直接输 URL）
③ 页面值         sla.store_confirm_hours=48 / sla.appointment_overdue_grace_minutes=120 / sla.accept_minutes=120
④ 点「修改」     弹窗回显：单位分钟、范围 5~1440、当前值 120（规格来自服务端 listSettingSpecs）
⑤ 保存 121      库值 121 · 审计 +1（old=120 → new=121）· 页面即时回显 121
⑥ 输入 99999    提示：保存失败（422 SETTING_VALUE_INVALID）：「新工单首次受理时限」必须在 5 ~ 1440 分钟 之间（实际 99999）
                 库值仍 121 · 审计未增加
⑦ 恢复 120      库值 120 · 审计 +1（old=121 → new=120）
⑧ 刷新页面      仍显示 120（不是内存态）
```

> 菜单点击的坑：`li.ant-menu-item` 命中后 `click()` **不触发路由**（实测停在上一个页面），
> 必须点真正的 `<a href>`。这条写进了门禁注释 —— 否则"点了没跳转"会被误读成"菜单没权限"。

截图（`.tmp-verify/`，未入库）：`ux01c-page-loaded-*.png` / `ux01c-modal-open-*.png` /
`ux01c-after-save-*.png` / `ux01c-range-error-*.png` / `ux01c-restored-*.png`。

**`No permissions` 判据的收窄（重要）**：页面内容区已无该文案。但后台 SPA 每次加载都会向
`environmentVariables:list` 发一次请求并被 B-8 守卫拒绝（403）—— **门店账号同样触发**，
属平台级既有现象（详见 §八 第 2 条 / BACKLOG），不是本页的失败信号，也没有被塞进本页判据。

---

## 四、阈值**真的被使用**（不是"存进去了"）

消费点：`services/sla-scan-scheduler.ts:226` 的 `readInt('sla.accept_minutes')`。
每次改值后重启（启动期跑一次与 cron **同一条** `runSlaScan`），用 `slaScannedAt` 作基准
在 SQL 里按同一谓词对账：

| 阈值 | health `slaAcceptanceOverdue` | SQL 同口径 | 结论 |
|---|---|---|---|
| 120（基线） | 216 | 216 | 一致 |
| **5** | **228** | 228 | 变小阈值 ⇒ 计数变大 |
| **1440** | **216** | 216 | 变大阈值 ⇒ 计数变小 |
| 120（恢复） | 216 | 216 | 回到基线 |

重启三次后：配置值 = 120、审计 10 → 13 条（每次写入各一条，含 `scene=restore`）、
`hq_admin / serviceSettings` 授权行仍在、`list` 仍只回 3 个键。

---

## 五、并发 409（真并发，不是串行）

两个请求**各自带独立 `X-Request-Id`**、同一 `expected_value=120`、值分别为 121 / 122：

```
statuses = [200, 409]
codes    = [null, "CONFIG_CONFLICT"]
final    = "121"（胜出者的值）
restore  = true（随后以 121 为 expected 恢复 120，scene=restore）
```

若两个请求共用一个 `X-Request-Id`，服务端会按幂等回放，第二个**根本不会执行** ——
那样的"409 通过"是假绿。这一点写在 `scripts/lib/ux01c-conflict.mjs` 文件头。

### 页面侧的 409（§三.9「页面正确重新读取」）
单用户点一次保存不会产生 409，必须**两个主体**。实测流程：
页面停在 120 并打开编辑弹窗 → 另一个主体把库改成 121 → 页面保存 122：

```
① 提示：保存失败（409 CONFIG_CONFLICT）：该配置已被他人修改（当前「121」，你看到的是「120」），请刷新后重试
② 弹窗关闭（不让人对着过期值继续改）
③ 表格重读为 121
④ 库里仍是 121；本次的 122 没有落库
```

对应 `scripts/verify-ux-01c-settings-conflict-ui.mjs`（9 项）。这条行为是本轮**新增**的：
R4 的实现只弹错、不重读，用户会在一个已知过期的界面上反复重试。

---

## 六、变异测试（证明门禁**会**变红）

| 变异 | 结果 |
|---|---|
| 打掉 `mergeKeyFilter` 的范围条件 | auth 门禁 **20 / 7**（当时共 27 项）：`list` 返回 26 行，泄露 `sms.*` / `security.*` / `historical.*` |
| 把影响行数判定改回"恒 0" | UI 门禁 **10 / 1**：保存超时（复现 §七 的原缺陷形态） |

两次变异均已还原并重跑：auth **29/0**（补了 upsert/bulkUpdate 两条后）、UI **21/0**。

**B-8 守卫的反向验证**（`verify-acl-boundary-reverse.mjs`，已有装置）：
断开 `native-metadata-guard` 的 403 ⇒ `probe-native-read-deps --assert` **通过 12 / 失败 7**
（`users` / `roles` / `collections` 等平台资源变 200）⇒ 那几条断言确实在观测边界。
该脚本随后在"还原后重编译"一步异常退出（`build-plugin` 退出码非 0，本机偶发），
但**源码已逐字节还原（sha 一致）**、产物可能仍是被断开的版本 ⇒
本轮**手工重建 + 重启 + `--assert` 复验**，结果 **19/0**。
（⚠️ 这说明该脚本的 build 失败路径会留下"产物与源码不一致"的中间态，已记入记忆，后续应加兜底重建。）

---

## 七、本轮发现并修复的缺陷：`updateSetting` **恒 409**（DEV-203）

**现象**：`120 → 121`（`expected_value=120` **正确**）也返回
`409 CONFIG_CONFLICT / 该配置刚刚被他人修改`。也就是说：**受控写入从未成功过**。

**根因（容器内源码取证）**：`@nocobase/database/lib/repository.js:544-575` 的
`Repository.update()` 默认分支是 `find()` 出实例、逐个更新，**返回实例数组**，
不是 Sequelize 的 `[affectedCount]`。原实现 `Number(updated[0])` 恒为 `NaN` ⇒ 恒判冲突。
且 `repo.update({ filter })` 的 filter **只用于 SELECT**，真正的 UPDATE 是 `WHERE id = ?`
—— "把期望值压进 WHERE 让数据库裁决"在这条路径上**不成立**，并发下仍会双写。

**修复**：改用 `Model.update(values, { where: { key, value: oldValue } })` ——
条件真的进了 UPDATE 的 WHERE（Postgres 行锁裁决），返回 `[affectedCount]`。
并发实测见 §五。

**为什么上一轮会漏**：R4 只验证了"权限 403 / 白名单 422 / 范围 422"，**没有一条断言"正确值能保存成功"**。
这与 `docs/ENGINEERING-RULES.md` 的"断言不会变红 = 没有断言"同型 —— 只测拒绝对，测不出"该通的不通"。
本轮把"成功路径"写进了三道门禁（UI / effect / auth 的写入口 → 403 方向仍单独保留）。

---

## 八、发现但**本轮未修**（不扩大范围）

### 1. 「门店报修入口」页对 hq_admin 报「渲染失败」（**非本轮引入**）
- 证据：403 `GET /api/stores:list?...`；页面 Model 为 `TableBlockModel`。
- 根因：该页自 P11-1 起就是一张 `stores` 原生表格，而 `stores` **从未**被授予业务角色原生读
  （`ROLE_NATIVE_READ_RESOURCES` 只有 4 张工单相关表）⇒ 结构性 403，与本轮改动无关。
- 处理：按用户"门店管理继续 PENDING、不扩大范围"的要求，**本轮不改**；
  在 `verify-ux-01c-pages.mjs` 里把它写成 `knownIssue`（断言"失败形态**恰好**是 `stores:list` 403"），
  若换成别的错误、或将来修好了，门禁都会**变红**提醒更新。
- 建议（留给门店管理页）：给 `hq_admin` 追加 `stores` 只读 + 字段白名单（排除 `contact_phone`），
  或把该页改为自定义区块走 `svc` action（与"原生只读是例外"的架构一致）。

### 2. 平台级 `environmentVariables:list 403`
后台 SPA 初始化时对所有业务角色都会请求它；B-8 守卫按设计拒绝（环境变量含敏感配置，
不能放开）。表现是偶尔一闪而过的 "No permissions" toast。**门店账号同样触发**，
属平台既有现象，已记入 `docs/BACKLOG.md`（B 类）。

---

## 九、页面与既有功能回归

`hq_admin` 的 5 个 `flowPage`（取自 `rolesDesktopRoutes`，不是手抄）：
全量工单（20 行）/ 工单事件时间线（20 行）/ 派工记录（20 行）/ 服务时效（3 行）全部正常；
门店报修入口 = §八 的已知遗留（已双向编码）。

**UX-01A 门店侧全量回归**：`verify-store-ui-primary-action.mjs` **65 / 0**
（六个状态主动作、处理/跟进窗口、详情抽屉、工作台布局与分页、故障注入重试全部通过）。
> 第一次重跑曾因我在其运行中途重建并重启应用导致 1 项「登录超时」；干净环境重跑 65/0。
> 这条记录在此，是为了区分"产品坏了"与"验的人自己打断了环境"。

### 9.1 顺带修好的**门禁过期**（不是产品问题）
`verify-plugin-load.mjs` 在 R4 之后实际上是**红的**（16 项失败），原因有两类：
- **期望值写死**：`4 角色 × 4 资源 = 16` / `20 张表`。R4 新增 `configChangeAudits`（21 张表）、
  本轮又给 `hq_admin` 加了第 17 条资源授权 ⇒ 正确实现被"过期期望"判红。
- **清单没登记**：`configChangeAudits` 未进 `EXPECTED_COLLECTIONS` / `expected-indexes.mjs` /
  `smoke-test.mjs` 的表清单 / `docs/DATA-MODEL.md`。

修法：期望值改为**从 `ROLE_SEEDS` 逐角色求和**（与播种同源）、补四处登记、中间件分组点名加
`settings-read-scope`。结果 **82/0**。
⚠️ 这类"门禁自己过期"必须与"产品坏了"分开报 —— 它训练人忽略红灯，比没有断言更糟。

---

## 十、PENDING（本轮**未做**）

- 短信通知页、门店管理页（含 §八-1）、`serviceSettings` 旧描述幂等迁移、UX-01D 页面装修。
- UX-01B 遗留：媒体-only 真实提交（`DOM.setFileInputFiles`）、上传/提交失败恢复、真机软键盘、
  真实 iPhone Safari。
- 一致性缺口（非阻塞，择机）：`serviceVisits`/`ticketEvents` 的 `view` 与 `list` 字段数不一致
  （33 vs 31 / 14 vs 12），说明资源级 `fields` 漂移对齐没有覆盖到所有 action 行。

---

## 十一、Git 纪律

**未 commit、未 push**（遵守本轮指令）。新增/修改文件均在
`nocobase/plugins/service-ticket/src/**`、`scripts/**`、`docs/**`
（`scripts/_tmp-*.mjs` 为临时探针，已删除）。

---

## 十二、需要裁决

1. 「服务时效」是否 PASS（本报告只提交证据，不自判）。
2. §八-1 门店报修入口：并入"门店管理"页一起修，还是先单独立项。
3. §十 的一致性缺口是否作为 A 类并入本阶段（当前判断：B 类，不影响匿名闭环）。
