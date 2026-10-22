# BE-02B 第一关：历史转正式服务单 接入设计与安全核查报告

> 日期：2026-10-21 · **BE-02B 第一关：PASS（设计层）**，**等待代码实施授权**
> 本轮全程只读：未建单、未调转单写接口、未改 26 条转换记录、未碰真实档案。未 commit / push。

---

## 1. P11-3 现有转单接口（源码实测）

| 项 | 值 |
|---|---|
| Action 常量 | `SVC_ACTION.HISTORICAL_CONVERT_TO_TICKET = 'historicalConvertToTicket'`（`constants.ts:2082`） |
| 路由 | **`POST /api/svc:historicalConvertToTicket`** |
| 实现 | `server/actions/svc/historical-review-archive.ts:935` |
| 已注册 | ✅ `constants.ts:2171`（在 `SVC_ACTION` 白名单里） |

### 请求

```json
{ "archiveId": 125, "reason": "客户来电要求继续处理", "note": "可选备注" }
```

**明确拒绝数组**（`archiveIds` / `archiveId` 是数组 ⇒ `422 BATCH_CONVERSION_NOT_ALLOWED`）。

---

## 2. 转换对象与允许状态

**对象是 `historicalServiceArchives`（档案），不是 candidate、不是原始 row。**

必要条件（服务端逐条校验）：

| # | 条件 | 失败码 |
|---|---|---|
| 1 | 必须是单条（非数组） | `422 BATCH_CONVERSION_NOT_ALLOWED` |
| 2 | `archiveId` 有效 | `422 ARCHIVE_ID_REQUIRED` |
| 3 | `reason` ≥ **4 字** | `422 REASON_REQUIRED` |
| 4 | **`stage = 'archived'`** | `404 ARCHIVE_NOT_FOUND`（不存在或已撤销） |
| 5 | 角色必须是 `store_after_sales` | `403 STORE_STAFF_ONLY` |
| 6 | 操作者 `storeIds` 必须含 `archive.store_id` | `403 CROSS_STORE_FORBIDDEN` |
| 7 | 门店必须还存在 | `409 STORE_NOT_FOUND` |
| 8 | **`archive.customer_mobile` 必须非空** | `422 ARCHIVE_HAS_NO_MOBILE` |

**能否转换**：

| 状态 | 能否 |
|---|---|
| 已归档（`stage=archived`）、未转换（`conversion_state=none`） | ✅ |
| **已转换（`converted`）** | 接口**不拦**，但幂等会返回 `reused:true` + 原工单（**不会建第二张**） |
| 已作废 / 撤销（非 `archived`） | ❌ 404 |
| 重复记录 | 没有"重复档案"这个概念；重复由幂等键保证 |
| **未确认归属** | ❌ 归属为空的档案没有 `store_id`，第 6 条会挡住 |
| 无手机号 | ❌ 422（提示"回到异常核对里补全"） |

---

## 3. 权限矩阵（源码 + 门禁双重确认）

| 角色 | 能否转单 | 依据 |
|---|---|---|
| **归属门店的 `store_after_sales`** | ✅ | 唯一允许的角色 + `storeIds` 含档案门店 |
| **其它门店的 `store_after_sales`** | ❌ `CROSS_STORE_FORBIDDEN` | |
| **`hq_after_sales`** | ❌ `STORE_STAFF_ONLY` | **刻意不用 `isHq` 放行**（源码注释写明） |
| **`hq_admin`** | ❌ `STORE_STAFF_ONLY` | 同上；**总部读 ≠ 总部写** |
| **`viewer`** | ❌ | 无该 action 权限 |
| **匿名** | ❌ 401 | |
| **请求体伪造 `storeId` / `storeCode`** | **无效** | 服务端只用 `archive.store_id`；门禁实测"工单归属 = 档案原门店" |

> 源码注释原话：「判据统一成一条：**操作者的门店范围必须包含档案的原门店**」——这是"不能由总部代建"与"不能跨店代转"的同一把尺子。

---

## 4. 幂等与异常恢复（三层，不能由前端模仿）

```
① findIdempotency('historical_conversion', key)
     └ 命中 → recovered:true + **补写缺失的转换记录** + conversion_state='converted'
② historicalTicketConversions 按 idempotency_key
     └ 命中 → reused:true + 返回原 ticketId/ticketNo
③ TicketService.create({ ..., idempotency: { scene, key, responseOf } })
     └ 建单 + 写事件 + 写幂等记录 **同一事务**
```

**关键设计**（源码注释）：

> 顺序必须是"**先幂等记录、再转换记录**"。只查转换记录 ⇒ 响应丢失后重试会**再建一张单**。

**故障注入**：`x-svc-fault: convert-after-ticket`（仅非 production）—— 在建单成功、转换记录未写时抛错，用来证明重试能收敛到同一张单。**P11-3 门禁 79/79 里已验证过这条**。

---

## 5. 历史档案 ↔ 正式工单的关联

| 方向 | 载体 |
|---|---|
| 档案 → 工单 | `historical_ticket_conversions.ticket_id / ticket_no` |
| 档案侧状态 | `historical_service_archives.conversion_state = 'converted'` |
| 工单 → 档案 | **`service_tickets.extra_json.historicalConversion`** = `{ archiveId, archiveNo, batchId, dataOrigin, drill }` |
| 审计 | `converted_by_user_id/username`、`converted_at`、`reason`、`note`、`snapshot_json`（archiveNo / storeCode / mappingVersion / sourceFileName / sourceSheet / sourceRow） |

**当前基线**：`archives=124`（**98 未转换 / 26 已转换**）、`conversions=26`（与 26 条 converted 一一对应 ✓）。

**26 = 既有基线，不是 BE-02B 成果。**

---

## 6. 推荐的最小 UI 位置

**现状**：`historical-archives-block.tsx` 的详情里**已经显示「转单状态」**（`:342-343`），但**没有任何转单按钮**。

**推荐**：**在 S2 档案详情抽屉里追加一个操作区**（只加 DOM，不动列表/查询/筛选）。

| 项 | 做法 |
|---|---|
| 位置 | 详情抽屉底部，与"来源文件/原始行"并列 |
| 显示条件 | `conversionState !== 'converted'` **且** `stage === 'archived'` **且** `customerMobile` 非空 |
| 按钮 | 「转为服务单」 |
| 点击 | 打开一个小确认弹窗（不直接提交） |
| 已转换 | 显示"已转为 XXXXX（不可再转）"，**不给可执行按钮** |

**为什么这是最小变更**：`HistoricalArchivesBlockModel` 的 `fetch` / 筛选 / 分页 / 详情字段**一行都不用改**，只在详情渲染末尾追加一个区块 + 一个受控弹窗（约 70–90 行）。

**不做**：批量转单、列表行内按钮、导入后自动转、Excel 全量转。

---

## 7. 人工确认界面字段

**只读展示**（来自档案，不可编辑）：

| 字段 | 来源 |
|---|---|
| 客户姓名 | `archive.customer_name` |
| 联系电话 | `archive.customer_mobile`（脱敏显示，仅末四位明文） |
| 原所属门店 | `archive.store_code_snapshot` / `store_name_snapshot` |
| 历史问题 | `archive.service_issue` / `device_summary` |
| 历史服务日期 | `archive.service_date` |
| 处理结果 | `archive.result_summary` |
| 原始来源 | `source_file_name` / `source_sheet` / `source_row` |
| 将创建的工单类型 | **固定 `repair`（报修）** + `source='staff'` |
| 是否已有转换记录 | `conversion_state` + 查询 `conversions` |

**必填输入**：

| 字段 | 规则 |
|---|---|
| **转单理由** | **必填，≥4 字**（服务端同规则） |
| 备注 | 选填 |

**服务端建单契约**（不绕过）：

- `customerName` / `customerMobile` 取自档案，**不在前端重填**（避免与档案漂移）
- `content` 由服务端拼 `[历史转入] {reason}`
- `storeId` **只用 `archive.store_id`**
- `ticketType` **固定 `repair`**

---

## 8. 需要新增/修改的文件

| 文件 | 改动 | 风险 |
|---|---|---|
| `client/historical-archives-block.tsx` | 详情抽屉**末尾追加**「转换区」（按钮 + 确认弹窗 + 结果回显） | **低**（只加，不改查询/筛选） |
| `client/historical-import-wizard.tsx` | **不改** | — |
| `server/**` | **不改** | — |
| `scripts/verify-*.mjs` | 新增一支针对性门禁（转单 UI 可达性 + 拒绝矩阵） | 低 |

**若你判定"改 S2 冻结区块"不可接受**，备选是：**新增一个独立 BlockModel**（如 `HistoricalConversionEntryBlockModel`）挂在同一页另一个区块上 —— 代价是**两个区块**、且**需要用户先选中一条档案**。**我推荐前者**（追加区块），因为不动既有逻辑。

---

## 9. 能否完全复用既有转单服务

**能，而且必须复用。**

理由：
1. 幂等三层（`findIdempotency` → `conversions` → `TicketService.create` 同事务）**前端无法模仿**；
2. 权限判定（`STORE_STAFF_ONLY` + `CROSS_STORE_FORBIDDEN`）全在服务端；
3. `metadata.historicalConversion.drill` 标记（用于区分演练/正式）由服务端写；
4. 故障注入（`x-svc-fault`）只在服务端有意义。

**BE-02B 不新增任何转单算法**，只做 **UI 接线 + 门禁**。

---

## 10. 下一关（真实浏览器验收）方案

**前置**：必须先解决"隔离环境"或取得"原库写入授权"（UX-01B-FINAL Gate 2 就卡在这）。

**方案**（待授权后执行，最小量）：

| 步 | 内容 |
|---|---|
| 1 | 挑 **1 条未转换、有手机号、归属 S01 的合成档案**（`data_origin=synthetic` 的批次产出） |
| 2 | `uat.store.a@svc.local` 登录 → 历史售后档案 → 打开该档案 → 点「转为服务单」 → 填理由 → 确认 |
| 3 | 断言：`service_tickets` **+1**、`conversions` **+1**、`archive.conversion_state='converted'`、工单 `extra_json.historicalConversion.archiveId` 对得上 |
| 4 | **重复点一次** → `reused:true`，`service_tickets` **不再 +1** |
| 5 | 权限反例：`hq_admin` / 其它门店 / viewer / 匿名 → 403/401 |
| 6 | 清理：工单 + conversion + 档案状态回滚（**需要新的清理脚本**，现有 `purge-ux01b-ticket.mjs` 只管工单，不管 conversion 与档案状态） |

**第 6 步是个缺口**：现有清理工具**不会**把 `conversion_state` 改回 `none`、也不会删 `historical_ticket_conversions`。**需要在 Gate 2 前补一段**（或明确"测试用档案单独造，用完连档案一起删"）。

---

## 11. 必须保留的边界

| 边界 | 状态 |
|---|---|
| P11-3 转单算法 | **不改** |
| SEC-HIST-01 / HQ-HIST-01 | **不改** |
| S2 历史查询与详情 | **不改查询逻辑**（只在详情末尾追加） |
| S1 六个新建服务单入口 | **不动** |
| 二维码签名 | **不改** |
| 建单状态机 / TicketService | **不改** |
| ACL / listMeta | **不扩** |
| 26 条既有转换记录 | **不动** |
| 批量转单 | **不做** |

---

## 12. Git 与未完成项

**本轮改动**：**仅新增本报告**（`docs/BE-02B-GATE1-DESIGN.md`）。**零代码改动。**

**Git**：49 个已跟踪改动（多阶段累积）+ 未跟踪文档；`diff --check` 干净；**未 commit / push**。

**未完成 / 待裁决**：

| # | 项 |
|---|---|
| 1 | **UI 接入位置**：推荐"详情抽屉追加区块"，若你不同意需换方案 |
| 2 | **清理缺口**：现有工具不处理 `conversion_state` 与 `conversions`，Gate 2 前要补 |
| 3 | **执行环境**：隔离实例仍缺插件启用（UX-01B 遗留），或需原库写入授权 |
| 4 | 无手机号的档案（422）在 UI 上应**提前禁用按钮并说明**，而不是等报错 |

---

## 13. 申请

**BE-02B 第一关：PASS（设计层）。**

等待代码实施授权。授权后我只做：

1. `historical-archives-block.tsx` 追加转换区（约 70–90 行）；
2. 一支针对性门禁；
3. 不碰服务端、不碰 S2 查询逻辑。

**未 commit / 未 push，停在此处。**
