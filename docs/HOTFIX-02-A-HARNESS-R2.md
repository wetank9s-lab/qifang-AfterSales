# P6-HOTFIX-02 · A 组 Harness 第二轮（精确 Mock）补证报告

> 时间：2026-10-22 16:43–16:50 CST
> 结论：**仍未取得 UI 证据**。但把"上轮为什么空"定位到了**确切代码分支**，并推翻了上轮的猜测。
> 按执行令 §7：**停止继续猜测，不自动转 A 方案，不重构生产组件**。
> **A 组维持 PARTIAL PASS。**

---

## 1. 上轮 `view=null` 的真实原因（已定位，非猜测）

**上轮我猜"Vite alias 对相对 specifier 不生效"——这个猜测是错的，本轮已推翻。**

真因在 `h5/src/pages/Customer/Progress.vue:233`：

```ts
const route = useRoute();
const token = String(route.value.params.token ?? '');   // ← 注意 route.value
```

组件按**真实 router 契约**（`useRoute(): DeepReadonly<Ref<RouteState>>`）取的是 `route.value`。
而我上轮的 stub 返回的是**普通对象**：

```ts
export function useRoute() { return { path: ..., params: { token } } }   // ❌ 不是 Ref
```

⇒ `route.value` 为 `undefined` ⇒ `undefined.params` 抛 `TypeError` ⇒ setup 阶段炸掉
⇒ Vue 内部捕获（所以我的 `try/catch` 抓不到），组件只留下一个空壳 `<section data-v-app="">`。
**这就是 694 字节空 DOM 的全部原因，与 alias 无关。**

---

## 2. 本轮修正与"Mock 是否命中"的证据

修正 stub：

```ts
import { ref } from 'vue';
export function useRoute() { return ref({ path, params: { token }, query: {} }); }  // ✅ 返回 Ref
```

**命中证据（间接但有力）**：修正后 DOM 从 694 B 变成 **378 B 且标题「服务进度」渲染出来了**：

```
关键文本: 服务进度
```

- 「服务进度」来自 `Progress.vue` 模板的 `<h1>服务进度</h1>` ⇒ **组件真的执行了 setup + render**；
- 若 alias 未命中、加载了真实 `api/media`，它会去打真实接口并因 `T-KITCHEN` 这种假 token 报错，
  页面会走 error 分支显示错误文案 —— 但实测**没有错误文案**，说明替身确实接管了取数。

⚠️ 但我**没有**拿到 Network/Console 的硬证据（替身是纯函数、本就不发请求；
无头 Edge 的 console 未落盘）⇒ 这条只能算"强间接证据"，不是"抓到了请求被拦截"。

---

## 3. 五个 case 的实际 DOM 结果

| case | DOM 长度 | 家电文本 | 电话链接 | 新工单按钮 | 结论 |
|---|---|---|---|---|---|
| `T-KITCHEN`（kitchen_bath） | 378 B | **未渲染** | 无 | 无 | ❌ |
| `T-AC`（air_conditioner） | 378 B | **未渲染** | 无 | 无 | ❌ |
| `T-UNKNOWN`（unknown_xyz） | 378 B | **未渲染** | 无 | 无 | ❌ |
| `T-NOPHONE`（电话为空） | 378 B | **未渲染** | 无 | 无 | ❌ |
| `T-NOSTORE`（无 entry_k） | 378 B | **未渲染** | 无 | 无 | ❌ |

五个页面**都只剩标题**，主体为空。既不显示 `厨卫电器`，也不显示原值 `kitchen_bath` ——
说明不是映射逻辑错，而是**主体区域根本没进入渲染**。

### 最可能的具体分支（供下一轮定位，不是结论）

`state` 仍是 `'loading'`，或渲染期抛错被 Vue 吞掉。我的合成 DTO 已补 `closed` / `queryable_until` /
`progress.steps` / `timeline` / `technician`，但仍可能缺模板用到的某个必填子字段
（例如 `progress.stage_label`、`submitted.*` 的某个键）⇒ 渲染函数访问 `undefined.xxx` 抛错。

**这条没有验证到，按令不再继续猜。**

---

## 4. 390px 布局

**无法评估** —— 主体没有内容，量不出排版。不编造。

---

## 5. 空门店 DTO 运行期验证

**未取得。** 它依赖组件进入 `state='ok'` 才能观察 `store_phone` / `entry_k` 的渲染效果，
而当前主体渲染不成功，所以这一项仍然只有**代码级论证**（`t.store?.` + `try/catch` + 前端 `v-if`）。

---

## 6. Harness 清理结果

| 项 | 结果 |
|---|---|
| `.harness/` / `.harness-dist/` / `.h-*.html` | **已全部删除** |
| 生产 H5 是否部署过 harness | **从未部署** |
| 源码残留 | `grep -c "harness\|__make__" Progress.vue` = **0** |
| `git status h5/` | 只有 `M h5/src/pages/Customer/Progress.vue`（A 组正式改动，与 harness 无关） |
| 真实业务写入 / 短信 | **0** |

---

## 7. 仍未完成 & 我的建议

| # | 未完成 |
|---|---|
| 1 | 问题② 家电标签的 **UI/DOM 证据** |
| 2 | 门店空值关联的 **运行期证据** |
| 3 | 390px 排版实测 |

### 建议：**停止扩建 Harness**，改用真实路径

两轮 harness 的边际收益已明显下降（第一轮踩 `route.value`，第二轮疑似 DTO 字段不全）。
继续调合成 DTO 会变成"为了让测试通过而构造数据"，这与执行令的精神相悖。

更可靠的两条路（都不改造生产组件）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **①（推荐）真实工单目视** | 库里已有 **2 张** `appliance_category='kitchen_bath'` 的工单，只要拿到其中一张的进度链接（门店/客户手上），打开即是**最硬的证据** | 需你提供一枚链接 |
| ② 隔离库造单 | 在**隔离库**（非生产 candidate）造一张 `kitchen_bath` 工单并签 token，用真实 H5 打开 | 需授权写隔离库 |

> 这两条都比继续做 harness 更接近"真实业务验收"，也符合执行令"不得用合成测试冒充 UAT"的要求。

---

## 8. 判定

- **A 组：PARTIAL PASS（维持）**，不申请 FROZEN。
- 本轮的实质产出是**推翻了自己的错误猜测并定位到确切代码分支**（`route.value` 形态错），
  这比"编一个通过"更有价值，但它不等于 UI 已验证。
- D 组 Logo URL 修复 PASS 不受影响；`D-UI-01` 继续独立 PENDING。
- 未 commit / 未 push；未部署；未写库；未发短信。

P6：LIVE / CONDITIONAL；Release：HOLD。
