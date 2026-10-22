# DEV-209 专项修复报告：客户进度页时间恒为「—」

> 日期：2026-10-19 · 状态：**DEV-209 已修**（用户授权专项修复）
> UX-01D M1 **PASS/FROZEN** · UX-01C **PASS/FROZEN** · UX-MEDIA-01 **PASS/FROZEN** · P11-5 **PASS/FROZEN** · P11-4 原 PENDING 保留 · Phase 11 IN PROGRESS · **Release HOLD**
>
> 未 commit / 未 push。**未碰** B-20 / B-21 / B-22 / B-26；未改 UX-01D M1 的任何已冻结功能。

---

## 一、结论

根因**与登记一致**：`progress-service.ts` 读的是 **snake_case 列名** `t.created_at` / `p.created_at`，
而 NocoBase 模型 `toJSON()` 的系统时间字段是 **驼峰属性名** `createdAt` / `updatedAt`
⇒ 取到 `undefined` ⇒ 被 `JSON.stringify` 丢弃 ⇒ 前端 `fmt(undefined)` 显示「—」。

**最小修复**：两处映射改成 `createdAt ?? created_at` / `updatedAt ?? updated_at`。
**声明的接口字段契约**一个没加（源码里仍是那 14 个键）；Token 权限边界**一处没动**，页面结构**一行没改**。
> ⚠️ 必须区分两件事：**契约没变** ≠ **运行态 JSON 没变**。修复前 `created_at`/`updated_at`/`timeline[].at`
> 因为取到 `undefined` 被 `JSON.stringify` **省略**；修复后它们**真的出现在 JSON 里**（这正是修复目标）。

---

## 二、只读取证（先证后改）

### 2.1 数据库里确实有值

| 查询 | 结果 |
|---|---|
| `select created_at from service_tickets where id=6770` | `2026-10-19 11:44:20.894+08` |
| `select created_at from ticket_events where ticket_id=6770 order by created_at limit 1` | `2026-10-19 11:44:20.896+08` |

### 2.2 模型 `toJSON()` 输出的是驼峰

用后台只读接口（`svc:timeline`）读同一张单，观察键名：

```
ticket keys:  createdAt, updatedAt, closed_at      ← 系统字段驼峰；自定义字段仍 snake
ticket createdAt = 2026-10-17T10:16:25.478Z   created_at = undefined
event  keys:  createdAt
event  createdAt = 2026-10-17T10:16:25.482Z   created_at = undefined
```

> `closed_at` 正常、`created_at` 恒 undefined —— 这正是"**只有系统时间列读错名**"的反证。

### 2.3 修复前的接口响应

```
HTTP 200
keys = ticket_no, store_name, status, status_label, closed_at,
       submitted, media, timeline, completion_note, review, queryable_until, closed
created_at = undefined     updated_at = undefined
timeline[0] = {"status":"NEW","status_label":"待处理"}     ← 没有 at
```

### 2.4 修复前的页面

截图 `.tmp-verify/dev209-before.png`：门店卡下「提交时间 —」，时间线「待处理 —」。

---

## 三、修改点（只有一个文件、两处映射）

`nocobase/plugins/service-ticket/src/server/services/progress-service.ts`

```diff
-        at: p.created_at,
+        // DEV-209：系统时间字段属性名是驼峰（createdAt/updatedAt），DB 列才是 created_at
+        at: p.createdAt ?? p.created_at,

-        created_at: t.created_at,
-        updated_at: t.updated_at,
+        created_at: t.createdAt ?? t.created_at,
+        updated_at: t.updatedAt ?? t.updated_at,
```

**刻意没做的事**：

- ❌ 没在前端 `fmt()` 里"兜住 undefined"（那只是把缺陷藏起来，接口仍然是坏的）；
- ❌ 没新增 `createdAt` 等字段（避免扩大公开响应面）；
- ❌ 没改排序、Token 校验、媒体读取、页面结构与样式。

---

## 四、修复后的接口与页面

```
HTTP 200
created_at = 2026-10-19T03:44:20.894Z
updated_at = 2026-10-19T03:44:20.894Z
timeline  = [{"status":"NEW","status_label":"待处理","at":"2026-10-19T03:44:20.896Z"}]
```

**声明的字段契约**没有增加（仍是那 14 个键）；但**运行态 JSON 的键集合确实变了**：
修复前 `created_at` / `updated_at` 被省略、`timeline[].at` 不存在；修复后这三个位置都有值。
这是**修复的目标**，不是"扩大公开面"。修复后实际键集合：

```
closed, closed_at, completion_note, created_at, media, queryable_until,
review, status, status_label, store_name, submitted, ticket_no, timeline, updated_at
```

### 4.1 取证工单对照（**三张不同的隔离夹具**，不是同一张单）

| 工单号 | 用途 | 数据库 `created_at` | 接口 / 页面 | 现状 |
|---|---|---|---|---|
| `FW20261019-0001`（id 6770） | 修复前只读取证 | `2026-10-19 11:44:20.894+08`（事件 `…896+08`） | 接口 `created_at=undefined`；页面「—」（`dev209-before.png`） | 已按 ID 清理 |
| `FW20261019-0002` | 门禁第 1 次运行 | `2026-10-19 11:46:05.281+08` | 接口 `2026-10-19T03:46:05.281Z`；页面 `11:46` | 已按 ID 清理 |
| `FW20261019-0004` | 门禁第 2 次运行（截图） | 同一轮断言内读取并与页面比对；**精确 DB 值随夹具清理未留存** | 页面 `11:47`（`dev209-after.png`） | 已按 ID 清理 |

> **为什么可以分属不同工单**：每一轮都用自己的夹具、拿**自己的 DB 行**做比对，
> 断言的是"页面时间 = 该工单的数据库时刻"，而不是"两张不同工单的时间相同"。
> 修复前后的对照则看**同一张** `FW20261019-0001`：修复前 API 缺字段、页面「—」；
> 修复后用门禁夹具重新验证（0002 / 0004）。
> 截图上的工单号（0004）与 §四开头的 API 样例（0001）**确实不是同一张** —— 这里如实标注。

> 截图里状态徽标仍是被拉伸的整行 —— 那是 **B-20**，按裁决保持独立、本次未改。

---

## 五、定向门禁（新增，内容级）

`scripts/verify-dev-209-progress-time.mjs` —— **20 / 20 通过**：

| 组 | 断言 |
|---|---|
| 接口内容 | `created_at`/`updated_at` 有值；可被 `new Date()` 解析；`created_at` 与 DB **同一时刻**（容差 2s）；`updated_at ≥ created_at` |
| 时间线 | 非空；每条 `at` 有值且可解析；**非递减**；首条 = 库内最早事件（容差 2s） |
| 边界 | 公开响应字段集合 = **声明契约的 14 个键**（防"顺手加字段"）；无效 / 篡改 Token 仍 **401** |
| 页面 | 「提交时间」不是「—」、格式 `YYYY-MM-DD HH:mm`、**等于 DB 时刻（Asia/Shanghai）**；时间线每条时间有值且格式合法 |
| 数据安全 | 隔离夹具（唯一手机号）**按 ID 清理**；`service_tickets` 总数清理前后一致（479 → 479，未触碰真实工单） |

### 反向验证（门禁真的会红）

把两处映射退回 `t.created_at` / `p.created_at` 并重建：

```
❌ created_at 有值（不是 undefined / 空串）
❌ created_at 可被 new Date() 解析
❌ updated_at 可被解析
❌ created_at 与数据库事实一致（容差 2s）
❌ updated_at ≥ created_at
❌ timeline 每一条都有可解析的 at
❌ 首条时间线时间 = 库内最早事件时间（容差 2s）
❌ 公开响应字段集合与 14 键契约不一致
（页面两条同步红）
```

还原后 **20/20 复绿**。

### 为什么旧门禁没抓到

`verify-progress-video.mjs` 只断言 `Array.isArray(timeline)` —— **只校验形状，不校验内容**。
本次新增的门禁补上了内容级判据；**旧门禁未改**（属冻结范围）。

---

## 六、关于 `verify-progress-video.mjs` 本轮的 10/14（如实说明，与 DEV-209 无关）

本轮为"定向回归"跑了一次该门禁，结果 10/14，4 条红：

| 红项 | 实际原因 |
|---|---|
| 关闭 29 天仍可查 / 31 天失效 / 未关闭不受限 | 第三步「未关闭」返回 **429**（同 IP 每分钟请求量被该门禁自身打满） |
| Token 可重复使用 | 三次查询全部 **429**（不是"Token 失效"，是请求被限流） |
| 撤销后 ⇒ 401 | 同样 **429** |
| log-format 子门禁 | 父脚本对该子门禁输出的解析失败；**单独运行 `verify-log-redaction.mjs` = 48/0** |

⇒ 4 条都不是 DEV-209 的行为变化，也**不是产品结论**：是同 IP 每分钟 30 次限额下该门禁请求量过大导致的环境失败。
**未修改该冻结门禁**，也未调整任何限流阈值。

---

## 七、Git 与密钥审计

- 改动：`progress-service.ts`（2 处映射）+ 新增 `scripts/verify-dev-209-progress-time.mjs` + 文档
  （`DEVIATIONS.md` 修复记录、`API.md` §1.6、`PROJECT-STATUS.md` 标记已修）。
- **未 commit / 未 push**；暂存区为空；`git diff --check` 干净。
- 密钥扫描（改动文件 + 新门禁）：**0 处硬编码凭证**；门禁从 `.env` 读 `SIGN_SECRET` 构造门店入口。
- 夹具：只读取证单 `FW20261019-0001`、门禁单 `FW20261019-0002` **均已按 ID 清理**
  （tickets/events/sms 全 0）；未发送真实短信。

---

## 八、边界确认

| 约束 | 结果 |
|---|---|
| 不修改真实客户工单 | ✅ 只操作自建夹具，总数清理前后一致 |
| 不扩大公开接口字段 | ✅ **声明契约**仍 14 键；运行态新增的只是原本被省略的三个时间值 |
| 不影响进度 Token 权限边界 | ✅ 无效/篡改仍 401；Token 校验代码未动 |
| 不顺手改 B-20/B-21/B-22 | ✅ 均未触碰 |
| UX-01D M1 / UX-01C / UX-MEDIA-01 / P11-5 | ✅ 已冻结功能未改 |
| Release | 仍 **HOLD** |
