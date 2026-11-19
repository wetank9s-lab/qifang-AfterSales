# P6-PROD-VISIT-FLOW-02 隔离客户端加固与预约展示报告

> 2026-10-25 15:34–15:50 · 隔离实施 + 只读调查
> **未部署生产、未改生产数据、未改 Nginx、未 commit。**

---

## 1. 所有"确认 / 驳回"入口清单

| 入口 | 文件 | 是否会发出 POST |
|---|---|---|
| 列表行主操作「审核结果」 | `row-action-matrix.ts:52-53` → `primary-action.tsx` | **不会**。它只负责打开工单详情抽屉（注释明写"审核在详情内完成"） |
| 详情抽屉里的审核区 | `ticket-drawer.tsx:847` 挂载 `StoreReviewSection`（仅当 `submittedVisit?.id != null`） | 由该组件内部按钮触发 |
| `StoreReviewSection` 的「确认服务 / 驳回」 | `ticket-store-review.tsx` | **唯一**发出 `svc/visits/:id/confirm|reject` 的地方（全仓 grep 只此一处） |

⇒ **不存在"列表上直接确认"的第二条路径**。之前门店能盲确认，是因为审核区在 GET 404 时只显示一行红字、而详情抽屉本身照常打开。

## 2. R4 最小 diff

`client/ticket-store-review.tsx`（唯一改动文件）：

```ts
const dtoVisitId = state.visit ? Number(state.visit.id ?? 0) : 0;
const canAct =
  !state.loading && !state.error && !!state.visit && dtoVisitId === Number(visitId);
```

- 错误分支文案改为：
  **「暂时无法读取师傅的服务回执，当前不能确认或驳回，请刷新后重试。」**（`data-testid=review-load-error`）
- 两个按钮：`disabled={!canAct || submitting}`，`onClick` 也加 `canAct &&` 守卫（`data-testid=store-confirm-open / store-reject-open`）
- `submitConfirm` / `submitReject` 入口各加一道 `if (!canAct) return;`（防"模态框已打开、期间刷新失败"）
- 切换 `visitId` 时 `useEffect` 会重新进入 loading ⇒ `canAct=false`，**旧回执不会被沿用**

**边界声明**：这是前端门禁，只防正常流程里的盲确认；**不冒充**服务端鉴权 —— 直接调 API 仍由 `assertCanWriteTicket` + 状态机拒绝。

构建：`23f94e8d`（180 文件），产物内可见 `review-load-error` / `store-confirm-open` / `store-reject-open` 各 1 处。
**我的文件无 TS 报错**（构建日志里那条 `date-range-item-model.tsx` 报错是既有问题，与本次无关）。

## 3. GET 失败时"无审核 POST"的浏览器证据 —— **PENDING**

我没有门店账号（生产 user 1 是**总部账号**，`store_users` 绑定数 = **0**），
也无法在本轮把 NocoBase 后台 UI 自动化起来。

所以 **B / C / E 的浏览器级证据我没拿到**，只做到"代码 + 构建产物"级。
按你定的标准，这三项记 **PENDING，不算 PASS**。

## 4. GET 成功时真实回执展示 —— **PENDING**

同上（缺门店账号）。代码路径已核对：`service_result` 经 `SERVICE_RESULT_LABEL` 映射，
`service_note` 原样展示，照片走 `svc/photos/:id` 受控读取，`is_charged` 决定是否显示金额行。

## 5. `customer_absent` 回执的真实显示结果

代码层：`SERVICE_RESULT_LABEL.customer_absent` 已存在于产物（1 处命中），会显示为"客户不在"。
**真实浏览器渲染 = PENDING（同上）**。

## 6. 预约显示前后对比

技师 H5（`pages/Technician/Visit.vue`）**没有预约/改约控件**，只读展示：

```
预约上门  {{ formatDay(ctx.expected_visit_at) }}     // 只到"天"
```

- 提交成功后进入 success 页，**不再显示预约时间**；
- 所以"重新预约入口"**物理上不存在**；
- 唯一误导：**已过期**的预约时间仍以普通字段展示（吴师傅 10-25 看到的是 10-24 12:00）。

**本轮未改文案**：按令"若页面本就没有这类误导，只需提交截图与判断依据"。
我判断"过期时间当作待办展示"确有一定误导，但改动属于技师 H5，需与后台客户端**分开授权发布**，
建议随 R4 一起做一个 `expected_visit_at < now ? '原约定 …（已过期）' : '预约上门 …'` 的两行改动。

## 7. P6-VISIT-RESULT-01 调查结果

| 问题 | 结论 |
|---|---|
| 枚举 | `resolved / need_followup / unresolved / customer_absent / other`（5 个，`constants.ts:204`） |
| `customer_absent` 含义 | **客户不在家，实际服务未完成** |
| visitConfirm 是否校验结果 | **不校验**（`store-review.ts` 里没有 `service_result` 相关判断）⇒ 任何合法结果都能确认进 `WAIT_FEEDBACK` |
| 是否有返工路径 | 有「驳回」→ `PROCESSING` → 重新派工/改约（`svc:reschedule` 仅限 PROCESSING） |
| 客户是否收到"服务完成" | **没有**。`review_invite` = `rejected / SMS_SCENE_NOT_ALLOWED`，`progress_link`/`dispatch_customer` 均 `rejected`。客户至今没收到任何短信 |
| 确认人 user 1 | **总部账号**（`store_users` 绑定 0），不是门店 15 的账号 |

**建议的最小业务规则（不动状态机）**：
`visitConfirm` 对 `service_result in (customer_absent, unresolved)` 增加**二次确认标志**（如 `confirm_abnormal_result=true` + 必填说明），
否则 409/422 拒绝；或对这两类结果**只允许驳回**。这两条都要你裁决，本轮**未改**。

## 8. 生产发布依赖与未授权迁移影响

**关键风险**：后台客户端与插件在同一产物里（`dist/client` + `dist/server`）。
如果要发布 R4，必须重建并**重启生产插件**，而这会触发自动迁移 —— 工作区里还躺着
**未获授权的 `202610252-drop-review-verify-codes`**。

因此必须先决其一：
- (a) 发布前把 2052 迁移**临时移出产物**（或加开关），只发客户端；或
- (b) 单独批准这次迁移在生产执行（对生产是 no-op，因为该表从不存在）。

**技师 H5** 是独立静态产物（`h5/dist`），可单独发布、单独回滚；但它也不含 R4，只有预约文案改动。

**结论：R4 现在不能上生产，卡在"发布即触发未授权迁移"这一点上。**

## 9. 生产零测试写入 & Git

- 生产：**只读**（SELECT + curl GET）；本轮未改 Nginx、未改数据、未重启
- 隔离：合成工单若干（`RS-*`、`ISO-*`）
- Git：**未 commit / 未 push**

---

## 状态

| 项 | 值 |
|---|---|
| P6-PROD-VISIT-FLOW-01 | P1 / OPEN（A 根因已修，R4 修复隔离完成待发布） |
| P6-PROD-VISIT-FLOW-02 | 隔离 R4 **代码+构建 PASS**；浏览器 A–J **PENDING** |
| P6-VISIT-RESULT-01 | **OPEN / 业务规则待裁决** |
| 生产发布 | **NOT AUTHORIZED**（且被 2052 迁移阻塞） |
