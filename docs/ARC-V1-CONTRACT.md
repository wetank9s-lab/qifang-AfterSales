# ARC-V1 · 接口契约与移动端交互设计（A2/A3 已实现部分）

> 日期：2026-11-09　范围：仅本地开发环境
> 本文是**页面配置与真机验收的前置产物**。服务端 A2/A3 已实现并通过定向验收；
> NocoBase 页面因 admin 会话未就绪而暂缓（按用户 2026-11-09 指令）。

---

## 一、数据结构

### 1.1 已建表（4 张）

| 表 | 关键列 | 说明 |
|---|---|---|
| `service_archives` | `archive_no`(uniq)、`store_id`、`archive_type`、`status`、`visibility`、`version`、`notes`、`public_note` | `status`（进度）与 `visibility`（客户可见性）**正交** |
| `service_archive_stages` | `archive_id`、`stage_code`、`stage_order`、`status`、`stage_date`、`version`、`withdraw_reason` | 建档案时**一次写六行**，`unique(archive_id, stage_code)` |
| `service_archive_photos` | `archive_id`、`stage_id`、`photo_type`、`storage_key`、`published`、`exif_stripped` | `storage_key` 永不出接口 |
| `service_archive_events` | `archive_id`、`stage_id`、`event_type`、`actor_role`、`payload_json` | 只记能归属到具体档案的事件 |

### 1.2 待建表（2 张，按用户裁决延后到 A4）

- `service_archive_verify_codes`：`store_id` / `customer_mobile` / `code_hash` / `expires_at` / `attempts` / `consumed_at` / `ip_hash`
- `service_archive_query_sessions`：`session_token_hash` / `store_id` / `customer_mobile` / `expires_at` / `revoked_at`

两表**只存哈希**，不存明文码/明会话。

### 1.3 枚举（`constants.ts` 单一事实来源）

| 枚举 | 取值 |
|---|---|
| `ARCHIVE_TYPE` | `service` / `hvac` |
| `ARCHIVE_VISIBILITY` | `draft` / `published` / `voided` |
| `ARCHIVE_STATUS` | `pending` / `scheduled` / `serving` / `completed` / `accepted` |
| `ARCHIVE_SERVICE_TYPE` | `delivery` / `install` / `repair` / `clean` / `guide` / `other` |
| `ARCHIVE_STAGE_CODE`（顺序即规则） | `survey` → `plan` → `pipe` → `device` → `test` → `accept` |
| 关键阶段（照片必填） | `survey` / `pipe` / `device` / `accept` |
| 每阶段照片上限 | **6** |
| 普通服务完工必填照片类型 | `before` + `after` 各 ≥1 |
| `ARCHIVE_PHOTO_TYPE` | `before` / `after` / `stage` |
| `ARCHIVE_STAGE_STATUS` | `pending` / `done` / `withdrawn` |
| `ARCHIVE_EVENT_TYPE` | `archive_created` / `archive_updated` / `archive_published` / `archive_voided` / `stage_completed` / `stage_withdrawn` / `photo_added` / `photo_removed` |

---

## 二、Action 契约（已实现 6 个）

统一前缀 `/api/svc:<action>`，均要求登录 + `X-Request-Id`（**必须是合法 UUID v4**）。

### 2.1 `archiveCreate`

```
POST /api/svc:archiveCreate
{ archive_type, store_id, customer_name, customer_mobile, service_address,
  service_type?, product_description?, package_description?,
  purchase_date?, planned_date?, assigned_worker?, notes?, public_note? }
→ 200 { archive }
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `ARCHIVE_FORBIDDEN` | 403 | 非 `store_sales`（负责人/总部/viewer/未知角色） |
| `ARCHIVE_STORE_NOT_DETERMINED` | 403 | 未传 `store_id` 且当前账号零店/多店/悬空绑定（fail closed，不猜） |
| `ARCHIVE_NOT_FOUND` | 404 | `store_id` 不在本人授权门店内（越权与不存在统一 404） |
| `ARCHIVE_MISSING_FIELD` | 400 | 客户姓名/手机号/地址缺失；上门服务缺 `service_type` |
| `ARCHIVE_BAD_MOBILE` | 400 | 手机号格式 |
| `IDEMPOTENT_PAYLOAD_MISMATCH` | 409 | 同一 `X-Request-Id` 已用于**内容不同**的建档，拒绝回放（列出不同的字段名，不含明文） |
| `IDEMPOTENT_CONCURRENT_PENDING` | 409 | 同号另一次提交仍在处理中，等不到完成态（不伪造成功） |
| `IDEMPOTENT_RESOURCE_MISSING` | 409 | 幂等记录指向的档案确已不存在 |
| `IDEMPOTENT_REPLAY_UNAVAILABLE` | 409 | 已执行但首次响应未缓存 |
| `IDEMPOTENT_REPLAY_STALE` | 409 | 缓存响应与档案真实行的 `version` 不一致（档案在首次响应后被改过），不回放过期快照 |

**行为**：`hvac` 自动生成六行阶段；`status=pending`、`visibility=draft`、`version=1`。

#### 2.1.1 幂等保证与事务边界（2026-11-10 收口）

`store_id` 可省略：由服务端从**当前登录销售的唯一有效门店绑定**推导；
显式传入时仍走一致性校验（传了就校验，不是一律拒绝）。

`X-Request-Id` 在本 action 上是**真正的幂等键**（不只是格式校验）：

- **键**：`scene='archive_create'` + `${actor.userId}:${requestId}`。含操作者 ⇒ 跨人同号不会互相回放。
- **事务范围**：档案行 + 暖通阶段行 + `archive_created` 事件 + `idempotency_records` 行
  **同一个 PostgreSQL 事务**（`ArchiveService.create` 接受 `transaction` 参数）。
  任一步失败整体回滚 ⇒ 不存在"半个档案"，也不存在"有幂等无业务"。
- **并发**：靠 `idempotency_records (scene, idempotency_key)` 的**唯一约束**做原子裁判
  （先写幂等行，碰撞则整个事务回滚，不预设 advisory lock）。
  落败方回滚后**用另一条连接**读先到者**已提交**的档案与缓存响应，再比对内容。
- **同号不同内容**：409 `IDEMPOTENT_PAYLOAD_MISMATCH`，绝不回放旧响应，也绝不静默新建。
- **业务失败**（如手机号非法）：不写幂等记录 ⇒ 同号重试是正常路径，不会被误判成重放。
- **返回**：命中重放时响应体与首次逐字节一致，另加 `X-Idempotent-Replay: 1`。

验证（`.tmp-verify/a8/`，全部回查**真实行数**，不以"编号相同"代替）：

| # | 用例 | 结果 |
|---|---|---|
| 1 | 顺序重放 → 两次 200、同编号、`service_archives` 1 行 | PASS |
| 2 | 同号并发 → 1 行、所有成功响应同编号 | PASS |
| 2b | **真实唯一键碰撞**（DB 事务占住幂等键并卡 2.5s）→ 回放先到者编号、落败方业务写入 0 行 0 事件 | PASS |
| 3 | `archive_created` 事件数 = 档案行数 = 1 | PASS |
| 4 | 业务失败后同号重试成功、失败时未写幂等记录 | PASS |
| 5 | 同号不同内容 → 409 `PAYLOAD_MISMATCH`，第二份内容 0 行 | PASS |
| 反向 | 置 `SVC_IDEM_TXN=off` 关闭事务 → 用例 2b **变红**（`archives=2`） | 已证断言有效 |

**事务开关已移除（2026-11-10）**：`SVC_IDEM_TXN` 当初只用于上面那一行反向验证。
验证完成后已从代码中删除 —— **一个能被环境变量关掉的事务等于没有事务**，
它的误用不会报错、只会让并发重复建档悄悄复活。现在事务路径无条件生效。
反向验证结论已固化在下表，不需要再留脚手架。

**回放前的两道复核（2026-11-10，用户安全核对项）**：

| 复核 | 做什么 | 为什么必须有 |
|---|---|---|
| ① 当前权限 | 用**本次请求**的 actor 对**档案真实行**跑 `assertCanWriteStore` | 幂等记录是"当初"的历史，权限必须按"现在"判。否则账号被撤角色后，拿旧 `X-Request-Id` 就能读到档案编号与状态 |
| ② 快照新鲜度 | 缓存体 `version` 与真实行 `version` 不一致 ⇒ 409 `REPLAY_STALE` | 收窄响应体后快照可能过期；回放过期版本号会让后续 `expected_version` 编辑陷入必然 409 的死循环 |

**`response_json` 只存最小字段集**（实测 `len=215`）：
`archive{id, archive_no, archive_type, store_id, status, visibility, version, created_at}`。
**不含** `customer_name / customer_mobile / service_address / notes` 等任何客户信息 ——
不是"存了再脱敏"，而是**根本不存**（与 `ticket-create` 的 `responseOf` 同一口径）。
回放需要的内容比对仍走**库里那张真实档案**，不依赖缓存。

安全核对取证（`.tmp-verify/a8/v5-security-checks.mjs`，22/22 PASS）：

| # | 用例 | 结果 |
|---|---|---|
| §1.1 | 源码/产物/容器三处均无 `SVC_IDEM_TXN`，事务无条件走 `sequelize` | PASS |
| §1.3a/b | `response_json` 内无手机号 `13900007788`、无地址标记 | PASS |
| §1.3c/d | 最小字段集齐全；且**根本没有**客户相关列 | PASS |
| §1.2 对照 | 撤权**前**用旧 requestId 回放 = 200（证明重放本来就能工作） | PASS |
| §1.2a | 撤门店绑定后，新/旧 token 均 403 `ARCHIVE_STORE_NOT_DETERMINED` | PASS |
| §1.2d | **撤 `store_sales` 改 `store_manager`、门店绑定不动** → 回放 403 `ARCHIVE_FORBIDDEN` | PASS |
| §1.3f | 档案被改过（v1→v2）后回放 → 409 `IDEMPOTENT_REPLAY_STALE` | PASS |
| 反向 | 注释掉复核① → §1.2d 立刻**变红**（`status=200`） | 已证断言有效 |

> ⚠️ **环境陷阱（踩过一次，代价是半个小时的错误结论）**：
> 直接 `UPDATE "rolesUsers"` 改角色后**不重启 app，权限判定完全不变** ——
> NocoBase 在进程内缓存了用户角色。我因此一度以为"角色校验根本不存在"，
> 实际是缓存没刷新。**任何靠改库制造权限差异的用例，改完必须 `docker compose restart app`
> 并等 `/api/app:getInfo` 回到 200**，否则测到的是缓存，不是代码。


### 2.2 `archiveUpdate`

```
POST /api/svc:archiveUpdate
{ id, expected_version, ...白名单字段 }
→ 200 { archive }
```

白名单：`customer_name / customer_mobile / service_address / product_description /
package_description / purchase_date / planned_date / service_type / assigned_worker /
notes / public_note`。

**不允许**通过本接口改 `status` / `visibility` / `store_id` / `archive_no`。

| 错误码 | HTTP |
|---|---|
| `ARCHIVE_MISSING_VERSION` | 400（强制乐观锁，不传就是允许无条件覆盖） |
| `ARCHIVE_STALE` | 409 |
| `ARCHIVE_VOIDED` | 409 |

### 2.3 `archiveComplete`（普通上门服务完工）

```
POST /api/svc:archiveComplete
{ id, completed_at, expected_version? }
→ 200 { archive }
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `ARCHIVE_MISSING_COMPLETED_AT` | 400 | 未填实际完成日期 |
| `ARCHIVE_PHOTO_REQUIRED` | 409 | 缺 `before` 或 `after`（**逐类型判**，只有一张也拒） |
| `ARCHIVE_WRONG_TYPE` | 400 | 暖通请走阶段 |
| `ARCHIVE_STALE` | 409 |

### 2.4 `archiveStageComplete`

```
POST /api/svc:archiveStageComplete
{ id, stage_code, stage_date, note?, expected_version }
→ 200 { archive, stage }
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `ARCHIVE_STAGE_OUT_OF_ORDER` | 409 | 前一阶段未完成 |
| `ARCHIVE_STAGE_PHOTO_REQUIRED` | 409 | 关键阶段无照片 |
| `ARCHIVE_STAGE_PHOTO_TOO_MANY` | 409 | 超过 6 张 |
| `ARCHIVE_STAGE_ALREADY_DONE` | 409 | 已完成，需先撤回 |
| `ARCHIVE_STAGE_STALE` | 409 | 版本冲突 |

**副作用**：`accept` 完成 ⇒ 工程 `status=accepted`；其它阶段首完成 ⇒ 从 `pending` 推进到 `serving`。

### 2.5 `archiveStageWithdraw`

```
POST /api/svc:archiveStageWithdraw
{ id, stage_code, reason, expected_version }
→ 200 { archive, withdrawn: [stage_code...] }
```

**连锁**：撤回 order=N 时，所有 order>N 且已完成的阶段一并撤回。
**留痕**：`status=withdrawn` + `withdraw_reason` + 事件；`stage_date` / `completed_at` **保留**。
**回退**：若工程原为 `accepted`，撤回后置回 `completed`。

### 2.6 `archiveStageList`

```
GET /api/svc:archiveStageList?id=<archiveId>
→ 200 { stages: [{ id, stage_code, stage_order, status, stage_date, note,
                   completed_at, completed_by, version, withdraw_reason,
                   photo_count, photo_required, photo_max }] }
```

不含 `storage_key`（已验证）。

---

## 二·B、照片 action（ARC-PHOTO-01）

### 2.7 `archivePhotoAttach`（multipart）

```
POST /api/svc:archivePhotoAttach?id=<archiveId>
Content-Type: multipart/form-data
  file        必填，单文件
  photo_type  service: before|after；hvac: 可省（强制 stage）
  stage_id    hvac 必填
→ 200 { photo: { id, archive_id, stage_id, photo_type, mime, byte_size,
                 width, height, published, uploaded_at } }
```

**投影里没有 `storage_key`**（已验证）。

| 错误码 | HTTP | 含义 |
|---|---|---|
| `NO_FILE` | 422 | 不是 multipart 或没有 file 字段 |
| `ARCHIVE_PHOTO_BAD_IMAGE` | 415 | magic bytes 不认识（不是 JPEG/PNG/WebP） |
| `ARCHIVE_PHOTO_TOO_LARGE` | 413 | 超过单张上限（默认 5MB） |
| `ARCHIVE_PHOTO_METADATA_RESIDUAL` | 422 | 剥完仍有元数据残余 |
| `ARCHIVE_PHOTO_BAD_TYPE` | 400 | 普通服务用了 stage / 暖通用了 before·after |
| `ARCHIVE_PHOTO_STAGE_REQUIRED` | 400 | 暖通照片没给 stage_id |
| `ARCHIVE_PHOTO_STAGE_INVALID` | 400 | 普通服务照片带了 stage_id |
| `ARCHIVE_PHOTO_STAGE_MISMATCH` | 400 | stage 不属于该档案 |
| `ARCHIVE_STAGE_PHOTO_TOO_MANY` | 409 | 该阶段已满 6 张 |
| `ARCHIVE_VOIDED` | 409 | 档案已作废 |

**行为**：落私有目录（与师傅照片同一个 `UPLOAD_PRIVATE_DIR`）→ 写 `service_archive_photos` →
写 `photo_added` 事件。**`published` 一律从 false 开始。**

### 2.8 `archivePhotoPublish`

```
POST /api/svc:archivePhotoPublish
{ photo_id, published: true|false }
→ 200 { photo }
```

| 规则 | 说明 |
|---|---|
| 发布要求阶段 done | 暖通照片所属阶段必须 `status=done`，否则 409 `ARCHIVE_PHOTO_STAGE_NOT_DONE` |
| 撤回后不能直接发布 | 同上（阶段是 withdrawn ⇒ 非 done） |
| 取消发布永远允许 | 撤回场景走这条路 |

### 2.9 `archivePhotoFile`（内部受控读取）

```
GET /api/svc:archivePhotoFile?photo_id=<id>
→ 200 图片字节（Content-Type 按库内 mime；Cache-Control: private, no-store）
```

**不做 published 过滤**：内部要能查看历史照片（含已撤回阶段的）。
门店范围由 `assertCanAccessRow` 判；总部角色放行。

### 2.10 `archivePhotoList`

```
GET /api/svc:archivePhotoList?id=<archiveId>
→ 200 { photos: [投影，同 2.7] }
```

---

## 二·C、客户可见性（唯一入口）

```ts
isPhotoCustomerVisible(archive, photo, stage)
  = archive.visibility === 'published'
  && photo.published === true
  && (photo.stage_id == null || stage.status === 'done')
```

**A4 的客户读取接口必须调这个函数**，不得各写一遍 where 条件（漏一条只会多给一张照片，不报错）。

---

## 二·D、单值读取口径与门店范围（A5-C 修复，2026-11-10）

### 2.11 单值读取的唯一正确写法

`serviceArchives:get` 有三种写法，本机实测后果完全不同（**这是本轮最危险的一条**）：

| 写法 | 实际结果 | 结论 |
|---|---|---|
| `?filterByTk=146` | **404「工单 146 不存在」** | 错。旧 `assertOwnership` 把档案 id 拿去查工单表 |
| `/:id` 末段（如 `serviceArchives:get:146`） | **200，但静默返回 `id=1` 的另一条档案** | **最危险**。末段被当成页码，页面"看起来打开成功了"，实际展示的是别人的档案 |
| `?filter[id]=146` | 200，且 `id` 与请求一致 | **正确写法** |

**客户端强制双保险**（`archive-edit-block.tsx`）：

```ts
const res = await request('serviceArchives:get', 'get', undefined, {
  headers: { 'X-Data-Source': 'main' },
  params: { filter: { id } },
});
const row = payloadOf(res) as ArchiveRow;
if (!row || !row.id) throw new Error('没取到档案内容');
if (Number(row.id) !== Number(id)) throw new Error(`取回的档案 id=${row.id} 与请求 id=${id} 不一致`);
```

> 服务端返回错行 + 客户端不校验 = 用户以为自己编辑的是 A 档案，实际改的是 B 档案。
> 这类错误**不报错、不留痕**，只能靠客户端断言拦住。

### 2.12 `storeScope` 的两个真实缺陷（已修）

**缺陷 1：`filter[id]` 越权读取（fail-open）**

- 现象：B 店销售（store 4）请求 `get?filter[id]=170`（A 店档案）→ **200 + 完整档案内容**；
  而同一条件的 `list?filter[id]=170` 正确返回 `[]`。
- 根因：`resolveTargetKey` 只认 `filterByTk` / `filterByPK`，不认 `params.filter.id`
  ⇒ `assertOwnership` 被整段跳过 ⇒ `get` 解析不出主键时只打 debug 日志就 `next()`。
- 修复：① `resolveTargetKey` 识别 `filter.id`（兼容 `{id:170}` 与 `{id:{$eq:170}}`）；
  ② **`get` 解析不出主键时注入恒假范围**（`$and:[orig, {id:-1}]`）——
  从"解析不出就放行"改为"解析不出就返回空"。这一条是 fail-closed 的兜底，
  即使将来又出现第三种写法，也只会读到空，不会读到别人的数据。

**缺陷 2：`assertOwnership` 对 `via:'self'` 一律查工单表**

- 现象：修完缺陷 1 后，**所有人**读档案都 404。
- 根因：`assertOwnership` 对 `via:'self'` 调 `assertCanAccessTicket()`，它查的是 `serviceTickets`。
  `serviceArchives` 也是 `via:'self'` ⇒ 拿档案 id 去工单表找，必然查不到。
  这个缺陷在缺陷 1 存在时被**完全掩盖**（越权路径根本不进 `assertOwnership`）。
- 修复：新增 `RESOURCE_TABLE` 映射，`via:'self'` 按资源名取表、读 `row.store_id` 与 `scope.storeIds` 比对：

```ts
const RESOURCE_TABLE: Record<string, string> = {
  serviceTickets: 'serviceTickets',
  serviceArchives: 'serviceArchives',
};
```

**双向验证（5/5 PASS）**——注意这张表**必须同时有"拿得到"和"拿不到"**：

| 用例 | 期望 | 结果 |
|---|---|---|
| A. B 店销售读 A 店档案 | 拿不到 | 404「记录 1 不存在」 |
| B. B 店销售读本店档案 | **拿得到** | 200 `id=2 DA-A1-TEST-B` |
| C. A 店销售读本店档案 | **拿得到** | 200 `id=1 DA-A1-TEST-A` |
| D. admin 读 A 店档案 | **拿得到** | 200 |
| E. A 店销售读 B 店档案 | 拿不到 | 404 |

> ⚠️ **变异测试的教训**：把 `filter[id]` 识别关掉后，A/E 仍然 PASS（fail-closed 兜底返回 `{"data":null}`），
> 但 B/C/D 全变红。**只测"越权拿不到"会得到假绿** —— 因为"全关掉"也满足"越权拿不到"。
> 判据必须双向：既证明不该给的没给，也证明该给的给了。

### 2.13 关联子表的门店范围：`via:'archive'` 两跳通道（A5-D 修复，2026-11-10）

**缺陷：`serviceArchiveEvents` / `serviceArchiveStages` 完全没有门店隔离**

`store-scope.ts` 里原有的注释写的是"这两张表的范围校验在 `archive-service` 的
`assertArchiveAccess` 完成"——**那个函数在全仓并不存在**。于是这两张表同时满足两个条件：

- 它们在 `ARCHIVE_NATIVE_READ_RESOURCES` 里 ⇒ 门店角色**有**原生读权限；
- 它们**不在** `SCOPED_RESOURCES` 里 ⇒ 中间件**不注入**任何范围。

结果：B 店销售 `list?filter[archive_id]=130`（A 店档案）→ **200 + 完整事件行**
（含 `actor_user_id`、操作时间线）。照片 `serviceArchivePhotos` 当时反而是 403，
因为它在 ACL 层就被整资源封禁 —— **两张子表的待遇不一致，一个漏在中间件、一个拦在 ACL**。

**修复：新增第三种 scope 通道**

```ts
serviceArchiveEvents: { via: 'archive', label: '档案事件' },
serviceArchiveStages: { via: 'archive', label: '档案阶段' },
```

`via:'archive'` = 子表自身没有 `store_id`，经 `archive_id` **两跳**到 `serviceArchives.store_id`：

| 环节 | 做法 | 为什么不能图省事 |
|---|---|---|
| 范围过滤 | `{'archive.store_id': {$in: storeIds}}`（关系路径，让 NocoBase 生成 JOIN） | 若改成"先查该店全部档案 id 再 `archive_id IN (...)`"：① 两次查询之间新产生的档案不在集合里（**新数据被误挡**）；② 大店上千条档案时会塞一个巨大 IN 列表 |
| 对象级校验 | 先查子行拿 `archive_id`，再按 `via:'self'` 校验 `serviceArchives` 那一行的 `store_id` | — |
| 解析不出归属 | **404**（`archive_id` 为空/非法即拒） | "不知道它属于谁"不等于"可以放行" |
| `get` | **也注入范围**（第二道防线） | `proxyToRepository` 把 `filterByTk` 与 `filter` **一起**交给 `findOne`；只靠对象级校验存在"验 A 行、返 B 行"的窗口 |

**验证（31 项，双向）**：A 店读本店 ✅ / B 店读本店 ✅ / 互相越权均 404 或空 / 异常 get 参数不返回任何档案。
后续以变异测试确认断言有效：关掉 `via:'archive'` 与 `get` 的归属校验后 **31 → 14（17 项变红）**，
暴露出的最危险情形是 **无参数 `get` 返回 `id=1`**、`get:130` 被 B 店拿到 A 店完整档案。

### 2.14 409 冲突提示的文案口径（A5-D 修订）

**真正对用户生效的是服务端那一句**，不是前端 Alert 的 `message`：
`ArchiveError` 的文案会经 toast 弹出并**覆盖**前端描述文字。所以两处都要改，且以服务端为准。

| 位置 | 文案 | 说明 |
|---|---|---|
| 标题 | `本次修改未保存（数据已更新）` | 先给**结果**。只说"数据已被其他人修改"会让人以为存上了、只是有提示 |
| 描述 | `保存未成功：数据已更新，本次修改未保存。你当前填写的内容已为你保留，请核对后确认是否重新加载` | 三件事：没存上 / 内容还在 / 由人决定是否重新加载 |
| 按钮 | `重新载入最新内容` | 显式动作，**不自动覆盖**用户输入 |

**硬禁止**：任何位置都不得出现「请刷新」/「刷新页面」/「刷新后重试」。
刷新是最容易丢掉未保存内容的操作，与这条提示的目的正好相反。

**可访问性**：提示框渲染出来 ≠ 用户看得见。A5-D 实测曾出现 `rect.top = -130`
（整个提示落在视口上方）。组件内有一段对齐逻辑把 `min(提示框.top, 表单.top)` 送到
`12px`，并用「元素相对视口的位置」复测一次，不依赖滚动容器顶部当基准
（那个容器 `clientHeight = 0`，滚动发生在内部合成层，容器顶部**不是内容原点**）。

---

## 三、移动端交互设计（待页面配置后落地）

### 3.1 页面清单与角色

| 页面 | 数据 | 可见角色 | 移动端要点 |
|---|---|---|---|
| 我的服务档案 | `serviceArchives`（本店） | 销售 / 负责人 | 列表卡片：客户名 + 类型徽标 + 进度条 |
| 新建上门服务信息卡 | 表单 | 销售 | **分两屏**：客户信息 → 产品与日期；底部固定「保存」 |
| 暖通六阶段记录 | `serviceArchiveStages` | 销售 | 竖向步骤条；每阶段一个「+ 拍照」与「完成」 |
| 本店只读档案 | `serviceArchives` | 负责人 | 只读详情，隐藏所有写按钮 |
| 总部跨店档案 | `serviceArchives`（全量） | hq_admin / hq_after_sales | 顶部门店筛选，只读 |

### 3.2 拍照上传流程（关键）

```
点「+ 拍照」→ 调系统相机 → 得到 file
   ↓
POST 上传（复用现有受控媒体链路）→ 得到 photoId
   ↓
POST /api/svc:archivePhotoAttach { id, stage_id?, photo_type, photoId }
   ↓
成功后本地列表插入缩略图（不等整页刷新）
```

**失败保留**（执行令明确要求）：上传失败时**不得清空已填表单**。
实现要点：
- 表单草稿在每次字段变更时写本地存储（`sessionStorage`），页面重开可恢复；
- 照片上传失败只在照片区显示「重试」，不影响已填字段；
- 「完成」按钮在照片未成功时禁用并给出明确原因，而不是静默失败。

### 3.3 桌面端

原生表格 + 筛选 + 详情抽屉；阶段用关联子表 + 步骤条。
**写入一律走 `svc:*`**，页面上的「完成/撤回」按钮调用业务 action，不绑原生 `update`。

---

## 四、页面配置待办（等 admin 会话）

1. 建 6 个页面（5 桌面 + 1 移动最小页）；
2. 移动端路由授权给 `store_sales` / `store_manager`；
3. 菜单矩阵（`ROLE_MENU_MATRIX`）加 5 项，只对上述角色可见；
4. **不跑全量 seed**、不覆盖旧页面树（用 `--sync-menus-only` 纪律）。

---

## 五、尚未解决的业务歧义

| # | 歧义 | 现状 | 建议 |
|---|---|---|---|
| Q1 | 普通上门服务的「已预约」何时进入 | 目前 `status` 只能由 `pending→serving→completed`；没有「预约」动作 | 加一个轻量 `archiveSchedule`（设 `planned_date` 并置 `scheduled`）？还是保持最小实现 |
| Q2 | 暖通工程是否也需要「完成日期」以外的整体完工时间 | 目前 `accept` 完成时用 `COALESCE(completed_at, now())` | 若业务要求"验收日期"独立于阶段日期，需加列 |
| Q3 | 撤回后是否允许把已撤回阶段的照片一并作废 | 目前照片保留且仍可被客户看到（若已发布） | 建议撤回时把该阶段照片 `published=false`，待确认 |
| Q4 | 照片 "已发布" 的判定口径 | 目前是照片行上的 `published` 布尔，需与档案 `visibility=published` 组合 | A4 落地时统一为"档案已发布 AND 照片 published AND 阶段 done" |

> Q1/Q3 会**改变行为**，所以没有自行决定；其余是 A4 的落地细节。
