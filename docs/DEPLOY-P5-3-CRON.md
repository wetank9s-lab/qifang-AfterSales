# P5-3 自动续期收尾报告（方案 B：手工 cron）

> 日期：2026-10-22 · **P5-3 自动续期：PASS**
> 未执行 `--install-cronjob`。未改 vhost、未 reload Nginx、未开放公网。未 commit / push。

---

## 1. 执行前检查

| # | 检查 | 结果 |
|---|---|---|
| 1 | `/opt/acme-src/acme.sh/acme.sh` 存在可执行 | ✅ **EXECUTABLE**（`-rwxr-xr-x`，301889 B） |
| 2 | `/opt/acme-data` 是本次签发用的 home | ✅ **HOME_OK**（含 `sh.scqfls.cn_ecc/fullchain.cer`） |
| 3 | root crontab 现状 | ✅ **4 条**（非空非注释 4 / 总行 4），**未打印内容** |
| 4 | 是否已有 acme 任务 | ✅ **0**（无重复） |
| 5 | 系统时区 | ✅ **Asia/Shanghai (CST, +0800)** |
| 6 | `flock` | ✅ `/usr/bin/flock` |
| 7 | cron 服务 | ✅ `crond: active` |

---

## 2. 变更内容

### 2.1 备份（先做）

| 项 | 值 |
|---|---|
| 路径 | `/opt/acme-data/backup/crontab-root-pre-acme.bak` |
| 权限 | **600 root** |
| 内容 | **原 4 条完整备份**（268 B） |

### 2.2 新增的**唯一一条**

```
17 3 * * * /usr/bin/flock -n /opt/acme-data/.renew.lock /opt/acme-src/acme.sh/acme.sh --cron --home /opt/acme-data >/dev/null 2>&1
```

| 元素 | 说明 |
|---|---|
| `17 3 * * *` | 每日 **03:17**（按你的指定） |
| **`/usr/bin/flock -n`** | **非阻塞锁**，避免同一任务并发 |
| 锁文件 | `/opt/acme-data/.renew.lock`（在专用目录内） |
| 脚本 | `/opt/acme-src/acme.sh/acme.sh` |
| `--cron --home /opt/acme-data` | 用本次签发的同一 home |
| 输出 | `>/dev/null 2>&1`（**不写日志文件，避免日志里出现敏感信息**） |

**没有加 Nginx reload hook**（按你的要求，留到 P5-4）。

### 2.3 安装方式

```
crontab -l > /tmp/cron.new          # 保留原内容
printf '%s\n' "<新行>" >> /tmp/cron.new
crontab /tmp/cron.new                # 整体安装
rm -f /tmp/cron.new                  # 清理临时文件
```

**没有**执行 `acme.sh --install-cronjob`，**没有**改 `/etc/cron.d`，**没有**改其他用户的 crontab。

---

## 3. 验证结果

| # | 检查 | 结果 |
|---|---|---|
| 1 | **新增任务恰好 1 条** | ✅ `grep -c 'acme.sh --cron'` = **1** |
| 2 | **原有 4 条全部保留** | ✅ 总行数 **5**（4 + 1），非空非注释 **5** |
| 3 | cron 服务运行 | ✅ `crond: active` |
| 4 | 脚本路径与 `--home` 正确 | ✅ `grep -c '/opt/acme-src/acme.sh/acme.sh --cron --home /opt/acme-data'` = **1** |
| 5 | 时间表达式正确 | ✅ `grep -c '^17 3 \* \* \*'` = **1** |
| 6 | 未装第二个 ACME 客户端 | ✅ `~/.acme.sh` **none**、`certbot` **none** |
| 7 | 未反复签发验证 | ✅ 只做静态核对，**没有触发任何签发** |
| 8 | 未输出密钥明文 | ✅ 全程只输出计数与路径 |

---

## 4. 当前证书与续期计划

| 项 | 值 |
|---|---|
| subject | `CN = sh.scqfls.cn` |
| SAN | `DNS:sh.scqfls.cn` |
| 签发 | Let's Encrypt（正式，CN=YE2） |
| **notBefore** | 2026-10-22 03:10:44 GMT |
| **notAfter** | **2027-01-20 03:10:43 GMT** |
| **acme.sh 记录的续期时间** | **2026-12-21T23:04:56Z**（ARI 窗口 12-20 ~ 12-22） |
| **调度** | 每日 03:17 `--cron`（到期前自动续） |

**按 ARI 窗口，实际续期会落在 2026-12-21 之后的第一次 03:17 运行**。

---

## 5. 尚未完成（留给 P5-4）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **证书部署到 Nginx 正式路径** | 目前证书在 `/opt/acme-data/sh.scqfls.cn_ecc/`，nginx 还没引用 |
| 2 | **续期后的 reload hook** | `--reloadcmd` 未配置；续期成功后 nginx 不会自动加载新证书 |
| 3 | 443 vhost | 未创建（P5-4 授权项） |
| 4 | H5 路由映射 | 未做（P5-5） |

**P5-4 需要同时做**：
- vhost 里引用 `/opt/acme-data/sh.scqfls.cn_ecc/fullchain.cer` 与 `.key`（或先复制到宝塔惯例路径）
- 给 cron 加 `--reloadcmd`（例如 `nginx -s reload`），但要确认只在证书真的更新时才 reload

⚠️ **一个必须提前说的坑**：如果证书路径直接指向 `/opt/acme-data/...`，**续期后 nginx 需要 reload 才生效**；如果不配 `--reloadcmd`，**证书会静默过期而不自知**（nginx 仍用旧证书）。

---

## 6. 判定

| 项 | 结论 |
|---|---|
| 执行前检查 | **PASS** |
| 备份（600） | **PASS**（4 条完整） |
| 新增任务 | **PASS**（恰好 1 条） |
| 原有任务保留 | **PASS**（4 条全在，总 5） |
| cron 服务 | **PASS**（active） |
| 路径 / 参数 / 时间 | **PASS** |
| 未装第二客户端 | **PASS** |
| 未输出密钥 | **PASS** |
| **证书部署 + reload hook** | **未做（P5-4）** |

**申请：P5-3 自动续期调度 专项 PASS。**

**P5-4 / P5-5 / P6 仍需单独授权。** 未改 vhost、未 reload Nginx、**公网业务访问仍为 503**。Release HOLD。
