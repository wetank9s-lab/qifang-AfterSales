# BE-04-DATE 日期筛选 · 技术接入调查报告

> 日期：2026-10-20 · 结论：**未找到可注入 filter 的正式接口 ⇒ 本项继续 HOLD，未改产品代码**
> 本轮**没有**修改通用 builder，**没有**用 DOM 操纵或前端假过滤。

---

## 1. 先给结论

原生筛选链路已经**完整追踪清楚**，但 `TableBlockModel` 暴露的方法里
**只有"激活/移除已有筛选源"，没有"从外部注入一条新 filter"**。
因此"本页专用日期组件写进表格查询"这条路，在当前版本**没有正式接入点**。

---

## 2. 真实数据流（抓包 + 结构探查，不是看 dist 猜）

### 2.1 请求链（hq_admin，客户手机号=13800004881）

```
填入「客户手机号」→ 点「筛选」
→ GET /api/serviceTickets:list
    ?filter={"$and":[{"customer_mobile":{"$includes":"13800004881"}}]}
    &appends[]=store&sort[]=-createdAt&page=1&pageSize=20&tree=false
→ 200，表格行数 20 → 1
```

点「重置」：

```
→ GET /api/serviceTickets:list?appends[]=store&sort[]=-createdAt&page=1&pageSize=20
   （filter 参数消失）→ 行数回到 20
```

**结论**：筛选最终就是 URL 上的 `filter` JSON；重置=去掉该参数。**服务端执行**，前端只发参数。

### 2.2 状态载体（React fiber 只读探查）

从表格 DOM 的 fiber 向上找到 `TableBlockModel` 实例：

| 项 | 实测 |
|---|---|
| `activeFilterSources` | **Map**，size=7（对应 7 个筛选项），value 全为 `false`（未激活） |
| 可用方法 | `setFilterActive`、`hasActiveFilters`、`removeFilterSource`、`refresh`、`resetAfterFilterChange`、`getFilterFields`、`addAppends` |
| **缺的方法** | **`addFilterSource` / `setFilter` / `setFilterParams` 均不存在** |
| `context` | `resourceName`、`resource` |

---

## 3. 逐条回答你 §三 的六个问题

| # | 问题 | 答案 | 依据 |
|---|---|---|---|
| 1 | 原生筛选组件调用哪个方法 | filterForm 提交 → 表格模型把对应 source **激活**（`setFilterActive`），再 `refresh()` | `activeFilterSources` 是 Map、值 `false`→激活后变 true 的行为；方法名 |
| 2 | 查询状态存在哪 | `TableBlockModel.activeFilterSources`（Map，key=field uid） | fiber 探查 |
| 3 | 表格请求从哪读参数 | 同一 model 的 `refresh()` 组参 → 发出 `serviceTickets:list?...&filter=…` | 抓包 |
| 4 | 是否有受支持的扩展接口 | **部分有**：`setFilterActive` / `removeFilterSource` / `refresh` 是公开方法；**但没有"新增 filter 源"的方法** | 原型链枚举 |
| 5 | 能否把外部日期范围与其它条件组合 | 若它成为一个 source，则天然按 AND 组合（现有 7 个就是 AND）；**问题是我无法新增 source** | `activeFilterSources` 结构 |
| 6 | 能否本页注册独立模型而不影响其它页面 | **能**（`engine.registerModels`，项目已在用）；但注册的模型只能渲染 UI，**改不动 filter** | `client/index.ts` 现有注册 |

---

## 4. 三个可选方案（含成本与风险）

| | 方案 B：自定义日期条 + 注入 filter | 方案 C：本页独立查询块 | 方案 E：在 filterForm 注册更多日期字段 |
|---|---|---|---|
| 做法 | 注册 `DateRangeBarModel`，调用 model 写 filter | 自建一块"日期+表格"，直接调 `serviceTickets:list` | 在 filterForm 里加 `createdAt` 的多个字段（日/月/年各一个） |
| 可行性 | ❌ **阻塞**：无 `addFilterSource`/`setFilter` | ✅ 可行 | ✅ 可行（但受控件形态限制） |
| 四模式互斥 | 能 | 能 | 勉强（变成多个并列字段，不是"模式切换"） |
| 快捷（今天/昨天/本月/上月/本年） | 能 | 能 | ❌ 做不了（控件无 presets） |
| 与现有条件 AND | 能 | 能（自己拼 filter） | 能 |
| 复用行级 ACL / 分页 / 排序 | 自动 | **要自己实现**（风险高） | 自动 |
| 改动面 | 1 个组件 + 1 处注册 | 新表格块 + 分页 + 列渲染 + 权限对齐 | 改通用 builder（5 个页面受影响） |
| 风险 | 低（若接口存在） | **高**：两套表格容易漂移，ACL 要重新证明 | 中：影响其它页面 |

**我的建议**：若要继续，优先争取方案 B 的**框架侧支持**（或确认是否存在未公开的 `setFilter`）；
在不改框架的前提下，方案 E 是唯一"低风险但不完整"的选项，**不能声称满足四模式/快捷**；
方案 C 不建议（等于把"所有工单"再实现一遍）。

---

## 5. 本轮实际动作

| 项 | 结果 |
|---|---|
| 产品代码 | **零改动** |
| 页面 schema | 未改（DATE 未落库） |
| 新增脚本 | `audit-be04-filter-flow.mjs`（只读追踪）、`audit-be04-screenshot.mjs`（截图与归因） |
| 快照 | 仍在 `backups/be04-pre-snapshot-1050.sql` |

---

## 6. 需要你决策的点

三条路选一条（我不会自行选择扩大改动面）：

1. **接受方案 E**：只做"日期范围"字段（能自定义起止，无四模式/快捷），并明确 BE-04 的日期要求降级；
2. **要求框架侧支持**：由我提交一份"需要 `setFilter`/`addFilterSource` 接口"的说明，等 NocoBase 升级或补丁；
3. **接受方案 C**：本页独立查询块（我需要在动手前先出设计与风险评估，并单独验收）。
