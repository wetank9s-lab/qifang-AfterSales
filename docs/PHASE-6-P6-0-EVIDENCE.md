# P6-0 交付证据（Store Review Read Model & Photo Access Gate）

> **状态：🟢 PASS —— 阶段已关闭（2026-09-25，用户正式接受）**
> —— §5 冻结验收矩阵 11 条**全部 PASS**：10 条机器可证（正向 **24/24** + 反向 **9/9**），
> 第 11 条 **U1 人眼项**已**实际执行一次并通过**（逐条实测 + 取证边界见 §④）。
>
> **功能交付基线 commit = `0d45b09`**（用户 2026-09-25 裁定：「`0d45b09` 可以作为 P6-0 功能交付基线」）。
> 本文件的状态改动属**关闭记录**，落在一个**文档-only** 的后续提交里 —— **不改动任何已通过的读取实现**。
>
> 上游基线：Phase 5 关闭 `4ccfaa8`；Phase 6 计划/契约定稿 `83f7831`（`docs/PHASE-6.md`）。
>
> 范围：**只做读** —— I11 门店回执读模型 + I14 私有照片受控读取（**无签名 URL**）+
> 一个**很薄的只读 UI**（§6.3，内联进 H3 详情抽屉）。
>
> **到 `WAIT_STORE_CONFIRM` 为止**：门店确认/驳回（M9/M10）、评价 Token、`CLOSED` **均未实现**
> （停止线核验见 §⑦；**关闭后仍成立** —— P6-1 已开工，但**先动的是契约不是代码**）。
> ⚠️ **批注（2026-09-26）**：上句的「P6-1 已开工但仍只动契约」是 **P6-0 关闭时**的实况；
> 其后 **P6-1（`c593bcd`）与 P6-2（`3ff8936`）已交付，Phase 6 整体 🟢 PASS**（见 `docs/PHASE-6.md` §14）。
> 本句的**历史原貌保留不改**；**P6-0 自身"只做读"的边界始终成立**。
>
> 取证环境：`svc-app` healthy · `svc-nginx` healthy · `svc-postgres` healthy · 本机 nginx 端口 **8080** ·
> 客户端产物构建标记 **`2026-09-25T08:09:57Z`**。

---

## ⓪ 新发现分诊（沿用 2026-09-25 定的三类规则）

> 规则：**A 影响匿名闭环/安全边界/数据一致性 → 本阶段必须修**；
> **B 只是后台 UX/运维/工具链 → 进 backlog**；**C 门店确认/评价/关闭 → 留给后续 Phase**。

### A 类 —— 已在本阶段修掉（带机器门）

| 编号 | 一句话 | 为什么必须本阶段修 |
|---|---|---|
| **DEV-83** | **"照片表不在原生白名单 ⇒ 不可读"不成立**：门店角色 `GET /api/serviceVisitPhotos:list` → **200**，整行下发 `storage_key` / `upload_ip_hash` / `file_id`（P6-0 的 N1 抓到） | **安全边界**：§5 的 N1 就是钉这一条；且 `storage_key` 属`docs/SECURITY.md` 明文禁止外泄的存储实现信息 |
| （可观测性） | `actions/svc/_http.ts` 的 5xx 分支只打 `error.stack`，而 sequelize `formatError` 用**空 Error 的 stack** 覆盖真实 stack ⇒ **DB 报错正文丢失** | 排 N1 时"日志里看不到 PG 原文"就是它造成的；修完日志里才有 `p51 reverse test: forced ticket update failure` 这类可核对正文 |

修法：
- DEV-83 → `middleware/store-scope.ts` 新增 **`NATIVE_FORBIDDEN_RESOURCES` 整资源封禁**
  （命中资源**任何**原生 action 一律 `403 NATIVE_RESOURCE_FORBIDDEN`，且**优先于**"非受管资源直接放行"分支）
  + `plugin.ts` 两条**启动断言**（同资源不得同时白名单+封禁；`serviceVisitPhotos` 必须在封禁表里）。
  完整根因见 `docs/DEVIATIONS.md` **DEV-83**。
- 可观测性 → 5xx 分支改为优先输出 `error.message` / `error.parent.message`，再附 stack。

### B 类 —— 进 backlog（不阻塞），见 `docs/BACKLOG.md`

| 编号 | 一句话 | 性质 |
|---|---|---|
| **B-8** | 业务角色可**原生读取** NocoBase 核心集合（`users` 含 email/phone、`roles`、`stores`、`collections`）—— 与 DEV-83 **同根因**（ACL 资源级缺失回退到忽略资源名的角色 strategy） | **安全边界**，但范围是**框架核心集合**且自 Phase 2 起即如此；修它会连带影响后台 UI 既有读取 ⇒ 需独立 mini-phase + 后台走查 |
| **B-9** | 多脚本**串跑**时，嵌套 `build-plugin.mjs` 被沙箱批量删除守卫拦下 → 级联假红（构建失败 ⇒ 产物比源码旧 ⇒ `verify-config` 红 ⇒ 依赖它的脚本 `rc=2`） | 工具链（**不影响产品**） |
| **B-10** | `verify-technician-upload` 的 **B10** 偶发一次 `fetch failed`（未复现：单独跑 20/20、按原顺序配对跑也 20/20） | 环境抖动 |
| **B-11** | NocoBase **核心**把"登录会话过期"的 401 记成 **error** 级 ⇒ S1 反向验证会污染 `smoke-test` 的日志闸 | 测试工具污染（已加窄成对豁免 + 分类器自检） |

### C 类 —— 留给后续 Phase（本阶段**不得**提前实现）

门店确认/驳回（M9/M10）· 评价 Token / 评价页 / 评价短信 · `CLOSED` 写路径。
✅ **已复核：`actions/` 目录下 `CONFIRMED` / `REJECTED` 命中数为 0**（详见 §⑦ 停止线）。

---

## ① 四边界矩阵（B 组）—— 正向 24/24

`node scripts/verify-store-photo-access.mjs`（真实 HTTP + 真实角色矩阵，自建两条一次性夹具单）

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| **B1** | 本店授权用户读**本店**照片 | 200 `image/*` | ✅ `photo#209 · image/jpeg · 86857B` |
| B1b | 响应头为私有内容口径 | `nosniff` / `no-store` / `inline` | ✅ `nosniff, nosniff · private, no-store · inline` |
| **B2** | HQ 授权用户读照片 | 200 | ✅ `HQ → 200 image/jpeg` |
| B2b | 本店用户读**第二张**照片也 200 | 200 | ✅ `photo#210 → 200`（不是"只放了第一张"） |
| **B3** | 跨店用户读**已知合法** `photoId` | 404 | ✅ `404 PHOTO_NOT_FOUND` |
| **B4** | 跨店用户读**不存在**的 `photoId` | 与 B3 **不可区分** | ✅ 同状态码 **+ 同响应体逐字节一致**（防存在性泄露） |
| B4b | 畸形 `photoId` 与不存在/越权**不可区分** | 同一出口 | ✅ `404 同形` |
| **B5** | 匿名读照片 | 401 | ✅ `401 EMPTY_TOKEN ×2`（两条路径都测） |

## ② N1 —— 原生 collection API 必须不可读

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| **N1** | 业务角色 `GET /api/serviceVisitPhotos:list` | 不可读 | ✅ `403 NATIVE_RESOURCE_FORBIDDEN` |
| N1 | 业务角色 `GET /api/serviceVisitPhotos:get` | 不可读 | ✅ `403 NATIVE_RESOURCE_FORBIDDEN` |
| N1-HQ | HQ 角色同样不可读（**整资源封禁，含总部**） | 403 | ✅ `403` |
| N1-回归 | **受管资源仍可读**（封禁没有误伤） | 200 | ✅ `serviceTickets:list → 200` |

> ⚠️ 这一组是**先红后修**的：修之前业务角色拿到 **200 + `storage_key`**（DEV-83）。
> 反向门的 `R-N1`（断言"业务角色可读 200"）**必须变红** —— 已实测变红，证明封禁真的生效（不是"看起来封了"）。

## ③ 反向与边界（R / S / O 组）

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| **R1** | 畸形 / 伪造 `photoId` | 安全失败（404/400，**不得 500**） | ✅ 非数字/注入/负数/零/超长/小数点 → **全 404** |
| **R2** | 成功响应 / I11 读模型**不泄露**存储实现字段 | 无 | ✅ `storage_key` / `upload_ip_hash` / `file_id` / `access_token_hash` **均未出现** |
| **S1** | **登录会话失效后**重新取图 | 401 | ✅ 登出前 200 → 登出后 **401**（照片与读模型**一致**） |
| **O1** | 本店用户读本店**历史 Visit**（`SUPERSEDED`）照片 | 200 | ✅ `历史 photo#211 → 200` |
| O1b | 历史 Visit 的**读模型**也 200 | 200 | ✅ `读模型 200 · status=SUPERSEDED` |
| O1c | 但**跨店**读这条历史 Visit 照片仍 404 | 404 | ✅ `404`（越店不因历史而放开） |

**I11 读模型配套断言**：`I11-a` 200 + `visit/photos` · `I11-b` **14 列全部在白名单内**（逐字段列举）·
`I11-c` 跨店 404 与不存在 404 **响应体一致** · `I11-d` 匿名 401。

## ④ U1 —— 门店只读 UI（机器层 + 人眼层）

**机器层（已绿）**

| # | 断言 | 实测 |
|---|---|---|
| U1-a | 读模型含 UI 需要的**全部**字段（缺一项 UI 就显示空白） | ✅ **8 项齐备** |
| U1-b | 只读视图**已内联进 H3 抽屉**，且**无任何写入口**（源码口径） | ✅ H3 内联渲染 + 无表单/无写动作 + blob 取图并释放 |
| R-U1b | 反向：断言"区块里**存在**写入口（`onOk=`）"必须变红 | ✅ 已按预期变红（证明 U1-b 不是恒绿） |

**人眼层（✅ 2026-09-25 已执行一次并通过）**

U1 原文是**人眼验证**（`docs/PHASE-6.md` §5 / §6.3），**机器不能代替**。

**执行结果**：以门店 A（`uat.store.a@svc.local`）在**真实 Chromium** 中实际登录 →
实际点开 **3 张** `WAIT_STORE_CONFIRM` + `SUBMITTED` 工单的行内「详情」→ 抽屉真实渲染。

| 判据（U1 原文四项） | 实测 |
|---|---|
| ① 明显看得到「技师回执」 | ✅ 3/3 命中（区块出现在「当前服务」与「处理记录」**之间**） |
| ② 结果 / 说明 / 收费·报费金额 / **真图非裂图** | ✅ 服务结果=已解决（中文）· 说明=`（未填写）`/32 字/`ok` 三种形态都渲染正确 · 是否收费=是→`¥128.50`、否→`不收费` · **DOM 内 `blob:` 图 `naturalWidth>0`（1/1/2 张，全解码）** |
| ③ 能理解"技师已提交、等待门店审核" | ✅ 区块标题「第 1 次上门回执 · 待门店确认」+ 页脚「本区块仅用于查看技师回执与照片（只读）。确认 / 驳回将在下一阶段开放。」 |
| ④ **绝对没有**确认·驳回·金额输入 | ✅ 抽屉 `innerText` 全文无任何写入口（源码口径见上方 U1-b / §⑦） |

**取证边界（不美化）**：本次走查是**真实 Chromium**（headless 模式）实际渲染，共留 **9 张分段截图**；
但**截图像素本身未被回读**（当前会话的模型对图片输入做了过滤）⇒ 「照片不是裂图」这一条的依据是
**DOM 内 `blob:` `<img>` 的 `naturalWidth > 0`**（**裂图的该值必然为 0**，这是比"看一眼"更硬的判据），
外加 `uat-preflight` §3.7 第③层同路径的独立证据，**而不是**"我把照片内容逐张看过"。
逐条实测、反例对照与归档位置见 **`docs/PHASE-6-P6-0-UAT-SHEET.md` §二 / §六**。

> ⚠️ 本阶段**没有**像 P5-1 那样的专用浏览器走查脚本：机器侧已由
> `uat-preflight` §3.7 第 ③ 层覆盖（见 §⑤），人眼项只要求"看一眼真图"。

## ⑤ 真实浏览器闸门 —— §3.7 第 ③ 层（P6-0 新增，本轮实测绿）

`node scripts/uat-preflight.mjs` 无头 Chromium **真实点开**行内「详情」，三个账号各一次：

```
✅ UAT-A  「我的门店工单」详情达标：行内「详情」→ svc:timeline 200 / svc:visits 200
         → 三区块齐全（客户与问题 / 当前服务 / 处理记录）
         · 「技师回执」区块 ✓ 照片 1/1 张已解码（I11 200 / I14 1 次）
✅ UAT-B  「我的门店工单」详情达标：… · 该行无「技师回执」区块（非待门店确认）
✅ UAT-HQ 「全量工单」详情达标：    … · 「技师回执」区块 ✓ 照片 1/1 张已解码（I11 200 / I14 1 次）
```

**为什么必须有这一层**：`blob:` 取图（axios `responseType` → `createObjectURL`）是本项目**第一次**出现的链路，
静态审查与接口断言都够不着它；只有真实渲染能兜住 —— 而这正是 DEV-72 那类"文字在、链路断"的假绿高发区。
判据是**最终结果**：DOM 里存在 `blob:` 图，且至少一张 `naturalWidth > 0`（真的解码成功），
外加 I11/I14 的实际状态码（避免"零照片"与"没渲染"混为一谈）。

---

## ⑥ 本轮发现的**假红**与工具问题（如实记录，含我自己造的）

### ⑥.1 `uat-preflight` §3.7 的**假红**：网络采集只认 `svc:` 冒号式（已修）
- **症状**：§3.7 报 `有「技师回执」区块却**没有发出 svc/visits/:id 请求**`（UAT-A / UAT-HQ 各一条）。
- **反证**：`docker logs svc-nginx` 里明明有 `GET /api/svc/visits/552 → 200` 与 `GET /api/svc/photos/111 → 200`。
- **根因**：采集器的 CDP `Network.responseReceived` 只 `if (u.indexOf('svc:') !== -1)` 才收录，
  而 P6-0 的 I11/I14 是 **`svc/visits/:id` / `svc/photos/:id` 斜杠式** ⇒ 一条都没收 ⇒ 新判据误报。
- **修法**：抽 `isBizUrl(u)`，**两套形态都收**。
  ⚠️ 这段代码位于 `renderProbe` 的**嵌套模板字符串内部**：不能写反引号、不能写 `\/` 转义
  （模板会把 `\/` 解码成 `/` 从而把正则变成注释）⇒ 只用 `indexOf` 组合。
- **反向验证**：临时还原成旧写法 ⇒ §3.7 **准确变红**（恰好报"没有发出 svc/visits/:id 请求"，
  且捕获列表里只剩两条 `svc:` 请求）⇒ 证明该修复是**承重**的、闸门**不是恒绿**。

### ⑥.2 `verify-detail-gate-reverse` 的**恒红**（还原检查写错判据）—— 既有问题，本轮修掉
- **症状**：`还原后产物里 /api/svc: 出现次数：2（应为 0）`。
- **根因**：它数的是 client bundle 里 `/api/svc:` 的字面出现次数，而 **esbuild 保留注释**，
  `server/constants.ts` 的注释里就有 `/api/svc:visitDetail?...` ⇒ 恒 ≥2 ⇒ **还原检查永远红**。
- **修法**：改为按**代码形态**匹配 —— 正向对照 `timelineUrl = \`svc:timeline?filterByTk=`（必须存在，否则假绿），
  缺陷形态 `timelineUrl = \`/api/svc:timeline?filterByTk=`（必须为 0）。
- **验证**：修后反向成立（缺陷态红、还原态绿）。

### ⑥.3 `smoke-test` 的**假红**：S1 的 error 级日志（已加窄成对豁免，见 B-11）
- **症状**：`app 日志中无 error 级别输出` → 发现 **2 条**，均为 `Your session has expired…`。
- **根因**：`verify-store-photo-access` 的 **S1**（会话失效 → 401）由核心 `BasicAuth.checkToken` 抛异常，
  被全局错误处理器按 **error** 级记录（`module=svc`，`submodule=photo` / `visitDetail`）。
  401 **是 S1 期望的正确行为** ⇒ 属**测试工具污染**，不是 P6-0 的噪声。
- **修法**：`smoke-test` 第三条豁免 —— 口径**窄且成对**：`message` 精确匹配 + `module==='svc'` +
  `submodule ∈ {photo, visitDetail}`，且**两个端点各至少一条**才认领，每种端点**封顶 2 条**。
- **反向验证（两步）**：
  ① 切断接线（`s1Claimed` 置空）⇒ `smoke-test` 恰因那 **2 条**日志变红（而分类器自检仍绿）⇒ 接线是承重的；
  ② 端点清单收窄成只认 `photo` ⇒ **分类器自检立刻红**（`只有 photo 一条时不得认领：期望 0，实际 1`）。
- 另配**分类器自检**（`S1 豁免分类器自检`，随每次 smoke 运行）：单端点不放行 / 成对认领 2 /
  超封顶只认 2 / 无关与异模块不放行 ⇒ 防"豁免写错成恒不生效"，也钉住框架字段语义变化。

> 共同教训（与 `verification-false-green-hunting` 一致）：
> **判据口径必须覆盖被测链路的全部形态**；**"工具坏了"与"产品坏了"必须先分开再下结论**；
> **每一处豁免都要能被反向证伪**。

---

## ⑦ 停止线：P6-0 **不含写操作**（可复核）

> ⚠️ **批注（2026-09-26 · Phase 6 closure sweep）**：下面两条 `grep` 的「0 命中」结论
> **只在 P6-0 基线 `0d45b09` 上成立**。P6-1 落地后新增了 `actions/svc/store-review.ts`
> （`visitConfirm` / `visitReject` handler）与 `actions/svc/_http.ts` 的映射 ⇒ **现在再跑会命中**，
> **这属于正常的阶段推进、不是 P6-0 边界被破坏**。本节的**历史结论保留不改**；
> Phase 6 现已整体 🟢 PASS（见 `docs/PHASE-6.md` §14）。

```bash
grep -rn "CONFIRMED\|REJECTED" nocobase/plugins/service-ticket/src/server/actions/
# → 0 命中（actions 层没有任何 confirm/reject 写路径）
grep -rn "confirmStore\|rejectStore" nocobase/plugins/service-ticket/src/  # → 0 命中
```

`CONFIRMED` / `REJECTED` 仅出现在 **声明处**（`constants.ts` 的枚举与允许转移表、`collections/*` 的选项定义）
—— 与 Phase 5 关闭时的口径一致：**声明先行、写路径按阶段推进**。
`actions/svc/visit-review.ts` 的两个 handler 均为**读**（`visitDetail` 取读模型、`photo` 流式返回字节）。

---

## ⑧ 机器门计数（2026-09-25 复跑，全部退出码 0）

| 门禁 | 结果 |
|---|---|
| `verify-config` | **56** 项 |
| `verify-plugin-load` | **61** 项 |
| `verify-ticket-actions` | **10** 项 |
| `verify-technician-h5-selftest` | **15** 条 |
| `verify-technician-h5` | **35** 项（含 fixture 自检 15） |
| `verify-technician-routing` / `‑reverse` | **11** 项 / **8/8** 反例 |
| `verify-technician-upload` | **20** 项 |
| `verify-technician-submit` | **19** 项（含 R1 事务回滚反向） |
| `verify-technician-token-matrix` | **12** 项 |
| `verify-phase3-h5` | **35** 项 |
| `verify-technician-h5-mutation` | **8/8** 被抓住 |
| `verify-reassign-contract` | **11** 项 |
| `verify-delivery-gate-reverse` | ✅ |
| `verify-detail-gate-reverse` | ✅ 反向成立（本轮修掉恒红，见 ⑥.2） |
| `verify-client-logic` | **53** 项（本轮 50 → 53：新增 `submittedVisitOf` 与回执区块契约） |
| `verify-store-photo-access` | **24/24** 正向 · **9/9** 反向 |
| `smoke-test` | **118** 项（本轮 117 → 118：新增 S1 豁免分类器自检） |
| `verify-bundle-delivery` | ✅ |
| `uat-preflight` | 🟡 20 项就绪 · **§3.7 / §3.8 全绿** |

---

## ⑨ 结论与剩余

- **P6-0 全部冻结判据（11/11）PASS** —— 10 条机器门（**含全部反向门**）+ **1 条 U1 人眼项**（已执行一次并通过）。
- **阶段状态：🟢 PASS · 已关闭（2026-09-25，用户正式接受）**；**功能交付基线 = `0d45b09`**。
- **关闭时的诚实口径**：
  - U1 是**真实浏览器实际执行一次**（3 张工单），**不是**由外部售后人员做的事，也不是"看了一遍照片像素"——
    见 §④ 的取证边界；该结论**按用户 2026-09-25 的裁定即可关闭**，**不重跑第二轮真人 UAT**。
  - 关闭**未修改任何已通过的读取实现** —— `0d45b09` 的代码即最终读实现；本文件的改动是**文档-only**。
- **下一阶段入口**：**P6-1 · Store Confirm / Reject Transaction**，契约先行 →
  `docs/PHASE-6-P6-1-CONTRACT.md`（本节关闭后即可引用）。
- 未在本轮修（已登记 backlog，**不阻塞** P6-0）：**B-8**（框架核心集合的原生读）、**B-9/B-10/B-11**（工具链）。

---

## ⑩ 补充记录（**P6-0 关闭之后**新发现）：DEV-84 手机实拍照片方向缺陷

> §⑨ 的结论**不变**（P6-0 🟢 PASS、已关闭、基线 `0d45b09`）。本节记录的是**关闭之后**由"真实照片走查"
> 抓到的、与 P6-0 的读实现无关的一个**上传侧**缺陷，按用户裁定做**定向修复 + 定向复测**。

| 项 | 内容 |
|---|---|
| 发现时机 | P6-0 关闭（2026-09-25）**之后**，用**真实手机照片**走查"门店只读 UI 看得到照片"时发现 —— 属于 §④ 取证边界里**明确声明未覆盖**的那部分（"不是看了一遍照片像素"）。**U1 的既有结论仍成立，不因此重开。** |
| 现象 | 手机实拍照片**本机看着正常**，上传后统一/部分**向右旋**；不同照片旋转程度不同（90° / 180° 混着），是"EXIF Orientation 值不同"的典型指纹。 |
| 根因 | Phase 5 的 EXIF 清理**只删标签、没转像素**。手机 JPEG 像素本身常**不是**视觉正向，朝向靠 EXIF `Orientation(0x0112)` 表达；标签被剥掉而像素未旋转 ⇒ 解码方不再旋转 ⇒ 从"靠标签的正确的歪"变成"错误的歪"。 |
| 修复 | 服务端上传管线新增 **ⓔ 按 EXIF Orientation 归一化像素**（先读朝向 → 转像素 → 再清元数据 → 重新编码 → 私有存储）。采用 **strip-then-decode** 顺序（避免 `@napi-rs/canvas` 对 JPEG/WebP 自动套 EXIF 造成双旋、对 PNG 不套造成漏旋）。能力缺失时 **fail-closed**：`503 PHOTO_ORIENTATION_UNAVAILABLE`，**拒绝上传**而不是存一张歪图。 |
| 证据 | `docs/DEVIATIONS.md` **DEV-84**（全文）；`scripts/verify-technician-upload.mjs` 新增 **A4a/A4b/A4c（离线）+ B11a/B11b/B11c（在线）** 六组，**26/26**。 |
| 范围纪律 | **不批量改历史照片**（`FW20260925-0055` 的存量错向照片仅作问题证据）；**不重开整个 P6-0 UAT**；**暂不启动 P6-1**，先把 DEV-84 收掉。 |
| **裁决（用户 2026-09-25）** | 🟢 **PASS · 已接受**：`7ebae5c` = **P6-0 关闭后的图片方向补丁基线**；**P6-0 结论仍为 PASS、不重开 UAT**；历史照片不批量重写维持原决定。**「暂不启动 P6-1」停止线解除** ⇒ §⑨ 的 P6-0 结论**不受影响**，下一阶段入口正式打开：**P6-1 · 契约定稿**（§11 七项逐项拍板后才写实现）。 |
| 对 P6-0 读实现的影响 | **无**。`0d45b09` 的 I11 / I14 读取代码**一行未改**；`verify-store-photo-access` 复跑仍 **24/24 正向 · 9/9 反向**。 |
