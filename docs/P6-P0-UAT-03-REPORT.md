# P6-P0-UAT-03 · A′ 实施结果（首次失败，已停手）+ P0 验收状态

> 时间：2026-10-29 15:29–15:40
> **结论：A′ 首次实施失败，按令停手（未切 B′）；P0-1 无真接口证据；P0-2 未完成。不申请部署。**
> 生产零变更、共享 UAT 零变更、未 commit / push。

---

## 1. CLI 报错的实际根因（把推测压到可证伪的范围）

| 观察 | 证据 |
|---|---|
| CLI 命令加载器抛错 | `yarn nocobase --help` → `TypeError: callback is not a function at _PluginManager.loadCommands (plugin-manager.js:383)` |
| 因此 `install / upgrade / pm add / pm enable` 全打印 `success` | 6 次调用，返回 `success / Done in Xs`，DB 无任何变化 |
| 插件**能被运行时加载** | `[@local/service-ticket] 运行 profile = production` |
| 插件在管理接口里**可见但未启用** | `GET /api/pm:list` 返回 `{"name":"@local/service-ticket","packageName":"@local/service-ticket","enabled":false,"installed":false}` |

⇒ 根因不是"NocoBase 框架坏了"，而是：**CLI 的 command 注册环节坏了**（`loadCommands` 回调签名不符），
导致所有"带副作用的 CLI 命令"变成空转；而**运行时插件发现**走的是另一条路径，所以日志看起来正常。

这不是推测——`pm:list` 里那条 `enabled:false, installed:false` 就是运行时发现与管理登记分离的直接证据。

## 2. 生产 vs p6-uat：最小差异表（只读核对）

| 维度 | 生产 `scqf-as-app` | 专属 `p6-uat` | 结论 |
|---|---|---|---|
| 镜像 digest | `sha256:dc9f54b7fb351…` | **同一 digest** | 不是版本差异 |
| 插件包 name/version | `@local/service-ticket` / 1.0.0 | 同 | 一致 |
| `node_modules/@local/service-ticket` | 实目录（bind 挂载） | 实目录（bind 挂载） | 一致 |
| 应用 `package.json` 是否声明该依赖 | **未声明** | 我注入了 `file:` 声明 | **差异（我引入的，计划还原）** |
| `applicationPlugins` 是否有该行 | 查询报错未取到（见 §2.1） | **无该行**（76 行全核心） | 待确认 |
| 业务表 | 25 张 | **0 张** | 核心差异 |
| CLI 是否可用 | 未验证（不在生产跑副作用命令） | **不可用** | 新实例的阻塞点 |

### 2.1 一处必须承认的取数失败
生产库的 `"applicationPlugins"` / `users` / `collections` 查询返回**空**，
但我没看 stderr —— 这多半是**列名/引号导致的 SQL 错误**，不能当成"生产也没有登记行"。
（同一脚本对 p6 库能返回数据，说明连接没问题，是查询写法问题。）
**在拿到生产真实登记行之前，不能断言"生产靠的就是 UI 启用"，这条仍是待证。**

## 3. A′ 的实施与失败点

按 A′（复刻生产的安装/登记/启用机制）在 p6-uat 上做的动作：

| 步骤 | 结果 |
|---|---|
| 应用 `package.json` 注入 `"@local/service-ticket": "file:./storage/plugins/@local/service-ticket"`（Node 精确改 JSON，已备份 `/tmp/pkg.bak`） | 成功 |
| `yarn nocobase pm add / pm enable`（CLI） | 打印 success，**登记表无变化** |
| 改用产品自身管理接口（等价于后台"插件管理"页）：`GET /api/pm:list` | 能看到该插件，`enabled:false, installed:false` |
| `POST /api/pm:enable` `{"name":"@local/service-ticket"}` | **`plugin name invalid`** |
| `POST /api/pm:enable` `{"name":"service-ticket"}` | 同样 `plugin name invalid` |
| `POST /api/pm:enable` 带 `packageName` 一并传 | 同样 `plugin name invalid` |

⇒ **A′ 首次实施失败**：管理接口不接受这个（带 scope 的）插件名，CLI 又坏了。
按令**停止**，未切 B′，未做任何 DB 侧绕过。

### 3.1 下一步需要的最小信息（不是再试一次）
要么确认 v2.2.15 的 `pm:enable` 对 scoped 包名的正确入参（例如是否应传短名 + `packageName` 分离、
或走 `pm:update` 的 `enabled` 字段），要么按生产历史方式（后台 UI 点启用）在浏览器里操作一次。
**这两条都需要先看清生产当初是怎么登记的**（§2.1 未取到）。

## 4. UAT 就绪门禁（9 项）

| # | 门禁 | 状态 |
|---|---|---|
| 1 | 插件已登记 | ❌ |
| 2 | 插件已启用 | ❌（`enabled:false`） |
| 3 | 业务集合已注册 | ❌ `collections`=2 |
| 4 | 业务表/字段/约束 | ❌ `service%`=0 |
| 5 | technicianVisit action 可用 | ❌ 无法验证 |
| 6 | 运行进程 bundle 含 `validateServiceNote` | 🟡 文件是待验版 `bafafd3d`，但进程未加载集合，谈不上"业务代码在跑" |
| 7 | 合法 Token 调业务 API | ❌ |
| 8 | 写入只落在 `scqf_p6_uat` | ✅（独立库/角色，未连生产） |
| 9 | 生产与其他 UAT 未受影响 | ✅（本轮只读生产 + 只动 p6-uat） |

## 5. P0-1 / P0-2

- **P0-1：0/13**。没有一条真实 HTTP 结果，不用 18/18 夹具冒充。
- **P0-2：未完成**。本轮已把本地 `vite preview` 与无头 Edge 起起来，但
  `vite preview` 只监听 `localhost`（`::1`），我用 `127.0.0.1:4180` 探测拿到 `000`，
  页面无内容 ⇒ 没进入表单，也就没有断言。**这是可修的启动参数问题**（改用 `localhost` 或 `--host 127.0.0.1`），
  不是产品问题。已在收工时清理全部临时进程。
  **不为凑数把空跑当结果。**

## 6. 本轮未产生的证据（明确列表）

| 要求 | 状态 |
|---|---|
| 插件登记与业务表前后对照 | 只有"前"（无行/0 表），"后"不存在 |
| p6-uat 运行版本 SHA | 插件文件 `bafafd3da73a5134`（未启用，未被业务调用） |
| P0-1 13 项 HTTP | 0 |
| P0-2 10 项浏览器 | 0 |

## 7. 生产与共享 UAT 变更核对

| 对象 | 本轮动作 |
|---|---|
| `scqf-as-app` / 生产库 / 生产 Nginx | **只读查询**，零写入 |
| `scqf-uat-inst` / `scqf-r4-uat` | **未触碰** |
| `plugin-r4` 共享目录 | **未触碰** |
| `p6-uat` / `scqf_p6_uat` | 注入了 `package.json` 一条依赖；其余为只读查询与失败的启用尝试 |
| Docker daemon | 未重启 |

回滚（p6-uat 自身）：`docker exec p6-uat cp /tmp/pkg.bak /app/nocobase/package.json` 即还原依赖声明；
容器可直接 `docker rm -f p6-uat` + `drop database scqf_p6_uat` 完全清除（不影响任何其他对象）。

## 8. 是否具备申请部署条件

**否。** P0-1 与 P0-2 均为 0 证据。生产仍为 server `0dc13875` / client `62677303`，待验版
`bafafd3d` / `edf199f6` 未上线。

## 9. Git 状态

未 commit、未 push；工作区改动仍是 P0-1/P0-2 的源码 + 门禁脚本，无新增生产侧改动。
