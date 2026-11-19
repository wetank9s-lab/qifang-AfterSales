# 问题⑦ 移动端录音布局最终补证

> 时间：2026-10-23 09:54–10:10 CST
> 结论：**遮挡/可操作性 = PASS**；**ready 态截图仍未取得**（并且**必须撤回上一轮的"已就绪"结论**）。

---

## 0. 先更正上一轮的一个错误结论（重要）

上一轮我写「录音 00:01 / **已就绪**」。本轮把状态文本读出来了：

```json
{"state":"网络不太稳定，请点「重试」","code":"NETWORK_ERROR","cls":"svc-mat-state is-failed"}
```

**卡片实际处于 `is-failed` 状态，不是"已就绪"。**

原因：我的 XHR 桩**没拦住 upload 请求**，请求透到真实网络、又被我自己的 `Fetch.failRequest` 中止
⇒ `xhr.onerror` ⇒ `NETWORK_ERROR`。

**所以我撤回上一轮的"已就绪"表述。** 布局测量数值仍然有效（失败态与就绪态共用同一套卡片 CSS），
但"状态"这个结论是错的，不能留。

---

## 1. 固定底栏遮挡与可操作性 —— **PASS**

| 项 | 390px | 320px |
|---|---|---|
| 滚动到底 | `scrollTop=394 / max=394` ✅ | `449 / 449` ✅ |
| `overflowX` | **0** | **0** |
| 卡片底边是否在视口内 | **true**（卡 386–494） | **true**（卡 353–475） |
| 固定底栏 `.svc-submit-fixed` | **y=722–770**（h=48） | **y=722–770** |
| 底栏与卡片是否重叠 | **不重叠**（494 < 722） | **不重叠**（475 < 722） |
| 安全区 `padding-bottom` | 0px | 0px |

⇒ **滚到底后整张卡片（含播放器、按钮）完整露出，固定底栏没有挡住它。**

### 真实指针命中测试（不是 `.click()`）

| 测试 | 390px | 320px |
|---|---|---|
| `elementFromPoint`（播放器中心） | **AUDIO**（`mat-audio-player`）✅ | **AUDIO** ✅ |
| 实际派发 mousePressed/Released 后 | `currentTime` **0 → 0.15s**（真的在播）✅ | 播放控件可点 ✅ |
| 删除按钮中心命中 | BUTTON `mat-reaudio` ✅ | BUTTON ✅ |
| 真实点击删除结果 | **1 张 → 0 张**，`worked=true` ✅ | 同 ✅ |

⇒ **播放器与删除按钮都能被真实指针点到，没有被固定底栏截获。**

截图：`q7b-390-bottom.png`、`q7b-320-bottom.png`（均为滚动到底后的完整卡片）。

---

## 2. ready 态截图：**未取得**（桩未命中）

- 卡片从未进入 `done` 状态，因此拿不到真正的「录音 00:01 / 已就绪」画面；
- **我不拿失败态截图冒充 ready 态**，也不重复用同一张图当作不同状态证据；
- 修复方向（下一轮一次即可）：
  1. 桩的匹配改成 `u.includes('/media/upload')`，并在桩内加 `window.__stubHits++` 自证命中；
  2. 若 `__stubHits===0`，判定"桩未生效"，**先修测试不改产品**。

---

## 3. 是否需要 CSS 修复

**不需要。** 遮挡与点击两项都通过，未发现布局缺陷。

---

## 4. 生产零测试写入

| 项 | 状态 |
|---|---|
| 生产媒体上传 | **0**（请求被本地 `Fetch` 中止，未到服务端） |
| 工单 / 短信 / 数据库 | 0 / 0 / 0 |
| 部署 / Nginx / 解析器 / 上限 / 会话鉴权 | 未动 |
| 临时文件 | `q7b.js`、`a.wav`、profile 已删；2 张截图保留 |
| Git | **未 commit / 未 push** |

---

## 5. 判定

| 项 | 状态 |
|---|---|
| 固定底栏遮挡 / 可操作性（320 & 390） | **PASS** |
| ready 态截图 + 状态转换证据 | **PENDING（桩未命中）** |
| 移动端浏览器布局模拟（320–420 卡片内部） | PASS（上一轮，数值仍有效） |
| Android Chrome / iOS Safari 真机 | PENDING |
| 真实录音上传 | PENDING |

⇒ **问题⑦ 暂不 CLOSED**：只差 ready 态一张图 + 状态证据。

其余状态：MEDIA-50M-BOUNDARY-01 PASS/CLOSED、MEDIA-ERROR-COPY-01 PASS/CLOSED、
标准 MP4 解析 PASS/FROZEN、V2/V3/V5 TEST INVALID、C6 PARTIAL、
Android 原始故障 PENDING、**C 组 PARTIAL PASS**、P6 LIVE/CONDITIONAL、Release HOLD。
