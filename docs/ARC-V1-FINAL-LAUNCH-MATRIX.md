# ARC-V1 · FINAL-LAUNCH 上线矩阵（2026-11-12 终版）

> **本轮已完成**：D1 定性、D2 服务端 Action 级闸门改造、D8 限流、ARC 短信联动、隔离环境九项验证。
> **未执行任何生产写入**：未部署、未重启生产、未改生产 Nginx、未改生产库、未发真实短信。
> 证据目录：`.tmp-media/launch/`（脚本、日志、截图 `shots/`）。

---

## 一、D1 —— 两条 member 路由定性：**B 类，不删**

| 项 | 结论 |
|---|---|
| 路由 | `wcsgqh8e71w` / `0xbj56mtilr` |
| 归属 | **P11-3 / BE-02A 历史售后档案**，**不是** ARC-V1 |
| 与 ARC-V1 移动路由关系 | 无。ARC-V1 移动页是 `n5c25yq5qlt`，与这两条互不相干 |
| member × ARC | **= 0**（member 对 `serviceArchives` 的 `dataSourcesRolesResources` 行数 = 0；对 ARC 移动页授权 = 0） |
| 处理 | **不得误删**（会破坏 member 其他原有路由）。本次**不需要**任何定向清理 |

详见 `docs/D1-MEMBER-ROUTE-VERDICT.md`。

**附带登记的独立弱点（本轮不修，不阻塞）**：`svc:historicalArchiveQuery` 对 member 返回 200 但 `total=0` ——
信息级差异（能区分"接口存在"与"不存在"），不含任何数据。

---

## 二、D2 —— 两层精确放行（**已改代码，已隔离验证**）

### 2.1 改造前后

| | 改造前 | 改造后 |
|---|---|---|
| 服务端粒度 | **资源级**：`PUBLIC_ARCHIVE_ENABLED=true` ⇒ 6 个 Action 全开 | **资源级 + Action 级**：两层全开也**只**放行 `queryByMobile` |
| 只开总闸 | 6 个全开（危险） | 6 个**全 403**（`PUBLIC_ARCHIVE_ACTION_CLOSED`）—— 比旧行为更严 |
| 错误码 | 只有 `PUBLIC_ARCHIVE_DISABLED` | 新增 `PUBLIC_ARCHIVE_ACTION_CLOSED`（区分"资源没开"与"动作未批准"） |
| 白名单匹配 | — | `includes` **精确相等**（不用 `startsWith`，防 `queryByMobileV2` 被前缀放行） |

改动文件：
- `src/server/middleware/public-archive-gate.ts` —— `shouldBlockPublicArchive(resourceName, actionName, enabled, queryEnabled)`、`QUERY_ACTION_ALLOWLIST`、`PUBLIC_ARCHIVE_QUERY_ENABLED` 开关
- `src/server/plugin.ts` —— 三态启动日志 + 白名单四项启动自检

### 2.2 四档真机矩阵（UAT `p6-uat`，24/24 断言 PASS）

| 档位 | `PUBLIC_ARCHIVE_ENABLED` | `PUBLIC_ARCHIVE_QUERY_ENABLED` | 实测 |
|---|---|---|---|
| A | 未设 | 未设 | 6 条全 403 `PUBLIC_ARCHIVE_DISABLED` |
| B | `true` | 未设 | 6 条全 403 `PUBLIC_ARCHIVE_ACTION_CLOSED` |
| C | `true` | `true` | `queryByMobile` **200 + data**；其余 5 条 403 `ACTION_CLOSED` |
| D | 未设 | `true` | 6 条全 403 `PUBLIC_ARCHIVE_DISABLED`（资源级优先） |

### 2.3 Nginx 三档组合（UAT 临时 nginx，与生产同构，28/28 PASS）

| 场景 | `queryByMobile` | 其余 5 条 + `queryByMobileV2` |
|---|---|---|
| 经 nginx + 两层全开 | 200 + data | **nginx 前缀块** 403（`X-Blocked-By: nginx-prefix`，未触达应用） |
| 直连 App + 两层全开 | 200 | **应用** 403 `PUBLIC_ARCHIVE_ACTION_CLOSED`（`layer=app`） |
| GET/PUT/DELETE | nginx 403（`limit_except POST`） | — |

> **两层独立性已分别取证**：靠响应头（`X-Blocked-By` / `X-Request-Id`）判定"谁拒的"，
> 不靠 body 长度 —— 实测 nginx 403 页 **153 B** vs 应用 JSON **151 B**，只差 2 字节。

### 2.4 待执行的生产 Nginx 片段（**尚未 apply**）

在 `location ^~ /api/publicArchive: { return 403; }`（现 `sh.scqfls.cn.conf:270`）**之前**插入：

```nginx
location = /api/publicArchive:queryByMobile {
    limit_except POST { deny all; }
    proxy_pass http://127.0.0.1:13000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 10s;
    proxy_read_timeout    60s;
    proxy_send_timeout    60s;
    proxy_request_buffering off;
}
```

`location =` 优先级高于 `^~`，其余 5 条继续由第 270 行拦住。

---

## 三、客户 H5 —— 文件真身已验证

| 文件 | 字节 | SHA256 | 本地/远端 |
|---|---:|---|---|
| `h5/archive.html` | 12838 | `0939268b32edb33f97888ec10fe0bd75b2a47b3c4ef2c292b49df35ad1d9c08f` | 一致 |
| `h5/archive-render.js` | 9253 | `04d46ebac7a17d5490116f06e443e780e8115ae54fac65ab3788b2b5a27fba93` | 一致 |

**生产现状（实测）**：`/h5/archive.html` 返回 **200 但只有 987 B**，与 `/h5/` 的 `index.html` 字节数完全相同
⇒ **SPA fallback，文件根本不存在**。用户第三节的担心已被实测证实。

### 浏览器真机 6 项（Edge 406×844，真实网络，L27 全 PASS）

| 项 | 结果 |
|---|---|
| 页面真实加载（12838 B，含 `#pageTitle`/`#mobileInput`） | PASS |
| 无购买门店选择（0 个 `select`）、无验证码 | PASS |
| 发出 `POST /api/publicArchive:queryByMobile`，号码在 body | PASS |
| **手机号不进 URL**（页面 URL 与全部请求 URL 均无） | PASS |
| 同号跨店自动分组（新都圣大家电 + 金堂华林电器） | PASS |
| draft / voided 不可见；published 可见 | PASS |
| 空号显示「未查询到可展示的服务档案」 | PASS |

截图（按字节数+哈希区分）：
- `shots/h5-01-initial.png` 35484 B / `f5f3f29b4c97712a`
- `shots/h5-02-result.png` 31570 B / `af11a6f9c1848b42`
- `shots/h5-03-empty.png` 17558 B / `5b260e94ce3cc557`
- `shots/h5-04-ratelimited.png` 37528 B / `933dff5be76b0d0f`

---

## 四、D8 —— 匿名查询限流与投影

### 4.1 限流（L25，8/8 PASS）

用**不同真实源 IP**（127.0.0.2/.3/.4/.5）验证，避免"全落 127.0.0.1 同桶"的假象：

| 场景 | 结果 |
|---|---|
| 源 IP 127.0.0.2 × 4 次 | `200 200 200 429` |
| 源 IP 127.0.0.3 × 4 次（另一桶） | `200 200 200 429` |
| IP 桶已满，换新号 | `429 429`（IP 维度独立） |
| 号桶已满，换新 IP | `429`（号维度独立） |
| 新 IP + 新号 | `200` |

- 计数落 `api_guards`（`scene=archive_query`，`scope=ip|mobile`，`guard_key=sha256(值+SIGN_SECRET)`），**跨实例共享**；
- 缺依赖 fail-closed（503 `ARCHIVE_QUERY_UNAVAILABLE`）；
- `Retry-After` + `Cache-Control: no-store` 实测在位。

### 4.2 本轮修掉的一个真实缺陷：`detail.limit` 语义错位

修复前响应：`{"limit":60,"retry_after_seconds":59}` —— `limit` 传成了 `windowSeconds`。
字段名叫 `limit`（**次数上限**）却给 **60**，与真实 3 次差 20 倍。

修复后：`{"reason":"ip","limit":3,"window_seconds":60,"retry_after_seconds":60}`
（按触发维度取各自上限，窗口长度独立成 `window_seconds`）

自证：`scripts/verify-arc-ratelimit-contract.mjs` —— **15/15 PASS**，含变异（改回 `windowSeconds` 后 A3/A4 变红）。

### 4.3 X-Real-IP 不可伪造（L24 取证）

`guard_key = c0ba6f929cec5f1a == sha256("127.0.0.1" + SIGN_SECRET)`。
伪造 `X-Real-IP: 10.238.54.159` / `10.177.172.81` ⇒ 全部落回 `127.0.0.1` 的桶
（nginx `proxy_set_header X-Real-IP $remote_addr` 覆写生效）。

### 4.4 匿名投影（实测键集合）

```json
{"data":{"mobile_masked":"139****9001","groups":[
  {"store_id":1,"store_name":"新都圣大家电","archives":[
    {"archive_type":"hvac","archive_type_label":"暖通工程","progress":"completed","progress_label":"已完成"}]},
  {"store_id":4,"store_name":"金堂华林电器","archives":[...]}]},"total":2}
```
每 archive **恰 4 键**；无 `archive_no` / 姓名 / 完整手机号 / 地址 / 照片 / 详细业务信息。

### 4.5 发布风险记录（保留）

> **手机号并非身份凭证。** 该入口允许"输入一个号码即看到它在哪些门店有已发布档案"，
> 存在**服务关联推断**风险。补偿措施：最小摘要（4 字段）+ 双维限流（3 次/60 秒）+ `no-store`。
> 用户已接受该限定业务方案。**不得扩大匿名投影。**

---

## 五、ARC 短信 —— 联动完成，实际发送仍 OFF

| 项 | 结论 |
|---|---|
| 独立场景开关 | 复用既有 `sms.scene.archive_verify.enabled`，默认值改为 **false**（`SMS_SCENE_DEFAULT_OFF` + `isSceneEnabledByDefault()`） |
| 为什么不新建第二套键 | 否则运维看到 A 开、系统按 B 判 |
| 模板审核闸 | `archive_verify` 在 `SMS_REVIEW_PENDING_SCENES` ⇒ 非 mock 通道必拒，落 `SMS_TEMPLATE_PENDING_REVIEW`；**开关打开也绕不过** |
| 六道闸顺序 | `!enabled` → `sceneEnabled===false` → 模板 CODE 缺失 → 正文空 → 未替换变量 → 待审核（仅非 mock） |
| 客户摘要查询不碰短信 | `queryByMobileSummary` 方法体（2197 字符）扫描 **0 命中** |
| 既有 8 场景 | 默认仍 **true**，未受影响 |

自证：`scripts/verify-arc-sms-linkage.mjs` —— **17/17 PASS**，含变异（默认值改回全 true ⇒ ARC 变会发）。

> ⚠️ **不得以 `SMS_ENABLED=false` 作为关闭依据** —— 生产总闸 `sms.enabled=true`。
> ARC 的关闭由**场景默认值 + 模板审核闸**双重保证。

---

## 六、生产变更清单（**待批准，未执行**）

> 旧版本文档标注"不修改 `dist/*`"—— **该条件已不成立**（新增了服务端 Action 级闸门）。
> 旧 SHA256 清单全部作废。

### 6.1 实际变化

| # | 文件/配置 | 变化 | 新值 |
|---|---|---|---|
| 1 | `dist/server/index.js` | 改（Action 级闸门 + `detail.limit` 修复） | `bb041fa6aab645198c90c72f3993cefa5fe62d370f2174d4e5a1d415067e4a15` · 1786206 B |
| 2 | `dist/client/index.js` | 改（随构建产出） | `833c1d939313b4e968075fe889cdad59194efdf5186d5c9d7fdbc38d37374f29` |
| 3 | `dist/client-v2/index.js` | 改（随构建产出） | `a57f14a283baa6491ddada12834a9340bc13468d5d53d0dcb22fb20ccda937f5` |
| 4 | `dist/build-fingerprint.json` | 改 | `1d1f29c1e6f025f017d5508f99b730d31878e14c158c857a3c125ee3990a4d88` |
| 5 | `/www/wwwroot/sh.scqfls.cn/h5/archive.html` | **新增** | `0939268b32edb33f97888ec10fe0bd75b2a47b3c4ef2c292b49df35ad1d9c08f` · 12838 B |
| 6 | `/www/wwwroot/sh.scqfls.cn/h5/archive-render.js` | **新增** | `04d46ebac7a17d5490116f06e443e780e8115ae54fac65ab3788b2b5a27fba93` · 9253 B |
| 7 | `sh.scqfls.cn.conf` | 改（插入 `location =` 精确块） | 现 `407dbf0392…` → 变更后另记 |
| 8 | `scqf-as-app` 环境 | 新增 `PUBLIC_ARCHIVE_ENABLED=true` + `PUBLIC_ARCHIVE_QUERY_ENABLED=true` | — |
| 9 | `service_settings` | 新增 `sms.scene.archive_verify.enabled = false` | 显式写库，与代码默认值一致 |
| — | member 路由清理 | **不需要**（D1 为 B 类） | — |

源码指纹：`19bfc78819c4…`（212 文件）· 构建标记 `2026-11-12T10:40:38Z`
TypeScript 诊断：**212 条**（基线 219，无新增）

### 6.2 明确不动

`service_archives` / `service_archive_photos` / `service_tickets` 数据、
`migrations` 目录、角色、ACL、账号、生产库结构、`sms.*` 其余键、`nginx` 其他 location。
**不跑全量 seed，不清库，不删档案及照片。**

### 6.3 备份与回滚

| 对象 | 备份方式 | 回滚 |
|---|---|---|
| `dist/` 四个文件 | `cp -a dist dist.bak.<ts>`（UAT 已按此做过） | `cp -a dist.bak.<ts>/. dist/` + 重启 |
| `sh.scqfls.cn.conf` | `cp -a …conf …conf.bak.<ts>` | 恢复 + `nginx -t` + `nginx -s reload` |
| `h5/` 两个新文件 | 原本不存在 | `rm` 两个文件 |
| 容器环境变量 | 记录变更前完整 `docker inspect` 环境 | 移除两个变量 + 重启 |
| `service_settings` | 该键原本不存在 | `DELETE` 该行 |

**回滚总耗时估计**：nginx reload 秒级；容器重启 ~35 s（health 200 实测 35 s）。

---

## 七、隔离环境九项验证汇总

在 UAT `p6-uat` + 临时 nginx（与生产 location 同构）完成，**未碰生产**：

| # | 要求 | 结果 |
|---|---|---|
| ① | 摘要开关 OFF 时 `queryByMobile` 不可访问 | PASS（403 `PUBLIC_ARCHIVE_DISABLED`） |
| ② | 开关 ON 后仅 `queryByMobile` 可访问 | PASS（200 + data；其余 5 条 + V2 全 403） |
| ③ | 其他 5 个 Action 被 Nginx 与服务端**分别**拒绝 | PASS（`X-Blocked-By` vs `X-Request-Id` 分别取证） |
| ④ | 绕过 Nginx 直连 App，其他 5 条仍不可匿名访问 | PASS（`PUBLIC_ARCHIVE_ACTION_CLOSED`） |
| ⑤ | H5 真正加载并正常查询 | PASS（浏览器真机，见第三节） |
| ⑥ | 前三次成功、第四次 429、60 秒窗口恢复 | PASS（`200×3 → 429`，`Retry-After=59~60`） |
| ⑦ | 多门店匹配、未发布/作废过滤、匿名投影 | PASS（2 店分组；draft+voided 全滤；恰 4 键） |
| ⑧ | ARC 短信关闭，Mock 联动原售后体系正常 | PASS（17/17 自证；默认关 + 审核闸；真实发送 0） |
| ⑨ | 原售后工单及员工端访问不受影响 | PASS（未改动任何既有路由/ACL；`publicStore:list` 仍 200） |

**未重复** ARC-V1 既有 A1–A6、B-35R 等已通过项。

---

## 八、生产发布后最小验收（真机，使用专用测试号码）

| # | 判据 | 期望 |
|---|---|---|
| A | `POST /api/publicArchive:queryByMobile`（专用号） | 200，键集合恰 4+3 |
| B | 第 4 次同 IP | 429 + `Retry-After` + `limit=3` |
| C | `sendCode`/`verify`/`list`/`detail`/`photo` 经 Nginx | 403（`server: nginx`，无 JSON） |
| D | 同 5 条直连 `127.0.0.1:13000` | 403 `PUBLIC_ARCHIVE_ACTION_CLOSED`（`X-Request-Id` 存在） |
| E | `/h5/archive.html` | 200 + **12838 B**（不是 987 B 的 SPA 壳） |
| F | `/api/publicStore:list` / `/api/app:getInfo` | 仍 200 |
| G | `sms_logs` 新增行 | 0（本入口不触发短信） |
| H | `service_archives` / `photos` / `tickets` 行数 | 与上线前一致 |
| I | 容器 `healthy` | 是 |

---

## 九、GO / NO-GO

| 结论项 | 状态 |
|---|---|
| D1 member 路由归属 | 定性完成：B 类，不删，不阻塞 |
| D2 两层闸门 | 代码已改 + 四档真机 + Nginx 组合 + 契约自证，**全部 PASS** |
| 客户 H5 | 文件真身 + 浏览器 6 项，**全部 PASS** |
| 匿名查询 + 3 次/分钟限流 | **PASS**（不同源 IP 三档） |
| ARC 短信联动 | 完成，实际发送 **OFF** |
| 生产变更清单 | 已列明（第六节），**等确认范围** |

**GO**，条件是：用户确认第六节变更范围后，在**同一窗口一次执行**。
出现隐私泄露 / member 越权 / 其他匿名接口意外开放 / 备份不可用 / 短信误发 —— **立即 STOP 并回滚**。
