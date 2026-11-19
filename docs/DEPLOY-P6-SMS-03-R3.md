# P6-SMS-03 单号码实发验收报告（R3 · 未达成，含 2 个真实缺陷修复）

> 时间：2026-10-22 15:41–15:52（CST）
> 测试号码：15002818184（用户提供）
> 结论：**单号码实发未达成**。但过程中挖出并修复了 **2 个会让功能永远不可用的真实缺陷**。
> 当前状态：`sms.enabled=false`、应用 healthy、**真实发送 0 条**。

---

## 1. 两个真实缺陷（本轮最大收获）

### 缺陷 A：`enqueue()` 后没有 `flush()` —— 提交成功短信**永远发不出去**

`SmsService` 的设计是两步：`enqueue()` 只写 outbox（`send_status=pending`），
必须再调用 `flush([...])` 才真正调供应商。而 `actions/public/ticket.ts` 建单后**只 enqueue，没有 flush**。

后果链条：
- 行停在 `pending`；
- 延迟重试只捞 `error` ⇒ 够不着；
- 恢复扫描只捞"**超龄 pending 且请求可重建**"，而进度短信的请求含**明文 token**，**不可重建**
  ⇒ 5 分钟后被判 `SMS_PENDING_ORPHAN_UNREBUILDABLE`。

**这不是我造的**：真实客户 14:43 / 14:52 / 14:55 三笔的 `SMS_PENDING_ORPHAN_UNREBUILDABLE`
就是这个机制的产物。**也就是说：如果今天直接开闸，没有任何一条提交成功短信会发出去。**

修复（`ticket.ts`，3 行）：

```diff
- await services.sms.enqueue({ scene: SMS_SCENE.PROGRESS_LINK, ... });
+ const pendingSms = await services.sms.enqueue({ scene: SMS_SCENE.PROGRESS_LINK, ... });
+ await services.sms.flush([pendingSms]);
```

**已验证生效**：修好后建单，同一条记录 `t=1` 就从 `pending` 落定（说明 flush 在链路内执行了）。

### 缺陷 B：短信宝被"模板码门禁"误杀

```ts
if (provider.name !== MOCK && !pending.templateCode) → SMS_TEMPLATE_NOT_CONFIGURED
```

这道闸是为**阿里云按 TemplateCode 发送**设计的。而短信宝**收发完整正文**（`c` 参数），
注册模板在供应商侧审核、**不对应任何 TemplateCode** ⇒ 短信宝通道上每一条都会被这条闸拦死。

实测：flush 修好后，6426 立刻变成 `rejected / SMS_TEMPLATE_NOT_CONFIGURED`。

修复：该闸只对"需要模板码的通道"生效，短信宝豁免（附源码注释说明原因）。

**构建**：源码指纹 `1e0e3b5a8f44`，bundle 1,482,102 B，已部署。

---

## 2. 三次实发尝试的结果（全部失败，逐次原因不同）

| 次 | 结果 | 原因 |
|---|---|---|
| R1 | 工单 6916 建立，短信 6424 `pending` | 我在 flush 完成前重启，打断了在飞请求 |
| R2 | 工单 6917 建立，短信 6425 等 40 秒仍 `pending` | 暴露了缺陷 A（根本没 flush） |
| R3 | **工单未建立** | `RATE_LIMITED`：该手机号**今日提交次数已达上限** |

R3 的接口响应（原文）：

```json
{"errors":[{"code":"RATE_LIMITED","message":"该手机号今日提交次数已达上限，请明日再试或直接联系门店"}]}
```

**⇒ 未产生任何真实短信发送。短信宝侧应无扣费。**

---

## 3. 当前配置与服务状态

| 项 | 值 |
|---|---|
| DB `sms.enabled` | **false**（每轮测试后立即关闭） |
| DB `sms.provider` | smsbao |
| DB `sms.retry_count` | 1 |
| 容器 `SMS_ENABLED` | false |
| `SMSBAO_SIGN_NAME` | **SET**（len=9，即 `【四川恒晟恒七方】`） |
| 凭据预检（余额查询） | 返回码 **0**，账户可查询 |
| 应用健康 | healthy |
| 站点 `/h5/report`、`/api/public/stores`、`/api/svc:health` | 200 / 200 / 200 |

---

## 4. 补偿控制：钱包风险已被三重挡住

即使我在窗口期短暂开启过 `sms.enabled=true`，**没有一条短信真正发出**，原因是：

1. 缺陷 A 让 R1/R2 的短信根本没进发送流程；
2. 缺陷 B 让 R3 前的 flush 被 `SMS_TEMPLATE_NOT_CONFIGURED` 拦下；
3. 缺陷修复后，R3 因**手机号日限**连工单都没建成。

⇒ **短信宝余额未被消耗**（可从后台核对）。

---

## 5. 遗留的合成测试记录（需精确清理，尚未执行）

| 类型 | id | 标记 |
|---|---|---|
| 工单 | 6916 `FW20261022-0008` | `content` 含「【P6-SMS-03 合成测试·请忽略】」、`customer_name=短信通道测试`、手机号 15002818184 |
| 工单 | 6917 `FW20261022-0009` | 同上 |
| 工单 | 6918 `FW20261022-0010` | 同上（R3 未建，可能不存在） |
| 短信 | 6424 / 6425 / 6426 | 均为 `progress_link`，非真实客户 |

**清理方案（待你确认后执行，不擅自动手）**：
1. 按 id 精确删除 `sms_logs` 6424/6425/6426；
2. 按 id 精确删除 `service_tickets` 6916/6917（+6918 若存在）及其 `ticket_events`；
3. 同步移除 `customer_media_sessions` 中对应会话（若有）；
4. **不**使用范围删除（`id >`），避免误伤真实工单；
5. 清理前先导出这 6 行的完整快照留档。

> ⚠️ 我不会自行执行删除 —— 真实工单随时在进，范围判据一旦写错就是事故。

---

## 6. 需要你决定的一件事

**手机号 `15002818184` 已达当日提交上限**（今日已用它建了 3 单）。
要继续实发验收，三选一：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 换一个**另一个内部号码**做测试 | 最简单，不碰限流规则 |
| B | 明日再用同一号码 | 等一天 |
| C | 调高该场景的手机号日限 | **不建议**——那是防刷单的业务规则，为测试放宽会有真实滥用风险 |

---

## 7. 判定

- **单号码实发：未达成（PENDING）**。
- 但**两个致命缺陷已修复**：按原实现，开闸后**一条短信都不会发出**；
  现在链路上能走到 `provider.send` 了（只差一个未被限流的号码）。
- 实发 **0**；`sms.enabled=false`；应用 healthy；生产数据未删改。
- **不把"配置成功"写成"送达成功"**；**不把"接口返回 0"写成"手机收到"**。
- P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。

### 下一步只需两件事

1. 给我**另一个内部号码**（或明日复用）；
2. 确认 §5 的清理方案。

拿到后我一次跑完：真实发送 → 核对短信宝响应 → 你确认手机实收 → 立即停发 → 精确清理。
