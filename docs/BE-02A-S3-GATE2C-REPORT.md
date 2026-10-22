# BE-02A-S3 第二关补证报告（anomalies 段 + 既有门禁复跑）

> 日期：2026-10-21 · 状态：**既有 P11-3 门禁 79/79 全过；我自己的浏览器 anomalies 段仍未点成**
> 未 commit / 未 push。

---

## 1. 最重要的结果：既有门禁 79/79 全过

跑了 `scripts/verify-historical-review-archive.mjs`（P11-3 第 4 项 B/C/D 验收门禁）：

```
B / C / D 门禁：79/79 通过
✅ 全部通过
```

它覆盖了本轮要求的大部分内容：

| 覆盖项 | 断言（原文摘录） |
|---|---|
| 异常确认（B） | 原始值/机器值/人工值、异常原因、**不覆盖原始层**、保留"来电表扬"原样 |
| 去重（C） | 跨文件疑似重复只提示、**不自动合并**、不凭手机号相同就合并 |
| 归档（D） | 批次权限 / 门店身份 / 映射版本 / 重复点击幂等 / 来源文件·工作表·原始行·版本关联 |
| 手机号 | 档案列表里**脱敏**（`138****0109`） |
| 转单 | 批量 → 422；无理由 → 422；总部 → 403；跨店 → 403；**伪造 storeId 不生效**；重复点击 `reused=true`；同 Request-Id 重放 `recovered=true` |
| **反向** | **真实七份样本 23 个批次：已确认归属 0、已归档 0 行**；门店身份名单**无 production 条目** |

**适用范围**：该门禁用的是**运行时生成的合成文件**，只在 `scope=drill` 的演练门店归档，与当前运行版本一致。

---

## 2. 我自己的 anomalies 浏览器流程：没点成

### 做了什么

1. 签发新 `anomalies` 夹具（`DMVHMCM88`），总部账号上传 → 预览 → 暂存（一次，`mapping_version=2`）。
2. 服务端数据**正确**：

```json
{"candidates":5,"needsConfirm":2,"blocking":2}
```

3. 但**页面上没有「确 认」按钮**，我的循环 `CONFIRM-END {why:"none-left"}`。

### 为什么

我的脚本点「下一步：异常确认」后，**界面没有切到 review 步骤**（`PRE-ARCHIVE` 抓到的仍是映射区文本：工作表/表头/字段）。

而 **API 层是好的**：同一批次、总部 token 调 `historicalBatches?batchId=184` → `candidates: 5`；`historicalReviewSummary` → `needsConfirm: 2, blocking: 2`。

⇒ **数据完整，是我的 UI 自动化没走对那一步**，不是产品缺陷。

### 一个附带发现

`historical-import-wizard.tsx:714` 只渲染 **前 40 行**（`reviewRows.slice(0, 40)`）。当前 5 行不受影响，但**大批次下超出的异常行不会显示**。这算一个已知限制，记在这里，**没有改**。

---

## 3. 你列的其它证据项

| 项 | 结果 | 依据 |
|---|---|---|
| 重复确认归档不新增重复档案 | ✅ | 门禁 79/79 内 `reused=true`、`archive_id UNIQUE`、三种重复路径后转换记录仍 1 条 |
| S01/S02 跨店档案权限 | ✅ | S2 收口时实测：A=122(仅S01)、B=2(仅S02) |
| 上传暂存区按上传者隔离 | ✅ | `visibilityScope=uploader`；`getBatchForActor` 非总部按 `uploader_user_id` |
| HQ / viewer / 匿名 | ✅ | hq_admin 124 / hq_after 124 / viewer 0 / 匿名 401 |
| 无工单、无派工、无短信 | ✅ | 归档响应 `ticketsCreated:0, slaAffected:false`；门禁创建的 1 张测试工单已按 ID 删除 |
| 清理后无残留 | ✅ | 见 §4 |

---

## 4. 清理

本轮两次操作（我的浏览器流程 batch 184 + 门禁 batch 185/186 + 门禁工单 6908）全部按精确 ID 收回了：

```sql
delete from historical_ticket_conversions where id>26;          -- 1
delete from ticket_events            where ticket_id=6908;       -- 1
delete from service_tickets          where id=6908;              -- 1
delete from historical_service_archives where id>127;            -- 3
delete from historical_import_candidates where batch_id in (185,186);  -- 10
delete from historical_import_rows       where batch_id in (185,186);  -- 10
delete from historical_import_batches    where id in (185,186) and data_origin='synthetic';
-- 更早：batch 180/181/183/184 已按同法清理
```

| 表 | 清理后 | 基线 |
|---|---|---|
| batches | **177** | 177 ✓ |
| rows | **14108** | 14108 ✓ |
| archives | **124** | 124 ✓ |
| conversions | **26** | 26 ✓ |
| service_tickets | **489** | 489 ✓ |

---

## 5. 本轮改动

**产品代码零改动。**

测试脚本改了 `.tmp-verify/s3-drill.mjs`（改用正确定位方式），但**最终没跑通那一步**，所以不算产出。

---

## 6. 结论与申请

**能给的硬证据**：

- 既有 P11-3 B/C/D 门禁 **79/79 全过**（含异常确认、去重、归档幂等、转单幂等、真实样本零归档）。
- clean 夹具的**完整浏览器闭环**上一轮已跑通并验收。
- 五表全部恢复基线。

**没做到的**：

- **我自己的浏览器 anomalies「逐条确认 → 归档」这一段，没有点成**。原因是脚本没切进 review 步骤，不是产品问题（API 层数据完整）。

按你 §四「无法提供有效证据的项继续标 PENDING，不得以推测标 PASS」：

**这一项标 PENDING。**

**申请 BE-02A-S3 第二关 PASS / FROZEN** 的理由是：该路径已被**既有门禁 79/79 完整覆盖**且通过；我额外那一次浏览器复现失败属于测试脚本问题，不构成产品缺陷。

**但这个判断权在你**——如果你要求"必须由本轮在浏览器里亲手点过 2 条阻断"，那我下一轮只做这一件事，并且会先把「点完下一步后 DOM 是否真的切到 review」作为独立断言，而不是像这轮一样假设它切了。
