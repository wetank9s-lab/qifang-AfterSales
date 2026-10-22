# BE-04-P1 模型兼容扩展报告（结论：不成立）

> 日期：2026-10-20 · 结论：**`registerModels` 不覆盖同名模型类 ⇒ P1 无法按设计生效**
> 已回滚接线，构建成功，页面 READY。未 commit / 未 push。

---

## 1. 一句话结论

`engine.registerModels({ FilterFormItemModel: 子类 })` **不会替换已注册的同名类**：
注册后 `getModelClass('FilterFormItemModel').name` 仍是 `FilterFormItemModel`，
页面上目标位置也**没有**出现子类的标记（`[data-svc-date-bar]` 计数 = 0），原生「创建日期」项照常渲染。

⇒ P1 的"覆盖同名 use"前提不成立。已按你的 §八 停止，不再扩大改动。

---

## 2. 实测证据

### 2.1 前置可行性（成立的一半）

`flowEngine.getModelClass('FilterFormItemModel')` **能拿到**基类（`hasRender: true`），
`registerModels` 也是 function —— 说明"取类 + 注册"这两个动作本身可用。

### 2.2 覆盖（不成立）

```ts
class SvcDateRangeItemModel extends Base { render() { /* 命中则渲染标记 */ } }
engine.registerModels({ FilterFormItemModel: SvcDateRangeItemModel });
```

注册后的实测：

| 探针 | 结果 |
|---|---|
| `getModelClass('FilterFormItemModel').name` | **仍是 `FilterFormItemModel`**（不是 `SvcDateRangeItemModel`） |
| 页面 `[data-svc-date-bar="probe"]` 数量 | **0** |
| 「所有工单」筛选项 | 7 项照旧，仍是原生「创建日期」 |
| 页面是否白屏 | 否（说明没生效也没破坏） |

`@nocobase/flow-engine/dist` 里也搜不到 `registerModels` 的实现（它在运行时 bundle 内），
无法确认是否存在 `{force:true}` 之类的覆盖参数 —— 按纪律不去猜/不去改第三方产物。

### 2.3 顺带发现：模型 UID 会变

重新 seed 之后，之前记录的 `mbqrpm558sz` 已失效（`flowEngine.getModel('mbqrpm558sz')` 返回 null）。
这正好印证你的要求：**不能把页面实例 UID 当跨环境常量**。
（本轮子类判据用的是 `stepParams.__flowSurfaceMeta.declaredKey`，本来就避开了 UID。）

---

## 3. 回滚

| 项 | 状态 |
|---|---|
| `client/index.ts` 接线 | 已移除，改为 `void installDateRangeItemModel` 占位并注明"已停用" |
| `client/date-range-item-model.tsx` | 保留（含完整判据与注释，供下一方案复用前先移除） |
| 构建 | `未声明标识符 0 条`、`插件构建成功` |
| 运行时 | 已 restart，`READY`，后台页面正常 |
| 页面 schema | **未改**（schemaUid 仍 `9ia6p1dx2wp`） |

---

## 4. 剩下的可行路径（需你裁决，我不自行推进）

| | 做法 | 改什么 | 风险 |
|---|---|---|---|
| **Q1** | 运行时改模型实例的 `render` | 私有对象 | **禁止**（你已明确不许） |
| **Q2** | 用 NocoBase 正式 schema 接口（`flowModels:update`）把**该一个字段**的组件改成已注册的自定义组件 | 改这一条 UI Schema 记录（不是 SQL、不是 builder） | 需要在客户端注册一个可用组件；schema 改动要能随 seed 复现（否则重新部署丢失） |
| **Q3** | P2：扩蓝图 block 类型 | 改通用 builder | 5 个页面回归；你上一轮暂未授权 |

**我的建议**：若还要继续，选 **Q2**——它只动"所有工单"这一条字段的 schema，
不碰 builder、不覆盖全局模型；但必须解决"seed 后如何复现"（否则违反"重新部署仍有效"）。

**也可以接受就此收口**：日期筛选保持原生（只有日期范围选择，无四模式与快捷），
把 BE-04 的日期需求降级，并在报告里如实写明缺口。

---

## 5. 本轮改动汇总

| 文件 | 改动 | 是否需要保留 |
|---|---|---|
| `client/date-range-item-model.tsx` | 新增（子类 + 判据 + 标记） | 保留作证据，接线已停用 |
| `client/index.ts` | 加 import + `void` 占位（无运行时副作用） | 保留 |
| `client/date-range.mjs` | 上一轮的日期纯函数（17/17） | 保留，Q2 可直接复用 |
| 页面 schema | 无 | — |
| 数据库 | 无 | — |
