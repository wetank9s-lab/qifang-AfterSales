# UX-01B 第四轮：指定 SVG 接入与真机布局修复报告

> 日期：2026-10-17 · 前序：`UX-01B-R3-REPORT.md` · 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01C 未提交代码**未被触碰**
> **本轮未提交、未推送。**

## 一、按用户设计稿接入（不再自由设计）
- 解压 `ux01b-media-icons-pack.zip`，将 4 枚 SVG 复制到 **`h5/src/assets/media-icons/`**（camera/album/microphone/video）。
- `MediaUploader.vue` 以 **Vite 静态资源导入**（`import cameraIcon from '../assets/media-icons/camera.svg'` …），渲染为 `<img :src="cameraIcon" alt="" aria-hidden="true" />`；
  **未使用 Emoji、未替换成其它图标、未加 CDN/外部字体/UI 框架**。
- **保留**：`button` / `label` / `input[type=file]` / `takePhoto` / `onPickFromAlbum` / `onRecordClick` / `takeVideo` / 全部 `data-testid`（含 `pick-from-album`、`record-timer`）/ 上传与录制逻辑。

## 二、按预览图改成 2×2 横向图文卡片
- 新增 `.svc-media-actions`（2 列网格）与 `.svc-media-action`：**浅蓝圆角图标底座（43px, `#EDF4FF`）+ 30px 双色 SVG + 右侧「动作名 + 次要说明」**，卡片 74px 高、15px 圆角、`#DFE7F2` 边框。
- 文案与设计稿一致：**拍照/现场拍摄 · 相册/选择已有照片 · 录音/最长 60 秒 · 拍视频/最长 30 秒**。
- 整行浅蓝提示条：**「也可直接填写文字，任选一种即可说明问题。」**（`background:#EDF4FF`，独立成行，不参与两列网格）。

## 三、真机/小屏三个布局问题的根因与修复（§三，全部实测取证）
| 问题 | 真实根因 | 修复 |
|---|---|---|
| **375px 仍显示四列** | 第三轮遗留 `@media (min-width:390px) { .svc-capture { repeat(4) } }`；部分手机逻辑视口是 **393/412px（≥390）**，于是命中四列 | **删除该四列规则**；媒体区固定 **2×2**，不再随宽度变列 |
| **固定提交按钮遮挡隐私说明** | 第三轮的占位 `svc-submit-spacer` 放在**表单内部**，而隐私说明在表单**之后** ⇒ 说明被固定 CTA 盖住 | 移除表单内 spacer；改在**页容器** `.svc-page.has-fixed-cta` 加 `padding-bottom: calc(100px + safe-area)` ⇒ 隐私说明能滚到按钮上方 |
| **表单底部过大空白** | 表单内 spacer(76px) + 页面 padding 叠加 | 同上：只保留页面级一处占位 |

**实测（`elementFromPoint` + 几何关系）**：
```
✓ [375×667] 隐私说明未被提交按钮遮挡 —— footBottom=559 ctaTop=609
✓ [390×844] 隐私说明未被提交按钮遮挡 —— footBottom=736 ctaTop=786
✓ [420]     隐私说明未被提交按钮遮挡 —— footBottom=792 ctaTop=842
✓ 逐卡滚动入视口：拍照/相册/录音/拍视频 **4/4 均可命中**，且 bottom=371 ≤ ctaTop=609（不与提交按钮重叠）
```

## 四、真实扫码入口验收（`/h5/report?k=<门店入口>`）
```
✓ [375×667] 4 张媒体卡片 · 4 枚指定 SVG **均已加载**（naturalWidth>0）· 2×2 两列两行
            · 提示条浅蓝整行 · 无横向溢出
✓ [390×844] 同上 · 四卡首屏均可命中
✓ [420]     同上
✓ labels=["拍照","相册","录音","拍视频"] hints=["现场拍摄","选择已有照片","最长 60 秒","最长 30 秒"]
✓ 投诉真实提交（成功页）—— 「投诉提交成功」FW20261017-0011
```
> 首次判据在 375 首屏把"第 3/4 张卡在折叠下方（未入视口）"误判成"被遮挡"，**已改正为逐卡滚动入视口后判定**（4/4 通过）。这是测试口径问题，不是产品遮挡。

**截图**（`.tmp-verify/`）：`ux01b4-375x667-top/-bottom.png`、`ux01b4-390x844-top/-bottom.png`、`ux01b4-420-top/-bottom.png`、`ux01b4-complaint-375.png`、`ux01b4-success-375.png`。
构建产物：`index-UTn0gKXJ.js` / `index-DG4vnRwD.css`（nginx 已立即下发）。

## 五、仍未验证（PENDING，不冒称）
1. **媒体-only 真实提交**（不填文字、仅照片/录音/视频）—— 未跑。
2. **上传失败 / 提交失败恢复** —— 未做定向失败注入。
3. **真机软键盘**弹出时输入框与提交按钮的相互遮挡 —— 仅静态/模拟视口，**未真机实测**。
4. **真实 iPhone Safari** —— 环境无真机，**PENDING**。
5. 媒体入口**实际触发文件选择/相机**的点击链路未在真机验证（DOM 与 `data-testid` 保持不变）。

## 六、Git 与审计
- `git status`：**46 个变更文件**（本轮新增：`h5/src/assets/media-icons/*.svg` ×4；修改：`MediaUploader.vue`、`base.css`、`Report/index.vue`）。
- `git diff --check`：**干净**；增量密钥审计对全部变更文件 → **exit 0**；临时脚本已删除。
- **未提交、未推送。**

## 七、结论
- 已**直接采用用户提供的 4 枚双色 SVG**，按预览图落成 **2×2 横向图文卡片**；同时**根因修复**了三处真机布局问题（四列残留、固定 CTA 遮隐私说明、底部空白）。
- 三视口真实截图 + 四卡命中 + 数据加载 + 真实提交均通过；**但媒体-only 提交、失败恢复、真机键盘与 iPhone Safari 仍 PENDING**，本轮不宣布 UX-01B 整体 PASS。
