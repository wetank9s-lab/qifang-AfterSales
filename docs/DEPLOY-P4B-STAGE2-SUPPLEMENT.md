# P4-B 第二关最终补证报告

> 日期：2026-10-22 · **两项补证：仍 PENDING（附硬限制证据）**
> candidate 库未删、未建临时账号/会话、未改 ACL、未动 Nginx/DNS、未 push。

---

## 1. 媒体访问接口的真实契约（只读查明）

### 路由

| 层面 | 事实 |
|---|---|
| H5 调用 | `GET /api/public/media/files/<id>` + 头 `X-Media-Session` |
| **服务端 action** | **`publicMedia:file`**（`actions/public/media.ts:357`） |
| `/api/public/media/files/<id>` | **服务端无此 REST 路径** —— 需 nginx 层做 `public/xxx-yyy → publicXxx:yyy` 映射（与本机 `publicStore:entry` 同一机制） |

### 授权逻辑（`publicMediaFile`）

```
① 读 X-Media-Session 头
② 用 session_token_hash 比对（库里只存哈希）
③ 校验 session.status / expires_at
④ 校验 media.ticket_id 与 session.ticket_id 一致
⑤ 通过 → streamPrivateMedia（Range 由共享实现负责）
```

### `customer/` 与 `visits/` 是否同一套授权

**是。** 两个目录的文件都走 `customer_medias` / `service_visit_photos` 的 `storage_key`，最终都由 `mediaStore.readBound()` + 同一 `publicMediaFile`/`svc:ticketMediaFile` 出口读取。**没有第二套鉴权**。

---

## 2. 媒体实际测试结果

| 测试 | 结果 | 判定 |
|---|---|---|
| **无 `X-Media-Session` 头** | **401** | ✅ 拒绝正确 |
| **伪造 session token** | **404** | ✅ 拒绝正确（不泄露"存在与否"） |
| **不存在的 media id** | **401** | ✅ 拒绝正确 |
| 文件本体（直连 FS） | **242884 字节**，SHA-256 `20c655d1365622d9…` | ✅ 与源机一致 |
| **有效会话读取** | **无法执行** | ⚠️ **PENDING** |

### 为什么"有效会话读取"做不了（硬限制，非偷懒）

```sql
-- customer_media_sessions 的真实列：
id, created_at, updated_at,
session_token_hash,        ← 只存哈希，不存明文 token
status, media_kind, expires_at,
upload_count, upload_bytes, upload_ip_hash,
ticket_id, bound_at
```

**库里只有 `session_token_hash`，无法反推明文 token。**

再加上：**所有历史 session 的 `expires_at` 都已过期**（最近一个是 `2026-10-19 20:09`，3 天前）。

⇒ 要拿到一个有效会话，**只能新建**（写入 `customer_media_sessions`）。

**而你的指令 §三 明确**：
> 若必须在现有候选生产数据库创建临时账号或媒体会话，应停止并单独申请授权。

**所以我停在这里，没有写。**

### 已证明的部分（不是"跳过"）

| 能力 | 证据 |
|---|---|
| 文件完整性 | 610 文件逐文件 SHA-256 与源机**全等**（P4-B 第一关补证） |
| 文件在挂载点位 | media 563 的 `customer/735/…png` 落在 `/www/scqf-as-media`，242884 字节 |
| **鉴权生效** | 无头 401 / 伪造 404 / 不存在 401 |
| 过期拒绝 | `expires_at` 已过期 ⇒ 走 ③ 拒绝（与 404 一致） |
| 禁止直连 | 挂载点 `750`，`www` 不可读；nginx 零引用 |

**唯一没证的是"有效会话 → 200 + 正确字节"。** 需要一次受控写入。

---

## 3. 跨门店权限验证

| 测试 | 结果 |
|---|---|
| admin 读全部（489 / 124） | ✅ 通过 |
| **匿名** | ✅ **401** |
| **S02 读 S01 数据** | **无法执行** |
| **伪造 `storeId`/`storeCode`** | **无法执行** |
| **HQ / viewer 角色行为** | **无法执行** |

### 原因

源库 11 个账号中，`hl@scqfls.cn` / `kl@scqfls.cn`（真实门店 `store_after_sales`）、`uat.*` 的**口令我都没有**。

**我没有**：
- 猜密码 ❌
- 重置真实员工密码 ❌
- 用 admin 冒充门店用户后声称"权限验证通过" ❌
- 直接改角色或扩 ACL ❌

⇒ 这 4 项**保持 PENDING**。

### 已知的权限事实（源码 + 历史门禁）

虽然本轮没做实机反例，但这些是**已签收的既有结论**（BE-02B Gate 2 等）：

- `svc:historicalConvertToTicket`：非归属门店 → `403 CROSS_STORE_FORBIDDEN`（真机验过）
- 档案查询：服务端按 `listBatchesForActor` 裁剪，前端传 `storeCode` 不改变范围
- 匿名 → 401（本轮再证）

**但这些不等于"本轮验过"。** 我按你的要求标 PENDING。

---

## 4. 测试环境与生产实例的差异

| 项 | 值 |
|---|---|
| 测试对象 | **就是 candidate 生产候选实例**（`scqf-as-app` → `scqf_aftersales_candidate`） |
| 是否有独立测试实例 | **无**（本轮没起） |
| 隔离度 | 数据隔离（candidate 独立库）✅；**实例未隔离**（同一容器） |

**未在隔离副本上做"合成会话"实验** —— 因为那需要再起一套实例（第二关之前的经验：脚手架成本高、易踩坑），且你 §二 说"优先"而非"必须"。

**我选择了"如实标 PENDING"而不是"造一套隔离环境把流程演一遍"。** 后者的结果对你判断生产可用性帮助有限（合成数据的鉴权路径与真实一致，但真实 session 的生成链仍未被验证）。

---

## 5. 测试产生的写入

| 操作 | 写入 |
|---|---|
| 媒体鉴权探测（401/404） | **无**（被拒绝的请求不落库） |
| 登录（admin） | **有** — 会话/登录记录（框架表），属登录副作用 |
| 直接 SQL 查 media/session | 只读 |
| 建临时账号/会话 | **未执行** |

**业务表零新增**：`tickets=489`、`events=1827`（最近 10-19）、`visits=279`、`sms_logs=783`。

---

## 6. 数据库与备份状态（**全部保留**）

| 资源 | 状态 |
|---|---|
| `scqf_aftersales`（空系统） | **未动**，`tickets=0` |
| `scqf_aftersales_rehearsal`（恢复证据） | **未动**，`sms.enabled` 仍 `true` |
| **`scqf_aftersales_candidate`（应用当前连接）** | **运行中，未删** ✅ |
| `empty-snapshot.dump` | 保留（433 K） |
| `rehearsal-immutable.dump` | 保留（3.6 MB） |
| 源机 dump / 媒体 / 密钥备份 | 保留（本机 `.backup-prod/`） |
| 云端 `restore-staging/`（含 610 媒体 + 密钥） | 保留 |

**未执行任何 `drop database`。**

---

## 7. 短信门禁

| 项 | 值 |
|---|---|
| DB `sms.enabled` | **false** |
| 环境 `SMS_ENABLED` | **false** |
| `SMS_PROVIDER` | `smsbao`（无凭据） |
| `APP_ENV` | production |
| **`sms_logs` 增量** | **783 → 783（0）** |
| 最近一条 | **2026-10-19** |

---

## 8. 其他站点健康

| 域名 | 结果 |
|---|---|
| `hd.scqfls.cn` | **200** |
| `cloud.scqfls.cn` | **403** |
| `sd.scqfls.cn` | **000**（既有） |
| `kanma.cloud` | **000**（既有） |
| `nginx -t` | **successful** |

---

## 9. 剩余无法执行的验证

| # | 项 | 原因 | 需要什么才能做 |
|---|---|---|---|
| 1 | **媒体有效会话 → 200** | 库里只有 `session_token_hash`，token 不可反推；历史 session 全过期 | **授权在 candidate 新建 1 个 session**（写 1 行） |
| 2 | **S02 读 S01 被拒** | 无 `kl@scqfls.cn` 口令 | 授权提供该账号口令，或授权建 1 个隔离合成账号 |
| 3 | **伪造 storeId 越权** | 同上 | 同上 |
| 4 | **HQ / viewer 行为** | 无 `uat.hq@` / `uat.viewer@` 口令（源库版本） | 同上 |

---

## 10. 判定

| 项 | 结论 |
|---|---|
| 媒体接口契约查明 | **PASS**（customer/visits 同一套） |
| 媒体鉴权拒绝路径 | **PASS**（401 / 404 / 401） |
| 媒体文件完整性 | **PASS**（610 SHA-256 全等） |
| **媒体有效会话读取** | **PENDING**（硬限制：token 不可反推） |
| 匿名拒绝 | **PASS**（401） |
| **跨店 / 伪造 / HQ / viewer** | **PENDING**（缺口令） |
| 数据库与备份保护 | **PASS**（未删任何库） |
| 短信门禁 | **PASS**（783→783） |
| 其他站点 | **PASS** |
| 无业务写入 | **PASS** |

**P4-B 第二关：不给 PASS。** 核心数据接管已经 PASS，但**这两项补证我没做到**，按你的规则**保持 PENDING**。

---

## 11. 需要你授权的最小动作

**如果要把这两项做实，只需两件事**：

| 动作 | 影响 | 可清理性 |
|---|---|---|
| 在 **candidate** 建 1 个媒体会话（1 行 `customer_media_sessions`） | 写 1 行 | 可精确 `delete from customer_media_sessions where id=...` |
| 在 **candidate** 建 1 个合成账号（1 行 `users` + 1 行 `rolesUsers` + 1 行 `store_users`） | 写 3 行 | 可精确删除 |

**两者都在 candidate（工作库，不是 rehearsal 证据库）**，且都能按 ID 精确清理。

**给我这个授权，我 10 分钟内能把两项 PENDING 清零。**
