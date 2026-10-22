# BE-02A 实施报告：Excel 导入与历史档案（HOLD）

> 日期：2026-10-20 · 状态：**HOLD —— 未交付可用功能，已完整回退**
> 未 commit / 未 push；Phase 11 IN PROGRESS；Release HOLD。

---

## 1. 结论先说

**本轮没有交付门店可用的 Excel 导入/历史档案功能。** 原因不是没做，而是做到一半发现了**会破坏已冻结功能**的副作用，我选择回退而不是留下带缺陷的东西。

---

## 2. 已核实的现状（P11-3 引擎是完整的）

六张表都在，**且有真实数据**：

| 表 | 行数 |
|---|---|
| `historical_import_batches` | **177** |
| `historical_import_rows` | **14 108** |
| `historical_import_candidates` | 4 215 |
| `historical_import_reviews` | 209 |
| `historical_service_archives` | **124** |
| `historical_ticket_conversions` | 26 |

服务端 API 齐全：`svc:historicalUpload / historicalPreview / historicalStage / historicalDuplicates / historicalReviewRow / historicalReviewSummary / historicalConfirmAttribution / historicalArchive / historicalBatches`。

客户端**已有完整向导**：`client/historical-import-wizard.tsx`（"历史 Excel 导入"，含上传/映射/预览/确认），并已注册为 `HistoricalImportWizardModel`（区块级 ActionModel）。

### 关键发现

**这套东西没有任何页面挂载它。** seed 的 11 个页面里没有一个用到 `historicalImportBatches` / `historicalServiceArchives`，`HistoricalImportWizardModel` 也没有出现在任何页面的 action 里。

所以现状是：**引擎在跑、数据在库、向导在代码里，但门店后台看不到任何入口。**

---

## 3. 我尝试了什么（以及为什么回退）

### 3.1 尝试：新增「历史售后档案」页

改了四处：

1. `seed-admin-pages.mjs`：新增 `ARCHIVE_LIST_FIELDS` + `buildHistoricalArchives()`（table on `historicalServiceArchives`），注册进 `PAGE_BUILDERS`；
2. `FIELD_GROUPS`：给三张历史表补 `fieldGroups`（它们有 20+ 生成弹窗字段，蓝图强制要求覆盖全部字段）；
3. `DEFAULTS.collections`：加三行 `{ fieldGroups: buildFieldGroups(...) }`；
4. `expected-sensitive-columns.mjs`：清单 + 四个角色的菜单。

**结果：页面本身应用成功**（`--only 历史售后档案 → 0 项未达标`），门店账号菜单也能看到（实测 MENUS 里有）。

### 3.2 但全量 seed 出现了新失败

```
=== 「新建服务单」入口挂载（P11-2：TicketCreateActionModel）===
  · 新建 6 / 修正 0
  ✗ 回读 6 张门店侧表：节点 12 个（重复 6 个）
```

**新增的 table 页面被 `TicketCreateActionModel` 的挂载逻辑算了进去**，导致每张表挂了 2 个"新建服务单"。

这是**破坏已冻结功能**的副作用（P11-2 的入口会重复），不是我加的历史页本身有问题。

### 3.3 回退

- 代码：四处改动全部撤销（`node --check` 通过，`grep 历史售后档案` = 0）；
- DB：用正式接口 `desktopRoutes:destroy` 删除该页的两条路由（flowPage + tabs），和之前处理「全量工单」遗留的做法一致；
- 重跑全量 seed：**`0 未达标`，全部页面已应用并回查通过**。

环境已回到 BE-04 FROZEN 之后的状态，没有留下半成品。

---

## 4. 真正的阻塞点（下一轮要先解决）

新增任何 table 页面都会触发 `TicketCreateActionModel` 的"6 张门店侧表"遍历，而**这个遍历是按页面/表格数量算的，不是按 collection 白名单**。

要安全加页面，必须先做**二选一**：

| 方案 | 做法 | 影响面 |
|---|---|---|
| **S1** | 把 `TicketCreateActionModel` 的挂载范围收窄为**显式 collection 白名单**（`serviceTickets`），不再按"所有门店侧表"遍历 | 改 seed 的挂载逻辑，需要回归 7 张表的主动作 |
| **S2** | 新增的历史页**不建 table 区块**，改用自定义 BlockModel（像工作台/装修页那样），避开 `TicketCreateActionModel` 的遍历 | 页面要自己实现列表，工作量大 |

**建议 S1**：它修的是"挂载逻辑依赖隐式数量"这个根因，顺带让后续加页面不再踩同一个坑。

---

## 5. 其余未完成项

- 「历史数据导入」页（挂 `HistoricalImportWizardModel`）——依赖同样的前置修复；
- 字段映射/预览/确认归档的端到端（wizard 已实现，但没挂到页面，无法验证）；
- 四角色 × 历史档案权限矩阵；
- 导入批次 / 部分失败 / 重复导入 / 门店 A/B 隔离；
- 无副作用证据（不建工单、不发短信、不派工）。

以上都需要页面先能挂上去。

---

## 6. 本轮改动与状态

| 项 | 值 |
|---|---|
| 产品代码 | **零改动**（改动已全部回退） |
| seed 脚本 | 已还原，全量重跑 `0 未达标` |
| DB | 删除了我新建的两条路由（`desktopRoutes:destroy`）；历史六张表**未动一行** |
| 夹具 | 无 |
| Git | 未 commit / 未 push |

---

## 7. 建议的下一步

1. **先做 S1**（收窄 `TicketCreateActionModel` 挂载范围），单独立项、单独回归；
2. 再做「历史售后档案」页 + 「历史数据导入」页；
3. 最后做端到端与四角色门禁。

在此之前 BE-02A 保持 **HOLD**——我不想用"页面能打开但没有导入功能"的东西去冒充交付。
