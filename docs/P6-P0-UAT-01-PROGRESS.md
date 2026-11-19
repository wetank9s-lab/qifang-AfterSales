# P6-P0-UAT-01 · 构建产物核查 + 专属隔离实例（进展报告）

> 时间：2026-10-29 14:02–14:12
> **结论：SHA 异常已定位并解释清楚（是我的报告错误，不是源码/构建错误）；专属 UAT 已建成但尚未完成建表，P0-1 真接口验收 PENDING；P0-2 本轮未做。**
> 未部署生产、未发短信、未改业务数据、未 commit / push。

---

## 1. 服务端 SHA「异常」的根因：**我引用了旧哈希**

### 1.1 实测（当前构建产物，不是记忆里的数字）

| 产物 | 实际 SHA（前 16） | 大小 | 构建时间 |
|---|---|---|---|
| **本次构建** server | **`bafafd3da73a5134`** | 1 536 563 B | 10-29 **11:50** |
| **本次构建** client | **`edf199f64e37778d`** | 477 009 B | 10-29 11:50 |
| **生产在跑** server | `0dc13875760cd924` | — | 10-29 10:53（UX 那次） |
| **生产在跑** client | `62677303c562a33d` | — | 10-29 10:53 |

⇒ 两者**并不相同**。我在上一份报告里写的"与生产相同"，是把 10:53 部署报告里的数字**抄了过来**，
没有重新算哈希。**这是报告错误，不是构建错误，也不是源码改错副本。**

### 1.2 新规则确实进了 bundle（不是靠搜函数名）

| 检查 | 结果 |
|---|---|
| `validateServiceNote` 出现次数 | **5** |
| `countEffectiveChars` | **4** |
| `SERVICE_NOTE_TOO_SHORT` | **1** |
| `SERVICE_NOTE_MIN_EFFECTIVE` | **3** |
| 中文字面量 `维修措施`（原始 UTF-8） | 0 —— 因为 esbuild 把中文转义成 `\uXXXX`（这不是缺失） |

### 1.3 构建源一致性

| 文件 | 工作区 vs admin-base |
|---|---|
| `server/constants.ts` | **逐字节一致** |
| `server/actions/technician/visit.ts` | **逐字节一致** |
| `server/services/visit-service.ts` | **逐字节一致** |
| `server/collections/serviceVisits.ts` | 内容一致（仅行尾 CRLF/LF 不同），两处都含「维修措施」 |
| `server/services/export-service.ts` | 同上 |

`prebuild-guard` 10 项 SAME；全量 TS 诊断 219 → 219。

### 1.4 「旧版是否仍允许 4 字」与「行为差异」

- **新版**：规则函数 `validateServiceNote()` 对 4 个有效字符返回 `SERVICE_NOTE_TOO_SHORT`
  —— 夹具 `p6-note-rules.test.mjs` **18/18**（含 4 字/5 字/空格凑长度/500/501）。
- **旧版（生产在跑的 `0dc13875`）**：该 bundle 里 **没有** `validateServiceNote` / `SERVICE_NOTE_TOO_SHORT`
  这两个符号（构建于 P6 改动之前 40 分钟），执行路径上只有 `SERVICE_NOTE_TOO_LONG`（500 上限）。
  ⇒ 旧版对 4 字**不拦截**。
- ⚠️ 诚实边界：我没有把旧 bundle 跑起来做 A/B（它依赖 NocoBase 运行时）。
  上面的差异是**符号级 + 源码 diff** 证据；**行为级 A/B 属于第 3 节要做的真接口验收**。

---

## 2. 12:04–12:07 共享 UAT 写入窗口的影响核查

| 事实 | 数值 |
|---|---|
| `scqf-uat-inst` 启动时间 | `2026-10-29T04:03:41Z` = **12:03:41 +08**（我那次 restart） |
| 该次重启时容器内文件哈希 | **`74c46a0926a8f8cc`（旧）** —— 写入新文件发生在重启**之后** |
| 之后是否再重启 | **没有**（RestartCount=0，StartedAt 未再变） |
| 写入→还原期间的文件 | 曾为 `0dc13875`（时长约 2–3 分钟），**但没有任何进程重新加载它** |
| 恢复后哈希 | 两侧（node_modules / storage）均回到 `74c46a09`；宿主 mtime 恢复 `Oct 25 15:47` |
| `scqf-r4-uat` | StartedAt `2026-10-26T03:51:15Z`，窗口内 **0 请求、0 错误**，未重启 |

**结论（不粉饰）**：
- **运行时影响为零**——两个实例在窗口内都没有重新加载该文件；`r4-uat` 甚至没有任何请求。
- **但不能说"等于没发生"**：共享目录的文件内容确实被替换过 2–3 分钟；
  若期间任一实例重启（或有人触发 reload），两个 UAT 都会加载那次写入的产物。这是真实存在的风险窗口。
- 窗口内 `scqf-uat-inst` 有 **4 条请求 / 6 行含 error 字样的日志** —— 未逐条核对内容，
  但该容器当时运行的是旧代码、且库内仍为 0 visits / 0 tickets，未见业务影响。

---

## 3. 专属隔离实例（方案 B）—— 已建成，**尚未可跑真接口**

### 3.1 资源检查（通过，内存偏紧）

| 项 | 值 |
|---|---|
| CPU / 负载 | 4 核 / load 0.08 |
| 内存 | 7.7 GiB 总，**2.9 GiB 可用**（再加一个 NocoBase 约 1–1.5 GiB，偏紧） |
| 磁盘 | 180 G，已用 34 G，**剩 147 G** |
| 端口 | 13000 / 13010 / 13097 / 13098 已用；**13099 空闲**（独占到 127.0.0.1） |
| 镜像 | `nocobase/nocobase:2.2.15-full-no-nginx`（本地已有） |
| 挂载所有权 | 新建目录 root 拥有；未触碰 `plugin-r4` / `scqf-uat-inst` |

### 3.2 已完成的隔离项

| 项 | 值 |
|---|---|
| 应用实例 | 容器 **`p6-uat`**（`127.0.0.1:13099` → 容器 `13000`），独立网络 `scqf-media-test-net` |
| 插件副本 | `/opt/scqf-p6-uat/storage/plugins/@local/service-ticket`（**独立副本**，非共享目录），内含本次构建 **`bafafd3da73a5134`** |
| 数据库 | **`scqf_p6_uat`** + 独立角色 **`p6_uat`**（新建，非 `scqf_uat_installed`）；复用现有 PG 进程 |
| 存储/媒体 | `/opt/scqf-p6-uat/uploads-private`（独立目录，未挂生产媒体） |
| 密钥 | 本实例独立 `APP_KEY`（随机 64 hex，未复用生产） |
| SMS | 未配置任何通道凭据；`delivery_status` 回执队列日志显示"缺 4 个阿里云变量"⇒ **不会发短信** |
| Nginx / daemon | 未改 / 未重启 |

已执行：`yarn nocobase install --lang=zh-CN`（Done 7.89s）→ `pm enable @local/service-ticket`（Done 13.0s）
→ 重启后 `GET /api/app:getInfo` **200**，插件日志已出现 `[@local/service-ticket]`。

### 3.3 卡在哪里（所以本轮没跑真接口）

**`service_*` 表数量 = 0** —— 插件已启用，但集合（25 张表）尚未建表。
NocoBase 2.2 的集合同步不是 `pm enable` 自动完成的，需要在实例内再执行一次集合同步/重启引导，
之后才能插入测试 Visit 并调用 `technicianVisit:submit`。

我在这里**停下**，没有继续用猜测的方式反复重启一个半成品实例。
下一步只差两步：①同步集合（`db:sync` 或再次 install 引导）；②按 `service_visits` 必填列插入
1 个 store / ticket / visit（token = `sha256(明文)`）+ 1 张 onsite 照片，然后跑第 4 节的矩阵。

---

## 4. P0-1 真接口验收：**PENDING**（未取得任何 HTTP 证据）

| 用例 | 状态 |
|---|---|
| 空 / 4 字 / 5 字 / 500 / 501 | ❌ 未执行 |
| 五种结果 + null 结果 | ❌ |
| 未知结果被枚举拒绝 | ❌ |
| 绕过前端直连 API | ❌ |
| 失败后 Visit/Ticket/事件不变、Token 可复用 | ❌ |
| 成功后 Token 失效 | ❌ |
| 历史 `service_note=NULL` 只读 | ❌（新库无历史数据，需单独造一条） |

---

## 5. P0-2 浏览器验收：本轮**未做**

上一轮用 CDP 直接打开成功页拿到 `undefined` 就被我停掉了（做法本身也不符合你的要求）。
正确做法已明确：本地 `vite preview` + CDP 网络拦截 **从报修表单提交**进入 `Success.vue`。
本轮把时间放在 SHA 溯源与专属实例上，P0-2 顺延，**不冒充已验**。

---

## 6. 限流裁决（按指令执行）

- **不调整** `consumeQuota` 顺序，保持 **60 次/小时/Token**。
- 登记现状：**非法输入也占用请求配额**（`guards.consume(scope=TOKEN)` 持久化计数）。
- 不做"把非法请求排除在限流之外"的改动（未经安全验证）。

---

## 7. 真正需要部署的文件（若后续验收通过）

| 目标 | 文件 | 现值 → 待发 |
|---|---|---|
| 插件 server | `dist/server/index.js` | `0dc13875` → **`bafafd3d`** |
| 插件 client | `dist/client/index.js` | `62677303` → **`edf199f6`**（仅字段标题改名） |
| H5 | `h5/dist/assets/index-*.js` | 生产现值需核对 → `index-D37Itv1Z.js` |

回滚依据：无 migration、无 DB 结构变更；插件整目录备份即可回退，H5 替换即可回退。

---

## 8. 下一步（按顺序，均为可执行的小步）

1. 在 `p6-uat` 内完成集合同步（一条命令），确认 `service_*` 表 25 张。
2. 造 1 组隔离数据（store / ticket / visit+token / 1 张 onsite 照片）→ 跑第 4 节 13 个用例，逐项记录
   HTTP 状态、`errors[0].code`、以及提交前后的 `service_visits / service_tickets / ticket_events / token_used_at`。
3. P0-2：本地 `vite preview` + CDP 从表单提交进入成功页，做 10 条浏览器断言 + 375/390/420 截图。
4. 两项都过 → 提交最小部署申请（插件 + H5，含回滚）。
