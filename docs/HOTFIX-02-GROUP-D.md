# P6-HOTFIX-02 · D 组修复报告（A 组补证未开始）

> 时间：2026-10-22 16:32–16:38 CST
> 本轮：**只做 D 组**。A 组 Harness 补证**未开始**（见 §5）。
> 判定：**D 组 = 修复完成 + URL 层全绿；「登录后界面目视」PENDING**（原因见 §4，不是我偷懒）

---

## 1. 原始 403 根因

```
GET /files/main/main/attachments/3.png → 403
content-type: application/json
body: {"errors":[{"message":"No permissions"}]}
```

**不是文件丢失，也不是 nginx 拦截**：
- `location ^~ /files/` 把请求反代给应用；
- 应用对该路由要求**登录态**，匿名请求一律 `No permissions`；
- 而浏览器加载品牌图是**匿名**请求 ⇒ 403。

**物理文件真实存在**：

```
/var/lib/docker/volumes/scqf-as-storage/_data/uploads/logo-1h0nij.png
size 11186 · magic 89504e470d0a1a0a · PNG image data, 320 x 47, 8-bit/color RGBA
```

⇒ 身份核实：**真实 PNG、320×47、RGBA**，是品牌横版 Logo 的尺寸形态；内容为品牌图，
不含任何客户数据（不是客户上传件）。

---

## 2. 修复方式与最小 diff

**做法**：把核实过的 Logo 作为**独立只读公开静态副本**部署，再对**那一个精确 URL** 做 nginx 精确匹配。
不改应用鉴权、不放宽 `/files/`。

```bash
install -m 644 -o root -g root \
  /var/lib/docker/volumes/scqf-as-storage/_data/uploads/logo-1h0nij.png \
  /www/wwwroot/sh.scqfls.cn/brand/login-logo.png
```

```diff
+ // nginx（本站 vhost，插入在 `location /` 之前）
+ location = /files/main/main/attachments/3.png {
+     alias /www/wwwroot/sh.scqfls.cn/brand/login-logo.png;
+     default_type image/png;
+     add_header Cache-Control "public, max-age=3600" always;
+     add_header X-Content-Type-Options "nosniff" always;
+ }
```

**为什么用 `=`**：精确匹配优先级最高，压过 `^~ /files/`，**只影响这一个路径**。
`/files/` 下其它任何附件仍走应用鉴权。

---

## 3. 验收（真实公网）

| # | 项目 | 结果 |
|---|---|---|
| 1 | Logo URL 返回 200 | **200** ✅ |
| 2 | `Content-Type` | **`image/png`** ✅ |
| 3 | 内容是真实图片（非 SPA 壳） | magic `89504e470d0a1a0a`，**11186 B**，与源文件 **sha256 完全一致** ✅ |
| 4 | 登录页 DOM 引用 | **❌ 见 §4** |
| 5 | 其它私有附件匿名访问仍拒绝 | `attachments/2.png` → **403** ✅ |
| 6 | customerMedia 会话鉴权不变 | `/api/public/media/files/999999` → **401**、`/api/customerMedias:list` → **401** ✅ |
| 7 | 其它四站点基线 | hd **200** / cloud **403** / sd **000** / kanma **000** ✅ |

本站内：`/h5/report` 200、`/api/public/stores` 200、`/admin` 200。

---

## 4. 第 4 项为什么 PENDING（重要发现）

用浏览器渲染 `/admin` 并取 DOM（361 KB，标题 `Signin - 七方售后系统`）后检查：

```
引用 attachments/3.png : no
DOM 中含 "logo"        : False
```

**后台登录页根本不引用这张图。** 也就是说：

- 我修的是"**这个 URL 的匿名可访问性**"，它现在确实 200 且是真 PNG；
- 但**登录页并不显示它**，所以"登录页 Logo 显示"这条**无法通过改 URL 来证明**；
- 用户所说的"后台 Logo"更可能是**登录后**的界面（应用头部/系统设置里的 logo），
  那需要**管理员账号登录**才能目视 —— 我没有密码，也不该去动真实员工账号。

⇒ 这一条标 **PENDING**，需要你登录后台看一眼（或授权我拿到只读的管理员会话）。
**不把"URL 200"冒充成"界面已显示"。**

> 附带说明：`attachments/3.png.bak` 返回 500（应用内部错误），不是我这层泄露 ——
> 它仍走应用鉴权链路，且该文件不存在。

---

## 5. A 组 Harness 补证：未开始

本轮全部预算用于 D 组定位与实施。A 组的临时 Harness（编译并挂载 `Progress.vue` + 注入合成 DTO）
**没有做**，因此：

- 问题② 家电标签的 **UI 证据仍缺**；
- 空值安全仍只有**代码级**论证（`t.store?.` + try/catch）;
- A 组维持 **PARTIAL PASS**，不申请 FROZEN。

下一轮我会按你的批准搭建一次性 Harness（本地/隔离、不部署到生产 H5、不 commit）。

---

## 6. 回滚依据

| 备份 | 位置 |
|---|---|
| vhost | `/opt/scqf-aftersales/backup/vhost-pre-logo-<时间>.conf` |
| 公开副本 | `/www/wwwroot/sh.scqfls.cn/brand/login-logo.png`（删掉即可，不影响应用） |
| 应用/数据库 | **完全未改** |

回滚 = 还原 vhost + `nginx -t` + `nginx -s reload`。**不涉及数据库、不涉及容器。**

---

## 7. 判定

| 组 | 状态 |
|---|---|
| **D** | **修复完成**；URL 层 7 项中 **6 项 PASS**，登录后界面目视 **1 项 PENDING** → **D 组 PARTIAL PASS**，暂不申请整体 PASS |
| A | 维持 **PARTIAL PASS**（Harness 未做） |
| B / C / E | 未开始 |

未改短信、未改 ACL、未删数据、未重启 docker daemon、未 commit / 未 push。
P6：LIVE / CONDITIONAL；Release：HOLD。
