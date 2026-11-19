# 腾讯云部署 第一阶段：本机基线与源码审计报告

> 日期：2026-10-22 · **阶段一 PASS；阶段二 BLOCKED（缺 SSH 凭据）**
> 全程只读，未修改源码、未改服务器、未迁移数据。

---

## 1. Git 状态

| 项 | 值 |
|---|---|
| 分支 | **`main`** |
| HEAD | **`9a57997efb2ff5940b56cb8bb84031195953f750`** |
| `origin/main` | **`9a57997…`** —— **与本地完全一致** |
| 未推送提交 | **0** |
| 未提交的跟踪文件 | **0** |
| 未跟踪 | `docs/GIT-COMMIT-2026-10-22.md`（提交审计报告，未入库） |

最近 5 个提交：

```
9a57997 feat(phase-11): add new modules referenced by preceding commits
6297af6 docs(phase-11): record acceptance reports and known limitations
a6f6496 feat(phase-11): remaining server/client wiring and doc updates
f060305 feat(phase-11): historical archive lifecycle, workbench, and multi-stage UI
6c08dcb fix(ux-01b): refine H5 repair form layout and unify media icons
```

**结论**：源码 → 远端 → 本机运行代码 **三者一致**，无待推提交。

---

## 2. Docker 环境

| 项 | 值 |
|---|---|
| Docker Engine | **29.5.3** |
| Docker Compose | **v5.1.4** |
| 应用镜像 | `nocobase/nocobase:2.2.15-full-no-nginx` |
| PostgreSQL | **16.15**（`postgres:16`） |
| Nginx | `nginx:1.27-alpine` |

运行中容器（**仅本项目的 3 个**）：

| 容器 | 端口 |
|---|---|
| `svc-app` | `127.0.0.1:13000->13000` |
| `svc-nginx` | `0.0.0.0:443`、`0.0.0.0:8080->80` |
| `svc-postgres` | 仅容器内 5432（**未映射到宿主机**） |

> 注：本机 80 端口被另一个项目（CRMEB）占用，所以本项目 HTTP 走 8080、HTTPS 走 443。

---

## 3. 业务数据基线（实测，非引用旧报告）

| 表 | 数量 |
|---|---|
| `service_tickets` | **489** |
| `historical_service_archives` | **124** |
| `historical_ticket_conversions` | **26** |
| `ticket_events` | **1827** |
| `service_visits` | **279** |
| `customer_medias` | **551** |
| `customer_media_sessions` | **725** |

**私有媒体**：`storage/uploads-private` = **94 MB**，**422 个子目录**。

**与任务书给的已知数字完全一致** —— 说明自上次报告以来无业务变动。

---

## 4. 构建

```
node scripts/build-plugin.mjs
exit = 0
✅ 插件构建成功
产物：storage/plugins/@local/service-ticket/dist/client/index.js（10:08 生成）
```

**关于 `TS2347`**：日志里有 **5 条** `date-range-item-model.tsx(76..80): error TS2347: Untyped function calls may not accept type arguments`。

- 这是**既有的类型检查噪声**（历史上一直存在，之前报 4 条，现在 5 条——因为新版本多了一行同模式调用）
- **不阻断构建**：`exit=0`、产物正常生成
- **不是本次新增缺陷**

> ⚠️ 我第一遍判断"构建失败"是**误读**：用 `grep -c "error TS"` 统计到 5 条就以为失败，其实那是 tsc 的 `noEmitOnError=false` 下的警告式输出，脚本仍判成功。**判构建要看 exit code 和「✅ 插件构建成功」这一行，不是看 error 计数。**

---

## 5. 环境变量

`.env` 共 **84 个变量名**，其中 `DB_ / APP_ / STORAGE / SMS_ / ALIYUN / NGINX / SVC_ / SMOKE_` 前缀 **45 个**。

**本报告只列名称，不输出任何值。**

生产部署需要重新生成的（不能直接复制本机）：

| 类别 | 处理 |
|---|---|
| `DB_PASSWORD` | **重新生成** |
| `APP_KEY` / `AES_KEY` | **重新生成**（换 key 会导致既有加密字段不可解，需在迁移方案里单独评估） |
| `SIGN_SECRET`（门店二维码） | **必须与迁移数据保持一致**，否则已印发的二维码全部失效 |
| `ALIYUN_SMS_*` | 生产先保持 **mock**，拿到单独授权后再配 |
| `SMOKE_ADMIN_*` | **不带入生产**（或改为强口令） |

---

## 6. 阶段二阻塞：SSH 无法认证

**目标**：`162.14.121.180`

| 检查 | 结果 |
|---|---|
| 22 端口 | **OPEN** |
| 本机 SSH key | `~/.ssh/id_ed25519` 存在 |
| `known_hosts` 含该 IP | **是（1 条）** |
| **SSH 实际连接** | **`Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password)`** |

**本机的 `id_ed25519` 未被服务器接受。**

按任务书纪律：
> 不得在提示词、报告或 Git 中保存 SSH 密码、私钥或面板登录凭据
> 遇到…必须停止并请求确认

**我停在这里，没有尝试密码爆破、没有尝试其他用户名猜测。**

---

## 7. 需要你提供（三选一）

| 方式 | 说明 |
|---|---|
| **A. 把本机公钥加到服务器** | 你执行一次 `ssh-copy-id`，或把 `~/.ssh/id_ed25519.pub` 内容加到服务器 `~/.ssh/authorized_keys`（**推荐**，之后我能直接只读审计） |
| **B. 告诉我登录用户名** | 若已有其他账号（非 root）且 key 已配好，告诉我是哪个用户 |
| **C. 你自己在服务器上跑审计命令** | 我给一份只读命令清单，你把输出贴回来（**最保守**，不涉及凭据传递） |

> 公钥指纹（可直接用于核对）：`ssh-keygen -lf ~/.ssh/id_ed25519.pub`

---

## 8. 阶段一判定

| 项 | 状态 |
|---|---|
| Git 一致性 | **PASS**（HEAD == origin/main，无待推） |
| Docker 环境 | **PASS** |
| 业务基线 | **PASS**（489/124/26/1827/279/551/725，与任务书一致） |
| 构建 | **PASS**（exit=0） |
| 环境变量齐全性 | **PASS**（84 个，名称清单已列） |
| **阶段二（服务器审计）** | **BLOCKED（SSH 认证）** |

**阶段一：PASS。阶段二：BLOCKED，等待凭据。**

---

## 9. 本轮未做

- 未修改任何源码/配置
- 未创建任何容器/镜像/网络/数据卷
- 未连接成功服务器（认证失败）
- 未迁移任何数据
- 未修改 DNS
- 未执行 Git push
- 未执行任何 Docker 清理

---

## 10. 下一步（拿到凭据后）

1. 服务器只读审计（12 项）
2. **重点确认 `sh.scqfls.cn` 是否已被其他项目占用** —— 若已绑定，立即出冲突报告并停止域名接入
3. 确认宝塔实际使用的 Nginx 实例与配置目录（不假定固定路径）
4. 确认空闲端口、Docker 网络/卷命名冲突
5. 出《独立部署方案》（含架构图、端口清单、目录规划、迁移与回滚方案）等待审核
