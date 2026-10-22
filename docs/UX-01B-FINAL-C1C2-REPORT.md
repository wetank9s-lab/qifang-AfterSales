# UX-01B-FINAL C1/C2 安全准备报告

> 日期：2026-10-21 · **C1 PASS · C2 PASS · Gate 2：READY FOR AUTHORIZATION**
> 本轮未在 `service_ticket` 主库创建/删除/修改任何业务记录，未 commit / push。

---

## 1. 关联表与外键关系（实测）

**数据库里没有任何外键约束**（NocoBase 由应用层维护关系）。所以改用 `ticket_id` / `visit_id` 列反查：

| 表 | 关联列 | 是否本次清理 | 说明 |
|---|---|---|---|
| `service_tickets` | — | ✅ 主表 | |
| `ticket_events` | `ticket_id` | ✅ | 工单事件 |
| `service_visits` | `ticket_id` | ✅ | 派工/上门 |
| `service_visit_photos` | **`visit_id`** | ✅ | 技师照片（含 `storage_key`）——**必须先于 visits 删** |
| `customer_medias` | `ticket_id` | ✅ | 客户媒体（含 `storage_key`） |
| `customer_media_sessions` | `ticket_id` | ✅ | 上传会话 / Token |
| `sms_logs` | `ticket_id` | ✅ | 短信留痕（mock 也写） |
| `historical_ticket_conversions` | `ticket_id` | ❌ **保留** | 历史转单审计，不该为"数字对齐"抹掉 |

**其余相关表**（`service_visit_photos` 之外）：`service_settings`（配置，不按 ticket 删）、`historical_*`（BE-02A 域，不动）。

**没有** `serviceAlerts` / `reviews` / `dispatch` 之类独立表 —— 评价与 SLA 均为**计算项**，不落库（见 C2）。

---

## 2. 新清理脚本

**位置**：`scripts/purge-ux01b-ticket.mjs`（**新增**，未改动任何旧脚本）

### 用法

```bash
# 1) 默认 dry-run（只读）
node scripts/purge-ux01b-ticket.mjs --ticket-id=6901 --run-id=UX01B42 --expect-store=S01

# 2) 真正执行（必须再带 --yes）
node scripts/purge-ux01b-ticket.mjs --ticket-id=6901 --run-id=UX01B42 --expect-store=S01 --apply --yes

# 3) 隔离验证（只允许 *_verify* 库名，且必须声明）
node scripts/purge-ux01b-ticket.mjs --db=xxx_verify --verify-isolated --ticket-id=9001 --run-id=X --expect-store=S01
```

### 安全闸门（少一条都不执行）

| # | 闸门 | 实测 |
|---|---|---|
| 1 | **默认 dry-run**，`--apply` 才写 | ✅ |
| 2 | **拒绝 `id>=` / 范围删除** | ✅ 报「本脚本不接受 `id>=`」 |
| 3 | 只接受**单个 `--ticket-id`** | ✅ 缺参即拒 |
| 4 | 必须给 `--run-id` + `--expect-store` | ✅ 缺即拒 |
| 5 | **客户名必须包含 `--run-id`**（证明是合成数据） | ✅ 真实工单 35（客户「张三」）+ 假 run-id → **拒绝** |
| 6 | `store_id` 必须等于 `--expect-store` | ✅ 不符即拒 |
| 7 | 删前列出**每表行数 + 文件清单** | ✅ |
| 8 | 有非本次记录 ⇒ 停 | ✅ 交叉守卫 |
| 9 | 文件路径必须在 `uploads-private/customer/` 内 | ✅ 越界即拒 |
| 10 | `--db` 只允许 `*_verify*` 且必须 `--verify-isolated` | ✅ `--db=foo` → 拒绝 |

---

## 3. 隔离模拟验证（`ux01b_verify` 库）

**构造**：1 张合成单（9001，客户名含 `UX01BVERIFY`）+ 1 张真实对照单（9002，客户「张三」）+ 6 张关联表数据 + 1 条 `historical_ticket_conversions`。

### dry-run 输出

```
工单      : #9001 V-TEST-9001（NEW）
客户名    : 合成UX01BVERIFY客户
归属      : store_id=1（S01）✓
· ticket_events               2 行
· service_visits              1 行
· service_visit_photos        1 行
· customer_medias             2 行
· customer_media_sessions     1 行
· sms_logs                    1 行
⚠️ historical_ticket_conversions: 1 行 —— 历史转单记录（不在本次清理范围）

DRY-RUN 结束：未改动任何数据。
```

### apply 结果

| 表 | 清理前 | 清理后 |
|---|---|---|
| service_tickets | 2（9001+9002） | **1（只剩 9002）** ✅ |
| ticket_events | 2 | **0** |
| service_visits | 1 | **0** |
| service_visit_photos | 1 | **0** |
| customer_medias | 2 | **0** |
| customer_media_sessions | 1 | **0** |
| sms_logs | 1 | **0** |
| **historical_ticket_conversions** | 1 | **1（保留）** ✅ |

**关键**：真实对照单 **9002 完好无损**；审计表**没被碰**。

验证完把 `ux01b_verify` 库 drop 了（不留残库）。

---

## 4. 物理文件安全方案

**问题**：数据库事务回滚不了文件系统。

**方案（三段式）**：

1. **先搬不删**：把本次涉及的 `storage_key` 对应文件 `mv` 到
   `storage/.purge-quarantine/<runId>/`
2. **再跑 DB 事务**：一条 `begin ... commit`
3. **成功才真删**：事务提交后 `rm -rf` 该 quarantine 目录

**失败处理**：
- 文件搬迁中途失败 ⇒ **把已搬的搬回去**，然后中止
- DB 事务失败 ⇒ **把文件搬回原位**，拒绝继续
- quarantine 删除失败 ⇒ 只提示，不影响业务（可手工清）

**路径守卫**：每个文件绝对路径必须 `startsWith('/app/nocobase/storage/uploads-private/customer/')`，否则拒绝整个操作。

---

## 5. C2：SLA 扫描的真实影响

**源码**：`server/services/sla-scan-scheduler.ts`

| 问题 | 答案（源码实测） |
|---|---|
| 执行频率 | **`*/5 * * * *`（每 5 分钟）** |
| 修改哪些工单字段 | **无** —— 文件内 `.update(` / `.insert(` / `.destroy(` / `create(` 出现次数 **= 0** |
| 是否创建 `serviceAlerts` 等派生记录 | **不创建**（且库里根本没有 alert 表） |
| 是否产生关联事件 | **不产生**（没有写 `ticket_events`） |
| 是否触发通知/后续任务 | **不触发** —— 只有 `logger.info/warn/error`，无 `emit` / `notify` / `sendSms` / webhook |
| 测试工单是否立即进入扫描范围 | **会**被读到（它扫全部在途单），但**只读**，不产生任何写 |
| 扫描期间精确清理是否有竞态 | **无写竞态**（扫描只读；清理是写）。唯一影响是扫描可能在那一瞬间读到"即将被删"的单，读到就算，下次就没了 |
| 派生记录如何清理 | **无需清理**（不产生） |
| 能否隔离 | 不需要隔离 —— 它不写库 |

**结论**：SLA 扫描对测试工单的**唯一影响是日志里多几行**。**C2 PASS**，且**不需要改任何配置、不需要关闭扫描**。

---

## 6. 主库基线复核（本轮结束后）

| 表 | 本轮开始 | 本轮结束 | |
|---|---|---|---|
| service_tickets | 489 | **489** | ✅ |
| ticket_events | 1827 | **1827** | ✅ |
| service_visits | 279 | **279** | ✅ |
| customer_medias | 551 | **551** | ✅ |
| customer_media_sessions | 725 | **725** | ✅ |

**完全没有变化** —— 本轮所有操作都在隔离库或只读查询里完成。

`storage/.purge-quarantine/` 只剩一个空目录（验证时创建），无残留文件。

---

## 7. 剩余风险

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **真机摄像头/麦克风录制仍未验证** | Gate 3 继续 PENDING；只做受控文件选择链路 |
| 2 | `service_visit_photos` 的物理文件本轮**没实测搬迁**（隔离库里没真实文件） | 搬迁逻辑与 `customer_medias` 同一段代码；Gate 2 会带真实文件走一遍 |
| 3 | 清理脚本假设 `storage_key` 形如 `customer/<id>/<file>` | 已加路径守卫，不符即拒（宁可不删） |
| 4 | 若测试中途中断，可能留下"工单在、媒体没传完"的半状态 | Gate 2 按"先建单 → 后传媒体"顺序执行，中断时按 ticketId 整体清 |

---

## 8. 判定

### C1：**PASS**
清理脚本已建、十道闸门全部实测生效、隔离库完整验证（合成单清空 + 真实对照保留 + 审计表不动）。

### C2：**PASS**
SLA 扫描**纯读不写**、每 5 分钟、无派生记录、无通知、无竞态。

### Gate 2：**READY FOR AUTHORIZATION**

**申请下一次写入授权**，计划（最小量）：

| 项 | 数量 |
|---|---|
| 报修单 | 1（S01） |
| 投诉单 | 1（S01 或 S02） |
| 媒体 | 每类各 1，共 4 个（受控文件选择） |
| run-id | `UX01B42` 形式，写进客户名 |
| 清理 | `purge-ux01b-ticket.mjs --apply --yes`，逐张 |
| 真机采集 | **仍 PENDING** |

**不自行启动 Gate 2。**

---

## 9. 本轮改动文件

| 文件 | 类型 |
|---|---|
| `scripts/purge-ux01b-ticket.mjs` | **新增**（清理工具） |
| `docs/UX-01B-FINAL-C1C2-REPORT.md` | 新增（本报告） |

**未改**：`uat-reset-baseline.mjs`、`uat-sweep-noise.sql`（按要求不碰）、所有业务代码、H5 视觉文件。
