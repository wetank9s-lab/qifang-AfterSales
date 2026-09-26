# Phase 9 契约：HQ Dashboard / SLA / Reports / Export

> **状态**：口径 **🔒 已冻结（2026-09-26）** · 实现 **⬜ 未开始**
> **基线**：Phase 8 🔒 CLOSED / PASS（`94fa3db` → `fe5548c`）；开工前取证 `docs/PHASE-9-PREWORK.md`（`08e0907`）
> **本文性质**：契约。冻结 KPI 口径与接口边界；**不含实现**。任何与本文不符的实现须先说明为何漂移。
> **核心原则**：Phase 9 **不发明"超时"定义**，一切 overdue 数字消费 Phase 8 已冻结的 SLA predicate/fact。

---

## §0 一句话口径总表

| 决策 | 冻结结论 |
|---|---|
| 单一 SLA 事实源 | 只允许来自 `runSlaScan` / `SLA_SOURCE` / `appointmentOverdueFrom`；**全仓不得出现第二处 overdue 谓词** |
| C1 预约逾期 | 取 **Phase 8 DEV-71 日期语义**；`API.md §5` 用**时态批注**订正（不改写历史） |
| C2 待门店确认 | 指标改名为 **「待门店处置数 / 处置时长」**，**含确认与驳回**（O5 口径） |
| C3 时间起算 | **判定/聚合用字段口径；展示用事件口径**；文档明示两者数字可能不同 |
| C4 短信送达率 | 🔴 **不可实现**（`delivery_status` 永为 `pending`，无回执入口）⇒ 改为 **「短信提交成功率」**（`send_status`） |
| 超时明细来源 | 看板**实时复用 `runSlaScan`**（按需分页），health 继续只读缓存 |
| 交付范围 | **看板 + KPI + 导出一次做全**（单一阶段内闭环） |

---

## §1 目标与范围

### 1.1 做

1. **看板** —— `GET /api/svc:dashboardSummary`：聚合计数 + 分组 + **超时明细（分页）**，按 actor 范围裁剪。
2. **报表** —— `GET /api/svc:reportKpi`：**12 项 KPI**（§3），支持筛选维度。
3. **导出** —— `GET /api/svc:exportTickets`：自研导出（脱敏 + 防 CSV 注入 + 导出事件），仅 `hq_admin`。
4. **订正** —— D1 注释漂移、D2 补写 AT-15 条文、`API.md §5` 时态批注、D3 闭合（§9）。

### 1.2 不做（并入 §11）

营业时间日历 · 实际上门准时率 / 到达时间类不可验证 KPI（`API.md:300` 已明令）· 外部告警 webhook ·
delivery callback 回执入口 · 新增 Ticket 状态 / 状态迁移 · 让 health 承担 Dashboard 职能。

---

## §2 单一 SLA 事实源（🔒 冻结）

| 类型 | 谓词（**不得重写**） | 基准 | 出处 |
|---|---|---|---|
| acceptance | `status = 'NEW'` | `created_at + sla.accept_minutes` | `sla-scan-scheduler.ts:412-426` |
| store_confirm | Visit `visit_status = 'SUBMITTED'` | `service_visits.submitted_at + sla.store_confirm_hours` | 同上 |
| appointment | Ticket ∈ `[NEW, PROCESSING, WAIT_STORE_CONFIRM]` 且**无** `CONFIRMED` Visit | `appointmentOverdueFrom(expected_visit_at, grace)` | `sla-scan-scheduler.ts:176-190` |

**`appointmentOverdueFrom` 不得被替代**：裸日期 → 当地 `23:59:59.999+08:00` → `+ grace*60000`。
任何 `expected_visit_at + graceMs` 形式都是实现错误（DEV-71）。

**阈值**（`constants.ts`）：`sla.accept_minutes=120`（`:1855`）· `sla.appointment_overdue_grace_minutes=120`（`:1862`）· `sla.store_confirm_hours=48`（`:1873`）。

**门禁断言**：`grep -rn "expected_visit_at" src/server/actions/svc src/server/services` 中，**除**复用 `appointmentOverdueFrom` 的调用外，不得出现新的比较表达式。

---

## §3 KPI 口径冻结（12 项）

**通用规则**

- **时间基准统一 `Asia/Shanghai`**（`TZ=Asia/Shanghai`；`APPOINTMENT_TIMEZONE_OFFSET='+08:00'`）。
- **字段口径优先**（C3）：聚合用 DB 字段；`client/timeliness.ts` 保留为**展示**口径，**不得**作为判定来源。
- 筛选维度：`date range / store / ticket_type / status / service_mode / rating`（`API.md:297`）。
- 日期范围一律按 **`created_at` 落在窗口**（半开区间 `[from, to)`）选取工单集合。

| # | 指标 | 冻结口径 | 分母 | 来源字段 |
|---|---|---|---|---|
| 1 | 首次响应时长 | `avg(first_response_at - created_at)`，仅 `first_response_at IS NOT NULL` | 有首响的工单 | `first_response_at`（受理时 `COALESCE(…, now())`，`ticket-service.ts:862`） |
| 2 | 闭环时长 | `avg(closed_at - created_at)`，**分母限定 `status='CLOSED'`** | `status='CLOSED'` 的工单 | `closed_at`（`:1043` 取消 / `:2611` 评价关闭）；⚠️ **取消也写 `closed_at`**，必须靠 `status` 过滤 |
| 3 | 待受理超时率 | **复用 Phase 8 `acceptanceOverdue`**（不再另算） | 窗口内建单数（`status<>'CANCELLED'`） | `SLA_SOURCE.acceptance` |
| 4 | 预约逾期未回执数 | **复用 Phase 8 `appointmentOverdue`** + 明细 | —（计数） | `appointmentOverdueFrom`（**禁止** `expected_visit_at < now`） |
| 5 | 待门店**处置**数 / 处置时长 | 计数复用 Phase 8 `storeConfirmOverdue`；时长 = `avg(store_confirmed_at - submitted_at)`，**含确认与驳回** | 已处置 Visit（`store_confirmed_at` 非空） | `store_confirmed_at`（`:641` 确认 / `:696` 驳回）；`submitted_at` |
| 6 | 评价参与率 | `review_status='submitted'` / 已发出邀约 | `review_status IS NOT NULL` | `review_status`（`REVIEW_STATUS` = pending/submitted/expired） |
| 7 | 平均评分 / 低评分率 | `avg(rating)`；低分 = `rating <= feedback.low_score_threshold` | `review_status='submitted'` | `rating`；阈值 `constants.ts:1825-1828`（默认 2） |
| 8 | 重开率 | `reopen_count > 0` | `review_status='submitted'`（**重开只发生在提交评价时**，`ticket-service.ts:2598` 是唯一自增点） | `reopen_count`（`serviceTickets.ts:146`，default 0） |
| 9 | **短信提交成功率**（原「送达率」） | `send_status='accepted'` / 已提交供应商 | `send_status ∈ (accepted, rejected, error)` | `sms_logs.send_status`（`SMS_SEND_STATUS`） |
| 10 | 确认收费金额 | `sum(confirmed_charge_amount)` 且 `is_charged = true` | —（求和） | `service_visits.confirmed_charge_amount` / `is_charged`（**必须 join Visit**） |
| 11 | 处理方式分布 | `count(*) group by service_mode` | 窗口内工单 | `SERVICE_MODE`（`shared/service-mode.ts:35-40`） |
| 12 | 收费不一致率 | `customer_charge_match='mismatch'` / 有收费结论的 Visit | `customer_charge_match ∈ (match, mismatch)`（**排除 `not_applicable`**） | `service_visits.customer_charge_match`（`CHARGE_MATCH`） |

**可复议项（本阶段先冻结，若有异议再改）**：#6 分母取"已发出邀约"而非"曾进入 `WAIT_FEEDBACK`（事件口径）"；
#8 分母取"已提交评价"而非"所有发过邀约的工单"（后者含 `expired`，会稀释重开率）。

---

## §4 冲突裁决记录（🔒）

| # | 原冲突 | 裁决 |
|---|---|---|
| **C1** | `API.md:287`（`expected_visit_at < now` 伪精度）⇄ `sla-scan-scheduler.ts:176-190`（DEV-71 日期语义） | **取 Phase 8**。`API.md §5` 按项目铁律用**时态批注**订正（原文保留 + `> ✅ 已于 2026-09-26 …`），**不改写历史** |
| **C2** | `store_confirmed_at` 驳回也写（`visit-service.ts:641` / `:696`） | 指标**改名「待门店处置」**，口径 = 含确认与驳回；与字段、O5 一致，不新增判定来源 |
| **C3** | 事件口径（`timeliness.ts:132-144`）⇄ 字段口径（scheduler `created_at`/`submitted_at`） | **判定/聚合用字段；展示用事件**。看板返回字段口径数字；前端文案仍走事件口径；文档明示两者可能不同 |
| **C4** | 原 KPI #9「短信送达率」 | 🔴 **不可实现**：`delivery_status` 在代码里**永为 `pending`**——`sms-service.ts:20/555/611` 明写"只能由供应商回执更新"，而 Phase 8 明确**不做 delivery callback**；`sms-provider.ts:54` 更在类型层禁止 Provider 声称 `delivered`。⇒ 改为**「短信提交成功率」**（`send_status`）。`delivered_at` / `delivery_status` 相关指标**本阶段不做**，待有回执入口再启用 |

---

## §5 看板契约 —— `GET /api/svc:dashboardSummary`

**鉴权**：已登录 svc 主体；按 actor 范围裁剪（`scopeOf` + `applyScope`，`middleware/store-scope.ts`）。**任何角色都可能访问，但只能看到自己范围内的数据**。

**入参**：`from` / `to`（date range）· `storeId?` · `ticketType?` · `serviceMode?` · `ratingMin?`
**超时明细分页**：`overdueKind=acceptance|appointment|store_confirm` · `page`（默认 1）· `pageSize`（默认 20，上限 100）

**出参（结构约束）**

```
{
  window: { from, to },
  totals:  { tickets, new, processing, waitStoreConfirm, waitFeedback, closed, cancelled },
  overdue: { acceptance, appointment, storeConfirm, scannedAt, thresholds },   // 与 health 同源
  overdueDetail?: { kind, page, pageSize, total, items: SlaOverdueFact[] },     // 仅当传 overdueKind
  breakdown: { serviceMode: {...}, store: {...} }
}
```

**实现约束（重要）**

1. **超时数字**直接取 `runSlaScan` 的产出，**不得**另写谓词。
2. **明细实时复用**（缺口 A 解法）：调用 `runSlaScan({ detailLimit: (page-1)*pageSize + pageSize })` 后 `.slice(...)`。
   —— 这样复用**完全相同的谓词**，且不受默认 `detailLimit=50` 截断；代价是每次请求多跑一次全表扫描（可加短 TTL memo，非必需）。
   ⚠️ 需先确认 `facts[]` 的**排序是确定性的**（按 `dueFrom` 升序）；若不确定，看板侧自行排序（**不改 Phase 8**）。
   ⚠️ `runSlaScan` / `SLA_SOURCE` / `slaPortFromServices` 当前是内部实现 —— Phase 9 需把它们**提为可复用入口**（导出或 service facade），**不改其判定逻辑**。
3. **缺口 B**：计数是**全量**、明细受分页 —— 看板必须显式展示 `total` 与当前页，避免"137 条只看到 20 条"被误读。
4. **不得**寄生在 `health` 上（`actions/public/health.ts:129-150` 已冻结：health 只给聚合计数 + 运行状态，不返回工单明细）。

---

## §6 报表契约 —— `GET /api/svc:reportKpi`

**鉴权**：`can(CAPABILITY.PRIVILEGED)`（`hq_after_sales` / `hq_admin`）。
**入参**：`from` / `to`（必填）· `storeId?` · `ticketType?` · `status?` · `serviceMode?` · `ratingMin?`
**出参**：`{ window, filters, kpis: [ { key, label, value, unit, denominator, basis } ] }`
—— 每项**必须带 `denominator` 与 `basis`**（`basis='field'`），使口径**自证**，禁止只回一个裸数字。
**约束**：12 项口径必须与 §3 逐字一致；口径变更须先改本文档。

---

## §7 导出契约 —— `GET /api/svc:exportTickets`

| 项 | 冻结要求 |
|---|---|
| 鉴权 | **仅 `can(CAPABILITY.ADMIN)`（`hq_admin`）**；其余一律 403 |
| 范围 | `applyScope` 注入 filter（**不得**只靠前端筛选） |
| 脱敏 | 走 `maskTicketForActor` / `maskVisitForActor`；**排除** `NATIVE_READ_FIELD_DENY` 全部列（`feedback_token_*` / `access_token_hash` / `token_expires_at` / `token_used_at`）；手机号按角色（`VIEW_RAW_MOBILE`） |
| 防 CSV 注入 | 单元格以 `= + - @` 或制表符开头时强制加前缀（`'`）；统一引号转义 |
| 审计 | **写导出事件**（TicketEvent 或专用导出日志），含 actor / 筛选条件 / 行数 / 时间 |
| 规模 | 流式输出，避免一次性载入内存；上限阈值须显式（超限拒绝或分片） |
| 收费列 | 在 `service_visits`，**必须 join Visit** |
| 只读列 | ⚠️ `TICKET_READONLY_FIELDS`（`constants.ts:1146+`）是"后台不可改"，**不是不可见** ⇒ 直出整行会带出 `status/escalated/reopen_count/...`，须逐列白名单 |

---

## §8 权限与隐私边界（含 D3 闭合）

| 层 | 现状（已取证） | Phase 9 要求 |
|---|---|---|
| 能力 | `CAPABILITY.ADMIN` ⇒ 导出 | 沿用；报表用 `PRIVILEGED`，看板按 scope |
| 四业务角色原生 ACL | 仅 `['view','list','get']`（`constants.ts:1643-1648`） | 不变 |
| 原生资源授权 | `NATIVE_READ_ALLOWLIST` 只给 `list/get`（`:1428-1433`） | 不变 |
| 启动自检 | `FORBIDDEN_READ_ACTIONS` 含 `export`（`plugin.ts:111`） | 不变 |
| 🔴 平台超管 | `root`/`admin` **绕过全部 ACL**（`constants.ts:1127`）⇒ 原生 `:export` **可用且不经脱敏** | ✅ **已闭合**（D3，2026-09-26 用户裁定「方案 1：闭合」）—— 见 **§8.1**。**不改** NocoBase 全局 root/ACL 机制，只对本插件自有业务资源做**能力层**窄守卫 |

**脱敏口径现状**：`maskTicketForActor`（`customer_mobile` / `technician_mobile`，`permission-service.ts:508-516`）·
`maskVisitForActor`（`actions/svc/_mask.ts:41-66`）· 凭据列总表 `constants.ts:1531-1542`。

---

### §8.1 D3 闭合（🔒 冻结语义 · 2026-09-26 用户裁定「方案 1：闭合」）

> 原文见 §9 D3 行；本节把裁决落成**可实现的边界**。裁定理由（用户原话摘要）：
> **不是因为"超管绝对不能看原始数据"，而是 Phase 9 已经把导出定义成一条独立的高风险数据出境路径。**
> 若同时保留 `root/admin → 原生 serviceTickets:export → 原始字段直出`，那前面这套导出安全边界
> **实际上可以被旁路**，系统会出现「页面/API 权限设计正确，但同一个管理员换一个 endpoint 就能绕开」的
> **双轨语义** —— 不适合作为已知风险长期接受。

**① 唯一受支持出口**

| 项 | 冻结要求 |
|---|---|
| 出口 | `svc:exportTickets`（**ServiceTicket 批量数据只有一个出口**） |
| 授权 | `CAPABILITY.ADMIN`（仅 `hq_admin`）；其余角色 `403` |
| 安全 | `applyScope` 裁范围 → 逐列白名单（排除 `NATIVE_READ_FIELD_DENY` 全部列）→ **固定脱敏** → CSV injection 防护 → 写一条导出审计 |
| 原生 `:export` | 🔴 **对任何角色都不得成为 ServiceTicket 数据导出通路，含 `root`/`admin`** |

**② 实现边界（用户明令，三条都不可越）**

1. **不修改 NocoBase 全局 root/admin ACL 机制** —— 只针对本插件自有业务资源的 native export capability 做**窄守卫**。
   理由：否则「一个导出问题会扩张成平台权限模型改造」。
2. **不在 URL 层封闭** —— 实现前先**取证**当前版本 native export 的真实 action/resource 路径与可能入口，
   然后在**能力/action 层**（`ctx.action.actionName`）封闭；URL grep 只能作为**辅助门禁**。
   （故 `serviceTickets:export`、`?filter=`、body、`filterByTk` 等**所有调用形态**同时被封。）
3. **平台超管若同时持有明确的 `hq_admin` 业务角色**，则按 `svc:exportTickets` **自身既定的授权模型**处理 ——
   **关键点是不能因为 NocoBase superuser bypass 就绕过业务导出策略**。

**③ 导出审计只记必要事实**

| 记 | 不记 |
|---|---|
| 操作者（userId / username / 角色）· 导出时刻 · 筛选范围与日期范围 · 导出条数 · `requestId` · 接口版本 | 🔴 客户手机号 · 整份 CSV 内容 · 任何被导出单元格的值 |

理由（用户原话）：**不要把导出的客户手机号或整份 CSV 内容再塞进 TicketEvent 来"审计导出"，否则反而制造第二份敏感数据副本。**
落点：独立集合 `export_audits`（**不复用 `ticket_events`** —— 该表 `ticket_id` 为 `allowNull:false`，
而"导出"是**跨工单**事件，不该为了它放宽事件表的外键）。

**④ 门禁（只设一个重门禁，不做整个 ACL 的 mutation/reverse 大工程）**

`scripts/verify-native-export-bypass.mjs`，7 条：

1. `hq_admin` 走自研脱敏导出 → **成功**；
2. 非 `ADMIN` 角色走自研导出 → **拒绝**；
3. `root` / `admin` 直接走 ServiceTicket **原生 export** → **被拒绝**；
4. **换一种 native export 调用形态**（`exportAttachments` / body 形态 / `filterByTk`）→ **仍不能旁路**；
5. 自研 CSV 里手机号等敏感字段**符合脱敏规则**；
6. `=` `+` `-` `@` 等危险单元格**被 CSV injection 防护转义**；
7. 成功导出**产生恰好一条审计**；失败/拒绝**不伪造**成功审计。

**⑤ 自研导出授权不变（与本裁定一致，未放宽也未收紧）**

`store_after_sales → 403` · `hq_after_sales → 403` · `viewer → 403` · `hq_admin → 200` ·
`root/admin → 不因平台超管身份自动获得 native bypass`。

> ### ⚠️ D3-a 订正（本阶段，对 §7 "手机号按角色" 的收紧）
>
> §7 原写「手机号按角色（`VIEW_RAW_MOBILE`）」。D3 裁定把导出定为**固定脱敏**，因此实现取
> **更严的一支**：**导出路径的手机号一律脱敏，不随 `VIEW_RAW_MOBILE` 放开**。
>
> 理由是这两句在导出场景下其实是同一件事：若 `hq_admin` 因持有 `VIEW_RAW_MOBILE` 就在 CSV 里拿到
> **全量明文号码**，那么"导出 = 数据出境路径"这个前提就不成立了 —— 一个 admin 一次导出即可带走整个窗口期
> 的全部客户号码。需要看某个客户号码时，走**工单详情**（已有 ACL + 审计），而不是**批量带走**。
> 这条收紧是**可逆的一行改动**，但方向必须是"收紧需论证"而不是"放开需论证"。

---

## §9 订正项

| # | 订正 | 动作 |
|---|---|---|
| **D1** | `constants.ts:1639-1641` 注释称"Phase 6 导出走自研 `/api/svc/export/tickets`"，但该 action **从不存在** | Phase 9 实现 `exportTickets` 后，把注释改为**指向真实存在的 action**；**不得**继续保留"Phase 6 已交付"的表述 |
| **D2** | `AT-15` 被 3 处引用为 Phase 9 验收项，但仓库内**无 AT 条文** | 按 §10 补写 AT-15 条文，否则验收无法判定 |
| **C1 订正** | `API.md:287` 伪精度口径 | **时态批注**（原文保留 + `> ✅ 已于 2026-09-26 按 DEV-71 订正：…`） |
| **D3** | 超管原生导出未脱敏 | 按 §8 二选一闭合 |

---

## §10 验收判据 —— AT-15（**补写**）

> 原文缺失（D2）。以下为本阶段补写的 AT-15 条文，Phase 9 验收以此为准。

1. **单一事实源**：`grep` 断言全仓 overdue 谓词**只有一处**（`SLA_SOURCE`）；看板/报表数字与 `runSlaScan` 完全一致。
2. **DEV-71 边界**：预约逾期对 `expected_visit_at` 的 `12:00` **不敏感**；边界测试——当天 `23:59:59.999` **未**逾期、`+1ms` 逾期、`grace` 生效。
3. **12 项 KPI 可复算**：每项可由 §3 口径独立复算；3 处冲突（C1/C2/C3）+ C4 均按 §4 裁决落地。
4. **导出**：非 `hq_admin` 403；导出内容**不含**任何 `NATIVE_READ_FIELD_DENY` 列与凭据哈希；CSV 注入样本被正确转义；**写下导出事件**。
5. **D3 闭合**：`root`/`admin` 的原生 `:export` **被拒绝**（不是"已声明接受风险"）—— 唯一受支持出口是
   `svc:exportTickets`；换调用形态仍不能旁路（判据见 §8.1 ④，门禁 `verify-native-export-bypass.mjs`）。
6. **门禁**：新增 `verify-report-kpi.mjs`（正向断言 + **反向精确转红**）；`smoke` 不回归（Phase 8 基线 118）。
7. **范围裁剪**：门店角色访问看板只能看到本店数据（越权样本必须为空）。

---

## §11 不做清单

营业时间日历（`sla.clock_mode = calendar elapsed time` 冻结不变）· 实际上门准时率 / 到达时间类 KPI ·
外部告警 webhook（Phase 8 冻结）· delivery callback 回执入口 · 新增 Ticket 状态 / 迁移 ·
把 health 扩成 Dashboard API · 为了看板去污染 Ticket 状态或无条件写 TicketEvent。

---

## §12 交付记录

（待实现后填写：实现 commit / 文档收口 commit / 门禁计数 / AT-15 逐条证据）

---

## §13 复现命令（ASCII 锚点）

```bash
# SLA 单一事实源
grep -rn "appointmentOverdueFrom\|SLA_SOURCE" nocobase/plugins/service-ticket/src/server

# C2 驳回也写处置时间
grep -n "store_confirmed_at" nocobase/plugins/service-ticket/src/server/services/visit-service.ts

# C4 delivery_status 永为 pending
grep -rn "delivery_status\|delivered" nocobase/plugins/service-ticket/src/server/services/sms-service.ts

# D1 漂移注释
grep -n "Phase 6 的导出走自研" nocobase/plugins/service-ticket/src/server/constants.ts

# 口径原文
sed -n '280,300p' docs/API.md
```
