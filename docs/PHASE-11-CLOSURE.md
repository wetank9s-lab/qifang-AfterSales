# P11-0 关闭报告 · PASS 申请

> **阶段**：Phase 11 / P11-0（产品化升级的第一个切片）
> **契约**：[`PHASE-11-REQUIREMENTS.md`](PHASE-11-REQUIREMENTS.md)（`P11-FROZEN-1`）
> **提交**：`cd42b47`（含 `fd2cbc6`）· 远端 `origin/main` 已回验一致
> **申请**：**P11-0 PASS** —— 由用户签发；本文只陈述事实与证据，不代签。
> **日期**：2026-10-10

---

## 1. 范围与非范围

| | 内容 |
|---|---|
| **已闭合** | 取消"受理"环节 · 单一主动作矩阵（`TicketPrimaryActionModel`）· 去原生按钮墙 · 转店/取消/`remoteComplete` · 厂家 provider-only · **B-8 CLOSED** · 服务详情重组 · **B-15 服务端状态筛选** · **NEW 文案统一为「待处理」** |
| **不属本阶段** | HQ 全员管理（P11-6）· 服务类型 6 类 / 门店人工新建 / 历史数据中心 / 客户多媒体 H5 / 师傅 H5 升级 / 生命周期与真人 UAT（P11-1 ~ P11-7 全部未开始） |
| **明确交接 P11-1** | **B-16**（`pending` 短信无人重发）· **`next_follow_at` 工单列**（当前无到期提醒能力）—— 用户已确认**不阻塞** P11-0 关闭 |

---

## 2. 上一轮 ACCEPTED 的三项要求：完成情况

| 优先级 | 要求 | 结果 |
|---|---|---|
| 一 | 核实评价 Token 是否进入已提交/推送的 Git 历史，给出**脱敏**安全处置结论 | ✅ 见 §4 |
| 二 | **B-15** 升级为必修项：**服务端**状态筛选，保持 storeScope 与分页/统计口径 | ✅ `verify-store-tab-filter` **38/38** |
| 三 (a) | seed 中途失败后的**安全重试** | ✅ 真实 SIGKILL 半写 → 复跑收敛（primary 7 / tab 7 / 旧按钮 0 / 孤儿 0） |
| 三 (b) | 完整闭环真实浏览器流程 + 按钮/状态/收费/审计一致 | ✅ `verify-store-close-loop` **26/26** |
| 三 (c) | 核对 `followUp` 的 `next_follow_at` | ✅ 证明**无该列、无提醒能力**，界面不谎称，交接 P11-1 |
| 三 (d) | 冲突/校验给**可理解的中文**，不把原始码当主要文案 | ✅ 修掉 DEV-109，`verify-store-close-loop` ⑤⑥ 判据钉住 |

---

## 3. 本轮修掉的缺陷（均含变异测试）

### 3.1 产品缺陷

| 编号 | 一句话 | 影响 | 修法 | 变异测试 |
|---|---|---|---|---|
| **DEV-108** | 门店确认后，客户的**评价邀请短信从未投递**（`confirmVisit` 取 `outcome.pending`，而待发短信在 `outcome.value.pending` ⇒ `flush()` 一次没跑） | **闭环断在最后一步**：客户拿不到评价链接，`WAIT_FEEDBACK` 只能等超时扫描被动关闭 | 取 `outcome.value.pending`；判据改钉 **`sms_logs.send_status='accepted'`**（发件箱是投递成功的**结果**，而此缺陷恰恰是压根没投递） | 回退 ⇒ **判红**（`send_status=pending` + 发件箱取不到 + 缺 `reviewed`）；还原 sha 一致 `6db3037e509be1de` ⇒ 26/26 |
| **DEV-109** | 冲突场景员工看到 `…无法确认（TICKET_NOT_REVIEWABLE）` —— 客户端码表 4 个 vs 服务端 `StateConflictError` **11 个**；处理/跟进窗口连码表都没有 | 员工无法判断"是不是我点错了" | 抽 `shared/user-error.ts`，**按 HTTP 409 判定**（码表会漏、状态码不会）+ **刷新界面**；三处界面共用 | 置 409 分支失效 ⇒ **判红**（正是原始码形态）；还原 sha 一致 `d98b950d921db4a3` |
| **DEV-112** | 改了代码常量，**已落库的字段枚举没变** ⇒ 状态列继续显示旧文案 | "Tab 改了、状态列没改"的自相矛盾，且**不报错** | 新增迁移 `20261010-status-label-wording.ts`（three-段自检：行数 → 无旧词 → 逐字比对） | 见 §5.2 |
| **DEV-114**（判据） | 「全部」Tab 的 `meta.count` 判据**间歇性假红** | 同一脚本时红时绿 | 首轮不清空观测窗口（点已激活的 Tab 不发请求） | 连跑 **3×38/38** |

### 3.2 验收器 / 夹具缺陷（"门禁其实没在跑"家族）

| 编号 | 一句话 | 影响 |
|---|---|---|
| **DEV-110** | `technician-harness.mjs` 把 `SVC_SCHEME=https` 配到 **HTTP 端口 8080** ⇒ `https://localhost:8080` 必然失败 | **14 支脚本的断言从未被执行过**（不是"没写断言"，是"从没跑过"） |
| **DEV-111** | `verify-store-ui-primary-action` ③ 取"第一行"且假设"点主动作必开详情抽屉" | **数据依赖的正确**：首行恰好长期是开抽屉的状态 |
| 夹具过时 | `acceptAndDispatch` 写死 `manufacturer` —— P11-0 后**厂家不铸师傅 Token**，不发 `technician_task` 短信 | 凡要 Token 的夹具必须派 `inhouse` |
| **DEV-113** | `verify-client-logic` 一条断言保护的是**缺陷本身**（扫冲突码表字面量） | 实现变好反而判红；改成端到端核对，**强度只增不减** |

---

## 4. 安全处置结论（脱敏）

**本报告全程不输出明文 Token**，只以指纹 `sha256:27f6189daa61…`（前 12 位）指代。

**结论：泄漏已关闭，且不可逆。** 那枚 Token 属验收脚本造的**测试工单**（非真实客户），处置三步：

| 步 | 动作 | 实测结果 |
|---|---|---|
| ① | 文件里的值换成合成串（**字段名/URL 形态/长度原样保留** —— fixture 要的是形态不是值） | 工作区不再含明文 |
| ② | 按**产品自身语义**吊销（`feedback_token_expires_at = now()`） | `GET` → `expired` / `can_review=false`；`POST` → **410** |
| ③ | **轮换 `feedback_token_hash`**（该 Token 的真正校验值） | `GET`/`POST` 均 **404** ⇒ 即使把过期时间改回未来也**映射不到任何工单** |

**暴露范围逐层取证（全部实测）**：

| 层 | 结果 |
|---|---|
| 提交历史 | `git log --all -S` = 0 命中；遍历所有 commit = 0 命中 ⇒ **从未进入任何 commit** |
| 远端 | 当时 `origin/main` **早于**签发；raw 直取该文件 = **404** |
| CI | 无 `.github/workflows` |
| Git 对象库（**含游离 blob**） | 确有 1 个游离 blob（`git add` 会写对象库，即使从未 commit）—— 已定点删除；复扫 810 blob / 15567 文件零命中 |
| 容器日志 | nginx 用 `safe` log_format（不含 `$request`/`$args`）⇒ 43 位串 0；app 日志 2 处经逐条核为请求 ID 误报 |
| 磁盘 | 全仓（含被忽略目录）15567 文件 / 1.37 GB 零命中 |

**本轮推送前复跑** `scan-commit-secrets.mjs --all`（231 个文本文件）：**未发现明文凭证**。

---

## 5. 验收证据汇总（全部本轮实跑）

### 5.1 门禁总表

| 门禁 | 结果 |
|---|---|
| `verify-types` | ✅ 通过（未声明标识符 0 条） |
| `verify-bundle-delivery` | ✅ 产物交付链达标 |
| `verify-ticket-actions` | ✅ **12/12** · `--reverse` ✅（删动作 ⇒ 判红 ⇒ 还原） |
| `verify-store-tab-filter` | ✅ **38/38**（连跑 3 次稳定） |
| `verify-store-close-loop` | ✅ **26/26** |
| `verify-store-ui-primary-action` | ✅ **30/30** |
| `verify-client-logic` | ✅ **58/58** |
| `verify-review-loop` | ✅ **126/126** |
| `verify-technician-submit` | ✅ **19/19**（**历史首次真正跑起来**） |
| `verify-store-review-write` | ✅ **58/58**（历史首次） |
| `verify-report-kpi` | ✅ **31/31** |
| `smoke-test` | ✅ **124/124** |
| `scan-commit-secrets --all` | ✅ 干净 |

### 5.2 B-15 服务端筛选（真实门店账号 `uat.store.a@svc.local` + 真实浏览器）

六个 Tab 的请求**均带正确的 `status.$eq`**；返回记录逐行匹配该 Tab 状态；
服务端 `meta.count` 与库里真值逐一对齐（全部 130 / NEW 38 / PROCESSING 57 /
WAIT_STORE_CONFIRM 1 / WAIT_FEEDBACK 20 / CLOSED 7 / CANCELLED 7）；
分页总数文案一致；组间记录集合互不相同；「处理中」第 2 页无重叠；**跨店 0 行**；**0 个 429**。

两个实测坑（已钉进 14 条双向 fixture）：① 服务端**不认** flow-engine 的 `{logic,items}`
原组形态（500），只认点号键/嵌套；② 无 `value` 的筛选项补默认值 ⇒ `{"status.$eq":true}`
⇒ **「全部」变空表**。变异测试：回退 ⇒ **红 4 条**；还原 sha 一致 `5fae57564990b42c`。

### 5.3 完整闭环（真实浏览器）

匿名建单 → 门店派工 → 真实短信取师傅 Token → 传照片并提交（含收费 88.00）
→ **浏览器**门店点「审核结果」→ 确认（模态框金额**预填 88**）→ `WAIT_FEEDBACK`
→ 客户点评价链接 → `CLOSED`。

一致性核对：主动作标签「审核结果」· 确认后抽屉里确认按钮**消失**（按钮与状态一致）·
`store_confirm_status/confirmed_charge_amount/store_confirmed_by` 一致 · 收费端到端 88 ·
审计事件 `dispatched → technician_submitted → store_confirmed → reviewed` 齐全
（事件名**从服务端 `EVENT_TYPE` 常量导入**，不手写第二份）。

### 5.4 NEW 文案统一为「待处理」（方案 A 落地）

| 判据（真实浏览器） | 结果 |
|---|---|
| Tab 标题 = `["全部","待处理","处理中","待门店确认","待客户评价","已闭环"]`，且**无「受理」字样** | ✅ |
| 各 Tab **状态列逐行**：待处理 20 / 处理中 20 / 待门店确认 1 / 待客户评价 20 / 已闭环 7 | ✅ 逐行一致 |
| 同一张单：**列表状态列** 与 **详情抽屉** 状态文案逐字相同 | ✅ 都是「待门店确认」 |
| 库内 `待受理` 残留（`fields`/`flowModels`/`desktopRoutes`/`collections`/`uiSchemas`） | ✅ 全 0 |

**变异测试**：把期望 Tab 标题改回 `待受理`、**不重灌 seed** ⇒ 判红
（"找不到该 Tab，页面上的 Tab = [全部,待处理,…]"）；还原 sha 一致 `c698b231c66d41eb` ⇒ 复绿。

---

## 6. 一处**刻意不动**并向用户报备的文案

详情底部「处理记录」会渲染**历史事件名**，其中
`constants.ts` 的 `[EVENT_TYPE.ACCEPTED]: '门店已受理'` 含「受理」二字。
那是"这张单**过去真的发生过**受理"的**如实记载**（本项目硬纪律：不抹掉历史）。

用户裁决范围是 **NEW 的状态文案**（"不再出现『待受理』"）⇒ 保留该项；
验收判据也相应**收窄到 `待受理`**，不把历史记载误判成违规。
**若需一并调整历史事件名，属另一次裁决。**

---

## 7. 已知残留（不阻塞本阶段关闭）

| 项 | 状态 |
|---|---|
| **B-16** `pending` 短信无人重发（Phase 8 兜底只捞 `error`） | 进 BACKLOG → **P11-1**。存量 5 条已核对：3 张已 CLOSED、2 张是验收自建 UAT ⇒ **真实客户 0 受影响** |
| **`next_follow_at`** 工单列不存在 | → **P11-1**（迁移 + 白名单同步 + `followUp()` 写工单列 ⇒ 之后才谈得上 P11-6 时效待办） |
| HQ 全员管理 | → **P11-6** |
| `verify-store-tab-filter` 的「全部」`meta.count` 判据 | 已修（DEV-114），连跑 3 次稳定 |

---

## 8. 申请

**P11-0 的验收项已全部跑通，且每一条都有真实浏览器 / 真实门店账号 / 变异测试支撑。**
据此申请 **P11-0 PASS**，并**在用户签发后直接进入 P11-1**。

> 说明：本文由实现方撰写，按项目纪律**不代签 PASS**；状态以用户裁决为准。
