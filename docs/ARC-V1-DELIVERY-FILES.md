# ARC-V1 · 交付文件清单（Git 跟踪缺口）

> 建立于 2026-11-10 · **复核更新于 2026-11-11（A6 上线前核查）；R0 补充第七节 SHA256 对照于 2026-11-11**。
> 起因：核查发现 `archive.ts` **未被 Git 跟踪**，进一步排查发现整个 ARC-V1 档案模块的源码都还没进索引。
> 本轮**不 commit**（用户纪律），故先固化为清单，防止正式交付/部署时遗漏。
>
> ⚠️ **2026-11-11 复核发现本清单自身已过期**（上一版停在 31 项 / 源文件数 207），
> 且**漏记了 5 个关键文件**（含第 ④ 项"H5 客户查询及渲染文件"的全部成员）。本版按实测重写。
> 复核方法：`node .tmp-verify/a6/audit-delivery.mjs`（只读盘点，输出见 `.tmp-verify/a6/audit-result.json`）。

## 一、结论（2026-11-11 实测口径）

`nocobase/plugins/service-ticket/src/` 下有 **36 个** 文件处于 `git status` 的 `??`（未跟踪）状态。
它们全部是**真实参与构建**的源码 —— `scripts/build-plugin.mjs` 报告源文件数 **208**，其中 Git 跟踪 **172**，差值 36 完全吻合。

| 指标 | 本版实测 |
|---|---|
| 插件 `src/` 下 `.ts`/`.tsx` 总数 | 208 |
| 其中已被 Git 跟踪 | 172 |
| **未跟踪** | **36** |
| **`scripts/arc/` 页面配置交付物**（A6 新增·必传） | **8**（见第三节 ⑤） |
| **已跟踪文件修改**（R0 实测） | **64**（`--untracked-files=no`） |
| **交付包 SHA256 对照**（R0 新增） | **见第七节**（dist 四文件 + 迁移聚合 + H5 5 文件 + nginx） |
| 插件外未跟踪（`h5/` / `scripts/` / `docs/` 等） | 另有数十项，见第三节 |

> 口径：`git status --porcelain --untracked-files=all`（**必须展开**，见第 1.3 节）。

### 1.1 上一版遗漏的关键文件（本版补入）

| 文件 | 为何关键 | 上一版状态 |
|---|---|---|
| `h5/public/archive.html` | **第 ④ 项"H5 客户查询及渲染文件"** 的主体 | **漏记** |
| `h5/public/archive-render.js` | 同上（客户页渲染逻辑） | **漏记** |
| `src/shared/date-only.ts` | DEV-217 修复核心（UTC 构造 + 回读校验） | **漏记** |
| `src/shared/archive-edit-body.ts` | DEV-218 修复核心（`buildUpdateBody()`） | **漏记** |
| `src/client/date-only-input.tsx` | 原生 `<input type="date">` 控件（DEV-218） | **漏记** |
| **`docs/ARC-V1-DELIVERY-FILES.md` 本身** | **这份清单自己也没进 Git** | 未标注 |

> "清单自身未跟踪"这件事值得单独点名：**记录缺口的文档自己也在缺口里**，
> 换机器 clone 之后连"该补哪些文件"的线索都没有。

### 1.3 口径警告：`git status` 默认会**折叠**未跟踪目录

**2026-11-11 复核时自己踩了一次**，记下来免得重犯：

| 命令 | 输出 | 计数 |
|---|---|---|
| `git status --porcelain` | 含 `?? .../src/client-v2/`、`?? .../src/server/bootstrap/` 两个**目录行** | **35**（`.ts/.tsx` 只有 33） |
| `git status --porcelain --untracked-files=all` | 逐文件列出，无目录行 | **36**（全部 `.ts/.tsx`） |

未跟踪目录默认被折叠成一行 ⇒ 直接数出来差 3，看起来像"清单多写了 3 个文件"。
**实际是口径问题，不是缺口。** 这与 DEV-225 第 4 类（跟踪集含 1 个 `.mjs` 导致 209≠208）同族：
**比对数字之前先对齐口径，差值必须能逐条解释。**

### 1.2 ARC-V1 档案模块（本阶段主体）

| 类别 | 文件 |
|---|---|
| 集合定义（6 张） | `collections/serviceArchives.ts`、`serviceArchiveStages.ts`、`serviceArchiveEvents.ts`、`serviceArchivePhotos.ts`、`serviceArchiveQuerySessions.ts`、`serviceArchiveVerifyCodes.ts` |
| 服务层（4 个） | `services/archive-service.ts`、`archive-stage-service.ts`、`archive-photo-service.ts`、`archive-query-service.ts` |
| 服务端 action（2 个） | `server/actions/svc/archive.ts`（幂等 + 门店推导，**DEV-223 修复点**）、`server/actions/public/archive.ts` |
| 共用解析器（2 个） | `shared/date-only.ts`、`shared/archive-edit-body.ts` |
| 客户端区块（3 个） | `client/archive-create-block.tsx`、`client/archive-edit-block.tsx`（**DEV-224 分页修复点**）、`client/date-only-input.tsx` |
| client-v2 入口（2 个） | `client-v2/index.ts`、`client-v2/diag.ts` |
| H5 客户页（2 个） | `h5/public/archive.html`、`h5/public/archive-render.js` |
| 角色迁移 | `migrations/202611091-arc-v1-roles.ts` |

**构建与包标记（4 项，均已跟踪，不属于缺口）**：
`scripts/build-plugin.mjs`、`nocobase/plugins/service-ticket/package.json`、
`nocobase/plugins/service-ticket/tsconfig.check.json`、`types/ambient-stubs.d.ts`。

## 二、插件 `src/` 下未跟踪文件全量（36 项）

```
client-v2/diag.ts
client-v2/index.ts
client/archive-create-block.tsx
client/archive-edit-block.tsx
client/date-only-input.tsx
client/hq-pages.tsx
client/page-logic.ts
server/actions/public/archive.ts
server/actions/public/progress-review.ts
server/actions/svc/archive.ts
server/actions/svc/form-schema.ts
server/actions/svc/insight.ts
server/bootstrap/admin-close-batch.ts
server/collections/serviceArchiveEvents.ts
server/collections/serviceArchivePhotos.ts
server/collections/serviceArchiveQuerySessions.ts
server/collections/serviceArchiveStages.ts
server/collections/serviceArchiveVerifyCodes.ts
server/collections/serviceArchives.ts
server/migrations/202610231-pending-file-deletions.ts
server/migrations/202610251-review-verify-codes.ts
server/migrations/202610252-drop-review-verify-codes.ts
server/migrations/202611061-visit-short-code.ts
server/migrations/202611062-progress-derived-code.ts
server/migrations/202611063-progress-code-hash.ts
server/migrations/202611064-visit-one-assigned.ts
server/migrations/202611065-visit-manual-code.ts
server/migrations/202611091-arc-v1-roles.ts
server/services/archive-photo-service.ts
server/services/archive-query-service.ts
server/services/archive-service.ts
server/services/archive-stage-service.ts
server/services/file-deletion-consumer.ts
server/services/file-deletion-scheduler.ts
shared/archive-edit-body.ts
shared/date-only.ts
```
（共 **36 项**，全部为 `.ts`/`.tsx`；`src/server/bootstrap/` 下只有 `admin-close-batch.ts` 一个文件。
**取这份列表必须带 `--untracked-files=all`** —— 否则 `bootstrap/` 与 `client-v2/` 会被折叠成目录行，
列表变成 35 行、看着像漏了一个文件。）

## 三、插件外的未跟踪项

**① H5 客户页（ARC-V1 §④ 交付物）**：`h5/public/archive.html`、`h5/public/archive-render.js`

**② 文档**：`docs/ARC-V1-DELIVERY-FILES.md`（本清单）、`docs/STORAGE-LIFECYCLE-EVIDENCE.md`
（后者被盘点脚本标为"疑似测试工件"，实为**文档**，非工件 —— 属误报，保留。）

**②b R0 新增的生产只读预检脚本**：`scripts/prod-db-precheck-arc.sh`（**147 行，纯 SELECT，零 DDL/DML**）
—— 补 `scripts/prod-db-precheck.sh` 未覆盖的 ARC 项（六表存在性 / 路由 UID 冲突 / `member` 授权范围 /
门店与 904 绑定 / 角色与迁移基线 / 短信基线）。**已 `bash -n` 语法校验通过**，本轮**未执行**。

**③ `scripts/` 下大量未跟踪脚本**（约 60+），需**按用途甄别取舍**，不能整体 `git add`：

| 类别 | 例子 | 交付建议 |
|---|---|---|
| 构建/门禁（应当入库） | `build-plugin.mjs`、`prebuild-guard.mjs`、`verify-ts-baseline.mjs`、`verify-ts2741-baseline.mjs`、`verify-config.mjs`、`verify-tls.mjs`、`lib/ts-resolve-hook.mjs`、`expected-ts-baseline.json`、`expected-ts2741.json` | **入库**（已是构建链一部分） |
| 生产部署/运维 | `prod-deploy-*.py`、`prod-db-precheck.*`、`prod-baseline-diff.py`、`prod-log-audit.py`、`sync-migrations.py`、`nginx-merge-3blocks.py`、`gen-lan-dev-cert.mjs` | 入库（含密钥风险，先过审计） |
| 一次性探针/取证 | `probe-*.py`、`probe-*.mjs`、`p0hqm02-prod.py`、`fix-be05-be03-tree.mjs`、`shot-manual-tech-link.mjs` | **评估后决定**；建议归档到 `scripts/oneoff/` 或不入库 |
| 真实数据相关 | `prod-close-batch.py`、`prod-close-test-tickets.py`、`prod-close-verify.py` | ⚠️ **先查是否含客户/门店真实数据**，确认无敏感内容再决定 |

**④ `h5/src/pages/Customer/ProgressReview.vue`**（H5 源，非 ARC-V1）

**⑤ `scripts/arc/` —— A6 页面配置交付物（8 项，2026-11-11 新增，必须随 ARC-V1 一起传）**

这是 A6 补证得出的**唯一交付缺口**的载体。为什么它必须进清单：
**V2 移动页的页面配置不是文件交付，是数据库态数据**（只存在于开发库的 5 张表），
仓库原有的迁移 / 官方蓝图 / 既有脚本**三条路都覆盖不到**它（逐条否证见 `docs/DEPLOY-RUNBOOK.md` A0）。
**没有这些文件，换机器重建页面就无从下手。**

| 文件 | 作用 | 实跑结果 |
|---|---|---|
| `scripts/arc/arc-v1-rebuild-mobile-page.mjs` | **页面配置重放**（A2 的唯一载体） | 空库首建 **17/17**、不清库重跑 **17/17**（**必须 root 会话**） |
| `scripts/arc/arc-v1-page-payload.json` | 页面配置载荷快照（24 KB，可离线核对） | — |
| `scripts/arc/arc-v1-rebuild-accounts.mjs` | 目标环境业务账号就位（建号/绑角色/绑门店） | **5/5** |
| `scripts/arc/arc-v1-compare-config.mjs` | 重建后 vs 开发库**逐字段等价**自检 | **15/15** |
| `scripts/arc/arc-v1-verify-render-uat.mjs` | 真机渲染 + 越权复验 | **9/9** |
| `scripts/arc/arc-v1-fix-member-route-grant.mjs` | **最小权限修复**：剔除 `member` 的自动路由授权（**默认 dry-run**） | dry-run 只读通过；`--apply` **8/8**（含双向对照） |
| `scripts/arc/arc-v1-check-member-route-scope.mjs` | `member` 能力边界取证（只读探针） | 已实测 |
| `scripts/arc/arc-v1-verify-member-page-visibility.mjs` | `member` 真机页面可见性（浏览器实测） | 已实测 |
| `scripts/arc/arc-b1-nonarc-page-probe.mjs` | **非 ARC 页面探针**（P1/P2/P3，证明 UID 判据有区分力） | **13/13** |
| `scripts/arc/arc-r0freeze-artifact-check.mjs` | 产物核对：重建比对 + 功能标记计数 + 最终 SHA256 | 已实测 |
| `scripts/arc/arc-r0freeze-files-check.mjs` | 交付文件分类清点（9 项点名 + 本轮活动文件） | 已实测 |
| `scripts/lib/arc-uid-ownership.mjs` | **UID 归属判据唯一实现**（三条件：结构 + 集合绑定 + 层级） | 被上述脚本引用 |
| `scripts/verify-arc-uid-ownership-selftest.mjs` | 归属判据自证（双向 fixture + 变异测试） | **39/39** |
| `scripts/arc-r0chg01-rate-limit-boundary.mjs` | 限流边界补测（反向/并发/真 60s） | **36/36** |

> ⚠️ **为什么放在 `scripts/arc/` 而不是 `.tmp-verify/`**：`.tmp-verify/` 被 `.gitignore` 忽略
> （`.gitignore:103`），放那里的脚本**永远进不了交付**。A6 期间我先把它们写在 `.tmp-verify/a6/`，
> 收口时提升到 `scripts/arc/` —— 这个动作本身必须做，否则"已验证"的脚本传不出去。
>
> ⚠️ **口令只走环境变量**：`arc-v1-rebuild-mobile-page.mjs` 与 `arc-v1-fix-member-route-grant.mjs`
> 只从 `UAT_ROOT_EMAIL` / `UAT_ROOT_PASSWORD` 读凭据，**读不到就抛错**（刻意不读凭据文件，
> 避免把口令带进交付物）。其余脚本的用法见 `docs/DEPLOY-RUNBOOK.md` G2 与 A5。
>
> 🔴 **2026-11-11 补（DEV-229）**：上面这句话原本**只对一半脚本成立** ——
> `arc-v1-rebuild-accounts.mjs`、`arc-v1-verify-member-page-visibility.mjs`、
> `arc-v1-verify-render-uat.mjs` 与 `arc-v1-fix-member-route-grant.mjs` 曾把**业务账号口令明文写死**，
> 其中最后一个还写成 `env || '<明文>'` 的兜底式。现已全部改为：
> **`ARC_ACCOUNT_PASSWORD` / `ARC_SALES_PASSWORD` 必填，缺失即抛错**，无任何默认值。
> ⇒ 交付时**必须把这两个变量一并写进执行说明**，否则脚本会"按文档跑却直接失败"。
>
> ⚠️ **仍未处置**：`scripts/` 下另有 9 个**历史** `arc-*.mjs`（不在本清单内）同样含明文口令，
> 已登记为发布前必处置项（见 `docs/DEVIATIONS.md` DEV-229 末节）。



## 四、测试工件混入检查（2026-11-11）

盘点脚本对 `src/` 与插件外的未跟踪文件做了工件特征扫描（`*.test.*` / `*.spec.*` / `fixtures/` / `evidence/` 等）：

- **插件 `src/` 下：未发现测试工件混入**（36 项全部是产品源码）。
- **插件外：仅 1 项被标记**，实为文档误报（`docs/STORAGE-LIFECYCLE-EVIDENCE.md`），非工件。
- 结论：**没有测试夹具/证据文件混进交付集**。

## 五、正式交付前的动作（未执行，仅登记）

1. **不要只看 `git add -u`** —— 它**只覆盖已跟踪文件的修改**，
   本模块的 36 个新文件**一个都不会被加入**。这是本清单存在的原因。
   正确做法：按本清单**显式列名** `git add`，或 `git add` 目录后**逐项**核对。
2. 逐一确认上述文件**不含密钥/凭据**（按 `repo-publish-secret-audit` 技能走一遍）。
   三类盲区照旧：运行期密钥文件、**临时改过以为还原的配置**、新写进文档的业务信息。
3. `git add` 后**必须**用 `git diff --cached` 检查**实际入库值**
   （本仓库有过"以为已还原、实际入库"的事故）。
4. 校验点三连（**命令必须带 `--untracked-files=all`，见下方警告**）：
   - `git status --porcelain --untracked-files=all nocobase/plugins/service-ticket/src | grep -c '^??'` 应等于 **36**；
   - `git ls-files nocobase/plugins/service-ticket/src | grep -cE '\.tsx?$'` 应等于 **172**（跟踪的构建源文件）；
     172 + 36 = **208**，与构建报告"源文件数"一致；
   - `git status --porcelain --untracked-files=all` 中 `?? nocobase/plugins/service-ticket/src/` 逐条列名、**无目录折叠行**。
5. **页面配置交付物在不在**（A6 新增，缺一条就停）：
   - `git status --porcelain --untracked-files=all | grep -c '^?? scripts/arc/'` 应等于 **11**；
   - `ls scripts/arc/` 十一个文件齐（10 个 `.mjs` + 1 个 `.json`），载荷 `arc-v1-page-payload.json` 大小 ≈ 24 KB；
   - **四件套实跑全绿**才是"能重建"的证据（见 `docs/DEPLOY-RUNBOOK.md` G）：17/17 · 5/5 · 15/15 · 9/9；
   - 最小权限修复工具 `arc-v1-fix-member-route-grant.mjs` **默认必须只读**（不加 `--apply` 不写库）。

> ⚠️ **口径警告（2026-11-11 复核时自己踩了一次）**：
> **不带 `--untracked-files=all` 的 `git status --porcelain` 会把未跟踪目录折叠成一行**
> —— 输出里会出现 `?? src/client-v2/`、`?? src/server/bootstrap/` 这样的**目录行**，
> 于是计数得到 **35（含 2 个目录行）**、`.ts/.tsx` 只有 **33**，与 36 差 3，看着像"少了文件"。
> 实际是**口径问题，不是缺口**：展开后正好 36，且 36/36 全是 `.ts/.tsx`。
> 这与 DEV-225 第 4 类、DEV-226 是同一族错误 —— **比对数字前先对齐口径**。

## 六、为什么这些会漏

`.gitignore` 里**没有**针对它们的规则（已用 `git check-ignore` 逐条确认）。
它们是在 `git init` 之后的某个时间点**新增**的文件，而历次提交只提交了
`git add -u`（已跟踪文件的修改）或显式列出的文件 —— 新文件因此一直没进索引。
这类缺口不会报错、不会影响构建，**只在别人 clone 或换机器部署时才会暴露**。

---

## 七、交付包 ↔ 部署清单 SHA256 对照（R0 · 2026-11-11 实测）

> 用途：S4 上传后逐文件比对。**本地值由本轮实测生成**；
> 生产目标路径取自 `docs/PROD-DEPLOY-LOG.md`（**注意：生产是 bind 挂载，路径带 `src/`**）。

### 7.1 插件构建产物（三文件 + 指纹）

| 文件 | 本地路径 | 字节 | SHA-256（前 16） |
|---|---|---:|---|
| 服务端 bundle | `storage/plugins/@local/service-ticket/dist/server/index.js` | 1753517 | `8e2ce1d81318ebd7` |
| 客户端 bundle（后台） | `storage/plugins/@local/service-ticket/dist/client/index.js` | 533459 | `d5fb6f6328d73e64` |
| 客户端 bundle（V2 区块） | `storage/plugins/@local/service-ticket/dist/client-v2/index.js` | 218348 | `5e8dae1bb34f3d44` |
| 构建指纹 | `storage/plugins/@local/service-ticket/dist/build-fingerprint.json` | 24419 | `6dd8522e0b302960` |

生产落点：`/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist/<同名>`

### 7.2 迁移目录（整目录，铁律 1）

| 项 | 值 |
|---|---|
| 目录 | `storage/plugins/@local/service-ticket/dist/server/migrations/` |
| 文件数 | **48**（= 24 条迁移 × 2：`.js` + `.js.map`） |
| **目录聚合哈希** | `ae00ab76e54e7110cc33d9486da57fdca1b9a0ee08b6086be95a034e1c8c2ad8` |
| 算法 | 目录内文件 `sha256sum`（**按文件名排序**）后再整体取 `sha256` |

> ⚠️ **必须整目录上传**（铁律 1）：只换 `index.js` 不带迁移 ⇒ 新旧表结构不匹配。

### 7.3 H5 静态产物

| 文件 | 字节 | SHA-256（前 16） |
|---|---:|---|
| `h5/dist/archive.html` | 22043 | `1e01de4321a8df3a` |
| `h5/dist/archive-render.js` | 6872 | `6a68535c5dff3c16` |
| `h5/dist/index.html` | 987 | `b0f20092b47f4c69` |
| `h5/dist/assets/index-BzQUHIgl.js` | 168830 | `b2d51e063374280e` |
| `h5/dist/assets/index-Bk_EobzV.css` | 29513 | `0ecdbfd1f0e1b34e` |
| **目录聚合哈希**（不含 `.gitkeep`） | — | `ba2d4a1960ad85bff5fbfa41e6d85bbe2dde23f8727a0b7adce3342967c08a63` |

生产落点：`/www/wwwroot/sh.scqfls.cn/h5/`

> ✅ **自洽性已验证**：`index.html` 引用的 `assets/index-BzQUHIgl.js` 与 `assets/index-Bk_EobzV.css`
> **均存在于目录中**（引用与文件一一对应，不会白屏）。
> `archive.html` 只引用 `archive-render.js`（相对路径），同目录存在。
>
> ⚠️ **与生产现网指纹不是同一批**：生产 `h5/index.html` 目前是
> `116d3f75…`（11-06，字节 987 —— 字节数相同但内容不同，因为 asset 名变了）。
> 本次上传**必须整目录替换**，不能只补 `archive.html`，否则 `index.html` 引用的旧 asset 会 404。

### 7.4 Nginx 配置

| 文件 | 字节 | SHA-256（前 16） |
|---|---:|---|
| `nginx/conf.d/service.conf` | 60350 | `24440c11254ee7ef` |

生产落点：`/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`
（⚠️ 生产该文件 **310 行**，与本仓库文件**不是同一形态** —— 生产是"三块合并"后的结果。
**必须用 `scripts/nginx-merge-3blocks.py` 按块合并，禁止整文件覆盖**，见铁律 3。）

### 7.5 复核命令（S4 上传后在服务器上跑）

```bash
D=/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist
sha256sum "$D/server/index.js" "$D/client/index.js" "$D/client-v2/index.js" "$D/build-fingerprint.json"

# 迁移目录聚合
cd "$D/server/migrations" && ls | sort | xargs sha256sum | sha256sum
# 期望：ae00ab76e54e7110cc33d9486da57fdca1b9a0ee08b6086be95a034e1c8c2ad8
```

> 判据：**四文件哈希逐一相符 + 迁移聚合哈希相符**。任一不符 ⇒ **停**（此时还没重启，回滚零成本）。

---

## 八、PROD-PRECHECK 交付白名单与 SHA256 重新登记（2026-11-12）

> 🔴 **权威声明**：**第七节的 SHA256 是 R0 旧值，已过期，禁止用作 S4 判据**。
> 本轮实测发现第七节 4 个 dist 值（`8e2ce1d8…`/`d5fb6f63…`/`5e8dae1b…`/`6dd8522e…`）
> 与冻结清单全部不符；迁移聚合、H5 两个客户页文件也不同。
> **S4 一律以 `.tmp-verify/evidence/r0freeze/sha256-manifest.json` 的 `manifest[]` 为准**（4/4 MATCH），
> H5 / nginx / migrations 以本节 8.3 的实测值为准。若按第七节核对，会得到 4/4 假红；
> **更要命的是：为让判据变绿而回退到旧版 H5，会撤销 A5-G 的「阶段备注防泄露」修复。**

### 8.1 冻结四产物（与冻结清单逐文件 MATCH）

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `dist/server/index.js` | 1777305 | `7df7cef52e339a0fc75d6f69552d73c6b77e840e91dc90525857f7f994d3470b` |
| `dist/client/index.js` | 536445 | `c381d28468fbfaf1dd6de0988b7782d70a82080d6f9f35c24c75056fc4045e58` |
| `dist/client-v2/index.js` | 221334 | `5afddb5f9039e7b14d92c0b4f691276516c79d16054d364935fcf4e9881fcc7c` |
| `dist/build-fingerprint.json` | 24419 | `de09e6f4383c676c3f4d53089cb0f760947f5f838f5631e4ecb1204a62dc56b0` |

### 8.2 本轮要求「重新登记 SHA256」的修复脚本

| 脚本 | 修复内容 | SHA-256 |
|---|---|---|
| `scripts/arc/arc-v1-rebuild-mobile-page.mjs` | R1 收口：R5/R6 改双态判据（适配 S6-B 后 10 行/5 角色） | `b770c1783b8837cb82eecbcde9cea7a54b3e37255d4d297763c8ad07febd944a` |
| `scripts/arc/arc-r0freeze-artifact-check.mjs` | DEV-231：比对后自动回滚，防止核对脚本改坏冻结对象 | `e5fb73a4e7b3b685fe65d0d83836068ef72e379f4e16c8c74af9b6eec7efa854` |

**同时登记 DEV-229 的四个口令修复脚本**（口令改为只读环境变量，缺失即抛错）：

| 脚本 | SHA-256 |
|---|---|
| `scripts/arc/arc-v1-rebuild-accounts.mjs` | `0c7ff7edd5728a01acc6aee81be0df4040f332a14a0782526431f4e6aad138fb` |
| `scripts/arc/arc-v1-fix-member-route-grant.mjs` | `af08c5c4efb5bed9f5dab90405ea65155fe7211c530b1efd18e2c84dbcea435d` |
| `scripts/arc/arc-v1-verify-member-page-visibility.mjs` | `d007027e7d86e701c52eefbeef26b207d7ca9af9352c2f498cfacca677afcdad` |
| `scripts/arc/arc-v1-verify-render-uat.mjs` | `9e72c04c6aafdeb91096530dfd2411ad7135626ecf5e20474ca94651b73ad3cb` |

> 运行前必须显式注入 `ARC_ACCOUNT_PASSWORD` / `ARC_SALES_PASSWORD`（隔离库业务账号），
> 以及 `UAT_ROOT_EMAIL` / `UAT_ROOT_PASSWORD`（root 会话）。**口令不写进任何交付文件。**

### 8.3 其余部署文件实测值（S4 判据；H5 基线已于 S1-RECOVERY 冻结 → **见第九节**）

| 项 | 实测值 | 与第七节 |
|---|---|---|
| migrations 目录聚合（48 文件） | `1c351abc9edb62c7c84b3e44a307e31fa63af8ce92cf709ec70df430eac6ec04` | 不同（旧 `ae00ab76…`） |
| `h5/dist/archive.html` | `0939268b32edb33f97888ec10fe0bd75b2a47b3c4ef2c292b49df35ad1d9c08f`（12838 B） | **不同**（旧 `1e01de43…`） |
| `h5/dist/archive-render.js` | `04d46ebac7a17d5490116f06e443e780e8115ae54fac65ab3788b2b5a27fba93`（9253 B） | **不同**（旧 `6a68535c…`） |
| `h5/dist/index.html` | `b0f20092b47f4c69a7dd32611f349073859ddc14a62d0204b9c18508d8163a9b` | 相同 |
| `h5/dist/assets/index-BzQUHIgl.js` | `b2d51e063374280ee86d9a84455f721a1a800af90885e01271b55ecf45ca080e` | 相同 |
| `h5/dist/assets/index-Bk_EobzV.css` | `0ecdbfd1f0e1b34e98c26c733b864579292b1457eb7a0a664542efac0774bf41` | 相同 |
| H5 目录聚合（不含 `.gitkeep`） | ~~`6c3c26bac2a7d15d8ff02d4f92b82053ea0a0daf9a7118c8151ef67aad987c2b`~~ **已作废**（口径不明、不可复现）→ 见 9.1 H5_DIST_AGG_V1 | 不同 |
| `nginx/conf.d/service.conf` | `24440c11254ee7eff817650af12270988b354dc10ad74fad495e25c802f35cfa`（60350 B） | 相同 |

⚠️ **H5 客户页存在三套哈希（历史记录）**：**裁决已完成** —— 2026-11-12 S1-RECOVERY 正式冻结当前实物版，
唯一基线见**第九节**；下表三套哈希中前两套已作废，此处仅留版本谱系。

| 来源 | archive.html | archive-render.js |
|---|---|---|
| 第七节（R0 旧值） | `1e01de43…` | `6a68535c…` |
| `docs/ARC-V1-A4-FIX.md` | `7db1717d…` | `3210f81b…` |
| **当前实物**（A5-G 删 `if (st.note)` 防阶段备注泄露之后） | `0939268b…` | `04d46eba…` |

当前实物是**安全修复后**的版本，`h5/public/` 与 `h5/dist/` 逐字节一致。
**不得回退到前两版**（会把「服务端一旦恢复下发阶段备注就自动泄露」的通道重新打开）。
冻结清单 `sha256-manifest.json` 只覆盖 4 个 dist 产物，**不含 H5** ——
这一缺口**已于 2026-11-12 补齐**：H5 唯一权威冻结依据为**第九节**的
`h5-final-baseline.json`（`status=FROZEN`，7/7 属性 + 8/8 变异自证）。
S4 逐文件核对时以第九节的四个 SHA256 与 `H5_DIST_AGG_V1` 为准，**不要再等"用户裁决"**。

### 8.4 白名单完整性与敏感文件排除

实测（`.tmp-media/precheck-whitelist-audit.mjs`，只读）：**27 项全部存在，缺失 0**。
分组：`scripts/arc/` 11 项、R0-FREEZE/归属判据/限流 4 项、dist 四产物 4 项、H5 7 项、nginx 1 项。

**白名单内命中敏感模式（明文口令 / 私钥 / 凭据文件引用）= 0 项** ✅。

**禁止上传**：以下 10 个历史脚本含隔离环境明文口令，**全部不在白名单内**（DEV-229 原记 9 个，
本轮全量扫描多出 `arc-a1-accounts-db.mjs`）：

```
scripts/arc-a1-accounts-db.mjs      scripts/arc-a1-accounts.mjs
scripts/arc-a2-verify.mjs           scripts/arc-a3-verify.mjs
scripts/arc-a5-action-integration.mjs scripts/arc-a5-mobile-verify.mjs
scripts/arc-a5-v2-mobile-create.mjs scripts/arc-dev-admin-restore.mjs
scripts/arc-photo-verify.mjs        scripts/arc-rules-verify.mjs
```

另确认以下文件**不在白名单内**：`.env`、`.tmp-verify/.deploy-pass`、
`.tmp-verify/.synth-pass`、`h5/public/xss-test.html`（XSS 测试工件）。

### 8.5 发布前整库备份方案（仅方案，未执行）

生产现有机制：root crontab 三条 —— `02:40 backup.sh`、`周日 04:30 restore-drill.sh`、`09:00 watchdog.sh`；
密钥 `/root/.scqf-backup.key`（600 root），备份目录 `/opt/scqf-aftersales/backups`（2.3 G，日 7/周 3/月 1）。

**S3 之前须在授权下执行**：调用现成的 `/opt/scqf-aftersales/scripts/backup.sh` 再做一次整库 `pg_dump`
→ 确认 `status/last-run.json` 的 `ok=true` 与 `bundle_bytes` 非空 → 对新包跑 `sha256sum -c`。
**本轮只做只读盘点，未执行备份、未改任何配置。**

## 九、S1-RECOVERY · H5 最终安全版本唯一 SHA256 基线（2026-11-12）

> 🔴 **权威声明**：本节是 H5 客户页**唯一**冻结基线。
> 第七节 R0 旧值、8.3 节三套历史哈希、以及 8.3 的 `6c3c26ba…` 目录聚合值
> **全部作废**。接受当前含 A5-G 安全修复的实物，**严禁为匹配旧哈希覆盖当前安全版本**。
> 生成工具 `.tmp-media/h5-final-baseline.mjs`（全只读）；
> 证据 `.tmp-verify/evidence/h5-final-baseline.json`（`status=FROZEN`）。

### 9.1 唯一基线（S4 判据）

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `h5/public/archive.html` | 12838 | `0939268b32edb33f97888ec10fe0bd75b2a47b3c4ef2c292b49df35ad1d9c08f` |
| `h5/public/archive-render.js` | 9253 | `04d46ebac7a17d5490116f06e443e780e8115ae54fac65ab3788b2b5a27fba93` |
| `h5/dist/archive.html` | 12838 | `0939268b32edb33f97888ec10fe0bd75b2a47b3c4ef2c292b49df35ad1d9c08f`（与 public 逐字节同） |
| `h5/dist/archive-render.js` | 9253 | `04d46ebac7a17d5490116f06e443e780e8115ae54fac65ab3788b2b5a27fba93`（与 public 逐字节同） |
| **H5_DIST_AGG_V1 目录聚合**（5 文件） | — | `a629defc0932152a36649211ca74c4088d6a45cd102cd6b785e3652c145c4e76` |

**目录聚合算法 H5_DIST_AGG_V1（唯一口径，可复现）**：递归列 `h5/dist` 下所有普通文件，
排除 `.gitkeep` → 相对路径转 POSIX `/` 并按字典序升序 → 每行拼
`${sha256(file)}  ${rel}\n`（sha256sum 兼容的双空格）→ 对拼接串取 SHA256。
5 个文件为 `archive-render.js` / `archive.html` / `assets/index-Bk_EobzV.css` /
`assets/index-BzQUHIgl.js` / `index.html`。

> ⚠️ **8.3 的 `6c3c26bac2…` 作废原因**：该值生成脚本未登记算法，本机三种 shell 口径
> 复现分别得到 `0d94c6de…`（`ls|sort|xargs sha256sum`）、`4aa04303…`（`find` 全量）、
> `49f4c0ea…`（显式列 5 文件），**互不相同且均不等于登记值** ⇒ 不可复现，不得用作 S4 判据。
> 以本节 H5_DIST_AGG_V1 为唯一权威。

### 9.2 三套历史哈希各自对应的版本（旧值全部作废）

| 版本 | archive.html | archive-render.js | 字节 | 时间 | 内容 | 本机实物 |
|---|---|---|---|---|---|---|
| R0 旧版（第七节登记） | `1e01de43…` | `6a68535c…` | 22043 / 6872 B | 2026-11-09 前 | `innerHTML` 拼接、有 `#storeSel` 门店选择、有 `#codeInput` 短信验证码 | 无（仅文档） |
| A4-FIX 版（`ARC-V1-A4-FIX.md:121`） | `7db1717d…` | `3210f81b…` | 未登记 | 2026-11-09 | XSS 收尾：抽出 `archive-render.js`、全改 `textContent`；仍含门店选择/验证码/详情渲染 | 无（仅文档） |
| **★ 当前最终版（本轮冻结）** | `0939268b…` | `04d46eba…` | **12838 / 9253 B** | 2026-11-11 16:20/16:30 | R0-CHG-01 手机号直查（无门店选择/无验证码/不进 URL）+ A5-G 删 `if(st.note)` 防阶段备注泄露 | **有** |

前两版**禁止回退**：回退会把「服务端一旦恢复下发阶段备注就自动泄露」的通道重新打开。
`h5/public/` 与 `h5/dist/` 两个文件逐字节一致；`xss-test.html` 是测试工件，**不在交付白名单**。

### 9.3 7 条安全属性 —— 7/7 通过，并有 checker 变异自证

| # | 属性 | 精确判据 | 结果 |
|---|---|---|---|
| ① | R0-CHG-01 手机号直接查询 | 页面唯一 `publicArchive:queryByMobile`、只提交 `{ mobile }`；无 localStorage/sessionStorage/URL | ✅ |
| ② | 无门店选择、无短信验证码 | 无 `#storeSel/#codeInput/#sendBtn`；全文恰好 1 个 `<input>`（type=tel、maxlength=11） | ✅ |
| ③ | 服务端自动匹配真实门店 | 按实际命中 `store_id` 集合批量查 `stores`（不假设 ID 连续）；handler 不收前端 `store_id` | ✅ |
| ④ | 每 60 秒最多 3 次的服务端限流 | `window=60` / `ip=3` / `mobile=3` 三个**数值**精确相等；`consumeSliding` 恰好 2 次（IP+MOBILE）、`Retry-After`、`no-store`、缺依赖 fail-closed 503 | ✅ |
| ⑤ | 仅展示门店、档案类型、粗略进度 | 投影键集合**恰为** `{archive_type, archive_type_label, progress, progress_label}`；页面只调 `summaryStoreBlock` | ✅ |
| ⑥ | 不返回姓名/地址/内部阶段备注/照片 | 仅扫 `queryByMobileSummary` 方法体（**先剥注释**），11 个敏感字段名零命中；渲染层无 `if(st.note)`；页面不调详情/照片渲染函数；号码由服务端 `mobile_masked` | ✅ |
| ⑦ | 受保护详情/照片接口不放宽权限 | **逐 handler** 断言 `service.detail(tokenOf(ctx),` 与 `service.readPhoto(tokenOf(ctx),`；ACL 白名单仍在但 handler 强制会话 + `isPhotoCustomerVisible` | ✅ |

**checker regression fixture（双向 + 变异测试）**：拿真实源码喂一遍必须 7/7 绿；
再对内存副本做 8 个单变量变异（换查询动作 / 加回门店下拉 / 写死门店 ID / 窗口改 600s /
手机上限改 30 / 不调摘要渲染 / 投影塞回 `customer_name` / 详情去掉会话 token），
**8/8 全部让目标判据变红**。fixture 自身不通过 ⇒ `TEST INVALID` + exit 2，**不给产品结论**。
本轮它确实抓出两处验证器盲点（见 DEV-232），证明不是摆设。

### 9.4 冻结 4 个 dist 产物保持不变（4/4 MATCH）

| 文件 | 字节 | SHA-256 | 与 `sha256-manifest.json` |
|---|---:|---|---|
| `dist/server/index.js` | 1777305 | `7df7cef5…` | ✅ MATCH |
| `dist/client/index.js` | 536445 | `c381d284…` | ✅ MATCH |
| `dist/client-v2/index.js` | 221334 | `5afddb5f…` | ✅ MATCH |
| `dist/build-fingerprint.json` | 24419 | `de09e6f4…` | ✅ MATCH |

实物路径 `storage/plugins/@local/service-ticket/dist/`。**本轮 0 行构建、0 行覆盖**。

### 9.5 作废旧值清单

1. `1e01de43…` / `6a68535c…`（R0 旧版 H5）；
2. `7db1717d…` / `3210f81b…`（A4-FIX 版 H5）；
3. `6c3c26bac2…`（8.3 H5 目录聚合，口径不明且不可复现）；
4. 第七节 4 个 dist 值、迁移聚合、nginx 对照值 —— 按 8.1 / 8.3 既有声明继续作废。

---

## 十、PROD-HOTFIX-01 · 最小补丁包（2026-11-12）

> 用途：**只**列本轮（`publicArchive` 服务端闸门 + 重放脚本参数化）**实际变化**的文件。
> 未在本节的产物（H5 安全版、`nginx/conf.d/service.conf`、其余冻结产物）**沿用原哈希**。
> 证据：`.tmp-verify/evidence/hotfix01/patch-manifest.json`（由 `.tmp-media/hotfix01/gen-patch-manifest.mjs` 生成）。

### 10.1 服务端源码（闸门实现）

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `nocobase/plugins/service-ticket/src/server/middleware/public-archive-gate.ts`（**新增**） | 9028 | `fda052ae51e05ef6835824fc43a3fa38bdcb316e06a797bcff06c9aeb4c4bf35` |
| `nocobase/plugins/service-ticket/src/server/plugin.ts`（修改：挂载 `resourcer.use`） | 177859 | `ea0861acf65a4b5af2eb6b1befc0ee9f42c1e7096cb2c9d3713ee0db2545c488` |

### 10.2 构建产物（**S4 主判据**）

| 文件 | 字节 | SHA-256 | 说明 |
|---|---:|---|---|
| `dist/server/index.js` | **1782154** | `243b8de84f5385399530aace46b5aea18bb7ad0ca088b992a52341f4defe05a6` | **已重建**。旧值 `7df7cef5…`(1777305B) **作废，不得用作校核目标** |
| `dist/client/index.js` | 536445 | `2a1d0acadcdf9b558f13954e9e4a73c70da6e653d3cd28a15ed4db69234e6ff7` | 字节数不变；哈希变化**仅**因构建时间戳（见 10.5） |
| `dist/client-v2/index.js` | 221334 | `43abf05adeef6069bcd24b01d4920b4a1dbeb0219a5d1a69b0f2235552af2b90` | 同上 |
| `dist/build-fingerprint.json` | 24539 | `31da740bcca92e7c3ba6ee8bfc2195018a82dafd7fdd01adb8b305137f76843f` | 记录 211 个源文件、`digest=98e79dde…` |

### 10.3 迁移目录（整目录，铁律 1）—— **口径已修正（DEV-235）**

| 项 | 值 |
|---|---|
| 目录 | `dist/server/migrations/` |
| 文件数 | **48**（24 条迁移 × `.js` + `.js.map`） |
| **`MIGRATIONS_AGG_V1`**（S4 判据） | `2c82c48d55a8dd4c00c6a64460dabe215ad4c2c2c0b93f684424968f9a6db178` |
| `JS_ONLY_AGG_V1`（仅 24 个 `.js`） | `caad8294c28852bc6d270722d2f529b319a2cca873cf11a23a6840f80a4ddfca` |
| 算法 | `node scripts/lib/migrations-agg.mjs`（Windows/Linux 同值） |

> 🔴 **8.3 的 `1c351abc…` 作废**：那是 `ls|sort|xargs sha256sum|sha256sum` 在 **Git Bash** 下的值
> （`sha256sum` 用 `*` 作分隔符）；Linux 上是两个空格 ⇒ 同一目录两个值。
> **迁移源码本轮零改动**，已用「24 条迁移逐个按源码重建 = 24/24 SAME」证明（见 DEV-235）。
> 拿旧值去核生产 Linux 会得到假红。

### 10.4 冻结载荷与脚本

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `docs/arc/arc-v1-page-payload.json`（**新增**，生产 `ARC_PAYLOAD_MODE=file` 唯一输入） | 22092 | `cecd64421ffbc32b36f2f61888a8b56d2d76b7fc618f079261c8add014e4c4a0` |
| `scripts/arc/arc-v1-rebuild-mobile-page.mjs`（参数化 + 并集口径 + `--payload`） | 50337 | `fa6997b98e9983f78c2552ac95eac1d985f30f57aedfd329c181f31c52e264b6` |
| `scripts/lib/arc-uid-ownership.mjs`（新增 `pageShell` 前置层） | 14730 | `0fbf5fcd7ab5f988bfd1e258f1aad08dc39ceb764acb2af8fdd5bb7dc19f7a96` |
| `scripts/verify-arc-uid-ownership-selftest.mjs`（P1–P5 / M7 / M8，46/46） | 30960 | `7bdfe4b1d05537d53f7a938d1bffc3e90264d0821891ff4db82e9e5f4edb0ce0` |
| `scripts/lib/migrations-agg.mjs`（**新增**，跨平台聚合） | 3086 | `5ef4974103bb55c5b1d6a30161e229745959e22d12cca4bab740a5f4d1fa8013` |

**本轮新增验证脚本（不入生产，随交付包留证）**：

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `scripts/verify-public-archive-gate.mjs`（10/10） | 11586 | `dd8a1b01684eeca6ad9957ff44242325eec4ab68c8fdf442574d8826141bf346` |
| `scripts/arc/build-prod-like-baseline.mjs`（构造 34 条历史路由基线） | 10273 | `9cf0e042200c43f159ebd0888d2f358a70d9fc14ae0957a7a67e725c7cf35f86` |
| `scripts/arc/verify-arc-replay-prodlike.mjs`（12/12） | 15169 | `b7f382d0d6e187e7da2b78afa5e0e3cef37b7fad2c5a030af36c1d6297fd7e8f` |
| `scripts/verify-delivery-doc-hashes.mjs`（本节 ↔ 实物一致性，16/16） | 3713 | `4c35a2cbf9522955f319812ba26c670950647a3890a1149d9801e432c00b5560` |

**本节的核对方式（不要只靠肉眼对哈希）**：

```bash
node scripts/verify-delivery-doc-hashes.mjs
# 期望：汇总 PASS 16 / 16
```

它把"文档里登记的哈希"与"磁盘实物"逐条比对（含字节数），并已做反向验证
（改 1 字节 ⇒ 立即变 15/16 并指名文件）。

### 10.5 为什么 client / client-v2 的哈希变了（已证明"无业务改动"）

`build-plugin.mjs` 每次构建都会注入 `__SVC_CLIENT_BUILD__ = new Date().toISOString()`
（`src/client/build-stamp.ts`，设计目的是让运维在 Console 里看出浏览器跑的是哪一版）。
本次实物内嵌 `2026-11-12T03:12:23Z`。

**单变量隔离验证**：用与真实构建**完全相同的选项**（`banner`/`footer`/`keepNames`/`sourcemap`/
两遍构建取 `externalDeps`/`EXTERNALS`）重建，**唯一固定变量为时间戳**：

```
SAME  client     536445B / 2a1d0acadcdf9b55…
SAME  client-v2  221334B / 43abf05adeef6069…
```

**反向验证**：改时间戳为 `2026-01-01T00:00:00Z` ⇒ 两者都 DIFF，**字节数不变、哈希变** ⇒
证明差异确实只由时间戳驱动，且该判据有区分力。

**结论**：两个 bundle 内 `PUBLIC_ARCHIVE` 出现次数均为 **0** —— 闸门是**纯服务端**机制，
客户端产物**没有**功能变化。可在 S4 按 10.2 的新哈希核对，**不需要**为此回退客户端。

### 10.6 未变化（沿用原哈希）

| 项 | 沿用值 |
|---|---|
| `h5/public` 与 `h5/dist` 的 `archive.html` | `0939268b…`（12838 B） |
| `h5/public` 与 `h5/dist` 的 `archive-render.js` | `04d46eba…`（9253 B） |
| `H5_DIST_AGG_V1` | `a629defc0932152a36649211ca74c4088d6a45cd102cd6b785e3652c145c4e76` |
| `nginx/conf.d/service.conf` | `24440c11…`（60350 B） |

（本轮逐字节复核 `h5/dist` 与 `h5/public` 四个文件，与第九节冻结基线一致。）

### 10.7 生产 Nginx 封堵现状（只读复核，**未删除、未改动**）

| 判据 | 结果 |
|---|---|
| 配置含 `location ^~ /api/publicArchive:` + `return 403` | ✅（`sh.scqfls.cn.conf:270`） |
| `nginx -t` | ✅ syntax is ok / test is successful |
| 4 条匿名 action 外部实测（443 + `--resolve`） | ✅ `queryByMobile` / `sendCode` / `list` / `queryByMobileSummary` 全 **403**（`server: nginx`） |
| 反向对照 `publicStore:list` | ✅ **200**（未误伤） |
| 公网直连 `:13000` | ✅ `CONN_FAIL`（仅绑 `127.0.0.1:13000`，无绕过路径） |
| **回环直连 `127.0.0.1:13000`** | ⚠️ **200 + 真实数据**（`{"data":{"mobile_masked":"138****0000",...}}`）⇒ **应用层开关尚未部署**，本轮闸门正是为封死这条 |

> ⚠️ 探测口径教训：`127.0.0.1` + 80 口得到 404/301 是**判据错**（该 vhost 是 `server_name sh.scqfls.cn`，
> 且 80 → 301 跳 443）。必须 `curl --resolve sh.scqfls.cn:443:127.0.0.1 https://...`。

