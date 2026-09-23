# Phase 4 — 派工 / ServiceVisit / 双短信（阶段交付报告）

> **状态：🟡 HOLD —— 服务层 ✅ PASS，阶段整体「未关闭」，不得进入 Phase 5**（2026-09-21 复核方裁定）
>
> | 部分 | 裁定 |
> |---|---|
> | **服务层 A~G + 总闸 J** | ✅ **PASS** —— 92 项总闸全绿（含 §4d 16 条），提交 `453570e` |
> | **DEV-45**（旧 Token 失效的表达形态） | ✅ **已接受偏差 / ACCEPTED** —— 保留 `200 + {valid:false}`，**无需改代码**；`401` 归还给 Phase 5 认证接口（见 §9） |
> | **H 后台页面 + H3/H6 客户端代码** | 🟡 **代码已交付 / UI 未走查** —— 四张页面已落库，详情抽屉与四个业务按钮已交付；**两处接口契约缺陷（`service_mode` 枚举 / `X-Request-Id`）已于 2026-09-21 收口**（§13.4.2） |
> | **I 真人 UI 走查** | 🟡 **走查环境已就绪，待执行** —— 临时 UAT 账号已建、两店 UAT 工单已备、前哨全绿；**尚未签署结果 → 阶段整体 HOLD**，这是**当前唯一的阻塞项**（见 §12 / §13.5 / `docs/PHASE-4-I-UAT.md`） |
>
> 2026-09-21 服务层与 action 层完成 · 2026-09-21 `smoke-test.mjs` §4d 共 16 条断言真机全绿 · 2026-09-21 收口 DEV-47 三处"注释正确、代码不对" · 2026-09-21 复核方裁定：**服务层 PASS / DEV-45 接受 / 整体 HOLD**
>
> 本文件是 Phase 4 的**独立阶段报告**。逐条验收口径的原始出处见 `docs/DEV-PLAN.md` §「Phase 4 — 派工 / ServiceVisit / 双短信」，
> 偏差登记见 `docs/DEVIATIONS.md`（**DEV-41 ~ DEV-47**），变更历史见 `CHANGELOG.md`。
>
> ⚠️ **本阶段按 Phase 4 强制条款 尚未关闭**：后台业务页面代码（我的门店工单 / 全量工单 /
> 工单详情含时间线 + Visit 区块）**已交付**，但**真实售后人员 UI 走查未进行**，
> 因此**不得进入 Phase 5**。详见 §12 / §13.5。

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
| H | 后台 UI：我的门店工单 / 全量工单 / 工单详情（时间线 + Visit 区块） | 门店范围继续走**服务端权限** | 🟡 **代码已交付 / UI 未走查**（强制条款 1 未关闭，只差 I） |
| I | **真实售后人员 UI 走查**（派工 / 改派 / 改约） | 记录走查人与走查时间 | 🟡 **环境已就绪 / 结果未签**（强制条款 2 未关闭，见 §12.3） |
| J | 断言并入 `smoke-test.mjs` 总闸 | 含「改派后旧 Token 失效」 | ✅ §4d 共 **16 条**，真机全绿 |

**校验基线（2026-09-21 真机实测，退出码均为 0）**：

| 脚本 | 结果 |
|---|---|
| `verify-config.mjs` | **48 / 48** |
| `verify-plugin-load.mjs` | **59 / 59**（含新增【4d】2 条探针自毁闸） |
| `verify-client-logic.mjs` | **36 / 36**（H6 矩阵 / H3 时效 / **写请求契约 / 派工参数契约**，离线） |
| `verify-phase3-h5.mjs` | **35 / 35**（H5 前后端契约 + 10 路并发取号 + 构建产物） |
| `smoke-test.mjs` | **116 / 116**（含 §4b 8 项 / §4c 12 项 / §4d 16 项 / **§4e 10 项** / **§4f 10 项**） |

> ⚠️ 数字会随阶段演进，**引用时以脚本实际输出为准**，不要照抄本表。

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
| 后台页面：**工单详情（H3）** | 🟡 代码已交付 / UI 未走查 | 只读抽屉已交付（§13.4），**降级的是"蓝图弹窗页"而不是抽屉**；仅未经真人走查，见 §13.2 |
| 后台页面：**受理 / 派工 / 改派 / 改约 业务按钮（H6）** | 🟡 代码已交付 / UI 未走查 | 4 个客户端 ActionModel 已注册；service_mode 与 X-Request-Id 两处接口契约已收口并加断言（§13.4.2），见 §13.4 |
| **真实售后人员 UI 走查（I）** | 🟡 环境已就绪 / 结果未签 | 走查脚本见 §12.2；组织与记录见 §12.3（`docs/PHASE-4-I-UAT.md`）；观察项清单见 §13.5。走查人与走查时间**待填** |
| `storeUsers` 门店用户映射**种子** | ⬜ 未交付 | 仍等业务方给账号清单；当前仅验收期临时建号。§12.2 第 7/8 条依赖它 |

---

## 12. 强制条款（`docs/DEV-PLAN.md` §「Phase 4 的强制交付条款」）

1. **后台业务页面必须在本 Phase 完成前交付**：我的门店工单（状态 Tab）/ 全量工单 / 工单详情（含事件时间线区块）/ **Visit 派工历史与状态区块**。
   Phase 2 的该缺口**只允许重排期到本 Phase，不允许继续顺延**。
   → **🟡 代码已交付 / UI 未走查**：四张页面已落库（§13.1）；**工单详情为降级交付**
   （降级的是"蓝图弹窗页"，只读抽屉已交付，§13.2）；**业务按钮（H6）代码已交付**
   且两处接口契约缺陷已收口（§13.4 / §13.4.2）。**条款本身仍未关闭 —— 缺的是 I 真人走查**。
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
> · **H 后台页面 = 🟡 代码已交付 / UI 未走查** —— 四张页面已落库（§13.1），
>   工单详情**降级交付**（§13.2，只读抽屉已交付）、业务按钮（H6）**代码已交付**；
>   **H6 的两处接口契约缺陷（`service_mode` 枚举 / `X-Request-Id` + request-id 幂等）已收口**（§13.4.2）；
> · **I 真人 UI 走查未进行 → 阶段整体 🟡 HOLD，不得进入 Phase 5**

#### 12.3 走查组织与记录（2026-09-21 新增）

走查**不再停在纸面脚本**，已完成全部可由自动化固定的前置工作，并留出只由真人回答的部分：

| 事项 | 落地物 | 说明 |
|---|---|---|
| 走查记录表 | **`docs/PHASE-4-I-UAT.md`** | 环境事实表 + 8 步勾选表 + 4 个观察项 + 问题整改表 + 结论签署 + 走查后清理 |
| 临时 UAT 账号 | `scripts/uat-accounts.mjs` | `--create` / `--create --bootstrap-uat-ticket` / `--reset-password` / `--list` / `--delete`。**通过真实 `storeUsers` 关系**映射门店 S01 / S02 |
| 走查前哨 | `scripts/uat-preflight.mjs` | 只读：账号可登录+角色+门店映射、UAT 工单状态与起始基线、数据范围预演；末尾打印**只能由真人回答**的清单 |
| UAT 工单 | `FW20260922-0002`（门店 S01，id=886）／`FW20260922-0003`（门店 S02，id=887） | 走真实匿名接口 `/api/public/tickets` 创建，**不直接 INSERT**；两店各一张，第 7 步才可证伪 |

> ⚠️ **隐私约束（仓库为 public）**：`docs/PHASE-4-I-UAT.md` 只记**代号**（`UAT-A` / `UAT-B` / `UAT-HQ`），
> **不写真实姓名、手机号、邮箱、口令**；临时口令用 `randomPassword()` 现场随机生成，
> 只落本机 `.env` 与 stdout，**绝不入库**。验收后 `--delete` 回收账号。
>
> ⚠️ **不得提前培训按钮位置**：只给目标（"请把这张报修单受理，然后派给王师傅"），
> 观察真人能否自己找到 —— 否则只能证明功能存在，证明不了后台能用。
>   —— **I 是当前唯一阻塞项**，契约类缺陷已由自动化覆盖，真人时间应花在 UX 判断上。
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

#### 13.1.1 工单号搜索框（2026-09-22 走查前补，来自真人反馈）

**问题**：原设计的 `actions:['filter']` 在界面上只渲染成一个**图标按钮**。真人走查账号
UAT-A 登录后反馈「登录后没有工单 FW20260922-0002，也没有搜索功能」——
排查结论是**数据没丢**（目标单确实在列表里），真正的原因是：
① 门店 S01 当时累积了 2xx 张脚本噪声工单，默认 `-createdAt` 倒序把目标单压到了第 2 页；
② 页面上**没有显眼的搜索入口**，只有一个不显眼的漏斗图标。

**处置**：
- 数据侧：清掉脚本噪声，走查基线收敛为每店一张（详见 `docs/PHASE-4-I-UAT.md` 基线说明）。
- 页面侧：H1 / H2 的**每个** Tab 顶部增加一个常驻 `filterForm` 区块，字段 = `ticket_no`，
  动作 = `submit` / `reset`。表格下沉到布局第 2 行。

**三条实测约束（改 `scripts/seed-admin-pages.mjs` 前必读）**：

| # | 约束 | 踩到的报错 |
|---|---|---|
| ① | 动作键是**公开键** `submit` / `reset`，不是 `filterFormSubmit` / `filterFormReset` | 400 `addAction only supports registered action types/uses` |
| ② | 区块级不接受 `displayTitle` 等 UI 键（只接受 `key/type/title/description/…/actions/sort/…` 白名单） | 400 `unsupported keys: displayTitle` |
| ③ | `filterForm` 必须**独占 tab 布局的第 0 行**（`block-layout-filter-must-lead`）；`layout` 只能写在 **tab** 上，不能写在 block 上（`block-layout-unsupported`）。且不要手写搜索框与表格的连接 —— 校验器会按字段名自动生成 `filterManager`（手写反而会对不上） | 400 `block-layout-filter-must-lead` |

**守护断言**：`smoke-test.mjs` 新增「工单页面都有显眼的工单号搜索框，且已连到表格上」，
三方向都断 —— ①区块在（FilterFormBlockModel 存在）、②连得上（`filterManager` 指向本 Tab 的表格，
防"框是装饰"）、③搜得对（目标表格的搜索项字段确实是 `ticket_no`，防"连上了但搜别的字段"）。

> ⚠️ **取证陷阱（值得记住）**：搜索项 `FilterFormItemModel` **不能靠树遍历取到** ——
> 它挂在 `FilterFormGridModel` 下，而这个中间节点在 `/api/flowModels:list?paginate=false`
> 的返回里**没有 `parentId`**，树链在那断了。按树遍历会得到 `searched=[]`，
> 看着像"搜索项不存在"的**假红**。正确做法：`FilterFormItemModel` 自带
> `defaultTargetUid`（连到哪张表）与 `filterField.name`（搜哪个字段），直接按 target 索引。

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

**因此：H3 工单详情走降级路径** ——

| 原计划 | 实际交付 |
|---|---|
| 列表 + 蓝图弹窗详情页 | **列表放足关键列**（见 §13.1 的列清单）+ **客户端只读抽屉**（自渲染，不经过 blueprint 校验器） |

> 口径：这是**实现路径的降级**（没有 blueprint 弹窗页），不是"没做"。
> 抽屉本身已交付、可打开，四块内容（基本信息 / 时效 / 派工历史 / 事件时间线）齐备，
> 且派工历史与事件都**由服务端按 ticket_id 查询**，不是前端拉全量再过滤。

> 状态（**2026-09-21 更正**）：列表侧已交付；**客户端只读抽屉已随 H6 交付**（§13.4），
> 仅**未经真人走查**。此前此处写的"只读抽屉尚未落地"是旧状态。

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

### 13.4 H3 详情抽屉 + H6 业务按钮（**已交付代码，⚠️ 未经真人走查**）

| 项 | 交付内容 | 状态 |
|---|---|---|
| 只读详情抽屉（H3） | `src/client/ticket-drawer.tsx` —— 点一行打开侧滑抽屉，四块内容：<br>**① 工单基本信息**（客户 / 门店 / 类型 / 内容 / 当前状态）<br>**② 时效**（报修时间 · 已等待 / 总耗时 · 首响 · 预约时间 · 距预约 / 已超过预约）<br>**③ 派工历史**（Visit #1 SUPERSEDED、Visit #2 ASSIGNED …，含链接失效原因）<br>**④ 事件时间线**（created / accepted / dispatched / reassigned / rescheduled …） | ✅ 代码已交付<br>🟡 **UI 未经真人验证** |
| 4 个业务动作（H6） | `src/client/ticket-actions.tsx` —— 受理 / 派工 / 改派 / 改约，各注册一个客户端 `ActionModel`，只 POST 既有 `/api/svc:*` | ✅ 代码已交付<br>🟡 **UI 未经真人验证** |
| 新增服务端接口 | `POST/GET /api/svc:visits?filterByTk=<工单 id>` —— 按 ticket_id 查派工历史（复用既有 `VisitService.listByTicket`，走 `assertCanAccessTicket`） | ✅ 真机已验证 |

**数据怎么取（复核方明确要求）**：事件与 Visit 都**按当前 ticket_id 在服务端查询**
（`svc:timeline` + `svc:visits`），**不**下载全量再在前端过滤 ——
既省数据，也继续沿用现有的对象级权限。

**时效的范围边界**（复核方明确）：**Phase 4 只展示时间，不做 SLA 引擎。**
"已等待 36 分钟""距预约还有 2 小时""已超过预约 47 分钟"这类文案到此为止；
预警阈值、SLA 扫描任务、总部异常看板全部留在 **Phase 9**，不在本期扩大范围。
`overdue` 只用于把文字标成醒目色，**不做任何判定或拦截**。

**H6 的 UI 状态矩阵**（复核方给定，按字面实现，见 `src/client/action-matrix.ts`）：

| 工单状态 | 显示的按钮 |
|---|---|
| `NEW` | 受理、派工 |
| `PROCESSING` 且尚未派工 | 派工 |
| `PROCESSING` 且已派工 | 改派、改约 |
| `WAIT_STORE_CONFIRM` | 不显示 |
| `WAIT_FEEDBACK` / `CLOSED` / `CANCELLED` | 不显示 |

> ⚠️ **这只是 UX，不是权限控制。** 按钮隐藏/禁用**不能**替代鉴权 ——
> 真正的裁决始终在服务端（PermissionService 能力校验 + 对象级校验 + 状态机）。
> 因此服务端返回 409 / 422 时，前端**原样展示服务端的错误码**，
> 而不是自己编一句"操作失败"（那会让人以为系统坏了）。
> 另外客户端只看得到 `dispatch_at` 是否存在，**看不到当前 Visit 的状态**，
> 所以"已派工"这一维是**尽力提示**，误判的代价只是"点了之后服务端说不行"。

两者的共同约束：**只调已存在的服务端接口**，**不新增任何状态写入路径** ——
否则就绕开了"状态写入唯一入口"这条 Phase 2 已确认不重构的设计。

> ⚠️ **为什么这里标 🟡 而不是 ✅**：本批代码**没有经过浏览器验证**
> （本机无 Playwright，未安装浏览器）。已自动验证的只有：
> ① 客户端纯逻辑（状态矩阵 / 时效文案 / **写请求契约与派工参数契约**）由
>    `verify-client-logic.mjs` **36 项**覆盖；
> ② 产物 **HTTP 200** 且 AMD 依赖全部在"运行时可解析"白名单内（防整页 App error）；
>    §4f 另从**已部署产物**里回读派工选项与 `X-Request-Id` 装配，防"源码对了产物没重新构建"；
> ③ `svc:visits` 的服务端契约。
> **"抽屉长什么样、按钮点不点得动"必须由 I 真人走查确认** —— 这正是 I 存在的理由。

#### 13.4.A ⚠️ 首轮走查 BLOCKED 与整改（2026-09-23）

首轮真人走查结论 **PARTIAL PASS / BLOCKED**：数据隔离全部成立
（UAT-A 只见 S01、UAT-B 只见 S02、UAT-HQ 见两店、工单号搜索可用、对象级越权 404），
但**三个角色均只能查看、无法受理/派工**。

根因**不在 ACL、也不在 TicketService**：五个自定义 `ActionModel` **只在客户端插件里注册了，
从来没有被挂到页面实例上**。「ActionModel 已注册」≠「Action 已挂到页面」。
整改过程暴露两条**架构级**约束，均已留档：

| 编号 | 约束（详见 `docs/DEVIATIONS.md`） |
|---|---|
| **DEV-68** | `applyBlueprint` 的 `actions` / `recordActions` **在架构上无法**声明自定义 ActionModel —— 它只接受编译期硬编码的 catalog publicKey，而自定义动作只注册在浏览器引擎里。**两个互不相通的世界。** 自定义动作**必须**绕过 blueprint、直接写 flowModels。 |
| **DEV-69** | `flowModels:save` 的 payload **就是扁平 model 对象本身**，不能再包 `{values:…}`。多包一层会让 `use` 埋进 `values`，顶层没有 `use` → 客户端解析不出模型类 → **静默不渲染**；而"行存在"是事实，所以只数行数的断言**全绿** —— 比 DEV-68 更隐蔽的假绿。 |

整改后的落地形态（`scripts/ticket-page-actions.mjs` + `seed-admin-pages.mjs`）：

- **挂载点**：`TableActionsColumnModel`（**不是** TableBlock 的 `actions`）—— 行级动作（`scene:'record'`）
  必须挂在行操作列下，与内置 `查看/编辑/删除` 同级；
- **写入**：`POST /api/flowModels:save` 传**扁平行**（`{uid,name,parentId,subKey:'actions',subType:'array',use,props,decoratorProps,stepParams,flowRegistry,sortIndex}`），
  `props` / `stepParams.buttonSettings` 逐字段对齐内置动作；
  用 `save` 而非 `create` —— `create` 不触发 `afterInsert` 钩子、**不建 `flowModelTreePath` 祖先链**，
  节点在库里但 UI 读树时完全看不见；
- **uid 稳定派生**（`<actionColumnUid>.<actionKey>` 的 FNV-1a），保证重复播种**不换 uid、不产生重复按钮**；
- **对账**：`blueprint replace` 每次重建表并换 uid，上一批动作全变孤儿。新增 `reconcileTicketActions()`
  把行数收敛到「活表数 × 5」，连续重跑稳定在 `35 行 / 0 孤儿`。

**已验证（真机）**：

- 五个按钮在 **H1 / H2 页面真实渲染** —— 无头浏览器实测行内按钮
  `["筛 选","重 置","查看","编辑","删除","详情","受理","派工","改派","改约"]`；
- 新增独立验收脚本 **`scripts/verify-ticket-actions.mjs`**（10 项，读**真实 flowModels**）：
  模型类注册（源码 + 产物）/ 各表实例齐全且**顶层 `use` 正确** / `TicketDetailActionModel` 已实例化 /
  无脚本注入的原生写路径 / 行数恒为 `表数 × 5` / 0 孤儿 / 0 病态行；
- **反向验证已做**（`--reverse`，铁律 8）：删掉某表的 `TicketAcceptActionModel` →
  判据**真的变红**并点名该表 → 还原后回到全绿；
- `uat-preflight.mjs` 新增 **§3.6 闸门**（18/18 全绿）：三账号页面上均出现全部 5 个自定义按钮，
  且库内 35 行顶层 `use` 全部正确 —— **"按钮到底有没有"不再留给真人发现**。

> ⚠️ 仍标 🟡 的原因：**H3/H6 的动作链必须在整改后的完整版本上重新走查**
> （受理 → manufacturer 派工 → Visit #1 → 改派 → Visit #1 SUPERSEDED + Visit #2 ASSIGNED
> → 改约 → Visit 数量不增加 → H3 详情抽屉 → 总部全量 → 门店 B 隔离）。
> 首轮已通过的数据隔离结果保留为历史证据。**Phase 4 在此之前继续 HOLD。**

### 13.4.1 角色 → 菜单可见性矩阵（2026-09-21 复核方要求补的验收缺口）

复核时发现的真实缺口：`applyBlueprint` 建页时只把新路由授给内置的 `member` + `admin`，
**四个业务角色一条授权都没有**；反之若全都授，门店员工会同时看到
「我的门店工单」和「全量工单」两个菜单，进去却都是自己门店的数据。

现在由 `scripts/seed-admin-pages.mjs` 按 `ROLE_MENU_MATRIX`（单一事实来源，
在 `scripts/expected-sensitive-columns.mjs`）**精确纠偏**（多退少补）：

| 角色 | 我的门店工单 | 全量工单 | 事件时间线 | 派工记录 |
|---|---|---|---|---|
| 门店售后 `store_after_sales` | ✅ | **不显示** | ✅ | ✅ |
| 总部售后 `hq_after_sales` | **不显示** | ✅ | ✅ | ✅ |
| 总部管理员 `hq_admin` | **不显示** | ✅ | ✅ | ✅ |
| 只读管理层 `viewer` | **不显示** | ✅ | ✅ | ✅ |

三个必须一起读的口径：
1. **菜单可见性不是安全边界** —— 安全边界永远是服务端 ACL + 数据范围。
   就算某个角色手动拼 URL 打开「全量工单」，也只会拿到它被授权的数据。
2. 这张表只管**业务角色**；内置的 `admin` / `member` / `root` 由 NocoBase 自己维护，
   脚本**不去动**，免得把后台搞成打不开。
3. 断言必须能变红 —— smoke 有两条：逐格核对矩阵，以及
   "任一角色都只有 1 个工单列表入口"。两条都做过反向验证。

### 13.4.2 H6 接口契约收口（2026-09-21 复核方裁定的两个**阻塞缺陷**）

复核方在 `0db9fcc` 上判定：H3/H6 的代码方向没问题，但**接口契约层有两个确定性缺陷**，
若直接进 I 真人走查，真人只会在浏览器里撞到一个本该静态审查就发现的 422。因此**先收口再走查**。

#### 缺陷 1 —— `service_mode` 前后端枚举不一致（客户端曾经发的是服务端不认识的值）

| | 客户端（收口前） | 服务端唯一合法值 |
|---|---|---|
| 自营 | `self` ❌ 服务端无此值 | `inhouse` ✅ |
| 厂家 | 被**并进** `third_party`（于是永远产生不了厂家数据） | `manufacturer` ✅ |
| 第三方 | `third_party` ✅ | `third_party` ✅ |
| 远程 | —— | `remote`（**不得进派工**，Phase 6 的 M11 才建 Visit） |

后果是**三重**：选"自营"必然 `422 INVALID_ENUM`；
"厂家"与"第三方"在数据上无法区分，后续按 `service_mode` 统计厂家占比**直接失真**；
而 `manufacturer` / `third_party` 服务端要求 `provider_name` **必填**，客户端却把它定成非必填。

**收口方式：单一事实来源。** 新建 `src/shared/service-mode.ts`（零依赖，前后端同一份），
`server/constants.ts` 改为 re-export，客户端的选项列表由 `dispatchServiceModeOptions()`
从 `DISPATCHABLE_SERVICE_MODES` 派生 —— 枚举、派工可选集、条件必填规则**只有一处定义**，
结构上排除再次漂移。UI 现在是：

| 选项 | 值 | `provider_name` |
|---|---|---|
| 门店自修 | `inhouse` | 不必填（且出口剔除空串，不下发空值） |
| 厂家 | `manufacturer` | **必填** |
| 第三方 | `third_party` | **必填** |

`remote` **不出现在派工 UI**；服务端仍保留 `REMOTE_MODE_DEFERRED` 兜底
（"UI 不显示" ≠ "接口开放"，断言同时验两侧）。

#### 缺陷 2 —— H6 没有显式发送 `X-Request-Id`

服务端四个写动作都要求合法 UUID v4 的 `X-Request-Id`，缺了直接 422；
但客户端统一请求器当时只传 `url / method / data`，**没有 header**。
复核方明确要求：**不赌框架的隐式注入**（仓库里没有任何证据支持"NocoBase 会自动注入"）。

收口：客户端用 `crypto.randomUUID()` 显式生成并发送，
且**一次用户逻辑操作的网络重试复用同一个号** —— 每次重试换号等于主动拆掉幂等防线。
这一条离线断言为：网络层失败重试 2 次后，服务端收到的仍是同一个 ID。

#### 幂等语义裁定：**采用方案 A（真实 request-id 幂等）**

服务端注释一直声称 `X-Request-Id` 是 `idempotencyRecords` 的幂等键，
但内部写动作**只校验它存不存在**，并没有用它做幂等记录 —— 注释与实现不符。
复核方给了两个选择：把内部写动作也做成真幂等（A），或改注释承认只用于 tracing（B）。

**选 A**，理由是 `reschedule` 的风险不对称：改约会**换发 Token + 写事件 + 发短信**，
弱网重试两次就会给客户发出两条不一致的短信和两枚 Token。
前三个动作有状态机兜底（重复 accept 状态已变 / 重复 dispatch 已有 active Visit /
重复 reassign 责任人已是新的），**但兜底不等于幂等**，而且 `reschedule` 没有。

实现要点（`TicketService` 的六个写动作统一走同一个执行器）：

1. **幂等键 = `scene + action + ticket_id + request_id + actor_user_id`** ——
   含**操作者维度**：换一个人拿同一个 request id 不算重放（断言已证明甲 200 / 乙 409）。
2. **幂等前置查询必须发生在业务写之前**；占位行则在业务写**完成之后**、
   **与业务写同一个事务**、事务提交前落库。两者是**互补的两条路径**：
   串行重放靠前置查表拦住（占位行在业务之后，所以"业务先拒绝"的路径走不到占位行 ——
   受理重放会在状态机第一行就抛 409，唯一索引永远撞不上，这正是首次实现踩的坑）；
   并发重放靠占位行的唯一约束兜底（先到者未提交时前置查表不可见，继续走业务，撞 23505 后回滚并回放）。
   > ⚠️ **不要把这条简化成"占位行写在业务写之前"**。那样改会把占位行提到业务之前，
   > 于是**业务失败也会留下占位行**，后续重放会拿到一个"什么都没做却标记为成功"的空响应。
   > 本句曾在提交 `5e629cd` 的文档里写反（复核方 2026-09-21 指出），已更正。
3. **回放只标响应头 `X-Idempotent-Replay: 1`，正文与首次完全一致**
   （前端不需要为"重放"写分支，拿到的就是第一次的结果）。
4. `sms` 仍在事务提交后发送，重放命中时**不进入发送路径**，短信数不变。

#### 守护断言（`smoke-test.mjs` §4f，10 条 + 离线数条）

| 断言 | 若缺失会怎样 |
|---|---|
| **已部署产物**的派工选项集合恰为 `inhouse/manufacturer/third_party`（`remote` 不得出现） | 源码改了但没重新构建 → 静态断言假绿，UI 依旧发 `self` |
| 已部署产物里 `X-Request-Id` 的**常量与装配两处**都在 | 同上：产物陈旧 |
| 用**与 UI 完全相同的 payload + header** 真打一次 `manufacturer` 派工 | 只测 `curl` 造的 payload = 没测 UI 真正会发的那份 |
| 自修时**不下发**空 `provider_name`；绕开 UI 缺 provider 时服务端仍 422 `MISSING_PROVIDER` | 前端拦了服务端就松 → 一旦换了调用方立刻脏数据 |
| 四个写动作 × 缺头/非法 UUID/非 v4 = **全部 422** | 幂等键可被跳过 |
| 同 request id 重放 `reschedule`：Visit / 事件 / 短信 / Token **均不再变化** | 弱网重试 = 客户收到两条短信 + 两枚 Token |
| 换操作者用同一 request id **不算**重放 | 幂等键缺维度 → A 的操作结果被 B 拿到 |

> 复核方特别要求第 6 条：**真人走查不会模拟"请求其实成功了但浏览器没收到响应、用户再点一次"**
> 这种网络故障，只有自动化适合抓它。

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
