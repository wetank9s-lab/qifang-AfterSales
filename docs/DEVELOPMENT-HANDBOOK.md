# 七方售后平台 · 开发文档（交付版）

> 版本：2026-10-30 · 编写依据：PROJECT-STATUS / BACKLOG / DEVIATIONS / ENGINEERING-RULES + 当日只读复核
> 读者：接手的开发者、运维、以及需要判断"能不能上线"的决策者
> **本文只回答四件事：现在是什么、坏在哪、卡在哪、还差什么。** 行为细节一律指向既有契约文档，不在本文重写。

---

## 0. 怎么读（先看这段，能省两天）

项目已有 **245 份 md 文档**，其中大量是**当时的验收快照**（标题写着「待裁决」，其实早已 PASS）。
所以阅读顺序必须是：

| 顺序 | 文件 | 用途 | 可信度 |
|---|---|---|---|
| 1 | **本文** | 现状 / 问题 / 卡点 / 未完成 | 当日复核 |
| 2 | `docs/PROJECT-STATUS.md` | 唯一「现在什么状态」登记处 | **权威** |
| 3 | `docs/ENGINEERING-RULES.md` | 28 条踩坑铁律（跨轮复用） | **权威** |
| 4 | `docs/API.md` · `STATE-MACHINE.md` · `SECURITY.md` | 契约 | 权威（改动需同步） |
| 5 | `docs/BACKLOG.md` · `DEVIATIONS.md` | 缺陷与事故原始记录 | 权威但**按编号检索**，别通读 |
| 6 | `docs/PHASE-*.md`、`docs/BE-*-REPORT.md` 等 | 历史证据 | **快照，可能已过时** |
| 7 | 代码 | 最终事实 | **有疑问就回代码取证** |

> ⚠️ 铁律：任何文档与代码冲突，**以代码 + 当日实测为准**，然后把文档改对。
> 本项目最贵的一类事故不是"写错代码"，而是"**验证方法错了，然后相信了它**"（见 §8.1）。

---

## 1. 项目是什么

### 1.1 业务闭环

面向**家电连锁门店**的售后工单系统：客户扫码匿名报修 → 门店受理派工 → 师傅手机端传照片/填维修措施 → 门店确认 → 客户评价 → 闭环（可重开）。

```
客户 H5（匿名，扫码进入，无账号）
   │  提交 六类服务单：维修 / 安装 / 调试保养 / 移机拆机 / 投诉 / 其他
   ▼
总部后台（NocoBase admin）  ── 派工 ──▶  师傅 H5（一次性 Token 链接，72h）
   │                                        │ 上传现场照片、填维修措施
   │  ◀──────── 提交 ──────────────────────┘
   ├─ 门店确认 ──▶ 客户评价邀请（短信链接）
   ├─ 总部工作台（KPI / 异常待办 / 门店对比 / 趋势）
   └─ 历史数据中心（Excel 导入 / 清洗 / 转正式单）
```

### 1.2 四个角色

| 角色 | 能做什么 | 硬边界 |
|---|---|---|
| `hq_admin` | 总部管理：配置、门店、账号、导入 | ≠ 平台 `admin`；仍受 `native-metadata-guard` 限制 |
| `hq_after_sales` | 总部售后：看板、工单、只读配置 | 写操作 403 |
| `store_after_sales` | 门店：本店工单、派工、确认、评价查看 | 行级收窄到 `store_users` 绑定的门店；跨店 404 |
| `viewer` | 只读 | 全写 403 |

> 另有平台级 `root` / `admin`（运维用），**不属于业务角色**，不参与业务 ACL 断言。

### 1.3 三条不可动摇的边界

1. **客户匿名，无账号体系**。客户身份 = 一次性 Token（进度 `/p/`、评价 `/f/`）；师傅身份 = 一次性 Token（作业 `/t/`）。库里**只存 sha256**，明文只在内存与链接里出现一次。
2. **平台元数据对业务角色 fail-closed**。`users` / `roles` / `collections` / `storages` / `attachments` 对四个业务角色一律 403，由 `middleware/native-metadata-guard.ts` 按"清单之外默认拒绝"实现（见 §8.3 B-8 关闭记录）。
3. **客户媒体（照片/录音/视频）不公开**。`/files/` 与 `/storage/uploads/` 一律反代给应用鉴权，**禁止** `alias` 直出磁盘。

---

## 2. 架构与技术栈

### 2.1 版本

| 组件 | 版本 | 备注 |
|---|---|---|
| NocoBase | `nocobase/nocobase:2.2.15-full-no-nginx` | **冻结**，不升级（升级=重跑全部 ACL/flow 门禁） |
| 业务插件 | `@local/service-ticket` 1.0.0 | 单插件，扩展全部收敛在这里 |
| PostgreSQL | 随 compose | 25 张业务表 |
| Nginx | `svc-nginx` 容器 | 本机 8080/443（80 被 CRMEB 占用） |
| 客户/师傅 H5 | Vue 3.4 + Vite 8.3，`base: '/h5/'` | 独立产物，**不是** NocoBase 前端的一部分 |

### 2.2 三套环境（当前实际状态，2026-10-30 只读核对）

| 环境 | 位置 | 端口 | 状态 | 用途 |
|---|---|---|---|---|
| **生产** | `162.14.121.180:/opt/scqf-aftersales` | 13000（公网 `https://sh.scqfls.cn`） | `scqf-as-app` Up 22h healthy，health **200**；公网 `/h5/` 与 `/api` 均 200 | 唯一对外环境 |
| **本机开发** | 本仓库 + `storage/plugins` | 13000 / 8080 / 443 | 三容器 Up 21h healthy，health **200** | 日常开发 |
| **专属 UAT** | 远端 `/opt/scqf-p6-uat` | **13099** | `p6-uat` Up 17h，health **200** | P0 真接口验收（独立库 `scqf_p6_uat` / 角色 `p6_uat`） |
| 共享 UAT | 远端 | 13097 / 13098 | `scqf-uat-inst` / `scqf-r4-uat` 在跑 | **禁止**再写入（12:04–12:07 已有一次事故，见 §8.2） |
| 媒体测试 | 远端 | 13010 | `scqf-media-test-app` healthy | 媒体解析验证 |

⚠️ **本机当前有一处"产物比进程新"**：`dist/server/index.js` mtime `2026-10-29 17:23`，而 `svc-app` 启动于 `2026-10-29 12:07`。
按铁律 26，**进程正在发旧产物**——本机改完代码必须 `docker compose restart app`，否则你测的是上一版。

### 2.3 请求链路

```
浏览器 /h5/…                 → nginx root /usr/share/nginx/html（静态）
浏览器 /t/<43字符>           → nginx 正则捕获 → rewrite → /h5/technician/visit?token=…
浏览器 /p/<token> /f/<token> → 同上（进度 / 评价）
浏览器 /api/<res>:<action>   → nginx 反代 → svc-app:13000 → NocoBase action
      │
      ├─ middleware/native-metadata-guard   平台元数据边界
      ├─ middleware/collection-metadata-scope  metadata 结构化投影
      ├─ actions/{public,technician,svc}/*  入口层：鉴权 / 限流 / DTO
      └─ services/*                         业务层：状态机 / 事务 / 短信
```

**关键**：`/api/public/*` 是匿名面（限流 `svc_public` 30r/m burst=10）；`/api/technicianVisit:*` 走 Token；`/api/svc:*` 走登录态 + 角色 ACL。

---

## 3. 代码地图

### 3.1 目录

```
nocobase/plugins/service-ticket/src/
├── server/
│   ├── actions/          接口层（public 9 / technician 2 / svc 21）
│   ├── services/         业务层（工单、拜访、短信、Token、媒体、导出…）
│   ├── collections/      25 张表定义
│   ├── migrations/       18 个迁移（按时间戳，只增不改）
│   ├── middleware(s)/    元数据边界、媒体守卫
│   ├── seeds/            角色、演示数据
│   ├── tasks/            定时任务（孤儿短信回收、SLA 扫描）
│   └── constants.ts      **单一事实源**：状态枚举、短信模板、Token 规格、错误码
├── client/               后台页面（flow-engine block + 两个业务页）
└── shared/               前后端共享契约

h5/src/                   客户与师傅 H5（Vue3）
├── pages/Report/{index,Success}.vue
├── pages/Technician/Visit.vue
├── pages/Customer/{Progress,ProgressReview}.vue
├── pages/Review/index.vue
└── utils/{last-order,privacy,validate,appliance}.ts

scripts/                  168 个脚本（117 个 verify-* 门禁）
docs/                     245 份文档（契约 + 历史证据）
```

### 3.2 改哪儿看哪儿（高频）

| 想改 | 去这里 | 注意 |
|---|---|---|
| 状态机 / 状态文案 | `server/constants.ts` → `TICKET_STATUS` / `VISIT_STATUS` | 改枚举必须同步迁移与前端映射 |
| 短信文案 | `constants.ts` → `SMS_TEMPLATE_TEXT` | 只有**这里**一处；改完跑 `be03-sms-copy.test.mjs` |
| 短信发送/闸门 | `services/sms-service.ts`（enqueue→flush→deliverOne） | 三道闸：总开关 / 场景开关 / 模板 CODE |
| 派工逻辑 | `services/ticket-service.ts` → `dispatch` / `reassign` / `reschedule` | 会同时发两条短信（客户 + 师傅） |
| 师傅提交校验 | `actions/technician/visit.ts` + `services/visit-service.ts` | **两道**校验（入口 422 / 业务层再拦一次） |
| 后台页面 | `client/hq-pages.tsx` + `client/page-logic.ts` | 状态派生逻辑必须在 `page-logic.ts`（纯函数，可测） |
| 客户 H5 | `h5/src/pages/Report/index.vue` | 提交成功后的"记住本单"在 `utils/last-order.ts` |
| 权限边界 | `middleware/native-metadata-guard.ts` + `constants.PLATFORM_UI_ACTION_ALLOWLIST` | 加白名单必须写业务理由 |
| 数据表 | `collections/*.ts` + 新增 `migrations/<日期>-*.ts` | NocoBase 会**静默丢弃** collection 级索引（DEV-16），索引要走 `ensure-indexes.ts` |

### 3.3 数据模型（25 张表，按用途分组）

| 组 | 表 |
|---|---|
| 业务主链 | `serviceTickets` · `serviceVisits` · `ticketEvents` · `serviceVisitPhotos` |
| 门店与账号 | `stores` · `storeUsers` · `storeAccountAudits` · `storeProfileAudits` |
| 配置与审计 | `serviceSettings` · `configChangeAudits` · `apiGuards` · `idempotencyRecords` |
| 短信 | `smsLogs` |
| 客户媒体 | `customerMedias` · `customerMediaSessions` |
| 历史数据（BE-02A/B） | `historicalImportBatches` · `historicalImportRows` · `historicalImportCandidates` · `historicalImportReviews` · `historicalServiceArchives` · `historicalTicketConversions` · `exportAudits` |
| 页面装修（UX-01D） | `pageThemeDrafts` · `pageThemeReleases` |
| 序列 | `dailySequences` |

### 3.4 接口清单

| 面 | 动作 | 鉴权 | 说明 |
|---|---|---|---|
| `public` | `ticket` · `store` · `progress` · `progress-review` · `review` · `media` · `health` · `live` · `ui-theme` | 匿名 + 限流 / Token | 客户报修、进度、评价、媒体上传 |
| `technician` | `visit`（另有 `_auth` helper） | 一次性 Token（43 字符 base64url） | 师傅作业页读写 |
| `svc` | `ticket` · `dispatch` · `report` · `store-review` · `visit-review` · `config-settings` · `store-entry` · `store-profile` · `store-accounts` · `ticket-create` · `ticket-urgent` · `ticket-media` · `insight` · `sms-recovery` · `historical-import` · `historical-review-archive` · `ui-theme` · `guard-quota` | 登录 + 角色 + 幂等头 | 后台业务接口 |

> 写接口一律要求 `X-Request-Id`（幂等）。**注意**：该校验在**权限判定之前**，所以"缺幂等头"返回 **422** 而不是 **403** —— 验权限反例时必须带上它，否则拿到的是参数错（本项目踩过）。

### 3.5 状态机（要点，完整版见 `docs/STATE-MACHINE.md`）

```
Ticket: NEW → PROCESSING → WAIT_STORE_CONFIRM → WAIT_FEEDBACK → CLOSED
                                  ↑                    │
                                  └──── 重开 ──────────┘

Visit:  ASSIGNED → SUBMITTED → CONFIRMED
             └→ SUPERSEDED（被改派/改约取代）
             └→ CANCELLED
```

三条容易踩的：

- `NEW` **不再经过"受理"**（P11-0 已移除受理动作），直接派工/转店/取消/电话解决。
- 师傅提交会**同时**推进 Visit（`SUBMITTED`）与 Ticket（`WAIT_STORE_CONFIRM`），并且**消费一次性 Token**——所以校验失败必须发生在**消费之前**。
- 改派会让旧 Visit 变 `SUPERSEDED`，旧链接立即失效，客户进度页只认**当前有效 Visit**。

---

## 4. 开发与交付流程

### 4.1 五层门禁（改完必须全过）

| 层 | 命令 | 判什么 | 失败含义 |
|---|---|---|---|
| 1 | `node scripts/prebuild-guard.mjs` | 工作区 vs 构建基线 `admin-base/` 的 10 个受管文件一致 | 你只改了一份，产物不会包含你的改动 |
| 2 | `npm run typecheck`（h5） / `verify-types.mjs` | TS 编译级错误（只判 TS2304/TS2552 这类硬错） | 真错 |
| 3 | `verify-ts2741-baseline.mjs` | `TS2741` 基线 19 条 | 新增必填字段没写 |
| 4 | `verify-ts-baseline.mjs` | **全量**诊断基线 219 条 / 101 键 | **任何新增诊断都阻断**（BUILD-TS-GATE-01 的产物） |
| 5 | `node scripts/build-plugin.mjs` | 串起 2–4 + esbuild 产物 | 构建失败 |

> 2–4 已焊进 5，**正常只需跑 5**；但第 1 层要**先单独跑**，它不通过时构建会给出误导性的结果。

### 4.2 验证纪律（比门禁更重要）

1. **写完断言必须反向验证**：人为造出缺陷态 → 断言变红 → 还原 → 回绿。不会变红的断言等于没有。
2. **变异测试**：把当年的坑逐个塞回去，要求**预期那条**变红。只证明"会红"不够，要证明"红在对的地方"。
3. **工具坏了 ≠ 产品坏了**：夹具/探针自身失败一律 `exit 2`，不给产品结论。
4. **断言最终形态，不断言中间形态**：短信要抓 Provider 的 `c` 参数，不是模板文本；页面要抓真实 Network，不是 DOM 文案。

### 4.3 构建与发布

```bash
# 1. 构建（含全部门禁）
node scripts/build-plugin.mjs

# 2. 本机生效（注意：up -d 对已运行容器是 no-op，必须 restart）
docker compose restart app && node scripts/verify-bundle-delivery.mjs

# 3. 发布到生产（受控脚本，先 dry-run 再 apply）
S6_SSH_PASS=*** python scripts/deploy-s6-remote.py --dry-run
S6_SSH_PASS=*** python scripts/deploy-s6-remote.py --apply
# 回滚
S6_SSH_PASS=*** python scripts/deploy-s6-remote.py --rollback <ts>
```

生产的插件路径是 `<root>/src/storage/plugins/@local/service-ticket`（**不是** `<root>/storage`），容器 `scqf-as-app` 用 bind 挂载 ⇒ **换 dist 三个文件 + restart 即可，不需要重建镜像**。

证书由 `acme.sh` 管理（账本 `/opt/acme-data`，cron 每日 03:17 `--cron`），**不是 certbot** —— 排查续期时别去找 `certbot renew` 或 systemd timer。

### 4.4 三条变更红线

1. **不得** `git commit` / `git push`（未获明确授权时）。
2. **不得**为了"让测试过"而放宽产品行为（限流、权限、校验、Token 规格）。
3. **不得**修改已冻结模块的布局/文案/统计口径；只有**可复现回归**才重开。

---

## 5. 当前状态快照

### 5.1 已 PASS / FROZEN（不重做）

| 模块 | 说明 |
|---|---|
| UX-01C 核心后台配置 | 服务时效 · 门店资料 · 短信通知（三模块全过，2026-10-17） |
| UX-01D M1 页面装修配置 | 五项配置 + 草稿/预览/发布/回滚 + 权限审计 |
| UX-PROGRESS-01 客户进度 | 5 节点阶段条 + 师傅卡 + 六类时间 + 事件时间线 |
| UX-LAST-ORDER-01 上一单记忆 | 客户 24/24、师傅闭环 25/25、B-30 布局 35/35 |
| P11-0 门店工作流 / P11-2 人工建单 / P11-3 历史中心 / P11-5 师傅详情 | 均冻结 |
| BE-02A 历史档案与 Excel 导入 · BE-02B Gate2 转正式单 | 已签收 |
| **BE-03-UX-01 短信通知业务化 · BE-05-UX-01 总部工作台业务化** | **2026-10-29 正式签收**（仅界面整改与三处只读统计） |
| UX-MEDIA-01 客户媒体后台可见 | 58/0 |
| B-8 平台元数据边界 | 已关闭（中间件 + 19 项边界断言 + 反向验证） |

### 5.2 IN PROGRESS / HOLD / 待裁决

| 项 | 状态 | 卡在哪 |
|---|---|---|
| **Release** | 🔴 **HOLD** | R-1~R-5 五项发布门禁（§6.1） |
| BE-03 整体 | 🟡 IN PROGRESS | 自动回执、完整生产发送验收、通道运营能力 |
| BE-05 整体 | 🟡 IN PROGRESS | KPI 钻取、详情跳转、异常总数、Excel 导出 |
| BE-04「所有工单」 | 🔴 HOLD 不申请 PASS | 日期筛选 UI 组件与 P1 方案待裁决 |
| P6-PRIORITY-01（维修措施 + 上一单） | 🟡 已实现，验收 **9/13·8/10** | 夹具缺陷 + 4 项未覆盖（§6.2） |
| P6-PRIORITY-02 | 🟡 同上 | 同上 |
| BE-03-SMS-COPY-01 三场景短信 | 🟡 **源码 PASS / 测试 PASS / 未部署** | 等部署批准 |
| SEC-STORE-01 门店账号隔离 | 🟡 25/25 已交付 | 等用户签收 |
| 华林账号 `hl@scqfls.cn` | 🟡 已绑定 S04 | 缺账号口令，未做真实登录 |
| P11-1 服务单模型 | 🟡 已交付 | 最终关闭核查 PENDING |
| P11-4 客户媒体上传 | 🟡 暂停 | 设备/通道未关闭项 |
| UX-01A 总部工单台 | 🟡 多轮迭代 | **从未宣布 PASS**，无整体冻结 |
| UX-01B 客户 H5 | ⏸ Gate2 被用户跳过 | 跳过 ≠ 通过 ≠ 取消 |
| BUILD-TS-GATE-01 | 🔴 **OPEN** | 方案已落地，等下一次真实发布验证流程是否被绕过 |
| P11-6 时效待办 · P11-7 生命周期与真人 UAT | ⏳ 未授权 | 需用户授权 |
| UX-01D M2 | ⏳ 未授权 | 五项文案/交互改动 |

---

## 6. 当前问题（按严重度）

### 6.1 P0 —— 直接阻塞发布

> ⚠️ **本节已按 2026-10-30 实测修正**：`PROJECT-STATUS.md` §4 里 R-2 / R-3 写于 2026-10-17，
> 当时描述的是**开发环境**；生产环境此后已补上域名与受信证书（见下）。两张表冲突时**以本表为准**，
> 因为它是实测的。

| # | 问题 | 现状（2026-10-30 实测） | 关闭条件 |
|---|---|---|---|
| R-1 | **真实短信通道未联调** | 🔴 **仍 PENDING**。只验证了 mock 与"缺凭证⇒明确拒发"；从未真实发送成功 | 选定服务商 + 真实凭证 + 审核通过模板 ⇒ 真实发一条，拿到 `provider_request_id` 与回执 |
| R-2 | 公网入口 | 🟢 **已具备**：`https://sh.scqfls.cn` 的 `/h5/` = **200**、`/api/app:getInfo` = **200**；容器内 `PUBLIC_BASE_URL=https://sh.scqfls.cn`（由 `.env.prod` 注入） | 剩余的是**真机扫码**验证（属 H5-02），不是配置缺失 |
| R-3 | TLS 证书 | 🟢 **已具备**：Let's Encrypt ECC，CN=`sh.scqfls.cn`，有效期至 **2027-01-20**；`SVC_TLS_INSECURE` **未设**；续期由 `acme.sh --cron` 每天 03:17 执行，账本下次 Renew = **2026-12-21** | 只需在 12 月下旬确认续期真的发生（**没有 certbot timer，别照 certbot 去查**） |
| R-4 | **真实 Client IP 分桶** | 🔴 **仍 PENDING**（现在有公网入口了，可以实测） | 从公网出口打限流，确认分桶按真实 IP 而非反代 IP |
| R-5 | **MNS 送达回执未连通** | 🔴 **仍 PENDING**，代码语义已闭合（RB-8） | 真实云资源证明 |
| G-1 | **BUILD-TS-GATE-01 OPEN** | 首次上线后才发现 9 条新增 TS 诊断（三层门禁全绿） | 全量基线门禁已焊入构建；需**下一次真实发布**证明它真的拦住 |
| U-1 | **P0-1 / P0-2 运行验收未满额** | 9/13、8/10（真 HTTP + 真浏览器） | 补 4 + 3 项（见 §6.2），两项满额后才可申请部署 |

> 结论：**发布门禁从 5 项缩到 3 项**（R-1 / R-4 / R-5）。
> 这三项的共同点是——**都需要外部资源**，不是写代码能解决的（见 §7.1）。

### 6.2 P0 未满额的具体缺口（都是小事，但没做完不能算过）

| 缺口 | 原因（已查明） | 补法 |
|---|---|---|
| P0-1 #6 500 字边界 | 夹具 bug：`insert` 后用 `order by id desc limit 1` 取 id，时序错位 ⇒ Token 无效 | 改用 `INSERT … RETURNING id`，每例独立 Visit |
| P0-1 #7 五种 service_result | 同上 | 同上，五种结果各跑一次成功提交 |
| P0-1 #9 未知枚举 `brand_new` | 同上 | 同上，断言按真实契约 422，不放宽 |
| P0-1 #14 历史 `service_note=NULL` 只读 | 未造数据 | 造一条历史 NULL Visit，用 GET 读，验证不崩且显示兼容 |
| P0-2 #4 跨门店隔离 | 未跑 | 拦截 `store-entry` 返回第二家门店，验证读不到第一家记录 |
| P0-2 #5 7 天过期 | 未跑 | 把 `savedAt` 改成 8 天前，重开应清除 |
| P0-2 #8 localStorage 不可用 | 未跑 | CDP 注入 `Object.defineProperty(window,'localStorage',{get(){throw…}})` 后走完整提交 |

### 6.3 P1 —— 不阻塞发布但会影响真实使用

| 编号 | 问题 | 影响 | 备注 |
|---|---|---|---|
| **B-17** | 后台首屏请求 `environmentVariables` 被 B-8 守卫拒 → 闪一条 "No permissions"（3 秒 toast） | 体验噪声，不影响流程 | 修法受限：**不得**放宽 B-8、不得放开环境变量读取 |
| **B-19** | `smsbao` 通道端到端不可用（`SMS_TEMPLATE_ENV_PREFIX` 缺 `smsbao` 映射） | **若首发选短信宝则升为 P0** | 后台已如实标注"不可发送"（这是正确展示） |
| B-27 | 新建用户默认带 `member`，门店账号可能"有角色却处处 403" | 不给权限（fail-closed），但让人以为系统坏了 | 已用橙色提示缓解；建号流程待固化 |
| B-12 | `STATE-MACHINE.md` 写着 `SELECT … FOR UPDATE`，**全仓 0 处使用行锁** | 文档误导；并发语义与文档不符 | 要么改文档，要么补实现 —— 必须二选一 |
| B-14 | 总部看板区块客户端未交付（服务端三条 API 已可用） | 能力有、入口没有 | 与 BE-05 部分重叠，合并处理 |
| SEC-STORE-01 未签收 | 功能 25/25 已交付 | 状态悬空，容易被人当成"已完成" | 等一次正式裁决 |
| 华林账号登录 HOLD | 已绑定 S04，无口令 | 无法验证真实门店视角 | 需账号持有人给口令（**不重置**） |

### 6.4 P2 —— 体验与文档

| 编号 | 问题 | 一句话 |
|---|---|---|
| B-21 | 隐私说明里显示字面 `**不需要注册账号**` | Markdown 语法用了但按纯文本渲染；**不要**改 `v-html`（XSS 面），去掉源文本的 `**` |
| B-22 | 「服务时效」表配置键/说明被截断 | 加 `ellipsis + title` 或调列宽；属冻结页，只做样式微调需单独评审 |
| B-26 | 媒体四枚图标是蓝色系，与品牌红/石墨灰不协调 | 用户明确"不得重新设计"，只能出 v2 方案 |
| B-24 | `verify-ux-01c-store-profile` 用固定手机号，同日重跑 >5 次必红 | 门禁自身缺陷（撞限流） |
| B-6 | `verify-concurrency-phase2.mjs` 仍打印 "Phase 2 仍为 HOLD" | 残留文案，误导读者 |
| B-3 | "重建产物后必须重启 app"仍靠人记得 | 已写进构建输出的收尾提示，但没有机制强制 |
| B-10 | `verify-technician-upload` 偶发一次 `fetch failed`（未复现） | 观察中 |

### 6.5 工程侧技术债（会直接咬下一个人）

| # | 债 | 证据 | 后果 |
|---|---|---|---|
| T-1 | **168 个未提交改动**（129 未跟踪 + 39 修改），最后一次提交是 `9a57997`（2026-10-22） | `git status --short \| wc -l` | 一次误操作就能丢 8 天工作量；且无法用 `git diff` 区分"本轮改了什么" |
| T-2 | **DEVIATIONS 编号重复 10 处** | 220 条目 / 210 唯一编号（DEV-145/165/166/167/168/169/199/203/204/205 各 2 条） | 说"看 DEV-167"时无法确定指哪一条 |
| T-3 | **客户端产物 SHA 不可复现** | 同一份源码两次构建：client SHA 变、server SHA 不变；差异是内嵌构建标记 | 不能靠 client SHA 差异判断"前端有没有变"，否则每次都误判 |
| T-4 | **117 个 verify 脚本无统一入口/无分层** | `scripts/verify-*.mjs` × 117 | 单跑容易、全跑成本高且会互相污染（限流、日志闸），新人不敢跑 |
| T-5 | **受管文件清单只有 10 个** | `prebuild-guard.mjs` | `ticket-service.ts`、`sms-orphan-resolver.ts` 等核心文件不在清单内，基线漂移靠人眼 |
| T-6 | 静态产物 URL 无内容指纹 | `/static/plugins/.../index.js` 路径固定 | 部署后必须强刷，否则用户看到旧界面 |
| T-7 | mock 通道 debug 日志含短信正文（正文现在含客户完整手机号） | `SmsbaoProvider` 不打印正文，mock 会 | 排障切 mock 时要注意；生产走短信宝不受影响 |
| T-8 | `docs/` 245 份文档里历史快照与现状并存 | PROJECT-STATUS 已声明"不追改" | 新人极易把"待裁决"读成"还没做" |

---

## 7. 卡点（为什么推不动）

卡点与问题不同：**问题是有 bug 要修，卡点是有事做不了**。四类，处置方式完全不同。

### 7.1 A 类：外部资源（自己解不了，只能等）

| 卡点 | 需要谁给 | 阻塞什么 |
|---|---|---|
| 真实短信凭证 + 已审核模板 | 用户选型（阿里云 / 短信宝）+ 供应商审核 | R-1、B-19 |
| 3 台真机（iPhone Safari / Android Chrome / 微信内置） | 用户提供设备 | H5 三端验收、`tel:` 拨号、相机/录音唤起 |
| 华林账号口令 | 账号持有人（**不重置**） | SEC-02 真实登录 + 跨店验证 |
| 阿里云 MNS 资源 | 云账号/队列 | R-5 送达回执 |
| 15 家门店真实资料 | 用户提供 | SEC-04 门店身份核定 |

> ✅ **已解决、不必再等**：公网域名与受信证书（`sh.scqfls.cn` + Let's Encrypt，续期由 acme.sh cron 负责）。
> 这一条长期挂在 `PROJECT-STATUS` §4 的 R-2/R-3 上，但**生产早在 10-22 就已具备**，属于登记表滞后，不是缺口。

### 7.2 B 类：授权（等裁决，不是技术问题）

- P11-6 时效待办、P11-7 生命周期与真人 UAT —— **未授权**
- UX-01D M2（5 项文案/交互） —— **未授权**
- BE-05 后半（KPI 钻取 / 详情跳转 / Excel 导出） —— 裁决后置
- BE-03 后半（通道运营能力） —— 未排期
- BE-03-SMS-COPY-01 部署、P0 两项部署 —— **等批准**
- BE-04 的 P1 方案（客户端覆盖 `FilterFormItemModel`）—— 等裁决

> 卡点特征：**代码可能已经准备好了，但没有裁决就不许动**。这类不要"先做起来再说"，本项目严格执行"未授权不做"。

### 7.3 C 类：技术不确定（需要专项，不是等）

| 卡点 | 已知边界 | 下一步 |
|---|---|---|
| 短信宝**无送达回执接口** | 官方文档无状态报告；本项目 `delivery_status` 永远到不了 `delivered` | 这是**产品能力天花板**，不是 bug。要么接受"只知受理不知送达"，要么换服务商 |
| `@dateOn` 语义有 1 秒偏差 | `gte start AND lt (end+1s)`；精确写法是 `$dateNotBefore` + `$dateBefore` | 已在 `BE-04-DATE-SEMANTICS-REPORT.md` 记录；UI 组件未实现 |
| NocoBase `acl.setStrategyResources()` 不可用 | 会被 `afterDefineCollection` 撑大，且误伤非 collection 资源 | 已绕行（中间件方案），**不要再试这条路** |
| NocoBase 客户端同名 Model 不覆盖 | `registerModels` 注册后基类名不变（probe=0） | BE-04 的日期筛选若要改 UI，只能覆盖 `FilterFormItemModel` 并接受 UID 会变 |
| 插件初始化重（`pm:enable` 参数契约） | 必须 `POST /api/pm:enable?filterByTk=<packageName>` + `awaitResponse=true`，参数放 query 不放 body | 已用 A′ 方案在 p6-uat 跑通；参数放 body 会得到 `plugin name invalid` |

### 7.4 D 类：环境与流程（可以优化）

| 卡点 | 现象 | 建议 |
|---|---|---|
| 全量门禁跑不动 | 117 个脚本 + 限流/日志闸互相污染 | 做一份"分层门禁清单"：L0 静态（秒级）/ L1 单模块 / L2 全量（需冷却与隔离） |
| UAT 一致性 | 共享 UAT 曾被误写（12:04–12:07），恢复哈希 ≠ 零影响 | 保持"专属 UAT 只写自己的库"，共享目录只读 |
| 发布验证弱 | 只能靠 SHA + 功能标记计数；`build-fingerprint.json` 曾过期导致"22 个文件变了"的假差 | 改用**产物内功能标记计数**（如 `provider_biz_id` 出现次数），不看 fingerprint 文件 |

---

## 8. 踩过的坑（按"会再咬人"排序）

### 8.1 验证方法类（最贵，因为它让你**相信**了错的东西）

| # | 坑 | 判据 / 避免方式 |
|---|---|---|
| K-1 | **断言不会变红 = 没有断言** | 每条断言做完必须反向验证一次 |
| K-2 | **只读 DOM 文本的"渲染闸门"是半个闸门** | 要断言真实 Network 2xx；名字必须与它真正观测到的东西一致 |
| K-3 | **子串匹配放过畸形**：`【【签名】】` 里 `includes('【签名】')` 仍为真 | 判结构（开头、次数、无双层括号），不判子串 |
| K-4 | **正则对整份 SFC 做语义判断**：`/\/\*[\s\S]*?\*\//` 在 `accept="image/*"` 处误吞 6KB 模板，被吞的段写什么都发现不了 | 分区 + 结构化解析；共用原语见 `scripts/lib/h5-contracts.mjs` |
| K-5 | **`eq` 用 `!==` 比数组 = 引用比较** ⇒ 断言永远不可能通过，而报错里"期望/实际"逐字相同 | `eqScalar` / `eqJson` 分开，不留万能 `eq` |
| K-6 | **静态源码断言命中注释**：注释里写着 `{ticket_no}`、`/api/`，grep 直接假红/假绿 | 先剥注释再扫；本次 `review_invite` 的 S15 又踩了一次 |
| K-7 | **`indexOf('[SMS_SCENE.X]')` 命中枚举定义** 而非模板表 | 先切出目标对象字面量块，再在块内定位 |
| K-8 | **反向验证没等改动生效**：`nginx -s reload` 异步 + keep-alive 复用 ⇒ 读到"好配置"，反向验证假通过 | 轮询到实际生效，每次新起进程探测 |
| K-9 | **探针环境与真人不同**：无头新 profile（空缓存）永远绿，真人持久 profile 被缓存粘住 | 看到"探针绿 / 真人红"先问环境差在哪 |
| K-10 | **工具坏了与产品坏了混报**：checker 自己错，却把产品判成坏的 | fixture 红 ⇒ `exit 2`，不给产品结论 |
| K-11 | **CRLF**：本仓库源码是 CRLF，用 `\n` 拼多行锚点**永远匹配不上**，变异脚本"看着在跑、一个都没施放" | 按文件行尾对齐 |
| K-12 | **esbuild 把中文写成 `\uXXXX` 但保留源码注释**：搜中文只命中注释，给出假绿 | 搜转义形态；或用 ASCII 锚点（时间戳、字段名） |
| K-13 | **夹具自身的时序 bug**：`insert` 后 `order by id desc limit 1` 取到旧 id ⇒ Token 无效，被误判成产品 401 | 一律 `INSERT … RETURNING id` |
| K-14 | **假的 localStorage**（缺 `key(i)` 方法）导致假红 | 夹具必须忠实实现被测 API |

### 8.2 交付链类（"代码对了"到"用户拿到"之间）

| # | 坑 | 判据 |
|---|---|---|
| K-15 | **改了代码 + 重建产物 ≠ 服务端在发新产物** | 产物 mtime **不得晚于**进程启动时间；晚了就红灯并给出重启命令 |
| K-16 | `docker compose up -d` 对已运行容器是 **no-op**，不会重启 | 必须 `restart`；构建脚本提示语本身也要验证 |
| K-17 | 静态产物 URL 固定（`/static/plugins/.../index.js`），无内容指纹 | 部署后**必须强刷**，否则用户看旧界面 |
| K-18 | `nginx -s reload` 不同步 + keep-alive 复用旧 worker | 见 K-8 |
| K-19 | `/h5/` 用 `alias` 在正则 location 里语义错误（拿到目录而非文件） | 用 `root` 让 nginx 自己拼；见 DEV-29 |
| K-20 | 共享 UAT 目录被写入（12:04–12:07） | **恢复哈希 ≠ 零影响**；必须记录时间窗与两实例的请求/日志，再给结论 |
| K-21 | `build-fingerprint.json` 可能是过期的 | 判"这次改了什么"看**产物内功能标记计数**，不看 fingerprint 文件 |

### 8.3 业务语义类（不看代码就会想当然）

| # | 坑 | 真相 |
|---|---|---|
| K-22 | **`pending` 在 `sms_logs` 上是两列** | `send_status='pending'` = 队列（会积压）；`delivery_status='pending'` = 送达（没回执消费者时**必然等于全表**）。把后者当队列 ⇒ "842 条待发"的假故障骗了 3 天 |
| K-23 | **`provider_request_id` ≠ `provider_biz_id`** | 前者是 API 追踪号（阿里云 `RequestId`），后者是回执匹配键（`BizId`）。互相顶替会让回执永远匹配不上 |
| K-24 | **短信宝没有消息 ID、没有送达回执** | 只能"机会性记录"，取不到就留空 + 留痕，**绝不编造** |
| K-25 | **师傅要的是能拨号的完整号码** | 旧实现给的是 `139****8000`（`contactOf` + `maskMobileText`），师傅根本无法联系客户。**后台短信记录的收件人号码仍脱敏**，那是另一个面 |
| K-26 | **门店名有对外名与内部名两个口径** | `stores.name`（对外）/ `门店名(code)`（内部，如 `圣大家电新都店(S01)`）。客户与师傅**不该看到**内部编码；但"取消派工"短信仍用带编码口径，因为不在裁决范围 |
| K-27 | **师傅 Token 必须 43 字符 base64url** | 自造 27 字符 Token 会在认证层就 401（`MALFORMED`），根本到不了业务校验 |
| K-28 | **`svc:updateSetting` 缺 `X-Request-Id` 返回 422 而非 403** | 幂等校验在权限判定**之前**；验权限反例必须带幂等头（用 `true→true` 避免真改） |
| K-29 | **NocoBase 会静默丢弃 collection 级索引** | 索引必须走 `ensure-indexes.ts`（DEV-16） |
| K-30 | **`role` 关联不能直接 SQL 改** | `rolesUsers` / `store_users` 直插会让 `X-Role` 报 `ROLE_NOT_FOUND_FOR_USER`；必须走后台或官方接口 |
| K-31 | **NocoBase `access_log off` 会覆盖同块前置的 `access_log`** | 曾导致站点 22 天无访问日志；修法是**删掉 server 级 off** |
| K-32 | **nginx `rewrite` 不改 HTTP 方法** | `/api/public/reviews/<t>` 的 rewrite 指向 `get`，POST 也会进读取 Action ⇒ **200 假成功** |

---

## 9. 未完成工作（可执行清单）

### 9.1 立刻能做（不依赖任何人）

| 序 | 工作 | 落点 | 验收方式 |
|---|---|---|---|
| 1 | P0-1 补 4 项（500 字 / 五种结果 / 未知枚举 / 历史 NULL） | `scqf_p6_uat` 合成夹具，`RETURNING id` | 13/13，每项带 HTTP + 库前后状态 |
| 2 | P0-2 补 3 项（跨店 / 7 天 / localStorage 异常） | 本地 H5 + CDP | 10/10，带 DOM 与 localStorage 证据 |
| 3 | B-21 去掉隐私说明字面星号 | `h5/src/utils/privacy.ts` | 回归 `verify-uc-*`，页面不再出现 `**` |
| 4 | B-24 门禁固定手机号 → 随机 | `scripts/verify-ux-01c-store-profile.mjs` | 同日连跑 6 次仍绿 |
| 5 | B-6 清掉 "Phase 2 仍为 HOLD" 残留文案 | `scripts/verify-concurrency-phase2.mjs` | 输出与现状一致 |
| 6 | T-2 给重复的 10 个 DEV 编号加后缀（`DEV-167a/b`） | `docs/DEVIATIONS.md` | 编号唯一，`grep` 可定位 |
| 7 | T-5 把 `ticket-service.ts` / `sms-orphan-resolver.ts` 纳入 prebuild-guard | `scripts/prebuild-guard.mjs` | 漂移时能报红 |
| 8 | T-4 出一份分层门禁清单（L0/L1/L2） | `scripts/gates.md` | 新人能按层跑 |

### 9.2 需要授权才能做

| 序 | 工作 | 需要什么授权 |
|---|---|---|
| 9 | 部署 BE-03-SMS-COPY-01（server 单文件 `ab586ef5…`） | 部署批准 + 真实发送需另行授权指定号码与条数 |
| 10 | P0 两项满额后申请部署（server + H5） | 部署批准 |
| 11 | BE-05 KPI 钻取 | 功能授权 |
| 12 | BE-05 Excel 导出（需脱敏 + 审计，`exportAudits` 已有表） | 功能授权 + 脱敏口径确认 |
| 13 | BE-03 通道运营能力（凭据管理页 / 通道切换 UI） | 功能授权 |
| 14 | BE-04 日期筛选 UI（客户端覆盖 `FilterFormItemModel`） | 方案裁决 |
| 15 | P11-6 五类时效与待办 | Phase 授权 |
| 16 | UX-01D M2 五项改动 | 功能授权 |
| 17 | B-17 修法二选一（收回 `pm.*` snippets / 接受噪声并写运维说明） | 方案裁决 |

### 9.3 必须等外部条件

| 序 | 工作 | 等什么 |
|---|---|---|
| 18 | R-1 真实短信联调 | 服务商 + 凭证 + 审核模板 |
| 19 | R-2 / R-3 公网入口与 TLS | 域名 + CA |
| 20 | R-5 MNS 回执 | 阿里云资源 |
| 21 | H5 三端真机验收（相机/相册/录音/录像/软键盘/`tel:`） | 3 台设备 |
| 22 | SEC-02 华林账号真实登录 | 口令（不重置） |
| 23 | SEC-04 15 家门店身份核定 | 真实门店资料 |
| 24 | P11-7 真人 UAT | 真人 + 环境 |

### 9.4 明确不做（避免有人"顺手做"）

- 不重构已 PASS/FROZEN 的模块（布局、状态语义、统计口径、五阶段映射）。
- 不升级 NocoBase 2.2.15。
- 不再尝试 `acl.setStrategyResources()`（已证不可用）。
- 不用 `v-html` 修文案（XSS 面）。
- 不为了通过门禁而放宽限流/权限/校验/Token 规格。
- 不物理删除走查账号（会破坏审计证据链）。

---

## 10. 上手第一周

| 天 | 做什么 | 产出 |
|---|---|---|
| D1 | 起本机环境（`docker compose up -d` + `restart app`）；读 `PROJECT-STATUS` §1/§4；跑一次 `build-plugin.mjs` | 能打开后台与 H5，构建全绿 |
| D2 | 读 `API.md` + `STATE-MACHINE.md` + `SECURITY.md`；用 curl 走一遍"报修→派工→师傅提交" | 理解三条边界与 Token 生命周期 |
| D3 | 挑一个 P2（建议 B-21）改掉 | 体验一次"改代码→反向验证→跑门禁→构建" |
| D4 | 跑 `scripts/verify-*.mjs` 里与你改动相关的 3~5 个；读 `ENGINEERING-RULES.md` | 知道哪些断言在保护你的改动 |
| D5 | 做一次**预发布演练**（本机 restart + 哈希核对 + 强刷验证界面） | 掌握"产物→进程→浏览器"三段一致性 |

---

## 11. 附录

### 11.1 常用命令

```bash
# 全量构建（含 4 层门禁）
node scripts/build-plugin.mjs

# 只查基线漂移
node scripts/prebuild-guard.mjs

# 本机生效
docker compose restart app
node scripts/verify-bundle-delivery.mjs      # 交付链自检

# 短信文案专项（本次新增）
node .tmp-verify/be03-sms-copy.test.mjs       # 74/74
node .tmp-verify/sms-copy-mutate.mjs          # 6/6 变异

# 生产只读核对
S6_SSH_PASS=*** python scripts/deploy-s6-remote.py --dry-run

# 远端环境一览
ssh root@162.14.121.180 'docker ps --format "{{.Names}}|{{.Status}}|{{.Ports}}"'
```

### 11.2 关键数字（2026-10-30 复核）

| 项 | 值 |
|---|---|
| 插件源码 | 181 个 `.ts/.tsx`；H5 25 个 `.vue/.ts` |
| 数据表 / 迁移 | 25 / 18 |
| 接口动作 | public 9 · technician 2 · svc 18（另有 3 个内部 helper 文件） |
| 门禁脚本 | 117 个 `verify-*` + 46 其他 + 5 py = 168 |
| 文档 | 245 份 md |
| 偏差记录 | 220 条（唯一编号 210，**重复 10**） |
| TS 全量基线 | 219 条 / 101 键 |
| 生产版本 | server `0dc13875760cd924…` · client `62677303c562a33d…` · fp `b7044e2143bc211b…` |
| 生产公网 | `https://sh.scqfls.cn`（h5/api=200）· LE ECC 证书至 2027-01-20 · acme.sh 每日续期 |
| 待发布版本 | server `ab586ef53083e3ea…`（新增短信文案）· client `1c0845b91e9b4b48…`（不可复现） |
| 未提交改动 | 168 个（129 未跟踪 / 39 修改），最后提交 `9a57997`（2026-10-22） |
| Release | 🔴 HOLD |

### 11.3 证据索引（只列当前有效的）

| 主题 | 文件 |
|---|---|
| 现状登记 | `docs/PROJECT-STATUS.md` |
| 工程铁律 28 条 | `docs/ENGINEERING-RULES.md` |
| 缺陷与事故 | `docs/DEVIATIONS.md`（**按编号查，勿通读**） |
| 优先级与路线 | `docs/NEXT-ROADMAP.md` · `docs/BACKLOG.md` |
| 三场景短信修复 | `docs/BE-03-SMS-COPY-01.md` |
| 两页业务化签收 | `docs/BE03-BE05-UX-FINAL-DEPLOY.md` · `BE03-BE05-UX-REPORT.md` |
| P0 运行验收 | `docs/P6-P0-UAT-05-REPORT.md`（9/13、8/10） |
| TS 门禁缺口 | `docs/BUILD-TS-GATE-01.md` |
| Phase 11 收口 | `docs/PHASE-11-CLOSURE.md` |
| 历史导入 | `docs/BE-02A-FINAL-ACCEPTANCE.md` · `BE-02B-GATE2-REPORT.md` |

### 11.4 术语

| 词 | 含义 |
|---|---|
| **冻结 / FROZEN** | 行为、文案、权限口径、审计语义不再重新设计；只有**可复现回归**才重开 |
| **A/B/C 分诊** | 实现中新冒出的问题：A 影响闭环/安全/一致性⇒本阶段必修；B 只是 UX/运维⇒进 BACKLOG；C 属后续 Phase⇒不提前做 |
| **假绿** | 断言全绿但功能是坏的 |
| **假红** | 断言变红但产品没坏（多为夹具/判据问题） |
| **变异测试** | 把历史上的坑塞回去，证明断言会**在正确的地方**变红 |
| **PASS ≠ 发布** | 功能阶段 PASS/FROZEN 与 Release 放行是两件事，前者不解除 R-1~R-5 |

---

## 12. 一句话交接

> 这套系统的**业务闭环是通的、权限边界是硬的、验证资产是厚的、公网入口与证书已经上线**；
> 真正缺的不是代码，而是 **5 张外部条件**（真实短信、真实 IP 分桶取证、云回执、3 台真机、账号口令/门店资料）
> 和 **2 个裁决**（P0 与短信文案的部署批准、后续功能授权）。
> 接手时最该警惕的不是"哪里没写完"，而是"**别相信任何没有反向验证过的绿灯**"，
> 以及"**别相信没有标注日期的状态表**"——`PROJECT-STATUS` §4 的 R-2/R-3 就滞后了 8 天。
