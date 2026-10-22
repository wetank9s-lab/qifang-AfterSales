# BE-02B Gate 2：历史档案转正式服务单真实闭环验收报告

> 日期：2026-10-22 · **申请 BE-02B Gate 2：PASS / FROZEN**
> 全程只在隔离 UAT（`svc-app-uat` / `service_ticket_verify` / `storage-uat`）执行；原库未变；未 commit / push。

---

## 1. 隔离环境写入前快照

| 项 | 值 |
|---|---|
| 容器 | `svc-app-uat`（13001，Up） |
| `DB_DATABASE` | **`service_ticket_verify`** |
| `STORAGE_PATH` | `/app/nocobase/storage`（挂 `./storage-uat`） |
| `SMS_PROVIDER` / `SMS_ENABLED` | **`mock` / `false`** |
| 隔离库基线 | tickets **0** / conversions **0** / archives **6** / idem **0** |
| 原库基线 | tickets **489** / archives **124** / conversions **26** |

---

## 2. 首次真实浏览器转换（archiveId=4）

**流程**：S01 账号（`uat.store.a@svc.local`，`store_after_sales`）→ 历史售后档案 → 档案 4 详情 → 点「转为服务单」→ 核对弹窗 → 填理由「客户来电要求继续处理」→ 确认。

**弹窗内容**（实测）：

```
客户姓名：合成演甲DMVHXLMH6
联系电话：****0201          ← 脱敏
原归属门店：S01
历史问题 / 设备：合成空调 KFR-11-DMVHXLMH6
历史服务日期：2026-09-11
处理结果：—
来源：合成演练夹具-clean-DMVHXLMH6.xlsx · 合成 · 第 2 行
将创建的工单类型：报修
```

**UI 反馈**：`转单状态：converted` + 绿色「该档案已转成当前服务单，不可重复转换」。

> ⚠️ 网络钩子（`fetch` 覆写）**没抓到请求** —— NocoBase 客户端走的是 axios（XHR），不是 `fetch`。所以本报告以**数据库实际写入**为准，不以 UI 文本为准。

---

## 3. 实际写入证据

| 表 | 写入前 | 写入后 |
|---|---|---|
| `service_tickets` | 0 | **1** |
| `historical_ticket_conversions` | 0 | **1** |
| `idempotency_records` | 0 | **1** |
| 档案 4 `conversion_state` | none | **converted** |

**新工单**：

```
id=1  ticket_no=FW20261022-0001  store_id=1(S01)  status=NEW  source=staff
customer_name=合成演甲DMVHXLMH6  customer_mobile=13800000201
content=[历史转入] 客户来电要求继续处理
```

**转换记录**：

```
archive_id=4  ticket_id=1  ticket_no=FW20261022-0001
reason=客户来电要求继续处理  converted_by_username=UAT-A-VERIFY
idempotency_key=91a544273a73f777…（sha256）
snapshot_json={"archiveNo":"HA-20261021-EIIJYO","storeCode":"S01","mappingVersion":3,
               "sourceFileName":"合成演练夹具-clean-DMVHXLMH6.xlsx","sourceSheet":"合成","sourceRow":2}
```

**来源标记**（实测落点）：

```json
// ticket_events.metadata_json（ticket_id=1, event_type=created）
{"store_code":"S01","store_name":"新都圣大家电","ticket_type":"repair","source":"staff",
 "historicalConversion":{"archiveId":4,"archiveNo":"HA-20261021-EIIJYO",
                         "batchId":1,"dataOrigin":"synthetic","drill":true}}
```

**一处已接受的设计差异（2026-10-22 正式裁决）**：

验收令原文要求 `service_tickets.extra_json.historicalConversion.archiveId`。**实测 `extra_json` 为 null**，来源标记落在 **`ticket_events.metadata_json`**。

原因在代码：`ticket-service.ts:830` 把 `input.metadata` 合进的是**事件的 metadata**，不是工单的 `extra_json`。

**正式裁决结论**：`extra_json.historicalConversion.archiveId` **修正为非强制字段**，不要求修改服务端。登记为「**设计文档与现有实现的字段位置不一致，已接受现有实现**」。

**不是**未修复的产品 Bug；本源追溯由三处共同承担：

| 载体 | 承担的内容 |
|---|---|
| `ticket_events.metadata_json.historicalConversion` | `archiveId / archiveNo / batchId / dataOrigin / drill` |
| `historical_ticket_conversions` | `archive_id` ↔ `ticket_id / ticket_no` 关联 |
| `historical_ticket_conversions.snapshot_json` | `archiveNo / mappingVersion / sourceFileName / sourceSheet / sourceRow` |

---

## 4. 幂等重试

同一 `archiveId=4`、同一理由，再发一次：

```json
{"action":"historicalConvertToTicket","archiveId":4,
 "reused":true,"recovered":true,"ticketId":1,"ticketNo":"FW20261022-0001"}
```

| 项 | 结果 |
|---|---|
| `reused` | **true** |
| `recovered` | **true**（幂等记录命中，补齐关联） |
| 返回工单 | **仍是 1 / FW20261022-0001** |
| `service_tickets` | **1 → 1**（未增加） |
| `historical_ticket_conversions` | **1 → 1**（未增加） |
| `idempotency_records` | **1 → 1** |

**幂等键由 `archiveId` 派生**（服务端 `buildConversionIdempotencyKey`），前端没有、也不需要自己的 Request-Id。

**故障注入**：本轮**未运行** `x-svc-fault: convert-after-ticket`。引用 P11-3 既有门禁（79/79 内已验证"响应丢失后重试收敛到同一单"），**适用边界**：同版本服务端、同一 archive 级幂等键。

---

## 5. 权限反例（隔离库实测）

| 角色 / 场景 | 结果 |
|---|---|
| S01 `store_after_sales`（archive 4） | **200**，建成 FW20261022-0001 |
| **S02 `store_after_sales`**（archive 5 属 S01） | **403 `CROSS_STORE_FORBIDDEN`** |
| **`hq_after_sales`** | **403 `STORE_STAFF_ONLY`** |
| **`hq_admin`** | **403 `STORE_STAFF_ONLY`** |
| **`viewer`** | **403 `STORE_STAFF_ONLY`** |
| **匿名** | **401 `EMPTY_TOKEN`** |
| **伪造 `storeId:2 / storeCode:'S02'`** | **200 但工单 `store_id=1`（S01）** —— 伪造**无效** |

**拒绝后的副作用核对**：`service_tickets` 仍为 1、`conversions` 仍为 1、档案 5 仍 `none` —— **拒绝路径没有写入任何东西**。

（伪造测试本身是一次成功转换：`ticketId=2 / FW20261022-0002`，归属仍是 S01。）

---

## 6. 副作用核查

| 项 | 结果 |
|---|---|
| `sms_logs` | **0**（未发短信） |
| `service_visits` | **0**（未派工） |
| 重复工单 | **无**（幂等保证） |
| 其它档案 | **未变**（1/2/3/5→converted 只 5，6 仍 none） |
| 原有 26 条转换记录 | **未触碰**（那是原库，本轮在隔离库） |
| SLA 起算 | 新工单 `status=NEW`、按当前时间起算；**未把历史服务日期当作起算时间** |

---

## 7. 清理与销毁

**销毁前核对独占**：容器名 `svc-app-uat`、库名 `service_ticket_verify`、目录 `storage-uat` —— 三者都只在本次创建。

```bash
docker stop svc-app-uat && docker rm -f svc-app-uat
psql -d postgres -c "drop database service_ticket_verify"
rm -rf storage-uat
```

**销毁后核对**：

| 项 | 结果 |
|---|---|
| `svc-app-uat` 容器 | **不存在** |
| `*verify*` 数据库 | **0 条** |
| `storage-uat` 目录 | **不存在** |

**未触碰**：`svc-app`（仍 Up healthy）、`service_ticket` 库、`./storage`。

---

## 8. 原业务库未受影响（只读证据）

| 表 | 值 |
|---|---|
| service_tickets | **489** |
| historical_service_archives | **124** |
| historical_ticket_conversions | **26** |
| ticket_events | **1827** |
| customer_medias | **551** |

**全部与写入前基线一致。**

---

## 9. 测试覆盖边界（如实记录，不冒称本轮全部重跑）

| 项 | 状态 | 说明 |
|---|---|---|
| **故障注入**（`x-svc-fault: convert-after-ticket`） | **本轮未重跑** | 引用 P11-3 既有 79/79 门禁证据；适用边界：同版本服务端 + 同一 archive 级幂等键 |
| **UI 层"无权限角色看不到按钮"** | **本轮未做独立显示测试** | 服务端权限反例（403/401）已全部通过；UI 只在前置轮验过按钮显隐分支 |
| **已转换档案显示旧工单号** | **未实现** | 详情接口不返回 `ticketNo`，属后续**可选优化**（需服务端加字段，本轮未授权） |
| 媒体上传 | 与本次转单无关，未做 | |
| 短信真发 | `SMS_ENABLED=false`，设计上不会发 | 未做正面验证 |

---

## 10. Git 状态

| 文件 | 改动 |
|---|---|
| `nocobase/plugins/service-ticket/src/client/historical-archives-block.tsx` | 转单 UI（第二关前置，已 FROZEN） |
| `scripts/seed-admin-pages.mjs` | `--base` + `envValue`（环境工具） |
| `docs/BE-02B-*.md` | 各阶段报告 |

**未 commit / push。**

---

## 11. 结论

| 项 | 结果 |
|---|---|
| 隔离环境写入前核对 | **PASS** |
| 真实浏览器首次转换 | **PASS** |
| 工单/转换/幂等/档案状态一致性 | **PASS** |
| 来源追溯（snapshot + event metadata） | **PASS**（`extra_json` 落点与文档措辞有差异，已说明） |
| 幂等重试 | **PASS**（`reused:true, recovered:true`，计数不变） |
| 权限反例（5 类 + 伪造） | **PASS** |
| 副作用（短信/派工/重复单） | **PASS**（全 0） |
| 环境销毁 | **PASS**（无遗留） |
| 原库未受影响 | **PASS** |

**申请 BE-02B Gate 2：PASS / FROZEN。**

**2026-10-22 正式裁决：PASS / FROZEN 已签收。**

`extra_json` 那处已按裁决登记为「设计文档与实现字段位置不一致，已接受」，**不列为 Bug，不要求改服务端**。

BE-02B 整体仍 **IN PROGRESS**（Gate 2 只是其中一关，待独立整体签收）；BE-02A 继续 PASS / FROZEN；Release 继续 HOLD。
