# P6-SMS-02 Token 压缩专项 · 签收与开启前必查补充

> 执行时间：2026-10-22 15:10（CST）
> 性质：**只读核查**。未删改任何日志，未发送短信，未改配置。
> 对应签收令：§三 生产数据保护 / §四 短信开启前必须补充检查

---

## 1. 签收确认

**P6-SMS-02 Token 压缩：PASS WITH KNOWN LIMITATION** —— 已收到并接受。

保留的 4 项 PENDING（计入短信整体验收台账）：

| # | PENDING | 状态 |
|---|---|---|
| 1 | 旧 43 位 Token 的真实点击 | 未完成（需一枚仍在有效期的历史链接） |
| 2 | 新 22 位 Token 的真实建单端到端 | 未完成（等下一笔真实报修抽查） |
| 3 | 单条短信计费 | **未通过**（92 字仍预计 2 段） |
| 4 | 短信宝生产发送 | 未授权启用 |

---

## 2. 生产数据快照（按令记录时间戳）

**快照时间：2026-10-22 15:10:38 CST**

| 表 | 计数 |
|---|---|
| `service_tickets` | **496** |
| `sms_logs` | **794** |
| `customer_medias` | **563** |

与 15 分钟前的快照（494 / 790 / 551）相比仍在小幅增长 —— **真实业务在持续进来**，
且 `customer_medias` 从 551 → 563（+12）说明客户在**上传照片**，不只是点开页面。

> 按签收令：不再要求计数保持 489 / 783；**未删除任何新增工单，未修改任何真实客户记录**。

---

## 3. §四：最新 8 条 `sms_logs` 逐条核查

安全列（**无手机号、无正文、无 token、无 key**）：

| id | scene | provider | send_status | delivery | error_code | retry | sent_at | 回执号 | 时间 |
|---|---|---|---|---|---|---|---|---|---|
| 6423 | technician_task | smsbao | **rejected** | pending | `SMS_DISABLED` | 0 | 无 | 无 | 15:08:56 |
| 6422 | dispatch_customer | smsbao | **rejected** | pending | `SMS_DISABLED` | 0 | 无 | 无 | 15:08:56 |
| 6421 | progress_link | smsbao | **rejected** | pending | `SMS_PENDING_ORPHAN_UNREBUILDABLE` | 1 | 无 | 无 | 15:04:39 |
| 6420 | progress_link | smsbao | **rejected** | pending | `SMS_PENDING_ORPHAN_UNREBUILDABLE` | 1 | 无 | 无 | 15:01:47 |
| 6419 | review_invite | smsbao | **rejected** | pending | `SMS_DISABLED` | 0 | 无 | 无 | 14:57:57 |
| 6418 | progress_link | smsbao | **rejected** | pending | `SMS_PENDING_ORPHAN_UNREBUILDABLE` | 1 | 无 | 无 | 14:55:35 |
| 6417 | progress_link | smsbao | **rejected** | pending | `SMS_PENDING_ORPHAN_UNREBUILDABLE` | 1 | 无 | 无 | 14:52:16 |
| 6416 | review_invite | smsbao | **rejected** | pending | `SMS_DISABLED` | 0 | 无 | 无 | 14:43:38 |

### 3.1 逐项回答签收令的五个问题

| 问题 | 答案 |
|---|---|
| provider | 8 条**全部 `smsbao`**（provider 切换后产生） |
| 状态 | 8 条**全部 `rejected`** —— 无一条 `accepted` |
| **是否真实调用过 `provider.send`** | **没有**。8 条 `sent_at` 均为空、`provider_request_id` 均为空。调用了 send 才会有这两个值 |
| 是否存在待恢复 / 待重试 / 结果未知 | **全表 pending = 0、error = 0**。无待恢复、无待重试、无"结果未知" |
| 未来启用短信后是否会被再次处理 | **不会**。重试任务只捞 `send_status='error'`；恢复任务只捞 `send_status='pending'` 且超龄。这两类当前都是 0 条 |

### 3.2 两种拒绝原因说明（都不是"发送失败"）

| error_code | 含义 | 是否接近过发送 |
|---|---|---|
| `SMS_DISABLED` | 门禁 1：`sms.enabled=false`，**在调用 provider 之前**就拒绝 | 否 |
| `SMS_PENDING_ORPHAN_UNREBUILDABLE` | 记录停在 pending，恢复任务尝试"重建请求"但重建不出来（缺可重建的上下文），于是判为不可恢复并终结 | 否（重建失败即终结，从未进发送） |

> `retry_count=1` 的那 5 条不是"重试过一次发送"，而是"恢复任务尝试重建过一次"。
> 状态是 `rejected` 而非 `error`，**重试通道根本不会看它们**（只捞 `error`）。

### 3.3 那条 `provider=smsbao` 的 pending —— **已收敛，不再是 pending**

签收令特别要求明确的那条（6418，14:55 入队），当前状态：

```
6418 | smsbao | rejected | SMS_PENDING_ORPHAN_UNREBUILDABLE | retry=1
```

**已由 5 分钟一轮的恢复扫描收敛为终态 `rejected`**，`pending` 计数归零。
⇒ **不存在"开启短信后它被补发"的路径。**

### 3.4 一个必须写清的审计陷阱

全表 322 条 `mock/accepted` 的记录**有 `sent_at`、有 `provider_request_id`**：

```
已真实调用过供应商(sent_at非空) = 322
有 provider 回执号               = 322
```

这 322 条**全部来自 `mock` provider**（mock 会伪造回执号，供本地联调用）。
**它们不代表真实短信已送达。** 将来任何人看到 `sent_at` 非空就判"发过短信"，都会误判。

真实发送条数：**0**（`provider=smsbao` 且 `sent_at` 非空的记录 = 0）。

---

## 4. 当前配置（保持不变的证据）

| 项 | 值 |
|---|---|
| DB `sms.provider` | **smsbao** |
| DB `sms.enabled` | **false** |
| DB `sms.retry_count` | **1**（未动） |
| 容器内 `SMS_ENABLED` | **false** |
| 容器内 `SMS_PROVIDER` | smsbao |
| `SMSBAO_*` 已注入变量数 | **0**（4 个全缺，故 `configured=false`） |
| 短信模板 | **未改**（上一轮已冻结） |
| `progress_update` scene | **未新增** |
| 工单状态机 | **未改** |

=> **未查清前不允许 `sms.enabled=true`** 这条纪律已遵守；本轮也未做任何开启动作。

---

## 5. 结论

- §四 要求的 5 项全部查清，**结论是安全的**：
  8 条新记录**全部 rejected、全部未调用 provider、无可恢复/可重试项**，那条 pending 已收敛。
- §三 快照已按时间戳记录（496 / 794 / 563），未删改真实数据。
- 唯一需要记住的**认知风险**：`sent_at` 非空 ≠ 真发过（322 条 mock 伪造回执）。

**P6：LIVE / CONDITIONAL；Release：HOLD。** 未 commit / 未 push。本轮停止，等下一步指令。
