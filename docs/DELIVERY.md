# 交付文档 · 家电门店售后服务平台

> **交付性质**：**发布候选交付（Release Candidate）—— 尚未发布**。
> 代码语义已闭合，但有一部分验收只能在**真实公网链路**上完成，因此仍处于 **Release HOLD**。
>
> **本文件的定位**：面向**验收人 / 接手人 / 发布执行人**。它回答「交付了什么、现在什么状态、
> 怎么验、还差什么、去哪查」。操作细节不在此重复 —— 见 `README.md` 与 `docs/` 的专题文档。

---

## 1. 一句话交付结论

**P10-C 工程实现完成；Phase 10 进入 Release HOLD。**

系统是一个可运行、可复原、有门禁守护的家电门店售后服务平台（匿名 H5 报修 → 门店受理派工 →
师傅链接传照片 → 审核 → 评价 → 关闭/重开）。**能不能上线，取决于一次真实公网发布演练**，
而不是取决于还有多少开发工作量。

### 冻结信息（认这两条）

| 项 | 值 |
|---|---|
| **代码冻结点** | `4cf6638` |
| **状态文档提交** | `f418ed9` |
| 仓库 | `github.com/wetank9s-lab/qifang-AfterSales`（public） |
| 权威状态 | `docs/PHASE-10.md` 顶部 **§状态（2026-10-09 · 冻结）** ← **唯一权威** |

> ⚠️ 冻结点之后**不再追加代码、不新增 P10 slice、不为等待证书继续优化门禁**。
> 恢复项目时**先读状态节**，不要凭旧摘要开工（历史教训：曾对着 9 天前的"下一步"干活）。

---

## 2. 交付状态表

| 项 | 状态 |
|---|---|
| **P10-A** | PASS |
| **P10-B** | PASS |
| **P10-C** | IMPLEMENTATION PASS |
| **RB-8 SMS delivery callback** | CLOSED |
| **TLS implementation gate** | PASS |
| **TLS production release gate** | **HOLD** |
| **Client-IP production validation** | **HOLD** |
| **MNS production connectivity** | **PENDING RELEASE REHEARSAL** |
| **Phase 10** | **RELEASE HOLD** |

### 三项 blocker 的「关闭程度不同」，不要合并表述

| 编号 | 对象 | 关闭到哪一层 | 为什么不能再往前关 |
|---|---|---|---|
| **RB-8** | SMS 送达回执 | **可正式 CLOSED**（代码语义已闭合） | 真实云资源只差**环境证明** ⇒ 记为 `MNS production connectivity`，**不把 RB-8 改回 OPEN** |
| — | 真 TLS 入口 | **只能关 implementation gate** | **浏览器信任与公网链路本身就是该 blocker 的核心** ⇒ 必须 HOLD 到真实证书演练完成 |
| — | 真实 Client IP | **只能关「本地 Docker 拓扑误判」这一层** | 真实公网出口的分桶语义未取证 |

### ⚠️ RB 编号纪律（防历史碰撞，别改写）

`RB-1`~`RB-7` 是 `docs/PHASE-10-PREWORK.md` 的**原始 blocker 清单**，语义已固定：

| 编号 | 固定语义 |
|---|---|
| `RB-1` | 请求日志无条件记录请求体（P10-A 已闭） |
| `RB-2` | 生产形态 = **无 TLS** + 三容器均 root + `./storage` 全量可写 bind mount |
| `RB-3` / `RB-6` | 可发布物与发布流程（P10-C） |
| `RB-4` / `RB-7` | 生产攻击面收敛（P10-B） |
| `RB-5` | 备份 / 恢复 / 回滚（P10-A） |
| **`RB-8`** | **SMS delivery callback 缺失** |

- ⇒ **临时报告/关闭报告的序号一律写 `#1 / #2 / #3`，禁止写成 `RB-1 / RB-2 / RB-3`。**
- ⚠️ 特别提醒：`RB-2` 恰好**也涉及 TLS**，但它是「**无 TLS**」这个**缺陷**，
  不是「**TLS 入口**」这个**交付物** —— 这比明显的编号重复更难发现。
- 新增 blocker **一律追加在 `RB-8` 之后**（`RB-9`、`RB-10`…），不复用既有编号。

---

## 3. 交付物清单

### 3.1 代码

| 项 | 位置 | 规模 |
|---|---|---|
| 自研插件（服务端 + 客户端 + 迁移） | `nocobase/plugins/service-ticket/` | 80 个 `.ts/.tsx` 源文件 |
| 客户 H5 / 师傅 H5 | `h5/`（产物 `h5/dist/`） | 构建产物，含 `assets/` + `index.html` |
| 部署编排 | `docker-compose.yml` | 3 服务 |
| 网关配置 | `nginx/nginx.conf` + `nginx/conf.d/` | 含 `proxy-headers.inc` |
| 门禁与运维脚本 | `scripts/` | 59 个 `.mjs` |

### 3.2 数据

| 项 | 数量 | 说明 |
|---|---|---|
| 业务表 | **12 张** | `stores` · `storeUsers` · `serviceTickets` · `serviceVisits` · `serviceVisitPhotos` · `ticketEvents` · `smsLogs` · `serviceSettings` · `apiGuards` · `dailySequences` · `idempotencyRecords` · `exportAudits` |
| 参数种子 | **17 条** | 落 `service_settings`；键清单由 `scripts/expected-settings.mjs` 钉住 |
| 索引清单 | **12 张表全覆盖** | 由 `scripts/expected-indexes.mjs` 钉住（含 `sms_logs.unique(provider, biz_id)` 等幂等键） |
| 后台页面 | 4 张 | 我的门店工单 / 全量工单 / 工单事件时间线 / 派工记录 |

### 3.3 定时任务（4 个）

| 任务 | 作用 | 备注 |
|---|---|---|
| `review_expiry` | 评价超时自动关闭 | 每日 |
| `sms_retry` | 短信失败重发 | 每 5 分钟；上限 1，**仅传输层错误重试** |
| `sla_scan` | SLA overdue 巡检 | **纯读**，不发短信 |
| `sms_receipt` | **短信送达回执消费** | 每分钟长轮询 MNS；**未配置队列时不注册**（刻意如此，会打日志说明） |

### 3.4 文档（`docs/`，33 个专题）

`PHASE-0.md`~`PHASE-10.md`（阶段契约与交付记录）· `DEVIATIONS.md`（103 条事故复盘）·
`SECURITY.md`（威胁模型 + **公网攻击面矩阵**）· `API.md` · `STATE-MACHINE.md` · `DATA-MODEL.md` ·
`ENGINEERING-RULES.md` · `FLOW-ENGINE-NOTES.md` · `DEV-PLAN.md` · `BACKLOG.md` ·
`PHASE-10-PREWORK.md` · **`DELIVERY.md`（本文件）**

> ⚠️ 维护者本地另有一份 `PROJECT-RULES.md`（放在 `.workbuddy/`）—— **它不进仓库、不随交付**，
> 因此**不在上面的清单里**。交付给外部的工程约定以仓库内的 `docs/ENGINEERING-RULES.md`
> 与 `ASSUMPTIONS.md` 为准。

### 3.5 部署形态

| 项 | 值 |
|---|---|
| 容器 | `svc-app`（NocoBase 应用）/ `svc-postgres` / `svc-nginx`（compose 服务名 `app`/`postgres`/`nginx`） |
| 端口 | HTTP `NGINX_HTTP_PORT`（本机 8080）· **HTTPS `NGINX_HTTPS_PORT`（必须 443）** · 应用调试口 `APP_DEBUG_PORT`（仅绑 `127.0.0.1`） |
| 挂载 | 插件产物、H5 产物、nginx 配置（均 `:ro`）· **TLS 证书 `./storage/certs:/etc/nginx/certs:ro`** · ACME webroot `./storage/acme:/var/www/acme:ro` |
| 版本冻结 | `nocobase/nocobase:2.2.15-full-no-nginx` · `postgres:16` · `nginx:1.27-alpine`（冻结于 2026-09-20，单一事实来源 `scripts/expected-versions.mjs`） |

### 3.6 事件入口（对外暴露面）

- **匿名**：门店下拉、匿名报修、评价读取/提交、师傅 Token 接口（`/api/public/*`、`/api/technician/*`、`/t/*`、`/f/*`）
- **已登录**：21 个 `svc:*` 内部接口（角色 + 门店范围 + 对象级校验 + 能力矩阵）
- **测试/诊断**（`tokenCheck`/`smsOutbox`/`faultInject`/`guardQuota`/`sweepProbe`）：
  **仅非 production 注册**，production 下**根本不注册**（404），不是"注册了但 403"
- 完整矩阵（含限流与鉴权口径）见 `docs/SECURITY.md` **§1-bis**

---

## 4. 门禁基线（冻结点读数）

| 门禁 | 读数 | 覆盖什么 | 需要什么环境 |
|---|---|---|---|
| `verify-config.mjs` | **74 项** | 部署层静态校验：挂载/变量/配置/限流/索引清单/TLS 静态事实 | 不需要 Docker |
| `verify-plugin-load.mjs` | **82 项** | 插件生命周期（离线桩）：注册/ACL/分级/production fail-closed 双极性 | 不需要容器 |
| `smoke-test.mjs` | **124 项** | 端到端：健康分档 / 匿名闭环 / 师傅链路 / 幂等 / 日志 / 后台元数据 | 容器 + 数据库 |
| `verify-tls.mjs` | **33 项** | TLS 工程链路（含"默认 CA 校验必须失败"的反向断言） | 容器 + 证书 |
| `verify-sms-receipt.mjs` | **39 项** | 回执链路的真实 HTTP 双极性（真产物 + 真 pg + 桩 MNS） | 容器 + 数据库 |
| `verify-log-redaction.mjs` | 正向 **46** · 反向 **11** | 日志脱敏（含"探针标记被功能本身抹掉"的处置） | 容器 |
| `verify-client-ip.mjs` | PASS | 限流分桶是否按真实客户端 IP（自包含探针） | 容器 |
| `verify-config-falsegreen-reverse.mjs` | 8/8 | **反向**：7 种缺陷形态各自把预期断言打红 | 不需要 Docker |
| `verify-version-pins-reverse.mjs` | 4/4 | **反向**：版本漂移必须被抓住 | 不需要 Docker |
| `verify-bundle-delivery.mjs` | PASS | 构建产物真的送达浏览器（防长缓存假绿） | 容器 |
| `scan-commit-secrets.mjs` | **0 泄漏** | 密钥审计（含运行期生成的密钥文件） | 只读仓库 |

> 📌 **反向门的含义**：它们不验证功能，而是**验证"验证器本身会红"**。
> 只做"注入缺陷⇒变红"证明不了"改完不再假红"，因此反向门都配了"可疑但无害的形态 ⇒ 仍绿"的用例。

---

## 5. 交付边界：部署方必须提供什么

> 这些都是**环境输入**，不在仓库里，也不应该被写进仓库。

| 类别 | 需要提供 | 说明 |
|---|---|---|
| **域名与证书** | 真实域名 + **域名匹配的受信 CA 证书**（含中间证书）+ 私钥 | 放入 `./storage/certs/`（`tls.crt` / `tls.key`）。**443 段用 `server_name _` ⇒ 换域名只替换挂载内容，不改配置不改代码** |
| **短信 · 发送** | `ALIYUN_SMS_ACCESS_KEY_ID` / `ALIYUN_SMS_ACCESS_KEY_SECRET` / `ALIYUN_SMS_SIGN_NAME` / 4 个模板 CODE | 生产禁止 mock 通道（启动闸门会拒绝） |
| **短信 · 回执** | `ALIYUN_SMS_RECEIPT_MNS_ENDPOINT` / `ALIYUN_SMS_RECEIPT_MNS_QUEUE` | 需在短信控制台开通 `SmsReport` 队列；**生产缺失 ⇒ 拒绝启动** |
| **其它密钥** | `SIGN_SECRET`、`PUBLIC_BASE_URL`（**必须 https 且非 localhost**）、DB 口令、备份口令 | 用 `scripts/gen-secret.mjs` 生成 |
| **基础设施** | 单机 + 公网入口；Docker Engine | 发布目标已冻结为「**公网可达的单机生产部署**」（不做 HA / 横向扩容 / K8s） |

**不在交付范围内**（已冻结的裁决，不要临时扩张）：
证书运营平台 / ACME 自动化 · CDN 与负载均衡 · 多实例高可用 · 依赖版本升级
（NocoBase / PG / Node / 业务依赖**本阶段全部冻结**）· 证书与密钥的托管方案。

---

## 6. 未关闭项（Release HOLD 的原因）

> 下面是**最终一轮发布演练**的关闭清单，**不再扩范围**。全绿后一次性签
> `TLS production gate PASS` · `Client-IP production validation PASS` ·
> `MNS production connectivity PASS` · `Phase 10 PASS` · `Release PASS`。

### ① 真实 TLS

- [ ] 真实域名（生产实际使用的那个）
- [ ] 证书 **SAN 与域名匹配**
- [ ] **受信 CA 完整链**（`openssl s_client -showcerts` 能串到根）
- [ ] **默认客户端验证成功** —— 即把 `verify-tls.mjs` 里"默认校验**必须失败**"那条反向断言
      改为"**必须成功**"（这是该 gate 的翻转判据，不是删掉断言）
- [ ] `http://域名/...` → `https://同域名/...`，**保留完整 path 与 query**
- [ ] H5 / API / `/t/` / `/f/` **全部走 HTTPS**，无 mixed content、无跳回 HTTP

### ② HSTS

- [ ] **只在可信证书已经通过之后**才启用，并**实测响应头出现**
- [ ] 首次上线**不要**急着上 `includeSubDomains` / `preload`，除非**所有子域**都已具备同等 HTTPS 条件
- [ ] 开启动作 = 取消 `nginx/conf.d/service.conf` 443 段末尾那行的注释（正式写法已备好）；
      两份断言（`verify-tls` / `verify-config`）会相应从"必须缺席"翻转为"必须出现"
- [ ] ℹ️ `preload` 只在头里写两个字**不生效**，须另行提交到浏览器 preload 列表

### ③ 真实 Client IP

- [ ] 从**至少两个不同公网出口**访问同一入口
- [ ] 确认 **Nginx 实际用于 `limit_req` 的那个地址**在两次访问中**不同**
      （判据是分桶依据本身，不是"日志里看起来像公网 IP"）
- [ ] ⚠️ 若正式架构前面多出 **CDN / LB / 反向代理**：**不要直接信任任意 `X-Forwarded-For`**
      （等于让客户端自己声明身份）。**只对明确的上游地址**配置可信代理链
      （`set_real_ip_from` + `real_ip_header`）

### ④ MNS 真联通（RB-8 的 deployment validation）

- [ ] 控制台开通 `SmsReport` 队列
- [ ] 至少**吃到一次真实 provider 消息**，证明四件事同时成立：
      AccessKey 权限 · 队列名/region 正确 · **消费确认**（`DeleteMessage`）·
      `provider_biz_id` **匹配上**（`delivery_status` 真的从 `pending` 变成 `delivered`/`failed`）
- [ ] ℹ️ 仓库里的 39 项已证明**协议实现正确**，但**不能替代这一腿**

### ⑤ 发布物回归

- [ ] 用**最终实际部署的产物**跑 release-blocking 门禁 —— **不要在签证书前的开发构建上签 PASS**
- [ ] `secret audit` 继续要求 **0 泄漏**

---

## 7. 已知限制（如实登记 —— 影响验收判断，但不是缺陷）

| 项 | 现状 | 对验收的影响 |
|---|---|---|
| **HTTP 不再直出业务** | 80 段收敛为「仅 `/healthz` + ACME + 301」。`/healthz` **必须**保留明文（容器 healthcheck 走 `wget http://127.0.0.1/healthz`） | 所有脚本/门禁已迁到 HTTPS（协议与端口只在 `scripts/lib/base-url.mjs` 判定一处） |
| **HTTPS 必须发布在 443** | 80 段跳转用 `$host`（不含端口）⇒ 目标固定落 443 | 改成 8443 会让跳转指向打不开的地址；已被静态断言钉住 |
| **限流分桶** | 实测：**容器来源流量 IP 被如实保留**；只有**宿主机回环**被折叠成 `172.19.0.1` | ⇒ 本机串跑门禁偶发 429 的**真因**是所有门禁共用一个桶（不是"脚本太激进"）。真实公网出口待演练取证 |
| **TLS 为自签演练件** | SAN 用 RFC 6761 保留的 `.test` + `localhost`，**刻意不碰真实域名** | 浏览器不会信任；**不能**读作"生产 TLS 已完成" |
| **`SmsSendResult.deliveryStatus` 类型即 `'pending'`** | Provider **不得**声称已送达 | `delivered/failed` 只能由回执更新；这是"accepted ≠ delivered"语义边界的实现方式 |
| **历史 `sms_logs` 无 `provider_biz_id`** | **刻意不回填**（发送时未记录，推导不出来；硬填=造假） | 这些行永远收不到回执，只能由新发送自然补齐；迁移里打 warn 说明 |
| **备份目录含真实手机号** | `backups/` 靠 `.gitignore` 挡住，**无挂载** | 属已登记的 B 类项，不影响本次验收 |
| **`SIGN_SECRET` 一密三用** | 已登记的 B 类项（B-15） | 同上 |
| **测试/诊断端点** | **仅非 production 存在**（production 下不注册） | 生产验收时它们应当是 404，**这是正确行为不是缺陷** |

---

## 8. 恢复入口（下一次恢复项目只做一件事）

> ### 真实域名 + 可信 CA 证书到位 → final release rehearsal
>
> 不做别的：**不开 P10-D、不重新设计、不回头重验已冻结阶段、不为等证书继续优化门禁**。
> 那一轮只验证 §6 的清单；**全绿后一次性签**五个 PASS。
>
> **接活前先读 `docs/PHASE-10.md` 顶部「§状态（2026-10-09 · 冻结）」**，不要凭旧摘要开工。

---

## 9. 运维速查

```bash
# 启动 / 重建
docker compose up -d

# 改完 nginx 配置（含证书替换）——先测语法再热载，避免把入口打挂
docker exec svc-nginx nginx -t && docker exec svc-nginx nginx -s reload

# 改完插件源码 —— 必须重建产物再 restart（不是 up -d）
node scripts/build-plugin.mjs && docker compose restart app

# 观察
docker ps --format '{{.Names}}\t{{.Status}}'
docker logs svc-app --tail 50
curl -k https://localhost/api/svc:live        # liveness：进程活着吗（不碰任何外部依赖）
curl -k https://localhost/api/svc:health      # readiness：能接生产流量吗（匿名档只回 {status}）
```

**健康语义分档**（别把两者混用）：

| 端点 | 语义 | 匿名响应 |
|---|---|---|
| `/api/svc:live` | **liveness** —— 不查库、不读任何外部依赖 | 恒 `{status:"ok"}` |
| `/api/svc:health` | **readiness** —— DB + 表齐 + 插件就绪 + 生产依赖满足 | 只回 `{status}`；详情档需鉴权 |

**启动期 fail-closed**：`APP_ENV=production` 下，配置不当会**拒绝启动**（不是警告）——
mock 短信通道 / 注入测试凭据 / `SIGN_SECRET` 缺失 / `PUBLIC_BASE_URL` 非 https /
**阿里云通道未配回执队列**。判定源唯一：`src/server/profile.ts`。

---

## 10. 去哪查什么（索引）

| 想知道 | 去哪 |
|---|---|
| **当前权威状态 / 冻结结论 / 发布演练清单** | `docs/PHASE-10.md` **§状态** ← 唯一权威 |
| 某次事故的现象/根因/教训（103 条） | `docs/DEVIATIONS.md` |
| 威胁模型 / **公网攻击面矩阵** / 密钥纪律 | `docs/SECURITY.md` |
| 接口契约 / 状态机 / 数据模型 | `docs/API.md` · `docs/STATE-MACHINE.md` · `docs/DATA-MODEL.md` |
| 断言怎么写才不假绿（工程铁律） | `docs/ENGINEERING-RULES.md` |
| 后台页面（flow-engine）怎么改 | `docs/FLOW-ENGINE-NOTES.md` |
| 各阶段计划与门槛 | `docs/PHASE-*.md` |
| 已登记但不要求本阶段做的项 | `docs/BACKLOG.md` |
| 快速上手 / 运维命令 | `README.md` |
| 工程约定 / 断言纪律（**仓库内**的权威） | `docs/ENGINEERING-RULES.md` · `ASSUMPTIONS.md` |

---

## 11. 安全声明

- **绝不入库**：`.env` · `storage/apps/`（含 AES 主密钥）· `storage/.license/` ·
  `storage/plugins/` · `storage/logs/` · `storage/uploads/` · `storage/tmp/` ·
  **`storage/certs/`（TLS 私钥）** · `backups/`
- **私钥纪律**：只经**只读挂载**提供；不进仓库、不进镜像、不进任何证据文档。
  证书（公钥部分）可公开，但本仓库**连 `tls.crt` 一起忽略** ——
  把"公钥可公开"当作"可以入库"来放松规则，是密钥审计里最容易吃亏的推理。
- **证据材料也是凭证副本**：门禁证据文件里凡涉及凭据，只保留**掩码 / 长度 / sha8**。
- **本文件不含任何凭据、口令、真实店名、客户数据**；只引用配置**键名**，不引用取值。

---

*交付文档版本：2026-10-09 · 对应代码冻结点 `4cf6638` · 状态文档 `f418ed9`*
