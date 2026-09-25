# API 清单

- 基址：`https://<domain>/api`（NocoBase `API_BASE_PATH`，默认 `/api`）
- 编码：`application/json`（上传接口为 `multipart/form-data`）
- 统一响应：成功 `{ "data": ... }`；失败 `{ "errors": [ { "code": "...", "message": "...", "detail": {...} } ] }`
- 所有写接口必须带 `X-Request-Id`（UUID v4），用于幂等与链路追踪
- 所有接口有 DTO/Schema 校验；**字段白名单**，禁止 mass assignment

## 0. 错误码

| code | HTTP | 含义 |
|---|---|---|
| `VALIDATION_FAILED` | 422 | 字段校验失败 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `DUPLICATE_TICKET` | 409 | 命中重复单，body 带已有 `ticket_no` |
| `TOKEN_INVALID` | 401 | Token 不存在/已使用/已过期（统一模糊化） |
| `CONFLICT_STATE_CHANGED` | 409 | 状态已被他人改变（乐观并发失败） |
| `FORBIDDEN_SCOPE` | 403 | 越权访问其他门店数据 |
| `BUSINESS_RULE_VIOLATION` | 422 | 业务规则不满足（如收费校验） |
| `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` / `FILE_COUNT_EXCEEDED` | 413/415/422 | 文件校验失败 |
| `INTERNAL_ERROR` | 500 | 服务端异常（日志记录 traceId，不回显堆栈） |

---

## 1. 客户匿名接口

### 1.1 `GET /api/public/stores`
- 认证：匿名（限流 `security.ip_minute_limit`）
- 响应：`[{ "code": "S01", "name": "圣大家电新都店" }]`
- 只返回 active 门店的 `code/name`，**不返回 id、电话、地址**

### 1.2 `POST /api/public/tickets`
- 认证：匿名；限流 IP + 手机号；`X-Request-Id` 幂等
- 入参（白名单，其余字段一律忽略）：
```json
{
  "store_code": "S03",
  "source": "qr",
  "ticket_type": "repair",
  "content": "空调不制冷，出风有异味",
  "customer_name": "张某",
  "customer_mobile": "13800000000",
  "privacy_agreed": true
}
```
- 校验：`store_code` 存在且 active；`source ∈ {qr,link,staff}`；`ticket_type ∈ {repair,complaint}`；`content` 去空白后 5–500 字；姓名 1–32 字；手机号 `/^1[3-9]\d{9}$/`；`privacy_agreed === true`
- 服务端行为：取号 → 建 NEW 工单 → 写 `created` 事件 → 写幂等记录
- 响应：`{ "ticket_no": "FW20260920-0001", "store_name": "...", "created_at": "..." }`
- **绝不返回** `id`、处理人、其他工单、门店内部信息

### 1.3 `GET /api/public/reviews/:token`
- 认证：Token（限流）
- 响应：`{ "store_name": "...", "ticket_no": "FW...", "is_charged": true, "confirmed_charge_amount": "120.00", "expires_at": "..." }`
- Token 已使用时仍返回 200，但 `"used": true` + 原评价摘要（页面只显示"已提交"，不可修改）
- **不含**手机号、姓名、师傅信息、工单 id

### 1.4 `POST /api/public/reviews/:token`
- 入参：
```json
{
  "rating": 5,
  "comment": "师傅很及时",
  "charge_match": "match",
  "customer_reported_amount": null
}
```
- 校验：`rating` 1–5 整数；`comment` ≤500 字；`charge_match ∈ {match,mismatch,not_applicable}`；`reset(未收费时)` 只能 `not_applicable`；`mismatch` 时 `customer_reported_amount` 可选但 ≥0
- 行为：写评价 → Token 立即失效 → 按 M12/M13 分流（可能转 PROCESSING 并 `escalated=true`）
- 响应：`{ "result": "closed" | "reopened", "rating": 5 }`

---

## 2. 师傅 Token 接口

> **🔑 Token 无效 → `401 TOKEN_INVALID`（本节全部接口）**
> 本节是**真正的匿名业务接口** —— Token 本身就是访问该资源的**认证凭证**，所以"Token 无效"就等于"你未被认证"，`401` 是准确语义。
>
> **对外一律只返回 `TOKEN_INVALID`**，不区分「不存在 / 已过期 / 已使用 / 被改派撤销」（防枚举）。
>
> ⚠️ **不要把这个 `401` 与 Phase 4 的诊断探针混为一谈**：`POST /api/svc:tokenCheck`（总部特权、仅 mock 通道存在）
> 是**询问**"这个 Token 有效吗"，因此返回 **`200` + `{valid:false, code:'TOKEN_INVALID'}`** —— 查询本身成功了，结论在 body 里。
> 两者形态不同、语义一致，理由见 `docs/DEVIATIONS.md` **DEV-45**（已接受偏差）。
>
> **硬验收矩阵**（Phase 5，见 `docs/DEV-PLAN.md` §Phase 5）：Visit #1 的 Token 改派前 `200` →
> **同一条 Token** 改派后 `401` → 新 Visit 的 Token `200`；过期 / 已使用 / 随机不存在 → 一律 `401`。

### 2.0 对外短链：短信里的那个链接长什么样（⚠️ 先看这条再看 2.1~2.3）

**短信里只出现一个地址，且它是长期稳定的对外契约：**

```
{PUBLIC_BASE_URL}/t/{token}          ← 对外契约（短信、已发出的链接、客服口述都用它）
        │  nginx 302（临时重定向，**不是 301**）
        ▼
    /h5/technician/visit/{token}     ← H5 的真实路由：内部实现路径，可随时调整
```

| 事实 | 值 | 谁说了算 |
|---|---|---|
| 对外前缀 | `/t/` | `TECHNICIAN_TOKEN.LINK_PATH`（`constants.ts`） |
| token 形态 | 43 字符 base64url（`[A-Za-z0-9_-]{43}`） | `TECHNICIAN_TOKEN.PATTERN` / `.LENGTH` |
| 跳转码 | `302`（`absolute_redirect off`，Location 为**相对路径**） | `nginx/conf.d/service.conf` |
| H5 实际路径 | `/h5/technician/visit/{token}` | `TECHNICIAN_LINK.H5_PATH_PREFIX` |

**为什么绕一层 302**：把**外部契约**与**前端部署结构**解耦。将来 H5 从 `/h5/` 挪到别处，
只需改 nginx 那一条 `return` —— 短信模板、已发出的链接、常量全都不用动。
（用 `301` 会把"随时可能变的目标"钉死在各家客户端缓存里，**明令禁止**。）

**边界（重要）**：
- `{PUBLIC_BASE_URL}/t/{token}` 返回 **302**，**不返回工单内容** —— 它只是把浏览器送到 H5。
- 畸形 token（长度/字符不符）**不匹配短链正则**，回落显式 `404`，**绝不 302 进 H5**
  （否则页面白渲染一次再吃 401，且无法区分"链接坏了"与"Token 失效了"）。
- `/t/` 段 `access_log off`：token 明文出现在请求行里，**不得落 nginx 访问日志**。
- Token 的取值（`GET /api/technician/visits/:token`）是**接口**，与短链是**两回事** →
  详见 2.1；短链只负责"把人送到页面"。

### 2.1 `GET /api/technician/visits/:token`
- 认证：Token；限流
- 响应（**最小必要信息**）：
```json
{
  "ticket_no": "FW20260920-0001",
  "store_name": "圣大家电新都店",
  "ticket_type": "repair",
  "content": "空调不制冷",
  "expected_visit_at": "2026-09-21T10:00:00+08:00",
  "expires_at": "2026-09-24T10:00:00+08:00",
  "status": "pending",
  "photos_count": 2,
  "max_photos": 6,
  "max_photo_size_mb": 5,
  "service_results": [
    { "value": "resolved",        "label": "已解决",     "note_required": false },
    { "value": "need_followup",   "label": "需再次上门", "note_required": true },
    { "value": "unresolved",      "label": "未解决",     "note_required": true },
    { "value": "customer_absent", "label": "客户不在家", "note_required": true },
    { "value": "other",           "label": "其他",       "note_required": true }
  ]
}
```
- **不含**客户手机号历史工单、其他门店信息；客户姓名仅在使用需要时返回（默认不返回）
- `service_results` 是**处理结果选项的唯一事实来源**：H5 不自己手抄枚举与中文标签。其中 `note_required` 告诉前端**该结果是否必须填处理说明**（规则见 §2.3 / DEV-82），前端据此切换必填标记与提交闸门 —— 规则维护在服务端一处，避免前后端各判一份而漂移。

### 2.2 `POST /api/technician/visits/:token/files`
- `multipart/form-data`：`file`（单张）、`photo_type ∈ {onsite,completed,receipt,other}`
- 校验链：Token → Visit → 有效期 → 未使用 → 数量 ≤ `visit.photo_max_count` → 单张 ≤ `visit.photo_max_size_mb` → **magic bytes 真实类型** ∈ {jpeg,png,webp}
- 服务端：去 EXIF 重编码 → 写入**私有存储** → 建 File Collection 记录 → 建 `serviceVisitPhotos`
- 响应：`{ "photo_id": 12, "photo_type": "onsite", "sort_order": 1 }`

### 2.3 `POST /api/technician/visits/:token/submit`
- 入参：
```json
{
  "service_result": "resolved",
  "service_note": "更换电容，已试机正常",
  "is_charged": true,
  "reported_charge_amount": 180.00
}
```
- 校验：`service_result ∈ {resolved,need_followup,unresolved,customer_absent,other}`；`service_note` **条件必填**（见下）、≤ 500 字；`is_charged` 布尔；`is_charged=true → reported_charge_amount > 0`，`false → 金额必须为 0`
- **`service_note` 的必填口径（DEV-82，用户 2026-09-25 拍板）**：
  - `service_result = resolved` → **可留空**（结构化结果已表达"已解决"，再强迫写一段文字容易产出"已处理""完成"这类无信息量内容）
  - 其余四种（`need_followup` / `unresolved` / `customer_absent` / `other`）→ **必填**：`need_followup`/`unresolved` 必须知道**为什么还没解决**；`other` 不写说明门店审核时无法理解发生了什么
  - 服务端是**权威校验**：命中必填而未填 → `422 MISSING_SERVICE_NOTE`（错误文案带上结果中文名）；留空时落库为 `NULL`
  - 前端必填规则**由本接口下发**（§2.1 的 `service_results[].note_required`），不得自己判
  - 判定取"**可留空名单**"（当前只有 `resolved`）而非"必填名单" —— **失败安全**：将来新增枚举若忘登记，默认按必填处理
- 行为：M8 → 状态 `WAIT_STORE_CONFIRM`；Token 失效；**不发客户评价短信**
- 响应：`{ "status": "WAIT_STORE_CONFIRM", "submitted_at": "..." }`

---

## 3. 短信回执

### 3.1 `POST /api/callbacks/sms/:provider`
- `provider ∈ {aliyun,tencent,mock}`；验签方式按 provider 实现（阿里云 HMAC-SHA1 签名 / 腾讯云签名；Mock 走共享密钥）
- **不适用匿名 ACL**：走独立签名校验中间件
- 入参（阿里云示例）：`phone_number`、`send_time`、`report_time`、`success`、`err_code`、`err_msg`、`biz_id`、`out_id`、`signature`
- 行为：`unique(provider, biz_id)` 幂等 → 更新 `SmsLog.delivery_status/delivered_at` → 失败则 `sms_failed` 事件（**同一 biz_id 只写一次**）
- 响应：`{"code":"OK"}`（供应商要求固定格式）

---

## 4. 内部接口（需登录 + 门店数据隔离）

角色：`store_after_sales`（门店售后）/ `hq_after_sales`（总部售后）/ `hq_admin`（总部管理员）/ `viewer`（只读管理层）

| # | 方法 | 路径 | 角色 | 入参要点 |
|---|---|---|---|---|
| I1 | POST | `/api/svc/tickets/:id/accept` | 门店/总部 | — |
| I2 | POST | `/api/svc/tickets/:id/transfer` | 门店/总部 | `target_store_code`、`reason`(必填) |
| I3 | POST | `/api/svc/tickets/:id/dispatch` | 门店/总部 | `service_mode`、`provider_name?`、`expected_visit_at?`、`technician_name?`、`technician_mobile?`、`customer_mobile?`（修正） |
| I4 | POST | `/api/svc/tickets/:id/reschedule` | 门店/总部 | `expected_visit_at`、`reason` |
| I5 | POST | `/api/svc/tickets/:id/reassign` | 门店/总部 | `technician_name`、`technician_mobile`、`reason` |
| I6 | POST | `/api/svc/tickets/:id/cancel` | 门店/总部 | `reason` |
| I7 | POST | `/api/svc/tickets/:id/remote-complete` | 门店/总部 | `completion_result`、`completion_note`、`is_charged?`、`amount?` |
| I8 | POST | `/api/svc/tickets/:id/customer-mobile` | 门店/总部 | `customer_mobile`（必写事件） |
| I9 | POST | `/api/svc/tickets/:id/resend-sms` | 门店/总部 | `scene ∈ {dispatch_customer,technician_task,review_invite}`；需校验业务前置状态 |
| I10 | GET | `/api/svc/tickets/:id/timeline` | 门店/总部 | 分页；返回 TicketEvent + 关联 SMS 摘要 |
| I11 | GET | `/api/svc/visits/:id` | 门店/总部 | Visit + 照片列表（含短时签名 URL） |
| I12 | POST | `/api/svc/visits/:id/confirm` | 门店/总部 | `confirmed_charge_amount`、`note?`（金额≠填报时必填） |
| I13 | POST | `/api/svc/visits/:id/reject` | 门店/总部 | `reason` 必填 |
| I14 | GET | `/api/svc/photos/:photoId` | 门店/总部 / 短时签名 | 权限校验后流式返回；`?exp=&sig=` 签名模式 10 分钟有效 |
| I15 | GET | `/api/svc/dashboard/summary` | 全部（按角色裁剪范围） | `from/to?`、`store_code?` |
| I16 | GET | `/api/svc/reports/kpi` | 总部 | 见 §5 口径 |
| I17 | GET | `/api/svc/export/tickets` | **仅总部** | 同筛选条件；脱敏 + 防 CSV 注入 + 写导出事件 |
| I18 | GET/PUT | `/api/svc/settings` | 总部管理员 | 白名单配置键 |
| I19 | GET | `/api/svc/health` | 内部 | DB / SMS provider / 定时任务心跳 |

**Phase 4 已实现的内部动作**：`accept`(I1) / `transfer`(I2) / `dispatch`(I3) / `reschedule`(I4) / `reassign`(I5) / `cancel`(I6) / `timeline`(I10)。

> **调用形式**（`docs/DEVIATIONS.md` DEV-18）：`svc` 资源的自定义 action 走
> `/api/svc:<action>?filterByTk=<ticketId>`（NocoBase resourcer 形式，写接口另需 `X-Request-Id`）；
> 上表里的 REST 风格路径（如 `/api/svc/tickets/:id/dispatch`）由 **nginx 内部重写**到同一入口 ——
> **二者是同一个接口**，不是两套实现。

> **I5 改派的语义**（`docs/PHASE-4.md` §4）：**终止旧 Visit（置 `SUPERSEDED`，旧行一个字段都不改）+ 新建 Visit**
> （新行 `reassigned_from_visit_id` 指回旧行），旧 Token **同事务失效**。
> **责任人判据 = `technician_mobile` + `provider_name` + `service_mode`**（姓名不在其中）；责任人未变化时拒绝改派（`422 SAME_RESPONSIBLE_PARTY`）。

**验收探针（Phase 4 新增，⚠️ 仅在 `sms.provider=mock` 时存在）**

| # | 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|---|
| P1 | POST | `/api/svc:tokenCheck` | **总部特权** | 校验任意师傅 Token 是否有效。响应 `{valid, code?}`；**无效时返回 `200` + `valid:false`**（诊断语义，非认证失败 —— 见 §2 与 `docs/DEVIATIONS.md` DEV-45） |
| P2 | GET | `/api/svc:smsOutbox` | **总部特权** | 读取 mock 短信发件箱条目（`since_seq` / `limit`），只回**脱敏**收件人 |

> ⚠️ **自毁闸**（`docs/DEVIATIONS.md` DEV-41）：`sms.provider ≠ mock` 时 **P1 / P2 一律返回 `404 NOT_FOUND`**（**不是** 403）——
> 真实通道下它们**本来就不该存在**。且**能力校验先于自毁闸**（非特权角色拿 `403`，不会先探出"接口存不存在"）。
> Phase 5 交付正式师傅接口后 **P1 仍保留**：它验证的是"Token **没通过**"这一侧，
> 而那正是匿名接口不该对外暴露的细节（失效原因的区分）。

**角色 × 动作矩阵（服务端强制）**

| 动作 | 门店售后 | 总部售后 | 总部管理员 | 只读管理层 |
|---|---|---|---|---|
| 查看工单 | 授权门店 | 全部 | 全部 | 全部 |
| 受理/派工/改派/改约/转店/取消 | ✅ | ✅ | ✅ | ❌ |
| 确认/驳回 Visit | ✅ | ✅ | ✅ | ❌ |
| 重发短信 | ✅ | ✅ | ✅ | ❌ |
| 强制转店 / 重开已关闭 | ❌ | ✅ | ✅ | ❌ |
| 看完整手机号 | ✅ | ✅ | ✅ | ❌（脱敏） |
| 修改参数 / 用户 / 门店 | ❌ | ❌ | ✅ | ❌ |
| 导出 Excel | ❌ | ❌ | ✅ | ❌ |

---

## 5. 报表口径（`/api/svc/reports/kpi`）

| 指标 | 口径 |
|---|---|
| 首次响应时长 | `first_response_at - created_at` |
| 闭环时长 | `closed_at - created_at`（首次进入 CLOSED） |
| 待受理超时率 | 超 `sla.accept_minutes` 仍为 NEW / 新工单 |
| 预约逾期未回执数 | `expected_visit_at < now` 且 status=PROCESSING 且无 `submitted_at` |
| 待门店确认数/时长 | status=WAIT_STORE_CONFIRM 数量及 `submitted_at → store_confirmed_at` |
| 评价参与率 | `review_status=submitted` / 进入过 WAIT_FEEDBACK 的工单 |
| 平均评分 / 低评分率 | 已评价均值；`rating ≤ 阈值` 占比 |
| 重开率 | `reopen_count > 0` / 已完成工单 |
| 短信送达率 | `delivery_status=delivered` / 已提交短信 |
| 确认收费金额 | `confirmed_charge_amount` 按门店/时间/处理方式汇总（仅业务统计） |
| 处理方式分布 | inhouse / manufacturer / third_party / remote |
| 收费不一致率 | `customer_charge_match=mismatch` / 有收费记录且完成评价的 Visit |

筛选维度：`date range`、`store`、`ticket_type`、`status`、`service_mode`、`rating`。
导出字段与筛选条件对齐；手机号按角色脱敏。

> **不提供**"实际上门准时率/到达时间"类指标（师傅不登录，无法验证）——文档 §15 明确要求不做看似精确不可验证的 KPI。

---

## 6. NocoBase 原生接口的使用边界

| 用途 | 允许 | 说明 |
|---|---|---|
| 后台列表/详情读取 | ✅ `/api/serviceTickets:list|get`、`/api/serviceVisits:list`、`/api/ticketEvents:list`、`/api/smsLogs:list` | 受 ACL + `storeScope` 中间件约束 |
| 后台新建/修改 | ⚠️ 仅限非状态字段（如补充备注） | `status / escalated / reopen_count / *_token_hash / dispatch_at / closed_at` 等由 ACL 设为**只读** |
| 状态类变更 | ❌ 禁止直调原生 update | 必须走 `/api/svc/...` 业务 action |
| 匿名访问 | ❌ 完全禁止 | 匿名只允许 §1–§3 列出的 8 个 action |
