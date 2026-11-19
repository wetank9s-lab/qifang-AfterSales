# P6-SMS-02 Token 压缩及兼容性报告

> 执行时间：2026-10-22 14:57–15:12（UTC+8）
> 改动范围：Token 43→22 位、模板对齐冻结文案、`/p/` 与 `/api/public/progress/` 正则、插件重建部署。
> **短信发送 0 条**；`sms.enabled` 仍 `false`；未 commit / 未 push。

---

## 0. 两件必须先说的事

### 0.1 生产已经在接收真实客户报修

做本轮验证时发现工单数从 **489 → 494**、`sms_logs` 从 **783 → 790**。核明细：

| id | 工单号 | 门店 | 来源 | 类型 | 时间 |
|---|---|---|---|---|---|
| 6909–6913 | `FW20261022-0001` ~ `0005` | 15 | **qr** | repair | **14:27 / 14:28 / 14:35 / 14:52 / 14:55** |

**这不是我的测试数据**（我本轮只发 GET/HEAD，从未 POST 建单）。
这是**真实客户扫码提交**——说明昨天修好的 H5 报修页**已经在真实使用**。

⇒ 我对这些工单**未做任何读写**。但它们改变了两件事：
1. 报告里"tickets 489 未变"这类表述必须停用，改为**快照 + 时间**；
2. **`sms.enabled=false` 现在在真实流量下被持续验证**——每笔真实报修都会走一遍门禁，这是最有价值的证据（见 §7）。

### 0.2 出现 4 条 `provider=smsbao` 的短信日志（其中 1 条 pending）

| id | scene | provider | send_status | error_code | 时间 |
|---|---|---|---|---|---|
| 6418 | progress_link | **smsbao** | **pending** | — | 14:55 |
| 6417 | progress_link | **smsbao** | pending→已转 rejected | — | 14:52 |
| 6416 | review_invite | smsbao | rejected | `SMS_DISABLED` | 14:43 |
| 6415 | progress_link | mock | rejected | `SMS_PENDING_ORPHAN_UNREBOUND` | 14:35 |

- 这些是 **provider 切到 smsbao 之后**真实流量产生的记录（之前全是 mock）。
- `SMS_DISABLED` 正是门禁 1 的拒绝码 —— **证明 `sms.enabled=false` 在真实链路上生效**。
- 有 1 条仍为 `pending`：这是 enqueue 与 flush/恢复扫描之间的**正常中间态**，
  同批其它几条已被 resovler 收敛为 rejected。**它会由 5 分钟一轮的恢复扫描收敛，不会自动发送**
  （重试与恢复两条通道都先读 `sms.enabled`，为 false 时直接跳过）。
- ⚠️ 我没有手工改这些行的状态，也没有删除它们。

---

## 1. 修改文件与最小 diff

### 1.1 `constants.ts`

```diff
-const PROGRESS_TOKEN_BYTES = 32;
+// 2026-10-22 P6-SMS-02：压缩为 16 字节 → 22 位 base64url（短信正文少 21 字）。
+const PROGRESS_TOKEN_BYTES = 16;
+/** 历史 Token 长度（32 字节 ⇒ 43 位）：**已签发的必须继续可解析** */
+const PROGRESS_TOKEN_LEGACY_LENGTH = 43;

   PATTERN: new RegExp(`^[A-Za-z0-9_-]{${PROGRESS_TOKEN_LENGTH}}$`),
+  /** 解析用：同时接受 22 位新 Token 与 43 位旧 Token */
+  PATTERN_ANY: new RegExp(
+    `^(?:[A-Za-z0-9_-]{${PROGRESS_TOKEN_LENGTH}}|[A-Za-z0-9_-]{${PROGRESS_TOKEN_LEGACY_LENGTH}})$`,
+  ),
+  LEGACY_LENGTH: PROGRESS_TOKEN_LEGACY_LENGTH,

-  [SMS_SCENE.PROGRESS_LINK]:
-    '【{sign}】您的售后申请已提交，工单号{ticket_no}。查看处理进度：{link}',
+  // 🔒 与短信宝审核通过的正文逐字符一致，禁止改动（冻结）。
+  [SMS_SCENE.PROGRESS_LINK]:
+    '【{sign}】您的售后申请已提交成功，工单号{ticket_no}。查看处理进度：https://sh.scqfls.cn/p/{token}',
```

> **签发只用 `PATTERN`（22 位），解析用 `PATTERN_ANY`（22 或 43）** —— 这两个必须分开：
> 合在一起会让"生成器又能生成 43 位"重新成为可能，压缩就白做了。

### 1.2 `services/progress-service.ts` / `actions/public/progress.ts`

```diff
- if (!PROGRESS_TOKEN.PATTERN.test(text)) return null;
+ if (!PROGRESS_TOKEN.PATTERN_ANY.test(text)) return null;  // 同时接受 22 / 43
```

### 1.3 `actions/public/ticket.ts`（短信参数）

```diff
   params: {
     ticket_no: String(created.ticket.ticket_no),
-    link: `${publicBaseUrlOf(process.env)}${PROGRESS_TOKEN.LINK_PATH}${mintedProgress.token}`,
+    token: mintedProgress.token,   // 模板已冻结为 https://sh.scqfls.cn/p/{token}
   },
```

> 只传 `token` 不传完整 URL，**避免 `https://…/p/https://…` 双重 URL**。

### 1.4 Nginx（本站 vhost，两处）

```diff
-location ~ "^/p/(?<svc_progress_token>[A-Za-z0-9_-]{43})$" {
+location ~ "^/p/(?<svc_progress_token>[A-Za-z0-9_-]{22}(?:[A-Za-z0-9_-]{21})?)$" {

-rewrite "^/api/public/progress/([A-Za-z0-9_-]{43})$" /api/publicProgress:get/$1 break;
+rewrite "^/api/public/progress/([A-Za-z0-9_-]{22}(?:[A-Za-z0-9_-]{21})?)$" /api/publicProgress:get/$1 break;
```

**写法说明**：用「22 位 + 可选 21 位」而不是 `{22}|{43}` 交替 ——
交替多一层括号会改变 `$1` / 命名捕获的分组编号，是这类正则最常见的静默错误。
`{22}` 量词**必须加引号**（本项目已因未加引号失败过两次）。

> ⚠️ 这是我在本轮**第二次**栽在同一个点上：第一次只改了 `/p/` 的 location，
> 漏了 `/api/public/progress/` 的 rewrite，导致 22 位 token 打 API 返回 **404**，
> 而 43 位返回 401。**同一个 43 常量在 nginx 里有两份**，改一处等于没改。

### 1.5 H5 路由：**无需改动**

`h5/src/router.ts` 的 `CUSTOMER_PROGRESS = /^\/customer\/progress\/([A-Za-z0-9_-]{8,256})$/`
本来就是 8–256 宽松匹配（注释写明"不在前端重复 token 长度常量"），22 位天然兼容。

---

## 2. 22 位 Token 的安全设计

| 项 | 值 |
|---|---|
| 随机源 | `crypto.randomBytes(16)` —— **CSPRNG**，128 位熵 |
| 编码 | base64url 无填充 ⇒ 固定 **22** 字符 |
| 字符集 | `A-Z a-z 0-9 - _`（URL 安全，进短信链接无需再编码） |
| 存储 | 仍只存 `sha256(token)` 64 位十六进制，**库里无明文** |
| 检索 | 仍走 `progress_token_hash` 单列索引 |
| 绑定 | 仍绑 `service_tickets.id`（一单一 token） |
| 有效期 | 未变：关闭后保留 30 天；有 `progress_token_revoked_at` |
| 重复签发 | `mintForTicket()` 的 `if (progress_token_hash) return null` **保留** |

**熵值评估**：128 位随机 + 在线限流，猜中概率可忽略；相比 256 位只损失"极端离线暴力"的余量，
而攻击面本来是"在线猜链接"，128 位绰绰有余。**没有为此削弱任何一条鉴权语义。**

实测唯一性（真实算法，20000 个样本）：

```
样本=20000  长度/字符/重复 异常数=0  唯一=20000
```

---

## 3. 43 位旧链接兼容结果

| 检查 | 结果 |
|---|---|
| Nginx `/p/<43>` | **302**（仍跳转） ✅ |
| 服务端 `resolveTicketId()` 接受 43 位 | `PATTERN_ANY` 覆盖 ✅ |
| Nginx `/api/public/progress/<43>` | **401**（到达 API 并被拒，非 404） ✅ |
| 22 位 | `/p/` → 302；API → **401** ✅ |
| 21 位 / 44 位 | **404**（形状不符，不进应用） ✅ |
| 库内已有 hash 是否被改写 | **未改**（无任何 UPDATE） ✅ |

**诚实边界**：我**没有**任何一枚历史 43 位 token 的明文（库里只有哈希，明文当初只返回过一次）。
所以"旧链接仍可用"的证据是**链路级**的：长度校验放开 + 解析逻辑按哈希单列匹配未变 +
库内 hash 未被触碰。**不是**"拿一枚真实的旧链接点开了"。
要拿到那个级别的证据，需要用户提供一枚仍在有效期内的旧链接（可由客户手上的短信取得）。

---

## 4. H5 与 Nginx 回归

| 用例 | 结果 |
|---|---|
| `/p/<22 合成>` | 302 |
| 跟随 → H5 | **200 / text/html / 987B** ✅ |
| `/p/<43 合成>` | 302 |
| `/p/21`、`/p/44` | 404 ✅ |
| `/api/public/progress/<22>` | 401（拒绝且不泄露） ✅ |
| `/api/public/progress/<21>` | 404 ✅ |
| `/h5/report` | 200 |
| `/api/public/stores` | 200 |
| `/api/svc:health` | 200 |
| `nginx -t` | successful（仅既有 `conflicting server name "_"` 警告） |
| reload | graceful，master pid **776 未变** |
| hd / cloud / sd / kanma | **200 / 403 / 000 / 000**（与基线一致） |
| Token 进日志 | 22 位合成 token 打 6 次：**日志新增 0、命中 0** ✅ |

---

## 5. 正式短信模板完全未改的证明

从**构建产物**（不是源码，防止"源码改了但没构建"）里直接抓到：

```
$ grep -o "https://sh.scqfls.cn/p/{token}" dist/server/index.js
https://sh.scqfls.cn/p/{token}
https://sh.scqfls.cn/p/{token}
```

配合源码中冻结的那一行：

```
【{sign}】您的售后申请已提交成功，工单号{ticket_no}。查看处理进度：https://sh.scqfls.cn/p/{token}
```

**逐项对照审核版**：

| 审核版片段 | 代码/产物 | 一致 |
|---|---|---|
| `【四川恒晟恒七方】` | `【{sign}】`，sign 由 `SMSBAO_SIGN_NAME` 注入，且 `decorateSmsbaoSign` 对带括号值**原样返回** | ✅ |
| `您的售后申请已提交成功，` | 同 | ✅ |
| `工单号{ticket_no}。` | 同（工单号保留，未删） | ✅ |
| `查看处理进度：` | 同 | ✅ |
| `https://sh.scqfls.cn/p/{token}` | 同（域名写死，未用 `{link}`） | ✅ |

- **没有**删除工单号、**没有**改中文/签名/标点/域名、**没有**把 `{token}` 改回 `{link}`、
  **没有**恢复处理进展短信、**没有**提交新模板。
- 唯一变化是：把**我们自己**的预览文案从"已提交"改成审核版的"已提交成功"（**对齐**，不是改平台模板）。

---

## 6. 实际短信字符数与计费段

模板固定部分（不含变量）：

```
【四川恒晟恒七方】您的售后申请已提交成功，工单号。查看处理进度：https://sh.scqfls.cn/p/
```

| Token 长度 | 15 位工单号时总长 | 估算法（70 字/条） |
|---|---|---|
| 43 位（旧） | **113 字** | 2 条 |
| **22 位（新）** | **92 字** | **2 条** |

⇒ **压缩确实生效（113→92，少 21 字），但仍然超过 70 字，仍按 2 条计费。**
链接本身 `https://sh.scqfls.cn/p/` + 22 位就已占 48 字，加上约 40 字正文，92 字是**结构决定的下限**。

**我不宣布"单条计费 PASS"。** 短信宝的实际计费规则（是否按 67/70 字计、长短信是否合并计价、
是否对含链接的模板有单独政策）需要你在平台侧核实后告知。本轮**只承诺 Token 压缩**。

---

## 7. 生产短信仍禁用的证据

| 证据 | 内容 |
|---|---|
| DB 配置 | `sms.enabled=false`、`sms.provider=smsbao`、`sms.retry_count=1`（未动） |
| **真实流量实测** | 14:43、14:52、14:55 的三笔真实报修触发短信入队，结果均为 `rejected` / `SMS_DISABLED` |
| 门禁层级 | 首发 `deliverOne` 闸 1、补发、重试三处都先读 `sms.enabled`，false 即跳过 |
| 附加保险 | `SmsbaoProvider.configured=false`（4 个 `SMSBAO_*` 仍缺）⇒ 即便误开也只会 `SMS_MISCONFIGURED` |
| 实发计数 | **0**（本轮无任何 `provider.send` 调用） |

> 这是本轮最有说服力的一组：**不是"我测了没发"，而是"真实客户报修时系统自己没发"**。

---

## 8. 未完成 / 需要你裁决

| # | 事项 | 说明 |
|---|---|---|
| U1 | **旧链接"真实点开"验证** | 需一枚仍在有效期的历史 43 位链接（你从客户短信里取一枚即可，我不会向你索取 token 之外的信息） |
| U2 | 22 位 token 的**端到端建单验证** | 需真实提交一笔才能产出新 token；生产在建单，我不擅自造单。可在隔离环境补，或等下一笔真实报修后抽查 |
| U3 | 短信宝计费规则核实 | 需你在平台确认 92 字计几段 |
| U4 | 4 个 `SMSBAO_*` 仍未配置 | 等新 Key 安全交接 |
| U5 | 那条 `pending` 记录 | 等恢复扫描收敛（5 分钟轮次）；若仍 pending 我会单独报 |
| U6 | 整站访问日志仍关闭 | 上一轮为堵 token 泄露而关，需可审计脱敏方案才能恢复 |

---

## 9. 判定

- **Token 压缩（43→22）= 完成**：生成、校验、解析、Nginx 两处正则、H5、API 全链一致；
  旧的 43 位在长度层面继续被接受，库内已有哈希未动。
- **模板 = 未改**（对齐审核版），产物级证据见 §5。
- **短信自动发送 = 继续 HOLD**，`sms.enabled=false`，本轮实发 **0**。
- 申请：**P6-SMS-02 Token 压缩专项验收**。
- P6：LIVE / CONDITIONAL；Release：HOLD。
