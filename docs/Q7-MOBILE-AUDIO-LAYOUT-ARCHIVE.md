# Q7-MOBILE-AUDIO-LAYOUT · 归档记录

> 状态：**PASS / CLOSED（浏览器模拟范围）**
> 关闭时间：2026-10-23
> 本项**不再追加测试**。

---

## 1. 验收范围（严格限定）

移动端浏览器模拟环境中，**真实 `MediaUploader.vue`** 的：

- 录音卡片布局（320 / 375 / 390 / 420）
- 上传成功后的 **ready（已就绪）** 状态
- **失败**状态
- 媒体卡片的**操作可触达性**（真实指针命中）

---

## 2. 通过证据清单

| # | 证据 | 结果 |
|---|---|---|
| 1 | 四宽度横向溢出 | **均为 0**（scrollW == clientW） |
| 2 | 播放器位置 | 独占卡片**第二行**，宽 = 卡片宽 − 18（240/295/310/340） |
| 3 | 删除按钮 | 41 × 44，可见可点 |
| 4 | 多卡片 / 删除重排 | 2~3 张排列正常；删除后 3 → 2 正常重排 |
| 5 | 滚动到底的固定底栏 | 卡片 386–494，底栏 722–770 ⇒ **不遮挡** |
| 6 | 真实指针命中 | `elementFromPoint` → **AUDIO**；播放后 `currentTime` 0 → 0.15s；真实点击删除 1 → 0 |
| 7 | 双通道拦截 | session = `fetch`；upload = `XMLHttpRequest`，**两者均被桩接管** |
| 8 | `stubHits` | **session = 1，upload = 1** |
| 9 | `onloadRan` | **1** |
| 10 | 组件真实状态 | `svc-mat-state **is-done**` |
| 11 | 界面文案 | **「录音 00:12 / 已就绪」** |
| 12 | 两态截图 | 成功态 / 失败态**各自独立**（字节与哈希不同） |
| 13 | 网络逃逸 | **`netEscaped = []`** ⇒ 无生产媒体写入 |

---

## 3. 归档截图

| 状态 | 文件 | 字节 | SHA-256（前 16 位） |
|---|---|---|---|
| **成功（已就绪）** | `q7d-390-ready.png` | **41,526** | `e87a32d74602a6d0` |
| **失败** | `q7c-390-failed.png` | 49,240 | `79fec8deecf31a8e` |

> ⚠️ 归档规则：**旧的失败态图不得复用作成功态证据。**
> 早期 `q7-390-ready.png` / `q7b-390-bottom.png` 实为失败态画面，仅作过程记录，**不作为验收证据**。

---

## 4. 测试方法结论（本次最重要的沉淀）

**双通道事实**：

```
session → fetch
upload  → XMLHttpRequest
```

**只桩 XHR 的后果**：session 透到网络 → 失败 → 卡片 `is-failed` + `NETWORK_ERROR` → **upload 根本不发生**。
我因此连续误判三轮（每次都看到"卡片显示了标题"，就以为到了 ready）。

**可复用的正确做法**：

1. 用 `Page.addScriptToEvaluateOnNewDocument` **在业务脚本之前**注入桩；
2. **fetch 与 XHR 都桩**；
3. 用 `stubHits` 计数 + `Network.requestWillBeSent` 逃逸记录**自证测试有效**；
4. `hits = 0` 或 `netEscaped ≠ []` ⇒ 直接判 **TEST INVALID**，不解释为产品问题；
5. 截图按**字节数 + 哈希**区分状态，避免"一张图顶两个状态"。

---

## 5. 明确不代表（继续 PENDING）

| 项 | 状态 |
|---|---|
| Android Chrome 真机录音上传成功 | **PENDING** |
| iOS Safari 真机录音上传成功 | **PENDING** |
| 远程音频文件实际加载与播放 | **PENDING** |
| Android 原始视频 422 故障已修复 | **PENDING** |
| V2/V3/V5 时长测试通过 | **TEST INVALID / PENDING** |
| C6 生命周期清理全部通过 | **PARTIAL / PENDING** |

---

## 6. 停止重复投入

- 不再为问题⑦制作 Harness
- 不再调整该卡片 CSS
- 不重新部署生产
- 不提交测试媒体
- 不改音频时长策略 A / 服务端解析器 / 会话授权 / Nginx / 数据库 / ACL
- 未经授权不 commit、不 push

---

## 7. 项目状态

| 项 | 状态 |
|---|---|
| MEDIA-50M-BOUNDARY-01 | PASS / CLOSED |
| MEDIA-ERROR-COPY-01 | PASS / CLOSED |
| 标准 MP4 解析 | PASS / FROZEN |
| **问题⑦ Q7-MOBILE-AUDIO-LAYOUT** | **PASS / CLOSED（浏览器模拟）** |
| Android 视频原始故障 | PENDING |
| Android Chrome / iOS Safari 真机 | PENDING |
| 真机录音上传及播放 | PENDING |
| V2/V3/V5 | TEST INVALID / PENDING |
| C6 生命周期 | PARTIAL / PENDING |
| MEDIA-AUDIO-DURATION-01 | 遗留风险（音频 null 时长不阻断 60s 上限） |
| **C 组** | **PARTIAL PASS** |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |
