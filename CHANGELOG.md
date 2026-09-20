# CHANGELOG

本项目所有重要变更记录于此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### Phase 0 — 需求核对与技术确认（2026-09-20）

**Added**
- 项目骨架目录：`nocobase/plugins/service-ticket/`、`h5/`、`nginx/`、`docs/`、`scripts/`、`tests/`、`backups/`
- `docs/PHASE-0.md` — 需求理解、系统架构、NocoBase 能力矩阵、自定义开发清单、目录结构、状态机、API 清单、安全设计、阻塞问题核查、开发计划
- `docs/DATA-MODEL.md` — 11 张表字段级定义（`stores` / `storeUsers` / `serviceTickets` / `serviceVisits` / `serviceVisitPhotos` / `ticketEvents` / `smsLogs` / `dailySequences` / `apiGuards` / `idempotencyRecords` / `systemSettings`）、ER 关系、索引与约束核查清单
- `docs/STATE-MACHINE.md` — 6 个主状态、15 条合法迁移、并发与幂等机制、Token 生命周期、SLA 定时任务
- `docs/API.md` — 8 个匿名接口 + 19 个内部接口、统一错误码、角色动作矩阵、12 项报表口径
- `docs/SECURITY.md` — 威胁模型对应对策表、双层数据隔离、Token 规范、文件安全、部署安全基线、与需求文档「禁止事项」逐条对照
- `docs/DEVIATIONS.md` — 与需求文档的偏差与决策记录（9 条）
- `docs/DEV-PLAN.md` — Phase 1–10 计划、每阶段验收门槛、26 项测试清单、工程约定
- `ASSUMPTIONS.md` — 默认值登记簿（架构 4 项 / 业务参数 18 项 / 技术细节 22 项 / 部署 6 项 / 上线依赖 6 项 / 待实测技术点 5 项）
- `README.md` — 项目说明、文档索引、目录结构、快速开始、部署要求
- `CHANGELOG.md` — 本文件

**Decisions**
- 锁定 **NocoBase Community v2.1.x**（Apache-2.0，不使用 v3 alpha，不依赖 Pro/Ent）
- 不新建独立 Node.js Service，全部后端扩展收敛到单一插件
- 客户报修页采用独立 Vue3 H5（Public Form 无法满足幂等/限流/防重）
- 照片私有存储 + 受控读取端点 + 短时签名 URL，杜绝永久公开 URL
- 工单状态写入唯一入口为插件 Service，且带乐观并发

**Verified（技术前提，2026-09-20 核对）**
- NocoBase 插件支持 `defineCollection()` / `extendCollection()` 声明数据表
- 支持 `this.app.resourceManager.define()` 注册自定义 API
- 支持 `this.app.acl.allow()` 与四级中间件（数据源 / 资源 / 权限 / 应用）
- File Collection（file manager）支持服务端上传；标准 HTTP API 需登录 JWT → 匿名上传必须由插件服务端代理（与需求文档 §21.8 结论一致）
- 内置存储引擎（local/S3/OSS/COS）产出**永久可访问 URL** → 私有化必须自建受控读取（T-03 降级路径已设计）

**Not Started**
- Phase 1：Dockerfile / docker-compose / .env.example / Nginx / 插件空壳 / README 运维章节

---

### Phase 1 — 项目初始化与可启动（2026-09-20）

**Added**
- `docker-compose.yml` — 三容器编排：`postgres:16`（`wal_level=logical`、healthcheck）+ `app`（`nocobase/nocobase:2.2.15-full-no-nginx`，仅回环暴露调试口）+ `nginx:1.27-alpine`（唯一公网入口）；`depends_on: service_healthy` 保证启动时序；全量日志轮转
- `nginx/nginx.conf` — `rt=`/`urt=` 日志格式、三档 `limit_req_zone`（public 30r/m、upload 60r/m、general 300r/m）+ `limit_conn`、`limit_*_status 429`、gzip、`server_tokens off`、`map` 定义 `$connection_upgrade` 与 `$svc_forwarded_proto`
- `nginx/conf.d/service.conf` — 12 个 location：`/healthz`、`/h5/`（SPA 回退 + `no-store` + `X-Robots-Tag`）、`/api/svc:health` 与 `/api/svc/health`、`/api/public/`、`/api/technician/`、`/api/callbacks/`、`/files/`、`/storage/uploads/`、`/ws`、`/static/plugins/`、通用入口（`proxy_buffering off`）、`@too_many` JSON 429
- `.env.example` — 9 段共 63 个变量；含插件加载机制说明、11 项参数种子、`PLUGIN_PACKAGE_PREFIX` 白名单、双口令一致性约束
- 插件骨架 19 文件 / 1907 行 TS：`plugin.ts`（注册表 + action + ACL + 种子）、`constants.ts`（枚举 + 6 状态迁移表 + `ANONYMOUS_ACTIONS` + 16 项 `DEFAULT_SETTINGS`）、`actions/public/health.ts`（健康检查 + 表缺失降级 + 敏感信息过滤）、11 张 collection + `_helpers.ts` 字段构造器 + `_options.ts` 下拉选项 + `collections/index.ts` 双清单
- `scripts/build-plugin.mjs` — esbuild 编译（external 照搬 NocoBase EXTERNAL 清单）+ 预检 + 产物自检
- `scripts/gen-secret.mjs` — 从 `.env.example` 生成带随机密钥的 `.env`（拒绝采样无取模偏置；强制 `DB_PASSWORD` ≡ `POSTGRES_PASSWORD`；`.`env` 存在则拒绝覆盖）
- `scripts/verify-config.mjs` — 41 项离线部署层断言（compose 结构/安全基线、nginx 静态 lint、`.env`×常量交叉一致性、目录完整性）
- `scripts/verify-plugin-load.mjs` — 24 项离线插件生命周期断言（包解析/`__esModule→default`/`load()` 注册 11 表/health 200 与降级/`install()` 种子/热重载幂等）
- `h5/dist/index.html` — H5 部署占位页（bind mount 宿主目录必须存在于仓库）
- `README.md` — 新增「快速开始」+「Phase 1 运维手册」7 小节
- `docs/PHASE-1.md` — Phase 1 交付报告（§27 十段格式）

**Decisions**
- 镜像锁定 **`nocobase/nocobase:2.2.15-full-no-nginx`**（比 Phase 0 记录的 v2.1.x 提前小版本；已核实 tag 存在、602 MB、amd64+arm64）。选 `-no-nginx` 变体以匹配「nginx 独立容器」架构，避免双重代理
- 插件分发形态：**宿主机 esbuild 预编译 + 双通道挂载**（`storage/plugins` 扫描发现 + `node_modules/@local` 包名解析），容器内零构建依赖（DEV-12）
- 不写 `Dockerfile`：官方镜像 + 挂载已满足需求，自建镜像只会增加维护面
- 不写手工 migration SQL：表结构由 `db.sync()` 从 TypeScript 定义同步，避免双重维护漂移
- 验收口径以 `DATA-MODEL.md` 为准（**11 张表**，非 DEV-PLAN 的 9 张，见 DEV-11）
- 健康检查同时支持 `/api/svc:health`（原生）与 `/api/svc/health`（验收写法）（DEV-10）

**Verified（离线验证，2026-09-20）**
- `docker compose config --quiet` 退出码 0（63 变量全量展开后语法有效）
- `node scripts/build-plugin.mjs` → 18 源文件编译成功，产物 51.2 KB，自检通过
- `node scripts/verify-config.mjs` → **41/41 通过**
- `node scripts/verify-plugin-load.mjs` → **24/24 通过**；实测 `{"db":"ok","sms":"mock","tasks":"ok"}` @ HTTP 200
- 已实际生成 `.env`（`APP_KEY`/`DB_PASSWORD`/`SIGN_SECRET`/`MOCK_SMS_CALLBACK_SECRET`/`BACKUP_PASSPHRASE`）

**Not Verified（需在有 Docker daemon 的机器上确认）**
- `docker compose up -d` 真实拉起三容器
- 官方镜像入口脚本「首次自动 `nocobase install`」行为（若未自动执行，fallback 命令已写入 README）

**Not Started**
- Phase 2：ACL 角色与字段权限、`storeScope` 中间件、`PermissionService`、种子数据、`TicketService`/`SequenceService`/`EventService`/`ConfigService`、后台工单页面

---

### Phase 1.1 — 真机启动验收（2026-09-20）

> Phase 1 的离线验证全绿后，在交付机（Windows + Docker Desktop，WSL2 后端）真实拉起三容器，
> 完成端到端验收，并发现修复了一个**离线与桩环境完全无法暴露**的框架级缺陷。
> 完整证据与复现命令见 `docs/VERIFY-PHASE-1.md`。

**Verified（真机，2026-09-20）**
- `docker compose up -d` 三容器全部 `Up (healthy)`（`postgres:16` / `nocobase:2.2.15-full-no-nginx` / `nginx:1.27-alpine`）
- `node scripts/smoke-test.mjs` → **55/55 通过**（新增的真机端到端验收脚本）
- `curl http://localhost:8080/api/svc/health` → `{"data":{"db":"ok","sms":"mock","tasks":"ok",…}}` @ HTTP 200；冒号与斜杠两种写法均 200
- 11 张业务表全部建出；`service_settings` 16 行参数种子；**35 条 collection 级索引 + 4 条字段级唯一全部落库**
- `node scripts/verify-config.mjs` → 41/41；`node scripts/verify-plugin-load.mjs` → **31/31**（新增 2 项索引声明守卫）

**Fixed（真机暴露的缺陷）**
- **collection 级索引被 NocoBase 静默丢弃**（DEV-16）：`collection.refreshIndexes()` 会把「列尚未注册到 model」的索引整条丢弃，不报错不告警。实测**每次启动稳定丢弃 1 条** —— `service_visit_photos(file_id)` 的 **UNIQUE 索引**，导致「同一文件不得重复挂到两次上门」的约束实际失效。已抓取真实 DDL（框架**从未**下发该 `CREATE INDEX`）并做「摘掉兜底即变红」的反证。修复：新增 `src/server/ensure-indexes.ts`，在 `afterLoad` 之后按「列集合 + 唯一性」语义等价核对补齐（只增不删、幂等、失败抛错阻断启动）
- **强制 `underscored: true`**（DEV-14）：NocoBase 默认 false 会把表名/时间戳列建成驼峰，与文档、验收 SQL、`EXPECTED_TABLE_NAMES` 全面对不上；索引里写 `created_at` 会报 `42703 undefined_column` 并导致启动失败
- **配置集合改名 `systemSettings` → `serviceSettings`**（DEV-15）：原名字与 NocoBase 核心集合冲突，会被 `hasCollection()` 判「已存在」而**静默跳过注册**，参数种子一条都种不进去
- **清理 4 组重复同义唯一索引**（DEV-17）：`ticket_no` / `access_token_hash` / `seq_key` / `key` 每列上同时存在字段级 UNIQUE CONSTRAINT 与 collection 级 UNIQUE INDEX，删冗余声明并 `DROP INDEX`

**Added**
- `src/server/ensure-indexes.ts` — 索引兜底补齐模块（DEV-16 修复产物）
- `scripts/expected-indexes.mjs` — 索引验收**单一事实来源**（按表列出 `{columns, unique, from}`），离线、真机、文档三方共用
- `scripts/smoke-test.mjs` — **55 项真机端到端验收**（容器状态 / nginx 路由与安全头 / 表与索引逐条落库核对 / 参数种子 / 运行时稳定性）
- `docs/VERIFY-PHASE-1.md` — 真机启动验收报告（原始证据 / 根因链 / 反证 / 复现命令 / 遗留限制更新）
- `verify-plugin-load.mjs` 新增 2 项索引声明守卫（双向：清单要求但未声明 / 已声明但清单未登记），均做过反向注入验证
- `smoke-test.mjs` 新增 11 + 1 项索引守卫（逐表逐条"声明式索引全部落库" + "无重复同义索引"）

**Changed**
- `docs/DEVIATIONS.md` — 新增 DEV-14 ~ DEV-17
- `docs/DATA-MODEL.md` — §11 集合名改为 `serviceSettings`；§13 补 §13.1「T-01 关闭结论」与 §13.2「索引验收单一事实来源」
- `docs/PHASE-1.md` — 结论段改为真机通过；测试方法 T 表补 T5（真机 55 项）；`当前完成情况` / `已知限制` / `本阶段踩过并已修复的坑` 全部按真机结果回填

**Not Verified（仍然）**
- HTTPS（待 Phase 10 证书就绪；微信内置浏览器要求 HTTPS，上线前必须完成）
- 真实短信通道（`SMS_PROVIDER=aliyun` 适配器在 Phase 4/8）
- H5 真实应用（Phase 3）


### Phase 2 — 数据模型 / 权限 / 工单底座（2026-09-20）

**Added**
- `src/server/services/` 五个服务：`PermissionService`（对象级鉴权 + 门店数据范围 + 脱敏）、`TicketService`（状态唯一写入口，乐观并发）、`EventService`（`ticketEvents` 唯一写入口）、`SequenceService`（原子取号）、`ConfigService`（`serviceSettings` 唯一读入口，短 TTL 缓存）
- `src/server/middleware/store-scope.ts` — 原生接口的**框架层**门店隔离（与对象级判定构成双层隔离）
- `src/server/actions/svc/ticket.ts` + `_http.ts` — 4 个内部业务 action（accept / transfer / cancel / timeline）与统一错误信封、`X-Request-Id`
- `src/server/seeds/{settings,stores,roles,apply}.ts` — 参数（16 项）、门店（15 家**占位**）、角色与**资源级授权**种子；一律"只增不改"
- `src/server/migrations/20260920-role-resource-grants.ts` — 给**已安装实例**补资源级授权（迁移跑过不重跑，故真正的自愈另挂 `afterLoad`）
- `docs/PHASE-2.md` — 本阶段交付报告（验收证据 / 缺陷根因 / 已知缺口 / 待确认输入 / 复跑命令）
- `scripts/smoke-test.mjs` §4b — **8 项 Phase 2 真机验收**（资源授权齐全 / 字段白名单安全 / 属性名正确 / AT-03 list 本店 / AT-03 get 他店 404 / 白名单无敏感列 / 并发 accept 409 / 事件必写）
- `verify-plugin-load.mjs` 新增 2 项守卫：字段白名单**名字来源**（不得含数字索引、必须含 `store_id`/`createdAt`、不得含关联名）、**取不到字段目录必须抛错绝不退化成整行下发**；另加「对外拒绝类错误的 `logLevel` 必须是框架认识的级别且不为 `error`」

**Fixed（真机暴露的缺陷，全部属"不报错但不生效"型）**
- **DEV-23 · 真实凭证泄露**：`viewer` 角色 8 条 action 行的 `fields` 是 `null`，实测 `GET /api/serviceTickets:list` 返回 **36 个键**，含 `feedback_token_hash` / `_expires_at` / `_used_at` —— 评价 Token 的哈希被整行下发。根因是 NocoBase 的字段白名单有三态（`null`＝整行下发、`[]`＝空壳、数组＝白名单），而 `null` 不触发 `mergeActionParams` 的 `'intersect'` 特例。修复：`repairUnsafeActionFields()` 把 `null`/`[]` 一律纠正为白名单（**运营自定义的非空白名单绝不覆盖**），并补建"有资源行但缺 action 行"（缺行＝该 action 恒 403）
- **DEV-23 · 白名单取错了字段目录**：`collection.getFields()` 在真机返回**数组**（`return [...this.fields.values()]`），`Object.keys()` 取到的是 `["0","1",…,"32"]` 数字索引垃圾白名单；且因数量恰好也是 33 而与正确结果"看起来一致"。改用 `collection.model.rawAttributes` 的键（ORM 属性名：含 `id`/`store_id`/驼峰时间戳，不含关联名）；离线桩已同步按真机形状重写并加"数字索引"哨兵
- **DEV-23 · 后台每张表 403**：只写了 `strategy.actions`（一级）而没写**资源级授权**（二级），任何资源都匹配不到授权条目。修复：`seeds/roles.ts` 双表同写；`/api/svc:health` 新增 `rolesInAcl` / `rolesResourcesInAcl` 两个计数器，使该状态可被一眼看出
- **DEV-20 · 越权 404 把 app 日志打成 error**：`@nocobase/plugin-error-handler` 按 `err.logLevel` 决定级别，不设则一律 `error`，于是"越权 get 他店 → 404"（文档明文要求）产生 `{"level":"error","message":"工单 10 不存在"}`，把「app 日志无 error」这条运维断言打成噪声。修复：`NotFoundError.logLevel='debug'`（与 action 层"404 不记日志"口径一致）、`ForbiddenError.logLevel='warn'`；安全线索仍由 `[permission] 越权访问被拒…`（warn）与请求日志（4xx→warn）保留
- **DEV-18 · 文档里的接口路径不可达**：NocoBase 的 `parseRequest` 对 `/api/<a>:<b>:<c>` 只 `split(':')` 一次，第三段被静默丢弃 → 多段 action 名**根本不存在**。恢复：action 名单段化 + nginx 重写折叠（对外路径 `/api/svc/tickets/:id/<action>` 保持不变）
- **DEV-19 / DEV-22 · 原生接口写操作面过大**：资源级 ACL 无法表达"只能改某些字段"，用 `fields` 表达会 fail-open。收敛为角色只授予 `list`/`get`，`create` 由中间件直接拒绝
- **两条校验脚本的误报**（误报会让红灯失去意义）：`verify-config.mjs` 原按"行"判定 nginx 指令结尾，把跨行 `rewrite` 误报为漏分号；原变量检查不认**具名捕获** `(?<svc_action>…)` 与 `$arg_*` 家族。现按"语句"判定 + 认具名捕获与前缀家族
- **`smoke-test.mjs` 两条断言失真**：①"app 日志无 error"用整行正则扫 `\berror\b`，而框架 4xx 日志**必然**含 `"method":"error-handler"` → 任何 4xx 都误报；改为解析 JSON 行只认 `level === 'error'`。②"参数种子写入日志：新增 16 项"只在 `install()`/`afterEnable()` 打，容器一旦重建该行永不出现（`docker restart` 保留旧日志能长期"蒙"过断言）；改为"有日志则断言 `created + skipped === 16`，无日志则由数据库 16 行兜底"
- `docker()` 调用补充 `maxBuffer: 64MB`：app 日志涨到 1.2MB 后超过 Node `execFileSync` 默认 1MB 上限，抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，导致 3 条依赖 `docker logs` 的断言误报

**Changed**
- `docker-compose.yml` — app 服务新增 `LOGGER_LEVEL: ${LOGGER_LEVEL:-info}`，需要复现越权请求完整链路时可临时 `LOGGER_LEVEL=debug docker compose up -d app`
- `verify-config.mjs` → **41/41**；`verify-plugin-load.mjs` → **53/53**；`smoke-test.mjs` → **63/63**（Phase 1 期间分别为 41/31/55）
- `docs/DEVIATIONS.md` — 新增 **DEV-18 ~ DEV-23**
- `docs/DEV-PLAN.md` — Phase 2 补「状态」段（含"并发 100 次取号未完成"的诚实说明）
- `README.md` — 文档索引补 `docs/PHASE-2.md`；三套校验项数更新

**Not Verified（仍然）**
- **并发 100 次取号无重复无空洞** —— 唯一触发取号的入口是"创建工单"（Phase 3），本阶段无对外接口可发起并发，故意不造假绿灯，留到 Phase 3 压测
- 后台业务页面（工单列表 / 详情 / 时间线区块）未做；`storeUsers` 用户映射种子未落（待账号清单）
- `tasks/`（SLA 巡检）与 `sms/`（短信适配器）目录为空，属 Phase 4/7
- HTTPS、真实短信通道、H5 真实应用（同 Phase 1）


### Phase 2.1 — 验收整改（2026-09-20）

> **触发**：独立验收给出结论 **Phase 0 = PASS / Phase 1 = PASS WITH DEVIATIONS / Phase 2 = HOLD**，
> 并下达 8 项强制整改。本条目对应 `docs/PHASE-2.md` §7。
>
> **状态口径变更（重要）**：Phase 2 由「✅ 已完成」改为 **⏸ 功能开发基本完成，正式验收挂起（HOLD）**，
> 挂起期间 `README.md` / `CHANGELOG.md` / `docs/DEV-PLAN.md` / `docs/PHASE-2.md` **一律不得写 PASS**。

**Fixed（整改项 4：viewer 探针残留与授权一致性）**
- **DEV-24 · 字段白名单"漂移即对齐"**：原口径是"非空数组一律不碰"，导致探针留下的 7 列白名单被永久保留。改为以代码里的 `nativeReadFieldsOf()` 为**单一事实来源**，漂移即对齐；逃生开关 `SVC_ACL_FIELDS_AUTOFIX=0` 只对"运营自定义的非空白名单"生效，`null`（整行下发）与 `[]`（空壳）**永远纠正**
- **DEV-24 · 假漂移（"狼来了"）**：NocoBase 会对 `list` 动作的 `fields` **重排顺序**，逐位比较于是每次启动都判定 16 行漂移并刷 16 条 warn —— 它会把真正的漂移（33 列被改成 7 列）淹掉。`sameFieldList()` 改为 `sameFieldSet()`（**集合语义**，忽略顺序与重复）
- **DEV-27 · 无主资源授权行（根因取证）**：真机发现 11 条 `roleName` 为 `NULL` 的授权行。受控实验证明 `POST /api/roles:update` 携带 `resources` 载荷会走**关联替换**语义，把旧行 `UPDATE … SET roleName = NULL` 脱钩（一次调用 +4 行），而库里没有 `roleName` 外键约束 → 旧行永久留成无主行。修复：新增 `removeOrphanResourceRows()`（先删子表 action 行再删父行，只删 `roleName` 空行，自定义角色一律不碰），并在 `plugin.ts` / 迁移 / 日志中登记 `orphansRemoved`
- **`.probe/fields-semantics.mjs` 加硬门闩**：破坏性探针必须显式 `SVC_PROBE_ALLOW_DESTRUCTIVE=1` 才执行，防止再次污染真库
- 真机结果：**0 条无主行 / 恰好 16 条资源授权 / 32 条 action 行 / 4 张表各只有 1 种白名单**，且**重启后自愈日志为 0 条**（真幂等）

**Added**
- **DEV-25 · NocoBase 版本正式冻结**：`scripts/expected-versions.mjs` 作为版本 pin 的**单一事实来源**（`2.2.15-full-no-nginx`），离线与真机三侧断言
- **DEV-26 · Dockerfile 偏差登记**：生产部署不得依赖开发目录 bind mount；Phase 10 须重新评估不可变生产镜像（`docs/DEV-PLAN.md` §Phase 10 已加"生产发布形态评审"强制条款，**未完成，不得视为已解决**）
- `scripts/verify-concurrency-phase2.mjs` — 100 路真实并发取号验收脚本（**Phase 2 挂起项的唯一解除手段**）。8 条断言：无 5xx / 恰好 100 张 / 单号唯一 / 序号连续无空洞 / 无唯一约束冲突 / 事件条数正确 / 重复 `request_id` 不消耗序号 / 幂等不产生新单号。**依赖 Phase 3 的 `POST /api/public/tickets`**，接口未就绪时**退出码 2（环境未就绪）**而不是红灯；已实测确认该行为
- `scripts/verify-plugin-load.mjs` 新增 3 项断言：无主资源授权行会被清理且不误删正常角色行、清理后 32 条 action 白名单与期望**同集合**；`matchFilter` 补 `IS NULL` 语义、仓库桩补 `destroy()`、`idSeq` 改为扫描预置行避免撞号（桩失真修复）
- `scripts/smoke-test.mjs` 新增 1 项真机断言：**授权表与代码期望逐行一致**（0 条无主行 / 恰好 16 条授权 / 32 条 action / 每张表白名单唯一）
- `scripts/verify-config.mjs` 必需文件清单 27 → **31** 项：补 `expected-indexes.mjs`、`expected-versions.mjs`、`verify-concurrency-phase2.mjs`、`docs/PHASE-2.md`。理由：挂起项的解除手段必须被**存在性断言**盯住，"写过又被删掉"在文档里看不出来
- `docs/DEV-PLAN.md` 新增 §「Phase 2 已确认不重构的设计（11 项）」、§Phase 3 交付顺序 A→I、§Phase 4 的「后台页面不得再延期 + 必须真实售后人员 UI 走查」条款、§Phase 10 的「生产发布形态评审」条款

**Fixed（测试工具互相污染 —— 红灯指向了错误的对象）**
- `verify-concurrency-phase2.mjs` 原用「直接 `POST` 一次」探测接口是否存在。Phase 3 未实现时该请求必然 404，而 NocoBase 会写一条 `[Error: public resource does not exist`（**level=error**）—— 恰好落进 `smoke-test.mjs`「最近窗口内 app 日志无 error」的区间，于是**跑一次并发脚本 → 冒烟出现一条与取号毫无关系的红灯**（真机复现：`63 项通过 / 1 项失败`）。
  改为**先静态、后联网**：零副作用的静态就绪门（源码 public action 目录 + 编译产物**去注释后**含接口标记），未就位则一个 HTTP 请求都不发、退出码 2。
  真机验证：脚本退出码 2；`docker logs svc-app` 行数 **1936 → 1936（完全不变）**；随后冒烟 **64/64**。
- 同处的隐性缺陷：产物侧检查若**不去注释**，`constants.ts` 里注释掉的 `publicTicket` 规划示例会让它在接口一行都没实现时恒为真 —— 门闩形同虚设。已加 `stripComments()`。

**Changed**
- `docs/PHASE-2.md` — 顶部改挂 HOLD 状态横幅；§1 验收门槛结论拆成"达标项 / 挂起项"；§5.1 后台页面加交付期约束；§5.3 由"探针残留"改为"已解决"；§6 复跑命令更新为 43 / 56 / 64；新增 §7 整改 8 项状态表 + §7.1 真机证据 + §7.2 并发脚本 8 条断言契约；§9 结论改"挂起"
- `README.md` — Phase 2 状态行改 HOLD；三套校验项数更新为 **43 / 56 / 64**；脚本表补 `expected-versions.mjs` 与 `verify-concurrency-phase2.mjs`；快速开始补并发验收步骤（含 IP 频控阈值需临时调高的说明）
- `docs/DEV-PLAN.md` — 进度总览 Phase 2 改 **⏸ HOLD** 并加口径说明；Phase 2 节状态段重写
- `verify-config.mjs` → **43/43**；`verify-plugin-load.mjs` → **56/56**；`smoke-test.mjs` → **64/64**（合计 **163 项**）

**Not Started（本次整改未完成的 1 项）**
- **整改项 2 的"跑通"部分**：`scripts/verify-concurrency-phase2.mjs` 已就位并通过语法/退出码自检，但 `POST /api/public/tickets` 属 Phase 3 —— 因此 **Phase 2 仍为 HOLD**，不得补签 PASS


