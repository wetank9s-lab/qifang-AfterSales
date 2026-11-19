# P4-B 最终签收与 P5 准备报告

> 日期：2026-10-22 · **P4-B：PASS WITH KNOWN LIMITATION**
> P5 未执行（仅方案）。P6 / Release HOLD。未 commit / push。

---

## 1. P4-B 签收结论

**P4-B：PASS WITH KNOWN LIMITATION**

这是**迁移与受控接管范围**的签收，**不代表所有媒体业务功能已通过完整正向验收**。

已确认：

| 项 | 状态 |
|---|---|
| 原始数据库恢复完整 | ✅ 129 表、405 索引、707 约束、52 序列 |
| 610 个媒体文件 SHA-256 | ✅ 全部一致 |
| 489 工单 / 124 档案 / 26 转换关联 | ✅ 完整 |
| 真实业务数据保持原值 | ✅ |
| 32 条孤儿工单未修改 | ✅ |
| 生产 Profile | ✅ production |
| DB `sms.enabled` | ✅ false |
| 未产生真实短信 | ✅ sms_logs 783→783 |
| S04 跨店拒绝 + storeCode 伪造反例 | ✅ 符合预期 |
| 合成用户与临时会话 | ✅ 已清理 |

---

## 2. 已知限制登记

### MEDIA-SESSION-BOUND-01（PENDING）

| 项 | 内容 |
|---|---|
| 编号 | **MEDIA-SESSION-BOUND-01** |
| 状态 | **PENDING**（不标 PASS） |
| 现象 | 新建媒体会话**无法访问**其他会话创建的旧媒体 |
| 根因 | `publicMediaFile` 用 `readBound(mediaId).sessionId` —— **只认媒体创建时绑定的那份会话** |
| 触发条件 | 历史媒体的会话已过期（最近 10-19 20:09）；新会话 `ticket_id=NULL`，第一步就对不上 |
| 已证 | 610 文件 SHA-256 全等；无头 401 / 伪造 404 / 不存在 401 |
| **未证** | **有效会话 → HTTP 200 + 正确字节** |

**裁决（已执行）**：**不通过修改旧 `customer_medias.session_id`、不延长真实客户会话、不绕过 `readBound`** 来制造一次成功读取。

**补证路径**（后续在隔离合成环境）：
```
建会话 → 用同一会话上传新合成媒体（自动绑定）→ 用同一会话读取 → 验 200 + 内容
```
**customer 与 visits 必须分别验**，不能假定一次 customer 成功就证明 visits。

### 权限覆盖缺口（PENDING）

| 角色 | 状态 |
|---|---|
| `store_after_sales`（S04） | ✅ 已验（读档案 0、伪造 storeCode 0、工单列表 `No permissions`、转单 403） |
| **HQ 角色** | **PENDING**（无源库口令） |
| **viewer 角色** | **PENDING**（无源库口令） |

**注意**：本次 `serviceTickets:list` 返回的是 **`No permissions`**（不是"列表为空"）。
⇒ **这不能当成"门店列表过滤测试通过"**，只是"该账号完全没有列表读权限"。
**真正的列表过滤（返回 N 条 vs 全部 489 条）仍未验证。**

---

## 3. 会话与账号清理核对（按 ID，非仅计数）

| 对象 | 结果 |
|---|---|
| **会话 736** | **查询为空**（已删除） |
| **会话 737** | **查询为空**（已删除） |
| `customer_media_sessions` 最大 id | **735**（= 源库最后一条，**无新残留**） |
| `customer_media_sessions` 计数 | **725**（= 快照值） |
| **账号 913**（users） | **0** |
| 913 的 rolesUsers | **0** |
| 913 的 store_users | **0** |
| 按邮箱 `%crosstest%` 查 | **0** |
| 原始 11 个账号 | **probe×3 / uat×5 / kl / hl / admin** —— 与源库一致，**未变** |

**Token 撤销**：两个会话行已物理删除，其 `session_token_hash` 一并消失 ⇒ **对应 token 无法再通过校验**（等同撤销）。

---

## 4. 敏感响应输出防护（我的两次失误与整改）

### 事实

| # | 时间 | 泄露内容 | 来源 |
|---|---|---|---|
| 1 | 10:51 | **`APP_KEY`** 明文 | `docker compose config \| grep -A1 APP_ENV` |
| 2 | 11:51 | **`session_token`** 明文 | `curl ... \| head -c 220` 打印响应体 |

两次都是"想看数据结构就顺手截取"。

### 处置

- 会话 736（token 已泄露）**立即删除**
- 报告 / 记忆 / Git 中**均无这两个值**
- `APP_KEY` **不轮换**（它是既有加密字段主密钥，轮换需全库重加密；泄露面是本机终端）

### 今后强制规则（已写入记忆）

| 禁止 | 替代做法 |
|---|---|
| 打印 API 完整响应体 | 只取**指定字段名**，用 `python -c` 解析后打印必要值 |
| `head -c` 截取未知响应 | 先 `python -c` 打印 `list(keys())`，确认结构后再取 |
| 输出完整 `docker compose config` | 只用 `grep '^KEYNAME='` 精确取需要的项 |
| 输出容器完整 env | 只 `echo $VAR1 $VAR2`（指定变量） |
| 输出 Authorization / Cookie / Token | 只输出 `len`、`exists`、`rejected?` |
| shell 调试模式（`set -x`） | 不用；或先 `set +x` 再碰敏感参数 |

**Token 只输出**：是否存在、长度、是否被拒绝。
**密钥只输出**：是否配置（不输出任何片段）。

---

## 5. 当前系统与备份状态

### 三个数据库（**都在，未删**）

| 库 | 用途 | 关键状态 |
|---|---|---|
| `scqf_aftersales` | 空系统 | `tickets=0` |
| `scqf_aftersales_rehearsal` | **不可变恢复证据** | `sms.enabled` 仍 `true`（原样保留） |
| **`scqf_aftersales_candidate`** | **应用当前连接** | 489/124/26/1827/783/11/725 |

### 备份（全部保留）

| 文件 | 位置 | 大小 |
|---|---|---|
| `svc-p4a.dump` | 本机 `.backup-prod/` + 云端 | 3.6 MB |
| `p4b-media.tgz` | 同上 | 85.1 MB |
| `p4b-keys.tgz` | 同上 | 794 B |
| `empty-snapshot.dump` | 云端 | 433 K |
| `rehearsal-immutable.dump` | 云端 | 3.6 MB |
| `cand-before-test.dump` | 云端 | 3.6 MB |
| `empty-media-backup.tgz` | 云端 | 180 B |
| `scqf-images.tar.gz` | 云端 | 751 MB |

### 运行态

```
ENV=production  PROV=smsbao  ENA=false  DB=scqf_aftersales_candidate
DB sms.enabled=false
app bound 127.0.0.1:13000
```

**未执行任何数据库清理或回滚。**

---

## 6. P5 前置条件（未执行，仅列条件）

| # | 前置 | 为什么必须先有 |
|---|---|---|
| 1 | **P4-B 签收** | ✅ 已完成 |
| 2 | **`publicStore:entry` / `publicMedia:file` 的 H5 路径映射方案** | 当前 `/api/public/media/files/<id>` 服务端**没有该 REST 路径**，需 nginx 映射；不映射则 H5 全线 404 |
| 3 | **访问白名单 / 维护模式设计** | `sh.scqfls.cn` 已解析到服务器，**新增 vhost 即刻公网可达**，真实客户数据可能立即暴露 |
| 4 | **证书申请方案** | 宝塔现有机制；需确认不改其他站点 |
| 5 | **回滚脚本** | 删除 vhost → `nginx -t` → 平滑 reload |
| 6 | **媒体端到端验证环境** | MEDIA-SESSION-BOUND-01 的补证要在隔离合成环境做，不能在 candidate 改真实数据 |

---

## 7. P5 执行方案（**仅供评审，未执行**）

### 7.1 vhost（独立文件，不动主配置）

`/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`

```nginx
server {
    listen 80;
    server_name sh.scqfls.cn;
    location /.well-known/acme-challenge/ { root /www/wwwroot/sh.scqfls.cn; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name sh.scqfls.cn;

    ssl_certificate     /www/server/panel/vhost/cert/sh.scqfls.cn/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/sh.scqfls.cn/privkey.pem;

    client_max_body_size 20m;
    proxy_read_timeout 120s;

    # 🔴 H5 路径映射（服务端没有这些 REST 路径，必须在此转）
    location = /api/public/media/files/ {
        # 保留 id，转到 action 形式
        rewrite ^/api/public/media/files/(.*)$ /api/publicMedia:file?id=$1 break;
        proxy_pass http://127.0.0.1:13000;
        include /www/server/nginx/conf/proxy_params;
    }
    location = /api/public/store-entry {
        rewrite ^/api/public/store-entry$ /api/publicStore:entry break;
        proxy_pass http://127.0.0.1:13000;
    }

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

**未配 `/uploads-private` 静态目录**（媒体必须走应用鉴权）。

### 7.2 公网暴露防护（**必做，先于 vhost 生效**）

`sh.scqfls.cn` 已解析到服务器 ⇒ **vhost 一加就公网可达**。

**三种可选隔离**（需你选一）：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. IP 白名单** | vhost 内 `allow <你的IP>; deny all;` | 简单、可验证 | 你换网络就失效 |
| **B. 维护模式** | 全站返回 503 + 仅 `/api/app:getInfo` 放行 | 完全不暴露业务 | H5 无法验证 |
| **C. Basic Auth** | `auth_basic` 挡住全站 | 可随时随地访问 | 需要一个账号口令 |

**我建议 A（白名单）**：既能做端到端验证，又不向公众暴露。

### 7.3 H5 端到端验证清单

| # | 项 |
|---|---|
| 1 | `https://sh.scqfls.cn/h5/report?k=S01.xxx` 打开 |
| 2 | `publicStore:entry` 映射生效（门店信息正确） |
| 3 | 上传 1 张合成图片 → 会话签发 → 上传成功 |
| 4 | **用同一会话读取该图** → **200 + 字节一致**（**这能同时解决 MEDIA-SESSION-BOUND-01**） |
| 5 | 录音/视频各 1 个（受控文件） |
| 6 | 匿名读他人媒体 → 拒绝 |
| 7 | 开发端点 → 404 |
| 8 | 其他站点（hd/cloud/sd/kanma）健康 |

### 7.4 回滚

```
rm /www/server/panel/vhost/nginx/sh.scqfls.cn.conf
nginx -t
nginx -s reload
# 验证四个既有站点仍正常
```

---

## 8. 其他已知限制

| # | 项 | 状态 |
|---|---|---|
| 1 | **MEDIA-SESSION-BOUND-01** | **PENDING** |
| 2 | HQ / viewer 角色反例 | **PENDING** |
| 3 | 门店列表过滤（返回 N 条 vs 489） | **PENDING**（`No permissions` 不等于过滤通过） |
| 4 | **DATA-STORE-ORPHAN-32** | 已登记，未改（32 条：28 条 store_id=2 + 4 条 NULL） |
| 5 | 镜像 `RepoDigests` | **PENDING**（save/load 后为空） |
| 6 | 插件挂载可写 | 建议稳定后改 `:ro` |
| 7 | H5 REST 路径映射 | **P5 范围**，未做 |
| 8 | **`sms.enabled` 双门禁** | 已确认：**DB 优先，env 仅在无行时生效**；任何恢复/切换后**必须查 DB** |

---

## 9. 判定

| 项 | 结论 |
|---|---|
| **P4-B** | **PASS WITH KNOWN LIMITATION** |
| **MEDIA-SESSION-BOUND-01** | **PENDING** |
| **HQ / viewer 权限覆盖** | **PENDING** |
| 会话 736/737 清理 | **PASS**（按 ID 查为空） |
| 合成账号 913 清理 | **PASS**（四表全 0） |
| 原始用户数据 | **PASS**（11 账号未变） |
| 数据库三层保护 | **PASS**（三个库都在） |
| 短信门禁 | **PASS** |
| 敏感输出防护规则 | **已建立**（见 §4） |
| P5 方案 | **已编制，未执行** |

**P5：尚未授权执行。P6：HOLD。Release：HOLD。**
