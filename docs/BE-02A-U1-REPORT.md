# BE-02A-U1 前端历史集合未注册根因报告

> 日期：2026-10-20 · 状态：**根因已定位（角色可见性），未做任何修改**
> 数据库零修改、Collection/Fields 零修改、未 commit / 未 push。

---

## 1. 一句话根因

**`collections:listMeta` 是按角色过滤的。业务角色的响应里根本没有这 5 张历史集合**——所以前端 collectionManager 注册不到，TableBlockModel 才说"可能已被删除"。

**跟表、字段、前端解析都没关系。**

---

## 2. 浏览器实际收到的响应（U1 第一关，已证实）

在 hq_admin 已认证会话里抓的真实响应：

### 2.1 `GET /api/dataSources:listEnabled?paginate=false&appends[]=collections`

```json
{ "data": [] }        // 11 字节，data 是**空数组**
```

- HTTP 200
- `data` 类型：array
- 条目数：**0**
- 不含任何集合（既没有 serviceTickets，也没有历史集合）

> 这个接口**不负责**加载集合定义，它是空的也正常——集合定义走 `listMeta`。不能因为"短"就认定数据源加载失败。

### 2.2 `GET /api/collections:listMeta`

| 项 | hq_admin 浏览器实际收到 |
|---|---|
| HTTP | 200 |
| 字节 | **38 671** |
| `data` 类型 | array |
| **条目数** | **5** |
| 含 `serviceTickets` | ✅ |
| **含 `historicalServiceArchives`** | **❌** |
| `historicalNames` | **`[]`** |
| 响应文本里出现 "historicalServiceArchives" | **false** |

**响应体里压根没有这些集合**——所以前端不是"解析失败"，是"没拿到"。

---

## 3. 同账号对照：差在角色（决定性证据）

同一台服务器、同一个接口，换不同账号：

| 账号 | 角色 | listMeta 条目数 | 含历史集合 | 含 serviceTickets |
|---|---|---|---|---|
| `admin@nocobase.com` | 超级管理员 | **27** | ✅ | ✅ |
| `uat.hqadmin@svc.local` | hq_admin | **5** | ❌ | ✅ |
| `uat.hq@svc.local` | hq_after_sales | **4** | ❌ | ✅ |
| `uat.store.a@svc.local` | store_after_sales | **4** | ❌ | ✅ |
| `uat.viewer@svc.local` | viewer | **4** | ❌ | ✅ |

**结论**：`listMeta` 按角色裁剪。业务角色只看得到 4–5 个集合，历史集合一个都不在其中；超级管理员看得到全部 27 个。

这就解释了为什么我在上一轮用 admin 账号查"listMeta 有 27 条含它"——**那不代表业务角色也能拿到**。

---

## 4. 回到那 4 个问题

### A. 浏览器实际收到的 listMeta 是否包含 historicalServiceArchives？

**不包含。** 5 条里没有，响应体全文也没有这个字符串。

### B. listEnabled 的短响应是什么？

`{"data":[]}`——空数组、11 字节。**它不承载集合定义**，空是正常的；集合定义在 listMeta。

### C. 客户端在哪个环节没把历史集合注册进 main collectionManager？

**在"收到响应"之前就没了**：`listMeta` 里没有 → `collectionManager` 自然不会有 → `TableBlockModel` 查不到 → 显示"可能已被删除"。
**不是前端解析 26 个字段时跳过。**

### D. 影响全部历史集合还是部分字段？

**全部 5 张历史集合一起不可见**（`historicalNames = []`），与字段无关。

### E. 哪个正式接口能最小化修复？

给业务角色授予这 5 个集合的**只读可见性 + 读动作**（NocoBase 正式 ACL：`rolesResources` / `rolesResourcesActions`，或后台「角色 → 权限」界面）。

### F. 是否需要改 P11-3 的 Collection 元数据？

**不需要。** 元数据已经与 `serviceTickets` 逐项一致（`inherit/hidden/template/from/origin/loadedFromCollectionManager/filterTargetKey` 全同，fields 26 个类型全部可解析）。

---

## 5. 已证实 vs 未验证

### 已证实

1. 浏览器 listMeta 只有 5 条、不含历史集合（**响应体级证据**）；
2. 同一接口 admin 27 条含、业务角色 4–5 条不含（**角色对照证据**）；
3. `listEnabled` 返回空数组，与集合加载无关；
4. 后端数据层正常：`historicalServiceArchives:list` 200、124 行；
5. 历史集合元数据与 serviceTickets 无结构差异；
6. `rolesResources` 与 `rolesResourcesActions` **两张表都是 0 行**（当前 ACL 没落在这两张表上）。

### 未验证

- 角色裁剪发生在 `listMeta` 的哪一段代码（可能走 `roles` 的策略/白名单，而不是经典 ACL 表）；
- 是否存在"集合需先在后台角色页被勾选"的前置登记。

两者都不影响修复方向：**给业务角色补上这 5 个集合的可见性。**

---

## 6. 最小修复方案（待授权，未实施）

### 方案 P1（推荐）

用**正式 ACL 接口**给 4 个业务角色授予：

| 集合 | 权限 |
|---|---|
| `historicalServiceArchives` | **read**（门店范围） |
| `historicalImportBatches` | read（门店范围） |
| `historicalImportRows` | read |
| `historicalImportCandidates` | read |
| `historicalImportReviews` | read |

- 只加 read，**不加** create/update/delete（历史归档由 `svc:historical*` 服务端动作写入，不需要前端写权限）；
- 门店范围用 existing 行级策略（同 `serviceTickets` 的 `store_id` 约束），**不扩大**；
- 不加任何其它模块权限。

### 影响面

| 项 | 结论 |
|---|---|
| 是否改历史数据 | ❌ 否 |
| 是否改 Collection/Fields | ❌ 否 |
| 是否影响 P11-3 API | ❌ 否（它们走服务端 service-role） |
| 是否可逆 | ✅ 是（撤掉角色资源即可） |
| 是否需要停机 | ❌ 否（ACL 变更即时生效，前端刷新即拿到新 listMeta） |

### 修复后要跑的门禁

1. 业务角色 listMeta 含历史集合（`hasArchives=true`）；
2. 历史档案页能渲染、有数据；
3. 门店 A 只看本店（行级）；
4. viewer 只读、写被拒；
5. **S1 回归**：`新建服务单` 仍 6 个、重复 0。

---

## 7. 环境状态

| 项 | 值 |
|---|---|
| 数据库 | **零修改**（历史四表 177 / 14108 / 124 / 26 未变） |
| Collection / Fields | **零修改** |
| 历史页面 | 未重建（仍是回退状态） |
| S1 白名单 | 保留，seed `6 个，重复 0` |
| 产品代码 | 零改动 |
| Git | 未 commit / 未 push |

---

## 8. 结论

**根因是"角色看不到集合"，不是"表坏了"。**

这解释了此前所有矛盾现象：admin 一切正常、业务角色前台空白、元数据和数据都全绿。

**等你批准 P1 后**，加最小 read 授权 → 重建历史档案页 → 继续 BE-02A。
不批准就维持 HOLD，不启动 T2/T3。
