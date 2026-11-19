# 腾讯云售后系统正式公网部署与 P5/P6 验收报告

> 日期：2026-10-22 · **P5：PASS（受保护/正式 HTTPS 接入）** · **P6：GO-LIVE（附 3 项 PENDING）**
> 未 commit / push。

---

## 1. 证书安装与续期 reloadcmd

| 项 | 值 |
|---|---|
| 证书源（acme.sh） | `/opt/acme-data/sh.scqfls.cn_ecc/` |
| **部署路径（固定）** | `/opt/scqf-aftersales/certs/fullchain.pem`（644） |
| **私钥** | `/opt/scqf-aftersales/certs/privkey.pem`（**600 root**） |
| 部署方式 | **`acme.sh --install-cert`**（不是手工 cp） |
| subject / SAN | `CN = sh.scqfls.cn` / `DNS:sh.scqfls.cn` |
| 有效期 | 2026-10-22 → **2027-01-20** |

### reloadcmd

```
/usr/bin/nginx -t >/opt/scqf-aftersales/certs/reload.log 2>&1 \
  && /usr/bin/nginx -s reload >>/opt/scqf-aftersales/certs/reload.log 2>&1
```

- **nginx 路径已实测确认**：`/usr/bin/nginx`（`command -v nginx` + `-x` 验证）
- **先 `-t` 再 reload**：配置不过就不 reload
- 日志 `/opt/scqf-aftersales/certs/reload.log`（**600**）
- **实测触发过一次**：`Running reload cmd: ...` → **`Reload successful`** ✅
- 未重启 Nginx 服务（用 `-s reload`）

---

## 2. 443 vhost

**路径**：`/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`（**100 行**，唯一改动文件）

| 项 | 配置 |
|---|---|
| 80 | ACME `^~` 放行 + 其余 **301 → https** |
| 443 | `ssl` + `http2`，TLS **1.2/1.3**，证书引用固定路径 |
| `client_max_body_size` | **8m**（与后端 `CUSTOMER_MEDIA.MAX_FILE_BYTES` 一致） |
| 上传 location | `= /api/public/media/upload`，`proxy_read_timeout 120s`、`request_buffering off` |
| 反代目标 | **`127.0.0.1:13000`** |
| 代理头 | `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto` |
| **IP allow/deny** | **无**（按授权取消白名单） |
| `root`/`alias` 指向私有媒体 | **无**（已验证：nginx 配置里 `scqf-as-media` 命中 **0**） |

**备份**：
- `nginx-conf-pre-p5.tgz`（85 K / 268 条目，保留）
- `sh.scqfls.cn.conf.pre-p54`（P5-2 版本 602 B）

---

## 3. H5 路由映射清单

**来源**：照搬本机 `nginx/conf.d/service.conf` 里**生产验证过**的 rewrite（不猜参数）。

| # | H5 路径 | → 服务端 action | 状态 |
|---|---|---|---|
| 1 | `GET /api/public/stores` | `publicStore:list` | 已映射 |
| 2 | `POST /api/public/tickets` | `publicTicket:create` | 已映射 |
| 3 | **`GET /api/public/store-entry`** | **`publicStore:entry`**（保留 `?k=`） | **已验 200** |
| 4 | `POST /api/public/media/session` | `publicMedia:session` | 已映射 |
| 5 | `POST /api/public/media/upload` | `publicMedia:upload` | 已映射（独立 location，120s） |
| 6 | **`GET /api/public/media/files/<id>`** | **`publicMedia:file/<id>`** | **已验 401/404** |
| 7 | `GET /api/public/progress/<43>` | `publicProgress:get/<token>` | 已映射 |
| 8 | `GET /api/public/reviews/<43>` | `publicReview:get/<token>` | 已映射 |
| 9 | `GET /api/publicUiTheme:get` | 已是 action 形式，直通 | 无需映射 |

### 一个踩到的坑（值得记）

第一次写 vhost 时 `nginx -t` 报 **`directive "rewrite" is not terminated by ";"`**。

根因：**nginx 把正则里的 `{43}` 当作块起始符**。本机原文是 `rewrite "^...([A-Za-z0-9_-]{43})$" ...`（**有引号**），我漏了引号。

⇒ **含 `{}` 的正则必须加引号**。

而 `if ($request_method = GET) { rewrite ... }` 那种写法也踩了同样的坑，最后改成**不用 `if`**，reviews 单独一个 `location ^~`。

**两次失败都自动回滚了**（vhost 恢复 → `nginx -t` successful），没有把坏配置留在线上。

---

## 4. 公网浏览器实测（**从我这台机器的真实公网**）

| 检查 | 结果 |
|---|---|
| **`https://sh.scqfls.cn/`** | **200**，**`ssl_verify=0`（证书校验通过，无警告）** |
| `http://sh.scqfls.cn/` | **301** → `https://sh.scqfls.cn/` |
| SAN 与域名一致 | ✅ `DNS:sh.scqfls.cn` |
| **门店入口（合法 k）** | **200**，返回 `{"code":"S01","name":"新都圣大家电",...}` |
| **门店入口（无效 k）** | **404** |
| **门店入口（无 k）** | **404** |
| **媒体（无 session）** | **401** |
| **媒体（伪造 session）** | **404** |

---

## 5. 匿名访问与认证边界

| 检查 | 结果 |
|---|---|
| `svc:historicalArchiveQuery`（匿名） | **401** |
| `serviceTickets:list`（匿名） | **401** |
| 开发端点 ×5（匿名 POST） | **404 / 404 / 404 / 404 / 404** |

**取消 IP 白名单 ≠ 匿名可读业务数据** —— 认证仍在应用层。

---

## 6. 媒体鉴权与已知限制

| 项 | 状态 |
|---|---|
| 媒体文件 | **610 个**（`/www/scqf-as-media`） |
| **nginx 是否直出媒体** | **否**（配置里 `scqf-as-media` 命中 0） |
| 无 session | **401** |
| 伪造 session | **404** |
| **MEDIA-SESSION-BOUND-01** | **仍 PENDING** |

**没有**改 `customer_medias.session_id`、没有续期真实客户会话、没有绕过 `readBound`。

---

## 7. 门店列表过滤与角色权限（**覆盖缺口如实保留**）

| 项 | 状态 |
|---|---|
| S04 跨店反例（P4-B 已验） | ✅ 读档案 0、伪造 storeCode 0、列表 `No permissions`、转单 403 |
| **门店列表过滤（N 条 vs 489）** | **PENDING** |
| **HQ 角色独立反例** | **PENDING** |
| **viewer 角色独立反例** | **PENDING** |

**本轮没有用 admin 冒充门店用户，也没有为了"全绿"去改 ACL。**

---

## 8. 短信

| 项 | 值 |
|---|---|
| `APP_ENV` | **production** |
| `SMS_PROVIDER` | **smsbao**（**无凭据**） |
| `SMS_ENABLED` | **false** |
| DB `sms.enabled` | **false** |
| `sms_logs` | **783 → 783（0 新增）** |
| 最近短信 | 2026-10-19 |

### ⚠️ 上线报告必须明确

**短信通知暂不可用**（`SMS_ENABLED=false` + 无凭据）。

**不得宣传"短信发送已通过验收"。**

**业务不受影响**：短信被设计为"发送失败不影响业务"（`deliverOne` 记 rejected 但不阻断派工/建单）。

---

## 9. 数据完整性

| 表 | 值 | 基线 |
|---|---|---|
| `service_tickets` | **489** | 489 ✅ |
| `historical_service_archives` | **124** | 124 ✅ |
| `historical_ticket_conversions` | **26** | 26 ✅ |
| `ticket_events` | **1827** | 1827 ✅ |
| `service_visits` | **279** | 279 ✅ |
| `customer_medias` | **551** | 551 ✅ |
| `customer_media_sessions` | **725** | 725 ✅ |

**最近工单仍是 2026-10-19 18:09** —— **本次上线过程零业务写入**。

### DATA-STORE-ORPHAN-32

**原样保留**：28 条 `store_id=2` + 4 条 `store_id=NULL`。**未补建门店、未改归属。**

---

## 10. 四个原有站点

| 域名 | 结果 |
|---|---|
| `hd.scqfls.cn` | **200** |
| `cloud.scqfls.cn` | **403** |
| `sd.scqfls.cn` | **000**（既有） |
| `kanma.cloud` | **000**（既有） |

**每次改动后都查，全部与基线一致。** `nginx -t` 每次成功才 reload。**未重启 Nginx 服务、未动 MySQL/Docker daemon。**

Nginx 错误日志**无 sh.scqfls.cn 相关错误**。

---

## 11. 回滚能力与数据保全

### 回滚（只退 sh 的 vhost）

```bash
cp /opt/scqf-aftersales/nginx-backup/sh.scqfls.cn.conf.pre-p54 \
   /www/server/panel/vhost/nginx/sh.scqfls.cn.conf     # 或删掉该文件
nginx -t && nginx -s reload
```

### 数据保全（**关键**）

**如果正式开放后产生新工单/事件/媒体，不得直接恢复旧快照并丢弃增量。**

必须先：
1. `pg_dump` 当前 candidate（保留增量）
2. 再决定恢复策略
3. 新媒体文件单独打包

**不会**删除 candidate 库、不会覆盖真实客户媒体、不会删 AES 密钥或备份。

---

## 12. Git / 数据库 / 媒体状态

| 项 | 状态 |
|---|---|
| Git | 本地 `9a57997` == `origin/main`，**未 commit / 未 push** |
| 数据库 | `scqf_aftersales_candidate`（**运行中**）、`_rehearsal`（证据）、`scqf_aftersales`（空）**三者都在** |
| 媒体 | `/www/scqf-as-media` **610 文件** |
| 证书 | `/opt/scqf-aftersales/certs/`（私钥 600） |
| cron | **1 条**续期（每日 03:17） |

---

## 13. 仍然 PENDING 的事项（**不标 PASS**）

| # | 项 | 原因 |
|---|---|---|
| 1 | **MEDIA-SESSION-BOUND-01** | 需在隔离环境走「建会话→同会话传新合成媒体→同会话读」 |
| 2 | **门店列表过滤（N 条 vs 489）** | 缺门店账号口令；`No permissions` 不等于过滤通过 |
| 3 | **HQ / viewer 角色反例** | 缺口令，未猜未重置 |
| 4 | 镜像 `RepoDigests` | save/load 后为空（P3 遗留） |
| 5 | 续期 reloadcmd 的**端到端**验证 | 要到 2026-12-21 真正续期才能验；本轮只验了"手动触发 reloadcmd 成功" |
| 6 | 插件挂载仍可写 | 建议稳定后改 `:ro` |

---

## 14. 判定

| 项 | 结论 |
|---|---|
| 证书安装（固定路径、私钥 600） | **PASS** |
| reloadcmd（`-t` 前置、实测成功） | **PASS** |
| 443 vhost（TLS 1.2/1.3、无反代泄漏） | **PASS** |
| H5 路由映射（9 条，照搬生产规则） | **PASS** |
| 公网 HTTPS + 证书校验 | **PASS**（`ssl_verify=0`） |
| HTTP → HTTPS 跳转 | **PASS** |
| 门店入口（合法/无效/无签名） | **PASS**（200/404/404） |
| 媒体鉴权（无/伪造 session） | **PASS**（401/404） |
| 开发端点隔离 | **PASS**（5×404） |
| 匿名读私有数据 | **PASS**（401） |
| 四站点未受影响 | **PASS** |
| 数据零新增 | **PASS** |
| 短信禁用 | **PASS** |
| **媒体有效会话** | **PENDING** |
| **门店列表过滤 / HQ / viewer** | **PENDING** |

### 申请

**P5：PASS（HTTPS 与受控路由接入）**
**P6：GO-LIVE（正式公网已开放，附 3 项 PENDING）**

**三项 PENDING 不影响"能访问、能认证、媒体不泄漏"这三条底线**，但**不能宣称它们已验收**。

---

## 15. 三个必须说清的风险

| # | 风险 | 说明 |
|---|---|---|
| 1 | **短信不可用** | 真实通知发不出去。**不要对外宣传短信已通过验收** |
| 2 | **媒体正向读取未验** | 已知限制，文件完整但"有效会话读到 200"没证过 |
| 3 | **续期 reloadcmd 只验了一半** | 手动触发成功；**真正到期续期要等 12-21**，届时需确认 reload 是否真的执行 |
