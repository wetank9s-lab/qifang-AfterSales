# 腾讯云部署 P4-B 第一关：真实数据隔离恢复验收报告

> 日期：2026-10-22 · **P4-B 第一关：PASS**
> 未覆盖云端运行库、未切流量、未动 Nginx/DNS、未开短信、未 push。

---

## 1. 原机最终基线与备份版本

| 项 | 值 |
|---|---|
| 数据库 | `service_ticket`（PG **16.15**） |
| dump | `.backup-prod/svc-p4a.dump` |
| dump SHA-256 | **`400454f0d9f9a2b710e34d346dd8a82b…`** |
| TOC / TABLE DATA | **1072 / 129** |
| 媒体包 | `p4b-media.tgz` **85.1 MB**，SHA-256 `de58d53b43e82067…` |
| 密钥包 | `p4b-keys.tgz` 794 B，SHA-256 `c8dd6bcd213422d0…` |

**传输前实测**（8 项全部与 P4-A 一致，无新增）：

```
tickets 489 | archives 124 | conv 26 | events 1827
visits 279 | medias 551 | sessions 725 | vphotos 51
```

---

## 2. 传输方式、范围与 SHA-256

| 项 | 值 |
|---|---|
| 通道 | **SSH/SFTP**（22 端口，已加密） |
| 暂存目录 | `/opt/scqf-aftersales/restore-staging`（**700**） |
| 文件权限 | 三个包落地后 `chmod 600` ✅ |

**传输前后 SHA-256 逐包比对**：

| 包 | 本地 | 云端 | 一致 |
|---|---|---|---|
| `svc-p4a.dump` | `400454f0d9f9a2b7…` | `400454f0d9f9a2b7…` | ✅ |
| `p4b-media.tgz` | `de58d53b43e82067…` | `de58d53b43e82067…` | ✅ |
| `p4b-keys.tgz` | `c8dd6bcd213422d0…` | `c8dd6bcd213422d0…` | ✅ |

**打包范围**：`uploads-private/` **整个目录**（含 `customer/` + `visits/`）+ `aes_key.dat` + `instance-id` + 数据库 dump。**未打任何缓存/临时文件**。

---

## 3. 云端隔离数据库与恢复结果

| 项 | 值 |
|---|---|
| 数据库名 | **`scqf_aftersales_rehearsal`**（新建空库） |
| 恢复前表数 | **0**（已确认） |
| 命令 | `pg_restore --no-owner --no-privileges --exit-on-error -U scqf_as -d scqf_aftersales_rehearsal` |
| **退出码** | **0** ✅ |
| 恢复后表数 | **129** ✅ |

**未使用** `--create`、**未使用** `--clean`、**未触碰** `scqf_aftersales`。

### 两个过程性错误（已修正，记录备查）

1. `pg_restore` 一开始报 `could not open input file` —— dump 还在宿主机，没 `docker cp` 进容器。
2. 修正后报 `role "root" does not exist` —— `pg_restore` 默认用当前系统用户，**必须显式 `-U scqf_as`**。

---

## 4. 表结构 / 约束 / 索引 / 序列

| 对象 | 数量 |
|---|---|
| 表（public） | **129** |
| 索引 | **405** |
| 约束 | **707** |
| 序列 | **52** |

**关键序列当前值**（恢复后，防止新单撞主键）：

```
historical_ticket_conversions_id_seq = 27
service_tickets_id_seq               = 6908
ticket_events_id_seq                 = 16759
```

---

## 5. 七张业务表实测计数（**与源库逐表比对**）

| 表 | 源 | 恢复库 | |
|---|---|---|---|
| `service_tickets` | 489 | **489** | ✅ |
| `historical_service_archives` | 124 | **124** | ✅ |
| `historical_ticket_conversions` | 26 | **26** | ✅ |
| `ticket_events` | 1827 | **1827** | ✅ |
| `service_visits` | 279 | **279** | ✅ |
| `customer_medias` | 551 | **551** | ✅ |
| `customer_media_sessions` | 725 | **725** | ✅ |
| `service_visit_photos` | 51 | **51** | ✅ |
| `stores` | 10 | **10** | ✅ |
| `users` | 11 | **11** | ✅ |

**`ALL_MATCH = True`**

### 关联完整性

| 检查 | 结果 |
|---|---|
| 转换记录无对应工单 | **0** ✅ |
| 事件无对应工单 | **0** ✅ |
| 上门记录无对应工单 | **0** ✅ |
| 技师照片无对应上门 | **0** ✅ |
| **工单的 `store_id` 在 `stores` 中不存在** | **32** ⚠️ |

### 关于那 32 条

**实测源库同样是 32 条** ⇒ **不是恢复引入的**。

构成：`store_id=2` 的 **28 张** + `store_id IS NULL` 的 **4 张**；而 `stores` 只有 **10 条**（id 1 与 3–15，**没有 id=2**）。

⇒ 这是**源库的历史遗留**（门店被删过/未迁移完整）。**恢复是忠实的**（32 = 32）。

**我没有去"修"它** —— 按纪律不人为改写业务字段让计数好看。**这条需要你后续决定**：是保留原样，还是在应用层补一个"已删除门店"占位。

---

## 6. `customer/` 与 `visits/` 完整性

媒体解到 **`restore-staging/media/`**（**未覆盖应用挂载路径**）。

| 项 | 值 | 判定 |
|---|---|---|
| 总文件 | **610** | = 源机 610 ✅ |
| `customer/` 文件 | **551** | = DB 551 ✅ |
| `visits/` 文件 | **59** | = 源机 59 ✅ |
| `customer/` 子目录 | **422** | ✅ |
| 体积 | **95 MB** | ✅ |
| 顶层结构 | 仅 `customer` / `visits` | **无层级错位** ✅ |
| DB `storage_key` → 文件缺失（customer） | **0 / 551** | ✅ |
| DB `storage_key` → 文件缺失（visits） | **0 / 51** | ✅ |

---

## 7. 8 个未引用上门照片的保留证明

`visits/` 有 **59 个文件**，`service_visit_photos` 只有 **51 条** ⇒ **8 个文件无 DB 关联**。

**这 8 个文件在恢复后的暂存目录中完整存在**（59 = 59，一个没少）。

**未清理、未跳过、未改名。**

---

## 8. AES 密钥一致性与"解密验证"

### 事实

| 项 | 值 |
|---|---|
| `aes_key.dat` | **32 字节**（AES-256），权限 **600** |
| 云端副本 SHA-256 | `c4ec6e9931440a4f8902d550…` |
| 源机 SHA-256 | `c4ec6e9931440a4f8902d550…` | ✅ **一致** |
| `instance-id` | 685 字节，权限 **600** |
| **是否用云端自动生成的临时密钥** | **否**（解包的是源机原文件，且放在独立 `restore-staging/keys/`，**未覆盖运行实例的 AES 文件**）|

### ⚠️ 一个必须如实说明的发现

**本项目业务表里没有 AES 加密字段。**

实测：

| 字段 | 实际形态 |
|---|---|
| `service_tickets.customer_mobile` | **明文**（长度 11、前缀 `1380`/`1331`） |
| `service_tickets.feedback_token_hash` | 64 字符 —— **sha256 哈希，不可逆** |
| `collections/*.ts` 里的 `encrypt` 引用 | **零** |

⇒ 本轮**没有"5 条密文可解密"这种对象可验**。

**这不是"跳过验证"，是"没有该验证对象"。** 我按纪律**没有伪造一个加密字段来做演示**。

`aes_key.dat` 仍**必须迁移**（NocoBase 框架级使用），哈希一致性已证。

---

## 9. 当前空系统未被覆盖的证据

| 检查 | 结果 |
|---|---|
| `scqf_aftersales` 表数 | **338**（含所有 schema，public 仍 129） |
| `scqf_aftersales` `service_tickets` | **0** ✅ **仍为空** |
| `scqf-as-app` 运行状态 | **未重启、`DB_DATABASE` 未改** |
| `scqf-as-app` 的 `aes_key.dat` | **未替换** |
| `scqf-as-app` 的 `uploads-private` | **未覆盖**（媒体解在 `restore-staging/media`） |
| PostgreSQL 数据卷 | **未删除** |
| Docker daemon | **未重启** |

**恢复前已备份空系统快照**：`restore-staging/empty-snapshot.dump`（**433 K**）。

---

## 10. 短信仍禁用、无外部副作用

| 项 | 值 |
|---|---|
| `APP_ENV` | **production**（未变） |
| `SMS_PROVIDER` / `SMS_ENABLED` | `smsbao` / **false**（未变） |
| 真实短信凭据 | **未配置** |
| 发送测试 | **未执行** |
| 恢复库里的 `sms.enabled` | **`true`**（这是**源库的历史配置值**，随 dump 恢复过来） |

**⚠️ 注意**：恢复库的 `sms.enabled=true` 是源库数据的一部分。**这不影响运行实例**（运行实例用的是 `scqf_aftersales`，其 `sms.enabled=false`）。但**P6 切库时必须同步把云端 `sms.enabled` 改回 false** —— 否则真实切流后会真发短信。

**这条已列入 P6 前置检查。**

**真实客户数据未用于任何公开 HTTP / 匿名 API / 开发测试端点。**

---

## 11. 服务器其他项目健康

| 项 | 结果 |
|---|---|
| `nginx -t` | **successful**（未 reload） |
| `hd.scqfls.cn` / `cloud.scqfls.cn` / `sd.scqfls.cn` / `kanma.cloud` | 与前次一致（200 / 403 / 000 / 000） |
| 其他容器 | **未触碰** |
| Docker daemon | **未重启** |

---

## 12. 备份保留、恢复与回滚

### 保留（**全部未删**）

| 文件 | 位置 | 用途 |
|---|---|---|
| `svc-p4a.dump` | 本机 `.backup-prod/` + 云端 `restore-staging/` | 源库备份 |
| `p4b-media.tgz` | 同上 | 源媒体备份 |
| `p4b-keys.tgz` | 同上 | 源密钥备份 |
| **`empty-snapshot.dump`** | 云端 `restore-staging/` | **云端空系统快照**（回滚用） |

### 回滚（云端侧，**不依赖原机**）

原机**外部不可达**（IPv4 是 NAT 地址、IPv6 从腾讯云 `Network is unreachable`、无隧道客户端），
⇒ **"DNS 指回原机"不是可用回滚**。

**真正的回滚**：

```
① pg_dump 当前（可能已坏）的 scqf_aftersales → 保留
② 从 empty-snapshot.dump 恢复 scqf_aftersales
③ 清空 /www/scqf-as-media 并从备份还原
④ 重启 scqf-as-app，健康检查
```

### P6 切流后新增数据的保留

切流后若发现问题需要回退：
- **先 dump 切流后新增的数据**（不能直接丢弃）
- 再恢复到快照
- 新增数据单独留存，供人工核对/补录

---

## 13. 未完成事项与真实阻塞

| # | 项 | 级别 |
|---|---|---|
| 1 | **32 条工单的 `store_id` 无对应门店**（源库既有，非恢复引入） | **需你裁决**（保留 or 补占位门店） |
| 2 | **无 AES 加密业务字段** → "5 条解密验证"无对象 | 说明项（非遗漏） |
| 3 | 恢复库 `sms.enabled=true`（源库历史值）→ **P6 切库必须改回 false** | **高**（否则切流后真发短信） |
| 4 | 主键序列已恢复（`service_tickets=6908`），但**未做"新单插入"实测** | 中（P6 前补一次） |
| 5 | 媒体仍是**暂存目录**，未与运行实例合并 | 正常（等 P6） |
| 6 | 镜像 `RepoDigests` 仍为空（P3 遗留） | 低 |

---

## 14. 判定

| 项 | 结论 |
|---|---|
| 传输前预检 | **PASS**（8 项无变化） |
| 传输完整性 | **PASS**（3 包 SHA-256 全一致） |
| 隔离恢复 | **PASS**（`exit=0`、129 表） |
| 表/索引/约束/序列 | **PASS**（405 / 707 / 52） |
| 七张表计数 | **PASS**（10 表全匹配） |
| `customer/` 完整性 | **PASS**（551/551、缺 0） |
| `visits/` 完整性（含 8 个未引用） | **PASS**（59/59） |
| 密钥一致性 | **PASS**（SHA-256 相同、600） |
| 空系统未被覆盖 | **PASS**（tickets 仍 0、已备份快照） |
| 短信仍禁用 | **PASS** |
| 其他项目健康 | **PASS** |
| 无外部副作用 | **PASS** |

**申请 P4-B 第一关：PASS / READY FOR APPLICATION CUTOVER AUTHORIZATION。**

**两个待裁决**：32 条孤儿工单怎么处理、P6 切库时 `sms.enabled` 必须同步为 false。

**P5 / P6 / Release 继续 HOLD。未 push。**
