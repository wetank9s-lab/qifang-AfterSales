# S0 基线核查报告

> 日期：2026-10-30 09:2x · 性质：**只读核查**（未改代码/配置/数据/产物，未重启容器，未 commit/push，未跑测试与构建）
> 结论先行：**Git 工作区比交接文档多 1 项（已查明来源）**；**本机进程正在使用旧产物**（不是新产物）；
> **P0-1 实为 9/13、P0-2 实为 8/10，缺口 4+3 项全部可定位**；**BE-04「UI 组件未实现」是过期表述，组件已实现且已上生产**；
> **构建门禁有 2 个真实缺口：TS2741 门禁未接线、全量基线脚本路径硬编码**。

---

## A. 工作区状态

### A.1 实测

| 项 | 值 | 命令 |
|---|---|---|
| 工作目录 | `/c/Users/Administrator/WorkBuddy/2026-09-20-15-28-58` | `pwd` |
| 分支 | `main` | `git rev-parse --abbrev-ref HEAD` |
| 最后提交 | `9a57997` · 2026-10-22 09:56:04 +0800 · `feat(phase-11): add new modules referenced by preceding commits` | `git log -1` |
| 未提交总数 | **169**（130 未跟踪 + 39 已修改） | `git status --short` |
| 已修改的**有效**文件 | **38** 个，+1784 / −242 | `git diff --stat` |

### A.2 与交接文档「168」的差异 —— 已查明，不是丢失

169 与 168 相差 **1 项**，来源明确：

```
昨日基线 168 + 今日新增 docs/DEVELOPMENT-HANDBOOK.md = 169
```

即本轮之前交付《开发文档》时新增的一个未跟踪文件。**没有文件丢失，也没有多出来的未知改动。**

另有一处需要说明：`git status` 报 39 个 `M`，但 `git diff --name-only` 只有 38 个。
差的那一个是 `nocobase/plugins/service-ticket/src/shared/svc-request.ts`：

```
$ git status --short -- <该文件>   →  M
$ git diff --numstat -- <该文件>   →  （空）
$ git ls-files -v -- <该文件>      →  H（普通跟踪，非 assume-unchanged）
```

⇒ 该文件的修改标记来自 **stat/行尾差异，内容无实质变化**（本仓库 CRLF + autocrlf）。
**结论：有效未提交改动 = 168 项文件级标记 − 1 项空改动 = 167 个真实改动对象。**

### A.3 未跟踪成果的构成（丢失风险清单）

| 类别 | 数量 | 说明 |
|---|---|---|
| `docs/` | **111** | 绝大部分是验收报告与专项证据，**只存在于工作区** |
| `nocobase/plugins/**` | 9 | 新模块（含 `date-range-item-model.tsx` 等） |
| `h5/src` 等源码 | 10 | 新组件/工具 |
| `scripts/` | ~8 | **4 个门禁相关**：`prebuild-guard.mjs`、`verify-ts-baseline.mjs`、`verify-ts2741-baseline.mjs`、`expected-ts-baseline.json` / `expected-ts2741.json`；另有 `deploy-s6-remote.py` |

### A.4 风险判定

| 风险 | 级别 | 说明 |
|---|---|---|
| **未跟踪成果无版本保护** | 🔴 高 | 130 项未跟踪文件**不在任何提交里**，一次 `git clean -fd` 或误删即永久丢失；其中含 4 个门禁脚本与 111 份报告 |
| **`.tmp-verify/` 被忽略** | 🟠 中 | 该目录存验收截图与夹具（P0-2 的三张宽度截图等），`git clean -fdx` 会一起删；它们**不是**可再生产物 |
| **`.workbuddy/` 被忽略** | 🟠 中 | 日度记忆与项目长期记忆不在 git 内 |
| 敏感文件泄漏 | 🟢 低 | `.env`、`.env.prod`、`storage/apps/main/aes_key.dat`、`storage/.license/instance-id` **全部已被 ignore**（`git check-ignore` 逐项确认） |

**建议（不在本轮执行，需授权）**：先做一次**本地 bundle 备份**（`git stash create` 或直接打包未跟踪文件），再考虑分批提交。不要先清理。

---

## B. 环境与版本一致性

### B.1 三方时间线

| 对象 | 时间 | 证据 |
|---|---|---|
| 源码（无更晚于产物的文件） | ≤ 产物时间 | `find src -newer dist/server/index.js` → **空** |
| **构建产物** | **2026-10-29 17:23:51 +0800** | `stat dist/server/index.js`；容器内同一文件同 mtime（bind mount） |
| **服务进程（node）** | **2026-10-29 12:07:30 +0800** | `docker top svc-app` → PID 1628 `node … yarn start` STARTED Oct 29 04:07:30 UTC |

### B.2 判定

> **产物比进程新 5 小时 16 分 ⇒ 当前运行中的服务加载的是旧代码（12:07 那一版），不是当前 dist。**

- 源码 ≤ 产物：**源码与产物一致**（不存在"改了源码没重建"）。
- 产物 > 进程：**产物与进程不一致**（铁律 26 的活样本）。
- 容器 `svc-app`：`Up 21 hours (healthy)`；`/api/app:getInfo` **200**。

**推论（需标注为推断）**：进程内存中的插件版本 = 12:07 时 dist 的内容，**其确切 SHA 无法直接读出**（未确认）。
当前 dist 的 server SHA 为 `ab586ef53083e3ea…`（含 BE-03-SMS-COPY-01 的短信文案改动）。

### B.3 三套环境的版本差异

| 环境 | server SHA | client SHA | 说明 |
|---|---|---|---|
| 本机 dist | `ab586ef53083e3ea…` | `1c0845b91e9b4b48…` | 最新构建 |
| **生产** | `0dc13875760cd924…` | `62677303c562a33d…` | 未含短信文案改动 |
| p6-uat（13099） | 独立副本 | 独立副本 | Up 17h，health 200 |

### B.4 建议（本轮不执行）

1. **下次要验证本机行为前**，先 `docker compose restart app`，再跑 `node scripts/verify-bundle-delivery.mjs` 确认交付链。
2. **不要**为了"让版本一致"而把本机 dist 推到生产 —— 两者当前本就不同，属预期。
3. NocoBase 镜像 `nocobase/nocobase:2.2.15-full-no-nginx`：**不得升级**（本轮未做任何镜像操作）。

---

## C. P6 验收矩阵

> 证据等级严格区分：**真 HTTP**（P0-1）≠ **浏览器+模拟响应**（P0-2）≠ **静态代码存在**。
> 报告：`docs/P6-P0-UAT-05-REPORT.md`（2026-10-29 16:08–16:30）· `docs/P6-PRIORITY-01-REPORT.md`

### C.1 P0-1 维修措施（13 项，真 HTTP，独立 UAT `scqf_p6_uat`）

| # | 用例 | 结果 | 级别 | 证据 |
|---|---|---|---|---|
| 1 | `service_note=""` | **PASS** 422 `SERVICE_NOTE_TOO_SHORT` | 真 HTTP | UAT-05 §2 |
| 2 | 全空白 `"   \n\t "` | **PASS** 422 同上 | 真 HTTP | 同上 |
| 3 | 4 个有效字符 | **PASS** 422 同上 | 真 HTTP | 同上 |
| 4 | 5 个有效字符 | **PASS** 200；Visit→`SUBMITTED`、Token 置位、Ticket→`WAIT_STORE_CONFIRM`、事件 0→1 | 真 HTTP + 库前后态 | 同上 |
| 5 | 501 字 | **PASS** 422 `SERVICE_NOTE_TOO_LONG` | 真 HTTP | 同上 |
| **6** | **500 字边界** | **NOT RUN** | — | 新 Visit 的 Token 被判无效（401），未覆盖 |
| **7** | **五种 `service_result`** | **NOT RUN** | — | 仅覆盖 `null` 成功与 `null` 拒绝 |
| 8 | `null` 结果仍要求维修措施 | **PASS**（第 1/3 例即 null 结果被拒） | 真 HTTP | 同上 |
| **9** | **未知枚举 `brand_new`** | **NOT RUN** | — | 同 #6 原因（Token 无效） |
| 10 | 绕过 H5 直接 POST | **PASS**（全部用 curl） | 真 HTTP | 同上 |
| 11 | 非法后 Visit/Ticket/Event 不变 | **PASS**（4 次 422 后 `ASSIGNED`/`PROCESSING`/events 0） | 真 HTTP + 库 | 同上 |
| 12 | 非法不消费一次性 Token | **PASS**（同一 Token 4 次 422 后未置 `token_used_at`） | 真 HTTP + 库 | 同上 |
| 13 | 合法提交后 Token 失效 | **PASS**（再提交 401 `TOKEN_INVALID`） | 真 HTTP | 同上 |
| **14** | **历史 `service_note=NULL` 只读** | **NOT RUN** | — | 未造数据 |

**通过 9 / 13；NOT RUN 4（#6 #7 #9 #14）。** 与"9/13"一致。

### C.2 P0-2 上一单记忆（10 项，真实浏览器 + 拦截模拟成功响应）

| # | 用例 | 结果 | 级别 |
|---|---|---|---|
| 1 | 两复选框默认勾选 | **PASS** | 真浏览器 |
| 2 | 不碰控件也自动保存（`svc.lastOrder.v1.S01`） | **PASS** | 真浏览器 + localStorage |
| 3 | 同店再进自动恢复 | **PASS** | 真浏览器 |
| **4** | **跨门店隔离** | **NOT RUN**（需第二个门店入口） | — |
| **5** | **7 天过期** | **NOT RUN**（需造过期记录） | — |
| 6 | 只关"自动进入"仍保留记录 | **PASS** | 真浏览器 |
| 7 | 清除后不恢复 | **PASS** | 真浏览器 |
| **8** | **localStorage 不可用仍可提交** | **NOT RUN** | — |
| 9 | 记录不含姓名/手机号明文 | **PASS**（8 个字段，`hasName=false`/`hasPhone=false`） | 真浏览器 + localStorage |
| 10 | 375/390/420 布局 | **PASS**（`docW == innerW`） | 真浏览器 + 截图 |

**通过 8 / 10；NOT RUN 3（#4 #5 #8）。**

> ⚠️ **P0-2 的通过边界**：路径是"真实报修表单 → 拦截 POST 返回**合成成功体** → 进入 Success 页"。
> 它证明的是**前端交互与本地记忆逻辑**，**不证明**生产服务端真实建单闭环。引用时必须带这句限定。

### C.3 代码侧核对（存在 ≠ 已验证）

| 关注点 | 代码事实 | 判定 |
|---|---|---|
| 500 字边界 | `constants.ts:253` `SERVICE_NOTE_MAX=500`；`:277` `text.length > 500` 才拒绝 | 逻辑上 500 应通过；**未实测** |
| 下限 5 字 | `:259` `SERVICE_NOTE_MIN_EFFECTIVE=5`；`:280` 用 `countEffectiveChars`（去空白后计数） | 与用例 3/4 一致（已验证） |
| 五种结果都必填 | `:204-211` 五个枚举值；`:245` `SERVICE_RESULT_NOTE_OPTIONAL = []` ⇒ `isServiceNoteRequired()` 恒真 | 规则成立；**五种各自提交未实测** |
| DTO 同步 | `actions/technician/visit.ts:306-312` 下发 `note_required: isServiceNoteRequired(value)` | 已实现 |
| 未知枚举 | `visit.ts:692` `!SERVICE_RESULT_VALUES.includes(...)` → `INVALID_SERVICE_RESULT` | 已实现；**未实测** |
| 历史 NULL 兼容 | `services/visit-service.ts:149` 类型为 `string \| null`；`assertText(..., 0, 500)` 允许空 | 写入侧兼容；**只读路径无显式 NULL 分支，未确认** |
| 跨店隔离（前端） | `h5/src/utils/last-order.ts:38` key = `svc.lastOrder.v1.<storeCode>` | 已实现；**未实测** |
| 7 天过期 | 同上 `:36` `7*24*60*60*1000`；`:78` 超期即删 | 已实现；**未实测** |
| localStorage 不可用 | 同上 `:41/:67/:91/:109` 全部 `try/catch`，失败即删记录 | 设计上不崩；**未实测** |

### C.4 额外发现（重要，非本轮任务但必须报）

`actions/technician/visit.ts`：**`await consumeQuota(...)`（:425）在 `parseSubmitDto()`（:427）之前**。

⇒ **非法输入（422）会消耗该 Token 的持久化限流配额**（60 次/小时）。
这是已裁决的现状（"暂不调整顺序，登记为现状"），**不属于缺陷**，但必须写进验收文档，
否则"反复试错测试"会把配额打光，然后被误判成"产品拒绝"。

---

## D. BE-04 状态裁定建议

### D.1 冲突来源：`PROJECT-STATUS.md` 单行拼接了 4 个时间点

`docs/PROJECT-STATUS.md` §1 第 41 行里同时存在四句互相矛盾的话（按时间排序）：

| 时间 | 出处 | 当时的结论 |
|---|---|---|
| 11:49 | `BE-04-DATE-SEMANTICS-REPORT.md` | 语义校准 12/12，**UI 组件未实施** |
| 12:07 | `BE-04-P1-REPORT.md` | `registerModels` 不覆盖同名类，**已回滚接线** |
| 12:39 | `BE-04-Q2-REPORT.md` | **日期 UI 已跑通**（第一、二关 PASS），**第三关未完成** |
| 15:26 | `BE-04-FINAL-UAT.md` | 六项条件满足，**申请整体 PASS/FROZEN** |

这四句被粘在同一格，**没有标注哪句是最终态** ⇒ 读者会看到"已申请 PASS"与"UI 组件未实现"并列。

### D.2 代码与产物事实（本轮实测，权重最高）

| 证据 | 内容 |
|---|---|
| 组件存在 | `client/date-range-item-model.tsx` **283 行**，导出 `BE04_DATE_MODEL_NAME='BE04DateRangeFilterItemModel'`（:22）与 `installDateRangeModel()`（:253） |
| **真被调用** | `client/index.ts:87` import + **`:105` `installDateRangeModel(this.app?.flowEngine)`** |
| 语义实现 | `:8` 注释与实现均用 `$dateNotBefore` + `$dateBefore`（规避 `$dateOn` 终点 +1s 缺陷） |
| 辅助模块 | `client/date-range.mjs` 95 行 |
| 本地产物 | `dist/client/index.js` 含 `BE04DateRangeFilterItemModel` **5 处** |
| **生产产物** | **同样 5 处**（`/opt/scqf-aftersales/.../client/index.js`，SHA `62677303c562a33d…`） |

⇒ **日期筛选组件不仅已实现，而且已经上线到生产。** "UI 组件未实现"这句**确定过期**。
`BE-04-U2-REPORT` 的"待裁决 P1（客户端覆盖 FilterFormItemModel）"同样过期 —— Q2 走的是**独立新模型**，不是覆盖。

### D.3 仍有真实缺口（不能据此宣布签收）

| 缺口 | 证据 |
|---|---|
| **第三关：重新 seed 后是否仍生效** | Q2 §4：「schema 已被我手工 `flowModels:update` 切到新模型，但**没有可复现的 post-seed 补丁** —— 重新 seed 会丢」；且 `flowModels` 里存在两条同名 `all.all-search.createdAt`（孤儿 grid） |
| 补丁脚本仍然严格失败 | `scripts/patch-be04-date-model.mjs:112-115`：多命中即 `createdAt-multiple` 返回失败，**没有放宽**（这是对的） |
| FINAL-UAT 的"Seed 可复现性不受破坏 ✅" | **只有结论，无独立证据段**；本轮只读核查无法复现（需跑 seed/patch，属禁止操作） |

### D.4 裁定建议（供负责人决策，我不宣布签收）

1. **"UI 组件未实现"应判为过期表述**，建议从 `PROJECT-STATUS` 该行删除，改为
   「组件已实现并于 client `62677303…` 上线（证据：产物 5 处标记 + `index.ts:105` 调用）」。
2. BE-04 状态建议改为 **`IN PROGRESS / 待签收（第三关待补证）`**，而不是同时写"不申请 PASS"与"已申请 PASS/FROZEN"。
3. 若要关闭第三关，最小取证是：清掉那条孤儿 grid（`k20m3m6n59x`）→ 重跑 seed → 跑 patch → 验证日期条仍在。
   这属于**写操作**，需单独授权。
4. 在第三关补证前，**不得对外称"BE-04 可重复部署"**。

---

## E. 构建门禁检查

### E.1 脚本存在性

| 脚本 | 大小 | 存在 |
|---|---|---|
| `scripts/prebuild-guard.mjs` | 3581 B | ✅ |
| `scripts/verify-ts-baseline.mjs` | 7841 B | ✅ |
| `scripts/verify-ts2741-baseline.mjs` | 8158 B | ✅ |
| `scripts/build-plugin.mjs` | 42160 B | ✅ |

### E.2 接线实测

`scripts/build-plugin.mjs` 主流程：

```
main() → preflight() → preflightMigrations() → preflightTypes()   (:815)
                                              → preflightTsBaseline() (:817)
```

| 门禁 | 定义 | 被调用 | 阻断语义 |
|---|---|---|---|
| `verify-types.mjs` | `preflightTypes()` :234 | ✅ :815 | 非 0 ⇒ `exit(1)`；`exit=2` 单独报"工具坏了"（:245-252）✅ |
| 全量诊断基线 | `preflightTsBaseline()` :308 | ✅ :817 | 非 0 ⇒ `exit(1)`；`exit=2` 单独报（:317-318）✅ |
| **TS2741 基线** | `preflightTs2741()` :281 | ❌ **从未被调用** | 定义完整但**死代码** |
| **prebuild-guard** | — | ❌ **构建链里没有引用** | 只能手动跑 |

`grep -n "preflightTs2741()" scripts/build-plugin.mjs` → **仅命中定义行 281**，无调用。

### E.3 缺口与风险

| # | 缺口 | 风险 | 严重度 |
|---|---|---|---|
| G-1 | **TS2741 门禁未接线** | 功能上被"全量基线"覆盖（注释 :816 已说明），**保护不缺**；但 `scripts/expected-ts2741.json` 的修改**不会产生任何效果** —— 下一个人会以为在维护一个活门禁 | 🟠 中（误导型） |
| G-2 | **全量基线脚本路径硬编码** | `build-plugin.mjs:269-271` 写死 `'C:/Users/Administrator/WorkBuddy/2026-09-20-15-28-58/scripts/...'`（绝对路径），**换机器/换目录/CI 必断**；而 TS2741 用的是 `__dirname`（:267，正确写法） | 🔴 高（可移植性） |
| G-3 | **prebuild-guard 未进构建链** | "工作区 vs `admin-base` 漂移"只能靠人记得手动跑。**本轮之前已实际发生**：我改 `constants.ts` 后 guard 报 `DIFF`，若当时直接构建就会得到"源码已改、产物没变"的假象 | 🟠 中 |

**判定：全量 TypeScript 新增诊断的阻断机制【已加入】构建链且语义正确（`exit(1)` 阻断 + `exit(2)` 区分工具故障）；但存在 G-1/G-2/G-3 三个接线级缺口。**

### E.4 本轮未做的事（按令）

未运行 `build-plugin.mjs`、未运行任何 `verify-*`、未重建产物、未重启容器 —— 以上结论全部来自**源码阅读 + 文件存在性 + 产物内标记检索**。

---

## F. 下一轮建议

> 遵循 DEV-EFFICIENCY-01：**合并修改、一次验证、不做全量回归**。

### F.1 优先级 1：门禁接线（改 1 个文件，约 10 行）

| 改动 | 文件 | 具体 |
|---|---|---|
| G-2 路径硬编码 → `__dirname` | `scripts/build-plugin.mjs:269-271` | 与 :267 同写法 |
| G-1 死代码处理 | 同上 :281 | 二选一：① 在 `main()` 里调用（保留独立门禁）；② 删除函数并在 :816 注释说明"TS2741 由全量基线覆盖"。**建议 ②**（少一次 tsc 全量扫描） |
| G-3 guard 入链 | 同上 `main()` 首步 | 在 `preflight()` 前加 `preflightGuard()`，调 `prebuild-guard.mjs`，非 0 则 `exit(1)` |

**验收方式**：故意制造一处新 TS 诊断 → 构建必须 `exit 1`；故意让 `constants.ts` 与 `admin-base` 不一致 → 构建必须 `exit 1`；还原后 `exit 0`。**只跑这 3 次构建，不跑全量回归。**

### F.2 优先级 2：P0 补测（7 项，一个脚本一次跑完）

| 缺口 | 补法 | 关键约束 |
|---|---|---|
| P0-1 #6 500 字 | 新 Visit + `INSERT … RETURNING id` 取 id | **不要**再用 `order by id desc limit 1`（上一轮就败在这） |
| P0-1 #7 五种结果 | 五种各一次独立 Visit + 独立 Token | 每种都断言 200 且 Visit/Ticket 状态正确 |
| P0-1 #9 未知枚举 | `brand_new` → 期望 422 `INVALID_SERVICE_RESULT` | 不改枚举白名单 |
| P0-1 #14 历史 NULL | 直接造一条 `service_note IS NULL` 的历史 Visit，用 GET 读 | 只读，不写 |
| P0-2 #4 跨店 | 拦截 `store-entry` 返回第二家门店 | 验证读不到第一家 key |
| P0-2 #5 7 天 | 把 `savedAt` 改 8 天前 | 验证被清除 |
| P0-2 #8 localStorage 异常 | CDP 注入 `Object.defineProperty(window,'localStorage',{get(){throw}})` | 验证仍能完成提交 |

**注意配额**：P0-1 的非法用例会消耗限流（§C.4），7 项合计控制在 **20 次请求内**，远离 60/h。

**验收产出**：13/13 + 10/10，每项带 HTTP 状态、业务码、库前后态或 DOM/localStorage 快照。

### F.3 优先级 3：BE-04 收敛（先文档，后补证）

1. **只改文档**（`PROJECT-STATUS` §1 第 41 行）：删除"UI 组件未实现""待裁决 P1（覆盖 FilterFormItemModel）"，改为 D.4 的表述。**不运行任何测试。**
2. 第三关补证需写操作（清孤儿 grid + seed + patch），**单独申请授权**后再做。

### F.4 本轮明确不建议做的

- 全量回归（117 个 verify 脚本）—— 代码未变，无信息增量。
- 重复浏览器验证 —— P0-2 已有 8/10 证据，只补 3 项。
- 任何 `git commit/push`、任何生产部署、任何容器重启。

---

## 附：本轮执行的只读命令清单

```
pwd / git rev-parse / git log -1 / git status --short / git diff --stat
git diff --numstat / git ls-files -v / git check-ignore
git status --short -- <file>（单文件定性）
stat（产物 mtime）/ find -newer（源码是否落后）
docker inspect / docker top / docker exec … stat（容器内 mtime）
docker ps --format
ssh 远端：grep 产物标记、sha256sum、docker ps（只读）
grep / sed / wc（源码与报告阅读）
```

**未执行**：任何测试脚本、任何构建、任何 `git` 写操作、任何容器重启、任何 SQL 写、任何短信发送、任何部署。
