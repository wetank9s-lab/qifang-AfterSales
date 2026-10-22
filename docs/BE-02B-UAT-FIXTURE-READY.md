# BE-02B 隔离 UAT 合成档案就绪报告

> 日期：2026-10-21 · **申请 READY FOR WRITE AUTHORIZATION**
> 未执行转单、未写原库、未 commit / push。

---

## 1. 隔离资源证据

| 项 | 值 |
|---|---|
| 容器 | `svc-app-uat`（**13001**），原 `svc-app`（13000）不受影响 |
| 数据库 | `service_ticket_verify`（独立库，129 表） |
| 存储 | `./storage-uat` → 容器内 `/app/nocobase/storage` |
| 插件 | `@local/service-ticket`，`enabled=t, installed=t` |
| 业务 action | `publicStore:entry` → **200**；`svc:historicalArchiveQuery` → 401（需登录） |

---

## 2. seed 脚本改动（`scripts/seed-admin-pages.mjs`）

### 2.1 `--base`（新增，默认行为不变）

```diff
-const BASE = `${SVC_SCHEME}://localhost:${PORT}`;
+const BASE_ARG = /* 解析 --base */;
+const BASE = (() => {
+  if (!BASE_ARG) return `${SVC_SCHEME}://localhost:${PORT}`;   // 默认行为**完全不变**
+  // 安全闸门：只允许本机/回环；端口 80/443/8080/8443（原实例 nginx）一律拒绝
+})();
+if (BASE_ARG) console.log(`[seed] 目标实例：${BASE}（--base 显式指定，非默认 nginx 入口）`);
```

实测拒绝：

```
node scripts/seed-admin-pages.mjs --base=http://127.0.0.1:8080
✗ --base 端口 8080 是原业务实例的 nginx 入口 —— 拒绝。隔离实例请用专用端口（如 13001）。
```

### 2.2 `envValue` 优先级修复

```diff
 const envValue = (k, d) => {
+  // 显式环境变量 > .env 文件 > 默认值
+  const fromProc = process.env[k];
+  if (fromProc) return String(fromProc).trim();
   const m = new RegExp(…).exec(envFile);
 };
```

**为什么必须改**：原来只读 `.env`，我传 `SMOKE_ADMIN_PASSWORD=admin123` 被**静默忽略** → 登录 401，看起来像"口令错了"。

---

## 3. `--only` 种子结果

```
[seed] 目标实例：http://127.0.0.1:13001（--base 显式指定，非默认 nginx 入口）
✓ 管理员登录成功（admin@nocobase.com）
· 现有路由 0 条，其中页面 0 个
=== --only 历史售后档案：跳过全量预清理（不触碰其它页面）===
✓ 历史售后档案 应用成功
  · 历史售后档案区块：✓ 已挂 HistoricalArchivesBlockModel（via declaredKey · uid 0ct74097az1 · HTTP 200）
=== 汇总（--only）：0 项未达标 ===
```

**只 seed 了这一页**，没动其它页面、没扩权限。

---

## 4. 合成账号与门店授权

| 项 | 值 |
|---|---|
| 账号 | `uat.store.a@svc.local`（uid **2**） |
| 角色 | `store_after_sales` |
| 门店 | store_id **1**（S01） |
| 密码 | `Verify-Uat-Only-2026!`（**只在隔离库**，未复制主库任何口令） |

**踩坑记录**：用 `storeUsers:create` 传 `{userId, storeId}`（camelCase）时，API 返回 200 但**列是空的**（表列是 `user_id`/`store_id`）。必须用 snake_case。已修正为 `user_id=2, store_id=1`。

---

## 5. 合成档案

| 项 | 值 |
|---|---|
| 夹具 | `合成演练夹具-clean-DMVHXLMH6.xlsx`，sha256 `766400f926e0b22c…` |
| 服务端登记 | ✅ `historicalDrillFixture` 签发（不是手写 `data_origin`） |
| batchId | **1**（`HI-20261021-6IDYAQ`） |
| `data_origin` | **`synthetic`**（由批次写入，服务端认定） |
| 归属 | `S01` / `scope='drill'` |
| 归档 | `created:3, archiveIds:[4,5,6], ticketsCreated:0, slaAffected:false` |

| archiveId | 单号 | mobile | stage | conversion_state |
|---|---|---|---|---|
| 4 | HA-20261021-EIIJYO | **13800000201** | archived | **none** |
| 5 | HA-20261021-JNW4Q4 | **13800000202** | archived | **none** |
| 6 | HA-20261021-06SSXB | **13800000201** | archived | **none** |

另有 1/2/3 三条 **mobile 为空**的档案 —— 正好用作"无手机号 → 禁用按钮"的对照分支。

**踩坑记录（两处）**：
1. **`scope` 不是 `attributionScope`**：确认归属的请求体参数名是 `scope`（`historical-review-archive.ts:512`），传错就落入默认 `production` → `409 STORE_IDENTITY_DRILL_ONLY`。
2. **字段名是 `customerPhone`（单数）**，不是 `customerPhones`。传错的话 mobile 全空，档案看起来"归档成功"但**根本不能转单**——这个是最阴的，因为归档接口返回 200。

---

## 6. S01 真实浏览器验证

| 项 | 结果 |
|---|---|
| 登录 | ✅ `http://127.0.0.1:13001/admin/glronwbq7z3` |
| 历史档案列表 | ✅ **6 行**，不含真实客户数据 |
| 详情抽屉 | ✅ 单号/门店/姓名/手机号/设备/服务时间/来源文件+工作表+行号/归档人/批次 |
| 转单状态 | ✅ `转单状态：none` |
| **「转为服务单」按钮** | ✅ 出现（`branch:'open'`） |
| 确认弹窗 | ✅ 8 项字段齐全 |
| **手机号脱敏** | ✅ `****0201`，`leak:false`（无 11 位明文） |
| **取消 → 零请求** | ✅ `blocked: 0` |

截图：`.tmp-verify/be02b-uat.png`

**踩坑记录（第三处）**：S01 账号一开始显示"暂无历史档案"——因为 `store_users` 绑定是空的（见 §4）。修正后 6 行立刻出现。

---

## 7. 原库基线（只读复核）

| 表 | 值 |
|---|---|
| service_tickets | **489** |
| historical_service_archives | **124** |
| historical_ticket_conversions | **26** |

**全程未变。**

---

## 8. 本轮未做

| 项 | 状态 |
|---|---|
| 调用 `historicalConvertToTicket` | **未执行** |
| 创建正式工单 | **未执行**（隔离库 `service_tickets=0`） |
| 修改 26 条既有转换记录 | **未执行** |
| 修改档案转换状态 | **未执行**（4/5/6 仍 `none`） |
| 主库 dump 到测试库 | **未执行** |
| H5 路径别名 / CDP Host 重写 | **未做**（本轮不需要，走后台流程） |

---

## 9. Git 状态

| 文件 | 改动 |
|---|---|
| `scripts/seed-admin-pages.mjs` | `--base` 参数 + `envValue` 优先级（**环境工具，非业务代码**） |
| `docs/BE-02B-UAT-FIXTURE-READY.md` | 本报告（新增） |

**未 commit / push。**

---

## 10. 清理方案（销毁清单）

测试完后按此顺序销毁（**执行前先验证资源独占**）：

1. 导出证据（截图 + 查询响应，不含真实客户信息）
2. `docker rm -f svc-app-uat`
3. `drop database service_ticket_verify`
4. 删 `./storage-uat`
5. **不触碰** `service_ticket` 库、`./storage`、`svc-app`

**独占性验证**：库名以 `_verify` 结尾、容器名 `svc-app-uat`、目录 `storage-uat` —— 三者都只在本次创建。

---

## 11. 剩余风险

| # | 风险 |
|---|---|
| 1 | **转单路径尚未真实跑过**（本轮只到"按钮可见"） |
| 2 | 跨店/总部/viewer 反例未在隔离实例验证（下轮做） |
| 3 | 隔离实例的 `admin123` 是 install 默认口令 —— **仅本机，且容器不对外** |
| 4 | `storage-uat` 里可能有 seed 产生的静态资源，销毁时一并删 |

---

## 12. 申请

**BE-02B Gate 2 环境与合成档案：READY FOR WRITE AUTHORIZATION。**

| 项 | 状态 |
|---|---|
| 隔离容器/库/存储 | **PASS** |
| 插件启用 | **PASS** |
| 合成账号 + 门店授权 | **PASS** |
| 合成档案（3 条可转 + 3 条无手机号对照） | **PASS** |
| `data_origin=synthetic` 服务端认证 | **PASS** |
| S01 浏览器查询/详情/转单按钮/弹窗/脱敏 | **PASS** |
| 零真实转单 | **PASS** |
| 原库基线 | **未变** |
| 真实转单执行 | **未授权，未执行** |

**等你下一次明确授权后，才调用转单接口。** 停在此处。
