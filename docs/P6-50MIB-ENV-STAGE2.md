# P6-HOTFIX-02：50 MiB 独立环境与业务边界验收报告（阶段二）

> 时间：2026-10-23 09:34–09:47 CST
> 结论：**ENV PASS**（独立实例建成、隔离门禁逐条实测通过）；
> **BOUNDARY PENDING**（第五~八关：种门店→签 k→会话→50 MiB 上传 尚未执行）。

---

## 1. 测试环境实际配置

| 项 | 值 |
|---|---|
| Compose 项目 | **`scqf-media-test`**（目录 `/opt/scqf-media-test`） |
| PG 容器 | `scqf-media-test-pg`（postgres:16，**不对外发布端口**） |
| App 容器 | `scqf-media-test-app`（`nocobase/nocobase:2.2.15-full-no-nginx`，**仅 `127.0.0.1:13010`**） |
| 资源限制 | `mem_limit: 1500m` |
| 数据卷 | `scqf-media-test-pgdata` / `scqf-media-test-storage`（**独立命名**） |
| 测试媒体目录 | **`/opt/scqf-test-media`** → `/app/nocobase/storage/uploads-private` |
| 网络 | `scqf-media-test-net`（独立） |
| 密钥 | **新生成** `APP_KEY`、`SIGN_SECRET`（`openssl rand -hex 32`，写在 `.env.test`，**600**） |
| 短信 | `SMS_ENABLED=false`、`SMS_PROVIDER=mock`、**无 `SMSBAO_*` 任何凭据** |

---

## 2. 隔离门禁（逐条实测，不是看文件名）

| # | 门禁 | 实测 | 结论 |
|---|---|---|---|
| 1 | 应用连的是测试 PG | `DB_HOST=pg-test`、`DB_PORT=5432`（容器内网） | ✅ |
| 2 | 测试库只含新数据 | 库清单 = `postgres, scqf_media_test` **两个** | ✅ |
| 3 | 未挂生产 DB 卷 | 挂载里**没有** `scqf-as-pgdata` | ✅ |
| 4 | 未挂生产媒体 | 挂载的是 **`/opt/scqf-test-media`**，不是 `/www/scqf-as-media` | ✅ |
| 5 | 未连 candidate / rehearsal | `DB_DATABASE=scqf_media_test` | ✅ |
| 6 | 不用生产密钥/凭据 | 新 `APP_KEY`/`SIGN_SECRET`；无短信凭据 | ✅ |
| 7 | 外部副作用关闭 | `SMS_ENABLED=false` / `SMS_PROVIDER=mock` | ✅ |
| 8 | 解析器与大小限制同版本 | 插件目录**只读挂载同一份** `service-ticket`（同一产物） | ✅ |
| 9 | 生产未变 | 见 §4 | ✅ |

**实际挂载源（`docker inspect`）**：

```
/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket → node_modules/@local/service-ticket   (ro)
/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket → storage/plugins/@local/service-ticket
/var/lib/docker/volumes/scqf-media-test-storage/_data          → /app/nocobase/storage
/opt/scqf-test-media                                          → /app/nocobase/storage/uploads-private
```

---

## 3. 迁移与健康

| 项 | 结果 |
|---|---|
| PG | **healthy** |
| 迁移 | 自动完成，测试库 **104 张表** |
| App | **healthy**（`/api/app:getInfo` 200） |
| 启动耗时 | PG ~15s，App ~35s |

---

## 4. 生产未受影响

| 项 | 值 |
|---|---|
| `scqf-as-app` | **Up 16 hours (healthy)** |
| `scqf-as-postgres` | **Up 22 hours (healthy)** |
| 生产 `customer_medias` | **580**（较昨日 576 为**真实客户增长**） |
| 内存 | used 3,717 MB / **avail 3,963 MB** |
| 生产 compose / Nginx / 解析器 / ACL / 上限 | **未改** |
| Docker daemon | **未重启** |
| 生产媒体目录写入 | **0** |

---

## 5. 边界验收（A 50 MiB / B 50 MiB+1）—— **未执行**

第五~八关待做，顺序已定：

1. 测试库种**合成门店**（不用真实客户资料）；
2. 用**测试实例自己的 `SIGN_SECRET`** 签出合法 `k`；
3. 建媒体会话；
4. 造**结构合法**的 50 MiB 夹具；
5. 上传 → 查库记录 + 媒体目录文件 → 比对长度与 SHA-256；
6. 50 MiB+1 同样流程，验证业务层拒绝（**区分**单文件上限 vs multipart 总上限）。

### 夹具计划（不造假）

采用**真实 4 秒 MP4 为基础**，把 `mdat` 载荷扩到目标字节数并**同步修正 box size**，
`ftyp/moov/mvhd/hdlr` 全部保留 —— 容器结构合法、时长仍为 4000ms。
**不会**用"随机字节 + 改扩展名"或"简单追加填充"。

> 若最终无法在精确字节数下保持结构合法，则单独报**夹具阻塞**，不申请业务边界 PASS。

---

## 6. 清理状态

- 实例**保留**（便于复核验收证据，按令不擅自销毁）。
- 如需销毁：先列资源清单（2 容器 / 2 卷 / 1 网络 / `/opt/scqf-test-media` / `/opt/scqf-media-test`）并再次确认归属。
- 未使用宽泛匹配的清理命令。

---

## 7. Git 与部署

| 项 | 状态 |
|---|---|
| 生产部署 | **无** |
| 生产代码改动 | **无** |
| Git | **未 commit / 未 push** |

---

## 8. 判定

| 项 | 状态 |
|---|---|
| **独立环境建设** | **ENV PASS** |
| **50 MiB 业务边界** | **BOUNDARY PENDING** |

| 其它 | 状态 |
|---|---|
| MEDIA-ERROR-COPY-01 | PASS / CLOSED |
| 标准 MP4 解析 | PASS / FROZEN |
| V2/V3/V5 | TEST INVALID / PENDING |
| C6-A / C6-B | PARTIAL / PENDING |
| Android 原始故障 | PENDING |
| 问题⑦ 录音布局 | PENDING |
| C 组 | PARTIAL PASS |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |
