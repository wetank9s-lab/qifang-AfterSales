# P6-HOTFIX-02 · 八项问题根因定位表（第一阶段 · 只读）

> 时间：2026-10-22 16:05:29 CST
> 阶段：**只读定位完成，未做任何修改**（无源码改动、无配置改动、无部署、无写入）
> 快照：`service_tickets 501` / `ticket_events 1858` / `customer_medias 566` / `customer_media_sessions 735` / `sms_logs 799`
> 部署目录非 Git 工作区（`/opt/scqf-aftersales/src` 无 `.git`），HEAD 以本地仓库为准，部署侧只能记产物指纹。

---

## 0. 一句话总览

| # | 问题 | 定位结论 | 责任层 | 是否写生产数据 |
|---|---|---|---|---|
| 1 | 记住上一单 | **已有实现**，但语义与本次要求**不同**（现在是"勾选才存"） | 前端 | 否 |
| 2 | `kitchen_bath` 显示原值 | 进度页**直接渲染枚举原值**，未查标签表 | 前端显示层 | 否 |
| 3 | 门店服务电话 | 进度 API **根本不返回门店电话** | 服务端 + 前端 | 否（只读） |
| 4 | 提交新工单按钮 | 缺"按工单门店签发入口"的服务端能力 | 服务端（契约缺口） | 否 |
| 5 | 进度页评价 | 进度页无评价区；Review 走**独立 token** | 前端 + 契约 | 提交时写评价表 |
| 6 | Android 时长 + 50MB | 时长解析在前端；**大小被 nginx 8m 先挡** | 前端 + API + Nginx | 测试上传会写媒体 |
| 7 | 录音后布局错位 | 纯 CSS/DOM | 前端 | 否 |
| 8 | 后台 Logo 403 | `/files/` 需登录，浏览器匿名取图被拒 | Nginx + 服务端 | 否 |

---

## 1. 问题①：记住上一单

**现状（重要）**：`h5/src/utils/last-order.ts` **已存在**，是 UX-LAST-ORDER-01 的产物，契约写得很明确：

- key = `svc.lastOrder.v1.<storeCode>`，**按门店分区**；
- **默认不保存**，必须客户在成功页勾选「在此设备记住这张工单」；
- 只存工单号 / token / 门店 code / 类型 / 时间 / autoOpen，**不存姓名手机地址**；
- 自带 `autoOpen` 第二开关。

**与本次要求的差异**：

| 项 | 现状 | 执行令要求 |
|---|---|---|
| 保存时机 | **勾选才存**（opt-in） | "工单创建事务成功后保存"（默认存） |
| 期限 | 代码中**未见 7 天 TTL** | 7 天到期清理 |
| 自动恢复 | 有 autoOpen 开关（需确认落地情况） | 同门店进入自动恢复 |
| 清除入口 | 需确认 | 必须有"清除上一单" |

**最小修复**：改为"提交成功即保存 + 7 天 TTL 判据 + 进入入口时自动恢复 + 清除按钮"，保留按门店分区与"不存客户资料"。**纯前端，不写生产数据。**
**需你裁决**：默认记住 vs 保持勾选式 —— 这关系到公共手机场景的隐私（token 是 bearer 凭证）。

---

## 2. 问题②：`kitchen_bath` 显示原值

**根因**：`h5/src/pages/Customer/Progress.vue:134`

```vue
{{ [view.submitted.appliance_category, view.submitted.brand_model].filter(Boolean).join(' · ') }}
```

直接渲染**枚举原值**，没有查标签。
而映射表**早就存在**：`h5/src/utils/appliance-options.ts:18`（`kitchen_bath → 厨卫电器`）、
`plugins/service-ticket/src/shared/appliance-category.ts:40`。

**最小修复**：进度页套一层 `labelOf(value)`，未知值安全回退为原值。**前端显示层，不动数据库、不动接口。** 不写数据。

---

## 3. 问题③：门店服务电话

**根因**：进度 API 响应里**没有门店电话**。实测 `/api/public/progress/<token>` 返回：

```json
{"store_name":"新都圣大家电", "submitted":{...}, "media":[], "timeline":[...], "progress":{...}}
```

既无 `store_phone` 也无 `store_id`；页面里**只有师傅电话**（`Progress.vue:92-96` 的 `tel:`）。

**最小修复（两层）**：
1. 服务端：progress action 按 `ticket.store_id` 复用现有门店读取，返回 `store_phone`（**只读，不新增写路径**）；
2. 前端：有号码才渲染 `tel:` 链接，空/非法不渲染。
服务端用**工单归属**决定门店，**不读客户端传的 storeCode** ⇒ 改 URL 拿不到别家电话。不写数据。

---

## 4. 问题④：提交新工单按钮

**根因（契约缺口）**：新工单入口必须是**签名后的 `k`**（`signStoreEntry`），而当前 H5 拿不到"这张工单所属门店的 k"。
`publicStore:entry` 是**输入 k → 返回门店资料**，方向相反。

**最小方案（二选一，需你裁决）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | progress 响应里增加 `entry_k`（**仅在 progress token 合法时**下发，等同该门店二维码的签名） | 契约扩展，但逻辑上不越权：能看进度的人本来就该能再提交 |
| B | 新增只读 action `publicStore:entryForTicket`（凭 progress token 换 k） | 多一个接口，契约更清晰，代码更多 |

**绝不**退化成 `?store=S01` 明文参数（那是已废弃的旧入口，可被任意改写）。**不写数据。**

---

## 5. 问题⑤：进度页直接评价

**现状**：进度页**没有**评价区；评价走独立入口 `/f/<43>` + **Review Token**（与 Progress Token 是两套，生命周期不同）。

**关键约束（必须先定）**：执行令要求"不得直接把 Progress Token 当 Review Token，除非现有契约明确允许"。
要核对：`publicReview:get` 接受什么凭据、`review_token` 与 ticket 的绑定关系、是否一次性。

**最小方案（三选一，需你裁决）**：

| 方案 | 做法 |
|---|---|
| **A** | progress 响应新增 `review_ready` + `review_token`（仅在"可评价且未评价"时下发，且 token 仍由既有 review 签发服务生成） |
| B | 进度页放"去评价"按钮，跳到 `/f/<review_token>`（若页面能拿到 token） |
| C | 不改后端，仅前端展示"已完成，请用短信里的评价链接"（等于不解决） |

**会写数据**（评价表），所以必须在隔离环境先测。**先不实施，等你选。**

---

## 6. 问题⑥：Android 视频时长 + 50 MB

### 6.1 大小限制：**四层都要动，当前卡在 nginx**

| 层 | 现状 | 需要 |
|---|---|---|
| Nginx 本站 | `client_max_body_size 8m`（**实测第 27 行**） | 仅媒体上传 location 设 `60m` |
| 服务端 media upload | 需核对（`limits: { files:1, fileSize: maxSizeBytes }`） | 50 MiB |
| NocoBase 通用上传 | 需核对 | 不放大（仅媒体通道放大） |
| H5 前端 | 需核对现值 | 50 MiB + 文案「单个文件不超过 50 MB」 |

> 8m 这一层意味着：**现在超过 8MB 的视频会在 nginx 就被 413 拒掉**，前端提示可能是"上传失败"。
> 50MB 改动必须**同层同步**，只改前端等于没改。

### 6.2 时长识别

`MediaUploader.vue` 用 `loadedmetadata` 取 `duration`；Android Chrome 上该事件可能早于元数据可读，
`duration` 为 `NaN`/`Infinity` 时立刻报"读不出时长"。需：等 `durationchange`、超时兜底、
不把"暂时读不到"判成"文件损坏"，并保留时长上限校验（不得为消错而取消校验）。

**真机约束**：没有 Android 真机就只能标 **PENDING**，我不会用桌面模拟冒充。

---

## 7. 问题⑦：录音上传后布局错位

纯前端：音频卡片容器高度、播放控件尺寸、删除按钮定位、长文件名换行、窄屏溢出。
只改 `h5/src/components/MediaUploader.vue` 的模板/CSS，不动上传 API 与授权。
验收：375 / 390 / 420 三个视口 × 上传前/后/播放中/删除后。**真机布局仍属 PENDING。**

---

## 8. 问题⑧：后台 Logo 403

**实测**：

```
GET /files/main/main/attachments/3.png
→ 403, application/json, 41 字节, body 以 {"errors" 开头
```

不是 404、不是 NocoBase 加载壳 —— 是**应用层鉴权拒绝**。

**根因**：`location ^~ /files/` 反代给应用，应用要求登录态；而后台登录页/侧边栏的 logo 由浏览器**匿名**请求。

**最小修复**：只对**已声明为公开品牌资源**的那个文件开一条精确路径（精确到 `main/attachments/3.png` 或该 attachments 的公开白名单），
**绝不**把 `/files/` 整体公开、**绝不**把 `uploads-private` 映射成静态目录。

**验收反例（必须做）**：任意真实客户私有附件仍返回 401/403、媒体 `readBound` 未被绕过。

---

## 9. 本轮未做的事（明确声明）

- 未改任何源码、未改 Nginx、未构建、未部署。
- 未创建测试工单、未上传测试媒体、未发送短信。
- 未 commit / 未 push。

---

## 10. 需要你裁决的 4 个点（阻塞实施）

| # | 裁决点 | 影响 |
|---|---|---|
| 1 | 问题①「默认记住」还是「保持勾选」 | 隐私 vs 体验（token 是 bearer 凭证） |
| 2 | 问题④ 用方案 A（progress 响应下发 `entry_k`）还是 B（新 action） | 契约扩展方式 |
| 3 | 问题⑤ 评价用 A / B / C 哪个方案 | 是否要动后端与评价表 |
| 4 | 问题⑥ 有没有**真实 Android 设备**可用于真机验收 | 没有就整项标 PENDING |

裁决后我按「改 → 构建 → 备份 → nginx -t → reload → 公网回归」逐项推进，每项单独给出 diff 与验证证据。
