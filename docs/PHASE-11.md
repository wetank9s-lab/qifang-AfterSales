# Phase 11：产品化升级

> **产品契约**：[`docs/PHASE-11-REQUIREMENTS.md`](PHASE-11-REQUIREMENTS.md)（`P11-FROZEN-1`，2026-10-09）。
> 本文是该契约在本仓库内的**阶段文档**：开工前 preflight、实施计划、逐步交付记录。
> **产品范围已冻结**；本文不重新开放产品决策，只记录事实与落地方式。
>
> **本文件与契约冲突时以契约为准**；契约与**源码事实**冲突时，按契约 §0.1.5 / §40 回报而不擅自改产品。

---

## §0 冻结基线与纪律

### §0.1 当前状态（**用户 2026-10-10 正式裁决**）

| 项 | 状态 |
|---|---|
| **Phase 11** | **IN PROGRESS** |
| **Release** | **HOLD** |
| **P11-0** | ✅ **PASS**（用户 2026-10-10 正式裁决 · 提交 `788a21f`） |
| **P11-1** | **IN PROGRESS**（裁决当日开工，**无需再次审批**） |
| `788a21f` | P11-0 最终关闭提交（NEW 文案「待处理」+ 关闭报告） |
| `cd42b47` | ACCEPTED（B-15 服务端筛选 + 完整闭环验收 + DEV-108/109/110/111） |
| `fd2cbc6` | ACCEPTED（页面迁移阻塞解除 + 门店浏览器验收 28/28） |
| `dfecff5` / `e71f222` | ACCEPTED（P11-0 的前两个有效推进提交） |

#### 🔒 P11-0 正式冻结（用户 2026-10-10 裁决）

> P11-0 正式冻结，**不再重新开放**以下产品决策：
> **门店操作流程** · **单一主动作** · **取消受理** · **NEW 文案**（「待处理」）。
>
> 任何后续阶段若发现与上述决策冲突，按 §0.2「不停的条件」报告，**不得**自行改动。

#### P11-0 关闭时已闭合 / 交接

| 项 | 结论 |
|---|---|
| **B-15 状态 Tab 不筛状态** | ✅ 已闭合（服务端筛选，`verify-store-tab-filter` 38/38） |
| **NEW 状态文案** | ✅ 已闭合（方案 A：`待受理` → `待处理`，见 §P11-0-p） |
| **B-16** `pending` 短信无人重发 | → **P11-1 第一项**（裁决指定：先关它） |
| **`next_follow_at`** 无到期提醒能力 | → **P11-1 第二项** |
| 服务地址 / 家电分类 / 品牌型号 / 紧急标记 + 相关模型升级 | → **P11-1 后续项** |
| **HQ 全员管理** | → **P11-6** |

> **P11-1 的执行纪律（用户 2026-10-10 裁决）**：
> ① 所有迁移继续遵守 **NocoBase 三层一致性**：**数据库 DDL** + **数据库字段元数据**
>   （`fields.options`）+ **插件 collection 定义**，三者必须一起改（这是 DEV-112 与
>   `202610091-visit-fields-allow-null.ts` 两次实测得出的规矩）；
> ② **不得以"构建成功"或"测试断言数量"替代真实业务验收**；
> ③ P11-1 可**连续实施**；**只有遇到真实契约冲突才回来报告**。

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
| **P11-0** | 门店工作流重构：取消受理 / 单一主动作矩阵 / 去原生噪音 / 转店·取消可用 / `first_response_at` 与 handler 口径 / `current_store_entered_at` / `remoteComplete` / 厂家 provider-only / **关闭 B-8** / 服务详情重组初版 | 🟨 **进行中**（真实浏览器验收 28/28，见 §P11-0-l；**未签 PASS**） |
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

### P11-1-b · **`next_follow_at` 待办能力**（2026-10-10）

> 用户 2026-10-10 的 8 条要求逐条落地。验收 `scripts/verify-follow-up-todo.mjs` **19/19**，
> 全程**真实门店账号 + 真实业务动作**。

#### 字段与迁移：三层一致（要求 ①）

`service_tickets.next_follow_at`（`timestamptz NULL`，只到天，业务时区 `+08:00` 的
canonical 正午 —— 与 `expected_visit_at` **同一个** `parseAppointmentDate`）。

迁移 `202610101-next-follow-at.ts` 三层一起改，并**先断言行数再断言内容**：

| 层 | 改什么 | 自检判据 |
|---|---|---|
| ① DDL | `ALTER TABLE … ADD COLUMN IF NOT EXISTS` | `information_schema` 查到**恰好 1 行**，且类型必须是 `timestamp with time zone` |
| ② `fields.options` | upsert 元数据行（`ON CONFLICT (collectionName,name) DO UPDATE`） | 查到**恰好 1 行**、`allowNull=true`、`uiSchema.title` 非空 |
| ③ collection 定义 | `collections/serviceTickets.ts` | 供**全新安装**使用（对已存在的库不生效 —— 这正是要单独动 ② 的原因） |

🔴 **顺带修掉一个 P11-0 遗留的三层缺口**：`current_store_entered_at` 有 DDL、有 collection 定义，
但 **`fields` 元数据行不存在**（NocoBase 的同步**不会**为"迁移里 raw DDL 加的列"补元数据行）
⇒ 该列对 ORM/界面**根本不存在**，而"列在库里"会让人以为没问题。同一条 helper 一并补齐，
自检日志如实打印两个字段。

#### `followUp`：同事务 + append-only（要求 ②）

同一事务里：**写当前列** + **写一条 `follow_up` 事件**。事件 metadata 记三样东西：

```
next_follow_intent    本次意图（unchanged / clear / set）—— 让"没动它"与"清空了"可区分
next_follow_at        本次落库后的值（unchanged 时等于原值，语义上"仍是它"）
next_follow_previous  被覆盖的原值（排障第一个要看的就是它）
```

⇒ 「某天这条待办为什么变成这个日期」可以从时间线**完整重建**，而列上只剩最后一个值。
历史**只增不改**：每次都新建事件，绝不回写旧事件。

⚠️ `unchanged` 也照样走一次条件更新（写回同一个值）—— 这不是多此一举：
条件更新是**唯一**能发现"我读状态之后有人改了它"的地方，跳过它等于让并发写悄悄通过。
0 行 ⇒ 抛 409（整笔回滚，不留下"事件说改了、列其实没改"的半落账）。

#### 三态意图（要求 ③）

| 请求体 `next_follow_at` | 意图 | 为什么 |
|---|---|---|
| **字段不出现** | `unchanged` | 调用方没打算动它 |
| `null` | `clear` | **明确的**取消动作 |
| `''` / 纯空白 | `unchanged` | ⚠️「表单那一栏是空的」**不等于**「用户要取消」 |
| 非空字符串 | `set` | 设 / 改 |

规则实现为一个**纯函数** `resolveNextFollowIntent()`（可单测、只有这一处）；
判定"字段到底出没出现"用新的 `paramPresence()` —— 既有的 `param()` 会**刻意跳过**
`null` 与 `''`，用它就会把"未传"与"传 null"塌缩成同一件事（那正是"无意清除"的来源）。

界面同步：打开跟进窗口时记下**当时已有的日期**，于是能表达两种"空"
（本来就空 ⇒ 不传；原本有、现在清空 ⇒ 传 `null`）。只有"当前是否为空"的话，
**"取消计划"这个动作在界面上根本做不到**。

#### 状态迁移时清理待办（要求 ④）

统一的 `clearFollowUpTodo(ticketId, reason, transaction)`，挂到**六处**：

| 迁移 | 原因码 |
|---|---|
| 师傅提交 → 待门店确认 | `left_followable_stage` |
| 门店确认 → 待客户评价 | `left_followable_stage` |
| 转店 | `store_transferred`（新门店**重新决定**，不复用上一家的安排） |
| 低分评价 / 收费不一致重开 | `ticket_reopened`（上一轮计划已过期） |
| 超时自动关闭 | `ticket_closed` |
| 门店取消 | `ticket_cancelled` |

⚠️ 清空的原因写进**那次状态迁移自己的事件** metadata（`follow_up_cleared`），
**不新增事件类型** —— 清空永远发生在某次状态迁移里，单独成一条会让时间线多出一堆
"没有业务变化的记录"。幂等且不制造噪声：本来为空 ⇒ 不写库。

#### 待跟进队列（要求 ⑤⑦⑧）

新 action `svc:followUpQueue`（已登录即可，**只读**）：

- **storeScope 在服务端裁**：`permissions.applyScope()` 的产出直接进查询 WHERE；
  gate 里用"A 店账号看不到临时挂到 B 店的单、总部看得到"**真实核对**了这一点；
- **时区**：`today` 取 `canonicalizeAppointmentDate(now)`（与写入**同一个函数**），
  响应里回传它，调用方可以自证口径。gate 断言它必须是 `T04:00:00.000Z`（= +08:00 12:00）；
- **逐列白名单**：`maskTicketForActor()` 只掩手机号、**不剥** token hash / `extra_json`
  ⇒ 队列必须显式列字段（看起来只是一次列表查询的接口最容易漏这个）；
- **只读**：gate 前后比对事件数与短信行数，证明它不写任何东西
  （要求 ⑧：不另造第二套 SLA 扫描体系；完整超时/异常工作台留 P11-6）。

#### 需求 ⑥（真实门店账号端到端）在 gate 里的对应

新增日期 → 队列可查 → 再跟进改日期（原值留档）→ 传 `null` 取消 → 队列里消失 →
取消 / 转店 / 离开跟进阶段后都不再提醒。**19 项全过。**

#### 顺带记录的坑

| 坑 | 教训 |
|---|---|
| 迁移文件名 `20261010b-…` **违反 `^\d{8,14}-` 命名约定** ⇒ 构建在**预检**阶段就失败 | 同日第二个迁移用项目既有的 9 位技巧（`202610091-` → `202610101-`） |
| 我只看 `grep 构建成功` 而**没看退出码** ⇒ 把"预检失败"读成了成功 | 构建/门禁一律**以退出码为准**，grep 只用来取摘要 |
| `ticket_events.metadata` 实际列名是 **`metadata_json`** | 断言打错列名时，报错是 SQL 层的 —— 别去产品侧找原因 |
| `{ $ne: null }` 经 NocoBase 落到 SQL 是 `!= NULL` ⇒ **恒空**（谁都不要） | 「有值」的判据用 `$gt: epoch` 这类下界，不用 `$ne: null` |


### P11-1-a · **B-16 已关闭**：`pending` 孤儿的回收机制（2026-10-10）

> 用户裁决「先关闭 B-16：建立短信 outbox pending 恢复机制，**保证并发安全、重试可控、
> 失效 Token 不重发**，并针对**事务提交后进程退出**等故障窗口提供**真实验证**」。

#### 问题形状（为什么 Phase 8 的兜底够不着）

| 形态 | 谁管 |
|---|---|
| 发出去了、供应商拒绝了 | `SMS_RETRY`（每 5 分钟，捞 `send_status='error'`） |
| **压根没发出去**（事务提交后、`flush()` 之前进程退出 / 调用方漏调 flush） | 🔴 **原来没人管** —— 永远是 `pending`，既不进重试队列，健康检查也只统计终态 |

#### 机制（`sms-pending-recovery-scheduler` + `SmsService.recoverOrphanedPending` + `sms-orphan-resolver`）

1. **捞**：`send_status='pending'` 且**超龄**（`SMS_PENDING_ORPHAN_AFTER_MS = 5 分钟`）。
   ⚠️ 年龄条件是"**不抢正在发送中的行**"的唯一保障 —— 正在 flush 的那条**也是 pending**，
   只按状态抢就会给客户发第二遍。
2. **原子认领**：`SMS_RECLAIM_SQL`（条件更新 `pending + 年龄 + 次数上限`），让数据库裁决 ——
   与 Phase 8 的 `claimForRetry` 同一手法，全仓 `FOR UPDATE` 仍为 0。
3. **分诊**（fail-closed，两张表都在 `constants.ts`）：
   - `SMS_SCENE_ORPHAN_REBUILDABLE`（三个**不含凭据**的 scene）⇒ 校验业务状态后**重建并补发**；
   - `SMS_SCENE_ONE_TIME_CREDENTIAL`（`technician_task` / `review_invite`）⇒ **绝不重发**，
     转显式终态，并**区分原因**：凭据已失效 → `TOKEN_INVALID`；明文丢失 → `TOKEN_LOST`；
   - 未列入白名单者（含未知 scene）⇒ 一律不发（新增 scene 必须显式归类）。
4. **重试可控**：上限复用 `sms.retry_count`，**不新增旋钮**；认领即 +1，到顶自然停止。

#### 🔴 为什么含一次性凭据的 scene **连"重新签发"都不做**

`docs/PHASE-7.md` §8.3 已冻结该动作的形状：明文 Token 库内不存在（只有 sha256），
唯一正确做法是**重新签发**，但它**不得自动跑** ——「盲发意味着每次重启都可能重复发短信，
而客户对重复短信的容忍度是零」，既有实现因此是**默认 dry-run + 人工 `--apply`**。
⇒ 本机制只负责"**转成显式终态 + 说清原因**"，把"要不要重新签发"留给人工。
**这正是"失效 Token 不重发"落地成的可观测行为。**

#### 验收（`verify-sms-pending-recovery.mjs`，**21/21**）

**不用 sleep 猜时机，而是真的让进程在"提交后、flush 前"退出**（新增与 C23 **独立**的
注入开关 `smsCrashAfterCommit`，仍走 `svc:faultInject` 的"已登录 + 共享密钥"双闸）：

| 段 | 判据 | 结果 |
|---|---|---|
| A | 派工调用断开 · 库里留下 2 条 `pending` · 业务结果已生效 · **发件箱 0 条** | ✅ |
| B | 未超龄的 `pending` **不被认领**（否则会发第二遍） | ✅ |
| C | 客户通知**补发**（发件箱可见，且**载荷与正常路径逐字段一致**）· 师傅链接 `TOKEN_LOST` **不重发** | ✅ |
| D | 业务状态已变（`reassign` 真改派）⇒ 都**不补发**：`STALE` / `TOKEN_INVALID` | ✅ |
| E | 两轮**同时**跑 ⇒ 每条只发一次 · 再跑一轮幂等 · 无密钥访问诊断闸 404 | ✅ |

**变异测试**：去掉年龄守卫（两条 SQL 同时去掉，避免只证"另一条腿还在"）⇒
「未超龄的 pending 不被认领」**判红**（本单 pending 行 2 → 0）；还原后 21/21 复绿。

#### 顺带修掉的**真缺陷**（都由这轮验收亲手抓出，见 DEVIATIONS）

| 编号 | 一句话 |
|---|---|
| **DEV-115** | 我自己的实现里两处错：① 调度器把函数当对象调 `.resolve()`（安全网兜住了，但"可重建的那一半"永远补发不出去）；② 重建 `store` 用了只有门店名的那个函数，比正常路径少了 `(S01)` —— **靠"载荷逐字段比对"抓出来的** |
| **DEV-116** | `verify-store-close-loop` ⑤ 会**消耗掉自己的前置数据** ⇒ 只能通过一次；改为自建夹具 |
| — | `tasksRegistered` 忘了登记新任务（`smoke-test` 当场判红）；模块级 catch 把**应用关闭**记成 error（污染 smoke 的日志闸）；tab-filter 用"总条数"当指纹在**空 Tab** 上永不成立 |

#### 回归（本轮实跑）

`smoke-test` **124/124** · `verify-store-close-loop` **27/27** · `verify-store-tab-filter` **37/37** ·
`verify-store-ui-primary-action` **30/30** · `verify-sms-pending-recovery` **21/21** ·
`verify-review-loop` **126/126** · `verify-ticket-actions` **12/12** · `verify-types` ✅


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

---

### P11-0-l · 页面迁移阻塞的两个根因 + 真实门店账号浏览器验收（2026-10-09）

用户上一轮判 `1ea7b33` **只作为开发过程提交接受、产品验收不通过**（状态 REWORK REQUIRED），
并要求「**下一轮只处理这次页面迁移阻塞，并完成真实浏览器验收**」。
本轮按这九条交付，记录如下。

#### 1. 阻塞一：`flowSurfaces:applyBlueprint` HTTP **400** —— 结构化响应体定位到确切字段

| 项 | 内容 |
|---|---|
| 结构化响应体 | `{"errors":[{"code":"VALIDATION_ERROR","message":"…default-field-groups-incomplete…"}]}` |
| 确切 validation failure | `FIELD_GROUPS.serviceTickets` 的 `ticket-timing` 分组**没有覆盖** `current_store_entered_at` —— 而该列是本阶段自己新增的（转店交接语义，契约 §5.4） |
| 修法 | 把 `current_store_entered_at` 补进 `ticket-timing`（**策展式补进**，不是把字段组改成"全部字段"） |
| 为什么没有绕过 | 用户明令"不要绕过框架 authoring validation"。放宽 `fieldGroups` 的做法会让**下一次新增列再次静默漏掉**，等于把校验关掉 |

#### 2. 阻塞二：修完 400 后冒出 HTTP **409** `declared key 'svc.detail' is duplicated`

| 项 | 内容 |
|---|---|
| 根因 | `actionRow()` 生成的 `declaredKey` 是**按动作**的常量 `svc.<动作key>`，而 7 张工单表 × 5 个动作 ⇒ **30 个重名 key** ⇒ authoring 校验判重复 |
| 为什么 400 时看不见 | 校验**短路**：`fieldGroups` 的 400 先返回，key 唯一性检查压根没跑到 |
| 修法 | `declaredKey` 改为 **`svc.<操作列uid>.<动作key>`**（`declaredKeyOf(tableUid, modelKey)`），天然按表唯一 |
| 部分写入状态的处理（用户要求"seed 可安全重试"） | 新增 `purgeSeedManagedActionRows(token)`：**在 applyBlueprint 之前**跑，用受支持的 `flowSurfaces:removeNode` 精确删除本 seed 管过的动作行，删完**回读断言 0/0**（非 0 则硬失败）。<br>它解决的是一个死锁：不清 ⇒ 页面建不起来 ⇒ 挂不上 ⇒ reconcile 永远跑不到。<br>⚠️ **没有**删整张 `flowModels` 表、也没有动任何无关页面配置。 |

#### 3. 按钮墙的**最后一块**：原生 查看/编辑/删除

每一版 `applyBlueprint` 都会被 `default-block-actions.js` **自动注入** `ViewActionModel` /
`EditActionModel` / `DeleteActionModel`，且**无法用 blueprint 去掉**（DEV-53 坑 2）。
browser 里表现为**一行两个按钮**（原生 查看 + 主动作）。

| 项 | 内容 |
|---|---|
| 修法 | 新增 `purgeNativeRowActions(token, liveBlocks)`：**在 applyBlueprint 之后**跑，只删"工单表操作列下"的这三类，删完**回读 `left === 0`** |
| 结果 | 21 行 → **0** |
| 新断言 | `verify-ticket-actions.mjs` 第 12 条「工单表操作列**没有**原生 查看/编辑/删除」—— **先红了**（21 行）再转绿，不是补一条恒绿的断言 |

#### 4. 动态标签：从**框架源码**取证，否掉了一条建议路线

用户建议"若现有稳定 `useProps` 能解决动态渲染，可优先使用"。取证结果（读 `dist/client/assets/index-93181bbb.js`）：

| 主张 | 源码事实 |
|---|---|
| **`useProps` 不是 2.2.15 的 FlowModel hook** | 10 处命中**全部**在 field-component / UI-Schema 代码里（`Rz = ({useProps = ()=>({}), ...rest}) => ({...rest, ...useProps()})`），与 FlowModel 无关 ⇒ **该路线不可用** |
| 覆写 `render()` 是框架契约，不是 hack | `FlowModelRenderer` 经 **`model.render()`** 渲染；缺失时它自己 warn `"FlowModelRenderer: Invalid model or render method not found."` |
| 标签来源 | `ActionModel.renderButton()` 的 label = `props.children \|\| this.getTitle()` ⇒ 必须**不要**把 `children` 写进 `defaultProps`，改为覆写 `getTitle()` |
| 行数据 / 刷新 | `getInputArgs()` 用 **`this.context.record`**；刷新用 `this.context.blockModel?.refresh?.()` |

⇒ 固定标签 fallback **已删除**（用户明令"固定标签 fallback 不能通过正式 UX 验收"），
标签全部由 `getTitle()` 按 `this.context.record` 的状态动态给出。

#### 5. 两个**只有真实浏览器才暴露**的运行期错误（esbuild 不做类型检查 ⇒ 构建恒绿）

| 错误 | 根因 |
|---|---|
| 抽屉标题 `工单 #undefined 加载失败 … request is not a function` | `openTicketDrawer(request, ticketId, {...})` 用了位置参数，实际签名是 `openTicketDrawer({ ticketId, request })` |
| 五种选择**点了全部没反应** | `sendSvcRequest(request, url, body, headers)` 用了位置参数 ⇒ `params.action` 为 `undefined` ⇒ 实际请求 `svc:undefined?filterByTk=undefined`。正确签名是 `sendSvcRequest(request, { action, ticketId, body, requestId })` |

⇒ 顺带把客户端可调用的 `svc:*` 动作名抽成唯一事实来源 **`src/shared/svc-action.ts`**，
`constants.ts` 的六个动作名改为从它派生 —— 结束"客户端抄一遍、服务端抄一遍"的漂移来源。

#### 6. 本轮修掉的两个真实缺陷（已登记）

- **DEV-104**：`voidActiveVisit` 无条件给 `technician_mobile` 发「派工取消」短信 ⇒
  **provider-only（厂家/第三方）派工一作废就 HTTP 500**，直接阻断「电话/门店直接解决」。
  修法：新赠 `enqueueAssignmentCancelled()` 作为唯一入口，用**与下游同一个** `isMobile()` 判定；
  顺带修了**同源第二处**改派路径（`cancelledTechnician.mobile`）—— 它一次都没被线上触发，不是不存在。
- **DEV-105**：「从发件箱取评价 Token」的判据读了 **三个不存在的字段**
  （`content/body/text`，实际是 `preview` 与 `params.link`）⇒ 断言**永远绿不了**，
  而失败文案长得像"产品没发短信"。判据抽成 `scripts/lib/review-token.mjs` 唯一实现 +
  `verify-outbox-review-token-selftest.mjs` **双向 fixture**（含当天真实抓包样本 + 旧判据变异对照）。

#### 7. 交付证据

| 证据项（用户点名要的） | 结果 |
|---|---|
| 400 的根因与修法 | `current_store_entered_at` 未进 `ticket-timing` 字段组 → 策展式补进 |
| seed **重复执行**结果 | 连跑 **3 次**：每次 4/4 页面应用通过、旧按钮墙残留 **0 行**、角色菜单新增/撤除 **0 条**；seed 后 `verify-ticket-actions` **12/12** |
| 持久化页面里**旧动作为零** | `flowModels` 1449 条 / 工单表 7 张：受禁 5 类旧动作 **0 行**、原生行内动作 **0 行**、孤儿 **0**、病态行 **0**；主动作 **7 行**（= 7 × 1） |
| **真实门店账号**的浏览器操作结果 | `uat.store.a@svc.local`，**28/28 全绿**（见下） |
| 反向验证 | `verify-ticket-actions --reverse`：删一条 `TicketPrimaryActionModel` → 断言**确实变红** → 还原后 `use` 与 `parentId` 均与删除前一致 |
| 常设回归 | `verify-types` 未声明标识符 **0** · `verify-bundle-delivery` 产物与构建一致 · `smoke-test` **124/124** |

**真实浏览器 28 项**（`scripts/verify-store-ui-primary-action.mjs`；页面 seed 重建后**又跑了一遍**，仍 28/28）：

```
① 每行操作列**总共**只有一个按钮（20 行全部为 1），且都不是 CSS 隐藏
   界面上不存在受理/派工/改派/改约/详情/编辑/删除
② 六个状态标签逐行交叉核对（扫 7 页 / 128 行）：
   NEW→处理 · PROCESSING→跟进 · WAIT_STORE_CONFIRM→审核结果
   WAIT_FEEDBACK→查看 · CLOSED→查看 · CANCELLED→查看   ← 六个全覆盖
③ 点击作用于当前行（抽屉工单号 == 该行工单号）
④ 「处理」窗口给出五种选择，且客户取消 / 电话解决都真的写库
⑤ 「跟进」真的写入 follow_up 事件
⑥ 「审核结果」打开的是本行的服务详情
⑦ 0 个 429（72 个 /api 请求全核）· 无一直 loading · 无可解释的控制台错误
补充：真实客户评价把工单推进到 CLOSED（工单 #4055 → CLOSED）
      sms.enabled 临时改 true 后**已还原并回验**（现值 false）
```

#### 8. 本轮**没有**顺手做的事（按用户 B 类分诊规则）

- **状态 Tab 不筛状态**（切六个 Tab 时 `serviceTickets:list` **不带任何 filter**，六个 Tab 是同一批 20 行；
  `smoke-test` 那条断言只核库里的 `props.defaultFilterValue`，于是"配置在"被当成"筛选生效"）。
  已登记 **B-15**（`docs/BACKLOG.md`）。⚠️ 本轮验收脚本**不依赖** Tab 挑状态（改为按库里状态在分页中定位），
  因此"脚本通过"**不能**读成"Tab 筛选已修复"。
- HQ 全员管理（P11-6）、总部看板（B-14）等一律未动。

> ⚠️ **P11-0 仍为 IN PROGRESS**：本轮交付的是"页面迁移阻塞已解除 + 真实浏览器验收通过"，
> 是否 PASS 由用户裁决；本文不代签。

---

### P11-0-m · B-15 修复：状态 Tab 的**服务端筛选**（2026-10-10）

用户把 B-15（状态 Tab 只改标题、不筛工单）升级为 **P11-0 必修项，不允许延期**，
并要求「**必须实现服务端筛选**…不能仅在当前 20 行做前端过滤…用真实门店账号及混合状态数据验证」。

#### 1. 根因（读容器内客户端产物取证，不是猜）

| 事实 | 证据 |
|---|---|
| 默认筛选**早就正确落库** | `flowModels` 里 `FilterActionModel` 的 `props.defaultFilterValue` = `status $eq PROCESSING` + 两条恒真 |
| 但**从不在加载时应用** | `filterSettings.defaultFilter` 步骤只有 `setProps("defaultFilterValue", …)` + `setProps("filterValue", …)` —— **没有 `addFilterGroup`** |
| 真正并进请求的只有事件 | `submitSettings`（on:"submit"）、`resetSettings`（on:"reset"）—— 即用户点「确定」或「重置」那一刻 |
| 区块级 `props.defaultFilter` 是死路 | flow-engine 客户端里 **0 处引用** |

⇒ **2.2.15 会把默认筛选持久化，但不会在打开页面时应用它。**

#### 2. 修法：只补"加载时应用"那一环

`TicketTabFilterModel`（`src/client/tab-filter.tsx`）—— **行为载体，不是按钮**
（`render()` 返回 `null`，界面上不多出任何控件）：在 `onInit`/`onMount` 调
`resource.addFilterGroup()`，与用户点「确定」走的是**同一条通道** ⇒ 筛选**随请求下到服务端**，
由服务端完成过滤 / 计数 / 分页。

关键设计：**seed 不解释筛选**。`seed-admin-pages.mjs` 只把区块自己持久化的
`defaultFilterValue` 原样搬进节点（`tabFilterRow()`），解释只存在于客户端
`toRequestFilter()` 一处 —— 避免"同一段解析逻辑出现两条腿"。
副作用是「全部 / 全量工单」天然不筛（它们的骨架项没有 `value`），不需要维护第二份状态映射。

挂载点 = **TableBlock 的 `actions`**（不是行操作列）：挂到操作列会**每行实例化一次**（20 行 = 20 次）。

#### 3. 两个实测出来的坑（都钉进了双向 fixture）

1. **服务端不认 `{logic,items}` 原组形态** —— 直接打 `serviceTickets:list` 实测：
   原组 ⇒ **500 `Invalid value`**；点号键 `{"status.$eq":"NEW"}` / 嵌套 `{status:{…}}` ⇒ 均 **200**。
   （框架自己有传 FilterGroup 实例的调用点，是因为 `addFilterGroup` 内部会 `toJSON()`；
   我们传普通对象 ⇒ `instanceof` 不成立 ⇒ 不被转 ⇒ 500。）
   ⇒ 这里"原样透传"恰恰是错的：**少一步转换 = 每个 Tab 都 500**。
2. **无 `value` 的项必须丢弃**：补默认值会变成 `{"status.$eq":true}` ⇒ **"全部"Tab 变空表**。

#### 4. 验收（真实门店账号 `uat.store.a@svc.local` + 真实浏览器，`verify-store-tab-filter.mjs` **30 项全过**）

| Tab | 请求里的筛选 | 服务端 count | 库里真值 | 返回记录 | 分页总数 |
|---|---|---|---|---|---|
| 全部 | **无**（按设计不筛） | 128 | 128 | 混合 6 种状态 | 总共 128 条 |
| 待受理 | `status.$eq NEW` | 42 | 42 | 20 行全 NEW | 总共 42 条 |
| 处理中 | `status.$eq PROCESSING` | 57 | 57 | 20 行全 PROCESSING | 总共 57 条 |
| 待门店确认 | `status.$eq WAIT_STORE_CONFIRM` | 5 | 5 | 5 行全该状态 | 总共 5 条 |
| 待客户评价 | `status.$eq WAIT_FEEDBACK` | 17 | 17 | 17 行全该状态 | 总共 17 条 |
| 已闭环 | `status.$eq CLOSED` | 2 | 2 | 2 行全 CLOSED | 总共 2 条 |

- **10/10 组**状态 Tab 的首屏记录集合互不相同；「全部」与任一状态 Tab 也不同。
- **翻页**：「处理中」第 2 页 20 行仍全是 PROCESSING，与第 1 页**无重叠**（前端过滤必在此露馅）。
- **跨店不可见**：每一个 Tab 里 `store_id ≠ 1` 的行数均为 **0**。
- **模型确实跑了**：5 条客户端自证日志（每个状态 Tab 一条，`phase=onInit`），
  用于区分"筛选生效"与"筛选压根没跑"（两者界面表现同形）。

#### 5. 顺带修掉一个**真**缺陷：多余的 `refresh()` 触发 429

`onInit` 挂上筛选 → 数据回来 → `onMount` 再跑一遍发现 `getData()` 非空 ⇒ 又 `refresh()`
⇒ **每个 Tab 白搭一次请求**，叠上首屏请求后撞限流，429 又让下一个 Tab 取不到数
（实测「待客户评价」因此 0 行）。加**筛选签名守卫**（筛选没变就不再刷新）后：
本轮 **60 个 /api 请求、429 = 0**。详见 `docs/DEVIATIONS.md` **DEV-107**。

#### 6. 变异测试（证明验收器有牙）

把 `toRequestFilter()` 回退成 bug 版 ⇒ fixture **红 4 条**（含真实库回喂那条）；
还原后 sha256 与变异前一致（`5fae57564990b42c`），14/14 复绿。

---

### P11-0-n · `followUp` 的"下次跟进日期"：**当前不更新任何待办字段**（交接 P11-1）

用户要求核对「`followUp` 的下次跟进日期是否已经真正更新当前待办字段 `next_follow_at`」。

**结论：没有。** 逐层取证：

| 层 | 事实 |
|---|---|
| 数据库 | `service_tickets` **没有** `next_follow_at` 列（`\d service_tickets` 里不存在） |
| 服务端 | `ticket-service.ts` 的 `followUp()` 把它写进 **`ticketEvents.metadata.next_follow_at`**（时间线留档），**不写工单** |
| 代码注释 | 原实现已写明「`next_follow_at` 随记录一起留档；**可查询的工单列**在 P11-1 随模型升级补」 |

⇒ 因此**当前不具备任何"到期提醒"能力**（没有可查询的待办字段，就没有可扫描的到期集合）。

**已按用户要求做的两件事**：

1. **界面不再可能误称**：跟进窗口的日期占位文案原为「下次跟进日期（选填）」，
   现已改为「**下次跟进日期（选填，随跟进记录留档）**」—— 既不说有提醒，也不让人白填。
   （原本也**没有**写过"到期提醒"字样，此改动是消除"填了却不知去向"的歧义。）
2. **显式交接 P11-1**：`§2` 的 P11-1 条目里本就含 `next_follow_at`。落地时必须同时处理：
   - 迁移新增 `service_tickets.next_follow_at` 列 + 索引；
   - **`collections` 白名单 / 敏感列契约同步**（`expected-sensitive-columns.mjs`）；
   - `followUp()` 改为**同时**写工单列（时间线留档保留，不删）；
   - 有了可查询列之后，才谈得上 P11-6 的「时效待办」去扫它。

⚠️ **在 P11-1 完成前，任何"跟进到期提醒"的表述都不成立**，不应写进交付说明或走查清单。

> ✅ **已由 §P11-1-b 关闭（2026-10-10）**：工单表已新增可查询的 `next_follow_at` 列，
> `followUp` 在同一事务里写它 + 一条 append-only 事件，另有只读的
> `svc:followUpQueue` 按授权范围返回"今日待跟进 / 已逾期"。上面列的四件事（迁移 + 白名单
> 同步 + 写工单列 + 可查询列）**都已落地**。
>
> ⚠️ 但表述纪律仍然适用，只是边界变了：现在可以说「**填写后可在待跟进队列中查到**」，
> **仍然不能**说"会提醒你" —— 契约里**没有**后台推送、没有到期告警，
> 完整的超时与异常工作台在 **P11-6**。

---

### P11-0-o · 完整闭环真实浏览器验收：**抓出两个真缺陷 + 一个共享夹具缺陷**（2026-10-10）

用户第三优先级要求补一条链路：师傅提交 → `WAIT_STORE_CONFIRM` → 门店点「审核结果」→
`WAIT_FEEDBACK` → 客户评价 → `CLOSED`，并核对 按钮 / 状态 / 收费 / 审计 四者一致。

#### 验收器（`scripts/verify-store-close-loop.mjs`，**26 项全过**）

链路除"读发件箱取 Token"外**没有任何一步绕过业务**：匿名建单 → 门店派工 →
从真实短信取师傅 Token → 师傅传照片并提交（含收费 88.00）→ **浏览器**里门店操作 →
客户点评价链接匿名提交。

| 段 | 关键判据 | 结果 |
|---|---|---|
| ① 师傅侧 | NEW 直接派工（无"受理"）、Token 43 位、上传入库、提交后 `WAIT_STORE_CONFIRM`、报费落 Visit | ✅ |
| ② 门店审核 | 新单**只**出现在「待门店确认」Tab（顺带复验 B-15）、主动作标签=「审核结果」、确认服务模态框**金额预填 88**、确认后抽屉里确认按钮消失（按钮与状态一致）、`WAIT_FEEDBACK`、确认金额/确认人一致 | ✅ |
| ③ 客户评价 | **`sms_logs.send_status=accepted`**（DEV-108 的回归判据）→ 取 Token → 评价 → `CLOSED`（rating/review_status/reviewed_at） | ✅ |
| ④ 审计 | `dispatched → technician_submitted → store_confirmed → reviewed`（事件名**从服务端 `EVENT_TYPE` 常量导入**，不手写第二份） | ✅ |
| ⑤ 冲突提示 | 抽屉开着时别人先确认 ⇒ 中文提示"已被其他人员处理，已刷新最新状态"，**不含原始码** | ✅ |
| ⑥ 校验提示 | 跟进不填内容 ⇒ 中文"必须填写跟进情况"，且**确实拦住了写入**（`follow_up` 事件数不变） | ✅ |

#### 抓出的三个缺陷

| 编号 | 类别 | 一句话 | 现状 |
|---|---|---|---|
| **DEV-108** | **产品** | 门店确认后评价邀请短信**从未投递**（`outcome.pending` 恒为 undefined，`flush()` 一次没跑过）⇒ 客户拿不到评价链接，闭环断在最后一步 | 已修，判据钉在 `send_status` |
| **DEV-109** | **产品** | 冲突场景员工看到 `…无法确认（TICKET_NOT_REVIEWABLE）` —— 客户端码表只有 4 个、服务端会抛 11 个；处理/跟进窗口连码表都没有 | 已修：按 **HTTP 409** 判定，三处界面共用 `shared/user-error.ts` |
| **DEV-110** | **夹具** | `technician-harness.mjs` 把 https 协议配到 HTTP 端口（8080）⇒ 14 支脚本基址全坏、断言从未被执行过 | 已修：以 `SVC_BASE_URL` 为唯一来源 |

三个都做了变异测试：回退成缺陷形态 ⇒ 验收器判红；还原后 sha256 逐字节一致、26/26 复绿。

#### 一条值得单列的教训

DEV-108 之所以长期没人发现，不是"没有短信门禁"，而是**每条发短信的路径都需要自己的断言**：
既有的 126 项评价门禁走的是 `remoteComplete` 那条 `enqueue`（写法正确），
于是"评价短信能发"被证过很多次，而"门店点确认"这条路径**从未被断言过**。

---

### P11-0-p · **方案 A 已批准并落地**：NEW 的界面文案统一为「待处理」

**用户 2026-10-10 正式裁决**：所有当前业务界面的 `NEW` 状态统一显示为「待处理」，
不再出现「待受理」。（此前登记的三个方案里选 A；B / C 不再讨论。）

裁决前的冲突背景（留档）：`TICKET_STATUS_TABS` 里 `new` 的标题曾是「待受理」，
与 `TICKET_STATUS_LABEL.NEW` 一致；但它与早前锁死的口径「界面不出现"受理"」冲突
（`accept` 已从门店流程移除 —— NEW 直接派工/转店/取消/电话解决）。

#### 落地清单（**一个都不能少**，否则会出现"某处改了、某处没改"的自相矛盾）

| # | 层 | 改动 | 为什么必须单独处理 |
|---|---|---|---|
| ① | 共享状态标签 | `constants.ts` 的 `TICKET_STATUS_LABEL.NEW` → `'待处理'` | `_options.ts` 用它生成枚举，是**唯一**来源 |
| ② | **已落库的字段元数据** | **新增迁移** `20261010-status-label-wording.ts` | 🔴 见下：改代码常量**不会**更新它 |
| ③ | Tab 标题 | `expected-sensitive-columns.mjs` 的 `TICKET_STATUS_TABS` → `'待处理'`，并**重跑 seed** | Tab 走 `flowModels`，由 seed 重灌（与 ② 是两套配置） |
| ④ | 详情抽屉 | `ticket-drawer.tsx`「尚未派工（等待门店**处理**）」 | NEW 行在详情里的那句话 |
| ⑤ | 时效一句话 | `timeliness.ts`：`等待处理 X`；PROCESSING 无预约时改说「尚未约定上门时间」 | 原句「已受理，尚未派工」**既不准确也不合规** |
| ⑥ | 报表 KPI 标签 | `report-kpi.ts` 的 `ACCEPTANCE_OVERDUE_RATE` 标签 → `'待处理超时率'` | 总部报表界面直接展示该 `label` |
| ⑦ | 代码注释 / 诊断文案 | SLA 扫描、report-kpi、seed、各验收脚本里的旧词 | 防止口径二次漂移 |
| ⑧ | 验收断言 | `verify-client-logic`（5 处期望值）+ 新增浏览器文案判据 | 期望值同步，**判定强度不降** |

#### 🔴 ② 为什么必须有迁移（本轮最费时间的一处，与 DEV-110 同型的"看不见的运行"）

改完 `constants.ts` 重启后，**门店列表的状态列仍然显示「待受理」**。
根因是本项目已经付过一次学费的那条规律（见 `202610091-visit-fields-allow-null.ts`）：

> **NocoBase 的字段展示取自库里的字段元数据（`fields.options.uiSchema.enum`），
>  不是取自代码里的 collection 定义。已存在的集合，代码定义只在 `install` 时写入库；
>  之后库里的那份说了算。**

实测三处枚举全是旧文案：`serviceTickets.status`、`ticketEvents.from_status`、
`ticketEvents.to_status`。**只改代码 ⇒ 这三处继续显示旧词，且没有任何报错。**

迁移的期望值来自 `TICKET_STATUS_OPTIONS`（由常数生成），**不重抄一个字面量**；
并照搬 202610091 的三段自检（先断言行数 → 再断言无旧词 → 最后与期望逐字比对），
避免"集合名写错 ⇒ 匹配 0 行 ⇒ 自检空过"的假绿。

#### 验收（真实门店账号 + 真实浏览器）

| 判据 | 结果 |
|---|---|
| 页面上 Tab 标题 = `["全部","待处理","处理中","待门店确认","待客户评价","已闭环"]`，且**无「受理」字样** | ✅ |
| 各 Tab **状态列逐行**显示：待处理 20 行 / 处理中 20 行 / 待门店确认 1 行 / 待客户评价 20 行 / 已闭环 7 行 | ✅ 全部逐行一致 |
| 「全部」Tab 的状态列取值只出现已定义标签 | ✅ 20 行 |
| 同一张单：**列表状态列** 与 **详情抽屉** 的状态文案逐字相同 | ✅ 两处都是「待门店确认」 |
| 详情抽屉里无「待受理」 | ✅ |
| `verify-store-tab-filter` | **38 项全过** |
| `verify-store-ui-primary-action` | **30 项全过** |

判据的期望值一律**从 `server/constants.ts` 编译后 require**，不在脚本里手抄
（否则"产品改了、脚本没改"会判红假红，"两边一起错"会判绿假绿）。

#### 变异测试（证明文案判据会红）

把 `TICKET_STATUS_TABS` 的标题改回 `'待受理'`、**且不重灌 seed**：

```
✗ 切到「待受理」 —— 找不到该 Tab，页面上的 Tab = ["全部","待处理","处理中",…]
通过 32 项 · 未达标 2 项
```

⇒ 证明判据读的是**真实页面 DOM**，不是常量自证。还原后 sha256 与变异前逐字节一致
（`c698b231c66d41eb`），复绿。

#### 一处**刻意不动**的文案（已向用户报备）

详情底部「处理记录」会渲染**历史事件名**，其中
`constants.ts` 的 `[EVENT_TYPE.ACCEPTED]: '门店已受理'` 含「受理」二字。
那是"这张单**过去真的发生过**受理"的**如实记载** —— 本项目的硬纪律是不抹掉历史。
裁决范围是 **NEW 的状态文案**（「不再出现『待受理』」），故保留；
验收判据也相应**收窄到 `待受理`**，不把历史记载误判成违规。
（若用户要求连历史事件名一并改，属另一次裁决。）

