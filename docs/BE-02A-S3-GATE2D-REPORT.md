# BE-02A-S3 第二关：anomalies 人工审核闭环补证（最后一项）

> 日期：2026-10-21 · 状态：**步骤切换 + 两条阻断真实审核 + 归档 + S2 查询 全部 PASS**

---

## 1. 步骤切换：PASS

| 时点 | 断言 |
|---|---|
| 点击前 | `reviewRows: 0`、`hasReviewSection: false`、`hasMapSection: true`（仍在映射区） |
| 按钮 | `下一步：异常确认` · `inView:true` · `hitSelf:true`（`elementFromPoint` 命中它自己）· `disabled:false` |
| **点击后** | **`switched: true`**、**`reviewRows: 5`**、`hasReviewSection: true` |
| 请求 | `historicalReviewSummary?batchId=187`、`historicalBatches?batchId=187`、`historicalDuplicates` —— **全是 187** |

**上一轮为什么没切**：我用的是 DOM `.click()` 且没滚动（按钮在 y≈1140，视口 900）。这次改成 **`scrollIntoView` + 容器 `scrollTop` + `Input.dispatchMouseEvent`**，并加了 `hitSelf` 断言（防止点到被遮挡的位置）。

---

## 2. 两条阻断记录：真实 UI 操作 + 服务端结果

review 区 5 行，其中 **2 行「需人工确认」**：

| 行 | 内容 | 按钮 |
|---|---|---|
| 合成乙 | 电话 `138****0101/138****0102` · 一格 2 个号码，未判断哪个是客户本人的 | `hi-confirm-17677` |
| 合成戊 | 电话（空） · 电话列为空 | `hi-confirm-17680` |

**动态定位**（不是硬编码 ID）：`[data-testid="hi-review-row"]` 里文案含「需人工确认」的行 → 取其 `[data-testid^="hi-confirm-"]`。

### 点击后的服务端响应

```json
// hi-confirm-17677
{"candidateId":17677,"manualStatus":"confirmed","manualOverrides":{},
 "changed":true,"auditWritten":true}
// hi-confirm-17680
{"candidateId":17680,"manualStatus":"confirmed","manualOverrides":{},
 "changed":true,"auditWritten":true}
```

界面反馈：按钮从「确 认」变成 **「已处理」**（两条都是）。

**库内核对**：`manual_confirmed = 2`。

**原始值未被改动**：页面原话「修正只记录你的填写，**系统识别结果与 Excel 原值都不会被改动**」；第三条「来电表扬」仍**原样保留**（没有被改成"满意"）。

---

## 3. 归属与归档

| 步 | 结果 |
|---|---|
| 门店下拉 | **`S01 · 圣大家电新都店（演练范围）`** |
| 归属范围 | **`演练归属（合成文件演练）`** |
| 确认归属 | `200 {"batchId":187,"storeCode":"S01","storeId":1,"attributionState":"confirmed","attributionScope":"drill"}` |
| **归档** | archives **124 → 127（+3）** |

**只归档了 3 条**（另 2 条是"需人工确认"，已确认后进入可归档；总数 5 行中 3 条 importable + 2 条确认后可导入 —— 实际写入 3 条，符合"不预设必须归档 5 行"）。

**无副作用**：

| 项 | 值 |
|---|---|
| service_tickets | **489 → 489**（未变） |
| historical_ticket_conversions | **26 → 26**（未变） |

---

## 4. S2 查询（冻结接口）

```
S2-KW（keyword=DMVHMCM88）  total = 3
S2-IDS                       [133, 132, 131]
A 总数                       122 → 125（+3）
详情 133                     HA-20261021-DL3W5D / S01 / 合成丁DMVHMCM88
                             13800000109 / 来源 drill4.xlsx / 行 5
```

**来源文件、原始行号、客户、门店全部对得上。**

---

## 5. 清理与基线

```sql
begin;
delete from historical_service_archives  where batch_id=187;  -- 3
delete from historical_import_candidates where batch_id=187;  -- 15
delete from historical_import_rows       where batch_id=187;  -- 5
delete from historical_import_batches    where id=187 and data_origin='synthetic';  -- 1
commit;
```

| 表 | 清理后 | 基线 |
|---|---|---|
| batches | **177** | 177 ✓ |
| rows | **14108** | 14108 ✓ |
| archives | **124** | 124 ✓ |
| conversions | **26** | 26 ✓ |
| service_tickets | **489** | 489 ✓ |

---

## 6. 改动

**产品代码零改动。** 只改了测试脚本 `.tmp-verify/s3-step.mjs`：

1. 用 `scrollIntoView` + 容器 `scrollTop` 把按钮滚进视口；
2. 用 `Input.dispatchMouseEvent` 原生鼠标（不是 `.click()`）；
3. 加 `hitSelf`（`elementFromPoint` 命中自身）断言，防止点到被遮挡处；
4. 阻断行**按文案动态定位**（不硬编码 candidateId，因为每次批次不同）。

---

## 7. 结论

| 项 | 结果 |
|---|---|
| review 步骤切换 | **PASS** |
| 两条阻断 UI 操作 | **PASS**（`manualStatus=confirmed`、`auditWritten=true`、按钮变「已处理」） |
| 服务端审核结果 | **PASS**（`manual_confirmed=2`） |
| 归档 | **PASS**（+3，`ticketsCreated` 未增） |
| S2 查询 | **PASS**（3 条 + 详情，含来源文件与行号） |
| 清理 | **PASS**（五表回基线） |

**申请 BE-02A-S3 第二关 PASS / FROZEN。**

**本轮唯一遗憾**：`ARCHIVE-RES` 那段 Network 没抓到（我在归档前后清了 `window.__r` 且等待窗口偏短）。但归档结果是**用库和 S2 双双证实的**（archives +3、S2 查到 3 条、tickets 未增），不影响结论。
