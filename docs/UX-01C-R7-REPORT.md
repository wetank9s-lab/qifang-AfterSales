# UX-01C 第七轮：门店资料管理交付报告

> 日期：2026-10-17 · 状态：P11-5 PASS/FROZEN · UX-MEDIA-01 PASS/FROZEN · UX-01C 服务时效 PASS/FROZEN · B-18 PASS/FROZEN · **UX-01C 门店资料管理 待验收裁决** · UX-01C 整体 IN PROGRESS · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD
> **未 commit / 未 push。** 真实 15 家门店**未被用于任何启停测试**。

---

## 一、交付内容

| 能力 | 结果 |
|---|---|
| 「门店报修入口」行内新增**「门店资料」**动作（仅服务端判 `hq_admin`） | ✅ |
| 可维护字段：`name` / `contact_phone` / `address` / `active`（`code` 只读） | ✅ |
| 受控写接口 `svc:updateStoreProfile` + 读模型 `svc:storeProfile` | ✅ |
| 新审计表 `storeProfileAudits`（同事务 / 幂等 / 恢复留痕） | ✅ |
| 原生写入口对业务角色全关（update/create/destroy/bulkUpdate/upsert） | ✅ |
| 客户 H5 名称/电话/地址生效；空电话不编造 | ✅ |
| 启停：停用后入口 404 + 新报修拒绝；历史工单仍可查；恢复后原签名码有效 | ✅（仅隔离门店 `T98`） |
| 真实浏览器编辑闭环 + 422/409 | ✅ |
| 重启后数据与审计仍在 | ✅ |

专项门禁：**`verify-ux-01c-store-profile.mjs` 71 / 0**。

---

## 二、字段、校验与并发（逐条对应 §二）

| 字段 | 长度（真实 schema） | 规则 |
|---|---|---|
| `name` | 64 | 非空、≤64、禁止换行/制表符 |
| `contact_phone` | 20 | **可空**；只允许数字与 `+ - ( ) # * 空格 转 x`，至少 5 位数字 —— 兼容手机 `138…`、座机 `028-12345678`、客服 `400-800-1234`；**不清空成假号码** |
| `address` | 200 | 可空、≤200 |
| `active` | bool | **只接受 `true`/`false`**（或字面量），`yes`/`1` 一律 422 |
| `code` | — | **不可写**：422 `STORE_CODE_READONLY`，提示"会让已印发的二维码失效" |

- **同事务**：`UPDATE` 与 `storeProfileAudits` 在同一 `sequelize.transaction`。
- **原子条件更新**：`Model.update(values, { where: { id, [field]: oldValue } })`，
  影响行数 ≠ 1 ⇒ 409（不是 DEV-203 那种"取错返回值/条件没进 WHERE"的写法）。
- **幂等**：`storeProfileAudits` 唯一索引 `(request_id, store_id, field)`；
  同 `X-Request-Id` 重放 ⇒ `replayed=true`，**不新增审计**。
- **恢复**：`scene=restore` 再写一条审计，不回改历史。
- **值没变**：不更新、不写审计（避免"点两次保存"产生两条无意义记录）。

---

## 三、原生写入绕过收口（§三）

`stores-read-scope` 在 ACL 之后、handler 之前裁决：**非只读 action 一律 403**。
实测四个业务角色（`hq_admin` / `hq_after_sales` / `store_A` / `viewer`）：

```
stores:update     403      stores:create      403
stores:destroy    403      stores:bulkUpdate  403/404
```

且绕过尝试后**夹具门店值未变**；匿名写 401/403。平台 `root`/`admin` 不经过该层，
保留初始化、迁移与维护能力（未改动）。

---

## 四、真实管理员编辑体验（§四）

CDP 真实浏览器（`hq_admin`）：

1. 「门店报修入口」→ `T98` 行 →「门店资料」→ 弹窗显示**数据库当前值**（名称/电话/地址/启用）与只读编码；
2. 改名称/电话/地址 → 保存 → 提示「已保存门店资料（name、contact_phone、address）」→ 表格**立即刷新**为新值；
3. 关闭重开 → 弹窗显示数据库最新值（不是内存态）；
4. 清空名称 → 保存 → **422 `STORE_NAME_REQUIRED`**，提示「门店名称不能为空」，弹窗保持打开；
5. 弹窗打开期间另一管理员改名 → 本地保存 → **409 `STORE_PROFILE_CONFLICT`**，
   提示当前值与"你看到的值"，**弹窗关闭 + 表格重新读取**为外部值（不静默覆盖）；
6. 门店账号（独立会话）点同一个动作 → 提示「仅总部管理员（hq_admin）可以修改门店资料」，弹窗不打开。

截图：`.tmp-verify/ux01c-r7-store-profile-modal.png`

---

## 五、隔离门店夹具与启停（§五）

- 夹具：`T98`（名称以 `R7…` 开头，SQL 建立，**只在本门禁内存在**；真实 15 家门店未动）。
- 建单：启用状态下用 `T98` 的**签名入口**走真实匿名链路建单（`FW…`），随后：
  1. 启用时签名入口 **200**；
  2. 停用后入口 **404**、新报修 **422**（服务端拒绝）；
  3. 停用后该工单 `svc:timeline` 仍 **200**（历史数据与授权不变）；
  4. 恢复启用后**原签名入口 200**，`entry` 字符串与停用前**逐字相同**；
  5. 改名/改电话/改地址后 `entry` 仍不变（签名只依赖 `code`）；
  6. 停用、恢复各一条审计（`true→false` / `false→true`，`scene=restore`）；
  7. 结束按 **ID** 清理：夹具工单（`cleanupTicket`）、审计（`store_id`）、门店（`id`）
     —— 清理后 `audit=0 / store=0 / ticket=0`。
- SMS 全程 `mock`；夹具客户手机号是测试号，没有对外发送。

---

## 六、客户 H5 实际生效（§四）

通过匿名接口（客户真实读取路径）验证：

| 操作 | `/api/public/store-entry?k=<T98 签名入口>` |
|---|---|
| 改名 | `name` 立即返回新值 |
| 设置座机 `028-12345678` | `phone` 返回真实值 |
| 清空电话 | `phone = null`（**不生成假号码**） |
| 设置地址 | `address` 返回新值 |

---

## 七、两个已发现问题的核查（§六）

### A. 对外二维码基址 —— **Release PENDING（不宣称公网扫码通过）**
- 唯一来源：`services/public-url.ts`，读取顺序 **`PUBLIC_H5_BASE_URL` → `PUBLIC_BASE_URL`**。
- 当前 `.env`：`PUBLIC_BASE_URL=http://localhost:8080`，**未配置** `PUBLIC_H5_BASE_URL`
  ⇒ 二维码内容为 `http://localhost:8080/h5/report?k=…`（UAT 可用，**不可对外**）。
- 生产档已有硬闸：`assertPublicBaseForProduction()` 对 localhost / 内网 IP / 非 80·443 端口
  **直接拒绝启动**（不会静默产出扫不开的二维码）。
- ⇒ 正式上线前必须配置 `PUBLIC_H5_BASE_URL=https://<客户可访问域名>`；
  本机无法访问公网，**不做"公网扫码通过"的结论**。签名算法本轮未改。

### B. `stores` 字段投影 —— **已改为显式允许列表**
- 本轮新增 `NATIVE_READ_FIELD_ALLOW.stores`（9 列：id/code/name/active/sort_order/
  contact_phone/address/createdAt/updatedAt）；`nativeReadFieldsOf()` **正向清单优先**。
- 效果：**将来给 stores 加列默认不下发**；要暴露必须改清单（有评审、有门禁）。
- 门禁 `verify-ux-01c-store-entry.mjs` 断言响应字段**恰好等于**这 9 列；
  清单里写了不存在的列 ⇒ 播种时抛错（不是静默忽略）。
- viewer / 门店账号的读取范围**未放宽**：门店仍是本店行级；viewer 仍是全量只读。

---

## 八、门禁与回归

| 门禁 | 结果 |
|---|---|
| `verify-ux-01c-store-profile.mjs`（新增） | **71 / 0** |
| `verify-ux-01c-store-entry.mjs`（B-18，冻结模块回归） | **36 / 0** |
| `verify-ux-01c-pages.mjs` | **22 / 0** |
| `verify-ux-01c-settings-auth.mjs`（服务时效，冻结模块回归） | **29 / 0** |
| `verify-native-sensitive-fields.mjs` | **44 / 0** |
| `verify-plugin-load.mjs` | **82 / 0** |
| `verify-store-ui-primary-action.mjs` | **65 / 0** |
| `verify-store-entry.mjs`（P11-1 入口契约，本页被改） | **93 / 0** |
| `verify-ux-01a-final.mjs` | **15 / 0** |

> 变异测试：本轮的行级收窄（B-18）与并发/幂等（R7）均由门禁逐条验证；
> 其中 **DEV-206**（空字符串期望值与 NULL 不等导致"每次保存 409"）就是门禁
> 在"弹窗空电话 → 保存"这一步抓出来的，不是靠读代码看出来的。

---

## 九、Git 与密钥

- **未 commit / 未 push**；暂存区为空；`git diff --check` 无空白错误。
- 本轮增量：
  - 新增 `collections/storeProfileAudits.ts`、`actions/svc/store-profile.ts`、
    `client/store-profile-action.tsx`、`scripts/verify-ux-01c-store-profile.mjs`；
  - 修改 `collections/index.ts`、`constants.ts`（字段规格 / 白名单 / 动作）、
    `seeds/apply.ts`（正向字段清单）、`seeds/roles.ts`、`plugin.ts`、`shared/svc-action.ts`、
    `client/index.ts`、`scripts/ticket-page-actions.mjs`、`scripts/seed-admin-pages.mjs`、
    `scripts/verify-plugin-load.mjs`、`scripts/smoke-test.mjs`、`scripts/expected-indexes.mjs`、
    `docs/API.md` / `SECURITY.md` / `DATA-MODEL.md` / `DEVIATIONS.md`。
- 密钥审计：无新增口令/密钥/Token 字面量；未写入真实客户资料；夹具已清零。

---

## 十、PENDING（不阻塞本轮）

- **对外基址**（同上 §七 A）：Release 前配置真实域名，属发布门禁，不属本轮开发。
- 门店资料编辑的**批量保存**（一次事务改多字段）未做：当前按字段逐笔提交，
  每笔独立审计/重试；多字段"全有或全无"若将来需要，另立需求（本轮未过度设计）。
