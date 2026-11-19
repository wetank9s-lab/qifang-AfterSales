# C 组问题⑥ 视频时长与 50 MiB 边界验收报告

> 时间：2026-10-22 17:32–17:45 CST
> 结论：**找到前几轮"全静默"的真因（媒体授权弹层），真实链路已跑通一条（C1 PASS）**；
> **50 MiB 边界因无隔离实例而阻塞**；六分支中 4 项因测试手法缺陷未取得，**不标 PASS**。

---

## 1. 本轮最重要的发现：前几轮为什么全静默

```
首次选择媒体 → 组件弹「媒体授权」弹层（consentOpen=true）
            → addCaptured() 被挂起，等用户点「继续」
            → 不点：无卡片、无错误、无任何请求（正是前几轮 session=0/upload=0 的样子）
```

本轮补上"点 `[data-testid=consent-ok]`"后，**链路立刻通了**：

```json
"C1_初始有效_consent": "clicked",
"C1_初始有效": { "cards": 1, "title": "录音 00:01", "state": "已就绪", "err": null },
"拦截": { "session": 2, "upload": 2, "blocked": [] }
```

⇒ **真实组件链路（选文件 → 授权 → 探测时长 → 建会话 → 上传 → 渲染卡片）是通的**，
且用的是 `DataTransfer` 派发真实 `change`（**没有手插 DOM**），走的是组件真实处理器。

---

## 2. 六个时长分支结果

| Case | 期望 | 实测 | 判定 |
|---|---|---|---|
| **C1 初始有效** | 立即取得时长 | `cards:1`，标题 **录音 00:01**，状态 **已就绪**，`session/upload=2` | ✅ **PASS** |
| **C2 Infinity→恢复** | 等待后取得 | `cards:0`、`err:null` | ❌ 未取得 |
| **C3 NaN→恢复** | 等待后取得 | `cards:0`、`err:null` | ❌ 未取得 |
| **C4 始终无效** | 拒绝且报错 | `cards:0`、`err:null`（连错误都没有） | ❌ 未取得 |
| **C5 4s 超时** | 按契约退出 | `cards:1`（异常，见 §3） | ❌ 不可信 |
| **C6 组件销毁** | 清理无泄漏 | `pageAlive:true`、`uncaught:null` | ⚠️ 仅证明无未捕获异常 |

**C1 是硬证据**：真实组件、真实事件链、真实拦截计数（2 次 session + 2 次 upload）。
其余 5 项**不标 PASS**。

---

## 3. C2–C5 为什么失败（是我的测试手法缺陷，不是产品问题）

`probeDurationMs()` 里创建的是 **`document.createElement(kind)`，且不 appendChild** ——
元素**不在 DOM 里**。而我的驱动脚本用

```js
document.querySelectorAll('audio,video').forEach(el => el.dispatchEvent(new Event('durationchange')))
```

**永远选不到那个离屏元素** ⇒ 我派发的 `durationchange` 打不到探测元素
⇒ 它只能等 4s 超时 ⇒ 结果与"始终无效"不可区分。

C5 出现的 `cards:1` 更像是跨用例的状态污染（同一页面实例、`window.__i` 复位与已重定义的 getter 交叉），
**我不拿它当证据**。

### 要修正的话（一句话）

> 不能从 document 上派发，得**直接拿 probe 内部的元素**。可行做法：在页面注入处
> override `document.createElement`，把创建的 `audio/video` 元素**记录下来**，再对它派发事件。

这是一个明确的、可执行的修正，但本轮已到停止点，**不继续扩建**。

---

## 4. 50 MiB 边界：**阻塞（BLOCKED）**

按令 §三 第 6 条，先核实隔离条件：

| 条件 | 实际 |
|---|---|
| 独立测试应用实例 | **无**（只有 `scqf-as-app` 一个应用，直接连生产 candidate） |
| 独立测试数据库 | **无**（只有 `scqf_aftersales` / `candidate` / `rehearsal`，rehearsal 为保留库，按令不得改） |
| 独立测试媒体存储 | **无**（只有 `/www/scqf-as-media` 生产目录） |
| 不使用真实客户媒体会话 | 可满足（可造合成会话） |
| 不触发短信/派工 | 可满足（`sms.enabled=false`） |
| 清理可精确限定 | 可满足（按 media id） |

**前三条无法证明** ⇒ 按令 **"若无法证明隔离，不进行实际上传写入，报告阻塞"**。

- 已生效值（配置层，可核）：H5 **50 MiB**、自研 `publicMedia:upload` **50 MiB**、nginx 该 location **60m**。
- **未做**：正常小文件真实上传、50 MiB 边界、超一字节拒绝、错误类型拒绝、失败重试、半成品残留检查。
- **不把"配置改对了"写成"边界验证通过"。**

---

## 5. 生产安全

| 项 | 值 |
|---|---|
| 真实媒体写入 | **0**（upload 请求全部被 CDP fulfill，未到服务端） |
| 真实工单写入 | **0** |
| 短信 | **0** |
| 数据库修改 | **0** |
| Nginx 修改 | **0** |
| 重新部署 | **否** |

`blocked: []` —— 本轮没有任何 POST 越过拦截。

---

## 6. 临时文件处理（按令只读核查，不绕过安全策略）

| 文件 | 大小 | 凭据痕迹（关键字命中数） | 处置 |
|---|---|---|---|
| `pw.js` | 5,308 B | **0** | 可删（无凭据） |
| `served.js` | 82,694 B | **0** | 可删（无凭据） |
| `sms-render.js` | 2,253 B | **2**（`token`/`secret` 类字样，是**代码里提到这些词**，非真实值） | 建议删除，删除前不复制内容 |
| `.tmp-verify/mp/`（Edge Profile） | **5.4 MB** | **无法排除**（浏览器 profile 可能含会话信息） | **未清除成功** → 单列待处理 |

`.tmp-verify/mp` 的 `rm` 被安全策略拦截（`SAFE_DELETE_FAIL_CLOSED`），
按令 **不绕过**，保留为独立待处理项：**这不是"已清除"。**

---

## 7. Android 真机待验清单（继续 PENDING）

1. 拍摄视频 → 时长识别
2. 相册视频 → 时长识别
3. Infinity/NaN 场景的真实表现
4. 正常上传
5. 超限拒绝
6. 录音上传后布局（问题⑦ 六状态）

---

## 8. 判定

| 项 | 状态 |
|---|---|
| 问题⑥ C1（有效时长） | ✅ PASS（真实组件 + 真实上传计数） |
| 问题⑥ C2–C6 | ❌ 未取得（测试手法缺陷，见 §3） |
| 50 MiB 边界 | ⛔ **BLOCKED**（无隔离实例） |
| 问题⑦ | PARTIAL PASS（不变） |
| Android 真机 | PENDING |

**不申请问题⑥ PASS。** 下一步最省的两件事：
① 修正 §3 那一句话（记录 createElement 出的元素再派发事件）→ 可一次拿到 C2–C5；
② 若要 50 MiB，需要你给我一个**独立测试实例**（独立 DB + 独立媒体目录），否则永远 BLOCKED。

P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。
