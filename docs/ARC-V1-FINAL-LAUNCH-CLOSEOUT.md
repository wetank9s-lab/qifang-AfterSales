# ARC-V1 · FINAL-LAUNCH-PROD 发布验收与备份缺陷收口

**归档日期**：2026-11-12
**状态**：生产功能验收 **PASS / 已正式接受**；发布工程发现 **1 项缺陷（备份同名覆盖）**，已修复脚本并补齐回滚链
**本轮约束**：未重启、未重新部署、未改生产数据库、未发真实短信、未新增业务功能

---

## 一、生产功能验收 PASS（用户已正式接受）

九项变更全部落地，验收全通过，**无需重新部署或重复业务测试**。

| # | 变更 | 结果 |
|---|---|---|
| 1 | `dist/server/index.js` | `bb041fa6…e4a15` · 1786206 B |
| 2 | `dist/client/index.js` | `833c1d93…74f29` · 624884 B |
| 3 | `dist/client-v2/index.js` | `a57f14a2…937f5` · 229239 B |
| 4 | `dist/build-fingerprint.json` | `1d1f29c1…a4d88` · 24648 B |
| 5 | `h5/archive.html` | `0939268b…9c08f` · 12838 B |
| 6 | `h5/archive-render.js` | `04d46eba…ba93` · 9253 B |
| 7 | `sh.scqfls.cn.conf` | `407dbf03…` → `8519fec2…` · 18419 → 19706 B（**原全前缀 403 保留**） |
| 8 | `PUBLIC_ARCHIVE_ENABLED=true` + `_QUERY_ENABLED=true` | 容器 env 实测 |
| 9 | `sms.scene.archive_verify.enabled=false` | 库读回 |

验收 A–H 全 PASS：查询返回 `total:1` + 零敏感字段；限流 `200/200/200/429`（`retry-after:60`）；
五个匿名 Action 经 Nginx 与直连 13000 **双路径全 403**；H5 真机 390px 全通；
原售后业务 `getInfo` / `publicStore:list` / `/` / `/h5/report` 均 200；数据零变化。

## 二、客户手机号摘要查询已正式上线

`POST /api/publicArchive:queryByMobile` 是**唯一**放行的匿名 Action（`=` 精确匹配，`limit_except POST`）。
实测：真实匹配号返回 `total:1`、`store_name=郫都康乐电器`、`archive_type=hvac`、`progress=ongoing`；
响应键集合恰为 `groups / mobile_masked / total`，无客户姓名、完整号码、地址、工单号、任何 Token。

## 三、ARC 短信 OFF，运营后续独立启用

生产侧 `sms.scene.archive_verify.enabled=false`，`sms_logs(scene='archive_verify')` 当日 **0 条**。
⇒ 当前 `sendCode` / `verify` / 验证码 H5 **仍关闭**。**仅改这一个开关不等于"验证码查询已启用"** ——
它同时受模板审核闸门（`SMS_TEMPLATE_PENDING_REVIEW`）约束，属运营后续的独立决策与独立发布。

## 四、发布工程缺陷：备份文件同名覆盖

### 4.1 缺陷形态

原 `step1_backup()` 用 `docker cp {C}:{remote} {BAKDIR}/dist/{os.path.basename(remote)}`。
三个 `index.js`（server / client / client-v2）basename 完全相同 ⇒ **落到同一个 `dist/index.js`，后者覆盖前者**，
最终只剩 1 份。**每次 `sha256sum` 都成功，三行都打印 ✅** —— 日志上无法区分"备份成功"与"只剩一份"。

### 4.2 旧版文件找回结果（按完整 SHA256，非文件名/大小）

用户给定的三条哈希**全部找到并核验通过**（另附 `server` 的 `243b8de8…`）：

| 文件 | SHA256（完整） | 字节 |
|---|---|---|
| `dist/server/index.js` | `243b8de84f5385399530aace46b5aea18bb7ad0ca088b992a52341f4defe05a6` | 1782154 |
| `dist/client/index.js` | `ca8159c3610556889cab79fc2f3fd07136b485ad70d7b0027017bbddd20b8ae9` | 624884 |
| `dist/client-v2/index.js` | `08dd0c6f52aa2ddb52ee0d2891423cfddf9000460e21db00e4d3691118218a59` | 229239 |
| `dist/build-fingerprint.json` | `955fd1f0a78f7a6c64e5d620819dcc1b6339d42ba5e4a7d2212120e3d3d16579` | 24648 |

**来源**：服务器 `/opt/b35r-uat/plugins/dist/`（B-35R 冻结包同一构建），全机按完整 SHA256 检索命中。
**归档位置**：`/opt/scqf-aftersales/backups/b35r-frozen-rollback-20261112/`
　　保留 `dist/{server,client,client-v2}/index.js` 层级 + `build-fingerprint.json` + `SHA256SUMS.txt`
　　建前 `test -e` 确认目录空闲；归档后 `sha256sum` 实测与清单 `diff` **4/4 逐字一致**；**未触碰生产文件**。

**判据纪律**：只按完整 SHA256 认定；**更早的 pre-B35R 备份不等于本次部署前的 B-35R 版本**，未被采用；
全程未伪造恢复、未用重新构建但哈希不符的产物冒充原文件。

### 4.3 生产当前状态（未因收口而变更）

只读核对三个生产文件哈希仍为 `bb041fa6…` / `833c1d93…` / `a57f14a2…` ⇒ **保持运行，无重启、无回滚**。
回滚说明已更正：`/root/arc-launch-20261112-205424/ROLLBACK-README.txt`
原"三项旧本体已不可获得"的结论已删除并补正，新增第五节「完整回滚到 B-35R（逐文件定位）」。

## 五、发布脚本永久修正（仅本地，本轮未再部署）

`deploy-arc-final.py` 五条硬约束落地：

| 要求 | 实现 |
|---|---|
| 每个文件独立相对路径 | `rel = remote.split('service-ticket/',1)[-1]` → `dist/server|client|client-v2/index.js` |
| 备份前检测目标已存在 | `test -e {dest}` 为 0 即抛 `BackupError`，**绝不覆盖已有备份** |
| 备份后核对 SHA256 | 三方比对：源 / 备份 / `expect_sha`（登记的旧值） |
| 任一备份失败即停止 apply | 收集**全部**失败项后一次性报告并 `fail()` 中止（防"看起来都 ✅ 其实只剩一份"） |
| 回滚逐文件定位 | `do_rollback()` 用相对路径还原；缺件**如实跳过并告警**，不猜、不替代、不扁平 |

**双向变异测试** `.tmp-media/launch/test-backup-fix.py`（内存假上下文，不碰生产）：

```
A 修复后  —— 4 次写入 / 4 个唯一路径；dist/server|client|client-v2 层级保留；
             四份哈希 = 各自源哈希；三个 index.js 互不相同（覆盖会退化成同一哈希）  → PASS
B 变异回旧写法 basename 扁平 —— 4 次写入只落到 2 个路径、4/4 份与源不符          → 必须变红，已变红
C 护栏 目标已存在 —— 抛 BackupError，已有备份内容未被改动                        → PASS
D 护栏 扁平目标   —— 抛 BackupError                                              → PASS
结论：全部 PASS
```

B 组的意义：**证明这套用例真有区分力** —— 修复退回旧写法时它确实会红，不是"怎么写都绿"。

> 修测试夹具的一次记录：A 组首轮 2 项 FAIL，原因是夹具用合成内容（`b'SERVER-OLD\n'*100`）
> 却拿**生产旧哈希**做 `expect_sha`，必然不等。这是**测试自身的 bug**，与被测代码无关；
> 已改为传夹具自身哈希。生产侧 `step1_backup` 传的是 `DIST_FILES` 登记的真实旧值，是正确的。

## 六、口径澄清：`queryByMobileV2`

`queryByMobileV2` 是**未注册的 Action**，直连 13000 返回 **404** —— 因为它在本产物里根本不存在
（`dist/server/index.js` 中该字符串计数 = 0）。
对照实验：`queryByMobileV2` / 随机不存在名 / `queryByMobile2` 三者 404 响应**逐字相同**；
`queryByMobile `（尾空格）返回 **400** 业务错误，说明路由确实在工作。

⇒ **不得将其记为"服务端 403 闸门成功"**。该项的正确表述是「未注册，404，非 2xx」。
真正的闸门证据来自**已注册的五个 Action**（`sendCode/verify/list/detail/photo`）：
Nginx 侧 HTML 403、直连 13000 侧 `403 + PUBLIC_ARCHIVE_ACTION_CLOSED`。

---

## 七、遗留与后续（独立、不阻塞）

1. `P6-API-DTO-SENSITIVE-01`：部分 DTO 下发 `feedback_token_hash` / `progress_token_hash`（哈希非明文）。
2. 后台静态 JS 固定 URL 无内容指纹 ⇒ 部署后必须强刷；建议加指纹或 `Cache-Control`。
3. 短信宝通道**无送达回执接口** ⇒ `DELIVERY CALLBACK` 属产品限制而非待修 bug（见 DEV-204）。
4. 运营后续独立启用验证码查询时，须同时满足模板审核通过 + 场景开关开启 + 重跑限流/闸门验收。
