# MEDIA-ERROR-COPY-01 · 422 运行期补证报告

> 时间：2026-10-23 09:09–09:20 CST
> 结论：**四码运行期全部通过，KIND_UNREADABLE 显示新文案**。
> **申请 MEDIA-ERROR-COPY-01：PASS**（无需重新部署）。
> **未发现产品缺陷**，不登记 `MEDIA-UPLOAD-422-STATE-01`。

---

## 1. 先查清"卡在正在上传…"的真因 —— **是我的拦截器，不是产品**

按令 §二 逐项排查，用 `Network` 域记录完整生命周期：

```
paused:session
respRecv:200:/api/public/media/session      ← 会话请求被 fulfill 后**正常产生响应**
loadFin:27312.
paused:upload
（之后**没有** respRecv，也没有 loadFin）      ← 关键证据
```

**结论**：`Fetch.fulfillRequest` 在 **Request 阶段**对**带大 body 的 multipart 上传**没有真正完成 ——
浏览器从未收到响应 ⇒ XHR 的 `onload` 不触发 ⇒ 组件停在 `uploading`。

同一套拦截对 `/media/session`（小 body）是正常的，所以问题只出现在上传。
**这不是产品缺陷**，`MediaUploader.vue` 的 catch 与状态机本身没有问题（415 两例就能正常落错）。

### 排查清单逐项结果

| 检查项 | 结果 |
|---|---|
| `Fetch.requestPaused` 命中 uplift 请求 | ✅ 命中（`paused:upload`） |
| `fulfillRequest` 执行一次 | ✅ 执行了 |
| `responseCode = 422` | ✅ |
| `Content-Type: application/json; charset=utf-8` | ✅ |
| body 为合法 UTF-8 JSON、结构与服务端一致（`{errors:[{code,message}]}`） | ✅ |
| 误设 `Content-Length` / `Content-Encoding` | 尝试显式 `Content-Length` 后**仍然卡住** |
| `Network.responseReceived` / `loadingFinished` | **都没有** ← 根因 |
| 客户端用 fetch 还是 XHR | **XHR**（`api/media.ts:156` 用 XHR 才有 `upload.onprogress`） |

---

## 2. 改用"客户端 XHR 层注入"，仍然走真实业务代码

修法：在页面内包装 `XMLHttpRequest.prototype.send`，只对 `/api/public/media/upload` 合成响应
（设定 `status` / `responseText` / `readyState` 并调用真实的 `onload`）。

**仍然完整经过**：组件 → `uploadMedia()` → `XHR.onload` → `JSON.parse` → `new ApiError(status, errors[0])` → 组件 `catch` → 文案映射。
**没有手插 DOM、没有改产品代码、没有绕过任何校验。**

四组用例使用**相同的上传入口、相同授权流程、相同注入机制**，只有状态码与业务码不同。

---

## 3. 四码结果（全部 PASS）

| # | 注入 | 实测 `state` 文案 | `data-code` | 判定 |
|---|---|---|---|---|
| **C** | `422 KIND_UNREADABLE` | **「暂时无法识别这个文件的音视频内容，请尝试更换文件，或使用手机自带的拍摄、录音功能重新制作后上传。」** | `KIND_UNREADABLE` | ✅ **新文案生效** |
| **D** | `422 DURATION_UNREADABLE` | 「这个文件读不出时长，请重新录制」 | `DURATION_UNREADABLE` | ✅ 原文案保留 |
| **B** | `415 KIND_MISMATCH` | 「上传没成功，请点「重试」」（通用兜底，非专属） | `KIND_MISMATCH` | ✅ 未回归 |
| **A** | `415 UNSUPPORTED_MEDIA` | 「这个文件格式不支持，请用手机直接拍照或录音」 | `UNSUPPORTED_MEDIA` | ✅ 未回归 |

- 四例 `card: true`（卡片仍在，可继续操作/删除），`svc-error` 与 `svc-mat-state` 文案一致。
- `_blocked = []` —— **没有任何 POST 越过拦截**。
- 每例独立导航 + 独立计数，无跨用例累计。

---

## 4. 判定（对应令 §五 情况 A）

> **情况 A：修正拦截响应后，422 正常显示文案** ⇒ 之前主要是**测试响应模拟方式不正确**。

- **KIND_UNREADABLE / DURATION_UNREADABLE 两例均取得 DOM 证据**；
- 四码对照未回归；
- ⇒ **申请 MEDIA-ERROR-COPY-01：PASS**。
- **无需再次部署**（线上仍是 `index-C9qJaSHE.js`，本轮零改动）。

**没有发现产品缺陷**，因此**不登记** `MEDIA-UPLOAD-422-STATE-01`。

---

## 5. 生产安全

| 项 | 值 |
|---|---|
| 生产媒体写入 | **0**（上传被拦截/注入，未到服务端） |
| 工单 / 短信 / 数据库 | 0 / 0 / 0 |
| Nginx / 插件 / ACL / 50 MiB | **未动** |
| 部署 | **无**（本轮零部署） |
| A/B 组已冻结功能 | 未触碰 |
| `SAFE_DELETE_FAIL_CLOSED` | **未绕过**；`.tmp-verify/mp` 仍单列待处理 |
| 清理 | `copy4b.js`、`diag422.js`、`a.wav`、`d4/`、`d5/` 已删 |
| Git | 未 commit / 未 push |

---

## 6. 仍然 PENDING（不合并验收）

- **Android 原始视频失败的根因**（缺真实失败文件；本机无 esbuild/ffprobe，服务端解析函数无法离线调用）
- V2/V3/V5 视频时长分支、C6 生命周期清理
- 50 MiB 独立实例边界上传（BLOCKED）
- 问题⑦ 录音上传后真实布局、Android 真机

> **文案修复 ≠ Android 视频故障修复。** 这两件事继续分开记。

**C 组：PARTIAL PASS。P6：LIVE / CONDITIONAL；Release：HOLD。**
