# Phase 5 — 师傅 H5（阶段计划）

> **状态**：🟡 **进行中**（2026-09-23 启动）。
> **前置**：✅ 已满足 —— Phase 4 整体 PASS（用户 2026-09-23 裁定「Phase 4-I：PASS / Phase 4：🟢 PASS」
> ⇒ 阶段关闭）。Phase 4 的 H（后台页面）与 I（真人走查）均已关闭，阻塞项清零。
> **本阶段产出的是"师傅拿着短信链接，在手机浏览器里完成一次上门回执"的完整闭环。**

---

## 1. 目标与范围

### 1.1 交付目标（`docs/DEV-PLAN.md` §Phase 5 原文口径）

| # | 交付物 | 说明 |
|---|---|---|
| 1 | `/technician/visit/:token` 页面 | 师傅端 H5，**匿名**（Token 即凭证，不登录） |
| 2 | `GET /api/technician/visits/:token` | 拉取作业单（**最小必要信息**） |
| 3 | `POST /api/technician/visits/:token/files` | 现场照片上传 |
| 4 | `POST /api/technician/visits/:token/submit` | 提交回执（含收费校验） |
| 5 | 状态副作用 | 提交后 → `WAIT_STORE_CONFIRM`，**不发评价短信** |

**验收条目**：AT-16 ~ AT-19 / AT-22（见 `docs/PHASE-0.md` §验收条目）。

### 1.2 明确**不做**的事（防止范围蔓延）

- ❌ **不做师傅登录/账号体系** —— 师傅永远匿名，Token 是唯一凭证（`docs/SECURITY.md`）。
- ❌ **不做门店确认/驳回** —— 那是 Phase 6（M9/M10）。本阶段只把状态推到 `WAIT_STORE_CONFIRM` 就停。
- ❌ **不发评价短信** —— `WAIT_FEEDBACK` 与评价邀约是 Phase 5 之后（M9 确认时才发）。
- ❌ **不做 SLA 计时/看板** —— 留 Phase 9。
- ❌ **不做照片的「多张合并/压缩包下载」** —— 受控读取单张即可。
- ❌ **不引入 vue-router** —— 只有当 H5 路由数 ≥5 或出现嵌套/守卫需求时才换（`h5/src/router.ts` 顶部已写）。
  本阶段只加 1 条路由（师傅页），现有 60 行路由器够用。

---

## 2. 已具备的复用件（本计划的基石）

> 结论：**Phase 5 的服务端主体能力在 Phase 4 已建好**，本阶段主要是"接出来 + 页面 + 照片管线 + 断言"。

| 复用件 | 位置 | 对本阶段的意义 |
|---|---|---|
| **TokenService** | `server/services/token-service.ts` | **签发/校验/吊销三件事全已实现**。`verify()` 已按序拒绝 `EXPIRED`/`ALREADY_USED`/`REVOKED`/`VISIT_NOT_ACTIVE`/`TICKET_NOT_ACTIVE`，**对外统一 `TOKEN_INVALID`** —— 这正是 §5 硬验收矩阵要判定的行为 |
| `TokenService.mint()` / `revoke()` / `reissue()` | 同上 | 改派吊销与改约换发已在 Phase 4 落地；本阶段**不需要改** |
| **VisitService** | `server/services/visit-service.ts` | 已有 `create` / `supersede` / `cancelActive` / `reschedule` / `findById` / `latestByTicket` / `findActiveByTicket` / `listByTicket` / `countByTicket`。**缺"提交回执"与"照片挂载"两个方法**（本阶段新增） |
| **Visit 表已预留回执字段** | `server/collections/serviceVisits.ts` | `service_result` / `service_note` / `is_charged` / `reported_charge_amount` / `confirmed_charge_amount` / `submitted_at` **全部已存在**（Phase 4 建表时预留）⇒ **本阶段无需迁移** |
| **serviceVisitPhotos 表** | `server/collections/serviceVisitPhotos.ts` | 字段齐备：`visit_id` / `photo_type` / `file_id` / `storage_key` / `mime` / `size` / `width` / `height` / `sort_order` / `uploaded_at` / `upload_ip_hash` |
| **照片类型枚举** | `server/collections/_options.ts` `PHOTO_TYPE_OPTIONS` | `onsite` / `completed` / `receipt` / `other` —— 与 `docs/API.md` §2.2 一致 |
| **服务结果枚举** | `SERVICE_RESULT_OPTIONS` | `resolved` / `need_followup` / `unresolved` / `customer_absent` / `other` |
| **照片上限设置** | `constants.ts` `visit.photo_max_count`(默认 6) / `visit.photo_max_size_mb`(默认 5) | 已进设置种子，**只增不改**；`GET` 响应要回这两个值供页面提示 |
| **状态机** | `constants.ts` `ALLOWED_TRANSITIONS` | `PROCESSING → WAIT_STORE_CONFIRM`（M8）**已经合法**，无需改表 |
| **权限/动作包装模式** | `server/actions/svc/_request.ts` `createWrapper` / `requireRequestId` / `replay` | **内部**动作的鉴权/幂等骨架。匿名接口**不能照抄**（见 §4.3） |
| **匿名动作模式** | `server/actions/public/ticket.ts` | 匿名接口的**守卫顺序范式**（频控→幂等→业务），Phase 5 要遵循同一思路 |
| **HTTP 工具** | `server/actions/svc/_http.ts` `ok` / `fail` / `traceId` | 响应封装复用 |
| **H5 骨架** | `h5/src/router.ts` / `api/http.ts` / `api/public.ts` | 极简路由 + `request()` 封装 + `ApiError`；师傅页按同一范式写 |
| **nginx 路由** | `nginx/conf.d/service.conf` | `/api/technician/` **已存在**（`svc_upload` 限流 + 8m body + 120s 超时）；`/h5/` 已服务 |

### 2.1 ⚠️ 复用件里的两个**已发现的坑**（必须在开工第一步处理）

**坑 A —— `/api/technician/` 是裸 `proxy_pass`，没有 rewrite（DEV-18 同型陷阱）**

nginx 现状：

```nginx
location ^~ /api/technician/ {
    limit_req zone=svc_upload burst=20 nodelay;
    proxy_pass http://svc_app;      # ← 没有 rewrite
    ...
}
```

而 NocoBase 的 URL 形态是 `/api/<resource>:<action>`。`/api/technician/visits/xxx` 会被
`parseRequest` 解析成 resourceName=`technician` / 后续段当 index → `getResource('technician')`
抛错 → **404**，且 `resourcerMiddleware` 是 `catch { console.log; return next() }` ——
**打一行 console 日志就放行**，于是现象是"404 + 日志里一条看起来毫不相干的
`technician resource does not exist`"（与 DEV-18 记录的现象**一字不差**）。

⇒ **本阶段第一个 nginx 改动**：按 `/api/public/` 的既有范式，为三个师傅接口加
**显式 rewrite**（显式枚举，不用通配 —— 理由见该段注释：通配会把拼错的路径也转给应用，
与"接口不存在"撞在同一个 404 上）。

**坑 B —— 短链 `/t/{token}` 目前**完全不存在**路由**

`TokenService.linkOf()` 产出的是 `{PUBLIC_BASE_URL}/t/{token}`（`LINK_PATH = '/t/'`），
但 H5 挂在 `/h5/`（`vite.config.ts` 的 `base: '/h5/'`），nginx 里**没有任何 `/t/` 的 location**。

⇒ 需要在 §4.1 做一次**口径裁定**（保留短链 302 过去，还是改 `LINK_PATH`）。

**坑 C（附带）—— `PUBLIC_BASE_URL` 缺省端口**

`.env.example` 的 `PUBLIC_BASE_URL=http://localhost`，而本机 nginx 在 **8080**。
⇒ 本地自测时作业链接会指向 `:80`（被 CRMEB 占用）。**这是环境配置问题，不是代码缺陷**，
但会让"点短信链接"这条人工走查在本地直接失败。要在 §9 前置核查里显式检查。

---

## 3. 交付物清单

### 3.1 服务端（`nocobase/plugins/service-ticket/src`）

| # | 文件 | 内容 |
|---|---|---|
| S1 | `server/actions/technician/visit.ts`（新） | 三个匿名 action：`get` / `uploadFile` / `submit` |
| S2 | `server/actions/technician/_auth.ts`（新） | **Token 认证中间层**：`verify()` → 失败一律 `401 TOKEN_INVALID`；成功把 `visit` 挂到 ctx |
| S3 | `server/services/file-service.ts`（新） | 照片管线：magic bytes 嗅探 → `sharp` 重编码（长边 ≤1600 / q 0.82 / **剥 EXIF**）→ 私有存储落盘 → 建附件记录 + `serviceVisitPhotos` |
| S4 | `server/services/visit-service.ts`（改） | 新增 `submitReceipt()`（校验收费口径 + 写回执字段 + 状态迁移 M8 + Token 用后即焚 + 写事件）与 `attachPhoto()`（数量/大小校验 + 落库） |
| S5 | `server/services/photo-signature.ts`（新，或并入 file-service） | 短时签名 URL：`sig = HMAC(photoId\|exp\|SIGN_SECRET)`，**10 分钟**有效 |
| S6 | `server/actions/technician/photo.ts`（新） | 受控读取端点（登录态 + 门店范围，或短时签名） |
| S7 | `server/plugin.ts` / `server/index.ts`（改） | 注册新 action 与 service |
| S8 | `server/constants.ts`（改） | 新增常量：`TECHNICIAN_API` 路径段、`PHOTO_ALLOWED_MIME`、签名有效期等。**设置种子只增不改** |

> ⚠️ **不新增数据表、不写迁移** —— Visit 与 Photos 的字段 Phase 4 已建齐（§2）。
> 若实现中发现确实缺列，必须**新增迁移**而不是手改库，并在 `docs/DATA-MODEL.md` 同步。

### 3.2 H5（`h5/src`）

| # | 文件 | 内容 |
|---|---|---|
| H1 | `pages/Technician/Visit.vue`（新） | 师傅作业主页面 |
| H2 | `pages/Technician/TokenInvalid.vue`（新） | Token 失效统一落地页（**只说"链接无效或已失效"，不给原因**） |
| H3 | `api/technician.ts`（新） | `fetchVisit` / `uploadPhoto` / `submitReceipt` |
| H4 | `router.ts`（改） | 加 `/technician/visit/:token` 一条路由（含 `:token` 段解析） |
| H5 | `styles/base.css`（改） | 师傅端样式（**大按钮、大字号、单手可达** —— 现场作业场景） |

**页面必须处理的四个状态**（缺一个就会出现"白屏/卡死"）：

`loading` → `ready` → `submitting` → `submitted`；另有独立的 `invalid`（Token 失效）分支。
`invalid` 必须**与 `ready` 互斥**，不能"先渲染表单再被 401 打回"。

### 3.3 nginx（`nginx/conf.d/service.conf`）

| # | 改动 | 理由 |
|---|---|---|
| N1 | 为三个师傅接口加**显式 rewrite** | §2.1 坑 A（DEV-18 同型） |
| N2 | 新增 `/t/` 短链 location → 302 到 `/h5/technician/visit/{token}` | §2.1 坑 B / §4.1 裁定 |
| N3 | 确认 `/api/technician/` 的 `limit_req` 分区与 `svc_upload` 配额合理 | 上传与拉取共用 `svc_upload`（burst=20）—— 见 §10 风险 |

### 3.4 脚本与文档

| # | 文件 | 内容 |
|---|---|---|
| V1 | `scripts/verify-technician-token-matrix.mjs`（新） | **§5 硬验收矩阵 6 条**，HTTP 层取证 + `--reverse` |
| V2 | `scripts/verify-technician-photos.mjs`（新） | 照片链路：类型白名单、超限拒绝、EXIF 剥离、私有目录不可直读、签名 URL 过期 |
| V3 | `scripts/verify-technician-submit.mjs`（新） | 收费校验矩阵 + M8 迁移 + **不发评价短信**（查 mock 发件箱**没有**该条） |
| V4 | `scripts/smoke-test.mjs`（改） | 新增 "§4f 师傅接口" 组，并纳入 `verify-all` |
| V5 | `scripts/uat-preflight.mjs`（改） | 新增前置闸门（§9） |
| V6 | `scripts/uat-reset-baseline.mjs`（改，谨慎） | 复位口径要覆盖 Visit 回执与照片；**顺序不可反** |
| V7 | `docs/API.md` / `docs/PHASE-5.md`（本文件） / `CHANGELOG.md` | 契约与阶段记录 |

---

## 4. 关键设计决策

### 4.1 【待裁定】短链口径：`/t/{token}` vs `/h5/technician/visit/{token}`

现状矛盾：`TokenService.LINK_PATH = '/t/'`（已在 Phase 4 定稿，且**短信文案与验收都指向它**），
但 H5 的实际路径是 `/h5/technician/visit/:token`。

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | **保留 `/t/{token}` 作为对外短链**，nginx `302` 到 `/h5/technician/visit/{token}` | ① 短信链接**短**（短信长度按条计费，且短链不易被误断行）；② **短信契约与 H5 部署路径解耦** —— 将来把 H5 从 `/h5/` 挪到根路径，短信链接**不用改**；③ Phase 4 已定稿，改这里等于改已验收的产物 | 多一跳 302（可忽略）；需新增一条 nginx 规则 |
| B | 把 `LINK_PATH` 改成 `/h5/technician/visit/` | nginx 不用加规则 | ① 短信链接变长；② **把"部署路径"烙进"短信契约"** —— 挪站点就断链；③ 改动了 Phase 4 已冻结的常量 |

**推荐 A**，理由：`/t/` 是一条**稳定的对外契约**，`/h5/...` 是**内部实现路径** ——
两者本就该解耦（这是"单一事实来源"思路在 URL 层的延伸）。落地写法：

```nginx
# 短链 → H5 师傅页；只接受严格 43 位 base64url（与 TECHNICIAN_TOKEN.PATTERN 一致）
# 用显式正则 location（能捕获 token），非法长度直接不匹配 → 落到 location / 由应用处理
location ~ ^/t/(?<svc_token>[A-Za-z0-9_-]{43})$ {
    return 302 /h5/technician/visit/$svc_token;
}
```

> ⚠️ 若裁定选 A，必须在 `docs/API.md` §2 与 `docs/SECURITY.md` 同步"对外短链"的说明，
> 并在 `token-service.ts` 注释里点明"`/t/` 是对外契约、由 nginx 302 到 H5"。

### 4.2 【已定】Token 失效一律 `401 TOKEN_INVALID`

`TokenService.verify()` 已经实现了"内部区分原因、对外统一 `TOKEN_INVALID`"。
Phase 5 只需把它**接到 HTTP 层**：

- 格式非法（`MALFORMED`，**零成本、不查库**）→ `401`
- 查不到 / 过期 / 已用 / 被吊销 / Visit 非 `ASSIGNED` / 工单非进行中 → **一律 `401 TOKEN_INVALID`**
- 响应体**不得**含 `reason` 字段；`reason` 只进日志（`TokenService` 已这么做）

**为什么 `401` 而 Phase 4 的 `tokenCheck` 是 `200 + {valid:false}`**：那是**诊断探针**
（总部特权，语义是"**询问**这个 Token 有效吗" —— 查询本身成功了，结论在 body 里）；
本阶段是**真正的认证接口**（Token 就是访问该资源的凭证，失效 = 未被认证）。
两者形态不同、语义一致 —— 见 `docs/DEVIATIONS.md` **DEV-45** 与 `docs/API.md` §2 顶部提示。

⚠️ **不要把 `reason` 泄漏到客户端**，包括：
错误提示文案、`X-...` 响应头、以及**响应时间差异**（`verify()` 已刻意做到"不存在时不做第二次查询"）。
前端页面也**只显示一句统一的"链接无效或已失效"**，不区分原因。

### 4.3 【已定】匿名接口的守卫顺序（照 `public/ticket.ts` 的范式，但不照抄实现）

```
① Token 格式校验（零成本，不查库）
② Token 认证（verify）        → 失败 401 TOKEN_INVALID   ← 先认证
③ 频控（按 IP，消费式）        → 超限 429                ← 再削峰
④ 业务校验（数量/大小/枚举…）   → 422
⑤ 业务写入
```

**顺序理由**（两条都不可换）：

- **② 必须在 ③ 之前**：否则"随便乱打 Token"也能消耗配额，把真师傅挡在门外（拒绝服务）。
  反过来说，认证失败的请求**不该**扣业务配额 —— 但**要**计入更外层的 nginx `limit_req`
  （防扫描）。这是"应用层配额"与"nginx 层限流"的分工，别混为一谈。
- **③ 必须在 ⑤ 之前**：匿名写接口必须先削峰再落库。

⚠️ **不能照抄 `svc` 那套**：`createWrapper` 依赖 `PermissionService.resolveActor`（要登录态），
匿名接口**没有用户**。且 `requireRequestId` 要求显式 `X-Request-Id` —— 师傅端页面
**也应当带**（`crypto.randomUUID()`，与 H5 报修页同一套 `uuid.ts`），使"弱网重试不重复提交"成立。

### 4.4 【已定】`submit` 的幂等与"用后即焚"

- **幂等**：与 H5 报修同思路 —— 前端 single-flight + 相同请求复用同一 `X-Request-Id`；
  服务端在事务内校验 `token_used_at IS NULL`，置位与状态迁移**同一事务**。
  并发重复提交由 `token_used_at` 的**条件更新**兜底（`UPDATE ... WHERE token_used_at IS NULL`，看影响行数）。
- **用后即焚**：提交成功后 `token_used_at = now()` ⇒ 同一 Token 二次提交必然 `401`
  （这正是 §5 矩阵第 5 条要验的）。
- **状态迁移**：`PROCESSING → WAIT_STORE_CONFIRM`（M8），走 `ALLOWED_TRANSITIONS` 校验，
  **不得**绕过状态机直接改 `status`。
- **不发评价短信**：本阶段**不调用** `SmsService` 的任何评价邀约场景。断言要**反向查** ——
  mock 发件箱里**没有** `review_invite` 类条目（只是"没报错"不算验过）。

### 4.5 【已定】收费口径（`docs/API.md` §2.3）

```
is_charged = true  → reported_charge_amount 必须 > 0
is_charged = false → reported_charge_amount 必须 = 0
service_note       → 1~1000 字必填
service_result     → ∈ SERVICE_RESULT_OPTIONS
```

⚠️ 金额用 `money` 类型（DB 层已定），**服务端不接受浮点精度不一致的写法**；
校验要在**服务端**做，前端校验只是体验（**前端校验不是校验**）。

---

## 5. 🔒 硬验收：Token 失效矩阵（逐条判定）

> **必须在 HTTP 层取证，不得用单测替代。** 脚本：`scripts/verify-technician-token-matrix.mjs`。

| # | 场景 | 预期 | 取证方式 |
|---|---|---|---|
| 1 | Visit #1 的 Token A，改派发生**前**访问 `GET /api/technician/visits/:token` | **`200`** | 受理 → 派工 → 拿 A → `GET` |
| 2 | **同一条 Token A**，改派发生**后**再访问 | **`401 TOKEN_INVALID`** | 改派 → 重打 A（**同一条 token，不是新取的**） |
| 3 | 新 Visit #2 的 Token B 访问 | **`200`** | 改派响应/发件箱取 B → `GET` |
| 4 | **已过期** Token | **`401 TOKEN_INVALID`** | 把 `token_expires_at` 改到过去（或把设置改成极小 TTL 后重新派工） |
| 5 | **已使用**（已提交回执）Token | **`401 TOKEN_INVALID`** | `submit` 成功 → 用**同一 A** 再 `GET` |
| 6 | **随机不存在** Token | **`401 TOKEN_INVALID`** | 随机 43 位 base64url（**格式合法**，避免测成 `MALFORMED`） |

**逐条另有两条附加断言（否则矩阵是半个矩阵）**：

- **A. 响应体一致性**：6 条里的失败响应**体完全一致**（同 `code`、**不含** `reason`/`visit`/`ticket` 等字段）。
  逐字节比对 —— 任何差异都是**枚举侧信道**。
- **B. 反向验证（`--reverse`，铁律 8）**：临时把"改派时吊销旧 Token"这段**去掉**，
  重跑第 2 条 —— 必须**变红**。验证完**还原并重跑全绿**（铁律 9：自造失败跨轮污染）。
  只写一句"若去掉就会红"是**描述，不是验证**。

**防枚举的额外要求**：

- 第 6 条（随机不存在）与第 4/5 条（真实但无效）的**响应时间差**不得成为判据来源 ——
  `TokenService.verify()` 已做到"不存在时不做第二次查询"。脚本可**记录**耗时供人工观察，
  但**不要**把它写成硬断言（CI 抖动会假红，属"会误报的检查比没检查更糟"）。

---

## 6. 照片链路（`docs/SECURITY.md` §3）

### 6.1 安全口径（五条，缺一不可）

| # | 要求 | 反例（若不做会怎样） |
|---|---|---|
| 1 | 文件本体落 **私有目录**（`.env` 的 `UPLOAD_PRIVATE_DIR`） | 落 Web 可直读路径 → 拿到 URL 就能看，绕过一切鉴权 |
| 2 | `storage_key` **不对外返回** | 泄漏私有目录内的相对路径，等于给出可拼接的读取线索 |
| 3 | `mime` 由 **magic bytes** 判定，不信任 `Content-Type` / 扩展名 | 传 `evil.svg` 改名 `.jpg` → 存储型 XSS |
| 4 | 重编码时**剥离 EXIF/GPS** | 师傅家里的 GPS 落进客户数据，隐私事故 |
| 5 | 读取走**受控端点**（登录 + 门店范围，或短时签名 URL） | 见 1 |

**类型白名单**：`image/jpeg` / `image/png` / `image/webp`。**拒绝 SVG**（XSS 载体）。
**重编码**：`sharp`，长边 ≤1600，质量 0.82。
**签名 URL**：`?exp=&sig=`，`sig = HMAC(photoId|exp|SIGN_SECRET)`，**10 分钟**有效。

### 6.2 校验链（顺序固定）

```
Token 有效 → Visit 存在且 ASSIGNED → 未过期 → 未使用
  → 数量 ≤ visit.photo_max_count（含本次）
  → 单张 ≤ visit.photo_max_size_mb
  → magic bytes ∈ 白名单
  → 重编码（剥 EXIF）→ 落私有目录 → 建 attachments 记录 → 建 serviceVisitPhotos
```

**响应**：`{ photo_id, photo_type, sort_order }`（**不回** `storage_key`）。

### 6.3 必须断言的"不变量"

- ✅ 上传后 **`UPLOAD_PRIVATE_DIR` 下确有该文件**，且 **`/storage/uploads/` 路径直取 → 404**
  （不是"没试过"，是真的打一次）。
- ✅ 存下来的文件 **EXIF 已被剥离**（读回文件元数据断言，不看代码）。
- ✅ 超数量 / 超大小 / 非白名单类型 → **422**（三类各一条，别合并成一条）。
- ✅ 签名 URL：正确签名 → `200`；**过期** → `401/403`；**签名被改一位** → 拒绝。
- ✅ **不做** `serviceVisitPhotos` 的"列表下载全部"端点（本阶段无此需求，不做就不会漏）。

---

## 7. 提交与状态机（M8）

```
PROCESSING ──M8 submit──▶ WAIT_STORE_CONFIRM
```

**事务内必须一起完成的五件事**（漏一件就是不一致）：

1. 校验 Token 未使用（`token_used_at IS NULL`）→ 置 `token_used_at = now()`
2. 写回执字段（`service_result` / `service_note` / `is_charged` / `reported_charge_amount` / `submitted_at`）
3. Visit 状态 `ASSIGNED → SUBMITTED`（`VISIT_STATUS.SUBMITTED` **已存在**，`serviceVisits.visit_status`）
4. Ticket 状态 `PROCESSING → WAIT_STORE_CONFIRM`（**经状态机校验**）
5. 写 `ticket_events`（`event_type` 走既有枚举，**不新增**不经 `_options.ts` 的事件类型）

**响应**：`{ status: 'WAIT_STORE_CONFIRM', submitted_at }`。

**断言要点**：

- 提交后 `GET` 同一 Token → **401**（用后即焚）
- 工单详情（门店端 `/api/svc:timeline`）**能看到这条事件**
- **mock 发件箱里没有评价邀约条目**（§4.4）
- 收费矩阵：`is_charged=true & amount=0` → 422；`is_charged=false & amount>0` → 422；
  `service_note` 空 / 超 1000 → 422；`service_result` 非法值 → 422（各一条）

---

## 8. 断言与反向验证（铁律 1 / 8）

**每条新断言都要有反例**。本阶段至少要有这些 `--reverse`：

| 反向项 | 做法 | 期望 |
|---|---|---|
| 矩阵第 2 条 | 去掉"改派吊销旧 Token" | **必须变红** |
| 矩阵第 5 条 | 不置 `token_used_at` | **必须变红** |
| 照片 EXIF | 跳过重编码直接落原图 | **必须变红** |
| 照片私有性 | 把 `UPLOAD_PRIVATE_DIR` 指到可直读目录 | **必须变红** |
| 不发评价短信 | 提交后手动调一次 `review_invite` | **必须变红** |

⚠️ 反向验证跑完**必须还原并重跑全绿**（铁律 9）。自造失败**跨轮污染**过一次，别再来一次。

---

## 9. 前置核查（`scripts/uat-preflight.mjs` 新增闸门）

开工与走查前都要过：

1. **`/t/` 短链可达**：`curl -I http://localhost:8080/t/<合法43位>` → **302**，`Location` 指向 `/h5/technician/visit/<token>`。
2. **短链非法长度**：`/t/abc` → **不是 302**（不匹配即落到应用，避免把垃圾转发进 H5）。
3. **`PUBLIC_BASE_URL` 与实际访问地址一致**（本地须带 `:8080`，否则短信链接指向 80）—— §2.1 坑 C。
4. **`/api/technician/` 三条路径不再是"resource does not exist"**：打一次未认证请求，
   断言得到 **401**（而不是 404 + 日志里的 resourcer 报错）—— §2.1 坑 A 的回归闸门。
5. **H5 产物已重建且已重启**：跑 `verify-bundle-delivery.mjs`（4 条，含"产物 mtime ≤ app 进程启动时间"）。
   ⚠️ **改完 H5 一定要重建 + `docker compose restart app`** —— 否则真人走查又跑旧产物（DEV-74 重演）。
6. **`UPLOAD_PRIVATE_DIR` 存在且可写**，且**不在** nginx 的任何 `alias` 路径下。

---

## 10. 风险与已知限制（如实标记，不美化）

| # | 风险 / 限制 | 处置 |
|---|---|---|
| R1 | **`/api/technician/` 与 `/api/public/` 共用 `limit_req` 分区的可能**：上传用 `svc_upload`，若拉取也走它，高频刷新会挤掉上传配额 | 明确分区；必要时给拉取单独 `limit_req` 与更宽 burst |
| R2 | **图片处理依赖（`sharp` / `file-type`）可能不在 NocoBase 镜像内** | 开工第一步确认；若缺，走插件 `package.json` 依赖 + 重建镜像（**不在容器里 `npm i` 手工装**） |
| R3 | **`remote` 模式无 Visit** ⇒ 远程完成走 I7，不走本阶段接口 | 断言：`remote` 工单不产生师傅 Token（DEV-42 已保证） |
| R4 | **本地 `PUBLIC_BASE_URL` 缺端口**，短信链接在本地打不开 | §9 闸门 3；**这是环境问题，不改代码口径** |
| R5 | **H5 无自动化 UI 断言**（Vue 组件断言成本高） | 沿用 Phase 4 口径：**自动化只补充，真人走查为准**（`docs/PHASE-4.md` §12.2 / §13.5） |
| R6 | 真实短信通道下**收不到链接**（本地无短信） | 走 mock 发件箱取链接；断言只认 mock 通道（`sms.provider=mock`） |
| R7 | 本阶段**不**验证弱网/大图体验 | 记入 backlog，Phase 5 不做 |

---

## 11. 交付状态表（随进度更新）

| 项 | 状态 | 备注 |
|---|---|---|
| §2.1 坑 A：`/api/technician/` rewrite | ⬜ 未开始 | nginx 改动，**先做** |
| §4.1 短链口径裁定（推荐方案 A） | ⬜ 待裁定 | 需用户/复核方确认后落地 |
| S1~S2 师傅 action + Token 认证层 | ⬜ 未开始 | |
| S3~S5 照片管线 + 签名 URL | ⬜ 未开始 | 先确认 R2 依赖 |
| S4 `submitReceipt()` | ⬜ 未开始 | |
| H1~H5 师傅 H5 页面 | ⬜ 未开始 | |
| N1~N3 nginx | ⬜ 未开始 | |
| V1 Token 失效矩阵脚本（**硬验收**） | ⬜ 未开始 | |
| V2~V3 照片 / 提交脚本 | ⬜ 未开始 | |
| V4~V6 集成进 smoke / preflight / reset | ⬜ 未开始 | |
| **真人走查（AT-16~19 / AT-22）** | ⬜ 未开始 | **自动化只能补充，不得替代** |

---

## 12. 与其它文档的关系

- 阶段总览与验收条目：`docs/DEV-PLAN.md` §Phase 5、`docs/PHASE-0.md`
- 接口契约（**本阶段以其为准**）：`docs/API.md` §2（师傅 Token 接口）
- 状态机 M8 / Token 生命周期：`docs/STATE-MACHINE.md` §5
- 安全口径（照片 / Token）：`docs/SECURITY.md`
- 后台页面与产物交付（改 H5 产物必读）：`docs/FLOW-ENGINE-NOTES.md`
- 上阶段交付报告：`docs/PHASE-4.md`
