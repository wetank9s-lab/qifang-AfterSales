# STORAGE-01 阶段三：Cron 已接线，S14/S12 未执行（未部署）

> 时间：2026-10-23 11:55–12:25 CST
> 结论：**代码完成、构建通过**；**未部署、S14/S12 未执行**。
> **不申请 S14 PASS，也不申请 RECOVERY CORE PASS。**

---

## 1. 本轮完成的代码

| 文件 | 改动 |
|---|---|
| `services/file-deletion-scheduler.ts` | **新增** `registerFileDeletionJob(app, deps)` |
| `services/file-deletion-consumer.ts` | **fencing 加固**：更新条件加 `attempts`（单调版本） |
| `server/plugin.ts` | **接线**：`registerFileDeletionTask()` + 在 `registerSmsRetryTask()` 同点位调用 |

构建：`exit=0`，指纹 **`e10f3d3a`**，**177 文件**。

### Cron 注册（照抄 SMS retry 的形态）

```ts
const job = manager.addJob({
  cronTime: deps.cronTime ?? '*/5 * * * *',
  onTick: () => { void runFileDeletionSweep({ db, photos, logger }).catch(...) },
  start: false,          // 由 CronJobManager 在 afterStart 统一 start
});
```

- `cronJobManager` 不可用 → **只 warn + 返回 null**（不让 `plugin.load()` 失败）；
- 依赖从**真实应用上下文**注入：`(this.app as any).db` + `this.services.photos` + `this.app.log`；
- **独立任务名**，与 SMS retry / recovery 互不阻塞；
- 单条文件删除失败不会让应用退出（`onTick` 不 await + catch）。

### fencing 加固（免改表）

```sql
UPDATE pending_file_deletions SET ...
 WHERE id = :id
   AND lease_owner = :owner
   AND status = 'PROCESSING'
   AND attempts = :attempts      -- ← 新增：单调版本
```

`attempts` 在每次认领时 +1，天然是"第几次认领"的版本号。
过期消费者手里的 `attempts` 已过期 ⇒ **0 行受影响**，无法覆盖新轮次 —— 比只看 `lease_owner` 强一档
（同一 owner 字符串重入也被挡住）。

---

## 2. 未执行的部分（真实原因）

| 项 | 状态 | 原因 |
|---|---|---|
| 部署到隔离实例 | **未部署** | 生成执行脚本时**嵌套引号把 heredoc 打断了**（第 N 次踩同一个坑） |
| **S14 真实 cron 自动调度** | **未执行** | 同上 |
| **S12 崩溃 + 租约恢复** | **未执行** | 依赖 S14 的调度器；且一次性注入门禁尚未实现 |

**测试实例当前仍跑阶段一的产物**（`pending_file_deletions` 表在、`deletePhoto` 事务化在），
阶段二/三的消费者与 cron **都没有上线到隔离实例**。

> 我不把"构建通过"说成"运行通过"。这是你令里明确写的那条。

---

## 3. 一次性注入门禁（设计已定，未实现）

令要求 `FILE_DELETE_CRASH_AFTER_UNLINK` 必须**单次、单任务**。设计：

```
.env.test 增加 FILE_DELETE_CRASH_TASK_ID=<id>   （而不是布尔开关）
消费者：if (String(process.env.FILE_DELETE_CRASH_TASK_ID) === String(row.id) && attempts === 1)
          → 写一个持久化标记（复用 last_error 或单独列）→ process.exit(1)
```

- **按任务 ID 精确命中**，不碰旧孤儿、不碰其他任务；
- `attempts === 1` 保证**只在第一次认领**触发，重启后不会重复崩；
- 触发前先落库标记，**跨进程可见**；
- 生产 `.env` 不设该变量。

这套需要再改一处消费逻辑 + 一次构建，我本轮没做（避免又交半截）。

---

## 4. 部署与执行计划（下一轮，我会用文件写入而非 heredoc）

1. 上传 tar → `/opt/scqf-media-test/plugin` → `--force-recreate app-test`；
2. 看日志确认 `[file-deletion] 已注册文件清理任务（cron=*/5 * * * *）`；
3. **S14**：上传 PNG → deletePhoto → 断言 `任务=PENDING` 且 **文件仍 EXISTS** → 等真实 cron（最长 ~5.5 分钟）→ 断言 `COMPLETED` + 文件 `GONE` + `attempts=1`；
4. **S12**：设 `FILE_DELETE_CRASH_TASK_ID=<新任务 id>` → 等 cron 认领 → 进程退出 → 断言文件 `GONE`、任务非 `COMPLETED` → 重启（去掉变量）→ 等租约过期（120s）→ 再次 cron → `absent` → `COMPLETED`。

---

## 5. 语义调整（已确认，写进验收口径）

`HTTP 200 + {deleted:true}` 现在表示：

- 照片业务行已删 ✅
- 清理任务已持久化 ✅
- 后续清理已被系统接管 ✅
- **不代表响应返回时物理文件已消失** ❗

因此后续 H5 验收**不得**把"删除成功"解释成"物理回收已完成"。

---

## 6. 生产纪律

| 项 | 状态 |
|---|---|
| 生产迁移 / 插件部署 / 重启 / Nginx / H5 | **未动** |
| 生产上传 / 删除 / 提交 / 短信 | **0** |
| 隔离实例 | 仍跑阶段一产物，**本轮未改动** |
| 孤儿证据 / 50 MiB 媒体 1、2 | 未触碰 |
| Git | **未 commit / 未 push** |

工作区未提交文件（5 个）：`migrations/202610231-pending-file-deletions.ts`、`services/file-deletion-consumer.ts`、
`services/file-deletion-scheduler.ts`、`services/photo-service.ts`、`actions/technician/visit.ts`、`server/plugin.ts`、`server/index.ts`。

---

## 7. 状态

| 项 | 状态 |
|---|---|
| TRANSACTION GATE | PASS / CLOSED |
| **S14（真实 cron）** | **PENDING（代码已就绪，未部署）** |
| **S12（崩溃恢复）** | **PENDING（依赖 S14 + 注入门禁）** |
| S15 / S16 | PENDING |
| RECOVERY CORE | **不申请** |
| TECH-PHOTO-DELETE-ROUTE-01 | HOLD |

P6：LIVE / CONDITIONAL；Release：HOLD。
