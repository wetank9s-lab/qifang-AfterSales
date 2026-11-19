# P3 生产 Profile 解阻报告

> 日期：2026-10-22 · **生产 profile：PASS**
> 未迁移数据、未配证书、未写 vhost、未切 DNS、未 push。

---

## 1. 源码约束核对（只读）

### production 的 6 条硬约束（`server/profile.ts`）

| # | 约束 | 说明 |
|---|---|---|
| ① | `SMS_PROVIDER` **不能为空、不能是 `mock`** | 空值与 mock 同罪 |
| ② | **测试/诊断 action 不得注册** | 要求 404，不是"注册了但 403" |
| ③ | **测试凭据变量不得注入** | 容器内 `env` 可读即违规 |
| ④ | `SIGN_SECRET` **不能空** | |
| ⑤ | `PUBLIC_BASE_URL` **必须 https 且非 localhost** | 正则校验 + `localhost\|127.0.0.1\|0.0.0.0` 拒绝 |
| ⑥ | **回执链路**（仅当 `SMS_PROVIDER=aliyun` 时要求） | 其他 provider 不要求 |

### provider 白名单（`SMS_PROVIDER_NAME`）

```
mock / aliyun / smsbao
```

`aliyun` 会额外要求 `ALIYUN_SMS_RECEIPT_MNS_ENDPOINT` + `..._QUEUE`。
**`smsbao` 不要求回执** —— 这是本次能通过的关键。

### profile 枚举

`development` / `test` / `production` —— **无 staging**，`APP_ENV` 缺失 ⇒ 默认 **production**（fail-closed）。

### `SMS_ENABLED=false` 是否允许 production

**允许** —— 6 条约束里**没有一条检查 `SMS_ENABLED`**。

⇒ **`SMS_PROVIDER=smsbao` + `SMS_ENABLED=false` = 通过校验且不会真发**。这正是"安全分阶段"的落点。

### development 测试端点的注册条件

`plugin.ts:657` / `1371`：`if (isProduction(this.profile))` —— **非 production 才注册**。

---

## 2. 实际配置状态（不含密钥）

| 项 | 值 |
|---|---|
| `APP_ENV` | **`production`** |
| `PUBLIC_BASE_URL` | **`https://sh.scqfls.cn`** |
| `SMS_PROVIDER` | **`smsbao`**（真实服务商标识，回执非必需） |
| `SMS_ENABLED` | **`false`** |
| `DB_DATABASE` / `DB_USER` / `DB_HOST` | `scqf_aftersales` / `scqf_as` / `postgres` |
| `APP_KEY` | **64 字符，保持原值**（未输出） |
| `SIGN_SECRET` | **64 字符，保持原值**（未输出） |
| `DB_PASSWORD` | **32 字符，独立强口令**（未输出） |

`.env.prod` 权限 **600**；已备份 `.env.prod.bak-<时间戳>`（同为 600）。

---

## 3. 一个反复出现的坑（必须记下来）

**`docker-compose.prod.yml` 的 `environment:` 会覆盖 `env_file`。**

这个坑**在同一份文件里出现了两次**：

| 第一次 | `APP_ENV: production` 硬编码 → 改 `.env.prod` 无效 |
|---|---|
| 第二次 | `SMS_PROVIDER: mock` + `SMS_ENABLED: "false"` 硬编码 → 改 `.env.prod` 的 `smsbao` **无效**，应用继续报 `SMS_PROVIDER="mock"` 拒绝启动 |

**修法**：`environment:` 里只写 `${VAR}` 引用，不写值。

```yaml
environment:
  APP_ENV: ${APP_ENV}            # 不写 production
  SMS_PROVIDER: ${SMS_PROVIDER}  # 不写 mock
  SMS_ENABLED: ${SMS_ENABLED}    # 不写 "false"
```

> 教训：**配置只有一个来源**。`env_file` + `environment` 双写，等于两个真相。

---

## 4. production 启动与健康

| 项 | 结果 |
|---|---|
| 容器内 `APP_ENV` | **`production`** |
| `PROV` / `ENABLED` / `BASE` | `smsbao` / `false` / `https://sh.scqfls.cn` |
| `/api/app:getInfo` | **200** |
| healthcheck | **healthy** |
| 表数 | **129**（104 框架 + 25 插件） |
| 插件 | `@local/service-ticket` **enabled=t** |

---

## 5. 测试端点隔离（关键验证）

| 端点 | 结果 |
|---|---|
| `svc:tokenCheck` | **404** |
| `svc:smsOutbox` | **404** |
| `svc:faultInject` | **404** |
| `svc:smsRecoverySweep` | **404** |
| `svc:historicalDrillFixture` | **404** |

**正常端点不受影响**：

| 端点 | 结果 |
|---|---|
| `svc:historicalArchiveQuery` | **401 `EMPTY_TOKEN`**（需登录，正确） |
| `publicStore:entry` | **404**（空库无门店，符合预期） |

---

## 6. 短信未发送

| 项 | 值 |
|---|---|
| `sms_logs` | **0** |
| `SMS_ENABLED` | **false** |
| 真实服务商凭据 | **未配置**（`smsbao` 仅作为标识通过校验，实际不会调用） |

---

## 7. 初始化凭据处理

| 位置 | 残留 |
|---|---|
| `docker-compose.prod.yml` | **0** |
| `.env.prod` | **0** |
| 容器内 `env` | **0** |

首次安装时 `INIT_ROOT_*` 是**命令行临时注入**（`up -d` 时带的环境变量），**未写入任何文件**；重建后已自然消失。

---

## 8. 其他站点健康

| 域名 | 基线 | 现在 |
|---|---|---|
| `hd.scqfls.cn` | 200 | **200** ✅ |
| `cloud.scqfls.cn` | 403 | **403** ✅ |
| `sd.scqfls.cn` | 000 | **000** ✅ |
| `kanma.cloud` | 000 | **000** ✅ |
| `nginx -t` | successful | **successful** ✅ |

**Nginx 未修改、未 reload；DNS 未动。**

---

## 9. 未解决 / PENDING

| # | 项 |
|---|---|
| 1 | **镜像 `RepoDigests` 仍为空**（save/load 后无 registry digest）。已记录：`ImageID=sha256:dc9f54b7…`、`Created=2026-09-19T06:03:25Z`、**归档 sha256=`c39a49df933cf11d9876f3b2…`**。**不把 ImageID 冒称为 digest**。 |
| 2 | **`SMS_PROVIDER=smsbao` 但无凭据** —— 生产若真要发短信，需补 `SMSBAO_*` 凭据并置 `SMS_ENABLED=true`（**等单独授权**） |
| 3 | 插件挂载仍为**可写**（`pm enable` 需要）；建议生产稳定后改回 `:ro` 并验证 |

---

## 10. APP_KEY 终端暴露处置

**事实**：上一轮我用 `docker compose config | grep -A1 APP_ENV` 时，插值后的 `APP_KEY` 被打印到终端。

**核查结论**：

| 项 | 判断 |
|---|---|
| 是否写入报告/记忆/Git | **否** |
| 是否写入服务器文件 | **否**（只出现在那次 stdout） |
| 暴露面 | **本机终端输出**（本次会话的工具日志），非公网、非其他用户可读 |
| 是否需要轮换 | **暂不建议** —— 它是既有加密字段的主密钥，轮换需重新加密全库 |

**建议**：若你对本机终端日志的留存有顾虑，我可以出一份**「APP_KEY 轮换 + 存量字段重加密」方案**（含回滚），但那属于 P4 之后的独立工作。

---

## 11. Git 状态

**本轮零代码改动**（只改了服务器上的 `.env.prod` 与 `docker-compose.prod.yml`，两者都在服务器、不入 Git）。

```
本地 main: 9a57997（== origin/main，未推未改）
```

---

## 12. 判定

| 项 | 结论 |
|---|---|
| 源码约束核对 | **PASS** |
| production 配置就绪 | **PASS** |
| production 启动 | **PASS** |
| 测试端点隔离 | **PASS**（5/5 → 404） |
| 短信未发送 | **PASS** |
| 初始化凭据清理 | **PASS**（0 残留） |
| 其他站点健康 | **PASS**（全部与基线一致） |
| 镜像 digest | **PENDING** |
| **P3 生产 profile** | **PASS** |

**P4 数据迁移 / P5 证书 / P6 切流：继续等单独授权。Release 继续 HOLD。**
