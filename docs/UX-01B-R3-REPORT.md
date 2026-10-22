# UX-01B 第三轮：媒体图标统一与小屏遮挡修复报告

> 日期：2026-10-17 · 前序：`UX-01B-R2-REPORT.md` · 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01C 未提交代码**未被触碰**
> **本轮未提交、未推送。**

## 一、三处定向修复（仅 3 个 H5 文件）
| 文件 | 改动 |
|---|---|
| `h5/src/components/MediaUploader.vue` | ① **删除全部 Emoji**（📷🖼️🎤🎬），改为 **4 个内联线性 SVG**；② 提示精简为「**可填写问题，也可只上传照片、录音或视频。**」并作为**独立整行**（在 `.svc-capture` 网格之外） |
| `h5/src/styles/base.css` | ③ `.svc-ico`：24×24、`stroke-width:1.8`、`stroke=currentColor`（主题蓝），四个按钮 `min-height:80px`、同圆角/边框；④ 网格断点 `≥390px` 才四列，**375px 保持 2×2**；⑤ **取消通用 `.svc-submit` 的 sticky**，新增 `.svc-submit-fixed`（fixed）+ `.svc-submit-spacer`（76px 真实占位） |
| `h5/src/pages/Report/index.vue` | 两个表单 CTA 加 `svc-submit-fixed`，并在其后插入 `svc-submit-spacer`（报修/投诉各一处） |

**未改**：媒体上传接口与能力、匿名 Token、时长校验、私有存储、建单/状态机、门店归属、隐私告知内容；**未触碰 UX-01C 的未提交文件**。
**未引入**：外部图标 CDN、新 UI 框架（h5 没有图标依赖 ⇒ 用内联 SVG，符合 §一）。

## 二、真实浏览器验收（`/h5/report?k=<门店入口>`）—— **✅ 22 项 / 0 失败**
```
✓ [375×667] 四个线性 SVG 图标 · 无 Emoji · 提示独占整行(313/313px) · 四按钮均可命中 · 高度 80/80/80/80 · 无横向溢出(0)
✓ [390×844] 同上（提示 328/328px）
✓ [420]     同上（提示 358/358px）
✓ [375/390/420] 滚动到底：四按钮**仍可命中**（吸底 CTA 不再遮挡）
✓ 投诉真实提交（成功页）—— 「投诉提交成功」FW20261017-0010
```
> 遮挡判定用 `elementFromPoint(按钮中心)` 是否落在按钮自身，**不是**只看"提交按钮可点"。

**新截图**（`.tmp-verify/`）：`ux01b3-375x667-top/-bottom.png`、`ux01b3-390x844-top/-bottom.png`、`ux01b3-420-top/-bottom.png`、`ux01b3-complaint-375.png`、`ux01b3-success-375.png`。

**人工核对项**：无 Emoji ✓；四图标同一线性风格（24px/1.8/圆头）✓；标签「拍照/相册/录音/拍视频」完整 ✓；提示独占整行 ✓；「补充信息（选填）」整行（上一轮已是 `<summary>`，本轮未改其结构，未见箭头分离）✓；吸底 CTA 不遮媒体 ✓；无横向溢出 ✓；相册入口仍可触发（input 仍绑定 `onPickFromAlbum`）✓。

## 三、旧门禁（`verify-phase3-h5.mjs`）：40/1 —— 两条失败的对应关系（§五）
| 失败断言 | 真实原因 | 处理口径 |
|---|---|---|
| `恰好 1 个 201 + 9 个 200，无 429 —— 出现 6 个 429` | **IP 频控**被本轮密集验收触发 | **不关闭、不降低**正式限流；改测试节奏/隔离（间隔、少次真实建单） |
| `响应体恰好三个字段 —— 实际 created_at, progress_token, store_name, ticket_no` | 门禁的字段白名单**落后于真实契约**（P11-4 已加 `progress_token`） | 应把断言更新为**精确 4 字段白名单**（`created_at/progress_token/store_name/ticket_no`），**不得**放宽成"任意字段"；`progress_token` 是**凭证**，只在断言里比对字段名，**不写入报告/日志** |

> 本轮**未修改**该门禁（避免顺手改断言）；上述是核对结论与建议，另开小项处理。

## 四、仍未验证（PENDING，不冒称）
1. **媒体-only 真实提交**（不填文字、仅照片/录音/视频）—— 未跑（需 `DOM.setFileInputFiles` 注入）。
2. **上传失败 / 提交失败恢复** —— 未做定向失败注入。
3. **真机软键盘**弹出后的可视区/按钮可点 —— 仅 375 滚动 + `elementFromPoint` 验证，**未真机实测**。
4. **真实 iPhone Safari** —— 环境无真机，**PENDING**，不以桌面 Chromium 冒充。

## 五、Git 与审计
- `git status`：**44 个变更文件**（本轮改动：`MediaUploader.vue`、`base.css`、`Report/index.vue`）。
- `git diff --check`：**干净**；增量密钥审计对全部变更文件 → **exit 0**（`progress_token` 未写入任何报告/日志）；临时脚本已删除。
- **未提交、未推送。**

## 六、结论
- **图标统一**（4 枚线性 SVG，同尺寸/线宽/颜色）、**媒体提示独占整行**、**375×667 吸底 CTA 不再遮挡媒体区**（真实 `elementFromPoint` 验证）。构建产物 `index-Bg6Fh8qk.js` / `index-DEz50904.css` 已由 nginx 立即下发。
- 本轮**不宣布 UX-01B 整体 PASS**：媒体-only 提交、失败恢复、真机键盘与 iPhone Safari 仍 PENDING。
- 项目状态不变：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD。
