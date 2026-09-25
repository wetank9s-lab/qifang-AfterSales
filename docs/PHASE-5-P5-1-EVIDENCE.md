# P5-1 交付证据（师傅匿名闭环）

> **状态：🟢 PASS（用户 2026-09-25 裁定）· 正式交付基线 `297e728`**
> ⇒ P5-1 关闭。**（当时）Phase 5 仍 🟡 HOLD**（唯一剩余项 = **P5-2 手机真人走查**，见 `docs/PHASE-5-P5-2-UAT.md`）。
> 📌 **后续结论批注（2026-09-25）**：P5-2 已于同日由真人走查跑通 → 条件项 **DEV-82** 收口（`14c5b1a`）
> ⇒ **P5-2 🟢 PASS / Phase 5 🟢 PASS**（关闭记录见 `docs/PHASE-5.md` §14）。
> 本行上方「Phase 5 仍 🟡 HOLD」为**当时的原始记录，保留不改**；本文档**基线仍为 `297e728`**，
> DEV-82 属 P5-2 收口修复，**不倒回去改写 P5-1 历史**。
>
> 范围：`Technician Token → GET 最小上下文 → 上传 1~6 张 → 填回执 → Submit →
> Visit ASSIGNED→SUBMITTED / Ticket PROCESSING→WAIT_STORE_CONFIRM / Token 用后即焚 / 写 TicketEvent
> → 页面「已提交，等待门店确认」`。
>
> **到 `WAIT_STORE_CONFIRM` 为止**：门店确认/驳回、评价 Token、评价短信、`CLOSED` **均未实现**。
> 停止线核验方式：对 `nocobase/plugins/service-ticket/src/server/actions/technician/` 与 `h5/src` 全量 grep
> `STORE_CONFIRMED|storeConfirm|store_reject|REJECTED|CLOSED|reviewToken|review_token|评价` ——
> 命中的**只有注释文字**（"刻意不做：门店确认/驳回、评价 Token、评价短信、CLOSED"），无任何实现。
>
> 取证时间：**2026-09-25 09:13 复跑确认**（首次取证 2026-09-24 08:52，两者均在 **DEV-75/DEV-80 修复之后**）。
> 九支门禁今日全部退出码 0：h5 **33**（含 fixture 13）· fixture 自检 **13** · 变异 **7/7** ·
> token-matrix **12** · upload **20** · submit **11** · config **56** · plugin-load **61** · bundle-delivery ✅。
> 环境：`svc-app` healthy · `svc-nginx` healthy · `svc-postgres` healthy · 本机 nginx 端口 8080。

---

## ⓪ 新发现分诊（按 2026-09-25 定的三类规则）

> 规则：**A 影响匿名技师闭环/安全边界/数据一致性 → 本阶段必须修**；
> **B 只是后台 UX/运维体验 → 进 backlog**；**C 门店确认/评价/关闭链路 → 留给后续 Phase**。
> 目的：**不因为实现中冒出新问题就不断扩大 P5-1 范围**。

### A 类 —— 已在本阶段修掉（6 项，全部带机器门）

| 编号 | 一句话 | 为什么必须本阶段修 |
|---|---|---|
| **DEV-75** | `statusOf()` 漏映射 `VisitValidationError` ⇒ 照片 413/415/422 **全变 500** | **安全边界**：拒绝语义失真，把"参数不对"报成"服务故障" |
| **DEV-80** | 已收费的师傅点提交**静默失败**（Vue `type="number"` → `.trim()` TypeError） | **闭环**：直接阻断一条分支，且页面**无任何提示** |
| DEV-76 / 76b / 76c | checker 正则撒网**吞掉 6KB 模板** | 验收有效性：假绿（P5 终态红线正落在被吞掉的那段） |
| DEV-77 | `eq()` 引用比较 ⇒ 断言**永不可能通过** | 验收有效性：会训练人忽略这条检查 |
| DEV-78 | 终态文案只扫 JS 字面量 ⇒ 模板里的"工单已完成"**零反应** | 验收有效性 + P5 红线 |
| DEV-79 | `photoUrl()` 在**渲染路径** throw（白屏）；校验放错层次 | 闭环可用性 + 安全边界定位 |

修法一律是"**修产生断言的验证方法**"，且每项都有**能变红的门**：
DEV-75 → `verify-plugin-load` 的"每个自定义 Error 类都要有分支"枚举闸（含自检）；
DEV-80 → H5 门禁 DEV-80 回归门 + fixture 双向 + 变异测试条目；
DEV-76~79 → `scripts/lib/h5-contracts.mjs`（分区 + 结构化提取 + `eqScalar`/`eqJson`）
+ fixture 层 + 变异测试（**7/7 被抓住**）。

### B 类 —— 进 backlog（不阻塞），见 `docs/BACKLOG.md`

`agent-browser` CLI 不保持会话（工具侧，已用 CDP 绕过）· 走查工单需手工复位 ·
"重建产物后重启 app"仍靠人记得 —— 都是**运维/体验**，不影响产品与验收有效性。

### C 类 —— 留给后续 Phase（本阶段**不得**提前实现）

门店确认/驳回 · 评价 Token/评价页/评价短信 · `CLOSED` 写路径。
✅ 已复核：这些在状态机里**只有声明**（枚举与允许转移表），**没有任何写路径**；
`CLOSED` 除枚举与转移表外零命中；technician actions 里唯一含 `confirm/reject` 的两处
分别是**只读投影** `store_confirm_status` 与认证辅助 `rejectInvalidToken`（命名撞车）。

---

## ① Token HTTP Matrix（8 格 + 反枚举）

脚本：`scripts/verify-technician-token-matrix.mjs`（**真实 HTTP**，12 项全绿）
输出原件：`.tmp-verify/evidence/final/verify-technician-token-matrix.txt`

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| 1 | 有效 Token A（`FW20260924-0019`） | 200 + 只回最小上下文 | **200**，`photos=0 max=6`，只回工单号/门店/问题/预计上门 |
| 2 | 随机 43 位 Token | 401 `TOKEN_INVALID` | **401** |
| 3 | 已过期（夹具置位后立即还原） | 401 | **401**（visit=488，跑完已还原） |
| 4 | 已使用（**Visit 仍 ASSIGNED**） | 401 | **401**（visit=489；证明"已用"是**独立**分支，不是靠 Visit 已提交顺带挡住的） |
| 5 | 改派**前** A | 200 | **200** |
| 6 | 改派**后**同一枚 A | 401 | **401**；旧行 = `SUPERSEDED\|reassigned\|王师傅`（状态/原因/姓名一字段未改，只置吊销位） |
| 7 | 改派产生的新 Visit 的 Token B | 200 | **200**（`visit_no=2`，B ≠ A） |
| 8 | B 在**真实 submit 之后** | 401 | **401**；`Visit=SUBMITTED（used=true）`、`Ticket=WAIT_STORE_CONFIRM` |

**反枚举（"不泄露具体失效原因"）**：
- 四种失效（随机/过期/已用/已吊销）的响应体**逐字节相同** —— 同一个响应体，**68 字节**。
- 响应体不含任何失效原因关键词，也不含 `detail` 字段。
- 随机 Token 打**四个端点**（get/upload/submit/photo）全部 401 → 认证层是**结构性**的，不是"只装在 get 上"。

---

## ② Upload Security Matrix

脚本：`scripts/verify-technician-upload.mjs`（20 项全绿）
输出原件：`.tmp-verify/evidence/final/verify-technician-upload.txt`

| 要求 | 实测 |
|---|---|
| **magic bytes 才是判据** | 真 JPEG/PNG/WebP → 正确 MIME + 尺寸；改名 PHP、SVG、纯文本、GIF、截断 JPEG **全拒**（`UNSUPPORTED_FORMAT` / `NO_DIMENSIONS`） |
| 不信任声明/扩展名 | 声明 `image/jpeg` 的 PHP 源码 + `.jpg` 扩展名 → **仍判非法**（415 `UNSUPPORTED_IMAGE`） |
| **EXIF/GPS 剥离** | 真实解码器验证：剥后 EXIF/GPS 为空、**尺寸不变**、**像素逐字节一致**、仍可解码；覆盖 `APP1(Exif/XMP)` / `PNG:eXIf` / `WEBP:EXIF` |
| WebP 容器长度重算 | RIFF 声明长度 = 真实字节数（`declared=28908 actual=28908`），不是"剪掉尾巴留个坏容器" |
| **单张大小** | 应用层 1MB 上限 vs 1.51MB → **413** `PHOTO_TOO_LARGE`；超 nginx 上限（12.6MB）→ 网关层 413；**两种都零副作用**（文件数不变） |
| **1–6 张（上限原子）** | 累计 6 张后第 7 张 → **422** `PHOTO_LIMIT_REACHED`，磁盘仍 6 个文件（不多出） |
| **Visit 绑定（属主校验）** | 拿 A 单的 ref 用 **B 单的 token** 读 → **404**（`PHOTO_NOT_FOUND`，与非法 ref **同一响应** —— ref 不可猜 ≠ 已授权） |
| **私有存储** | 私有目录有文件、**公共可服务目录没有同一个 storage_key**；公共静态路径**真打一次**取不到图片内容 |
| 存的确实是剥离版 | 磁盘字节 == 本地剥离后字节（`87069 → 86857B`） |
| **Visit 状态限制** | 提交后（`SUBMITTED`）再传 → 401、零新增；改派后（旧 Visit `SUPERSEDED`）旧 Token 上传 → 401、零新增。`CANCELLED` 与它们**走同一个分支**（`WHERE visit_status='ASSIGNED'`）—— ⚠️ **未单独实测**（P5-1 无取消入口） |
| **token 维度限流** | 每小时上限临时降到 2 → 第 3 次 **429** 且带 `Retry-After`（实测 429/`Retry-After=489s`），跑完恢复原值 |
| 事务边界：照片成功 ≠ 提交成功 | 提交前"刷新/重进" → 仍能看到已传 6 张、ref 稳定、**Visit 数仍为 1**（未产生第二个 Visit） |

**匿名 H5 不持有任何通用后台凭证**（取证，不是声明）：
- 匿名可访问的 action **共 8 个**，全部显式枚举：`svc:health`、`svc:guardQuota`、
  `public:storeList`、`public:ticketCreate`、`technicianVisit:{get,upload,submit,photo}`。
  **没有** `attachments:*`、没有通用文件 CRUD、没有 `serviceVisitPhotos:list`。
- H5 源码里 **零** `Authorization` / `Bearer` / `password` / `signIn` / `/api/auth`；
  唯一的本地持久化是走查用的 `sessionStorage` "已提交"标记（**不含任何凭据**，只影响显示）。
- 照片读取**只有一条通路**（`technicianVisit:photo`，需 Token + 属主校验）；文件本体在私有目录，
  公共路径取不到内容（实测 401）。

---

## ③ Submit 原子性（前后快照 + 回滚 + 重放）

脚本：`scripts/verify-technician-submit.mjs`（11 项全绿）
输出原件：`.tmp-verify/evidence/final/verify-technician-submit.txt`

### 成功路径（四样必须一起变）

```
Visit 快照（id | visit_no | 状态 | 确认状态 | result | note | charged | 金额 | token_used | revoked | submitted_at）
 before: 494 | 1 | ASSIGNED  | pending | -        | -                                    | f | -      | false | false | -
 after : 494 | 1 | SUBMITTED | pending | resolved | 已更换排水泵并试机 30 分钟，无异常    | t | 128.50 | true  | false | 2026-09-24 08:52:54.429+08

Ticket: before=[PROCESSING | 2026-09-24 08:52:50.649697+08 | - | 王师傅]
        after =[WAIT_STORE_CONFIRM | 2026-09-24 08:52:50.649697+08 | - | 王师傅]
事件：5 → 6（新增一条 technician_submitted）
```
- 收费口径：不收费时入库金额为 **NULL**（请求里带 300 也不采纳）；串 `'false'` 不会被翻转成 `true`。
- 入参契约：`service_result` / `service_note`（含"纯空白"）/ `is_charged` / 收费金额
  （含"三位小数会被 `numeric(12,2)` 静默舍入"这一格）**逐条 422**；且**每次拒绝后 Token 仍未消耗**、
  Visit/Ticket/事件**一字未改**。

### 反向测试 R1：故意让 Ticket 状态更新失败 → 零半落账

```
· 强制失败时返回 500 INTERNAL_ERROR（符合"基础设施故障"口径）
· 回滚判据：Visit 仍 ASSIGNED / token_used_at 仍空 / 事件数不变 —— 全部成立
· 恢复判据：撤掉触发器后**同一 Token** 提交成功（证明链接没被半消费）
```
→ 事务边界成立：**不会**出现"Visit 已 SUBMITTED 但 Ticket 还在 PROCESSING"这类半提交。

### 反向测试 R2：成功后重放完全相同的请求

```
重放 401 TOKEN_INVALID；Visit / Event / Ticket / submitted_at 四项全部未变；upload / photo 也一并关闭
```
→ **不会产生第二条 Event**，也没有其他副作用（"用后即焚"是真的）。

---

## ④ 真实浏览器走查（真实 Chromium + 真实网络）

- 驱动：`scripts/walkthrough-p5-1-browser.mjs`（CDP 驱动 `agent-browser` 装好的 Chrome 153，
  手机视口 390×844），夹具：`scripts/walkthrough-p5-1.mjs setup`，
  复核：`scripts/walkthrough-p5-1.mjs verify`。
- 走查单：**`FW20260924-0018`（ticket_id=1909 / visit_id=487）**；
  链路：真实短信形状的 `params.link` → `/t/{token}`。
- 截图与请求响应原件：`.tmp-verify/evidence/browser/`（`step1..step6` + 网络调用清单 + 各步报文）。

| 步骤 | 实测 |
|---|---|
| ① 短链 | `GET /t/jgCkegg…` → **302** → `http://localhost:8080/h5/technician/visit/jgCkegg…` |
| ② 最小上下文 | 页面只有：工单号 `FW20260924-0018` / 服务门店 / 预计上门 / 问题描述。**手机号 ✗ 未出现 · 客户字段名 ✗ 未出现**（字段级 + 形态级双查）；页面**无"完成/已关闭"表述**；`GET /api/technician/visits/<token>` → **200**，响应体 5 个客户字段名均未出现 |
| ③ 上传 | **一次选文件 = 1 次上传**（`POST …/files` → **201**，`ref=Hl4pP_…`）；照片在页面上真的渲染出来（`naturalWidth=1200`，`referrerpolicy=no-referrer`） |
| ④ 填回执 | 处理结果 **已解决**；是否收费 **已收费** → 金额框**才出现**（条件渲染）→ `128.50` |
| ⑤ 提交 | 终态文案 **「✓已提交，等待门店确认」**（无"完成"）；`POST …/submit` → **200**，响应含 `WAIT_STORE_CONFIRM`；提交报文逐字段 = `["is_charged","reported_charge_amount","service_note","service_result"]` |
| ⑥ 刷新复核 | 刷新后**仍显示「已提交，等待门店确认」**（不是"链接不可用" —— 否则师傅会以为没提交成功而重复联系门店）；刷新触发的 `GET …/visits/<token>` → **401** |

**库侧复核（`verify`，退出码 0）**：
```
Visit   : SUBMITTED / pending / resolved / 已收费 128.50 / Token 已消费 / submitted_at=2026-09-24 08:48:16
Ticket  : WAIT_STORE_CONFIRM（completed_at 与 reviewed_at 均为空 —— 工单未完成）
事件    : created → accepted → dispatched → sms_sent(客户/师傅) → **technician_submitted(PROCESSING→WAIT_STORE_CONFIRM)**
照片    : id=55 onsite image/jpeg 91369B 私有=true 公共文件=false 公共 HTTP=401
闭环收口: 再次 GET → 401 TOKEN_INVALID · 再次 submit → 401 TOKEN_INVALID
```

---

## ⑤ 本轮发现的异常（含 2 个产品缺陷）

### 产品缺陷 1 · DEV-75：`statusOf()` 漏了一整个错误类 → 照片链路错误全变 500
`VisitValidationError extends Error`（**不是** `ValidationError`），而 `_http.ts` 的 `statusOf()` 只映射了后者。
于是照片 413/415/422 **全部**被兜成 `500`。该类两阶段前就已存在，只因老路径抛的是 `ValidationError`（有分支）
而从未暴露 —— P5-1 的照片上传第一次让它现形。**已修**，并补结构闸：`verify-plugin-load` 现在枚举
`services/*.ts` 里所有 `export class *Error extends`，要求 `statusOf()` 里**每个都有分支**（含自检）。

### 产品缺陷 2 · DEV-80：**已收费的师傅点提交，静默失败**
`h5/src/pages/Technician/Visit.vue` 的 `onSubmit` 里写了 `form.reported_charge_amount.trim()`，
而 Vue 对 `<input type="number">` 的 `v-model` 会把值转成 **number**
（`runtime-dom` 的 `castToNumber = modifiers.number || el.type === 'number'`）→ `TypeError`；
异常抛在 `@submit` handler 内，Vue 交给 `console.error` → **页面上一个字都不显示**：
按钮可点、无红字、无请求，**工单其实没提交**。只有"已收费"才走这条路径，所以 API 层用例（`verify-technician-submit`）
**不可能发现它** —— 是真实浏览器走查逼出来的。**已修**（统一经 `amountText()/toAmount()` 读取），
并固化为机器门：H5 门禁新增 DEV-80 回归门 + fixture（双向）+ 变异测试条目。

### 验证器缺陷 · DEV-76~79（四条红灯全是 checker 自己错）
`stripComments` 误吃 `accept="image/*"`、`eq()` 用引用比较（断言永不可能通过）、
`photoUrl()` 在渲染路径 throw、终态文案漏扫 Vue template text。
处置按"**修产生断言的验证方法**"执行 → `scripts/lib/h5-contracts.mjs`（分区 + 结构化提取 + `eqScalar`/`eqJson`）
+ `verify-technician-h5-selftest.mjs`（fixture 层，**每条源码级规则还要拿真实源码喂一遍**）
+ `verify-technician-h5-mutation.mjs`（变异测试，**7/7 被抓住**，含 DEV-80）。细则见 `docs/ENGINEERING-RULES.md` §A′。

### 我自己制造并修掉的两个假红（记录在案）
1. **`/customer_/` 前缀匹配**：服务端处理结果枚举里有合法值 **`customer_absent`（"客户不在家"）**，
   前缀匹配把**枚举值**当成了客户资料。已改为按**精确字段名**判 + 手机号形态兜底。
2. **`publicDirHasAnyPhoto()`**：公共可服务目录里本来就有后台 `logo-*.png`，粗判据**恒为真**。
   已改为落到**本次照片的 storage_key**（并真打一次公共路径，断言取不到图片内容）。

### 走查工具的两个坑（工具侧，非产品）
- `HTMLElement.click()` 派发的合成事件在 Chrome 里**不会触发表单默认提交**；已改为 CDP 真鼠标点击
  （`Input.dispatchMouseEvent`）+ 点击坐标命中自检。⚠️ 注意：本轮"点了没反应"的**真正原因**是 DEV-80，
  合成点击只是让排查多绕了一圈。
- 走查脚本原先端口/profile 写死，两次运行会**抢同一个浏览器**，症状是"日志说第一步超时、库里流程却跑完了"；
  已改为按 pid 隔离。

---

## ⑥ 对验收口径的回应

| 口径 | 证据 |
|---|---|
| **照片上传成功 ≠ 服务提交成功** | ② B9：提交前刷新/重进，6 张照片仍在、ref 稳定、**Visit 数仍为 1**（不会产生第二个 Visit） |
| **技师提交成功 ≠ 工单完成** | ③ 快照：Ticket 到 `WAIT_STORE_CONFIRM`，`completed_at`/`reviewed_at` 为空；④ 终态文案「已提交，等待门店确认」，全页无"完成/已关闭" |
| 所有无效 Token 对外统一 `401 TOKEN_INVALID` | ① 第 2/3/4/6/8 格；且四种失效响应体**逐字节相同（68B）**、不含原因与 `detail` |

---

## ⑥b HOLD 两项的整改结果（2026-09-25，用户 HOLD 后补齐）

用户 2026-09-25 对 P5-1 给出 **🟡 HOLD**，附两项提交前必须定死的条件，均已整改：

**① "至少 1 张照片"已定为口径并落地（服务端权威校验）**

- 业务契约 = **1–6 张**（用户拍板，`docs/PHASE-5.md` 新增 §6.2a）。
- 服务端：submit 时 `photo_count < 1 → 422 PHOTO_REQUIRED`；`photo_count > max → 422
  PHOTO_LIMIT_REACHED`（防御性兜底，防"后台把上限调小"类绕过）。
  实现：`server/actions/technician/visit.ts` submit handler（原注释"不要求至少一张"已随裁定作废）。
- 前端（`Visit.vue`）：提交按钮置灰（`canSubmit` 加 `photoCount >= 1`）、`onSubmit` 入口拦一道
  （按钮置灰挡不住回车提交）、0 张时页面显示"请至少上传 1 张现场照片后才能提交"。
  **前端不是唯一防线**，服务端独立校验。
- **机器门**（`verify-technician-submit.mjs` 新增矩阵 P，11 → 14 项，全部通过）：
  - **P1** 0 张 submit → `422 PHOTO_REQUIRED`，且 Token 未被消耗（复用"拒绝不消耗 Token"守卫）；
  - **P2** **用户点名路径**：上传 1 张 → 库里失效到 0 张（直接删行模拟，绕过一切页面状态）→
    submit 仍被服务端拒绝；补回 1 张后恢复（证明可恢复路径）；
  - **P3** 防御性上限兜底：`visit.photo_max_count` 临时降为 0 → 已有 1 张也被拒，跑完恢复原值；
  - **P4**（正向）带 1 张提交成功 → 事件 metadata `photo_count=1`（与上传矩阵 B9b 的
    "6 张 + photo_count=6" 合起来钉住 1 和 6 两个边界）。
- 连带修复：token 矩阵 #8 与 submit 矩阵 A4/R1 的夹具补齐 1 张照片前置（此前是 0 张提交成功，
  新校验生效后如实拦截 —— 校验在真实环境里第一次咬到的就是验收夹具自己，属预期行为）。
- 共享夹具 `ensureFixtureJpeg()`（真 JPEG，过 magic bytes + 容器完整性两道闸）收敛到
  `technician-harness.mjs` **只此一份**（铁律 5：同一段逻辑出现两次 = 同一个坑两条腿）。

**② SMOKE_ADMIN_PASSWORD 安全债已清（用户判 A 类，本次顺手清除）**

- 处置口径：`smoke-test.mjs` **未设置该口令时明确失败并拒绝运行**（打印原因 + exit 1），
  **不存在任何默认口令 fallback**。
- 文档措辞（按用户要求，不写"再次删除"）：**完成仓库级同类扫描并清除剩余 smoke fallback**。
  实际核查：最早公开提交（`d9c617e`）确含 `envValue('SMOKE_ADMIN_PASSWORD', 'admin123')`
  明文默认值，其后某次提交已把 fallback 改为空串；本次补上"未设置 → 明确失败"的快门。
  （历史提交里的旧口令已随口令轮换失效。）
- **仓库级同类扫描**（PASSWORD/PASS/SECRET/TOKEN/API_KEY/AES_KEY × `ENV||'固定值'` /
  `?? '固定值'` / `${VAR:-固定值}` 三类模式，覆盖 `scripts/`、插件源码、H5 源码、nginx、compose）：
  - **0 处**真实秘密 fallback；
  - 命中项均为良性：`DB_PASSWORD` 的 `\u0000` 哨兵（泄漏检测正则，非默认值）、
    `SMOKE_USER_PASSWORD='Smoke@12345'`（smoke 自建自删的一次性夹具账号，dummy 值）、
    UAT 账号口令全部 env 驱动且缺失即失败（`uat-accounts` / `technician-harness` /
    `seed-admin-pages` 同一形态）。
- 反向验证：临时清空 `.env` 里的口令跑 smoke → 打印明确失败原因、不发登录请求、立即退出（随后恢复）。

**真人手点**：用户裁定**不作为 P5-1 阻塞项**（④ 的 CDP 真实浏览器已覆盖链路与 DEV-80 收费分支）；
正式关闭 Phase 5 前建议由未参与开发的人拿手机走一次短信链接（移动端 UX 验收，非代码闸门）。

## ⑦ 不在本轮范围 / 未做（**均不阻塞本阶段**）

- **C 类**（门店确认/驳回、评价 Token/评价短信、`CLOSED`）—— 按停止线**未实现**（复核见 ⓪）。
- **B 类**（运维/体验）—— 已归档到 `docs/BACKLOG.md`，不阻塞。
- `CANCELLED` 状态的"拒绝新增照片"**未单独实测**（与 `SUBMITTED`/`SUPERSEDED` 共用同一分支
  `WHERE visit_status = 'ASSIGNED'`；P5-1 无取消入口，无法自然构造）。**判定：不阻塞** ——
  同一分支已被两个状态实测覆盖。
- ~~"至少 1 张照片"口径~~ → **已裁定并整改**（见 ⑥b ①）；~~真人手点~~ → **已裁定不阻塞**（见 ⑥b）；
  ~~尚未 commit/push~~ → **已完成**（见 ⑥b 后的发布记录）。

---

## ⑧ 关闭记录（用户 2026-09-25 裁定 · 🟢 PASS）

| 项 | 结论 |
|---|---|
| **P5-1 判定** | 🟢 **PASS**（用户 2026-09-25，HOLD 两项关闭后裁定） |
| **正式交付基线** | **`297e728`** ——"Phase 5 P5-1：师傅匿名回执全链路 + HOLD 两项整改"（39 文件，+9816/−127，已 push 到 `wetank9s-lab/qifang-AfterSales` main，远端 HEAD 回验一致） |
| **不再改动承诺** | P5-1 之后**不再修改 `297e728` 的代码以"补证"** —— 已交付即冻结 |
| **HOLD 两项** | 均关闭：① 照片"1–6 张"口径 + 服务端权威校验（⑥b ①）；② `SMOKE_ADMIN_PASSWORD` 仓库级清理（⑥b ②） |
| **门禁基线** | 九支全绿；**submit 矩阵 14 项为新基线**（原 11）；token-matrix 12 · upload 20 · h5 33（含 fixture 13）· fixture 自检 13 · 变异 7/7 · config 56 · plugin-load 61 · bundle-delivery ✅ |
| **本阶段收获（用户评价）** | 验收体系已从"按钮注册了但点不到"（Phase 4）进化到"**checker 自己可能假红/假绿**"（Phase 5）—— 开始**验证验证器本身**（fixture 双向 + realSources + 变异测试，见 `docs/ENGINEERING-RULES.md` §A′） |

> **下一步**：进入 **P5-2 手机真人走查**（`docs/PHASE-5-P5-2-UAT.md`）——
> 机器已证明系统正确，P5-2 验的是**人能否正确理解系统**。完成后才判 **Phase 5 PASS**。

---

## ⑨ 基线之后的口径变更（DEV-82，2026-09-25 P5-2 期间）

> ⚠️ **本文件 ①~⑧ 的全部证据、门禁计数（submit **14** 项 / h5 **33** 项 / fixture 自检 **13** 条 /
> 变异 **7/7**）都是 **`297e728` 这个快照**的事实，**不回填、不改写**。

P5-2 手机真人走查之后，用户裁定了一项**轻量业务规则优化**（**DEV-82**）：
`service_note` 由"一律必填"改为 **条件必填**（`resolved` 可留空、其余必填），
规则改由**服务端下发**（`service_results[].note_required`）。

- **性质**：规则口径优化，**不是缺陷**，**不构成 P5-1 重开**；`297e728` **未改动**。
- **新基线计数**（DEV-82 之后）：submit **19** 项（14 + N1~N4）· h5 门禁 **35** 项（含 fixture 自检 15 条）·
  变异 **8/8**。⇒ **以新计数为准**，⑧ 里的旧计数仅代表 P5-1 交付当时的快照。
- **定向复测证据**：见 `docs/PHASE-5-P5-2-UAT.md`（机器矩阵 N + 一次最小真实浏览器复验）。
- **完整口径与教训**：`docs/DEVIATIONS.md` **DEV-82**。
