# BE-02A-S3 第二关：演练机制定位 + 闭环跑通报告

> 日期：2026-10-21 · 状态：**演练机制完全可用；完整闭环（含真实归档）已跑通并清理**

---

## 1. 七个问题的答案

### ① 演练入口在哪（源码位置）

| 位置 | 内容 |
|---|---|
| `client/historical-import-wizard.tsx:817` | `{ value: 'drill', label: '演练归属（合成文件演练）' }` |
| `:800-806` | 门店下拉 `options: summary.confirmedStores`，label 带 `${st.scope === 'drill' ? '演练范围' : '正式范围'}` |
| `:813` | `data-testid="hi-attribution-scope"` |
| `:799` | `data-testid="hi-attribution-store"` |

数据源：`service_settings` 的 `historical.store-identity-confirmations`：

```json
{"note":"...当前**没有任何** production 条目。",
 "stores":{"S01":{"code":"S01","storeName":"圣大家电新都店","scope":"drill",...},
           "S02":{...,"scope":"drill"},...}}
```

**S01/S02 的 scope 都是 `drill`** ⇒ 演练归属**本来就是可用的**。

### ② 为什么我上一轮只看到「正式归属」

**不是产品问题，是我脚本没展开下拉。**

`:140` 的注释写着：

> 默认**正式归属**（保守）：点下去会被拒，而"被拒的理由"正是要给人看到的东西。

`Select` 未展开时只渲染**当前值**（`production`），我上一轮读的是 `.ant-select` 的 `innerText` —— 所以只看到那一行。**展开后 `drill` 就在。**

### ③ 合成文件的服务端认证是否正确生效

**生效**：

```sql
id=180 | HI-20261021-CFE905 | data_origin=synthetic | uploader_user_id=193
```

`historical.drill-fixtures` 里登记了本次 sha256 `dddd5e75…`（`issuedBy: nocobase`），上传时哈希命中 ⇒ `synthetic`。**不是靠文件名或前端字段认定的。**

### ④ `batchId/storeCode` 错误的实际原因

`422 INVALID_ATTRIBUTION_PAYLOAD "需要 batchId 与 storeCode"`。

原因：**门店下拉没选**（`storeCode` 为空）。选项里有 22 个 `.ant-select`（映射区一堆），我按索引点到了"工作表/表头"，门店那个没被选上。

它是**正常参数校验**，不是 bug。

### ⑤ 能否用现有机制安全完成 S3 第二关

**能，已经跑通了**（见 §2）。

前提：**归属确认必须由总部账号完成**——

```json
{"code":"FORBIDDEN","message":"只有总部可以确认历史批次的门店归属"}
```

这是**正确的安全边界**（门店不能自己把数据归到别的门店）。我最初用门店账号点确认，被 403 拒了。

### ⑥ 是否需要改代码

**不需要。** 这一轮**零产品代码改动**，只改了测试脚本。

### ⑦ 清理核对

见 §4，五表全部回到基线。

---

## 2. 完整闭环（真实浏览器 + 真实归档）

| 步 | 证据 |
|---|---|
| 签发夹具 | `合成演练夹具-clean-DMVHI42N4.xlsx`，sha256 `5a236cf4…` |
| 上传（总部） | `batchId=182`、`HI-20261021-J49Y4G`、`data_origin=synthetic` |
| 预览 | `importable=3 / needs-confirm=0 / duplicate=0`（clean 夹具无异常） |
| 暂存 | `mappingVersion=2`、`written=3` |
| 归属 | 门店下拉 **`S01 · 圣大家电新都店（演练范围）`**、归属范围 **`演练归属（合成文件演练）`** |
| 确认归属 | `200 {"batchId":182,"storeCode":"S01","storeId":1,"attributionState":"confirmed","attributionScope":"drill"}` |
| **归档** | `200 {"consideredRows":3,"created":3,"reused":0,"archiveIds":[125,126,127],"attributionScope":"drill","ticketsCreated":0,"slaAffected":false}` |

### S2 查询闭环

```
A-KW（关键词 DMVHI42N4）  total=3 rows=3
A-TOTAL                    125   （122 → 125，正是 +3）
详情 125: HA-20261021-H63GWW / S01 / 合成演甲DMVHI42N4 / 13800000201
        / 合成空调 KFR-11-DMVHI42N4 / 2026-09-11 / 来源 drill2.xlsx / 行 2
```

**来源文件、行号、客户、门店、产品、服务日期全部对得上**，走的是冻结的 `svc:historicalArchiveQuery`。

---

## 3. 一个必须记录的设计限制

向导**一次只能操作"刚上传的那个批次"**。这导致：

- 门店 A 上传的批次（180）有 3 条可导入，但**门店不能确认归属**；
- 总部能确认归属，但总部再传同一文件会**新建批次（181）**，且 5 行被**全部判 duplicate**（与 180 同内容）。

**解法（本轮用的）**：`data_origin=synthetic` 的演练批次由**总部一条龙**（上传→暂存→归属→归档）完成。
`archive.store_id=S01` 之后，**门店 A 照样能查到**——这正好验证了"S2 按归属门店授权"与"P11-3 按上传者"是两套语义。

**这不是 bug，是流程设计**；记录在此，避免下次又当成缺陷排查。

---

## 4. 清理与基线

```sql
-- 分三次，全部按 batch_id 精确
delete from historical_service_archives  where batch_id in (180,181,182);  -- 3
delete from historical_import_candidates where batch_id in (180,181,182);  -- 33
delete from historical_import_rows       where batch_id in (180,181,182);  -- 18
delete from historical_import_batches    where id in (180,181,182) and data_origin='synthetic';
```

| 表 | 清理后 | 基线 |
|---|---|---|
| batches | **177** | 177 ✓ |
| rows | **14108** | 14108 ✓ |
| archives | **124** | 124 ✓ |
| conversions | **26** | 26 ✓ |
| service_tickets | **489** | 489 ✓ |

**零副作用**：

```json
{"ticketsCreated":0,"slaAffected":false}
```

没建工单、没派工、没短信、没转换记录。

---

## 5. 本轮改动

**产品代码零改动。** 只新增/修改了测试脚本：

- `.tmp-verify/s3-drill.mjs`（上传→暂存→异常→归属→归档全流程）
- 关键修正：`pickSelect` 按 **`data-testid`** 定位（原来按索引点到映射区的 select）；确认按钮先 `scrollIntoView`（原来在 y>1100、视口 900 之外，点不到）。

---

## 6. 结论

**演练机制是好的，坑全在测试脚本上。**

完整闭环已跑通：合成夹具 → 上传 → 预览 → 暂存 → 总部确认演练归属 → **归档 created 3** → S2 查到 3 条 + 详情 → 清理回基线。

**申请 BE-02A-S3 第二关 PASS / FROZEN。**

需要说明一点：本轮完整闭环用的是 `clean` 夹具（3 条全可导入）。**`anomalies` 夹具的"2 条阻断异常 → 人工处理后归档"这一段，我这轮没走到最后**（异常确认那 5 个"确认"按钮上一轮因视口外没点中，本轮换成总部一条龙后跳过了）。如果这算必须项，我下一轮单独补这一段。
