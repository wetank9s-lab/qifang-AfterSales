# UX-01A 第九轮最终验收报告

> 日期：2026-10-16 · 前序：`UX-01A-R8-REPORT.md`
> 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · **UX-01A：差 1 项（多门店临时账号）**
> **本轮未提交、未推送。**
> ⚠️ 修正 R8 文档口径：R8 实际有 **5 项** PENDING（标题误写为 3 项），本报告逐项列全并给出结果。

---

## 一、验收脚本组织（用户 §一）
新增**独立** `scripts/verify-ux-01a-final.mjs`：
- 复用既有机制：从主门禁 `import { Cdp, launchCdp, sleep, psql, envValue, SPINNING_EXPR }`（第九轮把主门禁改为**可被 import**：`run()` 加"仅直接执行时运行"的守卫 + 导出工具；**未改其 65 项断言**），并用既有 `technician-harness` 造夹具。
- **自带状态**：所有变量/工单 ID 都在本文件内，**不引用其它阶段的局部变量**（R8 的 `confirm` 越界问题由此根治）。
- 每项独立 PASS/FAIL；夹具在 `finally` 里**按 id 清理**；`sms.enabled` 改动在 `finally` 里还原并回验。

## 二、逐项结果（`verify-ux-01a-final.mjs` → **✅ 15 项 / 0 失败**）

### #1 【P0】未授权/越权 直访工作台（真实浏览器，不靠菜单推断）
| 角色 | 直访 `/admin/<工作台 schemaUid>` 结果 |
|---|---|
| 门店 B（同角色） | `wbRendered=true`，发起 **9** 个工作台数据请求 → **应然**（工作台按**角色**授权；其数据仍受自身门店范围约束） |
| 总部售后 | **`wbRendered=false`**，**0** 个工作台数据请求 |
| viewer | **`wbRendered=false`**，**0** 个工作台数据请求 |
- ⇒ 未被授予工作台的角色**直接访问 URL 也拿不到工作台区块**，且**不发起**工作台数据请求；**不是靠菜单隐藏**。
- 配合 R8 的**服务端**证据（门店 A 按 id 读门店 B 工单 → **404**；各账号 `serviceTickets:list` 的 `distinctStoreIds` 仅含自身门店）⇒ 页面直访 + API 双层均守住边界。

### #2 A2 专属查看（WAIT_STORE_CONFIRM，三入口**分开判定**）
业务夹具（自建、进入 `WAIT_STORE_CONFIRM`、跑完按 id 清理）：
```
✓ 夹具进入 WAIT_STORE_CONFIRM —— #6657 FW20261016-0033
✓ 工单号链接      打开**本行**详情且在最上层 —— 「工单 FW20261016-0033」
✓ 独立「查看」链接  打开**本行**详情且在最上层 —— 「工单 FW20261016-0033」
✓ 「审核结果」主按钮 仍执行自身业务（打开本行审核详情）
· 已清理 A2 夹具 #6657
```
⇒ 三入口**互不替代**；每行仍只有一个主业务按钮（由 65 项门禁的判据①持续守住）。

### #3 A3 客户端内部备注（已闭环工单）
```
✓ 提交后时间线立即显示该备注 —— UX01A-R9-NOTE-…
✓ 服务端恰好新增一条 internal_note 事件 —— 2 → 3
✓ status/next_follow_at/completed_at/closed_at 不变 —— CLOSED||…15:25:47.85+08|…15:25:48.197+08
✓ 无额外短信副作用 —— sms=2
✓ 关掉重开后备注仍在 · ✓ 浏览器刷新后仍可查看历史备注
```
（客户 H5 / 师傅 H5 的**服务端响应隔离**已于 R8/R5 有正向证据，产品代码未变，未重复。）

### #4 A1 故障注入与重试（Fetch 域，仅匹配一次只读请求）
- **先核对**：`Cdp` 类**确实已有**事件分发（`this.handlers` + `on(method, fn)`）—— R8 说的"无法订阅"是**错的**，本轮已纠正。
- 实现：`Fetch.enable` 仅匹配 `*serviceTickets:list*` → 首个请求 `Fetch.failRequest(Failed)`，其余 `Fetch.continueRequest` 放行；`finally` 中 `Fetch.disable`。
```
✓ 注入失败后显示「加载失败 + 重试」（非零工单假象） —— wb-error + wb-retry
✓ 恢复拦截并点重试后成功加载真实数据（无持续 loading） —— 5 卡 + 无 spinner
```
- 只作用于受控 UAT 浏览器；未拦截登录/写入/短信/真实业务；未改生产服务端或真实数据；未安装新浏览器框架。

### #5 多门店临时 UAT 账号 —— **⏳ PENDING（未完成）**
- **阻塞证据**：本环境 `.env` 仅 5 个 UAT 角色口令（store_a/store_b/hq/hqadmin/viewer），**无多门店授权账号**；`UAT_USERS` 查询亦只列出 `hqadmin`（其余账号在 `users` 中不匹配 `uat.%` 前缀）。创建"S01+S02 双授权"的临时门店售后账号需走既有播种流程（`scripts/uat-accounts.mjs` 一族）并额外授 S02 —— 本轮预算未能完成，**不冒充 PASS**。
- **最小恢复方案（下一轮可直接执行）**：用既有 `uat-accounts.mjs --create` 建一个临时门店售后账号 → 在 `store_users` 追加 S02 授权 → 用该账号核对工作台五卡与 `serviceTickets:list` 的 `meta.count`（范围 = S01∪S02）→ 验证其**读不到 S03/其它门店** → 测试后删除账号与其授权，保留审计记录。

## 三、测试账号与授权范围（不含凭据）
| 账号（标识） | 角色 | 授权范围 | 用途 |
|---|---|---|---|
| `uat.store.a@svc.local` | 门店售后 | 仅 S01 | 工作台/列表/备注/故障注入 |
| `uat.store.b@svc.local` | 门店售后 | 仅 S02 | 跨店 404、直访工作台 |
| `uat.hq@svc.local` | 总部售后 | 全量 | 直访工作台、发件箱取 Token |
| `uat.hqadmin@svc.local` | 总部管理员 | 全量 | 账号/授权管理 |
| `uat.viewer@svc.local` | 只读 | 全量（脱敏） | viewer 无写权限、直访工作台 |
> 口令一律**只从 `.env` 读**，未写入任何报告/日志/Git。

## 四、既有冻结门禁回归
`node scripts/verify-store-ui-primary-action.mjs` → **✅ 全部通过 65 项 / 0 失败**（导出/守卫改动后重跑确认，**未删/未跳过/未软化**原断言）。

## 五、Git 与审计
- `git status`：**13 已跟踪修改 + 11 新增 = 24**（新增含 `verify-ux-01a-final.mjs`、7 份 UX-01A 报告、`store-workbench.tsx`、`ticket-no-link.tsx`）。
- `git diff --check`：**干净**；增量密钥审计对**全部 24 个变更文件** → **exit 0**；临时探针已删除。**未提交、未推送。**

## 六、最终结论
- R8 的 5 项 PENDING 中，**4 项已闭环**（未授权直访工作台、A2 三入口分判、A3 客户端备注、A1 故障注入），且**无新的权限/隐私/业务阻断缺陷**。
- **仍剩 1 项 PENDING**：多门店临时账号的概览口径（**环境缺账号**，含明确阻塞证据与最小恢复方案）。
- ⇒ **UX-01A 尚未满足 READY FOR SIGN-OFF**（严格口径：尚有 1 项未验）。若接受"该 PENDING 为环境账号缺失、非产品缺陷"，可**有条件签收**；否则下一轮补齐该项后即可签收。
- **未提交、未推送。** 状态维持：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A IN PROGRESS。
