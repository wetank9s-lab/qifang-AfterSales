# SEC-HIST-01 / HQ-HIST-01 修复报告

> 日期：2026-10-20 · 状态：**两项均已修复并验证；数据零变更**
> 未 commit / 未 push。

---

## 1. 两个根因

### SEC-HIST-01：按"上传者"授权，不是"归属门店"

`historicalArchives` / `historicalArchiveQuery` 都用：

```ts
const visible = await store.listBatchesForActor(uploader, 500);
if (!uploader.isHq) filter.batch_id = { $in: visibleIds };
```

而 `listBatchesForActor` 的过滤是：

```ts
{ uploader_user_id: actor.userId, visibility_scope: 'uploader' }
```

**它回答的是"这批数据是谁传的"，不是"这批数据属于哪家门店"。**

实测分叉：

```
id=1  → store_id=2(S02) · batch.store_id=2 · uploader=uat_store_a
```

→ A 能读 S02 的档案（越权），**B 读不到自己的**（`total=0`）。

### HQ-HIST-01：`isHqActor` 漏了 `hq_after_sales`

historical 模块**自己维护了一份**总部角色清单，与 `constants.ts` 的 `HQ_ROLES`（`hq_after_sales/hq_admin/viewer`）不一致：

```ts
// 修前
roles.includes(ROLE.HQ_ADMIN) || roles.includes('hq_service') || root/admin
```

⇒ `hq_after_sales` 被当成普通角色，走"按批次可见"分支，而它没传过任何批次 ⇒ **0 条**。

---

## 2. 修复

### 2.1 新增 `resolveArchiveScope(actor)`

只用于**历史档案读取**，规则 fail-closed：

| 角色 | 范围 |
|---|---|
| 平台超管 / root / admin | `all` |
| `hq_admin` / `hq_after_sales` | `all` |
| `store_after_sales` + 授权门店 | `stores(ids)` |
| 其余（**含 viewer**） | **`none`** |

两个 handler 改成：

```ts
const scope = resolveArchiveScope(actor);
if (scope.kind === 'none') return ok(ctx, { archives: [], total: 0 });
const base = { stage: 'archived' };
if (scope.kind === 'stores') base.store_id = { $in: scope.storeIds };   // ← 用归属门店
```

**不再用 `batch_id $in (按上传者)`。**

### 2.2 `isHqActor` 补 `hq_after_sales`

```ts
roles.includes(ROLE.HQ_ADMIN) || roles.includes(ROLE.HQ_AFTER_SALES) || ...
```

与 `HQ_ROLES` 对齐，**不是**用"角色名包含 hq"这种字符串判断。

### 2.3 影响面（哪些没动）

| 调用点 | 语义 | 是否改 |
|---|---|---|
| `historicalArchives`（档案列表） | 档案读取 | ✅ **改** |
| `historicalArchiveQuery`（本轮新增） | 档案读取 | ✅ **改** |
| `historical-import.ts:433`（预览可见批次） | **上传者**语义（谁传谁看自己的暂存） | ❌ 不动 |
| `historical-import.ts:586`（批次列表） | 上传者语义 | ❌ 不动 |
| `historical-review-archive.ts:414`（审核可见） | 上传者语义 | ❌ 不动 |

**只改了档案读取这一层**，批次/行/审核的上传者语义保持原样（那是"谁能看自己的暂存"，与"数据归属"是两件事）。

---

## 3. 验证（真实账号）

### 3.1 列表

| 角色 | HTTP | total | 实际门店 |
|---|---|---|---|
| **门店 A** | 200 | **122** | **只有 `S01`** |
| **门店 B** | 200 | **2** | **只有 `S02`** |
| hq_admin | 200 | 124 | 全部 |
| **hq_after_sales** | 200 | **124** | 全部（**修好**） |
| viewer | 200 | **0** | 无 |

**122 + 2 = 124**，与库内总数完全对上——不再有"多算"或"少算"。

### 3.2 跨店样本（id=1，S02 的数据，A 上传）

| 请求方 | 结果 |
|---|---|
| **门店 A** | **404**（修前是 200 + 客户名） |
| **门店 B** | **200**（B 终于能读自己的） |
| hq_admin | 200 |

### 3.3 原接口回归

`svc:historicalArchives`（P11-3 原接口）：

- 门店 A → **200，total=122，只有 S01**（修前是 77 且含 S02）

### 3.4 其他

| 项 | 结果 |
|---|---|
| 匿名 | **401** |
| viewer 写 | 沿用原后端口径（本修复未改任何写路径） |

---

## 4. 数据与回退

| 项 | 值 |
|---|---|
| 快照 | `backups/historical-before-sec-hist-01.sql`（11 MB，四表） |
| 基线 | batches 177 / rows 14 108 / archives 124 / conversions 26 —— **未变** |
| 改归属 | ❌ 未改任何 `store_id` |
| 新建工单 / 派工 / SMS | ❌ 无 |
| 转换记录 | ❌ 未动 |
| P11-3 算法 | ❌ 未改（只改读取授权） |

**回退方式**：把两个 handler 的 `resolveArchiveScope` 换回 `listBatchesForActor`，`isHqActor` 去掉 `HQ_AFTER_SALES`，重新 build + restart。**数据无需回滚**（本轮没写库）。

---

## 5. 结论

| 项 | 结果 |
|---|---|
| SEC-HIST-01 | ✅ 修复（A 404 / B 200 / A 列表只剩 S01） |
| HQ-HIST-01 | ✅ 修复（hq_after 124） |
| 原接口同类越权 | ✅ 同步修复 |
| 数据 | 零变更 |

**安全专项通过。**

按你 §七，接下来补：UI 详情/筛选/分页、五档布局、Seed 二次幂等、`No permissions` 归因——这四项还没做。
