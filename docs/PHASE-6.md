# Phase 6 — 门店确认 / 驳回（阶段计划与契约）

> **状态：⬜ 计划态（未开工）** —— 本文是**先计划 / 再契约、后实现**的产物。
> 起点 = Phase 5 的终点 **`WAIT_STORE_CONFIRM`**（详见 `docs/PHASE-5.md` §14/§15）。
>
> **接力棒**：`Ticket.status = WAIT_STORE_CONFIRM` · `Visit.visit_status = SUBMITTED` ·
> `Visit.store_confirm_status = pending`（**派生字段**）· 师傅 Token **已消费失效**。
>
> **首个硬问题**（用户 2026-09-25 点名）：**照片读取权限** ——
> 在写"确认/驳回"按钮**之前**，先证明**门店授权用户能安全看到本工单照片**，
> 而未授权门店 / 匿名 / 跨店用户**不能靠猜 URL 或 photoId 拿到照片**。
>
> 计划方法沿用本项目已反复验证有效的节奏：
> **先计划 + 契约 → P6-0 只做 read model + 私有照片访问 → 再 P6-1 confirm/reject 事务。**

---

## 1. 目标与范围

### 1.1 交付目标

门店侧（后台 H）走完技师回执的**审核一跳**：

```
WAIT_STORE_CONFIRM ──confirm──▶ WAIT_FEEDBACK（Visit: SUBMITTED → CONFIRMED）
        │
        └────────────reject─────▶ PROCESSING   （Visit: SUBMITTED → REJECTED）
```

- 门店能**看到**技师提交的：服务结果 / 说明 / 是否收费 / 报费金额 / 照片（按类型与顺序）。
- 门店能**确认**（可修正实收金额）或**驳回**（必填原因）。
- 确认后**才**生成评价 Token、**才**发评价短信（M9）。
- 全程**不新造数据模型** —— `ServiceVisit` 已经正好把接力棒停在 `SUBMITTED`。

### 1.2 明确**不做**的事（防止范围蔓延）

- ❌ **不重新设计** `Ticket` / `ServiceVisit` / 照片模型。现有字段（`confirmed_charge_amount`、
  `store_confirm_status`、`store_confirm_note`、`store_confirmer`、`store_confirmed_at`）**已齐**，
  **不需要任何迁移**（见 §3）。
- ❌ **不把 Phase 5 的私有照片改成永久 public URL**，也不给 `uploads-private` 加 nginx alias。
- ❌ **不在 P6-0 写任何状态出边**（不写 `CONFIRMED` / `REJECTED` / `WAIT_FEEDBACK`）。
- ❌ **不在 P6-0 发评价短信**、不生成评价 Token。
- ❌ 不做评价（Phase 7）、不做自动重开（Phase 7）、不做门店确认后的多次 Visit 编排（后续阶段）。
- ❌ 不"顺手"改动 Phase 5 冻结的 `Technician H5`（阶段已冻结，见 `docs/PHASE-5.md` §14）。

---

## 2. 子阶段划分

| 子阶段 | 名称 | 一句话范围 | 硬验收 |
|---|---|---|---|
| **P6-0** | **Store Review Read Model & Photo Access Gate** | 只做**读**：门店回执读模型（I11）+ **私有照片受控读取闸门**（I14）。**不写确认/驳回状态变更。** | §5 四边界矩阵 + §6 read model 契约 |
| **P6-1** | Store Confirm / Reject Transaction | 写确认/驳回事务，落 **M9 / M10**；含并发与幂等 | §7 契约 + 并发用例 |
| P6-2 | （暂定）门店审核 UI 收口 | H 页面上按钮 + 视觉走查 + 真人复核 | 待 P6-1 后再定 |

> **为什么 P6-0 要单独拆出来**：这是**授权边界**问题，不是 UI 问题。
> 如果先做按钮、后补权限，最坏结果是"按钮做完了，但照片链路是 `知道 photoId 就能看`" ——
> 那时再改授权，等于把已交付的 UI 与验收结论一起推翻。先钉边界，再长 UI。

---

## 3. 已具备的复用件（本计划的基石 —— 全部**已存在**，无需新建/迁移）

> 这一节的用处：**证明 P6 不需要动模型**。每条都给出位置，可逐条复核。

| 复用件 | 位置 | 现状 |
|---|---|---|
| Ticket 合法迁移 `WAIT_STORE_CONFIRM → [WAIT_FEEDBACK, PROCESSING]` | `src/server/constants.ts` `ALLOWED_TRANSITIONS`（L60-72） | ✅ 已声明 |
| Visit 合法迁移 `SUBMITTED → [CONFIRMED, REJECTED]` | `src/server/constants.ts` `ALLOWED_VISIT_TRANSITIONS`（L297-313） | ✅ 已声明（**P6 的两个出边**） |
| `Visit → store_confirm_status` 派生映射（唯一事实来源） | `src/server/constants.ts` `VISIT_STATUS_TO_CONFIRM_STATUS`（L260-270）+ `visit-service.ts` `derivedConfirmStatus()`（L678-686） | ✅ 已实现 |
| 门店确认字段 | `collections/serviceVisits.ts`：`confirmed_charge_amount`(L159)、`store_confirm_status`(L166)、`store_confirm_note`(L173)、`store_confirmer`(L177)、`store_confirmed_at`(L180) | ✅ 列已存在 |
| 事件类型 `store_confirmed` / `store_rejected` | `constants.ts` `EVENT_TYPE`（L374-375 / 标签 L424-425）+ `event-service.ts` 白名单（L45-46） | ⚠️ **已登记、未接线** |
| 幂等场景 `store_confirm` | `constants.ts` `IDEMPOTENCY_SCENE.STORE_CONFIRM`（L777） | ⚠️ **已登记、未使用** |
| 门店/HQ 权限判定 | `services/permission-service.ts`：`scopeOf()`(L337-354)、`assertCanAccessTicket()`(L400-429)、`isHq()`(L268-271)、`loadStoreIds()`(L528-545) | ✅ 已实现 |
| `storeScope` 框架中间件 | `src/server/middleware/store-scope.ts`（挂载 `plugin.ts` L926-945） | ✅ 已实现（**但清单不含照片表**，见 §4.6） |
| 私有照片落盘 + 受控读取原语 | `services/photo-service.ts`：`DEFAULT_PRIVATE_DIR`(L64-65)、`read()`(L405-425，**自身不鉴权**)、`resolveInsideRoot()`(L466-473) | ✅ 已实现 |
| 照片表 | `collections/serviceVisitPhotos.ts`（`visit` FK L19-22、`storage_key` L34-38「禁止对外输出」） | ✅ 已存在 |
| 照片列表服务（**已剔除敏感列**） | `visit-service.ts` `listPhotos()`(L521-535)：主动剔除 `storage_key` 与 `upload_ip_hash` | ✅ 已实现 |
| 后台客户端统一请求器（带登录态 + 401 处理） | `src/client/index.ts` `request()`(L110-123，走 `app.apiClient.request()`) | ✅ 已实现 |
| nginx 内部动作段 | `nginx/conf.d/service.conf` `/api/svc/...`（L245-262，枚举白名单） | ✅ 已存在（**新增接口必须扩这一段**） |

---

## 4. 关键设计决策

### 4.1 ✅【已定】审核对象钉死 = **当前 `SUBMITTED` 的那条 Visit**

门店审核的是**一条具体的上门事实**（`service_visits.id`），**不是**"泛泛地改一张 Ticket"。

**为什么必须钉死**：

- `ServiceVisit` 才是"师傅上过门"这件事的载体。Phase 4 已确立：改派 = 旧 Visit 转 `SUPERSEDED`
  **原样保留** + 新建 Visit（`docs/STATE-MACHINE.md` §7.2/§7.4）—— 即"一次上门 = 一条不可篡改的行"。
- Ticket 只是**汇总结论**。M9/M10 的 From/To 虽然写在 Ticket 状态上，但**语义主体是 Visit**。
- 不钉死对象，后续并发与"陈旧页面"规则就无从谈起（§4.5）。

**推论（P6-1 的接口形状由此确定）**：
`confirm` / `reject` 的入参**必须带 Visit id**，且服务端**重读该 Visit**、断言
`visit_status = SUBMITTED` 且 `store_confirm_status = pending`，否则拒绝 ——
**不能**只凭 Ticket id + 客户端传来的状态就动手。

### 4.2 ✅【已定】照片访问方向

```
登录身份（session / Bearer）
      ↓
PermissionService.scopeOf(actor)          ← all / stores / none（fail-closed）
      ↓
assertCanAccessTicket(ticketId)            ← 越权与不存在**统一 404**（防存在性泄露）
      ↓
校验 photo.visit_id 属于该 ticket（Ticket↔Visit↔Photo 归属）
      ↓
受控读取（流式返回） 或 签发**短时**签名 URL
```

**明确否定**："知道 photoId / file id 就能看"。photoId **不是凭证**，每一次读取都必须过授权链。

### 4.3 ✅【已定】绝不把私有照片改成永久 public URL

- 现状：照片落盘在 `UPLOAD_PRIVATE_DIR=/app/nocobase/storage/uploads-private`，
  **在 nginx 文档根之外**；全仓确认**没有任何 `uploads-private` 的 nginx alias**。
- `attachments` 行 `storageId = null`、`url = null`（`photo-service.ts` L359-399）—— **故意**不挂
  local storage，所以 NocoBase 的 `/files/` 与后台附件列表**本来就取不到**照片。
- **禁止**以下任何"为了让 `<img>` 好显示"的走捷径做法：
  - ❌ 把 `uploads-private` 加进 nginx alias / 静态暴露；
  - ❌ 把 `storage_key`（形如 `visits/{visitId}/{yyyymm}/{48位hex}.{ext}`）直接拼成 URL 下发；
  - ❌ 给 `serviceVisitPhotos` 开**无字段裁剪**的原生 `list/get`（会整行下发 `storage_key`）。

### 4.4 ✅【已定】门店侧句柄 **≠** 师傅 Token 绑定的 `ref`

- 师傅侧的 `photo_ref` = `sha256(photoId + ':' + access_token_hash)` 前 22 位（`src/shared/photo-ref.ts` L33-51），
  **绑定师傅 Token 哈希**；而 Phase 5 提交后 **Token 已消费失效** ⇒ 门店**无法**、也**不该**复用这套 ref。
- 门店侧对外句柄用 **`serviceVisitPhotos.id`**（仅回传 id 与展示元数据，**不回传 `storage_key`/`file_id`**）。
- 更彻底的做法（P6-0 可选）：给门店侧引入**独立 opaque 句柄**（与师傅 ref 机制解耦）。
  无论哪种，**授权都不依赖句柄本身** —— 句柄只是"指哪张"，"能不能看"由 §4.2 的授权链裁决。

### 4.5 ✅【已定】并发与"陈旧页面"规则（P6-1，P6-0 先写进契约）

**场景**：两个门店员工**同时**打开同一张待确认工单，A 先点了"确认"，
B 的页面**还停在旧状态**，随后点了"驳回" ——

**必须**：B 的驳回**失败**，**不能**覆盖 A 的决定。

**实现口径**（与 M8/`technicianSubmit` 同范式）：

1. 事务内 `SELECT ... FOR UPDATE` 锁 Visit；
2. 断言 `visit_status = SUBMITTED` 且 `store_confirm_status = pending`；
3. 不满足 → **拒绝**（建议 `409`，具体码在 P6-1 定稿），**不改任何数据**；
4. 满足 → 写新状态 + 写 `TicketEvent` + 写幂等记录，**同一事务**提交。

> 关键：这是**乐观并发**的兜底 —— 客户端状态一律**不可信**，服务端以**重读后的行**为准。
> "前端把按钮置灰"是 UX，**不是**并发控制。

### 4.6 ⚠️【待裁决】`serviceVisitPhotos` 的隔离清单 —— 文档/代码分叉

- 侦察结论：`docs/SECURITY.md` §2.3（L58）**声称** `storeScope` 集合白名单含 `serviceVisitPhotos`；
  但 `src/server/middleware/store-scope.ts` 的 `SCOPED_RESOURCES`（L30-35）**实际没有它**，
  且 `NATIVE_READ_ALLOWLIST`（constants L1111-1116）与 `NATIVE_READ_FIELD_DENY`（L1214-1225）**也未登记**。
- **P6-0 开工第一步必须先裁决这对分叉**（二选一，并留下记录）：
  - **(a) 改代码**：把 `serviceVisitPhotos` 纳入受管清单 + 在字段拒绝名单登记
    `storage_key` / `upload_ip_hash` / `file_id`；
  - **(b) 改文档**：明确"照片**不经**原生接口，只走 I11/I14 自定义端点"，
    从而**本就不该**进 `storeScope` 白名单。
- **倾向 (b)**：照片读模型信息量大、且必须与"是否当前审核对象"联动，走自定义端点更可控；
  原生接口一旦开口，字段裁剪就是**第二道**防线，多一处可忘。**但此项需用户签字确认。**

---

## 5. 🔒 P6-0 硬验收：照片访问四边界矩阵（逐条判定）

> 与 Phase 5 的 Token 失效矩阵同风格：**每条都要有可复现断言**，
> 不区分"猜出来的"与"跑出来的"。脚本建议 `scripts/verify-store-photo-access.mjs`。

**四个边界（用户 2026-09-25 指定）**

| # | 主体 | 目标 | 期望 |
|---|---|---|---|
| **B1** | 本店授权用户（`store_after_sales`，`storeUsers` 映射含该店） | **本店** Ticket 的 SUBMITTED Visit 照片（I11 列表 + I14 流式） | **200** + 正确字节 |
| **B2** | HQ 授权用户（`hq_after_sales` / `hq_admin` / `viewer` / 平台超管） | 任意**有权限** Ticket 的照片 | **200** |
| **B3** | 其他门店用户（`store_after_sales`，映射**不含**该店） | 跨店 photo | **404**（**优先级：不泄露存在性**） |
| **B4** | 匿名 / 无登录 | 任意 photo | **401** |

**反向与枚举（同样是硬验收，不许省略）**

| # | 攻击/边界 | 期望 |
|---|---|---|
| **R1** | 伪造 / 不存在的 `photoId`（I14） | **404**，且与 B3 的**响应体逐字节相同** |
| **R2** | 畸形 `photoId`（非数字 / 超长 / 注入字符）（I14） | 404/400，**不得 500** |
| **R3** | 跨店用户**拿合法 photoId 猜 URL**（I14） | 404，**与 R1 不可区分**（防 oracle） |
| **R4** | 任意成功响应体 | **不得**出现 `storage_key` / `file_id` / `attachments` 内部路径 / 绝对路径 |
| **R5** | 签名 URL：篡改 `sig` / 过期 `exp`（I14 `?exp=&sig=`） | 401/403，**不放行** |
| **R6** | 本店用户读本店 Ticket 下**历史 Visit** 照片（如 `SUPERSEDED` / `CONFIRMED`） | **约定并断言**（建议：本店可读；**跨店一律 404**） |
| **R7** | 越权 + 存在（B3）与不存在（R1）的**响应耗时/体量** | 不做时序侧信道承诺，但**响应体与状态码必须一致** |

**判据**：四边界 + 反向全部可复现；任何一条红了，**P6-0 不通过**，
且**不得**为了让某条变绿而放宽授权（宁可从端点侧收紧）。

---

## 6. P6-0 read model 契约（I11 / I14）

> 接口编号沿用 `docs/API.md` §4 的**既有规划**（I11/I14 原文已声明，本节点亮它）。

### 6.1 `GET /api/svc/visits/:id`（I11 — 门店回执读模型）

- **授权**：§4.2 授权链（`assertCanAccessTicket` 经 `visit.ticket_id` 反查）。
- **返回**（示意，字段以 P6-0 实现为准）：
  ```
  {
    visit: { id, visit_no, visit_status, store_confirm_status,
             service_result, service_note, is_charged, reported_charge_amount,
             submitted_at },                       // ← 技师回执（Phase 5 写入）
    photos: [ { id, photo_type, mime, size, width, height, sort_order, uploaded_at,
                signed_url, signed_exp } ]         // ← signed_url 见 6.2
  }
  ```
- **不得返回**：`storage_key`、`upload_ip_hash`、`file_id`、`access_token_hash`、
  任何绝对/相对磁盘路径。
- **实现要点**：复用 `visit-service.listPhotos()`（**它已剔除敏感列**）+ 为每张签名。

### 6.2 `GET /api/svc/photos/:photoId`（I14 — 私有照片受控读取）

- **两种模式**（`docs/API.md` I14 已定义，本节点亮）：
  1. **直读**：带登录态 → 过 §4.2 授权链 → `PhotoService.read()` 流式返回。
  2. **短时签名**：`?exp=&sig=` —— 供后台 `<img src>` 使用（`<img>` **无法**带 Authorization 头）。
- **签名口径**（落地 `docs/SECURITY.md` §5 的规划态）：
  - 内容建议 `sig = HMAC_SIGN_SECRET("photo:{photoId}:{exp}")`（密钥复用 `.env` 的 `SIGN_SECRET`，**已存在**）；
  - **TTL = 10 分钟**（`docs/API.md` I14 已写死）；`exp` 到期即拒；
  - 签名 URL 是**持有即可读**的 capability（10 分钟内），**这是被接受的取舍** —— 故 TTL 越短越好，
    且**只有**过了授权链的调用方才能拿到 URL（§4.2 不过，I11 直接 404，不给签名）。
- **响应头**复用 Phase 5 的既有写法（`visit.ts` L468-485）：
  `Content-Type`（取库中 `mime`）、`X-Content-Type-Options: nosniff`、
  `Cache-Control: private, no-store`、`Content-Disposition: inline`、`ctx.withoutDataWrapping = true`。
- **错误**：不存在 / 越权**统一 404**（同 B3/R1），**不区分原因**。

### 6.3 P6-0 的"门店侧能看到照片" = 验收的一部分

P6-0 需交付一个**只读**的门店侧读视图（H 页面/详情抽屉扩展 **或** 最小只读页），
让"门店能安全看到本工单照片"**可被人眼验证**（机器断言之外的真人确认）。
**但**：P6-0 的这个视图**不放**"确认/驳回"按钮 —— 那是 P6-1。

---

## 7. P6-1 契约（I12 / I13 — confirm / reject 事务，**P6-0 不实现**）

> 先写进契约，是为了让 P6-0 的读模型**面向正确的目标状态**（避免读模型字段与写事务对不上）。

| 接口 | 动作 | 迁移 | 关键副作用 | 必填 |
|---|---|---|---|---|
| `POST /api/svc/visits/:id/confirm`（I12） | `confirm` | Ticket `WAIT_STORE_CONFIRM → WAIT_FEEDBACK`；Visit `SUBMITTED → CONFIRMED`（M9） | 写 `confirmed_*` + `completed_at`；**此时才**生成评价 Token；**此时才**发评价短信；写 `store_confirmed` + `completed` | `confirmed_charge_amount`；**当 `confirmed_charge_amount ≠ reported_charge_amount` 时 `note` 必填** |
| `POST /api/svc/visits/:id/reject`（I13） | `reject` | Ticket `WAIT_STORE_CONFIRM → PROCESSING`；Visit `SUBMITTED → REJECTED`（M10） | 写 `store_confirm_status=rejected` + 原因；**Visit 与照片全部保留**；写 `store_rejected` | `reason` 必填 |

**P6-1 必须同时满足**：

1. **审核对象** = 入参 Visit id（§4.1）。
2. **并发** = `FOR UPDATE` + 重读断言（§4.5）；陈旧页面点击 → 拒绝，不覆盖。
3. **幂等** = `IDEMPOTENCY_SCENE.STORE_CONFIRM`（已预留）+ `X-Request-Id`；
   同请求重放**不产生**第二条 Visit / 第二封评价短信。
4. **派生字段** = `store_confirm_status` **只能**经 `derivedConfirmStatus()` 由 `visit_status` 派生，
   **不得**两处各自推进（`docs/STATE-MACHINE.md` §7.5）。
5. **角色** = 门店/总部/管理员可写；`viewer` **不可写**（`docs/API.md` §4 角色矩阵）。
6. **驳回后语义** = 这条 Visit 是**终态**；后续要重新上门 = **新建 Visit**（M4/M5 同范式），
   **不是**把这条改派掉。
7. **状态机守卫** = 走 `canVisitTransition()` / `canTransition()`，越界拒绝。

---

## 8. 交付物清单（预计）

### 8.1 服务端（`nocobase/plugins/service-ticket/src`）

- `src/server/actions/svc/`（或既有 `svc` 资源）新增 `visits/:id` 读模型与 `photos/:photoId`（I11/I14）；
- 短时签名工具（新增，如 `src/shared/photo-sign.ts`），复用 `SIGN_SECRET`；
- `PhotoService` 增一个**带授权前置**的门店侧读取入口（**不**在 `PhotoService` 内部做鉴权，
  鉴权留在 action 层，保持"服务只负责取字节"的现状，见 `photo-service.ts` L405 注释）。
- （若 §4.6 裁决为 (a)）`store-scope.ts` 受管清单 + `NATIVE_READ_FIELD_DENY` 登记。

### 8.2 nginx（`nginx/conf.d/service.conf`）

- 在 `/api/svc/...` 段（L245-262）**新增** `visits/:id` / `photos/:photoId` 的 rewrite → `svc:*`。
- **不加**任何 `uploads-private` alias。

### 8.3 脚本与文档

- `scripts/verify-store-photo-access.mjs`（§5 四边界 + 反向，**真实 HTTP**）；
- `scripts/verify-store-visit-read.mjs`（I11 字段裁剪断言：**不得**含 `storage_key` 等）；
- 同步 `docs/API.md`（I11/I14 由"规划"→"已实现"）、`docs/SECURITY.md` §5（签名 URL 落地）、
  `docs/DATA-MODEL.md`（若句柄口径变化）、`docs/PHASE-0.md` §8.1 接口清单。

---

## 9. 断言与反向验证（铁律 1 / 8）

- **正例必须有反例配对**：B1/B2 的 200 必须配 B3/B4 的 404/401；
  "能读到"必须配"越权读不到"。
- **不得存在"只会变绿的断言"**：每支门禁脚本自身要能被**故意改坏**后变红（变异测试思路，
  见 `scripts/verify-technician-h5-mutation.mjs` 的范式）。
- **字段裁剪断言要"逐字段列举"**，不能用"整体看没问题"代替。

---

## 10. 前置核查

- P6-0 开工前，先跑一遍 Phase 5 冻结基线（`docs/PHASE-5.md` §14 口径），确认**无回归**再动手。
- 确认当前库内存在一张 **`WAIT_STORE_CONFIRM` + `SUBMITTED`** 的夹具单（或由脚本播种）。
- 确认 `.env` 的 `SIGN_SECRET` 就绪（密钥审计已见其存在）。

---

## 11. 风险与已知限制（如实标记，不美化）

| # | 风险/限制 | 处置 |
|---|---|---|
| 1 | 签名 URL 在 TTL 内是 capability（持有即可读） | 接受；TTL=10min；只有过授权链才发 URL |
| 2 | `serviceVisitPhotos` 未进隔离清单（文档/代码分叉） | §4.6 先裁决，二选一并留记录 |
| 3 | 后台 `<img>` 无法带 Authorization 头 | 用**短时签名 URL**（§6.2 模式 2），**不是**放宽为 public |
| 4 | `attachments` 故意不可用（`storageId/url=null`） | **保持**；门店读口走应用层新端点 |
| 5 | P6-0 不含 UI 写操作 | 刻意；避免"按钮先于授权" |

---

## 12. 交付状态表（随进度更新）

| 子阶段 | 状态 | 证据/说明 |
|---|---|---|
| 计划与契约（本文） | ✅ 已定稿（2026-09-25） | 四边界矩阵 + I11/I14 契约 |
| **P6-0** Store Review Read Model & Photo Access Gate | ⬜ 未开工 | §5/§6 为验收口径 |
| P6-1 Store Confirm / Reject Transaction | ⬜ 未开工 | §7 为契约 |
| P6-2 审核 UI 收口 | ⬜ 未定 | 待 P6-1 后 |

---

## 13. 与其它文档的关系

- 上游：`docs/PHASE-5.md` §14（关闭记录）/ §15（下一阶段）—— **`WAIT_STORE_CONFIRM` 接棒**。
- 状态机：`docs/STATE-MACHINE.md` M9 / M10 / §7.1 / §7.5。
- 接口：`docs/API.md` §4（I11 / I12 / I13 / I14）。
- 数据：`docs/DATA-MODEL.md` §4（Visit）/ §5（照片）。
- 安全：`docs/SECURITY.md` §2.3（隔离清单）/ §3（文件安全）/ §5（受控读取与签名 URL）。
- 计划：`docs/DEV-PLAN.md` §Phase 6。
