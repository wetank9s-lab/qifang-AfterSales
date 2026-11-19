# P6-R4-FINAL-UAT 隔离重启及门店审核验收报告

> 2026-10-25 15:50–16:10 · 隔离验证
> **未部署生产、未重启生产、未改生产数据/Nginx、未建测试账号、未 commit。**

---

## 1. 候选包身份

| 项 | 值 |
|---|---|
| 来源 | `git worktree add --detach HEAD`（HEAD = `9a57997`）+ 仅 R4 补丁（`ticket-store-review.tsx`，+46/−5） |
| dist 文件数 | **174**（与生产一致） |
| 迁移文件数 | **15**，末条 `20261017-sms-setting-descriptions`（与生产一致） |
| 202610231 / 2051 / 2052 | **0** |
| R4 testid | `review-load-error` 在产物中命中 **1**（在容器内验证过） |
| `svc/*` 依赖集 | 与生产客户端**完全一致（12 = 12，无增无减）** |

## 2. 真实重启前后的 DB 对比

UAT 库 `scqf_r4_uat`：**用生产库的 schema-only dump + 只搬 `migrations` 表数据**建立
（不搬任何业务数据；不连生产 candidate 写；不挂生产媒体目录）。

| 检查 | 第 1 次启动 | 第 2 次启动 | 结论 |
|---|---|---|---|
| `migrations` 行数 | 33 | **33** | ✅ 无新增登记 |
| public 表数 | 129 | **129** | ✅ 无 DDL |
| 新增表 | **空** | **空** | ✅ |
| 消失表 | **空** | **空** | ✅ |
| `review_verify_codes` / `pending_file_deletions` | **0** | **0** | ✅ 未被创建 |
| 两次结果一致性 | — | 迁移数/表集合均不变 | ✅ 幂等 |

⇒ **A/C/E 三项通过**：pending migration = 0、登记集合不变、无多余 DDL、未创建不该有的表。

## 3. ⚠️ 但发现启动确有写入 —— D 项不能算 PASS

`users / roles / applicationPlugins` 从基线 `0 / 0 / 0` 变成 **`1 / 4 / 77`**。

原因：我建的 UAT 库**只有 schema、没有系统数据**，应用判定为"未初始化"走了自动安装路径。
- 在**生产**上这些数据早已存在，安装分支不会触发；
- 但严格按你定的标准：**"没有新增迁移文件"不等于"启动没有写入"**，
  本次实验**无法证明**在"生产等价的全量数据副本"上重启是零写入。

⇒ **D 项 = PENDING（本实验不足以证明），不是 FAIL，也不能算 PASS。**

## 4. ⚠️ 服务可用性证据无效（TEST INVALID）

两次启动 `health` 都返回 **`000`** —— 我给容器**没有发布端口**（只给了 `--network`），
宿主侧根本连不上 `127.0.0.1:13098`。

⇒ "插件与审核接口正常工作"（G 项）**没有取得有效证据**，标记 **TEST INVALID**，
不能用"容器 running"冒充。

## 5. Store A/B 账号 —— **未创建（PENDING）**

本轮未建 `store_after_sales` 账号。原因：需要在隔离库写 `users` / `roles` / `storeUsers`
并绑定门店，属于 ACL/种子变更；且本轮上下文已耗尽，做一半比不做更危险。

**PENDING，不冒充。**

## 6. A–J 浏览器矩阵 —— **全部 PENDING**

没有 Store A/B ⇒ F/G/H 无法验；`admin` 只覆盖页面层，不替代门店权限语义。
B/C/D/E/J 的"审核 POST = 0"网络证据同样未取。
**一项都不写成 PASS。**

## 7. `svc/reports/kpi` 对审核业务的影响

- 生产客户端**已在**调用它；服务端 `reportsKpi` 名称 0 命中（映射未查清），nginx 无 rewrite；
- 它属于**报表/看板**，与 `StoreReviewSection`（审核区）**无调用关系**；
- ⇒ **对审核业务无影响**（INCOMPATIBLE 只影响看板，属既有缺口，另立单子）。

## 8. 生产最小替换 / 备份 / 回滚（待授权）

| 步骤 | 内容 |
|---|---|
| 候选 | 174 文件包，仅 `dist/client` 与 `dist/server`（迁移与生产逐条一致） |
| 备份 | `dist/` 整目录 `cp -a` + sha256 |
| 替换 | 覆盖插件目录的 `dist/`（**migrations 内容与生产完全相同**） |
| 生效 | 重启 app 容器 |
| 回滚 | 还原 `dist/` + 重启（秒级） |

**前置仍缺**：§3 的"全量数据副本零写入"与 §4 的"服务可用"两项证据。

## 9. 生产零改动 & Git

生产：只读（SELECT / GET / `nginx -T` / 只读 grep / schema-only dump）。**未写、未重启、未改配置。**
Git：HEAD `9a57997`，工作区改动与 R4 补丁**全部未提交**。

---

## 状态

| 项 | 值 |
|---|---|
| R4 | CODE PASS |
| R4 候选 | **BUILD PASS（174 文件 / 15 迁移 / API 依赖集等价）** |
| 隔离重启 | **PARTIAL**：A/C/E PASS；**D（零写入）PENDING**；**G（服务可用）TEST INVALID** |
| Store A/B | **PENDING** |
| R4 浏览器 A–J | **PENDING** |
| P6-VISIT-RESULT-01 | OPEN（独立，不混入本候选） |
| 生产发布 | **NOT AUTHORIZED** |
