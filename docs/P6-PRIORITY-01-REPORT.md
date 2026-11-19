# P6-PRIORITY-01 · 维修措施必填 + 上一单记忆（实现与验证报告）

> 日期：2026-10-29 11:45–12:05　状态：**代码完成 / 本机验证通过 / 未部署**
> 未做：生产部署、真实短信、数据库迁移、权限调整、commit / push。
> BE-05 新功能（钻取、Excel）**未动**，按裁决排在两项 P0 之后。

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| **P0-1 维修措施** | **已实现**（服务端权威校验 + H5 表单 + 三处显示改名）；规则矩阵 **18/18**，变异验证通过 |
| **P0-2 上一单记忆** | **代码在上一轮（P6-HOTFIX-02 B 组）已实现**；本轮**未改** `Success.vue` / `last-order.ts`（mtime 仍为 10-22），只补了行为矩阵 **14/14** |
| 部署 | **未部署**（本轮未获授权） |
| BE-05 | 未开始（按裁决后置） |

> 如实说明：P0-2 不是本轮新写的。我做的事是**逐条核对 10 条既有规则并为持久层写了可回归的测试**，
> 没有为了"看起来有工作量"去改已经正确的代码。

---

## 2. P0-1 维修措施

### 2.1 规则（唯一实现：`constants.validateServiceNote()`）

| 规则 | 值 |
|---|---|
| 必填范围 | **全部** service_result（含 `resolved`、含未知新枚举、含"未报告"NULL） |
| 最小长度 | **5 个有效字符**（去掉**所有**空白后计数：半角/全角空格、换行、Tab 都不算） |
| 最大长度 | **500**（沿用既有上限） |
| 校验顺序 | 先判超长，再判太短（前后端同序，避免"前端说超长、后端说太短"） |
| 落库 | 仍用 `service_note`，**不新建字段**；空串→null 的既有约定不变 |
| 文案 | `请填写维修措施，至少 5 个字`（前后端共用同一常量） |
| 未知新结果 | `isServiceNoteRequired()` 用的是"可留空名单 + `!includes`"，名单为空 ⇒ 新枚举**默认必填** |

### 2.2 改动文件（5 处）

| 文件 | 改动 |
|---|---|
| `server/constants.ts` | `SERVICE_RESULT_NOTE_OPTIONAL` 置空；新增 `SERVICE_NOTE_MAX/MIN_EFFECTIVE/REQUIRED_MESSAGE`、`countEffectiveChars()`、`validateServiceNote()` |
| `server/actions/technician/visit.ts` | `parseSubmitDto()` 用 `validateServiceNote()`；**位置在 `technicianSubmit()` 之前**（即 Visit 未写、状态未流转、Token 未消耗）；GET 的 `note_required` 随常量自动变 true |
| `server/services/visit-service.ts` | 服务层第二道闸同样调 `validateServiceNote()`（后台补录等将来入口也过这里） |
| `h5/src/pages/Technician/Visit.vue` | 标签「维修措施 \*」、引导文案、计数改"有效字符"、校验改 5 字、`canSubmit` 纳入 |
| 显示改名 | `collections/serviceVisits.ts`、`services/export-service.ts`、`client/ticket-store-review.tsx`、`client/primary-action.tsx` → 「维修措施」（内部字段名不变） |

**没有改**：`service_note` 列定义、历史 NULL 数据、照片/收费校验、Token 规则、工单状态机。

### 2.3 校验发生在副作用之前（代码位置证据）

```
submit handler:
  consumeQuota(...)          // 仅限流，不是一次性 Token
  parseSubmitDto(ctx)        // ← 维修措施校验在这里抛 ValidationError(422)
  countPhotos / 上限检查
  services.tickets.technicianSubmit(...)   // 事务：Visit → Token → Ticket → Event
```

⇒ 校验失败时事务尚未开始：不写 Visit、不推进 `WAIT_STORE_CONFIRM`、不消耗一次性师傅 Token。
（`consumeQuota` 是接口限流额度，与本单一 Token 无关，属既有行为。）

### 2.4 测试：`p6-note-rules.test.mjs` **18/18**

| 组 | 覆盖 |
|---|---|
| L1–L11 | 空串 / null / 全空格 / 全角空格+换行+Tab / 4 字 / 5 字 / 首尾空白后 5 字 / **用空格凑长度不算** / 恰好 500 / 501 / 文案逐字 |
| R1–R5 | 五种结果全必填（含 resolved）/ 未知新结果默认必填 / 空结果（NULL）也必填 / 任何结果下空维修措施都不通过 |
| C1–C2 | 有效字符口径（全角空格、换行、Tab 不计入） |

变异：把 `SERVICE_NOTE_MIN_EFFECTIVE` 由 5 改 1 ⇒ **L5/L8 变红**（`✓ 变异被抓住`）。

---

## 3. P0-2 上一单记忆（核验，不是重写）

代码位置：`h5/src/utils/last-order.ts`（10-22 完成）+ `h5/src/pages/Report/Success.vue`（10-22 完成）+ `Report/index.vue` 的恢复逻辑。

| # | 规则 | 实现事实 | 本轮验证 |
|---|---|---|---|
| 1 | 只在真实提交成功后写入 | 写入只发生在 `Success.vue`（提交成功页），`Report` 页只读 | 代码位置核对 |
| 2 | 默认 7 天，不动服务端 Token 有效期 | `LAST_ORDER_MAX_AGE_MS = 7*24*3600*1000`，读时判过期并删除 | **M3/M4**（边界点有效、+1ms 失效） |
| 3 | 同浏览器同门店才恢复 | key = `svc.lastOrder.v1.<storeCode>` | **M5** |
| 4 | 不同门店互不读取 | 同上（跨店读不到） | **M5** |
| 5 | 新单成功才替换 | 同 key 覆盖 | 代码位置核对 |
| 6 | 新单失败不覆盖 | 失败页不写（写入只在成功页挂载） | 代码位置核对 |
| 7 | 分享链接不成本机上一单 | 仅 `Success` 页写入；带 `pt` 的入口**跳过**恢复 | 代码位置核对（`maybeRestoreLastOrder` 的 `pt` 短路） |
| 8 | 过期/损坏/撤销/无效 ⇒ 清理 | 读时损坏即删；恢复时 401/404/410 删除并提示 | **M6** + 代码位置核对 |
| 9 | 「提交新工单」不被反复跳回 | `skipRestore=1` 一次性参数（抹掉后不持久化）；`autoOpen=false` 不自动跳 | 代码位置核对 |
| 10 | 清除记录可用 | `forget-last-order` 按钮 + `removeLastOrderByToken` | **M9/M11** |
| — | 两个勾选项的联动 | 取消"记住" ⇒ 关自动进入 + 删记录；只取消自动进入 ⇒ 保留记录 | **M8** + 代码结构 |
| — | 默认勾选且不触碰仍落盘 | `ref(true)` ×2 + `onMounted → applyRemember()` | **S1/S2**（结构检查） |
| — | 即时生效 | `@change` 绑定 | **S3**（结构检查） |
| — | 不含客户明文 | 记录只有 storeCode/ticketNo/token/ticketType/createdAt/autoOpen | **M2** |
| — | localStorage 不可用仍可提交 | `saveLastOrder` 返回 false，不抛错 | **M10** |

### 3.1 测试：`p6-last-order.test.mjs` **14/14**

用内存版 `localStorage` 桩（含 `key(i)` 枚举，第一版没实现它导致 M11 假红——夹具不真结论就不真）。
M1–M11 为**真实持久层行为**；S1–S3 是**结构检查**（防止有人把默认值改回 false 或删掉 `onMounted` 落盘），
报告里不把结构检查当成行为证明。

---

## 4. 构建与门禁

| 项 | 结果 |
|---|---|
| `prebuild-guard` | **10 项 SAME** |
| `verify-types`（TS2304/TS2552） | 0 |
| `verify-ts-baseline`（全量诊断基线） | 219 → **219**，无新增 |
| `build-plugin`（server+client） | ✅ 成功 |
| `h5 vite build` | ✅ 成功（`dist/assets/index-D37Itv1Z.js`，168.78 kB） |
| `h5 vue-tsc` | 我改动的部分**0 新增**；残留 2 条**非本轮引入**（见下） |

### 4.1 残留 H5 类型错误（如实列出，未修）

| 位置 | 内容 | 判定 |
|---|---|---|
| `Visit.vue:727` `service_result: form.service_result === '' ? null : ...` | TS2322 `null` 不可赋给 `string`（`SubmitReceiptInput` 声明） | 来自 **P6-TECH-VISIT-SUBMIT-03**（更早轮次），本轮未触碰该行 |
| `Progress.vue:139` | TS2345 `string \| null` 传给 `string` | 该文件本轮未修改（10-22 的改动） |

我本轮引入的 1 条（`noteRequired` 未使用）已删除该计算属性并复检通过。

---

## 5. 未完成 / 需后续（不随本轮关闭）

1. **未部署**：生产仍是 S6+UX 那版；本轮改动只在本机构建产物里。
2. **未做真机**：H5 未在 Android Chrome / iPhone Safari 实机验证（本轮只到构建 + 类型 + 逻辑夹具）。
3. **"绕过前端直接 POST → 422"没有真实 HTTP 证据**：因为未部署。当前证据是
   规则函数 18/18 + 调用顺序（静态）。**部署后必须补一次真实请求**（空/4 字/5 字）才算闭环。
4. **一次性 Token 未被消耗**：同样需要部署后用真实链接验证（提交失败 → 同链接仍可用；成功后 → 失效）。
5. `note_required` 现恒为 true，前端已不依赖它；若将来重新放开某类结果可留空，改 constants 名单即可，两处同步。
