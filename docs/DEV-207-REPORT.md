# DEV-207 短码索引化修复与验收报告

> 状态：**待专项验收**（未自行判定 PASS）
> 日期：2026-11-06
> 范围：DEV-207（客户进度短码索引化）+ 本轮连带发现并修复的 DEV-208 / DEV-209
> 纪律遵守：**未部署生产、未发真实短信、未改生产库、未提交、未推送**

---

## 0. 一览

| 项 | 结果 |
|---|---|
| 用户 10 条建议 | **10/10 落地**（第 6、7 条经实测后调整了实现形态，见 §3.6、§3.7） |
| 用户 8 项验收 | **8/8 覆盖**（§4） |
| 本轮新增验证套件 | 4 套，合计 **95/95 通过** |
| 本轮修出的产品缺陷 | **2 个**（DEV-208 并发重复派工、DEV-209 取号自死锁），均不在用户清单内、**由验收本身撞出** |
| R1 报告勘误 | **已更正**（§6） |
| 迁移总数 | 20 → **22**（`202611063` 索引回填、`202611064` 一单一派工守卫） |
| 库内凭证明文 | **0**（库 4 处扫描 + 日志 2 类扫描，§5.4） |
| 构建门禁 | `ts-baseline` **219 → 219**（101 键，无新增） |

---

## 1. 为什么要做这件事

R1 交付的 A4 派生码机制有一个**容量硬顶**：

```
解析未知 22 位码 ⇒ 不知道它是谁 ⇒ 遍历所有带 salt 的工单逐个 HMAC 比对
                  ⇒ DERIVE_SCAN_CAP = 5000，超过就拒绝判定（fail-closed）
```

这不是"慢一点"的问题，而是**到了上限就整片解析失败**（表现与"码错"完全一致：401）。
对一个要长期运营的售后系统，"工单数超过 5000 之后客户进度链接集体失效"是不可接受的。

用户 2026-11-06 裁决：优先评估并实现最小修复（即本报告）。

---

## 2. 修复形态（一句话）

**新增 `progress_code_hash = sha256(派生码)` 列 + 唯一索引**，解析从"逐行重算"变成
`code → sha256 → 索引等值命中 → 单行`，复杂度与表规模**无关**。

```
修复前：find(salt IS NOT NULL) → 逐行 HMAC → 定长比对 → 命中/超过 CAP 则 null
修复后：sha256(code) → WHERE progress_code_hash = ? （唯一索引）→ 单行
```

---

## 3. 用户 10 条建议的逐条落地

### 3.1 ✅ 保留现有 HMAC 派生机制

`deriveCode()` 一字未改：域前缀 `progress-code|`、`id|salt|epoch`、前 16 字节、base64url 22 位。
**派生**（生成码）与**索引**（查找码）是两件事，本轮只新增后者。

### 3.2 ✅ 新增 `progress_code_hash` 字段 + 唯一索引

- 字段：`str('progress_code_hash', …, { length: 64, allowNull: true, unique: true })`
- `allowNull: true` **是迁移必需的**：历史行先为 NULL，由回填迁移分批补齐。
  不能设 NOT NULL —— 一张工单可能**合法地从不使用**派生码（例如从未派工）。
- 唯一索引由**字段级 `unique: true`** 生成（PG `UNIQUE CONSTRAINT`），
  集合 `indexes[]` 里**不得**再声明一次（否则就是 DEV-206 的翻版）。

### 3.3 ✅ 库内只存 `sha256(code)`，不存短码明文

实测：`progress_code_hash` 共 22 个非空值，**22/22 匹配 `^[0-9a-f]{64}$`**（§5.4）。

### 3.4 ✅ 查找走哈希索引，不再逐行 HMAC

`resolveTicketId()` 现在并发做两次等值查找：

```ts
const hash = sha256Hex(text);
const [byToken, byDerived] = await Promise.all([
  repo.findOne({ filter: { progress_token_hash: hash } }),
  repo.findOne({ filter: { progress_code_hash: hash } }),
]);
```

单元测试 **D1–D8** 证明：原始 Token 路径、派生码路径、无效码路径 —— **三条路径都没有 `find()` 调用**，
且 `progress_code_salt` 不再作为任何查询的 filter 出现。

### 3.5 ✅ 既有派生码无损迁移

迁移 `202611063-progress-code-hash.ts` 用**现存** `(id, salt, epoch)` 重算，
**绝不重新生成 salt**（重新生成 = 已发出去的链接立刻失效）。

`dev207-migration.test.mjs` **9/9** 证明：

| 用例 | 断言 |
|---|---|
| M2 | **对照组**：回填前用 hash 查 = 命中 0（证明后面的命中不是本来就有的） |
| M4 | 无损：回填后**用迁移前算出的码**能查回**它原来那张工单** |
| M5 | 幂等：第二次执行后 hash **逐字节不变** |
| M6 | `pg_indexes` 里该列**恰好 1 条**索引 |
| M7 | 该索引是 **UNIQUE** |
| M8 | 写入重复 hash **真的被拒**（不是"建了索引但没生效"） |
| M9 | 收尾把 5 张工单的 3 列还原为 NULL |

### 3.6 ✅ 保留旧 22 位与 43 位链接

`PROGRESS_TOKEN.PATTERN_ANY` 未改；原始 Token 走 `progress_token_hash` 那一支，
**完全不受本轮影响**（`E22`/`E29` 实测：派生后、撤销后原始链接都是 200）。

### 3.7 ✅ 派生码与师傅权限严格隔离

- 派生码**不进** `service_visits.short_code_hash` ⇒ 师傅接口结构上认不出它；
- 实测 `E24` 派生码打进 `technicianVisit:get` ⇒ **401**；`E25` 打进 `overview` ⇒ **404**。

### 3.8 ✅ 撤销后旧码失效，且**不得因 epoch 重置而复活**

`revokeDerivedCodes()` 现在**同时**写两列：

```ts
values.progress_code_epoch = nextEpoch;
values.progress_code_hash  = deriveCodeHash(nextCode);   // H1，不是留着 H0
```

关键论证（单元测试 **B7/B8** + E2E **E30**）：

- 撤销写 H1 ⇒ 索引里**不再有** H0；
- 把 `epoch` 硬改回 0（模拟运维误操作/恢复脚本）⇒ 当前码又变回 C0，
  但库里 hash 还是 H1 ⇒ **查不到** ⇒ **不复活**；
- `B8` 是反事实：**若只 bump epoch 不改 hash** ⇒ 复活**确实会发生**。

> ⚠️ 这条是本轮**语义变化最大**的一处，见 §7 的"验收时被撞出的判据错误"。

### 3.9 ✅ 所有写复用外层事务

`ensureDerivedCode()` 的 salt 抢写与 hash 补写都传 `transaction`。
`C7` 断言 `pg_stat_activity` 的 `idle in transaction` = **0**（自死锁的指纹）。
`T4`/`T5` 断言**失败的派工不留 hash/盐**（写随事务回滚）。

### 3.10 ✅ `SIGN_SECRET` 轮换的链接连续性方案

见 §8。

---

## 4. 用户 8 项验收的覆盖情况

| # | 用户要求 | 覆盖方式 | 结果 |
|---|---|---|---|
| 1 | 现有客户进度码正常访问 | `r1-e2e` `E5`（原始 Token 200）、`E22`（派生后仍 200） | ✅ |
| 2 | 派工和改派正常产生通知 | `E8`+`E9`（派工 200、`progress_update` 入队）、`E10`（改派 200）、outbox `seq 29/30` | ✅ |
| 3 | 旧链接不因迁移失效 | `dev207-migration` `M4`（迁移前算出的码仍能查回原单）+ `E5`/`E22` | ✅ |
| 4 | **1 万 / 5 万条规模**的合法短码查询 | `dev207-scale`：10,000 行 **0.045 ms**；50,000 行 **0.058 ms**；终测 **0.068 ms** | ✅ |
| 5 | **无全表 HMAC 扫描** | 单元 `D1–D8`（三条路径无 `find()`）+ 规模 `EXPLAIN`（`Index Scan`、**无 `Seq Scan`**、返回 **1** 行） | ✅ |
| 6 | 并发派工与事务安全 | `dev207-concurrency` **25/25**；8 路并发 8/8 成功（368 ms）；同行并发 1 成功 1 拒绝（409） | ✅ |
| 7 | 撤销、过期、无效凭据和跨工单访问 | `E23`（随机 22 位 ⇒ 401）、`E27`–`E30`（撤销/不复活）、`E24`/`E25`（跨接口）、`T3`（状态冲突 409） | ✅ |
| 8 | 数据库与日志无凭证明文 | §5.4 六处扫描全 0 | ✅ |

### 4.1 规模层的关键对照

| 规模 | 索引查询 | 计划 | 返回行 | 旧实现 |
|---|---|---|---|---|
| 10,000 | **0.045 ms** | `Index Scan` | 1 | 取满 **5001** 行 / 6.4 ms ⇒ **超 CAP** |
| 50,000 | **0.058 ms** | `Index Scan` | 1 | 取满 **5001** 行 / 30.4 ms ⇒ **超 CAP** |
| 50,000（终测） | **0.068 ms** | 无 `Seq Scan` | 1 | 需 **50,000** 行 × 50,000 次 HMAC |

> **结论不是"索引更快"，而是"旧实现在该规模下已经不可用"。**
> 5001 > `DERIVE_SCAN_CAP=5000` ⇒ 旧实现会**整体拒绝判定**，
> 而索引实现在 5 万行下仍是 **0.068 ms 且与规模无关**。

---

## 5. 验证套件明细

### 5.1 四个套件

| 套件 | 断言数 | 证明什么 |
|---|---|---|
| `dev207-unit.test.mjs` | **34/34** | 哈希形状/单射、撤销语义（含反事实 B8）、fail-closed（C 组）、**无 find 调用**（D 组）、常量契约、变异测试（F 组） |
| `dev207-migration.test.mjs` | **9/9** | 无损、幂等、索引唯一且**真的会拒**、对照组 |
| `dev207-scale.test.mjs` | **19/19** | 1 万/5 万规模、执行计划、旧路径超 CAP 对照、清理回基线 |
| `dev207-concurrency.test.mjs` | **25/25** | 并发派工、同行互斥、**库级不变式**、事务边界、连接池无残骸 |
| `r1-e2e.mjs`（回归） | **32/32** | 全链路：建单→派工→改派→派生码→撤销→不复活 |

**合计 119/119。**

### 5.2 我自己的两个假绿（必须留档）

**(a) 变异测试 F2 曾是真空断言。**
第一版用 `hashOf('codeA')` 与 `hashOf('codeAxxxx')` 比"前缀匹配"，
两个随机哈希**根本不会共享前缀** ⇒ 断言恒假 ⇒ **什么也没测**。
改成构造**真的共享 8 字符前缀**的两个哈希后再比 ⇒ 重跑 34/34。

**(b) 并发 D 组的第一版判据写得太宽。**
第一版断言是"**至少一个成功** ⇒ 通过"。而两个并发派工**都返回 200** 恰好满足它 ——
于是**产品缺陷（两条 ASSIGNED）在我自己写的测试里住了下来**，还以绿色呈现。
改成断言**库级不变式**（同单 `ASSIGNED` 条数 = 1）之后立刻翻红，才挖出 DEV-208。
⇒ 教训：**判据要落在不变式上，不要落在"看起来正常"上。**

### 5.3 数据库回基线

| 项 | 前 | 后 |
|---|---|---|
| 规模测试插入行 | 0 | 50,000 |
| 清理后 | 50,000 | **0** |
| 工单总数（对照） | 489 | **489** |
| 迁移测试的 5 张工单三列 | 已改 | **还原为 NULL** |

### 5.4 凭证明文审计（用户第 8 条）

| 探测位置 | 判据 | 结果 |
|---|---|---|
| `service_tickets.progress_code_hash` | `^[0-9a-f]{64}$` | **22/22** ✅ |
| `service_tickets.progress_token_hash` | 同上 | **311/311** ✅ |
| `sms_logs.error_message` 含 22 位 base64url | `~ '[A-Za-z0-9_-]{22}'` | **0** ✅ |
| `ticket_events.metadata_json` 含 `/p/{22位}` | 精确链接形状 | **0** ✅ |
| `service_tickets.extra_json` 含 `/p/{22位}` | 精确链接形状 | **0** ✅ |
| 容器日志含 `/p/{22位}` | 精确链接形状 | **0** ✅ |
| 容器日志打印 `progress_code_hash` 的**值** | 只出现列名（12 次种子白名单 + 1 次回填统计） | **0 个值** ✅ |

> 判据说明：用**精确链接形状**而不是"任意 22 位串"，
> 是为了避免撞上合法枚举（例如 `customer_absent` 这类），这是项目里已有的教训。

---

## 6. R1 报告勘误（用户明确要求）

**原表述**：「真实 E2E 抓到的两条**入库正文**（`FW20261106-0011`，`sms_logs` + `request.preview` 同源）」

**两处不成立**：

1. **`sms_logs` 没有正文列，也没有参数列**（只有 `error_message`）。
   这是**设计如此** —— 正文必含凭据链接，落库即等于存凭据明文。
2. **`E15`/`E16` 不是"抓"的，是在测试里重建的**：
   测试自己用 `crypto.createHmac` 再算一遍 `derivedCode`，调 `renderSmsPreview()` 渲染，
   再和一个手写期望串比。**自己算、自己渲染、自己比** ⇒
   只能证明"渲染器对给定参数输出该字符串"，**不能**证明"发送路径真的传了这两个参数"。
   （那段代码自己的注释当时就写着"`sms_logs` 不存正文/参数"—— 我知道，但摘要里还是写错了。）

**正文断言真正的捕获位置**：`MockSmsProvider.outbox`。
它保存产品**真实交给通道**的 `request`（含 `preview` 与 `params` 原文），
经 `GET /api/svc:smsOutbox` 原样读出。本轮已实测（对应 R1 报告 §1.3–§1.5）：

```
--- seq 29  scene progress_update
  params:  {"ticket_no":"FW20261106-0045","code":"6o02CEnAQJx0K8nJAUUjcA"}
  preview: 【模拟通道】您的售后工单FW20261106-0045有新的处理进展，请点击查看：https://sh.scqfls.cn/p/6o02CEnAQJx0K8nJAUUjcA
```

⚠️ **但 outbox 不能替代逐字比对**：mock 通道会在正文前加 `【模拟通道】` 并按 mock 口径决定签名段。
⇒ 证据结构更正为**互补**：

| 要证明的事 | 由谁证明 | 等级 |
|---|---|---|
| 发送路径真的传了 `ticket_no` 与 22 位 `code` | outbox 的 `params` 原始值 | **强（产品真实产出）** |
| 正文里 code 与 params 一致、无拼接错位 | outbox `preview` 子串比对 | **强** |
| 给定参数时正文**逐字**等于审核版 | `E15`/`E16` + `be03-sms-template02.test.mjs` 55/55 | **中（渲染器契约）** |
| 短信真的入队并受理 | `sms_logs` 的 `scene/send_status/error_code` | **强** |

---

## 7. 验收过程中被撞出的两个产品缺陷（**不在用户清单内**）

### 7.1 DEV-208：并发派工会产出**两条 ASSIGNED**

- **现象**：同一张单并发两个 `svc:dispatch`，**两个都 200**，库里 `visit_no=1` 与 `visit_no=2` 同时 ASSIGNED。
- **根因**：`dispatch()` 是**读-判-写**，READ COMMITTED 下两个事务互相读不到 ⇒ 都通过守卫。
- **讽刺之处**：`findActiveByTicket()` 发现多于一条时打印的是
  「**说明有代码绕过 VisitService 直接写库**」—— 一条**已被写下的错误归因**，而它就是那段代码。
- **修法**：数据库**触发器** `trg_service_visits_one_assigned`（`BEFORE INSERT OR UPDATE`），
  冲突时 `RAISE ... ERRCODE=23505`；应用侧翻译成与守卫**同一个** `409 VISIT_ALREADY_ASSIGNED`。
- **走过的弯路（重要）**：第一版用**部分唯一索引**，迁移里建好、自检也过，但**容器一重启就消失**。
  根因是 NocoBase `sync-runner.js → handleUniqueIndex()` 会遍历**所有单字段唯一索引**，
  未声明 `unique: true` 就删。而 `indexes: []` 不支持 `WHERE`、普通唯一索引又会**禁止改派**
  ⇒ **单字段唯一索引这条路在 NocoBase 下走不通**。`pg_trigger` 不在它视野里，跨重启存活（已实测）。
- **反向验证**：绕过应用层直插第二条 ASSIGNED ⇒ `ERROR: ticket 66953 already has ASSIGNED visit 2673`；
  改派（旧→SUPERSEDED、新→ASSIGNED）⇒ **200，未误伤**。

### 7.2 DEV-209：`SequenceService` 取号**在事务里另借连接**

- **现象**：加完 DEV-208 立刻重跑并发，**8 路中 6 路 500**，每次 **约 60s**，`ConnectionAcquireTimeoutError`。
- **根因**：`nextVisitNoValue()` 的**注释**写着「必须在调用方同一个事务里调用」，
  但**方法签名没有 `transaction` 参数** ⇒ 每次另借连接做 `INSERT ... ON CONFLICT`
  ⇒ 与派工事务的行锁互等 ⇒ 池子被逐个占死。
- **修法**：`nextValue / nextTicketNo / nextVisitNoValue / nextVisitNo / bump / query` 全线加 `transaction` 并透传。
  **事务内**撞唯一约束时不再原地重试（PG 已把事务标 aborted，重试只会 25P02），直接抛给外层回滚。
- **明确不改**：`TicketService.create` 的 `nextTicketNo()` 不传 —— 那里取号在 `withTransaction` **之前**，
  是预取语义。**两处长得一样、语义相反，已各写注释**。
- **实测对比**：最慢单请求 **60076 ms → 367 ms**，成功数 **1/8 → 8/8**。

### 7.3 为什么这两个不在用户清单里却必须现在修

用户第 6 条要求是「**并发派工与事务安全**」。
如果不修，这条验收的结论只能是**不通过** —— 而失败原因是两个与索引化无关的既有缺陷。
按分诊规则，它们是 **A 类**（影响数据一致性 / 可用性），属于**本阶段必修**，不是"顺手改"。

---

## 8. `SIGN_SECRET` 轮换的链接连续性方案（用户第 10 条）

### 8.1 轮换会发生什么（事实，已由代码结构决定）

| 凭据种类 | 依赖 `SIGN_SECRET`？ | 轮换后 |
|---|---|---|
| **原始进度 Token**（22 位 / 43 位，客户收藏的链接） | **否**（库里存 `sha256(token)`，与密钥无关） | **继续有效** ✅ |
| **派生短码**（派工/改派短信里的链接） | **是**（HMAC 的密钥） | **全部失效**（重算得到不同码） |
| 师傅作业 Token | 否 | 继续有效 |

⇒ **轮换不会打断客户收藏的原始链接**，只影响"通知短信里当次发出的派生链接"。

⚠️ 同理：`202611063` 回填迁移在 `SIGN_SECRET` 与生产不一致时，
回填出来的 hash 对应**新码**，而客户手里是**旧码** ⇒ 旧码查不到。
**这是预期的**（轮换本就作废派生码），不是迁移缺陷；但必须在 runbook 里写明，
否则会被当成"迁移把链接搞坏了"。

### 8.2 运维 runbook（轮换 `SIGN_SECRET`）

```
① 轮换前
   · 记录当前值（备份到密钥库，不入 Git、不入 .env.example）
   · 统计派生码覆盖率：
       SELECT count(*) FROM service_tickets WHERE progress_code_salt IS NOT NULL;  -- 将有链接受影响
   · 通知门店：轮换后**此前短信里的进度链接会失效**，客户重新走"进度查询"应使用原始链接

② 执行轮换
   · 更新 SIGN_SECRET（容器环境变量）
   · **不要**同时改 SIGN_SECRET 与 SERVICE_TICKET_* 其他密钥（一次只动一个，否则分不清影响面）

③ 轮换后（必须做，否则派生码永久不可用）
   · 重启实例
   · 对每张有 salt 的工单**重新派生**一次（把 hash 换成新码的 hash）：
       方式 A（推荐，无代码）：走一次派工/改派 —— `ensureDerivedCode()` 会**自愈**补写 hash
       方式 B（批量）：重跑迁移 `202611063`（把 `progress_code_hash` 置 NULL 后再执行）
   · 验证：
       SELECT count(*) FROM service_tickets WHERE progress_code_salt IS NOT NULL
         AND progress_code_hash IS NULL;   -- 应为 0

④ 不可逆提醒
   · "撤销"写入的是**新一代 hash**，撤销是**不可逆的写**（§3.8）。
     轮换后再撤销，客户手里的旧派生链接**永久作废**，不会因任何"恢复 epoch"而复活。
```

### 8.3 为什么**没有**做"密钥版本化"（多密钥并存）

多密钥并存能让轮换**零中断**，但代价是：
- 每个凭据要记"用了哪一版密钥" ⇒ 库结构变更 + 全部解析路径加分支；
- 密钥的"删除时机"变成新的运维复杂度（什么时候可以安全删旧密钥？）。

用户的裁决是"**先做最小修复**"。多密钥版本化属于**独立演进**，已记入后续候选，
本轮**不实施**。当前形态的代价明确：**轮换会让派生链接失效一次**，且这一点被写进 runbook。

---

## 9. 代码变更清单

| 文件 | 变更 |
|---|---|
| `src/server/constants.ts` | `PROGRESS_DERIVE` 增加 `HASH_ALGO/HASH_LENGTH/BACKFILL_BATCH/MAX_EPOCH`；新增 `PROGRESS_DERIVE_LOOKUP = 'indexed'` |
| `src/server/collections/serviceTickets.ts` | 新增 `progress_code_hash`（64 位、nullable、`unique`）；`indexes[]` 注释改写并**明令不得重复声明该唯一索引** |
| `src/server/services/progress-service.ts` | 新增 `deriveCodeHash()`；`ensureDerivedCode()` 写 hash 并自愈；`revokeDerivedCodes()` **同时**写 epoch 与 hash；`resolveTicketId()` 改两次等值查找；**删除** `matchDerivedCode()`（保留墓碑注释说明为何不留降级路径） |
| `src/server/migrations/202611063-progress-code-hash.ts` | **新增**：加列 + 唯一索引 + 分批回填（500/批、可续跑、坏行不中断） |
| `src/server/migrations/202611064-visit-one-assigned.ts` | **新增**（DEV-208）：`BEFORE INSERT OR UPDATE` 触发器 |
| `src/server/services/ticket-service.ts` | `dispatch()` 捕获 `23505` → `409 VISIT_ALREADY_ASSIGNED`；`nextTicketNo()` 加"为何不传 transaction"的注释 |
| `src/server/services/visit-service.ts` | `create()` 把 `transaction` 透传给 `nextVisitNoValue()`（DEV-209） |
| `src/server/services/sequence-service.ts` | 全链加 `transaction` 参数并透传；事务内撞唯一约束不原地重试（DEV-209） |
| `docs/DEVIATIONS.md` | 新增 DEV-206 / DEV-207 / DEV-208 / DEV-209 |
| `docs/BE-03-SMS-TEMPLATE-02-R1-REPORT.md` | 勘误：正文证据来源（§6） |

---

## 10. 仍未解决 / 不在本轮范围

| 项 | 状态 | 说明 |
|---|---|---|
| 微信真机验收 | **NOT DONE** | 不得用 Chromium 代替；独立发布门 |
| 短信宝师傅模板审核 | **外部阻塞** | `technician_task` 仍在 `SMS_REVIEW_PENDING_SCENES` |
| `BUILD-TS-GATE-01`（= DEV-205） | 未闭环 | `ts-baseline` 已上，但错误码覆盖仍是 219 条基线 |
| `P6-API-DTO-SENSITIVE-01` | 未闭环 | DTO 下发 `*_token_hash`（哈希非明文，风险低） |
| 后台静态 JS 无内容指纹 | 未闭环 | 部署后必须强刷 |
| `r1-e2e.mjs` 的 `E15/E16` 改为从 outbox 读 | **未做** | 硬改会把"改测试"与"改产品"混在同一次验收（§6） |
| 多密钥版本化（轮换零中断） | **未做** | 属独立演进（§8.3） |
| 历史 `ASSIGNED` 重复行 | 本轮已清 1 张（66933） | 生产库需同样探测后处置；迁移会**每次都报**出来 |

---

## 11. 申请事项

**申请 DEV-207 专项验收。**

- 请裁决本轮三项：**DEV-207**（索引化）本身，以及连带修复的 **DEV-208 / DEV-209**。
- **未自动上线**。Release HOLD 保持不变。
- 两个独立发布门（微信真机、短信宝模板审核）**未变**。

**验收时建议重点质疑的三处**（我自己认为最可能被挑的地方）：

1. **`E27–E30` 的撤销验证是在宿主机上跑产品源码**，不是跑容器里的 bundle。
   严格说它证明的是"这份源码的撤销语义"，而不是"线上那个进程的撤销语义"。
   （容器里 `ProgressService` 未被单独导出，这一点已在脚本注释里写明。）
2. **`dev207-scale` 的 5 万行是临时插到真表里的**（前缀 `SCALE207-`，测完删除）。
   它证明的是"该表在这个行数下的执行计划"，不是"生产峰值负载"。
3. **mock 通道的 outbox 会加 `【模拟通道】` 前缀**，所以正文逐字比对**不能**用它（§6）。
   如果你认为"这等于没证明正文"，请直接判 HOLD —— 我不会用渲染器契约冒充发送路径证据。
