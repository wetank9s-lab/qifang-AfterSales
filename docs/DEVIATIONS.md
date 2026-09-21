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

## 未做偏差声明（明确保持不变）
- ✅ 不擅自增加状态（严格 6 个）
- ✅ 不增加角色（除文档已标注可选的 viewer）
- ✅ 不接入 ERP / 库存 / 商品 / SN / 财务 / 在线支付
- ✅ 不依赖 NocoBase Professional / Enterprise 插件
- ✅ 不使用自增 ID 作为匿名访问凭证
- ✅ 短信"调用成功"不等于"送达成功"
