# 需求偏差与决策记录（DEVIATIONS）

> 记录与《家电门店售后服务平台_开发文档_v1.1》**书面表述不一致**或**做了进一步明确**的地方。
> 原则：不扩大需求、不更换架构、不缩减安全要求。每条给出偏差、理由、影响、可逆性。

---

## DEV-01 客户报修页改用独立 Vue3 H5（文档原文"优先 NocoBase Public Form"）
| 项 | 内容 |
|---|---|
| 文档原文 | §1.1「客户报修 H5：优先 NocoBase Public Form」；§13「若报修入口直接采用 NocoBase Public Form，则 POST /public/tickets 可以不开发」 |
| 本方案 | 使用独立 Vue3 H5 + 自定义 `POST /api/public/tickets` |
| 理由 | 文档 §9.1 要求公开表单提交做 `request_id` 幂等；§14 要求重复工单检测；§18 要求 IP/手机号频控与"防止连点产生重复工单"。Public Form 的写前拦截能力不足（Workflow 仅事后触发），无法返回 429/409 语义 |
| 影响 | 仅前端呈现方式；数据模型、状态机、接口语义不变 |
| 可逆 | ✅ 可逆（Phase 3 前可切换，需接受防刷能力降级为 Nginx 层） |
| 状态 | 待确认（ASSUMPTIONS A-01） |

## DEV-02 不新增独立 Node.js Service（文档"可以建立独立 Node.js Service"）
文档 §一 允许在"匿名接口非常不适合放进 NocoBase Plugin"时建独立服务。经技术核实，本项目的匿名接口**全部适合**放进插件，因此不建。理由：避免跨进程鉴权、双写事务、双份部署与备份。此条为**行使文档给出的可选权**，不构成需求偏差。

## DEV-03 补全 TicketEvent 与 SmsLog 的字段（文档仅列出部分）
- `TicketEvent` 增加：`visit_id`、`operator_kind`、`metadata_json`、`index(ticket_id, created_at)`。
- `SmsLog` 增加：`visit_id`、`recipient_masked`、`unique(provider, biz_id)`、`index(delivery_status)`。
- 理由：文档 §16 要求"工单详情页面显示时间线"、§15 要求"短信回调按 provider + biz_id 幂等"，不补字段无法实现。

## DEV-04 新增 3 张支撑表（文档未提及）
`dailySequences`（工单号原子取号）、`apiGuards`（限流计数）、`idempotencyRecords`（幂等）、`systemSettings`（配置化）。
- 理由：文档 §4 要求 `FW20260920-0001` 格式编号、§9.1 要求幂等、§16 要求"配置化"（附录 B 列出 10 个配置键）。这些是**实现文档既有要求的最小必要支撑**，不引入新业务概念。

## DEV-05 照片不使用 NocoBase 原生附件字段直接展示
- 文档 §21.4 建议"照片单独关联 ServiceVisit，用 File collection + 关系字段"。
- 本方案：**保留 File Collection 存元数据**，但工单详情页的照片预览由插件自定义区块渲染，读取走受控端点，而非直接使用原生 `attachment` 字段的公开 URL。
- 理由：文档 §21.7 明确要求"现场照片不要使用永久公开 URL"；NocoBase 内置本地存储引擎产出的是永久可访问 URL，二者冲突时以安全要求为准。
- 影响：工单详情页照片区为自定义组件（工作量增加约 0.5 天），存储与元数据仍符合文档建议。

## DEV-06 状态写入的唯一入口是插件 Service，Workflow 不直接改 status
- 文档 §12.1 将 Workflow 列为状态流转能力，§9 列出 WF-01~WF-12。
- 本方案：WF-01~WF-12 的业务逻辑全部落在插件 Service（可单测、可事务、可幂等）；Workflow 仅用于"调用 Service"或纯通知动作。
- 理由：双写会导致状态与事件不一致（违反 §16"任何重要变化都写事件"）。

## DEV-07 不实现"实际上门准时率 / 到达时间"
文档 §15 已明确要求不做，此处登记以确保验收时不误判为缺失。

## DEV-08 增加 `viewer`（只读管理层）角色的落地
- 文档 §5 标注为"可选"，附录 A 未列对应页面。
- 本方案：保留该角色（只读 + 手机号默认脱敏），因为它直接支撑 §11"手机号泄露"控制项与 §15 报表需求；不为其单独开发页面，复用总部页面只读权限。

## DEV-09 工单主表保留"当前最新安排"快照字段
`serviceTickets.technician_name / technician_mobile / expected_visit_at / service_mode / provider_name` 与 `serviceVisits` 的同名字段**并存**。
- 理由：文档 §6.2 明确这些字段在 ServiceTicket 上；§21.3 又在 ServiceVisit 上。并存是刻意的：工单上=当前最新（便于列表展示与改派对比），Visit 上=历史快照（不可变）。改派时同步更新工单字段，Visit 不动。

## DEV-10 健康检查路径同时支持 `/api/svc:health` 与 `/api/svc/health`
| 项 | 内容 |
|---|---|
| 文档/验收原文 | DEV-PLAN §Phase 1 验收门槛写作 `curl /api/svc/health`（斜杠形式） |
| 本方案 | 应用侧实现了 NocoBase 原生的 `/api/svc:health`（冒号形式），并在 nginx 增加 `/api/svc/health` → `/api/svc:health` 的内部重写 |
| 理由 | NocoBase 的 resourcer 解析自定义 action 时，URL 形态由 `parseRequest` 决定：`/api/<resource>:<action>`。冒号是**框架约定的原生长相**，改成路径段需要覆写 resourcer 行为（侵入框架）。因此保留冒号形式为主，另加一层别名让验收命令原样可跑 |
| 影响 | 两种写法返回完全一致的响应体；nginx 侧多一个 `location =`（精确匹配，开销可忽略）。容器 healthcheck 用冒号形式（少一次重写） |
| 可逆 | ✅ 完全可逆（删掉 nginx 别名 location 即可，但验收命令需同步改） |
| 状态 | 已实现（Phase 1） |

## DEV-11 数据表数量为 11 张（DEV-PLAN 写"9 个 collection"）
| 项 | 内容 |
|---|---|
| 文档原文 | `DEV-PLAN.md` Phase 1 验收门槛写"9 张表出现在 PostgreSQL 中" |
| 实际 | `DATA-MODEL.md` 逐表定义了 **11 张**表 |
| 差额来源 | `DATA-MODEL.md` 比 `DEV-PLAN` 的粗算多出 2 张支撑表：`apiGuards`（限流计数）、`idempotencyRecords`（幂等记录）。二者是 DEV-04 为满足文档 §9.1「幂等」与 §18「频控」而下沉落库的**必要支撑**，不是新增业务概念 |
| 处理 | **以 DATA-MODEL.md 为准**（它是字段级权威定义），验收门槛按 11 张执行。插件 `EXPECTED_TABLE_NAMES` 硬编码 11 个表名，健康检查接口会逐个核对并在缺失时返回 503 + `missingTables` |
| 影响 | 无功能影响；仅验收口径需要明确。已同步修正 README 与 PHASE-1 文档表述 |
| 状态 | 已明确（Phase 1），后续如需可回改 DEV-PLAN 措辞 |

## DEV-12 自研插件以「已编译独立包」形态挂载，而非源码热加载
| 项 | 内容 |
|---|---|
| 文档原文 | 未规定插件分发形态（§一 只说"仅必要时写插件"） |
| 本方案 | 宿主机用 esbuild 把 `nocobase/plugins/service-ticket/src/**` 编译成 CJS 单文件 → `storage/plugins/@local/service-ticket/dist/server/index.js`；compose 把该目录**同时**挂到容器内 `storage/plugins`（被扫描发现）与 `node_modules/@local/service-ticket`（被 `require.resolve` 解析） |
| 理由 | NocoBase 2.x 加载插件需要同时满足：① 包名命中 `PLUGIN_PACKAGE_PREFIX` 白名单；② 能被 node 以包名解析；③ `package.json.main` 指向已编译 JS（容器内无构建工具链）。三条件缺一即启动失败或插件静默不启用。经阅读 `@nocobase/server@2.2.15` 的 plugin-manager 与 `@nocobase/utils@2.2.15` 的 plugin-package/plugin-symlink 源码确认 |
| 影响 | 改插件源码后必须重跑 `node scripts/build-plugin.mjs`（脚本内置产物自检）；换取的是**生产镜像零构建依赖**、启动快、可离线部署 |
| 可逆 | ✅ 可逆（改回镜像内 `nocobase build` 流程即可，代价是镜像体积与构建时间上升） |
| 状态 | 已实现（Phase 1） |

## DEV-13 脚本形态与计划不符：不写 `Dockerfile`，脚本用 `.mjs` 而非 `.sh`
| 项 | 内容 |
|---|---|
| 文档原文 | `DEV-PLAN.md` Phase 1 产出列了「`Dockerfile`（COPY 插件并构建）」与「`scripts/init-env.sh`、`backup.sh`、`restore.sh`」 |
| 本方案 | ① **不写 `Dockerfile`**：用官方镜像 + bind mount，容器内零构建依赖（理由见 DEV-12）；② 脚本改名为 `gen-secret.mjs` / `build-plugin.mjs` / `verify-config.mjs` / `verify-plugin-load.mjs`，用 Node 而非 shell |
| 理由 | ① 自建镜像只增加维护面（每次 NocoBase 升版都要重做基础层），而挂载方案功能等价且可回退；② 目标环境是 Windows 开发机 + Linux 服务器，`.sh` 在 Windows 侧需 WSL/Git Bash 才能跑，而 Node 已因插件构建成为**硬依赖**，用 `.mjs` 可跨平台零额外依赖；③ `verify-*.mjs` 是计划外的增益——它们把「启动后才发现」的部署层错误提前到启动前 |
| 影响 | 备份/恢复未做成脚本（只有 README 中的命令行），因为「备份到哪里、如何异地」属部署环境决策，做成脚本反而限制用户；Phase 10 若确认了备份策略再补 |
| 可逆 | ✅ 可逆 |
| 状态 | 已实现（Phase 1） |

## DEV-14 强制全部 collection 启用 `underscored: true`（NocoBase 默认是驼峰）
| 项 | 内容 |
|---|---|
| 文档原文 | 未规定命名策略；`docs/DATA-MODEL.md`、`PHASE-0/1` 表结构清单、验收 SQL **全部**写下划线（`service_tickets` / `created_at`） |
| 本方案 | 所有 collection **必须**经 `defineAppCollection()` 定义，它只做一件事：强制 `underscored: true`；禁止任何文件绕过它直接调 `defineCollection()` |
| 理由 | NocoBase 的 `underscored` 默认是 **false**。在该默认值下，`serviceTickets` 会建成带双引号的驼峰表 `"serviceTickets"`，自动注入的时间戳列也是驼峰 `createdAt`。而 `DATA-MODEL.md`、`EXPECTED_TABLE_NAMES`、`smoke-test.mjs`、健康检查的表名白名单**全部**按下划线写 —— 两边对不上会直接导致：① 索引里写 `['created_at']` → PG 报 `42703 undefined_column` → `db.sync()` 抛错 → 应用启动失败、`/api/*` 持续 503；② 验收脚本按下划线查表全部查不到 |
| 影响 | 表名/时间戳列全部下划线，与文档零漂移。业务字段本来就是显式 snake_case（`ticket_no`/`store_id`…），`snakeCase()` 对它们幂等，无副作用 |
| 可逆 | ✅ 可逆（但需同步改文档、验收 SQL 与全部 `EXPECTED_TABLE_NAMES`，代价极不对称） |
| 状态 | 已实现（Phase 1 真机启动）；`verify-plugin-load.mjs` 有专项断言守卫 |

## DEV-15 配置表命名为 `serviceSettings`，不叫文档里的 `systemSettings`
| 项 | 内容 |
|---|---|
| 文档原文 | `docs/DATA-MODEL.md` §11、`PHASE-0.md`、`STATE-MACHINE.md`、`ASSUMPTIONS.md` C-17、`DEV-PLAN.md` 工程约定均写 `systemSettings` |
| 本方案 | 逻辑名 `serviceSettings`，表名 `service_settings` |
| 理由 | NocoBase 核心**已占用** `systemSettings` 这个集合名（由 `@nocobase/plugin-system-settings`、`plugin-acl`、`plugin-users` 共同定义，字段是 `title`/`logoId`/`enabledLanguages`/`allowSignUp`…）。若沿用该名，`registerCollections()` 的 `hasCollection()` 会判定"已存在"从而**静默跳过注册**，随后 `seedSettings()` 会写进 NocoBase 核心表并报 `column systemSettings.key does not exist` —— 参数一条都种不进去，`/api/svc:health` 长期 degraded。这是典型的「不报错、只是不生效」型事故 |
| 影响 | 功能完全等价；四份文档中的 `systemSettings` / `system_settings` 已同步改为 `serviceSettings` / `service_settings` |
| 可逆 | ❌ 不推荐回改（改名会再次与核心冲突） |
| 状态 | 已实现（Phase 1）；`verify-plugin-load.mjs` 有「不得使用 NocoBase 核心保留名」专项断言守卫 |

## DEV-16 collection 级索引被 NocoBase **静默丢弃** → 增加 `ensureIndexes()` 兜底补齐
| 项 | 内容 |
|---|---|
| 文档原文 | `docs/DATA-MODEL.md` §13 末行早就预留了预案：「复合索引声明方式：`defineCollection` 的 `indexes`；**若不支持 → `QueryInterface.addIndex()` 补建（T-01）**」 |
| 现象 | Phase 1 真机启动后，11 张表全部建出、健康检查 200、日志**零报错**，但 `serviceVisitPhotos` / `ticketEvents` / `smsLogs` 三张表共 **8 条** collection 级索引从未下发到 Postgres，其中 2 条是业务幂等键（`unique(file_id)`、`unique(provider,biz_id)`）。仅靠"表存在 + 健康 200"完全发现不了 |
| 根因（读 NocoBase 2.2.15 源码定位） | `@nocobase/database` 的 `collection.refreshIndexes()`（`lib/collection.js:673-689`）在重建 `model._indexes` 时，用 `item.fields.every((field) => attributes[normalizeFieldName(field)])` 过滤：**只要某一列还没注册到 model 上，引用它的整条索引就被丢弃**——不抛错、不告警、不重试。而 `refreshIndexes()` 只由 `addIndex()/removeIndex()` 触发，后者由字段级索引注册触发（`fields/field.js:140`、`fields/belongs-to-field.js:130`），因此**是否丢索引取决于字段注册顺序**。另外 Sequelize 建索引读的是 `model._indexes` 而非 `options.indexes`（`sequelize/lib/model.js:989`），NocoBase 的 `SyncRunner.performSync` 就是裸调 `sequelize.Model.sync.call()`，所以一旦被丢弃就再没有第二次机会 |
| 本方案 | 新增 `src/server/ensure-indexes.ts`，用**公开**的 `queryInterface.showIndex()/addIndex()`（不依赖框架私有 `_indexes` 重建逻辑）在 `afterLoad` 之后核对补齐：① 按「列集合 + 唯一性」做**语义等价**判定（不看索引名，因此能与字段级 `unique` 生成的 PG UNIQUE CONSTRAINT 正确互认）；② **只增不删**；③ 同列已有非唯一索引但需要唯一时，用 `_uk` 后缀换名避免 `relation already exists`；④ 数据源不适用时返回 `applicable:false` 跳过而非抛错；⑤ 补齐失败**抛错**（沿用"宁可启动失败，也不带半套表结构对外服务"的原则） |
| 为什么挂 `afterLoad` | `app.load()` 时序为 `emitAsync('beforeLoad')` → `pm.load()` → `if(options.sync) await db.sync()` → `emitAsync('afterLoad')`（`@nocobase/server/lib/application.js:426-476`）。`afterLoad` 是**唯一**既保证表已建好、又每次启动都触发的位置（`afterEnable` 只覆盖后台启用路径）。`emitAsync` 会 await 监听器并向上抛错，因此挂这里能正确阻断启动 |
| 实测 | 首次加载日志 `索引核对：新建 8 条 / 已存在 27 条`；第二次加载 `新建 0 条 / 已存在 35 条`（**幂等验证通过**）。补建的正是那 8 条 |
| 影响 | 索引兜底补齐后，`smoke-test.mjs` 的「每张表声明式索引全部落库」改为**逐表逐条强制**比对（不再是抽样）；并新增"无重复同义索引"扫描 |
| 可逆 | ✅ 可逆（删掉 `ensure-indexes.ts` 与两处接线即可，但会退回"索引随机缺失且无任何信号"的状态，不建议） |
| 状态 | 已实现（Phase 1 真机验收）；形成三方闭环：`scripts/expected-indexes.mjs`（单一事实来源）→ `verify-plugin-load.mjs`（离线比声明）→ `smoke-test.mjs`（真机比落库） |

## DEV-17 清理 4 组「同一列上的重复同义唯一索引」
| 项 | 内容 |
|---|---|
| 现象 | `service_tickets.ticket_no`、`service_visits.access_token_hash`、`daily_sequences.seq_key`、`service_settings.key` 四列上**各有两个**唯一索引 |
| 根因 | 同一列被**两种方式**声明了唯一性：① 字段级 `unique: true` → PG 自动建 **UNIQUE CONSTRAINT**（索引名 `<table>_<col>_key`）；② collection 级 `indexes: [{ fields: [...], unique: true }]` → 另建 **UNIQUE INDEX**（索引名 `<table>_<col>`）。两者语义等价，但 PG 视为两个独立索引 |
| 本方案 | 删除 4 个 collection 文件里的冗余 collection 级声明（唯一性一律只由**字段级 `unique: true`** 声明），并 `DROP INDEX` 掉库里多余的那 4 个（**保留** `_key` 结尾的 CONSTRAINT，它才是字段级声明产出的） |
| 影响 | 每列少一个索引的写入与存储开销；避免"改了一个漏了另一个"的长期隐患。`sms_logs(provider,biz_id)` 这类**无字段级声明的复合唯一**仍保留 collection 级声明（那是它唯一的手段，见 DEV-16） |
| 可逆 | ✅ 可逆（但没必要） |
| 状态 | 已实现（Phase 1）；`smoke-test.mjs` 与 `verify-plugin-load.mjs` 各有"无重复同义索引"断言守卫 |

> **DEV-16/DEV-17 的共同教训**：这两类问题**都不会让程序报错**——
> 表建出来了、接口 200、日志干净，只有把「应该有 35 条索引」写成清单去逐条核对才暴露。
> 因此本项目把"索引必须存在"从代码里独立成 `scripts/expected-indexes.mjs`，
> 由离线校验（比声明）与真机校验（比落库）双向卡住，任一侧漂移都会立即失败。

---

## DEV-18 内部业务接口的对外路径由 **nginx 重写**成 NocoBase 可达形态
| 项 | 内容 |
|---|---|
| 文档原文 | `docs/API.md` §4 约定对外路径为 `/api/svc/tickets/:id/<action>`（如 `POST /api/svc/tickets/12/accept`） |
| 现象 | 直接按该路径注册 action 会让接口**完全不可达**，返回 404。真机实测：`/api/svc:tickets:accept` → `action does not exist` 被中间件 try/catch 吞掉 → 404，日志里看不到任何"配置错了"的线索 |
| 根因（读 NocoBase 2.2.15 源码定位） | `@nocobase/resourcer/lib/utils.js` 的 `parseRequest` 对 `/api/<a>:<b>:<c>` 只做**一次** `split(':')`：<br>`const [resourceName, actionName] = params.resourceName.split(':');`<br>第三段被**静默丢弃**，于是 `svc:tickets:accept` 被解析成 `resource=svc` / `action=tickets`。即：**多段 action 名在 NocoBase 里根本不存在**，不是"要额外配置"的问题 |
| 本方案 | action 名一律**单段**（`SVC_ACTION = { health, accept, transfer, cancel, timeline }`）；对外路径由 nginx 重写折叠：<br>`location ~ ^/api/svc/tickets/(?<svc_ticket_id>[0-9]+)/(?<svc_action>accept\|transfer\|cancel\|timeline)$` → `rewrite … /api/svc:$svc_action?filterByTk=$svc_ticket_id&page=$arg_page&pageSize=$arg_pageSize break;` |
| 为什么 action 用**枚举**而非 `(?<act>.+)` 通配 | 通配会把拼错的 action（`/api/svc/tickets/1/accep`）也转发给应用，应用回 404 —— 与"这个接口根本不存在"撞在同一个响应码上，排查时分不清是路由没配好还是参数写错。枚举让 nginx 直接 404，语义唯一；且新增 action 必须显式改这一行（变更可见、可评审） |
| 为什么只透传 page/pageSize 而不是 `&$args` | 直接透传原始 query 会让调用方追加 `&filterByTk=<别人的工单>`；NocoBase 的 qs 把重复键解析成数组、绕过取值。虽然下游会因"不是正整数"422（fail-closed），但路由层就该把参数面收敛到最小 |
| 影响 | `docs/API.md` §4 的对外路径**保持不变**（nginx 对外仍是 `/api/svc/tickets/:id/<action>`），仅内部实现路径不同；新增 action 需同步改 3 处（`SVC_ACTION`、`registerSvcResource` 的 `only`、nginx 枚举） |
| 可逆 | ✅ 可逆（若 NocoBase 后续支持多段 action，删掉 nginx 重写段即可） |
| 状态 | 已实现（Phase 2）；`verify-plugin-load.mjs` 有「action 名全部为单段」断言守卫，`smoke-test.mjs` 逐条验证冒号/斜杠两种写法均可路由 |

## DEV-19 原生只读接口的资源白名单收敛为 `list` / `get`（`create` 直接拒绝）
| 项 | 内容 |
|---|---|
| 文档原文 | `docs/API.md` §6「后台列表/详情读取 ✅ 允许」「状态类变更 ❌ 禁止直调原生 update」 |
| 本方案 | `NATIVE_READ_ALLOWLIST` 只列 `serviceTickets` / `serviceVisits` / `ticketEvents` / `smsLogs` 四个资源的 `['list','get']`。<br>· `create` —— 由 `storeScope` 中间件**直接拒绝**：业务写入必须走 `/api/svc` action（否则绕过状态机、事件时间线与幂等）；<br>· `update` / `destroy` / `export` —— Phase 2 **一律不开放** |
| 理由 | 原生接口的 ACL 粒度只有「资源 × action + fields 列表」，没有"只能改某些字段"的表达能力。而文档允许的"仅限非状态字段的后台修改"正是这个形状 —— 用 fields 表达会依赖运行时界面配置，界面一改约束就消失（fail-open）。宁可先不开，等 Phase 3+ 用自定义 action 提供受限编辑 |
| 影响 | 后台的写操作暂时不可用（读全通）；被 `verify-plugin-load.mjs` 的「svc 资源用 only 收敛：原生 CRUD 一律不在其中」与「4 个资源 × 仅 list,get」两条断言卡死 |
| 可逆 | ✅ 可逆（放开即在 `NATIVE_READ_ALLOWLIST` 增补，但需同时补 fields 白名单，见 DEV-23） |
| 状态 | 已实现（Phase 2） |

## DEV-20 对外"拒绝"类错误的日志级别策略（404 → debug，401/403 → warn）
| 项 | 内容 |
|---|---|
| 文档原文 | `docs/API.md` §0 要求「越权与不存在统一返回 404」；`docs/SECURITY.md` 未规定这类拒绝的日志级别 |
| 现象 | 该安全设计**本身会让应用日志堆满 error**。真机实测：门店用户 `GET /api/serviceTickets:get?filterByTk=<他店id>` 返回 404（符合文档），同时 app 日志出现<br>`{"level":"error","message":"工单 10 不存在","extra":{"method":"error-handler","err":"NotFoundError: …"}}`<br>后果：`smoke-test.mjs` 的「app 日志无 error 级输出」断言被预期噪声打成红色，而该断言才是"应用真的出事了"的唯一信号 —— <b>误报和漏报一样有害</b> |
| 根因（读 NocoBase 2.2.15 源码定位） | `@nocobase/plugin-error-handler/dist/server/error-handler.js` 兜住异常后**一定会写一条日志**，级别由 `err.logLevel` 决定：<br>`const logMethods = ['trace','debug','info','warn','error'];`<br>`getLogMethod = (err) => logMethods.includes(err?.logLevel) ? err.logLevel : 'error'`<br>中间件层抛出的错误（`storeScope` 的对象级校验）会直接落到它手里；不设 `logLevel` 就一律记成 error |
| 本方案 | 在 `NotFoundError` / `ForbiddenError` 上声明 `logLevel`（这就是框架留给使用方的机制）：<br>· `NotFoundError` → **`debug`** —— 404 是刻意不可区分的对外语义，陈旧书签/刷新已删工单/ID 猜错都会产生，不能当信号。与 action 层口径一致（`_http.ts` 的 `handleError` 对 404 **一条日志都不写**）；框架强制要写，就写到生产默认级别（`info`）之下<br>· `ForbiddenError` → **`warn`** —— 401 会话过期、403 权限错配/被试探值得看一眼，与 `handleError` 对 403 记 warn 的口径一致 |
| 安全线索会不会丢 | 不会，有两条更准确的路：<br>① `PermissionService` 自打的 `[permission] 越权访问被拒：用户 19（授权门店 [1]）尝试访问门店 2 的工单 14`（warn，真机实测）；<br>② NocoBase 请求日志按状态码分级（4xx → warn）输出 `response /api/serviceTickets:get?filterByTk=14`。<br>两条都保留了"谁、何时、访问了谁的什么"，被抑制的只是重复的堆栈 |
| 可观测性开关 | `docker-compose.yml` 的 app 服务新增 `LOGGER_LEVEL: ${LOGGER_LEVEL:-info}`（`@nocobase/logger` 的取值是 `LOGGER_LEVEL \|\| (APP_ENV==='development' ? 'debug' : 'info')`）。需要复现某次越权请求的完整链路：`LOGGER_LEVEL=debug docker compose up -d app`，排查完改回。**已实测**：同一请求在 debug 下落 `{"level":"debug",…,"method":"error-handler"}`，默认级别下不落盘 |
| 可逆 | ✅ 可逆（删掉两个 `logLevel` 字段即回到"预期拒绝也记 error"） |
| 状态 | 已实现（Phase 2）；`verify-plugin-load.mjs` 有专项断言：级别必须是框架**认识**的字符串（写成 `'warning'` 会静默回落成 `error`）且不得为 `'error'` |

## DEV-21 门店种子为**占位清单**（正式清单待业务方提供）
| 项 | 内容 |
|---|---|
| 文档原文 | 开发文档附录 E-03「门店清单」；`docs/ASSUMPTIONS.md` E 节列为"上线前置依赖" |
| 本方案 | `seeds/stores.ts` 落 **15 家占位门店**（`code` 形如 `S01…S15`，与开发文档里的连锁规模一致；`contact_phone` 占位为 `null`） |
| 理由 | Phase 2 的验收项 AT-03（门店隔离）**必须有 ≥2 家真实门店才能证伪** —— 只有一家门店时"门店用户看不到别家工单"这个断言恒真，测了等于没测。先落占位数据把隔离链路跑通，避免把 AT-03 拖到有正式数据之后 |
| 影响 | 占位 `code` **不得对外发布**：`code` 会印在门店二维码上且一经使用不可变更。上线前必须用正式清单替换，且替换时**不能改已发出的 code**（`seedStores()` 的语义是"按 code 只增不改"，改名/停用走后台） |
| 可逆 | ✅ 可逆（改一处常量；正式清单到位后只增不改地补真实门店） |
| 状态 | 占位已实现（Phase 2）；**待确认输入**，见 `docs/PHASE-2.md` §「待确认输入」 |

## DEV-22 四个业务角色在**原生接口**上不授予任何写 action（比文档严一档）
| 项 | 内容 |
|---|---|
| 文档原文 | `docs/API.md` §6 允许"仅限非状态字段的后台修改" |
| 本方案 | `ROLE_NATIVE_READ_ACTIONS = ['list','get']` —— `create` / `update` / `destroy` / `export` / `move` **不授予任何角色**；业务写入只走 `/api/svc` action |
| 理由 | NocoBase 的资源级授权（`dataSourcesRolesResourcesActions`）是「整个 action + 字段列表」，用它表达"可以改备注但不能改 status"完全依赖 `fields` 的运行时配置 —— 一旦有人在后台把字段白名单放开，约束当场消失（fail-open）。这类"靠界面配置维持的安全边界"不可审计，因此 Phase 2 选择**直接不开**，等后续用自定义 action 提供受限编辑接口（可单测、可评审、可回滚） |
| 影响 | 后台无写能力（读全通）；由 `verify-plugin-load.mjs` 的「角色策略只含 view/list/get」与「只列只读 action」两条断言守卫 |
| 可逆 | ✅ 可逆（增补 action 即放开，但必须同时补 `fields` 白名单，见 DEV-23） |
| 状态 | 已实现（Phase 2） |

## DEV-23 权限判定是**三级**的：只写前两级 = 每张表 403；action 行的 `fields` 三态 = 凭证泄露
| 项 | 内容 |
|---|---|
| 文档原文 | 开发文档把权限写成"角色 → 可访问集合"的一对多关系（一级）；`docs/API.md` §6 只声明"允许/禁止" |
| 现象（两类，都不报错） | ① **每张表 403**：`dataSourcesRoles` 写好了 4 个角色、前端进后台却每个资源都 `403 {"errors":[{"message":"No permissions"}]}`；<br>② **凭证泄露**：`viewer`（只读管理层）角色的 8 条 action 行 `fields` 是 `null`，实测 `GET /api/serviceTickets:list` 返回 **36 个键**，其中含 `feedback_token_hash` / `feedback_token_expires_at` / `feedback_token_used_at` —— 评价 Token 的哈希被整行下发，等于把"猜 Token"的离线爆破材料送到客户端 |
| 根因 | NocoBase 的判定链有**三级**，缺任一级都表现为"不报错但不生效"：<br>① `dataSourcesRoles.strategy.actions` —— 全局 action 名白名单；<br>② `dataSourcesRolesResources` + `…Actions` —— **逐资源**授权（只写 ① 时任何资源都匹配不到 ②，一律 403）；<br>③ action 行上的 `fields` 字段白名单，且它有三种语义：<br>&nbsp;&nbsp;· `null` = **整行下发**（框架的 `mergeActionParams` 只在 `'intersect'` 模式下做交集，`null` 不触发特例）→ 泄露凭证；<br>&nbsp;&nbsp;· `[]` = 只剩 `id/createdAt/updatedAt` 的空壳（HTTP 200，业务列全丢）；<br>&nbsp;&nbsp;· `白名单` = 目标状态（业务列 + 框架强补的 `createdAt`/`updatedAt`） |
| 附带的关键坑 | `fields` 白名单的元素必须用 **ORM 属性名**。`@nocobase/database` 的 `collection.getFields()` 实现是 `return [...this.fields.values()]` ——**返回数组**，元素是字段实例。用 `Object.keys(collection.getFields())` 取到的会是 `["0","1",…,"32"]` 这种**数字索引**垃圾白名单（数量恰好也是 33，因此与正确结果"看起来一致"，极难发现）。权威来源是 `collection.model.rawAttributes` 的键：含 `id` / `store_id` 这类外键列 / `createdAt` 驼峰时间戳，**不含**关联名（`store` / `handler`） |
| 本方案 | ① 资源级授权与角色策略**双表同写**（`seeds/roles.ts` + `seeds/apply.ts`）；<br>② `nativeReadFieldsOf()` 改用 `collection.model.rawAttributes`；<b>取不到字段目录即抛错，绝不退化成整行下发</b>；<br>③ 新增 `repairUnsafeActionFields()`，把 `null` / `[]` 一律纠正为白名单，**运营自定义的非空白名单一律不碰**，并补建"有资源行但缺 action 行"（缺行 = 该 action 恒 403）的条目；<br>④ 修复逻辑挂在 **`afterLoad` 自愈**而不是迁移里：umzug 迁移跑过就不再重跑，而"给已安装实例补数据"必须每次启动都能生效 |
| 实测 | 自愈日志：`资源级授权自愈（afterLoad）：补建 3 条资源授权行，修正 24 行不安全的字段白名单（null/空数组）`；字段数 33/24/12/18 与真机属性表推算一致。反证：把 `viewer/serviceTickets` 改回 `[]` 重启 → `修正 2 行不安全的字段白名单` 再次触发 → 33 列恢复 |
| 影响 | `/api/svc:health` 新增 `rolesInAcl`（一级）与 `rolesResourcesInAcl`（二级）两个计数器 —— "角色建好了但后台每张表都 403"从此可被一眼看出；`smoke-test.mjs` 新增 8 项 Phase 2 验收（含"字段白名单不含敏感列"） |
| 可逆 | ❌ 不推荐（退回只写一级 = 后台全 403；退回 `null` = 凭证泄露） |
| 状态 | 已实现（Phase 2 真机验收）；离线桩已按真机形状重写（`getFields()` 返回**数组** + `model.rawAttributes` 映射），并新增「白名单名字来源」「取不到字段目录必须抛错」两条防退化断言 |

> ⚠️ DEV-23 里"**运营自定义的非空白名单一律不碰**"这条口径已在 Phase 2.1 **被 DEV-24 取代**（改为"漂移即对齐"）。理由见 DEV-24。

---

## DEV-24 字段白名单从"不碰非空数组"改为"**漂移即对齐**"，并新增无主行清理
| 项 | 内容 |
|---|---|
| 触发 | Phase 2 独立验收（用户，2026-09-20）判定 **Phase 2 = HOLD**，整改项 4 要求"清理 viewer 测试探针遗留配置，给出正式字段白名单，加自动化断言，保证重新部署后配置一致" |
| 现象（三个，都不报错） | ① **测试残留被固化**：真机取证探针（`.probe/fields-semantics.mjs`）把 `viewer/serviceTickets` 的两条 action 行改成 7 列。那 7 列不含敏感列、接口也回业务列，**所有"安全检查"都能过**，但它与其余 30 条 action 行不一致 —— 报告只能写成"与其余角色不一致"；<br>② **无主授权行堆积**：库里出现 `roleName` 为 `NULL` 的 `dataSourcesRolesResources` 行（实测 7 条），它们永远不会被 ACL 加载，却让"授权配置是否一致"变成**不可判定**；<br>③ **每次启动误报并重写 16 行**：`list` 动作的 `fields` 被 NocoBase 重排，逐位比较把它判成漂移 → 每次部署刷 16 条 warn + 16 条 UPDATE |
| 根因 | ① 旧口径对"非空数组"一律不碰，动机是"不覆盖运营配置"；但字段白名单是**安全边界**，与 DEV-19 / DEV-22 同一条理由：不接受后台手工维护；<br>② `roles.resources` 是 `hasMany(sourceKey:'name', foreignKey:'roleName')`，替换关联时 Sequelize 执行的是 `UPDATE … SET roleName = NULL`（把旧行脱钩），而库里**没有 `roleName` 的外键约束**（实测 `pg_constraint` 只有主键）→ 旧行永久留成无主行。详见 DEV-27；<br>③ NocoBase 自己会在 `list` 动作上规范化重排 `fields`（同一份白名单：`get` 行保持原序、`list` 行被重排）。而 `fields` 在语义上是**集合** —— 顺序只影响 SELECT 的列序，不影响任何一条鉴权判定 |
| 本方案 | ① `repairUnsafeActionFields()` 重写为四类修正：缺 action 行 → 补建；`null` → 纠正；`[]` → 纠正；**非空但与期望不同集合 → 对齐**（第 ④ 类）；<br>② 新增 `removeOrphanResourceRows()`：删除 `roleName` 为 `NULL` / 空串的行**及其 action 行**（只删这一类，自定义角色的行一律不碰）；<br>③ 新增 `sameFieldSet()` 按**集合**比较（忽略顺序与重复），替换原先的逐位比较；<br>④ 漂移告警日志改成报**集合差**（多出/缺少/仅顺序），一条日志即可定性；<br>⑤ 逃生开关 `SVC_ACL_FIELDS_AUTOFIX=0` **只管第 ④ 类**，`null` / `[]` 永远纠正（那是漏洞，不是配置） |
| 断言 | `verify-plugin-load.mjs`（离线，桩上跑）：三类修正 + 逃生开关语义 + 32 条 action 行与期望同集合 + **无主行会被清理且不误删正常行**（含连带删 action 行）；<br>`smoke-test.mjs`（真机）：**0 条无主行 / 恰好 16 条授权 / 32 条 action / 每张表只有 1 种白名单** |
| 真机验证 | 整改前：11 条无主行 + viewer 缺 3 张表授权 + 14 行白名单漂移。`docker compose restart app` 后：日志 `清理 11 条无主行` + `补建 3 条资源授权行` + `修正 14 行`；库内 0 无主行 / 16 授权 / 32 action / 4 张表各 1 种白名单；**再重启一次，自愈日志为 0 条**（幂等） |
| 影响 | 白名单的"单一事实来源"从"库里的多数派"变成"代码里的 `nativeReadFieldsOf()`"；`SVC_ACL_FIELDS_AUTOFIX` 新增 `.env` 变量（`.env` 键数 63 → 64） |
| 可逆 | ⚠️ 部分可逆：`SVC_ACL_FIELDS_AUTOFIX=0` 可关闭第 ④ 类；但无主行清理与 `null`/`[]` 纠正不可关闭 |
| 状态 | 已实现（Phase 2.1 整改）；真机 + 离线双绿 |

## DEV-25 NocoBase 版本**正式冻结**为 `2.2.15-full-no-nginx`（升级需单独 Change Request）
| 项 | 内容 |
|---|---|
| 触发 | Phase 2 独立验收整改项 5："接受 2.2.15-full-no-nginx 变更，正式冻结；未经单独 Change Request 不允许后续 Phase 自行升级；所有自动化测试以此版本为基准" |
| 背景 | Phase 1→2 期间镜像实际从 `nocobase/nocobase:1.x` 切到 `2.2.15-full-no-nginx`（原因与影响见 DEV-14 / DEV-18）。这次变更此前只存在于 compose 文件里，**没有任何机制阻止下一个 Phase 顺手再升一版** |
| 本方案 | 新增 `scripts/expected-versions.mjs` 作为**唯一事实来源**（`NOCOBASE_IMAGE` / `NOCOBASE_VERSION` / `POSTGRES_IMAGE` / `VERSION_PINNED_AT`）；<br>`verify-config.mjs` 增加两条断言：<br>① 三处镜像 tag（`.env` / `docker-compose.yml` / 冻结常量）**逐字一致**；<br>② 插件 `package.json` 声明的 NocoBase 兼容范围覆盖冻结版本（而不是硬编码 `2.x`）；<br>离线校验原本还读 `package.json main` 里的 `supportedVersions`，现在改为以冻结版本为基准，避免"改 compose 忘了改插件声明" |
| 影响 | 升级 NocoBase 从"改一个 tag"变成"必须显式改 `expected-versions.mjs` 并让三条断言重新变绿"——即一个**需要评审的动作** |
| 可逆 | ✅ 可逆（改冻结常量 + 让断言重新变绿） |
| 状态 | 已实现（Phase 2.1 整改）；`verify-config.mjs` 43 项全绿 |

## DEV-26 生产部署**不得**依赖开发目录 bind mount（Phase 10 必须重新评估"不可变生产镜像"）
| 项 | 内容 |
|---|---|
| 触发 | Phase 2 独立验收整改项 6："Dockerfile 偏差记录：Phase 10 生产部署必须重新评估不可变生产镜像，生产环境不能默认依赖开发目录 bind mount 作为唯一发布机制" |
| 现状 | 见 DEV-13（不写 `Dockerfile`）与 DEV-12：插件以**已编译独立包**形态挂到 `storage/plugins/`，compose 把 `./storage` 与 `./storage/plugins/@local/service-ticket` bind mount 进容器。开发期这样最快（改完 `build-plugin.mjs` + `restart` 即生效） |
| 风险 | 这条链路成立的前提是"宿主机的 `storage/` 与容器内一致"。在生产上它意味着：<br>① **发布物不是不可变镜像**——回滚要回滚文件系统，而不是回滚一个 tag；<br>② 宿主机与该目录的**权限/属主**、SELinux/挂载选项都会成为故障面；<br>③ 同时存在容器内 `storage` 与宿主 `storage` 两份可写状态时，"当前到底跑的哪一版"无法从镜像 digest 自证；<br>④ 插件产物（`dist/`）被当成"运行时数据"而不是"构建产物" |
| 本方案 | **Phase 10（生产部署）必须重新评估**，候选方向：把插件 `dist/` 打进镜像（多阶段构建，`COPY --from=builder`），只把真正的运行时状态（`storage/uploads`、`storage/logs`）留作卷；若最终仍保留 bind mount，必须补一份书面理由 + 回滚脚本 + 版本自证手段（容器内记录镜像 digest 与插件产物 hash） |
| 影响 | Phase 10 的交付项新增"生产发布形态评审"这一条；在完成之前，**当前形态只适用于开发/联调环境** |
| 可逆 | ✅ 可逆（这正是 Phase 10 要决策的事） |
| 状态 | ⏳ 已登记，待 Phase 10 处理（**未完成，不得视为已解决**） |

## DEV-27 `POST /api/roles:update`（带 `resources` 载荷）会**脱钩旧行并丢 `roleName`** —— 探针残留的真正来源
| 项 | 内容 |
|---|---|
| 触发 | 清理 viewer 探针残留时发现库里有 7 条 `roleName` 为 `NULL` 的授权行，来源不明；Phase 2.1 整改项 4 要求"保证重新部署后配置一致"，因此必须查清成因，否则每次部署都会继续产生垃圾 |
| 取证（真机，2026-09-20） | ① `.probe/fields-semantics.mjs` 调用的 `POST /api/roles:update?filterByTk=viewer`（body 只带 `serviceTickets` 一个资源）**一次就把无主行从 7 条变成 11 条**（受控实验，前后各查一次 `count(*)`）；<br>② 该次调用同时**删掉了 viewer 在 `serviceVisits` / `smsLogs` / `ticketEvents` 三张表上的授权**（`roleName='viewer'` 的行从 4 条变成 1 条）——即"改一张表的白名单"实际会丢掉该角色其余三张表的读取权限；<br>③ 被脱钩的旧行 `updatedAt` 被刷新、`createdAt` 不变（`19:11:48` 创建 → `19:19:45` 被改），说明实现是 `UPDATE … SET roleName = NULL` 而不是 `DELETE` |
| 根因 | `roles.resources` 定义为 `hasMany(target: dataSourcesRolesResources, sourceKey: 'name', foreignKey: 'roleName')`（`@nocobase/plugin-acl/dist/server/collections/roles.js`）。`roles:update` 走的是**关联替换**语义：先把旧关联"清空"（对无外键约束的库就是 `SET roleName = NULL`），再按载荷插入新行；而新行插入过程本身也会留下 `roleName` 为空的行。库里没有 `roleName → roles.name` 的外键（`pg_constraint` 只有主键），因此没有任何机制清理这些脱钩行 |
| 本方案 | ① **自愈**：启动期 `removeOrphanResourceRows()` 清掉无主行，并按 `(roleName, dataSourceKey, name)` 补回被丢掉的授权（见 DEV-24）；<br>② **门闩**：给 `.probe/fields-semantics.mjs` 加硬门闩 —— 必须显式 `SVC_PROBE_ALLOW_DESTRUCTIVE=1` 才执行，否则以退出码 2 拒绝并打印恢复步骤；<br>③ **断言**：`smoke-test.mjs` 的真机断言要求"0 条无主行 + 恰好 16 条授权"；<br>④ 本条只做**取证与登记**：不修改 NocoBase 内部实现，也不声明"已修复上游" |
| 影响 | 运维须知：**在后台角色管理页保存角色，或调 `roles:update` 并带上 `resources` 载荷，会丢失该角色其余资源的授权**，直到下一次部署的启动期自愈恢复。若后续需要"安全地改单个资源授权"，应改走 `dataSourcesRolesResources:update` 直改 action 行的 `fields`，而不要走 `roles:update` 的整组替换 |
| 可逆 | ✅ 可逆（去掉门闩、去掉清理即可回到原状，但垃圾行会重新累积） |
| 状态 | 已取证 + 已加自愈与门闩（Phase 2.1）；**上游行为未改变，属已知平台缺陷** |

---

## DEV-28 匿名白名单上新增只读诊断接口 `GET /api/svc:guardQuota`（文档未提及）
| 项 | 内容 |
|---|---|
| 文档原文 | 文档未提及"限流额度查询"接口；§9/§14 只要求"IP/手机号频控与防连点" |
| 本方案 | 新增 `GET /api/svc:guardQuota?scene=&scope=`（`svc` 资源，**匿名白名单**第 3 条），要求请求头 `X-Svc-Diag-Key` 等于进程内 `SIGN_SECRET`，比较用 `crypto.timingSafeEqual`；`SIGN_SECRET` 为空时对一切请求返回 **404**（fail-closed） |
| 理由 | `scripts/verify-concurrency-phase2.mjs` 必须在**发压前**知道"本 IP 在当前分钟窗口还剩多少额度"，否则只能"先发 100 路、再靠 429 事后判断"——那时已经污染了结论。<br>这个数**只能由应用给**：桶的维度值是客户端 IP（脚本走 localhost、应用在容器内、中间还有 Docker NAT，脚本看到的 IP 未必等于 `X-Real-IP`），桶键是 `sha256(IP + SIGN_SECRET)`（脚本自己复算就等于把哈希口径复制成第二份实现，一漂移就永远查不到占用）。 |
| 影响 | 多一个只读接口。**不消耗任何配额**（走 `GuardService.peek()`，不自增）——绝不能在业务路径上用 peek 替代 consume，那等于没有频控。 |
| 可逆 | ✅ 可逆（删掉 action 与白名单条目即可；脚本会退回"无法预检"并以退出码 2 收场） |
| 状态 | 已实现（Phase 3-E）；`verify-plugin-load.mjs` 断言匿名白名单恰好 4 条 |

## DEV-29 `/h5/` 静态站点必须用 `root` 而不是 `alias`（真机缺陷，白屏级）
| 项 | 内容 |
|---|---|
| 触发 | Phase 3-H 交付后，页面能打开但 `GET /h5/assets/index-<hash>.js` 返回 **301 + 丢失端口** → 白屏 |
| 根因 | 原写法 `location ^~ /h5/ { alias .../h5/; }` + 嵌套 `location ~* ^/h5/assets/ { alias .../h5/assets/; }`。<br>① 正则 location 里的 `alias` **不含捕获组**时，nginx 按"目录"语义处理，于是走目录重定向 → `301` 并**补尾斜杠**；<br>② 301 的 `Location` 由 nginx 用 `server_name` 拼绝对地址，把对外端口 `8080` 丢了（变成 `http://127.0.0.1/h5/assets/x.js/`）。<br>Phase 1 时 dist 只有一个 `index.html`，走 `index`/`try_files` 内部跳转，**不经过那条嵌套正则**，所以从未暴露。 |
| 本方案 | 两处都改用 `root /usr/share/nginx/html;`。本项目的磁盘布局与 URI **本来就是同构的**（`h5/dist` 挂在 `/usr/share/nginx/html/h5` → URI `/h5/x` == 磁盘 `<root>/h5/x`），不需要 `alias` 的"替换前缀"语义 |
| 影响 | 仅 nginx 配置。附带须知：子 location 内出现 `add_header` 会**覆盖**父级全部 `add_header`（nginx 不做叠加），静态资源段因此丢掉了 `X-Robots-Tag`，属可接受取舍 |
| 可逆 | ✅ 可逆 |
| 状态 | 已修复并复验（`GET /h5/assets/*.js` 与磁盘逐字节一致，带 `immutable` 长缓存头） |

## DEV-30 匿名接口的对外路径用 nginx **显式** rewrite 折叠成 NocoBase 资源名
| 项 | 内容 |
|---|---|
| 文档原文 | 文档只给出对外路径 `GET /api/public/stores`、`POST /api/public/tickets` |
| 本方案 | nginx 里两条**显式** rewrite：`/api/public/stores → /api/publicStore:list`、`/api/public/tickets → /api/publicTicket:create` |
| 理由 | NocoBase 的 URL 形态是 `/api/<resource>:<action>`。`/api/public/tickets` 会被解析成 resource=`public`/index=`tickets`，`getResource('public')` 抛错；更糟的是 `resourcerMiddleware` 是 `catch (e) { console.log(e); return next() }`——**打一行日志然后放行**，于是现象是 404 加一条看起来毫不相干的 "public resource does not exist"。<br>**不用通配** `^/api/public/(.+)`：通配会把拼错的路径也转发给应用并回 404，与"接口不存在"撞在同一个响应码上；显式枚举让拼错路径直接被 nginx 404，且新增匿名接口必须显式改这一段（变更可见、可评审） |
| 影响 | 仅路由层。对外路径与文档完全一致 |
| 可逆 | ✅ 可逆 |
| 状态 | 已完成；与 DEV-18（svc 内部接口同一条理由）同源 |

## DEV-31 限流阈值有**两层**，且 `.env` 只影响**首次种子**（纠正验收步骤）
| 项 | 内容 |
|---|---|
| 触发 | 按 `docs/PHASE-2.md` §7.2 早期写法"改 `.env` 的 `SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT=300` 再 `docker compose up -d app`"，阈值**纹丝不动** |
| 事实（真机取证，2026-09-20） | ① **应用层**：`seedSettings`（`seeds/apply.ts`）是「存在即跳过」——`.env` 只决定**首次**种进 `service_settings` 的值，之后运行期一律以库里的行为准（`ConfigService` 优先读库，只在缺行时回退代码默认值）。所以改 `.env` + 重启**无效**；正确做法是直接 `UPDATE service_settings`，且 `ConfigService` 有 10s TTL 缓存，**连重启都不需要**。<br>② **nginx 层**：`limit_req_zone svc_public rate=30r/m`（站点侧 `burst=10`）与整站 `limit_conn svc_conn 96`。只放宽应用层 → 100 路里约 60 路被网关以 **429** 拦掉，现象与应用层频控**完全一致**，无法区分是哪一层拦的。 |
| 本方案 | ① 修正 `docs/PHASE-2.md` §7.2 的升降配步骤；② 在 `verify-concurrency-phase2.mjs` 里把"两层一起放宽/一起恢复"写成唯一的一份文案（`limitSteps()`），四处提示复用；③ 脚本自动从 `.env` 读 `SIGN_SECRET` 作为 `X-Svc-Diag-Key`（不带时 `guardQuota` 一律 404，会把"我忘了带头"误读成"接口没实现"） |
| 影响 | 运维与验收口径。**不是**为造绿灯而改被测对象：频控与幂等在所有验收里都保持开启，只是把"验收环境临时放宽"这件事写在正确的位置，并在跑完后**两层一起恢复** |
| 可逆 | ✅ 可逆（本条只是文档与脚本口径修正，不涉及产品代码） |
| 状态 | 已修正；恢复后实测 `guardQuota.limit = 30`、nginx 三处限流值经 `git diff` 确认逐字还原 |

## DEV-32 同 `request_id` 并发必须**进程内串行**（真机跑出的真实缺陷）
| 项 | 内容 |
|---|---|
| 触发 | Phase 3-H 验收首次真跑：固定同一 `X-Request-Id` 并发 10 路，期望 `201×1 + 200×9`、序号 `+1`；实际 `201×1 + 200×4 + **429×5**`，序号从 1 跳到 6（**增量 5**） |
| 根因 | 守卫链的 ⑤「读幂等记录」**不产生任何行**。10 路同时到达时，每一路都读到"没有"，于是**全部继续往下走**：⑥ 手机号日频控各自消费一次 → 5 的额度瞬间打满，第 6 路起 429；活下来的 5 路各自 `nextTicketNo()`（取号在事务**外**）→ 序号被推进 5；5 路同时 `INSERT` 幂等记录 → 1 成功、4 撞唯一索引回滚，白耗 4 个号 |
| 为什么不是"验收脚本太苛刻" | 这是**用户自己能触发**的缺陷：前端虽做了 single-flight（10 次点击 → 1 个请求），但弱网重试、多标签页、狂点刷新都会绕过它。后果是客户正常提交一次就烧掉自己手机号的日额度，且工单号出现空洞 |
| 本方案 | 把 ⑤~⑧ 放进一把按 `scene:request_id` 的**进程内锁**：先到者走完整条链，后来者在锁上等到先到者提交完，再进 ⑤ 时幂等表已有该行 → 直接回放 200。**锁不含 ④（IP 频控）**是刻意的：重放仍要消耗 IP 配额，否则同一 request_id 可被无限重放且完全不计数，等于开一条免限流旁路（`guard-service.ts` 文件头第 1 条禁止的正是这个） |
| 影响 | 单进程部署下锁覆盖全部真实流量。横向扩容成多实例后，跨进程并发仍由 `idempotency_records(scene, idempotency_key)` 唯一索引兜底——**正确性不受影响**（不会出两张单），只是那一路会按既有取舍白耗一个号。要做到多实例也零浪费需改为 PG 会话级咨询锁，属扩容时的事 |
| 可逆 | ✅ 可逆（去掉锁即回到原行为，但缺陷会重现） |
| 状态 | 已修复并复验（`201×1 + 200×9`、无 429、序号 `6→7` 增量 1、幂等记录 1 条、事件 1 条） |

## DEV-33 `DEV-PLAN` Phase 3-A 写的 `region` 字段不存在（以 `API.md` §1.1 为准）
| 项 | 内容 |
|---|---|
| 文档原文 | `docs/DEV-PLAN.md` Phase 3 表格 A 行：「`GET /api/public/stores`｜只回 `code`/`name`/**`region`**，不回内部 id 与其他门店信息」 |
| 事实 | `stores` 表**没有** `region` 列（`\d stores` 实测列：`id / created_at / updated_at / code / name / active / sort_order / contact_phone / sort`）；`docs/API.md` §1.1 是**对外接口契约**且写明只返回 `code/name` |
| 本方案 | 实现以 `API.md` §1.1 为准：`{ "code": "S01", "name": "圣大家电新都店" }` 两个字段，**不加** `region` |
| 理由 | 匿名接口多回一个字段就是多一份可被枚举的门店画像；且 `region` 在当前数据模型里根本不存在，凭空造一个等于顺手扩大需求 |
| 影响 | `DEV-PLAN` 该行需按此更正（若业务方确实需要"区域"筛选，应先补 `stores.region` 列与种子，再改契约，属独立变更） |
| 可逆 | ✅ 可逆（补列 + 改契约即可） |
| 状态 | 已按 `API.md` 实现；`DEV-PLAN` 差异在此登记 |

---

## DEV-34 nginx `limit_req burst` 的真实含义：**N+1 次突发 + 按 rate 回填**，不是"一分钟 N 次"
| 项 | 内容 |
|---|---|
| 配置原文 | `nginx/nginx.conf`：`limit_req_zone $binary_remote_addr zone=svc_public:10m rate=30r/m;`<br>`nginx/conf.d/service.conf`：`location ^~ /api/public/ { limit_req zone=svc_public burst=10 nodelay; ... }` |
| 直觉误读 | "30r/m + burst=10 → 每分钟能过 40 次；应用层阈值 30 更严，所以先 429 的必然是应用层" |
| 实测（2026-09-20，同一 `request_id` 连发 45 次） | 只过 **11 次**（`1×201 + 10×200`），**第 12 次起全是 nginx 的 429**；此刻 `/api/svc:guardQuota` 读到应用层 `used = 11`、`limit = 30` —— 应用层**根本没到阈值** |
| 机制 | `limit_req` 是漏桶：桶容量 = `burst`（10），初始为空 → 可连续放行 `burst + 1 = 11` 次；此后每 `1/rate`（30r/m = 每 2 秒）才回填 1 个令牌 |
| 后果 | ① **nginx 是先卡住的那层** —— 只看应用层阈值会误判成"应用层频控没生效"；<br>② 想走 nginx 打满**应用层**阈值需约 60 秒（先被网关拦、再按 0.5 次/秒慢慢喂）；<br>③ 打满会把网关桶掏空，**紧接着的下一轮验收**全部 429 —— 一条与产品无关的假红灯 |
| 本方案 | `smoke-test.mjs` §4c 的 429 断言**不走"连发打满"**：把库里 `security.ip_minute_limit` 临时降到 2，用 **3 个请求**逼出 `GuardService` 的 429（只走 3 次，远不到网关的 11 次突发上限），并在 `finally` 里**无条件**恢复 30 与清空 `ip` 桶 —— 总闸绝不能把自己变成故障源 |
| 附带收益 | 该做法顺带验到「阈值来自**库**、10s TTL 内生效、**不需要重启**」，与 DEV-31 互为佐证 |
| ⚠️ 两种 429 必须能区分 | nginx 的是 `{"code":"TOO_MANY_REQUESTS"}`；应用层的是 `{"errors":[{"code":"RATE_LIMITED",...}]}`。<br>不区分就会把"网关拦了"读成"频控生效了" —— 结论看着对、归因全错，排查时会在错误的层里找半天 |
| 可逆 | ✅ 纯文档/脚本修正，未改任何运行期配置 |

---

## DEV-35 验收断言必须**与库龄无关**（两条"随数据增长而漂移"的假红灯）
| 项 | 内容 |
|---|---|
| 现象 | Phase 3 收尾跑总闸时 `smoke-test.mjs` 62/64，两条红灯：<br>① `H5 占位页可访问（bind mount 生效）` — "返回内容不是 H5 占位页"<br>② `AT-03 门店隔离：门店用户 list 只返回本店工单` — "本店工单 T_A 不在列表里" |
| 真因①（过时断言） | Phase 3 起 `/h5/` 已由**真实 Vite 构建产物**取代占位页，返回的是 `<div id="app">` + 引用 `/h5/assets/index-<hash>.js`，**不含字面 'H5'**。断言仍按"占位页里写着 H5"判定 → 交付越完整越红 |
| 真因②（假设了空库） | 断言用 `list?pageSize=100`（默认排序取第 1 页）并要求新造的 `T_A` 出现在其中。但 S01 是验收主战场（一次 100 路并发压测就落 100 张），库内已有 **208** 张 —— `T_A` 的 `id` 最大，必然被挤出第 1 页。**Phase 2 时库是空的，所以当时 64/64 全绿** |
| 判定 | 两条**都不是产品回归**：同组的 `AT-03 get 他店 404 / 本店 200` 是绿的，恰好证明门店归属校验工作正常；`/h5/report` 实测 200 |
| 本方案 | ① 判据改为「SPA 挂载点 `<div id="app">` + 引用 `/h5/assets/*.js`，且**把该 JS 实取一次**要求 200 且非空」—— 保留对 DEV-29（`alias` 导致 301 丢端口）的覆盖，只验 index.html 200 抓不到那个坑；<br>② 拆成两条：**不筛时**第 1 页必须全属本店（证明没越界）+ **定向** `filter={"id":{"$in":[T_A,T_B]}}` 结果**只剩** `T_A`（证明没被过度裁剪）。后者顺带验到 scope 是 `$and` **叠加**而非覆盖 —— 请求里的 filter 挤不掉范围条件 |
| 教训 | 断言里凡是出现"第 1 页 / 前 N 条 / 总量"这类**依赖库内既有数据**的判据，都会随库龄漂移。<br>夹具断言应**把范围收窄到本次夹具**（按 id 或 `[SMOKE]` 前缀），而不是假设自己是库里唯一的数据 |
| 可逆 | ✅ 仅脚本断言，未动产品代码 |

---

## DEV-36 重复单识别补"事项文本"维度（PHASE-0 §9.4 的原规则，Phase 3 实现漏了）
| 项 | 内容 |
|---|---|
| 文档原文 | `PHASE-0.md` §9.4：重复单识别 = 同手机号 + 同门店 + 同类型 + **事项文本相似**，10 分钟内 → 拒绝并回原工单号 |
| Phase 3 实际实现 | 只比 手机号 + 门店 + `ticket_type` + 时间窗（`findDuplicateTicket` 一条 SQL + `LIMIT 1`），**完全没比较事项文本** |
| 缺陷后果 | **合法场景被错误拦截**，且拦得毫无道理：同一客户在同一家店 10 分钟内分别报修两件不同家电 ——「空调不制冷」与「冰箱漏水」`ticket_type` 都是 `repair`，第二件被判成第一件的重复单，客户拿不到单号。这不是"防刷生效"，是把正常业务挡死 |
| 本方案（Phase 3.1） | 判重改为**五维**：`customer_mobile` + `store_id` + `ticket_type` + **`normalizeContent(content)` 相等** + 时间窗，且 `status <> 'CANCELLED'`。<br>新增确定性 `normalizeContent()`：`NFKC` 归一化 → 删除 Unicode 标点/符号（`\p{P}\p{S}`）→ 删除全部空白 → 仅 ASCII `A–Z` 转小写。<br>实现分工：SQL 仍用前四个维度把候选压到极小（`LIMIT 50`），**应用层**再逐条比较归一化结果 —— 归一化依赖 `NFKC` + Unicode 字符类，PG 侧没有对等能力，而本阶段的明确约束是**不引入 PostgreSQL 扩展** |
| 刻意的取舍 | ① **不引入 AI / 向量 / 复杂 NLP**：判重结果直接拒绝客户请求，必须是可复现、可解释、可测的；相似度阈值调参会变成新的运维负担。<br>② 判错两个方向的代价**不对称** —— 漏判 = 客户看到两张单（可人工合并）；误判 = 客户拿不到单号、以为系统坏了。因此所有边界情形（归一化后为空、候选超限）一律**放行**：`if (!normalized) return null` |
| 验收 | `smoke-test.mjs` §4c 新增 **Phase 3.1-A~E 五组断言**（进总闸，不是临时脚本）：<br>A 同内容 → 409 + 原单号 + 不落新单 + **序号不推进**（实测 `13→14`，重复后仍 `14`）<br>B 同客户不同事项 → 各建一张独立单<br>C 仅空白/标点差异 → 仍判重复<br>D 同内容不同 `ticket_type` → 允许<br>E 原单 CANCELLED → 允许重新提交 |
| 附带发现 | 用户举例中的「冰箱漏水」（4 字）会被既有 `CONTENT_MIN = 5` 拦成 `422 INVALID_CONTENT` —— 那是**内容长度**门槛，与判重无关。断言改用满足长度的措辞，并把该约束写入 `docs/PHASE-3.md` 的「已知限制」 |
| 可逆 | ✅ 判重是**软约束**（非唯一索引），随时可回退为旧的"四维"口径；归一化是纯函数，无数据迁移 |

## DEV-37 当前版本按**单 NocoBase 应用实例**运行（横向扩容前必须重新验证两件事）
| 项 | 内容 |
|---|---|
| 事实 | ① `createPublicTicketHandler` 对同一 `request_id` 的互斥是**进程内**串行锁（`Map<scene:request_id>`，见 DEV-32）；<br>② `TicketService.create` 的 `ticket_no` 获取发生在**业务事务之前** |
| 当前约束 | Docker Compose 只有**一个** app 实例（`svc-app`），因此上述两点在当前形态下成立：同 `request_id` 的并发请求必然落在同一进程内被串行化，取号器也只有一份 |
| 边界声明 | **当前版本按单 NocoBase 应用实例运行。未经专门改造不得直接横向扩为多个 app replica。**<br>多实例部署前**必须重新验证**：<br>· **`request_id` 幂等竞态** —— 两个 replica 同时收到同 `request_id` 时进程内锁不再互斥，需改为数据库级锁 / 唯一索引抢占 / 分布式锁；<br>· **`ticket_no` 的无空洞性质** —— 取号在事务外，跨实例只能依赖 `daily_sequences` 的行级锁；若出现"取号成功但建单回滚"的空洞，需评估是否接受并把口径写进 SLA |
| 是否阻塞 | ❌ 不阻塞 Phase 3，也不是本阶段整改项。登记的目的是**防止后续有人"顺手"把 app 扩成 replicas** 而没重跑这两条验证 |
| 可逆 | ✅ 纯约束声明，无代码改动 |

---

## DEV-38 ServiceVisit 的语义定为「一次**执行责任**的派工尝试」（改派 = 终止旧 Visit + 新建 Visit）
| 项 | 内容 |
|---|---|
| 触发 | Phase 4 独立复核裁定（2026-09-21）。原 `docs/STATE-MACHINE.md` M4 写作"同一 Visit 换师傅/换手机号"，与 `serviceVisits.ts` 自己注释里的"改派会产生多个 Visit"**互相矛盾**，两种口径都能读出合理语义 |
| 裁定 | **只要执行责任人发生变化，就新建一条 Visit，绝不修改旧 Visit 的师傅身份。**<br>· 责任主体的判据是 **`technician_mobile` + `provider_name` + `service_mode`**，**姓名不在其中**；<br>· 改派 = 旧 Visit → `SUPERSEDED`（原样保留，含其 Token 哈希、预约时间、已上传照片）+ 新建 Visit（`visit_no+1`，新 Token）；<br>· 改约 = **不新建** Visit，只改 `expected_visit_at`（责任人没变），Token 可吊销后重新签发；<br>· 只纠正姓名错别字（手机号与服务方未变）→ 就地修改同一 Visit，但**必须**写 `metadata_corrected` 事件留痕；<br>· `reassign` **仅允许** `visit_status = ASSIGNED`。 |
| 为什么不让"历史不可覆盖"靠自觉 | 覆写同一行的师傅字段是**能做但不可逆**的操作；把改派建模成"新建行"后，"旧师傅是谁"变成**数据模型的必然结果**，而不是代码评审时的约定 |
| 新增字段 | `visit_status`（生命周期唯一事实来源）/ `assigned_at` / `reassigned_from_visit_id`（自引用，串出 Visit #1→#2→#3 链条）/ `superseded_at` / `superseded_reason` / `token_revoked_at` / `token_revoked_reason` |
| `store_confirm_status` 处置 | **降级为派生字段**，仅为兼容 Phase 2/3 已落库数据与既有断言而保留；两者不得各自推进，映射表 = `VISIT_STATUS_TO_CONFIRM_STATUS`（constants.ts）。纯文本纠错也复用 `metadata_corrected` 事件类型 |
| 连带修复 | `docs/STATE-MACHINE.md` M4/M5 改写为新口径；新增「Visit 生命周期」小节 |
| 可逆 | ⚠️ 部分是"加列 + 加枚举"，可通过迁移回滚列；但**已按新模型产生的数据**（多条 Visit）无法自动合并回旧模型 |

---

## DEV-39 `db.sync()` **会补列** —— 纠正此前记录的相反前提
| 项 | 内容 |
|---|---|
| 原记录（**错的**） | `services/ticket-service.ts` 的 `privacy` 字段注释写着："`sync()` 对已存在的表只做 `CREATE TABLE IF NOT EXISTS` 语义，**不会**补列。于是新列在老实例上根本不存在，写入即报 42703"。Phase 3 据此把 `privacy_agreed` 塞进 `extra_json` 而不是新加列 |
| 真机事实 | NocoBase 的 `Database` 构造函数里写死了默认同步选项：<br>`const opts = { sync: { alter: { drop: false }, force: false }, ...options };`<br>（`@nocobase/database/lib/database.js`，容器内取证）<br>即 `db.sync()` = **`alter: { drop: false }` 的增量同步：会补列，只是不删列**。<br>2026-09-21 实测确认：Phase 4-A 给 `serviceVisits` 新增 7 列 + 2 索引后，重启时它们**在迁移执行之前**就已由 sync 建好，迁移日志显示"新增列 0 个" |
| 后果与处置 | ① 后续**可以**用声明式加列（不必再走 `extra_json` 绕路）；② 但**数据回填 sync 做不了** —— 加 `NOT NULL DEFAULT` 列时，PG 会把**所有历史行**填成同一个值。对 `visit_status` 而言那个值（`ASSIGNED`）对"已提交/已确认"的历史 Visit 是**错的**，因此迁移的真实价值从"补列"转为"**纠正被默认值填错的阶段**"；③ `extra_json` 对 `privacy_agreed` 的用法**保留不动**（已上线、无迁移风险），但注释里的错误前提必须改正 —— 错误的前提比错误的结论更容易扩散 |
| 教训 | "文档里记着框架不会做某事"≠"框架真的不会做"。凡是要据此做**设计取舍**的框架行为，都必须**读源码或跑实验**取得证据，并写明取证位置 |

---

## DEV-40 离线桩的 `sequelize.query` 返回形状不忠实 → 造成**离线恒红、真机全绿**的假红灯
| 项 | 内容 |
|---|---|
| 现象 | Phase 4-A 的迁移里加了一句 `to_regclass` 预检（"表存在吗"）。真机全绿，但 `verify-plugin-load.mjs` **恒定失败**，报"表 service_visits 不存在" |
| 根因 | 桩的 `db.sequelize.query()` 返回的是**扁平数组** `presentTables.map((name) => ({ name }))`，而真实 sequelize 返回 `[rows, metadata]` 元组。于是调用点 `const [regRows] = await sequelize.query(...)` 在桩里拿到的是**一个表描述对象**而非行数组，预检恒判"表不存在" |
| 处置 | ① **删掉该预检**。它本来就是冗余的：离线校验已对**每个**迁移断言 `instance.on === 'afterLoad'`（"表建好之后才跑"这条前提已被守住），且真机上表若缺失，`ALTER TABLE` 会自己抛 `42P01 relation does not exist` —— 报错同样清晰，还不需要多一次查询、不依赖驱动返回形状；<br>② 迁移改为调用 `runInTransaction()`：宿主无 `sequelize.transaction` 时退化为直接执行 —— **沿用 `TicketService.withTransaction` 已有的同一约定**，不让两处对"桩环境怎么办"给出不同答案 |
| 为什么不改桩 | 试过把桩的 `query()` 改成返回元组，结果**连带 5 条断言变红**（health 的 `*Seeded`、表数量统计等长期依赖那个扁平形状）。改共享桩的返回契约属于"为了让一条新断言变绿而动摇 5 条老断言"，ROI 为负。**遗留问题已记录**：桩的 `query()` 与实际实现不同构，任何新的 `query()` 调用方都要提防同类假红灯 |
| 教训 | 与 DEV-34 同源：**会误报的检查比没有检查更糟**。这次是"桩误报"，比"断言误报"更隐蔽 —— 因为它伪装成产品缺陷。凡是新增的预检/探针，先问"它在桩环境里会得到什么"，而不是只看真机 |

---

## DEV-41 两个 Phase 4 验收探针（`tokenCheck` / `smsOutbox`）自带**生产环境自毁闸**
| 项 | 内容 |
|---|---|
| 背景 | Phase 4 的硬门槛是"**改派后旧 Token 必须立即失效**"，而这条必须在 **HTTP 层**被证明。但两个前提同时成立：① 师傅端页面是 **Phase 5** 的交付物，Phase 4 拿不到它；② 师傅 Token 的**明文只在短信里**（库里只有 `sha256`），没有取回通道就无从发起这次校验 |
| 备选方案与否决理由 | **A. 不验，等 Phase 5** → 等于让本阶段最硬的一条门槛只停留在单测里，而单测里调一下 service 无法证明"HTTP 入口走的是同一套校验"；<br>**B. 开一个匿名资源给验收脚本用** → 这会**永久**扩大对外暴露面（Phase 5 交付后它还在），用一个长期风险换一次验收；<br>**C. 已登录 + 总部特权的探针 action，且只在 mock 通道存在**（**采纳**） |
| 处置 | `POST /api/svc:tokenCheck` 与 `GET /api/svc:smsOutbox` 都走 `loggedIn` + `assertCapability(PRIVILEGED)`，并各自先过一道 `assertMockChannel()`：**`sms.provider` 一旦不是 `mock`，立即返回 404 `NOT_FOUND`**（不是 403）。<br>`tokenCheck` 调用的是与未来师傅端接口**完全相同**的 `TokenService.verify()`；`smsOutbox` 只回脱敏收件人，明文手机号仅存在于内存条目中 |
| 为什么是 404 而不是 403 | 403 的语义是"这个接口在这里，但你没权限"；404 的语义是"这里什么都没有"。真实通道下这两个探针**本来就不该存在**，所以 404 才是诚实的表达 —— 它不给攻击者任何"生产环境里有个调试入口"的信号 |
| 为什么能力校验必须**先于**自毁闸 | 顺序反了，一个只读账号（甚至未登录，若 ACL 配错）就能先探出"这个接口到底存不存在"。离线断言已把这一点钉死：`viewer` 拿到的是 **403**，而不是 404/200（见 `verify-plugin-load.mjs` 【4d】） |
| 证据 | 离线 `verify-plugin-load` 【4d】2 条：非 mock → 两个探针均 `404 NOT_FOUND`（且带反向对照：mock 通道下**不得**是 404，防断言空转）；`viewer` → `403 FORBIDDEN`。真机 `smoke-test` §4d 全程经由这两个探针取证 |
| 遗留 | Phase 5 交付 `/api/technician/visits/:token` 后，本探针**仍保留** —— 它验证的是"Token **没通过**"这一侧，而那正是匿名接口不该对外暴露的细节 |

---

## DEV-42 `service_mode=remote` 在 Phase 4 一律拒绝（`REMOTE_MODE_DEFERRED`）
| 项 | 内容 |
|---|---|
| 现象 | DEV-PLAN 的 Phase 4 把 `remote`（远程处理）列为可选服务方式之一，Phase 4-A 也已把 `is_remote` 落进表结构。但 `dispatch` 若接受 `remote`，会与 **M11（远程处理）** 的既定语义打架 |
| 冲突点 | M11 的设计是"远程处理**不产生上门 Visit**"（`access_token_hash` 为空、`is_remote=true`、无 `expected_visit_at` 语义）。而 Phase 4 的 `dispatch` 路径是**无条件新建 Visit + 签发 Token + 发作业链接**。若放行，同一条工单会出现"一条 `remote` 的 Visit 却带着作业链接"，而 Phase 6 的 M11 又会再建一条 —— **两条互相矛盾的 Visit** |
| 处置 | `assertDispatchInput()` 遇到 `service_mode=remote` 直接抛 `ValidationError('REMOTE_MODE_DEFERRED')` → **422**，并在 message 里指明"远程处理在 Phase 6（M11）交付"。`dispatch` / `reassign` / `reschedule` 三个入口共用同一处校验 |
| 为什么不是"先放行、以后再说" | 表结构已经支持 `remote` 了，所以放行**不会报任何错** —— 它会安静地产生错误数据，而这些数据在 M11 上线后需要**逐条人工清理**。宁可现在返回一个明确的 422 |
| 证据 | 真机冒烟 §4d：`dispatch(service_mode=remote)` → 422 `REMOTE_MODE_DEFERRED`（探针实测）；`DISPATCHABLE_SERVICE_MODES` 常量不含 `remote`，可被静态断言 |

---

## DEV-43 `cancel` / `transfer` 必须**同时作废**进行中的派工并通知原师傅
| 项 | 内容 |
|---|---|
| 现象 | Phase 4 之前，`cancel`（工单取消）与 `transfer`（转店）只改工单状态。Phase 4 起工单上会挂着一条**已签发 Token 的 Visit** —— 若不同步作废，会出现"工单已取消，师傅的作业链接**仍然可用**，他还能提交回执" |
| 严重性 | 这不是通知问题，是**数据完整性问题**：一条已取消工单将被写入一条合法的服务回执，随后进入门店审核与客户评价链路。而 GUI 上一切正常 |
| 处置 | 抽出 `voidActiveVisit()` 供 `cancel` / `transfer` 共用（各写一遍迟早有一处漏掉"通知原师傅"）：条件 UPDATE 把 `visit_status` 置为 `CANCELLED` / `SUPERSEDED`，同时置 `token_revoked_*`，并在同一事务内入队一条 `technician_assignment_cancelled` 短信 |
| "已提交回执"这一竞态 | 条件 UPDATE 只匹配 `visit_status='ASSIGNED'`。若未命中（师傅恰好刚提交回执），**不阻断主流程**（取消/转店已是既定事实），但记 `warn`：此时"链接失效"已不重要 —— Visit 已进入审核流程 |
| 未知原因码一律抛错 | `voidActiveVisit` 的 `switch` 有 `default: throw`。这条链路上"静默作废"比"操作失败"危险得多 |
| 证据 | 源码 `services/ticket-service.ts` 的 `voidActiveVisit`；`sms_logs.scene = technician_assignment_cancelled` 与 `visit_id` 指向被作废的那条 Visit |

---

## DEV-44 短信的**事务性发件箱**：`SmsLog.send_status` 新增第四态 `pending`
| 项 | 内容 |
|---|---|
| 问题 | 派工要发短信，而发短信要调**外部 HTTP**（阿里云）—— 绝不能放进数据库事务：外部调用可能耗时数秒，会把工单行的锁与连接一直占着；更关键的是**外部失败不应该回滚派工**（师傅已经派出去了，这是既成事实）。<br>但"事务内落库 → 提交 → 再调供应商"这个顺序留了一个缺口：**提交完成到调用供应商之间进程被杀**，短信永远不发、而且库里连一条记录都没有（事后无从发现，更无从补发） |
| 处置 | 标准**事务性发件箱**：① 事务内写一条 `pending` 的 `SmsLog`（含 scene / 模板 / 脱敏收件人 / `biz_id`）；② 提交后再发，把状态改成 `accepted` / `rejected` / `error`；③ Phase 8 的 `smsRetry` 定时任务额外扫描"停留 `pending` 超过阈值"的行补发 |
| 为什么现在就加这个枚举值 | 让 Phase 8 接任务时**不需要再改一次表结构**（改枚举值要走迁移 + 断言同步，成本远高于现在写进去） |
| ⚠️ `accepted` ≠ `delivered` | `accepted` 只表示"供应商已受理"。送达是 `delivery_status`（`pending` → `delivered`/`failed`），**只能由供应商回执更新**。把 `accepted` 写成 `delivered` 会让"客户没收到短信"这类投诉**永远查不出来**（报表上全是送达）。<br>类型上做了钉死：`SmsSendResult.deliveryStatus` 的类型就是字面量 `'pending'` —— 供应商返回的任何东西都无法把它变成别的值 |
| `sms.enabled` 闸 | 供应商账号/签名/模板的审批是**站外**流程，代码上线时往往还没批下来。此时若照发，会得到一批语焉不详的失败，且每次派工都试一次。显式关掉后，`SmsLog` 一律记 `rejected` + `error_code=SMS_DISABLED`：**业务照常推进**（派工是既成事实），**通知缺失被如实记录并可一眼查出**。默认 `false` 是刻意的安全默认值 |
| 证据 | 真机冒烟 §4d：`sms.enabled=false` 时派工仍 200、Visit 已建、两条 `SmsLog` 为 `rejected` + `SMS_DISABLED`；`sms.enabled=true` 时全部 `accepted` 且 `delivery_status` **恒为 `pending`**（0 条 `delivered`） |

---

## DEV-45 "改派后旧 Token 失效"的**表达形态**是 `200 + {valid:false}`，不是 401（✅ **已接受偏差 / ACCEPTED**，2026-09-21）
| 项 | 内容 |
|---|---|
| 与验收条款的差异 | DEV-PLAN Phase 4 步骤 J 原写本阶段断言"含**改派后旧 Token 401**"。实际交付的是：探针 `svc:tokenCheck` 返回 **HTTP 200** + `{ valid: false, code: 'TOKEN_INVALID' }` |
| 为什么不是 401 | `tokenCheck` 是**总部排障设施**，它回答的是"这个 Token 有效吗"这个**问题**，而不是"我要用这个 Token 通过认证"。若让它返回 401，调用者（总部运维）将无法区分"被问的 Token 无效"与"**我自己的登录态过期了**" —— 两者都长成 401，而处置方式完全不同。<br>真正的 401 语义属于 **Phase 5** 的匿名接口 `GET /api/technician/visits/:token`：那里"Token 无效"就是"你未被认证"，401 是正确的 |
| 已实现的语义等价性 | ① 被问的 Token 由 `TokenService.verify()` 判定，**与未来师傅端接口是同一个函数**；② 失败一律 `TOKEN_INVALID`，**内部 reason（过期/已用/被改派/Visit 非活跃）不外露**（区分原因 = 给攻击者一个可枚举的探测接口），reason 只进应用日志；③ 即便把响应体逐字搜索，也找不到 `reassigned` 等字样 —— 冒烟里有专门一条断言钉这一点 |
| **裁定结果** | ✅ **2026-09-21 复核方明确接受当前实现，不要求把 `tokenCheck` 改成 401，无需任何代码改动。** 复核方同时把 `401` 归还到它真正应该出现的位置：<br>· **Phase 4 `POST /api/svc:tokenCheck`** = 总部**诊断查询** → 旧 Token → `200 + {valid:false, code:'TOKEN_INVALID'}`<br>· **Phase 5 `GET /api/technician/visits/:token`** = **真正的师傅匿名业务接口**（Token 本身就是访问该资源的认证凭证）→ Token 不存在 / 已过期 / 已使用 / 被改派撤销 **一律 `401 TOKEN_INVALID`**<br>Phase 5 的六行硬验收矩阵已写入 `docs/DEV-PLAN.md` §Phase 5 |
| **条款措辞已同步修改** | DEV-PLAN Phase 4 的总纲与 §J 已由"改派后旧 Token 立即 **401**"改写为**语义要求**：<br>*"改派后旧 Token 必须立即失效。Phase 4 内部 `tokenCheck` 诊断探针以 `200 + valid:false + TOKEN_INVALID` 证明失效；Phase 5 正式师傅匿名接口使用失效 Token 必须返回 `401 TOKEN_INVALID`。"*<br>**原因**：把探针状态码写死进条款，迟早会出现"实现其实正确、规格文字制造假红灯" |
| 通用规则（值得推广） | **诊断接口的返回值不应借用认证失败的状态码**：前者回答"这个凭证有效吗"（查询本身成功 → 2xx + 结论在 body 里），后者表达"你未被认证"（→ 401）。两者混用会让调用方**无法区分是谁的凭证有问题** |
| 证据 | 真机冒烟 §4d 第 8 条（同一 Token 由 `valid:true` 变 `valid:false`）+ 第 11 条（四种失败形态统一 `TOKEN_INVALID`）；探针三重约束（总部特权 / 仅 mock 通道 / 原因不外露）见 DEV-41 |

---

## DEV-46 启动期**参数种子自愈**：新参数如何到达已安装的旧实例
| 项 | 内容 |
|---|---|
| 现象 | Phase 4 给 `DEFAULT_SETTINGS` 加了 `sms.enabled`。而 `seedSettings()` 只在 `install()` / `afterEnable()` 里跑 —— 对一个**早已安装**的实例，这两条路径都不会再走。结果：① 库里永远没有这一行；② health 的 `settingsSeeded` 恒为 `false`（那个标志只在播种函数成功时才置位）；③ 真机冒烟因此亮起一条与业务无关的红灯 |
| 这不是"忘了写迁移" | 它是**机制缺口**：只要"新增一个参数"这件事不能自动到达旧实例，**每一个 Phase 都会重演一次** |
| 为什么用自愈而不是再写一个迁移 | ① 与 `repairRoleResources()` 完全同构的理由 —— 迁移被 umzug 按文件名一次性记录，**跑过就不会再跑**，而"新参数不存在于旧实例"在迁移之后照样会发生；② **时序**：`app.load()` 触发 afterLoad 钩子，`pm.upgrade()` 才跑迁移，所以 afterLoad 自愈比同内容的迁移**更早生效**，迁移会退化成纯冗余。与其多一份维护点，不如只留这一处 |
| 为什么"每次启动写一遍"是安全的 | `seedSettings()` 的语义是**按 key 只增不改** —— 已存在的键一律跳过，运营在后台调过的值不会被部署冲掉。稳态下只做 17 次 `findOne`、新增 0 行，且**不产生任何日志**（只在真补了东西时打一行 `warn`） |
| 顺带修正了 `settingsSeeded` 的语义 | 它现在表示"**参数种子已就绪**（含自愈）"，而不是"本次进程恰好走过 install/afterEnable"。前者是**能被断言的数据事实**，后者取决于进程历史 —— 用后者做验收断言，正是上面那条假红灯的根因 |
| 证据 | 真机：`sms.enabled=false` 由其补写进库（此前 16 行 → 17 行）；冒烟 `service_settings` 的行集合断言从"数量等于 16"升级为"**与 `DEFAULT_SETTINGS` 逐键相等**" |

---

## DEV-47 Phase 4-B 收口时发现的**三处"注释正确、代码不对"**
| 项 | 内容 |
|---|---|
| 共性 | 三处都是"先写注释（想清楚要什么），代码凑合（当时拿不到所需的输入）"，于是**代码与注释相反**。它们的共同特征是：**不会报错、不会崩、测试全绿**，只会在三个月后被人问"这条数据到底什么意思"时暴露 |
| ① 取消短信挂在**新** Visit 上 | `enqueueDispatchPair()` 的注释写着"挂在**旧** Visit 上：这条通知说的就是'那条派工没了'"，代码却传了 `visitId: null`（`biz_id` 里落成 `x`）。根因是参数对象 `cancelledTechnician` 当时只带了手机号与预约时间、**拿不到旧 Visit 的 id**。<br>后果：`biz_id` 仍有随机后缀不撞唯一键，但排障时"这条取消短信对应哪次派工"就答不出来 —— 而这正是要留日志的原因。<br>处置：`cancelledTechnician` 增加 `visitId`，由 `reassign` 传入 `previousVisit.id` |
| ② 改派 / 改约给客户发的是"已受理" | `SMS_SCENE.DISPATCH_UPDATE`（"您的报修（X）上门时间已更新为…"）**定义齐全**（收件人映射、模板 CODE 环境变量后缀、预览文案都有），却**没有任何调用方**。改派与改约都复用了 `dispatch_customer`（"已由某店受理，师傅X将于…"）。<br>这不是文案问题：真实通道下**模板 CODE 用错** —— 变量个数对得上，所以不报任何错，只是客户收到一句"已受理"而**真正变化的信息（新时间/新师傅）反而没被强调**。<br>处置：`enqueueDispatchPair()` 增加 `customerScene` 参数，`dispatch` 用 `DISPATCH_CUSTOMER`、`reassign`/`reschedule` 用 `DISPATCH_UPDATE`。师傅侧**不区分**（无论首次还是改派他需要的都是"作业链接 + 预约时间"，供应商只需审一套模板） |
| ③ 常量注释里的 scene 名与取值不符 | `SMS_SCENE` 的注释把新师傅那条写成 `technician_assignment`，而实际取值是 `technician_task`（模板环境变量后缀 `ALIYUN_SMS_TPL_TECHNICIAN_TASK` 也依赖它）。照注释去配模板会配出一个**永远匹配不到的名字** |
| 教训 | 本项目已有"**规格与代码不一致时以代码为准并改注释**"的口径，但这次三处的方向相反 —— **注释是对的，代码是错的**。区分办法只有一个：注释里出现"刻意/故意"这类措辞时，必须回头确认代码真的那么做了；写注释时如果发现自己拿不到某个输入，**当时就该补上参数**，而不是在注释里描述一个没实现的行为 |

---

## DEV-48 插件从未产出**客户端产物**，导致整个后台打不开（Phase 4-H 开工首日发现）
| 项 | 内容 |
|---|---|
| 现象 | 浏览器打开 `/admin` 得到 `App error / Script error for "@local/service-ticket"`，**连登录页都渲染不出来**。全文只有这一个报错，看不出与"插件"有什么关系 |
| 根因 | NocoBase 后台 SPA 启动时调 `GET /api/pm:listEnabled`，拿到**每个已启用插件**的客户端入口 URL，再逐个动态加载：<br>`/static/plugins/@local/service-ticket/dist/client/index.js`<br>而 `@nocobase/server/lib/plugin-manager/options/resource.js` 的 `PackageUrls.fetch()` **不做存在性过滤** —— 它只在文件存在时给 URL 追加 `?hash=`，URL 无论如何都会返回。本插件自 Phase 0 起就只构建 `dist/server/index.js`，从未有过客户端产物 → 404 → requirejs 抛错 → 整个 SPA 挂掉 |
| 影响面 | **Phase 0～4 的所有后台交付物实际上一直是不可用的**（Phase 2 起就写在 DEV-PLAN 里的"后台业务页面"根本无处安放）。而三套校验脚本全绿 —— 因为它们只请求 `/api/*`，**从未请求过任何前端静态资源** |
| 为什么难发现 | ① 服务端一切正常（插件加载、表、接口、权限全对）；② 构建脚本"成功"，因为它按设计只编服务端；③ 缺文件不产生任何服务端日志 —— 404 只出现在浏览器控制台里 |
| 处置 | ① `scripts/build-plugin.mjs` 新增 `buildClient()`，产出符合 NocoBase 约定的 **AMD/UMD** 客户端 bundle（esbuild 只有 iife/cjs/esm，UMD 外壳需自己包）；<br>② 外部依赖清单**从产物 metafile 现读**，不手抄，避免两处漂移；<br>③ `define([...])` 显式声明依赖 + 局部 `__require` 白名单，遇到未声明依赖抛**带模块名**的错误（把"取不到"变成可定位的响亮失败）；<br>④ 预检：客户端入口源文件缺失直接拦住构建；<br>⑤ 产物自检：断言 `define.amd` / 白名单报错分支 / `__esModule` / `ServiceTicketClient` 类名 / `@nocobase/client` 为外部依赖 / **未把 React 内联**（内联 React 会让 hooks 报 "Invalid hook call"，症状是"页面能开、一交互就崩"） |
| 断言 | `smoke-test.mjs` **§4e**：客户端产物 HTTP 200 + 三个 UMD 特征；`pm:listEnabled` 中该插件的 `url` 必须带 `?hash=`（服务端只在**文件确实存在**时才追加它）|

---

## DEV-49 nginx 转发 Host 用 `$host` 丢掉端口 → 后台登录 403 `Invalid sign-in origin`
| 项 | 内容 |
|---|---|
| 现象 | 后台能打开、能填账号密码，点"Sign in"**没有任何反应**；Network 里 `POST /api/auth:signIn` 返回 **403 `{"errors":[{"message":"Invalid sign-in origin"}]}`** |
| 根因 | ① 浏览器发 POST 时**必定**带 `Origin: http://localhost:8080`；<br>② `@nocobase/auth` 的 `assertTrustedSignInOrigin()` 调 `isTrustedOrigin()`，同源判定用 `getRequestOrigin(ctx)` = `${x-forwarded-proto \|\| protocol}://${x-forwarded-host \|\| host}`；<br>③ 我们的 `service.conf` 写的是 `proxy_set_header Host $host;` —— **`$host` 不含端口**（nginx：主机名或 server_name，端口被剥掉），于是应用算出 `http://localhost`；<br>④ `http://localhost` ≠ `http://localhost:8080` → 非同源，`CORS_ORIGIN_WHITELIST` 又未配置 → 403 |
| 为什么"接口测试全绿" | `smokeSignIn()` 用 `fetch()` **不带 Origin 头** → 走 referer 分支、referer 也为空 → **直接放行**。也就是说：**同一件事，curl 永远成功、浏览器永远失败**，而验收只覆盖了 curl 那一侧 |
| 处置 | ① 新增 `nginx/conf.d/proxy-headers.inc`，把 11 处重复的转发头收敛为单一来源（重复书写不是"啰嗦"而是"会漂移"）；<br>② `Host` 与 `X-Forwarded-Host` 一律用 **`$http_host`**（保留端口）；<br>③ 刻意**不设置** `X-Forwarded-Port`：nginx 容器监听 80，而对外映射端口由 docker 决定，`$server_port` 只会给出**错误的 80** —— 给一个错误的头比不给更糟；<br>④ `verify-config.mjs` 新增闸门：任何 `proxy_set_header Host` 不得使用 `$http_host` 以外的值（否则变红），并校验 include 目标存在；<br>⑤ `smoke-test.mjs` §4e 新增两条：**带正确 Origin 登录必须 200**、**带未知 Origin 必须 403**（反向对照，防"把校验整体关掉"来"修好"这个 bug） |
| 与 Phase 10 的关系 | 换到真实域名 / 443 后 `$http_host` 依然正确，无需再改 —— 这正是不能写死 `PUBLIC_BASE_URL` 的原因 |

---

## DEV-50 就绪闸门只看 HTTP 200、不等 health 收敛 → **每次重启后跑总闸都必然误报**
| 项 | 内容 |
|---|---|
| 现象 | 按 README 的规范命令跑总闸，得到 `❌ 通过 97 项，失败 1 项：postgres 与 app 均为 healthy — 未达 healthy：svc-app=starting`。诡异之处：**它前面 96 项全绿、后面 34 项也全绿**，且其中包含一条"用正确 Origin 真实登录成功"——应用显然在正常工作 |
| 根因 | 应用 healthcheck 配置为 `interval: 30s / start_period: 240s`。重启后应用**约 13s 就能对外服务**（`/api/svc/health` 返回 200），但 Docker 要等到**下一个探测周期**（最长 30s 后）才会把 `Health.Status` 从 `starting` 翻成 `healthy`。<br>而就绪闸门的循环体是 `if (r.status === 200) { ready = true; break; }` —— **一拿到 HTTP 200 就跳出**，从不等 health 收敛。于是"HTTP 已就绪"与"Docker 认为它就绪"之间那个最长 30s 的窗口，被这条紧跟其后的断言精准踩中 |
| 为什么"加大 `--wait` 也没用" | `--wait 240` 只放大**超时上限**，不改变**跳出条件**——循环在 ~13s 就 break 了。所以这不是"参数没给够"，是判据本身选错了 |
| 为什么必须修脚本而不是改部署 | ① `starting` 确实该算"未就绪"，**放宽断言等于把这条门槛作废**；<br>② 缩短 healthcheck `interval` 是"为测试方便改生产配置"，且 30s 的探测间隔本身合理；<br>③ 真实验收要回答的问题是"**这次部署最终会不会收敛到 healthy**"，那就必须给它收敛的时间 |
| 这属于哪一类 | 与 DEV-31 / DEV-34 同类：**假红灯比没红灯更糟**（工程铁律 2）。这条尤其危险 —— 它常亮、位置靠前、措辞像"部署有毛病"，会把真正的部署红灯淹掉 |
| 处置 | 就绪闸门改为**两个条件都满足才判就绪**：`HTTP 200` **AND** `svc-postgres`/`svc-app` 的 `Health.Status === 'healthy'`；<br>轮询间隔 5s → 3s（收敛检测更及时）；<br>超时按**原因**分流两种 warning：`HTTP 未就绪`（该怀疑应用没起来）与 `HTTP 已就绪但 health 未收敛`（该加大 `--wait`）—— 把"环境未就绪"与"真红灯"继续分开（工程铁律 4）；<br>断言失败信息补一句 `starting = healthcheck 周期还没走到；用 --wait 等收敛后复跑` |
| 证据 | 修复前：97/1，唯一红灯为 `svc-app=starting`；修复后复跑 98/98 全绿（同一台机器、同一次 `docker compose restart app` 之后） |

---

## DEV-51 NocoBase 会**主动删除**时间戳字段的注册表项 → 后台列表排不出"报修时间"
| 项 | 内容 |
|---|---|
| 现象 | 后台建工单列表时，字段选择器里**找不到 `createdAt`**；flow-engine 校验器把它判为 unknown field。而 DB 里 `created_at` 列明明存在（`psql \d service_tickets` 可见），接口返回的行里也有 `createdAt` |
| 根因 | `@nocobase/database/lib/collection.js:478` 在 `timestamps !== false` 时执行 `this.fields.delete(name)` —— **把 `createdAt` / `updatedAt` 从 collection 的字段注册表里删掉**，只在 Sequelize 的 `rawAttributes` 上保留真实的 `created_at` / `updated_at` 列。<br>而 `CollectionRepository.db2cm()` 遍历的是 `collection.fields`（注册表），不是 `rawAttributes` → 这两个字段**永远不会**写进元数据仓库 → 后台"选择数据表"后的字段列表里没有它们 |
| 为什么"三套校验全绿" | ① `verify-plugin-load` 走的是 `rawAttributes`（DEV 里已明确要求用它做属性目录），两个字段都在；<br>② `smoke-test` 用 psql 直接查 `created_at`，列存在；<br>③ 只有**后台界面**依赖元数据仓库 —— 而没有一条断言看它 |
| 这属于哪一类 | 与 DEV-46 / DEV-48 同族：**接口全绿、界面全瞎**。这一类在本项目已经出现四次，共同点是"唯一的用户界面不在任何断言的观察范围里" |
| 处置 | `plugin.ts` 新增 **`ensureAutoTimestampFields(phase)`**：按 `(collectionName, name)` **只增不改**补写 createdAt/updatedAt 的元数据行（`options.field` 指向真实列名 `created_at`/`updated_at`），随 `afterLoad` 自愈；稳态下补 0 行。<br>新增 `inspectUiTimestampFields()` 做"实时查库判定"，health 暴露 `uiTimestampFieldsExpected/Registered/missingUiTimestampFields/uiTimestampFieldsSyncedThisRun` 四个可断言字段 |
| 为什么必须自愈而不能只改声明 | 与 DEV-46 完全同构：`db2cm()` 是**集合级存在即返回**，对早已安装的实例，改代码不会让元数据跟着变 |
| 证据 | 修复后 `uiTimestampFieldsRegistered=22/22`（11 张表 × 2），后台字段探针的 `availableFields` 里出现 `createdAt`/`updatedAt` |

---

## DEV-52 字段助手只写了 `uiSchema.title`、没写 `interface` → 这些列**不可筛选**
| 项 | 内容 |
|---|---|
| 现象 | 用 `applyBlueprint` 建工单列表时反复 400：`defaultFilter-field-ineligible` —— 把 `ticket_no` / `customer_mobile` 判为"不能用于 defaultFilter"。后台筛选区块里也选不到这些列 |
| 根因 | `interface` 不是装饰性字段：后台用它决定**渲染组件**与**能不能被筛选/搜索**。本插件早期的字段助手只有 `enumStr` 写了 `interface`，其余 8 个（`str`/`text`/`int`/`bool`/`money`/`ts`/`json`/`belongsTo`）只写了 `uiSchema.title` → 元数据里 `interface` 为 `null` |
| 处置 | ① `collections/_helpers.ts` 给全部 8 个助手补 `interface`（`input`/`textarea`/`integer`/`checkbox`/`number`/`datetime`/`json`/`m2o`）并补齐 `uiSchema.type` 与 `x-component`；<br>② `plugin.ts` 新增 **`ensureFieldInterfaces(phase)`**：以代码声明为唯一事实来源，**只补空值、绝不覆盖**（运营在后台手工调过的 interface 不被冲掉）；<br>③ health 暴露 `uiFieldInterfacesExpected/Registered/missingUiFieldInterfaces/uiFieldInterfacesRepaired`；<br>④ `smoke-test` 新增断言 `registered === expected` |
| 与 DEV-51 的关系 | 同一个机制缺口（db2cm 只增不改）的**第二个**表现。所以两个自愈函数共用一条纪律：按 (表, 字段) 只增不改，且三个计数器一律用 `+=` 而不是 `=`（`afterLoad` 在一个进程内可能执行多次，覆盖式赋值会把"这次启动真的修了什么"抹成 0） |
| 证据 | 修复后 `uiFieldInterfacesRegistered=124/124`；库内抽样确认 `ticket_no=input`、`content=textarea`、`store=m2o` 等落库正确 |

---

## DEV-53 `applyBlueprint` 建后台页面时踩到的**三个平台级坑**（Phase 4-H 主要时间成本）
| 项 | 内容 |
|---|---|
| 背景 | Phase 4-H 要在后台建"我的门店工单 / 全量工单 / 事件时间线 / 派工记录"四张页面。页面数据在 `desktopRoutes` / `flowModels` / `rolesDesktopRoutes` 三张表里，唯一可编程的写入通道是 `flowSurfaces:applyBlueprint`。该动作带一套相当严格的 authoring 校验器，本次在其中耗掉了大部分时间 |

### 坑 1 —— 弹窗内容被编译成**一个不含 defaults 的 compose 步骤**，导致带弹窗的页面必然 400
| 项 | 内容 |
|---|---|
| 现象 | 只要给工单表格的 `recordActions` 挂一个 `view` 弹窗（哪怕是空的），`applyBlueprint` 就报 `missing-default-field-groups`，指向 `$.defaults.collections.serviceTickets.fieldGroups` —— 但该 defaults **明明给了，而且覆盖了全部字段** |
| 取证方式 | 把容器内 `plugin-flow-engine` 的 `authoring-validation.js` / `default-action-popup.js` 拷出→插桩→拷回→重启，再跑一次 apply。日志（同一份文档）：<br>`[compose] keys=[mode,blocks,layout,defaults,target] hasDefaults=true` ← tab 步骤<br>`[compose] keys=[target,mode,blocks,layout,defaults] hasDefaults=false` ← **弹窗步骤**<br>`[resolveDefaults] rawDs="main" normDs="main" coll=serviceTickets found=false defaultsKeys=null`<br>`[pushMissing] actionTypes=["edit"] triggerPaths=["$.blocks[0].recordActions.edit"]`<br>取证完成后用 `docker compose up -d --force-recreate app` 从镜像恢复了原始 dist（`node_modules` 不在任何 volume 里） |
| 根因 | ① `applyBlueprint` 先把文档编译成若干 `compose` 步骤再落库，**弹窗内容单独成为一个 compose 步骤，且该步骤 payload 的 `defaults` 是 `undefined`**；<br>② 弹窗里的数据区块（`details`/`table`/`list`）自带默认的 `edit` 记录动作（`details` 的默认动作里就有 `edit` + popup）；<br>③ 于是这条需求在"读不到 defaults"的那一步被判定为无 fieldGroups 可覆盖 → 400。校验器的报错路径只是**解析失败时的兜底文案**，因而指向一个看起来"明明给了"的路径 —— 这是本次最误导人的一点 |
| 为什么没有合法绕法 | 豁免该需求的唯一办法是给该区块声明一个**带内联 popup 的 `edit` 动作**（`doesDefaultActionPopupGenerate()` 为假才跳过）。而校验器要求自定义 `edit` 弹窗里**恰好包含一个 `editForm`**（`custom-edit-popup-edit-form-count`）。那等于给工单表开一张可直接改字段的表单 —— **绕过 TicketService 状态机，属本项目设计禁止项**。<br>另外两条也实测无效：`tryTemplate:false`（非成因）、把内层区块换成小集合（外层表格自身的 `edit` 仍会触发） |
| 判定阈值与影响面 | 同一套校验里 `LARGE_GENERATED_POPUP_FIELD_GROUPS_THRESHOLD = 10`：**集合业务字段 > 10 时才有这个问题**。实测 `stores`（6 个业务字段）建只读表格页 `HTTP 200` 通过 —— 说明管道本身没问题，问题只在"大集合 + 弹窗"的组合 |
| 处置（**降级交付，明确记录**） | ① 四张页面**一律不挂 blueprint 弹窗**；<br>② `defaults.collections.<coll>.fieldGroups` 必须覆盖**全部**字段（含 token 哈希等敏感列），敏感列集中放进「内部字段（不在界面展示）」组；清单抽成单一事实来源 **`scripts/expected-sensitive-columns.mjs`**（播种脚本与总闸共用），并由 `smoke-test` §4e 第 5 组断言"导出蓝图后没有任何区块引用这些列"——**因这条断言的存在，处置②才不是一句口头纪律**；<br>③ 工单详情改为「列表放足关键列」+「H6 自定义动作里的只读抽屉（客户端渲染，不经过 blueprint）」两条路补齐（见 `docs/PHASE-4.md` §13.2/§13.4）；<br>④ 登记为平台缺陷，附可复现命令，便于后续版本升级时回归 |

### 坑 2 —— table 区块的默认动作会被**自动合并**进来（且无法从文档里移除）
| 项 | 内容 |
|---|---|
| 现象 | `exportBlueprint` 回读落库后的页面，发现我**只声明了** `actions:['filter','refresh']`、`recordActions:[]`，实际却是：<br>`actions: ["filter","refresh","bulkDelete","addNew"]`、`recordActions: ["view","edit","delete"]`，其中 `addNew`/`view`/`edit` 还各自带着 popup |
| 根因 | `default-block-actions.js` 的 `mergeDefaultActionList()` 对每个默认描述符**无条件**产出（`[...descriptors.map(...), ...extras]`），没有"排除"机制 |
| 影响 | 工单列表上会出现「新建」「批量删除」「查看」「编辑」「删除」——**前四个（新建/批量删除/编辑/删除）在语义上都绕过状态机** |
| 为什么可以接受（但必须写清楚） | 本项目的 ACL 只给原生接口授予 `list`/`get`，写动作恒 403（`smoke-test` 有断言守着）。所以这些按钮**点不出后果**，属于"界面噪音"而不是"权限漏洞" |
| 留给 I 走查的观察项 | 这正是走查表要问的"**有没有误点 / 找不到按钮**"：如果走查人员点了「编辑」而界面毫无反馈，需要判断是"没反应"还是"没权限"。Phase 4-H 的交付说明里必须写清这一点，不能指望走查人员自己猜 |

### 坑 3 —— `desktopRoutes` 里**单 Tab 页面的 Tab 与页面同名**，按标题定位会取错层级
| 项 | 内容 |
|---|---|
| 现象 | 播种脚本第二次运行（幂等性验证）时，4 个页面里 2 个报 `replace target page must contain at least one tab` —— 而文档里明明有 `tabs` |
| 根因 | 单 Tab 页面的路由是两条：`type=flowPage title="全量工单"` 与 `type=tabs title="全量工单"`。用 `new Map(routes.map(r => [r.title, r]))` 建索引，**同名的 tabs 路由会覆盖 flowPage**，于是 `target.pageSchemaUid` 指向了一个 Tab。报错信息说的是"target page 必须含至少一个 tab"，而真正坏的是"target 指错了层级"——**报错与实际原因错位** |
| 处置 | 定位时**必须过滤 `type === 'flowPage'`**；脚本里写死了这条注释，并输出"现有路由 N 条，其中页面 M 个"以便复现时一眼看出 M 是否合理 |
| 附带结论 | 幂等性必须**真的跑第二遍**才算验证过 —— 第一遍永远是 create 路径，replace 路径的坑只在第二遍暴露 |

---

## DEV-54 `flowSurfaces:exportBlueprint` 对**含关联列的页面**直接 400 → 不能拿它当回读通道
| 项 | 内容 |
|---|---|
| 背景 | 把"页面区块到底引用了哪些列"做成 smoke 断言时，第一反应是用官方回读通道 `flowSurfaces:exportBlueprint`（它导出的是**编译器改写后**的页面内容，看起来最权威） |
| 现象 | 四张页面里**三张**导出失败：<br>`HTTP 400 … cannot export field 'TableColumnModel' at $.tabs[0].blocks[0].fields[1]: unsupported-node`<br>失败的正是含 **belongsTo 关联列**的页面：全量工单（`store`）、工单事件时间线（`ticket`）、派工记录（`ticket`）。只有"我的门店工单"（纯标量列）能导出 |
| 为什么危险 | 如果断言写成"导出失败就跳过"，那么**唯一能导出的那张页**（我的门店工单，恰好没有敏感列）会被检查，而**最需要检查的三张**（派工记录含 token 相关列）会被跳过 —— 一条看起来绿的断言，实际什么都没守住 |
| 改用 | `/api/flowModels:list?paginate=false` 取回整棵模型树（约 1.4k 节点 / 0.5MB），在内存里按 `parentId` 建树后遍历。它是**后台渲染时真正读的东西**，比导出通道更接近事实：<br>· 表格列：`use='TableColumnModel'` 的 `stepParams.fieldSettings.init.fieldPath`<br>· 排序：`use='TableBlockModel'` 的 `stepParams.tableSettings.defaultSorting.sort[].field`<br>· 默认筛选：`use='FilterActionModel'` 的 `props.defaultFilterValue.items[].path`（⚠️ 在 `props` 里，不在 `stepParams` 里） |
| 遍历时第二个坑 | 根**不只有页面 uid** —— 区块挂在 **Tab 自己的 `schemaUid`** 下（`desktopRoutes` 里 `type='tabs'` 的路由各有 schemaUid）。只从页面 uid 出发会拿到 **0 个区块**，于是"敏感列检查"因为**读到空**而通过。这是本条最容易踩的假绿 |
| 附带产出 | 平台给非状态 Tab 自动生成的 `FilterActionModel` 里，`defaultFilterValue.items` 是**没有 `value` 的空条件**（如 `{path:'status',operator:'$eq'}`）。所以"筛选条件够不够"必须按**带 value 的条件**数判定，否则空筛选器会把断言喂绿 |

---

## DEV-55 断言脚本**自己制造**的 403 会污染下一轮的「无 error 日志」断言
| 项 | 内容 |
|---|---|
| 现象 | 加完 §4e 第 4 组「未知 Origin 一律 403」的反向对照断言之后，**下一轮**跑冒烟时 `app 日志中无 error 级别输出` 变红：<br>`发现 1 条 error 日志，首条：{"level":"error","message":"Invalid sign-in origin",...}` |
| 根因 | ① 反向对照断言**故意**用 `Origin: https://evil.example.com` 登录，服务端抛 `ForbiddenError`；<br>② NocoBase 全局错误处理器对 **4xx 也按 error 级**记日志；<br>③ `docker logs` 不会随断言结束而清空 —— 于是**上一轮脚本自己的探针**留到下一轮窗口里，被"应用无 error 日志"这条断言当成系统故障 |
| 为什么是同一类问题 | 与 DEV-31 / DEV-34（并发脚本的探测请求污染 app 日志）完全同型：**测试工具也会污染环境**。区别只是这次污染源在 §4e 而不是 §4b |
| 处置 | 加一条**窄口径**豁免 `isExpectedError()`：只认 `Invalid sign-in origin` 这一条消息（正是那条断言制造的）。<br>⚠️ **不能**写成"排除所有 4xx"——那会把真正的故障一起豁免掉 |
| 豁免的代价（写清楚） | 若 nginx 来源校验真的坏了，"无 error 日志"这一条不再变红。但 §4e 的「携带正确 Origin 的登录成功」会红，所以不会漏 —— 两条断言的职责分工是：一条盯"能不能登进来"，一条盯"有没有意外崩溃" |
| 附带纪律 | 反向验证（故意注入敏感列看断言会不会红）跑完**必须**还原并再跑一轮全绿；否则污染会留在环境里，把下一轮的结论带偏 |

## 未做偏差声明（明确保持不变）

- ✅ 不擅自增加状态（严格 6 个）
- ✅ 不增加角色（除文档已标注可选的 viewer）
- ✅ 不接入 ERP / 库存 / 商品 / SN / 财务 / 在线支付
- ✅ 不依赖 NocoBase Professional / Enterprise 插件
- ✅ 不使用自增 ID 作为匿名访问凭证
- ✅ 短信"调用成功"不等于"送达成功"
