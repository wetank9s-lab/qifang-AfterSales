# BE-02A-P1 历史集合权限修复报告（假设证伪 · 已回滚）

> 日期：2026-10-20 · 状态：**P1 未达成 —— "加 ACL 就能让 listMeta 返回" 被实验证伪；已完整回滚**
> 历史数据零修改；未 commit / 未 push。

---

## 1. 结论先说

我按 P1 做了三件事，**listMeta 一条都没变**：

| 动作 | 结果 |
|---|---|
| ① 给 4 角色 × 3 集合加 ACL（list/get，后补 view）→ 36 条 | listMeta 仍 5/4/4/4 |
| ② `NATIVE_READ_ALLOWLIST` 加 3 个历史集合 | 无变化 |
| ③ 重启后端（清缓存） | 无变化 |

**所以"角色看不到是因为没有 ACL"这个判断是错的**，U1 的结论只对了一半（确实是角色差异），但**修复点不在 ACL**。

已按 §五 **完整回滚**：ACL 36 动作 + 12 资源全删、两处代码改动撤销、重建重启，`listMeta` 恢复 `count=5`（原状）。

---

## 2. 实际 ACL 结构（§二 的核查结果）

这个版本的 ACL **不**在 `rolesResources` / `rolesResourcesActions`（两张表都是 0 行），而在：

| 表 | 行数 | 作用 |
|---|---|---|
| `dataSourcesRoles` | 7 | 角色 strategy（`{"actions":[view,list,get]}`，只限动作名，**不限资源**） |
| `dataSourcesRolesResources` | **21** | 角色 × 资源 |
| `dataSourcesRolesResourcesActions` | **63** | 上面每条 × 动作 |
| `dataSourcesRolesResourcesScopes` | 2 | 只有 `all` / `own`（`createdById = currentUser.id`） |

现有矩阵（授权前）：

| 角色 | 资源 |
|---|---|
| hq_admin | serviceSettings, serviceTickets, serviceVisits, smsLogs, stores, ticketEvents（6） |
| hq_after_sales | serviceTickets, serviceVisits, smsLogs, stores, ticketEvents（5） |
| store_after_sales | 同上 5 |
| viewer | 同上 5 |

**历史集合一条都没有** —— 这部分判断是对的。

---

## 3. 门店行级隔离的前置核查（§四，未执行授权前的安全门禁）

`storeScope` 中间件里的 `SCOPED_RESOURCES` 只覆盖 4 个资源：

```js
serviceTickets: { via: 'self' }    // 自带 store_id
serviceVisits / ticketEvents / smsLogs: { via: 'ticket' }   // 经 ticket.store_id
```

五张历史表的归属路径：

| 集合 | 直接 store_id | 关联路径 | 能否用现有 via |
|---|---|---|---|
| historicalServiceArchives | ✅ | — | ✅ `self` |
| historicalImportBatches | ✅ | — | ✅ `self` |
| historicalImportCandidates | ✅ | — | ✅ `self` |
| **historicalImportRows** | ❌ | `batch_id → batches.store_id` | ❌ 需新增 `via:'batch'` |
| **historicalImportReviews** | ❌ | `batch_id → batches.store_id` | ❌ 需新增 `via:'batch'` |

**所以按你的要求，我只对前 3 张做了授权尝试，后 2 张没碰**（否则会给门店开一个跨店可读的口子）。

---

## 4. 为什么 `listMeta` 不认 ACL（关键的实验对照）

用 hq_admin 实测两个接口：

```
GET /api/collections:list?pageSize=200   → 403（被 native-metadata-guard 拦）
GET /api/collections:listMeta            → 200，5 条：
     stores / serviceTickets / serviceVisits / ticketEvents / serviceSettings
```

- `listMeta` 的 5 条 = 该角色 ACL 里的 4 个资源 + `serviceSettings`；
- `collections:list` 被 guard 直接 403（守卫只放行 allowlist 里的资源）。

**于是我判断"那 5 条 = ACL 资源"，就去补 ACL —— 但补完 listMeta 没变。**

同时我读了 guard 的实现：它只拦 `collections:list`（除非 resource 在 `businessResources` 且 action 是只读），**完全不参与 `listMeta`**。

**结论**：`listMeta` 的裁剪发生在 NocoBase 框架侧，**不是本插件的 guard、也不是本插件能改的 allowlist**。我上一轮把它归因为"业务角色 ACL 缺失"，是把相关关系当成了因果关系。

---

## 5. 没有验证到的部分（不猜）

- `listMeta` 到底按什么过滤（可能是框架的角色→collection 缓存、`collections` 表的某个隐藏字段、或角色 strategy 的 resources 维度）；
- 为它补 ACL 后为什么没进 listMeta（可能需要另一个动作、或需要 `dataSourcesRoles` 层面的声明）；
- `historicalImportRows` / `Reviews` 的 `via:'batch'` 隔离实现（本轮未做，因为主体假设已证伪）。

---

## 6. 回滚清单（已执行并验证）

| 项 | 动作 | 结果 |
|---|---|---|
| ACL 动作 | destroy 36 条 | 成功 |
| ACL 资源 | destroy 12 条 | 成功 |
| `constants.ts` 的 allowlist +3 | 撤销 | `grep historicalServiceArchives` = 0 |
| `store-scope.ts` 的 SCOPED_RESOURCES +3 | 撤销 | 同上 = 0 |
| 重建 | build 成功、未声明标识符 0 | ✅ |
| 重启 + 复验 | `listMeta` `count=5` | 回到原状 ✅ |

备份：`backups/acl-before-p1.json`（21 资源 + 63 动作，授权前快照）。

---

## 7. 数据与环境

| 项 | 值 |
|---|---|
| 历史四表 | **零修改**（177 / 14 108 / 124 / 26） |
| Collection / Fields | 零修改 |
| 历史页面 | 未重建 |
| S1 白名单 | 保留（seed `6 个，重复 0`） |
| 产品代码 | **零净改动**（改了两处又撤销） |
| Git | 未 commit / 未 push |

---

## 8. 建议的下一步（需你裁决）

| | 方向 | 说明 |
|---|---|---|
| **V1** | 直接查 NocoBase `listMeta` 的服务端实现（框架 action），看它读哪张表/哪个缓存 | **只读**，能一次定死；比继续在插件侧猜有效 |
| **V2** | 放弃"让 listMeta 返回集合"，历史档案页改用**自定义 BlockModel** 直接调 `svc:historicalArchives`（服务端已有只读接口） | 回到 S2，你已否过；但它绕开了元数据可见性这个框架问题 |
| **V3** | 用 `dataSourcesRoles` 层面（strategy）声明 resources | 未验证，需要先做 V1 确认 |

**建议 V1**：这已经证明不是本插件 ACL 能解的，继续在插件侧试只会重复今天这三次无效实验。

---

## 9. 我的判断

P1 的假设错了两次（ACL、allowlist），我不想再猜第三次。

**"加权限就能修"这条路上我已经用掉三次尝试，应当停下来先读框架实现**。
