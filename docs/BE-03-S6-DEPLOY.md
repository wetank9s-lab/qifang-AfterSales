# BE-03-S6 · 受控部署工单（部署前状态）

> 生成：2026-10-29 09:2x　**状态：部署未执行**（当前会话无法登录生产主机，见 §5）
> 目标：只替换 `service-ticket` 插件产物（server/client），**不动数据库 / 历史短信 / 权限 / Nginx**。

---

## 1. 部署前基线（2026-10-29 09:0x–09:2x，只读实测）

| 项 | 实测值 | 取证方式 |
|---|---|---|
| 站点健康 | `200` | `GET /api/app:getInfo` |
| 线上 client 产物 | `sha256 8a0331146cbb19c2` / `424409` B | `GET /static/plugins/@local/service-ticket/dist/client/index.js` |
| 线上 client 是否含本次改动 | **否**（`供应商标识` ×0） | 同上，字节统计 |
| 线上 server 是否含本次改动 | **否**（`recent[]` 缺 `provider_biz_id`） | `GET /api/svc:smsOverview` → `recent[0]` 键集合 |
| `sms.enabled` | `false` | 同一 DTO 的 `channel.enabled` |
| `sms.provider` | `smsbao` | 同上 |
| `send_status='pending'` | **0** | `GET /api/smsLogs:list` 的 `meta.count` |
| `send_status='error'` | 0 | 同上 |
| 今日短信 | `total 0` | DTO `today` |
| 历史 sms_logs 总行数 | 842（accepted 324 / rejected 518） | 全量分页聚合 |

⚠️ **server 产物无法直接回读**（`/static/.../dist/server/index.js` 返回 2508 B 的 SPA 兜底页，不是真包）。
⇒ 因此 server 侧"是否已上线"用 **DTO 探针**判定（见 §4-③），**不用"重启过了"当证据**。

---

## 2. 本次要上的产物（本机构建，已过全部门禁）

| 文件 | SHA-256（前 16） | 大小 |
|---|---|---|
| `dist/server/index.js` | `a53086d510152aac` | 1 532 875 B |
| `dist/client/index.js` | `bd54fb8d575b6b26` | 424 838 B |
| `dist/build-fingerprint.json` | `aa03844927515db3` | 20 762 B |
| 源码指纹 | `8066aa22fb6f…`（179 文件） | — |

⚠️ **client 产物内嵌"构建标记时间戳"** ⇒ 同一份源码重编一次 SHA 就会变。
所以**跨构建比 SHA 没有意义**；上线判定必须用"内容标记 + DTO 探针"（§4），而不是"哈希相等"。

### 2.1 门禁结果

| 门禁 | 结果 |
|---|---|
| `prebuild-guard.mjs` | 9 个受管文件 **全部 SAME** |
| `verify-types.mjs` | 通过（TS2304/TS2552 = 0、白名单违例 = 0） |
| **`verify-ts2741-baseline.mjs`（本轮新增）** | 基线 19 → 当前 19，**无新增** |
| `build-plugin.mjs` | exit 0 |

---

## 3. 部署步骤（在**生产主机**上执行；容器名 `scqf-as-app`）

```bash
set -e
cd /opt/scqf-aftersales                     # 项目根（含 storage/plugins/@local/service-ticket）
TS=$(date +%Y%m%d-%H%M%S)
D=storage/plugins/@local/service-ticket/dist

# ① 备份（可整目录回滚）
cp -a "$D" "$D.bak.$TS"
sha256sum "$D/server/index.js" "$D/client/index.js" > "$D.bak.$TS.sha256"

# ② 落新产物（先把包传到 /tmp/s6-dist-<ts>）
cp -a /tmp/s6-dist/server/index.js            "$D/server/index.js"
cp -a /tmp/s6-dist/client/index.js            "$D/client/index.js"
cp -a /tmp/s6-dist/build-fingerprint.json     "$D/build-fingerprint.json"

# ③ 复核落盘哈希（**先证明文件真的是新的**，再谈重启）
sha256sum "$D/server/index.js" "$D/client/index.js"
#   期望：a53086d510152aac… / bd54fb8d575b6b26…

# ④ 重启应用（`up -d` 不会重启已运行容器，必须 restart）
docker compose restart app
```

> 为什么必须 `restart`：下发的 `?hash=` 由产物 mtime 算出并被进程缓存（DEV-74）。

---

## 4. 上线判定（三条，缺一不可）

| # | 判据 | 期望 | 反例（说明为什么不能只看一条） |
|---|---|---|---|
| ① | 容器健康 | `GET /api/app:getInfo` = **200**，且 `/health` 200 | 200 只说明进程活着，不说明加载了新包 |
| ② | **client 新**：拉 `/static/plugins/@local/service-ticket/dist/client/index.js`，统计 `供应商标识` | **≥1** | 不算 SHA（含时间戳）；不强刷可能读到缓存，需带 `Cache-Control: no-cache` 或加 `?v=<ts>` |
| ③ | **server 新**：`GET /api/svc:smsOverview` 的 `recent[0]` 键集合 | **含 `provider_biz_id`** | 这是 server 侧唯一的、无需登录主机即可验证的"新代码在跑"证据 |
| ④ | 配置未被动过 | `channel.enabled=false`、`channel.provider=smsbao` | 部署不该顺手开开关 |
| ⑤ | 零新增发送 | `today.total = 0`、`send_status='pending'` 仍 **0**、`accepted` 仍 324 | 若 accepted 变多 ⇒ 有真实短信被发出，立即回滚排查 |
| ⑥ | 后台页面 | 「短信通知总览」可打开、`recent` 表出现「供应商标识」列、无 Console 报错 | ③ 绿但页面白 ⇒ 客户端渲染问题 |
| ⑦ | 受控接口与权限 | `svc:updateSetting` 仍仅 hq_admin 可写（store 403 / anon 401）；`smsStatus` 读权限未扩大 | 部署不该改 ACL |

---

## 5. 回滚（任一判据失败立即执行，不试错）

```bash
cd /opt/scqf-aftersales
D=storage/plugins/@local/service-ticket/dist
ls -d "$D".bak.* | tail -1                 # 找到最近一次备份
rm -rf "$D" && cp -a "$D".bak.<TS> "$D"    # 整目录还原
docker compose restart app
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/api/app:getInfo
```

回滚依据（**为什么这样回滚一定成立**）：
- 本次**没有任何 migration**（migrations 仍 15 个 / 登记 33）⇒ 不存在"代码回退但库已迁移"的半截状态；
- **没有改数据库、没有改历史短信状态、没有改权限、没有改 Nginx**（§0 的边界）；
- 只替换了 `dist/` 下 3 个文件 ⇒ 整目录还原即回到上一版（`8a033114` 那一版）。
- 判定"回滚成功"仍用 §4 的 ②③ 反向：`供应商标识` 应为 0、DTO 应不含 `provider_biz_id`。

---

## 6. 当前阻塞（如实记录）

本会话**无法登录生产主机**：
- `ssh root@162.14.121.180` → `Permission denied (publickey)`（本机 `id_ed25519` 未被接受）；
- 本机无 `sshpass` / `plink`，仓库与 `.env` 中**没有任何 SSH 凭据**（按纪律也不该有）；
- 本机 Docker 处于停止状态，且**本地并非生产**（`127.0.0.1:8080/13000` 均 `000`，域名解析到腾讯云 `162.14.121.180`）。

⇒ 需要二选一：**①** 提供可用的 SSH 通道（密码登录，凭据不落盘、不进日志）；**②** 由你在主机上执行 §3 并回贴 §4 的输出。


---

## 8. 部署执行结果（2026-10-29 09:23:19 起）

### 8.1 执行摘要

| 项 | 值 |
|---|---|
| 主机 | `162.14.121.180`（OpenCloudOS 9.4，kernel 6.6.119） |
| 容器 | `scqf-as-app`（`Up` / `healthy`，`RestartCount=0`，`StartedAt 2026-10-29T01:23:32Z`） |
| 插件目录 | `/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket`（bind 挂载进容器） |
| compose | `cd /opt/scqf-aftersales && docker compose -f docker-compose.prod.yml restart app`（rc=0） |
| 备份 | `dist.bak.20261029-092319`（整目录，含 `server/` `client/` `build-fingerprint.json`） |
| 健康 | 容器内 `200`（第 7 次探测，约 35 s）；外网 `200` |

> ⚠️ 实测修正：项目根是 `/opt/scqf-aftersales`，但**插件在 `<root>/src/storage/...`**（不是 `<root>/storage/...`）。
> 部署脚本按 `find` 定位 dist，不写死路径。

### 8.2 部署前后 SHA

| 产物 | 部署前 | 部署后 |
|---|---|---|
| `server/index.js` | `6bc11d5d40e7355d` | **`a53086d510152aac`** |
| `client/index.js` | `8a0331146cbb19c2` | **`bd54fb8d575b6b26`** |
| `build-fingerprint.json` | `82a2e21c8292c5ec` | `aa03844927515db3` |

落盘后**在主机上**复核过哈希（不是只看本地），并核对**容器内**看到的 client 哈希
（`docker exec … sha256sum`）与宿主一致 ⇒ 证明改的就是容器真正加载的那份。

### 8.3 七条判据

| # | 判据 | 结果 |
|---|---|---|
| ① | 外网 `/api/app:getInfo` | **200** |
| ② | client 新版 | 线上 client `bd54fb8d575b6b26`；字面量 `title: "供应商标识"` **1 处**（旧 0 处） |
| ③ | server 新版 | `svc:smsOverview` 的 `recent[0]` **含 `provider_biz_id`** |
| ④ | 配置未动 | `enabled=false`、`provider=smsbao` |
| ⑤ | 零新增发送 | `today.total=0`；`send_status`：0 pending / 324 accepted / 518 rejected（与部署前逐项相同） |
| ⑥ | 两个后台页面 | 真浏览器（headless Edge + CDP）：`总部售后工作台` 与 `短信通知总览` 均正常渲染，`200 svc:hqOverview` / `200 svc:smsOverview`，**Runtime 异常 0**；短信页 DOM 文本含「供应商标识」 |
| ⑦ | 受控接口与权限 | 匿名 `svc:smsOverview` / `svc:hqOverview` / `POST svc:updateSetting` 全部 **401**；admin 读取 200 |

### 8.4 数据库 / 边界

| 项 | 结果 |
|---|---|
| migrations 文件数 | 15（未变） |
| 库内 `migrations` 登记 | **33**（未变） |
| `pending_file_deletions` | 3 行（**部署前就存在**：`[file-deletion]` 任务日志最早 2026-10-27 10:22，非本次引入） |
| 历史短信状态 | 未动（842 行分布逐项相同） |
| 权限 / Nginx | 未动 |

### 8.5 本次上线到底改了什么（用**产物标记**而非指纹判断）

`build-fingerprint.json` 新旧对比显示 22 个文件不同、5 个"新增"——但那是**旧指纹文件本身过期**造成的假差。
以 **bundle 内的功能标记**为准：

| 标记 | 旧 | 新 |
|---|---|---|
| `SMS_SCENE_DISABLED` | 8 | 8 |
| `requiresTemplateCode` | 5 | 5 |
| `EXIF` | 24 | 24 |
| `pending_file_deletions` | 6 | 6 |
| `hqOverview` / `smsOverview` | 2 / 2 | 2 / 2 |
| **`provider_biz_id`** | 5 | **10** |
| **`SMSBAO_SIGN_FORMAT_INVALID`** | 0 | **1** |
| **`SMSBAO_TASK_ID_MAX_LEN`** | 0 | **2** |
| **`SMSBAO_JSON_ERROR_CODES`** | 0 | **2** |

⇒ 实际功能增量**只有 S6 那几处**，其余标记逐一相等。

### 8.6 过程中发现并纠正的两个"假判据"（诚实记录）

1. **② 第一次判绿是假的**：我用 `bytes.count('供应商标识')` 判 client 是否含新列，
   命中 1 处 —— 但那是**源码注释**（esbuild 保留了注释），不是 UI 字面量。
   实际字面量是转义形态 `供…`。改用转义序列后：旧 0 / 新 1，且 `title:` 上下文正确。
   （与 DEV-201 同族：**判据落在"出现了这几个字"，而不是"那段字是代码还是注释"**。）
2. **两个页面一度 404**：`/admin/zku15hcn09u`、`/admin/1y4mi7pchuz` 返回"页面不存在"。
   查 `desktopRoutes` 后确认：页面在 10-28 重建过，schemaUid 已变为
   `/admin/qke3hyq3v92`（总部售后工作台）与 `/admin/mm4xs5ma1ef`（短信通知总览）。
   ⇒ 是**测试脚本里的旧 URL 过期**，不是部署造成的回归。
