# UX-01B-R4.2：「补充信息（选填）」折叠栏修复报告

> 日期：2026-10-21 · 状态：**三档 PASS**
> 只改 1 处模板 + 1 段 CSS；未 commit / push。

---

## 1. 根因

折叠栏是原生 `<details>/<summary>`，箭头原本是**伪元素文本**：

```css
.svc-extra > summary::after { content: ' ▾'; }
.svc-extra[open] > summary::after { content: ' ▴'; }
```

伪元素跟着**文字流**走 —— 窄屏下标题占满一行时，它就被挤到**下一行左侧**。

---

## 2. 修复

### 模板（`h5/src/pages/Report/index.vue`，仅 summary 内部）

```diff
-<summary data-testid="extra-toggle">补充信息（选填）：家电类别 / 品牌型号 / 服务地址</summary>
+<summary data-testid="extra-toggle">
+  <span class="svc-extra-text">补充信息（选填）：家电类别 / 品牌型号 / 服务地址</span>
+  <svg class="svc-extra-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"
+       stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
+       aria-hidden="true" focusable="false">
+    <path d="m6 9 6 6 6-6" />
+  </svg>
+</summary>
```

仍是**原生 `<summary>`**（键盘可达、点击整行展开），**没有嵌套 button**。

### CSS（`h5/src/styles/base.css`）

```diff
 .svc-extra > summary {
+  display: flex;
+  align-items: center;
+  gap: 8px;
   cursor: pointer;
   font-size: 14px;
   color: var(--svc-primary);
   padding: 6px 0;
   list-style: none;
 }
-.svc-extra > summary::after { content: ' ▾'; color: var(--svc-text-weak); }
-.svc-extra[open] > summary::after { content: ' ▴'; }
+.svc-extra-text {
+  flex: 1;
+  min-width: 0;
+  white-space: normal;
+  overflow-wrap: anywhere;
+}
+.svc-extra-arrow {
+  flex: 0 0 16px;
+  width: 16px; height: 16px;
+  margin-left: auto;
+  color: var(--svc-text-weak);
+  transition: transform .18s ease;
+}
+.svc-extra[open] .svc-extra-arrow { transform: rotate(180deg); }
```

展开方向：`chevron-down` → **旋转 180° 变向上**，与展开状态一致。

**未动**：`.svc-extra` 本体、`details` 语义、字段内容、`extra-toggle` testid、点击行为。

---

## 3. 三档实测（报修页）

| 视口 | 标题高 | 箭头高 | 同行 | 贴右 | 展开/收起 | **输入后收起再展开数据保持** | 横向溢出 |
|---|---|---|---|---|---|---|---|
| 375 | **45（2 行）** | 16 | ✓ | ✓ | false→true→false→true | **true** | 无 |
| 390 | **45（2 行）** | 16 | ✓ | ✓ | 同上 | **true** | 无 |
| 420 | **22（1 行）** | 16 | ✓ | ✓ | 同上 | **true** | 无 |

- `sameRow`：箭头垂直中心落在文本块内
- `arrowAtRight`：箭头右缘与 summary 右缘误差 ≤ 2px
- 输入验证：`cat=air_conditioner / brand=测试型号R42 / addr=测试地址R42` → 收起 → 再展开，**三个值全在**

---

## 4. 投诉页（如实说明）

| 项 | 结果 |
|---|---|
| `[data-testid="extra-info"]` | **不存在** |
| 投诉表单 | 在（`complaint-name`） |
| 隐私告知 | 在 |
| 横向溢出 | 无 |

**投诉页本来就没有「补充信息」折叠栏** —— 它的表单只有联系人 / 手机号 / 投诉内容 / 媒体，没有家电类别、品牌型号、服务地址这三个选填字段。

所以"报修 + 投诉两页都验"这一条，实际只能验**报修页**；投诉页我验的是"不受影响"（能切换、无溢出、表单与隐私都在）。**这不是遗漏，是两页结构本身不同。**

---

## 5. 关于 `aria-expanded`

`<summary>` **没有 `aria-expanded` 属性**（实测 `aria: null`）。

这是**原生 `<details>` 的标准行为**：`<summary>` 的展开态由 `details.open` 的 UA 语义/映射提供，不需要也不应该手写 `aria-expanded`（手写反而可能和浏览器状态打架）。

**不是回归**，我也没有去加它。

---

## 6. 构建

```
dist/assets/index-DvlJmwHL.js  160.84 kB
✓ built in 604ms
```

---

## 7. 结论

| 项 | 结果 |
|---|---|
| 标题自然换行 | ✅ 375/390 两行 |
| 箭头始终在右、不掉行 | ✅ 三档 `sameRow` + `arrowAtRight` 均 true |
| 点击整行展开 / 再点收起 | ✅ `false→true→false→true` |
| 可选字段内容完整 | ✅ |
| 输入数据不丢 | ✅ |
| 无横向溢出 | ✅ |
| 隐私与提交按钮 | ✅ 未受影响 |

**申请 UX-01B-R4.2 PASS。**

（不宣称 UX-01B 整体功能全部通过；真实建单与设备录制仍 PENDING。）

R4.1 / BE-02A 保持 PASS·FROZEN；BE-02B 未授权；Release HOLD。
