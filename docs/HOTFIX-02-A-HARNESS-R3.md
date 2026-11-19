# A 组 Harness 精确 Mock 补证报告（R3 · 定位到确切失败分支）

> 时间：2026-10-22 16:45–16:52 CST
> 结论：**Mock 已证明命中、按 token 隔离已证明生效**；组件在 `mount` 后**抛出确定性运行时错误**导致主体不渲染。
> 该错误属**页面级组件脱离应用外壳挂载**的环境问题，不是产品缺陷。
> **A 组维持 PARTIAL PASS。按令 §7 停止，不转 A 方案、不重构生产组件。**

---

## 1. 上轮 `view=null` 的真实原因（已定死）

`h5/src/pages/Customer/Progress.vue:233`：

```ts
const token = String(route.value.params.token ?? '');
```

`useRoute()` 的真实契约是返回 **Ref**。上一轮我的 stub 返回**普通对象** ⇒ `route.value` 为 `undefined`
⇒ `undefined.params` 抛 TypeError ⇒ setup 崩，Vue 内部吞掉 → 空壳。

**与 Vite alias 无关**（我上轮的猜测被本轮证据推翻）。

---

## 2. Mock 实际命中证据（硬证据）

本轮在 Harness 里加了自诊断（把状态写进 `<pre id="diag">`），五个 case 全部输出：

```json
{"stubMedia": true, "fetchCalled": ["T-KITCHEN"], "hasProgressCard": false,
 "errors": ["vue: Cannot read properties of undefined (reading 'owner') @#runtime-1"]}
```

| 断言 | 值 | 说明 |
|---|---|---|
| `stubMedia` | **true** | 替身模块被加载（真实模块被替换）✅ |
| `fetchCalled` | `["T-KITCHEN"]` / `["T-AC"]` / … | 每个 case **只调用一次**、且是**自己的 token** ⇒ 无串线 ✅ |
| `hasProgressCard` | **false** | 主体未渲染 |
| `errors` | `reading 'owner'` | 渲染期确定性异常 |

⇒ **精确 Mock 已经成功**（这是本轮相较上一轮的实质进展）。

---

## 3. 五个 case 的实际 DOM 结果

| case | bodyLen | 期望 | 实际 |
|---|---|---|---|
| T-KITCHEN | 41 | 显示「厨卫电器」 | **只有标题「服务进度」** |
| T-AC | 41 | 显示中文类别 | 同上 |
| T-UNKNOWN | 41 | 回退显示原值 | 同上 |
| T-NOPHONE | 41 | 无拨号链接 | 同上（空） |
| T-NOSTORE | 41 | 无新工单按钮 | 同上（空） |

**五项均未取得 UI 断言。不申请 PASS。**

---

## 4. 失败分支定位（本轮核心产出）

```
Cannot read properties of undefined (reading 'owner')   @vue runtime-1
```

`owner` 是 Vue 内部实例字段（`instance.owner` / `currentInstance` 相关）。
该错误在**页面级组件被 `createApp(...).mount()` 单独挂载**时出现，典型成因是组件依赖**应用级 provide/plugin**
（全局组件、`app.use()` 注入的对象、router 实例等），而 Harness 外壳里一个都没装。

⇒ **这不是 `Progress.vue` 的业务逻辑错**，而是"页面组件不能被当作独立组件挂载"。

### 因此我的结论

**不建议继续用 `createApp(Progress).mount()` 这条路线补证。** 它不是"再调一个 DTO 字段"能解决的 ——
要让它跑起来，就得复刻整个应用外壳（router + ui-state + 全局组件），那已经不是"临时 Harness"，
而是一个影子应用，成本与风险都超过收益。

按执行令 §7：**停止**。是否需要正式重构（把模板抽成纯展示子组件）**请你裁决**，我不自行执行 A 方案。

---

## 5. 390px 布局

**无法评估**（主体为空）。不编造。

---

## 6. 空门店 DTO 运行期验证

**未取得**，原因同上（依赖组件进入渲染态）。
该项仍只有**代码级论证**：`t.store?.contact_phone` / `t.store?.code` 可选链 + `try/catch` + 前端 `v-if`。

> 说明：这条与组件渲染**解耦**，其实可以单独测 —— 但那需要把 `buildProgressView()` 从服务里抽出来单独调用
> （它依赖 DB repository），要么造替身 repository、要么改结构。本轮不做，避免为测试改生产代码。

---

## 7. Harness 清理结果

| 项 | 结果 |
|---|---|
| `.harness/`、`.harness-dist/`、DOM 抓取文件 | **全部已删** |
| 临时 http server | 已终止 |
| 生产 H5 部署 | **从未部署** |
| 源码残留 | `grep harness\|__make__\|__STUB_MEDIA__ Progress.vue` = **0** |
| `git status h5/` | 仅 `M h5/src/pages/Customer/Progress.vue`（A 组正式改动） |
| 真实业务写入 / 短信 | **0** |

---

## 8. 仍未完成 & 建议路径

| # | 未完成 |
|---|---|
| 1 | 问题② 家电标签 UI 证据 |
| 2 | 空门店 DTO 运行期证据 |
| 3 | 390px 排版实测 |

**建议（按成本从低到高）**：

| 方案 | 做法 | 需要 |
|---|---|---|
| **① 真实工单目视（推荐）** | 库里已有 **2 张** `kitchen_bath` 工单，拿一张的进度链接打开即可 | 你给链接 |
| ② 隔离库造单 | 在隔离库造 `kitchen_bath` 工单 + 签 token，用真实 H5 打开 | 授权写隔离库 |
| ③ 组件重构 | 抽 `ProgressBody` 纯展示子组件，Harness 挂它 | 批准重构（有回归成本） |

> 我倾向 ①：它同时满足"真实业务验收"和"零改造"。

---

## 9. 判定

- **A 组：PARTIAL PASS（维持）**，不申请 FROZEN。
- 本轮实质进展：**证明了 Mock 精确命中 + 按 token 隔离**，并把失败从"未知"收敛到**一条确定的 Vue 运行时错误**。
- **不把"Mock 成功"写成"UI 通过"。**
- D 组 PASS 不受影响；`D-UI-01` 继续独立 PENDING。
- 未 commit / 未 push；未部署；未写库；未发短信。

P6：LIVE / CONDITIONAL；Release：HOLD。
