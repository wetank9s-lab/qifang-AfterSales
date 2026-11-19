# 腾讯云部署 P4-A：数据迁移准备与一致性备份报告

> 日期：2026-10-22 · **P4-A：PASS**
> 未传输任何真实数据、未改云端库、未迁密钥/媒体、未动 Nginx 或 DNS、未 push。

---

## 1. 源数据库基线（实测）

| 表 | 数量 |
|---|---|
| `service_tickets` | **489** |
| `historical_service_archives` | **124** |
| `historical_ticket_conversions` | **26** |
| `ticket_events` | **1827** |
| `service_visits` | **279** |
| `customer_medias` | **551** |
| `customer_media_sessions` | **725** |

**扩展**：仅 `plpgsql`（无 PostGIS 等特殊依赖）✅

---

## 2. 本地备份与完整性检查

| 项 | 值 |
|---|---|
| 格式 | `pg_dump -Fc`（自定义格式，gzip） |
| 路径 | `.backup-prod/svc-p4a.dump`（目录 `chmod 700`） |
| 开始 / 结束 | **2026-10-22T11:20:45+0800 → 11:20:45+0800**（同一秒） |
| 大小 | **3.6 MB** |
| SHA-256 | **`400454f0d9f9a2b710e34d346dd8a82b…`** |
| 归档可读 | ✅ `pg_restore -l` 正常，**TOC Entries 1072** |
| TABLE DATA 条目 | **129**（与云端 129 表一致） |

**并发写入**：备份瞬间源库**无写入**（见 §6），因此库快照内部一致；但**库与媒体快照仍有理论时间差**（见 §6）。

---

## 3. 私有媒体清单与关联核查

| 项 | 值 |
|---|---|
| `customer_medias` | **551** |
| `customer_media_sessions` | **725** |
| `customer/` 文件数 | **551** |
| `customer/` 子目录 | **422** |
| `visits/` 文件数 | **59** |
| `visits/` 子目录 | **607** |
| 总体积 | **94 MB** |

### 关联核查

| 检查 | 结果 |
|---|---|
| `storage_key` 全部为 `customer/<id>/<hash>.<ext>` | ✅ 无例外 |
| **越界**（非 `customer/` 前缀） | **0** ✅ |
| **DB 有、文件缺** | **0 / 551** ✅ |
| `customer/*/*` 文件数 = DB 行数 | **551 = 551** ✅ |

### ⚠️ 两个必须带走的发现

**① `uploads-private` 下不只有客户媒体，还有 `visits/`（技师上门照片）**

`service_visit_photos` 有 **51 行**，`visits/` 下有 **59 个文件**。

⇒ **媒体快照必须整个 `uploads-private` 目录打包**，不能只打 `customer/`。只打 `customer/` 会**丢掉全部技师照片**。

**② `visits/` 有 8 个"未引用文件"**（59 文件 vs 51 记录）

可能是历史删除记录后残留。**不删，一并迁移** —— 它们占空间极小，删错无法恢复。

### 权限

目录与文件均 `root:root`；`/www/scqf-as-media` 云端为 `750`（`www` 不可读）。

---

## 4. AES 密钥与实例文件

| 文件 | 存在 | 权限 | 处理 |
|---|---|---|---|
| `storage/apps/main/aes_key.dat` | ✅ | **644 root:root** ⚠️ | **必须迁**（否则加密字段解不开） |
| `storage/.license/instance-id` | ✅ | **644 root:root** ⚠️ | **必须迁**（实例标识） |
| `.env` 的 `APP_KEY` | ✅ | 64 字符 | **保持原值** |
| `.env` 的 `SIGN_SECRET` | ✅ | 64 字符 | **保持原值**（已印二维码依赖） |

**⚠️ 权限问题**：两个密钥文件是 **644**（同容器内其他用户可读）。原机是单租户容器，风险有限；但**迁移到云端时应设 600**。

**一致性要求**：`aes_key.dat` 与数据库**必须是同一版本**。若库是从 A 时刻备份、key 是从 B 时刻取的，加密字段可能解不开。

⇒ 迁移时**两者同一批打包**，并在恢复后做**抽样解密验证**。

---

## 5. 目标数据库恢复方案（设计，未执行）

### 5.1 角色与所有权

`pg_dump -Fc` 默认**不含角色**（`--no-owner` 未加，但角色本身不在 dump 里）。

| 项 | 本机 | 云端 | 处理 |
|---|---|---|---|
| 库名 | `service_ticket` | `scqf_aftersales` | `pg_restore -d scqf_aftersales` |
| 用户 | `svc_app` | `scqf_as` | 恢复时加 **`--no-owner --no-privileges`**，避免 "role svc_app does not exist" |

### 5.2 扩展

仅 `plpgsql`（PG 内置）→ **无兼容问题**。

### 5.3 演练流程（**先用合成库，不用真实数据**）

```
① 云端建临时库 scqf_rehearsal（空）
② pg_restore --no-owner --no-privileges -d scqf_rehearsal <dump>
③ 校验 7 张表行数 + 序列 + 外键关联
④ 校验 NocoBase 插件表（applicationPlugins 里 service-ticket enabled=t）
⑤ 通过 → drop scqf_rehearsal
⑥ 失败 → 保留现场，报告差异，不动正式库
```

**本轮用完全合成的本地测试库演练工具链**（见 §12），**不传真实 dump**。

### 5.4 正式恢复（待 P4-B 授权）

```
① 云端现有空系统做快照：pg_dump scqf_aftersales → /opt/scqf-aftersales/dist/snapshot-empty.dump
② 媒体卷 scqf-as-media 做 tar 快照
③ drop + recreate scqf_aftersales（或 restore 到新库再改名）
④ pg_restore 真实 dump（--no-owner --no-privileges）
⑤ 校验（见 §7）
⑥ 媒体解包到 /www/scqf-as-media
⑦ 校验 storage_key 对应性
⑧ 重启 app，验证插件与页面
```

### 5.5 失败回退

**回退到 ① 的空系统快照**（恢复空库 + 空媒体目录），**不是回退到原机**（原因见 §9）。

---

## 6. 源端业务写入与最终同步策略

### 实测

| 项 | 值 |
|---|---|
| 近 1 小时新工单 | **0** |
| 近 1 小时新事件 | **0** |
| 近 1 小时新媒体文件 | **0** |
| **最后一张工单** | **2026-10-19 18:09:10 +08**（约 **3 天前**） |

### 判断

**源系统当前处于静止状态**（无真实用户在用）。

⇒ **库与媒体之间不存在实际写入差**，但**理论上仍可能有时差**（若备份期间有人上传）。

### 最终同步方案（P4-B 执行）

```
① 记录 T0：库备份完成时刻
② 记录 T1：媒体打包完成时刻
③ 若 T0≠T1 且期间有新文件 → 补一次增量（按 mtime 找出 T0 之后的新文件）
④ 校验：DB 的 storage_key 集合 == 媒体文件集合（双向）
⑤ 若两边集合不一致 → 停止，报告差异
```

**不自行停止原机应用**（按纪律）。若届时出现写入，我会**先报告再询问**是否需要一个短暂的写入冻结窗口。

---

## 7. 最终一致性标准（不只看 7 张表数量）

| # | 检查 | 方法 |
|---|---|---|
| 1 | 7 张表行数 | 逐个对比基线 |
| 2 | **主键序列** | `pg_get_serial_sequence` + `last_value` 对比（否则新单会撞主键） |
| 3 | **历史转单关联** | `conversions.ticket_id` 100% 能在 `service_tickets` 找到 |
| 4 | **门店归属完整性** | 所有 `store_id` 存在于 `stores`；`drill` 门店标记保留 |
| 5 | **加密字段可读** | 抽样 5 条客户手机号，用迁移后的 `aes_key.dat` 解密成功 |
| 6 | **媒体对应性** | `customer_medias.storage_key` ↔ 文件双向 100% |
| 7 | **技师照片** | `service_visit_photos.storage_key` ↔ `visits/` 文件 |
| 8 | **插件配置** | `applicationPlugins` 里 `service-ticket enabled=t`；`sms.enabled=false` |

**报告中的抽样结果一律脱敏**（只写"5/5 成功"，不写手机号）。

---

## 8. 密钥保护与传输方案

| 项 | 方案 |
|---|---|
| 传输通道 | **SSH/SFTP**（已加密），不走公网 HTTP |
| 打包 | 数据库 dump、`aes_key.dat`、`instance-id`、媒体 **分成 4 个独立包**，各自 sha256 |
| 本地存放 | `.backup-prod/`（`700`），**不入 Git、不在 wwwroot** |
| 云端落地 | `/opt/scqf-aftersales/dist/`（`750`），**密钥文件落地后立即 `chmod 600`** |
| 密钥与源码包 | **分开**（源码包已核对不含 `aes_key.dat` / `instance-id`） |
| 清理 | 恢复并验证通过后，删除云端 `dist/` 下的临时包 |

---

## 9. 回滚方案修正（**重要**）

### 事实核查

| 项 | 结果 |
|---|---|
| 原机 IPv4 公网 | `171.213.229.122` —— **运营商 NAT 后的地址，不是固定公网 IP** |
| 原机 IPv6 | `240e:39d:…` |
| **从腾讯云 ping6 / curl -6 探原机** | **`Network is unreachable` / `000`** |
| 隧道客户端（cloudflared/frpc/ngrok） | **无** |

**结论：原机当前外部不可达。`sh.scqfls.cn` 已指向腾讯云，把 DNS 指回原机也不会有人能访问。**

⇒ **"DNS 指回原机" 不是可用的回滚方案。**

### 修正后的回滚方案（云端侧）

| 阶段 | 动作 |
|---|---|
| **迁移前** | 对云端空系统做快照：`pg_dump scqf_aftersales` + `tar scqf-as-media` |
| **迁移后出错** | ① 恢复空库快照 ② 清空媒体目录并还原空快照 ③ 重启 app ④ 健康检查 |
| **若已有新数据** | **先 `pg_dump` 保存当前（虽然有问题）的库**，再回滚 —— 不丢任何数据 |
| **原机角色** | **冷备**：保留全部数据与容器，供人工取证/回搬（需先解决网络可达） |

### 关于 DNS TTL

`sh.scqfls.cn` TTL 是 **600 秒**，但这**不等于所有客户端 10 分钟内一定切换**：
- 运营商/Local DNS 可能缓存更久
- 已建立的连接不会立即断开
- 移动端可能有独立缓存

⇒ **任何切流动作都要按"至少 30 分钟观察窗口"设计**，不能假设 10 分钟就干净。

---

## 10. 生产短信禁用出口核查（**逐条确认**）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | `SMS_ENABLED=false` 是否阻断真实请求 | ✅ `SMS_ENABLED` → 配置项 `sms.enabled`；`deliverOne` 的**闸 1** 在 `!enabled` 时**直接记 rejected、不调 `provider.send`** |
| 2 | 是否绕过该开关 | ✅ `provider.send` **全项目只有 1 个调用点**（`safeSend`） |
| 3 | 定时重试/通知是否遵守同一开关 | ✅ **4 个 `safeSend` 调用点全部有 `enabled` 门禁**（首发 543 / 补发 1003 / 重试 `retryPending` 1155+1175） |
| 4 | `smsbao` 缺凭据时的行为 | 会返回 `SMS_PROVIDER_NOT_CONFIGURED` —— 但**根本走不到**（`enabled=false` 先拦） |
| 5 | 生产是否注册其它测试端点 | ✅ 5 个（`tokenCheck`/`smsOutbox`/`faultInject`/`smsRecoverySweep`/`historicalDrillFixture`）**全部 404** |

**未发任何真实短信**（`sms_logs=0`）。

---

## 11. APP_KEY 暴露事件复查

| 项 | 结论 |
|---|---|
| 是否进报告/记忆/Git | **否** |
| 是否落服务器文件 | **否** |
| 是否在终端 stdout | **是**（一次 `docker compose config` 过滤） |
| 会话日志是否持久化 | 本次会话工具输出由宿主管理；**我无法保证其留存策略** |
| 是否有外部访问 | **无证据** |

**建议**：**不轮换**。

理由：`APP_KEY` 是既有加密字段的主密钥，轮换需**全库重加密**（改一个字段失败就可能丢数据）。而暴露面是**本机终端**，非公网、非共享。

**若你要更保守**：我可以出「重加密方案」——但那是**独立的、有风险的数据操作**，不属于部署范畴，需单独授权。

---

## 12. 恢复工具链演练（本地合成库）

**未执行真实 dump 恢复**（按纪律）。

已完成的**只读**验证：
- `pg_restore -l` 能解析归档（TOC 1072）✅
- 云端 PG 版本 **16** == 本机 **16.15** 同大版本 ✅
- 扩展仅 `plpgsql` ✅

**PENDING**：真正的 `pg_restore` 演练（用合成库）安排在 P4-B 授权后，作为"传真实数据之前的一步"。

---

## 13. 阻塞与风险

| # | 项 | 级别 |
|---|---|---|
| 1 | **原机外部不可达** → 回滚只能靠云端快照 | **高** |
| 2 | `aes_key.dat` / `instance-id` 权限 **644**（应 600） | 中 |
| 3 | `visits/` 有 **8 个未引用文件** | 低（一并迁移） |
| 4 | `visits/` 目录容易被漏（只打 `customer/` 就会丢技师照片） | **高**（已列入方案） |
| 5 | 主键序列未记录（需在 P4-B 恢复后校验） | 中 |
| 6 | 镜像 `RepoDigests` 仍为空（P3 遗留） | 低 |

---

## 14. 判定

| 项 | 结论 |
|---|---|
| 短信出口核查 | **PASS**（4 个发送点全部受 `sms.enabled` 门禁） |
| 源库备份 | **PASS**（3.6 MB、sha256、TOC 1072、129 表） |
| 媒体关联核查 | **PASS**（551↔551、0 缺失、0 越界） |
| 密钥依赖核查 | **PASS**（存在性已确认；权限待改 600） |
| 恢复方案设计 | **PASS** |
| 写入状态核查 | **PASS**（源库静止，最后工单 3 天前） |
| 回滚方案修正 | **PASS**（改为云端快照回滚，因原机不可达） |

**申请 P4-A：PASS / READY FOR P4-B AUTHORIZATION。**

**P4-B（真实传输与恢复）/ P5（证书）/ P6（切流）等待单独授权。Release 继续 HOLD。**
