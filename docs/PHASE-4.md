# Phase 4 — 派工 / ServiceVisit / 双短信（阶段交付报告）

> **状态：🟡 HOLD —— 服务层 ✅ PASS，阶段整体「未关闭」，不得进入 Phase 5**（2026-09-21 复核方裁定）
>
> | 部分 | 裁定 |
> |---|---|
> | **服务层 A~G + 总闸 J** | ✅ **PASS** —— 92 项总闸全绿（含 §4d 16 条），提交 `453570e` |
> | **DEV-45**（旧 Token 失效的表达形态） | ✅ **已接受偏差 / ACCEPTED** —— 保留 `200 + {valid:false}`，**无需改代码**；`401` 归还给 Phase 5 认证接口（见 §9） |
> | **H 后台页面 / I 真人 UI 走查** | ⬜ **未交付 → 阶段整体 HOLD**，阻塞项就是这两条（见 §12） |
>
> 2026-09-21 服务层与 action 层完成 · 2026-09-21 `smoke-test.mjs` §4d 共 16 条断言真机全绿 · 2026-09-21 收口 DEV-47 三处"注释正确、代码不对" · 2026-09-21 复核方裁定：**服务层 PASS / DEV-45 接受 / 整体 HOLD**
>
> 本文件是 Phase 4 的**独立阶段报告**。逐条验收口径的原始出处见 `docs/DEV-PLAN.md` §「Phase 4 — 派工 / ServiceVisit / 双短信」，
> 偏差登记见 `docs/DEVIATIONS.md`（**DEV-41 ~ DEV-47**），变更历史见 `CHANGELOG.md`。
>
> ⚠️ **本阶段按Phase 4 强制条款 尚未关闭**：后台业务页面（我的门店工单 / 全量工单 / 工单详情含时间线 + Visit 区块）
> 与真实售后人员 UI 走查**均未交付**，因此**不得进入 Phase 5**。详见 §12。

---

## 1. 本阶段目标

Phase 1 / 2 / 3 交付了「数据底座 + 权限 + 内部接口」与「客户匿名报修入口」，但系统此时仍然
**只是一台收单机器** —— 报修进来之后没有任何人「接单、上门」的动作被记录。

Phase 4 是**责任落地的第一步**：从这一刻起，系统对外承诺「**谁上的门**」。三件事，缺一不可：

1. **派工三动作**：`dispatch`（M3 首次派工）/ `reassign`（M4 改派）/ `reschedule`（M5 改约）。
2. **Visit 生命周期 = 数据模型保证的不可覆盖**：改派建模为「**终止旧 Visit + 新建 Visit**」，
   让「返工过程可追溯」成为模型的**必然结果**，而不是靠人记得别覆盖。
3. **短信适配层**：`SmsProvider` 抽象 + `MockSmsProvider` + `AliyunSmsProvider`；
   发短信走**事务性发件箱**，外部 HTTP 失败**不得**回滚已成功的派工。

外加一条**不得再延期的硬约束**（`docs/DEV-PLAN.md`）：后台业务页面必须在本 Phase 完成前交付，
且派工 / 改派 / 改约的验收**不得只用 `curl` 下结论**，必须由真实售后人员在浏览器上走一遍。

> 本阶段的高风险在于：它的三条硬语义（Visit 历史不可覆盖 / 旧 Token 立即失效 / 客户与师傅不共用模板）
> **全部属于"做错了不会报错"的类型** —— 改派写成覆盖旧行，页面一切正常，只是返工过程不可追溯；
> 旧 Token 不失效，原师傅仍能提交回执，数据看起来完全合法；两处共用 scene，供应商照发，
> 只是师傅收到一句客户话术。**这类缺陷没有任何一条能在页面上被肉眼发现**，只能在真机 + HTTP 层被证明。

---

## 2. 实际交付文件

对应提交见 `CHANGELOG.md` §「Phase 4」。

### 2.1 服务端（`nocobase/plugins/service-ticket`）

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/server/services/token-service.ts` | 新增 | **TokenService**：`randomBytes(32)` → base64url（明文只出台一次），入库 `sha256`；校验失败一律 `TOKEN_INVALID`（内部 reason 不外露） |
| `src/server/services/visit-service.ts` | 新增 | **VisitService**：建 Visit + `visit_no` 在**调用方事务内**取号；师傅姓名 / 手机号 / 预约时间均为**快照** |
| `src/server/services/sms-provider.ts` | 新增 | **SmsProvider 抽象** + `MockSmsProvider` + `AliyunSmsProvider`（手写 RPC v1.0 签名）+ `NotImplementedSmsProvider`（tencent 响亮失败）+ `createSmsProvider()` 工厂 |
| `src/server/services/sms-service.ts` | 新增 | **SmsService**：scene → 模板 / 收件人映射；事务性发件箱（事务内写 `pending`，提交后发送）；`accepted` 只记"已受理" |
| `src/server/actions/svc/dispatch.ts` | 新增 | `dispatch` / `reassign` / `reschedule` 三个 action handler + `tokenCheck` / `smsOutbox` 两个验收探针（含 `assertMockChannelOnly()`） |
| `src/server/migrations/20260921-visit-lifecycle.ts` | 新增 | `service_visits` 生命周期列（`visit_status` / `reassigned_from_visit_id` / `superseded_reason` / `token_revoked_*`）与索引 |
| `src/server/services/ticket-service.ts` | 修改 | 派工三入口唯一实现处；`voidActiveVisit()` 供 `cancel` / `transfer` 共用；`enqueueDispatchPair()` 发件箱入队（DEV-47 修两处） |
| `src/server/services/sequence-service.ts` | 修改 | `visit_no` 取号（与 `ticket_no` 共用的原子取号原语） |
| `src/server/services/config-service.ts` | 修改 | `sms.enabled` 参数接入（10s TTL 缓存） |
| `src/server/constants.ts` | 修改 | `SVC_ACTION` 新增 5 项；`SMS_SCENE` / `SMS_SCENE_RECIPIENT` / `SMS_SCENE_TPL_ENV`；`DISPATCHABLE_SERVICE_MODES`；`DEFAULT_SETTINGS` 新增 `sms.enabled` |
| `src/server/plugin.ts` | 修改 | 注册 `createDispatchActionHandlers()`；新增 `repairSettings()`（afterLoad 参数种子自愈，DEV-46） |
| `src/server/services/index.ts` | 修改 | 服务注册 |

### 2.2 脚本与文档

| 文件 | 说明 |
|---|---|
| `scripts/smoke-test.mjs` | 总闸新增 **§4d**（Phase 4 契约验收 **16 项**，走 nginx）；`readDefaultSettingKeys()` 把"16 行参数"改为**集合相等**断言 |
| `scripts/verify-plugin-load.mjs` | 新增 `readSvcActionSets()`（从 `constants.ts` 现读 action 集合，替代硬编码 6）；新增 **【4d】** 2 条（DEV-41 探针自毁闸的离线证明） |
| `docs/PHASE-4.md` | 本文件 |
| `docs/DEVIATIONS.md` | DEV-41 ~ DEV-47 |
| `docs/DATA-MODEL.md` | `sms_logs.scene` 枚举补 `technician_assignment_cancelled`，注明取值域以 `SMS_SCENE` 为唯一事实来源 |
| `docs/DEV-PLAN.md` | Phase 4 状态、A~J 执行表、8 条闸门证据表、E 步措辞更正 |

---

## 3. A→J 完成结果

| 步 | 内容 | 关键不变式 | 结果 |
|---|---|---|---|
| A | `TokenService` 生成 / 校验 / 失效 | 只存 `sha256`；失败一律 `TOKEN_INVALID` | ✅ 冒烟第 5 条（明文 43 位 vs 哈希 64 位十六进制、逐字节校验 sha256）；第 12 条（四种失败形态统一） |
| B | `VisitService` 建 Visit + `visit_no` 取号 | `unique(ticket_id, visit_no)`；快照不覆盖 | ✅ 冒烟第 2 条（`visit_no=1` / `ASSIGNED` / 单行） |
| C | `SmsService` + Provider 抽象 + 发件箱 | `TicketService` 不得直接依赖阿里云 SDK；`delivered` 只能由回执写 | ✅ 静态（`services/` 无 `@alicloud/*`）+ 冒烟第 3 / 4 条 |
| D | `dispatch`（M3） | Ticket 状态 + Visit + Token + `dispatched` 事件同事务 | ✅ 冒烟第 2 / 3 条 |
| E | `reassign`（M4） | **旧 Visit → `SUPERSEDED`（原样保留）+ 新建 Visit** + 旧 Token 失效 + 三条短信 | ✅ 冒烟第 7 / 8 / 9 条 |
| F | `reschedule`（M5） | **不新建 Visit**；旧 Token 失效 → 换发 | ✅ 冒烟第 11 条（Visit 数不变） |
| G | 事务边界与半成功防护 | 见 §7 | ✅ 冒烟第 13 条（被拒改派零副作用） |
| H | 后台 UI：我的门店工单 / 全量工单 / 工单详情（时间线 + Visit 区块） | 门店范围继续走**服务端权限** | ⬜ **未交付（强制条款 1）** |
| I | **真实售后人员 UI 走查**（派工 / 改派 / 改约） | 记录走查人与走查时间 | ⬜ **未交付（强制条款 2）** |
| J | 断言并入 `smoke-test.mjs` 总闸 | 含「改派后旧 Token 失效」 | ✅ §4d 共 **16 条**，真机全绿 |

**三套校验基线（2026-09-21 真机实测，退出码均为 0）**：

| 脚本 | 结果 |
|---|---|
| `verify-config.mjs` | **44 / 44** |
| `verify-plugin-load.mjs` | **59 / 59**（含新增【4d】2 条探针自毁闸） |
| `smoke-test.mjs` | **92 / 92**（含 §4b 8 项 / §4c 12 项 / **§4d 16 项**） |

---

## 4. Visit 生命周期语义（E 步的核心决策）

`docs/DEV-PLAN.md` 上一版 E 步写着「同 Visit 换师傅 + 新 Token；Visit 历史不覆盖」——
**这两句互相矛盾**：既然"不覆盖历史"，就不可能"同 Visit 换人"。本阶段锁定的语义是：

| | 就地换人（否决） | **终止 + 新建（采纳）** |
|---|---|---|
| 旧 Visit 行 | `UPDATE` 覆盖师傅姓名 / 手机号 | **一个字段都不改** |
| 新增行 | 无 | 新建 Visit，`reassigned_from_visit_id` 指回旧行 |
| 旧行终态 | 无终态语义 | `visit_status = SUPERSEDED` + `superseded_reason` |
| 旧 Token | 需另行作废 | `token_revoked_reason = reassigned` + `token_revoked_at` 同事务置位 |
| 返工可追溯 | **靠人记得别覆盖** | **数据模型的必然结果** |

代价是 `visit_no` 会随改派增长，因此加了两道闸：① 责任人未变化时拒绝改派（`SAME_RESPONSIBLE_PARTY`）；
② 已有进行中派工时不得再派工（`VISIT_ALREADY_ASSIGNED`）。

**「责任人」的判据**是 `technician_mobile` + `provider_name` + `service_mode` 三元组 —— **姓名不在其中**
（同名不同人不应被当成同一个人；姓名写错走 M8 的 `METADATA_CORRECTED`，不构成一次改派）。

---

## 5. `smoke-test.mjs` §4d 结果（16 条，真机全绿）

> 断言顺序**刻意**先验「通道未就绪」（`sms.enabled=false`）再打开开关 —— 因为 `ConfigService` 有
> **10s 进程内缓存**，本轮只能"改一次 + 等一次"；把要验的两种状态安排在这一次等待的两侧，
> 等于零额外耗时地覆盖了两条路径。`sms.enabled` 在 `finally` 里**无条件**恢复原值（读一次记下来，不假设它是 `false`）。

| # | 断言 | 实测结果 |
|---|---|---|
| ⓿ | 通道未就绪（`sms.enabled=false`）时业务照常、短信如实记 `rejected` 且不阻断派工 | 派工 200 / Visit 已建 / 短信 `rejected`×2（`SMS_DISABLED`） |
| ① | 首次派工建立 Visit #1，并把派工快照写进工单（不覆盖任何历史） | `visit #1 ASSIGNED`；工单快照 `PROCESSING\|inhouse\|13900010001\|true\|true` |
| ② | 首次派工恰发两条短信，客户与师傅是**两个不同 scene**、两个不同收件人 | `dispatch_customer` + `technician_task`，收件人 2 个且均脱敏 |
| ③ | 短信返回 `accepted` 只记「已受理」，`delivery_status` 必须仍是 `pending` | `accepted`×2 / `delivered` **0** |
| ④ | 师傅 Token 明文只存在于短信里，库里只存 `sha256` | 明文 43 位 → 哈希 `b6e8a24d…`；业务角色接口 **0 泄露** |
| ⑤ | 探针 `tokenCheck` 认可有效 Token，且只回最小字段集 | `visit=26 valid` |
| ⑥ | 工单已有进行中派工时再派工返回 409，且一个字段都不改 | `409 VISIT_ALREADY_ASSIGNED` |
| ⑦ | **改派是「旧 Visit 置 SUPERSEDED + 新建 Visit」，不是就地换人** | `#1 SUPERSEDED` → `#2`；#1 的 `technician_mobile` 仍是原师傅 |
| ⑧ | **【硬门槛】改派后旧 Token 立即失效**（同一实例、同一 Token 由 valid 变 invalid） | 旧 `cMWDee…` → `TOKEN_INVALID`；新 `OKp_Ri…` → `valid` |
| ⑨ | 改派发出三条短信，三个 scene 互不相同，原师傅收到的是「取消通知」 | `dispatch_update` + `technician_assignment_cancelled` + `technician_task` |
| ⑩ | 改约不新建 Visit（只改预约时间），并换发 Token 让旧链接失效 | Visit 数不变 / Token 换发（`OKp_Ri…` → `LDMloX…`） |
| ⑪ | Token 校验的三种失败（伪造 / 格式错 / 已失效）都是同一个 `TOKEN_INVALID` | 三者均 `TOKEN_INVALID`；空值另走 `422` |
| ⑫ | 被拒绝的改派（缺原因）不产生 Visit / 事件 / 短信（**事务边界**） | `422 MISSING_REASON` / 零副作用 |
| ⑬ | 责任人未变化时改派返回 422 `SAME_RESPONSIBLE_PARTY` | `422 SAME_RESPONSIBLE_PARTY` |
| ⑭ | 门店用户派**别家**门店的工单返回 404（数据范围在服务端） | 他店 **404** / 本店 409（权限已通过，走到业务语义） |
| ⑮ | 派工历史能串成一条链（Visit#1 → 改派 → Visit#2，无断点无环） | `#1 SUPERSEDED` → `#2 ASSIGNED`；事件 11 条 |

### 5.1 本段踩过的四个坑（都是**断言脚本**的坑，不是产品的）

| 坑 | 症状 | 修法 |
|---|---|---|
| 从发件箱"取最新一条" | 发件箱是**进程内**内存队列，跨轮次不清空 → 拿到上一张工单的 Token，"旧 Token 失效"这条断言看起来通过、实际证的是别的工单 | 按 **`ticket_no` + `scene` 双重过滤**后再取（与工程铁律 6 同源） |
| 用 `admin@nocobase.com` 验字段白名单 | root **绕过 ACL**，list 回整行（34 字段含 `access_token_hash`）→ 误报"原生接口泄露 Token 哈希" | 改用**非 root 业务账号** `hq_after_sales`，并加"业务列必须存在"防空转 |
| PG boolean 文本形态 | 期望写 `t`/`f`，实际是 `true`/`false` | 修正期望值 |
| `Authorization: \`Bearer ${auth.Authorization}\`` | 已带 `Bearer ` 的串又拼一次 → `INVALID_TOKEN` 401 | 改为直接透传 `...auth` |
| 工单号超长 | `FWP4{ts}MAIN` 超 `varchar(24)` | 夹具后缀缩短为 A/B/C/D |

---

## 6. 八条高风险闸门 → 证据映射

用户在授权本阶段时点名的风险点，逐条给出**可复现的断言证据**：

| # | 闸门 | 证据（§4d 序号） |
|---|---|---|
| 1 | 首次派工与改派必须创建 / 保留 ServiceVisit 历史，不得覆盖上一位师傅的数据（快照语义） | ①⑦⑮：Visit #1 的 `technician_mobile` 在改派后仍是原师傅；新行 `reassigned_from_visit_id` 指回旧行；链无断点 |
| 2 | **改派后旧 Token 必须立即失效**（本阶段硬门槛） | ⑧：同一 Token 由 `valid:true` → `valid:false`；库内 `token_revoked_reason=reassigned` 且 `token_revoked_at` 已置 |
| 3 | 改约若重新生成 Token，旧 Token 同样必须失效 | ⑩：改约后旧 Token `TOKEN_INVALID`、新 Token `valid:true`，且 **Visit 数不变** |
| 4 | 客户短信与师傅短信必须是两个独立 scene，不得混用模板 | ②⑨：首次为 `dispatch_customer` + `technician_task`；改派为 `dispatch_update` + `technician_task` + `technician_assignment_cancelled`（三个不同 scene、三个不同收件人） |
| 5 | `SmsProvider` 必须保持抽象：`TicketService` 不得直接依赖阿里云 SDK | 静态：`services/` 下无 `@alicloud/*` 依赖，三个实现经 `createSmsProvider()` 注入；离线 §4d 经 mock 通道取证 |
| 6 | 短信返回 `accepted` 只能记「已受理」，绝不能记 `delivered` | ③：所有 `accepted` 行 `delivery_status` 恒为 `pending`；`delivered` 行数 = 0；类型上 `SmsSendResult.deliveryStatus` 钉死为字面量 `'pending'` |
| 7 | 派工状态 / Visit / Token / TicketEvent / SmsLog 的事务边界（防"半成功"） | ⑫：被拒绝的改派零副作用；离线：`enqueue` 在事务内、`flush` 在提交后 |
| 8 | 后台 UI 的门店数据范围必须继续使用服务端权限，不得改成前端传 `store_id` 过滤 | ⑭：门店用户派**他店**工单 → 404，且他店工单上**没有**产生 Visit；反向对照（本店工单）走到业务语义 409 |
| — | 附加：短信通道未就绪时不得阻断业务 | ⓿：`sms.enabled=false` 时派工 200、Visit 已建、两条短信如实记 `rejected` + `SMS_DISABLED` |

---

## 7. 事务边界（设计决策，G 步落地）

| 边界 | 决策 | 理由 |
|---|---|---|
| Ticket 状态 + Visit + Token + `dispatched` 事件 | **同一事务** | 四者任一缺失都会造成"显示已派工但实际没有可执行 Visit"的半成功态；同事务后该状态在物理上不可能出现 |
| 短信发送（外部 HTTP 调用） | **事务提交后**执行 | 外部调用不可回滚；放事务内会持锁等网络（慢供应商直接拖垮派工吞吐） |
| `SmsLog` 落库 + `sms_sent` / `sms_failed` 事件 | **短信发送后的独立事务** | 短信失败**不得**回滚已成功的派工（师傅已在路上，回滚比通知失败更糟）；但必须留痕且在 UI 可见（工单"通知异常"标记），不允许静默 |
| `VisitService.create` 的取号 | 在**调用方事务内** | 取号与 Visit 插入必须原子；服务自身开事务会形成嵌套事务，掩盖边界 |

---

## 8. 两个验收探针与**生产环境自毁闸**（DEV-41）

Phase 4 的硬门槛「改派后旧 Token 必须立即失效」**必须在 HTTP 层被证明**，但两个前提同时成立：
① 师傅端页面是 **Phase 5** 的交付物；② Token 明文**只在短信里**，没有取回通道就无从发起这次校验。

三条路里选的是第三条：

| 备选 | 否决 / 采纳理由 |
|---|---|
| A. 不验，等 Phase 5 | 等于让本阶段最硬的门槛只停留在单测里；单测调一下 service 无法证明"HTTP 入口走的是同一套校验" |
| B. 开一个匿名资源给验收脚本 | 会**永久**扩大对外暴露面（Phase 5 交付后它还在），用一个长期风险换一次验收 |
| **C. 已登录 + 总部特权的探针，且只在 mock 通道存在** | **采纳** |

- `POST /api/svc:tokenCheck` 与 `GET /api/svc:smsOutbox` 均走 `loggedIn` + `assertCapability(PRIVILEGED)`，
  并各自先过一道 `assertMockChannelOnly()`：**`sms.provider` 一旦不是 `mock` 立即返回 404 `NOT_FOUND`**（不是 403）。
- **为什么是 404 而不是 403**：403 的语义是"接口在这里，你没权限"；404 是"这里什么都没有"。
  真实通道下这两个探针**本来就不该存在**，404 才是诚实的表达 —— 不给攻击者任何"生产环境里有个调试入口"的信号。
- **为什么能力校验必须先于自毁闸**：顺序反了，一个只读账号就能先探出"这个接口到底存不存在"。
  离线断言已把这点钉死（`verify-plugin-load.mjs` 【4d】）：非 mock → 两个探针均 404（带 mock 通道**反向对照**防空转）；
  `viewer` 角色 → **403 FORBIDDEN**。
- `tokenCheck` 调用的是与未来师傅端接口**完全相同**的 `TokenService.verify()`；`smsOutbox` 只回**脱敏**收件人。

---

## 9. 「改派后旧 Token 失效」的表达形态（DEV-45 — ✅ **已接受偏差 / ACCEPTED**，2026-09-21）

| 项 | 内容 |
|---|---|
| 原条款写法 | `docs/DEV-PLAN.md` Phase 4 步骤 J 曾写本阶段断言「含**改派后旧 Token 401**」 |
| 实际交付 | 探针 `svc:tokenCheck` 返回 **HTTP 200** + `{ valid: false, code: 'TOKEN_INVALID' }` |
| 为什么不是 401 | `tokenCheck` 是**总部诊断查询**，回答的是"这个 Token 有效吗"这个**问题**，而非"我要用这个 Token 通过认证"—— **查询本身成功了（200），查询结果是"无效"（valid:false）**。若返回 401，总部运维将无法区分"被问的 Token 无效"与"**我自己的登录态过期了**" —— 两者都长成 401，而处置方式完全不同 |
| **裁定结果** | ✅ **复核方于 2026-09-21 明确接受当前实现，不要求改成 401，无任何代码改动。** 并把 `401` 归还到它真正应该出现的位置：**Phase 5** 的 `GET /api/technician/visits/:token` —— 那里师傅 Token **本身就是访问该资源的认证凭证**，"Token 无效"就是"你未被认证" |
| **条款措辞已改** | 不再写死探针状态码，改为**语义要求**：<br>*"改派后旧 Token 必须立即失效。Phase 4 内部 `tokenCheck` 诊断探针以 `200 + valid:false + TOKEN_INVALID` 证明失效；Phase 5 正式师傅匿名接口使用失效 Token 必须返回 `401 TOKEN_INVALID`。"*<br>**原因**：把探针状态码写死进条款，迟早出现"实现其实正确、规格文字制造假红灯" |
| 探针的三重约束 | ① 要求**总部特权**角色（非特权一律 403）；② **仅在 `sms.provider=mock` 时存在**，真实通道直接 **404**；③ 内部失效原因（过期 / 已用 / 被改派 / Visit 非活跃）**不外露** |
| 语义等价性 | ① 被问的 Token 由 `TokenService.verify()` 判定，**与未来师傅端接口是同一个函数**；② 失败一律 `TOKEN_INVALID`；③ 响应体逐字搜索**找不到** `reassigned` 等字样（冒烟有专门断言钉这一点） |

> **通用规则（值得推广）**：**诊断接口的返回值不应借用认证失败的状态码** ——
> 前者回答"这个凭证有效吗"（**查询成功 → 2xx**，结论在 body 里），后者表达"你未被认证"（→ **401**）。
> 两者混用会让调用方**无法区分是谁的凭证有问题**。

> **Phase 5 的对应硬验收矩阵**（已写入 `docs/DEV-PLAN.md` §Phase 5）：
> Visit #1 的 Token A 改派前 → `200`；**同一条 Token A 改派后 → `401 TOKEN_INVALID`**；
> 新 Visit #2 的 Token B → `200`；过期 / 已使用 / 随机不存在 → **一律 `401 TOKEN_INVALID`**（不透露原因）。

---

## 10. DEV-41 ~ DEV-47

| 编号 | 一句话 |
|---|---|
| DEV-41 | 两个 Phase 4 验收探针自带**生产环境自毁闸**（非 mock → 404），且能力校验**先于**自毁闸 |
| DEV-42 | `service_mode=remote` 在 Phase 4 一律拒绝（422 `REMOTE_MODE_DEFERRED`），避免与 M11 撞出两条矛盾 Visit |
| DEV-43 | `cancel` / `transfer` 必须**同时作废**进行中的派工并通知原师傅（数据完整性问题，非通知问题） |
| DEV-44 | 短信的**事务性发件箱**：`SmsLog.send_status` 新增第四态 `pending`；`accepted` ≠ `delivered` |
| DEV-45 | 「改派后旧 Token 失效」的形态是 `200 + {valid:false}` 而非 401（✅ **已接受偏差 / ACCEPTED**，2026-09-21） |
| DEV-46 | 启动期**参数种子自愈**：新增参数如何到达已安装的旧实例（`repairSettings()`，按 key 只增不改） |
| DEV-47 | 收口时发现**三处"注释正确、代码不对"**（取消短信 `visitId` 落空 / `DISPATCH_UPDATE` 无调用方 / scene 注释与取值不符） |

**DEV-47 的共性教训**：三处都是"先写注释（想清楚要什么），代码凑合（当时拿不到所需输入）"，于是**代码与注释相反**。
共同特征是：**不报错、不崩、测试全绿**，只会在三个月后被人问"这条数据到底什么意思"时暴露。

本项目已有"规格与代码不一致时以代码为准并改注释"的口径，但这次方向相反 —— **注释是对的，代码是错的**。
区分办法只有一个：注释里出现"刻意 / 故意"这类措辞时，必须回头确认代码真的那么做了；
写注释时若发现自己拿不到某个输入，**当时就该补上参数**，而不是在注释里描述一个没实现的行为。

---

## 11. 当前已知限制

### 11.1 语义与判定

| 限制 | 说明 | 影响 |
|---|---|---|
| 改派**必须**换责任人 | 责任人（`technician_mobile` + `provider_name` + `service_mode`）不变时返回 422 `SAME_RESPONSIBLE_PARTY` | 只改姓名 / 只改预约时间分别走 M8 / M5，不要挤进 `reassign` |
| `remote` 不进派工 | `DISPATCHABLE_SERVICE_MODES` 不含 `remote`；Phase 6 交付 M11 前一律 422 | 需要远程处理的工单在 Phase 6 前无法派工，这是**刻意**的（DEV-42） |
| `sms.enabled` 默认 `false` | 供应商账号 / 签名 / 模板的审批是**站外**流程 | 未审批前派工仍成功，短信记 `rejected` + `SMS_DISABLED`；后台需能看见"通知异常" |
| 短信失败**不回滚**派工 | 事务性发件箱语义 | "通知没发出去"必须靠 `SmsLog` + UI 标记被发现，不能期望业务失败来报警 |
| `delivered` 恒为 `pending` | 送达状态只能由供应商回执更新（Phase 8） | 本阶段**无法**回答"客户到底收到没有"，这是设计边界 |

### 11.2 验收与环境

| 限制 | 说明 |
|---|---|
| 两个探针**仅 mock 通道可用** | 切到真实通道后 `tokenCheck` / `smsOutbox` 返回 404。想跑 §4d 必须先确认 `sms.provider=mock` |
| §4d 每轮固定等待 **11 秒** | `sms.enabled` 由 `ConfigService` 以 **10s TTL** 缓存在进程内，刚写完库就断言会读到上一个值 → 假红灯。全脚本只有这一处等待，且它等的是一个**确定**的事实（缓存过期） |
| `sms.enabled` 的改动**必须**在 `finally` 恢复 | 断言脚本读取 `PHASE4_SMS_RESTORE`（而非假设它是 `false`）原样写回 |
| 断言必须与库龄无关 | 发件箱取回必须按 `ticket_no` + `scene` **双重过滤**，不得"取最新一条"（工程铁律 6） |
| 手机号维度的守卫**按号计** | §4d 每轮用独立客户手机号，复用固定号会被上一轮吃掉额度 |

### 11.3 尚未交付（**阻塞 Phase 5**）

| 项 | 状态 | 说明 |
|---|---|---|
| 后台页面：我的门店工单 / 全量工单 / 工单事件时间线 / 派工记录 | ✅ 已交付 | 由 `scripts/seed-admin-pages.mjs` 播种，四页全部落库并回查通过。见 §13 |
| 后台页面：**工单详情（H3）** | 🟡 降级交付 | 蓝图弹窗在本版本**不可能合法实现**（约束 3），改为「列表放足关键列」+ 客户端只读抽屉补齐。见 §13.2 |
| 后台页面：**受理 / 派工 / 改派 / 改约 业务按钮（H6）** | ⬜ 未交付 | 需注册 4 个自定义客户端 ActionModel，属客户端代码 + UMD 构建，见 §13.4 |
| **真实售后人员 UI 走查（I）** | ⬜ 未进行 | 走查脚本见 §12.2；观察项清单见 §13.5。走查人与走查时间**未记录** |
| `storeUsers` 门店用户映射**种子** | ⬜ 未交付 | 仍等业务方给账号清单；当前仅验收期临时建号。§12.2 第 7/8 条依赖它 |

---

## 12. 强制条款（`docs/DEV-PLAN.md` §「Phase 4 的强制交付条款」）

1. **后台业务页面必须在本 Phase 完成前交付**：我的门店工单（状态 Tab）/ 全量工单 / 工单详情（含事件时间线区块）/ **Visit 派工历史与状态区块**。
   Phase 2 的该缺口**只允许重排期到本 Phase，不允许继续顺延**。
   → **🟡 部分交付**：四张页面已落库（§13.1）；**工单详情为降级交付**（§13.2）、
   **业务按钮（H6）未交付**（§13.4）。**条款本身尚未关闭**。
2. **Phase 4 验收必须包含真实售后人员的 UI 走查**：派工 / 改派 / 改约的验收**不得只用 `curl` 或 API 断言下结论**，
   必须由真实售后人员在浏览器页面上完整走一遍，并记录走查人与走查时间。 → **当前未完成**
3. 走查发现的可用性问题与本 Phase 的功能缺陷**同等对待**：未关闭不得进入 Phase 5。
4. **「真人走查」不可用自动化替代**（2026-09-21 复核方明确）：Playwright / Selenium 之类自动化浏览器脚本
   **可以额外做**（用于回归），但**不能作为 I 的验收证据** —— 本条款要的是"**实际人员使用后的可用性验证**"，
   自动化脚本无法产出"人在真实操作中卡在哪一步"这类结论。 → **当前未完成**

#### 12.1 H 的交付范围（**不得越界到 Phase 6**）

> ⚠️ **命名陷阱**：Visit 区块**本期只做「查看派工历史与状态」**。
> 不要因为看到"Visit 区块"就把 Phase 6 的**门店确认 / 驳回、照片审核、收费确认**提前做进来 —— 那些仍属于 Phase 6。
>
> 本期展示：`visit_no` / `visit_status`（`ASSIGNED` / `SUBMITTED` / `SUPERSEDED` / `CANCELLED`）/
> 师傅姓名与手机号（**快照**）/ 预约时间 / `reassigned_from_visit_id` 指向的上一次派工 /
> `token_revoked_reason` 反映的链接失效原因。**只读，不提供审核动作。**

#### 12.2 I 的走查脚本（必须在浏览器里逐屏走完）

| # | 身份 | 操作 | 期望可见结果 |
|---|---|---|---|
| 1 | 门店售后账号 | 登录 → 进入「我的门店工单」 | 只看到**本店**工单 |
| 2 | 门店售后账号 | 打开 `NEW` 工单 → 点「受理」 | 状态变为已受理（`PROCESSING`） |
| 3 | 门店售后账号 | 派工给**王师傅** | 出现 **Visit #1**，状态 `ASSIGNED` |
| 4 | 门店售后账号 | 改派给**李师傅**（填原因） | **Visit #1 仍在**且显示 `SUPERSEDED`；**Visit #2** 显示 `ASSIGNED` |
| 5 | 门店售后账号 | 对 Visit #2 **改约**（改预约时间） | **Visit 数量不增加**（仍为 2 条） |
| 6 | 门店售后账号 | 查看工单详情**事件时间线** | 受理 → 派工 → 改派 → 改约 **按序可见** |
| 7 | **总部账号** | 进入「全量工单」 | 能看到**所有门店**的工单 |
| 8 | **另一门店账号** | 进入「我的门店工单」 | **看不到**上面那家店的工单 |

> 第 7/8 条是**数据范围**的真人验证。服务端权限已由 §4d ⑭ 在 HTTP 层证明（他店 404），
> 本条要证明的是"**页面上**也不会漏出来"。
>
> ⚠️ 第 7/8 条需要**至少两个门店**的账号，依赖 `storeUsers` 门店用户映射种子（业务方账号清单仍未给到）。
> 若走查时种子未就绪，可临时建号完成走查，但**必须在走查记录里注明"账号为临时创建"**。

> **当前结论（2026-09-21 复核方裁定 + H 步进展）**：
> · **服务层 A~G + 总闸 J = ✅ PASS**（总闸全绿含 §4d 16 条；提交 `453570e`）；
> · **DEV-45 = ✅ 已接受偏差** —— 保留 `200 + {valid:false}`，**无代码改动**；`401` 归还给 Phase 5 认证接口；
> · **H 后台页面 = 🟡 部分交付** —— 四张页面已落库（§13.1），
>   工单详情**降级交付**（§13.2）、业务按钮（H6）**未交付**（§13.4）；
> · **I 真人 UI 走查未进行 → 阶段整体 🟡 HOLD，不得进入 Phase 5**。
>
> 本报告 §1~§11 可作为 **H 步的规格依据**（页面要展示的状态、Visit 字段、事件时间线均已定型），
> §13 记录 **H 的实际交付形态与降级原因**。

### 后台形态（已裁定）

**NocoBase 原生后台页面为主 + 少量自定义 NocoBase 客户端组件 / 动作增强**，**不做独立 Vue3 管理端**。
理由：门店范围、字段白名单、权限判定全部已在服务端就位；原生页面直接吃这套 ACL，
不需要在第二个前端里重新实现一遍数据范围 —— 而"第二处实现"正是 Phase 2 已确认不重构的设计要避免的。

---

## 13. Phase 4-H 后台页面交付说明（2026-09-21）

> 本节的文档定位：**§1~§11 是规格依据，本节是"实际交付成了什么样、哪些地方降级了、为什么"。**
> 降级项一律如实登记，不用"已交付"三个字盖过去。

### 13.1 交付方式与页面清单

页面落库在 `desktopRoutes` / `flowModels` / `rolesDesktopRoutes` 三张表里 ——
**是数据，不是配置文件**。所以交付物必须是**可重建的脚本**，而不是"在某台机器的后台点出来的页面"
（与 `seeds/` 的「代码即事实来源」同一条纪律；手点的页面在清库/换机后就没了，也无法 code review）。

**交付物**：`scripts/seed-admin-pages.mjs`（幂等：按页面标题查 `desktopRoutes` →
不存在则 `mode=create`、已存在则 `mode=replace` + `target.pageSchemaUid`）。
退出码约定与其它脚本一致：`0` 成功 / `1` 失败（校验 400 会把 `details` 原样打印）/ `2` 环境未就绪。

| # | 页面 | Tab | 集合 | 关键列 |
|---|---|---|---|---|
| H1 | **我的门店工单** | **6 个状态 Tab**：全部 / 待受理 / 处理中 / 待门店确认 / 待客户评价 / 已闭环 | `serviceTickets` | `ticket_no`、`status`、`ticket_type`、客户姓名/手机、`content`、师傅姓名/手机、`expected_visit_at`、`createdAt` |
| H2 | **全量工单** | 单 Tab | `serviceTickets` | 同上，另加**当前门店**一列 |
| H4 | **工单事件时间线** | 单 Tab | `ticketEvents` | `ticket`、`event_type`、`from_status` → `to_status`、`operator_kind`、`operator_user`、`summary`、`createdAt` |
| H5 | **派工记录** | 单 Tab | `serviceVisits` | `ticket`、`visit_no`、`visit_status`、`service_mode`、师傅姓名/手机（快照）、`provider_name`、`expected_visit_at`、`assigned_at`、`superseded_at`、**`token_revoked_reason`**、`createdAt` |

四张页面统一挂在导航分组 **「售后工单」** 下。H1 的每个状态 Tab 带 `defaultFilter`
（`{logic:'$and', items:[{path:'status',…}, …恒真条件]}`），所以"点进去就是那个状态的工单"。

**数据范围（门店隔离 / 总部全量）由服务端 ACL 决定，不由页面决定** ——
这正是「后台形态：NocoBase 原生后台 + 少量自定义组件」这条裁定的意义：
页面直接吃已有的门店范围与字段白名单，**不需要在第二个前端里重新实现一遍数据范围**
（"第二处实现"正是 Phase 2 已确认不重构的设计要避免的）。

### 13.2 ⚠️ 降级交付：工单详情**不能**用蓝图弹窗（约束 3）

这是本步骤最重要的一条记录，因为它**改变了 H3 的实现路径**。

`flowSurfaces:applyBlueprint` 在 NocoBase 2.2.15 上**无法**给服务工单相关页面挂弹窗：

- 只要文档里出现弹窗，校验器就会把弹窗内容编译成**额外的 `compose` 步骤**，
  而该步骤 payload 的 `defaults` 是 `undefined` —— 于是弹窗内数据区块的默认 `edit` 动作
  在这一步被判 400。这不是"配置写错了"，而是**编译器的行为**（已用容器内插桩取证，
  见 `docs/DEVIATIONS.md` DEV-53）。
- 唯一的合法豁免路径，是给区块声明**内联 `edit` popup**（要求恰好 1 个 `editForm`，
  规则 `custom-edit-popup-edit-form-count`）。那等于**给工单开一张绕过状态机的表单** ——
  与 Phase 2 已确认不重构的设计（"状态写入唯一入口 `TicketService`"）直接冲突，
  属**设计禁止项**，不能为了"把页面建出来"而采用。

**因此：H3 工单详情改为降级交付** ——

| 原计划 | 实际交付 |
|---|---|
| 列表 + 蓝图弹窗详情页 | **列表放足关键列**（见 §13.1 的列清单）+ **H6 落地时补一个客户端只读抽屉**（自渲染，不经过 blueprint 校验器） |

> 状态：**列表侧已交付**；**只读抽屉尚未落地**（属 §13.4）。

**同时接受一个界面噪音**：编译器会给每个表格区块**自动合并**
`actions:[filter, refresh, bulkDelete, addNew]` + `recordActions:[view, edit, delete]`，
并且**无法从蓝图文档里移除**。这些写动作对门店角色会被 ACL 挡成 403
（不会真的改坏数据），但按钮**确实会出现在界面上**。
处置：不掩盖，登记为 **I 走查的观察项**（§13.5 第 9 条）——
真人走查时要记录"有没有人误点、误点后看到什么"，那是可用性结论，不是功能缺陷。

### 13.3 一个必须写清楚的自相矛盾：敏感列**必须**进分组

`applyBlueprint` 有一条硬校验 `default-field-groups-incomplete`：
当表格区块的业务字段超过阈值（`LARGE_GENERATED_POPUP_FIELD_GROUPS_THRESHOLD = 10`）时，
`defaults.collections.<coll>.fieldGroups` 必须覆盖该集合的**全部字段** ——
**包括 `access_token_hash`、`feedback_token_hash` 这类凭据列**。

也就是说：**为了把页面建出来，必须把敏感列写进分组里。**

它当前成立，唯一的原因是 §13.2 那条结论：这些页面**一个弹窗都不挂**。
前提一旦被违反，fieldGroups 就会真的被渲染成表单项，敏感列直接出现在界面上 ——
而**任何 HTTP 断言都不会变红**。所以这个前提不能靠"注意一点"维持，必须有守护断言：

- 清单抽成单一事实来源 **`scripts/expected-sensitive-columns.mjs`**（播种脚本与总闸共用一份）；
- 总闸新增三条断言（§13.6）。

**一处刻意的例外**：`token_revoked_reason` 虽然在 `NATIVE_READ_FIELD_DENY` 里
（不能走原生只读接口下发），但它**是业务上必须看得见的** ——
派工记录页要显示"这条链接为什么失效"（§12.1）。它的取值是
`REASSIGNED` / `RESCHEDULED` 这类枚举，不含凭据。
**判据是"泄露了会不会被利用"，不是"名字里有没有 token"** ——
所以它归业务字段分组，**不在**敏感列清单里。

### 13.4 尚未落地的部分（H3 详情抽屉 / H6 业务按钮）

| 项 | 内容 | 为什么算 H 而不是别的阶段 |
|---|---|---|
| 只读详情抽屉 | 在 H1/H2 列表上点工单 → 侧滑抽屉展示 §13.1 全部列 + 事件时间线与派工历史 | 是 H3 的降级替代路径（§13.2） |
| 4 个业务动作 | **受理 / 派工 / 改派 / 改约**，各注册一个 NocoBase 自定义客户端 `ActionModel`，调用既有 `svc` 业务接口 | 走查脚本 §12.2 第 2~5 步要求"在页面上点"，不点就不算交付 |

两者的共同约束：**只调已存在的服务端接口**（`TicketService` 的受理、
`dispatch` / `reassign` / `reschedule`），**不新增任何状态写入路径** ——
否则就绕开了"状态写入唯一入口"这条 Phase 2 已确认不重构的设计。

> 这两项是**下一个可提交里程碑**：客户端代码 + UMD bundle 构建（走 `scripts/build-plugin.mjs`
> 的既有通道），不涉及服务端 schema 变更，因此不会重开 §4d 的 16 条断言。

### 13.5 I 走查的观察项（**除 §12.2 的 8 步之外，必看这 4 条**）

1. **误点写按钮**：列表上的"新建 / 编辑 / 删除"是编译器自动合并的（§13.2），
   门店角色点下去是 403。记录：**有没有人误点**、误点后界面给出的提示**看不看得懂**。
2. **`sms.enabled=false` 的通知异常**：派工成功但短信记 `rejected` + `SMS_DISABLED`（§11.1）。
   当前后台**没有**专门的"通知异常"标记 —— 记录：真人**能不能察觉**这条工单的客户其实没收到短信。
3. **状态 Tab 是否够用**：6 个 Tab 是按状态切的。记录：真实售后人员**习不习惯**这种切法，
   有没有"我就想看今天该我处理的"这类需求（那可能是 Phase 6 的排期输入，**不在本期做**）。
4. **字段名是否要培训**：`service_mode`、`provider_name`、`superseded_at` 这些列名
   在界面上是**数据库口径**。记录：哪几个**必须解释才能看懂** —— 这是"要不要改标签"的决策依据。

### 13.6 守护断言（`smoke-test.mjs` §4e 第 5 组，3 条）

| 断言 | 若缺失会怎样 |
|---|---|
| 四张页面均已落库（`type='flowPage'` 且标题匹配、`enableTabs` 与清单一致） | 页面被删 / 播种脚本被误删 → **后台导航空空如也，而所有 `/api` 断言照样全绿** |
| **任何区块都不引用敏感列**（导出每页蓝图，取 `fields[].field` + `sorting[].field` + `defaultFilter.items[].path` 三个来源） | §13.3 的前提被违反时**不会变红** → 凭据列悄悄出现在界面上 |
| 每个带 `defaultFilter` 的动作覆盖 ≥3 个可筛选字段，且**确实存在至少 1 个**（`checked > 0`） | 筛选条件被删成一条 → "点进 Tab 看到全部工单"；`checked > 0` 是防空过 |

三条都带**正对照**（蓝图必须有 Tab、每个区块 ≥3 个可见字段），
避免"页面是空的"这种状态下断言假绿 —— 工程铁律 1 的落地。

**为什么用 `flowSurfaces:exportBlueprint` 而不是"检查我们发送了什么"**：
发送成功 ≠ 落库成功 ≠ 界面上就是这个样子。导出的是**校验器认的那份页面内容**，
是被编译器改写之后的权威视图（例如自动合并的动作就是从这里才看得见）。

---

## 14. 下一阶段（**前置：Phase 4-H / I 必须先关闭**）

> ⛔ **Phase 5 暂不允许开始**（2026-09-21 复核方裁定）。
> 唯一正确的下一步是 **Phase 4-H（后台页面）+ Phase 4-I（真人 UI 走查）** —— 走查脚本见 §12.2。
> H 的当前完成度与降级项见 §13。

**Phase 5 — 师傅 H5**：`/technician/visit/:token` 页面；`GET /api/technician/visits/:token`；
`POST .../files`（私有存储 + magic bytes + 去 EXIF + 受控读取）；`POST .../submit`（收费校验）；
提交后置 `WAIT_STORE_CONFIRM` 且**不发评价短信**。

**Phase 5 的硬验收（Token 失效矩阵 —— 与 Phase 4 的语义要求一一对应；完整表见 `docs/DEV-PLAN.md` §Phase 5）**

| 场景 | 预期 |
|---|---|
| Visit #1 的 Token A，改派发生**前** | `200` |
| **同一条 Token A**，改派发生**后** | **`401 TOKEN_INVALID`** |
| 新 Visit #2 的 Token B | `200` |
| 已过期 / 已使用 / 随机不存在 | 一律 **`401 TOKEN_INVALID`**（不透露原因，维持防枚举） |

**恢复期注意事项**：

- Phase 5 的师傅端接口与 Phase 4 的 `tokenCheck` 探针**必须共用** `TokenService.verify()` ——
  它是"HTTP 入口走的是同一套校验"这一主张的物理保证。
- `tokenCheck` 探针**不因 Phase 5 交付而删除**：它验证的是"Token **没通过**"这一侧，
  而那正是匿名接口不该对外暴露的细节（错误原因的区分）。
- Phase 4 引入的新写入口（派工 / 改派 / 改约）依赖与 Phase 3 同一套守卫与事务纪律，
  Phase 5 再引入照片上传与 submit 后需**重新回归**这两条结论。
