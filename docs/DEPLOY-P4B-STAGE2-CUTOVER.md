# 腾讯云部署 P4-B 第二关：真实业务数据受控接管验收报告

> 日期：2026-10-22 · **P4-B 第二关：PASS（1 项 PENDING）**
> 未改 rehearsal 原库、未切流量、未动 Nginx/DNS、未开短信、未 push。

---

## 1. P4-B 第一关媒体 SHA-256 补证（**已补齐**）

| 项 | 结果 |
|---|---|
| 源机文件数 | **610** |
| 云端暂存文件数 | **610** |
| **路径集合完全一致** | **True** |
| 仅源机有 / 仅云端有 | **0 / 0** |
| **逐文件 SHA-256 不一致** | **0** ✅ |
| `customer/` | **551** ✅ |
| `visits/` | **59** ✅（含 8 个未引用） |

**⇒ P4-B 第一关正式 PASS。**

---

## 2. 库与备份状态（三个层次，互不覆盖）

| 库 | 用途 | 状态 |
|---|---|---|
| `scqf_aftersales` | 空系统 | **未动**，`tickets=0` |
| `scqf_aftersales_rehearsal` | **不可变恢复证据** | **只读参考**，`sms.enabled` 仍 `true` |
| **`scqf_aftersales_candidate`** | **第二关工作库** | 从 rehearsal 恢复后仅改 1 条配置 |

**备份清单（全部保留）**：

| 文件 | 大小 |
|---|---|
| 本机 `svc-p4a.dump` | 3.6 MB |
| 本机 `p4b-media.tgz` | 85.1 MB |
| 本机 `p4b-keys.tgz` | 794 B |
| 云端 `empty-snapshot.dump` | 433 K |
| 云端 `rehearsal-immutable.dump` | 3.6 MB |
| 云端 `empty-media-backup.tgz` | 180 B（空媒体快照） |

---

## 3. 短信配置修改前后对照

**先查清了真实链路**（关键）：

```
getBool('sms.enabled')
  → getString() → service_settings 表
      → 有行 ⇒ 用 DB 值
      → 无行 ⇒ 用 seed（代码默认 'false'）
         → seedSettings 仅在首次初始化写入，已有行则 skip
```

⇒ **环境变量 `SMS_ENABLED` 只在"库里还没有这一行"时生效**。
⇒ **库里是 `true` 时，env 写 `false` 完全无效。**

### 修改记录（事务内，仅 1 条）

| | candidate |
|---|---|
| 改前 | `sms.enabled = true` |
| 语句 | `update service_settings set value='false' where key='sms.enabled'` |
| 结果 | `UPDATE 1` |
| 改后 | **`sms.enabled = false`** ✅ |
| `sercice_settings` 总行数 | **26**（改前改后一致，未误改其它） |

**rehearsal 原库仍为 `true`** —— 原始证据保留 ✅

---

## 4. 双重门禁结果

| 门禁 | 值 |
|---|---|
| 环境变量 `SMS_ENABLED` | **false** |
| 容器内实际 `$SMS_ENABLED` | **false** |
| 数据库 `sms.enabled` | **false** |
| `SMS_PROVIDER` | `smsbao`（无凭据） |
| `APP_ENV` | **production** |

**启动前后 `sms_logs` 增量：783 → 783（0 新增）**，最近一条仍是 **2026-10-19**（源库历史）。

**没有只凭日志判断**：`provider.send` 全项目只有 1 个调用点、4 个调用处都有 `sms.enabled` 门禁（P4-A 已核）。

---

## 5. 实际连接数据库

```
容器内实测：DB=scqf_aftersales_candidate
            SMS=false  PROV=smsbao  ENV=production
```

---

## 6. 应用与插件健康

| 项 | 结果 |
|---|---|
| `/api/app:getInfo` | **200** |
| healthcheck | **healthy** |
| 表数 | **129** |
| 插件 | `@local/service-ticket` **enabled** |
| 5 个开发端点 | **全部 404** ✅ |

---

## 7. 关键业务表（应用接管后）

| 表 | 值 |
|---|---|
| `service_tickets` | **489** |
| `historical_service_archives` | **124** |
| `historical_ticket_conversions` | **26** |
| `ticket_events` | **1827** |
| `service_visits` | **279** |
| `customer_medias` | **551** |
| `service_visit_photos` | **51** |

**最近事件时间：`2026-10-19 18:15`（源库原值，无新增）** ✅

---

## 8. 读取测试结果

| 测试 | 结果 |
|---|---|
| 登录（源库 admin `Super Admin`） | ✅ 成功（口令经 SFTP 临时文件传入，**用后立即删除**） |
| **工单列表** | ✅ **total = 489** |
| **历史档案查询** | ✅ **total = 124** |
| **已转换档案详情** | ✅ `archive 5` → `conversionState=converted`、`HA-20261012-5RSKB6`、S01 |
| 转换记录关联 | ✅ `5→FW20261012-0021`（工单存在）、`9→FW20261012-0022`、`11→FW20261012-0068` |
| **匿名查询档案** | ✅ **401** |
| **开发端点 ×5** | ✅ **404** |
| Canvas | ✅ 可用（`PROCESS_OK`） |
| **客户媒体读取** | ⚠️ **404** —— 见下 |

### 媒体 404 的真实原因（不是缺陷）

```
media 563 → customer/735/20c655d1365622d9.png，242884 字节
挂载点文件：          242884 字节  ← 完全匹配
session 735 expires_at = 2026-10-19 20:09  ← 3 天前已过期
```

⇒ **404 是会话过期后的正确拒绝**（安全策略生效），**不是文件丢失**。

**PENDING**：要验证"有效会话可读"，需要**新建一个 media session**（会写库）。按纪律本轮**没有写**。文件完整性已由 610 文件 SHA-256 全等证明。

---

## 9. 门店权限与匿名

| 测试 | 结果 |
|---|---|
| 匿名访问档案查询 | **401** |
| 跨店越权 | **未执行**（需要目标门店账号口令，我没有） |
| admin 访问 | 正常（489 / 124） |

**跨店测试记为 PENDING** —— 我没有 `hl@scqfls.cn` / `kl@scqfls.cn` 的口令，**不猜、不重置**。

---

## 10. DATA-STORE-ORPHAN-32 台账

| 项 | 值 |
|---|---|
| 编号 | **DATA-STORE-ORPHAN-32** |
| 数量 | **32** 条工单 |
| 构成 | `store_id=2` → **28 条**；`store_id IS NULL` → **4 条** |
| `stores` 实际 | **10 条**（id 1、3–15，**缺 id=2**） |
| 源库 vs 恢复库 | **一致（32 = 32）** |

**已按你的决定：全部原样保留。**

- 未新增虚构门店 ✅
- 未修改 28 条 `store_id=2` ✅
- 未修改 4 条 `NULL` ✅
- 未改 `stores` 表 ✅
- 未扩门店 ACL ✅

**业务影响待评估**：这 32 条在门店维度报表里可能落空（无门店可归属），需在 Release 审查时明确处置。

---

## 11. 业务写入 / 短信 / 外部副作用

| 项 | 结果 |
|---|---|
| 工单 | **489 → 489**（0 新增） |
| 事件 | **1827 → 1827**（最近 10-19） |
| 上门记录 | **279 → 279** |
| 短信日志 | **783 → 783**（最近 10-19） |
| 真实短信 | **0 发送** |
| 外部通知 | **无** |
| 登录会话 | 有写入（会话表），属登录副作用，**未混入业务表** |

---

## 12. 其他站点健康（**与基线完全一致**）

| 域名 | 结果 |
|---|---|
| `hd.scqfls.cn` | **200** |
| `cloud.scqfls.cn` | **403** |
| `sd.scqfls.cn` | **000**（既有） |
| `kanma.cloud` | **000**（既有） |
| `nginx -t` | **successful**（未 reload） |

**Nginx 未修改、DNS 未动、防火墙未动、Docker daemon 未重启、PostgreSQL 卷未动。**

---

## 13. 可执行的云端恢复步骤

```
# 回到空系统
docker exec scqf-as-postgres psql -U scqf_as -d postgres -c "drop database scqf_aftersales_candidate"
cd /opt/scqf-aftersales
cp -a .env.prod.bak-pre-cutover .env.prod          # DB_DATABASE 回 scqf_aftersales
cp -a docker-compose.prod.yml.bak-pre-cutover docker-compose.prod.yml
rm -rf /www/scqf-as-media/* && tar -xzf restore-staging/empty-media-backup.tgz -C /www
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --force-recreate app
```

---

## 14. 未完成 / PENDING

| # | 项 | 说明 |
|---|---|---|
| 1 | **媒体有效会话读取** | 所有历史 session 已过期；建新 session 会写库，未做 |
| 2 | **跨店越权验证** | 缺 `hl`/`kl` 账号口令，未猜未重置 |
| 3 | **32 条孤儿工单业务影响** | 已登记台账，待业务治理 |
| 4 | 镜像 `RepoDigests` | P3 遗留 |
| 5 | 插件挂载仍可写 | 建议稳定后改 `:ro` |

---

## 15. 判定

| 项 | 结论 |
|---|---|
| 媒体 SHA-256 补证 | **PASS**（610/610、0 不一致） |
| 库分层（空/证据/工作） | **PASS** |
| 短信配置修改 | **PASS**（true→false，UPDATE 1） |
| 双重门禁 | **PASS** |
| 应用接管 | **PASS**（candidate、200、healthy） |
| 插件 / 开发端点 | **PASS**（enabled、5×404） |
| 业务计数与关联 | **PASS**（489/124/26/1827/279/551/51） |
| 已转换档案关联 | **PASS**（conversionState=converted + 工单存在） |
| 匿名拒绝 | **PASS**（401） |
| 其它站点 | **PASS**（全一致） |
| 无业务写入 / 无短信 | **PASS** |
| **媒体有效会话读取** | **PENDING** |
| **跨店越权** | **PENDING** |

**申请 P4-B 第二关：PASS（附 2 项 PENDING）。**

**P5 / P6 / Release 继续 HOLD。未 commit / 未 push。**
