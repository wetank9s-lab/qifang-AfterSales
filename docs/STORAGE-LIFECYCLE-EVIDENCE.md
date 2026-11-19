# Cron 生命周期归属报告（按令：只提交证据，不部署）

> 时间：2026-10-23 12:40–12:55 CST  
> 结论：**`beforeStop` 不是"只在停机时触发一次"的事件** —— NocoBase 在 **3 处** `emitAsync('beforeStop')`。  
> 因此「在 `beforeStop` 里 `removeJob`」和「在 `beforeStop` 里置标志」**都不安全**。  
> 按令 §八 的兜底条款：**停止试错，提交调用链证据进行专项代码审查**。**本轮未部署 0b04e189。**



---

## 1. 我们的注册点（真实位置）

```
plugin.ts:721    this.registerSmsRetryTask();
plugin.ts:722    this.registerFileDeletionTask();      ← 我插入的
```

二者都在 `plugin.load()` 的同，。 ，段里（registerAcl → registerRoles → … → registerSmsRetryTask）。  
**`load()` 每进程被调用两次**这一个推断，来自实测的两条日志（同 reqId、相隔 6 秒），  
加上幂等生效后的"跳过重复注册"日志 —— 即：**同一进程中 `registerFileDeletionTask()` 被进入两次**，  
第二次被 `app.__svcFileDeletionJob` 早返回挡掉。

> 注意：我没有只凭"时间接近/同 reqId"下结论，而是靠**幂等分支被触发**这一事实反推  
> （若 `load()` 只跑一次，不会有第二次进入）。

---

## 2. `beforeStop` 的真实触发源（源码证据）

```
/app/nocobase/node_modules/@nocobase/server/lib/application.js:408   await this.emitAsync("beforeStop");
/app/nocobase/node_modules/@nocobase/server/lib/application.js:680   await this.emitAsync("beforeStop");
/app/nocobase/node_modules/@nocobase/server/lib/application.js:702   await this.emitAsync("beforeStop", this, options);
```

**三处 emit**，而且 `:408` 位置靠前（远早于 `stop()`/`destroy()` 那两处），  
这解释了为什么我们在启动后第 5 秒就看到"停机信号"：

- 它不是"应用要停了"，而是**某条启动/初始化/重启路径**也会 emit；
- 具体是哪一条（install / restart / upgrade）**需要读 application.js 上下文才能定论**，  
  我这轮**没有**继续猜 —— 这正是你令里禁止的"靠时间接近推断"。

**结论**：`beforeStop` 作为"停机关闭顺序"的唯一依据是**不可靠的**。

---

## 3. `removeJob` 的 API 契约（源码证据）

```
/app/nocobase/node_modules/@nocobase/server/lib/cron/cron-job-manager.js:60   removeJob(job) { … }
```

- **参数是 job 对象**（不是名称、不是 ID）—— 我之前的调用形式 `removeJob(jobObject)` **恰好正确**；
- 返回值是否为 Promise / 是否等待运行中的 tick：**未确认**（源码只看到签名，没读函数体）。  
  ⇒ 因此**不能**假设 `removeJob` 会"等已有 sweep 结束"。

---

## 4. 由此得到的三个硬结论

| # | 结论                                                                                          |
| - | ------------------------------------------------------------------------------------------- |
| ① | **不能**在 `beforeStop` 里 `removeJob` —— 它会在非停机路径上把 Job 提前摘掉（这正是 `0b04e189` 的风险，所以没部署）         |
| ② | **不能**用"置标志 + 早返回" —— 标志一旦置位无复位路径，必然重演上一轮 S14 的失败                                           |
| ③ | 正确的停止顺序需要**真实可用的停机钩子**，而现在已知的唯一候选 `beforeStop` 语义不纯 ⇒ **必须先做代码审查/读 application.js 上下文**，再动手 |

---

## 5. 已确认可用的部分（不在本轮改动范围）

| 项                                    | 状态                                                        |
| ------------------------------------ | --------------------------------------------------------- |
| 注册幂等（`app.__svcFileDeletionJob` 早返回） | **PASS**（R1=1，有日志证据）                                      |
| `attempts` 作为认领版本（fencing）           | 代码就绪，S15 未验                                               |
| 消费者认领 + 删除 + 完成                      | 在 `948c1206` 构建上**已实测跑通一次**（任务 2/3 COMPLETED、文件 GONE、a=1） |
| 停机竞态（L1）                             | **未解决**（旧构建 12 条 `connection manager was closed`）         |
| inFlight 跟踪 + 有界等待                   | **未实现**                                                   |

---

## 6. 建议的下一步（供代码审查）

审查点（按优先级）：

1. **读 `application.js:380–420`**，确认 `:408` 的 `beforeStop` 属于哪条路径（install？restart？upgrade？）；
2. 找 NocoBase 里**只在真正停机时触发**的钩子（例如 `app.on('afterStop')` 或生命周期 `stop()` 内的插槽）；
3. 若确实没有干净钩子，则采用**不依赖钩子**的方案：
   - `onTick` 里用一个 **in-flight 集合**记录正在跑的 sweep；
   - `onTick` 捕获 DB 错误并按"停机中"分类（把 `connection manager was closed` 降级为 info 且不重试）；
   - 停止时不强行 removeJob，而让 Job 在下次启动时被幂等复用 —— 靠**租约**保证一致性。
4. 上述任选其一都要**先做代码审查**，再谈部署。

---

## 7. 生产纪律

| 项                       | 状态                               |
| ----------------------- | -------------------------------- |
| 本轮部署                    | **无**（`0b04e189` 未部署）            |
| 生产 DB / 插件 / Nginx / H5 | **未动**                           |
| 生产上传 / 删除 / 提交 / 短信     | **0**                            |
| 隔离实例当前运行                | `948c1206`（**含错误守卫**，S14 在该版本失败） |
| 历史孤儿 / 50 MiB 媒体 1、2    | 保留                               |
| Git                     | **未 commit / 未 push**            |

---

## 8. 状态

| 项               | 状态                      |
| --------------- | ----------------------- |
| S11             | PASS / CLOSED           |
| R1              | PASS（已验证范围）             |
| **S14**         | **FAIL**（当前部署版本）        |
| **L1**          | **未通过**（12 条关闭后 SQL 异常） |
| S12 / S15 / S16 | 未开始                     |
| RECOVERY CORE   | 不申请                     |
| ROUTE-01        | HOLD                    |

**按令 §八**：生命周期停止点尚未确认，**不再靠试错改代码并部署**，改走专项代码审查。

P6：LIVE / CONDITIONAL；Release：HOLD。
