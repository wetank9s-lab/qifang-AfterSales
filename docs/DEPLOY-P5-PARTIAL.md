# 腾讯云部署 P5：HTTPS 与受控 H5 路由接入报告（部分完成并停止）

> 日期：2026-10-22 · **P5-1 / P5-2：PASS** · **P5-3～P5-5：BLOCKED（两个前置缺失）**
> 未开放公网业务访问。未改其他站点。未 commit / push。

---

## 1. P5-1 实施前备份与健康基线：**PASS**

| 项 | 值 |
|---|---|
| Nginx prefix | `/www/server/nginx` |
| 主配置 | `/www/server/nginx/conf/nginx.conf` |
| vhost 目录 | `/www/server/panel/vhost/nginx/` |
| **`sh.scqfls.cn` 冲突** | **无**（grep 零命中） |
| **DNS** | `sh.scqfls.cn → 162.14.121.180`（A 记录，无 CNAME / AAAA） |
| 80/443 监听 | `0.0.0.0:80` / `0.0.0.0:443`（宝塔 nginx） |
| `nginx -t` | **successful** |
| 证书目录 | 4 套（`0.default` / `hd` / `kanma.cloud` / `kanma.cloud_80`）—— **无 sh** |
| 应用绑定 | **`127.0.0.1:13000`** |
| 运行态 | `ENV=production PROV=smsbao ENA=false DB=scqf_aftersales_candidate` |

**基线**：hd **200** / cloud **403** / sd **000** / kanma **000**

**备份**：`/opt/scqf-aftersales/nginx-backup/nginx-conf-pre-p5.tgz`（**85 K，268 个条目**）✅

---

## 2. P5-2 默认封闭 HTTP 入口：**PASS**

### 新增文件（唯一）

`/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`（**602 字节**）

```nginx
server {
    listen 80;
    server_name sh.scqfls.cn;

    location ^~ /.well-known/acme-challenge/ {
        root /www/wwwroot/sh.scqfls.cn;
        default_type text/plain;
        try_files $uri =404;
    }

    location / {
        default_type text/plain;
        return 503 "maintenance\n";
    }
}
```

**关于"`return 503` 不能放 server 级"**：我按你的要求把它放在 **`location /`** 里，ACME 用 **`location ^~`**（`^~` 优先于正则，且前缀匹配在 `location /` 之前）。**实测验证了匹配顺序**：

| 请求 | 结果 | 判定 |
|---|---|---|
| `http://sh.scqfls.cn/` | **503** | ✅ 维护态 |
| `http://sh.scqfls.cn/.well-known/acme-challenge/__probe__` | **404** | ✅ **ACME 未被 503 抢走** |
| `https://sh.scqfls.cn/` | **000** | ✅ 无 443 监听 |

**外部验证**：以上结果是从**我这台机器的真实公网**发出的（不是服务器本机 curl）。

### 回归

| 项 | 结果 |
|---|---|
| `nginx -t` | **successful**（仅既有 `conflicting server name "_"` 警告） |
| reload | **graceful**（`nginx -s reload`） |
| hd / cloud / sd / kanma | **200 / 403 / 000 / 000** —— 与基线**完全一致** |
| 80/443 监听 | 不变 |

---

## 3. P5-3 证书申请：**BLOCKED**

### 现状

| 检查 | 结果 |
|---|---|
| `certbot` | **无** |
| `acme.sh` | **无** |
| `/root/.acme.sh` | **不存在** |
| 宝塔 CLI | `/usr/bin/bt` 存在，但**是交互式菜单**（一跑就挂起，2 分钟后超时） |
| 宝塔证书路径 | 走 `/etc/letsencrypt/live/<siteName>`，**依赖面板"站点"概念** |

### 为什么卡住

宝塔的证书申请**要求先在面板里建站点**（站点在 `panelSite.py` 的站点库里）。而我只写了独立的 vhost 文件，**没有建"宝塔站点"**。

两条路：

| 路径 | 代价 | 风险 |
|---|---|---|
| **A. 走宝塔面板建站点 + 申请证书** | 需登录面板 API 或 UI | **会往宝塔站点库里写记录**，属于"改宝塔状态"，超出我当前授权范围 |
| **B. 装 acme.sh 独立申请** | 装一个标准工具 | 不改宝塔状态，但**要装新工具**（需授权） |

**我停在这里，没有装工具、没有建站点。**

### 影响

- **P5-4（HTTPS 白名单反代）依赖证书** ⇒ 一并阻塞
- **P5-5（路由映射）技术上可写进 80 的 vhost，但没有 HTTPS 就没有实际意义**，且你要求"证书申请成功不等于允许公网业务访问"

---

## 4. P5-4 白名单：**BLOCKED（缺你的出口 IP）**

你要求：

> 确认用户实际测试出口 IP 后，才加入白名单。
> 不得把当前公网 IP、服务器 IP 或任意大网段猜测为用户白名单。

**我没有你的出口 IP。**

我这边测到的是**我这台机器**的地址（`171.213.229.122`，还是运营商 NAT 地址，**不是稳定公网 IP**）。

**如果拿它当白名单，等于把访问权给了一台随时会换 IP 的机器，而且不是你。**

⇒ 按你的指令：**继续保持全站维护模式，不放开业务代理**。

---

## 5. P5-5 H5 路由映射：**未执行（依赖 HTTPS）**

映射规则已经查明（**没有凭猜测写 `?id=`**）：

| H5 路径 | 服务端 action | 参数 |
|---|---|---|
| `GET /api/public/store-entry` | `publicStore:entry` | 原样保留 `?k=<签名>` |
| `GET /api/public/media/files/<id>` | `publicMedia:file` | **`?id=<id>`** + 头 `X-Media-Session` |

**已从源码确认**：
- H5 用 `fetch('/api/public/media/files/' + mediaId, { headers: { 'X-Media-Session': token } })`
- 服务端 `publicMediaFile` 从 `ctx?.path.split('/').pop()` 或 query 取 id（两种都支持）
- `X-Media-Session` **必须原样透传**（不能丢头）
- 响应是**流式文件**（Range 由 `streamPrivateMedia` 负责）⇒ 映射要 `proxy_http_version 1.1` 且**不能缓冲改写**

**但因为 443 没有证书，这套映射写进去也无法验证**。按你的"不得取消公网限制才能完成验收"，我不做"只写不验"的动作。

---

## 6. MEDIA-SESSION-BOUND-01：仍 PENDING

**未做任何**：
- 修改 `customer_medias.session_id` ❌
- 延长历史客户会话 ❌
- 绕过 `readBound` ❌
- 让 Nginx 静态返回客户媒体 ❌

**P5 也没有把"路由接通"判成"媒体会话读取 PASS"** —— 因为路由根本没接通（§5）。

---

## 7. 生产配置核对（未变）

| 项 | 值 |
|---|---|
| `APP_ENV` | **production** |
| `SMS_PROVIDER` / `SMS_ENABLED` | `smsbao` / **false** |
| DB `sms.enabled` | **false** |
| 开发端点 | **未开放**（production profile，5 个全 404） |
| 匿名访问私有数据 | **401** |
| 真实用户 / 门店 ACL | **未修改** |

**未冒称 PASS 的项**：
- MEDIA-SESSION-BOUND-01：**PENDING**
- HQ / viewer 角色：**PENDING**
- `serviceTickets:list` 门店过滤：**PENDING**

---

## 8. 其他站点健康（每次改动后都查）

| 域名 | 基线 | 现在 |
|---|---|---|
| hd.scqfls.cn | 200 | **200** |
| cloud.scqfls.cn | 403 | **403** |
| sd.scqfls.cn | 000 | **000** |
| kanma.cloud | 000 | **000** |

`nginx -t` 每次都成功才 reload；**没有重启 Nginx、没有重启 Docker、没有动 MySQL**。

---

## 9. 备份与回滚

| 项 | 值 |
|---|---|
| Nginx 配置备份 | `nginx-conf-pre-p5.tgz`（85 K / 268 条目） |
| 本次新增文件 | **仅 1 个**：`sh.scqfls.cn.conf` |

**回滚（一条命令）**：
```bash
rm /www/server/panel/vhost/nginx/sh.scqfls.cn.conf
nginx -t && nginx -s reload
```

---

## 10. 需要你决定的三件事

| # | 事项 | 我的建议 |
|---|---|---|
| 1 | **证书怎么申请** | **装 acme.sh**（独立、不碰宝塔站点库）。若你坚持用宝塔，需要先在面板建"站点"，那会写宝塔库 |
| 2 | **你的出口 IP 是多少** | 给我一个（或几个）确定会用来测试的 IP，我加白名单；**不给就继续 503** |
| 3 | 是否接受"**先只做 80 维护态 + 证书，443 暂缓**" | 这是当前能安全推进的最大范围 |

---

## 11. 判定

| 项 | 结论 |
|---|---|
| P5-1 备份与基线 | **PASS** |
| P5-2 HTTP 默认封闭 | **PASS**（外部实测 503 / ACME 404） |
| P5-3 证书 | **BLOCKED**（无 ACME 工具 + 宝塔需建站点） |
| P5-4 白名单反代 | **BLOCKED**（缺你的出口 IP） |
| P5-5 路由映射 | **未执行**（依赖 443） |
| MEDIA-SESSION-BOUND-01 | **PENDING**（未动） |
| 其他站点 | **PASS**（全一致） |
| 公网业务访问 | **仍然完全关闭**（503） |

### 申请

**P5：部分完成 → 不给 PASS。** 等你在 §10 三件事上给方向。

**当前最安全的状态**：`sh.scqfls.cn` 对公网**返回 503**，ACME 路径可达，业务完全不可访问。**这个状态可以长期保持，不会有数据暴露风险。**

P6 / Release 继续 HOLD。
