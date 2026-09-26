# Phase 8 开工前事实清点（运行可靠性）

> **状态：⬜ 规划准备 —— 尚未开工，未冻结任何语义。**
> 本文**只是取证记录**，不是契约、不是计划。它的唯一目的是让 Phase 8 的规划
> **从既有代码事实出发**，而不是从印象出发（本项目铁律：**读文档必须回代码核实**）。
>
> 取证时间：**2026-09-26 16:0x**，基线 = **`05c0ec3`**（Phase 7 closure，工作区 clean）。
> 上游节点：**Phase 5 🔒 · Phase 6 🔒 `18fd59b` · Phase 7 🔒 `baf82aa` → `05c0ec3`**。

---

## 0. Phase 8 方向（用户 2026-09-26 定，**未开工**）

> 重点转向**运行可靠性**：① 已预留的**定时任务**架构能力 ② **SMS retry / 失败告警**
> ③ 整体运行可靠性。**不继续扩评价功能。**
> 节奏沿用现行：**先定真正要解决的业务目标 → 只冻结少数高风险语义 → 直接纵向实现**
> （**不恢复重流程**）。

---

## 1. 既有事实：定时任务

**结论：已有 1 个真任务，基础设施是现成的、且被刻意设计成可复用的。**

| 项 | 事实 | 取证位置 |
|---|---|---|
| 调度器实现 | **1 个** —— 评价超时自动关闭 | `services/review-expiry-scheduler.ts`（213 行） |
| 注册点 | 插件 `load()` → `registerReviewExpiryTask()`；热重载先 `removeJob` 摘旧任务 | `plugin.ts:406` |
| 用的 API | **`app.cronJobManager.addJob({cronTime, onTick, start:false})`** | `review-expiry-scheduler.ts:155` |
| 为什么不是 Workflow | **`@nocobase/plugin-workflow*` 在镜像里存在但未启用**（`app.pm.get('workflow')` 拿不到实例）；`cronJobManager` 是 server 包自带、零依赖 | 文件头 §"为什么用 cronJobManager" |
| 启动时机 | 注册本身不启动；`CronJobManager` 在 app `afterStart` 统一 `start()` | 文件头 |
| cron 默认 | `0 3 * * *`（每天 03:00），`batchLimit = 200` | `DEFAULT_CRON` / `DEFAULT_BATCH` |
| 幂等策略 | **不靠"只跑一次"，靠领域服务的原子谓词**（`affected rows = 0` ⇒ no-op） | 文件头 §"幂等与重复扫描" |
| 错误策略 | `runReviewExpirySweep()` **永不抛错**（单条失败记 warn + 计数，主循环继续） | 函数注释 |
| 未注册时的行为 | `cronJobManager` 不可用 → **warn 而不抛错**，返回 `null`（不让应用起不来，但必须被看见） | `registerReviewExpiryJob` |
| 硬架构约束 | **调度器不得绕过领域服务改核心状态**（只挑名单 + 逐条调领域服务，自己不写 SQL） | 文件头（用户明令） |

### 1b. 已有但**从未被消费**的定时任务预留物

| 预留物 | 现状 |
|---|---|
| 配置键 `sla.accept_minutes`（120） | **只在 `DEFAULT_SETTINGS` 里播种，全仓无任何消费点** |
| 配置键 `sla.appointment_overdue_grace_minutes`（120） | 同上 |
| 配置键 `sla.store_confirm_hours`（48） | 同上 |
| **索引 `service_tickets(status, expected_visit_at)`** | **已建**，注释明写「SLA 扫描：找出应上门但已超期的单」⇒ **SLA 扫描不需要新建索引** |
| `health.tasksRegistered` | 字段已存在；注释写「**Phase 1 为 0；Phase 8/9 起 > 0**」 |
| `health.tasks` | 当前恒为 `state.ready ? 'ok' : 'skipped'`（**不是真实任务数**，注释已自认） |
| `serviceTickets` 里 "SLA 扫描：找出应上门但已超期的单" | **只有注释 + 索引，无实现**（`collections/serviceTickets.ts:176`） |

⚠️ **这三条 `sla.*` 是"配置先行、实现缺席"的典型**：参数已播种、**索引已建**、注释已写，
但**没有任何代码读它们**。Phase 8 若做 SLA 巡检，**既不需要新增配置项、也不需要新增索引**。

> ✅ **反向核验（2026-09-26）**：全仓 `grep sla.accept_minutes|sla.appointment_overdue_grace_minutes|
> sla.store_confirm_hours`（排除 `constants.ts` 定义处）只有两处命中，**都不是消费点**：
> ① `shared/service-mode.ts:274` 的注释，**原文就写着「只是一个未被消费的种子参数」**；
> ② `scripts/verify-plugin-load.mjs:1734` 的断言，只验**键存在**，不验被使用。
> ⇒ **"零消费"已确认**，且项目自己早已知道这件事。

---

## 2. 既有事实：SMS retry / 失败告警

**结论：retry 已实现（传输层、有上限）；失败告警几乎不存在。**

### 2a. retry —— 已实现

| 项 | 事实 | 取证位置 |
|---|---|---|
| 重试上限来源 | `config.getInt('sms.retry_count', 1)` —— **默认 1 次** | `sms-service.ts:393` |
| 可重试错误码 | **`RETRYABLE_ERROR_CODES = {SMS_TRANSPORT_ERROR, SMS_TIMEOUT}`**（只重试传输层） | `sms-service.ts:65` |
| 重试语义 | 业务性拒绝（如模板没配）**不重试**；只有传输层失败重试 | `deliverOne` while 条件 |
| 计数落库 | `retry_count` 写入 SmsLog；每次重试记 warn 日志 | `finish()` |
| 发送时机 | 业务事务内落 **outbox** → **commit 后 flush** | 文件头 |
| 失败对业务的影响 | **短信失败不得回滚业务事务**；`accepted != delivered` | 冻结语义（沿用） |
| 失败留痕 | SmsLog 状态（`rejected` / `error`）+ **`sms_failed` TicketEvent** + warn 日志 | `finish()` |

### 2b. 失败告警 —— **缺口**

| 缺口 | 事实 |
|---|---|
| **无失败汇总出口** | 失败只散落在 SmsLog 行 + TicketEvent + 日志；**没有任何"积压/失败率"的对外可读视图** |
| **无自动重发任务** | `flush()` 注释写「**Phase 8 的批量重发任务同样复用本方法**」—— 任务**尚未存在** |
| **`sms.enabled=false` 是静默态** | 通道未就绪时"不发送但如实记录"，**只有日志与 rejected 行**，无告警 |
| **无投递回执处理** | `delivery_status` 字段存在，但**无回执接收/更新路径**（`accepted` 之后无下文） |
| 配置键 `sms.retry_count` 默认 1 | ⚠️ description 写「**文档要求最多 1 次**」—— 这是**需求文档规定的上限**，不是随手可调的旋钮。Phase 8 若要提高重试次数，**须先确认该上限是否仍有效**，不得擅自改。 |

⚠️ **`SmsLog.send_status` 与 `delivery_status` 是两件事**，本项目已冻结此口径：
`accepted ≠ delivered`。Phase 8 做告警时**不得**把两者混为一谈。

---

## 3. 既有事实：健康检查 / 可观测性

**结论：健康检查非常成熟（大量"接口全绿但后台全瞎"型故障已被探针覆盖），但缺"运行期业务积压"视图。**

| 已覆盖（**查库实时判定**，非进程内记账） | 说明 |
|---|---|
| `db` / `missingTables` / `tablesPresent` | 连通性 + 表齐备 |
| `settingsSeeded` / `storesSeeded` / `rolesSeeded` | 基线数据（避免重启后假阴性） |
| `roleStrategiesSeeded` / `roleResourcesSeeded` | **两级 ACL 判定**（症状同为 403，故分开记账） |
| `uiCollections` / `uiTimestampFields` / `uiFieldInterfaces` | **"接口全绿但后台全瞎"** 型故障（DEV-48/51/52） |
| `sms` | **只回通道名**（`mock` / 真实通道），不回密钥 |
| HTTP 语义 | 健康 `200`；degraded `503` |

**缺口**：

- ⚠️ **`tasks` 字段是假的** —— 恒为 `'ok' | 'skipped'`，**不是真实任务数/健康度**。
  Phase 8 接入更多任务后，这个字段应当变成**"注册了几个 + 上一次跑完是什么时候 + 上轮失败几条"**。
- ⚠️ **health 不回答"定时任务到底跑没跑"** —— 只有 `tasksRegistered`（注册数），
  **没有"lastRunAt / lastResult"**。而"窗口早过了、工单还挂着、日志里什么都查不到"
  正是本项目在 scheduler 注释里自认的最难排查形态。
- ⚠️ **health 不回答"SMS 有没有积压/失败"** —— 见 §2b。
- ⚠️ **health 不回答"SLA 超时工单有几张"** —— 见 §1b。

---

## 4. 候选工作项（**未裁决，仅供规划讨论**）

按 §0 的三个方向归拢；**每项都标明"已有基础"与"缺口在哪"**，便于判断工作量与风险。

### 方向 ①：定时任务架构

| 候选 | 已有基础 | 缺口 |
|---|---|---|
| **任务注册框架** | `registerReviewExpiryJob` 是可复用样板（热重载摘旧、失败不抛、warn 可见） | 每加一个任务都是手写一份注册 + `this.xxxJob` 字段；**是否抽公共注册器**待定 |
| **SLA 巡检任务** | `sla.*` 三个键已播种；索引 `(status, expected_visit_at)` 已建；`serviceTickets` 注释已写意图 | **全仓零消费**；"超时"定义、是否发提醒短信、是否写 TicketEvent 全未定 |
| **任务可观测性** | `tasksRegistered` 字段已在 | **无 lastRunAt / lastResult**；建议**先于**新增任务做（否则任务变多后更难查） |
| **任务并发（多实例）** | 幂等靠领域服务原子谓词，**已是对的** | 若将来多实例部署，需确认"两个实例同时扫"不会重复发短信（`bizId` 唯一性能否兜住） |

### 方向 ②：SMS retry / 失败告警

| 候选 | 已有基础 | 缺口 |
|---|---|---|
| **失败重发任务** | `flush()` 注释已预告"Phase 8 的批量重发任务复用本方法"；`retry_count` 已有 | **任务不存在**；"重发哪些 / 重发几次上限 / 多久后 / 幂等键"全未定 |
| **失败告警出口** | `sms_failed` 事件 + SmsLog 状态已有 | **无汇总**；告警是"日志"、"health 字段"、"TicketEvent"、还是"通知"未定 |
| **投递回执** | `delivery_status` 字段已在 | **无接收/更新路径** |
| **`sms.enabled=false` 可见性** | 已有 rejected 行 + 日志 | 该状态**没有任何主动提示** ⇒ 上线后容易"以为在发，其实没发" |

### 方向 ③：整体运行可靠性

| 候选 | 已有基础 | 缺口 |
|---|---|---|
| **health 的 tasks 字段做实** | 字段占位已在 | 改成真实数 + 最近一轮结果 |
| **基线/元数据自检**（已有） | 已很成熟 | 无需扩（**不要顺手加**） |
| **备份 / 恢复** | — | 本阶段是否纳入，**待裁决** |
| **日志与 trace** | `x-trace-id` 已贯通 nginx↔app；health 已用 | 定时任务是否也带 traceId，未定 |

---

## 5. 明确**不做**的事（沿用现行纪律）

- ❌ **不继续扩评价功能**（用户明确）。
- ❌ **不因开启 Phase 8 就顺手清理** B-5 / B-6 / B-7 / B-12 / B-13 ——
  **除非它们实际阻断 Phase 8**（用户明确）。当前判定：**均不阻断**。
- ❌ 不新增 `sms.*` / `sla.*` 之外的配置项，除非确有新增语义（`sla.*` 已够用）。
- ❌ 不重开 Phase 5/6/7 的任何已冻结语义。

---

## 6. 开工前必须先问清的问题（**待用户拍板，不自行假设**）

> 本项目的做法是**契约先行、只冻少数高风险语义**。以下问题应在写契约前定，避免返工。

1. **Phase 8 的"真正业务目标"是哪一条**？三个方向是否**全做**，还是**先只做一条纵向闭环**
   （例如"短信失败可被发现 + 可被重发"这一条端到端）？
2. **SLA 巡检要产生什么动作**？只写 `TicketEvent`（可查）／还要发提醒短信／还要在 health 暴露计数？
   —— 这决定风险等级（发短信就牵涉 §2 的幂等与告警）。
3. **失败告警的"出口"是什么**？日志 / health 字段 / `TicketEvent` / 外部通知（webhook / 邮件）？
   —— 若无外部通道，本阶段是否只做"可被发现"而不做"主动推送"？
4. **重发的边界**：哪些 `error_code` 可自动重发？上限几次？幂等键用什么
   （**必须显式确定性**，不得依赖随机 `bizId` 唯一冲突 —— 沿用 Phase 7 教训）？
5. **多实例**：本阶段是否需要考虑多实例并发跑的重复执行？还是单实例、靠原子谓词兜底即可？
6. **任务可观测性**是否**必须先于**新增任务做（建议是：先有 `lastRunAt`/`lastResult`，再堆任务）？

---

## 7. 目标态速查

```
Phase 5  🔒 CLOSED
Phase 6  🔒 CLOSED / PASS — 18fd59b
Phase 7  🔒 CLOSED / PASS — baf82aa → 05c0ec3   ← 当前基线
Phase 8  ⬜ 规划准备（本文）→ 待契约冻结 → 纵向实现
```
