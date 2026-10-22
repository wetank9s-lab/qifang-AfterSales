# BE-02A-T1 历史 Collection / Flow Engine 兼容性根因调查报告

> 日期：2026-10-20 · 状态：**定位到「前端 collectionManager 未加载」这一层；未定位到具体代码行**
> 未修改任何 Collection / Fields / 历史数据。未 commit / 未 push。

---

## 1. 一句话结论

**后端四层全部正常，前端 collectionManager 里这 5 张历史集合一个都没有。**

这是本轮最硬的证据，也把问题从"数据库表不存在"彻底排除到了"前端加载/解析"这一层。

---

## 2. 报错来源

文案 key（`@nocobase/plugin-client/dist/locale/zh-CN.json:1426`）：

```
The {{type}} "{{name}}" may have been deleted. Please remove this {{blockType}}.
→ {{type}} "{{name}}" 可能已被删除。请删除当前{{blockType}}.
```

渲染时：`type = 数据表`，`name = 主数据源 > historicalServiceArchives`，`blockType = 区块`。

**它只是文案**，不代表真的被删——下面四条证据都能证明表、字段、元数据、数据都在。

---

## 3. 关键实验：前端 collectionManager 里有没有它

在「所有工单」页（任意页都能跑）从 `TableBlockModel.context.dataSource.collectionManager` 直接查：

```json
{
  "dsKey": "main",
  "hasCM": true,
  "serviceTickets":              { "ok": true,  "fields": 43 },
  "historicalServiceArchives":   { "ok": false },
  "historicalImportBatches":     { "ok": false },
  "allCollections(historical*)": []
}
```

**`serviceTickets` 在、有 43 个字段；5 张历史集合全部 `ok:false`，一个都没注册。**

---

## 4. 后端四层全部正常（逐层证据）

| 层 | 检查 | 结果 |
|---|---|---|
| 物理表 | `historical_service_archives` 行数 | **124** |
| Collections 表 | `collections` 有记录 | ✅ `name/title/hidden/inherit/options` 齐全 |
| `collections:list` | pageSize=300 → 27 条 | **含 `historicalServiceArchives`**（按顺序排第 8） |
| `collections:list?pageSize=20` | 是否被截断 | 否，**仍含**（排除分页假设） |
| `collections:get` | 单条 | **HTTP 200**，返回完整元数据 |
| `collections:listMeta` | 前端真正用的接口 | **HTTP 200，154 KB，27 条，含它** |
| Fields | 字段数 | **26 个**，类型全部可解析（string/belongsTo/json/integer/date/text） |
| 数据 API | `/api/historicalServiceArchives:list` | **HTTP 200，count=124** |

---

## 5. 元数据对照（与 `serviceTickets` 逐项比）

### 5.1 Collections 表

| 项 | serviceTickets | historicalServiceArchives |
|---|---|---|
| `inherit` | f | f |
| `hidden` | f | f |
| `options->template` | (none) | (none) |
| `sort` | 3 | 10 |

### 5.2 listMeta 返回的条目

两者 **key 集合完全一致**，值也一致：

```
from=db2cm · origin=@nocobase/plugin-data-source-main
loadedFromCollectionManager=true · uiManageable=true · underscored=true
filterTargetKey=id · unavailableActions=[]
```

唯一差异：`fields` 数量（44 vs 26）与字段内容。

### 5.3 Fields

- 26 个字段，类型分布：string/input 10、belongsTo/m2o 4、json/json 3、string/select 2、integer 2、date/datetime 2、text/textarea 1、date/updatedAt 1、date/createdAt 1
- `createdAt` 的 `options.uiSchema` 与 serviceTickets **逐字相同**
- 所有集合（含 serviceTickets）都**没有显式的 `id` field 记录**（隐式主键），所以这不是差异

---

## 6. 前端加载链路（实测请求）

登录后抓到的 collection 相关请求只有两条：

```
GET /api/dataSources:listEnabled?paginate=false&appends[]=collections   → 200，响应 11 字节
GET /api/collections:listMeta                                          → 200，38 671 字节
```

**注意第一条：响应只有 11 字节**（几乎为空）。前端靠它拿"数据源 → 集合"的关系，而 `listMeta` 才有完整集合定义。

---

## 7. 已证实 vs 未证实

### 已证实

1. 表、字段、数据、元数据**全部存在且正常**；
2. `collections:list` / `get` / `listMeta` 三个接口**都返回它**；
3. **前端 collectionManager 里 5 张历史集合全部缺失**；
4. 元数据与 `serviceTickets` **无结构差异**；
5. 排除的假设：分页截断、hidden、template、dataSourceKey 缺失、主键字段缺失、字段类型无法解析、权限（hq_admin 同样空白）。

### 未证实（不猜）

- 前端 `collectionManager` 在**解析 26 个字段**时是否因某个字段静默跳过整个集合；
- `dataSources:listEnabled` 的 11 字节响应是否导致前端只认了一部分集合；
- 具体是哪一行代码决定"跳过"。

**要定死这两点，需要抓浏览器实际收到的 `listMeta` 响应体并比对**（本轮查的是服务端 fetch，不是浏览器实际响应），以及读 `plugin-data-source-main` 的 `db2cm` 加载器。

---

## 8. 最小无损修复方向（待授权，未执行）

| 方向 | 做法 | 风险 |
|---|---|---|
| **U1** | 抓浏览器实际 `listMeta` 响应，确认历史集合是否真在响应体里 | **只读**，零风险 |
| **U2** | 若响应体里有、前端仍跳过 → 逐个字段二分（临时隐藏部分字段看是否加载）——需要**改字段**，必须授权 | 中，要备份 |
| **U3** | 若响应体里没有 → 是服务端按数据源过滤，查 `dataSources:listEnabled` 为何返回 11 字节 | 低 |

**T2（重新创建 Collection）目前没有依据**：元数据与正常集合完全一致，重建不会解决"前端不加载"。

---

## 9. 数据保护

| 表 | 行数（未变） |
|---|---|
| historical_import_batches | **177** |
| historical_import_rows | **14 108** |
| historical_service_archives | **124** |
| historical_ticket_conversions | **26** |

本轮**只读**：没改 collections、fields、历史业务表，没删集合，没重建表。

---

## 10. 环境状态

| 项 | 值 |
|---|---|
| S1 白名单 | 保留，`6 个，重复 0` |
| 历史页面 | 已回退（不在 seed、无路由） |
| 产品代码 | 零改动 |
| Git | 未 commit / 未 push |

---

## 11. 建议

**先做 U1**（抓浏览器实际 `listMeta` 响应体）——这是只读的，且能一刀切开"服务端没给"还是"前端给了不认"。

在 U1 出结果前，BE-02A 保持 **HOLD**，不启动 T2/T3。
