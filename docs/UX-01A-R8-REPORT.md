# UX-01A 第八轮最终签收验收报告

> 日期：2026-10-16 · 前序：`UX-01A-R7-REPORT.md`
> 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · **UX-01A：NOT READY（3 项 PENDING）**
> **本轮未提交、未推送。** 结论来自真实账号 / 真实浏览器 / 真实服务端响应。

**结论：** 权限与隐私类验收**全部通过**（角色落地、菜单隔离、数据范围、跨店 404、客户 H5 与师傅 H5 隔离）；仍剩 **3 项非权限/隐私类的 UX 验证 PENDING**（A2 专属查看用例、A3 客户端备注、A1 故障注入）。⇒ **不宣布签收**。

---

## 一、角色权限与多门店（✅ 全部通过，服务端 + 浏览器证据）

**默认落地（按 `sort` 升序的第一个可访问页面）** —— 真实数据：
```
LANDING[store_after_sales] 售后服务工作台(sort=…411059) > 我的门店工单(…411060) > 工单事件时间线 > 派工记录 > 门店报修入口
LANDING[hq_after_sales]    全量工单(…236967475) > 工单事件时间线 > 派工记录 > 门店报修入口
LANDING[hq_admin]          全量工单(…236967475) > 工单事件时间线 > 派工记录 > 门店报修入口
LANDING[viewer]            全量工单(…236967475) > 工单事件时间线 > 派工记录 > 门店报修入口
```
- ✓ 门店角色**第一个**入口 = 售后服务工作台 ⇒ **默认落地 = 工作台**（已在第七轮由真实浏览器证据佐证 `href=…/admin/ypcok9wxzys`）。
- ✓ **修改 `desktopRoutes.sort` 未影响总部/只读**：hq_after_sales / hq_admin / viewer 的第一个页面仍是**全量工单**，与第七轮之前一致。
- ✓ **菜单隔离**：`售后服务工作台` **只出现在** `store_after_sales` 的授权列表里，总部/只读列表**不含**它。

**数据范围（真实账号，`serviceTickets:list`）**：
```
SCOPE[A]      {count:425, distinctStoreIds:[1]}        ← 门店A 仅授权 S01
SCOPE[B]      {count:28,  distinctStoreIds:[2]}        ← 门店B 仅自己的门店
SCOPE[HQ]     {count:457, distinctStoreIds:[1,2,null]} ← 总部=全量
SCOPE[VIEWER] {count:457, distinctStoreIds:[1,2,null]} ← 只读=全量（脱敏）
```
- ✓ **跨店直取**（不靠前端隐藏）：门店 A 用原生接口按 id 读**门店 B 的工单**：
  `GET /api/serviceTickets:get?filterByTk=4115` → **404 `NOT_FOUND`「工单 4115 不存在」** ⇒ **服务端**权限边界成立。
- ⚠️ **多门店授权账号**：本环境 `.env` 只有 store_a / store_b / hq / hqadmin / viewer 五个 UAT 账号，**没有"多门店授权"账号**（`UAT_USERS` 亦只列 hqadmin），故"多门店概览数字 = 各授权门店之和"**未验到** ⇒ 记为 **PENDING（环境无该账号，非产品缺陷）**。
- ⚠️ 未授权账号**直接访问工作台 URL**的浏览器实测：**PENDING**（服务端侧已由"跨店 404 + 按 scope 裁数据"证明；浏览器侧未单跑）。

## 二、A3 内部备注最终验收

**服务端（R5 已验证，本轮复用）**：`viewer` 写 → **403 FORBIDDEN**；跨店（门店B→门店A 工单）→ **404 NOT_FOUND**；两者**均未新增事件**（`notes_before == notes_after`）。

**✅ 客户 H5 公开响应隔离（本轮新增，**实际接口 JSON 深度检查**）**：
```
POST /api/public/tickets            → 201，返回 progress_token
POST /api/svc:internalNote          → 200（写入内部备注）
GET  /api/public/progress/<token>   → 200
   top_keys = [ticket_no, store_name, status, status_label, closed_at, submitted,
               media, timeline, completion_note, review, queryable_until, closed]
   leaks_internal_note = false   leaks_note_text = false
   has_summary_field   = false   has_operator_field = false
```
- 客户进度响应**含嵌套结构 `timeline`/`media`**，但**不含** `internal_note`、不含备注正文、不含内部事件字段（`summary`/`operator_kind`） ⇒ **服务端响应本身**未泄漏内部备注（非"前端隐藏"）。
- ✓ 师傅 H5 隔离已于 R5 通过（`/api/technician/visits/:token` 响应体不含 `internal_note`），本轮未改其接口，**未重复开发**。

**⏳ PENDING（客户端）**：在详情抽屉里**提交**内部备注 → 时间线出现 → **关/重开**仍在 → **刷新**仍在 → 状态/闭环时间不变。
- 说明：我在门禁里加了对应块，但它引用了**作用域外的 `confirm` 变量**导致报错，为避免破坏已冻结门禁**已回滚**（门禁恢复 65/0）。功能本身在服务端已验证（state_unchanged=true），客户端交互待下一轮用**正确作用域**补跑。

## 三、A2 独立查看用例（⏳ PENDING）
- 目标：用业务夹具产生 WAIT_STORE_CONFIRM 工单，在真实列表里分别点**工单号链接**与**独立「查看」链接**，确认打开**同一工单**只读详情、位于最上层、可点击，且**与「审核结果」主按钮分开判定**。
- 现状：门禁 **⑥** 已证明该状态行的**主按钮 =「审核结果」且能打开本行详情**；**①b/①c** 已证明**所有可见行**（含该状态行）的工单号链接与「查看」链接均可点、指向本行、且（列表弹窗场景下）抽屉在最上层。
- ⏳ **专属独立用例（同一次运行里对该状态行分别点两条链接）本轮未完成**（同上作用域问题，已回滚）⇒ 记 PENDING，**不用 ⑥/①b 代替**。

## 四、A1 故障注入与恢复（⏳ PENDING）
- 现状：工作台的失败/空态/重试 UI 在组件层存在（`wb-error` / `wb-retry`；且**失败不显示为 0**）。
- ⏳ **受控"仅拦截一次只读请求"的故障注入实测本轮未完成**：现有 CDP 工具类无**事件订阅**（只有 `send/evaluate/waitFor`），做请求级拦截需要新增基础设施 —— 与用户"不引入新框架"的约束冲突，故未强做 ⇒ PENDING。
- 风险等级：**非权限/隐私/业务阻断**，属"可观测性"验证缺口。

## 五、截图归档（✅）
`.tmp-verify/ux01a-workbench-desktop.png`（116 KB）、`.tmp-verify/ux01a-workbench-narrow.png`（68 KB，420px）**仍在**，随本轮交付一并展示。

## 六、冻结门禁 / 构建 / Git
- 冻结门禁 `verify-store-ui-primary-action.mjs`：**✅ 全部通过 65 项 / 0 失败**（第七轮 64 → 65；本轮未改产品代码，仅验证）。
- 本轮**未改产品代码**（`store-workbench.tsx` / `primary-action.tsx` / `ticket-drawer.tsx` 等均为第七轮已冻结成果）；仅新增/回滚**验证脚本**改动。
- `git status`：**13 已跟踪修改 + 9 新增 = 22**；`git diff --check` **干净**；增量密钥审计对**全部 22 个变更文件** → **exit 0**；临时探针已删除。

## 七、最终裁决
- **权限与隐私类：全部通过**（角色落地 / 菜单隔离 / sort 无副作用 / 数据范围 / 跨店 404 / 客户 H5 与师傅 H5 隔离）。
- **仍 PENDING（均非权限/隐私/业务阻断）**：① 多门店授权账号的概览口径（环境无此账号）；② 未授权账号直访工作台 URL 的**浏览器**实测；③ A2 WAIT_STORE_CONFIRM 专属查看用例；④ A3 客户端备注（提交/关重开/刷新）；⑤ A1 故障注入重试。
- ⇒ **UX-01A NOT READY FOR SIGN-OFF**（未达"形成可正式签收的最终证据"）。
- **未提交、未推送。** 状态维持：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A IN PROGRESS。
