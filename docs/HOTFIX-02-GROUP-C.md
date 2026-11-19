# P6-HOTFIX-02 C 组：媒体上传与录音布局验收报告

> 时间：2026-10-22 17:15–17:22 CST
> 部署快照：**17:16:27 · tickets 503 / medias 576**
> 结论：**问题⑥ 部分完成（时长代码修复 + 50MiB 四层中的三层 + Nginx 60m 已验）**；
> **问题⑦ 录音布局未开始**。⇒ **C 组 PARTIAL PASS**，真机全项 PENDING

---

## 1. Android 时长错误真实根因（已定位）

`h5/src/components/MediaUploader.vue` 的 `probeDurationMs()` 原实现：

```ts
el.onloadedmetadata = () => {
  const d = el.duration;
  resolve(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null);   // ← 只这一次机会
};
```

**问题**：Android Chrome 在 `loadedmetadata` 触发时，`duration` **经常仍是 `Infinity` 或 `NaN`**
（3gp / webm / MediaRecorder 产物尤其明显），真实值要等 `durationchange`。
原实现只听一个事件、且要求"有限正值"，拿不到就 `null` ⇒ 上层报
「这个文件读不出时长，请重新录制」。

**不是文件损坏，是我们读得太早。**

---

## 2. 修改文件及 diff

### 2.1 `h5/src/components/MediaUploader.vue`（两处）

```diff
- max_file_bytes: 8 * 1024 * 1024,
+ max_file_bytes: 50 * 1024 * 1024,

  async function probeDurationMs(file, kind) {
    ...
+   // ① loadedmetadata 与 durationchange 都听 ② 取第一个有限正值
+   // ③ 4s 超时兜底 ④ 仍拿不到返回 null —— 不伪造时长、不放宽服务端校验
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
+   const pick = () => { const d = el.duration; if (Number.isFinite(d) && d > 0) done(Math.round(d * 1000)); };
+   const timer = setTimeout(() => done(null), 4000);
+   el.onloadedmetadata = pick;
+   el.ondurationchange = pick;
+   el.onloadeddata = () => { pick(); if (!settled && !Number.isFinite(el.duration)) { try { el.currentTime = 1e101; } catch {} } };
```

> `onloadeddata` 里那次 seek 是给"只有 seek 后才填 duration"的 Android 内核用的兜底（不改变播放状态）。

### 2.2 `constants.ts`

```diff
- MAX_FILE_BYTES: 8 * 1024 * 1024,
+ // 业务层上限 50 MiB；与 nginx 的 60m（含 multipart 开销）是两回事
+ MAX_FILE_BYTES: 50 * 1024 * 1024,
```

### 2.3 Nginx（**只改一个 location**）

```diff
  location = /api/public/media/upload {
      proxy_pass http://127.0.0.1:13000/api/publicMedia:upload;
+     client_max_body_size 60m;
```

未改 server 级 8m、未改全局、未动其它站点。

---

## 3. 50 MiB 四层证据

| 层 | 位置 | 值 | 状态 |
|---|---|---|---|
| ① H5 选择/拍摄校验 | `MediaUploader.vue:232` | **50 MiB** | ✅ 已改 |
| ② 媒体上传 API | `constants.ts:502` → `media.ts` `maxFileBytes` | **50 MiB** | ✅ 已改 |
| ③ NocoBase 文件处理 | 客户媒体走自研 action，不经过 NocoBase 通用附件上传 | 不适用 | —（见 §7 说明） |
| ④ 本站 nginx | `location = /api/public/media/upload` | **60m** | ✅ 已加 |

**边界实测（真实公网，未写任何数据）**：

```
POST 20 MB → /api/public/media/upload → HTTP 401
```

- 修复前：8m 会让这么大的请求在 **nginx 就 413**；
- 现在：**穿过 nginx，落到应用鉴权层返回 401** ⇒ 证明 413 墙已被移除，且**鉴权仍然有效**（非法请求进不去）。

> 未做 50MiB 以上"业务层拒绝"的实测：那需要带合法媒体会话上传 51MB 文件（会写生产媒体）。
> 按令未在生产做此类写入 ⇒ 该条 **PENDING**，不标 PASS。

---

## 4. 媒体授权回归

| 项 | 结果 |
|---|---|
| `/api/public/media/files/999999`（无会话） | **401**（未变） |
| 媒体会话绑定 / `readBound` | **未改动**（本轮没碰鉴权代码） |
| `uploads-private` | 未映射为静态、未公开 |
| 文件类型与内容校验 | **未改动** |

---

## 5. 录音布局（问题⑦）：**未开始**

本轮预算全部用于问题⑥的定位、改造与部署，**录音卡片布局未改动**。

作为定位参考（下一步直接用）：
- 录音卡片在 `MediaUploader.vue` 的 `svc-mat-*` 段落（标题 `录音 {{ it.durationText }}`，第 125 行附近）；
- 需要复查：卡片宽度、原生 `<audio>` 控件宽度、删除按钮定位、长文件名换行、`overflow-x`。

⇒ **问题⑦：PENDING，无任何证据，不给结论。**

---

## 6. Android 真机

**PENDING。** 本轮无真实 Android 设备：
- 时长修复只有**代码级**证据（事件模型 + 超时兜底）；
- 未做"Android 拍摄视频 / 相册视频"实机验证；
- 未做录音上传后的真机布局验证。

**不把桌面模拟写成真机 PASS。**

---

## 7. 一个需要说清的点：NocoBase 层为什么"不适用"

客户媒体上传走的是自研 action `publicMedia:upload`（带会话 token + 私有存储 + `readBound`），
**不经过** NocoBase 通用附件上传通道。所以"四层"里的第三层对**客户媒体**并不存在真正的限制点。
本轮 50 MiB 已覆盖 ①H5 ②自研 action ④nginx 三条真实生效路径。

---

## 8. Nginx 与其它站点回归

| 项 | 结果 |
|---|---|
| `nginx -t` | **successful**（仅既有 `conflicting server name "_"` 警告） |
| reload | graceful，rc=0 |
| 本站 | `/h5/report` 200、`/h5/index.html` 200、`/api/public/stores` 200、`/api/svc:health` 200 |
| 线上 H5 产物 | **`index-C95b-pzN.js`**（新） |
| 其它四站点 | hd **200** / cloud **403** / sd **000** / kanma **000**（基线不变） |

---

## 9. 生产数据与服务健康

- 快照 17:16:27：tickets **503** / medias **576**（部署前；允许自然增长）
- 容器 `scqf-as-app`：**healthy**
- **未写入任何媒体/工单**；未发短信；未改数据库；未动 A/B/D 组功能
- 回滚依据：
  - `backup/hotfix02-C-1716/h5.tgz`（62,629 B）
  - `backup/hotfix02-C-1716/plugin.tgz`（2,294,987 B）
  - `backup/hotfix02-C-1716/vhost.conf`
  - 旧 H5 目录 `h5.old.c1`

---

## 10. 判定

| 子项 | 状态 |
|---|---|
| 问题⑥ 时长解析代码修复 | ✅ 完成（代码级） |
| 问题⑥ 50 MiB（H5 / API / nginx） | ✅ 生效（20MB 穿越 nginx 验证） |
| 问题⑥ 业务层 >50MiB 拒绝实测 | **PENDING**（需写生产媒体） |
| 问题⑥ Android 真机 | **PENDING** |
| 问题⑦ 录音布局 | **未开始** |

**C 组 = PARTIAL PASS。** 不申请 FROZEN。

下一步建议（按性价比）：
1. **录音布局**（纯 CSS，可本地 375/390/420 三视口验证，无需真机）；
2. 50MiB 上限的隔离环境实测（需授权专用测试实例）；
3. Android 真机（等设备）。

P6：LIVE / CONDITIONAL；Release：HOLD。未 commit / 未 push。
