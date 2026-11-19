# TECH-MEDIA-READ-ROUTE-01：客户媒体读取路由专项修复报告

> 时间：2026-10-23 11:01–11:15 CST
> 结论：**客户媒体读取已修好，浏览器里真实播出来了**。
> 申请 **TECH-MEDIA-READ-ROUTE-01：READ UI/FUNCTIONAL PASS**，**AUTH REGRESSION PENDING**。

---

## 1. 媒体读取授权链（源码证据）

`actions/technician/visit.ts` 的 `media` action：

```ts
const media = authed(TECHNICIAN_ACTION.MEDIA, async (ctx, auth) => {
  const ref = String(readParam(ctx, 'ref') ?? '').trim();
  if (!PHOTO_REF_PATTERN.test(ref)) { notFoundMedia(ctx); return; }   // ref 形态先校验
  const tokenHash = String(auth.visit.access_token_hash ?? '');
  const ticketId  = Number(auth.visit.ticket_id);
  const rows = await services.media.listForTicket(ticketId);           // ← 候选集 = 本工单
  const matched = rows.find(r => photoRefOf(Number(r.id), tokenHash) === ref);
  if (!matched) { notFoundMedia(ctx); return; }                        // 别单 ref 算不出 ⇒ 404
  const stored = await services.media.read(Number(matched.id));
  if (!stored) { notFoundMedia(ctx); return; }
  streamPrivateMedia(ctx, stored, { log: logger, label: '客户媒体' });  // 私有流式读取
});
```

逐条对应令 §二 的核查项：

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 强制验证有效师傅 Token | ✅ `authed()` 包裹 |
| 2 | 绑定当前有效 Visit | ✅ `auth.visit` |
| 3 | 验证媒体属本 Visit 的工单 | ✅ `listForTicket(visit.ticket_id)` |
| 4 | 拒绝撤销/替换凭据 | ✅ 由 `authed()` 统一处理（含已提交 `ALREADY_USED`） |
| 5 | 拒绝他单客户媒体 | ✅ 候选集不含 ⇒ 404（与"不存在"同响应，不构成存在性探测） |
| 6 | 不暴露存储目录 | ✅ 不生成静态 URL、不回显 mediaId / storage_key / 原文件名 |
| 7 | **ref 真实格式** | ✅ **`^[A-Za-z0-9_-]{22}$`**（`PHOTO_REF_PATTERN`）—— 客户媒体与师傅照片**同格式、不同候选集** |
| 8 | GET/HEAD 等方法 | `authed()` 为读取型 action；HEAD 未单独验证（PENDING） |

> 令里提醒"PHOTO_REF_PATTERN 属师傅照片、不能推断客户媒体也用同一规则" ——
> 我按你的要求**回代码取证**：客户媒体 ref 由 `photoRefOf(mediaId, tokenHash)` 生成，
> **确实复用同一 22 位模式**，所以映射用 `{22}` 是对的（不是推断）。

---

## 2. 最小 Nginx diff

位置：`location /`（唯一 `proxy_pass 127.0.0.1:13000` 的块）内，与既有 4 条并列：

```diff
+     # TECH-MEDIA-READ-ROUTE-01：客户材料读取 /media/<ref>（ref 22 位，候选集=本工单）
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/media/([A-Za-z0-9_-]{22})$" /api/technicianVisit:media?token=$1&ref=$2? break;
```

- 只放行 **43 位 token + 22 位 ref**；
- 末尾 `?` 抑制原始 query 覆盖；
- 内部 rewrite（**无浏览器可见 302**）、保留方法、不动全局 `proxy_pass`/限流/上传大小；
- **未改**既有 4 条师傅 API 映射。

---

## 3. 备份 / nginx -t / reload

| 步骤 | 结果 |
|---|---|
| 备份 | `/opt/scqf-aftersales/backup/media-read-route-01-<时间>/vhost.conf`，**13,325 B / 600** |
| `nginx -t` | **successful** |
| `nginx -s reload` | **rc=0** |
| Docker daemon / NocoBase / PG | **未重启** |

---

## 4. 验收结果

| # | 项 | 结果 |
|---|---|---|
| **A** | H5 实际 URL 不再 404 | `GET /api/technician/visits/<T>/media/<ref>` → **200** ✅ |
| **B** | 业务 200 + MIME 正确 | `200`，`content-type: audio/webm`，`71,040` 字节 ✅ |
| **C** | 页面原生 AUDIO 实际加载并播放 | `readyState=4`、`duration=5.16s`；`play()` 后 **`paused=false`、`currentTime=0.85`、`buffered=3.24`、`error=null`** ✅ |
| **D** | 工单/媒体归属正确 | 该 ref 来自本单 `FW20261022-0007` 的媒体列表，页面显示同一单 ✅ |
| **E** | 安全响应头 | `cache-control: private, no-store`、`x-content-type-options: nosniff`、`content-disposition: inline` ✅ |
| **F** | 无效 token / 非法 ref 被拒 | 伪造 43 位 → **401**；无效 ref → **404** ✅ |
| **G** | 其他入口不回归 | `/t/<T>` 302、`/p/<22>` 302、`/h5/report` 200、`/api/public/stores` 200、`/api/technician/visits/<T>` 200、`/admin` 200 ✅ |
| **H** | 生产零写入 | 工单 0 / 上传 0 / 删除 0 / 提交 0 / 短信 0 / DB 0 ✅ |

**浏览器 Network**（脱敏）：

```
GET /api/technician/visits/<T>/media/<ref>  → 200
GET /api/technician/visits/<T>/media/<ref>  → 200
```

---

## 5. 越权回归：**PENDING**（本轮未做）

**没做**跨工单/撤销 Visit 的真实越权测试 —— 需要**隔离实例 + 第二张合成工单**。
源码层面边界是清楚的（候选集 `listForTicket(ticket_id)`），但**源码不等于实测**。

⇒ 因此本轮只申请 **READ UI / FUNCTIONAL PASS**，**AUTH REGRESSION PENDING**。

---

## 6. Range 与 Referrer 遗留

| 项 | 状态 |
|---|---|
| **TECH-MEDIA-RANGE-01** | **OPEN**：`Range: bytes=0-1023` → 仍 `200` 全量 71,040 B，但响应声明 `Accept-Ranges: bytes`。**不阻塞本次 GET 修复**，但**不得宣称支持视频拖动/断点续传** |
| **TECH-TOKEN-REFERRER-01** | **待评估**：`/api/` 为 `strict-origin-when-cross-origin`，`/h5/` 为 `no-referrer`。Token 在 query、跨源只带 origin，风险可接受；**本轮未改全站安全头** |

---

## 7. 回滚依据

```bash
BK=/opt/scqf-aftersales/backup/media-read-route-01-<时间>
cp -p $BK/vhost.conf /www/server/panel/vhost/nginx/sh.scqfls.cn.conf
/usr/bin/nginx -t && /usr/bin/nginx -s reload
```

---

## 8. 生产纪律

| 项 | 状态 |
|---|---|
| 业务代码 / H5 / 插件 / DB | **未改** |
| 工单写入 / 上传 / 照片删除 / 提交 / 短信 | **0 / 0 / 0 / 0 / 0** |
| Token | `<T>` / `<ref>` 脱敏 |
| Git | **未 commit / 未 push** |

**遗留清理**：`.tmp-verify/dplay`（Edge profile）删除被 `SAFE_DELETE_FAIL_CLOSED` 拦下，**未绕过**，单列待处理。

---

## 9. 状态

| 项 | 状态 |
|---|---|
| TECH-H5-PLUGIN-CONTRACT-01 | ROOT CAUSE PASS / CLOSED |
| **TECH-MEDIA-READ-ROUTE-01** | **READ UI/FUNCTIONAL PASS；AUTH REGRESSION PENDING** |
| TECH-PHOTO-DELETE-ROUTE-01 | PENDING（本轮未加删除路由） |
| TECH-MEDIA-RANGE-01 | OPEN |
| TECH-TOKEN-REFERRER-01 | 待评估 |

P6：LIVE / CONDITIONAL；Release：HOLD。
