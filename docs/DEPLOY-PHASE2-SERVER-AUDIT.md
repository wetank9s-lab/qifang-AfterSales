# 腾讯云部署 第二阶段：服务器只读审计报告

> 日期：2026-10-22 · **第二阶段：PASS** · **域名冲突：无**
> 全程只读：未改任何配置、未停任何服务、未创建/删除任何资源。

---

## 1. SSH 登录身份与权限

| 项 | 值 |
|---|---|
| 用户 | **`root`**（uid=0，gid=0） |
| 认证方式 | 密码（本机 `id_ed25519` 未被服务器接受） |
| 目标 | `162.14.121.180:22` |

> 凭据未写入任何文件、报告或 Git。

---

## 2. 操作系统与资源容量

| 项 | 值 |
|---|---|
| 系统 | **OpenCloudOS 9.4** |
| 内核 | `6.6.119-47.8.oc9.x86_64` |
| CPU | **4 核** |
| 内存 | **7.5 GiB**（已用 2.2 GiB，可用 **5.4 GiB**） |
| 磁盘 | **180 GB**，已用 28 G，**可用 152 G（16%）** |
| Docker | **28.0.1** |
| Compose | **2.32.1** |
| 宝塔 | **11.8.0** |

**容量判断**：新增一套"应用 + PostgreSQL + 媒体存储"完全够用（预计占用 < 5 GB）。

---

## 3. Docker 现状

| 项 | 值 |
|---|---|
| daemon | **active** |
| **容器** | **0 个**（`docker ps -a` 为空） |
| **镜像** | **0 个** |
| **数据卷** | **0 个** |
| 网络 | `baota_net`（bridge）、`bridge`、`host`、`none` |
| Storage Driver | `overlay2` |
| Docker Root | `/var/lib/docker` |
| Compose 项目 | **0 个** |

**重要发现**：**服务器上没有任何 Docker 负载**。任务书说"正在运行其他项目"，实际是**宝塔直接跑的 PHP/MySQL 站点**，不涉及 Docker。

⇒ **Docker 侧零冲突**，本项目可独占容器/网络/卷命名空间。

---

## 4. 宝塔 / Nginx / 站点

| 项 | 值 |
|---|---|
| 宝塔目录 | `/www/server/panel` |
| 面板端口 | **28110** |
| Nginx | `/www/server/nginx/sbin/nginx`（root 776 起的 master + www 的 worker） |
| `nginx -t` | **syntax is ok / test is successful** |
| ⚠️ 既有警告 | `conflicting server name "_" on 0.0.0.0:80, ignored` —— **既有问题，非本次引入** |
| vhost 目录 | `/www/server/panel/vhost/nginx/` |

**已绑定域名**（`server_name` 汇总）：

```
_（×2）  127.0.0.1  cloud.scqfls.cn
hd.scqfls.cn hd1/hd2/hd3.scqfls.cn
sd.scqfls.cn
```

**站点目录**（`/www/wwwroot`）：

| 目录 | 文件数 |
|---|---|
| `default` | 0 |
| `fast-poster` | 6 |
| `hd.scqfls.cn` | 17 |
| `kanma` | 28 |
| `kanma_bak` | 2 |
| `kanma.cloud` | 25 |
| `sd.jiafei.net` | 18 |
| `sd.scqfls.cn` | 2 |

**证书**（`/www/server/panel/vhost/cert/`）：`0.default`、`hd.scqfls.cn`、`kanma.cloud`、`kanma.cloud_80` —— **共 4 套**。

---

## 5. `sh.scqfls.cn` 占用情况

| 检查 | 结果 |
|---|---|
| 站点目录 `/www/wwwroot/sh.scqfls.cn` | **不存在** |
| vhost 配置 `sh.scqfls.cn.conf` | **不存在** |
| `grep -rl "sh.scqfls.cn"` 全 vhost/conf | **零命中** |
| `server_name` 含 sh | **无** |
| 证书目录 `cert/sh.scqfls.cn` | **不存在** |
| **DNS 解析** | **`sh.scqfls.cn → 162.14.121.180`（TTL 600）** |

**结论：域名未被任何项目占用，且 DNS 已指向本机。**

> 这意味着现在访问 `https://sh.scqfls.cn` 会落到默认站点（无 vhost 匹配）。**这不影响其他项目**，但也不能直接上线——需要新建独立 vhost。

---

## 6. 端口占用与可用性

**已占用**（`ss -lnt`）：

```
22, 80, 443, 888（宝塔）, 28110（面板）, 20699, 28113, [::1]:25
```

80/443 均由**宝塔 nginx** 持有（多 worker 共享）。

**候选端口实测**：

| 端口 | 状态 |
|---|---|
| **13000** | **FREE** |
| **13001** | **FREE** |
| **15432** | **FREE** |
| 18080 | FREE |

**防火墙**（firewalld **active**）已开放：`20/21/22/80/443/888/3000/8080/8888/9317/28110/28113/39000-40000`。

⚠️ **不需要为项目开新端口**：应用只绑 `127.0.0.1`，由宝塔 nginx 反代进来，**不碰防火墙**。

---

## 7. 数据库现状

| 项 | 值 |
|---|---|
| **MySQL** | `/usr/bin/mysql`，**active**（宝塔装的，服务其他站点） |
| **PostgreSQL** | **inactive / 未安装** |

**结论**：本项目用**自带 PostgreSQL 16 容器**（与 MySQL 完全隔离），**不碰现有 MySQL**。

---

## 8. 现有项目健康基线（只读探测）

| 域名 | HTTPS 状态 |
|---|---|
| `hd.scqfls.cn` | **200** ✅ |
| `cloud.scqfls.cn` | 403（有访问控制，属正常） |
| `sd.scqfls.cn` | **000**（连不上 / 未配 HTTPS） |
| `kanma.cloud` | **000**（同上） |

> `sd.scqfls.cn` 与 `kanma.cloud` 的 000 **是既有状态，不是本次造成**。作为基线记录在此——将来若有人怀疑"是不是部署搞坏了"，可对照这条。

---

## 9. 是否可安全新增独立售后服务

**可以，风险很低。**

理由：

| 维度 | 判断 |
|---|---|
| Docker 资源 | **0 容器 0 镜像 0 卷** —— 零冲突 |
| 端口 | 13000/13001/15432 全空闲；且只在 `127.0.0.1` 绑定 |
| 磁盘 | 152 GB 可用 |
| 内存 | 5.4 GiB 可用（应用 + PG 预计 1.5~2 GB） |
| 数据库 | 用容器化 PG 16，与现有 MySQL 完全隔离 |
| 域名 | `sh` 未被占用 |
| Nginx | 只需**新增**一个 vhost 文件，不改主配置、不动其他站点 |
| 防火墙 | **不需要改动** |

---

## 10. 规划建议（待你审核后才执行）

### 命名

```
Compose 项目：scqf-aftersales-prod
容器：scqf-as-app / scqf-as-postgres
网络：scqf-as-net（独立 bridge，不接 baota_net）
卷：scqf-as-pgdata / scqf-as-storage
目录：/www/wwwroot/sh.scqfls.cn/（代码与 compose）
      /www/scqf-as-media/（私有媒体，绝不放进 wwwroot）
```

### 端口

| 服务 | 绑定 |
|---|---|
| 应用 | `127.0.0.1:13000` |
| PostgreSQL | **不映射宿主端口**（仅容器网络内 5432） |

> 复用 13000 与本机一致，便于对照；若不希望与应用端口混淆，可改 `127.0.0.1:13100`。**最终以审核结论为准。**

### 密钥策略

| 变量 | 处理 |
|---|---|
| `SIGN_SECRET` | **必须与迁移数据一致**（否则已印二维码全废） |
| `APP_KEY` | **先确认加密字段依赖**再定；默认**保持不变**（最安全） |
| `DB_PASSWORD` | **重新生成独立强口令**（容器内新库，不影响任何现有连接） |
| `SMS_PROVIDER` / `SMS_ENABLED` | 生产先保持 `mock` / `false` |
| `SMOKE_ADMIN_*` | 不带入生产 |

### Nginx

**只新增** `/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`，内容为：

```nginx
server {
  listen 80;
  server_name sh.scqfls.cn;
  # 仅 80→443 跳转 或 证书验证路径
}
server {
  listen 443 ssl http2;
  server_name sh.scqfls.cn;
  # 证书走宝塔申请
  client_max_body_size 20m;          # 媒体上传
  proxy_read_timeout 120s;
  location / {
    proxy_pass http://127.0.0.1:13000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

**不修改** `nginx.conf` 主文件、**不动**其他 vhost、reload 前先 `nginx -t`。

⚠️ **私有媒体**：`/uploads-private/**` 必须**继续走应用接口鉴权**，不得在 nginx 里配成静态目录。

### 证书

用宝塔现有机制为 `sh.scqfls.cn` 申请（DNS 已指向本机，HTTP-01 可过），**不影响其他站点证书**。

---

## 11. 迁移与回滚方案（草案）

**迁移**（需单独授权）：

1. 本机 `pg_dump -Fc` 全库 + `uploads-private` 打包 → **加密**传输
2. 云端新建空库 → `pg_restore`
3. 媒体解包到 `/www/scqf-as-media/uploads-private/`
4. 逐表核对：489/124/26/1827/279/551/725 + 媒体 422 目录 / 94 MB
5. 抽样校验 `storage_key` 与文件一一对应

**回滚**：

- DNS 指回原机（TTL 600，**10 分钟内生效**）
- 本机环境**保持运行不动**，直到云端稳定运行满回滚窗口
- 云端资源可随时 `docker compose down`（不移除卷）

---

## 12. 尚未确定 / 需你确认

| # | 事项 |
|---|---|
| 1 | **应用端口**：用 13000 还是另选（避免与本机混淆）？ |
| 2 | **`APP_KEY` 是否可保持不变**？（建议保持） |
| 3 | **代码部署方式**：git clone（需在服务器配 deploy key）还是 tar 上传？ |
| 4 | **媒体目录位置**：`/www/scqf-as-media` 是否可接受（在 wwwroot 之外）？ |
| 5 | **NocoBase 首次 install 的 admin 口令**由谁定？ |
| 6 | 是否允许我**先用只读方式**验证 nginx 模板语法（不 reload）？ |

---

## 13. 判定

| 项 | 结论 |
|---|---|
| **第二阶段审计** | **PASS** |
| **域名冲突** | **无**（`sh.scqfls.cn` 无任何站点/vhost/证书，DNS 已指向本机） |
| **是否具备进入部署架构设计阶段** | **具备** |
| 现有项目风险 | **低**（Docker 零负载、端口空闲、只新增一个 vhost） |

**等你在 §12 的 6 个问题上给方向后，再出正式部署方案。本轮未做任何修改。**
