# Phase 3 — 客户 H5 报修（阶段交付报告）

> **状态：✅ PASS**（2026-09-21 独立复核通过）
> 2026-09-20 A→I 全部交付 · 2026-09-21 阶段内验收并入总闸 `smoke-test.mjs` · 2026-09-21 完成 **Phase 3.1 重复单修正** · 2026-09-21 **独立复核通过，正式判 PASS**
>
> 本文件是 Phase 3 的**独立阶段报告**。逐条验收口径的原始出处见 `docs/DEV-PLAN.md` §「Phase 3 — 客户 H5 报修」，
> 偏差登记见 `docs/DEVIATIONS.md`（**DEV-28 ~ DEV-37**），变更历史见 `CHANGELOG.md`。

> **复核后收口两处文档漂移**（2026-09-21，非阻塞、已修）：
> ① `docs/SECURITY.md` 的"依赖"行手写旧版本线，而实际镜像早已冻结为另一 tag；
> ② 同文件频控表把 `svc_upload` 的 `burst` 抄到了 `/api/public/` 那行（属于**另一个 zone 的另一个数**）。
> 两处都**不影响任何运行行为**，因此没有任何真机断言能发现它们。
> 处置不是"改对数字"，而是**取消第二个维护点**：SECURITY.md 不再复写版本与限流参数，只指向
> `scripts/expected-versions.mjs` 与 `nginx/conf.d/service.conf`；并把这条规则写成 `verify-config` 断言
> （43 → **44 项**，已做注入验证证明它会变红）。**对交付物行数之类的数字不作为验收证据**，
> 因为它是叙述而非契约，随任何一次编辑漂移而无断言价值。

---

## 1. 本阶段目标

Phase 1 / 2 打通了「数据底座 + 权限 + 内部接口」，但整个系统此时对外是封闭的 ——
**没有任何一条客户能走的路**。Phase 3 要交付的就是这条唯一由匿名客户直接触达的入口，以及它必须承受的滥用压力。

三件事，缺一不可：

1. **匿名报修主链路**：门店列表 → 提交工单 → 拿到单号，全程不需要注册登录。
2. **守卫链**：匿名入口意味着它一定会被刷。四类守卫（IP 频控 / 手机号频控 / 重复单 / `request_id` 幂等）
   必须在建单之前全部生效，且**顺序**本身是安全设计的一部分。
3. **解除 Phase 2 的唯一挂起项**：「100 路并发取号无重复、无空洞」。当时唯一能触发取号的入口就是本阶段的
   创建工单接口，所以这项验收天然属于 Phase 3，也是 Phase 2 能否补签 PASS 的前提。

**交付顺序 A→I 不得跳步**（`docs/DEV-PLAN.md`），因为 I 步（100 路真实并发）必须建立在 A~H 全部就位之上。

---

## 2. 实际交付文件

对应提交 **`b97ca66`**（42 文件 / +7308 −409）。

### 2.1 服务端（`nocobase/plugins/service-ticket`）

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/server/actions/public/store.ts` | 新增 | `GET /api/public/stores`，仅回 `code`/`name` |
| `src/server/actions/public/ticket.ts` | 新增 | `POST /api/public/tickets`，守卫链 ①~⑧ 的唯一实现处 |
| `src/server/services/guard-service.ts` | 新增 | **GuardService** —— 四类守卫的唯一实现（Phase 3.1 加入了 `normalizeContent()`） |
| `src/server/actions/svc/guard-quota.ts` | 新增 | `GET /api/svc:guardQuota` 只读诊断（需 `X-Svc-Diag-Key`，见 DEV-28） |
| `src/server/actions/svc/_http.ts` | 修改 | 错误信封与 `clientIpOf`（IP 解析口径） |
| `src/server/services/ticket-service.ts` | 修改 | 建单事务、`CONTENT_MIN/MAX` 校验 |
| `src/server/services/index.ts` | 修改 | 服务注册 |
| `src/server/plugin.ts` | 修改 | action 注册与匿名白名单 |
| `src/server/constants.ts` | 修改 | `SVC_ACTION` / `PUBLIC_ACTION` 常量 |

### 2.2 前端（`h5/`，Vite + Vue3 + TS）

| 文件 | 说明 |
|---|---|
| `src/pages/Report/index.vue` | `/report` 报修页（表单 + 隐私勾选门槛） |
| `src/pages/Report/Success.vue` | `/report/success` 成功页（展示单号） |
| `src/pages/NotFound.vue` | 兜底页 |
| `src/api/http.ts` | 请求封装 + 错误信封解析（`ApiError`） |
| `src/api/public.ts` | 公开接口客户端，含 **single-flight** 提交器 |
| `src/utils/{uuid,validate,privacy}.ts` | `request_id` 生成 / 表单校验 / 隐私文案与版本 |
| `src/router.ts` | 自研 minimal router（H5 体量不值得引 vue-router） |
| `src/styles/base.css` | 移动端基线样式 |
| `vite.config.ts` / `tsconfig.json` / `package.json` | 构建配置（`base: '/h5/'`） |
| `public/.gitkeep` | 见 §5.4（保证 `dist/` 在未构建的仓库里也真实存在） |

### 2.3 配置与脚本

| 文件 | 说明 |
|---|---|
| `nginx/conf.d/service.conf` | `/api/public/*` 显式 rewrite（DEV-30）+ `/h5/` 静态站点（`root` 而非 `alias`，DEV-29） |
| `scripts/verify-phase3-h5.mjs` | H5 自身验收（4 组 35 项） |
| `scripts/smoke-test.mjs` | 总闸，新增 §4c（Phase 3 契约验收） |
| `scripts/verify-concurrency-phase2.mjs` | 100 路并发取号验收（Phase 3-I） |

---

## 3. A→I 完成结果

| 步 | 内容 | 完成判据 | 结果 |
|---|---|---|---|
| A | `GET /api/public/stores` | 只回 `code`/`name`，不含内部 id 与其他门店信息 | ✅ 真机 15 家门店，恰好 2 字段 |
| B | `POST /api/public/tickets` | 返回 `{ticket_no, store_name, created_at}`，**不返回 `id`** | ✅ 响应恰好 3 字段 |
| C | `GuardService`（IP / 手机号 / 重复单 / 幂等） | 四类守卫各自可被独立断言点亮 | ✅ 四类均有点亮断言 |
| D | `request_id` 幂等（`idempotencyRecords`） | 重放返回首个 `ticket_no`，且不消耗序号 | ✅ 重放逐字节一致，序号增量 0 |
| E | IP / 手机号频控 | 超频返回 **429**（阈值取库，不写魔法数） | ✅ 429 + `Retry-After` |
| F | 重复单识别 | 命中返回原单，不新建 | ✅ 409 `DUPLICATE_TICKET` + 原单号，**不消耗序号**（Phase 3.1 已修正判定维度，见 §10） |
| G | 隐私说明与勾选（`privacy_agreed` 强校验） | 未勾选一律 400 | ✅ 400 `PRIVACY_NOT_AGREED`（缺省 / 显式 `false` 两形态） |
| H | `/report` Vue3 H5（含 `/report/success`） | 手机端可用；连点 10 次只产生 1 单 | ✅ `verify-phase3-h5.mjs` **35 项全绿** |
| **I** | **100 路真实 API 并发取号** | `verify-concurrency-phase2.mjs` **8 条断言全绿 → 补签 Phase 2 PASS** | ✅ **8 条全绿、退出码 0**（详见 §8） |
| 末 | 阶段内验收并入总闸 | 并入 `smoke-test.mjs` | ✅ §4c 共 **12 项**，总闸 **76 项全绿** |
| 3.1 | 重复单补「事项文本」维度 | 同客户不同事项可各建一单 | ✅ 见 §10 |

---

## 4. `POST /api/public/tickets` 守卫顺序

顺序**不能调换**，每一处都有明确理由（实现见 `actions/public/ticket.ts` 文件头注释）。

```
① X-Request-Id 校验      缺失/非法 → 422
② 隐私勾选               未勾选   → 400
③ 字段白名单 + 结构校验            → 422
④ IP 频控（消费式）      超限     → 429
⑤ request_id 幂等        命中     → 200 回放首次响应
⑥ 手机号日频控（消费式） 超限     → 429
⑦ 重复单识别             命中     → 409 DUPLICATE_TICKET（带原单号）
⑧ 建单（取号 + 建单 + 写事件 + 写幂等记录，同一事务）→ 201
```

**三处顺序理由**：

- **④ 必须在 ⑤ 之前**。幂等命中会直接返回、不再往下走；若把「读幂等」提到频控之前，
  同一个 `request_id` 就能被无限重放且**不消耗任何配额** —— 等于给刷单者开了一条免限流的旁路。
  先把配额扣掉，再看要不要回放。
- **② 在 ③ 之前**。隐私勾选是**准入门槛**（DEV-PLAN Phase 3-G 明文「未勾选一律 400」）。
  若排在字段校验之后，「body 里少了一个字段」会先返回 422，
  于是「未勾选」在某些请求形态下永远拿不到 400 —— 验收口径就成了一句需要附加说明的话。**门槛就该在门口。**
- **⑦ 在 ⑧ 之前，且不消耗序号**。重复单意味着「已经有一张在办了」，不该再取一个号，
  否则工单号出现空洞，「序号连续」的验收口径被污染。Phase 3.1 起 ⑦ 需**五维全同**才算重复（§10）。

**响应体只回三个字段** `{ ticket_no, store_name, created_at }`：不回 `id`（匿名接口暴露内部主键等于给出可枚举实体）、
不回处理人、不回门店 id/电话。

---

## 5. H5 交付

### 5.1 页面与路由

| 路由 | 页面 | 说明 |
|---|---|---|
| `/h5/report` | 报修表单 | 门店选择（来自 `/api/public/stores`）、内容、姓名、手机号、隐私勾选 |
| `/h5/report/success` | 提交成功 | 展示单号与门店名，提示勿重复提交 |
| `/h5/*` | 兜底 | NotFound，避免白屏 |

### 5.2 提交器 single-flight（`api/public.ts`）

连点 10 次只发 **1 个 HTTP 请求**。`request_id` 仅在**内容变化时**重新生成 ——
内容不变的重试必须复用同一个 `request_id`，否则服务端的幂等根本无从生效。

> ⚠️ 必须区分两个独立的「单飞」：**前端 single-flight 只能减少请求数，挡不住弱网重试 / 多标签页 / 狂点刷新**。
> 真正的防线在服务端 —— 这正是 Phase 3.1 之前 §4c 能抓出 DEV-32 并发缺陷的原因。

### 5.3 隐私门槛

首屏展示个人信息处理说明（收集目的 / 范围 / 保存期限 / 联系方式），提交前置勾选；
未勾选时前端直接拦截，同时服务端 ② 兜底（400 `PRIVACY_NOT_AGREED`）——
**前端拦截不是安全边界**。

### 5.4 构建与挂载（两个容易踩的坑）

- `h5/dist` 是 nginx 容器的 **bind mount 宿主目录**。若目录在宿主上不存在，docker 会**静默创建一个
  root 所有的空目录**挂进去，表现为 `/h5/` 404 而非任何「挂载失败」报错，排查方向会被带偏很远。
  因此保留 `h5/public/.gitkeep`（Vite 的 `publicDir` 语义会在**每次构建后**把它复制进 `dist`）。
- **整个 `dist/` 不入库**（只跟踪 `dist/.gitkeep`）。曾对 `index.html` 开过例外，那是错的：
  `index.html` 是 Vite 构建输出，内部写死了 `assets/index-<hash>.js` 这种**带内容哈希**的文件名 ——
  一旦入库就是「页面能开、引用的 JS 不存在」的白屏，比什么都没有更难排查。
  部署前必须 `cd h5 && npm ci && npm run build`。

---

## 6. `smoke-test.mjs` 最终结果

### 6.1 总数

```
✅ Phase 1~3 端到端验收全部通过：76 项
EXIT=0
```

### 6.2 §4c —— Phase 3 契约验收（12 项，走 nginx，不依赖前端构建）

| # | 断言 | 关键判据 |
|---|---|---|
| 1 | 门店列表只回 `code`/`name` | 连 `id` 都不出（匿名接口最小披露） |
| 2 | 建单 `201`，响应体**恰好**三字段 | 多回一个 `id` 即泄漏内部主键 |
| 3 | 同 `X-Request-Id` 重放 `200` + 同单号 | 工单总数不变、幂等记录恰 1 条 |
| 4 | 未勾选隐私一律 `400` | 字段缺省 / 显式 `false` 两形态，且**不落库** |
| 5 | 缺 `X-Request-Id` → `422` | `detail.header` 指明缺哪个头 |
| 6 | 同手机号+门店+类型+**同内容** → `409` | `detail.ticket_no` 指向原单 |
| 7 | **Phase 3.1-A** 完全相同内容 → 409 | 回原单号 + 不落新单 + **序号不推进** |
| 8 | **Phase 3.1-B** 同客户不同事项 → 201×2 | 各建一张独立工单 |
| 9 | **Phase 3.1-C** 仅空白/标点差异 → 409 | `normalizeContent` 归一化后相同 |
| 10 | **Phase 3.1-D** 同内容不同 `ticket_type` → 201×2 | 类型仍是独立维度 |
| 11 | **Phase 3.1-E** 原单 `CANCELLED` → 201 | 取消后重报是正常行为 |
| 12 | IP 分钟频控超限 → `429 RATE_LIMITED` | `detail.scope=ip`、带 `Retry-After`、来源是**应用层** |

### 6.3 429 断言的实现要点

**不连发打满真实阈值**，改为「库里 `security.ip_minute_limit` 临时降到 2 + 3 个请求」，
并在 `finally` 里**无条件**恢复 30 与清空 `ip` 桶。

理由（实测）：nginx `svc_public burst=10` 只放行 **11 次**突发（DEV-34），
走网关打满应用层阈值需约 60 秒，且会掏空网关桶、让**下一轮**验收全红。
附带收益：验到「阈值来自库、10s TTL 内生效、**不需要重启**」（DEV-31）。

两种 429 必须能区分：网关 `{"code":"TOO_MANY_REQUESTS"}` vs 应用层 `{"errors":[{"code":"RATE_LIMITED"}]}`
—— 混同会把「网关拦了」读成「频控生效了」。脚本用 `phase3LimitSource()` 显式判定。

---

## 7. `verify-phase3-h5.mjs` 最终结果

```
✅ 35 项全绿、退出码 0
```

四组，全部使用**真实构建产物**而非读源码猜行为：

| 组 | 内容 |
|---|---|
| 【1】 | 前后端契约对齐（源码级：请求字段集 / 响应字段集 / 错误码） |
| 【2】 | 提交器行为 —— 把 `h5/src/api/public.ts` 用 esbuild 打成 ESM 后**真跑**：连点 10 次只发 1 个 HTTP；内容变化时才换 `request_id` |
| 【3】 | 真机端到端：同一 `request_id` **并发 10 次** → 恰好 1 张工单、序号恰好 +1（`201×1 + 200×9`） |
| 【4】 | 构建产物与 nginx 交付：`dist/index.html` 的 `base` 是 `/h5/`、`assets/*.js` 实取 200 |

支持 `--offline` 跳过第【3】组（无 Docker 环境时）。

---

## 8. 100 路真实并发结果

脚本：`scripts/verify-concurrency-phase2.mjs`（Phase 3-I，也是 Phase 2 挂起项的唯一解除手段）

| 项 | 结果 |
|---|---|
| RUN_ID | `20260920T212007-bb89` |
| 断言 | **8 条全绿、退出码 0** |
| 并发形态 | 100 路真实 HTTP 全链路（走 nginx，非直连服务层） |
| 建单 | `201×100`，耗时 **779ms** |
| 工单号 | `FW20260920-0111` … `FW20260920-0210` **连续无空洞** |
| 取号器 | `daily_sequences` `110 → 210`（增量**恰为 100**） |
| 唯一约束 | 无 `23505` 冲突 |
| 事件 | 每张工单**恰好** 1 条 `created` 事件 |
| 幂等重放 | 序号增量 **0** |

**全程未用 SQL 直连取号替代压测，也未为造绿灯拆掉频控 / 幂等 / 唯一约束。**
跑完后两层阈值均已恢复（`git diff` 确认 nginx 三处逐字还原、库内 `guardQuota.limit = 30`）。

---

## 9. DEV-28 ~ DEV-37

| 编号 | 一句话 |
|---|---|
| **DEV-28** | 匿名白名单新增只读诊断 `GET /api/svc:guardQuota`，需 `X-Svc-Diag-Key`（= 进程内 `SIGN_SECRET`），密钥不符**一律 404**（fail-closed，刻意不回 401/403 以免泄露接口存在） |
| **DEV-29** | `/h5/` 必须用 `root` 而非 `alias`：正则 `location` + 无捕获组的 `alias` 会触发**目录重定向**，返回 `301` 补尾斜杠且 `Location` 丢掉对外端口 → 页面能开、JS/CSS 全 301 → **白屏**，报错方向极具误导性 |
| **DEV-30** | 匿名接口的对外路径由 nginx **显式** rewrite 折叠成 NocoBase 资源名（不用通配，语义唯一：路径拼错就让 nginx 直接 404） |
| **DEV-31** | 限流阈值有**两层**（应用层库 + nginx），且 `.env` 只影响**首次种子**（`seedSettings` 存在即跳过）→ 改 `.env` + 重启**无效**；正确做法是 `UPDATE service_settings`（10s TTL，无需重启）+ nginx 一起改 |
| **DEV-32** | 同 `request_id` 并发必须**进程内串行**：原实现 10 路并发 → `201×1 + 200×4 + 429×5`、序号 `1→6`（增量 5）。根因是 ⑤「读幂等」不产生行 → 全部继续 → 各自消费手机号额度、各自取号。修法是按 `scene:request_id` 加进程内串行锁，**锁不含 ④ IP 频控**（否则开出一条免限流旁路） |
| **DEV-33** | `DEV-PLAN` Phase 3-A 写的 `region` 字段**不存在**（`stores` 表无该列），以 `docs/API.md` §1.1 为准只回 `code`/`name` |
| **DEV-34** | nginx `limit_req burst` 的真实含义是「**N+1 次突发 + 按 rate 回填**」：`rate=30r/m burst=10` 实测连发 45 次**只过 11 次**，第 12 次起就是网关 429，而此刻应用层 `used` 才 11（阈值 30）。**nginx 才是先卡住的那层** |
| **DEV-35** | 验收断言必须**与库龄无关**：「第 1 页 / 前 N 条 / 总量」这类判据会随数据增长漂移成假红灯（H5 占位页断言过时 + AT-03 假设了空门店） |
| **DEV-36** | 重复单识别补「**事项文本**」维度（PHASE-0 §9.4 的原规则，Phase 3 实现漏了）→ 见 §10 |
| **DEV-37** | 当前版本按**单 NocoBase 应用实例**运行，横向扩容前必须重新验证 `request_id` 幂等竞态与 `ticket_no` 无空洞性质 → 见 §11.3 |

---

## 10. Phase 3.1 重复单修正

### 10.1 问题

Phase 3 独立复核发现：`GuardService.findDuplicateTicket` 的判定维度只有
**同手机号 + 同门店 + 同 `ticket_type` + 时间窗**，
**漏掉了 `PHASE-0.md` §9.4 明文要求的「事项文本相似」**。

后果是把**合法场景**当重复挡掉：

```
同一客户、同一家店、10 分钟内：
  工单 A：空调不制冷      ← repair
  工单 B：冰箱漏水        ← repair
→ B 被判成 A 的重复单，客户拿不到 B 的单号
```

这不是「防刷生效」，是把正常业务挡死。

### 10.2 修法

判重改为**五维全同**，且排除已取消：

```
customer_mobile 相同
AND store_id 相同
AND ticket_type 相同
AND normalizeContent(content) 相同      ← 新增
AND created_at 在 duplicate window 内
AND status <> 'CANCELLED'
```

新增**确定性**的 `normalizeContent()`（`guard-service.ts`）：

1. `String.normalize('NFKC')` —— 全角 → 半角（Ａ→A、１→1），兼容字符统一
2. 删除 Unicode 标点与符号（`\p{P}\p{S}`）—— 覆盖中文标点 / 全角标点 / 常见符号
3. 删除**全部空白**（含 NFKC 转出的空格、换行、制表）
4. 仅把 ASCII `A–Z` 转小写

**实现分工**：SQL 仍用前四个维度把候选压到极小（`LIMIT 50`），**应用层**再逐条比较归一化结果 ——
归一化依赖 `NFKC` + Unicode 字符类，PG 侧没有对等能力，而本阶段的明确约束是**不引入 PostgreSQL 扩展**。

**三条刻意的取舍**：

- **不引入 AI / 向量 / 复杂 NLP**。判重结果直接拒绝客户请求，必须是可复现、可解释、可测的；
  相似度阈值调参会变成新的运维负担。
- **判错两个方向的代价不对称**：漏判 = 客户看到两张单（可人工合并）；误判 = 客户拿不到单号、以为系统坏了。
  因此一切边界情形（归一化后为空、候选超限）一律**放行**。
- **归一化后为空必须放行**（`if (!normalized) return null`）。拿空串当键判重，等于把「内容缺失」
  当成「内容相同」，是比漏判更糟的误判。

### 10.3 验收（A~E 五组，已进 `smoke-test.mjs` §4c 总闸）

| 组 | 场景 | 期望 | 实测 |
|---|---|---|---|
| **A** | 同手机号+门店+类型，**内容完全相同**，10 分钟内 | 409 + 回原单号 + 不建新单 + **不消耗序号** | ✅ `409` 回原单 `FW20260921-0014`；序号 `13→14`，**重复后仍为 14** |
| **B** | 同上，但「空调不制冷」/「冰箱漏水严重」 | 201，两张**独立**工单 | ✅ `FW20260921-0015` + `FW20260921-0016` |
| **C** | 内容仅空白/标点差异（`" 洗衣机不脱水。 "`） | 判为重复 | ✅ `409` 回原单 `FW20260921-0017` |
| **D** | 同手机号+门店+内容，不同 `ticket_type` | 允许 | ✅ `repair FW20260921-0018` + `complaint FW20260921-0019` |
| **E** | 原工单为 `CANCELLED` | 允许重新创建 | ✅ `FW20260921-0020` 置 CANCELLED → 重新提交得到 `FW20260921-0021` |

> A 组的两条断言（`seqAfterDup === seqAfterCreate`、`phase31Count(mobile) === 1`）是
> 「**重复单不消耗序号**」的直接证据 —— 取号发生在建单事务**之前**，若 ⑦ 被跳过，序号就会凭空 +1。

**E 组的夹具说明**：把工单置为 `CANCELLED` 用的是 SQL，而不是 `/api/svc/ticket:cancel`。
本断言要验的只是「判重是否排除 `CANCELLED`」这一条规则，不是取消流程本身（那由 svc 侧覆盖）；
用 SQL 可以避免把「登录 + 能力矩阵 + 状态前置」三件事的失败混进来，让红灯的归因保持唯一。
只改 `WHERE ticket_no = ...` 命中的那一条，不碰其它数据。

### 10.4 附带发现

用户举例中的「**冰箱漏水**」只有 4 字，会被既有的 `CONTENT_MIN = 5` 拦成 `422 INVALID_CONTENT`。
那是**内容长度**门槛，与判重无关 —— 断言改用满足长度的措辞（「冰箱漏水严重」）。
该约束已写入 §11.1，Phase 3.1 **未改动** `CONTENT_MIN`（不属于本次整改范围）。

---

## 11. 当前已知限制

### 11.1 输入与判定

| 限制 | 说明 | 影响 |
|---|---|---|
| `CONTENT_MIN = 5` / `CONTENT_MAX = 500` | 报修内容长度硬约束，早于判重生效 | 过短内容返回 `422 INVALID_CONTENT`，与重复单无关，排查时勿混淆 |
| 判重是**软约束** | 五维全同 + 移动时间窗**无法用唯一索引表达**（窗口是移动的，内容还要归一化） | 并发下存在**极小概率漏判**（两张单）。真正的硬防线是手机号日频控与 IP 频控 |
| 归一化是**宽松**的 | 标点与空白都被删除，因此 `"不制冷,漏水"` 与 `"不制冷漏水"` 视为相同 | 刻意的宽松化：宁可漏判（两张单可合并）也不要误判（客户拿不到单号） |
| 候选上限 `LIMIT 50` | 窗口内「同手机号+门店+类型」的候选最多取 50 条 | 超限只**漏判**（放行），不会误判。50 相对手机号日额度（默认 5/日）已是很大余量 |
| 归一化后为空 ⇒ 放行 | 原文全由标点/空白构成时不判重 | 避免「内容无意义」的提交互相拦死 |
| 不改判重为相似度/向量 | 第一版明确不引入 AI / NLP | 语义相近但措辞不同的两条（「空调不凉」/「空调没冷气」）**不会**被判重复 —— 按设计接受 |

### 11.2 验收与环境

| 限制 | 说明 |
|---|---|
| 限流是**两层**的 | 应用层阈值在 `service_settings`（10s TTL），nginx 另有一层。改 `.env` **无效**（只决定首次种子）。测 429 必须两层一起调、并在 `finally` 里无条件恢复（DEV-31） |
| nginx 突发语义反直觉 | `rate=30r/m burst=10` = **11 次突发 + 0.5 次/秒回填**，不是「一分钟 30 次」。走网关打满应用层阈值需约 60 秒，且会掏空桶让下一轮验收全红（DEV-34） |
| `smoke-test.mjs` §4c 需要等待 | Phase 3.1 的 A~E 会连发约 10 次 `/api/public/` 请求，因此脚本在动手前 `sleep 22s` 等 nginx 令牌桶回填（22s × 0.5 = 11，恰好补满）。代价是每轮多 22 秒，换来结论可信 |
| 断言必须与库龄无关 | 夹具断言一律按 `[SMOKE]` 前缀或 id 收窄范围，不得假设「库里只有本次数据」（DEV-35） |

### 11.3 部署形态（**重要**）

> **当前版本按单 NocoBase 应用实例运行。未经专门改造不得直接横向扩为多个 app replica。
> 多实例部署前必须重新验证 `request_id` 幂等竞态和 `ticket_no` 无空洞性质。**

原因（**DEV-37**）：

- `createPublicTicketHandler` 对同一 `request_id` 的互斥是**进程内**串行锁（`Map<scene:request_id>`）。
  两个 replica 会各自加锁，互斥失效。
- `TicketService.create` 的 `ticket_no` 获取发生在**业务事务之前**。跨实例只能依赖 `daily_sequences`
  的行级锁；若出现「取号成功但建单回滚」的空洞，需评估是否接受并把口径写进 SLA。

当前 Docker Compose 只有 `svc-app` 一个实例，因此上述两点成立。**不阻塞 Phase 3**，登记目的是防止后续
有人「顺手」扩容而没重跑这两条验证。

### 11.4 尚未交付

| 项 | 说明 |
|---|---|
| `storeUsers` 门店用户映射**种子** | 等业务方给出账号清单后再落；当前仅验收期临时建号 |
| **后台业务页面** | 门店受理 / 派工 / 审核 / 总部 KPI 页面均未交付。硬约束：**最迟 Phase 4 完成前交付** |

---

## 12. 下一阶段 Phase 4

**主题：派工 / Visit / Token / 短信。**

| # | 交付项 | 要点 |
|---|---|---|
| 1 | 门店受理 → 派工 | 建 `Visit`、写状态与事件（同事务）、双短信（客户 + 师傅） |
| 2 | 师傅一次性 Token | `/api/svc/photos` 上传链路；Token 60 次/小时；上传 ≤6 张/Visit；`*_token_hash` 存 SHA-256 |
| 3 | 照片安全 | 服务端 magic bytes 嗅探（不信任扩展名/Content-Type）、去 EXIF（含 GPS）、**私有存储** + 短时签名 URL 读取 |
| 4 | 短信适配层 | `AliyunSmsProvider` + `MockSmsProvider`（开发期默认 Mock）；回调按 `provider + biz_id` 幂等 |
| 5 | **后台业务页面** | 承载门店受理/派工的可操作界面 |

**硬约束（`docs/DEV-PLAN.md`）**：

- 后台业务页面**最迟 Phase 4 完成前交付** —— 这是 Phase 2 就挂起、被裁定重排到 Phase 4 的缺口。
- **派工验收必须包含真实售后人员的 UI 走查**，不接受纯接口自证。

**恢复期注意事项**：Phase 3 的核心结论（尤其是「重复单是软约束」「单实例边界」「两层限流」）
在 Phase 4 引入新的写入口（派工、照片上传）后必须**重新回归**，因为它们都依赖同一套守卫与事务纪律。
