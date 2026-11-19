# P6-SMS-03 短信宝正式生产上线验收报告

> 时间：2026-10-22 15:27–15:35（CST）
> 本轮完成：关口三（上线前快照）、**关口四（scene 允许名单，已上线）**、关口七（队列快照）
> 本轮阻断：**关口五/六/八/九/十** —— 根因是 **`SMSBAO_*` 凭据 0/4，一个都没配**
> 判定：**未达 PRODUCTION LIVE**。生产发送仍 **HOLD**，`sms.enabled=false` 未动，实发 **0**。

---

## 0. 一句话结论

> 本轮把**开闸前唯一还缺的安全门禁**（scene 白名单）做完并上线了 —— 这是本轮最有价值的产出。
> 但**短信发不出去**：`.env.prod` 里 `SMSBAO_USERNAME / API_KEY / SIGN_NAME / PRODUCT_ID`
> **实测注入 0/4**。没有凭据，关口八的内部号码实发和关口九的正式启用都无从谈起。

---

## 1. 生产配置生效证据（无密钥）

### 1.1 凭据状态（只报存在性）

```
SMSBAO_* 已注入 = 0 / 4
```

| 变量 | 容器内 |
|---|---|
| `SMSBAO_USERNAME` | 未注入 |
| `SMSBAO_API_KEY` | 未注入 |
| `SMSBAO_SIGN_NAME` | 未注入 |
| `SMSBAO_PRODUCT_ID` | 未注入 |

⇒ `SmsbaoProvider.configured === false`，`send()` 会直接返回 `SMS_MISCONFIGURED`。

### 1.2 开关与 provider

| 键 | 值 |
|---|---|
| DB `sms.provider` | **smsbao** |
| DB `sms.enabled` | **false** |
| DB `sms.retry_count` | 1 |
| 容器 `SMS_ENABLED` | false |
| 容器 `SMS_PROVIDER` | smsbao |

### 1.3 关于 Compose 覆盖关系（§五 要求）

本项目此前踩过两次 `environment:` 覆盖 `env_file` 的坑，现行约定是
**`environment:` 里只写 `${VAR}` 引用，不写字面值**。本轮核对未改动该文件，也未重建容器
（只 `docker restart scqf-as-app`，走 `env_file`）。

> ⚠️ 由于凭据缺失，**"容器是否真能读到正确凭据"这一条无法验证** —— 没有值可读。

---

## 2. 唯一允许发送的 scene（本轮核心交付）

### 2.1 为什么必须做这件事

全局 `sms.enabled` 是**总闸**：一开就同时放开全部 7 个 scene。用户只批准一条"提交成功通知"，
而**派工通知（`dispatch_customer` / `technician_task`）是运营日常动作** —— 一旦开闸，
下一次派单就会给客户和师傅真发短信。靠"大概不会触发"来保证安全是不可接受的。

### 2.2 实现（最小 diff）

```diff
// constants.ts
+ export const SMS_PRODUCTION_ALLOWED_SCENES: readonly string[] = ['progress_link'];
+ export const SMS_SCENE_NOT_ALLOWED = 'SMS_SCENE_NOT_ALLOWED';

// services/sms-service.ts · deliverOne()  —— 唯一首发漏斗
  const { provider } = ctx;
+ // ---- 闸 0：scene 允许名单（P6-SMS-03）----
+ // 放在 enabled 闸**之前**：非白名单场景即使通道开着也必须拒绝，
+ // 且拒绝原因要能与"通道未就绪"区分开（出事时才分得清是闸 0 还是闸 1 拦的）。
+ // mock 通道不拦 —— 它不产生真实费用，拦了会让本地联调全废。
+ if (provider.name !== SMS_PROVIDER_NAME.MOCK &&
+     !SMS_PRODUCTION_ALLOWED_SCENES.includes(String(pending.scene))) {
+   await this.finish(pending, { accepted: false, errorCode: SMS_SCENE_NOT_ALLOWED, ... });
+   return { ..., errorCode: SMS_SCENE_NOT_ALLOWED };
+ }
  // ---- 闸 1：通道未就绪（sms.enabled=false）----
```

**为什么放在 `deliverOne`**：它是**唯一的首发漏斗**。
`provider.send` 全仓只有 1 个调用点（`safeSend`），而 `safeSend` 的三个上游
（首发 / 重试 / 恢复）中，重试只处理 `error` 行、恢复只处理 `pending` 行 ——
两者都是**已经通过过 `deliverOne` 的行**，所以闸 0 天然覆盖整条链路，不需要在三处各写一遍
（那正是"同一个坑有两条腿"）。

**为什么放在 `enabled` 之前**：这样即使通道处于禁用态，非白名单 scene 也会落
`SMS_SCENE_NOT_ALLOWED` 而不是 `SMS_DISABLED` —— 事后能区分"是场景不该发"还是"通道没开"。

### 2.3 产物级验证

```
$ grep -c SMS_SCENE_NOT_ALLOWED dist/server/index.js
3
$ grep -o "progress_link" dist/server/index.js | head -1
progress_link
```

构建：源码指纹 `f667c92a9dc0…`，bundle **1,481,971 B**，已部署并 `docker restart scqf-as-app` → healthy。

### 2.4 诚实边界

- 运行期证据（真实触发一个非白名单 scene 观察拒绝码）**本轮没有做** ——
  那需要一次真实派工/改约动作，会碰真实工单。**不制造**。
- 现有 7 个 scene 中，只有 `progress_link` 在白名单内；其余 6 个**即使被触发也会被闸 0 拒绝**，
  拒绝记录会写进 `sms_logs`（`error_code=SMS_SCENE_NOT_ALLOWED`），可审计。

---

## 3. 旧队列隔离与 T0 边界

### 3.1 上线前队列快照（15:32）

| 项 | 值 |
|---|---|
| `sms_logs` 总数 | **794** |
| `send_status='pending'` | **0** |
| `send_status='error'` | **0** |
| 真实发送（`provider=smsbao` 且 `sent_at` 非空） | **0** |

### 3.2 T0 边界靠什么保证

| 通道 | 捞取条件 | 能否越过 T0 |
|---|---|---|
| 首发（flush） | 本次 enqueue 的行 | 只处理**新**行 ✅ |
| 重试（retry） | `send_status='error'` 且 `retry_count < limit` | 当前 **error=0**，捞不到 ✅ |
| 恢复（recovery） | `send_status='pending'` 且**超龄** | 当前 **pending=0**，捞不到 ✅ |
| 进程内 `retryQueue` | 内存数组 | 本轮重启已清空 ✅ |

⇒ **T0 之前不存在任何可被重放的记录**。这道边界不是靠代码里的时间戳，而是靠
"历史行全部落在 rejected，而两条自动通道都不看 rejected" —— 结构上够不着。

> ⚠️ 但按 §七 要求：**正式启用前必须再做一次新的队列快照**。本快照只代表 15:32。

---

## 4–6. 内部号码实发 / 手机接收 / H5 链接验证

**全部未执行 —— 阻断。**

原因（三个独立阻断，任何一个都足以停）：

| # | 阻断 | 事实 |
|---|---|---|
| 1 | **无凭据** | `SMSBAO_*` 0/4，provider 会返回 `SMS_MISCONFIGURED`，**请求根本到不了短信宝** |
| 2 | **无测试号码** | 执行令要求"用户或授权测试人员通过安全渠道提供"，本轮未收到 |
| 3 | 模板/签名审核状态 | 你已确认通过；我**无法自证**（无后台访问） |

按 §八 明文："测试号码缺失、收件人限制无法保证或平台鉴权失败时，**在此停止**，不进入生产自动发送。"

⇒ 停在这里。**没有给任何真实客户号码发过短信。**

---

## 7. 短信宝平台响应与实际计费

**无数据**（未发送）。

计费口径已知（上一轮核实）：92 字 = 2 个计费段。但**没有一次真实调用**，
所以"平台是否按 2 段扣费"仍属**未验证**，不写入 PASS。

---

## 8. 正式启用时间 T0

**未设定** —— 在六关未过前不允许启用。

---

## 9–11. 生产新工单通知验证 / 重复发送防护 / 停发回退

均**未执行**（未启用）。

其中「停发回退」已具备条件，写在这里备查：

```bash
# 一键停发（按实际缓存实现，DB 优先于 env）
docker exec scqf-as-postgres psql -U scqf_as -d scqf_aftersales_candidate \
  -c "update service_settings set value='false', updated_at=now() where key='sms.enabled'"
# 配置有进程内缓存 ⇒ 必须重启本项目应用，改 DB 不会立刻生效
docker restart scqf-as-app
# 验证：等一笔新工单，其 sms_logs 应为 rejected / SMS_DISABLED
```

> 禁止用删 `sms_logs` / 删工单 / 恢复旧快照来回滚 —— 已在执行令 §十一 明确。

---

## 12. 数据、构建及既有站点健康

### 12.1 上线前快照（§三，15:28:50 CST）

| 项 | 值 |
|---|---|
| 时间戳 | 2026-10-22 15:28:50 CST |
| DB 快照 | `db-before-sms03.dump` **3,779,908 B**（含 496 张工单） |
| 插件备份 | `plugin.tgz` **2,290,520 B** |
| 配置备份 | `env.prod.bak` 501 B、`vhost.conf` 10,595 B |
| 目录 | `/opt/scqf-aftersales/backup/pre-sms03-20261022/`（全部 600） |

> **不会用这个快照去覆盖线上**：它只是回退锚点。上线后新增的真实工单不会被删。

### 12.2 本轮变更

| 文件 | 改动 | 回退方式 |
|---|---|---|
| `constants.ts` | +scene 白名单常量、+错误码 | 还原 `plugin.tgz` + restart |
| `sms-service.ts` | +闸 0（约 25 行） | 同上 |
| 插件产物 | 重建并部署（1,481,971 B） | 同上 |

**未改**：短信正文、22 位 Token、`progress_update`、工单状态机、门店 ACL、其它站点、DB 数据。

### 12.3 回归

| 项 | 结果 |
|---|---|
| `/h5/report` | 200 |
| `/api/public/stores` | 200 |
| `/api/svc:health` | 200 |
| 容器 | `scqf-as-app` healthy |
| DB 计数 | 496（快照时刻） |

---

## 13. 未解决风险

| # | 风险 | 谁能解 |
|---|---|---|
| **B1** | **`SMSBAO_*` 全缺** —— 一切发送的门槛 | 你（新 Key 安全交接 + 签名名） |
| **B2** | 无内部测试号码 | 你 |
| **B3** | scene 白名单缺**运行期**证据 | 需一次真实非白名单触发（我不制造）或隔离环境实测 |
| **B4** | 模板/签名审核仅有你的口头确认 | 你回贴后台截图，或授权只读子账号 |
| **B5** | 整站 nginx access_log 仍关闭 | §十 已认可改用 sms_logs + 应用指标监测，但脱敏方案仍欠 |
| **B6** | 异地备份未做（独立遗留） | 你提供 COS 桶 |
| **B7** | 密钥离线副本 | 你 |

---

## 14. 判定

- **P6-SMS-03：未达 PRODUCTION LIVE。** 六关里只走完了第三、四、七关。
- **已完成且有实质价值的一项**：**scene 允许名单上线** ——
  从"开闸等于七个场景全放开"变成"只有 progress_link 能发"，这是本轮真正的安全收益。
- 短信发送：**继续 HOLD**，`sms.enabled=false` 未动，实发 **0**。
- P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。

### 需要你两个动作才能继续

1. **把新 Key + 签名名安全落到服务器**（不要经过对话）：
   ```bash
   # 在服务器上执行，Key 不进 shell history
   read -r -p 'SMSBAO_API_KEY: ' K; printf '%s' "$K" >> /opt/scqf-aftersales/.env.prod
   ```
   或直接编辑 `/opt/scqf-aftersales/.env.prod`（600）补上 4 个变量后告诉我"已就绪"。
2. **给一个内部测试号码** + 明确"同意接收并接受计费"。

拿到这两样，我就能一次跑完关口五/六/八，并给出真实送达结论。
