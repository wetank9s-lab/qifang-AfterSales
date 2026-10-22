# UX-PROGRESS-01 客户服务进度可视化与派单师傅信息 · 实施与验收报告

> 日期：2026-10-19 · 状态：**已实施 · 定向门禁 72/72 · 申请独立验收**
>
> ⚠️ **本报告已被 2026-10-19 二次裁决部分覆盖**：§3「对客电话数据缺口」与 §10 的
> "不展示号码、等待裁决"结论作废 —— 最终规则改为**直接使用 `serviceVisits.technician_mobile`**
> 作为对客号码（不新增字段/开关/授权流程）。整改与重新验收见
> **`UX-PROGRESS-01-RECTIFY-REPORT.md`**（门禁 93/93）。
> 本报告其余部分（阶段映射、有效派工解析、隔离边界）仍然有效。
> 不修改 UX-01C、UX-01D M1、UX-MEDIA-01、P11-5 的行为；不触碰 UX-LAST-ORDER-01 的 B-30；
> 华林账号真实登录仍 HOLD（未重置密码）；UX-01D M2 仍未授权。
>
> **未 commit / 未 push。**

---

## 〇、编号核对

`UX-PROGRESS-01` 在全仓（`docs/`、`scripts/`、`nocobase/`、`h5/`）**没有任何命中**，
不存在与既有需求/缺陷编号冲突（`grep -rn "UX-PROGRESS"` 为空）。
最近占用的是 `UX-LAST-ORDER-01`、`UX-01D M1`、`SEC-STORE-01`、`DEV-209/210`、`B-28/B-29`，均不重叠。

---

## 一、先核实现有业务状态（全部来自源码 + 库内真实数据）

### 1.1 真实枚举

| 维度 | 真实取值 | 出处 |
|---|---|---|
| `serviceTickets.status` | `NEW` / `PROCESSING` / `WAIT_STORE_CONFIRM` / `WAIT_FEEDBACK` / `CLOSED` / `CANCELLED` | `constants.ts` `TICKET_STATUS` |
| `serviceVisits.visit_status` | `ASSIGNED` / `SUBMITTED` / `CONFIRMED` / `REJECTED` / `SUPERSEDED` / `CANCELLED` | 同上 `VISIT_STATUS` |
| `ticket_events.event_type` | `created` / `accepted` / `dispatched` / `reassigned` / `rescheduled` / `technician_submitted` / `store_confirmed` / `store_rejected` / `remote_completed` / `reviewed` / `closed` / `cancelled` 等 18 种 | 同上 `EVENT_TYPE` |
| 工单级 `technician_name/mobile` | 是**冗余快照**，改派后可能落后 | `serviceTickets.ts` |

### 1.2 库内真实分布（2026-10-19 复核，非示例数据）

```
tickets : NEW 233 · PROCESSING 108 · CLOSED 92 · CANCELLED 29 · WAIT_FEEDBACK 26
          （WAIT_STORE_CONFIRM 0 —— 现网没有停在"师傅已提交待确认"的单）
visits  : CONFIRMED 115（仅 11 条有姓名/手机号）· ASSIGNED 105（91 条有）
          · SUPERSEDED 55（48 条有）· SUBMITTED 3
events  : created 480 · dispatched 169 · remote_completed 104 · accepted 96
          · store_confirmed 11 · technician_submitted 11 · reassigned 2
```

### 1.3 三条会决定映射正确性的事实

1. **"受理"不是必经动作**：`DISPATCHABLE_STATUSES = [NEW, PROCESSING]`，
   门店可以从 `NEW` 直接派工。所以用户建议的六步里「门店受理」不能作为独立节点 ——
   否则大量工单会永远停在一个不亮的灰点上。
2. **状态可能短暂不一致**：库里存在 `ticket=PROCESSING` 但 `visit=SUBMITTED` 的单（1 张），
   以及 `ticket=CLOSED` 但 `visit=SUBMITTED`（2 张，历史数据）。
   ⇒ 阶段**不能只用 ticket.status 推**，必须优先看 Visit。
3. **大量派工没有师傅姓名/手机号**：`CONFIRMED` 115 条里只有 11 条有姓名 ——
   厂家代处理（provider-only）与远程形态本来就没有具体师傅。
   ⇒ 必须支持"没有师傅卡片"，而不是渲染一个空壳。

### 1.4 映射表：数据库状态/事件 → 客户阶段 → 状态文案

| 优先级 | 真实条件 | 客户阶段 `stage` | 阶段名 | 状态文案（示例） | 5 节点状态 |
|---|---|---|---|---|---|
| 1 | `ticket.status=CANCELLED` | `cancelled` | 已取消 | 工单已取消，无需继续等待上门 | 已提交 done，其余 todo，**无 current** |
| 2 | `ticket.status=CLOSED` | `completed` | 已完成 | 本次服务已完成 | 全 done |
| 3 | `ticket.status=WAIT_FEEDBACK` | `store_confirmed` | 待您评价 | 门店已确认服务完成，等待您的评价 | 前 4 done，第 5 current |
| 4 | `visit.status=SUBMITTED` **或** `ticket=WAIT_STORE_CONFIRM` | `tech_submitted` | 待门店确认 | 师傅已提交服务回执，等待门店审核 | 前 3 done，第 4 current |
| 5 | 有效 visit = `ASSIGNED` / `REJECTED` | `dispatched` | 已派工 | 已安排 王建国 上门为您服务（第 2 次上门）；驳回时「门店已要求师傅重新处理」 | 前 2 done，第 3 current |
| 6 | 有 `remote_completed` 事件且**无任何 visit** | `store_confirmed` | 待您评价 | 门店已通过电话为您处理，无需上门 | 已提交 done / 安排师傅+上门 **skipped** / 门店确认 done |
| 7 | `ticket=PROCESSING`（无有效 visit） | `store_handling` | 门店处理中 | 门店正在安排服务人员，尚未派工 | 已提交 done，安排师傅 current |
| 8 | `ticket=NEW`（无 visit） | `submitted` | 待门店安排 | 已收到您的报修，等待门店安排 | 同上 |

5 个里程碑固定为：**已提交 → 安排师傅 → 上门服务 → 门店确认 → 已完成**。

**为什么不是用户举例的六步**：

| 用户举例 | 实际处理 | 理由 |
|---|---|---|
| 门店受理 | **不单独成节点** | P11-0 起受理已从门店流程移除，NEW 可直接派工；`accepted` 只是历史事件（时间线里仍显示） |
| 已派工 + 师傅服务 | 合并为「安排师傅 → 上门服务」两步，但"上门服务"的完成点是**师傅提交回执** | 系统没有"师傅开始服务"的状态；拆成两个都会有一半时间没有状态支撑，等于假进度 |
| 门店确认 / 已完成 | 保留，另加「待您评价」阶段名 | `WAIT_FEEDBACK` 是真实存在的独立状态（26 张），不能并进"门店确认" |
| — | 新增「已取消」终止分支与「远程解决」跳过分支 | 取消 29 张；`remote_completed` 104 次 |

**不显示百分比**：分母不是真实存在的（改派、驳回、远程解决都会改变实际步数）。
页面只给"当前在第几步 + 哪几步真的发生了（带时间）"。

---

## 二、当前有效派工的解析方式

```ts
// server/services/progress-stage.ts
currentVisit(visits):
  visits 按 visit_no 降序 → 取第一条 status 不属于 {SUPERSEDED, CANCELLED} 的记录
```

| 场景 | 结果 |
|---|---|
| 首次派工 | Visit #1 ASSIGNED ⇒ 返回它 |
| 改派 | Visit #1 → SUPERSEDED，Visit #2 新建 ASSIGNED ⇒ **返回 #2**（旧师傅不下发） |
| 工单取消 | visit 被置 `CANCELLED` ⇒ 返回 null ⇒ **不返回任何师傅** |
| 驳回 | Visit `REJECTED` ⇒ 仍是当前责任人，文案改为"要求重新处理" |
| 已闭环/待评价 | 前端展示"本次服务师傅"，取最新 `CONFIRMED` 的 visit（`role='completed'`） |

**明确不做的事**：
- 不读 `serviceTickets.technician_name/mobile`（工单级冗余，改派后可能过期）；
- 不从 `ticket_events` 推断"现在是谁"（事件只有历史，没有现状）；
- 不跨工单查询（`filter: { ticket_id }`，主键级隔离）。

> 反向验证：把 `currentVisit` 改成"取最旧且不跳过失效"（= 把历史师傅当现任），
> 门禁 **69/72，3 条红全部落在改派场景**（师傅变成旧人 / `visit_no` 错 / 阶段回退成"门店处理中"）。
> 还原后 72/72。

---

## 三、师傅姓名与对客联系电话：字段来源、授权、数据缺口

> 🔴 **2026-10-19 二次裁决已覆盖本节结论**：号码直接取 `serviceVisits.technician_mobile`，
> 不新增字段/开关/授权流程。以 `UX-PROGRESS-01-RECTIFY-REPORT.md` 为准。

### 3.1 字段来源

| 展示项 | 来源 | 投影方式 |
|---|---|---|
| 姓名 | `serviceVisits.technician_name`（派工快照） | 只取该字段，`String().trim()`，空则 `null` |
| 对客电话 | **无合法来源** | `phone=null`、`callable=false`、`contact_hint="请联系门店获取师傅联系方式"` |

### 3.2 为什么不能直接用 `technician_mobile`（**数据缺口**）

| 核查项 | 结论 |
|---|---|
| 模型里有没有"可对客展示"的标志位 | ❌ 没有。`serviceVisits` 只有 `technician_mobile` 一个号码字段 |
| 这个号码被谁用 | 短信**收件人**（发给师傅本人）、内部派工/改派判据、后台列表（且带掩码 `maskMobile`） |
| 客户是否已收到过这个号码 | ❌ 没有。短信模板里没有师傅手机号，客户也从未在 H5 上见过 |
| 有没有授权记录 | ❌ 没有。无字段、无审计、无勾选项 |

⇒ 按你的第 5 条要求：**未获明确授权不得公开个人手机号**。
所以本轮 **姓名展示、号码不展示**，并如实降级为"请联系门店"（不填假号码、不用门店电话冒充师傅电话）。

### 3.3 需要你裁决的两个方案（本轮**未实施**）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 新增受控字段**（推荐） | `serviceVisits.customer_contact_phone` + `allow_customer_call`（布尔，默认 false）；派工时门店可选填；只有 `allow_customer_call=true` 且有值时才下发 `phone`，并进审计 | 一次迁移 + 后台表单 + 门禁；语义干净，能审计"谁授权公开" |
| **B. 复用 `technician_mobile` + 显式授权勾选** | 加 `allow_customer_call` 布尔；勾选后把 `technician_mobile` 作为对客电话 | 少一列，但把"内部联系号码"和"对客号码"混在同一列，改号时无法区分意图 |
| C. 保持现状 | 永远只显示"请联系门店" | 客户少一条自助路径，但零风险 |

在你裁决前，`technician.phone` 会一直是 `null`，页面走降级文案。

### 3.4 最小字段投影（只回这 6 个键）

```json
{ "name": "王建国", "phone": null, "callable": false,
  "contact_hint": "请联系门店获取师傅联系方式",
  "visit_no": 1, "role": "current" }
```

**不返回**：师傅用户行、`rolesUsers`、登录信息、密码哈希、`technician_mobile` 原文、
`access_token_hash`、其他工单的师傅、内部操作人。
也未开放 users / roles / attachments 的任何权限来支撑这次查询 —— 全部走 `serviceVisits` 的服务端读 +
显式字段投影。

---

## 四、页面（真实浏览器，375/390/420）

| 元素 | `data-testid` | 说明 |
|---|---|---|
| 当前阶段 | `progress-stage-label`（带 `data-stage`） | 胶囊标签：已派工 / 待门店确认 / 待您评价 … |
| 当前状态 | `progress-status-text` | 一句话，例如"师傅已提交服务回执，等待门店审核" |
| 步骤条 | `progress-steps` + `progress-step-{key}` + `data-state` | 5 节点，`done/current/todo/skipped` 四态 |
| 已完成时间 | `progress-step-times` | **只列真的发生过的节点**，时间来自事件/行字段 |
| 下一步 | `progress-next-action`（带 `data-owner`） | 等门店 / 等师傅 / 等客户 |
| 师傅卡 | `progress-tech` / `-name` / `-hint` / `-phone` | 无有效派工时整卡不出现 |

截图：`.tmp-verify/ux-progress-dispatched-390.png`、`-375.png`、`-420.png`。

三视口断言：`scrollWidth <= innerWidth` 且 5 个节点不换行 —— 375/390/420 三档全部通过。

---

## 五、真实场景验收（隔离夹具，按 ID 清理）

门禁：`scripts/verify-ux-progress-01.mjs` —— **72 / 72**

| # | 场景 | 关键断言 | 结果 |
|---|---|---|---|
| 1 | 刚提交、未受理 | `stage=submitted`；`technician=null`；只有"已提交"带时间 | ✅ |
| 2 | 已受理、未派工 | `stage=store_handling`；文案含"尚未派工"；`next_action.owner=store` | ✅ |
| 3 | 已派工 | 姓名=王建国；`phone=null/callable=false`；**响应里没有 13900010001**；"安排师傅"时间与 DB 同刻（容差 2s） | ✅ |
| 4 | 师傅处理中 | 文案含"上门"且不含"已完成"；`next_action.owner=technician` | ✅ |
| 5 | 师傅提交回执 | `stage=tech_submitted`；"等待门店审核"；ticket 未 CLOSED；`role=current` | ✅ |
| 6 | 门店确认 → 评价 → 关闭 | `store_confirmed`（待您评价）→ 评价后 `completed` 且 5 节点全 done | ✅ |
| 7 | 改派 | 只显示赵永强；`visit_no=2`；**响应里没有旧师傅姓名/手机号**；阶段仍"已派工" | ✅ |
| 8 | 取消 | `stage=cancelled`；`technician=null`；无手机号；未完成节点保持灰态 | ✅ |
| 9 | 无手机号（厂家代处理） | `technician.name=null`；降级文案指向门店；响应中无任何 11 位手机号 | ✅ |
| 10 | 无效 / 撤销 / 过期 Token | 三者均 401，响应不泄露任何师傅资料 | ✅ |
| 11 | 375/390/420 | 无横向滚动、5 节点不换行 | ✅ |
| 12 | 副作用 | 只新增 4 张夹具；媒体会话不变；派工短信数不超过派工次数 | ✅ |

夹具清理：4 张全部按 ID 删除，`0 残留`（含照片磁盘文件）。

---

## 六、DEV-209 的独立结论

**DEV-209 保持 CLOSED，本次未回退、未重做。**

| 项 | 状态 |
|---|---|
| `created_at` / `updated_at` / `timeline[].at` 的驼峰映射修复 | ✅ 仍在（`progress-service.ts` 中三处 `p.createdAt ?? p.created_at` 原样保留） |
| DEV-209 定向门禁（时间有值/可解析/与 DB 同刻/时间线非递减/Token 401/浏览器显示） | ✅ **20 / 20** |
| 本次唯一改动 | 该门禁第 ⑤ 条"公开响应字段集合未扩大"的期望集合 +2 个键（`progress` / `technician`） |

**为什么这不是"改门禁让红变绿"**：这两个键是 UX-PROGRESS-01 明确要求的新契约，
且有自己的 72 条门禁（含"内部手机号不得出现在响应里"）。
DEV-209 的 19 条时间断言一条未动 —— 时间缺陷的修复结论不受影响。

---

## 七、相关门禁结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `verify-ux-progress-01.mjs`（新） | **72 / 72** | 12 场景 + 浏览器三视口 |
| 同上 · 变异（历史师傅当现任） | **69 / 72（红）** | 3 条红全在改派场景；还原后 72/72 |
| `verify-dev-209-progress-time.mjs` | **20 / 20** | 仅同步字段集合期望 |
| `verify-ux-last-order-01.mjs` | **24 / 24** | 进度接口新增字段未破坏最近工单恢复 |
| 插件类型判据（`build-plugin` 内 `verify-types`） | ✅ 通过 | 188 源文件，产物 1436.1 KB |

---

## 八、Git 与密钥审计

**改动范围（本次）**

| 文件 | 类型 |
|---|---|
| `nocobase/plugins/service-ticket/src/server/services/progress-stage.ts` | 新增（阶段推导纯函数） |
| `nocobase/plugins/service-ticket/src/server/services/progress-service.ts` | 修改（查 visits + 组装 progress/technician） |
| `h5/src/api/media.ts` | 修改（`ProgressView` 类型扩展） |
| `h5/src/pages/Customer/Progress.vue` | 修改（阶段条 + 师傅卡 + 样式） |
| `scripts/verify-ux-progress-01.mjs` | 新增（门禁） |
| `scripts/verify-dev-209-progress-time.mjs` | 修改（字段集合期望 +2） |
| `docs/API.md` | 修改（§1.6 契约） |
| `docs/UX-PROGRESS-01-REPORT.md` | 新增（本报告） |

**密钥审计**

- 新增代码/文档中**没有**任何 Token 明文、口令、`SIGN_SECRET`、AES key；
- 门禁里的师傅手机号是**编造值**（1390001000x），不是真实号码；
- 夹具客户手机号是运行时生成；
- `.tmp-verify/`（截图与日志）与 `storage/` 不入库；
- 未 commit / 未 push（`git status` 只有工作区修改，无暂存内容）。

---

## 九、未做 / 边界

- **未新增**任何权限、角色、原生 ACL 放行；未开放 users/roles/attachments；
- **未改动** UX-01C、UX-01D M1、UX-MEDIA-01、P11-5；
- **未处理** UX-LAST-ORDER-01 的 B-30（仍按原安排独立收口，不因本需求 PASS）；
- 华林账号真实登录仍 HOLD；UX-01D M2 仍未授权；Phase 11 IN PROGRESS；Release HOLD；
- 真机（iPhone Safari / Android Chrome / 微信内置）仍 PENDING —— 本轮只在 Chromium 内核 + 三视口验证。

## 十、申请验收时请你特别裁决的一项

**师傅对客电话的数据缺口**（§3.3）：方案 A / B / C 选一个。
在裁决前，师傅卡片只有姓名 + "请联系门店"，这是刻意做的安全降级，不是漏做。
