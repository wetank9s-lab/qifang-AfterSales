# BACKLOG（不阻塞当前阶段的问题）

> **口径**（用户 2026-09-25 定）：实现过程中冒出的新问题按三类处理
>
> | 类别 | 处理 |
> |---|---|
> | **A. 影响匿名技师闭环 / 安全边界 / 数据一致性** | **本阶段必须修**（不得带病进入下一阶段） |
> | **B. 只是后台 UX / 运维体验** | 记到本文件，**不阻塞**当前阶段 |
> | **C. 属于门店确认 / 评价 / 关闭链路** | **留给后续 Phase**，本阶段不得提前实现 |
>
> 本文件只收 **B 类**。A 类当场修掉（修完在 `docs/DEVIATIONS.md` 留复盘）；C 类在 `docs/DEV-PLAN.md` 的阶段划分里。

---

## B 类（运维 / 体验，不阻塞）

### B-1 `agent-browser` CLI 在本机不跨命令保持会话
- **现象**：`agent-browser open <url>` 能启动 Chromium，但下一条命令只看到 `about:blank`
  （守护进程不保持 session）⇒ 无法完成"上传 → 填表 → 提交"这类**连续动作**。
- **当前绕过**：走查改用 `agent-browser` 自己装好的 Chrome + **CDP**
  （`scripts/walkthrough-p5-1-browser.mjs`，Node 22 内置 WebSocket，零依赖），一个进程跑完整个流程。
- **为什么是 B 而非 A**：它是**验收工具**的问题，不是产品问题；产品闭环已用 CDP 真实浏览器验证通过。
- **待办**：确认是否是 upstream 的已知问题（版本 0.27.0 / Windows）；若是，值得提 issue。
  若将来 CLI 修好了，`walkthrough-p5-1-browser.mjs` 可以简化，但**不必**回退（CDP 版更可控）。

### B-2 走查工单留在库里，需要手工复位
- **现象**：`walkthrough-p5-1.mjs setup` 会建一张真单并把 Visit/照片/Ticket 留在库中（**故意的**，
  证据要能被复核）。复位要走 `node scripts/uat-reset-baseline.mjs`，而它会把走查单**一并删掉**。
- **影响**：只是"证据留存 vs 干净基线"的取舍，不影响任何断言。
- **待办**：若希望两者兼得，可给 reset 加一个 `--keep-tag P5-1走查` 之类的开关（**不急**）。

### B-3 "重建产物后必须重启 app"仍靠人记得
- **现象**：`verify-bundle-delivery` 能**检出**"产物比服务进程新"（DEV-74 的第 4 条断言），
  并打印 `docker restart svc-app` —— 但**重启本身**仍是手工步骤。
- **影响**：一次性运维动作；门禁已经会咬人，不会静默漂移。
- **待办**：可选：把重启做成 `scripts/` 里的一条命令（或在交付脚本里带 `--restart`）。

### B-4 `smoke-test.mjs` 里的口令形态 —— ✅ 已关闭（2026-09-25，用户判 A 类随 P5-1 整改清除）
- ~~现状记录在 `memory/MEMORY.md`：`scripts/smoke-test.mjs` 第 ~1087 行含 `SMOKE_ADMIN_PASSWORD` 的
  **明文默认值**，而仓库是 **public**。~~
- **处置结果**：`SMOKE_ADMIN_PASSWORD` 未设置时 smoke **明确失败并拒绝运行**（exit 1，不发登录请求）；
  **完成仓库级同类扫描并清除剩余 smoke fallback**（扫描口径与结果见
  `docs/PHASE-5-P5-1-EVIDENCE.md` ⑥b ② —— 0 处真实秘密 fallback，夹具 dummy 值已区分标注）。
- 仓库**历史提交**中的旧口令字面量（`d9c617e` 引入）无法追改，该口令已轮换失效。

### B-5 一次性凭证走查的证据目录应改用 `run_id`（禁止覆盖已有 run）
- **来源**：Phase 5 关闭评审（用户 2026-09-25 提出），登记为**测试基础设施改进项**，**不重开 Phase 5**。
- **现象**：本机 Bash 工具在 escalation 场景下会把同一条命令**执行两遍**（输出含
  `⚠️ Sandbox bypassed (escalation-approved)`）。一次性 Token 走查脚本（`scripts/walkthrough-p5-1.mjs`）
  第二次执行时 Token 已被首轮消费 → `401`，并把 `走查记录.txt` / `step0-*.json` 等证据文件
  **覆盖成近乎空**（同名复用）。
- **影响**：验收工具可靠性 —— 会让"证据被静默稀释"。**本次不影响 P5-2 PASS 判定**
  （已用 DB 终态 + 文件 mtime 交叉确认首轮证据有效）。
- **待办**：这类**一次性凭证**走查，证据目录改用 **`run_id`**（时间戳 / 随机后缀），
  **禁止覆盖已有 run**；脚本检测到目标 run 目录已存在时应**报错退出**，而不是复用同名目录。

### B-6 跨阶段残留：`verify-concurrency-phase2.mjs` 仍打印 "Phase 2 仍为 HOLD"
- **现象**：Phase 2 早已**补签 PASS**（2026-09-20），但 `scripts/verify-concurrency-phase2.mjs`
  的输出文案仍写 **"Phase 2 仍为 HOLD"** —— 属**历史文案漂移**。
- **影响**：只是脚本提示语，**不影响断言结果**；但会让下一个人读到过期状态。
- **待办**：把该文案改为 PASS 口径（或去掉基于阶段状态的那句提示）。
  **属 Phase 5 关闭范围之外的历史文案**，故只登记、**不在本轮修改**（不扩大当前阶段范围）。

### B-7 师傅接口是否需要进总闸 / preflight 增闸门（原 V4~V6）
- **现象**：P5-1 的四组证据脚本（`verify-technician-token-matrix` / `-upload` / `-submit` / `verify-technician-h5`）
  目前**独立运行**，**未并入** `scripts/smoke-test.mjs` 总闸与 preflight。
- **影响**：不影响当前验收；但长期看，"总闸跑一遍"**不覆盖师傅接口**，后续阶段容易遗漏回归。
- **待办**：由**后续阶段**决定是否把师傅接口纳入总闸 / preflight。**不阻塞 Phase 5 关闭**
  （`docs/PHASE-5.md` §11 已标 ⬜ 转 backlog）。

### B-8 业务角色可**原生读取** NocoBase 核心集合（`users` 含 email/phone、`roles`、`stores`、`collections`）
- **发现于**：Phase 6 · P6-0（2026-09-25），排查 N1 时顺带实测到的**既有**问题（**非 P6-0 引入**）。
- **现象**：以门店账号（`store_after_sales`，仅授权 S01）登录后，直接请求原生 collection API：
  | 请求 | 实测 |
  |---|---|
  | `GET /api/users:list` | **200** —— 返回全部用户的 `email` / `phone` / `nickname` 等列 |
  | `GET /api/roles:list` | **200** —— 返回全部角色及其 `strategy` |
  | `GET /api/stores:list` | **200** —— 返回全部门店 |
  | `GET /api/collections:list` | **200** —— 返回全部集合定义 |
  | `GET /api/storages:list` | 403（对照，说明 ACL 确实在判定） |
  | 以上任意一条**匿名**请求 | 401（说明这是**角色级**放行，不是匿名口） |
- **根因**（已取证到源码级）：NocoBase ACL 的判定分两级，而"资源级没有条目"时**不是 deny**，
  而是**回退到角色 strategy**（`@nocobase/acl/lib/acl.js` 的 `getCanByRole()`；
  `strategyResources` 在本版本恒为 `null`，因为 `setStrategyResources()` 全仓无调用点）。
  而 `ACLAvailableStrategy.allow(resourceName, actionName)` **完全忽略 `resourceName`** ——
  它只做 `matchAction(actionName)`。于是本插件四个业务角色的 strategy
  `{"actions":["view","list","get"]}`（`seeds/roles.ts` 的 `strategyOf()` 只写 `actions`、**不带 `resources`**）
  在语义上等于「**任何**集合都可读」。
- **影响**：跨角色可枚举用户邮箱/手机号、角色策略、门店全量。属**安全边界**问题。
  但**范围**是 NocoBase 核心集合（不是本插件业务表），且自 Phase 2 起即如此 ——
  修它会改变所有阶段都在依赖的 ACL 语义。
- **为什么本轮只登记、不在 P6-0 修**：
  ① 用户 2026-09-25 明确划定 P6-0 范围 = **只读读模型 + 私有照片访问**，
  `docs/PHASE-6.md` §5 冻结矩阵的 N1 **只针对 `serviceVisitPhotos`**（已修，见 DEV-83）；
  ② 可行的修法（`acl.setStrategyResources(ROLE_NATIVE_READ_RESOURCES)`，或给每个策略补资源约束）
  会让**后台 UI 的既有读取**（工单列表的门店下拉、处理人展示等）一起 403 ——
  必须配一次**真人后台走查**并**重跑 Phase 2~5 全部门禁**，属于一个独立的 mini-phase。
- **待办（建议）**：单独立项，按"先加断言复现 → 再改策略 → 复跑门禁 + 后台走查"的顺序做。
  反向门建议直接扩 `scripts/verify-store-photo-access.mjs` 的 N1 组（把资源清单参数化）。
- **可逆**：✅ 可逆（只改策略/`strategyResources`，不动数据）。

---

### B-9 多脚本**串跑**时，嵌套的 `build-plugin.mjs` 会被沙箱「批量删除守卫」拦下 → 全量回归出现**级联假红**
- **发现于**：Phase 6 · P6-0 收口回归（2026-09-25）。
- **现象**：把 18 支门禁写进**同一条命令**串跑时，凡是**自己会重建产物**的脚本报
  `[build-plugin] 构建失败`：
  `Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":125,"threshold":50,"scope":"turn",...}`
  随后**级联**：源码被反向脚本改过又还原（mtime 变新），而重建失败 ⇒ 产物比源码旧
  ⇒ `verify-config` 的「插件源码与构建产物同步」**红**（55/56）
  ⇒ 依赖它作前置的 `verify-technician-routing-reverse` 直接 `rc=2 环境未就绪`。
- **根因**：`build-plugin.mjs` 构建前用 `fs.rmSync(dist, {recursive:true})` 清产物目录
  （`dist` 下 100+ 文件）。本机沙箱的 safe-delete 垫片按 **turn 维度累计删除量**设阈值 50，
  一个 turn 内跑第 2~3 次构建就必然越界。**单独**跑（沙箱 bypass）时不会触发 —— 所以
  「逐支单跑全绿、串跑就红」，看起来像产品坏了，其实是**工具链在沙箱下的行为**。
- **影响**：验收有效性（假红 + 级联），**不影响产品**。但它会让人误判"P6-0 有回归"。
- **处置（本轮）**：不在 `build-plugin.mjs` 里加 bypass（那等于绕过安全网）。
  改为**约定 + 记录**：全量回归里凡**会重建产物**的脚本
  （`verify-detail-gate-reverse` / `verify-technician-h5-mutation`）**必须各自单独一条命令**跑，
  且跑完**必须重建产物 + 重启 app** 再跑 `verify-bundle-delivery` / `uat-preflight`
  （否则 §3.8「产物比服务进程新」红）。
- **待办（建议）**：给 `build-plugin.mjs` 加"增量清理"（只删本次要覆盖的条目，或按白名单目录删），
  从根上避开批量删除阈值；或把"产物是否最新"的判断从 mtime 换成内容哈希（免受"改又还原"影响）。
- **可逆**：✅ 可逆（纯工具链）。

### B-10 `verify-technician-upload` 的 **B10** 偶发一次 `fetch failed`（未复现）
- **发现于**：Phase 6 · P6-0 全量回归（2026-09-25），**仅出现 1 次**。
- **现象**：B10（临时把小时上限降到 2，断言第 3 次上传 `429` + `Retry-After`，跑完恢复）
  报 `fetch failed`（undici 连接层失败），同一次运行里 **B1~B9 全绿**；
  同一次回归里 `verify-technician-routing-reverse` 刚跑过（会多次改 nginx 配置 + reload）。
- **复现尝试（均**未**复现）**：① 单独跑 `verify-technician-upload` → **20/20 绿**；
  ② 按原顺序 `routing-reverse → upload` 配对跑 → `upload` **20/20 绿**（B10 `Retry-After=142s`）。
- **定性**：**环境抖动**（不是产品缺陷，也不是稳定可复现的顺序问题）。
  最可能是 reload / 容器网络在那一瞬的连接层失败。
- **为什么仍要登记**：它的**症状长得像红灯**（`fetch failed` 会被当成"上传链路坏了"）。
  下次再遇到，先按"单独复跑 + 配对复跑"两步判真伪，**不要**直接当成 P6-0 回归。
- **待办（建议）**：给 B10 的 HTTP 调用加一次**带退避的重试**（仅在连接层失败时），
  并在失败信息里带上 `cause`（undici 的 `error.cause` 才含 `ECONNREFUSED` / `UND_ERR_*`）。
- **可逆**：✅ 可逆（纯脚本）。

### B-11 NocoBase **核心**把"登录会话过期"的 401 记成 **error** 级 → 任何会话失效反向验证都会污染 `smoke-test` 的日志闸
- **发现于**：Phase 6 · P6-0 收口回归（2026-09-25）：`verify-store-photo-access`（S1）跑在
  `smoke-test` 之前，`smoke-test` 就红在「app 日志中无 error 级别输出」。
- **现象**：S1 会 `auth:signOut` 之后**故意**拿死会话去读 `/api/svc/photos/:id`（I14）与
  `/api/svc/visits/:id`（I11）。**401 是 S1 断言期望的正确行为**，但它由核心
  `BasicAuth.checkToken` 抛 `UnauthorizedError`，被全局错误处理器按 **error** 级记 2 条
  （`module=svc`，`submodule=photo` / `visitDetail`）。另配 2 条 **warn** 级的框架 `response` 行
  （不含敏感信息；`smoke-test` 按 `level` 字段判定，故只吃到那 2 条 error）。
- **定性**：**测试工具污染环境**（与 B-4 / DEV-83 同类），**不是 P6-0 引入的噪声** ——
  "过期会话"是**正常客户端状态**（页面开着过夜就会遇到），且是**框架级**行为：
  任何需要登录的端点都一样。我们自己的 401（如师傅侧 `TOKEN_INVALID`）走**业务 Error**，不记 error 级。
- **处置（本轮）**：`scripts/smoke-test.mjs` 新增**第三条豁免**，口径**窄且成对**：
  只认 `message === 'Your session has expired. Please sign in again.'` 且 `module==='svc'`
  且 `submodule ∈ {photo, visitDetail}`；**必须两个端点各至少一条**才认领（S1 一次运行必然成对产生）；
  每种端点**封顶 2 条**。另配**分类器自检**（`S1 豁免分类器自检`：单端点不放行 / 成对认领 2 /
  超封顶只认 2 / 无关与异模块不放行）—— 防"豁免逻辑写错成恒不生效"，也钉住框架字段语义变化。
- **反向验证**：① 切断接线（`s1Claimed` 置空）后 `smoke-test` 恰因那 **2 条**日志变红；
  ② 把端点清单收窄成只认 `photo` ⇒ **自检立刻红**（"只有 photo 一条时不得认领：期望 0，实际 1"）。
- **待办（建议）**：这是**框架级**行为，不在本插件控制范围内。若将来要根治，
  方向是"让业务端点自建 401（返回业务错误码）而不是让核心 auth 抛异常"——
  但那会改变 `docs/SECURITY.md` 的口径，需单独立项。
- **可逆**：✅ 可逆（纯脚本豁免）。

---

### B-12 `docs/STATE-MACHINE.md` §4 / §7.1 写着 `SELECT ... FOR UPDATE`，但**全仓 0 处使用行锁**
- **发现于**：Phase 6 · **P6-1 契约起草**（2026-09-25）—— 为钉"并发 loser 如何返回"去读码取证时发现。
- **现象**：`docs/STATE-MACHINE.md` L82「Visit 取号并发 | 事务内 `SELECT max(visit_no) ... FOR UPDATE`」
  与 L147「锁 Ticket（`SELECT ... FOR UPDATE`）」两处都写了行锁；但
  `grep -rni "for update"` 覆盖 `nocobase/` + `scripts/` ⇒ **0 命中**。
  实际实现是：**条件 UPDATE + 影响行数判断**（`ticket-service.ts` `conditionalUpdate`、
  `visit-service.ts` `submit/migrate` 的 `WHERE visit_status='...'`）+ **取号用
  `INSERT ... ON CONFLICT (seq_key) DO UPDATE ... RETURNING`**（`sequence-service.ts`）
  + **唯一索引兜底**（`idempotency_records(scene, idempotency_key)`、`unique(ticket_id, visit_no)`）。
- **定性**：**文档漂移**（文档写的是从未采用的方案）。**产品行为没有问题** ——
  同一份 §4 表格的**另一行**（"两个门店人员同时派工 | UPDATE … WHERE id=$1 AND status=$2；
  影响行数 = 0 即冲突"）**与代码一致**，所以 §4 内部本身就自相矛盾。
  属"**注释/文档不是证据**"的又一例（同 DEV-83 的教训）。
- **为什么不在本轮改**：这两处是 **Phase 4 期**写下的措辞，**不在 P6-0/P6-1 的关闭范围内**；
  顺手改会扩大当前阶段范围，且该文件与 Phase 2/3/4 的多处断言互相引用。
- **本轮已做（限于本阶段范围）**：`docs/PHASE-6.md` §4.5 / §7 的同类措辞已在
  `docs/PHASE-6-P6-1-CONTRACT.md` §1（F1）中**显式纠正**，P6-1 实现**沿用条件 UPDATE**；
  P6-1 契约里的"loser"语义钉在**影响行数 = 0 → 409** 上。
- **待办（建议）**：把 §4 / §7.1 两处改成实际范式（条件 UPDATE + 唯一索引），
  或在句中标注"历史上的设计意图，实现采用条件 UPDATE"。**纯文档，可逆。**
- **可逆**：✅ 可逆（纯文档）。

---

## A 类（本阶段已修，留索引）

| 编号 | 一句话 | 为什么是 A |
|---|---|---|
| DEV-75 | `statusOf()` 漏映射 `VisitValidationError`，照片 413/415/422 全变 500 | 安全边界：拒绝语义失真（"参数不对"被报成"服务故障"） |
| DEV-80 | 已收费的师傅点提交**静默失败**（Vue `type=number` → `.trim()` TypeError） | 闭环：直接阻断一条分支，且页面无任何提示 |
| DEV-76/76b/76c | checker 正则撒网吞掉 6KB 模板 | 验收有效性：假绿（P5 终态红线在吞掉的那段里） |
| DEV-77 | `eq()` 引用比较 ⇒ 断言**永不可能通过** | 验收有效性：会训练人忽略检查 |
| DEV-78 | 终态文案只扫 JS 字面量，模板文本零反应 | 验收有效性 + P5 红线 |
| DEV-79 | `photoUrl()` 渲染路径 throw（白屏）+ 校验层次错 | 闭环可用性 + 安全边界定位 |
| DEV-83 | "照片表不在原生白名单 ⇒ 不可读"**不成立**：门店角色 `GET /api/serviceVisitPhotos:list` → 200 且整行下发 `storage_key` / `upload_ip_hash`（P6-0 N1 抓到） | 安全边界：私有照片的存储实现信息（含磁盘相对路径）可直接读出 |

---

## C 类（留给后续 Phase，本阶段**不得**提前实现）

- 门店确认 / 驳回 action（`VisitStatus` 的 `CONFIRMED` / `REJECTED` 写入；`StoreConfirmStatus` 流转）
  —— **已进入 Phase 6**（2026-09-25 启动）：计划/契约见 `docs/PHASE-6.md`；
  **P6-0** 只做读（门店回执读模型 + **私有照片访问闸门**），**P6-1** 才写 confirm/reject 事务（M9/M10）。
- 评价 Token / 评价页 / 评价短信（`publicReview:*`）
  - **P6-1 已定的边界（2026-09-25 裁决，不要提前做）**：P6-1 **生成并入库** Review Token（只存 hash +
    `feedback_token_expires_at`），但**不发送**评价短信、**不创建**评价类 SmsLog、**不实现** `/f/` 路由、
    **不给**"重发评价短信"按钮（见 `docs/PHASE-6-P6-1-CONTRACT.md` §11.1/§11.2/§11.3、§12）。
  - **上线时必须三件同时**：`/f/{token}` 的 nginx route（**302**、严格 token shape、畸形 404、
    **token URL 不进 access log**）+ **评价 H5 落地页** + **发送双闸门**
    （`feedback_sms_enabled` **AND** `feedback_h5_ready`，后者在 H5 交付前不得由普通后台提前打开）。
    ⇒ 避免"302 到一个不存在的页面"。
  - **Review Token 的常量必须自成事实来源**（算法/长度/字符集），不得假定与师傅侧同为 43 字符。
- `CLOSED` 的写路径与关闭链路
- 上述三者在状态机里**已有声明**（枚举与允许转移表），但**没有任何写路径** —— 这是刻意的：
  声明先行便于评审，实现按阶段推进。
