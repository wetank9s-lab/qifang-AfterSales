# P6-SMS-02 双模板业务接入 · 预检与适配报告

> 执行时间：2026-10-22 14:24–14:32（UTC+8）
> 本轮范围：源码核对、离线适配、`/p/` 短链修复与公网验证、旧队列审计。
> **未启用发送、未发送任何短信、未使用任何 API Key。**
> 判定：**READY FOR CONTROLLED TEST 未达成** —— 仍有 4 项阻断（见 §12），申请 **HOLD**。

---

## 0. 必须先说的一件事：Key 又暴露了一次

你在消息里以明文给出了 `username: buyrui` 与 API Key。
按你上一条执行令 §八「新 Key 只能通过安全渠道配置，**不在聊天、报告、日志、命令行参数、Git 或完整环境变量输出中出现**」，
这把 Key 已经**再次处于暴露状态**。

我的处理：

- **没有**写入 `.env.prod`、**没有**写进任何文件、**没有**用于任何请求（包括余额查询）。
- 本报告不含该字符串。
- 建议：**再轮换一次**，然后用下面任一方式交接（二者都不经过对话）：
  - 你 SSH 登录服务器，自己执行：`printf '%s' '<新KEY>' > /root/.smsbao.key && chmod 600 /root/.smsbao.key`，然后告诉我"已就绪"；
  - 或授权我用 `read` 提示交互读取（不落 shell history）。

> 因为这一条，第三组「通道预检」本轮**无法执行**，标 PENDING。

---

## 1. 七个现有 SMS scene 的真实映射表

| # | scene | 模板原文（`SMS_TEMPLATE_TEXT`） | 变量 | 接收人 | 触发点（源码位置） |
|---|---|---|---|---|---|
| 1 | `dispatch_customer`（派工通知·客户） | `【{sign}】您的{label}（{ticket_no}）已由{store}受理，师傅{technician}将于{expected}与您联系上门。` | sign,label,ticket_no,store,technician,expected | 客户 | 派工动作（`ticket-service.ts:2134` 附近，`customerScene`） |
| 2 | `technician_task`（派工通知·师傅） | `【{sign}】{store}派单：{ticket_no} 客户{contact}，预约{expected}。作业链接（{hours}小时内有效）：{link}` | sign,store,ticket_no,contact,expected,hours,link | 师傅 | `ticket-service.ts:2687` |
| 3 | `technician_assignment_cancelled`（改派取消） | `【{sign}】{store}取消派单：{ticket_no}（原定{expected}）已改派他人，请勿上门。` | sign,store,ticket_no,expected | 师傅 | `ticket-service.ts:2775` |
| 4 | `dispatch_update`（改约） | `【{sign}】您的{label}（{ticket_no}）上门时间已更新为{expected}，师傅{technician}。` | sign,label,ticket_no,expected,technician | 客户 | `ticket-service.ts:2134` |
| 5 | `review_invite`（评价邀请） | `【{sign}】您的{label}（{ticket_no}）已处理完成，请点击评价：{link}` | sign,label,ticket_no,link | 客户 | `ticket-service.ts:3862` |
| 6 | `progress_link`（进度查询链接） | `【{sign}】您的售后申请已提交，工单号{ticket_no}。查看处理进度：{link}` | sign,ticket_no,link | 客户 | `actions/public/ticket.ts:729`（匿名建单成功后） |
| 7 | `manual_resend`（人工重发） | `【{sign}】{scene_label}（{ticket_no}）：{raw_text}` | sign,scene_label,ticket_no,raw_text | 人工指定 | `actions/svc/sms-recovery.ts` |

**共性**：全部走 `SmsService.enqueue` → outbox → `safeSend` → 唯一 `provider.send` 调用点；
三处发送门禁（首发 / 补发 / 重试）共用同一个 `config.getBool('sms.enabled')`。

---

## 2. 两条模板分别绑定的实际 scene

| 你的模板 | 语义 | 最匹配的既有 scene | 结论 |
|---|---|---|---|
| **模板 2**：`…您的售后申请已提交成功，工单号{ticket_no}。查看处理进度：https://sh.scqfls.cn/p/{token}` | 提交成功通知 | **`progress_link`**（当前文案：`您的售后申请已提交…查看处理进度：{link}`） | **复用，只改文案 + 变量** |
| **模板 1**：`…您的售后工单{ticket_no}有新的处理进展，请点击查看：https://sh.scqfls.cn/p/{token}` | 处理进展通知 | **无匹配**：`dispatch_customer` 是派工、`dispatch_update` 是改约、`review_invite` 是评价，都不是"通用进展" | **必须新增 scene** |

> 按执行令 §二「优先复用语义匹配的已有 scene，确认不存在才提出最小新增」——模板 2 复用，模板 1 新增。

---

## 3. 需要新增的 scene 与最小 diff（**已写方案，未落地**）

新增一个 `progress_update`（"工单处理进展"）：

```diff
// constants.ts · SMS_SCENE
+ PROGRESS_UPDATE: 'progress_update',

// constants.ts · SMS_TEMPLATE_TEXT
+ [SMS_SCENE.PROGRESS_UPDATE]:
+   '【{sign}】您的售后工单{ticket_no}有新的处理进展，请点击查看：{link}',

// constants.ts · 场景中文名 / 接收人（两处映射）
+ [SMS_SCENE.PROGRESS_UPDATE]: '工单处理进展',
+ [SMS_SCENE.PROGRESS_UPDATE]: SMS_RECIPIENT_KIND.CUSTOMER,
```

**触发点**：必须是**状态机里对客户有意义的迁移**，且每条迁移只发一次。
按现有状态机（`SMS_SCENE` 之外，`STATE_MACHINE`）：

| 迁移 | 对客户有意义？ | 是否已有通知 | 建议 |
|---|---|---|---|
| `NEW → PROCESSING`（受理） | 是 | 无（目前只发师傅） | ✅ 可作为白名单 |
| `PROCESSING → WAIT_STORE_CONFIRM`（师傅回执） | 弱 | 无 | ❓待定 |
| `PROCESSING → WAIT_FEEDBACK`（完成待评价） | 是 | `review_invite` 已覆盖 | ❌ 不要重复发 |
| `WAIT_FEEDBACK → CLOSED` | 是 | 无 | ✅ 可作白名单 |
| 任何 → `CANCELLED` | 是 | 无 | ✅ 可作白名单 |
| 备注/内部字段变化 | 否 | — | ❌ 不发 |
| 同状态重复保存 | 否 | — | ❌ 不发（状态未变） |

**必须满足的唯一事件 ID**：现有 `ticket_events` 每条迁移写一行，`id` 即唯一事件 ID。
建议以 `ticket_events.id` 作为幂等键（与现有 outbox 幂等契约一致），
**没有这个键就不许开自动进度短信**（执行令 §三）。

> ⚠️ **未落地原因**：新增 scene 属于业务改动，且要绑定状态白名单。
> 本报告只提方案，等你裁决白名单范围后再改。

---

## 4. token 生成来源与校验方式

| 项 | 事实 |
|---|---|
| 生成处 | `actions/public/ticket.ts` 建单事务内 `mintedProgress = mint(...)`（`PROGRESS_TOKEN` 服务） |
| 明文 | 只存在于 `mintedProgress.token`（43 位 base64url） |
| 落库 | **只落 hash**：`service_tickets.progressTokenHash`；明文**不可反推** |
| 链接构造 | `${publicBaseUrlOf(env)}${PROGRESS_TOKEN.LINK_PATH}${token}`，即 `https://sh.scqfls.cn/p/<43>` |
| 校验 | 服务端按 hash 反查 → 命中才返回该工单进度；`/p/` 本身不做校验（只做形状跳转） |

**结论：token 是现成的，不需要新造第二套算法。**
执行令要求的"不让 `{token}` 里放完整 URL、不形成双重 URL"——
现有代码把完整 URL 放在 `{link}` 里是**正确的**：渲染结果是 `…/p/<token>`，与批准文案完全一致。

**需要你裁决的一点**：
模板里有 `https://sh.scqfls.cn/p/` 这个**写死的域名**。两种实现：

| 方案 | 模板写法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | `…请点击查看：{link}` | 域名来自 `PUBLIC_BASE_URL`，换域名不用改模板 | 模板文本与批准文案"字面"不同，但**渲染结果逐字相同** |
| B | `…请点击查看：https://sh.scqfls.cn/p/{token}` | 模板字面与批准文案一致 | **域名写死**，将来换域名/加 CDN 会静默发错链接 |

> 我倾向 A，但**这是你的业务决定**，我不擅自改文案。

---

## 5. 两条模板的离线渲染（合成数据，token 已脱敏）

用真实渲染规则（`replace(/\{(\w+)\}/g)`，未知键→空）模拟：

**模板 2（复用 progress_link）**

```
输入: ticket_no=FW20261022-9999, link=https://sh.scqfls.cn/p/A…A(43)
渲染: 【四川恒晟恒七方】您的售后申请已提交成功，工单号FW20261022-9999。查看处理进度：https://sh.scqfls.cn/p/A…A
残留占位符: 无 ✅   长度: 约 112 字   → 约 2 条计费
```

**模板 1（新增 progress_update）**

```
输入: ticket_no=FW20261022-9999, link=https://sh.scqfls.cn/p/A…A(43)
渲染: 【四川恒晟恒七方】您的售后工单FW20261022-9999有新的处理进展，请点击查看：https://sh.scqfls.cn/p/A…A
残留占位符: 无 ✅   长度: 约 108 字   → 约 2 条计费
```

**缺失必填变量的行为（当前实现）**：

| 缺失 | 现状 | 要求 | 结论 |
|---|---|---|---|
| `ticket_no` | 渲染成空 → 文案变 `工单号。` | 必须**阻断发送** | ❌ 需加校验 |
| `link` | 渲染成空 → 链接整段消失 | 必须**阻断发送** | ❌ 需加校验 |

执行令 §四.8 明确「不允许继续沿用未知变量静默替换为空来处理这两条模板的必填变量」。
**最小改法**：在 `SmsService.enqueue`（或这两条 scene 的构造处）加一道**仅针对这两个 scene** 的断言：

```ts
if (scene === SMS_SCENE.PROGRESS_LINK || scene === SMS_SCENE.PROGRESS_UPDATE) {
  if (!params?.ticket_no) return reject('SMS_PARAM_MISSING: ticket_no');
  if (!params?.link || !/^https:\/\/[^\s]+\/p\/[A-Za-z0-9_-]{43}$/.test(params.link))
    return reject('SMS_PARAM_INVALID: link');
}
```

不改模板引擎全局行为，只拦这两条。**未落地**（等文案方案定稿一并改）。

---

## 6. `/p/` 真实公网测试结果

**修复前**：`/p/<43>` 落到 `location /` → 返回 NocoBase 加载壳（**200 / 2508B / text/html**），
客户点短信链接会看到一个与进度无关的页面，而日志全是 200。

**本轮已修复**（只改本站 vhost，备份 `vhost-pre-p-20261022.conf`）：

```nginx
location ~ "^/p/(?<svc_progress_token>[A-Za-z0-9_-]{43})$" {
    absolute_redirect off;
    return 302 /h5/customer/progress/$svc_progress_token;
}
location /p/ { return 404; }     # 注意：不能写 ^~，否则短路上面的正则
```

**修复过程中我自己踩了一次**：第一版写成 `location ^~ /p/ { return 404; }`，
`^~` 的语义就是"命中后跳过正则" ⇒ 合法 token 也被 404。已改回普通前缀并复验。

### 实测（公网，`--resolve` 锁定本机验证后再走真实外网）

| 用例 | 结果 |
|---|---|
| `/p/<43 合成 token>` | **302**，`Location: /h5/customer/progress/<43>`（相对地址，`absolute_redirect off`） ✅ |
| 跟随跳转 | **200**，`text/html`，**987 字节**，`<title>服务报修 · 家电门店售后服务平台</title>` ✅ |
| 浏览器渲染 | `data-v-app` 已挂载，`class="svc-page svc-progress"`，标题「服务进度」 ✅ |
| 假 token 的页面表现 | 显示「**这个查询链接无效、已过期或已被撤销**」，**无任何客户数据** ✅ |
| `/p/bad`（形状不符） | **404**（不再是 2508 加载壳） ✅ |
| `/p/`（空） | **404** ✅ |
| `/p/<43>/extra` | **404** ✅ |
| H5 资源 | `/h5/assets/index-DvlJmwHL.js` 200 / `application/javascript` / 160843B ✅ 无 MIME 错误 |

### ⚠️ 一项不合格：**token 明文进了访问日志**

```
日志中存在完整 token 的次数: 18
… "GET /p/<43位> HTTP/2.0" 302 138 …
/h5/customer/progress 被记录: 8 次
```

执行令 §五 要求「不在 Nginx 或应用日志中泄露完整 token」。**当前不满足。**

两种修法，需你选：

| 方案 | 做法 | 影响 |
|---|---|---|
| **A** | 在 `/p/` 与 `/h5/customer/progress/` 两个 location 内 `access_log off` | 只改本站 vhost，但**这两条路径失去访问日志**（排障变难） |
| **B** | 在 http 级定义 `map` 掩码 + 自定义 `log_format`，本站引用新 format | 日志可审计且 token 打码，但**要改全局 `nginx.conf`**，超出"只改本站 vhost"的授权 |

我不擅自选。默认偏向 B（安全 + 可审计），但需你批准动全局配置。

---

## 7. 模板与签名审核状态

**未核实。** 我没有短信宝后台访问权限，无法确认：

- 签名 `【四川恒晟恒七方】` 是否通过；
- 两条模板是否通过（当前状态：**已申请**，不等于通过）；
- `{token}` 嵌在固定 URL 里这种形式是否被平台接受；
- 43 字符 token 是否符合平台变量要求；
- 域名 `sh.scqfls.cn` 是否需要单独报备；
- 是否需专用产品 ID（`SMSBAO_PRODUCT_ID`）。

**需要你在后台确认并回贴状态**，或授权我用只读子账号查看。
按执行令 §六：若平台要求改文案，**先反馈你**，我不自行重新提交。

---

## 8. 旧短信队列重放风险 —— **结论：无风险（有证据）**

| 检查 | 结果 |
|---|---|
| `sms_logs` 总数 | **783**，**全部 `provider=mock`** |
| 状态分布 | `rejected` **461** / `accepted` **322** |
| 是否存在 `pending` | **0**（恢复调度器只捞超龄 `pending` ⇒ 捞不到） |
| 是否存在 `error` | **0**（重试只捞 `send_status='error'` 且 `retry_count < limit` ⇒ 捞不到） |
| 重试队列形态 | `this.retryQueue` 是**进程内内存数组**，应用重启即清空 |
| 切换方式 | 改 provider 必须重启应用 ⇒ 队列必清 |

⇒ **切换后不会补发任何历史短信**。783 条 mock 记录既不在 `pending` 也不在 `error`，
两条自动通道都够不着。**不需要隔离方案，也不需要删除历史记录。**

---

## 9. DB provider 与 enabled 状态（复核）

| 键 | 值 | 更新时间 |
|---|---|---|
| `sms.provider` | **mock** | 2026-10-17 13:12:08 |
| `sms.enabled` | **false** | 2026-10-22 11:41:17 |
| `sms.retry_count` | 1 | 2026-10-17 13:21:17 |

与上一轮一致，**本轮未做任何修改**。
按执行令 §七：在模板、凭据、短链门禁全通过前，**继续保持 `sms.enabled=false`**。

---

## 10. 新 Key 安全配置状态

| 项 | 状态 |
|---|---|
| `.env.prod` 中 `SMSBAO_USERNAME / API_KEY / SIGN_NAME / PRODUCT_ID` | **仍全部缺失** |
| 是否写入任何字段 | **否** |
| 是否用于任何请求 | **否**（含余额查询） |
| 泄漏面 | 本轮以明文出现在对话中 ⇒ **需再次轮换** |

---

## 11. 本轮修改的文件与回归

| 文件 | 改动 | 备份 |
|---|---|---|
| `/www/server/panel/vhost/nginx/sh.scqfls.cn.conf` | 新增 `/p/` 两条 location（+34 行），**未改任何既有规则** | `/opt/scqf-aftersales/backup/vhost-pre-p-20261022.conf` |
| 业务源码 | **零改动** | — |
| `.env.prod` | **零改动** | — |
| 数据库 | **零改动**（tickets 489 / sms_logs 783 不变） | — |

- `nginx -t`：**successful**（仅既有 `conflicting server name "_"` 警告）
- reload：graceful，master pid **776 未变**，worker 已换新
- 构建：**未触发**（未改源码，无需重建）

**回归**：

| 项 | 结果 |
|---|---|
| `/h5/report` | 200 / 987 |
| `/h5/index.html` | 200 / 987 |
| `/h5/assets/index-DvlJmwHL.js` | 200 / `application/javascript` / 160843 |
| `/api/public/stores` | 200 / 440 |
| `/api/public/store-entry`（无 k） | 404 / 168 |
| hd / cloud / sd / kanma | **200 / 403 / 000 / 000**（与基线一致） |
| 容器 | `scqf-as-app` healthy / `scqf-as-postgres` healthy |
| 业务数据 | tickets **489**、sms_logs **783** —— 零新增 |

---

## 12. 未解决风险与阻断项

| # | 阻断 | 说明 | 谁能解 |
|---|---|---|---|
| **B1** | 模板/签名审核状态未知 | 只有"已申请" | 你（后台确认） |
| **B2** | 新 Key 未安全落库且已再暴露 | 需再次轮换 + 安全交接 | 你 |
| **B3** | 模板 1 需新增 scene + 状态白名单 | 方案已给，需裁决白名单 | 你 |
| **B4** | 必填变量缺失时未阻断 | 需加 12 行校验（仅这两个 scene） | 我（等文案定稿一并改） |
| **B5** | **token 明文进访问日志** | 违反 §五，需选 A/B 方案 | 你决定方案 |

非阻断：域名写死 vs `{link}`（§4）、计费 2 条/条（需平台确认）、余额查询无实现（需新增探针）。

---

## 13. 判定

- **P6-SMS-02：未达到 READY FOR CONTROLLED TEST** —— B1–B5 全在。
- **短信发送：继续 HOLD**，`sms.enabled=false` 未动，本轮**实发数量 0**。
- 已完成的硬成果：**`/p/` 短链打通并经真实浏览器验证**（这是原报告里最大的阻断，现已消除），
  以及**旧队列重放风险排除**（有数据证据，不需要隔离方案）。
- P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。

### 需要你回答的三件事

1. **模板文案用哪种实现**：`{link}`（推荐，域名可配）还是写死 `https://sh.scqfls.cn/p/{token}`？
2. **进度短信的状态白名单**：只放 `NEW→PROCESSING` + `→CLOSED` + `→CANCELLED`，还是要更多？
3. **token 日志方案选 A 还是 B**（A 关日志 / B 改全局加掩码格式）？
