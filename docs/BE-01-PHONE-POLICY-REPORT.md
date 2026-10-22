# BE-01 后台手机号展示规则调整与权限回归报告

> 日期：2026-10-20 · 范围：手机号策略调整 + 权限回归
> 未 commit / 未 push；Phase 11 IN PROGRESS；Release HOLD。

---

## 1. 规则变更（用户 2026-10-20 裁决）

| 项 | 旧（2026-10-19） | 新（本次） |
|---|---|---|
| viewer 手机号 | 必须 `138****8888` | **完整号码** |
| 其它后台角色 | 完整 | 完整（不变） |
| 遮罩机制 | 对 viewer 强制 | **保留机制、名单置空** |

> 「查看完整手机号」≠「获得额外权限」：ACL、门店范围、写能力**一项未扩大**。

---

## 2. 改动文件

| 文件 | 改动 | 为什么 |
|---|---|---|
| `server/constants.ts` | `MASK_MOBILE_ROLES: [viewer]` → `[]`（带说明） | 名单驱动，改一处即可；机制不删，将来要恢复只加回角色 |
| `server/plugin.ts` | 停止挂载 `native-sensitive-field-guard`（代码保留 + 注释） | 后台原生接口不再脱敏；文件保留作为取证与现成方案 |
| `scripts/verify-be01-s0-permissions.mjs` | ①组断言由"无完整号/有掩码"改为"**必须是完整号/不再掩码**"，文件头写明变更原因 | 旧断言与新产品规则冲突；安全断言（写 403/敏感资源/隔离/按钮）全部保留 |
| `scripts/verify-be01-phone-policy.mjs` | **新增**，覆盖 12 条验收 | 新规则的可执行断言 |

**未改动**：`permission-service.ts` 的 `maskMobile()` 实现、`_mask.ts`、导出脱敏、`smsLogs.recipient_masked`、任何 ACL、`rolesUsers`、门店隔离。

---

## 3. 权限矩阵（实测）

| 角色 | 客户手机号 | 师傅手机号 | 写动作 | 数据范围 |
|---|---|---|---|---|
| store_after_sales | **完整** | **完整**（列表+派工记录） | 可写本店 | 仅本店（`store_id` 去重 ≤1） |
| hq_after_sales | **完整** | **完整** | 可写 | 全量 |
| hq_admin | **完整** | **完整** | 可写 | 全量 |
| viewer | **完整** | **完整** | **403**（followUp/internalNote/update） | 全量只读 |

夹具：`13800005555` / `13900003333`（合成值，跑完删除）。

---

## 4. 门禁结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `verify-be01-phone-policy.mjs` | **20 / 20** | 12 条验收 + 敏感资源拒绝 + 清理 |
| `verify-be01-s0-permissions.mjs`（修订后） | **26 / 26** | 新规则下复跑 |
| `verify-be01-s1-resource-inventory.mjs` | **通过** | viewer 仍只有 5 个可读资源 |

关键断言：
- 门店在**列表**与**派工记录**里都能看到完整师傅号；
- 四角色都能看到完整客户+师傅号；
- `list` 与 `get` 一致（都完整、无掩码）；
- 按手机号筛选 `filter[customer_mobile]` 仍可用（count ≥ 1）；
- 未登录读集合 401/403；
- 客户 H5 入口签名校验仍生效；
- users / roles / environmentVariables 仍 403；
- viewer 界面可见写按钮 = 0，且**页面上确实显示完整号码**。

---

## 5. 客户 H5 未受影响（专项确认）

`maskMobile` 的调用点只有三处：`svc/ticket.ts`（smsLogs 摘要）、`_mask.ts`（师傅详情）、`export-service`。
客户 H5 与匿名接口走 `/api/public/*`，**不经过**这条路径，因此：

- 进度 Token 的签发/校验/失效语义未变；
- 私有媒体读取（Range、`private,no-store`）未变；
- 匿名入口签名、限流未变；
- `smsLogs` 历史数据仍是掩码，未回填。

门禁已用"无签名入口被拒"间接验证第 9 条。

---

## 6. 遗留

| 项 | 状态 |
|---|---|
| `apps/.../fields=*` 返回 500 | 既有异常，非泄露，未修 |
| `smsLogs` 中历史 `recipient_masked` | 保持掩码，**不回填**（用户明确） |
| 导出脱敏 | 仍按原逻辑（导出是批量带走，独立于本次）；BE-05 再评估 |

---

## 7. Git / 夹具

暂存区空；未 commit / 未 push；夹具按 ID 清理 0 残留；测试号码全为合成值。
