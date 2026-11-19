# D1 定性结论：`member` 两条历史路由

> 取证时间 2026-09-12 17:58（生产只读 + member-only 真实登录）
> 证据 `.tmp-media/launch/d1-result-remote.txt`、`d1-scope` 输出

## 一、两条路由的真实归属

| 项 | `wcsgqh8e71w` | `0xbj56mtilr` |
|---|---|---|
| 路由 id | 393140917567488 | 393140917567489 |
| 标题 | 历史售后档案 | 历史售后档案 |
| type | `flowPage` | `tabs`（`hidden=t`） |
| 父级 | 387851208425472（`售后工单` group） | **393140917567488**（上一条的子路由） |
| schemaUid | `wcsgqh8e71w` | `0xbj56mtilr` |
| menuSchemaUid / tabSchemaName | `5qa4rwpxg6y` / — | — / `6zi6zl2kbad` |
| 根模型 | `1ubee65u6sj` → `RootPageModel`（`icon=HistoryOutlined`） | — |
| 区块模型 | `tnxewe9mz3h` → **`HistoricalArchivesBlockModel`** | `lwgesae1vyf` → `BlockGridModel` |
| 数据来源 | **`svc:historicalArchiveQuery`**（受控只读接口） | 同左 |

**归属判定：P11-3 / BE-02A 的「历史售后档案」功能**，不是 ARC-V1。
判据三条：
1. 区块类是 `historical-archives-block.tsx` 导出的 `HistoricalArchivesBlockModel`，文件头写明
   「BE-02A S2：历史售后档案专用区块」；
2. 它调的是 `svc:historicalArchiveQuery`（`constants.ts:2877`，P11-3 冻结契约的并列入口）；
3. 数据在 `historicalServiceArchives`（历史导入表），**不是** ARC 的 `serviceArchives`。

**与 ARC-V1 移动路由的关系：无。** ARC 移动页是 `397268289585152`（`n5c25yq5qlt`）+
子路由 `397268289585153`（`97x481j2bv1`），父级、schemaUid、区块类、数据源全部不同。
ARC 页面用 `ArchiveCreateBlockModel` / `ArchiveEditBlockModel`，数据在 `serviceArchives`。

## 二、member-only 真实登录实测（临时账号，用完即删）

账号只带 `member`（`ROLES_CHECK` 返回 `"member"`），登录后逐项打点：

| 探测项 | 结果 | 说明 |
|---|---|---|
| `desktopRoutes:listAccessible?layout=admin-layout-model` | 200，**34 条** | 含 `wcsgqh8e71w` ✅、`0xbj56mtilr` ✅ |
| `desktopRoutes:listAccessible?layout=mobile-layout-model` | 200，**0 条** | member 在移动端看不到任何页 |
| `flowModels:findOne`（5 个 UID） | 200 但 **`none`** | member 拿不到渲染树模型 |
| `flowSurfaces:get?pageSchemaUid=wcsgqh8e71w` | **403** | 页面树被拒 |
| `uiSchemas:getJsonSchema/wcsgqh8e71w` | **403** `No permissions` | |
| `desktopRoutes:list` / `flowModels:list` | **403** | |
| `serviceArchives:list` / Stages / Photos | **403** | ARC 集合读不到 ✅ |
| **`svc:historicalArchiveQuery`** | **200** | ⚠️ 可达 |
| **`svc:historicalArchives`** | **200** | ⚠️ 可达 |

## 三、结论：**B 类 + 一条独立弱点**

### B 类成立：两条路由不属于 ARC-V1，**不得误删**

- 它们是 P11-3/BE-02A 的历史档案页，member 持有的是**与其它 5 个角色相同的常规授权**
  （`admin` / `hq_admin` / `hq_after_sales` / `store_after_sales` / `viewer` / `member` 各有 2 条）。
- 它**不是** ARC 越权：ARC 的 `serviceArchives` / Stages / Photos / uiSchemas 对 member 全部 403。
- ⇒ **不撤销这两条授权**（撤销会改变 P11-3 既有行为，超出本次授权范围，且会影响 member 的其他原有路由语义）。

### ⚠️ 但发现一条真实弱点（独立于 ARC，本次**不修**，只登记）

`svc:historicalArchiveQuery` 与 `svc:historicalArchives` 对 member 返回 **200**。
实测数据面：**`total=0`，0 行**（root 对照 `total=124`）。
根因在 `historical-review-archive.ts:71 resolveArchiveScope()`：
`member` 不命中 `hq_admin`/`hq_after_sales`/`store_after_sales` 任一分支 ⇒ 落到
`return { kind: 'none' }` ⇒ 直接返回空集，**不查库**。

⇒ 这是一个「**接口可调、数据为空**」的信息级弱点（能探测到接口存在，但拿不到任何档案）。
不是数据泄露。按分诊属 **B 类（后台/运维）**，登记到 `docs/BACKOFF`，不在本轮修。

### 页面是否真的能打开？

`listAccessible` 里能看到路由（菜单项会出现），但：
`flowModels:findOne` 全 `none` + `flowSurfaces:get` 403 + `uiSchemas:getJsonSchema` 403
⇒ **页面渲染树与数据都拿不到，打开即空/报错**。
即「菜单可见、页面不可用」，属既有状态，与本轮 ARC 发布无关。

## 四、对 FINAL-LAUNCH 的影响

**不构成 HOLD。** 理由：B 类（非 ARC）、数据面 total=0（无泄露）、
ARC 集合对 member 全 403（ARC 无越权）。

**不做任何角色清理**（用户明令「不执行全局角色清理，不修改既有工单 ACL」）。
「member × ARC = 0」这条验收口径**成立**：ARC 移动页 `n5c25yq5qlt` / `97x481j2bv1`
对 member 授权 = 0，ARC 集合 ACL = 0，实测 403。
