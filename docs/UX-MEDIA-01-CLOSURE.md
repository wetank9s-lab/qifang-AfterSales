# UX-MEDIA-01 验收与测试数据安全收口记录

> 日期：2026-10-17 · 状态：**UX-MEDIA-01 PASS / FROZEN** · UX-01B IN PROGRESS · UX-01C 服务时效 PASS/FROZEN（整体 IN PROGRESS）· P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD
> **未 commit / 未 push。** 真实工单 `FW20261017-0012` **未做任何修改或删除**。

---

## 一、合成工单 `FW20261017-0015` 为什么被改

`verify-store-ui-primary-action.mjs` 的写操作用例原先**按状态从列表里挑任意一张**：

```js
// ④ 处理（含取消 / 电话解决）
async function openHandleOnNew() {
  let found = await findRowByStatus('NEW');        // ← 列表里第一张 NEW
  if (!found) { /* 只有"没有了"才自建 */ }
}
// ④-b 客户取消：对 found 点「取消」
// ④-c 电话解决：再找一张 NEW，点「电话解决」
// ⑤ 跟进：切「处理中」Tab，取第一张 PROCESSING 并保存
// 评价闭环：`ORDER BY id DESC LIMIT 1` 取一张 NEW/PROCESSING 做 remoteComplete
```

`FW20261017-0015` 是当时最新的 NEW 工单 ⇒ 被 ④-b 选中并改为 `CANCELLED`。
**不是脚本"认识"这张单，而是它恰好排在第一位** —— 这正是用户指出的测试安全风险。

---

## 二、全部写操作用例的测试数据来源核查

| 用例 | 修复前数据来源 | 是否写真实工单 | 修复后 |
|---|---|---|---|
| ④-b 客户取消 | 列表首个 `NEW` | **是** | 本轮自建 `[UIPA-NEW-1]` |
| ④-c 电话解决 | 列表首个 `NEW`（第二次） | **是** | 本轮自建 `[UIPA-NEW-2]` |
| ⑤ 跟进保存 | 「处理中」Tab 首个 `PROCESSING` | **是**（写 follow_up 事件） | 本轮自建 `[UIPA-PROC]`（真实 `svc:dispatch` 进入 PROCESSING） |
| ⑥ 门店确认详情 | **原本就自建** | 否 | 不变 |
| 评价闭环（remote + review） | `ORDER BY id DESC` 的 NEW/PROCESSING | **是** | 复用 ④-c 的夹具；否则只在夹具白名单里挑 |
| UX-01A #3 内部备注 | `ORDER BY id DESC` 的最新真实 `CLOSED` | **是**（写 internal_note） | 自建 `[UX01A-R9-NOTE]` 并走真实闭环 → CLOSED |
| UX-01A #2 审核详情 | **原本就自建** | 否 | 不变 |
| ①/①b/①c/②/③/⑦ 及六状态扫描 | 只读 | 否 | 不变（①c 改为**只读翻页**找非查看态行） |

另：历史上一次被中断的运行留下了 `#6652 / #6653` 两张 `UIPA-*` 夹具（均带标记），
已按 id 精确清理（`cleanupTicket`，含 1 张照片与附件）。

---

## 三、隔离修复（最小改动，不动 CDP 框架）

1. **唯一写白名单** `writableFixtures`：只有 `createScratchTicket()` 创建的 id 会被登记；
   `assertWritableFixture(id, step)` 在取消 / 电话解决 / 跟进 / 评价前**硬断言**，
   不在白名单 ⇒ 直接失败（绝不落到真实工单）。
2. **④ 无条件自建**（不再"先找现成的"），并用 `findRowById()` 按**精确 id** 定位行。
3. **⑤ 自建 + 真实派工**：建单 → `svc:dispatch` → PROCESSING，再按 id 定位。
4. **评价闭环只用自己的夹具**：优先复用 ④-c 的 WAIT_FEEDBACK；否则只在白名单里挑。
5. **找不到夹具 = 环境阻塞**：记红并停止该用例，不回退。
6. **清理**：所有断言跑完后 `cleanupAllFixtures()`；异常路径也会兜底清理。
   `cleanupTicket()` 已扩展为同时清理客户媒体（`customer_medias` / `customer_media_sessions` / 私有文件），
   防止"带媒体的夹具"留下孤儿。
7. **不删断言**：①c 原本只在"第 1 页恰有非查看态行"时才执行；
   现改为**只读翻页查找**，找不到才按纪律记"未验到"。

### 定向验证（同一环境、前后指纹对照）
非夹具工单（`customer_name not like 'UIPA-%' and not like 'UX01A%'`）的指纹：

```
跑前：{"tickets":"469","stateHash":"ea3081fa20e779c3ce9119df67fed9a7","events":"1760","sms":"733"}
跑后：{"tickets":"469","stateHash":"ea3081fa20e779c3ce9119df67fed9a7","events":"1760","sms":"733"}
```

`stateHash` 覆盖所有非夹具工单的 `status / next_follow_at / completed_at / closed_at`。
**逐字节相同 ⇒ 本轮门禁对真实工单零写入。**

| 门禁 | 结果 | 夹具 |
|---|---|---|
| `verify-store-ui-primary-action.mjs` | **65 / 0**（与整改前同数量） | 4 张自建，全部按 id 清理 |
| `verify-ux-01a-final.mjs` | **15 / 0** | 2 张自建（#2 / #3），全部清理 |
| `verify-ux-media-01.mjs` | **58 / 0** | 视频夹具改为**每次自建 + 清理**（多出 1 条清理断言） |

**授权范围说明**：①c 的翻页定位会打开真实工单的详情抽屉（`FW20261014-0177`），
这是**只读**验证（只点「查看」、不提交任何写动作），符合"真实客户工单只允许无副作用只读"。

---

## 四、`FW20261017-0015` 的处理

- 环境：`APP_ENV=development` + `SMS_PROVIDER=mock` + `PUBLIC_BASE_URL=http://localhost:8080`
  ⇒ 隔离 UAT，非生产。
- 关联数据核实：1 条媒体（video/webm 20,012 B）、1 个会话（`bound`）、3 条事件、1 条短信、0 条派工、2 条幂等记录。
- 依赖：仅本单自身；不承载任何回归夹具职责（媒体门禁已改为**每次自建 + 跑完清理**）。
- **处置：按 id 精确清理**（`cleanupTicket(6673)`，先校验标记再删）。

### 清理回执
```
BEFORE  6673 / FW20261017-0015 / CANCELLED / name=合成测试视频（标记校验通过）
DEPS    medias=1 sessions=1 events=3 sms=1 visits=0
CLEANED 行全部删除；私有文件 customer/697/813462d6….webm 已不存在（目录也已收掉）
LEFT    tickets=0 medias=0 sessions=0 events=0 sms=0
```

清理后**非夹具指纹**（与清理前 `469 / 1760 / 733` 相比，差值恰好等于该单自身的 1 张工单 / 3 条事件 / 1 条短信）：

```
{"tickets":"468","stateHash":"e76470e8…","events":"1757","sms":"732"}
```

另：历史中断残留的两张 `UIPA-*` 夹具（#6652 / #6653）也已按 id 清理（含 1 张照片 + 1 个附件）。
当前库内 `UIPA-% / UX01A% / UX-MEDIA% / 合成测试%` 工单数 = **0**。

真实工单 `FW20261017-0012`：**未修改、未删除**。只读指纹（清理前后逐字节一致）：

```
ticket: md5 a2206cbecd38…（元数据指纹，不含任何字段值）
media : 3 个文件 / 合计 662280 B
sha256: 4f110e2f…(.png) / 58a095d2…(.jpg) / c01900c5…(.webm)
```

---

## 五、非阻断待办（保留，不重开媒体系统）

1. 较大视频（接近 8 MB）的后台加载耗时、内存占用与预览稳定性未专项测量。
2. 原始文件名 UTF-8 被按 Latin-1 解释（界面不展示文件名，故不影响查看）。
3. Blob 生命周期：每个媒体项在 `useEffect` cleanup 里 `URL.revokeObjectURL`，
   抽屉 `destroyOnClose` ⇒ 关闭即卸载；切换工单会重新挂载并释放旧 blob。
   （本轮未做长时压测，属待办 1 的一部分。）

---

## 六、Git 差异与增量密钥审计

### 6.1 工作区状态
- **暂存区为空**（`git diff --cached` 无内容）⇒ 本轮没有"看起来已提交"的中间态。
- 工作区包含**累积未提交**改动（UX-01A/B/C + UX-MEDIA-01），`git diff --stat`：34 个文件，+2776 / −276。
- 本轮（UX-MEDIA-01 + 收口）**增量**：
  - 新增：`server/actions/svc/ticket-media.ts`、`scripts/verify-ux-media-01.mjs`、
    `scripts/verify-native-sensitive-fields.mjs`、`docs/UX-MEDIA-01-REPORT.md`、本文件。
  - 修改：`server/services/media-store.ts`、`server/constants.ts`、`server/plugin.ts`、
    `shared/svc-action.ts`、`client/ticket-drawer.tsx`、
    `scripts/verify-store-ui-primary-action.mjs`（隔离闸）、`scripts/verify-ux-01a-final.mjs`（隔离闸）、
    `scripts/technician-harness.mjs`（夹具清理含客户媒体）、
    `docs/API.md` / `SECURITY.md` / `DEVIATIONS.md`（DEV-204/205）/ `BACKLOG.md`。
  - `h5/**`、`UX-01A/B/C` 的其它文件是**此前轮次**的未提交改动，本轮未再修改（H5 侧媒体能力保持冻结）。

### 6.2 增量密钥审计（结果）
| 检查 | 结果 |
|---|---|
| 明文口令 / 私钥 / `SIGN_SECRET` 形态（本轮涉及文件） | **未命中** |
| 被打印过的进度 Token 明文（`gtJI5iUF…`）是否落盘 | **全仓未命中**（只出现在当时的 stdout） |
| 真实客户手机号 / 姓名是否写入文档 | **未命中**（报告只写工单号与媒体计数） |
| 暂存区是否含 `.env` / `storage/**` / `.tmp-verify/**` | **否**（暂存区为空；三项均被 `.gitignore` 覆盖） |
| 本文件中的工单指纹 | ticket md5 只保留前缀，**不含任何字段值**；文件 sha256 只保留前缀 |

> ⚠️ 发布前仍需按既有纪律跑一次 `repo-publish-secret-audit`（运行期密钥文件如
> `storage/apps/main/aes_key.dat` 不在 `.env` 里，用 `.env` 反查查不到）。

