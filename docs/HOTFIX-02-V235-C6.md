# 视频 V2/V3/V5 与 C6 生命周期收口报告

> 时间：2026-10-23 09:26–09:36 CST
> 结论：**V2/V3/V5 仍 TEST INVALID**（probe 的 duration getter 读取次数为 0）；
> **但资源生命周期拿到了硬证据**（ObjectURL 逐 URL 释放 + 计时器被清）。
> 按令 §八 **停止扩建 Harness**。

---

## 1. 元素定位：改用"身份判据"，但仍没打到 probe

本轮按令要求，不再硬编码首/末元素，改为：

- 每个 `<video>` 创建时分配**唯一序号**；
- 保存**真实引用**（不再 `querySelectorAll`）；
- 创建瞬间打桩 `duration` 并**逐元素统计读取次数**；
- 判定 probe 的**判据**：probe **从不插入 DOM** ⇒ `el.isConnected === false`。

实测：

```json
"seqs": ["1(off):0", "2(dom):0"]
```

- **seq1 = 离屏元素（probe 候选）**，**读取次数 0**；
- seq2 = 卡片预览（在 DOM 里），读取次数 0。

⇒ **`duration` getter 一次都没被调用** ⇒ `probeReads: []`。

### 判定：**TEST INVALID（V2/V3/V5）**

按令 §三："如果 getter 读取次数为 0，直接 TEST INVALID"。
**我不拿"卡片显示了 00:04"当通过**，也不硬编码元素制造通过。

**定位失败的具体证据**：元素创建序号与 `isConnected` 都正确，`setH` 显示四个属性处理器**全部被赋值**
（`onloadedmetadata|ondurationchange|onloadeddata|onerror`），说明**选中的确实是组件正在使用的元素**；
但组件读 `duration` 时**没有经过我的 getter** —— 说明我的 `defineProperty` 被某种方式绕过/覆盖。
**具体机制未查明，不再猜。**

---

## 2. 意外收获：资源生命周期证据（这部分是硬的）

V5（duration 恒 NaN、等待 5.2s 覆盖完整 4s 窗口）：

| 观测 | 值 | 含义 |
|---|---|---|
| `timers` / `cleared` | **1 / 1** | **4s 超时计时器被 `clearTimeout`** ✅ |
| `urls` / `revoked` | 2 / 1 | 创建 2 个 ObjectURL，释放 1 个 |
| **`urlMatched`** | **1** | **按 URL 精确匹配**（不是只比次数）✅ |
| `setH` | 四个全赋值 | 属性处理器确实在用 |
| `clearH` | **空** | **从不把事件属性置 `null`**（登记事实，不推断泄漏） |

⇒ **超时路径的清理是可靠的**：计时器被清、对应的 ObjectURL 被精确释放。
`clearH=[]` 只记录事实 —— 元素被丢弃后由 GC 回收，**不认定内存泄漏**。

---

## 3. 另一条重要行为观察（视频 vs 音频不同）

V5 中：

```json
"cards": 1, "title": "视频 —", "reqs": ["session"]
```

- 卡片**生成了**，但标题是 **「视频 —」**（时长未知）；
- **只发了 session，没有 upload**。

⇒ **视频时长未知时：不上传**（卡片保留、标"—"）。这与音频"null 仍放行上传"**正好相反**，
再次印证"方案 A 只适用于音频，视频是 fail-closed"。

---

## 4. C6：一半成立、一半 TEST INVALID

| 子例 | 结果 |
|---|---|
| **A 正常/超时结束** | ✅ 计时器被清、ObjectURL 按 URL 释放（见 §2） |
| **B 探测中途卸载** | ❌ **TEST INVALID** —— `history.pushState + popstate` **没有让路由卸载**（5s 后 `mounted: true`），所以"卸载后是否还有异步任务"没被判到 |

B 的负向证据仍有一点价值：同一观察窗口内 4s 定时器照常触发并 revoke，**说明超时路径会自己收尾**，
即使组件没被卸载。

---

## 5. 是否需要最小产品修复

**当前不建议改任何产品代码。**
- 资源清理（计时器 + ObjectURL）在超时路径上是**正确**的；
- `clearH=[]` 属"没有显式解绑"，在元素被丢弃的前提下不构成实际泄漏；
- 视频 null 时长不上传，行为**符合 fail-closed**。

若将来要彻底消除"无显式解绑"的疑虑，可选的最小改动是在 `probeDurationMs` 的 `finally` 里
把四个 `on*` 属性置 `null`（一行），**但这不是缺陷修复，只是洁癖**，不申请授权。

---

## 6. 零生产写入

| 项 | 值 |
|---|---|
| 上传 / 工单 / 短信 / 数据库 | **0 / 0 / 0 / 0** |
| 上传请求 | 全部在页面内 XHR 桩处理，`Fetch` 对 upload 直接 abort |
| 解析器 / 白名单 / 权限 / 上限 | 未改 |
| Nginx / 部署 / 重启 | 未动 / 未部署 / 未重启 |
| 临时产物 | `v27.js`、`d7/` 已删 |
| Git | 未 commit / 未 push |

---

## 7. 状态

| 项 | 状态 |
|---|---|
| MEDIA-ERROR-COPY-01 | **PASS / CLOSED** |
| 标准 MP4 服务端解析 | **PASS / FROZEN** |
| **V2 / V3 / V5** | **TEST INVALID（维持 PENDING）** |
| **C6-A 资源清理** | ✅ **拿到证据**（计时器 + ObjectURL 逐 URL 匹配） |
| **C6-B 卸载后行为** | **TEST INVALID**（未能真正卸载） |
| Android 原始故障 | **PENDING**（无样本） |
| 50 MiB 隔离边界 | **BLOCKED** |
| 问题⑦ 录音真实布局 | **PENDING** |
| **C 组** | **PARTIAL PASS** |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |

---

## 8. 如果还要继续这三项，需要换思路（不再扩建 Harness）

我已经连续三轮没能控制到 probe 的 `duration` 读取。**继续加埋点大概率还是打偏。**

更可靠的替代（都不需要新 Harness）：

| 目标 | 办法 |
|---|---|
| V2/V3/V5 | **在隔离环境给 `probeDurationMs` 写真正的单元测试**（把函数从 SFC 里抽出来 import）—— 但那是重构，需你授权 |
| C6-B | 用**真实的 Vue Router 跳转**（点击页面里的链接），而不是 `pushState` 伪造 |
| Android 根因 | 一条真实失败视频 |

**我建议先停下这三项**，把力气放到 50 MiB 隔离实例或 Android 样本上 —— 那两项的阻塞是资源/样本，不是测试手法。
