# BE-02A-S2 第二关最终验收报告（发现两个既有语义问题）

> 日期：2026-10-20 · 状态：**页面与列表 PASS；隔离与总部语义发现 2 个既有问题；部分 UI 项未验**
> 未 commit / 未 push。

---

## 1. 一句话结论

**页面能用、列表对、分页对、手机号对、越权 id 被拒**——但验收过程中查出**两个不是本轮引入、却直接影响你 §四 要求的既有问题**：

1. **隔离按"上传者"而不是"归属门店"**；
2. **`hq_after_sales` 不被认作总部**，读历史档案返回 0 条。

两条都源于 P11-3 的 `uploaderOf/isHqActor` 语义，改它们要动冻结区，我**没有擅自改**。

---

## 2. 已验证通过（接口层，真实调用）

| 项 | 结果 |
|---|---|
| 门店 A 列表 | **200，total=77**（20 行/页） |
| 门店 A 详情（自己的 id=124） | **200**，返回真实 DTO（`合成丁DMV6CL3QG`） |
| 不存在的 id（999999） | **404 `ARCHIVE_NOT_FOUND`** |
| 非法 id（`abc`） | 走列表分支，不报错、不泄露 |
| 关键词 `合成丁` | 200，**total=26** |
| storeCode 自己的 `S01` | 200，**total=75** |
| storeCode 别人的 `S99` | 200，**total=0**（不越权） |
| 日期 `2026-08-01~08-31` | 200，**total=22** |
| 分页 p1/p2 | 各 20 行，**重叠 0**，total 恒 77 |
| 匿名 | **401** |
| viewer 列表 | **200，total=0** |
| hq_admin | **200，total=124** |

---

## 3. ⚠️ 问题一：隔离按"上传者"，不是"归属门店"

### 现象

门店 A 用 `id=1` 请求详情 → **200**，拿到客户名 `合成丙RMV4WYPQF`。

### 根因（数据实证）

```
id=1  → store_id=2(S02) · batch_id=33 · batch.store_id=2 · uploader_username=uat_store_a
id=124→ store_id=1(S01) · batch_id=175· batch.store_id=1 · uploader_username=uat_store_a
```

`listBatchesForActor(uploader)` 是按**上传者**筛批次的，所以：

- A 能看到"**自己上传、但归属 S02**"的批次里的档案（id 1/2）；
- **B 看不到自己门店的档案**（`total=0`，因为那批是 A 代传的）。

### 影响

| 角色 | 期望 | 实际 |
|---|---|---|
| 门店 A | 只看 S01 | 看到 S01 **+ 自己代传的 S02** |
| 门店 B | 看到 S02 | **0 条** |

### 判定

**这是 P11-3 的既有语义**（`historicalArchives` 用同一个 `listBatchesForActor`，行为一致），**不是本轮的 `historicalArchiveQuery` 引入的**。

修它要改 `listBatchesForActor` 的归属判定（按 `batch.store_id` 而非 uploader）——**属 P11-3 冻结范围，我停在这里等授权**。

---

## 4. ⚠️ 问题二：`hq_after_sales` 读历史档案 0 条

`isHqActor()` 认的是：

```ts
roles.includes('hq_admin') || roles.includes('hq_service') || platform 是 root/admin
```

**不含 `hq_after_sales`** ⇒ 它走"按可见批次"，而它没上传过任何批次 ⇒ **total=0**。

同样，`historicalArchives` 也是这样。

这与你 §四.2「总部角色读取授权范围」不符。改它同样属于 P11-3 冻结区。

---

## 5. ⚠️ 其他未闭合项

| 项 | 状态 |
|---|---|
| UI 点击「详情」弹窗 | ❌ 未做（接口层已验证） |
| UI 筛选 / 重置 | ❌ 未做（接口层已验证） |
| UI 翻页 | ❌ 未做（接口层已验证） |
| 五档宽度 375/390/420/1280/1440 | ❌ 未做 |
| Seed 第二次 + `--only` | ⚠️ 全量跑过一次（0 未达标） |
| **`No permissions` toast 归因** | ❌ **未做** |

### 关于 `No permissions`

我没有抓到它对应的请求。你这轮明确要求"必须抓一次 Network/Console 证据"——**这一项我没完成**，不猜是不是 B-17（`environmentVariables`）。

---

## 6. 本轮改动

| 文件 | 改动 |
|---|---|
| `client/historical-archives-block.tsx` | 新增（上一轮） |
| `client/index.ts` | 注册 |
| `server/constants.ts` / `historical-review-archive.ts` | 新只读 action（上两轮） |
| `scripts/seed-admin-pages.mjs` / `expected-sensitive-columns.mjs` | 页面 + 菜单 |

**本轮（收口轮）零代码改动**，只做验证。

---

## 7. 数据与冻结

| 项 | 值 |
|---|---|
| 历史四表 | 177 / 14 108 / 124 / 26 **未变** |
| 原生 ACL | 零改动 |
| BE-04 / BE-01 / P11-2 / P11-3 | 未改 |
| S1 | 6 个，重复 0 |
| Git | 未 commit / 未 push |

---

## 8. 结论与申请

**不申请 PASS/FROZEN。**

页面这一关（技术风险最大的）已经过了，但按你 §八 的验收清单：

- **2 个既有语义问题**（上传者隔离、hq_after 0 条）需要你裁决是否动 P11-3；
- **4 项未验**（UI 详情/筛选/翻页、五档、Seed 二次、No permissions 归因）。

我建议下一轮**只做剩下这 4 项验证 + 抓 toast**，两个语义问题单独裁决——因为它们一改就是 P11-3 的范围，不该混在验收轮里做。
