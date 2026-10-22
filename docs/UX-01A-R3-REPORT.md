# UX-01A 第三轮最终收口报告

> 日期：2026-10-15（第三轮） · 审计基线 `af84363` · 前序：`docs/UX-01A-REPORT.md`、`docs/UX-01A-R2-REPORT.md`
> 状态：P11-5 = PASS/FROZEN · P11-4 = IN PROGRESS（暂停）· Phase 11 = IN PROGRESS · Release = HOLD · **UX-01A = IN PROGRESS**
> **本轮未提交、未推送。** 所有结论均来自真实构建 / 真实容器 / 真实浏览器 / 真实库。

---

## 0. A1 页面创建阻塞：**已定位根因并修复**（本轮最大进展）

### 可复现的最小失败请求 + 完整响应（用户 §一 要求）
```
POST /api/flowSurfaces:applyBlueprint   (mode:'replace'，页面「我的门店工单」)
HTTP 400
[default-field-groups-incomplete] $.defaults.collections.serviceTickets.fieldGroups
  flowSurfaces authoring $.defaults.collections.serviceTickets.fieldGroups does not cover
  required generated popup fields: progress_token_hash, progress_token_expires_at, progress_token_revoked_at
  details = {"collection":"serviceTickets",
             "missingFieldNames":["progress_token_hash","progress_token_expires_at","progress_token_revoked_at"]}
```

### 根因（具体源码位置）
- **P11-4** 给 `serviceTickets` 集合加了三个 `progress_token_*`（客户匿名进度查询凭据）字段；
- 但 `scripts/expected-sensitive-columns.mjs` 的 `SENSITIVE_COLUMNS.serviceTickets` **没同步**这三个字段；
- `scripts/seed-admin-pages.mjs` 的 `buildFieldGroups()` 把 `SENSITIVE_COLUMNS[collection]` 当作"内部字段组"，而校验器要求 fieldGroups **覆盖集合全部字段** ⇒ 漏一个**整页 400**。
- **这是既有的种子漂移，与 A1 无关**，但它"毒化"了**所有**页面的应用（包括新建页面）。

### 最小修复
- `scripts/expected-sensitive-columns.mjs`：向 `SENSITIVE_COLUMNS.serviceTickets` 补 `progress_token_hash / progress_token_expires_at / progress_token_revoked_at`（**同时也是安全收益**：smoke 从此断言这三列绝不进后台页面）。

### 修复验证（真实执行）
- `node scripts/seed-admin-pages.mjs --only 我的门店工单` → `✓ 我的门店工单 应用成功`（**0 项未达标**）。
- `node scripts/seed-admin-pages.mjs`（全量）→ **exit 0**：`✓ 我的门店工单 / 全量工单 / 工单事件时间线 / 派工记录 / 门店报修入口` **五个页面全部应用成功**；动作挂载、工单号链接、角色菜单纠偏全部执行。
- 新增 `--only <标题>` **隔离执行模式**（用户 §一 授权）：跳过全量预清理、只应用目标页、回查后退出 —— 不再"反复全量试错"。

### A1 工作台**仍未交付**（如实说明，不冒称）
- 阻塞**已解除**，但**工作台页面本身本轮未实现**。
- 原因：工作台需要一块**自定义区块模型**（`StoreWorkbenchModel`）承载"概览/待办/快捷/最近"，而 `seed-admin-pages.mjs` 的蓝图构造器**只支持 `table` / `filterForm`**；正确路径是"先用蓝图建页 → 再用 `flowModels:save` 把该页的区块 `use` 换成自定义模型"（与本轮 A2 换字段模型同法）。这条路径**尚未落地**，且必须配真实浏览器验证 —— 我不在**未验证**的情况下把它算作交付。
- **下一轮最小步骤**：(1) 写 `StoreWorkbenchModel`（客户端区块；数据用 `serviceTickets:list?filter[status]=…&pageSize=1` 读 `meta.count`（服务端已按 `applyScope` 裁范围）+ `svc:followUpQueue` 取今日待办 + `serviceTickets:list?pageSize=10` 取最近）；(2) `index.ts` 注册；(3) 蓝图建"售后服务工作台"页并换区块 `use`；(4) 门店角色默认落地；(5) 真实浏览器验证数字与列表一致、待办可跳转、多门店范围正确、空态/失败有提示。

---

## 1. A2 —— 列表直接查看：✅ 通过（含单主按钮门禁保持）

- 真实浏览器（`verify-store-ui-primary-action.mjs`）：**① 每行操作列总共只有一个按钮 —— 20 行全部为 1**（冻结规则保持）；**①b 每行工单号是可点击链接、指向本行、点击打开本行只读详情**（抽屉标题含本行工单号）。
- 整轮 **36 通过 / 1 失败**；唯一失败是 `⑤ 库里没有 PROCESSING`（**该状态当前无数据** ⇒ 判据空转按纪律判红），非产品缺陷。
- **六状态覆盖说明（如实）**：门禁②已逐态核对 **NEW / PROCESSING(有数据时) / WAIT_FEEDBACK / CLOSED / CANCELLED** 的标签与链接；**WAIT_STORE_CONFIRM 多次因库里无数据未验到 ⇒ 标 PENDING**，不声称六态全部完成。
- 链接点击为**只读**：打开的是既有 `ticket-drawer`（不写状态、不发短信）；①b 已在**当前可见表格**里锁定目标行并核对 `data-ticket-id`==行号、抽屉标题含该行工单号。

## 2. A3 —— 内部备注：✅ 服务端已验证（第二轮）；本轮无新增

- 已实测（第二轮）：对**已闭环**工单 `svc:internalNote` → 200、`event_type=internal_note`、**state_unchanged=true**（status/next_follow_at/completed_at/closed_at 全不变）、只 1 条事件、幂等重放不重复、缺 `X-Request-Id` → 422。
- **PENDING**：viewer 只读 403、跨店账号 404（实现走 `assertCanWriteTicket`，静态已核对）、客户端「内部记录」区的人工点验、H5 数据隔离实测。本轮未跑。

## 3. A4 —— 新建服务单：✅ 通过（真实浏览器 7/7）

- `verify-store-create-ui.mjs`：**✅ 全部通过：7 项**，含 `⑥ 按类型显示字段：投诉 3 项隐藏 ✓ · 安装 3 项显示 ✓`、`⑦ 六类逐类走界面创建并查库`、`⑧ 新单在列表且行内主动作=处理（无"受理"）`、`⑨ 详情内可调紧急标记且列表无新增按钮`。
- 本轮修的一个**真实回归**：上一轮把选填字段做成了**条件渲染**，导致"安装单要问家电类别/服务地址"的字段在 DOM 里消失（门禁判红）。已改为**始终在 DOM、用 `display:none` 折叠** ⇒ 首屏仍精简、按类型必现字段仍存在 ⇒ 门禁转绿。

## 4. A5 —— 门店报修入口：✅ 通过（真实浏览器 93/0）

- `verify-store-entry.mjs`：**通过 93 项 / 未达标 0 项**。含：`✓ 裸编码（旧二维码形态）仍可用（200）· 错签名被拒（404）`、`✓ 旧入口建单 provenance=legacy`、`✓ 后台弹窗只给正式签名入口（旧入口链接与说明已移除）`、`✓ 弹窗二维码与服务端几何逐字一致`。
- 本轮修的一处**门禁与新需求的冲突**：该脚本原有"弹窗必须显示旧入口链接"的 UI 判据，与 UX-01A §八（后台不再展示旧入口）**直接矛盾**。已把该条**翻转为**"断言旧入口链接与说明**不存在**"，并保留/前移服务端兼容的全部判据（服务端 `resolveStoreEntry` **一字未改**）。

## 5. 构建与部署结果

- `node scripts/build-plugin.mjs`：TS 门禁 **✅ 通过**（TS2304/TS2552 = 0；宿主包具名导入违例 = 0）+ esbuild **✅ 构建成功**（服务端 1315.6 KB / 客户端 236.5 KB）。
- `docker compose restart app` → `/api/svc:health` = **200**；`verify-bundle-delivery.mjs` **✅ 产物交付链达标**。
- 本轮共构建/重启 2 次（A4 折叠方式修正前后各一次），均绿。

## 6. 页面种子 / 路由 / 授权变更

- **页面种子：已改** —— `seed-admin-pages.mjs`：①新增 `seedTicketNoLink()`（A2，列表列→TicketNoLinkModel，搜索框字段还原为 InputFieldModel）；②新增 `--only <标题>` 隔离模式。
- **敏感列清单：已改** —— `expected-sensitive-columns.mjs` 补 `progress_token_*`（修 400 根因 + 安全收益）。
- **默认登录路由：未改**（A1 未交付）。**角色菜单：未改**（本轮只跑现有纠偏，未见漂移）。
- **未删除任何现有页面后重建**；`applyBlueprint` 使用既有 `replace/create`，未新增覆盖式流程。

## 7. Git 修改清单与密钥审计（本轮未提交未推送）

- `git status`：**13 个已跟踪修改 + 3 个新增 = 16 个**。
  - 修改：`src/shared/svc-action.ts`、`src/server/constants.ts`、`src/server/services/ticket-service.ts`、`src/server/actions/svc/ticket.ts`、`src/client/{index,primary-action,ticket-create-action,ticket-drawer,store-entry-action}.tsx`、`scripts/{seed-admin-pages,expected-sensitive-columns,verify-store-entry,verify-store-ui-primary-action}.mjs`
  - 新增：`src/client/ticket-no-link.tsx`、`docs/UX-01A-REPORT.md`、`docs/UX-01A-R2-REPORT.md`
- `git diff --check`：**无空白错误**。
- **上一轮的 12 vs 13 不一致已核对**：上一轮 `--paths` 只传了 12 个**代码**文件，**漏了 `docs/UX-01A-REPORT.md`**。本轮改为**对"全部变更文件（含未跟踪的 docs）"统一审计**：`--paths <16 files>` → **通过（exit 0）**，无明文 Token/手机号/密钥。
- **未提交、未推送 `origin/main`。**

---

## 8. 结论与未通过项（继续标红）

| 项 | 状态 |
|---|---|
| A2 工单号可点击查看（+ 单主按钮门禁） | ✅ 真实浏览器通过；**WAIT_STORE_CONFIRM 状态未验到 ⇒ PENDING** |
| A3 内部备注 | ✅ 服务端验证通过；**viewer/cross-store/客户端点验 PENDING** |
| A4 新建服务单精简 | ✅ 真实浏览器 **7/7** |
| A5 门店报修入口 | ✅ 真实浏览器 **93/0** |
| **A1 门店售后服务工作台** | ❌ **未交付**（阻塞已定位并修复；页面本身待下一轮落地 + 浏览器验证） |

**没有工作台真实运行证据，UX-01A 不完成。** 本轮已把 A1 的**环境/种子阻塞彻底解决**（可复现的 400 + 根因 + 最小修复 + 修复后全量播种 exit 0），并关闭了 A2/A4/A5 的定向验收；**A1 页面本体下一轮交付**。
