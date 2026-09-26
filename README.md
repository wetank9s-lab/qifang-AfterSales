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
| [`docs/PHASE-4.md`](docs/PHASE-4.md) | **Phase 4 交付报告（🟢 PASS，阶段已关闭）**：派工 / 改派 / 改约（A→J）、**Visit 生命周期 = 终止旧 Visit + 新建 Visit**、事务性发件箱、`SmsProvider` 抽象、总闸 §4d 16 项、八条高风险闸门证据映射、**DEV-41~DEV-74**、**DEV-45 已接受**、**§13 H 后台页面交付说明**、**§13.4.A 四层验收方法论（DEV-68/69）**、**§13.4.B 第二轮走查 P0/P1 整改（DEV-70~73）**、**§13.4.C 详情 404 真机制（DEV-74）** |
| [`docs/PHASE-4-I-UAT.md`](docs/PHASE-4-I-UAT.md) | **Phase 4-I 真人走查记录**：本轮范围（首轮已证的数据隔离结论**保留不重验**）、**三层验收模型 + 业务层**、8 步操作闭环、**锁定的 9 条 PASS 门槛**、主持规范（**禁止预提示**）、**「编辑/删除」盲测项**、收尾提问、走查后数据复核、清理口径 |
| [`docs/PHASE-4-I-UAT-SHEET.md`](docs/PHASE-4-I-UAT-SHEET.md) | **走查现场记录表（打印/对照用一页版）** —— 实时对照，避免现场翻长文档；§8 已落 **PASS** 签字与结论表 |
| [`docs/PHASE-5.md`](docs/PHASE-5.md) | **Phase 5 阶段计划（🟢 PASS，阶段已关闭 2026-09-25）** —— 师傅 H5：阶段状态表、目标与范围、复用件盘点、交付物清单、**五个关键设计决策**、**Token 失效矩阵 6 条硬验收**、照片 1–6 张口径、M8 提交与状态机、反向验证清单、前置核查闸门、风险与限制、**§13 P5-2 收口验收**、**§14 关闭记录**、**§15 下一阶段（Phase 6 从 WAIT_STORE_CONFIRM 接力）** |
| [`docs/PHASE-5-P5-1-EVIDENCE.md`](docs/PHASE-5-P5-1-EVIDENCE.md) | **P5-1 交付证据（🟢 PASS，基线 `297e728`）** —— 四组证据逐条实测值：① Token HTTP 矩阵（8 格 + 反枚举）② 上传安全矩阵（20 项）③ Submit 原子性前后快照 + R1/R2 反向 ④ 真实浏览器走查 6 步（含 DEV-80）+ **⓪ 新发现三类分诊 + ⑥b HOLD 两项整改** |
| [`docs/PHASE-5-P5-2-UAT.md`](docs/PHASE-5-P5-2-UAT.md) | **P5-2 手机真人走查方法（🟢 PASS，2026-09-25 收口）** —— 从短信形状 `/t/{token}` 出发的**普通技师视角**验收、**禁止预提示**、锁定的 PASS 门槛、**五个阻断项 vs 视觉 backlog**、**三个自然问题**、**§8.4 真人 UAT 真实轨迹（首轮 PASS + 反馈 + DEV-82 收口）**、数据复核与清理 |
| [`docs/PHASE-5-P5-2-UAT-SHEET.md`](docs/PHASE-5-P5-2-UAT-SHEET.md) | **P5-2 现场记录表（打印/对照用一页版）** —— 开场台词、三个必答问题逐字记录、阻断项勾选、签字结论 |
| [`docs/PHASE-6.md`](docs/PHASE-6.md) | **Phase 6 门店确认/驳回 阶段计划与契约（🟢 PASS，阶段已关闭 2026-09-26）** —— 起点 = `WAIT_STORE_CONFIRM`；**P6-0 🟢 PASS（基线 `0d45b09`）** / **P6-1 🟢 PASS（领域事务 + I12/I13 API，基线 `c593bcd`）** / **P6-2 🟢 PASS（审核 UI 接线 + 两条真人走查，候选基线 `3ff8936`，走查工具 `0ea4a45`）**；子阶段划分；**审核对象钉死 = 当前 SUBMITTED Visit**；**照片访问四边界矩阵**（本店 200 / HQ 200 / 跨店 404 / 匿名 401）+ 反向用例；并发"陈旧页面不得覆盖"规则；**§6.3 只读视图落点 = 内联 H3，不新建动作**；**§12 交付状态表 + §12.1 机器门计数**；复用件盘点（**不改模型**）；**§14 关闭记录（含冻结语义、已知中间态、下一阶段入口）** |
| [`docs/PHASE-7.md`](docs/PHASE-7.md) | **Phase 7 客户评价闭环 短契约 + 关闭记录（🟢 PASS → 🔒 CLOSED，2026-09-26，功能交付基线 `baf82aa`）** —— §1 **提交 × 超时竞争的 winner 裁决**（条件 UPDATE + 影响行数）· §3 匿名 API 与稳定业务码（`410 REVIEW_EXPIRED` / `409 REVIEW_ALREADY_SUBMITTED`）· §4 Token 生命周期与窗口张力 · §5 **收费三态的服务端权威** · §6 reopen 规则（低分阈值 / 金额不一致 / 3 星仅 HQ 关注）· §8 **评价短信开启 + 存量 backfill**（含 **§8.3.1 执行记录**）· §9 `/f/{token}` 路由 · §10 字段白名单 · §13 开放项 · **§14 交付与验收记录**（裁定 / **首跑失败 DEV-89/90 历史** / backfill 执行事实与幂等策略 / 门禁计数 / **未执行项** / 遗留 backlog） |
| [`docs/PHASE-8.md`](docs/PHASE-8.md) | **Phase 8 后台任务可靠性 + SMS 失败恢复闭环 短契约（🔒 语义冻结 → 🟢 PASS，2026-09-26，§10 交付记录）** —— §0 定位与**明确不做**（webhook / SLA 提醒短信 / 营业日历 / Dashboard / **delivery callback**）· §1 **任务可观测性**（`lastRunAt`/`lastSuccessAt`/`lastResult`/`lastProcessedCount`/`lastError`，**只记最近运行、不建 job history**）· §2 **SMS retry 上限冻结为 1 次** + **唯一并发门**（原子 claim，**不得先 SELECT 看 retry_count**）+ 告警出口只做"**可发现**"· §3 **SLA 只检测不发短信** + **§3.3 `appointment_overdue_grace_minutes` 按"预计日期结束 23:59:59 + grace"解释**（**不得**用 DB 归一化的 12:00 当基准）+ §3.4 **不得每次扫描无条件写 TicketEvent** · §4 health `tasks` 假字段转正 · §5 沿用架构约束 · §6 **4 个重门禁** · §8 开放项（O8-1~O8-6 已落定） · §10 交付记录 |
| [`docs/PHASE-8-PREWORK.md`](docs/PHASE-8-PREWORK.md) | **Phase 8 开工前事实清点（仅取证，非契约）**（`f1fe312`）—— 定时任务基础设施现状（`cronJobManager` 可用 / workflow 未启用 / 幂等靠原子谓词）· 🔴 **`sla.*` 三键已播种但全仓零消费**、索引 `(status, expected_visit_at)` **已建** · SMS retry 现状与 `sms.retry_count` **"文档要求最多 1 次"= 需求上限** · health 成熟但 `tasks` **是假字段** · 候选工作项与 6 个待裁决问题 |
| [`docs/PHASE-6-P6-0-EVIDENCE.md`](docs/PHASE-6-P6-0-EVIDENCE.md) | **P6-0 交付证据（🟢 PASS，阶段已关闭 2026-09-25，基线 `0d45b09`）** —— §5 冻结矩阵逐条实测值：① 四边界 B1~B5（**24/24**）② N1 原生口封禁（含 `storage_key` 泄漏的 **DEV-83**）③ R1/R2/S1/O1 ④ U1 机器层 + **人眼层（已执行一次并通过，含取证边界）** ⑤ **真实浏览器闸门 §3.7 第③层**（照片真的解码）⑥ **本轮三处假红的根因与反向验证** ⑦ 停止线（P6-0 不含写操作）⑧ 机器门计数 |
| [`docs/PHASE-6-P6-0-UAT-SHEET.md`](docs/PHASE-6-P6-0-UAT-SHEET.md) | **P6-0 现场记录表（打印/对照用一页版 · ✅ U1 PASS）** —— U1 人眼项清单：9 条"应当出现" + 4 条"**不应出现**的写入口" + 5 条阻断项 + 结论签字；**§六 走查执行记录**（3 张工单逐条实测 + **取证边界：截图像素未回读 / 未执行项如实标注**） |
| [`docs/PHASE-6-P6-1-CONTRACT.md`](docs/PHASE-6-P6-1-CONTRACT.md) | **P6-1 事务契约（🔒 FROZEN / 已履行，2026-09-25 定稿 → 2026-09-26 随 Phase 6 关闭）** —— `confirmed_charge_amount` 如何形成 / 驳回原因与 Visit 后续语义 / 并发 loser 的返回码与响应体（**条件 UPDATE + 影响行数**，非行锁；契约 C16 的 422 已按实现修正为 **409**） / I12·I13 幂等键与重放语义 / confirm → `WAIT_FEEDBACK` 的评价 Token·短信边界（**O1-B：不发送评价短信、不实现 `/f/`**） / reject 之后**究竟停在哪里**等待重新处理；含**契约自检清单 C1~C26** 与**§11 七项开放项裁决（已全部定稿）** |
| [`docs/FLOW-ENGINE-NOTES.md`](docs/FLOW-ENGINE-NOTES.md) | **后台页面作业手册（改页面前必读）** —— flow-engine 页面是数据的判据、**自定义动作挂载全链路（DEV-68/69）**、`filterForm` 五条硬约束（DEV-61~64）、**客户端产物交付链（DEV-74）**、快速自检清单 |
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

# 5) 验收自检（116 项端到端断言：Phase 1 基线 + Phase 2 八项 + Phase 3 十二项 + Phase 4 十六项 + §4e 十项 + §4f 十项）
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
- 客户评价：`http://localhost:8080/f/<token>`（**稳定外部短链**，302 → `/h5/customer/review/<token>`；门店确认后短信下发，**Phase 7 起，已交付**）
  > ⚠️ 早期草案写的 `/h5/review/<token>` **已作废** —— 冻结路由是 `/f/{token}` → `/h5/customer/review/{token}`（P6-1 契约 §11.3 冻结路由名，Phase 7 实现）。
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
| `node scripts/verify-config.mjs` | compose 挂载点 / nginx 语法与变量 / `.env` 交叉一致性 / **NocoBase 版本冻结断言**（56 项，含 UAT 账号键完整性） | ❌ |
| `node scripts/verify-plugin-load.mjs` | 桩环境跑一遍插件生命周期 + 健康检查 + 索引声明守卫 + 权限与字段白名单守卫 + **【4d】两个 Phase 4 探针的自毁闸** + **声明 action 可达性守卫**（61 项） | ❌ |
| `node scripts/expected-indexes.mjs` | 索引验收**单一事实来源**（离线与真机共用同一份清单） | ❌（被引用） |
| `node scripts/expected-versions.mjs` | **版本冻结单一事实来源**（NocoBase 版本 pin，被离线与真机断言引用） | ❌（被引用） |
| `node scripts/verify-client-logic.mjs` | **客户端纯逻辑离线验收（58 项）**：H6 按钮状态矩阵（每个工单状态该出现哪些按钮）+ H3 时效文案（已等待 / 距预约 / 已超过预约 / 总耗时 / 尚未响应 / 今天明天）+ **写请求契约**（`X-Request-Id` 必带 UUID v4、网络重试复用同号、HTTP 有响应不重试）+ **派工参数契约**（`service_mode` 恰为 `inhouse`/`manufacturer`/`third_party`、`remote` 不出现、`manufacturer`/`third_party` 未填 provider 前端拦住）+ **P6-2 门店审核接线（按钮显隐 / payload+request-id / 成功后刷新 / 409 刷新）**。用 esbuild 编译零依赖纯模块后在 Node 里断言 —— 浏览器里的逻辑除此之外**没有**任何自动验证 | ✅ |
| `node scripts/smoke-test.mjs` | **真机端到端验收（总闸，106 项）**：容器健康、容器内插件解析、日志证据、健康检查门槛、Nginx 头与路由、11 张表与**35 条声明式索引逐条落库**、参数种子、**Phase 2 八项（资源授权 / 字段白名单 / AT-03 门店隔离 / 并发 409 / 事件必写 / 授权表零无主行）**、**Phase 3 十二项（门店列表最小披露 / 建单 201 恰好三字段 / request_id 幂等重放 / 隐私 400 两形态 / 缺请求号 422 / 重复单 409 / 应用层 429 / Phase 3.1 判重 A~E 五项）**、**Phase 4 十六项（通道未就绪不阻断派工 / Visit#1 与派工快照 / 两 scene 短信 / accepted≠delivered / Token 只存 sha256 / 重复派工 409 / 改派 = SUPERSEDED+新建 / **改派后旧 Token 立即失效** / 三 scene 短信 / 改约不新建 Visit 且换发 Token / 失败形态统一 TOKEN_INVALID / 被拒改派零副作用 / 责任人未变 422 / 门店越权 404 / 派工链无断点）**、稳定性、**§4e 后台可用性 12 项（客户端产物 / 元数据齐备 / 时间戳与 interface 自愈 / 带 Origin 登录 / 来源校验反向对照 / **Phase 4-H 四张页面落库 / 区块不引用敏感列 / 状态 Tab 默认筛选完整 / 角色菜单可见性矩阵 / 单工单列表入口 / 客户端 AMD 依赖可解析 / svc:visits 按 ticket_id 且不泄露凭据**）**、**§4f H6 契约收口 10 项（已部署产物的派工选项与 `X-Request-Id` 装配 / 用与 UI 相同的 payload+header 真打厂家派工 / 缺 provider 服务端仍 MISSING_PROVIDER / 四动作×三种坏头部全 422 / **同 request id 重放 reschedule 后 Visit·事件·短信·Token 均不变** / 幂等命中只标响应头 / 换操作者不算重放）** | ✅ |
| `node scripts/seed-admin-pages.mjs` | **Phase 4-H 后台页面播种**（幂等：页面已存在则 `mode=replace`，否则 `create`）。四张页面：我的门店工单（6 状态 Tab）/ 全量工单 / 工单事件时间线 / 派工记录。<br>**另含自定义动作挂载**（DEV-68/69）：给 7 张工单表的行操作列挂 **详情 / 受理 / 派工 / 改派 / 改约** 五个 `ActionModel` —— 因 `applyBlueprint` 的 `actions` 在架构上无法声明自定义动作，只能直写 `flowModels`；另有对账步骤把孤儿行收敛到 `表数 × 5`。退出码 `0` / `1`（校验 400 原样打印）/ `2`（环境未就绪）；支持 `--dry-run` / `--list` | ✅ |
| `node scripts/ticket-page-actions.mjs` | 自定义动作的**纯函数模块**（uid 稳定派生 + 扁平行形状）。被播种脚本与结构断言共用，文件头记录 DEV-68/69 的完整证据链与 `flowModels` 读写 API 边界 | ❌（被引用） |
| `node scripts/verify-ticket-actions.mjs` | **「自定义动作已挂到页面上」的结构验收（10 项，读真实 `flowModels` 而非源码）**：五模型已注册（源码 + 产物）/ 每张工单表 5 个实例齐全**且顶层 `use` 正确** / `TicketDetailActionModel` 已实例化 / 无脚本注入的原生写路径 / 行数恒为 `表数 × 5` / 0 孤儿 / 0 病态行。<br>`--reverse` 做**反向验证**（铁律 8）：删一条 `TicketAcceptActionModel` → 判据必须变红并点名该表 → 还原后回到全绿。`--verbose` 打印各表明细。退出码 `0` / `1` / `2`（环境未就绪） | ✅ |
| `node scripts/expected-sensitive-columns.mjs` | 「绝不能出现在后台界面上的列」**单一事实来源**（播种脚本与总闸共用同一份），另含页面清单与状态 Tab 清单 | ❌（被引用） |
| `node scripts/verify-phase3-h5.mjs` | **Phase 3 客户 H5 验收**（35 项）：前后端契约对齐（长度/正则/版本号/头名源码级比对）、提交器行为（连点 10 次 single-flight、失败重试复用 request_id、内容变化换号、响应收敛为 3 字段）、**同 request_id 并发 10 路真机 E2E**（恰好 1 张单 + 序号仅 +1）、构建产物与 nginx 交付（字节一致 + 缓存头） | ✅ |
| `node scripts/verify-concurrency-phase2.mjs` | **100 路真实并发取号**（Phase 2 门槛的唯一解除手段；2026-09-20 已通过，8 条断言全绿、退出码 0）。依赖 `POST /api/public/tickets`；接口未就绪时以退出码 2「环境未就绪」收场（不是绿灯，也不是红灯）。**跑之前两层限流都要放宽，见「快速开始」第 6 步** | ✅ |
| `node scripts/verify-store-photo-access.mjs` | **P6-0 门店回执读模型 + 私有照片访问闸门**（**24 正向 + 9 反向**）：四边界矩阵（本店 200 / HQ 200 / 跨店 404 / 匿名 401）+ **N1 原生口整资源封禁**（`serviceVisitPhotos` 原生口 → 403，修掉 DEV-83 `storage_key` 泄漏）+ 真实 Chromium 点开抽屉验「照片真的解码」。`--reverse` 做反向验证 | ✅ |
| `node scripts/verify-store-review-write.mjs` | **P6-1 门店 confirm/reject 事务门禁**（**58 正向 + 9 反向**，契约 §10 的 **C1~C26**）：**事务矩阵**（confirm/reject 逐字段 before→after）· **故障回滚**（C23 七子项 + 五面泄漏扫描）· **真并发 + 幂等**（`Promise.all` 三组 confirm×confirm / confirm×reject / reject×reject，每组独立 fixture、winner 不固定、唯一索引兜底守 `visitId`）。首跑抓出 **DEV-86** 三处真实缺陷 | ✅ |
| `node scripts/walkthrough-p6-2-browser.mjs` | **P6-2 门店审核真实浏览器走查**（Chromium/CDP）：确认路径（收费 → 确认成功 → `WAIT_FEEDBACK` 按钮消失）+ 驳回路径（不收费 → 驳回成功 → `PROCESSING` → `svc:dispatch` 新建 ASSIGNED Visit#2）。支持 `WALKTHROUGH_MODE=confirm/reject` 单条分跑、`WALKTHROUGH_TICKET_NO` 指定工单；配套 `prepare-p6-2-walkthrough.mjs`（造走查工单 + `--cleanup`） | ✅ |

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
| Phase 3 客户 H5 报修 | ✅ **完成** —— A→I 全部交付；100 路真实并发验收 **8 条全绿**（已解除 Phase 2 挂起项）；H5 自身验收 **35 项全绿**；阶段内 AT-01/AT-02/重复提交/限流验收已并入总闸 `smoke-test.mjs` §4c。**Phase 3.1 重复单修正**已落地并复验 |
| Phase 4 派工 / ServiceVisit / 双短信 | 🟢 **PASS（阶段已关闭，2026-09-23）** —— 服务层 A~G 与总闸 J 完成（§4d **16 项**真机全绿）、**DEV-45 已接受**；后台页面 H 已交付并**完成自定义动作挂载整改**（DEV-68/69：`ActionModel 已注册` ≠ `Action 已挂到页面` —— 五按钮已在 H1/H2 **真实渲染**，结构断言 + 反向验证 + preflight §3.6 闸门全部就位）；**I 真人 UI 走查四轮闭环**（第二轮 P0/P1 ⇒ 第三轮「详情 404」⇒ DEV-74 交付链修复 ⇒ 第四轮复测 PASS）。详见 `docs/PHASE-4.md` |
| Phase 5 师傅 H5 | 🟢 **PASS（阶段已关闭，2026-09-25）**（分包推进，见 `docs/PHASE-5.md`）—— **P5-0 Routing & Environment Gate ✅ PASS**（`7b7e232`）· **P5-1 Technician API/H5/Security 🟢 PASS**（正式基线 **`297e728`**，2026-09-25 裁定）· **P5-2 Mobile Human UAT 🟢 PASS**（真人跑通核心链路 + 一次性 Token；唯一条件项 **DEV-82** 说明条件必填已收口，`14c5b1a`，见 `docs/PHASE-5-P5-2-UAT.md` §8）。硬验收 = **Token 失效矩阵 6 条**（`401 TOKEN_INVALID`，HTTP 层取证）。**下一阶段从 `WAIT_STORE_CONFIRM` 接力**（门店确认/驳回） |
| Phase 6 门店确认 / 驳回 | 🟢 **PASS（阶段已关闭，2026-09-26）** —— 计划/契约 `docs/PHASE-6.md` + `docs/PHASE-6-P6-1-CONTRACT.md`（🔒 FROZEN）。**P6-0** = Store Review Read Model & **Photo Access Gate**（只读 + 私有照片受控访问）→ 🟢 **PASS（基线 `0d45b09`）**：§5 四边界矩阵 **24/24 正向 + 9/9 反向**（本店 200 / HQ 200 / 跨店 404 / 匿名 401）、N1 原生口封禁（顺带修掉 **DEV-83**）、真实浏览器闸门 §3.7 第③层「照片真的解码」**绿**、**U1 人眼项已执行一次并通过**（取证边界见 `docs/PHASE-6-P6-0-EVIDENCE.md` / `-UAT-SHEET.md` §六）。**P6-1** = confirm/reject 事务（落 M9/M10）→ 🟢 **PASS（领域事务 + I12/I13 API，基线 `c593bcd`）**：门禁 `verify-store-review-write.mjs` 覆盖 **C1~C26**，**正向 58/58 + 反向 9/9**（事务矩阵 / 故障回滚 / 真并发 + 幂等三组硬证据）；首跑抓出 **DEV-86** 三处真实缺陷（幂等重放被前置校验短路、跨店 404 存在性探测器、响应整行下发 Ticket）并已修复。**P6-2** = 审核 UI 接线 + 真人走查 → 🟢 **PASS（候选基线 `3ff8936`，走查工具 `0ea4a45`）**：确认/驳回两个薄动作落在「技师回执」区块（H3 内联），两条真人走查（确认 → `WAIT_FEEDBACK` 按钮消失；驳回 → `PROCESSING` + `svc:dispatch` 新建 ASSIGNED Visit#2 返工接力成立）**全过**。**不重新设计 Ticket/Visit 模型** |
| Phase 7 客户评价闭环 | 🟢 **PASS → 🔒 CLOSED（2026-09-26 裁定，功能交付基线 `baf82aa`）** —— 短契约 `docs/PHASE-7.md`（**§14 交付与验收记录**）。闭环：`WAIT_FEEDBACK` → 评价短信 → **`/f/{token}`（302）** → 匿名评价 H5 → 提交 → **正常 `CLOSED` / 低分或金额不一致 `reopen` → 超时自动 `CLOSED`**。**七项高风险全部有实测证据**：Review Token 独立定义且 **hash-only**（库中只存 sha256，明文 0 泄露）· 一次性提交 · 跨 Token/过期访问 · 金额核对三态（服务端最终权威）· reopen 事务 · 评价短信链接安全 · **超时与提交竞争**。**并发裁决 = 条件 UPDATE + 影响行数**（`submit×submit` / `submit×expiry` 均有真并发证据，恰好一个 winner）。门禁 `verify-review-loop.mjs` **126 项**（含 E/F 真并发）· `verify-review-routing.mjs` **23 项 + 反向** · 真实 Chromium 走查 **①②③ 全绿**。**首跑是红的**：抓出 **DEV-89**（`null` 哨兵被 `Number()` 摧毁 ⇒ 两条正常路径全 422）与 **DEV-90**（`type="number"` + `string` ref ⇒ 输入金额即白屏），均已修复并**原场景重跑穿透验证**；**DEV-89 曾遮蔽 DEV-90**。**O1-B 未被推翻** —— 本阶段是**履行 O1-B 当时预留的启用条件**（DEV-88），Phase 6 的 C19/C20 验收口径全部保留有效 |

| Phase 8 后台任务可靠性 + SMS 失败恢复闭环 | 🟢 **PASS（2026-09-26 交付）** —— 短契约 `docs/PHASE-8.md`（**§10 交付记录**）。三条纵向能力 **P8-A 任务可观测性 → P8-B SMS retry + 终局失败可见 → P8-C SLA overdue 检测** 一次性交付。`health.tasks` 假字段转正（`tasksOverall` + 逐任务 `lastResult/lastSuccessAt/runCount` + `tasksRegistered` 真实计数）；SMS retry **原子 claim（条件 UPDATE + RETURNING，全仓 0 行锁）**，终局失败经 `health.smsTerminalFailed`/`smsRetryPending` 可发现；SLA **纯读不写库**、`appointmentOverdueFrom()` 落实 DEV-71 日期语义（**12:00 技术值不被污染**）。门禁 `scripts/verify-task-reliability.mjs` **正向 25 项全绿 + 反向 6 项精确转红**（容器内单进程探针跑真实连接池）；smoke 118 / plugin-load 62 全绿。**明确不做**：外部告警 webhook / SLA 提醒短信 / 营业时间日历 / 运营 Dashboard（Phase 9）/ **delivery callback 新工程**。`review-expiry` 接入可观测性但**不重写领域逻辑** |

**Phase 0 结论：通过。**
**Phase 1 结论：通过。** 交付物 = 一条 `docker compose up -d` 可拉起的项目骨架：
三容器编排、11 张表定义、`/api/svc:health`（兼容 `/api/svc/health`）健康检查、
16 项参数种子、Nginx 限流与安全基线、离线自检脚本（当时 72 项断言 = `verify-config` 41 + `verify-plugin-load` 31）。
**真机验收已完成**：三容器 `Up (healthy)`，`smoke-test.mjs` 55/55（Phase 1 时点数），
11 张表 + 35 条声明式索引全部落库（见 `docs/VERIFY-PHASE-1.md`）。

**Phase 2 结论：PASS（2026-09-20 补签）—— 验收门槛已全部满足。**
服务端底座（三级权限模型：全局 action → 资源级授权 → 字段白名单；双层门店隔离；
原子取号；状态机 M1/M2/M6/M7；事件必写；参数配置）**真机验收通过**：
`smoke-test.mjs` **116/116**（Phase 2 时点数为 64；Phase 3 收尾后 71，Phase 3.1 后 76，Phase 4 服务层后 92，Phase 4-H 页面后 102，H3/H6 + 角色矩阵后 106，**H6 契约收口后 116**）、`verify-plugin-load.mjs` **59/59**、`verify-config.mjs` **48/48**、`verify-client-logic.mjs` **36/36**、`verify-phase3-h5.mjs` **35/35**（合计 **294 项**全绿）。
⚠️ 数字会随阶段演进，引用时以脚本实际输出为准。

> ⚠️ 上面的数字会随阶段演进，**引用时以脚本实际输出为准**，不要照抄本文。
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
① **服务端契约**进总闸 —— `smoke-test.mjs` §4c **12 项**（H6 契约收口后总闸 **116 项全绿**）；
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

**Phase 4 结论：服务层 ✅ PASS / 阶段整体 🟡 HOLD（2026-09-21 复核方裁定；2026-09-23 完成动作挂载整改）。**

> **2026-09-23 整改说明**：首轮真人走查 **PARTIAL PASS / BLOCKED** —— 数据隔离全部成立
> （UAT-A 只见 S01 / UAT-B 只见 S02 / UAT-HQ 见两店 / 工单号搜索可用 / 对象级越权 404），
> 但三个角色**均只能查看、无法受理/派工**。根因**不在 ACL、也不在 TicketService**，而在
> H3/H6 的自定义 `ActionModel` **只在客户端注册、从未挂到页面实例上**。
> 两条架构级约束已留档（`docs/DEVIATIONS.md`）：
> **DEV-68** `applyBlueprint` 的 `actions` 在架构上无法声明自定义 ActionModel（只收编译期
> 硬编码 catalog key，而自定义动作只注册在浏览器引擎 —— 两个互不相通的世界）；
> **DEV-69** `flowModels:save` 的 payload 就是**扁平 model 对象本身**，再包一层 `{values:…}`
> 会让顶层没有 `use` → 客户端解析不出 → **静默不渲染**，而"行存在"使只数行数的断言全绿。
> 整改后五按钮在 H1/H2 **真实渲染**（无头浏览器实测），`verify-ticket-actions.mjs` 10 项
> + 反向验证 + `uat-preflight.mjs` §3.6 闸门全部就位。**H3/H6 动作链仍需真人在整改后重走。**

派工 / 改派 / 改约三动作（M3/M4/M5）已在**真机 + HTTP 层**被锁住：
① **Visit 历史不可覆盖由数据模型保证** —— 改派 = 旧 Visit 置 `SUPERSEDED` + 新建 Visit（旧行一个字段都不改），
返工可追溯不再依赖"人记得别覆盖"；
② **改派后旧 Token 立即失效**（本阶段硬门槛）—— 同一实例、同一 Token 由 `valid:true` 变 `valid:false`，
库内 `token_revoked_reason=reassigned` 已置位；
③ **客户与师傅不共用模板** —— 首次 `dispatch_customer` + `technician_task`，改派再加 `technician_assignment_cancelled`（取消通知）；
④ **短信失败不回滚派工** —— 事务性发件箱（事务内写 `pending`、提交后发送），且 `accepted` ≠ `delivered`。
以上 **16 条**断言已进总闸 §4d；八条高风险闸门逐条对应证据见 `docs/PHASE-4.md` §6。

> 🚧 **阻塞声明（强制条款）**：**H 后台页面为 🟡 部分交付**（四张页面已由 `scripts/seed-admin-pages.mjs`
> 播种并落库；**工单详情降级为「列表 + 客户端只读抽屉」**、**受理 / 派工 / 改派 / 改约业务按钮未交付**），
> 且**真实售后人员的 UI 走查（I）未进行**。按 `docs/DEV-PLAN.md` §Phase 4 Phase 4 强制条款，
> **阶段整体判定为「未关闭 / HOLD」，不得进入 Phase 5**。本阶段 ✅ 的**仅服务层** ——
> 不含任何浏览器 UI 证据：派工 / 改派 / 改约**尚未**在真实售后人员手中走查过。
>
> ✅ **已于 2026-09-23 解除**：上述两项缺口均已补齐 —— 业务按钮经 **DEV-68/69** 整改后已在 H1/H2
> **真实渲染**；UI 走查经四轮（第二轮 P0/P1 ⇒ 第三轮「详情 404」⇒ **DEV-74** 交付链修复 ⇒ 第四轮复测）
> **判定 PASS** ⇒ **Phase 4 已关闭为 🟢 PASS**，Phase 5 已获准开始。上段为当时的原始记录，保留不改。

> **走查必须由真人操作**：自动化浏览器脚本（Playwright 等）可以额外做回归，但**不能替代真人走查**
> （本条款要的是"实际人员使用后的可用性验证"）。逐屏走查脚本见 `docs/PHASE-4.md` §12.2，
> 走查观察项（除 8 步之外的 4 条）见 §13.5，H 的降级原因见 §13.2。

> ✅ **DEV-45 已接受（2026-09-21）**：复核方接受 `tokenCheck` 保留 **HTTP 200 + `{valid:false, code:'TOKEN_INVALID'}`**，
> **无需任何代码改动** —— 它是"总部已登录人员询问某个师傅 Token 是否有效"的**诊断查询**，不是拿该 Token 做认证。
> `401` 归还到它真正的位置：**Phase 5** 的 `GET /api/technician/visits/:token`（那里 Token 本身就是认证凭证）。
> Phase 5 的 Token 失效硬验收矩阵（改派前 `200` → **同一条 Token 改派后 `401`** → 新 Visit 的 Token `200`；
> 过期 / 已使用 / 随机不存在一律 `401 TOKEN_INVALID`）已写入 `docs/DEV-PLAN.md` §Phase 5。

详见 `docs/PHASE-4.md`。

