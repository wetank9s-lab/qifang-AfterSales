# C 组第五阶段：时长策略、视频分支与格式识别

> 时间：2026-10-22 17:51–18:06 CST
> 结论：**视频分支用真夹具跑通 1 例**；**找到原始报错的真正来源 —— 服务端，不是前端**；
> 50 MiB 独立实例仍未建。C 组继续 PARTIAL PASS。

---

## 1. 方案 A 执行情况（音频放行）

**未改任何代码**。`addCaptured()` 里 `durationMs === null` 对音频仍然放行，与裁决一致。

**登记风险：`MEDIA-AUDIO-DURATION-01`**
> 当 `durationMs=null` 时，`audio_max_ms`（60 秒）**不能保证被执行**。
> 因此**不得再宣称"所有音频均已可靠执行 60 秒上限"**。
> 后续应评估：录制过程计时 / 服务端真实时长校验 / 媒体时长二次探测。

---

## 2. C4/C5 真实探测返回值（把"探测结果"与"上传策略"分开记录）

| 项 | 探测结果 | 上传策略 |
|---|---|---|
| C4 始终无效 | `duration` 读取 **4 次全为 NaN** → `probeDurationMs` 返回 **null** | 方案 A：**仍放行上传**（`cards:1`、session+upload 各 1） |
| C5 4 秒超时 | 同样 4 次 NaN → **null**；`setT:1 / clrT:1`（超时计时器被清） | 同上 |

⇒ **不能因为"卡片生成/上传成功"就推断"时长探测成功"** —— 这两件事在本项目里是**解耦**的。这一条我记进报告，避免以后误读。

---

## 3. C6 生命周期：仍无证据（不申请 PASS）

上一轮已说明：组件用的是 `el.onloadedmetadata = …` 属性处理器，我的 `addEventListener` 埋点**测不到**。
本轮**未重做**该项（预算用于视频分支），维持 **PENDING**。

需要补的最小改法：埋 `HTMLMediaElement.prototype` 上 `onloadedmetadata/ondurationchange/onloadeddata/onerror` 的
setter，看卸载后是否被置 `null`，以及 `revokeObjectURL` 的调用时机。

---

## 4. 视频分支（用你提供的真 MP4）

夹具核验：

```
c6_duration_fixture_4s.mp4   size=258819
sha256=93b97e60c2c4088a87283d79583b62ba24de764777431a711f6a113d11045c90  ✅ 与令一致
```

| Case | 结果 |
|---|---|
| **V1 初始有效（4.0s）** | ✅ **卡片「视频 00:04」/ 已就绪**，`session+upload` 各 1 次，`reads=valid×3` |
| V2 Infinity→恢复 | ⚠️ `cards:0` —— **我的问题**：`document.querySelectorAll('video')` 选不到 probe 的**离屏**元素，`durationchange` 派不到它 |
| V3 NaN→恢复 | ⚠️ 同上 |
| **V4 始终无效** | 🔴 `cards:0`（`reads=never×4`）→ **视频的 null 时长会阻断上传**，与音频放行**不同** |
| V5 超时 | ❌ 结果自相矛盾（`reads=never` 却 `cards:1`、00:04），**不采信** |

**两条有价值的结论**：
1. **视频分支在真实 MP4 上工作正常**（4 秒 → 显示 00:04）；
2. **视频是 fail-closed、音频是放行** —— 这正好印证"方案 A 只适用于音频，不得扩大到视频"。

---

## 5. 🔴 原始报错的真正来源：**服务端**（本轮最关键的发现）

全仓搜 `KIND_UNREADABLE` / `DURATION_UNREADABLE`：

- `h5/src/components/MediaUploader.vue`：**只有文案映射**（617/618 行），**没有任何地方抛出它们**；
- 真正抛出点在 **`nocobase/.../services/media-format.ts`**：

| 位置 | 条件 | 错误 |
|---|---|---|
| MP4 · 711 | `mp4HandlerType(buf) === null` | 422 `DURATION_UNREADABLE`「缺少可读的轨道信息」 |
| MP4 · 748 | `mp4DurationMs(buf) === null` | 422 `DURATION_UNREADABLE` |
| WebM · 764 | `webmDurationMs === null` | 422 `DURATION_UNREADABLE` |
| WebM · 728 | `webmTrackType === null` | 422 `KIND_UNREADABLE` |

⇒ **服务端用纯 JS 解析容器**（moov/mvhd、WebM Segment/Info），**不依赖 ffprobe**。

### 这意味着什么（必须说清）

我上一轮部署的 **客户端 `durationchange` 修复只解决了"前端那一半"**。
用户最初看到的「这个文件读不出时长，请重新录制」，**很可能来自服务端解析失败（422）**，
所以**那条修复并不能宣布最初报告已解决**。

### 后续只读定位清单（本轮未做，需真实 Android 文件）

1. `mp4HandlerType` / `mp4DurationMs` 对 **Android 常见 MP4（H.264+AAC，moov 在尾部）** 的解析路径；
2. WebM 分支对 Chrome MediaRecorder 产物（无 Tracks）的处理；
3. 是否存在**合法格式被误判**（这是最可能的缺陷方向）；
4. 服务端与客户端对"可接受格式"的清单是否一致。

> 我没有 Android 真机文件，**不猜测具体失败字节**。真机验证继续 **PENDING**。

---

## 6. 50 MiB 独立实例：**未建**

预算全部用于视频分支与根因定位。维持 **BLOCKED**，不写入、不验收。

---

## 7. 生产零测试写入

| 项 | 值 |
|---|---|
| 生产媒体写入 | **0**（upload 全被 CDP fulfill） |
| 工单 / 短信 / 数据库 | 0 / 0 / 0 |
| Nginx / 部署 | 未动 / 否 |
| `SAFE_DELETE_FAIL_CLOSED` | 未绕过；`.tmp-verify/mp` 仍存在，单列待处理 |

清理：`vid.js`、`dv/` 已删；用户夹具原文件**未修改、未删除**。

---

## 8. 判定

| 项 | 状态 |
|---|---|
| 方案 A（音频放行） | ✅ 已执行并登记 `MEDIA-AUDIO-DURATION-01` |
| C4/C5 探测值 | ✅ 已取得（null），与上传策略分开记录 |
| C6 生命周期 | ❌ PENDING |
| 视频 V1 | ✅ PASS |
| 视频 V2/V3 | ⚠️ 我的派发方法缺陷（离屏元素），非产品问题 |
| 视频 V4 | ✅ 取得（视频 fail-closed） |
| 视频 V5 | ❌ 不采信 |
| KIND_UNREADABLE 根因 | ✅ **定位到服务端**；具体失败条件需真机文件 |
| 50 MiB | ⛔ BLOCKED |

**问题⑥ 不申请 PASS。** C 组继续 PARTIAL PASS。

### 下一步（按性价比）

1. **服务端格式解析**是原始报错的关键 —— 建议下一步就用你这条 MP4（以及一条 Android 实拍视频）**直接喂 `media-format.ts` 的解析函数**（可离线跑，不写库），看它到底在哪一步返回 null；
2. C6 改埋属性处理器；
3. 50 MiB 需要你确认是否搭独立实例。

P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。
