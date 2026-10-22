# BE-04-P1→Q2 实施报告（三关 + 日期 UI）

> 日期：2026-10-20 · 状态：**Q2 第一、二关 PASS；日期 UI 已跑通；第三关（seed 可复现）未完成**
> 未 commit / 未 push。

---

## 1. 三关结果

| 关 | 内容 | 结果 |
|---|---|---|
| **1** | 独立模型注册（新名字，不覆盖框架类） | ✅ **PASS** |
| **2** | `flowModels:update` 切换单条模型的 `use` | ✅ **PASS**（含撤销/恢复） |
| **3** | post-seed 补丁（可复现） | ❌ **未完成**（见 §4） |

---

## 2. 第一关：独立模型注册

```ts
const Base = flowEngine.getModelClass('FilterFormItemModel');   // 运行时取基类
class BE04DateRangeFilterItemModel extends Base { ... }
flowEngine.registerModels({ BE04DateRangeFilterItemModel });    // 新名字，不覆盖
```

实测：

| 探针 | 结果 |
|---|---|
| `getModelClass('BE04DateRangeFilterItemModel')` | 返回新类，`hasRender: true` |
| `isSubclassOfBase` | **true** |
| `getModelClass('FilterFormItemModel').name` | 仍是 `FilterFormItemModel`（**未被覆盖**） |
| 页面 | 7 项筛选、20 行、不白屏 |

---

## 3. 第二关：单条 FlowModel 正式更新

### 3.1 定位（按稳定业务条件）

`declaredKey='all.all-search.createdAt'` + `collectionName='serviceTickets'` + `fieldPath='createdAt'`。

DB 里命中 **2 条**（`hlgyq0dyysk` / `bvcrjww2fny`），是页面重建留下的重复。
用运行时有效性区分：

| uid | `getModel(uid)` |
|---|---|
| `hlgyq0dyysk`（旧 grid `k20m3m6n59x` 下） | **null**（历史孤儿） |
| `bvcrjww2fny`（新 grid `rw5nkr0epr0` 下） | `FilterFormItemModel`，有子模型（**当前有效**） |

### 3.2 更新

```
POST /api/flowModels:update?filterByTk=bvcrjww2fny   { "use": "BE04DateRangeFilterItemModel" }
→ HTTP 200
回读 use = BE04DateRangeFilterItemModel
```

页面实测：`classOfTarget = BE04DateRangeFilterItemModel`，7 项筛选齐全、20 行、标题「所有工单」、**不白屏**。

### 3.3 撤销

```
use=FilterFormItemModel      → 200，回读 FilterFormItemModel
use=BE04DateRangeFilterItemModel → 200，回读 BE04DateRangeFilterItemModel
```

**可逆已验证**。原配置已快照：`backups/be04-model-bvcrjww2fny-1237.json`。

---

## 4. 第三关：为什么未完成

`flowModels` 里存在 **两条** `declaredKey='all.all-search.createdAt'`（重建残留的孤儿 grid）。
你要求"匹配结果恰好一项，多条时明确失败"——按这条规则，自动定位的补丁脚本**本该失败**。

我没有为了让它跑通而放宽判据。现在的状态是：

> **schema 已被我手工 `flowModels:update` 切到新模型，但没有可复现的 post-seed 补丁 —— 重新 seed 会丢。**

这违反"重新部署仍有效"，所以**不能进入正式验收**。

**需要的选择**（我不擅自做破坏性操作）：
- **A**：授权我用正式接口清理那条孤儿 grid（`k20m3m6n59x` 及其子树），之后 patch 脚本可稳定匹配"恰好一项"；
- **B**：patch 脚本按"运行时有效"过滤 —— 但脚本没有浏览器上下文，做不到；
- **C**：patch 脚本接受 `--uid` 显式指定（可复现性依赖一个会变的 uid，不满足你的要求）。

---

## 5. 日期 UI：已跑通（真实证据）

| 项 | 结果 |
|---|---|
| 模式按钮 | 按日 / 按月 / 按年 / 自定义（4 个） |
| 快捷按钮 | 今天 / 昨天 / 本月 / 上月 / 本年（5 个） |
| 清除 | 「清除日期」 |
| 生效提示 | 「生效中：本月 · 2026-10-01 00:00 ~ 2026-11-01 00:00（不含结束）」 |
| 原生日期项 | **已消失**（筛选项 7 → 6，不再有 `$dateOn` 双条件） |

点「本月」实际请求：

```
GET /api/serviceTickets:list
  ?filter={"$and":[{"createdAt":{
      "$dateNotBefore":"2026-10-01T00:00:00+08:00",
      "$dateBefore":"2026-11-01T00:00:00+08:00"}}]}
  &appends[]=store&sort[]=-createdAt&page=1&pageSize=20
```

- 双操作符、无 `$dateOn`/`$dateBetween`、无 `end-1s`；
- `appends=store`、`sort`、分页全保留；
- 表格门店名称列正常（新都圣大家电 / 金堂华林电器）。

截图：`.tmp-verify/date-bar.png`（含日期条、生效文案、门店列、完整手机号）。

---

## 6. 尚未完成（不能算通过）

| 项 | 状态 |
|---|---|
| post-seed 补丁（第三关） | ❌ |
| 日 / 年 / 自定义的端到端点击验证 | ❌（只验了「本月」） |
| 日期 + 门店/状态/类型组合 | ❌ |
| 重置、分页回第一页、无匹配 | ❌ |
| 刷新 / 重新登录后状态一致 | ❌ |
| 五档布局回归 | ❌ |
| 四角色 + 4 个原筛选页面回归 | ❌ |
| 反向 A（日期函数变异） | ✅ 已做：15/17 红，还原 17/17（上一轮） |

---

## 7. 当前环境状态（重要）

| 项 | 值 |
|---|---|
| `bvcrjww2fny.use` | `BE04DateRangeFilterItemModel`（**手工改的，未进 seed**） |
| 快照 | `backups/be04-model-bcrjww2fny-*.json` + `be04-pre-snapshot-1050.sql` |
| 回退方法 | 一次 `flowModels:update {use:'FilterFormItemModel'}`（已实测可逆） |
| 重新 seed 后 | **会退回原生日期项**（补丁未接入） |
| 构建 | 成功（未声明标识符 0） |
| 页面 | 正常，无白屏 |
