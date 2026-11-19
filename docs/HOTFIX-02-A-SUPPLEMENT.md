# P6-HOTFIX-02 · A 组补证与 LEGACY 范围核实

> 时间：2026-10-22 16:26–16:32 CST
> 本轮：只读核查（**未改代码、未部署、未写库**）
> 结论：A 组补证中的**空值安全 = PASS（代码级）**；**LEGACY-ENTRY-01 范围 = 无越权**；
> **问题② UI 补证仍 PENDING**；B / C / D / E 组**未开始**。

---

## 1. 空值安全（28 条孤儿门店 + 4 条门店为空的工单）

### 1.1 代码级证据

新增两段的每一次门店访问都写了可选链 + 兜底，**没有任何未保护解引用**：

```ts
store_phone: ((): string | null => {
  const v = (t as any).store?.contact_phone;   // store 为 undefined ⇒ v = undefined
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;                          // ⇒ 返回 null，不抛
})(),

entry_k: ((): string | null => {
  const code = String((t as any).store?.code ?? '').trim();  // 同上
  if (!code) return null;                                   // 无门店码 ⇒ 提前返回 null
  try { return signStoreEntry(code, signingSecretOf(process.env)); }
  catch { return null; }                                    // 签名异常 ⇒ 吞掉并返回 null
})(),
```

| 核查点 | 结论 |
|---|---|
| `t.store` 为 null/undefined | `?.` 短路，两字段回 `null`，**不抛错** |
| 缺门店 code | `entry_k` 提前 `return null`，**不会用空串去签名** |
| 签名抛异常 | `try/catch` 兜住并回 `null` |
| `store_phone` 为空/空白 | trim 后为空 ⇒ `null` |
| 进度主内容 | 完全不依赖这两个字段，原有字段链路未改 |
| 前端「提交新工单」 | `v-if="newTicketHref"`，`null → ''` ⇒ **按钮不渲染** |

### 1.2 为什么**没有**运行期证据（必须说清）

那 28 + 4 张工单的**进度 token 明文不可得**（库里只存 sha256 哈希，明文只在建单响应里出现过一次）。
⇒ **无法**构造一次真实调用来观察它们的 progress 响应。

所以这一项给的是**代码级论证**，不是运行期实测。若要运行期证据，需要你授权在**隔离库**里造一张
`store_id=2` 的工单并签发 token —— 那是写入操作，我不擅自做。

---

## 2. 问题② UI 补证：**仍 PENDING**

- 代码侧已完成：`applianceLabel` 走 `APPLIANCE_CATEGORY_OPTIONS`（`kitchen_bath → 厨卫电器`），
  未知值回退原值（不显示空白）。
- **但"组件 DOM 渲染证据"我本轮没做出来**：要渲染 `Progress.vue` 并注入合成 DTO，
  需要一个临时挂载宿主（vite 入口或 Vue 单测环境）。当前工程没有这套 harness，
  临时搭一个属于新增工程脚手架，不在"最小修复"范围内。
- **不把"逻辑正确"写成"UI 已验证"。** 这一项继续 PENDING，等：
  ① 你不介意我加一个临时 harness；或 ② 一张真实 `kitchen_bath` 工单的进度链接。

---

## 3. LEGACY-ENTRY-01 范围核实 —— **无越权**

`?k=S09`（裸门店码）走的是**既有 legacy 兼容**，实测只拿到公开报修所需的门店资料：

```
k=S09        → 200  {"code":"S09","name":"新津欣盛电器","phone":"028-82513363","address":"新津区武阳中路27号"}
k=S01.坏签名  → 404  （坏签名被拒，不回落 legacy）
```

**私有能力全部 401**：

| 探测 | 结果 |
|---|---|
| `/api/serviceTickets:list`（无登录） | **401** |
| `/api/serviceTickets:get?filterByTk=1` | **401** |
| `/api/public/media/files/1`（无会话） | **401** |
| `/api/customerMedias:list` | **401** |
| `/api/historicalServiceArchives:list` | **401** |
| `/admin`（SPA 壳） | 200（**壳**，后台 API 仍需登录） |

结论：
- ✅ 不能读私有工单、不能读历史档案、不能取私有媒体、不能提升员工权限；
- ✅ 只能做既有公开报修（提交工单 + 拿门店公开资料）；
- ⚠️ 门店电话/地址属**公开信息**（印在二维码页面上），不构成越权；
- **未关闭 legacy 入口**（已印制的二维码依赖它）。

---

## 4. 其余各组：未开始

| 组 | 内容 | 状态 |
|---|---|---|
| **B** | 默认记住上一单 + 7 天 TTL + 清除 + 防循环 | 未开始 |
| **D** | 后台 Logo 403 | 未开始 |
| **C** | Android 时长 + 50MB 四层 + 录音布局 | 未开始 |
| **E** | 评价授权**设计**（只设计不实施） | 未开始 |

本轮上下文/时间用于 A 组补证与 LEGACY 核实，未推进 B/C/D/E。**不虚报。**

---

## 5. 判定

| 项 | 状态 |
|---|---|
| 问题③ 门店电话 | **PASS** |
| 问题④ 新工单入口 | **PASS**（服务端 + 按钮 + 入口页 200 均已验） |
| 问题② 家电标签 | **代码完成 / UI 补证 PENDING** |
| 空值安全（孤儿门店） | **代码级 PASS**，运行期待隔离库授权 |
| LEGACY-ENTRY-01 | **PASS（无越权）**，入口保留 |

**A 组 = PARTIAL PASS（维持）**，暂不能给 FROZEN —— 卡在问题②的 UI 证据。

未改代码、未部署、未写库、未发短信。未 commit / 未 push。
