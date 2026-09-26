# Phase 7 —— 客户评价闭环（短契约）

> **状态：🔒 语义冻结（2026-09-26）· 冻结后直接纵向实现，不再逐片审批。**
> 上游：**Phase 6 🔒 CLOSED / PASS —— closure 基线 `18fd59b`**；起点 = `WAIT_FEEDBACK`。
>
> 本文**刻意写得短**。它只冻结**真正危险的语义**（7 类 + 存量 backfill）；
> 页面样式、星级组件、普通文案、按钮显隐**不建契约、不建重型门禁**。
>
> 冻结口径一旦写下，实现阶段**只按本文执行**；发现本文与代码冲突时，
> 沿用本项目铁律：**先回代码取证，再决定改代码还是改文档**，并在本文标注。

---

## 0. 闭环与终态一览

```
WAIT_FEEDBACK
   │  ①confirm 事务内 enqueue review_invite 短信（after-commit flush）
   ▼
短信 /f/{明文Token}  →  302  →  /h5/customer/review/{明文Token}
   │  ②匿名 GET 取最小上下文 → ③POST 提交评价
   ▼
┌─────────────────────────────── 唯一终局（二选一）───────────────────────────────┐
│ submit 赢（客户先提交）                                                        │
│   rating ≥ 3 且 charge_match ≠ mismatch  → CLOSED   + review_status=submitted   │
│   rating ≤ 2 或 charge_match = mismatch  → PROCESSING + escalated + reopen_count+1│
│ expiry 赢（超时任务先跑）                                                       │
│   → CLOSED + review_status=expired                                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

**不变式**：任一 Ticket 的 `review_status` **不可能同时**为 `submitted` 与 `expired`；
`review_status` 一旦离开 `pending`，**永不回退**（reopen 也不回退到 pending —— 见 §6）。

---

## 1. ★ 冻结项：review submit × review expiry 竞争（**先冻结的第一条**）

### 1.1 判 winner 的唯一机制

**数据库条件更新 + 影响行数**（沿用本项目并发范式；**任何地方都不用行锁**）。

两条路径的 WHERE 谓词**完全相同**：

```sql
WHERE id = $1 AND status = 'WAIT_FEEDBACK' AND review_status = 'pending'
```

- `affected rows = 1` ⇒ **winner**
- `affected rows = 0` ⇒ **loser**

> 实现约束：现有 `conditionalUpdate()` 只支持 `fromStatuses`（匹配 `status`）。
> **本阶段为它加一个闭集开关 `requireReviewPending?: boolean`**，
> 追加 `AND review_status = 'pending'`。
> ⚠️ **不接受自由 SQL 片段**（防注入面）；只允许这个布尔开关。

**为什么必须这样**：「先 SELECT 查状态再 UPDATE」在两个请求同时到达时，
两边都读到 `pending`，两边都写 —— 这正是本项要排除的缺陷。

### 1.2 submit 赢（客户先提交）

**单个事务内**完成，顺序固定：

| # | 动作 | 说明 |
|---|---|---|
| 1 | 条件推进 **Ticket**（§1.1 谓词） | 写 `status`、`review_status='submitted'`、`rating`、`review_comment`、`reviewed_at=now()`、`feedback_token_used_at=now()`；按 §6 写 `closed_at`/`close_reason` 或 `escalated`/`reopen_count` |
| 2 | 条件推进 **Visit** | 写 `customer_charge_match`、`customer_reported_amount`、`charge_diff_reason`（见 §5）；谓词 `id = feedback_visit_id` |
| 3 | 写 **TicketEvent** | `reviewed`（`EVENT_TYPE.REVIEWED`，已存在）；若 reopen 再加 `reopened`（`EVENT_TYPE.REOPENED`） |
| 4 | commit | — |

- Ticket 更新 **0 行 ⇒ 整个事务回滚**，按 §4 给 loser 响应；**Visit / Event 一行都不许落**。
- 因此 Visit 与 Event 的写入必须**排在 Ticket 条件更新之后**（先判 winner 再写副作用）。
- ⚠️ 副作用一致性：Visit 更新也要带**幂等谓词**，防「Ticket 赢了但 Visit 已被改」——
  用 `WHERE id = $1 AND (customer_charge_match IS NULL)`；0 行 ⇒ 抛错回滚（这是数据异常，不是 loser）。

### 1.3 expiry 赢（超时任务先跑）

```
UPDATE service_tickets
   SET status='CLOSED', review_status='expired',
       closed_at=now(), close_reason='review_timeout', updated_at=now()
 WHERE id = $1 AND status='WAIT_FEEDBACK' AND review_status='pending'
```

- `affected rows = 1` ⇒ 写 `review_expired` TicketEvent。
- `affected rows = 0` ⇒ **幂等 no-op**：
  - **不是系统错误**，不抛异常、不写 error 日志（写 debug/info）。
  - 返回 `{ outcome: 'skipped', reason: 'already_submitted' | 'already_expired' | 'not_pending' }`。
  - reason 由**一次只读查询**得出（**不用于决策**，只用于日志与统计 —— 与
    `throwStateConflict()` 的既有做法同构）。

### 1.4 loser 的响应（提交侧）

submit 拿到 `affected rows = 0` 后，**只读一次**当前状态，映射为稳定业务错误：

| 库内实际 | HTTP | code | 语义 |
|---|---|---|---|
| `review_status='expired'` | **410** | `REVIEW_EXPIRED` | 评价窗口已过期关闭 |
| `review_status='submitted'` | **409** | `REVIEW_ALREADY_SUBMITTED` | 已经提交过评价 |
| 其它（如 `status` 已离开 `WAIT_FEEDBACK`） | **409** | `REVIEW_NOT_AVAILABLE` | 当前不可评价 |

**绝不**把 `expired` 的 Ticket 改回 `submitted`，**绝不**因 loser 触发 reopen。

### 1.5 真并发必须被证明

门禁 **F**：同一条 Ticket 上 `submit` 与 `expire` **用 `Promise.all` 同时发起**（不是串行），断言：

1. 恰好一个 winner（`submitted` 与 `expired` 互斥）；
2. 库内**不存在**「`rating` 已写但 `review_status='expired'`」这类混合态；
3. 副作用各只一套（TicketEvent 数、`feedback_token_used_at`）；
4. loser 的返回码符合 §1.4（submit 侧）或 §1.3（expiry 侧）。

---

## 2. 匿名 Review Token

| 项 | 冻结值 |
|---|---|
| 形状 | **`REVIEW_TOKEN`**：32 bytes 密码学安全随机 → base64url，长度 43，`{[A-Za-z0-9_-]}`；**与 `TECHNICIAN_TOKEN` 完全独立**（各自常量、各自 `LINK_PATH`） |
| 外链路径 | **`/f/{token}`**（`REVIEW_TOKEN.LINK_PATH = '/f/'`） |
| 存储 | 库里**只有 SHA-256 hash**（`service_tickets.feedback_token_hash`） |
| 有效期 | `feedback_token_expires_at`（confirm 时按 `feedback.token_expire_days` 播种） |
| 一次性 | `feedback_token_used_at`（提交成功时 `now()`） |
| 归属 Visit | `service_tickets.feedback_visit_id`（收费核对取该 Visit 的事实） |

**明文 Token 不得出现的 5 个持久化/外发面**（门禁 G 逐面扫描）：
`TicketEvent.metadata` · 幂等 payload/response · `sms_logs` 各列 · 后台 API 响应 · 应用日志。

> ⚠️ **已知且刻意保留的唯一例外（必须在门禁里如实表达，不得隐藏）**：
> `sms-provider.ts` 的 **mock** provider 会把渲染后的短信正文写进日志，正文含 `/f/{明文Token}`。
> 这是 Phase 5 师傅 Token 的既有形状，且**只在 mock 通道**（真实通道不打印正文）。
> **Phase 7 处理**：给 mock provider 的日志行加**链接脱敏**（把 `/f/<token>`、`/t/<token>`
> 的 token 段替换为 `***`），使「明文不进日志」成为**真的成立**而不是"差一行"。
> 该改动**只动日志卫生，不动任何业务语义**。
>
> 另：`dispatch.ts` 的 `smsOutbox` 探针会**故意**回传 `preview`/`params`（含明文链接）——
> 它**只在 mock 通道 + 总部角色**下可达，是既有的受审计调试口，**保留**。

**匿名查找链**：明文 Token → `sha256` → 命中 `feedback_token_hash` → 得 Ticket。**没有别的入口。**

---

## 3. 一次性提交与并发（submit × submit）

- 同一 Token 的两个并发提交：§1.1 条件更新保证**恰好一个 winner**，另一个走 §1.4 → **409 `REVIEW_ALREADY_SUBMITTED`**。
- 幂等层：提交走**匿名 guard + 一次性 Token**，**不引入 `idempotency_records`**
  （Token 本身就是一次性凭证；再叠一层幂等键会与 §1.1 的 winner 判定争夺"谁说了算"）。
  理由写入实现注释。
- 门禁 **E**：`Promise.all` 两次同 Token 提交 ⇒ 恰好 1 个 200、1 个 409；
  库内 `rating`/`reviewed_at` 只被写一次；TicketEvent `reviewed` 只 1 条。

---

## 4. 错 / 过期 / 已用 Token 的响应矩阵

**GET 与 POST 的口径刻意不同**：

| 情形 | `GET /api/public/reviews/:token` | `POST /api/public/reviews/:token` |
|---|---|---|
| 形状非法（长度/字符不符） | **404** `REVIEW_NOT_FOUND` | **404** `REVIEW_NOT_FOUND` |
| hash 查不到 | **404** `REVIEW_NOT_FOUND` | **404** `REVIEW_NOT_FOUND` |
| 已用（`feedback_token_used_at NOT NULL`） | **200** + `can_review=false`, `review_state='submitted'` | **409** `REVIEW_ALREADY_SUBMITTED` |
| 已过期（`review_status='expired'` 或 `expires_at < now()`） | **200** + `can_review=false`, `review_state='expired'` | **410** `REVIEW_EXPIRED` |
| 正常 | **200** 最小上下文 | 见 §1 |

**为什么 GET 用 200 而 POST 用错误码**：GET 的职责是**让页面渲染清楚的话术**
（"您已评价过 / 评价已过期"），把它做成 4xx 会让 H5 把正常业务态走成异常分支；
POST 的职责是**拒绝一次真实写入**，必须是稳定、可断言的业务错误码。
—— 这是**刻意的不对称**，不是不一致。

**「过期」的判定取两者之严**：`review_status='expired'` **或** `feedback_expires_at < now()`。
即：**超时关闭优先**（§7），Token 的 TTL 是次级护栏。

> ⚠️ **本文承认的一处张力**：`feedback.wait_days = 7`（评价窗口），而
> `feedback.token_expire_days = 15`（Token TTL）。第 7~15 天之间，Token 计时上仍有效，但
> `review_status` 已是 `expired` ⇒ **按 §4 走 410**（fail-closed）。
> 两者都可在后台配置；**运维口径：正常应保持 `wait_days ≤ token_expire_days`**。
> 冻结优先级：`review_status` 优先，`expires_at` 兜底。

**匿名 GET 的最小上下文**（**不得**返回完整 Ticket）：

```
ticket_no · store_display_name · service_summary（问题摘要）
confirmed_charge_amount（可为 null） · is_charged
can_review（bool） · review_state（pending|submitted|expired）
```

**明令不返回**：内部用户 ID、`technician_*` 的 token/hash、`customer_mobile`、
`TicketEvent`、内部备注、`store_id`、任何 hash 列。

---

## 5. 收费金额核对（三态，服务端权威）

沿用**已存在**的 `CHARGE_MATCH = {match, mismatch, not_applicable}` 与
`service_visits.customer_charge_match / customer_reported_amount / charge_diff_reason`
—— **Phase 7 不新增任何列**。

事实源 = `service_tickets.feedback_visit_id` 指向的 Visit 的 `is_charged` / `confirmed_charge_amount`。

| 门店事实 | 允许的 `charge_match` | 金额要求 |
|---|---|---|
| `is_charged = false`（`confirmed_charge_amount IS NULL`） | **只能** `not_applicable` | **不得**带 `customer_reported_amount` |
| `is_charged = true` | `match` 或 `mismatch` | `match`：不得带金额；`mismatch`：**必须**带 `customer_reported_amount` |

校验规则（全部 **422**，服务端独立判定，**不依赖 H5 显隐**）：

| 违规 | code |
|---|---|
| 未收费却报 `match` / `mismatch` | `CHARGE_MATCH_NOT_APPLICABLE` |
| 收费却报 `not_applicable` | `CHARGE_MATCH_REQUIRED` |
| `mismatch` 缺 `customer_reported_amount` | `MISSING_CUSTOMER_AMOUNT` |
| `not_applicable` 带了金额 | `AMOUNT_NOT_ALLOWED` |
| 金额 ≤ 0 或 > `CONFIRMED_AMOUNT_MAX`(99999.99) | `INVALID_CUSTOMER_AMOUNT` |

> 与 P6-1 同构：**`NULL`（没收费）≠ `0.00`（自相矛盾，非法）≠ `>0`（实际金额）**。

---

## 6. 正常评价与 reopen

**判据（按顺序）**：

```
reopen := (charge_match === 'mismatch') || (rating <= low_score_threshold)
```
- `low_score_threshold` 取自 **`feedback.low_score_threshold`**（默认 `2`）⇒ **rating ≤ 2 自动 reopen**。
- **3 星默认不 reopen**，仅作 HQ attention 的可配置规则（若把阈值调成 3 才 reopen）。
- **mismatch 无论星级多高都 reopen**（5 星 + mismatch 也 reopen）。

| 结果 | Ticket | 其它写入 |
|---|---|---|
| **正常** | `CLOSED` | `review_status='submitted'`、`reviewed_at=now()`、`closed_at=now()`、`close_reason='reviewed'`、`escalated=false` |
| **reopen** | `PROCESSING` | `review_status='submitted'`、`reviewed_at=now()`、`escalated=true`、`reopen_count = reopen_count + 1`、`closed_at=NULL`、`close_reason=NULL`；写 `reopened`（`EVENT_TYPE.REOPENED`）TicketEvent |

> **口径纠正（回代码取证，2026-09-26）**：`CLOSE_REASON` 的**实际枚举值只有**
> `reviewed` / `review_expired` / `cancelled` / `manual`（`constants.ts` L357）。
> 初稿写的 `review_submitted` **在代码里不存在** ⇒ 按本项目铁律
> 「**先回代码取证，再决定改代码还是改文档**」，此处**改文档**：正常评价落
> **`close_reason = CLOSE_REASON.REVIEWED`（`'reviewed'`）**。
> 超时关闭落 `CLOSE_REASON.REVIEW_EXPIRED`（`'review_expired'`，§7）。
> **理由**：新增一个枚举值要动 `CLOSE_REASON_VALUES` 白名单、后台中文标签表
> （`CLOSE_REASON_LABEL` 一类）、H5 与后台的展示分支，而语义上
> "客户已评价后关闭" **本来就叫 `reviewed`** —— 新增值只会造出两个近义状态。


1. **保留原评价事实**（`rating` / `review_comment` / `customer_charge_match` / `customer_reported_amount` 全部**不被覆盖、不被删除**）。
2. **不自动创建新的 ServiceVisit** —— 后续是否重新派工由门店正常业务动作决定。
3. **`review_status` 停在 `submitted`，不回退 `pending`**（该 Token 已消费，评价生命周期结束）。
4. **不修改 `completed_at`**（= 门店确认完成时刻，Phase 6 冻结语义，见 §12）。

---

## 7. 评价超时关闭

- **键**：**复用已播种键 `feedback.wait_days`（默认 7）**，不新增配置项（理由见 §12）。
- **候选**：`status='WAIT_FEEDBACK' AND review_status='pending' AND feedback_token_used_at IS NULL AND completed_at < now() - interval '<feedback.wait_days> days'`。
- **推进**：**逐条**走 §1.3 的条件更新 —— 领域服务 `expireReview(ticketId)` 是**唯一**改状态的地方。
- **调度**：复用 NocoBase 内建 **`app.cronJobManager.addJob()`**（构造函数已在 `afterStart` 自动 `start()`；
  本项目**未安装 workflow 插件**，故不使用 Workflow）。注册在插件 `load()`。
  ⚠️ 定时任务**只调用领域服务**，**绝不**直接改核心状态（用户明令）。
- **幂等**：可重复运行；`affected rows=0` ⇒ no-op（§1.3）。
  **不因重复扫描产生重复 TicketEvent**（Event 只在 winner 分支写）。
- **单实例**：本部署单 app 实例；即便将来多实例，§1.1 的原子谓词已保证不会双写。
- 返回汇总 `{ scanned, expired, skipped }`（写 info 日志）。

---

## 8. 评价短信正式开启 + Phase 6 存量 backfill

### 8.1 正常路径（今后每次 confirm）

在 confirm 事务内 `enqueue(REVIEW_INVITE)`（`params: {ticket_no, label, link}`，
`link = {PUBLIC_BASE_URL}/f/{明文Token}`），**事务提交后** `flush`。
沿用既有边界：**短信失败不回滚业务事务**；`accepted ≠ delivered`。

> 这**取代** P6-1 的 **O1-B**（当时刻意不发）。O1-B 是 Phase 6 的**阶段内**冻结，
> 被本阶段用户指令「Phase 7 才正式打开 review SMS」**显式解除**。
> `docs/DEVIATIONS.md` 需登记一条"O1-B 于 Phase 7 按计划解除"。

### 8.2 存量事实（盘点结论，**决定了策略**）

| 事实 | 值 |
|---|---|
| 存量 `WAIT_FEEDBACK` | **3 张**：`#2001 FW20260925-0053` / `#2002 FW20260925-0054` / `#2003 FW20260925-0055` |
| `feedback_token_hash` | **3/3 已生成**（P6-1 confirm 时 mint） |
| `review_status` | 3/3 = `pending` |
| **`feedback_token_expires_at`** | 3/3 = **2026-10-10**（未过期，剩余 14 天） |
| `review_invite` 短信 | **0 条**（O1-B 所致） |
| 明文 Token | **已不存在**（只留 hash，不可逆） |

> ⚠️ **列名以代码/库为准**（首跑踩到）：真实列是 `feedback_token_expires_at` /
> `feedback_token_used_at`，本表早前写的 `feedback_expires_at` 是**简写**，
> 直接拿去写 SQL 会 `column does not exist`。

### 8.3 冻结的 backfill 策略（显式 / 可审计 / 幂等）

**核心判断：因为明文已丢弃，`hash` 不可逆 ⇒ 无法"补发指向原 Token 的短信"。**
**唯一正确做法 = 重新签发（re-mint）一个新 Review Token，再发短信。**

规则：

1. **不是自动扫描**。由**运维显式执行** `node scripts/backfill-review-invite.mjs`
   （**默认 dry-run**；`--apply` 才真正写）。**不在插件启动时盲发**。
2. **逐条前置条件**（全部满足才处理）：
   - `status='WAIT_FEEDBACK'`
   - `review_status='pending'`
   - `feedback_token_used_at IS NULL`
   - **`feedback_expires_at > now()`**（原窗口尚未过期 —— **不复活已过期窗口**）
   - 无既有 `sms_logs(scene='review_invite', ticket_id=该单)` 行
3. **动作**：事务内 re-mint（`mintReview()`）→ 覆盖
   `feedback_token_hash` + `feedback_expires_at`（**保留原到期时刻**，不延长客户窗口）
   → `enqueue(REVIEW_INVITE)`；**commit 后 flush**。
4. **幂等 —— 靠"确定性 biz_id"，不是靠 `makeBizId`**。
   ⚠️ **本契约初稿在此处写错了，已按代码取证纠正**：`makeBizId(scene, ticket, visit)`
   （`sms-service.ts:729`）末尾拼了 **`randomBytes(4).toString('hex')`**，
   **每次调用都不同** ⇒ 它**不是**幂等键，`unique(provider, biz_id)` 也**拦不住**
   重复 backfill（两次执行会得到两个不同 biz_id → 两条短信）。
   正确做法：调用方**显式传入**确定性的 `bizId`（`SmsSendRequest.bizId` 支持复用
   —— `sms-service.ts:296` 分支），本脚本用
   ```
   bizId = `review_invite-${ticketId}-backfill`
   ```
   （确定性、可读、可审计）。于是重复 `--apply` 会撞 `unique(provider, biz_id)` ⇒
   不产生第二条短信 ⇒ 报告 `already_sent`。
   **双保险**：执行前仍按规则 2 预检"该单是否已有 `review_invite` 行"，
   预检命中即跳过（**不依赖唯一约束去抛异常做控制流**）。
   **dry-run 与 `--apply` 输出同一份候选清单**。
5. **绝不触碰**非 `WAIT_FEEDBACK` 工单、**绝不**改 `review_status`、**绝不**改 `completed_at`。
6. 跳过项必须**逐条打印原因**（`already_sent` / `expired_window` / `used` / `not_pending`）。
7. **re-mint 覆盖原 hash 的语义边界**：本策略会**作废原 Token**（若它曾泄露到别处也不可用）。
   这是可接受的，因为 P6-1 从未发送过任何指向原 Token 的链接 ⇒ **不存在持有旧链接的客户**。

#### 8.3.1 执行记录（2026-09-26，已实际执行并核验）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 盘点（dry-run） | `node scripts/backfill-review-invite.mjs` | 候选 **3** 张，与 §8.2 盘点一致 |
| 执行 | `… --apply` | 3/3 成功；`hash 已覆盖=是`；每单 `invite 行数=1` |
| **幂等复跑** | `… --apply`（第二次） | 候选 **0** 张，3 张全部 `already_sent` ⇒ **无第二条短信** |
| 出网边界 | `sms_logs` 实查 | 3 行 `provider=mock` / `send_status=pending` / `delivery_status=pending` / `template_code=SMS_TEMPLATE_NOT_CONFIGURED`（**本机 mock + sms.enabled=false ⇒ 只入 outbox，不出网**） |
| **明文泄漏扫描** | `sms_logs.biz_id` / `ticket_events.metadata_json` / `idempotency_records.response_json` 全库 `LIKE '%/f/%'` | **均 0 命中**；`feedback_token_hash` 3/3 长度为 64（纯 sha256 十六进制） |
| **未越界改动** | 三单现状复读 | `status` / `review_status` / `feedback_token_used_at`(NULL) / `feedback_token_expires_at`(10-10) **全部未变**（窗口**未延长**） |

> 边界（沿用既有口径，不因补齐而改变）：**`send_status=pending` 只表示"已入队"，
> 不等于"已送达"**；`accepted ≠ delivered`。真实通道开启后由回执推进
> `delivery_status`。`template_code` 落在 `SMS_TEMPLATE_NOT_CONFIGURED` 是**刻意**的
> 自解释占位（见 §8.1 与 `SMS_TEMPLATE_NOT_CONFIGURED` 的注释）——本机未配运营商模板，
> 这是"没配模板"的可见证据，不是失败。

---

## 9. `/f/{token}` 路由与 H5

```nginx
# 与 /t/ 完全同构（含 access_log off 的理由）
location ~ "^/f/(?<svc_review_token>[A-Za-z0-9_-]{43})$" {
    access_log off;
    return 302 /h5/customer/review/$svc_review_token;
}
location /f/ { access_log off; return 404; }   # 形状不符 ⇒ 404，且不落日志
```

- **302，不用 301**（一次性凭证不可被永久缓存）。
- **token 只走 path，不进 query string**；`/f/` 下 `access_log off` ⇒ **token 不落 access log**。
- H5 真实路由：**`/h5/customer/review/{token}`**（SPA，`try_files` 兜底已在 `/h5/` 内）。
- **不新增**短链服务、不产生永久公开 URL。

**H5 页面**：星级 1–5、可选 `comment`、收费核对三态（未收费**不出现金额框**）、提交后展示终态；
`expired` / `used` 给清楚的话术。**只做必要的浏览器走查**（见 §11 末），不为样式建重型门。

---

## 10. 匿名评价 API 与防滥用

**资源/动作**（沿用 constants 已预留的形状）：

```
PUBLIC_RESOURCE.REVIEW = 'publicReview'
PUBLIC_ACTION.REVIEW_GET = 'get'        →  GET  /api/public/reviews/:token
PUBLIC_ACTION.REVIEW_SUBMIT = 'submit'  →  POST /api/public/reviews/:token
```

入 `ANONYMOUS_ACTIONS`（**每一处单独评审**；同步 `verify-plugin-load.mjs` 的匿名枚举断言）。

**POST body 白名单**（多余字段**拒绝**，不做"忽略"）：

```
rating: integer 1..5            （必填）
comment: string ≤ 500           （可选）
charge_match: 'match'|'mismatch'|'not_applicable'   （必填）
customer_reported_amount: number, 0 < x ≤ 99999.99   （仅 mismatch 必填）
```

**Guard**（复用 `GuardService`，**新增两个 scene** `REVIEW_VIEW` / `REVIEW_SUBMIT`，
与客户报修、师傅上传**各自计桶**）：`token` + `ip` 双维度。

**不引入 CAPTCHA**（无实际 abuse 证据）。

**不暴露"资源是否存在"的额外信息**：形状非法与 hash 查不到**同响应**（都是 404 + 同一文案）。

---

## 11. 门禁清单（**只做承重部分**）

| # | 断言 |
|---|---|
| **A** | Token：valid / malformed / nonexistent / expired / used 五种，响应码与 code 匹配 §4 |
| **B** | 正常评价：5 星 + `match` ⇒ `CLOSED` + `review_status='submitted'` + `reviewed_at` |
| **C** | 低分：`rating=2` ⇒ `PROCESSING` + `escalated=true` + `reopen_count +1` |
| **D** | 金额争议：**5 星** + `mismatch` ⇒ 仍 reopen（`PROCESSING`） |
| **E** | 一次性与并发：`submit × submit` 真并发 ⇒ 恰好 1 winner、1 个 409 |
| **F** | 超时竞争：`submit × expiry` 真并发 ⇒ 恰好 1 winner，无混合态 |
| **G** | SMS：`/f/{token}` 正确拼出；**明文 Token 不在** 5 个持久化面（+ mock provider 日志已脱敏）；`accepted ≠ delivered` 语义未混淆 |
| **反向** | 关键断言（尤其 A/E/F/G）各配**反向项**，证明有区分力（不是恒绿） |
| **浏览器走查** | ①正常评价 → CLOSED；②低分 → reopen；③金额 mismatch → reopen；④expired / used 页面提示清楚 |

**明确不做**：星级组件样式、普通文案、按钮显隐的 mutation/reverse 门。

---

## 12. 冻结不变式与承接约束

| 项 | 冻结值 |
|---|---|
| `completed_at` | **门店确认完成时刻**（Phase 6 语义）。**Phase 7 绝不重解释**、**绝不修改**；评价完成时间另用 `reviewed_at` |
| C16 | **409 `NO_ACTIVE_VISIT`**（不回 422） |
| 并发范式 | **条件 UPDATE + 影响行数**（+ 唯一索引兜底）；**全仓无行锁** |
| reopen | **不新建 ServiceVisit**、**不回退 `review_status`**、**不删原评价事实** |
| Workflow | 本项目**未装 workflow 插件**；定时任务走 `cronJobManager`，且**只调领域服务** |
| 纪律 | 不接 ERP · 不引独立 Node 服务 · 不引重型 BPM/FSM · 不引在线支付/财务/库存 · 服务端状态机与权限始终权威 |

**Phase 7 的配置项口径：一个字都不新增。**

> **口径纠正（回代码取证，2026-09-26）**：初稿列了 5 个"新增 settings 键"。回代码后
> 全部推翻 —— `constants.ts` **L1571-1576** 写着本项目的一条硬规则：
> **"只用已有种子键（`DEFAULT_SETTINGS` 里已存在），不新增配置项 ——
> 新增键会在已安装实例上产生'库里没有该键'的中间态，而 seed 是只增不改的（DEV-23），
> 运维又要等一次重启。"**
>
> 且**所需语义已被现有键完整覆盖**：

| Phase 7 需要 | 复用的既有键 | 默认 | 说明 |
|---|---|---|---|
| 评价超时期限（天） | **`feedback.wait_days`** | `7` | 播种描述原文即「门店确认完成后等待客户评价的天数，超时自动关闭」—— **逐字就是 Phase 7 要的语义** |
| 低分阈值 | **`feedback.low_score_threshold`** | `2` | 播种描述「评分 ≤ 该值判定为不满意并升级」—— 直接作为 §6 的 reopen 阈值 |
| Token TTL（次级护栏） | **`feedback.token_expire_days`** | `15` | Phase 6 已用，§4 的窗口张力即出自它与 `feedback.wait_days` |
| 匿名 IP 分钟限流 | **`security.ip_minute_limit`** | `30` | 与 `public_ticket` / `public_store` **共用阈值、分开计桶** |
| 评价 Token 小时限流 | **`security.technician_token_hourly_limit`** | `60` | 键名字面含 `technician` 但**语义是"单个 token 每小时请求上限"**，评价 Token 同构可直接用（见下方说明） |

**唯一"新增"的东西是 Guard 的 scene 常量**（`REVIEW_VIEW` / `REVIEW_SUBMIT`）——
**这不是配置项**：`GUARD_SCENE` 是**代码常量**（`constants.ts` L1544），
scene 是限流桶的**第一维**，本来就是"每加一个接口就加一个 scene"，不落库、不需重启。

**明确不新增 `review.auto_close_enabled`**：一个"是否启用"的布尔开关会造出
"关闭了但存量还在 pending"的第二套状态语义。当前实现取"**开关即存在与否**"——
定时任务恒注册，是否到期由 `feedback.wait_days` 决定；要停只停任务，不加配置面。

**明确不新增 `security.review_*`**：`security.ip_minute_limit` 已经承担了
"匿名 IP 分钟频控"这个职责，评价接口只是**换一个 scene 桶**。
新增一个同义键会让运维面对"两个都叫 IP 分钟限流"的困惑，
且会出现"改了一个没生效"的静默脱钩（正是 L1590-1595 那段注释警告过的事）。

---

## 13. 开放项

| # | 内容 | 处置 |
|---|---|---|
| O7-1 | 7 天自动关闭 vs 15 天 Token TTL 的窗口差 | **已冻结优先级**（§4：`review_status` 优先，fail-closed）；仅提示运维保持 `auto_close ≤ token_days`。**不阻塞实现** |
| O7-2 | reopen（`PROCESSING`）之后 HQ 如何收口 | **不在本阶段范围**（属后续阶段）；本阶段只保证 reopen 事务正确且不留半写 |
