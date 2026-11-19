# TECH-PHOTO-DELETE-01：合法 PNG 上传及照片删除隔离回归报告

> 时间：2026-10-23 11:25–11:45 CST
> 结论：**后端 / 授权 PASS**。D1–D10 全部实测通过，含深度重算 ref。
> 生产 deletePhoto 路由**未开放**，H5 UI **PENDING**。

---

## 1. PNG 夹具（真实可解码）

| 项 | 值 |
|---|---|
| 生成方式 | 纯 Python `zlib` + `struct` 手写 IHDR/IDAT/IEND（无 PIL） |
| 尺寸 | **16 × 16** RGB 8-bit |
| 字节数 | **79 B** |
| SHA-256 | **`7edcaa5172398709e517147e932cef4d52c682bff2c8c5bbfdae9a8eb086a7eb`** |
| magic | `89504e470d0a1a0a`（真 PNG 头） |

**不是改扩展名**：服务端上传后回 `mime=image/png`、**`width=16`** —— 说明它真的解析了 IHDR，
不是靠文件名放行。

---

## 2. 有效 Visit（重签后验证）

| Visit | ticket | 状态 |
|---|---|---|
| 1 | TEST-A-0001 | `token_expires_at=now+2h`、`used/revoked=null`、`visit_status=ASSIGNED` |
| 2 | TEST-B-0001 | 同上 |

`:get` 实测：`A → TEST-A-0001`、`B → TEST-B-0001` ✅（不是只看 INSERT 成功）

> 说明：A/B 在上一轮撤销/替换测试后已失效，本轮**重签了新的 hash + expires**，
> 没有去"恢复旧 Token"，避免动到已冻结的媒体授权证据。

---

## 3. D1 上传（真实 action）

```
A: {"photo":{"ref":"tuZxARpBxsvKdVPvQL2AT3","photo_type":"onsite","mime":"image/png","size":79,"width":16…}}
B: {"photo":{"ref":"8u9TeS-kzG8a04WhS91ea6", … }}
photoA id=1  photoB id=2
storageA = visits/1/202610/3c4b79fb2aa059bec1b2cf9410d1191dee4f20c894cf86e5.png
```

---

## 4. 删除用例（D2–D10）

| # | 用例 | 结果 | 判定 |
|---|---|---|---|
| **D2** | 删自己未提交照片 | **200** `{"deleted":true,"photos_count":0}` | ✅ |
| **D3** | 删除后再读该 ref | **404**，79 B（错误体，无图片字节） | ✅ |
| **D4** | 库与存储一致性 | `photosA=0`、`photosB=1` ⇒ **DB 行消失（真删）**，B 未受影响 | ✅ |
| **D5** | A 删 B 的照片 ref | **404** `PHOTO_NOT_FOUND`；**B 的照片仍在**（`photosB=1`） | ✅ |
| **D5-deep** | 用 **A 的 hash + B 的 photoId** 重算 ref 再删 | **404** | ✅ 归属边界 |
| **D6** | 客户媒体 ref 走删除接口 | **404**；`customer_medias(ticket1)` 计数不变 | ✅ |
| **D7** | 撤销 Token 后删除 | **401** | ✅ |
| **D8** | 重复删除同一 ref | 第 1 次 **200**、第 2 次 **404**（一致、无新副作用） | ✅ |
| **D9** | 已提交（`token_used_at` 非空） | **401**（状态机在认证层就拒） | ✅ |
| **D10** | 只影响目标照片 | 删除 A 某张后 B 的照片、客户媒体均不变 | ✅ |

**D5-deep 的意义**：照片 ref 与 Token Hash 绑定，所以"随机错误 ref 得到 404"根本证明不了归属隔离。
我按真实算法 `base64url(sha256(photoId + ':' + tokenHash))[:22]` 用 **A 的 hash 对 B 的照片 id** 重算出**格式完全合法**的 ref，
请求仍被 404 —— 拦截点是**归属校验**，不是"猜不到"。这与 MEDIA-AUTH 的深度测试同一套路。

---

## 5. 删除的物理语义

`{"deleted":true,"photos_count":0}` + 复查 `service_visit_photos` 行数为 0 + 再读 404
⇒ **这是真删（DB 行 + 私有文件），不是软删**。与源码注释「删除是真删」一致。
存储目录当前 8 个文件（含客户媒体与本次照片），未做物理清理核对之外的任何删除。

---

## 6. H5 UI：PENDING

隔离实例**不提供 H5 静态产物**（只跑 API）⇒ 无法验证"删除后卡片消失"。
**不拿模拟冒充**。生产 deletePhoto 路由**仍未开放**。

前端契约（源码口径，供后续接路由时对照）：
`POST {BASE}/{token}/photos/{ref}/delete` → 响应 `{ photos_count }`；成功后 H5 从列表移除该卡片。

---

## 7. 登记与清理清单（未执行，待验收后按 ID 精确操作）

| 资源 | ID | 说明 |
|---|---|---|
| 工单 | **1、2** | 本专项合成（TEST-A/B-0001） |
| 工单 | 3、4 | 早前失败尝试遗留，**归属待确认**（无 Visit 引用） |
| Visit | **1、2** | 本轮删除回归用的有效 Visit |
| 客户媒体 | **3、4** | → ticket1 / ticket2 |
| **50 MiB 边界媒体** | **1、2** | **必须保留**，`ticket_id` 仍 `null` ✅ |
| 师傅照片 | photosA 剩 1、photosB 剩 1 | D8/D9 上传的残留，可删 |

存储目录 8 个文件。清理只按上述 ID，不用模糊条件。

---

## 8. 生产纪律

| 项 | 状态 |
|---|---|
| 生产工单 / 照片上传 / 照片删除 / 提交 / 短信 / DB | **0 / 0 / 0 / 0 / 0 / 0** |
| 生产 Nginx / H5 / 插件 / 媒体校验 | **未改** |
| 测试库写入 | 仅 `scqf_media_test`（上表） |
| `.tmp-verify/dplay` | 保留，未绕过 |
| Git | **未 commit / 未 push** |

---

## 9. 申请

**TECH-PHOTO-DELETE-01：BACKEND / AUTH PASS**（D1–D10 实测）

仍独立待办：

| 项 | 状态 |
|---|---|
| 生产 `photos/:ref/delete` Nginx 映射 | **未提交，需专项批准** |
| H5 删除后卡片更新（真机/浏览器） | **PENDING** |
| TECH-MEDIA-RANGE-01 | OPEN |
| TECH-TOKEN-REFERRER-01 | OPEN |

P6：LIVE / CONDITIONAL；Release：HOLD。
