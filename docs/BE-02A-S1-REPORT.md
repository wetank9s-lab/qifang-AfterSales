# BE-02A-S1 入口挂载修复报告

> 日期：2026-10-20 · 状态：**S1 PASS；历史档案页因渲染阻塞已回退**
> 未 commit / 未 push；Phase 11 IN PROGRESS；Release HOLD。

---

## 1. 原六个合法挂载点（业务清单）

「新建服务单」挂在**工单列表区块的工具栏**，合法目标是 6 个：

| # | 页面 | 区块 `declaredKey` | Collection | 说明 |
|---|---|---|---|---|
| 1 | 我的门店工单 / 全部 | `all.all-table` | serviceTickets | 门店「全部」tab |
| 2 | 我的门店工单 / 待处理 | `new.new-table` | serviceTickets | |
| 3 | 我的门店工单 / 跟进中 | `processing.processing-table` | serviceTickets | |
| 4 | 我的门店工单 / 待反馈 | `wait-feedback.wait-feedback-table` | serviceTickets | |
| 5 | 我的门店工单 / 待门店确认 | `wait-store.wait-store-table` | serviceTickets | |
| 6 | 我的门店工单 / 已完成 | `closed.closed-table` | serviceTickets | |

另有 **`all.hq-table`**（总部「所有工单」）——**业务上不该有创建入口**，用 `HQ_TABLE_DECLARED_KEY` 显式排除。

---

## 2. 重复六个节点的真实根因（两个，不是一个）

### 2.1 主因：断言把"重建后的瞬时孤儿"算成了重复

`applyBlueprint(mode='replace')` 会重建区块 ⇒ `block.uid` 变化。
旧 uid 上的 create 节点此刻 **parent 已不存在**，但**还没被后面的"对账清理"删掉**。

而原断言：

```js
const duplicates = nodes.length - wanted.size;   // 12 - 6 = 6
```

把 6 个"parent 已消失的孤儿"算进了 duplicates —— **这是误报**。
真正的重复（同一个 block 上挂两个）才是要拦的。

> 旁证：回退后查 DB，`TicketCreateActionModel` 只有 6 个、parent 全部有效、**零孤儿**。

### 2.2 次因：挂载选择靠子串匹配

```js
const bag = JSON.stringify(node.stepParams) + JSON.stringify(node.props);
if (!bag.includes('serviceTickets')) continue;   // ← 子串
```

任何"文本里出现过 serviceTickets"的新表格都可能被卷进来，且无法表达"同 Collection 但不应有入口"（总部页就是靠额外特判排除的）。

---

## 3. 白名单设计

```js
const TICKET_CREATE_ALLOWED_BLOCKS = new Set([
  'all.all-table',
  'new.new-table',
  'processing.processing-table',
  'wait-feedback.wait-feedback-table',
  'wait-store.wait-store-table',
  'closed.closed-table',
]);
```

在 `findTicketTableBlocks()` 里加一行 `if (!ALLOWED.has(declaredKey)) continue;`。

- 按 **declaredKey**（蓝图里的稳定声明键）匹配，**不依赖动态 FlowModel UID**；
- 不在白名单的表格**一律跳过**；
- 新增页面**默认不挂**，要挂必须显式加进来并补权限验收。

### 改动文件

| 文件 | 改动 |
|---|---|
| `scripts/seed-admin-pages.mjs` | 新增 `TICKET_CREATE_ALLOWED_BLOCKS`；`findTicketTableBlocks` 加白名单过滤 |
| `scripts/seed-admin-pages.mjs` | `assertCreateEntries` 的 `duplicates` 改为**只算挂在当前有效区块上的**，并额外输出 `orphanCount`（待清理孤儿） |

---

## 4. 验证结果

### 4.1 原功能保持（S1-A）

```
=== 「新建服务单」入口挂载（P11-2：TicketCreateActionModel）===
  · 新建 6 / 修正 0
  ✓ 回读 6 张门店侧表：有效区块上 6 个（重复 0 个）
```

6 个入口都在、无重复、无新增路由/动作。

### 4.2 新历史表格被排除（S1-B）

把「历史售后档案」页（table on `historicalServiceArchives`）加回去后：

```
✓ 历史售后档案 应用成功
✓ 回读 6 张门店侧表：有效区块上 6 个（重复 0 个）
store_after_sales：可见 … 门店报修入口、历史售后档案（新增 2）
```

**checked 仍是 6、重复仍是 0** —— 历史表进了页面，但**没有被挂「新建服务单」**。白名单生效。

### 4.3 Seed 幂等

| 轮次 | 结果 |
|---|---|
| 第一次全量 | `6 个，重复 0`，EXIT=0 |
| 第二次全量 | `6 个，重复 0`，EXIT=0 |
| 加历史页后全量 | `6 个，重复 0`，EXIT=0 |
| `--only 历史售后档案` | `0 项未达标` |
| 回退后再全量 | `6 个，重复 0`，EXIT=0 |

### 4.4 反向门禁

历史表就是最好的"白名单外测试 Table"：它真实存在于页面、真实有数据，**没有被挂载**。
（没有向真实环境注入故障。）

---

## 5. ⛔ 新阻塞：历史档案页渲染不出来

页面能建、菜单能出、路由能打开，但内容区只有一行提示：

> 数据表 "主数据源 > historicalServiceArchives" 可能已被删除。请删除当前区块.

排查记录：

| 检查 | 结果 |
|---|---|
| `collections` 表有该集合 | ✅ `historicalServiceArchives` |
| `fields` 表有字段定义 | ✅ 26 个（serviceTickets 是 41 个） |
| 集合 `options`（indexes 等） | ✅ 结构正常 |
| 换成非关联字段（`store_code_snapshot`） | ❌ 仍同样提示 |
| 换 hq_admin 打开 | ❌ 同样提示（不是权限问题） |
| 重启后端 + 清缓存 | ❌ 仍同样提示 |

**结论**：这套历史表是由 P11-3 的服务端迁移**直接建表 + 写 collections 记录**产生的，
前端 Flow Engine 解析时认为该集合"不可用"。这不是挂载规则问题，是**集合与前端 schema 的兼容问题**。

按你 §八："S1 通过，但页面机制挂不上去 → 停止扩大实施，提交最小技术阻塞证据和可行方案。"

---

## 6. 本轮最终状态

| 项 | 值 |
|---|---|
| **S1 修复** | ✅ **保留**（白名单 + 断言判据修正） |
| 历史档案页 | ❌ **已回退**（代码 + `desktopRoutes:destroy` 删两条路由） |
| 当前 seed | `6 个，重复 0`，`全部页面已应用并回查通过` |
| 产品代码 | 零改动（只改 seed 脚本） |
| 历史数据 | **一行未动**（batches 177 / rows 14108 / archives 124 / conversions 26） |
| Git | 未 commit / 未 push |

---

## 7. 建议的下一步（三选一，需你裁决）

| | 做法 | 说明 |
|---|---|---|
| **T1** | 查清为什么前端认为该集合"已被删除"（对比 `serviceTickets` 的 collections/fields 全字段差异，可能是 `template`/`autoGen`/`dataSourceKey` 缺项） | 最可能一次修好，不动数据 |
| **T2** | 给历史表在 NocoBase 里**重新登记**为普通集合（走 `collections:create` 的 `autoGen`），让它和现有表结构对齐 | 有可能改动 `fields`，需备份 |
| **T3** | 放弃"通用 table 页"，历史档案改用自定义 BlockModel 直接查 `svc:historicalArchives` | 回到 S2（你已否掉），不推荐 |

**建议 T1**：先把差异查清，再决定要不要动 schema。

在 T1/T2 走通之前，BE-02A 的两个入口都挂不上去，保持 **HOLD**。
