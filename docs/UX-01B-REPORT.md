# UX-01B 客户 H5 界面整改报告

> 日期：2026-10-17 · 基建：`h5/`（独立 Vite 应用）· 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A 保持（本轮不触碰）
> **本轮未提交、未推送。** 结论来自真实构建 / 真实 Nginx / 真实浏览器（真实 H5 入口 URL）。

## 一、客户原先看不到新 UI 的真实原因（**不是缓存，也不是部署链路坏**）

逐项取证（§一）：

| 检查 | 实测结论 |
|---|---|
| H5 是否独立构建 | **是**：`h5/` 独立 Vite 应用（`vite.config.ts` `base:'/h5/'`），`cd h5 && vite build` → `h5/dist` |
| Nginx 静态配置 | `location ^~ /h5/` 直接读 `h5/dist`（bind mount `→ /usr/share/nginx/html/h5/`）|
| 服务端返回 vs 本地产物 | **逐字节一致**：`curl -k https://127.0.0.1/h5/index.html` 引用 `index-DGYL9G_q.js` / `index-Cz3HlZjl.css`，与 `h5/dist/index.html` **完全相同** |
| 产物是否来自当前源码 | **是**：`h5/dist`（Oct 14 18:09）由 `h5/src/pages/Report/index.vue`（Oct 14 11:56）构建 |
| 浏览器缓存 / Service Worker / 旧目录 / 另一路由 | **均无异常**（H5 无 SW；`/h5/` 唯一入口；二维码入口即 `/h5/report?k=…`） |

**根因**：**UX-01A 只改了 NocoBase 后台客户端，从未改过 H5**（H5 首屏精简属 UX-01B，此前未获授权）。
⇒ 客户扫码看到的**就是当时的源码**（长表单）。**本轮因此是"真正改源码 + 重新构建 + 部署"**，不是修缓存。

## 二、修改文件（3 个）
| 文件 | 改动 |
|---|---|
| `h5/src/pages/Report/index.vue` | ① 报修选填字段（家电类别/品牌型号/服务地址）折叠进原生 `<details>`「补充信息（选填）」；② 新增 `focusin` 监听：输入框聚焦后滚到可视区中部（G16） |
| `h5/src/styles/base.css` | ① `.svc-extra` 折叠样式 + **`.svc-extra:not([open]) > .svc-field { display:none }`**（关键：`.svc-field{display:flex}` 会覆盖 `<details>` 默认隐藏）；② 输入框 `scroll-margin`；③ `.svc-submit` **吸底**（`position:sticky; bottom: calc(10px + env(safe-area-inset-bottom))`） |
| `h5/index.html` | viewport 增 `interactive-widget=resizes-content`（软键盘压缩内容区而非盖住页面） |

未改：媒体上传、匿名 Token、时长校验、私有存储、隐私告知、成功页/进度查询、服务端任何校验（§四 全保留）。

## 三、构建与部署证据（§五 部署验证）
```
构建前（旧）：/h5/assets/index-DGYL9G_q.js · index-Cz3HlZjl.css     ← 与 dist 一致（旧 UI）
构建后（新）：/h5/assets/index-YC7WwpPJ.js · index-F3bbZe-b.css     ← vite build 1.18s，nginx 立即返回新哈希
```
- H5 为 bind mount ⇒ **重新构建即部署**（无需 `restart app`；`build-plugin.mjs`/`restart app` 与 H5 无关）。
- 服务端 `/h5/index.html` 与 `h5/dist/index.html` 引用同一对新哈希 ⇒ **对外入口返回的是最新产物**。

## 四、真实浏览器验收（真实入口 `https://…/h5/report?k=<门店入口>`）—— **✅ 22 项 / 0 失败**

**界面（3 个视口）**：
```
✓ [390×844] 头部=「四川七方连锁售后服务平台」 · 报修/投诉切换首屏可见 · 提交按钮首屏可见
            · 选填字段默认折叠 · 折叠时家电类别不可见 · 无横向溢出(0px)
✓ [375×667] 同上全部通过
✓ [420]     同上全部通过
✓ 展开「补充信息」后选填字段出现
✓ 投诉表单不出现家电类别/服务地址
```
**真实操作**：
```
✓ 投诉真实提交成功 —— 成功页「投诉提交成功」FW20261017-0003
✓ 报修真实提交成功 —— 成功页「报修提交成功」FW20261017-0004
· 服务端归属：FW20261017-0001 → store=S01、ticket_type=complaint、source=qr（与扫码门店一致）
```
**截图**（真实视口）：`ux01b-repair-390x844.png` · `ux01b-repair-375x667.png` · `ux01b-repair-420.png` · `ux01b-complaint-390.png`（均在 `.tmp-verify/`，随交付展示）。

## 五、未验证事项与风险（如实标 PENDING，不冒充）
1. **真实 iPhone Safari**：未做（环境无真机）——**不以桌面 Chromium 冒充**。
2. **软键盘实际弹出后的可视区/按钮可点**：仅实现（viewport `interactive-widget` + `focusin` 滚动 + 吸底 CTA）与静态断言，**未在真机键盘下实测**。
3. **媒体提交（不填文字、仅照片/录音/视频）**：本轮只验了"文字提交"的真实链路；**媒体-only 提交未跑**（需 `DOM.setFileInputFiles` 注入，未做）。
4. **上传失败 / 提交失败 / 重试**：未做定向失败注入实测。
5. **Nginx `/h5/` 缓存头**：未核对（本轮只证明"产物更新后 nginx 立即返回新哈希"）。
6. **改版"前"截图**：旧产物已被 `emptyOutDir` 覆盖，**未能保留旧版首屏截图**（只有新旧哈希与源码对照；after 截图齐全）。

## 六、Git 与审计
- `git status`：**16 已跟踪修改 + 13 新增 = 29**（本轮新增 `h5/index.html`、`h5/src/pages/Report/index.vue`、`h5/src/styles/base.css` 三项修改）。
- `git diff --check`：**干净**；增量密钥审计对**全部变更文件** → **exit 0**；临时验收脚本已删除（`scripts/_tmp_*` 无残留）。
- **未提交、未推送。**

## 七、结论
- 客户看不到新 UI 的原因**已查清并已实际修复**：H5 源码首次被真正整改 + 重新构建 + 立即部署（新哈希已在对外入口生效）。
- 手机首屏：**报修/投诉切换 + 核心填写区 + 提交按钮同屏可见**；选填字段默认折叠；无横向溢出；报修/投诉**真实提交成功**且归属门店=S01、类型正确。
- **仍 PENDING**：真机 Safari、软键盘实测、媒体-only 提交、失败重试、缓存头核对、改版前截图。
- 项目状态不变：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01A 保持。
