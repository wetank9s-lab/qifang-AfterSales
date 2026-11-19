# A 组 UI 最后补证及 B 组启动报告

> 时间：2026-10-22 16:52–17:00 CST
> 方法：**真实已部署 H5 产物 + 真实 Edge + CDP `Fetch.fulfillRequest` 拦截**（不挂独立组件、不改源码）
> 结论：**拦截成功 5/5，五个 case 全部取得真实 DOM 证据。问题② 可申请 PASS。**

---

## 1. 浏览器网络拦截是否成功 —— **成功**

做法（符合你的三条硬要求）：

1. Edge `--headless=new --remote-debugging-port=9223`，**加载真实线上 H5**（`https://sh.scqfls.cn/h5/customer/progress/<合成token>`）；
2. `Fetch.enable` 只匹配 `*api/public/progress*`，在 **Request 阶段** `Fetch.fulfillRequest` 返回合成 DTO；
3. 其它请求（主题配置 `publicUiTheme:get`、静态资源）**一律放行**，走真实服务端；
4. DTO **不是我编的结构**：先取真实响应（用我自己造的合成工单 `FW20261022-0012`）作模板，
   顶层 17 个键原样保留（含 `review`、`completion_note`、`technician: null`），只替换被测字段；
5. 每个 case 用**独立合成 token**（≥8 位，满足 H5 路由 `{8,256}`），逐次 `Page.navigate` 重新加载文档。

**命中证据**：`INTERCEPT_HITS` 记录到 **5 条**，每个 token 各自命中一次、无串线：

```
[TEST-KITCHEN, TEST-AIRCOND, TEST-UNKNOWN, TEST-NOPHONE, TEST-NOSTORE]
```

> 附带发现：第一轮用 `T-AC`（4 位）时页面显示「页面不存在」——那是 **H5 路由的 `{8,256}` 规则**在拦，
> 说明路由校验是有效的；换成 8 位以上即正常。这不是产品问题，是我 token 造短了。

---

## 2. 真实 H5 DOM 测试结果（390×900 视口）

| case | 家电文本（DOM 实测） | 拨号按钮 | 新工单按钮 | bodyLen |
|---|---|---|---|---|
| **kitchen_bath** | **`厨卫电器 · K-100`** | ✅ 有 | ✅ 有 | 4556 |
| **air_conditioner** | **`空调 · GREE KFR-35`** | ✅ 有 | ✅ 有 | 4560 |
| **unknown_xyz** | **`unknown_xyz · X-9`**（既定回退：原值） | ✅ 有 | ✅ 有 | 4561 |
| **null_store_phone** | `厨卫电器 · K-100` | **❌ 无**（正确不渲染无效拨号） | ✅ 有 | 4382 |
| **no_store** | `厨卫电器 · K-100` | **❌ 无** | **❌ 无**（无 entry_k 时不显示） | 4272 |

补充可见证据（TEST-KITCHEN 全文本片段）：

```
服务进度 工单号 FW20261022-9999 … 服务门店 测试门店 服务电话 028-00000000
提交时间 2026-10-22 16:03 家电 厨卫电器 · K-100 提交新工单 我提交的说明 合成数据…
```

- **`kitchen_bath` 不再以机器值出现**；品牌型号 `K-100` / `GREE KFR-35` / `X-9` 均完整保留；
- 页面标题为 `四川七方连锁售后服务平台 · 服务进度`，即真实主题已加载（非硬编码）；
- 不是往 DOM 里注入文字：这些都是组件用合成 DTO 渲染出来的结构（`.svc-progress-meta` 存在）。

---

## 3. A 组最终验收范围与限制

| 项 | 结论 | 证据级别 |
|---|---|---|
| 问题③ 门店服务电话 | **PASS** | 真实工单 API + 真实浏览器（含 `tel:`） |
| 问题④ 提交新工单入口 | **PASS** | 真实 `entry_k` → `/h5/report?k=…` 200 |
| 问题② 家电中文标签 | **PASS（本轮取得 UI 证据）** | 真实 H5 + CDP 合成 DTO，5 case DOM |
| 空门店 → 前端隐藏按钮/电话 | **PASS（前端行为）** | NOSTORE/NOPHONE 两 case DOM |
| 空门店 → 服务端 DTO 构造 | **运行期 PENDING** | 仅静态审查（见 §4） |
| 390px 布局 | **部分验证** | 390×900 视口下内容完整、无遮挡；**未测横向溢出像素值** |

> **限制声明**：本轮的 UI 证据是「**真实 H5 + 合成 DTO**」的隔离组件级验证，
> **不是**真实客户工单的 UAT；也**没有**用任何真实客户 Token。

---

## 4. 仍未完成的服务端空门店测试

`buildProgressView()` 依赖 DB repository，要隔离运行需替身 repository 或改结构 ——
按你 §四 的授权边界（"若需新建复杂环境或改生产数据则停止"），**本轮停止该项**：

- 保持 **运行期 PENDING**；
- 已有静态证据：`t.store?.contact_phone` / `t.store?.code` 可选链 + `code` 为空提前 `return null` + 签名 `try/catch`；
- 未在 candidate 库造 `store_id=2` 工单，未动 32 条历史异常工单。

---

## 5. B 组实现与回归计划

### 5.1 现状（已核）

`h5/src/utils/last-order.ts` 已存在（UX-LAST-ORDER-01），当前是**勾选式 opt-in**、按门店 code 分区、
只存 `ticketNo/token/storeCode/ticketType/createdAt/savedAt/autoOpen`、**不存客户资料**。
缺三样：① 默认保存 ② 7 天 TTL ③ 清除入口 + 防循环。

### 5.2 计划（改动清单）

| 文件 | 改动 |
|---|---|
| `utils/last-order.ts` | 去掉 opt-in 语义（保存不再依赖勾选）；加 `TTL_MS = 7d` 与 `isExpired()`；`load()` 读时过期即删并返回 null |
| `pages/Report/Success.vue` | 提交成功即 `save()`（**仅当服务端返回合法 `progress_token`**）；保留"这是公用手机，不要记住"的反向开关（**清除**语义，不是默认不存） |
| `pages/Customer/Progress.vue` | 顶部加「这不是我的工单／清除记录」按钮；清理后回到本门店报修页 |
| 路由/入口 | 从门店入口 `?k=` 进入时，若该门店有未过期记录且**未带 `skipRestore=1`** → 跳进度页；「提交新工单」带 `skipRestore=1`，避免循环 |
| 隐私 | **只有提交成功才 `save()`**；打开他人转发的进度链接**不写**本地（进度页不写，只有 Success 页写） |

### 5.3 回归用例

1. 提交成功 → 同门店再进自动到进度页；
2. 不同门店互不恢复；
3. 7 天后（改本地时间戳模拟）自动清除；
4. 清除记录后回到报修页；
5. 「提交新工单」→ 带 `skipRestore=1`，不弹回上一单、不循环；
6. 提交失败不覆盖旧记录；
7. 从短信/他人转发链接打开进度页 → 本地无新增记录；
8. `localStorage` 不可用（隐私模式）→ 全流程不报错。

### 5.4 部署

H5 单独部署（原子替换 + 备份），不涉及服务端与 Nginx；快照前后各记一次。

---

## 6. 临时工具清理

| 项 | 结果 |
|---|---|
| `cdp-profile/`（Edge 用户目录） | **已删** |
| `dto.json`（真实 DTO 模板） | **已删** |
| `cdp-test.js` | **已删** |
| Edge 进程 | 已终止 |
| 生产 H5 / 插件 / Nginx | **未改动**（本轮零部署） |
| `h5/.harness` 及旧构建产物 | 上一轮已删，本轮确认不存在 |

---

## 7. 生产数据未受影响的证据

- 本轮**零写入**：浏览器只做 GET；进度 API 请求被**本地 CDP 拦截**，根本没到达服务端；
  `publicUiTheme:get` 等放行请求均为只读。
- 未创建工单、未上传媒体、未发短信、未改 ACL。
- `git status`：仅既有的 A 组源码改动（`Progress.vue`、`progress-service.ts`、`progress.ts`、`ticket.ts`、`constants.ts`），**无新增文件**。
- 最近一次数据快照：**16:34 CST · tickets 501 / medias 566**（本轮未再取，因为无写入）。

---

## 8. 判定与申请

- **问题② 家电类别中文显示：申请 PASS**（真实 H5 DOM 证据，5 case）。
- **A 组：申请「代码与隔离组件验收 PASS / FROZEN」**，并明确保留两项限制：
  ① 服务端空门店 DTO 构造——运行期 PENDING；② 390px 横向溢出——未量化。
  ③ **未使用真实客户 Token，未做真实客户 UAT**。
- **B 组：按 §六 立即接续**，独立开发/部署/验收。
- D 组 PASS 不受影响；`D-UI-01` 继续独立 PENDING。
- 未 commit / 未 push。

P6：LIVE / CONDITIONAL；Release：HOLD。
