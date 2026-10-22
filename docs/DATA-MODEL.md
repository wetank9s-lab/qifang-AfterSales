# 数据模型（PostgreSQL / NocoBase Collections）

> 全部通过插件 `defineCollection()` 声明；NocoBase 自动建表与迁移，**不手写 SQL 迁移脚本**。
> 命名：表名 `snake_case` 复数；外键 `xxx_id`。主键统一 NocoBase `id`（bigint 自增，内部用；**绝不作为任何匿名访问凭证**）。
> 金额统一 `DECIMAL(10,2)`。时间统一 `timestamptz`。

---

## 1. stores — 门店

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | 内部主键 |
| code | string(16) | ✅ | **unique** | 稳定门店编码，如 `S01`（二维码参数用） |
| name | string(64) | ✅ | | 门店名称 |
| active | boolean | ✅ | index(active, sort_order) | 是否可选（下架门店不出现在 H5） |
| sort_order | integer | ✅ | | H5 下拉排序 |
| contact_phone | string(20) | ❌ | | 门店售后电话 |
| created_at / updated_at | timestamptz | ✅ | | 系统字段 |

## 2. storeUsers — 用户 ↔ 门店（多对多中间表）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| user_id | belongsTo users | ✅ | **unique(user_id, store_id)**、index(user_id) | 售后人员 |
| store_id | belongsTo stores | ✅ | index(store_id) | 授权门店 |
| created_at | timestamptz | ✅ | | |

> 一个售后人员可负责多个门店；一个门店可有多个售后人员（文档 §5 要求）。总部角色**不写中间表**，由 ACL 放行全量。

## 3. serviceTickets — 售后工单（核心表）

| 字段 | 类型 | 来源 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | 系统 | | **不对外暴露** |
| ticket_no | string(24) | 系统 | **unique** | `FW20260920-0001` |
| store_id | belongsTo stores | 客户/系统 | index、**index(store_id, status)** | 当前负责门店 |
| source_store_code | string(16) | 系统 | | 入口带入的原始门店，转店时**不变** |
| source | enum | 系统 | | `qr` / `link` / `staff` |
| ticket_type | enum | 客户 | | `repair` / `complaint` |
| content | text | 客户 | | 报修/投诉事项，5–500 字 |
| customer_name | string(32) | 客户 | | 姓名 |
| customer_mobile | string(20) | 客户 | index | 手机号（列表默认脱敏） |
| status | enum | 系统 | index、**index(status, expected_visit_at)** | 6 个状态之一 |
| handler_user_id | belongsTo users | 系统/人工 | | 当前主要处理人，可空 |
| service_mode | enum | 门店 | index | `inhouse` / `manufacturer` / `third_party` / `remote` |
| provider_name | string(64) | 门店 | | 厂家/第三方名称，可空 |
| technician_name | string(32) | 门店 | | 当前最新安排（需上门时必填） |
| technician_mobile | string(20) | 门店 | | 同上 |
| expected_visit_at | timestamptz | 门店 | | 当前最新预计上门时间 |
| dispatch_at | timestamptz | 系统 | | **首次**确认派工时间（口径固定，不随改派变化） |
| completion_result | enum | 门店 | | `resolved` / `unresolved` / `referred` / `customer_cancelled` / `other` |
| completion_note | text | 门店 | | 完成说明 |
| completed_at | timestamptz | 系统 | | 门店确认完成时间（首次关闭口径参考） |
| rating | integer | 客户 | | 1–5 |
| review_comment | text | 客户 | | 选填 |
| reviewed_at | timestamptz | 系统 | | 评价提交时间 |
| review_status | enum | 系统 | | `pending` / `submitted` / `expired` |
| feedback_token_hash | string(64) | 系统 | unique（可空） | 评价 Token 的 SHA-256 |
| feedback_token_expires_at | timestamptz | 系统 | | 评价链接有效期 |
| feedback_token_used_at | timestamptz | 系统 | | 一次性使用标记 |
| feedback_visit_id | belongsTo serviceVisits | 系统 | | 本轮评价对应的 Visit（多次返工可区分） |
| escalated | boolean | 系统 | index | 低评分/收费不一致升级标记 |
| reopen_count | integer | 系统 | | 重开次数，默认 0 |
| close_reason | string(32) | 系统/人工 | | `reviewed` / `review_expired` / `cancelled` / `manual` |
| first_response_at | timestamptz | 系统 | | 首次 NEW→PROCESSING，用于响应时长 |
| closed_at | timestamptz | 系统 | | 闭环口径 |
| created_at / updated_at | timestamptz | 系统 | index(created_at) | |

**枚举（写死在代码常量，不允许 DB 随意新增）**
- `status`: `NEW` `PROCESSING` `WAIT_STORE_CONFIRM` `WAIT_FEEDBACK` `CLOSED` `CANCELLED`
- `ticket_type`: `repair` `complaint`
- `service_mode`: `inhouse` `manufacturer` `third_party` `remote`
- `review_status`: `pending` `submitted` `expired`

## 4. serviceVisits — 服务回执（**一次「执行责任的派工尝试」**）

> 模型口径（Phase 4 裁定，见 `docs/DEVIATIONS.md` DEV-38）：
> 一张工单可有多个 Visit：改派、二次上门、低评分返工、驳回后重新处理。**历史永不覆盖。**
> **只要执行责任人变化就新建一条 Visit**，绝不修改旧 Visit 的师傅字段 ——
> 于是"历史不可覆盖"是数据模型的必然结果，而非约定。
> 责任主体判据 = `technician_mobile` + `provider_name` + `service_mode`（**姓名不在其中**）。
> 生命周期见 `docs/STATE-MACHINE.md` §7。

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| ticket_id | belongsTo serviceTickets | ✅ | index(ticket_id)、**unique(ticket_id, visit_no)** | |
| visit_no | integer | ✅ | | 第几次（从 1 递增，事务内取 `max+1`）。**改派会 +1**（新建 Visit） |
| **visit_status** | enum | ✅ | **index** | **Visit 生命周期的唯一事实来源**（Phase 4-A 新增）：`ASSIGNED` / `SUBMITTED` / `CONFIRMED` / `REJECTED` / `SUPERSEDED` / `CANCELLED`，默认 `ASSIGNED` |
| **assigned_at** | timestamptz | ❌ | | 本次派工产生时刻（改派时新 Visit 重新计时，旧 Visit 保留原值） |
| **reassigned_from_visit_id** | belongsTo serviceVisits（自引用） | ❌ | index | 改派时指向被取代的那条 Visit；首派为空。用于串出 Visit#1→#2→#3 链条 |
| **superseded_at** | timestamptz | ❌ | | 仅 `visit_status=SUPERSEDED` 时有值 |
| **superseded_reason** | text | ❌ | | 改派原因（冗余一份，便于只读 Visit 表时也能看到） |
| service_mode | enum | ✅ | | 快照，**责任主体判据之一** |
| provider_name | string(64) | ❌ | | 快照，**责任主体判据之一** |
| technician_name | string(32) | ✅ | | 快照。**唯一允许在原 Visit 上就地纠正的责任字段**，且必须写 `metadata_corrected` 事件 |
| technician_mobile | string(20) | ✅ | index | 快照，**责任主体判据之一**：本字段变化 = 必须走 `reassign`（新建 Visit），不得就地改 |
| expected_visit_at | timestamptz | ✅ | | 快照；**改约只改它，不新建 Visit** |
| access_token_hash | string(64) | ❌ | **unique** | 师傅 Token SHA-256 |
| token_expires_at | timestamptz | ❌ | | |
| token_used_at | timestamptz | ❌ | | 提交后置位 → Token 失效 |
| **token_revoked_at** | timestamptz | ❌ | | Token 被**主动吊销**的时刻（改派/改约重新签发）。与"过期"分开记：排障时"你被改派了"与"链接放太久"是两件事 |
| **token_revoked_reason** | string(64) | ❌ | | 如 `reassigned` / `rescheduled`；与 `token_revoked_at` 同生同灭 |
| is_remote | boolean | ✅ | | `service_mode=remote` 时为 true，不生成 Token |
| service_result | enum | ❌ | | `resolved` / `need_followup` / `unresolved` / `customer_absent` / `other` |
| service_note | text | ❌ | | 师傅处理说明，**条件必填**（提交时）：`service_result=resolved` 可留空（落 `NULL`），其余结果必填，≤ 500 字。规则与"可留空名单"见 `constants.SERVICE_RESULT_NOTE_OPTIONAL` / `isServiceNoteRequired()`（DEV-82） |
| is_charged | boolean | ❌ | | 默认 false |
| reported_charge_amount | numeric(10,2) | ❌ | | 师傅填报；`is_charged=false` 时必须 0 |
| confirmed_charge_amount | numeric(10,2) | ❌ | | 门店确认金额 |
| submitted_at | timestamptz | ❌ | | 师傅提交时间 |
| store_confirm_status | enum | ✅ | index | ⚠️ **Phase 4-A 起降级为 `visit_status` 的派生字段**（仅为兼容历史数据与既有断言保留；映射表 = `VISIT_STATUS_TO_CONFIRM_STATUS`）。**两套状态不得各自推进** |
| store_confirm_note | text | ❌ | | 驳回或金额调整原因 |
| store_confirmed_by | belongsTo users | ❌ | | |
| store_confirmed_at | timestamptz | ❌ | | |
| customer_charge_match | enum | ❌ | | `match` / `mismatch` / `not_applicable` |
| customer_reported_amount | numeric(10,2) | ❌ | | 客户反馈实际支付 |
| charge_diff_reason | text | ❌ | | 门店对不一致的说明（可选） |
| created_at / updated_at | timestamptz | ✅ | | |

## 5. serviceVisitPhotos — 现场照片

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| visit_id | belongsTo serviceVisits | ✅ | index(visit_id) | 关联 Visit（不挂 Ticket，避免覆盖） |
| photo_type | enum | ✅ | | `onsite` / `completed` / `receipt` / `other` |
| file_id | belongsTo attachments | ✅ | **unique** | NocoBase File Collection 记录 |
| storage_key | string(255) | ✅ | | 私有存储内的相对路径（用于受控读取，不对外） |
| mime | string(64) | ✅ | | 服务端 magic bytes 判定结果 |
| size | integer | ✅ | | 字节 |
| width / height | integer | ❌ | | 去 EXIF 重编码后尺寸 |
| uploaded_at | timestamptz | ✅ | | |
| sort_order | integer | ✅ | | 顺序 |
| upload_ip_hash | string(64) | ❌ | | sha256(ip+salt)，用于风控，不存明文 IP |

## 6. ticketEvents — 工单事件（业务时间线）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| ticket_id | belongsTo serviceTickets | ✅ | **index(ticket_id, created_at)** | |
| visit_id | belongsTo serviceVisits | ❌ | | 与 Visit 相关的事件 |
| event_type | enum | ✅ | index | 见下 |
| from_status / to_status | enum | ❌ | | 状态变化 |
| operator_user_id | belongsTo users | ❌ | | 客户提交/评价时为空 |
| operator_kind | enum | ✅ | | `customer` / `technician` / `store` / `hq` / `system` |
| summary | string(255) | ✅ | | 人可读，如"改派：王师傅 → 李师傅；上门时间 14:00 → 16:00" |
| metadata_json | jsonb | ❌ | | 结构化补充（金额、原因、门店编码等） |
| created_at | timestamptz | ✅ | | |

**event_type 白名单**（与文档 §16 一致）：
`created` `accepted` `transferred` `dispatched` `rescheduled` `reassigned` `technician_submitted` `store_confirmed` `store_rejected` `completed` `sms_sent` `sms_failed` `reviewed` `reopened` `closed` `cancelled`

> 写事件统一走 `EventService.append()`；**任何状态变更必须伴随事件**（在同一个事务内）。

## 7. smsLogs — 短信日志（全链路）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| ticket_id | belongsTo serviceTickets | ❌ | index(ticket_id) | |
| visit_id | belongsTo serviceVisits | ❌ | | |
| scene | enum | ✅ | index | `dispatch_customer` / `technician_task` / `technician_assignment_cancelled` / `dispatch_update` / `review_invite` / `manual_resend`（**取值域以 `src/server/constants.ts` 的 `SMS_SCENE` 为唯一事实来源**） |
| provider | enum | ✅ | **unique(provider, biz_id)** | `aliyun` / `tencent` / `mock` |
| template_code | string(64) | ✅ | | |
| recipient_masked | string(20) | ✅ | | 脱敏后的接收号码 |
| provider_request_id | string(64) | ❌ | | 供应商请求流水 |
| biz_id | string(64) | ❌ | | 供应商业务流水（幂等键） |
| send_status | enum | ✅ | index | `accepted` / `rejected` / `error` |
| delivery_status | enum | ✅ | index | `pending` / `delivered` / `failed` |
| error_code / error_message | string | ❌ | | |
| retry_count | integer | ✅ | | 默认 0，最多 1 次重试 |
| sent_at / delivered_at | timestamptz | ❌ | | |
| created_at / updated_at | timestamptz | ✅ | | |

## 8. dailySequences — 业务编号取号器

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| seq_key | string(32) | ✅ | **unique** | 如 `FW-20260920` |
| current_value | integer | ✅ | | 当前值 |
| updated_at | timestamptz | ✅ | | |

取号（唯一允许的原生 SQL，已参数化）：
```sql
INSERT INTO daily_sequences (seq_key, current_value, updated_at)
VALUES ($1, 1, now())
ON CONFLICT (seq_key)
DO UPDATE SET current_value = daily_sequences.current_value + 1, updated_at = now()
RETURNING current_value;
```
→ `ticket_no = 'FW' + YYYYMMDD + '-' + lpad(value, 4, '0')`

## 9. apiGuards — 限流计数

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| scene | string(32) | ✅ | **unique(scene, scope, guard_key, window_start)** | `public_ticket` / `technician_token` / `review_token` … |
| scope | enum | ✅ | | `ip` / `mobile` / `token` / `store` |
| guard_key | string(128) | ✅ | | 已哈希（IP 存 `sha256(ip+salt)`） |
| window_start | timestamptz | ✅ | index | 窗口起点 |
| counter | integer | ✅ | | 计数 |
| expires_at | timestamptz | ✅ | index | 过期清理 |

## 10. idempotencyRecords — 幂等记录

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| id | bigint PK | ✅ | | |
| scene | string(32) | ✅ | **unique(scene, idempotency_key)** | 如 `public_ticket` / `technician_submit` / `review_submit` |
| idempotency_key | string(64) | ✅ | | 客户端 `request_id` 或服务端派生指纹 |
| resource_type | string(32) | ✅ | | `serviceTicket` / `serviceVisit` |
| resource_id | bigint | ✅ | | 首次执行产物 |
| response_json | jsonb | ❌ | | 重放时原样返回 |
| created_at | timestamptz | ✅ | index | |

## 11. serviceSettings — 配置表

> ⚠️ **命名偏差**：本文档早期写的是 `systemSettings`，但 NocoBase 核心**已占用**该集合名
> （`@nocobase/plugin-system-settings` / `plugin-acl` / `plugin-users`），沿用会导致本插件
> 的注册被 `hasCollection()` **静默跳过**、参数一条都种不进去。
> 已改名为 `serviceSettings` / 表名 `service_settings`，详见 `docs/DEVIATIONS.md` **DEV-15**。

| 字段 | 类型 | 说明 |
|---|---|---|
| key | string(64) **unique** | 见附录 B 的配置键 |
| value | string / jsonb | 值 |
| value_type | enum | `int` / `bool` / `string` / `json` |
| description | string(255) | 说明 |
| updated_by / updated_at | | 审计 |

**唯一性声明方式**：仅由字段级 `unique: true` 声明（产出 PG UNIQUE CONSTRAINT
`service_settings_key_key`），**不再**额外写 collection 级 `indexes` —— 否则同一列上
会出现两个同义唯一索引，见 `docs/DEVIATIONS.md` **DEV-17**。

**配置键（v1.1 附录 B）**
`feedback.low_score_threshold`(2) · `feedback.wait_days`(7) · `feedback.token_expire_days`(15) · `sla.accept_minutes`(120) · `sla.appointment_overdue_grace_minutes`(120) · `sla.store_confirm_hours`(48) · `sms.provider`(mock) · `sms.retry_count`(1) · `security.ticket_phone_daily_limit`(5) · `security.ip_minute_limit`(30) · `security.duplicate_window_minutes`(10) · `security.technician_token_hourly_limit`(60) · `visit.photo_max_count`(6) · `visit.photo_max_size_mb`(5) · `technician.token_expire_hours`(72) · `privacy.retention_months`(24)

---

## 12. exportAudits — 导出审计（Phase 9 新增 · 第 12 张表）

> 来源：Phase 9 / **D3 闭合**（用户 2026-09-26 裁定）⇒ 登记 `docs/DEVIATIONS.md` **DEV-91**。
> 契约：`docs/PHASE-9.md` §7 / §8.1。

| 字段 | 类型 | 说明 |
|---|---|---|
| channel | string(32) | 导出通道，目前恒为 `svc:exportTickets`（唯一受支持出口） |
| engine_version | string(32) | 脱敏/防注入规则版本；用于事后核对"按**哪版规则**导的" |
| operator_user_id | FK → users（可空） | 操作者（与 `ticket_events` 同口径） |
| operator_username | string(64) | 账号**快照**（用户改名/删除后审计仍能回答"当时是谁"） |
| operator_roles | string(128) | 业务角色**快照**（逗号分隔），回答"以什么身份发生" |
| exported_at | timestamptz | 导出业务时刻（数据出境发生的时间） |
| filter_json | jsonb | **仅**筛选条件与日期窗口（from/to/storeId/ticketType/serviceMode/ratingMin） |
| row_count | integer | 成功写入 CSV 的条数；被拒绝/失败**不写本表** |
| columns_json | jsonb | 导出的**列名**清单（不是列值） |
| request_id | string(64) | 与链路日志对齐，定位"这一次导出"是哪一笔请求 |

### 12.1 为什么**不**复用 `ticket_events`（本表存在的全部理由）

`ticket_events.ticket_id` 是 `allowNull: false` —— 那是它作为「工单时间线」的**完整性约束**：
一条事件必须能回答"它属于哪张工单"。而"导出"在语义上**不属于任何一张工单**（一次导出可覆盖窗口内上万张）。
只有两条路，都不可取：放宽 `ticket_id`（牺牲事件表最核心的约束）或给被导出的**每一张**工单各写一条事件
（污染业务时间线，且把一次操作放大成上万次写入）。⇒ **跨工单的操作记在跨工单的表里。**

### 12.2 🔴 只记事实，不记数据本体（字段清单是经过收敛的，不要随手加列）

| ✅ 记 | 🔴 不记 |
|---|---|
| 操作者 / 时刻 / 筛选与日期范围 / 条数 / requestId / 接口版本 / **列名** | 任何**被导出的值**（手机号、姓名、报修内容…）· 整份 CSV 正文 |

用户原话：**"不要把导出的客户手机号或整份 CSV 内容再塞进 TicketEvent 来『审计导出』，否则反而制造第二份敏感数据副本。"**
这条纪律**同样适用于本表** —— 它只是换了张表，泄漏面不会因此变小。判据是"**是否含客户/业务数据**"，不是"是否来自导出流程"。

**索引**：`exported_at` · `operator_user_id` · `created_at`（**纯追加日志**，写入量极低，不再加业务列索引）。

---

## 13. ER 关系摘要

```
stores 1──n serviceTickets            (store_id, 转店时变更, source_store_code 保留)
stores n──n users  via storeUsers     (数据隔离依据)
serviceTickets 1──n serviceVisits     (visit_no 递增, 永不覆盖)
serviceVisits 1──n serviceVisitPhotos (visit_id)
serviceVisitPhotos n──1 attachments   (file_id, NocoBase File Collection)
serviceTickets 1──n ticketEvents      (ticket_id)
serviceTickets 1──n smsLogs           (ticket_id)
serviceVisits 1──n smsLogs            (visit_id)
users 1──n serviceTickets             (handler_user_id, 可空)
users 1──n serviceVisits              (store_confirmed_by, 可空)
users 1──n exportAudits               (operator_user_id, 可空)   ← Phase 9
```

> 注：`exportAudits` 刻意**不与任何工单关联**（见 §12.1）—— 它不是业务关系图上的一环，
> 而是一条独立的、跨工单的**数据出境**记录。

## 14. 索引与约束核查清单（对应文档 §21）

| 文档要求 | 本设计 | 状态 |
|---|---|---|
| ticket_no 索引 | `unique(ticket_no)` | ✅ |
| store_id 索引 | `index(store_id)` + `index(store_id,status)` | ✅ |
| status 索引 | `index(status)` + `index(status,expected_visit_at)` | ✅ |
| customer_mobile 索引 | `index(customer_mobile)` | ✅ |
| created_at 索引 | `index(created_at)` | ✅ |
| ServiceVisit: ticket_id | `index(ticket_id)` + `unique(ticket_id,visit_no)` | ✅ |
| ServiceVisit: technician_mobile | `index(technician_mobile)` | ✅ |
| ServiceVisit: store_confirm_status | `index(store_confirm_status)` | ✅ |
| SmsLog: ticket_id | `index(ticket_id)` | ✅ |
| SmsLog: biz_id | `unique(provider,biz_id)` | ✅ |
| SmsLog: delivery_status | `index(delivery_status)` | ✅ |
| Token 不明文入库 | `access_token_hash` / `feedback_token_hash` = SHA-256 hex | ✅ |
| 必要外键 | 全部 `belongsTo` 关系（NocoBase 生成 FK） | ✅ |
| 复合索引声明方式 | `defineCollection` 的 `indexes` 声明 + `ensureIndexes()` 在 `afterLoad` 兜底补齐 | ✅ **Phase 1 真机实测关闭**（详见下方） |
| 命名策略 | 全部 collection 强制 `underscored: true`（表名/时间戳列下划线） | ✅ 见 DEV-14 |

### 14.1 T-01 关闭结论：`indexes` 声明能用，但会被**静默丢弃**，必须兜底

Phase 1 真机启动实测发现：`defineCollection({ indexes: [...] })` **语法上被接受**，
但 NocoBase 的 `collection.refreshIndexes()` 会把「列尚未注册到 model 上」的索引
**整条静默丢弃**（不报错、不告警、不重试），导致 `service_visit_photos` / `ticket_events` /
`sms_logs` 三张表共 **8 条**索引从未下发到 Postgres。

因此本节原先预留的降级路径
「若不支持 → `QueryInterface.addIndex()` 补建（T-01）」
**已被采用并落地**为 `src/server/ensure-indexes.ts`，在 `afterLoad` 之后按
「列集合 + 唯一性」的**语义等价**判定核对补齐（只增不删）。
完整根因链与源码位置见 `docs/DEVIATIONS.md` **DEV-16**。

### 14.2 索引验收的单一事实来源

「哪些索引**必须**存在」已从代码里独立出来，写成 `scripts/expected-indexes.mjs`
（按表名列出 `{columns, unique, from}`，`from` 区分字段级唯一与 collection 级声明），
三处共用同一份清单形成闭环：

| 层 | 载体 | 比对内容 |
|---|---|---|
| 离线 | `scripts/verify-plugin-load.mjs` | 插件**源码声明**的 collection 级索引 == 清单 `from:'collection'` 项（不多不少，双向校验） |
| 真机 | `scripts/smoke-test.mjs` | Postgres **实际落库**索引 ⊇ 清单全部项（逐表逐条）+ 无重复同义索引扫描 |
| 人读 | 本节 §14 | 需求文档要求 → 本设计 → 状态 |

> 真机实测合计 **39 条** collection 级索引声明，全部落库；
> 另有字段级唯一约束 **6 条**（PG UNIQUE CONSTRAINT 形态）。
>
> ⚠️ **这两个数字以 `scripts/expected-indexes.mjs` 为准**，不要凭本节的数字做判断 ——
> 本节此前写的是"35 条 / 4 条"，那是 Phase 4 时期的旧值，此后各阶段新增的索引没有回填到这句话里
> （属于典型的"文档数字悄悄过期"）。Phase 9 新增的 `export_audits` 贡献了 3 条 collection 级索引。

---

## 15. configChangeAudits — 配置变更审计（UX-01C 新增 · 第 21 张表）

> 来源：UX-01C「总部设置中心 · 服务时效」；受控写接口 `POST /api/svc:updateSetting`。
> 关联：`docs/SECURITY.md` §2.3.1（行级收窄）· `docs/API.md` §6。

| 字段 | 类型 | 说明 |
|---|---|---|
| key | string(64) | 配置键（与 `serviceSettings.key` 同值，**不建外键**：键可以被改名/删除，审计必须独立存活） |
| old_value | text（可空） | 变更前的值（字符串原样） |
| new_value | text（可空） | 变更后的值（字符串原样，已经是 `validateSettingValue` 规范化后的结果） |
| operator_user_id | FK → users（可空） | 操作者 |
| operator_name | string(64)（可空） | 账号**快照**（用户改名/删除后仍能回答"当时是谁"） |
| scene | string(16) | `update` / `restore`（由调用方声明：页面编辑恒为 `update`；回滚场景可显式传 `restore`） |
| request_id | string(64) | 与 `X-Request-Id` 对齐，用于把"这一次改动"与日志/工单操作串起来 |

### 15.1 为什么必须与写值**同事务**
只写值、后写审计（或反过来）会产生两种失真：改了值但查不到是谁改的；或审计说改了、值其实没动
（回滚后）。因此 `configChangeAudits` 的写入与 `serviceSettings` 的更新在**同一个事务**里完成
（`actions/svc/config-settings.ts`）；`UPDATE` 影响行数 ≠ 1 ⇒ 抛 409 并整体回滚（DEV-203）。

### 15.2 为什么不复用 `ticketEvents`
与 `exportAudits` 同型（见 §12.1）：配置变更**不属于任何一张工单**，
`ticket_events.ticket_id` 又是 `allowNull: false`。硬塞进去要么放宽约束、要么污染业务时间线。
且配置项里含 `security.*` / `privacy.*` 之类运行参数，**更不该**出现在门店可见的工单时间线上。

**索引**：`key`（看某个配置的修改史）· `created_at`（全局时间序复盘）。

---

## 16. storeProfileAudits — 门店资料变更审计（UX-01C-R7 · 第 22 张表）

> 来源：「门店报修入口」行内「门店资料」编辑（仅 `hq_admin`）；
> 受控写接口 `POST /api/svc:updateStoreProfile`。关联：`docs/SECURITY.md` §2.3.4。

| 字段 | 类型 | 说明 |
|---|---|---|
| store_id | bigint | `stores.id`（**不建外键**：门店删除后审计仍须保留） |
| store_code | string(16) | 变更时的门店编码**快照** |
| field | string(32) | `name` / `contact_phone` / `address` / `active` |
| old_value | text（可空） | 变更前值（统一字符串；布尔 `true/false`；空为 `NULL`） |
| new_value | text（可空） | 变更后值 |
| operator_user_id | FK → users（可空） | 操作者 |
| operator_name | string(64) | 账号快照（改名/删除后仍能回答"当时是谁"） |
| scene | string(32) | `update` / `restore`（恢复**再写一条**，不回改历史） |
| request_id | string(64) | `X-Request-Id`；同时是幂等键 |

### 16.1 为什么单独一张表（不复用 `configChangeAudits`）
配置审计的主键语义是 **key**（`sla.accept_minutes`），门店资料是 **门店 × 字段**。
把两种语义塞进一张表，查询与约束都会变模糊（"这家门店改过什么"要解析 key 字符串）。
与 `exportAudits`（跨工单）同理：**跨实体的操作，记在跨实体的表里**。

### 16.2 幂等与并发
- 唯一索引 `(request_id, store_id, field)`：同一请求号最多一条审计 ——
  即使两个并发重复请求同时穿过"先查是否已回放"，也会被数据库挡住。
- 更新用 `UPDATE ... WHERE id=? AND <field>=<旧值>`（原子条件更新）；
  影响行数 ≠ 1 ⇒ 409，整体回滚（同一个教训见 DEV-203）。

**索引**：`store_id` · `field` · `created_at` · 唯一 `(request_id, store_id, field)`。


---

## 17. `page_theme_drafts` / `page_theme_releases`（UX-01D M1 · 客户页面装修）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `page_theme_drafts` | **草稿**（每 scope 一行） | `UNIQUE(scope)` · `UNIQUE(request_id)` · `revision` 乐观锁 |
| `page_theme_releases` | **已发布版本**（不可变、只追加） | `UNIQUE(scope, version)` · `UNIQUE(request_id)` |

### 17.1 为什么是两张独立表，而不是 `serviceSettings` 的十几个键

- **发布要原子**：整份快照切换；拆成键会出现"新主题 + 旧文案"的混合态；
- **要有版本**：`serviceSettings` 是单值，没有"草稿/已发布"维度；
- **要有回滚**：回滚 = 以旧快照再发一版，需要不可变版本行；
- **审计粒度**：一次发布是一条版本记录，而不是十几个互不关联的字段变更。

### 17.2 字段

`page_theme_drafts`：`scope`(v1 恒 `hq`) · `revision` · `base_version` · `doc`(jsonb) ·
`updated_by_user_id` · `request_id` · 时间戳。

`page_theme_releases`：`scope` · `version` · `doc`(jsonb 快照) · `published_by_user_id` ·
`published_at` · `note` · `rolled_back_from` · `request_id`。

`doc` 结构（schema_version=1）：
`{ schema_version, brand:{name,subtitle}, theme:{preset}, copy:{media_help}, modules:{media_help} }`

### 17.3 并发与原子性（实测教训）

- 保存：`UPDATE ... WHERE scope=? AND revision=?`（条件更新），影响行数 ≠1 ⇒ 409；
- 发布：**行锁 + 条件更新 + 括号推进 revision**。
  ⚠️ 发布若只更新 `base_version` 而不推进 `revision`，"同一版草稿"可以被连续发布两次
  （两个管理员同时点 → v11、v12 都返回 200）—— 见 `docs/DEVIATIONS.md` DEV-210。
- 公开面只读**最大 version** 的整份快照；草稿永远不从这里出去。
- 原生 CRUD 对**所有业务角色（含 hq_admin）**关闭：写只走 `svc:uiTheme*`。

**索引**：草稿 `UNIQUE(scope)` / `UNIQUE(request_id)` / `updated_at`；
版本 `UNIQUE(scope,version)` / `UNIQUE(request_id)`。


---

## 18. `store_account_audits`（SEC-STORE-01 · 门店账号授权审计）

`user_id` · `user_email` · `old_store_ids`(json) · `new_store_ids`(json) ·
`operator_user_id` · `operator_name` · `scene` · `request_id`(unique) · 时间戳。

- 语义是「**用户 × 一次授权集合变更**」，与 `storeProfileAudits`（门店 × 字段）、
  `configChangeAudits`（配置键）不同，故独立成表；
- 只增不改；`request_id` 唯一 ⇒ 同一请求号重放不新增审计；
- 授权关系本身仍在 `store_users`（`UNIQUE(user_id, store_id)`），本表只记历史。
