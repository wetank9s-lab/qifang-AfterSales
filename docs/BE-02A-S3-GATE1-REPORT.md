# BE-02A-S3 第一关报告：向导正式挂载

> 日期：2026-10-21 · 状态：**入口与向导打开 PASS；"关闭返回"未通过**
> 未 commit / 未 push。

---

## 1. 结论

| 验收项 | 结果 |
|---|---|
| 菜单「历史数据导入」 | ✅ 有，且唯一 |
| 页面打开、无「可能已被删除」 | ✅ |
| 「上传历史 Excel」按钮 | ✅ **唯一 1 个** |
| 点击后**真实向导打开** | ✅ 弹窗出现，内容是 P11-3 的上传步骤 |
| **关闭后返回页面** | ❌ **未通过**（点了关不掉，再点变 2 个实例） |
| S1 六个「新建服务单」 | ✅ 6 个 / 重复 0 |

**第一关按你的规则不能判通过**——"关闭返回"和"不出现重复实例"都没达成。

---

## 2. 挂载方式（核心发现）

`HistoricalImportWizardModel` 是 **ActionModel**（`extends ActionModel`，`scene=collection`）。

**第一次尝试**：按 `TicketCreateActionModel` 的做法，把它作为 markdown 区块的 `actions` 子节点写入 → `flowModels:save` 返回 **200**，但**页面上什么都不渲染**（按钮数 0）。

**原因**：**markdown 区块没有 actions 容器**。ActionModel 写进库里也不会画出来。

**改成**：与 S2 同法——把宿主 markdown 的 `use` 换成新的 `HistoricalImportEntryBlockModel`，它渲染一个按钮，点击复用**同一个 `Wizard`**（没有重写引擎）。

---

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `client/historical-import-wizard.tsx` | deps 加 `BaseBlockModel`；新增 `EntryPanel` + `HistoricalImportEntryBlockModel`，**复用原 `Wizard`** |
| `client/index.ts` | 把 `BaseBlockModel` 取值**提前**到 `models` 之前（原来在之后 ⇒ 传进去是 `undefined`）；拆成 `HistoricalImportWizardModel`（进 actions）与 `HistoricalImportEntryBlockModel`（进 blocks）两个注册键 |
| `scripts/seed-admin-pages.mjs` | 新增页面 `buildHistoricalImportPage()` + `seedHistoricalImportEntry()`（替换 use，清理第一版误写的 ActionModel 节点）；`--only` 也补跑 |
| `scripts/expected-sensitive-columns.mjs` | 页面清单 + 四角色菜单 |

**没有改** P11-3 的解析/映射/去重/归档算法。

---

## 4. 踩到的三个坑（都写进注释）

| # | 现象 | 根因 |
|---|---|---|
| 1 | ActionModel 写入 200 但页面无按钮 | **markdown 没有 actions 容器** |
| 2 | `flowModels:save` 返回 **500** | uid 用了带 `.`/`-` 的长串；必须用短标识（改用 FNV 派生 `himp…`） |
| 3 | 模型注册了但页面没按钮 | **`BaseBlockModel` 在 `models` 之后才定义** ⇒ 传进 build 的是 `undefined` ⇒ `extends undefined` 静默失败 |

---

## 5. 当前阻塞：关闭按钮无效

| 判据 | 结果 |
|---|---|
| 点「关闭」前 | `modalVisible = 1` |
| 点「关闭」后（sleep 1200ms） | **`modalVisible = 1`（没关）** |
| 再点「上传历史 Excel」 | **`modalVisible = 2`（叠了第二个）** |

**试过三种点击**：`.click()`、`mousedown+mouseup+click`、全局找文本按钮——都不生效。

**代码上看是对的**：
- `Wizard` 里 `React.createElement(Button, { onClick: onClose }, '关闭')`（wizard:945）
- `onClose` = `() => modal.close()`（wizard:1002）
- `openClosableModal` 的 `close` = `destroy()` → `instance?.destroy?.()`（modal-kit）

**我没定位到为什么没关**。三种可能，我都没证据排掉：

1. 我点到的不是那个按钮（页面里可能有多个"关闭"文本）；
2. `Modal.confirm` 的 `destroy()` 之后 DOM 残留（但 `getBoundingClientRect` 仍有尺寸，不像）；
3. `EntryPanel` 里 `onClose: () => modal.close()` 的闭包在某个时序下拿到 `undefined`。

---

## 6. 数据与冻结

| 项 | 值 |
|---|---|
| 历史四表 | 177 / 14 108 / 124 / 26 **未变** |
| 原生 ACL / listMeta / P11-3 算法 | 未改 |
| SEC-HIST-01 / HQ-HIST-01 | 保留 |
| 新增工单 / 派工 / SMS | 无 |
| Git | 未 commit / 未 push |

---

## 7. 结论

**入口挂载做成了，向导能打开、内容是 P11-3 原样的上传步骤。**

但**关闭返回这一条没过**，按你 §十一「第一关若失败，先停在挂载问题，不扩展开发」，我停在这里，**不进入第二关（真实 Excel 归档）**。

**需要你定**：
- 要么人工点一次「关闭」看是否真的关不掉（10 秒就能确认是产品还是我的脚本）；
- 要么我下一轮在 `EntryPanel` 里给关闭加一个显式的 `data-testid` 并打印点击前后的 `modal` 对象，把这条定死。
