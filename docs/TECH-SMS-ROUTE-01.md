# TECH-SMS-ROUTE-01：师傅短信短链路由修复报告

> 时间：2026-10-23 10:34–10:40 CST
> 结论：**/t/ 短链已修复并全部验收通过**。申请 **TECH-SMS-ROUTE-01：PASS / CLOSED**。
> 本次**未动** Token 长度、生成器、校验器、数据库、短信模板、插件代码。

---

## 1. 修复前的真实错误证据

```
/t/<43位合法Token>  →  200  <title>Loading...</title>
/t/not-a-token      →  200  <title>Loading...</title>
```

**两者都返回后台管理壳**，而短信模板 `LINK_PATH = '/t/'`（`constants.ts:1296`）用的正是这条路径
⇒ **师傅收到的短信链接会打开后台登录页**。

**根因**：nginx 的 location 列表里**没有 `/t/`**：

```
location ^~ /.well-known/…   location / (301→https)
location = /api/public/media/upload        location ^~ /api/public/reviews/
location ^~ /api/public/                   location = /h5
location ^~ /h5/  { location ~* ^/h5/assets/ }
location ~ ^/p/(22|43)$                    location /p/ (404)
location = /files/…/3.png                  location / (proxy → 13000)
```

`/t/xxx` 不匹配任何前缀 ⇒ 落到 `location /` ⇒ 被反代到管理应用 ⇒ 管理壳 `Loading...`。

---

## 2. Nginx 最小 diff（只加两段）

```diff
+    # TECH-SMS-ROUTE-01：师傅短信短链 /t/<token> → H5 作业页（302，禁 301）
+    location ~ "^/t/(?<svc_visit_token>[A-Za-z0-9_-]{43})$" {
+        return 302 /h5/technician/visit/$svc_visit_token;
+    }
+    location /t/ {
+        return 404;
+    }
+
     location / {
         proxy_pass http://127.0.0.1:13000;
```

**设计说明**：

- **只匹配 43 位**（当前正式发行格式），未放宽；
- `return 302` 用**相对路径** ⇒ 不跨域、不带额外鉴权参数、Token 原样保留；
- 第二段 `location /t/ { return 404; }` 专治"非法格式仍回退管理壳"；
  普通前缀 location **优先级低于正则 location**，所以两者共存不会互相吃掉
  —— 这与既有 `/p/` 的写法完全一致；
- 未触碰 `/h5/`、`/api/`、`/p/`、`/files/`、`/`，未扩大匹配范围。

---

## 3. 部署门禁

| 步骤 | 结果 |
|---|---|
| 备份 | `/opt/scqf-aftersales/backup/tech-sms-route-01-<时间>/vhost.conf`，**11,665 B，权限 600** |
| `nginx -t` | **syntax is ok / test is successful** |
| graceful reload | `nginx -s reload` → **rc=0**（仅既有 `conflicting server name "_"` 警告） |
| 容器 / daemon | **未重启**（NocoBase、PostgreSQL 全程未动） |

---

## 4. 上线后验收（逐条对应令 §五）

| # | 项 | 结果 |
|---|---|---|
| **A** | 合法 43 位 `/t/` 返回 302 | **302** ✅ |
| **B** | Location 同域、Token 完整一致 | `https://sh.scqfls.cn/h5/technician/visit/<TOKEN>`，**Token 原样** ✅ |
| **C** | 跳转后是师傅作业页，非 Loading 壳 | 跟随 → **200**，`<title>服务报修 · 家电门店售后服务平台</title>` ✅ |
| **D** | 有效凭据下业务 API 正常 | `technicianVisit:get?token=…` → **200**，返回 `FW20261022-0007` / 峨眉诚信电器 ✅ |
| **E** | 非法短链不进入后台壳 | `/t/not-a-token` → **404** ✅（改造前是 200 + Loading） |
| **F** | `/p/` 客户进度入口 | `/p/<22>` → **302** ✅ |
| **G** | `/h5/` 入口 | `/h5/report` → **200** ✅ |
| **H** | `/api/` 与后台 | `/api/public/stores` **200**、`/admin` **200** ✅ |
| **I** | 其它站点基线 | hd **200** / cloud **403** / sd **000** / kanma **000**（与会话基线一致）✅ |

> 不是只看"302 + 静态页 200"：**带了真实令牌调业务 API 拿到对应工单**，才判 C/D 通过。

---

## 5. 回滚依据

```bash
BK=/opt/scqf-aftersales/backup/tech-sms-route-01-<时间>
cp -p $BK/vhost.conf /www/server/panel/vhost/nginx/sh.scqfls.cn.conf
/usr/bin/nginx -t && /usr/bin/nginx -s reload
```

备份权限 **600**，且位于 `/opt/...`（不在仓库内、不入 Git）。

---

## 6. 生产纪律

| 项 | 状态 |
|---|---|
| 生产测试工单 | **0** |
| 短信发送 | **0** |
| 数据库写入 | **0** |
| 师傅作业修改 / 媒体上传 | **0 / 0** |
| Token 长度 / 生成器 / 校验器 / 模板 / 插件 | **未改** |
| Docker daemon | 未重启 |
| **完整有效 Token 写入报告** | **未写入**（报告内一律以 `<TOKEN>` 表示） |
| Git | **未 commit / 未 push** |

---

## 7. 结论与后续

- **TECH-SMS-ROUTE-01：PASS / CLOSED。**
- **本专项不代表 22 位 Token 已实现**。其后续方案（按令 §七，**顺序不可颠倒**）：
  1. 先让服务端**同时接受 43 与 22**（校验器双长度，仿 `PROGRESS_TOKEN.PATTERN_ANY`）；
  2. 再切换**签发**为 16 字节 / 22 位；
  3. **最后**才把 nginx 的 `/t/` 正则放宽到 `{22}(?:{21})?`。
  > 顺序反了会出现"新签发的 22 位 Token 被旧校验器 401 拒"——上一轮我已经撞到过这个墙。
- P6：LIVE / CONDITIONAL；Release：HOLD。
