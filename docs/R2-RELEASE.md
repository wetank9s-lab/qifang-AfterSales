# R2 发布包 · 版本标识 / 发布说明 / 部署回滚 / 遗留清单

> **状态**：R2 商用候选 **已验收通过，功能范围冻结**。
> **本文档不含生产部署授权** —— 生产发布须单独确认（见 §3 末尾「发布前置确认项」）。
> 生成时间：2026-11-16 · 对应本地隔离环境实测基线。

---

## 1. 版本标识

| 项 | 值 |
|---|---|
| 产品 | 家电门店售后服务平台 |
| 版本 | **R2**（商用候选） |
| 运行时 | NocoBase **2.2.15**（冻结，未升级） |
| 插件 | `@local/service-ticket` **1.0.0** |
| 构建标记 | `2026-11-16T07:26:51Z`（打进 client/server 产物，可在浏览器 Network/Console 自证） |
| 产物指纹 | client `index.js` = **649,161 B**；server `index.js` = **1,825,839 B** |
| 移动端产物 | `/m/`（Konsta 独立 H5，与 `/h5/` **并存不替换**） |
| 数据库迁移 | **24 个**脚本，**全部已应用**（逐条比对，0 遗漏） |
| 代码基线 | `git HEAD 9a57997` + 工作区 **373 条变更（待提交，含本文档）** |

### ⚠️ 版本标识目前**不完备**，必须先补一件事

`git HEAD` 是 `9a57997`，但 **R2 的全部成果仍在工作区未提交**（373 条，含本文档）。这意味着：

- 现在**没有一个可引用的提交**能代表 R2；
- 回滚时只能回滚到 `9a57997`（Phase-11），**会把 R2 全部功能一起丢掉**。

⇒ **发布前必须把工作区提交成一个 R2 提交，并打 tag**：

```bash
git add -A
git commit -m "feat(R2): 商用候选冻结版本 —— 工单详情/内部跟进/门店名称/菜单重组/Banner"
git tag -a r2.0.0-commercial -m "R2 commercial candidate, build 2026-11-16T07:26:51Z"
```

提交前**必须**跑密钥审计（技能 `repo-publish-secret-audit`）。本仓库的三类盲区
（运行期 `aes_key.dat` / 临时改过以为还原的配置 / 新写进 `docs/` 的真实门店名）已在
历史 DEV 中反复出现过，不要跳过。

> 本轮已补：`.gitignore` 增加 `.tmp-*/` 与 `.tmp-*` **通配**规则。
> 原因：此前 `.tmp-verify/` `.tmp-media/` `.tmp-orient/` 是逐目录列出的，于是新增的
> `.tmp-r2-lifecycle.json`（**含真实工单号**）、`.tmp-probe-g35-*.png`（含真实门店名）
> 全部是 `??`，一次 `git add -A` 就会进公开仓库。实测已从 379 条降到 372 条。

---

## 2. 发布说明

### 2.1 本版交付范围（已验收）

| 模块 | 状态 |
|---|---|
| 工单详情五阶段与全生命周期 | ✅ 验收 |
| 内部跟进（备注 / 时间线） | ✅ 验收 |
| 门店名称显示 | ✅ 验收 |
| 后台菜单重组（日常运维 / 系统维护） | ✅ 验收 |
| **B-36 客户报修页可配置 Banner** | ✅ 验收 |

### 2.2 Banner 实现要点（安全边界未放宽）

- **双目录物理隔离**：`storage/uploads-private`（客户附件，Token 门禁）
  vs `storage/uploads-banner`（公开可读）。
- **内容类型靠 magic bytes 判**（`sniffImageKind()`），不看扩展名、不看客户端声明 MIME
  ⇒ **SVG / HTML 天然被拒**，不是靠黑名单。
- **文件名带内容指纹**（`banner-<sha16>.<ext>`）⇒ 换图即换 URL。
- **发布模型两列同判**：公开读 filter = `{status:'PUBLISHED', revoked_at: null}`；
  下架时同时改两列 ⇒ `PUBLISHED + revoked_at≠null` 这个组合**正常业务流程走不到**。
- **门店回退不用布尔**：`store_id IS NULL` = 总部通用。

四条禁令全部守住：`publicMedia` 未改公开 / `/storage/uploads/` 未整体开放 /
进度 Token 附件规则未动 / 门店人员文件权限未扩大。

### 2.3 兼容性

- 数据库迁移**只增不改**（24 个全部幂等，已应用）。
- 无破坏性 API 变更；`svc:*` 动作集合未删减。
- `/h5/` 与 `/m/` 并存，互不替换。

---

## 3. 部署方案

### 3.1 拓扑（生产）

```
宿主机根      /opt/scqf-aftersales
插件产物      /opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist
容器          scqf-as-app（bind mount 插件目录）
compose       docker-compose.prod.yml
```

> 关键性质：插件目录是 **bind mount**，换 `dist` 三个文件 + `restart app` 即可，
> **不需要重建镜像**。

### 3.2 部署步骤

```bash
# 0) 先备份（产物 + 数据库），失败可回滚
node scripts/backup-db.mjs                 # 或 pg_dump 到 backups/
ssh root@<host> 'cp -a /opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist \
                       /opt/scqf-aftersales/backups/dist-$(date +%Y%m%d-%H%M%S)'

# 1) 本地构建（三件产物都要）
node scripts/build-plugin.mjs              # 产出 dist/client + dist/client-v2 + dist/server
cd h5       && npm ci && npm run build      # /h5/
cd src-mobile && npm ci && npx vite build   # /m/  ← 目录必须先存在再起容器

# 2) 上传产物
#    插件产物是 bind mount，只需替换 dist 下 3 个文件：
#      server/index.js、client/index.js、client-v2/index.js
#    ⚠️ 仓库里的 `scripts/deploy-s6-remote.py` **不纳入本版本库**，原因：
#      ① 硬编码生产主机 IP；② 硬编码了 2026-10 的旧产物哈希（EXPECT），与当前产物不符，
#      直接跑会在校验步骤失败。它是一次性历史脚本，不应作为发布基线。
#    ⇒ 用你方既有的上传通道（scp / rsync / 发布平台）把 dist 三个文件推到位即可。
#       如需沿用该脚本：先把 EXPECT 改成当前产物哈希、把 HOST 改为环境变量，
#       并确认它不在公开仓库中。

# 3) 🔴 必须 restart，不是 up -d
docker compose -f docker-compose.prod.yml restart app

# 4) 验证（只跑交付链这一条，不是全量回归）
node scripts/verify-bundle-delivery.mjs
```

> **为什么必须 `restart`**：服务端下发的 `?hash=` 由产物 mtime + APP_KEY + version 算出，
> 并被 `PackageUrls.items` **进程内缓存**；只 `up -d`（容器未重建）会继续下发旧 hash。
> 见 §3.3(d) 与 DEV-74。

### 3.3 ⚠️ 静态 JS 缓存：现状已正确，风险在**纪律**不在配置

用户点名要解决的第 2 项。本轮做了决定性实测，结论如下：

**（a）服务端不缓存静态文件** —— 造测试文件、改内容但**保持 mtime 不变**，
请求立刻返回新内容（`Content-Length` 20 → 28）。`.txt` 与 `.js` 一致。
不存在"文件缓存粘住"。

**（b）陈旧 `?hash=` 无害** —— 带假 hash `?hash=deadbeef` 请求，返回 **200 + 最新 649,161 字节**。
说明 `?hash=` 只是**浏览器缓存键**，服务端不校验它。

**（c）缓存头已是 `no-cache`** —— 实测两条通道（`dist/client` 桌面、`dist/client-v2` 移动）
均为 `Cache-Control: no-cache`，浏览器每次回源校验。
历史缺陷（DEV-74）当时的 `max-age=604800`（7 天、无 ETag）**已不存在**，
`verify-bundle-delivery.mjs` 的断言② 持续守这条，**不得改回长缓存**。

**（d）唯一真实风险：进程内 hash 缓存** —— 服务端下发的 `?hash=` 由
`sha256(产物 mtime + APP_KEY + version …)` 算出，且被 `PackageUrls.items` **进程内缓存**。
所以 **重建产物却不重启 ⇒ 服务端继续下发旧 hash**。

> 即便 hash 陈旧，因为 `no-cache` + 服务端每次返回最新字节，用户**仍能拿到新版本**；
> 但为了不留隐患，处置仍是**重启**。
> `verify-bundle-delivery.mjs` 的断言④（产物 mtime 不得晚于服务进程启动时间）
> 就是专门抓"改了没重启"这一条的。

**（e）SPA 层面的现实** —— 用户已打开的后台页面**不会自己重新请求 JS**。
部署后需要用户刷新一次（或下次进入）。这是 SPA 通病，不是缓存缺陷。
**R2 功能已冻结，本轮不为此新增版本提示 UI**，改为在发布通知里明确写"请刷新页面"。

### 3.4 回滚方案

| 层 | 回滚方式 | 备份位置 |
|---|---|---|
| **插件产物** | 还原 `dist` 备份目录 + `restart app` | `backups/dist-<ts>`（部署时创建） |
| **菜单重组** | `node scripts/_r2-menu-reorg.mjs --rollback` | 备份表 `_bak_menu_reorg`（**12 行**，实测有效） |
| **菜单（更早期）** | 同上脚本内建还原 | `_bak_desktoproutes_r2`（39 行）/ `_bak_rolesdesktoproutes_r2`（161 行） |
| **数据库** | `pg_restore` 整库 | `backups/*.dump` / `*.sql` |
| **代码** | `git checkout <上一个 tag>` | 需先完成 §1 的提交+打 tag |

菜单回滚**已实测**：`--apply` → `--rollback` → `--apply` → 重启两轮，
7 个角色的可见页面数每一步**逐字未变**（16/15/7/16/7/1/1）。
回滚后标题确实恢复为「售后工单」「服务档案」，页面归属也回到原组 ⇒ **不是只看退出码**。

### 3.5 发布前置确认项（**当前未完成，需人工决策**）

1. **代码提交与打 tag**（§1）—— 否则无可回滚基线。
2. **Banner 品牌素材替换**（见 §4 第 3 条）。
3. 生产 TLS 证书应从自签演练件换成受信 CA（`SVC_TLS_INSECURE=1` 必须去掉）。
4. 小范围关键功能核对（见 §4 第 3 条）。
5. **生产部署授权** —— 用户明确：本次未授权，须单独确认。

---

## 4. 遗留问题清单

### P1 · B-17 后台每次加载闪一条 `No permissions`

- **现象**：后台 SPA 每次加载请求 `environmentVariables:list`，被 B-8 守卫 403，弹一条红 toast。
- **本轮实测归因**：Banner 配置页加载期间**只有 1 条** `/api` 拒绝
  （`403 /api/environmentVariables?paginate=false`），**`svc:banner*` 零 403**。
  ⇒ 与 Banner 功能无关，不阻塞发布。
- **🔒 处置约束（用户明确）**：**不允许为了消除提示而放开环境变量读取权限。**
  该守卫是安全边界，噪声应通过**前端静默**或**降低请求频率**解决，不是放开读权限。
- **状态**：独立 P1，转发布后维护。

### P2 · Banner 品牌素材待替换

- **现状**：`store_banners` 表 **0 行**，`uploads-banner` 目录 **0 文件**
  ⇒ 验收用的彩条测试图**已全部清理，不会带到生产**。
- **上线动作**：由门店提供经确认的品牌图 → 后台「客户页面装修 → 客户报修页顶部横幅（Banner）」
  上传并发布 → 手机端报修页确认。
- **要求**：建议横幅比例 16:5 左右（移动端高度上限 32vw，实测 112px 占视口 13.3%）。
- **注意**：上传后是**草稿**，必须点「发布」才对客户可见。

### P3 · 后台静态 JS 部署纪律（非缺陷，防退化）

- 见 §3.3。必须守住两条：**改产物后 restart**、**该路径不得改回长缓存**。
- 由 `verify-bundle-delivery.mjs` 的断言②④ 持续守护。

### P2 · `P6-API-DTO-SENSITIVE-01`：DTO 下发哈希字段

- `svc:timeline.ticket` 等 DTO 下发 `feedback_token_hash` / `progress_token_hash`（**哈希非明文**）。
- 风险低（不可逆），但属信息最小化缺口。

### P3 · `updatedAt` 不是完整审计记录

- 只有一个时间戳，没有"谁改的 / 改前是什么 / 为什么改"；**裸 SQL 改动甚至不留痕**。
- 完整记录 = **迁移脚本 + 备份表 + 执行记录**三者合一（本版已具备）。

### P3 · 文档内真实门店名

- `docs/` 已在公开仓库，且含真实门店名（新都圣大家电 / 金堂华林电器）。
- **不得再写账号、口令、客户手机号、真实工单号。**

### 已知限制（产品决策，非待修 Bug）

- 短信宝通道**无送达回执接口**（官方能力边界）⇒ `DELIVERY CALLBACK` 可能永远无法实现。
  `msgid` 只能机会性记录，取不到就留空 + 留痕，**不截断**。

---

## 5. 本轮证据留存（不重复运行）

验收证据已固定，**不再重跑**：

| 证据 | 位置 |
|---|---|
| Banner 后台配置截图 | `storage/tmp/b36-admin/admin-banner-config.png` |
| 手机端三场景 | `storage/tmp/b36-browser/s1-published.png` / `s2-store-switch.png` / `s3-revoked.png` |
| 五阶段工单截图 **有效 5 张** | `storage/tmp/r2-five-states/`：`NEW_117179` / `PROCESSING_117182` / `WAIT_FEEDBACK_117186` / `WAIT_STORE_CONFIRM_117188` / `CLOSED_117189` |
| 五阶段探针数据（权威索引） | `storage/tmp/r2-five-states/probe.json` |
| 生命周期五态 | `storage/tmp/r2-lifecycle/` |
| 偏差记录 | `docs/DEVIATIONS.md`（DEV-260 ~ DEV-263 为本轮） |
| 工作日志 | `.workbuddy/memory/2026-11-16.md` §九 |

### ⚠️ 取证据时必须先读 `probe.json`

`r2-five-states/` 目录里实际有 **8 张图**，但有效证据只有 **5 张**；
另外 3 张是早期轮次（`CLOSED_6668` / `WAIT_FEEDBACK_117183` / `WAIT_STORE_CONFIRM_117184`），
**已被后续样本取代，不得当作证据使用**。

判据：**以 `probe.json` 的 `samples[].file` 为准**，并可用其中的 `bytes` / `hash` 逐字节核对。
**修改时间判断不了有效性**（8 张都在同一天，早期轮次只早几分钟）。
同目录的 `README.md` 已写明这张对照表 —— 留注记而不删旧图，是因为"那次为什么作废"
本身也是原始记录；但不说清，下一个人一定会拿错。

> 证据目录位于 `storage/tmp/`，**按 `.gitignore` 不入库**（含真实门店名）。
> 证据留本机 / 内部归档，发布包只引用路径，不搬运内容。

