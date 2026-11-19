# P6-SMS-03 短信宝正式上线验收报告（R2）

> 时间：2026-10-22 15:36–15:48（CST）
> 本轮完成：第一关（配置核验 + 修正一处回归）、第二关（provider/凭据预检）、第三关（队列）、第四关（模板/链接回归）
> 本轮阻断：**第五关起** —— `SMSBAO_SIGN_NAME` 缺失 ⇒ `configured=false`；且无内部测试号码
> 判定：**未达 PRODUCTION LIVE**；申请状态 **READY FOR SINGLE-SMS TEST（差 1 个变量 + 1 个号码）**
> 实发 **0**，`sms.enabled=false` 未动。

---

## 0. 先说一个我自己造成并已修复的回归（必须披露）

我按"配置已更新"重建了 app 容器。重建后实测：

```
SMS_PROVIDER  SET len=0
SMS_ENABLED   SET len=0
```

**根因**：compose 的 `environment:` 里写着

```yaml
SMS_PROVIDER: ${SMS_PROVIDER}
SMS_ENABLED: ${SMS_ENABLED}
```

`${VAR}` 是 **compose CLI 的变量插值**，它从「项目级 `.env` 或 shell 环境」解析，
**不是**从 `env_file: .env.prod` 解析。本项目没有 `.env` ⇒ 插值成空字符串 ⇒
再用空值**覆盖**了 `env_file` 提供的 `smsbao` / `false`。

> 这正是本项目记录过的"`environment` 覆盖 `env_file`"同一个坑的**第三个变体**：
> 第一次是写字面量 `APP_ENV: production`，第二次是 `SMS_PROVIDER: mock`，
> 这次是**写插值但解析不到**。三种写法都会覆盖，只有"**不写**"才安全。

**修复**：删掉这两行（`env_file` 是唯一来源），重建 app，实测恢复：

```
SMS_PROVIDER  SET len=6   ← smsbao
SMS_ENABLED   SET len=5   ← false
```

备份：`backup/pre-sms03-20261022/compose-before-fix.yml`。
**只重建了 app 一个服务**，postgres 容器与数据卷未动，未重启 Docker daemon。

---

## 1. 四项配置 SET / MISSING（不含任何值）

| 变量 | `.env.prod` | 容器内 | 长度 |
|---|---|---|---|
| `SMSBAO_USERNAME` | **SET** | **SET** | 6 |
| `SMSBAO_API_KEY` | **SET** | **SET** | 32 |
| `SMSBAO_SIGN_NAME` | **ABSENT** | **MISSING** | — |
| `SMSBAO_PRODUCT_ID` | ABSENT | MISSING | — |

- `.env.prod` 权限：**600 root:root** ✅
- 无重复定义、无拼错变量名（`grep` 全表只有 1 次定义）✅
- compose 中 SMS 字面量：**0 处**（不硬编码 mock）✅
- `env_file: .env.prod` 声明在第 29 行 ✅

---

## 2. 运行时 provider 与 configured 状态

| 项 | 值 |
|---|---|
| DB `sms.provider` | **smsbao** |
| DB `sms.enabled` | **false** |
| DB `sms.retry_count` | 1 |
| 容器 `SMS_PROVIDER` | **smsbao**（len=6） |
| 容器 `SMS_ENABLED` | **false**（len=5） |
| **`SmsbaoProvider.configured`** | **false** |

**为什么 configured=false**：源码 `get configured()` 要求 **用户名 + ApiKey + 签名名三者齐备**：

```ts
return Boolean(this.username && this.apiKey && this.signName);
```

`SMSBAO_SIGN_NAME` 为空 ⇒ 第三项不成立。
（`PRODUCT_ID` 不参与该判断，属可选。）

### 2.1 只读认证预检 —— **通过**

调用短信宝官方余额查询接口（**只读，不发送**）：

```
返回码: 0
判定: 凭据有效（账户可查询）
```

⚠️ **这只证明"账号 + ApiKey 有效、可查询"，不等于"能发短信"，更不等于"手机能收到"。**

---

## 3. 历史队列实时状态（15:44 查询，非引用旧计数）

| 状态 | 数量 |
|---|---|
| `pending` | **0** |
| `error` | **0** |
| `rejected` | 472 |
| `accepted` | 322（**全部 mock**） |
| **真实发送**（`provider=smsbao` 且 `sent_at` 非空） | **0** |
| 合计 | **794** |

- 未知发送结果：**0**（无 `pending`、无 `error`）
- 开启后会被重试/恢复处理的历史消息：**0**
  （重试只捞 `error`、恢复只捞超龄 `pending`，两者当前都是 0）
- 内存中的旧重试任务：**0**（本轮 app 重建两次，`retryQueue` 必清空）
- 历史 mock 记录不会被重发：**成立**（`send_status` 为 accepted/rejected，两条通道都不看）
- T0 之前不会批量补发：**成立**（同上，结构性够不着，不依赖时间戳）

---

## 4. scene 白名单验证范围

| 项 | 值 |
|---|---|
| 常量 | `SMS_PRODUCTION_ALLOWED_SCENES = ['progress_link']` |
| 产物命中 | `SMS_SCENE_NOT_ALLOWED` **3 次**、`progress_link` **2 次** |
| 产物 mtime | 2026-10-22 15:28:42 |
| 闸位 | `deliverOne()` 内，**在 `enabled` 闸之前** |

**覆盖范围（静态推理，可信）**：`deliverOne` 是唯一首发漏斗；`provider.send` 全仓只有 1 个调用点
（`safeSend`），其三个上游中，重试只处理 `error` 行、恢复只处理 `pending` 行 ——
两者都是**已通过过 `deliverOne` 的行** ⇒ 闸 0 天然覆盖全链。

**⚠️ 运行期证据仍缺**：本轮**没有**真实触发过非白名单 scene（需要一次真实派工/改约，会碰真实工单，我不制造）。
所以这一项是**代码 + 产物级证据，运行期待补证**。报告不写成"已验证生效"。

---

## 5. 模板与 Token 回归（合成数据，未发送）

### 5.1 模板原文（冻结，未改）

```
【四川恒晟恒七方】您的售后申请已提交成功，工单号{ticket_no}。查看处理进度：https://sh.scqfls.cn/p/{token}
```

代码侧：`【{sign}】…{ticket_no}…https://sh.scqfls.cn/p/{token}`，
`sign` 由 `SMSBAO_SIGN_NAME` 注入；`decorateSmsbaoSign` 对带【】的值**原样返回**，不会重复加签名。

### 5.2 Token 与链接

| 用例 | 结果 |
|---|---|
| `/p/<22 位>` | **302** ✅ |
| `/p/<43 位>` | **302** ✅（旧链接兼容） |
| 跟随 22 位 | **200 / 987 B / `<title>服务报修…</title>`** ✅ |
| 无效 token | 404 或 H5 显示"链接无效、已过期或已被撤销"，无客户数据 ✅ |
| Token 进访问日志 | 本站 `access_log off`，上一轮实测新增 0 命中 ✅ |

### 5.3 长度与计费

- 固定正文 **55** + 工单号 **15** + token **22** = **92 字** ⇒ **2 个计费段**（你已接受）。
- 一次通知**只调用一次** `provider.send`（全仓唯一调用点，`deliverOne` 内可能因传输层错误重试，
  但那是"同一次提交的重试"，不是拆成两条）。**不存在把一次通知拆成两次发送的逻辑。**

---

## 6. 内部单号码真实发送结果

**未执行。** 两个独立阻断：

| # | 阻断 |
|---|---|
| 1 | `configured=false`（缺 `SMSBAO_SIGN_NAME`）⇒ 请求会在本地被 `SMS_MISCONFIGURED` 拒绝，**到不了短信宝** |
| 2 | 未收到内部测试号码（执行令要求安全渠道提供） |

未向任何真实客户号码发送测试内容；未群发；未重复测试。

---

## 7–8. 手机实收 / 实际计费段数

**无数据**（未发送）。计费 2 段目前仍是**按规则推算**，不是实测。

---

## 9. 正式启用时间 T0

**未设定。** 六关未过，不允许启用。

---

## 10. 首批真实通知观察

**未开始**（未启用）。

---

## 11. 停发与回退

已具备并写入报告，本轮**未触发**：

```bash
# 停发（DB 优先于 env；配置有进程内缓存 ⇒ 必须重启应用才生效）
docker exec scqf-as-postgres psql -U scqf_as -d scqf_aftersales_candidate \
  -c "update service_settings set value='false', updated_at=now() where key='sms.enabled'"
docker restart scqf-as-app
# 验证：等一笔新工单，其 sms_logs 应为 rejected / SMS_DISABLED
```

禁止用删 `sms_logs` / 删工单 / 恢复旧快照回滚（执行令 §八 明确）。

---

## 12. 未完成项及原因

| # | 事项 | 原因 | 谁能解 |
|---|---|---|---|
| **B1** | `SMSBAO_SIGN_NAME` 空 | 用户未填 | **你**：加一行 `SMSBAO_SIGN_NAME=【四川恒晟恒七方】`（带括号或不带都可，代码会规范化） |
| B2 | `SMSBAO_PRODUCT_ID` | 可选，取决于账户是否用专用通道产品 | 你确认 |
| **B3** | 内部测试号码 | 未提供 | **你** |
| B4 | 闸 0 运行期取证 | 需真实非白名单触发 | 隔离环境实测或授权触发 |
| B5 | 模板/签名平台审核 | 仅你的口头确认，我无法自证 | 你回贴后台截图 |
| B6 | 异地备份（独立遗留） | 缺 COS 桶 | 你 |

---

## 13. 判定

- **P6-SMS-03：未达 PRODUCTION LIVE。**
- 状态：**READY FOR SINGLE-SMS TEST，差 1 个变量（`SMSBAO_SIGN_NAME`）+ 1 个内部号码。**
- 已完成：配置核验（含修正 compose 覆盖回归）、凭据有效性（账户查询 code=0）、
  队列安全检查（pending/error 双 0）、白名单产物级确认、模板与链接回归。
- 实发 **0**；`sms.enabled=false` 未动。
- **不把"配置成功"写成"送达成功"，不把"接口返回 0"写成"手机收到"。**
- P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。
