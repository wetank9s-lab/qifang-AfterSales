# BE-02B 一次性隔离 UAT 环境预检报告（进行中）

> 日期：2026-10-21 · 状态：**隔离实例已可用；夹具与页面 seed 未完成**
> 未执行转单、未写原库、未 commit / push。

---

## 1. 先纠正上一轮的一个错误判断

上一轮我写"**插件在新库未启用**，所以 `store-entry` 404"。**这个结论是错的。**

实测：

```sql
select name, enabled, installed from "applicationPlugins" where name like '%service-ticket%';
-- 新库 service_ticket_verify: service-ticket | t | t
-- 原库 service_ticket:        service-ticket | t | t
```

**插件一直是 enabled=true、installed=true。**

### 404 的真正原因

`/api/public/store-entry` 这个**路径**在原实例能 200，新实例 404 —— 但**同一个 handler** 用 action 形式两边都通：

```
curl http://127.0.0.1:13001/api/publicStore:entry?k=S01.xxx
→ 200 {"data":{"code":"S01","name":"新都圣大家电","phone":null,...}}
```

- `PUBLIC_RESOURCE.STORE = 'publicStore'`、`PUBLIC_ACTION.STORE_ENTRY`
- 注册位置 `plugin.ts:1517`：`` [`${PUBLIC_RESOURCE.STORE}:${PUBLIC_ACTION.STORE_ENTRY}`] ``
- **真实 action 名是 `publicStore:entry`**
- `/api/public/store-entry` 是**另一层路径映射**（原实例某处把 `public/xxx-yyy` 转成 `publicXxx:yyy`），新实例没有这层

**所以上一轮的 BLOCKED 判断是基于错误归因**。插件没问题，是**路径别名缺失**。

---

## 2. 隔离实例当前状态

| 项 | 状态 | 证据 |
|---|---|---|
| 独立容器 | ✅ | `svc-app-uat`（13001），`svc-app` 不受影响 |
| 独立数据库 | ✅ | `service_ticket_verify`，129 张表，`service_tickets=0` |
| 插件已启用 | ✅ | `applicationPlugins.enabled=t` |
| 业务 action 可达 | ✅ | `publicStore:entry` → **200** |
| 需认证接口 | ✅ | `svc:historicalArchiveQuery` → **401 EMPTY_TOKEN**（说明路由已注册，要登录） |
| 独立存储 | ✅ | `./storage-uat`（容器内 `/app/nocobase/storage`） |
| 主库未受影响 | ✅ | `service_tickets=489` |

**结论：隔离实例的"框架 + 插件 + 路由"已经通了。**

---

## 3. 还缺什么（未完成）

### 3.1 合成夹具

新库是 migration 出来的空壳：

| 项 | 现状 | 需要 |
|---|---|---|
| 门店 | `stores=15`（migration 自带） | **S01 的 `phone` 为空**（`phone:null`） |
| 门店账号 | `users=1`（install 的 admin） | `uat.store.a@svc.local`（绑 S01、角色 `store_after_sales`） |
| 历史档案 | **0 条** | 1 条已归档+未转换+有手机号的合成档案 |
| 已转换展示夹具 | 0 条 | 1 条（可选） |
| viewer 账号 | 0 | 1 个（用于权限反例） |

### 3.2 页面 seed

`seed-admin-pages.mjs` 把 BASE 写死成 `SVC_SCHEME://localhost:PORT`（nginx），**打不到 13001**。要让"历史售后档案"页面出现在隔离实例上，需要让它指到 13001（**改测试脚本，不改产品代码**，可以接受，但要动 700 行脚本的 BASE——有风险）。

### 3.3 H5 指向隔离实例

H5 请求是相对 `/api/...` → 落 nginx → 原实例。要让浏览器打到 13001，只能：

- **CDP `Fetch` 拦截**（不改任何配置/代码）：
  - 把 `/api/*` 的 host 改到 `127.0.0.1:13001`
  - **额外**把 `/api/public/store-entry` → `/api/publicStore:entry`（补上缺失的别名）

**这条我验证过 CDP 支持 `Fetch.continueRequest({ url })` 改写**，可行。

---

## 4. 剩余风险评估

| 风险 | 说明 |
|---|---|
| **seed 脚本要改 BASE** | 700 行脚本，改一处常量；但它的很多逻辑依赖原实例已有数据（角色、页面 uid），在空库上可能**跑不通** |
| **造档案必须走合法流程** | 合成档案要用 `historicalDrillFixture` + 上传 + 暂存 + 归属 + 归档（**正是 BE-02A 那一整套**），在隔离实例上要重跑一遍 |
| **时间成本** | 上面两件加起来不是几个工具调用能完成的 |
| **CDP 改写别名** | 属于测试层，不改产品；但要在拦截层同时处理 host 改写 + 路径改写，需仔细验证 |

---

## 5. 我的判断

**隔离环境的"底座"已经好了**（容器/库/插件/路由/存储全通，主库零影响）。

**但"能跑一次真实转单"还差三件**：夹具（账号+门店 phone+合成档案）、页面（S2 区块 seed）、H5 路由转发。

**这三件里，第 2 件（seed 700 行脚本到空库）最不确定**——它可能依赖原实例的历史数据。

---

## 6. 本轮各项状态

| 项 | 状态 |
|---|---|
| 独立应用 / 库 / 存储 | **PASS** |
| 插件启用 | **PASS**（此前误判为未启用） |
| 业务 action 可达 | **PASS**（`publicStore:entry` 200 / `historicalArchiveQuery` 401） |
| 合成账号 / 档案夹具 | **PENDING** |
| 历史档案页面在隔离实例可加载 | **PENDING**（未 seed） |
| 零写入浏览器预检 | **PENDING** |
| 原库基线 | **489 未变** ✓ |
| 转单 | **未执行** |

---

## 7. 申请

**BE-02B Gate 2 环境预检：HOLD（底座 PASS，夹具与页面未就绪）。**

**不申请写入授权**——因为现在即使授权，也没有可转的合成档案。

**下一步建议（等你选）**：

**选项 1**：继续搭（seed 页面 + 造夹具 + H5 转发），把环境做完整。**风险**：seed 脚本可能跑不通空库，要重试。

**选项 2**：**接受"底座已就绪"作为本轮的成果**，把夹具与预检并入下一轮（真实转单授权时一起做）。

**选项 3**：改用**一次性"全库拷贝"**——把主库整库 `pg_dump` 到一个新的 `*_verify` 库（**含数据**），在那上面测，测完整库销毁。
- 优点：**立刻有 124 条档案、26 条转换、489 张工单**，夹具全在
- 缺点：**新库里有真实客户数据** —— 但它是**完全独立的库、独立实例、独立存储**，测完整库销毁，**不碰主库**
- 我认为这是**最省事且风险可控**的路径，但要你确认"在隔离副本上使用真实数据做只读/受控测试"是否可接受

**我倾向选项 3**，但**不擅自执行**——因为涉及"真实客户数据进入测试库"这个判断。

未 commit / push。
