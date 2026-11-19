# MEDIA-50M-BOUNDARY-01 验收收口记录

> 时间：2026-10-23 09:48–09:55 CST
> 结论：**完整哈希一致 → 「50 MiB 落盘完整性」PASS**。
> **专项归档：PASS / CLOSED**（范围严格限定为业务层单文件大小判定）。

---

## 1. 完整 SHA-256 只读补证（本轮唯一动作）

先按数据库存储路径定位物理文件：

```
storage_key = customer/3/cbb54bb29c084ae0.mp4
物理路径     = /opt/scqf-test-media/customer/3/cbb54bb29c084ae0.mp4
file_exists  = YES
```

| 对象 | 字节数 | 完整 SHA-256 |
|---|---|---|
| 夹具 `exact_50mib.mp4` | **52,428,800** | **`cbb54bb29c084ae06039a1417fb37896d108f070acb7bb1526f9fdbd9a8ac4e1`** |
| 落盘文件（id=2） | **52,428,800** | **`cbb54bb29c084ae06039a1417fb37896d108f070acb7bb1526f9fdbd9a8ac4e1`** |
| 比对 | — | **same = YES** ✅ |

**没有只比文件名前缀** —— 是对两端算完整 SHA-256 后逐字符比对。
⇒ **50 MiB 落盘完整性：PASS**。

---

## 2. 归档的边界证据（不重复上传）

| 项 | 结果 |
|---|---|
| 258,819 B 小 MP4 | HTTP 200，媒体 **id=1**，实际落盘 258,819 |
| **52,428,800 B** | HTTP 200，媒体 **id=2**，库 `size=52428800`，物理文件同长同哈希 |
| **52,428,801 B** | HTTP **413**，`FILE_TOO_LARGE`「单个文件不能超过 50MB」 |
| 超限残留 | **无媒体记录、无孤儿文件**（目录仅 2 个文件） |
| 拒绝阶段 | **业务层**（测试实例直连 `127.0.0.1:13010`，无 Nginx） |
| 生产写入 | **0**（生产 medias 580 未变） |

---

## 3. 独立解码缺口（单独记录，不撤销边界 PASS）

- 夹具 = 真实 4 秒 H.264 MP4 + 合法 `free` box 扩充；
- **绝大部分字节为非编码填充**（约 52.17 MB），不代表 50 MiB 全是视频编码数据；
- 真实服务端解析器已识别为 `video/mp4` / **4000ms**；
- **本机无 ffmpeg/ffprobe ⇒ 未完成整份夹具的独立完整解码验证**。

⇒ **独立解码：PENDING。**
该缺口**不撤销**业务层大小判定 PASS，但**不得宣称完整视频兼容性已验收**。

---

## 4. 插件启用方式归档

| 方式 | 结果 |
|---|---|
| `nocobase pm:enable @local/service-ticket` | **失败**：`TypeError: callback is not a function`（`plugin-manager.loadCommands`） |
| `APPEND_PRESET_BUILT_IN_PLUGINS=@local/service-ticket` | **成功**，`POST /api/publicMedia:session` → **200** |

> 更正一处笔误：实际生效值是 **`@local/service-ticket`**（单个 `@`），不是 `@//local/service-ticket`。

**边界声明**：这只证明**当前这个环境镜像 + CLI 组合**下 `pm:enable` 调用失败，
**不认定**所有 NocoBase 2.2.15 环境都有同一缺陷；本轮**不为它做修复**。
**该测试配置只存在于 `scqf-media-test/.env.test`，绝不复制到生产。**

---

## 5. 证据保留

实例 `scqf-media-test` **保留**，暂留：

| 资源 | 标识 |
|---|---|
| 媒体记录 | id=**1**（258,819） / id=**2**（52,428,800） |
| 物理文件 | `customer/2/93b97e60c2c4088a.mp4` / `customer/3/cbb54bb29c084ae0.mp4` |
| 夹具 | `/tmp/m50/exact_50mib.mp4`、`/tmp/m50/over_1byte.mp4` |
| 请求与结果摘要 | 本报告 §2 + 上一轮报告 |

**未执行任何宽泛清理。** 将来清理按明确 ID 单独执行并保留验收记录。

---

## 6. 生产纪律

| 项 | 状态 |
|---|---|
| 生产应用 / Nginx / 数据库 / 媒体目录 / ACL / 上限 | **未改** |
| 生产重新部署 | **无** |
| 生产测试写入 | **0** |
| Docker daemon | 未重启 |
| Git | **未 commit / 未 push** |

---

## 7. 最终归档

| 结论项 | 状态 |
|---|---|
| **业务层大小限制（50 MiB 接受 / +1 拒绝）** | **PASS** |
| **50 MiB 文件长度与数据库一致** | **PASS** |
| **完整哈希（夹具 = 落盘）** | **PASS（本轮补齐）** |
| 完整视频解码 | **PENDING**（无 ffmpeg/ffprobe） |
| 生产 H5 端到端 | **不属于本次 PASS** |

⇒ **MEDIA-50M-BOUNDARY-01：PASS / CLOSED**（范围：独立实例内业务层单文件大小判定）。

---

## 8. 后续（按令转入问题⑦）

| 项 | 状态 |
|---|---|
| **问题⑦ 录音上传后移动端布局** | **下一阶段优先** |
| Android 原始上传故障 | PENDING |
| V2/V3/V5 | TEST INVALID / PENDING |
| C6-B | PENDING |
| 50 MiB 业务边界 | **PASS / CLOSED，不再是 C 组 BLOCKED 项** |
| C 组 | PARTIAL PASS |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |
