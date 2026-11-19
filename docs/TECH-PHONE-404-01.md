# TECH-PHONE-404-01 真机 404 定位报告

> 时间：2026-10-23 10:44–10:56 CST
> 结论：**根因已定位（服务端实测确认）**：师傅页调用的 API 路径在生产 nginx **缺少 rewrite**，返回 404。
> 本轮**只定位，未部署**任何修改（按令 §六）。

---

## 1. 先说结论（一句话）

> **页面壳是 200 的，但页面自己发的 API 是 404。**
> H5 调 `/api/technician/visits/<token>`，而生产 nginx 没有这条转发；
> 内部真正存在的路由是 `/api/technicianVisit:get?token=…`。

---

## 2. 关键证据（同一枚令牌，两条路径）

| 请求 | 结果 |
|---|---|
| `GET /api/technician/visits/<TOKEN>`（**H5 实际调的**） | **404**，响应体是纯文本 `Not Found` |
| `GET /api/technicianVisit:get?token=<TOKEN>`（**内部真实路由**） | **200**，`{"data":{"ticket_no":"FW20261022-0007","store_name":"峨眉诚信电器",…}}` |

同一个 Token、同一台服务器、同一时刻 —— **差别只在 URL 形状**。

---

## 3. 404 发生在哪一层（对应令 §三 的 A~E）

| 层 | 判定 |
|---|---|
| A 请求没到 `/t/` | ❌ 排除（`/t/<43>` → 302 正常） |
| B 跳转后页面资源 404 | ❌ 排除（`/h5/index.html` 与深链返回的 HTML **完全一致**，资源是**绝对路径** `/h5/assets/…`） |
| C 前端路由显示 404 | ❌ 排除（H5 路由 `{8,256}` 接受 43 位） |
| **D 页面渲染成功，业务 API 404** | ✅ **就是这个** |
| E API 200 但页面显示 404 | ❌ 排除 |

**真正 404 的请求**：`GET /api/technician/visits/<TOKEN>` → `text/plain` 的 `Not Found`
（NocoBase 对不存在的资源返回的默认 404，不是 H5 自己的错误页）。

---

## 4. 为什么会有这个缺口（契约有、实现没有）

插件源码**自己写明了四条映射**（`actions/technician/visit.ts:6-9`）：

```
GET  /api/technician/visits/:token              → /api/technicianVisit:get?token=…
POST /api/technician/visits/:token/files        → /api/technicianVisit:upload?token=…
POST /api/technician/visits/:token/submit       → /api/technicianVisit:submit?token=…
GET  /api/technician/visits/:token/photos/:ref  → /api/technicianVisit:photo?token=…&ref=…
```

但**生产 vhost 里一条 `/api/technician/...` 的 rewrite 都没有**：

```
$ grep -n "technician" vhost.conf
141:  # 客户端路由（…/technician/visit/:t…）   ← 只是注释
213:  return 302 /h5/technician/visit/$svc_visit_token;   ← 我这轮加的页面路由
```

⇒ `/api/technician/visits/...` 落到 `location /` → 反代到 NocoBase → **资源不存在 → 404**。

---

## 5. 我需要更正上一轮的一个结论

`TECH-SMS-ROUTE-01` 里我写了"业务 API 200 通过" —— 那是我**手工调用内部路由**的结果，
**不是页面自己发出的请求**。页面发的那条是 404。

**当时那句话说得过满，现在更正：页面路由修好了，API 链路仍然是断的。**
（这也解释了为什么真机还是 404 —— 你看到的是页面加载成功后的接口失败。）

---

## 6. 手机端未复现（NOT REPRODUCED，如实标注）

我没有测试人员的真机，**没有在真实手机/微信内置浏览器上复现**。
但根因已在服务端用**同一枚合法令牌**实测确认（404 vs 200 的对照），
且这个缺口**对所有师傅链接都成立**，与设备型号、浏览器无关。

---

## 7. 最小修复方案（待批准，本轮未执行）

在 vhost 的 `/api/` 区域（`location ^~ /api/public/` 附近）加 4 条 rewrite，
风格与既有 `/p/` 一致、只匹配 43 位、**不改任何后端代码**：

```nginx
# TECH-PHONE-404-01：师傅作业接口（H5 调用形状 → 插件 action）
rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/photos/([A-Za-z0-9_-]{1,64})$" /api/technicianVisit:photo?token=$1&ref=$2 break;
rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/files$"  /api/technicianVisit:upload?token=$1 break;
rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/submit$" /api/technicianVisit:submit?token=$1 break;
rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})$"        /api/technicianVisit:get?token=$1    break;
```

- **顺序**：`photos` → `files` → `submit` → 裸 token（长路径先匹配，避免被通配吃掉）
- 只放行 43 位；非法形状继续 404（**不扩大匹配面**）
- 不动 backend 鉴权：`technicianVisit:*` 自己会校验 token 与状态
- 与上一轮 `/t/` 302 是**两层**：`/t/` 管"打开页面"，这四条管"页面取数"

**风险**：低（纯转发映射，无状态变更）；**回滚**：还原 vhost + `nginx -t` + reload。

---

## 8. 是否需要改代码

**不需要改代码。** 插件四条 action 已存在且工作正常，缺的只是 nginx 转发。

---

## 9. 生产纪律

| 项 | 状态 |
|---|---|
| 本轮部署 / 重载 | **无**（只读定位） |
| 测试工单 / 师傅提交 / 媒体上传 / 短信 / DB 写入 | **0 / 0 / 0 / 0 / 0** |
| Token 长度 / 生成器 / 校验器 | 未改 |
| 报告中的 Token | 一律 `<TOKEN>`，无完整值 |
| Git | **未 commit / 未 push** |

---

## 10. 申请

- **TECH-PHONE-404-01：根因已定位，修复待批准**（BLOCKED ON APPROVAL）。
- **不申请真机 PASS** —— 没有真机复现，只有服务端证据。
- 批准后我按"备份 → 改 vhost → `nginx -t` → graceful reload → 四条路径逐条验证（含 files/submit 的形状，不上传真实媒体）"执行。

> 注意：`files`/`submit` 的验证我只做**形状与鉴权层**（不带合法 multipart 提交、不改真实作业），
> 避免产生业务写入。

P6：LIVE / CONDITIONAL；Release：HOLD。
