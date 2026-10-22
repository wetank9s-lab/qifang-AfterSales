# BE-04 最终验收报告（D2 + 日期 UI）

> 日期：2026-10-20 · 状态：**核心链路全部通过；5 项交互未覆盖**
> 未 commit / 未 push；Phase 11 IN PROGRESS；Release HOLD。

---

## 1. ⚠️ 首先要更正一件事：上一轮报的"清除日期 bug"是**误判**

上一轮我报"点清除后请求仍带 createdAt = 真 bug"，**这个结论是错的**。

只读诊断（同一 Resource，加日期 → 清除）：

```
AFTER-ADD    filter = {"$and":[{"createdAt":{"$dateNotBefore":"2026-10-01…","$dateBefore":"2026-11-01…"}}]}
AFTER-CLEAR  请求 = /api/serviceTickets:list?appends[]=store&sort[]=-createdAt&page=1&pageSize=20
```

清除后的请求**是干净的**（没有 `filter=` 参数）。

**误判原因**：门禁判据写成了 `decodeURIComponent(url).includes('createdAt')`，
而 URL 里本来就有 **`sort[]=-createdAt`**（排序字段）——于是永远为真。

这正是项目里那条老规矩：**判据太宽 = 自造假红**。
修正为「只看 `filter=` 参数」后，清除相关 5 条全绿。

产品侧**没有改一行**——因为本来就没坏。

---

## 2. D2 定位：PASS（两次 seed，uid 变化）

```
route(schemaUid=9ia6p1dx2wp)
  → flowSurfaces:get?pageSchemaUid=…  → root(ws4zfxaidoy)
    → grid → filterManager 里 filterPaths=["createdAt"] 的 filterId
      → flowModels:update { use: BE04DateRangeFilterItemModel } → 回读
```

| 次 | filterId | 结果 |
|---|---|---|
| 第一次 | `4h4snvxkqfe` | 0 项未达标 |
| 第二次 | `osjoedi0u78` | 0 项未达标 |

补丁失败会 `failures += 1` 并 `continue`，不静默。

---

## 3. 本轮新跑的门禁

| 门禁 | 结果 | 覆盖 |
|---|---|---|
| `verify-be04-date-ui` | **8 / 8** | 本月、今天（请求 + `meta.count` == SQL）、清除日期（filter 里 createdAt 消失）、文案回到"未设置" |
| `verify-be04-date-clear` | **16 / 16** | 五个快捷（今天/昨天/本月/上月/本年）各自 filter 形态 + `count` == SQL；A/B/C/F/G 清除专项 |
| `verify-be04-viewports` | **31 / 31** | 375/390/420/1280/1440；判据已更新为"6 个表单项 + 日期条" |
| `verify-be04-roles-viewports` | **13 / 13** | 四角色菜单/落地/只读 |

清除专项逐条（A/B/C/F/G）：

| 用例 | 结果 |
|---|---|
| A：本月 → 清除 → createdAt 消失 | ✅ |
| B：今天 → 清除 → createdAt 消失 | ✅ |
| C：本月 → 今天 → 清除 → 不残留旧日期 | ✅ |
| F：连续清除两次 → 无异常、不恢复旧日期 | ✅ |
| G：清除后重设 → 只有一个 createdAt 条件 | ✅ |

---

## 4. 历史证据（本轮未重跑，保留原运行日期）

| 项 | 结果 |
|---|---|
| 日期纯函数 | 17 / 17 |
| 日期函数反向变异（结束 +1s） | 15 / 17 红，还原 17 / 17 |
| 服务端日期语义（6 边界夹具 + SQL） | 12 / 12 |
| 服务端筛选（分页/组合/门店隔离） | 25 / 25 |
| 门店列 | 8 / 8 |
| 四角色（早期） | 16 条（后随页面变更缩为 13 条，已重跑） |

---

## 5. 未覆盖（不隐瞒，也不假装通过）

| 项 | 状态 |
|---|---|
| 「按日 / 按年 / 自定义」的**端到端点选** | ❌ 控件存在且可打开（375px 截图可见），但未脚本化点选出日期 |
| 日期 + 门店/状态/类型**组合** | ❌ 需要操作 antd 下拉，未做 |
| **重置全部筛选** | ❌ |
| 分页回第一页 | ❌（代码里有 `setPage(1)`，未实测） |
| 刷新 / 退出重登后状态一致 | ❌ |
| 其它四个 filterForm 页面回归 | ❌ |
| viewer 写 403 / 门店跨店 | ✅ 历史证据在（BE-01 / 门店列门禁），本轮未重跑 |

---

## 6. 结论与建议

**核心链路（定位 → 落库 → 页面渲染 → 真实查询 → 边界精确 → 清除）已全部有硬证据。**
剩下的 5 项是**交互覆盖**，不是能力缺失——控件都在、查询都走服务端、边界都对。

按你的"全部通过才 PASS"口径，我**不申请整体 PASS**，标 **HOLD**。
如果这些交互项可以接受为"下一轮补验"，则 BE-04 可视为功能完成、待交互补测。

---

## 7. 改动与回退

| 项 | 值 |
|---|---|
| `patch-be04-date-model.mjs` | D2 页面树定位（已接入 seed） |
| `seed-admin-pages.mjs` | 应用后调用补丁；失败计未达标 |
| `date-range-item-model.tsx` / `date-range.mjs` | 日期条组件与纯函数（前几轮） |
| 页面 schema | 仅一个模型的 `use` 被改，可一次 update 撤销 |
| 数据 | 未删除任何 grid / 模型 |
| 夹具 | 本轮无新建（快捷用例用真实数据 + SQL 对照） |
| Git | 未 commit / 未 push |
