# UX-01B-R4.1：门店电话降权报告

> 日期：2026-10-21 · 状态：**三档复验 PASS**
> 只改 `.svc-store-call` 一段样式；未 commit / push。

---

## 1. CSS diff

```diff
 .svc-store-call {
   flex: 0 0 auto;
   display: inline-flex;
   align-items: center;
   justify-content: center;
   gap: 5px;
-  min-height: 40px;
-  padding: 6px 9px;
-  border-radius: 10px;
-  border: 1px solid #dce8ff;
-  background: #edf4ff;
-  color: #2768e8;
+  min-height: 44px;              /* 触控高度保住，靠透明 padding 撑 */
+  padding: 6px 0 6px 6px;
+  border: 0;
+  border-radius: 6px;
+  background: transparent;
+  box-shadow: none;
+  color: #647da3;
   text-decoration: none;
   font-size: 13px;
-  font-weight: 600;
+  font-weight: 500;
   line-height: 1.25;
   font-variant-numeric: tabular-nums;
   white-space: nowrap;
 }
+/* 电话图标只覆盖自己这一处（地址图标仍是 17px） */
+.svc-store-call .svc-store-icon {
+  width: 15px;
+  height: 15px;
+  flex: 0 0 15px;
+}

 .svc-store-call:focus-visible {
-  outline: 2px solid #2768e8;
+  outline: 2px solid #647da3;
   outline-offset: 2px;
 }
```

**保留**：`display: inline-flex` / `align-items: center` / `justify-content: center` / `gap` / `white-space: nowrap` / `tel:` / `data-testid="store-phone"`。

---

## 2. 三档复验（Chromium，DPR=2，真实门店地址）

| 项 | 375×667 | 390×844 | 420 |
|---|---|---|---|
| 卡片高 | **94**（原 90） | 94 | 94 |
| 店名/电话同行 | **true** | true | true |
| 名称与电话重叠 | 无 | 无 | 无 |
| **电话点击区高** | **44** | 44 | 44 |
| 电话 href | `tel:028-83992299` | 同 | 同 |
| 地址完整（无省略） | ✓ | ✓ | ✓ |
| 「展开完整地址」 | 不存在 | 不存在 | 不存在 |
| 媒体图标 / 高度 | 24×4 / **74×4** | 同 | 同 |
| 横向溢出 | 无 | 无 | 无 |
| Emoji 残留 | 无 | 无 | 无 |

**卡片高 90 → 94（+4）**：`min-height` 40→44 的直接结果，属预期；没有额外内边距膨胀。

---

## 3. 视觉权重对照（375 实测像素）

| 元素 | 颜色 | 字号/字重 | 背景 |
|---|---|---|---|
| **店名**「新都圣大家电」 | `--svc-text`（近黑） | **17px / 700** | 无 |
| **我要报修**（主入口） | `#2768e8` | 主按钮 | **实心浅蓝 + 蓝边** |
| 门店电话 | **`#647da3`** | **13px / 500** | **透明**（无边框无阴影） |
| 地址 | `--svc-text-weak` | 13px / 400 | 无 |

层次：**店名 > 我要报修 > 电话 ≈ 地址**。电话不再抢主入口的注意力。

---

## 4. 未改动项（按你的清单）

店名 / 地址 / 门店卡整体结构、地址完整显示规则、报修投诉切换栏、联系人 / 手机号 / 故障描述、媒体四入口及其 SVG、固定提交按钮、隐私告知、服务端与建单业务 —— **全部未动**。

未引入图标库，未回退 Emoji。

---

## 5. 构建

```
dist/assets/index-Dnx0DSvR.css   26.57 kB
dist/assets/index-Bcx4lPjH.js   160.57 kB
✓ built in 778ms
```

---

## 6. 结论

**电话降权完成，三档复验通过**，主入口「我要报修」重新成为视觉焦点。

建单与录制仍为 **PENDING**（本轮的改动不涉及它们）。

BE-02A 保持 PASS / FROZEN；BE-02B 未授权；Release HOLD。
