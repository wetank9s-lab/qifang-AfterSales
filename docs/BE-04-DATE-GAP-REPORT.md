# BE-04-DATE 技术差距报告（第二轮）

> 日期：2026-10-20 · 结论：**接口存在，但注册/取值缺两项能力 ⇒ 未实施产品代码，DATE 继续 HOLD**

---

## 1. 精确版本与环境

| 项 | 值 |
|---|---|
| NocoBase | **2.2.15**（`@nocobase/plugin-flow-engine`） |
| 包位置 | `/app/nocobase/node_modules/@nocobase/...`（容器内） |
| 官方文档（**本地就有**） | `@nocobase/plugin-flow-engine/dist/ai/docs/runjs/context/filter-manager.md` |
| 同款接口的真实使用者 | `@nocobase/plugin-block-tree/dist/client/index.js` 里调 `refreshTargetsByFilter` |

之前"dist 里搜不到 `filterManager`"是我搜错了目录 —— 实际在 `@nocobase/app/dist/client/*.js` 与上述 md 里。

---

## 2. 官方接口在本地版本的可用性（逐条对照）

| 文档接口 | 本地是否存在 | 证据 |
|---|---|---|
| `ctx.filterManager` | ✅ | 文档 md + app bundle 符号 |
| `getFilterConfigs()` | ✅ **已实跑** | 返回 7 条配置（见 §3） |
| `addFilterConfig({filterId,targetId,filterPaths,operator})` | ⚠️ **存在但返回 403** | 实跑：`ERR Request failed with status code 403` |
| `refreshTargetsByFilter(filterId)` | ✅ **已实跑** | 返回 ok |
| `removeFilterConfig` / `bindToTarget` / `getConnectFieldsConfig` | 文档列出（未逐个跑） | md |
| `FilterModel.getFilterValue()` | ✅（文档要求） | md「FilterModel 必须实现 getFilterValue」 |

### 3. 关键收获：筛选源的真实映射（实跑 `getFilterConfigs()`）

```
targetId = 4tjsnf2d0yp   （「所有工单」表格模型 uid）

{"filterId":"mbqrpm558sz","targetId":"4tjsnf2d0yp","filterPaths":["createdAt"]}   ← 日期
{"filterId":"qww5f7ft5xc","targetId":"4tjsnf2d0yp","filterPaths":["store.id"]}
{"filterId":"69uf94ooykm","targetId":"4tjsnf2d0yp","filterPaths":["ticket_type"]}
{"filterId":"pv853hbahup","targetId":"4tjsnf2d0yp","filterPaths":["status"]}
{"filterId":"yey8dud96nz","targetId":"4tjsnf2d0yp","filterPaths":["ticket_no"]}
{"filterId":"txjuoq0yihn","targetId":"4tjsnf2d0yp","filterPaths":["customer_name"]}
{"filterId":"pk7f5pwiihj","targetId":"4tjsnf2d0yp","filterPaths":["customer_mobile"]}
```

**`createdAt` 的筛选源已经存在**（`mbqrpm558sz`），这印证了你的判断：
不需要新增 source，只要能**给这个 source 设值**就行。

---

## 4. 第一方案（复用现有 createdAt 表单）：**实测不可行**

做了两步真实试验：

| 步骤 | 结果 |
|---|---|
| 取 `FilterFormBlockModel.form` | 有 `form` 实例，`setFieldValue` / `submit` 都是 function |
| `form.getFieldsValue(true)` | **`{}`（空对象）** —— 这个 form **没有任何字段** |
| `form.setFieldValue('createdAt', ['2026-10-01','2026-11-01'])` | 调用成功，`getFieldsValue` 里出现了该键 |
| `form.submit()` | **请求无 filter**：`serviceTickets:list?appends[]=store&sort[]=-createdAt&page=1&pageSize=20`，行数仍 20 |

**结论**：filterForm 不是普通 antd Form —— 每个筛选项是**独立的 FilterModel**，各自持值；
往容器 form 里塞字段是"无主字段"，提交时没人认领。

**这条路径不是"键名写错"，而是结构上不成立。** 我不会再用它。

---

## 5. 第二方案（本页受控 FilterModel）：接口在，但缺两步

按官方文档，需要：

1. 定义一个模型实现 `getFilterValue()`；
2. `addFilterConfig({ filterId: 本模型 uid, targetId: '4tjsnf2d0yp', filterPaths: ['createdAt'] })`；
3. 值变化时 `refreshTargetsByFilter(本模型 uid)`。

实跑发现两个卡点：

| 卡点 | 现象 | 判断 |
|---|---|---|
| **A. `addFilterConfig` 返回 403** | 直接调用即 403 | 它可能默认**持久化**到后端，而当前角色没有写 flow-surface 配置的权限。需确认是否支持 `persist: false`（文档只在 `removeFilterConfig` 里写了 `persist`，`addFilterConfig` 未写） |
| **B. 拿不到现有 FilterFormItemModel 实例** | 从 `TableBlockModel.__allModels` 取，返回**空** | 现有 7 个 source 的模型实例不在表格模型的 `__allModels` 里，运行时无法从表格侧反查，也就无法给 `mbqrpm558sz` 设值 |

> A、B 任一解决，第一或第二方案就能通。**现在是两个都没解决**，所以停下来报告，而不是硬试。

---

## 6. 若做"项目内最小适配层"，需要改什么

| 文件 | 改动 | 影响面 |
|---|---|---|
| `nocobase/plugins/service-ticket/src/client/date-range-filter-model.tsx`（新增） | 一个 FilterModel：渲染 `[按日][按月][按年][自定义]` + 五个快捷；实现 `getFilterValue()` 返回 `{createdAt: {$gte,$lt}}`（Asia/Shanghai 半开） | 仅本页 |
| `src/client/index.ts` | `engine.registerModels({ DateRangeFilterModel })`（已有注册模式，风险低） | 不影响其它页面 |
| `scripts/seed-admin-pages.mjs` | 在「所有工单」tab 的 filterForm 里加一个该模型的字段 | **只改本部页面**；但 touch 通用 builder，需要回归另外 4 个页面 |
| 页面 schema | 一次 `--only 所有工单` 应用 | 可回退（快照 + seed 幂等） |

**如果 A（`persist:false`）成立**，甚至可以不改 schema：在现有 filterForm 上加一个"日期模式"区块即可。

---

## 7. 回退与验证

- 回退：删掉新模型 + 撤销 seed 改动；或回灌 `backups/be04-pre-snapshot-1050.sql`；
- 验证：`verify-be04-all-tickets`（25 条服务端语义）保持不变，新增一条"日期条件进入 HTTP filter"的断言。

---

## 8. 需要你裁决的一件事

我建议**先做 30 分钟的"卡点 B/A"小实验**（不改产品代码，只在运行时验证）：
1. `addFilterConfig({..., persist: false})` 是否不再 403；
2. 用 `flowEngine.getModel(uid)`（若存在）能否直接拿到 `mbqrpm558sz` 实例。

任一成功 ⇒ 第二方案可落地，我再提交完整实现计划；
两者都失败 ⇒ 该版本确实没有可用的局部注入点，只能走框架侧支持。

本轮**产品代码零改动**，等这个裁决。
