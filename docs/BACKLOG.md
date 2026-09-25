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

---

## C 类（留给后续 Phase，本阶段**不得**提前实现）

- 门店确认 / 驳回 action（`VisitStatus` 的 `CONFIRMED` / `REJECTED` 写入；`StoreConfirmStatus` 流转）
- 评价 Token / 评价页 / 评价短信（`publicReview:*`）
- `CLOSED` 的写路径与关闭链路
- 上述三者在状态机里**已有声明**（枚举与允许转移表），但**没有任何写路径** —— 这是刻意的：
  声明先行便于评审，实现按阶段推进。
