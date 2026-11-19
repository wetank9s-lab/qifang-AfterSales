# TECH-PHOTO-DELETE-ROUTE-01：Nginx 最小映射及发布门禁报告

> 时间：2026-10-23 11:29–11:50 CST
> 结论：**最小映射已备好（未部署）**；但门禁 A 发现一个**必须先更正的事实**：
> **删除只删 DB 行，物理文件留在私有目录** ⇒ 存储只增不减。

---

## 0. 先更正我上一份报告的一处错误

上一份我写「删除是真删（DB 行 + 私有文件）」——**这是错的**。

实测（隔离实例）：D2 删掉的那张照片，其 `storage_key` 对应文件**仍存在**：

```
visits/1/202610/3c4b79fb2aa059bec1b2cf9410d1191dee4f20c894cf86e5.png → EXISTS
service_visit_photos 中该行 → 已不存在
```

⇒ **删除语义 = DB 硬删 + 文件未清理**。这不是"软删"，而是**孤儿文件**。

**影响**：
- 私有媒体目录**只增不减**（师傅删了照片，磁盘仍占着）；
- 若该文件路径被泄露/枚举，理论上仍可取（但 ref 已失效、且路径不含 token ⇒ 需存储层直读）；
- 门店审核侧"看不到但磁盘还在"，与源码注释里"避免师傅以为删了、门店仍看到"的**初衷部分相悖**——
  DB 层面确实不显示了，只是**磁盘没回收**。

**已登记**：`TECH-PHOTO-DELETE-STORAGE-01`（孤儿文件 / 存储泄漏），**本轮不改代码**。

---

## 1. 实际契约（只读核对）

| 项 | 实测 |
|---|---|
| H5 方法 | **POST** |
| H5 URL | `{BASE_PATH}/{token}/photos/{ref}/delete` |
| 请求体 | 无（仅 `Accept: application/json`） |
| action 名 | `technicianVisit:deletePhoto` |
| action 方法 | **POST**（NocoBase action 默认 POST） |
| token 格式 | **43 位** `[A-Za-z0-9_-]` |
| ref 格式 | **22 位** `[A-Za-z0-9_-]`（`PHOTO_REF_PATTERN`） |
| 成功响应 | `{"data":{"deleted":true,"photos_count":0}}`（隔离实测） |

**前后端方法一致（POST/POST）**，不需要也不允许通过 Nginx 转换方法。

---

## 2. 最小 Nginx diff（待批准，未部署）

插入位置：`location /`（唯一 `proxy_pass 127.0.0.1:13000` 的块），
**必须排在 `photos/:ref` 规则之前**（否则被短规则吃掉）：

```diff
  location / {
+     # TECH-PHOTO-DELETE-ROUTE-01：删照片 /photos/<ref>/delete（POST，长路径先匹配）
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/photos/([A-Za-z0-9_-]{22})/delete$" /api/technicianVisit:deletePhoto?token=$1&ref=$2? break;
      rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/media/([A-Za-z0-9_-]{22})$"         ...:media?token=$1&ref=$2?       break;
      rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/photos/([A-Za-z0-9_-]{22})$"        ...:photo?token=$1&ref=$2?       break;
      rewrite ".../files$"  ...:upload?token=$1? break;
      rewrite ".../submit$" ...:submit?token=$1? break;
      rewrite ".../([A-Za-z0-9_-]{43})$" ...:get?token=$1? break;
      proxy_pass http://127.0.0.1:13000;
```

**要点**：
- 内部 rewrite（**无 301/302**）、**方法原样透传**（POST 仍是 POST）；
- 末尾 `?` 抑制原 query；
- 只匹配 **43 位 token + 22 位 ref**；
- **不改**已有 get/photo/upload/submit/media 五条；
- 不开放任何通用媒体删除入口、不放宽图片类型/大小/鉴权。

**匹配顺序检查**（nginx 正则 location 内 rewrite 按书写顺序执行）：
`photos/:ref/delete` 在 `photos/:ref` 之前 ✅ —— 这一点**已按上轮踩过的坑**特意保证。

---

## 3. 门禁 A：物理存储验证 —— **不通过**

| 项 | 期望 | 实测 |
|---|---|---|
| 删除后 DB 行消失 | ✅ | ✅（`photos_count` 递减、行不存在） |
| 删除后物理文件消失 | ✅ | **❌ 仍 EXISTS** |
| 存储文件数随删除递减 | ✅ | **❌ 不递减**（目录 8 个文件，其中 ≥2 是已删行的孤儿） |

⇒ **按门禁要求，这一项不通过**，且**它不是路由问题，是 action 实现问题**。
**建议：先修存储清理，再谈开放生产路由** —— 否则生产一开放，师傅每删一张就多一个永久孤儿文件。

---

## 4. 门禁 B：路由方法验证 —— **PENDING**

隔离实例**没有 nginx**（直连 13010），无法验证"外部路径 → action"的方法透传。
方法探测只能确认：假 token 下 GET 与 POST **都是 401** ⇒ 鉴权先于方法。
⇒ **方法语义 PENDING**，需在部署后用真实路径验证（或给隔离实例加一层 nginx）。

---

## 5. 门禁 C：H5 卡片交互 —— **PENDING**

隔离实例无 H5 静态产物。**不拿模拟冒充**。
（若要补：把生产同版本 H5 产物挂到测试实例同源路径下，再测"上传 PNG → 卡片 → 点删除 → 卡片消失 → 刷新不复现"。）

---

## 6. 生产发布方案（仅方案，未执行）

| 步骤 | 内容 |
|---|---|
| 1 | 备份 `vhost.conf` 到 `/opt/scqf-aftersales/backup/photo-delete-route-<时间>/`，`chmod 600` |
| 2 | 应用 §2 的单行 diff |
| 3 | `nginx -t` 必须 `successful`，否则**立即还原** |
| 4 | `nginx -s reload`（graceful）；**不重启容器/daemon** |
| 5 | 只读回归：`/t/` 302、`/p/` 302、`/h5/report` 200、`/api/public/stores` 200、`/api/technician/visits/<T>` 200、`/admin` 200；**GET** `/photos/<ref>/delete` 应 401/404（非 200） |
| 6 | **禁止**在生产做真实删除测试（不得删真实师傅照片） |
| 7 | 回滚：还原备份 → `nginx -t` → reload |
| 8 | 日志检查：确认 token/ref 未进 access/error log（本站 access_log 已关） |

---

## 7. 遗留测试数据（未清理）

| 资源 | 实际 ID | 说明 |
|---|---|---|
| 工单 | 1、2（`TEST-A/B-0001`）；另有 2 条 id 不连续的合成单 | 3、4 查询为空 ⇒ **归属待列全表确认**，不按猜删 |
| Visit | 1（ticket1）、2（ticket2） | 本轮删除回归用 |
| 客户媒体 | 3→ticket1、4→ticket2 | 媒体授权证据 |
| **50 MiB 边界媒体** | **1、2** | **必须保留**（`ticket_id=null`） |
| 师傅照片 | id=**2**（visit2）、id=**4**（visit1） | 物理文件各一 |
| **孤儿文件** | `visits/1/202610/3c4b79fb….png` 等 ≥2 个 | 删除后残留，**证据价值**：证明存储不回收 |

存储目录共 8 个文件。

---

## 8. 生产纪律

| 项 | 状态 |
|---|---|
| 生产 Nginx / 上传 / 删除 / DB / H5 / 插件 | **全部未动** |
| 短信 / 容器重启 / daemon | 无 |
| 隔离写入 | 仅 `scqf_media_test` |
| Git | **未 commit / 未 push** |

---

## 9. 申请与建议

| 项 | 状态 |
|---|---|
| **TECH-PHOTO-DELETE-01** | BACKEND / AUTH PASS / CLOSED（按你裁决） |
| **TECH-PHOTO-DELETE-ROUTE-01** | **方案就绪，部署待裁决** |
| **TECH-PHOTO-DELETE-STORAGE-01** | **新登记：孤儿文件，门禁 A 未通过** |

**我的建议：先不要开生产删除路由。**
理由是门禁 A 明确未通过 —— 开放后每个师傅删除都会留一个永久孤儿文件，
等于把"存储只增不减"这个缺陷放大到生产。**建议顺序：先修存储清理（或明确接受留档语义并写进契约），再开路由。**

P6：LIVE / CONDITIONAL；Release：HOLD。
