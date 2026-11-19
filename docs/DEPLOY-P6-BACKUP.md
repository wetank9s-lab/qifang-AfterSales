# P6 上线后紧急收口 · 任务二：生产自动备份治理

> 执行时间：2026-10-22 12:46–12:52（UTC+8）
> 目标：`162.14.121.180` / `/opt/scqf-aftersales/backups`
> 判定：**本地自动备份闭环 PASS**；**异地与外部告警 NOT DONE（需用户决策）**
> 未动生产数据：tickets **489** / events **1827** / medias **551** / sms_logs **783** 全程不变

---

## 一、先说结论与边界（不夸大）

| 能力 | 状态 | 说明 |
|---|---|---|
| 每日自动备份 | ✅ 已上线 | cron `40 2 * * *`，flock 互斥 |
| 加密 | ✅ | AES-256-CBC + PBKDF2 20 万次，密钥独立 600 文件 |
| 完整性校验 | ✅ | 真解密 + 成员清点 + 包内媒体条目数复核 |
| 保留期 | ✅ | 日 7 / 周 4 / 月 3（周日晋升、每月 1 号晋升） |
| 容量闸门 | ✅ | 需 ≥ max(上次包 ×3, 2GB)，不足则**拒绝开跑并告警** |
| 恢复演练 | ✅ 已跑通 | 每周日 `04:30`，真恢复到临时库并逐表比对 |
| 新鲜度看门狗 | ✅ | 每日 `09:00`，与备份脚本解耦 |
| **异地副本** | ❌ **未实现** | 服务器上没有任何对象存储凭据/对端主机 |
| **外部告警** | ⚠️ **半成品** | postfix 只监听 `127.0.0.1:25`，外发不可用；已留 webhook 接口 |
| **密钥离线保管** | ❌ **待用户动作** | 密钥与备份同盘 ⇒ 防"包被拿走"，**不防"盘没了"** |

> 一句话：**现在磁片挂了仍然全丢**。任务二只做到"同一台机器上的自动、加密、可验证、可保留"，离"容灾"还差两步，卡在需要用户提供资源（异地目标 + 告警通道 + 密钥离线副本）。

---

## 二、为何这样设计（四条硬约束）

1. **备份必须离开这台机器才有意义** ⇒ 只要文件会移动，就必须假定途中会被别人拿到。
   媒体里有客户上门照片、库里有客户手机号 —— 明文备份等于把客户资料复制到更容易泄露的地方。
   ⇒ 加密不是可选项。

2. **"文件存在"不等于"能用"** ⇒ 必须有真恢复演练。真实翻车最常见的一类是：
   备份一直跑、从不报错，真要恢复时才发现少序列/少表。

3. **定时任务最常见的失败不是报错，而是"根本没跑"** ⇒ 看门狗独立判断"最近成功备份是否够新"，
   不和备份脚本共用同一套逻辑（否则备份脚本坏了，检查它的人也一起坏）。

4. **容量不足时要失败得早且响** ⇒ 磁盘写满时若继续跑，会得到一个**截断的备份**，
   而截断的备份比没有备份更危险（它看起来是成功的）。

---

## 三、交付物

### 3.1 三个脚本（`/opt/scqf-aftersales/scripts/`，`750 root:root`）

| 脚本 | 作用 | 触发 |
|---|---|---|
| `backup.sh` | 备份主流程 | 每日 02:40 |
| `restore-drill.sh` | 真恢复演练 | 每周日 04:30 |
| `watchdog.sh` | 新鲜度/完整性/容量检查 | 每日 09:00 |

### 3.2 目录结构

```
/opt/scqf-aftersales/backups/          700
├── .backup.key                        600  64 字节（AES 口令，**需离线另存**）
├── .backup.lock                             备份互斥锁
├── daily/     scqf-backup-<ts>.tar.zst.enc + .sha256 + manifest-<ts>.txt
├── weekly/    仅周日晋升（硬链接，不额外占空间）
├── monthly/   仅每月 1 号晋升
├── logs/      backup-YYYYMM.log / drill-YYYYMM.log / watchdog-YYYYMM.log / alerts.log
└── status/    last-run.json / last-drill.json
```

### 3.3 一个包装什么

| 成员 | 内容 |
|---|---|
| `db.dump` | `pg_dump -Fc --no-owner --no-privileges`，3,771,150 B，TOC **1068** |
| `media.tar.zst` | `/www/scqf-as-media` 全量：**610 文件 / 1640 目录 / 97,427,269 B** → 压后 23.7 MB |
| `keys/aes_key.dat` | 32 B（与库**同版本**才能解开既有加密字段） |
| `keys/instance-id` | 685 B（许可证标识） |
| `manifest.txt` | 明文清单：计数 + 哈希 + `sms_enabled`，**不含任何凭据** |

> 媒体只打 `customer/` 是不够的 —— `visits/`（技师现场照片 59 个）会被整体丢掉（P4-A 已登记的关键坑）。

### 3.4 实测体积

- 单包 **21 MB**（`zstd -3` 后加密），一次全流程约 **2 秒**
- 当前保留 4 个日包，目录合计 **84 MB**
- 满配（7 日 + 4 周 + 3 月 + 硬链接）≈ **260 MB**，相对 149 GB 可用可忽略

### 3.5 cron（既有 5 条 → 8 条，`acme` 那条未受影响）

```cron
40 2 * * * /usr/bin/flock -n /opt/scqf-aftersales/backups/.cron-backup.lock /opt/scqf-aftersales/scripts/backup.sh
30 4 * * 0 /usr/bin/flock -n /opt/scqf-aftersales/backups/.cron-drill.lock /opt/scqf-aftersales/scripts/restore-drill.sh
0 9 * * * /opt/scqf-aftersales/scripts/watchdog.sh
```

`02:40` 与 `04:30` 刻意避开 acme 的 `03:17`（两者都会吃 I/O，且备份不该和证书续期抢窗口）。
crontab 已备份：`/opt/scqf-aftersales/backup/crontab-root-pre-backup-20261022.bak`（5 行，600）。

---

## 四、验证（含 4 个反向用例）

### 4.1 正向：备份真的产出可用包

```
pg_dump 完成 3771150B → TOC 1068
媒体完成：610 个文件 → 23730461B
密钥完成 aes=c4ec6e99…（与 P4-B 迁移时记录的 aes_key 哈希**一致**）
bundle 大小 21908096B
解包校验通过：db.dump keys/ keys/aes_key.dat keys/instance-id manifest.txt media.tar.zst
包内媒体条目: 2250（= 610 文件 + 1640 目录）
```

`manifest` 里记录 `sms_enabled = false` —— 这条很重要：**恢复后如果这个值是 true，切库就会真发短信**（P4-B 踩过）。

### 4.2 正向：恢复演练真恢复并逐表比对

```
演练对象：daily/scqf-backup-20261022-125033.tar.zst.enc
aes_key 与清单一致
pg_restore 完成
计数一致 customer_medias  = 551
计数一致 service_settings = 26
计数一致 service_tickets  = 489
计数一致 sms_logs         = 783
计数一致 stores           = 10
计数一致 ticket_events    = 1827
计数一致 users            = 11
共校验 7 张表
媒体条目一致：包内 2250 ≥ 清单 610
=========== 恢复演练成功 ===========
```

演练临时库 `scqf_restore_drill` 结束后已自动 `drop`（复查：库列表只有
`scqf_aftersales` / `scqf_aftersales_candidate` / `scqf_aftersales_rehearsal`，无残留）。

### 4.3 反向：**断言必须会变红**（这是本轮最关键的一段）

| 用例 | 构造 | 期望 | 实测 |
|---|---|---|---|
| A | 删掉 `status/last-run.json` | watchdog 退出 1 + 告警 | ✅ `exit=1`，`从未成功备份过（…不存在）` |
| B | 把状态文件 mtime 改到 3 天前 | watchdog 退出 1 + 告警 | ✅ `exit=1`，`最近成功备份已 72 小时（阈值 26h）`；复原后 `exit=0` |
| C | 复制最新包、改 1 字节，但 `.sha256` 仍记原值 | 跳过坏包、用下一个好包 | ✅ 日志 `跳过校验失败的包：…235959…`，最终 `exit=0` |
| D | 把所有包移走 | 硬失败 + 告警 | ✅ `exit=1`，`找不到任何通过 sha256 校验的备份包`；复原后 `exit=0` |

**这一段是必须的**：如果只测正向，等于验证了"一切都好"这句话——而它在真出事那天不会告诉你任何事。

### 4.4 最小环境实跑（模拟 cron，`PATH=/usr/bin:/bin`）

```
env -i PATH=/usr/bin:/bin HOME=/root backup.sh        → exit=0
env -i PATH=/usr/bin:/bin HOME=/root restore-drill.sh → exit=0
env -i PATH=/usr/bin:/bin HOME=/root watchdog.sh      → exit=0
```

cron 里最常见的坑是 PATH 差异（脚本在交互 shell 能跑、cron 里找不到命令）。
所有依赖（`docker zstd openssl flock mail tar find stat df du`）实测都在 `/usr/bin`。

---

## 五、实施中修掉的 3 个真 Bug（都出在我自己的校验逻辑里）

> 这一节留着，是因为"验证器自己也会错，而且错得比产品更隐蔽"。

### Bug 1：清单里写的是**别名**，演练却当**表名**用

`manifest` 里 `table_counts` 原本记 `events=1827` / `medias=551`，但真实表名是
`ticket_events` / `customer_medias`。演练直接 `select count(*) from events` → 报错。

**修法**：清单标签一律改用**真实表名**（`service_tickets` / `ticket_events` / …）。
代价是可读性略降，换来的是"清单可被机器直接执行"。

### Bug 2：`set -e` 让"计数查询失败"变成**静默退出**

`got=$(docker exec … psql …)` 失败时，整个脚本直接退出，**一条"计数不符"都不打印**。
表现是"演练跑了一下就没了"，比报错更难查。

**修法**：`got=$(… || true)`，并显式区分 `<查询失败>` 与"计数为 0"。

### Bug 3：awk 规则顺序把 7 张表缩成 1 张（最阴的一个）

```awk
f&&/^  /{gsub(/^ +/,"");print}   f&&!/^  /{f=0}
```

`gsub` 先改写 `$0`，紧接着的 `!/^  /` 立刻成立 → `f` 被关掉。
结果**只输出第一行**：演练"通过"，但实际只校验了 7 张表里的 1 张。

**修法**：打印后 `next`；并把这段解析抽成**唯一函数** `manifest_counts()`
（原来同一段 awk 写了两遍 —— 同一个坑有两条腿），再加一条硬闸门
`CHECKED >= 5`，防止"只验 1 张也算过"。

### 另外两个小修正

- 状态文件里的 `backup_dir_size` 曾把 `.staging` 算进去（89M vs 实际 63M）→ 加 `--exclude=.staging`。
- `expires 30d` 与 `add_header Cache-Control` 叠加会发**两个** Cache-Control（任务一修复项）。

---

## 六、恢复操作手册（出事时照着做）

```bash
# 1. 选包（先验完整性，别用"看起来最新"的那个）
cd /opt/scqf-aftersales/backups/daily
sha256sum -c scqf-backup-<ts>.tar.zst.enc.sha256

# 2. 解密解包到临时目录
mkdir -p /tmp/restore && cd /tmp/restore
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass file:/opt/scqf-aftersales/backups/.backup.key \
  -in /opt/scqf-aftersales/backups/daily/scqf-backup-<ts>.tar.zst.enc \
  | zstd -d | tar -xf -

# 3. 恢复数据库（先建空库，绝不覆盖在跑的库）
docker exec scqf-as-postgres psql -U scqf_as -d postgres -c "create database scqf_aftersales_restore;"
docker exec -i scqf-as-postgres pg_restore -U scqf_as --no-owner --no-privileges \
  -d scqf_aftersales_restore < db.dump

# 4. 比对清单里的 table_counts（必须逐表相等）

# 5. 恢复媒体（注意：这是**覆盖**动作，先备份现值）
tar --zstd -xf media.tar.zst -C /www/scqf-as-media

# 6. 恢复密钥（必须与库同版本，否则加密字段解不开）
#    keys/aes_key.dat → 容器内 /app/nocobase/storage/apps/main/
```

---

## 七、必须由用户决策的 3 件事（未做，不冒充完成）

### 7.1 异地副本（最高优先）

服务器上目前**没有任何对象存储凭据、没有对端主机**，所以异地无法实施。可选方案（按实施难度排序）：

| 方案 | 做法 | 代价 | 备注 |
|---|---|---|---|
| **A. 腾讯云 COS**（推荐） | 建桶 + 子账号密钥 → `coscli`/`rclone` 同步 `daily/` | 21 MB/天，费用极低 | 同云内网传输快；需开子账号最小权限 |
| B. 宝塔「计划任务 → 备份到 COS/OSS」 | 面板内置 | 需面板绑定密钥 | 与现有脚本**并行**会重复，建议二选一 |
| C. rsync 到另一台主机 | SSH 免密 + `rsync -a --delete` | 需对端机器 | 异地性取决于对端位置 |

**建议 A**：脚本已把产物收敛成"单文件 + .sha256"，`rclone copy` 一行就能同步，
且失败可重试、可按天增量。**未执行，等你指定桶与授权方式。**

### 7.2 告警外发通道

现状：`postfix` 只监听 `127.0.0.1:25`，`mail root` 只写进本机 `/var/mail/root` —— **没有人会看**。
脚本已内置钩子：把 webhook 地址写进

```bash
/opt/scqf-aftersales/backups/.alert-webhook     # 一行 URL，600
```

即会以企业微信/钉钉机器人 `{"msgtype":"text",...}` 格式推送。
**未配置，因为我没有你的机器人地址。**

### 7.3 密钥离线保管（**现在就该做**）

```bash
# 在你自己的终端里执行（本会话不打印密钥）
cat /opt/scqf-aftersales/backups/.backup.key
```

把这一行存进密码管理器 / 纸质保险柜。**丢了它 = 所有备份永久打不开**；
它与备份同盘，所以"盘挂"时它也会一起没。

---

## 八、遗留与下一步

- **P6-BK-01**（阻塞容灾）：异地副本未实施 — 见 7.1
- **P6-BK-02**：外部告警通道未接 — 见 7.2
- **P6-BK-03**：密钥离线副本待用户保存 — 见 7.3
- **P6-BK-04**：首次"真续期"验证 —— 12-21 acme 续期后需人工确认 `reloadcmd` 生效
- 旧的手工备份 `/opt/scqf-aftersales/restore-staging/`（191 MB，7 份）**原样保留未删**，
  它是 P4 阶段的取证材料；确认新链路稳定后再由用户决定是否清理。

---

## 九、判定

**任务二 = PASS（本地闭环） / 容灾 = HOLD（等资源，不是等技术）**

- 自动化、加密、校验、保留期、容量闸门、恢复演练、看门狗**全部实测通过**，且反向用例会真的变红。
- 未 commit / 未 push（这些文件都在服务器 `/opt`，不在 Git 工作区）。
- 未删除任何既有备份，未改动生产数据。
