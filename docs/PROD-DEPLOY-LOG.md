# 生产发布登记簿（PROD DEPLOY LOG）

> 用途：每次生产发布**只需追加一段**，记录"哪个版本在跑、备份在哪、怎么回退"。
> 不写验收细节（那些在各自专项报告里），只写**上线事实与回滚锚点**。
> 状态：**PROD DEPLOY PASS**（2026-11-06）

---

## 当前生产在跑什么（以本节为准）

| 项 | 值 |
|---|---|
| 主机 | `162.14.121.180`（`VM-0-8-opencloudos`，machine-id `59983898e2cb4fc88bc6a571858e041d`） |
| 应用容器 | `scqf-as-app`（`Up (healthy)`） |
| 数据库容器 | `scqf-as-postgres`（库 `scqf_aftersales_candidate` / 用户 `scqf_as`） |
| 插件目录 | `/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket`（bind 挂载） |
| compose | `cd /opt/scqf-aftersales && docker compose -f docker-compose.prod.yml restart app` |
| 站点 | `https://sh.scqfls.cn`（nginx 直装于宿主，非容器） |
| vhost | `/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`（310 行） |

### 产物指纹（SHA-256 前 16）

> 🔴 **2026-11-06 15:20 已被 BE-03-SMS-FIX-01 覆盖**，现行值见下方 15:20 段。
> 🔴 **2026-11-06 16:29 H5 侧又被 P0-1 覆盖**，现行 H5 值见下方 16:29 段。
> 下表保留为「累计版本」的出厂记录，不代表现网。

| 文件 | 指纹（累计版本 · 已下线） |
|---|---|
| `dist/server/index.js` | `2ec3066ab68caa3e` |
| `dist/client/index.js` | `2ba79303c260329e` |
| `dist/build-fingerprint.json` | `6344ebfe4b105043` |
| `dist/server/migrations/*.js` | 23 个（与仓库构建逐一同哈希） |

### 数据库

| 项 | 值 |
|---|---|
| `migrations` 登记 | **41**（本次从 33 增至 41） |
| 新增迁移 | `202610231` / `202610251` / `202610252` / `202611061` / `202611062` / `202611063` / `202611064` / `202611065` |
| 触发器 | `trg_service_visits_one_assigned`（`BEFORE INSERT OR UPDATE`，enabled） |
| 唯一索引 | `service_visits_short_code_hash_key` / `service_visits_manual_code_hash_key` / `service_tickets_progress_code_hash_key` |
| 数据基线 | 票据 **523** / Visit **297** / 重复 ASSIGNED **0** |
| 短信日志 | mock 464 rejected + 322 accepted；smsbao 59 rejected + 7 accepted（**与部署前逐项相同，零新增发送**） |
| 短信总开关 | **保持关闭**，本次未动 |

---

## 2026-11-06 14:27–14:40 · 累计版本发布（PASS）

**发布内容**：BE-03-SMS-TEMPLATE-02 → TEMPLATE-02-R1 → DEV-207/208/209 → BE-03-MANUAL-TECH-LINK
+ Nginx `/p/t/{22}` 与 6 条 `?code=` rewrite。

### 备份（回滚锚点）

| 类型 | 路径 | 大小 |
|---|---|---|
| 整库 dump | `/root/scqf-db-before-20261106-143326.sql.gz` | 3 321 133 B |
| 整库 dump（第一次尝试） | `/root/scqf-db-before-20261106-142722.sql.gz` | 3 320 740 B |
| dist 整目录 | `dist.bak.20261106-143326` | — |
| dist 整目录（第一次尝试） | `dist.bak.20261106-142722` | — |
| nginx vhost | `sh.scqfls.cn.conf.bak.deploy-20261106-143724` | 15 472 B |

### 回滚步骤

```bash
# 1) 代码（不动数据库、不删列、不 drop 触发器）
D=/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist
rm -rf "$D" && cp -a "$D.bak.20261106-143326" "$D"

# 2) 重启
cd /opt/scqf-aftersales && docker compose -f docker-compose.prod.yml restart app

# 3) nginx（仅在需要撤掉 /p/t/ 与 ?code= 时）
cp -a /www/server/panel/vhost/nginx/sh.scqfls.cn.conf.bak.deploy-20261106-143724 \
      /www/server/panel/vhost/nginx/sh.scqfls.cn.conf
nginx -t && systemctl reload nginx
```

**数据库不入回滚路径**（用户 2026-11-06 明确要求：保留历史短链校验所需的列）。
如需整库回退：`gunzip -c /root/scqf-db-before-20261106-143326.sql.gz | docker exec -i scqf-as-postgres psql -U scqf_as -d scqf_aftersales_candidate`
—— 但**整库回退会丢掉本次上线后新增的工单/访问记录**，非必要不做。

⚠️ **回滚后的强制动作**：若代码回退到 TEMPLATE-02 之前的版本，旧代码路径不认触发器的
`23505`，并发派工会从"产生两条 ASSIGNED"变成"派工直接报错"。
⇒ **回滚后必须立刻做一次真实派工验证**，不能只重启完事。

### 上线验收（实测，非推断）

| 判据 | 结果 |
|---|---|
| `/api/app:getInfo` | 200 |
| `/p/t/{22}` | 302 → `/h5/technician/visit/{code}`（部署前 404） |
| `/p/t/` 畸形 | 404 |
| `/p/{22}` 与 `/p/{43}` | 302（历史 43 位仍可用） |
| `/t/{43}` | 302 |
| `svc:technicianLink` 匿名 | 401 |
| `technicianVisit:get?code=<无效>` | 401 `TOKEN_INVALID`（非 404 ⇒ 路由+鉴权链路通） |
| 线上 client 标记 | 与本地构建逐字节一致 |

### 待完成

- [ ] **微信真机验证**（客户进度链接 + 师傅作业短链）——由用户执行
- [ ] 真机通过后确认本次功能**最终验收结果**

---

## 2026-11-06 14:57 · 收尾日志审计（不改任何东西，只读）

`python scripts/prod-log-audit.py` 两窗口交叉验证：

| 窗口 | 起点 | 总行数 | error | 启动批次内 | 运行期 | 判定 |
|---|---|---|---|---|---|---|
| 本次容器启动以来 | `2026-11-06T14:36:22` | 890 | 2 | 2（全 `APP_COMMANDING`） | **0** | PASS |
| 整个发布窗口 | `2026-11-06T14:20:00` | 1 854 | 12 | 7（全 `APP_COMMANDING`） | 5（全 `APP_COMMANDING`） | PASS |

- **无任何 `APP_ERROR` / 非维护态 error**。所有 error 都是重启期间
  `{"status":503,"maintaining":true,"code":"APP_COMMANDING"}` 的自我保护响应。
- 两周全量日志里的 618 条 error（含 `ENOENT .../uploads/`、`No permissions`、
  `APP_ERROR` 80 条）**全部落在 10-22 ~ 11-05**，早于本次发布，与本次改动无关。
- 审计脚本自身踩到「`--since` 带空格只回 1 行」的假干净坑，已写进 `docs/DEPLOY-RUNBOOK.md` 铁律 5，
  并在脚本里加了「窗口内必须有 `init plugins` 才允许下结论」的自证闸。

**发布后真实业务已在流**：`FW20261106-0002` 14:49:27 创建（PROCESSING），票据 523→524、Visit 297→298。

### 本次会话新增/改动的文件（均未推送）

| 文件 | 作用 |
|---|---|
| `docs/PROD-DEPLOY-LOG.md` | 本登记簿 |
| `docs/DEPLOY-RUNBOOK.md` | 部署规范（铁律 0–5） |
| `scripts/prod-deploy-cumulative.py` | 加两道硬闸：迁移目录必传 + 落库校验；健康判据自证 |
| `scripts/nginx-merge-3blocks.py` | 按块合并 vhost |
| `scripts/sync-migrations.py` | 只补不删、逐文件 sha256 |
| `scripts/prod-log-audit.py` | 发布后日志审计（窗口自证 + 按启动批次归类） |

---

## 2026-11-06 15:20 · BE-03-SMS-FIX-01（PASS，无迁移）

### 变更内容（**只换 3 个文件**）

| 文件 | 旧 | 新 |
|---|---|---|
| `dist/server/index.js` | `2ec3066ab68caa3e` | **`e1fe6c8075dc224f`** |
| `dist/client/index.js` | `2ba79303c260329e` | **`74f0ef80d5f45598`** |
| `dist/build-fingerprint.json` | `6344ebfe4b105043` | **`2fab7a8d2559d7b7`** |

未动：迁移（41 条，前后一致）、nginx、数据库结构、短信总开关。

### 根因

`sms_logs` id=6484（11-06 14:49:47）落 `rejected + SMS_TEMPLATE_PENDING_REVIEW`。
真正原因**不是模板没审核**，而是代码硬名单 `SMS_REVIEW_PENDING_SCENES = ['technician_task']`
（`constants.ts:1414`）在提交前无条件拦截，与供应商审核状态无关，配置层无法解除。
同行 `progress_link`(6482)/`progress_update`(6483) 均 `accepted` ⇒ Provider 无故障。

### 修复

1. `SMS_REVIEW_PENDING_SCENES` → `[]`（机制保留，注释写明「清空 ≠ 这个闸不存在」）。
2. `SMS_SCENE_LABEL` / `sceneSummary` / client `SCENE_LABEL` 三处统一；`insight.ts`
   改为 `{ ...SMS_SCENE_LABEL }`，**删掉手抄的第四份映射**（这才是"未命名通知"的根因）。
3. 错误显示：补 `SMS_TEMPLATE_PENDING_REVIEW` / `SMS_UNRENDERED_VARIABLE` 译名；
   未知码兜底 `未发送（CODE）`；新增 `smsErrorDetail()`（译名 → `error_message` → 原始码）。
4. 正文模板**一字未改**，22 位短码 / 72h / 撤销机制均未动。

### 部署

备份：`dist.bak.20261106-152024`（71M）
回滚：`python scripts/prod-deploy-sms-fix-01.py --rollback 20261106-152024`
（只还原 dist + restart，无 SQL；回滚后师傅短信会回到被拦状态，**不会误发**）

健康：容器内 200 / 域名 `https://sh.scqfls.cn/api/app:getInfo` 200 / 容器 `running|healthy`
（重启后 t+20s 起出现过 503，是 `APP_COMMANDING` 维护态，t+28s 转 200）

### 验收（实测，非推断）

| 项 | 结果 |
|---|---|
| bundle 内闸门 | `SMS_REVIEW_PENDING_SCENES = []` |
| 场景名（解析 bundle 对象字面量） | 师傅任务通知 / 客户报修成功通知 / 客户处理进展通知 |
| 师傅正文 | 与授权模板**逐字一致**，无门店/工单号/姓名/手机号，`{code}` 恰 1 处 |
| 错误显示 | 历史 rejected 行 → 「模板待供应商审核，未提交（非故障）」 |
| 零发送 | `max(sms_logs.id)` 部署前后均为 **6484**，无新增 |

### 遗留

- 后台静态 JS 无内容指纹 ⇒ 运营/用户需**强刷**才能看到新场景名。
- `sms.enabled` 生产库值仍为 `true`（未改动）；本轮**未发送任何真实短信**，
  师傅短信是否真的发出，取决于下一次真实派工 —— 由用户真机验证确认。

---

## 2026-11-06 16:29 · P0-1「维修措施必填」（PASS，无迁移）

**发布内容**：师傅 H5 作业页「处理说明（选填）」→「维修措施（必填）」，
至少 5 个有效字（去空白后计数），前端拦截 + 服务端既有校验。
**只换 H5 静态产物 3 个文件**：不重启容器、不改 Nginx、不改数据库、不改短信配置。

### 变更内容（只换 3 个文件）

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `h5/index.html` | 987 | `116d3f75250d741ac683cc0bd4ab97c7c529d26029f1f7b0ba7773189cc793e5` |
| `h5/assets/index-BG5kVB0x.js` | 168630 | `78a99c64ad60052a318a5e4bde4ecf2fd437f2bc1723b213bd9e67dfcd2929f7` |
| `h5/assets/index-DBQ7A3d6.css` | 29513 | `49010f4d392a914ac10bf09e87aac95598a14001aaffbbab71f8766f9932d3ca` |

> 新 JS：**`index-BG5kVB0x.js`**　新 CSS：**`index-DBQ7A3d6.css`**
> 旧产物 `index-B-QCspWq.js` / `index-e8rVAVRE.css` **保留未删**（HTTP 200 可访问）。

### 构建方式（方案 D：最小差异）

生产 H5 的源码基线**不等于 git HEAD**（线上含一批未入库改动），因此不能从 HEAD 重建。
实际做法：以**当前工作区源码**为基线，只撤回尚未上线的 P6B 行为，再加入 P0-1。
构建目录 `.build/p01d`（一次性，非开发源码）。

撤回的 3 处未上线 P6B：

1. `Report/Success.vue` 挂载即落盘（`if (canRemember) applyRemember()`）→ 已移除；
2. `remember` / `autoOpen` 初值 `ref(true)` → 回到 `ref(false)`；
3. `Report/index.vue` 中 `skipRestore` 的**消费分支** → 已移除
   （线上只有"生成链接时带该参数"3 处、消费 0 处，属死参数）。

已上线且**原样保留**：清除本机记录（`progress-forget`）、P6-PROGRESS-SYNC-02「此前服务师傅」、
门店电话（`progress-store-phone`）、`lastOrder` 7 天期限（`6048e5`）、评价直连 `publicReview:submit`。

### 备份（回滚锚点）

| 类型 | 路径 |
|---|---|
| H5 整目录 | `/www/wwwroot/sh.scqfls.cn/h5.bak.20261106-162927` |

回滚：`python scripts/prod-deploy-p01.py --rollback 20261106-162927`
（整目录互换，秒级；无 SQL、无容器重启）

### 上线验收（实测，非推断）

发布前**业务分支级**语义对比（非字符串计数）：19 条判据全 PASS；
`Success.setup` 与 Report 恢复函数切片与线上**逐字同构**；
变异测试证明未撤回版本会精确红 4 条。

生产浏览器验证 **14 / 14 通过**（真实 Edge + 生产产物）：

| 项 | 结果 |
|---|---|
| index.html 引用新产物 | `index-BG5kVB0x.js` / `index-DBQ7A3d6.css` |
| 线上 JS 内容哈希 | 与本地发布件逐字节一致 |
| 标签 | 「维修措施\*」（星号恒显） |
| 提示文案 | 必填，至少 5 个字。请写清检查情况、做了哪些维修操作、最终处理结果。 |
| 计数布局 | `5 / 500` 单独一行右对齐（`.svc-note-help`） |
| 纯空白 | 计数 `0 / 500`，按钮置灰 |
| 4 个有效字 | 按钮仍置灰（不足 5 字） |
| 5 个有效字 | 解除置灰 |
| 旧文案 | 页面无「处理说明」 |
| 数据影响 | **全程无写请求**，未创建任何维修记录 |

### 遗留

- **实际维修提交与门店查看，等待下一次正常业务自然确认**（本轮不造测试工单）。
- 后台静态 JS 无内容指纹 ⇒ 运营/用户需刷新才能看到新界面（H5 侧已 `no-store`，无此问题）。
- 电话/门店直接解决分支的旧「处理说明」校验未动，已登记 BACKLOG（见 `docs/BACKLOG.md`）。
