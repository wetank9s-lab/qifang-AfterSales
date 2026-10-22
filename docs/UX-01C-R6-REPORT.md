# UX-01C 第六轮：B-18 门店报修入口修复 + 门店管理进度

> 日期：2026-10-17 · 状态：P11-5 PASS/FROZEN · UX-MEDIA-01 PASS/FROZEN · UX-01C 服务时效 PASS/FROZEN · **UX-01C 整体 IN PROGRESS** · P11-4 IN PROGRESS（暂停）· UX-01B IN PROGRESS · Phase 11 IN PROGRESS · Release HOLD
> **未 commit / 未 push。**

---

## 一、结论

| 项 | 结果 |
|---|---|
| **B-18「门店报修入口」** | ✅ **PASS**（按本轮授权：完成验收即允许标记 PASS。页面真实渲染；行级权限、字段白名单、二维码链路全部实测） |
| **门店资料编辑** | ⏸ **PENDING**（按本轮授权条款："预算不足允许只完成 B-18 完整闭环，不得以只读页面冒充整体完成"） |

B-18 不是"少给了一个权限"，而是**三层同时缺失**：资源授权、行级范围、以及一个从未被验证过的页面。
本轮用"按角色授权 + 行级收窄 + 服务端字段白名单"补齐，**没有**把 `stores` 加进全局 `NATIVE_READ_ALLOWLIST`。

---

## 二、真实根因（按代码与真实浏览器证据）

| 层 | 事实 |
|---|---|
| 页面 | 「门店报修入口」是一张 `stores` 原生表格（列：`code/name/active`），行内挂 `StoreEntryActionModel` |
| 元数据 | `collections:listMeta` **已包含** `stores`（所以区块能渲染、只是数据读不到） |
| 数据 | 四个业务角色都没有 `stores` 的资源级授权 ⇒ `GET /api/stores:list` **403** |
| 表现 | 区块报 `ResponseError: No permissions` → 页面「渲染失败」 |
| 旧门禁 | 曾以 `knownIssue` 编码"预期 403"，把失败写成了"通过" —— 本轮已删除 |

> 修复前 CDP 证据（第五轮记录）：`403 stores:list` + 页面「门店报修入口 渲染失败」。
> 修复后同一页面：`200` + **15 行**（见 §四）。

---

## 三、角色、字段与权限口径（先确认再实施）

### 3.1 哪些角色应当使用本页
直接取 `ROLE_MENU_MATRIX`（菜单可见性）+ `rolesDesktopRoutes`（真实授权）：

| 角色 | 菜单 | 读取范围 |
|---|---|---|
| `store_after_sales` | 有 | **仅授权门店**（S01 账号 → 1 行） |
| `hq_after_sales` | 有 | 全量（15） |
| `hq_admin` | 有 | 全量（15） |
| `viewer` | 有 | 全量（15，只读；本页只有 code/name/active 三列） |

`STORES_READ_ROLES` 与这份矩阵**同源**：菜单隐藏不会给 API 权限；不在清单里的角色直接 403。

### 3.2 页面需要哪些字段
页面只声明 `code / name / active` 三列。链接与二维码**不走列**，由 `svc:storeEntryLinks`
在弹窗里返回（`item.url` / `qr_svg` / `qr_filename`）。

### 3.3 `contact_phone` 的定性（有代码依据）
| 证据 | 结论 |
|---|---|
| 列注释：「门店对外售后电话，展示在 H5 与短信签名位」 | **对外** |
| `publicStore:list` 返回 `phone` | 匿名客户可见 |
| `publicStore:entry` 投影逐列包含 `contact_phone` | 匿名客户可见 |

⇒ 它**不是**内部联络资料，而是对外服务电话。因此字段白名单里**不需要**为它做特殊隐藏；
但本页也不展示它（页面只声明三列；弹窗只用名称/编码/链接/二维码）。
本轮据此在 `NATIVE_READ_FIELD_DENY.stores` **显式登记为空**，把"不排除任何列"这句判断留痕。

### 3.4 签名二维码 / 旧码依赖哪些字段
| 能力 | 依赖 | 说明 |
|---|---|---|
| 签名入口 `entry` | `stores.code` + `SIGN_SECRET`（HMAC） | 与名称/电话/地址**无关** ⇒ 改名不会让已发二维码失效 |
| 二维码 `qr_svg` | `entry` + 对外基址 | 服务端生成；页面只渲染 |
| 旧码兼容 | 裸 `code` | `resolveStoreEntry()` 继续接受（legacy provenance），**UI 不再展示** |

---

## 四、最小修复（不新增数据、不改上传/存储）

1. **按角色资源授权**（不进全局白名单）
   - `constants.ts`：`STORES_READ_RESOURCE='stores'`、`STORES_READ_ROLES`、`extraReadResourcesOf(role)`；
   - `seeds/roles.ts`：四个角色各自 `resourceSeedsOf(extras)`；重启后自愈补建 **4 条**资源授权行；
   - `native-metadata-guard`：`roleScopedResources` 改为**从 `ROLE_SEEDS` 派生**（避免第二份清单）。
2. **行级收窄**（新中间件 `stores-read-scope.ts`）
   - `list`：门店角色注入 `id IN (storeIds)`（`$and` 叠加，filter 挤不掉）；无授权门店 ⇒ `id=-1`；
   - `get`/`view`（带主键）：不在授权范围内 ⇒ **404 同形**；`view` 无主键视为 ACL 探针放行；
   - 写动作一律 403；平台 root/admin 不经过本层。
3. **字段白名单**：仍由 ACL `fields` 负责（`NATIVE_READ_FIELD_DENY.stores` 显式登记）。
4. 页面与动作**未改**：仍是原生表格 + `StoreEntryActionModel`（链接/二维码仍由服务端生成）。

---

## 五、验收（修复后，真实证据）

### 5.1 接口矩阵（`stores`）
| 主体 | `list` | 结果 |
|---|---|---|
| `hq_admin` | 200 | **15** 行（S01…S15） |
| `hq_after_sales` | 200 | **15** 行 |
| `store_A` | 200 | **1** 行（S01） |
| `store_B` | 200 | **1** 行（S02） |
| `viewer` | 200 | **15** 行（只读策略不变） |
| 匿名 | 401 | — |

- 字段集合实测：`active,address,code,contact_phone,createdAt,id,name,sort_order,updatedAt`（= 服务端白名单）。
- `store_A` get 本店 200 / **跨店 404**；用 `filter={code:S02}` 也拿不到（0 行）；原生 `update` **403**。

### 5.2 真实浏览器（CDP）
| 场景 | 证据 |
|---|---|
| hq_admin 打开 | 表格 **15 行**，无「渲染失败 / No permissions」 |
| store_A 打开 | 表格 **1 行**，只看到 S01、看不到 S02 |
| viewer 打开 | 表格 **15 行**，无错误 |
| S01 报修入口弹窗 | 名称/编码正确；`url = http://localhost:8080/h5/report?k=S01.<sig>`；二维码 SVG 已渲染 |
| 复制 | **真实鼠标事件**触发；剪贴板内容 = 链接（或"已复制"提示） |
| 下载 | 产生真实文件 `S01-report-qr.svg`，内容以 `<svg` 开头 |
| 旧入口 | 弹窗中**不再出现**"旧入口/旧链接"字样（正式链接标签「已签名，防篡改」保留） |

> 复制验证的教训：`element.click()` 是脚本合成事件，**不构成用户激活**，剪贴板必然被拒。
> 第一版据此误报"复制不可用"；改用 `Input.dispatchMouseEvent` 的真实点击后通过。
> 这与"判据自己会错"同型 —— 报的是驱动方式，不是产品。

### 5.3 签名 / 旧码 / 篡改 / 停用
- 签名入口匿名可打开（200，code=S01）；
- **篡改末位签名 → 404**（与不存在同形）；
- **旧码（裸 `S01`）仍 200**（服务端兼容保持，UI 不展示）；
- 停用门店：当前库内**没有停用门店** ⇒ 不做破坏性启停测试（按纪律）；
  停用拒绝规则本身未改（`publicStore:entry` 与建单路径都按 `active=false` 拒绝）。

---

## 六、门禁

| 门禁 | 结果 | 说明 |
|---|---|---|
| `verify-ux-01c-store-entry.mjs`（新增） | **36 / 0** | API 矩阵 + 三角色浏览器 + 二维码复制/下载/签名/旧码 |
| `verify-ux-01c-pages.mjs` | **22 / 0** | **B-18 的 `knownIssue` 已删，改为正向断言** |
| `verify-plugin-load.mjs` | **82 / 0** | 中间件分组补 `stores-read-scope`；授权行数由种子派生 |
| `probe-native-read-deps.mjs --assert` | **19 / 0** | 平台元数据仍全拒（门店主数据授权不影响 B-8） |
| `verify-ux-01c-settings-auth.mjs` | **29 / 0** | 服务时效未回归 |
| `verify-store-ui-primary-action.mjs` | **65 / 0** | 门店工单主链路未回归 |
| `verify-ux-01a-final.mjs` | **15 / 0** | 抽屉/备注/工作台未回归 |

**变异测试**：把行级收窄短路（`return next()`）后，B-18 门禁 **29 / 6**（当时共 35 项）：
`store_A` 读到 S01…S15、跨店 get 200、filter 绕过成功 —— 证明这条断言真的在观测行级边界。
还原后 **36 / 0**。

---

## 七、门店资料编辑为什么本轮 PENDING

按本轮授权："预算不足允许只完成 B-18 完整闭环，门店资料编辑继续 PENDING，
不得以只读页面修好冒充门店管理整体完成。" 本轮选择**如实停在这里**，原因：

1. B-18 已经引入一个新的权限层（资源授权 + 行级收窄 + 角色清单），它本身需要完整回归；
2. 门店资料编辑需要**新的写入面**（新审计表 + 两个受控 action + 客户端编辑动作 + 种子），
   且 `active` 启停的验收必须用**隔离门店夹具**（不能对真实门店做破坏性测试）——
   这是一整套工作，半做会留下"能改但不审计 / 有审计但不校验"的半成品；
3. 用户明确禁止把"只读页面修好"当成门店管理完成。

**下一轮的确定方案**（已想清楚，不含未定项）：
- 新审计表 `storeProfileAudits`（store_id / code / field / old / new / operator / scene / request_id）；
- `svc:listStoreProfiles`（hq_admin，白名单字段）+ `svc:updateStoreProfile`
  （hq_admin + 字段白名单 + 校验 + `expected_value` 并发 + 同事务审计 + 恢复即再审计）；
- 客户端：`stores` 表行内新增「门店资料」动作（仅 hq_admin 可见），复用 `ConfigEditActionModel` 的弹窗形态；
- 验收：隔离门店夹具（`T9x`，SQL 建、按 ID 精确清理）上验证 name/phone/address/active；
  停用后 `publicStore:entry` 与新报修必须 404；启用恢复后入口恢复；
  另加"改名不影响已发签名二维码"（entry 只依赖 code）与"停用不影响历史工单归属"。

---

## 八、Git 与密钥

- **未 commit / 未 push**，暂存区为空。
- 本轮增量：
  - 新增 `src/server/middleware/stores-read-scope.ts`、`scripts/verify-ux-01c-store-entry.mjs`；
  - 修改 `constants.ts`（STORES_READ_* / extraReadResourcesOf / deny 登记）、`seeds/roles.ts`、
    `plugin.ts`（守卫按种子派生 + 挂载行级中间件）、
    `scripts/verify-ux-01c-pages.mjs`（knownIssue → 正向）、`scripts/verify-plugin-load.mjs`（中间件分组）、
    `docs/API.md`、`docs/SECURITY.md`。
- `git diff --check`：**无空白错误**。
- 密钥审计：本轮未新增任何口令/密钥/Token 字面量；未写入真实客户资料；
  `.tmp-verify` 证据目录仍被忽略。
- 夹具残留：`UIPA% / UX01A% / UX-MEDIA% / 合成测试%` = **0 张**。

---

## 九、冻结与后续

- **冻结不变**：UX-01C 服务时效、UX-MEDIA-01、客户/师傅 H5 媒体能力；
- B-17（`environmentVariables:list` 403 瞬时提示）继续独立登记，**不**通过放开环境变量权限解决；
- 「短信通知」、旧短信描述迁移、UX-01D 页面装修：继续后续任务；
- 状态：**B-18 PASS**；UX-01C 整体仍 IN PROGRESS（门店资料编辑 PENDING）。B-18 是否随「服务时效」一并冻结，待你确认。
