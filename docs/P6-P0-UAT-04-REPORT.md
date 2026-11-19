# P6-P0-UAT-04 · pm:enable 参数契约核实 + 专属 UAT 初始化成功（P0-1 未取到规则证据）

> 时间：2026-10-29 15:50–16:05
> **本轮最大进展：专属 UAT 业务层初始化成功**（27 个集合 / 25 张业务表 / 15 家门店），
> 根因就是你指出的 `filterByTk`。**但 P0-1 仍未取到规则级 422 证据**（合成 Token 被 401 拒绝），**P0-2 未做**。
> 生产零变更、共享 UAT 零触碰、未 commit / push。

---

## 1. pm:enable 的真实参数契约（读的是容器里的 2.2.15 源码，不是网上的新版文档）

文件：`@nocobase/server/lib/plugin-manager/options/resource.js`

```js
async enable(ctx, next) {
  const { filterByTk, awaitResponse: awaitResponseRaw } = ctx.action.params;   // ← 参数来自 URL，不是 body
  const keys = normalizePmPluginKeys(filterByTk);
  if (!keys.length) ctx.throw(400, "plugin name invalid");
  for (const key of keys) {
    try { assertSafePluginPackageName(key); }
    catch (error) { ctx.throw(400, "plugin name invalid"); }
  }
  const argv = ["pm", "enable", ...keys];
  if (awaitResponse) await app.runAsCLI(argv, { from: "user", throwError: true });  // ← 同步等结果、抛错
  else app.runAsCLI(argv, ...).catch(err => app.log.error(err));                    // ← 只打日志，HTTP 仍 200
  ctx.body = filterByTk;
}
```

| 问题 | 答案 |
|---|---|
| HTTP 方法 | `POST /api/pm:enable` |
| 参数来源 | **`ctx.action.params.filterByTk`**（URL query / tk），**不是** JSON body 的 `name`/`packageName` |
| `plugin name invalid` 抛出条件 | `filterByTk` 为空 / `normalizePmPluginKeys` 返回空 / `assertSafePluginPackageName` 抛错 |
| 合法格式 | 插件包名（本实例为 `@local/service-ticket`，需 URL 编码） |
| 是否 `runAsCLI` | **是**；`awaitResponse=true` 时**同步等待并把 CLI 错误抛回 HTTP**；默认（false）只打日志、HTTP 照样 200 |
| 是否需要前置注册 | 不需要额外注册；`pm:list` 里它已在列表（`enabled:false, installed:false`） |

**这就是此前所有 `plugin name invalid` 的原因**：我一直把 name 放在 body 里。
同时也解释了"为什么 CLI `--help` 报错但 enable 能跑"——`runAsCLI(["pm","enable",...])` 走的是另一条命令路径。

---

## 2. 一次正式启用：过程与结果

按指令先还原了上轮注入的 `package.json` 依赖（容器重建，天然还原）。

启用依次撞上**插件自身的三道 production 守卫**（这本身说明插件在正常工作）：

| 次序 | 错误码 | 原因 | 处理 |
|---|---|---|---|
| 1 | `SMS_PROVIDER_MOCK` | `SMS_PROVIDER=""`（空值与 mock 同罪） | 设 `SMS_PROVIDER=smsbao`（**无任何凭据**，不可能发短信） |
| 2 | `SIGN_SECRET_MISSING` | 缺签名密钥 | 为本实例生成独立 `SIGN_SECRET` |
| 3 | `PUBLIC_BASE_URL_NOT_PRODUCTION` | `http://127.0.0.1:13099` 不合规 | 设 `https://p6-uat.invalid`（仅满足格式，不解析） |
| ✔ | — | — | `POST /api/pm:enable?filterByTk=%40local%2Fservice-ticket&awaitResponse=true` → **`{"data":"@local/service-ticket"}`** |

### 2.1 启用后的客观证据

| 项 | 值 |
|---|---|
| `collections` 元数据 | **2 → 27**（25 个业务集合已注册） |
| 业务表 | `service_tickets` / `service_visits` / `service_visit_photos` / `ticket_events` … **已建** |
| 门店种子 | **15 家**（`S01 新都圣大家电`、`S02 圣大家电青白江店` …） |
| 插件文件 | `/opt/scqf-p6-uat/.../dist/server/index.js` = `bafafd3da73a5134`（待验版） |
| 应用健康 | 200 |

⚠️ `applicationPlugins` 的 LIKE 查询仍返回空 —— 又是我的引号/写法问题（同一坑第三次），
**不能再把"查不到"当作"没登记"**。登记与否以 `collections=27` + 业务表存在为准（这两项是硬证据）。

---

## 3. P0-1：合成 Token 被 401 拒绝 —— 规则级证据**未取到**

合成数据已建（隔离库）：`service_tickets` 1 条（`FW-P6UAT-0001`）、`service_visits` 1 条（`ASSIGNED`）、
`service_visit_photos` 1 条（onsite）。

但三次提交（空 / 4 字 / 5 字）**全部返回**：

```
HTTP 401  {"errors":[{"code":"TOKEN_INVALID","message":"链接无效或已失效，请联系门店重新获取"}]}
```

且 `visit_status` 仍 `ASSIGNED`、`token_used_at` 为空、`service_note` 仍 `<null>`、工单仍 `PROCESSING`
——**说明请求在认证层就被拒，根本没走到维修措施校验**。

最可能原因：我自造的 Token（`p6uat` + 22 位 hex，共 27 字符）不满足 `TokenService.verify()` 的形态/长度约束。
**下一步要做的是读 `TECHNICIAN_TOKEN` 常量与 `verify()` 的形态校验，按真实格式重造 Token**，而不是继续猜。

因此：**P0-1 = 0/13**。这是"环境能跑、凭证不对"，不是"规则没实现"。

---

## 4. P0-2：本轮未做（第四次顺延，必须说明）

本轮把全部时间用在了 UAT 初始化（这一步此前卡了四轮，且现在确实打通了）。
P0-2 的已知阻塞点已定位：`vite preview` 默认只监听 `localhost(::1)`，我上轮用 `127.0.0.1` 探测得 `000`。
正确启动方式是 `vite preview --host 127.0.0.1 --port 4180 --strictPort`。
**我不把"没跑"写成"通过"**，也不拿空白页当产品缺陷。

---

## 5. 安全边界核对

| 对象 | 本轮动作 |
|---|---|
| 生产 `scqf-as-app` / 生产库 / Nginx | 零写入（本轮连只读查询都未对生产库执行） |
| `scqf-uat-inst` / `scqf-r4-uat` / `plugin-r4` | **未触碰** |
| `p6-uat` / `scqf_p6_uat` | 容器按新 env 重建（DB 保留）；写入 1 工单 + 1 Visit + 1 照片（合成数据） |
| Docker daemon | 未重启 |
| 短信 | `SMS_PROVIDER=smsbao` 但**无任何凭据**、`sms.enabled` 默认 false ⇒ 不可能真实发送 |

回滚：`docker rm -f p6-uat` + `drop database scqf_p6_uat` 即可完全清除该实例（不影响其他对象）；
`/opt/scqf-p6-uat` 目录可直接删除。

---

## 6. 结论与下一步（按顺序，每步都很小）

| # | 动作 | 预期结果 |
|---|---|---|
| 1 | 读 `TECHNICIAN_TOKEN` 常量 + `TokenService.verify()` 的形态校验，按真实格式重造 Token | 401 → 进入业务校验 |
| 2 | 跑 13 项 P0-1（空/4/5/500/501/五种结果/null/未知/绕过/失败不变/Token 可复用/成功失效/历史 NULL） | 拿到 422/200 与库前后状态 |
| 3 | `vite preview --host 127.0.0.1` + CDP 从表单提交进入 Success，做 10 项 | 浏览器证据 |

生产仍为 server `0dc13875` / client `62677303`；待验版 `bafafd3d` / `edf199f6` 未上线。
**两项 P0 未完成前不申请部署。** Release HOLD，未 commit / push。
