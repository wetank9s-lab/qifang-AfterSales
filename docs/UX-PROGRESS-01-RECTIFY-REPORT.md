# UX-PROGRESS-01 真机反馈整改与师傅电话展示报告

> 日期：2026-10-19（测试执行）· 状态：**PASS / FROZEN（用户 2026-10-19 正式裁决，见 §九）**
> 定向门禁 **93/93** · 变异 A/B 均变红 · DEV-209 20/20 · UX-LAST-ORDER-01 24/24
> （测试执行于 2026-10-19；§九 为裁决归档，未重新执行）
> 本报告**覆盖** `UX-PROGRESS-01-REPORT.md` §3「对客电话数据缺口」与 §10 的结论：
> 最终业务规则改为**直接使用 `serviceVisits.technician_mobile` 作为对客号码**，
> 不再新增 `customer_contact_phone` / `allow_customer_call` / 独立授权流程。
>
> 未 commit / 未 push。

---

## 一、师傅电话：来源与有效派工解析

### 1.1 最终规则（按你 2026-10-19 的裁决）

| 项 | 结论 |
|---|---|
| 号码来源 | `serviceVisits.technician_mobile`（**当前有效 Visit** 上那一行） |
| 是否新增字段 | ❌ 不新增 `customer_contact_phone` |
| 是否新增开关 | ❌ 不新增 `allow_customer_call` |
| 是否逐人授权 | ❌ 不做；派工即视为同意向**本工单客户**展示 |
| 是否迁移历史号码 | ❌ 不迁移；直接复用已有派工记录 |
| 派工短信/受理/师傅登录 | ❌ **一行未改** |

### 1.2 有效 Visit 的解析（唯一入口）

```ts
// server/services/progress-stage.ts
currentVisit(visits):
  visits 按 visit_no 降序
  → 取第一条 visit_status ∉ {SUPERSEDED, CANCELLED}
```

| 场景 | 返回 | 客户可见 |
|---|---|---|
| 首次派工 | Visit #1（ASSIGNED） | 师傅姓名 + 号码 |
| 改派 | Visit #2（新 ASSIGNED）；#1 已 SUPERSEDED | 只有新师傅；旧姓名/旧号码**不出现在响应任何位置** |
| 派工取消 / 工单取消 | null | 师傅卡整段不出现 |
| 待评价 / 已闭环 | 最新 `CONFIRMED` 的 Visit（`role='completed'`） | 「本次服务师傅」 |
| 厂家代处理（无姓名） | 该 Visit（name=null） | 显示"门店已安排服务人员"+ 有号码则显示号码 |

**号码格式必须校验**：`technician_mobile` 在派工入口只是 `optionalText`（无格式约束），
所以只认 `^1[3-9]\d{9}$`。门店填了座机 / "无" / 短号 ⇒ 当作"没有号码"，显示
「暂无师傅联系电话，请联系门店」——**不把错号做成 `tel:` 链接**。

### 1.3 隔离边界（"默认同意展示"≠"任意人可查"）

| 要求 | 实现 | 证据 |
|---|---|---|
| 必须持有效进度 Token | `resolveTicketId()` 四类失效统一 401 | 门禁 ⑩ |
| 只读本工单的师傅 | `filter: { ticket_id }` + 服务端字段投影 | 门禁 ⑦（不返回其它工单号码） |
| 改派后立即换人 | `currentVisit` 按 visit_no 取最新、跳过失效 | 门禁 ⑦ |
| 取消后隐藏 | 工单 CANCELLED ⇒ `technician=null` | 门禁 ⑧ |
| 不批量拿号码 | 未开放 `users:list` / `serviceVisits:list`；无新增匿名接口 | 本次未改权限/ACL |
| 不写日志/埋点/缓存 | 服务端不打号码；响应 `Cache-Control: private, no-store` | 既有约定未变 |

---

## 二、六项时间：各自来源与映射（真机问题 1）

### 2.1 数据来源核实结果

| 时间 | 真实来源 | 是否存在 | 页面缺失时 |
|---|---|---|---|
| 提交时间 | `serviceTickets.createdAt` | ✅ | — |
| 派工时间 | **当前 Visit** 的 `assigned_at` | ✅ | 「尚未派工」 |
| 预约上门时间 | 该 Visit 的 `expected_visit_at`（**只到天**，存 canonical 正午） | ✅ **有现成字段** | 「待确认」 |
| **实际到场时间** | **无任何字段**（全库无 `arrived_at` / `started_at`） | ❌ **缺口** | 「尚未记录」 |
| 师傅回执提交时间 | 该 Visit 的 `submitted_at` | ✅ | 「尚未提交」 |
| 门店确认时间 | 该 Visit 的 `store_confirmed_at` | ✅ | 「尚未确认」 |

### 2.2 明确不做的两件事

1. **不拿 `ticket.updatedAt` 冒充派工/上门时间** —— 门禁里有一条**常驻守卫**：
   把夹具的 `updated_at` 推到 +3 小时，`times.dispatched_at` 必须原地不动。
2. **不新增"到场打卡"流程**（未经评审）—— 所以实际到场恒为 `null`，页面显示"尚未记录"，
   并在报告里如实登记为缺口。

### 2.3 真机反馈的"时间混淆"如何解决

页面新增独立的「**服务时间**」卡片（`data-testid="progress-times"`），六行分别展示，
不再让客户从一条"处理进度"里猜哪个时间是上门时间。

---

## 三、五阶段点亮规则（真机问题 2：已派工 ≠ 已上门）

固定 5 个里程碑：**已提交 → 安排师傅 → 上门服务 → 门店确认 → 已完成**

| 阶段 | 阶段名 | 已提交 | 安排师傅 | 上门服务 | 门店确认 | 已完成 |
|---|---|---|---|---|---|---|
| `submitted` | 待门店安排 | done | **current** | todo | todo | todo |
| `store_handling` | 门店处理中 | done | **current** | todo | todo | todo |
| `dispatched` | 已派工 | done | done | **current** | todo | todo |
| `tech_submitted` | 待门店确认 | done | done | done | **current** | todo |
| `store_confirmed` | 待您评价 | done | done | done | done | **current** |
| `completed` | 已完成 | done | done | done | done | done |
| `cancelled` | 已取消 | done | todo | todo | todo | todo |
| 远程解决（无 Visit） | 待您评价 | done | **skipped** | **skipped** | done | current |

关键：

- **`dispatched` 时「上门服务」是 `current` 且 `at=null`** —— 表示"正在等待上门"，不是"已上门"；
- 阶段文案按定稿：`已安排王建国为您服务，请保持电话畅通`（**只说已安排**）；
- 师傅提交回执后：`待门店确认` + 真实回执时间，**不出现"已完成"/CLOSED**。

---

## 四、处理进度时间线整改（真机问题 3）

### 4.1 旧实现为什么会出现「重复的处理中 / 空标题」

旧代码直接拿 `to_status` 当标题：

```ts
status_label: TICKET_STATUS_LABEL[to_status]   // dispatched / reassigned / follow_up 都推 PROCESSING
```

⇒ 多个不同事件都显示"处理中"；`to_status` 为空的事件直接渲染成"只有时间没有文字"。

### 4.2 新映射（事件类型 → 客户可读事件名）

| 真实事件 | 客户看到 | 是否展示 |
|---|---|---|
| `created` | 工单已提交 | ✅ |
| `accepted` | 门店已接单 | ✅ |
| `transferred` | 工单已转交其他门店 | ✅ |
| `dispatched` | 门店已安排师傅 | ✅ |
| `reassigned` | 门店已更换服务师傅 | ✅ |
| `rescheduled` | 上门时间已调整 | ✅ |
| `technician_submitted` | 师傅已提交服务回执 | ✅ |
| `store_confirmed` | 门店已确认服务 | ✅ |
| `store_rejected` | 门店要求重新处理 | ✅ |
| `remote_completed` | 门店已通过电话处理 | ✅ |
| `reviewed` | 您已完成评价 | ✅ |
| `closed` | 服务已完成 | ✅ |
| `cancelled` | 工单已取消 | ✅ |
| `reopened` | 工单已重新打开 | ✅ |
| `sms_sent` / `sms_failed` | — | ❌ 内部 |
| `internal_note` / `follow_up` | — | ❌ 内部 |
| `metadata_corrected` | — | ❌ 内部 |
| 表里没有的值 | — | ❌ **不展示**（绝不渲染空标题） |

API 仍返回 `status` / `status_label`（兼容旧客户端与既有门禁），但页面渲染 `event_label`。

### 4.3 门禁证据

- 时间线每条 `event_label` 非空且 ≠ 英文枚举；
- 不含任何内部事件；
- 首条 = `created`；
- **事件名不重复**（"多条处理中"彻底消失）；
- 浏览器层再验一次：`li` 的 `.svc-progress-t` 非空。

---

## 五、验收结果

### 5.1 定向门禁 `verify-ux-progress-01.mjs`：**93 / 93**

覆盖你列的 14 条，另加时间与时间线专项：

| # | 场景 | 断言要点 | 结果 |
|---|---|---|---|
| 1 | 新工单未派工 | 无姓名、无号码、无 `tel:` | ✅ |
| 2 | 已派工 | 姓名 `王建国`；`phone=13900010001`；**号码来自 Visit 行**（与工单级冗余对比打印） | ✅ |
| 3 | 点击拨号 | `href="tel:13900010001"` 与显示文本**完全一致** | ✅ |
| 4 | 号码为空 | `phone=null` + 「暂无师傅联系电话，请联系门店」 | ✅ |
| 5 | 改派 | 新姓名 + 新号码；旧姓名/旧号码零命中；不返回其它工单号码 | ✅ |
| 6 | 取消 | `technician=null`，号码零命中 | ✅ |
| 7 | 远程处理 | 上门两步 `skipped`，阶段=待您评价 | ✅ |
| 8 | 师傅提交回执 | `tech_submitted_at` = `Visit.submitted_at`；未 CLOSED | ✅ |
| 9 | 派工时间 vs 门店处理时间 | `dispatched_at` = `assigned_at`；把 `updated_at` 推后 3 小时也**不漂移** | ✅ |
| 10 | 无预约数据 | 有 `expected_visit_at` 时显示日期；`arrived_at` 恒 null（"尚未记录"） | ✅ |
| 11 | 时间线 | 无空标题、无重复事件名、无内部事件 | ✅ |
| 12 | 无效/过期/跨工单 Token | 401 且不泄露号码 | ✅ |
| 13 | 375/390/420 | 无横向滚动、5 节点不换行 | ✅ |
| 14 | 原有 72 条 | 全部保留（只按新规则更新了"该显示号码"的 3 条断言语义） | ✅ |

### 5.2 两条反向验证（都真的变红）

| 变异 | 结果 | 红在哪 |
|---|---|---|
| **A. 把派工时间映射成门店更新时间** | **92 / 93（红）** | 「派工时间不随 `updated_at` 漂移」—— api 变成 `12:25:52`，`assigned_at` 仍是 `17:25:51` |
| **B. 返回历史师傅 / 其手机号** | **89 / 93（红）** | 改派场景 4 条：新师傅姓名、新师傅号码、`visit_no=2`、阶段仍"已派工"全部失败 |

还原后复跑：**93 / 93**（两次变异都先 `build-plugin` + `restart` 生效，再跑；不是改测试）。

### 5.3 回归

| 门禁 | 结果 |
|---|---|
| `verify-dev-209-progress-time.mjs` | **20 / 20**（时间字段映射未回退；时间线改事件后首条仍是 `created`） |
| `verify-ux-last-order-01.mjs` | **24 / 24** |

---

## 六、截图与设备

| 文件 | 内容 |
|---|---|
| `.tmp-verify/ux-progress-dispatched-390.png` | 已派工：阶段胶囊 + 5 节点 + **服务师傅 王建国 / 13900010001** + 服务时间六行 |
| `.tmp-verify/ux-progress-dispatched-375.png` | 同上，375px |
| `.tmp-verify/ux-progress-dispatched-420.png` | 同上，420px |

> ⚠️ **真机未复验（PENDING）**：本轮仍是 Chromium 内核 + 三视口模拟。
> iPhone Safari / Android Chrome / 微信内置浏览器的 `tel:` 唤起行为**必须**由你在真机上点一次确认
> （模拟器的 `tel:` 不会真的拉起拨号盘）。

---

## 七、Git、密钥与夹具

| 项 | 结果 |
|---|---|
| 改动文件 | `progress-stage.ts`（新增）、`progress-service.ts`、`Progress.vue`、`media.ts`、门禁脚本、`API.md`、两份报告 |
| 敏感内容 | 无 Token / 口令 / `SIGN_SECRET` / AES key；**测试号码是编造值**（1390001000x / 1390002000x / 1390003000x / 1390004000x） |
| 夹具清理 | 4 张按 ID 删除，`{tickets,visits,events,sms,photos}` 全 0，照片磁盘文件同删 |
| 残留 | 变异注释已清除（`grep "变异 B"` 无命中）；`git diff --cached` 为空 |
| commit / push | ❌ 未执行（按你的禁令） |

---

## 八、仍未做的（明确边界）

- **实际到场时间**：系统没有到场记录，本轮不新增打卡流程（未评审），页面显示"尚未记录"；
- **真机复验**：PENDING（见上）；
- UX-LAST-ORDER-01 的 B-30：独立处理，不因本报告 PASS；
- 华林账号真实登录：HOLD（未重置密码）；UX-01D M2 未授权；Phase 11 IN PROGRESS；Release HOLD。

---

## 九、验收裁决（用户 2026-10-19）：PASS / FROZEN

> **归档说明**：本节只记录**用户裁决**，不表示重新执行过测试。
> 本报告正文的测试执行日期为 **2026-10-19**（93/93、变异 A/B、DEV-209 20/20、UX-LAST-ORDER-01 24/24），
> 裁决发生在同日晚些时候，未重跑。

### 9.1 用户认可的八项

1. 五阶段业务进度与当前状态映射；
2. 当前有效 Visit 的师傅姓名与 `technician_mobile` 对客展示；
3. 改派、取消、无效 Token 的数据隔离；
4. 提交、派工、预约上门、实际到场、师傅回执、门店确认**六类时间的独立来源**；
5. 实际到场无记录时**如实显示**，不伪造时间；
6. 事件时间线按真实事件生成**客户可读名称**；
7. **93/93** 专项门禁与**两组有效反向测试**；
8. DEV-209 **20/20**、上一单功能 **24/24** 定向回归。

### 9.2 冻结范围（不得重构，除非另获明确授权）

| # | 冻结项 |
|---|---|
| ① | 五阶段展示与真实状态映射 |
| ② | 师傅姓名及**当前有效派工**联系电话 |
| ③ | 六类时间的真实来源与缺省语义 |
| ④ | 客户事件时间线映射 |
| ⑤ | Token 隔离、改派隔离 |
| ⑥ | 三视口页面布局（375 / 390 / 420） |

### 9.3 独立待验（PENDING，**不阻断功能冻结**）

真实手机拨号交互，待在以下环境验证并确认 `tel:` 唤起、显示号码与拨号号码一致、页面返回体验：

- iPhone Safari
- Android Chrome
- 微信内置浏览器

> **在相关终端验收前，不得宣称三端拨号均已通过。**

### 9.4 数据缺口口径（保持）

系统没有 `arrived_at` 或等价的真实到场采集机制 ⇒ 页面恒显示「尚未记录」。
未经另行评审，**不新增打卡或定位采集功能**，**不用其它更新时间冒充实际到场**。

### 9.5 项目边界（裁决时重申）

- UX-01D M1 **PASS / FROZEN**；UX-01D M2 **未授权**；
- UX-LAST-ORDER-01 的 **B-30 保持独立待办**（不因本项 PASS 而关闭）；
- 华林账号**绑定 PASS、真实登录 HOLD**（未重置密码）；
- Phase 11 **IN PROGRESS**；Release **HOLD**；
- **未 commit / 未 push**（本轮仅状态归档，无代码改动）。
