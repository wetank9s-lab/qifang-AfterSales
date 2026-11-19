# TECH-MEDIA-AUTH-01 / TECH-PHOTO-DELETE-01 隔离验收报告

> 时间：2026-10-23 11:04–11:18 CST
> 结论：**BLOCKED** —— 隔离实例**缺合成 Visit 与工单归属媒体**，无法开展跨工单授权回归。
> 按令「没有合成 Visit 和合法媒体夹具时明确 BLOCKED，不用生产工单代替」，**本轮不做任何越权实测**。

---

## 1. 前置条件核查（实测）

| 项 | 实测 | 是否满足 |
|---|---|---|
| 门店 | **15** | ✅ |
| `service_tickets` | **0** | ❌ |
| `service_visits` | **0** | ❌ 没有 Visit ⇒ 没有师傅 Token 可用 |
| `customer_medias` | 2（50 MiB 边界测试留下的，**未绑定工单**） | ❌ 无工单归属 |
| `customer_media_sessions` | 4 | — |
| 师傅 action 可达性 | `get/media/upload/submit/deletePhoto` **全部 401**（鉴权层在，非 404） | ✅ 接口在 |
| `publicStore:list` | **200** | ✅ |
| `publicTicket:create` | **422**（需合法 body 与 k） | 可用但需签名 |

⇒ **缺的正是最关键的两样**：**Visit**（师傅 Token 的载体）与**归属某工单的媒体**。
没有它们，"Token A 读媒体 A / 读媒体 B"这类用例根本无从构造。

---

## 2. 为什么不能直接开始（技术细节，避免下次重复踩）

1. **Visit 不是公开接口能造的**：派工走的是门店侧（需登录态）动作，
   测试实例**没有管理员账号**（全新库）⇒ 无法通过 API 派工。
2. **媒体要绑工单**：`:media` 的候选集是 `listForTicket(visit.ticket_id)`，
   所以媒体行必须有 `ticket_id`；而那 2 条 50 MiB 媒体是纯上传产物，**没有工单归属**。
3. **Token 载体**：Visit 行需 `access_token_hash`（sha256 明文令牌）+ 有效/未撤销状态；
   这些字段只能在插入 Visit 时一并构造。

---

## 3. 可行的建场方案（下一步，需你批准"直接写测试库"）

在 **`scqf_media_test`（隔离库）** 内用合成数据建场，**不碰生产**：

| 步骤 | 做法 |
|---|---|
| ① 合成工单 A/B | 用测试实例 `SIGN_SECRET` 签 `k`（HMAC-SHA256(`store-entry:<code>`) → base64url 截断），走 `publicTicket:create` 建两单 |
| ② 合成 Visit A/B | **直接 INSERT** `service_visits`（ticket_id=A/B、`access_token_hash=sha256(token)`、未撤销） |
| ③ 媒体 A/B | 各上传一条音频，落库后 **UPDATE `customer_medias.ticket_id`** 指向各自工单（隔离库允许） |
| ④ 双 Token | 两枚独立 43 位随机串，分别 hash 写入 Visit A/B |
| ⑤ 校验 | 按令的 8 条用例逐条跑：A 读 A ✅ / A 读 B ❌ / B 读 A ❌ / 假 ref ❌ / 错 token ❌ / 撤销后 ❌ / 替换后 ❌ / 不泄露 mediaId·storage_key |

**为什么需要你批一句**：②③ 是**直接改测试库表**（不是走业务接口）。
虽然是隔离库，仍属"手工造状态"，按你一贯的纪律我不擅自动手。

> 若你更希望**全走接口**，那需要先给测试实例建一个管理员账号（NocoBase 安装流程），
> 再用后台派工 —— 步骤更多，但没有手工 SQL。

---

## 4. 未取得证据的项目（全部 PENDING，不冒充）

| 项 | 状态 |
|---|---|
| Token A 读媒体 A 成功 | **未测**（无 Visit/媒体） |
| A 读 B 被拒 | **未测** |
| B 读 A 被拒 | **未测** |
| 不存在 ref 被拒 | 生产已测（404），隔离未测 |
| 错误 Token 被拒 | 生产已测（401），隔离未测 |
| 撤销 / 替换后拒绝 | **未测**（需撤销 Visit） |
| 照片删除：合法删除成功 | **未测**（需合成照片） |
| 照片删除：越权/他单/客户媒体拒绝 | **未测** |
| 删除后 DB 与私有存储一致 | **未测** |
| 删除后 H5 卡片更新 | **未测** |
| Range / 206 | **OPEN**（仍 200 全量） |
| Referrer 策略 | **OPEN / 待评估** |

---

## 5. `dplay` 遗留（只读登记，未删除、未绕过）

| 项 | 值 |
|---|---|
| 路径 | `C:\Users\Administrator\WorkBuddy\2026-09-20-15-28-58\.tmp-verify\dplay` |
| 大小 | **5.3 MB** |
| 存在 | **YES**（本地仍在） |
| 删除结果 | `SAFE_DELETE_FAIL_CLOSED` 拒绝，**未绕过** |
| 是否含证据 | 仅 Edge 测试 profile（无验收截图/日志），**推定无保留价值** |
| 处置 | 按既有安全删除流程**单独申请**后再清；或由你在资源管理器手动删除 |

> 另一个 `mp`（更早轮次）也在同一目录，情况相同。

---

## 6. 生产纪律（本轮）

| 项 | 状态 |
|---|---|
| 生产工单 / 媒体写入 / 照片删除 / 提交 / 短信 | **0 / 0 / 0 / 0 / 0** |
| 生产 DB 修改 | **0** |
| 测试库写入 | **0**（本轮仅只读查询） |
| Nginx / H5 / 插件部署 | **未动**（已验证的那条 media rewrite 保持不变） |
| Token 生成/鉴权 | 未改 |
| Git | **未 commit / 未 push** |

---

## 7. 状态

| 项 | 状态 |
|---|---|
| TECH-MEDIA-READ-ROUTE-01 | **READ FUNCTIONAL PASS / AUTH PENDING** |
| **TECH-MEDIA-AUTH-01** | **BLOCKED（缺合成 Visit + 工单媒体）** |
| **TECH-PHOTO-DELETE-01** | **BLOCKED（同上）** |
| TECH-MEDIA-RANGE-01 | **OPEN** |
| TECH-TOKEN-REFERRER-01 | **OPEN / 待评估** |

---

## 8. 需要你一句话

**「批准在 scqf_media_test 内手工建场（INSERT visit / UPDATE media.ticket_id）」** —— 我就能把 A/B 双工单、双 Token、双媒体一次建好，按 8 条用例跑完授权回归。

否则我需要你给测试实例建管理员账号，改走全接口路线（步骤更多）。

P6：LIVE / CONDITIONAL；Release：HOLD。
