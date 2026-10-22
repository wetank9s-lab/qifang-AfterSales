# SEC-STORE-01 门店账号归属与隔离专项审计报告

> 日期：2026-10-19 · 状态：**审计完成 · 后端隔离正确 · 后台配置入口已补齐（待验收）**
> UX-01D M1 / UX-01C / UX-MEDIA-01 / P11-5 保持冻结 · Phase 11 IN PROGRESS · Release HOLD
>
> 未 commit / 未 push。**未修改真实客户工单**；所有测试用隔离夹具，按 ID 清理。

---

## 一、结论先行

| 问题 | 结论 |
|---|---|
| 目前究竟有没有「账号—门店」关系？ | **有**：`store_users(user_id, store_id)`；`scopeOf(actor).storeIds` 只从它计算 |
| 实际账号的门店关联是否缺失？ | **是**：4 个门店角色账号中 **2 个未绑定**（探针账号 + 1 个疑似真实门店账号） |
| 无门店归属账号能访问什么？ | **什么也看不到**（`scope=none`，fail-closed）：列表 0 行或 403，读/写单条 404/403 |
| 是否发生真实越权？ | **未发现**：A/B 跨店读、写、筛选、按 ID 直查全部被拒；原生写与敏感集合全 403 |
| 需要新增什么后台配置能力？ | **账号—门店授权页**（本轮已交付）+ 受控动作 + 审计 |
| 是否可宣称多租户权限完整 PASS？ | **后端隔离可判 PASS；后台配置与真实浏览器验收待你裁决**（本轮已补，见 §五） |

---

## 二、只读取证（对应你列的 8 问）

| # | 问题 | 事实 |
|---|---|---|
| 1 | 用户与业务角色存哪 | `users`（NocoBase 核心）+ `rolesUsers(userId, roleName)` |
| 2 | 门店授权关系存哪 | **`store_users(user_id, store_id)`**（本插件 `storeUsers` 集合） |
| 3 | 创建门店账号时如何指定门店 | **没有创建流程**。账号在 NocoBase 用户管理里创建（默认带 `member`），角色在角色管理里分配；`store_users` **只能靠 SQL / 种子**，**后台没有任何入口** |
| 4 | 总部管理员有无门店授权界面 | **没有**。`hq_admin` 访问原生 `storeUsers:list` / `users:list` / `roles:list` 全部 **403**（B-8 生效） |
| 5 | `scopeOf(actor).storeIds` 从哪算 | `PermissionService.loadStoreIds()`：仅当含 `store_after_sales` 角色时，查 `store_users WHERE user_id=?`；其它角色返回 `[]` |
| 6 | 未配置 storeIds 时如何处理 | `scopeOf` 判 `kind:'none'`（**fail-closed**）；`stores-read-scope` / `applyScope` 使其看不到任何门店业务；直接读单条返回 404/403 |
| 7 | 修改门店归属后旧会话何时生效 | **下一次请求立即生效**（每次请求重新查 `store_users`，无缓存）。实测：同一 token 改绑 S01→S02，列表立即只余 S02 |
| 8 | 有多少门店账号没绑门店 | **4 个门店角色账号，2 个未绑定**（`probe.store.a@example.com`、`h***@scqfls.cn`）；无"空范围=全店"的账号 |

> 未输出任何口令、私人手机号或 Token。账号邮箱在报告中按需掩码。

---

## 三、真实权限矩阵（隔离 UAT）

建立 A（S01）/ B（S02）/ C（门店角色、未绑定）三个账号，HQ 作参照；工单夹具为 S01、S02 各一张（测后删除）。

### 3.1 A / B：必须只看/只写本店

| 用例 | A（S01） | B（S02） |
|---|---|---|
| 原生 `serviceTickets:list` | 只含 S01 行 | 只含 S02 行 |
| 本店 `get` | 200 | 200 |
| 跨店 `get` | **404** | **404** |
| `filter[store_id]=他店` | **0 行** | **0 行** |
| 本店 / 跨店 `timeline` | 200 / **404** | 200 / **404** |
| 本店 / 跨店 客户媒体（`ticketMedia`） | 200 / **404** | 200 / **404** |
| 本店 / 跨店 `internal_note`（写） | 200 / **404** | 200 / **404** |
| 本店 / 跨店 `accept`（写） | 200 / **404** | 200 / **404** |
| `stores:list` / 他店 `stores:get` | 仅 `["S01"]` / **404** | 仅 `["S02"]` / **404** |
| 报修入口 `storeEntryLinks` | 仅 S01 | 仅 S02 |
| `updateStoreProfile`（改门店资料） | **403** | **403** |
| 原生 `storeUsers/users/roles:list`、`serviceTickets:update` | **全部 403** | 同左 |

### 3.2 C：无门店绑定 ⇒ fail-closed

| 用例 | 结果 |
|---|---|
| 工单列表 | **403**（早期该账号还带 `member` 角色时）/ 或 200 + 0 行（仅门店角色时） |
| 读任意工单 / `timeline` / 写备注 | **403 / 404 / 404** |
| `stores:list` | 0 行或 403 |
| 报修入口 | 0 条 |

> 两种形态都**不泄露任何门店数据**；差异来自账号是否还残留默认 `member` 角色（见 §六 B-27）。

### 3.3 改绑时效

同一登录会话、不重新登录：把 A 从 S01 改绑到 S02 ⇒ 列表立即只剩 S02；还原后恢复 S01。
说明 `storeIds` **没有缓存**，权限变更即时生效。

### 3.4 矩阵小结

**46 / 48 通过**；2 条"未通过"是断言写得太窄（期望 200+空数组，实际 403），
**实际行为更严格（fail-closed）**，不是缺陷。

---

## 四、发现了什么、没发现什么

### 4.1 未发现越权

- 客户端提交任意 `store_id` 不会获得对应权限（显式 filter 被收窄为空）；
- 跨店按 ID 直查不泄露存在性（404，非 403 详情）；
- 原生写全关；`users/roles/storeUsers` 对业务角色与 hq_admin 均 403；
- 门店资料写入需要 ADMIN（门店账号 403）。

### 4.2 真正的缺口：**没有后台配置入口**

- `store_users` 无界面、无受控接口；未绑定账号只能靠 SQL 修；
- 新建账号默认带 `member` 角色，若不清掉，ACL 可能以 `member` 作为"当前角色" ⇒ 处处 403；
- 以上导致"账号明明有门店角色，却看不到/改不了任何东西"，而管理员无从下手。

---

## 五、最小修复（已交付）

### 5.1 数据与接口

| 新增 | 说明 |
|---|---|
| `store_account_audits` | 用户 × 一次授权集合变更（old/new ids、操作人、request_id 唯一、只增不改） |
| `svc:storeAccounts` | 列出**门店角色账号** + 实际全部角色 + 当前门店 + 全部门店选项（仅 hq_admin） |
| `svc:updateStoreAccountStores` | **整体替换**授权门店：事务 + **用户行锁** + `expected_store_ids` 并发 + `request_id` 幂等 + 同事务审计 |

**没有**开放 users/roles/storeUsers 的原生读写；所有写仍走受控动作。
`store_ids: []` 合法 = 撤销全部门店（fail-closed）。

### 5.2 后台页面「门店账号」（仅 hq_admin）

- 顶部：门店角色账号数 / **未绑定数**（红标）；
- 表格：账号、姓名、**实际业务角色**（含 `member` 会标橙提示）、授权门店（未绑定红标）；
- 「配置门店」：勾选真实门店（含停用标记）→ 保存 → **重新读取**生效结果；
- 页面与菜单已播种（`/admin/<uid>`），仅 hq_admin 可见。

截图：`.tmp-verify/sec-store-01-edit.png`（配置弹窗）、`sec-store-01-after.png`（保存后 S01 生效）。

### 5.3 定向门禁 `verify-sec-store-01.mjs`：**25 / 25**

权限（匿名 401 / 三角色 403）· 校验（非门店角色、未知门店、缺并发基准、缺请求号 ⇒ 422）·
未绑定/撤销后 fail-closed · 绑定后同会话立即生效 · 并发 200+409 · 幂等回放 · 同号不同内容 409 ·
审计（旧→新+操作人，回放不重复写）· hq_admin 原生仍 403 · 真实浏览器配置→保存→回读 · 夹具账号与审计清理为 0。

### 5.4 一个必须记住的建号规则

> 新建账号请**只保留 `store_after_sales`**（移除默认 `member`），否则 ACL 可能以 `member` 为当前角色
> ⇒ 账号"有门店角色却处处 403"。页面会对含 `member` 的账号标橙提示。

已登记 **B-27**（建号流程规范化，不在本轮扩大范围）。

---

## 六、当前账号状态与遗留

| 账号 | 角色 | 门店 |
|---|---|---|
| `uat.store.a@svc.local` | store_after_sales | S01 |
| `uat.store.b@svc.local` | store_after_sales | S02 |
| `probe.store.a@example.com` | store_after_sales | **未绑定**（探针历史账号，可删） |
| `h***@scqfls.cn` | store_after_sales | **未绑定**（疑似真实门店账号，需你确认属于哪家店） |

> 测试用的临时账号（含 `uat.sec01.*`、C 账号）均已删除，审计/绑定/角色残留 **0**。
> 这两条未绑定记录**不构成越权**（fail-closed），但会让对应人员"登录后什么也看不到"。

---

## 七、边界

- 未改真实客户工单；测试工单（S01/S02 各 1 张）已按 ID 清理；
- 未放宽 B-8；未开放原生 users/roles/storeUsers；
- 未用 SQL 改 `rolesUsers` 或 `store_users` 做权限变更（改绑走受控动作；仅测试夹具清理用 SQL 按 ID 删除）；
- UX-01D M1 / UX-01C / UX-MEDIA-01 / P11-5 未触碰；Release 仍 HOLD。
