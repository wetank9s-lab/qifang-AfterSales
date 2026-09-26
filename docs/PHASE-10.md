# Phase 10 契约：生产发布资格（Release Qualification）

> **状态**：口径 **🔒 已冻结（2026-09-26）** · 实现 **⬜ 未开始**
> **基线**：Phase 9 🟢 PASS（契约 `b746ebe` → 实现 `1f2c598` → 交付 `6b7b35e`）；
> 开工前取证 **`docs/PHASE-10-PREWORK.md`**（714 行，本会话产出，未 push）
> **本文性质**：契约。冻结生产形态与验证判据；**不含实现**。任何与本文不符的实现须先说明为何漂移。
> **与 P7~P9 的关系**：**不推翻任何已冻结语义**。P10 处理的全部是「功能已正确，但交付形态还不能称为生产发布」的差距。

---

## §0 一句话目标与裁决总表

> **Phase 10 不是继续增加业务功能，而是证明当前系统能够以明确、可回滚、可恢复、
> 不会把测试能力和敏感数据带进生产的形态发布。**

| # | 裁决 | 冻结结论 |
|---|---|---|
| **D1** | 发布目标 | **按「公网可达的单机生产部署」验收**。不得以「内网自用」降低标准 |
| **D2** | 拓扑边界 | 保持 **单实例 NocoBase + PostgreSQL + Nginx**；**DEV-37 继续成立**；不做 HA、不做横向扩容、不做 K8s |
| **D3** | 恢复演练 | **批准**独立 Compose project + 独立 volume 做真实 restore rehearsal，**定为 release-blocking** |
| **D4** | 请求日志 | **默认完全不记录 body**（不做「全 body 结构化脱敏」）；token-bearing access log **归一化**（保留可审计性，日志中不出现 token） |
| **D5** | 发布物 | **正式 immutable production image**；**不再接受**「bind mount + 书面理由」作为最终生产形态 |
| **D6** | health | **分级**：匿名只回最小存活信息；详细信息必须鉴权；`access_log off` 不得到完全不可审计 |
| **D7** | 生产启动 | **fail closed**（比「production profile」更硬）：见 §4.2 拒绝启动清单 |
| **D8** | 依赖版本 | 🔴 **当前版本继续冻结**。**本阶段不做任何** NocoBase / PostgreSQL / Node / 业务依赖升级（详见 §1.2） |
| **D9** | 证书运营 | P10 **不负责**证书运营平台。TLS 终止由 Nginx 完成，证书由部署环境提供；验收重点是「配置能够 HTTPS-only」，不是自建 ACME |

**分段（组织结构，不是三个待批准的 slice）**：

| 段 | 内容 |
|---|---|
| **P10-A 数据副本收敛** | RB-1 日志/Token 泄漏 + RB-5 backup/restore |
| **P10-B 生产攻击面收敛** | RB-2 production hardening + RB-4 production profile/test capability + RB-7 health 分级 |
| **P10-C 可发布物与发布流程** | RB-3 immutable image/reproducibility + RB-6 release-blocking gate manifest |

> A/B/C 按顺序连续开发，**不做逐段审批**。走到 Phase 10 可验收为止，**不需要再做一轮 prework**。

---

## §1 范围

### 1.1 做

1. **RB-1** 请求日志不记 body；token-bearing API 的 access log 归一化；日志 rotation/retention；历史敏感日志处置。
2. **RB-2** HTTPS-only 入口 + HTTP→HTTPS；app/nginx 尽量非 root；PG 不暴露公网；`./storage` 收窄为明确持久化目录；production profile 分离；DEV-37 写入契约与启动自检。
3. **RB-3** 多阶段构建 → immutable production image；构建工具链入库并锁版本；镜像 digest + 产物 hash 自证；**mtime 新鲜度判据退休**。
4. **RB-4** 生产启动 fail-closed；测试/诊断能力在 production **不注册**；9 个现存账号**先分类后定策略**。
5. **RB-5** 可执行 backup + restore 路径；**独立 project / 独立 volume 的真实恢复演练**；半恢复必须显式失败。
6. **RB-6** release-blocking gate manifest，**一条命令给 PASS/FAIL**；修正 README 总表与过期计数。
7. **RB-7** health 分级（匿名最小 / 详情鉴权）+ health 可审计。
8. **补齐未纳管组件**：`nginx:1.27-alpine` 纳入版本冻结；限流值（`30r/m` / `burst=10`）加静态断言；`verify-config` 的 mtime 判据改内容哈希（§6）。

### 1.2 不做（硬边界）

| 不做 | 理由 |
|---|---|
| 🔴 **任何依赖/框架版本升级**（NocoBase / PostgreSQL / Node / npm 包） | 版本升级是**另一种风险**，不得与生产形态改造混在同一次 release qualification |
| HA / 横向扩容 / K8s / 多实例 | D2；DEV-37 的前提仍然成立 |
| 自建 ACME 证书签发平台 | D9 |
| **改写/清洗历史日志内容** | 见 §3.3：历史日志**隔离与删除**即可，不重写 |
| 用 migration「按名字像测试账号」批量删用户 | 见 §4.3：**先分类**，各自定策略 |
| 修 §9 的非阻塞冲突（除被 RB 直接要求的） | 登记为 B-15~，不顺手扩大范围 |
| 为 `BACKUP_PASSPHRASE` 自定义一套脆弱加密格式 | 见 §3.5：要么可靠机制，要么废弃该配置 |
| 开 CSP / 其他与发布形态无关的安全头 | 保留既有 Phase 10 待办，不并入本次验收（避免验收面漂移） |

---

## §2 RB-1：请求日志与 Token 泄漏（P10-A）

### 2.1 实测根因（**本会话回代码核实**，非推测）

**框架请求日志实现**：`@nocobase/logger/lib/request-logger.js`（容器内
`/app/nocobase/node_modules/@nocobase/logger/lib/request-logger.js`）。
装配点：`@nocobase/server/lib/helper.js:125`
→ `app.use(requestLogger(app.name, app.requestLogger, options.logger?.request), { tag: 'logger' })`。

它**每个请求写两行**，且两条线的行为不同：

| 行 | 位置 | 记录内容 | 是否可配置 |
|---|---|---|---|
| **request** 行 | `:66-74` | `message: request <METHOD> ${ctx.url}` + `req: pick(ctx.request.toJSON(), requestWhitelist)` + `action: ctx.action.toJSON()` | ⚠️ `req` 走 `requestWhitelist`（**含 `"action"`**）⇒ 请求行泄漏**可配置**（`logger.request.requestWhitelist`） |
| **response** 行 | `:84-97` | `message: response ${ctx.url}` + `action: **omit**(ctx.action.toJSON(), defaultActionBlackList)` | 🔴 **不可配置** —— `defaultActionBlackList`（`:47-52`）是**模块级硬编码常量**，只去掉 `password` / `confirmPassword` / `oldPassword` / `newPassword` 四个字段 |

**响应行按状态码三分支（`:98-104`）**：

```
status 5xx → requestLogger.error({ ...info, res: ctx.body?.errors || ctx.body })
status 4xx → requestLogger.warn ({ ...info, res: ctx.body?.errors || ctx.body })
status 2xx → requestLogger.info (info)          // res = pick(ctx.response.toJSON(), ['status'])
```

⇒ **4xx/5xx 时 `res` = 整个响应体**（本次取证实测到 health 的完整 payload 就是这样落盘的）。

**🔴 由此得到一条不可绕过的结论**：

> **配置层只能收敛「请求行」；「响应行」与「错误行的响应体」无法通过 `options` 关闭。**
> 因此 RB-1 **不能**用「加个环境变量/开关」实现，**必须在插件层接管请求日志**。
> 取证时若只改 `requestWhitelist` 就宣称"修好了"，是**假绿**。

**泄漏量实测**（对 `storage/logs/main/request_*.log` 7 个文件逐行解析字段值）：

| 指标 | 值 |
|---|---|
| 明文 11 位号码出现次数 | **5,019** |
| 去重后不同号码 | **1,402** |
| 字段分布 | `customer_mobile` 3,157 · `technician_mobile` 1,862 |
| 掩码形态（`138****8888`） | **0** |

### 2.2 冻结的日志字段白名单（🔒）

production 请求日志**只允许**出现下列信息：

| 允许 | 说明 |
|---|---|
| `request_id` | 保留可追踪性（现为 `ctx.reqId`） |
| `method` | HTTP 方法 |
| `route` / `action` | **归一化**的资源名 + action 名（如 `svc:dispatch`），**不含资源 ID / token / 文件 ref** |
| `status` | 响应码 |
| `duration` / `cost` | 耗时 |
| `actor / role` | 安全标识（`userId` / `username` / 角色），**允许** |
| 必要错误码 | 业务错误码（枚举值），**不含 error message 的自由文本**（可能含字段值） |

**禁止**：request body 任何字段、response body 任何字段、`ctx.url` 原文（含 query）、token 原文、
手机号、姓名、故障描述、评价内容、收费信息。

> **设计原则（用户裁决原话）**：这个系统的 body 天然包含姓名、手机号、故障描述、评价内容、收费信息，
> 以及以后可能新增的字段。维护「目前已知敏感字段」的 denylist 很容易随 API 演进重新泄漏 ——
> **因此选择安全边界更简单的方案：不记 body**。

### 2.3 实现边界的硬约束（🔒）

1. **不得依赖框架 `options` 开关作为唯一手段**（§2.1 已证不可行；`requestWhitelist` 只能作为补充）。
2. **接管点必须是插件层**，且**不得修改 `node_modules`**（与 D5 immutable image 冲突）。
   已核实的可行机制：`app.requestLogger` 是被**对象引用**传入中间件的
   （`helper.js:125` 传对象，`request-logger.js` 在调用时做属性查找 `requestLogger2.info(...)`）
   ⇒ 插件在其方法上装脱敏包装**可以生效**，且不需要打补丁。
   *（具体机制由实现选择；契约只要求「不依赖框架 options、不改 node_modules」两条。）*
3. **`ctx.url` 必须处理**：两条行的 `message` 都含 `${ctx.url}`（**含 query string**）。
   仅靠 nginx 把 token 从 path 挪到 query **无效**（见 §2.4）。
4. **只记白名单，不记黑名单**：实现上必须是**正向白名单**（§2.2 的字段集合），
   而不是「先记全量再删掉敏感字段」。

### 2.4 Token-bearing API 的 access log 归一化（🔒）

**实测现状**：`access_log off` 只加在 `/t/{token}`（`service.conf:169-189`）与
`/f/{token}`（`:206-216`）两条 **302 重定向**上；而**真正携带 token 的 API 路径没有**：

| 路径 | 现状 | 实测 |
|---|---|---|
| `GET /api/public/reviews/{token}` | `location ^~ /api/public/`（`:481`）**无** `access_log off` | 明文落盘 |
| `POST /api/technician/visits/{token}/...` | `location ^~ /api/technician/`（`:558`）**无** `access_log off` | technician token 形态命中 **257** 次 |

**为什么「把 token 挪到 query」不解决问题**：`log_format main`（`nginx.conf:28-31`）记录 **`$request`**
= **rewrite 之前**的原始请求行 ⇒ 挪到 query 后 token 仍以 path 形态落盘。

**🔴 另有一条更隐蔽的坑（本会话核实）**：不能简单改用 `$uri` 代替 `$request`。
`/api/public/reviews/{token}` 的 rewrite（`service.conf:516,519`）把 token **留在 path**
（`/api/publicReview:get/$1`，token 充当 NocoBase 的资源 ID）⇒ **rewrite 之后 `$uri` 里仍有 token**。
而 `/api/technician/` 的 rewrite（`:569-571`）把 token 放到 **query** ⇒ 其 `$uri` 才是干净的。
**两条路径形态不同，不能用同一条"安全格式"想当然覆盖。**

**冻结要求**：

1. 这两类窄 location **不得输出原始请求行**（`$request` / `$request_uri`）。
2. **保留可审计性**（用户明确倾向）：采用专用 `log_format`，其中出现的是
   **location 内用 `set` 显式声明的归一化 route 类别**（如 `svc_route=public_review` /
   `technician_visit`）+ method + status + 耗时 + 真实 IP，**不出现 token**。
   *不得*依赖从 URI 派生 route（理由见上）。
3. `access_log off` 允许作为备选，但**必须同时**由应用侧留下不含 token 的必要安全事件
   （否则等于把审计一起关掉）。
4. **反向断言**：把 `$request` 加回这两类 location 的日志 ⇒ 门禁必须变红。

### 2.5 历史日志与 retention（🔒）

| 项 | 要求 |
|---|---|
| 新日志 | 应用日志**必须有 rotation + retention 上限**（当前 67 MB / 75 文件 / **无上限**；compose 的 `max-size` 只管容器 stdout，**管不到** `/app/nocobase/storage/logs`） |
| 历史日志 | **不要求清洗重写**；要求**隔离 + 删除**：给出明确处置动作并执行（含 `storage/logs` 内既存明文号码文件） |
| 导出临时文件 | `storage/tmp/` 的导出残留必须有**生命周期**（当前 2 个空壳 ✅ 无数据，但**无任何清理动作**，且生产用的是同一个 host 目录） |
| 旧备份 | `backups/*.sql` 两份**明文全库 dump**（其一含 **265** 处明文号码）⇒ 随 §3 一起隔离/加密/删除 |

---

## §3 RB-5：备份 / 恢复 / 回滚（P10-A · **release-blocking**）

### 3.1 冻结：恢复演练必须真实执行（🔒）

**判据升级（用户裁决）**：**「存在 backup 脚本」≠ PASS**。必须**实际完成**一次：

```
现有测试数据
  → backup
  → 新独立 compose project / 新独立 PostgreSQL volume
  → restore
  → 启动应用
  → 核验核心数据
  → 核验关键约束 / 索引
  → 至少跑一组关键业务 read/probe
```

**硬约束**：

| # | 约束 |
|---|---|
| 1 | 🔴 **不得 restore 回当前数据库**来证明恢复能力 |
| 2 | 演练环境必须使用**不同 project name** + **不同 DB volume** |
| 3 | 如需暴露端口，使用**不同 host port**，避免误连现有实例 |
| 4 | 演练后清理新建 project/volume（并留下记录） |
| 5 | 必须验证**失败时不会产生「看似成功」的半恢复**（负向注入：中断 restore ⇒ 必须显式失败，不得报成功） |
| 6 | 演练输出**可复核**：脚本 + 输出 + 行数/约束比对结果，落盘为证据 |

### 3.2 现状证据（供实现对照）

| 检查 | 实测结果 |
|---|---|
| `scripts/` 下有备份脚本吗 | **没有**（48 个脚本无一是备份/恢复） |
| `BACKUP_PASSPHRASE` 消费者 | **0**（只有 `gen-secret.mjs:78` 生成它） |
| `BACKUP_RETENTION_DAYS` 消费者 | **0**（只出现在 `.env.example:168` 与文档） |
| 恢复演练 | **从未执行**，无任何证据 |
| `README.md:215-223` | 命令**格式错误**：`pg_dump -Fc` **不支持加密**，命令里也无任何加密步骤，却在 `:223` 声称"备份口令取自 `BACKUP_PASSPHRASE`" |
| `SECURITY.md:28 / :174` | 承诺「`pg_dump` 加密 + `backups/` 权限收紧（实测 755）+ 每月恢复演练」⇒ **三项全无** |

### 3.3 回滚语义（🔒）

1. **回滚单位 = 回滚一个 image tag/digest**（与 D5 配套），不是「回滚文件系统」。
2. ⚠️ **回滚不是只读动作**：启动期自愈（ACL 字段白名单对齐、`removeOrphanResourceRows()`、
   角色资源补回、时间戳/interface 修复、参数种子补齐）会在检测到漂移时**写库**。
   状态回滚到旧版本时，自愈会把 ACL/参数**修回该版本期望值** ⇒ **必须写进回滚流程**。
3. 存在**含数据语义的不可逆项**：`DEVIATIONS.md:385` 已登记（Phase 4 生命周期列
   「可通过迁移回滚列；但**已按新模型产生的数据**无法自动合并回旧模型」）⇒ 回滚文档必须引用它。

### 3.4 升级流程

必须有**独立可执行文档**（不是「改 `expected-versions.mjs` 的注释」）：
改版本 → 3 套校验 + 100 路并发 → 复查框架行为假设 → 回滚点确认 → 演练。
（`expected-versions.mjs` 头部已描述「改本文件 = 发起版本变更」，但那是**断言机制**，不是**升级步骤**。）

### 3.5 备份加密：不许留「看起来已经支持」（🔒）

> **用户裁决原话**：不要为了让这个变量显得有用而自己设计一套脆弱加密格式。
> 生产备份是否加密要么采用**明确可靠的工具/存储层机制**，要么**删掉/废弃这个虚假配置**。
> **不存在的安全能力不能继续留成看起来已经支持。**

⇒ 二选一，**不得**新造自研加密格式：
**(a)** 采用明确的可靠机制（如 `age` / `gpg` / 对象存储服务端加密 / 卷级加密），并把口令真正接上；
**(b)** 废弃 `BACKUP_PASSPHRASE` + `BACKUP_RETENTION_DAYS`（从 `.env.example`、`gen-secret.mjs`、
文档中一并移除或明确标注「未实现」），并把 `SECURITY.md` 的空承诺订正为事实。
**无论选哪条，`SECURITY.md:28/:174` 与 `README.md:213-224` 都必须与实际一致。**

---

## §4 RB-2 / RB-4 / RB-7：生产攻击面收敛（P10-B）

### 4.1 RB-2 production hardening（🔒 必须实质解决）

| # | 要求 | 现状（实测） |
|---|---|---|
| 1 | **HTTPS/TLS** | 完全无：`nginx/conf.d/` 无 `ssl.conf`；`grep -rn "listen.*443\|ssl_certificate" nginx/` **零命中**；`service.conf:39-41` 只有 `listen 80 default_server` |
| 2 | **HTTP → HTTPS** 跳转 | 无 |
| 3 | **app / nginx 尽量非 root** | 三容器**全部 uid=0**（`svc-app` / `svc-nginx` / `svc-postgres`）；compose 无 `user:` / `read_only` / `cap_drop` / `security_opt` |
| 4 | **PostgreSQL 不暴露公网端口** | 现状已满足（postgres 无 `ports:`）⇒ **加断言钉住，防止回归** |
| 5 | **不再把整个 `./storage` 无边界地当生产可写目录** | 现状 `./storage:/app/nocobase/storage`（`:96`）整目录可写，**含插件目录 = 可写入将被 require 的代码** |
| 6 | **明确持久化目录及权限** | 数据目录 755；`backups/` 755 |
| 7 | **production profile 与开发/测试 profile 分离** | **不存在 profile 概念**（见 4.2） |
| 8 | **DEV-37 单实例限制写入生产部署契约与启动自检** | 已被 `container_name` 结构性承接 ✅，但**无任何断言/自检把它写下来** |

**TLS 落点（已核实的既有基础，不需重做）**：
- `nginx.conf:101-104` 的 `map $http_x_forwarded_proto $svc_forwarded_proto { default ...; "" $scheme; }`
  与 `proxy-headers.inc:43` 的 `X-Forwarded-Proto $svc_forwarded_proto` **已经 HTTPS-ready** ——
  在 443 server 块里 `$scheme` 即 `https`，**不需要改这两个文件**。
- `service.conf:48-49` 已把「CSP 延后」记为 Phase 10 待办（本次**不并入**验收，见 §1.2）。
- compose `:138-139` 的 443 映射已有注释占位。

**新增/改动面**：新增 `nginx/conf.d/ssl.conf`（443 server 块 + 80→443 跳转）、
compose 暴露 `${NGINX_HTTPS_PORT:-443}:443`、证书由部署环境提供（D9）、
**`nginx:1.27-alpine` 必须一并纳入版本冻结**（§6，当前**完全无人管**）。

**storage 收窄**：`./storage` 全量挂载必须收窄为**明确列出的运行时状态目录**
（至少：DB 外的上传、私有照片、日志、tmp），并且**插件代码目录不得落在可写挂载内**（与 D5 配套）。

### 4.2 RB-4 production fail-closed（🔒 比 profile 更硬）

**引入 `APP_ENV`**：这不是新造的变量 —— `@nocobase/logger/lib/config.js:48,53` 已经在用它
（`LOGGER_LEVEL || (APP_ENV === 'development' ? 'debug' : 'info')`、`LOGGER_FORMAT` 同理），
当前**未设置** ⇒ 取 production 分支的默认值。本阶段把它**显式化**为生产 profile 开关。

**生产启动必须 fail closed（拒绝启动，不是 warning）**：

| # | 拒绝启动的条件 |
|---|---|
| 1 | `SMS_PROVIDER=mock` |
| 2 | 已知测试 / probe / fault-injection capability 在 production 可达 |
| 3 | 默认/测试凭据仍处于允许状态 |
| 4 | 必要 production secrets 缺失（如 `SIGN_SECRET` 空） |
| 5 | 明确的开发配置被 production profile 使用（如 `PUBLIC_BASE_URL` 仍是 `http://localhost`） |
| 6 | DEV-37 单实例前提被破坏（如编排层出现 `replicas > 1` 语义） |

**为什么这条比「per-account 删账号」更根本**：RB-4 的根因**不是某个开关没关，而是没有开关** ——
`[实测]` 容器 env 里 **`APP_ENV` 与 `NODE_ENV` 都没有设置**，全插件源码里
`grep isProduction|APP_ENV` **零命中** ⇒ 系统无法区分「我在开发」与「我在生产」，
因此也无法「在生产上拒绝启动」。

**测试能力：production 下「不注册」优于「注册了但 403」（🔒 用户裁决）**：

> 攻击面不存在比 ACL 正确更强。

需覆盖的测试/诊断专属面（现状**唯一闸 = `SMS_PROVIDER=mock`，而模板出厂默认就是 mock**）：

| 端点 | 鉴权 | 自毁闸 | 现状 |
|---|---|---|---|
| `POST /api/public/reviews/_probe/sweep`（`PUBLIC_ACTION.REVIEW_SWEEP_PROBE`） | **匿名** | 非 mock ⇒ 404 | 可达 |
| `svc:tokenCheck`（`constants.ts:1226`） | 已登录 | 非 mock ⇒ 404 | 可达 |
| `svc:smsOutbox`（`:1239`） | 已登录 + 总部特权 | 非 mock ⇒ 404 | 可达 |
| `svc:faultInject`（`:1396-1407`） | 已登录 + `X-Svc-Diag-Key == SIGN_SECRET` | **无** | 可达 |
| `svc:guardQuota`（匿名 + `X-Svc-Diag-Key`，`guard-quota.ts:27`） | 匿名 | fail-closed（空 `SIGN_SECRET` ⇒ 404） | 可达 |

⚠️ **`review.ts:288-289` 的注释自己写明了设计前提**：
> 「安全性因此完全依赖上面那条自毁闸 **+ 生产环境 `SMS_CHANNEL` 必为真实通道这一事实**」

⇒ 这个「事实」目前**既没有被配置保证、也没有被启动自检保证、更没有门禁**。P10 必须把它变成
**被自检拒绝启动**的事实（条件 1）。

### 4.3 9 个现存账号：先分类，再定策略（🔒）

**禁用机制本身是扎实的**（`scripts/uat-accounts.mjs:471-487` 的 `--disable`：
① 撤门店映射 ② 撤角色 ③ **把口令重置成随机 sha256** ④ 改名/改邮箱 + 打标记）——
**问题不是「机制是假的」，而是「机制没有跑过」**。

**当前 9 个账号全部存活**（`uat_restricted_at` 全为 `NULL`），且**6 个口令变量注入 app 容器**
（一次 `up -d` 后会变 7）：`SMOKE_ADMIN_EMAIL/PASSWORD` · `UAT_STORE_A/B_PASSWORD` ·
`UAT_HQ_PASSWORD` · `UAT_VIEWER_PASSWORD` ⇒ `docker inspect` / `/proc/1/environ` /
容器内任意代码均可读。

**必须分类，各自形成明确的生产初始化/禁用策略**（🔴 不做「按名字像测试账号」的粗暴 migration 删除）：

| 类 | 账号 | 策略要求 |
|---|---|---|
| 默认超管 | `id=1 admin@nocobase.com`（`admin + root + member`） | 默认邮箱必须替换或明确保留理由；口令必须来自部署环境 |
| **probe/test 残留** | `id=2 probe.store.a@`、`id=13 probe.v2@`、`id=14 probe.v@` | 明确：生产前删除或禁用（走 `--disable`，非裸删） |
| **UAT** | `id=193/194/195/476/537 uat.*@svc.local` | 明确：生产禁用（`--disable`），或仅存在于非生产项目 |
| 凭据注入面 | 上述 6~7 个 env 变量 | production compose **不得**注入测试口令 |

**验收口径**：**最终生产数据集中不能留下仍可登录的测试账号**，且该状态**由门禁断言**
（当前**没有任何门禁**断言生产库里不存在测试账号）。

（`deleteAccounts({force})` 在账号被工单 `handler_user_id` / 事件 `operator_user_id` 引用时会拒绝物理删除
⇒ 策略应基于 `--disable` 而不是物理删除。）

### 4.4 RB-7 health 分级（🔒）

**现状**：匿名 `/api/svc:health`（`service.conf:225,237`）一次无鉴权 GET 返回 **1838 字节** JSON，含：

```
sms:"mock" · version · tablesPresent:12 · registeredSvcActions:20 · rolesInAcl:4
slaAcceptanceOverdue:14 · slaAppointmentOverdue:0 · slaStoreConfirmOverdue:3
smsRetryPending · smsTerminalFailed · tasks{review_expiry,sms_retry,sla_scan}.runCount/lastError
uptimeSeconds · ready · checkedAt …
```

⇒ 一次 GET 即可得知 **① 短信通道是 mock（⇒ 4 个测试端点在线）**、**② 业务积压数量**、
③ 内部表数/ACL 结构/任务调度节奏。且 `access_log off` ⇒ **这类访问不留痕**。

**冻结要求**：

| 项 | 要求 |
|---|---|
| 匿名档 | **最多** `{"status":"ok"}` 或 `{"status":"degraded"}` |
| 匿名档禁止暴露 | SMS provider/mock 状态 · SLA overdue 数量 · task 名称/执行结果 · DB/内部组件细节 · backlog/业务量 · 配置状态 |
| 详情档 | **必须鉴权**（HQ/admin/运维路径），保留现有全部字段 |
| 可审计 | **不再 `access_log off` 到完全不可审计**（health 无 secret token ⇒ 使用安全的普通 access logging 即可） |

**⚠️ 影响面（本会话核实，必须在实现时一并处理）**：

1. **`docker-compose.yml:106-114` 的 healthcheck 只需 `statusCode===200`**
   ⇒ 匿名最小档**足够**，healthcheck **不需要**改。
2. **`scripts/smoke-test.mjs` 深度依赖详情字段**（`unwrapHealth` 解析后使用
   `db` / `sms` / `tasksOverall` / `tasks` / `status` / `ready` / `tablesExpected` / `tablesPresent` /
   `missingTables` / `registeredCollections` / `settingsSeeded` / `uiCollections*` / `uiTimestampFields*`）
   ⇒ **必须改走鉴权详情端点**，否则总闸直接红。
3. 🔴 **`smoke-test.mjs:497` `assertEq(health.sms, 'mock', 'sms')` 与 §4.2 条件 1 直接冲突**：
   总闸在断言「短信通道是 mock」，而生产 profile **禁止 mock**。
   ⇒ 该断言必须**按 profile 区分**（开发档断言 mock；生产档断言非 mock），
   **不得**把「sms=mock」继续当成全局正确性条件。这是本次裁决暴露出的**真实矛盾**，必须在契约里处理掉。

---

## §5 RB-3 / RB-6：可发布物与发布流程（P10-C）

### 5.1 RB-3 immutable production image（🔒 不再接受 bind mount + 书面理由）

**用户裁决**：Phase 1 接受 bind-mounted compiled plugin 是为了开发推进；
DEV-26 已明确把重新评估留给 Phase 10 —— **现在正是还债点**。

**目标形态**：

```
locked source/dependencies
        ↓
      builder
        ↓
compiled plugin + H5 assets
        ↓
immutable runtime image
        ↓
image digest + artifact/source hash evidence
```

**冻结要求**：

| # | 要求 |
|---|---|
| 1 | **生产容器不得依赖宿主机上的 compiled plugin / H5 build output 才能启动** |
| 2 | 构建工具链（esbuild / node / npm 依赖）**必须进仓库并锁版本**（根 `package.json` + lock，或容器化构建） |
| 3 | **发布自证基于内容**：`Git commit` + `artifact hash` + `image digest`（**不得**基于文件时间） |
| 4 | **mtime 新鲜度判据退休**（`verify-config.mjs:1205-1223`）⇒ 换成**内容哈希** |
| 5 | 容器内可读出「当前跑的哪一版」（镜像 digest + 插件产物 hash + `APP_KEY` 指纹（**不含明文**）），**不依赖宿主机目录状态** |
| 6 | 回滚单位 = tag/digest（§3.3） |

**现状证据（实现必须消除）**：

| 项 | 实测 |
|---|---|
| 编译产物不在仓库 | `git ls-files storage/plugins` = **0** ⇒ 一份 `git clone` 后 `docker compose up` **直接起不来** |
| 构建工具在仓库外 | `scripts/build-plugin.mjs:73-79` 把 `NODE_WORKSPACE` 解析为 `%USERPROFILE%/.workbuddy/binaries/node/workspace`（**本机 agent 沙箱路径**）；实测该处 esbuild = **0.28.2**，其 `package.json`/lock **不在本项目仓库** ⇒ **换机器重建产物不确定** |
| 新鲜度判据 | `verify-config.mjs:1205-1223` 取 `src/**` 最大 mtime 与产物 mtime 比较 ⇒ **既能被 `touch 产物` 骗过，也会因 `touch 源码` 假红**；源码与产物之间**没有任何内容哈希绑定** |

**⚠️ 关键可行性发现（本会话核实，直接决定 D5 能否落地）**：
插件**发现**依赖 `PLUGIN_STORAGE_PATH`（`.env.example:73` = `/app/nocobase/storage/plugins`），
配合 `APPEND_PRESET_BUILT_IN_PLUGINS=@local/service-ticket`（`:64`）与
`PLUGIN_PACKAGE_PREFIX=@local/`（`:68`）。
⇒ **`PLUGIN_STORAGE_PATH` 本身就是「解绑 bind mount」的旋钮** ——
生产镜像可把编译产物 `COPY` 到**镜像内**路径并把该变量指过去。
⚠️ 但「`storage/plugins` 扫描发现 + `node_modules` 解析 require」是**两个条件**
（compose 头部注释 `:16-18` 明说），实现时必须**同时满足**并**实测插件真的被加载**
（不能只靠 `COPY` 成功就判断成功）。**这是 P10-C 的首要风险点。**

**HTTPS/H5 静态面同样要去 bind mount**：`docker-compose.yml:135`
`./h5/dist:/usr/share/nginx/html/h5:ro` ⇒ 生产必须把 H5 产物**打进 nginx 镜像**（或等价不可变机制）。

### 5.2 RB-6 release-blocking gate manifest（🔒）

**判据**：**一条命令给出 PASS/FAIL**；**不把所有历史 checker 无脑塞进去**，
只选**真正 release-blocking** 的集合。

**建议四层（取证 §2.3，待实现时按此落成单一事实来源）**：

| 层 | 门禁 | 为什么必跑 |
|---|---|---|
| **L1 静态/离线** | `verify-config` · `verify-plugin-load` · `verify-client-logic` | 不需要 Docker，能在**启动前**挡住绝大多数部署层错误 |
| **L2 产物交付** | `verify-bundle-delivery` | 唯一守「代码改对了、浏览器到底拿不拿得到」 |
| **L3 真机总闸** | `smoke-test` | 端到端 + 表/索引/参数种子/后台可用性 |
| **L4 阶段安全边界**（含 `--reverse`） | `verify-native-export-bypass` · `verify-report-kpi` · `verify-store-review-write` · `verify-store-photo-access` · `verify-review-loop` · `verify-review-routing` · `verify-task-reliability` · `verify-ticket-actions` · `verify-technician-token-matrix` · `verify-technician-routing` · `verify-reassign-contract` | 守**安全边界与并发**，回归代价最高 |

**明确剔除（不得进发布必跑集）**：

| 类 | 数量 | 剔除理由 |
|---|---|---|
| **元门禁** | 4 | `verify-delivery-gate-reverse` / `verify-detail-gate-reverse` / `verify-technician-routing-reverse` / `verify-technician-h5-mutation` —— **临时改写生产配置或重建产物**。在发布候选上跑等于「为了变红先把产品改坏」；重建产物还会让 `verify-bundle-delivery` ④ 必然变红（BACKLOG **B-9**）⇒ 归**开发期/CI 独立环境** |
| **一次性历史门禁** | 1 | `verify-concurrency-phase2` —— **要求先放宽限流**，与生产配置冲突 ⇒ 归**版本级回归** |
| **真人走查** | 4 | `walkthrough-*` —— 面向真人验收（需浏览器、指定工单号；`walkthrough-p5-1.mjs` 会清库到基线）⇒ 归**阶段验收** |

**⚠️ 现状缺口（RB-6 的一半）**：

- `README.md:226-246` 自检总表**停在 Phase 6** ⇒ Phase 7/8/9 的 **≥20 条门禁全部缺席**
  （`verify-review-loop` · `verify-task-reliability` · `verify-native-export-bypass` ·
  `verify-report-kpi` · `verify-bundle-delivery` · `verify-technician-*` · `verify-reassign-contract` …）
- `README.md:233` 写 `verify-plugin-load（61 项）`，实际 **62**；`:237` 写 `smoke-test（106 项）`，实际 **119**
- **无 CI**（`.github/` / `.gitlab-ci.yml` / `Jenkinsfile` 均不存在）；根目录**无 `package.json`**
  ⇒ 无 `npm test`、无统一入口；`tests/` 只有两个**空目录**（`git ls-files tests/` = 0）
- 🔴 **L3/L4 全部需要写库**（造工单、造 Visit、翻 token）⇒ **当前不存在任何「只读发布体检」档**，
  也没有一套能对着**生产库或只读副本**跑的门禁

**⇒ 契约要求**：manifest 必须明确「离线档能否对生产只读副本跑」；README 总表与计数**必须与实际一致**
（判据是**脚本输出**，不是历史文档）。

---

## §6 补齐未纳管的冻结项（并入 P10-C）

| # | 项 | 现状 | 要求 |
|---|---|---|---|
| 1 | **nginx 镜像版本** | `nginx:1.27-alpine` **既不在 `expected-versions.mjs`，也无任何断言**（全仓只出现在 compose `:123` 与文档）⇒ **公网入口组件版本漂移无人管** | 纳入 `expected-versions.mjs`，与 NocoBase/PG 同等待遇（`.env`/compose/常量三处逐字一致） |
| 2 | **限流值静态断言** | 对客承诺 `rate=30r/m` 与 `burst=10` **没有任何断言钉住**（`verify-config` 只断言「引用的 zone 已定义」`:465`、「`limit_req_status 429`」`:557`、「文档不许复写 burst 数值」`:1184`） | 加静态断言钉住 3 个 zone 的 rate + burst；**未来「顺手放宽 + 提交」必须被拦住** |
| 3 | **限流注释漂移** | `nginx.conf:67-74` 注释称 burst 是「**环境变量**」，实际是**硬编码字面量**，且 §5.1 已证**没有任何模板机制**（`grep -E '\$\{[A-Z_]+\}' nginx/` 零命中） | 改注释与事实一致（有安全含义的文档漂移） |
| 4 | **mtime 判据** | `verify-config.mjs:1205-1223` | 改内容哈希（见 §5.1 #4） |
| 5 | **`h5/dist` 空目录假绿** | `verify-config.mjs:1097` 的 `REQUIRED_PATHS` 只断言 `['h5/dist','dir']` ⇒ **空 dist 也过，而 `/h5/` 全站 404** | 改为断言**非空**（含关键产物文件） |
| 6 | **版本 tag → digest** | NocoBase/PG 仅到 **tag 级**（非 digest）；`postgres:16` 的 `16` 是**浮动 minor** | 生产发布记录 digest（至少记录，不强求改成 digest 引用） |
| 7 | **游离文件清理** | 仓库根 **20 个游离文件**（`.probe-render-*.mjs`×11、`.probe-reverse-*.log`、`.q1.sql`、`.q-rev-del.sql`、`.baseline*.txt`、`.preflight*.txt`）—— 均已被忽略但**仍在工作区** | 发布前清理脚本（并入 §7 AT-12） |

**⚠️ 契约扩展要求**：新增 `docker-compose.prod.yml` 后，`verify-config` 对镜像的三处一致性断言
必须**覆盖两个 compose 文件**（否则新增文件成为「不受管的配置面」）。

---

## §7 验收判据（AT-1 ~ AT-12）

> **总原则（用户裁决）**：**不以「测试项数量很多」作为主要交付证据**。
> 以**真实 release rehearsal** 为主证据。每条 AT 给出**可证伪**的判据 + **反向断言**（铁律 8）。

| AT | 判据 | 反向断言（必须变红） |
|---|---|---|
| **AT-1 可复现构建自证** | 从 **clean checkout / clean build context** 构建 production image 成功，**不依赖开发机外部构建工具**；记录 commit / artifact hash / image digest | 把构建工具指回仓库外目录（现 `%USERPROFILE%/.workbuddy/...`）⇒ 必须失败 |
| **AT-2 无 bind mount 启动** | production compose **真正从 immutable image 启动**；**无 compiled-plugin bind mount**；且**实测插件真的被发现并加载**（`PLUGIN_STORAGE_PATH` 指向镜像内路径，非仅 `COPY` 成功） | 把 `storage/plugins` 挂载加回 ⇒ 断言变红 |
| **AT-3 HTTPS 入口** | HTTPS 入口**实际探测**通过；HTTP 行为符合契约（跳转）；`X-Forwarded-Proto` 正确（影响短信链接/文件 URL 正确性） | 移除 443 server 块 ⇒ 变红 |
| **AT-4 DB 无公网暴露** | PostgreSQL **没有公网暴露**（实测 + 配置断言钉住） | 加 `ports: 5432:5432` ⇒ 变红 |
| **AT-5 profile fail-closed** | production profile 下 **mock / test / probe / fault-injection 能力 fail-closed**（§4.2 六条逐条注入坏配置 ⇒ 拒绝启动） | 关掉守卫 ⇒ 变红 |
| **AT-6 测试能力不注册** | production 下测试/诊断端点 **404 且 action 未注册**（不是「注册了但 403」） | 让端点重新注册 ⇒ 变红 |
| **AT-7 日志卫生** | 新请求**不再**把 body、手机号、姓名、匿名 Token 写进 request/access logs；**沿用本次取证同款解析器**做内容计量 = 0 命中；**同时**断言正向字段仍在（`request_id`/`method`/`route`/`status`/`duration`），**避免「什么都不记」也过** | 把 body 记录加回 ⇒ 变红 |
| **AT-8 日志 rotation/retention** | 应用日志有 rotation + retention 并有实测；历史敏感日志已隔离/删除（策略 + 执行记录） | 关掉轮转 ⇒ 变红 |
| **AT-9 health 分级** | 匿名 health **只有最小状态**（**精确集合断言** `{status}`，不是「不含某键」）；详细 health **权限隔离**；health 可审计 | 把任一新字段加回匿名响应 ⇒ 变红 |
| **AT-10 真实恢复演练** | **真实 backup → 独立新 volume → restore → 数据/索引/关键读取验证成功**（§3.1 六条硬约束全部满足）；**半恢复必须显式失败** | 中断 restore ⇒ 必须**报告失败**（若报成功即变红） |
| **AT-11 一条命令 PASS/FAIL** | release gate manifest **一条命令给出 PASS/FAIL**，集合 = §5.2 四层（不含剔除项） | 从 manifest 摘掉一个 L4 门禁 ⇒ 必须被发现（集合被断言，不是手写列表） |
| **AT-12 发布上下文扫描** | 最后做一次 **secrets / test-account / temp-export / log-artifact** 扫描，证明发布上下文**不会把这些副本打进 image / repository**；含 §6 #7 的 20 个游离文件清理 | 往 image 里塞一份 `backups/*.sql` ⇒ 变红 |

**代表性 smoke（用户要求，并入 AT-3/AT-5/AT-7 之外的补充）**：
SMS、匿名评价、师傅提交、**D3 native-export guard** 等关键安全能力，
必须在 **production-shaped deployment** 上做代表性强验证，**而不是只在开发 compose 上绿**。

---

## §8 与既有冻结语义的关系（🔒 不得重解释）

| 既有项 | 本阶段处置 |
|---|---|
| **P7 / P8 / P9 功能与安全边界（含 D3）** | **全部保留有效**。取证已复核：`native-export-bypass` 33/33 + rev 10/10、`report-kpi` 31/31 + rev 11/11 仍然全绿 |
| **DEV-26**（bind mount） | **兑现**，不是推翻 —— DEV-26 标题自己就写着「Phase 10 必须重新评估"不可变生产镜像"」，本阶段给出结论（D5） |
| **DEV-37**（单实例） | **继续成立**（D2），但必须**写入契约 + 启动自检 + 静态断言**（现已被 `container_name` 结构性承接但无断言） |
| **DEV-71**（`appointment_overdue_grace_minutes` 日期语义） | 不动。SLA 谓词/fact 单一事实源不变 |
| **DEV-83**（ACL 资源级缺省放行） | 不动。启动自愈的 ACL 写入行为纳入回滚语义（§3.3） |
| **O1-B** | 不动（历史事实与 C19/C20 验收口径全部保留有效） |
| **铁律 8**（反向/变异断言） | 保持。新增门禁必须自带反向断言（§7 逐条） |
| **B-5/B-6/B-7/B-12/B-13/B-14** | **不顺手清理**（已核均不阻断）；登记不变 |
| **「注释/文档不是证据」** | 本契约所有现状断言均标注来源；`SECURITY.md` / `README.md` 的空承诺按 §3.5 / §9 订正 |

---

## §9 非阻塞冲突登记（B-15~B-23，**不要求 P10 全做**）

| 编号 | 事项 | 证据 | 处置 |
|---|---|---|---|
| **B-15** | `SIGN_SECRET` **一密三用**（照片短时 HMAC 签名 / 匿名 `guardQuota` 凭据 / `faultInject` 凭据），三者威胁模型不同 | `[代码]` `guard-quota.ts:27` · `store-review.ts:262,270` | 拆「签名密钥 / 诊断密钥」；**非阻塞** |
| **B-16** | `/api/callbacks/*` 路由已声明（`service.conf:594`）但**实现为空目录**（`src/server/actions/callback/` = 0 文件），实测 404；且是唯一**无 `limit_req`** 的 `/api/` 块 | `[实测]` | 要么删路由要么标 TODO；`SECURITY.md:25` 的「按 provider 验签」承诺须改为「未实现」 |
| **B-17** | **登录无锁定**：`signIn` 401 正常返回；全仓无 lockout；落在兜底 `location /` 的 `svc_general`(300r/m) | `[实测]` | 给 `/api/auth:` 专用限流 + 失败计数锁定，或明确接受 |
| **B-18** | `SECURITY.md:29` 的「结构化日志脱敏中间件」**不存在**（`src/server/middleware/` 只有 `native-export-guard.ts` / `store-scope.ts`） | `[实测]` | 随 **RB-1** 一并订正（RB-1 实现后该承诺才有对应物） |
| **B-19** | `SECURITY.md:28` 称 `backups/`「权限收紧」，实测 **755** | `[实测]` | 随 **RB-5** 一并处理 |
| **B-20** | 启动自愈在检测到漂移时**写库** ⇒ 回滚插件版本是**非只读动作** | `[代码]` | 已写入 §3.3 回滚流程 |
| **B-21** | `storage/nocobase.conf`（NocoBase 自生成 nginx 配置，含 `access_log /var/log/nginx/nocobase.log apm`）在当前「独立 nginx 容器」架构下疑似**无用** | `[实测]` | 确认是否参与运行时；无用则说明，避免被误读为第二条 nginx 层 |
| **B-22** | 容器均为 root，`storage/uploads-private`（私有照片）755 | `[实测]` | 与 **RB-2** #3/#6 重叠，随 RB-2 处理 |
| **B-23** | 备份目录 `backups/` 在宿主、**无挂载**进容器 ⇒ 容器内没有备份能力 | `[实测]` | 随 **RB-5** 决定备份执行位置（宿主 vs 容器） |

---

## §10 交付记录

**⬜ 未开始。** 实现完成后按 Phase 9 同样格式追加：

1. 各段（P10-A/B/C）提交哈希与文件清单
2. AT-1 ~ AT-12 **逐条证据**（判据 → 落在哪条断言 → 实测输出）
3. 门禁计数（**以脚本输出为准**）
4. 恢复演练记录（project name / volume / 行数比对 / 探针结果 / 清理确认）
5. 订正项（`SECURITY.md` / `README.md` / `nginx.conf` 注释）
6. 遗留与后续
7. 复现（最短路径）

---

## §11 复现（最短路径）

```bash
# 0) 基线
git -C . log --oneline -1                 # 期望 6b7b35e（或 P10 实现后的提交）
node scripts/verify-config.mjs            # 当前 55/56（唯一红灯见 §5.1 #4，判据缺陷）

# 1) 取证报告
sed -n '1,60p' docs/PHASE-10-PREWORK.md

# 2) 关键实测（ASCII 锚点）
grep -c '"action"' storage/logs/main/request_*.log            # 请求/响应行均含 action
docker compose up --dry-run --scale app=2                     # DEV-37 结构性承接
docker exec svc-app sh -lc 'grep -n "ctx.url" /app/nocobase/node_modules/@nocobase/logger/lib/request-logger.js'

# 3) 关键配置面
grep -n 'log_format\|limit_req_zone' nginx/nginx.conf
grep -n 'access_log\|limit_req' nginx/conf.d/service.conf
grep -n 'PLUGIN_STORAGE_PATH\|APPEND_PRESET_BUILT_IN_PLUGINS' .env.example
```
