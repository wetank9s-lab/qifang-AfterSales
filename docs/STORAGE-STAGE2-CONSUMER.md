# STORAGE-01 · 阶段二报告：消费者已实现，S12 因"无安全调用入口"未执行

> 时间：2026-10-23 11:52–12:20 CST
> 结论：**消费者代码完成并构建通过**；**S12 未执行** —— 卡在"如何在应用进程内安全驱动消费者"。
> **不申请 RECOVERY CORE PASS。**

---

## 1. 本轮修改的文件

| 文件 | 改动 |
|---|---|
| `services/file-deletion-consumer.ts` | **新增**：`runFileDeletionSweep(deps, opts)` |
| `server/index.ts` | +1 行导出 `runFileDeletionSweep` |
| `actions/technician/visit.ts` | **移除提交后的同步清理**，清理统一交给消费者 |

构建：`exit=0`，指纹 `dcf85f45`，176 文件，bundle **1,485,654 B**。

> 中途我把 `visit.ts` 切坏过一次（splice 命中了 try 内的 `if (deleted)`，导致 `Expected "finally"`），
> 已按正确结构重写并重新构建通过。**如实记录这次自伤**。

---

## 2. 消费者实现要点

### 认领（短事务 + SKIP LOCKED + 租约）

```sql
WITH due AS (
  SELECT id FROM pending_file_deletions
   WHERE (status IN ('PENDING','RETRY') AND next_attempt_at <= now())
      OR (status = 'PROCESSING' AND lease_until < now())      -- 租约过期 ⇒ 可重认领
   ORDER BY next_attempt_at LIMIT :batch
   FOR UPDATE SKIP LOCKED
)
UPDATE pending_file_deletions p
   SET status='PROCESSING', lease_owner=:owner,
       lease_until=now()+interval '120 seconds',
       attempts=p.attempts+1, updated_at=now()
  FROM due WHERE p.id=due.id
RETURNING p.id, p.storage_key, p.attempts
```

**锁只覆盖这条 UPDATE**，文件 I/O 在事务之外 —— 没有"把行锁当长期锁"。

### fencing

所有状态更新都带：

```sql
WHERE id = :id AND lease_owner = :owner AND status = 'PROCESSING'
```

⇒ 过期消费者的写入 **0 行受影响**，不会覆盖新认领者的结果。
（`guardedUpdate` 返回受影响行数，消费者据此判断是否计入 completed。）

### 结果映射

| `removeByStorageKey` 返回 | 任务状态 |
|---|---|
| `deleted` / `absent` | **COMPLETED**（absent = 幂等成功） |
| `skipped` | **RETRY** + `last_error='referenced_by_active_record'`，1 小时后复查 |
| `throw` | `attempts+1`；<5 → **RETRY**（退避 60s/5m/15m/1h/6h）；≥5 → **FAILED** + `logger.error` |

### 故障注入钩子

`FILE_DELETE_CRASH_AFTER_UNLINK=1` → unlink 成功后、写 COMPLETED 前 `process.exit(1)`。
默认不设；仅隔离环境使用（已在文件头注明）。

---

## 3. 清理路径的协调（令 §七）

**选择了"全部走消费者"**：`deletePhoto` 提交后**不再**同步删文件。

理由：同步删 + 消费者会形成两条路径竞争同一任务（"文件已删但任务 PENDING" / "双方各删一次"）。
统一走消费者换来的是**任务状态与物理文件最终一致**，代价是文件不会在 HTTP 响应前消失。

**副作用（必须记录）**：正常删除后，**文件会短暂残留**，直到消费者跑一轮。
这改变了上一阶段"200 即 GONE"的观察 —— 是设计取舍，不是回归。

---

## 4. S12 为什么没执行（真实阻塞）

要验证"文件已删、任务未标记 → 中断 → 恢复幂等"，必须**在应用进程内**调用消费者，因为：

- `runFileDeletionSweep(deps)` 需要 **NocoBase 的 `db` 句柄**（`db.sequelize.query`，且用了 sequelize 的 `:name` 占位符）；
- 在容器里 `node -e "require(bundle).runFileDeletionSweep(...)"` **拿不到 app 的 db**；
- 令里明确**禁止新增公网可调用的管理接口**；
- 自己用 `pg` 拼一个 shim 去模拟 `sequelize.query` 的 `:name` 替换，属于"为测试重写运行期契约"，不可靠。

**结论：S12 需要先给消费者一个"合法的进程内触发面"。** 两条路（都需你裁决）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 直接进入**阶段三**：注册 cron（独立任务名，5 分钟），让调度器自己触发；S12 用"注入崩溃后等下一轮 cron"来验证 | 需要能等 5–10 分钟，且 S14 顺带完成 |
| B | 提供一个**仅本地回环、需内部 token** 的诊断 action（不发公网） | 属新增接口，需单独批准；与"禁止管理接口"精神有张力 |

**我倾向 A**：既不新增接口，又能同时拿到 S14 的证据（真实调度）。

---

## 5. 已就绪但未验证的部分

| 项 | 状态 |
|---|---|
| 认领 SQL（SKIP LOCKED + 租约） | 代码已就绪，**未在真实 DB 上跑过** |
| fencing（`lease_owner` 条件更新） | 代码已就绪，**未做定向竞争测试** |
| 退避 / FAILED 阈值 | 代码已就绪，**未注入验证** |
| 迁移 `down()` 非破坏性 | 已按"不 DROP 表、只删索引"实现（阶段一） |

---

## 6. 门禁复核（本轮执行前）

| 项 | 实测 |
|---|---|
| DB=`scqf_media_test` | ✅（阶段一已验证） |
| 媒体 `/opt/scqf-test-media` | ✅ |
| 独立插件 `/opt/scqf-media-test/plugin` | ✅ |
| `SMS_ENABLED=false` | ✅ |
| `zz_inject_fail` 约束 | **已解除**（阶段一末尾 DROP CONSTRAINT） |
| `uq_pfd_active_key` / `ix_pfd_due` | ✅ 存在 |
| 孤儿文件 / 50 MiB 媒体 1、2 | ✅ 未触碰 |

---

## 7. 生产纪律

| 项 | 状态 |
|---|---|
| 生产迁移 / 插件部署 / Nginx / H5 | **未动** |
| 生产上传 / 删除 / 提交 / 短信 | **0** |
| 隔离部署 | **本轮未部署**（只构建） |
| Git | **未 commit / 未 push** |

工作区现有未提交改动：
- `migrations/202610231-pending-file-deletions.ts`（新）
- `services/file-deletion-consumer.ts`（新）
- `services/photo-service.ts`（removeByStorageKey）
- `actions/technician/visit.ts`（事务 + 去掉同步清理）
- `server/index.ts`（+1 行导出）

---

## 8. 申请与下一步

| 项 | 状态 |
|---|---|
| TRANSACTION GATE | PASS / CLOSED（保持） |
| **RECOVERY CORE（S12）** | **PENDING（未执行，非失败）** |
| SCHEDULER / CONCURRENCY | 未开始 |

**下一步建议**：直接进阶段三（注册 cron + 观察真实触发），用"S14 的调度器"来驱动 S12 的崩溃恢复验证 —— 这样一次拿下两块证据，且不新增任何接口。

P6：LIVE / CONDITIONAL；Release：HOLD。
