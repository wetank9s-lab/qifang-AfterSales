# C 组问题⑦ 最后一次定向补证报告

> 时间：2026-10-22 17:29–17:38 CST
> 结论：**上传流程仍未启动，断点已定位到"真实文件选择需要系统对话框"这一无头环境的固有限制**。
> **问题⑦ 维持 PARTIAL PASS**，按令停止扩建 Harness。

---

## 1. 动态 input 的真实创建与事件链（本轮诊断，非猜测）

### 1.1 源码事实

| 入口 | 实现 | 是否经 file input |
|---|---|---|
| 📷 拍照 / 🎬 拍视频 | `pickWithCapture()` 用 `document.createElement('input')`，`capture=environment`，**插入 body 后 `click()`** | 是（**动态创建**） |
| 🎤 录音 | **`onRecordClick` → MediaRecorder** | **否，完全不经过 file input** |
| 🖼 相册 | 模板里的常驻 `<input type="file" data-testid="pick-from-album">`，`accept="image/*,video/*,audio/*"` | 是（**常驻**） |

⇒ **录音路径不是文件选择**，这也是上一轮"对相册 input 设文件却没启动录音"的原因之一。

### 1.2 运行时实测（390×900）

```json
"B1_点击前_input": [ { "testid": "pick-from-album", "accept": "image/*,video/*,audio/*",
                       "disabled": false, "hidden": false } ]
"B2_录音按钮": []                       ← 录音按钮没有 data-testid，只能按文案定位
"B3_点录音后_input数": 1                 ← 点击录音**没有**新增 file input（印证走 MediaRecorder）
"B4_录音后状态": { "recordingButtons": ["录音\n最长 60 秒"], "error": null }
```

### 1.3 设文件后的真实结果（断点位置）

```json
"C2_设文件后": { "cards": 0, "error": null, "upHint": false }
"C3_拦截":     { "session": 0, "upload": 0, "blocked": [] }
```

**关键判读**：
- input 存在、**未禁用、未隐藏**；
- CDP `DOM.setFileInputFiles` 之后：**没有卡片、没有错误提示、没有会话请求、没有上传请求**；
- 若 `addCaptured()` 被执行，至少会出现「读不出时长」的错误文案（`probeDurationMs` 返回 null 时）——
  **连这个都没有**，说明 **`change` 处理器根本没被触发**。

⇒ **断点：CDP 设置文件没有触发组件的 `change`**，`addCaptured()` 从未进入。

---

## 2. 这是方法限制，不是产品缺陷（重要）

组件设计是**用户手势 → 打开系统文件选择器 → 选文件 → change**。
无头浏览器里没有系统文件对话框，`setFileInputFiles` 是"绕过对话框直接塞文件"的旁路——
它在本环境（Edge Headless 100 / ConPTY 会话）下**没有派发 `change`**。

**我没有证据说这是产品问题**；相反，现网真实客户能正常上传（生产已有 576 个媒体），
说明该链路在真实浏览器里是通的。

---

## 3. 六种状态的实际结果

| 状态 | 结果 |
|---|---|
| ① 上传中 | ❌ 未触发 |
| ② 上传成功 | ❌ 未触发 |
| ③ 上传失败 | ❌ 未触发 |
| ④ 播放中 | ❌ 未触发（无卡片） |
| ⑤ 长文件名 | ❌ 未触发 |
| ⑥ 删除 | ❌ 未触发（0 张卡片可删） |
| 375/390/420 几何 | ❌ 全部 null（上一轮）；本轮只做诊断，未重复 |

**一项都不申请 PASS。**

---

## 4. 生产安全（本轮）

| 项 | 值 |
|---|---|
| 真实媒体写入 | **0** |
| 真实工单写入 | **0** |
| 短信 | **0** |
| 数据库修改 | **0** |
| Nginx 修改 | **0** |
| 重新部署 H5 | **否**（CSS 保持上一轮已部署版本） |
| 会话 / 上传请求到达服务端 | **0**（`session=0, upload=0`） |

---

## 5. 临时资源清理

| 项 | 结果 |
|---|---|
| `diag.js` / `a.wav` | 已删 |
| `sp2/`（Edge profile） | 已删 |
| 遗留：`pw.js` / `served.js` / `sms-render.js`（更早轮次的本地分析脚本） | 仍在 `.tmp-verify`，无敏感内容 |
| 遗留：`.tmp-verify/mp`（Edge profile） | 删除被安全策略拦下 |

---

## 6. 停止条件（按令 §7 执行）

1. ✅ 保留当前 CSS 修复（已部署，不回滚）
2. ✅ 问题⑦ 继续 **PARTIAL PASS**
3. ✅ **不再扩建 Harness**
4. ⏭ 转向 C 组其它未完成项

---

## 7. 若将来要拿到这六种状态，最省的办法

**不需要再写 CDP**：

| 方式 | 成本 |
|---|---|
| **你在手机上录一段音、提交** → 我用 CDP 量那张卡（375/390/420 全几何） | 30 秒，且顺带消掉 Android 真机 PENDING |
| 或者你给我一张"录音上传后"的手机截图 | 一眼就能看出是否错位 |

理由：真实文件选择本来就是**人机交互**，无头环境天生缺这一环。

---

## 8. C 组整体剩余

| 项 | 状态 |
|---|---|
| 问题⑦ CSS 修复 | ✅ 已上线（三视口空表单 0 溢出、B-UX-01 44px） |
| 问题⑦ 上传后六状态 | **PENDING**（本轮已证为方法限制） |
| 问题⑥ duration 六分支 | **PENDING** |
| 50 MiB 边界/超限 | **PENDING**（需独立测试实例） |
| Android 真机 | **PENDING** |

**C 组：PARTIAL PASS。**

P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。
