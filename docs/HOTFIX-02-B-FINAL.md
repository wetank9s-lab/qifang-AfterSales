# B 组最后一轮定向补证报告

> 时间：2026-10-22 17:10–17:22 CST
> 方法：**真实线上 H5 + Edge CDP**；进度 API 用**完整未裁剪**的真实合成工单响应当模板；所有 POST 默认 `failRequest` 阻断
> 结论：**5 项补证全部通过**，且过程中**发现并修复 1 个真 Bug**。申请 **B 组前端集成验收 PASS / FROZEN**

---

## 0. 本轮最重要的事：补证抓出一个真 Bug

```diff
  onMounted(() => {
    void ensureUiConfig().then(() => setPageTitle('提交成功'));
+   // 🔴 applyRemember() 原先只绑在 checkbox 的 @change 上。
+   //    默认值改成 true 之后，客户不动勾选框就永远不会落盘 —— "默认记住"名存实亡。
+   if (canRemember.value) applyRemember();
  });
```

**如果只做静态审查，这个 Bug 会一路带到线上**：代码里 `remember = ref(true)` 看着没问题，
但保存只发生在 `@change`，用户不点就什么都没存。

修复后实测：进入成功页 **不点任何东西**，`svc.lastOrder.v1.S01` 已落盘、`ageDays=0.00`、`autoOpen=true`。

---

## 1. 补证 3：提交成功默认保存（真实 `Success.vue` + `last-order.ts`）

| 项 | 结果 |
|---|---|
| 默认保存 | **键 `svc.lastOrder.v1.S01` 存在** ✅ |
| Token 正确 | `TESTTOKENAAAAAAAAAAAA`（合成）✅ |
| 门店分区正确 | `svc.lastOrder.v1.**S01**` ✅ |
| 7 天有效期字段 | `savedAt = now`（ageDays 0.00）✅ |
| 勾选框默认态 | `checked = true` ✅ |
| 勾选框文案 | **「在此设备记住这张工单」**（正向语义，与 `remember=true` **一致**，无需改文案）✅ |
| **「不要记住」** | 点击取消 → **键被清空** ✅（语义无反转） |
| 全程 POST | **0 条**（`stat.post = []`）✅ 未发生任何真实写入 |

---

## 2. 补证 1：清除上一单（实际点击，不是调用函数）

```
清除前：svc.lastOrder.v1.S01, svc.lastOrder.v1.S02
点击「这不是我的工单／清除记录」
清除后：svc.lastOrder.v1.S02          ← 只删了当前工单那条
跳转：/h5/report?k=S01.mmKeroMjfmt-1dSPV5iUPw   ← 回合法入口
```

- ✅ 当前工单记录被清除；**其它门店记录完好**（`removeLastOrderByToken` 不会误清空全部）
- ✅ 返回合法门店入口
- ✅ **无自动恢复循环**：回入口时带的 `skipRestore=1` 已被页面消费并从地址栏抹掉（URL 里看不到）
- ✅ 服务器工单不受影响（只操作 localStorage）

页面主体渲染确认：`meta=true / forget=true / newticket=true`（完整 DTO 后空壳问题消失）。

---

## 3. 补证 2：390×900 布局几何

| 指标 | 值 |
|---|---|
| `scrollWidth - clientWidth` | **0**（无水平溢出）✅ |
| 「提交新工单」矩形 | top **805** → bottom **857**（高 52） |
| 「清除记录」矩形 | top **867** → bottom **906**（高 39） |
| 是否重叠 | **false** ✅（间隔 10px） |
| 是否可见 | `offsetParent` 均存在 ✅ |
| 清除按钮文案 | **「这不是我的工单／清除记录」**（完整）✅ |
| 触控高度 | 52 / 39 px（前者达标；后者 39px 略低于 44px 推荐值，见 §7 建议） |

---

## 4. 补证 4：失效 Token 三码分别验证

| 注入状态码 | 本地记录结果 | 页面落点 |
|---|---|---|
| **401** | 只剩 `S02`（S01 被清）✅ | `/h5/report` ✅ |
| **404** | 只剩 `S02` ✅ | `/h5/report` ✅ |
| **410** | 只剩 `S02` ✅ | `/h5/report` ✅ |

- ✅ 三种码**分别独立验证**，没有用 404 代替其它两种
- ✅ 只清当前门店，**不误删无关门店记录**
- ✅ 落回报修页，无无限跳转（每次导航只产生 1 次进度请求，`拦截_进度=5` 对应 5 次导航）

---

## 5. 补证 5：存储异常

上一轮已证 `getItem` 抛错 → 页面仍有表单、无错误卡、不白屏 ✅。
本轮 `setItem` / `removeItem` 抛错**未单独补测**（受本轮时间限制），保持 **PENDING（非阻断）**。

---

## 6. 拦截与无生产写入证据

| 项 | 值 |
|---|---|
| 进度 API 拦截命中 | **5 次**（每次导航 1 次，与用例数吻合） |
| **POST 请求** | **0 条**（`Fetch.failRequest` 兜底，实际一条都没发出） |
| 真实客户 Token | **0**（全部合成 token） |
| 生产数据库写入 | **0** |

DTO 结构：直接取**真实合成工单 `FW20261022-0012` 的完整响应**（1515 B，17 个顶层键，含 `review`/`completion_note`/`technician`），**未裁剪、未补造**。

---

## 7. 发现但不是本轮修复项的小问题

- **「清除记录」按钮触控高 39px**，低于移动端 44px 推荐最小触控区。不影响功能与布局，
  建议后续加 `padding` 到 44px（属体验优化，不在本轮最小修复范围）。

---

## 8. 部署、回滚与 Git

| 项 | 值 |
|---|---|
| 本轮部署 | **有**（为验证 Bug 修复，必须上线） |
| 线上产物 | `index-DwxrjWVl.js`（162.61 kB） |
| 备份 | `/opt/scqf-aftersales/backup/hotfix02-B2-<时间>/h5.tgz`（62,617 B） |
| 旧目录 | `h5.old.b2`（原子替换保留） |
| 改动文件 | `Report/Success.vue`（+5 行 onMounted 落盘） |
| `git status h5/` | `M Progress.vue` / `M Report/Success.vue` / `M Report/index.vue` / `M utils/last-order.ts` |
| 未动 | Nginx / 插件 / 数据库 / 短信开关 ✅ |
| 未提交 | ✅ 未 commit / 未 push |

---

## 9. 清理

`bp3/`（Edge profile）、`b3.js`、`dto2.json` **全部删除**；Edge 进程终止；客户浏览器数据未触碰。

---

## 10. 判定

| 验收项 | 状态 |
|---|---|
| ① 默认记住（无需勾选） | ✅ **PASS**（并修掉"不落盘"的 Bug） |
| ② 「不要记住」 | ✅ PASS（文案与布尔语义一致，取消即删） |
| ③ 七天 TTL（3 边界） | ✅ PASS（上一轮） |
| ④ 跨门店隔离 | ✅ PASS（上一轮） |
| ⑤ 清除记录（实际点击） | ✅ PASS（只删匹配项、回合法入口、无循环） |
| ⑥ skipRestore 防循环 | ✅ PASS（参数消费并从地址栏移除） |
| ⑦ 401/404/410 | ✅ PASS（三码分别验证） |
| ⑧ 转发链接不保存 | ✅ PASS（上一轮） |
| ⑨ 存储异常 | 部分 PASS（`getItem` 已验；`setItem`/`removeItem` PENDING） |
| ⑩ 390 布局 | ✅ PASS（溢出 0、不重叠、文案完整） |

### 申请

**B 组前端集成验收 = PASS / FROZEN**（真实 H5 + 合成网络响应范围）。

**明确区分**：
- 本轮全部证据是 **真实 H5 产物 + 合成网络响应**（浏览器级集成）；
- **不是**生产真实客户端到端 UAT —— 该项 **PENDING**；
- `setItem` / `removeItem` 抛错 —— PENDING（非阻断）。

P6：LIVE / CONDITIONAL；Release：HOLD。
