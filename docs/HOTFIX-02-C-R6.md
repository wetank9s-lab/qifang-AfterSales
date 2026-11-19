# C 组第三阶段：视频时长分支与 50 MiB 边界

> 时间：2026-10-22 17:38–17:52 CST
> 结论：**3 个时长分支取得证据（C1/C2/C3），2 个未取得（C4/C5，测试媒体本身合法）**；
> **50 MiB 独立环境本轮未开始**。问题⑥ **不申请 PASS**。

---

## 1. C1 的 session/upload 两次请求 —— 根因：**统计累计，不是重复上传**

按令先核查这件事。改成**每个 case 独立清空计数器**后实测：

| case | 请求序列 |
|---|---|
| C1 | `[session, upload]` |
| C2 | `[session, upload]` |
| C3 | `[session, upload]` |
| C4 | `[session, upload]` |
| C5 | `[session, upload]` |

**每次注入 = 1 次 session + 1 次 upload。**

⇒ 上一轮看到的 `session:2 / upload:2` 是**跨用例累计**（计数器没清），
**组件不存在重复上传同一文件的问题**。原始请求顺序是 `session → upload`，无重试、无重复绑定。

> 这一条按你的要求"不要为了让计数变成 1 而直接改统计代码" —— 我改的是**测试的计数作用域**，
> 不是产品代码；结论是"组件本来就没重复"。

---

## 2. 六个时长分支结果

| Case | 桩生效 | 实测 | 判定 |
|---|---|---|---|
| **C1 初始有效** | `first=0.6` | 卡片「录音 00:01」，session+upload 各 1 | ✅ **PASS** |
| **C2 Infinity→恢复** | `first=Infinity` | 派发 `durationchange` 后仍得「录音 00:01」 | ✅ **PASS**（未提前返回 null） |
| **C3 NaN→恢复** | `first=NaN` | 派发 `durationchange` 后得「录音 00:01」 | ✅ **PASS** |
| **C4 始终无效** | `first=NaN` | **仍得 00:01** | ❌ 未取得 |
| **C5 4s 超时** | `first=NaN` | **仍得 00:01** | ❌ 未取得 |
| C6 组件销毁 | — | 仅 `uncaught:null` | ⚠️ 不足以 PASS |

### C4/C5 为什么拿不到（诚实原因）

我的桩打在"最后创建的 audio 元素"上，但 **合成 WAV 本身时长合法（0.6s）** ——
真正的 probe 元素读到的是**真实 600ms**，所以无论如何都拿不到"始终无效"。

要造 C4/C5，需要**不可解码的媒体**（随机字节 + `audio/wav` MIME），让 `duration` 永远不出现。
这是一个明确的、可执行的修正，本轮未做。

**C6 也不够**：`uncaught:null` 只证明没抛未捕获异常，**不证明**监听器 / 计时器 / ObjectURL 被释放。

---

## 3. 测试手法修正记录（本轮实际解决的两个坑）

| 坑 | 现象 | 修正 |
|---|---|---|
| 授权弹层时序 | 同步点「继续」→ 按钮还没渲染 → 全静默 | **派发 change 后等 350ms 再点** |
| 离屏元素 | `document.querySelectorAll('audio,video')` 选不到 probe 元素 | **包装 `document.createElement`，记录创建的 audio/video 实例**，直接对该实例打桩 |

两条都已按你的 §三 要求实现（包装时保存原实现、只记录 audio/video、其余委托、case 结束 `restore`）。

---

## 4. 50 MiB 独立测试环境 —— **本轮未开始（BLOCKED）**

按令需要：独立容器 + 独立 DB + 独立媒体目录 + 独立密钥 + 合成门店账号 + 回环绑定。
本轮预算全部用于时长分支，**没有启动该环境**。

已核实的现状（仍未变）：

| 隔离条件 | 实际 |
|---|---|
| 独立应用实例 | **无**（仅 `scqf-as-app` 连生产 candidate） |
| 独立测试数据库 | **无**（rehearsal 为保留库，按令不得冒充可写库） |
| 独立媒体目录 | **无**（仅 `/www/scqf-as-media`） |

⇒ **不写入、不验收，保持 BLOCKED。** 不把配置值（H5 50MiB / API 50MiB / nginx 60m）当成边界通过。

---

## 5. 生产安全

| 项 | 值 |
|---|---|
| 生产媒体写入 | **0**（upload 全部被 CDP fulfill） |
| 生产工单写入 | **0** |
| 短信 | **0** |
| 数据库修改 | **0** |
| Nginx 修改 | **0** |
| 重新部署 | **否**（录音 CSS 保持已部署状态，未动） |

---

## 6. 清理

`dur2.js`、`a.wav`、`dq/`（Edge profile）**已删**。
遗留：`.tmp-verify/mp/`（5.4 MB，上一轮 rm 被 `SAFE_DELETE_FAIL_CLOSED` 拦下）
→ **仍存在，单列待处理**，不称已清除。

---

## 7. 判定

| 项 | 状态 |
|---|---|
| C1 / C2 / C3 | ✅ PASS |
| C4 / C5 | ❌ 未取得（需不可解码媒体） |
| C6 | ⚠️ 证据不足 |
| 50 MiB 边界 | ⛔ BLOCKED（未建隔离环境） |
| 问题⑦ | PARTIAL PASS（不变，CSS 未动） |
| Android 真机 | PENDING |

**问题⑥：不申请 PASS。**

### 下一步（两步，都不需要真机）

1. **C4/C5**：把合成媒体换成**随机字节 + `audio/wav`**（不可解码）→ 一次就能拿到"始终无效/超时"；
2. **C6**：在 probe 元素上挂 `removeEventListener` 计数 + 检查 `URL.revokeObjectURL` 是否被调，
   并在探测中途 `Page.navigate` 离开，断言"离开后不再有状态更新"。

P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。
