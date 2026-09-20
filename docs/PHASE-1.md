# Phase 1 交付报告 —— 项目初始化与可启动

> 生成时间：2026-09-20
> 依据：`docs/DEV-PLAN.md` §27 输出格式契约 & 《家电门店售后服务平台_开发文档_v1.1》
> 上一阶段：`docs/PHASE-0.md`

---

## 结论

**Phase 1 通过（离线 + 真机端到端验收全部绿），可进入 Phase 2。**

| 验收门槛（DEV-PLAN 原文） | 结果 | 证据 |
|---|---|---|
| `docker compose up -d` 一条命令拉起 | ✅ **真机实测通过** | `postgres` / `app` / `nginx` 三容器 `Up (healthy)`；`docker compose config --quiet` 退出码 0；`verify-config.mjs` 41 项全绿 |
| 后台完成初始化 | ✅ **真机实测通过** | 官方镜像入口脚本自动 `nocobase install`；首次启动约 60–90s 转 `healthy` |
| `curl /api/svc/health` 返回 `{"db":"ok","sms":"mock","tasks":"ok"}` | ✅ **真机实测通过** | `{"data":{"db":"ok","sms":"mock","tasks":"ok",…}}` @ HTTP 200（冒号与斜杠两种写法均 200） |
| 9 张表出现在 PostgreSQL 中 | ✅ **真机实测 11 张**（见 DEV-11） | `smoke-test.mjs` 按表名白名单查询 11/11 |
| **索引全部建立**（原 DEV-PLAN 未列，因 DEV-16 补入） | ✅ **真机实测通过** | 35 条 collection 级索引 + 4 条字段级唯一，逐表逐条断言落库 |

### 三层验收结果

| 脚本 | 层 | 结果 |
|---|---|---|
| `node scripts/verify-config.mjs` | 离线（部署层） | ✅ **41 / 41** |
| `node scripts/verify-plugin-load.mjs` | 离线（插件生命周期） | ✅ **31 / 31** |
| `node scripts/smoke-test.mjs` | **真机（端到端）** | ✅ **55 / 55** |
| 合计 | | ✅ **127 项断言全绿** |

> 🎯 **真机验收已在本机完成**，完整证据、复现命令与根因分析见
> **`docs/VERIFY-PHASE-1.md`**（本文件原先「本机 Docker daemon 不可用」的说明已被该报告取代）。
>
> 真机验收额外发现并修复了一个**离线与桩环境完全无法暴露**的真实缺陷：
> NocoBase 的 `collection.refreshIndexes()` 会**静默丢弃** collection 级索引
> （不报错、不告警，表照样建出来），导致 `service_visit_photos(file_id)` 的**唯一约束失效**。
> 该问题已确定性复现（每次启动必丢 1 条）、抓取到真实 DDL、并通过「摘掉兜底即变红」做了反证。
> 修复见 `ensure-indexes.ts` + `docs/DEVIATIONS.md` **DEV-16**。

---

## 【本阶段目标】

一条命令（`docker compose up -d`）拉起 `postgres + app(NocoBase) + nginx` 三容器，
应用启动时自动加载自研插件 `@local/service-ticket`、自动建成 11 张业务表、
自动写入参数种子，并对外提供匿名健康检查 `GET /api/svc:health`。

**本阶段不做任何业务逻辑**（工单/派工/短信/评价均为 Phase 2+）。
Phase 1 的产物价值在于：把「部署形态、插件加载链路、安全边界、可观测性」这四件
一旦后期返工代价极高的事，在业务代码之前先钉死。

---

## 【本阶段修改的目录/文件】

新增 **40 个文件**，共 **约 270 KB / 约 4,900 行**（不含 `.map`）。

> 真机验收阶段在原 36 个文件基础上新增 4 个：`src/server/ensure-indexes.ts`（索引兜底）、
> `scripts/expected-indexes.mjs`（索引清单）、`scripts/smoke-test.mjs`（真机验收）、
> `docs/VERIFY-PHASE-1.md`（真机验收报告）。

### 部署层（6）

| 文件 | 行数 | 说明 |
|---|---|---|
| `docker-compose.yml` | 139 | 三容器编排、健康检查、依赖顺序、双通道插件挂载 |
| `nginx/nginx.conf` | 94 | 主配置：access_log 格式（含 urt）、限流 zone、gzip、安全头、WS map |
| `nginx/conf.d/service.conf` | 276 | 站点路由：12 个 location、限流分级、错误页、反代清单 |
| `.env.example` | 142 | 全部 63 个环境变量（9 段），含插件加载机制说明 |
| `.gitignore` | 44 | 密钥/构建物/上传/备份隔离 + `h5/dist` 例外 |
| `h5/dist/index.html` | 52 | H5 部署占位页（bind mount 宿主目录必须存在，见下方「坑位记录」） |

### 插件源码（20 项 / 19 个 .ts，约 2,378 行 TS）

| 文件 | 行数 | 说明 |
|---|---|---|
| `nocobase/plugins/service-ticket/package.json` | 27 | 包名 `@local/service-ticket`、`main` 指向 dist、`nocobase.supportedVersions: ["2.x"]` |
| `nocobase/plugins/service-ticket/tsconfig.json` | 24 | ES2020 / CommonJS / strict / outDir dist |
| `src/server/index.ts` | 15 | 具名 + 默认导出（NocoBase 取 `default`） |
| `src/server/plugin.ts` | 241 | 插件主类：注册表 / 注册 action / 开匿名 ACL / 落种子 |
| `src/server/constants.ts` | 398 | 全部枚举、6 状态迁移表 `canTransition()`、`ANONYMOUS_ACTIONS`、`DEFAULT_SETTINGS` |
| `src/server/actions/public/health.ts` | 158 | 健康检查处理器（含表缺失降级、敏感信息过滤） |
| `src/server/collections/index.ts` | 70 | `ALL_COLLECTIONS`（11）+ `EXPECTED_TABLE_NAMES`（11） |
| `src/server/collections/_helpers.ts` | 108 | 字段构造器 `str/enumStr/text/int/bool/money/ts/json/belongsTo` |
| `src/server/collections/_options.ts` | 120 | 从 constants 派生的下拉选项（label/value） |
| `src/server/collections/stores.ts` | 48 | 门店主数据 |
| `src/server/collections/storeUsers.ts` | 34 | 门店↔用户多对多（数据隔离底座） |
| `src/server/collections/serviceSettings.ts` | 72 | 参数配置（key unique；**不叫 `systemSettings`**，见 DEV-15） |
| `src/server/collections/serviceTickets.ts` | 179 | 工单主表（11 个索引含 2 个唯一） |
| `src/server/collections/serviceVisits.ts` | 125 | 上门记录（含 Token 哈希） |
| `src/server/collections/serviceVisitPhotos.ts` | 62 | 现场照片元数据（storage_key 隐私） |
| `src/server/collections/ticketEvents.ts` | 53 | 事件时间线（index(ticket_id, created_at)） |
| `src/server/collections/smsLogs.ts` | 96 | 短信日志（unique(provider, biz_id) 幂等） |
| `src/server/collections/dailySequences.ts` | 41 | 工单号原子取号 |
| `src/server/collections/apiGuards.ts` | 49 | 频控计数（支持 DB 降级方案） |
| `src/server/collections/idempotencyRecords.ts` | 51 | 幂等记录 |
| `src/server/ensure-indexes.ts` | 172 | **索引兜底补齐**（`afterLoad` 后语义等价核对，只增不删）—— DEV-16 修复产物 |

### 构建与自检脚本（6，约 2,855 行）

| 文件 | 行数 | 需要 Docker | 断言数 |
|---|---|---|---|
| `scripts/gen-secret.mjs` | 206 | ❌ | 生成 6 类密钥（拒绝采样，无取模偏置） |
| `scripts/build-plugin.mjs` | 316 | ❌ | esbuild 编译 + 产物自检 |
| `scripts/verify-config.mjs` | 611 | ❌ | 41 项（compose / nginx / .env / 目录） |
| `scripts/verify-plugin-load.mjs` | 682 | ❌ | 31 项（插件生命周期 + 健康检查 + 索引声明守卫） |
| `scripts/expected-indexes.mjs` | 144 | ❌ | 索引验收**单一事实来源**（35 + 4 条，代码/离线/真机三方共用） |
| `scripts/smoke-test.mjs` | 810 | ✅ | **55 项真机端到端验收** |

> 注：`smoke-test.mjs` 是本次真机验收补齐的一环；它需要 Docker，因此与上面四个离线脚本
> 分属不同层。日常改代码只需跑离线四个，改动表结构/索引时必须补跑 `smoke-test.mjs`。

### 构建产物（2）

| 文件 | 大小 | 说明 |
|---|---|---|
| `storage/plugins/@local/service-ticket/dist/server/index.js` | 61.0 KB | esbuild CJS 单文件（19 个源文件编译产物） |
| `storage/plugins/@local/service-ticket/package.json` | 742 B | 由构建脚本同步，保证与源码一致 |

### 文档（3 改 + 3 新）

| 文件 | 变更 |
|---|---|
| `README.md` | 新增「快速开始」+「Phase 1 运维手册」7 小节（启动/DB 初始化/插件加载/日志/配置变更/备份恢复/自检脚本） |
| `docs/DEVIATIONS.md` | 新增 DEV-10（健康检查双路径）、DEV-11（11 张表 vs 验收写 9）、DEV-12（插件以已编译包挂载）、DEV-13（不写 Dockerfile / 脚本用 .mjs）；**真机验收后补 DEV-14（underscored）、DEV-15（集合改名）、DEV-16（索引静默丢弃）、DEV-17（重复唯一索引清理）** |
| `docs/DATA-MODEL.md` | §11 集合名 `systemSettings` → `serviceSettings`（DEV-15）；§13 补 §13.1 T-01 关闭结论与 §13.2 索引验收单一事实来源 |
| `docs/DEV-PLAN.md` | 进度总览 Phase 1 状态置为 ✅（验收口径按 11 张表） |
| `ASSUMPTIONS.md` | A-02 版本锁定 → `CONFIRMED`（实际 `2.2.15-full-no-nginx`）；D 段部署默认值按实际落地更新（含 4 处 ✏️ 标记）；F 段技术验证清单补结论（T-01/T-05/T-06 已关闭，新增 T-06/T-07） |
| `CHANGELOG.md` | 新增 Phase 1 段（Added / Decisions / Verified / Not Verified / Not Started）；**真机验收后补 Phase 1.1 段** |
| `docs/PHASE-1.md` | 本文件 |
| `docs/VERIFY-PHASE-1.md` | **新增** —— 真机启动验收报告（原始证据 / DEV-16 根因与反证 / 复现命令） |

---

## 【完整代码】

> **交付约定**：本项目按 §27 要求「不省略核心代码」，但代码的**交付载体是仓库里的真实文件**，
> 而非文档中的摘录——这比内联摘录更严格（可编译、可 diff、可执行）。
> 因此本节策略为：
> - **全文内联**：决定 Phase 1 验收成败的 3 个文件（compose、站点 nginx、插件主类）+ 健康检查 + 集合清单；
> - **逐表白描**：11 张表的字段/索引/唯一约束以表格给出（权威定义仍在 `docs/DATA-MODEL.md`）；
> - **路径索引**：其余文件已在上节列出「路径 + 行数」，全部可直接打开。

### 1. `docker-compose.yml`（全文）

```yaml
# =============================================================================
#  家电门店售后服务平台 —— 本地/生产 docker compose（Phase 1）
# -----------------------------------------------------------------------------
#  三容器：postgres（数据） + app（NocoBase，含自研插件） + nginx（唯一对外入口）
#
#  首次运行顺序（必须按序）：
#    1) cp .env.example .env                并替换全部 CHANGE_ME
#    2) node scripts/gen-secret.mjs        生成 APP_KEY / SIGN_SECRET / 备份口令
#    3) node scripts/build-plugin.mjs      编译插件到 storage/plugins/@local/service-ticket
#    4) docker compose up -d               首次启动会自动完成 NocoBase 安装
#    5) node scripts/smoke-test.mjs        验收自检
#
#  设计要点：
#   - app 不直接对公网暴露端口，唯一入口是 nginx（符合 docs/SECURITY.md 部署基线）
#   - app 用「-no-nginx」镜像，避免镜像内置 nginx 与外层 nginx 双重代理
#   - ./storage 同时挂到 app 的 storage 与 node_modules/@local，
#     让 NocoBase 既能「发现」插件（storage/plugins 扫描），
#     又能「require」插件（node_modules 包名解析）
# =============================================================================

name: service-ticket

networks:
  nocobase:
    driver: bridge

volumes:
  # 具名卷用于数据库与上传目录的长期持久化；不使用的话可删掉改为纯绑定挂载
  pg_data:
    name: svc_pg_data

services:
  # ---------------------------------------------------------------- postgres ---
  postgres:
    image: postgres:16
    container_name: svc-postgres
    restart: always
    # wal_level=logical：NocoBase 备份/恢复类插件需要；同时便于日后做逻辑复制
    command: postgres -c wal_level=logical -c max_connections=120
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      TZ: ${TZ}
      # 中文排序：保证门店名/客户名排序符合预期
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
    volumes:
      - pg_data:/var/lib/postgresql/data
    networks:
      - nocobase
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"

  # ------------------------------------------------------------ nocobase app ---
  app:
    # 注意：必须是 -no-nginx 变体。默认镜像是「自带 nginx + 监听 80」的，
    # 与本项目「nginx 独立容器」的架构冲突。
    image: nocobase/nocobase:2.2.15-full-no-nginx
    container_name: svc-app
    restart: always
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - nocobase
    # .env 全量注入；下面的 environment 覆盖/补充 .env 中不适合写死的项
    env_file:
      - .env
    environment:
      APP_PORT: 13000
      # 说明：官方镜像的入口脚本在首次启动时会自动执行 nocobase install，
      # 无需额外变量控制；若需手工重新初始化，见 README「数据库初始化」章节。
    volumes:
      # ① storage：数据库外的全部持久化（上传、插件、日志、备份）
      - ./storage:/app/nocobase/storage
      # ② 让 node 能以包名解析到自研插件（require.resolve('@local/service-ticket')）
      #    源与 storage/plugins/@local/service-ticket 是同一个目录
      - ./storage/plugins/@local/service-ticket:/app/nocobase/node_modules/@local/service-ticket
    # 只在宿主机回环暴露，供本地 curl / 调试用；公网入口仍然只有 nginx
    ports:
      - "127.0.0.1:${APP_DEBUG_PORT:-13000}:13000"
    healthcheck:
      # 走容器内 13000 端口直连，不经过 nginx，验证应用进程本身。
      # 路径为 NocoBase 原生 action 形式 /api/<resource>:<action>
      test:
        - CMD-SHELL
        - >-
          node -e "require('http').get({host:'127.0.0.1',port:13000,path:'/api/svc:health',timeout:5000},
          r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"
      interval: 30s
      timeout: 12s
      retries: 6
      start_period: 240s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

  # ------------------------------------------------------------------ nginx ---
  nginx:
    image: nginx:1.27-alpine
    container_name: svc-nginx
    restart: always
    depends_on:
      - app
    networks:
      - nocobase
    volumes:
      # 主配置与站点配置以只读方式挂载（改完配置执行 docker compose exec nginx nginx -s reload）
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      # 客户 H5 静态站点（Phase 3 起产出 h5/dist；Phase 1 该目录为空占位）
      - ./h5/dist:/usr/share/nginx/html/h5:ro
    ports:
      - "${NGINX_HTTP_PORT:-80}:80"
      # HTTPS：证书就绪后放置证书并启用 nginx/conf.d/ssl.conf（Phase 10）
      # - "${NGINX_HTTPS_PORT:-443}:443"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1/healthz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
```

### 2. `nginx/nginx.conf`（全文）

```nginx
# =============================================================================
#  nginx.conf —— 家电门店售后服务平台 外层 Nginx（唯一公网入口）
# -----------------------------------------------------------------------------
#  职责：TLS 终止（Phase 10）、反向代理到 app:13000、H5 静态托管、
#        匿名接口限流、客户端 IP 透传、安全响应头、Gzip。
#  注意：NocoBase 自身的安全校验（登录态、字段级权限）在应用层完成，
#        本文件不承担业务鉴权；/storage/uploads/ 一律反代给应用，禁止
#        用 alias 直接暴露磁盘目录（否则绕过登录校验）。
# =============================================================================

user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;

events {
    worker_connections  2048;
    multi_accept        on;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    # ---------------------------------------------------------------- 日志 ----
    # 记录 upstream 耗时，便于区分「网络慢」与「应用慢」
    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for" '
                      'rt=$request_time urt=$upstream_response_time';

    access_log  /var/log/nginx/access.log  main;

    # ------------------------------------------------------------ 基础调优 ----
    sendfile            on;
    tcp_nopush          on;
    tcp_nodelay         on;
    keepalive_timeout   65;
    server_tokens       off;

    # 上传：单张照片 5MB + multipart 开销；与 .env 的 UPLOAD_MAX_SIZE_MB 对应。
    # 应用层会再做一次严格校验（magic bytes + 尺寸 + 数量），此处只是第一道闸。
    client_max_body_size    8m;
    client_body_timeout     60s;
    client_header_timeout   20s;

    # ---------------------------------------------------------------- Gzip ----
    gzip              on;
    gzip_vary         on;
    gzip_min_length   1024;
    gzip_proxied      any;
    gzip_comp_level   5;
    gzip_types        text/plain text/css text/xml
                      application/json application/javascript
                      application/xml application/xml+rss
                      image/svg+xml font/woff2;

    # ------------------------------------------------------------ 限流规则 ----
    # 说明：这里是「粗粒度兜底」，精确规则（按手机号、按 Token、按门店）在
    # 应用层 GuardService 里实现（见 docs/SECURITY.md）。两层同时生效。
    #
    # svc_public   ：匿名客户接口（提交工单、查门店、评价）——默认 30 次/分钟
    # svc_upload   ：师傅端接口（含照片上传）——默认 60 次/分钟
    # svc_general  ：其余 /api 请求——默认 300 次/分钟
    limit_req_zone   $binary_remote_addr zone=svc_public:10m   rate=30r/m;
    limit_req_zone   $binary_remote_addr zone=svc_upload:10m   rate=60r/m;
    limit_req_zone   $binary_remote_addr zone=svc_general:10m  rate=300r/m;

    # 同一 IP 的并发连接数（防慢速攻击 / 半开连接堆积）
    limit_conn_zone  $binary_remote_addr zone=svc_conn:10m;

    # 触发限流时返回 429 而不是 503，与应用层错误码保持一致
    limit_req_status  429;
    limit_conn_status 429;

    # 被限流时在响应头里暴露策略，便于前端提示与排障
    limit_req_log_level warn;

    # --------------------------------------------------- WebSocket 升级映射 ----
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    # 反代时统一使用客户端请求的 Host（NocoBase 用它拼接回调/文件绝对地址）
    map $http_x_forwarded_proto $svc_forwarded_proto {
        default $http_x_forwarded_proto;
        ''      $scheme;
    }

    include /etc/nginx/conf.d/*.conf;
}
```

### 3. `nginx/conf.d/service.conf`（全文）

```nginx
# =============================================================================
#  service.conf —— 站点配置（家电门店售后服务平台）
# -----------------------------------------------------------------------------
#  路由总览：
#    /healthz                  → nginx 自身存活（不经过应用）
#    /h5/                      → 客户 H5 / 师傅 H5 静态站点（Phase 3+）
#    /api/svc/health           → 插件健康检查（完全匿名，用于容器探针）
#    /api/public/*             → 匿名客户接口（严格限流）
#    /api/technician/*         → 师傅端接口（Token 鉴权，含照片上传）
#    /api/callbacks/*          → 短信供应商回调（验签在应用层）
#    /files/*                  → 受控文件读取（应用鉴权 + 短时签名）
#    /storage/uploads/*        → 一律反代给应用，禁止 alias 暴露磁盘
#    /ws                       → WebSocket
#    /static/plugins/*         → 插件前端静态资源
#    /                         → 后台 SPA（含 history 回退）
#
#  重要：/files/ 与 /storage/uploads/ 必须排在通用 location 之前，
#        且绝不能用 alias 直接指向宿主机上传目录（会绕过登录校验）。
# =============================================================================

upstream svc_app {
    # app 是 compose 网络内的服务名（DNS 由 docker 提供）
    server app:13000 max_fails=3 fail_timeout=15s;

    # 开启到上游的长连接，降低高并发下的 TIME_WAIT
    keepalive 32;
}

# 供 upstream 复用的代理头（避免每处重复书写）
# 注：nginx 不支持宏，故在各 location 内重复声明；此处仅作说明。

server {
    listen       80 default_server;
    listen       [::]:80 default_server;
    server_name  _;

    # 单 IP 并发连接上限
    limit_conn svc_conn 96;

    # ------------------------------------------------------------ 安全响应头 ----
    # 说明：
    #  - 不加 Content-Security-Policy，因为 NocoBase 后台是低代码动态渲染，
    #    Phase 10 在充分回归后再开启（已在 docs/SECURITY.md 记录为待办）。
    #  - X-Frame-Options 用 SAMEORIGIN：H5 页面可能被自己的后台 iframe 引用。
    add_header X-Content-Type-Options   "nosniff"                        always;
    add_header X-Frame-Options          "SAMEORIGIN"                     always;
    add_header Referrer-Policy          "strict-origin-when-cross-origin" always;
    add_header X-Permitted-Cross-Domain-Policies "none"                  always;

    # 隐藏文件与备份文件一律拒绝
    location ~ /\.(?!well-known) {
        deny all;
        access_log off;
    }
    location ~* \.(sql|bak|env|log|ini)$ {
        deny all;
        access_log off;
    }

    # ------------------------------------------------------- nginx 自身存活 ----
    # 容器 healthcheck 用；不产生访问日志噪音
    location = /healthz {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok\n";
    }

    # ------------------------------------------------------------ 客户 H5 ----
    # Phase 3 起 h5/dist 由 Vite 构建产出；Phase 1 为占位空目录。
    # H5 是「带 Token 的一次性页面」，不做长缓存，避免旧版本页面残留。
    location ^~ /h5/ {
        alias /usr/share/nginx/html/h5/;
        index  index.html;
        try_files $uri $uri/ /h5/index.html;

        add_header Cache-Control "no-store, must-revalidate" always;
        add_header X-Robots-Tag  "noindex, nofollow"         always;

        # 静态资源（Vite 产物带 hash）可长缓存
        location ~* ^/h5/assets/ {
            alias /usr/share/nginx/html/h5/assets/;
            expires 30d;
            add_header Cache-Control "public, max-age=2592000, immutable" always;
            access_log off;
        }
    }

    # -------------------------------------------------- 插件健康检查（匿名）----
    # 完全匿名、不参与业务限流，供 docker healthcheck 与上线自检使用。
    #
    # 两种等价写法都支持：
    #   /api/svc:health  —— NocoBase 原生风格 /api/<resource>:<action>
    #   /api/svc/health  —— 验收文档与 README 使用的斜杠风格（此处重写映射）
    # 见 docs/DEVIATIONS.md DEV-10。
    location = /api/svc:health {
        access_log off;
        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;
        proxy_connect_timeout 5s;
        proxy_read_timeout    10s;
        proxy_send_timeout    10s;
    }

    # 斜杠形式：内部重写为冒号形式后再交给同一 upstream，行为完全一致。
    location = /api/svc/health {
        access_log off;
        rewrite ^/api/svc/health$ /api/svc:health break;
        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;
        proxy_connect_timeout 5s;
        proxy_read_timeout    10s;
        proxy_send_timeout    10s;
    }

    # --------------------------------------------------- 匿名客户公开接口 -----
    # 最严格限流：这一组是最容易被刷的接口（提交工单 / 评价 / 门店列表）
    location ^~ /api/public/ {
        limit_req zone=svc_public burst=10 nodelay;

        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        proxy_connect_timeout 10s;
        proxy_read_timeout    60s;
        proxy_send_timeout    60s;
        proxy_request_buffering off;
    }

    # ------------------------------------------------------ 师傅端接口 --------
    # 含照片上传，body 上限已在 http 段设为 8m；放宽读超时以容忍弱网。
    location ^~ /api/technician/ {
        limit_req zone=svc_upload burst=20 nodelay;

        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        proxy_connect_timeout 10s;
        proxy_read_timeout    120s;
        proxy_send_timeout    120s;
        # 上传流式转发，避免大 body 落盘到 nginx
        proxy_request_buffering off;
    }

    # ------------------------------------------------------- 短信回调 --------
    # 不做 limit_req：供应商侧可能集中回调；改由应用层按 provider+biz_id 幂等。
    # 生产环境建议再加 IP 白名单（阿里云/腾讯云回调网段）。
    location ^~ /api/callbacks/ {
        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        proxy_connect_timeout 10s;
        proxy_read_timeout    30s;
        proxy_send_timeout    30s;
    }

    # ------------------------------------------------- 受控文件读取 ----------
    # 必须放在 location / 之前，且必须反代给应用：
    # 应用会校验登录态/门店权限 + 校验短时 HMAC 签名，命中后才回源文件。
    location ^~ /files/ {
        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        # 私有保单/照片：禁止任何中间层缓存
        add_header Cache-Control "private, no-store" always;

        proxy_connect_timeout 10s;
        proxy_read_timeout    60s;
        proxy_send_timeout    60s;
    }

    # -------------------------------------- 旧版上传路径（交给应用鉴权）------
    # 官方配置文档明确警告：不要在原盘目录上直接 alias，否则绕过登录检查。
    location ^~ /storage/uploads/ {
        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        add_header Cache-Control "private, no-store" always;
    }

    # ---------------------------------------------------------- WebSocket ----
    location ^~ /ws {
        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        # 长连接：读超时给足，否则后台会反复重连
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering     off;
    }

    # ------------------------------------------------ 插件前端静态资源 -------
    # NocoBase 通过 /static/plugins/ 提供插件的前端产物；
    # 路径中含版本号，可长缓存（Phase 6 起自研插件会有 admin 前端）。
    location ^~ /static/plugins/ {
        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        expires 7d;
        add_header Cache-Control "public, max-age=604800" always;
        access_log off;
    }

    # ------------------------------------------------------------- 通用入口 ----
    # 兜底：后台 SPA、其余 /api/*。
    # 必须保留 proxy_buffering off —— NocoBase 后台有流式响应/SSE。
    location / {
        limit_req zone=svc_general burst=60 nodelay;

        proxy_pass http://svc_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $svc_forwarded_proto;

        proxy_connect_timeout 30s;
        proxy_read_timeout    300s;
        proxy_send_timeout    300s;
        proxy_buffering       off;
        proxy_cache_bypass    $http_upgrade;
    }

    # 错误页：避免把 nginx 默认页暴露给用户
    error_page 429 = @too_many;
    location @too_many {
        default_type application/json;
        return 429 '{"code":"TOO_MANY_REQUESTS","message":"请求过于频繁，请稍后再试"}';
    }
}
```

### 4. `nocobase/plugins/service-ticket/src/server/plugin.ts`（全文）

```ts
/**
 * 家电门店售后服务平台 —— 核心业务插件（服务端）
 *
 * 这是整个系统**唯一**的后端业务扩展点（开发文档 §6 / docs/PHASE-0.md 的能力矩阵）：
 * 不额外起 Node 服务、不改 NocoBase 核心代码、不引入付费插件。
 *
 * 生命周期（依据 NocoBase 2.2.x 源码 plugin-manager）：
 *   pm.load():  ① 对每个插件 await plugin.beforeLoad()
 *               ② 对每个插件 await plugin.loadCollections()  （扫描 <basePath>/server/collections 目录）
 *               ③ 对每个插件 await plugin.load()
 *               → 之后 App.load() 若带 {sync:true} 会执行 db.sync()
 *   pm.install(): 先 db.sync()，再逐个 await plugin.install()
 *
 * 因此：**在 load() 里注册的 collection，会在紧随其后的 db.sync() 阶段被建表**；
 *      需要落种子数据的逻辑放在 install()（首次安装）与 afterEnable()（后台启用插件）。
 *
 * 本文件在 Phase 1 只做三件事：
 *   1) 注册 11 张表（字段级定义见 src/server/collections/）
 *   2) 注册并公开 /api/svc:health 健康检查
 *   3) 写入 systemSettings 参数种子
 * 业务服务层（TicketService / VisitService / SmsService …）自 Phase 2 起逐个接入。
 */
import { Plugin } from '@nocobase/server';

import { ALL_COLLECTIONS, EXPECTED_TABLE_NAMES } from './collections';
import { ANONYMOUS_ACTIONS, DEFAULT_SETTINGS, PKG_NAME } from './constants';
import { createHealthHandler, type HealthState } from './actions/public/health';

/** 与 package.json 保持一致；health 接口会回显，便于确认线上跑的是哪一版 */
const PLUGIN_VERSION = '1.0.0';

export class ServiceTicketPlugin extends Plugin {
  /**
   * 运行期状态。
   * 刻意做成普通对象而不是依赖 app 单例，方便 /api/svc:health 直接读取，
   * 也方便 Phase 2 起的定向测试注入假状态。
   */
  private healthState: HealthState = {
    ready: false,
    registeredCollections: 0,
    tasksRegistered: 0,
    settingsSeeded: false,
    loadedAt: '',
  };

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * beforeLoad：本插件当前不需要在 collection 同步之前做任何事。
   * 保留覆写是为了留出明确的位置给 Phase 2 的 storeScope 中间件前置准备。
   */
  async beforeLoad(): Promise<void> {
    this.app.log.debug(`[${PKG_NAME}] beforeLoad`);
  }

  /**
   * load：注册表结构 + 接口 + 权限。
   * 注意执行顺序 —— 先把表建好，再挂接口，最后开权限，任何一步抛错都会阻断启动
   * （这是刻意的：宁可启动失败，也不要带着半套表结构对外服务）。
   */
  async load(): Promise<void> {
    this.registerCollections();
    this.registerHealthAction();
    this.registerAcl();

    // Phase 1 没有定时任务；Phase 8/9 接入后这里是真实数量
    this.healthState.tasksRegistered = 0;
    this.healthState.loadedAt = new Date().toISOString();
    this.healthState.ready = true;

    this.app.log.info(
      `[${PKG_NAME}] 已加载：${ALL_COLLECTIONS.length} 张表 / ` +
        `期望表名 ${EXPECTED_TABLE_NAMES.length} 个 / 定时任务 ${this.healthState.tasksRegistered} 个 / v${PLUGIN_VERSION}`,
    );
  }

  /** install：首次安装（容器第一次启动）时落参数种子 */
  async install(): Promise<void> {
    await this.seedSettings('system');
  }

  /** afterEnable：后台手工启用/重新启用插件时补种参数（不覆盖已有值） */
  async afterEnable(): Promise<void> {
    await this.seedSettings('system');
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /**
   * 注册全部 collection。
   *
   * 幂等保护：应用热重载（app.reload()）会重新走一遍 load()，
   * 若 collection 已存在则跳过，避免 "Collection already defined" 抛错。
   */
  private registerCollections(): void {
    let registered = 0;

    for (const options of ALL_COLLECTIONS) {
      const name = (options as { name: string }).name;

      if (this.hasCollection(name)) {
        this.app.log.debug(`[${PKG_NAME}] collection "${name}" 已存在，跳过注册`);
        registered += 1;
        continue;
      }

      this.db.collection(options);
      registered += 1;
    }

    this.healthState.registeredCollections = registered;
  }

  /** db 上是否存在该 collection（兼容不同版本的判定入口） */
  private hasCollection(name: string): boolean {
    const db: any = this.db;
    if (typeof db.hasCollection === 'function') {
      return !!db.hasCollection(name);
    }
    if (db.collections && typeof db.collections.has === 'function') {
      return db.collections.has(name);
    }
    // 兜底：拿不到判定方法时按"不存在"处理，交给 db.collection() 自身去报错
    return false;
  }

  /**
   * 注册健康检查：GET /api/svc:health
   *
   * resource 声明为 single 类型，action 名叫 health；
   * NocoBase 的 resourcer 会把 /api/svc:health 解析成 resource=svc, action=health。
   */
  private registerHealthAction(): void {
    const handler = createHealthHandler({
      pluginVersion: PLUGIN_VERSION,
      state: this.healthState,
    });

    const resourcer: any = this.app.resourcer;

    // 若同名 resource 已存在（热重载），先移除再重新定义，保证 handler 引用的是最新闭包
    if (typeof resourcer.removeResource === 'function' && resourcer.getResource?.('svc')) {
      resourcer.removeResource('svc');
    }

    resourcer.define({
      name: 'svc',
      type: 'single',
      actions: {
        health: handler,
      },
    });

    this.app.log.debug(`[${PKG_NAME}] 已注册 action: GET /api/svc:health`);
  }

  /**
   * 开放匿名访问权限。
   *
   * NocoBase 的 ACL 语义（源码 @nocobase/acl）：
   *   acl.allow(resource, action) 等价于 skip(resource, action, 'public')，
   *   会在 allowManager 里登记一个恒真条件，命中后设置 ctx.permission.skip = true，
   *   从而**完全跳过登录态与角色校验**。
   *
   * 因此这份白名单是"对外暴露面"的唯一事实来源，
   * 必须与 docs/API.md §0 严格一致（每多一条都要单独评审）。
   */
  private registerAcl(): void {
    const acl: any = (this.app as any).acl;

    if (!acl || typeof acl.allow !== 'function') {
      // 极端情况：权限插件未启用。此时绝不能"降低安全要求"继续跑，
      // 而是记录错误 —— health 接口会因此返回 tasks/ready 异常，被监控发现。
      this.healthState.lastError = 'ACL_UNAVAILABLE';
      this.app.log.error(`[${PKG_NAME}] app.acl 不可用，匿名白名单未生效，请检查 @nocobase/plugin-acl 是否启用`);
      return;
    }

    for (const [resource, action] of ANONYMOUS_ACTIONS) {
      acl.allow(resource, action);
      this.app.log.debug(`[${PKG_NAME}] 开放匿名访问：${resource}:${action}`);
    }
  }

  /**
   * 写入 systemSettings 参数种子。
   *
   * 三条原则：
   *  1) **只增不改**：已存在的键一律跳过，运营在后台调过的值不会被安装脚本冲掉。
   *  2) 支持 .env 覆盖：同名环境变量（DEFAULT_SETTINGS[].envKey）优先于代码默认值，
   *     这样首次上线可以一次部署到位，不必进后台手工配。
   *  3) **失败不阻断启动**：参数缺失只影响阈值默认值，不该让整个应用起不来；
   *     失败信息写进 healthState.settingsSeeded / lastError，由 /api/svc:health 暴露。
   */
  private async seedSettings(operator: string): Promise<void> {
    try {
      const repository = this.db.getRepository('systemSettings');
      let created = 0;
      let skipped = 0;

      for (const seed of DEFAULT_SETTINGS) {
        const existing = await repository.findOne({ filter: { key: seed.key } });
        if (existing) {
          skipped += 1;
          continue;
        }

        const fromEnv = seed.envKey ? process.env[seed.envKey] : undefined;
        const value =
          fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== ''
            ? String(fromEnv).trim()
            : seed.value;

        await repository.create({
          values: {
            key: seed.key,
            value,
            value_type: seed.valueType,
            description: seed.description,
            updated_by: operator,
          },
        });
        created += 1;
      }

      this.healthState.settingsSeeded = true;
      this.app.log.info(`[${PKG_NAME}] 参数种子：新增 ${created} 项，跳过（已存在）${skipped} 项`);
    } catch (error) {
      this.healthState.settingsSeeded = false;
      this.healthState.lastError = 'SEED_SETTINGS_FAILED';
      this.app.log.error(`[${PKG_NAME}] 写入参数种子失败：${(error as Error)?.message}`);
    }
  }
}

export default ServiceTicketPlugin;
```

### 5. `src/server/index.ts`（全文）

```ts
export { ServiceTicketPlugin } from './plugin';
export { default } from './plugin';
```

> 要点：NocoBase 的 `requireModule` 逻辑是 `m.__esModule ? m.default : m`，
> 因此**必须同时具备 `default` 导出**与 CJS 的 `__esModule` 标记。
> esbuild 的 `cjs` 产物自带 `__toCommonJS` 包装，天然满足；`build-plugin.mjs` 会自检这一点。

### 6. `src/server/actions/public/health.ts`（全文）

```ts
/**
 * 健康检查 action（全匿名，供容器探针与上线自检使用）
 *
 * 路径：GET /api/svc:health
 *   （NocoBase 自定义 action 的原生 URL 形式是 /api/<resource>:<action>，
 *     见 docs/DEVIATIONS.md DEV-10）
 *
 * 设计约束：
 *  - **不得泄露任何敏感信息**：不返回数据库连接串、不返回环境变量、不返回错误堆栈。
 *    数据库异常时只回 db:"error" + 一个稳定的错误分类码。
 *  - 供 docker healthcheck 调用，必须快：全部检查都是轻量查询。
 *  - 顶层字段保持扁平（db / sms / tasks），便于 shell 一行断言。
 */
import { EXPECTED_TABLE_NAMES } from '../../collections';

export interface HealthState {
  /** 插件 load() 是否完整走完 */
  ready: boolean;
  /** 已注册的 collection 数量 */
  registeredCollections: number;
  /** 已注册的定时任务数量（Phase 1 为 0；Phase 8/9 起 > 0） */
  tasksRegistered: number;
  /** 参数种子是否成功落库 */
  settingsSeeded: boolean;
  /** 插件加载完成时间（ISO） */
  loadedAt: string;
  /** 加载期捕获到的非阻塞错误信息（供排障，不含敏感数据） */
  lastError?: string;
}

/** 依赖注入进来的运行时信息 */
export interface HealthRuntime {
  pluginVersion: string;
  /** 由插件在 load() 时写入的、可变的运行状态 */
  state: HealthState;
}

/** 稳定错误分类码（不外泄原始错误文本） */
const DB_ERROR_CODES = {
  CONNECT_FAILED: 'DB_CONNECT_FAILED',
  QUERY_FAILED: 'DB_QUERY_FAILED',
} as const;

/**
 * 用 information_schema 统计本插件的表是否都已创建。
 * 表名来自代码常量（EXPECTED_TABLE_NAMES），不含任何外部输入，
 * 因此这里的 SQL 拼接是安全的（下方做了白名单二次断言）。
 */
async function inspectTables(app: any): Promise<{
  present: string[];
  missing: string[];
  errorCode?: string;
}> {
  const safeNames = EXPECTED_TABLE_NAMES.filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
  const inList = safeNames.map((n) => `'${n}'`).join(', ');

  const sql = `
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (${inList})
  `;

  try {
    const rows: Array<{ name: string }> = await app.db.sequelize.query(sql, { type: 'SELECT' });
    const present = rows.map((r) => r.name);
    return {
      present,
      missing: safeNames.filter((n) => !present.includes(n)),
    };
  } catch (err) {
    return { present: [], missing: safeNames, errorCode: DB_ERROR_CODES.QUERY_FAILED };
  }
}

export function createHealthHandler(runtime: HealthRuntime) {
  return async function svcHealth(ctx: any, next: any): Promise<void> {
    const startedAt = Date.now();
    const { state } = runtime;

    // 沿用上游（nginx / 上游服务）传进来的 traceId，没有就现造一个，
    // 便于把 nginx access log 与应用日志串起来。
    const traceId = ctx.get?.('x-trace-id') || `hc-${Date.now().toString(36)}`;
    ctx.set?.('X-Trace-Id', traceId);

    // ---------------- 1. 数据库连通性 ----------------
    let dbStatus: 'ok' | 'error' = 'error';
    let dbErrorCode: string | undefined;
    try {
      await ctx.app.db.sequelize.authenticate();
      dbStatus = 'ok';
    } catch (err) {
      dbErrorCode = DB_ERROR_CODES.CONNECT_FAILED;
    }

    // ---------------- 2. 表结构 ----------------
    let tables = { present: [] as string[], missing: [] as string[] };
    if (dbStatus === 'ok') {
      const t = await inspectTables(ctx.app);
      tables = { present: t.present, missing: t.missing };
      if (t.errorCode) dbErrorCode = t.errorCode;
    }

    // ---------------- 3. 短信通道 ----------------
    // 只回通道名，不回任何密钥。mock 表示当前不会真实发短信。
    const smsProvider = String(ctx.app.env?.SMS_PROVIDER || process.env.SMS_PROVIDER || 'mock');

    // ---------------- 4. 定时任务 ----------------
    // Phase 1 尚无定时任务，"ok" 表示任务注册环节本身成功执行完毕；
    // Phase 8/9 接入 slaScan/reviewExpire/smsRetry/guardCleanup 后此处置为真实任务数。
    const tasksStatus = state.ready ? 'ok' : 'skipped';

    const tablesOk = tables.missing.length === 0;
    const status = dbStatus === 'ok' && tablesOk && state.ready ? 'ok' : 'degraded';

    const payload: Record<string, any> = {
      // —— 验收断言用得到的前三个字段（保持扁平）——
      db: dbStatus,
      sms: smsProvider,
      tasks: tasksStatus,

      // —— 排障补充信息（均非敏感）——
      status,
      plugin: '@local/service-ticket',
      version: runtime.pluginVersion,
      ready: state.ready,
      uptimeSeconds: Math.round(process.uptime()),
      tablesExpected: EXPECTED_TABLE_NAMES.length,
      tablesPresent: tables.present.length,
      missingTables: tables.missing,
      registeredCollections: state.registeredCollections,
      tasksRegistered: state.tasksRegistered,
      settingsSeeded: state.settingsSeeded,
      loadedAt: state.loadedAt || null,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      traceId,
    };

    if (dbErrorCode) payload.dbErrorCode = dbErrorCode;
    if (state.lastError) payload.lastError = state.lastError;

    ctx.status = status === 'ok' ? 200 : 503;
    ctx.body = payload;

    // 探针调用频繁，成功时降级日志级别，避免刷满日志
    if (status === 'ok') {
      ctx.app.log.debug(`[svc:health] ok latency=${payload.latencyMs}ms trace=${traceId}`);
    } else {
      ctx.app.log.warn(
        `[svc:health] degraded status=${status} db=${dbStatus} missing=${tables.missing.join(',')} trace=${traceId}`,
      );
    }

    await next();
  };
}
```

### 7. `src/server/collections/index.ts`（全文）

```ts
/**
 * 全部 collection 注册清单 + 期望表名清单
 *
 * 两张清单必须**成对维护**：
 *  - ALL_COLLECTIONS   → 传给 db.collection() 的定义
 *  - EXPECTED_TABLE_NAMES → /api/svc:health 用它核对「表到底建出来没有」
 * 二者一旦不同步，健康检查就会误报（要么漏报缺表，要么恒报缺表）。
 * verify-plugin-load.mjs 里有一条断言专门核对这两个清单是否自洽。
 *
 * 命名映射：NocoBase 默认 snakeCase 化 collection name 得到表名，
 * 例：serviceVisitPhotos → service_visit_photos
 */
import type { CollectionOptions } from '@nocobase/database';

import { stores } from './stores';
import { storeUsers } from './storeUsers';
import { systemSettings } from './systemSettings';
import { serviceTickets } from './serviceTickets';
import { serviceVisits } from './serviceVisits';
import { serviceVisitPhotos } from './serviceVisitPhotos';
import { ticketEvents } from './ticketEvents';
import { smsLogs } from './smsLogs';
import { dailySequences } from './dailySequences';
import { apiGuards } from './apiGuards';
import { idempotencyRecords } from './idempotencyRecords';

/**
 * 注册顺序：主数据 → 业务主体 → 支撑表。
 * NocoBase 建表时按此顺序执行 db.sync()，先有被引用的表更利于外键创建。
 *
 * 注：docs/DEV-PLAN.md 的 Phase 1 验收门槛写"9 张表"，而 docs/DATA-MODEL.md
 * 逐表定义了 11 张 —— 差异见 docs/DEVIATIONS.md DEV-11，以 DATA-MODEL.md 为准。
 */
export const ALL_COLLECTIONS: CollectionOptions[] = [
  // ---- 主数据 ----
  stores,
  storeUsers,
  systemSettings,
  // ---- 业务主体 ----
  serviceTickets,
  serviceVisits,
  serviceVisitPhotos,
  ticketEvents,
  // ---- 支撑 ----
  smsLogs,
  dailySequences,
  apiGuards,
  idempotencyRecords,
];

/** 期望出现在 PostgreSQL 中的表名（下划线形式），健康检查逐项核对 */
export const EXPECTED_TABLE_NAMES: string[] = [
  'stores',
  'store_users',
  'service_tickets',
  'service_visits',
  'service_visit_photos',
  'ticket_events',
  'sms_logs',
  'daily_sequences',
  'api_guards',
  'idempotency_records',
  'system_settings',
];
```

### 8. `src/server/collections/_helpers.ts`（全文）

```ts
/**
 * collection 字段构造器
 *
 * 目的：让 11 张表的定义读起来是「业务字段表」而不是「框架 API 大全」。
 * 统一在这里固化三件事：
 *  1) 字段类型 → NocoBase interface + 中文 uiSchema 标题前缀
 *  2) 外键一律**显式指定 snake_case 名**（belongsTo 的默认命名在不同版本有差异，
 *     显式写死可以杜绝"迁移后外键列名变了"这类事故）
 *  3) 敏感字段（Token 哈希、storage_key）统一带 x-sensitive 标记，供前端脱敏读取
 */
import type { CollectionOptions } from '@nocobase/database';

/** 通用字段返回结构（只约束我们真正会写的那几个键） */
export interface FieldDef {
  name: string;
  type: string;
  interface?: string;
  uiSchema?: Record<string, any>;
  [key: string]: any;
}

/** 必填字符串 */
export function str(name: string, title: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    name,
    type: 'string',
    interface: 'input',
    uiSchema: { type: 'string', title, 'x-component': 'Input' },
    ...extra,
  };
}

/** 枚举字符串（存 code，展示 label；选项来自 _options.ts） */
export function enumStr(
  name: string,
  title: string,
  options: Array<{ label: string; value: string }>,
  extra: Partial<FieldDef> = {},
): FieldDef {
  return {
    name,
    type: 'string',
    interface: 'select',
    uiSchema: {
      type: 'string',
      title,
      enum: options,
      'x-component': 'Select',
    },
    ...extra,
  };
}

/** 长文本 */
export function text(name: string, title: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    name,
    type: 'text',
    interface: 'textarea',
    uiSchema: { type: 'string', title, 'x-component': 'Input.TextArea' },
    ...extra,
  };
}

/** 整数 */
export function int(name: string, title: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    name,
    type: 'integer',
    interface: 'number',
    uiSchema: { type: 'number', title, 'x-component': 'InputNumber', 'x-component-props': { precision: 0 } },
    ...extra,
  };
}

/** 布尔 */
export function bool(name: string, title: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    name,
    type: 'boolean',
    interface: 'checkbox',
    uiSchema: { type: 'boolean', title, 'x-component': 'Checkbox' },
    ...extra,
  };
}

/** 金额（人民币，两位小数；全程以 decimal 存储，避免浮点误差） */
export function money(name: string, title: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    name,
    type: 'decimal',
    interface: 'number',
    uiSchema: {
      type: 'number',
      title,
      'x-component': 'InputNumber',
      'x-component-props': { precision: 2, addonBefore: '¥' },
    },
    ...extra,
  };
}

/** 时间戳（带时区） */
export function ts(name: string, title: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    name,
    type: 'date',
    interface: 'datetime',
    uiSchema: { type: 'string', title, 'x-component': 'DatePicker', 'x-component-props': { showTime: true } },
    ...extra,
  };
}

/** JSON 结构（元数据、快照） */
export function json(name: string, title: string, extra: Partial<FieldDef> = {}): FieldDef {
  return {
    name,
    type: 'json',
    interface: 'json',
    uiSchema: { type: 'object', title, 'x-component': 'Input.JSON' },
    ...extra,
  };
}

/**
 * 外键（多对一）。
 * 显式写死外键列名，避免 NocoBase 不同版本的默认命名差异。
 * target 为被引用 collection 的 name；onDelete 默认 RESTRICT（禁止级联删业务数据）。
 */
export function belongsTo(
  name: string,
  title: string,
  target: string,
  foreignKey: string,
  extra: Record<string, any> = {},
): FieldDef {
  return {
    name,
    type: 'belongsTo',
    interface: undefined,
    target,
    foreignKey,
    onDelete: 'RESTRICT',
    uiSchema: { title, 'x-component': 'AssociationField', 'x-component-props': { multiple: false } },
    ...extra,
  };
}

/**
 * 敏感字段标记。
 * 用于 Token 哈希、storage_key 这类「不该出现在列表页/导出里」的列。
 * NocoBase 自身的字段级权限在 Phase 2 配置，这里先在 uiSchema 里做显式声明。
 */
export function sensitive(field: FieldDef): FieldDef {
  return {
    ...field,
    uiSchema: { ...(field.uiSchema || {}), 'x-sensitive': true },
  };
}
```

### 9. 11 张 collection 字段级清单

> 完整可编译代码见 `src/server/collections/*.ts`（11 个文件，见文件清单）。
> 唯一约束与索引是 Phase 1 最需要评审的部分，故完整列出（与 `docs/DATA-MODEL.md` 一致）：

| # | collection | 表名 | 唯一约束 | 普通索引 | 关键字段 |
|---|---|---|---|---|---|
| 1 | `stores` | `stores` | `code` | `status` | code/name/short_name/region/address/contact_mobile/status |
| 2 | `storeUsers` | `store_users` | `(user_id, store_id)` | `user_id`, `store_id` | user_id/store_id/role_in_store/is_primary |
| 3 | `systemSettings` | `system_settings` | `key` | — | key/value/value_type/description/updated_by |
| 4 | `serviceTickets` | `service_tickets` | `ticket_no`、`feedback_token_hash` | `store_id`、`status`、`ticket_type`、`customer_mobile`、`created_at`、`(store_id,status)`、`(status,created_at)`、`technician_mobile`、`sla_due_at` | ticket_no/ticket_type/source/store_id/customer_*/product_*/issue_*/status/service_mode/technician_*/expected_visit_at/charge_*/feedback_*/closed_*/close_reason |
| 5 | `serviceVisits` | `service_visits` | `(ticket_id, visit_no)`、`access_token_hash` | `ticket_id`、`token_expire_at` | ticket_id/visit_no/technician_*/service_mode/service_result/charge_amount/charge_match_status/**access_token_hash** |
| 6 | `serviceVisitPhotos` | `service_visit_photos` | `file_id` | `visit_id`、`photo_type` | visit_id/photo_type/**storage_key**/original_name/mime/size/width/height/uploaded_by_kind |
| 7 | `ticketEvents` | `ticket_events` | — | `(ticket_id, created_at)`、`event_type` | ticket_id/visit_id/event_type/operator_kind/operator_id/summary/metadata_json |
| 8 | `smsLogs` | `sms_logs` | `(provider, biz_id)` | `delivery_status`、`ticket_id`、`scene` | provider/biz_id/scene/recipient_masked/template_code/params_json/send_status/delivery_status/error_message/ticket_id/visit_id |
| 9 | `dailySequences` | `daily_sequences` | `seq_key` | — | seq_key/current_value/updated_at |
| 10 | `apiGuards` | `api_guards` | `(scene, scope, guard_key, window_start)` | `window_start` | scene/scope/guard_key/window_start/counter/blocked_until |
| 11 | `idempotencyRecords` | `idempotency_records` | `(scene, idempotency_key)` | `created_at` | scene/idempotency_key/request_hash/response_json/status_code/expire_at |

**三处「唯一约束即安全机制」的说明**（这是 Phase 1 最容易被忽略的设计点）：

1. `smsLogs` 的 `unique(provider, biz_id)` —— 短信回执幂等的**唯一**落地手段。
   没有它，供应商重推回调就会产生重复事件。
2. `serviceTickets.ticket_no` 唯一 —— 并发取号的最终防线（`dailySequences` 提供
   `UPDATE ... RETURNING` 原子自增，唯一约束兜底防止空洞被外部注入）。
3. `serviceVisits.access_token_hash` 唯一 —— 保证「一次上门一个 Token」，
   且**只存哈希**。哈希唯一意味着 Token 明文泄漏也无从反查，且不会被跨单复用。

---

## 【数据库变更】

Phase 1 的建表**完全由 NocoBase 的 `db.sync()` 完成**，不写手工 migration SQL。
理由：表结构在 TypeScript 里定义一次即可，避免「代码定义 + SQL 脚本」双重维护漂移。

| 项 | 值 |
|---|---|
| 数据库 | PostgreSQL 16（`postgres:16`，`wal_level=logical`，`max_connections=120`） |
| 库名 | `service_ticket`（`POSTGRES_DB` / `DB_DATABASE`） |
| 用户 | `svc_app`（`POSTGRES_USER` / `DB_USER`） |
| 建表时机 | 首次 `nocobase install` → `plugin.load()` 注册 11 张表 → `db.sync()` 建表 |
| 后续改表 | 改 `src/server/collections/*.ts` → `node scripts/build-plugin.mjs` → `docker compose restart app`（`load()` 幂等重新注册 + `db.sync()` 增量同步） |
| 数据卷 | 具名卷 `svc_pg_data` → 容器 `/var/lib/postgresql/data` |

### 建表结果核对 SQL

```sql
-- 应返回 11 行（本插件业务表）
SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN (
    'stores','store_users','service_tickets','service_visits',
    'service_visit_photos','ticket_events','sms_logs','daily_sequences',
    'api_guards','idempotency_records','system_settings'
  )
ORDER BY table_name;

-- 核对唯一约束是否都建上了（应能看到 tickets 的 ticket_no / feedback_token_hash 等）
SELECT conrelid::regclass AS tbl, conname, contype
FROM pg_constraint
WHERE contype IN ('u','p')
  AND conrelid::regclass::text IN (
    'stores','store_users','service_tickets','service_visits',
    'service_visit_photos','sms_logs','daily_sequences',
    'api_guards','idempotency_records','system_settings')
ORDER BY 1, 2;

-- 核对参数种子（应为 16 行）
SELECT key, value, value_type FROM system_settings ORDER BY key;
```

> NocoBase 自身还会建一批系统表（`users`、`roles`、`collections`、`fields`、
> `authenticators` 等），因此 `\dt` 看到的数量会明显多于 11 ——
> **验收时请用上面第 1 条 SQL**（按表名白名单过滤），不要用 `SELECT count(*) FROM pg_tables`。

---

## 【配置项】

| 变量 | 默认值（`.env.example`） | 作用 | 验收相关 |
|---|---|---|---|
| `APP_KEY` | `CHANGE_ME__…` → 脚本生成 64 位 | 应用密钥；变更后所有 Token 失效 | ✅ 必须替换 |
| `TZ` | `Asia/Shanghai` | 工单号日期、SLA 口径、报表 | |
| `APP_LANGUAGE` | `zh-CN` | 应用语言 | |
| `APP_PORT` | `13000` | 容器内监听端口（不对公网暴露） | |
| `PUBLIC_BASE_URL` | `http://localhost` | 拼接短信里的师傅/评价链接 | 上线须改域名 |
| `DB_DIALECT` / `DB_HOST` / `DB_PORT` | `postgres` / `postgres` / `5432` | 连接串 | |
| `DB_DATABASE` / `DB_USER` | `service_ticket` / `svc_app` | 库与用户 | |
| `DB_PASSWORD` / `POSTGRES_PASSWORD` | 脚本生成 40 位（**两者必须一致**） | 数据库口令 | ✅ 必须替换 |
| `APPEND_PRESET_BUILT_IN_PLUGINS` | `@local/service-ticket` | 自动安装 + 自动启用插件 | ✅ 核心机制 |
| `PLUGIN_PACKAGE_PREFIX` | `@nocobase/plugin-,@nocobase/preset-,@local/` | 插件包名前缀白名单 | ✅ 缺 `@local/` 启动即抛错 |
| `NODE_MODULES_PATH` / `STORAGE_PATH` / `PLUGIN_STORAGE_PATH` | `/app/nocobase/node_modules` / `…/storage` / `…/storage/plugins` | 容器内路径 | ✅ 与 compose 挂载对应 |
| `NOCOBASE_EXTRACT_CLIENT_ASSETS` | `false` | 由本项目自维护 nginx，不由 NocoBase 生成代理配置 | |
| `SIGN_SECRET` | 脚本生成 64 位 | 照片短时签名 URL 的 HMAC 密钥 + IP 加盐 | ✅ 必须替换 |
| `SIGN_URL_TTL_SECONDS` | `600` | 签名有效期 | |
| `UPLOAD_PRIVATE_DIR` | `/app/nocobase/storage/uploads-private` | 私有上传根目录 | |
| `UPLOAD_MAX_SIZE_MB` / `UPLOAD_MAX_COUNT` | `5` / `6` | 单张上限 / 单次张数（与 nginx `client_max_body_size 8m` 呼应） | |
| `UPLOAD_MAX_EDGE_PX` / `UPLOAD_JPEG_QUALITY` | `1600` / `82` | 服务端重编码长边与质量（同时剥离 EXIF/GPS） | |
| `SMS_PROVIDER` | `mock` | 短信通道（mock/aliyun/tencent） | ✅ 验收要求回 `mock` |
| `SMS_RETRY_COUNT` | `1` | 失败重试次数（文档要求最多 1 次） | |
| `SMS_ENABLED` | `false` | 服务商就绪标志；`false` 时任务跳过、日志记 `rejected` | |
| `ALIYUN_SMS_*` / `TENCENT_SMS_*` | 空 | 真实短信凭据与模板 CODE（腾讯云为预留） | |
| `MOCK_SMS_CALLBACK_SECRET` | 脚本生成 32 位 | mock 回调验签 | |
| `SVC_DEFAULT_*` × 11 | 见 `.env.example` §7 | 首次初始化写入 `system_settings` 的参数种子 | ✅ 与 constants.ts 逐项对齐 |
| `NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT` | `80` / `443` | 对外端口 | |
| `APP_DEBUG_PORT` | `13000` | 仅绑定 `127.0.0.1` 的调试口 | |
| `BACKUP_RETENTION_DAYS` | `30` | 备份保留天数 | |
| `BACKUP_PASSPHRASE` | 脚本生成 32 位 | 备份加密口令 | ✅ 必须替换 |

**`.env` 中的 11 个参数种子**（与 `constants.ts` 的 `envKey` 一对一，脚本会校验无孤儿键）：
`FEEDBACK_LOW_SCORE_THRESHOLD=2`、`FEEDBACK_WAIT_DAYS=7`、`FEEDBACK_TOKEN_EXPIRE_DAYS=15`、
`TECHNICIAN_TOKEN_EXPIRE_HOURS=72`、`SLA_ACCEPT_MINUTES=120`、
`SLA_APPOINTMENT_OVERDUE_GRACE_MINUTES=120`、`SLA_STORE_CONFIRM_HOURS=48`、
`SECURITY_IP_MINUTE_LIMIT=30`、`SECURITY_TICKET_PHONE_DAILY_LIMIT=5`、
`SECURITY_DUPLICATE_WINDOW_MINUTES=10`、`PRIVACY_RETENTION_MONTHS=24`。

> 除上述 11 项外，`DEFAULT_SETTINGS` 还含 5 项无环境变量覆盖的配置（共 16 项落库）；
> 这些项只能通过后台「参数配置」页修改。

---

## 【运行命令】

### 首次部署（按序执行）

```bash
cd /path/to/service-ticket

# ① 生成 .env（随机密钥；已存在则加 --force 才会覆盖）
node scripts/gen-secret.mjs

# ② 编译插件到 storage/plugins/@local/service-ticket
node scripts/build-plugin.mjs

# ③ 启动前静态自检（不需要 Docker daemon）
node scripts/verify-config.mjs

# ④ 拉起三容器
docker compose up -d

# ⑤ 跟踪首次安装日志（看到「已加载：11 张表」与「参数种子：新增 16 项」即成功）
docker compose logs -f app
```

### 验收

```bash
# 1) 三容器状态（app 首次需 1–3 分钟变 healthy）
docker compose ps

# 2) 健康检查 —— 冒号形式（原生）
curl -s http://localhost/api/svc:health | head -c 400

# 3) 健康检查 —— 斜杠形式（验收文档写法，二者等价）
curl -s http://localhost/api/svc/health

# 4) 一行断言核心三字段
curl -s http://localhost/api/svc/health \
  | tr -d ' \n' | grep -q '"db":"ok","sms":"mock","tasks":"ok"' \
  && echo "PASS" || echo "FAIL"

# 5) 核对 11 张表
docker compose exec -T postgres psql -U svc_app -d service_ticket -c "\dt" | grep -E \
  'stores|store_users|service_tickets|service_visits|service_visit_photos|ticket_events|sms_logs|daily_sequences|api_guards|idempotency_records|system_settings'
```

### 离线自检（无 Docker 也可跑）

```bash
node scripts/build-plugin.mjs          # 编译 + 产物自检
node scripts/verify-config.mjs         # 41 项部署层断言
node scripts/verify-plugin-load.mjs    # 24 项插件生命周期断言
```

### 日常运维

```bash
docker compose restart app                 # 改插件后（需先 build-plugin）
docker compose exec nginx nginx -t         # nginx 配置语法检查
docker compose exec nginx nginx -s reload  # 热加载 nginx
docker compose down                        # 停止（保留数据）
docker compose down -v                     # ⚠️ 停止并删除数据卷（数据不可恢复）
```

---

## 【测试方法】

Phase 1 的测试全部是**可重放的自动化断言**，不需要人工点击。

| # | 脚本 / 命令 | 断言数 | 需要 Docker | 覆盖内容 |
|---|---|---|---|---|
| T1 | `node scripts/build-plugin.mjs` | 产物自检 6 项 | ❌ | 包名/`main`/`supportedVersions` 预检；产物含 `__toCommonJS`、`__esModule`、`default` 取值器、`ServiceTicketPlugin` 类；未内联 `defineCollection`（说明 external 生效）；引用 `@nocobase/database` |
| T2 | `node scripts/verify-plugin-load.mjs` | **31 项** ✅ | ❌ | ① 包解析与导出形态 ② 生命周期 `load()` ③ 健康检查 ④ 参数种子 `install()` ⑤ 热重载幂等性 ⑥ **索引声明清单守卫**（DEV-16/17） |
| T3 | `node scripts/verify-config.mjs` | **41 项** ✅ | ❌ | ① compose 结构与安全基线（16）② nginx 静态 lint（12）③ `.env`/常量交叉一致性（11）④ 目录与文档完整性（3） |
| T4 | `docker compose config --quiet` | — | ❌ | compose 全量变量展开后语法有效（退出码 0） |
| T5 | `node scripts/smoke-test.mjs` | **55 项** ✅ | ✅ | **真机端到端验收**：容器状态 / nginx 路由与安全头 / **11 张表 + 35 条声明式索引逐条落库核对** / 参数种子 / 运行时稳定性。详见 `docs/VERIFY-PHASE-1.md` |

> 合计 **127 项断言全绿**（离线 72 + 真机 55）。

### T2 的 31 项明细（这是 Phase 1 的核心证据）

```
【1】包解析与导出形态（4）
  ✅ require('@local/service-ticket') 可解析（等同容器内 node_modules 挂载）
  ✅ NocoBase 的 requireModule 语义可取到插件类（__esModule → default） — ServiceTicketPlugin
  ✅ 同时提供具名导出 ServiceTicketPlugin
  ✅ package.json main 指向 ./dist/server/index.js — v1.0.0
【2】生命周期 load()（17）
  ✅ new Plugin(app, options) 可实例化
  ✅ load() 无异常完成
  ✅ 注册了 11 张表 — stores, storeUsers, serviceTickets, serviceVisits,
     serviceVisitPhotos, ticketEvents, smsLogs, dailySequences, apiGuards,
     idempotencyRecords, serviceSettings
  ✅ 集合名与 docs/DATA-MODEL.md 一致
  ✅ 集合名 → 表名映射与 EXPECTED_TABLE_NAMES 自洽 — stores, store_users, …
  ✅ 全部集合都启用了 underscored（表名/时间戳落库为下划线） — 11 张表均 underscored: true
  ✅ 没有 collection 绕过 defineAppCollection 直接调 defineCollection — 13 个文件已检查
  ✅ 索引字段名全部为下划线小写（与 underscored 后的实际列名一致） — 49 个索引字段
  ✅ 没有集合使用 NocoBase 核心已占用的保留名 — 已比对 6 个保留名
  ✅ 每张表的字段都有 name 且无重复
  ✅ 唯一约束关键项存在（ticket_no / access_token_hash / feedback_token_hash）
  ✅ smsLogs 有 (provider, biz_id) 复合唯一索引（回执幂等）
  ✅ collection 级索引声明与 expected-indexes.mjs 清单逐条一致（不多不少）
     — 35 条 collection 级索引逐条对齐            ← 本次真机修复后新增（DEV-16）
  ✅ 无重复同义索引声明（同一列集合只声明一次，见 DEV-17）  ← 本次新增（DEV-17）
  ✅ 注册了 resource svc 且含 health action — GET /api/svc:health
  ✅ 开放匿名白名单：svc:health（且仅此一条）
  ✅ load() 后健康状态为 ready
【3】健康检查 GET /api/svc:health（6）
  ✅ 返回 200 且 db=ok / sms=mock / tasks=ok（Phase 1 验收门槛）
  ✅ 表数量统计正确（11/11，无缺失）
  ✅ settingsSeeded 以数据库为准（进程重启后不假阴性） — 库中 16 条→true / 0 条→false
  ✅ 响应不含敏感信息（无连接串/密码/堆栈）
  ✅ 缺表时降级为 503 并列出 missingTables（监控可发现） — missing=9
  ✅ 数据库不可达时 db=error 且不抛异常 — DB_CONNECT_FAILED
【4】参数种子 install()（3）
  ✅ 首次安装写入全部参数种子（16 项）
  ✅ 已存在的参数不被覆盖（只增不改） — 跳过 1 项
  ✅ 参数写入失败不阻断启动（记为 lastError）
【5】热重载幂等性（1）
  ✅ load() 重复调用不抛 "collection 已存在"
```

> 新增的 2 项「索引声明清单守卫」都做过**反向注入验证**，确认不是空壳：
> 删掉 `serviceVisitPhotos` 的 `file_id` 声明 → 报
> `service_visit_photos(file_id) UNIQUE: 清单要求但源码未声明`；
> 多声明一条 `stores(name)` → 报 `source 已声明但清单未登记`。

### T3 的 41 项明细

```
【1】docker-compose.yml 结构与安全基线（16）
  ✅ js-yaml 可加载且文件可解析
  ✅ 项目名为 service-ticket
  ✅ 恰好 3 个 service：postgres / app / nginx
  ✅ app 使用 -no-nginx 镜像
  ✅ app 不向 0.0.0.0 暴露端口（唯一入口只有 nginx）
  ✅ postgres 不暴露任何宿主机端口
  ✅ nginx 暴露 ${NGINX_HTTP_PORT:-80}:80
  ✅ app 依赖 postgres 且要求 service_healthy
  ✅ postgres 开启 wal_level=logical
  ✅ app 健康检查直连容器内 13000 探 /api/svc:health
  ✅ nginx 健康检查探 /healthz
  ✅ 所有 bind mount 的宿主路径都真实存在（防 Docker 静默建空目录）
  ✅ app 同时挂载 storage 与 node_modules/@local（发现 + 解析双通道）
  ✅ 插件目录/入口文件已就位
  ✅ 三容器共用 nocobase 网络
  ✅ 日志轮转已配置（max-size + max-file）
【2】Nginx 配置静态 lint（12）
  ✅ nginx.conf 大括号平衡（4 对）
  ✅ service.conf 大括号平衡（19 对）
  ✅ 每个非块指令行都以 ; 结尾
  ✅ 所有 limit_req / limit_conn 引用的 zone 都已定义
  ✅ 所有 $变量 都有来源（map 定义 / nginx 内建白名单）
  ✅ proxy_pass 的 upstream 名已定义
  ✅ 健康检查两种写法都路由到上游（冒号 + 斜杠）
  ✅ /files/ 与 /storage/uploads/ 走反代而非 alias
  ✅ 429 错误页返回 JSON
  ✅ WebSocket 升级头已正确映射
  ✅ 通用入口关闭 proxy_buffering
  ✅ include 了 conf.d/*.conf
【3】.env / 插件常量 交叉一致性（11）
  ✅ APPEND_PRESET_BUILT_IN_PLUGINS 含 @local/service-ticket
  ✅ PLUGIN_PACKAGE_PREFIX 含默认前缀与 @local/
  ✅ PLUGIN_STORAGE_PATH 与 compose 挂载一致
  ✅ .env 与 .env.example 的键集合一致（63 个变量）
  ✅ .env 中已无遗留 CHANGE_ME 占位符
  ✅ DB_PASSWORD 与 POSTGRES_PASSWORD 一致
  ✅ constants.ts 的 envKey 数量 == .env 的 SVC_DEFAULT_* 数量（11）
  ✅ .env 每个 SVC_DEFAULT_* 都对应 constants.ts 的 envKey（无孤儿）
  ✅ SMS_PROVIDER 默认 mock
  ✅ TZ 为 Asia/Shanghai
  ✅ 插件源码与构建产物同步（产物不旧于源码）
【4】目录与文档完整性（3）
  ✅ 25 个必需文件/目录全部存在
  ✅ .gitignore 忽略 .env 与 storage 运行产物
  ✅ 插件源码与构建产物同步
```

### T5 真机端到端验收（已在交付机完成，55 项全绿）

`node scripts/smoke-test.mjs` 需要 Docker，是唯一跨到真实环境的验收层。
实测**55 / 55 全绿**，节选：

```
【4. PostgreSQL 实际表结构】
  ✅ 11 张业务表全部存在（按表名白名单查询，不数 pg_tables 总数）
  ✅ unique(ticket_no) 已建立（防重复工单号）
  ✅ unique(feedback_token_hash) 已建立（评价 Token 不可逆且唯一）
  ✅ unique(ticket_id, visit_no) 已建立（一次上门一条记录，永不覆盖）
  ✅ unique(access_token_hash) 已建立（师傅 Token 单次有效）
  ✅ unique(provider, biz_id) 已建立（短信回执幂等的唯一手段）
  ✅ unique(file_id) 已建立（同一文件不得重复挂到两次上门）   ← DEV-16 修复后恢复
  ✅ service_settings 有 16 行参数种子
  ✅ service_tickets 索引已建立（含复合索引） — 14 个索引（按列集合去重）
  ✅ stores / store_users / service_tickets / service_visits / service_visit_photos
     / ticket_events / sms_logs / daily_sequences / api_guards
     / idempotency_records / service_settings 的声明式索引**全部落库**（逐表逐条）
  ✅ 没有同一组列上的重复同义索引（浪费写入与存储） — 已扫 11 张表，无重复
  ✅ daily_sequences 可正常取号 — current_value=1
【5. 运行时稳定性】
  ✅ app 容器无重启记录（重启 0 次）
  ✅ app 日志中无 error 级别输出（仅统计应用就绪之后）
  ✅ 连续 5 次健康检查均返回 200
  ✅ 健康检查响应时间 < 1s — 9ms
```

完整证据、根因分析与复现命令见 **`docs/VERIFY-PHASE-1.md`**。

---

## 【预期结果】

### 1. `curl /api/svc/health` 预期输出（HTTP 200）

```json
{
  "db": "ok",
  "sms": "mock",
  "tasks": "ok",
  "status": "ok",
  "plugin": "@local/service-ticket",
  "version": "1.0.0",
  "ready": true,
  "uptimeSeconds": 214,
  "tablesExpected": 11,
  "tablesPresent": 11,
  "missingTables": [],
  "registeredCollections": 11,
  "tasksRegistered": 0,
  "settingsSeeded": true,
  "loadedAt": "2026-09-20T08:00:00.000Z",
  "latencyMs": 4,
  "checkedAt": "2026-09-20T08:03:34.000Z",
  "traceId": "hc-xxxxxxxx"
}
```

**验收断言只取前三个字段**：`db=ok`、`sms=mock`、`tasks=ok`。

> 📌 **实测响应形态**：NocoBase 的 resourcer 会把 `single` 类型 resource 的 action
> 返回值包一层 `{"data": …}`，即真实响应是
> `{"data":{"db":"ok","sms":"mock","tasks":"ok",…}}`。
> 因此**逐字段 JSON 解析**时应读 `data.db`；而验收门槛给出的「`tr -d ' \n' | grep`」
> 一行断言是**子串匹配，不受外层包裹影响，原文可用**（已实测 PASS）。

### 2. 降级行为的预期响应（证明"能发现问题"）

| 场景 | HTTP | 关键字段 |
|---|---|---|
| 表未建全（sync 未跑完） | **503** | `status:"degraded"`、`missingTables:[...]`、`tablesPresent < 11` |
| 数据库不可达 | **503** | `db:"error"`、`dbErrorCode:"DB_CONNECT_FAILED"` |
| 表查询失败 | **503** | `dbErrorCode:"DB_QUERY_FAILED"` |
| ACL 插件未启用 | 200/503 | `lastError:"ACL_UNAVAILABLE"`（**绝不降级放行**） |
| 参数种子写入失败 | 200 | `settingsSeeded:false`、`lastError:"SEED_SETTINGS_FAILED"`（不阻断启动） |

> 为什么"缺表要返 503"：容器 healthcheck 会因此判定 unhealthy，
> 从而**不会把流量导到一个表都没建好的实例上**。这比"永远返 200"安全得多。

### 3. `docker compose ps` 预期（实测已达成）

```
NAME          IMAGE                                        STATUS
svc-postgres  postgres:16                                  Up (healthy)
svc-app       nocobase/nocobase:2.2.15-full-no-nginx       Up (healthy)
svc-nginx     nginx:1.27-alpine                            Up (healthy)
```

### 4. 数据库预期（实测已达成）

- 11 张业务表全部存在（按表名白名单查）
- `service_settings` 恰好 16 行种子　⚠️ 早期本文档写 `system_settings`，那是 DEV-15 改名前的版本，现名为 `service_settings`
- 唯一约束：`stores.code`、`store_users(user_id,store_id)`、`service_settings.key`、
  `service_tickets.ticket_no`、`service_tickets.feedback_token_hash`、
  `service_visits(ticket_id,visit_no)`、`service_visits.access_token_hash`、
  `service_visit_photos.file_id`、`sms_logs(provider,biz_id)`、
  `daily_sequences.seq_key`、`api_guards(scene,scope,guard_key,window_start)`、
  `idempotency_records(scene,idempotency_key)`
- **索引**：`scripts/expected-indexes.mjs` 清单里的 35 条 collection 级索引 + 4 条字段级唯一，
  全部落库（逐表逐条断言，见 `docs/VERIFY-PHASE-1.md` §3.5）

---

## 【当前完成情况】

| 项 | 状态 | 说明 |
|---|---|---|
| `docker-compose.yml` | ✅ 完成 | `docker compose config --quiet` 退出码 0；16 项结构断言通过 |
| `nginx/nginx.conf` + `conf.d/service.conf` | ✅ 完成 | 12 项静态 lint 通过（括号/分号/zone/变量/upstream/安全性） |
| `.env.example`（63 变量） | ✅ 完成 | 与 `.env` 键集合一致；11 项种子与 `constants.ts` 对齐 |
| 插件骨架（19 文件 / 1907 行 TS） | ✅ 完成 | esbuild 编译成功（61.0 KB），产物自检通过 |
| 11 张表定义（含唯一约束与索引） | ✅ 完成 | **真机实测 11/11 建表成功**；字段均含 `name` 且无重复 |
| `/api/svc:health` + `/api/svc/health` | ✅ 完成 | **真机实测** `{"data":{"db":"ok","sms":"mock","tasks":"ok",…}}` @ 200（两种写法均 200） |
| 参数种子（16 项，只增不改，支持 `.env` 覆盖） | ✅ 完成 | **真机实测 16 行落库**；重复装跳过、失败降级不阻断 |
| 匿名白名单（仅 `svc:health`） | ✅ 完成 | 断言"有且仅此一条"，为 Phase 3+ 的扩展留出评审位 |
| **索引兜底补齐 `ensure-indexes.ts`** | ✅ 完成 | 真机实测：每次启动补齐被框架静默丢弃的 1 条，第二遍幂等为 0（DEV-16） |
| **索引验收清单 `expected-indexes.mjs`** | ✅ 完成 | 离线（比声明）与真机（比落库）共用的单一事实来源 |
| 构建脚本 `build-plugin.mjs` | ✅ 完成 | 含预检 + 编译 + 产物自检三阶段 |
| 密钥脚本 `gen-secret.mjs` | ✅ 完成 | 已实际生成本机 `.env`（拒绝采样无偏置；DB 双口令一致性保证） |
| 静态校验脚本 `verify-config.mjs` | ✅ 完成 | **41 项全绿** |
| 桩环境验证脚本 `verify-plugin-load.mjs` | ✅ 完成 | **31 项全绿**（含 2 项索引声明守卫） |
| 真机验收脚本 `smoke-test.mjs` | ✅ 完成 | **55 项全绿**（含 11 + 1 项索引落库守卫） |
| `README.md` Phase 1 运维手册 | ✅ 完成 | 7 小节：启动/DB 初始化/插件加载/日志/配置变更/备份恢复/自检脚本 |
| `docs/DEVIATIONS.md` DEV-10 ~ DEV-17 | ✅ 完成 | 健康检查双路径、11 vs 9 张表、插件挂载形态、underscored、集合改名、索引静默丢弃、重复索引清理 |
| `docs/VERIFY-PHASE-1.md` | ✅ 完成 | 真机启动验收报告（原始证据 + 根因 + 反证 + 复现命令） |
| `docs/PHASE-1.md`（本文件） | ✅ 完成 | 按 §27 十段格式 |
| **真实容器启动验证** | ✅ **已完成** | 三容器 `Up (healthy)`，`smoke-test.mjs` 55/55 —— 详见 `docs/VERIFY-PHASE-1.md` |

### 本阶段踩过并已修复的坑（对后续阶段有参考价值）

| # | 坑 | 后果 | 修复 |
|---|---|---|---|
| 1 | 误以为健康检查路径是 `/api/svc/health` | 容器 healthcheck 永远 404 → app 永远 unhealthy | 读 `@nocobase/resourcer` 源码确认原生形式是 `resource:action` 冒号分隔；并加 nginx 别名兼容斜杠写法（DEV-10） |
| 2 | 杜撰环境变量 `NOCOBASE_INSTALL_ON_START` | 变量无效，误以为能控制首次安装 | 核实官方镜像靠入口脚本首次自动 install，删除该变量 |
| 3 | `ALLOWED_TRANSITIONS` 列入非法迁移（如 `WAIT_FEEDBACK→CLOSED` 重复、`PROCESSING→PROCESSING`） | 状态机与 `STATE-MACHINE.md` 的 M1–M15 冲突 | 对照文档重写为 6 状态正确迁移表 + `canTransition()` |
| 4 | `esbuild` 报 `Could not resolve "../collections"` | 编译失败 | `health.ts` 在 `actions/public/` 下，相对路径应为 `../../collections` |
| 5 | `build-plugin.mjs` 产物自检误报"未发现 default 导出" | 构建脚本自身不可信 | inspecting 真实产物后把正则改为锚定 `module.exports = __toCommonJS(`、`default: () =>`、`ServiceTicketPlugin = class` |
| 6 | **`h5/dist` 被 `.gitignore` 的 `dist/` 规则连带忽略** | 新克隆的仓库没有该目录 → **Docker 静默创建一个 root 所有的空目录挂进去**，报错信息完全对不上（表现为 `/h5/` 404 而非挂载错误） | `.gitignore` 增加 `!h5/dist/` 例外并保留占位 `index.html`；`verify-config.mjs` 新增"所有 bind mount 宿主路径必须存在"断言，把这类问题提前到启动前暴露 |
| 7 | nginx 引用未定义变量/zone 会**启动即 crash-loop** | 容器反复重启，日志刷屏 | lint 断言：所有 `$var` 必须来自 map 定义或内建白名单；所有 `limit_req zone=` 必须已在 `http` 段声明 |
| 8 | **`underscored` 默认 false** | 表名与时间戳列落库为驼峰，与文档、验收 SQL、`EXPECTED_TABLE_NAMES` 全面对不上；索引里写 `created_at` 会报 `42703 undefined_column` 并导致启动失败 | 强制全部 collection 经 `defineAppCollection()` 启用 `underscored: true`，并加"不得绕过"断言（DEV-14） |
| 9 | **集合名 `systemSettings` 与 NocoBase 核心冲突** | `hasCollection()` 判「已存在」→ **静默跳过注册** → 参数种子写进核心表并报 `column systemSettings.key does not exist`，一条都种不进去 | 改名 `serviceSettings`，加"不得使用核心保留名"断言（DEV-15） |
| 10 | **collection 级索引被 NocoBase `refreshIndexes()` 静默丢弃** | 表建出来了、接口 200、日志零报错，但 `service_visit_photos(file_id)` 的**唯一约束实际不存在**（每次启动稳定丢 1 条） | `ensureIndexes()` 在 `afterLoad` 后按「列集合 + 唯一性」语义等价核对补齐；并把索引清单独立成 `expected-indexes.mjs`，离线比声明 + 真机比落库双向布防（DEV-16） |
| 11 | 同一列上存在重复同义唯一索引 | 字段级 UNIQUE CONSTRAINT 与 collection 级 UNIQUE INDEX 各建一个，浪费写入与存储，且埋下"改一个漏一个"的隐患 | 删除 4 处冗余声明并 `DROP INDEX`（DEV-17） |
| 12 | 唯一索引查错了系统表 | collection 级唯一索引落库是 UNIQUE INDEX，查 `pg_constraint(contype='u')` 查不到 → 验收误报"未建立" | 改查 `pg_indexes` |
| 13 | `docker compose restart` 期间旧进程仍在服务 | 健康历史里出现"假成功"探针，导致 1 条 error 日志被误计 | `--since` 改取健康历史**尾部连续成功段**的起点 |
| 14 | `psql -c "INSERT … RETURNING"` 输出多一行命令标签 | 整段 `Number()` 变 `NaN`，取号断言失真 | 改为只取首行 |
| 15 | `docker logs --since` 不接受 Go 时间字符串 | `invalid value for "since"` | 转 Unix 秒再传 |

### 已知限制（不隐瞒）

1. ~~**未在真实 Docker 中启动过。**~~ ✅ **已关闭** —— 三容器已在交付机真实拉起并全部
   `Up (healthy)`，`smoke-test.mjs` 55/55 全绿。原始证据、根因分析与复现命令见
   **`docs/VERIFY-PHASE-1.md`**。（本条原先记录的"本机 Docker daemon 不可用"已随
   WSL2 / 虚拟化平台修复而消除。）
2. **HTTPS 未启用。** `nginx/conf.d/ssl.conf` 待 Phase 10 证书就绪后启用；
   当前仅 HTTP 80。微信内置浏览器要求 HTTPS，**上线前必须完成**。
3. **短信全为 mock。** `SMS_PROVIDER=mock`、`SMS_ENABLED=false`，
   `SMS_PROVIDER=aliyun` 的适配器将在 Phase 4/8 实现。
4. **H5 目录为占位页**，Phase 3 产出真实 Vue3 应用。
5. **`NOCOBASE_EXTRACT_CLIENT_ASSETS=false`** 的性能取舍：
   后台静态资源由 nginx 反代到应用进程（多一跳），换取的是自维护 nginx 配置的
   可控性。Phase 10 压测后如成为瓶颈，可改为 `true` 并让 nginx 直接托管静态资源。
6. **`.env` 已在本机生成**（含真实随机密钥），已在 `.gitignore` 中；
   但请**不要**把该文件复制到聊天/邮件中。

---

## 【下一阶段】

**Phase 2 — 数据模型 / 权限 / 工单底座**

前置条件：Phase 1 的 11 张表已在真实 PostgreSQL 中建出，`/api/svc/health` 返回 `ok`。

| 交付项 | 内容 |
|---|---|
| ACL 角色与字段权限 | `store`（门店售后）/ `hq_staff`（总部售后）/ `hq_admin`（总部管理员）/ `viewer`（只读）；手机号默认脱敏（DEV-08） |
| `storeScope` 中间件 | 服务端强制门店隔离：从 URL/查询/请求体推导 `store_id` 的用户不可绕过的过滤条件 |
| `PermissionService` | 对象级鉴权：门店用户读写工单/Visit 前的归属校验（**不依赖前端隐藏菜单**） |
| 种子数据 | 15 家门店 + 门店↔用户映射 + 至少 1 个总部管理员 |
| `TicketService` | `create` / `accept` / `transfer` / `cancel`，全部走 `canTransition()` + 写 `ticketEvents` |
| `SequenceService` | `FW{YYYYMMDD}-{NNNN}` 原子取号（`dailySequences` 的 `UPDATE ... RETURNING`） |
| `EventService` / `ConfigService` | 事件唯一写入口；参数读取（带默认值与类型转换） |
| 后台页面 | 我的门店工单（状态 Tab）、全量工单、工单详情（含时间线区块） |
| 定向测试 | AT-03 门店隔离；并发 100 次取号无重复无空洞 |

**Phase 2 验收门槛**：AT-03 通过（门店 A 用户无法通过 URL/API 看到门店 B 的工单）；并发 100 次取号无重复、无空洞。

---

## 附：Phase 1 文件全清单（40 项）

```
.env.example                                                    6,613 B / 142 行
.gitignore                                                        853 B /  44 行
README.md                                                      10,031 B / 227 行
docker-compose.yml                                              5,561 B / 139 行
h5/dist/index.html                                              2,621 B /  52 行
nginx/nginx.conf                                                4,099 B /  94 行
nginx/conf.d/service.conf                                      11,983 B / 276 行
docs/DEVIATIONS.md                                             17,344 B / 148 行（改：+DEV-14~17）
docs/DATA-MODEL.md                                             16,954 B / 294 行（改：§11 改名 §13 结论）
docs/VERIFY-PHASE-1.md                                         15,199 B / 308 行（新增：真机验收报告）
docs/PHASE-1.md                                                88,227 B / 1844 行（本文件）
nocobase/plugins/service-ticket/package.json                      742 B /  27 行
nocobase/plugins/service-ticket/tsconfig.json                     571 B /  24 行
nocobase/plugins/service-ticket/src/server/index.ts               504 B /  15 行
nocobase/plugins/service-ticket/src/server/plugin.ts           13,995 B / 347 行（改：索引核对接线）
nocobase/plugins/service-ticket/src/server/constants.ts        13,490 B / 398 行
nocobase/plugins/service-ticket/src/server/ensure-indexes.ts   11,342 B / 253 行（新增：索引兜底补齐）
nocobase/plugins/service-ticket/src/server/actions/public/health.ts  5,826 B / 158 行
nocobase/plugins/service-ticket/src/server/collections/index.ts  1,927 B /  70 行
nocobase/plugins/service-ticket/src/server/collections/_helpers.ts   3,102 B / 108 行（改：defineAppCollection）
nocobase/plugins/service-ticket/src/server/collections/_options.ts   3,910 B / 120 行
nocobase/plugins/service-ticket/src/server/collections/stores.ts 1,454 B / 48 行
nocobase/plugins/service-ticket/src/server/collections/storeUsers.ts 1,115 B / 34 行
nocobase/plugins/service-ticket/src/server/collections/serviceSettings.ts 2,909 B / 72 行（原 systemSettings.ts）
nocobase/plugins/service-ticket/src/server/collections/serviceTickets.ts 6,446 B / 179 行
nocobase/plugins/service-ticket/src/server/collections/serviceVisits.ts  4,801 B / 125 行
nocobase/plugins/service-ticket/src/server/collections/serviceVisitPhotos.ts 2,402 B / 62 行
nocobase/plugins/service-ticket/src/server/collections/ticketEvents.ts   2,207 B / 53 行
nocobase/plugins/service-ticket/src/server/collections/smsLogs.ts        3,376 B / 96 行
nocobase/plugins/service-ticket/src/server/collections/dailySequences.ts 1,297 B / 41 行
nocobase/plugins/service-ticket/src/server/collections/apiGuards.ts      1,878 B / 49 行
nocobase/plugins/service-ticket/src/server/collections/idempotencyRecords.ts 1,729 B / 51 行
scripts/build-plugin.mjs                                      11,006 B / 315 行
scripts/gen-secret.mjs                                         7,273 B / 205 行
scripts/verify-config.mjs                                     25,242 B / 612 行
scripts/verify-plugin-load.mjs                                32,503 B / 770 行（改：+2 项索引声明守卫）
scripts/expected-indexes.mjs                                   6,571 B / 143 行（新增：索引验收清单）
scripts/smoke-test.mjs                                        35,507 B / 810 行（新增：真机端到端验收 55 项）
storage/plugins/@local/service-ticket/dist/server/index.js    62,503 B / 1572 行（构建产物，61.0 KB）
storage/plugins/@local/service-ticket/package.json               742 B（构建产物）
```
