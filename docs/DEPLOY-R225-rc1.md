# R2.2.5-rc.1 · 上门服务业务操作闭环

| 项 | 值 |
|---|---|
| 版本 | `r2.2.5-rc.1` |
| 提交 | `ab5cc72` |
| 分支 | `release/r2.2.0-fusion` |
| 插件源码指纹 | `f792e31761b45282f1b16b7410614b9fac274056eb14c9bd8801f349fd54a231`（235 文件） |
| 构建时间 | 2026-11-26T08:54:31.978Z |
| 生产部署 | **未执行**（等授权） |
| 历史 Tag | `r2.2.4-rc.9` = `c6b7429`，**未移动** |

---

## 一、§二 实际日期保存失败的根因与修复

### 根因（不是校验问题，是请求从未发出）

`src-mobile/src/pages/ArchiveEdit.tsx` 里用了 `await confirm.ask()`，
但**忘了把 `{confirm.node}` 挂进 JSX**。`ask()` 返回的 Promise 永远 pending：

```
用户点「保存」→ ask() 挂起 → 请求队列停在这一步 → 按钮转圈
→ 用户以为"保存失败/报错" → 实际 archiveUpdate 一次都没发出去
```

这也是为什么"改别的字段也像坏了"、而"有时又能保存"（其他入口不经过 confirm）。

### 修复

一行：把 `{confirm.node}` 渲染进组件树。**没有动任何校验。**

- 服务端 `parseDateOnly` 的 400 校验**保留**（`'Invalid date'` ⇒ `ARCHIVE_BAD_DATE` 中文提示）
- 前端表单校验**保留**
- 失败时**保留表单内容**（`confirm` 关闭但 state 不清空）

### 判据

`.probe/r225-e2e-date-save.mjs` **21/21 PASS**，含变异测试：
摘掉 `{confirm.node}` 重建 ⇒ 4 项立刻变红（`service_date` 为空、无 `archiveUpdate` 请求记录、
未回详情页、请求体无 `service_date`）；还原 ⇒ 21/21。

---

## 二、业务操作流程实现说明

### 状态机（复用既有，未新建）

```
pending / scheduled ──archiveStart──▶ serving ──archiveComplete──▶ completed
        └──────────────────── archiveComplete（补录，直接完成）──────┘
```

- `ARCHIVE_STATUS` 常量**未改**；`serving` 此前**没有任何写入点**，本轮补 `archiveStart`。
- **不恢复**草稿 / 已发布等展示状态（`visibility` 与 `status` 依然独立）。

### 服务端（两个沉默缺陷，详见 `docs/DEVIATIONS.md` DEV-R225-02）

| 缺陷 | 现象 | 根因 | 修法 |
|---|---|---|---|
| A | `svc:archiveStart` 恒 404 | 常量进了 `SVC_ACTION` 却没进 `AUTHENTICATED_SVC_ACTIONS` ⇒ handler 从未注册 | 补进注册表；注册计数 87 → **88** |
| B | `svc:archiveComplete` 照片齐全仍恒 409 `ARCHIVE_STALE` | `IN (:from)` 传**字符串**被整体转义成 `'''pending'',''serving'',''scheduled'''` ⇒ UPDATE 恒 0 行 | 改传**数组** `[...ALLOWED_FROM]` |

> 缺陷 B 被 `ARCHIVE_STALE`（"数据已更新，本次操作未保存"）的文伪装成并发冲突 ——
> 这正是它藏了两轮的原因。教训已写进 DEVIATIONS。

其它服务端约束：

- `complete()` 用 **`COMPLETABLE_FROM = [pending, serving, scheduled]` 正面列举白名单**（不写"非 completed 即可"）。
- `service_date` 走与 `archiveUpdate` **同一个** `parseDateOnly`。
- `service_date = COALESCE(:serviceDate, service_date)`：没带就保持原值，**不刷新成今天**。
- **`archiveUpdate` 依然不认 `status` / `completed_at`**（断言行：塞了也 400 / 不生效）。
- 补录失败**不留半截**：断言 `status` 仍 `pending`、`completed_at` 为空、`version` 未推进。

### 移动端

**`QFServiceActionSheet`**（`components/qf/service-action.tsx`，新建）

四态一个组件：`start` / `complete` / `backfill` / `edit`。

- 日期初值**只有两级**：`已记录 service_date` → `今天`。
  **绝不**拿计划日期兜底 —— 那等于凭空制造"客户 11-28 上过门"（用户 §二 明令不伪造）。
- 服务前 / 服务后**两个独立入口**，`photo_type` 写死在各自的 `PhotoSlot` 里，
  **必填无默认值**（少传编译不过），**不按上传顺序 / 文件名 / 内容推断**。
- `edit` 分支**只调 `archiveUpdate`**，从不调 `archiveComplete`
  ⇒ 完成时间**结构上改不动**，不需要靠"记得别改"来保证。
- 提交按钮在照片不足时**禁用 + 明确中文**：「完成服务需要服务前、服务后各至少一张照片。两类都还没有。」

**`QFPlannedDateSheet`**：只发 `planned_date` + `expected_version`，不碰状态。

**详情页底栏**（按状态给业务操作，`ArchiveDetail.tsx`）

| 状态 | 左（次） | 右（主） |
|---|---|---|
| 待服务 | 修改计划 | **开始服务** ＋ 文字链「补录服务结果」 |
| 服务中 | 添加照片 | **完成服务** |
| 已完成 | — | **修改服务记录** |
| 暖通 | 查看阶段照片 | **完成「<阶段名>」**（读 `stageNameOf`，六阶段全完成则改为陈述句，不显示假按钮） |
| 只读角色 | 无按钮，纯文本提示 | — |

**「编辑档案」从底栏移到导航栏右侧**，只负责基础资料。

**列表页**：四段进度筛选（全部/待服务/服务中/已完成）+ 卡片快捷操作
（开始服务 / 完成服务 / 查看记录），**只打开面板，不直接改状态**。
`STATUS_GROUP` 把员工端三档展开成库内多值（`completed` 吸收 `accepted`）。

### 视觉（§四 合规）

- 主按钮：`--radius-svc` 一族的**适度圆角矩形（10px）**，非胶囊；经典 iOS 蓝。
- **无毛玻璃 / 无 Liquid Glass / 无圆球按钮** —— 为此专门修了 Konsta `right` 槽位的 Glass
  （R2.2.2 只修了 `leftClassName`，见 DEV-R225-03 ③）。
- 底栏 `sticky bottom-0` + `pb-safe`；内容留白 `148px`（实测底栏 125px）。

---

## 三、验收结果

| 门禁 | 结果 | 覆盖 |
|---|---|---|
| `.probe/r225-service-closure.mjs` | **29/29 PASS** | 服务端全链路 + 5 组会红对手 |
| `.probe/r225-ui-acceptance.mjs` | **52/52 PASS** | 390px 真实页面，真实网络，10 张截图 |
| `.probe/r225-e2e-date-save.mjs` | **21/21 PASS** | §二 日期保存 + 变异测试 |

### 七场景对照

| # | 场景 | 结果 |
|---|---|---|
| ① | 计划 11-28 / 实际 11-26 能保存 | PASS（两列独立，`status` 不联动） |
| ② | 待服务 → 开始服务 → 服务中 | PASS（真实调 `archiveStart`，进度条到第 2 步） |
| ③ | 前后照片从正确入口上传、分类正确 | PASS（`photo_type` 精确匹配，双入口各 1 张） |
| ④ | 服务中能完成、缺照片中文提示 | PASS（按钮禁用 + 「服务前、服务后各至少一张」） |
| ⑤ | 待服务可补录完成 | PASS（一次填完直接 `completed`，不经过假的"服务中"） |
| ⑥ | 已完成授权纠错、状态与完成时间不变 | PASS（`completed_at` **逐字符相同**，`netReq` 证明**未调** `archiveComplete`） |
| ⑦ | 暖通详情直接进下一阶段 | PASS（按钮名读配置，`完成「现场勘察」`） |

### 截图（`03-验收截图/`，均 390px 真机视口）

```
01-保存确认面板.png          02-待服务详情.png
03-开始服务面板.png          04-服务中详情.png
05-完成服务面板-缺照片提示.png  06-完成服务面板-照片齐全.png
07-已完成详情.png            08-暖通下一阶段入口.png
09-暖通阶段完成面板.png        10-列表页进度筛选.png
```

---

## 四、部署说明（**本轮不执行**）

### 改动文件（11 个）

| 文件 | 改动 |
|---|---|
| `nocobase/plugins/service-ticket/src/server/constants.ts` | +20：`ARCHIVE_START` 进 `AUTHENTICATED_SVC_ACTIONS` |
| `.../server/actions/svc/archive.ts` | +100：`archiveStart` handler；`archiveComplete` 接 `service_date` |
| `.../server/services/archive-service.ts` | +225：`startService`；`COMPLETABLE_FROM`；两处 `IN(:x)` 改数组 |
| `src-mobile/src/api/archives.ts` | +132：`startService` / `complete` / `attachServicePhoto`；`STATUS_GROUP` |
| `src-mobile/src/components/qf/service-action.tsx` | **新建**（四态面板 + 计划日期面板） |
| `src-mobile/src/components/qf/index.ts` | +15：导出 |
| `src-mobile/src/components/qf/list.tsx` | +41：卡片 `quickAction` |
| `src-mobile/src/pages/ArchiveDetail.tsx` | +832：进度条、底栏分支、面板接线 |
| `src-mobile/src/pages/ArchiveEdit.tsx` | +28：**`{confirm.node}` 修复** |
| `src-mobile/src/pages/ArchiveList.tsx` | +146：进度筛选 + 快捷操作 |
| `src-mobile/src/components/AppShell.tsx` | +14：`rightClassName` 去 Glass |
| `docs/DEVIATIONS.md` | +267：DEV-R225-02 / DEV-R225-03 |

合计 **+1733 / -87**。

### 部署步骤（获授权后执行）

```bash
# 1. 插件产物 → 生产 bind mount 目录（换 4 个入口文件）
#    dist/{client/index.js, client-v2/index.js, server/index.js, package.json}
# 2. 移动端产物 → src-mobile/dist/（index.html + assets/*）
# 3. docker restart scqf-as-app        # 必须 restart，up -d 不会重启
# 4. 等 healthy（约 30–35s）
# 5. 回读核对哈希（不信任 scp 返回值）
```

> ⚠️ `scripts/deploy-s6-remote.py` 的 `LOCAL_DIR` 必须指向**本包 `01-插件产物/`**，
> 不能指向任何 `backups/` 目录（DEV-REL-01）。
> ⚠️ 后台静态 JS URL 无内容指纹 ⇒ 部署后**必须强刷**。

### 本轮明确未做

- 未新增数据库迁移（`service_date` 列在 `202611241-service-date` 里已存在）
- 未改售后维修工单业务、客户 H5、照片 ACL、全局 Token
- 未启用客户档案查询短信
- 未向任何真实档案注入测试数据（全部用例建在本地隔离环境）

---

## 五、已知遗留（B 类，不阻塞）

| 编号 | 内容 |
|---|---|
| `P6-API-DTO-SENSITIVE-01` | DTO 下发 `feedback_token_hash` / `progress_token_hash`（哈希非明文） |
| — | 后台静态 JS 固定 URL 无内容指纹 |
| `DEV-RC9-01` | `archivePhotoThumb` 单次 404，未复现 |
| — | `access_log off` 覆盖同块前置 `access_log`（本轮未修） |
