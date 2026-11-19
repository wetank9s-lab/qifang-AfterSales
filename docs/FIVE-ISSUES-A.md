# P6-PROD-FIVE-ISSUES-01 批次 A 定位报告

> 2026-10-25 16:56–17:05 · 生产只读
> **未写生产数据、未改 Nginx、未重启、未 commit。**

---

## 1. FW20261025-0003 评价是否真实落库？—— **没有**

只读核对（ticket 6926 / visit 2641）：

| 字段 | 实际值 |
|---|---|
| `status` / `review_status` | `WAIT_FEEDBACK` / **`pending`** |
| `rating` | **NULL** |
| `review_comment` 长度 | **0** |
| `reviewed_at` | **NULL** |
| `feedback_token_used_at` | **未使用** |
| `ticket_events` 里 `reviewed` | **不存在**（事件止于 16:36 `store_confirmed`） |
| Visit 2641 | `CONFIRMED` / `resolved` / `is_charged=true` / 报费 **1000.00** |

⇒ **客户评价没有提交成功，或者根本没提交。**
不是"落库了但后台不显示"，而是**数据层面就没有评价**。

**这属于令里"情况 C"**（DB 无评价 → 要查提交响应/事务/前端成功判断）。
但也要先排除最简单的可能：客户点开链接后看到"金额一致/不一致"要求而没提交（这单`is_charged=true`，必须选收费核对才能提交）。

## 2. `/f/:reviewToken` 为什么进后台登录页？—— **Nginx 缺 `/f/` 的 location**

实测（合成 token，不使用真实凭据）：

| 请求 | 状态 | 说明 |
|---|---|---|
| `/p/AAAAAAAAAAAAAAAAAAAAAA` | **302** → `/h5/customer/progress/…` | ✅ 有专门 location |
| `/f/fakeA…`（43 位） | **200**，**无 Location** | ❌ 没有专门 location，落到 `location /` → 反代到 NocoBase 后台 SPA |
| `/h5/customer/review/fakeA…` | 200（H5 静态页） | ✅ 页面本身是好的 |

配置文件里只有 `/p/` 的两条 location（184、192 行），**`grep /f/` 0 命中**。

⇒ 根因：**缺 `location ~ "^/f/(?<t>[A-Za-z0-9_-]{43})$" { return 302 /h5/customer/review/$t; }`**，
短链被后台 SPA 兜住 → 显示登录页。与 `/p/` 的写法完全对称，可精确匹配。

## 3. Android 视频时长 —— **PENDING**

需要测试人员 Android 实拍样本（原始字节、不改后缀）。无样本无法定位是前端 `durationchange` 探测失败还是 `media-format.ts` 的 `DURATION_UNREADABLE` / `KIND_UNREADABLE` 分支。
**不做推测。**

## 4. 客户进度页合并评价（P1-C）

E 组隔离 PASS 的实现在**当前源码**里，但生产实测：
- 生产客户端 `svc/*` 路径集 = 12，**不含任何 progress 评价相关端点**（`publicProgress:review` 是 H5 直连 action，不经 svc）；
- 生产 H5 产物未见 `ProgressReview` 组件痕迹 → **E 组未上线**。

结论：**能复用**（同一套 `submitReview` + 条件更新），但**需要 H5 + 插件一起发布**，会触发未授权迁移 ⇒ 属批次 C，须专项方案。

## 5. 技师端移除"处理结果"（P2）

只读核对：`service_result` 是 `POST /api/technicianVisit:submit` 的**必填**字段（服务端枚举校验 5 值），且被
`visitConfirm`（无校验）、客户评价页展示、门店审核区 01 依赖。

⇒ 删除 UI 控件**必须同时**给服务端一个明确策略，否则会出现"删了字段 → 服务端 422 → 师傅无法提交"或"自动填 resolved 掩盖真实情况"。
最小方案（待裁决）：**保留字段但改为"未完成服务"复选框**，勾选写 `customer_absent/unresolved`，不勾选写 `resolved` —— 不新增枚举、不改状态机。

---

## 六、五项状态

| # | 问题 | 状态 | 归属批次 |
|---|---|---|---|
| 1 | Android 视频时长 | **PENDING**（缺实拍样本） | A/B |
| 2 | 评价后台不同步 | **已定位为"评价未落库"**，需查提交链路 | A→B |
| 3 | 统一进度链接 | 方案可行（复用 E 组），**需 H5+插件同发** | C |
| 4 | 技师端移除处理结果 | 影响面已核清，**方案待裁决** | C |
| 5 | `/f/` 短链 | **根因确定：Nginx 缺 location**，最小修复方案已给出 | B（可独立热修） |

## 七、生产变更与风险

| 项 | 需要的变更 | 风险 |
|---|---|---|
| `/f/` 短链 | 仅 Nginx 加 1 条 location + reload | 低（与 `/p/` 同构，可秒级回滚） |
| 评价同步 | 先查提交链路，可能无需代码变更 | 待定 |
| 统一进度页 | H5 + 插件发布 | **高**：会触发 202610231/2051/2052 迁移 |
| 移除处理结果 | H5 + 服务端契约 | 中 |

**未授权迁移风险仍在**：任何插件重启都可能执行 3 条未批准迁移（其中 2 条建表）。

生产零改动；未 commit / 未 push。
