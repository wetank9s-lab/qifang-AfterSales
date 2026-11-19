# P6-SMS-02 双模板正式接入专项报告

> 执行时间：2026-10-22 14:38–14:52（UTC+8）
> 本轮完成：§五 Token 日志加固（方案 A）、§七 DB provider 切换、§四 Token 生命周期核查。
> 本轮**未改任何业务源码**、**未发送任何短信**、**未开启 `sms.enabled`**。
> 判定：**未达 READY FOR CONTROLLED SEND** —— **模板 1 命中 §四 停止条件，已按令停止接线**。

---

## 0. 最重要的结论：模板 1 必须停

执行令 §四 写得很清楚：

> 如现有数据模型仅支持单 Token、且新签发会导致老客户链接失效，**立即停止模板 1 的接线**，
> 提交专门的 Token 生命周期设计，**不得自行改数据库结构或冻结的进度权限算法**。

我核到的正是这种情况，三条证据：

| 证据 | 源码事实 |
|---|---|
| ① 单列单值 | `resolveTicketId()` 用 `findOne({ filter: { progress_token_hash: hash } })` —— 一个字段只存**一个**哈希 |
| ② 不轮换 | `mintForTicket()` 首行判断 `if (plain.progress_token_hash) return null;`，注释原文：「轮换会让已发出去的短信失效，而"重新签发"应由显式的撤销 + 重发流程做」 |
| ③ 无处取明文 | 明文只在建单那一刻由 `mintStandalone()` 产生并随响应返回一次，库里只有 `sha256`；**不可反推** |

⇒ **后续状态变更时，系统没有任何合法途径拿到该工单的进度 Token**。
要发模板 1 只能新签一个覆盖旧哈希 —— 而覆盖之后**老客户手上的链接立即失效**（因为解析按单列匹配）。

**因此：模板 1（`progress_update` scene）本轮不接线、不新增 scene。**
需要一份专门的 Token 生命周期设计（见 §9 申请）。

---

## 1. 两条模板的渲染结果

### 1.1 模板 2（提交成功）—— 现有 `progress_link`，**可用**

现网实现（未改）：

```
【四川恒晟恒七方】您的售后申请已提交，工单号FW20261022-9999。查看处理进度：https://sh.scqfls.cn/p/<43>
```

与审核版差异：
- 多一个「成功」两字（`已提交` vs `已提交成功`）
- 变量名用的是 `{link}`（完整 URL），审核版写的是 `{token}`

**渲染结果逐字对比（合成数据）**：

| | 文本 |
|---|---|
| 审核通过版 | `【四川恒晟恒七方】您的售后申请已提交成功，工单号{ticket_no}。查看处理进度：https://sh.scqfls.cn/p/{token}` |
| 现网渲染 | `【四川恒晟恒七方】您的售后申请已提交，工单号FW20261022-9999。查看处理进度：https://sh.scqfls.cn/p/AAAA…A` |
| 差在哪 | **少「成功」**；链接部分**完全一致**（域名 + `/p/` + 43 位） |

⇒ 只需改文案一处 + 增加域名校验，**链接生成逻辑不用动**（`{link}` 产出与 `https://sh.scqfls.cn/p/{token}` 逐字相同）。

### 1.2 模板 1（处理进展）—— **未接线，无渲染**

若接线，渲染结果会是：

```
【四川恒晟恒七方】您的售后工单FW20261022-9999有新的处理进展，请点击查看：https://sh.scqfls.cn/p/<43>
```

但取不到 `<43>`，所以**这一条不会存在**。

---

## 2. `progress_link` 的修改范围（方案已定，**本轮未落地**）

```diff
// constants.ts · SMS_TEMPLATE_TEXT
- [SMS_SCENE.PROGRESS_LINK]:
-   '【{sign}】您的售后申请已提交，工单号{ticket_no}。查看处理进度：{link}',
+ [SMS_SCENE.PROGRESS_LINK]:
+   '【{sign}】您的售后申请已提交成功，工单号{ticket_no}。查看处理进度：{link}',
```

**外加一道域名闸门**（执行令 §二：「必须校验最终域名恰好为已审核的 sh.scqfls.cn」）：

```ts
// 发送前（仅 progress_link 这一条）
const base = publicBaseUrlOf(process.env);
if (base !== 'https://sh.scqfls.cn') {
  return reject('SMS_BASE_URL_MISMATCH');  // 配置值改了就不许发，避免文案与审核版不一致
}
```

**为什么没落地**：改 `constants.ts` 要重新构建插件并重新部署（`dist/server/index.js` 1.48MB），
本轮时间不足以完成「构建 → 校验 → 灰度 → 回归」全链，且**模板 1 已停**，
两条模板应作为一个整体一起改、一起验收，避免半套上线。

---

## 3. `progress_update` 新增 scene 的最小 diff（**按令停止，不提交**）

原计划：

```diff
+ PROGRESS_UPDATE: 'progress_update',
+ [SMS_SCENE.PROGRESS_UPDATE]: '【{sign}】您的售后工单{ticket_no}有新的处理进展，请点击查看：{link}',
+ [SMS_SCENE.PROGRESS_UPDATE]: '工单处理进展',
+ [SMS_SCENE.PROGRESS_UPDATE]: SMS_RECIPIENT_KIND.CUSTOMER,
```

**状态**：**不提交**。原因见 §0。

---

## 4. 三类状态转换与现有状态机的对应

状态机（`STATE_MACHINE`，已冻结，本轮未动）：

| 你的白名单 | 对应实际迁移 | 现有通知 | 判读 |
|---|---|---|---|
| NEW→PROCESSING | `NEW: ['PROCESSING','CANCELLED']` | 只发师傅（`technician_task`），**客户侧无通知** | ✅ 可作进展短信，不重复 |
| →CLOSED | `WAIT_FEEDBACK: ['CLOSED','PROCESSING']` | 无 | ✅ 可作进展短信 |
| →CANCELLED | `NEW/PROCESSING: [..., 'CANCELLED']` | 无 | ✅ 可作进展短信 |
| （禁止）创建时初始化 | 建单写 `NEW` 并已发 `progress_link` | 模板 2 已覆盖 | ❌ 不再发模板 1，避免一单一进来两条 |

**去重设计（若将来恢复接线）**：以 `ticket_events.id` 作幂等键（每次迁移写一行，天然唯一），
在 outbox 侧做 `event_id` 唯一约束；`PROCESSING → WAIT_FEEDBACK` **不发**（避免与 `review_invite` 语义重叠）。

---

## 5. Token 后续获取机制 / 老链接是否失效

| 问题 | 答案 |
|---|---|
| 新 Token 能否绑定原工单？ | 可以，但只能**覆盖** `progress_token_hash` |
| 原短信链接是否仍有效？ | **失效**。解析按单列哈希匹配，旧哈希被覆盖后旧链接查不到 |
| 有效期/撤销规则 | 关闭后保留 30 天（`RETAIN_DAYS_AFTER_CLOSE`）；有 `progress_token_revoked_at` 显式撤销位 |
| 是否支持多个有效 Token？ | **不支持**（单列） |
| 覆盖旧 Hash 的风险 | **正是本节的结论**：会打断老客户链接 |

⇒ 与执行令的停止条件完全吻合，**不自行改表结构**。

---

## 6. Token 日志：18 次历史命中的处置

### 6.1 已止住新增（方案 A 落地）

只改本站 vhost（备份 `vhost-pre-logfix-20261022.conf`），**未动全局 `nginx.conf`**：

```nginx
# 443 server 级
access_log off;
error_log  /www/wwwlogs/sh.scqfls.cn.error.log;
```

并在 `/h5/` 块内把 `Referrer-Policy` 改为 **`no-referrer`**（原为 `strict-origin-when-cross-origin`），
**只保留一条**（第一次改完出现两条并存，已修正 —— 重复头会导致浏览器取值不确定）。

**为什么不是逐路径 `access_log off`**（三个都堵不住的原因）：

1. `/api/public/progress/<token>` 被 `location ^~ /api/public/` 整体吃掉，
   **`^~` 前缀会短路所有正则**，加不了更精确的正则规则（与 `/p/` 那个坑同源）；
2. `/h5/` 有 `try_files` 内部跳转，最终命中 `/h5/index.html`，内部跳转仍会记**原始 URI**；
3. `Referer` 头本身也可能带完整 URL。

⇒ 逐条堵必留缝，整站关闭是当前唯一能**证明**不留缝的做法。代价见 §12。

### 6.2 历史 18 次命中

- 原文件：`/www/wwwlogs/sh.scqfls.cn.log`（768 行，含 18 条 `/p/<完整token>`）。
- **未删除、未改写**（执行令要求"不能删除旧日志"）。
- 处置建议（待你批准后执行）：
  1. 立即收紧文件权限到 `600`，并确认不在任何 Web 根下（已核：`/www/wwwlogs` 不经 nginx 暴露）；
  2. 备份传播控制：该文件**不进入**任何备份包（当前备份只打 `/www/scqf-as-media` 与 DB，**不含** logs）；
  3. 轮转：`logrotate` 切分后归档加密、设定保留期；
  4. 评估：这 18 条对应的 token 是否仍有效 —— 若对应工单已关闭超 30 天则天然失效；
     否则建议对相关工单执行**撤销**（`progress_token_revoked_at`），由客户重新获取链接。

> 我**没有**把任何完整 token 写进本报告。

---

## 7. 新请求无 Token 日志泄露（实测）

用合成 token `Z…Z(43)`，连打 3 轮共 9 次请求（`/p/`、`/h5/customer/progress/`、`/api/public/progress/`）：

```
加固前日志行数: 768
加固后日志行数: 768
新增行数（应为 0）: 0 ✅
合成 token 在日志中的命中数（应为 0）: 0 ✅
```

进度页响应头：

```
cache-control: no-store, must-revalidate
x-robots-tag: noindex, nofollow
referrer-policy: no-referrer          ← 单条
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
```

鉴权/Cache-Control/X-Robots-Tag 均保留 ✅

---

## 8. `/p/` 与 H5 回归

| 用例 | 结果 |
|---|---|
| `/p/<43>` | 302 → `Location: /h5/customer/progress/<43>`（相对） ✅ |
| 跟随 | 200 / `text/html` / **987B** / `<title>服务报修…</title>` ✅ |
| 浏览器渲染 | `svc-progress` 挂载，标题「服务进度」；假 token 显示「链接无效、已过期或已被撤销」，**零客户数据** ✅ |
| `/p/bad`、`/p/`、`/p/<43>/extra` | 404（不再是 2508 加载壳） ✅ |
| `/h5/assets/index-DvlJmwHL.js` | 200 / `application/javascript` / 160843B ✅ |
| `/h5/report` | 200 / 987 |
| `/api/public/stores` | 200 / 440 |
| `/api/svc:health` | 200 / `{"data":{"status":"ok"}}` |

---

## 9. provider 与 enabled 的实际运行时状态

| 键 | 切换前 | 切换后 |
|---|---|---|
| `sms.provider` | mock | **smsbao** ✅ |
| `sms.enabled` | false | **false**（未动） ✅ |
| `sms.retry_count` | 1 | **1**（未动） ✅ |

- `.env.prod` 的 `SMS_PROVIDER` 本来就是 `smsbao`，本轮未改。
- 改完 DB 后**重启了应用**（配置有进程内缓存，不重启不生效），第 9 次轮询转 healthy。
- 重启后站点全绿：`/h5/report` 200、`/api/public/stores` 200、health 200。

**诚实说明**：`/api/svc:health` 只回 `{"status":"ok"}`，**按设计不暴露部署情报**，
所以外部没有只读接口能直接读出"当前 provider = smsbao"。
现有证据链是：**DB 行 = smsbao → 重启清缓存 → 源码唯一读取点 `currentProvider()` 读 `sms.provider`**。
要达到"运行期自证"，需要一个只读诊断接口（属新功能，未做）。

⚠️ 另需注意：`SmsbaoProvider.configured` 现在为 **false**（4 个 `SMSBAO_*` 仍缺失）。
即使有人误把 `sms.enabled` 打开，`deliverOne` 也只会落 `SMS_MISCONFIGURED` 而**不会真发** —— 这是一层意外保护。

---

## 10. 发送意图去重与历史队列安全

| 项 | 状态 |
|---|---|
| 新 scene 发送意图 | **0**（模板 1 未接线） |
| `progress_link` 触发点 | 仍只有匿名建单成功后一次（`ticket.ts:729`） |
| 历史 `sms_logs` | **783**，全部 `provider=mock` |
| 状态分布 | rejected **461** / accepted **322** |
| `pending` / `error` | **0 / 0** |
| 重试可达性 | 只捞 `send_status='error'`；恢复只捞超龄 `pending` ⇒ **都够不着** |
| 队列形态 | `retryQueue` 是**内存数组**，本轮重启已清空 |
| 是否删除/重放旧记录 | **否**（一条未动） |

> 认可执行令 §六 的提醒：这是**当前快照**的良好证据，不等于永远无风险。
> 生产开闸前必须**再测一次**（届时 `provider` 已变，历史记录仍不会被重试，因为 `send_status` 不变）。

---

## 11. 构建与其它站点回归

- **构建：未执行**（本轮未改业务源码，无需重建）。
- `nginx -t`：**successful**（仅既有 `conflicting server name "_"` 警告）。
- reload：graceful，master pid **776 未变**，worker 已换新。
- 其它站点：hd **200** / cloud **403** / sd **000** / kanma **000**（与基线一致）。
- 容器：`scqf-as-app` healthy、`scqf-as-postgres` healthy。
- 业务数据：tickets **489**、sms_logs **783**、media **610** —— 零变化。

---

## 12. 未完成项

| # | 事项 | 原因 / 下一步 |
|---|---|---|
| **U1** | **模板 1 接线** | **命中 §四 停止条件**；需先做 Token 生命周期设计（见下） |
| **U2** | 模板 2 文案改「已提交成功」+ 域名闸门 | 需改 `constants.ts` 并**重建插件 + 重新部署**；等与 U1 一并处理 |
| **U3** | 必填变量阻断校验 | 同一批源码改动，随 U2 一起 |
| **U4** | 4 个 `SMSBAO_*` 未配置 | 等新 Key 安全交接 + 签名名 |
| **U5** | 模板/签名在平台侧的实际审核状态 | 你已确认通过；我**无法自证**（无后台访问），按"你确认"记录，未做独立核实 |
| **U6** | **整站访问日志已关闭** | 排障变难；需可审计脱敏方案（http 级 `map` + 掩码 `log_format`，要动全局配置） |
| **U7** | 历史 18 条 token 日志 | 未删除；待你批准按 §6.2 处置（权限收紧 / 归档 / 对相关工单撤销 token） |
| **U8** | 运行期 provider 自证 | 无只读诊断接口，只能靠"DB+重启+源码"证据链 |
| **U9** | 余额/产品通道预检 | 需新 Key |

### 需要你裁决的 Token 生命周期设计（U1 的前置）

三个方向，各有代价，我不擅自选：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 多 Token 表** | 新增 `progress_tokens(ticket_id, hash, created_at, revoked_at)`，一张工单可挂多个有效 token | 需建表 + 改解析为多行匹配；**改数据模型**，需你明确批准 |
| **B. 一次性短链聚合页** | 进展短信不发 token，改发"查看进度"引导到需二次验证的页面 | 客户体验变差，且需要另一个身份凭据 |
| **C. 只发模板 2，不发进展短信** | 维持现状：提交时发一次带链接的短信，后续进展靠客户自己点原链接 | **零改动、零风险**，但放弃"进展提醒"产品价值 |

> 我的建议是 **C 先上，A 作为后续迭代**：C 能立刻交付价值（提交成功通知 + 可查进度），
> 而 A 涉及数据模型变更，应该单独走一次设计评审。

---

## 13. 判定

- **P6-SMS-02：未达 READY FOR CONTROLLED SEND。**
- **已交付的硬成果**：`/p/` 短链打通（含真实浏览器验证）、**Token 明文日志已止住且可证**（0 新增命中）、
  DB provider 已切到 smsbao 且 `enabled` 仍为 false、Token 生命周期风险已查清并**按令停手**。
- **短信自动发送：继续 HOLD**，`sms.enabled=false` 未动，本轮实发 **0**。
- P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。
