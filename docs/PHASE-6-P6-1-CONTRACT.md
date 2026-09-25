# P6-1 事务契约（Store Confirm / Reject）—— 钉死版

> **状态：🟡 契约先行（2026-09-25 开工）· 待用户裁决 §11 的开放项后才进入实现。**
> **本文定稿前，不写任何按钮、不写任何写路径。** 理由：`docs/PHASE-6.md` §6.3 ——
> **按钮必须晚于事务契约与授权面**；"先用按钮试一下"会让 P6-1 的授权面被 UI 反向决定。
>
> 上游：**P6-0 🟢 PASS（阶段已关闭，功能交付基线 `0d45b09`）** —— 只读链路已锁死，
> 本文只定义**写**的那一跳。纲要见 `docs/PHASE-6.md` §7；本文是**逐条钉死的定稿**。
> 状态机：`docs/STATE-MACHINE.md` **M9 / M10 / §7.1 / §7.5**；接口：`docs/API.md` **I12 / I13**。

---

## 0. 本文要回答的问题（用户 2026-09-25 点名）

| # | 问题 | 落在 |
|---|---|---|
| Q1 | 确认金额如何形成 `confirmed_charge_amount` | §3 |
| Q2 | 驳回原因及 Visit 后续语义 | §4 |
| Q3 | 并发 loser 如何返回（用户原话"`FOR UPDATE` loser"） | §5 |
| Q4 | I12 / I13 幂等 | §6 |
| Q5 | confirm 后进入 `WAIT_FEEDBACK` 的**评价 Token / 短信边界** | §7 |
| Q6 | reject 后**究竟停在哪里**等待重新处理 | §8 |
| Q7 | 接口形状与鉴权链（不写清楚就无法实现 Q1~Q6） | §2 |

---

## 1. 写契约前先取证：**契约依赖的既有事实**（含 3 处文档/代码漂移）

> 与 P6-0 的教训一致 —— **注释不是证据，文档也不是**。下列每一条都是本轮**实地读码/实测**得出的，
> 与既有文档不一致的地方**逐条标出**，并说明"以代码为准还是以文档为准"。

| # | 事实（取证方式） | 与文档的关系 | 处置 |
|---|---|---|---|
| **F1** | **全仓 `FOR UPDATE` 命中数 = 0**（`grep -rni "for update"` 覆盖 `nocobase/` + `scripts/`，0 命中）。本项目的并发控制范式是 **「条件 UPDATE + 影响行数」**（`ticket-service.ts` 的 `conditionalUpdate`；`visit-service.ts` 的 `submit/migrate` 同样是 `WHERE visit_status = '...'`）与**唯一索引兜底**（`idempotency_records(scene, idempotency_key)`、`unique(ticket_id, visit_no)`） | ⚠️ **3 处文档写成 `SELECT ... FOR UPDATE`**：`docs/PHASE-6.md` §4.5 L179 / §7 L320、`docs/STATE-MACHINE.md` §4 L82 / §7.1 L147 | **以代码为准**。P6-1 **沿用条件 UPDATE**，不引入 `FOR UPDATE`；本文 §5 把"loser 语义"钉在**影响行数 = 0** 上。§11-**O6** 登记 §4.5/§7 的措辞修正 |
| **F2** | 师傅提交时**不收费 → `reported_charge_amount` 落 `NULL`**（`visit-service.ts` L464-478：`amount` 初值 `null`，仅 `is_charged=true` 时才赋值） | ⚠️ 与 `collections/serviceVisits.ts` L153 注释「`false` 时必须 `= 0`」及 `docs/STATE-MACHINE.md` M8「`false → amount=0`」**矛盾** | **以代码为准**（`NULL`）。P6-1 的 `confirmed_charge_amount` 同口径；§11-**O5** 登记注释修正 |
| **F3** | **内部写动作用的幂等场景是 `INTERNAL_WRITE_SCENE`（`svc_accept` / `svc_dispatch` / …）**，不是 `IDEMPOTENCY_SCENE`。六个既有内部写动作（accept/transfer/cancel/dispatch/reassign/reschedule）**全部**用 `svc_*`；幂等键由 `writeIdempotencyOf()` 组装为 `${ticketId}:${actorUserId}:${requestId}` | ⚠️ `docs/PHASE-6.md` §7 写「幂等 = `IDEMPOTENCY_SCENE.STORE_CONFIRM`（已预留）」—— **对 svc 入口是错的**（`STORE_CONFIRM` 属于公开/技师侧的 scene 表） | **以既有实现为准**：新增 `INTERNAL_WRITE_SCENE.CONFIRM = 'svc_confirm'` / `.REJECT = 'svc_reject'`。**绝不**两个动作共用一个 scene（见 §6.1） |
| **F4** | Visit 的 `UPDATABLE_COLUMNS`（`visit-service.ts` L57-74）**不含** P6-1 需要的 4 列：`confirmed_charge_amount` / `store_confirm_note` / `store_confirmed_by` / `store_confirmed_at` | 文档未提 | **实现前必须显式加入该白名单**；白名单外一律抛错（防列名注入）——**不得**用原生 SQL 绕过 |
| **F5** | Ticket 的 `UPDATABLE_COLUMNS`（`ticket-service.ts` L78-100）**不含** 4 个评价列：`feedback_token_hash` / `feedback_token_expires_at` / `feedback_token_used_at` / `feedback_visit_id` | 文档未提 | 同上，**必须显式加入** |
| **F6** | 缺 / 非法 `X-Request-Id` → **`422 VALIDATION_FAILED`**（`_request.ts` `requireRequestId`，注意**不是** 400） | `docs/API.md` 未列该码 | 沿用 |
| **F7** | 能力不足（如 `viewer` 写）→ **`403 FORBIDDEN`**（`permission-service.ts` L318 `assertCapability`） | 与 `docs/API.md` 角色矩阵一致 | 沿用 |
| **F8** | 内部写动作的**权威写入口**是 `assertCanWriteTicket(actor, ticketId)` = 能力（`WRITE_TICKET`）+ 归属（`assertCanAccessTicket`）；**越权与不存在都表现为 `404`**（刻意，防存在性泄露） | 与 P6-0 的 I11/I14 一致 | 沿用（§2.3） |
| **F9** | `SMS_SCENE.REVIEW_INVITE = 'review_invite'` **已存在**（收件人 = 客户） | ✅ 一致 | 直接用 |
| **F10** | **评价侧的对外短链路径尚未定义**：`TokenService.LINK_PATH` 只有师傅侧的 `'/t/'`（`constants.ts` L675）；`docs/` 里**没有** `/f/{token}` 这类评价短链 | 文档缺口 | ⚠️ 这是 §11-**O1**（第一开放项）：P6-1 必须先定义评价链接形状，否则"发评价短信"无处可指 |
| **F11** | `feedback.token_expire_days` 默认 **15**；另有 `feedback.wait_days` 默认 **7**；而 M14 的判据用的是 `feedback_token_expires_at` | `docs/` 未解释两者关系 | **P6-1 只负责写 `feedback_token_expires_at`**；M14 用哪个由后续阶段定（本文 §12 停止线） |
| **F12** | `money()` 字段 = `decimal(10, 2)`（`collections/_helpers.ts` L168-183）⇒ 上限 **99,999,999.99**，**恰好 2 位小数** | ✅ 一致 | 见 §3.4 的业务上限 |
| **F13** | `ALLOWED_VISIT_TRANSITIONS` **已声明** `SUBMITTED → CONFIRMED / REJECTED`，且 `CONFIRMED` / `REJECTED` **无出边**（`constants.ts` L300-308）；`VISIT_STATUS_TO_CONFIRM_STATUS` 已把 `CONFIRMED→confirmed` / `REJECTED→rejected` 映射好 | ✅ 一致 | 守卫直接复用 `canVisitTransition()` + `derivedConfirmStatus()`，**不得**另写映射 |
| **F14** | 幂等记录的 `response_json` **会缓存首次响应体**（`runIdempotentWrite` → `completeIdempotencyClaim`），且重放时**原样回给调用方** | 文档未强调 | ⇒ **响应体绝不能含评价 Token 明文或评价链接**（§7.4） |

---

## 2. 接口形状与鉴权链

### 2.1 对外路径 / action 名 / nginx

| 接口 | 对外路径（`docs/API.md` I12/I13） | action 名 | nginx 重写入参 |
|---|---|---|---|
| I12 `confirm` | `POST /api/svc/visits/:id/confirm` | **`visitConfirm`** | `filterByTk = :id`（**Visit id**） |
| I13 `reject` | `POST /api/svc/visits/:id/reject` | **`visitReject`** | 同上 |

- `:id` **是 Visit id**（`docs/PHASE-6.md` §4.1「审核对象 = 当前 `SUBMITTED` 的那条 Visit」），
  **不是** ticket id —— 与 I11 一致。ticket id 由服务端**从 Visit 反查**，**不接受客户端传入**
  （否则"审核对象"就可以被调用方替换，§4.1 的裁定形同虚设）。
- ⚠️ **action 名不得与既有冲突**：`visits`（按工单列派工历史）与 `visitDetail`（I11）**均已占用** ⇒ 用 `visitConfirm` / `visitReject`。
- ⚠️ **nginx 重写顺序是硬约束**：`/api/svc/visits/:id/confirm` 与 `/api/svc/visits/:id/reject`
  必须**排在** `/api/svc/visits/:id`（I11）**之前**，否则两段式路径会被单段式规则先吃掉 ⇒
  confirm/reject 会**静默打到只读的 I11 上**（表现是 405/奇怪的 200，而不是明显报错）。
  **实现时必须有一条断言或 preflight 用例专门钉住这个顺序**（登记进 §10）。

### 2.2 入参

| 接口 | 入参 | 必填规则 |
|---|---|---|
| I12 `confirm` | `confirmed_charge_amount`（number）· `note`（string，可选） | 见 §3 |
| I13 `reject` | `reason`（string） | 必填，2–200 字 |

- 两个 action 都**必须**带合法 `X-Request-Id`（UUID v4）→ 否则 `422 VALIDATION_FAILED`（F6）。
- **不接受**客户端传 `visit_status` / `store_confirm_status` / `ticket_status` / `store_confirmed_by`
  —— 这些一律由服务端决定；出现即 `422`（**不接受并忽略**比"悄悄忽略"好：静默忽略会让客户端以为生效了）。

### 2.3 鉴权链（**必须先过，再进事务**）

```
① resolveActor(ctx)                      → 匿名 ⇒ 401 EMPTY_TOKEN（与 P6-0 同形）
② requireRequestId(ctx, actionName)       → 缺/非法 ⇒ 422 VALIDATION_FAILED
③ 读 Visit（by id）
      · Visit 不存在        ⇒ 404 VISIT_NOT_FOUND
      · Visit→Ticket 不存在 ⇒ 404 VISIT_NOT_FOUND（同形）
④ assertCanWriteTicket(actor, visit.ticket_id)
      · 无 WRITE_TICKET（viewer）      ⇒ 403 FORBIDDEN（F7）
      · 超出授权门店范围（scope=stores）⇒ 404 VISIT_NOT_FOUND（与"不存在"**逐字节同形**，F8）
⑤ 校验入参（§3 / §4 的必填与数值）
⑥ 进事务（§5）
```

> **为什么 ①② 在 ③ 之前**：`X-Request-Id` 缺失属**请求格式**问题，不该先花一次库查询去判断
> "这张单存不存在" —— 否则"缺头的探测请求"会把存在性差异暴露在响应耗时/日志量上。
> （P6-0 的 B3/B4 已经把"越权与不存在不可区分"钉死，这里只是保持同一条线的顺序。）

> **为什么 ④ 的"越权"表现为 404 而不是 403**：沿用全系统的刻意设计（F8）。
> ⚠️ 但**必须区分**「角色能力不足」→ **403** 与「数据范围不足」→ **404**：
> 前者是"你这类账号本就不该写"，后者是"这条不属于你"。

---

## 3. Q1 —— 确认金额如何形成 `confirmed_charge_amount`

### 3.1 语义定义（先钉语义，再钉校验）

> **`confirmed_charge_amount` = 门店对本次上门**最终实收金额**的书面认定。**
> 它是**业务记账口径**（`docs/API.md` §5「确认收费金额」KPI 直接汇总它），
> **不是**师傅报数的副本，也不是"客户实付"（那是 `customer_reported_amount`）。

三者关系必须分清（都是既有字段，**不新增模型**）：

| 字段 | 谁填 | 含义 | 何时有值 |
|---|---|---|---|
| `reported_charge_amount` | 师傅（P5-1 M8） | 师傅**报**的金额 | `is_charged=true` 时 `>0`；否则 `NULL`（F2） |
| **`confirmed_charge_amount`** | **门店（本文 M9）** | 门店**认**的实收金额 | **confirm 成功**时按 §3.2 落值 |
| `customer_reported_amount` | 客户（评价页，**不在 P6-1**） | 客户说自己实付了多少 | 评价提交时 |

### 3.2 落值规则（**唯一**判定表，按 `is_charged` 分叉）

| `Visit.is_charged` | 入参 `confirmed_charge_amount` | 落库值 | 违反时 |
|---|---|---|---|
| **`true`** | **必填**，`> 0` | 归一后的入参 | 缺 ⇒ `422 MISSING_CONFIRMED_AMOUNT`；`≤0` / 非数字 / 非有限数 / 超业务上限 ⇒ `422 INVALID_CONFIRMED_AMOUNT` |
| **`false`** | **必须省略或显式传 `0`**；传 `> 0` ⇒ 拒绝 | **`NULL`**（对齐 F2 的师傅侧口径） | 传 `>0` ⇒ `422 CONFIRMED_AMOUNT_NOT_ALLOWED`（**否则会造出"师傅说不收费、门店说收了 128 元"的自相矛盾数据**） |

> **"不收费"落 `NULL` 而不是 `0`**：`0` 会被读成"收了 0 元"（一种金额），
> 而"不收费"是**另一件事**。F2 已经用 `NULL` 表达这一点，门店侧**跟随**，
> 避免同一件事在同一张表里出现两种表达（那正是 `visit_status` / `store_confirm_status`
> 曾经踩过的坑 —— 见 `constants.ts` 的"两者不得各自推进"）。

### 3.3 「改额必须留痕」

| 条件 | `note` 要求 | 落库 |
|---|---|---|
| `confirmed_charge_amount ≠ reported_charge_amount`（**含**"不收费但门店改成收费"这类跨分叉变化） | **必填**，2–200 字 | `store_confirm_note` |
| 相等 | 可选（填了就落 `store_confirm_note`） | `store_confirm_note` |

- 缺 note ⇒ `422 MISSING_CONFIRM_NOTE`（`docs/STATE-MACHINE.md` M9 前置校验）。
- **`note` 与 `reason` 复用同一列 `store_confirm_note`**，且**互斥**：一次操作只会写一个
  （confirm 写"改额原因"，reject 写"驳回原因"）。列注释已写「驳回/改额原因」，**不需要迁移**。

### 3.4 数值口径

- **归一**：入库前 `Math.round(x * 100) / 100`（**与 M8 的 `visit-service.submit` 完全一致**）。
  - 理由：同一个不合法输入（如 `128.505`）若师傅侧接受、门店侧拒绝，会变成"看入口决定行为"的诡异口径。
  - **代价与补偿**：归一意味着"客户端原值"会被悄悄改掉 ⇒ **事件 metadata 必须记 `amount_raw`**
    （客户端原值），让"被改过的位数"可追溯（§9）。
- **业务上限**：`CONFIRMED_AMOUNT_MAX = 99999.99`（**需用户确认**，§11-**O4**）。
  理由：家电台次费用不可能六位数，而"多输一个 0"是金额字段最常见的人为错误；
  列本身的上限是 `99,999,999.99`（F12），**不靠列宽当业务校验**。
- **单位**：元（CNY）。**不接受**分、不接受带千分位/货币符号的字符串。
- `is_charged=false` 时若客户端传 `0`，**也落 `NULL`**（便于统计口径统一，避免 `0` 混进平均值）。

---

## 4. Q2 —— 驳回原因与 Visit 后续语义

### 4.1 入参与落值

| 项 | 规则 |
|---|---|
| `reason` | **必填**，2–200 字（去首尾空白后判定；纯空白视为缺失）⇒ 缺 ⇒ `422 MISSING_REJECT_REASON` |
| `store_confirm_note` | = `reason`（同一列，见 §3.3） |
| `confirmed_charge_amount` | **保持 `NULL`、不写**（驳回**不产生**任何金额认定） |
| `store_confirmer`（列 `store_confirmed_by`） | **写** = `actor.userId` |
| `store_confirmed_at` | **写** = DB 时钟 `now()` |
| `submitted_at` | **不动**（师傅提交时间是不可改的事实） |
| Visit 的**回执与照片** | **一个字段都不改、一张照片都不删** |

> ⚠️ **`store_confirmed_at` 的语义泛化**：字段名是"确认时间"，但驳回也要写它
> ⇒ 它的真实语义是「**门店处置时间**」（确认或驳回）。为什么仍然写：
> ① 库里**没有** `rejected_at` 列，而 §1.2 硬约束是"**不需要任何迁移**"；
> ② `docs/API.md` §5 的 KPI「待门店确认数/时长」口径 = `submitted_at → store_confirmed_at`，
> 不写这一列，**被驳回的 Visit 会永远算成"仍在等待"** —— 那是比字段名不准更严重的失真。
> 处置：**写**，并在 §11-**O5** 登记"给该列补一句注释说明它=处置时间"。

### 4.2 Visit 是**终态**（这是 P6-1 最重要的语义之一）

- Visit：`SUBMITTED → REJECTED`；`store_confirm_status` 由 `derivedConfirmStatus()` **派生**为 `rejected`。
- `ALLOWED_VISIT_TRANSITIONS[REJECTED] = []`（**已声明**，F13）⇒ 这条 Visit **不得**再被
  confirm / reject / reassign / reschedule / cancel **任何**动作改动。守卫直接复用 `canVisitTransition()`。
- **但历史必须一直可读**：I11 仍能读到这条 `REJECTED` Visit 的回执与照片，
  照片仍可经 I14 取到 —— **P6-0 的 O1 已经证过同类形态**（本店历史 Visit 照片 200）。
  ⇒ P6-1 **不新增**任何"驳回后隐藏"的逻辑，也**不放宽**任何东西。

### 4.3 「驳回 ≠ 改派」——必须写死

> **驳回只做一件事：把 Ticket 推回 `PROCESSING`，把这条 Visit 判定为终态。**
> **它不新建 Visit、不改派、不重发师傅 Token、不吊销任何东西。**

为什么必须写死：`docs/STATE-MACHINE.md` §7 的模型口径是
「**只要执行责任人发生变化，就新建一条 Visit**」。驳回时**责任人并没有变化** ——
是"这次作业不被接受"。把驳回实现成"顺手改派"会引出两个后果：
① 主管没批准的新师傅**凭空出现**在工单上；② 被驳回的 Visit 历史被覆盖（**不可事后重建**，F13 注释原话）。

**"重新上门"由门店随后显式决定** —— 走 `M3 dispatch`（新建 Visit，`visit_no+1`）或
`M4 reassign`（仅在存在 `ASSIGNED` 当前 Visit 时可用）。见 §8。

---

## 5. Q3 —— 并发：**沿用条件 UPDATE**，loser 由"影响行数 = 0"决定

### 5.1 范式裁定（基于 F1 的取证）

> **P6-1 不使用 `SELECT ... FOR UPDATE`。** 本项目**全仓 0 处**使用行锁（F1），
> 既有并发控制一律是 **「条件 UPDATE + 影响行数判断」** + **唯一索引兜底**。
> 引入一种新的并发范式会让**两套机制在同一批数据上并存** —— 这正是最难排查的一类不一致。

### 5.2 事务内顺序（与 M8 `technicianSubmit` 同范式：**把最可能失败的放在最前**）

```
T1  Visit 条件迁移（原子，lossless 的胜负判定点）
    UPDATE service_visits
       SET visit_status='CONFIRMED'|'REJECTED',
           store_confirm_status=derivedConfirmStatus(...),
           confirmed_charge_amount=...,      -- confirm：见 §3.2；reject：不写
           store_confirm_note=...,
           store_confirmed_by=$actorUserId,
           store_confirmed_at=now(),
           updated_at=now()
     WHERE id=$1 AND visit_status='SUBMITTED'
    RETURNING *
    · 影响 0 行 ⇒ 抛 409 VISIT_NOT_REVIEWABLE（§5.3），**不改任何数据**

T2  Ticket 条件迁移
    UPDATE service_tickets
       SET status='WAIT_FEEDBACK'|'PROCESSING',
           completed_at=now(),               -- 仅 confirm（M9）；reject 不写
           feedback_token_hash=<sha256>,     -- 仅 confirm（§7）
           feedback_token_expires_at=...,
           feedback_token_used_at=NULL,
           feedback_visit_id=<visitId>,
           review_status='pending',
           updated_at=now()
     WHERE id=$2 AND status='WAIT_STORE_CONFIRM'
    · 影响 0 行 ⇒ 与 M8 同处置：抛 409 CONFLICT_STATE_CHANGED 并**抛出以回滚 T1**
      （F1 范式下 T1 与 T2 同事务，回滚后 Visit 回到 SUBMITTED，数据不留半成品）

T3  写 TicketEvent（§9）：confirm ⇒ store_confirmed + completed；reject ⇒ store_rejected
T4  写幂等占位行（scene + key + resource_id，response_json=NULL）——     §6
T5  写短信**待发行**（仅 confirm；事务性发件箱，status=pending）——      §7
      ↑ T1..T5 全部成功后才 COMMIT
提交后：flush 短信（§7.5）；把响应体回填幂等行（§6.3）
```

### 5.3 loser 如何返回（**用户问的就是这一条**）

| 情形 | HTTP | code | 响应体 | 是否写数据 |
|---|---|---|---|---|
| A 先点 `confirm`，B 的旧页面随后点 `reject` | **409** | `VISIT_NOT_REVIEWABLE` | 含 `current_visit_status`（实际值，如 `CONFIRMED`）与 `ticket_status` | **否**（T1 影响 0 行，事务里什么都没写） |
| 两个 `confirm` 同时到 | 同上 | 同上 | 同上 | 否 |
| 同一 `X-Request-Id` **重放**（不是并发，是重试） | **200** | — | **首次响应体逐字节一致** + 头 `X-Idempotent-Replay: 1` | 否（走 §6 幂等出口，**根本不进业务代码**） |
| 占位行已在、但响应体未回填 | **409** | `IDEMPOTENT_REPLAY_UNAVAILABLE` | 沿用既有出口（`_request.ts` `replay()`） | 否 |

**设计口径（三条，都可被机器门钉住）**：

1. **绝不 500**。并发输家是**预期**路径，不是异常。所有冲突都映射成 409 + 可行动文案。
2. **必须返回"当前真实状态"**，让 UI 能说清楚"该回执已于 X 被处理，请刷新"。
   - 这**不构成信息泄露**：调用方**已经**通过了 ④（`assertCanWriteTicket`），
     本就对这张工单有写权限，也能自己调 I11 看到状态。
   - ⚠️ 与 P6-0 的"跨店 404 与不存在 404 逐字节同形"是**两件事**：那条规则保护的是
     **未授权者**的存在性探测；这里调用方**已授权**。不要混用，也不要把 409 也做成同形。
3. **输家不写任何东西**：不写 TicketEvent、不发短信、不占幂等键（占位行在 T4，输家走不到）。

### 5.4 死锁分析（为什么这里不会死锁）

- 在 `Ticket = WAIT_STORE_CONFIRM` 的窗口里，**能写该 Ticket 的只有 confirm 与 reject**
  —— `cancel`（M7：仅 NEW/PROCESSING）、`transfer`（M6：仅 NEW/PROCESSING）、
  `dispatch`（M3：NEW/PROCESSING）、`reassign`/`reschedule`（M4/M5：要求存在 `ASSIGNED` Visit，
  而此窗口只有 `SUBMITTED`）**全部被状态门槛挡在事务之外**。
- 而 confirm 与 reject **争抢的是同一行 Visit**（同一事务里先 UPDATE 它）⇒
  两者在 **T1 上串行化**，落败者的后续步骤根本不会执行。
- ⇒ 不存在"A 持 Visit 等 Ticket、B 持 Ticket 等 Visit"的环。
- **仍保留的规则**（防守性，因为将来可能有人在窗口内加动作）：**锁序统一为 Visit → Ticket**，
  与 M8（Visit → Token → Ticket → 事件）一致。参见 `docs/STATE-MACHINE.md` §4。

---

## 6. Q4 —— I12 / I13 幂等

### 6.1 scene：**两个动作必须各有一个**（F3 + DEV-58 口径）

```
INTERNAL_WRITE_SCENE.CONFIRM = 'svc_confirm'      ← 新增
INTERNAL_WRITE_SCENE.REJECT  = 'svc_reject'       ← 新增
```

> **为什么不共用一个 scene**（`constants.ts` 对 DEV-58 的原始论证，直接适用）：
> scene 是幂等键的**第一维**。共用时，同一个 `X-Request-Id` 被误用到另一个动作上
> （前端重试 bug 把"驳回"的重放打到了"确认"），后到者会**直接回放成前一个动作的结果** ——
> 客户端拿到 200，**库里却做了另一件事**。这是最难查的一类"成功了但没生效"。
>
> ⚠️ 同时修正 `docs/PHASE-6.md` §7 的「`IDEMPOTENCY_SCENE.STORE_CONFIRM`（已预留）」：
> 那是**公开/技师侧**的 scene 表（F3），svc 入口**不该**用它。该常量保持**未被使用**
> （与 `TECHNICIAN_SUBMIT` 同样"只是曾计划过"的痕迹）。

### 6.2 幂等键：**加一维 `visitId`**

| 现状（F3） | P6-1 |
|---|---|
| `${ticketId}:${actorUserId}:${requestId}` | `${ticketId}:${visitId}:${actorUserId}:${requestId}` |

- 实现方式：给 `writeIdempotencyOf()` 加**可选** `visitId`；传了就把它插进去，**不传时行为逐字节不变**
  （既有 6 个动作零改动、零回归）。
- **为什么必须加**：一张工单可以有多条 Visit（改派/驳回后重派都会新建）。
  若键里只有 ticketId，客户端**复用同一个 `X-Request-Id` 去 confirm 第二条 Visit** 时，
  会**静默回放第一条的响应** —— 正是 §6.1 那段要防的错。
  加上 `visitId` 后，这种误用会落到**真实的 409/业务校验**上，而不是静默成功。
- 三维以上的语义不变：`actorUserId` 仍必须在（响应对首次操作者做过脱敏）；
  `requestId` 仍负责区分"重试"与"又一次操作"。

### 6.3 重放语义（三条，与既有机制一致）

| 情形 | 行为 |
|---|---|
| **串行重放**（第一次已提交，客户端重试同号） | `runIdempotentWrite` 的**前置查表**命中 ⇒ 直接回放首次响应（`X-Idempotent-Replay: 1`），**不重复发短信、不重复生成 Token** |
| **并发重放**（两请求同时到） | 后到者 INSERT 占位行撞 `idempotency_records(scene, idempotency_key)` 唯一索引 ⇒ 事务**整体回滚**（它建的占位/事件全部消失）⇒ 重读并回放 |
| **换号重放**（同一个 Visit，新的 `X-Request-Id`） | **这不是重放，是第二次操作** ⇒ 走业务校验 ⇒ `409 VISIT_NOT_REVIEWABLE`（Visit 已不是 `SUBMITTED`） |

**响应体与幂等键的两条硬约束**：

1. **`response_json` 绝不能包含评价 Token 明文或评价链接**（F14）。它是**长期留库并被回放**的，
   把活链接写进去等于把客户的一次性入口存进一张平时没人看的表。
2. **`responseOf()` 必须裁剪**：只回白名单字段（§9.2），**不回** Visit/Ticket 的全量行
   （全量行会带出 `access_token_hash`、脱敏前的手机号等）。

### 6.4 与"师傅提交**刻意不做**幂等"的区别（必须说清，避免被误推广）

`technicianSubmit` **刻意不接** request-id 幂等（**一次性 Token 本身就是提交边界**，
再接幂等等于把已关闭的匿名入口重新打开一次 —— `ticket-service.ts` 的长注释）。
**confirm/reject 完全不同**：它们是**已登录的内部写动作**，`X-Request-Id` 是唯一的重试判据，
且副作用（**生成评价 Token + 发短信**）在状态上**不留痕迹** —— 正是"必须幂等"的典型形态。
⇒ 不要因为"提交没做幂等"就推断"审计类动作也不用做"。

---

## 7. Q5 —— confirm → `WAIT_FEEDBACK`：评价 Token / 短信边界

### 7.1 进入 `WAIT_FEEDBACK` 的**完整**副作用清单（M9）

| # | 副作用 | 落在 | 时机 |
|---|---|---|---|
| 1 | Ticket `WAIT_STORE_CONFIRM → WAIT_FEEDBACK` | T2 | 事务内 |
| 2 | Visit `SUBMITTED → CONFIRMED` + `confirmed_*` | T1 | 事务内 |
| 3 | `Ticket.completed_at = now()` | T2 | 事务内 |
| 4 | **评价 Token 生成 + 入库哈希** | T2 | **事务内** |
| 5 | 事件 `store_confirmed` + `completed` | T3 | 事务内 |
| 6 | 幂等占位行 | T4 | 事务内 |
| 7 | **评价短信 `pending` 行入队** | T5 | **事务内**（事务性发件箱） |
| 8 | **实际调供应商发短信** | — | **提交之后** |

> **4 与 8 必须在事务两侧**：Token 哈希入库要**与业务写同事务**（否则"确认成功但没有 Token"
> 或"有 Token 但没确认"都可能出现）；而**调供应商必须等提交**（Phase 4 口径：
> 短信失败**不回滚**业务，`accepted ≠ delivered`）。

> 🔒 **【冻结口径 · 用户 2026-09-25 正式确认，从"契约推荐"升格为冻结决定】**
> ① Review Token **hash + expiry** 与 confirm 的业务写入**同一数据库事务**；
> ② 若确需发送，SmsLog/outbox **同事务入队**（事务性发件箱）；
> ③ **任何外部 SMS provider 调用只能发生在 commit 之后**；
> ④ 短信失败**不得回滚**门店确认（`accepted ≠ delivered`）；
> ⑤ **结合 O1-B**：P6-1 的评价邀请**不产生**待发送的 SmsLog/outbox 行 ——
>    **禁止为未来短信预造一条永远 `pending` 的脏数据**；等评价 H5 上线且发送开启后，
>    在**对应的发送动作**里创建 SmsLog。
> ⇒ 一句话："**状态提交成功**"与"**外部 SMS 发送成功**"**不构成**一个不可分割事务；
>    Token / outbox 可随业务事务落库，外部发送**必须 after-commit**。

### 7.2 Token 生成口径（复用既有算法，不新造）

| 项 | 值 |
|---|---|
| 明文 | `crypto.randomBytes(32).toString('base64url')`（与 `docs/STATE-MACHINE.md` §5 一致） |
| 入库 | `serviceTickets.feedback_token_hash = sha256(明文)`（**只存哈希，明文不入库**） |
| 有效期 | `feedback_token_expires_at = now() + feedback.token_expire_days`（**从 `systemSettings` 读，默认 15，不写死**，F11） |
| 关联 | `feedback_visit_id = <本次 Visit id>` |
| 状态 | `review_status = 'pending'`；`feedback_token_used_at = NULL` |
| 对外链接 | ~~需先定义（F10）~~ ⇒ **已冻结**：`{PUBLIC_BASE_URL}/f/{token}`，见 **§11.3**（**路由不提前实现**） |
| ⚠️ Token 形制的事实来源 | **Review Token 有自己的常量**（算法/长度/字符集），**不得**沿用 `TECHNICIAN_TOKEN.*` 或"假定同为 43 字符"。若二者最终一致，由**门禁证明"当前"一致**，不靠人脑推定（§11.3 末条） |

### 7.3 Token 明文的**生命周期边界**（五条"不得"）

明文只允许出现在**两个地方**：本次请求内存、**短信参数里**（那是它的用途）。
**不得**：

1. 写入任何**日志**（含 `logger.info/warn/error` 与 `error.stack`）；
2. 写入 `TicketEvent.metadata`（事件是给门店/客服看的，不是给链接用的）；
3. 写入**幂等记录的 `response_json`**（F14 / §6.3）；
4. 经 **I11 读模型**回给后台（P6-0 的字段白名单已经不含它，**P6-1 不要开这个口**）；
5. 出现在**确认响应体**里（响应会被缓存 + 回放 ⇒ 等价于 (3)）。

> ⚠️ 明文**会**进入 `sms_messages` 的参数（这是设计使然 —— 短信内容就是链接）。
> 因此既有保护必须**继续成立**：`smsOutbox` 探针（P2）是**总部特权**且
> `sms.provider ≠ mock` 时**自毁返回 404**（DEV-41）。**P6-1 不得放宽这两条**。

### 7.4 重发（I9 `resend-sms scene=review_invite`）—— **本契约暴露的第一个真实冲突**

**冲突本身**：明文 Token 不落库（§7.2），**所以"把同一条短信再发一遍"在技术上不可能**
—— 服务端手里没有任何可用于重建旧链接的东西。

⇒ 只有两种可能：

| 方案 | 行为 | 后果 |
|---|---|---|
| **(a) 重发 = 重新签发**（推荐） | 覆盖 `feedback_token_hash` + **重算** `feedback_token_expires_at`，`review_status` 保持 `pending`，**重新入队短信** | 旧短信里的链接**立即失效** ⇒ **重发按钮必须先提示"将重新生成链接，旧链接作废"** |
| (b) 重发 = 拒绝 | 回 `409`，让门店改走别的路径 | 短信发送失败后**无法补救** ⇒ 工单只能等超时 |

- **推荐 (a)**，理由：`accepted ≠ delivered`（Phase 4 口径）意味着短信失败是**正常可达**的状态，
  必须有补救手段；而 `docs/API.md` I9 已经把 `review_invite` 列进可重发场景。
- **必须同时钉死的边界**：
  - 若 `feedback_token_used_at` **非空**（客户已评价）⇒ **拒绝重发**（`409`），**不得**覆盖。
  - 若 Ticket 已不在 `WAIT_FEEDBACK` ⇒ 拒绝重发。
  - **重发不写幂等之外的任何业务状态**（不碰 `completed_at`、不碰 `review_status`）。
  - 重发**必须记事件**（`sms_sent` / 或专门的 `feedback_token_reissued` 摘要），否则"链接为什么失效"
    在时间线上查不出来。

> 🔒 **【冻结口径 · 用户 2026-09-25（O2 裁决追加的事务要求）】**
> **重新签发评价 Token 时，新 Token 建立 + 旧 Token revoke 必须原子化**：
> ① 不得出现"旧的已废、新的没落库"（⇒ 客户手里一条用不了的链接，且无任何可用替代）；
> ② 不得出现"两个同时有效"（⇒ 一次评价被提交两次 / 旧链接绕过期）。
> 实现形态：同一事务内 `UPDATE feedback_token_hash = 新哈希, feedback_token_expires_at = 新到期,
> feedback_token_used_at = NULL, review_status='pending'` —— **一条 UPDATE 覆盖即原子**，
> 不存在"先删后插"的中间态。
> ⚠️ **P6-1 的范围**：重发**只在"评价入口已正式开放"后才有实际意义** ⇒
> P6-1 **准备领域能力/契约（含上面这条原子性）**，**但不给"发送评价短信"的按钮/入口**（§11.2 条 1）。

### 7.5 短信发送失败时的状态（**合法**，不是缺陷）

- 事务已提交（Ticket 已 `WAIT_FEEDBACK`、Token 已入库）⇒ 短信 flush 失败**只影响通知**。
- 可观测性要求：`sms_messages.delivery_status` 反映真实结果；`smsRetry` 定时任务（既有）负责重试 1 次；
  仍失败 ⇒ 门店端应能看到"通知异常"（既有口径）。
- **不允许**：因为短信失败而回滚确认。**不允许**：把发送失败吞掉不留痕。

---

## 8. Q6 —— reject 之后**究竟停在哪里**等待重新处理

### 8.1 停点（一句话）

> **Ticket = `PROCESSING`，且**没有任何 `ASSIGNED` 的 Visit** ；
> 门店必须**显式**再派一次工（`M3 dispatch`）才能重新上门。**

```
WAIT_STORE_CONFIRM ──reject──▶ PROCESSING（Visit V1: SUBMITTED → REJECTED，终态）
                                   │
                                   │  ⚠️ 此刻「当前派工」是**空的**
                                   ▼
                           门店显式 M3 dispatch ──▶ 新建 Visit V2（visit_no = 2, ASSIGNED）
```

### 8.2 三条必须写死的行为（否则门店会撞上莫名报错）

| # | 行为 | 为什么 |
|---|---|---|
| **R1** | 驳回后**不能** `reassign`（M4 要求存在 `ASSIGNED` 当前 Visit ⇒ 会回 `422`） | `reassign` 的语义是"换个人，同一件事继续"；此刻没有"进行中的派工"可换。**门店要派人必须走 `dispatch`** —— 这一点必须在 **P6-2 的 UI 上体现**（驳回后按钮应从"改派"切换成"派工"），否则会变成一个说不清的错误 |
| **R2** | 驳回后 `reopen_count` **不增加** | `reopen_count` 是**评价不满意导致的重开**（M13/M15）的字段。驳回是**正常审核**，不是重开。混用会让"重开率"KPI 失真 |
| **R3** | 驳回**不**发任何短信 | `docs/STATE-MACHINE.md` M10 的副作用表里**没有短信**（只有 `store_rejected` 事件）。这是**有意的**：门店紧接着 `dispatch` 时 M3 会发客户短信，两条连发语义重复且会让客户困惑（"被驳回了/又派人了"）。若"驳回后不打算再派人"，通知责任留给 P6-2 的 UX（§11-**O3**） |

### 8.3 驳回后的"可读性"（与 P6-0 的衔接）

- 被驳回的 Visit 及其照片**永久保留、长期可读**（§4.2）：I11 + I14 仍能取到，
  门店在"处理记录"里能看到"第 1 次上门被驳回"的完整证据。
- **不新增**任何"仅显示最后一次 Visit"的过滤逻辑 —— P6-0 的 `submittedVisitOf()`
  只负责挑"**当前待审核**的那条"，历史 Visit 的展示是既有"处理记录"区块的职责。

---

## 9. 事件、可观测性与响应体

### 9.1 事件（与 M9/M10 逐条对齐）

| 动作 | 事件类型 | `operatorKind` | summary（中文） | metadata（**白名单**） |
|---|---|---|---|---|
| confirm | `store_confirmed` | `STORE` | `门店已确认：实收 ¥<confirmed>（师傅报 ¥<reported>）` / 未改额时不写括号 | `visit_id` · `visit_no` · `reported_charge_amount` · `confirmed_charge_amount` · `amount_changed`(bool) · `amount_raw`(客户端原值，§3.4) · `note_length` |
| confirm | `completed` | `STORE` | `服务已确认完成，已发送评价邀请` | `visit_id` · `feedback_token_expires_at`（**只有有效期，没有 Token / 链接**） |
| reject | `store_rejected` | `STORE` | `门店已驳回：<reason 前 40 字>` | `visit_id` · `visit_no` · `note_length` · `reported_charge_amount` |

- ⚠️ **metadata 不存 `note` / `reason` 全文**：它们在 `service_visits.store_confirm_note` 上，
  事件里再存一份就是**两份真相**（改一处忘一处必然不一致）。事件只记**长度与摘要**。
- **`from/to` 状态不得手写字面量** —— 用条件 UPDATE 的 `RETURNING` 回填（M8 的既有做法）。

### 9.2 响应体（白名单，**不含** Token / 链接 / 哈希）

```jsonc
// confirm 200
{
  "visit":  { "id", "visit_no", "visit_status", "store_confirm_status",
              "service_result", "service_note", "is_charged",
              "reported_charge_amount", "confirmed_charge_amount",
              "store_confirm_note", "submitted_at", "store_confirmed_at" },
  "ticket": { "id", "ticket_no", "status", "completed_at" },
  "review": { "token_issued": true, "expires_at": "…", "sms_queued": true }
}
// reject 200
{ "visit": { …, "visit_status": "REJECTED", "store_confirm_note": "<reason>" },
  "ticket": { "id", "ticket_no", "status": "PROCESSING" },
  "review": { "token_issued": false } }
```

- 手机号等**脱敏规则沿用 `PermissionService.maskTicketForActor`**；不要在这两个 action 里另写一套。
- **`review.token_issued` 只回布尔与有效期**，不回 Token/链接（§7.3 第 5 条）。

### 9.3 必须记的日志（排障用，且**不含**敏感值）

- 成功：`[ticket] 工单 <no> 门店<确认|驳回> visit=<id>（第 N 次）→ <新状态>，评价Token=<已签发|不涉及>`
- 冲突：沿用 `throwStateConflict` 的形态，打印"当前状态 vs 期望状态"，**不打印 Token/链接**。

---

## 10. 契约自检清单（**实现前**逐条可判 —— 每条都要有可执行的判据）

| # | 检查项 | 可执行判据 |
|---|---|---|
| C1 | 两个 action 已接线（`SVC_ACTION` + `AUTHENTICATED_SVC_ACTIONS` + `handlerSets`） | `verify-config` / `verify-plugin-load` 计数增加且不红 |
| C2 | **nginx 重写顺序**：两段式路径排在 I11 之前 | 新增 preflight 或脚本用例：`POST /api/svc/visits/:id/confirm` 必须落到 `visitConfirm`（**不是** `visitDetail`）；**故意调换顺序必须变红**（反向验证） |
| C3 | 匿名 → 401；`viewer` → 403；跨店 → 404（与"不存在"同形） | 新增 `verify-store-review-write.mjs` 的四边界矩阵（**含反向**） |
| C4 | 缺 `X-Request-Id` → 422 `VALIDATION_FAILED` | 脚本单例 |
| C5 | Visit 白名单 4 列 + Ticket 白名单 4 列**已加入**（F4/F5） | 若未加，写库会抛"列不在白名单" ⇒ 正向用例直接红（这条**自带**反向） |
| C6 | 金额 4 种非法输入（缺/≤0/超上限/非收费却传正数）各回对应 422 | 逐条断言 code，**不只断状态码** |
| C7 | 改额未填 note → 422 `MISSING_CONFIRM_NOTE` | 单例 |
| C8 | reject 缺/空白 reason → 422 `MISSING_REJECT_REASON` | 单例 |
| C9 | **并发 loser**：两个并发请求只成功一个，另一个 409 `VISIT_NOT_REVIEWABLE`，且**只产生一条事件**、**评价邀请短信恒为 0 条**（**O1-B**：不发送、不入队） | 并发脚本（参考 `verify-concurrency-phase2.mjs` 的范式）+ **库内计数**取证（不能只看响应码） |
| C10 | **幂等重放**：同号重放返回 200 + `X-Idempotent-Replay: 1`，且**评价类短信行数恒为 0**（**O1-B**）、**Token 哈希不变** | 先取快照 → 重放 → 比对（M8 R1 的既有范式） |
| C11 | `svc_confirm` 与 `svc_reject` **是两个字幕**：把 reject 的请求头误用到 confirm 上**不得**静默回放 | 跨 scene 误用用例（这条防的正是 DEV-58 类缺陷） |
| C12 | 评价 Token 明文**不出现在**：app 日志、`TicketEvent.metadata`、`idempotency_records.response_json`、I11 响应、confirm 响应 | 五个出口各一条断言（**逐出口**，不做"整体没看到"） |
| C13 | `feedback_token_hash` 入库值 = `sha256(明文)`，且**库内不存在等于明文的列** | 库内查询断言 |
| C14 | 短信失败**不回滚**确认；`delivery_status` 如实反映 | 用 mock provider 造一次失败 |
| C15 | **reject 后**：Visit 终态、照片仍全量可读（I11/I14）、`reopen_count` 未变、**未发短信**、Ticket=PROCESSING 且**无 ASSIGNED Visit** | 库内快照 + I11 复查 |
| C16 | **reject 后 `reassign` 必须失败**（回 422，不是 500） | 单例（R1） |
| C17 | 逆向：把"评审对象"从 Visit 改成 ticket id（故意写坏）⇒ C2/C9 之一**必须红** | 反向验证，证明判据有区分力 |
| C18 | 停止线：`grep` 确认**没有**评价提交（M12/M13）与 `CLOSED` 写路径 | 与 P6-0 §⑦ 同法 |
| **C19** | **O1-B**：P6-1 **不存在**"发评价短信"的代码路径（不靠配置纪律，靠**没有调用点**） | 结构断言（扫 `scene='review_invite'` 的发送入口 = 0）+ **反向**（植入一个发送调用必须变红） |
| **C20** | **O1-B**：confirm 之后库内**评价类 `SmsLog` 行数 = 0**（**不为未来预造永远 `pending` 的行**） | 库内 `count(*) where scene='review_invite'` 断言为 0（confirm 前/后都查） |
| **C21** | **Review Token 常量独立**：长度/字符集/算法由**它自己的常量**定义；若与师傅侧最终同为 `randomBytes(32)→base64url`，由**门禁证明"当前"一致** | 脚本断言 `REVIEW_TOKEN.PATTERN` 与 `/f/` 正则（未来）/ 与师傅侧 `PATTERN` 的一致性；**禁止**在实现里硬编码"43"或从 `TECHNICIAN_TOKEN.*` 取值 |
| **C22** | **金额语义（L3）**：不收费 ⇒ `confirmed_charge_amount` 落 **`NULL`**，**不是 `0.00`**（O4/O5 配套）；收费时按 §3.2 分叉 | 库内 `IS NULL` 断言 + 反向（把 `NULL` 写成 0 必须变红） |
| **C23** | **故障注入（L2 + §11.7）**：在"Review Token 已生成、**hash+expiry 已写、Event/幂等尚未写**"这一刻**强制事务失败** ⇒ **Visit / Ticket / Token 字段 / Event / 幂等行**全部无半写 | 注入钩子（测试专用）+ 前后库内快照比对。**泄漏面按 §11.6 条 4 扫全五处**：`TicketEvent.metadata` / 幂等 stored response + payload / 应用日志（含 error）/ `SmsLog` / HTTP 响应体 |
| **C26** | **真并发三组（§11.8）**：confirm×confirm / confirm×reject / reject×reject **同时**发出 ⇒ 每组**恰好一个 winner**，loser **409 + DB 最终真实状态**，且**只有一套** winner 的 Event/Token/幂等副作用 | 并发脚本（Promise.all 真并发，**禁止**串行模拟）+ **库内计数**取证，不能只看响应码 |
| **C24** | **幂等 `visitId` 参与冲突判定（L5）**：同 `actor+scene+request-id` 下，**同 visitId ⇒ replay**、**不同 visitId ⇒ conflict**（不得回放旧 Visit 结果） | 三条用例：同 Visit 重放 / 跨 Visit 同号 / confirm 与 reject 互换 scene（**均不得互相命中**） |
| **C25** | **金额由 Visit 的服务事实约束（L3）**：`is_charged=false` 却**偷偷传 amount** ⇒ **422 拒绝**（**不是静默忽略**）；`> 99999.99` ⇒ 422 | 逐条断言 code；反向（改成"忽略"必须变红） |

---

## 11. 开放项 —— ✅ **已全部裁决（用户 2026-09-25），本节定稿**

> ~~待用户裁决~~ ⇒ **7 项 O1~O7 已逐项拍板，见 §11.1**。
> **下表（原"选项 + 推荐"）按项目惯例保留原文不改**，用于追溯"当时为什么这么推荐"；
> **以 §11.1 的裁决为准**（其中 **O1 由推荐 A 改判 B**，理由见 `docs/DEVIATIONS.md` **DEV-85**）。

| # | 开放项 | 选项 | 推荐 |
|---|---|---|---|
| **O1** | **评价链接的对外形状尚未定义**（F10）。P6-1 到底发不发评价短信？ | **A**：定义 `{PUBLIC_BASE_URL}/f/{token}`（与师傅侧 `/t/` 平行，nginx 302 到评价页），**照发短信**；**评价落地页在 P6-1 之后才存在 ⇒ 链接暂时打不开**，作为**已知中间态**登记 backlog ／ **B**：P6-1 生成 Token 但**不发短信**（用配置开关兜住，评价页上线时打开） ／ **C**：Token 与短信**全推迟** | **A**。理由：与 M9 契约一致（不拆契约）；`WAIT_FEEDBACK` 有真实入口；评价页上线后自然打通。**代价必须如实写进文档**：这段窗口内客户点链接打不开。**C 不可取** —— `WAIT_FEEDBACK` 会变成一个没有 Token 的中间态，`feedback_token_expires_at` 为空，M14 判据无值 |
| **O2** | 重发评价短信 = **重新签发**（旧链接失效）还是**拒绝**？ | (a) 重新签发 ／ (b) 拒绝 | **(a)**，且重发按钮必须先提示"将重新生成链接，旧链接作废"（§7.4） |
| **O3** | reject 是否发客户短信？ | 不发（现状）／ 发一条"门店已驳回、将重新安排" | **不发**（对齐 M10 副作用表）。但**若门店驳回后不打算再派人**，客户侧就没有任何信号 —— 该缺口留给 **P6-2 的 UX**（例如驳回时要求选择"是否重新派人"），**不在 P6-1 扩范围** |
| **O4** | `confirmed_charge_amount` 的业务上限 | 沿用列宽 `99,999,999.99` ／ 设 `99999.99` | **`99999.99`**（§3.4）：多一个 0 是金额字段最常见的人为错误，列宽不该当业务校验 |
| **O5** | `store_confirmed_at` 语义泛化为"**处置**时间"（驳回也写），要不要改字段名/注释？ | 改字段名（**需迁移，违反 §1.2**）／ **只改注释** | **只改注释**（§4.1）。另：`collections/serviceVisits.ts` L153 关于"不收费时 `= 0`"的注释与代码不符（F2），**一并改注释** |
| **O6** | 文档里的 `FOR UPDATE` 措辞（F1） | 全改 ／ 只改本阶段相关处 | **只改 `docs/PHASE-6.md` §4.5/§7**（本阶段范围）；`docs/STATE-MACHINE.md` §4/§7.1 是 **Phase 4 期**的措辞漂移，**范围外 ⇒ 只登记 `docs/BACKLOG.md`**，不顺手改 |
| **O7** | 幂等键加 `visitId` 维（§6.2） | 加 ／ 不加 | **加**（向后兼容的可选参数；把"静默错误回放"变成真实冲突） |

### 11.1 裁决记录（用户 2026-09-25 —— **P6-1 契约据此定稿**）

| # | 裁决 | 冻结口径 |
|---|---|---|
| **O1** | **B**（⚠️ **偏离推荐 A**，理由见 `docs/DEVIATIONS.md` **DEV-85**） | confirm **照常生成并入库**评价 Token（只存 hash + `feedback_token_expires_at`），但 **P6-1 不发送评价短信、不创建评价邀请 SmsLog**；评价入口正式上线后**才**接入发送路径 |
| **O2** | **(a) 重新签发** | 重发 = 重新签发 Token，旧 Token **立即失效**；**新 Token 建立 + 旧 Token revoke 必须原子**（不得出现"旧的已废、新的没落库"，也不得两个同时有效）；UI 必须先明确提示"将重新生成链接，旧链接作废"。且**重发动作只在评价入口正式开放后才有意义** —— P6-1 准备领域能力/契约，**不给发送死链的按钮** |
| **O3** | **不发** | reject **不发**客户短信；"驳回后客户侧无信号"的缺口留 **P6-2 UX**，**不在 P6-1 扩范围** |
| **O4** | **`99999.99`** | `confirmed_charge_amount` 业务上限固定 **¥99,999.99**（列宽不作业务校验）。**继续坚持 §3.2/§3.3 的分叉**：**`NULL` 与 `0.00` 语义不同** —— 不收费落 **`NULL`**，不得被"偷换成 0" |
| **O5** | **只改注释** | 不做迁移/不改字段名（`store_confirmed_at` 语义泛化为"处置时间"仅改注释）；一并修正 `collections/serviceVisits.ts` L153"不收费时 `= 0`"的**错误注释**（F2） |
| **O6** | **只改本阶段文档** | 只改 `docs/PHASE-6.md` §4.5/§7；`docs/STATE-MACHINE.md` §4/§7.1 属 **Phase 4 期**措辞漂移，**只登记 `docs/BACKLOG.md` B-12，不顺手改** |
| **O7** | **加 `visitId`** | 幂等键纳入 Visit 维（向后兼容的可选参数）—— 避免同一 `request_id` 在**错误的 Visit** 上静默 replay |

### 11.2 O1-B 的**收紧**：P6-1 不得存在"误发死链"的运行路径

> 用户在 O1-B 上进一步收紧，不只是"把开关设成 false"。

| 条 | 冻结口径 |
|---|---|
| 1 | **P6-1 不接入评价邀请的发送路径**：代码里**不存在**"发评价短信"的调用点 ⇒ 管理员把任何配置改成 true 也发不出去（不是靠配置纪律，是靠**没有代码路径**） |
| 2 | 将来接入时的发送资格是**双闸门 AND**：`feedback_sms_enabled` **AND** `feedback_h5_ready`；其中 **`feedback_h5_ready` 不得由普通后台设置提前打开**（评价 H5 真正交付前它恒为 false） |
| 3 | **不为未来短信预造 `pending` 行**：P6-1 的评价邀请**不产生**任何 SmsLog/outbox 行 —— 禁止制造"永远 pending"的脏数据；等评价 H5 上线、发送开启时，在**对应发送动作**里创建 |
| 4 | **门禁**：实现完成后必须有断言证明"P6-1 内不存在评价短信发送路径 / 不产生评价 SmsLog"（写进 §10 清单） |

### 11.3 `/f/{token}` —— 对外契约**现在冻结**，路由**不提前实现**

| 项 | 冻结口径 |
|---|---|
| 形状 | 未来评价入口 = **`{PUBLIC_BASE_URL}/f/{token}`**，与 `/t/{token}` 同取**稳定外部短链**原则 |
| 跳转 | **302**（**禁止 301**：会被客户端长期缓存，与目标可变相冲突）；相对 Location + `absolute_redirect off` |
| Token 形制 | **严格 token shape 校验**；非法/畸形路径 **404**（兜底用普通前缀 location，**不用 `^~`** —— 否则合法链也被吃掉） |
| 日志 | **token URL 不得进入 access log** |
| 上线时机 | **route + 评价 H5 + SMS 发送开关三者同时上线** ⇒ **不存在"302 到一个不存在的页面"的中间态** |
| ⚠️ 事实来源 | **不许因为 `/t/` 当前恰好是 43 字符就假定 Review Token 与 Technician Token 永远相同**。Review Token 的**长度/字符集/生成算法必须由它自己的常量**定义并成为 `/f/` 的事实来源；若最终同样是 `randomBytes(32) → base64url`（= 43 chars），则**由门禁证明二者"当前"一致**（`PATTERN` 与 nginx 正则一致），而不是靠人脑"应该一样" |

### 11.4 事务语义的**五个锁点**（用户 2026-09-25 —— 防"代码看着对、事务语义已漂"）

| # | 锁点 | 冻结口径 |
|---|---|---|
| **L1** | **409 loser 是业务冲突，不是幂等 replay** | 两个员工对同一 `SUBMITTED`/待审 Visit 操作时：第一个成功；第二个**条件 UPDATE 影响行数 = 0** ⇒ **重读真实状态**并回 **409**。⚠️ **不得**因为第二个请求"恰好也是 confirm"就包装成"已经确认 ⇒ 算成功"。**只有相同幂等键的合法 replay** 才返回首次的原始成功结果 |
| **L2** | **Review Token 的位置：晚于全部前置校验、早于 commit，失败完全回滚** | Token 生成/写入排在**所有业务校验之后**、`COMMIT` **之前**，与业务写**同事务** ⇒ 任一步失败 ⇒ **Visit / Ticket / Token 字段 / Event / 幂等行**全部无半写。**必须有 fault injection 门**（§10 **C23**）：在"Token 已生成、正要写入"之后**强制事务失败**，证明库内零残留。另：**随机明文 Token 不得进入 `TicketEvent.metadata` / 日志**（§7.3 五条"不得"） |
| **L3** | **金额分叉由 Visit 的**服务事实**约束，不是只验请求金额** | `is_charged = false` ⇒ `confirmed_charge_amount = NULL`；客户端**偷偷传 amount** ⇒ **422 拒绝**（**不是静默忽略** —— 忽略会让"前端传了但没生效"变成无信号的静默分歧）。`is_charged = true` ⇒ **必须提供**；`0.00` 是否允许**按 §3.2 契约执行**；`> 99999.99` ⇒ 422。⇒ C22 要证明的是"**服务端据 `is_charged` 定夺**"，而不是"UI 恰好没传 0.00" |
| **L4** | **reject 与 Review Token 彻底解耦** | reject 成功 ⇒ Visit=`REJECTED` + Ticket=`PROCESSING` + **无 active `ASSIGNED` Visit**；**不得**生成/刷新 feedback token、**不得**增 `reopen_count`、**不得**产生评价 SmsLog、**不得**偷偷创建下一条 Visit。下一次派工**仍由正常 `dispatch` 明确触发** |
| **L5** | **幂等记录里的 `visitId` 参与**冲突判定**，不只是审计字段** | 同一 `actor + scene + request-id`：**同 `visitId` + 同业务请求 ⇒ replay**；**不同 `visitId` ⇒ conflict**（**不得**回放旧 Visit 的结果）。且 confirm/reject **是两个 scene** ⇒ 同一个 request-id 分别用于二者**不得互相命中** |

> **验收纪律（用户点名）**：第 2 片结束时**即使后台一个"确认/驳回"按钮都没有**，
> 只要 I12/I13 的**领域事务 / 权限 / 并发 / 幂等 / 反向门禁**真正成立，就是一个**干净的机器验收点**。
> ⇒ **不许**用"按钮能点"当 P6-1 的成功证据；先交**事务矩阵**及其
> **fault / concurrency / idempotency** 三类证据。

### 11.5 用户确认"不另开设计"的两块（原样冻结，不重新设计）

| 块 | 冻结口径 |
|---|---|
| **并发 loser** | confirm/reject → **条件 UPDATE** → **affected rows = 0 ⇒ loser** → 返回 **409 + 当前真实状态**（已授权调用方，不适用 P6-0 的"同形 404"）→ **绝不覆盖 winner** 的写入 |
| **reject 后返工** | Visit = `REJECTED`；Ticket = `PROCESSING`；**active `ASSIGNED` Visit = none**；**`reopen_count` 不增加**；下一步是**新的 `dispatch`**，**不是**对已 `REJECTED` 的 Visit 做 `reassign`（`reassign` 会 422）—— **"驳回 ≠ 改派"继续保持** |

---

### 11.6 Review Token 的**生命周期与泄漏面**（用户 2026-09-25 追加）

| 条 | 冻结口径 |
|---|---|
| 1 | **明文只活在本次 confirm 调用的内存里**；数据库**只保存 hash**（`feedback_token_hash`） |
| 2 | **I12 的成功响应不含评价 Token / 链接** —— 只回业务结果（Visit / Ticket 当前状态等） |
| 3 | **幂等 response 同样不含明文** ⇒ replay **不需要**"重新获得"原 Token，也就**不会诱导**把明文塞进 `idempotency_records.response_json`。P6-1 本就不发短信、不返链接，所以幂等响应里**没有任何理由**出现它 |
| 4 | **C23 的泄漏检查不能只扫 `TicketEvent.metadata`**，至少覆盖本次请求对应的五处：**① `TicketEvent.metadata` ② 幂等 stored response / payload ③ 应用日志（含 error 日志）④ `SmsLog` ⑤ HTTP 响应体** —— 任一处出现明文即红 |

### 11.7 **事务顺序**（用户 2026-09-25 追加，冻结）

```
所有输入 / 权限 / 状态 / 金额校验        ← 全部在事务外先做完
        ↓
进入核心事务
        ↓
条件推进 Visit（confirmVisit / rejectVisit，影响行数 0 ⇒ loser）
        ↓
推进 Ticket
        ↓
生成 Review Token（明文进内存，hash 待写）
        ↓
写 hash + expiry
        ↓
★ C23 故障注入点 ★
        ↓
写 Event + 幂等记录
        ↓
COMMIT
```

> Event / 幂等两步的先后可随既有事务框架调整；**关键不是机械顺序，而是故障点触发时，
> 上述所有业务副作用仍属于同一个未提交事务** ⇒ 一旦注入失败，**整体回滚零残留**。

### 11.8 并发验收必须是**真并发**（用户 2026-09-25 追加）

| 组 | 判据 |
|---|---|
| confirm vs confirm | 恰好**一个** winner；另一个 **409 + 数据库最终真实状态** |
| confirm vs reject | 同上 |
| reject vs reject | 同上 |
| 共同 | 最终**只能有一套** winner 对应的 Event / Token / 幂等副作用；**不得用串行脚本模拟并发**（必须真正同时发出） |

---

## 12. 明确**不做**（P6-1 停止线）

- ❌ **不做**评价落地页 / 评价提交（M12 / M13）· ❌ **不做** `CLOSED`（M14 超时关闭 / M15 总部重开）。
- ❌ **不发送**评价邀请短信、**不创建**任何评价类 `SmsLog`/outbox 行（**O1-B + §11.2 条 1/3**）——
  **不能为未来短信预造一条永远 `pending` 的脏数据**。
- ❌ **不实现** `/f/{token}` 的 nginx route（对外契约已**冻结**于 §11.3；
  **route + 评价 H5 + 发送开关三者同时上线**，避免"302 到不存在页面"）。
- ❌ **不做**"重发评价短信"的按钮/入口（**O2**：领域能力与原子性可备，**入口不给** ——
  评价入口开放前它没有实际意义）。
- ❌ **不做**审核 UI 的完整 UX（含"驳回后按钮切换"）—— **那属 P6-2**；P6-1 只到"接口可用 + 可被脚本验证"。
- ❌ **不新增**任何数据列、**不做**任何迁移（`docs/PHASE-6.md` §1.2）。
- ❌ **不动** P6-0 的任何读实现（用户 2026-09-25 明确：不为关闭 P6-0 改已通过的实现）。
- ❌ **不动** P6-0 建立的照片访问四边界与 `NATIVE_FORBIDDEN_RESOURCES`。
- ❌ **不做** `remoteComplete`（M11）—— 它与 M9 共用评价 Token 逻辑，但入口不同，属后续阶段。

---

## 13. 与其它文档的关系

- 上游：**`docs/PHASE-6-P6-0-EVIDENCE.md`**（P6-0 🟢 PASS，基线 `0d45b09`）。
- 纲要：`docs/PHASE-6.md` §7（本契约取代其"预计"口径；§7 的两处漂移见 F1/F3）。
- 状态机：`docs/STATE-MACHINE.md` **M9 / M10** + §4（并发与幂等）+ §7（Visit 生命周期）。
- 接口：`docs/API.md` **I12 / I13**（含角色矩阵）+ I9（`resend-sms scene=review_invite`）。
- 数据：`docs/DATA-MODEL.md` §4（Visit 的 `store_confirm_*` / `confirmed_charge_amount`）·
  §5（Ticket 的 `feedback_*`）。
- 安全：`docs/SECURITY.md`（Token 只存哈希；`smsOutbox` 的自毁闸 DEV-41）。
- 工程铁律：`docs/ENGINEERING-RULES.md`（正例必配反例；不得存在"只会变绿的断言"）。
