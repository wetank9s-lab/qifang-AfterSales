# BE-02A 三层修复实施报告（ACL 层未通 · 已回滚）

> 日期：2026-10-20 · 状态：**storeScope 已实施但无法验证；ACL 加了不生效；已全部回滚**
> 历史数据零修改；未 commit / 未 push。

---

## 1. 本轮做了什么

按「先隔离 → 再授权 → 最后元数据」：

| 步 | 动作 | 结果 |
|---|---|---|
| ① storeScope | `SCOPED_RESOURCES` 加 3 个历史集合（`via:'self'`） | ✅ 已加、构建通过 |
| ② ACL | 4 角色 × 3 集合 × list/get/view = 36 条动作 + 12 条资源 | ⚠️ **加了但不生效** |
| ③ 白名单 | 未做（②不通，按你"失败即停"的要求） | ❌ |

**全部回滚**（36+12 条 ACL 全删、storeScope 撤销、重建重启，`serviceTickets` 200 / `listMeta` 5 恢复原状）。

---

## 2. 关键进展：找到并修掉了 P1 漏掉的两个必填项

对比能正常工作的 `serviceTickets`，我加的 ACL 记录**缺两样**：

| 字段 | serviceTickets | P1 加的历史集合 | 已修 |
|---|---|---|---|
| `usingActionsConfig` | `true` | **NULL** | ✅ 改成 true |
| `actions.fields` | 完整字段数组 | **`[]`** | ✅ 填 26/23/13 个字段 |
| `actions.fields` 是否含 `id` | 有 | **没有**（隐式主键不在 fields 表） | ✅ 补了 `id` |

**修完之后 `get` 有变化**：门店 A 读 B 店记录从 **403 → 404**（这正是 storeScope 的越权契约：NotFoundError）。

**但 `list` 仍是 403**，而同一账号同一时刻：

```
serviceTickets              => 200, count=452
historicalServiceArchives   => 403
historicalImportBatches     => 403
```

---

## 3. 卡在哪（已排除的）

两条 ACL 记录**全字段 diff 只剩 id/时间/name**：

```json
{"dataSourceKey":"main","roleName":"store_after_sales","usingActionsConfig":true,...}
```

动作也都是 `list/get/view`、`scopeId=null`、`fields` 非空且含 `id`。

所以**不是**：
- 不是 `usingActionsConfig`（已 true）
- 不是 `fields` 为空（已填）
- 不是缺 `id`（已补）
- 不是缓存（重启过）
- 不是 strategy（`{"actions":["view","list","get"]}` 两个资源共用）
- 不是 storeScope 抛的 403（`mergeScopeFilter` 在无范围时用 `id:-1` 置空，不抛）

**`get` 通了、`list` 不通** —— 同一资源、同一角色、同一份 ACL，两个动作一个过一个不过，**这不合常理，说明还有一层我没看到的东西在判 `list`**。

---

## 4. 一个必须说清的不确定点

`get` 的 404 可能是两种完全不同的东西：

- **A**：ACL 放行了，storeScope 判越权 → 404（这是我倾向的解释）；
- **B**：ACL 根本没放行，NocoBase 对无权限的 `get` 伪装成 404（防存在性泄露）。

**我没能证明是 A。** 如果是 B，那 ACL 层从头到尾都没生效过，`get` 的变化只是巧合。

---

## 5. 已回滚清单

| 项 | 结果 |
|---|---|
| ACL 动作 36 条 | 已删 |
| ACL 资源 12 条 | 已删（DB 里 `historical%` 资源数 = **0**） |
| `store-scope.ts` 3 项 | 已撤销（`grep` = 0） |
| 构建 / 重启 | 成功，`未声明标识符 0` |
| 基线复验 | `serviceTickets:list` **200**、`listMeta` **5 条** |
| 历史四表 | 177 / 14 108 / 124 / 26 **未变** |
| 历史页面 | 未重建 |

备份：`backups/acl-before-p1.json`。

---

## 6. 我的判断与建议

**ACL 这条路我走了四轮**（P1 加 list/get → 补 view → 补 usingActionsConfig/fields → 补 id），每次都能排除一个变量，但 `list` 始终 403。

按你"失败即停止"的要求，我停在这里，**不再做第五次尝试**。

**建议改走另一条路（不碰 ACL）：**

历史档案页不用原生 table block，改**自定义 BlockModel**，数据走服务端已有的 `svc:historicalArchives` / `svc:historicalBatches` 接口。

理由：
- 这些接口**已经在跑**（`historical_import_batches` 177 行、archives 124 行都是经它们写入的）；
- 服务端的 `storeScope` / 权限校验已经在 `svc` handler 内部做过（`store-entry.ts` 里就有 `scope.storeIds` 的用法）；
- **完全绕开**「listMeta 白名单 + 原生 ACL」这两层我们搞不定的东西；
- 代价：列表要自己写（你之前否掉过 S2，但那时是"为了绕元数据"，现在是"为了绕 ACL"——理由变了）。

**如果坚持走原生 ACL**，下一步只能是去读 NocoBase `acl` 包里 `list` 动作的判定（`actions/list` 的 permission 逻辑），看它除了 `dataSourcesRolesResources*` 还查什么。

---

## 7. 环境状态

| 项 | 值 |
|---|---|
| 产品代码 | 零净改动（改了两处又撤销） |
| ACL | 零改动（回滚到 `backups/acl-before-p1.json` 状态） |
| 数据库 | 零改动 |
| S1 白名单 | 保留（seed `6 个，重复 0`） |
| Git | 未 commit / 未 push |
