# MEDIA-ERROR-COPY-01 文案专项修复报告

> 时间：2026-10-22 17:59–18:15 CST
> 结论：**文案已改、已构建、已部署，静态核对通过**；但 **422 两例的运行期回归未取得** ⇒
> **不申请 PASS，申请 PARTIAL**（文案修复本身无风险，缺的是我这边的验证手段）。

---

## 1. 唯一修改的错误映射

`h5/src/components/MediaUploader.vue`

```diff
- KIND_UNREADABLE: '这个文件读不出时长，请重新录制',
+ // 服务端 KIND_UNREADABLE 的真实语义是**容器/轨道认不出**；与 DURATION_UNREADABLE 共用一句话，
+ // 会让用户反复重录同一格式（永远无效）。文案区分开，其余一切不动。
+ KIND_UNREADABLE: '暂时无法识别这个文件的音视频内容，请尝试更换文件，或使用手机自带的拍摄、录音功能重新制作后上传。',

  DURATION_UNREADABLE: '这个文件读不出时长，请重新录制',   // 保持不变
```

**未改动**：错误码、HTTP 状态码、MIME 检查、时长上限、服务端解析算法、50 MiB 上限、媒体会话授权、私有存储与 `readBound`。
**422 不会被转成成功**（本轮没有任何"把失败变成功"的改动）。

---

## 2. 构建与部署

| 项 | 值 |
|---|---|
| 构建 | `index-C9qJaSHE.js` 162.91 kB |
| 备份 | `backup/media-copy-01-<时间>/h5.tgz`（62,736 B） |
| 部署 | 原子替换，旧目录 `h5.old.m1` |
| 线上引用 | **`assets/index-C9qJaSHE.js`** ✅ |
| 站点 | `/h5/report` 200、`/h5/index.html` 200、`/api/public/stores` 200 |
| 四站点 | hd **200** / cloud **403** / sd **000** / kanma **000**（基线） |
| 未动 | 插件 / Nginx / 数据库 / 短信 |

---

## 3. 静态核对（线上真实产物）

```
new_copy_hits          = 1   ← 新文案已进产物
old_duration_copy_hits = 1   ← DURATION_UNREADABLE 仍是原「读不出时长」
unsupported_copy_hits  = 1   ← 格式不支持文案仍在
```

⇒ **两个码的文案已经分开**，且旧的时长文案没有被误删。

---

## 4. 四码回归结果

| 码 / HTTP | 期望 | 实测 | 判定 |
|---|---|---|---|
| **UNSUPPORTED_MEDIA / 415** | 格式不支持提示 | 「这个文件格式不支持，请用手机直接拍照或录音」 | ✅ **PASS** |
| **KIND_MISMATCH / 415** | 按既有映射，不回归 | 「上传没成功，请点「重试」」（**通用兜底**，非专属文案） | ✅ 未回归（行为未变） |
| **KIND_UNREADABLE / 422** | 新的格式识别提示 | **客户端停在「正在上传…」6 秒不动** | ❌ **未取得** |
| **DURATION_UNREADABLE / 422** | 原时长提示 | 同上 | ❌ **未取得** |

**422 两例为什么卡住**：我的 CDP 拦截下 422 响应没有让客户端落到错误态（`blocked=[]`，说明请求确实被 fulfill 了），
客户端一直显示"正在上传…"。**这是我这侧拦截/时序的问题，不是产品结论**，但**我拿不到那两句文案的运行时证据**。

> 顺带一个观察（未验证，不下结论）：422 时客户端长时间停在"正在上传…"，若在真机上同样表现，
> 可能让用户以为还在传 —— 值得后续单独看，但本轮**不改**。

---

## 5. 回滚依据

```bash
tar xzf /opt/scqf-aftersales/backup/media-copy-01-<时间>/h5.tgz -C /www/wwwroot/sh.scqfls.cn
# 或把 h5.old.m1 换回 h5
```

---

## 6. 生产零测试写入

| 项 | 值 |
|---|---|
| 生产媒体写入 | **0**（上传全部被 CDP fulfill，未到服务端） |
| 工单 / 短信 / 数据库 | 0 / 0 / 0 |
| `blocked` 计数 | **0**（无 POST 越界） |
| 清理 | `copy4.js`、`a.wav`、`dc/` 已删 |

---

## 7. 仍待解决的 Android 兼容性（继续 PENDING）

- 原始 Android 失败文件的**真实字节证据**（无样本，不猜失败 box）
- 服务端解析函数的**离线可执行性**（产物未导出 `sniffCustomerMedia`；本机无 esbuild/ffprobe）
- V2/V3/V5 视频时长分支、C6 生命周期清理
- 50 MiB 独立实例边界上传
- 问题⑦ 录音上传后真实布局、Android 真机

---

## 判定

- **MEDIA-ERROR-COPY-01：PARTIAL**（改动正确、已上线、静态可核；缺 422 两例的运行期文案证据）。
- **不把文案修复冒充 Android 视频故障修复** —— 那是两件事，Android 侧仍 PENDING。
- C 组：PARTIAL PASS。
- 未 commit / 未 push。

P6：LIVE / CONDITIONAL；Release：HOLD。
