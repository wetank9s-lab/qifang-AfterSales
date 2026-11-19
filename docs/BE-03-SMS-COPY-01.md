# BE-03-SMS-COPY-01 三场景短信内容修复报告

> 日期：2026-10-29 · 状态：**源码 PASS / 正文捕获 PASS / 生产部署 NOT DEPLOYED（待专项批准）**
> 本轮性质：只改**正文生成与必要字段映射**；未改发送时机、收件人选择、Token 签发、评价状态机、工单状态机。

---

## 0. 三句话结论

| 项 | 判定 | 依据 |
|---|---|---|
| **源码修改** | **PASS** | 三处模板 + 一处字段映射；`prebuild-guard` 10/10 SAME；TS 全量基线 219 → 219（无新增） |
| **捕获 Provider 正文测试** | **PASS** | 抓真实 `fetch` 的 `c` 参数断言：**74/74**；变异测试 **6/6** 回退被抓 |
| **生产部署** | **未执行（按令）** | 生产仍为 `server 0dc13875…` / `client 62677303…`；本轮未部署、未发短信、未 commit/push |

---

## 1. 裁决文案 vs 实际发出去的正文（逐字）

> 下面三行是**最终传给短信宝的 `c` 参数**，不是前端预览、不是模板源码。
> 合成数据：门店`十里大道一段店`(内部码`S10`) / 工单`FW20261029-0002` / 客户`王小明` `13900008000` / 师傅`张三` / 预约`11-02`。

**A. 客户派工通知（`dispatch_customer`）**

```
【四川恒晟恒七方】您的维修（FW20261029-0002）已由十里大道一段店受理，张三将于11-02与您联系上门。
```

- 保留工单号 ✓　无 `(S10)` ✓　门店用对外名称 ✓

**B. 师傅任务通知（`technician_task`）**

```
【四川恒晟恒七方】十里大道一段店派单：客户王小明，联系电话：13900008000，预约11-02。作业链接（72小时内有效）：https://sh.scqfls.cn/t/kkk…(43)
```

- 无工单号 ✓　无 `(S10)` ✓　**客户完整 11 位号码** ✓　不含脱敏形态 ✓

**C. 客户评价邀请（`review_invite`）**

```
【四川恒晟恒七方】您的维修已处理完成。您的评价对我们很重要，诚邀您点击链接评价：https://sh.scqfls.cn/f/mmm…(43)
```

- 无工单号 ✓　含「您的评价对我们很重要」 ✓　链接为 `/f/` ✓

---

## 2. 最小 diff（三文件，逐字前后对照）

### 2.1 `server/constants.ts` —— 三条模板

| scene | 改前（HEAD） | 改后 |
|---|---|---|
| `DISPATCH_CUSTOMER` | `'【{sign}】您的{label}（{ticket_no}）已由{store}受理，师傅{technician}将于{expected}与您联系上门。'` | `'…已由{store}受理，{technician}将于{expected}与您联系上门。'` |
| `TECHNICIAN_TASK` | `'【{sign}】{store}派单：{ticket_no} 客户{contact}，预约{expected}。作业链接（{hours}小时内有效）：{link}'` | `'【{sign}】{store}派单：客户{customer_name}，联系电话：{customer_mobile}，预约{expected}。作业链接（{hours}小时内有效）：{link}'` |
| `REVIEW_INVITE` | `'【{sign}】您的{label}（{ticket_no}）已处理完成，请点击评价：{link}'` | `'【{sign}】您的{label}已处理完成。您的评价对我们很重要，诚邀您点击链接评价：{link}'` |

> 旧 `{contact}` 的实现是 `姓名 + maskMobileText(号码)`（`contactOf()`）⇒ **师傅收到的是打不出去的脱敏号**，这正是本轮的缺陷本体。
> `{technician}` 前的字面「师傅」一并去掉：厂家售后形态下该变量被填成**服务商名称**（`technicianOrProvider`），"师傅海尔售后将于…"是病句。

### 2.2 `server/services/ticket-service.ts` —— 字段映射与守卫

- `enqueueDispatchPair`：`store` 改用 `storeDisplayNameOf()`（对外名称，不含编码）。
- 师傅短信参数：`{ contact }` → `{ customer_name, customer_mobile }`；`customer_mobile` 取**未脱敏**的 `ticket.customer_mobile`。
- 新增守卫：客户号不满足 `/^1[3-9]\d{9}$/` ⇒ **整条跳过并 warn**（只打长度，不打号码），不伪造成功记录。
- 新增 `storeLabeled`：**取消派工**短信仍用 `storeLabelOf()`（`门店名(编码)`），与本轮三场景**口径隔离**。
- 删除死代码 `contactOf()`（此函数已无调用点）。

### 2.3 `server/services/sms-orphan-resolver.ts`

- `dispatch_customer` / `dispatch_update` 的重建改用 `storeDisplayNameOfTicket()`，保证**首发 = 补发**逐字一致。
- `technician_assignment_cancelled` 的重建**保持** `storeNameOf()`（带编码），与首发一致。
- 同步修正两处已与代码相反的历史注释（否则下一轮会照注释把内部编码加回来）。

### 2.4 范围声明（明确未做）

- 未改：发送时机、收件人选择规则、场景开关、模板 CODE 优先级、Token 签发/校验、评价与工单状态机、`sms.enabled`、供应商凭据。
- **已知的连带变化（需备案）**：`DISPATCH_UPDATE`（改派/改约的客户通知）与 `DISPATCH_CUSTOMER` 共用同一组参数，因此**也**去掉了 `(S10)`。这是同一条"客户不该看到内部编号"的裁决的必然结果；若要求改派通知保留编码，需要拆参数来源，请明确。
- **保持不动**：`TECHNICIAN_ASSIGNMENT_CANCELLED`（取消派工）仍带编码——一条"你不用去了"的通知给的是师傅，不属本轮三场景。

---

## 3. 正文链路取证（为什么断言 `c` 而不是断言模板）

```
业务参数 ──▶ renderSmsPreview()  (services/sms-preview.ts，正文唯一实现)
          ──▶ SmsSendRequest.preview  (内存；sms_logs 不落)
          ──▶ SmsbaoProvider.send()  ──▶ decorateSmsbaoSign/bareSignName 规范化开头签名
                                     ──▶ URLSearchParams({u,p,m,c})  ──▶ GET api.smsbao.com/sms?…&c=<正文>
```

- `SmsService.renderPreview()` 只是 `renderSmsPreview()` 的转发（单一实现，没有第二份）。
- `deliverOne()` 把 `pending.request` 原样交给 `safeSend(provider, …)`，**不二次加工正文**。
- 因此夹具只要 `renderSmsPreview → 真实 SmsbaoProvider.send（假 fetch）`，抓到 `c` 就等于抓到了真实发送内容。

**签名形态**：生产 `SMSBAO_SIGN_NAME=【四川恒晟恒七方】`（len=9，见 `DEPLOY-P6-SMS-03-R3.md`）。模板 `【{sign}】` 先渲染成 `【【…】】`，Provider 的前缀候选整段替换后**回到单层** `【…】`——这也是为什么"只验预览"会漏掉双层签名（历史事故）。

**「72 小时」与真实有效期**：`hours` 与 `mint(ttlHours)` 用的是**同一个** `tokenTtlHours()`（同一条归一化：`>0 取整，否则 72`）⇒ 文案里的小时数**不可能**与实际有效期不符；运营把配置改成 48，文案自动变"48小时内有效"，无需改代码。
⚠️ 本轮未读取生产 `technician.token_expire_hours` 的实际值（只读接口需登录态），默认 72；因此生产上线后显示的小时数应以配置为准，**但一定等于真实有效期**。

---

## 4. 测试矩阵（用户规定的 16 项 → 实际判据）

| # | 要求 | 判据 ID | 结果 |
|---|---|---|---|
| 1 | 客户通知保留工单号 | A2 | ✓ |
| 2 | 客户通知无 `(S10)` | A3 | ✓ |
| 3 | 师傅通知无工单号 | B2 | ✓ |
| 4 | 师傅通知无 `(S10)` | B3 | ✓ |
| 5 | 师傅通知含完整 11 位号码 | B4 | ✓ |
| 6 | 不含该号的星号脱敏形态 | B5 | ✓ |
| 7 | 自有/厂家售后师傅规则一致 | B12 | ✓ |
| 8 | 无具体师傅（厂家/第三方/远程）不误发链接 | S22 + S5/S6 | ✓ |
| 9 | 评价邀请无工单号 | C2 | ✓ |
| 10 | 评价邀请含「您的评价对我们很重要」 | C3 / S16 | ✓ |
| 11 | 三场景签名开头、仅一次、无双层括号 | A5/B9/C5 + D-裸名/D-【】/D-〖〗/D-nest | ✓ |
| 12 | 变量替换正确、无 `undefined`/`null`/残留占位 | A7/B10/C6 | ✓ |
| 13 | 链接类型/域名/有效期语义正确 | B6/B7/B8/C4/S19-S21 | ✓ |
| 14 | 既有场景开关与总开关仍有效 | `be03-scene-gate.test.mjs` 34/34 | ✓ |
| 15 | 客户号非法不产生假成功短信 | S5/S6 + E1/E2（证明显式拦截必要） | ✓ |
| 16 | 普通日志/后台摘要不泄露完整号码与 Token | L1–L5 | ✓ |

**合计 74 项，74 PASS / 0 FAIL**（`.tmp-verify/be03-sms-copy.test.mjs`）。
补充回归：`be03-scene-gate` 34/34、`be03-s6-msgid` 42/42（通道解析与 `provider_biz_id` 未回归）。

### 4.1 断言灵敏度（变异测试）

`.tmp-verify/sms-copy-mutate.mjs`：把整棵 `src/` 复制到 `.tmp-verify/mut-src`，每次只注入一处**真实可能发生的回退**，要求夹具退出码 1 且预期断言变红。

| 变异 | 注入 | 抓到（红的判据） |
|---|---|---|
| MU1 | 师傅正文退回 `{customer_mobile_masked}` | B1, B4, S17 |
| MU2 | 评价邀请退回旧文案（带工单号/无邀请语） | C1, C2, C3, S15, S16 |
| MU3 | 派工短信退回 `storeLabelOf`（带编码） | S8 |
| MU4 | 删除客户号合法性守卫 | S5 |
| MU5 | 有效期写死 72 | S20 |
| MU6 | 取消派工短信被顺手改成对外名称 | S9 |

**6/6 全部被抓**（副本未变异基线 74/74 先自证可信）。
> 过程中被变异测试抓出两条**过宽的判据**：`storeDisplayNameOf` 与 `hours: ttlHours` 原先是在**整个文件**上做存在性匹配，改一处调用点照样全绿。已收紧为"函数级作用域"与"全量调用点"。

### 4.2 夹具自身的四次假红（已修，记录以免重犯）

| 现象 | 真因 |
|---|---|
| `D-〖〗` 红 | 判据写成 `/^【…】/`，而产品**刻意保留**运营配置的 `〖〗`；改为括号无关 |
| `S14/S15` 红 | 用 `indexOf('[SMS_SCENE.X]')` 切片，命中的是**枚举定义**而非模板表 |
| `S15` 再红 | 切片带进了下一场景的**注释**，注释里正好写着 `{ticket_no}` ⇒ 命中注释（本项目同类坑第 N 次） |
| `M5` 红 | `【【X】】` 在 `【[^【】]+】` 下只匹配内层，计数=1；双层判据应看 `【【`，不是计数 |

---

## 5. 构建与门禁

| 门禁 | 结果 |
|---|---|
| `prebuild-guard.mjs` | ✓ 10/10 受管文件 SAME（工作区 = `admin-base`） |
| `verify-types` | ✓ 通过 |
| `verify-ts2741-baseline` | ✓ 通过 |
| **TS 全量基线** | **219 → 219（101 键），✅ 无新增诊断** |
| `build-plugin` | ✓ 成功（192 源文件 / 166 ms） |

> 构建基线是 `admin-base/`，实际打包读工作区 `nocobase/plugins/...`。本轮为避免"改了工作区、基线没跟上"，对 `constants.ts` / `ticket-service.ts` / `sms-orphan-resolver.ts` 三份都做了 **ws → base** 同步，并用 guard 复核。`ticket-service.ts` / `sms-orphan-resolver.ts` **不在** 受管清单里，需要人工比对，这一点仍是个缺口。

**产物内文案核对**（esbuild 把中文写成 `\uXXXX`，必须按转义形态查）：

| 标记 | 命中 |
|---|---|
| `联系电话：` | 1（大写转义） |
| `您的评价对我们很重要` | 1 |
| `诚邀您点击链接评价` | 1 |
| 旧 `请点击评价` | **0** |
| 旧 `{contact}` 参数 | **0** |
| `contactOf` | **0** |

---

## 6. 版本与 SHA

**本地新产物**

| 文件 | SHA-256 前缀 | 大小 |
|---|---|---|
| `dist/server/index.js` | `ab586ef53083e3ea…` | 1483.3 KB |
| `dist/client/index.js` | `1c0845b91e9b4b48…` | 468.0 KB |
| `dist/build-fingerprint.json` | `19060c5b5cd83a4c…` | 183 文件 |

**生产当前（2026-10-29 只读核对，未做任何写操作）**

| 文件 | SHA-256 前缀 | mtime |
|---|---|---|
| `server/index.js` | `0dc13875760cd9249b2a551c…` | 2026-10-29 10:53:20 +0800 |
| `client/index.js` | `62677303c562a33df48b1a20…` | 同上 |
| `build-fingerprint.json` | `b7044e2143bc211b1fe5b6a4…` | 同上 |

容器 `scqf-as-app`：`Up 6 hours (healthy)`；`/api/app:getInfo` → **200**。

**两条必须记住的 SHA 事实**

1. **服务端产物可复现，客户端产物不可复现。**
   本轮在"删 `contactOf` 死代码"前后各构建一次：server SHA **完全相同**（`ab586ef5…`，证明该函数本就不在产物里，删除是纯源码清理、对线上字节零影响）；client SHA 从 `20eca188…` 变成 `1c0845b9…`，而**客户端源码本轮一个字都没改** —— 唯一差异是产物内嵌的构建标记（`2026-10-29T09:22:29Z` → `09:23:51Z`）。
   ⇒ **不能用 client SHA 差异推断"客户端有变更"**，否则每次都会得出"改了 22 个文件"那类假差。

2. 因此本轮的部署对象只有 **server 一个文件**（外加 fingerprint）；client 是否随之发布属于另一个决策（它带着此前未上线的前端改动）。

---

## 7. 隐私与日志面（正文现在含客户完整号码）

| 面 | 结论 | 依据 |
|---|---|---|
| `sms_logs` 落库 | 只写 `recipient_masked`；**不写正文、不写 params** | L2（`insertPending` 实际字段） |
| 收件人号码 | 入队即 `maskMobileText(to)` 脱敏 | L3 |
| 后台"最近短信记录" | 仍显示脱敏号，未扩大展示面 | 同上 |
| 短信宝通道日志 | **不打印正文**（正文含客户完整号码） | L5 |
| mock 通道 debug 日志 | 链接 token 已脱敏（`sanitizeLinkTokens`）；正文其余部分仅 mock/开发期可见 | L4 |
| 新增的跳过告警 | 只打 `ticket_no` 与**号码长度**，不打号码本身 | `ticket-service.ts` warn 文案 |
| 明文 Token | 仅存在于内存 `PendingSms.request`，不落库、不进事件 metadata | 原有约束未改 |

---

## 8. 未执行 / 待批准

- **未部署**：`scqf-as-app` 未重启、dist 未替换、`sms.enabled` 未动。
- **未发真实短信**：全流程零网络（fetch 被夹具接管），未向任何真实号码发送，也未复用此前的单条测试授权。
- **未建/未改真实工单**、未改历史短信与送达状态、未改门店权限、未动 Nginx。
- **未 commit / push**。

**若批准上线，最小动作清单**

1. 备份容器内 `dist/server/index.js`（+ `build-fingerprint.json`）到带时间戳目录；
2. 只替换这两个文件；`docker compose -f docker-compose.prod.yml restart app`；
3. 复核 health 200 + 容器 healthy + `dist` SHA = `ab586ef53083e3ea…`；
4. 真实发送需**另行授权**「指定号码 + 条数」，且不得复用旧授权；发送后按三项人工核对：客户派工短信（无编码、有工单号）、师傅短信（完整号码可拨、链接可开）、评价邀请（无工单号、有邀请语）；
5. 任一项不符 ⇒ 立即回滚（`deploy-s6-remote.py --rollback <ts>` 或手工还原备份）。

---

## 9. 遗留与风险

| 项 | 说明 |
|---|---|
| `DISPATCH_UPDATE` 连带去编码 | 见 §2.4，需产品确认是否接受 |
| 生产 `technician.token_expire_hours` 实际值 | 未读取；文案动态取真实 TTL，不会谎报 |
| client 产物不可复现 | 内嵌构建时间戳；建议加内容指纹或改为确定性构建（与"静态 URL 无指纹"是同一类问题） |
| 受管文件清单只有 10 个 | `ticket-service.ts` / `sms-orphan-resolver.ts` 未纳入 guard，只能人工比对 |
| mock debug 日志含正文 | 含客户完整号码；生产走短信宝不受影响，但排障时若切 mock 需注意 |
