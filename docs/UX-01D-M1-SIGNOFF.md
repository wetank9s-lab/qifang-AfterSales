# UX-01D M1 最终签收补证报告

> 日期：2026-10-17 · 状态：**UX-01D M1 = PASS / FROZEN（用户 2026-10-19 正式裁决）**
> （本报告提交时的状态是"补证完成、申请最终 PASS"；裁决于 2026-10-19 下达。）
> UX-01C 核心配置 PASS/FROZEN · UX-MEDIA-01 PASS/FROZEN · P11-5 PASS/FROZEN · UX-01B / P11-4 原 PENDING 保留 · Phase 11 IN PROGRESS · Release HOLD
>
> **未 commit / 未 push。** 未进入 M2，未扩大 M1 产品范围。
> 本报告只覆盖你指定的三项签收缺口 + 版本状态核查。

---

## 一、预览双重鉴权（缺口 #1）

### 1.1 审查结论：**原实现不满足要求，已做最小安全修复**

M1 初版把"读草稿"放在**匿名接口** `POST /api/publicUiTheme:preview`，只校验 HMAC + 过期 + revision。
缺的正是"是谁在看"：

| 要求 | 初版 | 现在 |
|---|---|---|
| 已登录 | ❌ 匿名可调 | ✅ 受控动作，`loggedIn` ACL |
| 角色 | ❌ 不检查 | ✅ `CAPABILITY.ADMIN`（hq_admin） |
| 签发者绑定 | ❌ 不检查 | ✅ `payload.u === actor.userId` |
| 短时凭证 | ✅ | ✅ |
| revision 绑定 | ✅ | ✅ |

**修复方式（最小面）**：
1. 新增受控动作 `svc:uiThemePreviewDoc`（登录 + ADMIN + 签发者 + revision），凭证只从 **POST body** 读；
2. **删除**匿名预览接口（`publicUiTheme:preview` 现为 **404**），匿名面只剩"读已发布快照"的 `get`（白名单 20 → **19** 条）；
3. 后台（登录态）消费凭证后，只把 `doc` 用同源 `postMessage` 交给 iframe ——
   **凭证从此不进入 H5 匿名上下文**（比"藏在 URL 里"更强）。

### 1.2 定向门禁结果：`verify-ux-01d-preview-auth.mjs` **21 / 21**

| # | 用例 | 结果 |
|---|---|---|
| 1 | hq_admin 本人 + 有效凭证 | **200**，返回草稿（非已发布），合成门店，revision 一致 |
| 2 | 退出登录（无 Authorization）持原凭证 | **401** |
| 3 | `store_after_sales` 持原凭证 | **403** `FORBIDDEN`（缺少权限：admin） |
| 3 | `viewer` 持原凭证 | **403** `FORBIDDEN` |
| 4 | **另一个 hq_admin**（临时给 `uat.hq@svc.local` 授 hq_admin）持**别人签发**的凭证 | **403 `PREVIEW_ISSUER_MISMATCH`** |
| 5 | 草稿 revision +1 后，旧凭证 | **409 `PREVIEW_STALE`** |
| 6 | 篡改凭证 | **401** |
| 6 | 过期凭证（签名由 `SIGN_SECRET` 正确签名） | **401** |
| — | 旧匿名预览接口 | **404**（已移除，不是"还在但拒绝"） |

> **测试隔离（必须说明）**：用例 4 需要第二个 hq_admin。做法是**临时**给 `uat.hq@svc.local` 插入
> `hq_admin` 角色 → 登录 → 验证 → **finally 删除并回查残留 0**；随后**重启 app 清 ACL 缓存**，
> 并用 `verify-ux-01d-config` 复验该账号已恢复为"读草稿 403"。最终库里该账号**只剩 `hq_after_sales`**。

### 1.3 凭证不进 URL / 日志 / Referer

- iframe `src` 固定 `/h5/report?uiPreview=1`（断言：不含凭证）；
- 采集到的凭证前缀在 **nginx access log：0 命中**、**应用日志（近 2 分钟，尾 400 行）：0 命中**；
- 凭证只存在于后台内存与一次 POST body。

---

## 二、`postMessage` 安全检查（缺口 #1 第二段）

| 方向 | 检查 | 实现 |
|---|---|---|
| 后台 ← iframe | `event.origin === location.origin` | ✅ |
| 后台 ← iframe | `event.source === iframeRef.current.contentWindow` | ✅（本轮补上；此前只查 origin） |
| H5 ← 父窗口 | `event.origin === location.origin` | ✅ |
| H5 ← 父窗口 | `event.source === window.parent` | ✅ |
| 后台 → iframe | `targetOrigin = location.origin`（非 `*`） | ✅ |
| 内容伪造 | 从 H5 **页面自身**发一条 `svc-ui-preview-doc`（`source === window`，不是 parent） | **被忽略**：品牌名未变（H5 门禁实断言） |

---

## 三、B-25 门禁漂移：根因与关闭（缺口 #2）

### 3.1 根因（对比 M1 前后）

| 时点 | 媒体区（`[data-testid=media-uploader]`）内 | 首次授权弹层 |
|---|---|---|
| **上一个提交（HEAD）** | `<p class="svc-hint svc-privacy-line">照片、录音和视频仅用于本次售后处理。</p>` | 同一句的加长版 |
| **M1 开始时的工作区** | 已换成**帮助条** `也可直接填写文字，任选一种即可说明问题。` | 保留用途说明 |
| **M1 之后** | 同上，只是改为 `v-if="showHelp"` + `{{ helpText }}` | 未改 |

**结论**：旧断言（要求媒体区唯一 `<p>` 是那句隐私说明）在 **M1 开始前就已经过期** ——
"常驻说明移除、用途告知移入授权弹层"是**同日更早的 UX-01B 整改**（该轮同样未提交）。
因为整条工作区未提交，`git show HEAD` 仍能看到旧行，**很容易误判成"M1 删了它"**。
M1 对该文件只改了 3 个 props（`helpText` / `showHelp` / `disabled`）与 `v-if` 绑定。

因此：**只改测试判据，客户页面一个字未改**（`MediaUploader.vue` 的上传机制、授权逻辑、DOM 结构均未动）。

### 3.2 新判据（正向）

1. 媒体区提示 == **当前生效配置**的 `copy.media_help`（默认值仍是原文）；
2. 四个入口（拍照 / 相册 / 录音 / 拍视频）都在且可点；
3. **首次授权弹层里的隐私用途说明始终存在**（与帮助条显隐无关）；
4. `verify-customer-media-ui` 的**设备档位**（Android 412 / iPhone 390 / 微信 390）都通过；
   注：这与 M1 要求的 375/390/420 **不是同一组宽度**，其中 375/420 未被该门禁覆盖 ——
   2026-10-19 已补定向验证 `verify-ux-01d-media-viewports.mjs`（**12/12**），见文末「签收后核查」。
5. 额外在 **UX-01D H5 门禁**里覆盖"配置隐藏帮助条"：隐藏后**只有帮助条消失**，
   四个入口仍可用、授权弹层用途说明仍在。

### 3.3 结果

- `verify-customer-media-ui.mjs`：**38 / 38 全绿**（此前 3 条红全部关闭）；
- `verify-ux-01d-h5.mjs`：**63 / 63**（新增 2 条"隐藏帮助条"对照断言）；
- 真机未验证项仍如实列出（iPhone/Android/微信内置浏览器），**不宣称真机通过**。

---

## 四、B-24 清理影响与测试隔离方案（缺口 #3）

### 4.1 做了什么（执行记录）

```sql
DELETE FROM api_guards WHERE scene='public_ticket' AND scope='mobile';
-- 返回：DELETE 3395
```

执行时间：2026-10-17 约 16:5x（UX-01D M1 首次执行 `verify-ux-01c-store-profile` 时被 429 卡住后）。
**没有整表清理**，其它场景/维度未触碰。

### 4.2 影响范围（可核实部分）

| 问题 | 事实 |
|---|---|
| 执行环境是否与真实客户隔离 | **是（未发布环境）**：`APP_ENV=development`、`PUBLIC_BASE_URL=http://localhost:8080`、自签证书、`server_name _`、无公网域名。真实客户没有入口 |
| 记录属于哪些场景 | **只有** `scene='public_ticket' AND scope='mobile'`（"某手机号当日提交次数"计数）。现存分组里 IP 限流、媒体上传、师傅 Token、评价等**均未受影响** |
| 是否包含实际客户请求 | **行级证据已不可恢复**（DELETE 无备份、该表无行级审计）⇒ **不可追溯**。**不推测"全是测试数据"**。<br>能说的只有：该表字段只有 `scene/scope/guard_key(哈希)/window_start/counter/expires_at`，**即使行还在也无法对应到具体客户或工单**；且该环境没有真实客户入口 |
| 是否影响现存限流安全边界 | **阈值与守卫代码未改**（`security.ticket_phone_daily_limit` 仍为 5）。被清掉的是**已有计数**：效果仅限"今日已到上限的号码可再提交一次"；IP 限流、重复单检测、隐私同意、上传限额全部不变 |

### 4.3 今后测试隔离方案（最小改动，不改阈值/不绕守卫）

1. **每次运行唯一手机号**（已在本轮 H5 门禁落地）：`139` + 运行时间后 8 位；
2. 或登记**专用测试号码段**并在 finally 清该号码计数；
3. 若必须复用固定号码：**等真实限流窗口恢复**（次日 0 点），不得改阈值。

> `verify-ux-01c-store-profile` 属冻结模块，本轮**未改其门禁**；建议在其所属阶段按方案 1 调整。

---

## 五、UAT 发布版本与当前有效配置（缺口 #4）

| 项 | 事实 |
|---|---|
| 版本数量 | **85**（v1–v85）。比上次报告的 51 多，是**本轮补证反复执行门禁**（含三次变异/回滚）产生 |
| 是否删除 | **没有删除任何版本**（设计要求历史不可改写） |
| 环境隔离 | `APP_ENV=development`、`PUBLIC_BASE_URL=http://localhost:8080`、无公网域名、自签证书 ⇒ **无真实客户访问** |
| 当前最新快照（v85） | 名称「四川七方连锁售后服务平台」· 主题 `classic-blue` · 帮助条显示 · 副标题空 ⇒ **= 改造前默认展示**，与 `DEFAULT_UI_DOC` 逐字段一致 |
| 恢复方式 | 需要恢复时用 **`svc:uiThemePublish` 再发一版**（本轮即如此）；**不使用 UPDATE 改历史** |
| 故障测试在哪里跑 | 本轮所有发布/回滚/原子失败测试**只在本机 UAT 容器**执行；生产未部署、未触碰 |

---

## 六、实际修改、针对性测试、Git 与密钥审计

### 6.1 本轮（签收补证）改了哪些文件

| 文件 | 改动 |
|---|---|
| `server/actions/svc/ui-theme.ts` | 新增 `uiThemePreviewDoc`（登录 + hq_admin + 签发者 + revision） |
| `server/services/page-theme.ts` | `readPreviewUiTheme(db, token, expectedUserId)`：签发者绑定 + `ForbiddenError` |
| `server/actions/public/ui-theme.ts` | **删除**匿名预览动作（只留 `get`）；头部说明同步 |
| `server/constants.ts` | 新增 `uiThemePreviewDoc`；匿名动作 20→19 |
| `server/plugin.ts` | 资源形状只剩 `get`；移除 preview 实现 |
| `client/page-theme-model.tsx` | 凭证在后台消费后**只下发 doc**；接收 `ready` 时校验 `source === iframe.contentWindow`；`targetOrigin` 用明确 origin |
| `h5/src/pages/Report/index.vue` | 接收 `svc-ui-preview-doc`（只收内容，不收凭证）；保留 origin/parent 双校验 |
| `h5/src/ui-state.ts` / `h5/src/api/ui.ts` | 移除"凭证换草稿"的客户端路径（不再有匿名预览调用） |
| `scripts/verify-ux-01d-preview-auth.mjs`（新） | 21 条鉴权/日志/postMessage 断言 |
| `scripts/verify-ux-01d-config.mjs` | 匿名预览改为"接口已移除 404 + 受控动作未登录 401"（27/27） |
| `scripts/verify-ux-01d-h5.mjs` | 预览改走受控动作 + doc 下发；伪造消息被忽略；隐藏帮助条对照断言；夹具手机号每次唯一（63/63） |
| `scripts/verify-customer-media-ui.mjs` | B-25 判据更新 + 四入口/授权文案断言（38/38） |
| `scripts/verify-plugin-load.mjs` | 匿名白名单 20→19、形状 `['get']` |
| `docs/SECURITY.md` / `docs/API.md` / `docs/UX-01D-DESIGN.md` | 预览消费端与传输契约按实现改写 |
| `docs/BACKLOG.md` | B-24 补调查结论与隔离方案；B-25 **CLOSED** |

### 6.2 门禁

| 门禁 | 结果 |
|---|---|
| `verify-ux-01d-preview-auth.mjs`（新） | **21 / 21** |
| `verify-ux-01d-config.mjs` | **27 / 27** |
| `verify-ux-01d-h5.mjs` | **63 / 63** |
| `verify-customer-media-ui.mjs` | **38 / 38**（B-25 关闭） |
| `verify-plugin-load.mjs` | **82 / 82**（匿名 19 条、24 张表） |
| `verify-ux-01d-publish.mjs` | **29 / 29**（本轮未改发布路径；证据沿用当次运行） |

未重跑：UX-01C settings/store-profile/pages、UX-MEDIA-01、P11-5 —— 本轮改动不涉及它们的路径，
且这些冻结门禁在上一轮已全绿（29/0、71/0、26/0、58/0）。

### 6.3 Git 与密钥

- **未 commit / 未 push**；暂存区为空；`git diff --check` 干净。
- 密钥审计（10 个本轮相关源文件）：**0 处硬编码凭证/JWT**；门禁脚本的 `SIGN_SECRET` 一律从 `.env` 读取，
  只用于构造"过期凭证"用例，不打印、不落盘。
- 未新增环境变量、未新增公开资源（反而**减少**一条匿名动作）。

---

## 七、结论

三项签收缺口已按裁决补齐：

1. **预览现在是"登录 + 角色 + 签发者 + 短时凭证 + revision"五重校验**，且凭证不进入 H5/URL/日志；
2. **B-25 已关闭**：确认是旧断言过期，只改判据，媒体页零改动，38/38 全绿；
3. **B-24 影响已核实到可核实的边界**：行级证据不可追溯这一事实如实写明，隔离方案已落地（唯一号码）。

**申请 UX-01D M1 最终 PASS。** 未进入 M2；Release 门禁仍 HOLD。


---

## 附：签收后核查（2026-10-19，用户要求的两项独立核查）

### 附 1. 正式角色管理流程撤权后的会话时效 —— **不是安全缺陷**

**调查（只读 + 一次可回滚的正式流程实验）**：

| 事实 | 证据 |
|---|---|
| 框架按请求取角色：`cache.wrap('roles:<userId>', …)` | `@nocobase/plugin-acl/dist/server/middlewares/setCurrentRole.js:56` |
| 角色关联变更会**清掉该缓存** | `plugin-acl/dist/server/server.js`：`rolesUsers.afterSave` / `afterDestroy` → `cache.del('roles:'+userId)` |
| 正式授权后，**已有会话**立即获得管理员能力 | 同一 token：403 → **200**（未重新登录） |
| 正式撤权后，**已有会话**立即失去能力 | 同一 token：200 → **403**（立即与 3 秒后均 403） |
| 最终角色/残留 | `uat.hq` 恢复为仅 `hq_after_sales`，`hq_admin` 行数 0 |

**结论**：走正式流程时，撤权对已有会话**立即生效**，不构成发布阻断缺陷。

**但发现一条运维禁令（已写入 `docs/SECURITY.md` §11）**：
**不得用 SQL 直接改 `rolesUsers`**。SQL 绕过 Sequelize 钩子 ⇒ `roles:<userId>` 缓存不清，
旧会话会一直保留管理员能力直到**进程重启**。（M1 签收补证期间我们正是用 SQL 删角色，
才观察到"要重启才失效"的假象；换成正式接口后立即失效。）

### 附 2. B-25 视口口径修正

- **实际门禁**：`verify-customer-media-ui.mjs` 用设备档位 **412 / 390 / 390**（Android / iPhone / 微信）；
  与 M1 要求的 **375 / 390 / 420** 不同 —— 375 与 420 **确实未被覆盖**，不只是记录错误。
- **处理**：不改冻结门禁（其档位语义是"设备模拟"），**只补定向验证**
  `verify-ux-01d-media-viewports.mjs`：375/390/420 各断言
  ①提示与生效配置一致 ②四入口可点 ③授权弹层隐私说明存在 ④无横向滚动 ⇒ **12 / 12 通过**。
- 截图：`.tmp-verify/ux01d-m1/media-375.png` / `media-390.png` / `media-420.png`。
