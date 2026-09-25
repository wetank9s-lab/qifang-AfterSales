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
| 2 | 数据模型 / 权限 / 工单底座 | ✅ **PASS**（2026-09-20 补签） | AT-03 门店隔离有效 ✅；「并发 100 次取号」✅ **8 条断言全绿、退出码 0**（Phase 3-I 补做，证据见 `docs/PHASE-2.md` §7.3）。后台页面缺口按裁定重排期至 Phase 4 |
| 3 | 客户 H5 报修 | ✅ **PASS**（2026-09-21 独立复核通过） | A→I 顺序执行完成；末尾 100 路真实并发验收 **8 条断言全绿、退出码 0**（Phase 3-I）；H5 自身验收 `verify-phase3-h5.mjs` **35 项全绿**；阶段内 AT-01 / AT-02 / 重复提交 / 限流验收已并入 `scripts/smoke-test.mjs` §4c（总闸 **76 项全绿**）<br>✅ **Phase 3.1 重复单修正**（2026-09-21）：判重补"事项文本"维度（PHASE-0 §9.4 的原规则），A~E 五组断言入总闸 → 提交 `0cc9625`<br>✅ **独立复核后正式 PASS**：另修掉两处**文档漂移**（SECURITY.md 手写旧版本线 / 抄错 nginx burst），并把"规格文档不复写易漂移参数"变成 `verify-config` 断言（43 → **44 项**） |
| 4 | 派工 / Visit / Token / 短信 | ✅ **PASS**（2026-09-23 复核方裁定） | 执行顺序 A→J 见本 Phase 章节；AT-04 / AT-05；**且必须交付后台工单页面并由真实售后人员 UI 走查**。8 条高风险闸门逐条需可复现断言 |
| 5 | 师傅 H5（照片 / 结果 / 收费） | 🟢 **PASS（阶段已关闭，2026-09-25）**（细分子阶段见 `docs/PHASE-5.md` §状态表 / §14 关闭记录）：**P5-0 PASS**（`7b7e232`）· **P5-1 PASS**（`297e728`，2026-09-25 裁定）· **P5-2 手机真人走查 🟢 PASS**（DEV-82 说明条件必填收口，`14c5b1a`） | AT-16 ~ AT-19 / AT-22 |
| 6 | 门店确认 / 驳回 / 多次 Visit / 改派改约 | 🟡 **进行中（2026-09-25 启动）** —— 计划/契约已定稿（`docs/PHASE-6.md`）；**P6-0** Store Review Read Model & Photo Access Gate **机器门 🟢 全绿**（§5 矩阵 24/24 + 反向 9/9；证据 `docs/PHASE-6-P6-0-EVIDENCE.md`），**剩 U1 人眼走查待裁定**；**P6-1** confirm/reject 事务待开工 | AT-08 / AT-09 / AT-20 / AT-21 / AT-23 |
| 7 | 匿名评价 / 收费一致性 / 自动重开 | ⬜ | AT-10 ~ AT-12 / AT-24 |
| 8 | 短信回执 / 重试 / SmsLog | ⬜ | AT-06 |
| 9 | SLA / 看板 / 报表 / Excel 导出 | ⬜ | AT-15 + 口径核对 |
| 10 | 全量测试 / 安全检查 / 生产部署 | ⬜ | 以下 26 项测试全绿；**且必须完成「生产发布形态评审」**（见 Phase 10 节） |

> ✅ **Phase 2 状态口径（2026-09-20 补签 PASS）**
> Phase 2 = **PASS**。服务端底座（模型 / 三级权限 / 门店隔离 / 原子取号 /
> 状态机 / 事件 / 参数）真机通过、三套校验 43 + 56 + 64 = **163 项全绿**。
> 曾因 DEV-PLAN 自己写的门槛「并发 100 次取号无重复、无空洞」未验证而判为 HOLD
> —— 当时唯一能触发取号的入口是 Phase 3 的「创建工单」，Phase 2 无对外接口，
> **故意不造这个绿灯**（用 SQL 直连取号器属于自欺欺人）。
> **该挂起项已在 Phase 3-I 解除**：`scripts/verify-concurrency-phase2.mjs` 经真实 HTTP 全链路，
> **8 条断言全绿、退出码 0**（证据见 `docs/PHASE-2.md` §7.3）。
> 补做时**没有**用 SQL 直连取号替代压测，也**没有**为变绿而调低/关闭频控与幂等。
>
> ⚠️ **PASS 的边界**：指的是"验收门槛已满足"，**不代表** Phase 2 §5.1 的后台页面缺口已补
> —— 那项按裁定重排期至 Phase 4，仍是未交付状态（见 Phase 4 的强制条款 1）。

---

## Phase 1 — 项目初始化与可启动

**目标**：一条命令拉起 postgres + nocobase + nginx，插件已加载，健康检查通过。

**产出**
- `Dockerfile`（基于 `scripts/expected-versions.mjs` 里冻结的镜像 tag，**不从本文取版本号**；COPY 插件并构建）
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

**状态：✅ PASS（2026-09-20 补签）—— 功能开发完成，验收门槛全部满足**
详见 [`docs/PHASE-2.md`](PHASE-2.md)；整改执行情况见该文 §7，100 路并发取号证据见该文 §7.3。

已达成（真机 + 三套校验 43 + 56 + 64 = 163 项全绿）：
- AT-03 通过：原生接口与 `/api/svc` 两条路径都隔离，且 get 他店返回 **404**（非 403/500）
- 服务端底座全部落地：三级权限（全局 action → 资源级授权 → 字段白名单）、双层门店隔离、原子取号、状态机 M1/M2/M6/M7、事件必写、参数配置
- 本阶段修掉 10 个"不报错但不生效"的缺陷（DEV-18 ~ DEV-27），其中 DEV-23 含**真实凭证泄露**（`fields=null` 导致 `feedback_token_hash` 被整行下发）
- **「并发 100 次取号无重复、无空洞」✅ 已通过**（Phase 3-I，2026-09-20）：真实 HTTP 全链路 8 条断言全绿、退出码 0；100 路 `201×100`、编号连续无空洞、取号器增量恰为 100

**仍未交付（属排期缺口，不影响本 Phase 的 PASS 判定）：**
- ⚠️ 后台页面、`storeUsers` 用户映射、`tasks/` + `sms/` 内容留待后续阶段（见 §Phase 4 的交付期约束）。
  **注意**：Phase 2 的 PASS 指"验收门槛满足"，**不包含**这些缺口；它们仍是未交付状态，不得因为 PASS 而被顺带说成"已完成"。

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

**状态：✅ 完成**
（2026-09-20 A→I 全部交付 · 2026-09-21 阶段内验收并入 `smoke-test.mjs` 总闸 · 2026-09-21 完成 **Phase 3.1 重复单修正**）

**交付顺序（A → I，不得跳步；I 是 Phase 2 挂起项的唯一解除手段）**

| 步 | 内容 | 完成判据 | 实况 |
|---|---|---|---|
| A | `GET /api/public/stores` | 只回 `code`/`name`，不回内部 id 与其他门店信息（以 `docs/API.md` §1.1 为准，**不含 `region`**，见 DEV-33） | ✅ 真机 15 家门店，仅 2 字段 |
| B | `POST /api/public/tickets` | 按 `docs/API.md` §1.2 返回 `{ticket_no, store_name, created_at}`；**不返回 `id`/处理人** | ✅ 响应恰好 3 字段 |
| C | `GuardService`（IP / 手机号 / 重复单 / 幂等） | 四类守卫各自可被独立断言点亮 | ✅ 四类守卫均有点亮断言 |
| D | `request_id` 幂等（`idempotencyRecords`） | 重放返回首个 `ticket_no`，且不消耗序号 | ✅ 重放逐字节一致，序号增量 0 |
| E | IP / 手机号频控 | 超频返回 **429**（阈值取 `serviceSettings`，不写魔法数） | ✅ 429 + `Retry-After` |
| F | 重复单识别（同号 + 同店 + 同类型 + **同事项文本** + 时间窗） | 命中返回原单，不新建 | ✅ 409 `DUPLICATE_TICKET` + 原单号，**不消耗序号**<br>⚠️ **Phase 3.1 修正**：原实现只比 手机号+门店+类型+时间窗，**漏了 PHASE-0 §9.4 明文要求的"事项文本"**，于是"同客户在同店 10 分钟内分别报修空调和冰箱"这种合法场景被当成重复单挡死。已补确定性 `normalizeContent()`（NFKC → 去标点 → 去空白 → ASCII 小写），见 **DEV-36** |
| G | 隐私说明与勾选（`privacy_agreed` 强校验） | 未勾选一律 400 | ✅ 400 `PRIVACY_NOT_AGREED` |
| H | `/report` Vue3 H5（含 `/report/success`） | 手机端可用；连点 10 次只产生 1 单 | ✅ `verify-phase3-h5.mjs` **35 项全绿** |
| **I** | **100 路真实 API 并发取号验收** | `node scripts/verify-concurrency-phase2.mjs` **8 条断言全绿 → 补签 Phase 2 PASS** | ✅ **8 条全绿、退出码 0 → Phase 2 已补签 PASS** |
| 末 | Phase 3 自身的 AT-01 / AT-02 / 重复提交 / 限流验收 | 并入 `smoke-test.mjs` | ✅ **已完成** → `smoke-test.mjs` §4c 共 **12 项**（门店列表最小披露 / 建单 201 恰好三字段 / 幂等重放 / 隐私 400 两形态 / 缺请求号 422 / 重复单 409 / **应用层 429** / **Phase 3.1 判重 A~E 五项**），总闸 **76 项全绿** |
| 3.1 | 重复单识别补"事项文本"维度 + A~E 断言并入总闸 | 同客户不同事项可各建一单；完全相同内容仍 409 且不消耗序号 | ✅ **已完成**（2026-09-21）：见 `docs/PHASE-3.md` §「Phase 3.1 重复单修正」；总闸 76 项全绿 |

**产出**：`h5/` 工程（Vite + Vue3 + TS）、`/report` 页面、`/report/success`、`POST /api/public/tickets`、`GuardService`（IP/手机号/重复单/幂等）、隐私说明与勾选、`/api/public/stores`。
**验收**：AT-01 / AT-02；连点 10 次只产生 1 张工单；超频返回 429。
→ 三条均已落地为可复跑脚本：前两条分别由 `verify-phase3-h5.mjs`【2】（提交器 single-flight）与【3】
（同一 `request_id` 并发 10 路 → `201×1 + 200×9`）覆盖；第三条 + 服务端契约并入总闸 `smoke-test.mjs` §4c。

> 📌 **并入总闸时实测到的一条反直觉事实（值得记住）**：走 nginx 连发 45 次同一 `request_id`，
> 只有 **11 次**能过闸（`1×201 + 10×200`），第 12 次起就是 **nginx 自己的 429**，
> 而那一刻应用层 `guardQuota.used` 才 **11**（阈值 30）。
> 即 `limit_req rate=30r/m burst=10 nodelay` 的真实含义是「**11 次突发 + 0.5 次/秒回填**」，
> 不是"一分钟能打 30 次"。
> 两个后果：① **nginx 才是先卡住的那层** —— 只看应用层阈值会误判"频控没生效"；
> ② 想走 nginx 打满应用层阈值需约 60 秒，且会把网关桶打空、让**下一轮**验收全红。
> 因此 `smoke-test.mjs` §4c 的 429 断言改用「库里阈值临时降到 2 + 3 个请求」，
> 全程 3 次请求、无冷却、可重复，顺带验到"阈值来自库、10s TTL 内生效、不需要重启"（DEV-31）。
> nginx 那层 429 的语义由 `verify-config.mjs` 静态覆盖（`limit_req_status 429` + JSON 错误体）。
> ⚠️ 两种 429 **必须能区分**：网关的是 `{"code":"TOO_MANY_REQUESTS"}`，
> 应用层的是 `{"errors":[{"code":"RATE_LIMITED",...}]}` —— 混同会让"网关拦了"读成"频控生效了"。

**Phase 3 暴露并修掉的缺陷**：`DEVIATIONS.md` **DEV-28 ~ DEV-33**。其中最值钱的一条是
**DEV-32**（同 `request_id` 并发各取各号：手机号日额度被打满 + 工单号出现空洞）——
它是"用户自己能触发"的真实缺陷，而前端 single-flight **挡不住**（弱网重试 / 多标签页 / 狂点刷新都会绕过它）。

> ⚠️ **两个"看起来像产品缺陷、其实是环境/脚本"的坑**（已在文档里纠正，避免下次重踩）：
> ① `PHASE-2.md` §7.2 原文教人"改 `.env` 再重启"来放宽 IP 阈值 —— **无效**，
> 生效值在 `service_settings` 表里（`.env` 只决定首次种子），且 nginx 还有**第二层**限流（见 **DEV-31**）；
> ② `verify-concurrency-phase2.mjs` 首次真跑时，前两条红灯是**脚本自己**造的
> （探测请求复用了压测号段的手机号 → 被重复单规则正确拦成 409；断言 6 的 SQL 写了 `GROUP BY 1`），
> 只有第三条才是真缺陷。**修断言之前先确认"产品是不是本来就该这样"。**

**前置条件**：业务方给出「门店用户账号清单与门店归属」（`docs/PHASE-2.md` §8 第 2 项），否则 `storeUsers` 种子继续缺失，门店侧验收仍只能靠临时账号。

---

## Phase 4 — 派工 / ServiceVisit / 双短信

**状态：🟢 PASS —— 已关闭，允许进入 Phase 5**（2026-09-23 复核方裁定）

| 部分 | 裁定 |
|---|---|
| **服务层 A~G + 总闸 J** | ✅ **PASS** —— 92 项总闸全绿（含 §4d 16 条），提交 `453570e` |
| **DEV-45**（旧 Token 失效的表达形态） | ✅ **已接受偏差 / ACCEPTED** —— 保留 `200 + {valid:false}`，**无需改代码**；401 归还给 Phase 5 认证接口（见 §J） |
| **H 后台页面 / I 真人 UI 走查** | ✅ **已交付并关闭** —— 四张页面已落库、五个自定义按钮真实渲染；真人走查共四轮：首轮 BLOCKED（DEV-68/69）→ 第二轮 P0×1+P1×2（DEV-70~73）→ 第三轮详情 404（DEV-74）→ **第四轮复测 PASS**。详见 `docs/PHASE-4.md` 头部状态块与 §13 |

**产出**：`dispatch` / `reassign` / `reschedule`；`VisitService` 建 Visit + `visit_no` 并发取号；`TokenService` 生成师傅 Token；`SmsService` + `SmsProvider` 抽象 + `MockSmsProvider` + `AliyunSmsProvider`；`SmsLog` 写入；事件 `dispatched/rescheduled/reassigned`。
**验收**：AT-04 / AT-05；**改派后旧 Token 必须立即失效** —— Phase 4 内部 `tokenCheck` 诊断探针以 `200 + {valid:false, code:'TOKEN_INVALID'}` 证明失效；Phase 5 正式师傅匿名接口使用失效 Token 必须返回 `401 TOKEN_INVALID`。

> ⚠️ **本条是语义要求，不写死探针状态码**（2026-09-21 复核方裁定，见 §J）。
> 早期版本把条款写成"改派后旧 Token 立即 **401**"—— 那是把**诊断查询**的返回值当成了**认证失败**的返回值，
> 会制造"实现其实正确、规格文字制造假红灯"的假故障。

### 执行顺序（A→J，逐项验收）

| 步 | 内容 | 关键不变式 | 状态 |
|---|---|---|---|
| A | `TokenService`：师傅 Token 生成 / 校验 / 失效 | 只存 `sha256`；失败一律 `TOKEN_INVALID`（不区分不存在/已用/已过期，防枚举） | ✅ |
| B | `VisitService`：建 Visit + `visit_no` 事务内取号 | `unique(ticket_id, visit_no)`；师傅姓名/手机号/预约时间是**快照**，改派不覆盖历史 | ✅ |
| C | `SmsService` + `SmsProvider` 抽象 + `MockSmsProvider` + `AliyunSmsProvider` + `SmsLog` | `TicketService` **不得**直接依赖阿里云 SDK；`accepted` 只写"已受理"，`delivered` 只能由回执写 | ✅ |
| D | `dispatch`（M3） | 同一事务写：Ticket 状态 + Visit + Token + `dispatched` 事件 | ✅ |
| E | `reassign`（M4） | **旧 Visit → `SUPERSEDED`（原样保留）+ 新建 Visit**；旧 Token 立即失效 + 新 Token；三条短信（客户 / **新**师傅 / **原**师傅取消通知） | ✅ |
| F | `reschedule`（M5） | **不新建 Visit**；改 `expected_visit_at` + **旧 Token 失效 → 换发新 Token** | ✅ |
| G | 事务边界与"半成功状态"防护 | 见下方「事务边界」小节 | ✅ |
| H | 后台 UI：我的门店工单 / 全量工单 / 工单详情（时间线 + **Visit 派工历史/状态区块**） | 门店范围**继续走服务端权限**，前端不传 `store_id` 过滤；**Visit 区块本期只做「查看派工历史与状态」，不含 Phase 6 的门店确认 / 驳回 / 照片审核 / 收费确认** | ⬜ **未交付（强制条款 1）** |
| I | **真实售后人员 UI 走查**（派工 / 改派 / 改约） | **必须由真人操作**并记录走查人与走查时间；不得只用 `curl` 下结论 —— **自动化浏览器脚本（Playwright 等）不能替代真人走查，只能作为补充** | ⬜ **未交付（强制条款 2）** |
| J | Phase 4 断言并入 `smoke-test.mjs` 总闸 | 含"改派后旧 Token 失效" | ✅（断言已并入，共 16 条；见下方 §J 说明） |

> ⚠️ **E 步措辞已更正**：上一版写作"同 Visit 换师傅 + 新 Token；Visit 历史不覆盖" —— 这两句互相矛盾。
> 本阶段锁定的语义是 **改派 = 终止旧 Visit + 新建 Visit**（旧行一个字段都不改），
> 让"返工过程可追溯"成为**数据模型的必然结果**，而不是靠人记得别覆盖。
> 代价是 `visit_no` 会随改派增长，因此加了"责任人未变化时拒绝改派（`SAME_RESPONSIBLE_PARTY`）"这道闸。

### §J 说明：「401」形态**已裁定为语义要求**（2026-09-21 复核方接受，无代码改动）

| 项 | 内容 |
|---|---|
| 已并入 | `smoke-test.mjs` §4d 共 **16 条** Phase 4 断言（真机全绿，见 `docs/PHASE-4.md` §5）。含核心硬门槛：**同一 Token 在改派前 `valid:true`、改派后 `valid:false`**（同一实例、同一工单、同一 Token，排除"整条链路坏了"的可能，并带新 Token `valid:true` 的反向对照） |
| **裁定结果** | **复核方于 2026-09-21 明确接受当前实现，不要求把 `tokenCheck` 改成 401。** 理由：`tokenCheck` 本质是"**总部已登录人员询问某个师傅 Token 是否有效**"的**诊断查询**，不是拿这个师傅 Token 去做认证 —— 查询本身成功了（`200`），查询的结果是"无效"（`valid:false`）。若强行返回 401，就会混淆"**总部操作者自己的登录态无效**"与"**被检查的师傅 Token 无效**"这两件完全不同的事 |
| 探针的三重约束（已实现） | ① 要求**总部特权**角色（非特权一律 403）；② **仅在 `sms.provider=mock` 时存在**，真实通道直接 **404**；③ 内部失效原因（过期 / 已用 / 被改派 / Visit 非活跃）**不外露**，一律 `TOKEN_INVALID` |
| **401 的正确位置** | **Phase 5** 的 `GET /api/technician/visits/:token` —— 那里师傅 Token **本身就是访问该资源的认证凭证**，"Token 无效"就等于"你未被认证"，`401` 才是准确语义。硬验收矩阵见 §Phase 5 |
| 条款措辞已改 | 本 Phase 的验收行与本节均已由"立即 **401**"改为**语义要求**（见上方 §验收 行的引用块），避免规格文字再次制造假红灯 |
| 为什么仍保留本节 | 它曾是一条"复核方点名条款 vs 实际交付形态不同"的显式悬挂项。**裁定完成后继续保留**，因为它示范了一条通用规则：**诊断接口的返回值不该借用认证失败的状态码** |

### ⚠️ 本阶段的高风险闸门（复核清单）

用户（独立复核方）在授权本阶段时点名的风险点，逐条必须给出**可复现的断言证据**（下表"证据"列指向 `smoke-test.mjs` §4d 的断言序号）：

| # | 闸门 | 证据 |
|---|---|---|
| 1 | 首次派工与改派必须创建/保留 ServiceVisit 历史，不得覆盖上一位师傅的数据（快照语义） | §4d ①⑦⑮：Visit #1 的 `technician_mobile` 在改派后仍是原师傅；新行 `reassigned_from_visit_id` 指回旧行；链无断点 |
| 2 | **改派后旧 Token 必须立即失效**（本阶段硬门槛） | §4d ⑧：同一 Token 由 `valid:true` → `valid:false`；库内 `token_revoked_reason=reassigned` 且 `token_revoked_at` 已置 |
| 3 | 改约若重新生成 Token，旧 Token 同样必须失效 | §4d ⑩：改约后旧 Token `TOKEN_INVALID`、新 Token `valid:true`，且 **Visit 数不变** |
| 4 | 客户短信与师傅短信必须是两个独立 scene，不得混用模板 | §4d ②⑨：首次为 `dispatch_customer`+`technician_task`；改派为 `dispatch_update`+`technician_task`+`technician_assignment_cancelled`（三个不同 scene、三个不同收件人） |
| 5 | `SmsProvider` 必须保持抽象：`TicketService` 不得直接依赖阿里云 SDK | 静态：`services/` 下无 `@alicloud/*` 依赖，三个实现经 `createSmsProvider()` 注入；离线 §4d 经 mock 通道取证 |
| 6 | 短信返回 `accepted` 只能记"已受理"，绝不能记 `delivered` | §4d ③：所有 `accepted` 行的 `delivery_status` 恒为 `pending`；`delivered` 行数 = 0；类型上 `SmsSendResult.deliveryStatus` 钉死为字面量 |
| 7 | 派工状态 / Visit / Token / TicketEvent / SmsLog 的事务边界（防"半成功"） | §4d ⑫：被拒绝的改派零副作用（Visit/事件/短信三者计数不变）；离线：`enqueue` 在事务内、`flush` 在提交后 |
| 8 | 后台 UI 的门店数据范围必须继续使用服务端权限，不得改成前端传 `store_id` 过滤 | §4d ⑭：门店用户派**他店**工单 → 404，且他店工单上**没有**产生 Visit；反向对照（本店工单）走到业务语义 409 |
| — | 附加：短信通道未就绪时不得阻断业务 | §4d ⓿：`sms.enabled=false` 时派工 200、Visit 已建、两条短信如实记 `rejected` + `SMS_DISABLED` |

### 事务边界（设计决策，G 步落地）

| 边界 | 决策 | 理由 |
|---|---|---|
| Ticket 状态 + Visit + Token + `dispatched` 事件 | **同一事务** | 四者任一缺失都会造成"显示已派工但实际没有可执行 Visit"的半成功态；放同一事务后该状态在物理上不可能出现 |
| 短信发送（外部 HTTP 调用） | **事务提交后**执行 | 外部调用不可回滚，且放事务内会持锁等网络（慢供应商直接拖垮派工吞吐） |
| `SmsLog` 落库 + `sms_sent`/`sms_failed` 事件 | **短信发送后的独立事务** | 短信失败**不得**回滚已成功的派工（师傅已在路上，回滚比通知失败更糟）；但必须留痕且**在 UI 可见**（工单"通知异常"标记），不允许静默 |
| `VisitService.create` 的取号 | 在**调用方事务内**（不做自己的事务） | 取号与 Visit 插入必须原子；服务自身开事务会形成嵌套事务，掩盖边界 |

### ⚠️ Phase 4 的强制交付条款（后台页面不得再延期）

1. **后台业务页面必须在本 Phase 完成前交付**：我的门店工单（状态 Tab）/ 全量工单 / 工单详情（含事件时间线区块）/ **Visit 派工历史与状态区块**。Phase 2 的该缺口**只允许重排期到本 Phase，不允许继续顺延**。
2. **Phase 4 验收必须包含真实售后人员的 UI 走查**：派工 / 改派 / 改约的验收**不得只用 `curl` 或 API 断言下结论** —— 必须由真实售后人员在浏览器页面上完整走一遍，并记录走查人与走查时间。
3. 走查发现的可用性问题与本 Phase 的功能缺陷**同等对待**：未关闭不得进入 Phase 5。
4. **「真人走查」不可用自动化替代**（2026-09-21 复核方明确）：Playwright / Selenium 之类自动化浏览器脚本**可以额外做**（用于回归），但**不能作为 I 的验收证据** —— 本条款要的是"**实际人员使用后的可用性验证**"，自动化脚本无法产出"人在真实操作中卡在哪一步"这类结论。

#### H 的交付范围（**不得越界到 Phase 6**）

> ⚠️ **命名陷阱**：Visit 区块**本期只做「查看派工历史与状态」**。
> 不要因为看到"Visit 区块"就提前把 Phase 6 的**门店确认 / 驳回、照片审核、收费确认**做进来 —— 那些仍属于 Phase 6。
>
> 本期 Visit 区块展示：`visit_no` / `visit_status`（`ASSIGNED` / `SUBMITTED` / `SUPERSEDED` / `CANCELLED`）/
> 师傅姓名与手机号（**快照**）/ 预约时间 / `reassigned_from_visit_id` 指向的上一次派工 /
> `token_revoked_reason` 反映的链接失效原因。**只读，不提供审核动作。**

#### I 的走查脚本（必须在浏览器里逐屏走完的链路）

| # | 身份 | 操作 | 期望可见结果 |
|---|---|---|---|
| 1 | 门店售后账号 | 登录 → 进入「我的门店工单」 | 只看到**本店**工单 |
| 2 | 门店售后账号 | 打开一张 `NEW` 工单 → 点「受理」 | 状态变为已受理（`PROCESSING`） |
| 3 | 门店售后账号 | 派工给**王师傅** | 页面出现 **Visit #1**，状态 `ASSIGNED` |
| 4 | 门店售后账号 | 改派给**李师傅**（填原因） | **Visit #1 仍在**且显示 `SUPERSEDED`；**Visit #2** 显示 `ASSIGNED` |
| 5 | 门店售后账号 | 对 Visit #2 改约（改预约时间） | **Visit 数量不增加**（仍为 2 条） |
| 6 | 门店售后账号 | 查看工单详情的**事件时间线** | 全过程按序可见（受理 → 派工 → 改派 → 改约） |
| 7 | **总部账号** | 进入「全量工单」 | 能看到**所有门店**的工单 |
| 8 | **另一门店账号** | 进入「我的门店工单」 | **看不到**上面那家店的工单 |

> 第 7/8 条是**数据范围**的真人验证。服务端权限已由 §4d ⑭ 在 HTTP 层证明（他店 404），
> 但本条要证明的是"**页面上**也不会漏出来"。
>
> ⚠️ 第 7/8 条需要**至少两个门店**的账号，这依赖 `storeUsers` 门店用户映射种子（业务方账号清单仍未给到）。
> 若走查时种子仍未就绪，可用临时建号完成走查，但**必须在走查记录里注明"账号为临时创建"**。

---

## Phase 5 — 师傅 H5

**状态：🟢 PASS（阶段已关闭，2026-09-25）**

| 子阶段 | 状态 |
|---|---|
| P5-0 Routing & Environment Gate | ✅ **PASS**（`7b7e232`） |
| P5-1 Technician API / H5 / Security | 🟢 **PASS**（正式交付基线 `297e728`，用户 2026-09-25 裁定） |
| P5-2 Mobile Human UAT | 🟢 **PASS** —— 真人已跑通核心链路（提交成功 · 无卡点 · 重开链接失效）；唯一条件项 **DEV-82**（说明条件必填）已收口（`14c5b1a`）。见 `docs/PHASE-5-P5-2-UAT.md` §8 / §8.4 |
| **Phase 5** | **🟢 PASS（阶段已关闭）** —— 关闭记录见 `docs/PHASE-5.md` §14 |

**产出**：`/technician/visit/:token` 页面；`GET /api/technician/visits/:token`；`POST .../files`（私有存储 + magic bytes + 去 EXIF + 受控读取）；`POST .../submit`（收费校验）；提交后置 `WAIT_STORE_CONFIRM` 且**不发评价短信**。
> ⚠️ **路径口径（2026-09-23 随 P5-0 落实，勿混用）**：H5 部署在 `/h5/`（`BASE`），应用内路由是
> `/technician/visit/:token`，因此**对外完整 URL 为 `/h5/technician/visit/:token`**；
> 而**短信里出现的是更短的 `/t/:token`**，由 nginx `302` 转到上面那条（方案 A，见 `docs/API.md` §2.0）。
**验收**：AT-16 ~ AT-19 / AT-22。

**🔒 硬验收：Token 失效矩阵（逐条判定，必须在 **HTTP 层**取证，不得用单测替代）**

| # | 场景 | 预期 |
|---|---|---|
| 1 | Visit #1 的 Token A，在改派发生**前**访问师傅接口 | `200` |
| 2 | **同一条 Token A**，在改派发生**后**再访问 | `401 TOKEN_INVALID` |
| 3 | 新 Visit #2 的 Token B 访问 | `200` |
| 4 | **已过期** Token | `401 TOKEN_INVALID` |
| 5 | **已使用**（已提交回执）Token | `401 TOKEN_INVALID` |
| 6 | **随机不存在** Token | `401 TOKEN_INVALID` |

> 对外**一律只返回 `TOKEN_INVALID`**，不让师傅端区分"被改派撤销 / 过期 / 已使用 / 不存在" ——
> 维持 Phase 4 已确立的**防枚举**原则。
> 第 2 条正是 Phase 4「**改派后旧 Token 必须立即失效**」这条语义在**正式业务接口**上的落地形态：
> Phase 4 用 `tokenCheck` **诊断探针**证明（形态 `200 + valid:false`），Phase 5 用**认证接口**证明（形态 `401`）。
> 两者形态不同、语义一致 —— 理由见 §Phase 4 的 §J 说明。

**前置依赖**：✅ **已满足**（2026-09-23）—— Phase 4 的 H（后台页面）与 I（真人 UI 走查）均已关闭，
Phase 4 整体 PASS。本阶段计划见 `docs/PHASE-5.md`。

---

## Phase 6 — 门店确认 / 驳回 / 多次 Visit

**状态：🟡 进行中（2026-09-25 启动）** —— 起点 = Phase 5 终点 **`WAIT_STORE_CONFIRM`**。
**计划与契约见 `docs/PHASE-6.md`**（不再改 Ticket/Visit 模型；`SUBMITTED → [CONFIRMED, REJECTED]` 等迁移与字段**已预留**）。

| 子阶段 | 范围 | 硬验收 |
|---|---|---|
| **P6-0** Store Review Read Model & Photo Access Gate | 只做**读**：门店回执读模型（I11）+ **私有照片受控读取闸门**（I14）；**不写确认/驳回**。**机器门 🟢 全绿（2026-09-25）**，证据 `docs/PHASE-6-P6-0-EVIDENCE.md`；仅剩 U1 人眼走查（`docs/PHASE-6-P6-0-UAT-SHEET.md`） | `docs/PHASE-6.md` §5 **照片访问四边界矩阵**（本店 200 / HQ 200 / 跨店 404 / 匿名 401）+ 反向用例 |
| **P6-1** Store Confirm / Reject Transaction | 写 `confirm`（M9）/ `reject`（M10）；含并发（陈旧页面不得覆盖）与幂等 | `docs/PHASE-6.md` §7 |
| P6-2 | 门店审核 UI 收口（按钮 + 视觉 + 真人复核） | 待 P6-1 后定 |

**产出**：`confirm`（含金额调整必填原因、生成评价 Token、发评价短信）/ `reject`（保留 Visit 与照片）/ `remoteComplete`；工单详情页 Visit 审核区块（照片预览、金额、确认/驳回）。
**验收**：AT-08 / AT-09 / AT-20 / AT-21 / AT-23。

> ⚠️ **首个硬问题 = 照片读取权限**（用户 2026-09-25 点名）：在写"确认/驳回"按钮**之前**，
> 先证明**门店授权用户能安全查看本工单照片**，而**未授权门店 / 匿名 / 跨店用户不能靠猜 URL 或 photoId 拿到照片**。
> 方向锁定：`登录身份 → storeScope/HQ 权限 → Ticket↔Visit↔Photo 归属验证 → 受控读取 / 短时签名响应`，
> **绝不**把 Phase 5 的私有照片改成永久 public URL。

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
