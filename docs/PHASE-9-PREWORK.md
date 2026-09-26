# Phase 9 开工前事实取证（只取证，**未冻结口径**、未实现）

> 目的：按用户 2026-09-26 的指示，Phase 9（HQ Dashboard / SLA / 报表 / 导出）开工前
> **只做一次很短的事实取证**，聚焦四件事：① 现有 dashboard/report API 已有什么；
> ② Phase 8 SLA fact 如何被读取；③ HQ export 现有隐私字段与权限边界；
> ④ 指标分母/时间口径在代码里有没有既存定义。
>
> 方法：**一律回代码/文档取证**（含 `file:line`），不凭印象。本文**不含**任何实现与语义冻结。
> 复现命令见文末 §6。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| ① 现有 dashboard/report API | **0 实现**。只有文档条目（I15/I16/I17）与 DEV-PLAN 产出清单；`slaScan` 已实现（Phase 8） |
| ② Phase 8 SLA fact 读取 | `runSlaScan` 产出 → `TaskRegistry.putFact` **只缓存三个计数** → `health` 只读缓存。**明细 `facts[]` 未缓存** |
| ③ 导出权限/隐私 | 能力=仅 `hq_admin`；四业务角色原生 `export` 全关；⚠️ 但 `root/admin` 绕过 ACL，**原生导出对超管仍可用且不经脱敏** |
| ④ KPI 口径既存定义 | `API.md §5` 有 12 项**文档口径**（未实现）；**3 处与已冻结实现冲突**，必须先裁决 |

---

## 1. ① 现有 dashboard / report / export API 到底已有什么

### 1.1 代码侧：没有任何报表/看板/导出 action

已登录 svc action 全集（`src/server/constants.ts:1338-1367`，共 16 条）：

```
accept · transfer · cancel · timeline · dispatch · reassign · reschedule
tokenCheck · smsOutbox · visits · visitDetail · photo · visitConfirm · visitReject · faultInject
（+ health 走匿名白名单）
```

- **无** `dashboard` / `summary` / `kpi` / `report` / `export` / `stats` 任何一条。
- 匿名白名单 `ANONYMOUS_ACTIONS`（`constants.ts:1664+`）亦无报表类接口。
- 全仓 `grep "export/tickets|SVC_ACTION.EXPORT"` ⇒ **仅命中注释与文档**，无实现。

### 1.2 文档侧：三条接口已"登记"，但均为未实现状态

| # | 路径 | 文档声明的角色 | 出处 |
|---|---|---|---|
| I15 | `GET /api/svc/dashboard/summary` | 全部（按角色裁剪范围） | `docs/API.md:224`、`docs/PHASE-0.md:336` |
| I16 | `GET /api/svc/reports/kpi` | 总部 | `docs/API.md:225`、`docs/PHASE-0.md:337` |
| I17 | `GET /api/svc/export/tickets` | **仅总部** | `docs/API.md:226`、`docs/PHASE-0.md:338` |

`docs/DEV-PLAN.md:405` 的 Phase 9 产出清单：

```
slaScan 定时任务；dashboard/summary；reports/kpi（12 项口径）；
export/tickets（脱敏 + 防 CSV 注入 + 导出事件）；总部看板区块
```

阶段状态：`docs/DEV-PLAN.md:38` ⇒ `| 9 | SLA / 看板 / 报表 / Excel 导出 | ⬜ | AT-15 + 口径核对 |`（**未开始**）。

### 1.3 🔴 取证发现 D1：文档漂移（声称存在于 Phase 6）

`constants.ts:1639-1641` 注释写：

> `export` 不在其中 —— 导出属总部管理员专属能力，而原生 export 走不到 storeScope 的范围裁剪，放开等于全量泄露。
> **Phase 6 的导出走自研 `/api/svc/export/tickets`（脱敏 + 写导出事件）。**

**事实**：该 action **不存在**（`AUTHENTICATED_SVC_ACTIONS` 无此项；全仓无 `SVC_ACTION.EXPORT`）。
⇒ 这是一条"**文档声称 Phase 6 已交付、实际从未实现**"的漂移，Phase 9 必须一并订正（要么补实现，要么改注释）。

### 1.4 🔴 取证发现 D2：AT-15 条文不在仓库内

`AT-15` 在三处被引用为 Phase 9 的验收项（`DEV-PLAN.md:38,406`、`PHASE-0.md:435`），
但**仓库内没有 AT-01~AT-24 的条文清单**（`PHASE-0.md` 只有里程碑→AT 编号的映射表）。
⇒ Phase 9 需先把 **AT-15 的判据文本**补写出来，否则"验收 AT-15"无法判定。

### 1.5 health **不是** Dashboard API（Phase 8 已冻结）

`actions/public/health.ts:129-150` 明确：health 只给**聚合计数 + 运行状态**，**不返回工单明细**；
理由与契约 §4 一致（高频探针、不跑扫描、不污染日志）。⇒ Phase 9 的看板**不得**寄生在 health 上。

---

## 2. ② Phase 8 SLA fact 如何被读取

### 2.1 生产者

| 项 | 位置 |
|---|---|
| 纯函数（唯一权威判定） | `services/sla-scan-scheduler.ts#appointmentOverdueFrom` |
| 扫描主流程（纯读、幂等、永不抛错） | `services/sla-scan-scheduler.ts#runSlaScan` |
| 调度注册 | `#registerSlaScanJob`（`cron = */5 * * * *`，`start:false`，`afterStart` 自动启动） |
| 窄接口装配 | `#slaPortFromServices(services)` → `SlaScanPort` |

`runSlaScan` 的产出 `SlaScanResult`（`sla-scan-scheduler.ts:65-76`）：

```
{ acceptanceOverdue, appointmentOverdue, storeConfirmOverdue,   // 计数：全量
  scannedAt,
  facts: SlaOverdueFact[],                                       // 明细：受 detailLimit（默认 50）
  thresholds: { acceptMinutes, graceMinutes, storeConfirmHours } }
```

`SlaOverdueFact` = `{ kind: 'acceptance'|'appointment'|'store_confirm', ticketId, ticketNo, visitId, dueFrom }`（`:56-63`）。

### 2.2 缓存（**只缓存计数**）

`sla-scan-scheduler.ts:362-368`：

```ts
port.tasks?.putFact?.(TASK_NAME.SLA_SCAN, {
  acceptanceOverdue, appointmentOverdue, storeConfirmOverdue,
  scannedAt, thresholds,
});
```

⚠️ **`facts[]` 不进缓存**。`TaskRegistry.putFact/getFact`（`services/task-registry.ts:301-314`）是进程内 `Map`，重启清空。

### 2.3 消费者（现状仅 health）

`actions/public/health.ts:555-587` → `runtime.tasks.getFact(TASK_NAME.SLA_SCAN)`，
输出 `slaAcceptanceOverdue / slaAppointmentOverdue / slaStoreConfirmOverdue / slaScannedAt`（`:656-663`）。
兜底：`runtime.slaStats(app)`（注入式回调，测试用）。

### 2.4 三类谓词与阈值（**Phase 9 必须复用，不得重写**）

`SLA_SOURCE`（`sla-scan-scheduler.ts:412-426`）：

| 类型 | 谓词 | 基准字段 |
|---|---|---|
| acceptance | `status = 'NEW'` | `created_at + sla.accept_minutes` |
| store_confirm | Visit `visit_status = 'SUBMITTED'` | `service_visits.submitted_at + sla.store_confirm_hours` |
| appointment | Ticket ∈ `[NEW, PROCESSING, WAIT_STORE_CONFIRM]` 且**无** `CONFIRMED` Visit | `appointmentOverdueFrom(expected_visit_at, grace)` = 裸日期 → 当地 `23:59:59.999+08:00` → `+ grace` |

阈值键与播种值（`constants.ts:1855 / 1862 / 1873`）：`sla.accept_minutes=120`、`sla.appointment_overdue_grace_minutes=120`、`sla.store_confirm_hours=48`。

### 2.5 ⚠️ Phase 9 消费时绕不开的两个缺口

- **缺口 A（明细来源）**：看板若要"列出哪些工单超时"，现缓存里**没有明细**。
  两条路：① 扩展 `putFact` 一并缓存 `facts`；② Phase 9 直接调用 `runSlaScan`（纯读、可重入，但每轮会多跑一次全表扫描）。
  必须在 Phase 9 冻结时二选一。
- **缺口 B（计数 vs 明细不同源）**：`facts` 受 `detailLimit`（默认 50）截断，而计数是**全量**。
  ⇒ "超时 137 条但只能看到 50 条"是必然现象，看板若要下钻需**另定分页口径**。

---

## 3. ③ HQ export 现有隐私字段与权限边界

### 3.1 权限边界（代码级）

| 层 | 事实 | 出处 |
|---|---|---|
| 能力 | `CAPABILITY.ADMIN` 注释 = 「修改参数 / 用户 / 门店，**导出 Excel**」 | `services/permission-service.ts:81` |
| 判定 | `can(ADMIN)` ⇒ `actor.roles.includes(ROLE.HQ_ADMIN)` | `permission-service.ts:303-304` |
| 文档一致 | 角色矩阵「导出 Excel」= 仅**总部管理员** | `docs/API.md:276` |
| 原生 ACL | 四业务角色 strategy 全为 `['view','list','get']`，**不含 export** | `constants.ts:1643-1648` |
| 原生资源授权 | `NATIVE_READ_ALLOWLIST` 只给 `list/get` | `constants.ts:1428-1433` |
| 行为设防 | `FORBIDDEN_READ_ACTIONS` 显式含 `export` | `plugin.ts:111` |
| 中间件 | `storeScope` 的 `READ_ACTIONS = ['list','get','export']` —— **已为 export 预留范围裁剪分支** | `middleware/store-scope.ts:43` |

### 3.2 🔴 取证发现 D3：原生导出对平台超管仍然可用，且**不经脱敏**

`root` / `admin` **绕过全部 ACL**（`constants.ts:1127` 引 NocoBase 源码；`permission-service.ts:264-271` 按总部管理员对待）。
⇒ `GET /api/serviceTickets:export`（NocoBase 内置 export）**对超管可用**，
而**脱敏只存在于我们自己的 `/api/svc` action 层**（`maskTicketForActor` / `maskVisitForActor`），
`storeScope` 只会**注入 filter** 而**不改字段**。
`docs/API.md:306-312` 的「原生接口使用边界」只把 *list/get* 列为允许，**未把 export 列为允许** ⇒ 现状是"文档不允许、超管实际能做"。
⇒ **Phase 9 若做导出，必须在服务端自研 action 内完成脱敏与审计**（或显式关闭原生 export）。

### 3.3 隐私字段清单（脱敏口径现状）

| 机制 | 覆盖字段 | 出处 |
|---|---|---|
| `maskTicketForActor` | `customer_mobile`、`technician_mobile` | `permission-service.ts:508-516` |
| `maskVisitForActor` | 删 `NATIVE_READ_FIELD_DENY.serviceVisits` + `token_revoked_at`；`technician_mobile` 脱敏 | `actions/svc/_mask.ts:41-66` |
| 凭据列总表 | `serviceTickets`: `feedback_token_hash/_expires_at/_used_at`；`serviceVisits`: `access_token_hash/token_expires_at/token_used_at`；`ticketEvents`/`smsLogs`: `[]` | `constants.ts:1531-1542` |
| 手机号可见性 | `VIEW_RAW_MOBILE` = 非 `MASK_MOBILE_ROLES`（`= [VIEWER]`）才可看原文 | `permission-service.ts:300-301`、`constants.ts:1120` |
| 短信收件人 | `sms_logs.recipient_masked` **本身就只存掩码** | schema（Phase 8 取证） |

⚠️ **导出新增风险（三处）**：
1. `TICKET_READONLY_FIELDS`（`constants.ts:1146+`）里的 `status/escalated/reopen_count/review_status/dispatch_at/completed_at/closed_at/first_response_at/ticket_no/feedback_token_*` 是**只读**（后台不能改），**不是不可见** ⇒ 导出若直接 dump 整行，这些列会一并出去（token 哈希列须走 `NATIVE_READ_FIELD_DENY` 排除）。
2. 收费类列在 **`service_visits`**（`is_charged / confirmed_charge_amount / customer_charge_match / customer_reported_amount / charge_diff_reason / reported_charge_amount`），**不在 `service_tickets`** ⇒ 导出"收费"维度必须 join Visit。
3. 导出需考虑 **CSV 注入**（`docs/API.md:226`"防 CSV 注入"）与**导出事件留痕**（同处"写导出事件"）。

---

## 4. ④ 指标分母 / 时间口径的既存定义

### 4.1 文档级：`API.md §5` 的 12 项口径（**全部未实现**）

`docs/API.md:280-300`。逐项核对"落地可行性"如下：

| # | 指标 | 文档口径 | 代码可行性 / 隐患 |
|---|---|---|---|
| 1 | 首次响应时长 | `first_response_at - created_at` | ✅ 字段存在，受理时 `COALESCE(first_response_at, now())` 首写（`ticket-service.ts:836,860-862`） |
| 2 | 闭环时长 | `closed_at - created_at` | ⚠️ 需核实 `closed_at` 是否真被写（`TICKET_READONLY_FIELDS` 只证明列存在） |
| 3 | 待受理超时率 | 超 `sla.accept_minutes` 仍为 NEW | ✅ 与 Phase 8 `acceptanceOverdue` **同义，可直接复用** |
| 4 | **预约逾期未回执数** | `expected_visit_at < now` 且 PROCESSING 且无 `submitted_at` | 🔴 **正是 DEV-71 禁止的伪精度口径**（把 DB 的 12:00 当真实到达时刻）⇒ 必须改用 `appointmentOverdueFrom` |
| 5 | **待门店确认数/时长** | `submitted_at → store_confirmed_at` | 🔴 `store_confirmed_at` 语义已泛化为"**处置**时间"（`visit-service.ts:695`：**驳回也写**）⇒ 会把驳回混进"确认时长" |
| 6 | 评价参与率 | `review_status=submitted` / 进入过 WAIT_FEEDBACK | ⚠️ 分母需事件或字段支撑，待裁决 |
| 7 | 平均评分 / 低评分率 | 已评价均值；`rating ≤ 阈值` | 阈值 = `feedback.low_score_threshold = 2`（`constants.ts:1825-1828`） |
| 8 | 重开率 | `reopen_count > 0` / 已完成工单 | ⚠️ 分母"已完成"需定义（= CLOSED？） |
| 9 | 短信送达率 | `delivery_status=delivered` / 已提交短信 | ⚠️ 已注明 `accepted ≠ delivered`（`DEVIATIONS.md`） |
| 10 | 确认收费金额 | `confirmed_charge_amount` 按门店/时间/方式汇总 | ⚠️ 在 `service_visits`，需 join |
| 11 | 处理方式分布 | `inhouse/manufacturer/third_party/remote` | ✅ = `SERVICE_MODE`（`shared/service-mode.ts:35-44`，与 `API.md:294` 逐值一致） |
| 12 | 收费不一致率 | `customer_charge_match=mismatch` / 有收费且完成评价的 Visit | ⚠️ 分母口径待裁决 |

筛选维度（`API.md:297`）：`date range / store / ticket_type / status / service_mode / rating`。
`API.md:300` 明确**不提供**"实际上门准时率/到达时间"类指标。

### 4.2 代码级：已存在、可直接复用的口径

| 口径 | 定义 | 出处 | 用途 |
|---|---|---|---|
| **SLA 三类超时** | 见 §2.4（含 `appointmentOverdueFrom`） | `sla-scan-scheduler.ts` | **唯一"超时"权威定义** |
| 进入某状态的时刻 | 最后一条 `ticket_events.to_status == status` 的 `created_at` | `client/timeliness.ts:132-144` `enteredStatusAt` | 展示文案 |
| 时长人话化 | 只到**分钟** | `timeliness.ts:70-81` | 展示 |
| 预约日期展示 | 只到**天**，**刻意不提供 HH:mm** | `timeliness.ts:111-123` | 展示 |
| 时区基准 | `TZ=Asia/Shanghai`；`APPOINTMENT_TIMEZONE_OFFSET='+08:00'` | `PHASE-1.md:1398`、`service-mode.ts:291` | 日界 |
| 处置时间 | `store_confirmed_at` = 门店确认**或驳回**（O5） | `visit-service.ts:695-696` | ⚠️ 见 §4.1 #5 |
| 完成时刻 | `completed_at` = 门店确认完成（Phase 7 冻结）；`reviewed_at` = 评价完成 | Phase 7 冻结语义 | 不得重解释 |

> ⚠️ `timeliness.ts:4-8` 文件头**明写**："**不做 SLA 引擎，也不做指标墙**；预警阈值、SLA 扫描任务、总部异常看板**全部留在 Phase 9**"。
> ⇒ 它是 Phase 9 可用的**既有展示口径**，但**不得**被当成 SLA 判定来源。

### 4.3 🔴 必须在 Phase 9 冻结的**三处口径冲突**

| # | 冲突 | 各自出处 | 建议（待裁决） |
|---|---|---|---|
| C1 | **预约逾期**：伪精度 vs DEV-71 日期语义 | `API.md:287` ⇄ `sla-scan-scheduler.ts:176-190` | 取 **Phase 8**；同步修订 `API.md §5`，避免 Dashboard 与 scheduler 各写一套"超时" |
| C2 | **待门店确认"终点"**：`store_confirmed_at` 驳回也写 | `API.md:288` ⇄ `visit-service.ts:695` | 需定义"确认时长"是否含驳回；或改用事件类型区分处置结果 |
| C3 | **等待时长起算**：事件口径 vs 字段口径 | `timeliness.ts:132-144`（事件 `to_status`）⇄ `sla-scan-scheduler.ts`（字段 `created_at`/`submitted_at`） | 看板须二者择一；若两处并存，**必须明示二者数字不同** |

---

## 5. 建议的 Phase 9 边界（**建议，未冻结**）

1. **单一 SLA 事实源**：Phase 9 的一切 overdue 数字**只能**来自 `runSlaScan` 的 `SlaScanResult` / `SLA_SOURCE` / `appointmentOverdueFrom`，**不得**新写谓词。
2. **导出 = 自研 action**：`/api/svc:exportTickets`（`CAPABILITY.ADMIN` + `applyScope` + `maskTicketForActor`/`maskVisitForActor` + 防 CSV 注入 + 写导出事件），并订正 D1 漂移。
3. **先冻结 KPI 分母/时间基准，再实现**（含 C1/C2/C3 三处裁决与 `API.md §5` 修订）。
4. **补写 AT-15 条文**（D2），否则验收无法判定。
5. 复用既有展示口径（`timeliness.ts`）做看板文案，但**判定与展示分离**。
6. 不做：营业时间日历、实际上门准时率类不可验证 KPI（`API.md:300` 已明令）。

---

## 6. 复现命令（ASCII 锚点）

```bash
# ① 报表/看板/导出 action 是否存在
grep -rn "SVC_ACTION\." nocobase/plugins/service-ticket/src/server/constants.ts | sed -n '1,40p'
grep -rn "export/tickets\|SVC_ACTION.EXPORT" --include=*.ts --include=*.md .

# ② SLA fact 生产/消费链路
grep -rn "putFact\|getFact\|SLA_SCAN" nocobase/plugins/service-ticket/src/server

# ③ 导出权限与脱敏
grep -rn "CAPABILITY.ADMIN\|ROLE_ACL_ACTIONS\|NATIVE_READ_FIELD_DENY" nocobase/plugins/service-ticket/src/server

# ④ KPI 口径
sed -n '280,300p' docs/API.md
grep -rn "store_confirmed_at" nocobase/plugins/service-ticket/src/server/services/visit-service.ts
```

---

## 7. 本文的性质

- 本文**只取证、不改代码、不冻结语义**。
- 所有结论均可由 §6 命令复现；任何与本文不符的后续实现，须先说明为何漂移。
- 取证日期：**2026-09-26**。基线：Phase 8 🔒 CLOSED / PASS（`94fa3db` → `fe5548c`）。
