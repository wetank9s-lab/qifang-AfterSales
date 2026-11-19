# P6-R4 兼容性、门店身份及浏览器验收报告

> 2026-10-25 15:46–16:05 · 只读核查 + 基线隔离构建
> **未部署生产、未重启、未迁移、未建测试账号、未 commit。**

---

## 1. 四个 API 的兼容性（逐项）

| 路径 | 生产客户端是否已在调用 | 生产服务端 action | 生产 nginx rewrite | 判定 |
|---|---|---|---|---|
| `svc/dashboard/summary` | **是**（1 处） | `dashboardSummary`（5 处命中） | **无** | **COMPATIBLE（相对基线）** — 候选与生产依赖一致；当前 404 是**既有缺陷**，非 R4 引入 |
| `svc/reports/kpi` | **是**（1 处） | `reportsKpi` **0 命中**（可能映射到别的名字，未确认到） | **无** | **PENDING**（语义映射未查清，但对 R4 无新增影响） |
| `svc/export/tickets` | **是**（1 处） | `exportTickets`（11 处） | **无** | **COMPATIBLE（相对基线）**；导出功能今天就是 404，属既存问题 |
| `svc/guard` | **是**（1 处） | `guardQuota`（14 处） | **无** | **COMPATIBLE（相对基线）** |

**最关键的一条硬证据**：把候选客户端与生产运行客户端的 `svc/*` 路径集合做了精确 diff：

```
prod_paths = 12
NEW  : （空）
GONE : （空）
```

⇒ **R4 客户端替换不新增任何 API 依赖**，四个路径的行为与今天**完全一样**。
它们缺 rewrite 是**历史缺口**，应另立单子，而不是本次发布引入。

生产 nginx 生效配置（`nginx -T`）里与 svc 相关的 rewrite 只有我上一轮加的 4 条（visitDetail/Confirm/Reject/photo），**没有** dashboard/reports/export/guard 的项。

## 2. 生产基线 vs R4 候选的精确差异

做法：`git worktree add --detach HEAD` 建独立基线（HEAD = `9a57997`，其 `migrations/` **止于 20261017**，与生产一致），
只把 R4 补丁（`ticket-store-review.tsx`，**+46/−5，仅此一个文件**）拷进去，再用该 worktree 自己的构建脚本产出。

| 维度 | 生产 | **R4 候选** |
|---|---|---|
| dist 文件数 | 174 | **174** |
| 迁移清单末条 | `20261017-sms-setting-descriptions` | **完全相同** |
| 新增迁移 | — | **0** |
| R4 testid | 无 | `review-load-error` / `store-confirm-open` / `store-reject-open` 各 1 |
| `svc/*` 依赖集 | 12 | **12（完全一致）** |

**没有直接改压缩 JS**，是从源码基线重建的。

## 3. 实际迁移清单与重启风险

| 检查 | 结果 |
|---|---|
| 候选 `dist/server/migrations/` | 17 条，与生产**逐条一致**（止于 20261017） |
| 是否含 202610231 / 2051 / 2052 | **0** |
| 生产 `migrations` 表已登记 | 与本插件清单对应（2051/2052 均 **0**） |
| 重启时 pending 迁移 | **应为 0**（清单一致） |

⚠️ 但"应为 0"仍是**推断**，我**没有**在等价隔离副本上真正重启验证启动日志。
按你定的标准，重启零副作用 = **PENDING**，因此 **DEPLOY BLOCKED 维持**。

## 4. 隔离 Store A/B 账号 —— **未创建**

本轮**没有**建 `store_after_sales` 账号，也没有绑门店。
原因：需要动隔离库的角色/`store_users`/ACL 种子，属于配置变更，我按"不擅自改 ACL"的既有纪律停住了；
且本轮上下文已耗尽，做不完整反而更危险。

所以：**Store A / Store B 归属测试 = PENDING**。

## 5. A–J 浏览器矩阵 —— **全部 PENDING**

无门店账号 ⇒ A(E 部分)、F、G、H 无法验。
`admin` 只能覆盖 A/E/J 的页面层面，但**不能替代门店角色语义**，我不拿它冒充。

**没有一项写成 PASS。**

## 6. R4 是否存在绕过路径

静态结论：全仓只有 `ticket-store-review.tsx` 发 confirm/reject POST；列表主操作只打开抽屉；
`canAct` 已同时约束按钮与 `submitConfirm/submitReject`。
**但"没有绕过"必须靠 B/C/E 的 Network 证据**，现在只有源码与产物级证据 ⇒ **PENDING**。

## 7. 生产独立发布与回滚方案（待授权）

| 步骤 | 内容 |
|---|---|
| 候选 | 上述 174 文件包（含 R4，零新迁移） |
| 部署 | 替换 `dist/client/index.js` 与必要静态资源（不动 migrations 与 server bundle） |
| 生效 | 重启 app 容器（因迁移清单一致 ⇒ 预期无 DDL，**待 §3 实测确认**） |
| 回滚 | 备份 `dist/client/` + `dist/server/index.js` 的 sha256；还原后重启 |

## 8. 生产零改动

生产：只读（SELECT / curl GET / `nginx -T` / docker 只读 grep）。**未写数据、未改配置、未重启。**

## 9. Git

`HEAD=9a57997`；工作区有未提交改动（`h5/*`、插件源码等），**未 commit / 未 push**。
基线 worktree 位于 `C:\Users\Administrator\WorkBuddy\r4-base`（detached HEAD，便于复核与销毁）。

---

## 状态

| 项 | 值 |
|---|---|
| R4 | CODE PASS / **BROWSER PENDING** |
| R4 候选包 | **BUILD PASS（174 文件、零新增迁移、API 依赖集等价）** |
| 重启零副作用 | **PENDING（未实测）** → DEPLOY BLOCKED 维持 |
| Store A/B | **PENDING（未建账号）** |
| P6-VISIT-RESULT-01 | OPEN / 方案待裁决 |
| 生产发布 | NOT AUTHORIZED |
