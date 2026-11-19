# P6-HOTFIX-02 B 组：上一单自动恢复验收报告

> 时间：2026-10-22 16:58–17:04 CST
> 部署快照：**16:59:10 · tickets 503 / medias 576**
> 结论：**B 组代码与部署完成、公网回归通过**；端到端提交流程仍需隔离环境 → **申请 PARTIAL PASS**

---

## 1. 修改文件与 diff（4 个文件，纯前端）

### 1.1 `h5/src/utils/last-order.ts`

```diff
- export const LAST_ORDER_MAX_AGE_MS = 30 * 86_400_000;
+ // 默认记忆期限 **7 天**（用户裁决）。这是**本地记忆**期限，与服务端 Token 有效期无关。
+ export const LAST_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
```

新增 `removeLastOrderByToken(token)`：进度页只知道 token（不知道门店 code），
按 token 遍历各门店分区、删掉完全相等的那条 —— **只删本地，不动服务端工单**。

### 1.2 `h5/src/pages/Report/Success.vue`

```diff
- const remember = ref(false);   const autoOpen = ref(false);
+ const remember = ref(true);    const autoOpen = ref(true);   // 默认记住
```

去掉了"必须勾选才保存"的门槛；勾选框变成「不要记住」的出口（取消即 `removeLastOrder`）。

### 1.3 `h5/src/pages/Report/index.vue`

```diff
  async function maybeRestoreLastOrder() {
    if (isPreview.value || lastOrderChecked) return;
+   // skipRestore=1 ⇒ 客户主动要新建，本次不弹回上一单（防死循环）
+   // 只在本次生效：立即从地址栏抹掉，不写任何持久存储
+   if (query.skipRestore === '1') { lastOrderChecked = true; history.replaceState(...); return; }
```

> **重要**：**自动恢复本来就有** —— `maybeRestoreLastOrder()` 会先 `fetchProgress(rec.token)`
> 校验 token，通过且 `autoOpen` 才跳转；遇 401/404/410 会 `removeLastOrder` 并提示"已失效，已清除"。
> 本轮**没有重写它**，只加了 `skipRestore` 一个出口。

### 1.4 `h5/src/pages/Customer/Progress.vue`

```diff
+ import { removeLastOrderByToken } from '../../utils/last-order';
+ function forgetThis(): void {
+   removeLastOrderByToken(token);                       // 只删本地
+   window.location.href = entry_k ? `/h5/report?k=${...}&skipRestore=1` : '/h5/report?skipRestore=1';
+ }
+ <button data-testid="progress-forget" @click="forgetThis">这不是我的工单／清除记录</button>

- return k ? `/h5/report?k=${encodeURIComponent(k)}` : '';
+ return k ? `/h5/report?k=${encodeURIComponent(k)}&skipRestore=1` : '';
```

> `skipRestore` **只影响前端自动恢复**，不参与服务端权限判断（服务端根本不读这个参数）。

---

## 2. 构建与部署

| 项 | 值 |
|---|---|
| 构建 | `vite build` ✅ · JS `index-CX10NKyZ.js` 162.60 kB · CSS `index-CwFV1B-h.css` 27.20 kB |
| 备份 | `/opt/scqf-aftersales/backup/hotfix02-B-1659/h5.tgz`（62,404 B） |
| 部署 | **原子替换**（`h5.new` → `h5`，旧目录保留为 `h5.old.1659`） |
| 只部署 | **仅 H5 静态产物**；未动插件、未动 Nginx、未动数据库 |

**公网回归**：

| 项 | 结果 |
|---|---|
| `/h5/index.html` / `/h5/report` / `/api/public/stores` | 200 / 200 / 200 |
| 线上引用新产物 | `index-CX10NKyZ.js` ✅ |
| 四站点 | hd 200 / cloud 403 / sd 000 / kanma 000（基线不变） |

---

## 3. 真实 H5 页面证据（390×900，真实合成工单 token）

| 检查 | 结果 |
|---|---|
| `data-testid=progress-forget` | **存在** ✅ |
| 文案「这不是我的工单／清除记录」 | **存在** ✅ |
| 新工单 href | `/h5/report?k=S01.mmKeroMjfmt-1dSPV5iUPw&skipRestore=1` ✅ |
| 页面完整渲染 | 5,468 B，主体/时间线/媒体区齐全 |

---

## 4. 七天 TTL

| 判据 | 结果 |
|---|---|
| 常量值 | `7 * 24 * 60 * 60 * 1000` ✅ |
| 读取时过期判定 | `readLastOrder()` 已有：`now - savedAt > MAX_AGE` ⇒ 清掉并返回 null ✅ |
| 损坏数据 | `JSON.parse` 已 try/catch，解析失败按"无记录"处理 ✅ |
| **运行期验证** | ❌ **未做**（需伪造 savedAt 或等待 7 天）。**不标 PASS** |

---

## 5. 按门店隔离 / 清除 / 防循环

| 场景 | 依据 | 状态 |
|---|---|---|
| 同门店自动恢复 | `readLastOrder(store.code)` 按 `svc.lastOrder.v1.<storeCode>` 分区 | 代码级 ✅ / 运行期未测 |
| 不同门店互不干扰 | key 前缀含 storeCode，且 storeCode 来自**服务端解析**的入口 | 代码级 ✅ |
| 手动清除 | 进度页按钮 + 成功页取消勾选，两条路都只删本地 | **页面级已验证按钮存在**；点击路径未实测 |
| 防循环 | 新工单链接带 `skipRestore=1`；`maybeRestoreLastOrder` 消费后立即从地址栏删除 | **链路已验**（href 带参 + 代码消费） |
| 打开他人转发链接不保存 | **进度页不写 localStorage**，只有 Success 页写 | 代码级 ✅ |
| 提交失败不覆盖旧记录 | 保存只发生在 Success 页（建单成功后才有 token） | 代码级 ✅ |
| localStorage 不可用 | `last-order.ts` 全部读写包 try/catch，失败返回 false/null | 代码级 ✅ / 运行期未测 |

---

## 6. 尚未完成（如实列出，不标 PASS）

| # | 项 | 原因 |
|---|---|---|
| 1 | **端到端提交流程**（提交成功→自动记住→再进自动恢复） | 需在库中造单，按令不得在生产盲目造单；**需隔离环境授权** |
| 2 | 7 天过期运行期 | 需伪造时间戳（可做，但属额外测试工具，本轮未做） |
| 3 | 跨门店隔离运行期 | 同上（需两个门店记录） |
| 4 | `localStorage` 不可用运行期 | 需浏览器禁用存储的实验配置 |
| 5 | 390px 横向溢出量化 | 只确认"内容完整、无遮挡"，**未测 `scrollWidth - clientWidth`** |
| 6 | 人工 UAT | 需真实客户/门店实操 |

---

## 7. 生产变更与回滚

- **未修改数据库**、未清理工单、未动短信配置、未触发短信、未动 A/D 组已验证功能。
- 回滚：`tar xzf backup/hotfix02-B-1659/h5.tgz -C /www/wwwroot/sh.scqfls.cn`（或把 `h5.old.1659` 换回）。
- 快照：16:59:10 · tickets **503** / medias **576**（部署前；数字为时间点快照，允许自然增长）。

---

## 8. 判定

- **B 组：代码完成 + 部署上线 + 公网回归通过**；
  但 10 项验收场景里只有 3 项拿到**页面级证据**，其余为代码级。
- ⇒ **申请 PARTIAL PASS**，不给 FROZEN。
- 最快补齐路径：**授权我在隔离库造 2 张工单（不同门店）+ 签 token**，即可一次覆盖场景 1/2/3/4/6/7/8。
- 未 commit / 未 push。

P6：LIVE / CONDITIONAL；Release：HOLD。
