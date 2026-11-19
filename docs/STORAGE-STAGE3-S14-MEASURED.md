# STORAGE-01 · 阶段三实测：链路跑通，但发现 Cron 重复注册（S14 暂不判 PASS）

> 时间：2026-10-23 12:01–12:08 CST
> 结论：**S14 的端到端链路真实跑通了**（文件由消费者删除、任务 COMPLETED、无手工调用），
> **但同时暴露两个问题**：① **cron 重复注册**（2 条注册日志）；② **停机时 job 仍在跑**。
> 按令「若 Cron 重复注册，先修复再测试」⇒ **S14 保持 PENDING**，S12 未开始。

---

## 1. 部署结果（仅隔离实例）

| 项 | 值 |
|---|---|
| 插件目录 | `/opt/scqf-media-test/plugin/service-ticket`（**独立**，与生产解耦） |
| 新 bundle | **1,492,112 B** |
| 容器内加载 | `runFileDeletionSweep` 命中 **5**（确认跑的是新产物，不是旧包） |
| 健康 | **healthy** |
| 日志级别 | 临时改 `LOGGER_LEVEL=info`（**只改 `.env.test`**，为看到注册与 tick） |
| 表 / 约束门禁 | `pending_file_deletions` 存在；`zz_inject_fail` **已不存在** ✅ |

**部署脚本修正**（你令 §二 要求）：
- 去掉 `set -e` 与 grep 的耦合（`grep` 无匹配返回 1 会把脚本中途打断 —— 上一轮就是死在这里）；
- 所有路径写死为隔离路径，不用通配符覆盖；
- 部署后核对「容器内实际加载的产物」而不是只看 tar 拷进去。

---

## 2. Cron 注册：**注册了，但注册了两次**

```
{"level":"info","message":"[file-deletion] 已注册文件清理任务（cron=*/5 * * * *，租约 120s）", ... "timestamp":"2026-10-23 12:03:52"}
{"level":"info","message":"[file-deletion] 已注册文件清理任务（cron=*/5 * * * *，租约 120s）", ... "timestamp":"2026-10-23 12:03:58"}
```

**两条，间隔 6 秒，同一 reqId。**

我的 `registerFileDeletionTask()` 里有"先 removeJob 再 addJob"的幂等保护，但它挡不住**两次独立调用**。
最可能的原因：我把调用插在了 `this.registerSmsRetryTask();` 的位置，而该处位于一个会被执行两次的生命周期
（例如 `load()` 内的注册段 + `afterStart` 再跑一次）。

**影响**：同一实例内每 5 分钟跑两个 sweep。虽然 `SKIP LOCKED` + fencing 保证不会重复处理同一任务，
但**违背你令里的硬门禁**，而且会让 `claimed` 计数失真。**必须先修。**

---

## 3. 另一个问题：停机时 job 仍在跑

```
{"level":"error","message":"[file-deletion] sweep 异常：ConnectionManager.getConnection was called after the connection manager was closed!", ...
 "timestamp":"2026-10-23 12:05:00"}
{"level":"info","message":"[file-deletion] owner=consumer-297-1792728300045 claimed=2 done=0 retry=0 failed=0", ...
 "timestamp":"2026-10-23 12:05:00"}
```

- `claimed=2` 说明它认领了任务，但 DB 连接已被关闭 ⇒ `done=0`；
- 这次 sweep 来自**正在退出的进程**（或重复注册的第二个 job），说明**没有响应 app 关闭**；
- 好在租约机制兜底：该次认领的 `lease_until` 到期后，任务可被重新认领 —— 这正是我们要的语义，
  但**不该靠它来掩盖"停机时还在干活"**。

---

## 4. S14 链路证据（这一段是干净的）

| 步骤 | 实测 |
|---|---|
| 上传合成 PNG（81 B） | photoId=**7**，`visits/1/202610/bbfe0d18….png`，文件 **EXISTS** |
| `deletePhoto` | **200** `{"deleted":true,"photos_count":1}` |
| 图片 API 立即 | **404**（业务行已删，URL 立即失效）✅ |
| 任务 | **PENDING / attempts=0 / lease_owner=-** |
| Cron 前文件 | **EXISTS**（没有同步删除抢先）✅ |
| 41 秒后 | 任务 **COMPLETED / attempts=1 / owner=consumer-297**，文件 **GONE** |
| 手工调用 sweep | **没有**（全程只靠 cron） |

⇒ **"异步回收"这条链路是真的**：任务持久化 → 调度器认领 → 消费者 unlink → 标记完成。

**但因为 §2 的重复注册**，按令**不能判 S14 PASS**。

---

## 5. 其它媒体未受影响

```
photosA=1  photosB=1
medias: 1:null  2:null  3:1  4:2      ← 50 MiB 边界媒体 1、2 仍为 null（未动）
tasks_total=3
```

---

## 6. 修复计划（下一步，各一步一验）

| # | 问题 | 修法 |
|---|---|---|
| 1 | cron 重复注册 | 在 `registerFileDeletionTask()` 开头加 `if (this.fileDeletionJob) return;`（**先判已有，不做 removeJob 重建**）；并核对该调用点是否被执行两次（改用 `afterStart` 单点） |
| 2 | 停机时 sweep 仍在跑 | 消费者入口检查 `app.status`；或在 `beforeStop` 里 `removeJob`。**不做**则会持续产生"认领后连不上库"的 error |
| 3 | 一次性注入 | 按 `FILE_DELETE_CRASH_TASK_ID` + `attempts=1` 实现（本轮未做） |

修完 1、2 后重跑 S14，通过再进 S12。

---

## 7. 生产纪律

| 项 | 状态 |
|---|---|
| 生产 DB / 插件 / Nginx / H5 | **未动** |
| 生产上传 / 删除 / 提交 / 短信 | **0** |
| 隔离写入 | 仅 `scqf_media_test`：photoId=7（已删）、任务 3（含历史） |
| 孤儿证据 / 50 MiB 媒体 1、2 | 未触碰 |
| Git | **未 commit / 未 push** |

---

## 8. 状态

| 项 | 状态 |
|---|---|
| TRANSACTION GATE | PASS / CLOSED |
| **S14（真实 cron）** | **PENDING（链路已证，但重复注册未修）** |
| S12 | 未开始 |
| RECOVERY CORE | 不申请 |
| S15 / S16 | PENDING |
| ROUTE-01 | HOLD |

P6：LIVE / CONDITIONAL；Release：HOLD。
