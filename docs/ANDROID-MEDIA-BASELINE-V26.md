# 标准 MP4 基线冻结 + V2/V3/V5/C6 推进记录

> 时间：2026-10-23 09:20–09:28 CST
> 结论：**MP4 基线已冻结（PASS）**；V2/V3/V5 与 C6 **仍未取得可信结论**（我的埋点打错了对象），
> **不申请 PASS**。Android 根因仍 PENDING（无样本）。

---

## 1. 冻结的回归基线（PASS）

| 项 | 值 |
|---|---|
| 夹具 | `c6_duration_fixture_4s.mp4` |
| 大小 | **258,819 bytes** |
| SHA-256 | `93b97e60c2c4088a87283d79583b62ba24de764777431a711f6a113d11045c90` |
| 源码 | `nocobase/plugins/service-ticket/src/server/services/media-format.ts`（当前工作区版本，未改） |
| 构建方式 | 受管 workspace esbuild → 临时 CJS（101,126 B，0 错误），跑完即删 |
| 调用 | `sniffCustomerMedia(buf,'mixed')` / `(buf,'video')` / `(buf,'audio')` / `(buf,'image')` |
| 结果 | mixed→`video/video.mp4/4000ms`；video→同上；audio/image→`KIND_MISMATCH` |

**该基线不再重复验证。** 截断对照（50%、末尾少 1KB 仍通过；头部 512B → `DURATION_UNREADABLE`）一并归档。

---

## 2. V2/V3/V5：**仍未取得**（打错了对象）

### 已确认的事实 ✅

埋点显示组件确实使用**属性处理器**，四个全部被赋值：

```
setHandlers = onloadedmetadata | ondurationchange | onloadeddata | onerror
```

这证实了此前"`addEventListener` 埋点测不到东西"的判断。

**另一条确认**：`cleared` 为空 —— 组件**从不把这些属性置 `null`**。
即没有显式解绑；元素被丢弃后由 GC 回收，**不是真泄漏**，但值得登记。

### 失败点 ❌

`reads` 全部为空 —— 我注入的 `duration` getter **一次都没被调用**。

原因：`window.__st.el` 被**后续创建的 `<video>`（卡片预览）覆盖**，我 patch 的是"最后一个"，
而 probe 用的是"第一个"。所以三个用例都没真正被桩控制。

**V5 出现 `card:1 / 视频 00:04 / revoked:1`，与 V4（never → card:0）矛盾 ⇒ 不采信。**

⇒ **V2/V3/V5：PENDING。** 下次修法明确：**按创建序号锁定元素**（第 1 个 `<video>` = probe，其后是 preview）。

---

## 3. C6：部分证据

| 观测 | 结果 |
|---|---|
| 探测中途路由离开 | 页面正常（`alive:true`） |
| **离开后是否继续上传** | **否**（`reqs=[]`）✅ |
| `revoked` 数量 | **0**（promise 未 settle，`finally` 未执行，符合预期） |
| 属性处理器置空 | **从未发生**（同上 §2） |
| 计时器 | 上一轮已观测到超时路径 `setT:1 / clrT:1`（超时被清） |

⇒ **"没有后续副作用"这半条成立；"资源是否被及时释放"这半条仍缺证据** ⇒ **PENDING**。

---

## 4. Android 原始故障：PENDING（无样本）

本轮没有任何 Android 文件，因此**不推进、不推断**。
取证清单已按令登记：系统/浏览器版本、入口（拍摄 vs 相册）、原始 MIME/大小/扩展名/SHA-256、
HTTP 状态与业务码、浏览器解码结果；**不转码、不重封装、不改扩展名**。

---

## 5. 完整性风险（按令单独登记，不改校验）

> **ITEM-TRUNC-01（待评估）**：解析器对截断 50% 的文件仍返回 4000ms。
> 这只说明"元数据可读"，不说明文件完整。当前**不认定**为安全缺陷，**不修改**生产校验。
> 若将来出现"离线解析成功但上传 422"，再在隔离环境比对上传前后长度与哈希。

---

## 6. 生产边界

| 项 | 值 |
|---|---|
| 上传 / 工单 / 短信 / 数据库 | **0 / 0 / 0 / 0** |
| 解析器 / 白名单 / 权限 / 大小上限 | **未改** |
| Nginx / 部署 / 重启 | **未动 / 未部署 / 未重启** |
| 临时产物 | `v26.js`、`mf.cjs`、`d6/` **已删** |
| `SAFE_DELETE_FAIL_CLOSED` | 未绕过（`.tmp-verify/mp` 仍单列待处理） |
| Git | 未 commit / 未 push |

---

## 7. 状态

| 项 | 状态 |
|---|---|
| MEDIA-ERROR-COPY-01 | **PASS / CLOSED** |
| 标准 MP4 服务端解析 | **PASS（基线已冻结）** |
| V2/V3/V5 视频离屏事件 | **PENDING**（埋点打错元素，下轮按序号锁定） |
| C6 生命周期 | **PENDING**（无后续副作用 ✅ / 释放证据缺） |
| Android 原始故障 | **PENDING**（无样本） |
| 50 MiB 独立实例 | **BLOCKED** |
| 问题⑦ 录音真实布局 | **PENDING** |
| **C 组** | **PARTIAL PASS** |
| P6 | LIVE / CONDITIONAL |
| Release | HOLD |
