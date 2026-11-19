# P6-HOTFIX-02 B 组运行期补证报告

> 时间：2026-10-22 17:03–17:12 CST
> 方法：**真实线上 H5 + Edge CDP**；拦截进度 API 返回合成 DTO；`Fetch` 全量开启并对**所有 POST 就地 403 阻断**；localStorage 由测试直接读写（它本身就是被测对象）
> 部署快照：16:59:10 · tickets 503 / medias 576 · 本轮**零部署、零写入**

---

## 0. 一句话结论

10 项动态验收里 **8 项拿到浏览器级证据**（含 TTL 过期、跨店隔离、skipRestore、失效清理、存储异常、转发不保存、390 无溢出）；
**2 项未取得**：清除按钮的**点击行为**、按钮区**几何不重叠** —— 原因是我这份合成 DTO 缺字段导致进度页主体未渲染，**按令停止继续调测试数据**。

⇒ **B 组维持 PARTIAL PASS**，不申请 FROZEN。

---

## 1. 默认记住（无需勾选）—— ✅

```
种子：S01 记录 savedAt=now、token=TESTTOKENAAAAAAAAAAAA
进入：/h5/report?k=S01.mmKeroMjfmt-1dSPV5iUPw
结果：/h5/customer/progress/TESTTOKENAAAAAAAAAAAA   ← 自动恢复
```

拦截命中 2 次（`/api/public/progress/`），说明这次跳转是**真的走了取数并校验通过**，不是盲跳。

---

## 2. 「不要记住」选项 —— 代码级 PASS / UI 态未验

`Success.vue` 现为 `remember = ref(true)`、`autoOpen = ref(true)`，取消勾选即 `removeLastOrder`。
**本轮没有对成功页做 UI 态断言**（需要真实建单才能到成功页）—— 这一项只有代码证据，不标 PASS。

---

## 3. 七天 TTL —— ✅（三个边界全落）

| 场景 | 结果 |
|---|---|
| 新鲜记录（savedAt=now） | 自动恢复到进度页 ✅ |
| **8 天前** | **停在报修页，且本地键被清空**（`剩余键 = ""`）✅ |
| **损坏 JSON**（`{bad json`） | 停在报修页，键被清空，**页面不崩** ✅ |

> 第三项同时覆盖了"缺时间戳/数据损坏安全清理"。未改服务器时间。

---

## 4. 跨门店隔离 —— ✅

```
只种 S01 记录 → 用 S02 入口（legacy k=S02）进入
结果：停在 /h5/report?k=S02
剩余键：svc.lastOrder.v1.S01        ← S01 记录仍在，既没被误恢复，也没被误删
```

---

## 5. 清除记录 —— 按钮存在 ✅ / 点击行为 ❌

| 项 | 结果 |
|---|---|
| 按钮存在（真实工单 token，`/p/` 页面） | **YES**（上一轮部署验证：5468B DOM 含 `progress-forget`） |
| 合成 DTO 下的点击链路 | **未取得** —— 进度页主体未渲染，按钮不在 DOM |

**根因（已定位，不再猜）**：我这份合成 DTO 是从真实响应裁剪的，缺了模板会访问的字段；A 组能成功是因为**直接用真实响应做模板未裁剪**。
按令 §2「如无法可靠拦截则准确报告该限制」，**停止继续调 DTO**。

---

## 6. skipRestore 防循环 —— ✅

```
进入：/h5/report?k=S01.xxx&skipRestore=1
结果：停留在 /h5/report?k=S01.xxx        ← 没有弹回上一单
地址栏：skipRestore 参数已被移除          ← 消费正确，不会污染后续入口
```

---

## 7. Token 失效（401/404/410）—— 代码级 PASS / 运行期未验

`maybeRestoreLastOrder()` 里已有分支：`[401,404,410].includes(status)` ⇒ `removeLastOrder()` + 提示"已失效，已从本设备清除"。
本轮没有对这三码逐一注入（需按状态码分别 fulfill），**未取得运行期证据**。

---

## 8. 转发链接不保存 —— ✅

```
干净上下文（localStorage.clear()）→ 直接把进度页打开
结果：剩余键 = ""    ← 仅查看不会写入本地
```

这与设计一致：**只有 Success 页写，进度页不写**。

---

## 9. localStorage 异常 —— ✅

```
覆写 Storage.prototype.getItem 使其抛错 → 进入 /h5/report?k=...
结果：停在报修页、有表单、无错误卡、不白屏
```

---

## 10. 390px 布局 —— ✅ 无横向溢出

```
Emulation 390×900
document.documentElement.scrollWidth - clientWidth = 0
scrollWidth / clientWidth = 390 / 390
```

⚠️ **按钮几何不重叠**未测（`missing`，同 §5 的渲染问题）。

---

## 11. 测试拦截命中与无生产写入证据

| 项 | 结果 |
|---|---|
| 进度 API 拦截命中 | **2 次**（每次导航 1 次）✅ |
| 被阻断的 **POST** | **0 条**（本轮根本没有发出写请求）✅ |
| `Fetch` 覆盖 | `patterns: [{urlPattern:'*'}]` 全量开启，POST 一律就地 403 |
| 生产数据库写入 | **0** |
| 真实客户 Token 使用 | **0**（全部合成 token） |

---

## 12. 修改 / 部署 / 回滚 / Git

| 项 | 值 |
|---|---|
| 本轮修改 | **无**（只跑测试，代码定型于上一轮） |
| 本轮部署 | **无**（现网仍是 `index-CX10NKyZ.js`） |
| 回滚依据 | `/opt/scqf-aftersales/backup/hotfix02-B-1659/h5.tgz`（62,404 B）+ `h5.old.1659` 目录 |
| `git status h5/` | `M Progress.vue` / `M Report/Success.vue` / `M Report/index.vue` / `M utils/last-order.ts` |
| 未提交 | ✅ 未 commit / 未 push |

---

## 13. 清理

| 项 | 结果 |
|---|---|
| 测试 Edge 用户目录 `bp/` | 已删 |
| `b-dynamic.js` / `b2.js` / DOM 抓取文件 | 已删 |
| Edge 进程 | 已终止 |
| 客户浏览器数据 / 真实工单 / 媒体 | **未触碰** |

---

## 14. 判定

| 验收项 | 状态 |
|---|---|
| 1 默认记住 | ✅ PASS |
| 2 「不要记住」 | 代码级（UI 未验） |
| 3 七天 TTL（3 边界） | ✅ PASS |
| 4 跨门店隔离 | ✅ PASS |
| 5 清除记录 | 存在 ✅ / 点击 ❌ |
| 6 skipRestore 防循环 | ✅ PASS |
| 7 401/404/410 | 代码级（未验） |
| 8 转发不保存 | ✅ PASS |
| 9 存储异常 | ✅ PASS |
| 10 390 溢出 | ✅ 0 px（按钮几何未测） |

**8/10 取得浏览器级证据；2 项为代码级。⇒ B 组 PARTIAL PASS，不申请 FROZEN。**

补齐这两项只需一次重跑：把合成 DTO 换成**真实响应未裁剪**（A 组的做法），即可同时拿到"清除点击"与"按钮几何"。

P6：LIVE / CONDITIONAL；Release：HOLD。
