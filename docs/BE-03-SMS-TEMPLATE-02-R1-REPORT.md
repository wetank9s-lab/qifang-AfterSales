# BE-03-SMS-TEMPLATE-02-R1 修复及验收报告

| 项 | 内容 |
|---|---|
| 任务 | BE-03-SMS-TEMPLATE-02-R1：短信模板契约确认及客户进度短码阻塞修复 |
| 日期 | 2026-11-06 |
| 裁决 | 客户进度短码阻塞项按用户裁决 **选 A4** |
| 结论 | 功能与验收 **全部达成**（五套用例 118/118）；发布门禁 **仍保持 HOLD** |
| 生产影响 | **零** —— 未发真实短信、未改生产库、未部署、未执行生产迁移、未改生产 Nginx、未 commit、未 push |
| 环境 | 本地 `svc-app` / `svc-postgres` / `svc-nginx`（`APP_ENV=development`） |

---

## 0. 一句话结论

**短信正文契约已锁死三条模板（客户两条变量名 `{token}` → `{code}`），客户进度通知不再因"没有进度 Token 明文"而静默跳过——改用 A4 的 HMAC 派生短码，服务端可随时重算、库里不存任何凭据明文、与原有 22 位/43 位链接完全兼容、且派生码无法进入师傅作业接口。**

本轮过程中我自己引入过一个**会导致全站 500 的生产级缺陷**（派工时库连接自死锁），已定位修死并留下机制级教训（见 §7）。另修掉一处**重复索引 + 死代码**（见 §4.3）。

---

## 1. 三条模板最终代码映射与渲染结果

### 1.1 代码映射（唯一事实来源：`src/server/constants.ts` 的 `SMS_TEMPLATE_BY_SCENE`）

| 场景常量 | 场景值 | 接收方 | 锁定正文（`{sign}` = `四川恒晟恒七方`） |
|---|---|---|---|
| `SMS_SCENE.TECHNICIAN_TASK` | `technician_task` | 师傅 | `【{sign}】您有新的售后服务任务，请点击链接查看并处理：https://sh.scqfls.cn/p/t/{code}` |
| `SMS_SCENE.PROGRESS_UPDATE` | `progress_update` | 客户 | `【{sign}】您的售后工单{ticket_no}有新的处理进展，请点击查看：https://sh.scqfls.cn/p/{code}` |
| `SMS_SCENE.PROGRESS_LINK` | `progress_link` | 客户 | `【{sign}】您的售后申请已提交成功，工单号{ticket_no}。查看处理进度：https://sh.scqfls.cn/p/{code}` |

**变更点只有变量名，正文一字未动。** 证明方式（用例 `V5`/`V6`）：把 `{code}` 统一替换为哨兵字符 `§` 后，新旧正文**逐字节相等**。这条断言的意义在于——**提交给短信宝审核的是固定正文，变量名调整不能顺手改字**。

### 1.2 渲染证据（产品自身的 `renderSmsPreview`，非人工拼接）

运行时产物里的链接形态只有三种，与契约完全一致（`grep` 容器内 `dist/server/index.js`）：

```
https://sh.scqfls.cn/p/           ← 空壳，闸 2.6 的拦截对象
https://sh.scqfls.cn/p/t/{code}
https://sh.scqfls.cn/p/{code}
```

### ⚠️ 【2026-11-06 勘误】这一节原来的说法是错的

R1 报告初版写的是「真实 E2E 抓到的两条**入库正文**（`FW20261106-0011`，`sms_logs` + `request.preview` 同源）」。
**这句话有两处不成立**，按用户裁决在本轮更正：

**（1）`sms_logs` 根本没有正文列，也没有参数列。**

```
sms_logs 实际列：id, scene, recipient_kind, to, provider, send_status, error_code,
                error_message, retry_count, provider_biz_id, delivery_status,
                ticket_id, visit_id, created_at, updated_at …
```

没有 `body` / `content` / `params` / `payload`。这是**设计如此**：正文必须包含可点击的凭据链接，
把它落库等于把凭据明文写进表（与 A4「库内无凭证明文」直接冲突）。
⇒ 所以「从 `sms_logs` 读到正文」这件事**从来不可能**，那句"同源"是我把两个不同的东西写混了。

**（2）`E15` / `E16` 不是"抓"到的，是**在测试里重建**的。**

看 `r1-e2e.mjs` 第 236–252 行的实际代码：

```js
const derivedCode = (() => {
  const msg = `progress-code|${ticketId}|${salt}|0`;
  return crypto.createHmac('sha256', SIGN_SECRET).update(msg)
    .digest().subarray(0, 16).toString('base64url');   // ← 测试自己又算了一遍派生码
})();
const expectUpdate = M.renderSmsPreview('progress_update', { ticket_no: ticketNo, code: derivedCode }, SIGN_NAME);
rec('E15', expectUpdate === `【四川恒晟恒七方】…${derivedCode}`, …);   // ← 自己算、自己渲染、自己比
```

也就是说：**测试用自己的 HMAC 算出 code，用产品自己的 `renderSmsPreview()` 渲染，再和一个手写的期望串比。**
它能证明的只有一件事——「产品渲染器对给定参数输出该字符串」，
**不能**证明「派工那条路径真的把这两个参数交给了渲染器」。

⚠️ 而且这段代码自己的注释当时就写着「`sms_logs` 不存正文/参数（设计如此）」——
**我知道这件事，却仍在上面那句摘要里写了"入库正文"**。这正是"报告结论与实现细节脱节"的典型。

---

### 1.3 正文断言**真正的捕获位置**在哪（勘误续）

这个系统里，短信正文在生产链路上**只存在于两个瞬时位置**，都不落库：

| 位置 | 是什么 | 可取证性 |
|---|---|---|
| `SmsSendRequest.preview` | 发送前渲染好的正文，作为待发送对象的字段存在于内存 | **不持久化**（`insertPending()` 只写状态列，不写 params） |
| `MockSmsProvider.outbox` | mock 通道把**真实收到的 `request`**（含 `preview` 与 `params` 原文）存在内存数组里 | 可以通过 `GET /api/svc:smsOutbox` **原样读出**（仅 mock 档、HQ 权限） |

⇒ **唯一能从"产品真实发送路径"取到正文的地方是 `MockSmsProvider.outbox`。**
它不是"测试自己算的"，而是**产品把这条短信交给通道时实际传过去的东西**。

`summarizeOutbox()` 返回 `preview`（渲染后的正文）**和** `params`（渲染用的变量）两者原文，
所以「参数 → 正文」这一步也能被独立核对，而不是相信同一段代码自己算两次。

---

### 1.4 更正后的结论（本轮 DEV-207 实测，从 outbox 真读）

`GET /api/svc:smsOutbox?limit=3` 刚取到的**原始回报**（HQ 账号，mock 档）：

```
--- seq 29  scene progress_update
  params:  {"ticket_no":"FW20261106-0045","code":"6o02CEnAQJx0K8nJAUUjcA"}
  preview: 【模拟通道】您的售后工单FW20261106-0045有新的处理进展，请点击查看：https://sh.scqfls.cn/p/6o02CEnAQJx0K8nJAUUjcA
--- seq 30  scene technician_task
  params:  {"code":"jBFltMGfExMgzuE_iAzAAg"}
  preview: 【模拟通道】您有新的售后服务任务，请点击链接查看并处理：https://sh.scqfls.cn/p/t/jBFltMGfExMgzuE_iAzAAg
--- seq 31  scene technician_assignment_cancelled
  params:  {"store":"新都圣大家电(S01)","ticket_no":"FW20261106-0045","expected":"11-07"}
  preview: 【模拟通道】新都圣大家电(S01)取消派单：FW20261106-0045（原定11-07）已改派他人，请勿上门。
```

⚠️ **这里有一个必须写明的差异**：mock 通道会在正文前加 **`【模拟通道】`** 前缀，
并由 mock 侧决定签名段（`【模拟通道】` 而不是 `【四川恒晟恒七方】`）。
⇒ **outbox 的 `preview` 不能用来做"与审核版逐字一致"的比对**，只能用来证明：
- ① **`params` 是真实传入的**（`ticket_no` 与 `code` 都在，且 `code` 是 22 位）；
- ② 正文里出现的 code **与 params 一致**（不是拼接错位）；
- ③ 链接形状正确（`/p/{code}` 客户、`/p/t/{code}` 师傅、无链接的取消通知）。

"逐字符合审核版模板"这一条**仍然由 `E15`/`E16`（渲染器契约）承担**，
两者是**互补**关系而不是替代关系：
**outbox 证明"传对了参数"，渲染器证明"给定参数输出什么字"**，合起来才等于"客户真的收到那句话"。

因此本轮将证据结构更正为：

| 要证明的事 | 由谁证明 | 等级 |
|---|---|---|
| 派工/改派的真实发送路径确实传了 `ticket_no` 与 22 位 `code` | `GET /api/svc:smsOutbox` 的 `params` 原始值（seq 29/30） | **强（产品真实产出）** |
| 正文里 `code` 与 params 一致、无拼接错位 | 同上，比对 `preview` 中的子串 | **强** |
| 给定参数时正文**逐字**等于审核版模板 | `E15` / `E16`（`renderSmsPreview` 契约用例）+ `be03-sms-template02.test.mjs` 的 **55/55** | **中（渲染器契约，非发送路径）** |
| 短信真的入了队列并受理 | `sms_logs` 的 `scene / send_status / error_code`（`E6`、`E9`） | **强** |

⚠️ **留待改进（已登记，未在本轮修改）**：`r1-e2e.mjs` 的 `E15/E16` 应当改成**从 outbox 读**，
而不是自己重算派生码。本轮不改的理由：它已在跑，且结论已由新证据覆盖；
硬改会把"改测试"与"改产品"混在同一次验收里，说不清哪一条变绿是因为什么。



### 1.5 ⚠️ 本轮踩到并推翻的第一次设计（必须留档）

第一版闸门设计的是"查残留占位符 `\{[A-Za-z_]\w*\}`"。**这个判据是错的**，用例 `V7`/`V8` 直接翻红。

原因：`renderSmsPreview()` 对**缺失的键替换为空字符串**，而不是保留占位符。所以
`…/p/{code}` + 参数 `{token}` ⇒ 渲染成 `…sh.scqfls.cn/p/`，**一个残留字符都没有**，`send_status` 会被写成 `accepted`——即"短信发出去了，但客户点开链接是 404"。

⇒ 闸 2.6 因此重设计为**结构性判据**：凭据前缀（`/p/`、`/p/t/`、`/t/`、`/f/`）之后必须紧跟 ≥16 位 base64url 字符。详见 §4.2。

---

## 2. A4 实现方案

### 2.1 用户已确认的两个设计选择

| 选择项 | 用户裁决 | 落地形态 |
|---|---|---|
| 派生形态 | **HMAC(密钥, ticket_id + 随机盐)** | 建单时生成随机 salt 存库（非凭据、不可反推）；`code = base64url(HMAC-SHA256(SIGN_SECRET, "progress-code\|{id}\|{salt}\|{epoch}")[0..16])`，22 位；服务端可随时重算，**绝不存明文**；换 epoch 即轮换 |
| 有效期 | **沿用原进度查询期限** | 与 `PROGRESS_TOKEN` 同一套：未关闭工单一直可查；关闭后保留 30 天；**派生码不设独立 TTL** |

### 2.2 7 项子目标逐条对照

| # | 要求 | 实现 | 证据 |
|---|---|---|---|
| ① | 原有客户进度码不失效 | 派生码写 `progress_code_salt/epoch` **两列全新字段**，`progress_token_hash` 不动 | `E13`（哈希仍在）、`E22`（派生后原链接仍 200） |
| ② | 后续进展通知获得有效 22 位 code | `ensureDerivedCode()` 在派工/改派/重排时按需派生 | `E9`（入队 1 条）、`E18`（22 位） |
| ③ | 数据库不保存访问凭据明文 | 只存 salt（22 位 base64url，非凭据）+ epoch（整数） | `E14`（`progress_token_hash` 是 sha256，非明文） |
| ④ | 客户进度凭据仅具进度读取权限 | `resolveTicketId()` 是唯一入口，只被公共进度查询使用 | `E24`（打师傅接口 401） |
| ⑤ | 不允许进度码进入师傅作业接口 | 派生码**从不**写入 `service_visits.short_code_hash`，结构上无法命中 | `E25`（师傅总览 404） |
| ⑥ | 遵守原客户查询期限 | 两类凭据在 `resolveTicketId()` 里**共用同一段**过期判定 | 代码同源，无分支 |
| ⑦ | 同一业务事件不重复生成/发送 | `ensureDerivedCode()` 抢写 `WHERE salt IS NULL`，同单同码 | `E26`（多次派生盐不变） |
| ⑧ | 22 位与 43 位客户进度链接继续兼容 | `PATTERN_ANY` 同时接受两种长度；先查哈希再查派生 | `E5`（22 位原链）、`E20`（派生）、`E21`（同一 ticket_no） |

### 2.3 关键实现（`progress-service.ts`）

```ts
deriveCode({ ticketId, salt, epoch }): string | null {
  const secret = signingSecretOf(process.env);
  if (!secret) return null;                       // fail-closed，不抛错
  const message = `progress-code|${ticketId}|${salt}|${epoch}`;
  return crypto.createHmac('sha256', secret).update(message)
    .digest().subarray(0, PROGRESS_DERIVE.BYTES).toString('base64url');
}
```

- **域前缀 `progress-code|`**：防止派生结果与其它 HMAC 用途（如签名）撞值。用例 `D7` 专门验证"改域前缀则结果不同"。
- **`timingSafeEqual` 比对**：避免用字符串比较泄露时序信息。
- **解析双路**：先按 `sha256(token)` 查 `progress_token_hash`（命中即原始凭据），未命中再走派生码匹配（`credentialKind = 'derived_code'`）。两类**共用同一段**吊销/过期判定，因此不存在"派生码绕过过期"的缝。

### 2.4 撤销语义（与原始 Token **完全隔离**）

`revokeDerivedCodes(ticketId, reason)` 使 `progress_code_epoch += 1`（上限 `MAX_EPOCH=1000`）。

- 撤销派生码 ⇒ 派生码立即 401；**原始链接不受影响仍 200**（`E28` / `E29` 同时证明）。
- 复原 epoch ⇒ 派生码重新可用（`E30`）。因为它是**确定性重算**，不需要"找回"。

### 2.5 派生码匹配的成本与熔断（DEV-207）

A4 要求"不存明文 + 不存派生码哈希 + 可随时重算"三者同时成立，⇒ **无法按派生码建索引查找**，只能遍历带 salt 的工单逐个 HMAC 比对。这是 A4 的固有代价，本轮已量化：

| 候选行数 | 纯 CPU 耗时 |
|---|---|
| 500 | 2.95 ms |
| 1,000 | 6.74 ms |
| 2,000 | 9.25 ms |
| 5,000（上限） | **14.49 ms** |

- 线性增长，无退化。
- `DERIVE_SCAN_CAP = 5000`；候选行数超上限 ⇒ `logger.error` + **返回 null（拒绝判定）**，不退化为无上限扫描。
- **风险窗口**：当"带 salt 的工单数"逼近 5000 时，派生码解析会开始失败，且**表现为 401（与"码错"不可区分）**。容量规划需跟踪：`SELECT count(*) FROM service_tickets WHERE progress_code_salt IS NOT NULL;`。
- 消除上限的路径（**本轮不做**，需改契约）：① 存 `sha256(派生码)` + 唯一索引；② 把 epoch/salt 编进短码前缀做分桶。

当前本地库：`has_salt = 0`（E2E 夹具已清理，见 §6.4）。

---

## 3. 修改文件及 diff

本轮 R1 实际改动 **9 个文件**（全部为 2026-11-06 10:21–10:53 的修改）：

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/server/constants.ts` | 客户两条模板 `{token}`→`{code}`；新增 `PROGRESS_DERIVE` 常量块；新增错误码 `SMS_UNRENDERED_VARIABLE` | 契约 |
| `src/server/collections/serviceTickets.ts` | 新增 `progress_code_salt`（varchar 32, nullable）、`progress_code_epoch`（int, NOT NULL, default 0）；`indexes` 增 `progress_code_salt` | 模型 |
| `src/server/migrations/202611062-progress-derived-code.ts` | **新增文件**：加两列 + 补默认值 | 迁移 |
| `src/server/services/progress-service.ts` | 新增 `deriveCode` / `ensureDerivedCode` / `revokeDerivedCodes` / `matchDerivedCode`；`resolveTicketId` 改为双路解析 | 核心 |
| `src/server/services/ticket-service.ts` | `enqueueDispatchPair` 参数 `progressToken` → `deriveProgressCode`；3 处调用点改传派生器；新增 `setProgressCodeDeriver` | 核心 |
| `src/server/services/sms-service.ts` | 新增**闸 2.6**（悬空凭据链接）+ `findDanglingCredentialLink()` + `KNOWN_TEMPLATE_KEYS` | 防御 |
| `src/server/actions/public/ticket.ts` | `progress_link` 入队参数 `token:` → `code:` | 契约 |
| `src/server/plugin.ts` | 装配派生器：`tickets.setProgressCodeDeriver(...)` | 装配 |
| `docs/DEVIATIONS.md` | 新增 DEV-206 / DEV-207 | 留档 |

**关键 diff 摘要：**

```diff
# constants.ts —— 只改变量名
- '…请点击查看：https://sh.scqfls.cn/p/{token}'
+ '…请点击查看：https://sh.scqfls.cn/p/{code}'
- '…查看处理进度：https://sh.scqfls.cn/p/{token}'
+ '…查看处理进度：https://sh.scqfls.cn/p/{code}'

# ticket-service.ts —— 从"拿不到明文就跳过"改为"按需派生"
- progressToken?: string | null;
+ deriveProgressCode?: ((ticketId, source, transaction?) => Promise<string|null>) | null;
- if (params.progressToken) { … enqueue({ params: { ticket_no, token: params.progressToken } }) }
+ progressCode = await params.deriveProgressCode(ticketId, `dispatch:${SMS_SCENE.PROGRESS_UPDATE}`, params.transaction);
+ if (progressCode) { … enqueue({ params: { ticket_no, code: progressCode } }) }
```

**构建门禁**：`[ts-baseline] 基线 219 条 → 当前 219 条（101 键）`，**无新增诊断**；源文件 193 个；迁移 20 个（原 19，+1）；产物 `1527.0 KB`。

---

## 4. 数据库和密钥影响范围

### 4.1 数据库变更（仅两列 + 一个索引）

| 对象 | 定义 | 说明 |
|---|---|---|
| `progress_code_salt` | `varchar(32) NULL` | `base64url(16B)` 随机盐，22 字符。**非凭据**——单靠它推不出码，秘密在 `SIGN_SECRET` |
| `progress_code_epoch` | `integer NOT NULL DEFAULT 0` | 撤销派生码 = +1。**刻意 NOT NULL**：可空会让"从未派生"与"值丢失"无法区分，前者跳过、后者必须报警 |
| 索引 | `service_tickets_progress_code_salt` | 由集合定义 `indexes: []` 产生（见 §4.3） |

**迁移**：`202611062-progress-derived-code.ts`，`on = 'afterLoad'`，全部语句幂等（`ADD COLUMN IF NOT EXISTS` / `UPDATE … WHERE IS NULL`）。
**回滚**：`down()` 删两列 ⇒ 派生码全部失效（**预期行为**，可随时重算）；`progress_token_hash` **不受影响**，历史链接继续可用。

**对存量数据的影响**：零行被修改（`has_salt` 全为 0，`epoch` 全为 0）。本地库表规模变化见 §6.4。

### 4.2 密钥影响：**不新增任何密钥**

| 项 | 状态 |
|---|---|
| `SIGN_SECRET` | **复用现有**（本地已配置，长度 64）。派生码用它做 HMAC 密钥 |
| 新增密钥 | **无** |
| 密钥轮换影响 | 换 `SIGN_SECRET` ⇒ **所有派生码立即失效**（服务端按新密钥重算得到不同结果），但**原始 22/43 位 Token 完全不受影响**（它们走 sha256 哈希，与密钥无关）。这是一条需要写进运维手册的行为 |
| 缺失密钥 | `SIGN_SECRET` 为空 ⇒ `deriveCode()` 返回 `null`（fail-closed，不抛错、不降级成弱算法）；production 下 `profile.ts` ④ 直接拒绝启动 |

### 4.3 ⚠️ 本轮修掉的重复索引 + 死代码（DEV-206）

第一版 migration 里**手写**了一条 `CREATE INDEX … WHERE salt IS NOT NULL`，而集合定义的 `indexes: []` 里**也**声明了同一字段 ⇒ 库里出现**两条**语义重复的索引，写入双倍维护。

**实测发现的更严重事实**：清空唯一索引 + 删迁移登记 + 重启后，重建出来的是 **NocoBase 那条**（`service_tickets_progress_code_salt`）。日志明确打出：

```
[migration 202611062] progress_code_salt 已有索引 service_tickets_progress_code_salt，跳过重复创建
```

⇒ **`db.sync()` 发生在 `afterLoad` migration 之前**，migration 里那段建索引代码**永远执行不到**，是死代码。

**处置**：① 删除 migration 里的建索引逻辑，索引所有权单点归 `serviceTickets.ts` 的 `indexes: []`；② `down()` 保留 `DROP INDEX IF EXISTS i_service_tickets_progress_code_salt` 作历史兜底；③ 本地库删除重复索引，`pg_indexes` 恢复为 **1 条**。

**教训**：`IF NOT EXISTS` 的"幂等"在这里**掩盖了重复**——不报错、不告警，索引就悄悄多出一条。

---

## 5. outbox / `request.preview` / `sms_logs` / HTTP 日志 凭据安全审计

### 5.1 结论：**未发现任何凭据明文持久化**

| 介质 | 是否落盘 | 是否含凭据 | 证据 |
|---|---|---|---|
| `sms_logs` | 是 | **否** | 表内**没有正文列、没有参数列**（仅 `error_message`）。全表 `~ '[A-Za-z0-9_-]{43}'` 命中 **0 行** |
| `sms_logs.error_message` | 是 | **否** | 实际内容仅 3 类：`短信通道未就绪（sms.enabled=false）` / `分诊失败：…resolve is not a function` / `scene "progress_link" 不在可无损重建白名单里…` |
| `request.preview`（`SmsSendRequest`） | **否** | 含正文但与凭据同体 | 只存在于**内存**中的待发送对象；`insertPending()` **不持久化** `params`。正文由 `renderSmsPreview()` 现场生成 |
| SMS outbox / 重试队列 | — | — | **无此表**（`to_regclass('public.sms_outbox')` = false）。重试语义挂在 `sms_logs.send_status` 上 |
| `service_tickets.progress_token_hash` | 是 | **否** | sha256 摘要（`E14` 断言"非明文"） |
| `service_tickets.progress_code_salt` | 是 | **否** | 随机盐，需配合 `SIGN_SECRET` 才能派生 |
| `service_tickets.extra_json` | 是 | **否** | 全表 `~ '[A-Za-z0-9_-]{43}'` 命中 **0 行** |
| `ticket_events.metadata_json` | 是 | **否** | 全表 `LIKE '%/p/%'` 命中 **0 行** |
| HTTP 请求日志 | — | **否** | nginx `service.conf` 该 server 块 `access_log off`；进度链接是 **GET + path 参数**，不落入查询串 |
| `sms_logs.recipient_masked` | 是 | **否** | 形如 `139****6619`，已脱敏 |

### 5.2 唯一"凭据与正文同体"的地方，以及为什么它安全

短信正文**必须**包含可点击的凭据链接——这是产品需求，无法避免。它落在两处：

1. **内存中的 `SmsSendRequest.preview`**：生命周期 = 一次发送调用；不写库、不写日志（日志只打 `scene`、`ticket_no`、脱敏手机号）。
2. **`renderSmsPreview()` 的返回值**：直接交给 provider 的 `c=` 参数。

⚠️ 但这意味着：**任何在 `logger` 里打印 `preview` 或 `params` 的代码，都会把凭据写进日志**。本轮新增的日志全部只打**字段名/工单号/失败原因**，不打值。这条约束需要写进工程规范。

---

## 6. 端到端测试：客户首次与后续进度短信

### 6.1 全链路结果（`.tmp-verify/r1-e2e.mjs`，**31/31**）

真实 HTTP，走本地 nginx → app → PG：

```
✓ E1  建单 201                    ✓ E2  工单 FW20261106-0011
✓ E3  响应体返回原始 Token（22 位） ✓ E4  响应带门店名、不回 code
✓ E5  原始进度链接可查 200         ✓ E6  progress_link 落库 accepted
✓ E7  后台登录 200                ✓ E8  派工 200
✓ E9  派工后 progress_update 已入队（这是 R1 要修复的核心）
✓ E10 改派 200                    ✓ E11 派生盐已落库（22 位）
✓ E13 原始 Token 哈希仍在（A4 ①） ✓ E14 库内无明文
✓ E15 progress_update 正文逐字符合模板
✓ E16 progress_link 正文逐字符合模板
✓ E17 两条正文均无未替换变量
✓ E18 派生码 22 位                ✓ E19 派生码 ≠ 原始 Token
✓ E20 **派生码可查同一张工单 200**  ✓ E21 两者返回同一 ticket_no
✓ E22 派生后原始链接仍 200
```

### 6.2 "首次与后续"两次进度通知都拿到有效链接

修复前，`progress_update` 会打：

```
[sms] progress_update 跳过：工单 … 无可用进度 Token 明文（待裁决：BE-03-SMS-TEMPLATE-02 §阻塞项 A）
```

**一条都不发**。修复后同一工单连续 5 条业务短信全部 `accepted`，且两次 `progress_update`（派工 + 改派）各自带**有效短码**：

```
6425 progress_link     139****6619 accepted   ← 建单
6426 progress_update   139****6619 accepted   ← 派工（首次进度）
6427 technician_task   138****9999 accepted
6428 progress_update   139****6619 accepted   ← 改派（后续进度）
6429 technician_task   138****8888 accepted
6430 technician_assignment_cancelled 138****9999 accepted
```

`E20`/`E22` 证明：**客户用第一次和后续的链接都能查到同一张工单**。

### 6.3 `technician_task` 审核闸隔离验证（`.tmp-verify/r1-gate-technician.test.mjs`，**11/11**）

| 关键断言 | 结果 |
|---|---|
| G1 通道是真的短信宝实现（`name=smsbao`，非 mock） | ✓ |
| G3 待审核名单含 `technician_task` | ✓ `["technician_task"]` |
| G4 `progress_update` **不在**名单（已审核，必须能发） | ✓ |
| G6 **对照组**：`progress_update` 经同一 provider 发送成功 | ✓ `accepted=true` |
| G8 闸 3 条件成立 ⇒ `technician_task` 不会被提交 | ✓ |
| G9 **反证**：绕过闸 3 直接调 provider **是能发成功的** | ✓（证明拦住它的是闸门，不是故障） |
| G10 `technician_task` 正文与审核版逐字一致 | ✓ |

**供应商调用次数：2，全部打到注入的假 `fetch`，零真实网络。**
G9 这条反证是关键——它排除了"发送本来就是坏的，所以看起来像被闸住了"这种假绿。

### 6.4 数据库变更与清理记录（审计留痕）

本轮 E2E 在本地库生成夹具，**已按用户"不改生产数据"的纪律在本地清理**，清理前后逐表计数留档：

| 表 | 清理前 | 本轮夹具 | 清理后 |
|---|---|---|---|
| `service_tickets` | 500 | 11 | **489** |
| `sms_logs` | 808 | 23 | **785** |
| `ticket_events` | 1,895 | 39 | **1,856** |
| `service_visits` | 285 | 5 | **280** |

清理后核对：`residual_tickets=0`、`idx=1`（重复索引已消）、`max_ticket_id=6860`（回到存量水位）、`epoch_bumped=0`。

---

## 7. 🔴 本轮自己引入并修掉的生产级缺陷：连接池自死锁

**必须单独成章**——它的机制会复现，而且症状完全不像"死锁"。

### 现象
`POST /api/svc:dispatch` 在**精确 60,031 ms** 后返回 500：

```
SequelizeConnectionAcquireTimeoutError: Operation timeout
  ← SequenceService.bump
  ← VisitService.create
```

### 诊断
`pg_stat_activity` 显示：

| 状态 | 持续 | 语句 |
|---|---|---|
| `idle in transaction` | 12 分钟 | — |
| `idle in transaction` | 7 分钟 | — |
| `active` / `wait_event_type=Lock` / `transactionid` | — | `UPDATE "service_tickets" SET "progress_code_salt"=$1 …` |

### 根因
`ensureDerivedCode()` 被调在 **`enqueueDispatchPair()` 内部**，而外层事务已经通过 `SELECT … FOR UPDATE` 持有了该行的行锁。派生逻辑去**连接池借第二个连接**执行 `UPDATE service_tickets` ⇒ 第二个连接等第一个连接释放行锁，第一个连接等调用返回 ⇒ **自己等自己**，两个连接被钉死，池耗尽，此后**所有**请求 500。

### 修法
把 `transaction` 一路透传下去，让派生写入**复用同一事务的连接**：

```ts
// 签名放宽
ensureDerivedCode(ticketId, source, transaction?: unknown)
  → repo.findOne({ filter: { id }, transaction })
  → repo.update({ filter: { id, progress_code_salt: null }, values: {…}, transaction })

// 调用方把外层事务交下去
progressCode = await params.deriveProgressCode(ticketId, `dispatch:…`, params.transaction);
```

修复后：`dispatch` 200、`progress_update` 入队、E2E 由 30/31 → **31/31**。

### 机制级教训（这条比 bug 本身重要）
> **在持有行锁的事务里，任何"顺手写同一张表"的调用，都必须共用同一个事务对象。**
> 连接池 + 行锁的组合下，跨连接嵌套写入 = 自死锁，而它的报错是 `ConnectionAcquireTimeout`（看起来像"数据库慢"），不是"死锁"。
> **潜伏风险**：今后任何在 `enqueueDispatchPair` 内部新增 `service_tickets` 写操作的代码，都会掉进同一个坑。已在函数处留注释。

---

## 8. 新旧链接兼容测试

| 凭据形态 | 长度 | 存储方式 | 兼容性证据 |
|---|---|---|---|
| 原始 `PROGRESS_TOKEN` | 22 | sha256 → `progress_token_hash` | `E5` 200 |
| **A4 派生码** | 22 | 不存（salt + epoch 重算） | `E20`/`E21` 200，返回同一 `ticket_no` |
| 历史 `LEGACY` Token | 43 | sha256 → `progress_token_hash` | `PATTERN_ANY` 接受两种长度，解析路径同 `E5` |
| 随机 22 位（未授权） | 22 | — | `E23` **401**（不是 200，也不是 500） |
| 派生码打师傅接口 | 22 | — | `E24` **401** / `E25` **404** |

`PATTERN_ANY` 是同一个正则同时接受 22 与 43，因此 nginx 与 H5 前端**零改动**。

### 8.1 新增闸 2.6：拦截"链接后没有凭据"（`.tmp-verify/r1-gate.test.mjs`，**15/15**）

双向 fixture，**含变异测试**：

- N1–N6（负例）：正常正文 / `/p/` 带 22 位 / `/p/` 带 43 位 / `/p/t/` 带 22 位 / 非链接场景 ⇒ **均不拦**
- P1–P7（正例）：`/p/` 空、`/p/t/` 空、`/t/` 空、`/f/` 空、短于 16 位、含非法字符 ⇒ **均拦下**
- **X1**：`/p/t/` 不被 `/p/` 规则吃掉（判据顺序陷阱）
- **F1 变异测试**：把判据换成"永远放行" ⇒ 7 条正例**全部翻红** ⇒ 证明这个 fixture 真的有区分力

错误码 `SMS_UNRENDERED_VARIABLE` 的错误信息里会附带**可疑的未识别参数键名**（只打键名，不打值），便于定位"是不是变量名写错了"。

---

## 9. 尚未解除的发布门禁

### 9.1 本轮未做，且**必须不做**（用户明令）

| 项 | 状态 |
|---|---|
| 真实短信发送 | ❌ 未做（provider 调用全部打到注入的假 fetch） |
| 生产数据库变更 | ❌ 未做 |
| 生产部署 | ❌ 未做 |
| 生产迁移执行 | ❌ 未做 |
| 生产 Nginx 修改 | ❌ 未做 |
| commit / push | ❌ 未做 |

### 9.2 阻塞发布的问题（按严重度）

| # | 门禁 | 状态 | 说明 |
|---|---|---|---|
| 1 | **短信宝模板审核未通过** | **BLOCKED** | `technician_task` 仍在 `SMS_REVIEW_PENDING_SCENES`，送审即被闸 3 拦。这是**外部前置条件**，代码侧无法解除 |
| 2 | **微信真机验证** | **NOT DONE** | 本轮全部结论均为 Chromium / HTTP 层。**不得**用 Chromium 结果代替真机 |
| 3 | `BUILD-TS-GATE-01` | 未修 | `prebuild-guard.mjs` 对比的是过期的 `admin-base/`；`build-plugin.mjs` 有硬编码绝对路径；`preflightTs2741()` 未被调用；`plugin.ts` 不在 guard 列表 |
| 4 | `P6-API-DTO-SENSITIVE-01` | 未修 | DTO 下发 `feedback_token_hash` / `progress_token_hash`（哈希非明文，但没必要下发） |
| 5 | A4 扫描上限容量风险 | **需监控** | 见 §2.5。逼近 5000 张带 salt 的工单时，派生码解析会静默变成 401 |
| 6 | 密钥轮换行为未写入运维文档 | 待补 | 换 `SIGN_SECRET` ⇒ 全体派生码失效（原始 Token 不受影响）。这是**预期行为**，但必须运维知悉 |
| 7 | P0-1 剩余 | 未修 | 500 字符上限、五个 `service_results` 枚举、历史 NULL 处理 |
| 8 | P0-2 剩余 | 未修 | 跨门店、7 天过期、localStorage 不可用 |
| 9 | BE-05 KPI 下钻 + Excel 导出 | 未做 | — |

### 9.3 本轮新增的两条偏差记录

- **DEV-206**：同一列被建了两条索引（集合定义 + migration 各写一遍），其中 migration 那条**因执行顺序而永远执行不到**。
- **DEV-207**：派生码解析是**有上限的全表扫描**，成本必须量化，且要给出"触及上限时的行为"。

---

## 10. 验收套件总览

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `be03-sms-template02.test.mjs` | 正文契约 + 变量名契约（V1–V10）+ `deriveCode`（D1–D12） | **55/55** |
| `r1-gate.test.mjs` | 闸 2.6 双向 fixture + 变异测试 | **15/15** |
| `r1-e2e.mjs` | 真实 HTTP 全链路（建单→派工→改派→撤销） | **31/31** |
| `r1-gate-technician.test.mjs` | 审核闸 + provider 隔离（含对照组与反证） | **11/11** |
| `r1-scan-cost.test.mjs` | 派生码解析成本量化（500–5000 行） | **6/6** |
| **合计** | | **118/118** |

另有 `r1-final-render.mjs`：改为从运行时产物取渲染器，但产物**未导出** `renderSmsPreview`（内部函数），故未产出独立断言——渲染逐字对照的证据由 `V5`/`V6`/`E15`/`E16` 已有覆盖，**未以"跑通了"冒充"验证过"**。

---

## 11. 申请

**请予专项验收。** 本轮不自动部署生产。

如准予进入下一阶段，建议顺序：
1. 先解除门禁 #1（短信宝模板审核）—— 这是唯一的外部阻塞。
2. 补 #2 微信真机验证（单独排期，不与本轮结论混用）。
3. 修 #3/#4 两个技术债（都不影响功能，但会持续污染构建门禁的可信度）。
4. 上线前把 #5 的监控指标纳入运维看板。
