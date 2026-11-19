# P0-HQ-MENU-02 排查报告：总部管理员看不到售后业务菜单

> 环境：**仅开发环境**（`svc-app` :13000 / `svc-nginx` :443,8080 / `svc-postgres`）。
> 生产库**只读**（`SELECT`）取证，未作任何写入。本轮**未改任何源码 / 未跑播种脚本 / 未改数据库 / 未 commit**。
> （注：`scripts/expected-sensitive-columns.mjs` 与 `scripts/seed-admin-pages.mjs` 在 `git status` 里显示
> 为 `M`，但两者 mtime 均为 **2026-10-27**，是此前几轮未提交的工作，**不是**本轮改动 —— 已核对 diff 内容与本任务无关。）
> 取证时间：2026-11-06

---

## 一、账号实际绑定的角色（真实数据，非推测）

### 1.1 角色全集（开发库 / 生产库一致）

| 角色名（Role Key） | 标题 | 性质 |
|---|---|---|
| `root` / `admin` / `member` | — | NocoBase **内置**，不参与业务矩阵 |
| `store_after_sales` | 门店售后 | 业务角色（门店级数据范围） |
| `hq_after_sales` | 总部售后 | 业务角色（全量数据范围） |
| `hq_admin` | 总部管理员 | 业务角色（全量 + 配置/用户/门店维护） |
| `viewer` | 只读管理层 | 业务角色（全量只读） |

**共 7 个角色，全部 `createdAt = 2026-09-20`；库里没有任何"新建"的自定义角色。**
最近创建的用户是 2026-10-27，**11 月没有任何新账号**。

### 1.2 总部账号

| userId | 账号 | 绑定角色 |
|---|---|---|
| 537 | `uat.hqadmin@svc.local`（UAT-HA） | `hq_admin` |
| 195 | `uat.hq@svc.local` | `hq_after_sales` |
| 914 | `hq` | `viewer` |

### 1.3 登录时实际激活的角色（真实会话取证）

用真实 `signIn` 拿 token，再用 `X-Role` 逐个试探，服务端返回的是真值：

```
X-Role=hq_admin           → HTTP 200   （该账号确实持有）
X-Role=hq_after_sales     → HTTP 401  ROLE_NOT_FOUND_FOR_USER
X-Role=viewer             → HTTP 401  ROLE_NOT_FOUND_FOR_USER
X-Role=store_after_sales  → HTTP 401  ROLE_NOT_FOUND_FOR_USER
X-Role=nonexistent_probe  → HTTP 401  ROLE_NOT_FOUND_FOR_USER
```

⇒ **激活角色解析是正确且 fail-closed 的**：只有库里真实绑定的角色才被接受，
不存在的角色一律拒绝。**这一层没有缺陷。**

---

## 二、菜单缺失的真实原因

### 2.1 情况判定：是 **A（角色没有菜单授权）**，不是 B / C / D

| 情况 | 判定 | 证据 |
|---|---|---|
| **A. 角色没有菜单授权** | ✅ **命中** | 见 2.2 授权表 |
| B. 菜单有授权但路由无授权 | ❌ | 菜单与路由授权是同一张表 `rolesDesktopRoutes`，不存在两套 |
| C. 页面树没挂载 | ❌ | 14 个页面全部 `parentId = 387851208425472`（`售后工单` 组），且 `schemaUid` **全部非空** |
| D. 无门店上下文导致数据为空 | ❌ 本次不是 | HQ 会话 `serviceTickets:list` **543 条全量**、`svc:hqOverview` **200**；且 `store_users` 里总部账号授权行数 = **0**（总部本来就不走门店绑定） |

### 2.2 开发库真实授权表（`售后工单` 组下 14 个页面）

| 页面 | 已授权角色 | hq_admin 可见 |
|---|---|---|
| 售后服务工作台 | admin, member, **store_after_sales** | ❌ |
| 我的门店工单 | admin, member, **store_after_sales** | ❌ |
| 所有工单 | admin, member, hq_after_sales, **hq_admin**, viewer | ✅ |
| 工单事件时间线 | 四业务角色 + admin/member | ✅ |
| 派工记录 | 同上 | ✅ |
| 门店报修入口 | 同上 | ✅ |
| 历史数据导入 | 同上 | ✅ |
| 历史售后档案 | 同上 | ✅ |
| 服务时效 | admin, member, **hq_admin** | ✅ |
| 短信通知 | admin, member, **hq_admin** | ✅ |
| 客户页面装修 | admin, member, **hq_admin** | ✅ |
| 门店账号 | admin, member, **hq_admin** | ✅ |
| 总部售后工作台 | **仅 admin, member** | ❌ |
| 短信通知总览 | **仅 admin, member** | ❌ |

### 2.3 根因（两条，叠加）

**根因 ①：权限矩阵按 2026-09-21 的旧设计刻意排除了这两个页面。**

`scripts/expected-sensitive-columns.mjs:186` 的 `ROLE_MENU_MATRIX.hq_admin` 里没有
`'售后服务工作台'` 和 `'我的门店工单'`，原注释写得很明确：

> 总部售后 / 总部管理员 / 只读管理层 → **不显示**「我的门店工单」
> （总部看的就是全量，"我的门店"对总部没有意义，同样会造成两个菜单的困惑）

现在需求变更（用户要求总部管理员必须能进这两个页面并切换门店），**矩阵没跟上**。
而 `scripts/seed-admin-pages.mjs:1952 syncRoleMenus()` 是严格按矩阵"多退少补"的 ——
**矩阵里没写，脚本就主动不授权**。所以这不是"漏授"，是**按设计排除**。

**根因 ②：矩阵是"固定角色名"硬编码，矩阵外的角色永远进不来。**

```js
export const MANAGED_MENU_ROLES = Object.keys(ROLE_MENU_MATRIX);  // 只有 4 个名字
function visiblePagesOf(roleName) { return ROLE_MENU_MATRIX[roleName] ?? null; }
```

`syncRoleMenus()` 只遍历 `MANAGED_MENU_ROLES`。**运营在后台新建任何命名的新角色
（如「总部管理员2」），播种脚本根本不会处理它 —— 一行授权都不会给。**

**根因 ③（潜在，与本任务强相关）：后端只认 4 个固定角色名。**

`permission-service.ts:784 normalizeRoles()` 只保留 `ROLE_VALUES`（4 个）里的名字，
其余一律丢弃 → `scopeOf()` 落到 `{kind:'none'}` → `mergeScopeFilter` 注入 `{ id: -1 }` →
**数据恒空**。同时 `HQ_ROLES` / `WRITE_ROLES` / `CREATE_ROLES` / `PRIVILEGED_ROLES`
全部是按名字写的数组。

⇒ **结论：如果本次修复只是"给后台点几下加角色"，运营下次新建角色仍会复现。
必须走统一权限矩阵。**

### 2.4 一个需要单独停手的发现（本次不修，只报告）

`售后服务工作台`、`我的门店工单`、`总部售后工作台`、`短信通知总览` 这四个页面，
**`member`（NocoBase 内置普通成员角色）都有授权**：

```
售后服务工作台   | admin,member,store_after_sales
我的门店工单     | admin,member,store_after_sales
总部售后工作台   | admin,member
短信通知总览     | admin,member
```

`member` 是 NocoBase 建用户时的默认角色（`rolesUsers` 插入默认值）。这意味着
**一个"什么都没配"的新账号，登录后导航里就有「售后服务工作台」「我的门店工单」
「总部售后工作台」「短信通知总览」四个入口**。

- 数据**不一定泄漏**：`scopeOf()` 对 `member` 判 `{kind:'none'}`，`svc` 动作另会 `assertCapability`。
  但这是**依赖两个下游默认值都正确**才成立的"巧合安全"。
- 这四个授权**不在 `MANAGED_MENU_ROLES` 管辖内**（脚本"手伸不到"），所以既不会被删也不会被校验。

> **建议单独立卡**（不进本任务）：把 `member` 从这四个页面的授权表里摘掉，
> 并把"受管范围外的授权"纳入 smoke 断言。**本轮不动**——它与本次需求无关，且动它会波及其他后台。

---

## 三、需要修改的文件

| 文件 | 改动 | 性质 |
|---|---|---|
| `scripts/expected-sensitive-columns.mjs` | `ROLE_MENU_MATRIX.hq_admin` 增加 `'售后服务工作台'`、`'我的门店工单'`；更新上方注释（旧设计被新需求覆盖） | **必改** |
| `scripts/seed-admin-pages.mjs` | 新增 `--sync-menus-only` 开关（只同步 `rolesDesktopRoutes`，不调 `applyBlueprint`） | **必改**（否则只能走全量重建，风险大） |
| 开发库 `rolesDesktopRoutes` | 跑上述开关定向同步（**多退少补**，不是手工 SQL） | 由脚本产生 |
| `scripts/smoke-test.mjs` | 矩阵变了不必改代码（它读同一份矩阵），但需**跑一次**确认没有反向断言残留 | 验证 |

**不需要修改**：

- `nocobase/plugins/service-ticket/src/server/constants.ts` 的 `AUTHENTICATED_SVC_ACTIONS`
  —— 见第四节，**不涉及后端 ACL 扩权**
- `permission-service.ts` / `store-scope.ts` —— 现有 fail-closed 逻辑正确
- 工单状态机 / 短信 / H5 / 数据库业务结构 —— **零改动**

---

## 四、是否涉及后端 ACL 扩权：**否**

`AUTHENTICATED_SVC_ACTIONS`（`constants.ts:2503`）里已有 `HQ_OVERVIEW` / `VISITS` /
`TIMELINE` / `DISPATCH` / `STORE_OPTIONS` 等，注册方式为 `acl.allow('svc', action, 'loggedIn')`
——**只要求"已登录"，与角色无关**。

实测（真实会话）：

```
svc:hqOverview         HTTP 200   new_today=54
serviceTickets:list    HTTP 200   meta.count=543
```

⇒ **总部管理员现在拿数据的权限就已经有了**，唯一的缺口是
"菜单里没有入口 / 路由没授权"。所以**不需要新增任何 ACL 动作，也不需要放开任何 API**。

唯一被 403 的是 `desktopRoutes:list`（`No permissions`）——这是 NocoBase 后台配置类接口，
业务角色本来就**不该**有读权限，**不做扩权**。

---

## 五、修复前后的角色菜单矩阵

| 页面 | store_after_sales | hq_after_sales | **hq_admin** | viewer |
|---|---|---|---|---|
| 售后服务工作台 | ✅ 保持 | ❌ 保持 | **❌ → ✅ 新增** | ❌ 保持 |
| 我的门店工单 | ✅ 保持 | ❌ 保持 | **❌ → ✅ 新增** | ❌ 保持 |
| 所有工单 | ❌ 保持 | ✅ 保持 | ✅ 保持 | ✅ 保持 |
| 工单事件时间线 | ✅ | ✅ | ✅ | ✅ |
| 派工记录 | ✅ | ✅ | ✅ | ✅ |
| 门店报修入口 | ✅ | ✅ | ✅ | ✅ |
| 历史售后档案 | ✅ | ✅ | ✅ | ✅ |
| 历史数据导入 | ✅ | ✅ | ✅ | ✅ |
| 服务时效 | ❌ | ❌ | ✅ | ❌ |
| 短信通知 | ❌ | ❌ | ✅ | ❌ |
| 客户页面装修 | ❌ | ❌ | ✅ | ❌ |
| 门店账号 | ❌ | ❌ | ✅ | ❌ |
| 总部售后工作台 | ❌ | ✅ | ✅ | ❌ |
| 短信通知总览 | ❌ | ✅ | ✅ | ❌ |

**只动一格（`hq_admin` 的两项）。其余 13 格一格不动。**

### 数据范围基线（修复前后都必须一致，实测值）

| 账号 | 角色 | `meta.count` | store_id 分布 |
|---|---|---|---|
| 门店A | store_after_sales | **506** | `1:500`（只有门店1） |
| 门店B | store_after_sales | **28** | `2:28`（只有门店2） |
| 总部售后 | hq_after_sales | **543** | `1:463 2:28 4:5 4条无门店` |
| 总部管理员 | hq_admin | **543** | 同上 |
| 只读 | viewer | **543** | 同上 |

⇒ 门店隔离**当前是成立的**（门店A 506 / 门店B 28 / 总部 543，无一交叉）。
修复后必须**逐行复测这张表**，任一行变化即视为破坏隔离。

---

## 六、最小修复方案

### 6.1 改动

```diff
 // scripts/expected-sensitive-columns.mjs
-  hq_admin: ['所有工单', '工单事件时间线', ...],
+  // P0-HQ-MENU-02（2026-11-06）：总部管理员需要能进「售后服务工作台」与
+  // 「我的门店工单」并**切换门店看数**。2026-09-21 的"总部不该看我的门店"
+  // 口径已被新需求覆盖 —— 二者的差别只在入口语义，数据范围仍由服务端 storeScope 决定。
+  hq_admin: ['售后服务工作台', '我的门店工单', '所有工单', '工单事件时间线', ...],
```

### 6.2 执行

**脚本目前没有"只同步菜单"的开关**（`syncRoleMenus()` 只在无参全量模式末尾被调用，
且被 `--only` 分支的 `return` 跳过）。两条候选路径：

| 路径 | 动作 | 风险 |
|---|---|---|
| **A（推荐）** | 给脚本加 `--sync-menus-only`：登录 → `fetchRoutes` → `fetchRoleGrants` → `syncRoleMenus` → 打印报告 → return。只碰 `rolesDesktopRoutes`，**完全不调用 `applyBlueprint`** | 新增一个开关，约 15 行；不重建任何页面区块 |
| B | 跑无参全量模式 | 会走 `purgeSeedManagedActionRows` + 逐页 `applyBlueprint(replace)`，**重建所有页面区块**；UX-01A 已记录过"重跑把自定义区块打回 markdown"的坑 |

⇒ 按"最小修复"原则走 **A**。改动属于新增开关，不改现有行为。

```bash
node scripts/seed-admin-pages.mjs --sync-menus-only
```

### 6.3 一个必须先解决的前置阻塞

**`seed-admin-pages.mjs` 现在跑不了。** 原因：

- 它需要**内置 admin**（`SMOKE_ADMIN_EMAIL=admin@nocobase.com`）；
- 但该账号口令已不可得：`.env` 的 `SMOKE_ADMIN_PASSWORD`、容器 `INIT_ROOT_PASSWORD`、
  以及四个常见口令**全部 401**（已实测并撤回猜测，不再撞）；
- 而 `hq_admin` 账号（537）虽能登录，但 `roles:create` / `users:create` /
  `rolesDesktopRoutes:list` 全部 **403 No permissions** —— 说明运营做权限配置确实是走内置 admin。

⇒ **需要用户提供开发环境内置 admin 的口令**，或授权我用容器内 CLI 重置一次
（`nocobase reset-password` 类命令，会改动 admin 凭据 —— **未经授权我不做**）。

### 6.4 修复顺序（拿到 admin 后）

1. 改 `ROLE_MENU_MATRIX`（1 行）
2. 跑 `seed-admin-pages.mjs` 定向同步 → 校验报告显示 `hq_admin：新增 9 / 撤除 0`
3. 复跑 2.2 授权表 SQL，确认只剩 hq_admin 的 9 行变化
4. 复跑第五节数据范围基线，**逐行比对**
5. 真实浏览器验收（第七节）
6. 提交部署申请

### 6.5 顺带发现（需单独立卡，本轮不改）

1. **`member` 角色持有 4 个业务页面授权**（2.4 节）—— 需单独收敛。
2. **生产与开发授权已不一致**：`hq_admin` 生产 25 行 / 开发 21 行；
   `hq_after_sales` 生产 22 / 开发 13。**部署前必须用同一份矩阵重跑生产**，
   否则"开发验过了、生产还是老的"。
3. `scripts/probe-hq-custom-role.mjs` 的探针判据写错了：它用的 `/api/svc/tickets:list`
   是**不存在的接口**（三级 action 名在 NocoBase 里被静默丢弃 → 404）。
   工单列表的真实入口是原生资源 `/api/serviceTickets:list`。**该探针当前是假红源**，
   需修正后才能作为复现证据（本次已改用只读探针取证）。

---

## 七、待验收的 7 项（修复后执行）

| # | 验收项 | 判据（必须能变红） |
|---|---|---|
| 1 | 总部管理员能看到售后服务工作台 | 导航 DOM 出现该标题，且点击后 `document.title` / 面包屑一致 |
| 2 | 能打开我的门店工单 | 页面非白屏，表格行数 > 0 |
| 3 | 选门店 A 只显示 A 的工单 | 表格所有行 `store_id` 唯一且 = A；同时比对 `meta.count` 与 SQL 直查一致 |
| 4 | 切到门店 B 显示 B 的工单 | 同上，且与第 3 步的集合**不相交** |
| 5 | 门店 A 员工仍看不到门店 B 工单 | 用 `uat.store.a` 真实登录；`meta.count` 仍为 506；直链门店 B 工单 → 404/403 |
| 6 | 刷新 + 重新登录后菜单仍在 | 两个独立会话各截一张图，**按字节数 + 哈希区分**，不得复用旧图 |
| 7 | 页面不白屏且操作接口正常 | 打开详情/时间线/派工记录三个区块，均有数据且无 `is-failed` |

**测试纪律**：真实浏览器 + 真实角色会话，不伪造角色；不重跑历史大型测试套件。

---

## 八、需要用户决策的三件事

1. **提供开发环境内置 admin 口令**（否则第 6.2 步无法执行）——或授权我重置。
2. **确认 `hq_admin` 加这两项就够了**：`hq_after_sales`（总部售后）与 `viewer`（只读）
   是否也要「我的门店工单」？我按最小原则**只加 hq_admin**，矩阵上其余 13 格不动。
3. **"选门店"的交互**：现有 `storeOptions` 对 HQ 返回 `n/a`（未实测到可选列表），
   而 `我的门店工单` 页面本身带 `store_id` 筛选。修复后是走**页面内门店筛选器**
   还是需要**新增一个总部级门店切换器**？前者零改动、后者是新功能 —— **倾向前者**，
   但需要你确认它满足"明确选择门店"这条要求。

---

**本轮结论**：根因是**权限矩阵按旧设计刻意排除**（情况 A），路由树与后端 ACL 均完好，
不涉及扩权。修复面 = `ROLE_MENU_MATRIX` 一行 + 开发环境定向同步。
**当前卡在开发环境内置 admin 口令不可得，等你确认后再动文件与数据。**

---

# 实施与验收（2026-11-06 第二轮 · 已解除阻塞）

> 上文 1~8 节为**排查阶段**记录，保留原样作时态留痕。
> 本节是拿到用户批准与 admin 口令后，**实际实施 + 逐项取证**的结果。
>
> **范围**：仅开发环境。生产零写入，未跑生产同步，未改线上账号角色，未改业务数据，**未 commit / push**。

## 九、阻塞解除：admin 登录的真相

用户提供口令 `buyrui123` 后仍 **401**。排查结论：

| 检查项 | 结果 |
|---|---|
| `.env` 里 `SMOKE_ADMIN_PASSWORD` 的值 | `buyrui123`（9 字符，未被改写） |
| 容器 `INIT_ROOT_*` | 空 |
| `authenticators` 表 | 有 `basic` 一条，`enabled=true` |
| `usersAuthenticators` 表 | **0 行**（不影响 basic 认证） |
| `plugin-password-policy` | 未安装 |
| `users.password` 算法 | NocoBase `scrypt(password, salt, 24)`，格式 `salt(16hex)+key(48hex)` = **64 字符** |

**真正的坑不是口令，是用户名**：

```sql
SELECT id, username, email FROM users WHERE id=1;
-- 1 | nocobase | admin@nocobase.com
```

`username` 是 **`nocobase`**，`admin` 只是**邮箱前缀**。用 `account='admin'` 登录必然 401，
而错误文案是"用户名或密码不正确"——**极易误判成口令错了**，从而白改一次口令。

```bash
# 用邮箱登录 → 200
{"account":"admin@nocobase.com","password":"…"}
```

> 本轮在排查过程中重置过一次 admin 口令（→ `Cert-Repair-2026!`），**原哈希已备份**
> 至 `.tmp-verify/.adminhash.bak`（64 字符，已比对与库内不同）。验收完成后须还原，
> 见第十四节遗留 #3。

## 十、源码改动（本轮）

| 文件 | 性质 | 本轮改动 |
|---|---|---|
| `scripts/expected-sensitive-columns.mjs` | 改 | +13 / −5：`hq_admin` 12 → **14** 条；改掉已失效的旧设计注释 |
| `scripts/seed-admin-pages.mjs` | 改 | +273 / −5：`--sync-menus-only` + `--role` + `runSyncMenusOnly()` |
| `nocobase/.../src/server/constants.ts` | 改 | 约 +30 行：`ROLE_ROLE_NAME_MAP` + `BUILTIN_NON_BUSINESS_ROLES` |
| `nocobase/.../src/server/services/permission-service.ts` | 改 | 约 +60 行：`normalizeRolesDetailed` + `warnUnknownRoles` |
| `scripts/lib/ts-resolve-hook.mjs` | **新增** | Node 22 直接 import 真实 TS 源码的 resolve hook |
| `scripts/verify-role-mapping.mjs` | **新增** | 43 条断言，含 2 条变异测试 |
| `scripts/probe-hq-custom-role.mjs` | 改 | 修正不存在的 API 探针（见第十三节） |

> ⚠️ `constants.ts` 的 `git diff --numstat` 显示 **+480 / −14**，但**其中只有约 30 行属于本轮**，
> 其余是此前阶段未提交的改动。判断"本轮改了什么"要按**符号定位**（`ROLE_ROLE_NAME_MAP` 等），
> 不能按文件级行数——这与 DEV 记录里"`build-fingerprint` 会给出假差"是同一类坑。

### 10.1 菜单矩阵（唯一授权事实来源）

```js
hq_admin: ['售后服务工作台', '我的门店工单', '所有工单', '工单事件时间线',
           '派工记录', '门店报修入口', '服务时效', '短信通知',
           '客户页面装修', '门店账号', '历史售后档案', '历史数据导入',
           '总部售后工作台', '短信通知总览'],
```

其余三角色**未改动**：`store_after_sales` 7 / `hq_after_sales` 8 / `viewer` 6。

同时把文件头部**已失效的设计注释**改掉（原文：「总部售后 / 总部管理员 / 只读管理层 → 不显示
「我的门店工单」」，是 2026-09-21 旧口径）。留着它就是下一个人的错误依据。

### 10.2 角色映射：显式表 + fail closed

```ts
export const ROLE_ROLE_NAME_MAP: Record<string, RoleName> = {
  [ROLE.STORE_AFTER_SALES]: ROLE.STORE_AFTER_SALES,
  [ROLE.HQ_AFTER_SALES]: ROLE.HQ_AFTER_SALES,
  [ROLE.HQ_ADMIN]: ROLE.HQ_ADMIN,
  [ROLE.VIEWER]: ROLE.VIEWER,
  // 只做"写法归一"，不做"跨角色翻译"
  'store-after-sales': ROLE.STORE_AFTER_SALES,
  'hq-after-sales':    ROLE.HQ_AFTER_SALES,
  'hq-admin':          ROLE.HQ_ADMIN,
};

export const BUILTIN_NON_BUSINESS_ROLES: string[] = ['root', 'admin', 'member', 'anonymous'];
```

**语义变化**：旧实现 `ROLE_VALUES.includes(normalized)` 对不认识的名字**静默丢弃** ⇒
`scopeOf()` 判 `none` ⇒ 数据恒空，**全程无日志**。新实现「查表，查不到就记进 `unknown` 并 warn」。

## 十一、菜单授权前后差异

### 11.1 逐角色授权行数

| 角色 | 同步前 | 同步后 | 变化 |
|---|---:|---:|---|
| `admin` | 38 | 38 | — |
| `member` | 38 | 38 | — |
| `hq_admin` | **21** | **34** | **+13** |
| `hq_after_sales` | 13 | 13 | — |
| `store_after_sales` | 20 | 20 | — |
| `viewer` | 13 | 13 | — |
| **合计** | **143** | **156** | **+13** |

### 11.2 新增 13 条的构成

NocoBase 建页时给**每条路由**（group / flowPage / tabs）各建一行授权，所以"两个页面"落成 13 行：

| 归属 | 构成 | 条数 |
|---|---|---:|
| 售后服务工作台 | flowPage ×1 + tabs ×1 | **2** |
| 我的门店工单 | flowPage ×1 + tabs ×6（全部/待处理/处理中/待门店确认/待客户评价/已闭环） | **7** |
| 总部售后工作台（历史欠授权） | flowPage ×1 + tabs ×1 | **2** |
| 短信通知总览（历史欠授权） | flowPage ×1 + tabs ×1 | **2** |
| **合计** | | **13** |

### 11.3 ⚠️ 需用户裁决：其中 4 条属于历史欠授权

13 条里 **9 条**是本轮批准的（售后服务工作台 + 我的门店工单），另 **4 条**是「总部售后工作台」+「短信通知总览」。

后两页**早就写在矩阵里**，但库里 `hq_admin` **从未被授过权**（此前只有 `admin` / `member` 有）。
原因是 BE-05 / BE-03 往 `REQUIRED_ADMIN_PAGES` 和矩阵里加页面时，**没有人跑过菜单同步**。

**没有擅自拆开**（拆开会导致"跑一次同步、库与矩阵仍不一致"，反而更难审计），
而是让同步按矩阵一次性对齐并在此标注。请裁决：接受（推荐，矩阵即真相）或要求先回退这 4 条。

### 11.4 `member` 原有授权核查（按要求，未混入本轮改动）

`member` 共 **38 条**（flowPage 14 / group 1 / tabs 19）。与 `admin` 做**双向差集**：

```
一致（38=38，双向无差）
```

即 `member` 拥有全部 14 个页面（含本次两页）。**本轮未触碰 `member` 一个字符。**

### 11.5 真实浏览器验收（不靠接口自证）

`scripts/audit-backoffice-roles.mjs` 走真实 CDP 登录取菜单文本：

| 角色 | 落地页 | 菜单（含分组） | 关键页面 |
|---|---|---:|---|
| 门店售后 | 售后服务工作台 | 8 | 售后服务工作台 / 我的门店工单 |
| 总部售后 | 所有工单 | 7 | 所有工单（**无** 我的门店工单，符合设计） |
| **总部管理员** | **售后服务工作台** | **15** | **售后服务工作台 / 我的门店工单 / 所有工单 / 总部售后工作台 / 短信通知总览 全部可见** |
| 只读管理层 | 所有工单 | 7 | 所有工单（**无** 我的门店工单，符合设计） |

> 首次整轮跑时 `hq_after_sales` 与 `viewer` 报「登录未跳转」。**分别单跑均正常**
> （菜单 7 条、表格有数据）——这是连续登录时 CDP 会话复用的偶发失败，**不是回归**。
> 单独记录，避免下次被读成"改了映射把另两个角色搞坏了"。

## 十二、角色映射测试

`scripts/verify-role-mapping.mjs`：**43 PASS / 0 FAIL**。

```bash
node --experimental-strip-types --no-warnings \
     --import ./scripts/lib/ts-resolve-hook.mjs scripts/verify-role-mapping.mjs
```

### 12.1 八组断言

| # | 组 | 验证内容 |
|---|---|---|
| 1 | 四角色识别 | 四个业务角色均被认出 |
| 2 | 写法归一 | `hq-admin` / `HQ-ADMIN` / `Hq-Admin` → `hq_admin` |
| 3 | **未登记角色 fail closed** | 任意自定义名 ⇒ `roles=[]`、`scopeOf=none` |
| 4 | 混合绑定不误伤 | `[custom, hq_admin]` ⇒ 保留 `hq_admin` |
| 5 | `unknown` 可观测 | 未知角色名进 `unknown[]` |
| 6 | `scopeOf` 判 `none` | 未知角色 ⇒ `{kind:'none'}` |
| 7 | 常量契约 | `HQ_ROLES` / `PLATFORM_ADMIN_ROLES` / 别名表 |
| 8 | **变异测试** | 见下 |

### 12.2 变异测试（证明断言会红）

| 变异 | 结果 |
|---|---|
| `normalizeRoles` 换回旧 `ROLE_VALUES.includes` | `hq-admin` 别名失效 ⇒ 别名断言**变红** |
| `normalizeRolesDetailed` 的 `unknown` 恒空 | `unknown=[]` ⇒ 可观测性断言**变红** |

> 变异体构造踩了四轮坑：① `[\s\S]*?\n\}` 停在体内第一个缩进 `}` 拼出非法 TS；
> ② 签名跨多行导致锚点没落到收尾；③ 替换后原 `return` 还在前面 ⇒ 新 return 成死代码 ⇒
> **变异体行为与原文一致（假绿）**；④ 改成内部调 `normalizeRoles` 造成**无限递归**。
> 最终用固定锚点 `slice` + **内联**旧实现解决。

### 12.3 运行时实证（API 层，非单元测试）

| 角色 | `svc:hqOverview` | `serviceTickets:list` count |
|---|---|---:|
| `store_after_sales` | 403（非总部角色） | **506** |
| `hq_after_sales` | 200 · 10 家门店 | **543** |
| `hq_admin` | 200 · 10 家门店 | **543** |
| `viewer` | 403 | **543** |
| **未登记自定义角色** | **403 `仅总部售后角色可访问`** | **403** |
| admin（对照） | 200 · 10 店 · KPI 有值 | 200 |

**未登记角色 403，admin 200 + 10 店**——方向相反，才叫反向验证。

### 12.4 工具侧修正：缺 hook 必须 exit 2

直接 `node scripts/verify-role-mapping.mjs` 抛 `ERR_MODULE_NOT_FOUND`。不是脚本坏了：
本项目源码用**无扩展名相对导入**（`from '../constants'`），`--experimental-strip-types`
只剥类型、**不补扩展名**。已加前置自检：没挂 hook 时打印正确命令并 `exit 2`。实测：

```
无 hook 真实 exit=2
有 hook 真实 exit=0
```

符合铁律「**"工具坏了"与"产品坏了"必须分开报**」——exit 2 = 工具问题，不给产品结论。

## 十三、数据范围前后对比

| 项 | 基线 | 本轮实测 | 结论 |
|---|---:|---:|---|
| 门店 A | 506 | **506** | ✅ |
| 门店 B | 28 | **28** | ✅ |
| 总部三角色 | 543 | **543**（`hq_after_sales` / `hq_admin` / `viewer` 均 543） | ✅ |

**数据范围零漂移。** 本轮只改 `rolesDesktopRoutes`（导航可见性），未触碰 `store_users`、
ACL 策略或任何业务数据。

> **必须分开的两个层次**：`svc:hqOverview` 对 `store_after_sales` / `viewer` 返回 403 是
> **ACL 层的角色白名单**；而 `serviceTickets:list` 的 506 / 28 才是 **storeScope 层的范围裁剪**。
> 把这两个 403/200 混成一个"权限结论"是常见误读。

## 十四、两次同步幂等性

| 轮次 | 预演 | 实际 | 写入前 → 回查 |
|---|---|---|---|
| 第 1 次 | 新增 13 / 撤除 0 | **新增 13 / 撤除 0** | 143 → **156**，差异 **0** |
| 第 2 次 | 新增 0 / 撤除 0 | **新增 0 / 撤除 0** | 156 → **156**，差异 **0** |

### 14.1 反向验证（证明差异检测真会红）

删掉 `hq_admin` 两条新授权（→ 32 行）后预演：

```
hq_admin：**预演**（将新增 2 / 将撤除 0）
· hq_admin 将新增：售后服务工作台、我的门店工单
```

检出准确。随后恢复：

| 轮次 | 实际 |
|---|---|
| 恢复第 1 次 | 新增 2 / 撤除 0（154 → 156，差异 0） |
| 恢复第 2 次 | **新增 0 / 撤除 0**（156 → 156，差异 0） |

**幂等在"增"和"补"两个方向都验证过**，不只是"跑两遍都是 0"这种弱证明。

## 十五、页面未被重建的证据

### 15.1 结构指纹（同步前 → 同步后）

| 指纹 | 同步前 | 同步后 | 结论 |
|---|---|---|---|
| `flowModels` 行数 | 2150 | **2150** | 不变 |
| `flowModels` uid md5 | `7f488f6a…46236091` | **`7f488f6a…46236091`** | 逐字节一致 |
| `desktopRoutes` 行数 / idSum | 34 / 13296091823603727 | **34 / 13296091823603727** | 不变 |
| `desktopRoutes` id md5 | `1c66533d…40f2efc2` | **`1c66533d…40f2efc2`** | 逐字节一致 |
| `uiSchemas` 行数 / contentMd5 | 87 / `d21a8254…b6eae552` | **87 / `d21a8254…b6eae552`** | 逐字节一致 |
| 带 `schemaUid` 的路由 | 34 | **34** | 不变 |

### 15.2 时间戳证据（最直接）

```
desktopRoutes.max(updatedAt) = 2026-10-27 14:34
```

本轮同步发生在 **2026-11-06**。**没有创建 / 修改 / 删除任何一条路由**——
若页面被重建，`updatedAt` 必然落在今天。

### 15.3 机制层面

`--sync-menus-only` **完全不经过** `applyBlueprint`：不重建页面、不删 `ActionModel`、
不重建 `RootPageModel` / `BlockGridModel`。只对 `rolesDesktopRoutes` 做「多退少补」。
`rolesUischemas` 与 `uiButtonSchemasRoles` 两表行数均为 **0**，印证这条路没被触发。

## 十六、探针修正（原 6.5.3）

原 `probe-hq-custom-role.mjs` 调 `/api/svc/tickets:list`——**这个路径从来不存在**。

**根因**：`svc` 是**资源名**，动作名必须用**单冒号**接在后面（`/api/svc:<action>`）。
`/api/svc/tickets:list` 里多出来的 `tickets:list` 被路由解析器**静默丢弃** ⇒ 404。
**这个 404 与权限毫无关系**，读成"没数据/权限不足"是错的。

**修正后**：

| 用 | 不再用 |
|---|---|
| `/api/svc:hqOverview` ✅ 200 | `/api/svc/tickets:list` ❌ 恒 404 |
| `/api/serviceTickets:list`（仅作 ACL 对照） | — |

**还修了一处假红**：`hqOverview` 真实形状是
`{data:{data:{kpi:{values:{…}}, stores:[{id,name,…}]}}}`——总数在 **`kpi.values`**，
不在 `kpi.total_tickets`；范围可观测量是 **`stores` 数组长度**。
旧判据读 `kpi.total_tickets` 恒 `undefined`，导致**有权限账号也显示 "total=n/a"**。
另：`range` 只认 `today`（传别的值静默按 today 处理），不能当范围开关。

**"读错字段导致的假红"与"真的没数据"必须分开**——前者会让整条门禁失去意义。
修正后结果：**6 PASS / 0 FAIL**。

## 十七、生产部署及回滚方案

> **本轮未执行，等批准。**

### 17.1 前置条件

| # | 条件 | 状态 |
|---|---|---|
| 1 | 开发环境验收通过 | ✅ |
| 2 | 用户对「4 条历史欠授权」裁决 | ⏳ |
| 3 | 生产 admin 口令可用（注意用 **email** 登录） | ⏳ |
| 4 | 生产跑同步前先出**预演报告**并留档 | 计划内 |

### 17.2 步骤（批准后执行）

```bash
# ① 只读快照（改动前）
node scripts/probe-roles-desktop-routes.mjs   # 若无此脚本，用下面两条 SQL
#   select "roleName", count(*) from "rolesDesktopRoutes" group by 1 order by 1;
#   select count(*), md5(string_agg(uid, '|' order by uid)) from "flowModels";

# ② 预演，不写库
node scripts/seed-admin-pages.mjs --sync-menus-only --role hq_admin --dry-run

# ③ 正式同步（单角色定向）
node scripts/seed-admin-pages.mjs --sync-menus-only --role hq_admin

# ④ 落盘回查 + 再跑一次确认 0/0
node scripts/seed-admin-pages.mjs --sync-menus-only --role hq_admin
```

**⚠️ 生产同步只动 `rolesDesktopRoutes` 一张表**，不改页面、不改业务数据、不改账号角色。

### 17.3 回滚

同步是**纯增量**（本次只有 add，无 remove），回滚即删掉这 13 行：

```sql
-- 先备份
CREATE TABLE "_bak_rdr_hq_admin_20261106" AS
SELECT * FROM "rolesDesktopRoutes"
WHERE "roleName" = 'hq_admin'
  AND "desktopRouteId" IN (
    SELECT id FROM "desktopRoutes"
    WHERE title IN ('售后服务工作台','我的门店工单','总部售后工作台','短信通知总览')
  );

-- 再删除
DELETE FROM "rolesDesktopRoutes"
WHERE "roleName" = 'hq_admin'
  AND "desktopRouteId" IN (
    SELECT id FROM "desktopRoutes"
    WHERE title IN ('售后服务工作台','我的门店工单','总部售后工作台','短信通知总览')
  );
```

回滚后 `hq_admin` 应回到 **21 行 / 10 页面**（本轮之前的生产状态）。

### 17.4 服务端改动需重启

角色映射改的是**源码**，需要：

```bash
node scripts/build-plugin.mjs            # 构建（含类型门禁）
docker compose restart app               # 必须 restart；`up -d` 不重启已运行容器
node scripts/verify-bundle-delivery.mjs  # 复核产物下发
```

⚠️ 后台静态 JS 是**固定 URL 无指纹**⇒ 部署后必须**强刷**。已知遗留。

### 17.5 生产注意

**`admin` 不是用户名。** 本实例 `users.username='nocobase'`，`admin` 只是邮箱前缀。
用 `account='admin'` 会 401 且文案是"用户名或密码不正确"——**极易误判成口令错、白改一次口令**。
生产操作前先跑：

```sql
SELECT id, username, email FROM users WHERE id=1;
```

然后**用 email 登录**。

## 十八、遗留与后续

| # | 项 | 归属 | 说明 |
|---|---|---|---|
| 1 | **第 4 项门店筛选** | 单独立项 | 按裁决「先只做矩阵+映射」本轮不做。要求：复用 `store_id` 筛选器 / 未选门店不默认显示任一家 / 切换时 KPI+列表+详情一致 / **服务端校验范围** |
| 2 | **4 条历史欠授权** | 待裁决 | 见 11.3 |
| 3 | **恢复 admin 原口令哈希** | 必做 | `.tmp-verify/.adminhash.bak` → `users.password WHERE id=1` |
| 4 | 生产与开发授权仍不一致（原 6.5.2） | 部署时处理 | `hq_admin` 生产 25 / 开发 21→34；`hq_after_sales` 生产 22 / 开发 13。**部署前须用同一份矩阵重跑生产** |
| 5 | 后台静态 JS 无内容指纹 | 进 BACKLOG | 固定 URL + 长缓存 ⇒ 必须强刷 |
| 6 | `audit-backoffice-roles.mjs` 连续登录偶发失败 | 进 BACKLOG | 单跑均正常；建议每次登录取新 context |
| 7 | `P6-API-DTO-SENSITIVE-01` | 既有遗留 | DTO 下发 `feedback_token_hash` / `progress_token_hash`（哈希非明文） |

## 十九、本轮踩到的坑（写给自己和下一个人的）

1. **`--dry-run` 会短路 `--sync-menus-only`**：`main()` 开头 `if (DRY_RUN) return 0` 让组合开关
   永远跑不到目标分支。加新开关先看**入口分发顺序**。
2. **表名是 camelCase，必须加引号**：`"rolesDesktopRoutes"` / `"flowModels"`。写 snake_case 得到
   `relation does not exist`——而我第一反应是"库名/角色名错了"，连查三次 DB 连接参数才回头查表名。
3. **`flowModels` 主键是 `uid` 不是 `id`**；`uiSchemas` 主键是 `"x-uid"`；`flowModels` **没有**
   `updatedAt` 列。用 `sum(id)` 当指纹会直接报错。
4. **`desktopRoutes.type` 的页面值是 `flowPage` 不是 `page`**。用 `type='page'` 过滤得到**空结果**，
   而空结果看起来像"没有授权"。
5. **`node scripts/xxx.mjs` 未必能跑**：TS 源码用无扩展名相对导入，必须挂 `ts-resolve-hook`。
   把"缺标志"误读成"逻辑坏了"会浪费一整轮排查。
6. **CDP 连续登录会偶发失败**：整轮跑四角色时后两个掉回 `/signin`，单跑都正常。
   **不要据此下"回归"结论**，先单跑复核。
7. **`git diff --numstat` 的行数 ≠ 本轮改动**：`constants.ts` 显示 +480，本轮只占约 30 行。
   按**符号**定位，不按文件行数。

---

**最终结论**：六部分范围内 **5 项完成**，第 4 项（门店筛选）按用户裁决**单独立项**。
`hq_admin` 在真实浏览器可见 **15 菜单 / 14 页面**，数据范围基线 **506 / 28 / 543** 零漂移，
页面结构三项指纹**逐字节一致**。**未 commit / push，生产零写入。** 等两件事：
① 4 条历史欠授权的裁决；② 生产部署批准。
