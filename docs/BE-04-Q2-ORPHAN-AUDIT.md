# BE-04-Q2 孤儿判定审计报告（结论：不可判定，未删除）

> 日期：2026-10-20 · 状态：**引用审计完成；孤儿不可判定；未执行任何删除**
> 依据用户 §七：「如果孤儿清理前置条件不满足，立即停止删除并报告，不自动改用 Q3」。

---

## 1. 一句话结论

`k20m3m6n59x` 与 `rw5nkr0epr0` 在**持久化关系上完全对称**：
两者都没有父引用、都没有路由引用、各自带着 7 个独立字段子模型、字段 uid 互不重叠。
**只有运行时 `getModel()` 能区分谁在页面树上** —— 而"运行时"正是持久化关系给不出的。

所以按你的标准（不能只看 `getModel` 是否为 null），**孤儿判定失败**，我没有删任何东西。

---

## 2. 审计数据

### 2.1 路由

```
desktopRoutes：所有工单
  flowPage  schemaUid = 9ia6p1dx2wp   menuSchemaUid = wup2x2rgu1l
  tabs      schemaUid = 6dbu7gadt9j
```

`9ia6p1dx2wp` 不是页面模型本身，而是 **RouteModel 占位**：

```json
{"schema":{"use":"RouteModel"}}
```

真正的页面根是 `ws4zfxaidoy`：

```json
{"parentId":"9ia6p1dx2wp","parent":"9ia6p1dx2wp","use":"RootPageModel",
 "props":{"routeId":393089789394944,"title":"所有工单"}}
```

### 2.2 两个 grid 的引用情况

| 探针 | `rw5nkr0epr0`（运行时有效） | `k20m3m6n59x`（疑似孤儿） |
|---|---|---|
| `options.parentId` | **(null)** | **(null)** |
| `options.parent` | **(null)** | **(null)** |
| 被 `desktopRoutes.schemaUid/menuSchemaUid` 引用 | **0** | **0** |
| 被其它模型 `options` 文本引用（作为父） | **0** | **0** |
| 子模型（`FilterFormItemModel`） | 7 个：`bvcrjww2fny`(已换 BE04) / `vjtvkj1osn3` / `al4apo1sg6x` / `jdny7kln9z8` / `55c6h3q8miw` / `umfobvemg9p` / `qxbm202jcv6` | 7 个：`hlgyq0dyysk` / `xt8wp6knhoe` / `01we66oq2dc` / `416ec4ywzvk` / `tfstkao6auu` / `mo8cj4wt5xn` / `jolddo1b5wr` |
| 两套字段 uid 有交集 | **无** | **无** |

### 2.3 运行时（上一轮已测）

| uid | `flowEngine.getModel(uid)` |
|---|---|
| `rw5nkr0epr0` / `bvcrjww2fny` | 有实例（当前页面在用） |
| `k20m3m6n59x` / `hlgyq0dyysk` | **null**（不在当前页面树上） |

**但这一条被你的规则明确禁止单独作为删除依据**，而其它证据又不足以区分二者。

---

## 3. 为什么不删

按你 §二 的六条：

| 条件 | 结果 |
|---|---|
| 旧 Grid 从所有有效页面入口不可达 | **无法证明**（没有父引用 = 无法证明"属于谁"） |
| 子树没有被其它有效页面引用 | ✅（反向引用为 0） |
| 不会误删共享节点 | ⚠️ 无法排除（两套结构对称） |

三条里有一条无法证明，就不满足删除前置条件 → **停止**。

---

## 4. 连带后果：第三关仍然阻塞

post-seed 补丁要在 Node 里定位"唯一有效的 createdAt 项"，只能依赖持久化数据。
现在持久化数据给出的是**两条对称记录**，脚本无法在不使用运行时信息的前提下选对。

也就是说：**孤儿清理与 patch 定位是同一个问题的两面** ——
只要不能从持久化关系里区分，两个都做不了。

---

## 5. 三条可选出路（需你裁决）

| | 做法 | 代价 / 风险 |
|---|---|---|
| **A1** | 授权我删 `k20m3m6n59x` 子树（**按"运行时 null"判据**，即接受你原本禁止的那条依据） | 一旦判断错，会删掉别处的筛选表单；但当前反向引用为 0，风险可见 |
| **A2** | 查清 flow-engine 到底用什么字段挂父子（可能要读 `flowModels` 之外的关联表），再给 patch 一个稳定路径 | 需要再花时间摸存储模型，但**不需要删任何东西**，最干净 |
| **A3** | 放弃 patch，改成"每次 seed 后由我手工 update 一次" | 不满足"重新部署仍有效"，不可接受 |

**我建议 A2**：先把"grid 到底挂在哪"查清楚。如果 grid 是通过 `name` 路径或另一张关联表挂上去的，那么 patch 就能按"路由 → 页面 → grid → createdAt"稳定走到唯一一条，**既不删记录、也不需要运行时**。

---

## 6. 本轮动作

| 项 | 结果 |
|---|---|
| 数据库 | **未删除、未修改任何记录**（本轮只读查询） |
| 快照 | `backups/be04-model-bvcrjww2fny-1237.json`（上一轮）、`be04-pre-snapshot-1050.sql` |
| 页面状态 | 仍为上一轮手工切换后的状态（`bvcrjww2fny.use = BE04DateRangeFilterItemModel`） |
| post-seed 补丁 | **未写**（定位方式未定，写了也不可靠） |
| 构建 / 运行 | 未改动，页面正常 |
