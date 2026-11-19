# TECH-PHOTO-DELETE-STORAGE-01：持久化清理队列 —— 实施设计（未实施）

> 时间：2026-10-23 11:42–12:00 CST
> 状态：**本轮未写代码、未建表、未迁移、未部署**。只做了门禁核查 + 实施设计。
> 原因：本专项（表 + 迁移 + 消费者 + 事务重构 + S1–S16 含故障注入）超出本轮可稳妥完成的范围。
> **不交半截代码** —— 半接线的迁移/消费者比不做更危险。

---

## 1. 门禁核查（可复用，已确认）

| # | 条件 | 现状 |
|---|---|---|
| 1 | DB = `scqf_media_test` | ✅ |
| 2 | 媒体目录 `/opt/scqf-test-media` | ✅ |
| 3 | 独立插件目录 `/opt/scqf-media-test/plugin` | ✅（上一轮已拆开） |
| 4 | 不再共享生产插件产物 | ✅（compose 两处挂载已改） |
| 5 | 独立密钥/配置 | ✅ 独立 `.env.test` |
| 6 | `SMS_ENABLED=false` | ✅ |
| 7 | 未挂生产媒体 | ✅ |
| 8 | 生产 Nginx/容器/DB 未受影响 | ✅ |

---

## 2. 任务表设计（DDL）

```sql
CREATE TABLE pending_file_deletions (
  id            bigserial PRIMARY KEY,
  storage_key   varchar(512) NOT NULL,
  object_type   varchar(32)  NOT NULL DEFAULT 'technician_photo',
  status        varchar(16)  NOT NULL DEFAULT 'PENDING',   -- PENDING|PROCESSING|COMPLETED|RETRY|FAILED
  attempts      int          NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner   varchar(64),          -- 消费者实例标识（认领租约）
  lease_until   timestamptz,          -- 租约到期 ⇒ 可被重新认领（崩溃恢复）
  last_error    varchar(200),         -- **脱敏摘要**，不含 token/绝对路径
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

-- 幂等入队：同一 storage_key 未完成时不重复插入
CREATE UNIQUE INDEX uq_pfd_active_key
  ON pending_file_deletions(storage_key)
  WHERE status IN ('PENDING','PROCESSING','RETRY');

-- 认领扫描
CREATE INDEX ix_pfd_due ON pending_file_deletions(status, next_attempt_at);
```

**不写入**：师傅 Token、签名 URL、客户手机号、绝对路径。

---

## 3. 事务边界（deletePhoto 重构）

```ts
// actions/technician/visit.ts · deletePhoto
const trx = await db.sequelize.transaction();          // ① 开事务
try {
  const deleted = await services.visits.deletePhoto(id, trx);   // ② 删业务行（同一 trx）
  if (deleted) {
    await services.fileDeletions.enqueue({                       // ③ 同一 trx 入队
      storageKey: deleted.storage_key,
      objectType: 'technician_photo',
      transaction: trx,
    });
  }
  await trx.commit();                                            // ④ 一起提交
  // ⑤ 提交后再尽力同步清理一次（失败无所谓，任务还在）
  void services.fileDeletions.tryNow(deleted?.storage_key).catch(() => {});
} catch (e) {
  await trx.rollback();                                          // 入队失败 ⇒ 业务删除一并回滚
  throw e;
}
```

**硬约束**：
- 入队失败 ⇒ 业务删除**必须**回滚（上面 ③ 抛错即走 ②）；
- 事务内**不做**任何文件 I/O（只在 ⑤ 提交后）；
- 返回 `{deleted:true}` 时，DB 行消失 + 任务已持久化**两者都成立**。

---

## 4. 消费者（复用既有 cron 设施）

`services/file-deletion-scheduler.ts`，与 `registerSmsRetryJob` 同构，注册进 `index.ts` 的 `JOBS` 表：

```sql
-- 认领（并发安全：SKIP LOCKED + 租约）
WITH due AS (
  SELECT id FROM pending_file_deletions
   WHERE status IN ('PENDING','RETRY')
      OR (status='PROCESSING' AND lease_until < now())     -- 租约过期 ⇒ 崩溃恢复
   ORDER BY next_attempt_at
   LIMIT :batch
   FOR UPDATE SKIP LOCKED
)
UPDATE pending_file_deletions p
   SET status='PROCESSING', lease_owner=:owner, lease_until=now()+interval '2 minutes', updated_at=now()
  FROM due WHERE p.id = due.id
RETURNING p.id, p.storage_key, p.attempts;
```

处理循环：`removeByStorageKey(key)` →
- `deleted` / `absent` → `COMPLETED`
- `skipped`（仍有引用）→ `RETRY` + `next_attempt_at=+1h`，`last_error='referenced'`
- 异常 → `attempts+1`；`attempts < 5` → `RETRY`（退避 1m/5m/15m/1h/6h）；否则 `FAILED` + **error 日志 + 计数**

**cron 周期**：5 分钟（与 SMS 任务同频但**独立任务名**，互不阻塞）。

---

## 5. S1–S16 与实现点的对应

| # | 用例 | 需要什么 | 现状 |
|---|---|---|---|
| S1–S3 | 上传/删行/文件消失 | 已有同步路径 | ✅ 已证 |
| **S4** | 失败后任务保留并重试 | 队列 + 退避 | ❌ 待实现 |
| S5 | 重复删除幂等 | 已有 | ✅ |
| S6–S8 | 跨单/客户媒体/A 不影响 B | 已有 | ✅ |
| **S9** | 故障注入后恢复 | EACCES/EIO 注入 + 租约恢复 | ❌ |
| **S10** | 路径逃逸拒绝 | 代码级已有；需注入 `../` key 验证 | ⚠️ 半 |
| **S11** | 入队失败 → DB 回滚 | 事务重构 | ❌ |
| **S12** | 删文件后、标记前崩溃 | `absent` 幂等收敛 | ❌ |
| **S13** | 共享引用不误删 | `refs>0 → skipped` 已有；需并发注入 | ⚠️ 半 |
| **S14** | 调度器自动执行 | 注册 cron + 观察真实触发 | ❌ |
| **S15** | 双消费者并发 | `SKIP LOCKED` + 租约 | ❌ |
| **S16** | 超阈值 → FAILED + 告警 | 状态机 + error 日志/指标 | ❌ |

---

## 6. 迁移与回滚

- 文件：`migrations/202610231-pending-file-deletions.ts`（沿用 `2026101xx-` 命名与既有 runner）；
- 幂等：`CREATE TABLE IF NOT EXISTS` + 索引 `IF NOT EXISTS`；重复执行安全；
- **回滚方案必须保任务**：`DROP TABLE` 会丢未完成的清理意图 ⇒
  回滚脚本先导出 `status IN ('PENDING','PROCESSING','RETRY')` 到 JSON 留档，再删表；
  或**只停消费者、保留表**（推荐，零数据丢失）。
- 生产部署顺序（将来）：迁移 → 部署插件（消费者先只读/空跑）→ 观察 24h → 打开 deletePhoto 路由。

---

## 7. 为什么本轮没写代码（说明，不辩解）

1. 涉及**新表 + 迁移 + 消费者 + 事务重构 + 16 项含故障注入**，任何一环半成品都会让
   "删除看起来成功、任务其实没入队"这类问题更难查；
2. 本项目铁律是「**断言不会变红 = 没有断言**」—— 写了但没跑过故障注入的队列，不能算交付；
3. 我剩余的执行预算不足以完成"实现 + 迁移 + 注入 + 观测真实 cron"这一整条链。

**所以只交设计，不交半成品。**

---

## 8. 生产纪律

| 项 | 状态 |
|---|---|
| 代码 / 迁移 / 表 / 部署 | **全部未做** |
| 生产写入 / 上传 / 删除 / 短信 | **0** |
| 隔离库 | 本轮只读（上一轮的 visits/photos 数据保留） |
| Git | **未 commit / 未 push** |

上一轮已落地的两处源码改动（`removeByStorageKey` 实现 + 去可选链）仍留在工作区，未提交。

---

## 9. 建议

把本专项**排成一次独立会话**，我按 §2→§3→§4→§6 的顺序落地，然后：
1. 先跑 S11（入队失败回滚）与 S12（中断幂等）——这两项最能证明队列是真的；
2. 再跑 S14（真实 cron）与 S15（并发认领）——证明消费者是真的在跑；
3. 最后 S9/S16（故障注入 + FAILED 告警）。

这四项过了，`STORAGE / RECOVERY PASS` 才有依据。

P6：LIVE / CONDITIONAL；Release：HOLD。
