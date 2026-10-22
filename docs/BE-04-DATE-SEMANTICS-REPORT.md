# BE-04-DATE 操作符语义校准报告

> 日期：2026-10-20 · 结论：**语义已校准（12/12）**，UI 组件未实施
> 依据：NocoBase **2.2.15** 源码 + 6 个边界夹具 + SQL 独立对照
> 未 commit / 未 push。

---

## 1. 源码证据（不是猜名字）

文件：`/app/nocobase/node_modules/@nocobase/database/lib/operators/date.js`

```js
$dateOn(value, ctx) {
  const r = parseDate(value, { timezone: parseDateTimezone(ctx) });
  if (typeof r === 'string') return { [Op.eq]: toDate(r) };
  if (Array.isArray(r))
    return { [Op.and]: [{ [Op.gte]: toDate(r[0]) }, { [Op.lt]: toDate(r[1]) }] };
}

$dateBetween(value, ctx) {           // ← 与 $dateOn 数组**完全同构**
  return { [Op.and]: [{ [Op.gte]: toDate(r[0]) }, { [Op.lt]: toDate(r[1]) }] };
}

$dateBefore(value, ctx)     → { lt:  toDate(r[0]) }   // 字符串时 r[0] = 起点
$dateNotBefore(value, ctx)  → { gte: toDate(r[0]) }
```

时区：`parseDateTimezone(ctx)` 对普通 datetime 返回 `db.options.timezone`；
容器实测 **`TZ=Asia/Shanghai`**，数据库会话 `SHOW TIMEZONE` = `Asia/Shanghai`，
`created_at` 类型 = **`timestamp with time zone`**。

---

## 2. 🔴 关键结论：`$dateOn` 数组会多 1 秒

`parseDate` 实跑（容器内直接调用 `@nocobase/utils`）：

```
parseDate('2026-11-01T00:00:00+08:00', {timezone:'Asia/Shanghai'})
  → ["2026-10-31T16:00:00.000Z", "2026-10-31T16:00:01.000Z"]     ← 单值 = 1 秒窗口
parseDate(['2026-10-01T00:00:00+08:00','2026-11-01T00:00:00+08:00'], tz)
  → ["2026-09-30T16:00:00.000Z", "2026-10-31T16:00:01.000Z"]     ← 终点被 +1s
parseDate('2026-11-01')  → Invalid time value                     ← 纯日期不被接受
```

⇒ `$dateOn: [start, end]` 实际是 **`gte start AND lt (end + 1s)`**，
会把"终点整点后 1 秒内"的数据纳入。`$dateBetween` 同构，问题一样。

**夹具实测**：`2026-11-01T00:00:00.000+08` 那条被 `$dateOn` 数组错误包含，
组合写法正确排除（`count` 452 vs 451）。

---

## 3. 正确写法：`$dateNotBefore` + `$dateBefore`

```json
{"createdAt": {
  "$dateNotBefore": "2026-10-01T00:00:00+08:00",
  "$dateBefore":    "2026-11-01T00:00:00+08:00"
}}
```

- 前者 `gte start`、后者 `lt end`，两个都取 `r[0]`，**没有 +1s**；
- 实测 `count=451`，与 SQL `>= start AND < end` **完全一致**。

---

## 4. 边界夹具结果（12 / 12）

6 张合成工单，`created_at` 精确设到下列时刻（Asia/Shanghai）：

| 夹具 | 时刻 | 期望 | 结果 |
|---|---|---|---|
| 起点前 1ms | 2026-09-30 23:59:59.999 | 排除 | ✅ |
| 起点整点 | 2026-10-01 00:00:00 | **包含** | ✅ |
| 区间内部 | 2026-10-15 12:00:00 | 包含 | ✅ |
| 终点前 1ms | 2026-10-31 23:59:59.999 | 包含 | ✅ |
| 下周期整点 | 2026-11-01 00:00:00 | **排除** | ✅ |
| 区间外 | 2026-12-01 10:00:00 | 排除 | ✅ |

其他断言：
- 夹具范围内 **API 命中集合 == SQL 命中集合**（逐 ID）；
- 闰月 `2024-02`：API count == SQL count；
- 跨年 `2025-12 → 2026-01`：API count == SQL count；
- 单日 `2026-10-15` 只命中当天那一条；
- `$dateOn` 数组与组合写法的差异被记录（多 1 条，正是终点整点）。

---

## 5. 还没验证的 workaround（不采用）

想继续用现有筛选项（单操作符）时，理论上可以传 `[start, end-1s]` 让 `lt` 落回 `end`。
但它**依赖"parseDate 恒 +1s"这个框架内部实现细节**，一旦升级就静默错位。
本轮没有把它当方案，只在报告里记录，避免留下隐患。

---

## 6. UI 实现方案（下一轮）

### 6.1 必须解决的一个矛盾

现有 `FilterFormItemModel` **一次只能带一个操作符**（当前 `$dateOn`）。
而精确半开需要**两个操作符**（`$dateNotBefore` + `$dateBefore`）。

三个选项：

| 选项 | 做法 | 代价 |
|---|---|---|
| **D1** 新增本页 `DateRangeFilterModel` | 自己实现 `getFilterValue()` 返回双操作符，用 `addFilterConfig` 绑到 `4tjsnf2d0yp` | 需新模型；`addFilterConfig` 内存可用但**持久化 403**，刷新丢失 → 需要在模型 `onMount` 时重新注册 |
| **D2** 复用现有筛选项 + `end-1s` | 不改模型，`setFieldValue(...[start,end-1s])` | 依赖框架 +1s 细节，**不稳健**，不推荐 |
| **D3** 改现有筛选项的 `operator` 为 `$dateBetween` | 仍是单操作符，仍有 +1s | 不能解决精度问题 |

**推荐 D1**，并且：
- filterId 用本页模型自己的 uid（**不由页面实例临时 UID 当跨环境常量**，运行时从模型取）；
- 在 `onMount` 里 `addFilterConfig({filterId, targetId, filterPaths:['createdAt']})`，失败时明确报错、**不静默查全量**；
- 目标筛选项/表格用 `filterManager.getFilterConfigs()` 反查（`filterPaths` 含 `createdAt` 且 `targetId` 匹配），找不到就失败。

### 6.2 日期计算（纯函数）

```
day(2026-10-15)   → ['2026-10-15T00:00:00+08:00','2026-10-16T00:00:00+08:00')
month(2026-10)    → ['2026-10-01...','2026-11-01...')
year(2026)        → ['2026-01-01...','2027-01-01...')
today/yesterday/thisMonth/lastMonth/thisYear → 同上派生
```

与 `verify-be04-all-tickets` 的 SQL 基准同一口径（`>= start AND < end`）。

---

## 7. 本轮改动

| 项 | 结果 |
|---|---|
| 产品代码 | **零改动** |
| 页面 schema | 未改 |
| 新增脚本 | `verify-be04-date-semantics.mjs`（12 条） |
| 夹具 | 6 张，按 ID 清理，残留 0 |
| 快照 | `be04-pre-snapshot-1050.sql` 仍在 |

---

## 8. 下一步

按 §6.1 的 **D1** 实现 `DateRangeFilterModel`（含 onMount 重新注册），完成后：
1. UI 闭环（日/月/年/自定义 + 5 快捷 + 组合 + 分页 + 重置）；
2. 反向 A（改日期纯函数的边界 → 门禁红）；
3. 五档与四角色回归；
4. 更新 BE-04 总报告，申请整体 PASS/FROZEN。
