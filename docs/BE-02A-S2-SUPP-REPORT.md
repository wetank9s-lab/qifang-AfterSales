# BE-02A-S2 第二关补证报告（四组 + 顺带修的 3 个真缺陷）

> 日期：2026-10-20 · 状态：**门店筛选/组合/快速连点 PASS；日期双边 UI 未验证成功**
> 未 commit / 未 push。

---

## 1. 四组结果

| 组 | 结果 |
|---|---|
| 1. 门店筛选 | ✅ **S01 → 122 条；S02 → 0 条**（不越权） |
| 2. 日期筛选 | ⚠️ **单边通过，双边 UI 未验成功**（见 §3） |
| 3. 组合筛选 | ✅ `keyword=合成丁&storeCode=S01` → 29 条；重置 → 122 条 |
| 4. 快速连续查询 | ✅ 先 S02 后立刻 S01，最终显示 **S01 / 122 条**（新响应覆盖旧） |

### 门店筛选原始日志

```
STORE-S01 req=/api/svc:historicalArchiveQuery?page=1&pageSize=20&storeCode=S01  → 共 122 条
STORE-S02 req=/api/svc:historicalArchiveQuery?page=1&pageSize=20&storeCode=S02  → 0 行 / total 空
RESET     req=/api/svc:historicalArchiveQuery?page=1&pageSize=20                → 共 122 条
```

### 组合与快速连点

```
COMBO       keyword=合成丁&storeCode=S01        → 共 29 条
COMBO-RESET （无参数）                          → 共 122 条
RACE        先 S02(0) 后 S01(122)，最终          → S01 / 共 122 条
```

---

## 2. 本轮顺带修了 3 个真实缺陷 + 1 个 seed 缺陷

这些不是"为了验收改代码"，是验证时**撞出来的真问题**：

| # | 缺陷 | 现象 | 修法 |
|---|---|---|---|
| 1 | **重置不生效** | 点重置后请求仍带 `keyword`，total 还是 29 | `load()` 显式接收筛选参数，`reset()` 传空值（setState 是异步的） |
| 2 | **`DatePicker.RangePicker` 不渲染** | 日期控件整块消失（`pickers: 0`） | 换成**两个独立 `DatePicker`**（`DatePicker` 在项目白名单里且 BE-04 验证过） |
| 3 | **日期 onChange 读闭包** | 只点出 `dateFrom`，`dateTo` 丢失 | 改成**函数式** `setRange(prev => …)` |
| 4 | **`--only` 会把页面打回 markdown** | 跑过 `--only 历史售后档案` 后，页面打开空白 | `--only` 分支补跑 `seedHistoricalArchivesBlock()` |

第 4 条尤其重要：`applyBlueprint(replace)` 会重建区块，`use` 被打回 `MarkdownBlockModel`，而 seeder 只在全量流程里跑。**这正是"重复 Seed 不重新产生错误模型"的反例**，已修。

修复后 `--only` 输出：

```
· 历史售后档案区块：✓ 已挂 HistoricalArchivesBlockModel（via declaredKey · uid 082by9iepn7 · HTTP 200）
=== 汇总（--only）：0 项未达标 ===
```

---

## 3. 日期双边：没验成功，如实说明

**做出来的**：
- 单边能用：点「开始日期」→ `dateFrom=2026-09-30` 正确进请求，服务端过滤生效（total 变 0）。
- 接口层早前已验证双边：`dateFrom=2026-08-01&dateTo=2026-08-31` → **22 条**（S2 收口前那轮）。

**没做出来的**：
- 脚本连续点两个 `DatePicker` 时，**两次 onChange 都落在第一个 picker 上** ⇒ 请求只有 `dateFrom`、没有 `dateTo`。

**为什么**：两个 picker 相邻，点第二个格子时第一个面板还开着，点击落到了旧面板。我加了「点完按 Esc + 点空白关面板」仍然复现。

**我的判断**：这是**自动化脚本的交互问题**，不是产品缺陷——`onChange` 已改成函数式（`prev => …`），产品逻辑上两个值互不覆盖。但我**没有真机手动点过的证据**，所以标"未验证"，不硬说通过。

**建议**：这条要么由人工在浏览器点一次（10 秒），要么我下一轮改用 CDP `Input.dispatchMouseEvent` 按坐标点击（比 DOM `.click()` 更接近真实操作）。

---

## 4. Seed 与重登

| 项 | 结果 |
|---|---|
| 全量 Seed ×2 | 6/0、6/0（uid 两次不同仍挂上） |
| `--only`（修后） | 0 未达标，区块挂上 |
| 重登 | 菜单唯一、页面能开、无重复区块（`panelCount=1`） |

---

## 5. 数据与冻结

| 项 | 值 |
|---|---|
| 历史四表 | 177 / 14 108 / 124 / 26 **未变** |
| 原生 ACL / listMeta / P11-3 算法 | 未改 |
| SEC-HIST-01 / HQ-HIST-01 | 修复保留 |
| Git | 未 commit / 未 push |

---

## 6. 结论

**门店筛选、组合、快速连点、Seed、重登都通过**；本轮额外修掉 4 个真缺陷（其中 `--only` 那个会直接让页面变空白）。

**只有"日期双边 UI 组合"这一项没有真机证据**——我建议不因为它卡签收（接口层已证、单边已证、缺陷已修），但要你确认是"接受人工补一次点击"还是"要我下一轮用坐标点击再验"。

诚实结论：**距 PASS 只差这一条证据。**
