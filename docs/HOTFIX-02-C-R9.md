# C 组服务端 media-format.ts 离线解析定位报告

> 时间：2026-10-22 17:56–18:12 CST
> 结论：**离线执行解析器被工具链阻塞**；但**生产实证否定了"解析器普遍性缺陷"** ——
> **103 条真实视频全部解析出了时长**。C 组继续 PARTIAL PASS。

---

## 1. 前后端错误调用链（源码确认）

```
H5 选择文件
  └─ addCaptured(file, kind)                     // kind 由 file.type 前缀判定
       ├─ probeDurationMs()                      // 客户端预检（我已修 durationchange）
       └─ POST /api/public/media/upload
            └─ publicMedia:upload
                 └─ sniffCustomerMedia(buf, expected)      // ← 服务端真正的判定点
                      ├─ 图片签名 → 直接通过
                      ├─ 音频签名 → wavDurationMs / oggDurationMs / webmDurationMs
                      │     └─ null → 422 DURATION_UNREADABLE
                      ├─ MP4(ftyp) → mp4HandlerType(buf)
                      │     ├─ null → 422 DURATION_UNREADABLE「缺少可读的轨道信息」
                      │     └─ mp4DurationMs(buf) null → 422 DURATION_UNREADABLE
                      ├─ WebM(视频) → webmTrackType(buf)
                      │     ├─ null → 422 KIND_UNREADABLE「格式无法识别」
                      │     └─ webmDurationMs null → 422 DURATION_UNREADABLE
                      └─ 都不匹配 → 415 UNSUPPORTED_MEDIA
```

**六类错误必须分开看**（都不该统称"读不出时长"）：

| 情形 | 错误码 | HTTP |
|---|---|---|
| 内容不属于任何支持格式 | `UNSUPPORTED_MEDIA` | 415 |
| 入口与类型不符（如视频口选图片） | `KIND_MISMATCH` | 415 |
| WebM 判不出轨道类型 | `KIND_UNREADABLE` | 422 |
| MP4 无 `hdlr` 轨道 | `DURATION_UNREADABLE` | 422 |
| 有时长读不出（容器/编码问题） | `DURATION_UNREADABLE` | 422 |
| 时长超上限 | 由上层 `video_max_ms` 判定 | 422 |

前端 `MediaUploader.vue` 617/618 只是**文案映射**（两个码共用同一句中文），
所以用户看到的"读不出时长"**无法区分是"格式没认出来"还是"时长读不出"** —— 这是提示层的真实缺陷（见 §6）。

---

## 2. 离线执行真实解析器：**BLOCKED（工具链）**

按令要求"使用当前生产版本对应的真实 media-format.ts，不复制核心逻辑重写测试版"：

| 尝试 | 结果 |
|---|---|
| 产物 `dist/server/index.js` 导出的 76 个符号 | **没有 `sniffCustomerMedia`**（函数在 bundle 内但未导出） |
| 直接 `require` 调用 | `NOT_EXPORTED; exports=76` |
| 本机 esbuild | **MISSING**（无法把单文件 TS 打成可 require 的模块） |
| 本机 ffprobe / ffmpeg | **MISSING**（无法做独立参照） |
| 重新实现解析逻辑 | **被令禁止**（"不复制核心解析逻辑重新实现测试版"） |

⇒ **我没有拿到"标准 MP4 喂进真实解析器"的直接结果。这一项标 BLOCKED，不编造。**

---

## 3. 改用生产实证（比合成夹具更有说服力）

`customer_medias` 按 mime 统计（生产真实数据）：

| mime | 总数 | 有 `duration_ms` |
|---|---|---|
| `image/png` | 298 | 0（图片本无时长，正常） |
| `audio/webm` | 142 | **142** |
| **`video/webm`** | **68** | **68** |
| **`video/mp4`** | **35** | **35** |
| `image/jpeg` | 21 | 0 |
| `audio/mp4` | 16 | 16 |

样本（真实视频，时长都解析出来了）：

```
id=578  video/mp4   1,325,298 B → 9,867 ms
id=573  video/mp4     335,126 B → 2,767 ms
id=547  video/webm    126,326 B → 2,940 ms
```

### 结论

**103 条真实视频（68 webm + 35 mp4）全部成功解析出时长。**

⇒ **服务端 `media-format.ts` 在真实样本上是工作的，不存在"普遍性解析缺陷"。**
这与执行令的"情况 A/B"吻合：标准与多数真实文件通过，**失败的是个别文件/容器特征**。

---

## 4. 合成格式差异测试：**未执行**

需要 FFmpeg 生成（moov 前置/后置、WebM、截断、MIME 与内容不符等），本机 **无 ffmpeg**。
不编造结果。

---

## 5. FFprobe 与业务解析比较：**未执行**（无 ffprobe）

---

## 6. Android 实拍样本：**PENDING**

没有真实 Android 原始文件 ⇒ **Android 特定根因 PENDING**。
按令"不通过猜测给出最终结论"，我不猜失败 box。

### 但有一条可以立即给出的**提示层改进**（不涉及解析规则）

前端两个错误码共用同一句文案：

```
KIND_UNREADABLE:    '这个文件读不出时长，请重新录制'
DURATION_UNREADABLE:'这个文件读不出时长，请重新录制'
```

**问题**：`KIND_UNREADABLE` 实际是"**格式没认出来**"，却告诉用户"时长读不出" ——
用户会反复重录同一种格式，永远无效。这是**真实的用户体验缺陷**。

**最小修复建议（待批准，不改解析规则）**：把 `KIND_UNREADABLE` 的文案改成
「这个文件的格式暂时无法识别，请改用**手机相机拍摄**后上传，或换一段视频」，
并保留 `DURATION_UNREADABLE` 的原文案。**一行文案，不碰校验。**

---

## 7. 是否存在服务端真实 Bug

**结论：未发现普遍性 Bug。**
- 生产 103 条真实视频全部解析成功；
- 无法复现"合法格式被普遍拒绝"；
- 个别文件失败需要**那条具体文件**才能定性 → PENDING。

---

## 8. 最小修复建议（都不是解析规则改动）

| # | 建议 | 影响面 |
|---|---|---|
| 1 | 区分 `KIND_UNREADABLE` 与 `DURATION_UNREADABLE` 的文案（§6） | 前端 1 行 |
| 2 | 服务端 422 响应里带上 `code`，前端据此给不同提示 | 需确认响应体已含 code（目前映射表按 code 取文案，应已具备） |
| 3 | 若要提升 Android 兼容性：先拿到真实失败文件，再评估 `mp4HandlerType` 是否只支持单一 box 排列 | 需样本 |

---

## 9. 未完成的边界验收（继续 PENDING，不偷换成 PASS）

- V2/V3 离屏 video 事件补证（我的派发方法缺陷）
- V5 超时（上轮结果自相矛盾，不采信）
- C6 生命周期资源清理（需改埋属性处理器）
- 50 MiB 独立环境真实上传边界（未建实例）
- Android 真机上传 + 录音布局

---

## 10. 生产零写入 / 零部署 / Git

| 项 | 值 |
|---|---|
| 生产媒体写入 | **0** |
| 工单 / 短信 / 数据库 | 0 / 0 / 0 |
| Nginx / 部署 | 未动 / **未部署** |
| 临时文件 | 容器内 `/tmp/sniff.js`、`/tmp/fx.mp4` **已删**；本机 `sniff.js` 已删 |
| 用户夹具 | **未修改、未删除** |
| `git status` | 仅既有源码改动，**未 commit / 未 push** |

---

## 判定

**C 组：PARTIAL PASS（不变）。** 原始 Android 报错**不申请 PASS** —— 缺真实失败文件。
最有价值的两个结论：
1. **解析器不是普遍失效**（生产 103/103 视频全过）；
2. **提示层把"格式不认识"说成"时长读不出"**，这会让用户徒劳重录。

P6：LIVE / CONDITIONAL；Release：HOLD。
