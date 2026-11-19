# P5-3 独立 HTTPS 证书申请专项报告

> 日期：2026-10-22 · **P5-3：PASS（证书已签发）** · **自动续期：PENDING（未装 cron）**
> 未开放 443 业务、未改其他站点、未动宝塔站点库。未 commit / push。

---

## 1. P5-3A 安装前检查：**全部通过**

| # | 检查 | 结果 |
|---|---|---|
| 1 | vhost 仍维护态 | ✅ `return 503` 存在，本机 `/` → **503** |
| 2 | DNS 解析 | ✅ `sh.scqfls.cn → 162.14.121.180`（仅 A 记录，无 AAAA/CNAME） |
| 3 | ACME 目录 | ✅ `/www/wwwroot/sh.scqfls.cn/.well-known/acme-challenge`（755） |
| 4 | **Let's Encrypt 可达** | ✅ `acme-v02=200`、`acme-staging-v02=200` |
| 5 | `nginx -t` | ✅ successful |
| 6 | 既有 ACME 客户端 / 续期任务 | ✅ **无**（`~/.acme.sh` 不存在、crontab 无 acme 条目） |
| 7 | **GitHub 可达** | ✅ `github=200`、`raw=301` |

---

## 2. P5-3B 独立安装：**没有用安装器**

**做法**：`git clone` 源码 → 语法自检 → 用仓库内脚本 + `--home` 专用目录。

| 项 | 值 |
|---|---|
| 源码位置 | `/opt/acme-src/acme.sh` |
| **版本** | **v3.1.7** |
| **commit** | **`37d064f7b580055d3f2ddf9a9c960f754f3694d6`**（2026-10-16） |
| 语法自检 | ✅ `bash -n acme.sh` → SYNTAX_OK |
| 运行数据目录 | **`/opt/acme-data`**（专用） |
| **是否执行 install 脚本** | **否** |
| **是否写 cron** | **否**（`crontab -l \| grep -c acme` = **0**） |
| **是否改 shell profile** | **否** |
| 是否建宝塔站点 | **否** |
| 是否改 Nginx 主配置 | **否** |

**既有 4 行 crontab 未动。**

**没有执行任何 `curl ... | sh`。**

---

## 3. P5-3C Webroot 公网验证：**通过**

| 测试 | 结果 |
|---|---|
| 写入临时文件 `p53c-55f03a8da5a26c15` | ✅ 644 |
| **服务器本机读** | ✅ `p53c-55f03a8da5a26c15` |
| **外部真实公网读** | ✅ **`p53c-55f03a8da5a26c15`（一致）** |
| 目录穿越 `..%2f..%2f..%2fetc%2fpasswd` | ✅ **400**（未泄露） |
| 业务路径 `/` | ✅ 仍 **503** |
| 临时文件清理 | ✅ 已删，目录剩 **0** |

**Webroot 只指向 `/www/wwwroot/sh.scqfls.cn`，没有映射到任何客户媒体目录。**

---

## 4. P5-3D 证书申请：**成功**

### 先 staging 演练

```
--server letsencrypt_test → Cert success
ARI suggestedWindow: 2026-12-03 ~ 12-04
```

**演练通过后才做正式签发**（避免触发签发频率限制）。

### 正式签发

| 项 | 值 |
|---|---|
| 机构 | **Let's Encrypt（正式 acme-v02）** |
| subject | **`CN = sh.scqfls.cn`** |
| issuer | `C = US, O = Let's Encrypt, CN = YE2` |
| SAN | **`DNS:sh.scqfls.cn`** |
| notBefore | **Oct 22 03:10:44 2026 GMT** |
| **notAfter** | **Jan 20 03:10:43 2027 GMT** |
| **链验证** | **`OK`**（`openssl verify -untrusted ca.cer`） |
| fullchain 首张 | leaf（`CN = sh.scqfls.cn`）✅ |

### 文件与权限

| 文件 | 大小 | 权限 |
|---|---|---|
| `fullchain.cer` | 4804 B | 644 |
| `sh.scqfls.cn.cer` | 1281 B | 644 |
| `ca.cer` | 3523 B | 644 |
| **`sh.scqfls.cn.key`** | 227 B | **600 root:root** ✅ |

**私钥全程未打印。**

### 未做的事（按你的指令）

- ❌ 未用 `standalone` 抢 80
- ❌ 未用 `tls-alpn` 抢 443
- ❌ 未自动改 Nginx
- ❌ 未 reload/restart Nginx
- ❌ 未动其他域名证书
- ❌ 未打印证书私钥 / ACME 账户密钥

---

## 5. 一处必须纠正的自检方法（我自己的错）

第一次验证时我用两种**错误方法**，得出了两个假的"失败"结论：

| 我用的方法 | 得出的错误结论 | 正确做法 |
|---|---|---|
| `openssl x509 -modulus` 比私钥 | "私钥与证书不匹配" | **EC 证书没有 modulus**；应比 `-pubkey` 指纹 |
| `openssl verify -CAfile ca.cer` | "链验证失败" | `ca.cer` 是**中间证书**，应作 **`-untrusted`**，根用系统 CA |

**按正确方法重验：链 OK、leaf 正确、SAN 正确。**

**教训**：**验证器自己会错**。差一点就报了一个不存在的证书问题。

---

## 6. 自动续期：**PENDING**

| 项 | 状态 |
|---|---|
| acme.sh 已记录续期时间 | `Le_NextRenewTimeStr = 2026-12-21T23:04:56Z` |
| **crontab 里的续期任务** | **没有（0 条）** |
| 结论 | **证书到期前不会自动续期** |

**为什么没装**：`acme.sh --install-cronjob` 会**写入 root 的 crontab**，而你的指令要求"不允许覆盖已有计划任务 / 审计安装器可能创建的 cron"。

**两条可选做法**：

| 方案 | 说明 |
|---|---|
| **A. `acme.sh --install-cronjob`** | acme.sh 会**追加**一行（不覆盖既有 4 行），但需要你确认 |
| **B. 手工加一条独立 cron** | 例如 `17 3 * * * /opt/acme-src/acme.sh/acme.sh --cron --home /opt/acme-data >/dev/null` |

**我需要你授权其中一种。**

---

## 7. 当前状态（与证书签发前完全一致 + 证书文件新增）

| 项 | 值 |
|---|---|
| `sh.scqfls.cn` HTTP `/` | **503**（维护态，未变） |
| `sh.scqfls.cn` 443 | **未配置**（P5-4 未授权） |
| hd / cloud / sd / kanma | **200 / 403 / 000 / 000**（未变） |
| `nginx -t` | **successful** |
| 应用 | `127.0.0.1:13000`、production、smsbao、SMS_ENABLED=false |
| 数据库 | `scqf_aftersales_candidate`（489/124/26） |

**公网业务访问：仍然完全关闭。**

---

## 8. 新增资源清单

| 路径 | 用途 |
|---|---|
| `/opt/acme-src/acme.sh` | acme.sh 源码（v3.1.7，commit `37d064f7`） |
| `/opt/acme-data/` | 运行数据（账户、证书、配置） |
| `/opt/acme-data/sh.scqfls.cn_ecc/` | 证书与私钥 |
| `/www/wwwroot/sh.scqfls.cn/` | Webroot（仅 ACME 用） |
| `/www/server/panel/vhost/nginx/sh.scqfls.cn.conf` | 唯一 vhost（P5-2） |

**未改**：宝塔站点库、Nginx 主配置、crontab、shell profile、其他站点证书。

---

## 9. 判定

| 项 | 结论 |
|---|---|
| P5-3A 安装前检查 | **PASS** |
| P5-3B 独立安装（无 install 器、无 cron） | **PASS** |
| P5-3C Webroot 公网验证 | **PASS**（外部读到一致内容、穿越 400、业务仍 503） |
| P5-3D 证书签发 | **PASS**（Let's Encrypt 正式、SAN 正确、链 OK、私钥 600） |
| **自动续期** | **PENDING**（等你选 A 或 B） |
| 公网业务访问 | **仍关闭**（503） |

**P5-3：PASS（证书已就绪，未部署到 443）。**

**P5-4 / P5-5 未授权，继续暂缓。P6 / Release HOLD。**
