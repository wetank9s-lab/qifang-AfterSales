# TECH-PHONE-404-01：师傅作业 API 路由热修报告

> 时间：2026-10-23 10:50–11:05 CST
> 结论：**主读取链路已修复（页面渲染出真实工单）**；
> 但浏览器 Network 又暴露**两条新 404**，成因是 **H5 与插件的版本漂移**，**不是 nginx 能修的**。

---

## 1. 根因与修复前对照

| 请求 | 修复前 |
|---|---|
| `GET /api/technician/visits/<TOKEN>`（**H5 实际调的**） | **404** `text/plain: Not Found` |
| `GET /api/technicianVisit:get?token=<TOKEN>`（内部 action） | **200** |

vhost 里当时**没有任何 `/api/technician/...` 转发** ⇒ 落到 `location /` → 反代到 NocoBase 不存在的资源 → 404。

---

## 2. 修改所在的 location 与最小 diff

**位置**：`location /`（唯一 `proxy_pass http://127.0.0.1:13000` 的块），插入在 `proxy_pass` **之前**。
（不是 server 块末尾 —— 那样不会进入 rewrite 阶段。）

```diff
  location / {
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/photos/([A-Za-z0-9_-]{22})$" /api/technicianVisit:photo?token=$1&ref=$2? break;
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/files$"                    /api/technicianVisit:upload?token=$1?       break;
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/submit$"                   /api/technicianVisit:submit?token=$1?       break;
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})$"                          /api/technicianVisit:get?token=$1?          break;
      proxy_pass http://127.0.0.1:13000;
```

**查询参数策略**：目标 URI 末尾的 `?` **抑制原始 query 追加** ——
防止 `?token=<伪造>` 被拼到 `?token=<真实>` 后面形成二义。实测"用伪造 token 作 query 覆盖"时，
**路径里的 Token 仍然胜出**（返回的是路径令牌对应的数据）。

**photo ref 真实格式**：源码 `PHOTO_REF_PATTERN = /^[A-Za-z0-9_-]{22}$/`
—— 我最初写成 `{1,64}`，**已收紧为 `{22}`**，与契约一致（未扩大匹配面）。

**未做**：不加 22 位兼容规则、不改 301/302、不动上传大小/超时/限流、不绕鉴权。

---

## 3. nginx -t 与 reload

| 步骤 | 结果 |
|---|---|
| 备份 | `backup/tech-api-route-01-<时间>/vhost.conf`，**12,277 B / 600**（另有 `-ref22.conf`、`-media.conf` 两次中间备份） |
| `nginx -t` | **successful** |
| `nginx -s reload` | **rc=0**（仅既有 `conflicting server name "_"` 警告） |
| Docker daemon / NocoBase / PG | **未重启** |

---

## 4. H5 实际 GET 链路（真实浏览器，390×844）

```json
PAGE: { "title": "服务报修 · 家电门店售后服务平台", "has404": false }
API:  [{ "u": "/api/technician/visits/<T>", "st": 200 }]
```

页面正文（真实渲染）：

```
上门作业 / 峨眉诚信电器 / 工单号 FW20261022-0007 / 预计上门 2026-10-24
问题描述：坏了修不好了
客户提交的材料：客户录音 · 0:05
现场服务照片（必填，1～3 张） 0/3
```

⇒ **不是只看接口 200**：页面把工单号、门店、描述、材料清单都渲染出来了。

**业务字段一致性**：`/api/technician/visits/<T>` 与 `/api/technicianVisit:get?token=<T>`
返回同一单（`ticket_no` 均为 `FW20261022-0007`）。

---

## 5. 🔴 但 Network 里还有两条 404（新缺陷，非 nginx 可修）

```
/api/technician/visits/<T>/media/iOxjDD40-VorwuvjC45P89   → 404
/api/technician/visits/<T>/media/zilsfCfIQmhHpoCiA5HCrV   → 404
```

- 这是**客户材料预览**（录音/照片）的取流地址；
- 部署的插件只有 **4 个 action**：`get` / `photo` / `upload` / `submit` —— **没有 `media`，也没有 `deletePhoto`**；
- 直接调 `technicianVisit:photo?token=…&ref=<这两个 ref>` → 也是 **404**
  （`:photo` 的 ref 由「师傅照片 id + 本 Visit tokenHash」派生，**客户媒体不是同一套 ref**）；
- 另有 `/photos/<ref>/delete`（POST）同样无对应 action。

⇒ **H5 比插件新，存在版本漂移**：页面按新契约调用，服务端还是旧契约。
**这不是路由能补的**，需要对齐插件产物版本（或补这两个 action）。

**影响**：师傅能打开页面、看到工单信息，但**看不到客户材料、也删不掉照片**。

---

## 6. 负面与回归

| 用例 | 结果 |
|---|---|
| 43 位合法 | **200** |
| 42 位（非法长度） | **404** ✅ |
| 伪造 43 位 | **401**（`TOKEN_INVALID`）✅ |
| 附加 `?token=<伪造>` 覆盖 | 路径 Token 仍胜出 ✅ |
| 跳转循环 | 无（`/t/` 302 单跳）✅ |
| `/p/<22>` | 302 ✅ |
| `/t/<43>` | 302 ✅ |
| `/h5/report`、`/api/public/stores`、`/admin` | 200 / 200 / 200 ✅ |
| 四站点 | hd 200 / cloud 403 / sd 000 / kanma 000（基线）✅ |

---

## 7. Token 日志泄漏检查

```
sh.scqfls.cn.log   token 命中 = 0
nginx_error.log    token 命中 = 0
```

本站 access_log 本就关闭（此前为防 Token 入日志），本次 rewrite 未新增落盘。
（只报命中数，未打印任何明文。）

---

## 8. 回滚依据

```bash
BK=/opt/scqf-aftersales/backup/tech-api-route-01-<时间>
cp -p $BK/vhost.conf /www/server/panel/vhost/nginx/sh.scqfls.cn.conf
/usr/bin/nginx -t && /usr/bin/nginx -s reload
```

---

## 9. 生产纪律

| 项 | 状态 |
|---|---|
| 真实上传 / 提交 / 照片删除 | **0** |
| 测试工单 / 短信 / DB 写入 | 0 / 0 / 0 |
| 插件源码 / Token 生成器 / 校验器 / H5 / 状态机 | **未改** |
| 报告中的 Token | 一律 `<TOKEN>` / `<T>` |
| Git | **未 commit / 未 push** |

---

## 10. 申请

- **TECH-PHONE-404-01（读取入口）：PASS** ——
  H5 实际 GET 链路 200 + 真实浏览器渲染出正确工单，两者都有。
- **`files` / `submit` 真实 POST：PENDING** —— 无隔离师傅单，本轮明确不向生产写入。
- **客户材料预览（`/media/<ref>`）与照片删除（`/photos/<ref>/delete`）：PENDING，且为新缺陷** ——
  需插件与 H5 版本对齐后才有 action 可映射。
- **真机浏览器验收：PENDING**（无设备，只有桌面 Chromium 的移动视口）。

> 上一轮我写"业务 API 通过"时说得过满，本轮已用**页面自身发的请求**重新验证并更正。

P6：LIVE / CONDITIONAL；Release：HOLD。
