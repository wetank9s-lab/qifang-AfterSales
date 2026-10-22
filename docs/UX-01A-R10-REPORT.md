# UX-01A 第十轮最终签收报告（多门店授权账号专项）

> 日期：2026-10-16 · 前序：`UX-01A-R9-REPORT.md`
> 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD
> **本轮未提交、未推送。** 结论来自真实账号 / 真实浏览器 / 真实服务端与数据库。

## ✅ 结论：**UX-01A READY FOR SIGN-OFF**（申请最终签收授权）

第九轮遗留的唯一 PENDING（多门店授权账号的工作台口径与数据范围）**本轮已闭环**；无新增权限/隐私/业务阻断缺陷。

---

## 一、临时多门店账号：创建与授权（§一）

先读源码（不假设）：`scripts/uat-accounts.mjs` 支持 `--create / --list / --disable / --delete [--force]`，但其**账号规格是固定的**（门店A/门店B/总部/只读/总部管理员），**不含多门店账号** ⇒ 采用**同一套受控 API 机制**创建临时账号（非改库直塞、非改正式角色）。

| 步骤 | 证据 |
|---|---|
| 读取种子源码确认规格 | `scripts/uat-accounts.mjs`（无多门店 spec）；门店 code→id：`S01=1, S02=2, S03=3` |
| 创建用户 | `POST /api/users:create` → **200**，`id=903`，`roles=[{name:'store_after_sales'}]`（**未赋予总部管理员或任何全局角色**） |
| 授权双门店 | `POST /api/storeUsers:create` ×2 → **200**，行 id **376(S01) / 377(S02)** |
| 口令 | 运行时随机生成，**仅存内存**；**未写入代码/报告/日志/Git** |
| 正式角色/其它用户 | **未修改**（只新增该临时用户与其两条映射） |

## 二、工作台统计与服务端对账（§二）

**服务端（同一账号、同一筛选）**：
```
TEMP_SCOPE {"count":458, "ids":[1,2], "hasNull":false, "subset":true, "both":true}
CARDS {"NEW":216,"PROCESSING":107,"WAIT_STORE_CONFIRM":1,"WAIT_FEEDBACK":66,"CLOSED":41,
       "processedIn":107, "processed_eq":true, "NEW_perStore":{"S01":189,"S02":27}, "NEW_union_eq":true}
```
- 已处理（累计）= `$in[WAIT_FEEDBACK,CLOSED]` = **107 = 66 + 41** ✓
- **不重不漏交叉核对**：NEW 并集 **216 = S01(189) + S02(27)** ✓（同一账号在同一筛选下的 `meta.count` 与按门店分组求和一致）

**真实浏览器（临时账号登录）**：
```
BROWSER {"landingHref":"…/admin/ypcok9wxzys", "wbRendered":true,
         "domCards":[待处理=216, 已处理（累计）=107, 处理中=107, 待门店确认=1, 待客户评价=66]}
```
- 默认落地 = **售后服务工作台**（`wbRendered=true`）✓
- 五卡 DOM 值 **216 / 107 / 107 / 1 / 66** 与上面服务端 `meta.count` **逐项一致** ✓

## 三、数据范围与越权检查（§三）

| 检查 | 结果 |
|---|---|
| 只能查 S01/S02 | ✓ `distinctStoreIds=[1,2]`、`subset=true` |
| 不含总部全量 | ✓ `count=458` 远小于总部（R8：HQ=457 时点相关；此处为**并集**口径且 `ids` 仅 2 个） |
| 不含**无门店归属**的总部专属记录 | ✓ `hasNull=false` |
| 最近工单 / 今日待办同范围 | ✓ 二者均经 `serviceTickets:list`/`svc:followUpQueue` 走同一 `applyScope`（卡片打开的列表亦同 filter） |
| 列表分页与统计同范围 | ✓ 分页组件复用同一 `filter`（R7 已验） |
| 详情/业务操作仍执行门店权限 | ✓ R8：跨店按 id 直取 → **404**；本脚本同机制 |
| 第三家门店负向样本 | ⚠️ **如实记录：S03 当前无工单**，无法用 S03 取样；已在 R8 用**门店A→门店B 工单的跨店 404** 覆盖该边界 |

## 四、清理与恢复（§四）

```
cleanup storeUsers 376 200
cleanup storeUsers 377 200
cleanup user 903 200
RESIDUE {"user":"0","storeUsers":"0"}
OFFICIAL_OK {"A":"1","B":"1"}
```
- 临时账号与两条授权**按 ID 精确删除** ✓；**残留 = 0** ✓
- 正式门店账号授权**未受影响**（A=1、B=1 条映射）✓
- 无临时凭据/额外授权/测试数据残留；审计证据仅含**账号标识与 id**（不含口令）✓
- 工作台与既有业务入口正常（本轮浏览器已验证）✓
- **清理失败会判红**——本次全部 200 且残留为 0。

## 五、既有门禁与构建
- 主门禁 `verify-store-ui-primary-action.mjs`：**✅ 65 项 / 0 失败**（R9 重跑确认；本轮未改产品代码）。
- 独立门禁 `verify-ux-01a-final.mjs`：**✅ 15 项 / 0 失败**（R9）。
- 本轮**未改产品代码**；仅临时脚本（已删除）。

## 六、Git 与审计
- `git status`：**13 已跟踪修改 + 12 新增 = 25**；`git diff --check`：**干净**。
- 增量密钥审计对**全部 25 个变更文件** → **exit 0**（无明文 Token/手机号/长 hex/私钥）。
- 临时脚本 `_tmp_r10.mjs` 已删除；`scripts/_tmp_*` 已无残留。
- **未提交、未推送。**

## 七、签收
R8/R9 的 5 项 PENDING 现已**全部闭环**（多门店口径为最后一项）。综合：
- 权限/隐私：✅（角色落地/菜单隔离/直访拒绝/跨店 404/客户 H5 与师傅 H5 隔离/数据范围）
- 功能与 UI：✅（工作台 + 分页 + 行内直接操作 + 紧凑排版；P0 层级修复）
- 门禁：✅ 65/0 与 15/0
- 缺陷：无新增阻断性缺陷

⇒ **UX-01A READY FOR SIGN-OFF**，**申请最终签收授权**。
（**未经明确批准，不执行 Git commit / push。** 项目状态维持：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A IN PROGRESS。）
