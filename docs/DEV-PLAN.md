# 开发计划（Phase 1 → Phase 10）

> 每个 Phase 必须做到：**当前代码可运行** 才进入下一阶段；**不带已知错误**进入下一阶段。
> 每阶段输出严格遵循下方固定格式，不省略核心代码，禁止"其余代码省略 / 按类似方式实现 / 此处自行补充"。

---

## 输出格式契约（文档 §27）

```
【本阶段目标】
【本阶段修改的目录/文件】
【完整代码】
【数据库变更】
【配置项】
【运行命令】
【测试方法】
【预期结果】
【当前完成情况】
【下一阶段】
```

---

## 进度总览

| Phase | 名称 | 状态 | 验收门槛 |
|---|---|---|---|
| **0** | 需求核对与技术确认 | ✅ 完成 | 无架构级阻塞，本目录产出 |
| 1 | 项目初始化与可启动 | ✅ 完成 | **真机验收全绿**：三容器 `Up (healthy)`；`smoke-test.mjs` 55/55（Phase 1 时点数）；`/api/svc/health` 实测 `{"db":"ok","sms":"mock","tasks":"ok"}`；11 张表 + 35 条声明式索引全部落库（见 `docs/VERIFY-PHASE-1.md`）。离线：`verify-config` 41 + `verify-plugin-load` 31 = 72 项全绿（Phase 1 时点数） |
| 2 | 数据模型 / 权限 / 工单底座 | ⏸ **功能开发基本完成，正式验收挂起（HOLD）** | AT-03 门店隔离有效 ✅；**「并发 100 次取号」未验证 ❌ → 挂起**。挂起期间**不得写 PASS**，解除条件见 `docs/PHASE-2.md` §7 |
| 3 | 客户 H5 报修 | ⬜ 下一步 | AT-01 / AT-02 / 连点只产生 1 单；**并按 A→I 顺序交付，末尾含 100 路真实并发验收** |
| 4 | 派工 / Visit / Token / 短信 | ⬜ | AT-04 / AT-05；**且必须交付后台工单页面并由真实售后人员 UI 走查** |
| 5 | 师傅 H5（照片 / 结果 / 收费） | ⬜ | AT-16 ~ AT-19 / AT-22 |
| 6 | 门店确认 / 驳回 / 多次 Visit / 改派改约 | ⬜ | AT-08 / AT-09 / AT-20 / AT-21 / AT-23 |
| 7 | 匿名评价 / 收费一致性 / 自动重开 | ⬜ | AT-10 ~ AT-12 / AT-24 |
| 8 | 短信回执 / 重试 / SmsLog | ⬜ | AT-06 |
| 9 | SLA / 看板 / 报表 / Excel 导出 | ⬜ | AT-15 + 口径核对 |
| 10 | 全量测试 / 安全检查 / 生产部署 | ⬜ | 以下 26 项测试全绿；**且必须完成「生产发布形态评审」**（见 Phase 10 节） |

> ⚠️ **Phase 2 状态口径（2026-09-20 独立验收结论）**
> Phase 2 = **HOLD**，不是 PASS。服务端底座（模型 / 三级权限 / 门店隔离 / 原子取号 /
> 状态机 / 事件 / 参数）已真机通过、三套校验 43 + 56 + 64 = **163 项全绿**，
> 但 DEV-PLAN 自己写的门槛「并发 100 次取号无重复、无空洞」**未验证** ——
> 唯一能触发取号的入口是 Phase 3 的「创建工单」，Phase 2 无对外接口，
> **故意不造这个绿灯**（用 SQL 直连取号器属于自欺欺人）。
> 解除条件：Phase 3 完成后跑 `scripts/verify-concurrency-phase2.mjs` 8 条断言全绿
> （脚本已就位，契约见 `docs/PHASE-2.md` §7.2）。

---

## Phase 1 — 项目初始化与可启动

**目标**：一条命令拉起 postgres + nocobase + nginx，插件已加载，健康检查通过。

**产出**
- `Dockerfile`（基于 `nocobase/nocobase:<v2.1.x tag>`，COPY 插件并构建）
- `docker-compose.yml`（`postgres` / `nocobase` / `nginx`，健康检查、依赖顺序、数据卷）
- `.env.example`（含全部键：`APP_KEY`、`DB_*`、`API_BASE_PATH`、`TZ`、`PUBLIC_BASE_URL`、`SIGN_SECRET`、`UPLOAD_DIR`、`SMS_*` 占位）
- `nginx/nginx.conf` + `nginx/conf.d/service.conf`（HTTPS、`limit_req`、H5 静态、`/api` 反代、上传体大小）
- 插件空壳：`package.json` / `tsconfig.json` / `src/server/plugin.ts`（注册 9 个 collection + `/api/svc/health`）
- `README.md`：开发环境启动、生产构建、DB 初始化、NocoBase 初始化、插件加载、日志、备份、恢复
- `scripts/`：`init-env.sh`、`backup.sh`、`restore.sh`

**验收**：`docker compose up -d` → `https`/`http` 打开后台完成初始化向导 → `curl /api/svc/health` 返回 `{"db":"ok","sms":"mock","tasks":"ok"}` → 9 张表出现在 PostgreSQL 中。

**风险点**：插件注入官方镜像的路径与构建方式（构建期 `yarn build` vs 运行期挂载 `packages/plugins`）。两种方式都会给出并验证。

---

## Phase 2 — 数据模型 / 权限 / 工单底座

**目标**：工单表、事件表、门店权限、取号器、服务层骨架全部可用；后台能看工单列表与详情。

**产出**
- 9 张 collection 定义（含索引与唯一约束；T-01 降级方案就绪）
- `storeUsers` 多对多 + 种子数据脚本（15 门店 + 用户映射）
- `storeScope` 中间件、`PermissionService`、对象级鉴权
- ACL 角色与字段只读配置
- `TicketService`（create/accept/transfer/cancel）、`EventService`、`SequenceService`、`ConfigService`
- 后台页面：我的门店工单（状态 Tab）、全量工单、工单详情（时间线区块）
- 定向测试：门店隔离、取号并发、事件必写

**验收**：AT-03 通过（门店 A 用户无法通过 URL/API 看到门店 B 工单）；并发 100 次取号无重复、无空洞。

**状态：⏸ HOLD —— 功能开发基本完成，正式验收挂起（2026-09-20，真机 + 独立验收结论）**
详见 [`docs/PHASE-2.md`](PHASE-2.md)；整改执行情况见该文 §7。

已达成（真机 + 三套校验 43 + 56 + 64 = 163 项全绿）：
- AT-03 通过：原生接口与 `/api/svc` 两条路径都隔离，且 get 他店返回 **404**（非 403/500）
- 服务端底座全部落地：三级权限（全局 action → 资源级授权 → 字段白名单）、双层门店隔离、原子取号、状态机 M1/M2/M6/M7、事件必写、参数配置
- 本阶段修掉 10 个"不报错但不生效"的缺陷（DEV-18 ~ DEV-27），其中 DEV-23 含**真实凭证泄露**（`fields=null` 导致 `feedback_token_hash` 被整行下发）

**未达成（即挂起项，不得写 PASS）：**
- ❌ **「并发 100 次取号无重复、无空洞」未验证**：唯一会触发取号的入口是"创建工单"，属 Phase 3；用 SQL 直连取号器去模拟会变成"验证 PG 而不是验证我们的代码"，属自欺欺人的绿灯，因此**明确不做**。
  - **解除条件**：Phase 3 实现 `POST /api/public/tickets` 后**第一时间**跑 `scripts/verify-concurrency-phase2.mjs`（8 条断言见 `docs/PHASE-2.md` §7.2），全绿方可补签 PASS。
  - **禁止**：用 SQL 直连 `SequenceService` 替代真实 HTTP 压测；也**禁止**为造绿灯而调低/关闭频控与幂等（脚本在频控拦截时以退出码 2「环境未就绪」收场，而不是记成红灯）。
- ⚠️ 后台页面、`storeUsers` 用户映射、`tasks/` + `sms/` 内容留待后续阶段（见 §Phase 4 的交付期约束）。

---

## Phase 2 已确认不重构的设计（11 项）

> 独立验收已确认**架构与业务路线无偏离**。以下 11 项是本阶段的**已验证正确设计**，
> 后续阶段**一律不重构**；如需变更，必须先写进 `docs/DEVIATIONS.md` 并说明理由，
> 不允许"顺手改一下"。

| # | 已确认设计 | 为什么不动 |
|---|---|---|
| 1 | 单一 NocoBase 插件承载全部后端扩展（不新建独立 Node 服务） | 跨进程会引入分布式事务与部署复杂度；本系统规模不需要 |
| 2 | 11 张 collection 全部由插件 `defineCollection()` 声明，不手写 DDL | 手写 DDL 会与 NocoBase 元数据漂移，升级即坏 |
| 3 | **三级权限**：全局 action → 资源级授权 → 字段白名单 | 缺任一级都表现为"不报错但不生效"（DEV-23）；合并成一级就丢掉字段级安全边界 |
| 4 | **双层门店隔离**：框架层中间件 + 服务层对象级 | 中间件覆盖原生接口，服务层覆盖自定义 action；只留一层必然有盲区 |
| 5 | **越权与不存在返回同一个结果（404）**，不是 403 | 403 等于承认存在性，可被用来枚举他店工单规模 |
| 6 | 字段白名单以 `nativeReadFieldsOf()` 为**单一事实来源**，"漂移即对齐" | 白名单是安全边界，不接受手工配置漂移（DEV-24）；逃生开关只管运营自定义那一类 |
| 7 | 原生接口**只授予 `list`/`get`**，写操作一律走自定义 action | 资源级 ACL 无"只能改某些字段"的表达力，用 `fields` 表达会 fail-open（DEV-19/22） |
| 8 | 原子取号 = 单条 `INSERT … ON CONFLICT … DO UPDATE RETURNING` | 唯一能排除 lost update 的写法；"先 SELECT 再 UPDATE"并发下必然重号 |
| 9 | 状态写入唯一入口是 `TicketService`，且**条件 UPDATE + 影响行数为 0 即 409** | 乐观并发；绕过去就会出现两个处理人 |
| 10 | 事件与状态变更**同事务**，`TicketEvent` 只能由 `EventService` 写 | 否则会出现"状态变了但时间线断"的不可解释数据 |
| 11 | 只增不改的播种 + `afterLoad` 自愈（迁移跑过不重跑） | 已安装实例拿不到新种子；自愈挂在 `afterLoad` 才能覆盖老实例（DEV-23） |

---

## Phase 3 — 客户 H5 报修

**交付顺序（A → I，不得跳步；I 是 Phase 2 挂起项的唯一解除手段）**

| 步 | 内容 | 完成判据 |
|---|---|---|
| A | `GET /api/public/stores` | 只回 `code`/`name`/`region`，不回内部 id 与其他门店信息 |
| B | `POST /api/public/tickets` | 按 `docs/API.md` §1.2 返回 `{ticket_no, store_name, created_at}`；**不返回 `id`/处理人** |
| C | `GuardService`（IP / 手机号 / 重复单 / 幂等） | 四类守卫各自可被独立断言点亮 |
| D | `request_id` 幂等（`idempotencyRecords`） | 重放返回首个 `ticket_no`，且不消耗序号 |
| E | IP / 手机号频控 | 超频返回 **429**（阈值取 `systemSettings`，不写魔法数） |
| F | 重复单识别（同号 + 同店 + 同类型 + 时间窗） | 命中返回原单，不新建 |
| G | 隐私说明与勾选（`privacy_agreed` 强校验） | 未勾选一律 400 |
| H | `/report` Vue3 H5（含 `/report/success`） | 手机端可用；连点 10 次只产生 1 单 |
| **I** | **100 路真实 API 并发取号验收** | `node scripts/verify-concurrency-phase2.mjs` **8 条断言全绿 → 补签 Phase 2 PASS** |
| 末 | Phase 3 自身的 AT-01 / AT-02 / 重复提交 / 限流验收 | 并入 `smoke-test.mjs` |

**产出**：`h5/` 工程（Vite + Vue3 + TS）、`/report` 页面、`/report/success`、`POST /api/public/tickets`、`GuardService`（IP/手机号/重复单/幂等）、隐私说明与勾选、`/api/public/stores`。
**验收**：AT-01 / AT-02；连点 10 次只产生 1 张工单；超频返回 429。

**前置条件**：业务方给出「门店用户账号清单与门店归属」（`docs/PHASE-2.md` §8 第 2 项），否则 `storeUsers` 种子继续缺失，门店侧验收仍只能靠临时账号。

---

## Phase 4 — 派工 / ServiceVisit / 双短信

**产出**：`dispatch` / `reassign` / `reschedule`；`VisitService` 建 Visit + `visit_no` 并发取号；`TokenService` 生成师傅 Token；`SmsService` + `SmsProvider` 抽象 + `MockSmsProvider` + `AliyunSmsProvider`；`SmsLog` 写入；事件 `dispatched/rescheduled/reassigned`。
**验收**：AT-04 / AT-05；改派后旧 Token 立即 401。

### ⚠️ Phase 4 的强制交付条款（后台页面不得再延期）

1. **后台业务页面必须在本 Phase 完成前交付**：我的门店工单（状态 Tab）/ 全量工单 / 工单详情（含事件时间线区块）/ Visit 审核区块。Phase 2 的该缺口**只允许重排期到本 Phase，不允许继续顺延**。
2. **Phase 4 验收必须包含真实售后人员的 UI 走查**：派工 / 改派 / 改约的验收**不得只用 `curl` 或 API 断言下结论** —— 必须由真实售后人员在浏览器页面上完整走一遍，并记录走查人与走查时间。
3. 走查发现的可用性问题与本 Phase 的功能缺陷**同等对待**：未关闭不得进入 Phase 5。

---

## Phase 5 — 师傅 H5

**产出**：`/technician/visit/:token` 页面；`GET /api/technician/visits/:token`；`POST .../files`（私有存储 + magic bytes + 去 EXIF + 受控读取）；`POST .../submit`（收费校验）；提交后置 `WAIT_STORE_CONFIRM` 且**不发评价短信**。
**验收**：AT-16 ~ AT-19 / AT-22。

---

## Phase 6 — 门店确认 / 驳回 / 多次 Visit

**产出**：`confirm`（含金额调整必填原因、生成评价 Token、发评价短信）/ `reject`（保留 Visit 与照片）/ `remoteComplete`；工单详情页 Visit 审核区块（照片预览、金额、确认/驳回）。
**验收**：AT-08 / AT-09 / AT-20 / AT-21 / AT-23。

---

## Phase 7 — 匿名评价 / 收费一致性 / 自动重开

**产出**：`/review/:token` 页面；`GET/POST /api/public/reviews/:token`；`FeedbackService` 分流（M12/M13）；`escalated` / `reopen_count` / `review_status`；总部异常列表。
**验收**：AT-10 ~ AT-12 / AT-24；5 星 + mismatch 也必须重开。

---

## Phase 8 — 短信回执 / 重试

**产出**：`POST /api/callbacks/sms/:provider`（验签 + `provider+biz_id` 幂等）；`smsRetry` 定时任务（最多 1 次）；工单"通知异常"标记与总部看板入口；`reviewExpire` 定时任务。
**验收**：AT-06；同一 `biz_id` 回调 3 次只产生 1 条状态变化。

---

## Phase 9 — SLA / 看板 / 报表 / 导出

**产出**：`slaScan` 定时任务；`dashboard/summary`；`reports/kpi`（12 项口径）；`export/tickets`（脱敏 + 防 CSV 注入 + 导出事件）；总部看板区块。
**验收**：AT-15；报表数字与 SQL 抽样核对一致。

---

## Phase 10 — 测试 / 安全 / 生产部署

**产出**：全量测试、安全检查清单、生产 Dockerfile/compose、备份恢复脚本与演练记录、`README` 上线清单。

### ⚠️ 强制条款 1：生产发布形态评审（DEV-26，**未完成，不得视为已解决**）

开发期与生产期的**发布形态不一致**，这是当前已知偏差（登记于 `docs/DEVIATIONS.md` DEV-26）：

| 项 | 开发期现状 | 生产要求 |
|---|---|---|
| 插件产物 | 宿主目录 bind mount 进容器（改代码即生效） | **不可变镜像**：产物在构建期 `COPY` 进镜像，运行时无宿主目录依赖 |
| 配置 | `.env` 由宿主提供 | 密钥走部署环境注入，镜像内不含任何密钥 |
| 可复现性 | 依赖开发者本机目录内容 | 同一镜像 tag 在任何机器上行为一致 |

**Phase 10 必须产出结论，三选一并在 `docs/DEVIATIONS.md` 更新 DEV-26 状态：**

1. **不可变生产镜像**（推荐）：`Dockerfile` 采用多阶段构建，`COPY` 插件产物 + `yarn build`，运行时零 bind mount；产出镜像 `docker save` 归档 + tag 冻结。
2. **保留 bind mount**：必须写明**为什么可以接受**（例如单机自运维、无灰度需求）以及配套补偿措施（部署脚本化、产物校验和比对）。
3. **混合**：代码进镜像、上传目录与服务配置外挂。

无论选哪种，**Phase 10 验收必须包含一次"干净机器部署演练"** —— 在一台没装过本项目的机器上，仅凭镜像/仓库 + `.env.example` 完成部署并通过 `smoke-test.mjs`。做不到就说明发布形态不可复现。

### ⚠️ 强制条款 2：全量测试必须包含已挂起项的回归

Phase 10 的全量测试须复跑 `scripts/verify-concurrency-phase2.mjs`（100 路并发取号），
确保 Phase 3 补签的 PASS 在后续阶段没有被回归破坏。

---

## 测试清单（文档 §24，共 26 项，全部必须真实编写）

| # | 用例 | 类型 | 归属 Phase |
|---|---|---|---|
| 1 | 客户创建工单（含字段校验、白名单） | 集成 | 3 |
| 2 | 门店权限隔离（跨店 API 越权） | 集成 | 2 |
| 3 | 派工（建 Visit + 双短信 + 事件） | 集成 | 4 |
| 4 | 生成 ServiceVisit（`visit_no` 并发唯一） | 集成 | 4 |
| 5 | 生成师傅 Token（格式/熵/仅存 hash） | 单元 | 4 |
| 6 | Token 过期 | 单元 | 4 |
| 7 | Token 重复使用 | 单元 | 4 |
| 8 | 图片格式错误（伪造扩展名绕过） | 单元 | 5 |
| 9 | 图片大小错误 | 单元 | 5 |
| 10 | 收费 = true 但金额为空 | 单元 | 5 |
| 11 | 师傅提交（状态 → WAIT_STORE_CONFIRM，不发评价短信） | 集成 | 5 |
| 12 | 门店确认（金额写入 + 生成评价 Token + 发短信） | 集成 | 6 |
| 13 | 门店驳回（保留 Visit 与照片，回 PROCESSING） | 集成 | 6 |
| 14 | 客户评价（正常 → CLOSED） | 集成 | 7 |
| 15 | 低评分重开（`escalated` + `reopen_count`） | 集成 | 7 |
| 16 | 收费不一致重开（即使 5 星） | 集成 | 7 |
| 17 | 评价 Token 重复使用 | 单元 | 7 |
| 18 | 评价超时关闭（`review_status=expired`） | 集成（假时钟） | 8 |
| 19 | 转店（`source_store_code` 不变 + 事件） | 集成 | 6 |
| 20 | 改派导致旧 Token 失效 | 集成 | 4/6 |
| 21 | 短信失败重试（最多 1 次） | 集成 | 8 |
| 22 | 短信回调幂等 | 集成 | 8 |
| 23 | 匿名接口限流 | 集成 | 3 |
| 24 | 重复提交检测（同号同店同类型） | 集成 | 3 |
| 25 | 门店越权写操作（用别人的 ticketId 调 confirm） | 集成 | 6 |
| 26 | 照片受控读取（无权限/签名过期） | 集成 | 5 |

**测试基建**：`@nocobase/test` + Jest/Vitest + 独立测试库（每次 `migrate:down/up`）；假时钟用于 Token 过期与超时关闭；Mock 短信 Provider 断言发送内容与次数。

---

## 工程约定

| 项 | 约定 |
|---|---|
| 语言 | TypeScript（strict） |
| 命名 | 变量/函数语义化；枚举常量化；服务类单职责 |
| 禁止魔法数 | 阈值、cron、上限全部进 `systemSettings` 或 `.env` |
| 校验 | 每个公开接口一个 DTO/Schema |
| 分层 | `actions`（校验+响应）→ `services`（业务+事务）→ `collections`（数据） |
| 状态写入 | 仅 `TicketService`（含 `VisitService`/`FeedbackService` 内部调用），并同步写 `TicketEvent` |
| 错误 | 统一错误码（见 `docs/API.md` §0）；不向前端回显堆栈 |
| 日志 | 结构化 + traceId；不写敏感明文 |
