# 状态机与业务规则

> 主状态**只有 6 个**（文档 §5 强制）。任何"差评中/返工中/待重发"一律用字段或事件表达，**不得新增状态**。
> 状态写入唯一入口：`TicketService`。控制器（actions）**禁止**直接改 `status`。

---

## 1. 状态定义

| 代码 | 中文 | 进入条件 | 退出条件 |
|---|---|---|---|
| `NEW` | 待受理 | 客户提交成功 | 受理/派工 → PROCESSING；取消 → CANCELLED |
| `PROCESSING` | 处理中 | 门店受理或已派工；低评分/收费不一致重开 | 师傅提交回执 → WAIT_STORE_CONFIRM；remote 完成 → WAIT_FEEDBACK |
| `WAIT_STORE_CONFIRM` | 待门店确认 | 师傅提交服务回执 | 确认 → WAIT_FEEDBACK；驳回 → PROCESSING |
| `WAIT_FEEDBACK` | 待评价 | 门店确认服务完成 | 客户评价 / 超时 → CLOSED；异常评价 → PROCESSING |
| `CLOSED` | 已关闭 | 正常评价、评价超时、总部手动关闭 | 终态（总部必要时可重开 → PROCESSING） |
| `CANCELLED` | 已取消 | 客户取消 / 重复单 / 无效单 / 号码错误 | 终态 |

## 2. 状态迁移图

```
                    ┌──────────────── transfer（改 store_id，状态不变） ────────────────┐
                    ▼                                                                  │
  客户 createTicket                                                                     │
        │                                                                               │
        ▼                                                                               │
    ┌───────┐  accept / dispatch   ┌────────────┐  technicianSubmit   ┌────────────────────┐
    │  NEW  │ ───────────────────▶ │ PROCESSING │ ──────────────────▶ │ WAIT_STORE_CONFIRM │
    └───────┘                      └────────────┘                     └────────────────────┘
        │                               ▲    ▲                                  │      │
        │ cancel                        │    │ reject（保留回执与照片）           │      │ confirm
        ▼                               │    └──────────────────────────────────┘      │
   ┌───────────┐                        │                                              ▼
   │ CANCELLED │                        │                                    ┌─────────────────┐
   └───────────┘                        │                                    │ WAIT_FEEDBACK   │
                                        │                                    └─────────────────┘
                                        │  review → 低评分 或 收费不一致               │      │
                                        └───────────────────────────────────┘      │      │ autoClose
                                          (escalated=true, reopen_count+1)         │      │ (超时)
                                                                                   ▼      ▼
                                                                              ┌────────────┐
                                                                              │   CLOSED   │
                                                                              └────────────┘
```

## 3. 合法迁移表（唯一路径）

| # | 动作 | From | To | 前置校验（不满足则拒绝，不改任何数据） | 同事务副作用 |
|---|---|---|---|---|---|
| M1 | `createTicket` | — | NEW | 门店 active；`ticket_type` 合法；`content` 5–500 字；手机号格式；IP/手机号限流通过；`request_id` 未被用过 | 取 ticket_no；写 `created` 事件；写幂等记录 |
| M2 | `accept` | NEW | PROCESSING | `status=NEW` 且操作人有该门店权限 | `handler_user_id`；`first_response_at`（仅首次）；写 `accepted` |
| M3 | `dispatch` | NEW / PROCESSING | PROCESSING | 有权限；`service_mode` 合法；非 remote 时 预约时间/师傅姓名/手机号必填 | 新建 ServiceVisit（`visit_no=max+1`）+ 师傅 Token；`dispatch_at`（仅首次）；`technician_*`/`expected_visit_at` 同步到 Ticket；发**客户短信 + 师傅短信**；写 `dispatched` + `sms_sent` |
| M4 | `reassign` | PROCESSING | PROCESSING | 存在 `visit_status = ASSIGNED` 的当前 Visit（**仅此一态可改派**） | **旧 Token 立即失效**；旧 Visit → `SUPERSEDED`（**原样保留**：师傅快照、预约时间、已上传照片，一个字段都不改）+ **新建** Visit（`visit_no+1`、新师傅、新 Token、`reassigned_from_visit_id` 指回旧 Visit）；发客户更新短信 + 新师傅任务短信 + **原师傅取消短信**；写 `reassigned` |
| M5 | `reschedule` | PROCESSING | PROCESSING | 存在 `visit_status = ASSIGNED` 的当前 Visit | **不新建 Visit**（执行责任人没变）；旧 Token **吊销并签发新 Token**；仅改 `expected_visit_at`；发更新短信给客户 + 师傅；写 `rescheduled` |
| M6 | `transfer` | NEW / PROCESSING | 不变 | 目标门店 active 且 ≠ 当前；填原因 | 改 `store_id`；**`source_store_code` 不变**；写 `transferred`（含原/新门店、操作人、时间） |
| M7 | `cancel` | NEW / PROCESSING | CANCELLED | 填原因 | `close_reason`；写 `cancelled` |
| M8 | `technicianSubmit` | PROCESSING | WAIT_STORE_CONFIRM | Token 有效 + 未使用 + 未过期 + 绑定的 Visit 属于该 ticket 且 `store_confirm_status=pending`；`service_result` 必填；`service_note` **条件必填**（`resolved` 可留空、其余必填，≤500 字，见 DEV-82）；`is_charged=true → amount>0`，`false → amount=0` | 写 Visit 回执；`token_used_at` 置位（**Token 立即失效**）；`store_confirm_status=pending`；**绝不发客户评价短信**；写 `technician_submitted` |
| M9 | `confirm` | WAIT_STORE_CONFIRM | WAIT_FEEDBACK | 操作人有权限；Visit `store_confirm_status=pending`；若 `confirmed_charge_amount ≠ reported_charge_amount` 则**必须填原因** | 写 `confirmed_*`；`completed_at`；生成评价 Token（`feedback_token_hash` / `expires` / `feedback_visit_id` / `review_status=pending`）；**此时才**发评价短信；写 `store_confirmed` + `completed` + `sms_sent` |
| M10 | `reject` | WAIT_STORE_CONFIRM | PROCESSING | 必填原因 | `store_confirm_status=rejected` + 原因；**Visit 与照片全部保留**；写 `store_rejected` |
| M11 | `remoteComplete` | PROCESSING | WAIT_FEEDBACK | `service_mode=remote` | 建一条 `is_remote=true` 的 Visit（无 Token）并直接确认；生成评价 Token + 发评价短信；写 `completed` |
| M12 | `review`（正常） | WAIT_FEEDBACK | CLOSED | Token 有效未用未过期；`1 ≤ rating ≤ 5`；`rating > low_score_threshold`；`charge_match ∈ {match, not_applicable}` | 写 rating/comment/`reviewed_at`；`review_status=submitted`；`close_reason=reviewed`；`closed_at`；写 `reviewed` + `closed` |
| M13 | `review`（异常） | WAIT_FEEDBACK | **PROCESSING** | 同上，但 `rating ≤ 阈值` **或** `charge_match=mismatch` | 写 rating/comment；`escalated=true`；`reopen_count+1`；**不关闭**；写 `reviewed` + `reopened`；进总部异常看板 |
| M14 | `autoClose`（定时） | WAIT_FEEDBACK | CLOSED | `now > feedback_token_expires_at` 且 `review_status=pending` | `review_status=expired`；`close_reason=review_expired`；写 `closed` |
| M15 | `hqReopen` | CLOSED | PROCESSING | 总部角色；填原因 | `escalated=true`；`reopen_count+1`；写 `reopened` |

**非法迁移示例（必须被拒绝并记 warning 日志，不得静默成功）**
- `WAIT_STORE_CONFIRM → CLOSED`（师傅提交后直接关闭）❌
- `WAIT_FEEDBACK → CLOSED` 且 `rating ≤ 阈值` ❌
- `WAIT_FEEDBACK → CLOSED` 且 `charge_match=mismatch` ❌
- 对已 `submitted` 的评价 Token 再次提交 ❌
- 对已 `used` 的师傅 Token 再次提交或上传 ❌

## 4. 并发与幂等

| 场景 | 机制 |
|---|---|
| 两个门店人员同时派工 | `UPDATE service_tickets SET status=..., dispatch_at=... WHERE id=$1 AND status=$2`；**影响行数 = 0 即冲突**，抛 `CONFLICT_STATE_CHANGED`，不产生第二条短信 |
| 客户连点提交 | 客户端带 `request_id`（UUID）；`idempotencyRecords` 唯一约束命中 → 直接返回首次结果 |
| 相同内容重复提交 | 同 `customer_mobile + store_id + ticket_type` + `content` 相似度 + 10 分钟窗口 → 返回已有 `ticket_no` 并提示（不新建） |
| 短信回执重复推送 | `unique(provider, biz_id)` 冲突 → 幂等更新，**不重复写 TicketEvent** |
| 评价 Token 重复提交 | `feedback_token_used_at` 非空 → 返回 `TOKEN_ALREADY_USED`，**不覆盖原评价**（重复打开只显示"已提交"） |
| Visit 取号并发 | 事务内 `SELECT max(visit_no) ... FOR UPDATE` + `unique(ticket_id, visit_no)` 兜底 |
| 工单号取号并发 | `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`（原子） |

## 5. Token 生命周期

| Token | 绑定 | 默认有效期 | 失效触发 | 存库 |
|---|---|---|---|---|
| 师傅作业 Token | `serviceVisit.id` | 72h（`technician.token_expire_hours`，可配） | 提交（用后即焚）/ 改派 / 改约 / 过期 | `serviceVisits.access_token_hash` + `token_used_at` |
| 客户评价 Token | `serviceTicket.id` + `feedback_visit_id` | 15 天（`feedback.token_expire_days`） | 评价提交 / 过期 / 门店驳回后重发（覆盖旧 hash） | `serviceTickets.feedback_token_hash` + `feedback_token_used_at` |

> 生成算法：`crypto.randomBytes(32).toString('base64url')`；入库前 `sha256`。校验时对入参 `sha256` 后按唯一索引查表。
> 所有失败响应统一 `TOKEN_INVALID`，不区分"不存在 / 已使用 / 已过期"，避免枚举探测。

## 6. SLA 与定时任务

| 任务 | 频率 | 逻辑 | 输出 |
|---|---|---|---|
| `slaScan` | 每 5 分钟 | NEW 超 `sla.accept_minutes` → 标 `accept_overdue`；PROCESSING 且 `expected_visit_at + grace < now` 且无有效回执 → 标 `appointment_overdue`；WAIT_STORE_CONFIRM 超 `sla.store_confirm_hours` | 不新增状态，只在看板与列表派生展示；可选写事件 `sla_flagged`（归入 metadata） |
| `reviewExpire` | 每小时 | M14 | CLOSED + `review_status=expired` |
| `smsRetry` | 每 5 分钟 | `send_status=error` 或 `delivery_status=failed` 且 `retry_count < sms.retry_count` | 重发 1 次；仍失败 → `sms_failed` 事件 + 工单标"通知异常" |
| `guardCleanup` | 每天 | 清理 `apiGuards.expires_at < now` 与 30 天前 `idempotencyRecords` | — |

> 所有 cron 表达式与阈值均来自 `systemSettings`，**不写死在代码**。

---

## 7. ServiceVisit 的生命周期（Phase 4 起）

**模型口径**（裁定记录见 `docs/DEVIATIONS.md` DEV-38）：

> `ServiceTicket` = 一次客户售后事项（上表 6 个主状态不变）
> `ServiceVisit` = **一次「具体执行责任的派工尝试」**

**只要执行责任人发生变化，就新建一条 Visit，绝不修改旧 Visit 的师傅身份。**
于是"历史不可覆盖"是**数据模型**的必然结果，而不是代码评审时的约定。

责任主体的判据 = **`technician_mobile` + `provider_name` + `service_mode`**。
**姓名不在其中** —— 只纠正姓名错别字属同一责任主体，可就地改但必须写 `metadata_corrected` 事件。

### 7.1 状态迁移（`visit_status`，Visit 生命周期的唯一事实来源）

```
                    dispatch（新建 Visit，visit_no+1）
                              ↓
                        ┌─ ASSIGNED ─┐
        technicianSubmit│            │reassign → 旧行转 SUPERSEDED，并**新建**下一条
                        ↓            │cancel
                    SUBMITTED        └────────→ CANCELLED
                     ┌──┴──┐
              confirm│     │reject
                     ↓     ↓
                CONFIRMED  REJECTED
```

| `visit_status` | 含义 | 可再迁移到 | 说明 |
|---|---|---|---|
| `ASSIGNED` | 已派给师傅，等待上门/提交 | `SUBMITTED` / `SUPERSEDED` / `CANCELLED` | 新建 Visit 的初始态。**唯一可被 `reassign` 取代的状态** |
| `SUBMITTED` | 师傅已上传照片与处理结果 | `CONFIRMED` / `REJECTED` | 师傅已实际上门，此时**禁止改派** —— 覆盖它等于抹掉已发生的服务事实 |
| `CONFIRMED` | 门店审核通过 | —（终态） | 业务流程已继续（评价 Token 已发出） |
| `REJECTED` | 门店驳回本次回执 | —（终态） | 正确做法是**新建**下一条 Visit，而不是把这条改派掉 |
| `SUPERSEDED` | **原派工安排被另一条派工取代** | —（终态） | 既不是"失败维修"也不是"已上门"，语义上是"这条安排作废了"。**行内师傅快照原样保留** |
| `CANCELLED` | 本次服务安排被取消 | —（终态） | |

### 7.2 `reassign` 的标准事务（顺序不可交换）

1. 锁 Ticket（`SELECT ... FOR UPDATE`），校验 `status = PROCESSING`
2. 锁当前 Visit，校验 `visit_status = ASSIGNED`（否则拒绝，见 §7.1）
3. 旧 Token **立即失效**（置 `token_revoked_at` / `token_revoked_reason='reassigned'`）
4. 旧 Visit → `SUPERSEDED`，写 `superseded_at` / `superseded_reason`（**其余字段一个都不改**）
5. **新建** Visit：`visit_no = max+1`、新师傅快照、`reassigned_from_visit_id = 旧 Visit id`
6. 为新 Visit 签发**全新** Token
7. 写 `TicketEvent(reassigned)`（metadata 含旧/新师傅完整快照与原因，便于只读事件也能还原过程）
8. **产生三条短信任务**：客户更新、新师傅任务、**原师傅取消**
9. **COMMIT**

外部短信的实际发送**在事务提交之后**执行 —— 供应商超时不能把数据库事务锁住。

### 7.3 为什么必须有「原师傅取消短信」

旧 Token 失效只是让链接打不开，**师傅本人并不知道任务没了**。
只失效不通知，王师傅仍会按原预约时间跑到客户家 ——
系统里这条任务已经不存在，现场却来了个人，是最糟的错配。
因此改派事务必须同时产生一条发给原师傅的取消短信（scene `technician_assignment_cancelled`）。

### 7.4 `reschedule` 与 `reassign` 的区别（必须分清）

| | `reassign` 改派 | `reschedule` 改约 |
|---|---|---|
| 触发 | **执行责任人变了**（手机号 / 服务方 / 服务方式变） | 责任人没变，只改时间 |
| Visit | 旧 → `SUPERSEDED` + **新建 Visit** | **不新建**，就地改 |
| `visit_no` | +1 | 不变 |
| Token | 旧失效，新 Visit 签发新 Token | 旧吊销，**同一 Visit** 签发新 Token |
| 事件 | `reassigned` | `rescheduled` |

### 7.5 `store_confirm_status` 的地位（已降级）

Phase 2 的 `store_confirm_status`（pending/confirmed/rejected）**自 Phase 4-A 起降级为派生字段**，
仅为兼容已落库数据与既有断言而保留。两者**不得各自推进**，
映射表是单一事实来源：`VISIT_STATUS_TO_CONFIRM_STATUS`（`constants.ts`）。

