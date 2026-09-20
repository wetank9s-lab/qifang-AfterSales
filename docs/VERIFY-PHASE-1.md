# Phase 1 真机启动验收报告（VERIFY-PHASE-1）

> 生成时间：2026-09-20
> 执行机器：Windows 开发机（Administrator），Docker Desktop 4.77.0 / Engine 29.5.3，WSL2 后端
> 依据：`docs/DEV-PLAN.md` §Phase 1 验收门槛 & 《家电门店售后服务平台_开发文档_v1.1》
> 关联文档：`docs/PHASE-1.md`（交付报告）、`docs/DEVIATIONS.md`（DEV-10 ~ DEV-17）

---

## 一、结论

**Phase 1 真机验收通过。** `docs/PHASE-1.md` 中列为「待你在有 Docker 的机器上确认」的
全部事项，均已在真实容器环境中执行完毕，并额外发现并修复了 1 个**离线与桩环境完全无法暴露**的
真实缺陷（collection 级索引被框架静默丢弃，见 `docs/DEVIATIONS.md` DEV-16）。

| 脚本 | 层 | 结果 |
|---|---|---|
| `scripts/verify-config.mjs` | 离线（部署层） | ✅ **41 / 41** |
| `scripts/verify-plugin-load.mjs` | 离线（插件生命周期） | ✅ **31 / 31** |
| `scripts/smoke-test.mjs` | **真机（端到端）** | ✅ **55 / 55** |
| 合计 | | ✅ **127 项断言全绿** |

---

## 二、验收门槛逐条对照（DEV-PLAN 原文）

| # | 验收门槛（原文） | 结果 | 原始证据 |
|---|---|---|---|
| 1 | `docker compose up -d` 一条命令拉起三容器 | ✅ | `docker compose ps` 见 §3.1，`postgres` / `app` / `nginx` 三容器 `Up (healthy)` |
| 2 | 后台完成初始化 | ✅ | 官方镜像入口脚本自动 `nocobase install`；`app` 首次启动约 60–90s 后转 `healthy` |
| 3 | `curl /api/svc/health` 返回 `{"db":"ok","sms":"mock","tasks":"ok"}` | ✅ | 见 §3.2（冒号与斜杠两种写法均 200） |
| 4 | 11 张表出现在 PostgreSQL 中 | ✅ 11/11 | 见 §3.3（**以 DATA-MODEL.md 的 11 张为准**，非 DEV-PLAN 粗算的 9 张，见 DEV-11） |
| 5 | 参数种子落库 | ✅ 16 项 | 见 §3.4 |
| 6 | **索引全部建立** | ✅ 35 条 collection 级 + 4 条字段级唯一 | 见 §3.5 —— **本项是本次真机验收新增的门槛**，原 DEV-PLAN 未列，因 DEV-16 而补 |

---

## 三、原始证据

### 3.1 容器状态

```
NAME           IMAGE                                    STATUS
svc-postgres   postgres:16                              Up (healthy)      5432/tcp
svc-app        nocobase/nocobase:2.2.15-full-no-nginx   Up (healthy)      127.0.0.1:13000->13000/tcp
svc-nginx      nginx:1.27-alpine                        Up (healthy)      0.0.0.0:8080->80/tcp
```

### 3.2 健康检查

`docker compose exec` 之外，从宿主机经 nginx（8080）实测：

```console
$ curl -s http://localhost:8080/api/svc/health
{"data":{"db":"ok","sms":"mock","tasks":"ok","status":"ok","plugin":"@local/service-ticket",
"version":"1.0.0","ready":true,"uptimeSeconds":94,"tablesExpected":11,"tablesPresent":11,
"missingTables":[],"registeredCollections":11,"tasksRegistered":0,"settingsSeeded":true,
"loadedAt":"2026-09-20T09:09:24.268Z","latencyMs":9,"checkedAt":"2026-09-20T09:10:52.199Z",
"traceId":"hc-mu9ljdwe"}}

$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8080/api/svc:health
HTTP 200

# 验收门槛「一行断言」原文命令，实测通过：
$ curl -s http://localhost:8080/api/svc/health \
    | tr -d ' \n' | grep -q '"db":"ok","sms":"mock","tasks":"ok"' && echo PASS || echo FAIL
PASS
```

> 📌 **一处需记录的响应形态**：NocoBase 的 resourcer 会把 `single` 类型 resource 的
> action 返回值包一层 `{"data": ...}`。因此**逐字段 JSON 解析**时应读 `data.db`；
> 而验收门槛给出的「一行断言」是 `grep` 子串匹配，**不受外层包裹影响，原样可用**。
> `scripts/smoke-test.mjs` 两种都做了兼容（先尝试解包 `data`，再断言扁平的三个字段）。

### 3.3 数据库表（11/11）

按**表名白名单**查询（不用 `count(*) FROM pg_tables`，因为 NocoBase 自身还会建
`users`/`roles`/`collections`/`fields`/`authenticators` 等系统表）：

```
api_guards, daily_sequences, idempotency_records, service_settings, service_tickets,
service_visit_photos, service_visits, sms_logs, store_users, stores, ticket_events
```

### 3.4 参数种子（16 项，只增不改）

```
feedback.low_score_threshold=2   feedback.wait_days=7
technician.token_expire_hours=72 privacy.retention_months=24
（共 16 项，抽样取值与 constants.ts 的 DEFAULT_SETTINGS 一致）
```

### 3.5 索引（11 张表逐条核对）

```
 stores               |  3        service_visit_photos |  4
 store_users          |  4        ticket_events        |  6
 service_tickets      | 14        sms_logs             |  9
 service_visits       |  7        daily_sequences      |  2
 api_guards           |  3        idempotency_records  |  3
 service_settings     |  2
```

> 上表是 `pg_indexes` 的**原始计数**，含主键索引、NocoBase 自动为 FK 建的索引等。
> 验收真正比对的是 `scripts/expected-indexes.mjs` 清单里的
> **35 条 collection 级索引 + 4 条字段级唯一约束**，由 `smoke-test.mjs` 逐表逐条断言
> 「声明式索引全部落库」+「无重复同义索引」，共 11 + 1 条断言，全部通过。

---

## 四、真机验收发现并修复的缺陷（DEV-16）

这是本次真机验收**唯一一个**桩环境与离线校验完全无法暴露的缺陷，也是 Phase 1
最值得留在工程记忆里的一条。

### 4.1 现象

`docker compose up -d` 后：11 张表**全部**建出、`/api/svc:health` 返回 200、
应用日志**零 error**、容器 `healthy` —— 一切看起来通过。但数据库里
`service_visit_photos(file_id)` 的**唯一索引不存在**。

`file_id` 是 `belongsTo('file', …, 'attachments', 'file_id')` 外键，**没有字段级 `unique`**，
它的唯一性（「同一文件不得重复挂到两次上门」）**完全**依赖 collection 级索引声明。丢了就等于该约束失效。

### 4.2 确定性复现

连续 3 次 `docker compose restart app`，每次结果完全一致：

```console
[service-ticket] 索引核对：新建 1 条 / 已存在 34 条
[service-ticket] 索引核对：新建 0 条 / 已存在 35 条
```

即：**每次启动，同一张表的同一条索引都会被框架丢弃一次**，
然后由本项目的兜底逻辑补齐。第二次核对报 `新建 0 条`，说明兜底是幂等的。

### 4.3 抓取真实 DDL

开启 `ALTER SYSTEM SET log_statement='all'` + `pg_reload_conf()`，重启应用后抓 Postgres 实际收到的语句：

```console
$ docker compose logs postgres | grep -i "CREATE.*INDEX"
CREATE UNIQUE INDEX "service_visit_photos_file_id"
  ON "service_visit_photos" ("file_id")
```

全量日志里**只有这一条** `CREATE INDEX` —— NocoBase 自己**从未**为它下发过建索引语句。
确认是「从未发出」，而非「发出了又失败」。

### 4.4 反证：摘掉兜底后索引真的没有

临时注释掉 `plugin.ts` 里的 `this.registerIndexReconciliation();`，手工 `DROP INDEX`，重启：

```console
$ docker compose exec -T postgres psql -U svc_app -d service_ticket -c \
    "SELECT indexname FROM pg_indexes WHERE tablename='service_visit_photos' AND indexdef ILIKE '%file_id%';"
(0 行)
```

同时真机验收脚本立即变红，且报错信息直接指向根因：

```
❌ unique(file_id) 已建立（同一文件不得重复挂到两次上门） — 未找到 file_id 唯一索引
❌ service_visit_photos 的声明式索引全部落库（3 条） — 缺失 1/3 条：file_id（无索引）
   [根因通常是 NocoBase refreshIndexes() 静默丢索引，见 docs/DEVIATIONS.md DEV-16]
❌ 通过 53 项，失败 2 项
```

恢复接线后回到 **55/55**。这组「红 → 绿」的对照证明了两件事：
**① 缺陷是真实的；② 兜底逻辑与验收断言都不是空壳。**

### 4.5 根因（源码定位）

`@nocobase/database` 的 `collection.refreshIndexes()`（`lib/collection.js:673-689`）在重建
`model._indexes` 时按以下条件过滤：

```js
item.fields.every((field) => attributes[normalizeFieldName(field)])
```

**只要引用到的某一列还没注册到 model 上，整条索引就被丢弃 —— 不抛错、不告警、不重试。**
而 `refreshIndexes()` 只由 `addIndex()/removeIndex()` 触发，后者由字段级索引注册触发
（`fields/field.js:140`、`fields/belongs-to-field.js:130`），因此「丢不丢」取决于
**字段注册顺序**。`file_id` 指向的是 NocoBase 核心 collection `attachments`，
其关系的注册时机落在本插件 collection 的索引刷新之后，于是这条索引每次都被过滤掉。

另外，Sequelize 建索引读的是 `model._indexes` **而不是** `options.indexes`
（`sequelize/lib/model.js:989`），而 NocoBase 的 `SyncRunner.performSync` 就是裸调
`sequelize.Model.sync.call()` —— 所以一旦被 `refreshIndexes()` 丢弃，
`db.sync()` **没有任何第二次机会**把它补回来。

### 4.6 修复

见 `docs/DEVIATIONS.md` **DEV-16**：新增 `src/server/ensure-indexes.ts`，
用**公开**的 `queryInterface.showIndex()/addIndex()` 在 `afterLoad` 之后核对补齐，
按「列集合 + 唯一性」做**语义等价**判定（不看索引名，因此能与字段级 `unique` 生成的
PG UNIQUE CONSTRAINT 正确互认），只增不删，补齐失败则抛错阻断启动。

实测补齐效果：

| 时机 | 日志 |
|---|---|
| 首次加载 | `索引核对：新建 8 条 / 已存在 27 条`（当时曾整体删表重启，8 条一次性暴露） |
| 之后每次启动 | `索引核对：新建 1 条 / 已存在 34 条`（即 §4.2 的那一条） |
| 同一次加载的第二遍 | `索引核对：新建 0 条 / 已存在 35 条`（幂等） |

### 4.7 为什么离线校验抓不到

桩环境里 `db.collection()` 只是把定义对象塞进一个 `Map`，**根本没有 `db.sync()`，
也没有 `refreshIndexes()`**。因此「插件声明了什么」离线可验，
但「声明的东西最终有没有落到 PostgreSQL」**只能在真机验**。

这就是本次把索引清单独立成 `scripts/expected-indexes.mjs` 并**双向布防**的原因：

| 层 | 载体 | 卡住什么 |
|---|---|---|
| 离线 | `verify-plugin-load.mjs`（新增 2 项） | 源码**声明**漂移（删了/改了/多声明了索引） |
| 真机 | `smoke-test.mjs`（新增 11 + 1 项） | 声明**落库**失败（本次 DEV-16 这类） |

两个守卫都做过反向注入验证，确认不是「永远通过」的空壳：
删掉 `file_id` 声明 → 离线校验报 `service_visit_photos(file_id) UNIQUE: 清单要求但源码未声明`；
多声明一条 `stores(name)` → 报 `源码已声明但清单未登记`。

---

## 五、其他一并解决的真机问题

| # | 问题 | 现象 | 处理 |
|---|---|---|---|
| 1 | `underscored` 默认 false | 表名/时间戳列为驼峰，与文档和验收 SQL 全面对不上；索引里写 `created_at` 会报 `42703 undefined_column` 并导致启动失败 | 强制全部 collection 经 `defineAppCollection()` 启用 `underscored: true`（DEV-14） |
| 2 | 配置表名与核心冲突 | 沿用 `systemSettings` 会被 `hasCollection()` 判「已存在」而**静默跳过注册**，参数一条都种不进去 | 改名 `serviceSettings` / `service_settings`（DEV-15） |
| 3 | 4 组重复同义唯一索引 | 同一列上同时存在字段级 UNIQUE CONSTRAINT 与 collection 级 UNIQUE INDEX | 删除冗余声明并 `DROP INDEX`（DEV-17） |
| 4 | 唯一索引查询查错了系统表 | collection 级唯一索引落库是 UNIQUE INDEX，查 `pg_constraint(contype='u')` 查不到 → 验收误报 | 改查 `pg_indexes` |
| 5 | `psql -c "INSERT … RETURNING"` 输出多一行命令标签 | `Number()` 整段变 `NaN` | 取号断言改为只取首行 |
| 6 | `docker logs --since` 不接受 Go 时间字符串 | `invalid value for "since"` | 转 Unix 秒 |
| 7 | `docker compose restart` 期间旧进程仍在服务 | 健康历史出现「假成功」探针，导致 1 条 error 日志被误计 | 改取健康历史**尾部连续成功段**的起点 |

---

## 六、复现本报告的全部命令

```bash
cd /path/to/service-ticket

# —— 准备 ——
node scripts/gen-secret.mjs            # 生成 .env（已存在则跳过）
node scripts/build-plugin.mjs          # 编译插件产物
node scripts/verify-config.mjs         # 离线部署层 41 项
node scripts/verify-plugin-load.mjs    # 离线插件生命周期 31 项

# —— 启动 ——
docker compose up -d
sleep 90
docker compose ps                      # 三容器应为 Up (healthy)

# —— 真机端到端验收（唯一需要 Docker 的一步）——
node scripts/smoke-test.mjs            # 55 项

# —— 手动复核 ——
curl -s http://localhost:8080/api/svc/health
curl -s http://localhost:8080/api/svc/health \
  | tr -d ' \n' | grep -q '"db":"ok","sms":"mock","tasks":"ok"' && echo PASS || echo FAIL

docker compose exec -T postgres psql -U svc_app -d service_ticket -c \
  "SELECT tablename, count(*) FROM pg_indexes
   WHERE schemaname='public'
     AND tablename IN ('stores','store_users','service_tickets','service_visits',
       'service_visit_photos','ticket_events','sms_logs','daily_sequences',
       'api_guards','idempotency_records','service_settings')
   GROUP BY tablename ORDER BY tablename;"

# 确认 DEV-16 的兜底在工作（每次重启都应看到「新建 1 条 / 已存在 34 条」）
docker compose restart app && sleep 45 && docker compose logs app --since 1m | grep 索引核对
```

---

## 七、遗留限制（真机验收后更新）

原 `docs/PHASE-1.md`「已知限制」中第 1 条（**未在真实 Docker 中启动过**）**已关闭**。
其余限制仍然成立：

| # | 限制 | 状态 |
|---|---|---|
| 1 | 未在真实 Docker 中启动过 | ✅ **已关闭** —— 见本报告 |
| 2 | HTTPS 未启用（微信内置浏览器要求 HTTPS） | ⏳ 待 Phase 10 证书就绪；**上线前必须完成** |
| 3 | 短信全为 `mock`（`SMS_ENABLED=false`） | ⏳ 真实通道适配器在 Phase 4 / 8 |
| 4 | H5 目录为占位页 | ⏳ Phase 3 产出真实 Vue3 应用 |
| 5 | `NOCOBASE_EXTRACT_CLIENT_ASSETS=false` 的性能取舍 | ⏳ Phase 10 压测后评估 |
| 6 | `.env` 已生成真实随机密钥，切勿外传 | ⚠️ 长期注意 |

> 另需注意：**`docs/PHASE-1.md` 正文里多处以 `systemSettings` / `system_settings` 书写**
> （含内联的早期代码摘录与验收 SQL），那是 DEV-15 改名前的版本。
> **权威定义以 `docs/DATA-MODEL.md` 与 `nocobase/plugins/service-ticket/src/**` 为准**
> （现名 `serviceSettings` / `service_settings`），本报告与 `docs/DEVIATIONS.md` 已按现名书写。

---

## 八、下一步

Phase 1 的全部验收门槛已达成，可进入 **Phase 2 — 数据模型 / 权限 / 工单底座**
（详见 `docs/DEV-PLAN.md` 与 `docs/PHASE-1.md` 的【下一阶段】）。

Phase 2 验收门槛：AT-03 门店隔离有效；并发 100 次取号无重复、无空洞。

> 工程约定提醒：本次 DEV-16 的教训是「**验收不能只验『接口 200』**」。
> Phase 2 起，凡涉及约束/唯一性/隔离的需求，都必须写成可执行断言，
> 且**离线比声明、真机比落库**两层都要有。

---

## 九、Phase 2 复跑时的变化（本报告为 Phase 1 快照，勿据此判断当前状态）

本报告记录的是 **Phase 1 时点**的数字，Phase 2 已把它们推进（见 `docs/PHASE-2.md`）：

| 项 | Phase 1 时点 | Phase 2 当前 |
|---|---|---|
| `smoke-test.mjs` | 55 项 | **63 项**（新增 §4b Phase 2 验收 8 项） |
| `verify-plugin-load.mjs` | 31 项 | **53 项**（新增权限/字段白名单/logLevel 守卫与种子覆盖） |
| `verify-config.mjs` | 41 项 | 41 项（项数未变，修掉 2 项**误报**：跨行 `rewrite` 被判漏分号、具名捕获被判未定义变量） |
| 索引 | 35 条声明式全部落库 | 不变（`ensure-indexes` 仍每次启动语义等价核对） |

> ⚠️ 别把本报告里的"全绿"当成当前状态 —— 每次部署后请按 `docs/PHASE-2.md` §6 重跑三套脚本。
