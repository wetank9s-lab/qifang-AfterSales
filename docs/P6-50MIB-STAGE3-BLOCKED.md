# P6-HOTFIX-02：50 MiB 业务层边界最终验收报告（阶段三）

> 时间：2026-10-23 09:39–09:57 CST
> 结论：**BOUNDARY BLOCKED** —— 夹具与脚本都已就绪，但**测试实例的插件未启用**，
> 媒体 action 返回 404，会话建不出来 ⇒ **边界上传未能执行**。**不申请 PASS。**

---

## 1. ENV 复核（保持 PASS）

| 项 | 值 |
|---|---|
| `scqf-media-test-app` | **healthy** |
| `scqf-media-test-pg` | **healthy** |
| 主机可用内存 | **4,058 MB** |
| 插件产物 | `sha256=288523d776e0…` / `size=1,483,540`（测试前后同一份，只读挂载） |

---

## 2. 夹具：**已生成并校验**（真实 MP4 + 精确 free box）

以真实 4 秒 H.264 MP4（258,819 B，sha256 `93b97e60…`）为基础，在其后追加一个**结构合法的 `free` box**，
长度精确补齐到目标字节数（脚本内 `assert len(out) == target`）：

| 夹具 | 目标字节数 | 结果 |
|---|---|---|
| `exact_50mib.mp4` | **52,428,800** | ✅ 精确匹配 |
| `over_1byte.mp4` | **52,428,801** | ✅ 精确匹配 |

**明文标注**：这是执行令允许的「**有效容器大小边界夹具**」——
`ftyp/moov/mvhd/hdlr` 与真实视频轨道完整保留、时长仍为 4000ms，
**但 50 MiB 中约 52.17 MB 是 `free` box 的非编码填充**，不是全部为视频编码数据。
**不是**"随机字节 + 改扩展名"，**不是**"只改 mdat size"。

---

## 3. 阻塞点：测试实例插件未启用（404）

| 尝试 | 结果 |
|---|---|
| `POST /api/public/media/session`（生产走 nginx 重写的那条） | **404** |
| `POST /api/publicMedia:session`（NocoBase 内部 action 路由） | **404** |

原因：**全新实例的 `scqf_media_test` 库里没有任何插件被启用**，
`@local/service-ticket` 未 enabled ⇒ 媒体 action 未注册。
（生产库是启用过该插件的，所以生产这条链路是通的。）

⇒ **会话建不出来，两个边界上传都没有执行**。**不编造结果。**

---

## 4. 已就绪、只差一步

准备好的执行脚本（`/tmp/run50.sh`）会一次完成：

1. 建会话（`media_consent`）→ 打印 token 长度（**不输出明文**）与 `max_file_bytes`；
2. 两个夹具依次上传 → 记录 HTTP 状态 + 业务响应；
3. 查测试库 `customer_medias`（kind/mime/size/duration/storage_key）；
4. 列 `/opt/scqf-test-media` 实际文件并比对长度；
5. 对照生产 medias 计数与容器健康。

**下一步只需**：在测试库启用插件（`applicationPlugins` 置 enabled，或走 pm API）→ 重启 test app → 重跑该脚本。

---

## 5. 生产零测试写入

| 项 | 值 |
|---|---|
| 生产 `customer_medias` | **580**（真实客户增长，非测试） |
| `scqf-as-app` | Up 16h (healthy) |
| 生产 compose / Nginx / 解析器 / 上限 / ACL | **未改** |
| Docker daemon | 未重启 |
| 本轮测试写入 | 仅限 `scqf-media-test` 内（无媒体写入，因会话未建立） |

---

## 6. 验收范围划分（按令 §七）

| 范围 | 状态 |
|---|---|
| **业务层 50 MiB** | **BLOCKED**（会话 404，未执行） |
| Nginx 已观察的大请求行为 | **已记录**：51 MiB → 401（非 413） |
| 生产 H5 全链路 | **未因此自动通过** |

---

## 7. 实例与清理

- `scqf-media-test` **保留**（便于复核），不销毁。
- 测试数据：本轮**未产生任何媒体记录**（会话未建立）。
- 临时文件：`/tmp/fx.mp4`、`/tmp/run50.sh` 留在服务器便于重跑；`/tmp/m50` 随脚本生成。
- 未使用宽泛清理命令，未绕过 `SAFE_DELETE_FAIL_CLOSED`。

---

## 8. Git 与部署

| 项 | 状态 |
|---|---|
| 生产部署 | 无 |
| 生产代码改动 | 无 |
| Git | **未 commit / 未 push** |

---

## 9. 状态

| 项 | 状态 |
|---|---|
| ENV | **PASS / FROZEN** |
| **BOUNDARY（50 MiB 业务层）** | **BLOCKED（插件未启用）** |
| MEDIA-50M-BOUNDARY-01 | **未申请** |
| MEDIA-ERROR-COPY-01 | PASS / CLOSED |
| 标准 MP4 解析 | PASS / FROZEN |
| V2/V3/V5 | TEST INVALID / PENDING |
| C6 | PARTIAL / PENDING |
| Android 原始故障 | PENDING |
| 问题⑦ 录音布局 | PENDING |
| C 组 | PARTIAL PASS |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |
