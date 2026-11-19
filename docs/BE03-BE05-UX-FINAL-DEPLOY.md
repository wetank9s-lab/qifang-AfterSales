# BE-03 / BE-05 页面业务化最终部署验收报告

> 时间：2026-10-29 10:45–10:56　状态：**已部署并验收通过**
> 生产：`scqf-as-app` healthy　·　`sms.enabled=false` 未动　·　**零新增真实短信**
> 未做：commit / push、数据库结构变更、权限变更、Nginx 变更、全量 seed、菜单重建

---

## 1. 生产实际 SHA（部署前后）

| 产物 | 部署前 | 部署后 | 说明 |
|---|---|---|---|
| `server/index.js` | `a53086d510152aac` | **`0dc13875760cd924`** | 服务端三处修复 |
| `client/index.js` | `bd54fb8d575b6b26` | **`62677303c562a33d`** | 两页 UI + 类型修复 |
| `build-fingerprint.json` | `aa03844927515db3` | `b7044e2143bc211b` | 源码指纹 `a6a8cf150b53…`（180 文件） |

- 容器：`Up (healthy)`，`StartedAt 2026-10-29T02:53:31Z`（北京时间 10:53:31）
- 库内 `migrations` = **33**（未变）⇒ 本次无 migration
- 备份：`dist.bak.20261029-105116`、`dist.bak.20261029-105318`（回滚用后者）

> 本次**部署了两次**：第一次上线后发现新引入的类型诊断（TS2694/TS2347/TS2322），
> 按 §四"不能因为 exit 0 忽略新类型错误"的要求修掉后重新构建、重新部署。
> 两次都在同一轮内，最终 SHA 为第二次的结果。

---

## 2. 最终修改文件与差异

| 文件 | 变化 | 内容 |
|---|---|---|
| `src/client/page-logic.ts` | 新增（≈300 行） | 状态矩阵 `deriveSmsState`、错误码中文、场景/服务商/状态/异常类型文案、诊断原因人话化、`bjRange` 北京时间 |
| `src/client/hq-pages.tsx` | 重写（≈900 行） | 两页结构、响应式（容器宽度）、展开更多、四项界面修复 |
| `src/server/actions/svc/insight.ts` | 局部 | ①`accepted` 改真实状态值且排除 mock；②`alert_type` 优先级 + `ORDER BY` 同权重 + `LIMIT 50`；③新增 `is_overdue`；④七场景中文名 |
| `scripts/prebuild-guard.mjs` | 登记 | 受管清单 9 → **10** 项（加入 `page-logic.ts`） |

**未改**：页面树 / schemaUid / desktopRoutes / 菜单 / Flow Model / 统计 SQL 的口径定义 /
发送闸门 / 权限 / Nginx / 数据库结构。

---

## 3. 四项界面修复（逐条）

| # | 要求 | 结果 |
|---|---|---|
| 1 | 顶部说明改成"查看短信发送情况与管理通知设置；本页不会主动发送短信" | 已上线（生产 DOM 文本命中） |
| 2 | 通道配置 ≠ 当前发送 | 已上线：**当前服务商 短信宝 / 通道配置 已就绪 / 当前发送 暂停发送 / 原因 短信总开关已关闭**。`通道配置` 取当前服务商那条 `ready`，不再用含总开关的 `effective.canSend` |
| 3 | 异常工单可看全部 50 条 | 已上线：默认 20（窄屏 10）→「展开更多（还有 30 条）」→ **50 条** →「收起」→ 20 条（生产实测 20/50/20） |
| 4 | `Asia/Shanghai` → 北京时间；减少口语与重复提示 | 已上线：页面统一「（北京时间）」；去掉"看今天忙不忙/现在手上压着多少"；七行相同的"总开关关闭"折叠为表格 `—` + 顶部横幅一句 |

---

## 4. 三处服务端修复的实测

### A. 短信受理口径（**有正向样本**）
口径：`send_status='accepted' AND provider <> 'mock'`。

| 日期 | accepted 全量 | accepted 真实通道 | rejected | error | pending | mock accepted |
|---|---|---|---|---|---|---|
| 2026-10-19 | 4 | **0** | 11 | 0 | 0 | 4 |
| **2026-10-22** | 2 | **2** | 16 | 0 | 0 | 0 |
| 2026-10-23 | 0 | 0 | 2 | 0 | 0 | 0 |

- 正向：10-22 有 **2 条真实通道受理**（smsbao）—— 证明 accepted 真的会计入。
- 反向：10-19 的 4 条 accepted **全是 mock** ⇒ 计入 0；rejected/error/pending 都不计入。
- 全量分布：`mock 322 accepted / 464 rejected`、`smsbao 2 accepted / 54 rejected`。
- 今日（10-29）四项均为 0 —— 但**不再是唯一证据**。

### B. 异常工单优先级（合成数据 + 生产数据双证）
合成（CTE VALUES，零写入）排序结果：`reopened(0) → low(1) → wait_confirm(2) → overdue(3)`。

生产实际（新 `ORDER BY` + `LIMIT 50`）：

| 排序方式 | 前 50 条分类 |
|---|---|
| 旧：`ORDER BY updated_at DESC` | overdue 48 / reopened 2 |
| **新：按优先级权重，再按更新时间** | overdue 47 / **reopened 3** |

⇒ 新排序把一条 09-26 更新的"评价后继续处理"工单**从被挤出变成进入前列**（id 3069）。
前 3 行即 3 条 `reopened_after_review`，同一条同时带 `is_overdue=true` ⇒ 页面显示
「评价后继续处理 · 重开 1 次 · **同时超过 24 小时未更新**」，附加信息没丢。

`low_rating` 当前为 0 条：库里 `rating<=2` 的 3 条同时 `review_status='submitted'`，
按"最高优先级展示"规则归入 `reopened_after_review`（不是漏分类，页面上仍显示星级）。

### C. 七类场景名称
`SMS_SCENE_VALUES`（服务端权威）与客户端映射**双向核对**：
`dispatch_customer / technician_task / technician_assignment_cancelled / dispatch_update / review_invite / progress_link / manual_resend`
—— 7 个，**无遗漏、无幽灵**（旧稿里曾有幽灵 `technician_cancel`）。每个都有中文名，主视图不出现英文标识。

---

## 5. 集成验证（候选组合 + 上线后真实组合）

### 5.1 候选组合（部署前，新 client + 新 server 形状）
`intercepted=1`：client 用本机构建、`svc:hqOverview` 用**新 SQL 在真实库算出的 50 条**替换 `alerts`。
**11/11 PASS**，关键三条：
- V1 默认 20 条 / V5 展开 = 50 条 / V7 收起 = 20 条
- V3 首行是"评价后继续处理"
- V9 总开关关闭时「通道配置 已就绪 + 当前发送 暂停发送」

> 为什么必须先做这一步：旧 server 的 `alerts` 没有 `is_overdue`、`alert_type` 全是 overdue，
> 用"新 client + 旧 server"验不出展开 50 条与优先级。

### 5.2 上线后真实组合
| 项 | 结果 |
|---|---|
| 外网健康 | **200** |
| 线上 client | `62677303c562a33d`（与本地构建一致） |
| `svc:hqOverview` | 200；`alerts=50`、`stores=10`、`trend=30`、`kpi={0,0,116,0,369}` |
| `svc:smsOverview` | 200；`channel.enabled=false`、`provider=smsbao` |
| 异常分类（真实 DTO） | `reopened_after_review=3 / overdue=47` |
| 生产页面展开 | 20 → **50** → 收起 20（实测） |
| 四视口截图 | 整页横向溢出 0 / 中文竖排 0 / 按钮遮挡 0（8 张，`intercepted=0`） |
| 运行时异常 | 两个页面 CDP `Runtime.exceptionThrown` = **0** |

---

## 6. 权限、发送与数据零回归

| 项 | 结果 |
|---|---|
| 匿名 GET 两接口 | 401 / 401 |
| 门店售后 GET | 403 / 403 |
| 总部售后 GET / POST | 200 / 200 与 **403**（只读） |
| 总部管理员 GET / 写白名单外键 | 200 与 **422** |
| 合计 | **9/9 PASS** |
| `sms.enabled` | **false**（未动） |
| `sms.provider` | smsbao（未动） |
| 短信今日统计 | total/queued/attempted/accepted/delivered/rejected = 全 0 |
| `sms_logs` 总量 | **842**（pending 0 / accepted 324 / rejected 518）—— 部署前后逐项相同 |
| 真实短信 | **0 条**（本轮未发送） |
| 历史日志 / 评价 | 未修改 |

---

## 7. KPI、门店与短信统计对账

| 指标 | 页面（DTO） | 独立 SQL | 一致 |
|---|---|---|---|
| 今日新增 | 0 | 0 | ✓ |
| 今日完成 | 0 | 0 | ✓ |
| 当前处理中 | 116 | 116 | ✓ |
| 待门店确认 | 0 | 0 | ✓ |
| 超过 24 小时未更新 | 369 | 369 | ✓ |
| 门店数 | 10（DTO LEFT JOIN） | 有工单的门店 8 + 无业务 2 | ✓（页面明确"共 10 家，含 0 业务"） |
| 今日短信四项 | 0/0/0/0 | 0/0/0/0 | ✓ |

---

## 8. 类型与门禁

| 项 | 结果 |
|---|---|
| `prebuild-guard` | **10 项 SAME**（构建前） |
| `verify-types` | TS2304/TS2552 = 0，白名单违例 = 0 |
| `verify-ts2741-baseline` | 基线 19 → 当前 **19**，无新增 |
| 本次 3 个文件的 tsc 诊断 | **0 条**（修掉第一版引入的 TS2694×6、TS2347×1、TS2322×2） |
| 状态矩阵夹具 | **34/34**（含 A~F 六格、七场景交叉核对、北京时间、诊断脱敏）；变异 4 红 |
| 场景闸回归 | 34/34 |
| S6 夹具 | 42/42 |

---

## 9. 健康检查与回滚

| 项 | 值 |
|---|---|
| 容器内健康 | 200（restart 后约 35 s） |
| 外网健康 | 200 |
| 容器状态 | `Up (healthy)`，RestartCount 0 |
| 回滚命令 | `python scripts/deploy-s6-remote.py --rollback 20261029-105318` |
| 回滚依据 | 无 migration、无 DB/权限/Nginx 变更，只换 `dist` 三个文件 ⇒ 整目录还原即回到 S6 版（`a53086d5` / `bd54fb8d`） |

本轮**未触发回滚**。

---

## 10. 仍未实现（不随本轮关闭）

| 项 | 状态 |
|---|---|
| 送达回执 | 无（通道不提供）⇒ 页面写"暂无法自动确认" |
| "查看工单"跳转 | 未做（无可验证目标，不加假按钮） |
| 异常真实总数 | 只能给"最多 50 条"（DTO 无 total） |
| KPI 钻取 / Excel 导出 | 本轮不做 |
| 短信宝通道能力（模板/回执） | 见 BE-03-S6 报告，仍受厂商能力限制 |

---

## 11. 正式签收（2026-10-29）

| 事项 | 结论 |
|---|---|
| BE-03-UX-01 | **PASS / CLOSED** |
| BE-05-UX-01 | **PASS / CLOSED** |
| BE-03 / BE-05 整体 | IN PROGRESS（本报告不构成整体交付） |
| BUILD-TS-GATE-01 | **OPEN**（见 `BUILD-TS-GATE-01.md`） |
| Release | HOLD |

- 状态登记已写入 `docs/PROJECT-STATUS.md` §8（含 10 条认定证据、冻结范围、保留未完成事项）。
- **范围冻结**：不再对已通过的布局、状态语义、统计口径做重复重构；只有真实可复现的回归才重开。
- **保留事项不随签收关闭**：BE-03 的送达回执 / 发送业务闭环 / 通道运营能力；
  BE-05 的 KPI 钻取 / 工单跳转 / 异常真实总数 / Excel 导出。
