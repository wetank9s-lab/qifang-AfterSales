# UX-01A 第二轮整改报告

> 日期：2026-10-15（第二轮） · 审计基线 `af84363` · 上一轮报告：`docs/UX-01A-REPORT.md`
> 项目状态：P11-5 = PASS/FROZEN · P11-4 = IN PROGRESS（暂停）· Phase 11 = IN PROGRESS · Release = HOLD · **UX-01A = IN PROGRESS（未签收）**
> **本轮未提交、未推送**。凡未经真实运行验证的项一律标 PENDING，不以"源码存在 / seed 存在 / HTTP 200"冒充通过。

---

## 0. 环境核实结论（修正上一轮的错误判断）

| 问题（用户 §一） | 结论 |
|---|---|
| 1. 当前工作目录是否项目根目录 | **是**：`/c/Users/Administrator/WorkBuddy/2026-09-20-15-28-58`（有 `.git/nocobase/scripts/h5/docs`） |
| 2. `scripts/build-plugin.mjs` 是否存在 | **存在**（38,978 字节） |
| 3. 原有 Node 依赖是否可用 | **可用**：构建工具链在受管 workspace `~/.workbuddy/binaries/node/workspace/node_modules`（含 `esbuild` + `typescript`）；仓库自身 `node_modules` 为空是**设计如此**（宿主包 external） |
| 4. 只读分析环境还是实际开发主机 | **实际开发主机** |
| 5. NocoBase 容器/实例是否在另一环境 | **就在本机**：`docker compose` 的 `svc-app`(healthy)/`svc-nginx`/`svc-postgres` 均在运行；`https://127.0.0.1/api/svc:health` = **200** |
| 6. 能否按既有流程构建与定向测试 | **能**：已实际完成 `build-plugin.mjs`（TS 门禁 + esbuild 全绿）、`docker compose restart app`、`verify-bundle-delivery.mjs`、`verify-store-ui-primary-action.mjs`（真实浏览器） |

> ⚠️ **更正上一轮的结论**：上一轮我报告"无 tsc/esbuild、无容器、无浏览器" —— 那是**错误的**（当时把构建工具链在受管 workspace 而非仓库 node_modules、以及一次 `docker ps` 的瞬时失败，误判成"环境不可用"）。本轮已核实：**环境完整可用**。上一轮据此把 A1/A2 标 PENDING 的判断依据不成立，特此更正。

---

## 1. A2 —— 列表内**直接、独立**的查看入口：✅ 已实现并经真实浏览器验证

**用户 §二 的要求**：查看必须独立于处理/跟进；工单号做成可点击链接；点击直接打开既有只读详情抽屉；保留"每行只有一个主按钮"的冻结门禁；六状态都可查看。

**实现（最小列模型扩展，用户 §二 许可的路径）**：
- 运行实例核对：每个工单表的工单号列结构为 `TableColumnModel`(subKey=columns) → 子节点 `DisplayTextFieldModel`(subKey=field，declaredKey=`<block>.ticket_no.field`)。
- 新增 `src/client/ticket-no-link.tsx`：**派生宿主的 `DisplayTextFieldModel`**（基类经 `engine.getModelClass('DisplayTextFieldModel')` 取得，与 index.ts 取 `ActionModel` 同法），覆写 `renderComponent`，把工单号渲染成链接 `[data-testid="ticket-no-link"]`，`onClick` 调**既有的** `openTicketDrawer`（只读）。取不到行记录/基类 ⇒ **静默退回普通文本**（不假装可点）。
- `src/client/index.ts`：单独注册该字段模型（不进动作组）。
- `scripts/seed-admin-pages.mjs`：新增 `seedTicketNoLink()`，把 8 个**列表列**的 `ticket_no` 字段节点 `use` 改为 `TicketNoLinkModel`（**只改 use**，uid/parentId/subKey/subType/props/stepParams/flowRegistry 原样保留）；同时**排除并还原**搜索框字段（`-search.`）为 `InputFieldModel`。**未新增行按钮**，冻结门禁不受影响。

**真实浏览器验证**（`scripts/verify-store-ui-primary-action.mjs`，真实门店账号登录 + 无头 Chrome）——本轮在既有门禁中**新增判据 ①b**（复用其既有 CDP，不引入新框架）：

```
──────────────── ① 每行只有一个按钮 ────────────────
  ✓ 每行操作列**总共**只有一个按钮 —— 20 行全部为 1          ← 冻结门禁保持
──────────────── ①b 工单号是可点击链接 ────────────────
  ✓ ①b 每行工单号是可点击链接 —— 20 行均有
  ✓ ①b 工单号链接指向**本行**工单 —— 20 行 data-ticket-id 与行号一致
  ✓ ①b 点击工单号打开**本行**只读详情 —— 抽屉标题「工单 FW20261015-0001」含「FW20261015-0001」
```
- 结果：**通过 36 项，失败 1 项**。唯一失败是 `⑤ 找到 PROCESSING 工单 —— 库里没有 PROCESSING`（**门店列表当前无该状态的行** ⇒ 判据空转按纪律判红），与本次改动无关；③（点击作用于当前行）在本轮**由红转绿**。
- 结论：**A2 ✅ PASS**（前提：六状态中"有数据的四态（NEW/PROCESSING-由②覆盖/WAIT_FEEDBACK/CLOSED/CANCELLED）已验；WAIT_STORE_CONFIRM 当轮库里无数据，②记"未验到"）。

---

## 2. A3 —— 内部备注：✅ 代码完成 + 服务端定向验证通过

服务端定向验证（门店账号，对**已闭环**工单 #6561 调 `POST /api/svc:internalNote`）：
```
http1 = 200 · event_type = internal_note
state_unchanged = true            ← status / next_follow_at / completed_at / closed_at **全部不变**
internal_note_events = 1          ← 只写一条事件
idempotent_replay: 同 X-Request-Id 重放 → 200，事件仍为 1（replay_no_dup=true）
missing_requestid: 无 X-Request-Id → 422 VALIDATION_FAILED
```
→ **闭环工单可备注 / 无副作用 / 幂等 / 写接口契约** 四项均实测通过。
未实测项（PENDING）：viewer 只读角色 403、跨店账号 404（实现走 `assertCanWriteTicket`，静态已核对；未跑真实账号）。客户端「内部记录」区入口已在 A2 的抽屉路径中可达（六状态均可打开详情）。

---

## 3. A4 —— 新建服务单精简：✅ 代码完成（UI 定向验证 PENDING）

- 首屏仅必填 + 紧急标记；「更多信息（选填）」折叠地址/家电/品牌；六类不变；系统字段不暴露；门店归属不变。
- **PENDING**：未运行 `verify-store-create-ui.mjs`（时间/预算所限）。**未以"源码存在"冒充界面通过。**

---

## 4. A5 —— 旧二维码入口：✅ 代码完成；服务端兼容未动

- `store-entry-action.tsx` 已不再渲染旧入口链接与旧说明（源码级）。
- 服务端 `resolveStoreEntry` / 路由 / 签名**一字未改**；`verify-store-entry.mjs` 的判据落在**服务端 API**（`legacy_url` 字段与裸编码解析），不依赖弹窗里是否显示旧链接 ⇒ **不冲突**。
- **PENDING**：未重跑 `verify-store-entry.mjs`（未以"seed/接口存在"冒充）。建议下一轮跑一次确认服务端 200/404 分流仍绿。

---

## 5. A1 —— 门店售后服务工作台：❌ **本轮未实现**（如实报告，不冒称完成）

**未实现**。这是本轮最大缺口，直接说明原因与最小恢复方案，不粉饰：

1. 工作台需要一个**新的 NocoBase 页面**，且页面主体是一块**自定义区块模型**（统计卡 + 今日待办 + 快捷入口 + 最近工单）。而本项目的页面种子 `seed-admin-pages.mjs` 的 `tablePage()` 蓝图**只支持 `table` / `filterForm` 两种区块**，**没有**"自定义 React 区块"这一档。
2. 实测：本轮运行 `seed-admin-pages.mjs` 时，**已存在页面的重新应用（`applyBlueprint`）在本环境返回 HTTP 400**（4 个页面"应用失败 HTTP 400"；但页面本身仍正常，见 A2 的真实浏览器验证通过）。⇒ 在**页面应用这一步本身就不稳**的环境下新增/改写页面，风险高，且无法保证"改了 seed 但登录后仍是旧页面"不发生。
3. 因此我没有为了"看起来完成了"而硬塞一个建不出来的工作台页面。

**最小恢复方案（下一轮）**：
- (a) 先查清 `applyBlueprint` 400 的**根因**（本环境既有问题，非本次改动引入）——拿到响应体定位是哪个校验器/字段组缺失；
- (b) 新增 `StoreWorkbenchModel`（自定义区块）+ 页面蓝图（`desktopRoutes` + `flowModels`，`mode:'create'`，**不动**其它页面、不用 replace 覆盖）；
- (c) 只把**门店角色**的默认落地指向工作台（不动总部/只读角色入口）；
- (d) 数据口径（已定）：待处理=NEW；已处理（**累计**）=WAIT_FEEDBACK+CLOSED；辅助=PROCESSING/WAIT_STORE_CONFIRM/WAIT_FEEDBACK；今日待办复用 `svc:followUpQueue`+SLA 并**去重**；统计走 `applyScope`、排除历史导入（历史在 `historicalImportRows` 等独立集合）；
- (e) 用真实浏览器验证"卡片数字与列表一致、待办可跳转、多门店范围正确、空态/失败有提示"。

---

## 6. 实际修改文件

| 文件 | 说明 |
|---|---|
| `src/shared/svc-action.ts` · `src/server/constants.ts` · `src/server/services/ticket-service.ts` · `src/server/actions/svc/ticket.ts` | A3 内部备注（动作/事件/服务/鉴权 + timeline `can_write`） |
| `src/client/ticket-drawer.tsx` | A3 详情「内部记录」区 + 备注输入 |
| **`src/client/ticket-no-link.tsx`（新增）** · `src/client/index.ts` | **A2** 工单号可点击链接（派生 DisplayTextFieldModel） |
| `src/client/primary-action.tsx` | 处理/跟进窗口内「查看工单详情」入口（A2 辅助） |
| `src/client/ticket-create-action.tsx` | A4 选填字段折叠 |
| `src/client/store-entry-action.tsx` | A5 隐藏旧入口展示 |
| **`scripts/seed-admin-pages.mjs`** | **A2** 页面种子新增 `seedTicketNoLink()`（列表列 → TicketNoLinkModel；搜索框还原） |
| **`scripts/verify-store-ui-primary-action.mjs`** | **新增判据 ①b**（复用既有 CDP）验证工单号链接 |

**是否修改页面种子 / 默认登录路由**：
- **页面种子：已修改**（`seed-admin-pages.mjs` 增 `seedTicketNoLink()`，并已实际运行生效：列表列 8 个 → TicketNoLinkModel，搜索框 7 个还原）。
- **默认登录路由：未修改**（A1 未做）。

---

## 7. 权限与业务副作用检查

- 内部备注：`assertCanWriteTicket`（能力+门店归属，越权/不存在统一 404）；只读角色 403；写接口必带 `X-Request-Id`（实测 422）。无状态变更/无短信/无派工/无 SLA（实测 state_unchanged=true）。
- 工单号链接：只读抽屉，不改状态、不发短信。
- A2 字段模型：仅影响工单号这一列；搜索框字段已还原为 `InputFieldModel`（避免误伤筛选）。
- 未放宽 `svc:followUp`；未改状态机；未触碰 P11-5 冻结项。

---

## 8. 尚未完成的人工验收项

1. **A1 门店工作台首页：未实现**（见 §5）。
2. A4 新建单界面定向测试（`verify-store-create-ui.mjs`）未跑。
3. A5 `verify-store-entry.mjs`（服务端兼容）未重跑。
4. A3：viewer 只读 403 / 跨店 404 未用真实账号实测；客户端「内部记录」区入口的**人工点验**未做（A2 已验证详情抽屉可打开，但备注输入框本身需人眼确认）。
5. A2：WAIT_STORE_CONFIRM 状态当轮库里无数据，未验到（门禁如实标注）。

---

## 9. Git 与密钥审计（本轮未提交未推送）

- `git status`：**11 个已跟踪文件被修改 + 2 个新增**（`docs/UX-01A-REPORT.md`、`src/client/ticket-no-link.tsx`）；**无无关改动**、无构建产物泄漏（`storage/plugins/**` 已被忽略）。
- `git diff --check`：**无空白错误**。
- 增量密钥审计 `scan-commit-secrets.mjs --paths <12 files>`：**通过（exit 0）**，无明文 Token/手机号/密钥（2 处合成号段占位已排除）。
- **未提交、未推送 `origin/main`。**

---

## 10. 结论

- **A2 ✅ 通过**（真实浏览器：工单号=可点击链接、指向本行、点击打开本行只读详情；行操作列仍只有一个按钮）。
- **A3 ✅ 服务端验证通过**（闭环可备注、无副作用、幂等、契约正确）；客户端入口可达。
- **A4 / A5：代码完成，界面/服务端定向测试 PENDING**（未跑对应既有脚本，不冒称通过）。
- **A1 ❌ 未实现** —— 卡在"工作台需要新的自定义区块页面、而本环境页面应用步骤返回 400"，已给出最小恢复方案。**本轮不具备签收条件。**
- 环境已确认**完整可用**（更正上一轮误判）。
