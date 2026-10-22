# BE-02A-S3 第二关报告（走到归档归属，未完成最终归档）

> 日期：2026-10-21 · 状态：**上传/映射/预览/暂存/异常统计 PASS；最终归档未执行（归属选项待确认）**
> 数据已按 batchId 精确清理，基线恢复。未 commit / 未 push。

---

## 1. 安全预检（已做）

| 项 | 结果 |
|---|---|
| 环境 | 本机 UAT（`APP_ENV=development`，`historicalDrillFixture` 可用） |
| 基线（开始前） | batches **177** / rows **14108** / archives **124** / conversions **26** / **tickets 489** |
| 受控合成夹具 | ✅ `svc:historicalDrillFixture`（**仅总部可签发**、生产 profile 拒绝、服务端登记 sha256） |
| 夹具 | `合成演练夹具-anomalies-DMVHGE3QV.xlsx`，18590 B，**sha256 `dddd5e75…c4602`**（本地实测与服务端返回值一致） |
| 上传账号 | `uat.store.a@svc.local`（门店 A），归属 S01 |

---

## 2. 上传（真实浏览器，CDP `DOM.setFileInputFiles`）

```json
{"s":200,"id":179,"no":"HI-20261021-ZCWSB3","hash":"dddd5e75…c4602","scope":"uploader"}
```

| 项 | 值 |
|---|---|
| batchId | **179** |
| batchNo | `HI-20261021-ZCWSB3` |
| fileHash | 与签发 sha256 **一致** |
| visibilityScope | `uploader`（P11-3 上传者语义 ✓） |
| **重复上传** | 再次上传同一文件仍返回 **179**（`reused`）→ **幂等 ✓**，没有产生 180 |
| 识别 | 1 张工作表 / 5 行；`物理行 6 = 表头 1 + 售后 5 + 排除 0` |

---

## 3. 字段映射（UI 实测）

自动映射结果（逐项可见）：

| 目标字段 | 映射到 |
|---|---|
| 客户姓名 | 第 3 列 · 姓名 |
| 联系电话 | 第 4 列 · 电话 |
| 牌名型号 | 第 5 列 · 机器信息 |
| 数量 | 第 6 列 · 数量 |
| 服务性质 | 第 8 列 · 性质 |
| 配送/安装日期 | 第 2 列 · 安装时间 |
| 回访日期 | 第 1 列 · 回访时间 |
| 服务结果 | 第 9 列 · 回访结果 |
| 销售单位 | 第 7 列（界面标注"**不会**据此写归属门店"） |

未映射项（服务地址/购机日期/接件/完工/派单/报修故障/维修措施/服务人员/回访记录）显示"不导入这一项"。

---

## 4. 预览（`svc:historicalPreview`）

```json
{"batchId":179,"mappingVersion":1,
 "counts":{"importable":3,"needs-confirm":2,"duplicate":0,"excluded":0,"parse-error":0},
 "quality":{"multiPhoneRows":1,"ambiguousDateRows":0,"missingPhoneRows":1,"abnormalReviewRows":1}}
```

- 每行都有 **Excel 原始行号 / 清洗前原值 / 清洗后候选值**；
- 一行多号、缺手机号、服务结果异常分别标注；
- 「可导入候选（仍需人工确认后才正式归档）」措辞明确。

---

## 5. 安全暂存（`svc:historicalStage`）

```json
{"batchId":179,"mappingVersion":2,"written":5,
 "counts":{"importable":3,"needs-confirm":2,...}}
```

候选行落库 5 条。

---

## 6. 异常确认（`svc:historicalReviewSummary`）

```json
{"importableCount":3,"needsConfirmCount":2,"candidateCount":5,
 "anomalyTypes":[
   {"key":"multiPhone","hitCount":1,"sampleRows":[{"rowId":14110,"sourceRow":3}]},
   {"key":"abnormalReviewResult","hitCount":1,"sampleRows":[{"rowId":14111,"sourceRow":4}]},
   {"key":"missingPhone","hitCount":1,"sampleRows":[{"rowId":14113,"sourceRow":6}]}],
 "anomalyUniqueRowCount":3,"anomalyHitCount":3,
 "blockingUniqueRowCount":2,"advisoryUniqueRowCount":1}
```

**正好印证你 §五 要求区分的两件事**：

- **异常命中 3 次**，涉及 **3 行**（同一行可命中多类）；
- **阻断 2 条**、**不阻塞提示 1 条**。

界面原话也写了"异常命中合计 3 次（同一行可命中多类，与行数不相等）"。

---

## 7. 归档页：**未执行最终归档**

点「下一步：确认归档」后到达归档页：

```
按钮：确认归属 / 确认归档 / 返回异常确认 / 关闭
文案：当前归属：未确认
      归档写入的是独立的历史售后档案，不是当前服务单；不会影响当前工单数量与 SLA/KPI
```

点「确认归属」弹出的对话框里，下拉只看到：

```
请选择
正式归属（真实历史资料）
```

**我没有看到"演练归属"这个选项**，所以**停在这里，没有点确认**。

**为什么不硬点**：`正式归属（真实历史资料）` 会把本次合成批次写成**真实门店归属**，这与"合成数据不得伪装成真实资料"直接冲突；而且这一步之后就是不可逆的归档写入。**宁可停在证据完整的地方，也不为了凑闭环去点一个我不确定后果的选项。**

---

## 8. 已知的版本膨胀（如实记录）

我这一轮为了探查流程，**跑了 3 次「安全暂存」**，于是 `historical_import_candidates` 里出现 **15 条**（5 行 × 3 个 mappingVersion）。

`mappingVersion` 递增是 P11-3 的**版本保留设计**（配合审计），**不是 bug**；但这说明：**重复点"安全暂存"会累积候选版本**，正式使用时应当避免。

---

## 9. 清理（按 batchId 精确）

```sql
begin;
delete from historical_import_candidates where batch_id=179;  -- 15
delete from historical_import_rows      where batch_id=179;  -- 5
delete from historical_import_batches   where id=179 and data_origin='synthetic';  -- 1
commit;
```

**清理后基线**：

| 表 | 值 | 基线 |
|---|---|---|
| batches | **177** | 177 ✓ |
| rows | **14108** | 14108 ✓ |
| archives | **124** | 124 ✓ |
| conversions | **26** | 26 ✓ |
| service_tickets | **489** | 489 ✓ |

---

## 10. 无副作用（已证）

| 项 | 结果 |
|---|---|
| serviceTickets | **489 → 489**（未增） |
| historical_ticket_conversions | **26 → 26**（未增） |
| 派工 / SMS / 工单事件 | 无（本流程未触达这些路径） |
| archives | **124 → 124**（未归档，所以未增） |

---

## 11. 结论

**前半段（上传 → 映射 → 预览 → 暂存 → 异常统计）全部通过，且都是真实浏览器操作。**

**后半段（归属确认 → 归档 → S2 查询）没做**，卡在一个具体问题上：

> **合成演练批次在「确认归属」里没有"演练归属"选项，只有"正式归属（真实历史资料）"。**

**需要你裁决**：
- 合成批次**应当**怎么归档？（走演练归属，还是允许以 `正式归属` 归档到演练门店再清理？）
- 或者 P11-3 里本来就有一个我还没找到的演练归属入口（在别的位置/别的开关）？

**在你答复之前我不点那个按钮**——它一旦写错就是真实的归属数据。

**第二关不申请 PASS。**
