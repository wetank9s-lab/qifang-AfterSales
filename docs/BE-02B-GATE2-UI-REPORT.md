# BE-02B 第二关前置：历史档案转单 UI 接线报告

> 日期：2026-10-21 · **申请 PASS（UI 层）**
> 未调用转单写接口、未建单、未改档案状态。未 commit / push。

---

## 1. 修改文件与最小 diff

**唯一改动**：`nocobase/plugins/service-ticket/src/client/historical-archives-block.tsx`

| # | 改动 | 行数 |
|---|---|---|
| 1 | 新增 `maskMobile()` + `ConversionPanel()` 组件 | +176 |
| 2 | `DetailBody` 增加 `request` / `onChanged` 两个 props，末尾渲染 `<ConversionPanel>` | +2 / −1 |
| 3 | 调用处传参 | 1 行改 |

**没动**：`fetch` / 筛选 / 分页 / 详情字段 / `Row`/`Detail` 类型 / 服务端任何文件。

```diff
-function DetailBody({ d }: { d: Detail }) {
+function ConversionPanel({ d, request, onChanged }: {...}) { ... }   // 新增
+
+function DetailBody({ d, request, onChanged }: { d: Detail; request: any; onChanged?: () => void }) {

       <Tag ...>转单状态：{d.conversionState || '未转换'}</Tag>
+      <ConversionPanel d={d} request={request} onChanged={onChanged} />
     </div>

-<DetailBody d={detail} />
+<DetailBody d={detail} request={request} onChanged={() => { void openDetail(detail.id); void load(page, pageSize); }} />
```

---

## 2. 状态分支实现

| 档案状态 | 渲染 | data-testid |
|---|---|---|
| `conversionState === 'converted'` | 绿色成功提示，**无按钮** | `be02b-converted` |
| **无手机号** | 提示"缺手机号"+ **禁用按钮** | `be02b-no-mobile` / `be02b-convert-disabled` |
| 已归档 + 未转换 + 有手机号 | **「转为服务单」按钮** | `be02b-convert-open` |
| `stage !== 'archived'` | — | **天然不可达**：`historicalArchiveQuery` 详情强制 `filter.stage='archived'`，非归档档案根本查不到 |

> 关于"已转换显示工单号"：**详情接口不返回 `ticketNo`**（`archive` 只有 `conversionState`）。本轮不改服务端，所以：
> - **本次转换成功** → 显示服务端返回的 `ticketNo`（满足要求）；
> - **历史已转换的** → 显示"已转成当前服务单，不可重复转换"（**拿不到号**）。
> 这是**已知限制**，要补号需在 `historicalArchiveQuery` 里加一个 join 字段——**需你单独授权改服务端**。

---

## 3. 确认弹窗

**只读展示**（实测文案）：

```
客户姓名：合成丁DMV6CL3QG
联系电话：****0109            ← 脱敏（末四位）
原归属门店：S01
历史问题 / 设备：合成微波炉 MW-09-DG6CL3QG
历史服务日期：2026-08-13
处理结果：演练归档 RMV6CL3GF
来源：合成演练夹具-anomalies-DM6CL3QG.xlsx · 合成 · 第 5 行
将创建的工单类型：报修
```

**输入**：转单理由（必填 ≥4 字，`maxLength 200`）+ 备注（选填，`maxLength 120`）。

**防误触**：
- 打开详情**不会**自动提交；
- 理由 <4 字 ⇒ 提交按钮 **disabled**；
- `busy` 期间 `okText` 变"提交中…"、`confirmLoading`、`onCancel` 直接 return；
- 错误原样显示在弹窗内（`be02b-convert-error`），**不吞、不伪装成功**。

---

## 4. 幂等键怎么复用

**前端不需要造 Request-Id。** 服务端的幂等键是 `buildConversionIdempotencyKey(archiveId)`——**按 archiveId 派生**。

⇒ 只要用户不换档案，**网络重试天然命中同一个键**，返回 `reused:true` + 原工单。前端**没有、也不该有**自己的重试逻辑。

---

## 5. 专项门禁运行结果（`be02b-gate.mjs`）

**全程拦截 `historicalConvertToTicket`**：`window.fetch` + `XHR` 双覆写，命中即返回伪造 403，**请求不出浏览器**。

| 检查 | 结果 |
|---|---|
| S2 列表仍 20 行、搜索框在 | ✅ `rows:20, hasSearch:true` |
| 打开档案 124 → 面板出现 | ✅ `hasPanel:true` |
| 分支判定 | ✅ **`branch:'open'`**（未转换 + 有手机号） |
| 弹窗字段齐全 | ✅ 8 项全在 |
| **手机号脱敏** | ✅ `****0109`，`rawMobileLeak:false`（无 11 位明文） |
| 提交初始禁用（理由空） | ✅ `submitDisabled:true` |
| 理由填「短」(<4 字) | ✅ 仍 `submitDisabled:true` |
| **取消不发请求** | ✅ `blocked:0` |
| 合法理由提交 → 被拦截 403 | ✅ `blockedDelta:1` |
| **错误可见** | ✅ `hasError:true`，文案 `Request failed with status code 403` |
| **不显示成功** | ✅ `hasSuccess:false` |
| **零真实写入** | ✅ `ZERO-WRITE {blocked:1}` —— **1 次拦截、0 次真发** |

> `hasPager:false` 是因为当前正好 20 条一页（`pageSize=20`），分页组件未渲染，**不是分页坏了**。

---

## 6. 构建

```
✅ 插件构建成功
（只有既有的 date-range-item-model.tsx TS2347 噪声，与本次改动无关）
已 docker compose restart app → READY
```

---

## 7. 未触发转单写入的证据

1. **拦截层**：`urls` 只记录到 1 条，且被 `fetch` 覆写直接 `return 403` —— 没有落到网络；
2. **数据库**：门禁前后 `service_tickets` / `historical_ticket_conversions` / `archive.conversion_state` 未变（见下）；
3. **没有调用任何服务端写接口**（上传/暂存/转单都没跑）。

数据库只读复核：

| 表 | 值 |
|---|---|
| service_tickets | **489** |
| historical_service_archives | **124**（98 none / 26 converted） |
| historical_ticket_conversions | **26** |

---

## 8. 隔离 UAT 插件启用问题：**仍未解决**

上次起的 `svc-app-uat` 已停。**插件未在新库启用**（`store-entry` 404）这条路**没有推进**——本轮把精力放在 UI 与门禁上。

**当前状态**：Gate 2 的隔离环境**仍不可用**。三个选项还在桌上：

| 选项 | 状态 |
|---|---|
| A. 真隔离（`pm:enable` + 账号 + seed + H5 转发） | 未做，工作量大 |
| B. 原库写入 + 精确清理 | **未获授权** |
| C. 一次性隔离库（建 → 测 → 整库销毁） | 需要先解决 A 的插件问题 |

---

## 9. 专用转单清理方案（设计，未实施）

现有 `purge-ux01b-ticket.mjs` **不够**——它只删工单，不会：

- 删 `historical_ticket_conversions` 的那一行
- 把 `archive.conversion_state` 改回 `none`
- 清工单幂等记录（`idempotency` 表）

**方案**（Gate 2 前要落地）：

```
① 转单前记录：archiveId、原 conversion_state、conversions 行数
② 转单后清理（按 ticketId + archiveId 双键）：
   - service_tickets / ticket_events（沿用现有工具）
   - historical_ticket_conversions where archive_id=<本次>
   - archive.conversion_state → 'none'（仅当本次确实由它改成 converted）
   - 工单幂等记录（按 idempotency_key=buildConversionIdempotencyKey(archiveId)）
③ 校验：archive 回到 98/26 分布，conversions 回到 26
```

**或者更干净**：Gate 2 用**一次性隔离库**，测完**整库销毁**（保留截图/响应作为证据）。**我倾向这个**——它不需要写"回滚脚本"这种容易出错的东西。

---

## 10. Git 状态

| 项 | 值 |
|---|---|
| 改动 | `historical-archives-block.tsx`（+176/−2） |
| 新增文档 | `docs/BE-02B-GATE2-UI-REPORT.md` |
| 新增脚本 | `.tmp-verify/be02b-gate.mjs`（临时） |
| commit / push | **无** |

---

## 11. 申请

**BE-02B 第二关前置（UI 接线）：PASS。**

| 项 | 状态 |
|---|---|
| UI 接线 | **PASS** |
| 专项门禁（无写入） | **PASS** |
| 构建 | **PASS** |
| 零写入证据 | **PASS** |
| 已转换显示工单号 | **PENDING**（需改服务端返回字段，未授权） |
| Gate 2 真实转单 | **BLOCKED**（隔离环境未就绪） |

**不自行启动 Gate 2。** 停在此处等你裁决：

1. 要不要为"已转换显示工单号"开一个小口子改 `historicalArchiveQuery`（加 `convertedTicketNo`）？
2. Gate 2 走**一次性隔离库**（整库销毁）还是**原库 + 回滚脚本**？
