# P6 正式上线后稳定性与剩余门禁报告

> 日期：2026-10-22 · **P6：LIVE / CONDITIONAL ACCEPTANCE 维持**（关键缺口未消除）
> Release：**继续 HOLD**。未 commit / push。

---

## 1. 公网服务可用性

| 检查 | 结果 |
|---|---|
| `https://sh.scqfls.cn/` | **200**，`ssl_verify=0`（证书链校验通过） |
| `http://sh.scqfls.cn/` | **301** → https |
| 证书 SAN | `DNS:sh.scqfls.cn` |
| 容器 | `scqf-as-app` / `scqf-as-postgres` **Up** |

---

## 2. 权限正向与反向测试

### 已验（P4-B 阶段，S04 合成账号）

| 项 | 结果 |
|---|---|
| S04 读历史档案 | `total=0`（只看到自己门店） |
| **伪造 `storeCode=S01`** | **`total=0`（伪造无效）** |
| S04 读工单列表 | **`No permissions`** |
| S04 跨店转单 | **403** |
| 匿名读档案 | **401** |
| 匿名读工单 | **401** |

### ⚠️ 仍然 PENDING（三项，**不标 PASS**）

| # | 项 | 原因 |
|---|---|---|
| 1 | **合法门店账号读自己门店工单** | 缺 `hl@` / `kl@` 口令；未猜、未重置 |
| 2 | **门店列表实际过滤（N 条 vs 489）** | `No permissions` 只证明"没权限"，**不证明"过滤生效"** |
| 3 | **HQ / viewer 独立反例** | 缺口令 |

**这三项是 Release 的关键门禁。** 我没有用 admin 冒充门店用户来"制造 PASS"。

---

## 3. H5 实际提交与媒体链路

### 已验（公网实测）

| 项 | 结果 |
|---|---|
| 门店入口（合法签名） | **200**，返回门店公开字段 |
| 门店入口（无效 / 无签名） | **404 / 404** |
| 媒体（无 session） | **401** |
| 媒体（伪造 session） | **404** |
| 媒体（过期 session） | 404（P4-B 已验） |
| 开发端点 ×5 | **404** |

### ⚠️ PENDING：**MEDIA-SESSION-BOUND-01**

**未做**：「建会话 → 同会话上传合成媒体 → 同会话读取 → 200」。

**未做**：报修/投诉的**真实提交**（需要业务写入 + 可精确清理的合成数据 + 你的授权）。

**没有**改 `customer_medias.session_id`、没续期真实客户会话、没绕 `readBound`。

---

## 4. 证书续期部署机制（**本轮核实，发现一个好消息**）

### 4.1 Nginx 二进制一致性 —— **同一实例，没有踩坑**

| 检查 | 结果 |
|---|---|
| `readlink -f /usr/bin/nginx` | **`/www/server/nginx/sbin/nginx`** |
| `readlink -f /www/server/nginx/sbin/nginx` | `/www/server/nginx/sbin/nginx` |
| **两个文件 sha256** | **完全相同**（`d9a18f3635a6be46`） |
| 运行中 master pid | **776** |

⇒ **reloadcmd 指向的就是宝塔在用的那个 nginx**，不存在"reload 错实例"的问题。

（inode 不同是因为 `/usr/bin/nginx` 是**软链**，不是两个二进制。）

### 4.2 证书序列号一致性 —— **一致**

| 来源 | 序列号 |
|---|---|
| 磁盘 `/opt/scqf-aftersales/certs/fullchain.pem` | **`053FC8D59C03CC4ECD65574EA9B4863D9B94`** |
| acme.sh 源 `/opt/acme-data/sh.scqfls.cn_ecc/fullchain.cer` | **`053FC8D59C03CC4ECD65574EA9B4863D9B94`** |

⇒ **线上跑的就是签发的那张证书。**

### 4.3 reloadcmd

```
/usr/bin/nginx -t >/opt/scqf-aftersales/certs/reload.log 2>&1 \
  && /usr/bin/nginx -s reload >>/opt/scqf-aftersales/certs/reload.log 2>&1
```

- **先 `-t` 后 reload**（配置不过就不 reload）
- 日志 **600**
- **实测触发过**：`Reload successful`

### 4.4 cron

| 项 | 值 |
|---|---|
| 条数 | **1**（`acme.sh --cron`） |
| 时间 | 每日 **03:17** |
| 锁 | `flock -n /opt/acme-data/.renew.lock` |

### ⚠️ 4.5 失败可发现性：**不足（PENDING）**

现在 reload 失败会写进 `reload.log`，但**没有任何告警机制**。

**没有人会主动看那个日志** ⇒ 如果 12-21 续期时 reload 失败，**会静默发生**。

**这是 Release 前必须补的**：加一条监控/告警（哪怕只是 cron 里 `|| echo` 到某个会被看到的通道）。

---

## 5. 备份及可恢复性

### 现状（7 份都在）

| 文件 | 大小 |
|---|---|
| `svc-p4a.dump`（源库备份） | 3.6 MB |
| `p4b-media.tgz`（源媒体） | 86 MB |
| `p4b-keys.tgz`（AES + instance-id） | 794 B |
| `empty-snapshot.dump`（空系统快照） | 433 K |
| `rehearsal-immutable.dump`（恢复证据） | 3.6 MB |
| `cand-before-test.dump` | 3.6 MB |
| `empty-media-backup.tgz` | 180 B |

### ⚠️ 缺的（**PENDING**）

| # | 项 | 说明 |
|---|---|---|
| 1 | **定期自动备份** | 现在全是**手工一次性**的，**没有定时任务** |
| 2 | **独立于本服务器的异地备份** | 全部在同一台机器的 `/opt/scqf-aftersales/restore-staging/` |
| 3 | **加密** | 备份是明文 tar.gz |
| 4 | **恢复演练** | 只在 `_rehearsal` 验过一次，**没有定期演练** |
| 5 | **增量保全策略** | 上线后新数据如何单独保全，**只有方案没落地** |

**这 5 项是 Release 的硬性缺口。** 现在如果服务器磁盘挂了，**数据和备份一起没**。

---

## 6. 真实业务新增记录与系统健康

### 关键发现：**还没有真实用户进来**

| 项 | 值 |
|---|---|
| `service_tickets` | **489**（= 迁移基线） |
| `ticket_events` | **1827** |
| `customer_medias` | **551** |
| `sms_logs` | **783** |
| **最近工单** | **2026-10-19 18:09**（3 天前） |
| **近 2 小时新增** | **0 工单 / 0 事件** |

⇒ **上线后 5 分钟内无真实写入**，系统处于"已开放但无人使用"状态。

### 健康

| 项 | 状态 |
|---|---|
| 应用 | Up，`/api/app:getInfo` 200 |
| PostgreSQL | Up，容器 healthy |
| `sms.enabled` | **false** |
| 媒体 | **610** 文件 |
| 磁盘 / 内存 | 152 G 可用 / 5.4 G 可用（P5 时实测，本轮未复测） |

---

## 7. 短信保持禁用的证据

| 项 | 值 |
|---|---|
| `SMS_ENABLED` | **false** |
| DB `sms.enabled` | **false** |
| `SMS_PROVIDER` | `smsbao`（**无凭据**） |
| `sms_logs` | **783 → 783（0 新增）** |

**双重门禁都在。** 且 `provider.send` 全项目只有 1 个调用点、4 个调用处都有 `enabled` 门禁（P4-A 已核）。

---

## 8. 原有网站运行状态

| 域名 | 结果 |
|---|---|
| `hd.scqfls.cn` | **200** |
| `cloud.scqfls.cn` | **403** |
| `sd.scqfls.cn` | **000**（既有） |
| `kanma.cloud` | **000**（既有） |

**与基线完全一致。** 未重启 Nginx、未动 MySQL/Docker daemon。

---

## 9. 所有尚未消除的风险

| # | 风险 | 级别 | 影响 |
|---|---|---|---|
| 1 | **门店权限正向/列表过滤/HQ/viewer 未验** | **高** | 无法证明"跨店不泄漏" |
| 2 | **媒体有效会话读取未验** | 中 | 无法证明"客户上传后能看到自己的图" |
| 3 | **备份无自动、无异地、无加密** | **高** | 磁盘故障 = 数据与备份同归于尽 |
| 4 | **续期失败无告警** | 中 | 12-21 续期失败会静默 |
| 5 | **真实提交路径未验** | 中 | 报修/投诉能否成功建单未证 |
| 6 | **短信不可用** | 中 | 通知发不出（业务不受阻） |
| 7 | **32 条孤儿工单** | 低 | 已登记，未改 |
| 8 | 镜像 `RepoDigests` 缺失 | 低 | 无法按 digest 追溯 |
| 9 | 插件挂载可写 | 低 | 建议改 `:ro` |

---

## 10. 是否具备 Release 最终签收条件

**不具备。**

### 必须补的四项（缺一不可）

| # | 门禁 | 怎么做 |
|---|---|---|
| **A** | **门店权限正向验证** | 提供 `hl@scqfls.cn` 或 `kl@scqfls.cn` 口令（或授权重置其中一个），验证"列表返回 N 条且 N < 489" |
| **B** | **HQ / viewer 反例** | 同上，`uat.hq@` / `uat.viewer@` 口令 |
| **C** | **媒体端到端 + 真实提交** | 授权在 candidate 建 1 个合成会话 + 1 张合成工单，走完整上传/读取/提交链，完后按 ID 精确清理 |
| **D** | **备份自动化 + 异地** | 至少：每日 `pg_dump` + 媒体 tar，落到**另一台机器或对象存储**，且加密 |

**A/B 只需要口令；C/D 需要授权。**

---

## 11. 判定

| 项 | 结论 |
|---|---|
| 公网可用性 | **PASS** |
| 证书二进制/序列号一致性 | **PASS**（本轮新查，排除了"reload 错实例"的风险） |
| reloadcmd 机制 | **PASS**（手动触发成功） |
| 续期失败告警 | **PENDING** |
| 匿名拒绝 | **PASS** |
| 跨店/伪造 storeCode | **PASS**（S04 反例） |
| **门店权限正向 / 列表过滤 / HQ / viewer** | **PENDING** |
| **媒体端到端** | **PENDING** |
| **真实提交** | **PENDING** |
| 短信禁用 | **PASS** |
| 数据完整性 | **PASS**（489/124/26/1827/279/551/725，零新增） |
| 四站点 | **PASS** |
| **备份自动化/异地/加密** | **PENDING** |

### 申请

**P6：维持 LIVE / CONDITIONAL ACCEPTANCE。**
**Release：继续 HOLD。**

**不申请 FINAL ACCEPTANCE** —— 四项硬门禁（A/B/C/D）未过。

**上线是成功了的**（能访问、能认证、媒体不泄漏、数据完整、其他站点无影响），
**但"能不能安全地长期运营"这件事还没验完**，特别是**备份**和**门店权限隔离**。

在你补齐 A/B 的口令、或授权 C/D 之后，我可以一次性把剩余门禁跑完。
