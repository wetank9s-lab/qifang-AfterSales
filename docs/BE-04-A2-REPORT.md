# BE-04-A2 模型挂载与 Seed 来源调查报告

> 日期：2026-10-20 · 状态：**只读调查完成；定位仍未收敛；未删除、未改 schema**
> 依据用户 §五：「两条方向均无法提供可靠定位方式 → 立即停止，提交技术阻塞报告」。

---

## 1. 查到了什么（四条硬事实）

### 1.1 页面加载链路（持久化侧）

```
desktopRoutes (title=所有工单, type=flowPage)
  schemaUid = 9ia6p1dx2wp        ← 其实是 **RouteModel 占位** {"schema":{"use":"RouteModel"}}
  └─ flowModels.ws4zfxaidoy      ← RootPageModel，parentId = 9ia6p1dx2wp
       └─ subModels.tabs[0]      ← RootPageTabModel uid=6dbu7gadt9j
            └─ subModels.grid    ← BlockGridModel（含 filterManager）
                 └─ filterManager[] = [{filterId, targetId, filterPaths}]
                      └─ filterId → FilterFormItemModel（createdAt 那一项）
```

**关键点**：`filterManager` 本身就存着 `筛选项 uid → 目标字段` 的映射，
这正是运行时 `ctx.filterManager` 用的那份数据。

### 1.2 `applyBlueprint` 的响应树里有什么

完整应用（`mode=replace`）时，响应 `data.surface.tree` 含：

```json
{"use":"RootPageModel","uid":"ws4zfxaidoy",
 "subModels":{"tabs":[{"uid":"6dbu7gadt9j","use":"RootPageTabModel",
   "subModels":{"grid":{"use":"BlockGridModel",
     "filterManager":[{"filterId":"vk8ww52pm5j","targetId":"kdjo0ewpd7u","filterPaths":["createdAt"]}, ...]}}}]}}
```

⇒ **Seed 确实能拿到本次创建的 uid**（这就是你 §四 的"结果 2"）。

但实测两处不一致：
- `--only 所有工单` 时，响应树**只有根节点**（`subModels` 为空）；
- 全量 seed 时树完整，但按 `filterPaths` 含 `createdAt` 取出的是 **7 个不同 filterId**。

### 1.3 `flowModels:list` 的返回形态

返回的是**扁平化模型**（`options` 已展开到顶层）：
`{ uid, use, stepParams, filterManager, subKey, parentId, sortIndex, ... }`

按 `use='BlockGridModel'` + `filterManager` 含 `createdAt` 过滤，同样得到 **7 个**。
原因：**多个页面都有「创建日期」筛选项**（我的门店工单、事件时间线、派工记录…），
它们的 `filterPaths` 都含 `createdAt`。

### 1.4 数据库侧的差异（这是唯一"收敛"的线索）

```sql
-- BlockGridModel 的 filterManager 里含 createdAt 的条数
select uid, count(*) from flowModels
where options->>'use'='BlockGridModel' ...
```

| uid | 含 createdAt 的条数 | filterManager 总数 |
|---|---|---|
| `1adr5krrbkz` | **1** | 7 |
| 其它 9 个 BlockGridModel | **0** | **0** |

**含义**：历史残留的那块 grid（`k20m3m6n59x` / 新 `rw5nkr0epr0` 之外的）
它的 `filterManager` 是**空的** —— 所以它既没有映射、运行时也不会被使用。

> 这一条同时解释了"为什么两套 grid 结构对称但只有一套生效"：
> **生效的那套有 filterManager 映射，残留那套没有。**

---

## 2. 为什么仍不能当作可靠定位

`filterManager.filterPaths` 只能说明"这个筛选项映射到 createdAt"，
**不能说明它属于哪个页面**——7 个页面都有日期筛选。

要收敛到「所有工单」，还需要一层"页面归属"：
- grid 的 `parentId` 在 DB 里是**空**（前面已验）；
- `flowModels:list` 的 `parentId` 也拿不到可靠的页面链；
- 响应树里虽然有 `tabs → grid` 的结构，但全量 seed 时 `findTargetUid` 递归到的却是 7 条
  （说明响应树里不止一个 grid，或者我的递归把其它 tab 的 grid 也算进来了——**未定论**）。

**按你 §五，这属于"无法提供可靠定位方式"，我不继续猜。**

---

## 3. Seed 来源：能拿到 uid，但拿不到"这一条属于本页"

| 项 | 结论 |
|---|---|
| `applyBlueprint` 是否返回创建的 uid | **是**（`data.surface.tree` 含完整子节点 uid） |
| 是否含 `filterManager` 映射 | **是**（完整应用时） |
| 能否直接据此定位唯一 createdAt 项 | **不能**（见 §2，7 条候选） |
| 是否依赖固定 uid | 否（都是本次响应里的 uid） |
| 是否可幂等 | 设计上可以（已替换则 noop），但定位没收敛前无意义 |

---

## 4. 已实现但**未启用**的东西

`scripts/patch-be04-date-model.mjs`（已接入 seed 的「所有工单」分支）：

- 优先用响应树的 `filterManager`；
- 回退用 `flowModels:list`；
- **匹配不到 / 匹配多个 → 返回失败，seed 计为未达标**（不静默）。

当前实际效果：**seed 会报 `✗ 所有工单 日期模型补丁失败（multiple-targets:…）`，整体退出码非 0**。
这是"诚实失败"，不是通过。

同时补丁里的 `collectKeys` 调试函数还留着（只在失败时返回，不影响生产路径）。

---

## 5. 可行的收口方向（需你裁决）

| | 做法 | 说明 |
|---|---|---|
| **D1** | 用 `targetId` 反查表格节点：取 `filterManager[].targetId` → 找那个 `TableBlockModel` 的 `collection`，只保留 `serviceTickets`，再叠加"该 grid 的 `filterManager` 长度=7" | 可能收敛到 1，但"门店工单"页也是 serviceTickets，仍可能 2 个 |
| **D2** | 从 `desktopRoutes` → `schemaUid` → `ws4zfxaidoy` 逐层读 `subModels`（用 `flowModels:get` 拉每个节点），而不是一次拉全表 | **最正统**：真正沿页面树走，天然只命中本页 |
| **D3** | 清理残留 grid（回到 A1，需你另行批准） | 已经被否 |

**我建议 D2**：`flowModels:get` 是逐节点读取，从 `ws4zfxaidoy` 开始按 `subModels` 往下走，
走到 `BlockGridModel` 再读 `filterManager` —— 这条链**只经过本页的节点**，
不会碰到别的页面，也不需要删数据。

本轮没做 D2 的原因：它需要多次 `flowModels:get`（约 20-30 次），
而本轮的目标是"调查 + 报告"，我不在没确认方向前扩大实现。

---

## 6. 当前环境状态

| 项 | 值 |
|---|---|
| 数据库 | 本轮**未删除、未改 schema** |
| `bvcrjww2fny` 等旧 uid | 已随 seed 重建变化（不复用） |
| 日期组件 | 仍可工作（上一轮手工切换的那条，若已被 seed 重建则退回原生） |
| seed 现状 | **会报补丁失败**（诚实失败），页面本身应用成功 |
| 构建 | 未动 |
| Git | 未 commit / 未 push |

---

## 7. 未解决的技术风险

1. 页面归属无法从 `flowModels` 单表给出（grid 无 parentId）；
2. `applyBlueprint` 在 `--only` 与全量模式下返回的树**不一致**（前者被简化）；
3. 若将来有第二个页面也用 `serviceTickets` + `createdAt`，D2 之外的方案都会歧义。
