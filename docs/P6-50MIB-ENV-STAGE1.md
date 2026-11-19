# P6 50 MiB 独立测试环境及边界验证报告（阶段一：资源核查 + Nginx 层）

> 时间：2026-10-23 09:30–09:40 CST
> 结论：**资源满足**、**Nginx 层 51 MiB 已实测穿透（无 413）**；
> **业务层 50 MiB 边界仍未验**（隔离实例本轮未开工）。**不申请 50 MiB PASS。**

---

## 1. 资源检查（只读）

| 项 | 实测 | 判断 |
|---|---|---|
| CPU | **4 vCPU** | 够（测试实例再加 1 个 app + 1 个 PG） |
| 内存 | 总 7,681 MB / **可用 4,499 MB** | **够但偏紧**（NocoBase+PG 约需 1–1.5 GB） |
| 磁盘 | 180 G，已用 32 G，**剩 149 G** | 充裕（50 MiB×若干 + 镜像层） |
| 现有容器 | `scqf-as-app`（**127.0.0.1:13000**）、`scqf-as-postgres`（无对外端口） | 完全回环，无公网暴露 |
| 卷 | `scqf-as-pgdata`、`scqf-as-storage` | 生产专用，**不复用** |
| 端口 | 13000 被占；**13010 空闲** | 测试实例用 13010（回环） |

**生产挂载（绝不能复用）**：
```
/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket → 插件
/www/scqf-as-media                                            → uploads-private（生产媒体）
/var/lib/docker/volumes/scqf-as-storage/_data                 → 应用 storage
```

---

## 2. Nginx 层边界：**已实测（零写入）** ✅

向生产上传口发送大请求体（**无会话**，只观察 413 是否发生）：

| 请求体 | 结果 | 含义 |
|---|---|---|
| **51 MiB**（53,477,376 B） | **401** | **没有 413** ⇒ 穿透 nginx |
| 49 MiB（51,380,224 B） | **401** | 同上 |

⇒ `client_max_body_size 60m` **确实生效**，**51 MiB 不会被 Nginx 提前拦**。
无会话 ⇒ 业务层直接 401，**未创建任何会话/媒体**。临时请求体已删。

---

## 3. 业务层 50 MiB 边界：**未验（本轮未开工）**

需要独立实例，且不只是"起个容器"——还要：

1. 新 PG（回环 55432，独立卷）；
2. 新 app 容器（回环 13010，`SMS_ENABLED=false`，**不配任何短信凭据**）；
3. 跑迁移建表；
4. **在新库里种一个合成门店**（否则签不出合法 `k`、建不出会话）；
5. 用新实例自己的 APP_KEY 签 `k`；
6. 生成**格式合法**的大媒体夹具（50 MiB / 50 MiB+1）；
7. 建会话 → 上传 → 校验库记录 + 物理文件长度/哈希；
8. 按精确 ID 清理，销毁实例。

本轮预算不足以稳妥完成这 8 步，**因此没开工，也不冒充结果**。

---

## 4. 生产零测试写入证据

| 项 | 值 |
|---|---|
| 生产媒体记录 | 580（昨天 576 —— **真实客户增长 +4**，非测试） |
| 生产媒体会话 | 748 |
| 生产媒体目录条目 | 2（顶层目录数，未新增） |
| 我这侧的上传 | **全部 401，未进入业务层，零写入** |
| 数据库 / Nginx / 解析器 / ACL | **未改** |
| Docker daemon | 未重启 |
| 临时文件 | `/tmp/req51.bin`、`/tmp/req49.bin` **已删** |

> ⚠️ 580 vs 576 是**真实业务增长**（网关在接单），不是我造成的 —— 如实记录，不做"数字没变"的假证。

---

## 5. 隔离设计（已定稿，待执行）

```
compose 项目：scqf-media-test（独立目录 /opt/scqf-media-test）
  ├─ pg-test   镜像 postgres:16  卷 test-pgdata  端口 127.0.0.1:55432
  └─ app-test  镜像 nocobase/nocobase:2.2.15-full-no-nginx
               端口 127.0.0.1:13010
               卷 test-storage + /opt/scqf-test-media → uploads-private
               DB_DATABASE=scqf_media_test（**不是 candidate**）
               SMS_ENABLED=false，无 SMSBAO_* 凭据
               独立 APP_KEY（新生成，不入 Git）
```

**隔离硬保证**：
- 不挂 `/www/scqf-as-media`、不挂 `scqf-as-pgdata`、不连 `scqf_aftersales*`；
- 不碰 `rehearsal`；不并入生产 compose；不改生产 Nginx（测试直连 13010）；
- 不重启 Docker daemon（只 `docker compose up`）。

---

## 6. 实际阻塞与遗留风险

| # | 项 | 说明 |
|---|---|---|
| B1 | 业务层 50 MiB 未验 | 需按 §5 建实例；**资源够，是工时问题，不是资源问题** |
| B2 | 内存余量 4.5 GB | 建实例期间需盯内存；NocoBase 迁移期峰值较高 |
| B3 | 合法大媒体夹具 | 需构造**结构合法**的 50 MiB 媒体（不能靠追加随机字节） |
| R1 | `ITEM-TRUNC-01` | 截断文件仍可解析 —— 待评估，未改校验 |
| R2 | V2/V3/V5 | TEST INVALID，已冻结不再尝试 |

---

## 7. Git 与部署

| 项 | 状态 |
|---|---|
| 部署 | **无**（本轮零部署、零代码改动） |
| Git | **未 commit / 未 push** |
| 生产配置 | 未动 |

---

## 8. 状态

| 项 | 状态 |
|---|---|
| MEDIA-ERROR-COPY-01 | **PASS / CLOSED** |
| 标准 MP4 解析 | **PASS / FROZEN** |
| V2/V3/V5 | **TEST INVALID / PENDING** |
| C6-A | PARTIAL PASS |
| C6-B | PENDING |
| Android 原始故障 | PENDING |
| **50 MiB** | **BLOCKED → 现在改为「Nginx 层 PASS / 业务层 PENDING」** |
| C 组 | PARTIAL PASS |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |

**下一步只需你说一句"继续建实例"，我就按 §5 的顺序一次做完**（建库→迁移→种门店→签 k→大夹具→会话→上传→校验→清理→销毁）。
