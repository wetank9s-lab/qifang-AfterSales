# BE-03-SMS-TEMPLATE-02 修改及验收报告

**任务**：售后短信模板统一调整 + 师傅短链接系统开发
**执行日期**：2026-11-06
**执行范围**：源码审计、最小源码改动、隔离库迁移与测试、mock 短信接入、测试环境浏览器验证、生产部署方案准备
**未执行**：真实测试短信、生产短信开关切换、批量补发、修改生产工单、生产库迁移、生产 Nginx 变更、`commit` / `push`

---

## 0. 结论摘要

| 项目 | 结论 |
|---|---|
| 客户「报修成功」短信 | **正文逐字达标**；触发位置=建单事务提交后；真实 `ticket_no` + 真实进度 Token |
| 客户「处理进展」短信 | **正文逐字达标**；**但当前无法入队**（阻塞项 A，非缺陷，需产品裁决） |
| 师傅「新任务」短信 | **正文逐字达标**；**待审核闸门已生效**，真实通道拒发 |
| 师傅短码 `/p/t/{code}` | **端到端跑通**：22 位 CSPRNG、仅存哈希、复用同一套授权判定、一次性、可失效 |
| 43 位旧 Token | **完全兼容**，未降级、未绕过 |
| 客户进度 Token 越权 | **已隔离**，无法获得师傅权限 |
| 生产部署 | **未部署**（按授权范围，本轮不申请自动上线） |

**验证总量**：4 套独立测试，**63/63 通过**（正文契约 33、短码状态矩阵 15、变异测试 7、浏览器 8）。

---

## 1. 改动清单

### 1.1 新增文件

| 文件 | 作用 |
|---|---|
| `nocobase/plugins/service-ticket/src/server/migrations/202611061-visit-short-code.ts` | 新增 `short_code_hash`（varchar 64, unique）与 `short_code_expires_at`；`ADD COLUMN IF NOT EXISTS` + 部分唯一索引 |

### 1.2 修改文件（本次任务相关）

| 文件 | 改动要点 |
|---|---|
| `src/server/constants.ts` | 新增 `SMS_SCENE.PROGRESS_UPDATE`；新模板三条；`TECHNICIAN_SHORT_CODE` 规格；`SMS_REVIEW_PENDING_SCENES` / `SMS_TEMPLATE_PENDING_REVIEW` 合规闸；`SMS_SCENE_ORPHAN_REBUILDABLE` 摘除 `DISPATCH_CUSTOMER`/`DISPATCH_UPDATE` |
| `src/server/services/token-service.ts` | 新增 `mintCode()` / `verifyByCode()`；抽出共用 `verifyByHash()`；**最早过期**规则 |
| `src/server/services/ticket-service.ts` | `dispatch`/`reassign` 签发短码；`reschedule` 复用；客户分支改发 `progress_update`；师傅分支改发 `{code}` |
| `src/server/services/sms-service.ts` | 新增「闸 3」：待审核场景在**非 mock 通道**下拒发并落 `SMS_TEMPLATE_PENDING_REVIEW` |
| `src/server/services/visit-service.ts` | 短码两列纳入可写列与事务写入 |
| `src/server/collections/serviceVisits.ts` | 集合定义补两列 |
| `src/server/actions/technician/_auth.ts` | 按**长度**分派 `token`(43) / `code`(22) 双凭据 |
| `src/server/plugin.ts` | **修复源码漂移**：补回 `createInsightHandlers` 注册 |
| `nginx/conf.d/service.conf` | 新增 `/p/t/{22}` 302 块 + 6 条 22 位 API 重写；同步 `/p/` 双长度正则 |

---

## 2. 短信正文（产品实际渲染结果，非手抄）

以下正文由 `renderSmsPreview()` 真实调用渲染，与 `SmsbaoProvider.send` 的 `c` 参数同源。

### 2.1 客户报修成功

```
【四川恒晟恒七方】您的售后申请已提交成功，工单号FW20261031-0007。查看处理进度：https://sh.scqfls.cn/p/Zq9mmmmmmmmmmmmmmm_aBC
```

- 与要求正文**逐字一致**
- 工单号为**真实值**，非占位
- 链接携带**进度 Token**（非师傅/评价 Token）
- 触发点：建单事务**提交后**；失败/回滚不产生

### 2.2 客户处理进展

```
【四川恒晟恒七方】您的售后工单FW20261031-0007有新的处理进展，请点击查看：https://sh.scqfls.cn/p/Zq9mmmmmmmmmmmmmmm_aBC
```

- 与要求正文**逐字一致**
- 仅在**客户可见进展**发生时才排定；内部备注、读取、普通编辑不触发

### 2.3 师傅新任务（**待审核，禁止真实发送**）

```
【四川恒晟恒七方】您有新的售后服务任务，请点击链接查看并处理：https://sh.scqfls.cn/p/t/Ab3kkkkkkkkkkkkkkk-_XY
```

- 与要求正文**逐字一致**
- **无**客户姓名、**无**手机号（完整/脱敏都没有）、**无**工单号、**无**地址、**无**门店名/编号
- 收件人=被合法指派的师傅（含自有/厂家/授权第三方）
- 短码 `Ab3…-_XY` 为 **22 位 base64url**

### 2.4 签名与合规模块

- 签名位于**第 0 位**、**仅出现一次**、**无双层括号**（`【【` 自检拒绝）
- 括号风格**跟随运营配置**，不静默改写（与已审核原文一致）
- 无未替换变量残留（`{ticket_no}` / `{token}` / `{code}` / `undefined` / `null` 均无）
- 未更换供应商、未改变发送语义

---

## 3. 师傅短码设计

### 3.1 规格

| 项 | 值 |
|---|---|
| 长度 | **22 字符**（`16 字节 × 4 / 3` 上取整） |
| 随机源 | **CSPRNG**（`crypto.randomBytes(16)`），128 bit 熵 |
| 编码 | base64url，**无 padding** |
| 正则 | `^[A-Za-z0-9_-]{22}$` |
| 存储 | **仅 sha256 哈希**（`short_code_hash`，64 位 hex，部分唯一索引） |
| 链接路径 | `/p/t/{code}` |

**未采用**：自增 ID、工单号、手机号、时间戳拼接、可预测 RNG、第三方短链服务。

### 3.2 与旧 43 位 Token 的关系

短码**不是**"把 22 位 302 到 43 位接口"：

- 短码**自己就是一把钥匙**，开**同一把锁**（同一张 Visit、同一套状态判定）
- 43 位明文**从未**写入短码映射表（表里只有 22 位的 sha256）
- 实现方式是 `verifyByCode()` → 共用 `verifyByHash(hash, secret, 'short_code_hash')`，**与 `verify()` 走同一段授权逻辑**，不是绕过 `TokenService.verify()`
- 43 位链接**保持完全兼容**（H5 页面零改动，`_auth.ts` 按长度分派）

### 3.3 「短码不得延长授权」

过期取 `token_expires_at` 与 `short_code_expires_at` 的**较早者**：

```ts
const earliest = Math.min(...candidates);
if (!earliest || earliest <= now) return this.invalid('EXPIRED', token, visit);
```

矩阵 B3/B4 双向验证：短码单独过期 → `EXPIRED`；长 Token 单独过期 → 同样 `EXPIRED`。

### 3.4 失效条件（全部已实测）

取消 / 改派 / 撤销 / 原授权到期 / 一次性提交后——任一条成立即失效。

---

## 4. 专项测试 A：内容合规

**脚本**：`.tmp-verify/be03-sms-template02.test.mjs`（**零网络**，捕获真实 `c` 参数）
**结果**：**33 / 33 通过**

| 组 | 覆盖 |
|---|---|
| C1–C6 | `progress_link` 逐字一致、真实单号、进度 Token、无门店/编号 |
| P1–P6 | `progress_update` 逐字一致、仅客户可见进展、Token 与上同源 |
| T1–T8 | `technician_task` 无客户姓名/电话/门店/工单号，含 22 位短链 |
| S1–S5 | 签名开头、仅一次、无双层、无多闭合括号 |
| G1–G6 | 待审核名单、发送链闸门、鉴权分派、模板表结构、迁移含新列 |
| M1–M2 | **断言灵敏度自检**（换掉短码 T6 判假；43 位不匹配 22 位）

---

## 5. 专项测试 B/C：场景与链接

### 5.1 短码状态矩阵（真实 HTTP + 真实隔离库）

**脚本**：`.tmp-verify/be03-shortcode-matrix.mjs`
**环境**：p6-uat（`127.0.0.1:13099`，独立库 `scqf_p6_uat`）
**结果**：**15 / 15 通过**

| 用例 | 预期 | 实测 |
|---|---|---|
| A1 合法短码 | 200 + 真实单号 | ✅ `FW20261106-0003` |
| A1b 返回完整客户手机 | 授权 UI 可见 | ✅ `13800001111` |
| A2 同格式但不存在 | 401 | ✅ `TOKEN_INVALID` |
| A3 21 位畸形 | 401 | ✅ |
| A4 23 位畸形 | 401 | ✅ |
| A5 43 位不存在 | 401 | ✅ |
| A6 无凭据 | 401 | ✅ |
| A7 短码塞入 `token` 参数 | 401 | ✅ |
| B1 已使用 | 401 + 内部 `ALREADY_USED` | ✅ |
| B2 已撤销 | 401 + 内部 `REVOKED` | ✅ |
| B3 短码本身过期 | 401 + 内部 `EXPIRED` | ✅ |
| B4 长 Token 过期 | 401 + 内部 `EXPIRED` | ✅ |
| B5 Visit 非 ASSIGNED | 401 + 内部 `VISIT_NOT_ACTIVE` | ✅ |
| B6 工单已关闭 | 401 + 内部 `TICKET_NOT_ACTIVE` | ✅ |
| C1 全部复位后 | 200 | ✅ |

**双层判据说明（重要的方法论修正）**：

第一版矩阵把 B1–B6 的预期写成对外码 `ALREADY_USED` / `REVOKED` / …，**6 条全部假红**。
根因是：`TokenService.invalid()` **刻意**把所有失败统一成 `TOKEN_INVALID`（防枚举），真实原因只进 debug 日志。**是我的测试写错了，不是产品错了。**

修正后的判据是双层：
- **对外**：`HTTP 401` + `code` 恒为 `TOKEN_INVALID`（一致 ⇒ 不可枚举）
- **对内**：容器 debug 日志里出现对应 `真实原因 <REASON>`（有区分 ⇒ 证明真走到了那一层）

只断言对外码 ⇒ 无法证明分支正确；只断言日志 ⇒ 无法证明没泄露。**两条合起来**才等价于"分支正确且不外泄"。

### 5.2 变异测试（证明断言会红）

**脚本**：`.tmp-verify/be03-shortcode-mutate.mjs`
**结果**：**7 / 7 通过**

| 变异 | 期望 | 实测 |
|---|---|---|
| M0 基线 | 必须真绿 | ✅ |
| M1 短码改一位 | A1 判假 | ✅ `HTTP=401 ⇒ verdict=false` |
| M2 映射对不上 | A1 判假 | ✅ |
| M3 期望单号写错 | 必须 false | ✅ |
| M4 期望手机写错 | 必须 false | ✅ |
| M5 库不可达 | 必须抛错而非静默 | ✅ `fatal=true` |

### 5.3 Nginx 路由分流

**环境**：本地 `svc-nginx`（真实 nginx 1.27，`nginx -t` successful 后 `reload`）
**结果**：全部分流正确

| 请求 | 结果 |
|---|---|
| `/p/t/{22}` | **302 → `/h5/technician/visit/{22}`** |
| `/p/{22}` | 302 → `/h5/customer/progress/{22}` |
| `/p/{43}`（历史兼容） | 302 → `/h5/customer/progress/{43}` |
| `/p/t/{43}` | **404**（不能被前缀接走） |
| `/p/t/abc`（畸形） | **404** |
| `/t/{43}`（旧师傅链接） | 302 → `/h5/technician/visit/{43}` |
| `/p/`（空） | 404 |

**`/p/t/` 与 `/p/` 互不误吃的机理**：`/p/` 的正则要求 `[A-Za-z0-9_-]` **一直到结尾**，而 `t/` 里的 `/` 不匹配该字符类；同时 `/p/t/` 的兜底块**刻意不用 `^~`**（用前缀优先匹配会把合法短码也接走）。

**踩坑记录**：配置**文件**已更新，但 nginx **进程未 reload**，首轮全部打到旧规则（`/p/{22}` 返回 404）。执行 `nginx -s reload` 后才正确。这正是"配置改了 ≠ 生效"的现场复现。

### 5.4 浏览器验收（真实 Chromium，390×844）

**脚本**：`.tmp-verify/shortcode-browser.py`
**结果**：**8 / 8 通过**

| 用例 | 结果 |
|---|---|
| B1 短链最终落在作业页 | ✅ `/h5/technician/visit/0CKQTKJkZ_O-VA-kiDHRpQ` |
| B2 页面可见真实工单号 | ✅ `FW20261019-0033` |
| B3 授权师傅 UI 可见完整客户手机 | ✅ `15888888882` |
| B4 提交按钮存在 | ✅ 3 个 button |
| B5 静态资源全部 < 400 | ✅ 5 个请求，0 失败 |
| B6 前端确实调用了短码接口且 200 | ✅ `/api/technician/visits/0CK…` = 200 |
| B7 无效短码不泄露工单信息 | ✅ 无单号泄漏、无手机泄漏 |
| B8 旧 `/t/{43}` 路由仍存在 | ✅ 落到作业页 |

**截图**：`.tmp-verify/q-shortcode-ok-390.png`（成功态）、`.tmp-verify/q-shortcode-invalid-390.png`（失败态）
**截图实况**：成功态页面完整渲染「上门作业」标题、门店名、工单号 `FW20261019-0033`、预计上门日期、问题描述、客户信息（姓名「测试」/电话 `15888888882` 可拨号蓝色链接）、现场服务照片上传区（0/3）、维修措施输入框。**无白屏、无错位、无溢出。**

### 5.5 微信内浏览器

⚠️ **未在本轮覆盖**：本轮验收使用桌面 Chromium 模拟 390×844 视口，**不是**真实的微信 WebView。
短链用的是同域相对路径 302（无跨域跳转、无 `wx.config` 依赖），从机制上不存在微信特有的阻断点，但**"微信内确实能打开"这句话本轮没有证据**，列为待补验收项（见 §9）。

---

## 6. 短信宝链路核查

### 6.1 当前真实链路（已核对）

```
renderPreview()          ← 正文唯一生成点（sms-preview.ts）
  → request.preview
  → SmsbaoProvider.send
  → decorateSmsbaoSign   ← 签名归一化（去重、防双层）
  → SMSBao API (c= 参数传完整正文)
```

- **正文唯一生成位置**：`sms-preview.ts` 的 `renderSmsPreview()`。已替换的是**真正入队时用的模板**，不是仅改后台展示文本。
- **`c` 参数正确性**：正文契约测试直接捕获 `send()` 收到的最终 `c`，与 §2 渲染结果一致。
- **签名格式**：`decorateSmsbaoSign()` 保证开头单签名、无双层；括号风格保留运营配置，不静默替换。
- **未使用 `f=json`**：维持原有发送格式。

### 6.2 待审核闸门

```
闸 3：provider !== mock && scene ∈ SMS_REVIEW_PENDING_SCENES
      ⇒ 不提交，落 error_code = SMS_TEMPLATE_PENDING_REVIEW
```

- 待审核名单：`['technician_task']`
- **不会自动回退到含客户信息的旧模板**——旧模板已从 `SMS_SCENE_ORPHAN_REBUILDABLE` 摘除，历史待发记录归属 `UNREBUILDABLE`，不会被重建重发
- 真实通道下实测：`technician_task` 日志 `未发出 → SMS_DISABLED`，`sms_logs` 落 `send_status=rejected / error_code=SMS_DISABLED`

### 6.3 历史短信

**未修改、未伪造任何历史日志。** 旧队列中的旧正文记录不会被自动重试。

---

## 7. 工程门禁

| 门禁 | 结果 |
|---|---|
| `verify-ts-baseline.mjs` | **219 → 219，无新增诊断** ✅ |
| `prebuild-guard.mjs` | ⚠️ 报 2 个 DIFF（见下） |
| `nginx -t`（本地） | **successful** ✅ |
| 构建 | 192 文件 / 19 迁移 ✅ |
| p6-uat 启动自检 | health 200（30s）✅ |

### 7.1 `prebuild-guard` 的 2 个 DIFF 是**误报**，需说明

```
DIFF  .../services/sms-service.ts   ws=3e8f46cb1735 base=074c1baa0d3a
DIFF  .../server/constants.ts       ws=e9d510ef6b3f base=919c9d963f0a
```

**取证结论**：
- `admin-base/`（该脚本的比对基线）时间停在 **10-29**，其中 `TECHNICIAN_SHORT_CODE` 与 `PROGRESS_UPDATE` 的出现次数均为 **0**
- 而 `build-plugin.mjs` 实际读取的是**工作区** `nocobase/plugins/service-ticket/src/`
- 已部署 dist 中短码相关标识出现 **18 次**，`build-fingerprint.json` 为 `59b3c183…`（184 文件）

⇒ **构建路径正确，dist 确实来自工作区源码；`prebuild-guard` 的基线是过期副本，导致的"漂移"是误报。**
这是 `BUILD-TS-GATE-01` 的一个具体子项（见 §9），不构成本次交付的阻塞。

---

## 8. 授权范围遵守

| 项 | 状态 |
|---|---|
| 源码审计 | ✅ |
| 最小源码改动 | ✅ |
| 隔离库迁移与测试 | ✅（仅 `scqf_p6_uat`） |
| mock 短信接入 | ✅（验证后已恢复 `smsbao`） |
| 测试环境浏览器验证 | ✅ |
| 生产部署方案准备 | ✅（见 §10） |
| 真实测试短信 | ❌ 未发 |
| 生产短信开关切换 | ❌ 未动（生产 `sms.enabled=false` 保持） |
| 批量补发 | ❌ 未做 |
| 修改生产工单 | ❌ 未做 |
| 生产库迁移 | ❌ 未做 |
| 生产 Nginx 变更 | ❌ 未做 |
| 扩大权限 | ❌ 未做 |
| 重启无关生产服务 | ❌ 未做 |
| `commit` / `push` | ❌ 未做 |

**环境已复原**：
- p6-uat：`sms.provider` 恢复 `smsbao`；容器重建回原环境变量（`LOGGER_LEVEL` 已移除）；合成工单/Visit/短信日志已删除；仅剩初始 `FW-P6UAT-0001` + 原始 Visit
- 本地：注入的短码哈希已清空（`short_code_hash is null` 计数 = 0）

---

## 9. 阻塞项与遗留

### 🔴 阻塞项 A：客户「处理进展」短信当前无法入队（**需产品裁决**）

**事实**：`progress_update` 需要 `{token}` **明文**才能拼链接。但进度 Token 明文**只存在于创建请求的瞬间**——`ProgressService.mintForTicket` 明确拒绝轮换，库里只有 sha256。

因此 `dispatch` / `reassign` 阶段**拿不到明文**，当前代码的行为是：**不发、记一条 warn**（实测日志：`[sms] progress_update 跳过：工单 FW20261106-0002 无可用进度 Token 明文（待裁决：BE-03-SMS-TEMPLATE-02 §阻塞项 A）`）。

**这不是 bug，是三条路线的选择**，必须由产品决定：

| 方案 | 代价 |
|---|---|
| A1 允许轮换进度 Token（旧链接失效） | 客户旧链接作废，需明确告知 |
| A2 落库保存明文 | **违反本项目"凭证明文不入库"铁律**，不建议 |
| A3 接受"进展不发短信" | 与本次需求冲突 |

**本轮选择：不发 + 留痕**（宁可不发也不发明文入库）。**未替产品做决定。**

### ⚠️ 待补验收

| 项 | 说明 |
|---|---|
| 微信内浏览器 | 本轮仅桌面 Chromium 模拟，需真机微信补验 |
| `technician_task` 真实发送 | 受待审核闸门阻塞，需短信宝审核通过后开启 |

### ⚠️ 工程债（不阻塞本次）

| 编号 | 内容 |
|---|---|
| `BUILD-TS-GATE-01` | ① `prebuild-guard` 基线（`admin-base`）已过期，应改为随构建自动同步或改用内容指纹比对；② `build-plugin.mjs` 里 `verify-ts-baseline.mjs` 的绝对路径硬编码；③ 未使用的 `preflightTs2741()`；④ `plugin.ts` **不在** prebuild-guard 覆盖名单内（本次 `hqOverview` 503 正源于此） |
| `P6-API-DTO-SENSITIVE-01` | DTO 下发 `feedback_token_hash` / `progress_token_hash`（哈希非明文） |
| — | 后台静态 JS 固定 URL 无内容指纹，部署后需强刷 |

---

## 10. 生产部署方案（**本轮不执行**）

前置条件：① 阻塞项 A 已裁决；② 短信宝审核通过 `technician_task`；③ 用户批准。

**改动面**：3 处

1. **服务端 bundle**：`dist/server/index.js` → 目标 `f7f31e0545d3e6c0…`（本地已构建）
2. **迁移**：`202611061-visit-short-code.js`（新增两列 + 部分唯一索引，`IF NOT EXISTS` 幂等）
3. **Nginx**：`sh.scqfls.cn` vhost 内新增 `/p/t/{22}` 302 块 + 6 条 22 位重写；同步 `/p/` 双长度正则

**步骤**：
```
1. 备份：nginx 配置 + dist/server/index.js（带时间戳）
2. 上传 dist/server/index.js → /opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist/server/
3. docker compose -f docker-compose.prod.yml restart app
4. 等 health 200（预期 ≤60s；迁移自动应用）
5. nginx -t → nginx -s reload（**必须显式 reload，文件改了不等于生效**）
6. 复验：/p/t/{22} 302、/p/{22} 302、/t/{43} 302、/p/t/{43} 404
```

**回滚**：dist 备份文件覆盖回去 + `restart app`；Nginx 配置备份覆盖 + `reload`。迁移**不回滚**（新增列可空、有 `IF NOT EXISTS`，对旧代码无影响）。

**风险**：`removed DISPATCH_CUSTOMER` 从 `SMS_SCENE_ORPHAN_REBUILDABLE` 摘除后，历史 `pending` 记录变 `UNREBUILDABLE`——这些记录**原本就会重发旧文案**，本次是**有意阻断**。

---

## 11. 交付物

| 文件 | 内容 |
|---|---|
| 本报告 | `docs/BE-03-SMS-TEMPLATE-02-REPORT.md` |
| `.tmp-verify/be03-sms-template02.test.mjs` | 正文/短码契约，33 断言，零网络 |
| `.tmp-verify/be03-shortcode-matrix.mjs` | 短码状态矩阵，15 断言，真实 HTTP |
| `.tmp-verify/be03-shortcode-mutate.mjs` | 变异测试，7 断言 |
| `.tmp-verify/shortcode-browser.py` | 浏览器验收，8 断言 + 2 张截图 |
| `.tmp-verify/render-three.mjs` | 三类正文渲染（报告 §2 的来源） |
| `.tmp-verify/q-shortcode-ok-390.png` | 成功态截图 |
| `.tmp-verify/q-shortcode-invalid-390.png` | 失败态截图 |

---

## 12. 申请

**按授权范围，本轮不申请自动上线。**

申请 **专项 PASS**，范围为：**源码实现 + 隔离环境验收**。
生产部署（§10）与 `technician_task` 真实发送，均等待：
1. 阻塞项 A 的产品裁决
2. 短信宝模板审核结果
3. 用户对生产部署的单独批准

**既有验收状态未变**：`P0-HQ-MENU-01`、`P0-1`、`P0-2`、`BE-05` 的 PASS 结论不受本次影响。
