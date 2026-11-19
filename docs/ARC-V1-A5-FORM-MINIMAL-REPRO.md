# ARC-V1 · A5 首个原生移动业务表单 —— 最小复现与阻塞报告

> 时间：2026-11-10 · 环境：本地开发（`svc-app` / `svc-postgres` / `svc-nginx`，NocoBase 2.2.15）
> 生产：**零写入**（未连生产库、未部署）
> 本轮只改「档案移动测试」一个页面（`n5c25yq5qlt`），未触碰其他页面、未改 ACL、未改服务端代码、未 commit/push。
> **结论身份**：按你第 6 条停止条件，**停在最小复现**。表单**已经建在真实移动页面上**，按钮**已经绑到 `POST /api/svc:archiveCreate`**，但**真实门店账号目前跑不通**，原因不在配置手法，而在三处平台/契约层面的硬约束（下文 B1/B2/B3，每条都有可复现的取证）。

---

## 0. 一句话

**做了的**：V2 移动端「新建上门服务档案」表单（9 字段）+「自定义请求」提交按钮，全部持久化到 `flowModels` / `customRequests`，配置与变量绑定完整。
**没做成的**：让真实门店销售把这单真正提交出去 —— 被三处阻塞挡住；其中 **B1（非管理员角色读不到 collection 字段元数据，区块退化成"数据表可能已被删除"）** 是根因级阻塞，改配置绕不过去。

---

## 1. 表单是否真的建出来了（第 7 条 · 问题一）

**是。** 落库位置与结构（`flowModels`，可 `SELECT` 复现）：

```
n5c25yq5qlt  RouteModel            （desktopRoutes 396888170692608, flowPage, 档案移动测试）
└─ 3ebe3d19d1c  MobileRootPageModel   subKey=page
   └─ 97x481j2bv1  RouteModel(tabs)    subKey=grid 父
      └─ fbbc7e231c3  BlockGridModel    subKey=grid   ← 区块真正的挂载点
         └─ c2d0e320f4c  CreateFormModel collectionName=serviceArchives
            ├─ f5fbb7bb373  FormGridModel  subKey=grid
            │  └─ 9 × FormItemModel
            └─ 88bc036b9d8  CustomRequestActionModel  subKey=actions
```

**9 个字段（真实 `fieldPath`，按 `sortIndex`）**

| # | fieldPath | 对应业务字段 |
|---|---|---|
| 1 | `archive_type` | 档案类型 |
| 2 | `customer_name` | 客户姓名 |
| 4 | `service_address` | 服务地址 |
| 5 | `service_type` | 服务类型 |
| 6 | `customer_mobile` | 客户手机 |
| 7 | `product_description` | 产品/机型描述 |
| 8 | `planned_date` | 预约日期 |
| 9 | `store` | 所属门店（关联） |
| 9 | `public_note` | 对客户说明 |

> 注：`sortIndex` 有两条都是 9（`store` 与 `public_note`），是后台拖拽后未重排序的正常残留，不影响渲染顺序的稳定性（按 uid 次序稳定）。**这是缺陷，不是结论**：应在后续版本里重排一次。

**取证脚本**（只读 SQL）：本轮新增 `.tmp-verify/ui41.mjs`（元数据矩阵）、`.tmp-verify/ui42-requestid.mjs`（请求头契约）。

---

## 2. 按钮是否真的调用 `svc:archiveCreate`（第 7 条 · 问题二）

**是，配置层面完全正确且已持久化。**

```json
// flowModels.88bc036b9d8
options.stepParams.customRequestClickSettings.sendRequest =
{ "key": "req-29rvlpwwmmz", "configured": true, "variablePaths": [], "responseType": "json" }

// customRequests.req-29rvlpwwmmz.options
{ "method": "POST",
  "url": "/api/svc:archiveCreate",
  "headers": [{ "name": "X-Request-Id", "value": "{{$nToken}}" }],
  "data": { "archive_type": "{{$nForm.archive_type}}", "customer_name": "{{$nForm.customer_name}}",
            "customer_mobile": "{{$nForm.customer_mobile}}", "service_address": "{{$nForm.service_address}}",
            "service_type": "{{$nForm.service_type}}", "product_description": "{{$nForm.product_description}}",
            "planned_date": "{{$nForm.planned_date}}", "store_id": "{{$nForm.store}}" },
  "timeout": 5000, "responseType": "json" }
```

- 目标地址**不是** `serviceArchives:create`（未走原生写接口）✔
- 表单值通过 `$nForm.<field>` 逐字段绑定，后台「请求设置」保存时 `customRequests:updateOrCreate` 200 + `flowModels:save` 200 ✔

---

## 3. 三处硬阻塞（第 6 条停止条件的具体限制）

### B1 ★根因级：非管理员角色读不到 `serviceArchives` 的字段元数据 ⇒ 区块不渲染

同一页面、同一会话，四个账号的对照（`.tmp-verify/ui41.mjs`）：

| 账号 | 角色 | `collections:listMeta` | 集合数 | 含 `serviceArchives` | fields | 页面实际渲染 |
|---|---|---|---|---|---|---|
| `arc1.sales.a` | `store_sales` | 200 | 4 | **false** | 0 | 「数据表 "主数据源 > serviceArchives" 可能已被删除」 |
| `arc1.sales.b` | `store_sales` | 200 | 4 | **false** | 0 | 同上 |
| `arc1.mgr.a` | `store_manager` | 200 | 4 | **false** | 0 | 页面级 404（未授予根路由） |
| `uat.hqadmin` | `hq_admin` | 200 | 5 | **false** | 0 | 页面级 404（未授予根路由） |

**根因取证**（不是猜的）：

```
GET /api/collections:listMeta?paginate=false      → 200，但返回的集合清单里没有 serviceArchives
GET /api/collections:list                          → 403 {"message":"No permissions"}
GET /api/fields:list?filter[collectionName]=…      → 403 {"message":"No permissions"}
```

而 `roles:check` 明确显示这些角色**确实拥有** `serviceArchives:view / list / get`：

```
【A店销售】角色=["store_sales"]
  已授权动作 = serviceArchives:view | serviceArchives:list | serviceArchives:get
               serviceArchiveStages:* | serviceArchiveEvents:* | stores:* ...
```

⇒ **业务动作已授权，但集合/字段的"元数据"没授权**。V2 表单区块必须拿到字段元数据才能渲染控件；拿不到就降级成"数据表可能已被删除"。`dataSourcesRolesResources` 里对 `collections` / `fields` 两个资源 **没有任何角色有行**。

**这为什么不能靠"改配置"绕开**：区块渲染路径是前端 → `listMeta` → 查 `collection.fields` 构建控件。元数据缺失是数据层事实，不是 CSS/参数问题。唯一的合法修法是**给角色授予 `collections:list` / `fields:list`（或对应资源）**——这正是你第 6 条明确禁止我做的事（"不要自行修改 ACL"）。

> 附带发现（不影响结论）：`arc1.mgr.a` 与 `uat.hqadmin` 打该页是 **页面级 404**，因为根路由 `396888170692608` 只授给了 `admin / member / store_sales`（`rolesDesktopRoutes` 三行）。这是**授权缺失**，不是页面不存在。按第 6 条的"不改 ACL"，我没有补授。

### B2 `X-Request-Id` 无法在「自定义请求」的请求头里生成 UUID v4

- 请求头「值」输入框只接受**变量**（`{{$nForm.*}}` / `{{$nToken}}` / `{{$nUser.*}}`），**没有表达式、没有内置函数、没有 UUID 生成器**。
- 当前填的是 `{{$nToken}}`，而 `$nToken` 是登录 JWT（长度 **257**）。
- 服务端契约（`src/shared/svc-request.ts`）：

```ts
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
```

**实测**（`.tmp-verify/ui42-requestid.mjs`，真实销售 token 当请求头送去）：

```
isUuidV4 = false
POST /api/svc:archiveCreate  →  422
{"errors":[{"code":"VALIDATION_FAILED",
            "message":"X-Request-Id 不是合法的 UUID v4",
            "detail":{"header":"X-Request-Id","received":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"}}]}
```

⇒ 即使 B1 修好，这一条也会让每次提交稳定 422。**替代方案**见第 5 节。

### B3 `store_id` 无法由表单安全取得（你已裁决的「列表回填」也卡在 B1 上）

- `$nForm` 里没有任何键能给出"当前账号的唯一门店"；`svc:archiveCreate` 的服务端门禁是 `assertCanWriteStore`（`actor.storeIds.includes(storeId)`），故意不允许前端自报。
- 你选的方案是：页面上放「我的档案」列表区块，取第一行 `store_id` 回填隐藏值。
- **但这个列表区块同样需要 `serviceArchives` 的字段元数据才能渲染** ⇒ 与 B1 同源，同样退化成"数据表可能已被删除"。

> 也就是说：`store_id` 不是第二个独立问题，它是 B1 的直接下游。

---

## 4. 第 4 条最小验收：逐项现状

| # | 验收项 | 现状 | 依据 |
|---|---|---|---|
| 1 | A 店销售填写并提交 → 真建档 | **未通过** | 区块不渲染（B1），提交根本不发生 |
| 2 | B 店销售同页 → 落到 B 店 | **未通过** | 同上 |
| 3 | 刷新后可查询并重开该档案 | **未通过** | 无档案产生 |
| 4 | 接口失败时已填内容不丢失 | **未验证** | 表单未渲染，无从验证 |
| 5 | 原生 `serviceArchives:create/update/destroy` 仍 403 | **未复跑**（第 4 条要求不重复历史 18 条） | 历史结论 `scripts/arc-a5-action-integration.mjs` 18/18 PASS 仍成立，本轮未改 ACL |
| 6 | 经理/总部不能用此按钮写 | **未通过验证**（两者连页面都进不去，属"更严"而非"通过"） | 页面级 404 |

---

## 5. 三条可选路线（等你裁决，我不自行推进）

### 路线 A：补"元数据只读"授权（推荐，最小改动）
给 `store_sales` / `store_manager` / `hq_admin` 追加**只读**的 `collections:list` + `fields:list`（不含任何数据动作）。
- 改动面：ACL 表 2 类资源 × 3 角色，**不动任何业务写权限**
- 风险：把集合名与字段名暴露给这些角色（schema 层信息，不含数据行）
- 代价：需要你授权我"修改 ACL"——这与第 6 条冲突，**必须你点头**

### 路线 B：不用 V2 表单区块，回到"列表区块 + 弹窗表单"或纯 H5
绕开表单区块的元数据依赖，但**列表区块同样依赖元数据**（B3 已验证）。纯 H5 则违反第 5 条"不重写第二套员工 H5"。

### 路线 C：换掉 B2 的实现方式
`X-Request-Id` 目前无解，可行替代：
1. 服务端支持 `Idempotency-Key` 之类的**非 UUID** 头 —— 属改契约，不在本轮范围
2. 让「自定义请求」走一个**预先签发的 UUID**（例如把 UUID 塞进 `$nForm` 的隐藏字段，由页面初始化时生成）—— 但 V2 表单没有"初始化时执行 JS"的安全入口，且第 5 条禁止 JS 脚本
3. 由服务端在缺失时**自行生成**并只对"无头"请求降级为不幂等 —— 属改服务端，不在本轮范围

---

## 6. `archiveUpdate` 与照片上传还差什么（第 7 条 · 问题六）

| 能力 | 现状 | 还差什么 |
|---|---|---|
| `archiveCreate` | 按钮与变量绑定已完成 | B1（渲染）+ B2（请求头 UUID）+ B3（store_id） |
| `archiveUpdate` | **零实现** | 需「档案详情」页 + `expected_version` 乐观锁（服务端读 `id` + `expected_version`）；乐观锁版本号必须在提交前由 `archiveGet` 取回并随请求带出，V2 表单没有"先取后填"的原生步骤 |
| 照片上传 | **零实现** | 需 multipart + 私有存储 + `archivePhotoAttach` / `archivePhotoPublish`；V2「自定义请求」的请求体是 JSON 对象，**不支持 multipart**，这是与 B2 同级的能力缺口 |

---

## 7. 本轮未做的事（对照第 5 条）

- ✘ 未做 multipart 照片上传
- ✘ 未做空调六阶段
- ✘ 未用「自定义操作事件」工作流
- ✘ 未生成其余六个页面
- ✘ 未改 NocoBase 默认前端入口
- ✘ 未开放任何原生 collection 写权限
- ✘ 未改 ACL（B1 的修法**等你裁决**）
- ✘ 未改服务端代码（B2 的修法**等你裁决**）
- ✘ 未 commit / push，未部署生产，未清库

---

## 8. 附：本轮取证脚本

| 脚本 | 用途 | 结果 |
|---|---|---|
| `.tmp-verify/ui32.mjs` | UI 登录方式的角色对照 | 登录态不稳，已弃用（保留教训） |
| `.tmp-verify/ui33.mjs` | API 登录 + 注入 token 的角色对照 | 证明四账号 `listMeta` 均缺 `serviceArchives` |
| `.tmp-verify/ui34.mjs` | 页面加载期全量接口抓取 | 16 条请求、0 条非 2xx（**说明不是接口报错，是载荷里没有**） |
| `.tmp-verify/ui35.mjs` | 逐接口复打定位 | `collections:list/listMeta` 403 / 载荷缺失 |
| `.tmp-verify/ui41.mjs` | **四账号元数据矩阵（主证据）** | 见第 3 节表格 |
| `.tmp-verify/ui42-requestid.mjs` | **X-Request-Id 契约反证** | 422 `X-Request-Id 不是合法的 UUID v4` |
| `.tmp-verify/arc-a5-b1-*.png` | 各角色页面截图 | 「数据表……可能已被删除」 |

**截图**：`.tmp-verify/arc-a5-b1-A店销售-1794280987799.png`（销售视角，区块降级）
