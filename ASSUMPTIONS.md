# ASSUMPTIONS.md — 默认值与待确认项

> 依据用户指令第 10 条：非阻塞性细节不明确时采用合理默认值，**不停止开发反复询问**。
> 本文档是**唯一**的默认值登记簿。每条含：默认值 / 理由 / 影响面 / 是否可逆 / 需确认时点。
> 状态：`ACTIVE`（生效中）· `PENDING`（待用户确认，不阻塞）· `CONFIRMED`（已确认）

---

## A. 架构与选型

### A-01 客户报修页使用独立 Vue3 H5，而非 NocoBase Public Form —— `PENDING`
- **默认值**：`/report` 用 `h5/` 的 Vue3 + Vite 实现，调用插件公开接口 `POST /api/public/tickets`。
- **理由**：文档 §9.1 要求"幂等"，§14 要求"重复工单检测"，§18 要求"IP/手机号频控 + 防止连点产生重复工单"。NocoBase Public Form 的 Workflow 只能在**写入之后**触发，无法在写入前拦截并返回 429/409；也无法做字段白名单与统一 `X-Request-Id` 幂等。且师傅页、评价页已确定为独立 H5，统一技术栈可减少一套表单引擎的维护成本。
- **影响面**：仅前端实现方式。数据模型、状态机、接口语义完全不变。
- **可逆性**：可逆。若坚持 Public Form，Phase 3 切换，并需接受"限流/防重降级为 Nginx 层 + 事后去重"。
- **需确认时点**：Phase 3 开始前。

### A-02 NocoBase 版本锁定 v2.2.15 —— `CONFIRMED` ✅ Phase 1 已落地
- **默认值**：使用 Community（Apache-2.0）稳定线，**实际锁定 `nocobase/nocobase:2.2.15-full-no-nginx`**（比原计划的 v2.1.x 提前一个小版本线）。
- **理由**：v2.0（2026-02-15）起许可改为 Apache-2.0，商业友好；v3 目前为 alpha（客户端架构重构、插件 API 不稳定），官方明确不建议生产使用；v1.x 已进入维护后期。插件开发 API（`defineCollection` / `resourcer.define` / `app.acl`）在 v2 已稳定。
- **Phase 1 核实结果（2026-09-20）**：
  - 镜像 tag 存在：602 MB，支持 `amd64` + `arm64`；`-full-no-nginx` 变体自带 pg 客户端与完整依赖
  - 选 `-no-nginx` 变体：与本项目「nginx 独立容器」架构匹配，避免镜像内 nginx 与外层 nginx 双重代理
  - 源码级确认的插件 API：`Plugin.beforeLoad/loadCollections/load/install/afterEnable`、`APPEND_PRESET_BUILT_IN_PLUGINS` 自动安装+启用、`PLUGIN_PACKAGE_PREFIX` 白名单、`resourcer.define` 的 `resource:action` URL 形式、`acl.allow()` ≡ `skip(...,'public')`
- **影响面**：决定插件 API 写法与 client 目录（`client-v2`）。
- **可逆性**：低（换大版本需改插件代码）。
- **状态**：已确认。若后续需降到 v2.1.x，插件代码无需改动（上述 API 两版一致），仅需改 compose 镜像 tag。

### A-03 不新增独立 Node.js Service —— `ACTIVE`
- **默认值**：所有后端扩展（含匿名接口、Token、文件上传、短信回执）都在 NocoBase 插件 `@local/service-ticket` 内实现。
- **理由**：NocoBase 插件已支持自定义 API（`resourceManager.define`），匿名接口所需能力（`ctx.db`、File Collection、短信 HTTP、事务）全在同一进程内。独立服务会引入跨进程鉴权、数据库双写与事务边界、双份部署/日志/备份，收益为零。
- **影响面**：无（这是实现形态的简化）。
- **可逆性**：可逆（未来若需独立扩容，可把 `services/` 抽成包）。
- **需确认时点**：不需要。

### A-04 定位：不做 ERP/CRM/FSM —— `CONFIRMED`
- 由文档 §1.2、§21.6 与用户指令第 4 条共同确定。不接入门店 ERP，不同步销售单/商品/SN/售价/库存/财务。

---

## B. 业务参数（全部配置化，取默认值即可开工）

| 键 | 默认值 | 说明 | 需确认时点 |
|---|---|---|---|
| `feedback.low_score_threshold` | `2` | ≤2 星触发重开；3 星进入总部关注但可关闭 | 上线前 |
| `feedback.wait_days` | `7` | 评价等待天数 | 上线前 |
| `feedback.token_expire_days` | `15` | 评价 Token 有效天数 | 上线前 |
| `technician.token_expire_hours` | `72` | 师傅 Token 有效期（预计上门后 48–72h） | 上线前 |
| `sla.accept_minutes` | `120` | 待受理 SLA | 上线前（可设"未启用"） |
| `sla.appointment_overdue_grace_minutes` | `120` | 预约过期容忍 | 上线前 |
| `sla.store_confirm_hours` | `48` | 待门店确认超时 | 上线前 |
| `visit.photo_max_count` | `6` | 单次上门照片上限 | 上线前 |
| `visit.photo_max_size_mb` | `5` | 单张大小上限 | 上线前 |
| `security.ip_minute_limit` | `30` | 公开接口 IP 频控 | 上线前 |
| `security.ticket_phone_daily_limit` | `5` | 同手机号每日提交上限 | 上线前 |
| `security.duplicate_window_minutes` | `10` | 重复单识别窗口 | 上线前 |
| `sms.retry_count` | `1` | 失败自动重试次数 | 上线前 |
| `privacy.retention_months` | `24` | 个人信息保留月数 | **必须由法务/运营确认** |
| 投诉是否允许 `remote` | 允许 | 若全部投诉必须上门则关闭该模式 | 上线前 |
| 是否收集服务地址 | 不收集 | 若电话确认地址成本高再新增为可选项 | 上线后评估 |
| 手机号验证码 | 不启用 | 出现严重刷单再启用 | 上线后评估 |
| 总部是否可见完整手机号 | 可见；`viewer` 默认脱敏 | 按内部权限策略 | 上线前 |

---

## C. 技术实现细节默认值

| # | 事项 | 默认值 | 理由 |
|---|---|---|---|
| C-01 | Token 哈希算法 | `SHA-256`（hex 小写） | 文档 §21 明确要求 |
| C-02 | Token 生成 | `crypto.randomBytes(32).toString('base64url')` | 高熵、URL 安全、43 字符可放进短信变量长度 |
| C-03 | 工单号格式 | `FW` + `YYYYMMDD` + `-` + 4 位序号 | 文档 §4 示例 `FW20260920-0001` |
| C-04 | 工单号取号 | `dailySequences` 表 + `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` | 原子、无竞态、可跨重启 |
| C-05 | 时区 | 服务器 `TZ=Asia/Shanghai`，DB 存 `timestamptz` | 与门店业务一致 |
| C-06 | 状态变更入口 | 仅 `TicketService` | 文档 §23 要求 |
| C-07 | 并发控制 | 条件更新（乐观锁）+ 影响行数判定 | 文档 §9.1 要求 |
| C-08 | 照片存储 | NocoBase File Collection 记录元数据 + **插件私有目录**落盘 + 受控读取端点 | 文档 §21.7 要求不永久公开 |
| C-09 | 照片读取 | `GET /api/svc/photos/:id`（登录+范围校验）或 10 分钟 HMAC 签名 URL | 兼顾后台预览与安全 |
| C-10 | EXIF | 一律剥离（`sharp` 重编码） | 文档 §21.7 允许 |
| C-11 | 图片压缩 | 前端先压缩（长边 1600 / 质量 0.8），服务端再次规范化 | 省流量、统一格式 |
| C-12 | MIME 判定 | magic bytes 嗅探，拒绝 SVG | 文档 §21.7 要求不信任扩展名 |
| C-13 | 短信默认实现 | `MockSmsProvider`（开发/测试）；生产切换 `AliyunSmsProvider` | 无资质也能开发 |
| C-14 | 评价链接形式 | `https://<domain>/review/<token>`（token 为变量） | 文档 §10.2 的阿里云可行形式 |
| C-15 | 若模板不允许变量带链接 | 降级：短信带工单号 + `https://<domain>/r` 短链落地页输入工单号后跳到评价页 | 备选路径，A-04 相关 |
| C-16 | 事件写入 | 与状态变更同一事务（`EventService.append`） | 保证时间线不丢事件 |
| C-17 | 定时任务 | 插件内置调度（`node-cron` 语义），cron 与阈值来自 `systemSettings` | 可配置、可测试 |
| C-18 | 汇总口径 | 首次响应 = `first_response_at - created_at`；闭环 = `closed_at - created_at` | 文档 §15 口径 |
| C-19 | 不做到达/准时率 KPI | 师傅不登录，无法验证 | 文档 §15 明确要求 |
| C-20 | 导出脱敏 | 手机号按角色；`= + - @` 开头单元格前置 `'` | 安全基线 |
| C-21 | 日志 | 结构化 + traceId；不写姓名/手机号明文 | 安全基线 |
| C-22 | 健康检查 | `GET /api/svc:health`（原生形式；nginx 同时兼容 `/api/svc/health`）；返回 `db`/`sms`/`tasks` 三字段 | 便于 Docker healthcheck；见 DEV-10 |

---

## D. 部署默认值

> Phase 1 已落地，实际取值如下（与原计划的差异标记 ✏️）。

| # | 事项 | 默认值 |
|---|---|---|
| D-01 | Compose 服务 | `postgres` + **`app`**（NocoBase）+ `nginx`（**无独立 service-api**）✏️ 服务名用 `app` 而非 `nocobase`，因镜像选 `-no-nginx` 变体后容器角色就是「应用」 |
| D-02 | 对外端口 | 当前 **HTTP 8080**（`NGINX_HTTP_PORT`）；HTTPS 443 待 Phase 10 证书就绪后启用 `nginx/conf.d/ssl.conf` ✏️ 原计划"仅 443"，但本机/POC 阶段无证书，先跑 HTTP 以保证「一条命令可拉起」。**本机 80 被 CRMEB 项目的 `crmeb-nginx` 占用且该容器 `restart: always`（Docker 重启会自动抢回），故本项目固定用 8080 与 CRMEB 完全隔离** |
| D-03 | 插件注入方式 | **不写 Dockerfile**：官方镜像 + 双通道 bind mount（`storage/plugins` 发现 + `node_modules/@local` 解析），宿主机 esbuild 预编译 ✏️ 见 DEV-12 |
| D-04 | H5 交付 | `h5` 构建为静态资源，由 Nginx 托管于 **`/h5/`**（SPA 回退 `index.html`）；Phase 1 为占位页 ✏️ 挂载到子路径而非根路径，为后台 SPA 让出 `location /` |
| D-05 | DB 名称/用户 | 库 `service_ticket`，用户 **`svc_app`**（非超级用户）✏️ 原写 `svc`，为避免与 compose service 名混淆改名 |
| D-06 | 备份 | 每日 `pg_dump -Fc` + 上传目录归档，保留 30 天（`BACKUP_RETENTION_DAYS`），`backups/` 不入库 |
| D-07 | 日志 | 容器 `json-file` 轮转：app `50m×5`、postgres/nginx `20m×5` |
| D-08 | 应用口暴露 | `APP_DEBUG_PORT` 仅绑定 `127.0.0.1`（不对局域网），公网入口只有 nginx |

---

## E. 上线前置依赖（非默认值，必须由业务方提供）

| # | 依赖 | 说明 | 阻塞 |
|---|---|---|---|
| E-01 | 企业资质 + 短信签名/模板报备 | 运营商报备有周期，文档 §10.3 要求不得放到上线当天 | 上线 |
| E-02 | 已备案域名 + HTTPS 证书 | 微信内置浏览器要求 HTTPS | 上线 |
| E-03 | 15 家门店正式名称与 `code` 编码方案 | 用于 `stores` 初始化数据。**Phase 2 已落 15 家占位门店（`S01…S15`，电话为 `null`）**；`code` 会印在门店二维码上且一经发出不可变更，因此正式清单到位后**只能按 code 只增不改地替换**（见 DEV-21） | 上线 |
| E-04 | 门店售后人员名单 + 授权门店映射 | 用于 `storeUsers` 初始化。**Phase 2 未落**，AT-03 目前由冒烟脚本临时造账号验证 | 上线 |
| E-05 | 阿里云短信 AK/SK、模板 CODE | 仅写入 `.env` | 联调 |
| E-06 | 数据保留期法务口径 | 默认 24 个月 | 上线 |

---

## F. 需要实测验证的技术点（Phase 1 已部分关闭）

| # | 技术点 | 结论 | 依据 |
|---|---|---|---|
| T-01 | `defineCollection` 声明复合索引 | ✅ **部分成立 → 需兜底** | collection 的 `indexes` 选项**语法上可用**，但真机实测发现 NocoBase 的 `collection.refreshIndexes()` 会**静默丢弃**「列尚未注册到 model」的索引（不报错不告警）。实测每次启动稳定丢弃 1 条：`service_visit_photos(file_id)` 的 **UNIQUE 索引**。已按本文档预留的降级路径落地 `ensure-indexes.ts`（`queryInterface.addIndex()` 语义等价补齐，`afterLoad` 后核对）。详见 `docs/DEVIATIONS.md` **DEV-16** 与 `docs/VERIFY-PHASE-1.md` §4 |
| T-02 | 插件内服务端写入 File Collection | ⏳ Phase 5 | 尚无上传代码 |
| T-03 | 本地存储引擎 `baseUrl` 指向非静态受控路径 | ⏳ Phase 5 | 已按 DEV-05 设计为「仅存元数据 + 受控端点读取」 |
| T-04 | ACL 数据范围过滤"用户多对多门店" | ✅ **已实测（结论：原生 ACL 无法表达，降级方案落地）** | 原生 ACL 的粒度是「资源 × action（+ 字段列表）」，**没有数据级维度**，无法表达"只能看自己门店的行"。已按预案落地两层：① `middleware/store-scope.ts`（框架层，给 list/update/destroy 注入范围条件，用 `$and` 叠加而不覆盖调用方 filter）；② `PermissionService`（对象级，get/update 逐条判归属）。两层缺省都是 fail-closed。真机验收见 `docs/PHASE-2.md` §3（AT-03） |
| T-10 | action 行上的 `fields` 字段白名单：不写会怎样 | ✅ **已实测（结论：必须显式写，且不能用 `null`）** | 三态语义：`null` = **整行下发**（实测 `serviceTickets:list` 返回 36 个键，含 `feedback_token_hash` / `_expires_at` / `_used_at` —— **凭证泄露**）；`[]` = 只剩 `id/createdAt/updatedAt` 的空壳（业务列全丢）；数组 = 白名单。`mergeActionParams` 只在 `'intersect'` 模式下取交集，`null` 不触发该特例。详见 **DEV-23** |
| T-11 | 字段白名单的元素该取哪个入口 | ✅ **已实测（结论：`collection.model.rawAttributes`，不是 `getFields()`）** | `@nocobase/database` 的 `collection.getFields()` 实现是 `return [...this.fields.values()]` —— **返回数组**，元素是字段实例。`Object.keys(getFields())` 会得到 `["0","1",…,"32"]` 数字索引垃圾白名单（且数量恰好也是 33，与正确答案"看起来一致"，极难发现）。权威来源是 `model.rawAttributes` 的键：ORM 属性名，含 `id` / `store_id` 外键列 / `createdAt` 驼峰时间戳，**不含**关联名 |
| T-12 | NocoBase 是否会记录"预期内的拒绝" | ✅ **已实测（结论：会，且默认记为 error 级）** | `@nocobase/plugin-error-handler` 兜住异常后一定写一条日志，级别由 `err.logLevel` 决定：`['trace','debug','info','warn','error'].includes(err?.logLevel) ? err.logLevel : 'error'`。因此不设 `logLevel` 时，"越权 → 404"这条安全设计会把应用日志打成 error，使「app 日志无 error 级输出」这条运维断言失真。已按框架机制声明 `NotFoundError.logLevel='debug'` / `ForbiddenError.logLevel='warn'`（**DEV-20**） |
| T-05 | 插件内注册自定义 `allowAnonymous` action | ✅ **成立** | `resourcer.define({name:'svc',type:'single',actions:{health}})` + `acl.allow('svc','health')` 已实测：匿名访问 `/api/svc:health` 返回 200，无需登录；且 `acl.allow` 语义确实等价于 `skip(...,'public')`（`ctx.permission.skip=true`）。**真机复验**：经 nginx 8080 匿名访问同样 200 |
| T-06 | 插件以包名被 NocoBase 解析并自动启用 | ✅ **成立** | `APPEND_PRESET_BUILT_IN_PLUGINS` + `PLUGIN_PACKAGE_PREFIX` 含 `@local/` + `node_modules/@local/service-ticket` 挂载，三者齐备即可；`main` 必须指向已编译 JS，且必须 `export default`。**真机复验**：11 张表自动建出、16 项种子自动落库 |
| T-07 | 官方镜像首次启动自动 `nocobase install` | ✅ **成立（真机确认）** | 首次 `docker compose up -d` 后无需人工干预，约 60–90s 应用转为 `healthy`，11 张表与参数种子自动就位。fallback 命令仍保留在 README「数据库初始化」 |
| T-08 | `underscored` 默认值对表名/列名的影响 | ✅ **已实测（结论：必须显式开启）** | NocoBase 默认 `underscored: false`，会把表名与自动时间戳列建成驼峰；与本项目按 snake_case 书写的文档、验收 SQL、`EXPECTED_TABLE_NAMES` 全面冲突。已强制全部 collection 经 `defineAppCollection()` 开启 `underscored: true`（DEV-14） |
| T-09 | 配置集合命名是否可复用核心的 `systemSettings` | ✅ **已实测（结论：不可复用）** | NocoBase 核心已占用该集合名，复用会被 `hasCollection()` 判「已存在」而**静默跳过注册**，参数种子写入报 `column systemSettings.key does not exist`。已改名 `serviceSettings`（DEV-15） |


> T-02 / T-03 在 Phase 5 实测；**均已设计降级路径**，任一不成立都不会导致架构重做。
> T-01 / T-05 / T-06 / T-07 / T-08 / T-09 已在 Phase 1 真机验收中确认（详见 `docs/VERIFY-PHASE-1.md`）。
> T-04 / T-10 / T-11 / T-12 已在 Phase 2 真机验收中确认（详见 `docs/PHASE-2.md` §4）。
>
> ⚠️ **T-10 ~ T-12 的共同特征**：三者都属"文档没写、不问就不知道、出错也不报错"的框架行为。
> 这类结论只能靠**读框架源码 + 真机取证**得到，不能靠推断 —— 也正因如此，每一条都配了断言守卫
> （`verify-plugin-load.mjs` 的字段白名单名字来源 / 取不到字段目录必须抛错 / `logLevel` 必须合法），
> 否则下次重构会静默改回去。
