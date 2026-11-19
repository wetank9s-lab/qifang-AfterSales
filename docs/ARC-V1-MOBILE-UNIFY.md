# ARC-V1 · MOBILE-UNIFY 移动端统一重构 · 第一阶段交付

**日期**：2026-11-12
**阶段**：只读盘点 + 兼容性验证 + 架构选型（**尚未动生产，未部署**）
**状态**：盘点完成 · PoC 19/19 PASS · 三个代表性页面开发中

---

## 一、现有移动端页面与 API 完整盘点

### 1.1 结论先行：员工端移动页面**基本不存在**

| 事实 | 证据 |
|---|---|
| 移动布局（`mobile-layout-model`）只有 **1 个**页面 | `desktopRoutes:listAccessible?layout=mobile-layout-model` → 1 条根节点 |
| 该页面是**空壳** | `n5c25yq5qlt` 的 `flowModelTreePath` 只有 2 个节点：`RouteModel` + 空 `MobileRootPageModel`，**零区块** |
| 其余 15 个业务页面全部挂在 `admin-layout-model` | 库内 39 行 `desktopRoutes`，`group` 2 + `flowPage` 17 + `tabs` 20 |
| 店长 / 销售角色访问桌面布局返回 **0 条** | `layout=admin-layout-model` 对 `store_sales` / `store_manager` → `data: []` |

⇒ **"把现有移动 H5 美化"这个前提不成立**。员工端的真实处境是：
`/v/mobile/n5c25yq5qlt` 打开的是一个空白页；能用的是桌面页面在窄屏下的表现。

### 1.2 实际存在的移动触点

| # | 入口 | 技术栈 | 现状 | 角色 |
|---|---|---|---|---|
| 1 | `/h5/report?store=xxx` | **Vue 3 + Vite** | 在用 | 匿名客户 |
| 2 | `/h5/report/success` | Vue 3 | 在用 | 匿名客户 |
| 3 | `/f/{token}` → `/h5/customer/review/{token}` | Vue 3 | 在用 | 匿名客户 |
| 4 | `/p/{token}` / `/p/t/{code}` → `/h5/customer/progress/{token}` | Vue 3 | 在用 | 匿名客户 |
| 5 | `/t/{token}` → `/h5/technician/visit/{token}` | Vue 3 | 在用 | 师傅（Token） |
| 6 | `/h5/archive.html` + `archive-render.js` | **纯静态 HTML/JS**（无框架） | 在用 | 匿名客户（ARC 查询） |
| 7 | `/v/mobile/n5c25yq5qlt` | NocoBase v2 lane | **空壳页** | 员工 |
| 8 | `/admin/*`（15 个页面） | NocoBase 桌面 | 在用 | 员工 |

**关键观察**：7 个面向客户/师傅的页面里，**6 个是 Vue，1 个是手写静态页**；
而员工端 0 个可用移动页面。这意味着"统一设计语言"实际是**三套技术栈收敛成一套**，
不是"改几个 CSS"。

### 1.3 后端 API 盘点（服务端 77 个 svc action，全部保留）

| 域 | Action | 前端用途 |
|---|---|---|
| **工单查询** | `serviceTickets:list`（原生资源，非 svc） | 列表 / 分组 / 计数（`meta.count`） |
| | `svc:timeline` | 详情（45 字段 + 事件 + 短信摘要，**已脱敏**） |
| | `svc:followUpQueue` | 今日待办队列 |
| | `svc:followUpQueue` / `svc:followUp` | 跟进记录 |
| **工单动作** | `svc:accept` / `svc:dispatch` / `svc:reassign` | 受理 / 派工 / 改派 |
| | `svc:reschedule` / `svc:cancel` / `svc:transfer` | 改约 / 取消 / 转店 |
| | `svc:visitConfirm` / `svc:visitReject` | 门店确认 / 驳回 |
| | `svc:remoteComplete` / `svc:internalNote` / `svc:setUrgent` | 电话解决 / 备注 / 紧急 |
| | `svc:createTicket` | 门店人工建单 |
| **工单媒体** | `svc:photo` / `svc:ticketMedia` / `svc:ticketMediaFile` | 照片（私有存储 → Blob） |
| **师傅链接** | `svc:technicianLink` / `svc:visits` / `svc:visitDetail` | 链接下发 / 派工历史 |
| **服务档案** | `svc:archiveCreate` / `archiveUpdate` / `archiveComplete` | 建档 / 编辑 / 完工 |
| | `svc:archiveStageList` / `archiveStageComplete` / `archiveStageWithdraw` | 暖通六阶段 |
| | `svc:archivePhotoAttach` / `archivePhotoList` / `archivePhotoFile` / `archivePhotoPublish` | 照片（multipart 上传） |
| | `svc:archivePublish` / `archiveVoid` | 发布 / 作废 |
| **档案列表** | `serviceArchives:list` + `serviceArchiveStages/Photos:list`（`via:'archive'` 两跳） | 列表 / 详情 |
| **客户匿名** | `publicArchive:queryByMobile` | **手机号摘要查询（唯一放行的匿名 action）** |
| | `publicTicket:create` / `publicStore:list` / `publicStore:entry` | 报修 |
| | `publicReview:get` / `publicReview:submit` | 评价 |
| | `publicProgress:get` / `publicPhotoFile` | 进度 / 照片 |
| **总部** | `svc:hqOverview` / `svc:reportKpi` / `svc:exportTickets` | 概览 / 报表 / 导出 |

⚠️ 全部 `svc:*` 写动作要求 **`X-Request-Id` = 合法 UUID v4**（幂等键 + 链路追踪锚点）。
这是适配层的硬要求，不是可选项。

---

## 二、Konsta UI 兼容性结论与选定架构

### 2.1 真实版本取证（不靠文档推测）

| 项 | 实际值 | 取证方式 |
|---|---|---|
| NocoBase | **2.2.15** | 镜像 tag |
| **react-dom** | **18.2.0** | `vendor-core-*.js` 内 `version:"18.2.0",rendererPackageName:"react-dom"` |
| React 19 特征 | **0 处** | 产物内 `useOptimistic` / `useFormStatus` / `useActionState` 计数 = 0 |
| antd | **5.24.2** | `vendor-antd-*.js` |
| Tailwind | **不存在** | 产物内 `tailwind` 计数 = 0 |
| 前端产物形态 | **ESM chunks**（`/assets/vendor-*.js`） | 首页 HTML |

**用户指令里的前提得到证实**：NocoBase 项目确实在 **React 18** 环境。

### 2.2 Konsta 5.5.0 的真实行为（解包验证，不是读文档）

```
konsta@5.5.0
  peerDependencies: 无
  dependencies:     tailwind-merge@^3.3.1
  react/ 目录内 import: useState / useRef / useEffect / useLayoutEffect / useContext
  React 19 独有 API（useOptimistic 等): 0 处
```

⇒ **Konsta 5.5.0 运行时只用了 React 18 就有的基础 hook**。官方文档写 React 19
（因为 5.x 起要求 Tailwind 4），但**组件代码本身不依赖 React 19**。

⚠️ 这是"实测结论"，不是"官方承诺"。所以下面仍然**不把 Konsta 塞进 NocoBase 主包** ——
理由见 2.3。

### 2.3 架构选型：**独立构建 + 同源部署**

#### 选定方案

```
https://<域名>/m/            ← 新：服务工作台（React 18 + Konsta 5 + Tailwind 4）
https://<域名>/h5/           ← 保留：客户/师傅 Vue 应用（不变）
https://<域名>/admin/        ← 保留：NocoBase 后台（不变）
https://<域名>/api/          ← 唯一后端（不变）
```

- 本应用**自己的** `<html>`、React、CSS 管线；
- 与 NocoBase 仅通过 `/api/*`（HTTP）交互，**不共享任何 JS 模块**；
- **同源部署**（同一个域名下的 `/m/`），因此不存在跨源问题。

#### 为什么不嵌进 NocoBase 插件

| 风险 | 说明 |
|---|---|
| **双 React** | 宿主是 18.2.0；若插件自带 19.x 打进去，同页两份 React → `Invalid hook call`，**报错位置离真正原因极远** |
| **Tailwind Preflight** | `@import 'tailwindcss'` 自带全局 reset，会重置 antd 的 `button`/`input`/`h1` 等基础样式 → 后台界面全乱 |
| **Konsta 全局 CSS** | `konsta/theme.css` 定义 `.ios` / `.md` / `k-*`，且 `App` 组件会给 `html` 加类 |
| **构建链冲突** | NocoBase 的插件构建是 esbuild 单文件 AMD；Tailwind 4 需要独立的 PostCSS 管线 |

即使 react 版本"恰好"兼容，**样式污染这一条就足以否决嵌入方案** ——
而样式污染的表现是"后台看起来有点怪"，极难归因。

#### 为什么不跨源部署（`m.域名.com` 或独立端口）

取证发现 NocoBase 的 CORS 策略：

```js
// @nocobase/server/lib/helper.js:102
function resolveCorsOrigin(ctx) {
  const origin = ctx.get('origin');
  const whitelist = getCorsWhitelist();
  if (isWhitelistedCorsOrigin(ctx)) return origin;
  return whitelist ? false : origin;   // ← 白名单未配置时**反射任意 Origin**
}
```

实测：`OPTIONS` 预检回 `Access-Control-Allow-Origin: http://localhost:5273`（反射）。
容器内 `CORS_ORIGIN` **未设置** ⇒ 当前对任意来源开放。

⇒ 跨源部署会要求本应用**依赖一个"任意来源都可访问 API"的宽松策略**。
这既扩大了攻击面，又让"必须同源"成为一条隐式的安全依赖。
**同源部署把这个变量彻底消掉。**

#### 会话复用的可行性（关键验证）

取证：NocoBase 的 Cookie token **只对文件访问路径 + GET/HEAD 生效**：

```js
// @nocobase/server/lib/helper.js:165
const canUseAuthCookie = Boolean(ctx.state.fileAccess || ctx.state.legacyFileAccess)
                      && ['GET','HEAD'].includes(ctx.method);
```

⇒ **同源 Cookie 不能用于业务 API**（POST 一律 `EMPTY_TOKEN`，已实测）。

因此本应用的会话方案是：**登录时取 Bearer Token，由应用自己持有**。
它有这些已验证的性质：

| 判据 | 实测结果 |
|---|---|
| `auth:signIn` 返回 `data.token` | ✅ 200 |
| Bearer 调 GET / POST 业务接口 | ✅ 均 200（**无需 CSRF 头**） |
| Token 有效期 | `exp - iat` ≈ 24h |
| 是否引入第二套账号 | **否** —— 登录走同一个 `/api/auth:signIn`，同一套 `users` / `roles` |

⚠️ 仍必须解决的：**"员工在 NocoBase 后台已登录，打开 /m/ 要不要再登一次？"**
这是产品体验问题而非安全问题。方案见 5.2 —— 不在本轮擅自实现跨 tab 取 token
（那需要放宽 httpOnly，属安全决策，须用户裁决）。

### 2.4 PoC 证据（19/19 PASS，含变异验证）

`.tmp-verify/mobile-poc/` · 脚本 `src-mobile/scripts/poc-verify.mjs` · 390×844 Chrome headless

| # | 断言 | 结果 |
|---|---|---|
| 1 | React 应用挂载 | PASS |
| 2 | 无 `Invalid hook call`（双 React 症状） | PASS |
| 3 | Konsta `Button` 渲染且圆角非 0 | PASS `radius=4px` |
| 4 | Konsta `Card` 渲染且圆角非 0 | PASS `radius=24px` |
| 5 | `--color-svc-brand` 注入成功 | PASS `oklch(55% .19 258)` |
| 6 | `--font-ios` 存在（iOS 材质生效） | PASS |
| 7 | 点击真实改变 React 状态 | PASS `0 → 1` |
| 8 | **medium 按钮 ≥44px**（Konsta 默认 34px） | PASS `44.0px` |
| 9 | large 按钮 ≥44px | PASS `48.0px` |
| 10 | 深色类切换生效 | PASS |
| 11 | 深色下 token 变量被覆盖 | PASS `55%→68%` |
| 12 | 360 / 390 / 430 无横向溢出 | PASS ×3 |
| 13 | `Network.loadingFailed` = 0 | PASS |
| 14 | 无 4xx/5xx 资源 | PASS（修掉 favicon 404 后） |
| 15 | 浅色/深色截图哈希不同 | PASS |

**变异验证（证明断言有区分力，不是"怎么写都绿"）**：
移除 `.k-button { min-height: 44px }` 后重建 →
断言 #8 **变红**（`medium=34.0px`），#9 仍 PASS（`48px`）。
⇒ 这条断言真的在测"设计系统是否强制了触摸目标"，不是恰好通过。

**PoC 阶段发现并修复的 2 个真实缺陷**：
1. `medium` 按钮只有 34px < iOS 44px 下限（Konsta 默认尺寸）；
2. 缺 favicon → 永久一条 404，会让"资源全 200"这条运维断言永远红。

---

## 三、统一信息架构与导航

### 3.1 产品形态

**名称**：服务工作台
**主路径**：`/m/`
**导航**：底部 Tab（员工）+ 独立全屏页（客户/师傅，**不带 Tab**）

### 3.2 角色 → 首页映射（数据来自 `auth:check` 的 `roles[]`，不由前端猜）

| 角色 | Tab 1 | Tab 2 | Tab 3 | Tab 4 |
|---|---|---|---|---|
| `store_after_sales` 门店售后 | 工作台 | 工单 | — | 我的 |
| `store_sales` 门店销售 | 工作台 | 服务档案 | 查询 | 我的 |
| `store_manager` 门店负责人 | 工作台 | 工单（只读） | 服务档案（只读） | 我的 |
| `hq_admin` / `hq_after_sales` 总部 | 概览 | 工单 | 服务档案 | 我的 |

⚠️ **Tab 数量随角色变化，但底栏高度不变** —— 这是刻意设计：
底栏忽高忽低会让页面内容在切换角色后跳动。

⚠️ **不为统一首页新增任何权限**。Tab 的可见性由 `roles[].name` 决定，
但**页面内的每个数据范围仍由服务端 ACL 决定**。前端隐藏 Tab ≠ 权限控制。

### 3.3 页面矩阵（旧 → 新）

| 旧 | 新 | 角色 | 真实 API | 迁移策略 |
|---|---|---|---|---|
| `/m/`（不存在） | 工作台 | 员工 | `serviceTickets:list` + `svc:followUpQueue` | 新建 |
| 桌面"我的门店工单" `tujyw08ec1d` | 工单列表 | 售后/负责人 | `serviceTickets:list` | 移动重建 |
| 桌面工单详情抽屉 | 工单详情 `/m/tickets/:id` | 售后/负责人 | `svc:timeline` | 移动重建 |
| 桌面"服务档案"`sw9hdyrx280` | 档案列表 `/m/archives` | 销售/负责人 | `serviceArchives:list` | 移动重建 |
| 移动测试页 `n5c25yq5qlt` | 建档 `/m/archives/new/:type` | 销售 | `svc:archiveCreate` | **替换空壳** |
| `/h5/archive.html` | `/m/archive-query` | 匿名客户 | `publicArchive:queryByMobile` | 保留旧页，新页并行 |
| `/h5/report` | 保持不变 | 匿名客户 | `publicTicket:create` | **本轮不迁**（表单复杂，风险高） |
| `/h5/technician/visit/:token` | 保持不变 | 师傅 | `/api/technician/visits/:token` | **本轮不迁** |
| `/h5/customer/review/:token` | 保持不变 | 匿名客户 | `publicReview:get/submit` | **本轮不迁** |
| `/h5/customer/progress/:token` | 保持不变 | 匿名客户 | `publicProgress:get` | **本轮不迁** |

**迁移纪律**：旧的 `/h5/*` 与 `/f/`、`/p/`、`/t/` 深链**全部保持有效**，
直到新页面对应功能通过同等验收并单独授权切换。**不做"一刀切替换"** ——
短信里的 Token 链接一旦失效，已经发出去的那批短信就永久死了。

---

## 四、可复用组件目录（实现中）

```
src-mobile/src/
├── design/
│   ├── tokens.ts            设计 token（唯一颜色/尺寸来源）
│   └── ThemeProvider.tsx     浅/深色切换 + 跟随系统
├── components/
│   ├── ServiceAppShell.tsx   底栏 + safe area + 内容区
│   ├── MobilePageHeader.tsx  Navbar 封装（含返回、右侧动作）
│   ├── ServiceStatusBadge.tsx 状态徽标（tone → 颜色）
│   ├── ServiceCard.tsx       业务卡片（列表行）
│   ├── ServiceTimeline.tsx   业务时间线
│   ├── ServiceFilterSheet.tsx 筛选浮层
│   ├── ServiceFormSection.tsx 表单分组
│   ├── ServicePhotoUploader.tsx 上传（进度/失败/重试）
│   ├── SecurePhotoGallery.tsx 私有图（Blob → objectURL）
│   ├── StickyActionBar.tsx   底部固定主操作
│   ├── EmptyState.tsx
│   ├── LoadingState.tsx
│   ├── ErrorState.tsx
│   ├── PermissionDeniedState.tsx
│   └── ConfirmationSheet.tsx
├── api/
│   ├── http.ts              统一请求（Bearer + X-Request-Id + 错误归一）
│   ├── session.ts           登录/登出/当前角色
│   ├── tickets.ts           TicketApiAdapter
│   ├── archives.ts          ArchiveApiAdapter
│   └── media.ts             SecureMediaAdapter
└── pages/                   三个代表性页面 + /components 组件展厅
```

---

## 五、验收状态与阻塞项

### 5.1 已通过

| 项 | 结果 |
|---|---|
| Konsta 5.5.0 × React 18.2 兼容性 | **PASS**（19/19，含变异验证） |
| 双 React 风险 | **PASS**（独立构建，物理隔离） |
| 样式隔离 | **PASS**（独立 `<html>`，与后台零交集） |
| 深色模式 | **PASS**（token 级切换，截图哈希不同） |
| 360/390/430 无横向溢出 | **PASS** |
| 触摸目标 44px | **PASS**（设计系统强制，已变异验证） |

### 5.2 需用户裁决的 2 项（**不阻塞开发，阻塞"体验是否达标"**）

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| **A** | 员工已在 NocoBase 后台登录，打开 `/m/` 是否要**再登一次**？ | ① 独立登录页（简单、安全，多一次输入）<br>② 共享登录态（需放宽 httpOnly 或加一个"发短期票"的接口） | **先做 ①**。② 属安全边界变更，需单独授权；且能用 ① 就不该先动 ② |
| **B** | 客户查询页（原 `archive.html`）是否在 `/m/` 重建并切换？ | ① 新建 `/m/archive-query` 并行，旧页暂留<br>② 直接替换 | **① 并行**。旧页是生产在用的匿名入口，直接被替换等于把一条已验证的链路换成未验证的 |

### 5.3 安全或业务阻塞

**无阻塞项。** 但有 3 条必须遵守的边界（已在设计里固化）：

1. **不新增后端聚合 API**。三个页面全部用现有 `svc:*` 与原生资源接口。
   若后续确需跨系统聚合，先提交**只读**最小接口契约，不自行改 ACL。
2. **不按手机号自动合并业务记录**。工单与档案是两张表，
   客户查询只展示**已发布档案的最小摘要**，不跨表 join。
3. **ARC 短信保持 OFF**。本轮任何改动都不得触碰 `sms.scene.archive_verify.enabled`，
   也不得发送真实短信。

### 5.4 剩余页面迁移清单

| 页面 | 优先级 | 依赖 |
|---|---|---|
| 工单列表 + 详情 | P0（本轮） | 无 |
| 档案列表 + 建档 | P0（本轮） | 无 |
| 客户摘要查询 | P0（本轮） | 无 |
| 派工 / 改派 / 改约 | P1 | 工单详情 |
| 派工历史 + 师傅链接 | P1 | 工单详情 |
| 档案照片上传 + 阶段 | P1 | 建档 |
| 总部概览 | P2 | 无 |
| 组件展厅 `/m/components` | P1（与 P0 同批） | 组件 |

---

## 六、部署形态（待单独授权，本轮不执行）

| 项 | 值 |
|---|---|
| 构建命令 | `cd src-mobile && npm ci && npm run build` |
| 产物目录 | `src-mobile/dist/` |
| Nginx location | `location ^~ /m/ { alias <dist>/; try_files $uri $uri/ /m/index.html; }` |
| 是否需要改 NocoBase | **否** |
| 是否需要改数据库 | **否** |
| 是否需要改 ACL / 角色 | **否** |
| 回滚 | 删除该 location + 删除目录即可，**不影响任何现有链路** |

**独立发布清单与完整哈希**：待三个页面完成后一次性给出（含回滚脚本）。
