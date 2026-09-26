# Phase 8 —— 后台任务可靠性 + SMS 失败恢复闭环（短契约）

> **状态：🔒 语义冻结（2026-09-26 用户裁定）· ✅ 已实现（2026-09-26，交付 `94fa3db`，见 §10 交付记录）**
> **上游基线：Phase 7 🔒 CLOSED —— `baf82aa` → `05c0ec3`；prework 取证 `f1fe312`。**
>
> ⚠️ **本文刻意写得短**（与 Phase 7 同一做法）。它**只冻结少数高风险语义**；
> health JSON 形状、后台列表、普通 UI 显示**不建契约、不建重型门禁**。
>
> 冻结口径一旦写下，实现阶段**只按本文执行**；发现本文与代码冲突时沿用铁律：
> **先回代码取证，再决定改代码还是改文档**，并在本文标注。

---

## 0. 阶段定位

> **Phase 8 = 后台任务可靠性 + SMS 失败恢复闭环。**
> SLA 在本阶段**开始"检测并留下可消费结果"，但不做复杂通知 / 运营分析。**

**三条纵向能力（按依赖顺序，A 是基础设施）**：

```
P8-A  Scheduled-task observability          ← 基础设施，先做
        ↓
P8-B  SMS failed → retry once → terminal failure visible
        ↓
P8-C  SLA scan → overdue facts visible
```

现有 `review-expiry` **接入 A，但不重写它的领域逻辑**。
Phase 8 结束后，后台运行能力才真正从"**有 cron**"升级为"**知道 cron 是否工作**"。

### 0.1 明确**不做**（范围外，防止膨胀）

❌ 外部告警 webhook / 企业微信 / 钉钉 ❌ SLA 提醒短信
❌ 营业时间日历（business-hours SLA） ❌ 运营 Dashboard / report / export（**Phase 9**）
❌ **delivery callback（投递回执）新工程** —— `delivery_status` 字段已有但**无回执入口**，
这是值得做的能力，但它涉及不同 provider 的 callback **鉴权 / 签名 / 状态映射**，
容易单独长成一块。**Phase 8 不因为"有一个字段"就顺便实现它。**

---

## 1. 【决策 1】任务可观测性 —— Phase 8 的基础设施

**先做，且作为基础设施**。理由：现在有 `review-expiry`，马上会有 SMS retry、SLA scan；
没有 `lastRunAt` / `lastResult`，以后"**任务到底没跑、跑失败、还是跑了但没命中**"极难分辨。

**保持轻量，不建"任务中心"。** 每个任务统一记录：

| 字段 | 说明 |
|---|---|
| `task_name` | 任务标识（`review_expiry` / `sms_retry` / `sla_scan`） |
| `last_started_at` | 最近一次开始 |
| `last_finished_at` | 最近一次结束 |
| `last_result` | `success` \| `partial` \| `failed` |
| `last_processed_count` | 最近一轮处理条数 |
| `last_error` | **截断后的安全摘要**，**不存敏感数据** |
| **`last_success_at`** | ⚠️ **必须有** —— 它比单纯 `last_result=failed` 更有诊断价值：**能知道已经连续多久没有成功执行** |

⚠️ **这套状态只描述"最近运行情况"，不做完整 job history**（不建历史表、不做趋势）。

---

## 2. 【决策 2 / 4】SMS retry + 终局失败可见

### 2.1 retry 上限继续冻结为 **1 次**

⚠️ **不要把 `sms.retry_count` 当运营配置开放。**
其 description 已写「**文档要求最多 1 次**」—— 这是**需求文档规定的上限**，不是可调旋钮。

```
首次发送
   ↓ transport error / timeout
retry once
   ↓
成功 → 正常
仍失败 → terminal failed / attention
```

- **只重试传输层**：`RETRYABLE_ERROR_CODES = {SMS_TRANSPORT_ERROR, SMS_TIMEOUT}`（**已有，复用**）。
- **业务拒绝、号码错误等非传输层错误不得机械重试**（模板没配 `SMS_TEMPLATE_MISSING`、
  `SMS_DISABLED` 等一律不重试）。
- **必须复用现有 `flush()` / SmsLog / outbox 语义**，**不另造第二套发送管线**。

### 2.2 ⚠️ 本阶段唯一的并发门（重门禁之一）

> **两个 retry worker / 两次 scheduler 重叠运行时，同一 `SmsLog` 最多获得一次合法 retry。**

**必须用数据库原子 claim / 条件更新解决，不得依赖"先 SELECT 看 retry_count"。**

理由（本项目已冻结的并发范式）：`SELECT` 与后续 `UPDATE` 之间没有互斥，
两个 worker 会同时看到 `retry_count = 0` 而各重试一次 ⇒ **同一失败短信被发两遍**。
⇒ 正确形态 = **条件 UPDATE + 影响行数**（`WHERE retry_count = 0 AND send_status = 'error'`，
`affected = 1` 才算抢到 claim，`affected = 0` ⇒ no-op）。
⚠️ **全仓 `FOR UPDATE` 命中 = 0**，本项目**一律不用行锁**（沿用 Phase 6/7 冻结口径）。

### 2.3 【决策 4】告警出口：本阶段做到**"可发现"，不接 webhook**

当前**没有已经确定的外部告警通道** ⇒ **不为了"告警"两个字引入 webhook、企业微信、钉钉之类新基础设施。**

Phase 8 的出口就是这四条：

1. **health / ops 状态能看到**失败 / 积压数量；
2. **HQ 后台能够找到最终失败的 `SmsLog`**；
3. **应用日志保留结构化错误**；
4. **task health 能看 retry job 最近是否成功**。

⇒ 这已构成完整的「**人工可发现 + 可诊断 + 自动重试一次**」闭环。
**主动外部告警以后真有通道再接。**

---

## 3. 【决策 5】SLA：**只检测，不发提醒短信**

> ⚠️ **这一点明确切断**，否则会迅速膨胀成：
> SLA scan → 通知谁 → 多久提醒一次 → 重复短信幂等 → 门店/HQ 分别通知 → quiet hours → business hours……

### 3.1 本阶段消费现有三个键（`DEFAULT_SETTINGS` 已播种）

| 键 | 值 | 语义 |
|---|---|---|
| `sla.accept_minutes` | 120 | 门店受理时效（分钟），超过标记响应超时 |
| `sla.appointment_overdue_grace_minutes` | 120 | 约定上门时间宽限（分钟）—— ⚠️ **语义见 §3.3，必须先解决** |
| `sla.store_confirm_hours` | 48 | 门店确认时效（小时），师傅提交后超过则提醒 |

产出 = **"当前 SLA overdue fact"**，供 **HQ / health / 后续 Phase 9 使用**即可。

⚠️ **索引 `service_tickets(status, expected_visit_at)` 已建**（注释明写"SLA 扫描"）
⇒ **不需要新增索引**。三个键**已播种** ⇒ **不需要新增配置项**。

### 3.2 【决策 5b】`sla.clock_mode` MVP 明确 = **calendar elapsed time**

**使用日历自然时间**。**不要现在实现营业时间日历。**
未来若业务确认需要 business-hours SLA，**再作为明确功能加入** ——
**不让 Phase 8 卡在"门店营业日历系统"上。**
⚠️ 因此本阶段**不新增** `sla.clock_mode` 配置键（避免播一个无人消费的键，重蹈 §3.1 覆辙）。

### 3.3 🔴 契约级语义修正：`appointment_overdue_grace_minutes` 的解释

> **这是本阶段唯一"必须先明确、不能直接开写"的语义问题。**

**问题**：`expected_visit_at` 是**日期语义**，DB 里的 `12:00 +08:00`
只是**防跨日的技术归一值**（**DEV-71**），**不是真实预约时间**。
若把 `appointment_overdue_grace_minutes = 120` 解释成 `expected_visit_at + 120min`，
就得到"**预计当天 14:00 超时**"——**这是假的业务含义**。

**DEV-71 既有裁定（必须承接，不得重解释）**：

| 纪律 | 原文 |
|---|---|
| ① UI 不得显示那个固定时刻 | `formatVisitDate()` 只到天 |
| ② `TicketEvent` / 短信**不得**把它描述成真实预约时刻 | 已满足 |
| ③ **SLA 不得拿它当真实到达时间（逾期口径留 Phase 9 重新裁决）** | ← **本阶段正是在偿还这一条** |

**✅ 冻结口径（用户 2026-09-26 裁定）**：

```
appointmentOverdueFrom = 预计上门日期 结束（当地 23:59:59.999）
                       + sla.appointment_overdue_grace_minutes
```

⇒ `120` 表示「**预计日期结束后再宽限 2 小时**」，
**不会伪造一个客户从未约定过的具体上门时间**。

> ⚠️ **不得**以 DB 归一化的 `12:00` 为基准计算。
> **不得**因为"配置已经存在"就直接按 datetime 算。
> 实现上：**先把 `expected_visit_at` 取成裸日期（`appointmentDateOnly()`，已有）**，
> 再取**当天 23:59:59.999（+08:00）**，再加 grace —— **不许直接 `expected_visit_at + graceMs`**。

**另两个键的时间基准（同样按"事实字段"定义，不涉伪精度）**：

| fact | 基准字段 | 判定（**状态谓词已回代码取证**） |
|---|---|---|
| `acceptanceOverdue` | `tickets.created_at` + `sla.accept_minutes` | 超过且 `status = 'NEW'`（**已取证**：`NEW` = 客户已提交待门店受理；受理后转 `PROCESSING` 并写 `EVENT_TYPE.ACCEPTED`） |
| `storeConfirmOverdue` | **`service_visits.submitted_at`**（**已取证**：列注释即「师傅提交时间」）+ `sla.store_confirm_hours` | 超过且**仍未门店确认**（Ticket 仍 `WAIT_STORE_CONFIRM`） |
| `appointmentOverdue` | 见上（**日期语义 + grace**） | 超过且**尚未上门完成**（Visit 终态谓词见 O8-1） |

⚠️ `appointmentOverdue` 的"尚未上门完成"**精确谓词仍需在实现时回状态机取证**（见 O8-1）——
不得凭印象写；其余两行的谓词已在上表中取证落定。

### 3.4 🔴 SLA **不得**每次扫描无条件写 `TicketEvent`

**问题**：一张工单连续超时三天，每 5 分钟扫一次，若每次都 `scan → TicketEvent(sla_overdue)`，
**审计轨迹很快就被废掉**。

**冻结口径**：

- 若写 Event，**只写"首次进入 overdue"或"SLA overdue 类型发生变化"时**，且**具有确定性去重**；
- ⚠️ **如果目前没有轻量办法保存"已告警 / 已进入 overdue"状态，Phase 8 甚至可以只计算
  overdue fact + 聚合计数，不强求 `TicketEvent`。**

> **SLA 本质上是从 Ticket 当前事实推导出来的运营状态，
> 不一定必须永久污染核心状态机。**

### 3.5 SLA 主要防的是**状态污染**（重门禁之一）

见 §6 门禁 ④ —— **scheduler 重复执行必须幂等，不重复产生业务副作用**。

---

## 4. 【决策 6】health 的 `tasks` 假字段**转正**

现状（已取证）：`tasks` 恒为 `state.ready ? 'ok' : 'skipped'`，
**实际上没检查任何任务**（代码注释已自认；注释还写「Phase 8/9 起 > 0」）。

**Phase 8 后至少能表达**：

```yaml
tasks:
  review_expiry:  { lastRunAt, lastSuccessAt, lastResult }
  sms_retry:      { lastRunAt, lastSuccessAt, lastResult }
  sla_scan:       { lastRunAt, lastSuccessAt, lastResult }
sms:
  retryPending:   <int>
  terminalFailed: <int>
sla:
  acceptanceOverdue:     <int>
  appointmentOverdue:    <int>
  storeConfirmOverdue:   <int>
```

> ⚠️ **health 不要顺手变成 Dashboard API。**
> 这里给机器 / 运维的是**聚合计数和运行状态**，**不返回工单明细**。
> **Phase 9 再负责真正的 HQ dashboard / report / export。**

---

## 5. 沿用既有架构约束（**不得违反**）

1. ⚠️ **调度器不得绕过领域服务改核心状态**（用户明令）。
   调度器只做「**挑名单（只读）+ 逐条调领域服务**」，**自己不写一行状态推进 SQL**。
   否则会出现**第二处**状态推进逻辑，谓词一旦不一致就产生脏数据（Phase 7 已论证）。
2. ⚠️ **任务注册沿用现有样板**：`app.cronJobManager.addJob({cronTime, onTick, start:false})`；
   **热重载先 `removeJob` 摘旧任务**；**注册失败只 warn 不抛错**（体现在 `tasksRegistered`）。
3. ⚠️ **workflow 插件在镜像里存在但未启用** —— 不依赖它。
4. ⚠️ **幂等不靠"只跑一次"**，靠**领域服务的原子谓词**（`affected rows = 0` ⇒ no-op）。
5. ⚠️ **`accepted ≠ delivered`**：`send_status` 与 `delivery_status` 是两件事，**不得混为一谈**。
6. ⚠️ **幂等键必须显式确定性**（Phase 7 教训）：**不得依赖随机 `bizId` 唯一冲突实现幂等**。
7. ⚠️ **不改 Phase 5/6/7 任何已冻结语义**（含 `completed_at` = 门店确认时刻、
   C16 = 409、Review Token hash-only、`/f/{token}` 302）。

---

## 6. 门禁：压缩到 **4 个重门禁**（不恢复 C1~C30 模式）

| # | 重门禁 | 判据 |
|---|---|---|
| **①** | **任务重启 / 热重载不会重复注册，运行结果可观测** | `reload()` 后任务数不叠加；`lastRunAt` / `lastResult` / `lastSuccessAt` 真被写入 |
| **②** | **SMS retry 真并发** | 两个 worker 并发时，**同一失败短信最多 retry once**（原子 claim 生效，`affected=1` 唯一） |
| **③** | **SLA 三类边界时间判断正确** | ⚠️ **尤其 `expected_visit_at` 的 date semantics 不被 `12:00` 技术值污染** —— `120` 必须从**当天 23:59:59.999** 起算，不是从 12:00 |
| **④** | **scheduler 重复执行幂等** | 连跑 / 重叠跑**不重复产生业务副作用**（不重复写 Event、不重复发短信） |

**health JSON、后台列表、普通 UI 显示 → 做正常测试即可**，**不建重型验证体系**。

---

## 7. 阶段划分（纵向切片）

| 切片 | 内容 | 说明 |
|---|---|---|
| **P8-A** | Task observability | **基础设施，先做**；`review-expiry` 接入但**不重写其领域逻辑** |
| **P8-B** | SMS retry + terminal failure visibility | 复用 `flush()`；原子 claim；4 条出口（§2.3） |
| **P8-C** | SLA overdue detection | 只检测 + 聚合计数；**不发短信**；**§3.3 语义必须先落** |

---

## 8. 开放项 / 实现时必须回代码取证的点

> ✅ **全部已落定（2026-09-26 实现阶段裁决）**。用户明示：O8-1~O8-6 属实现细节，
> 只要不改变 fbea884 冻结的业务语义，可取证后自行决定并在此说明。

| # | 项 | 状态 |
|---|---|---|
| **O8-1** | `appointmentOverdue` 的"**尚未上门完成**"精确 Visit 终态谓词 | ✅ **已取证**：最窄 Ticket 侧谓词 `[NEW, PROCESSING, WAIT_STORE_CONFIRM]`（排除 WAIT_FEEDBACK/CLOSED/CANCELLED）+ Visit 侧 `hasConfirmedVisit()` 双查。`VISIT_STATUS` 六态**没有** COMPLETED，"上门完成"= `CONFIRMED`。见 `APPOINTMENT_ACTIVE_TICKET_STATUSES` |
| **O8-2** | `storeConfirmOverdue` 基准字段 | ✅ **已取证**：`service_visits.submitted_at`（列注释「师傅提交时间」） |
| **O8-3** | task 运行状态的**存储位置** | ✅ **定内存**（`TaskRegistry` 持 `Map`，进程级，重启即复位）。理由：运行状态本就是"进程内事实"，跨实例/跨重启不追求一致；避免写放大与多实例归属问题 |
| **O8-4** | SLA overdue fact 的**呈现位置** | ✅ **health 字段**（`slaAcceptanceOverdue` / `slaAppointmentOverdue` / `slaStoreConfirmOverdue` / `slaScannedAt`），读**任务缓存的 fact**（`putFact`/`getFact`），探针不现算。**不建 Dashboard** |
| **O8-5** | `sms_retry` 的触发频率与 batch 上限 | ✅ `*/5 * * * *` / `batch=50`（与 `sla_scan` 同频；比 `review-expiry` 密，因重试是"尽快自愈"型） |
| **O8-6** | 是否需要为 retry 加**重试时间窗** | ✅ **不加独立窗口**：由 `retry_count < retryLimit(=1)` 的原子谓词 + 有界内存队列（`RETRY_QUEUE_CAPACITY=200`）共同封顶。终态失败仍以 `send_status='error'` 留库可被发现，不会无限重试 |

---

## 9. 目标态速查

```
Phase 5  🔒 CLOSED
Phase 6  🔒 CLOSED / PASS — 18fd59b
Phase 7  🔒 CLOSED / PASS — baf82aa → 05c0ec3
Phase 8  🔒 语义冻结（fbea884）→ P8-A → P8-B → P8-C ✅ 已实现
```

---

## 10. 交付记录（2026-09-26 · commit `94fa3db`）

**P8-A / P8-B / P8-C 一次性交付**，核心落点：

- **任务可观测性（P8-A）**：`services/task-registry.ts`（`TaskRegistry` 内存注册表，
  `start/finish/snapshot/putFact/getFact`，**所有写方法永不抛错** —— 状态记录失败不影响业务）。
  三个任务统一记录 `lastStartedAt/lastFinishedAt/lastResult/lastProcessedCount/lastError/lastSuccessAt/runCount/failureCount`。
  `health.tasks` 假字段转正（`tasksOverall` + 逐任务快照）；`tasksRegistered` 记真实注册数（0~3）。
- **SMS retry（P8-B）**：`SmsService.claimForRetry`（**原子条件 UPDATE + RETURNING**，全仓 0 行锁）
  + `enqueueRetry`（有界内存队列，**明文手机号绝不落库**）+ `retryPending`（claim → send → finish 死序）
  + `sms-retry-scheduler.ts`（`*/5`）。终态失败经 `health.smsTerminalFailed` / `smsRetryPending` 可发现。
- **SLA 检测（P8-C）**：`sla-scan-scheduler.ts` **纯读**（不写任何行、不写 TicketEvent、不新建 Ticket 状态）。
  `appointmentOverdueFrom()` 实现 DEV-71 日期语义（`appointmentDateOnly() → 当地 23:59:59.999 → + grace`）；
  三类 overdue 计数缓存进 TaskRegistry，health 只读缓存。
- **门禁**：`scripts/verify-task-reliability.mjs` —— 四条重门禁（① 注册幂等+可观测 ② 真并发 retry≤1
  ③ SLA 边界日期语义 ④ 重复执行幂等），**正向 25 项全绿 + 反向 6 项精确转红**（容器内单进程探针
  `scripts/lib/p8-probe.cjs` 用真实连接池跑同一条 claim SQL）。
- **两个实现期发现并修复的缺陷**：
  1. `runStartupSlaScan` 的 `void` 触发在关机/热重载时与连接池关闭竞态，会打出 error 日志污染冒烟断言
     ⇒ 新增 `isShutdownSignal()` 统一识别关机竞态，三个调度器 catch 静默中止（不记 FAILED）。
  2. `onConfigWarn` 无条件覆盖 `healthState.lastError`，会盖掉更具体的 `SEED_SETTINGS_FAILED`
     ⇒ 改为**最低优先级**（仅当 lastError 为空才写 CONFIG_WARN）。
