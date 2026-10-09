# 家电门店售后服务平台

<p>
  <img alt="status" src="https://img.shields.io/badge/status-release%20candidate-orange">
  <img alt="phase 10" src="https://img.shields.io/badge/Phase%2010-RELEASE%20HOLD-lightgrey">
  <img alt="NocoBase" src="https://img.shields.io/badge/NocoBase-2.2.15-2b6cb0">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-336791">
  <img alt="Nginx" src="https://img.shields.io/badge/Nginx-1.27-009639">
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3-42b883">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-compose-2496ED">
</p>

> **门店售后工单中台** —— 匿名 H5 报修 → 门店派工 → 师傅上传 → 审核 → 匿名评价 → 关闭/重开。
> 单机自托管 · 服务端强制门店隔离 · 一次性 Token 匿名闭环 · 短信通知 · 总部监管

🔴 **当前状态：发布候选（Release Candidate）—— Phase 10 处于 RELEASE HOLD。**

工程链路已闭合；剩余工作不是继续开发，而是**真实公网发布演练取证**（真实域名与受信 CA 证书、
真实客户端 IP 分桶、短信回执真队列联通）。

- **权威状态** → [`docs/PHASE-10.md` §状态](docs/PHASE-10.md)
- **接手 / 验收入口** → [`docs/DELIVERY.md`](docs/DELIVERY.md)（交付了什么 / 怎么验 / 还差什么）

## 技术栈（版本已冻结）

| 层 | 选型 | 冻结版本 |
|---|---|---|
| 低代码基座 | NocoBase Community | `2.2.15-full-no-nginx` |
| 数据库 | PostgreSQL | `16` |
| 网关 | Nginx | `1.27-alpine` |
| 前端 | Vue 3 + Vite | `3.4` |
| 部署 | Docker Compose（单机自托管） | 3 服务：`svc-app` / `svc-postgres` / `svc-nginx` |

> 版本的**单一事实来源**是 [`scripts/expected-versions.mjs`](scripts/expected-versions.mjs)，
> 不是本文件 —— 改版本 = 发起一次版本变更，由门禁断言拦住漏改的那一腿。

---

## 这是什么

一个**独立、轻量的「门店售后工单中台」**，不做 ERP / CRM / 重型 FSM：

```
客户匿名 H5 报修/投诉
  → 门店售后受理 / 转店 / 派工
  → 师傅凭一次性短信链接匿名上传现场照片 + 提交处理结果与收费
  → 门店审核确认（或驳回返工）
  → 客户凭一次性链接匿名评价（含收费一致性确认）
  → 满意关闭 / 低评分或收费不一致自动重开
  → 总部全量监控 + KPI + Excel 导出
```

---

## 角色

| 角色 | 账号 | 范围 |
|---|---|---|
| 门店售后人员 | 有 | 仅被授权门店（服务端强制隔离） |
| 总部售后人员 | 有 | 全部门店 |
| 总部管理员 | 有 | 全部 + 配置/权限/导出 |
| 客户 | 无 | 匿名 H5；评价用一次性 Token |
| 师傅 | 无 | 一次性 Token H5，仅本次任务最小信息 |

---

## 目录结构

```
.
├─ nocobase/plugins/service-ticket/   后端唯一扩展插件（TypeScript 源码）
├─ h5/                                Vue3 + Vite H5（客户报修 / 师傅回执 / 客户评价）
│  └─ dist/                           构建产物（nginx 挂载点）
├─ nginx/                             反向代理、HTTPS、限流、静态托管
├─ docs/                              设计与运维文档
├─ scripts/                           build / verify / gen-secret 等工具
├─ backups/                           备份输出（不入库）
├─ storage/                           运行时持久化（含已编译插件，不入库）
│  └─ plugins/@local/service-ticket/  esbuild 编译产物（compose 挂载源）
├─ docker-compose.yml                 postgres + app(nocobase) + nginx
└─ .env.example                       全部环境变量样例
```

---

## 快速开始

```bash
# 1) 生成 .env（自动填充 APP_KEY / DB 口令 / 签名密钥 / 备份口令）
node scripts/gen-secret.mjs

# 2) 编译自研插件（宿主机 esbuild → storage/plugins/@local/service-ticket）
node scripts/build-plugin.mjs

# 3) 静态校验部署层（不需要 Docker daemon，可在启动前抓出挂载/变量/配置错误）
node scripts/verify-config.mjs

# 3.5) 插件生命周期离线校验（桩环境，不需要容器）
node scripts/verify-plugin-load.mjs

# 4) 启动（首次启动会自动完成 NocoBase 安装与建表，约 1–3 分钟）
docker compose up -d
docker compose logs -f app

# 5) 验收自检（端到端总闸；**项数以脚本自身输出为准**，不在文档里写死）
#    §4c 的 429 断言会临时把 security.ip_minute_limit 降到 2 再在 finally 里恢复，
#    全程只有 3 个请求（远不到 nginx 的 11 次突发上限），所以**不需要**预先放宽限流，也不会留下冷却。
node scripts/smoke-test.mjs --wait 240

# 5b) 客户 H5 验收（前后端契约对齐 / 提交器 single-flight / 同 request_id 并发真机 E2E / nginx 交付）
node scripts/verify-phase3-h5.mjs

# 6) 100 路真实并发取号验收（Phase 2 门槛的唯一解除手段；已于 2026-09-20 通过）
#    接口未就绪时退出码 2（环境未就绪），不会误报红灯
#    ⚠️ 跑之前必须把 IP 频控放宽到 >100，且**两层一起改**：
#       · 应用层 = 改库不是改 .env（.env 只决定首次种子）：
#           docker exec svc-postgres psql -U svc_app -d service_ticket -c \
#             "UPDATE service_settings SET value='1200', updated_at=now() WHERE key='security.ip_minute_limit'"
#       · nginx 层 = svc_public rate 与 limit_conn（只改应用层会被网关 429，现象无法区分）
node scripts/verify-concurrency-phase2.mjs

#    跑完**两层一起恢复**（脚本结尾会再提醒一次；改回后实测 guardQuota.limit = 30）
```

访问（**HTTPS 入口**，端口取 `.env` 的 `NGINX_HTTPS_PORT`）：

- 管理后台：`https://localhost/`（首次进入初始化向导）
- 客户报修：`https://localhost/h5/report?store=S01&source=qr`
- 师傅作业：`https://localhost/h5/technician/visit/<token>`（短信下发）
- 客户评价：`https://localhost/f/<token>`（稳定外部短链，302 → `/h5/customer/review/<token>`）
- 健康检查：`https://localhost/api/svc/health` 或其原生形式 `/api/svc:health`

> ⚠️ **HTTP（80）不直出业务** —— 只保留 `/healthz`（容器 healthcheck）、
> `/.well-known/acme-challenge/`（ACME 校验），其余一律 **301 到 HTTPS**。
> 本机开发证书是**自签演练件**（浏览器会提示不受信任）；正式域名与受信 CA 证书到位后
> **只需替换 `storage/certs/` 的内容**，不改配置、不改代码。详见 [`docs/DELIVERY.md`](docs/DELIVERY.md)。

---

## 部署要求

- 对外仅暴露 **443**；`13000`（NocoBase）与 `5432`（PostgreSQL）不对公网开放
- 必须 HTTPS（微信内置浏览器要求）+ 已备案域名
- 短信签名/模板需提前完成实名资质与运营商报备（有审核周期，勿压到上线当天）
- 密钥只在 `.env`：不进 Git、不进前端、不写入可被前端读取的表

---
