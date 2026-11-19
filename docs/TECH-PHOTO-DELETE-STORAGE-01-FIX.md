# TECH-PHOTO-DELETE-STORAGE-01：隔离修复与文件一致性回归报告

> 时间：2026-10-23 11:36–11:50 CST
> 结论：**文件清理已修好（S3 从 STILL_EXISTS 变为 GONE）**；
> **但清理队列/补偿机制未实现** ⇒ S4/S9/S11/S12 **PENDING**，**不申请完整 PASS**。

---

## 1. 根因与旧实现（复述）

```ts
// 旧：actions/technician/visit.ts:616
await services.photos.removeByStorageKey?.(String(deleted.storage_key ?? ''));
```

- `services.photos` 是接线的（`services/index.ts:190/:318`），
- 但 `removeByStorageKey` **全仓无定义**（只有这一处调用），
- **可选链 `?.()`** 把"方法缺失"变成静默 no-op ⇒ 文件永不删除、**连 warn 都没有**。

---

## 2. PhotoService 最小实现（diff）

```diff
+  async removeByStorageKey(storageKey: string): Promise<'deleted' | 'absent' | 'skipped'> {
+    const key = String(storageKey ?? '').trim();
+    if (!key) throw new Error('[photo] removeByStorageKey: storage_key 为空');
+    if (!key.startsWith('visits/')) {
+      throw new Error(`[photo] removeByStorageKey: 非师傅照片路径，拒绝处理：${key}`);
+    }
+    const abs = this.resolveInsideRoot(key);          // 已有：root + path.sep 比较
+
+    const refs = await this.db.getRepository('serviceVisitPhotos')
+      .count({ filter: { storage_key: key } });
+    if (Number(refs) > 0) { this.logger?.warn?.(…); return 'skipped'; }   // 防误删共用对象
+
+    try { await this.fsx.unlink(abs); return 'deleted'; }
+    catch (error) {
+      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent';   // 幂等
+      throw error;                                                              // 绝不静默
+    }
+  }
```

**复用既有抽象**：`resolveInsideRoot`（既有路径越界防护）、`this.fsx`（可注入 fs，便于故障注入）、
`this.logger`。**没有**在 action 里裸写 `fs.unlink`。

## 3. 调用处 diff（去掉可选链）

```diff
-      try {
-        await services.photos.removeByStorageKey?.(String(deleted.storage_key ?? ''));
-      } catch {
-        logger.warn?.(`[technician:deletePhoto] 记录已删但文件未清掉（visit=${visitId}）`);
-      }
+      try {
+        const outcome = await services.photos.removeByStorageKey(String(deleted.storage_key ?? ''));
+        if (outcome !== 'deleted') logger.warn?.(`… 文件未删除（outcome=${outcome} …）`);
+      } catch (error) {
+        logger.error?.(`… 记录已删但文件清理失败（key=${…}）：${(error as Error)?.message}`);
+      }
```

**关键**：空 `storage_key` 不再被 `?? ''` 吞掉后继续跑 —— 方法内**显式抛错**。

---

## 4. 部署范围（只动隔离实例）

| 项 | 做法 |
|---|---|
| 构建 | `exit=0`，bundle **1,485,717 B**，指纹 `13475f1c`，`removeByStorageKey` 命中 5 |
| 隔离插件目录 | **新建** `/opt/scqf-media-test/plugin/service-ticket`（与生产挂载解耦） |
| 隔离 compose | 两处挂载由生产目录改为该独立目录（**仅测试实例**） |
| 重建 | `docker compose up -d --force-recreate app-test` → **healthy**，容器内方法命中 5 |
| **生产** | 插件挂载、容器、DB、Nginx **全未动** |

> 这一步很关键：原测试实例与生产**共用同一个插件目录**，若直接在那里重建，生产下次重启就会吃到新产物。
> 所以先把隔离实例的挂载摘出去。

---

## 5. 回归结果（真实执行）

| # | 用例 | 结果 |
|---|---|---|
| **S1** | 上传合法 PNG（24×24，87 B，`width=24` 服务端解析） | ✅ photoId=5，文件存在 |
| **S2** | 删除后 DB 行消失 | ✅ `200 {"deleted":true,"photos_count":1}`，行数 0 |
| **S3** | **物理文件最终消失** | ✅ **GONE**（修复前必为 STILL_EXISTS） |
| **S5** | 重复删除无副作用 | ✅ `404`（与契约一致） |
| S6 | 跨 Visit 拒绝 | ✅ 前一轮已证（含 deep ref），本轮未重跑 |
| S7 | 客户媒体不可删 | ✅ 前一轮已证 |
| S8 | 删 A 不影响 B | ✅ 前一轮已证（`photosB` 不变） |
| S10 | 路径逃逸/异常 key | ⚠️ **代码级**：`key` 必须 `visits/` 前缀 + `resolveInsideRoot`；未做运行期注入 |

**日志**：删除成功路径无异常；仅有框架的 `Workflow pre-action: collection "technicianVisit" not found` 噪声（既有现象，与本次无关）。

---

## 6. 未实现（PENDING，必须说清）

| # | 用例 | 状态 | 原因 |
|---|---|---|---|
| **S4** | 文件删除失败可检测/重试 | **PENDING** | 只有 `error` 日志，**无重试队列** |
| **S9** | 注入存储删除异常后可恢复 | **PENDING** | 同上 |
| **S11** | 队列写入失败 → DB 删除回滚 | **PENDING** | 队列表未建 |
| **S12** | 删文件后、标记完成前中断 → 幂等收敛 | **PENDING** | 无队列/状态 |
| S13 | 仍有引用不得物理删除 | ✅ 代码已实现（`refs > 0 → skipped`），**未做并发注入** |
| S14 | 调度器真实执行 | **PENDING** | 无消费者 |

**为什么没做**：需要**新增一张待清理表 + 迁移 + 消费者（复用 cron 设施）**，
属插件结构改动 + 迁移，本轮授权范围里我优先做了"根因修复 + 核心回归"，
没有把握在一次交付里把迁移与调度都做稳。**不假装完成。**

---

## 7. 现状下的一致性保证（如实描述）

| 场景 | 现行为 |
|---|---|
| DB 删成功 + 文件删成功 | ✅ 一致 |
| DB 删成功 + 文件不存在 | ✅ 一致（ENOENT 幂等） |
| DB 删成功 + 文件删除失败 | ⚠️ **不一致**，仅 `error` 日志，**需人工/后续队列** |
| 仍有引用 | ✅ 跳过并 warn |

⇒ 从"**100% 泄漏**"降到"**失败才泄漏且有日志**"。这是实质改进，但**不是最终一致性方案**。

---

## 8. 旧孤儿文件（保留）

`visits/1/202610/3c4b79fb….png`（79 B）**仍保留**，作为根因证据。
本轮**未删除任何历史孤儿**，未触碰 50 MiB 媒体 id=1、2（`ticket_id` 仍 null）。
目录当前 8 个文件（删了 1 个 S1 文件、新增 1 个 S1 文件，净持平）。

---

## 9. 生产纪律

| 项 | 状态 |
|---|---|
| 生产插件 / 容器 / DB / Nginx / H5 | **未改** |
| 生产迁移 / 上传 / 删除 / 短信 | **0** |
| 隔离库写入 | 仅 `scqf_media_test`（photoId 5 已删，新签名 token） |
| Git | **未 commit / 未 push**（工作区有 2 个源码文件改动） |

**改动文件**：
- `nocobase/plugins/service-ticket/src/server/services/photo-service.ts`（+45 行，新方法）
- `nocobase/plugins/service-ticket/src/server/actions/technician/visit.ts`（调用处去掉 `?.`，日志升级）

---

## 10. 申请

| 项 | 状态 |
|---|---|
| **TECH-PHOTO-DELETE-STORAGE-01** | **文件清理修复 PASS（同步路径）；补偿/队列 PENDING** → 申请 **PARTIAL**，不申请完整 PASS |
| TECH-PHOTO-DELETE-ROUTE-01 | **仍 HOLD**（建议队列做完再开） |

**下一步（需你授权）**：新增 `pending_file_deletions` 表 + 迁移 + 消费者（复用 cron），
把 S4/S9/S11/S12 补上；DB 删除与入队放同一事务。

P6：LIVE / CONDITIONAL；Release：HOLD。
