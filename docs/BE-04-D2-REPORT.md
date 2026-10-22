# BE-04-D2 + Seed 幂等 + UI 闭环 验收报告

> 日期：2026-10-20 · 状态：**D2 PASS / Seed 幂等 PASS / UI 闭环 7-8（清除日期有真 bug）**
> 未 commit / 未 push。

---

## 1. D2 定位：PASS

实际执行链（可审计）：

```
route(schemaUid=9ia6p1dx2wp)
  → flowSurfaces:get?pageSchemaUid=… → root(ws4zfxaidoy)
    → grid(odsge0n9gt6)
      → filterManager 中 filterPaths=["createdAt"] 的 filterId
        → flowModels:update { use: BE04DateRangeFilterItemModel }
          → 回读确认
```

两次 seed 的 filterId 分别是 `4h4snvxkqfe` 与 `osjoedi0u78`——**uid 变了，定位仍然成功**。

### 关键接口发现

| 接口 | 结论 |
|---|---|
| `applyBlueprint` 响应树 | `--only` 下只有根节点，不可作稳定来源 |
| `flowModels:get` | **不含 subModels** |
| `flowModels` 的 parentId | grid/tab 都没有（表里无持久化父子） |
| **`flowSurfaces:get?pageSchemaUid=`** | ✅ 返回完整页面树（含 `grid.filterManager`），GET 即可 |

### 两个实测坑（已写进注释）

1. `subModels` 是**容器对象**（`{tabs:[…]}`），必须遍历它的**值**，否则一个子节点都遍历不到；
2. seed 的 `api()` **默认 POST**，`flowSurfaces:get` 只认 GET。

---

## 2. Seed 幂等：PASS（两次）

| 次 | 结果 |
|---|---|
| 第一次 | `✓ 日期模型已切换 → filterId(4h4snvxkqfe)`，`0 项未达标` |
| 第二次 | `✓ 日期模型已切换 → filterId(osjoedi0u78)`，`0 项未达标` |

`--only` 与完整 seed 都走同一套定位。补丁失败会 `failures += 1` 并 `continue`，**不会静默宣布成功**。

---

## 3. UI 闭环：7 / 8

`scripts/verify-be04-date-ui.mjs`（真实浏览器 → 请求 → `meta.count` → SQL）：

| 用例 | 结果 |
|---|---|
| 本月：请求带 `$dateNotBefore` + `$dateBefore`（无 `$dateOn`） | ✅ |
| 本月：`meta.count` == SQL | ✅ |
| 今天：同上 | ✅ |
| 清除日期：界面回到「未设置」 | ✅ |
| **清除日期：请求不再带 createdAt** | ❌ **未通过** |

### ❌ 真 bug：清除日期没有真正移除过滤组

现象（实测）：

```
点「清除日期」→ 确实发出了新的 serviceTickets:list 请求（n=1）
但该请求 **仍然带** createdAt 过滤条件
界面文案却已变成「未设置日期筛选（显示全部）」
```

这正是你明令禁止的"UI 显示未设置、实际仍在筛选"。

初步定位：`resource.removeFilterGroup('be04.createdAtRange')` 调用后，
随后的 `refresh()` 仍带着该条件 —— 说明 `removeFilterGroup` 的 key 语义与我 `addFilterGroup` 时用的 key **不匹配**（或它移除的是"组"而主 filter 已被合并污染）。

**没有修完，所以不申请 PASS。** 下一步需要：
1. 清除后打印 `resource.getFilter()`，确认残留形态；
2. 若 `removeFilterGroup` 无效，改用 `setFilter()` 重建"仅含其它条件"的 filter，或确认 key 的正确用法。

---

## 4. 其他已验证（沿用历史，未重跑）

- 日期纯函数 17/17（含闰年/跨年/起晚于止）；
- 日期函数反向变异：15/17 红，还原 17/17；
- 服务端日期语义 12/12（6 个边界夹具 + SQL 对照）；
- 服务端筛选 25/25、五档 31/31、四角色 13/13、门店列 8/8（均为本轮之前的证据，**未在本轮重跑**）。

---

## 5. 未完成清单

| 项 | 状态 |
|---|---|
| 清除日期（真移除过滤组） | ❌ 真 bug |
| 按日 / 按年 / 自定义 的端到端点击 | ❌ |
| 五个快捷逐个点 | ❌（只点了本月、今天） |
| 日期 + 门店/状态/类型组合 | ❌ |
| 重置全部筛选 | ❌ |
| 分页回第一页 | ❌ |
| 刷新 / 重新登录后状态一致 | ❌ |
| 五档 / 四角色 / 其它页面回归（本轮） | ❌ |

---

## 6. 改动与回退

| 项 | 值 |
|---|---|
| `scripts/patch-be04-date-model.mjs` | 重写为 D2（页面树定位），已接入 seed |
| `scripts/seed-admin-pages.mjs` | 加 import + 应用后调用；失败计未达标 |
| `client/date-range-item-model.tsx` | 日期条组件（上轮已完成，本轮未改） |
| `client/date-range.mjs` | 日期纯函数（上轮 17/17） |
| 页面 schema | 仅该一个模型 `use` 被改（可重复、可撤销） |
| 数据 | 未删除任何 grid / 模型 |
| Git | 未 commit / 未 push |
