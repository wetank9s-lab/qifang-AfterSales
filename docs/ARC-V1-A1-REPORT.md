# ARC-V1 · A1 阶段报告（第一批）

> 日期：2026-11-09　环境：**仅本地开发环境**（`svc-app` / `svc-postgres` / `svc-nginx`）
> 生产零写入：未改生产数据、账号、ACL、菜单、Nginx、短信配置；未部署；未 commit / push。
> 本批交付：环境恢复 + 四集合 + 两角色 + 权限矩阵实证。**页面与移动端真机验证待 admin 凭据**（见 §8）。

---

## 1. 本地开发环境恢复情况

| 项 | 结果 |
|---|---|
| Docker 栈 | 已启动，`svc-app` / `svc-nginx` / `svc-postgres` 均 `healthy` |
| 库指向 | **`service_ticket`**（本地库），非生产 |
| 数据量对照 | 本地 `service_tickets = 543`；生产 = 525 ⇒ 确认不是同一个库 |
| 门店数 | 本地 10 家 |
| 端点 | `127.0.0.1:13000/api/app:getInfo` → 200；`https://127.0.0.1/` → 200 |
| 局域网（供真机） | `https://192.168.0.167/` → 200（自签证书，手机需点"继续"） |
| 账号口令 | **未重置任何账号**（含 admin）。生产 `store_users` 悬空绑定未触碰 |

---

## 2. 原生移动端六步真机验证

**状态：未执行（阻塞于 admin 凭据，非产品不可用）**

原因：移动端页面必须由具备 `flowSurfaces` / `mobileRoutes` 写权限的账号创建，
而 `hq_admin` 对这两个接口均为 **403 `FLOW_SURFACE_FORBIDDEN`**：

```
GET  /api/flowSurfaces:list            → 403 No permissions
GET  /api/mobileRoutes:list            → 403 No permissions
POST /api/flowSurfaces:applyBlueprint  → 403 FLOW_SURFACE_FORBIDDEN
```

唯一平台管理员是 `admin@nocobase.com`（同时持 `admin` + `root`），口令未知；
用户此前提供的 `buyrui123` 实测 **401**（该口令在 2026-11-06 就未通过，当时据此重置过一次，
随后已按要求还原原哈希 ⇒ 恢复后仍不是这个口令）。

**没有**用"重置管理员密码"绕过——执行令明确禁止。

> 需要你二选一：**① 提供 admin 真实口令**；② 授权我重置为临时口令（用完立即还原原哈希，
> 备份已在本机）。

---

## 3. 新角色的真实权限矩阵（已实测）

### 3.1 角色落库

| 角色 | title | 进入方式 |
|---|---|---|
| `store_sales` | 门店销售 | migration `202611091-arc-v1-roles` 补种 |
| `store_manager` | 门店负责人 | 同上 |

> ⚠️ 必须走 migration：NocoBase 对**已安装**插件不再调 `install()`，
> 只改常量 + 重启是**不会**建角色的（而且失败是静默的）。

### 3.2 资源级授权边界（关键安全点）

```
store_sales    -> serviceArchives, serviceArchiveStages, serviceArchiveEvents
store_manager  -> serviceArchives, serviceArchiveStages, serviceArchiveEvents
工单四表(serviceTickets/serviceVisits/ticketEvents/smsLogs) 命中数 = 0
```

**新角色拿不到任何工单权限。** 实现上刻意不用 `resourceSeedsOf()`——那个函数会默认塞入
工单四表；改用只含档案资源的 `archiveResourceSeeds()`。

`serviceArchivePhotos` **不进**原生只读白名单（含 `storage_key`），照片只走受控端点。

### 3.3 数据范围实证（真实登录 + 真实接口）

测试数据：A 店(1) 一条、B 店(4) 一条。

| 账号 | 角色 | 绑定门店 | `serviceArchives:list` | 判定 |
|---|---|---|---:|---|
| `arc1.sales.a` | store_sales | [1] | 200 · **1 行 store=[1]** | ✅ |
| `arc1.sales.b` | store_sales | [4] | 200 · **1 行 store=[4]** | ✅ |
| `arc1.mgr.a` | store_manager | [1] | 200 · **1 行 store=[1]** | ✅ |
| `arc1.sales.multi` | store_sales | [1,4] | 200 · **0 行** | ✅ **fail closed** |
| `uat.hqadmin` | hq_admin | — | 200 · 2 行 store=[1,4] | ✅ 跨店只读 |
| `uat.viewer` | viewer | — | **403** | ✅ 不自动获得档案权限 |

### 3.4 本轮修掉的两个真实缺陷（都是"看起来能用"型）

1. **`loadStoreIds` 里还有一份硬编码 `ROLE.STORE_AFTER_SALES`**。
   改完 `scopeOf` 后，`store_sales` 的角色认对了、但 `storeIds` 恒为空 ⇒ 落到
   `isStoreScoped && storeIds.length > 0` 的 false 分支 ⇒ `none`。
   现象是"登录正常、菜单正常、列表 0 行"，日志只说"数据范围 none"。
   ⇒ 同一判断出现两次 = 同一个坑有两条腿，两处必须一起改。

2. **多店绑定未 fail closed**。首次实测 `arc1.sales.multi`（绑 1+4）拿到了 **2 行**，
   而执行令要求多店绑定必须 fail closed。已加规则：档案门店角色必须**恰好 1 个有效门店**，
   否则判 `none`。该规则**只作用于档案角色**，不影响 `store_after_sales`
   （生产 904 号绑 10 店是合法配置）。

3. 顺带补上"**有效**门店"过滤：`store_users` 里存在悬空绑定（生产 `user 194 → store 2`，
   而 stores 无 id=2）。不过滤的后果是——绑了假 id 的销售会被"唯一门店"判定误伤成多店，
   而只绑假 id 的销售会拿到一个永远查不到数据的范围。现在不存在的门店一律忽略并告警。

---

## 4. 四个集合与迁移实现情况

### 4.1 建表结果（NocoBase 启动自动 sync）

| 表 | 行数 | 关键结构核对 |
|---|---:|---|
| `service_archives` | 2（测试数据） | `status` / `visibility` **两列分开**；`notes` / `public_note` **两列分开**；`version` int |
| `service_archive_stages` | 0 | `stage_code` + `stage_order`，`unique(archive_id, stage_code)` |
| `service_archive_photos` | 0 | `storage_key` 私有列；`published` 独立布尔 |
| `service_archive_events` | 0 | `actor_role` 存快照；`payload_json` |

### 4.2 索引核对（`service_archives`）

```
service_archives_store_id_customer_mobile          ← 执行令点名要求
service_archives_store_id_visibility_status
service_archives_customer_mobile
service_archives_archive_no (unique)
service_archives_updated_at
```

### 4.3 枚举单一事实来源

`ARCHIVE_TYPE` / `ARCHIVE_VISIBILITY` / `ARCHIVE_STATUS` / `ARCHIVE_SERVICE_TYPE` /
`ARCHIVE_STAGE_CODE`（+ `ARCHIVE_STAGE_ORDER` / `ARCHIVE_STAGE_PHOTO_REQUIRED` /
`ARCHIVE_STAGE_PHOTO_MAX`）/ `ARCHIVE_PHOTO_TYPE` / `ARCHIVE_EVENT_TYPE`
全部定义在 `constants.ts`，`_options.ts` 只做派生 ⇒ 下拉、校验、状态机共用一份。

### 4.4 门店隔离接入

`precedence/store-scope.ts` 的 `SCOPED_RESOURCES` 增加 `serviceArchives: { via: 'self' }`。
阶段/照片/事件三表**故意不加**——它们没有 `store_id`，硬套会去查不存在的 `ticket_id` 列；
它们的归属校验放在业务层（`archive_id → archive.store_id` 两跳），A2 实现。

---

## 5. NocoBase 档案页面实际效果

**未执行**（与 §2 同一阻塞）。

设计已定，待 admin 凭据后按此落地：

| 页面 | 数据源 | 可见角色 |
|---|---|---|
| 我的服务档案 | serviceArchives（本店） | store_sales / store_manager |
| 新上门服务信息卡 | serviceArchives 表单 | store_sales |
| 暖通六阶段记录 | serviceArchiveStages | store_sales |
| 本店只读档案 | serviceArchives（本店只读） | store_manager |
| 总部跨店档案 | serviceArchives（全量只读） | hq_admin / hq_after_sales |

配置方式沿用现有 `--sync-menus-only` 纪律：**不跑全量 seed、不覆盖旧页面树**。

---

## 6. 两店角色隔离结果

见 §3.3。A 店销售只看到 A 店、B 店销售只看到 B 店、**互相不可见**；
跨店绑定 fail closed；总部可跨店但只读（写接口尚未实现，A2 落地后再验）。

---

## 7. 最小修改文件清单

### 新增

| 路径 | 作用 |
|---|---|
| `src/server/collections/serviceArchives.ts` | 主表 |
| `src/server/collections/serviceArchiveStages.ts` | 六阶段 |
| `src/server/collections/serviceArchivePhotos.ts` | 私有照片 |
| `src/server/collections/serviceArchiveEvents.ts` | 审计事件 |
| `src/server/migrations/202611091-arc-v1-roles.ts` | 补种两角色（含回读自证） |
| `scripts/arc-a1-accounts-db.mjs` | 开发环境最小测试账号 |

### 修改

| 路径 | 改什么 |
|---|---|
| `src/server/constants.ts` | `ROLE` +2；`ROLE_ROLE_NAME_MAP` +2（含别名）；`ROLE_TITLE` / `ROLE_ACL_ACTIONS` 补两角色；`ARCHIVE_*` 枚举与规则常量；`ARCHIVE_READ/WRITE/HQ_READ/STORE_ROLES`；`ARCHIVE_NATIVE_READ_RESOURCES`；`extraReadResourcesOf` 给总部角色追加档案只读 |
| `src/server/services/permission-service.ts` | `scopeOf` 用常量 + 唯一门店约束；`loadStoreIds` 用常量 + 只保留有效门店 |
| `src/server/seeds/roles.ts` | 新增 `archiveResourceSeeds()`（不含工单表）；`ROLE_SEEDS` +2 |
| `src/server/middleware/store-scope.ts` | `SCOPED_RESOURCES` + `serviceArchives` |
| `src/server/collections/index.ts` | 注册四集合 + `EXPECTED_TABLE_NAMES` |

> 未改：`serviceTickets` / `serviceVisits` / `serviceVisitPhotos` / `store_users` /
> `historical*` 任何表结构与数据。

---

## 8. 是否存在真实阻断

| # | 项 | 性质 | 需要你做什么 |
|---|---|---|---|
| B1 | **页面/移动端配置缺 admin 凭据** | **硬阻塞**（仅阻塞页面与真机验证，不阻塞已完成部分） | 提供 admin 口令，或授权临时重置 |
| B2 | 移动端 6 步未验证 | 未执行（依赖 B1） | — |
| B3 | 档案写入 Action 未实现 | 计划内（A2/A3） | — |
| B4 | 验证码/会话两表 | 按你的裁决推迟到 A4 | — |

**没有发现**"手机端不可用 / 需改登录架构 / 会扩大权限 / 破坏旧售后功能"这类问题。

---

## 9. 下一步（拿到 admin 凭据后立即执行）

1. 用 blueprint 建 5 个档案页面（桌面）+ 1 个最小移动页面；
2. **真机 6 步验证**（登录→新建→调相机→上传→预览→保存→重开续编，含上传失败保留）；
3. 通过后进 A2：普通上门服务的写入 action + 完工校验（前后照片）；
4. A3：暖通六阶段事务校验 + 并发控制。

---

# 第二批（2026-11-09 下午）：A2 服务端完成

## 10. admin 凭据核对结论

用户提供 `admin` + 指定口令。**核对结果：不匹配。**

| 核对项 | 结果 |
|---|---|
| 库内 `users.password`（id=1） | 64 字符 scrypt 哈希 |
| 用该口令做 scrypt 比对 | **不匹配** |
| `account='admin'` 登录 | 401 |
| `account='admin@nocobase.com'` 登录 | 401 |
| `account='nocobase'`（真实 username）登录 | 401 |

**未修改任何密码或哈希**（按指令）。因此页面配置与真机验证仍无法执行。
需要你确认：该口令是否属于**另一个环境**（例如生产 `scqf-as-app`），或改用可在本地开发环境登录的凭据。

## 11. A2 服务端已完成（不等凭据的部分）

新增 `ArchiveService`（唯一写入口）+ 三个业务 action：

| action | 作用 |
|---|---|
| `svc:archiveCreate` | 建档案；按业务契约校验必填（不因列为 NULL 就跳过）；暖通自动写六行阶段 |
| `svc:archiveUpdate` | 白名单字段更新；**强制 `expected_version`** |
| `svc:archiveComplete` | 完工闸：完成日期必填 + 查表校验前后照片各 ≥1 |

### 11.1 验收结果：19 PASS / 0 FAIL

| # | 断言 | 结果 |
|---|---|---|
| 1 | A 店销售可建本店档案，`store_id` 不被请求体篡改 | ✅ |
| 2 | A 店销售不能建 B 店档案 | ✅ 404 |
| 3 | `store_manager` 写入 → 403 | ✅ |
| 4 | `hq_admin` 写入 → 403 | ✅ |
| 5 | A 店销售不能改 B 店档案 | ✅ 404 |
| 6 | 缺前后照片 → 409 | ✅ |
| 7 | 只有「服务前」一张 → 仍 409（逐类型判，不是"有照片就行"） | ✅ |
| 8 | 补全后可完成，`status=completed` | ✅ |
| 9 | 完成日期落库且本地时区仍是所填日期 | ✅ |
| 10 | 用当前版本更新 → 成功（证明通路可用） | ✅ |
| 11 | 用旧版本更新 → 409 | ✅ |
| 12 | 被拒那次确实没写库 | ✅ |
| 13 | 原生 `serviceArchives:update` 对业务角色 403（不能绕过） | ✅ |
| 14 | 创建与完工都写审计事件 | ✅ 3 条 |
| 15 | 审计 payload 不含手机号明文 | ✅ 0 命中 |
| 16 | **绑 [1,2]（2 不存在）→ 档案访问仍拒绝** | ✅ 0 行 |
| 17 | **绑 [1,2] → 也不能写 1 号店** | ✅ 404 |

### 11.2 本轮修掉的两个"假绿"

1. **`sequelize.query(UPDATE …)` 的返回值不是行数**。
   我原来写 `const [affected] = await sequelize.query(...)`，拿到的是**空结果集**，
   `Number([]) === 0` 恒成立 ⇒ **所有更新都报 409 STALE**。
   更糟的是"并发不得静默覆盖"这条断言因此**假绿**：它看到的 409 来自"永远失败"，
   而不是"真的检测到冲突"。改用 `RETURNING id` + 判返回行数，并给并发断言补了
   **正向对照**（先用当前版本更新成功，再用旧版本被拒）——只测反向的并发断言是不可信的。

2. **时区把日期断言写假了**。`2026-11-09`（Asia/Shanghai）落库是
   `2026-11-08T16:00:00.000Z`，用 `startsWith('2026-11-09')` 判会红。
   改成按本地时区还原日期再比。

### 11.3 按你的口径改严的一处

原先"过滤掉不存在的门店、按剩余门店放行"（绑 [1,2] ⇒ 当成 1 号店）。
你明确要求「绑 [1,2] 且门店 2 不存在时，档案访问仍拒绝」⇒ 已改为
**档案角色只要存在无效绑定就判无授权**（fail closed），不做"替用户猜"。

## 12. 五个档案页面

**未建立**（依赖 admin 凭据）。设计已冻结，拿到凭据后按 `--sync-menus-only` 纪律落地，
不跑全量 seed、不覆盖旧页面树。

## 13. 当前阻塞

| # | 阻塞 | 影响 |
|---|---|---|
| B1 | **admin 凭据与本地库不匹配** | 页面配置、移动端真机六步、A2 界面验收全部无法进行 |

A2/A3 的**服务端**不受影响，可继续推进。

