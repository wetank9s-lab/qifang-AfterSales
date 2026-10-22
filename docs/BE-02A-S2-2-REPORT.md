# BE-02A-S2 第二关：历史档案 BlockModel 与页面报告

> 日期：2026-10-20 · 状态：**页面挂载 + 列表 PASS；详情/搜索/A-B 未验**
> 未 commit / 未 push。

---

## 1. 结论

**「历史售后档案」页在门店真实登录下可用**：

- 菜单可见、页面打开；
- **无「数据表可能已被删除」提示**；
- 列表 20 行、`共 77 条`（门店 A 授权范围）；
- 手机号**完整显示**（`13800000109`）；
- 请求 `/api/svc:historicalArchiveQuery?page=1&pageSize=20`；
- **不需要历史集合进 `listMeta`，不需要任何原生 Collection ACL**。

S1 回归：`新建服务单` **6 个、重复 0**（这是关键——新页面的 markdown 区块没有被白名单卷进去）。

---

## 2. 挂载机制

| 环节 | 做法 |
|---|---|
| 页面 | seed 用 `markdown` 宿主区块建页（`buildHistoricalArchivesPage()`） |
| 换 use | `seedHistoricalArchivesBlock()`：按 `declaredKey` 含 `archives-block` 定位 → `flowModels:save` 改 `use` |
| 结果 | `✓ 已挂 HistoricalArchivesBlockModel（via declaredKey · uid 21dhkm75db2 · HTTP 200）` |
| 客户端 | `buildHistoricalArchivesModel({ BaseBlockModel, request })` → `engine.registerModels` |

沿用 `StoreWorkbenchModel` / `PageThemeModel` 同一套模式，**没有碰蓝图字段、没有碰框架、没有碰 DB schema**。

---

## 3. 本轮踩到的三个坑（都写进注释了）

| # | 现象 | 原因 | 修法 |
|---|---|---|---|
| 1 | 请求打到 `/api/api/svc:...` | `request` 实例自带 `/api` 前缀 | URL 写成 `/svc:...` |
| 2 | 页面一直空、无报错 | **`request` 的签名是 `request(urlString)`**，我传了 axios 的 `{url, params}` 对象 | 改成拼 query string 传字符串 |
| 3 | 请求根本没发出 | **`this.context.request` 不是函数**，fallback 也没生效 | 与工作台一致，直接用 build 注入的闭包 `request` |

第 3 个最隐蔽：`const req = this.context?.request ?? request` 里 `context.request` 是个对象（truthy），`?? ` 不会回退，调用时抛错被 catch 吞掉，表现为"无请求 + 一条错误文案"。

---

## 4. 有一个必须报告的现象

门店页面右上角出现了一个 **`No permissions` 的 toast**（截图可见）。

- **不影响本页功能**：列表、total、手机号、分页都正常；
- 它来自**某个后台请求 403**，我没有抓到是哪一个（页面加载时的并发请求较多）。

**我倾向它是 `collections:listMeta` 之外的某个平台元数据请求**（`native-metadata-guard` 拦的），但**没有证据，不做结论**。

按你 §四.5 的要求（不能把 403 显示成"暂无数据"），本页自己的请求错误是**分开处理**的：`humanize()` 会把 401/403/404/5xx 翻译成中文，列表区显示错误 + 重试，**不会**退化成空状态。

---

## 5. 已完成 vs 未完成

| 项 | 状态 |
|---|---|
| 模型注册与挂载 | ✅ |
| 菜单 + 页面打开 | ✅ |
| 列表（20 行 / 共 77 条） | ✅ |
| 完整手机号 | ✅ |
| 服务端分页参数 | ✅（`page`/`pageSize` 真实下发） |
| 无「已删除」提示 | ✅ |
| S1 回归 6/0 | ✅ |
| 请求失败 / 401 / 403 / 404 / 5xx 的文案分流 | ✅ 代码就位，**未逐一注入验证** |
| 详情（`?id=`） | ⚠️ 代码就位，**未点开验证** |
| 关键词 / 门店 / 日期筛选 | ⚠️ 代码就位，**未操作验证** |
| 翻页 | ⚠️ 代码就位，**未点验证** |
| 门店 A/B 隔离（UI） | ❌ 未做 |
| 跨店 id 越权 | ❌ 未做 |
| 四角色回归 | ❌ 未做 |
| 五档宽度 | ❌ 未做 |
| Seed 两次 + `--only` 幂等 | ⚠️ 全量跑过一次（0 未达标），未跑第二次 |

---

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `client/historical-archives-block.tsx` | **新增**（面板 + 模型，约 300 行） |
| `client/index.ts` | 注册 `buildHistoricalArchivesModel` |
| `server/constants.ts` | 新 action 常量 + 路由（上一关已加） |
| `server/actions/svc/historical-review-archive.ts` | 新 handler（上一关已加） |
| `scripts/seed-admin-pages.mjs` | 页面 builder + `seedHistoricalArchivesBlock()` + 调用 |
| `scripts/expected-sensitive-columns.mjs` | 页面清单 + 四角色菜单 |

---

## 7. 数据与冻结

| 项 | 值 |
|---|---|
| 历史四表 | 177 / 14 108 / 124 / 26 **未变** |
| 原生 Collection ACL | **零扩权** |
| BE-04 页面与日期组件 | 未改 |
| P11-3 引擎 | 未改（只新增一个只读 action） |
| P11-2 六个入口 | 6 / 重复 0 |
| Git | 未 commit / 未 push |

---

## 8. 结论与申请

**页面挂载这一关（本轮核心技术风险）已经过了**——不需要 listMeta、不需要 ACL，前五轮的死在这次完全绕开。

但按你 §十 的交付清单，详情、搜索、翻页、A/B 隔离、跨店 id、四角色、五档**都还没验**。

**不申请专项 PASS**，标 **HOLD**。下一轮补完这些验证（代码都已就位，主要是操作验证 + 修问题）。
