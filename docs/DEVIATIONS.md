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
| 本方案 | `ROLE_NATIVE_READ_ACTIONS = ['view','list','get']` —— `create` / `update` / `destroy` / `export` / `move` **不授予任何角色**；业务写入只走 `/api/svc` action<br>⚠️ `view` 是 2026-09-22 补入的（**DEV-65**）：前台表格区块的渲染探针用的就是 `view`，缺它会让表格整块不渲染。其后 `plugin.ts` 的启动期自检改为断言「不得命中**写**名单」而非「必须在 `list/get` 里」，避免下次新增只读动作再误杀 |
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

## DEV-56 客户端插件**可以** import `@nocobase/flow-engine`，但必须逐个取证「运行时可解析」
| 项 | 内容 |
|---|---|
| 现象 | 要做 H6 业务按钮就得写客户端 `ActionModel`，而容器里**根本不存在** `@nocobase/client` / `@nocobase/flow-engine` 这两个包目录（`@nocobase/` 下只有 `plugin-*`）。照官方文档 `import { ActionModel } from '@nocobase/client-v2'` 写，风险未知 |
| 取证方法 | 不去猜，直接看**已经在跑的**内置插件产物的 UMD 依赖数组：<br>`plugin-action-export/dist/client/index.js` 的 `define("@nocobase/plugin-action-export",["lodash","react-i18next","@nocobase/flow-engine","@nocobase/client-v2","@emotion/css","@formily/antd-v5","@formily/shared","react","antd","@nocobase/client","@formily/react"])`<br>→ 数组里的名字就是 requirejs 认得的模块名（`react-dom` 另由 `plugin-action-import` / `plugin-block-workbench` 取证） |
| 结论 | 客户端可以安全 import：`@nocobase/client`、`@nocobase/flow-engine`、`react`、`react-dom`、`antd`。本项目产物最终用到 5 个：`["@nocobase/client","@nocobase/flow-engine","antd","react","react-dom"]` |
| 为什么必须自动守护 | 产物 HTTP 200、字节数正常、语法无误，**但只要有一个依赖名 requirejs 不认得**，浏览器就抛 `Script error for "@local/service-ticket"`，整个后台渲染成 App error，而 `/api/*` 侧所有断言**照样全绿**（与 §4e 开头那两条同型）。这是"测试覆盖的那一侧全绿、没覆盖的那一侧全瞎"的第三次出现 |
| 处置 | smoke 新增一条断言：解析产物 `define([...])`，逐个对照"内置插件实际用过"的模块白名单，不在白名单即红。<br>⚠️ 白名单是**取证结果**不是猜测，新增依赖前必须先确认它在某个内置插件里被用过 |
| 第二个不能退让的约束 | **客户端 `load()` 绝不抛出**。引擎 API 是运行时动态取的（不同小版本未必导出 `ActionModel`），拿不到就 `try/catch` 后 console.error 降级 —— 宁可"按钮没出现"，绝不能"后台打不开" |
| 为什么渲染只用 react/antd 的**基础**组件 | 刻意不用 antd 的 `Descriptions` / `Timeline`：它们在 v4/v5 之间 `items` 与 `children` 写法不兼容，踩错就是抽屉渲染不出来（而这在接口断言里完全看不出来）。列表一律用原生 HTML + 内联样式 |

## DEV-57 `.mjs`（ESM）里没有全局 `require`，异常被 catch 吞掉后伪装成"找不到模块"
| 项 | 内容 |
|---|---|
| 现象 | `scripts/verify-client-logic.mjs` 照抄 `build-plugin.mjs` 的 esbuild 兜底加载（三个 `require(...)` 候选），结果一律失败并退出码 2「找不到 esbuild」。而 `esbuild` 明明就在 `.workbuddy/binaries/node/workspace/node_modules/esbuild` |
| 根因 | `.mjs` 是 ESM，**没有全局 `require`**。写 `require('esbuild')` 抛的是 `ReferenceError: require is not defined`，而我把它和其他候选一起 `catch {}` 吞了 —— 于是"函数根本不存在"被显示成"模块找不到"，排查方向被带偏 |
| 处置 | 用 `createRequire(import.meta.url)` 拿 `nodeRequire` 再逐个候选加载；并且**把失败原因打印出来**（`errors.join(' | ')`），不再静默 |
| 可复用纪律 | ① 复制"加载代码"时先看源文件的模块形态（CJS 还是 ESM），`require` 不是通用写法；<br>② **catch 里吞掉异常又只报一个笼统结论**，是最容易把排查方向带偏的写法 —— 至少把 `error.message` 打出来 |

## DEV-58 客户端 `service_mode` 枚举与服务端不一致（**收口为前后端共享契约**）
| 项 | 内容 |
|---|---|
| 现象 | H6 派工/改派弹窗只有 `self`（自营）/ `third_party`（第三方·厂家合并）两个选项，而服务端 `DISPATCHABLE_SERVICE_MODES` 是 `inhouse` / `manufacturer` / `third_party`。选"自营"必然 `422 INVALID_ENUM`；"厂家"被并进"第三方"，**永远产生不了 `manufacturer` 数据** |
| 三重后果 | ① 服务端不认识 `self` → 确定性 422；② 按 `service_mode` 统计"厂家 vs 第三方"**直接失真**；③ 服务端对 `manufacturer`/`third_party` 要求 `provider_name` **必填**，客户端却把它定成非必填 |
| 根因（结构性） | 枚举在前后端**各写一份**，无人守护对齐 → "漂移"不是意外而是迟早。与 DEV-42 的"注释写一套、代码另一套"同型 |
| 处置 | 新建**零依赖共享模块** `src/shared/service-mode.ts`：枚举、派工可选集、中文标签、`requiresProviderName()` 条件必填规则**只此一份**；`server/constants.ts` 改为 re-export，客户端选项列表由 `dispatchServiceModeOptions()` 从 `DISPATCHABLE_SERVICE_MODES` **派生**（不是手抄）。<br>UI 三选项：门店自修 `inhouse`（provider 不必填）/ 厂家 `manufacturer` / 第三方 `third_party`（后两者必填）；`remote` 不显示，服务端仍保留 `REMOTE_MODE_DEFERRED` |
| 为什么还要断言 | 共享模块只保证"源码一致"。**源码改了但没重新构建**时，产物里仍是旧枚举 → 所以 smoke §4f 从**已部署产物**回读选项集合，而不是只读源码 |
| 附带纪律 | 空 `provider_name` 必须在**出口剔除**（不下发空串）——否则服务端会把空串当成"填了名字"，"没填"与"填了空"语义混淆 |

## DEV-59 内部写动作的 `X-Request-Id` **只校验存在、不做幂等**（注释与实现不符 → 裁定为方案 A）
| 项 | 内容 |
|---|---|
| 现象 | 服务端注释声称 `X-Request-Id` 是 `idempotencyRecords` 的幂等键，但 `dispatch`/`reassign`/`reschedule`/`accept` 的 action 只检查"这个头存不存在"，**没把它传进** `TicketService`。真实幂等只在**客户建单**那条链路上 |
| 风险不对称 | 前三个动作有状态机兜底（重复 accept 状态已变 / 重复 dispatch 已有 active Visit / 重复 reassign 责任人已更新），不易产生第二条 Visit；但 **`reschedule` 没有** —— 弱网重试两次会**再换发一枚 Token、再写一条事件、再发一条短信**，客户收到两条互相矛盾的短信 |
| 裁定 | 复核方给了二选一：**A** 内部写动作也实现真幂等；**B** 改注释承认只用于 tracing。**采用 A** —— 因为改约的副作用（换 Token + 发短信）不可回滚，而"注释与实现不符"本身就是下一轮缺陷的来源 |
| 实现要点 | ① 幂等键 = `scene + action + ticket_id + request_id + actor_user_id`（**含操作者维度**：换人拿同一个号不算重放）；② **幂等前置查询必须发生在业务写之前** —— 占位行本身是在业务写**完成之后**、**与业务写同一个事务**、事务提交前落库的。两者是**两条互补的路径**：串行重放靠前置查表拦住（占位行写在业务之后，所以"业务先拒绝"的路径根本走不到占位行 —— 受理重放会在状态机第一行就抛 409，唯一索引永远撞不上）；并发重放靠占位行的唯一约束兜底（先到者未提交时前置查表不可见，继续走业务，撞 23505 后回滚并回放）。<br>⚠️ **不要**把这条简化成"占位行必须写在业务写之前" —— 那是错的（2026-09-21 复核方指出）：真按那句话去"修正"代码，会把占位行提到业务之前，于是**业务失败也会留下占位行**，后续重放会拿到一个"什么都没做却标记为成功"的空响应。③ 回放**只标响应头** `X-Idempotent-Replay: 1`，正文与首次完全一致（前端不必为"重放"写分支）；④ `sms` 仍在事务提交后发，重放命中**不进入**发送路径 |
| 客户端对应要求 | 显式 `crypto.randomUUID()` 生成并发送 —— **不赌框架隐式注入**（仓库里没有任何证据支持 NocoBase 会自动注入本项目定义的这个头）。一次**逻辑操作**的网络重试**复用同一个号**；每次重试换号 = 主动拆掉幂等防线 |
| 为什么必须由自动化守护 | 真人走查**不会**模拟"请求其实成功了但浏览器没收到响应、用户再点一次"这种网络故障。§4f 为此专门断言：同 request id 重放 `reschedule` 后 Visit / 事件 / 短信 / Token **均不再变化** |

## DEV-60 后台整页 App error —— 产物 AMD 依赖数组漏声明 `react/jsx-runtime`
| 项 | 内容 |
|---|---|
| 现象 | 打开 `http://localhost:8080/` 报 **`App error` / `[service-ticket/client] 未在 AMD 依赖里声明的外部模块: react/jsx-runtime`**，整个后台白屏 |
| 触发时机 | 2026-09-22 走查前打开页面时暴露。**上一提交 `34a4348` 之前已存在**，非本轮引入 |
| 根因 | `scripts/build-plugin.mjs` 的 `buildClient()` 跑**两遍编译**：第一遍 "probe" 只为拿 metafile 的外部依赖清单，第二遍出真产物。**两遍选项不一致** —— probe 漏了 `jsx: 'automatic'` 与 `define`，于是 esbuild 不注入 `react/jsx-runtime`；第二遍有这个选项，产物里 `require("react/jsx-runtime")`。结果 `define([...])` 只声明 5 个、bundle 却 require 第 6 个 → UMD 白名单 `__require` 抛错 → requirejs 记为 Script error → **整页白屏** |
| 为什么 116 项断言全绿 | 原断言只查「**声明了的**依赖是否可解析」**一个方向**。本事故在**另一个方向**：正文 require 了但没声明。声明方向全绿、调用方向炸了 —— 典型"半个检查" |
| 修复 | 把两遍构建的**公共选项抽成同一个 `clientBuildOptions` 对象**（含 `jsx` / `define` / `external` / `platform` / `format` / `target`），probe 与产物构建都 spread 它，各自只追加差异项（`write` / `outfile` / `sourcemap` / `banner`）。这样"metafile 描述的程序"与"实际发布的程序"在编译语义上**不可能再分叉** |
| 补齐的断言（第二条 AMD 依赖检查扩为**三个方向**） | ① 声明方向：`define([...])` 里每个名字都在可解析白名单内（原有）；② **反向**：正文里每个 `require("裸模块")` 都必须在 `define([...])` 里已声明；③ **对照运行时**：这些模块还必须真的被 NocoBase 加载器注册过 —— 取证方式是读**后台主 bundle** 里的 `,"<模块名>",` 注册调用，**而不是再手抄一张清单**（手抄清单迟早漂移，这正是本次事故的成因）。主 bundle 文件名带内容哈希，故从首页 HTML 现取，不硬编码 |
| 取证（支撑"修复方向正确"） | ① admin 主 bundle 里确有 `iR(e,"react/jsx-runtime",O)` —— 加载器**注册过**它，所以"声明它"是可解析的，本次不是把故障换个地方；② 全仓 300+ 内置插件的 `define` 数组里**没有一个**声明 `react/jsx-runtime`（它们用 classic runtime / `React.createElement`，由 esbuild 内联）；③ 全仓搜 `jsx-runtime` 只命中 `plugin-ai` 一处，且是 URL 字面量 `hast-util-to-jsx-runtime` 的**假阳性**。故本插件是"首个用 automatic runtime 的客户端插件"，**必须自己显式声明** |
| 反向验证 | 注入伪造依赖 `fake/unregistered-module` → 断言**确实变红**（工程铁律 8）；还原后全绿 |
| 教训 | **"两遍编译取同一份输入"必须共享选项对象。** 只要两遍的编译选项可能不同，metafile 描述的就是"另一个程序"，而它看上去完全正常 |

---

## DEV-61 清理脚本"退出码 0 但什么都没删"—— psql 连接串写错却不报错

| 项 | 内容 |
|---|---|
| 现象 | 走查前清噪声工单：`docker exec svc-postgres psql ... <<'SQL'` 整段执行**无任何输出、退出码 0**，随后核对却发现工单数**一条没少**（仍 235）。 |
| 根因 | 两条叠加：① psql 的用户名/库名写错（写成了 `nocobase`，实际是 `.env` 里的 `svc_app` / `service_ticket`），psql 打印 `FATAL: role "nocobase" does not exist` 后退出码 **2**；② 但外层是 `docker exec ... && echo` 的**管道/多命令链**，shell 最终退出码取自**最后一条命令**，于是整体仍报 **0**。"命令失败"这件事被**退出码掩盖**了。 |
| 为什么危险 | 这正是工程铁律 10「读到空是最坏的假绿」的变体：**"以为删了"比"没删"更危险** —— 会拿着没生效的结果继续往下走（本轮的下一步就是基于"已清理"去安排走查）。 |
| 修复 | ① 从 `.env` **现读** `DB_USER` / `DB_DATABASE`，不手抄；② 清理 SQL 落成**带自校验的文件**（`BEGIN` + 前后置 `DO $$ ... RAISE EXCEPTION $$` + `COMMIT`），用 `psql -v ON_ERROR_STOP=1 -f` 执行 —— 断言不过就整事务回滚，**不可能半途落库**；③ 执行后**独立**再查一次行数与保留清单，不拿"执行成功"当证据。 |
| 关键教训 | **`Exit Code: 0` 不等于"业务动作发生了"**。凡是有副作用的命令，必须有一条**独立的、读真实状态的**复核查询；把"成功/失败"的判断权交给被写对象的实际取值，而不是退出码。多命令链里尤其要看**具体那条**的退出码（本例里 psql 的 `rc=2` 被链尾的 `echo` 冲掉了）。 |

---

## DEV-62 `flowModels:list?paginate=false` 的 `FilterFormGridModel` 没有 `parentId` —— 树遍历会假红

| 项 | 内容 |
|---|---|
| 现象 | 为搜索框写守护断言时，按既有 `pageSubtree()` 树遍历取 `FilterFormItemModel`，得到 **`searched=[]`**，看上去像"搜索项根本不存在/字段没配"。但库里确实有 8 个 `FilterFormItemModel`，`filterField.name` 全是 `ticket_no`。 |
| 根因 | 搜索项挂在 `FilterFormGridModel` 之下，而这个**中间节点在 `/api/flowModels:list?paginate=false` 的返回里没有 `parentId`**（实测 `"parentId" in node === false`）。树链在那一层断开，从页面根往下走永远到不了搜索项。 |
| 为什么容易误判 | 同一次断言里，"搜索**区块**（`FilterFormBlockModel`）"和"grid 的 `filterManager` 连接"都取得到、都通过，**只有搜索项取不到** —— 于是错误信息只指向"字段是空的"，非常像"配置漏了字段"，会把人引去改 JSON（而 JSON 是对的）。 |
| 修复 | 不靠树取搜索项：`FilterFormItemModel` 自带 `defaultTargetUid`（连到哪张表 = 目标表格 uid）与 `filterField.name`（搜哪个字段），直接按 target 建索引 `searchItemsByTarget()`，再与 grid 的 `filterManager.targetId` 对齐做三方向断言。附带保留 `assert(itemsByTarget.size > 0)` 防"索引本身是空的"假绿。 |
| 教训 | **平台返回的"树"不一定是完整的树。** 依赖父子关系做遍历前，先验证**每一层都有 `parentId`**；有断层的，改用节点自带的外键/引用去关联，别硬走树。另外：一条断言里"部分子检查通过、一个取空"时，别急着改被检查的数据 —— 先确认**取数路径**本身是对的。 |

---

## DEV-63 脚本连跑时 smoke 必出 429 假红 —— 限流令牌桶没回填

| 项 | 内容 |
|---|---|
| 现象 | 把 `verify-config → verify-plugin-load → verify-client-logic → verify-phase3-h5 → smoke-test` **连续串起来跑**时，`smoke-test` **必定**多出 2~3 条红，报错形如 `Phase3: 缺 X-Request-Id 返回 422（不是 400/500） — HTTP 状态码：期望 422，实际 429`。而 `smoke-test` **单独跑是 117 项全绿**。 |
| 根因 | nginx 对匿名接口的限流是 `svc_public: rate=30r/m burst=10 nodelay`（`nginx/nginx.conf:66`），对通用接口是 `svc_general: rate=300r/m burst=60`（`:68`）。前一个脚本（`verify-phase3-h5`）的匿名请求**把令牌桶打满**，紧随其后的 smoke 头几个请求就被 429 拦掉。30r/m = 0.5/s，从上一次打满算起约需 **20s** 才完全回填。 |
| 为什么危险 | 429 是**环境态**产物，不是业务缺陷，但它混进了业务断言的红灯里。下一个排查的人会去翻 `publicTicket:create` 的校验分支，而代码根本没错。**这正是"会误报的检查比没检查更糟"**（工程铁律 2），也是铁律 5「测试工具会污染环境」的一个具体形态。 |
| 判定依据（怎么区分 429 与真红） | ① 报错里出现 `实际 429` / `HTTP 429` 而**期望值是一个业务状态码**（422/409）；② 同一断言**单独跑就绿**；③ 重跑时失败项数**随机浮动**（2 或 3），而不是稳定同一组。三条同时成立即可判定为限流，不必改业务代码。 |
| 修复 | 新增 `scripts/uat-reset-baseline.mjs` 作为**标准编排入口**：脚本之间强制插入 **25s 冷却**（覆盖 20s 回填 + 余量），并把失败输出里的 429 单独标注为"疑似限流，非业务缺陷"。**不去改产品 nginx 限流值** —— 那是保护匿名接口的真实防线，为跑测试放宽等于把闸门拆了（与"取不到不能成为放宽权限的理由"同一条纪律）。 |
| 教训 | **验证脚本的编排者要为"状态污染"负责。** 串行跑联网脚本时，前一个脚本的副作用（限流额度、缓存 TTL、脏数据）会变成后一个脚本的假红。凡是要串起来的套件，必须显式处理"跨脚本状态" —— 要么冷却，要么隔离，要么在断言里把"环境未就绪"与"真失败"分开报。 |

---

## DEV-64 反向检查在"键不存在"时静默判定为安全 —— 读到空被当成没泄露

| 项 | 内容 |
|---|---|
| 现象 | `scripts/verify-config.mjs` 里「`.env 与 .env.example` 键集合一致」这条 check 一直是 **48/48 全绿**，但实际上 **`.env.example` 里根本没有那三个 `UAT_*_PASSWORD` 键**（模板只 64 键，`.env` 67 键，差额恰好就是这三个白名单键）。绿灯是靠白名单把差额吃掉换来的，不是靠模板真的留了坑位。 |
| 根因 | 该 check 的反向验证写成：<br>`UAT_PASSWORD_KEYS.filter(k => /^\s*[A-Z0-9_]+=/.test(text.split(/\r?\n/).find(l => l.includes(k)) ?? ''))`<br>当键**完全不存在**时 `find` 返回 `undefined` → `?? ''` → 在**空串**上跑 `test` 得 `false` → 该键**不被计入 leaked** → 判定为"没有泄露"。实测三态复现：<br>① 键不存在 → `leaked = []`<br>② 真泄露（注释被改成赋值）→ `leaked = ["UAT_HQ_PASSWORD"]`<br>③ 注释保留 → `leaked = []`<br>**①与③不可区分**，即"闸门已经不在模板里了"与"闸门装得好好的"给出同一个绿灯。 |
| 为什么危险 | 这是**工程铁律 10「读到空是最坏的假绿」**的标准形态：它不会误报，所以没人会去查它；但它会在整条守卫最该报警的时候保持沉默。更具体的危害是 —— 白名单机制的全部意义是"模板里留了注释坑位供走查时取消注释"，坑位不存在则白名单退化成"这三个键爱在哪在哪"，将来有人把 `UAT_STORE_C_PASSWORD` 之类的敏感键漏进 `.env`，也很难靠这套机制发现。 |
| 判定依据 | 断言"名称"与"实际覆盖面"不符：名字说"键集合一致"，实际做的是"`.env` 独有键必须落在白名单里"。白名单是**豁免**，而豁免对象是否存在**从未被要求**。凡是"豁免类"断言，都必须额外断言"被豁免的东西确实存在"（else 就是拿豁免掩盖缺失）。 |
| 修复 | ① 断言拆成正反两条：**存在性**（键必须出现在 `.env.example`）+ **形态**（必须是 `# KEY=` 的注释形态，等号后为空）。任一不满足即红。② `.env.example` 补上 3 行注释坑位与说明段。③ 把"读到空"这个坑写进注释，防止后人再简化回去。 |
| 反向验证 | **两种失败模式都必须能变红**（只验一种等于没验）：<br>A. 把注释改成 `# UAT_HQ_PASSWORD=LEAKEDSECRET` → **47 通过 / 1 失败**，报"不是注释形态，可能被实际赋值"；<br>B. 把整行注释删掉（**旧实现会在此假绿**）→ **47 通过 / 1 失败**，报"完全找不到"；<br>C. 还原后复跑 → **48/48 全绿**。 |
| 教训 | **写"反向验证"时，必须覆盖"被检查对象不存在"这一态**，而不只是"存在但取错值"。`?? ''` / `?? []` / `\|\| fallback` 这类兜底写法，在断言里几乎总意味着"取不到就当成安全"，是个持续的假绿来源。同理见 DEV-59 的 `userIdOf() ?? fallback`（`??` 对返回 `0` 的函数不生效，兜底永不触发）——**同一类错误的两种表现形式**。 |

---

## DEV-65 资源级 ACL 缺 `view` → 后台表格**整块不渲染**（Phase 4-I 走查阻塞项）

| 项 | 内容 |
|---|---|
| 现象 | 三个 UAT 账号（A / B / HQ）登录后台后：页面骨架、菜单、6 个 Tab 标题、搜索框**全都在**，但**表格整块不见**（`document.querySelectorAll('.ant-table').length === 0`），看不到任何工单。同一页面上 `admin` 登录**正常看到表格**。接口侧 `serviceTickets:list` 一直是 **200 且有数据**，页面**无任何 JS 异常、无 4xx**。 |
| 为什么是最危险的形态 | 所有"服务端视角"的验证都是绿的：`smoke-test` 的 `SMOKE_ALLOW_NO_VISITS`、数据洁净检查、`serviceTickets:list` 返回体非空、ACL 授权行数正确。**只有真人打开浏览器才看得见问题** —— 这正是 Phase 4-I 要求"必须真人走查、自动化只能补充"的实证。 |
| 根因 | **NocoBase 的 ACL 是两级判定，两级都要过**：<br>① `dataSourcesRoles.strategy.actions`（全局 action 名白名单）<br>② `dataSourcesRolesResources` + `dataSourcesRolesResourcesActions`（**逐资源 × 逐 action 放行**）<br>当时 `ROLE_NATIVE_READ_ACTIONS = ['list','get']` → 资源级授权里**没有 `serviceTickets:view` 这一行**。strategy 层虽然写了 `view`，但第二级不过就是不过。 |
| 取证链（逐层排除） | ① 页面骨架/Tab/搜索框都在，`.ant-table` 数量为 0 → 不是页面没加载；<br>② 注入 `window.addEventListener('error')` + `unhandledrejection` + `Log.entryAdded` → **全无**异常 → 不是渲染崩溃；<br>③ 抓 `flowModels:*` 请求 → 表格区块 `z2eqnnlell6` **从未被请求**；<br>④ 读 React fiber → 模型层**完全正确**：`layout.rows` 有 row2、`subModels.items` 里 `FilterFormBlockModel` 与 `TableBlockModel` 都在；<br>⑤ 读两个区块的运行时 `hidden` → FilterForm `false`、**Table `true`**（差异唯一来源）；<br>⑥ 定位置 `hidden=true` 的代码：客户端 `aclCheck` 动作用 `actionName: 'view'` 做探针，不过则 `model.hidden = !0` + `exitAll()`；<br>⑦ 前端 `normalizeLayoutFromSource()` 把 `hidden===true` 的 item 从格子剔除 → row2 变空行 → **整行被删** → 表格消失。 |
| 关键代码 | 客户端 `aclCheck`（minified bundle 内）：<br>`wM = defineAction({ name: "aclCheck", async handler(e,t){ if(e.skipAclCheck) return; let a = await e.aclCheck({ dataSourceKey, resourceName, actionName: e.actionName, fields, allowedActions, recordPkValue }); e.actionName && (a \|\| (e.model.hidden = !0, e.model.forbidden = { actionName: e.actionName }, e.exitAll())) } })`<br>前端 grid 剪枝：`items.filter(e => e === EMPTY_COLUMN_UID \|\| a.get(e)?.hidden !== true)`，无可见 item 则整格 `null`、整行 `null`。 |
| 为什么之前没发现 | 前端 ACL 探针的**动作名是按区块类型定的**：`TableBlockModel` 用 **`view`**，而 `FilterFormBlockModel` **不用 `view`**。所以"搜索框在、表格没了"这个组合看起来像渲染 bug，实际是权限判定问题。此前所有 ACL 验证都只验 `list`/`get`（服务端取数路径），从未验过 `view`（前端渲染路径）。 |
| 反证（已实测，非推断） | 手工插入 `(store_after_sales, serviceTickets, view, <与 list 同白名单>)` + `docker compose restart app`：<br>· `roles:check` 从 8 键 → 9 键（含 `serviceTickets:view`）<br>· 浏览器 `tables: 1 / rows: 4`，数据全部出现<br>· `admin` 对照：root 不过 ACL，始终正常 —— 差异唯一来源确认为 ACL |
| 修复 | `ROLE_NATIVE_READ_ACTIONS` 由 `['list','get']` 改为 **`['view','list','get']`**（`nocobase/plugins/service-ticket/src/server/constants.ts`），附 35 行说明注释记录本次完整取证链。种子"只增不改"会把 `view` 行补进已部署实例（实测 `dataSourcesRolesResourcesActions` 32 → **48** 行）。 |
| 安全性 | `view` **不放宽任何写权限**：它是只读判定动作，NocoBase 的写入口（`create`/`update`/`destroy`）走完全不同的 action 名，仍由 `assertNativeReadAllowlist()` 的写名单断言在**启动期**拦死。`view` 的语义是"可进入查看态"，不产生任何数据变更路径。 |
| 同步修正的断言（"会误报的检查比没检查更糟"） | 改常量后暴露出 `verify-plugin-load.mjs` **26 项 + 3 项**假红，根因都是**断言手抄了 `list/get` 与数字 32**，而实现改对了：<br>· `verify-plugin-load.mjs`：`32` → 由 `expectedActions` 派生；新增 `WRITE_ACTIONS` **否命题**断言（"不得命中写名单"）替代 `row.name === 'list' \|\| row.name === 'get'` 这样的**白名单枚举**。枚举式断言在只读动作集演进时必然误报，且一旦被"放宽成任意 action 都行"就会把写后门放进来 —— 否命题同时避开两个坑。<br>· `plugin.ts:63` `NATIVE_READ_ONLY_ACTIONS` 由**手抄** `['list','get']` 改为**从常量派生** `new Set(ROLE_NATIVE_READ_ACTIONS)`。<br>· `smoke-test.mjs`：新增 `PHASE2_READ_ACTIONS` 常量，替换三处硬编码 `2` / `list/get` / `32 条`。 |
| 反向验证 | 在 `ROLE_NATIVE_READ_ACTIONS` 里注入写动作 `update` 后重建 → **13 项失败**，错误消息为"含写 action：update；各业务角色只应被授予只读动作（view/list/get）"，且**启动期自检**也抛错（`load()` 级别的失败被上层 catch 成多项红）。还原后复跑 → **59/59 全绿**。证明新断言既拦得住写后门，又不再误杀 `view`。 |
| 教训 | ① **ACL 是两级判定**：`strategy` 层写了不等于资源级放行，"看起来该有权限"与"权限真的存在"是两件事；<br>② **前端也有 ACL**：后台表格/详情区块会按区块类型挑不同的 action 名做探针，服务端取数通过 ≠ 前端会渲染；<br>③ **"接口 200 且有数据"不能证明"用户看得见"** —— 本轮所有服务端绿灯都在，用户看到的仍是空白页；<br>④ 断言里**手抄白名单/数字**迟早误报，优先写**否命题**（"不得命中写名单"）；<br>⑤ 单一事实来源要真的"单源"：`plugin.ts` 手抄了一份 `list/get`，于是改 `constants.ts` 反而让插件起不来。 |

---

## DEV-66 复核 DEV-65 时探针**自己造出来的 404** —— 一个字符的 typo 伪装成权限缺陷

| 项 | 内容 |
|---|---|
| 现象 | 为复核 DEV-65 写三账号浏览器探针（`.probe-uat-all.mjs`）。结果**只有 UAT-HQ 失败**：登录后访问 `/admin/<uid>` 渲染「404 页面不存在」，`tables=0 / rows=0`。A、B 两个账号都正常出表格。 |
| 为什么极具迷惑性 | ① 失败**只出现在一个账号**上 → 天然像"该角色的权限/菜单配置有问题"；<br>② 另一个探针（`.probe-hq404.mjs`）跑**同一账号同一 URL** 却拿到了 `tables:1 / rows:4` → 两个结果互相矛盾；<br>③ 期间还叠加了两个**我自己引入的 CDP 用法错误**（见下），使排查方向被反复带偏。 |
| 真根因（一个字） | 探针里把 HQ 页面路径写成 `'/admin/a7p45sundbs'`，**真实 schemaUid 是 `a7p45sundsb`**（`b` 与 `s` 写反了）。<br>数据库实测：`SELECT "schemaUid" FROM "desktopRoutes" WHERE title='全量工单'` → **`a7p45sundsb`**。<br>于是探针访问的是一个**从不存在的路由** → SPA catch-all 渲染 404。**与权限、菜单、ACL 全都无关。** |
| 排查中被带偏的三条岔路（都曾是"合理怀疑"） | ① **怀疑 role 配置**：`rolesDesktopRoutes` 里 `hq_after_sales` 确实**有** 全量工单 → 排除；<br>② **怀疑前端路由未注册**：改用"点真实菜单"进入 → 无头模式下左侧菜单**从不渲染**（`menuTexts: []`），该路径在本环境不可用 → 排除；<br>③ **怀疑时序竞态**：按登录后 8/15/25/40s 各直链一次，**恒 404** → 不是等待时长问题。 |
| 同时暴露的两个**探针**缺陷（与产品无关，但会持续制造假红） | ① **CDP 连错 endpoint**：ws 连了 `/json/list` 里的 **page** endpoint，却发 `Target.createTarget` / `Target.attachToTarget` 这类 **browser 级**命令 → `targetId`/`sessionId` 双双 `undefined`，所有 `Runtime.evaluate` 都打在 `about:blank` 上，返回空值。**正解：ws 必须连 `/json/version` 的 `webSocketDebuggerUrl`；页面级命令（`Runtime.enable`/`Page.navigate`）必须带 `sessionId`，否则报 `'Runtime.enable' wasn't found`。**<br>② **`send()` 吞掉 CDP 错误**：收到 `error` 字段时不 reject，静默 resolve(undefined) → 报错点漂移到无关的 `JSON.parse` 上，浪费大量时间。**正解：`m.error ? rej(...) : res(...)`。** |
| 定位方法（可复用） | 做了**顺序对照实验**：把 HQ 放在第一个账号 → 变成 **HQ 成功、A 失败**；把 A/B 放前面 → A/B 成功、HQ 失败。即失败**跟随"位置"而非"账号"**。<br>这一步很关键：它**一次性推翻**了"某个账号权限有问题"的所有假设，把问题定域到"探针对不同账号的处理差异"上，随后逐字段比对才发现是路径字面量写错。<br>最终用 **一进程一账号**（`.probe-one-account.mjs`）拿到干净结果：<br>· UAT-A `tables=1 rows=3`（FW0059/FW0002/FW0001）<br>· UAT-B `tables=1 rows=1`（FW0060）<br>· UAT-HQ `tables=1 rows=4`（FW0060/FW0059/FW0002/FW0001） |
| 教训（与铁律 9「脚本自造失败跨轮污染」同源） | ① **"只有一个账号失败"不等于"那个账号有问题"** —— 先问"失败是否跟随位置/顺序"，顺序对照实验成本极低、排除力极强；<br>② **探测脚本里的字面量（URL/uid/id）必须从权威来源取，不要手抄**。本轮的 `a7p45sundsb` 就是手抄时 transposed 一个字符 —— 与 DEV-65 里"断言手抄 `list/get`"是**同一类错误**：手抄的字面量迟早漂移，且伪装得极好；<br>③ **两个探针给出矛盾结论时，不要选信一个，要去找到那个区分变量**。本轮区分变量最终是"页面路径字面量"，而非最初怀疑的权限/时序/CDP；<br>④ 输出**逐条追加写文件**，不要用 `tail -N` 看结果 —— 本轮 `tail -40` 把前两个成功账号的输出截掉，一度让人以为"只有第三个有问题"。 |

---

## DEV-67 DEV-65 哨兵初版是**假绿** —— `Runtime.evaluate` 表达式引用了生成脚本的变量

| 项 | 内容 |
|---|---|
| 现象 | 给 `scripts/uat-preflight.mjs` 加了「界面渲染（DEV-65 哨兵）」小节（三账号各开一次无头浏览器，断言 `.ant-table` 与 `tr.ant-table-row` 真的存在）。**首跑三账号全红**：`tables=0 rows=0`。但同一环境下独立探针 `.probe-one-account.mjs` 稳定给出 A `3 行` / B `1 行` / HQ `4 行`。 |
| 第一层误导 | 红得像"DEV-65 复发"，且"独立探针绿、前哨红"的差异看起来像**同进程串跑三个账号的会话串扰**（此前 DEV-66 已有"失败跟随位置"的先例，很容易顺着这个思路去改成 spawn 子进程）。 |
| 真根因（两层，都是**探针**自己的问题） | ① **一个 JS 作用域错误**：生成的脚本里写了 `const EMAIL_JSON = "..."`，然后在 `Runtime.evaluate` 的表达式里 `JSON.parse(EMAIL_JSON)`。但 `Runtime.evaluate` 把表达式送到**浏览器页面的 JS 上下文**执行 —— 页面里根本没有 `EMAIL_JSON` 这个名字。<br>② **异常被静默吞掉**：`Runtime.evaluate` 的业务异常走 `result.subtype === 'error'`，**不会**让 `send()` reject。于是 `ReferenceError: EMAIL_JSON is not defined` 无声无息，两个 `input` 保持为空 → 点"登录"什么也不发生 → 页面**停在 `/signin`** → 探针如实报 `tables=0`。<br>判定工具：`.probe-render-dbg2.mjs` 打了阶段日志，一眼看到 `after login: url=http://localhost:8080/signin` —— **根本没登录进去**，与表格、权限、ACL 全无关系。 |
| 为什么这是"最坏的一类假红" | 症状（空白页）与 DEV-65 的**真实故障症状完全一致**，因此一个探针 bug 能完美伪装成被它守护的那个产品缺陷。若不去做反向验证，就会得出"DEV-65 修复无效"的错误结论，进而可能去改**本来就正确**的生产代码。 |
| 修复 | ① 账号口令**直接内联进 `Runtime.evaluate` 的表达式**（外层插值 `setVal(ins[0], ${JSON.stringify(email)})`），不再经由生成脚本的 const 中转；<br>② 填写后**回读两个 input 的值**并断言等于期望，不等则立即 `bail`（把"填不进去"暴露在最短路径上，不等 25s 后报"表格未渲染"）；<br>③ 显式检查 `fill.result?.subtype === 'error'`；<br>④ 点击"登录"也回读 `CLICKED` / `NOT_FOUND`，避免"没点着"沉没成假红；<br>⑤ 冷启动等待由固定 `11s` 提到 `BOOT_MS = 18s`（本地 Nginx + NocoBase 首请求要编译 bundle）。 |
| 反向验证（**本次真正证明断言有效的一步**） | 修复后前哨 13/13 全绿（A 3 行 / B 1 行 / HQ 4 行）。随后做**真正的反向验证**：<br>① 直接问服务端 `GET /api/roles:check`（`auth:check` 只回用户对象、**没有** acl 字段 —— 别猜端点）→ 三账号 `serviceTickets:*` 含 `view`，`HAS_VIEW=true`；<br>② 从库里 **删除** 8 条 `view` 授权行；<br>③ **必须临时中和种子补齐**：`seedRoleResources()` 的"① 补齐缺失的 action 行"**不受任何逃生开关控制**，重启后会把 `view` 全部补回 —— 第一次反向验证因此被静默破坏（删了又被补，前哨仍绿，差点误判为"断言无法变红"）。中和方式是临时改**已构建产物** `storage/plugins/.../dist/server/index.js` 里那一行，验完立即还原；<br>④ 重启后确认库里 `view` = **0 行**、`roles:check` 三账号 `HAS_VIEW=false` → 前哨**三账号全红、退出码 1**；<br>⑤ 还原产物 + 重启 → 种子自愈补回 **8 行**、`HAS_VIEW=true`、前哨 **13/13** 全绿。 |
| 教训 | ① **铁律 8 的具体形态**：新写的哨兵**必须先证明它能变红**再看它绿不绿。本轮首版"绿"是纯假绿（连登录都没成功），若不做反向验证会一路带进走查；<br>② **`Runtime.evaluate` 与 Node 是两套作用域**：表达式里只能引用**页面里存在**的变量。凡是"在 evaluate 里引用生成脚本的变量"都必须先问：这名字在页面里有吗？<br>③ **`Runtime.evaluate` 的异常不会 reject CDP 调用**，必须显式查 `result.subtype === 'error'`，否则错误会漂移/静默；<br>④ **反向验证本身也可能被"自愈逻辑"破坏**：本项目种子刻意设计成"只增不改 + 自动补齐"，这让"删掉某行看能不能变红"天然失效。做反向验证前必须先确认**没有别的机制会把它加回来**，否则得到的是"断言无法变红"的错误结论；<br>⑤ **症状相同 ≠ 病因相同**：探针故障与产品故障可以长得一模一样。定位手段是**看中间态**（本例看"登录后 URL"），而不是盯着最终症状猜；<br>⑥ 端点与字段名同样**不要猜**：`auth:check` 回用户、`roles:check` 回 ACL，猜错只会得到又一个"空结果假绿"。 |

---

## DEV-68 `applyBlueprint` 的 `actions` / `recordActions` **在架构上无法**声明自定义 ActionModel

| 项 | 内容 |
|---|---|
| 现象 | Phase 4-I 首轮走查发现：H3/H6 的五个自定义 `Ticket*ActionModel` 已在客户端注册（引擎注册表实测 `REGISTERED\|{"total":245,"ticket":[...5 个...]}`），但页面上一个按钮都没有。自然想法是"那就在 `seed-admin-pages.mjs` 的 `ticketTableBlock()` 里把 `actions: ['filter','refresh']` 扩成 `['filter','refresh','accept','dispatch',...]`"。 |
| 结论 | **这条路走不通，而且不是"没找到正确写法"，是架构上被禁止。** 自定义动作**只能**绕过 blueprint、直接在 flowModels 层写入。 |
| 证据链（服务端实测，容器内源码 + HTTP 双证） | ① **`actions`/`recordActions` 里只能是 catalog 的 publicKey**：`catalog.js:3880 resolveSupportedActionCatalogItem()` 先按 `input.use` 查 `ACTION_CATALOG_BY_USE`、再按 `input.type` 查 `ACTION_CATALOG_BY_KEY`，两者都只查**静态 `actionRegistry` 数组**（`catalog.js:3220`，纯字面量、无插件注册入口）；查不到即 `throwBadRequest('flowSurfaces addAction only supports registered action types/uses')`。<br>② **`actionRegistry` 每一项都被 `validateActionRegistryItem()` 校验 `nodeContracts.has(item.use)`**（`catalog.js:3774`），而 `nodeContracts` 只由**硬编码的 `NODE_CONTRACT_ENTRIES` 数组**填充（`catalog.js:2629/2751`，约 120 项，全是内置模型）。自定义 `Ticket*ActionModel` 不在数组里 → 即使硬塞进 `actionRegistry` 也会被 `throwCatalogInvariant` 挡下。<br>③ **静态全量目录实测**：`grep -rn 'TicketAcceptActionModel' /app/nocobase/node_modules/@nocobase/plugin-flow-engine/dist/` → **0 命中**（自定义动作只在 `storage/plugins/@local/service-ticket/dist/client/` 里有）。<br>④ **HTTP 实证（对照实验）**：`POST /api/flowSurfaces:addAction`，`target.uid=19w3dxgv1eo`（H1 `all.all-table`）<br>&nbsp;&nbsp;· `{use:'TicketAcceptActionModel'}` → **400** `only supports registered action types/uses`<br>&nbsp;&nbsp;· `{type:'TicketAcceptActionModel'}` → **400** 同错<br>&nbsp;&nbsp;· `{action:{use:'TicketAcceptActionModel'}}` → **400** 同错<br>&nbsp;&nbsp;· `{use:'TicketAcceptActionModel', key:'ticketAccept'}` → **400** 同错<br>&nbsp;&nbsp;· **对照组 `{type:'link'}` → 200**，返回 `{"uid":"iyyh8egpcaz","parentUid":"19w3dxgv1eo","subKey":"actions","scope":"block"}`<br>对照组成功 ⇒ 是**该 use 不被接受**，不是权限/路径/参数形状问题。 |
| 附带的**独立**发现（DEV-53 坑 2 的机制层解释） | `actions` 只能写内置 key，但**blockType 还会自动注入一批默认动作**：`default-block-actions.js` 的 `FLOW_SURFACE_DEFAULT_BLOCK_ACTIONS.table = [filter, refresh, **bulkDelete**, **addNew**(actions 侧), **view**, **edit**, **delete**(recordActions 侧)]`，由 `mergeFlowSurfaceDefaultBlockActions()`（`compile-blocks.js:2101`）合并。因此 `actions:['filter','refresh']` 实际落库**5 个按钮**，行级还凭空多出 `查看/编辑/删除`：实测 H1 `all.all-table` 的 `actions` 子模型 = `FilterActionModel`(declaredKey `all.all-table.filter_1`) + `RefreshActionModel`(`refresh_2`) + `BulkDeleteActionModel`(`bulkDelete_default_3`) + `AddNewActionModel`(`addNew_default_4`)。<br>⚠️ **`AddNewActionModel` 的 `popupSettings.openView` 指向一个真实存在的抽屉页 `ChildPageModel`**（`uid=n42h5a1403q`，模板 `evg3drixi4t`）—— 这正是"自动生成的按钮让真人误以为是正常售后操作"的源头，也是第四条第 ⑤ 项断言「页面中没有通用 update/edit/delete/addNew 写路径」要盯的对象。<br>逃生口：`splitApplyBlueprintBlockActionsByScope()` 会先按 scope 分流（`ATTACHED`：`view/edit/delete/updateRecord/duplicate` 从 `actions` 自动**提升**到 `recordActions`），且 `resolveDefaultBlockActions()` 在 `hasFlowSurfaceTemplateDocument(template)` 为真时返回 `[]`（模板化区块不注入）。**但仍无法借此声明自定义动作。** |
| 为什么这是"必须记录"的架构约束 | 若不记录，下一轮（或下一个接手的人）会再次尝试"给 `actions` 加自定义 key"，然后花大量时间猜 Flow Engine JSON —— 正是用户明确禁止的（"不要继续猜 Flow Engine 内部 JSON"）。DX 上它有极强的**误导性**：`actions: ['filter','refresh']` 看起来就是一个"可扩展的按钮清单"，而实际上它只接受**编译期硬编码的 catalog publicKey**。 |
| 修复方向（Task 51 据此改写） | 不走 blueprint `actions`。改为在 **flowModels 层写入动作模型行**（每行 `{uid, name, parentId, subKey:'actions', subType:'array', use, props, stepParams, flowRegistry}`，直接对照本文件 §真实生成行），并保留 `__flowSurfaceMeta.declaredKey` 以保证播种幂等可定位。详见 `docs/PHASE-4.md`。 |
| 教训 | ① **"看起来可配置"≠"可配置"**：`actions` 数组的真实类型是 `enum<catalogPublicKey>`，不是 `string[]`。判断某个字段能否承载自定义值，要去看**校验器**，不是看调用点；<br>② **对照实验依然是最高性价比的定位手段**（同源 DEV-66 教训③）：同为 `addAction`，`link` 200 而 `TicketAcceptActionModel` 400，一个变量之差，立刻排除"权限/参数形状/端点错误"；<br>③ **自定义客户端模型默认是"前端孤岛"**：`client/index.ts` 里 `engine.registerModels()` 成功 ≠ 服务端 catalog 认识它。**`addAction` 走的是服务端 catalog，`registerModels` 走的是浏览器引擎注册表 —— 这是两个互不相通的世界**；<br>④ 拿"真实生成行"当模板（本轮 `link` 动作 `iyyh8egpcaz` 的完整落库形状）比读类型声明可靠得多 —— 与 DEV-54 的教训同源；<br>⑤ `removeNode` 才是 `addAction` 的对称清理接口（`removeAction`/`deleteAction` 均 404），反向验证时用它删除实例。 |

---

## DEV-69 `flowModels:save` 的 payload **不能再包一层 `{values:…}`** —— 库里行数全对、页面一个按钮都没有

| 项 | 内容 |
|---|---|
| 现象 | 按 DEV-68 的结论改为"直接在 flowModels 层写动作行"后，播种脚本报 **`7 张工单表已挂齐五个自定义动作，且回读确认无缺失`**、对账后 `现存自定义动作行 35（期望 35）· 孤儿 0`，所有"数行数"的断言**全绿**；但无头浏览器打开 H1 页面，行内按钮依旧是 `["筛 选","重 置","查看","编辑","删除"]` —— **五个业务按钮一个都没有**。 |
| 结论 | **`POST /api/flowModels:save` 的 body 就是「扁平 model 对象本身」，不是 `{values: model}`。** 多包一层的后果是：服务端把 `values` 当成了一个**普通字段**原样摊平进节点行 → 落库行长这样：<br>`{"values":{"use":"TicketDetailActionModel","props":{…}},"parentId":"rxwga9x1mqg","subKey":"actions","subType":"array"}`<br>——**顶层没有 `use`**。客户端拿不到 `use` → 解析不出模型类 → **静默不渲染**。而"这个 uid 的行存在"是客观事实，所以只数行数的断言**全部为绿**。 |
| 证据链 | ① 服务端实现（`plugin-flow-engine/dist/server/server.js`）：`save: async (ctx) => { const { values } = ctx.action.params; const uid = await repository.upsertModel(values); }` —— **`values` 自身就是 model 对象**。<br>② `upsertModel` → `modelToSingleNodes(model)`（`server/repository.js:1256`）首行：`const { uid, async, subModels, ...rest } = cloneDeep(model);`，随后 `const node = { uid: currentUid, 'x-async': async \|\| false, name: currentUid, ...rest };` —— **除 `uid`/`async`/`subModels` 外的一切字段被原样摊平进节点行**。所以传 `{values:{…}}` 时，`values` 就成了一个真实的 key。<br>③ **库内对照（`flowModels` 表只有 `(uid, name, options)` 三列，全部结构在 `options` JSON 里）**：<br>&nbsp;&nbsp;· 坏行 `hbgy5cwvj36` → `{"values":{"uid":"testattach01","use":"TicketDetailActionModel",…},"parentId":"rxwga9x1mqg","subKey":"actions","subType":"array"}`<br>&nbsp;&nbsp;· 内置行 `orjt790xo4m` → `{"parentId":"rxwga9x1mqg","subKey":"actions","subType":"array","use":"ViewActionModel","props":{…},"decoratorProps":{},"stepParams":{…},"flowRegistry":{}}`<br>④ **页面树响应体实证**：坏节点在树里长成 `{values:{…},parentId:"rxwga9x1mqg",parent:"rxwga9x1mqg",subKey:"actions",subType:"array",uid:"hbgy5cwvj36",sortIndex:4}`，遍历打印 `use=undefined`；内置节点 `keys=parentId,subKey,subType,use,props,decoratorProps,stepParams,flowRegistry,uid,parent,sortIndex`。<br>⑤ **修正后的对照**：同一位置改用扁平 payload 重新 `save`，回读得到 `{"use":"TicketDetailActionModel","parentId":"rxwga9x1mqg",…,"uid":"probeattach1","parent":"rxwga9x1mqg"}`（**键集与内置节点逐字段一致**），无头浏览器立刻渲染出 `btns:["筛 选","重 置","查看","编辑","删除","详情"]`；全量播种后 H1/H2 均为 `["…","详情","受理","派工","改派","改约"]`。 |
| 为什么这是"必须记录"的陷阱 | ① 它的**假绿程度高于 DEV-68**：DEV-68 至少会 400 报错，而它**一路 200 + 行数正确 + 断言全绿**，只有真人打开页面才发现"没有按钮"—— 正是首轮走查 BLOCKED 的同类形态；<br>② 错误方向**极难自查**：`{values:{…}}` 是一个很自然的心智模型（"save 接口当然收 values"），而真名字段（`ctx.action.params.values`）与真实现（"摊平进行"）之间只隔一层解构，看调用点完全看不出来；<br>③ 会连带污染**全库**：所有"数一数有几行自定义动作"的断言、对账、`declaredKey` 溯源全部对这五类病态行**视而不见**（因为顶层 `use` 是 `undefined`，`TICKET_ACTION_USES.includes(undefined)` 为假）。 |
| 修复 | `scripts/ticket-page-actions.mjs` 的 `actionRow()` 产出**扁平**行（`{uid, name, parentId, subKey, subType, use, props, decoratorProps, stepParams, flowRegistry, sortIndex}`）；`scripts/seed-admin-pages.mjs` 的 `seedTicketPageActions()` 改为 `POST /api/flowModels:save` **直接传 `row`**（**不再** `{ body: { values: row } }`）。<br>顺带两点：<br>&nbsp;&nbsp;· **改用 `save` 而非 `create`**：`create` 走裸 insert、**不触发 `flowModels.afterInsert` 钩子**（该钩子负责 `insertNewSchema` → 写 `flowModelTreePath` 祖先链），不建祖先链的节点 UI 读树时完全看不见。`save` 内部走 `updateSingleNode`/`insertSingleNode`，路径由钩子维护，且**本身就是 upsert**（省掉"探测存在性"那一步）。<br>&nbsp;&nbsp;· **`props` 与 `stepParams.buttonSettings` 逐字段对齐内置动作**（`props:{type:'link',title,icon:null}`；`stepParams.buttonSettings.general:{title,icon:null,type:'link',iconOnly:false}`），并把 `stepParams.__flowSurfaceMeta.declaredKey` 设为 `svc.<key>` 以便溯源。 |
| 断言侧的修正（同样重要） | **判据从「uid 的行在不在」改为「顶层 `use` 是不是期望值」。** `assertTicketActions()` 新增 `malformed` 通道：命中 uid 但 `node.use !== model.use` 的行单独点名（`<uid>:顶层无 use`），并计入失败。`reconcileTicketActions()` 增加第二遍兜底扫描，按"uid ∈ 期望集合但顶层无 `use`"清理病态行。<br>`scripts/verify-ticket-actions.mjs` 独立断言「没有病态行（顶层 use 缺失/错位）」。 |
| 教训 | ① **"库里写对了"与"界面上出现了"是两件事**：结构断言的判据要选**客户端真正消费的那个字段**（这里是顶层 `use`），而不是"插入动作成功与否"；<br>② **接口收 `{values}` 不代表 body 要包一层 `values`**。看调用点 (`ctx.action.params.values`) 与看实现 (`modelToSingleNodes` 的 `...rest`) 会得出**相反**的结论 —— 涉及"写入形状"时**必须读实现**；<br>③ **递增式假绿最危险**：行数对、对账 0 孤儿、断言全绿，一切指标都在说"成了"。这类缺陷只能靠**一次真实渲染验证**兜住 —— 因此"结构断言 + 渲染验证"必须成对存在，不能只有前者；<br>④ 拿"内置同类节点的**完整落库键集**"当基线最省事：把 `Object.keys(内置节点)` 与 `Object.keys(我的节点)` 并排打出来，差异一眼可见（本轮就是靠这个当场定位的）；<br>⑤ 反向验证要**真的重跑断言**并断言它变红，不能只写一句"若此刻重跑会变红"——那是描述，不是验证（铁律 8）。 |

---

## DEV-70 改派 `reason` 在客户端载荷出口被**静默剔除**（Phase 4-I 第二轮走查 P0）

| 项 | 内容 |
|---|---|
| 现象 | 第二轮真人走查：在页面上点「改派」、**填了"改派原因"**、提交后服务端返回 **422 `MISSING_REASON`**。界面上表现为"这个框填了没用"，而**两边都不报错**。 |
| 结论 | 不是服务端校验不当、不是 ACL、不是表单没收集到 —— 是**客户端载荷的白名单只认派工字段**。`reason` 在**出口**被丢掉，服务端看到的就是"没传"。 |
| 证据链（实测） | ① `src/client/ticket-actions.tsx` 用 `isDispatch` 这个布尔把「派工」与「改派」混在一起，改派因此走了 `buildDispatchPayload()`；<br>② `src/shared/service-mode.ts` 的 `buildDispatchPayload` 只遍历 `DISPATCH_FORM_FIELDS`（5 个字段，**不含 `reason`**）→ `reason` 在构造载荷时被剔除；<br>③ 服务端 `dispatchInputOf()` 读出 `reason=''` → 422 `MISSING_REASON`（**服务端行为一直是正确的**）；<br>④ 对照组（`verify-reassign-contract` A4）：用**与 UI 完全一致**的载荷（含 `reason`）+ `X-Request-Id` 打真实 `svc:reassign` ⇒ **200**，Visit #1 `SUPERSEDED` / #2 `ASSIGNED`；<br>⑤ A3：绕过客户端故意缺 `reason` ⇒ **仍 422**（证明修复不是靠放宽服务端）。 |
| 判定 | **阻塞 Phase 4**（走查第 4 步失败）。 |
| 修复 | `REASSIGN_FORM_FIELDS = [...DISPATCH_FORM_FIELDS, 'reason']` + `missingReassignFields()` + `buildReassignPayload()`；客户端由"一个布尔猜动作"改为**每个动作各自的 `PARAM_CONFIG`**（fields / validate / payloadOf）；新增 `scripts/verify-reassign-contract.mjs`（A1~A7 联机 + `--reverse` 反向验证）。 |
| 明确**不做**的事 | **不**把服务端 `reason` 改成可选、**不**删 `MISSING_REASON` 守卫 —— 那会把"客户端丢字段"的缺陷改造成"业务口径缺失"。 |
| 教训 | ① **「表单里有这个字段」≠「payload 里有这个字段」**：只要载荷是按白名单挑字段构造的，新增字段就必须**同时进白名单**；<br>② **动作 A 复用动作 B 的载荷构造器**是这类缺陷的结构性温床 —— 必须为每个动作**显式声明字段集**，并断言两者的**差集**（本轮的 A2b 就是这条守卫）；<br>③ 这类缺陷**只有"真的打一次接口"的断言**能发现：静态断言只要跟着实现写，就会一起漏；<br>④ 反向验证不可省（铁律 8）：用**修复前**的构造器打同一接口，断言它**确实变红且无副作用**。 |

---

## DEV-71 「预计上门时间」是分钟级**伪精度** → 收敛为「预计上门日期」

| 项 | 内容 |
|---|---|
| 现象/动机 | UI 要求门店把预约时间选到分钟，但本项目**不采集**师傅签到 / 到达 / GPS / 精细排程 —— 那个时分**既无人履约、也无从校验**，而页面上的"09:37"会被读成"师傅 9 点半到"。这是**用精度伪装确定性**。 |
| 结论 | 派工与改约 UI 一律改为**日期选择器**（`<Input type="date" />`），字段与文案改「**预计上门日期**」；**DB 不迁移**（`expected_visit_at` 仍是 `datetime`），落库统一归一到**当天 12:00（+08:00）**。 |
| 三条纪律（缺一不可） | ① **UI 不得显示**那个固定时刻；② `TicketEvent` / 短信**不得**把它描述成真实预约时刻；③ SLA **不得**拿它当真实到达时间（逾期口径留 **Phase 9** 重新裁决）。 |
| 实现 | `APPOINTMENT_CANONICAL_TIME='12:00:00'` / `APPOINTMENT_TIMEZONE_OFFSET='+08:00'`；**出口** `normalizeAppointmentDate()`（UI 提交前）；**入口** `parseAppointmentDate()` / `canonicalizeAppointmentDate()`（服务端兜底 —— curl / 脚本 / 旧产物会绕过客户端）；面向用户的 `formatVisitDate()` 只到天。 |
| 断言 | A6a UI `YYYY-MM-DD` ⇒ 当天 12:00；A6b 落库确为 12:00 **且事件文案 0 处泄露时分**；A6c 短信模板的 `expected:` 取值点**全部**经 `formatVisitDate()`（源码口径）；A6d 直接传带时分的值 ⇒ 仍归一。 |
| ⚠️ 为什么统一到 **12:00** 而不是 00:00 | 00:00 离日期边界太近，**时区或日期解析上的任何一次误读都会串到前一天**；12:00 离两端都远，跨时区误读也不会串天。 |
| ⚠️ 为什么用**固定偏移**而不是进程时区 | 服务端容器的 `TZ` 与业务时区不是一回事；依赖进程 TZ 会让"同一天"在换环境后落成另一个时刻 —— 那才是最难查的一类漂移。 |
| 可逆 | ✅ 可逆（若 Phase 9 真要做精确排程，恢复时间选择器并移除规范化即可；DB 字段本来就是 datetime） |

---

## DEV-72 H3 详情抽屉请求路径多带一层 `/api` → 实际打 `/api/api/svc:timeline` → 404（**只有真实渲染能发现**）

| 项 | 内容 |
|---|---|
| 现象 | 详情抽屉点开**永远"加载失败"**，而**所有** HTTP 断言、结构断言、契约断言**全绿**。 |
| 根因 | 抽屉里写的是 `request('/api/svc:timeline?…')`，而注入的 `request` 最终走 `app.apiClient.request()` —— **它会自己补 `/api` 前缀**。于是真实请求是 **`/api/api/svc:timeline`** → 404 `api resource does not exist`（`docker logs svc-app` 实测出现 **6 次**）。 |
| 为什么长期没被任何断言发现 | 没有任何断言检查**浏览器真正发出的 URL**。smoke 的 `svc:visits` 打的是正确路径 `/api/svc:visits`，于是结论是"接口没问题" —— 而缺陷在**客户端自己拼错了**。**"接口对"与"调用方拼对"是两件事。** |
| 修复 | 抽屉请求路径改为**不带前缀**的相对名（`svc:timeline` / `svc:visits`）；新增**离线断言**「详情抽屉请求路径不带 `/api` 前缀」，并在 `uat-preflight.mjs` 增加 **§3.7 H3 抽屉真实渲染闸门**。 |
| ⚠️ 该断言的实现细节 | 扫源码前**必须先剥注释**（`readClientSource()` 去掉 `/* */` 与 `//`）：抽屉源码里为解释本坑写了**含 `/api/` 的注释**，直接 grep 会**假红**。这是铁律 2"会误报的检查比没检查更糟"的又一实例。 |
| 教训 | ① **HTTP 层断言全绿 ≠ 浏览器里真的对**；② 呈现层探针（无头浏览器 `renderProbe`）不是锦上添花 —— 它是唯一能发现"客户端自己拼错/自己解析错"的一层（与 DEV-65/66/67 同一族）；③ 写客户端请求时，**先确认 `request` 是不是已经带了 baseURL**。 |

---

## DEV-73 `smoke-test` 中唯一覆盖 `svc:visits` 的断言，在标准入口里**被跳过却算作通过**

| 项 | 内容 |
|---|---|
| 现象 | 标准入口 `uat-reset-baseline.mjs` 汇总写「smoke-test **全部通过：117 项**」，但其中 **1 项实际是跳过**（`库中 Visit=0`，走查洁净基线），**并未验证**。同一脚本单独跑（不带 `SMOKE_ALLOW_NO_VISITS=1`）则报 116 通过 / 1 失败。 |
| 根因（两个独立的错，各负其责） | ① **汇总是假绿**：`check()` 把**任何不抛异常的返回**都算 `passed++`，于是 `return '⚠️ 已跳过…'` 被计成"通过" —— 正是用户明令禁止的"用总闸全绿掩盖缺失"；<br>② **断言成立与否取决于别处的残留数据**：该断言要求"库里恰好有一条 Visit"，而洁净基线把 Visit 清成 0。标准入口里它之所以曾"通过"，是因为跑在它前面的某次操作留下了残留 Visit —— 这不是假红，是**偶然绿**（铁律 20 的镜像形态）。 |
| 修复 | ① 引入 `SkipCheck` 哨兵 + `skipped` 计数：跳过**单独打印、不计入"通过"**，汇总写成「全部通过：116 项 **· 跳过 1 项**」，编排器的摘取正则同步保留该后缀；输出并明写"（跳过项不计入通过，也不代表已验证）"。<br>② 把同主题断言搬到 `scripts/verify-reassign-contract.mjs` 的 **A7** —— 该脚本**自带 Visit 夹具**（临时工单的 #1 `SUPERSEDED` / #2 `ASSIGNED`），判据与夹具同生命周期，**不再依赖残留数据**，于是覆盖没有丢。 |
| 实测到的附带坑 | Visit 的**状态列名是 `visit_status`，不是 `status`**（Phase 4-A 起它才是生命周期唯一事实来源，老的 `status` 已降级为派生字段）。A7 第一版按 `status` 判 → 拿到 `undefined` → 报出"读不到 SUPERSEDED 的历史 Visit："（后面空空如也），看起来像业务缺失，其实是**断言自己用错了键名**。 |
| 教训 | ① **"跳过"必须与"通过"分开计数**，否则所谓"全绿"是假的；<br>② 断言的前置条件若由**别处残留**满足，就是"偶然绿"—— 判据要挂到**自带夹具**的脚本上，而不是"碰巧有数据"的那一个；<br>③ 要断言某个字段，**先确认它真的是接口返回的那个键名**（与 DEV-69 的"判据要选客户端真正消费的字段"同源）。 |

---

- ✅ 不擅自增加状态（严格 6 个）
- ✅ 不增加角色（除文档已标注可选的 viewer）
- ✅ 不接入 ERP / 库存 / 商品 / SN / 财务 / 在线支付
- ✅ 不依赖 NocoBase Professional / Enterprise 插件
- ✅ 不使用自增 ID 作为匿名访问凭证
- ✅ 短信"调用成功"不等于"送达成功"
