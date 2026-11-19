# P6 生产备份与恢复能力验收报告

> 执行时间：2026-10-22 14:03–14:08（UTC+8）
> 目标主机：`162.14.121.180`（OpenCloudOS 9.4 / 宝塔 11.8.0）
> 业务库：`scqf_aftersales_candidate`
> 本轮边界：**未改 H5 / 未改 Nginx 路由 / 未改业务算法 / 未 commit / 未 push**
> 判定：**本地备份与恢复能力 = PASS**；**异地 = PENDING**；**外部告警 = PENDING**

---

## 0. 结论速览

| # | 项目 | 状态 | 依据 |
|---|---|---|---|
| 1 | 定时任务及执行账号 | ✅ PASS | root crontab 3 条，最小环境实跑 exit=0 |
| 2 | 数据库与媒体备份范围 | ✅ PASS | 库 + 610 媒体 + 双密钥 + 清单 |
| 3 | 加密方式与密钥保管 | ✅ PASS（离线副本 PENDING） | AES-256-CBC/PBKDF2 20 万次；密钥已移出备份目录 |
| 4 | 异地存储 | ❌ **PENDING** | 服务器无任何 COS 凭据，见 `DEPLOY-P6-OFFSITE-REQUEST.md` |
| 5 | SHA-256 校验 | ✅ PASS | 包级 + 610 个媒体逐文件 + 清单 + aes_key |
| 6 | 隔离恢复演练 | ✅ PASS | 10 表全等、storage_key 缺失 0、档案/转换零悬空 |
| 7 | 失败告警 | ⚠️ **本地可发现 PASS / 外发 PENDING** | syslog 实测收到 3 条；webhook 未授权 |
| 8 | 保留策略 | ✅ PASS | 日 7/周 4/月 3；实测 5→8→裁到 7 |
| 9 | 生产数据未受影响 | ✅ PASS | 489/1827/551/51/124/26/783 全等，孤儿 28+4 未动 |
| 10 | 未完成事项 | — | 见 §10 |

> **不把"文件存在"当 PASS，也不把"本机能恢复"说成"能容灾"。**

---

## 1. 定时任务及执行账号

**执行账号：`root`**（`id -un` = root；crontab 为 root 的 crontab）

| 时间 | 命令 | 作用 |
|---|---|---|
| `40 2 * * *` | `flock -n .cron-backup.lock → backup.sh` | 每日备份 |
| `30 4 * * 0` | `flock -n .cron-drill.lock → restore-drill.sh` | 每周日恢复演练 |
| `0 9 * * *` | `watchdog.sh` | 每日新鲜度/完整性/容量巡检 |

- 每条 cron 外层再加一层 `flock`，脚本内部还有一层 `flock`（**双层互斥**：cron 层防重叠，脚本层防手工误触并发）。
- 时区 `Asia/Shanghai`；`02:40` / `04:30` 刻意避开 acme 续期的 `03:17`。
- crontab 原有 5 条未改动（含 acme），现共 **8 条**；修改前已备份
  `/opt/scqf-aftersales/backup/crontab-root-pre-backup-20261022.bak`。
- **最小环境实跑**（模拟 cron 的 `PATH=/usr/bin:/bin`）：

```
env -i PATH=/usr/bin:/bin HOME=/root backup.sh        → exit=0
env -i PATH=/usr/bin:/bin HOME=/root restore-drill.sh → exit=0
env -i PATH=/usr/bin:/bin HOME=/root watchdog.sh      → exit=0
```

- 依赖实测全部在 `/usr/bin`：`docker zstd openssl flock logger mail tar find stat df du`

> ⚠️ 诚实说明：三条 cron **尚未经历一次"自然触发"**（今天 02:40 已过、下周日在未来）。
> 已完成的是"cron 等价的执行环境实跑"，不等于"调度器确实触发了"。
> 首次自然触发应在 **2026-10-23 02:40**，建议届时核对 `logs/backup-202610.log` 是否新增一条。

---

## 2. 数据库与媒体备份范围

单次备份产物（`scqf-backup-20261022-140642.tar.zst.enc`，**21,938,272 B**）：

| 成员 | 内容 | 大小/数量 |
|---|---|---|
| `db.dump` | `pg_dump -Fc --no-owner --no-privileges`，库 `scqf_aftersales_candidate` | **3,771,222 B**，TOC **1068** |
| `media.tar.zst` | `/www/scqf-as-media` 全量 | **610 文件 / 97,427,269 B** → 压后 23,730,461 B |
| `media-list.tsv` | 逐文件 `相对路径<TAB>字节`，610 行 | 恢复演练据此核对 `storage_key` |
| `media-sha256.txt` | 逐文件 SHA-256，610 行 | 演练时真校验 |
| `keys/aes_key.dat` | 32 B，`sha256=c4ec6e9931440a4f…` | 与库**同版本**才能解字段 |
| `keys/instance-id` | 685 B，许可证标识 | — |
| `manifest.txt` | 计数 + 哈希 + `sms_enabled`（**不含任何凭据**） | — |

**媒体必须分目录核对**（这是 P4-A 踩过的坑）：

| 目录 | 文件数 | 说明 |
|---|---|---|
| `customer/` | **551** | 客户提交的照片/语音/视频 |
| `visits/` | **59** | 师傅现场照片 —— **只打 customer/ 会全丢** |
| 合计 | **610** | 与 `customer_medias 551 + service_visit_photos 51` 的引用关系一致（§6） |

**恢复所需元数据**：`manifest.txt` 里的 `table_counts`（10 张关键表）、`aes_key_sha`、`instance_sha`、
`media_list_sha`、`sms_enabled` —— 恢复后逐项比对，不靠人记。

> 备份**不进 Git、不进 Web 目录**：`/opt/scqf-aftersales/backups` 不在 `/www` 下（已核），
> nginx 配置对该路径引用数 **0**，`/www/wwwroot` 下无任何 `.dump` / `.tar.zst.enc` 副本。

---

## 3. 加密方式及密钥保管策略

### 3.1 加密

```
tar(cf) → zstd(-3) → openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt
```

- 对称加密 **AES-256-CBC**，密钥派生 **PBKDF2-HMAC-SHA256，200,000 次迭代**，每次随机 salt。
- 加密发生在**打包管道里**，明文 `db.dump` / `media.tar.zst` **不落盘到最终目录**
  （只在 `.staging` 短暂存在，脚本退出时由 `trap cleanup` 删除）。
- 这样设计的原因：媒体里有客户上门照片、库里有客户手机号。备份文件必然要移动，
  只要会移动就必须假定途中会被别人拿到 —— 明文备份等于把客户资料复制到更容易泄露的地方。

### 3.2 密钥保管（本轮做了实质改进）

| 项 | 现状 |
|---|---|
| 位置 | **`/root/.scqf-backup.key`**（600 root，64 字符） |
| 是否在备份目录内 | **否** —— 本轮已从 `backups/.backup.key` 迁出并删除旧文件 |
| 目录内提示 | `backups/README-KEY.txt`（640），只写"密钥不在这里"，不含密钥 |
| 脚本取用顺序 | `$BACKUP_KEY_FILE` → `/root/.scqf-backup.key` → 旧位置（兼容回退） |
| 迁移后验证 | 立刻实跑一次备份 **exit=0**，产出新包 `…140642`，证明密钥仍可用 |

**目的**：即使整个 `backups/` 目录被打包带走（`cp -a` / `tar`），拿到的也只是加密包，**不含密钥**。

### 3.3 仍然缺的一步（PENDING）

密钥与备份**仍在同一台机器、同一块盘**。这只能防"备份被拷走"，**不能防"机器没了"**。
需要你把它抄一份到**离线介质 / 密码管理器**：

```bash
cat /root/.scqf-backup.key      # 在你自己的终端执行，本会话不打印
```

丢了它 = 所有备份永久打不开（PBKDF2 无后门）。

---

## 4. 异地存储状态

**PENDING —— 完全未配置。**

只读核查 6 个位置全部为空：无 `coscli/rclone/ossutil/coscmd/aws/s3cmd`、无任何云端配置文件、
无相关环境变量、`.env.prod` 无相关键、宝塔无对象存储插件、无云端备份配置痕迹。

按执行令要求：**未创建任何收费资源、未向任何未知位置上传任何字节**。
详细需求（桶配置、最小权限子账号策略、凭据下发方式三选一）见
**`docs/DEPLOY-P6-OFFSITE-REQUEST.md`**。

---

## 5. SHA-256 校验结果

| 校验对象 | 结果 |
|---|---|
| 备份包（整包） | 落盘时生成 `.sha256`；演练前先 `sha256sum -c`，**通过才继续** |
| 媒体逐文件 | `media-sha256.txt` 610 条，演练中 `sha256sum -c` **610/610 全部 OK** |
| 媒体清单 | `media-list.tsv` 的 sha256 与 manifest 中 `media_list_sha` **一致**（本次 `ba065a75…`） |
| `aes_key.dat` | 包内实测 `c4ec6e9931440a4f8902d550d24e258cafdb14233301bad561d3c8d6e17e7c8a`，与 manifest **一致**；且与 P4-B 迁移时记录的源哈希一致 |
| `instance-id` | `2dfe60966bd2f1f1…`，与 manifest 一致 |

> 为什么不用"总大小相同"当判据：大小相同但内容被替换（同长度覆盖）时大小判据完全失效。
> 逐文件哈希才能发现"某一张照片被换成了别的东西"。

---

## 6. 隔离恢复演练

**演练库 `scqf_restore_drill`（临时，结束即 drop）—— 绝不覆盖生产库。**

演练对象：`scqf-backup-20261022-140642.tar.zst.enc`（先过 sha256）

### 6.1 十张关键表逐表比对（全部一致）

| 表 | 行数 |
|---|---|
| `service_tickets` | 489 |
| `ticket_events` | 1827 |
| `customer_medias` | 551 |
| `service_visit_photos` | 51 |
| `historical_service_archives` | **124** |
| `historical_ticket_conversions` | **26** |
| `service_settings` | 26 |
| `sms_logs` | 783 |
| `stores` | 10 |
| `users` | 11 |

### 6.2 `storage_key` ↔ 实际媒体文件（双向）

```
storage_key 引用 602 个（customer_medias ∪ service_visit_photos 去重）
缺失文件  0 个   ← 硬失败闸门，非 0 即 exit 1
未引用文件 7 个   ← 历史允许，原样保留并打印路径
```

- 602 = 551（客户媒体）+ 51（技师照片），与库内行数一致。
- 610 个文件 − 602 个被引用 = 8，其中 1 个与其它行共享同一 `storage_key`（去重后为 7）。
- 未引用文件全部在 `visits/` 下（如 `visits/2430/202610/43c3aa3b….png`），**未删除、未清理**。

### 6.3 其他强断言

| 检查 | 结果 |
|---|---|
| `sms.enabled` | **`false`** —— 恢复后仍禁用（否则切库会真发短信，P4-B 踩过） |
| 历史档案 | 124 条 |
| 历史转单 | 26 条 |
| 悬空 `archive_ref`（转换指向不存在的档案） | **0** |
| 悬空 `ticket_ref`（转换指向不存在的工单） | **0** |
| 媒体解包 | 610 文件全部解出，逐文件哈希通过 |

### 6.4 演练产物

`backups/status/last-drill.json`：

```json
{
  "ts": "2026-10-22 14:07:03 +0800",
  "ok": true,
  "bundle": "scqf-backup-20261022-140642.tar.zst.enc",
  "tables_checked": 10,
  "media_files_verified": 610,
  "storage_keys": 602,
  "missing_files": 0,
  "orphan_files": 7,
  "archives": 124,
  "conversions": 26,
  "sms_enabled": "false"
}
```

---

## 7. 失败告警验证

### 7.1 告警出口（四层，统一由 `scripts/lib-alert.sh` 实现）

| 层 | 通道 | 状态 |
|---|---|---|
| ① | **syslog**（`logger -t scqf-backup/-drill/-watchdog`）→ `/var/log/messages`，宝塔「系统日志」可看 | ✅ 可用 |
| ② | Webhook（企业微信/钉钉机器人） | ⚠️ **未授权，未配置** |
| ③ | 邮件 → 本机 root（postfix 只监听 127.0.0.1，外发不可用） | ⚠️ 兜底 |
| ④ | `status/LAST-ALERT`（640，供巡检脚本读取最近一条） | ✅ 可用 |

> 抽成 `lib-alert.sh` 的原因：上一版三个脚本各写一份告警，改一处必漏两处。
> 现在只有一个实现，避免"同一个坑有两条腿"。

### 7.2 三类失败实测（都真的变红）

| 用例 | 构造 | 实测 |
|---|---|---|
| 容量不足 | `MIN_FREE_GB=999999` | **exit=1**，告警：`磁盘空间不足：可用 151804MB < 需要 …` |
| 状态缺失 | `mv last-run.json` | **exit=1**，告警：`从未成功备份过（…不存在）` |
| 包被篡改且无备用 | 复制最新包改 1 字节 + 挪走好包 | **exit=1**，告警：`找不到任何通过 sha256 校验的备份包` |

### 7.3 告警确实进了 syslog（不是只写本地文件）

```
2026-10-22T14:05:34.647531+08:00 VM-0-8-opencloudos scqf-backup[1420220]: [ERROR] 磁盘空间不足：…
2026-10-22T14:05:34.843291+08:00 VM-0-8-opencloudos scqf-watchdog[1420270]: [ERROR] 从未成功备份过…
```

`/var/log/messages` 计数 **3** 条（含 drill 一条）。

### 7.4 看门狗覆盖的判据

1. 最近一次成功备份是否 **≤26h**
2. `last-run.json` 是否为 `"ok": true`
3. 最新 daily 包的 `.sha256` 是否自洽
4. 备份盘可用空间是否 **≥5GB**
5. **最近一次成功演练是否 ≤9 天**（本轮新增）

> 覆盖"脚本根本没跑"这一最常见失败形态 —— 它不会报错，只会静默。

### 7.5 仍未解的

**没有授权的外部通道**。syslog 是"可检索"，但**不会主动推送到你手机**。
如果不能做到"出事时有人收到消息"，告警就是半成品 —— 这一项标 **PENDING**，等你给 webhook 或 SMTP。

---

## 8. 备份保留策略

| 层级 | 保留 | 触发 |
|---|---|---|
| `daily/` | **7** 份 | 每次备份 |
| `weekly/` | **4** 份 | 仅**周日**晋升（硬链接，不额外占空间） |
| `monthly/` | **3** 份 | 仅**每月 1 号**晋升 |

- 单包 21 MB；满配理论占用 ≈ 7×21 + 4×21 + 3×21 ≈ 294 MB（硬链接使周/月不重复占盘，实际更少）。
- 当前实测：`daily=7`，目录合计 **147 MB**，磁盘可用 **151 GB**。

### 8.1 保留期实测（不是只读代码）

```
清理前 daily = 5
连跑 3 次备份（产生 3 个新包）
清理后 daily = 7      ← 触发裁剪
最早包 scqf-backup-20261022-124813 已被删除
孤儿 .sha256 文件数 = 0
```

> 特意验证"孤儿 `.sha256`"：裁剪时若只删 `.enc` 不删 `.sha256`，目录会慢慢堆满无用小文件，
> 且下次 `ls | wc -l` 会给出错误的备份数量 —— 这是一个不容易发现但会误导审计的缺陷。

### 8.2 容量闸门

开跑前要求 `可用 ≥ max(上次包 × 3, 2 GB)`，不足则**拒绝开跑并告警**
（不是"跑一半失败"，那会留下截断的包，比没有备份更危险）。
本轮为能证明该闸门有效，把阈值做成可被 `MIN_FREE_GB` 覆盖（否则只能靠塞满磁盘来测）。

---

## 9. 生产数据未受影响的证据

| 检查项 | 开工前 | 收工后 | 结论 |
|---|---|---|---|
| `service_tickets` | 489 | **489** | 未变 |
| `ticket_events` | 1827 | **1827** | 未变 |
| `customer_medias` | 551 | **551** | 未变 |
| `service_visit_photos` | 51 | **51** | 未变 |
| `historical_service_archives` | 124 | **124** | 未变 |
| `historical_ticket_conversions` | 26 | **26** | 未变 |
| `sms_logs` | 783 | **783** | 未变 |
| `sms.enabled` | false | **false** | 短信仍禁用 |
| 孤儿工单 `store_id=2` | 28 | **28** | **未删除** |
| 孤儿工单 `store_id IS NULL` | 4 | **4** | **未删除** |
| 媒体文件 | 610 | **610** | 未增未删 |
| 容器 | app/postgres healthy | **healthy** | 未重启 daemon |

另外确认：

- **备份不在 Web 可读路径**：`/opt/scqf-aftersales/backups` 不在 `/www` 下；nginx 配置引用 **0**；
  `/www/wwwroot` 下无 `.dump` / `.tar.zst.enc`。
- **公网探测不算泄露**：`/backups/`、`/opt/scqf-aftersales/backups/`、`/scqf-backup-….enc`
  全部返回 **200 + `text/html` + 2508 字节 + `<!DOCTYPE html>`** —— 那是 NocoBase 的 SPA 加载壳，
  **不是备份文件**。（只看状态码会把这件事误报成"备份已泄露到公网"。）
- 演练临时库 `scqf_restore_drill` 每次结束即 `drop`；生产三库
  （`scqf_aftersales` / `scqf_aftersales_candidate` / `scqf_aftersales_rehearsal`）保留未动。
- 既有手工备份 `/opt/scqf-aftersales/restore-staging/`（7 份，191 MB）**原样保留，一份未删**。

---

## 10. 未完成事项

| 编号 | 事项 | 卡在哪 |
|---|---|---|
| `P6-BK-01` | **异地加密副本** | 需 COS 桶 + 最小权限子账号（见 OFFSITE-REQUEST） |
| `P6-BK-02` | **外部告警通道** | 需 webhook URL 或 SMTP 授权；当前只能靠 syslog 被动检索 |
| `P6-BK-03` | **密钥离线副本** | 需你手工抄走 `/root/.scqf-backup.key` |
| `P6-BK-04` | **cron 自然触发验证** | 等 2026-10-23 02:40 首次触发后核对日志 |
| `P6-BK-05` | 早期 4 个旧包不含 `media-list.tsv` / `media-sha256.txt` | 新脚本产物才有；旧包仍可恢复，只是演练会拒绝（成员不全） |
| `P6-BK-06` | 异地恢复演练（从云端拉回再恢复） | 依赖 `P6-BK-01` |

### 已知限制（写给自己，也写给审计）

- 备份与生产**同盘**：磁盘整体损坏时两者一起没。这是当前最大风险，**不是**脚本能解决的。
- 加密口令与备份同机：只能防"包被拿走"，不能防"机器被拿走"。
- 演练验证的是**备份包完整性 + 可恢复性**，不覆盖"恢复后业务功能是否正常"（那需要另立验收令）。

---

## 11. 交付物清单

| 文件 | 位置 |
|---|---|
| 备份主脚本 | `/opt/scqf-aftersales/scripts/backup.sh`（750 root） |
| 恢复演练脚本 | `/opt/scqf-aftersales/scripts/restore-drill.sh`（750 root） |
| 看门狗 | `/opt/scqf-aftersales/scripts/watchdog.sh`（750 root） |
| 统一告警库 | `/opt/scqf-aftersales/scripts/lib-alert.sh`（640 root） |
| 加密密钥 | `/root/.scqf-backup.key`（600 root） |
| 备份目录 | `/opt/scqf-aftersales/backups/`（700 root） |
| 状态可巡检 | `backups/status/last-run.json`、`last-drill.json`、`LAST-ALERT` |
| 异地资源需求 | `docs/DEPLOY-P6-OFFSITE-REQUEST.md` |
| 本报告 | `docs/DEPLOY-P6-BACKUP-ACCEPTANCE.md` |

---

## 12. 最终判定

- **P6 备份与恢复（本地闭环）= PASS**：定时、加密、校验、演练、告警、保留期六项均有实测证据，
  且失败路径**真的会变红**。
- **异地 = PENDING**，**外发告警 = PENDING**，**密钥离线副本 = PENDING**。
- **P6：LIVE / CONDITIONAL**；**Release：HOLD**。
- 未 commit / 未 push；未改 H5、未改 Nginx 路由、未改业务算法；
  未删孤儿工单、未动门店 ACL、未重启 Docker daemon、未覆盖生产库、未删既有恢复备份。

**本轮结束，等待下一步授权。**
