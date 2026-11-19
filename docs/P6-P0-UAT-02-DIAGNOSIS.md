# P6-P0-UAT-02 · 专属 UAT 初始化诊断（业务集合确认缺失，门禁未过）

> 时间：2026-10-29 14:53–15:05
> **结论：业务表确实不存在（不是查询方法错误）；初始化卡在"插件未被插件管理器登记"这一步，我已停止盲目重试。P0-1 未进入验收，P0-2 本轮未做。不得部署。**
> 未部署生产、未发短信、未改生产数据、未动 `scqf-uat-inst` / `scqf-r4-uat` / `plugin-r4`、未重启 daemon、未 commit / push。

---

## 1. 业务集合：**确实缺失**（三种互相独立的证据）

| 检查 | 结果 |
|---|---|
| ① 应用实际连接的库/角色 | `DB_DATABASE=scqf_p6_uat`、`DB_USER=p6_uat`；`select current_database(), current_user` → `scqf_p6_uat \| p6_uat` |
| ② 非系统 schema 全部表 | **104 张**，全部是核心表（`ai*` / `apiKeys` / `users` …）；`service%` 前缀 **0 张** |
| ③ `collections` 元数据表 | **2 行**（核心系统集合），没有业务集合 |
| ④ 插件管理器登记表 `"applicationPlugins"` | **76 行，全部核心插件；`service-ticket` 一行都没有** |
| ⑤ 运行时日志 | 插件**确实被加载**：`[@local/service-ticket] 运行 profile = production`、`送达回执队列未配置…` |

⚠️ 自查一处方法错误并已修正：我第一次查 `applicationPlugins` 用了未加引号的表名，
PostgreSQL 折叠成小写 → `relation does not exist`，而我只打印了 stdout ⇒ **静默空结果**。
改用 `"applicationPlugins"` 后才看到上面这 76 行。**"表不存在"与"查法不对"必须分开**，
这次两个问题同时存在，已分别记录。

---

## 2. 初始化失败的具体阶段（准确到命令与返回值）

| 步骤 | 命令 | 返回 | 实际效果 |
|---|---|---|---|
| 1 | `yarn nocobase install --lang=zh-CN`（首次，插件未启用） | `Done in 7.89s` | 建好 104 张核心表；**此时插件未被登记，所以它的集合不在同步范围** |
| 2 | `yarn nocobase pm enable @local/service-ticket` | `success / Done in 13.0s` | **无效果**：`applicationPlugins` 仍无该行 |
| 3 | 重启容器 | health 200 | 运行时**加载**了插件（有日志），但集合仍为 0 |
| 4 | 再次 `yarn nocobase install` | `success / Done in 7.29s` | 表仍 0；`collections` 仍 2 |
| 5 | `yarn nocobase upgrade` | `success / Done in 14.44s` | 表仍 0 |
| 6 | `yarn nocobase pm add @local/service-ticket` + `pm enable` | 均 `success` | `applicationPlugins` 仍 **76 行，无该插件** |

另外：`yarn nocobase --help` 本身报错 `TypeError: callback is not a function`
（`plugin-manager.js:383 loadCommands`）—— CLI 的命令加载在这个镜像上下文里是坏的，
所以"success"不能当作"命令真的执行了"。

### 2.1 根因判断

**不是**"数据库连错"、"角色权限不足"、"schema 不对"（第 1 节 ①② 已证明），
也**不是**"install 时序不对"（重跑 install/upgrade 共三次都无效）。

根因是：**CLI 的插件管理器根本不知道这个本地插件**
—— 它只登记/加载"核心插件 + 应用 `package.json` 里声明过的插件"。
我们的插件是通过 **bind mount 塞进 `node_modules/@local`** 的，没有在应用 `package.json` 里声明，
于是：
- 运行时：NocoBase 扫描本地目录，插件被**加载**（所以有日志）；
- CLI（install / upgrade / pm）：插件不在注册表里 ⇒ 它的 collections **不参与 `db.sync()`** ⇒ 一张表都不建。

"load ≠ registered ≠ synced" —— 这正是你提醒的"不能把 getInfo=200 当初始化完成"。

---

## 3. 最小修复方案（未执行，等确认）

| 方案 | 做法 | 风险 |
|---|---|---|
| **A（推荐）** | 在应用 `package.json` 增加依赖 `"@local/service-ticket": "file:./storage/plugins/@local/service-ticket"`，然后 `pm add` → `pm enable` → `upgrade` | 只改该实例的应用配置，不碰 DB/生产；符合 NocoBase 本地插件安装的常规做法 |
| B | 容器内一次性 Node 脚本，用 `@nocobase/server` 的 pluginManager API 调 `enable(name, { syncCollections: true })` | 绕过 CLI，仍走官方 API；需要确认 v2 的方法签名 |
| C | 放弃该系统，用"应用模板 + 声明依赖"的镜像 | 成本最高 |

**不会**采用：手写 SQL 建 25 张表（被明确禁止，且会与 NocoBase 的元数据不一致）。

---

## 4. 专属 UAT 就绪门禁（7 项，**未通过**）

| # | 门禁 | 状态 |
|---|---|---|
| 1 | 业务集合已注册 | ❌ `collections`=2 |
| 2 | 业务表与关键字段存在 | ❌ `service%` 表=0 |
| 3 | 应用健康检查 200 | ✅（但不作为初始化完成证据） |
| 4 | technicianVisit 业务 action 已注册 | ❌ 无集合 ⇒ 无法验证 |
| 5 | 独立账号/Token/DB/媒体目录 | 🟡 DB（`scqf_p6_uat`+`p6_uat`）与媒体目录（`/opt/scqf-p6-uat/uploads-private`）已独立；账号/Token 待集合就绪后创建 |
| 6 | 不写入生产/其他 UAT | ✅（独立库、独立角色；未连接生产库） |
| 7 | 未启用真实短信与外部副作用 | ✅（无任何通道凭据；日志显示回执队列缺 4 个变量） |

⇒ **门禁 1、2、4 未过，P0-1 不具备开工条件。**

---

## 5. P0-1 / P0-2 状态

- **P0-1 真接口：未开始**（门禁未过）。没有任何 HTTP 结果可报，不拿 18/18 单元夹具冒充。
- **P0-2 浏览器：本轮未做**。正确做法已固定：本地 `vite preview` + CDP 拦截
  `/api/public/store-entry` 与提交响应，**从报修表单提交**进入真正的 `Success.vue`，
  再验默认勾选、不触碰也落盘、跨店隔离、关自动进入、清除、7 天过期、无效 Token、storage 不可用、375/390/420 无遮挡。
  不接受"直接打开成功页"的做法（上一轮已证明会拿到 undefined）。

---

## 6. 共享 UAT 影响调查（只读，单独登记）

窗口 `12:03:00–12:08:00`：

| 项 | 结果 |
|---|---|
| `scqf-uat-inst` 请求 | **4 条**，全部是启动期/健康探测；无业务写入请求 |
| `scqf-uat-inst` 含 error 字样的日志 | 6 行，**其中大部分是误命中**：`load plugin migrations [error-handler]`（插件名叫 error-handler）、启动期 `plugins loaded` 的 503 维护态回包；未见真实异常堆栈 |
| `scqf-uat-inst` 加载的代码 | 重启发生在 12:03:41，当时文件为旧版 `74c46a09`；新文件写入在其后、且此前无第二次重启 ⇒ **未加载过新文件** |
| `scqf-r4-uat` | 窗口内**0 条请求**；无重启；仅一条 `sla.accept_minutes 读取失败（connection manager closed）` 的 warn，与本事件无因果关系 |
| 持久化写入 | 两库均未见新增业务行（uat-inst 仍 0 visits / 0 tickets） |

**结论**：该窗口**没有业务请求受影响**，也没有加载过被替换的产物；
但"文件内容被替换 2–3 分钟"这一事实仍成立，**不能表述为"零影响"**，只能表述为
"**未观测到运行时影响**，且存在一个真实的风险窗口（若期间触发重启/重载即会加载）"。

---

## 7. 版本与 SHA（生产未动）

| 对象 | SHA（前 16） |
|---|---|
| 生产 server | `0dc13875760cd924` |
| 生产 client | `62677303c562a33d` |
| 待验 server | `bafafd3da73a5134` |
| 待验 client | `edf199f64e37778d` |
| 专属 UAT 内插件 | `bafafd3da73a5134`（已确认是待验版，不是生产版） |

---

## 8. 是否具备申请专项部署条件

**否。** 缺的是 P0-1 的真接口证据（13 项一条都没有）与 P0-2 的浏览器证据（10 项一条都没有）。
在补齐之前申请部署，等于用单元测试替代运行验收。

下一步只有两步，且都不需要新授权：
1. 用第 3 节方案 A 补声明 → `pm add/enable` → `upgrade`，确认 `service_tickets/service_visits/...` 出现（25 张）。
2. 建合成 store/ticket/visit+token/1 张可解码 onsite 照片 → 跑 13 项真接口；同时另起 P0-2 浏览器验收。

---

## 9. 追加证据（14:56）：`pm add` 也是空转，根因是 **CLI 命令加载器坏了**

按方案 A 又试了一次（已授权范围内的修复尝试）：

| 步骤 | 结果 |
|---|---|
| 备份 `/app/nocobase/package.json` | 已备份到容器内 `/tmp/pkg.bak` |
| 用 Node 精确注入依赖 `"@local/service-ticket": "file:./storage/plugins/@local/service-ticket"` | `dep added`（未用 sed 改文本） |
| `yarn nocobase pm add @local/service-ticket` | 打印 `success / Done in 7.77s`，**`applicationPlugins` 仍无该行** |

结合前面 `yarn nocobase --help` 的报错：

```
[error] callback is not a function
  at _PluginManager.loadCommands (plugin-manager.js:383)
```

⇒ **CLI 的命令加载本身是坏的**：`install` / `upgrade` / `pm add` / `pm enable` 都只是"跑完了并打印 success"，
并没有真正执行插件管理动作。这解释了为什么 6 次尝试的返回全是 success、DB 却一动不动。
**"命令返回 success"在这个镜像里不是"命令生效"的证据。**

### 9.1 因此剩下两条可行路径（都需要你点一下，我不再自行尝试）

| 路径 | 内容 | 代价 |
|---|---|---|
| **A′（推荐）** | 用与生产相同的方式构建/启动实例：把插件在**镜像构建期**声明进依赖（生产实例就是这样来的），或使用镜像自带的本地方案 | 需要一次镜像/启动方式的调整，不改任何生产对象 |
| B′ | 容器内一次性 Node 脚本：boot app → `app.pm.enable(name,{syncCollections:true})` → `db.sync()` | 绕过坏掉的 CLI，用官方 API；需要在容器内跑一次 Node |
| （不可取） | 手写 SQL 建 25 张表 / 给 `applicationPlugins` 插行 | 前者被明令禁止；后者虽只是元数据，但绕过官方初始化流程，容易造成"表与元数据不一致" |

## 10. 本轮最终状态（更新）

| 项 | 状态 |
|---|---|
| 业务集合是否缺失 | **确实缺失**（三证；且我承认第一次 pm 查询因大小写静默失败，已修正） |
| 初始化失败阶段 | **CLI 命令加载器损坏**（`loadCommands: callback is not a function`）⇒ install/upgrade/pm add/pm enable 全部空转 |
| 专属 UAT 可用性 | **不可用**（无业务表） |
| P0-1 真接口 | **未开始**（0/13） |
| P0-2 浏览器 | **未做**（0/10） |
| 是否具备部署条件 | **否** |
