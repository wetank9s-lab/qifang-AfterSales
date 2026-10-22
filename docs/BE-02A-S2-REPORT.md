# BE-02A-S2 最小页面与受控读取验证报告（第一关）

> 日期：2026-10-20 · 状态：**第一关 PASS（只读接口已通并验证隔离）；第二关页面挂载未完成**
> 未 commit / 未 push。

---

## 1. 九个 svc:historical* 接口审计结论

| 接口 | 用途 | 分页 | 真实 total | 多字段筛选 | 详情 | 手机号 |
|---|---|---|---|---|---|---|
| `historicalUpload` | 上传 | — | — | — | — | — |
| `historicalPreview` | 预览 | — | — | — | — | 脱敏 |
| `historicalStage` | 暂存 | — | — | — | — | — |
| `historicalBatches` | 批次列表 | ❌ 只有 limit | ❌ | ❌ | 取某批行 | 脱敏 |
| `historicalDuplicates` | 去重预览 | — | — | — | — | — |
| `historicalReviewSummary` | 异常汇总 | — | — | — | — | — |
| `historicalReviewRow` | 单行 | — | — | — | 按 id | 脱敏 |
| `historicalConfirmAttribution` | 归属确认 | — | — | — | — | — |
| `historicalArchive` | 归档 | — | — | — | — | — |
| **`historicalArchives`** | **档案列表** | ❌ 只有 `limit`（≤200） | ❌ **total = 返回行数** | ❌ 只有 `storeCode` | ❌ | 脱敏 |
| `historicalConvertToTicket` | 转工单（BE-02B） | — | — | — | — | — |

**差距明确**：现有读取接口**没有 offset 分页、没有真实 total、没有关键词/日期筛选、没有详情、手机号一律脱敏**。

按你 §三 的授权（"仅允许在 BE-02A 项目业务层提出最小受控读取接口，不得修改 P11-3 已冻结的算法"），我**新增**了一个只读接口，**没有改动** `historicalArchives`。

---

## 2. 新增接口：`svc:historicalArchiveQuery`（只读）

```
GET /api/svc:historicalArchiveQuery?page=1&pageSize=20
    &keyword=（姓名/手机号/档案号）
    &storeCode=S01
    &dateFrom=2026-01-01&dateTo=2026-12-31

GET /api/svc:historicalArchiveQuery?id=124      → 详情
```

关键设计：

| 项 | 实现 |
|---|---|
| **门店隔离** | 与 `historicalArchives` **同源**：`store.listBatchesForActor(uploader, 500)` → `filter.batch_id = { $in: visibleIds }` |
| 非总部且无可见批次 | **直接返回空集**，不查库（fail-closed） |
| 真实 total | `findAndCount`（返回 `[rows, count]`） |
| 分页 | `limit` + `offset`，`pageSize` 上限 100 |
| 排序 | `-archived_at, -id`（稳定） |
| 手机号 | **完整值**（`customerMobile`），按你 §五 的后台政策 |
| 详情 | `?id=` 时另返回 `storeId/customerAddress/archiveNote/sourceRow/batchId` 等 |
| 副作用 | **无**——纯读，不写库、不建工单、不发短信 |

改动文件：
- `server/constants.ts`：加 `HISTORICAL_ARCHIVE_QUERY` 常量 + 路由表
- `server/actions/svc/historical-review-archive.ts`：加 handler（约 100 行，含注释）

---

## 3. 实测（第一关核心证据）

同一时刻、同一接口、不同角色：

| 角色 | HTTP | total | 首条 |
|---|---|---|---|
| **store_after_sales（门店 A）** | 200 | **77** | `HA-20261013-04BU6B / S01 / 合成丁DMV6CL3QG / 13800000109` |
| **hq_admin** | 200 | **124** | 同上 |
| **viewer** | 200 | **0** | `null` |

- 门店 A 看到的是**自己批次产生的 77 条**，不是全量 124；
- 总部看到全量 124；
- viewer 无门店绑定 → `listBatchesForActor` 为空 → **0 条**（符合现有 fail-closed 契约，不是越权）；
- 手机号返回完整值 `13800000109`。

---

## 4. 第二关：页面挂载（未完成）

**方案已定，未实施**：沿用本项目**已验证过两次**的模式——
「用 `markdown` 宿主区块建页面 → 再把这个区块节点的 `use` 换成自定义 BlockModel」
（`售后服务工作台` 的 `StoreWorkbenchModel`、`客户页面装修` 的 `PageThemeModel` 都是这么挂的）。

这样：
- 不碰蓝图对 `table/filterForm/markdown` 的类型限制；
- 不需要历史 Collection 进 `listMeta`（**绕开 V1 定位的那层白名单**）；
- 不需要任何原生 Collection ACL。

**为什么本轮没做**：把「接口 + 模型 + 页面 + 四角色验证」全塞进这一轮，我判断做不完，宁可先把第一关的证据交上来。

---

## 5. 剩余工作（下一轮）

| # | 事项 | 依赖 |
|---|---|---|
| 1 | `HistoricalArchivesBlockModel`（列表 + 搜索 + 分页 + 详情弹窗） | 无（接口已就绪） |
| 2 | seed 加「历史售后档案」页（markdown block 换 use） | 1 |
| 3 | 门店 A/B 隔离的 UI 验证 + 四角色 | 2 |
| 4 | Excel 向导复用（`HistoricalImportWizardModel` 挂到导入口） | 2 |
| 5 | S1 回归（新建服务单仍 6/0）+ Seed 幂等 | 2 |
| 6 | 异常/幂等/部分失败门禁 | 4 |

---

## 6. 本轮改动与状态

| 项 | 值 |
|---|---|
| 服务端 | **新增 1 个只读 action**（未改 P11-3 任何算法） |
| 数据库 | 零修改（177 / 14 108 / 124 / 26 未变） |
| ACL | 零修改 |
| 历史页面 | 未建（第二关未做） |
| 原生 Collection 权限 | **未扩权**（这是 S2 的核心价值：完全不依赖它） |
| Git | 未 commit / 未 push |

---

## 7. 结论

**第一关 PASS**：有了一个**只读、分页、可筛选、真实 total、带门店隔离**的接口，且不依赖任何原生 Collection ACL。

**第二关（页面挂载）未开始**，但路径清楚、有两次成功先例，风险低。

BE-02A 继续 HOLD。
