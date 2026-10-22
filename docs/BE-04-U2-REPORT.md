# BE-04-U2 Builder 兼容扩展报告（可行性结论）

> 日期：2026-10-20 · 结论：**U2 的"对象形式指定组件"在当前框架下不被支持**
> 已还原试改，页面重新应用成功（0 项未达标）。未 commit / 未 push。

---

## 1. 一句话结论

`filterForm.fields` **确实接受对象**，但对象只认 **`fieldType` / `fields` / `titleField`**
（这三个是**关联字段展开**用的），**没有 `component`**。
所以"用字段配置指定 `daterange` 组件"这条路，前端 builder 再怎么写也没用——**是框架侧的解析不支持**。

---

## 2. 实测过程（不是猜）

### 2.1 试改

```js
fields: [
  { field: 'createdAt', component: 'daterange', props: {} },
  'store', 'ticket_type', 'status', 'ticket_no', 'customer_name', 'customer_mobile',
]
```

### 2.2 服务端返回

```
HTTP 400
[internal-field-keys-not-public] $.tabs[0].blocks[0].fields[0]
field objects must use public fieldType/fields/titleField keys;
remove internal keys: props
```

### 2.3 源码佐证

`@nocobase/plugin-flow-engine/dist/server/flow-surfaces/authoring-validation.js:7278`

```
message: `field objects must use public fieldType/fields/titleField keys; remove internal keys: ...`
```

允许的是 `fieldType`（字段语义类型，如 `belongsTo`）、`fields`（展开的子字段）、`titleField`（显示字段）。
**没有"选择渲染组件"这个维度**——`fieldType` 来自字段元数据，不是 UI 组件名。

→ 结论：这套对象语法是为**关联字段**设计的，不是给自定义控件预留的扩展点。

---

## 3. 因此 U2 的真实成本

要让 `filterForm` 里出现一个**自定义可交互组件**，只有两条路：

| | 做法 | 是否改框架 | 影响面 | 授权状态 |
|---|---|---|---|---|
| **P1** | 客户端注册 `FilterFormItemModel` 的**子类覆盖同名 use**，内部判断 `collection='serviceTickets'` + `fieldPath='createdAt'` + 所属页面 UID，命中才渲染日期条，否则 `super.render()` | **否**（只注册模型，项目已有先例） | 全局模型解析会经过我的类；其它 4 个页面走默认分支。风险：一旦判断条件写漏，会波及别的页面 | 需你确认是否算"波及非预期页面" |
| **P2** | 扩蓝图支持新的 **block 类型**（`custom`/`daterange`），页面单独加一块 | 改 `seed` 的 builder（通用） | 5 个页面都要回归 | 上一轮已说明，需授权 |

**U2 原方案（改 fields 解析）不成立**：解析器在框架里，我方只能改文档结构，改不出组件。

---

## 4. 我建议的选择

**推荐 P1**，理由：

1. 不改框架源码、不改 `node_modules`、不改通用 builder；
2. 用项目已有的 `engine.registerModels`（`store-entry-action` / `config-edit-action` 都在用）；
3. 收敛条件明确：`collection === 'serviceTickets' && fieldPath === 'createdAt' && 页面 UID === 9ia6p1dx2wp`；
4. 回退 = 删注册 + 重新 build，页面 schema 不用动；
5. 日期计算与查询逻辑**已经就绪**（`date-range.mjs` 17/17、`addFilterGroup` 原型 10/10），接上就能跑。

**P1 的残余风险要说清楚**：
- 覆盖同名 `use` 会影响**模型解析**（不是渲染结果）。我必须在类里对"非目标筛选项"原样 `super`，否则其它页面的日期项可能变形；
- 这一条需要用四角色 + 四个 filterForm 页面回归来证明（我会一起做）。

---

## 5. 本轮实际动作

| 项 | 结果 |
|---|---|
| 试改 | 已还原（`scripts/seed-admin-pages.mjs` 与备份一致，`grep component:'daterange'` = 0） |
| 页面 | 重新应用成功，`0 项未达标`，schemaUid 仍 `9ia6p1dx2wp` |
| 产品代码 | 未改 |
| 快照 | `be04-pre-snapshot-1050.sql` 仍在 |

---

## 6. 需要你裁决的一句

**是否批准 P1（客户端覆盖 `FilterFormItemModel` 渲染，条件收敛到本页的 createdAt）？**

- 批准 → 我按 P1 实现日期条 + 四页面回归，然后一次做 UI 闭环与反向验证；
- 不批准 → 只能走 P2（扩 block 类型，改通用 builder），或接受"日期筛选只用原生范围选择、不做四模式与快捷"。
