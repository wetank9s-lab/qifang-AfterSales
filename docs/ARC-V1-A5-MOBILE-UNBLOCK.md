# ARC-V1 · A5 移动端阻塞核查 —— 交接报告

> 时间：2026-11-10 · 环境：本地开发（`svc-app` / `svc-postgres` / `svc-nginx`，NocoBase 2.2.15）
> 生产：**零写入**（全程未连生产库、未部署）
> 结论：**V2 移动端可用。此前的"无法创建页面"结论是错的，根因是我用错了 URL 形态。**

---

## 0. 一句话结论

你人工创建的「档案移动测试」**已经成功落库、已经能在 V2 移动端打开、已经能授权给门店销售**。
上一轮我报的"页面建在了错误入口"**也是错的**——页面在 V2 里，是我拿 `/v/mobile/<uid>` 去访问，
而 V2 的真实地址是 **`/v/mobile/<uid>`（重定向后的最终形态）**，我在中途多次测了 `page/`、`flowPage/`
这些不存在的形态，误判成"页面没建成"。

---

## 1. 真实路由与 FlowModel 结构（第 1 项）

**路由行（`desktopRoutes`）**

| 字段 | 值 |
|---|---|
| id | `396888170692608` |
| type | `flowPage` |
| title | 档案移动测试 |
| schemaUid | `n5c25yq5qlt` |
| menuSchemaUid | `x4d16a0cx0b` |
| icon | `snippetsoutlined` |
| enableTabs | false |
| parentId | 无（顶层） |

子路由：`396888170692609` / `type=tabs` / `schemaUid=97x481j2bv1` / `hidden=true`

**FlowModel 树**（真实链在 `flowModelTreePath`，**不是** `flowModels.options.parentId`）

```
n5c25yq5qlt  (RouteModel — 路由根)
└── 3ebe3d19d1c  use=MobileRootPageModel  subKey=page
        （当前为空：props={} stepParams={}）
```

tabs 分支：`97x481j2bv1` → `fbbc7e231c3` `use=BlockGridModel` `subKey=grid`（空）

> **取证脚本**：`scripts/arc-a5-page-structure.mjs`（全程只读 SELECT）
> ⚠️ 三条踩过的坑写进脚本注释了：`desktopRoutes` 没有 `flowRegistry` 列；`flowModels` 只有
> `uid/name/options` 三列；父子关系必须查 `flowModelTreePath(ancestor, descendant, depth)`。

---

## 2. 刷新后可正常打开（第 2 项）—— 10/10 PASS

**正确的 URL 形态（实测得出）**

| 形态 | 结果 |
|---|---|
| `/v/mobile` | ✅ 自动重定向到 `/v/mobile/n5c25yq5qlt` |
| `/v/mobile/n5c25yq5qlt` | ✅ 直接打开 |
| `/v/mobile/flowPage/<uid>` | ❌ 404 |
| `/v/mobile/page/<uid>` | ❌ 404 |
| `/m/...`（V1 入口） | ❌ 404 / "暂无页面" |

> `/{type}/{schemaUid}` 是**底部标签路由**的内部拼接规则，不是浏览器地址栏形态。
> 我把它当地址栏用，制造了整轮的假 404。

**验证结果**

| # | 断言 | 结果 |
|---|---|---|
| 2a | `/v/mobile` 自动落到该页并渲染出标题 | PASS |
| 2b | 直连 URL 可打开 | PASS |
| 2c | 强制刷新（`ignoreCache`）后仍打开 | PASS |
| 2d | 离开后再进入仍打开 | PASS |
| R | 反向对照：不存在的桌面页面 uid 打不开 | PASS |

**截图**：`.tmp-verify/arc-a5-vmobile-rendered-*.png`（admin 视角）、`arc-a5-sales-mobile-*.png`（销售视角）

页面当前状态：手机框 + 顶部标题「档案移动测试」+ 底部单标签 + **中间内容区空白**（因为还没放区块）。

---

## 3. store_sales 移动端访问（第 3 项）

- 本页路由的角色授权已设为：`admin, member, store_sales`
- 授权前销售账号 `desktopRoutes:listAccessible?layout=mobile-layout-model` **不含**本页
- 授权后**含**本页
- 只授了这**一条**路由（`desktopRoutes: [{ id: 396888170692608 }]`），未动其它 42 条

| # | 断言 | 结果 |
|---|---|---|
| 3a | 授权前销售看不到（正向对照） | PASS |
| 3b | 授权后销售能看到 | PASS |

---

## 4. 真实销售账号验证路由可见性（第 4 项）

用 `arc1.sales.a@svc.local`（A 店）真实登录浏览器：

| # | 断言 | 结果 |
|---|---|---|
| 4a | 登录后 `/v/mobile` 直接显示该页 | PASS |
| 4b | 可直连该页 URL | PASS |
| 4c | 销售B（另一家店）同样能看到入口 | PASS |

> 4c 说明：**这是菜单级权限**。数据级隔离由 `svc:` 动作按 actor 绑定门店裁决（见第 5 项 ②e）。

---

## 5. 页面如何调用受控 `svc:archiveCreate` / `archiveUpdate` / `archivePhotoAttach`（第 5 项）—— 18/18 PASS

### 5.1 关键事实（全部实测）

| 事实 | 证据 |
|---|---|
| `svc` 是**全局单例资源** | `plugin.ts`: `resourcer.define({ name:'svc', type:'single', ... })`；未带 token 访问返回 **401 而非 404** |
| 地址形态 | `POST /api/svc:<action>`，**不绑定任何 collection** |
| 自定义操作事件可用 | `workflow-custom-action-trigger` = **enabled** |
| 自定义请求可用 | `action-custom-request` = **enabled** |

> **这意味着**：V2 移动端**不需要**把页面绑到 `serviceArchives` 才能调业务动作。
> 这是"不开放原生写"这条铁律能守住的根本原因。

### 5.2 原生写必须关闭（①）

| 角色 | `serviceArchives:create` | `:update` | `:destroy` |
|---|---|---|---|
| 销售A | 403 | 403 | 403 |
| 负责人A | 403 | 403 | 403 |

**反向对照 ①d**：同一个销售A 通过 `svc:archiveCreate` **创建成功（200）**
⇒ 证明上面的 403 是"通道被关"，不是"这个角色什么都干不了"。

### 5.3 服务端校验真实生效（②）

| # | 断言 | 结果 |
|---|---|---|
| ②a | 缺前后照片时完工被拒 | PASS（`ARCHIVE_*` 业务错误） |
| ②b | 带正确 `expected_version` 编辑成功 | PASS（200） |
| ②c | 过期 `expected_version` 编辑被拒 | PASS（**409 ARCHIVE_STALE**） |
| ②d | 非 multipart 调 `archivePhotoAttach` 被拒 | PASS（422 NO_FILE） |
| ②e | 请求体传 `store_id=4`（非本店）被直接拒绝且不落库 | PASS（**404 ARCHIVE_NOT_FOUND**） |
| ②f | 正向对照：同账号建本店(1)成功 | PASS（200，store_id=1） |

> ⚠️ **契约来自源码**（`actions/svc/archive.ts`），不是猜的：
> 参数名是 **`id` + `expected_version`**，不是 `archive_id` / `version`。
> 我第一次猜错，拿到 `ARCHIVE_BAD_ID` 还以为"接口坏了"。

### 5.4 浏览器内直连（③）—— 这是"按钮能接上"的直接证据

在**真实销售会话 + 移动端页面上下文**里执行 `fetch`：

```js
// 成功
await fetch('/api/svc:archiveCreate', { method:'POST', headers:{ Authorization:'Bearer '+tk }, body: ... })
// → 200

// 被拒
await fetch('/api/serviceArchives:create', { method:'POST', headers:{ Authorization:'Bearer '+tk }, body: ... })
// → 403 { message: 'No permissions' }
```

| # | 断言 | 结果 |
|---|---|---|
| ③a | 浏览器内持有真实销售 token | PASS |
| ③b | 页面上下文内 `/api/svc:archiveCreate` 成功 | PASS（200） |
| ③c | 同一会话 `/api/serviceArchives:create` 被拒 | PASS（403） |

### 5.5 可行的接线方式（3 条，按推荐顺序）

1. **「自定义请求」动作（推荐，最直接）**
   在移动页面上放一个 Button 区块 → 动作选「自定义请求」→ 填 `POST /api/svc:archiveCreate`
   → Body 用变量取表单值。**不绑 collection，不碰原生写。**
   局限：multipart 上传（照片）用这个方法不顺手，需配合下面的方式。

2. **「自定义操作事件」工作流（适合带表单/带记录的场景）**
   `workflow-custom-action-trigger` 已启用：在某个表单的自定义按钮上挂工作流，
   工作流内用「HTTP 请求」节点调 `svc:`。适合"提交后要跑一串编排"的场景。

3. **iframe / 局部自绘（照片上传到这一步才需要）**
   当前 `archivePhotoAttach` 是 `multipart/form-data; file=`。V2 原生表单不产出该形态，
   所以**照片上传这一段**建议用 iframe 嵌一段 30 行的上传组件，
   或在工作流里用 `workflow-javascript` 节点转 multipart 再转发。

> **不建议**的方案：为移动端单独做一个"员工 H5 应用"。这会和现有匿名 H5、后台形成三套 UI，
> 违背"不重复造表/不重复造状态机"的原则。**目前没有这个必要**。

---

## 6. 我在本轮犯的错（写下来防复发）

| # | 错误 | 代价 | 教训 |
|---|---|---|---|
| 1 | 把 `/{type}/{schemaUid}` 当浏览器地址栏形态 | 整轮假 404，误判"页面没建成" | **断言"打不开"之前，先用一个已知能打开的页面验证 URL 形态** |
| 2 | 用 `/v/mobile/zzzznotexist` 做反向对照 | 假红（它兜底到默认页） | 反向对照必须选**有区分力**的路径 |
| 3 | 断言 `len>20` 才算"渲染出内容" | 页面只有 13 字被判失败 | 判据要落在**关键内容**（标题出现）而非长度 |
| 4 | 授权前不撤销就测"授权前看不到" | 第二次运行必假红 | **脚本必须可重入**：先撤再测 |
| 5 | 清 `localStorage` 想切账号 | 登录超时，误以为密码错 | 会话在 **httpOnly cookie**，必须走 `auth:signOut` + `clearBrowserCookies` |
| 6 | `localStorage.getItem('NOCOBASE_TOKEN')` 判真值 | 空串也判"已登录" | 改成判 `长度 > 20` |
| 7 | 凭据用 `\S+` 解析 | 含空格的口令被截断 → 登录 400 | 取**第一个冒号后的全部内容** |
| 8 | 猜 `archive_id` / `version` 参数名 | 4 条断言假红 | **参数名回源码查，不猜** |
| 9 | 以为跨店会被"静默改成本店" | 判据写反 | 实测是**直接拒绝**（404），比想象更严格 |

---

## 7. 环境现状（全部可回滚）

| 项 | 状态 |
|---|---|
| `mobileRoutes` / `rolesMobileRoutes` / `main_mobileRoutes_path` | **全部 0 行**（实验中建过又全部清掉；V2 不用这三张表） |
| 孤儿 path 行 | 已清理 2 条（上次"精确删除"漏删的 `main_mobileRoutes_path`） |
| `service_archives` 测试数据 | 已清理 6 条（id 27–32），事件表同步清理 |
| 本页角色授权 | 保留 `admin, member, store_sales` |
| 生产 | **零写入** |

**备份**：`.tmp-verify/arc-a5-mobileroutes-backup-20261110-095610.json`
**凭据文件权限**：`.tmp-verify/admin-credential-dev.txt` 已收紧为 `Administrator(R,W) + SYSTEM(F)`

---

## 8. 下一步（等你裁决，不自动推进）

按你定的第 7 条「在第一个真实业务页能建/拍/存/再编辑之前，不批量生成页面」：

1. **先在这一个页面上放最小区块**：一个「新建档案」表单（客户姓名/手机/地址/机型）+ 提交按钮
2. 提交按钮用**「自定义请求」**接 `/api/svc:archiveCreate`（不绑 collection）
3. 验证：提交后库里真的多一条、列表能刷新出来、再点进去能编辑（走 `svc:archiveUpdate`）
4. 通过之后再考虑照片上传那一段

**需要你确认的**：第 2 步用「自定义请求」还是「自定义操作事件工作流」？
如果你没有偏好，我按**自定义请求**做（最少移动件、最贴近"按钮直连 svc:"）。

---

## 附：脚本清单

| 脚本 | 作用 | 结果 |
|---|---|---|
| `scripts/arc-a5-page-structure.mjs` | 只读取证路由 + FlowModel 树 | 只读 |
| `scripts/arc-a5-route-probe.mjs` | URL 形态探测（历史，已被后续修正） | — |
| `scripts/arc-a5-mobile-verify.mjs` | 第 2/3/4 项正式验证 | **10/10 PASS** |
| `scripts/arc-a5-action-integration.mjs` | 第 5 项集成可行性验证 | **18/18 PASS** |
