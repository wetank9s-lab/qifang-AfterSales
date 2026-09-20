# Phase 0 — 需求核对与技术确认

> 依据：《家电门店售后服务平台_开发文档_v1.1》（2026-09-20）
> 结论：**Phase 0 通过，可以进入 Phase 1。**（无架构级阻塞问题，详见 §10）

---

## 1. 对需求的准确理解

### 1.1 一句话定位
一个**独立、轻量的「门店售后工单中台」**：客户匿名 H5 提交报修/投诉 → 门店售后受理派工 → 师傅凭一次性短信链接匿名回执（照片 + 处理结果 + 收费）→ 门店审核确认 → 客户一次性链接匿名评价 → 满意关闭 / 低评分或收费不一致自动重开 → 总部全量监控与导出。

### 1.2 边界（明确不做）
- 不接 15 家门店原 ERP；不同步销售单、商品编码、SN、售价、库存、财务。
- 不做师傅账号 / APP（师傅只有一次性 Token H5）。
- 不做客户账号体系、不做设备档案、不做备件/结算/工时/地图调度/定位/电子签字。
- 不做在线支付、税务发票、财务对账（收费金额定位为**服务事实数据**，不是财务账）。
- 不依赖 NocoBase Professional / Enterprise 付费插件。

### 1.3 五个角色与权限边界
| 角色 | 账号 | 可见数据 | 关键约束 |
|---|---|---|---|
| 门店售后人员 | 有 | 仅被授权门店（多对多） | 服务端强制过滤，禁止前端过滤 |
| 总部售后人员 | 有 | 全部门店 | 可重开、强制转店、异常处置 |
| 总部管理员 | 有 | 全部数据 | 用户/门店/参数/权限/导出 |
| 客户 | 无 | 仅自己提交的工单号 | 匿名，无登录无验证码 |
| 师傅 | 无 | 仅本次 ServiceVisit 最小信息 | 一次性 Token，绑定 visitId |

### 1.4 三条不可违背的业务红线
1. **师傅提交 ≠ 工单关闭**，必须经门店确认；确认前**绝不能**发客户评价短信。
2. **低评分（默认 ≤2 星）或收费金额不一致，即使 5 星也不允许 CLOSED**，必须 `escalated=true` + 回 `PROCESSING`。
3. **历史不可覆盖**：改派/返工/二次上门一律新建 ServiceVisit，旧 Visit、旧照片、旧金额永久保留。

### 1.5 主状态只有 6 个
`NEW / PROCESSING / WAIT_STORE_CONFIRM / WAIT_FEEDBACK / CLOSED / CANCELLED`
例外情况一律用**字段 / 事件 / 标签**表达：`escalated`、`reopen_count`、`review_status`、`sms_abnormal`（派生）、`appointment_overdue`（派生）。**自定义状态不得增加。**

---

## 2. 系统架构

### 2.1 技术选型（锁定）
| 层 | 选型 | 版本/说明 |
|---|---|---|
| 低代码后台 | NocoBase **Community**（Apache-2.0） | **锁定 v2.1.x 稳定线**（不使用 v3 alpha，不使用 Pro/Ent） |
| 数据库 | PostgreSQL | 16.x |
| 反向代理 | Nginx | HTTPS / 限流 / 静态资源 / H5 托管 |
| 客户 + 师傅 H5 | Vue 3 + Vite + TypeScript | 单仓库 `h5/`，产出静态资源由 Nginx 托管 |
| 后端扩展 | NocoBase 自定义插件 `@local/service-ticket` | 唯一后端扩展形态，**不新建独立 Node 服务** |
| 文件 | NocoBase File Collection（file manager） | 私有存储 + 受控读取端点 |
| 短信 | `SmsProvider` 抽象层 | `AliyunSmsProvider` / `MockSmsProvider`（预留腾讯云） |
| 部署 | Docker Compose | postgres + nocobase + nginx |

### 2.2 为什么**不**新建独立 Node.js Service
文档允许"某些匿名接口非常不适合放进 NocoBase Plugin"时建独立服务。经核实，**本项目的匿名接口全部适合放进插件**：

- NocoBase 插件可注册任意自定义 API：`this.app.resourceManager.define({ name, actions })`（官方文档已确认）。
- 匿名接口需要的能力（校验 Token、读 `ctx.db`、写 File Collection、触发短信）**全部在同一进程内**，插件里是零成本调用。
- 独立服务会引入：跨进程鉴权、数据库双写与事务边界、部署与日志双份、备份恢复复杂度翻倍、短信回执幂等需要跨库协调。**收益为零，风险为正。**
- 结论：**单一后端进程（NocoBase）+ 插件扩展**。

### 2.3 架构分层
```
[Nginx]  HTTPS / limit_req / 静态资源
   ├── /            → h5/dist   （客户报修、师傅回执、客户评价）
   ├── /api/*       → NocoBase  (app:13000)
   └── /uploads-primary/* → 仅内部签名短时访问（见 §9.5）
        │
[NocoBase v2.1.x 进程]
   ├── 原生能力：Collections / ACL / Workflow / Export / Scheduled Task
   └── 插件 @local/service-ticket
        ├── collections/   9 张表（业务表 + 事件表 + 日志表）
        ├── middlewares/   storeScope 数据隔离（服务端强制）
        ├── actions/
        │    ├── public/      客户匿名接口
        │    ├── technician/  师傅 Token 接口（含受控文件上传）
        │    ├── callback/    短信回执
        │    └── internal/    受理/派工/改派/确认/驳回/重发/报表
        ├── services/      TicketService / VisitService / FeedbackService
        │                  SmsService / TokenService / FileService
        │                  EventService / PermissionService / GuardService
        ├── sms/           SmsProvider 抽象 + Aliyun/Mock 实现
        └── tasks/         SLA 扫描 / 评价超时关闭 / 短信重试
        │
[PostgreSQL 16]
```

### 2.4 关键架构决策（4 条）
| # | 决策 | 理由 | 可逆性 |
|---|---|---|---|
| D1 | 客户报修页用**独立 Vue3 H5**，不用 NocoBase Public Form | Public Form 无法在写入前拦截：做不了 `request_id` 幂等、IP/手机号频控 429、字段白名单、重复单识别（文档 §9.1/§14/§18 明确要求）；且评价页/师傅页已是独立 H5，统一技术栈减少维护面 | **可逆**，Phase 3 前可切换回 Public Form（架构与数据模型不变） |
| D2 | 匿名接口用**自定义 resource action**，`allowAnonymous` 只开这 7 个 action | 绝不把 NocoBase 原生 CRUD / 管理员 API Key 暴露给匿名用户 | 不可逆（正确方向） |
| D3 | 照片**不使用永久公开 URL**：私有目录 + 受控读取端点 | 文档 §21.7 明确要求；NocoBase 本地存储默认 URL 是永久公开的 | 不可逆（安全要求） |
| D4 | 工单状态只能经 `TicketService` 变更，且带**乐观并发**（`UPDATE ... WHERE status = 期望值`） | 防止两个门店人员同时派工产生重复短信（文档 §9.1） | 不可逆（正确方向） |

---

## 3. 数据表及关联

共 **9 张表**（`docs/DATA-MODEL.md` 有完整字段级定义）。

```
stores ──< storeUsers >── users                                   [多对多：门店 ↔ 售后人员]
  │
  └─< serviceTickets ──< serviceVisits ──< serviceVisitPhotos ──> attachments(File Collection)
            │                  │
            ├─< ticketEvents    └─ access_token_hash / token_expires_at
            ├─< smsLogs
            ├─ feedback_token_hash / feedback_expires_at
            └─ ticket_no ← dailySequences（按日原子取号）
                        apiGuards（限流）/ idempotencyRecords（幂等）/ systemSettings（配置）
```

| 表 | 用途 | 关键索引 / 约束 |
|---|---|---|
| `stores` | 门店 | `unique(code)`、`index(active, sort_order)` |
| `storeUsers` | 用户-门店多对多 | `unique(userId, storeId)`、`index(userId)` |
| `serviceTickets` | 工单核心 | `unique(ticket_no)`、`index(store_id)`、`index(status)`、`index(customer_mobile)`、`index(created_at)`、`index(store_id,status)`、`index(status,expected_visit_at)` |
| `serviceVisits` | 每次上门/处理回执 | `unique(ticket_id,visit_no)`、`unique(access_token_hash)`、`index(ticket_id)`、`index(technician_mobile)`、`index(store_confirm_status)` |
| `serviceVisitPhotos` | 现场照片（关联 File Collection） | `index(visit_id)`、`unique(file_id)` |
| `ticketEvents` | 业务时间线（替代付费 Record History） | `index(ticket_id,created_at)`、`index(event_type)` |
| `smsLogs` | 短信全链路 | `unique(provider,biz_id)`、`index(ticket_id)`、`index(delivery_status)` |
| `dailySequences` | 工单号取号器 | `unique(seq_key)` |
| `apiGuards` / `idempotencyRecords` / `systemSettings` | 限流/幂等/配置 | 见 DATA-MODEL.md |

**字段设计要点**
- 所有 Token 只存 `sha256(token)`，绝不存明文；`serviceVisits.access_token_hash` 与 `serviceTickets.feedback_token_hash` 均为唯一索引。
- `serviceTickets.source_store_code` 在转店时**不变**，用于分析"客户选错门店"。
- `serviceVisits` 保存 `technician_name/mobile/service_mode/expected_visit_at` 的**快照**；工单上保留"当前最新安排"，便于改派对比。
- 金额统一 `DECIMAL(10,2)`，`is_charged=false` 时强制 `reported_charge_amount=0`。
- 收费一致性存 `customer_charge_match`（`match/mismatch/not_applicable`）+ `customer_reported_amount`，落在 **Visit** 上而非 Ticket，保证多次上门可分别核对。

---

## 4. NocoBase Community 能直接完成的部分

| 能力 | 用途 | 结论 |
|---|---|---|
| Collections 数据建模 | 9 张表结构、关系、唯一约束、索引 | ✅ 直接用（`defineCollection`），不手写 SQL 迁移 |
| REST API 自动生成 | 后台列表/详情/新增/修改 | ✅ 直接用 |
| ACL + 数据范围（服务端） | 角色、字段级权限、数据范围过滤 | ✅ 直接用，**另加插件中间件二次兜底** |
| 文件表 / 附件（file-manager） | 照片元数据与物理存储 | ✅ 用其 Collection + Storage，读取走自建受控端点 |
| Workflow | 状态流转、SLA 扫描、评价超时关闭、HTTP Request 调短信 | ✅ 用于**辅助/兜底**；核心闭环落在插件 Service（可测试、原子、可幂等） |
| Scheduled Task / Delay | 定时扫描 | ✅ 用于辅助；关键定时（评价超时、SLA）放插件 `tasks/`，保证可配置与可测试 |
| Export | 总部 Excel 导出 | ✅ 用内置导出 + **导出权限仅总部**；导出前做脱敏与 CSV 注入防护 |
| 图表 / 看板区块 | 总部 KPI 展示 | ✅ 用内置图表区块 + 自定义统计接口 |
| Server Logs | 故障排查 | ✅ |

> 说明：核心状态流转**同时**存在于 Workflow 与插件 Service 会形成双写风险。因此约定：**状态写入的唯一入口是插件 Service**；Workflow 只做"调用 Service"或纯通知类动作，不直接改 `status`。

---

## 5. 必须自定义开发的部分

| # | 能力 | 为什么 Community 做不到 | 实现形态 |
|---|---|---|---|
| C1 | 客户匿名报修接口（幂等 + 限流 + 防重） | Public Form 无法写入前拦截 | 插件 `public/tickets` action + `GuardService` |
| C2 | 一次性 Token 体系（师傅 / 评价） | 无内置匿名 Token 机制 | 插件 `TokenService`，SHA-256 + 单次 + 过期 |
| C3 | 师傅匿名 H5 接口 + **受控文件上传** | 标准文件 API 需登录 JWT | 插件 `technician/*` action，服务端落盘建关联 |
| C4 | 照片私有化与权限读取 | 本地存储 URL 永久公开 | 插件 `internal/photos` 代理 + 短时签名 |
| C5 | 短信回执入口（验签 + 幂等） | 无内置回调接收 | 插件 `callbacks/sms/:provider` + `SmsService` |
| C6 | 业务时间线 TicketEvent | 完整 Record History 属 Professional | 自建表 + `EventService` 统一写入 |
| C7 | 工单号按日原子取号 | 无内置业务编号器 | `dailySequences` + `UPDATE ... RETURNING` |
| C8 | 门店数据隔离的**服务端兜底** | ACL 依赖配置，配置错就漏数据 | 插件 `storeScope` 中间件 + `PermissionService` |
| C9 | 低评分 / 收费不一致自动重开 | 需跨表判断 + 原子事务 | `FeedbackService` |
| C10 | 收费一致性确认闭环 | 无内置 | 评价接口扩展 + Visit 字段 |
| C11 | SLA / 评价超时 / 短信重试定时任务 | 需可配置 + 可测试 | 插件 `tasks/`（cron 可配） |
| C12 | 总部报表与导出脱敏 | 内置导出无法按角色脱敏 + 防 CSV 注入 | 插件报表接口 + 导出包装 |
| C13 | 工单详情页时间线 / Visit / 照片自定义区块 | 需组合多源数据 | 插件 `client-v2` 自定义区块 |

---

## 6. 最终目录结构

```
project/                                  ← C:\Users\Administrator\WorkBuddy\2026-09-20-15-28-58
├─ nocobase/
│  └─ plugins/
│     └─ service-ticket/                   ← 唯一的后端扩展插件
│        ├─ src/
│        │  ├─ server/
│        │  │  ├─ plugin.ts                ← 插件入口：注册 collections / actions / ACL / 中间件 / 定时任务
│        │  │  ├─ collections/             ← 9 张表定义（defineCollection）
│        │  │  ├─ middlewares/             ← storeScope 数据隔离、rateLimitGuard
│        │  │  ├─ actions/
│        │  │  │  ├─ public/               ← 客户匿名接口
│        │  │  │  ├─ technician/           ← 师傅 Token 接口
│        │  │  │  ├─ callback/             ← 短信回执
│        │  │  │  └─ internal/             ← 后台业务动作 + 报表
│        │  │  ├─ services/                ← TicketService / VisitService / FeedbackService
│        │  │  │                              SmsService / TokenService / FileService
│        │  │  │                              EventService / PermissionService / GuardService
│        │  │  │                              SequenceService / ConfigService
│        │  │  ├─ sms/                     ← SmsProvider 抽象 + AliyunSmsProvider / MockSmsProvider
│        │  │  ├─ tasks/                   ← slaScan / reviewExpire / smsRetry
│        │  │  ├─ dto/                     ← 每个公开接口的入参 Schema + 字段白名单
│        │  │  └─ utils/                   ← mask / sign / magic-bytes / errors
│        │  ├─ client-v2/                  ← 自定义区块：工单时间线、Visit 审核、照片预览、看板
│        │  └─ locale/                     ← zh-CN.json / en-US.json
│        ├─ package.json
│        ├─ tsconfig.json
│        └─ README.md
├─ h5/
│  ├─ src/
│  │  ├─ pages/
│  │  │  ├─ Report/                        ← 报修/投诉 + 提交成功
│  │  │  ├─ TechnicianVisit/               ← 师傅回执（照片/结果/收费）
│  │  │  └─ Review/                        ← 匿名评价 + 收费一致性
│  │  ├─ api/                              ← 统一请求封装（错误码、重试、request_id）
│  │  ├─ components/                       ← Stars / PhotoPicker / Stepper
│  │  └─ utils/                            ← 图片压缩、手机号校验、脱敏、隐私文案
│  ├─ public/
│  ├─ index.html
│  ├─ vite.config.ts
│  └─ package.json
├─ nginx/
│  ├─ nginx.conf
│  └─ conf.d/service.conf                  ← HTTPS、limit_req、H5 静态、/api 反代
├─ docs/
│  ├─ PHASE-0.md                           ← 本文档
│  ├─ DATA-MODEL.md
│  ├─ STATE-MACHINE.md
│  ├─ API.md
│  ├─ SECURITY.md
│  ├─ DEVIATIONS.md
│  └─ DEV-PLAN.md
├─ scripts/                                ← init-db / backup / restore / seed / smoke-test
├─ tests/
│  ├─ unit/                                ← 24 项必须覆盖的单元/集成测试
│  └─ e2e/
├─ backups/
├─ Dockerfile                              ← 基于 nocobase/nocobase:2.1.x + 注入插件
├─ docker-compose.yml
├─ .env.example
├─ .gitignore
├─ README.md
├─ ASSUMPTIONS.md
└─ CHANGELOG.md
```

**相对文档建议结构的 3 处调整（并说明理由）**
1. 增加 `nocobase/plugins/service-ticket/src/server/services/`：文档 §23 要求"核心服务"分层。控制器（actions）只做参数校验与响应，业务全在 services，便于单测与复用。
2. 增加 `src/server/dto/`：文档要求"所有公开 API 有 DTO/Schema 验证"和"字段白名单"，独立目录避免散落。
3. **不建** `service-api/` 独立服务目录（理由见 §2.2）；相应能力进 `nocobase/plugins/service-ticket/src/server/actions/`。

---

## 7. 状态机

### 7.1 主状态与迁移
```
                 ┌──────────────────────── 转店(store_id 变更, status 不变) ───────────────┐
                 │                                                                          │
  客户提交        ▼                                                                          │
 ┌──────┐   受理/派工    ┌──────────────┐  师傅提交回执   ┌───────────────────────┐
 │ NEW  │ ────────────▶ │  PROCESSING  │ ─────────────▶ │ WAIT_STORE_CONFIRM     │
 └──────┘               └──────────────┘                └───────────────────────┘
   │                        ▲     │                            │        │
   │ 取消/重复/无效          │     │ 驳回(stored_rejected)       │        │ 确认完成
   ▼                        │     └────────────────────────────┘        ▼
┌───────────┐               │                                    ┌──────────────────┐
│ CANCELLED │               │   低评分 或 收费不一致              │  WAIT_FEEDBACK   │
└───────────┘               └────────────────────────────────────│  (发评价短信)     │
                            (escalated=true, reopen_count+1)     └──────────────────┘
                                                                      │        │
                                                        客户评价(正常) │        │ 超时(默认 7 天)
                                                                      ▼        ▼
                                                                 ┌──────────────────┐
                                                                 │      CLOSED      │
                                                                 └──────────────────┘
```

### 7.2 迁移表（唯一合法路径）
| From | 动作 | To | 前置校验 | 副作用 |
|---|---|---|---|---|
| — | `createTicket` | NEW | 门店有效、字段合法、限流/幂等通过 | 生成 ticket_no、写 `created` 事件 |
| NEW | `accept` | PROCESSING | status=NEW | 写 `accepted`；不自动派工 |
| NEW | `dispatch` | PROCESSING | status=NEW 或 PROCESSING | 建 Visit + 师傅 Token；发客户/师傅短信；写 `dispatched` |
| NEW | `transfer` | NEW | status ∈ {NEW, PROCESSING} | 改 store_id，保留 source_store_code，写 `transferred` |
| NEW | `cancel` | CANCELLED | 填原因 | 写 `cancelled` |
| PROCESSING | `reschedule` | PROCESSING | 同一 Visit | 更新预计时间，旧 Token 失效 → 新 Token，发更新短信，写 `rescheduled` |
| PROCESSING | `reassign` | PROCESSING | 同一 Visit | 换师傅，旧 Token 失效 → 新 Token，发更新短信，写 `reassigned` |
| PROCESSING | `technicianSubmit` | WAIT_STORE_CONFIRM | Token 有效未用 | 存照片/结果/收费；Token 立即失效；写 `technician_submitted` |
| WAIT_STORE_CONFIRM | `confirm` | WAIT_FEEDBACK | 金额规则通过 | 写 confirmed 金额、completed_at；**此时才**生成评价 Token 并发短信 |
| WAIT_STORE_CONFIRM | `reject` | PROCESSING | 填原因 | Visit.store_confirm_status=rejected；**保留全部照片与回执** |
| WAIT_FEEDBACK | `review`(正常) | CLOSED | Token 有效未用、评分 > 阈值、收费一致 | 写 rating/comment；`closed`；review_status=submitted |
| WAIT_FEEDBACK | `review`(异常) | PROCESSING | 评分 ≤ 阈值 或 mismatch | `escalated=true`、`reopen_count+1`、写 `reopened` |
| WAIT_FEEDBACK | `autoClose` | CLOSED | 超时 | review_status=expired；close_reason=review_expired |
| WAIT_STORE_CONFIRM | `remoteComplete` | WAIT_FEEDBACK | service_mode=remote | 门店直接处理路径，不发师傅短信、无师傅 Token |

### 7.3 异常标签（不新增状态）
| 标签 | 含义 | 来源 |
|---|---|---|
| `escalated` | 低评分 / 收费不一致重开 | FeedbackService |
| `reopen_count` | 重开次数 | FeedbackService |
| `review_status` | pending / submitted / expired | FeedbackService |
| `sms_abnormal`（派生） | 存在 send_status=error 或 delivery_status=failed 的 SmsLog | 查询派生，不落库 |
| `appointment_overdue`（派生） | `expected_visit_at < now` 且 status=PROCESSING 且无有效回执 | SLA 扫描派生 |
| `accept_overdue`（派生） | `created_at + sla.accept_minutes < now` 且 status=NEW | SLA 扫描派生 |

---

## 8. API 清单

所有自定义接口挂在 NocoBase 的 API 前缀下（默认 `/api`）。**匿名接口仅 7 个**，其余全部要求登录。

### 8.1 公开 / 匿名（`allowAnonymous: true`，仅这些 action）
| 方法 | 路径 | 用途 | 关键规则 |
|---|---|---|---|
| GET | `/api/public/stores` | 启用门店 | 只返回 `code/name`；限流 |
| POST | `/api/public/tickets` | 创建工单 | `request_id` 幂等；IP+手机号限流；字段白名单；5-500 字；手机号校验；重复单识别；服务端生成 ticket_no；返回 `ticket_no` |
| GET | `/api/public/reviews/:token` | 评价上下文 | Token 校验（存在/未用/未过期）；只返回门店名、收费金额、是否收费；**不含手机号/师傅信息**；限流 |
| POST | `/api/public/reviews/:token` | 提交评价 | Token 单次；rating 1-5；`charge_match` 三选一；mismatch 时可带金额；提交后 Token 立即失效；幂等 |
| GET | `/api/technician/visits/:token` | 师傅读取本次任务 | 只返回工单号、门店名、类型、事项、预计上门时间、Token 过期时间；**不含客户姓名之外的任何客户信息与历史工单**；限流 |
| POST | `/api/technician/visits/:token/files` | 上传现场照片 | 校验 Token→Visit→有效期→**magic bytes MIME**→单张 ≤5MB→单 Visit ≤6 张→去 EXIF→私有落盘→建 photo 记录；限流 |
| POST | `/api/technician/visits/:token/submit` | 提交回执 | `service_result`/`service_note` 必填；`is_charged=true` 必须 `amount>0`，否则金额必须为 0；成功后 Token 失效、状态→WAIT_STORE_CONFIRM、**不发客户短信**；幂等 |
| POST | `/api/callbacks/sms/:provider` | 短信下发回执 | 供应商签名校验；`provider+biz_id` 幂等；只更新 SmsLog，不产生重复 TicketEvent；**不走匿名 ACL，单独签名校验** |

### 8.2 内部（需登录 + 门店数据隔离）
| 方法 | 路径 | 角色 | 用途 |
|---|---|---|---|
| POST | `/api/svc/tickets/:id/accept` | 门店/总部 | 受理 |
| POST | `/api/svc/tickets/:id/transfer` | 门店/总部 | 转店（必填目标门店 + 原因） |
| POST | `/api/svc/tickets/:id/dispatch` | 门店/总部 | 派工/首次派工（建 Visit + Token + 双短信） |
| POST | `/api/svc/tickets/:id/reschedule` | 门店/总部 | 改约（旧 Token 失效 → 新 Token + 更新短信） |
| POST | `/api/svc/tickets/:id/reassign` | 门店/总部 | 改派 |
| POST | `/api/svc/tickets/:id/cancel` | 门店/总部 | 取消（必填原因） |
| POST | `/api/svc/tickets/:id/resend-sms` | 门店/总部 | 人工重发（scene 白名单） |
| POST | `/api/svc/tickets/:id/remote-complete` | 门店/总部 | 门店直接处理完成（remote 模式，无师傅 Token） |
| POST | `/api/svc/tickets/:id/customer-mobile` | 门店/总部 | 派工前修正客户手机号（必写事件） |
| GET | `/api/svc/tickets/:id/timeline` | 门店/总部 | TicketEvent 时间线 |
| GET | `/api/svc/visits/:id` | 门店/总部 | Visit 详情（含照片列表、金额、回执） |
| POST | `/api/svc/visits/:id/confirm` | 门店/总部 | 确认（可调金额，必填原因） |
| POST | `/api/svc/visits/:id/reject` | 门店/总部 | 驳回（必填原因） |
| GET | `/api/svc/photos/:photoId` | 门店/总部/短时签名 | 受控读取照片（权限校验后流式返回） |
| GET | `/api/svc/dashboard/summary` | 全部（按角色裁剪） | 总部/门店看板数字 |
| GET | `/api/svc/reports/kpi` | 总部 | KPI（首次响应/闭环时长/超时率/评价率/评分/重开率/送达率/收费统计） |
| GET | `/api/svc/export/tickets` | **仅总部** | Excel 导出（脱敏 + 防 CSV 注入 + 记录导出事件） |
| GET/PUT | `/api/svc/settings` | 总部管理员 | 参数读写（白名单键） |
| GET | `/api/svc/health` | 内部 | 健康检查（DB / SMS provider / 定时任务） |

**NocoBase 原生 REST**（`/api/serviceTickets:list|get|create|update` 等）用于后台页面读取；**写操作只允许经上述业务 action**，`create/update` 对 `status` 等关键字段由 ACL 设为只读。

---

## 9. 安全设计

### 9.1 Token 体系（统一 `TokenService`）
- 生成：`crypto.randomBytes(32)` → base64url（43 字符），**高熵、不可枚举**。
- 存储：DB 只存 `sha256(token)`（hex 64），字段建**唯一索引** → 查表命中即校验，天然常量时间，不回表比对明文。
- 绑定：师傅 Token 绑 `visitId`；评价 Token 绑 `ticketId` + `reviewRound`（`feedback_visit_id`）。
- 生命周期：有效期（师傅默认 72h、评价默认 15 天，均可配）；**单次使用**（用后写 `used_at`/清空 hash）；失效场景 = 改派 / 改约 / 提交 / 评价完成 / 过期。
- 错误响应统一模糊化：`TOKEN_INVALID`（不区分"不存在"与"已使用"，防枚举探测）。

### 9.2 数据隔离（双层，服务端）
1. **NocoBase ACL**：角色 `store_after_sales / hq_after_sales / hq_admin / viewer`，数据范围按 `storeUsers` 配置。
2. **插件 `storeScope` 中间件**（兜底）：对 `serviceTickets / serviceVisits / serviceVisitPhotos / ticketEvents / smsLogs` 的 list/get/export 请求，强制注入 `store_id ∈ currentUserStores`（总部角色跳过）。**不信任前端传参，不依赖前端隐藏。**
3. **对象级鉴权**：任何 `:id` 操作，先 `PermissionService.assertTicketAccess(user, ticketId)`，再进业务逻辑（防 IDOR）。

### 9.3 输入与输出
- 所有公开接口 **DTO + Schema 校验**（必填/类型/长度/枚举/手机号正则），校验不过不落库。
- **字段白名单**：入参经 mapper 显式取值，杜绝 mass assignment（防止匿名传 `status/store_id/escalated`）。
- **防注入**：全部经 NocoBase Repository / Sequelize 参数化；唯一原生 SQL 是取号 `UPDATE daily_sequences SET current_value = current_value + 1 WHERE seq_key = $1 RETURNING current_value`（参数化）。
- **防 XSS**：存储原文，前端 Vue 默认转义渲染，**禁止 `v-html`**；导出 Excel 时对以 `= + - @` 开头的单元格加前缀 `'`（防 CSV/公式注入）。
- **输出裁剪**：匿名接口按 DTO 只输出白名单字段；工单列表手机号默认 `138****8888`，完整号码仅总部角色；导出仅总部。

### 9.4 限流与防刷（`GuardService` + Nginx 双保险）
| 维度 | 默认值 | 配置键 |
|---|---|---|
| 公开接口 IP 频控 | 30 次/分钟 | `security.ip_minute_limit` |
| 同手机号每日提交 | 5 次/日 | `security.ticket_phone_daily_limit` |
| 重复单识别 | 同手机号+同门店+同类型 + 事项文本相似，10 分钟内 → 拒绝并回原工单号 | `security.duplicate_window_minutes` |
| 幂等 | `request_id`（客户端 UUID）唯一，重放直接回原结果 | — |
| 师傅 Token 接口 | 60 次/小时/Token；上传 ≤6 张/Visit | `security.technician_token_hourly_limit` |
| Nginx | `limit_req` 10r/s burst 20（/api/public） | nginx conf |

### 9.5 文件安全
- **服务端 magic bytes 嗅探真实类型**（不信任扩展名/Content-Type），只允许 `image/jpeg|png|webp`。
- 单张 ≤5MB、单 Visit ≤6 张、单 Token 累计 ≤6 张；前端先压缩（长边 1600、质量 0.8）。
- **去除 EXIF**（含 GPS）：用 `sharp` 重新编码落盘。
- **私有存储**：文件落盘到非 Nginx 静态目录；NocoBase 侧只保存元数据记录（File Collection）。
- **受控读取**：`GET /api/svc/photos/:photoId` 校验登录 + 门店范围后流式返回；对外预览用**短时签名 URL**（`?exp=&sig=hmac`，默认 10 分钟），**不存在永久公开 URL**。

### 9.6 密钥与合规
- 短信 AK/SK、DB 密码、`APP_KEY`、签名密钥全部只在 `.env`；`.env` 进 `.gitignore`；**绝不写入前端 JS，绝不写入可被前端读取的表**。
- 日志脱敏：手机号/姓名不写进应用日志。
- 隐私：H5 首屏展示个人信息处理说明（目的/范围/保存期限 24 个月/联系方式），提交前置勾选；保留期 `privacy.retention_months` 可配（默认 24）。
- 备份：`pg_dump` 加密 + `backups/` 限权访问；定期演练恢复。

---

## 10. 阻塞问题核查

### 10.1 结论
**Phase 0 通过，可以进入 Phase 1。** 未发现会导致架构错误、数据不可逆或安全风险的阻塞问题。下列 4 项为**非阻塞**事项，已给出默认值并写入 `ASSUMPTIONS.md`，可在 Phase 3 / 联调 / 上线前确认，不影响现在开工。

### 10.2 非阻塞事项（已取默认值）
| # | 事项 | 默认决定 | 需确认时点 |
|---|---|---|---|
| A-01 | 报修页用 Public Form 还是独立 H5 | 用**独立 Vue3 H5**（理由见 D1；Public Form 无法满足幂等/限流/防重）。**可逆**，若坚持 Public Form，Phase 3 可切换，数据模型不变 | Phase 3 前 |
| A-02 | NocoBase 版本 | 锁定 **v2.1.x 稳定线**（2.0 起为 Apache-2.0；不使用 v3 alpha；不使用 Pro/Ent） | Phase 1 开始前（Phase 1 会写入具体 tag） |
| A-03 | 短信供应商与模板 | 实现 `AliyunSmsProvider` + `MockSmsProvider`，**开发期默认 Mock**；业务代码不绑定阿里云 | 联调前 |
| A-04 | 评价链接能否放进短信模板 | 先按"阿里云通知短信 固定域名 + `${token}` 变量"设计；若审核不允许，降级为"短信带工单号 + 短域名跳转页" | 联调前 |

### 10.3 真正的**上线前置**依赖（不阻塞开发，但阻塞上线）
1. **短信签名/模板实名审核**：需企业资质 + 已备案域名，运营商报备有周期，须提前启动（文档 §10.3 明确要求不要放到上线当天）。
2. **域名 + HTTPS 证书**：H5 需在微信内置浏览器打开，必须 `https://` 且域名已备案。
3. **反向代理端口/防火墙**：对外仅暴露 443；`app:13000` 与 `postgres:5432` 不得对外。
4. **数据保留期与法务口径**：默认 24 个月，最终由法务/运营确认。

### 10.4 需要在 Phase 2/5 实测确认的技术点（不阻塞 Phase 1）
| # | 技术点 | 若不成则的降级方案 |
|---|---|---|
| T-01 | `defineCollection` 是否直接声明**复合索引** | 用 `db.sequelize.getQueryInterface().addIndex()` 在插件 `install()`/`afterLoad()` 补建 |
| T-02 | 插件内**服务端写入 File Collection** 的官方 API 形态 | 直接经 `ctx.db.getRepository('attachments').create()` + storage 适配器写盘（同附件中间件路径） |
| T-03 | 本地存储引擎的 `baseUrl` 能否指向**非静态受控路径** | 若不能：文件物理落盘到插件自管私有目录，`attachments` 仅存元数据，读取全部走 `GET /api/svc/photos/:id` |
| T-04 | NocoBase ACL 数据范围能否直接过滤**用户多对多门店** | 由插件 `storeScope` 中间件兜底（已设计，独立于 ACL 生效） |

---

## 11. 开发计划（Phase 1 → Phase 10）

| Phase | 目标 | 关键产出 | 验收（必须可运行） |
|---|---|---|---|
| **1** | 初始化与启动 | `Dockerfile`、`docker-compose.yml`、`.env.example`、postgres/nocobase/nginx、插件空壳、README | `docker compose up -d` 后能登录 NocoBase，插件已加载（`/api/svc/health` 返回 ok） |
| **2** | 数据与权限底座 | 9 张表、索引、`storeUsers` 多对多、`storeScope` 中间件、ACL 角色、取号器、TicketEvent、门店工单列表/详情页 | 门店 A 用户无法通过 API 看到门店 B 工单（AT-03） |
| **3** | 客户 H5 报修 | `/report` 页面 + `POST /api/public/tickets` + 限流/幂等/防重 | AT-01、AT-02；连点只产生 1 张工单 |
| **4** | 派工与通知 | dispatch/reassign/reschedule + ServiceVisit + 师傅 Token + 客户/师傅短信（Mock）+ SmsLog | AT-04、AT-05 |
| **5** | 师傅 H5 | `/technician/visit/:token` + 照片上传 + 结果/收费 + 提交 | AT-16 ~ AT-19、AT-22 |
| **6** | 门店确认与多次 Visit | confirm/reject + 时间线 + 改派/改约失效旧 Token | AT-08、AT-09、AT-20、AT-21、AT-23 |
| **7** | 匿名评价与重开 | `/review/:token` + 收费一致性 + 低评分重开 + 收费不一致重开 | AT-10、AT-11、AT-12、AT-24 |
| **8** | 短信回执与重试 | `callbacks/sms/:provider` 验签幂等 + 重试 1 次 + 异常标记 | AT-06 |
| **9** | SLA / 看板 / 报表 | 定时任务、总部看板、KPI、Excel 导出（脱敏） | AT-15 + 报表口径核对 |
| **10** | 测试 / 安全 / 生产 | 全量测试、安全检查、生产部署、备份恢复、上线清单 | 24 项测试全绿 |

**每个 Phase 的强制输出格式**（严格按文档 §27）：
【本阶段目标】【本阶段修改的目录/文件】【完整代码】【数据库变更】【配置项】【运行命令】【测试方法】【预期结果】【当前完成情况】【下一阶段】
—— 不留已知错误进入下一阶段；禁止"其余代码省略/按类似方式实现/此处自行补充"。

**当前进度**：Phase 0 完成 ✅ ｜ 下一步 **Phase 1：项目初始化（Docker + PostgreSQL + NocoBase + Nginx + 插件空壳，确保可启动）**
