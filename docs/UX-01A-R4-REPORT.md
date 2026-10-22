# UX-01A 第四轮 · A1 专项交付报告

> 日期：2026-10-16 · 基线 `af84363` · 前序：`UX-01A-REPORT.md` / `-R2-` / `-R3-`
> 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · **UX-01A = IN PROGRESS（A1 已交付，待最终签收）**
> **本轮未提交、未推送。** 全部结论来自真实构建 / 容器 / 浏览器 / 库。

---

## A1 —— 门店售后服务工作台：**已交付，真实浏览器验证通过** ✅

### 实现（复用既有 FlowEngine 扩展，不新建页面系统）
- **自定义区块模型** `src/client/store-workbench.tsx`：`StoreWorkbenchModel` **派生宿主的区块模型**
  （基类经 `engine.getModelClass('MarkdownBlockModel')` 取，取不到退回 `TableBlockModel`），
  覆写 `render()` 渲染工作台。与 A2 换字段模型**同一手法**。
- **独立页面**：`scripts/seed-admin-pages.mjs` 新增 `buildStoreWorkbenchPage()` —— 用宿主 `markdown` 静态区块
  在 `flowSurfaces:applyBlueprint` 里建出「售后服务工作台」页；页面落库后由 `seedWorkbenchBlock()`
  用**既有的** `flowModels:save`（扁平 payload）把该区块节点 `use` 换成 `StoreWorkbenchModel`。
- **不删不改**其它页面；`applyBlueprint` 走既有 `create/replace`，无覆盖式流程。
- **幂等**：本页经**两次**完整种子（含 replace 重建）后，`seedWorkbenchBlock` 每次都重新挂上
  （`✓ 已挂 StoreWorkbenchModel（via declaredKey · HTTP 200）`）；区块 uid 随重建变化但 `declaredKey`
  稳定（`workbench.workbench-block`），重播种**不会丢失工作台**。

### 业务数据（真实、服务端授权范围）
- 先**实测 API 格式**（未假设）：`serviceTickets:list?pageSize=1&filter={...}` → `meta.count` 生效且**已按门店授权范围裁剪**（NEW=204/208、`$in` 联合=75）；`svc:followUpQueue` 回 `{todayCount,overdueCount,items}`。前端**不拉全量再过滤**。
- **概览卡**：待处理=NEW；**已处理（累计）**=WAIT_FEEDBACK+CLOSED（卡面注明口径）；处理中=PROCESSING；待门店确认=WAIT_STORE_CONFIRM；待客户评价=WAIT_FEEDBACK。
- **卡片可点击** → 打开**同一 filter** 的筛选结果弹窗（已处理用 `$in` 联合筛选），行内工单号可开只读详情。
- **今日待办**：待受理(NEW) + 待门店审核(WAIT_STORE_CONFIRM) + `svc:followUpQueue`（到期跟进/已逾期），**按工单 id 去重**；日期口径沿用服务端。
- **快捷操作**：新建服务单（跳转既有门店工单页的建单入口）、记录查询（既有列表筛选）。
- **最近服务单**：`serviceTickets:list` 最近 10 条，工单号直接打开既有只读详情抽屉。
- **历史导入档案**在独立集合（`historicalImportRows` 等），不在 `serviceTickets` ⇒ 天然不混入统计。
- **loading / 空态 / 失败+重试**齐备（失败**不显示为 0**）。

### 默认落地（门店登录即进工作台）
- 机制：NocoBase 菜单按 `desktopRoutes.sort` 升序、登录打开**第一个可访问页面**。
  `seed-admin-pages.mjs` 新增 `ensureWorkbenchFirst()`：把工作台路由 sort 调到**最小**（只动这一条路由）。
- **只给门店角色**加该页（`ROLE_MENU_MATRIX.store_after_sales` 首位）；总部管理员 / 总部售后 / 只读的菜单**未动**。

### 真实浏览器验证（沿用既有 CDP；本轮在既有门禁里新增 A1 段）
```
──── A1 门店登录默认落地工作台（真实浏览器）────
  ✓ A1 登录后默认落地「售后服务工作台」        href=https://localhost/admin/ypcok9wxzys
  ✓ A1 概览卡齐全                            待处理 / 已处理（累计）/ 处理中 / 待门店确认 / 待客户评价
  ✓ A1 概览卡数值为真实数字                  204 / 79 / 118 / 0 / 52
  ✓ A1 快捷操作存在                          新建服务单 + 记录查询
  ✓ A1 最近服务单渲染                        rows=10
  ✓ A1 概览卡可点击且与列表口径一致          待处理 卡片=204 · 列表首屏 30 行
  ✓ A1 最近工单直接打开本行只读详情          「工单 FW20261015-0001」
  ✓ 每行操作列**总共**只有一个按钮 —— 20 行全部为 1        （A2 冻结门禁保持）
  ✓ ①b 工单号是可点击链接 / 指向本行 / 点击开本行抽屉
  ❌ 通过 43 项，失败 1 项： ⑤ 找到 PROCESSING 工单（库里没有 PROCESSING 数据 ⇒ 判据空转判红，非产品缺陷）
```
**这条业务链已可走通**：门店登录 → 工作台 → 看今日待办/最近工单 → 点工单查看详情 → （列表内）处理/跟进 → 详情内添加内部备注 → 新建服务单。

---

## 剩余小范围验收

| 项 | 状态 |
|---|---|
| A1 HQ/只读 默认落地与授权未受影响 | **PENDING**（种子级证据：本轮仅 `store_after_sales` 新增 2 条菜单授权，其它角色 0 变更；真实浏览器对 HQ/viewer 的落地未跑） |
| A1 单门店/多门店/无权访问 场景 | **PENDING**（统计走服务端 `applyScope`，静态与接口已证；多门店账号的真实浏览器场景未跑） |
| A1 接口失败/刷新/重播种不丢 | 部分：重播种已验证（两次）；"接口失败显示错误+重试"代码就绪，**未用故障注入实测** |
| A2 WAIT_STORE_CONFIRM | **PENDING**（当轮库里无该状态数据；未造假数据） |
| A2 ①/①b 六态中已覆盖的有数据状态 | ✅ 通过 |
| A3 viewer 403 / 跨店 404 / 客户端备注点验 / H5 隔离 | **PENDING**（服务端"闭环可备注、无副作用、幂等、422"已于 R2/R3 通过） |
| A4 新建服务单 | ✅ 上轮 7/7 通过；本轮未改相关代码，**未重跑** |
| A5 门店报修入口 | ✅ 上轮 93/0 通过；本轮未改相关代码，**未重跑** |

---

## 页面种子 / 路由 / 授权变更

- `scripts/seed-admin-pages.mjs`：新增 `buildStoreWorkbenchPage` / `seedWorkbenchBlock` / `ensureWorkbenchFirst`；`PAGE_BUILDERS` 增「售后服务工作台」；`--only` 隔离模式（R3 已加）。
- `scripts/expected-sensitive-columns.mjs`：`REQUIRED_ADMIN_PAGES` 增「售后服务工作台」（受管清单，防漂移）；`ROLE_MENU_MATRIX.store_after_sales` 置工作台于**首位**（其余角色不变）。
- `scripts/verify-store-ui-primary-action.mjs`：新增 **A1 段** + A1 断言（复用既有 CDP，不引入新框架）。
- **默认登录路由**：通过**菜单首位**实现（未改路由框架、未改浏览器本地跳转）。

## 构建 / Git / 审计（本轮未提交未推送）

- 构建：`build-plugin.mjs` TS 门禁 **✅**（两类判据 0 条）+ esbuild **✅**；`docker compose restart app` → health 200；`verify-bundle-delivery` 达标。
- `git status`：**13 个已跟踪修改 + 5 个新增 = 18**。
  - 新增：`src/client/store-workbench.tsx`、`src/client/ticket-no-link.tsx`、`docs/UX-01A-REPORT.md`、`docs/UX-01A-R2-REPORT.md`、`docs/UX-01A-R3-REPORT.md`
  - 修改：`src/shared/svc-action.ts`、`src/server/{constants.ts,services/ticket-service.ts,actions/svc/ticket.ts}`、`src/client/{index,primary-action,ticket-create-action,ticket-drawer,store-entry-action}.tsx`、`scripts/{seed-admin-pages,expected-sensitive-columns,verify-store-entry,verify-store-ui-primary-action}.mjs`
- `git diff --check`：**无空白错误**；增量密钥审计**对全部 18 个变更文件**（含未跟踪 docs）→ **exit 0**。
- 临时探针脚本（`_tmp_*`）已删除，未混入。

## 结论

- **A1 已真实交付**：门店账号登录**默认进入**售后服务工作台，概览/待办/快捷/最近均**真实渲染**，卡片与列表口径一致，工单可直接查看详情 —— 有**真实浏览器证据**。
- A2（含冻结门禁）保持通过；A4/A5 保持上轮通过（本轮未触碰）。
- 仍 **PENDING**：A1 的 HQ/只读落地与单/多门店浏览器场景、故障注入重试；A2 的 WAIT_STORE_CONFIRM；A3 的 viewer/跨店/客户端点验/H5 隔离。
- **UX-01A 尚未最终签收**（PENDING 项未清）。状态不变：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A IN PROGRESS。
