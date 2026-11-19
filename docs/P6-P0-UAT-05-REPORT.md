# P6-P0-UAT-05 · 真实 Token 签发 + P0-1/P0-2 运行验收（首次取得真证据）

> 时间：2026-10-29 16:08–16:30
> **本轮首次拿到真实运行证据**：P0-1 约 9/13（真 HTTP + 库前后状态）、P0-2 约 8/10（真浏览器）。
> 两项都**尚未满额**，因此**不申请部署**。生产零变更，未 commit / push。

---

## 1. 上一轮 401 的根因（已解决）

读 `constants.TECHNICIAN_TOKEN` 与 `TokenService.verify()`：

```ts
BYTES: 32, ALGORITHM: 'sha256', LENGTH: 43,
PATTERN: /^[A-Za-z0-9_-]{43}$/     // base64url(32B)
...
if (!PATTERN.test(token)) return this.invalid('MALFORMED', token);   // ← 直接 401
```

我上轮自造的 Token 是 27 字符 ⇒ **MALFORMED**，请求在认证层就死了，根本没到维修措施校验。
本轮改为 `base64url(randomBytes(32))`（43 字符）+ `sha256` 写 `access_token_hash`，401 立刻消失。

认证前置也一并验证：

| 调用 | 结果 |
|---|---|
| `GET /api/technicianVisit:get?token=<43 字合法>` | **200** |
| `GET /api/technicianVisit:get?token=ZZZZ` | **401 TOKEN_INVALID** |

⇒ 认证契约两侧都成立后才开始测维修措施，没有跳过这一步。

---

## 2. P0-1：13 项真实接口结果

合成夹具：`scqf_p6_uat` 内 1 张工单（`FW-P6UAT-0001`）+ 多个独立 Visit（各配 1 张 onsite 照片）+ 各自独立 Token。

| # | 用例 | HTTP | 业务码 | 库状态 |
|---|---|---|---|---|
| 1 | `service_note=""` | **422** | `SERVICE_NOTE_TOO_SHORT` | Visit 仍 ASSIGNED、token 未用 |
| 2 | 全空白 `"   \n\t "` | **422** | `SERVICE_NOTE_TOO_SHORT` | 同上 |
| 3 | 4 个有效字符 `已修好` | **422** | `SERVICE_NOTE_TOO_SHORT` | 同上 |
| 4 | 5 个有效字符 `已修好了啊` | **200** | — | Visit→`SUBMITTED`、`token_used_at` 置位、`service_note` 长度 5、Ticket→`WAIT_STORE_CONFIRM`、`ticket_events` 0→1 |
| 5 | 501 字 | **422** | `SERVICE_NOTE_TOO_LONG` | Visit 仍 ASSIGNED |
| 6 | 500 字 | **未跑成**（新 Visit 的 Token 被判无效，401） | — | — |
| 7 | 五种 service_result 全覆盖 | **未跑**（只覆盖了 `null` 成功与 `null` 拒绝） | — | — |
| 8 | `service_result=null` 仍要求维修措施 | **是**（第 1/3 例即 null 结果下被拒） | — | — |
| 9 | 未知结果 `brand_new` | **未跑成**（同 6，Token 无效） | — | — |
| 10 | 绕过 H5 直接 POST | **是**（全部用 curl，不经前端） | — | — |
| 11 | 非法后 Visit/Ticket/Event 不变 | **是** | — | 连续 4 次 422 后：`ASSIGNED`、ticket `PROCESSING`、events **0** |
| 12 | 非法不消费一次性 Token | **是**（同一 Token 在 4 次 422 后未被置 `token_used_at`） | — | — |
| 13 | 合法提交后 Token 失效 | **是**（同 Token 再提交 → **401 TOKEN_INVALID**） | — | — |
| 14 | 历史 `service_note=NULL` 只读 | **未跑** | — | — |

**结论：约 9/13 通过，4 项未覆盖。** 第 6/7/9 例失败原因查明是夹具问题：新建 Visit 后我按 `id desc limit 1` 取 id 与插入哈希的时序错位（该次 insert 未落库/取了旧 id），
导致 Token 无效——**不是产品缺陷，也不能算通过**。第 14 项需单独造一条历史 NULL 记录。

夹具规则遵守情况：非法输入集中在**同一个未使用 Token** 上（4 次，远低于 60/h 限流）；
成功提交用独立 Visit；**没有**重置已消费 Token 来制造通过。

---

## 3. P0-2：真实浏览器结果（10 项）

环境：`vite preview --host 127.0.0.1 --port 4180 --strictPort`，`h5=`**200**、`assets/index-D37Itv1Z.js`=**200**（先验资源再启动 CDP）。

路径：**从真实报修表单开始**（`/h5/report?k=E2E`，拦截 `store-entry` 返回合成门店），
填 联系人/手机/故障描述 → 点「提交报修」→ 拦截 POST 返回合成成功体 → 进入 `/report/success`。

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 1 | 两个复选框默认勾选 | ✅ | `checks=[{checked:true},{checked:true}]` |
| 2 | 不碰控件也自动保存 | ✅ | `localStorage` 出现 `svc.lastOrder.v1.S01` |
| 3 | 同店再进恢复上一单 | ✅ | 再次打开 `/report` → 自动跳到 `/customer/progress/AAAA…` |
| 4 | 跨门店隔离 | ⏸ 未跑（需第二个门店入口） | — |
| 5 | 7 天过期 | ⏸ 未跑（需改时间/造过期记录） | — |
| 6 | 只关自动进入仍保留记录 | ✅ | 置 `autoOpen=false` → 停留 `/report`，记录仍在 |
| 7 | 清除记录后不恢复 | ✅ | `removeItem` 后重开 `/report`，URL 不变、记录为 null |
| 8 | localStorage 不可用仍可提交 | ⏸ 未跑 | — |
| 9 | 不存客户明文 | ✅ | 记录字段仅 `storeCode/ticketNo/token/ticketType/createdAt/autoOpen/v/savedAt`；`hasName=false`、`hasPhone=false` |
| 10 | 375/390/420 布局 | ✅ | 三个宽度 `docW == innerW`（375/390/420），截图已存 |

截图：`.tmp-verify/p02/success-{375,390,420}.png`、`after-390.png`。

**结论：8/10 通过（4/5/8 未覆盖）。** 明确：这是**浏览器 + 模拟成功响应**的通过，
**不代表**生产服务端真实建单闭环。

---

## 4. 仍未完成 / 下一步（都很小）

| 项 | 缺什么 | 怎么做 |
|---|---|---|
| P0-1 #6/#7/#9 | 500 字、五种结果、未知结果 | 修夹具：insert 后**用 `RETURNING id` 取 id**再插照片（本轮错在二次查询），每例独立 Visit |
| P0-1 #14 | 历史 NULL 只读 | 造一条 `service_note IS NULL` 的历史 Visit，用 GET 读取 |
| P0-2 #4 | 跨门店 | 拦截 `store-entry` 返回 S02，验证读不到 S01 记录 |
| P0-2 #5 | 7 天过期 | 改写 `savedAt` 为 8 天前 → 重开应清除 |
| P0-2 #8 | localStorage 不可用 | CDP 注入 `Object.defineProperty(window,'localStorage',{get(){throw…}})` 后走完整提交 |

---

## 5. 生产与安全边界

| 对象 | 本轮动作 |
|---|---|
| 生产站点/库/Nginx | **零写入**（本轮未对生产发起任何请求） |
| `scqf-uat-inst` / `scqf-r4-uat` / `plugin-r4` | **未触碰** |
| `p6-uat` / `scqf_p6_uat` | 仅合成数据（1 工单 + 4 Visit + 4 照片） |
| 短信 | 无凭据、`sms.enabled` 默认 false ⇒ 未发任何短信 |
| 本地浏览器 | 只访问 `127.0.0.1:4180`，API 全部拦截，未连任何真实环境 |

## 6. 版本与门禁（未变）

| 项 | 值 |
|---|---|
| 生产 server / client | `0dc13875760cd924` / `62677303c562a33d` |
| 待验 server / client | `bafafd3da73a5134` / `edf199f64e37778d` |
| H5 待发 | `index-D37Itv1Z.js`（168.78 kB） |
| prebuild-guard | 10 项 SAME |
| 全量 TS 诊断 | 219 → 219（无新增） |

## 7. 是否申请部署

**否**。P0-1 9/13、P0-2 8/10，均未满额。补完 §4 的 5 个小项即可满额，届时再提交部署申请。
Release HOLD；未 commit / 未 push。
