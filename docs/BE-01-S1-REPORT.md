# BE-01-S1 读取路径安全审计报告

> 日期：2026-10-20 · 范围：viewer 的**当前部署**读取路径与敏感字段完整性
> 未 commit / 未 push；BE-04 仍 HOLD；Phase 11 IN PROGRESS；Release HOLD。

---

## 1. 当前注册资源与 viewer 的可读动作（来自实际 ACL 表）

来源：`dataSourcesRolesResources` + `dataSourcesRolesResourcesActions`（NocoBase 生效表，不是猜接口名）。

```sql
viewer 的 ACL 资源（共 5 个，每个 get/list/view）：
  serviceTickets | serviceVisits | smsLogs | stores | ticketEvents
```

> `rolesResources` 是本版**废弃表**（0 行），实际生效的是 `dataSourcesRolesResources`。
> 第一版审计脚本查错了表，会得出"viewer 无任何权限"的错误结论 —— 记下来，防止下次再犯。

---

## 2. viewer 实际可读路径矩阵（42 项）

`scripts/audit-be01-s1-read-paths.mjs` —— 合成夹具（`13800001111` / `13900002222`）贯穿。

| 组 | 项数 | 结果 |
|---|---|---|
| ① 5 资源 × list/get/view | 15 | get/list 200 且**掩码**；`view` 全部 404 |
| ② 关联展开（appends） | 4 | `store` / `ticket` 展开且无明文；`handler` / `visits` / `events` **未展开**（ACL 不允许 users，且无该关联） |
| ③ 字段投影（fields / except） | 4 | 双号 / except / 主键+号 → 掩码；`fields=*` → **500**（既有异常，不泄露） |
| ④ 聚合/导出/附件 | 7 | dashboard 200 无 PII；reportKpi / exportTickets / 原生 export / customerMedias / visitPhotos / attachments 全 403 |
| ⑤ 号码格式 | 7 | 见 §4，全部安全 |
| ⑥ 前端时序 | 4 | 见 §6，写按钮 0 |
| 清理 | 1 | 残留 0 |

**合计 42 项 · LEAK 0 · DENIED 12。**

---

## 3. 关联展开与字段投影（重点结论）

| 探测 | 结果 | 判定 |
|---|---|---|
| `serviceTickets?appends=store` | 已展开，门店对象无个人手机号 | 安全 |
| `serviceTickets?appends=handler` | **未展开**（viewer 对 users 无权限） | 无泄露面 |
| `serviceTickets?appends=feedback_visit` | 未展开 | 无泄露面 |
| `serviceVisits?appends=ticket` | 已展开，工单对象返回的是**掩码**值 | 安全（递归生效） |
| `fields=customer_mobile,technician_mobile` | `138****1111` | 安全 |
| `except=technician_mobile` | 其余字段无号码 | 安全 |
| `fields=*` | HTTP 500 | **既有异常**，非泄露；未修（不在本轮范围） |

> 关键判断依据是**最终 HTTP 响应体**，不是中间件内部对象。

---

## 4. 🔴 本轮发现的真实缺陷：非规范号码被原样放行

第一版掩码函数：

```ts
if (!/^1[3-9]\d{9}$/.test(digits)) return digits;   // 不匹配 ⇒ 原样返回
```

实测（合成夹具，改的是自建工单）：

| 入库值 | 修复前返回 | 修复后返回 |
|---|---|---|
| `13800001111` | `138****1111` | `138****1111` |
| `+8613800001111` | **`+8613800001111`** 🔴 | `138****1111` |
| `138 0000 1111` | **原样** 🔴 | `138****1111` |
| `138-0000-1111` | **原样** 🔴 | `138****1111` |
| `0731-88886666`（座机） | **原样** 🔴 | `073****6666` |
| 空值 | 空 | 空 |
| `abc` | **`abc`** 🔴 | `***` |

**根因**：「正则不匹配就放行」是一种 fail-open。库里出现什么格式，viewer 就原样拿到什么格式。

**修复**（`native-sensitive-field-guard.ts` 的 `maskMobileValue`，fail-closed）：
归一化（去空格/括号/横线、去 `+86`）→ 11 位手机打码 → 其它 ≥7 位数字保留前 3 后 4 → 太短/非数字输出 `***` → 空值保持空。

**门店业务电话不经过本函数**（`stores.phone` 属允许公开，未做无差别替换）。

---

## 5. 反向验证

| 验证 | 做法 | 结果 |
|---|---|---|
| **A. 顶层明文恢复** | `maskMobileValue` 直接 `return raw` | **LEAK 15**，exit 1；还原后 **0** |
| **B. 关联对象明文** | 当前部署**无法在 HTTP 层构造**：`handler` 需要 users 权限、`visits/events` 关联不存在 | 改用**资源清单护栏**（见下） |

### 为什么 B 改成资源清单护栏

你的要求是"故意在关联对象里返回完整号码 ⇒ 门禁变红"，目的是防止**新的读取面**悄悄出现。
当前部署里没有可展开且含 PII 的关联，硬造一个等于伪造测试。

替代方案更可持续：

`scripts/verify-be01-s1-resource-inventory.mjs` —— 直接读 ACL 表，断言 viewer 的
(资源, action) 集合**恰好等于已审计的这 5 个**。任何新增（换人配权限、插件升级带出新集合）
**立即变红**，逼着先跑审计脚本再放行。

> 它比一次性构造更难绕过：不是测"某个关联有没有脱敏"，而是测"可读面有没有变大"。

---

## 6. 前端角色时序（viewer）

| 场景 | 可见写按钮 | 结果 |
|---|---|---|
| 首次登录 | 0 | ✅ |
| 刷新 | 0 | ✅ |
| 页面切换（点菜单） | 0 | ✅ |
| 退出再登录 | 0 | ✅ |

（"正式角色变更"未做：改角色需要写 `rolesUsers`，本轮禁止 SQL 改角色关系；
如需验证，应由管理员在后台界面操作后复测。）

---

## 7. 剩余泄露路径结论

| 结论 | 说明 |
|---|---|
| 当前资源全集 | **5 资源 × 3 只读 action，全部审计完毕，无剩余完整联系方式泄露** |
| 已修 | 非规范号码 fail-open（本轮） |
| 无泄露面但被判 DENIED | users / roles / collections / envVars / 原生导出 / 附件 / 私有媒体元数据 |
| 既有异常 | `fields=*` 返回 500（不影响安全，登记为遗留） |
| 新增资源 | 由资源清单护栏自动拦截 |

---

## 8. 修复建议 / 最小补丁范围

已实施（本轮）：
- `native-sensitive-field-guard.ts`：`maskMobileValue` 从 fail-open 改为 fail-closed；
- 未新增任何 ACL 权限、未开放任何资源。

建议（未实施）：
- `fields=*` 的 500 应改为 400 或按白名单返回（独立小修，不影响安全）；
- 若将来 `appends=handler` 被允许，**必须**先跑本审计脚本 —— 护栏会因 ACL 变化而红。

---

## 9. S0 的 26/26 计数说明（补齐）

报告表格里的分组合计是 22，因为**漏计了两处**，不是多报了通过数：

| 组 | 明细 | 条数 |
|---|---|---|
| 前置 | viewer 账号可登录 | 1 |
| ① 三个资源（tickets / visits） | 每个 3 条：仍可访问 + 无完整号 + 有掩码 | **9** |
| ② 写动作 | followUp / internalNote / update | 3 |
| ③ 敏感资源 | users / roles / collections / envVars / export | 5 |
| ④ 聚合 | 200 + 无 PII | 2 |
| ⑤ 不误伤 | hq / hqadmin | 2 |
| ⑥ 门店隔离 | 可读 + 单店 | 2 |
| ⑦ 按钮 | 可见写按钮 0 | 1 |
| 清理 | 夹具残留 0 | 1 |
| **合计** | | **26** |

> 旧表格把 ① 写成"6 条"（只数了"无号+掩码"，漏了"仍可访问"3 条），也没列前置 1 条。
> **只改文档，不伪称重新运行**；本次 S1 的 42 项是新一轮真实执行。

---

## 10. 夹具 / Git / 密钥

| 项 | 结果 |
|---|---|
| 夹具 | 自建工单 + 派工；跑完按 ID 删除，残留 0 |
| 号码 | 全部为合成值（13800001111 / 13900002222），脚本输出不含真实业务号码 |
| 真实客户数据 | 未读写、未修改 |
| 临时 SQL | 只 `UPDATE` 自建夹具的 `customer_mobile`（测格式），不碰真实工单 |
| 密钥 | 无 Token / 口令 / 密钥写入代码或文档 |
| 暂存区 | 空 |
| commit / push | 未执行 |

---

## 11. 申请

若认可上述结论：**BE-01-S0 / S1 读取路径安全收口，申请最终 PASS**。
BE-04 继续 HOLD，等下一次明确裁决。
