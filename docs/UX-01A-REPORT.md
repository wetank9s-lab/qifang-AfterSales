# UX-01A · 门店售后服务工作台及核心操作体验整改 —— 开发与验收报告

> 日期：2026-10-15 · 审计基线：`af84363` · 本轮授权范围：**仅 UX-01A**
> 项目状态：P11-5 = PASS / FROZEN · P11-4 = IN PROGRESS（暂停）· Phase 11 = IN PROGRESS · Release = HOLD · **UX-01A = IN PROGRESS**
> 本轮**未提交、未推送**（按 §十二.3，等用户决定）。
> ⚠️ 本报告**不宣布 UX-01A PASS**；凡未能在真实运行环境验证的项一律标 **PENDING**，不以"源码存在/接口 200"冒充 UI 验收。

---

## 1. 结论摘要（先看这个）

| 任务 | 状态 | 说明 |
|---|---|---|
| **A3 统一内部备注** | ✅ 代码完成 | 服务端（事件白名单 + 服务方法 + action + 鉴权）+ 客户端（详情「内部记录」区 + 备注输入）全部落地 |
| **A4 人工新建服务单精简** | ✅ 代码完成 | 选填字段折叠进「更多信息」；六类/紧急标记/门店归属/系统字段保护**不变** |
| **A5 隐藏旧二维码入口** | ✅ 代码完成 | 门店后台不再展示旧入口链接与旧入口说明；服务端 `resolveStoreEntry` 兼容**一字未改** |
| **A2 工单查看与操作重构** | 🟨 部分完成 | 六状态均新增"查看详情"入口（放在**窗口内**，不破坏「行操作列仅一个按钮」冻结门禁）；详情抽屉重构出「内部记录」区。**待收口**：工单号列本身可点击（PENDING） |
| **A1 门店工作台首页** | ⏳ 未实施（设计就绪） | 需**新建 NocoBase 页面 + 登录默认落地**，属运行期页面数据；本轮未落地（PENDING，见 §11） |

**一句话**：A3/A4/A5 代码已完成且互不破坏既有门禁；A2 完成"人人可查看 + 详情内部记录"这一核心诉求；A1（工作台首页）需要运行期页面/落地改造，本轮**没有**动 —— 因为它必须靠真实 NocoBase 页面验证，而本环境**无法编译/无浏览器**（见 §8），盲改页面正是用户点名的"改了源码、NocoBase 仍显示旧页面"的风险。

---

## 2. 逐文件改动说明（含复用了什么）

| 文件 | 改动 | 复用 |
|---|---|---|
| `src/shared/svc-action.ts` | 新增 `SVC_ACTION.INTERNAL_NOTE='internalNote'`；加入 `SVC_WRITE_ACTIONS` | 既有共享动作契约（前后端同源） |
| `src/server/constants.ts` | `EVENT_TYPE.INTERNAL_NOTE='internal_note'` + `EVENT_TYPE_LABEL['内部备注']`；`INTERNAL_WRITE_SCENE.INTERNAL_NOTE`；`SVC_ACTION.INTERNAL_NOTE`；加入 `AUTHENTICATED_SVC_ACTIONS` | 既有事件白名单 / 幂等 scene / 鉴权名单 |
| `src/server/services/ticket-service.ts` | 新增 `addInternalNote()`：**只写一条事件**（无 `conditionalUpdate`、无状态迁移）| 复用 `runIdempotentWrite` / `withTransaction` / `events.write` / `ValidationError` |
| `src/server/actions/svc/ticket.ts` | 新增 `internalNote` handler（`requireRequestId` + `requireTicketId` + `assertCanWriteTicket` + 服务层调用）；`svc:timeline` 响应新增 `can_write` | 复用 `createWrapper` / `writeIdempotencyOf` / `replay` / `assertCanWriteTicket` |
| `src/client/ticket-drawer.tsx` | 新增 `canWrite` 状态；新增 `NoteComposer`（备注输入）；把"处理记录"区重构为**「内部记录」**（备注入口 + 历史事件） | 复用 `sendSvcRequest` / `newRequestId` / 既有时间线 `buildTimeline` |
| `src/client/primary-action.tsx` | 「处理」「跟进」窗口顶部新增「查看工单详情（只读）」链接（`openTicketDrawer`）| 复用既有 `openTicketDrawer`（未新造详情） |
| `src/client/ticket-create-action.tsx` | 选填字段（地址/家电类别/品牌型号）折叠进「更多信息（选填）」；紧急标记仍在首屏 | 复用既有 `TYPE_CONFIG` / `openClosableModal` / `svc:storeOptions` / `svc:createTicket` |
| `src/client/store-entry-action.tsx` | 移除旧入口链接展示与旧入口说明；`EntryBody` 不再渲染 `legacy_url`；更新文件头边界说明 | 复用 `svc:storeEntryLinks`（服务端响应形状不变） |

**新增的最小能力（只有一处真正新增）**：`INTERNAL_NOTE` 事件类型 + `svc:internalNote` 动作。其余全是**复用既有机制**（事件白名单、幂等、详情抽屉、创建表单、报修入口）。

---

## 3. 内部备注（A3）—— 逐条对照用户规则

| 用户要求 | 实现 |
|---|---|
| 与 `svc:followUp` **分开**，不得放宽 followUp 状态限制 | ✅ 独立 action `internalNote` + 独立 scene；`followUp` 一字未改 |
| 只写一条历史事件 | ✅ 仅 `events.write(EVENT_TYPE.INTERNAL_NOTE)`，**无** `conditionalUpdate` |
| 不改状态/不重开/不重新派工/不发短信/不改收费评价完工时间/不动 `next_follow_at`/不生成 SLA 待办 | ✅ 服务方法**根本不触碰工单行**，只写事件 |
| 覆盖 NEW / PROCESSING / WAIT_STORE_CONFIRM / WAIT_FEEDBACK / CLOSED / CANCELLED（仅授权） | ✅ **无状态限制**；"能不能写"由 `assertCanWriteTicket` 裁决 |
| 白名单正确 | ✅ 已加入 `EVENT_TYPE` + `EVENT_TYPE_VALUES`（`assertValid` 校验） |
| 只能经授权服务端动作写入 | ✅ action 走 `createWrapper`（登录）+ `assertCanWriteTicket` |
| 记录操作人/时间/工单/内容 | ✅ `operator_user`（关系字段名已修正）、`created_at`、`ticket_id`、`metadata.note` |
| 可读、不可无痕覆盖 | ✅ `ticketEvents` append-only；时间线按 `EVENT_TYPE_LABEL` 显示为「内部备注」 |
| 不向客户/师傅 H5 泄露 | ✅ 事件只在 `svc:timeline`（已登录、门店范围）读取；公开接口不涉及 |
| 不改状态机 | ✅ 无状态字段写入 |
| 失败/重复点击有反馈、防重复 | ✅ 幂等键 `ticketId:userId:requestId`；按钮 loading + 服务端幂等 |
| 详情里「添加内部备注」入口 + 历史可区分 | ✅ 「内部记录」区；事件标签含「跟进记录/门店已派工/门店已确认/客户已评价/内部备注」 |

**权限**：`internalNote` 在 `AUTHENTICATED_SVC_ACTIONS`（需登录）；`assertCanWriteTicket` → `WRITE_ROLES = [store_after_sales, hq_after_sales, hq_admin]`。**只读角色（viewer）写操作被 403 挡下**，且详情里 `canWrite=false` 时**不渲染**备注入口。

---

## 4. 工单查看与操作（A2）—— 实际可见动作矩阵（六状态全）

> 关键约束：`verify-store-ui-primary-action.mjs` **判据①** 冻结了「每行操作列**总共**只有一个按钮」。
> 因此"查看"**没有**做成第二个行按钮（那会破坏门禁），而是放在**行主按钮打开的窗口内部**——
> 行操作列仍只有一个按钮，但**六种状态都能打开只读详情**（详情本身只读、不改状态）。

| 状态 | 行主按钮 | 点击后 | 查看详情路径 | 内部备注 |
|---|---|---|---|---|
| **NEW**（待处理） | 处理 | 处理窗口（内含「查看工单详情（只读）」） | 窗口内链接 → 只读抽屉 | 抽屉「内部记录」区（可写角色） |
| **PROCESSING**（处理中） | 跟进 | 跟进窗口（内含「查看工单详情（只读）」） | 窗口内链接 → 只读抽屉 | 同上 |
| **WAIT_STORE_CONFIRM** | 审核结果 | 只读详情抽屉（含确认/驳回区） | 行按钮直达 | 同上 |
| **WAIT_FEEDBACK** | 查看 | 只读详情抽屉 | 行按钮直达 | 同上 |
| **CLOSED**（已闭环） | 查看 | 只读详情抽屉 | 行按钮直达 | 同上（**新增能力**） |
| **CANCELLED** | 查看 | 只读详情抽屉 | 行按钮直达 | 同上（授权人员） |

**两套矩阵治理（G6）**：`action-matrix.ts` 是**能力契约**（`verify-client-logic.mjs` 逐状态断言它，不能删）；`row-action-matrix.ts` 是**摆放**（列表行按钮的唯一运行时来源）。二者职责不同、**本就不是重复**——已确认无第二处驱动行按钮。**本轮不改**，以免动到冻结门禁。

---

## 5. 人工新建服务单（A4）

- 首屏只留**必填**：服务类型 / 联系人 / 联系电话 / 服务事项 + 紧急标记。
- 「更多信息（选填）▼」折叠：服务地址 / 家电类别 / 品牌型号。
- **六类不变**（维修/安装/调试保养/移机拆机/投诉/其他）；投诉/其他仍不问卷家电与地址。
- **系统级字段不暴露**（提交体仍只有业务字段，`store_code` 来自 `svc:storeOptions`）——保持现状、未重复开发。
- 门店归属：单店自动固定、多店仅授权门店可选，服务端仍校验。

---

## 6. 隐藏旧二维码入口（A5）

- 后台弹窗**只显示**：门店名 + 正式签名链接 + 二维码 + 复制 + 下载。
- **不再显示**：旧入口链接文本、旧入口（无防篡改）说明。
- **服务端兼容保留**（一字未改）：`resolveStoreEntry` 仍接受裸门店编码，旧码扫码照旧进得来。

---

## 7. 定向测试结果

> ⚠️ 本环境**没有本地 `tsc`/`esbuild`，也没有可用的运行容器/浏览器**（详见 §8）⇒
> **无法执行编译或任何浏览器/接口运行期验证**。下表如实标注每一项的**真实**状态。

| 验证项 | 状态 | 说明 |
|---|---|---|
| 语法/静态（esbuild 转译 + TS 门禁） | ⏳ PENDING | 本地无 esbuild/tsc；需在容器内 `node scripts/build-plugin.mjs` 跑 |
| 工作台（登录→首页/数字正确/待办跳转） | ⏳ PENDING | **A1 未实施** |
| 六状态可查看详情 | ⏳ PENDING | 代码就绪，需浏览器点验（`verify-store-ui-primary-action.mjs` 覆盖） |
| 内部备注：新增/操作人/时间/跨店/状态不变/不发短信 | ⏳ PENDING | 服务端逻辑就绪，需运行期验证（建议新增定向脚本，见 §9） |
| 新建服务单：六类/必填一致/折叠不影响保存 | ⏳ PENDING | 代码就绪，需浏览器点验（`verify-store-create-ui.mjs` 覆盖） |
| 二维码：界面不显示旧入口 / 旧码仍可用 | 🟨 静态确认 | 界面已移除（源码级）；旧码兼容未改。运行期待验（`verify-store-entry.mjs`） |
| 页面持久化 | ⏳ PENDING | 本轮未改 seed，无新增页面 |
| **增量密钥审计** | ✅ 通过 | `scan-commit-secrets.mjs --paths <7 files>` → exit 0，无明文 Token/手机号/密钥 |
| **工作树干净度** | ✅ | `git status` 仅 7 个预期源码文件被修改，无无关改动 |

---

## 8. 为什么只能标 PENDING（环境事实，非借口）

1. **无本地编译链**：仓库 `node_modules` 内**没有** `typescript`/`esbuild`（它们在应用容器里）。本机执行 `node -e "require('esbuild')"` → `MODULE_NOT_FOUND`。
2. **无可用运行容器/浏览器**：`docker ps` 无输出（容器未运行）；用户明令**不引入** CDP/Puppeteer/自动登录/截图框架。
3. ⇒ 因此本轮**只做源码级交付 + 静态/审计验证**；任何 UI/接口行为**都不冒充分**为已通过。

---

## 9. 尚需用户/环境执行的人工验收项（最短路径）

**先构建并重启**（改的是插件源码）：
```
node scripts/build-plugin.mjs          # TS 门禁(TS2304/TS2552 + 宿主成员) + esbuild
docker compose restart app             # DEV-74：不 restart 则 ?hash 缓存不刷新
```

**门店账号最短测试路径**（本环境无浏览器，请人工点验）：
`登录门店售后 → 我的门店工单 →`
1. **NEW 行**：点「处理」→ 窗口内点「查看工单详情（只读）」→ 能打开只读详情（先查看后处理）。
2. **PROCESSING 行**：点「跟进」→ 窗口内「查看工单详情」→ 详情 → 「内部记录」→ **添加内部备注** → 保存 → 时间线出现「内部备注」+ 操作人/时间。
3. **CLOSED 行**：点「查看」→ 详情 → 「内部记录」→ 添加内部备注 → **状态仍为已闭环**（不被重开）。
4. **新建服务单**：首屏只有必填 + 紧急；点「更多信息（选填）」才展开地址/家电/品牌；六类均可建。
5. **门店报修入口**：弹窗**只**有正式链接 + 二维码 + 复制 + 下载，**无旧入口链接**；用早期旧码扫码仍能进 H5。
6. 只读角色（viewer）：详情「内部记录」区显示"只读，不能添加内部备注"，且服务端写操作 403。

**建议补一支定向脚本**（服务端，本环境可跑）验证内部备注的"无副作用"：写入后断言 `status`/`closed_at`/`completed_at`/`next_follow_at`/评价/金额**全部不变**，且 `ticket_events` 只多一条 `internal_note`、`smsLogs` 无新增。

---

## 10. 权限与数据安全（静态核对）

- 内部备注：`assertCanWriteTicket`（能力 + 门店归属，越权/不存在统一 404）；只读角色 403；`viewer` 前端不显示入口（`can_write=false`）。
- 详情入口：只读抽屉，不改状态；`svc:timeline`/`svc:visits` 仍按 `assertCanAccessTicket` 裁范围。
- 新建：系统级字段不可写；门店归属由 `svc:storeOptions` + 服务端 `assertStoreInScope` 裁。
- 二维码：界面移除的是**展示**，服务端签名/校验/兼容路由**未改**。
- 未新增任何匿名可达接口；未放宽任何 ACL/白名单；未触碰 P11-5 冻结项（师傅 H5 / 私有媒体 / Range / 现场照片 1–3 / Token / 状态机 / 真实短信）。

---

## 11. 已知问题与未完成事项

1. **A1 门店工作台首页：未实施（PENDING）**。原因：它是**运行期页面数据**（`desktopRoutes`/`flowModels`），需要
   ① 新增客户端工作台模型（统计 + 今日待办 + 快捷入口 + 最近工单）；
   ② 通过 `seed-admin-pages.mjs` 播种（注意 `mode:'replace'` 覆盖与 declaredKey 去重）；
   ③ 把门店角色**默认落地**改到工作台；
   ④ 真实浏览器验证"数字与列表一致、待办可跳转、多门店范围正确、空态提示"。
   本环境无法编译/无浏览器 → **盲改页面风险高**（正是用户点名的"改了源码、NocoBase 仍显示旧页面"），故本轮**不动**。
   - 数据来源设计（已定，避免前端写死/第二套算法）：**待处理 = 当前授权门店 `status=NEW`**；**已处理（累计）= `WAIT_FEEDBACK + CLOSED`**；辅助 = `PROCESSING / WAIT_STORE_CONFIRM / WAIT_FEEDBACK`；今日待办**复用 `svc:followUpQueue`（+ 现有 SLA）**，同一工单多条件命中在待办总数去重；统计一律走 `applyScope` + 排除历史导入（历史数据在 `historicalImportRows` 等**独立集合**，非 `serviceTickets`）。
2. **G2 工单号列本身可点击：未实施（PENDING）**。需要控制 `ticket_no` 列的渲染（flow-engine 列/字段模型 + 播种），同样属未验证的页面改动。**已用「窗口内查看详情链接」达成"六状态均可查看详情"这一实质目标**。
3. **G4 今日待办入口**：依赖 A1 工作台页面，随 A1 一起做。
4. **未运行**任何冻结测试（17/17、15/15、Phase 11 全量、SMS/客户媒体/P11-5）—— 按纪律不做无关全量回归。

---

## 12. Git 管理（按 §十二.3：本轮不提交、不推送）

- 工作树：仅 **7 个**预期源码文件被修改（§2 表 + `primary-action.tsx`），无无关改动。
- 增量密钥审计：**通过**（exit 0）。
- **未提交、未推送** `origin/main`。等用户审阅本报告与验收结果后，再决定是否提交与推送。
- 未泄露任何密钥/手机号/完整 Token/真实客户数据；未新增任何工具（未引入 CDP/Puppeteer/自动登录/截图框架）。

---

## 13. 建议的下一步

1. 用户在环境内 `build-plugin` + `restart app`，按 §9 走一遍人工验收（尤其是**内部备注无副作用**与**六状态可查看**）。
2. 若 A3/A4/A5 验收通过 → 我再按最小改动落地 **A2 收口（工单号可点击）** 与 **A1 工作台首页**（含 seed 与落地路由），并用真实页面验证。
3. 全程遵守：禁止重复造轮子 · 不做不必要哈希校验 · 小改动不全量回归 · 不为凑提交改无缺陷代码。
