# 安全设计

> 对照文档 §11、§18、§21.7、§29「禁止事项」逐条落地。

---

## 1. 威胁模型与对策总表

| 威胁 | 对策 | 落地位置 |
|---|---|---|
| 匿名用户直接访问 NocoBase 管理 API | 仅 8 个自定义 action 标 `allowAnonymous: true`；原生 CRUD 对匿名角色**全部关闭** | 插件 `load()` 的 ACL 配置 |
| 用管理员 Token / API Key 放前端 | 前端只调 `/api/public/*`、`/api/technician/*`；**服务端不签发任何长期凭据给浏览器** | 架构约束 + Code Review |
| Token 被猜测/枚举 | 32 字节 CSPRNG → base64url(43)；DB 只存 SHA-256；唯一索引查表；失败统一 `TOKEN_INVALID` | `TokenService` |
| Token 重放 | 单次使用（`token_used_at`）；有效期；改派/改约强制失效 | `TokenService` + M4/M5/M8 |
| 越权查看其他门店 | ACL 数据范围 + `storeScope` 中间件强制注入；对象级 `assertTicketAccess` | `PermissionService` / `middlewares/storeScope` |
| 前端隐藏冒充数据隔离 | 所有列表接口服务端过滤；前端仅做展示 | 同上 |
| 用自增 ID 当匿名凭证 | 匿名接口入参只接受 `token`；响应**永不返回**内部 `id` | DTO |
| 公开表单刷单 | IP 限流 + 手机号日限 + 重复单识别 + `request_id` 幂等；Nginx `limit_req` 兜底 | `GuardService` + `nginx/conf.d` |
| 手机号泄露 | 列表默认 `138****8888`；完整号码按角色；导出仅总部；应用日志不写号码 | 序列化层 DTO |
| 图片永久公开 URL | 私有存储 + 受控读取端点 + 10 分钟短时签名 URL | `FileService` |
| 上传非图片/超大文件 | magic bytes 真实类型校验 + 数量/大小上限 + 去 EXIF 重编码 | `FileService` |
| SQL 注入 | 全部走 Repository/Sequelize 参数化；唯一原生 SQL（取号）已参数化 | `SequenceService` |
| XSS | Vue 默认转义；禁止 `v-html`；超长文本截断渲染 | `h5/src` |
| CSV / 公式注入 | 导出时以 `= + - @` 开头的单元格前置 `'` | 导出服务 |
| 短信回执伪造 | 按 provider 验签（阿里云 HMAC-SHA1 / 腾讯云签名）+ `provider+biz_id` 幂等 | `actions/callback` |
| 短信密钥泄露 | AK/SK 只在 `.env`；不进 Git、不进前端、不进可被前端读取的表 | 部署规范 |
| 重复短信轰炸 | 状态前置校验（乐观并发）+ 场景白名单 + 重发限频 | `TicketService` |
| 备份泄露 | `pg_dump` 加密 + `backups/` 权限收紧 + 恢复演练 | `scripts/` |
| 日志泄露敏感信息 | 结构化日志脱敏中间件；traceId 关联 | 日志工具 |

---

## 2. 认证与授权

### 2.1 三类主体
| 主体 | 认证方式 | 授权方式 |
|---|---|---|
| 内部用户（门店/总部） | NocoBase 登录（JWT） | NocoBase ACL 角色 + 数据范围 + 插件 `storeScope` |
| 客户（匿名） | 无（可选：评价 Token） | 仅能创建工单；评价仅限自己的 Token |
| 师傅（匿名） | 一次性 Visit Token | 仅本次 Visit 的读取/上传/提交 |

### 2.2 角色定义
| 角色 | 数据范围 | 备注 |
|---|---|---|
| `store_after_sales` | 仅 `storeUsers` 授权门店 | 主力操作角色 |
| `hq_after_sales` | 全部门店 | 可重开、强制转店 |
| `hq_admin` | 全部 + 系统设置 | 用户/门店/参数/导出 |
| `viewer` | 全部只读 | 手机号默认脱敏 |

### 2.3 双层数据隔离
```
请求 → ACL 中间件（角色 + 数据范围）
     → storeScope 中间件（兜底：对业务集合强制注入 store_id ∈ 用户授权门店）
     → PermissionService.assertTicketAccess(user, ticketId)  ← 对象级（防 IDOR）
     → Service（业务逻辑）
```
- 总部角色（`hq_*`）在 `storeScope` 中跳过注入。
- `storeScope` 集合白名单：`serviceTickets`、`serviceVisits`、`serviceVisitPhotos`、`ticketEvents`、`smsLogs`。
- 命中越权时返回 `403 FORBIDDEN_SCOPE`，并记录 `security` 级别日志（含 userId、ticketId、traceId）。

---

## 3. 字段级只读（防止绕过 Service 层改状态）

以下字段由 ACL 设为**任何人不可通过原生 update 修改**：
`serviceTickets`：`ticket_no` `status` `escalated` `reopen_count` `feedback_token_hash` `feedback_token_expires_at` `feedback_token_used_at` `dispatch_at` `completed_at` `closed_at` `first_response_at` `review_status` `rating`
`serviceVisits`：`access_token_hash` `token_expires_at` `token_used_at` `visit_no` `submitted_at` `store_confirm_status`
`serviceVisitPhotos`：`storage_key` `file_id`

---

## 4. Token 规范（`TokenService`）

```ts
generate(kind: 'technician' | 'review', binding: Binding): Promise<{ token: string; expiresAt: Date }>
verify(kind, rawToken): Promise<Binding>          // 不通过抛 TOKEN_INVALID
consume(kind, rawToken): Promise<Binding>         // 事务内校验并置 used_at（原子）
invalidate(kind, binding): Promise<void>          // 改派/改约时调用
```

规则
1. 明文仅出现在：生成时返回给 SmsService 拼链接、以及浏览器 URL。**不写日志、不入库、不入事件 metadata**。
2. 入库 `sha256(token)`（hex 小写 64 位）。
3. `consume()` 用条件更新保证原子：`UPDATE ... SET token_used_at = now() WHERE id = $1 AND token_used_at IS NULL`，影响行数 0 即已用过。
4. 过期判断在 SQL 条件内（`now() <= token_expires_at`），不依赖应用时钟比较。
5. 短链可读性 vs 安全性：URL 形如 `/technician/visit/<43字符token>`；**不使用 ticket id / visit id 作为路径参数**。

---

## 5. 匿名文件上传安全（`FileService`）

| 环节 | 措施 |
|---|---|
| 入口 | 仅 `POST /api/technician/visits/:token/files`；先 `TokenService.verify`，Token 无效直接 401 |
| 归属 | 校验 Visit 存在、`token_used_at IS NULL`、`store_confirm_status='pending'` |
| 数量 | `count(photos by visit_id) + 本次 ≤ visit.photo_max_count`（默认 6）；单次请求只允许 1 个文件 |
| 大小 | ≤ `visit.photo_max_size_mb`（默认 5MB），流式解析，超限立即中断连接 |
| 类型 | **magic bytes 嗅探**（`file-type`），白名单 `image/jpeg|png|webp`；拒绝 SVG（XSS 载体） |
| 内容 | `sharp` 重编码（长边 ≤1600，质量 0.82）→ **EXIF/GPS 全部剥离** |
| 存储 | 落盘到私有目录（非 Nginx 静态路径），文件名 = `sha256(random + visitId + time)` + 安全扩展名 |
| 元数据 | `serviceVisitPhotos.storage_key` 保存相对路径；该字段对所有角色只读 |
| 读取 | `GET /api/svc/photos/:photoId`：校验登录 + 门店范围 → 流式返回；或短时签名 URL（`exp` + `sig=HMAC(photoId|exp|SECRET)`，10 分钟） |
| 禁止 | 不生成任何永久公开 URL；不在响应里回显存储路径 |

---

## 6. 限流与防刷（`GuardService`）

实现：DB 表 `apiGuards`（跨重启可靠）+ 进程内 LRU 快缓存（降低 DB 压力）。

| 场景 | 维度 | 默认阈值 | 配置键 |
|---|---|---|---|
| 公开接口 | IP | 30/分钟 | `security.ip_minute_limit` |
| 创建工单 | 手机号 | 5/日 | `security.ticket_phone_daily_limit` |
| 创建工单 | 重复单 | 同手机号+门店+类型+**同事项文本**（`normalizeContent` 归一化后相等），10 分钟内拒绝并回原单号；排除 `CANCELLED` | `security.duplicate_window_minutes` |
| 创建工单 | 幂等 | `X-Request-Id` 唯一 | — |
| 师傅接口 | Token | 60/小时 | `security.technician_token_hourly_limit` |
| 评价接口 | Token | 20/小时 | 同上（复用） |
| 短信重发 | 工单 | 同场景 5 分钟内 1 次 | 代码常量 + 配置 |
| Nginx 兜底 | IP | `limit_req zone=public burst=20 nodelay` | nginx conf |

超限返回 `429 RATE_LIMITED` + `Retry-After`。

> ⚠️ **实例数前提（DEV-37）**：`X-Request-Id` 的并发互斥是**进程内**串行锁
> （`Map<scene:request_id>`），且 `ticket_no` 的取号发生在**业务事务之前**。
> 这两点只在**单 app 实例**下成立。
> **「当前版本按单 NocoBase 应用实例运行。未经专门改造不得直接横向扩为多个 app replica。
> 多实例部署前必须重新验证 `request_id` 幂等竞态和 `ticket_no` 无空洞性质。」**

---

## 7. 隐私与合规

- H5 首屏展示**个人信息处理说明**：收集目的（售后履约）、范围（姓名、手机号、服务照片）、保存期限（默认 24 个月）、联系方式；提交前必须勾选 `privacy_agreed`。
- 最小必要：第一版**不收集**地址、品牌、型号、SN、购买日期、销售单号。
- 脱敏：列表 `138****8888`；详情按角色；`viewer` 一律脱敏；导出仅总部。
- 保留策略：`privacy.retention_months`（默认 24）；到期任务对超期数据进行删除或匿名化（姓名置"已匿名"、手机号置空、照片删除），保留工单统计事实。
- 照片去 EXIF（含 GPS），不做地理位置留痕。
- 日志：不写姓名/手机号明文；`upload_ip_hash` 亦为加盐哈希。

---

## 8. 部署安全基线

| 项 | 要求 |
|---|---|
| HTTPS | 强制 301 跳转 + HSTS（`max-age=31536000; includeSubDomains`） |
| 端口暴露 | 对外仅 443；`app:13000`、`postgres:5432` 仅内网 `expose`，不 `ports` 映射 |
| 密钥 | `.env`（`chmod 600`），`.gitignore` 排除；生产用独立强随机 `APP_KEY` |
| DB 账号 | 非 `postgres` 超级用户；仅授予业务库所需权限 |
| 备份 | 每日 `pg_dump` + 上传目录打包；加密存储于 `backups/`；保留 30 天；**每月恢复演练** |
| 日志 | 轮转；保留 ≥90 天；错误日志含 traceId |
| 依赖 | 锁定镜像 tag（NocoBase `2.1.x` 具体版本，不用 `latest`）；定期升级并回归 |
| 审计 | 关键动作（导出、改参数、重开、强制转店）写 `ticketEvents` + 应用审计日志 |
| **应用实例数** | **单实例**（当前只有 `svc-app` 一个 replica）。同 `request_id` 的互斥依赖进程内锁、取号发生在事务外 —— **横向扩容前必须重新验证幂等竞态与工单号无空洞性质**（详见 DEV-37） |

---

## 9. 与文档 §29「禁止事项」的逐条对照

| 禁止项 | 本设计的防线 | 状态 |
|---|---|---|
| 管理员 Token 写进 H5 | 前端只有 8 个匿名接口；不签发长期凭据 | ✅ |
| 数据库密码写进代码 | `.env` only + `.gitignore` | ✅ |
| 匿名用户访问 NocoBase 管理 API | 匿名角色对原生资源全禁 | ✅ |
| 图片永久 public | 私有存储 + 受控端点 + 短时签名 | ✅ |
| Token 明文存数据库 | `*_token_hash` = SHA-256 | ✅ |
| 自增工单 ID 作匿名凭证 | 凭证只用 Token；响应不返回 id | ✅ |
| 门店数据只在前端过滤 | ACL + storeScope + 对象级鉴权 | ✅ |
| 师傅提交后直接关闭工单 | M8 只到 WAIT_STORE_CONFIRM | ✅ |
| 低评分后仍直接 CLOSED | M13 强制 PROCESSING + escalated | ✅ |
| 收费不一致但不触发异常 | M13 同分支拦截 | ✅ |
| 覆盖旧 ServiceVisit | 一律新建，`unique(ticket_id,visit_no)` | ✅ |
| 覆盖历史照片 | 照片挂 Visit，永不删除/覆盖 | ✅ |
| 用 paid NocoBase 插件但不说明 | 明确锁定 Community + Apache-2.0 | ✅ |
| 短信"调用成功"当作"客户收到" | 强制接入回执，语义为 `accepted ≠ delivered` | ✅ |
| 擅自增加 ERP/库存/商品/SN/财务逻辑 | 明确不做清单（PHASE-0 §1.2） | ✅ |
