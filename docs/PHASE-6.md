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
受控读取（流式返回；**不签发任何签名 URL / 短期凭证**）
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

### 4.3a ✅【已定，用户 2026-09-25 拍板】后台取图 = `authenticated fetch → Blob`，**不做签名 URL**

后台是**登录后的内部系统**，没有必要主动创造"拿到 URL 后、在 TTL 内脱离登录身份仍可读"这个**新能力**。

```
Admin UI ──authenticated request──▶ GET /api/svc/photos/:photoId
                                       ├─ 当前登录用户
                                       ├─ PermissionService（scopeOf）
                                       ├─ storeScope / HQ
                                       └─ Photo → Visit → Ticket 归属
                                            ▼
                                        image bytes
                                            ▼
                            response.blob() → URL.createObjectURL()
                                            ▼
                                   <img src="blob:...">
                                            ▼
                             unmount / reload → URL.revokeObjectURL()
```

- **每一次服务端取图都经过当前登录身份**；浏览器里的 `blob:` 只是**内存副本**，不构成新的服务端读取权限。
- 与 Phase 5「匿名 Technician Token + photo ref」那套**彻底分离**，概念更清楚。
- **不引入 `SIGN_SECRET`**、**不实现** 10 分钟 signed URL。
- 需要给客户端请求包装器加 `responseType: 'blob'` 透传（见 §8.1）。

> 为什么这次不优先 signed URL：它适合**对象存储直出 / CDN / 大文件下载**；我们只是内部售后人员
> 看 1–6 张维修照片，规模上**没必要**为 `<img>` 的便利引入第二套授权凭证，还会带来
> TTL 窗口、secret 生命周期、canonicalization、过期处理、日志 / DevTools / 浏览器历史暴露、
> "跨店用户拿旧 URL 继续看"等一串新问题 —— 都不是 P6-0 必须解决的。
> `docs/SECURITY.md` §5 的 HMAC URL 已改标**「备选方案 / 暂不采用」**，保留设计历史。

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

### 4.6 ✅【已定，用户 2026-09-25 拍板：选 (b)】`serviceVisitPhotos` **不进**原生读取白名单

- 侦察结论：`docs/SECURITY.md` §2.3 曾**误写** `storeScope` 白名单含 `serviceVisitPhotos`；
  实际 `src/server/middleware/store-scope.ts` 的 `SCOPED_RESOURCES`（L30-35）**没有它**，
  `NATIVE_READ_ALLOWLIST`（constants L1111-1116）与 `NATIVE_READ_FIELD_DENY`（L1214-1225）**也未登记**。
- **裁决 = (b)**：`serviceVisitPhotos` **有意不属于**原生读取白名单，
  **只通过 I11 / I14 两个自定义业务端点读取**，不开放原生 collection CRUD/read。

```
serviceVisitPhotos ──「原生 API」────────▶ DENY
        │
        ├─ I11 `/api/svc/visits/:id`     → Ticket + 当前 SUBMITTED Visit + 回执字段 + photos 安全展示元数据
        └─ I14 `/api/svc/photos/:photoId`→ 登录身份 + storeScope/HQ + Photo→Visit→Ticket 归属 → 受控图像响应
```

- **理由**：该表不是"应让前端自由查询"的业务集合 —— 它含 `storage_key` 等**存储实现信息**。
  一旦进白名单，就得长期维护字段 denylist，将来新增敏感列还可能出现"代码能读、只是忘了禁字段"。
- **已同步修正** `docs/SECURITY.md` §2.3 的漂移（写成"**有意不进白名单，只走业务端点**"，而非"代码补进白名单"）。
- **新增反向机器门**（§5 · N1）：业务角色直接 `GET /api/serviceVisitPhotos:list` **必须不可读** ——
  以后谁"为了方便"把它加进 allowlist，测试**立刻变红**。

---

## 5. 🔒 P6-0 硬验收矩阵（**已冻结，不再扩** — 用户 2026-09-25）

> 与 Phase 5 的 Token 失效矩阵同风格：**每条都要有可复现断言**。脚本 `scripts/verify-store-photo-access.mjs`。
> **判据**：全部可复现；任何一条红了 **P6-0 不通过**，且**不得**为了让某条变绿而放宽授权（宁可从端点侧收紧）。

**四边界（B 组）**

| # | 场景 | 期望 |
|---|---|---|
| **B1** | 本店授权用户（`store_after_sales`，`storeUsers` 映射含该店）读取**本店**照片 | **200** `image/*` |
| **B2** | HQ 授权用户（`hq_after_sales` / `hq_admin` / `viewer` / 平台超管）读取照片 | **200** |
| **B3** | 跨店用户读取**已知合法** `photoId` | **404** |
| **B4** | 跨店用户读取**不存在**的 `photoId` | 与 B3 **不可区分**（同状态码 + 响应体逐字节相同） |
| **B5** | 匿名 / 无登录读取 | **401** |

**反向与边界（N / R / S / O / U 组）**

| # | 场景 | 期望 |
|---|---|---|
| **N1** | 业务角色直接 `GET /api/serviceVisitPhotos:list`（**原生 collection API**） | **不可读取**（403/404）—— 谁"为了方便"把它加进 allowlist，此门立刻红 |
| **R1** | 畸形 / 伪造 `photoId`（非数字 / 超长 / 注入字符） | **安全失败**（404/400，**不得 500**） |
| **R2** | 任意成功响应 / I11 read model 字段 | **不泄露** `storage_key` / `upload_ip_hash` / `file_id` / 内部或绝对路径 |
| **S1** | **登录会话失效后**重新取图 | **401** —— 页面里已有的 `blob:` 只是浏览器内存副本，**不代表**新的服务端读取权限 |
| **O1** | 本店用户读本店工单下的**历史 Visit** 照片（`SUPERSEDED` / `CONFIRMED` 等） | **可读**（200）；**但**不得因此获得**其他门店**任何 Visit 的照片（越店仍 404） |
| **U1** | 门店只读 UI | 能**真实显示**当前审核 Visit 的 1–6 张照片（人眼验证，见 §6.3） |

> **已删除**原计划里的 R5「签名篡改 / 过期」—— **不实现签名机制**（§4.3a），
> 不为测试一个不存在的机制而实现机制；其价值由 **S1** 取代。

---

## 6. P6-0 read model 契约（I11 / I14）

> 接口编号沿用 `docs/API.md` §4 的**既有规划**（I11/I14 原文已声明，本节点亮它）。

### 6.1 `GET /api/svc/visits/:id`（I11 — 门店回执读模型）

- **对外路径** `GET /api/svc/visits/:id`；nginx rewrite → `/api/svc:visitDetail?filterByTk=:id`
  （⚠️ **不能**复用 action 名 `visits` —— 它已被"按 ticketId 列派工历史"占用，见 §8）。
- **授权**：§4.2 授权链（`assertCanAccessTicket` 经 `visit.ticket_id` 反查）。
- **返回**（示意，字段以 P6-0 实现为准）：
  ```
  {
    visit: { id, visit_no, visit_status, store_confirm_status,
             service_result, service_note, is_charged, reported_charge_amount,
             submitted_at, technician_name },      // ← 技师回执（Phase 5 写入）
    photos: [ { id, photo_type, mime, size, width, height, sort_order, uploaded_at } ]
                                                   // ← 只有安全展示元数据；取图另走 6.2
  }
  ```
- **不得返回**：`storage_key`、`upload_ip_hash`、`file_id`、`access_token_hash`、`token_*`、
  任何绝对/相对磁盘路径。
- **实现要点**：复用 `visit-service.listPhotos()`（**它已剔除 `storage_key` 与 `upload_ip_hash`**）；
  再**显式白名单一次字段**（"逐字段列举"，不用"整体看没问题"代替）。

### 6.2 `GET /api/svc/photos/:photoId`（I14 — 私有照片受控读取，**无签名 URL**）

- **对外路径** `GET /api/svc/photos/:photoId`；nginx rewrite → `/api/svc:photo?filterByTk=:photoId`。
- **唯一模式**：带**登录态** → 过 §4.2 授权链 → `PhotoService.read()` 取 `absPath` → 流式返回。
  **没有**"签名 URL / 短期凭证"模式（§4.3a）。
- **授权链（固定顺序）**：
  1. 登录身份（未登录 → **401**）；
  2. `permissions.resolveActor(ctx)` → `scopeOf(actor)`（HQ/超管 = `all`；门店 = `stores`；否则 `none`，fail-closed）；
  3. `photoId → visit_id → ticket_id`（`findPhotoById` → `findById`），任一环缺失 → **404**；
  4. `permissions.assertCanAccessTicket(actor, ticketId)` —— 越权与不存在**统一 404**；
  5. `PhotoService.read(photoId)`；行在但文件缺失 → **404**（不是 500）。
- **响应头**复用 Phase 5 既有写法（`technician/visit.ts` L468-485）：
  `Content-Type`（取库中 `mime`）、`X-Content-Type-Options: nosniff`、
  `Cache-Control: private, no-store`、`Content-Disposition: inline`、`ctx.withoutDataWrapping = true`。
- **错误**：不存在 / 越权 / 畸形 id **统一 404 `PHOTO_NOT_FOUND`**，**不区分原因**（防 oracle）。

### 6.3 P6-0 的"门店侧能看到照片" = 验收的一部分（**已定：包含最小只读视图，不挪 P6-2**）

P6-0 的命题**不是**"后端权限函数看起来正确"，而是
**"门店真的能够安全看到自己即将审核的技师回执和照片"**。所以交付一个**很薄的 read-only UI**：

- **复用现有 H3（工单详情只读抽屉）体系**，不新建完整审核工作台；
- **只呈现**：技师 / 服务结果 / 处理说明 / 是否收费 / 技师报费金额 / 服务照片 / 提交时间，
  外加必要的 **Visit 标识** 与 **"待门店确认"** 中文状态；
- **没有**确认按钮、**没有**驳回按钮、**没有**金额修改输入框（那是 P6-1）；
- 照片渲染走 `authenticated fetch → Blob → objectURL`（§4.3a）；
- 最终做一次**真正的人眼验证**：门店打开 `WAIT_STORE_CONFIRM` 工单 → 看得到本次技师提交结果和照片 → 照片正常显示。

**落点裁定（P6-0 实现，2026-09-25）：内联进 H3 抽屉，不新建动作。**
在「当前服务」与「处理记录」之间插一个「技师回执」区块，随抽屉一起取数（I11 + 每张 I14）。
理由：自定义动作必须经 `scripts/ticket-page-actions.mjs` → `flowModels` 落库
（`seed-admin-pages.mjs`）才会出现，而**一个新按钮会对所有角色、所有工单状态可见** ——
那等于替 P6-1 的授权面提前开一个口子，也与 §8.1 交付物清单不符。
⚠️ 区块内**只读**：没有确认/驳回按钮、没有金额输入（§1.2 的硬边界）。

> P6-2 负责的是审核 UI 的**完整 UX 收口**，而**不是**"第一次证明照片能显示"。
> ⚠️ **P6-1 未动之前，确认/驳回继续保持未实现** —— 尤其不要"为了测试页面方便顺手挂按钮"。

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

- 新增工厂 `src/server/actions/svc/visit-review.ts` → `createVisitReviewHandlers(deps)`，含两个 action：
  - **`visitDetail`**（I11 读模型）—— 对外 `/api/svc/visits/:id`；
  - **`photo`**（I14 受控读取）—— 对外 `/api/svc/photos/:photoId`。
- ⚠️ **action 名 `visits` 已被占用**（`/api/svc:visits?filterByTk=<ticketId>` = 按工单列派工历史，Phase 4）——
  故读模型用新名 **`visitDetail`**；对外路径仍按 `docs/API.md` I11 写 `/api/svc/visits/:id`（由 nginx 映射）。
- **接线三处**（缺一即启动失败）：`constants.ts` 的 `SVC_ACTION` 加两个新名
  + `AUTHENTICATED_SVC_ACTIONS` 加进数组 + `plugin.ts` 的 `handlerSets` 纳入新工厂。
- `PhotoService` 保持"**只负责取字节、内部不鉴权**"（`photo-service.ts` L405 注释）—— 鉴权留在 action 层。
- **不做** `src/shared/photo-sign.ts`（**无签名机制**，§4.3a）。
- **不动** `store-scope.ts` 受管清单、**不动** `NATIVE_READ_*`（§4.6 选 (b)）。
  ✅ 实际施工仍然成立：`SCOPED_RESOURCES` 与 `NATIVE_READ_ALLOWLIST` 一行未改。
- ⚠️ **实际施工多出一处 —— N1 抓到的既有缺陷，必须在本阶段落闸**：
  `middleware/store-scope.ts` 新增 **`NATIVE_FORBIDDEN_RESOURCES` 整资源封禁**
  （`serviceVisitPhotos` 的**任何**原生 action → `403 NATIVE_RESOURCE_FORBIDDEN`，优先于"非受管资源放行"分支）；
  `plugin.ts` 另加两条**启动断言**（同资源不得同时白名单+封禁；`serviceVisitPhotos` 必须在封禁表里）。
  为什么"不在白名单里 ⇒ 不可读"**不成立**：见 `docs/DEVIATIONS.md` **DEV-83**（NocoBase ACL 的资源级缺失会回退到角色 strategy，
  而该 strategy 忽略资源名 ⇒ 缺省是**放行**）。
- ⚠️ 另修一处**可观测性**缺陷：`actions/svc/_http.ts` 的 5xx 分支原先只打 `error.stack`，
  而 sequelize 的 `formatError` 会用**空 Error 的 stack** 覆盖真实 stack ⇒ DB 报错正文丢失
  （这也是 N1 排查时"日志里看不到 PG 原文"的原因）。改为优先输出 `error.message` / `error.parent.message`。

### 8.2 nginx（`nginx/conf.d/service.conf`）

- 在 `/api/svc/...` 段（L245-262）**新增** `visits/:id` / `photos/:photoId` 的 rewrite → `svc:*`。
- **不加**任何 `uploads-private` alias。

### 8.3 脚本与文档

- `scripts/verify-store-photo-access.mjs`（§5 **全部** B / N / R / S / O 组，**真实 HTTP** + 角色矩阵；
  `--reverse` 9 条反向断言；另含 **U1** 的"可否渲染"前置断言与源码卫生检查）；
- `scripts/uat-preflight.mjs` §3.7 追加**第 ③ 层判据**：抽屉里若出现「技师回执」区块，
  其照片必须**真的解码成功**（DOM 里出现 `blob:` 且 `naturalWidth>0`）。
  顺带修掉该段网络采集的**假红**：原先只匹配 `svc:` 冒号式，而 P6-0 的 I11/I14 是
  `svc/visits/:id` / `svc/photos/:id` **斜杠式** ⇒ 采集不到、误报"没发出请求"（nginx 日志实测两者都 200）。
- `scripts/verify-client-logic.mjs` 追加 `submittedVisitOf` 与「技师回执」渲染的离线契约（50 → **53** 项）；
- `scripts/smoke-test.mjs` 追加**第三条窄成对豁免**（S1 会话失效遗留的 error 级日志）+ **分类器自检**（117 → **118** 项）；
- `scripts/verify-detail-gate-reverse.mjs` 修掉"还原后必红"的假红（原先数的是**注释里**的 `/api/svc:` 字样，
  而 esbuild **保留注释** ⇒ 恒 ≥2；改为按**代码形态**匹配 `timelineUrl = \`svc:timeline?...\`` 正/负对照）；
- 同步 `docs/API.md`（I11/I14 由"规划"→"已实现"；**I14 去掉签名模式**）、
  `docs/SECURITY.md` §2.3（漂移已修正）/ §5（签名 URL 改"**备选 / 暂不采用**"）、
  `docs/PHASE-0.md` §8.1 接口清单、`docs/BACKLOG.md`（B-8~B-11）、`docs/DEVIATIONS.md`（DEV-83）。
- 客户端 `src/client/index.ts` 的 `request()` 增加 `responseType` 透传（§4.3a）。
- **客户端交付物**（§6.3 的"最小只读视图"，落点在 H3 内联）：
  - 新增 `src/client/ticket-store-review.tsx` —— `StoreReviewSection`（技师回执）+ `PhotoThumb`
    （`authenticated fetch → Blob → objectURL`，卸载/重载时 `revokeObjectURL`）；
  - `src/client/ticket-display.ts` 新增 `submittedVisitOf()` —— 审核对象按**状态**取当前 `SUBMITTED` 的那条 Visit，
    **不是** `visit_no` 最大的一条（改派会留下 `SUPERSEDED` 历史行）；
  - `src/client/ticket-drawer.tsx` 把区块内联进 H3，`Requester` 类型加 `responseType` 可选参数；
  - `src/client/ticket-actions.tsx` **不**新增任何动作（保持"P6-0 不含写操作"）。

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
| 1 | 后台 `<img>` 无法带 Authorization 头 | 用 `authenticated fetch → Blob → objectURL`（§4.3a）—— **不**引入签名 URL、**不**放宽为 public |
| 2 | `serviceVisitPhotos` 是否进隔离清单 | **已裁决 (b)**：**不进**；只走 I11/I14（§4.6），并已修正 `SECURITY.md` §2.3 |
| 3 | `attachments` 故意不可用（`storageId/url=null`） | **保持**；门店读口走应用层新端点 |
| 4 | 取图需整张进内存后转 Blob（1–6 张、≤5MB/张） | 规模可接受；`blob:` 由前端在 unmount/reload 时 `revokeObjectURL` 释放 |
| 5 | P6-0 不含 UI 写操作 | 刻意；避免"按钮先于授权" |

---

## 12. 交付状态表（随进度更新）

| 子阶段 | 状态 | 证据/说明 |
|---|---|---|
| 计划与契约（本文） | ✅ 已定稿（2026-09-25） | §5 验收矩阵 + §6 I11/I14 契约 |
| **三项决策锁定**（用户 2026-09-25 拍板） | ✅ 已落文档 | ① 照片表**不进**原生白名单（只走 I11/I14）② P6-0 **含**最小只读视图 ③ **不做**签名 URL，改 `authenticated fetch → Blob` |
| **P6-0** Store Review Read Model & Photo Access Gate | 🟢 **机器门全绿**（2026-09-25）<br>⏳ **关闭待用户裁定** | 证据入口 → **`docs/PHASE-6-P6-0-EVIDENCE.md`**。§5 矩阵 B1~B5 / N1 / R1 / R2 / S1 / O1 **正向 24/24 + 反向 9/9**；真实浏览器闸门 §3.7 第 ③ 层「照片真的解码」**绿**；smoke **118/118** |
| **P6-0 · U1 人眼项**（门店只读 UI 看得到照片） | ⏳ **待用户走查确认** | 明确**不是**机器门：`uat-preflight` §3.7 已给出同路径的真实浏览器证据（`照片 1/1 张已解码（I11 200 / I14 1 次）`），但 §5 的 U1 原文要求**人眼**确认 —— 由用户拍板。走查清单见 `docs/PHASE-6-P6-0-EVIDENCE.md` §④ |
| P6-1 Store Confirm / Reject Transaction | ⬜ 未开工 | §7 为契约；**P6-0 关闭前不动**（P6-0 机器门已绿，可待裁定后开工） |
| P6-2 审核 UI 收口 | ⬜ 未定 | 待 P6-1 后 |

### 12.1 本轮机器门计数（2026-09-25 复跑，全部退出码 0）

| 门禁 | 结果 |
|---|---|
| `verify-config` | **56** 项 |
| `verify-plugin-load` | **61** 项 |
| `verify-ticket-actions` | **10** 项 |
| `verify-technician-h5-selftest` | **15** 条（fixture） |
| `verify-technician-h5` | **35** 项（含 fixture 自检 15） |
| `verify-technician-routing` / `-reverse` | **11** 项 / **8/8** 反例 |
| `verify-technician-upload` | **20** 项 |
| `verify-technician-submit` | **19** 项（含 R1 事务回滚反向） |
| `verify-technician-token-matrix` | **12** 项 |
| `verify-phase3-h5` | **35** 项 |
| `verify-technician-h5-mutation` | **8/8** 被抓住 |
| `verify-reassign-contract` | **11** 项 |
| `verify-delivery-gate-reverse` | ✅ |
| `verify-detail-gate-reverse` | ✅ 反向成立 |
| `verify-client-logic` | **53** 项 |
| `verify-store-photo-access` | **24/24** 正向 · **9/9** 反向 |
| `smoke-test` | **118** 项 |
| `verify-bundle-delivery` | ✅ |
| `uat-preflight` | 🟡 20 项就绪 · §3.7/§3.8 **全绿** |

> ⚠️ 两个**必须知道**的工具链约束（不照做会出现"看起来像回归"的假红）：
> ① 反向脚本（`verify-detail-gate-reverse` / `verify-technician-h5-mutation`）会**重建产物**，
>    而多脚本串跑时构建会被沙箱的批量删除守卫拦下 ⇒ **必须各自单独一条命令跑**，
>    跑完再 `build-plugin.mjs` + `docker compose restart app`（见 `docs/BACKLOG.md` **B-9**）。
> ② `verify-store-photo-access` 的 **S1** 会留下 2 条 error 级日志（框架对"会话过期"的记录），
>    `smoke-test` 已加**窄成对豁免**（见 `docs/BACKLOG.md` **B-11**）。

---

## 13. 与其它文档的关系

- 上游：`docs/PHASE-5.md` §14（关闭记录）/ §15（下一阶段）—— **`WAIT_STORE_CONFIRM` 接棒**。
- 状态机：`docs/STATE-MACHINE.md` M9 / M10 / §7.1 / §7.5。
- 接口：`docs/API.md` §4（I11 / I12 / I13 / I14）。
- 数据：`docs/DATA-MODEL.md` §4（Visit）/ §5（照片）。
- 安全：`docs/SECURITY.md` §2.3（隔离清单）/ §3（文件安全）/ §5（受控读取与签名 URL）。
- 计划：`docs/DEV-PLAN.md` §Phase 6。
