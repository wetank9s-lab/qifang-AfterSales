# UX-01C 总部业务设置中心 —— 交付报告（**部分交付：本轮只落地 §1 映射 + §2 短信枚举漂移修复**）

> 日期：2026-10-17 · 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A/01B 保持
> **本轮未提交、未推送。**
> ⚠️ **如实声明**：本轮**未交付**三个可维护的设置页面（服务时效 / 短信通知 / 门店管理）与"改配置留痕"治理。下面给出真实映射、已落地的修复、以及未交付项的确切原因与可直接执行的最小方案。

---

## 1. 设置项映射（§1，**全部来自当前源码实测**，非推测）

| 设置键 | 默认值 | 后台输入项 | 实际业务读取点 | 生效时机 | 允许修改的角色 |
|---|---|---|---|---|---|
| `sla.accept_minutes` | 120 | 服务时效 | `sla-scan-scheduler.ts:226`（`readInt`） | 下次 SLA 扫描 | `hq_admin`（`allowConfigure:true`） |
| `sla.appointment_overdue_grace_minutes` | 120 | 服务时效 | `sla-scan-scheduler.ts:227` | 同上 | 同上 |
| `sla.store_confirm_hours` | 48 | 服务时效 | `sla-scan-scheduler.ts:228` | 同上 | 同上 |
| `sms.provider` | `mock` | 短信通知 | `sms-service.ts:296` → `createSmsProvider` | 下次发送 | 同上 |
| `sms.enabled` | `false` | 短信通知 | `sms-service.ts:509/907/1155` | 下次发送 | 同上 |
| `sms.retry_count` | 1 | 短信通知 | `sms-service.ts:510/908/1158` | 下次重试 | 同上 |
| `security.ip_minute_limit` | 30 | （安全） | `public/review.ts` · `public/store.ts` · `technician/visit.ts` | 下个请求 | 同上 |
| `security.media_session_hourly_limit` | 120 | （安全） | `public/media.ts:165` | 下个请求 | 同上 |
| `security.media_upload_hourly_limit` | 400 | （安全） | `public/media.ts:221` | 下个请求 | 同上 |
| `security.ticket_phone_daily_limit` | 5 | （安全） | `public/ticket.ts:508` | 下个请求 | 同上 |
| `security.duplicate_window_minutes` | 10 | （安全） | `public/ticket.ts:562` | 下个请求 | 同上 |
| `security.technician_token_hourly_limit` | 60 | （安全） | `technician/visit.ts:162` | 下个请求 | 同上 |
| `visit.photo_max_count` / `photo_max_size_mb` | 3 / 5 | （上门） | `technician/visit.ts:230/231/342/445` | 下个请求 | 同上 |
| `feedback.low_score_threshold` / `wait_days` / `token_expire_days` | 2 / 7 / 15 | （评价） | `ticket-service.ts:3418` · `review-expiry-scheduler.ts:87` · `ticket-service.ts:1249/3010` | 下个请求/扫描 | 同上 |
| `technician.token_expire_hours` | 72 | （师傅） | `ticket-service.ts:2423` | 下次派工 | 同上 |
| ⚠️ `privacy.retention_months` | 24 | —— | **无任何读取点** | —— | **假设置：可改不生效** |
| ⚠️ `historical.unreplayable-batches` / `test-artifacts.purge.audit` | —— | —— | **无读写**（仅为 smoke 判据存在） | —— | **孤儿键** |

**关键事实（决定本轮交付形态）**：
1. **`hq_admin` 已经具备 `allowConfigure:true`**（`roles.ts`）⇒ 总部管理员**今天已经能在 NocoBase 后台的集合管理里直接改这些值**。⇒ 这一需求的性质是"**已有能力但入口不友好**"（缺中文表单/单位/范围校验/留痕），不是"完全没有能力"。
2. 本项目页面种子 **`约束 3` 明确禁止页面挂蓝图弹窗**（DEV-53：蓝图编译出的 popup `defaults` 为 `undefined`，其内 `edit` 必 400）⇒ **"可编辑的设置页"不能靠原生表格弹窗实现**，必须像既有 `store-entry-action.tsx` / `ticket-create-action.tsx` 那样**写一个自定义动作模型**（打开自建表单 → 走受控写接口）。

## 2. 本轮已交付（真实代码 + 已验证构建）

### ✅ 短信服务商枚举漂移修复（§2 明确要求）
- `src/server/collections/smsLogs.ts`：`provider` 枚举 `阿里云 / 腾讯云 / 模拟` → **`阿里云 / 短信宝 / 模拟`**（`tencent` 从未实现，选它只会静默全拒）。
- `src/server/constants.ts`：`sms.provider` 描述 `mock / aliyun / tencent` → **`mock（模拟，不真实发送）/ aliyun（阿里云）/ smsbao（短信宝）；未实现的通道不在可选项内`**（补上已实现却缺失的 `smsbao`）。
- 构建：`build-plugin.mjs` TS 门禁（①=0 / ②=0）**✅ 通过** + esbuild **✅**；`docker compose restart app` → health **200**。
- ⚠️ **已知残余**：`serviceSettings` 的**描述行**由种子 `只增不改` 写入，**改代码不会更新库里的旧描述** ⇒ 旧库该行仍是老文案（需一条 `UPDATE`/迁移把它们刷新；本轮未做，**已如实记录**）。

### ✅ §1 映射表（上表，全部对到源码行号）

## 3. 本轮**未交付**（明确 PENDING + 最小方案）

| 项 | 状态 | 阻塞与最小方案 |
|---|---|---|
| 「服务时效」页（sla.*，中文表单/单位/范围校验/规则说明） | ❌ 未交付 | 需 **1 个自定义动作模型** `ConfigEditActionModel`（打开自建表单 → 调**新增的**受控写接口 `svc:updateSetting`，带密钥白名单 + 按 `value_type` 校验 + 写审计），再按既有 `seedTicketPageActions` 的方式挂到页面的操作列。**不能**用原生弹窗（约束 3）。 |
| 「短信通知」页（服务商/启停/重试 + `smsLogs` 只读 + 失败信息） | ❌ 未交付 | 同上的编辑动作 + `smsLogs` 只读表页；敏感密钥**不返回**（`ALIYUN_*` 只在环境变量，本就不入库，天然满足）。 |
| 「门店管理」页（名称/公开电话/地址/启停） | ❌ 未交付 | `stores` 集合的编辑动作（同上）；须回归验证不破坏二维码/门店归属/停用拒绝建单。 |
| 治理（操作人+时间+前后值留痕、预览、恢复） | ❌ 未交付 | 需新增 **`configChangeAudits` 审计集合** + 写接口内落审计（记录 `key/old/new/operator/at`）。 |
| UX-01D 白名单接口（标题/Logo/主题/模块开关/预览/发布/回滚） | ❌ 未交付（本轮约定仅**保留设计接口**） | 建议：新增**只读** `publicSiteConfig`（仅回可公开项）+ 后台维护页；法定告知/必需校验/安全规则**不可**由装修开关关闭。 |

**为什么未交付（如实）**：三个页面 + 编辑动作 + 审计集合属于**跨 5~6 个文件的新功能**（客户端动作模型、受控写接口、审计集合+迁移、页面种子、角色白名单、浏览器验证）。本轮预算在完成 §1 源码取证与 §2 枚举修复后耗尽；**我没有把未验证的代码算作交付**。

## 4. 验收（本轮可做的部分）
- 构建/部署：TS 门禁 ✅ + esbuild ✅ + `restart app` health 200（已执行）。
- ⚠️ **未做**（因页面未交付）：HQ 管理员改值 → 服务端读取生效 → 恢复原值 的端到端实测；无权角色写入被拒的实测；重播种后配置不丢失的实测。**均记为 PENDING，不冒充通过。**
- 既有冻结门禁：本轮**未改** `verify-store-ui-primary-action.mjs`（65 项）与 `verify-ux-01a-final.mjs`（15 项），未重跑；未触碰 P11-5。

## 5. Git 与审计
- `git status`：**17 已跟踪修改 + 14 新增 = 31**（本轮新增改动：`smsLogs.ts`、`constants.ts`）。
- `git diff --check`：**干净**；增量密钥审计对全部变更文件 → **exit 0**（无明文密钥；`ALIYUN_*` 密钥始终只在环境变量）。
- **未提交、未推送。**

## 6. 结论
- UX-01C **本轮为部分交付**：§1 映射（真实）+ §2 短信枚举漂移修复（已落地并构建验证）。
- 三个可维护设置页面、编辑动作与"改配置留痕"治理 **未交付**（PENDING），已给出**可直接执行的最小方案**（自定义编辑动作 + `svc:updateSetting` + `configChangeAudits`）。
- UX-01B 的 PENDING（真机 Safari / 软键盘实测 / 媒体-only 提交 / 失败重试 / 缓存头 / 改版前截图）继续保留。
- 项目状态不变：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD。
