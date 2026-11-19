# P4-B 第二关最终补证报告（最小测试写入）

> 日期：2026-10-22 · **跨店权限：PASS / 媒体有效读取：PENDING（架构限制）**
> 临时写入已按 ID 精确清理，计数回到操作前快照。

---

## 1. 操作前预检（全部符合）

| 项 | 值 |
|---|---|
| 容器 | `scqf-as-app` / `scqf-as-postgres` |
| 数据库 | `scqf_aftersales_candidate` |
| `APP_ENV` | **production** |
| `SMS_PROVIDER` / `SMS_ENABLED` | `smsbao` / **false** |
| DB `sms.enabled` | **false** |
| 应用绑定 | **127.0.0.1:13000** |

**快照**：tickets **489** / archives **124** / conv **26** / sms_logs **783** / users **11** / rolesUsers **13** / store_users **3** / sessions **725**

**恢复点**：`cand-before-test.dump`（**3.6 MB**，TOC 1072，`pg_restore -l` 可读）✅

---

## 2. 门店实际情况（重要）

```
id=1  S01  新都圣大家电
id=4  S04  金堂华林电器     ← 用作 B 门店
id=8  S08  崇州九兴电器
id=9  S09  新津欣盛电器
id=10 S10  青神易田电器
id=11 S11  郫都康乐电器
id=12 S12 龙泉东山电器
id=13 S13 茂县国茂电器
id=14 S14 蒲江江华家电
id=15 S15 峨眉诚信电器
```

**没有 id=2 / id=3 / id=5 / id=6 / id=7。**

⇒ **没有 S02**，用 **S04（id=4）** 作 B 门店。**没有创建虚构门店，没有使用不存在的 store_id=2。**

---

## 3. 媒体会话测试

### 3.1 契约查明

| 项 | 事实 |
|---|---|
| 签发 API | **`POST /api/publicMedia:session`**（**既有，非手工插库**） |
| 参数 | `media_consent: true`（强制） |
| token 生成 | `crypto.randomBytes(32).toString('base64url')` |
| 存储 | **只存 `sha256Hex(token)`** |
| 绑定 | `media_kind: 'mixed'`（可覆盖两类） |
| 校验 | `status` + `expires_at` + `media.ticket_id === session.ticket_id` |

### 3.2 实测结果

| 测试 | 结果 |
|---|---|
| 通过既有 API 签发会话 | ✅ `session_id=737`、token 43 字符 |
| **用新会话读 media 563** | **404** ❌ |
| 无 session 头 | **401** ✅ |
| 伪造 session | **404** ✅ |
| 不存在的 media id | **401** ✅ |

### 3.3 为什么新会话读不了（**架构事实**）

```
media 563 → ticket_id=6860, session_id=735（status=bound, expires_at=2026-10-19 20:09 已过期）
新会话 737 → ticket_id=NULL（未绑定任何工单）

publicMediaFile 的校验链：
  readBound(mediaId) → meta.sessionId = 735（媒体自己的会话）
  ticketOfSession(735) → 6860
  meta.ticketId(6860) === sessionTicket(6860) → 通过
  canAccess(actor, 6860) → ...
```

**读取时用的是「媒体创建时绑定的那个会话」，不是我新签发的会话。**

⇒ 新会话（`ticket_id=NULL`）**在第一步就对不上**，必然 404。

**要让它读到，只能改 media 563 的 `session_id` 或给会话 735 续期 —— 两者都是修改真实记录，禁止。**

### 3.4 结论

| 项 | 判定 |
|---|---|
| 会话签发机制可用 | ✅ |
| 鉴权拒绝路径 | ✅（401 / 404 / 401） |
| 文件完整性 | ✅（610 文件 SHA-256 全等） |
| **有效会话 → 200 + 正确字节** | **PENDING** |

**这不是"没测"，是"当前架构下无法在不改真实数据的前提下测"。**

**新增限制**：`customer/` 与 `visits/` 的读取**共用同一出口**（`readBound` + `publicMediaFile`），但**各自绑定自己的会话**。所以即使能读一类，也不能推断另一类——**两类都要单独验**。

---

## 4. 跨门店权限测试（**全部通过**）

### 4.1 合成账号

| 项 | 值 |
|---|---|
| ID | **913** |
| 邮箱 | `synthetic.crosstest@svc.invalid`（`.invalid` TLD，不可能真实投递） |
| 昵称 | 合成跨店测试 |
| 角色 | `store_after_sales` |
| 门店 | **S04（id=4）** |
| 口令 | 会话内随机生成，**未写入报告/日志/Git** |
| 创建方式 | `users:create` API + `rolesUsers` / `store_users` 正式关联 |

### 4.2 实测结果

| 测试 | 实际响应 | 判定 |
|---|---|---|
| **登录** | token 257 字符 | ✅ 成功 |
| **角色/门店解析** | `store_after_sales` + `store_id=4` | ✅ 正确 |
| **读历史档案（无参数）** | `total = 0` | ✅ 只看到自己门店（S04 无档案） |
| **伪造 `storeCode=S01`** | `total = 0` | ✅ **伪造无效** |
| **读工单列表** | **`{"errors":[{"message":"No permissions"}]}`** | ✅ **完全拒绝** |
| **跨店转单**（archive 1 属 S01） | **403** | ✅ 拒绝 |

**"伪造 storeCode=S01" 仍返回 0** —— 这是关键证据：**前端传什么门店都不改变服务端裁剪结果**。

---

## 5. 测试写入与清理

| 对象 | 写入 | 清理 | 验证 |
|---|---|---|---|
| 媒体会话 736 | 1 行（`createSession`） | `delete` → **DELETE 1** | — |
| 媒体会话 737 | 1 行 | `delete` → **DELETE 1** | — |
| 用户 913 | 1 行 | `delete` → **DELETE 1** | — |
| rolesUsers（913） | **2 行**（`member` 默认 + `store_after_sales`） | `delete` → **DELETE 2** | — |
| store_users（913） | 1 行 | `delete` → **DELETE 1** | — |

### 清理后计数（与快照逐项对比）

| 表 | 快照 | 清理后 | |
|---|---|---|---|
| users | 11 | **11** | ✅ |
| rolesUsers | 13 | **13** | ✅ |
| store_users | 3 | **3** | ✅ |
| customer_media_sessions | 725 | **725** | ✅ |
| service_tickets | 489 | **489** | ✅ |
| sms_logs | 783 | **783** | ✅ |

**完全回到操作前状态。**

---

## 6. 数据库与原始证据状态

| 资源 | 状态 |
|---|---|
| `scqf_aftersales`（空系统） | **未动**，tickets=0 |
| `scqf_aftersales_rehearsal`（证据） | **未动**，sms.enabled 仍 `true` |
| **`scqf_aftersales_candidate`** | **运行中，未删** ✅ |
| `cand-before-test.dump` | **新增**（3.6 MB，本次恢复点） |
| `empty-snapshot.dump` / `rehearsal-immutable.dump` | 保留 |
| 源机 dump / 媒体 / 密钥 | 保留 |

**未执行任何 `drop database`。**

---

## 7. 短信门禁

| 项 | 值 |
|---|---|
| DB `sms.enabled` | **false** |
| `SMS_ENABLED` | **false** |
| `sms_logs` | **783 → 783（0 增量）** |
| 真实发送 | **0** |

**注意**：本次测试**签发过媒体会话**（`publicMedia:session`），但**没有触发任何短信路径**（该接口不涉及短信）。

---

## 8. 其他站点健康

| 域名 | 结果 |
|---|---|
| `hd.scqfls.cn` | **200** |
| `cloud.scqfls.cn` | **403** |
| `sd.scqfls.cn` | **000**（既有） |
| `kanma.cloud` | **000**（既有） |
| `nginx -t` | **successful** |

**Nginx 未修改、DNS 未动。**

---

## 9. 一个必须报告的操作失误

**签发会话时，我把 `/api/publicMedia:session` 的响应体打印了前 220 字符，其中包含 `session_token` 明文。**

处理：
- 该会话（**736**）**已立即删除**（`DELETE 1`）
- 后续改用「只取字段名、token 只写临时文件、不回显」的方式重发（737，也已删除）
- 报告、记忆、Git 中**没有该 token**

**这是我在本轮的第二次"把敏感值打到终端"**（上一次是 `APP_KEY`）。两次都是「想看数据结构就顺手 `head -c`」。**这个习惯必须改。**

---

## 10. 判定

| 项 | 结论 |
|---|---|
| 预检与恢复点 | **PASS** |
| 会话签发机制 | **PASS**（既有 API 可用） |
| 媒体鉴权拒绝路径 | **PASS**（401/404/401） |
| 媒体文件完整性 | **PASS**（610 SHA-256 全等） |
| **媒体有效会话读取** | **PENDING**（架构限制：读取只认媒体自己的会话） |
| 合成账号创建与归属 | **PASS** |
| 合成账号登录 | **PASS** |
| **跨店读档案** | **PASS**（total=0） |
| **伪造 storeCode** | **PASS**（仍 0，伪造无效） |
| **跨店读工单列表** | **PASS**（`No permissions`） |
| **跨店转单** | **PASS**（403） |
| 临时写入清理 | **PASS**（6 项计数全部回快照） |
| 数据库保护 | **PASS**（未删任何库） |
| 短信门禁 | **PASS**（783→783） |
| 其他站点 | **PASS** |

### 申请

**P4-B 第二关：跨店权限部分 PASS / FROZEN；媒体有效读取 1 项 PENDING。**

**不给整关 PASS** —— 按你的规则，缺实测证据的项不宣布完成。

### 媒体项要怎么才能 PASS

**只有一个办法**：授权**改 media 563 的 `session_id`** 指向一个新会话（或给会话 735 续期）。
- 改动：`customer_medias.session_id` 1 行 或 `customer_media_sessions.expires_at` 1 行
- **这是修改真实业务记录**，我不擅自动。

**或者**：接受"文件完整性已证（SHA-256 全等）+ 鉴权拒绝已证 + 架构限制已查明"这个证据组合，把媒体项判为 **PASS WITH KNOWN LIMITATION**。

**这个判断权在你。**
