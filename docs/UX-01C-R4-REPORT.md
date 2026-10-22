# UX-01C 第四轮：服务时效页面不可用问题定位报告（**第一层已修；第二层已定位，页面仍不可用 ⇒ 未 PASS**）

> 日期：2026-10-17 · 前序：`docs/UX-01C-R3-REPORT.md` · 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · **UX-01C IN PROGRESS**
> **本轮未提交、未推送。**
> ❌ **「服务时效」不 PASS** —— 页面由"元数据缺失"变为"读取无权限"，仍打不开（但**根因已 100% 定位到两处具体代码**）。

---

## 一、页面打不开的真实原因（**网络证据**，按 §一 逐项）
用 CDP 在 `hq_admin` 会话里抓 `collections:listMeta` 的**实际响应**：

```
修复前： /api/collections:listMeta → 200 · count=4
         names=["stores","serviceTickets","serviceVisits","ticketEvents"]   ← 没有 serviceSettings
页面区块：数据表 "主数据源 > serviceSettings" 可能已被删除。请删除当前区块.
```

**判定（不是 DATA 读取被拒，而是集合元数据根本没下发）**：
| §一 问题 | 结论 |
|---|---|
| ① `collections:listMeta` 实际请求/响应 | 已抓：200，仅 4 个集合 |
| ② `serviceSettings` 是否在响应中缺失 | **缺失**（`hasServiceSettings=false`） |
| ③ 种子里的 collection 名/dataSource/字段映射 | 正确（`serviceSettings`；block 报错里也印出了这个名字） |
| ④ 三个 SLA 参数的数据读取是否正常 | 页面此时**还没走到**读取（先卡在元数据） |
| ⑤ 根因归属 | **集合元数据被正向投影过滤掉了**（非"集合不存在"、非"读取被拒"） |

## 二、第一层修复（已实施并验证）
`src/server/middleware/collection-metadata-scope.ts`：新增
`HQ_ADMIN_EXTRA_ALLOWLIST = ['serviceSettings']`，并在投影前按**当前角色**决定有效白名单 ——
**只有 `hq_admin`** 追加放行；门店 / 总部售后 / viewer 的白名单**一字未改**（隔离保持）。
（⚠️ 未把它塞进全局 `COLLECTION_METADATA_ALLOWLIST`，正是 §二"不得改变其它集合的元数据投影规则"。）

**修复后实测**：
```
/api/collections:listMeta → 200 · count=5
names=["stores","serviceTickets","serviceVisits","ticketEvents","serviceSettings"]  ← 元数据已下发 ✅
```
`defaultFilter` 只影响页面展示口径，**未**被当作权限边界（§二 末条）。

## 三、第二层：**读取无权限**（本轮新暴露，根因已定位）
元数据放行后，页面区块换成另一个错：
```
渲染失败 … Model: TableBlockModel (uid: 4rdzi4mraxu) … ResponseError: No permissions
```
**根因**：`serviceSettings` 的**原生只读授权**从未授予业务角色 ——
`constants.ts` 的 `NATIVE_READ_ALLOWLIST`（→ `ROLE_NATIVE_READ_RESOURCES` → `seeds/roles.ts` 的 `resourceSeedsOf()`）
只有 4 个资源：
```ts
[['serviceTickets',['list','get']], ['serviceVisits',['list','get']],
 ['ticketEvents',['list','get']], ['smsLogs',['list','get']]]
```
⇒ `hq_admin` 对 `serviceSettings` **没有 `list`/`get` 权限** ⇒ 原生表格取不到数据。

**最小修复（下一轮一次性完成，仍属"方案 A"的同一半）**：
在 `seeds/roles.ts` 里**只给 `hq_admin`** 这一条角色加一个只读资源种子
`{ resource: 'serviceSettings', actions: ['list','get'], usingActionsConfig: true }`，
并让该角色的列表字段走**列白名单**（`key/value/value_type/description/updated_by`）；
- 门店 / 总部售后 / viewer **不加**（隔离不变）；
- 写入口**不放**（写入仍只走 `svc:updateSetting` 的白名单+范围+审计）；
- 应用方式：改完需**重新应用角色资源种子**（`seeds/apply.ts` 的 `seedRoles`，随插件初始化/迁移生效）。

## 四、§三 受管配置绕过写入（**已核实存在，未收口**）
**核实结论**：`hq_admin` 具备 `allowConfigure:true`，因此**仍可经 NocoBase 通用集合 API 直接改 `serviceSettings`**（例如 `/api/serviceSettings:update`），**绕过** `svc:updateSetting` 的白名单、范围校验与审计。
⇒ 目前**只有页面入口经审计**，通用 CRUD 入口**未收口**。
**最小修复方案（未实施）**：在 `serviceSettings` 资源上加一层**受管键保护** ——
对 `key ∈ {三个 SLA 键}` 的 `update/create/upsert/bulk*` 等**实际存在的写路径**统一拦截（或改写到等价的校验+审计），
**非受管键与系统初始化/迁移不受影响**（迁移走 repository，不经 HTTP action，天然不受影响）。

## 五、§四 并发双写（**代码已改，实测未做**）
上一轮已把冲突判定改为**条件更新**（`UPDATE … WHERE key=? AND value=?` + 影响行数校验），
但按 §四 要求，**必须两个并发请求实测**（同 `expected_value`、写不同值 ⇒ 恰好一次 200 / 一次 409、
库值等于成功者、审计恰好 +1）—— **本轮未跑，记 PENDING**。

## 六、§五 页面级验收（**未取得，PENDING**）
因页面仍不可用，以下**全部未取证**：三个 SLA 项可见并值正确、中文编辑表单、安全测试值保存并回显、
服务端生效、审计新增、恢复+审计、422 范围提示、409 冲突提示、门店/总部售后/viewer 不能进入或调 API 改配置、
重启/重播种后页面与配置/审计仍可用、其它 7 个页面未回归。**不以 seed exit 0 / HTTP 200 / DOM 存在代替。**

## 七、本轮已完成与未完成（一句话）
- ✅ **第一层根因修复并验证**（元数据放行，`listMeta` 4→5 项，仅 `hq_admin`）。
- ✅ 上一轮成果保持：模型注册、页面种子、动作挂载、条件更新的冲突实现、`hq_admin` 专属菜单。
- ❌ **第二层（原生只读授权缺失）已定位但未修** ⇒ 页面仍打不开。
- ❌ §三 绕过收口、§四 并发实测、§五 页面验收——**均 PENDING**。

## 八、Git 与审计
- `git status`：**41 个变更文件**（本轮新增改动：`middleware/collection-metadata-scope.ts`）。
- `git diff --check`：**干净**；增量密钥审计对全部变更文件 → **exit 0**；临时脚本已删除。
- **未提交、未推送。**

## 九、结论
- 本轮把"页面打不开"的根因**从一层挖到两层**，且**每层都落到具体文件与具体常量**，第一层已修并验证。
- **「服务时效」仍不 PASS**；**UX-01C 继续 IN PROGRESS**。
- 下一轮（一次性完成）：按 §三 给 `hq_admin` 补 `serviceSettings` 只读资源种子并重应用 → 页面应可渲染 →
  再跑 §五 全套浏览器验收 + §四 并发实测 + §三 绕过收口。
- 「短信通知」「门店管理」、旧短信描述迁移、UX-01D 装修**继续 PENDING**；不扩展 SLA 节点、不做假设置项。
