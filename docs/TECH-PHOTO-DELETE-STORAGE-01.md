# TECH-PHOTO-DELETE-STORAGE-01：删除链路、文件生命周期与孤儿文件根因报告

> 时间：2026-10-23 11:33–11:55 CST
> 结论：**情况 A（只做 DB 删除，文件清理调用指向一个不存在的方法，且被可选链静默吞掉）**。
> 定性：**存储生命周期缺陷**（不是"有意留档"）。**未改任何代码，未删任何文件。**

---

## 1. 实际删除调用链（文件:行）

```
actions/technician/visit.ts:595   const deletePhoto = authed('deletePhoto', async (ctx, auth) => {
  :597   ref 形态校验（PHOTO_REF_PATTERN，22 位）
  :603   services.visits.listPhotos(visitId)          ← 候选集 = 本 Visit
  :604   photoRefOf(row.id, tokenHash) === ref        ← 按 tokenHash 重算比对（归属校验）
  :605   且 photo_type 必须是 ONSITE
  :612   services.visits.deletePhoto(id)              ← ① DB 硬删
  :615   if (deleted) {
  :616     await services.photos.removeByStorageKey?.(deleted.storage_key)   ← ② 本应删文件
  :618     } catch { logger.warn(...) }               ← 只 warn，不重试
```

---

## 2. 根因：方法不存在 + 可选链把"缺失"变成"静默"

| 事实 | 证据 |
|---|---|
| `services.photos` **是接线的** | `services/index.ts:190` 类型 `photos: PhotoService`；`:318` 装配 `photos,` |
| **`removeByStorageKey` 全仓只有一处出现** | `grep -rn removeByStorageKey` → **只有 `visit.ts:616` 这一行调用，没有任何定义** |
| 调用用了**可选链** | `services.photos.removeByStorageKey?.(...)` |

⇒ `photoService.removeByStorageKey` 是 `undefined` ⇒ `?.()` **直接返回 undefined，不抛错** ⇒
**连 `catch` 里的 `warn` 都不会触发** ⇒ **文件从未被删除，日志里也一个字都没有**。

这解释了为什么这个缺陷一直没被发现：**代码"看起来"做了文件清理，实际上什么都没做，而且不留痕迹。**

这条也值得记进工程纪律：**可选链用在"必须存在"的协作方法上，会把缺失变成沉默。**

---

## 3. 上传侧：文件是怎么写的（对照）

- 上传走 `technicianVisit:upload` → 写入**私有目录**（容器内 `/app/nocobase/storage/uploads-private`，
  隔离实例挂 `/opt/scqf-test-media`）；
- `service_visit_photos` 通过 **`storage_key`** 关联文件，实测样例：
  `visits/1/202610/3c4b79fb2aa059bec1b2cf9410d1191dee4f20c894cf86e5.png`
- 路径含 `visit_id/YYYYMM/` 与文件名哈希前缀 ⇒ 天然按 Visit 分桶、文件名不可猜。

**三个概念必须分开**（令 §三 的要求）：

| 层次 | 现状 |
|---|---|
| DB 记录不存在 | ✅ 删除后确实不存在 |
| 图片 API 无法访问 | ✅ 再读返回 404 |
| **私有文件实际不存在** | ❌ **仍在磁盘上** |

三者不等价 —— 前两条成立，第三条不成立。

---

## 4. 是否存在"有意留档"设计

**没有找到任何依据。** 检索结论：

| 检查项 | 结果 |
|---|---|
| 业务规范 / 图片生命周期文档 | 无"删除后保留文件"的说明 |
| 安全/审计要求 | 无 |
| 定时清理任务 | 插件只有 **SMS retry** 与 **SMS pending recovery** 两个 cron，**没有照片/媒体 GC** |
| 软删除设计 | 无（`deletePhoto` 是真删 DB 行） |
| 删除失败重试 | 无（catch 里只 `warn`） |

⇒ **不能推测"为了审计所以保留"**。这是漏实现，不是设计。

---

## 5. 已知孤儿文件（只读盘点，未删除）

| 相对路径 | 大小 | DB 行 | 说明 |
|---|---|---|---|
| `visits/1/202610/3c4b79fb….png` | 79 B | **不存在** | D2 删除后残留（实测 EXISTS） |
| 其余待核 | — | — | 目录共 **8 个文件**：媒体 4（含 50 MiB 的 1、2）+ 照片 2 + **孤儿 ≥2** |

> 我**没有**按"文件数 − 记录数"直接断言全部孤儿（令 §七 明确禁止）。上表只列了**已有直接证据**的那一个。

---

## 6. 最小修复设计（未实施）

### 6.1 必做两件事

1. **实现 `PhotoService.removeByStorageKey(storageKey)`** —— 走项目既有存储抽象（`services.media` 同一套），
   而不是在 action 里裸写 `fs.unlink`；
2. **去掉 `?.`** —— 方法缺失必须在启动/调用时**炸出来**，不能静默。

### 6.2 语义与安全边界

| # | 关注点 | 设计 |
|---|---|---|
| 1 | 幂等 | 文件不存在视为成功（`ENOENT` 吞掉） |
| 2 | DB 成功 / 文件失败 | 记 `error` 级日志 + 计数指标，并把 `storage_key` 写入**待清理表**（最终一致） |
| 3 | 文件成功 / DB 失败 | 不允许发生：**先 DB、后文件**（现状顺序正确，保留） |
| 4 | 路径可信 | 只用 DB 里的 `storage_key`，不接受客户端输入 |
| 5 | 路径逃逸 | `path.resolve` 后必须 `startsWith(uploads-private 根)`，否则拒绝并告警 |
| 6 | 共用对象 | 删前查 `count(*) where storage_key = ?`，>1 则跳过并告警（防误删他记录引用） |
| 7 | 持久化待办 | 新增一张小表或复用既有 outbox 语义：`pending_file_deletions(storage_key, attempts, next_at)` |
| 8 | 最终一致验证 | 一个只读核对脚本：遍历 `pending_file_deletions` + 抽样比对 DB 引用与磁盘 |
| 9 | 不误删在用媒体 | 删除前二次校验"无记录引用"（同 #6） |
| 10 | 异常不静默 | `error` 日志 + 指标；**禁止** `catch {}` 空块 |

### 6.3 建议 diff 形态（示意，未提交）

```diff
+ // services/photo-service.ts
+ async removeByStorageKey(storageKey: string): Promise<'deleted'|'absent'|'skipped'> {
+   const key = String(storageKey ?? '').trim();
+   if (!key) return 'absent';
+   const root = path.resolve(this.storageRoot);
+   const abs  = path.resolve(root, key);
+   if (!abs.startsWith(root + path.sep)) { this.logger.error?.(...); throw new Error('path escape'); }
+   const refs = await this.db.getRepository('serviceVisitPhotos').count({ filter: { storage_key: key } });
+   if (refs > 0) { this.logger.warn?.(...); return 'skipped'; }
+   try { await fs.promises.unlink(abs); return 'deleted'; }
+   catch (e: any) { if (e?.code === 'ENOENT') return 'absent'; throw e; }
+ }

  // actions/technician/visit.ts:616
-   await services.photos.removeByStorageKey?.(String(deleted.storage_key ?? ''));
- } catch { logger.warn?.(...) }
+   try { await services.photos.removeByStorageKey(String(deleted.storage_key ?? '')); }
+   catch (e) { logger.error?.(...); await services.maintenance.enqueueFileDeletion(...); }
```

> **注意**：这需要新增一个小表/队列与一次迁移 —— 属"插件改动 + 重建 + 部署"，**必须另立专项**。

---

## 7. 隔离回归方案（S1–S10，设计稿）

| # | 用例 | 现状 |
|---|---|---|
| S1 | 上传 PNG，记录 DB + 文件 | ✅ 已有证据（photo id 1/2/4，文件在） |
| S2 | 删除后 DB 行消失 | ✅ 已证 |
| S3 | 文件按契约被清理 | ❌ **当前必失败**（根因） |
| S4 | 删除失败可检测/补偿 | ❌ 无机制，修复后需注入验证 |
| S5 | 重复删除无副作用 | ✅ 已证（200 → 404） |
| S6 | 跨 Visit 不可删 | ✅ 已证（含 deep ref） |
| S7 | 客户媒体不可删 | ✅ 已证 |
| S8 | 删 A 不影响 B | ✅ 已证（photosB 不变） |
| S9 | 存储删除失败后恢复 | 待修复后注入（如 `chmod 000` 目标目录） |
| S10 | 清理不越出测试根目录 | 待修复后验证（构造 `../` 的 storage_key） |

---

## 8. 生产纪律

| 项 | 状态 |
|---|---|
| 生产代码 / Nginx / DB / 插件 / H5 | **未改** |
| 生产上传 / 删除 / 短信 / 重启 | **0** |
| 隔离库写入 | 0（本轮只读） |
| 文件删除 | **0**（未删任何孤儿） |
| Git | **未 commit / 未 push** |

---

## 9. 状态与建议

| 项 | 状态 |
|---|---|
| TECH-PHOTO-DELETE-01 | BACKEND / AUTH PASS（保持） |
| **TECH-PHOTO-DELETE-STORAGE-01** | **ROOT CAUSE FOUND（情况 A）→ 修复待专项授权** |
| TECH-PHOTO-DELETE-ROUTE-01 | **HOLD**（存储缺陷未修前不开生产删除路由，否则孤儿文件会持续累积） |

**建议顺序**：先做 STORAGE 修复（含待清理队列 + 迁移）→ 隔离回归 S3/S4/S9/S10 → 再开生产路由。

P6：LIVE / CONDITIONAL；Release：HOLD。
