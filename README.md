# 家电门店售后服务平台

> 门店售后工单中台 · H5 报修 / 投诉 · 门店派工 · 短信通知 · 匿名评价 · 总部监管
> 技术底座：**NocoBase Community (Apache-2.0) + PostgreSQL + Nginx + Vue3 H5 + 短信适配层**

---

## 这是什么

一个**独立、轻量的「门店售后工单中台」**，不做 ERP / CRM / 重型 FSM：

```
客户匿名 H5 报修/投诉
  → 门店售后受理 / 转店 / 派工
  → 师傅凭一次性短信链接匿名上传现场照片 + 提交处理结果与收费
  → 门店审核确认（或驳回返工）
  → 客户凭一次性链接匿名评价（含收费一致性确认）
  → 满意关闭 / 低评分或收费不一致自动重开
  → 总部全量监控 + KPI + Excel 导出
```

**明确不做**：不接门店 ERP、不同步销售单/商品/SN/售价/库存/财务、不做客户账号、不做备件/结算/工时/地图调度/定位/电子签字、不做在线支付。

---

## 角色

| 角色 | 账号 | 范围 |
|---|---|---|
| 门店售后人员 | 有 | 仅被授权门店（服务端强制隔离） |
| 总部售后人员 | 有 | 全部门店 |
| 总部管理员 | 有 | 全部 + 配置/权限/导出 |
| 客户 | 无 | 匿名 H5；评价用一次性 Token |
| 师傅 | 无 | 一次性 Token H5，仅本次任务最小信息 |

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/PHASE-0.md`](docs/PHASE-0.md) | **Phase 0 交付**：需求理解、系统架构、能力矩阵、目录结构、阻塞问题核查 |
| [`docs/PHASE-1.md`](docs/PHASE-1.md) | **Phase 1 交付**：部署层与插件骨架的完整代码、离线 72 项验证证据、运行命令与预期结果 |
| [`docs/VERIFY-PHASE-1.md`](docs/VERIFY-PHASE-1.md) | **Phase 1 真机验收报告**：原始证据、索引静默丢弃缺陷的根因与反证、复现命令 |
| [`docs/PHASE-2.md`](docs/PHASE-2.md) | **Phase 2 交付报告（状态 PASS）**：三级权限模型、门店隔离、验收证据、10 个"不报错但不生效"缺陷的根因、Phase 2.1 验收整改 8 项、已知缺口与待确认输入、**§7.3 100 路并发取号证据** |
| [`docs/PHASE-3.md`](docs/PHASE-3.md) | **Phase 3 交付报告（状态 ✅ 完成）**：客户匿名 H5 报修全链路（A→I）、`POST /api/public/tickets` 守卫顺序 ①~⑧、H5 single-flight、总闸 §4c 12 项、100 路并发证据、**DEV-28~DEV-37**、**Phase 3.1 重复单修正**、已知限制（含单实例部署边界）、Phase 4 计划 |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | 11 张表字段级定义、关系、索引与约束清单 |
| [`docs/STATE-MACHINE.md`](docs/STATE-MACHINE.md) | 6 状态迁移表、并发与幂等、Token 生命周期、SLA 任务 |
| [`docs/API.md`](docs/API.md) | 全部接口清单、错误码、角色动作矩阵、报表口径 |
| [`docs/SECURITY.md`](docs/SECURITY.md) | 威胁模型、双层数据隔离、Token 规范、文件安全、合规基线 |
| [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md) | 与需求文档的偏差与决策记录 |
| [`docs/DEV-PLAN.md`](docs/DEV-PLAN.md) | Phase 1–10 计划、每阶段验收门槛、26 项测试清单 |
| [`ASSUMPTIONS.md`](ASSUMPTIONS.md) | 全部默认值与待确认项登记簿 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录 |

---

## 目录结构

```
.
├─ nocobase/plugins/service-ticket/   后端唯一扩展插件（TypeScript 源码）
├─ h5/                                Vue3 + Vite H5（客户报修 / 师傅回执 / 客户评价）
│  └─ dist/                           构建产物；Phase 1 为占位页（nginx 挂载点）
├─ nginx/                             反向代理、HTTPS、限流、静态托管
├─ docs/                              设计与运维文档
├─ scripts/                           build / verify / gen-secret 等工具
├─ tests/                             unit + e2e（26 项必测用例）
├─ backups/                           备份输出（不入库）
├─ storage/                           运行时持久化（含已编译插件，不入库）
│  └─ plugins/@local/service-ticket/  esbuild 编译产物（compose 挂载源）
├─ docker-compose.yml                 postgres + app(nocobase) + nginx
└─ .env.example                       全部环境变量样例
```

---

## 快速开始

```bash
# 1) 生成 .env（自动填充 APP_KEY / DB 口令 / 签名密钥 / 备份口令）
node scripts/gen-secret.mjs

# 2) 编译自研插件（宿主机 esbuild → storage/plugins/@local/service-ticket）
node scripts/build-plugin.mjs

# 3) 静态校验部署层（不需要 Docker daemon，可在启动前抓出挂载/变量/配置错误）
node scripts/verify-config.mjs

# 3.5) 插件生命周期离线校验（桩环境，不需要容器）
node scripts/verify-plugin-load.mjs

# 4) 启动（首次启动会自动完成 NocoBase 安装与建表，约 1–3 分钟）
docker compose up -d
docker compose logs -f app

# 5) 验收自检（76 项端到端断言：Phase 1 基线 + Phase 2 八项 + Phase 3 十二项）
#    §4c 的 429 断言会临时把 security.ip_minute_limit 降到 2 再在 finally 里恢复，
#    全程只有 3 个请求（远不到 nginx 的 11 次突发上限），所以**不需要**预先放宽限流，也不会留下冷却。
node scripts/smoke-test.mjs --wait 240

# 5b) Phase 3 客户 H5 验收（35 项：前后端契约对齐 / 提交器 single-flight / 同 request_id 并发真机 E2E / nginx 交付）
node scripts/verify-phase3-h5.mjs

# 6) 100 路真实并发取号验收（Phase 2 门槛的唯一解除手段；已于 2026-09-20 通过）
#    接口未就绪时退出码 2（环境未就绪），不会误报红灯
#    ⚠️ 跑之前必须把 IP 频控放宽到 >100，且**两层一起改**：
#       · 应用层 = 改库不是改 .env（.env 只决定首次种子）：
#           docker exec svc-postgres psql -U svc_app -d service_ticket -c \
#             "UPDATE service_settings SET value='1200', updated_at=now() WHERE key='security.ip_minute_limit'"
#       · nginx 层 = svc_public rate 与 limit_conn（只改应用层会被网关 429，现象无法区分）
node scripts/verify-concurrency-phase2.mjs

#    跑完**两层一起恢复**（脚本结尾会再提醒一次；改回后实测 guardQuota.limit = 30）
```

访问（端口取 `.env` 的 `NGINX_HTTP_PORT`，本机因 CRMEB 占用 80 而用 **8080**）：

- 管理后台：`http://localhost:8080/`（首次进入初始化向导）
- 客户报修：`http://localhost:8080/h5/report?store=S01&source=qr`（Phase 3，**已交付**）
- 师傅作业：`http://localhost:8080/h5/technician/visit/<token>`（短信下发，**Phase 5 起**；Phase 4 已能签发 Token 与短信，但页面尚未交付）
- 客户评价：`http://localhost:8080/h5/review/<token>`（门店确认后短信下发，Phase 7 起）
- 健康检查：`http://localhost:8080/api/svc/health` 或其原生形式 `/api/svc:health`

---

## Phase 1 运维手册

### 启动

```bash
docker compose up -d              # 全部拉起
docker compose ps                 # 看三个容器是否 healthy
docker compose logs -f app        # 跟踪应用日志（首次安装信息在这里）
docker compose logs --tail=100 nginx
```

首次启动的**时序**（不必人工干预，但需知道）：

1. `postgres` 初始化数据库 → healthcheck 变 healthy（约 10–30 秒）
2. `app` 才开始启动（`depends_on: service_healthy` 保证顺序）→ 官方镜像入口脚本执行
   `nocobase install` → 加载 `@local/service-ticket` → `db.sync()` 建 11 张表 →
   写入 16 项参数种子 → 监听 13000
3. `nginx` 起来后 `http://localhost/` 即可访问

> `app` 的 healthcheck `start_period` 给了 240 秒，是给首次安装留的余量。
> 若 `docker compose ps` 显示 `starting` 属正常，超过 4 分钟仍非 healthy 再查日志。

### 数据库初始化（何时需要重做）

正常情况下**不需要**手工初始化。仅在以下情形手工执行：

```bash
# 全新的库（清空数据卷后）—— 官方镜像入口脚本一般已自动完成
docker compose exec app npx nocobase install -f

# 只重新同步表结构（改过 collection 定义、不想丢数据时）
docker compose restart app
# 插件 load() 时会再跑一次 db.sync()（幂等，不会删列）
```

> ⚠️ 清库：`docker compose down -v` 会删除 `svc_pg_data` 卷，**数据不可恢复**。
> 生产环境执行前必须先备份（见下文「备份与恢复」）。

### 插件加载

| 事项 | 说明 |
|---|---|
| 加载方式 | `.env` 的 `APPEND_PRESET_BUILT_IN_PLUGINS=@local/service-ticket` → 自动 install + enable |
| 发现路径 | `PLUGIN_STORAGE_PATH=/app/nocobase/storage/plugins`（容器内扫描已编译插件） |
| 解析路径 | compose 把同一目录挂到 `/app/nocobase/node_modules/@local/service-ticket`，使 `require.resolve` 可命中 |
| 前缀白名单 | `PLUGIN_PACKAGE_PREFIX` 必须含 `@local/`，否则启动直接抛错 |
| 改代码后 | `node scripts/build-plugin.mjs && docker compose restart app` |
| 排错 | `docker compose exec app node -e "console.log(require.resolve('@local/service-ticket'))"` |

### 日志

```bash
docker compose logs -f app                    # 应用（含插件安装/建表/短信 mock 输出）
docker compose logs -f nginx                   # 访问日志（含 rt= 总耗时 / urt= 上游耗时）
docker compose exec nginx tail -f /var/log/nginx/error.log
```

容器日志已配 `max-size` + `max-file` 轮转（app 50m×5、postgres/nginx 20m×5），不会打满磁盘。

### 配置变更

| 变更 | 生效方式 |
|---|---|
| `.env` 里的环境变量 | `docker compose up -d`（compose 会重建容器） |
| `nginx/**` 配置 | `docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload` |
| `h5/dist/**` 静态资源 | 无需操作（bind mount 直接生效；浏览器强刷即可） |
| 业务参数（阈值/SLA/限流） | 后台「参数配置」页修改（写入 `service_settings`），或改 `.env` 的 `SVC_DEFAULT_*` 后重建容器 |

### 备份与恢复

```bash
# 备份（PostgreSQL 逻辑备份 + 私有上传目录 + 插件产物）
docker compose exec -T postgres pg_dump -U svc_app -d service_ticket -Fc \
  > "backups/db-$(date +%Y%m%d-%H%M%S).dump"

# 恢复
docker compose exec -T postgres pg_restore -U svc_app -d service_ticket --clean --if-exists \
  < backups/db-20260920-160000.dump
```

> 备份口令取自 `.env` 的 `BACKUP_PASSPHRASE`；`backups/*` 已在 `.gitignore` 中，
> 且 `uploads-private/` 目录**不参与 Git**，请一并纳入你的异地备份策略。

### 自检脚本

| 脚本 | 用途 | 是否需要 Docker |
|---|---|---|
| `node scripts/gen-secret.mjs` | 从 `.env.example` 生成带随机密钥的 `.env` | ❌ |
| `node scripts/build-plugin.mjs` | 编译插件到 `storage/plugins/@local/`（含产物自检） | ❌ |
| `node scripts/verify-config.mjs` | compose 挂载点 / nginx 语法与变量 / `.env` 交叉一致性 / **NocoBase 版本冻结断言**（44 项） | ❌ |
| `node scripts/verify-plugin-load.mjs` | 桩环境跑一遍插件生命周期 + 健康检查 + 索引声明守卫 + 权限与字段白名单守卫 + **【4d】两个 Phase 4 探针的自毁闸**（59 项） | ❌ |
| `node scripts/expected-indexes.mjs` | 索引验收**单一事实来源**（离线与真机共用同一份清单） | ❌（被引用） |
| `node scripts/expected-versions.mjs` | **版本冻结单一事实来源**（NocoBase 版本 pin，被离线与真机断言引用） | ❌（被引用） |
| `node scripts/smoke-test.mjs` | **真机端到端验收（总闸，92 项）**：容器健康、容器内插件解析、日志证据、健康检查门槛、Nginx 头与路由、11 张表与**35 条声明式索引逐条落库**、参数种子、**Phase 2 八项（资源授权 / 字段白名单 / AT-03 门店隔离 / 并发 409 / 事件必写 / 授权表零无主行）**、**Phase 3 十二项（门店列表最小披露 / 建单 201 恰好三字段 / request_id 幂等重放 / 隐私 400 两形态 / 缺请求号 422 / 重复单 409 / 应用层 429 / Phase 3.1 判重 A~E 五项）**、**Phase 4 十六项（通道未就绪不阻断派工 / Visit#1 与派工快照 / 两 scene 短信 / accepted≠delivered / Token 只存 sha256 / 重复派工 409 / 改派 = SUPERSEDED+新建 / **改派后旧 Token 立即失效** / 三 scene 短信 / 改约不新建 Visit 且换发 Token / 失败形态统一 TOKEN_INVALID / 被拒改派零副作用 / 责任人未变 422 / 门店越权 404 / 派工链无断点）**、稳定性 | ✅ |
| `node scripts/verify-phase3-h5.mjs` | **Phase 3 客户 H5 验收**（35 项）：前后端契约对齐（长度/正则/版本号/头名源码级比对）、提交器行为（连点 10 次 single-flight、失败重试复用 request_id、内容变化换号、响应收敛为 3 字段）、**同 request_id 并发 10 路真机 E2E**（恰好 1 张单 + 序号仅 +1）、构建产物与 nginx 交付（字节一致 + 缓存头） | ✅ |
| `node scripts/verify-concurrency-phase2.mjs` | **100 路真实并发取号**（Phase 2 门槛的唯一解除手段；2026-09-20 已通过，8 条断言全绿、退出码 0）。依赖 `POST /api/public/tickets`；接口未就绪时以退出码 2「环境未就绪」收场（不是绿灯，也不是红灯）。**跑之前两层限流都要放宽，见「快速开始」第 6 步** | ✅ |

> 四个离线脚本的存在意义：即使没有（或不想起）Docker，仍能**在启动前**定位绝大多数
> 部署层错误（漏挂载、变量未定义、限额 zone 缺失、密钥占位符未替换等）。
> `smoke-test.mjs` 则用于启动后的真实验收，建议每次部署后都跑一次。

#### 冒烟测试用法

```bash
node scripts/smoke-test.mjs                  # 读 .env 的 NGINX_HTTP_PORT 自动拼地址
node scripts/smoke-test.mjs --url http://localhost:8080
node scripts/smoke-test.mjs --wait 240       # 等待应用就绪（首次启动约 1–3 分钟）
```

### ⚠️ 本机端口冲突（重要）

本机 80 端口默认被**另一个项目 CRMEB**（`crmeb-nginx` 容器）占用，
且那四个容器都是 `restart: always` —— **Docker 一重启就会自动抢回 80**。

因此本项目 `.env` 已把 `NGINX_HTTP_PORT` 设为 **8080**、`PUBLIC_BASE_URL` 设为
`http://localhost:8080`，与 CRMEB 完全隔离（互不干扰，可同时运行）。

若换到 80 空闲的机器，改回 80 即可（同步去掉 `PUBLIC_BASE_URL` 的端口）。


---

## 部署要求

- 对外仅暴露 **443**；`13000`（NocoBase）与 `5432`（PostgreSQL）不对公网开放
- 必须 HTTPS（微信内置浏览器要求）+ 已备案域名
- 短信签名/模板需提前完成实名资质与运营商报备（有审核周期，勿压到上线当天）
- 密钥只在 `.env`：不进 Git、不进前端、不写入可被前端读取的表

---

## 当前状态

| Phase | 状态 |
|---|---|
| Phase 0 需求核对与技术确认 | ✅ 完成 |
| Phase 1 项目初始化与可启动 | ✅ 完成 |
| Phase 2 数据模型 / 权限 / 工单底座 | ✅ **PASS**（2026-09-20 补签）—— 服务端底座真机通过；「并发 100 次取号」已按真实 HTTP 全链路补做，**8 条断言全绿、退出码 0** |
| Phase 3 客户 H5 报修 | ✅ **完成** —— A→I 全部交付；100 路真实并发验收 **8 条全绿**（已解除 Phase 2 挂起项）；H5 自身验收 **35 项全绿**；阶段内 AT-01/AT-02/重复提交/限流验收已并入总闸 `smoke-test.mjs` §4c（**76 项全绿**）。**Phase 3.1 重复单修正**已落地并复验 |

**Phase 0 结论：通过。**
**Phase 1 结论：通过。** 交付物 = 一条 `docker compose up -d` 可拉起的项目骨架：
三容器编排、11 张表定义、`/api/svc:health`（兼容 `/api/svc/health`）健康检查、
16 项参数种子、Nginx 限流与安全基线、离线自检脚本（当时 72 项断言 = `verify-config` 41 + `verify-plugin-load` 31）。
**真机验收已完成**：三容器 `Up (healthy)`，`smoke-test.mjs` 55/55（Phase 1 时点数），
11 张表 + 35 条声明式索引全部落库（见 `docs/VERIFY-PHASE-1.md`）。

**Phase 2 结论：PASS（2026-09-20 补签）—— 验收门槛已全部满足。**
服务端底座（三级权限模型：全局 action → 资源级授权 → 字段白名单；双层门店隔离；
原子取号；状态机 M1/M2/M6/M7；事件必写；参数配置）**真机验收通过**：
`smoke-test.mjs` **76/76**（Phase 2 时点数为 64；Phase 3 收尾后 71，Phase 3.1 后 76）、`verify-plugin-load.mjs` **57/57**、`verify-config.mjs` **43/43**（合计 **176 项**全绿）。
`AT-03`（门店隔离）通过，且 get 他店返回 **404** 而非 403（不给攻击者存在性信号）。
本阶段修掉 10 个"不报错但不生效"的缺陷（DEV-18 ~ DEV-27），其中 DEV-23 含**真实凭证泄露**
（`fields=null` 导致 `feedback_token_hash` 被整行下发）。

DEV-PLAN 自己写的门槛「并发 100 次取号无重复、无空洞」曾因 Phase 2 无对外入口而**故意不造绿灯**
（用 SQL 直连取号器去模拟等于"验证 PostgreSQL 而不是验证本项目的代码"）。该挂起项已在 **Phase 3-I** 解除：
`node scripts/verify-concurrency-phase2.mjs` 经**真实 HTTP 全链路**（nginx → NocoBase → GuardService →
TicketService/SequenceService → PostgreSQL）**8 条断言全绿、退出码 0** ——
100 路 `201×100`、编号连续无空洞、取号器增量恰为 100。补做时**没有**用 SQL 直连取号替代压测，
也**没有**为变绿而拆掉频控/幂等/唯一约束。证据见 `docs/PHASE-2.md` §7.3。

> ⚠️ **PASS 的边界**：指"验收门槛已满足"，**不代表**已无缺口。Phase 2 的后台业务页面、
> `storeUsers` 用户映射仍**未交付** —— 后台页面**最迟 Phase 4 完成前交付**，
> 且 Phase 4 派工验收**必须含真实售后人员的 UI 走查**（见 `docs/DEV-PLAN.md` §Phase 4）。
>
> ⚠️ **放宽限流阈值要改库、不是改 `.env`**，而且应用层与 nginx 层**两层都得改**（见 `DEVIATIONS.md` DEV-31）：
> 生效值在 `service_settings` 表里，`.env` 只决定首次种子。

详见 `docs/PHASE-2.md`。

**Phase 3 结论：完成（2026-09-21 并入总闸；同日完成 Phase 3.1 重复单修正）。**
客户 H5 报修全链路（`/report` 页面 → `POST /api/public/tickets` → 守卫链 ①~⑧ → 落库）已在三个层面上被锁住：
① **服务端契约**进总闸 —— `smoke-test.mjs` §4c **12 项**（Phase 4 收尾后总闸 **92 项全绿**）；
② **H5 自身** —— `verify-phase3-h5.mjs` **35 项全绿**（前后端常量逐字对齐、提交器 single-flight、构建产物字节一致）；
③ **并发** —— 同一 `request_id` 并发 10 路只出 1 单、序号仅 +1；100 路真实 HTTP 并发 `201×100`、编号无空洞。

**Phase 3.1 修正了一处真实误判**（见 `docs/PHASE-3.md` §10 / `DEVIATIONS.md` DEV-36）：
原重复单判定漏了 `PHASE-0` §9.4 要求的「**事项文本**」维度，只比 手机号+门店+类型+时间窗，
于是同一客户在同一家店分别报修「空调不制冷」与「冰箱漏水」时，第二件会被当成重复单挡死 ——
**合法场景被错误拦截**。现改为五维全同（新增确定性 `normalizeContent()`，不引入 AI/NLP/PG 扩展），
A~E 五组断言已进总闸。

> ⚠️ **重复单是软约束**：五维全同 + 移动时间窗无法用唯一索引表达，并发下存在极小概率漏判。
> 真正的硬防线是手机号日频控与 IP 频控。判错两个方向的代价**不对称**（漏判=两张单可合并；
> 误判=客户拿不到单号），因此所有边界情形一律选择**放行**。

> ⚠️ **单实例边界**：同 `request_id` 的互斥是**进程内**锁、取号发生在业务事务**之前** ——
> 当前版本按**单 NocoBase 应用实例**运行，**未经改造不得横向扩为多个 app replica**，
> 多实例前必须重新验证幂等竞态与工单号无空洞性质（`DEVIATIONS.md` DEV-37、`docs/SECURITY.md` §8）。

> 📌 **一条反直觉的实测结论（排查限流时最容易踩）**：nginx 的
> `limit_req rate=30r/m burst=10 nodelay` 真实含义是「**11 次突发 + 0.5 次/秒回填**」——
> 连发 45 次只有前 11 次能过闸，第 12 次起就是 nginx 的 429，而那一刻应用层 `used` 才 11（阈值 30）。
> 也就是说 **nginx 才是先卡住的那层**，只看应用层阈值会误判成"频控没生效"。
> 两种 429 的响应体不同、必须能区分：网关 `{"code":"TOO_MANY_REQUESTS"}`，
> 应用层 `{"errors":[{"code":"RATE_LIMITED",...}]}`。
> 因此 §4c 的 429 断言用「库里阈值临时降到 2 + 3 个请求」（无冷却、可重复），
> 并**在 finally 里无条件恢复阈值与清空桶** —— 否则总闸会把自己变成故障源。

详见 `docs/PHASE-2.md` §7.3 与 `docs/DEV-PLAN.md` §Phase 3。

**Phase 4 结论：部分交付（2026-09-21）—— 服务层与总闸验收完成，后台页面与 UI 走查未交付。**
派工 / 改派 / 改约三动作（M3/M4/M5）已在**真机 + HTTP 层**被锁住：
① **Visit 历史不可覆盖由数据模型保证** —— 改派 = 旧 Visit 置 `SUPERSEDED` + 新建 Visit（旧行一个字段都不改），
返工可追溯不再依赖"人记得别覆盖"；
② **改派后旧 Token 立即失效**（本阶段硬门槛）—— 同一实例、同一 Token 由 `valid:true` 变 `valid:false`，
库内 `token_revoked_reason=reassigned` 已置位；
③ **客户与师傅不共用模板** —— 首次 `dispatch_customer` + `technician_task`，改派再加 `technician_assignment_cancelled`（取消通知）；
④ **短信失败不回滚派工** —— 事务性发件箱（事务内写 `pending`、提交后发送），且 `accepted` ≠ `delivered`。
以上 **16 条**断言已进总闸 §4d；八条高风险闸门逐条对应证据见 `docs/PHASE-4.md` §6。

> 🚧 **阻塞声明（强制条款）**：后台业务页面（我的门店工单 / 全量工单 / 工单详情含时间线 + Visit 区块）
> 与**真实售后人员的 UI 走查**均**未交付**。按 `docs/DEV-PLAN.md` §Phase 4 强制条款 1/2/3，
> **Phase 4 判定为「未关闭」，不得进入 Phase 5**。本阶段的验收结论**仅覆盖服务层**，
> 不含任何浏览器 UI 证据 —— 派工 / 改派 / 改约**尚未**在真实售后人员手中走查过。

> ⚖️ **待裁定（DEV-45）**：条款原文要求"改派后旧 Token 401"，实际交付为探针返回
> **HTTP 200 + `{valid:false, code:'TOKEN_INVALID'}`**（理由：`tokenCheck` 是总部排障设施，
> 若返回 401 会让"被问的 Token 无效"与"调用者自己的登录态过期"无法区分）。
> 语义已达成、表达形态不同，**需复核方确认**。

详见 `docs/PHASE-4.md`。

