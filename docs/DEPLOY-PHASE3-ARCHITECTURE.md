# 腾讯云部署 第三阶段：正式部署架构与执行计划

> 日期：2026-10-22 · **仅方案编制，未执行任何服务器修改**
> 六项决策已按批准内容固化；本文件不含任何口令、Token、密钥明文。

---

## 1. 架构总览

```
                        ┌─────────────────────────────────────────┐
                        │  宝塔 nginx（既有，root 776，80/443）      │
                        │  仅新增 vhost: sh.scqfls.cn.conf          │
                        └───────────────┬─────────────────────────┘
                                        │ proxy_pass 127.0.0.1:13000
                                        ▼
   ┌────────────────────────────────────────────────────────────────┐
   │ Docker Compose 项目：scqf-aftersales-prod                        │
   │  网络：scqf-as-net（bridge，internal 无关，不接 baota_net）        │
   │                                                                 │
   │  ┌──────────────────┐      ┌──────────────────────────────┐    │
   │  │ scqf-as-app      │─────▶│ scqf-as-postgres             │    │
   │  │ nocobase 2.2.15  │ 5432 │ postgres:16（**不映射宿主端口**）│    │
   │  │ 127.0.0.1:13000  │      └──────────┬───────────────────┘    │
   │  └────────┬─────────┘                 │                         │
   │           │                           ▼                         │
   │           │                    volume: scqf-as-pgdata           │
   │           ▼                                                     │
   │  volume: scqf-as-storage → /opt/scqf-aftersales/storage          │
   │           │                                                     │
   │           └── uploads-private/ ──▶ bind: /www/scqf-as-media      │
   └────────────────────────────────────────────────────────────────┘
```

**与现有项目的隔离边界**

| 维度 | 隔离方式 |
|---|---|
| 容器 | 本项目专属名（`scqf-as-*`），不碰 `baota_net` 上的任何容器 |
| 网络 | 自建 `scqf-as-net`，**不与 baota_net 互联** |
| 数据卷 | `scqf-as-pgdata` / `scqf-as-storage`（**新建，不复用**） |
| 数据库 | 容器化 **PostgreSQL 16**，与既有 **MySQL 完全无关** |
| 媒体 | `/www/scqf-as-media`（**在 wwwroot 之外**） |
| Nginx | **只新增 1 个 vhost 文件**，不改主配置、不动其他 server block |
| 防火墙 | **零改动**（应用只绑 127.0.0.1） |
| Docker daemon | **不重启、不 prune** |

---

## 2. 目录规划

| 路径 | 用途 | 权限 |
|---|---|---|
| `/opt/scqf-aftersales/` | 代码 + compose + env | `root:root 750` |
| `/opt/scqf-aftersales/src/` | 源码（固定 commit 解包） | `root:root 750` |
| `/opt/scqf-aftersales/storage/` | NocoBase storage（卷挂载点） | `root:root 750` |
| `/opt/scqf-aftersales/storage/plugins/@local/service-ticket/` | 插件（含 dist） | `root:root 755` |
| `/opt/scqf-aftersales/.env.prod` | 生产环境变量 | **`root:root 600`** |
| `/www/scqf-as-media/` | **私有媒体根** | `root:root 750`，**www 组不可读** |
| `/www/scqf-as-media/customer/<ticketId>/` | 媒体文件（按工单分目录） | `root:root 750` |
| `/www/scqf-as-media/.purge-quarantine/` | 清理暂存区 | `root:root 700` |

⚠️ **`/www/scqf-as-media` 绝不放进任何 nginx `root`/`alias`**；媒体只能经应用接口 + Token 读取。

---

## 3. 端口与容器表

| 容器 | 镜像 | 端口绑定 | 说明 |
|---|---|---|---|
| `scqf-as-app` | `nocobase/nocobase:2.2.15-full-no-nginx` | **`127.0.0.1:13000:13000`** | 仅回环 |
| `scqf-as-postgres` | `postgres:16` | **无宿主映射** | 仅 `scqf-as-net` 内 5432 |

| Compose 项目 | 网络 | 卷 |
|---|---|---|
| `scqf-aftersales-prod` | `scqf-as-net` | `scqf-as-pgdata`、`scqf-as-storage` |

**端口核对**：13000 在服务器实测 **FREE**（阶段二已确认）。

---

## 4. Compose 草案（**不执行，仅评审**）

```yaml
# /opt/scqf-aftersales/docker-compose.prod.yml
name: scqf-aftersales-prod

services:
  postgres:
    image: postgres:16
    container_name: scqf-as-postgres
    restart: always
    environment:
      POSTGRES_DB: ${DB_DATABASE}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      TZ: Asia/Shanghai
    volumes:
      - scqf-as-pgdata:/var/lib/postgresql/data
    networks: [scqf-as-net]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_DATABASE}"]
      interval: 10s
      timeout: 5s
      retries: 10
    # 无 ports：绝不映射到宿主

  app:
    image: nocobase/nocobase:2.2.15-full-no-nginx
    container_name: scqf-as-app
    restart: always
    depends_on:
      postgres: { condition: service_healthy }
    env_file: .env.prod
    environment:
      APP_PORT: 13000
      DB_DATABASE: ${DB_DATABASE}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
      DB_HOST: postgres
      DB_PORT: 5432
      APP_ENV: production
      LOGGER_LEVEL: info
      LOGGER_FORMAT: json
      SMS_PROVIDER: mock
      SMS_ENABLED: "false"
    ports:
      - "127.0.0.1:13000:13000"
    volumes:
      - scqf-as-storage:/app/nocobase/storage
      - /www/scqf-as-media:/app/nocobase/storage/uploads-private
      - ./src/storage/plugins/@local/service-ticket:/app/nocobase/node_modules/@local/service-ticket:ro
    networks: [scqf-as-net]
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:13000/api/app:getInfo || exit 1"]
      interval: 20s
      timeout: 8s
      retries: 15
      start_period: 180s

networks:
  scqf-as-net:
    name: scqf-as-net
    driver: bridge

volumes:
  scqf-as-pgdata:
    name: scqf-as-pgdata
  scqf-as-storage:
    name: scqf-as-storage
```

**说明**：
- `uploads-private` 用 **bind mount** 覆盖到卷内子目录 —— 媒体落在 `/www/scqf-as-media`，与库卷分离，便于单独备份/迁移。
- 插件**只读挂载**（`:ro`），运行时不可改。

---

## 5. 源码包与构建

### 5.1 打包（本机执行，**不 push**）

```bash
cd /c/Users/Administrator/WorkBuddy/2026-09-20-15-28-58
git archive --format=tar.gz --prefix=scqf-src/ \
    -o /tmp/scqf-src-9a57997.tar.gz 9a57997efb2ff5940b56cb8bb84031195953f750
sha256sum /tmp/scqf-src-9a57997.tar.gz > /tmp/scqf-src-9a57997.sha256
```

**固定 commit**：`9a57997efb2ff5940b56cb8bb84031195953f750`（== `origin/main`）

### 5.2 传输

```bash
scp /tmp/scqf-src-9a57997.tar.gz /tmp/scqf-src-9a57997.sha256 root@162.14.121.180:/opt/scqf-aftersales/dist/
```

**加密**：SSH 本身加密（走 22 端口，已验证可达）。

### 5.3 校验与解包（服务器）

```bash
cd /opt/scqf-aftersales/dist
sha256sum -c scqf-src-9a57997.sha256      # 必须 OK
tar -xzf scqf-src-9a57997.tar.gz -C /opt/scqf-aftersales/
```

### 5.4 镜像构建

**本项目无 Dockerfile**（阶段一已核实），直接用官方镜像：

| 镜像 | 版本 | 说明 |
|---|---|---|
| `nocobase/nocobase` | **2.2.15-full-no-nginx** | **与本机完全一致** |
| `postgres` | **16** | 与本机 PG 16.15 同大版本 |

**镜像 digest 需在拉取后记录**（`docker image inspect --format '{{.RepoDigests}}'`）。

### 5.5 一个必须验证的点

插件 peer 依赖 **`@napi-rs/canvas`**（照片 EXIF 方向归一化），但 **dist 里没有 `.node`**（8.7 MB 纯 JS）——它由**宿主镜像自带**。

⇒ 云端首次启动后**必须验证** `@napi-rs/canvas` 在镜像内可用（版本可能与本机 `0.1.100` 不同）。若不可用，照片方向归一化会降级——**这是验收项之一，不能跳过**。

---

## 6. 环境变量与密钥策略

| 变量 | 策略 |
|---|---|
| **`SIGN_SECRET`** | **保持原值**（已印二维码依赖） |
| **`APP_KEY`** | **保持原值**（既有加密字段依赖） |
| **`AES_KEY`**（`storage/apps/main/aes_key.dat`） | **保持原值** —— 它是**文件而非环境变量**，必须**从本机一并迁移**（见 §7.3） |
| **`DB_PASSWORD`** | **重新生成**（32 位随机，仅存 `.env.prod` chmod 600） |
| **`DB_USER` / `DB_DATABASE`** | 建议 `scqf_as` / `service_ticket`（保持库名一致，减少迁移差异） |
| `SMS_PROVIDER` / `SMS_ENABLED` | **`mock` / `false`** |
| `ALIYUN_SMS_*` | **不配**（等单独授权） |
| `SMOKE_ADMIN_*` | **不带入** |
| `APP_ENV` | **`production`**（注意：会启用生产约束，mock 短信是被允许的） |

**`.env.prod` 生成方式**：服务器上用 `openssl rand -base64 24` 现场生成 `DB_PASSWORD`，**不经过任何日志**。

---

## 7. 数据迁移方案（**本次不执行**）

### 7.1 数据库

```bash
# 本机
docker exec svc-postgres pg_dump -U svc_app -Fc -d service_ticket > /tmp/svc-$(date +%Y%m%d).dump
```

**版本兼容**：两端均 PG **16**（本机 16.15）→ 同大版本，`pg_dump -Fc` 可直接 `pg_restore`。

**恢复演练**：先在云端**临时库** `service_ticket_rehearsal` 恢复一次，核对通过后**drop 临时库**，再恢复到正式库。

### 7.2 私有媒体

```bash
tar -czf /tmp/scqf-media.tar.gz -C storage uploads-private
```

**必须校验**：`customer_medias.storage_key` 与文件路径一一对应（计划脚本：逐行取 `storage_key`，`test -f` 校验，统计缺失/多余）。

### 7.3 `aes_key.dat`

`storage/apps/main/aes_key.dat` 是 **AES 主密钥文件**（不在 `.env` 里）。

**必须迁移**，否则既有加密字段（含客户手机号等）**无法解密**。

```bash
# 本机
tar -czf /tmp/scqf-appkeys.tar.gz -C storage apps/main/aes_key.dat .license/instance-id
```

### 7.4 迁移后核验（**不能只比总数**）

| 校验项 | 期望 |
|---|---|
| `service_tickets` | 489 |
| `historical_service_archives` | 124 |
| `historical_ticket_conversions` | 26 |
| `ticket_events` | 1827 |
| `service_visits` | 279 |
| `customer_medias` | 551 |
| `customer_media_sessions` | 725 |
| 媒体目录数 | 422 |
| 媒体体积 | ≈ 94 MB |
| **`storage_key` 逐条对应** | **100% 命中，无缺失无多余** |
| 抽样解密 | 随机 5 条手机号可正常读出（验证 `aes_key.dat`） |
| 历史转单关联 | `conversions.ticket_id` 全部能在 `service_tickets` 找到 |

---

## 8. NocoBase 首次安装与管理员设置

**采用用户本人交互设置，不落任何明文**：

1. 容器启动后，`nocobase install` 由镜像入口自动执行（空库）。
2. 通过 **HTTPS 站点页面**（有证书后）或 **SSH 端口转发** `ssh -L 13000:127.0.0.1:13000` 打开首次安装向导。
3. **由你本人在浏览器里输入 admin 邮箱与口令**。
4. 设置完成后立即 `chmod 600 .env.prod` 并确认日志无口令输出。

⚠️ 若走 SSH 隧道设置，隧道只在你自己电脑与本机之间，**不经过任何第三方**。

---

## 9. Nginx vhost 模板（**不写入，仅 `/tmp` 语法检查**）

```nginx
# /www/server/panel/vhost/nginx/sh.scqfls.cn.conf（未来）
server {
    listen 80;
    server_name sh.scqfls.cn;
    # 证书验证路径
    location /.well-known/acme-challenge/ { root /www/wwwroot/sh.scqfls.cn; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name sh.scqfls.cn;

    ssl_certificate     /www/server/panel/vhost/cert/sh.scqfls.cn/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/sh.scqfls.cn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 20m;          # 媒体上传
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;

    location / {
        proxy_pass http://127.0.0.1:13000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

**注意**：
- **不配 `/uploads-private` 静态目录**（媒体必须走应用鉴权）。
- 不写 `root`/`alias` 指向 `/www/scqf-as-media`。
- 该文件**独立**，不影响 `nginx.conf` 与其他 vhost。

**语法检查流程（已获批准）**：
1. `nginx -t`（现有配置，只读）
2. 将模板写入 `/tmp/sh.scqfls.cn.conf.test`，用 `nginx -t -c` 指向一个**临时合并配置**（仅当不会影响运行中配置时）
3. 完成后**删除临时文件**
4. **不 reload、不 restart**

---

## 10. 执行阶段与验收证据

| 阶段 | 动作 | 验收证据 |
|---|---|---|
| **P3-1 目录与环境** | 建 `/opt/scqf-aftersales`、`/www/scqf-as-media`、`.env.prod` | `ls -la` 输出（权限位）、`stat` |
| **P3-2 源码上云** | scp + sha256 校验 + 解包 | `sha256sum -c` 输出 **OK** |
| **P3-3 镜像拉取** | pull 两个镜像 | `docker images` + **digest** |
| **P3-4 起库** | 只起 postgres | `pg_isready` 通过、`docker ps` 只多 1 个容器 |
| **P3-5 起应用** | 起 app | `/api/app:getInfo` 200、日志无 fatal |
| **P3-6 插件验证** | 确认插件启用、路由可达 | `applicationPlugins.enabled=t`、`publicStore:entry` 200、`historicalArchiveQuery` 401 |
| **P3-7 canvas 验证** | `@napi-rs/canvas` 可用性 | 容器内 require 成功 |
| **P3-8 现有项目未受影响** | `nginx -t` + 4 个既有域名探测 | `hd` 仍 200、`cloud` 仍 403、80/443 监听进程不变 |
| **P3-9 vhost 语法** | `/tmp` 模板检查 + 删除临时文件 | 检查输出 + `ls /tmp` 确认已删 |
| **（待授权）P4 数据迁移** | §7 全套 | §7.4 核验表 |
| **（待授权）P5 证书** | 宝塔申请 | 证书链校验 |
| **（待授权）P6 切流** | DNS/流量 | 浏览器实测 + 回滚预案就绪 |

---

## 11. 停止条件（遇到即停）

| # | 条件 |
|---|---|
| 1 | 13000 端口被占用 |
| 2 | 任何现有容器/站点出现异常 |
| 3 | `nginx -t` **失败**（说明模板有问题，不能 reload） |
| 4 | `sha256sum -c` 不通过 |
| 5 | 插件在云端无法启用 |
| 6 | `@napi-rs/canvas` 不可用且影响照片方向 |
| 7 | 数据库恢复后行数与基线不符且原因不明 |
| 8 | `storage_key` 与文件不能 100% 对应 |
| 9 | 出现任何真实短信/通知发送 |
| 10 | 需要重启 Docker daemon 或清理全局资源 |

---

## 12. 回滚方案

| 层面 | 回滚动作 |
|---|---|
| **应用** | `docker compose -p scqf-aftersales-prod down`（**保留卷**，不 `-v`） |
| **数据库** | 卷 `scqf-as-pgdata` 保留；如需重来，先 `pg_dump` 备份再 drop |
| **媒体** | `/www/scqf-as-media` 原样保留 |
| **Nginx** | 删除 `sh.scqfls.cn.conf` → `nginx -t` → 平滑 reload（**仅在已授权阶段**） |
| **DNS** | 指回原机（TTL 600，10 分钟生效） |
| **原机** | **全程保持运行**，不删容器/库/媒体，直到云端稳定运行满回滚窗口 |

**回滚不涉及任何数据清空或覆盖。**

---

## 13. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| 1 | `@napi-rs/canvas` 版本差异影响照片方向 | P3-7 专项验证 |
| 2 | `aes_key.dat` 漏迁 → 加密字段不可解 | §7.3 显式纳入迁移清单 + §7.4 抽样解密校验 |
| 3 | 宝塔 nginx 的 `conflicting server name "_"` 既有警告 | **不动它**；新增 vhost 用独立 `server_name` |
| 4 | 上传体积（20m）不足 | 按实际媒体上限调整，先测 |
| 5 | 内存 5.4G 可用，PG + 应用峰值 | 观察；必要时调 PG `shared_buffers` |
| 6 | 现有 `sd.scqfls.cn` / `kanma.cloud` 的 000 状态 | **既有问题，基线已记录**，不归因于本次 |

---

## 14. 待你审批的 3 件事

| # | 事项 |
|---|---|
| 1 | **`DB_DATABASE` 是否沿用 `service_ticket`** 库名？（沿用可减少迁移差异，但生产库名可另起如 `scqf_aftersales`） |
| 2 | **是否先做 P3-1~P3-8（不含数据迁移）**，把空系统跑起来验收，再申请数据迁移？ |
| 3 | **`/www/scqf-as-media` 的目录属主**：`root:root 750` 还是建一个 `scqf` 系统用户？ |

**本阶段只出方案，未执行任何修改。等你审批。**
