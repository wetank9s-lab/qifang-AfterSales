# BE-02A-V1 报告：`collections:listMeta` 裁剪逻辑（根因已定位到源码行）

> 日期：2026-10-20 · 状态：**根因确定；本轮只读，未做任何修改**
> 未 commit / 未 push。

---

## 1. 一句话根因

**裁剪不是框架做的，是我们自己的中间件做的。**

`nocobase/plugins/service-ticket/src/server/middleware/collection-metadata-scope.ts`：

```ts
export const COLLECTION_METADATA_ALLOWLIST: readonly string[] = [
  'serviceTickets', 'serviceVisits', 'ticketEvents', 'stores',
];
export const HQ_ADMIN_EXTRA_ALLOWLIST: readonly string[] = ['serviceSettings'];
```

**正向白名单**——白名单之外的集合，元数据直接被丢弃。

---

## 2. 完整链路（源码 + 行号）

### 2.1 框架侧：`listMeta` 本身不按角色过滤

`@nocobase/plugin-data-source-main/dist/server/resourcers/collections.js:113`

```js
async ["collections:listMeta"](ctx, next) {
  const db = ctx.app.db;
  const results = [];
  db.collections.forEach((collection) => {
    if (!collection.options.loadedFromCollectionManager) return;   // 唯一的过滤条件
    results.push({ ...collection.options, fields: [...] });
  });
  ctx.body = sortBy(results, "sort");     // ← 全量 27 条 → ctx.body
}
```

**它给的是全量 27 条，且没有任何角色判断。**

### 2.2 我们的中间件：把 27 条投影成 4/5 条

`middleware/collection-metadata-scope.ts`：

| 行 | 内容 |
|---|---|
| **60** | `COLLECTION_METADATA_ALLOWLIST = ['serviceTickets','serviceVisits','ticketEvents','stores']` |
| **81** | `HQ_ADMIN_EXTRA_ALLOWLIST = ['serviceSettings']` |
| **113–123** | `referencesOutsideAllowlist()` —— 字段里引用了白名单外集合的，**该字段也丢** |
| **139–146** | `projectCollection()` —— `if (!allow.has(name)) return null;` |
| **168–177** | `projectListMetaBody(body, allowList)` —— 数组 / `{data:[]}` 两种形状都处理 |
| **SCOPED_RESOURCE/SCOPED_ACTION** | 只对 `collections` × `listMeta` 生效 |
| **`hasPlatformRole()`** | `root` / `admin` **直接跳过**本层（所以超级管理员是 27 条） |

### 2.3 数量对得上，逐项吻合

| 角色 | 白名单 | 预期 | 实测 |
|---|---|---|---|
| admin / root | 跳过投影 | 全量 27 | **27** ✅ |
| hq_admin | 4 + `serviceSettings` | 5 | **5** ✅ |
| hq_after_sales | 4 | 4 | **4** ✅ |
| store_after_sales | 4 | 4 | **4** ✅ |
| viewer | 4 | 4 | **4** ✅ |

**理论与实测完全一致，无残留疑点。**

---

## 3. 为什么 P1 的 36 条 ACL 一点用都没有（§五 要求解释）

因为 **P1 改的是"能不能读记录"，而这里卡的是"能不能看到集合元数据"，两件事在两个地方**：

| 层 | 谁管 | 位置 |
|---|---|---|
| **元数据可见性**（listMeta 里有没有它） | `COLLECTION_METADATA_ALLOWLIST` | 本项目中间件 |
| **记录读取权限**（能不能 select 出数据） | `dataSourcesRolesResources*` | NocoBase ACL |

P1 只动了下面那层，**上面那层根本没放行**，所以 listMeta 一条都没变。

同理，`NATIVE_READ_ALLOWLIST` 只影响 `native-metadata-guard`（它拦的是 `collections:list` 的 403），也碰不到 listMeta。

**结论：P1 的假设方向错了一层，不是"权限没配好"，是"元数据被自己的白名单截断了"。**

---

## 4. §六 的两种读取权限（已区分清楚）

| | A. 元数据可见性 | B. 记录读取 |
|---|---|---|
| 决定者 | `COLLECTION_METADATA_ALLOWLIST` | ACL 资源 + 动作 |
| 现状 | 历史集合**不在**白名单 | 历史集合**也没有** ACL（P1 加过又回滚） |
| 只改 A 的后果 | 页面能渲染出表格 | **但一查就 403**，或者被 storeScope 拦住 |
| 只改 B 的后果 | 页面仍显示"数据表已被删除" | 数据能读但界面不认 |

**两者必须同时配，且行级隔离还要第三层（`SCOPED_RESOURCES`）。**

---

## 5. 最小修复方案（本轮不实施，等授权）

三张表分三步走，**每一步都有明确前置**：

### 第一步：元数据可见（必须）

`COLLECTION_METADATA_ALLOWLIST` 增加：

```
historicalServiceArchives, historicalImportBatches, historicalImportCandidates
```

> 不加 `historicalImportRows` / `historicalImportReviews` —— 它们没有 `store_id`，
> 一旦出现在元数据里，页面就能建表并直接查，**而 storeScope 当前不覆盖它们**。

### 第二步：记录读取 ACL（必须，P1 已验证过写法）

给 4 个角色 × 这 3 个集合加 `list` / `get` / `view`（**`view` 是 DEV-65 的已知要求**）。

P1 已经把 36 条写法跑通过（`dataSourcesRolesResources:create` + `...Actions:create`），可直接复用。

### 第三步：行级隔离（必须，否则不能给门店）

`store-scope.ts` 的 `SCOPED_RESOURCES` 增加这 3 个（`via:'self'`，它们都有 `store_id`）。

**没有这一步，第二步就是给门店开跨店读取。**

---

## 6. 为什么 `historicalImportRows` / `Reviews` 这次依然不碰

| 集合 | store_id | 现有 via 支持 | 结论 |
|---|---|---|---|
| Archives / Batches / Candidates | ✅ | ✅ `self` | 可放行 |
| **Rows / Reviews** | ❌（只有 `batch_id`） | ❌ 需新增 `via:'batch'` | **本轮不放行** |

按你 §六 的要求：**不能让门店通过原生接口读到别店数据**。
它们要放行，必须先给 `storeScope` 加 `via:'batch'`（`batch.store_id in scope`），那是另一处改动。

---

## 7. 本轮改动

| 项 | 值 |
|---|---|
| 代码 | **零改动**（只读） |
| 数据库 | 零改动 |
| ACL | 零改动（P1 已回滚，备份在 `backups/acl-before-p1.json`） |
| 历史四表 | 177 / 14 108 / 124 / 26 未变 |
| 历史页面 | 未重建 |
| Git | 未 commit / 未 push |

---

## 8. 结论

**根因：`COLLECTION_METADATA_ALLOWLIST` 只放了 4 个集合。**

不是框架限制、不是缓存、不是 ACL 没配对——是我们自己在 P11-0 为了"不让业务角色看到平台元数据"而做的正向投影，把历史集合一起挡在外面了。

**下一步（等你批）**：按 §5 的三步走，先白名单 → 再 ACL → 再 storeScope，然后重建历史档案页验证。
