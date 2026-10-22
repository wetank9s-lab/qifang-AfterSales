# BE-02A 最终验收与冻结报告

> 日期：2026-10-21 · 结论：**申请 BE-02A 整体 PASS / FROZEN**
> 本轮只做证据汇总与只读核查，未新增业务开发，未 commit / push。

---

## 1. 交付范围

| 阶段 | 交付 | 状态 |
|---|---|---|
| **S1** | 六个合法「新建服务单」入口按 `declaredKey` 挂载 | PASS |
| **S2** | 「历史售后档案」页 + `svc:historicalArchiveQuery` + **SEC-HIST-01 / HQ-HIST-01 授权修复** | PASS / FROZEN |
| **S3** | 「历史数据导入」入口 + 复用 P11-3 向导的**真实上传→映射→预览→暂存→人工审核→归属→归档→S2 查询**闭环 | PASS |

**不在范围**：BE-02B（当前工单批量导入）、真实客户 Excel 的生产归档。

---

## 2. 阶段证据索引

### S1
- 六入口 / 重复 0：每次全量 Seed 输出 `✓ 回读 6 张门店侧表：有效区块上 6 个（重复 0 个）`。
- 定位方式：`declaredKey`（`svc.<blockUid>.<key>`），新增历史页面**不进** `serviceTickets` 动作白名单（`HQ_TABLE_DECLARED_KEY` 例外规则不变）。

### S2
- `HistoricalArchivesBlockModel` 挂在 markdown 宿主上（`declaredKey` 含 `archives-block`）。
- 接口 `svc:historicalArchiveQuery`：列表 / 详情 / 关键词 / 门店 / 日期 / 分页 / 重置。
- 五档 375/390/420/1280/1440：每档 20 行、`panelCount=1`、手机号不竖排。
- **隔离实测**：A=122（仅 S01）、B=2（仅 S02）、hq_admin=124、hq_after=124、viewer=0、匿名 401。
- **Seed 重播种后模型不丢**：`--only` 两次均挂上（uid 变，`declaredKey` 不变）。

### S3
**Clean 夹具（batchId=182）**：`data_origin=synthetic` → 总部确认 `S01 / attributionScope=drill` → 归档 `created:3, archiveIds:[125,126,127], ticketsCreated:0, slaAffected:false` → S2 查 3 条 + 详情（来源 `drill2.xlsx`、行 2）。

**Anomalies 夹具（batchId=187）**：真实浏览器进入 review（`reviewRows=5`）→ 两条阻断真实点击：
```json
{"candidateId":17677,"manualStatus":"confirmed","changed":true,"auditWritten":true}
{"candidateId":17680,"manualStatus":"confirmed","changed":true,"auditWritten":true}
```
→ 归属 `S01 / drill` → **归档 3 条（archiveIds 131/132/133）** → S2 `total=3`、A 总数 122→125、详情含 `来源 drill4.xlsx / 行 5`。

**79/79 门禁**：`scripts/verify-historical-review-archive.mjs` → `B / C / D 门禁：79/79 通过`。
**适用范围**：运行时生成的合成文件 + 只在 `scope=drill` 门店归档；含"真实七份样本 23 批次：确认归属 0、归档 0 行"的反向断言。

---

## 3. 安全边界（三层，不混用）

### 3.1 导入暂存区 —— **按上传者**
- `visibilityScope=uploader`；`getBatchForActor` 非总部按 `uploader_user_id`。
- 客户端伪造 `storeId/storeCode` **不生效**（门禁断言：工单归属仍是档案原门店）。
- 人工审核：`historicalReviewRow` 记录 `auditWritten:true`。
- 确认归属：**仅总部**（门店点 → `403 只有总部可以确认历史批次的门店归属`）——**这是正确边界，不是缺陷**。

### 3.2 正式历史档案 —— **按 `archive.store_id`**
- `resolveArchiveScope(actor)`：platform/hq → all；`store_after_sales` → `stores(storeIds)`；**其余含 viewer → none**。
- **明确结论：正式历史档案按 `archive.store_id` 授权，不按 Excel 上传者授权。** 这也是 SEC-HIST-01 的修复核心。
- HQ-HIST-01：`isHqActor` 补入 `hq_after_sales`（与 `HQ_ROLES` 对齐），此前它为 0 条。

### 3.3 演练数据
- 合成来源由**服务端**验证（`historicalDrillFixture` 登记 sha256，上传命中才标 `data_origin=synthetic`）。
- 归属范围 `drill`；门店身份表里**没有任何 production 条目** ⇒ 真实资料结构上无法归属。
- **总部完成受控演练 ≠ 门店账号拥有总部审核权限**（门店确认归属实测 403）。

### 3.4 工单转换
- 归档响应 `ticketsCreated:0, slaAffected:false`。
- 本轮两次归档前后 `service_tickets` 恒为 **489**、`historical_ticket_conversions` 恒为 **26**。
- 26 条转换记录是**既有基线**，不是 BE-02B 成果。

---

## 4. 数据完整性（只读核对）

| 表 | 当前 | 基线 | |
|---|---|---|---|
| historical_import_batches | **177** | 177 | ✓ |
| historical_import_rows | **14108** | 14108 | ✓ |
| historical_service_archives | **124** | 124 | ✓ |
| historical_ticket_conversions | **26** | 26 | ✓ |
| service_tickets | **489** | 489 | ✓ |

补充核查：

| 项 | 结果 |
|---|---|
| 本轮合成批次残留（`id>177`） | 仅 **178**，是 **2026-10-14** 的旧批次（`voided`、归档 0），属基线内，**非本轮产物** |
| 测试新增 archive（`id>124`） | **0** |
| 孤儿候选行 / 孤儿原始行 | **0 / 0** |
| 既有档案归属未变 | `store_id=1 → 122`、`store_id=2 → 2`（与 S2 验收一致） |

⚠️ **说明**：五表计数一致是**必要证据，不等于完整数据一致性证明**。上面几项（残留、孤儿、归属）是补充，仍不构成全量审计。

---

## 5. 已知遗留（登记，不开发）

### R1 异常审核展示上限
`historical-import-wizard.tsx:714` 是 `reviewRows.slice(0, 40)`。5 行夹具不受影响；**大批次第 41 行之后是否还有其它可达审核路径，未确认**。
**建议**：正式批量使用前，用 >40 行异常的文件验证一次，确认超出的行不会"看得见统计、点不到操作"。

### R2 重复安全暂存
同一批次多次暂存会保留多个 `mapping_version` 与候选版本（实测 4 次 → 15 条候选）。属既有版本保留设计。
**建议**：加重复点击提示或节流，**不得删除版本机制**。

### R3 异常确认与归档数量差
Anomalies：**5 条候选 / 2 条人工确认 / 3 条最终归档**。
**另外两条的最终处置状态，我无法从现有证据确定**（归档响应只回了 `created:3`，该批次已按契约清理，无法回溯）。
**登记为"待补充审计说明"，不猜测。**

### R4 测试覆盖边界
本次通过的是**合法合成夹具 + 受控演练归属**的真实浏览器闭环。
**不能宣称**已完成生产环境真实客户 Excel 的正式归档演练；**也不得**为补这项证据把真实客户数据写入生产归档。

---

## 6. Git 与冻结审计（只读）

```
git status --short   → 49 个已跟踪改动 + 一批未跟踪文档
git diff --stat      → 49 files changed, 5670 insertions(+), 374 deletions(-)
git diff --check     → 无输出（exit 0）
```

### BE-02A 实际涉及的文件

| 类别 | 文件 |
|---|---|
| **S2 新接口 + 授权修复** | `server/actions/svc/historical-review-archive.ts`、`server/constants.ts` |
| **S2 页面模型（新文件）** | `client/historical-archives-block.tsx` |
| **S3 入口** | `client/historical-import-wizard.tsx`（加 `HistoricalImportEntryBlockModel`，复用原 `Wizard`） |
| **注册** | `client/index.ts`（`BaseBlockModel` 提前取值 + 两个注册键） |
| **Seed** | `scripts/seed-admin-pages.mjs`、`scripts/expected-sensitive-columns.mjs` |
| **文档** | `docs/BE-02A-*.md`（各阶段报告） |

### 不属于 BE-02A（其它阶段累积）
`h5/*`（门店 H5 / 客户页）、`primary-action.tsx`、`ticket-drawer.tsx`、`store-entry-action.tsx`、`ticket-create-action.tsx`、`middleware/*`、`verify-*` 等 —— 属 UX-01 / BE-01 / BE-04 等，**不计入 BE-02A 成果**。

### S3 第二关是否改了产品业务代码
**没有。** 第二关全程只改测试脚本（`.tmp-verify/s3-*.mjs`）与文档。产品代码改动只发生在**第一关**（入口 BlockModel）。

---

## 7. 数据与隐私

- 全程使用**服务端签发的合成夹具**（客户名形如 `合成甲DMVHMCM88`，手机号 `1380000xxxx`）。
- 未把任何真实客户 Excel 归到占位门店；门禁反向断言：真实样本 23 批次**确认归属 0、归档 0**。
- 档案列表手机号**脱敏**（`138****0109`）。
- 所有测试数据按 **batchId 精确删除**，未使用 `TRUNCATE` / 无条件 `DELETE`。

---

## 8. BE-02A 与 BE-02B 的分界

| | BE-02A（本次） | BE-02B（未授权） |
|---|---|---|
| 目标 | **历史**数据导入 → **独立历史档案** | **当前**工单批量导入 |
| 写入 | `historical_service_archives` | `serviceTickets` |
| 工单 | **0 张** | 批量创建 |
| 转换 | 不触发（26 条为既有基线） | 核心能力 |
| 状态 | PASS / FROZEN | **未授权，未启动** |

---

## 9. Release 仍 HOLD 的原因

1. BE-02B 未授权、未开发；
2. R1（>40 行审核可达性）未验证；
3. R3（2 条候选处置）缺审计说明；
4. 未做生产真实数据的归档演练（R4）；
5. 本轮按要求**不 commit / push**，代码尚未进入版本库。

---

## 10. 申请

**BE-02A 整体：PASS / FROZEN。**

未完成/需后续确认的只有 R1–R4 四项**遗留登记**，均不构成安全或数据完整性阻塞。

**BE-02B：未授权，本轮未启动，也不自行宣布授权。**
**Release：维持 HOLD。**
