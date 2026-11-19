# P6-E 状态登记 & E-OTP-MIGRATION-01 核查简报

> 时间：2026-10-25 10:16–10:30 CST
> 本轮只做只读核查与状态登记；**未修改评价功能**。

---

## 一、正式状态（本文件为准）

| 项 | 状态 |
|---|---|
| **E 组：服务进度页直接评价** | **PASS / FROZEN**（隔离功能与安全验收范围） |
| P6-E-OTP（短信验证码） | **CANCELLED** |
| **E-OTP-MIGRATION-01** | **OPEN**（新环境迁移核查 → 结论见 §三，处置方案待授权） |
| Android / iPhone 真机 | **PENDING** |
| 生产 E 组部署 | **NOT AUTHORIZED** |
| P6 | LIVE / CONDITIONAL |
| Release | **HOLD** |

冻结范围（复述，不再改动）：持有效 Progress Token 直接评价 · 已完成服务才可评价 · 1–5 星与回显 ·
收费核对与 fail-closed · 一致/不一致主动选择 · 单次评价/并发/跨单隔离 · 旧 Review Token 兼容 ·
争议重开后的只读展示与"门店继续处理"提示。

> 历史报告保留当时结论，**不回写**为伪造 PASS。

---

## 二、迁移框架怎么识别"已执行"

源码证据（容器内实际产物）：

```
@nocobase/server/lib/plugin.js:151  async loadMigrations()
  → 目录 = <pluginBase>/server/migrations
  → app.loadMigrations({ directory, namespace: <packageName> })

@nocobase/database/lib/database.js:257  createMigrator({ migrations })
  storage.tableName = `${tablePrefix}migrations`
  sortBy(migrations, m => m.name)
```

结论：NocoBase 用 **Umzug**，以 `migrations` 表按 **name（= 文件名@插件名）** 记录已执行项；
`up()` 时执行"**表里没有的**"那些文件，按名称排序。

实测登记值：`202610251-review-verify-codes/@local/service-ticket` —— 说明它**已登记**，
所以在**当前这个库**里不会被重跑。

---

## 三、全新空库实证（关键，且有一个必须说清的限定）

做法：新建 `scqf_mig_probe` 空库 + 一次性容器（`--tmpfs /app/nocobase/storage`，全新 storage），
与本插件同镜像、同 env，跑 180 秒后检查，最后**容器与库都已销毁**（现有库只剩 `postgres`、`scqf_media_test`）。

结果：

| 观测 | 值 |
|---|---|
| `review_verify_codes` 是否存在 | **0（不存在）** |
| `migrations` 行数 | **0** |
| 是否登记了 `202610251-…` | **无** |
| 探针日志 | `[file-deletion] sweep 异常：relation "pending_file_deletions" does not exist` |

**限定（必须诚实说明）**：`pending_file_deletions` 也不存在 ⇒ **这次启动根本没执行任何插件迁移**。
原因是空库里插件未安装/未启用，`loadMigrations` 没有产出可执行集合。
所以这次实证**不能**证明"新环境不会建表"，它只证明了"**空库 + 插件未启用时不会建**"。

---

## 四、结论：**情况 B（条件成立）**

- 迁移文件 `202610251-review-verify-codes.ts` 的 `up()` **仍然包含 `CREATE TABLE IF NOT EXISTS review_verify_codes`**（本轮只加了头部注释，未改逻辑）；
- Umzug 的判据是 `migrations` 表；**任何真实部署都会安装并启用本插件**（它是业务核心），
  启用时 `migrations` 为空 ⇒ **会执行该文件 ⇒ 表会被建出来**；
- 因此：**E-OTP-MIGRATION-01 = OPEN，风险真实存在**，只是触发条件是"插件被安装/启用"，
  而不是"库里有没有登记"。

---

## 五、最小、向前兼容的处置方案（**待授权，未写入代码库**）

新增一个**更晚**的迁移（不改历史、不删登记、不 CASCADE）：

```ts
// migrations/202610252-drop-review-verify-codes.ts
import { Migration } from '@nocobase/database';

/**
 * 撤销 OTP 后的收尾：把已取消方案留下的表清掉。
 * · 新环境：先执行 202610251 建表，再由本迁移删掉 ⇒ 净结果 = 无此表；
 * · 现有环境：表已被手工删除 ⇒ IF EXISTS 使其成为 no-op；
 * · 不修改 202610251 的代码与登记，历史保持一致；
 * · 不使用 CASCADE，不触碰其他表。
 */
export default class extends Migration {
  on = 'afterLoad';
  async up(): Promise<void> {
    await this.db.sequelize.query('DROP TABLE IF EXISTS review_verify_codes');
  }
  async down(): Promise<void> {
    /* 不可逆：本表属于已撤销方案，不提供重建 */
  }
}
```

**性质**：这是"向前的新记录"，不是篡改历史；对现有库是 no-op。
**但它会在下次部署时对生产执行一次 `DROP TABLE`** ⇒ 按你令 §三 要求，
**必须先取得生产变更授权**才能合入/部署。本轮**未创建该文件**。

替代方案（若不想在生产执行任何 DDL）：保留空表不动（`IF NOT EXISTS` 已建过就无害），
代价是留下一张无人使用的表。**我不建议**，但它是零 DDL 的选项。

---

## 六、对现有隔离环境与生产的影响

| 环境 | 现状 | 影响 |
|---|---|---|
| `scqf_media_test` | 表已删；`migrations` 仍登记 202610251 | 不会重建（已登记）；无功能影响 |
| 全新隔离库（插件未启用） | 无表、无迁移 | 实证见 §三 |
| 全新生产实例（插件启用） | **会建表** | E-OTP-MIGRATION-01 的实际风险 |
| 现有生产实例（已启用插件） | 表从未存在过（OTP 未上线生产） | 无影响 |

---

## 七、生产零改动 & Git

- 生产 DB / H5 / 插件 / Nginx：**未触碰**
- 探针容器与探针库：**已销毁**（`pg_database` 仅剩 `postgres`、`scqf_media_test`）
- 本轮未改任何评价功能代码；未发真实短信
- **未 commit / 未 push**

---

## 八、仍待真实设备

Android / iPhone 真机 = **PENDING**（收费金额键盘、`inputmode=decimal`、字号放大换行），
发布前单列检查，**不冒充真机 PASS**。
