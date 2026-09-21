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

---

### Phase 2.2 — 源码归档与 `.gitignore` 安全修补（2026-09-20）

**Added**
- 项目源码归档至 GitHub：`https://github.com/wetank9s-lab/-`（`main` 分支，首次提交 62 文件 / 19649 行）
  - ⚠️ 该仓库**已于 2026-09-21 更名为 `https://github.com/wetank9s-lab/qifang-AfterSales`**
    （旧地址仍会重定向，但不要在脚本/CI 里继续引用旧名）。本次更名后的归档见
    下方「Phase 3 收尾 · 归档」段

**Fixed（安全：`.gitignore` 漏洞会让 NocoBase 主密钥推上远端）**
- **`storage/apps/main/aes_key.dat`（AES 主密钥，32 字节）原本会被提交。**
  它是 NocoBase 用于加密库内敏感字段的主密钥，**不出现在 `.env` 中** ——
  因此"用 `.env` 的真实值去反查待提交文件"这种密钥扫描**查不出它**，
  而原 `.gitignore` 也没有任何规则能匹配它。任何同时拿到该文件与一份数据库备份的人都能解开加密列。
  新增忽略：`storage/apps/`、`storage/.license/`（实例签名）、`storage/nocobase.conf`
  （NocoBase 自动生成的 nginx 片段，与本项目自己的 `nginx/` 无关）、
  `storage/plugins/`（`build-plugin.mjs` 的产物，可重建）、`storage/logs/`
- `.workbuddy/`（AI 工作记录：内部验收口径、排障过程、决策讨论）与 `.probe/`
  （破坏性排障探针，门闩 `SVC_PROBE_ALLOW_DESTRUCTIVE=1`）不再入库。
  探针的取证结论已完整落在 `docs/DEVIATIONS.md`（DEV-27），
  分发探针反而有风险 —— 别人 clone 后误设环境变量会破坏他们自己的库

**教训（值得单独记住）**
- **密钥审计不能只查 `.env`。** 运行时生成的主密钥文件（`aes_key.dat`）与实例签名
  （`instance-id`）都不在 `.env` 里，却比 `.env` 更危险 —— 后者至少还被 `.gitignore` 明确忽略了。
  审计口径应是「**先把所有会入库的文件列出来，再逐个问它为什么该入库**」，
  而不是「拿 `.env` 的值去搜」。
- **文件一旦进入 Git 索引，`.gitignore` 就再也不对它生效。** 修补 `.gitignore` 后必须
  `git rm -r --cached . -f` 清空索引再重新 `git add`，否则新规则看似生效、实则被已跟踪状态绕过。
- 首次上传前的双重验证：远端 `git ls-remote` 的 HEAD 必须与本地 `git rev-parse HEAD` 一致；
  并从 `raw.githubusercontent.com` **拉回远端实际存储的文件内容**做密钥终审 ——
  只信本地审计与推送输出是不够的。

---

### Phase 3 — 客户 H5 报修（A→I 全部交付，2026-09-20）

**Added**
- `nocobase/plugins/service-ticket/src/server/services/guard-service.ts` — **GuardService**：四类守卫唯一实现
  （IP 分钟频控 / 手机号日频控 / 重复单识别 / `request_id` 幂等）。计数走单条
  `INSERT … ON CONFLICT (scene, scope, guard_key, window_start) DO UPDATE SET counter = counter + 1 RETURNING counter`；
  维度值一律 `sha256(值 + SIGN_SECRET)`（**绝不存明文 IP / 手机号**）；窗口起点由 **DB 的 `date_trunc(now())`** 计算，
  不掺应用时钟
- `nocobase/plugins/service-ticket/src/server/actions/public/store.ts` — `GET /api/public/stores`（仅 `code`/`name`，不含 id/电话/地址）
- `nocobase/plugins/service-ticket/src/server/actions/public/ticket.ts` — `POST /api/public/tickets`：守卫链 **① X-Request-Id(422) → ② privacy_agreed(400) → ③ DTO 白名单(422) → ④ IP 频控(429) → ⑤ 幂等回放(200) → ⑥ 手机号频控(429) → ⑦ 重复单(409) → ⑧ 建单(201)**；响应**恰好 3 个字段**
- `nocobase/plugins/service-ticket/src/server/actions/svc/guard-quota.ts` — `GET /api/svc:guardQuota`（只读诊断，走 `peek()` 不计数；需 `X-Svc-Diag-Key`，见 DEV-28）
- `h5/` — 全新 Vue3 + Vite + TS 工程：`/report` 报修页、`/report/success`、隐私说明与勾选门槛、
  自研 minimal router、`api/http.ts`（错误信封 + `ApiError`）、`api/public.ts`（**single-flight**：连点 10 次只发 1 个 HTTP；`request_id` 仅在内容变化时重生成）、`utils/{uuid,validate,privacy}.ts`
- `nginx/conf.d/service.conf` — 匿名公开接口路由（`/api/public/stores` → `/api/publicStore:list`、`/api/public/tickets` → `/api/publicTicket:create`，见 DEV-30）+ `/h5/` 静态站点
- `scripts/verify-phase3-h5.mjs` — Phase 3-H 验收脚本（4 组 35 项，退出码 0/1/2）
- `docs/DEVIATIONS.md` — 新增 **DEV-28 ~ DEV-33**

**Fixed（产品缺陷）**
- **同 `request_id` 并发各取各号（DEV-32）** ——「连点/重试」场景下的真实缺陷：
  固定同一 `X-Request-Id` 并发 10 路，实测 `201×1 + 200×4 + **429×5**`，序号 `1 → 6`（**增量 5**）。
  根因是 ⑤「读幂等」**不产生任何行**：10 路都读到"没有"→ 全部继续 → ⑥ 各自消费手机号日额度（5 很快打满）、
  幸存者各自 `nextTicketNo()`（取号在事务外）、5 路同时写幂等记录只有 1 路成功且白耗 4 个号。
  **前端 single-flight 挡不住它**（弱网重试 / 多标签页 / 狂点刷新都会绕过）。
  修法：⑤~⑧ 放进按 `scene:request_id` 的**进程内串行锁**；**锁不含 ④（IP 频控）**是刻意的 ——
  重放仍要消耗 IP 配额，否则同一 request_id 可被无限重放且完全不计数（等于开一条免限流旁路）。
  复验：`201×1 + 200×9`、无 429、序号 `6→7`（增量 1）、幂等记录 1 条、`created` 事件 1 条

**Fixed（nginx / 交付物）**
- `/h5/assets/*.js` 返回 **301 + 丢失端口**导致白屏（DEV-29）：根因是「正则 `location` + 无捕获组的 `alias`」
  触发目录重定向。改为 `root /usr/share/nginx/html`（本项目 URI 与磁盘布局本来就同构）
- `h5/dist/index.html` 曾被 Git 跟踪：Vite 构建会把它覆盖成**引用带 hash 资源**的版本，
  一旦提交就是"引用不存在的 JS"的白屏。改为 `dist` 全量忽略、只跟踪 `dist/.gitkeep`，
  并补 `h5/public/.gitkeep`（Vite `publicDir` 会把它拷进 dist）
- `TICKET_SOURCE_VALUES` / `TICKET_TYPE_VALUES` 是字面量联合数组，`.includes(任意 string)` 被 TS 正确拒绝（TS2345）：
  改为 `ReadonlySet<string>` + `.has()`，同时把查找从 O(n) 降到 O(1)

**Fixed（验收脚本自身，**不是**产品缺陷）**
- `verify-concurrency-phase2.mjs` 首次真跑暴露两个脚本缺陷：
  ① **探测请求复用了 `mobiles[0]`** → 探测先建了一张单，随后并发批次里同号请求被**重复单规则正确地**拦成 409，
  断言 2/3/4 全红 —— 看起来极像"并发下有请求被吃掉"；改为给探测请求分配独立号段（`…998`）并断言三段互不相交。
  ② 断言 6 的 SQL 写了 `GROUP BY 1` → PG 报 `aggregate functions are not allowed in GROUP BY`
  （序号 GROUP BY 解析的是含 `count()` 的选择项）；改为 `GROUP BY t.ticket_no`
- `verify-concurrency-phase2.mjs` 补 `X-Svc-Diag-Key`（从 `.env` 读 `SIGN_SECRET`）：不带时 `guardQuota` **一律 404**，
  会把"我忘了带头"误读成"接口没实现"；现在脚本会在报错信息里区分这两种根因
- `verify-plugin-load.mjs` 断言更新为 6 个 svc action + 4 条匿名白名单（含新增的 `svc:guardQuota`），**57 项全绿**

**Changed（文档口径纠正）**
- `docs/PHASE-2.md` **§7.2 的升降配步骤原文是错的**（DEV-31）：它教人"改 `.env` 的
  `SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT` 再 `docker compose up -d app`"，实测**阈值纹丝不动** ——
  `seedSettings` 是「存在即跳过」，`.env` 只决定**首次**种进 `service_settings` 的值，之后运行期以**库里的行**为准。
  正确做法：直接 `UPDATE service_settings`（ConfigService 有 10s TTL，**无需重启**），
  且 nginx 还有**第二层**（`svc_public` 30r/m + `limit_conn svc_conn 96`）必须一起放宽、一起恢复
- `docs/DEV-PLAN.md` Phase 3-A 写的 `region` 字段不存在（DEV-33）：`stores` 表无该列，
  以 `docs/API.md` §1.1 为准只回 `code`/`name`

**Verified（2026-09-20 真机）**
- **Phase 2 补签 PASS**：`scripts/verify-concurrency-phase2.mjs` **8 条断言全绿、退出码 0** ——
  `RUN_ID=20260920T212007-bb89`，100 路 `201×100`（耗时 779ms）、
  `ticket_no FW20260920-0111…0210` 连续无空洞、`daily_sequences` `110 → 210`（增量恰 100）、
  无 23505、每张恰好 1 条 `created`、幂等重放序号增量 0。**全程未用 SQL 直连取号替代压测，
  也未为造绿灯而拆掉频控/幂等/唯一约束**；跑完后两层阈值均已恢复（实测 `guardQuota.limit = 30`，
  nginx 三处经 `git diff` 确认逐字还原）
- **Phase 3-H**：`scripts/verify-phase3-h5.mjs` **35 项全绿、退出码 0**
- 插件类型检查与基线逐字一致（仅剩 tsc 无法解析 `@nocobase` 基类导致的既有噪声，
  `actions/public/**` 零错误）

**Not Started**
- Phase 4 派工 / Visit / Token / 短信（含后台工单页面与真实售后人员 UI 走查）

### Phase 3 收尾 — 阶段内验收并入总闸（2026-09-21）

**Added**
- `scripts/smoke-test.mjs` §4c — **7 项 Phase 3 服务端契约验收**（走 nginx，不依赖前端构建）：
  门店列表只回 `code/name`（匿名接口最小披露，连 `id` 都不出）；
  建单 `201` 且响应体**恰好** `{ticket_no, store_name, created_at}`；
  同 `X-Request-Id` 重放 `200` + 同单号且工单总数不变、幂等记录恰 1 条；
  隐私未勾选一律 `400 PRIVACY_NOT_AGREED`（字段缺省 / 显式 `false` 两种形态）且不落库；
  缺 `X-Request-Id` → `422 VALIDATION_FAILED`（`detail.header` 指明缺哪个头）；
  窗口内同号同店同类型 → `409 DUPLICATE_TICKET` 且 `detail.ticket_no` 指向原单；
  **IP 分钟频控超限 → `429 RATE_LIMITED`**（`detail.scope=ip`、`detail.limit` 与库内阈值一致、带 `Retry-After`）。
  总闸由 64 项 → **71 项**。

**Fixed（验收脚本自身，均为"假红灯"而非产品缺陷）**
- `smoke-test.mjs` 的 H5 断言是**过时断言**：Phase 3 起 `/h5/` 已由真实 Vite 构建产物取代占位页，
  判据改为「SPA 挂载点 `<div id="app">` + 引用 `/h5/assets/*.js` 且该 JS 实取 200 且非空」
  （保留对 DEV-29 `alias` 坑的覆盖：只验 index.html 200 抓不到资源 301 丢端口）。
- `smoke-test.mjs` 的 AT-03 list 断言**假设了空门店**：S01 已是验收主战场（并发压测一轮就落 100 张，
  库内 208 张），`pageSize=100` 的默认第 1 页必然装不下新造的 `T_A` —— 一条随库龄漂移的假红灯。
  改为「不筛时第 1 页必须全属本店」+「定向 `filter={id:{$in:[T_A,T_B]}}` 结果只剩本店 `T_A`」，
  后者顺带验到 scope 是 `$and` **叠加**而非覆盖（请求里的 filter 挤不掉范围条件）。

**Changed**
- 429 断言**不连发打满真实阈值**，改「库里 `security.ip_minute_limit` 临时降到 2 + 3 个请求」并在
  `finally` 里无条件恢复 30 与清空 `ip` 桶。理由（实测）：nginx `svc_public burst=10` 只放行 **11 次**突发，
  走网关打满应用层阈值需约 60 秒且会把网关桶打空、让下一轮验收全红。
  附带收益：验到「阈值来自库、10s TTL 内生效、不需要重启」。
- 新增 `phase3LimitSource()` 区分两种 429（网关 `{"code":"TOO_MANY_REQUESTS"}` vs
  应用层 `{"errors":[{"code":"RATE_LIMITED"}]}`）—— 混同会把"网关拦了"读成"频控生效了"。
- `smoke-test.mjs` 横幅与结论文案由「Phase 1」改为「Phase 1~3」。
- 删除遗留临时脚本 `scripts/tmp-smoke-public-ticket.sh`（其头部已注明"跑完即删"，
  正式验收落在 `verify-phase3-h5.mjs`）。

**Verified（2026-09-21 真机）**
- `node scripts/smoke-test.mjs` **71 项全绿、退出码 0**，**连跑两遍复现**
  （第二轮 `FW20260921-0001`、`Retry-After=20s`）—— 证明 §4c 无冷却型假红灯。
- 跑后核对：`security.ip_minute_limit=30` 已恢复、`api_guards` 中 `scope='ip'` 无残留行。

**归档（2026-09-21）**
- 提交 **`b97ca66`** —— `feat: Phase 3 客户 H5 报修 — A→I 全部交付（Phase 3 判定完成）`，
  42 文件 / +7308 −409，已推送至 `main`
- **仓库更名**：`wetank9s-lab/-` → **`wetank9s-lab/qifang-AfterSales`**。推送时远端返回
  `This repository moved` 重定向提示，故一并改掉本地 `origin` URL，不长期依赖重定向
- ⚠️ **仓库仍为 public**（用户此前已知情确认）。本次推送**前重跑了密钥审计**，而非复用上次结论：
  ① 以 `.env` 的 5 个密钥型变量（`APP_KEY` / `DB_PASSWORD` / `POSTGRES_PASSWORD` /
  `SIGN_SECRET` / `BACKUP_PASSPHRASE`）反查 41 个待入库文件 → **零命中**；
  ② 第三方密钥形态特征（`sk-…` / `gh[pousr]_…` / `LTAI…` / `AIza…` / PRIVATE KEY 块 / `xox…`）→ **零命中**；
  ③ 敏感路径终审（`.env` / `aes_key` / `instance-id` / `.license` / `*.pem` / `*.key` / `*.sql` /
  `.workbuddy` / `.probe` / 备份）→ **干净**
- 入库前额外核对：`nginx/conf.d/service.conf` 提交的是**还原后的正式限流值**
  （`svc_conn 96` / `svc_public burst=10` / `rate=30r/m`），而非压测时的临时放宽值 ——
  防"临时改配置忘记还原"被静默提交
- **远端回验**（不只信本地审计，也不只信 push 输出）：`git ls-remote` 的 `main` HEAD 与本地
  `git rev-parse HEAD` **一致**（Git 内容寻址，哈希一致即整棵树一致）；
  `raw.githubusercontent.com` 匿名直取 `.env`、`storage/apps/main/aes_key.dat`、
  `h5/dist/index.html`、`h5/dist/assets/index-*.js` **全部 404**，
  `h5/dist/.gitkeep` 与 `h5/src/pages/Report/index.vue` 为 **200** —— 与预期逐条吻合
- `h5/dist/index.html` 在本次提交中被**真正从仓库移除**（Phase 3 修正 `.gitignore` 后的清理动作），
  远端已确认 404

### Phase 3.1 — 重复单识别补「事项文本」维度（2026-09-21）

**Fixed（产品缺陷：合法场景被误判为重复单）**
- `GuardService.findDuplicateTicket` 原先只比 **手机号 + 门店 + `ticket_type` + 时间窗**，
  **漏了 `PHASE-0.md` §9.4 明文要求的「事项文本相似」**。
  后果：同一客户在同一家店 10 分钟内分别报修「空调不制冷」与「冰箱漏水」（`ticket_type` 都是 `repair`），
  第二件被判成第一件的重复单，**客户拿不到单号** —— 这不是防刷生效，是把正常业务挡死。
- 修法：判重改为**五维全同** —— `customer_mobile` + `store_id` + `ticket_type` +
  **`normalizeContent(content)` 相等** + 时间窗，且 `status <> 'CANCELLED'`。
  新增确定性 `normalizeContent()`：`NFKC` 归一化 → 删除 Unicode 标点/符号（`\p{P}\p{S}`）
  → 删除全部空白 → 仅 ASCII `A–Z` 转小写。
- 分工：SQL 仍用前四维把候选压到极小（`LIMIT 50`），**应用层**再逐条比较归一化结果 ——
  归一化依赖 `NFKC` + Unicode 字符类，PG 侧没有对等能力，而本阶段的明确约束是**不引入 PostgreSQL 扩展**。
- 刻意的取舍：① **不引入 AI / 向量 / 复杂 NLP**（判重结果直接拒绝客户请求，必须可复现、可解释、可测）；
  ② 判错两个方向的代价**不对称**（漏判 = 两张单可人工合并；误判 = 客户拿不到单号、以为系统坏了），
  故所有边界情形（归一化后为空、候选超限）一律**放行**。

**Added（进总闸，不是临时脚本）**
- `scripts/smoke-test.mjs` §4c 新增 **Phase 3.1-A ~ E 五组断言**，总闸 71 → **76 项**：
  - **A** 完全相同内容 → `409` + 回原单号 + 不落新单 + **序号不推进**（实测 `13→14`，重复后仍 `14`）
  - **B** 同客户不同事项 → `201×2`，两张独立工单
  - **C** 仅空白/标点差异 → 仍 `409`
  - **D** 同内容不同 `ticket_type` → 允许
  - **E** 原单 `CANCELLED` → 允许重新提交
- 因 nginx `svc_public burst=10` 只放行 11 次突发（**DEV-34**），A~E 连发约 10 次请求前
  增加 `sleep 22s` 等令牌桶回填 —— 否则会撞上网关 429，把「不同事项被误判」伪装成「频控生效」。

**Verified（2026-09-21 真机）**
- `smoke-test.mjs` **76 项全绿、退出码 0**
- Phase 3.1 夹具实证：`FW20260921-0014`（A 原单）/ `0015`+`0016`（B 两件事）/ `0017`（C）/
  `0018`+`0019`（D）/ `0020` CANCELLED + `0021`（E）
- 跑后核对：`security.ip_minute_limit=30` 已恢复、`api_guards` 中 `scope='ip'` 无残留行

**Changed（文档）**
- 新增 **`docs/PHASE-3.md`** —— Phase 3 独立阶段交付报告（12 节），README 文档索引已加入
- `docs/DEV-PLAN.md` §Phase 3 章节**内**的状态行由 `🟡 A→I 已完成；阶段内验收待并入…` 更正为 **✅ 完成**，
  并补 Phase 3.1 行；进度表同步
- `docs/DEVIATIONS.md` 新增 **DEV-36**（重复单补「事项文本」）、**DEV-37**（单实例部署边界）
- `docs/SECURITY.md` §6 判重口径改为五维、§8 部署基线新增「应用实例数 = 单实例」，
  并登记单实例边界声明
- `README.md` 总闸点数 71 → 76、`verify-plugin-load` 56 → 57（笔误）、文档索引加入 `PHASE-3.md`

**Not Started（本段收尾时点）**
- Phase 4 派工 / Visit / Token / 短信 —— 已于同日启动并完成服务层，见下节

---

### Phase 4 — 派工 / ServiceVisit / 双短信（服务层 A~G + 总闸 J，2026-09-21）

> **状态：🟡 部分交付**。服务层与 action 层完成并真机验收；**后台页面（H）与真实售后人员 UI 走查（I）未交付**，
> 按 `docs/DEV-PLAN.md` §Phase 4 Phase 4 强制条款 **不得进入 Phase 5**。独立阶段报告见 **`docs/PHASE-4.md`**。

**Added（服务层）**
- `services/token-service.ts` —— **TokenService**：`randomBytes(32)` → base64url，**明文只出台一次**，入库 `sha256`；
  校验失败一律 `TOKEN_INVALID`，**内部 reason（过期 / 已用 / 被改派 / Visit 非活跃）不外露**（区分原因 = 给攻击者一个可枚举探测接口）
- `services/visit-service.ts` —— **VisitService**：建 Visit + `visit_no` 在**调用方事务内**取号（不做自己的事务）；
  师傅姓名 / 手机号 / 预约时间是**快照**
- `services/sms-provider.ts` —— **SmsProvider 抽象** + `MockSmsProvider` + `AliyunSmsProvider`（手写 RPC v1.0 签名）
  + `NotImplementedSmsProvider`（tencent 响亮失败）+ `createSmsProvider()` 工厂；**业务层永不知道怎么发**
- `services/sms-service.ts` —— **SmsService**：scene → 模板 / 收件人映射；**事务性发件箱**（事务内写 `pending`，**提交后**才调供应商）
- `actions/svc/dispatch.ts` —— `dispatch` / `reassign` / `reschedule` 三个 handler + `tokenCheck` / `smsOutbox` 两个验收探针
- `migrations/20260921-visit-lifecycle.ts` —— Visit 生命周期列（`visit_status` / `reassigned_from_visit_id` /
  `superseded_reason` / `token_revoked_reason` / `token_revoked_at`）与索引
- `constants.ts` —— `SVC_ACTION` 新增 5 项（`dispatch` / `reassign` / `reschedule` / `tokenCheck` / `smsOutbox`）；
  `SMS_SCENE` + `SMS_SCENE_RECIPIENT` + `SMS_SCENE_TPL_ENV` 三表一一对应；`DISPATCHABLE_SERVICE_MODES`（**不含 `remote`**）；
  `DEFAULT_SETTINGS` 新增 `sms.enabled`（默认 `false`）

**Changed（语义锁定）**
- **改派 = 终止旧 Visit + 新建 Visit**（`DEV-PLAN` 上一版 E 步"同 Visit 换师傅 + Visit 历史不覆盖"两句自相矛盾，已更正）：
  旧行 `visit_status → SUPERSEDED` + 新行 `reassigned_from_visit_id` 指回旧行，**旧行一个字段都不改** ——
  让"返工过程可追溯"成为**数据模型的必然结果**，而不是靠人记得别覆盖
- **责任人判据** = `technician_mobile` + `provider_name` + `service_mode`（**姓名不在其中**，改名走 M8）
- `cancel` / `transfer` 抽公用 `voidActiveVisit()`：同步作废进行中的派工 + 通知原师傅（**数据完整性问题**，非通知问题）
- `plugin.ts` 新增 `repairSettings()`（afterLoad）—— 让**新增参数能到达已安装的旧实例**（DEV-46）

**Fixed（DEV-47：三处"注释正确、代码不对"，不报错、不崩、测试全绿）**
- ① `enqueueDispatchPair()` 的取消短信传 `visitId: null`（注释说"挂在旧 Visit 上"，`biz_id` 落成 `x`）→ 增补 `visitId` 参数
- ② `DISPATCH_UPDATE` scene **定义齐全却无任何调用方**，改派 / 改约给客户错发"已受理"话术 → 增补 `customerScene` 参数
- ③ `SMS_SCENE` 注释把 `technician_task` 写成 `technician_assignment`（照注释配模板会配出永远匹配不到的名字）→ 改正

**Added（断言）**
- `scripts/smoke-test.mjs` §4d —— **Phase 4 验收 16 项**，总闸 76 → **92 项**；`sms.enabled` 临时改 `true`、
  等 **11s**（`ConfigService` 10s TTL）后在 `finally` 里**无条件恢复原值**（读 `PHASE4_SMS_RESTORE`，不假设它是 `false`）
- `scripts/verify-plugin-load.mjs` 新增 **`readSvcActionSets()`**（从 `constants.ts` 现读 action 集合，替代**硬编码 6**，
  顺带把 4 处会因新增 action 假红的断言改为集合驱动）+ **【4d】2 条**（DEV-41 探针自毁闸的离线证明）

**Verified（2026-09-21 真机，均退出码 0）**
- `verify-config.mjs` **44 / 44** · `verify-plugin-load.mjs` **59 / 59** · `smoke-test.mjs` **92 / 92**
- 8 条高风险闸门全部在 HTTP 层取证（映射见 `docs/PHASE-4.md` §6）；核心错误码：
  重复派工 `409 VISIT_ALREADY_ASSIGNED` / 责任人未变 `422 SAME_RESPONSIBLE_PARTY` / 缺原因 `422 MISSING_REASON` /
  `remote` 拒绝 `422 REMOTE_MODE_DEFERRED` / 第三方缺 `provider_name` `422 MISSING_PROVIDER` / 门店越权 `404`
- **硬门槛实证**：同一实例、同一工单、同一 Token 由 `valid:true` → `valid:false`（并带新 Token `valid:true` 的反向对照），
  库内 `token_revoked_reason=reassigned`

**Not Delivered（阻塞 Phase 5）**
- **H** 后台业务页面（我的门店工单 / 全量工单 / 工单详情含事件时间线 + Visit 区块）—— **未交付**
- **I** 真实售后人员 UI 走查（派工 / 改派 / 改约）—— **未进行**，走查人与走查时间**未记录**
- 后台形态已裁定：**NocoBase 原生后台为主 + 少量自定义客户端组件 / 动作增强**，**不做独立 Vue3 管理端**
  （门店范围 / 字段白名单 / 权限判定已全在服务端，原生页面直接吃这套 ACL，避免"第二处实现"）

**Resolved（2026-09-21 复核方裁定）**
- **DEV-45 → ✅ 已接受偏差 / ACCEPTED**：复核方明确接受 `tokenCheck` 保留 **`200 + {valid:false, code:'TOKEN_INVALID'}`**，
  **无需任何代码改动** —— 它是"总部已登录人员询问某个师傅 Token 是否有效"的**诊断查询**，不是拿该 Token 做认证。
  `401` 归还给 **Phase 5** 的 `GET /api/technician/visits/:token`（那里 Token 本身就是访问该资源的认证凭证）
- **验收条款改写为「语义要求」**：`docs/DEV-PLAN.md` §Phase 4 总纲与 §J 由"改派后旧 Token 立即 **401**"
  改为「改派后旧 Token **必须立即失效**；Phase 4 以 `tokenCheck` 探针的 `200 + valid:false` 证明，
  Phase 5 以正式师傅匿名接口的 `401 TOKEN_INVALID` 证明」—— 避免把探针状态码写死进条款、
  再次制造"实现其实正确、规格文字制造假红灯"
- **Phase 5 新增硬验收矩阵（6 行）**：改派前 `200` → **同一条 Token 改派后 `401`** → 新 Visit 的 Token `200`；
  过期 / 已使用 / 随机不存在 → 一律 `401 TOKEN_INVALID`（不透露原因）。已写入 `docs/DEV-PLAN.md` §Phase 5
- **阶段状态裁定**：**服务层 A~G + 总闸 J = ✅ PASS**；**H / I 未交付 → 阶段整体 🟡 HOLD，Phase 5 暂不允许开始**
- **H 的范围边界**（复核方明确）：Phase 4 的 Visit 区块**只做「查看派工历史与状态」**，
  **不得**提前实现 Phase 6 的门店确认 / 驳回、照片审核、收费确认
- **I 的判定门槛**（复核方明确）：**必须由真人操作**；自动化浏览器脚本（Playwright 等）可作补充，
  **不能作为 I 的验收证据**（本条款要的是"实际人员使用后的可用性验证"）
- **I 的逐屏走查脚本**（8 步：登录 → 受理 → 派工 → 改派 → 改约 → 时间线 → 总部全量 → 他店不可见）
  已写入 `docs/DEV-PLAN.md` §Phase 4 与 `docs/PHASE-4.md` §12.2

**Changed（文档）**
- 新增 **`docs/PHASE-4.md`** —— Phase 4 独立阶段报告（13 节），README 文档索引已加入
- `docs/DEV-PLAN.md` §Phase 4：状态行、A~J 执行表逐项标注、§J 说明（已裁定）、8 条闸门证据表、E 步措辞更正、
  强制条款新增第 4 条（真人不可替代）、H 范围边界与 I 走查脚本；§Phase 5 新增 Token 失效硬验收矩阵
- `docs/DEVIATIONS.md` 新增 **DEV-41 ~ DEV-47**；**DEV-45 状态改为 ✅ 已接受偏差**
- `docs/API.md`：§2 新增 Token 语义与 `401` 归属说明（含与探针的区别）、§4 登记两个验收探针 P1/P2
  （含「仅 mock 通道存在、非 mock 404」的自毁闸）与 I5 改派语义
- `docs/DATA-MODEL.md`：`sms_logs.scene` 枚举补 `technician_assignment_cancelled`，注明取值域以 `SMS_SCENE` 为唯一事实来源
- `README.md`：三套基线 92 / 59 / 44（合计 195）、Phase 4 状态行（HOLD / 服务层 PASS）与结论段、文档索引

---

### Phase 4-H — 后台业务页面（**🟡 部分交付**，2026-09-21）

> **状态：🟡 部分交付**。四张页面已通过脚本播种并落库；**工单详情为降级交付**、**业务按钮（受理 / 派工 / 改派 / 改约）未交付**、
> **真人 UI 走查（I）未进行** → 按 Phase 4 强制条款 **仍不得进入 Phase 5**。详见 `docs/PHASE-4.md` §13。

**Added（交付物）**
- `scripts/seed-admin-pages.mjs` —— 后台页面播种脚本（**幂等**：`desktopRoutes` 里已存在则 `mode=replace`，
  否则 `mode=create`）。退出码 `0` 成功 / `1` 失败（校验 400 原样打印 `details`）/ `2` 环境未就绪；
  支持 `--dry-run` / `--list`
- 四张页面，统一挂在导航分组「售后工单」下：
  **我的门店工单**（6 个状态 Tab）/ **全量工单**（多一列当前门店）/ **工单事件时间线** / **派工记录**（只读）
- `scripts/expected-sensitive-columns.mjs` —— 「绝不能出现在后台界面上的列」**单一事实来源**
  （播种脚本与 `smoke-test` 共用同一份；另含页面清单与状态 Tab 清单）

**Fixed（DEV-51 / DEV-52：两处「接口全绿、后台选不到」）**
- DEV-51：NocoBase 会**主动删除** `createdAt` / `updatedAt` 的字段注册表项 → `db2cm()` 漏写元数据
  → 后台列表排不出"报修时间"、事件时间线没有时间。处置 `ensureAutoTimestampFields` + 健康检查两盏灯
  （`uiTimestampFieldsRegistered` / `uiTimestampFieldsMissing`）
- DEV-52：字段助手只给 `enumStr` 写了 `interface`，其余 8 个没写 → 这些列**不可筛选**（筛选器下拉为空）。
  处置：补 `interface` 与 `uiSchema.type` / `x-component`，并加 `ensureFieldInterfaces` 自愈 + 健康检查计数

**Degraded（⚠️ 降级交付，如实登记）**
- **工单详情（H3）不能用蓝图弹窗**：`applyBlueprint` 会把弹窗编译成一个 `defaults` 为 `undefined` 的
  `compose` 步骤，弹窗内区块的默认 `edit` 动作在该步必然 400（DEV-53 坑 1，已插桩取证）；
  唯一合法豁免路径需要给工单开一张**绕过状态机**的表单，属设计禁止项。
  → 改为「列表放足关键列」+ H6 落地时补**客户端只读抽屉**
- **编译器自动合并写动作且无法移除**（DEV-53 坑 2）：每个表格区块会被补上
  `addNew` / `bulkDelete` / `view` / `edit` / `delete`。ACL 会挡成 403（**点不出后果**），
  但按钮确实在界面上 → 登记为 **I 走查的观察项**，不掩盖

**Added（断言：总闸 99 → 102 项）**
- §4e 第 5 组 3 条：**① 四张页面均已落库**（`type='flowPage'`，防止"页面被删而所有 `/api` 断言照样全绿"）；
  **② 任何区块都不引用敏感列**（DEV-53 处置②的守护断言，带"每页必须有区块、每区块 ≥3 列"的正对照）；
  **③ 每个状态 Tab 的默认筛选 ≥3 个可筛选字段且命中对应 status**
- 读路径用 `/api/flowModels:list` 建树，**不用** `exportBlueprint`（见 DEV-54：它对含关联列的页面 400，
  四张页面里三张会中招；且区块挂在 **Tab 的 `schemaUid`** 下，只从页面 uid 出发会读到空 → 最坏的假绿）
- 已做**反向验证**：临时让派工记录页引用 `access_token_hash` → 断言如期变红（`「派工记录」引用了敏感列：access_token_hash`），验证后已还原

**Changed（文档）**
- `docs/PHASE-4.md` 新增 **§13「Phase 4-H 后台页面交付说明」**（页面清单 / 降级原因 / 敏感列悖论 /
  未落地项 / I 走查 4 条观察项 / 守护断言），原 §13 顺延为 §14；§11.3 改为分状态表格
- `docs/DEVIATIONS.md` 新增 **DEV-53**（applyBlueprint 三个平台坑）与 **DEV-54**（exportBlueprint 不可用作回读通道）
- `scripts/verify-config.mjs` 必需文件清单新增 `expected-sensitive-columns.mjs` / `seed-admin-pages.mjs` / `docs/PHASE-4.md`



