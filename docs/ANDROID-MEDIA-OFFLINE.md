# Android 媒体解析离线验证报告

> 时间：2026-10-23 09:13–09:22 CST
> 结论：**首次真正跑通服务端解析器**。标准 H.264 MP4 → `video/mp4`、**4000ms**，无任何错误。
> **Android 根因仍 PENDING**（缺真实失败样本）。

---

## 1. 工具链：受管 workspace 里确实有 esbuild（关键发现）

上次判定"无法离线执行"是**我找错了地方** —— esbuild 不在仓库 `node_modules`，而在：

```
C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild
```

用 `NODE_PATH` 指向它 + `esbuild.buildSync` 把**真实源码**打成临时 CJS：

```
entryPoints: nocobase/plugins/service-ticket/src/server/services/media-format.ts
→ .tmp-verify/mf.cjs   101,126 B   errors: 0
```

**没有修改生产模块导出**（打包只读源码，产物在 `.tmp-verify/`，用完即删）。
**没有复制或重写解析算法** —— 跑的就是 `sniffCustomerMedia()` 本体。

---

## 2. 标准 MP4 实际结果（已执行 ✅）

夹具：`c6_duration_fixture_4s.mp4`，258,819 B，sha256 `93b97e60…`（与令一致）。

| 调用 | 结果 |
|---|---|
| `sniffCustomerMedia(buf, 'mixed')` | `{kind:'video', mime:'video/mp4', ext:'mp4', durationMs:4000}` ✅ |
| `sniffCustomerMedia(buf, 'video')` | 同上 ✅ |
| `sniffCustomerMedia(buf, 'audio')` | `KIND_MISMATCH`「这个入口只接受语音，请重新选择」✅（正确拒绝） |
| `sniffCustomerMedia(buf, 'image')` | `KIND_MISMATCH` ✅ |

**逐条对照令 §四 的四个目标**：

| 目标 | 结果 |
|---|---|
| 接受对应容器 | ✅ `video/mp4` |
| 识别 video 轨道 | ✅ `kind='video'` |
| 取得约 4000ms 时长 | ✅ **精确 4000** |
| 不产生 KIND/DURATION_UNREADABLE | ✅ 无错误 |

⇒ **服务端解析器对标准 H.264 MP4 完全正常。**

---

## 3. 截断对照（额外做的，帮助定位失败分支）

| 样本 | 结果 |
|---|---|
| 完整文件 | `video` / **4000ms** ✅ |
| 截断 50% | `video` / **4000ms**（仍通过） |
| 末尾少 1 KB | `video` / **4000ms**（仍通过） |
| **只给头部 512 B** | **`DURATION_UNREADABLE`｜「无法识别这个视频/语音文件（缺少可读的轨道信息）」** |

两条有价值的信息：

1. **解析器相当宽容** —— 不需要完整文件，截断一半仍能读出时长；
2. 那句「缺少可读的轨道信息」**精确对应 `mp4HandlerType(buf) === null`** 这条分支
   （即：在缓冲区里找不到可读的 `hdlr` 轨道信息）。

---

## 4. 对原始 Android 报错的推断边界

**可以说**（有实测支撑）：
- 解析器本身没坏（标准 MP4 通过、103 条生产视频也都有时长）；
- 若用户看到「缺少可读的轨道信息」，那一定是 `mp4HandlerType` 返回 null。

**不能说**（无样本，不推断）：
- 不能说 Android 文件一定是 `hdlr` 位置问题 —— **假设**可能是：`moov/hdlr` 在解析器扫描范围之外、
  或容器并非标准 MP4（3GP / fMP4 / 非规范 box 顺序）。**这是假设，不是结论。**

⇒ **Android 根因 PENDING**，需要那条真实失败文件。

---

## 5. 未执行 / 无法执行

| 项 | 原因 |
|---|---|
| Android 实拍文件对比 | 无样本 |
| FFprobe 独立参照 | 本机无 ffprobe/ffmpeg |
| WebM/3GP/fMP4 对照 | 无夹具（且改扩展名伪造被禁止） |
| 生产环境复现 | 按令禁止

---

## 6. 生产边界

| 项 | 值 |
|---|---|
| 生产上传 / 工单 / 短信 / 数据库 | **0 / 0 / 0 / 0** |
| 服务端解析规则、白名单、权限、大小上限 | **未改** |
| 服务重启 / Nginx / 短信配置 | **未动** |
| 生产模块导出 | **未改**（只读源码 + 临时产物） |
| 临时产物 | `mf.cjs` **已删** |
| `SAFE_DELETE_FAIL_CLOSED` | 未绕过（`.tmp-verify/mp` 仍单列待处理） |
| Git | 未 commit / 未 push |

---

## 7. 状态

| 项 | 状态 |
|---|---|
| **MEDIA-ERROR-COPY-01** | **PASS / CLOSED** |
| 标准 MP4 服务端解析 | ✅ **已执行并通过** |
| Android 原始报错根因 | **PENDING**（缺真实样本） |
| 视频 V2/V3/V5、C6 | PENDING |
| 50 MiB 独立实例 | BLOCKED |
| 问题⑦ 录音真实布局 | PENDING |
| **C 组** | **PARTIAL PASS** |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |

---

## 8. 下一步只差一样东西

**一条真实的 Android 失败视频原文件**（测试人员自拍、无个人信息、不转码）。

拿到后我可以立刻用现在这套离线链路跑：
- 浏览器能否播放；
- `sniffCustomerMedia()` 返回什么码；
- 如果是 `DURATION_UNREADABLE`，具体是 `mp4HandlerType` 还是 `mp4DurationMs` 返回 null；
- 失败 box 的位置/类型。

**在这之前，我不会对 Android 根因下任何结论。**
