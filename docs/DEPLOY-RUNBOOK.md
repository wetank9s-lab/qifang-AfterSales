# 生产部署规范（从 2026-11-06 那次真实事故提炼）

> 适用：所有 `scqf-as-app` 生产发布。
> 每一条都对应一次**真实踩过的坑**，不是假想的风险清单。
> 配套：`docs/PROD-DEPLOY-LOG.md`（上线登记）、`scripts/prod-deploy-cumulative.py`（执行）。

---

## 铁律 0：环境假设必须实测，不能沿用本地

本地与生产的差异（第一次部署时写死的假设**全部错误**）：

| 项 | 本地开发 | 生产 | 踩到的后果 |
|---|---|---|---|
| PG 用户 | `svc_app` | **`scqf_as`** | `FATAL: role "svc_app" does not exist` |
| 库名 | `service_ticket` | **`scqf_aftersales_candidate`** | 同上 |
| nginx 配置 | `conf.d/service.conf`（1002 行） | **`/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`（281→310 行）** | 整文件覆盖会毁站 |
| 插件 dist | `<root>/storage/...` | **`<root>/src/storage/...`** | 找不到目录 |

**规矩**：
1. 库凭据从容器环境读，不写死：`docker exec <pg> env | grep '^POSTGRES_'`（口令只取名字不打印）。
2. nginx 路径从宝塔 vhost 找：`grep -rl '<域名>' /www/server/panel/vhost/nginx/`。
3. **`find /opt` 找 dist 是错的** —— 生产还有 `p6-uat` / `scqf-uat-inst` / `scqf-r4-uat` /
   `scqf-media-test-app` 四个 UAT 实例，同样有同名 `dist`。必须按**容器挂载点**定位：
   ```bash
   docker inspect scqf-as-app --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}'
   ```
   取 `Destination` 以 `/storage/plugins/@local/service-ticket` 结尾且 `RW=true` 的那一条，
   `Source` 才是真正要写的目录。**命中数 ≠ 1 就停，不猜。**

---

## 铁律 1：迁移是独立打包的，换 `index.js` 不会带上迁移

### 事故
第一次部署只替换了 `dist/server/{index.js, client/index.js, build-fingerprint.json}` 三个文件。
结果：进程重启、`upgrading... / run upgrade` 都正常、健康 **200**，
但 `migrations` 表仍是 **33**，触发器、索引、新增列**一个都没有**。

⇒ 这是一个**最危险的半截态**：代码是新版（会去查 `manual_code_hash`、调 `shortCode`），
库是旧版（列不存在）⇒ 真实业务一进来就 500，而健康检查全绿。

### 根因
`dist/server/migrations/*.js` 是 esbuild **单独打包**的产物，不在 `index.js` 里。
migrator（umzug）扫描的是那个**目录**，不是 bundle。

### 判据（唯一可信）
**不认"重启过"，不认"日志里跑了 upgrade"，只认库里的状态：**

```sql
SELECT count(*) FROM migrations;                          -- 必须等于预期值
SELECT name FROM migrations WHERE name LIKE '%<本次前缀>%'; -- 必须逐条出现
SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relname='service_visits' AND NOT tgisinternal;     -- 触发器必须在
SELECT indexname FROM pg_indexes WHERE indexname IN (...);  -- 唯一索引必须在
```

### 规矩
1. 发布产物清单**必须包含** `dist/server/migrations/`（整目录），不是一个文件。
2. 用 `scripts/sync-migrations.py --apply` 补齐：只新增、不删除、逐文件 sha256 复核。
3. **迁移未落库 = 发布未完成**，即使健康 200。此时应视为「代码已上、库未上」，
   要么补齐迁移，要么立刻回滚代码。

---

## 铁律 2：健康检查的判据本身必须先被验证

### 事故
第一次部署判"健康失败"并自动回滚，**实际上生产 25 秒就 200 了**。

根因一行：
```python
r.run("curl ... -w '%%{http_code}' " + URL)   # ← % 运算符把 %% 转义成字面 %
```
`%%` 在 `%` 格式化后变成 `%`，但这里用的是**字符串拼接**而不是 `%` 格式化，
于是 curl 收到的就是字面量 `%%{http_code}`，原样输出 7 个字符，永远 ≠ `"200"`。

### 规矩
1. **写死的判据先在命令行跑一遍，看真实输出**再写进脚本。
2. 判据拿到的值如果要和常量比较，**先打印一次实际值**（`log("[S2] health=%r" % health)`），
   而不是只判真假。
3. **"脚本说失败"与"产品失败"必须分开报**：
   脚本判定异常时，先人工复核一次真实状态（`curl` + `docker ps` + `docker logs`），
   再决定是否回滚。盲目自动回滚会把一次成功部署变成一次停机。
4. 回滚动作要**幂等且不扩大破坏**（本次回滚只动 `dist`，没有动数据库）。

---

## 铁律 3：Nginx 只按块合并，绝不整文件覆盖

生产 vhost（310 行）与仓库配置（1002 行）**结构完全不同**：
仓库是"一个 server 块装下所有 location"，生产是宝塔生成的独立 vhost。

**规矩**：
1. 先 `scp` 下来与仓库 `diff`，定位**真正缺哪几段**（本次只有 2 处：`/p/t/{22}` 与 6 条 `?code=`）。
2. 插入前断言**锚点唯一命中**（`count(anchor) == 1`），否则停止。
3. 已经存在的段落**不重复插入**（幂等，可重跑）。
4. 生产已经修好、但仓库落后的段（本次的 `/p/` 双长度正则）**保持生产原样**，
   不要"顺手同步仓库版"——那等于把修复回退。
5. 顺序固定：**备份 → 写入 → `nginx -t` → 失败即还原 → 成功才 reload → 检查 `is-active`**。
6. `nginx -t` 里 `conflicting server name "_"` 是**既有告警**（其它站点），
   判定只看 `test is successful`。

---

## 铁律 4：验收判据要落到真实契约上

- **`/p/t/<code>` 的 302 不代表链接有效** —— nginx 是纯路由，任何 22 位字符串都 302。
  真正的有效性在 `technicianVisit:get` 的响应里（401 `TOKEN_INVALID` vs 200）。
- **接口 404 与 401 语义完全不同**：404 = 路由/动作不存在；401 = 存在但拒绝。
  验证"接口上线了"要看它**返回业务错误码**，而不是看它不 404。
- **测 token 形状时注意长度**：曾用 46 位字符串测 43 位规则，得到假 404。
  生成测试串时用 `python -c "print('A'*43)"`，并**打印实际长度**。
- **`sms_logs` 的分布是零发送的硬证据**：部署前后逐项比对
  （`send_status × provider` 计数完全一致），比"我没发短信"这句话可靠。

---

## 铁律 5：日志窗口必须自证，`--since` 的时间格式会静默骗人

### 事故（2026-11-06 收尾核对时发现）

收尾核对"发布后有没有新增 error"，我先用 `docker logs --since 10m` 查 —— 空；
改查全量，得到 618 条 error（跨 10-22 ~ 11-06 两周），看起来像"发布后大量报错"。
两次都错，因为**窗口本身没被验证过**。

### 三个具体坑

| 坑 | 现象 | 真因 |
|---|---|---|
| `--since 10m` 空结果 | 以为"没报错" | `upgrading...` 是 10 分钟前打的，窗口刚好错过 |
| 全量 618 条 | 以为"发布把系统搞崩了" | 长寿命容器，两周历史混进来 |
| `--since '2026-11-06 14:35:22'`（**带空格**）只回 1 行 | 以为"干净" | Docker 对空格格式**解析成别的意思且不报错**；同一时刻用 `T` 分隔回 896 行 |
| `StartedAt` 是 **UTC**（`06:36:22Z`），日志是 **+08:00**（`14:36:22`） | 窗口早 8 小时 | 直接把 UTC 串喂给 `--since` |

### 规矩
1. **时间一律用 `T` 分隔**：`--since 2026-11-06T14:35:22`。带空格的格式在实测中会静默只返回 1 行。
2. **窗口起点从容器算，不从"现在"倒推**：
   ```bash
   docker inspect <app> --format '{{.State.StartedAt}}'   # UTC
   docker exec <app> date -d '<那个值>' '+%Y-%m-%dT%H:%M:%S'  # 换成本地日志时区
   ```
3. **窗口必须自证**：一次启动必然伴随 `init plugins`。窗口内**没有**这行 ⇒ 判
   `TEST INVALID`，**不得**把"0 条 error"当成干净（`scripts/prod-log-audit.py` 已内置该闸，退出码非 0）。
4. **error 要按启动批次归类**：`init plugins` 开头 / `plugins loaded` 收尾算一个启动批次；
   批次内的 `APP_COMMANDING`（`{"status":503,"maintaining":true}`）是重启期自我保护，不是故障；
   只有批次**之外**的非 `APP_COMMANDING` error 才需要人工看。

---

## 发布检查清单（每次照抄）

- [ ] `ssh` 登录并核对 `hostname` + `/etc/machine-id`
- [ ] `docker inspect` 定位 dist（挂载点唯一定位，**不用 find**）
- [ ] 只读预检：迁移登记 / 目标列 / 唯一索引冲突 / 重复 ASSIGNED / 短信基线
- [ ] 整库 `pg_dump | gzip` + 校验非空
- [ ] `dist` 整目录 `cp -a` 备份
- [ ] 上传 `server/index.js` + `client/index.js` + `build-fingerprint.json`
- [ ] **上传 `dist/server/migrations/` 整目录**（铁律 1）
- [ ] 落盘后逐文件 sha256 复核（对不上立即回滚，未重启）
- [ ] 重启 → 轮询健康（**判据先验证过**，铁律 2）
- [ ] 核对 `migrations` 计数 + 触发器 + 唯一索引（**不看日志，看库**）
- [ ] Nginx 按块合并（铁律 3）
- [ ] 验收：健康 / 短链 302 / 畸形 404 / 匿名 401 / 无效码业务错误 / 短信零新增
- [ ] **日志审计** `python scripts/prod-log-audit.py`（窗口自证通过、运行期 0 条非维护态 error，铁律 5）
- [ ] 追加 `docs/PROD-DEPLOY-LOG.md`

---

## ★ R0. 生产只读预检结论（2026-11-11 · 只读，未做任何生产写入）

> **本轮约束**：生产 SSH 口令**不在本机**（`.env` 无 `S6_SSH_*`）⇒ 按"复用已有权威报告"原则，
> 预检数据源为 `docs/ARC-V1-A0.md`（**2026-11-09 生产库只读实测**，`SELECT`/`pg_catalog`，未写入）
> 与 `docs/PROD-DEPLOY-LOG.md`（2026-11-06 上线登记）、`docs/DEPLOY-P6-BACKUP-ACCEPTANCE.md`。
> **本节不重复已通过的测试**，只登记"若上线，必须在会上确认的事"。

### R0.1 生产基线（复用 A0，无需重测）

| 项 | 生产现网值 | 与 ARC-V1 的关系 |
|---|---|---|
| NocoBase | **2.2.15** | 与开发/隔离一致，无需升级 |
| 应用容器 | `scqf-as-app`（`Up (healthy)`） | S5 重启对象 |
| 数据库 | `scqf_aftersales_candidate` / 用户 `scqf_as` | ⚠️ **不是** `service_ticket` |
| 十家门店 | `1,4,8,9,10,11,12,13,14,15`（**不连续**，缺 2/3/5/6/7） | 所有脚本禁写 `for i in 1..10` |
| 账号 904 | `hl@scqfls.cn`，仅 `store_after_sales` | **本次不改**（绑定数见 C1） |
| 角色 | 原 7 个：`root`/`admin`/`member`/`hq_admin`/`hq_after_sales`/`viewer`/`store_after_sales`；**无 `store_sales`/`store_manager`** | 这两个角色由迁移 `202611091` 新建 |
| `mobileRoutes` / `rolesMobileRoutes` | 各 **0 行** | 与本次无关（我们用的是 `desktopRoutes`） |
| ARC 六张表 | A0 时**不存在**，由插件 `loadCollections()` 自动建 | 不靠迁移，**见 A3** |
| 迁移登记 | **41**（2026-11-06） | 本次增量 = `202611091-arc-v1-roles` |

### R0.2 三个必须人工确认的点（工具查不到，只有人能判）

| # | 事项 | 为什么工具不行 | 会上怎么确认 |
|---|---|---|---|
| **C1** | **`904` 绑定数存在两份冲突档案** | `docs/HL-ACCOUNT-BINDING-REPORT.md`（**2026-10-19**）记绑 `[4]`（S04 单店）；`docs/ARC-V1-A0.md`（**2026-11-09**）记绑**全部 10 家** | 按"A0 更新且明确标注生产现网"取 **A0 = 10 家**；但**上线前用 `svc:storeAccounts` 读一次现网值**再落笔（**只读，不改**） |
| **C2** | **`member` 在生产的路由授权范围未知** | A0 未测 `desktopRoutes`；开发库里 `member` 对**全部 39 条**路由都有授权（含 4 条孤儿） | S6-B 的 dry-run **只做只读盘点**；**不预设**"生产一定含 ARC" —— 若本就为 0 则直接跳过清理（见 S6-B 修正条：那是安全状态） |
| **C3** | **生产 `desktopRoutes` 已有历史页面** | A0 只测了 `mobileRoutes`（0 行），未测 `desktopRoutes`；`BE-03-S6-DEPLOY.md` 记生产有 `/admin/qke3hyq3v92` 等页面 | ARC 两条 UID（`n5c25yq5qlt`/`97x481j2bv1`）是随机 11 位 base36，撞号概率≈0；但重放脚本**按 `schemaUid` 回查复用** ⇒ 若真撞上会**静默串页**。**S6-A 必须核对本次新建路由 id 是本次新值；UID 已被占用且无法证明属于本次重放 ⇒ 停** |

### R0.3 备份 / 恢复演练 / watchdog 证据（G3，复用 P6 验收报告）

| 项 | 状态 | 证据 |
|---|---|---|
| root crontab 3 条（`02:40` 备份 / `04:30` 演练 / `09:00` watchdog） | ✅ 已登记 | `docs/DEPLOY-P6-BACKUP-ACCEPTANCE.md` §1 |
| 加密 | ✅ AES-256-CBC / PBKDF2 20 万次 | 同上 §3 |
| 隔离恢复演练 | ✅ **PASS**（10 表全等、孤儿未动） | 同上 §6 |
| SHA-256 校验 | ✅ 包级 + 610 媒体逐文件 | 同上 §5 |
| 保留策略 | ✅ 日 7 / 周 4 / 月 3 | 同上 §8 |
| **异地存储** | ❌ **PENDING** | 服务器无 COS 凭据 |
| **失败外发告警** | ⚠️ **PENDING**（本地可发现 PASS） | webhook 未授权 |

> ⚠️ **诚实说明**：三条 cron **尚未经历一次"自然触发"**（报告原文），
> 已完成的是"cron 等价执行环境实跑"。⇒ S1 仍必须**实连服务器确认最近一次备份新鲜**。

### R0.4 部署顺序（S0 → S7，S6 已拆为 A/B/C）

见上文 **★ 生产发布检查单 · 执行顺序**。**R0 不执行任何写入步骤**，只锁定顺序与判据。

**S6 三段的分工**：
- **S6-A 重放页面配置** ⇒ 判据 **17/17** + 等价性 15/15，**路由 id 动态映射**（禁止硬编码）；
- **S6-B 撤销 `member` 授权** ⇒ dry-run 基线自证 → `--apply` ⇒ 8/8（含双向对照）；
- **S6-C 授权面收敛** ⇒ 四业务角色可见 + `member` 不可见 + **写权限不扩大**。

### R0.5 发布策略分项（A/B/C/D）

| 项 | 能否上线 | 前置条件 | 依据 |
|---|---|---|---|
| **A. 员工端**（销售建档 / 暖通阶段 / 负责人及总部只读） | ✅ **条件具备** | S5 健康 + S6-A 重放 + S6-B/C 授权收敛 + S7 四角色渲染 9/9 | 隔离环境已 **17/17 · 15/15 · 9/9** 实测 |
| **B. 客户端**（客户查询入口） | ⛔ **暂不开** | **短信模板平台侧审核通过**（G1）。审核未过 ⇒ 验证码只能 mock，真实客户收不到码 | `SMS_REVIEW_PENDING_SCENES` 含 `archive_verify` |
| **C. 原图**（照片 EXIF/GPS 清理） | ✅ **可上线，但首次必须真机复验** | 部署后**用真实手机原图**上传一张，确认落盘无 EXIF/GPS。**失败即停新照片录入**并走预案 | G2；禁止用桌面文件代替真机 |
| **D. 回滚** | ✅ **首选 R1/R2**（纯授权面 + 关匿名入口），**不 DROP 表、不删档案/照片/审计** | 见 E 节回滚表 | `serviceArchives` 及 5 张关联表回滚时一律不删 |

**明确不做**（用户 A6 §三 裁决，逐条）：不改现有工单 ACL；不运行全量 seed；
不改生产账号 904 的绑定；不导入开发测试档案；不以 DROP 作为常规回滚手段。

---

# ARC-V1 专属章节（2026-11-11 · A6 上线前核查产出）

> 上面的通用铁律 0–5 与检查清单一律适用。本节的增量是 **ARC-V1 特有的三个"不连续"**：
> 门店 ID 不连续、路由必须父子一起授权、以及"回滚不能用 DROP"。
> **本节只写步骤，尚未执行任何生产写入。**

---

## ⚠️ A-1. 三条闸门**一律保留**，不因本次发布削弱（用户 A6 收口指令第 3 条）

这三条闸门是**发布的前置条件**，不是"可选项"。ARC-V1 发布**不得**修改它们。

| # | 闸门 | 机制（代码位置） | 当前口径 | 发布时的要求 |
|---|---|---|---|---|
| **G1** | **短信审核闸门** | `SMS_REVIEW_PENDING_SCENES` + `SMS_TEMPLATE_PENDING_REVIEW`（`src/server/constants.ts`） | `archive_verify` **登记在待审核清单**；审核前**只允许 mock**，真实通道落 `rejected + SMS_TEMPLATE_PENDING_REVIEW` | **不清空该清单**。短信宝平台侧审核通过前，档案查询验证码短信**不得真实发出** |
| **G2** | **手机原图验证闸门** | EXIF/GPS 剥离链（`services/photo-service.ts` + `media-format.ts`） | 源图含 `EXIF + GPS + Orientation` 的证据已有；**回传与落盘均无**（字节级） | **发布后必须用真实手机再传一次原图**，确认落盘无 EXIF/GPS。**不许用桌面文件代替真机** |
| **G3** | **生产备份闸门** | `backup.sh` / `restore-drill.sh` / `watchdog.sh`（root crontab 3 条） | 隔离恢复演练 **PASS**（10 表全等）；AES-256-CBC；日 7/周 4/月 3 | **发布前先确认最近一次备份新鲜**（`watchdog.sh` 无告警）+ **本次改动前再做一次整库 `pg_dump`**；**恢复演练未通过不得发布** |

**三条闸门的"不许削弱"逐条含义**：

- **G1**：`SMS_REVIEW_PENDING_SCENES` **语义保留**，即使将来审核通过也只清空数组、**不删机制**
  （源码注释明写："清空 ≠ 这个闸不存在"）。发布时**禁止**为了"让短信能发出去"而临时移除登记。
- **G2**：**"代码里有剥离逻辑"不等于"真机照片不会带 GPS"**。EXIF 剥离要实测，且
  **必须真机** —— 桌面端文件常常本来就没 GPS，用它会得到一条"通过"的假绿。
- **G3**：备份闸门的判据是**演练能恢复**，不是**文件存在**。
  ⚠️ 历史坑：`BACKUP_PASSPHRASE` 曾被记录为"零消费者"（PHASE-10-PREWORK RB-5）——
  现在的 P6 备份验收报告显示**加密与恢复演练均已实测 PASS**，但那依赖服务器上的
  `backup.sh` 系列脚本，**不在本仓库**。⇒ 发布前**必须实连服务器确认 cron 在跑**，
  不能凭"文档说做了"就认为闸门有效。

> 三条闸门与 A6 §三"不修改现有工单 ACL、不开放 FlowEngine 管理权限"是同一组约束：
> **本次只交付页面配置 + 源码，不动任何一条既有安全边界。**

---

## ★ 生产发布检查单（ARC-V1 · 一页版）

> 与上面"发布检查清单"配合使用：**通用清单管 dist/迁移/回滚，本单管 ARC-V1 增量**。
> **执行顺序不可调换**；任何一步的停止条件命中 ⇒ **立即停手并走 E 节回滚**。
>
> （编号 `★` 是刻意的：本手册后文已有 `A. 前置` / `A0` / `A2`–`A4` 等节，
> 用字母会撞号，**不要把本单误读成"另一个 A 节"**。）

### 执行顺序（`S0 → S7`）

| 步 | 动作 | 判据（做完了看什么） | 🛑 停止条件 |
|---|---|---|---|
| **S0** | **确认目标库是生产库**（不是开发库/隔离库） | `select current_database()`；生产业务量级对得上（不是 39/2481 这种开发库规模） | 库名/量级含糊 ⇒ **停**。脚本的 `S0` 只能自证，**不能替人认生产库** |
| **S1** | **备份闸门就绪**（G3） | 最近一次备份新鲜（`watchdog.sh` 无告警）；本次改动前**再做一次**整库 `pg_dump` + 校验非空 | 备份失败/为空/演练未通过 ⇒ **停** |
| **S2** | **只读预检** | 跑 `scripts/prod-db-precheck.sh`（迁移/索引/触发器/ASSIGNED/库规模/短信基线）+ **`scripts/prod-db-precheck-arc.sh`**（ARC 六表存在性 / 路由 UID 冲突 / `member` 授权范围 / 门店与 904 绑定 / 角色与迁移基线）。**两者都是纯 SELECT，零 DDL/DML** | 预检有不认识的行 ⇒ **停**（尤其：ARC 六表**上线前应全 false**；两条 UID **应 0 行**） |
| **S3** | **传源码**（逐文件清点，**禁止只用 `git add -u`**） | 按 `docs/ARC-V1-DELIVERY-FILES.md` 的**分类清单**逐项点数：`scripts/arc/` **11** 个（10 `.mjs` + 1 `.json`）；另含 3 个 R0-FREEZE 脚本（`arc-r0freeze-artifact-check.mjs` / `arc-r0freeze-files-check.mjs` / `arc-r0chg01-rate-limit-boundary.mjs`）+ `scripts/lib/arc-uid-ownership.mjs` + `scripts/verify-arc-uid-ownership-selftest.mjs`。**必须 `--untracked-files=all` 展开目录**（`git status --short` 默认把目录折叠成一行，会把 N 个文件数成 1 个） | 逐项点数对不上 ⇒ **停** |
| **S4** | **传 dist 三文件 + migrations 整目录 + H5 产物 + nginx** | 逐文件 `sha256` 与本地一致（本地值见 `docs/ARC-V1-DELIVERY-FILES.md` 第七节） | 有一个对不上 ⇒ **停**（尚未重启，此时回滚零成本） |
| **S5** | **重启 → 轮询健康** | `/api/app:getInfo` = 200（**判据先验证过**，铁律 2）；容器 `Up (healthy)`；`/api/svc/health` 200 | 超时/非 200 ⇒ **停**，走 R3 |
| **S6-A** | **重放 V2 页面配置**（A2，本次核心增量）<br>先 `--dry-run` 自证目标库，再去掉该参数 | `node scripts/arc/arc-v1-rebuild-mobile-page.mjs` ⇒ **17/17**（**必须用 root 会话**，`hq_admin` 会 403 假绿）；再跑 `arc-v1-compare-config.mjs` ⇒ **15/15**。**路由 id 必须动态映射**（禁止硬编码 `396888170692608`）。<br>🔴 **UID 判据（2026-11-11 修正）**：脚本按 `schemaUid` 回查复用，因此**必须核对本次新建路由的 id 是一个本次才出现的新值**（重放前后各取一次 `desktopRoutes` 全表 id 快照，对比差集）。<br>**若目标 UID 已被其它页面占用**：先判断它是否属于本次重放 —— 用 `arc-v1-compare-config.mjs` 比对**该路由挂载的 schema 内容**是否为 ARC 页面；**无法证明属于本次重放 ⇒ 停**。**绝不允许"回查到就复用"** —— 那会静默把 ARC 配置写进一个既有的、可能有真实业务数据的页面 | 任一判据红 / 路由 id 非本次新建 / **UID 已被占用且无法证明是本次重放** ⇒ **停**，走 R1（撤路由授权，不动数据） |
| **S6-B** | **撤销 `member` 对 ARC 两条路由的授权**（A5 最小权限修复）<br>先只读预演，确认后再 `--apply` | `node scripts/arc/arc-v1-fix-member-route-grant.mjs`（dry-run 只读）；`--apply` ⇒ **8/8**（含 `store_sales` 反向对照仍可见）。<br>🔴 **基线判据（2026-11-11 修正）**：**不再要求**"`member` 修复前必须可见 ARC"。若目标环境本就**没有** `member` 的 ARC 授权（= 已经是安全状态），**这是 GO 而非 NO-GO**。正确判据是**以重放完成后的授权实际状态为准**：<br>　① `member` 有 ARC 授权 ⇒ **定向清理**（删掉该角色的这两行），清理后必须为 **0**；<br>　② `member` 无 ARC 授权 ⇒ **跳过清理**（不要 `--apply`），但必须**留证**（记录当时 `rolesDesktopRoutes` 中 member × ARC 的行数 = 0）；<br>　③ 两种情况**最终都必须是 `member` × ARC = 0 行**。<br>反向对照（`store_sales` 仍可见）**在两种情况下都要跑** —— 它是"判据有区分力"的证据，与基线是否含 ARC 无关 | 两个业务角色都被清空（反向对照也失败，说明脚本在删错东西）⇒ **停**。**"基线不含 ARC"本身不是停止条件** |
| **S6-C** | **确认授权面收敛** | ① 四个**业务角色**（`store_sales`/`store_manager`/`hq_admin`/`hq_after_sales`）在 `listAccessible?layout=mobile-layout-model` 中**可见**且 `children` 非空；② `member` **不可见**；③ ARC 业务集合的**写权限未扩大**（四业务角色 `create/update/destroy` 仍按 A3 口径，不自愈出写权） | 任一业务角色不可见 / member 仍可见 / 写权限扩大 ⇒ **停**，走 R1 |
| **S7** | **真机验收 + 越权复验** | `arc-v1-verify-render-uat.mjs` ⇒ **9/9**（四角色渲染 + 越权 12 次全 403）；**真机再传一张原图**（G2）；**确认无真实短信发出**（G1）；门店隔离抽样（档案只在本店可见） | 越权未拦 / 短信真发了 / EXIF 残留 / 跨店可见 ⇒ **停**，走 R1/R2 |

> ⚠️ **S6 必须在 S5 之后、且在 S7 之前**：页面配置是**数据库态数据**（A0），
> 重启只加载代码，不会把页面配置带进来 —— **漏了 S6，S7 一定"页面 404"**。
> ⚠️ **S6 重放前先跑 `--dry-run`**（只做基线自证、不写入），确认目标是该被重放的那一个库。

### 停止条件汇总（命中任一即停）

1. **目标库认不准**（S0）：库名或量级无法确认是生产库。
2. **备份不新鲜 / 恢复演练未过**（S1、G3）。
3. **只读预检出现未知行**（S2）。
4. **交付数字对不上**（S3）：逐文件清点不符（**必须 `--untracked-files=all`**，否则目录被折叠成一行）。
5. **sha256 不一致**（S4）：此时**还没重启**，回滚成本最低。
6. **健康检查不过**（S5）。
7. **重放或等价性判据红**（S6-A）、**UID 冲突且无法证明属于本次重放**（S6-A 修正条）、**授权面未收敛**（S6-C）。
   ⚠️ **S6-B 的两种情况都不在停止条件里**：`member` 基线本来就不含 ARC ⇒ 跳过清理并留证即可（**安全状态，不是故障**）。停止条件是"S6-C 收敛检查失败"与"S6-A 的 UID 无法归属"。
8. **越权被放行 / 真实短信发出 / EXIF 残留 / 跨店可见**（S7、G1、G2）。

> **8 条里任何一条命中，都不许"再看一眼继续"** —— 本项目最贵的教训是
> "判据太宽 = 自造假绿"。停下来报清楚"是哪一步、看到什么、与期望差在哪"。

### 回滚（与 E 节一致，按侵入性从低到高）

| 级别 | 动作 | 什么时候用 |
|---|---|---|
| **R1** | 撤掉新菜单/路由授权（删 `rolesDesktopRoutes` 那两条） | S6/S7 出问题 —— **纯授权面，不碰业务表，不可能丢数据**（首选） |
| **R2** | 关掉客户匿名入口（`/h5/archive.html` 与 `publicArchive` ACL） | 客户侧出问题 |
| **R3** | 恢复上一版 `dist` 三文件 + 重启 | S5/S7 代码层问题（走铁律 1 的整目录备份 + 逐文件 sha256） |
| **R4** | 回滚迁移（**仅角色定义本身有问题时**） | 罕见；仍不动业务数据 |

**`serviceArchives` 及其 5 张关联表在回滚时一律不删** —— 档案是真实业务数据，
`drop table` 不是回滚，是数据事故。

---

## ⚠️ A0. 最重要的一条：**页面配置不是"文件交付"，是数据库态数据**（2026-11-11 隔离复现实测）

**先看结论**：V2 移动页（`档案移动测试`）的配置**不在源码、不在迁移、也不在官方蓝图里**。
它只存在于数据库的 **5 张表**中，而且**目前只存在于开发库这一台**。

| 表 | 开发库实测行数 | 内容 |
|---|---|---|
| `desktopRoutes` | **2** | 页面路由 `n5c25yq5qlt` + tabs 子路由 `97x481j2bv1` |
| `desktopRoutesUiLayouts` | **2** | 两条路由 → `mobile-layout-model` |
| `flowModels` | **26** | 页面根模型 1 + BlockGrid 1 + 导航/字段等 22 + **两个业务区块** 2 |
| `flowModelTreePath` | 119+ | 模型父子链（**权威链在这里，不在 `flowModels.options.parentId`**） |
| `rolesDesktopRoutes` | **12** | 6 角色 × 2 路由（含 NocoBase 自动给的 admin/member） |

> ⚠️ **不要去数 `flowModelTreePath` 的 distinct descendant（会得到 33）** ——
> 其中 **7 个是孤儿**（模型早删、树路径残留）。**真实模型数 = join 口径 = 26**。
> 把 33 当期望值 = 去追一批不存在的模型。

### 为什么"文件交付"这条路走不通（逐条实测，别重复试）

1. **仓库里没有建页面的迁移** —— `migrations/` 只有角色与权限（`202611091-arc-v1-roles.ts`），
   没有任何一处写入 `desktopRoutes` / `flowModels`。
2. **官方蓝图机制导不出自定义区块** —— `flowSurfaces:exportBlueprint` 严格策略报
   `400 cannot export block 'ArchiveCreateBlockModel' at $.tabs[0].blocks[0]: unsupported-node`；
   放宽成 `unsupported: 'warn'` 换一句 `400 cannot export a page without at least one supported tab`。
   ⇒ 官方导入导出**覆盖不到我们的页面**，这不是配置错，是能力边界。
   （入参契约：只接受 `{ target: {<恰好一个定位符>}, options: {} }`，
   定位符四选一 `uid`/`pageSchemaUid`/`tabSchemaUid`/`routeId`，不可并列。）
3. **`scripts/` 里的建页脚本是探针不是交付物** —— `arc-a5-v2-mobile-create.mjs` 只建路由，
   **不含两个业务区块**。

⇒ **结论：必须新增一步"页面配置重放"**，见下方 **A2**。这是本次补证暴露的**唯一实际缺口**。

### A2. 页面配置重放（新增步骤，用隔离环境的验证脚本）

脚本：`scripts/arc/arc-v1-rebuild-mobile-page.mjs`（**它既是最小复现，就是交付物本身**）。
隔离环境首次重建 **17/17 PASS**；**不清库重跑同样 17/17 PASS**（幂等）。
（🔴 **2026-11-11 R1-READY 修正**：上一轮记的 14/14 是在 `hq_admin` 会话下跑出来的**假绿** ——
`hq_admin` 不是超管，写路由/模型会 403。改用 **root 会话**后，S0–S1b 之外还多出
`R3/R3b/R1/R2/R4/R5/R6/R7/R8` 九项，故正确口径是 **17/17**，不是 14/14。）

**三条必须遵守的顺序/口径（都是踩过的坑，不是理论）**：

| # | 规矩 | 违反的后果（实测） |
|---|---|---|
| 1 | **先建路由，再写模型** | uid 命名空间**跨 `flowModels` 与 `desktopRoutes` 共用**。反了会报 `uid already exists`，而 `desktopRoutes` 明明是空的、也没有唯一索引 —— 极易误判成"NocoBase 坏了" |
| 2 | **父路由先建；子路由 `parentId` 必须重映射到新 id** | 生产库自增 id 与开发库不同，**绝不能硬编码 `396888170692609`** |
| 3 | **模型数按 join 口径 = 26** | 按 33 去重建会去追 7 个不存在的孤儿模型 |

**另外两条 NocoBase 行为（实测，非缺陷）**：
- `desktopRoutes:create` 会**自动**挂 `admin-layout-model` 给新路由。ARC 页是**移动页**，
  不该出现在桌面菜单里 ⇒ 必须**删掉自动生成的 admin 关联**，只留 `mobile-layout-model`。
  （该表主键是复合键 `(desktopRouteId, uiLayoutUid)`，**没有 id 列**，删除要用复合键 filter。）
- 建路由时会**自动**授予 `admin` + `member`。开发库那两条路由的授权因此是 **12 行 / 6 角色**
  （自动 2 + 手工 4），**不是 8 行**。判据要写"与开发库角色集合一致"。

**幂等写法**：`desktopRoutes:create` 命中已存在时按 `schemaUid` **回查复用**；
重复的 `rolesDesktopRoutes:create` 返回的是 **`<field> already exists`**
（文里**没有** `duplicate` / `unique` 这两个词，用它们做正则判重复会永远漏判）。

### A3. 哪些是"自动的"、哪些必须"交付"（隔离环境实测的分界）

隔离库是**全新初始化**的空库，实测结果一刀切开两类：

| 类别 | 机制 | 隔离库实测 | 需不需要交付 |
|---|---|---|---|
| **六张 ARC 业务表** | 插件 `loadCollections()` 扫目录自动建 | **6/6 已自动建好** | ❌ 不需要（**不靠迁移**） |
| **角色定义**（9 个，含四个业务角色） | 插件迁移 + 自愈 | **已建好** | ❌ 不需要 |
| **ACL 资源授权** | 插件 `afterLoad` 的 `repairRoleResources` 自愈 | `dataSourcesRolesResources` **33=33**、`...Actions` **99=99**，与开发库**逐字一致** | ❌ 不需要 |
| **ARC 只读口径** | 同上 | 四角色均 `view,list,get`，**无 create/update/delete** | ❌ 不需要（自动就对） |
| **页面配置**（5 张表） | **无任何载体** | **0 行** | ✅ **必须交付 —— 唯一缺口** |

> 这一条也顺带解释了"为什么越权拒绝是自动的"：**写接口拒绝对只读角色之所以成立，
> 靠的是插件自愈出来的 ACL，不是部署时手工配的**。换新库不用担心漏配 ACL。

### A4. 业务账号必须**对齐开发库口径**（否则真机验收会假红）

用 `users:create` 建的账号会**自动带 `member` 角色**，而开发库这 15 个业务账号
**每个都恰好 1 个角色**。带着 `member` 的后果不是"多一个角色"这么轻：

- 浏览器会话会选中 `member`（`roles:check` 返回 `role=member`、`strategy.actions=["view:own"]`）；
- 业务集合一律 **403** ⇒ **页面能打开，但正文显示"列表加载失败 No permissions"**；
- 真机验收极易被误读成"权限没配好"。

⇒ 建号后**必须移除多余的 `member`**。删除 `rolesUsers` 同样要用**复合键 `(roleName, userId)`**
（该表**没有 id 列**，用 `filterByTk=<id>` 会报 `Invalid SQL column or table reference`）。

> 另外：`store_users` 的两个字段是 **belongsTo 关系**，API 名是**关系名 `user` / `store`**
> （`foreignKey` 才是 `user_id`/`store_id`）。传 `{userId, storeId}` **不报错但会静默写成 NULL**，
> 于是门店角色的数据范围过滤命中 0 行 ⇒ 又是 403。**必须回读校验非空。**

### A5. `member` 的**自动路由授权**：可见性越界，建议发布时剔除（2026-11-11 实测）

**背景**：`desktopRoutes:create` 会自动授予 `admin` + `member`（见 A2）。
开发库里 `member` 对**全部 39 条路由都有授权**（43 行 = 39 + 4 条指向已删路由的孤儿行），
`allowNewMenu` / `allowNewMobileMenu` 均为 `t` ⇒ **每建一个新页面，member 都会自动拿到它**。

**实测 member 的真实边界**（拿 root token + `X-Role: member`，等价于"只有 member 的新用户"）：

| 观测项 | 结果 | 解读 |
|---|---|---|
| `roles:check` | `role=member`、`strategy={"actions":["view:own"]}` | member 只有"看自己的" |
| `serviceArchives` / `serviceArchiveStages` / `serviceArchivePhotos` 的 `list/create/update/destroy` | **全 403** | **业务数据没越界**（这是好的一面） |
| `desktopRoutes:list` | **403** | 列表读不到 |
| `desktopRoutes:listAccessible?layout=mobile-layout-model` | **200，含 ARC 页** | ⚠️ **但页面可见性给了** |
| 浏览器打开 `/v/mobile/n5c25yq5qlt` | **渲染出页面标题**，正文 `列表加载失败 No permissions` | ⚠️ 页面能开、标题在、正文空 |
| `flowModels:findOne?filterByTk=<uid>` | **200** | ⚠️ 能逐个读页面配置（`list` 是 403，`findOne` 却是 200） |

**结论**：
1. **不符合最小权限要求**。member 对 ARC 页**既不读数据、也不该看到页面**，但**能打开页面**。
   现象形态就是 **DEV-222**（"能开、标题在、正文全空、无红请求"）——验收时极易被误判成"权限配好了"。
2. **越界仅限"可见性 + 页面配置结构"，不含业务数据**。写接口对 member 一律 403，
   档案数据没有泄露。**所以这是 B 类问题，不是 P0**，但**发布时应当剔除**。

**最小修复（已实测有效且可持续）**：删掉 member 对 ARC 两条路由的授权行。四条判据全绿：

| 判据 | 结果 |
|---|---|
| 修复前基线（member 在 mobile 布局下**含** ARC） | `true` ⇒ **判据有区分力**（不是恒 0 的假判据） |
| 修复后（`rolesDesktopRoutes:destroy` 官方接口，复合键 filter） | 授权行 **2 → 0** |
| 修复后 member 在 mobile 布局下**含** ARC | `false` ⇒ **修复有效** |
| 重启容器后 member 授权行数 | **仍为 0** ⇒ **未被自愈加回，修复可持续** |

> 🔴 **2026-11-11 修正（R0-CHG-01 §六）**：上表第 1 行是**开发库**的实测基线，
> 它证明的是"这条判据在开发库有区分力"，**不是**"生产发布时必须复现这个基线"。
> 在生产上如果 `member` 本来就**没有** ARC 授权，那是**更安全的目标状态**，
> 属于 **GO**，不是 NO-GO。发布时的判据改为：
>
> | 场景 | 动作 | 通过条件 |
> |---|---|---|
> | 重放后 `member` **有** ARC 授权 | 定向清理（删这两行） | 清理后 **0 行** |
> | 重放后 `member` **无** ARC 授权 | **不执行 `--apply`**，只留证 | 记录当时行数 = **0** |
> | 反向对照（`store_sales` 在 mobile 布局可见 ARC） | **两种场景都跑** | **可见** |
>
> 也就是说：**最终必须 = 0**，但"起点就是 0"与"清理到 0"同样合格。
> 之所以要写清楚，是因为旧判据会让一个**已经安全的环境被判成 NO-GO**，
> 从而促使操作者去"制造一个需要清理的基线"—— 那是把发布流程逼向更危险的方向。

> 为什么"可持续"有静态依据：`grep -rn rolesDesktopRoutes nocobase/plugins/service-ticket/src/`
> **零命中** —— 插件的自愈（`repairRoleResources`）只重写 `dataSourcesRolesResources`（资源级 ACL），
> **完全不碰路由授权表**。所以删掉就是删掉，不会被下次启动加回来。
>
> ⚠️ **判据陷阱（本轮自己踩了）**：`desktopRoutes:listAccessible` **不带 `layout` 参数时默认查桌面布局**，
> 而 ARC 页只挂 `mobile-layout-model` ⇒ **不带参数恒返回 0**，修复前后都是 0、**毫无区分力**。
> 必须写 `?layout=mobile-layout-model`。这正是"断言不会变红 = 没有断言"的又一实例。

**发布动作**（并入 S6 之后）：
```bash
# 1) 重放页面配置后，查 ARC 两条路由的 id
# 2) 删掉 member 的授权（复合键 filter，官方接口）
POST /api/rolesDesktopRoutes:destroy?filter={"roleName":"member","desktopRouteId":<id>}
# 3) 复验：member 的 listAccessible?layout=mobile-layout-model 不应再含该 schemaUid
# 4) 确认 admin 的授权**保留**（超管需要能进配置）
```
> **只删 member，不删 admin** —— `admin` 进配置区是正常需要。
> `hq_admin` / `hq_after_sales` / `store_manager` / `store_sales` 的授权是**有意授予的业务角色**，
> **一个字都不要动**（这正是 S7 要验的四角色渲染）。


## A. 前置：先把"要传什么"变成清单（不是"看看 git status"）

ARC-V1 的源码**大量处于未跟踪状态**（清单见 `docs/ARC-V1-DELIVERY-FILES.md`，**36 项**）。
⇒ **`git add -u` 只会带上已跟踪文件的修改，这 36 个新文件一个都不会进去。**
⇒ 换机器 clone 出来的产物**会缺 ARC-V1 整个模块**，而本地构建却完全正常。

**规矩**：
1. 交付前按清单**显式列名**核对，别依赖 `git add -u`。
2. 三条自证判据（缺一条就停）：
   - `git status --porcelain --untracked-files=all | grep '^?? nocobase/plugins/service-ticket/src/'` 应列出 **36 条**、
     **且无目录折叠行**（不带 `--untracked-files=all` 会折叠成 `?? src/client-v2/` 这类目录行，数出来是 35）；
   - `git ls-files nocobase/plugins/service-ticket/src | grep -cE '\.tsx?$'` == **172**（跟踪的构建源文件）；
   - 构建报告"源文件数"== **208**（172 + 36），且与上一条一致。
3. `h5/public/archive.html` 与 `h5/public/archive-render.js` **必须单独确认** ——
   它们不在插件目录里，最容易被"我只传了插件"漏掉（上一版清单就漏了这两条）。

## B. 迁移（沿用铁律 1，ARC-V1 的增量）

ARC-V1 的迁移是 **`202611091-arc-v1-roles.ts`**（角色与权限）。要点：

1. 迁移**必须整目录上传** `dist/server/migrations/`（铁律 1）。
2. **十家门店 ID 不连续** —— 迁移与验收脚本**不得假设 `1..10`**。
   正确做法：门店 ID 从库里查（`select id, code from stores order by id`），
   或按 `code` 匹配。任何写死 `for i in 1..10` 的脚本都要先改掉。
3. 目标库的**既有门店**必须先核对数量与 code 集合；若生产门店集合与开发不一致，
   **停**，不要"按开发的口径发下去"。
4. 落 `store_sales` / `store_manager` 的**创建与授权必须幂等**：
   - 建角色：先查 `roles` 有无同名，有则复用，不重复建；
   - 授权用官方接口（`rolesDesktopRoutes:create`）并容忍"已存在"（唯一键冲突视为成功）。
   ⇒ 目标：**同一条命令跑两遍，结果与跑一遍相同**，且第二遍不报错。

## C. 路由授权：父子必须一起给（DEV-222 的教训）

V2 移动页的正文能否渲染，取决于路由树里**页面路由**与它的 **tabs 子路由**是否都存在：

| 必须同时授权的两条 | 开发库 id（**仅供识别，禁止照抄**） | 说明 |
|---|---|---|
| 页面路由 | `396888170692608` | `schemaUid=n5c25yq5qlt`，`/v/mobile/n5c25yq5qlt` 的根 |
| **其 tabs 子路由** | `396888170692609` | `schemaUid=97x481j2bv1`，**缺它则正文空白** |

**只授父不授子 = 页面能开、标题与菜单在、正文全空**，而且**不报错、没有红请求**。
这是最容易"看起来部署成功了"的坑。

> 🔴 **上面两个 id 在生产一定不同** —— `desktopRoutes.id` 是数据库自增。
> 隔离环境实测：重建后拿到的是 `397108135198720` / `397108135198721`。
> **所有脚本必须按 `schemaUid` 查 id**（`select id from "desktopRoutes" where "schemaUid"='…'`），
> **任何硬编码 396888170692608 的脚本在生产都会静默作用到错的路由或什么都不做。**

**授权后必须验证的是**：`desktopRoutes:listAccessible?layout=mobile-layout-model` 里，
目标角色的页面路由 `children` **非空**。只看"接口 200"不够，要看 `children` 数组。

## D. 明确不做的事（用户 A6 §三 裁决，逐条）

1. **不运行覆盖原售后页面的全量 seed**。ARC-V1 是**新增**页面，不是替换。
2. **不改现有工单 ACL**。ARC-V1 的角色/资源与工单那套互不干扰。
3. **不导入开发测试档案**。开发库里 `arc1.*` 账号造的 200+ 条测试档案**不进生产**。
4. **不改生产账号 904 的十店绑定**。它是运维账号，动它会连带影响其它模块。
5. **生产数据不允许被 DROP 作为常规回滚手段**。

## E. 回滚：停用，不删数据

ARC-V1 的回滚**不是**"把表删掉"，而是"把入口关掉"。按侵入性从低到高：

| 级别 | 动作 | 影响面 | 数据 |
|---|---|---|---|
| R1 | **撤掉新菜单/路由授权**（删除 `rolesDesktopRoutes` 里那两条） | 员工看不到 ARC 页面，其它一切正常 | 全保留 |
| R2 | **关掉客户匿名入口**（`/h5/archive.html` 与 `publicArchive` 的 ACL） | 客户查不到档案 | 全保留 |
| R3 | **停用新功能**（恢复上一版 `dist` 三个文件 + 重启） | 回到上一版行为 | 全保留 |
| R4 | 回滚迁移（**仅在角色定义本身有问题时**） | 角色表 | 仍不动业务数据 |

**判据**：
- R1/R2 是**纯授权面**操作，**不触碰任何业务表** —— 这是首选，因为它**不可能丢数据**。
- 只有 R3 需要动 `dist`（此时走铁律 1 的"整目录备份 + 逐文件 sha256"）。
- **`serviceArchives` 及其 5 张关联表在回滚时一律不删**：
  档案是真实业务数据，`drop table` 不是回滚，是数据事故。

## F. 本次新增的两个必测项（A6 发现，必须进发布检查清单）

- [ ] **幂等回放真的能重放**：同一 `X-Request-Id` 连打两次，第 2 次必须 **200 + `x-idempotent-replay: 1`**，
      且返回**同一条档案**（id 相同）。
      ⇒ DEV-223：此处曾有 P0（TDZ 导致回放恒 500），**上线前必须实测**，不能只看代码。
- [ ] **档案列表分页能翻到第 51 条**：负责人本店 >50 条时，界面必须能取到后续记录。
      ⇒ DEV-224：原先写死 `page: 1`，第 51 条起永远看不到。
      验证要**比 id 集合**（两页交集为空）并**观测真实网络请求**（`page=2` 真的发出）。
- [ ] **总部角色的分页要单独验一遍**：总部走的是另一条分支（`isHqViewer` ⇒ 无 `store_id` 过滤 ⇒ 全库量级）。
      ⇒ DEV-226：上一版只验了负责人，**"共用同一个组件"被误当成"同一份验证"**。
      验证时先自证"观测的确实是总部视图"（标题含「全部门店」、总数 == 全库），
      再逐页快照取并集；**快照页数必须等于总页数**，否则属脚本漏采、不给产品结论。

## G. 隔离环境复现结果（2026-11-11 实测，回答"能不能重建"）

环境：`docker-compose.uat.yml` → 容器 `svc-app-uat`、库 `service_ticket_verify`、
独立存储 `storage-uat`、端口 `13001`。**与开发实例完全分离**（开发库 `desktopRoutes=39`，隔离库起点 0）。

| 脚本 | 判据 | 结果 |
|---|---|---|
| `scripts/arc/arc-v1-rebuild-mobile-page.mjs` | S0/S1/S2/S3-R/S1b + D1–D3 + R1–R8 | **17/17 PASS**（空库首次重建，root 会话） |
| 同上，**不清库重跑** | 幂等（`R3b=reuse`） | **17/17 PASS** |
| `scripts/arc/arc-v1-rebuild-accounts.mjs` | 四账号建号/绑角色/绑门店 | **5/5 PASS** |
| `scripts/arc/arc-v1-compare-config.mjs` | 隔离库 vs 开发库**逐字段等价**（含 2 条反向对照） | **15/15 PASS** |
| `scripts/arc/arc-v1-verify-render-uat.mjs` | 浏览器真机渲染 + 越权 | **9/9 PASS** |

**等价性对照证明的等价点**（`arc-v1-compare-config.mjs`，比**集合**不比顺序）：
路由的 `(uid|type|title|icon|enableTabs|hidden)`、布局归属（均"只挂 mobile"）、
模型集合 `(uid|use)` **各 26 个**、两个业务区块各 1 个、授权角色集合（6 个）、
ARC 资源授权（12 行，角色:资源:动作集合逐字一致，且**均无 create/update/delete**）。

**变异测试（证明断言真会红，不是假绿）**：
- 删掉 `store_sales` 的 2 条授权 → `E7`/`E8` **变红**（13/15）。
- 删掉建档区块模型 `c2d0e320f4c` → `E4`/`E5` **变红**（10/15）。

### G2. 本轮**新增的交付文件**（必须随 ARC-V1 一起传，`.tmp-verify/` 已被 gitignore）

```
scripts/arc/arc-v1-rebuild-mobile-page.mjs              # 页面配置重放（A2 的唯一载体）
scripts/arc/arc-v1-page-payload.json                    # 页面配置载荷快照（24 KB，可离线核对）
scripts/arc/arc-v1-rebuild-accounts.mjs                 # 目标环境业务账号就位
scripts/arc/arc-v1-compare-config.mjs                   # 重建后 vs 开发库 等价性自检
scripts/arc/arc-v1-verify-render-uat.mjs                # 真机渲染 + 越权复验
scripts/arc/arc-v1-fix-member-route-grant.mjs           # 最小权限修复（默认 dry-run，见 A5）
scripts/arc/arc-v1-check-member-route-scope.mjs         # member 能力边界取证（只读）
scripts/arc/arc-v1-verify-member-page-visibility.mjs    # member 真机页面可见性（浏览器实测）
```

**用法（口令只走环境变量，脚本刻意不读凭据文件）**：

```bash
# 目标环境 root（arc-v1-rebuild-mobile-page.mjs 必须用 root，hq_admin 会 403 假绿）
export UAT_ROOT_EMAIL=... UAT_ROOT_PASSWORD=...
# 业务账号口令（2026-11-11 起**必填**，见 DEV-229：脚本不再内置任何默认口令）
export ARC_ACCOUNT_PASSWORD=...    # 供 rebuild-accounts / verify-render-uat / verify-member-page-visibility
export ARC_SALES_PASSWORD=...      # 供 fix-member-route-grant 的反向对照（需真实持有 store_sales 的账号）
export SVC_UAT_BASE=http://127.0.0.1:13001           # 可选，默认即隔离实例

node scripts/arc/arc-v1-rebuild-mobile-page.mjs      # ① 重放页面配置 → 期望 17/17（root 会话！）
node scripts/arc/arc-v1-rebuild-accounts.mjs         # ② 账号就位     → 期望 5/5
node scripts/arc/arc-v1-compare-config.mjs           # ③ 等价性自检   → 期望 15/15
node scripts/arc/arc-v1-verify-render-uat.mjs        # ④ 真机复验     → 期望 9/9

# ⑤ 最小权限修复（A5）：先只读预演，确认后再 --apply
node scripts/arc/arc-v1-fix-member-route-grant.mjs            # dry-run（只读）
node scripts/arc/arc-v1-fix-member-route-grant.mjs --apply    # 期望 8/8（含双向对照）
```

> 🔴 **缺 `ARC_ACCOUNT_PASSWORD` / `ARC_SALES_PASSWORD` 会直接抛错退出**，这是**刻意的**（DEV-229）。
> 旧版这两个口令是写死在脚本里的，缺环境变量时**静默回落到仓库中的常量** ——
> 那种"照样能跑"正是口令外泄最难被发现的原因。**不要为了"跑起来"把口令写回脚本。**

> ⚠️ **重放前请先确认目标库是"该被重放的那一个"**：脚本自带 `S0` 判据
> （比对 `current_database` 与开发库规模），但它**不能代替人工确认生产库**。
> 生产执行前必须先跑 `--dry-run`（只做基线自证、不写入）。

**真机渲染证据**（截图按字节数 + sha256 落盘，四种状态各自独立、旧图不复用）：
- 销售：页标题 + 列表区 + **完整建档表单**（档案类型/客户姓名/手机号/服务地址/服务类型…）；
- 负责人：`本店服务档案（只读）` + 「当前账号为只读（无建档权限）」；
- 总部管理员 / 总部售后：`服务档案（全部门店）` + 只读提示；
- 反向对照：不存在的页面 → `404` 且无本页标题（证明判据有区分力）。

**越权验证**：`serviceArchives:create|update|destroy` × 4 角色 = **12 次全部 403**；
同一批角色 `list` **全部 200**（证明 403 来自写权限，不是账号整体不可用）。

---

# ★★ R1-READY 最终发布状态（2026-11-11 · B3 补齐后冻结）

> **本轮结论**：上一轮唯一未闭合项 **B3（隔离环境完整重放）已 PASS**，`R0-FREEZE` 的
> 三项核对 + 本轮 B3 全部达标。发布包**保持冻结**，等**生产发布单独授权**。
> 本节是**发布前最后一页**：只列"执行条件 / 停止条件 / 回滚条件 / 生产现场必确认"。

## R1.1 B3 实测结果（隔离库 `service_ticket_verify`，root 会话）

| 用户 §1 要求 | 判据 | 实测 |
|---|---|---|
| ① 首次重放建立完整 ARC 页面与模型 | 先重置到 `0/0/0` 基线再重放 | ✅ **17/17**（2 路由 / 26 模型 / 12 授权行） |
| ② 不清库重跑幂等 | 路由 id 不变、计数不变 | ✅ **17/17**；`R3b=reuse`、授权 `12→12` |
| ③ 已占用 UID 必须提供真实归属证据；证据缺失拒绝复用 | 篡改集合绑定后必须**停止** | ✅ 报「归属证据不足（缺 collection）… ⇒ 停」，**零写入** |
| ④ 两条路由 / 26 模型 / 四业务角色权限正确 | 逐条核对 + 与开发库 uid 集合比对 | ✅ **11/11**（C1–C8） |
| ⑤ `member` 对 ARC 路由最终授权数为 0 | 清理后行数 = 0，且 `store_sales` 仍可见 | ✅ **8/8**；`member×ARC=0`、反向对照通过 |
| ⑥ 不覆盖现有其他业务页面 | 开发库规模不变 | ✅ 开发库 `39 路由 / 2481 模型`、ARC id 原值未变 |

**第三次重放（R1-READY 收口）**：在 S6-B 已剔除 `member` 的状态下再跑一次重放，首次出现 `15/17`（R5/R6 红）。**判据缺陷，非产品故障** —— R5/R6 写死「12 行 / 6 角色（含 member）」，而 S6-B 之后正确目标态是「10 行 / 5 角色」。把这个假红当故障，会诱使操作者**补回 member 让判据变绿**，把发布推向更危险的方向。
已修：R5/R6 接受两种合法态（12 行含 member＝S6-A 刚跑完 / 10 行不含 member＝S6-B 已执行），硬条件仍保持「4 个业务角色全在 + 每角色恰好 2 行（父子成对）」。重跑结果 **17/17 PASS**（`R3b=reuse`、授权 `10→10`、member 未被加回）。
收口后库内实测：`member×ARC=0`；隔离库 `routes=2 / models=26 / treepath=119`；开发库 `39 路由 / 2481 模型`、ARC id 仍为 `396888170692608/396888170692609`（未漂移）。

**另补一条端到端证据**：`arc-v1-verify-render-uat.mjs` ⇒ **9/9**（真实浏览器，非 fixture）——
四角色都能打开页面且文案符合角色（销售有建档入口、其余仅只读），越权 12 次全 403。

**B1 反向验证（§1.3 的核心）怎么做的**：把 tabs 子树里一个叶子 FormItem 的
`collectionName` 从 `serviceArchives` 改成 `serviceVisits`。此时**结构指纹仍是 ARC 正例**
（`24 行/grid=1/create=1/edit=1`），**只有"实际集合绑定"这条条件能识破它** ⇒ 脚本停止。
改完**已还原**：9 行规范化后**逐字节一致**、`serviceVisits` 残留 = **0**。

## R1.2 S0–S7 执行条件（一页速查）

> 完整判据见上文「★ 生产发布检查单」。此处只列**执行条件**与**一票否决条件**。

| 步 | 执行条件（满足才做） | 一票否决（命中即停） |
|---|---|---|
| **S0** | 能读到生产库 `current_database()`，且业务量级**不是**开发/隔离库规模 | 库名或量级认不准 |
| **S1** | 最近一次备份新鲜 + **本次改动前再做一次整库 `pg_dump`** 并校验非空 | 备份失败 / 为空 / 恢复演练未过 |
| **S2** | `prod-db-precheck.sh` + `prod-db-precheck-arc.sh` 均**纯 SELECT 跑通** | 预检出现不认识的行（ARC 六表上线前应全 false、两条 UID 应 0 行） |
| **S3** | 按 `docs/ARC-V1-DELIVERY-FILES.md` **逐文件**清点（**禁止只用 `git add -u`**） | 交付数字对不上 |
| **S4** | 按 `.tmp-verify/evidence/r0freeze/sha256-manifest.json` 的 `manifest[]` 对 4 个 dist 产物**逐条 `sha256sum`**；再核 migrations 整目录 + H5 产物 + nginx。🔴 **发布前不要再跑 `arc-r0freeze-artifact-check.mjs`**（它会重建并覆盖 dist，见 DEV-231）；若必须跑，跑完须重新逐条回验，不一致即停 | **有一个对不上**（此时未重启，回滚零成本） |
| **S5** | `/api/app:getInfo`=200 + 容器 `Up (healthy)` + `/api/svc/health`=200 | 超时 / 非 200 |
| **S6-A** | `arc-v1-rebuild-mobile-page.mjs` **先 `--dry-run`** 自证目标库 ⇒ 再去掉参数 ⇒ **17/17**；路由 id 必须是**本次新值** | 判据红 / 路由 id 非本次新建 / **UID 已被占用且无法证明属于本次重放** |
| **S6-B** | `arc-v1-fix-member-route-grant.mjs` 先 dry-run：① 有 member 授权 ⇒ `--apply` 清理到 0；② 无 ⇒ **跳过并留证** | 两个业务角色都被清空（说明删错东西）。**"基线不含 ARC"本身不是停止条件** |
| **S6-C** | 四业务角色 `listAccessible?layout=mobile-layout-model` 可见；`member` 不可见；写权限未扩大 | 任一业务角色不可见 / member 仍可见 / 写权限扩大 |
| **S7** | `arc-v1-verify-render-uat.mjs` **9/9** + 真机传一张**真实手机原图** + 确认**无真实短信** + 门店隔离抽样 | 越权未拦 / 真发短信 / EXIF 残留 / 跨店可见 |

⚠️ **顺序不可调换**：`S6` 必须在 `S5` 之后（页面配置是**数据库态数据**，重启不会带进来）、
且在 `S7` 之前。漏了 `S6` ⇒ `S7` 一定"页面 404"。

## R1.3 回滚条件（按侵入性从低到高）

| 级别 | 触发时机 | 动作 | 数据风险 |
|---|---|---|---|
| **R1**（首选） | S6/S7 出问题 | 删 `rolesDesktopRoutes` 中 ARC 两条路由的授权 | **无**（纯授权面，不碰业务表） |
| **R2** | 客户侧出问题 | 关掉 `/h5/archive.html` 与 `publicArchive` ACL | 无 |
| **R3** | S5/S7 代码层问题 | 恢复上一版 dist 三文件 + 重启（走铁律 1 整目录备份 + 逐文件 sha256） | 无 |
| **R4** | **仅角色定义本身有问题时** | 回滚迁移 `202611091` | 罕见；不动业务数据 |

🔴 **`serviceArchives` 及 5 张关联表在回滚时一律不删** —— 档案是真实业务数据，
`drop table` 不是回滚，是数据事故。

## R1.4 生产现场仍须逐项确认（工具查不到，只有人能判）

| # | 事项 | 怎么确认 |
|---|---|---|
| 1 | **真实数据库与门店 ID、账号 904 绑定** | 连生产库读 `current_database()`；用 `svc:storeAccounts` **只读**读 904 绑定的门店清单（A0 记 10 家，旧报告记 1 家 ⇒ **以现网值落笔**） |
| 2 | **最新有效备份与恢复条件** | 实连服务器确认最近一次 `pg_dump` 新鲜；确认恢复演练步骤与责任人；异地存储/告警仍 PENDING |
| 3 | **ARC 表及路由 UID 冲突** | `prod-db-precheck-arc.sh` 查 ARC 六表存在性与两条 UID（`n5c25yq5qlt`/`97x481j2bv1`）是否已被占用；**被占用且无法证明归属 ⇒ 停** |
| 4 | **`member` 最小权限** | S6-B dry-run 只看只读盘点，不预设生产含 ARC；终态必须是 `member×ARC=0` |
| 5 | **真机原图 EXIF/GPS 清理** | 部署后**用真实手机原图**上传一张，确认落盘无 EXIF/GPS（禁止用桌面文件代替） |
| 6 | **客户手机号匿名摘要查询保持每 60 秒最多 3 次** | 上线后实打 4 次：前 3 次 200、第 4 次 429；**不开放敏感详情或照片**（响应只含摘要字段） |
| 7 | **`archive_verify` 真实短信继续关闭** | 确认 `SMS_REVIEW_PENDING_SCENES` 仍含 `archive_verify`；验证码只能 mock |

> **发布纪律**：本节写完后**不再改代码、不再加功能**。
> 生产发布须**单独授权**；在授权到达前，**不部署生产、不写生产、不发真实短信、不清库、不 commit/push**。

## R1.5 R1-READY 收口补证（2026-11-12）

### 冻结清单：实物已逐文件匹配

| 产物 | 冻结 SHA256 | 实物核对 |
|---|---|---|
| `dist/server/index.js` | `7df7cef52e339a0f…` | ✅ MATCH（1777305 B） |
| `dist/client/index.js` | `c381d28468fbfaf1d…` | ✅ MATCH（536445 B） |
| `dist/client-v2/index.js` | `5afddb5f9039e7b14…` | ✅ MATCH（221334 B） |
| `dist/build-fingerprint.json` | `de09e6f4383c676c…` | ✅ MATCH（24419 B） |

**4/4 MATCH**；migrations 24 条 `.js`，末条 `202611091-arc-v1-roles.js`。上表即生产上传的**唯一依据**，清单文件内 `frozenFinal` 段为权威说明。

### DEV-231：核对脚本会改坏冻结对象（已处置）

`arc-r0freeze-artifact-check.mjs` 原设计「备份 dist → 就地重建 → 比对」，并把重建后哈希写进清单 ⇒ **一次"只读核对"同时改掉实物和清单**，脚本仍报通过。已修为「比对后立即回滚 + 逐文件回验 + 失败 exit 1」，并以 `FREEZE_KEEP_REBUILT=1` 做双向验证（默认保冻结值 / 显式开关确实变哈希），证明判据不是恒真。

收口过程中因该开关的反向验证，**一度把最初的冻结字节副本覆盖**；已用「构建时间戳回填 + 冻结哈希自证」精确还原（三个文件各仅 1 处时间戳，回填后哈希分别命中冻结值，反证无内容漂移）。完整复盘见 `docs/DEVIATIONS.md` DEV-231。

### 本轮对交付包内文件的改动（如实登记，供授权时裁决）

| 文件 | 性质 | 说明 |
|---|---|---|
| `scripts/arc/arc-v1-rebuild-mobile-page.mjs` | 判据修正 | R5/R6 由单态改双态；不改产品行为，重放 17/17 |
| `scripts/arc/arc-r0freeze-artifact-check.mjs` | 验证工具缺陷修复 | 增加回滚，防止再改坏冻结对象（DEV-231） |
| `.tmp-verify/evidence/r0freeze/sha256-manifest.json` | 清单修正 | `manifest[]` 改回冻结四值 + `frozenFinal` 权威说明 |
| `docs/DEVIATIONS.md` / 本文件 | 文档 | DEV-231 复盘 + 本节状态 |

**以上改动均不涉及 4 个 dist 产物的字节**（已 4/4 回验）。若授权方要求「交付清单内脚本一律不动」，可将前两个脚本回退，但**必须同时接受 DEV-231 的操作限制**：发布前不跑该核对脚本。

### 仍存的非阻塞遗留

- **DEV-229**：9 个历史 `arc-*.mjs` 仍含隔离环境明文口令，**不在交付清单内**，已登记、未擅自修改；建议发布前统一处置或确认不上传。
- 两个交付脚本的口令已改为只读环境变量（`ARC_ACCOUNT_PASSWORD` / `ARC_SALES_PASSWORD`），缺失即抛错；运行前须显式注入。

> **结论**：B3 **PASS**，无阻塞项；满足**申请**生产部署授权的条件。授权到达前，仍**不部署、不写生产、不发真实短信、不清库、不 commit/push**；R1.4 的 7 项须在生产现场由人逐项确认。

## R1.6 PROD-PRECHECK 生产现场只读预检（2026-11-12）

> **授权范围**：生产发布审批 + 只读预检准备；**未授权 S3–S7**。
> 本轮全部为 `SELECT` / `pg_catalog` / 只读 `ls|grep|cat`；SQL 经 psql stdin 传入，
> **生产零落盘**。未备份、未重启、未重放、未改权限、未改绑定、未开放客户入口。

### S0 目标库自证 ✅

| 项 | 现网实测 |
|---|---|
| 库 / 用户 | `scqf_aftersales_candidate` / `scqf_as`（**不是** `service_ticket`） |
| 量级 | 工单 **526** / 回访 **300** / 门店 **10** / 用户 13 / 库 47 MB |
| 判定 | 与开发库 39 路由 / 2481 模型规模明显不同，目标库认得准 |

### S2 只读预检 ✅（11/11 精确判据全通过，无未知占用）

| 项 | 期望 | 实测 |
|---|---|---|
| ARC 六表已存在数 | 0 | **0** |
| 两条 `schemaUid` 占用 | 0 | **0** |
| `flowModels` 26 个 uid 占用 | 0 | **0** |
| 启用门店数 | 10 | **10**（id `1,4,8,9,10,11,12,13,14,15`） |
| 账号 904 绑定 | 以现网为准 | **10 家 = 全部启用门店**；角色仅 `store_after_sales`，**不含 member** |
| `member × ARC` 授权 | 0 | **0**（但 `member` 共有 38 条路由授权，且 `allowNewMobileMenu=true`） |
| 现有角色 | 7 个、无新增两角色 | **7**：root/admin/member/hq_admin/hq_after_sales/viewer/store_after_sales |
| 迁移登记 | 41 / arc-v1 未登记 | **41 / 0** |
| `archive_verify` 短信 | 0 | **0**；待发队列 `send_status=pending` **0** |

🔴 **C1 冲突档案已按现网落笔**：旧报告记 904 绑 `[4]`、A0 记 10 家 —— 现网只读确认为 **10 家**。
已知历史遗留 `user 194 → store 2`（悬空，A0 已记，非本次引入，本次不改）。

### S1 备份与恢复条件 ⛔ **停止条件命中**

| 项 | 实测 | 判定 |
|---|---|---|
| 最近备份 | `2026-11-12 02:40`，`scqf-backup-20261112-024001.tar.zst.enc`，296,347,184 B，解包校验通过，媒体 691 文件 | ✅ 新鲜 |
| `status/last-run.json` | `ok=true`，`db_dump_bytes=3,782,957` | ✅ |
| 密钥 | `/root/.scqf-backup.key`，600 root，64 B | ✅ |
| 三条 cron | `02:40` 备份 / 周日 `04:30` 演练 / `09:00` watchdog | ✅ 在 |
| **最近一次成功恢复演练** | `status/last-drill.json` **停在 2026-10-25** | ⛔ **18 天，阈值 9** |
| watchdog 今日 09:00 | `ALERT[ERROR] 最近一次成功演练已 18 天（阈值 9）`（11-04 起连续 9 天） | ⛔ 未消除 |
| 11-01 / 11-08 演练 | 10 张表计数全一致，但末尾 `ALERT[ERROR] 恢复库 sms.enabled=true（必须为 false，否则切库会真发短信）` ⇒ **未计入成功** | ⛔ 根因未修 |

⇒ 命中「停止条件汇总」第 2 条「**备份不新鲜 / 恢复演练未过**」。
**备份本身没问题，问题是「恢复条件」**：恢复库 `service_settings.sms.enabled=true`，
一旦真的切库且环境变量未同步，会真发短信。这与「archive_verify 真实短信继续关闭」的安全前提直接相关。

### 短信关闭现状（当前生产安全，但恢复态不安全）

| 层 | 值 |
|---|---|
| 生产容器 `SMS_ENABLED` | **`false`** ⇒ 当前不会发真实短信 ✅ |
| `SMS_REVIEW_PENDING_SCENES` | 空 |
| `archive_verify` 短信行 | **0** ✅；已启用场景仅 4 个既有：`progress_link`/`dispatch_customer`/`technician_task`/`review_invite` |
| 生产库 `service_settings.sms.enabled` | `true`（与环境变量总闸不一致，也是演练告警来源） |

### 保护边界 ✅

- 原有售后数据未被触碰：`service_tickets=526`、`service_visits=300`、`service_visit_photos=65`、`customer_medias=618`、`sms_logs=864`。
- 角色 7 个未变；`member` 的 38 条全量授权与 `allowNewMobileMenu=true` 是 **S6-B 必须收敛**的已知项（不是未知冲突）。
- Nginx `sh.scqfls.cn.conf` 310 行：**无 `archive` location、无 `limit_` 指令**。
  ⇒ 匿名摘要查询限流在**应用层**（冻结产物含 `consumeSliding`×3 / `ARCHIVE_QUERY`×34），
  S7 须实打 4 次验证「前 3 次 200、第 4 次 429」，不能拿 Nginx 配置当证据。
- 生产 H5 目录只有 `index.html` + `assets/`，**无 `archive.html` / `archive-render.js`** ⇒ 客户入口未开放 ✅。
  `h5/index.html` = `b0f20092…`，与本机一致。
- 生产 dist 仍是旧版：`server/index.js=4030a9f4…`、`client/index.js=62b4d71f…`、
  `build-fingerprint.json=bf249477…`，**无 `client-v2/`**，migrations **23** 条（本机 24）
  ⇒ ARC-V1 确实尚未部署，S4 是整目录替换，不是覆盖已有 ARC 文件。

### 交付白名单与 SHA256

见 `docs/ARC-V1-DELIVERY-FILES.md` **第八节**（27 项完整、两个修复脚本已重新登记 SHA256、
10 个含明文口令的历史脚本全部排除）。
🔴 **第七节 R0 旧 SHA256 已作废**；4 个 dist 产物以冻结清单为准（**4/4 MATCH**）。
🔴 **H5 客户页存在三套哈希**，当前实物是 A5-G 防泄露修复后的版本，
**S3 之前须由授权方明确裁决冻结基线，禁止回退旧版**。

### 员工端 / 客户摘要查询分别评估

| 面 | 上线条件 |
|---|---|
| **员工端** | S0/S2 冲突项全清，技术条件具备；但**同受 S1 阻塞**，须先处置恢复演练。S6-B 必须把 `member×ARC` 收敛到 0。 |
| **客户手机号摘要查询** | 当前生产入口未开放（无 `archive.html`、无 nginx location），可**延后单独上线**；上线前须实打 4 次验证每 60 秒最多 3 次，且响应只含摘要、不开放敏感详情或照片。`archive_verify` 真实短信继续关闭。 |

> **本轮判定**：S0 ✅ / S2 ✅ / **S1 ⛔** ⇒ 按 RUNBOOK 停止条件，
> **不满足执行 S3–S7 的条件**。须先：① 修复恢复库 `sms.enabled` 并重跑演练至 `last-drill.json` 更新、
> watchdog 告警消除；② 裁决 H5 冻结基线；③ 取得 S3–S7 单独授权。
> 以上三项均**未在本轮执行**（涉及生产变更，须授权）。
> ⚠️ **本节为 2026-11-12 PROD-PRECHECK 当时的历史判定，已被 R1.7 取代**
> **当前状态以 R1.7 为准**：S1 隔离恢复演练真实 PASS、H5 唯一基线已冻结；
> 技术阻塞已消除，具备重新申请 S3–S7 的条件；但 **S3–S7 仍须明确授权**，
> 且生产 watchdog 告警消除需**单独授权**（见 R1.7 第四节）。

## R1.7 S1-RECOVERY 发布阻塞专项整改（2026-11-12）

> **授权范围**：仅隔离恢复环境演练 + 本地交付文档；**未授权生产写入 / 服务重启 /
> 生产配置变更 / 生产切换 / 客户入口开放 / commit / push**。
> 本轮对现网只做 `SELECT` 与只读 `cat|stat|wc`，**生产零写入**。

### 一、S1 恢复安全演练 —— 真实 PASS（隔离环境）

工具 `scripts/restore-drill-sms-safe.sh`（新建，**不覆盖**生产 `restore-drill.sh`），
编排 `.tmp-media/s1-run-drill.py`，证据 `.tmp-media/s1-recovery/drill-evidence.json`
（`rc=0`、`verdict=PASS`、`run_at=2026-11-12T10:00:37+08:00`）。

- 备份包 `scqf-backup-20261112-024001.tar.zst.enc`，清单 `sms_enabled=true`，
  恢复库 `scqf_restore_drill` 原始 `sms.enabled=true` ⇒ **证明备份确实含危险配置**；
- 解包 7 成员、AES key 匹配、媒体清单匹配、**691 个媒体逐文件 SHA-256**、
  `pg_restore` 成功、10 张表计数全一致、683 个 `storage_key` 双向核对
  （缺文件 0、孤儿 8）、历史档案/转换悬空引用 0 ⇒ **不是只查 10 张表行数**；
- **未消毒门禁 = BLOCKED**；消毒后 **F1–F5 全到位 = PASS**；
- **5/5 真实数据变异全部 BLOCKED**（真改恢复库 `sms.enabled` / 真改环境变量
  `SMS_ENABLED` / 真改 `sms.provider` / 模拟忘开网络隔离 / 真把一条 `sms_logs`
  改回 `pending`），每轮单变量后 `sanitize_sms` 还原；
- 网络出口 `EGRESS_BLOCKED` 且有反向对照 `DNS_OK`（证明隔离真生效，不是 DNS 全挂）；
  恢复库外部会话 0、恢复副本应用容器 0、`restore_app_started=false`。

| 防线 | 内容 | 证据键 |
|---|---|---|
| F1 | 恢复库 `service_settings.sms.enabled=false` | `drill_sms_enabled_after_sanitize=false` |
| F2 | 恢复环境 `SMS_ENABLED=false` | `drill_env_SMS_ENABLED=false` |
| F3 | 真实 Provider 禁用（`sms.provider=mock` + 所有 `sms.scene.*.enabled=false`） | `drill_sms_provider=mock` / `drill_scenes_enabled=0` |
| F4 | `unshare -n` 阻断真实短信探测 + `DNS_OK` 反向对照 | `egress_real=BLOCKED` / `egress_reverse_control=DNS_OK` |
| F5 | 积压短信任务冻结（`send_status='pending'` 必须为 0） | `drill_pending_queue=0` |

**生产零状态写入证明**：演练前后 `last-drill.json` mtime=`1792873807`、
sha=`c352aa6d8a7ddf6b`、`alerts.log` 17 行、`LAST-ALERT` sha=`63a78c6653de662a`、
`drill-202611.log` 42 行 **全部一致**；现网库 `sms.enabled` 前后均 `true`（未改）。
⇒ 未手改时间戳、未伪造 PASS、未关闭 watchdog 告警、未改现网短信业务策略。

### 二、发布控制复核（生产只读，19/19 与 R1.6 基线一致）

证据 `.tmp-media/s1-recovery/release-control.json`（`verdict=PASS`）。
904 绑定 10 家、角色 7 个、工单 526 / 回访 300 / 照片 65 / 媒体 618 / sms_logs 864、
待发队列 0、`archive_verify` 0、`member×ARC` 0、迁移 41 条、ARC 六表 0、
生产库 `sms.enabled=true` 未改、容器 `SMS_ENABLED=false`、
生产 H5 无 `archive.html`、生产 dist 无 `client-v2/`、隔离恢复库无遗留。

- 10 个含明文口令历史脚本**仍全部排除在白名单外**（实测 `arc1.*` 测试口令字面量
  9 个脚本命中；`arc-dev-admin-restore.mjs` 为口令赋值形态而非该字面量，同样排除）；
- 密钥/凭据文件 `.env` / `.deploy-pass` / `aes_key.dat` / `license` 等均不在白名单；
- **未修改账号 904 门店绑定、未修改现有售后工单权限、未运行全量 seed**；
- `git status --short --untracked-files=all`：68 已跟踪改动 / 262 未跟踪 /
  **0 已暂存 / 0 删除**；HEAD 仍 `9a57997`，**未 commit、未 push**。

### 三、H5 最终基线已冻结

见 `docs/ARC-V1-DELIVERY-FILES.md` **第九节**（唯一 SHA256 基线、7/7 属性、
8/8 变异自证、三套历史哈希全部作废）。当前实物为 R0-CHG-01 + A5-G 安全版，
`h5/public` 与 `h5/dist` 逐字节一致，冻结 4 个 dist 产物 4/4 MATCH 未变。

### 四、watchdog 告警现状与恢复办法（**需单独授权**）

**现状（如实，不掩盖）**：生产 `status/last-drill.json` 仍停在 `2026-10-25 04:30:07`，
距今 **18 天**（阈值 9）；`LAST-ALERT` 仍是
`2026-11-12 09:00:02 ERROR 最近一次成功演练已 18 天（阈值 9）`。
本轮隔离演练**按授权刻意不写** `status/last-drill.json` / `logs/` / `alerts.log` /
`LAST-ALERT` / syslog / crontab，因此告警**未消除**——这是授权边界的结果，不是演练失败。

**告警恢复办法（须单独授权后方可执行，本轮一律未做）**：

1. 授权把 `restore-drill-sms-safe.sh` 的 **F1–F5 五道防线 + pre_launch_gate**
   合并进生产 `/opt/scqf-aftersales/scripts/restore-drill.sh`（或作为其启动前置门禁），
   使**官方**演练也具备同等级短信安全，且恢复库消毒后才允许启动恢复副本应用；
2. 在授权窗口内，用最新备份跑一次**官方**恢复演练（周日 04:30 cron 或手动触发），
   由官方脚本正常写出 `status/last-drill.json`（`ok=true`，并带 `sms_enabled=false`）；
3. 次日 09:00 `watchdog.sh` 重算 `DAGE ≤ 9` ⇒ `exit 0`，不再追加新的 ERROR；
   `LAST-ALERT` 与 `alerts.log` 作为历史**保留不清空**；
4. 回验：`watchdog.sh; echo $?` = 0、日志出现 `OK 最近备份…`、
   再比对 `last-drill.json` 与 `alerts.log` 确认只有新增成功记录。

**严禁**：手改 `last-drill.json` 的 mtime 或内容、直接清空 `alerts.log`/`LAST-ALERT`、
关闭 watchdog 或把 9 天阈值调大、摘掉 `lib-alert.sh`。
这些做法只会让告警变绿，**不会让恢复流程变安全**。

### 五、发布状态与 S0–S7 条件

| 阶段 | 状态 | 执行条件 |
|---|---|---|
| S0 / S2 | ✅ PASS（R1.6，本轮 19 项复核一致） | 已完成，无需重跑 |
| **S1** | **✅ 完全闭环**（2026-11-12 10:51 官方演练 PASS + watchdog 恢复正常） | 五道防线已并入生产脚本；`last-drill.json` 已真实更新；见第六节 |
| S3 备份 | ⛔ 未执行 | 须 S1 收口 + 单独授权；发布前整库 `pg_dump` + `sha256sum -c` |
| S4 部署 | ⛔ 未执行 | 按 `sha256-manifest.json` 4 产物 + H5 第九节基线逐文件核对；**发布前不要再跑 `arc-r0freeze-artifact-check.mjs`** |
| S5 迁移 / S6 页面重放与权限 | ⛔ 未执行 | S6-B 必须把 `member×ARC` 收敛到 0；不改 904 绑定、不跑全量 seed |
| S7 验收 | ⛔ 未执行 | 客户摘要入口须实打 4 次验证「前 3 次 200、第 4 次 429」；`archive_verify` 真实短信继续关闭 |

**回滚条件**：任一阶段出现 ① 冻结产物 SHA256 不符；② H5 实物与第九节基线不符；
③ `member×ARC ≠ 0`；④ 904 绑定或现有工单权限被改动；⑤ 限流第 4 次未返回 429；
⑥ 备份包校验失败 —— 立即停止，按 R1.3 的 R1–R4 回滚，不得继续后续阶段。

> **判定（2026-11-12 10:51 更新）**：S1 **已完全闭环** —— 加固补丁已入生产、
> 官方演练真实 PASS、`last-drill.json` 已更新、watchdog 已恢复正常（见第六节）。
> **已满足申请 S3–S7 生产部署授权的条件。**
> **S3–S7 仍须等待用户对正式生产部署的明确授权，本轮一律未启动。**

### 六、S1-WATCHDOG 执行结果（2026-11-12 10:51，用户明确授权后执行）

> 授权来源：用户「S1-WATCHDOG 最后收口」明确授权执行全部三步。
> 执行范围严格限定：替换 `restore-drill.sh` → 跑一次官方演练 → 跑一次官方 watchdog。
> **未重启任何服务、未改 crontab / watchdog 代码、未动业务数据与短信开关。**

#### 1. 补丁内容（只做一件事：让演练能安全地变绿）

| 项 | 值 |
|---|---|
| 原脚本 | `1195a84195ae5f19…`（9031 B，750 root:root） |
| 加固后 | `2e02c9ad5deeb26cc215c5388430ecce89e7ad3657ef5d3a89eeb3b5d2a5b179`（12950 B，750 root:root） |
| 回滚备份 | `/opt/scqf-aftersales/scripts/restore-drill.sh.bak.20261112-105136`（sha256 = 原脚本） |
| 新增 | 隔离性自证 + `sanitize_sms()` + `pre_launch_gate()`（F1–F5）+ 未消毒反向验证 + 消毒后正向门禁 |

补丁只在 `pg_restore` 之后插入一段；另改 2 处（步骤 8 文案、`last-drill.json` 增 2 字段）。
**所有写语句只走 `psql_d`（= `scqf_restore_drill`），无任何指向生产库的写。**

F4 不使用 `|| echo BLOCKED` 兜底 —— `unshare` 不可用时取到空值会判 **FAIL**，
不会伪装成"已阻断"。

#### 2. 官方演练结果：**PASS**

`[10:51:43] 未消毒门禁已正确阻断` → `[10:51:44] 五道防线全部到位（F1–F5）`
→ 10 张表计数全部一致 → `storage_key 683 / 缺失 0 / 孤儿 7`
→ `sms.enabled=false（备份原样为 true）` → 悬空 0/0 → `恢复演练 v2 成功`。
`exit=0`，耗时 8.7s。

`status/last-drill.json`（已真实更新，非伪造）：

```json
{
  "ts": "2026-11-12 10:51:45 +0800",
  "ok": true,
  "bundle": "scqf-backup-20261112-024001.tar.zst.enc",
  "tables_checked": 10,
  "media_files_verified": 691,
  "storage_keys": 683,
  "missing_files": 0,
  "orphan_files": 7,
  "archives": 124,
  "conversions": 26,
  "sms_enabled": "false",
  "sms_enabled_in_backup": "true",
  "sms_gate": "PASS"
}
```

关键语义：`sms_enabled_in_backup=true` 与 `sms_enabled=false` **同时存在**，证明
「备份确实含危险配置」且「加固流程确实消毒掉了」，而不是把危险值抹掉当没发生。

#### 3. watchdog：**已恢复正常**

`[2026-11-12 10:51:48] OK 最近备份 2026-11-12 02:40:06，包 scqf-backup-20261112-024001.tar.zst.enc，可用 145GB`，`exit=0`。

- `watchdog.sh` 代码未改（sha256 仍 `99b8de70…`），crontab 三条仍在。
- `status/LAST-ALERT` 仍保留 `2026-11-12 09:00:02 ERROR 最近一次成功演练已 18 天` ——
  这是**最后一次告警的历史快照**，按授权**未清空**；当前状态以 watchdog 运行结果
  （exit 0 + `OK 最近备份` 行）判定，不以 LAST-ALERT 是否为空判定。
- 前后对照天然成立：同日 09:00 报 18 天 ERROR，10:51 报 OK ⇒ 证明 watchdog 真的读了
  `last-drill.json`，不是被绕过。

#### 4. 生产保护边界（29 项只读复核全通过）

生产库 `scqf_aftersales_candidate`、`sms.enabled` 仍 `true`、容器 `SMS_ENABLED=false`、
904 绑定 10 家、角色 7、工单 526、回访 300、`sms_logs` 864、待发 0、
隔离库已清理、应用容器在运行。证据 `.tmp-media/s1w/final-verify.json`。

#### 5. 回滚办法

```bash
cp -p /opt/scqf-aftersales/scripts/restore-drill.sh.bak.20261112-105136 \
      /opt/scqf-aftersales/scripts/restore-drill.sh
```

⚠️ 回滚后演练会再次在第 8 步失败、watchdog 告警会重新出现 —— 回滚仅用于
"新脚本本身出问题"，**不是用来消告警的**。

## R1.8 PROD-DEPLOY 执行中止记录（2026-11-12 11:00–11:06）

### 已完成（可核验）

| 阶段 | 结果 | 证据 |
|---|---|---|
| S3 备份 | **PASS** | `scqf-backup-20261112-105838.tar.zst.enc`，296,347,168 B，`c039c37e…`，`sha256sum -c OK`；恢复位置 `backups/daily` |
| S4 核对 | **PASS** | 4 个 dist 产物逐字节匹配冻结清单；migrations 48 文件；H5 为 `0939268b/04d46eba` 安全版（**本轮未部署**） |
| S5 部署 | **完成** | 52 文件落盘 SHA256 全一致；重启后 t+50s 健康 200、容器 healthy；migrations 41→42、roles 7→9、ARC 六表已建；工单 526 / 回访 300 / sms_logs 864 / 904=10 均未变 |

### STOP：客户匿名入口意外开放（命中停止条件）

- 部署冻结包后 `POST /api/publicArchive:queryByMobile` **匿名可达**
  （非法手机号返回我方 `400 ARCHIVE_QUERY_BAD_MOBILE` ⇒ 已越过鉴权执行到 handler）。
- 该 action 本就在 `PUBLIC_ANONYMOUS_ACTIONS` 白名单内；此前"入口关闭"靠的是
  **H5 文件与 nginx location 不存在**，不是服务端闸门 ⇒ 一旦部署 server 代码即开放。
- 命中 RUNBOOK 停止条件「客户匿名入口意外开放」⇒ **S6/S7 未执行**。

### 已执行的封堵（R2，非破坏性）

- 生产 nginx 块级插入 `location ^~ /api/publicArchive: { return 403; }`
  （备份 `sh.scqfls.cn.conf.bak.20261112-110502`，`nginx -t` 通过后 reload）。
- 验证：匿名 `queryByMobile`/`sendCode` = **403**；`/api/app:getInfo` = **200**；
  原有匿名 `/api/public/stores` = **200**（未误伤既有业务）。
- **未执行 R3**（恢复旧 dist）：旧代码 + 新迁移的兼容性未证明，
  按"无法证明安全时停止自动回滚并报告"处置。

### 中止后状态（可核验）

`desktopRoutes 34 / ARC 路由 0 / member×ARC 0 / arc_tables 6 / migrations 42 / roles 9`
`tickets 526 / visits 300 / sms_logs 864 / 904=10 / sms.enabled=true / SMS_ENABLED=false`
`H5 archive ABSENT / 匿名档案接口 403 / 应用健康 200`

⇒ **员工端 ARC 页面尚未创建（未启用），原有售后业务不受影响。**

### 下次恢复部署的前置条件

1. 给 `publicArchive` 增加**服务端闸门**（环境变量/配置开关，默认关闭），
   或提供不含该 action 的部署变体；否则任何一次部署冻结包都会重新打开该入口。
2. 页面重放脚本需支持目标库参数（当前硬编码 `service_ticket_verify` 与
   `svc-postgres`，且 `S1` 只接受 0/0/0 或 2/26/1，**无法对 34 条既有路由的生产库运行**）。
3. 上述两项完成后，从 S6-A 续跑；S3–S5 已完成的产物无需重做。

