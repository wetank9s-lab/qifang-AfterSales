# P6-HOTFIX-02：插件启用及 50 MiB 业务边界验收报告

> 时间：2026-10-23 09:42–10:02 CST
> 结论：**PLUGIN PASS**、**业务层 50 MiB 边界 PASS**。
> **申请 `MEDIA-50M-BOUNDARY-01`：PASS。**

---

## 1. 插件启用（正式机制不可用，改用官方配置开关）

| 尝试 | 结果 |
|---|---|
| `nocobase pm:list` | **无输出**（CLI 命令加载即失败） |
| `nocobase pm:enable @local/service-ticket` | **失败**：`TypeError: callback is not a function`（`plugin-manager.loadCommands`）—— **NocoBase CLI 自身 bug**，与我们的插件无关 |
| **SQL `UPDATE applicationPlugins`** | **未使用**（按令禁止） |
| ✅ **官方预设开关** | 在 `.env.test` 增加<br>`APPEND_PRESET_BUILT_IN_PLUGINS=@local/service-ticket`<br>→ `compose up -d --force-recreate app-test` → **生效** |

**只重建了 `scqf-media-test-app`**；生产容器、daemon、Nginx 均未触碰。

### 404 是否真正消失

```
POST /api/publicMedia:session  →  HTTP 200
{"data":{"session_id":1,"session_token":"<REDACTED>","limits":{"max_file_bytes":52428800,...}}}
```

- ✅ **404 消失**，媒体 action 已注册；
- ✅ `max_file_bytes = 52,428,800`（**正好 50 MiB**，与源码常量一致）；
- 日志中 `service-ticket` 相关行 **31 条**；
- test app **healthy**。

---

## 2. 测试实例隔离（复核）

| 项 | 值 |
|---|---|
| DB | `scqf_media_test`（库清单仅 `postgres, scqf_media_test`） |
| 媒体目录 | `/opt/scqf-test-media`（非 `/www/scqf-as-media`） |
| 端口 | **仅 `127.0.0.1:13010`** |
| 短信 | `SMS_ENABLED=false` / `SMS_PROVIDER=mock` / 无任何 SMSBAO 凭据 |
| 插件产物 | 只读挂载同一份（`sha256=288523d7…`，size 1,483,540） |

---

## 3. 小文件闭环（先跑通再上大文件）

| 项 | 结果 |
|---|---|
| 会话 | 创建成功（token 43 位，**未输出明文**） |
| 上传 | **HTTP 200** |
| 响应 | `{"id":1,"kind":"video","mime":"video/mp4","size":258819,"duration_ms":4000}` |
| 测试库记录 | `1｜video｜video/mp4｜258819｜4000｜customer/2/93b97e60c2c4088a.mp4` |
| 物理文件 | `/opt/scqf-test-media/customer/2/93b97e60c2c4088a.mp4`，**258,819 B** ✅ |

---

## 4. 两个边界夹具（精确字节 + SHA-256）

| 夹具 | 目标字节 | 实际字节 | SHA-256 |
|---|---|---|---|
| `exact_50mib.mp4` | 52,428,800 | **52,428,800** ✅ | `cbb54bb29c084ae06039a1417fb37896d108f070acb7bb1526f9fdbd9a8ac4e1` |
| `over_1byte.mp4` | 52,428,801 | **52,428,801** ✅ | `08b12c0eec9de920968686b77ecc0de2b6e9d8a4468dfe3fa6026232724f7837` |

**夹具性质（必须标注）**：真实 4 秒 H.264 MP4（`ftyp/moov/mvhd/hdlr` + 真实视频轨道 + 采样表完整）
+ 精确 `free` box 补齐。**约 52.17 MB 属非编码填充**，不代表 50 MiB 全是视频编码数据。
不是随机字节、不是改扩展名、不是只改 mdat size。

> 解码能力：本机无 ffmpeg/ffprobe，**未做独立解码验证** —— 该项按令报缺口，**不计入 PASS**。
> 但服务端真实 `sniffCustomerMedia()` 对两个夹具均识别为 `video/mp4` 且 **duration 4000ms**（见 §5/§6）。

---

## 5. A：恰好 50 MiB → **接受（PASS）**

| 项 | 证据 |
|---|---|
| 会话 | 新建合法会话（token 43 位，未输出） |
| HTTP | **200** |
| 业务响应 | `{"id":2,"kind":"video","mime":"video/mp4","size":52428800,"duration_ms":4000}` |
| 测试库记录 | `2｜video｜video/mp4｜52428800｜4000｜customer/3/cbb54bb29c084ae0.mp4` |
| 物理文件 | `/opt/scqf-test-media/customer/3/cbb54bb29c084ae0.mp4`，**52,428,800 B** ✅ |
| 哈希一致 | 落盘文件名前缀 `cbb54bb29c084ae0` **= 夹具 SHA-256 前 16 位** ✅ |

⇒ **不是只看 HTTP 200**：库记录 + 物理文件 + 长度 + 哈希前缀，四者一致。

---

## 6. B：50 MiB + 1 byte → **拒绝（PASS）**

| 项 | 证据 |
|---|---|
| 会话 | 新建合法会话 |
| HTTP | **413** |
| 业务码 | **`FILE_TOO_LARGE`** |
| 文案 | 「单个文件不能超过 50MB」 |
| 拒绝阶段 | **上传阶段、业务层**（详见下） |
| 测试库 | **没有该文件的记录**（表内仍只有 id=1、id=2） |
| 媒体目录 | **仍只有 2 个文件**，无孤儿 ✅ |

### 关于 413 的来源（重要）

测试实例**前面没有 nginx**（直连 `127.0.0.1:13010`），
所以这个 **413 是业务层返回的**，不是 nginx 的 413。响应体是标准 JSON 错误（`errors[0].code`），也印证是应用层。

### 单文件上限 vs multipart 总大小

- 业务判定依据 **单文件字节数**（`limits.fileSize = 50 MiB`）；
- 生产 nginx 的 `60m` 是 **HTTP 请求体总上限**，两者口径不同、互不替代；
- 本轮 413 发生在**单文件**判定，不是请求体超限。

---

## 7. 生产零测试写入

| 项 | 值 |
|---|---|
| 生产 `customer_medias` | **580**（与测试前一致，本轮未变） |
| `scqf-as-app` | **Up 16 hours (healthy)** |
| 本轮测试写入 | **全部在 `scqf-media-test` 内**：2 条媒体记录（id=1、2）+ 2 个文件 |
| 生产 compose / Nginx / 解析器 / 上限 / ACL | 未改 |
| Docker daemon | 未重启 |

---

## 8. 清理与实例状态

- 实例 **保留**（便于复核），未销毁。
- 测试数据：`customer_medias` id=**1**（小文件）、id=**2**（50 MiB），文件 2 个 —— **按 ID 可精确清理**，暂留作证据。
- 未使用宽泛删除命令；`SAFE_DELETE_FAIL_CLOSED` 未绕过。
- 被拒的 50 MiB+1 **未产生任何残留**（这是要重点确认的一条，已确认）。

---

## 9. 验收范围（按令 §七 划分）

| 范围 | 状态 |
|---|---|
| **业务层 50 MiB** | **PASS** |
| Nginx 已观察的大请求行为 | 已记录：51 MiB → 401（非 413） |
| 生产 H5 全链路 | **未因此自动通过** |
| 独立解码验证（ffprobe） | **缺口未做**（无工具），不计 PASS |

---

## 10. 判定与申请

- **PLUGIN：PASS**
- **业务层 50 MiB 边界：PASS**
- **申请 `MEDIA-50M-BOUNDARY-01`：PASS**

| 其它项 | 状态 |
|---|---|
| ENV | PASS / FROZEN |
| MEDIA-ERROR-COPY-01 | PASS / CLOSED |
| 标准 MP4 解析 | PASS / FROZEN |
| V2/V3/V5 | TEST INVALID / PENDING |
| C6 | PARTIAL / PENDING |
| Android 原始故障 | PENDING |
| 问题⑦ 录音布局 | PENDING |
| C 组 | PARTIAL PASS |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |

**Git：未 commit / 未 push。生产零部署。**
