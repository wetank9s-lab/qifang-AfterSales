# UX-01C 第二轮交付报告（受控配置写入与审计机制 **已交付并验证**；「服务时效」页面 **未接通，PENDING**）

> 日期：2026-10-17 · 前序：`docs/UX-01C-REPORT.md` · 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD
> **本轮未提交、未推送。**
> ⚠️ **如实声明**：本轮交付的是「服务时效」的**服务端受控写入与审计机制**（已端到端验证），
> **页面（UI）尚未接通** —— 因此总部管理员**还不能在后台界面点着改**，该项记 **PENDING**，**不冒充已交付**。

---

## 一、本轮已交付（4 个文件，全部构建/运行验证）

| 文件 | 内容 |
|---|---|
| `src/server/collections/configChangeAudits.ts`（新） | 配置变更审计表（key / old_value / new_value / operator_user / operator_name / scene / request_id / note）。**只增不改**；复用 `defineAppCollection`；`? 无既有通用审计表可复用`（`ticketEvents.ticket_id` 非空、`exportAudits` 语义不同）⇒ 按最小原则新建。 |
| `src/server/actions/svc/config-settings.ts`（新） | 受控读写：`listSettingSpecs`（只读，下发白名单元数据）+ `updateSetting`（写）。**白名单** `SETTING_EDIT_SPECS` = 3 个 SLA 键（每条都标了真实消费点）。 |
| `src/server/{constants.ts,collections/index.ts,plugin.ts}` · `src/shared/svc-action.ts` | 注册：`SVC_ACTION.LIST_SETTING_SPECS/UPDATE_SETTING` + `AUTHENTICATED_SVC_ACTIONS` + `ALL_COLLECTIONS`/`EXPECTED_TABLE_NAMES`（`config_change_audits`）+ handlerSets。 |
| `src/client/config-edit-action.tsx`（新） | `ConfigEditActionModel`：行内「修改」→ 自建表单（中文名/单位/范围/生效时机，均取自**服务端**白名单）→ 调 `svc:updateSetting`，带 `expected_value` 做并发检测。（未接通页面，见 §三） |

**受控接口逐条对照（用户 §二）**：
| 要求 | 实现 |
|---|---|
| ① 服务端校验 `hq_admin` | `permissions.assertCapability(actor, CAPABILITY.ADMIN)` |
| ② 仅白名单键 | `SETTING_EDIT_SPECS`；其它键 → **422 `SETTING_NOT_WRITABLE`** |
| ③ 按 `value_type` 校验 | `validateSettingValue()`（正则整数 + `Number` 有限性） |
| ④ 拒绝 NaN/负值/非法单位 + 范围 | 非整数/NaN → **422 `SETTING_VALUE_INVALID`**；越界 → 422（含 min/max） |
| ⑤ 操作人/时间/前后值 | 写 `configChangeAudits`（`operator_user_id`/`operator_name`/`old_value`/`new_value`；时间用表自带 `created_at`） |
| ⑥ 更新与审计**同事务** | `db.sequelize.transaction(...)` 内 update + create |
| ⑦ **并发冲突检测** | 调用方带 `expected_value`；不符 → **409 `CONFIG_CONFLICT`** |
| ⑧ 受控恢复并留痕 | 同一接口 + `scene:'restore'` ⇒ 再写一条审计 |
| 禁止前端任意键写入 | 前端只调 `svc:updateSetting`，键由页面行数据提供、服务端白名单强校验 |

**真实执行证据（`hq_admin` 账号 `uat.hqadmin@svc.local`，服务端 + 库）**：
```
BEFORE  {original:"120", audits:0}
UPDATE  {http:200, newValue:"127", auditsDelta:1, lastAudit:"120->127|uat_hqadmin|update"}   ← 改值 + 审计(同事务)
CONFLICT {http:409, code:"CONFIG_CONFLICT"}                                                    ← 旧 expected_value 被拒
INVALID  {neg:422, nan:422, notWritable:422, codes:[SETTING_VALUE_INVALID, SETTING_VALUE_INVALID, SETTING_NOT_WRITABLE]}
DENY  storeA        {http:403, code:"FORBIDDEN"}
DENY  viewer        {http:403, code:"FORBIDDEN"}
DENY  hq_after_sales{http:403, code:"FORBIDDEN"}
RESTORE {http:200, value:"120", backToOriginal:true, auditsTotal:2}                            ← 恢复原值 + 第二条审计
```
- 构建：`build-plugin.mjs` TS 门禁（①=0 / ②=0）**✅** + esbuild **✅**；`restart app` health **200**。
- 新表已建：`information_schema.tables[config_change_audits] = 1` ✅。
- ⚠️ 过程中一次**真实门禁拦截**：客户端最初 `import { InputNumber } from 'antd'` 被 `verify-types` 判据②（宿主导出未核实）**判红** → 已改用既有 `Input`（类型/范围由服务端校验）。

## 二、「服务时效」的三个参数（§一）
| 键 | 中文名 | 单位 | 范围 | 消费点（真） | 生效时机 |
|---|---|---|---|---|---|
| `sla.accept_minutes` | 新工单首次受理时限 | 分钟 | 5~1440 | `sla-scan-scheduler.ts:226` | 下次扫描 |
| `sla.appointment_overdue_grace_minutes` | 预约上门超时宽限 | 分钟 | 0~1440 | `sla-scan-scheduler.ts:227` | 下次扫描 |
| `sla.store_confirm_hours` | 师傅提交后门店确认时限 | 小时 | 1~168 | `sla-scan-scheduler.ts:228` | 下次扫描 |

**§一 另要求核对的"其它节点覆盖范围"**（如实）：现有 SLA 只覆盖 **受理 / 预约超时 / 门店确认** 三个节点；
**处理中跟进、重开、评价等节点目前没有 SLA 消费点**，总部异常待办/通知（`serviceAlerts`/P11-6）**尚未实现消费**
⇒ 这些**不得**登记为可写设置项（本轮 `SETTING_EDIT_SPECS` 只有 3 条，正是这个原因）。

## 三、**未交付（PENDING）**
| 项 | 状态 | 差什么 |
|---|---|---|
| **「服务时效」页面**（后台可见/可点/可改） | ❌ **PENDING** | 需把 `ConfigEditActionModel` **挂到页面操作列**：在 `scripts/ticket-page-actions.mjs` 里加 `CONFIG_EDIT_ACTION_MODELS/USES`（沿用 `actionRow()`），在 `seed-admin-pages.mjs` 加页面 builder + `seedConfigEditAction()`，并在 `expected-sensitive-columns.mjs` 的 `REQUIRED_ADMIN_PAGES`/`ROLE_MENU_MATRIX`（仅 `hq_admin`）登记。**动作模型与服务端接口已就绪，只差这一步挂载。** |
| 浏览器端"改值→生效→恢复"实测 | ❌ PENDING | 依赖上面的页面 |
| 重播种/重启后设置与审计不丢 | 🟨 部分 | 重启已验（数据在库）；**重播种未跑** |
| 「短信通知」页 | ❌ PENDING（未开始） | 服务商枚举已修（上轮）；页面与写接口复用本轮机制 |
| 「门店管理」页 | ❌ PENDING（未开始） | 复用 `stores` + 本轮写接口机制 |
| `serviceSettings` 旧描述未同步 | ❌ PENDING | 需受控幂等迁移（只更新"与代码默认完全一致"的行，不覆盖管理员自定义） |
| UX-01D 白名单接口 | ❌ PENDING（按约定不在本轮 PASS） | 只保留边界设计 |

**原因（如实）**：页面挂载需要改 `ticket-page-actions.mjs` + `seed-admin-pages.mjs` 两个种子模块（含预清理集合与角色矩阵），
本轮预算在完成"服务端受控写入 + 审计 + 权限 + 冲突 + 恢复"的**实现与端到端验证**后耗尽。
**我没有把未运行的页面算作已交付。**

## 四、UX-01D 边界（§六，仅保留设计，不计本轮 PASS）
- 公开白名单（拟定）：`site.title` / `site.logoUrl` / `site.themeColor` / `site.modules[]`（含顺序）/ `site.published`；
- 客户 H5 **只**能读这个**独立持久化**的公开配置（**不读** `serviceSettings`）；
- 隐私告知/权限/必需校验/敏感配置**不可**由装修开关关闭；
- 页面种子 `replace` 覆盖管理员改动的问题 ⇒ 装修配置**独立存表**、重播种/重启/升级不丢。

## 五、Git 与审计
- `git status`：**37 个变更文件**（本轮新增：`configChangeAudits.ts`、`config-settings.ts`、`config-edit-action.tsx`；修改：`collections/index.ts`、`constants.ts`、`plugin.ts`、`shared/svc-action.ts`）。
- `git diff --check`：**干净**；增量密钥审计对全部变更文件 → **exit 0**；临时脚本已删除（`scripts/_tmp_*` 无残留）。
- **未提交、未推送。**

## 六、结论
- ✅ **受控配置写入与审计机制已交付并经真实服务端验证**（权限 403 / 白名单 422 / 范围 422 / 冲突 409 / 同事务审计 / 恢复留痕）。
- ❌ **「服务时效」页面未接通** ⇒ 管理员**暂时还不能在后台点着改**；**UX-01C 本轮不签收**。
- 下一步（最小、可直接执行）：按 §三 把动作挂到页面（改两个种子模块 + 角色矩阵），即可完成"服务时效"完整闭环，再依次做「短信通知」「门店管理」。
- 项目状态不变：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD。UX-01B 的 PENDING 清单继续保留。
