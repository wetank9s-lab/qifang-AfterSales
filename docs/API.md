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

### 1.1b `GET /api/public/store-entry?k=<入口>`

> **✅ Phase 11 / P11-1 已实现（2026-10-10，基线 `8b91a04`）。** 门店**专属报修入口**的解析接口。
> **🔴 2026-10-10 契约收紧（A1）**：响应**只有四个字段**，`provenance` **不再下发**（见下）。

- 认证：匿名；与 `1.1` 共用同一个 IP 分钟限流桶（都是"进页面前必调"的读接口，分开计桶等于给两倍免费额度）
- 入参：`k` = 门店入口值。两种形态（服务端**如实区分**，见下）
- 响应：`{ "code": "S01", "name": "圣大家电新都店", "phone": "028-…"|null, "address": "…"|null }`
  - **只有这四个字段** —— 无 `id`、无内部字段、无后台权限数据
  - `phone` / `address` 取自门店**真实资料**（`stores.contact_phone` / `stores.address`）；
    **没有就回 `null`，页面不渲染该行** —— 服务端**不编造**电话与地址
    （⚠️ 实测 15 家门店的 `contact_phone` 目前全为 `NULL`，属**数据缺口**，不是接口缺陷）
  - `provenance ∈ {signed, legacy}` 在服务端**照旧判定并落库审计**，但
    **不再下发给客户**：用户明确"不向客户展示签名/防篡改/锁定机制等技术说明"。
    安全边界保留在代码、日志与技术文档里 —— **这是"不再下发"，不是"放宽校验"**
  - 反向判据：响应体**必须根本不存在** `provenance` 这个键
    （"页面不显示"不等于"接口没给" —— 接口给了，下一个改页面的人就可能把它渲染出来）
- 失败：入口缺失 / 签名不匹配 / 门店不存在 / **门店已停用** → 一律 **404 `STORE_ENTRY_INVALID`**
  - ⚠️ 四种情况**对外同形**：区分它们等于告诉探测者"这个编码存在，只是签名不对 / 只是停用了"
- 稳定码：`404 STORE_ENTRY_INVALID`

### 1.2 `POST /api/public/tickets`

> **🔴 Phase 11 / P11-1（`8b91a04`）起，门店归属由入口决定，不再由 body 决定。**
> 旧契约（"`store_code` 决定门店"）已作废：它正是"改一个请求体就能把单写到别家店"的来源。
> **🔴 2026-10-10 三处口径变更（A2 / A4 / B）**：隐私同意改告知式、`urgent` 移出匿名白名单、
> 类型枚举扩为六类（客户面仍只有两种）。逐条见下。

- 认证：匿名；限流 IP + 手机号；`X-Request-Id` 幂等
- **入口走 query（不是 body）**：`POST /api/public/tickets?k=<入口>`
  - `k` 的两种形态同 §1.1b（`signed` / `legacy`），**服务端解析后才决定门店**
  - ⚠️ 旧参数名 `?store=S01` **在 API 层不构成入口**（只认 `k`）——
    H5 页把 `?store=` 转成 `?k=` 是**必需**的一步，不是装饰
- 入参（白名单，其余字段一律忽略）：
```json
{
  "k": "（在 query 上，不在这里）",
  "store_code": "S03",
  "source": "qr",
  "ticket_type": "repair",
  "content": "空调不制冷，出风有异味",
  "customer_name": "张某",
  "customer_mobile": "13800000000",
  "service_address": "成都市新都区XX路1号3栋2单元501",
  "appliance_category": "air_conditioner",
  "brand_model": "海尔 BCD-216STPT"
}
```
> ⚠️ 与旧文档的差别（**都已在实现里生效**）：
> - **没有 `privacy_agreed`**：客户 H5 不再发这个键（同意由"页脚常驻告知 + 提交行为"承载）；
> - **没有 `urgent`**：用户 A4 决定"紧急标记只由授权门店人员设定"，该字段已从匿名白名单移除。
>   客户即使显式传 `urgent: true` 也**被忽略**（落库仍为 `false`），**不是** 422；
> - `source` 可以不带：缺省即 `qr`（新页面只在 URL 带 `?source=` 时才发它）。
>   ⇒ 判据必须落在**库里的 `source` 列**上（必须仍是 `qr`），不能只看"请求体里有没有这个键"。

- 校验顺序（**先门店、后内容**，顺序固定 ⇒ 同一请求永远得到同一条提示）：
  - **门店归属**：`k` 必须能解析出**已启用**的门店，否则 `422 MISSING_STORE_ENTRY` / `422 INVALID_STORE_ENTRY`
  - `store_code`（**选填**）只作**一致性校验**：与入口不一致 → `422 STORE_BINDING_CONFLICT`
  - `source ∈ {qr,link,staff}`（缺省 `qr`）
  - **`ticket_type ∈ {repair, complaint}`** —— 这是**匿名客户面**的白名单（`PUBLIC_TICKET_TYPE_VALUES`），
    **不是**内部六类。匿名提交 `installation` / `maintenance` / `relocation` / `other`
    → `422 INVALID_TICKET_TYPE`（六类是**内部工单分类**，不是六个客户报修选项）
    - 客户"**我要报修**" → `repair`；"**我要投诉**" → `complaint`
  - `content` 去空白后 5–500 字；姓名 1–32 字；手机号 `/^1[3-9]\d{9}$/`
  - **Phase 11 / P11-1 新增四项（全部选填）**：
    `service_address` ≤200 字；`appliance_category` ∈ §8.2 固定枚举
    （`air_conditioner` / `refrigerator` / `washer` / `tv` / `kitchen_bath` / `small_appliance` / `other`）；
    `brand_model` ≤64 字（**单个**字段）；`urgent` —— ⚠️ **已不在匿名白名单内**（见上方说明）
- **隐私同意（A2：告知式，不是勾选门槛）**：

  | 客户端发来的 | 行为 | 落库审计 `privacy` |
  |---|---|---|
  | **不带** `privacy_agreed`（新 H5 形态） | 正常建单 | `{ basis: "submission", agreed: true, version: "<告知版本>" }` |
  | `privacy_agreed: true`（旧产物 / 旧二维码） | 正常建单 | `{ basis: "checkbox", agreed: true, … }` |
  | `privacy_agreed: false`（旧勾选页面的"未勾选"形态） | **400 `PRIVACY_NOT_AGREED`，不落库** | — |

  - 即：**门槛只对"缺失"放开，对"明示拒绝"依旧关闭**。
    "不要求客户做额外勾选" ≠ "客户说了不同意也照建单" ——
    不得因为删掉 UI 而削掉既有的隐私保护（用户原话）。
  - `basis` 是**新增键**：既有行没有它 ⇒ 缺省即"勾选时代"，历史**不重写**。
  - **不得**把新形态伪造成"客户勾过复选框"：审计必须如实记录同意的**形态**。
- 服务端行为：解析入口 → 取号 → 建 NEW 工单（写入口来源 `provenance`）→ 写 `created` 事件 → 写幂等记录
  - `metadata.entry_provenance = signed | legacy` 落 **`ticket_events.metadata_json`**（`created` 事件）
  - `created` 事件的 `summary` 用 **`TICKET_TYPE_LABEL[ticket_type]`** 取名
    （六类扩展前它是 `ticketType === 'complaint' ? '投诉' : '报修'` 的二元三元式 ⇒
     四类会被写成"报修"。见 DEV-129）
- 响应：`{ "ticket_no": "FW20260920-0001", "store_name": "...", "created_at": "..." }`
- **绝不返回** `id`、处理人、其他工单、门店内部信息
- 稳定错误码（P11-1 相关）：`422 MISSING_STORE_ENTRY` · `422 INVALID_STORE_ENTRY` ·
  `422 STORE_BINDING_CONFLICT` · `422 INVALID_TICKET_TYPE` · `422 INVALID_APPLIANCE_CATEGORY` ·
  `422 INVALID_FIELD_LENGTH` · `400 PRIVACY_NOT_AGREED`（仅显式拒绝）
- 门禁：`scripts/verify-store-entry.mjs`（**89 项 / 0 未达标**，含真实浏览器 9 条判据：标题/门店卡/
  无勾选无编号/双表单字段/真实提交与归属/投诉免报修字段/切换不串字段/移动端无横向滚动与无意义空白/
  15 家入口逐个解析）· `scripts/verify-ticket-type.mjs`（**31 项**，六类五层一致性 + 匿名面隔离 +
  存量可查 + 冻结边界）

### 1.2b 工单类型：**内部六类** vs **匿名两类**（Phase 11 / P11-1 · 用户 B 段）

> **✅ 2026-10-10 已实现。** 迁移 `202610104-ticket-type-six`。
> 这一节单列，是因为它最容易做错：**"扩展枚举"与"放开客户选项"是两件事**。

| 层 | 取值 | 定义处 |
|---|---|---|
| **内部**（后台新建/筛选/报表） | `repair` 维修 · `installation` 安装 · `maintenance` 调试保养 · `relocation` 移机拆机 · `complaint` 投诉 · `other` 其他 | `TICKET_TYPE` / `TICKET_TYPE_VALUES` / `TICKET_TYPE_LABEL`（`constants.ts`）+ `TICKET_TYPE_OPTIONS`（`_options.ts`） |
| **匿名客户面** | `repair`（我要报修） · `complaint`（我要投诉） | `PUBLIC_TICKET_TYPE_VALUES`（`constants.ts`） |

- 🔴 **两套是两个不同的集合**（长度 6 vs 2），且匿名 ⊆ 内部。
  若匿名面直接复用 `TICKET_TYPE_VALUES`，客户就能自己提交"安装/移机"——
  那等于把**门店的业务判断**交给客户，也正是用户明确否掉的"六个客户报修选项"。
- 显示名与**稳定码**刻意不同名：`repair` 的内部标签是「**维修**」，
  而客户 H5 的按钮仍写「**我要报修**」。中文是展示文案，英文码是落库值与查询键 ——
  改一次文案不该变成一次数据迁移。
- **向后兼容**（硬要求）：库里既有取值只有 `repair` / `complaint`，
  含义与代码**都没有动**；迁移自检里断言 `repair` 仍在枚举内（**只增不减**）；
  存量工单继续按原值可查，**不静默改写历史业务类型**。
- **不改冻结状态机**：六个工单状态（`NEW` / `PROCESSING` / `WAIT_STORE_CONFIRM` /
  `WAIT_FEEDBACK` / `CLOSED` / `CANCELLED`）与 `ALLOWED_TRANSITIONS` 一个字都没动；
  六类之间在**建单路径上行为完全一致**（都落到 `NEW`、`service_mode` 为 `NULL`、
  不产生 Visit）⇒ **没有任何一类被强制走师傅上门**。
- ⚠️ **当前边界（诚实说明）**：`services.tickets.create()` 目前**唯一**的调用方是匿名接口
  （按设计只收两类）⇒ "内部建一张安装单"这条路径**现在还不存在**，属 **§9 / P11-2 门店人工新建**。
  本阶段对"内部六类可建"的判据是**服务层契约 + 数据形态**（见下），**不宣称已端到端打通**。
- 门禁：`scripts/verify-ticket-type.mjs`（**31 项**）
  - 五层一致性：常量 / collection 定义 / DDL / `fields` 元数据 `uiSchema.enum` / 迁移登记 + 产物 / `fieldGroups`
  - **匿名面隔离**（真 HTTP，双向）：六类逐一提交 → `repair`/`complaint` 201，其余四类
    `422 INVALID_TICKET_TYPE`，且**一条都没落库**
  - **存量可查**（真库 + 真 HTTP）：`distinct ticket_type ⊆ 六类`；按 `repair`/`complaint` 过滤
    查得出且过滤真的生效（反向控制：`ticket_type=fridge` → 0 行 ⇒ 证明过滤没被忽略）
  - **不强制上门**：`create()` 用 `TICKET_TYPE_VALUES` 校验，且方法体内**无任何按类型分叉**
    （允许清单逐条列出 + 两条变异测试证明它会红）；六类夹具形态逐字段一致
  - **冻结边界**：六个状态 / 中文名 / 迁移表 / `fields` 枚举逐字比对；类型与状态**无交集**
  - ⚠️ 该门禁的判据刻意**不从被测源码派生期望值**（从被测源码派生的期望值永远相等）



### 1.3 `GET /api/public/reviews/:token`

> **✅ Phase 7 已实现（2026-09-26，基线 `baf82aa`）。** 本节早期草案字段名已**按实现修正**；
> 权威契约见 `docs/PHASE-7.md` §3 / §5，交付记录见其 **§14**。

- 认证：Token（走 **path**，不走 query；`access_log off`，不落访问日志）+ 限流（IP 分钟 + Token 小时，分开计桶）
- 响应：`{ "ticket_no": "FW…", "store_display_name": "", "service_summary": "报修·…", "confirmed_charge_amount": 88.00, "is_charged": true, "review_state": "pending", "can_review": true }`
  - ⚠️ 字段名以实现为准：**`store_display_name`**（不是草案的 `store_name`）；**无 `expires_at`**（窗口信息不外泄）
  - `confirmed_charge_amount` 为 **`null` = 本次未收费**（≠ `0.00`）；`is_charged` 由服务端直接下发，页面不再自己推断
  - **`review_state ∈ {pending, submitted, expired}`** + `can_review` 表达终态
- 终态仍返回 **200**（不是 4xx），由 `review_state` / `can_review` 表达"已评价 / 已过期"
- **不含**手机号、姓名、师傅信息与 Token、工单内部 `id`、TicketEvent、内部备注 —— **只回最小上下文**

### 1.4 `POST /api/public/reviews/:token`

> **✅ Phase 7 已实现（2026-09-26，基线 `baf82aa`）。**

- 入参：
```json
{
  "rating": 5,
  "comment": "师傅很及时",
  "charge_match": "match",
  "customer_reported_amount": null
}
```
- **白名单**：仅上述 4 个字段（`rating` / `comment` / `charge_match` / `customer_reported_amount`）；
  多传字段 → `422 UNEXPECTED_FIELD`（**拒绝**，不静默忽略）
- 校验（**服务端最终权威**，H5 的显隐不作数）：`rating` 1–5 整数；`comment` ≤500 字；
  `charge_match ∈ {match,mismatch,not_applicable}`；**收费三态按 Visit 事实裁决** ——
  未收费只能 `not_applicable` 且**不得带金额**；已收费时为 `match`（**不得带金额**）或
  `mismatch`（**必须带** `customer_reported_amount`，`0 < amount ≤ 99999.99`）
- 行为：条件 UPDATE 原子推进（`submit` × `expiry` 竞争**恰好一个 winner**）→ Token 立即失效 →
  按 M12/M13 分流（`rating ≤ feedback.low_score_threshold` 或 `charge_match = mismatch` ⇒ `PROCESSING` + `escalated=true` + `reopen_count+1`）
- 响应：`{ "ticket_no": "FW…", "rating": 5, "closed": true, "reopened": false }`
- 稳定业务错误码：`409 REVIEW_ALREADY_SUBMITTED` · `410 REVIEW_EXPIRED` · `404 REVIEW_NOT_FOUND`
  （**不再使用草案的 `{"result": …}` 包裹**）

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
- 行为：M8 → 状态 `WAIT_STORE_CONFIRM`；Token 失效；**本接口不发评价短信**
  > ⚠️ **时态**：这是 Phase 5 师傅提交接口的行为（M8）。评价短信在
  > **门店 confirm 时**（`POST /api/svc/visits/:id/confirm`）由 confirm 事务发出 —— 见 **I12**。
  > **Phase 7 起发送路径已打开**（DEV-88：履行 O1-B 预留的启用条件）。
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
| I11 | GET | `/api/svc/visits/:id` | 门店/总部 | ✅ **P6-0 已实现**。Visit 回执读模型 + 照片**安全展示元数据**（id/photo_type/mime/size/宽高/sort_order/uploaded_at）。**不含**签名 URL、`storage_key`、`file_id`、任何磁盘路径 |
| I12 | POST | `/api/svc/visits/:id/confirm` | 门店/总部 | ✅ **P6-1 已实现**（action 名 **`visitConfirm`**，基线 `c593bcd`）。`confirmed_charge_amount`（`is_charged=true` 时必填、`0 < amount ≤ 99999.99`；`false` 时**不得携带**，落库 `NULL` 而非 `0.00`）、`note?`（**改额时必填**）。同事务写 Visit/Ticket/评价 Token/Event/幂等；loser `409 VISIT_NOT_REVIEWABLE`。**评价短信**：P6-1 阶段**不发送**（O1-B）；**Phase 7 起已在同一事务内 `enqueue(review_invite)` + 提交后 `flush`**（DEV-88 履行 O1-B 预留条件） |
| I13 | POST | `/api/svc/visits/:id/reject` | 门店/总部 | ✅ **P6-1 已实现**（action 名 **`visitReject`**，基线 `c593bcd`）。`reason` 必填。Visit → `REJECTED`、Ticket → `PROCESSING`（**不**自动生成下一 Visit，靠正常派工接力） |
| I14 | GET | `/api/svc/photos/:photoId` | 门店/总部（**登录态**） | ✅ **P6-0 已实现**。唯一模式 = 带登录态过授权链后流式返回（`Content-Type` 取库中 mime / `nosniff` / `private, no-store` / `inline`）。**无签名模式** —— `?exp=&sig=` 已作废，见 `docs/SECURITY.md` §5 与 `docs/PHASE-6.md` §4.3a |
| I15 | GET | `/api/svc/dashboard/summary` | 全部（按角色裁剪范围） | `from/to?`、`store_code?` |
| I16 | GET | `/api/svc/reports/kpi` | 总部 | 见 §5 口径 |
| I17 | GET | `/api/svc/export/tickets` | **仅总部** | 同筛选条件；脱敏 + 防 CSV 注入 + 写导出事件 |
| I18 | GET/PUT | `/api/svc/settings` | 总部管理员 | 白名单配置键 |
| I19 | GET | `/api/svc/health` | 内部 | DB / SMS provider / 定时任务心跳 |
| I21 | POST | `/api/svc:createTicket` | **门店角色**（`create_ticket`）/ **总部无此能力** | ✅ **P11-2 已实现**（2026-10-10）。**门店人工新建服务单**：可选**六类**（`repair` 维修 / `installation` 安装 / `maintenance` 调试保养 / `relocation` 移机拆机 / `complaint` 投诉 / `other` 其他），`urgent` 由授权员工设置，来源固定 `source=staff`、事件 `operator_kind=store` 且**记录操作人**。入参 snake_case 与 camelCase 都接受（`store_code`/`storeCode`…）：`store_code`（必填）、`ticket_type`（必填）、`content`（必填）、`customer_name`（必填）、`customer_mobile`（必填）、`service_address`/`appliance_category`/`brand_model`/`urgent`（选填）。响应 **只有 7 个字段**：`{ ticket_no, store_name, store_code, ticket_id, ticket_type, status, created_at }` （⚠️ 与幂等记录里的 `response_json` 是**同一个构造函数** ⇒ 重放两次**逐字节一致**）。**门店范围由服务端裁决**：`store_code` 解析出的门店必须在 `scopeOf(actor).storeIds` 里，越权回 **403 `STORE_OUT_OF_SCOPE`**（不是 404 —— "建到哪家"是操作意图，不是对某对象的读取）；角色本身没有能力回 **403 `FORBIDDEN`**。🔴 **总部汇总查看权限 ≠ 跨店创建权限**：`HQ_AFTER_SALES`/`HQ_ADMIN` 有 `write_ticket` 但**没有** `create_ticket`（`CREATE_ROLES = [store_after_sales]`）。⚠️ 本动作**不放宽**匿名面的两类白名单：`GET/POST /api/public/*` 仍是 `PUBLIC_TICKET_TYPE_VALUES = [repair, complaint]`，且匿名面**没有** `urgent` 字段。新建的单状态恒为 `NEW`（**不重新引入「受理」步骤**），跨店转单仍不可用。

#### §I21 补充契约（2026-10-10 · P11-2 客户端交付时加固）

**门店怎么填**：前端**不许自己猜** —— 弹窗里调 `GET /api/svc:storeOptions`（I20，按 `scopeOf(actor)` 裁，门店角色只看到自己被授权的门店），单一门店直接固定、多门店给选择器；服务端仍做 `assertStoreInScope`（前端只负责填；准不准由服务端说了算）。
⚠️ 历史教训 **DEV-139**：第一版从页面上下文 / 全局变量里「猜」门店码 ⇒ 空串 ⇒ `422 MISSING_STORE`，而界面把它吞成「点了没反应」。

**幂等（用户裁决二 · 第 10 条）**：命中 `(scene, requestId)` 之后**必须逐字段比对**
（门店 / 类型 / 正文 / 手机号 / 服务地址 / 家电类别 / 品牌型号 / 紧急 / **操作人**），全等才回放：

| 情形 | 响应 |
|---|---|
| 全部一致 | **200** + `X-Idempotent-Replay`，响应体与首次**逐字节一致** |
| 有任何一项不同 | **409 `IDEMPOTENT_PAYLOAD_MISMATCH`**（`detail.differences` 列出差异） |
| 幂等记录在但工单已不存在 | **409 `IDEMPOTENT_RESOURCE_MISSING`** |
| 占位已写但响应体缺失 | **409 `IDEMPOTENT_RESPONSE_MISSING`**（**不伪造成功**） |

⚠️ 顺序：**能力与门店范围校验先于幂等判定** —— 越权者不该从这条路里探出「某个 requestId 是否被用过、用在哪家门店」。
⚠️ 这条防的是**静默丢请求**：只按 requestId 回放时，「换了内容却复用同一个 requestId」的请求**根本没被创建**，而调用方看到「成功 + 一个单号」。
⚠️ 判据：`verify-store-create.mjs` ② 用**三种改法**（改正文 / 改类型 / 改手机号）断言 409，并单列「改门店 ⇒ 403（越权优先）」，再加上「原内容仍 200 回放且两次响应体逐字节一致」。

| I20 | GET | `/api/svc/store-entry` | 门店（按 `applyScope` 裁范围）/ 总部 | ✅ **P11-1 已实现**（action 名 **`storeEntryLinks`**，基线 `8b91a04`）。取**门店专属报修入口**的链接与二维码：`{ base_url, count, items:[{ code,name,active,entry,url,qr_svg,qr_filename,legacy_url }] }`。二维码 SVG 由**服务端**生成（`qrcode` 打进服务端产物 ⇒ 浏览器零依赖）；链接基址来自 `services/public-url.ts`（对外地址唯一来源）。**鉴权只到 `loggedIn`**，数据范围由 handler 内的 `applyScope` 裁（门店账号只看自己被授权的门店）；⚠️ 未配 `SIGN_SECRET` 时回 **503 `ENTRY_SECRET_MISSING`**（fail-closed，**不产出不带签名的链接**） |

**Phase 4 已实现的内部动作**：`accept`(I1) / `transfer`(I2) / `dispatch`(I3) / `reschedule`(I4) / `reassign`(I5) / `cancel`(I6) / `timeline`(I10)。

**Phase 6 · P6-0 已实现**：`visits/:id`(I11 读模型，action 名 **`visitDetail`**) / `photos/:photoId`(I14 受控读取，action 名 **`photo`**)。
- 两者都要求**登录**（匿名 → 401），授权链为 `resolveActor → scopeOf → Photo/Visit→Ticket 归属 → assertCanAccessTicket`；
- 越权与不存在**统一 404 且响应体逐字节相同**（防存在性泄露）；
- ⚠️ action 名不能复用 `visits` —— 它已被"按 ticketId 列派工历史"占用（`/api/svc:visits?filterByTk=<ticketId>`）。对外路径仍按本表写，由 nginx 重写成 `/api/svc:visitDetail?filterByTk=:id`。
- 门禁：`scripts/verify-store-photo-access.mjs`（四边界 B1~B5 + N1/R1/R2/S1/O1，`--reverse` 逐条证明断言有区分力）。

**Phase 6 · P6-1 / P6-2 已实现**（2026-09-26 阶段关闭）：`visits/:id/confirm`(I12，action 名 **`visitConfirm`**) / `visits/:id/reject`(I13，action 名 **`visitReject`**)。
- 二者均为**写**接口，要求**登录 + `X-Request-Id`**（幂等键 `${ticketId}:${actor.userId}:${requestId}`）；跨店/越权与不存在**统一 404 同形**（`VISIT_NOT_FOUND`，防存在性探测）。
- 幂等重放 → `200 + X-Idempotent-Replay`；跨 Visit 复用同号 → `409 IDEMPOTENT_VISIT_MISMATCH`；并发 loser → `409 VISIT_NOT_REVIEWABLE`（**条件 UPDATE + 影响行数**，非行锁）。
- 门禁：`scripts/verify-store-review-write.mjs`（契约 C1~C26，**58 正向 + 9 反向**：事务矩阵 / 故障回滚 / 真并发 + 幂等）。
- UI：门店后台「技师回执」区块（H3 内联）内确认/驳回，成功 / 409 后整页重拉。走查：`scripts/walkthrough-p6-2-browser.mjs`（真实 Chromium/CDP）。

**Phase 9 已实现**（2026-09-26）：`dashboard/summary`(I15，action 名 **`dashboardSummary`**) / `reports/kpi`(I16，action 名 **`reportKpi`**) / `export/tickets`(I17，action 名 **`exportTickets`**)。
- 三者都只要求**登录**（ACL 走 `loggedIn`），真正的判定在 action 层：I15 按 `scopeOf`/`applyScope` 裁范围；I16 要求 `CAPABILITY.PRIVILEGED`；I17 要求 `CAPABILITY.ADMIN`（**仅 `hq_admin`**）。
- 🔴 **I17 是本系统 ServiceTicket 批量数据的唯一受支持出口**。NocoBase 原生 `<资源>:export` 对**任何角色（含 `root`/`admin`）**都不再是导出通路 —— 能力层窄守卫见 `middleware/native-export-guard.ts` 与 `docs/DEVIATIONS.md` **DEV-91**（用户 2026-09-26 裁定 D3=闭合）。
- I17 的脱敏是**固定的**（手机号一律脱敏，**不随** `VIEW_RAW_MOBILE` 放开）；导出审计写**独立集合** `export_audits`，**只记**操作者/时刻/筛选与日期范围/条数/`requestId`，**不记**手机号与 CSV 内容。
- 超时数字**不另写谓词**：全部消费 Phase 8 的 `runSlaScan`/`SLA_SOURCE`（契约 `docs/PHASE-9.md` §2）。
- 门禁：`scripts/verify-report-kpi.mjs`（12 项 KPI + SLA 单一事实源）· `scripts/verify-native-export-bypass.mjs`（D3 七条）。

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

### 4.1 `POST /api/svc/followUp` —— 记录跟进（**下次跟进日期是三态**）

Phase 11 / P11-1。请求体：

| 字段 | 必填 | 说明 |
|---|---|---|
| `note` | ✅ | 跟进情况（≤500 字） |
| `next_follow_at` | ❌ | 下次跟进日期，**只到天**（`YYYY-MM-DD`）。**它的"有没有出现"本身有语义** —— 见下 |

🔴 **`next_follow_at` 的三态契约**（这是接口语义，不是实现细节）：

| 请求体里 | 含义 | 结果 |
|---|---|---|
| **字段不出现** | 调用方没打算动它 | **保持不变**（已有安排原样保留） |
| `null` | **明确的取消** | 清空当前待办 |
| `""` / 纯空白 | 表单那一栏是空的 | **保持不变**（⚠️ 不是清空） |
| `"2026-10-15"` | 设定 / 更新 | 写为该日期（业务时区 canonical 正午） |

⚠️ 为什么空串**不**等于清空：几乎所有表单在"没填"时都会送出空串。
若把空串当清空，那么"只是补记一条跟进、没碰日期"就会**静默抹掉**已有安排 ——
而它不报错、也不改任何审计字段，只有等到某天该跟进的没跟上才会被发现。
要取消必须**显式**送 `null`（界面就是这么做的：窗口打开时记下当时已有的日期，
用户把它清空才送 `null`）。

**副作用（同一事务）**：写当前列 + 写一条 append-only 的 `follow_up` 事件
（metadata 记 `next_follow_intent` / `next_follow_at` / `next_follow_previous`）。

**409**：`note` 为空是 422（`MISSING_NOTE`）；状态不是 `PROCESSING` 是 409。

### 4.2 `GET /api/svc/followUpQueue` —— 今日待跟进 / 已逾期（**只读**）

Phase 11 / P11-1。已登录即可调用；**数据范围由 `applyScope` 在服务端裁剪**
（不是前端过滤 —— 前端过滤只能"少显示"，不能"防越权"）。

| 查询参数 | 说明 |
|---|---|
| `limit` | 单页上限（默认 100，上限 200） |

响应：

```json
{
  "today": "2026-10-10T04:00:00.000Z",   // 业务时区（+08:00）当日的 canonical 正午
  "todayCount": 1,
  "overdueCount": 0,
  "items": [ /* 逾期在前，组内按 next_follow_at 升序 */ ]
}
```

- `today` **必须**回传：调用方据此自证"服务端用的是哪个时区"，而不是猜。
  它是 `+08:00` 的 12:00（UTC 里就是当天 04:00）。
- 只报"**确实安排了日期**（非空）且仍处于可跟进状态（`PROCESSING`）"的单。
- **不扫描、不发短信、不写任何表** —— 完整的超时与异常工作台在 P11-6
  （本项目不建第二套 SLA 扫描体系）。

⚠️ 实现侧的一条坑（已记进 PHASE-11 §P11-1-b）：判断"有值"**不能**用
`{ $ne: null }` —— 它经 NocoBase 落到 SQL 是 `!= NULL`，而 SQL 里任何与 NULL 的比较
都是 NULL，于是那条条件既不是"排除空值"也不是"全都要"，而是**恒空**。

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

> ### ✅ 已于 2026-09-26 订正（Phase 9）—— 本节口径以上表**时态批注**为准
>
> 上表是历史原文，**保留不改写**（项目铁律：历史停止线用批注而非改写）。Phase 9 逐项回代码取证后，
> **四行**与本系统实际可证的事实不一致，现行口径以 `docs/PHASE-9.md` §3 为准：
>
> | 上表原文 | 现行口径（冻结） | 为什么 |
> |---|---|---|
> | 预约逾期未回执数 = `expected_visit_at < now` 且 status=PROCESSING 且无 `submitted_at` | 取 Phase 8 `SLA_SOURCE.appointment`：Ticket ∈ `[NEW, PROCESSING, WAIT_STORE_CONFIRM]` 且**无 `CONFIRMED` Visit**，起点 `appointmentOverdueFrom(expected_visit_at, grace)` | `expected_visit_at` 的业务语义**只到天**，`12:00` 只是防跨日的技术值（**DEV-71**）；`< now` 会造出"当天 12:00 就逾期"的**伪精度**，且 `submitted_at` 在 Visit 上不在 Ticket 上。见 **DEV-94** |
> | 待门店**确认**数/时长 | 改称**「待门店处置数 / 处置时长」**，**含确认与驳回** | `store_confirmed_at` **驳回也写**（`visit-service.ts:641` 确认 / `:696` 驳回）⇒ 只叫"确认"会把驳回的 Visit 排除在口径外，与字段事实不符 |
> | 短信**送达率** = `delivery_status=delivered` / 已提交短信 | **「短信提交成功率」** = `send_status='accepted'` / `send_status ∈ (accepted, rejected, error)` | 🔴 `delivery_status` 在代码里**永为 `pending`**（`sms-service.ts:20/555/611` 写明只能由供应商回执更新，而 Phase 8 明令**不做** delivery callback；`sms-provider.ts:54` 更在类型层禁止 Provider 声称 `delivered`）⇒ **分子恒为 0**。见 **DEV-93** |
> | 闭环时长 = `closed_at - created_at`（首次进入 CLOSED） | 分子分母均**限定 `status='CLOSED'`** | ⚠️ **取消也写 `closed_at`**（`ticket-service.ts:1043`）⇒ 不限定 status 会把"取消"混进闭环时长 |
>
> 另：**判定/聚合用字段口径**（DB 字段），**展示用事件口径**（`client/timeliness.ts`）—— 两者数字可能不同，
> 属预期（契约 §4 C3），不得据此判任一侧为错。

> **不提供**"实际上门准时率/到达时间"类指标（师傅不登录，无法验证）——文档 §15 明确要求不做看似精确不可验证的 KPI。

---

## 6. NocoBase 原生接口的使用边界

| 用途 | 允许 | 说明 |
|---|---|---|
| 后台列表/详情读取 | ✅ `/api/serviceTickets:list|get`、`/api/serviceVisits:list`、`/api/ticketEvents:list`、`/api/smsLogs:list` | 受 ACL + `storeScope` 中间件约束 |
| 后台新建/修改 | ⚠️ 仅限非状态字段（如补充备注） | `status / escalated / reopen_count / *_token_hash / dispatch_at / closed_at` 等由 ACL 设为**只读** |
| 状态类变更 | ❌ 禁止直调原生 update | 必须走 `/api/svc/...` 业务 action |
| 匿名访问 | ❌ 完全禁止 | 匿名只允许 §1–§3 列出的 8 个 action |
