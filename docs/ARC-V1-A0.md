# ARC-V1 · A0 环境与兼容性核查报告

> 核查日期：2026-11-09　环境：**生产库只读**（`SELECT` / `pg_catalog`）+ 本地源码
> 未做任何写入：未改数据、未跑 seed、未改 ACL、未部署、未 commit / push。
> 本报告只回答执行令要求的 8 个问题，不展开设计。

---

## 一、生产 NocoBase 版本与原生手机页面可用性

| 项 | 实测值 |
|---|---|
| NocoBase | **2.2.15**（`/api/app:getInfo` 直读） |
| 数据库 | PostgreSQL（`dialect: postgres`） |
| `mobile` 插件 | **已启用**（2.2.15） |
| `mobileRoutes` 表 | 存在，**0 行** |
| `rolesMobileRoutes` 表 | 存在，**0 行** |
| `file-manager` 插件 | 已启用（2.2.15） |
| `verification` 插件 | 已启用（2.2.15） |
| `plugin-auth-sms` 包 | **存在于镜像，但未启用** |
| 已启用插件总数 | 80 个（含 `service-ticket` 1.0.0） |

**结论**：原生移动端**能力具备但完全未配置**——表和插件都在，没有任何移动端路由/菜单。原生手机页面**未被任何真实业务使用过**，属"可用性未证明"，不是"已知不可用"。

---

## 二、10 家真实门店（生产现网）

| # | store_id | 编码 | 名称 | 启用 | 联系电话 | 地址 |
|---:|---:|---|---|---|---|---|
| 1 | **1** | S01 | 新都圣大家电 | ✅ | 028-67444368 | 新都区新城市广场和信中心 1-3 楼 |
| 2 | **4** | S04 | 金堂华林电器 | ✅ | 028-84988165 | 金堂县赵镇十里大道一段 428 号 |
| 3 | **8** | S08 | 崇州九兴电器 | ✅ | 028-82183298 | 崇州市蜀州中路 96 号 |
| 4 | **9** | S09 | 新津欣盛电器 | ✅ | 028-82525720 | 新津区武阳中路 27 号 |
| 5 | **10** | S10 | 青神易田电器 | ✅ | 028-38826998 | 眉山市青神县中岩广场对面 |
| 6 | **11** | S11 | 郫都康乐电器 | ✅ | 028-87886869 | 郫都区南大街 66 号 |
| 7 | **12** | S12 | 龙泉东山电器 | ✅ | 028-84623615 | 龙泉驿区驿都东路 38 号 |
| 8 | **13** | S13 | 茂县国茂电器 | ✅ | 0837-6937788 | 茂县凤仪镇内南街 54 号（城门洞） |
| 9 | **14** | S14 | 蒲江江华家电 | ✅ | 028-88555378 | 蒲江县鹤山北路 1 号 |
| 10 | **15** | S15 | 峨眉诚信电器 | ✅ | 0833-5388883 | 绥山西路 75 号坤大鑫城 |

**全部 10 家 `active = true`。** 与执行令"实际有 10 家门店"一致。

⚠️ **两点必须知道**：
1. **store_id 不连续**（1,4,8,9,10,11,12,13,14,15；缺 2/3/5/6/7）。任何"按 1..10 循环"的代码都会错，必须按实际 ID 枚举。
2. **存在悬空门店绑定**：`store_users` 有 `user_id=194 → store_id=2`，而 `stores` 表**没有 id=2**。该用户是 UAT 测试账号 `uat_store_b`。**本轮不改**，但 A1 建档案外键时不能依赖"store_id 一定存在"。

### 2.1 员工绑定现状（全部 12 行）

| user_id | 账号 | 名称 | 绑定门店 |
|---:|---|---|---|
| 193 | `uat_store_a` | UAT-A | 1 |
| 194 | `uat_store_b` | UAT-B | **2（悬空）** |
| 904 | `hl@scqfls.cn` | 华林电器 | **1,4,8,9,10,11,12,13,14,15（全部 10 家）** |

**生产上真实在用的门店账号只有 1 个（904，且绑 10 家）**；193/194 是验收残留。
另有 `hq_admin` 2 人、`hq_after_sales` 1 人、`viewer` 4 人、`admin`/`root` 各 1 人。

---

## 三、销售 / 门店负责人是否已有可映射角色

### **没有。这是 A1 之前必须做的决策。**

现有角色共 7 个，没有一个能表达"门店销售"或"门店负责人"：

| 角色 | 人数 | 现有语义 | 能否承载档案业务 |
|---|---:|---|---|
| `root` / `admin` | 1 / 1 | 平台超管 | ❌ 禁止用于业务授权 |
| `member` | 1 | NocoBase 默认 | ❌ 无业务语义 |
| `hq_admin` | 2 | 总部管理员（配置+全量） | ❌ 语义是"管理后台"，不是"只读业务" |
| `hq_after_sales` | 1 | 总部售后（全量） | ⚠️ 可近似"总部只读"，但语义是售后不是档案 |
| `viewer` | 4 | 只读管理层（全量） | ⚠️ 全量只读，但非"总部授权人员"专指 |
| `store_after_sales` | 5 | **门店售后（工单）** | ⚠️ 语义被工单占用 |

**关键风险**：把"门店销售"直接映射到 `store_after_sales`，会让**档案权限跟着工单权限走**——以后调整工单授权会静默改变档案授权。

**建议（待裁决）**：新增 2 个角色 `store_sales`（本店增改）、`store_manager`（本店只读），并遵守项目已有的"四处同步"纪律：
`constants.ts` 的 `ROLE` 枚举 → `ROLE_ROLE_NAME_MAP` → `HQ_ROLES`/写权限清单 → `expected-sensitive-columns.mjs` 的 `ROLE_MENU_MATRIX`。
漏掉第四处的后果是"后端认这个角色，但导航里一个菜单都没有"，且不报错。

---

## 四、附件存储能否支撑档案私有图片

**能，且已有可直接照抄的实现。**

| 项 | 实测 |
|---|---|
| 存储配置 | **仅 1 条**：`Local storage` / `type=local` / `default=true` / `documentRoot=storage/uploads` |
| 对象存储（OSS/COS/S3） | **无** |
| `attachments` 表 | 存在（NocoBase File Manager 标准表） |
| 现有私有照片范式 | `service_visit_photos`：`storage_key` + `file_id`，**不入原生读取白名单** |

现成可复用的受控读取（`actions/svc/visit-review.ts`）：

- `storage_key` **只在服务端使用**，服务层 `listPhotos` 已剔除；
- 前端只拿 `photoId`，凭 `photoId` 换流；
- 有 `photos.exists(storageKey)` 存在性校验；
- 明确注释"**不得**含 `storage_key` / `upload_ip_hash` / `file_id`"。

**结论**：不引入对象存储、不开放 File Manager 匿名列表，照 `service_visit_photos` 的 `storage_key` 模式建 `service_archive_photos` 即可满足"照片经会话与归属验证"。

---

## 五、档案验证码短信如何复用短信宝

### 5.1 现有短信体系（可扩展）

| 项 | 现状 |
|---|---|
| 通道 | `service_settings.sms.provider = smsbao` |
| 发送链路 | 既有 outbox（`sms_logs`，`send_status` 队列 / `delivery_status` 送达） |
| 已启用场景 | 4 个（`progress_link` / `review_invite` / `dispatch_customer` / `technician_task`） |
| 模板正文条目 | 8 条（`SMS_TEMPLATE_TEXT`），其中标注"已审核/冻结"的客户侧文案 3 条 |
| 未审核闸门 | `SMS_REVIEW_PENDING_SCENES` + `SMS_TEMPLATE_PENDING_REVIEW` **机制已存在** |

### 5.2 短信宝的关键差异（直接决定实现方式）

**短信宝接收完整正文（`c` 参数），不识别 TemplateCode。** 因此：

- **不需要**为验证码重建一套模板 CODE 映射；
- 新增 `SMS_SCENE.ARCHIVE_VERIFY` + 一条 `SMS_TEMPLATE_TEXT` 正文即可；
- 但仍**必须走短信宝平台侧的内容审核**（平台是内容审核制，不是 API 层校验）；
- 审核前用既有 `SMS_REVIEW_PENDING_SCENES` 闸门**只允许 mock 发送**——这套闸门已在生产代码里，不需要新造。

**现有 8 条模板一条都不动**，新增场景是第 9 条。

### 5.3 验证码实现建议：**自建轻量表，不用 `plugin-verification`**

`verification` 插件虽已启用，但它的 provider 模型是"通用验证因子"（登录/注册场景），**无法承载"绑定 store_id + mobile 的查询会话"**语义。

建议：`service_archive_verify_codes`（一次性码，5 分钟、6 位、60 秒重发、5 次错误上限）+ 复用现有 IP/手机号限流键，**发送仍走既有 outbox**。这样验证码与档案归属校验在同一个事务边界内，不需要跨插件猜状态。

---

## 六、原生手机录入是否可行

**结论：能力具备，但"可用性"未被证明；建议 A1 第一步先做一次真机最小验证，再决定是否要轻量 H5。**

| 判断依据 | 结果 |
|---|---|
| `mobile` 插件 | 已启用 |
| `mobileRoutes` | **0 行（从未配置）** |
| 生产是否已有移动端业务在用 | **无** |
| 手机拍照（File Manager upload） | 能力存在，**但未在手机端验证过** |
| 已知风险点 | ① 手机相机调用依赖 File Manager 前端上传组件；② 移动端页面与桌面页面是**两套路由配置**，需单独建；③ 生产禁止升级 NocoBase，只能用法 |

**阻断证据：目前没有。** 但也**没有成功证据**——不能把"插件已启用"当成"能用"。

执行令要求的 6 步真机验证（打开→新建→调用相机→上传预览保存→重开续编）必须在**开发环境**跑，且开发环境当前 Docker 已停止，需先启动。

若验证失败，才有资格讨论轻量员工 H5；届时提交具体阻断证据。

---

## 七、四个新增集合的最终数据字典

命名沿项目既有规范：`snake_case` 列名、`bigint` 主键、`timestamptz` 时间、`character varying` 短文本、`text` 长文本、`json` 扩展。

### 7.1 `service_archives`（主表）

| 字段 | 类型 | 空 | 说明 |
|---|---|:--:|---|
| `id` | bigint PK | — | |
| `archive_no` | varchar(32) | N | 档案号 `DA-YYYYMMDD-XXXX`，**唯一** |
| `store_id` | bigint | N | → `stores.id`，**所有写入的门店归属判据** |
| `archive_type` | varchar(16) | N | `service` / `hvac` |
| `customer_name` | varchar(64) | N | 敏感 |
| `customer_mobile` | varchar(20) | N | 敏感，**不唯一**（允许多次购买/多项工程） |
| `service_address` | varchar(255) | N | 敏感 |
| `product_description` | text | Y | 产品/机型描述 |
| `package_description` | text | Y | 套餐说明 |
| `purchase_date` | date | Y | 购买日期 |
| `planned_date` | date | Y | 预约上门日期 |
| `service_type` | varchar(24) | Y | 仅 `archive_type=service`：`delivery`/`install`/`repair`/`clean`/`guide`/`other` |
| `assigned_worker` | varchar(64) | Y | 上门人员姓名（**不建独立账号**） |
| `sales_user_id` | bigint | Y | → `users.id` |
| `notes` | text | Y | **内部备注，永不公开** |
| `status` | varchar(24) | N | `draft`/`published`/`voided` + 进度态（见下） |
| `completed_at` | timestamptz | Y | |
| `published_at` | timestamptz | Y | |
| `version` | integer | N | **乐观锁**，默认 1（并发控制） |
| `created_by` / `updated_by` | bigint | N | |
| `created_at` / `updated_at` | timestamptz | N | |

**索引（必须）**

```
UNIQUE (archive_no)
INDEX  (store_id, customer_mobile)   ← 执行令点名要求
INDEX  (store_id, status, updated_at DESC)
INDEX  (customer_mobile)
```

**状态取值分离**（草稿/发布 是可见性，不是进度）：

| 维度 | 取值 |
|---|---|
| `status`（进度） | `pending` 待安排 / `scheduled` 已预约 / `serving` 服务中 / `completed` 已完成 / `accepted` 已验收（暖通专用） |
| `visibility`（建议独立列，不塞进 status） | `draft` / `published` / `voided` |

> 把"可见性"和"进度"挤进同一个 `status` 是常见错误：作废一份已完成的档案时，`status` 该写 `completed` 还是 `voided`？拆两列后两者正交，`published_at` / `voided_at` 各自留痕。

### 7.2 `service_archive_stages`（暖通六阶段）

| 字段 | 类型 | 空 | 说明 |
|---|---|:--:|---|
| `id` | bigint PK | — | |
| `archive_id` | bigint | N | → `service_archives.id`，级联 |
| `stage_code` | varchar(16) | N | `survey`/`plan`/`pipe`/`device`/`test`/`accept` |
| `stage_order` | smallint | N | 1..6，**顺序约束的机器可读来源** |
| `stage_date` | date | Y | 完成时必填 |
| `note` | text | Y | |
| `status` | varchar(16) | N | `pending` / `done` / `withdrawn` |
| `completed_at` | timestamptz | Y | |
| `completed_by` | bigint | Y | |
| `version` | integer | N | 并发控制 |
| `created_at` / `updated_at` | timestamptz | N | |

```
UNIQUE (archive_id, stage_code)
INDEX  (archive_id, stage_order)
```

**照片必填的阶段**（执行令冻结）：`survey` / `pipe` / `device` / `accept` 必须 ≥1 张；`plan` / `test` 可选。每阶段最多 **6 张**。

### 7.3 `service_archive_photos`

| 字段 | 类型 | 空 | 说明 |
|---|---|:--:|---|
| `id` | bigint PK | — | |
| `archive_id` | bigint | N | 归属判据 |
| `stage_id` | bigint | Y | 暖通阶段照片；上门服务为 NULL |
| `photo_type` | varchar(16) | N | `before` / `after` / `stage` |
| `storage_key` | varchar(255) | N | **私有存储键，绝不出接口** |
| `file_id` | bigint | Y | → `attachments.id`（可空，仅作溯源） |
| `mime_type` | varchar(64) | N | **服务端按魔数判定**，不信扩展名 |
| `byte_size` | integer | N | |
| `width` / `height` | integer | Y | |
| `exif_stripped` | boolean | N | 默认 true（剥离 GPS/EXIF） |
| `published` | boolean | N | **仅 published=true 且档案已发布**才对外 |
| `uploaded_by` | bigint | N | |
| `created_at` | timestamptz | N | |

```
INDEX (archive_id, photo_type)
INDEX (stage_id)
```

### 7.4 `service_archive_events`（审计）

| 字段 | 类型 | 空 | 说明 |
|---|---|:--:|---|
| `id` | bigint | — | |
| `archive_id` | bigint | N | |
| `stage_id` | bigint | Y | |
| `event_type` | varchar(32) | N | 见下 |
| `actor_user_id` | bigint | Y | |
| `actor_role` | varchar(32) | Y | 快照，不改写历史 |
| `payload_json` | json | Y | **不得含手机号明文/验证码** |
| `created_at` | timestamptz | N | |

事件类型：`archive_created` / `archive_updated` / `archive_published` / `archive_voided` / `stage_completed` / `stage_withdrawn` / `photo_added` / `photo_removed` / `verify_code_issued` / `customer_queried`

### 7.5 验证码与会话（建议增补两表）

执行令只点名四集合，但"验证码绑定门店+手机号、生成短期会话"无表可落。建议增补（**待批准**）：

- `service_archive_verify_codes`：`store_id` / `customer_mobile` / `code_hash` / `expires_at` / `attempts` / `consumed_at` / `ip_hash`
- `service_archive_query_sessions`：`session_token_hash` / `store_id` / `customer_mobile` / `expires_at` / `last_seen_at`

两表都**只存哈希**，不存明文码/明会话。

---

## 八、预计改动文件与受影响模块

### 8.1 新增

| 路径 | 内容 |
|---|---|
| `src/server/collections/serviceArchives.ts` | 主表 |
| `src/server/collections/serviceArchiveStages.ts` | 六阶段 |
| `src/server/collections/serviceArchivePhotos.ts` | 照片（私有） |
| `src/server/collections/serviceArchiveEvents.ts` | 审计 |
| `src/server/collections/serviceArchiveVerifyCodes.ts` | 验证码（待批） |
| `src/server/collections/serviceArchiveQuerySessions.ts` | 查询会话（待批） |
| `src/server/services/archive-service.ts` | 主业务 + 并发控制 |
| `src/server/services/archive-stage-service.ts` | 六阶段事务校验 |
| `src/server/services/archive-photo-service.ts` | 私有存储 + 魔数 + EXIF |
| `src/server/actions/svc/archive.ts` | 员工侧：list/detail/create/update/stage/publish/void |
| `src/server/actions/public/archive-query.ts` | 客户侧：验证码 + 查询 + 照片流 |
| `src/server/migrations/2026xxxx-arc-v1.ts` | 建表 + 索引 |
| `h5/src/pages/Archive/*.vue` | 客户查询 H5（沿用现有 H5 工程） |
| `scripts/verify-arc-v1.mjs` | 14 条承重验收 |
| `scripts/expected-sensitive-columns.mjs`（改） | 新集合敏感列 + 页面 + 矩阵 |

### 8.2 修改（必须同步，漏一处就"看起来坏了但不报错"）

| 文件 | 改什么 |
|---|---|
| `src/server/constants.ts` | `ROLE` 增 `store_sales`/`store_manager`；`ARCHIVE_TYPE`/`STATUS`/`VISIBILITY`/`STAGE_CODE`；`SMS_SCENE.ARCHIVE_VERIFY`；`SMS_TEMPLATE_TEXT` 第 9 条；`ROLE_ROLE_NAME_MAP` 两条；`AUTHENTICATED_SVC_ACTIONS` / 匿名白名单 |
| `src/server/services/permission-service.ts` | 新角色映射 + `storeScope` 覆盖档案集合 |
| `src/server/plugin.ts` | 注册新 action handlers |
| `scripts/expected-sensitive-columns.mjs` | `REQUIRED_ADMIN_PAGES` +5 页；`ROLE_MENU_MATRIX` 按角色授权 |
| `scripts/seed-admin-pages.mjs` | 5 个页面蓝图 + 移动端路由 |
| `h5/src/router`、`nginx` | `/archive` 客户入口 |

### 8.3 受影响但不改

`service_tickets` / `service_visits` / `sms_logs` / `store_users` / `rolesDesktopRoutes` 的**现有数据与状态机一律不动**。

### 8.4 生产影响面（部署时需要的最小 diff 与备份）

- **schema 变更**：仅新增 4~6 张表 + 索引，**无 ALTER 现有表**，无不可逆迁移；
- **备份**：部署前 `pg_dump` 业务表结构 + 新建表为空，回滚=删表；
- **ACL**：只新增资源条目，**不扩大通配符**；
- **静态产物**：需重建插件 dist + H5 dist（部署时单独申请）。

---

## 九、A0 发现的风险项（需裁决后才能进 A1）

| # | 风险 | 影响 | 建议 |
|---|---|---|---|
| R1 | **无"门店销售 / 门店负责人"角色** | A1 无法按契约授权；若硬套 `store_after_sales` 会让档案权限随工单权限漂移 | 新增 2 角色，四处同步（见 §3） |
| R2 | **门店 2 悬空**（`user 194 → store 2`，stores 无 id=2） | A1 建外键/范围校验时可能踩空 | 本轮不动；外键只约束"存在即合法"，不假设连续性 |
| R3 | **真实门店账号只有 1 个**（904 绑 10 店） | "销售只能改本店"无法用现有账号验证到"不同店之间隔离" | A1 需在开发环境造 2 个不同店账号做正反向验收 |
| R4 | **mobile 从未配置过** | 原生手机录入"未证明可用" | A1 第一步先真机验证 6 步 |
| R5 | **开发环境 Docker 已停止** | 无法做任何开发验证 | 需先启动本地栈 |
| R6 | 四项之外还缺"验证码/会话"落点 | 执行令点名 4 集合，但验证码无表 | 建议增补 2 表（见 §7.5），待批 |

---

**A0 结论**：环境与兼容性**具备开发条件**，无"必须立即叫停"的问题；但 **R1（角色缺失）与 R4（移动端未验证）是 A1 的前置决策**，R6 需要你对"增补 2 张验证码/会话表"表态。

本轮未做任何写入。
