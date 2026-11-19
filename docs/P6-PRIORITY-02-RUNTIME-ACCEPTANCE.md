# P6-PRIORITY-02 · 两项 P0 运行验收（未通过：BLOCKED / PENDING）

> 时间：2026-10-29 12:01–12:15
> **结论先行：P0-1 运行验收 BLOCKED，P0-2 浏览器验收 PENDING。本轮不申请任何 PASS。**
> 原因不是代码，是**没有可用的隔离运行时**；下面把尝试过程、已还原的证据、以及需要什么条件写清楚。

---

## 1. P0-1：真实接口验收 —— **BLOCKED**

### 1.1 阻塞事实（逐条可核）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 本机 Docker 未运行 | `docker ps` → `failed to connect … dockerDesktopLinuxEngine`；本地无隔离栈 |
| 2 | 远程有 3 个 UAT 容器，但**没有一个是"可写且专属"的** | `scqf-uat-inst` / `scqf-r4-uat` / `scqf-media-test-app` |
| 3 | `scqf-uat-inst` 的插件目录是 **ro 挂载** | `docker cp` → `mounted volume is marked read-only` |
| 4 | 唯一可写路径落回**共享宿主目录** | `.HostConfig.Binds`：`/opt/scqf-media-test/plugin-r4/service-ticket` → storage(**rw**) 与 node_modules(**ro**)；该目录同时服务 `scqf-r4-uat` |
| 5 | UAT 的 DB 在别的容器上 | `DB_HOST=pg-test`（网络别名），实际库在 `scqf-media-test-pg` 的 `scqf_uat_installed` |

⇒ 一旦为跑 P0-1 而替换该目录的产物，**会同时影响两个 UAT 实例**。
这不是"隔离环境"，属于超范围的连带改动，因此**停止**。

### 1.2 我做过的一次尝试与还原（必须记录）

- 12:04 尝试把新 server 产物写进 `scqf-uat-inst`；
  - 对 `node_modules` 路径：**被 ro 挂载拒绝**（rc=1），未生效；
  - 对 `storage` 路径：写成功（hash 变为 `0dc13875`），但该路径与 `node_modules` 是**同一个宿主目录** ⇒ 等于改了共享 UAT 产物。
- 12:07 **已还原**：从容器内 `/tmp/uat-srv.bak` 回写，双向核对
  `node_modules` 与 `storage` 两侧哈希均回到原始 `74c46a0926a8f8cc`；
  宿主文件 mtime 恢复为 `Oct 25 15:47`；`health=200`。
- 容器未重启（运行中的仍是原产物），未产生任何测试数据（UAT 库仍是 0 visits / 0 tickets）。

### 1.3 因此**没有**取得的证据（明确列出，避免被误读为已通过）

| 用户要求 | 状态 |
|---|---|
| 空 / 4 字 / 5 字 / 500 / 501 的真实 HTTP 结果 | ❌ 未取得 |
| 五种 service_result 各跑一遍 | ❌ 未取得 |
| service_result=null 仍要求维修措施 | ❌ 未取得 |
| 绕过 H5 直连 API 被拒 | ❌ 未取得（只有规则函数 + 调用顺序的静态证据） |
| 失败后 Visit/Ticket/Token 不变 | ❌ 未取得 |
| 成功后再用同一 Token 被判失效 | ❌ 未取得 |
| 历史 `service_note=NULL` 只读展示 | ❌ 未取得（UAT 库内无历史 Visit） |

### 1.4 已完成的替代证据（不冒充运行验收）

- `p6-note-rules.test.mjs` **18/18**（含空/全空格/4/5/500/501/五种结果/未知结果/有效字符口径），变异 5→1 时 L5/L8 变红。
- 调用顺序（静态）：`consumeQuota → parseSubmitDto（422 在此）→ 照片检查 → technicianSubmit(事务)`。

### 1.5 `consumeQuota` 的静态结论（用户特别要求）

- 实现：`guards.consume({ scene, scope: TOKEN, value: 明文 token, limit: 60, window: HOUR })`，**持久化**（有 `guard-quota` 诊断接口读同一批桶）。
- 结论：**无效维修措施会消耗该 token 的每小时配额**（成功与失败都计 1 次）。
- 影响：连续非法提交累计 60 次后，该 token 在 1 小时内收到 **429**；正常师傅基本无感，恶意/脚本刷会被限流——这本身是保护，不是缺陷。
- 最小调整方案（**未实施，待批准**）：把 `parseSubmitDto()` 移到 `consumeQuota()` **之前**。
  代价：验证是纯字符串操作（微秒级），前置不削弱抗刷能力；限流仍覆盖"通过校验后的真实提交/上传"。
  **不采用**"删掉限流"或"失败回补配额"（后者要在并发下正确回补，复杂度远大于换顺序）。
- 另一种可选：保持现状，在文档里写明"非法提交也占配额"。二选一需要裁决。

---

## 2. P0-2：真实浏览器验收 —— **PENDING**

### 2.1 已做

- 构建产物：`h5/dist`（`index-D37Itv1Z.js`，168.78 kB），本地 `vite preview` 起在 4180（base `/h5/`）。
- 用 CDP 打开 `#/report/success?...` 与 `/h5/report/success?...` 两个形态，
  期望读取两个复选框的 `checked` 与 `localStorage` 键 —— **两次都拿到 `undefined`**（页面未进入可断言状态）。
- 已停掉预览服务与浏览器，未留下进程。

### 2.2 未取得（因此不申请 PASS）

10 条浏览器验收（默认勾选 / 不触碰也落盘 / 同店自动恢复 / 跨店隔离 / 关自动进入 / 关记住 / 无循环 / 失败不覆盖 / 7 天与损坏清理 / storage 不可用）
**全部未在真机浏览器上完成**。持久层行为矩阵（14/14）仍在，但那不是运行验收。

---

## 3. 部署准备（已核对项）

| 项 | 结果 |
|---|---|
| 唯一构建源一致 | `prebuild-guard` **10 项 SAME** |
| 全量 TypeScript 新增诊断门禁 | 219 → **219**，无新增 |
| 插件产物哈希 | server `0dc13875760cd924` / client `62677303c562a33d`（与当前生产**相同** ⇒ 插件无需再发） |
| H5 产物哈希 | `h5/dist/assets/index-D37Itv1Z.js`（168.78 kB）**与生产不一致** ⇒ 若通过验收，本次真正要替换的是 **H5 静态产物** + 服务端三处规则（已在插件里） |
| P0-2 是否重复部署 | P0-2 代码 10-22 已存在；**若生产 H5 已是含 B 组的版本，则不需要为 P0-2 单独部署**（需核对生产 H5 产物哈希） |
| 不会改的东西 | 短信配置、Nginx、门店 ACL、工单状态机、历史记录 |

**本轮未申请部署、未执行任何部署。**

---

## 4. 下一步（需要你选一条，我才能继续）

| 选项 | 需要你做的事 | 我能完成的验收 |
|---|---|---|
| A. 本地隔离栈 | 启动本机 Docker Desktop（或告诉我可用的 DOCKER_HOST） | 全部 P0-1 真接口 + P0-2 真浏览器（本地 H5 + 本地 API） |
| B. 专用 UAT | 给我一个**可写且专属**的插件目录（新建一个 UAT 实例，或授权我改 `plugin-r4` 并接受影响 `scqf-r4-uat`） | 全部 P0-1 真接口 |
| C. 授权在 `scqf-uat-inst` 上临时替换并在验完立即还原 | 明确认可"验期间 `scqf-r4-uat` 也会加载新代码" | P0-1 真接口（P0-2 仍需本地浏览器） |

P0-2 的浏览器验收**不需要服务端**（成功页与恢复逻辑只依赖 localStorage + 一个 mock 的 progress 响应），
只要允许我在本机起 `vite preview` + CDP 驱动，就可以独立完成。
