# BE-02A-S2 第二关 `--only` 修复回归（最小证据）

> 日期：2026-10-21 · 状态：**两次 `--only` + 浏览器回归均通过**

---

## 1. 修复在位

```
grep -c "ONLY_TITLE === '历史售后档案'" scripts/seed-admin-pages.mjs  → 1
```

`--only` 分支会在 `applyBlueprint(replace)` 之后补跑 `seedHistoricalArchivesBlock()`。

---

## 2. 两次 `--only`

| 次 | 结果 | 区块 uid | 定位方式 |
|---|---|---|---|
| 第 1 次 | `✓ 已挂 HistoricalArchivesBlockModel`，**0 未达标** | `glwur2o3dbh` | `declaredKey` |
| 第 2 次 | `✓ 已挂 HistoricalArchivesBlockModel`，**0 未达标** | `4nc0jdl2e0j` | `declaredKey` |

**uid 两次不同、但都挂上** —— 走的是 `declaredKey`，**没有硬编码 UID**。

数据库回查（第 2 次之后）：

```
4nc0jdl2e0j | HistoricalArchivesBlockModel | archives.archives-block
```

| 计数 | 值 |
|---|---|
| `HistoricalArchivesBlockModel` 节点数 | **1**（无重复） |
| `desktopRoutes` 标题=历史售后档案 | 2（flowPage + tabs，一个页面的两条路由，正常） |
| `TicketCreateActionModel` 节点数 | **6** |

---

## 3. 浏览器回归（真实 S01 账号，重新登录）

| 项 | 结果 |
|---|---|
| 页面形态 | **不是空白 Markdown**，专用面板正常渲染 |
| 列表 | **20 行** |
| total | **共 122 条** |
| 详情 | 点 id=124 → 请求 `/api/svc:historicalArchiveQuery?id=124` → 真实 DTO（单号/门店 S01/姓名/手机号/地址/产品/时间/结果/来源文件） |
| 关闭详情 | 列表恢复 20 行 / 122 条 |
| 4xx | 仅 `/api/environmentVariables?paginate=false` **403**（B-17，已知，不影响本页） |

---

## 4. 数据与冻结

| 项 | 值 |
|---|---|
| 历史四表 | **177 / 14 108 / 124 / 26 未变** |
| SEC-HIST-01 / HQ-HIST-01 | 修复保留 |
| 原生 ACL / listMeta / P11-3 算法 | 未改 |
| 新建工单 / 派工 / SMS | 无 |
| Git | 未 commit / 未 push |

---

## 5. 申请

`--only 历史售后档案` 重复执行**不再让页面变空白**，两次都稳定挂上、无重复区块、S1 保持 6/0。

**BE-02A-S2 第二关：PASS / FROZEN。**
