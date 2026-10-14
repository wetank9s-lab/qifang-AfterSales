# 真实浏览器媒体样本（P11-4 第三批）

这些文件是 **Chromium MediaRecorder 真实产出**（headless + fake media device），
不是手工拼装的容器。用途：让"服务端从内容判定媒体类别与时长"这件事**有真实字节守着**。

| 文件 | 浏览器自报 mime | 大小 | 真实结构（`scripts/ebml-probe.py` 复核） |
|---|---|---|---|
| `audio-chrome.webm` | `audio/webm;codecs=opus` | 40,666 B | Tracks@195 · **TrackType=[2]**(audio) · Duration=2940ms |
| `video-chrome.webm` | `video/webm;codecs=vp8,opus` | 126,326 B | Tracks@195 · **TrackType=[2,1]**(audio+video) · Duration=2940ms |

## 为什么入库

第一版服务端解析器用"在字节流里搜 ID"的方式找 `TrackType`，并据此得出
**"真实产物没有 Tracks"** 的错误结论 —— 真因是字节搜索**命中了 SeekHead 里的 SeekID**
（`0x1654AE6B` 作为"对元素 ID 的引用"出现在那里），从那儿往后找 `0x83` 自然命中了 Info 的 MuxingApp。
（见 `docs/DEVIATIONS.md` **DEV-183**。）

⇒ 手工拼的夹具**无法**复现"引用 vs 定义"这种混淆。只有真实字节能守住这条路径。

## 如何重新生成

```bash
node storage/tmp/capture-real-media.mjs     # 需要本机 Chrome；产出到 storage/tmp/real-media/
```

⚠️ 重新生成后请同步本目录并更新上表（时长/大小会变）。
