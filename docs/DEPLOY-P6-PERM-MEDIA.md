# P6 上线后紧急收口 · 任务三：权限与媒体补证（隔离环境）

> 执行时间：2026-10-22 12:56–13:04（UTC+8）
> 环境：一次性隔离实例 `scqf-as-app-verify`（127.0.0.1:13002）+ 独立库 `scqf_aftersales_verify`（129 表）
> 判定：**A / B / C / D 四组全部完成**，其中 **C（MEDIA-SESSION-BOUND-01）正式关闭**
> 生产零影响：tickets **489** / events **1827** / medias **551** / sessions **725** / sms_logs **783** 全程不变

---

## 一、隔离环境怎么做的（以及为什么必须隔离）

| 项 | 隔离做法 |
|---|---|
| 数据库 | `pg_dump candidate \| psql verify` 复制出 **129 表** 的全新库 |
| 存储 | 独立目录 `verify/storage`，只拷 `aes_key.dat` + `instance-id`（与库同版本） |
| 媒体 | **空目录**（0 文件）—— 刻意如此，证明与生产媒体完全隔离 |
| 插件 | **复制**一份到隔离存储（不共用生产目录） |
| 实例 | 独立容器 `scqf-as-app-verify`，端口 `127.0.0.1:13002`，`APP_ENV=production`，`SMS_ENABLED=false` |
| 账号 | 4 个合成账号（**只存在于隔离库**，生产 users 表一行未动） |

> 为什么不能像 P4-B 那样直接在生产库造账号再删：造账号要写 `users`、`rolesUsers`、`store_users`
> 三张表，任何一步留下残行都是"真实数据被污染"。复制一份库再折腾，代价是多花 2 分钟。

### 合成账号

| 账号 | id | 角色 | 门店 |
|---|---|---|---|
| `synth.s01@svc.invalid` | 914 | `store_after_sales`（default） | 1（S01） |
| `synth.s04@svc.invalid` | 915 | `store_after_sales`（default） | 4（S04） |
| `synth.hq@svc.invalid` | 916 | `hq_after_sales` | — |
| `synth.viewer@svc.invalid` | 917 | `viewer` | — |

### 🔑 顺带查清：NocoBase 口令存储算法（以后造账号不用再摸）

`@nocobase/database/lib/fields/password-field.js`：

```
length = 64, randomBytesSize = 8
hash = salt_hex(16 字符) + scrypt(password, salt_utf8_hex, keylen=24).hex()
       scrypt 参数 = Node 默认（N=16384, r=8, p=1）
```

**不是 sha256、不是 bcrypt**。我第一次按 sha256 造账号，4 个账号全部 401 —— 这是本轮第一个被推翻的假设。

---

## 二、A. 门店列表过滤（挂了三轮的 PENDING，本次关闭）

| 账号 | 期望 | 实测 `serviceTickets:list` count |
|---|---|---|
| S01（store_id=1） | 452 | **452** ✅ |
| S04（store_id=4） | 5 | **5** ✅ |
| HQ | 489（全量） | **489** ✅ |
| viewer | （只读，范围另记） | 489（见 §五.4 待确认） |

- 隔离库真实分布：`store 1 = 452 / store 2 = 28（孤儿）/ store 4 = 5 / NULL = 4`，合计 489。
- **伪造过滤被直接拒绝**：`?filter={"storeId":4}` 与 `?filter[storeId]=4` 均返回 **400 `Invalid SQL column or table reference`**。
  这比"静默忽略、返回本店数据"更硬 —— 参数面在 ORM 层就被挡掉。
- 结论：**门店数据范围由 `applyScope()` 落到 SQL WHERE，不靠前端**，与契约一致。

> 这一项此前一直挂着，是因为 **P4-B 那次用的是 `serviceTickets:list` 却返回 `No permissions`** ——
> 根因是那个合成账号同时挂了 `member` 角色且 `default` 可能不是门店角色。
> 本次只挂单一 `store_after_sales` 且 `default=true`，A 组一次通过。

---

## 三、B. HQ / viewer / 跨店 反例

| 场景 | 期望 | 实测 | 判定 |
|---|---|---|---|
| `viewer` 受理工单 | 拒绝 | **403 `FORBIDDEN`** | ✅ |
| `store S04` 受理 S01 的工单（跨店） | 拒绝 | **404 `NOT_FOUND`**「工单 2423 不存在」 | ✅（fail-closed） |
| `hq_after_sales` 受理 S01 的工单 | 见下 | **200，且状态 NEW → PROCESSING** | ⚠️ 设计如此 |

### ⚠️ 三个必须说清的口径问题

**① HQ 能受理门店工单，是设计，不是漏洞。**
`permission-service.ts` 的能力矩阵里 `WRITE_TICKET = 任一 WRITE_ROLES`，注释原文：
「总部角色能写全量工单」。所以 HQ 对任意门店工单 `accept` 成功是预期行为。

**但**：P4-B 记录过「`hq_after_sales` 转单 → 403 `STORE_STAFF_ONLY`」。同一个人、同一张单，
`accept` 放行而 `transfer` 拒绝 —— 两条写操作的口径不一致。**这不是我本轮能裁决的**，
登记为 **PERM-HQ-ACCEPT-01（待裁决）**：要么 accept 也该限门店，要么 transfer 的 403 应放宽。

**② 跨店返回 404 而不是 403。**
契约（`docs/STATE-MACHINE.md` / P4-B 记录）写的是 `403 CROSS_STORE`，`accept` 实际返回 `404 NOT_FOUND`。
安全上 404 更好（不泄露"这张单存在"），但**文档与实现对不上**，登记 **PERM-XSTORE-404-01（文档口径）**。
注意 `transfer` 那条路径确实返回 403 —— 说明两处代码不是同一个实现。

**③ `viewer` 能看到全量 489 张。**
`viewer` 是"只读管理层"，`isReadOnly()` 只限制**写**，`scopeOf()` 对无门店绑定的角色给全量。
如果产品意图是"只读但只能看自己门店"，现在就是**越权可见**；如果意图是"只读看全盘"，那没问题。
**我没有改任何东西**，登记 **VIEWER-SCOPE-01（待产品确认）**。

---

## 四、C. MEDIA-SESSION-BOUND-01 —— **CLOSED**

这个缺陷从 P4-B 一直挂到现在：`publicMediaFile` 只认"媒体创建时绑定的那个会话"，
而生产环境所有历史会话**都已过期**、明文 token 又不可反推 —— 所以它**只能在隔离环境里造新会话才能验**。

实测（会话 746 → 媒体 569）：

| 步骤 | 期望 | 实测 |
|---|---|---|
| `POST /api/publicMedia:session`（`media_consent:true`） | 200 + session_id/token | **200，session_id=746** |
| `POST /api/publicMedia:upload`（`X-Media-Session`，multipart 字段 `file`） | 200 + 媒体 id | **200，id=569（69 B PNG）** |
| 同会话 `GET /api/publicMedia:file/569` | **200** | **200** ✅ |
| 另一会话读取同一媒体 | **404** | **404** ✅ |
| 完全不带会话 | **401** | **401** ✅ |

**判定**：`readBound(mediaId).sessionId` 的绑定语义**按设计工作** ——
同一会话可读、其他会话（哪怕合法签发）读不到、匿名直接 401。
⇒ 先前"读不到历史媒体"**不是缺陷**，是会话过期 + 绑定语义共同作用的正确结果。
**MEDIA-SESSION-BOUND-01 关闭，不留 PENDING。**

---

## 五、D. 真实建单闭环（报修 + 投诉）

匿名经 `k=S01` 入口（legacy 形态，服务端支持且无需签名密钥）：

| 类型 | 状态 | 单号 | 门店 |
|---|---|---|---|
| 报修 `repair` | **201 Created** | `FW20261022-0001` | 新都圣大家电 |
| 投诉 `complaint` | **201 Created** | `FW20261022-0002` | 新都圣大家电 |

- 响应还带上 `progress_token` / `progress_url`（客户当场拿到进度查询入口）。
- 隔离库工单 **489 → 491**（+2，符合预期）。
- **生产库全程 489 不变**。
- 字段口径：请求体用 **snake_case**（`ticket_type` / `customer_name` / `customer_mobile` / `store_code`），
  不是 TS 接口里的 camelCase —— 我第一次按 camelCase 发，报 `INVALID_TICKET_TYPE 实际 ""`。

---

## 六、本轮我自己的 3 处断言错误（验证器比产品更容易错）

| # | 我写的断言 | 实际 | 教训 |
|---|---|---|---|
| 1 | 用 sha256 造口令 | 应为 scrypt(salt+hash) | 造数据前先读字段实现，别按"常见做法"猜 |
| 2 | HQ 受理应 403 | 200（设计允许） | 把"我以为是规则"当成规则；应先读能力矩阵 |
| 3 | 建单应 200 / 上传返回 `media_id` | 201 / 返回 `id` | 断言里硬编码状态码与字段名，等于给自己埋假红 |

三次都是**测试脚本错**，不是产品错。若不做反向验证、只跑一轮就发报告，这三条会变成三条"产品缺陷"。

---

## 七、销毁与残留核查

已销毁：

```
容器 scqf-as-app-verify        已移除
库   scqf_aftersales_verify    已 DROP
目录 /opt/scqf-aftersales/verify  已删除
文件 docker-compose.verify.yml 已删除
临时凭据 /tmp/.synth-pass 与全部临时脚本  已清理
```

销毁后核对：

| 项 | 结果 |
|---|---|
| 运行容器 | 仅 `scqf-as-app` / `scqf-as-postgres`，均 healthy |
| 数据库 | `scqf_aftersales` / `scqf_aftersales_candidate` / `scqf_aftersales_rehearsal`（三库俱在） |
| 业务计数 | 489 / 1827 / 551 / 725 / 783 —— **与开工前完全一致** |
| 站点 | `/h5/report` **200**、`/api/public/stores` **200** |
| 13002 端口 | 已释放 |

---

## 八、判定与待裁决

**任务三 = PASS**（四组补证全部给出正例 + 反例 + 实测值）

关闭的 PENDING：
- ✅ MEDIA-SESSION-BOUND-01
- ✅ 门店列表过滤（N vs 489）
- ✅ HQ / viewer 反例（结论见 §三，含 3 条待裁决）

新登记（**未擅自修改任何代码/配置**）：

| 编号 | 内容 | 需要谁 |
|---|---|---|
| `PERM-HQ-ACCEPT-01` | HQ 可 `accept` 但不可 `transfer`，两条写操作口径不一致 | 产品裁决 |
| `PERM-XSTORE-404-01` | 跨店 `accept` 返 404，文档写 403 | 文档对齐 |
| `VIEWER-SCOPE-01` | `viewer` 无门店绑定时可见全量 489 张 | 产品确认 |

> 这三条都**不是**本轮改动引起的，是既有实现与文档/预期之间的差异。
> 按项目分诊规则属于需要裁决的 A 类问题，等我拿到结论再动代码。
