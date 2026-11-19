# BE-03-S6 · 短信宝消息标识映射 + 历史队列风险核查

> 日期：2026-10-28　状态：**代码完成 / 单元与变异自证通过 / 未部署**（等单独批准）
> 生产状态：`sms.enabled=false`、`sms.provider=smsbao`、`retry_count=1`；本轮**零真实短信**、未改任何配置、未重启容器。

---

## 1. 结论先行

| 项 | 结论 |
|---|---|
| `provider_request_id` 为什么恒为 null | **不是缺陷的产物，是语义放错了位置**：短信宝没有"API 调用追踪号"这个概念；它返回的 `msgid` 属于**回执匹配键**，对应内部 `provider_biz_id`（RB-8），不是 `provider_request_id` |
| 短信宝是否真的返回 `msgid` | **官方文档里没有**（见 §2）。代码改为**机会性记录**：真返回了才存，没返回就留空并留痕，**绝不编造** |
| S5 的"`provider_request_id=null`"证据可信吗 | **不可信（两个原因）**：① 适配器当时确实没读 ID；② 联调脚本读的是 `res.requestId`，而结果字段叫 `providerRequestId` ⇒ 即使读到也会打印 null。见 DEV-203 |
| `pending=842` 是真的队列积压吗 | **不是。`send_status='pending'` 实际为 0**；842 是 `sms_logs` 的**总行数**，而 `delivery_status='pending'` 恰好等于全表（回执从未回填）。见 §4 与 DEV-204 |
| 打开 `sms.enabled` 会涌出多少存量短信 | **0 条**。认领谓词要求 `send_status ∈ {pending, error}`，两者都是 0 |
| 历史一次性链接会被重发吗 | **不会**。`progress_link` 在"一次性凭据"硬闸里，295 条孤儿已按 `ORPHAN_UNREBUILDABLE` / `ORPHAN_TOKEN_LOST` 落终态 |

---

## 2. 短信宝接口的**事实边界**（2026-10-28 逐条核对官方文档）

来源：<https://www.smsbao.com/openapi/213.html>（《发送国内短信接口API》）

| 事实 | 原文 / 实际 |
|---|---|
| 请求参数只有 5 个 | `u`（用户名）、`p`（密码 MD5 **或** ApiKey）、`g`（专用通道产品 ID，可选）、`m`（号码）、`c`（UTF-8 URLENCODE 的**完整正文**） |
| **没有 `f` 参数** | 文档参数表里不存在 `f`。项目里 `query.set('f','json')` 属**我们自己加的**，官方未定义 ⇒ 只能当"也许被忽略"的尝试，**不能当契约** |
| 返回是**纯文本** | 「返回 '0' 视为发送成功，其他内容为错误提示内容」 |
| **没有任何消息 ID 字段** | 文档全文无 `msgid` / `msg_id` / `MessageId` |
| **没有送达回执接口** | 只有"短信接收推送"（客户回复上行），没有状态报告/回执回调 |

⇒ 因此本模块对 `msgid` 的处理只能是**机会性兼容**，不能声称"按官方契约映射"。

### 2.1 存储契约（本次固化）

```
SmsSendResult.providerBizId    ←→  sms_logs.provider_biz_id   （回执匹配唯一键，RB-8）
SmsSendResult.providerRequestId ←→ sms_logs.provider_request_id（API 调用追踪号）
```

- 短信宝：`msgid` → **`provider_biz_id`**；`provider_request_id` 恒 `null`。
- 阿里云：`BizId` → `provider_biz_id`，`RequestId` → `provider_request_id`（**行为未变**）。

**为什么不把 `msgid` 同时写进 `provider_request_id`**：那会给两列赋予同一个假语义。将来谁拿
`provider_request_id` 做幂等/对账，都会以为"什么都能对上"，而实际上只有回执键那一路有意义。
**空缺是诚实的信息，重复值才是隐患。**

### 2.2 不编造规则（三条硬约束）

1. 取不到就 `null`，**不**用 `biz_id` / 时间戳 / 随机串补。
2. `provider_biz_id` 是 `varchar(64)` ⇒ 超长**不截断**（截断后的 ID 与供应商侧不同，回执永远匹配不上，而"列里有值"会让人以为匹配键是好的），留空并单独留痕 `messageIdTooLong`。
3. 只认标量（string/number）；对象/数组忽略，避免把 `[object Object]` 写进库。

### 2.3 机会性字段候选（**非契约**）

`msgid` → `msg_id` → `messageid` → `message_id`，取第一个非空标量。

⚠️ 这一层存在的理由：`f=json` 虽无官方定义，但**可能**被某些接入形态回 JSON。若真回，就顺手记下；
若不回（当前最可能），`0` 的纯文本分支照旧工作，且日志会打出**顶层字段名**（只打键名、不打值），
让**下一次被授权的真实发送**自动变成"真实响应结构"的证据。

---

## 3. 本轮代码改动（4 处，均可逆）

| 文件 | 改动 | 目的 |
|---|---|---|
| `services/sms-provider.ts` | 新增 `parseSmsbaoBody()`（纯函数）+ `PROVIDER_ID_MAX_LEN` + `SMSBAO_ID_FIELDS` | 把解析从 `send()` 里剥出来，**可被隔离夹具直接喂**；解析口径单点 |
| 同上 | 成功分支：`providerBizId = parsed.messageId`，补 `deliveryStatus:'pending'`（原来**缺这个必填字段**） | ID 真正落库；修 TS2741 |
| 同上 | `reject()` 补 `deliveryStatus:'pending'` | 同上 |
| 同上 | 新增**生产路径**双层括号自检：正文含 `【【` / `】】` ⇒ `SMSBAO_SIGN_FORMAT_INVALID`，**提交前**拒发 | 此前该判据只在联调脚本里，等于没有（DEV-201 同族） |
| `actions/svc/insight.ts` | `recent[]` 增 `provider_biz_id` | 修好了要看得见 |
| `client/hq-pages.tsx` | 「最近 30 条日志」增「供应商标识」列（`provider_biz_id` → `provider_request_id` → `-`） | 同上 |

### 3.1 被"修好"的一个隐性缺陷：`deliveryStatus` 必填字段被 esbuild 吞掉

`SmsSendResult.deliveryStatus` 是**必填**（类型即约束：受理 ≠ 送达）。短信宝的两个 return **都没写它**。

| 门禁 | 是否发现 |
|---|---|
| `build-plugin.mjs`（esbuild，只转译） | ❌ 通过 |
| `verify-types.mjs` | ⚠️ tsc **报了** `TS2741`（`sms-provider.ts(612,9)`、`(652,5)`），但该类**不判红**（只判 TS2304/TS2552 + 宿主包白名单） |

⇒ 实测：修复前 `TS2741 ×21`，修复后 **`×19`**，且 `sms-provider.ts` 的诊断归零。
这两个数字就是这条改动的**正反证据**（不是"我觉得补上更好"）。

---

## 4. 队列风险核查（只读，2026-10-28 04:0x UTC）

数据来源：`GET /api/smsLogs:list`（`meta.count` + 结构字段），**未执行任何 SQL 写操作**。

### 4.1 口径纠错（这是本轮最重要的发现）

| 指标 | 值 | 说明 |
|---|---|---|
| `sms_logs` 总行数 | **842** | 这正是被误称为"pending=842"的数字 |
| `send_status='pending'` | **0** | **队列是空的** |
| `send_status='accepted'` | 324 | |
| `send_status='rejected'` | 518 | |
| `send_status='error'` | 0 | 延迟重试只捞 error ⇒ 无可捞 |
| `delivery_status='pending'` | **842** | 全表恒 pending（回执从未回填）⇒ 容易被误读成"842 条待发" |

### 4.2 状态 / 错误码分布

| error_code | 条数 | 含义 |
|---|---|---|
| `SMS_PENDING_ORPHAN_UNREBUILDABLE` | 290 | 孤儿回收：scene 不在可重建白名单 ⇒ **按设计不发** |
| `SMS_DISABLED` | 215 | 总开关关闭期间入队 ⇒ 如实记录未发 |
| `SMS_SCENE_NOT_ALLOWED` | 7 | 场景未放行（历史口径） |
| `SMS_PENDING_ORPHAN_TOKEN_LOST` | 5 | 一次性凭据明文只在内存 ⇒ **不得自动重发** |
| `SMS_TEMPLATE_NOT_CONFIGURED` | 1 | 模板 CODE 缺失被闸拦下 |

**自洽性交叉验证**：`retry_count=1` 的行 = **295** 条，恰好等于 290 + 5。
认领谓词是 `retry_count = retry_count + 1` ⇒ **295 条孤儿各被认领过一次并全部落终态**。
这就是 `pending` 现在为 0 的真正原因：**B-16 孤儿回收任务确实在跑，而且已经把历史积压清干了。**

### 4.3 通道与场景

| provider | 全部 | accepted | rejected |
|---|---|---|---|
| mock | 786 | 322 | 464 |
| **smsbao** | **56** | **2** | 54 |
| aliyun | 0 | 0 | 0 |

- **smsbao 有 2 条 `accepted`**（id 6427 / 6428，`progress_link`，2026-10-22 07:56 / 08:03）。
  ⇒ 此前"从未成功发出过一条真实短信"的说法**不成立**；真实通道受理过 2 条。
  ⇒ 而这两条 `provider_biz_id` 为空（发送时未记录），**永远收不到回执** —— 这正是 §3 要修的那个洞的**历史实例**。
- `progress_link|rejected = 297`（290 + 5 + 2）—— 一次性凭据场景全部按设计落终态，**没有一条被重发**。

### 4.4 打开开关会发生什么（逐条回答）

| 问题 | 答案 | 依据 |
|---|---|---|
| 会有多少存量被认领 | **0** | `SMS_CLAIM_SQL` 前置 `send_status='error'`（0 条）；`SMS_RECLAIM_SQL` 前置 `pending`（0 条） |
| 会重复通知客户吗 | **不会** | 唯一幂等键 `unique(provider, biz_id)`；存量里没有可认领行 |
| `progress_link` 孤儿会被补发吗 | **不会** | `SMS_SCENE_ONE_TIME_CREDENTIAL` 硬闸优先于白名单 |
| 有 TTL / 最大重试吗 | 有：孤儿窗口 `5min`（`SMS_PENDING_ORPHAN_AFTER_MS`）、重试上限 `retry_count=1` | `constants.ts` |
| 打开开关的真实影响 | **只影响"今后新产生"的短信** —— 它们会被真的发出去（短信宝收发正文、不需要模板 CODE） | `requiresTemplateCode=false` |

---

## 5. 验证证据

| 项 | 结果 |
|---|---|
| 隔离夹具 `.tmp-verify/be03-s6-msgid.test.mjs` | **31/31 PASS**（U1–U11 解析、S1–S14 发送、I1–I3 落库参数、R1–R3 其它通道不回归） |
| 变异测试 `.tmp-verify/s6-mutate.mjs` | **6/6 CAUGHT**（M1 不读 ID、M2 不回传、M3 用 bizId 冒充、M4 去掉双括号闸、M5 截断、M6 失败误判 accepted） |
| 变异工具自检 | 锚点必须**命中恰好 1 次**，否则 `TOOL-BROKEN` ⇒ exit 2（不给产品结论） |
| `verify-types.mjs` | 通过；`TS2741` 21 → **19**，`sms-provider.ts` 诊断归零 |
| `prebuild-guard.mjs` | 9 个受管文件 **全部 SAME** |
| 本地构建 | exit 0；server `b786268e45d9c79b`、client `2a91f3aec876f8bd` |
| 产物取证 | server bundle 含 `SMSBAO_SIGN_FORMAT_INVALID` ×1、`SMSBAO_ID_FIELDS`、`parseSmsbaoBody`；client 含「供应商标识」×1 |
| 真实短信 | **0 条**（本轮未发送） |
| 生产配置 | `sms.enabled=false` 未变；未重启、未部署（线上仍是 server `6bc11d5d40e7355d` / client `8a0331146cbb19c2`） |

---

## 6. 未完成 / 需决策

1. **部署未获授权** —— 本轮只到"本地构建通过"。部署需要一次 `docker compose restart app`（远端 `scqf-as-*`）。
2. **`DELIVERY CALLBACK` 仍是 PENDING，且对短信宝可能永远无法实现**：官方没有状态报告接口。
   若确实需要"已送达"，只有两条路：换有回执的通道（阿里云）或人工对账。**这需要用户决策**，不在本轮擅自扩范围。
3. **"真实响应结构"仍缺一份抓包**：本轮不允许发真实短信 ⇒ 只能靠"下一次被授权的发送"自动留痕（日志会打出顶层字段名）。**不要**为了取证而擅自发送。
4. 这两条 `progress_link` 历史 accepted 行的 `provider_biz_id` 永久为空（发送时未记录，回填任何值都是编造）。


---

## 7. 【2026-10-29 增补】新版官方文档核对 → 补解析、补门禁、查回执

### 7.1 事实：新版文档确实定义了 `f` 与 JSON 形态

来源：<https://m.smsbao.com/docs/developer/domestic-sms-api> 与
<https://user.smsbao.com/docs/developer/error-codes>（2026-10-29 核对）

| 项 | 内容 |
|---|---|
| 请求参数 | `u` `p` `m` `c` `g`(可选) **`f`(可选，txt/json)**；不填 `f` 默认 txt |
| txt 成功 | 明文 `0` |
| **json 成功** | `{"code":0,"msg":"短信发送成功","data":{"taskId":"202401011200001"}}` |
| json 失败 | `code` 非 0，`data` 可能为 null |

⚠️ 与旧版文档（`openapi/213.html`）的差异：旧页**没有 `f` 参数、没有 msgid、没有 taskId**。
两版文档同时在线 ⇒ 我们**同时兼容两种形态**，且**不假定**线上一定回 JSON。

### 7.2 顺带修掉一个**既存缺陷**：txt 与 json 的码表**语义不同**

| 码 | txt 含义 | json 含义 |
|---|---|---|
| 50 | 内容含敏感词 | （未定义） |
| 51 | 手机号码不正确 | **内容含敏感词** |
| 52 | （未定义） | 手机号码格式不正确 |

旧实现只有**一张** `SMSBAO_ERROR_CODES`（按 txt 写）。若线上返回 JSON，`51` 会被记成
"手机号不正确"，运维会去改号码 —— **方向被带偏，而 accepted/failed 的判断仍是对的**，
所以这种错误**不会自己冒出来**。
⇒ 改为 `SMSBAO_TXT_ERROR_CODES` / `SMSBAO_JSON_ERROR_CODES` 两张表，由 `parseSmsbaoBody().format` 选择。
另补 txt 文档里原来漏掉的 `42 账号已过期` / `60 尚未充值`。

### 7.3 `data.taskId` 的定位：**只解析、只记日志，不当回执键**

- 官方只说"发送成功时包含**任务 ID**"，**没有公开状态报告字段**，也没说回执会回带它；
- ⇒ 写进 `provider_biz_id` 等于**凭空造一个匹配契约**（而且会让回执消费者永远匹配不上却不报错）；
- ⇒ 现状：解析出 `taskId` → `logger.info('已受理（format=json）taskId=…')`，**两个 ID 列都保持不动**。
  记下来的用处：① 日后对账能对上号；② **日志里的 `format=` 直接揭示账号到底回 txt 还是 json** ——
  这是零成本、零风险的"账号能力探针"，不需要再发真实短信。

### 7.4 本轮**没有**改请求格式

`send()` 里仍是 `u/p/m/c` + `f=json`（这一行在 S3/S4 就已存在，本轮**未新增也未删除**）。
夹具 `J10` 直接断言**请求参数集合 = {u,p,m,c,f}**，防止"顺手改一下"造成格式漂移。

### 7.5 送达状态报告调查结论（只读，官方公开页）

| 问题 | 结论 |
|---|---|
| 公开文档是否提供"状态报告/送达回执"接口 | **没有**。`status-report-api` 页原话："送达状态报告的具体字段和配置方式请以控制台或客服开通说明为准"，"回调字段未在当前公开页面中展开" |
| 是否已开通 / 怎么开 | **无法离线判定**，须登录控制台或在客服处确认；不存在自助接口 |
| 能否按 `taskId` 查状态 | 公开文档**没有**查询接口（只有 `query` 查余额） |
| 上行短信 = 回执吗 | **不是**。上行是"**用户回复**我们"（GET，参数 `m` + `c`=回复内容）；回执是"**平台告诉我们**投递结果"。文档把两者放在不同小节，本项目**不得**把上行当回执 |
| 对本项目的影响 | `delivery_status` 会长期停在 `pending`（842/842），报表里"送达率"**没有真实输入源** |

⇒ 若业务确实需要"已送达"，只有两条路：**换有回执能力的通道**，或**人工在供应商后台对账**。
这是产品决策，不在本轮擅自实现。

### 7.6 新增门禁：TS2741 基线（前置条件 5）

`SmsSendResult.deliveryStatus` 必填却被漏写，暴露了"esbuild 不查类型 + verify-types 只判 TS2304/TS2552"的缝。
新增 `scripts/verify-ts2741-baseline.mjs`：

- 键 = `文件|属性|类型`（**不含行号**，行号会漂移）；
- 基线 `scripts/expected-ts2741.json` = 19 条历史积压（4 个键）；
- **新增键或同键次数变多 ⇒ exit 1，构建中止**；变少 ⇒ 只提示"可收紧基线"；
- 已**焊进** `build-plugin.mjs` 的 preflight（admin-base 与工作区两份都接了）。

**双向自证**：删掉 `reject()` 里的 `deliveryStatus` → 门禁 exit 1 且指名
`sms-provider.ts Property 'deliveryStatus' → SmsSendResult`；还原后 exit 0。
（不是"写完就算有门禁"，是"拿真缺陷喂过一遍它会红"。）

### 7.7 验证增量

| 项 | 结果 |
|---|---|
| 夹具 | **42/42 PASS**（新增 J1–J11：新版 JSON、taskId 隔离、双码表、请求参数锁） |
| 变异 | **8/8 CAUGHT**（新增 M7「taskId 冒充回执键」、M8「JSON 套 txt 码表」） |
| 改动文件 tsc 诊断 | `sms-provider.ts` **0 条**（含 TS2741） |
| 全仓 TS2741 | 19 条 / 4 键，与基线一致 |
