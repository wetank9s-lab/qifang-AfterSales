# FW20261022-0007 技师回执展示与重复预约根因报告

> P6-PROD-VISIT-FLOW-01（P1）· 2026-10-25 15:28–15:50
> 生产全程只读（SELECT / curl GET）；隔离环境用合成数据。**未写真实工单、未替门店操作、未改代码上生产。**

---

## 0. 先纠正一个前提

工单**已经不在** `WAIT_STORE_CONFIRM`：

```
Ticket 6915: WAIT_FEEDBACK  (review_status=pending, feedback_visit_id=2638)
Visit 2638 : CONFIRMED / confirmed / store_confirmed_at 10-25 15:23:14 / by user 1
```

也就是说**门店已经点过「确认服务」**（时间正好在我 15:22 修好 nginx 路由之后一分钟）。
若这单确实"没看到回执就确认了"，需要门店复核 —— 见 §6。

---

## 1. 师傅提交的业务数据是否真实保存在库里？—— **是**

| 字段 | 实际值 |
|---|---|
| `submitted_at` | **10-25 14:49:51** |
| `service_result` | **`customer_absent`**（15 字符） |
| `service_note` | **有值，10 字符**（按要求不打印正文） |
| `service_mode` | inhouse |
| `technician_name` | 吴师傅 |
| `is_charged` | **false**（无收费） |
| 照片 | **1 张**：id 818，`image/jpeg`，3,637,968 B，`onsite`，10-25 14:49 |
| 事件 | `technician_submitted` 10-25 14:49:51 |

⇒ **不是"没保存"**，数据完整。DB 侧无丢失。

## 2. `svc:visitDetail` 是否完整返回？—— 代码路径完整，**实测 PENDING**

读模型白名单（`actions/svc/visit-review.ts`）明确包含：
`service_result / service_note / is_charged / reported_charge_amount / submitted_at / expected_visit_at / technician_name`
照片另有 `PHOTO_DISPLAY_FIELDS` 白名单（不含 `storage_key`）。

⚠️ 我**没有门店 15 的账号**，无法执行真实的 `GET /api/svc/visits/2638` 并核对 DTO。
这一条标 **PENDING**（代码层证据充分，缺一次真实 200 的 DTO）。

## 3. 门店页面为什么只剩"确认"而看不到回执？—— **根因是此前 GET 404，确认入口绕过了回执**

时间线吻合：

- 15:08 我诊断时：`GET /api/svc/visits/2638` → **404**（nginx 缺 rewrite）
- 客户端 `StoreReviewSection` 在 `state.error` 时**只渲染红色错误行**（源码 416–419 行），回执正文与照片都不渲染
- 但「确认服务」入口来自**列表/抽屉主操作**（不依赖 I11 读取）
  ⇒ 于是门店看到的是：**没有内容 + 一个可点的确认按钮** → 盲确认

这正是令里 R4 描述的失败形态：**读取失败没有把审核操作锁死**。nginx 修复后内容应该能出来，但 R4 这个客户端加固**还没有做**（见 §7）。

## 4. "重新预约"发生在什么时候、谁操作？—— **没有证据表明发生过**

只读核查结论：

| 检查 | 结果 |
|---|---|
| `ticket_events` 全量（9 条） | created → dispatched → sms_failed×3 → **technician_submitted 14:49:51** → **store_confirmed 15:23:14** → sms_failed。**无 reschedule / 预约变更事件** |
| `expected_visit_at` | **10-24 12:00**（一直没变） |
| 技师 H5（`pages/Technician/Visit.vue`） | **没有预约/改约控件**，`expected_visit_at` 只读展示 |
| 改约服务端入口 | `svc:reschedule`，服务层要求 **ticket.status === PROCESSING** |

最可能的解释：师傅在 10-25 打开页面时，页面显示的是「预约上门：10-24 12:00」（**已过期一天**），他误以为需要在页面里重新约时间 —— 而页面并没有这个功能。

## 5. 预约时间是否被实际覆盖？—— **没有**

`expected_visit_at` 仍是 `10-24 12:00`；`updated_at=10-25 15:23` 来自门店确认动作，不是改约。
没有第二条 Visit，也没有 superseded 记录。

## 6. 是否存在"提交后仍可改约"的服务端缺陷？—— **没有（隔离实测）**

隔离环境合成数据：

| 场景 | 结果 |
|---|---|
| PROCESSING 工单改约 | 走通到服务层（我的夹具没有 active visit，回 `409 NO_ACTIVE_VISIT` —— 夹具问题，非产品） |
| **WAIT_STORE_CONFIRM（技师已提交）改约** | **409 `CONFLICT_STATE_CHANGED`「只有 PROCESSING 才能改约」** |
| 预约时间 before/after | `10-24 12:00` → **未变** |
| 事件 | **无新增** |

⇒ **R9 PASS**：提交后改约被服务端拒绝，历史预约未被污染。

## 7. 最小修复与隔离验证进度

| 项 | 状态 |
|---|---|
| nginx 4 条 svc rewrite（I11/I12/I13/photo） | **已上生产**（P6-PROD-STORE-CONFIRM-02，ROUTE PASS） |
| **R4：读取失败时禁用确认/驳回** | **未做**（需改客户端 → 需构建 + 部署授权） |
| H5 预约区显示"已过期预约"的误导 | **未做**（建议：`expected_visit_at` 已过且非 PROCESSING 时，改文案为「原约定 10-24 12:00（已过期）」并隐藏任何预约暗示） |
| R1/R2/R3/R5/R6/R7/R8/R10/R11/R12 | 本轮**未逐条跑**（上一轮已验 R5/R6/R7：confirm→WAIT_FEEDBACK、reject→PROCESSING、跨店 401/404） |

**我没有把未跑的项目写成 PASS。**

## 8. 这张真实工单是否需要额外数据处置？—— **数据本身不需要**

- 回执数据完整、预约未被覆盖、事件链完整；
- **但有一个业务事实需要门店人工确认**：`service_result = customer_absent`（客户不在家），却已经"确认服务"并进入待评价。
  如果实际没完成服务，这个确认可能是误操作。**处置权在门店**，我不做任何写入。

## 9. 生产热修需要哪些授权？

| 变更 | 授权状态 |
|---|---|
| Nginx 4 条 rewrite | ✅ 已授权并执行 |
| **客户端 R4 加固（读取失败禁用确认）** | ❌ 未授权，需要构建 + 部署客户端 → 单独申请 |
| **技师 H5 预约文案修正** | ❌ 未授权（同上，随客户端一起发） |
| 生产数据库修正 | 不需要 |

---

## 状态

| 项 | 值 |
|---|---|
| P6-PROD-VISIT-FLOW-01 | **P1 / OPEN**（A 根因=nignx 404 已修；B 未发现缺陷，为感知问题） |
| P6-PROD-STORE-CONFIRM-01 | ROUTE PASS / 业务闭环待门店复验 |
| 真实工单写入 | **0** |
| 生产代码变更 | 仅 nginx（上一轮已授权） |
| commit / push | 无 |
