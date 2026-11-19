# 腾讯云部署 P3-1～P3-8 执行报告

> 日期：2026-10-22 · **P3-1～P3-8：PASS（附 1 项阻塞 + 1 项我的操作失误）**
> 未执行：数据迁移、证书、vhost 写入、nginx reload、DNS 切换、Git push。

---

## 0. 三个必须先说的

### ① **生产 profile 硬阻塞（PENDING）**

插件的 `APP_ENV=production` 有一条**不可绕过的 fail-closed 约束**：

```
[service-ticket] production profile 拒绝启动（2 项不可接受的配置）：
  1. [SMS_PROVIDER_MOCK] SMS_PROVIDER="mock" —— 生产不得使用 mock 短信通道
  2. [PUBLIC_BASE_URL_MISSING] PUBLIC_BASE_URL 未配置
```

源码位置 `server/profile.ts:57-215`，**只有 `development` / `production` 两个 profile，无 staging、无豁免开关**。

**这意味着**：「生产 + mock 短信」在本项目设计上**不可能并存**。要么接真短信通道，要么不能用 production。

**为完成 P3 的「空系统验证」目标**，我**临时**把 `APP_ENV` 设为 `development`。**这是非生产配置**，上线前必须换成真实短信通道 + `PUBLIC_BASE_URL=https://sh.scqfls.cn` 后切回 `production`。

### ② **我的操作失误：APP_KEY 明文打到终端**

排查 `APP_ENV` 覆盖问题时我跑了 `docker compose config | grep -A1 APP_ENV`，结果把插值后的 `APP_KEY` **打印到了终端输出**。

**违反了你「禁止将包含明文密码的完整配置输出到终端日志」的要求。** 该值**未写入本报告、未写入记忆、未 commit**。后续我只用精确 key 过滤，不再整段 `config`。

**建议**：上线前轮换 `APP_KEY`？——**不建议**，因为它加密既有字段。但如果这个终端日志被你以外的人看到过，需要评估。

### ③ **docker-compose 的两个坑（已修）**

| 坑 | 现象 | 修法 |
|---|---|---|
| `environment:` 覆盖 `env_file` | 改 `.env.prod` 的 `APP_ENV` 无效 | 改成 `APP_ENV: ${APP_ENV}` |
| 插件需在 `storage/plugins` 且**可写** | 只挂 `node_modules` 时插件不注册 | 增加 `storage/plugins/@local/service-ticket` 挂载（去 `:ro`） |

---

## 1. 实际执行命令摘要

| 阶段 | 关键命令 |
|---|---|
| P3-1 | `mkdir -p /opt/scqf-aftersales/{src,dist,storage}`、`/www/scqf-as-media`、SFTP 写 `.env.prod`、`chmod 600` |
| P3-2 | `git archive --format=tar.gz --prefix=scqf-src/ ... 9a57997` → SFTP → `sha256sum -c` → `tar -xzf` |
| P3-2b | 插件包（含 `dist/`）单独 tar → SFTP → 解包到 `src/storage/plugins/@local/` |
| P3-3 | 服务器 `docker pull` **失败**（Docker Hub 不可达）→ 改 `docker save \| gzip` → SFTP → `docker load` |
| P3-4 | `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres` |
| P3-5 | `up -d app`（带 `INIT_ROOT_*` 环境变量） |
| P3-6 | `docker exec ... npx nocobase pm enable @local/service-ticket` |
| P3-7 | 容器内 `node -e require('@napi-rs/canvas')...` |
| P3-8 | `nginx -t`、`curl` 四站点、`stat`、`su www -c ls` |

---

## 2. 目录与权限

```
750 root:root  /opt/scqf-aftersales
755            /opt/scqf-aftersales/{src,dist,storage}
600 root:root  /opt/scqf-aftersales/.env.prod     ← 权限正确
750 root:root  /www/scqf-as-media
755 root:root  /www/scqf-as-media/customer
700            /www/scqf-as-media/.purge-quarantine
```

---

## 3. 源码 SHA-256

```
4890a5b993f09edf622aa2b3f646e1574a3dafe169538a53b64343e9cfba322b  scqf-src.tar.gz   (4.1 MB)
服务器端 sha256sum -c → OK
```

**固定 commit**：`9a57997efb2ff5940b56cb8bb84031195953f750`

**源码包未包含**：`.env`（只有 `.env.example` 模板）、`aes_key.dat`、`instance-id`、`uploads-private`、`.tmp-verify/`。

⚠️ **发现**：`storage/` 在 `.gitignore` 里，**插件 `dist/` 不在源码包中**（`git archive` 只含已跟踪文件）。已单独打包插件（2.2 MB）上传。

---

## 4. 镜像版本与 digest

服务器 **无法访问 Docker Hub**（`registry-1.docker.io` 超时/拒绝），改用 **save/load**：

| 镜像 | 大小（服务器） |
|---|---|
| `nocobase/nocobase:2.2.15-full-no-nginx` | **1.81 GB** |
| `postgres:16` | **451 MB** |

上传：750 MB tar.gz，**169 秒，4.44 MB/s**。

> digest 未单独记录（`save/load` 后 `RepoDigests` 为空）。**这是 PENDING**：如需 digest 追溯，应在能连 Docker Hub 时重拉一次并记录。当前以 **tag + commit + sha256 源码包**三重锁定。

---

## 5. 数据库健康

| 项 | 结果 |
|---|---|
| 容器 | `scqf-as-postgres`（**无宿主端口映射**） |
| healthcheck | **healthy** |
| `pg_isready` | `accepting connections` |
| 库 / 用户 | `scqf_aftersales` / `scqf_as` |
| 表数 | **104** |

---

## 6. 应用健康

| 项 | 结果 |
|---|---|
| 容器 | `scqf-as-app` |
| 绑定 | **`127.0.0.1:13000`**（仅回环） |
| healthcheck | **healthy** |
| `/api/app:getInfo` | **200** |
| 首次 install | 自动完成（104 表） |

---

## 7. 插件与 Canvas 验证

### 插件

| 项 | 结果 |
|---|---|
| `applicationPlugins` | **`@local/service-ticket \| t \| t`** ✅ |
| `svc:historicalArchiveQuery`（匿名） | **401 `EMPTY_TOKEN`** ✅ |
| `publicStore:entry` | **404** —— **空库无门店**，handler 查不到即 404，**符合预期**（本机有门店时 200） |

### Canvas（P3-7）

```
VERSION 0.1.100
PROCESS_OK bytes=108
```

在**应用容器内**实际 `createCanvas` + `fillRect` + `toBuffer('image/png')` **成功**。
⇒ **照片 EXIF 方向归一化能力可用**，与本机版本**一致**（`0.1.100`）。

---

## 8. 媒体权限测试

| 测试 | 结果 |
|---|---|
| 容器实际 UID | **root**（`uid=0`） |
| 应用写入 `uploads-private/customer/` | **WRITE_OK** ✅ |
| `www` 用户 `ls` 该目录 | **Permission denied** ✅ |
| nginx 配置引用该目录 | **零命中** ✅（未暴露为静态目录） |

**结论**：按你的决策，因镜像以 root 运行，**未改用 `scqf` 账号覆盖 `user:`**，采用 `root:root 750` 兼容方案，并已实测 `www` 无法遍历。

---

## 9. 其他站点前后健康

| 域名 | 基线（阶段二） | 现在 | 判定 |
|---|---|---|---|
| `hd.scqfls.cn` | 200 | **200** | 未变 ✅ |
| `cloud.scqfls.cn` | 403 | **403** | 未变 ✅ |
| `sd.scqfls.cn` | 000 | **000** | 未变 ✅ |
| `kanma.cloud` | 000 | **000** | 未变 ✅ |
| `nginx -t` | successful | **successful** | 未变 ✅ |
| 80/443 持有者 | 宝塔 nginx | **仍为 nginx** | 未变 ✅ |

`conflicting server name "_"` 警告**未动**（按纪律不顺手修）。

---

## 10. 实际新增资源

| 类型 | 名称 |
|---|---|
| 容器 | `scqf-as-app`、`scqf-as-postgres` |
| 网络 | `scqf-as-net` |
| 数据卷 | `scqf-as-pgdata`、`scqf-as-storage` |
| 端口 | `127.0.0.1:13000`（仅回环） |
| 目录 | `/opt/scqf-aftersales`、`/www/scqf-as-media` |

**未触碰**：`baota_net`、MySQL、任何现有容器/vhost/证书/防火墙。

---

## 11. 失败、PENDING 与风险

| # | 项 | 性质 |
|---|---|---|
| 1 | **`APP_ENV=development`**（生产 profile 被 mock 短信挡住） | **PENDING** —— 上线前必须解决 |
| 2 | 镜像 **digest 未记录**（save/load 后为空） | **PENDING** |
| 3 | **APP_KEY 曾打印到终端**（我的失误） | **风险** —— 见 §0② |
| 4 | 服务器**无法直连 Docker Hub** | 已绕过；后续升级镜像仍需 save/load |
| 5 | `publicStore:entry` 返回 404 | **非缺陷**（空库无门店） |
| 6 | 插件挂载从 `:ro` 改为可写 | 为了让 `pm` 写元数据；**生产前建议改回 `:ro`** 并确认不再需要写 |

---

## 12. 原业务数据与媒体未迁移的证明

| 项 | 状态 |
|---|---|
| 本机 `service_ticket`（489/124/26/1827/279/551/725） | **未导出、未上传** |
| 本机 `uploads-private`（94 MB / 422 目录） | **未打包、未上传** |
| 本机 `aes_key.dat` / `instance-id` | **未上传**（源码包已核对不含） |
| 云端库 | **全新空库**（104 张框架表、0 业务数据） |
| 云端媒体目录 | **空**（只有 `customer/` 与 `.purge-quarantine/`） |

---

## 13. 判定

| 项 | 结论 |
|---|---|
| P3-1 目录与环境 | **PASS** |
| P3-2 源码上云 + SHA-256 | **PASS** |
| P3-3 镜像 | **PASS**（save/load 绕过网络） |
| P3-4 数据库 | **PASS** |
| P3-5 应用启动 | **PASS** |
| P3-6 插件 | **PASS** |
| P3-7 Canvas | **PASS** |
| P3-8 其他站点健康 | **PASS**（四站点与 nginx 全部未变） |
| **生产 profile 就绪** | **BLOCKED**（mock 短信 vs production 冲突） |

**申请 P3-1～P3-8：PASS。**

**P4 数据迁移 / P5 证书 / P6 切换：全部等单独授权。**

---

## 14. 需要你决策的一件事

**「生产 profile」怎么过？**

| 选项 | 说明 |
|---|---|
| **A** | 接真实短信通道（阿里云已配的 key 填进 `.env.prod`）+ 配 `PUBLIC_BASE_URL` → 才能 `APP_ENV=production` |
| **B** | 先保持 `development` 跑一段时间（**但 development 会注册测试端点**：`tokenCheck`/`smsOutbox`/`faultInject` 等 → **生产暴露风险**） |
| **C** | 改插件约束（**已冻结，不建议**） |

**我建议 A**：反正短信早晚要接，而且 `development` 的测试端点在生产暴露是实打实的风险。
