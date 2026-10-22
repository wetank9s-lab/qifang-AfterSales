# BE-01-S0 安全收口报告（只读角色权限与敏感数据）

> 日期：2026-10-20 · 范围：**仅 BE-01-S0**（BE-04 未开始，见 §8）
> 未 commit / 未 push；Phase 11 IN PROGRESS；Release HOLD。

---

## 1. 一句话结论

viewer 通过**原生集合接口**能读到完整客户/师傅手机号（实测），已在服务端收口：
改为返回 `138****8888`，且**写动作本来就是 403**（按钮只是展示层问题）。
定向门禁 **26/26**，反向变异 **6 条红**。

---

## 2. 实测矩阵（改前 → 改后）

以一张**脚本自建**并派工的夹具单为对象（跑完按 ID 删除）：

| 路径（viewer） | 改前 | 改后 | 说明 |
|---|---|---|---|
| `GET /api/serviceTickets:list` | 200 · **完整手机号** | 200 · `138****8888` | 主漏洞 |
| `GET /api/serviceTickets:get` | 200 · **完整手机号** | 200 · 掩码 | 详情同理 |
| `GET /api/serviceVisits:list` | 200 · **完整手机号** | 200 · 掩码 | 关联资源，同一漏洞 |
| `GET /api/serviceVisitPhotos:list` | 403 | 403 | 既有守卫已挡 |
| `GET /api/users:list` / `roles` / `collections` | 403 | 403 | 未放宽 |
| `GET /api/environmentVariables:list` | 403 | 403 | B-17 不得靠开这个解决 |
| `GET /api/svc:exportTickets` | 403 | 403 | 导出旁路已关 |
| `POST /api/svc:followUp` / `internalNote` | **403** | 403 | **后端从未越权** |
| `POST /api/serviceTickets:update` | **403** | 403 | 同上 |
| `GET /api/svc:dashboardSummary` | 200 | 200 | 聚合仍可用（不封死） |
| `GET /api/svc:reportKpi` | 403 | 403 | 原本就没有 |

**hq_after_sales / hq_admin**：`list` 仍返回**完整号码**（业务需要），未误伤。
**store_after_sales**：列表只含本店（`store_id` 去重后 ≤ 1）。

---

## 3. 根因（不是"配置没开"）

```
svc:* 动作  → permissionService.maskMobile() → 按 MASK_MOBILE_ROLES(viewer) 打码   ✅ 一直有效
后台列表    → NocoBase 原生 serviceTickets:list / serviceVisits:list            ❌ 完全没走 mask
```

`MASK_MOBILE_ROLES` 这个常量**早就存在**（`constants.ts:1588`），但它只被
`permission-service.ts:314` 使用 —— **只覆盖了动作层**。后台列表/详情走的是原生集合接口，
那条路没有任何脱敏。

所以这不是"忘了配 ACL"，而是**掩码策略的覆盖面缺了一条路**。

---

## 4. 修复（两处，各管一件事）

### 4.1 服务端：原生读字段脱敏

`server/middleware/native-sensitive-field-guard.ts`（新增）

- 挂在 `after: 'acl'`，在 action 返回后改写 `ctx.body`；
- 只对 `MASK_MOBILE_ROLES`（= viewer）生效；
- 只处理 `serviceTickets` / `serviceVisits`；
- 字段精确匹配 `customer_mobile` / `technician_mobile`，值必须匹配 `^1[3-9]\d{9}$` 才打码
  （座机/空值原样保留，不改成怪样子）；
- **保留字段、改写值** —— 列表列不空、筛选不受影响（用户要求"不能因为关闭敏感字段把查看功能封死"）。

### 4.2 前端：只读角色隐藏写按钮

`client/viewer-readonly.ts`（新增）+ `client/index.ts` 接线。

- 角色来源：`localStorage.NOCOBASE_ROLE`（NocoBase 自己写的，实测值 `viewer`）；
- `load()` 时可能还在登录页，所以**轮询最多 60 次**（每秒一次），命中后启用；
- 隐藏文本为「处理 / 跟进 / 新建服务单 / 编辑 / 删除」的按钮；
- **独立 try**：`registerTicketActions()` 抛错时不会连带跳过这段（实测踩过，见 §7）；
- 任何异常都吞掉：后台 SPA 不能因为补丁白屏。

> 🔴 报告口径：**这是"按钮错误"的修正，不是安全边界**。
> 安全由服务端 403 保证（改前就已经是 403）；隐藏按钮只是避免运营以为"系统坏了"。

---

## 5. 定向门禁

`scripts/verify-be01-s0-permissions.mjs` —— **26 / 26**

| 组 | 判据 | 结果 |
|---|---|---|
| ① | viewer list / get / visits：无完整号码、**有掩码值** | ✅ 6 条 |
| ② | viewer followUp / internalNote / update：服务端 403 | ✅ 3 条 |
| ③ | users / roles / collections / envVars / export：拒绝 | ✅ 5 条 |
| ④ | dashboard 200 且不含手机号 | ✅ 2 条 |
| ⑤ | hq_after_sales / hq_admin 仍能读完整号码 | ✅ 2 条 |
| ⑥ | 门店列表只含本店 | ✅ 2 条 |
| ⑦ | 浏览器：viewer **可见**写按钮数 = 0 | ✅ 1 条 |
| 清理 | 夹具按 ID 删除，0 残留 | ✅ 1 条 |

**反向验证**：把脱敏角色列表置空（等价于恢复明文路径）⇒ **6 条红**，
实测响应直接出现 `13761541059` / `13900018888`；还原后 26/26。

---

## 6. 权限变化与未动项

| 项 | 是否变化 |
|---|---|
| ACL / rolesResources | **未改**（未走 SQL，未改 `rolesUsers`） |
| viewer 可读资源 | 未扩也未缩；只改**返回值的形态** |
| hq / store 手机号语义 | 未变 |
| `svc:exportTickets` | 未动 |
| 状态机 / 派工 / 受理 / 短信 | 未动 |
| `environmentVariables` / 原生元数据 / 私有附件 | **未放宽**（B-17 红线） |

---

## 7. 验证过程中修掉的三个"验证器/接入点"问题（都记下来）

1. **门禁假红**：`display:none` 的元素按规范 `innerText` 退回 `textContent`，
   第一版判据 `innerText` 非空 ⇒ 隐藏了也判"还在"。改为按 `getComputedStyle` + `offsetParent` 判**可见性**。
2. **补丁静默不执行**：`installViewerReadonly()` 原本排在 `registerTicketActions()` 之后，
   后者抛错就被跳过。拆成独立 try 才生效。
3. **角色时序**：`load()` 发生在登录页，`NOCOBASE_ROLE` 尚未写入 ⇒ 改成轮询。

> 这三条都不是产品缺陷，但没有它们就会得出"按钮隐藏失败/安全没收口"的错误结论。

---

## 8. BE-04 状态：**暂停（按用户闸门规则）**

用户指令：「若无法证明不存在读取旁路，则暂停 BE-04」。

**本轮能证明的**：已识别的 6 条读路径（`serviceTickets:list|get`、`serviceVisits:list`、
`serviceVisitPhotos:list`）与 5 类敏感资源（users/roles/collections/envVars/export）全部覆盖；
viewer 对它们的响应要么掩码、要么 403。

**本轮不能证明的**：**没有做全资源穷举**。具体未覆盖：
- `stores` 的 `appends`、`serviceTickets` 的关联展开（如果前端请求 `appends=...`）；
- 未来新增/其他人新增的关联资源；
- NocoBase 平台自身的其它通用读 action（当前 `native-metadata-guard` 已默认拒绝清单外资源，
  但"清单外"是一个动态集合，不能等同于"已证明无旁路"）。

⇒ 按规则**不宣称"不存在读取旁路"**，因此 **BE-04 暂停、未开始**。
下一步应先做「读路径穷举」专项（枚举全部可读资源 × action × 字段，逐个打 viewer token 验证），
再决定 BE-04 是否放行。

> 补充：BE-04 本身还需要改页面 schema 并重跑 seed（`filterForm` 加日期/门店/类型/状态 + 改名），
> 是会影响所有角色后台的独立变更，本来也应在独立窗口做完整四角色回归。

---

## 9. Git 状态

| 项 | 结果 |
|---|---|
| 暂存区 | 空 |
| 改动 | `plugin.ts`（注册中间件）、`client/index.ts`（接线）、2 个新文件、1 个门禁脚本 |
| 密钥 | 无 Token / 口令 / 密钥；测试手机号为编造值 |
| commit / push | 未执行 |

---

## 10. 已知遗留

| 项 | 说明 |
|---|---|
| B-17 `No permissions` 红条 | 仍在（既有），**未**通过放宽 envVars 解决 |
| viewer 列表列宽 | 掩码后号码变短，列宽正常，无需改 |
| 真机 | 本轮是 Chromium，后台桌面宽度；无真机项 |
| BE-04 | 未开始 |
