# Phase 2 交付报告 — 数据模型 / 权限 / 工单底座

> 对应 `docs/DEV-PLAN.md` 的「Phase 2 — 数据模型 / 权限 / 工单底座」。
> 本文记录**实际交付内容、进入下一阶段的门槛、真机证据、踩过并修掉的坑**，
> 以及**尚未完成/待业务方确认**的部分。所有数字均可在真机复跑（命令见 §6）。
>
> ## ✅ 当前状态：**PASS（正式验收已通过，2026-09-20 补签）**
>
> 独立验收（用户，2026-09-20）曾判定 **Phase 2：HOLD**，唯一挂起项是
> 「100 路真实并发取号」（原始验收门槛，Phase 2 自身没有对外接口能触发取号）。
> 该挂起项已按 §7.2 的契约在 Phase 3-I 补做，`scripts/verify-concurrency-phase2.mjs`
> **8 条断言全绿、退出码 0**（证据见 §7.3），因此 Phase 2 **补签为 PASS**。
>
> | 项 | 状态 |
> |---|---|
> | 架构与业务路线是否偏离 | **否**，无需重构（11 项已确认设计见 `docs/DEV-PLAN.md` §「Phase 2 已确认不重构的设计」） |
> | 服务端底座（模型/权限/自动取号/状态机/事件/参数） | ✅ 真机通过 |
> | AT-01 / AT-02 / AT-03 等阶段内验收 | ✅ 通过（当时 `smoke-test.mjs` 真机 64 项全绿；Phase 3 收尾后为 71 项，见 `CHANGELOG.md` §Phase 3 收尾） |
> | **100 路并发取号（DEV-PLAN 原始门槛）** | ✅ **已通过**（2026-09-20，8 条断言全绿、退出码 0，见 §7.3） |
> | 后台页面（我的门店工单 / 全量工单 / 工单详情 / 事件时间线） | ⏳ 重排期，**最迟 Phase 4 完成前交付**（见 §5） |
>
> **PASS 的边界（必须与"全部完成"区分开）**：PASS 指的是
> **验收门槛（含 100 路并发取号）已全部满足**，不代表本文 §5 的
> "后台页面"缺口已补 —— 那一项按用户裁定重排期，仍是**未交付**状态。
>
> 补签时同步更新：`docs/DEV-PLAN.md`、`README.md`、`CHANGELOG.md`。
> 相关新偏离记录：`docs/DEVIATIONS.md` DEV-28 ~ DEV-33。

---

## 1. 本阶段目标与达成情况

| 计划产出 | 状态 | 说明 |
|---|---|---|
| 11 张 collection 定义（含索引与唯一约束） | ✅ | 比计划的 9 张多 2 张（见 DEV-11）；索引由 `ensure-indexes.ts` 兜底（见 DEV-16） |
| `storeUsers` 多对多 + 种子数据（15 门店 + 用户映射） | ⚠️ 部分 | 门店种子 15 家已落（**占位清单**，见 DEV-21）；**用户映射未落** —— 依赖业务方给出的账号清单与门店归属 |
| `storeScope` 中间件、`PermissionService`、对象级鉴权 | ✅ | 双层隔离：框架层（中间件）+ 对象级（服务层），缺省一律 fail-closed |
| ACL 角色与字段只读配置 | ✅ | 比计划多一层：**三级**判定（全局 action → 资源级授权 → 字段白名单），见 DEV-23；字段白名单已"受管"化（见 DEV-24） |
| `TicketService` / `EventService` / `SequenceService` / `ConfigService` | ✅ | 4 个动作 M1/M2/M6/M7；事件与状态同事务；取号为 PG row-lock upsert |
| 后台页面（我的门店工单 / 全量工单 / 工单详情） | ❌ **未做** | 见 §5「已知缺口」—— 允许重排期，但**最迟 Phase 4 完成前必须交付可操作页面** |
| 定向测试：门店隔离 / 取号并发 / 事件必写 | ✅ | 已并入 `scripts/smoke-test.mjs` 的 §4b（9 项），不再是独立临时代码 |

**验收门槛结论：已全部达成**（2026-09-20 补做 §7.3 后，原唯一挂起项已解除）。

- ✅ **已达成的门槛**：`AT-03` 通过（门店 A 用户经**原生接口**与 `/api/svc` 两条路径都无法看到门店 B 工单，且 get 他店返回 404 而非 403）；事件必写通过；参数配置真机通过；三级权限与字段白名单通过（真机 64 项冒烟全绿）。
- ✅ **100 路并发取号**：原为挂起项（Phase 2 没有任何对外接口能触发取号，唯一入口是 Phase 3 的"创建工单"，因此本阶段**故意不造这个绿灯**，理由见 §3.4）。已在 Phase 3-I 经真实 HTTP 全链路补做，**8 条断言全绿、退出码 0**，证据见 **§7.3**。
- ⏳ **未达成的门槛**：后台页面未交付（重排期，最迟 Phase 4）。

---

## 2. 交付物清单

### 2.1 服务端模块（`nocobase/plugins/service-ticket/src/server/`）

| 模块 | 职责 | 关键约定 |
|---|---|---|
| `services/permission-service.ts` | 对象级鉴权 + 门店数据范围 + 脱敏 | 铁律：服务端强制 / fail-closed / **越权与不存在返回同一个结果（404）** |
| `services/ticket-service.ts` | 工单状态的**唯一**写入口 | 乐观并发 = 条件 UPDATE + 影响行数为 0 即冲突（409） |
| `services/event-service.ts` | `ticketEvents` 的**唯一**写入口 | 校验 event_type 白名单；状态变更事件必须带 `to_status` |
| `services/sequence-service.ts` | 工单号 / 上门序号原子取号 | 单条 SQL `INSERT … ON CONFLICT … DO UPDATE RETURNING`，并发下无重复无空洞 |
| `services/config-service.ts` | `serviceSettings` 的**唯一**读取入口 | 短 TTL 缓存（10s）；缺键回落代码默认值并告警，不抛错 |
| `middleware/store-scope.ts` | 原生接口的框架层门店隔离 | 给 list/update/destroy 注入范围条件（用 `$and` 叠加，不覆盖调用方 filter） |
| `actions/svc/ticket.ts` | 4 个内部业务 action | 固定四步：解析操作者 → 能力校验 → 对象级校验 → 服务层写库 |
| `actions/svc/_http.ts` | 错误信封 / `X-Request-Id` / 异常→HTTP 映射 | 与错误类的 `logLevel` 同口径（见 DEV-20） |
| `actions/public/health.ts` | `/api/svc:health` | 只回稳定三字段 + 诊断计数器，不回连接串/堆栈 |
| `seeds/{settings,stores,roles,apply}.ts` | 参数 / 门店 / 角色与授权种子 | 一律**只增不改**；`repairUnsafeActionFields()` 负责安全自愈 |
| `migrations/20260920-{baseline-seed,role-resource-grants}.ts` | 给**已安装实例**补数据 | 迁移跑过不重跑，因此自愈另挂 `afterLoad`（见 DEV-23） |
| `ensure-indexes.ts` | 索引兜底补齐 | 语义等价比对（列集合 + 唯一性），只增不删，失败抛错阻断启动 |

### 2.2 权限模型落库形态

```
roles                          ← 4 个业务角色（hq_admin / store_manager / store_service / viewer）
  └─ dataSourcesRoles          ← ① strategy.actions 全局 action 白名单
       └─ dataSourcesRolesResources        ← ② 逐资源授权（4 资源 × 4 角色 = 16 行）
            └─ …ResourcesActions           ← ③ 逐 action 行（16 × 2 = 32 行）
                 └─ fields = [ORM 属性名…] ← 字段级白名单（serviceTickets 33 列，已排除 3 个敏感列）
```

三级**缺任何一级都表现为"不报错但不生效"**：缺 ① → 该角色全员 403；缺 ② → 每张表 403；③ 为 `null` → **整行下发（凭证泄露）**、为 `[]` → 空壳（业务列全丢）。详见 DEV-23。

---

## 3. 验收项与证据

`scripts/smoke-test.mjs` 的 `§4b Phase 2 验收` 共 8 项，全部通过（真机）：

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 四个业务角色都拿到 4 张表的资源级授权 | 4 角色 × 4 资源 × 2 action 齐全 |
| 2 | 字段白名单非空、不含敏感列、不含数字索引 | 32 条 action 行全部安全（696 个字段授权，0 处敏感列） |
| 3 | 白名单用的是 ORM 属性名 | 33 个属性名（`store_id` ✓ / `createdAt` ✓ / 关联名 ✗） |
| 4 | **AT-03** 门店用户 `list` 只返回本店工单 | 返回 2 行全部属于 S01，含本店工单 |
| 5 | **AT-03** `get` 他店工单返回 404（不是 403/500） | 他店 404 / 本店 200 |
| 6 | 字段白名单生效：`list` 回业务列且不含 `feedback_token_hash` | 两类角色均回业务列，0 个敏感列 |
| 7 | 并发取号：重复 `accept` 返回 409 且不产生重复处理人 | 首次 200 / 重复 409（`CONFLICT_STATE_CHANGED`） |
| 8 | 事件必写：`accept` 落 `accepted` 事件；越权操作不留事件 | T_A 1 条（含 accepted）/ T_B 0 条 |

> 第 5 项为什么必须是 404 而不是 403：403 等于承认"这条工单存在"，门店用户据此可枚举出别家门店的工单规模。404 才是"看不见即不存在"。（`docs/SECURITY.md` §双层数据隔离）

### 三套校验的总量（截至本阶段）

| 脚本 | 项数 | 用途 |
|---|---|---|
| `scripts/verify-config.mjs` | **41 / 41** | 部署层静态校验：compose 安全基线、nginx 语法与变量、`.env` 交叉一致性 |
| `scripts/verify-plugin-load.mjs` | **53 / 53** | 桩环境跑完整插件生命周期：包解析、11 张表、索引声明、种子、svc 资源形态、热重载幂等 |
| `scripts/smoke-test.mjs` | **63 / 63** | 真机端到端：容器健康、nginx 路由与安全头、表与索引逐条落库、健康检查、**Phase 2 八项**、运行时稳定性 |

---

## 4. 本阶段踩过并已修复的坑（都属"不报错但不生效"型）

| 编号 | 症状 | 根因 | 修复 |
|---|---|---|---|
| DEV-18 | 按文档路径 `/api/svc/tickets/:id/accept` 注册的 action **完全不可达**（404） | `parseRequest` 对 `/api/<a>:<b>:<c>` 只 split 一次，第三段被静默丢弃 → 多段 action 名在 NocoBase 根本不存在 | action 名改单段 + nginx 重写折叠路径（对外路径不变） |
| DEV-19 | 原生接口的写操作面过大 | 资源级 ACL 无"只能改某些字段"的表达力，用 `fields` 表达会 fail-open（界面一改约束就消失） | 白名单收敛为 `list`/`get`，`create` 由中间件直接拒绝 |
| DEV-20 | 越权 404 把 app 日志打成 error，运维断言失真 | `plugin-error-handler` 按 `err.logLevel` 决定级别，不设则一律 `error` | `NotFoundError.logLevel='debug'`、`ForbiddenError.logLevel='warn'`；并加 `LOGGER_LEVEL` 开关 |
| DEV-21 | AT-03 只有一家门店时**恒真**（测了等于没测） | 缺少门店数据 | 落 15 家占位门店（**待业务方给正式清单**） |
| DEV-22 | 角色在原生接口上被隐式授予写能力 | 同 DEV-19 | `ROLE_NATIVE_READ_ACTIONS = ['list','get']`，写一律不授予 |
| DEV-23 | ① 后台每张表 403；② `viewer` 能读到 `feedback_token_hash` | ① 只写了 `strategy.actions`，没写**资源级授权**；② action 行 `fields = null` = 整行下发 | 双表同写 + `repairUnsafeActionFields()` 自愈（`null`/`[]` 一律纠正，运营自定义不碰）+ 白名单取 `model.rawAttributes` |

另有**三条校验脚本自身**的缺陷（误报会让红灯失去意义，因此一并修掉）：

- `verify-config.mjs` 原按「行」判定 nginx 指令是否以 `;` 结尾 → 把跨行的 `rewrite` 误报为漏分号；原变量检查不认**具名捕获**（`(?<svc_action>…)`）与 `$arg_*` 变量家族 → 误报 4 个未定义变量。现按「语句」判定 + 认具名捕获与前缀家族。
- `smoke-test.mjs` 的「app 日志无 error」原用整行正则扫 `\berror\b`，而框架的 4xx 日志里**必然**含 `"method":"error-handler"` → 任何 4xx 都误报。现改为解析 JSON 行、只认 `level === 'error'`。
- `smoke-test.mjs` 的「参数种子写入日志：新增 16 项」原要求日志里存在该行，但它只在 `install()`/`afterEnable()` 打 —— 容器一旦**重建**（改了 env 再 `up -d`）这行就永不出现，而 `docker restart` 保留旧日志能让它长期"蒙"过断言。现改为：有日志则断言 `created + skipped === 16` 自洽，无日志则说明是已安装实例，改由数据库 16 行兜底。

另有一条**测试工具互相污染**的缺陷（Phase 2.1 新增，属"红灯指向了错误的对象"）：

- `scripts/verify-concurrency-phase2.mjs` 原用「直接 `POST` 一次探测接口是否存在」做就绪判断。
  在 Phase 3 未实现时该请求必然 404，而 NocoBase 会为此写一条 `[Error: public resource does not exist`（**level=error**）——
  恰好落进 `smoke-test.mjs`「最近一段窗口内 app 日志无 error」的统计区间，
  于是**跑一次并发脚本 → 随后跑冒烟就出现一条与取号毫无关系的红灯**（真机复现，`63 项通过 / 1 项失败`）。
  这类缺陷最费时间：查的人会去翻取号代码，而真相是"我的测试工具多发了一个注定 404 的请求"。
  现改为**先静态、后联网**：先用「源码 public action 目录有无非 health 文件」+「编译产物**去注释后**是否含接口标记」
  做零副作用就绪门，未就位则**一个 HTTP 请求都不发**、以退出码 2 收场。
  真机验证：脚本退出码 2，`docker logs svc-app` 行数 **1936 → 1936（完全不变）**，随后冒烟 **64/64**。
  （产物侧必须**去注释**才能匹配 —— 否则 `constants.ts` 里注释掉的 `publicTicket` 规划示例会让该检查在接口一行都没实现时恒为真，门闩形同虚设。）

---

## 5. 已知缺口与限制（**不隐藏**）

### 5.1 未完成项

| 项 | 影响 | 计划 |
|---|---|---|
| 后台页面（工单列表 / 详情 / 时间线区块） | 目前后台只能通过原生接口读数据，无业务化页面 | **允许重排期，但最迟 Phase 4 完成前必须交付可操作页面**。**Phase 4 的派工验收不得只靠 `curl`/API 结论** —— 必须由真实售后人员在 UI 上走查一遍（见 `DEV-PLAN.md` §Phase 4 验收条款） |
| `storeUsers` 用户映射种子 | 门店用户的账号与门店归属尚未落库，AT-03 目前靠冒烟脚本临时造用户验证 | 待业务方给出账号清单（见 §7） |
| `tasks/` 与 `sms/` 目录 | 目录已建、**内容为空**（SLA 巡检、短信适配器属 Phase 4/7） | 按 DEV-PLAN 推进 |

**关于 DEV-PLAN 写的"并发 100 次取号无重复、无空洞"——已于 2026-09-20 补做通过：**

- ✅ 已验证：`SequenceService` 的取号实现是单条 `INSERT … ON CONFLICT … DO UPDATE … RETURNING`（PG 行锁 + upsert），从写法上排除了"先 SELECT 再 UPDATE"的 lost update；`daily_sequences` 表可正常取号（冒烟脚本实测 `current_value` 正确推进并已清理测试行）。
- ✅ 已验证：**状态机的并发保护**——同一条工单重复 `accept` 第二次返回 409 `CONFLICT_STATE_CHANGED`，不会产生两个处理人（条件 UPDATE + 影响行数为 0 即冲突）。
- ✅ **已补做（原挂起项）**：100 路并发下的编号连续性。原挂起原因是**唯一会触发取号的业务入口是"创建工单"，而它属于 Phase 3**（`POST /api/public/tickets`）——Phase 2 没有可以发起 100 路并发取号的对外接口；用 SQL 直连 SequenceService 去模拟会变成"验证 PG 而不是验证我们的代码"，属于自欺欺人的绿灯，因此当时**明确不做**。
- ✅ **补做结果（Phase 3-I，2026-09-20）**：`scripts/verify-concurrency-phase2.mjs` 经真实 HTTP 全链路（nginx → NocoBase → GuardService → TicketService/SequenceService → PostgreSQL），**8 条断言全绿、退出码 0**；100 路 `201×100`、`FW20260920-0111…0210` 连续无空洞、取号器增量恰为 100。详见 **§7.3**。**全程未使用 SQL 直连取号替代压测。**

### 5.2 明确不做（本阶段有意留白）

- 客户 H5 报修（Phase 3）、派工与上门（Phase 4/5）、门店确认与评价（Phase 6/7）。
- 原生接口的写操作（DEV-19 / DEV-22）—— 需要受限编辑能力时用自定义 action 提供，不走原生 `update`。
- HTTPS —— 依赖 Phase 10 的证书；**微信内置浏览器要求 HTTPS，上线前必须完成**。

### 5.3 探针残留与授权一致性（Phase 2.1 已解决）

- ~~`viewer` 的字段白名单是探针遗留的 7 列非空白名单，因"非空数组一律不覆盖"而保留~~ → **已解决**。
  Phase 2.1 把口径改为"**漂移即对齐**"：字段白名单是安全边界，由代码里的 `nativeReadFieldsOf()` 作为单一事实来源，不接受后台手工配置（见 DEV-24）。
- 同时清理了库里 11 条 `roleName` 为空的无主授权行，其来源已查清并登记为 **DEV-27**（`roles:update` 关联替换会脱钩旧行），并给破坏性探针加了硬门闩。
- 现状（真机实测）：**0 条无主行 / 恰好 16 条资源授权 / 32 条 action 行 / 4 张表各只有 1 种字段白名单**，且**重启后自愈日志为 0 条**（幂等）。

---

## 6. 复跑命令（每次部署后建议全跑）

```bash
# 0) 构建插件产物（改了 src 就必须重跑；产物在 storage/plugins/@local/service-ticket）
node scripts/build-plugin.mjs

# 1) 部署层静态校验（不需要应用在跑；含版本冻结断言）
node scripts/verify-config.mjs          # 期望 43/43

# 2) 插件生命周期离线校验（桩环境，不需要容器）
node scripts/verify-plugin-load.mjs     # 期望 56/56

# 3) 起容器
docker compose up -d

# 4) 真机端到端验收（--wait 会等应用就绪，首次启动约 1–3 分钟）
node scripts/smoke-test.mjs --wait 240  # 期望 71/71（Phase 3 阶段内验收并入总闸后）

# 5) 100 路真实并发取号验收（Phase 2 挂起项的唯一解除手段）
#    ⚠️ 需 Phase 3 的 POST /api/public/tickets 就位；未就位时**安全**：
#       退出码 2（环境未就绪）、零 HTTP 请求、不污染 svc-app 日志 → 随时可跑，不影响冒烟结果
#    ⚠️ 跑之前必须临时放宽 IP 频控（默认 30/分钟 < 100 并发），且**两层一起改**：
#       · 应用层 = **改库，不是改 .env**（.env 只决定首次种子，改完重启阈值纹丝不动 —— DEV-31）：
#           docker exec svc-postgres psql -U svc_app -d service_ticket -c \
#             "UPDATE service_settings SET value='1200', updated_at=now() WHERE key='security.ip_minute_limit'"
#         （ConfigService 有 10s TTL，改完等 10s 再发压，**不需要重启**）
#       · nginx 层 = svc_public rate=30r/m 与 /api/public/ 的 burst=10，另加 limit_conn svc_conn 96
#         （只放宽应用层会被网关 429，现象与"应用层频控生效"完全一样、无法区分）
node scripts/verify-concurrency-phase2.mjs
#    跑完**两层一起恢复**（脚本结尾会再提醒一次；实测恢复后 guardQuota.limit = 30）
```

排障用：

```bash
# 需要看某次越权请求的完整链路（错误处理器的 level=debug 明细）
LOGGER_LEVEL=debug docker compose up -d app
docker logs svc-app 2>&1 | grep 'error-handler"'
# 排查完务必改回：docker compose up -d app

# 应用自身诊断计数器（rolesInAcl / rolesResourcesInAcl / roleResourcesSeeded …）
curl -s http://localhost:8080/api/svc/health | jq .data

# 授权表是否与代码一致（0 条无主行 / 16 条授权 / 32 条 action）
docker exec svc-postgres psql -U svc_app -d service_ticket -c \
  'SELECT "roleName", count(*) FROM "dataSourcesRolesResources" GROUP BY 1'
```

---

## 7. Phase 2.1 验收整改（2026-09-20）

独立验收判定 Phase 2 = HOLD 后执行的整改，共 8 项。**本节的目的是让"哪些做完了、哪些还挂着"一眼可辨。**
（2026-09-20 复查：8 项**全部完成**，Phase 2 已补签 PASS。）

| # | 整改项 | 状态 |
|---|---|---|
| 1 | 修正 Phase 2 状态（先改为"正式验收挂起"，Phase 3-I 通过后**补签 PASS**） | ✅ 本文 §顶部 + `DEV-PLAN.md` + `README.md` + `CHANGELOG.md` 同步 |
| 2 | 补做真实 100 路并发创建工单测试 | ✅ **已完成**（2026-09-20，Phase 3-I）—— 8 条断言全绿、退出码 0，证据见 §7.3 |
| 3 | 后台页面不得无限延期 | ✅ 已写进 `DEV-PLAN.md`：最迟 Phase 4 完成前交付；Phase 4 验收须含真实售后人员 UI 走查 |
| 4 | 清理 viewer 探针遗留配置 | ✅ 见 DEV-24 / DEV-27；真机 0 无主行、32 行白名单同集合、重启幂等 |
| 5 | NocoBase 版本正式冻结 | ✅ 见 DEV-25；`expected-versions.mjs` 单一事实来源 + 3 条断言 |
| 6 | Dockerfile 偏差记录 | ✅ 见 DEV-26；`DEV-PLAN.md` Phase 10 已加"生产发布形态评审"条款（**未完成，不得视为已解决**） |
| 7 | 不改变已正确架构 | ✅ 11 项已确认设计已写进 `DEV-PLAN.md`，明确标注"不重构" |
| 8 | Phase 3 开发顺序 A→I | ✅ 已写进 `DEV-PLAN.md` §Phase 3 |

### 7.1 整改项 4 的真机证据

| 阶段 | 无主行 | viewer 授权 | 漂移行数 | 启动自愈日志 |
|---|---|---|---|---|
| 整改前 | 11 条 | 缺 3 张表（`serviceVisits`/`smsLogs`/`ticketEvents`） | 14 行 | — |
| 重启后 | **0 条** | **4 张表齐全** | 0 行 | `清理 11 条无主行` + `补建 3 条资源授权行` + `修正 14 行` |
| 再重启 | 0 条 | 4 张表齐全 | 0 行 | **0 条（幂等）** |

### 7.2 整改项 2 的验收脚本契约（`scripts/verify-concurrency-phase2.mjs`）

**脚本状态：已就位**（2026-09-20，通过 `node --check` 语法校验与退出码自检）。
必须经 **Public API → GuardService → TicketService/SequenceService → PostgreSQL** 全链路，**禁止 SQL 直连**。8 条断言：

1. 100 路并发创建**无 5xx**（含超时/连接重置）
2. 恰好产生 **100 张工单**（不多不少，幂等与频控不能吃掉合法请求）
3. 100 个 `ticket_no` **互不相同**
4. 序号**连续无空洞**（同日 `daily_sequences` 的 `current_value` 增量 == 100，且后缀 == 基线+1…基线+100）
5. 唯一索引**不冲突**（无 `23505` 且无静默吞错）
6. `ticketEvents` 条数正确（每张新建工单恰好 1 条 `created` 事件）
7. **重复 `request_id` 不消耗序号**（同 request_id 重放不推进 `current_value`）
8. **幂等不产生新单号**（同 request_id 第二次调用返回首个工单号，且 `tickets` 总数不变）

**退出码约定（关键：不让"环境问题"污染红灯）**

| 退出码 | 含义 | 此时能否补签 Phase 2 PASS |
|---|---|---|
| **0** | 8 条断言全绿 | ✅ 可以 |
| **1** | 有断言失败（真红灯） | ❌ 不可以，需按失败信息回查 |
| **2** | **环境未就绪**（接口不在 / 频控拦截 / Docker 不可用） | ❌ 不可以，但它**不是**取号缺陷的红灯 |

**⚠️ 已识别的环境前提冲突（必须在跑之前处理）**

生效的 IP 阈值默认是 **30 次/分钟**，而本脚本要发 **100 路并发**
→ **默认配置下必然有约 60–70 路被 429 拦掉**，断言 2 会失败，但根因是**频控在正常工作**，不是取号有 bug。

脚本对此的处理是：**不去拆频控闸门**（那属于"为造绿灯而改被测对象"），而是
① 发压前用 `/api/svc:guardQuota` 预检真实剩余额度，不足则**一个压测请求都不发**、
以**退出码 2（环境未就绪）**收场；② 出现 429 时同样以退出码 2 收场，
并把附带的失败项标注为"需在环境就绪后复核，暂不计为红灯"——避免又一次"狼来了"。

### 跑通 100 路的正确姿势（**两层一起改，应用层改库不是改 .env**）

> ⚠️ **本节早期写法是错的**（2026-09-20 真机纠正，见 `DEVIATIONS.md` DEV-31）：
> 原文写"改 `.env` 的 `SVC_DEFAULT_SECURITY_IP_MINUTE_LIMIT=300`，再 `docker compose up -d app`"。
> 实测**阈值纹丝不动** —— 因为 `seedSettings`（`seeds/apply.ts`）是「存在即跳过」：
> `.env` 只决定**首次**种进 `service_settings` 的值，之后运行期一律以**库里的行**为准。
> 照旧文档操作的现象是"改完重启、429 依旧"，会被误读成产品缺陷。

```bash
# 1) 应用层：直接改库（唯一起作用的一层；ConfigService 有 10s TTL，无需重启）
docker exec svc-postgres psql -U svc_app -d service_ticket -c \
  "UPDATE service_settings SET value='1200', updated_at=now() WHERE key='security.ip_minute_limit'"

# 2) nginx 层：只改第 1 步会被网关 429，且现象与应用层频控无法区分
#    nginx/nginx.conf    : zone=svc_public       rate=30r/m → 1200r/m
#    nginx/conf.d/service.conf : /api/public/ 的 burst=10 → 300
#                                limit_conn svc_conn 96 → 256
docker exec svc-nginx nginx -s reload

# 3) 确认真实生效值（脚本也会自己预检；这一步是给人看的）
KEY=$(grep '^SIGN_SECRET=' .env | cut -d= -f2-)
curl -s -H "X-Svc-Diag-Key: $KEY" 'http://127.0.0.1:8080/api/svc:guardQuota?scene=public_ticket'

# 4) 发压
node scripts/verify-concurrency-phase2.mjs --wait 240

# 5) **两层一起恢复**（脚本结尾会再提醒一次）
docker exec svc-postgres psql -U svc_app -d service_ticket -c \
  "UPDATE service_settings SET value='30', updated_at=now() WHERE key='security.ip_minute_limit'"
#    nginx 三处改回 30r/m / burst=10 / limit_conn 96，再 nginx -s reload
```

> ⚠️ `guardQuota` 必须带 `X-Svc-Diag-Key`（= 进程内 `SIGN_SECRET`），否则**一律 404**；
> 脚本已自动从 `.env` 读取并带上。不带时"404"会被误读成"Phase 3 没做这个接口"——
> 而两者处置方式相反（前者改脚本、后者说明还没到 I 步），所以脚本会在报错信息里
> 明确区分这两种根因。

> 为什么不用"改小并发"绕过：`--concurrency 30` 虽然能避开频控，但**不满足挂起项的"100 路"要求**，
> 不能据此补签 PASS。脚本在检测到 `并发 > 阈值` 时会把这一点明确打印出来。

### 7.3 整改项 2 的执行结果（2026-09-20，Phase 3-I）

`RUN_ID=20260920T212007-bb89`，100 路真实并发经
**HTTP → nginx → NocoBase resourcer → GuardService → TicketService/SequenceService → PostgreSQL** 全链路。

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 100 路并发无 5xx（含超时/连接重置） | ✅ | 100 路全部 < 500，无超时/连接重置 |
| 2 | 恰好产生 100 张工单（不多不少） | ✅ | 状态分布 `201×100`，耗时 779ms（最慢 770ms / 最快 43ms） |
| 3 | 100 个 `ticket_no` 互不相同 | ✅ | `FW20260920-0111` … `FW20260920-0210` |
| 4 | 序号连续无空洞 | ✅ | 序号 111…210 连续；`daily_sequences(FW-20260920)` `110 → 210`（增量恰为 100） |
| 5 | 唯一索引不冲突（且无静默吞错） | ✅ | 压测窗口内 `0` 次 23505 / duplicate key；计数等式 2/3/4 同时成立 |
| 6 | `ticketEvents` 条数正确 | ✅ | 每张工单恰好 1 条 `created`；表总行数 `106 → 206`（幂等重放**未**多写事件） |
| 7 | 重复 `request_id` 不消耗序号 | ✅ | 重放前后 `current_value` 均为 `211`（增量 0） |
| 8 | 幂等不产生新单号 | ✅ | 两次调用均返回 `FW20260920-0211`；当日工单总数不变；幂等记录 1 条 |

**退出码 0**（8 条契约全绿）→ 据此把 Phase 2 由 HOLD **补签为 PASS**。
跑完后两层阈值均已恢复生产值：实测 `guardQuota.limit = 30`，
nginx 三处限流值经 `git diff` 确认逐字还原。

**本轮同时暴露并修掉的 3 个缺陷（都是"第一次真跑才会出现"）**

| 缺陷 | 性质 | 现象 | 修法 |
|---|---|---|---|
| 探测请求复用了 `mobiles[0]` | **脚本缺陷** | 探测先用 `13{nonce}000` 建了一张单，随后并发批次里同号请求被**重复单规则正确拦成 409**，断言 2/3/4 全红——看起来极像"并发下有请求被吃掉" | 给探测请求分配**独立**号段（`…998`），并在生成时断言三段互不相交 |
| 断言 6 的 SQL 写了 `GROUP BY 1` | **脚本缺陷** | PG 的序号 GROUP BY 解析的是"第 1 个选择项表达式"，而该项含 `count(a.id)` → `aggregate functions are not allowed in GROUP BY` | 改为 `GROUP BY t.ticket_no` |
| 同 `request_id` 并发各取各号 | **产品缺陷**（真缺陷） | 固定同一 `X-Request-Id` 并发 10 路 → `201×1 + 200×4 + 429×5`，序号 `1 → 6`（增量 5） | ⑤~⑧ 加进程内 `scene:request_id` 串行锁，见 `DEVIATIONS.md` **DEV-32** |

> 前两个是脚本自己的问题（频控与重复单都是**设计特性**，脚本却造出了会触发它们的输入），
> 第三个才是被测代码的真实缺陷。把这两类分清很重要：脚本缺陷造成的红灯如果被算到产品头上，
> 会让人去查根本没问题的并发取号代码。

**其它实现细节（都已按真机口径处理）**

- **就绪判断是「先静态、后联网」**：先用零副作用的静态门（源码 public action 目录 + 编译产物**去注释后**的接口标记）
  判断 Phase 3 接口在不在；未就位则**一个 HTTP 请求都不发**、退出码 2。
  原因见 §4 最后一条：直接 POST 探测会给 `svc-app` 写 error 日志，进而把随后跑的 `smoke-test` 打成假红灯。
  真机验证：脚本退出码 2，`docker logs svc-app` 行数 1936 → 1936（完全不变）。
  `--ready-marker <正则>` 可在 Phase 3 用了别的资源名时覆盖默认标记（`publicTickets?`）；`--skip-static-gate` 强制发 HTTP 探测。
- 100 路用**互不相同的手机号**（`13800000001…13800000100`）与**互不相同的 `X-Request-Id`**：
  否则会先被 GuardService 的"同号 + 同店 + 同类型"重复单规则折叠掉，测的就不是并发取号了。
- 断言 2 的"不多不少"按**本次 100 个 `request_id` 的产物**统计，而不是"当天工单总数"——
  否则历史数据（冒烟脚本、手工点单）会让硬断言失真；探测请求单独建单，不入这 100 张。
- 幂等断言（7/8）用**独立于压测的** request_id 与手机号，分两次串行调用，第二次必须是**重放**。
- 清理是**可选**的（`--cleanup`），且需另开破坏性门闩 `SVC_PROBE_ALLOW_DESTRUCTIVE=1`（与 DEV-27 同一条门槛）；
  清理**按 `ticket_no` 精确匹配**，不按时间范围删，避免误伤他人工单；
  且 `daily_sequences.current_value` **永不回收**（号码一旦发出即作废，是 `SequenceService` 的刻意设计）。

---

## 8. 待确认输入（阻塞上线，不阻塞开发）

| # | 待确认项 | 当前默认值 | 需确认时点 |
|---|---|---|---|
| 1 | **正式门店清单**（开发文档附录 E-03）：`code` / 名称 / 对外售后电话 / 排序 | 15 家占位门店（`S01…S15`，电话为 `null`） | **二维码印刷前必须替换** —— `code` 一经发出不可变更（DEV-21） |
| 2 | 门店用户账号清单与门店归属（用于 `storeUsers` 种子） | 未落；测试用临时账号 | Phase 3 开始前 |
| 3 | 后台页面形态（原生区块 vs 自定义页面） | 未定 | **Phase 4 完成前必须定**（§5.1） |
| 4 | ~~`viewer` 角色的字段白名单是否与业务角色统一~~ | **已统一**（Phase 2.1，见 §5.3） | ✅ 已关闭 |
| 5 | 日志级别策略是否纳入运维规范（DEV-20） | `LOGGER_LEVEL=info`；越权 404 记 debug、401/403 记 warn | 上线前 |
| 6 | 生产发布形态：不可变镜像 vs bind mount（DEV-26） | 开发期用 bind mount | **Phase 10 前必须评审** |

---

## 9. 结论

Phase 2 的服务端底座（数据模型、三级权限、门店隔离、取号、状态机、事件、参数配置）
**功能开发完成、真机通过**，三套校验合计 **163 项全绿**（43 + 56 + 64），
且每条关键断言都有"反向注入即变红"的验证。

**正式验收已通过 → Phase 2 = PASS（2026-09-20 补签）。**
原唯一挂起项「100 路并发取号」已在 Phase 3-I 补做：真实 HTTP 全链路、8 条断言全绿、退出码 0（§7.3）。
补做过程中**没有**用 SQL 直连取号替代压测，也**没有**为了变绿而拆掉频控/幂等/唯一约束。

**PASS 的边界**：PASS 指"验收门槛全部满足"。§5.1 的**后台页面缺口仍然存在**
（按用户裁定重排期，最迟 Phase 4 完成前交付，且 Phase 4 验收必须含真实售后人员 UI 走查）。

真正值得记住的教训是：本阶段修掉的缺陷（DEV-18 ~ DEV-27）**没有一个会让程序报错** ——
接口 200、日志干净、表也建出来了，只有把「应该是什么样」写成断言去逐条核对才暴露出来。
Phase 2.1 又补上一条更细的：**一条每次部署都会报的告警等于没有告警** ——
`list` 动作的 `fields` 被 NocoBase 重排导致每启动一次刷 16 条假漂移，
它会把真正的漂移（33 列被改成 7 列）淹掉。因此断言不仅要比对，还要**用对语义**（集合而非顺序）。
本项目的做法是：**任何"应该有"的东西，都要有一侧脚本能把它变成红灯**，
否则它迟早会静默消失。

Phase 3-I 又给这条教训加了一个更硬的注脚：**"脚本自己造出冲突、再把红灯算到产品头上"是最贵的一类假红灯**。
100 路压测首次真跑时 4 条断言全红，看上去完全是"并发下有请求被吃掉"，
实际前两条是脚本缺陷（探测请求复用了压测号段的手机号 → 被重复单规则**正确地**拦成 409；
断言 6 的 SQL 写了 `GROUP BY 1` → PG 拒绝含聚合的选择项）。
只有第三条（同 `request_id` 并发各取各号，DEV-32）才是真缺陷。
**修断言之前，先确认"这条断言要证明的东西，产品是不是本来就该这样"** —— 否则会去查根本没问题的代码。

下一阶段（Phase 3 客户 H5 报修）的前置条件与执行顺序见 `DEV-PLAN.md` §Phase 3：
A `GET /api/public/stores` → B `POST /api/public/tickets` → C `GuardService` → D `request_id` 幂等
→ E IP/手机号频控 → F 重复单识别 → G 隐私同意 → H `/report` Vue H5
→ **I 100 路真实 API 并发取号验收（补签 Phase 2 PASS）** → 最后做 Phase 3 自身的 AT-01/AT-02/重复提交验收。
