# UX-MEDIA-01：客户上传媒体在售后后台无法查看 —— P0 专项修复报告

> 日期：2026-10-17 · 优先级 P0 · 前序：`docs/UX-01C-R5-REPORT.md`
> 状态：P11-5 PASS/FROZEN · P11-4 IN PROGRESS（暂停）· Phase 11 IN PROGRESS · Release HOLD · UX-01C 暂停（本单优先） · **UX-MEDIA-01 待验收裁决**
> **本轮未提交、未推送。未删除任何真实附件、未改真实工单状态、未重建关联。**

---

## 一、结论

**根因不是"播放器打不开"，而是后台从未实现"看客户媒体"这条路**：
数据库与私有文件**完好**，服务端**没有取媒体的后台端点**，客户端**没有该区块**。

现在：`hq_admin` / `hq_after_sales` / 授权门店员工可在工单详情里看到并播放**照片 / 录音 / 视频**；
`viewer` 明令不开放（403 + UI 静默）；跨店 404；未登录 401。
真实客户文件一个字节都没动，私有存储路径不下发，也没有生成任何公开 URL。

| 门禁 | 结果 |
|---|---|
| `verify-ux-media-01.mjs`（新增，三层端到端） | **57 / 0** |
| `verify-native-sensitive-fields.mjs`（新增，字段级安全） | **44 / 0** |
| `verify-plugin-load.mjs` | **82 / 0** |
| `verify-ux-01a-final.mjs` | **15 / 0** |
| `verify-store-ui-primary-action.mjs` | **65 / 0** |
| 变异测试：断开媒体权限 | **54 / 3**（viewer 三条全红） |

---

## 二、真实工单 `FW20261017-0012` 取证（**只读**）

| 项 | 事实 |
|---|---|
| 工单 | `id=6670` · 门店 **S04 金堂华林电器** · `repair` · `NEW` · 创建 `2026-10-17 09:59:46` |
| 媒体会话 | `#695` · `status=bound` · `ticket_id=6670` · `upload_count=3` · `bound_at=09:59:46` |
| 媒体 | **1 段录音 + 2 张图片；没有视频**（用户提醒"不得假设三种都有"） |
| 录音 | `#513` · `audio/webm` · 28,310 B · 1.68s |
| 图片 1 | `#514` · `image/png` · 415,942 B · 2210×738 |
| 图片 2 | `#515` · `image/jpeg` · 218,028 B · 1100×1100 |
| 私有文件 | 三个都在；大小与库**逐字节一致**；文件头 `1a45dfa3` / `89504e47` / `ffd8ff` 与 MIME 相符 |
| 归属一致性 | `media.ticket_id == session.ticket_id == 6670` ✅ |

⇒ **数据完整性无缺陷**。这条区分很重要：如果先怀疑"文件丢了"去补传/重建关联，
就会在真实客户单上做多余写操作，而问题其实在别处。

> 原始文件名在库里有 UTF-8 被按 Latin-1 解释的乱码（`ä»£é‡‘...`）。
> 本次**不展示文件名**（后台只显示"照片 N / 录音 N"），所以不影响查看；已记入 PENDING。

---

## 三、失败位置（真实浏览器证据，修复前）

CDP 以 `hq_admin` 打开 `FW20261017-0012`：

```
DOM   : hasSection=false · img=0 · audio=0 · video=0 · mediaTestids=[]
NETWORK: 200 /api/svc:timeline?filterByTk=6670
         200 /api/svc:visits?filterByTk=6670
         —— 没有任何媒体请求
接口   : svc:timeline / svc:visits 响应中 media 命中数 = 0
```

| 候选原因 | 判定 |
|---|---|
| 没有 UI | ✅ 抽屉里搜"客户提交材料/media" 0 处 |
| 接口没有媒体 | ✅ 两个接口都不回媒体；后台也没有独立媒体端点 |
| 权限拒绝 | ❌ 不是（根本没发请求） |
| 播放器/格式问题 | ❌ 不是（没有播放器） |

⇒ 这是**功能缺口**（服务端 + 客户端同时缺失），不是 UI 组件写错。

---

## 四、修复（最小面，复用既有能力）

### 服务端（新增两个受控端点）
| 端点 | 作用 |
|---|---|
| `GET /api/svc:ticketMedia?filterByTk=<ticketId>` | 元数据清单：`id/kind/mime/size/durationMs/width/height/uploadedAt`（**无** storage_key / 原名 / IP） |
| `GET /api/svc:ticketMediaFile?id=<mediaId>` | 二进制流；**复用** `shared/private-media-stream.ts`（Range 206/416 + 安全头） |

授权链（顺序固定）：登录 → `CAPABILITY.WRITE_TICKET` → `media.ticket_id == session.ticket_id == 入参` →
`assertCanAccessTicket`（门店按授权门店、总部按全量）。失败统一 404 同形。

> 为什么不用原生 `customerMedias:list`：该表含 `storage_key` / `upload_ip_hash`，
> 与 `serviceVisitPhotos` 同型风险（DEV-83 的教训）。**没有**把它加进原生白名单。

### 客户端
`ticket-drawer.tsx` 新增「客户提交的材料」区块（在「客户与问题」之后）：
照片缩略图（点击看大图）/ 录音播放器 / 视频播放器；取数走
`authenticated fetch → Blob`（`<img src>` 带不上 Authorization，且不允许公开 URL）。
加载失败**不拖垮**抽屉；`viewer` 403 时**静默不渲染**（不显示"你看不到"）。

### 权限矩阵（实测）
| 主体 | 清单 | 文件 |
|---|---|---|
| `hq_admin` / `hq_after_sales` | 200（全量范围） | 200 |
| 门店员工（本店） | 200 | 200 |
| 门店员工（跨店） | **404** | **404** |
| `viewer` | **403** | **403** |
| 未登录 | **401** | **401** |
| 不存在的媒体 id | 404 | 404 |

---

## 五、真实浏览器验收（修复后）

### 真实工单 `FW20261017-0012`
```
区块「客户提交的材料」 ✅
2 张图片：blob: 且 naturalWidth>0（解码成功） ✅
1 段录音：blob: 且 duration=1.68s ✅
点击图片 → 大图预览 712×238（原图 2210×738）✅
界面不含 customer/<id>/ 或 storage_key ✅
Network：ticketMedia 200 + 三个 ticketMediaFile 200（audio/webm、image/png、image/jpeg）✅
```
截图：`.tmp-verify/ux-media-01-real-ticket.png`

> 截图右上角的 "No permissions" 是**平台级** `environmentVariables:list` 403 的既有噪声
> （BACKLOG B-17：所有业务角色在任意后台页都会触发，与本次媒体无关）。
> 判据已因此收到**页面内容区**，不把这条 toast 当作媒体失败。

### 视频（该单没有视频 ⇒ **受控合成**）
- 视频**真实录制**：浏览器 `MediaRecorder` 录 canvas 1.5s（20,012 B，`video/webm`，EBML 头 `1a45dfa3`）。
- 走**真实匿名链路**：`POST /api/public/media/session` → `POST /api/public/media/upload` →
  `POST /api/public/tickets`（带 `X-Request-Id`），得到 `FW20261017-0015`（id 6673，门店 S01）。
- 后台播放：`<video>` blob 可播放，`duration=1.417s`，元素尺寸 320×240。
- 门店账号（S01）也能看到并播放；跨店不可见。
- 截图：`.tmp-verify/ux-media-01-synthetic-video.png`
- 用户裁决（2026-10-17）：该合成单**不作长期夹具**。门禁已改为**每次运行自建 + 跑完按 id 清理**；
  原 `FW20261017-0015` 已清理，详见 `docs/UX-MEDIA-01-CLOSURE.md`。

### viewer
打开同一工单：详情正常、**没有**「客户提交的材料」区块、**没有**"读取失败"提示（静默）。

### 5.1 门店主门禁抓到的一次**真实回归**（已修）
第一版把媒体请求 `await` 在 timeline/visits 之后才 `setState`，于是抽屉的 `loading`
多挂了约 100ms —— 这段时间 `ticket=null`，**标题显示回退值「工单 #6673」而不是工单号**。
`verify-store-ui-primary-action` ①b 直接判红（`title=「工单 #6673」期望含「FW20261017-0015」`）。

修法：timeline/visits 先落 state（标题与客户信息立刻正确），媒体**随后**补进来，
失败只影响媒体区块。实测连续采样 12 次标题全部是「工单 FW20261017-0015」（无闪回）。

> 这条值得单独写：它不是"媒体功能坏了"，而是**媒体把主体信息挡住了**。
> 如果只验"媒体能不能看"，这个回归会一直留在产品里。

---

## 六、变异测试（证明门禁有区分力）

把 `assertCapability(WRITE_TICKET)` 临时去掉后重跑：

```
❌ viewer 读清单 403 —— HTTP 200
❌ viewer 读文件 403 —— HTTP 200
❌ viewer **看不到**「客户提交的材料」
结果：54 / 3
```

还原后 **57 / 0**。⇒ "viewer 不开放"这条不是靠注释保证的。

---

## 七、顺带修掉的 A 类安全缺陷（DEV-205）

取证时打了一次原生 `serviceTickets:get`，响应里出现 **`progress_token_hash` / `_expires_at` / `_revoked_at`**
（P11-4 新增的进度 Token 三列**没登记**进 `NATIVE_READ_FIELD_DENY`）⇒ 四个业务角色的 `list/get` 都会带出哈希。

- 已补登黑名单；重启后漂移对齐把 **12 行**（4 角色 × view/list/get）fields 白名单收紧。
- 新增 `scripts/verify-native-sensitive-fields.mjs`（44 项）：四角色 × 四资源，
  `list`/`get` 都断言"敏感列一个不出现 + 业务列仍在"（后者防"收成空壳"的假修）。
- 详细复盘：`docs/DEVIATIONS.md` **DEV-205**。

---

## 八、未做 / PENDING（均为非阻断）

- **原始文件名乱码**（上传时 UTF-8 被按 Latin-1 解释）：界面不展示文件名，因此不影响本次；
  若要"下载时用原名"需单独修编码（B 类）。
- **较大视频（接近 8 MB）**的后台加载耗时 / 内存占用 / 预览稳定性未专项测量；
  当前走整文件 Blob（服务端上限 8MB/文件）。
- **Blob 释放**：每个媒体项的 `useEffect` cleanup 会 `revokeObjectURL`，抽屉 `destroyOnClose`
  ⇒ 关闭即卸载、切换工单会重新挂载并释放旧 blob；长时压测并入上一条待办。
- **真机 iOS Safari** 播放后台视频未验（后台页面本就面向桌面；H5 侧播放已在 P11-5 验过）。
- UX-01C 的短信通知 / 门店管理 / 旧描述迁移、UX-01D：按用户指令**继续暂停**。

---

## 九、Git 纪律与裁决结果

**未 commit / 未 push。** 新增文件：
`src/server/actions/svc/ticket-media.ts`、`scripts/verify-ux-media-01.mjs`、
`scripts/verify-native-sensitive-fields.mjs`，以及
`ticket-drawer.tsx` / `media-store.ts` / `constants.ts` / `plugin.ts` / `shared/svc-action.ts` 的增量修改。

**裁决（2026-10-17）**：
1. UX-MEDIA-01 **PASS / FROZEN**。
2. 合成工单**不保留** ⇒ 已按 id 清理，门禁改为每次自建/自清理。
3. DEV-205 的 12 行 fields 变更**接受**（凭据列不得下发的既有纪律）。
4. 新增整改：门禁测试数据隔离（写操作只允许命中本脚本创建的夹具）——
   见 `docs/UX-MEDIA-01-CLOSURE.md`。
