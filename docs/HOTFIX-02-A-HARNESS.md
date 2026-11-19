# P6-HOTFIX-02 · A 组临时 Harness 补证报告（未达成，证据不足）

> 时间：2026-10-22 16:37–16:44 CST
> 结论：**Harness 搭起来并成功编译，但组件未渲染出内容 ⇒ 补证未达成。**
> **不申请 A 组 FROZEN**。问题② 的 UI 证据仍然缺失。

---

## 1. 做了什么（可复现）

在 `h5/.harness/` 下建了一次性 Harness（**已删除**）：

| 文件 | 作用 |
|---|---|
| `main.ts` | 真实 `import Progress from '../src/pages/Customer/Progress.vue'`，用 `createApp` 逐个 case 挂载 |
| `stub-media.ts` | 替身：`fetchProgress()` 返回合成 DTO（**不发任何网络请求**） |
| `stub-router.ts` | 替身：`useRoute()` 返回固定 token |
| `stub-uistate.ts` / `stub-http.ts` | 替身：UI 配置与 `ApiError` |
| `vite.config.ts` | `resolve.alias` 把四个依赖替换成替身，`base: './'` |

**5 个合成用例**：`kitchen_bath` / `air_conditioner` / `unknown_xyz` / `null_store_phone` / `no_store`。

编译：`vite build` **成功**（72.89 kB JS）—— 说明 alias 生效、组件能编译。

---

## 2. 失败点（必须如实说）

用 Edge 无头渲染 `http://127.0.0.1:8899/index.html`，`--virtual-time-budget=8000`，DOM 只有 **694 字节**：

```html
<section data-case="kitchen_bath" data-v-app=""> …（无内容） </section>
```

5 个 case **全部是空壳**：

| case | 家电文本 | 新工单按钮 | 电话 | 异常块 |
|---|---|---|---|---|
| kitchen_bath | 无 | 无 | 无 | 无 |
| air_conditioner | 无 | 无 | 无 | 无 |
| unknown_xyz | 无 | 无 | 无 | 无 |
| null_store_phone | 无 | 无 | 无 | 无 |
| no_store | 无 | 无 | 无 | 无 |

**组件挂载了（`data-v-app` 在），但 `view` 始终为空 ⇒ 模板里的内容全部被 `v-if` 挡住。**

### 最可能的两个原因（未验证完）

1. **替身没真正替上**：`Progress.vue` 里写的是相对说明符 `'../../api/media'`，
   Vite alias 对相对路径的匹配时机不一定在解析前 ⇒ 可能仍加载了**真实**模块，
   于是 `fetchProgress` 去打了真实接口（token 是我编的 `TESTTOKEN`）→ 401 → `view=null`。
2. **`window.__DTO__` 被循环覆盖**：我在每次 `mount` 前设置全局，但异步 `fetchProgress` 读取时机在之后，
   5 个实例可能都读到最后一个值 —— 不过即便如此也应渲染出内容，所以 ① 更可能。

---

## 3. 因此的判定

| 项 | 状态 |
|---|---|
| Harness 可编译、可挂载 | ✅ |
| 真实 Progress.vue 渲染出中文标签 | ❌ **未取得** |
| 390px 视口布局检查 | ❌ 未取得 |
| 门店空值隔离测试 | ❌ 未取得 |
| 临时文件清理 | ✅ **已删除**，`Progress.vue` 无 harness 残留（`grep harness` = 0） |
| 生产 H5 | **未部署 harness**，`git status` 只有 `M h5/src/pages/Customer/Progress.vue`（即 A 组正式改动） |

**A 组维持 PARTIAL PASS**：
- 问题③ 电话 = PASS（真实工单 + 浏览器已验证）
- 问题④ 新工单入口 = PASS（真实 token + 浏览器已验证）
- 问题② 家电标签 = **代码级完成，UI 仍待验**
- 空值安全 = **代码级论证，运行期仍待验**

---

## 4. 下一轮怎么把它做成

两个更可靠的路子（择一，均本地、不碰生产）：

| 方案 | 做法 | 优点 |
|---|---|---|
| **A（推荐）** | 不用 alias，直接在 Harness 里**复制一份 Progress.vue 的渲染路径**：把它的 `<template>` 与 `computed` 抽成一个纯展示子组件（`ProgressView`），Harness 只挂这个子组件 | 不依赖模块替身，确定性高；但需要一次小幅重构（有回归成本） |
| B | alias 改成**精确文件路径**（`path.resolve(h5/src/api/media.ts)` 作为 `find`），并在替身里返回固定 DTO，同时把 `__DTO__` 改为按 case 传入参数 | 改动小，但需要验证 alias 对相对 specifier 是否生效 |

我倾向 B 先试（成本低），失败再走 A。

---

## 5. 未做的事（明确）

- 未使用任何真实客户 Token。
- 未向生产数据库插入测试工单、未改 32 条异常门店归属。
- 未把 Harness 部署到线上。
- 未 commit / 未 push。

P6：LIVE / CONDITIONAL；Release：HOLD。
