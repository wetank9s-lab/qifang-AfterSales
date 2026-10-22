# UX-01C 第三轮：「服务时效」页面交付报告（**挂载完成，但页面尚不可用 ⇒ 未 PASS**）

> 日期：2026-10-17 · 前序：`docs/UX-01C-R2-REPORT.md` · 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01C IN PROGRESS
> **本轮未提交、未推送。**
> ❌ **不宣布「服务时效」PASS** —— 页面已建、动作已挂、菜单已开，但**页面内的数据表打不开**（见 §三）。

---

## 一处对照核实（用户 §一）
`ConfigEditActionModel` **此前并未注册**（只有文件存在）。本轮已在 `src/client/index.ts` 补注册：
```ts
...buildConfigEditActionModel({ ActionModel, ActionSceneEnum, request }),
```
—— 符合用户强调的"不能只因为模型文件存在就认为可以被渲染"。

## 一、本轮完成的工作（5 处改动，均已落库/构建）
| 位置 | 改动 | 结果 |
|---|---|---|
| `src/client/index.ts` | 注册 `ConfigEditActionModel` | 构建 ✅ |
| `scripts/ticket-page-actions.mjs` | 新增 `CONFIG_EDIT_ACTION_MODELS/USES`；并入 `isSeedManagedActionRow()` 与 `SEED_MANAGED_USES`（防重播种留孤儿） | ✅ |
| `scripts/seed-admin-pages.mjs` | 新增 `buildSlaSettingsPage()`（`serviceSettings` 表，`defaultFilter` **锁定 3 个 SLA 键**，不暴露整个集合）+ `seedConfigEditAction()`（复用 `actionRow()` + `flowModels:save`）+ `PAGE_BUILDERS` 登记 + main() 挂载步骤 | ✅ |
| `scripts/expected-sensitive-columns.mjs` | `REQUIRED_ADMIN_PAGES` 增「服务时效」；`ROLE_MENU_MATRIX.hq_admin` 增「服务时效」（**只给 hq_admin**） | ✅ |
| `src/server/actions/svc/config-settings.ts` | 冲突判定改为**条件更新**（`UPDATE ... WHERE key=? AND value=?` + 影响行数校验）——修上一轮"先读后判"在 READ COMMITTED 下的**双写/丢失更新**风险（§三） | ✅ |

**种子执行结果（`node scripts/seed-admin-pages.mjs` → exit 0）**：
```
✓ 我的门店工单 / 全量工单 / 工单事件时间线 / 派工记录 / 门店报修入口 / 售后服务工作台 / 服务时效   全部「应用成功」
· 「服务时效」配置编辑动作：✓ 已挂 ConfigEditActionModel（uid eweuuswtdk8 · HTTP 200）
hq_admin：可见 全量工单、工单事件时间线、派工记录、门店报修入口、服务时效（新增 2 / 撤除 0）
```
- 期间修掉一个真实校验错误：`defaultFilter-minimum-fields`（我的筛选只覆盖 2 个字段）→ 补第 3 个字段 `value_type` 后通过。

## 二、真实浏览器核实（hq_admin 登录）
```
DIAG {href:"https://127.0.0.1/admin/orm5rz0ojnd", tables:0, rows:0,
      body:"… 服务时效 … 售后工单 / 服务时效 / 数据表 "主数据源 >  erviceSetting " 可能已被删除。请删除当前区块."}
```
- ✅ **菜单里确实出现「服务时效」**，且**只有 hq_admin**（`hq_admin：新增 2`；门店/总部售后/只读角色未授权）。
- ✅ 页面路由可打开（`/admin/orm5rz0ojnd`）。
- ❌ **页面内的数据表打不开**：区块报 **`数据表"主数据源 > erviceSetting"可能已被删除`** ⇒ **管理员无法看到/修改三个 SLA 值**。

## 三、根因（已定位，指向具体文件）
`collections:listMeta` 的**结构化正向投影**（Phase 11 / P11-0 B-8）在
`src/server/middleware/collection-metadata-scope.ts`：它只放行**白名单内集合**的元数据；
**`serviceSettings` 不在其中** ⇒ 页面客户端拿不到该集合的字段元数据 ⇒ 表格区块渲染成
"数据表可能已被删除"（并把集合名截断显示为 `erviceSetting`）。

**这不是"种子没跑"或"动作没挂"，而是元数据投影层没有放行 `serviceSettings`。**

## 四、最小修复方案（下一轮可直接执行）
在 `collection-metadata-scope.ts` 的 listMeta 正向投影里，**仅对 `hq_admin`** 放行
`serviceSettings`（只读字段 `key/value/value_type/description/updated_by`）——
- 不放行给门店/总部售后/只读（它们本来也不需要，`serviceSettings` 对它们应保持不可见）；
- 其它集合的投影规则**不动**（避免影响既有 B-8 收口）；
- 放行后重跑：`build → restart → seed →` 本页验收脚本（改值/422/409/恢复/审计/截图）。
> 备选（若不改投影层）：把「服务时效」做成**自定义区块**（像 `StoreWorkbenchModel` 那样自带数据读取），
> 不依赖原生表格对集合元数据的依赖。两种都属小改动，二选一即可。

## 五、仍未交付（PENDING）
- ❌ 「服务时效」**页面可用性**（因 §三）⇒ **本轮不 PASS**；真机/浏览器端"改值→生效→恢复"闭环、409 冲突提示、422 范围提示、审计查询、重播种后动作仍在、重启后不丢 —— **均未取得证据**。
- ❌ §三 的**通用 CRUD 绕过**核查（`hq_admin` 仍可经 NocoBase 通用集合管理直接改 `serviceSettings`）**未做**；受管键的写入口收口**未做**。
- ❌ §三 的**并发双写实测**未做（代码已改为条件更新，但未跑"两个请求同 `expected_value`"）。
- ❌ 「短信通知」/「门店管理」未开始；`serviceSettings` 旧描述迁移未做；UX-01D 仍仅边界设计。

## 六、Git 与审计
- `git status`：**39 个变更文件**（本轮新增/修改：`client/index.ts`、`ticket-page-actions.mjs`、`seed-admin-pages.mjs`、`expected-sensitive-columns.mjs`、`config-settings.ts`）。
- `git diff --check`：**干净**；增量密钥审计对全部变更文件 → **exit 0**；临时脚本已删除。
- **未提交、未推送。**

## 七、结论
- 本轮把「服务时效」**挂载链路走通**：模型注册 → 页面种子（只含 3 个受管键）→ 动作挂载（HTTP 200）→ 仅 `hq_admin` 可见（种子 exit 0，其它 6 个页面未受影响）。
- **但页面数据表因 `collections:listMeta` 未放行 `serviceSettings` 而不可用** ⇒ **「服务时效」不 PASS**，**UX-01C 继续 IN PROGRESS**。
- 下一轮按 §四 最小修复（放行 `serviceSettings` 到 hq_admin 的 listMeta）后，即可完成本页的真实闭环验收。
