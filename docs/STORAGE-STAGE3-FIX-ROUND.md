# STORAGE-01 · 修复轮报告：重复注册已修，但我的停机守卫导致 S14 失败（自伤）

> 时间：2026-10-23 12:28–12:45 CST
> 结论：**R1（注册幂等）PASS**；**S14 本轮 FAIL** —— 原因是我新加的停机守卫写错，**不是产品缺陷**。
> 已在代码中修正并重新构建（`0b04e189`），**尚未部署复验**。

---

## 1. 重复注册：已修好（R1 = 1）

**修复**：`registerFileDeletionJob` 增加 **app 级幂等**（`app.__svcFileDeletionJob` 已存在则早返回），
`plugin.ts` 里去掉"先 removeJob 再 addJob"的循环做法。

**证据**（同一进程日志）：

```
12:29:46  [file-deletion] 已注册文件清理任务（cron=*/5 * * * *，租约 120s，pid=296）
12:29:52  [file-deletion] 已存在清理任务，跳过重复注册（幂等）
```

R1 计数（`grep -c 已注册文件清理任务`）= **1** ✅
R5：`SMS 延迟重试任务已注册` 仍有 **2** 条（未被影响）✅

---

## 2. 但我引入了一个更严重的问题（自伤）

为了修"停机后仍在访问 DB"，我加了：

```ts
app.on?.('beforeStop', () => { app.__svcFileDeletionStopping = true; });
// onTick: if (app.__svcFileDeletionStopping) return;
```

**实测发现 `beforeStop` 在本环境启动阶段就被触发过一次**（`12:29:51 收到停机信号`），
标志一旦置位**永不复位** ⇒ 该进程后续**所有 tick 全被跳过**。

**后果（S14 直接失败）**：

| 观测 | 值 |
|---|---|
| 任务 id=4 | **PENDING / attempts=0 / 无 owner** |
| 等待 | **348 秒** |
| cron 处理日志 | **0 条** |
| 文件 | **STILL_EXISTS** |

⇒ 不是产品问题，**是我的守卫写错了**。

---

## 3. 修正（已构建，未部署）

```diff
- app.on?.('beforeStop', () => { app.__svcFileDeletionStopping = true; });
- // onTick: if (app.__svcFileDeletionStopping) return;
+ app.on?.('beforeStop', () => {
+   // 用 removeJob 停止调度：语义准确，且不依赖任何状态复位
+   app.cronJobManager?.removeJob?.(app.__svcFileDeletionJob);
+ });
```

构建：`exit=0`，指纹 **`0b04e189`**，177 文件。

**设计理由**：`removeJob` 是"取消调度"这个动作本身；
用标志位做守卫要求"置位/复位"成对出现，而我无法保证 `beforeStop` 只在真正停机时触发一次 ——
这正是"只检查一次状态不等于解决竞争"的反面教训。

---

## 4. 停机竞态（L1）现状

测试的是**旧构建**（带错误守卫）：

```
停机后 connection manager was closed 异常 = 12 条
```

**新构建未验证。** 预期 `removeJob` 会让停机后不再有 tick，但**没有实测就不算解决**。

---

## 5. 数据状态

| 项 | 值 |
|---|---|
| 任务表 | `2:COMPLETED(a=1)`、`3:COMPLETED(a=1)`、**`4:PENDING(a=0)`**（本轮遗留，下一轮会被处理） |
| photosA / photosB | 1 / 1（未受影响） |
| customer_medias | `1:null 2:null 3:1 4:2`（**50 MiB 边界 1、2 未动**） |
| 孤儿证据 | 保留 |

---

## 6. 生产纪律

| 项 | 状态 |
|---|---|
| 生产 DB / 插件 / Nginx / H5 | **未动** |
| 生产上传 / 删除 / 提交 / 短信 | **0** |
| 隔离部署 | 部署了 **带缺陷守卫的构建**（`948c1206`）；新构建 `0b04e189` **未部署** |
| Git | **未 commit / 未 push** |

---

## 7. 状态与下一步

| 项 | 状态 |
|---|---|
| R1 注册幂等 | **PASS** |
| R2/R3（重复/并发触发） | 未单独测（幂等代码覆盖，但无实测） |
| **S14** | **FAIL（本轮）**，新构建待复验 |
| L1 停机 | 旧构建 12 条异常；新构建待验 |
| S12 / S15 / S16 | 未开始 |
| RECOVERY CORE | 不申请 |
| ROUTE-01 | HOLD |

**下一步（一轮可完成）**：
1. 部署 `0b04e189` → 确认 R1=1、无"跳过重复注册"刷屏；
2. 用**新合成 PNG** 跑 S14（等真实 cron，≤5 分钟）→ 期望 `COMPLETED` + `GONE`；
3. 顺手验证 L1：`docker restart` 后 `connection manager was closed` 应为 **0**。

P6：LIVE / CONDITIONAL；Release：HOLD。
