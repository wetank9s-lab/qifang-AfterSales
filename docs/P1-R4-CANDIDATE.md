# P6-R4 安全发布候选与浏览器验收报告

> 2026-10-25 15:42–15:55 · 只读核对 + 本地构建分析
> **未部署生产、未重启、未迁移、未 commit。**

---

## 1. 与生产基线相比的精确变更清单

| 维度 | 生产当前 | 当前源码构建 |
|---|---|---|
| 插件 version | `1.0.0` | `1.0.0` |
| dist 文件数 | **174** | **180** |
| 构建指纹 digest | `e112b342…` | `23f94e8d…` |
| 迁移文件（末条） | 止于 **`20261017-sms-setting-descriptions`** | 多出 **3 条** |
| 客户端 | 无 R4 门禁 | **含 R4 门禁** |

## 2. 迁移风险排除证据 —— ⚠️ **不止 2051/2052**

生产 `migrations` 表里本插件登记止于 `20261017-…`；当前源码产物比它多出：

| 迁移 | 作用 | 风险 |
|---|---|---|
| `202610231-pending-file-deletions` | **CREATE TABLE `pending_file_deletions`** | **新表 + 新索引**，是真实 schema 变更 |
| `202610251-review-verify-codes` | **CREATE TABLE `review_verify_codes`** | 已撤销功能，不应再建 |
| `202610252-drop-review-verify-codes` | DROP 该表 | 未授权 |

生产当前**没有**登记 2051/2052（`count = 0`）。
⇒ 只删 2052 不够（2051 仍会建表）；**而 202610231 也不是 OTP 的东西，它是照片删除队列的表**。

**这条是本次调查最重要的发现**：如果直接把当前构建发上去，会一次性执行 3 条迁移，其中 2 条建表。

## 3. 候选包两条路线

### 路线 B1（推荐）：**客户端单文件替换**
```
候选 = 生产插件目录原样
     + dist/client/index.js  ← 用含 R4 的新构建替换
     （dist/server/* 与 dist/server/migrations/* 完全不换）
```
- 迁移风险：**零**（迁移文件一个不动，服务端 bundle 不变）
- 是否需要重启插件：**需要**（`dist/client` 是静态资源，但 NocoBase 启动时校验客户端入口，实测仍需重启 app 才会加载新 bundle）
- **必须先验证的兼容性**：新客户端会调用
  `svc/dashboard/summary`、`svc/reports/kpi`、`svc/export/tickets`、`svc/guard`
  等路径 —— 这些在**生产服务端 action 清单里没有同名项**，需要先确认 nginx 是否有对应 rewrite、
  或这些调用是否被代码分支屏蔽。**未确认前不能发。**

### 路线 B2：完整构建 + 剔除迁移文件
- 剔除 2051/2052 后，`202610231` 仍会执行（建表）⇒ **不符合"零迁移"要求**
- 若连 202610231 一起剔除，则服务端代码引用了不存在的表 ⇒ 运行期报错
- ⇒ **B2 判定 BLOCKED**

## 4. dist/client、dist/server 版本与差异

- `dist/client/index.js`：差异集中在 `ticket-store-review.tsx`（`review-load-error`、`store-confirm-open`、`store-reject-open` 三个 testid 各 1 处）
- `dist/server/index.js`：本次**没有任何改动诉求**（R4 是纯前端门禁）
- 但当前构建的 server bundle 相对生产**包含了 202610231/2051/2052 时期的代码**（如 file-deletion consumer），
  所以"整体替换"并不等于"只改 R4"

## 5. 是否需要插件重启 / 自动迁移副作用

- **需要重启**：客户端 bundle 在插件启动时被加载，替换文件后必须重启 app 才生效
- **重启即触发自动迁移**（若产物里带着新迁移文件）⇒ 这正是为什么必须走 B1
- B1 因为不碰 `dist/server/migrations`，重启**不会**触发任何新迁移

## 6. A–J 浏览器结果 —— **全部 PENDING**

原因同上一轮：**没有隔离环境内的门店业务账号**。
本轮未新建 `store_after_sales` 账号（要改 ACL/角色绑定，属于"配置变更"，我按令没有擅自动）。

`admin` 只能覆盖"页面能否打开"，**不能覆盖 H（跨店）与 F/G（门店确认/驳回权限）**。

我**不把任何一项写成 PASS**。

## 7. 门店账号 vs 总部账号的测试边界

| 账号类型 | 能验 | 不能验 |
|---|---|---|
| 总部 admin（现有） | A 页面渲染、E 入口一致性、J 刷新/竞态 | **H 跨店隔离**、F/G 门店权限语义 |
| store_after_sales（**尚缺**） | F/G/H 全部 | — |

## 8. `customer_absent` 最小服务端修复方案（未实施，待裁决）

在 `actions/svc/store-review.ts` 的 `visitConfirm` 里，于现有状态校验之后加一条：

```ts
// P6-VISIT-RESULT-01：未完成服务的回执不得按"正常完成"确认
const r = String(visit.service_result ?? '');
if (r === SERVICE_RESULT.CUSTOMER_ABSENT || r === SERVICE_RESULT.UNRESOLVED) {
  fail(ctx, 422, 'SERVICE_NOT_COMPLETED',
    '这次回执的结果是"客户不在家/未解决"，不能按正常完成确认；请驳回并安排再次上门。');
  return;
}
```

- 不动状态机、不动枚举、不清回执/照片、不覆盖预约
- `need_followup` / `other` **暂不改**（语义待业务裁决）
- 该改动属**服务端**，**不得混进 R4 客户端候选包**

## 9. 真实工单未被修改的证明

只读核对（本轮未执行任何写）：

```
Ticket 6915 : WAIT_FEEDBACK / review_status=pending
Visit 2638  : CONFIRMED / confirmed / submitted 10-25 14:49:51 / confirmed 10-25 15:23:14
expected_visit_at : 10-24 12:00（未变）
```

本轮未重签、未确认、未驳回、未改预约。**唯一一次写是本轮之前重签评价令牌**（已报告）。

## 10. 生产独立发布与回滚计划（B1 路线，待授权）

| 步骤 | 内容 |
|---|---|
| 备份 | `cp -a` 生产 `dist/client/index.js` → `.bak.<ts>` + 记 sha256 |
| 替换 | 仅覆盖 `dist/client/index.js` |
| 生效 | 重启 app 容器（**不触发迁移**，因为 migrations 目录未动） |
| 验证 | 页面加载正常、审核区读失败时不出现确认按钮 |
| 回滚 | 还原 `dist/client/index.js` + 重启 |

## 11. Git

**未 commit / 未 push。**

---

## 状态

| 项 | 值 |
|---|---|
| R4 | CODE PASS / **BROWSER PENDING** |
| 安全发布候选 | **BLOCKED**（B2 不可行；B1 需先验客户端↔生产服务端兼容性） |
| P6-VISIT-RESULT-01 | 业务缺陷确认 / 修复方案待裁决 |
| 生产发布 | NOT AUTHORIZED |
