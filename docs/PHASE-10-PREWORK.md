# Phase 10 开工前取证 —— 发布证据清点 + 生产形态评审

> **性质：只取证，不改实现。** 本文回答"当前系统能不能以一种明确、可回滚、可恢复、
> 不会把测试能力与敏感数据带进生产的形态发布"，并**只列出冲突与 release blockers**。
> Phase 10 契约在本文被确认之后再冻结。
>
> 取证时间：2026-09-26 21:00~21:40（+08:00）
> 代码基线：HEAD `6b7b35e`（Phase 9 交付完成）
> 环境：`svc-app` / `svc-postgres` / `svc-nginx` 三容器，`NGINX_HTTP_PORT=8080`
>
> **取证纪律**：每条断言都标注来源，分三档 ——
> `[实测]` = 本次第一手跑出来/查出来的；`[代码]` = 读源码/配置行号；`[未核实]` = 只读到文档说法。

---

## 0. 一页结论

| 编号 | Release blocker | 类别 | 严重度 |
|---|---|---|---|
| **RB-1** | 应用请求日志**无条件记录请求体** ⇒ 明文手机号/姓名/故障描述落盘，且**无保留期** | 数据出境/合规 | 🔴 高 |
| **RB-2** | 生产形态 = **无 TLS** + **三容器均 root** + `./storage` 全量可写 bind mount | 传输/主机加固 | 🔴 高 |
| **RB-3** | 发布物**不可复现、不可自证**：编译产物不在仓库、构建工具在仓库外且未锁版本、新鲜度判据是 mtime | 发布形态 | 🔴 高 |
| **RB-4** | **测试账号与测试能力随交付物进入生产**，且**没有"生产"这个概念**（无启动自检拒绝 mock 通道） | 测试能力外泄 | 🔴 高 |
| **RB-5** | 备份/恢复/回滚**只有文档样子**：无脚本、`BACKUP_PASSPHRASE` 零消费者、从未做过恢复 | 可恢复性 | 🔴 高 |
| **RB-6** | **没有 release-blocking 门禁清单**：README 总表停在 Phase 6、无 CI、`tests/` 为空 | 发布流程 | 🟠 中 |
| **RB-7** | 匿名 `/api/svc:health` **公示** mock 通道标志与业务逾期计数，且 `access_log off`（不可审计） | 信息泄露 | 🟠 中 |

**另有 9 条非阻塞冲突/风险**（§9），以及 **1 条当前红灯**（§3.5，`verify-config` 55/56）。

**必须先说清楚的一件事**：RB-1~RB-7 **没有一条是业务逻辑缺陷**。P7/P8/P9 的功能与安全边界
（含 D3）本次复核仍然成立（§8）。这些全部是**"跑起来了"与"可以发布"之间的落差** —— 正是
Phase 10 要解决的那一类。这也意味着 Phase 10 的性质确实与 P7~P9 不同：**它不能靠再加断言变绿，
必须靠"形态改变 + 一次真实演练"来证明。**

---

## 1. 取证方法（可复核）

| 手段 | 覆盖 |
|---|---|
| 静态读 compose / nginx / `.env(.example)` / `.gitignore` / 构建脚本 / 迁移与启动钩子 | 部署形态、配置同源、忽略规则 |
| `git ls-files` / `git check-ignore -v` 逐路径判定 | "什么会进仓库"（11 条敏感/杂项路径逐条查） |
| `git log -p -S` / `git grep HEAD` | 限流值是否被放宽过、产物与源码的时序 |
| `docker exec` 读容器 env / uid / 目录 | 容器真实状态（不是文档说法） |
| `docker compose up --dry-run --scale` | 单实例约束是否被编排层**结构性**拒绝 |
| 直连 DB（`psql`）读 users / roles / 列结构 | 账号真实状态 |
| 直连 HTTP（`curl`：health / healthz / callbacks / signIn / native export） | 匿名面与守卫真实行为 |
| **对落盘数据做内容计量**（日志 / 备份 / 导出残留 逐文件解析） | 敏感数据副本是否真的存在 |

**未做（明确声明）**：
- **未做任何恢复演练**（这正是 RB-5 要 Phase 10 补的，取证阶段做不了"没有路径的事"）。
- **未触发 `publicReview:sweepProbe`**（会真实关掉已到期工单 = 状态变更）。其可达性由
  `[代码]` + `[实测]` 的配置事实链推出，见 §5.3 标注。
- **未重跑在线门禁全量套件**（`smoke-test` 4097 行且写库）。本文只重跑了**离线**的
  `verify-config`（§3.5）与**两条 Phase 9 重门禁**（§8）。
- 未改任何源码、配置、数据；未重建产物；工作区提交状态未变（HEAD `6b7b35e`，`git status` 干净）。

---

## 2. ① 全量门禁清点

`scripts/` 下 **48 个 `.mjs`**。按可执行性质分四类 —— 这个分类直接决定"哪些能进发布必跑集"。

### 2.1 分类统计 `[实测]`

| 类 | 数量 | 说明 |
|---|---|---|
| `verify-*.mjs` | **26** | 验收断言（其中 11 个支持 `--reverse`） |
| `walkthrough-*.mjs` | 4 | 真人走查（3 个要浏览器） |
| `probe-*.mjs` / `_probe-*` | 2 | 一次性探针 |
| 工具/单一事实来源/脚手架 | 16 | `expected-*.mjs`（5）、`build-plugin`、`gen-secret`、`uat-*`(3)、`seed-admin-pages`、`technician-harness`、`ticket-page-actions`、`backfill-review-invite`、`prepare-p6-2-walkthrough` |
| **需要真机（联网/容器）** | **32** | 其余 16 个是离线/纯函数 |
| **需要浏览器（Chromium/CDP）** | 5 | `uat-preflight` / `walkthrough-*`(3) / `_probe-detail-request-runner` |
| **"元门禁"（反向/变异：临时改生产配置或源码，`finally` 还原）** | **4** | `verify-delivery-gate-reverse` · `verify-detail-gate-reverse` · `verify-technician-routing-reverse` · `verify-technician-h5-mutation` |

### 2.2 三类**不应进发布必跑集**的门禁（关键判断）

**(a) 元门禁（4 个）** —— 它们证明"门禁自己会红"（铁律 8），价值很高，但方法是
**临时改写生产配置/源码**：`verify-delivery-gate-reverse.mjs` 把 `nginx/conf.d/service.conf`
的缓存策略改回缺陷形态再 reload；`verify-detail-gate-reverse.mjs` **重建插件产物**。
在发布候选上跑它们等于"为了让门禁变红先把产品改坏"，且重建产物会让
`verify-bundle-delivery` 的 ④（产物不得晚于进程启动）必然变红（BACKLOG **B-9**）。
⇒ 归属：**开发期/CI 在独立环境跑**，不属于发布必跑。

**(b) 一次性历史门禁** —— `verify-concurrency-phase2.mjs`（100 路取号，README 自述
"Phase 2 门槛的唯一解除手段；2026-09-20 已通过"）。它**要求先放宽两层限流**（见 §6.3），
在发布环境跑会与实际限流配置冲突。⇒ 归属：**版本级回归**，不是每次发布必跑。

**(c) 走查脚本（4 个）** —— 面向真人验收（需要人在浏览器里操作/指定工单号），
`walkthrough-p5-1.mjs` 的注释自己就说会清库到基线。⇒ 归属：**阶段验收**，不是发布必跑。

### 2.3 发布必跑集（建议形态，待契约冻结）

| 层 | 门禁 | 为什么必跑 | 现状 |
|---|---|---|---|
| L1 静态/离线 | `verify-config.mjs` · `verify-plugin-load.mjs` · `verify-client-logic.mjs` | 不需要 Docker，能在**启动前**挡住绝大多数部署层错误 | **1 红**，见 §3.5 |
| L2 产物交付 | `verify-bundle-delivery.mjs` | 唯一守"代码改对了、浏览器到底拿不拿得到"的门禁 | 需先重建+重启 |
| L3 真机总闸 | `smoke-test.mjs` | 端到端 + 表/索引/参数种子/后台可用性 | 上次 119/119 |
| L4 阶段安全边界（带 `--reverse`） | `verify-native-export-bypass` · `verify-report-kpi` · `verify-store-review-write` · `verify-store-photo-access` · `verify-review-loop` · `verify-review-routing` · `verify-task-reliability` · `verify-ticket-actions` · `verify-technician-token-matrix` · `verify-technician-routing` · `verify-reassign-contract` | 这些守的是**安全边界与并发**，回归代价最高 | 全绿 |

> ⚠️ **L3/L4 全部需要写库**（造工单、造 Visit、翻 token）。**没有一个只读的"发布体检"档**。
> 也就是说：**当前不存在一套可以对着生产库或只读副本跑的门禁。** 这是 §7 要冻结的事之一。

### 2.4 文档与实际的三处不一致 `[实测]`

| 位置 | 文档说 | 实际 |
|---|---|---|
| `README.md:226-246`（自检脚本总表） | 列到 Phase 6 为止 | **Phase 7/8/9 的 ≥20 条门禁全部缺席**（`verify-review-loop` · `verify-task-reliability` · `verify-native-export-bypass` · `verify-report-kpi` · `verify-bundle-delivery` · `verify-technician-*` · `verify-reassign-contract` …） |
| `README.md:233` | "verify-plugin-load（**61 项**）" | 实际 **62** |
| `README.md:237` | "smoke-test（总闸，**106 项**）" | 实际 **119**（Phase 9 §12.4 已订正说明，README 未跟上） |
| `.gitignore:24` 注释 | "部署前必须 `cd h5 && npm ci && npm run build`" | 属实，但 **`verify-config.mjs:1097` 只断言 `h5/dist` 是目录** —— 空 dist 也过，`/h5/` 全站 404 |

**⇒ 无法把 README 交给运维当作"发布门禁清单"。** 这是 RB-6 的一半。
另一半见 §2.5。

### 2.5 没有 CI、没有测试套件 `[实测]`

- `.github/` / `.gitlab-ci.yml` / `Jenkinsfile`：**均不存在**。门禁**没有任何自动化触发**。
- 根目录**无 `package.json`** ⇒ 没有 `npm test`、没有统一的入口。
- `tests/` 只存在 `tests/unit/` 与 `tests/e2e/` 两个**空目录**，`git ls-files tests/` = **0**。
  ⇒ "全量测试"在 Phase 10 里**没有对应的东西可跑**，全部验证都在 `scripts/`。

---

## 3. ② 部署形态评审：Compose / 镜像 / 挂载

### 3.1 现状（`docker-compose.yml`，逐行） `[代码]`

| 项 | 值 | 行 |
|---|---|---|
| app 镜像 | `nocobase/nocobase:2.2.15-full-no-nginx` | :67 |
| postgres 镜像 | `postgres:16` | :35 |
| nginx 镜像 | `nginx:1.27-alpine` | :123 |
| 插件来源 | **bind mount**：`./storage/plugins/@local/service-ticket` → `/app/nocobase/node_modules/@local/service-ticket` | :99 |
| 全量状态 | **bind mount**：`./storage` → `/app/nocobase/storage` | :96 |
| app 暴露 | `127.0.0.1:${APP_DEBUG_PORT:-13000}:13000`（仅回环） | :102 |
| nginx 暴露 | `${NGINX_HTTP_PORT:-80}:80`（**唯一公网口**） | :137 |
| HTTPS | **注释掉**（`:138-139`） | :138 |
| 日志轮转 | 只对**容器 stdout**：app 50m×5 / pg·nginx 20m×5 | :57-61, :115-119, :146-150 |
| 加固 | **`user:` / `read_only` / `cap_drop` / `security_opt` / 资源上限：全部没有** | — |

### 3.2 回答"是否仍是官方镜像 + bind-mounted compiled plugin"

**是，且这是被 `DEV-26` 明确登记为"未完成"的事项。** `[代码]`

`docs/DEVIATIONS.md:237-246`（DEV-26）逐条写着：

> **状态 | ⏳ 已登记，待 Phase 10 处理（未完成，不得视为已解决）**

并已列出四条风险与候选方向："把插件 `dist/` 打进镜像（多阶段构建，`COPY --from=builder`），
只把真正的运行时状态（`storage/uploads`、`storage/logs`）留作卷；**若最终仍保留 bind mount，
必须补一份书面理由 + 回滚脚本 + 版本自证手段（容器内记录镜像 digest 与插件产物 hash）**"。

⇒ **本条不需要重新论证，只需兑现。** 现状附带三条实测证据：

- `[实测]` **编译产物不在仓库**：`git ls-files storage/plugins` = **0**。
  一份 `git clone` 之后 **`docker compose up` 直接起不来**（插件不存在），
  必须先跑 `build-plugin.mjs`（compose 头部注释第 3 步写了，但没有任何机制保证）。
- `[实测]` **构建链路的工具在仓库之外**：`scripts/build-plugin.mjs:73-79` 把
  `NODE_WORKSPACE` 解析为 `%USERPROFILE%/.workbuddy/binaries/node/workspace` —— 一个
  **本机 agent 沙箱路径**。实测该处 esbuild 版本 = **0.28.2**，
  而该 workspace 的 `package.json` / `package-lock.json` **不在本项目仓库里**。
  ⇒ 换一台机器重建，esbuild 版本不确定 ⇒ **产物不确定**。
- `[实测]` **"产物与源码同步"的判据是 mtime**：`scripts/verify-config.mjs:1205-1223`
  取 `src/**` 的**最大 mtime** 与产物 mtime 比较（`outM >= newest`）。
  ⇒ 它**既能被"touch 产物"骗过（不重建就变绿），也会因"touch 源码"而假红**（见 §3.5）。
  **源码与产物之间没有任何内容哈希绑定。**

### 3.3 生产 immutable image 应怎样收口（供契约决策，不在本次实施）

按 DEV-26 给的方向 + 本次取证，需要冻结的是四件事：

1. **产物来源**：`dist/` 由多阶段构建进镜像（`COPY --from=builder`），
   `storage/` 只保留**运行时状态**（`uploads-private` / `logs` / `tmp`）。
2. **版本自证**：容器内可读出 `镜像 digest` + `插件产物 hash` + `APP_KEY 指纹`（不含明文），
   让"当前到底跑的哪一版"**不依赖宿主机目录状态**。
3. **回滚单位**：回滚 = 回滚一个 tag/digest（而非"回滚文件系统"）。
4. **构建可复现**：esbuild / node / 基础镜像的版本必须**进仓库并锁定**
   （根 `package.json` + lock，或容器化构建）。

### 3.4 镜像版本冻结现状：**只到 tag，且 nginx 不在冻结范围** `[代码]`

`scripts/expected-versions.mjs` 冻结了 `NOCOBASE_IMAGE` / `POSTGRES_IMAGE` / `VERSION_PINNED_AT`
（tag 级，非 digest），`verify-config` 会断言 `.env` / compose / 冻结常量三处**逐字一致** —— 这条机制是好的。

但：**`nginx:1.27-alpine` 既不在 `expected-versions.mjs`，也没有任何断言覆盖它**
（全仓只出现在 `docker-compose.yml:123` 与文档）。
⇒ 公网入口组件的版本**漂移无人管**。tag 级冻结 + 可变 tag（Docker Hub 可重推）本身也不是
digest 级的不可变保证。

### 3.5 ⚠️ 当前 `verify-config` 是**红的**，并且是**假红** `[实测]`

```
P9 / 配置：❌ 通过 55 项，失败 1 项
  • 插件源码与构建产物同步（源码不晚于产物）
    构建产物比源码旧 —— 请重新运行 node scripts/build-plugin.mjs
```

**根因已定位（这是判据缺陷，不是产物过期）：**

| 项 | 时间 |
|---|---|
| 产物 `dist/server/index.js` | **20:29:36** |
| Phase 9 实现提交 `1f2c598`（改 9 个 src 文件） | 20:42:07（**仅提交时间**） |
| 触发红灯的文件：`services/visit-service.ts` | mtime **20:45:09** |
| `visit-service.ts` 最后一次**内容**变更 | `94fa3db`（Phase 8，17:26） |

而 `[实测]` `git diff --stat HEAD -- …/src` **为空**、`git status` 干净
⇒ **源码内容与 HEAD 完全一致，唯一"更新"的文件从来没改过内容**（被某次重写/触碰改了 mtime）。

⇒ 结论有两层，都要进契约：
1. **产品没有过期**；产物内容与已提交源码一致。
2. **判据本身不可靠**：mtime 判"产物新鲜"既会假红（当前）也会假绿（`touch` 产物即可）。
   在"发布物必须可自证"的目标下，这条必须换成**内容哈希**（源码 hash 与产物
   内嵌的构建标记比对），否则它是唯一连接"源码"与"发布物"的那根线，而它是空的。

---

## 4. ③ secrets / 默认账号 / 测试专属能力

### 4.1 secrets：入库面是干净的 `[实测]`

| 检查 | 结果 |
|---|---|
| `.env` 是否入库 | ❌ 未入库（`.gitignore` 覆盖）；`[实测]` `git status` 干净 |
| `.env` 是否含 `CHANGE_ME` 残留 | ❌ 无（`APP_KEY` 64 / `DB_PASSWORD` 40 / `SIGN_SECRET` 64 / `BACKUP_PASSPHRASE` 32 均已填） |
| `.env` 是否含模板之外的键 | ❌ 无（`set(.env) - set(.env.example)` 只有 UAT/SMOKE 口令 7 个，模板以注释坑位保留） |
| 逐路径忽略核查（11 条敏感/杂项） | ✅ 全部命中忽略规则（`backups/*` :31 · `storage/tmp/` :65 · `storage/uploads/` :34 · `.probe*` :91-93 · `.tmp-verify/` :74 · `.q*.sql` :102 …） |
| 运行期密钥文件 | ✅ `storage/apps/main/aes_key.dat`（32B）在 `storage/` 下，已被忽略 |

> **结论**：**密钥不会进仓库**这一点是站得住的。问题不在"入库"，在**运行期与发布物的形态**（§4.2~§4.4）。

### 4.2 账号：**9 个账号全部存活**，密码在容器环境变量里 `[实测]`

```
id  email                        roles
1   admin@nocobase.com           admin + root + member   ← NocoBase 默认超管，仍是默认邮箱
2   probe.store.a@example.com    store_after_sales       ← Phase 2 探针残留
13  probe.v2@svc.local           viewer                  ← Phase 2 探针残留
14  probe.v@svc.local            viewer                  ← Phase 2 探针残留
193 uat.store.a@svc.local        store_after_sales       ← UAT
194 uat.store.b@svc.local        store_after_sales       ← UAT
195 uat.hq@svc.local             hq_after_sales          ← UAT
476 uat.viewer@svc.local         viewer                  ← UAT
537 uat.hqadmin@svc.local        hq_admin                ← UAT
```

- `[实测]` **全部 9 个账号 `uat_restricted_at` 均为 `NULL`** ⇒ 没有任何一个被停用。
- `[实测]` **6 个口令变量被注入 app 容器**（一次 `up -d` 后会变 7）：
  `SMOKE_ADMIN_EMAIL` · `SMOKE_ADMIN_PASSWORD` · `UAT_STORE_A_PASSWORD` ·
  `UAT_STORE_B_PASSWORD` · `UAT_HQ_PASSWORD` · `UAT_VIEWER_PASSWORD`
  ⇒ `docker inspect` / `/proc/1/environ` / 容器内任意代码均可读。
- **公平地说**：停用机制本身是**扎实**的 `[代码]` ——
  `scripts/uat-accounts.mjs:471-487` 的 `--disable` 会 ① 撤门店映射 ② 撤角色 ③
  **把口令重置成随机 sha256**（登录不可能）④ 改名/改邮箱 + 打标记。`uat_restricted_at`
  只是标记，真正的闸是口令+角色。
  ⇒ **问题不是"机制是假的"，而是"机制没有跑过"**，且**没有任何门禁断言生产库里不存在测试账号**。

### 4.3 测试专属能力：4 个端点，**唯一的闸是 `SMS_PROVIDER=mock`** `[代码]`

| 端点 | 鉴权 | 自毁闸 | 当前是否可达 |
|---|---|---|---|
| `POST /api/public/reviews/_probe/sweep` | **匿名** | 非 mock ⇒ 404 | **可达** |
| `svc:tokenCheck` | 已登录 | 非 mock ⇒ 404 | 可达 |
| `svc:smsOutbox` | 已登录 + 总部特权 | 非 mock ⇒ 404 | 可达 |
| `svc:faultInject` | 已登录 + `X-Svc-Diag-Key == SIGN_SECRET` | 无 | 可达 |

`[实测]` 配置事实：
- `.env.example:103,107` 的**出厂默认是 `SMS_PROVIDER=mock` + `SMS_ENABLED=false`**；
- 当前 `.env` 与容器内实际值同样是 `SMS_PROVIDER=mock` / `SMS_ENABLED=false`；
- `[实测]` 匿名 health 端点自报 `"sms":"mock"`（见 §5.4）。

`[代码]` 闸的实现：`services/sms-service.ts:293` `isMockChannel()` 判**当前 provider 名**是否 `mock`；
`actions/public/review.ts:305` 用它决定 404。
注释自己写明了这条设计的前提（`review.ts:288-289`）：
> "安全性因此完全依赖上面那条自毁闸 **+ 生产环境 `SMS_CHANNEL` 必为真实通道这一事实**"

⇒ **这个"事实"目前既没有被配置保证（模板默认 mock），也没有被启动自检保证，更没有门禁。**
只要生产沿用了这份 `.env`，**4 个测试能力全部在线**；其中 1 个是**匿名**的。

### 4.4 凭据复用：`SIGN_SECRET` 一个密钥担三种角色 `[代码]`

| 用途 | 位置 |
|---|---|
| 照片受控读取的短时 HMAC 签名 | `SIGN_SECRET` |
| **匿名** `guardQuota` 的 HTTP 凭据（`X-Svc-Diag-Key`） | `actions/svc/guard-quota.ts:27`，`timingSafeEqual` 比较、fail-closed |
| `svc:faultInject` 的 HTTP 凭据 | `actions/svc/store-review.ts:262,270` |

三者威胁模型不同（签名密钥 / 匿名接口凭据 / 能"人为打挂一次门店确认"的能力），
但用的是**同一个值**，且该值就在容器 env 里。另外它经 HTTP 明文传输（§5.1 无 TLS）。
⇒ 建议在契约里拆成"签名密钥"与"诊断密钥"两个值（属加固项，非阻塞）。

### 4.5 "生产"这个概念不存在 `[实测]`

`[实测]` 容器 env 里 **`APP_ENV` 与 `NODE_ENV` 都没有设置**。
`[代码]` 全插件源码里没有任何 `isProduction` / "生产 profile" 分支，
唯一相关的是 NocoBase 日志级别默认值（compose `:93` 显式给 `LOGGER_LEVEL=info`）。

⇒ **系统无法区分"我在开发"与"我在生产"**，因此也就无法"在生产上拒绝启动"。
RB-4 的根因是这一条 —— 不是某个开关没关，而是**没有开关**。

---

## 5. ④ Nginx 与生产配置同源性

### 5.1 同源性：**结论是好的** —— 只有一份配置 `[实测] + [代码]`

- `[实测]` `nginx/` 下只有 3 个文件：`nginx.conf` · `conf.d/service.conf` · `conf.d/proxy-headers.inc`。
  **不存在 `ssl.conf`，不存在任何 test/prod 分叉的配置，不存在 `.template` / `.example`。**
- `[实测]` `grep -E '\$\{[A-Z_]+\}' nginx/` **零命中** ⇒ **没有环境变量模板机制**，
  同一份文件同时服务测试与生产（compose 以 `:ro` 只读挂载，`:132-133`）。
- ⇒ **"测试环境与生产配置不同源"这个风险在当前形态下不成立。** 这是本项目做得好的一点。

### 5.2 但"同源"也意味着：**测试期的放宽动作直接作用在生产文件上** `[代码] + [实测]`

`nginx.conf:67-74` 的注释写着：
> "⚠️ burst 之所以做成**环境变量**而不是写死 … 默认值保持 10；只有验收时显式调大。"

`[实测]` **这与事实不符**：`nginx.conf:72-77` 的 `limit_req_zone` 与
`service.conf:487` 的 `burst=10` 都是**硬编码字面量**；且 §5.1 已证明**没有任何模板机制**。
⇒ 这是一条**有安全含义的文档漂移**：读者会以为限额可以按环境配，实际只能改文件。

`[实测]` 历史核查（这一条是**好消息**）：`svc_public` 的 burst 在 git 全历史里
**只出现过 `burst=10`**（`git log -p` 统计 3 处命中全是 10），
**从未有"临时放宽的值被提交进去"**。配合 `[实测]` 当前 HEAD 的 `burst=10` 与工作区干净，
这条风险**没有被兑现过**。

`[实测]` 但它**没有任何门禁**：`verify-config.mjs` 只断言
（`:465`）"引用的 zone 都已定义"、`:557` `limit_req_status 429`，
以及 `:1184` 要求**文档不许复写** burst 数值。
**对客承诺 `rate=30r/m` 与 `burst=10` 本身，没有任何断言钉住。**
⇒ 未来一次"顺手放宽 + 提交"不会被任何东西拦住。这是"同源"带来的**真实运维风险**，
建议在契约里给限流值一次性冻结断言。

### 5.3 ⚠️ Token 明文进了 Nginx 访问日志（**与项目自己的纪律冲突**） `[实测]`

`[代码]` 项目的纪律与实现（对的）：`service.conf:169-189` 的 `/t/{token}` 与 `:206-216` 的
`/f/{token}` 都写了 `access_log off`，注释 `:148-152`、`:203-205` 明确说明理由 ——

> "`access_log off` 是**刻意的** … token 明文出现在请求行里，写进 nginx 访问日志 = 把作业凭证落到磁盘上。
> 本项目对 Token 的纪律是'明文只活一次'（不入库、不进事件、不进 SmsLog），**访问日志同理**。"

`[实测]` **但真正携带 token 的是 API 调用，不是那两条跳转**：

```
"GET  /api/public/reviews/<43位 Review Token 明文> HTTP/1.1
"POST /api/technician/visits/<43位 Technician Token 明文>/files  HTTP/1.1
"POST /api/technician/visits/<43位 Technician Token 明文>/submit HTTP/1.1
```

> ⚠️ **上文已按 Token 纪律脱敏**：原始日志行里是**真实 token 明文**（`[A-Za-z0-9_-]{43}`，
> 与 `REVIEW_TOKEN` / `TECHNICIAN_TOKEN` 的字节数与字符集一致）。取证时原样抄录过一版，
> **提交前已替换为占位符** —— 本项目纪律是"Token 明文只活一次"（不入库、不进事件、
> 不进 SmsLog），**本文档也不得成为它的第二个副本**。证据价值（形态/长度/路径位置）不受影响。

- `location ^~ /api/public/`（`service.conf:481`）与 `location ^~ /api/technician/`
  （`:558`）**都没有 `access_log off`**。
- `[实测]` 计数：technician token 形态命中 **257** 次（log 全历史）。
- `[实测]` `/api/technician/` 的 rewrite 把 token 从 **path** 挪到 **query**
  （`service.conf:569-577`），但 nginx 的 `log_format` 记的是 `$request`
  （`nginx.conf:28-31`）= **改写前的原始请求行** ⇒ token 仍以 path 形态落盘。

⇒ **保护装在了"没人走的腿"上，真正走 token 的那条腿没有保护。**
评价 Token 是**一次性凭证**、消费者是**客户手机浏览器**，
`service.conf:203-205` 自己说它比 `/t/` "更要紧"，却恰好漏了它。RB 之外的**高价值修正项**。

### 5.4 匿名面清单（逐条实测状态） `[实测]`

| 路径 | 结果 | 备注 |
|---|---|---|
| `/healthz` | **200** | nginx 自身，`access_log off` |
| `/api/svc:health` | **200** | **匿名**，见下 |
| `/api/callbacks/*` | **404** | 路由已声明但**无实现**（§9.1）；且是唯一**没有 `limit_req`** 的 `/api/` 块（`service.conf:594`） |
| `POST /api/auth:signIn` | **401**（正常） | **无锁定/无专用频控**，落在兜底 `location /` 的 `svc_general`（300r/m）（§9.2） |
| `/api/public/*` | 30r/m + burst 10 | 四个匿名接口 + **1 个探针**（§4.3） |
| `/api/technician/*` | 60r/m + burst 20 | 上传 + 受控照片读取 |

`/api/svc:health` **匿名返回**（`[实测]` 直接 `curl` 得到 1838 字节 JSON）：

```
sms:"mock" · version · tablesPresent:12 · registeredSvcActions:20 · rolesInAcl:4
slaAcceptanceOverdue:14 · slaAppointmentOverdue:0 · slaStoreConfirmOverdue:3
smsRetryPending · smsTerminalFailed · tasks{review_expiry,sms_retry,sla_scan}.runCount/lastError
uptimeSeconds · ready · checkedAt
```

⇒ 一次无鉴权 GET 就能知道：**① 短信通道是 mock（⇒ 4 个测试端点在线）**；
② 业务积压（14 张超时未受理、3 张门店确认超时）；③ 内部表数/ACL 结构/任务调度节奏。
且 `access_log off`（`service.conf:225,238`）⇒ **这类访问不留痕**。
设计与运维需要它（docker healthcheck / `verify-config` 用它），
但**"存活"与"诊断"没有被拆开**，且它同时是**不可审计**的。

### 5.5 TLS：**完全没有** `[实测] + [代码]`

- `[实测]` `nginx/conf.d/` 无 `ssl.conf`；`grep -rn "listen.*443|ssl_certificate" nginx/` **零命中**。
- `[代码]` `service.conf:39-41` 只有 `listen 80 default_server`；
  `docker-compose.yml:138-139` 的 443 映射是**注释**。
- ⇒ 当前形态下，**客户手机号、工单内容、师傅 token、评价 token、后台会话 cookie、
  以及 `X-Svc-Diag-Key` 全部走明文 HTTP**。

---

## 6. ⑤ PostgreSQL 备份 / 恢复 / 迁移 / 升级 / 回滚

### 6.1 备份：**没有脚本，口令没有消费者** `[实测]`

| 检查 | 结果 |
|---|---|
| `scripts/` 下有备份脚本吗 | **没有**（48 个脚本无一是备份/恢复） |
| `BACKUP_PASSPHRASE` 有消费者吗 | **没有**（全仓只有 `gen-secret.mjs:78` **生成**它；`[实测]` 生产代码 0 引用） |
| `BACKUP_RETENTION_DAYS` 有消费者吗 | **没有**（只出现在 `.env.example:168` 与文档） |
| 官方文档给的路径 | `README.md:213-224` 两条**手工** `docker compose exec` 命令 |

`[实测]` 而 `README.md:215-216` 给的命令是：

```bash
docker compose exec -T postgres pg_dump -U svc_app -d service_ticket -Fc \
  > "backups/db-$(date +%Y%m%d-%H%M%S).dump"
```

紧接着 `README.md:223` 写：
> "备份口令取自 `.env` 的 `BACKUP_PASSPHRASE`"

⇒ **这是错的**：`pg_dump -Fc` 不支持加密，命令里也没有任何加密步骤。
`BACKUP_PASSPHRASE` 不参与任何环节。**"备份加密"是文档里的一个空承诺。**

### 6.2 现状证据：工作区里躺着**未加密的全库 dump** `[实测]`

```
backups/pre-index-fix-20260920-165802.sql      327,127 B   明文 SQL
backups/uat-cleanup-20260922T113631.sql        320,788 B   明文 SQL
```

- `[实测]` 后者含 **265 处明文 11 位数字**（`customer_mobile` 等字段）。
- `[实测]` 两者都是**纯文本 `pg_dump`**（`-- PostgreSQL database dump` 头，
  **不是 `-Fc` 自定义格式、无加密**）。**与 README 给的命令形态都不一致。**
- 只靠 `.gitignore:31 backups/*` 挡着（`[实测]` `git ls-files backups/` = 0，未入库）。✅

### 6.3 恢复：**从未执行过，且没有可执行路径** `[实测]`

| 检查 | 结果 |
|---|---|
| 全仓 `pg_restore` 出现处 | **仅 `README.md:219`** 一条命令，无脚本、无文档、无演练记录 |
| 是否做过任何恢复演练 | **没有任何证据**（`docs/` 与 `CHANGELOG.md` 里 `恢复演练` 只出现在**承诺**语境） |
| 是否有回滚流程（版本级） | **没有**（无 `rollback` 文档；DEV-26 说"回滚要回滚文件系统"，即现状没有回滚单位） |
| 是否有升级流程 | **没有独立 CR 流程文档**；`expected-versions.mjs` 的注释描述了"改版本 = 需评审的动作"，但那只是**断言机制**，不是**升级步骤** |

`[实测]` `docs/SECURITY.md` 在**同一张威胁表**里承诺了三件事（`:28` 行）：

| 威胁 | 文档承诺的对策 | 折法位置（文档自己写的） | 实际 |
|---|---|---|---|
| 备份泄露 | `pg_dump` **加密** + `backups/` **权限收紧** + **恢复演练** | `scripts/` | **三项全无**：无加密、`[实测] backups/` 权限 `drwxr-xr-x`(755)、无演练 |

同文件 `:174` 还写着"**每月恢复演练**"——**这是一条从未运行过的控制**。

> ★ 这一条正是你在开工指令里点出的判据：**"存在 backup 脚本 ≠ PASS"**。
> 实际情况比那更靠前一步：**连脚本都不存在**，存在的是一条**格式错误**的 README 命令。

### 6.4 迁移：机制存在，但"启动即写库"要纳入回滚讨论 `[代码]`

`[代码]` 数据模型全部走 `defineCollection()`（`docs/DATA-MODEL.md:3`："NocoBase 自动建表与迁移，
**不手写 SQL 迁移脚本**"），迁移目录存在（`src/server/migrations/`）。
启动期还有若干**自愈**动作，均会**在检测到漂移时写库**：ACL 字段白名单对齐
（`.env.example:155` `SVC_ACL_FIELDS_AUTOFIX=1`）、`removeOrphanResourceRows()`、
角色资源补回、时间戳/interface 修复、参数种子补齐。
`[实测]` 本次读取的 health 显示各 `*ThisRun` 计数均为 `0` ⇒ 自愈是**幂等**的（无漂移不写）。

⇒ 待冻结的事：**回滚插件版本时，启动自愈会把 ACL/参数"修回该版本期望值"**。
这不是缺陷，但意味着**回滚不是只读动作**，必须在回滚流程里写清楚。

---

## 7. ⑥ storage/tmp、私有照片、日志、SmsLog 的持久化 / 清理 / 权限

### 7.1 落盘位置与"是否真的持久化" `[实测]`

| 数据 | 宿主路径 | 容器内 | 持久化方式 | 清理策略 |
|---|---|---|---|---|
| 私有照片 | `storage/uploads-private` (7.9 MB / 24 文件) | `UPLOAD_PRIVATE_DIR` | bind mount `./storage` :96 | **无** |
| 旧上传 | `storage/uploads` (32 KB / 4) | — | 同上 | **无** |
| **应用日志** | `storage/logs` (**67 MB / 75 文件**) | `/app/nocobase/storage/logs` | 同上 | **无** |
| 导出临时文件 | `storage/tmp` (2 文件) | — | 同上 | **无** |
| 插件产物 | `storage/plugins/@local/...` (3.7 MB / 12) | `node_modules/@local/...` | bind mount :96 + :99 | 重建覆盖 |
| DB | 具名卷 `svc_pg_data` | — | volume :48 | 无 |
| 备份 | `backups/`（宿主） | — | **无挂载** | 无（`BACKUP_RETENTION_DAYS` 未实现） |

**关键点**：compose 的 `logging: max-size/max-file`（`:57-61,115-119,146-150`）
只作用于**容器 stdout**；而应用日志是 NocoBase 自己写进
`/app/nocobase/storage/logs` 的**普通文件** ⇒ **完全不受 Docker 日志轮转约束**。
`[实测]` 该目录已到 **67 MB**，文件从 `2026-09-20` 起**全部保留**（7 天 75 个文件），
只有一个"按日新建、从不删除"的机制 ⇒ **生产上会无界增长**。

### 7.2 🔴 日志里真的有敏感数据 —— 这是 RB-1 的证据 `[实测]`

对 `storage/logs/main/request_*.log`（7 个文件）做逐行解析：

| 指标 | 值 |
|---|---|
| 明文 11 位号码出现次数 | **5,019** |
| 去重后不同号码数 | **1,402** |
| 字段分布 | `customer_mobile` **3,157** · `technician_mobile` **1,862** |
| 接口分布 | `publicTicket:create` 3,154 · `svc:dispatch` 1,430 · `svc:reassign` 432 · `serviceTickets:create` 3 |
| `masked` 形态（`138****8888`）出现次数 | **0** |

**机制**（`[实测]` 抽出的原始行，手机号已在此处替换）：NocoBase 的请求日志在
`response` 行里写 `action.params.values` —— **整个请求体**：

```json
{"level":"warn","message":"response /api/publicTicket:create", ...
 "action":{"actionName":"create","resourceName":"publicTicket",
   "params":{"resourceName":"publicTicket","actionName":"create",
     "values":{"store_code":"S01","ticket_type":"repair",
       "content":"冰箱不制冷了","customer_name":"张三","customer_mobile":"<PHONE>"}}},
 "status":400, ...}
```

即 **`customer_name`（姓名）+ `customer_mobile`（明文手机号）+ `content`（故障描述自由文本）**
在**成功(201)与失败(400)两条路径上都被记录**。同类还有 `svc:dispatch` / `svc:reassign`
写入的 `technician_mobile`。

**与项目冻结纪律的冲突**（`docs/SECURITY.md:19`，威胁模型表第 19 行）：

| 文档承诺 | 实际 |
|---|---|
| "手机号泄露 … **应用日志不写号码** \| 序列化层 DTO" | **实测 5,019 处明文，0 处掩码** |

并且 `[实测]` `docs/SECURITY.md:29` 承诺的"**结构化日志脱敏中间件**"**不存在** ——
`src/server/middleware/` 只有 `native-export-store…` 两个文件
（`native-export-guard.ts` · `store-scope.ts`），全仓 grep `redact|脱敏中间件|maskLog` **零命中**。

> **口径要诚实**：当前库内数据绝大多数是**合成/验收数据**（`张三`、`[SMOKE]…`、
> `UAT 客户`、`P5-1-TOKEN验收` 等）。所以"已经泄露了真实客户隐私"**不成立**。
> 但**机制是无条件记录请求体** ⇒ **真实流量一旦进来，同样落盘**。
> 这就是"不能带进生产"的那件事：不是测试数据进了生产，而是**生产会自己造第二份明文 PII**。
> （与你在 D3 里对导出审计的要求同源：**不要制造第二份敏感数据副本**。）

### 7.3 `storage/tmp` 的导出残留：**已核实是空壳** ✅ `[实测]`

```
storage/tmp/xlsx-1790423959096-hlcm3dm6q7.xlsx   2,215 B
storage/tmp/xlsx-1790423975093-mobkht68zq.xlsx   2,215 B
```

逐文件解析：ZIP magic 为 `PK\x03\x04` 但**无中央目录**（`BadZipFile`），
**无 `sheetData`、无 `sharedStrings`、明文号码命中 0** ⇒ 是**被中断的空工作簿**，
**不含任何数据**。

`[实测]` 但它们的**成因值得记录**：`storage/logs/main/action-export/2026-09-26.log` 显示
19:59:35 与 19:59:50 各有一次 **"Found 41 records to export from collection [serviceTickets]" +
"Export completed...... processed 41 records in total"** ——
**D3 的原生导出在守卫实现之前（守卫文件 mtime 20:02）确实成功导出过 41 条原始行。**
所以 D3 不是理论风险，是**已发生过一次**的事实。这两个空壳是它的残留。

`[实测]` `storage/tmp/` 已在 Phase 9 补进 `.gitignore:65`（唯一一条"漏了就会把含明文手机号的
XLSX 推上 public 仓库"的规则）。⇒ **忽略规则已补，但"清理"没有**：
`storage/tmp` 无任何清理动作，而**生产用的正是同一个 host 目录**（bind mount）⇒
**残留会随部署形态一起走**。契约里需要一条"发布前清理 + 导出临时文件生命周期"。

### 7.4 权限：三容器**全部 root**，数据目录 **755** `[实测]`

```
svc-app      uid=0(root) gid=0(root)
svc-nginx    uid=0(root) gid=0(root)     ← nginx 主进程，但 worker 由 nginx 配置降权为 nginx 用户
svc-postgres uid=0(root) gid=0(root)

backups/                 drwxr-xr-x   ← SECURITY.md:28 声称"权限收紧"
storage/logs             drwxr-xr-x
storage/uploads-private  drwxr-xr-x   ← 私有照片目录
storage/tmp              drwxr-xr-x
```

`[代码]` compose 无 `user:` / `read_only` / `cap_drop` / `security_opt`。
⇒ app 容器以 root 运行、且 `./storage` 整目录可写（含插件目录 = 可写入将被 require 的代码）。

### 7.5 SmsLog：**这一条是干净的** ✅ `[实测]`

按项目既有口径 `sms_logs` 只存掩码号；本次取证在日志侧**没有**发现 SmsLog 相关明文
（明文来源全部是 §7.2 的**框架请求日志**，不是 `sms_logs` 表）。
`verify-native-export-bypass` 的 T5 系列在 Phase 9 已用"deny 列真值 0 命中"覆盖了
CSV/导出出口。⇒ **数据库与导出出口这条线是守住的；漏的是"框架请求日志"这条线。**

---

## 8. ⑦ 版本冻结 / 启动自检 / health-readiness / DEV-37

### 8.1 health / readiness：能力齐备，但"存活"与"诊断"没拆 `[实测]`

`/api/svc:health` 里 `ready` / `status` / `tasksOverall` / `db` 四类判据都在，
`tasks{...}.neverRan/lastSuccessAt` 也已转正（Phase 8 交付）。
⇒ **作为 readiness 探针它够用**；问题是它把**诊断信息**也放在**同一个匿名端点**里（§5.4）。
`/healthz`（nginx 自身）与 app 的 healthcheck（compose `:106-114`，容器内直连 13000）
是分开的 ⇒ **拆分的落点已经存在，只差把响应体分级。**

### 8.2 启动自检：**有，但全部是"自愈/一致性"类，没有一条是"生产形态"类** `[代码]`

已有的启动自检（都真实存在）：导出列安全断言（`export-service.ts:124,199`）、
原生导出 deny 名单覆盖自检（`plugin.ts:1380`）、索引声明守卫、权限与字段白名单守卫、
声明 action 可达性守卫、照片方向能力探针（`photo-orient.ts:327`）、
时间戳/interface 修复、角色资源自愈、参数种子补齐。

**没有的**（`[实测]` 全仓 grep `isProduction|APP_ENV` 零命中）：任何一条
"生产环境不允许 X"的拒绝启动检查。例如下面这些**本可以在启动期拦住**的事：
`SMS_PROVIDER=mock` / `PUBLIC_BASE_URL` 是 `http://localhost` / `SIGN_SECRET` 为空 /
UAT 账号仍启用 / 未替换默认超管邮箱。

⇒ 这是 RB-4 的可执行解法（**不是**逐条删测试能力，而是**在生产 profile 下拒绝启动**），
建议写进契约。

### 8.3 DEV-37（单实例假设）：**已被部署形态结构性承接** ✅ `[实测]`

`docs/DEVIATIONS.md:365-372` 的约束是：① 同一 `request_id` 的互斥是**进程内**串行锁；
② `ticket_no` 取号发生在业务事务**之前** ⇒ 当前形态成立的前提是**只有一个 app 实例**。

`[实测]` 用非破坏方式验证：

```
$ docker compose up --dry-run --scale app=2
WARNING: The "app" service is using the custom container name "svc-app".
Docker requires each container to have a unique name. Remove the custom name to scale the service
```

⇒ **`container_name: svc-app`（`docker-compose.yml:68`）在编排层直接拒绝扩容**，
且 `:102` 的固定宿主端口 `127.0.0.1:13000:13000` 是第二道。**DEV-37 不是"靠人记得"。**

`[实测]` 但**没有任何断言或自检**把这条写下来（没有门禁检查 compose 里是否存在
`container_name`/`replicas`）。⇒ 次要项：建议在契约里补一条"单实例假设"的静态断言。

### 8.4 镜像版本冻结汇总 `[代码] + [实测]`

| 组件 | 冻结方式 | 断言 | 缺口 |
|---|---|---|---|
| NocoBase | `expected-versions.mjs:33` tag | ✅ `.env`/compose/常量三处逐字一致 | 非 digest |
| PostgreSQL | `expected-versions.mjs:39` tag `postgres:16` | ✅ 同上 | 非 digest；`16` 是浮动 minor |
| **Nginx** | **无** | **无** | **完全未纳入冻结**（§3.4） |
| 插件构建工具 esbuild | **无**（在仓库外，0.28.2） | **无** | **不可复现**（§3.2） |
| H5 前端依赖 | `h5/package.json` + `package-lock.json`（已入库 ✅） | 未见断言 | 无人守 lock 与产物一致 |

---

## 9. 非阻塞冲突 / 风险清单（登记，不要求 Phase 10 全做）

| # | 事项 | 证据 | 处置建议 |
|---|---|---|---|
| 1 | `/api/callbacks/*` 路由已声明（`service.conf:594`）但**实现为空目录** `src/server/actions/callback/`（0 文件），`[实测]` 实测 404；且是唯一无 `limit_req` 的 `/api/` 块 | `[实测]`+`[代码]` | 要么删路由要么留 TODO；`SECURITY.md:25` 的"按 provider 验签"承诺需改成"未实现" |
| 2 | **登录无锁定**：`[实测]` `signIn` 401 正常返回；`[代码]` 全仓无 lockout；落在兜底 `location /` 的 `svc_general`(300r/m) | `[实测]` | 契约里给 `/api/auth:` 一条专用限流 + 失败计数锁定（或明确接受） |
| 3 | `nginx.conf:67-74` 注释称 burst 是"环境变量"，实际硬编码（§5.2） | `[实测]` | 改注释；并给限流值加冻结断言 |
| 4 | `SECURITY.md:28` 称"`backups/` 权限收紧"，实际 755（§7.4） | `[实测]` | 与 RB-5 一起处理 |
| 5 | `SECURITY.md:29` 的"结构化日志脱敏中间件"不存在（§7.2） | `[实测]` | 与 RB-1 一起处理 |
| 6 | `README.md` 自检脚本总表停在 Phase 6、计数过期（61/106）（§2.4） | `[实测]` | 与 RB-6 一起处理 |
| 7 | 仓库根目录 **20 个游离文件**（`.probe-render-*.mjs`×11、`.probe-reverse-*.log`、`.q1.sql`、`.q-rev-del.sql`、`.baseline*.txt`、`.preflight*.txt`）—— 均已被忽略，但**仍在工作区** | `[实测]` | 发布前清理脚本 |
| 8 | `SIGN_SECRET` 一密三用（§4.4） | `[代码]` | 拆分"签名密钥 / 诊断密钥" |
| 9 | 启动自愈会在检测到漂移时写库；**回滚插件版本 = 一次非只读动作**（§6.4） | `[代码]` | 写进回滚流程 |

---

## 10. 你的六个问题，逐条回答

| 你问的 | 答（一句话） |
|---|---|
| **① 全量 gate 有哪些，哪些真正 release-blocking，去掉历史重复** | **48 个脚本**：26 `verify-*`（11 个带 `--reverse`）、4 走查、2 探针、16 工具/单一事实来源。**建议剔除 9 个**：4 个元门禁（临时改生产配置/源码，见 §2.2a）、1 个一次性并发门禁（需放宽限流）、4 个真人走查。发布必跑集建议 4 层（§2.3）。**但关键结论是：当前没有任何"只读发布体检"档，且没有 CI 触发（§2.5）。** |
| **② 是否仍是"官方镜像 + bind-mounted compiled plugin"，生产 immutable image 应怎样收口** | **是，且 DEV-26 自己标着"未完成，不得视为已解决"**（`DEVIATIONS.md:246`）。实测更糟一层：**产物不在仓库**（`git ls-files storage/plugins`=0）且**构建工具在仓库外的 agent 目录**（esbuild 0.28.2，未锁）。收口四件事见 §3.3。 |
| **③ secrets / 默认账号 / debug / fault-injection / probe / test-only endpoint 会不会进生产** | **secrets 入库面干净（✅）**；但**9 个账号全存活**（含默认超管 + 3 个探针残留 + 5 个 UAT）、**口令在容器 env 里**、**4 个测试端点只靠 `SMS_PROVIDER=mock` 这一个闸**（而模板默认就是 mock），且**系统没有"生产"这个概念**（无 `APP_ENV`、无启动拒绝）。⇒ **会。这是 RB-4。** |
| **④ Nginx /t/ /f/ 匿名 API 上传 native export guard 限流 日志脱敏 的生产配置是否与测试同源** | **同源（✅）**——只有一份配置、无模板、无 test 分叉、compose 只读挂载。**但"同源"带来两个后果**：① 实测放宽动作直接作用在生产文件上（历史未被兑现，`burst=10` 全历史一致 ✅，但**无任何门禁钉住限流值**）；② **日志脱敏这条线是断的** —— `/t/` `/f/` 有 `access_log off`，**真正携带 token 的 `/api/public/reviews/{token}` 与 `/api/technician/visits/{token}` 没有**（RB-1 的姊妹项，§5.3）。 |
| **⑤ PG backup/restore/迁移/升级/rollback 有没有实际可执行路径** | **没有。** 无备份脚本；`BACKUP_PASSPHRASE`/`BACKUP_RETENTION_DAYS` **零消费者**；README 的命令**格式错误**（`-Fc` 不加密却声称用口令加密）；**恢复从未执行**；无版本级回滚流程；现存备份是两份**未加密明文 dump**（其中一份含 265 处明文号码）。`SECURITY.md:28,174` 承诺的"加密/权限收紧/每月演练"**三项全无**。⇒ **RB-5。** |
| **⑥ storage/tmp 私有照片 日志 SmsLog 持久化/清理/权限；依赖与镜像冻结 启动自检 health/readiness DEV-37** | **持久化**：全部在 `./storage` bind mount ✅，但 compose 的日志轮转**只管容器 stdout**，应用日志 67 MB **无界增长、无保留期**（§7.1）。**权限**：三容器**全 root**、数据目录 755（§7.4）。**SmsLog 干净 ✅**。**SmsLog/DB/导出出口守住了，漏的是框架请求日志**（§7.2）。**版本冻结**：NocoBase/PG 到 tag 级 ✅，**nginx 完全未纳管**，**esbuild 不可复现**。**启动自检**：有 10 余条一致性自检，**没有一条是生产形态拒绝启动**。**health/readiness**：判据齐备但**匿名端点混装诊断信息且不记日志**（RB-7）。**DEV-37**：**已被 `container_name` 结构性承接 ✅**（dry-run 实证），只差一条断言。 |

---

## 11. 建议 Phase 10 契约冻结的内容（待你确认，本节不含实现）

1. **一句话目标**（沿用你的表述）：不是继续增加业务功能，而是
   **证明当前系统能够以明确、可回滚、可恢复、不会把测试能力与敏感数据带进生产的形态发布。**
2. **PASS 判据必须包含"演练凭证"**：至少一次**隔离环境** `backup → restore → 核心数据/约束验证`，
   并留下可复核的记录（脚本 + 输出 + 行数/约束比对）。**"存在脚本"不构成 PASS。**
3. **生产 profile 的定义与"拒绝启动"清单**（解决 RB-4）：定义 `APP_ENV=production` 语义，
   并列出该 profile 下**拒绝启动**的配置（mock 通道 / 未替换的 `PUBLIC_BASE_URL` /
   空 `SIGN_SECRET` / UAT 账号仍启用 / 默认超管邮箱）。
4. **发布物形态**（解决 RB-3）：immutable image + 镜像 digest 与插件产物 hash 的**自证**；
   构建工具链进仓库并锁版本。**若最终仍保留 bind mount，必须补 DEV-26 要求的那份书面理由。**
5. **敏感数据副本的唯一性**（解决 RB-1 + §5.3 + §7.3）：
   ① 框架请求日志**不得**记录请求体（或必须结构化脱敏）；
   ② 携带 token 的**API 路径**必须 `access_log off`（或改成不落 token 的形态）；
   ③ 应用日志的**保留期与轮转上限**；
   ④ 导出临时文件的生命周期。
6. **可恢复性**（解决 RB-5）：备份脚本 + 加密 + 保留期**必须真的实现**；
   升级/回滚流程；回滚时的启动自愈语义（§6.4）。
7. **发布门禁清单**（解决 RB-6）：把 §2.3 的四层落成**单一事实来源**，
   并明确"离线档能否对生产只读副本跑"；修正 README 总表与计数。
8. **未纳入冻结的组件补齐**：nginx 镜像版本；限流值（`30r/m` / `burst=10`）的静态断言。

---

## 12. 附录：本次取证的原始事实速查

```
HEAD                 6b7b35e           工作区 git status 干净
门禁脚本             48 个 .mjs         verify-* 26（11 带 --reverse）/ 走查 4 / 探针 2 / 工具 16
需要真机 32 · 需要浏览器 5 · 元门禁 4
tests/               0 文件（两个空目录）      CI：无
verify-config 现状   ❌ 55/56（唯一红灯 = "源码不晚于产物"，根因 mtime，非产物过期）
容器用户             svc-app/svc-nginx/svc-postgres 全部 uid=0
镜像                 nocobase/nocobase:2.2.15-full-no-nginx · postgres:16 · nginx:1.27-alpine（未冻结）
产物入库             git ls-files storage/plugins = 0
构建工具             esbuild 0.28.2 @ %USERPROFILE%/.workbuddy/binaries/node/workspace（仓库外，未锁）
DB 账号              9 个，全部 uat_restricted_at = NULL
容器内凭据变量       6 个（一次 up -d 后 7 个）
测试端点             4 个，唯一闸 = SMS_PROVIDER=mock（模板默认即 mock）
匿名 health          200，1838 B，含 "sms":"mock" / slaAcceptanceOverdue:14 / slaStoreConfirmOverdue:3
TLS                 无（无 ssl.conf / 无 listen 443）
应用日志             storage/logs 67 MB / 75 文件 / 保留 7 天全部 / 无轮转上限
日志明文号码         5,019 处（去重 1,402）；customer_mobile 3,157 · technician_mobile 1,862；掩码 0
nginx 访问日志       technician token 命中 257 次；/api/public/reviews/{token} 亦明文落盘
导出残留             storage/tmp 2 个 XLSX = 中断空壳（0 明文号码）✅
D3 历史成交          19:59:35 / 19:59:50 原生导出各成功 41 条（守卫实现于 20:02）
备份脚本             无；BACKUP_PASSPHRASE/BACKUP_RETENTION_DAYS 消费者 = 0
现存备份             backups/*.sql 明文全库 dump（其一含 265 处明文号码）
恢复演练             从未执行，无证据
单实例约束           docker compose up --dry-run --scale app=2 被 container_name 拒绝 ✅
```
