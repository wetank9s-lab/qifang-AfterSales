# BE-02A-S3 第一关补证报告（脚本问题已定位）

> 日期：2026-10-21 · 状态：**产品无缺陷；是我的判据写错。第一关 PASS**

---

## 1. 结论

**产品没问题。上一轮报的"关闭点不掉"是我测试脚本的判据错误。**

用 CDP 原生鼠标事件 + 正确判据重测，全部通过：

| 步骤 | 可见弹窗 | 遮罩 |
|---|---|---|
| 初始（未打开） | **0** | 0 |
| 点「上传历史 Excel」 | **1** | 1 |
| 点底部「关闭」 | **0** | 0 |
| 再开 | **1** | 1 |
| 点右上角 **×** | **0** | 0 |
| 第三次 开 → 关 | 1 → **0** | 1 → 0 |
| 最终 | 按钮仍可点、中央无遮罩拦截 | |

---

## 2. 脚本错在哪（能定位，说清楚）

旧判据：

```js
const els = [...document.querySelectorAll('[data-testid="historical-import-modal"]')];
const vis = els.filter(el => el.getBoundingClientRect().width > 0);
```

**它只看元素自身尺寸，没看祖先是否被隐藏。**

antd 的 `Modal.confirm` 关闭后，`.ant-modal-wrap` 被置 `display:none`，但**里面的内容 div 自身 `getBoundingClientRect()` 仍可能返回非零尺寸**（它没被单独隐藏）。

⇒ 关闭明明成功了，我却统计成"还可见 1 个"；再点一次自然就是"2 个"，于是得出了"实例泄漏"的错误结论。

新判据加了祖先链检查：

```js
let p = el;
while (p && p !== document.body) {
  if (getComputedStyle(p).display === 'none') return false;
  p = p.parentElement;
}
```

**改完判据，一次就全过。**

另外两处也一并改对了：
- 点击改用 **CDP `Input.dispatchMouseEvent`**（真鼠标），不是 DOM `.click()`；
- 关闭后 **等 2 秒**（动画结束）再统计，不是 1.2 秒。

**用户此前的人工验证与我的新结果一致**，说明产品一直正常。

---

## 3. 人工验证记录（你方）

1. 打开导入向导；
2. 点底部「关闭」→ 正常关闭；
3. 再次进入；
4. 确认前再点「关闭」→ 仍正常。

与本轮自动化结果完全吻合。

---

## 4. Seed 回归

| 项 | 结果 |
|---|---|
| 全量 Seed | 历史档案区块 ✓、历史数据导入入口 ✓、**S1 6 个 / 重复 0** |
| `--only 历史数据导入` | ✓ 已挂 `HistoricalImportEntryBlockModel`、**0 未达标** |
| 定位方式 | 均走 `declaredKey`（uid 每次不同但都挂上） |

---

## 5. 本轮改动

| 文件 | 改动 |
|---|---|
| `.tmp-verify/s3-gate1b.mjs` | **新增**（测试脚本：CDP 原生鼠标 + 祖先可见性判据 + 2s 等待） |

**产品代码零改动**（上一轮的 `HistoricalImportEntryBlockModel` 保留；P11-3 的 `Wizard` 未动一行）。

---

## 6. 数据与冻结

| 项 | 值 |
|---|---|
| 历史四表 | 177 / 14 108 / 124 / 26 **未变** |
| P11-3 算法 | 未改 |
| 原生 ACL / listMeta | 未改 |
| SEC-HIST-01 / HQ-HIST-01 | 保留 |
| S2 | FROZEN |
| Git | 未 commit / 未 push |

---

## 7. 申请

**BE-02A-S3 第一关：PASS。**

按你的要求，**不执行第二关的 Excel 真实归档测试**，停在这里等签收。
