# TECH-H5-PLUGIN-CONTRACT-01：H5 / 插件契约差异报告

> 时间：2026-10-23 10:55–11:20 CST
> 结论：**Case D** —— 两个 action **都存在且工作**，缺的只是 **nginx 外部路径映射**。
> 无需改代码、无需重建、无需重启。本轮按令**未部署**。

---

## 1. 生产 H5 产物

| 项 | 值 |
|---|---|
| 入口 | `/h5/index.html`（引用 `assets/index-C9qJaSHE.js` + `assets/index-BUMs9pEX.css`） |
| JS | **`index-C9qJaSHE.js`**，162,912 B |
| JS SHA-256 | **`9f05f890d9ad2cd8c3a540f0ee82bc85`**（实测，取自生产响应体） |
| 构建元数据 | **BUILD PROVENANCE UNKNOWN** —— 产物内无可验证 git revision，`index.html` 无 build id |
| H5 师傅路径基址 | `/api/technician/visits`（`BASE_PATH`） |

> 没有凭文件名猜 commit。H5 源码与产物的对应关系**当前不可证**。

---

## 2. 生产插件产物

| 项 | 值 |
|---|---|
| 路径 | `/opt/scqf-aftersales/src/storage/plugins/@local/service-ticket/dist/server/index.js`（`@local/service-ticket`） |
| 大小 | **1,483,540 B** |
| SHA-256 | **`288523d776e0a983d2ce70eee57d8164…`** |
| 含 `technicianVisit:media` | **1 处** |
| 含 `DELETE_PHOTO` | **5 处** |

⇒ **产物里带着这两个能力**，不是"源码有、dist 没有"。

---

## 3. 六条接口契约矩阵

| # | H5 实际请求 | 内部 action | 已注册 | Nginx 映射 | 实测 |
|---|---|---|---|---|---|
| **A** | `GET /api/technician/visits/:token` | `technicianVisit:get` | ✅ | ✅（已加） | **200**，`FW20261022-0007` |
| **B** | `POST …/:token/files` | `technicianVisit:upload` | ✅ | ✅（已加） | **PENDING**（不写生产） |
| **C** | `POST …/:token/submit` | `technicianVisit:submit` | ✅ | ✅（已加） | **PENDING**（不写） |
| **D** | `GET …/:token/photos/:ref` | `technicianVisit:photo` | ✅ | ✅（已加） | 路径通；真实 ref 未持有 → 功能 PENDING |
| **E** | `GET …/:token/media/:ref` | **`technicianVisit:media`** | ✅ | **❌** | **内部 200**（`audio/webm` 71,040 B）；外部 404 |
| **F** | `POST …/:token/photos/:ref/delete` | **`technicianVisit:deletePhoto`** | ✅ | **❌** | **内部 404 + `PHOTO_NOT_FOUND`**（业务错 ⇒ action 在） |

**ref 格式**：两者都是 `^[A-Za-z0-9_-]{22}$`（`PHOTO_REF_PATTERN`），但**候选集不同**：
`:photo` = 师傅本人照片；`:media` = **本工单**的客户媒体 ⇒ ref **不能互换**
（上一轮我用 `:photo` 测客户 ref 得 404，正是这个原因）。

---

## 4. media 缺失的真实原因

**不是缺功能，是缺映射**：

```
GET /api/technicianVisit:media?token=<T>&ref=<有效ref>  → 200  audio/webm  71,040 B
GET /api/technicianVisit:media?token=<T>&ref=<无效ref>  → 404
GET /api/technician/visits/<T>/media/<ref>             → 404  ← H5 走这条，无映射
```

那 71,040 B 的 `audio/webm` **就是页面里那条 0:05 的客户录音**。

## 5. deletePhoto 缺失的真实原因

同样只是缺映射。用**假 ref** POST 到内部 action（**不删任何真实照片**）：

```
POST /api/technicianVisit:deletePhoto?token=<T>&ref=<假ref>
→ 404  {"errors":[{"code":"PHOTO_NOT_FOUND","message":"照片不存在…"}]}
```

这是**业务级 404（JSON）**，与"不存在的 action"返回的**纯文本 404** 可区分 ⇒ action 已注册且在校验。

---

## 6. 客户媒体授权边界（源码口径）

- 候选集 = **本工单**客户媒体，边界由 `service_visits.ticket_id` 决定；
- ref 由「媒体 id + 本 Visit tokenHash」派生 ⇒ 换单算不出同一 ref；
- 撤销/失效 Visit ⇒ token 校验先失败（同一套 `withTechnicianAuth`）；
- 媒体保持私有：不公开目录、不复用 `/files/`、不取消 `readBound`。

> 以上为源码与既有实现口径，**本轮未做越权实测**（无隔离师傅单）→ PENDING。

---

## 7. 删除安全模型（源码口径）

- 仅允许**回执提交之前**删除（提交后 Token 失效 ⇒ 天然拒绝）；
- 只能删本人本次上门上传的照片，删不了客户媒体、删不了别单；
- 与既有存储/数据库生命周期一致；真实删除**未测**（需隔离实例）。

---

## 8. 是否需要新增 action / Nginx

| 项 | 结论 |
|---|---|
| 新增 action | **不需要**（产物已有） |
| 重建 / 重启插件 | **不需要** |
| Nginx 映射 | **需要，且仅这两条** |

---

## 9. 最小修复 diff（待批，未执行）

```diff
  location / {
      rewrite ".../visits/([A-Za-z0-9_-]{43})/photos/([A-Za-z0-9_-]{22})$" ...:photo?token=$1&ref=$2? break;
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/photos/([A-Za-z0-9_-]{22})/delete$" /api/technicianVisit:deletePhoto?token=$1&ref=$2? break;
+     rewrite "^/api/technician/visits/([A-Za-z0-9_-]{43})/media/([A-Za-z0-9_-]{22})$"        /api/technicianVisit:media?token=$1&ref=$2?       break;
      rewrite ".../visits/([A-Za-z0-9_-]{43})/files$"  ...:upload?token=$1? break;
      ...
  }
```

- **顺序**：`photos/:ref/delete` 必须排在 `photos/:ref` **之前**（否则被短规则吃掉）；
- 末尾 `?` 抑制原 query；只放行 43 位 token + 22 位 ref；
- 不改 MIME/Range/缓存（沿用 action），不动上传上限与 ACL。

---

## 10. 隔离环境验收计划

1. 有效师傅读本单客户媒体 → 200 + 正确 MIME；
2. Range 请求 → 206；
3. 他单媒体 ref → 404；
4. 撤销 Visit token → 拒绝；
5. 本人照片删除 → 成功、计数减一；
6. 他单照片删除 → 拒绝；
7. 用客户媒体 ref 走删除 → 拒绝；
8. 重复删除 → `PHOTO_NOT_FOUND`；
9. 320/390px 页面可实际播放与删除。

---

## 11. 生产纪律

| 项 | 状态 |
|---|---|
| 工单写入 / 客户媒体上传 / 照片删除 / 提交 | **0 / 0 / 0 / 0** |
| 短信 / 数据库修改 | 0 / 0 |
| Nginx 修改 | **本轮无**（上一轮 4 条已在前） |
| 插件重建 / 重启 NocoBase | **无** |
| Token / ref | 全部 `<T>` / `<ref>` 脱敏 |
| Git | **未 commit / 未 push** |

---

## 12. 申请

- **TECH-H5-PLUGIN-CONTRACT-01：根因核查 PASS**（Case D，证据：内部 action 200 + 业务级 404）。
- 功能修复**未做**（按令不部署）。
- `TECH-PHONE-404-01-READ`：PASS / CLOSED。
- 真机：PENDING；files/submit 真实 POST：PENDING；客户媒体读/删授权回归：PENDING（需隔离师傅单）。

P6：LIVE / CONDITIONAL；Release：HOLD。
