# UX-01C 第八轮：短信通知管理交付报告

> 日期：2026-10-17 · 状态：P11-5 PASS/FROZEN · UX-MEDIA-01 PASS/FROZEN · UX-01C 服务时效 PASS/FROZEN · B-18 PASS/FROZEN · 门店资料管理 PASS/FROZEN · **UX-01C 短信通知 PASS/FROZEN（用户 2026-10-17 正式裁决）** · UX-01C 整体 IN PROGRESS · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD
> **未 commit / 未 push。** 全程 `mock` 通道，未向任何真实客户发送短信。

---

## 一、可配置参数 ↔ 真实消费点（逐项核实，不猜）

| 配置键 | 类型 / 取值 | 真实消费点 | 生效时机 |
|---|---|---|---|
| `sms.enabled` | bool | `sms-service.ts:509` `getBool` → `flush()` 每条判定；false ⇒ `rejected(SMS_DISABLED)` | 下一次发送（配置缓存 10s） |
| `sms.provider` | enum：`mock` / `aliyun` / `smsbao` | `sms-service.ts:296` `getString` → `createSmsProvider()`（按名字缓存实例） | 10s 内；切换后新实例生效 |
| `sms.retry_count` | int **0~1**（契约上限 1） | `sms-service.ts:510` `getInt` → 内联重试次数；`sms-retry-scheduler` 同源 | 下一次发送 |
| 服务商凭证 | **环境变量**（不入库） | `sms-provider.ts` 构造时读取：`ALIYUN_SMS_ACCESS_KEY_ID/SECRET/SIGN_NAME`、`SMSBAO_USERNAME/API_KEY/SIGN_NAME` | **需重启**（进程环境） |
| 模板 CODE | **环境变量** `ALIYUN_SMS_TPL_<SCENE>` | `SmsService.templateCodeFor()`；缺 ⇒ `SMS_TEMPLATE_NOT_CONFIGURED` | 需重启 |

> 没有消费点的其它短信参数（例如历史文档里提过的"发送策略"）**没有登记为可写项** ——
> 不制造"保存成功但业务不生效"的假设置。

### 通道真实能力（服务端判定）
| 通道 | 实现 | 当前状态 | 说明 |
|---|---|---|---|
| `mock` | ✅ | **可发送** | 不真实发送；写内存发件箱 |
| `aliyun` | ✅ | **不可发送（缺凭证 + 0/6 模板）** | 补齐 3 个凭证与 6 个场景模板后可发送 |
| `smsbao` | ✅（provider 有实现） | **不可发送（缺模板映射）** | `SMS_TEMPLATE_ENV_PREFIX` 无 `smsbao` ⇒ 每条都被模板闸门拒掉，见 DEV-207 |
| `tencent` | ❌ | **不展示** | 从未实现，已从描述/选项中移除 |

---

## 二、后台页面（仅 `hq_admin`）

「售后工单 → 短信通知」（`/admin/o4fx69lk2pb`）：
- **通道能力表**：实现 / 凭证（已配置或"缺 N 项"）/ 模板（已配数量）/ 可发送 / 原因；
- **三项配置**：开关、通道、重试次数，各带「修改」；
- **最近 20 条发送记录**：时间、工单号、用途、通道、结果、失败原因、脱敏号码；
- 顶部实时结论：`可发送 / 不可发送 + 原因`。

截图（两张，均取自真实浏览器）：

| 文件 | 状态 | 用途 |
|---|---|---|
| `.tmp-verify/ux01c-r8-sms-center.png` | 测试中（`retry_count` 暂为 0、右上角 422 提示） | 验证 422 中文提示与弹窗保持打开 |
| `.tmp-verify/ux01c-r8-sms-center-final.png` | **最终稳定态**（`enabled=已开启` / `provider=模拟` / `retry=1 次` / 20 条记录） | 交付主图 |

> 两张图上出现的红色 `No permissions` toast 与本页无关：那是 SPA 初始化请求
> `environmentVariables`/`attachments` 被平台元数据守卫拒绝所致，属既有 **B-17**（对任何业务角色都触发），
> 页面内容区判据已与它分离。

### 编辑行为（实测）
- 保存成功 ⇒ 提示「已保存：<中文名>」→ 重新读取状态 → 页面显示新值；
- 输入 `2` 次 ⇒ **422**「必须在 0 ~ 1 次之间」，弹窗保持打开；
- 通道切到 `aliyun`（缺凭证）⇒ **422 `SMS_PROVIDER_NOT_READY`**，值不被改动；
- 两管理员同 `expected_value` 并发 ⇒ **200 + 409**，只多一条审计；
- 同一 `X-Request-Id` 重放 ⇒ `replayed=true`，**不新增审计**；
- 恢复旧值 ⇒ 新写一条 `scene=restore` 审计。

---

## 三、权限与原生接口

- `svc:smsStatus` / `svc:updateSetting` / `svc:listSettingSpecs`：**hq_admin 200**；`hq_after_sales` / `store_A` / `viewer` **403**；匿名 **401**。
- **原生写全关**：`serviceSettings:update / destroy / create` 对业务角色 **403**，绕过尝试后值未变。
- **原生读未放宽**：`serviceSettings:list` 仍只回 **SLA 三键**（R5 冻结断言 29/0 保持）；
  短信配置只经受控 action 读取（`svc:smsStatus` 只回"是否配置/缺哪些键名"，**不回显凭证值**）。
- 非管理员**直访页面**被拒（路由未授权 → 404），不渲染任何配置。

---

## 四、真实消费验证（mock，不发真实短信）

1. **开启**（mock）→ 夹具工单派工 ⇒ 产生 `accepted` 记录：
   `dispatch_customer / mock / accepted / 137****4502`、`technician_task / mock / accepted / 139****0009`。
2. **关闭** → 等配置缓存 TTL（10s）→ 再派工 ⇒ 派工仍成功（业务不失败），
   短信记录为 `rejected / SMS_DISABLED`。
3. **重试次数被真实消费**（离线跑**真实** `SmsService.flush` + 注入失败 provider）：
   | `retry_count` | 供应商调用次数 | 记录 `retry_count` |
   |---|---|---|
   | 0 | **1** | 0 |
   | 1 | **2** | 1 |
   | 1 + 非传输错误（模板缺失） | **1**（不重试） | 0 |
4. 失败记录可在后台"最近发送记录"直接看到（`error_code` + `error_message`）。
5. 所有记录的手机号均为入库即脱敏的 `recipient_masked`；页面无正文、无 Token、无密钥。

> ⚠️ 关闭后派工的第一版判据曾失败：`ConfigService` 有 10s 缓存，关闭后立刻派工仍读到 `true`。
> 已在门禁里显式等待 TTL（不是实现问题；注释写清原因）。

---

## 五、旧描述迁移（§六）

库中 `sms.provider` 仍是旧默认描述「mock / aliyun / tencent」。新增迁移
`20261017-sms-setting-descriptions.ts`：

- **只改** `description` 与已知旧串**逐字相等**的行 → 更新为新描述；
- 运营改过的任何其它描述**不动**；幂等（再次执行 `updated=0`）；
- 实测：`共修正 1 行`，迁移后库中描述为「mock（模拟，不真实发送）/ aliyun / smsbao…」。

---

## 六、重启与持久化

重启后：三项配置值保持（`enabled=true / provider=mock / retry=1`），
`sms.retry_count` 审计条数不变，`svc:smsStatus` 仍 200。
所有测试夹具工单按 ID 清理（残留 0）。

---

## 七、门禁

| 门禁 | 结果 |
|---|---|
| `verify-ux-01c-sms.mjs`（新增） | **57 / 0** |
| `verify-ux-01c-settings-auth.mjs`（服务时效冻结） | **29 / 0** |
| `verify-ux-01c-store-entry.mjs`（B-18 冻结） | **36 / 0** |
| `verify-ux-01c-pages.mjs`（含新页面） | **26 / 0** |
| `verify-native-sensitive-fields.mjs` | **44 / 0** |
| `verify-plugin-load.mjs` | **82 / 0** |
| `verify-store-ui-primary-action.mjs` | **65 / 0** |
| `verify-ux-01a-final.mjs` | **15 / 0** |
| `verify-ux-01c-store-profile.mjs`（门店资料冻结） | **71 / 0** |

---

## 八、Git 与密钥

- **未 commit / 未 push**；暂存区为空；`git diff --check` 无空白错误；夹具残留 0。
- 本轮增量：
  - 新增 `services/sms-status.ts`、`client/sms-center.tsx`、`migrations/20261017-sms-setting-descriptions.ts`、
    `scripts/verify-ux-01c-sms.mjs`；
  - 修改 `actions/svc/config-settings.ts`（3 条规格 / bool+enum 校验 / 幂等 / 开闸守卫 / smsStatus）、
    `middleware/settings-read-scope.ts`（原生读仍只放 SLA 三键）、`constants.ts`（动作 / 场景标签）、
    `collections/configChangeAudits.ts`（幂等唯一索引）、`client/index.ts`、
    `scripts/{seed-admin-pages,ticket-page-actions,expected-indexes,expected-sensitive-columns}.mjs`、
    `docs/{API,SECURITY,DEVIATIONS,BACKLOG}.md`。
- 密钥审计：无新增口令/密钥字面量；**页面与响应均不含凭证值**；未写入真实客户资料。

---

## 九、PENDING（如实列出）

1. **真实阿里云/短信宝通道联调**：需要真实凭证 + 已审核模板 + 公网出口；
   当前只验证到"缺凭证/缺模板 ⇒ 明确不可发送"这一侧。**不宣称真实发送通过。**
2. **`smsbao` 端到端修复**（DEV-207 / BACKLOG B-19）：需决定模板策略，
   涉及发送行为变更，单独评审。
3. **送达回执展示**：`delivery_status` 已入库，本轮页面只展示状态与失败原因；
   回执明细查询（阿里云 MNS）未在页面开放 —— 不在本轮范围。
4. 未实现的短信参数（历史描述里的发送策略等）**不登记为可写项**，避免假设置。

---

## 十、验收裁决与收口（2026-10-17）

**用户裁决：PASS / FROZEN。** 认可范围：三项有真实消费点的设置、57/0 专项门禁、mock 发送与关闭后的
真实业务行为、重试次数的实际消费验证、422/409 与幂等/审计/恢复、凭证不回显、原生写入保护与角色隔离、
已冻结模块回归。

收口动作（**只做状态归档，不改已通过的功能**）：

| 事项 | 落点 |
|---|---|
| 三大模块 PASS/FROZEN 登记 | `docs/PROJECT-STATUS.md` §1/§2；`docs/PHASE-11.md` §0.1 指针 |
| B-17 升级为全局 **P1**（含三条修复硬约束） | `docs/BACKLOG.md` B-17 |
| B-19 保持独立待办（不因本页 PASS 关闭） | `docs/BACKLOG.md` B-19 |
| 真实通道联调 / 公网入口 = Release PENDING | `docs/PROJECT-STATUS.md` §4（R-1、R-2） |
| 库内 `tencent` 残留核查：**无残留，未改动任何描述** | `docs/PROJECT-STATUS.md` §6 |

**未 commit / 未 push**；工作区未提交改动全部保留。
