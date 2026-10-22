# BE-04-STORE 所属门店列验收

> 日期：2026-10-20 · 状态：**PASS（本项）**
> 改动极小、未改通用 builder、未改数据库归属。

---

## 1. 根因与修复

**现象**：`TICKET_LIST_FIELDS_HQ` 里明明有 `store`，但表头 12 列没有门店。

**根因**：`store` 是 **belongsTo 关联**。列清单里写关联名，引擎不会自动取"关联的显示字段"，
所以这一列没有可渲染的标量值。

**修复（一行）**：

```diff
- const TICKET_LIST_FIELDS_HQ = ['ticket_no', 'store', ...TICKET_LIST_FIELDS.slice(1)];
+ const TICKET_LIST_FIELDS_HQ = ['ticket_no', 'store.name', ...TICKET_LIST_FIELDS.slice(1)];
```

即：把关联名换成**关联字段路径** `store.name`，让引擎按关联的显示字段渲染。

- 未改通用列 builder；
- 未改数据库工单归属；
- 未新增关联查询（不产生重复行）。

---

## 1.5 有效截图与上一轮「认证异常」归因

上一轮那张截图确实是**骨架屏 + 两条弹窗**，不能作为证据。本轮用**请求钩子**逐条归因：

| 问题 | 答案 | 证据 |
|---|---|---|
| A. 哪条请求触发 `No permissions` | `GET /api/environmentVariables?paginate=false` → **403** | 22 条请求里唯一 403 |
| B. 哪条请求触发 `未认证` | **本会话没有任何 401** | 请求记录 `401` 计数 = 0 |
| C. 业务列表请求是否 200 | 是 | `serviceTickets:list` → 200 |
| D. 是否测试脚本自己发的无认证请求 | **是** | 前几轮脚本里有一句裸 `fetch('/api/auth:check')`（不带 Authorization）——NocoBase 的 token 由 axios 拦截器加，裸 fetch 必然 401 并弹"未认证" |

> 结论：**不是产品登录失效**，是测试方法错误（脚本自身发起的无认证请求）。
> B-17 的 `No permissions` 是既有噪声，**没有**通过开放环境变量权限处理。

**本轮有效截图**：`.tmp-verify/be04-final-all-tickets.png`
—— 已登录后台、标题「所有工单」、筛选表单 7 项齐全、表头含「门店名称」、
数据行显示「新都圣大家电 / 金堂华林电器」、客户手机号完整、**只剩一条 B-17 弹窗、无「未认证」**。

截图前的硬条件（脚本断言）：表格行 `getBoundingClientRect().height > 12` 且进入视口，
再等 1.2s 才拍——避免"DOM 就绪但画面空白"。

---

## 2. 真实浏览器证据

| 项 | 结果 |
|---|---|
| 表头 | 操作 / 工单号 / **门店名称** / 状态 / 工单类型 / 客户姓名 / 客户手机号 / 报修投诉内容 / 师傅姓名 / 师傅手机号 / 预计上门时间 / 创建日期 |
| 首行门店 | **新都圣大家电**（真实门店名，非空、非纯数字 id） |
| 与 SQL 比对 | 页面值 == `stores.name`（按首行工单号 JOIN 校验） |
| 重复行 | 20 行、20 个唯一工单号 ⇒ 无重复 |
| 行数 vs 总数 | 行数 ≤ `meta.count`（关联未放大结果集） |

截图：`.tmp-verify/be04-store-column.png`

---

## 3. 权限未受影响

| 断言 | 结果 |
|---|---|
| 门店账号列表只含本店（`store_id` 去重 ≤ 1） | ✅ |
| 门店按别店 id 过滤 count=0 | ✅ |
| 总部可看全部授权门店 | ✅（列显示全量门店名） |
| 未新增跨店写权限 | ✅（未动 ACL） |

---

## 4. 门禁

`scripts/verify-be04-store-column.mjs` —— **8 / 8**

（含一条元验证：API `appends=store` 能取到门店名，证明列的数据来源真实可用。）

---

## 5. 附：本轮修掉的验证器错误

1. **列索引错位**：表格有勾选列，`td` 比过滤后的 `th` **多一列**；第一版用同一个 index，
   把"工单号"当成了"门店名"（假红）。修正为 `th.indexOf('门店名称') + 1`。
2. **模板字符串里写注释用了反引号**：把字符串提前闭合，直接语法错误。

---

## 6. 恢复方式

- 回退 = 把 `store.name` 改回 `store`（或回灌 `backups/be04-pre-snapshot-1050.sql`）；
- seed 幂等：`node scripts/seed-admin-pages.mjs --only 所有工单` 可重复应用，列不会丢。
