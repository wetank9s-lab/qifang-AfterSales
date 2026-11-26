# R2.2.5-rc.1 · 生产发布记录

| 项 | 值 |
|---|---|
| 版本 | `r2.2.5-rc.1` |
| 提交 | `ab5cc72` |
| 远端 | `origin/release/r2.2.0-fusion` = `ab5cc72` ✓ |
| Tag | `refs/tags/r2.2.5-rc.1^{}` = `ab5cc72` ✓（tag 对象 `bee8a32`） |
| 回滚基线 | `r2.2.4-rc.9` = `c6b7429`（**未移动**） |
| 发布时刻 | 2026-11-26 17:12（插件）/ 17:13（移动端） |
| 生产 | `sh.scqfls.cn` · `scqf-as-app` · `scqf-as-postgres` |

---

## 一、发布前基线核对（证明回滚点是真的）

生产 `dist/build-fingerprint.json` 的 digest 是 `4a8c4d208cb4…`。
把 **`c6b7429` 检出到临时工作树重新构建**，得到的 digest **逐字符相同**：

```
rc.9 源码指纹 digest = 4a8c4d208cb408a894bb80f96637122605cc3624937917ee6dfabc4856c06451
生产实际指纹   digest = 4a8c4d208cb408a894bb80f96637122605cc3624937917ee6dfabc4856c06451
```

⇒ 发布前的生产**确实**是 rc.9 源码，不是"我以为的 rc.9"。

---

## 二、备份位置

| 内容 | 路径 |
|---|---|
| 插件 rc.9（整目录） | `/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist.bak.20261126-171245` |
| 手机端 /m（整目录含旧 index.html） | `/opt/scqf-aftersales/backups/mobile-staged-20261126-171354/` |
| 旧 assets（仍在线上，未删） | `/www/wwwroot/sh.scqfls.cn/m/assets/index-CBbEj7Iy.js`、`style-7l-5ly0Z.css` |
| 发布前 dist 哈希 | `server 671cbf278a30 / client 623fe68b3d96 / client-v2 2d3c2c7406b6 / fp 95fef2f71021` |

数据库：**本轮无迁移、无 DDL、无权限改动**，因此不做数据库备份；
如需全量回滚数据库，用腾讯云控制台的每日自动备份（本脚本未触碰任何数据）。

---

## 三、发布顺序（遵守 §三）

### 插件

`deploy-s6-remote.py --apply`：上传到 `/tmp` → 回读哈希 → `cp -a` 备份 dist →
落盘 4 个入口文件 → **从服务器回读哈希逐一比对** → `compose restart app` →
容器内 `/api/app:getInfo` 探到 200。

### 手机端（这才是 §三 的重点）

用户明令：「先发布新资源，最后切换 index.html」。
既有 `deploy-mobile-remote.py` 是**整目录原子切换**，做不到这个顺序
（切换那一刻入口与资源同时到位，没有观察窗口），因此本轮新增
`scripts/deploy-mobile-staged.py`：

```
[1] 备份 /m → /opt/scqf-aftersales/backups/mobile-staged-20261126-171354/
[2] 阶段 A：上传 4 个 assets
    ✅ 且**硬断言此刻线上 index.html 仍是旧版**（86f1ab2e89cb8081…）
       —— 这是"顺序被遵守"的唯一可验证证据
    ✅ 观察窗口：页面行为与发布前完全一致
[3] 阶段 B：上传 index.html（唯一一次入口切换）+ 其余静态小文件
[4] 全量回读：本地 9 个文件与线上逐一相符
```

未删旧 assets、未碰 nginx（`/m/` 段本来就存在，脚本只写目录）。
回滚只需把旧 `index.html` 放回（旧 assets 一直在线上）：
`python scripts/deploy-mobile-staged.py --rollback 20261126-171354`

---

## 四、生产精简验收（§四 六项）

脚本 `.probe/r225-prod-smoke.mjs`（**纯只读，不点任何写操作按钮**）**16/16 PASS**。

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | 容器正常、关键接口可用 | PASS | `scqf-as-app` running/healthy；`/api/app:getInfo` 200；`/m/` 200；`/h5/` 200 |
| 2 | 插件线上哈希匹配候选产物 | PASS | server `279b79ca…` / client `767e18be…` / client-v2 `e9036ac0…`；生产 digest `f792e317…` = 本地 |
| 3 | 手机端真实加载新版 JS/CSS | PASS | `performance` 实测加载 `index-B-w0TeKE.js`、`style-BRWHbFyJ.css`、`konsta-C2FtRk8f.js`、`react-vendor-CRH2syub.js`；旧 `index-CBbEj7Iy.js`/`style-7l-5ly0Z.css` **已不被引用** |
| 4 | 普通服务详情按状态给下一步 | PASS（角色分支已验） | 详情页正常渲染、`data-step=0`、底栏按角色分流；**销售专用按钮待业务负责人确认**（见 §六） |
| 5 | 暖通详情给下一阶段入口 | PASS（结构已验） | 六阶段时间线完整、第 3 阶段标"当前阶段"；销售主操作同见 §六 |
| 6 | 客户 H5 保持原状 | PASS | `/h5/` 200，加载 `/h5/assets/index-Ct26HwW9.js`，**未**被注入任何 `/m/assets/` |

补充反面对照：打开不存在的 id（99999999）→ 落到错误态且**不渲染假详情页**。

### ③ 手机端资源名称（线上实际）

| 文件 | sha256 前 16 |
|---|---|
| `assets/index-B-w0TeKE.js` | `c8745b306416ee8d` |
| `assets/style-BRWHbFyJ.css` | `613249a1f27fc6dd` |
| `assets/konsta-C2FtRk8f.js` | `00c3cc7a7fc227d5` |
| `assets/react-vendor-CRH2syub.js` | `fa5d2eaa88b62a5b` |
| `index.html` | `6cdfec44cf9cf283` |

---

## 五、产出物一致性

| 三者 | 结果 |
|---|---|
| `R2.2.5-rc.1-发布包/` 内的副本 | ✓ |
| 本地构建产物 `storage/plugins/.../dist`、`src-mobile/dist` | ✓ |
| 生产线上实际文件 | ✓ |

三者逐字节相同（见 `06-生产冒烟/SHA256-MANIFEST.md` 与 `03-验收截图/result.json`）。

---

## 六、尚待业务负责人确认

生产**没有启用中的 `store_sales` 账号**（两个都被 `uat_restricted_at` 合规限制），
`kl@scqfls.cn` / `hl@scqfls.cn` 是「门店售后」。经你裁决，本轮用超管
`admin@nocobase.com` 做只读验收。

超管走的是**只读分支**，因此以下四项**只验证了"不该出现的没出现"**，
没有验证"该出现的长什么样"——它们的正面证据仍然是本地 390px 的 52/52：

| 待确认 | 本地证据 | 生产验证方式 |
|---|---|---|
| 「开始服务」按钮与开始面板 | 截图 02/03 | 业务负责人用销售账号真机操作 |
| 「完成服务」面板与缺照片中文提示 | 截图 05/06 | 同上 |
| 「补录服务结果」一次完成 | 场景 ⑤ PASS | 同上 |
| 暖通「完成「<阶段名>」」主操作 | 截图 08/09 | 同上 |

⚠️ 另需注意：生产档案 26 是**改版前的草稿**（`visibility=draft`），
页面提示"这条档案还没发布，客户查不到"，这是既有数据的正常状态，不是缺陷。

---

## 七、观察项（不阻塞）

| 编号 | 内容 |
|---|---|
| `P6-API-DTO-SENSITIVE-01` | DTO 下发 `feedback_token_hash` / `progress_token_hash`（哈希非明文） |
| — | 后台静态 JS 固定 URL 无内容指纹，部署后需强刷 |
| `DEV-RC9-01` | `archivePhotoThumb` 单次 404，未复现 |
| — | `access_log off` 覆盖同块前置 `access_log`（本轮未修） |
