# 后台页面操作手册（flow-engine）—— 改页面前必读

> **本文是"动手改后台页面/自定义动作/客户端产物"时的作业手册。**
> 事故复盘在 `docs/DEVIATIONS.md`（DEV-53/54/56/61~64/68/69/74），断言铁律在
> `docs/ENGINEERING-RULES.md`，阶段交付说明在 `docs/PHASE-4.md` §13。
> 本文只写**结论与判据**，省得下次再从源码推一遍。

---

## 0. 三条最贵的教训（先读这个）

1. **「ActionModel 已注册」≠「Action 已挂到页面」**（DEV-68/69）。
   中间隔着整条链路，**任何一环断了只是"少几个按钮"，不报错、不崩溃、不静默**：
   模型类注册 → `flowModels` 有行 → **顶层 `use` 正确** → 挂在 `TableActionsColumnModel` 下
   → `flowModelTreePath` 祖先链连通 → 客户端能解析 → **真实渲染出按钮**。
   ⇒ **"结构断言 + 一次真实渲染验证"必须成对存在**：缺前者漏 DEV-68，缺后者漏 DEV-69。

2. **判据必须选「客户端真正消费的那个字段」**，不是"插入动作成功与否"。
   本项目的判据是 **顶层 `use`**，不是"uid 的行在不在"。

3. **"重建了产物" ≠ "服务端在发新产物"**（DEV-74）。
   见 §4，这一条曾让一整轮真人走查空跑。

---

## 1. 页面是数据，不是配置

- 交付物必须是**可重建脚本**：`scripts/seed-admin-pages.mjs`（幂等 create/replace）。
  只手工在界面上点出来的页面 = 不可重建 = 不可验收。
- **服务工单页面绝不能挂 blueprint 弹窗**（DEV-53 坑1）→ 详情走**客户端自渲染只读抽屉**。
- **定位页面必须过滤 `type === 'flowPage'`**（坑3：单 Tab 页面的 Tab 与页面同名，不过滤会撞名）。
- 回读内容用 `/api/flowModels:list?paginate=false` 建树，**不要用 `exportBlueprint`**
  （DEV-54：含关联列时 400）。
- 但**守护断言**要用 `flowSurfaces:exportBlueprint`：导出的是**校验器认的那份页面内容**，
  是被编译器改写之后的权威视图（例如"自动合并的动作"只有从这里才看得见）。
  见 `docs/PHASE-4.md` §13.6。

### 1.1 取数位置有三个，别只查一个

断言"区块不引用敏感列"时，必须同时取：
`fields[].field` + `sorting[].field` + `defaultFilter.items[].path`。
只查第一个 → 排序/默认筛选里悄悄带上凭据列也不会变红。

### 1.2 区块挂在 Tab 自己的 `schemaUid` 下

不是挂在页面 uid 下。详见 `docs/PHASE-4.md` §13.6。

---

## 2. 自定义动作挂载（DEV-68/69）

> 全文（含源码级证据链与 HTTP 对照实验）见 `docs/DEVIATIONS.md` DEV-68 / DEV-69。

### 2.1 必须绕过 blueprint，直写 `flowModels`

`applyBlueprint` 的 `actions` / `recordActions` **架构上无法**声明自定义 ActionModel：

- 它们只接受**编译期硬编码的 catalog publicKey**（`catalog.js` 的静态 `actionRegistry` 数组，
  每一项还要过 `nodeContracts` 校验，而 `nodeContracts` 只由硬编码 `NODE_CONTRACT_ENTRIES` 填充）。
- 自定义 `Ticket*ActionModel` 只注册在**浏览器引擎**里，服务端 catalog **不认识** ——
  **两个互不相通的世界**。
- 实测：`POST /api/flowSurfaces:addAction` 传自定义 use → **400**
  `only supports registered action types/uses`；对照组 `{type:'link'}` → **200**。
  ⇒ 是**该 use 不被接受**，不是权限/路径/参数形状问题（**对照实验仍是最高性价比的定位手段**）。

**反向删除**用 `flowSurfaces:removeNode`（`removeAction` / `deleteAction` 均 **404**）。

**附带的独立发现**：`actions` 只能写内置 key，但 blockType 还会**自动注入**一批默认动作
（`default-block-actions.js` 的 `FLOW_SURFACE_DEFAULT_BLOCK_ACTIONS.table`）：
`filter / refresh / bulkDelete / addNew / view / edit / delete`。
所以 `actions:['filter','refresh']` 实际落库 **5 个按钮**，行级还凭空多出 `查看/编辑/删除`
（这正是"自动生成的按钮让真人误以为是正常售后操作"的源头，也是"页面不得存在通用写路径"
这条断言要盯的对象）。**无法移除**；逃生口只有"模板化区块不注入"，但**仍无法借此声明自定义动作**。

### 2.2 `flowModels:save` 的 body 就是扁平 model 本身

**不能包 `{values: …}`**（DEV-69）。

- 多包一层 → 服务端把 `values` 当**普通字段**摊平进节点行 → **顶层没有 `use`**
  → 客户端解析不出模型类 → **静默不渲染**。
- 而"这个 uid 的行存在"是客观事实 ⇒ **只数行数的断言全部为绿**。**这比 DEV-68 更危险**：
  DEV-68 至少会 400，它是一路 200 + 行数正确 + 断言全绿。
- 它还会**连带污染全库**：所有"数一数有几行自定义动作"的断言、对账、`declaredKey` 溯源
  都对这类病态行视而不见（`TICKET_ACTION_USES.includes(undefined)` 为假）。

**判据（写进断言）**：命中 uid 但 `node.use !== model.use` 的行**单独点名**并计入失败
（`assertTicketActions()` 的 `malformed` 通道）；`reconcileTicketActions()` 增加第二遍兜底扫描，
按"uid ∈ 期望集合但顶层无 `use`"清理病态行。

### 2.3 必须用 `save`，不能用 `create`

`create` 走**裸 insert**、**不触发 `flowModels.afterInsert` 钩子**（该钩子负责 `insertNewSchema`
→ 写 `flowModelTreePath` 祖先链）→ 节点在库里但 **UI 读树完全看不见**。
`save` 内部走 `updateSingleNode`/`insertSingleNode`，路径由钩子维护，**本身就是 upsert**。

### 2.4 挂载位置与参数

- **行级动作（`scene:'record'`）挂 `TableActionsColumnModel`**，不是 TableBlock 的 `actions`。
  挂错父节点 = "库里 35 行齐整、页面零按钮"。
- `flowModels:attach` 参数**必须走 query string**；`position` 只接受 `first` / `last`。
- `props` 与 `stepParams.buttonSettings` 要和**内置动作逐字段对齐**
  （`props:{type:'link',title,icon:null}`；`stepParams.buttonSettings.general:{title,icon:null,type:'link',iconOnly:false}`），
  并把 `stepParams.__flowSurfaceMeta.declaredKey` 设为 `svc.<key>` 以便溯源。

### 2.5 孤儿行对账（会无限膨胀）

**`blueprint replace` 每次重建 TableBlock 并换新 uid** → 上一批动作全变孤儿
（实测 100 行 / 65 孤儿）。必须靠对账收敛到「活表数 × 5」。
⚠️ **孤儿行不渲染成重复按钮**，所以"数按钮"类断言**发现不了它**。

### 2.6 实现与断言在哪

| 文件 | 职责 |
|---|---|
| `scripts/ticket-page-actions.mjs` | 纯函数：动作行构造 / 断言 / 对账 |
| `scripts/seed-admin-pages.mjs` | 挂载 + 对账（`seedTicketPageActions()`） |
| `scripts/verify-ticket-actions.mjs` | 10 项断言 + `--reverse` 反向验证 |
| `scripts/uat-preflight.mjs` **§3.6** | 动作实例闸门 |

---

## 3. `filterForm` 搜索框（DEV-61~64）

五条硬约束，每条都对应一次 400 或一次假红：

1. 必须**独占 tab 布局第 0 行**（`block-layout-filter-must-lead`）。
2. `layout` 只能写在 **tab** 上；写 block 上 = `block-layout-unsupported`。
3. 动作公开键是 **`submit` / `reset`**（**不是** `filterFormSubmit`）。
4. `displayTitle` **不在白名单**。
5. 连接 `filterManager` 由校验器**按字段名自动推导** —— 手写会 400。

⚠️ **搜索项不能靠树遍历取**（DEV-62）：`?paginate=false` 返回的树里 `FilterFormGridModel`
**没有 `parentId`** → 树链在那一层**断开** → 遍历必假红。
改按 `defaultTargetUid` 索引：
`stepParams.filterFormItemSettings.init.defaultTargetUid` + `.filterField.name`。

---

## 4. 客户端产物交付链（DEV-74）

> 全文见 `docs/DEVIATIONS.md` DEV-74；铁律见 `docs/ENGINEERING-RULES.md` §D。

**真机制**：服务端下发的产物 URL 带 `?hash=`，该 hash =
`sha256(产物 **mtime** + `APP_KEY` + 插件 version + appVersion + `PLUGIN_URL_HASH_SALT`)[:8]`，
**但结果被 `PackageUrls.items`（静态 Map）进程内缓存**，在进程重启前不会重算。

⇒ **重建产物却没重启 app** ⇒ 服务端继续发**旧 hash** ⇒ 浏览器缓存键不变
⇒ 真人**永远拿不到新产物**。

⚠️ `docker compose up -d` 对**已运行且配置未变**的容器是 **no-op**，**不会重启** ——
这就是"重建了却没用"的根源，也是 `build-plugin.mjs` 收尾提示从 `up -d` 改成 `restart` 的原因。

**两条处置必须都做**：

| # | 措施 | 定位 |
|---|---|---|
| ① | **重建后重启**：`docker compose restart app` | **主措施**（URL 随之改变 ⇒ 绕开旧缓存条目） |
| ② | nginx `/static/plugins/` 设 `no-cache` | 兜底（防 URL 复用期内的静默漂移） |

**辅助手段**：

- 产物带构建标记：`build-plugin.mjs` 经 esbuild `define` 注入 `__SVC_CLIENT_BUILD__`
  （与产物构建**共用同一份选项对象**，DEV-60），客户端启动 `console.info` 打印 → 浏览器可自证版本。
- **抽屉错误态必须带失败请求的 URL** → 下次走查不用开 DevTools 就能说清是哪个地址失败。

**断言** `scripts/verify-bundle-delivery.mjs`（**4 条**）：

1. 服务端返回字节 == 刚构建的产物；
2. 缓存头不得长缓存；
3. 带构建标记；
4. **产物 mtime 不得晚于 app 进程启动时间** —— 判据**只用时间**，**不复算内部 hash**
  （复算会绑死实现细节，常量一搬就假红）。
   实现：`docker inspect -f '{{.State.StartedAt}}' svc-app`（容器名可用 `SVC_APP_CONTAINER` 覆盖）。
   晚于即红灯，并给出确切的重启命令。

另有 `scripts/verify-detail-gate-reverse.mjs` / `scripts/verify-delivery-gate-reverse.mjs`
两个**反向验证**（铁律 8：断言不会变红 = 没有断言）。

⚠️ **探针环境必须与真人环境对齐**（铁律 28）：无头探针每次**全新 profile**（空缓存）⇒ 永远拿最新产物；
真人用**持久 profile** ⇒ 被缓存粘住。**"探针全绿"与"真人报错"可以同时为真**，
且这恰恰是**缓存/交付类缺陷**的典型特征。看到这种分歧，先问：**"探针和真人的环境差在哪？"**

---

## 5. 客户端插件 API 取证（DEV-56）

要确认客户端能用哪些模块，**靠内置插件产物的 UMD 依赖数组**取证，不要靠猜。
本项目白名单：`@nocobase/client`、`@nocobase/flow-engine`、`antd`、`react`、`react-dom`。
smoke 守一条："产物 define 依赖 ⊆ 白名单"。
**客户端 `load()` 绝不抛出**（抛了会让整个引擎挂掉，而不是只少一个按钮）。

---

## 6. 快速自检清单（改完页面前跑一遍）

- [ ] 播种脚本可重跑（幂等），没手工改过库
- [ ] 回读用 `flowModels:list?paginate=false` 建树，没碰 `exportBlueprint`（除守护断言）
- [ ] 自定义动作是**直写 flowModels**、payload **扁平**、用 **`save`**、挂 **`TableActionsColumnModel`**
- [ ] 对账后自定义动作行数 == 活表数 × 5，孤儿 0
- [ ] **打开一次真实页面，肉眼确认按钮渲染出来了**（只跑结构断言不算）
- [ ] 敏感列三处取数（fields / sorting / defaultFilter）都不含凭据列
- [ ] 改过客户端产物 → `docker compose restart app` + 跑 `verify-bundle-delivery.mjs`
- [ ] 每条新断言都做过反向验证（造一个反例看它是否变红）
