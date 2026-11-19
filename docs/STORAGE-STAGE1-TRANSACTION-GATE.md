# TECH-PHOTO-DELETE-STORAGE-01 · 阶段一报告：任务表 + 事务一致性

> 时间：2026-10-23 11:46–12:05 CST
> 结论：**TRANSACTION GATE PASS**（S11 实测通过，回滚是真的）。
> 阶段二（消费者 / S12）**未开始**，按令不越级。

---

## 1. 实际修改文件

| 文件 | 改动 |
|---|---|
| `server/migrations/202610231-pending-file-deletions.ts` | **新增**：建表 + 2 个索引（含部分唯一索引） |
| `server/actions/technician/visit.ts` | `deletePhoto` 改为**同一事务内删行 + 入队** |

**未改**：`photo-service.ts`（上一轮的 `removeByStorageKey` 保持）、Token/鉴权、H5、Nginx。

### 迁移要点

```sql
CREATE TABLE IF NOT EXISTS pending_file_deletions (
  id bigserial PRIMARY KEY,
  storage_key varchar(512) NOT NULL,
  object_type varchar(32) NOT NULL DEFAULT 'technician_photo',
  status varchar(16) NOT NULL DEFAULT 'PENDING',   -- PENDING|PROCESSING|COMPLETED|RETRY|FAILED
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(64), lease_until timestamptz,
  last_error varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 幂等入队：未完成期间同一 storage_key 只许一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_pfd_active_key
  ON pending_file_deletions(storage_key) WHERE status IN ('PENDING','PROCESSING','RETRY');
CREATE INDEX IF NOT EXISTS ix_pfd_due ON pending_file_deletions(status, next_attempt_at);
```

`down()` **刻意不 DROP TABLE**（会丢未完成的清理意图），只删索引 —— 已在文件头写明。

### 事务重构（action）

```ts
let deleted: any = null;
const trx = await ctx.db.sequelize.transaction();
try {
  deleted = await services.visits.deletePhoto(Number(matched.id), trx);   // ① 同一事务删行
  if (deleted) {
    await ctx.db.sequelize.query(
      `INSERT INTO pending_file_deletions (storage_key, object_type, status)
       VALUES (:key,'technician_photo','PENDING') ON CONFLICT DO NOTHING`,
      { replacements: { key: String(deleted.storage_key ?? '') }, transaction: trx },
    );                                                                     // ② 同一事务入队
  }
  await trx.commit();                                                      // ③ 一起提交
} catch (error) {
  await trx.rollback().catch(() => undefined);                             // 入队失败 ⇒ 删行也回滚
  throw error;
}
// ④ 提交之后才做文件 I/O（事务内不碰磁盘）
```

`visits.deletePhoto(photoId, transaction?)` 本来就支持传事务 —— 无需改服务层。

---

## 2. 构建与部署

| 步骤 | 结果 |
|---|---|
| 首次构建 | **失败**：`迁移产物未以外部依赖方式引用 @nocobase/database（Migration 基类）` |
| 修正 | 迁移基类改为 `import { Migration } from '@nocobase/database'` |
| 二次构建 | **exit=0**，指纹 `b6210960`，**175 文件**，迁移产物 `202610231-pending-file-deletions.js` 已生成 |
| 部署 | 仅隔离实例 `/opt/scqf-media-test/plugin`，`--force-recreate app-test` → **healthy** |
| 迁移执行 | **app 启动时自动执行**：`table_exists=1` |
| 索引 | `ix_pfd_due`、`pending_file_deletions_pkey`、`uq_pfd_active_key` ✅ |

> 没有手工建表：三件（表 + 两索引）都是插件迁移自动建的，说明迁移链路是通的。

---

## 3. S11：入队失败 → 业务删除回滚（核心）

**注入方式**：`ALTER TABLE pending_file_deletions ADD CONSTRAINT zz_inject_fail CHECK (false) NOT VALID`
（只让 INSERT 失败，不动代码）

| 观测项 | 期望 | 实测 |
|---|---|---|
| `deletePhoto` 返回 | 明确失败 | **HTTP 500** `{"code":"INTERNAL_ERROR"}` ✅ |
| 照片业务记录 | **仍在** | `count = 1` ✅ |
| 私有文件 | **仍在** | `YES` ✅ |
| 清理任务 | **不存在** | `count = 0` ✅（无半条/错误任务） |
| 其他照片 | 不受影响 | `photosA=1`、`photosB=1` ✅ |

⇒ **入队失败 ⇒ 整个事务回滚**，没有"行没了任务也没有"的静默孤儿。

---

## 4. 正常路径（解除注入后）

| 观测项 | 实测 |
|---|---|
| HTTP | **200** `{"data":{"deleted":true,"photos_count":1}}` |
| 任务行 | `visits/1/202610/11a4c284….png｜**PENDING**｜attempts=0` ✅ |
| 文件 | **GONE**（提交后同步清理成功） |
| 他单 | `photosB=1` 未变 |

**关键**：返回 `{deleted:true}` 时，**业务行已删 + 任务已持久化**两者同时成立 —— 这正是本阶段的验收条件。

---

## 5. 尚未取得的证据（不自动 PASS）

| 项 | 状态 |
|---|---|
| **S12** 删文件后、标记前中断 → 重启幂等收敛 | 阶段二 |
| S4 / S9 失败重试与恢复 | 阶段二/四 |
| S14 真实 cron 自动执行 | 阶段三 |
| S15 双消费者并发 | 阶段三 |
| S16 FAILED 与告警可观察 | 阶段三 |
| S10 路径逃逸注入 | 阶段四 |
| S13 共享引用并发注入 | 阶段四 |
| S6/S7/S8 重跑（新实现） | 阶段四（令要求不得只引旧结果） |
| S1/S2/S3/S5 新实现复验 | **本次已部分覆盖**：正常删除 200/任务入队/文件 GONE；S5 幂等未在新实现下重跑 |

---

## 6. 生产纪律

| 项 | 状态 |
|---|---|
| 生产 DB 迁移 | **0** |
| 生产插件重建/重启 | **0** |
| 生产 Nginx / H5 | 未动 |
| 生产上传/删除/提交/短信 | **0** |
| 隔离写入 | 仅 `scqf_media_test`（新表 + 1 条任务 + 1 张照片已删） |
| 孤儿证据 | 保留（未删任何历史孤儿） |
| 50 MiB 媒体 id=1、2 | 未触碰 |
| Git | **未 commit / 未 push** |

---

## 7. 申请

**TRANSACTION GATE：PASS**

下一步（阶段二）：实现消费者 + `FOR UPDATE SKIP LOCKED` + 租约 + fencing，
然后跑 **S12**（文件已删、标记前中断 → 重启幂等收敛）。
**S12 不过，不宣称具备崩溃恢复能力。**

P6：LIVE / CONDITIONAL；Release：HOLD。
