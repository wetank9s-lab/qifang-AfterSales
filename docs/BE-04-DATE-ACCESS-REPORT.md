# BE-04-DATE 技术接入点确认报告

> 日期：2026-10-20 · 结论：**接入点已确认（第一方案成立）**，但**日期语义仍需校准**，本轮未写产品组件
> 未 commit / 未 push。

---

## 1. 一句话结论

用**官方表单 API** 就能把日期条件送进真实查询：

```
FilterFormBlockModel.form.setFieldValue('createdAt_mbqrpm558sz', ['2026-10-01','2026-10-31'])
→ FilterFormItemModel.doFilter()
→ GET /api/serviceTickets:list?filter={"$and":[{"createdAt":{"$dateOn":[...]}}]}
```

**请求确实带上了 createdAt 条件**。这不是 DOM 操纵，也不是前端假过滤。

---

## 2. 与上一轮"阻塞"结论的差异（如实修正）

上一轮我写"没有可注入 filter 的接口"，那是**基于错误的前提**：

| 上一轮的判断 | 实际情况 |
|---|---|
| 往 `form.setFieldValue('createdAt', ...)` 写，请求没 filter | 字段名不是 `createdAt`，而是 **`createdAt_mbqrpm558sz`**（字段名带 filter 项 uid 后缀） |
| `FilterFormBlockModel.form.getFieldsValue()` 是 `{}` | 那是**未按真实字段名**读；用真名写入后，`doFilter()` 能正确组参 |
| `activeFilterSources` 只有 setFilterActive | 真正驱动查询的是 **`FilterFormItemModel.doFilter()`**，不是表格模型 |

**修正记录**：上一轮的"无接口"结论作废，改为"有接口，但需要正确的字段名与触发方法"。这条已写进本文，不掩盖。

---

## 3. 关键结构（实跑取到）

```
targetId（表格模型 uid）= 4tjsnf2d0yp
createdAt 的筛选源：
  filterId  = mbqrpm558sz
  type      = FilterFormItemModel
  operator  = $dateOn
  subModels = { field: DateTimeTzFilterFieldModel }
  props.name= createdAt_mbqrpm558sz        ← 表单字段名
  filterField.name = createdAt             ← 目标字段
  defaultTargetUid = 4tjsnf2d0yp
  stepParams.__flowSurfaceMeta.declaredKey = all.all-search.createdAt
```

其余 6 个筛选项同样是 `FilterFormItemModel`，filterId 与字段：
`qww5f7ft5xc→store.id`、`69uf94ooykm→ticket_type`、`pv853hbahup→status`、
`yey8dud96nz→ticket_no`、`txjuoq0yihn→customer_name`、`pk7f5pwiihj→customer_mobile`。

---

## 4. 实跑证据

| 步骤 | 结果 |
|---|---|
| `flowEngine.getModel('mbqrpm558sz')` | 取到 `FilterFormItemModel` |
| `block.form.setFieldValue('createdAt_mbqrpm558sz', ['2026-10-01','2026-10-31'])` | `ok` |
| `item.doFilter()` | 触发刷新 |
| 实际请求 | `serviceTickets:list?filter={"$and":[{"createdAt":{"$dateOn":["2026-10-01","2026-10-31"]}}]}&appends[]=store&sort[]=-createdAt&page=1&pageSize=20` |
| 表格行数 | 20（pageSize 上限，**需进一步确认是真过滤还是恰好一页**） |

---

## 5. 还差的一步：日期语义校准（当前不算完成）

`operator` 当前是 **`$dateOn`**，值传的是 `["起","止"]`。
`$dateOn` 在 NocoBase 里通常是"某一天"语义，**不是区间**。所以：

- 必须确认正确操作符：`$dateBetween` / `$dateOn` 配合数组 / 或 `$gte + $lt` 两个条件；
- 必须确认**结果真的按区间过滤**（用 `meta.count` 与 SQL 对比，不能只看 pageSize=20 的行数）。

**这一步没做完，所以我不说"DATE 已经跑通"，只说"接入点已通"。**

---

## 6. 实现方案（下一轮可执行，改动很小）

### 6.1 组件形态

在 `client/` 新增一个**本页专用**的 `DateRangeFilterModel`（继承现有 `FilterFormItemModel` 或等价基类）：

- 渲染：`[按日][按月][按年][自定义]` + `[今天][昨天][本月][上月][本年]` + 当前生效范围文本；
- 内部维护**唯一一份**日期状态（四模式互斥，切换时清空上一模式）；
- 变化时：`form.setFieldValue('createdAt_mbqrpm558sz', [start, end])` → `doFilter()`；
- 日期计算为**纯函数**（Asia/Shanghai 半开区间），与 `verify-be04-all-tickets` 的 SQL 基准同一口径。

### 6.2 为什么这是"最小扩展"

| 项 | 说明 |
|---|---|
| 复用现有筛选源 | 用 `mbqrpm558sz`，**不新增 filterId**（也就不需要 `addFilterConfig`，避开它的 403） |
| 不改通用 builder | 只在本页注册一个新模型（`engine.registerModels`，项目已有先例） |
| 不影响其它页面 | 模型只挂在「所有工单」 |
| 可回退 | 删模型 + 撤 seed 字段，或回灌快照 |

### 6.3 需要确认的技术点（下一轮前 30 分钟）

1. `$dateOn` 的准确语义与数组用法；
2. 是否存在 `$dateBetween`；若没有，改用两个条件 `{$gte, $lt}` 的组合写法（`getFilterValue()` 返回对象即可）；
3. `meta.count` 与 SQL 对比，证明真过滤。

---

## 7. 本轮改动

| 项 | 结果 |
|---|---|
| 产品代码 | **零改动** |
| 页面 schema | 未改 |
| 脚本 | 新增 5 个只读探针（`proto-*.mjs`），均在 `.tmp-verify/` |
| 快照 | `backups/be04-pre-snapshot-1050.sql` 仍在 |

---

## 8. 建议

下一轮按 §6 实施（约 1 个组件 + 1 处注册 + 1 条门禁），先跑通"选本月 → 请求带 `$gte/$lt` → `count` 与 SQL 一致"，再补四模式与快捷 UI。
如果 §6.3 第 2 点证明**无法表达区间**，那才需要回到"框架侧支持"，届时我会给出具体缺失点。
