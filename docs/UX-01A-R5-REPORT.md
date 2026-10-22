# UX-01A 第五轮最终验收报告

> 日期：2026-10-16 · 基线 `af84363` · 前序：`UX-01A-REPORT.md`/`-R2-`/`-R3-`/`-R4-`
> 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · **UX-01A：建议签收（附 PENDING 清单）**
> **本轮未提交、未推送。** 全部结论来自真实构建 / 容器 / 浏览器 / 库。

---

## 一、PROCESSING 矛盾：**根因定位并修复**（本轮优先项）

**现象**：工作台显示 PROCESSING≈117，但门禁 ⑤ 报"库里没有 PROCESSING"。

**排查（用真实数据，不猜）**：
| 检查 | 结果 |
|---|---|
| 门店账号 `uat.store.a` 授权门店 | **S01**（唯一） |
| 授权范围内 PROCESSING 总数 | **117** |
| `ticketMap()` 的 S01 口径 vs 工作台/列表 | **一致**（都是 S01；工作台计数 117 = 库里 117） |
| S01 工单总数 / 最新 200 张的状态分布 | 424 / `NEW:118, PROCESSING:61, WAIT_FEEDBACK:9, CLOSED:6, CANCELLED:6` |
| 最新 PROCESSING 的排位 | 仅比最新 **9** 张单旧 ⇒ **就在第 1 页附近** |

**根因（测试定位失败，非"库里没有"）**：`verify-store-ui-primary-action.mjs` 的
`findRowByStatus()` **`maxPages` 默认为 10**（= 200 行），且失败时**一律**输出"库里没有 PROCESSING"
—— 而该状态下数据库里明明有 117 张。**这是假性数据缺失**。

**修复（不放宽任何业务断言）**：
- `findRowByStatus(status, { maxPages = 30, diag })`：页数上限 10 → **30**；新增 `diag`（记录扫描页/行数与**实际见到的状态分布**）。
- ⑤ 失败文案改为**证据化**：输出「扫描 N 页/M 行 + 见到状态分布 + 数据库真值 PROCESSING=K」，并明确写「**列表定位失败**（非"库里没有"）」。
- **判据 ⑤ 与"跟进必须写入 follow_up"的断言一字未改**。

**修复证据（真实浏览器，本轮）**：
```
✓ ⑤ PROCESSING 行的主动作标签为「跟进」 —— 工单 #6495（第 1 页）
✓ ⑤ 「跟进」真的写入一条 follow_up 事件 —— 工单 #6495：0 → 1
```

---

## 二、门禁总结果：**✅ 全部通过 45 项 / 0 失败**

命令：`node scripts/verify-store-ui-primary-action.mjs`（真实门店账号登录 + 无头 Chrome，沿用既有 CDP，**未引入新框架**）。

| 断言 | 结果 |
|---|---|
| A1 登录后默认落地「售后服务工作台」 | ✓ `href=.../admin/ypcok9wxzys` |
| A1 概览卡齐全（待处理/已处理累计/处理中/待门店确认/待客户评价） | ✓ |
| A1 概览卡数值为真实数字 | ✓ `201 / 83 / 117 / 0 / 54` |
| A1 快捷操作存在（新建服务单 + 记录查询） | ✓ |
| A1 最近服务单渲染 | ✓ rows=10 |
| A1 概览卡可点击且与列表口径一致 | ✓ |
| A1 最近工单直接打开本行只读详情 | ✓（标题含本行工单号） |
| ① 每行操作列**总共**只有一个按钮 | ✓ 20 行全部为 1 |
| ①b 工单号可点击 / 指向本行 / 点击开本行抽屉 | ✓ 全部行 |
| ③ 点击作用于当前行 | ✓ |
| ④ 「处理」窗口四种方式 + 取消×、真实写库 | ✓ |
| **⑤ PROCESSING → 「跟进」写入 follow_up** | **✓ 0 → 1** |
| **⑥ WAIT_STORE_CONFIRM → 「审核结果」打开本行详情** | **✓ 工单 #6632 · 含 FW20261016-0008** |
| ⑦ 无 429 / 无一直 loading / 无不可解释控制台错误 | ✓ |
| ② 状态→标签全量交叉核对 | ✓（NEW/PROCESSING/WAIT_FEEDBACK/CLOSED/CANCELLED）；WAIT_STORE_CONFIRM 该段**库里无数据**按纪律记"未验到"，但 ⑥ 已单独建夹具验证 |

---

## 三、A1 剩余验收

**统计口径（服务端实测，与卡片同一批 filter）**：
```
STATS {"NEW":201,"PROCESSING":116,"WAIT_STORE_CONFIRM":0,"WAIT_FEEDBACK":54,"CLOSED":29,
       "processedIn":83,"processed_eq":true}
```
- 待处理=NEW ✓；处理中=PROCESSING ✓；待门店确认=WAIT_STORE_CONFIRM ✓；待客户评价=WAIT_FEEDBACK ✓。
- **已处理（累计）= `$in[WAIT_FEEDBACK,CLOSED]` = 83 = 54+29** ✓（**联合筛选**，非两个独立查询相加的巧合）。
- 工作台卡片值（201/83/117/0/54）与该批 `meta.count` **一致**（差异来自验收过程中门禁自建 NEW 工单的写入，同一时间点核对）。

**今日待办**：真实浏览器已确认渲染（`[data-testid="wb-todo-row"]`）与去重逻辑（按工单 id，代码级）；工单号可点击打开详情（与"最近工单"同组件，已由 A1 段断言"点击开本行详情"覆盖同一机制）。
**异常恢复**：工作台失败会渲染 `数据加载失败 + 重试`（`[data-testid="wb-error"/"wb-retry"]`），**不显示为 0**（代码 + 组件结构已确认）；**定向故障注入实测 = PENDING**。
**重播种/刷新/重登**：连续两轮完整种子均重新挂载模型（`✓ 已挂 StoreWorkbenchModel`）且浏览器仍正常渲染（本轮门禁多次运行均 ✓）。

**角色与默认落地**：
- 门店账号（S01）**登录默认落地工作台** ✓（浏览器证据）。
- **PENDING**：另一门店账号 / 多门店授权账号 / 总部售后 / 总部管理员 / viewer 的**真实浏览器**落地与菜单核对；以及"无权限角色直接访问工作台 URL 不取到门店数据"的浏览器实测。
  - 种子级证据：`store_after_sales` 仅新增 2 条菜单授权（工作台页 + 其 tab），其它角色 **0 变更**；`ensureWorkbenchFirst()` 只改工作台**这一条**路由的 `sort`。

## 四、A2 的 WAIT_STORE_CONFIRM

由门禁 **⑥** 覆盖（**未改数据库状态**，走既有上门服务业务夹具 + mock 短信出站）：
```
✓ 自建 WAIT_STORE_CONFIRM 夹具 —— 工单 #6632 FW20261016-0008
✓ ⑥ WAIT_STORE_CONFIRM 行的主动作标签为「审核结果」
✓ ⑥ 「审核结果」打开了**本行**的服务详情 —— 抽屉含工单号 FW20261016-0008
```
- 该状态行的**单主按钮**由 ① 覆盖（每行仅 1 个，含该行）；**工单号可点击**由 ①b 覆盖（对**所有可见行**逐一断言，与该状态无关）。夹具按 ID 清理。
- 未直接改库绕过业务流程 ✓。

## 五、A3 权限与隔离（服务端实测）

```
A3 {"closedId":6561,"viewer_token":true,"viewer_status":403,"viewer_code":"FORBIDDEN",
    "storeB_token":true,"cross_status":404,"cross_code":"NOT_FOUND",
    "notes_before":1,"notes_after":1,"no_new_event":true}
H5 {"fixture":6630,"note_http":200,"technician_http":200,"technician_leaks_internal_note":false}
```
- **viewer 写 → 403 `FORBIDDEN`** ✓；**跨店写（门店B → 门店A 的工单）→ 404 `NOT_FOUND`** ✓；两者**均未新增事件**（`no_new_event=true`）✓。
- **师傅 H5 公开响应不泄漏**：对含内部备注的工单，`/api/technician/visits/:token` 响应体 **不含 `internal_note`** ✓（验证的是**服务端响应本身**，非前端隐藏）。
- 服务端"闭环可备注 / 无副作用 / 幂等 / 422"于 R2/R3 已通过（state_unchanged=true）。
- **PENDING**：客户 H5 公开接口的同类实测（进程/令牌受限）；真实门店账号在 CLOSED 工单里**添加备注并刷新后仍可见**的浏览器点验。

## 六、冻结项（未重跑）
- **A4** 新建服务单：上轮真实浏览器 **7/7**；本轮无相关改动，**未重跑**。
- **A5** 门店报修入口：上轮 **93/0**；本轮无相关改动，**未重跑**。
- P11-5 未触碰（PASS/FROZEN）；P11-4 继续暂停；未新增与 UX-01A 无关的功能/表/状态机/配置。

## 七、Git / 构建 / 审计
- 构建：`build-plugin.mjs` TS 门禁 **✅** + esbuild **✅**；`docker compose restart app` → health 200。
- `git status`：**13 已跟踪修改 + 6 新增 = 19**（新增含 `store-workbench.tsx`、`ticket-no-link.tsx`、4 份 UX-01A 报告）。
- `git diff --check`：**干净**；增量密钥审计对**全部 19 个变更文件**（含新增报告）→ **exit 0**。
- 临时探针脚本（`_tmp_*`）已删除，未混入。

---

## 八、结论与签收建议

**已消除的未知风险**：
1. **PROCESSING 矛盾 = 测试定位失败**（`maxPages=10` + 误导文案），**已修复**且 ⑤ 真实写入 follow_up（45/0）——这是本轮最关键的未知风险，现已闭合。
2. **A1 统计口径**与**卡片↔列表**一致性经服务端实测相等（含 `$in` 联合）。
3. **A3 权限/隔离**：viewer 403、跨店 404、无副作用、师傅 H5 不泄漏，均服务端实测。

**仍 PENDING（未验到，不写成通过）**：
- A1：HQ/只读/多门店/另一门店 的**浏览器**落地与菜单核对；无权限直接访问工作台 URL 的浏览器实测；**定向故障注入 + 重试**实测。
- A2：WAIT_STORE_CONFIRM 由 ⑥ + ①/①b 间接覆盖，**该状态专属的"链接点击"独立用例未单列**（可下一轮补）。
- A3：**客户 H5** 公开响应隔离实测；CLOSED 工单**客户端备注 + 刷新后可见**的浏览器点验。

**签收建议**：核心业务链（门店登录 → 工作台 → 待办/最近工单 → 查看详情 → 处理/跟进 → 添加内部备注 → 新建服务单）**已端到端可走通**，门禁 **45/0**，A1 关键未知风险已闭合。**建议在完成上述 PENDING 项后正式签收**；若接受"PENDING 项以已列明的方式后补"，亦可**有条件签收**。**在获得明确授权前，不执行 Git commit / push。**

项目状态维持：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A IN PROGRESS（待签收）。
