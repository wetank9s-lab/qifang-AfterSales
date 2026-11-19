# TECH-H5-PLUGIN-CONTRACT-01 · 补证（第二轮）

> 时间：2026-10-23 10:56–11:05 CST
> 补的是主报告里按令要求、但上一轮没做到的三项：**响应头 / Range / 真实 UA 行为**。

---

## 1. `:media` 的真实响应头（有效 ref）

```
HTTP/2 200
content-type: audio/webm
content-length: 71040
content-disposition: inline
cache-control: private, no-store          ← 私有媒体不被中间层缓存 ✅
x-content-type-options: nosniff           ← 防 MIME 嗅探 ✅
accept-ranges: bytes                      ← 声称支持 Range
referrer-policy: strict-origin-when-cross-origin
```

**判读**：`private, no-store` + `nosniff` + `inline` 这套组合对"私有媒体直出"是合适的，
**没有**把 `Content-Disposition` 设成 attachment（浏览器可内联播放）。

> ⚠️ `referrer-policy` 这里是 `strict-origin-when-cross-origin`，
> 而 `/h5/` 的 location 用的是 `no-referrer`。**`/api/` 这条路径不会把 Token 放进 Referer**
> （Token 在 query 里，跨源请求只会带 origin），风险可接受，但**两处策略不一致**，值得记录。

---

## 2. 🔴 Range 请求：**声明了但没实现**

```
请求：Range: bytes=0-1023
响应：HTTP/2 200（不是 206）
实际收到：71,040 字节（完整文件，不是 1,024）
accept-ranges: bytes
```

**结论**：action 返回 `Accept-Ranges: bytes`，但**不处理 Range 请求头** ⇒ 每次请求都全量返回。

影响评估：

| 场景 | 影响 |
|---|---|
| 71 KB 录音（本单） | 可忽略 |
| 几 MB 视频（客户上传的现场视频） | **拖动进度条会重下整段**；弱网下体验差 |
| 断点续传 | 不可用 |

**这是既有实现的能力缺口，不是本轮改动引入的**，也不影响"能不能看到/听到"。
按令 §五.8「Range 支持」应如实记为：**声明支持、实际未实现 206**。

---

## 3. 真实 Android Chrome UA 下的行为

```
UA: Mozilla/5.0 (Linux; Android 13; SM-G991B) … Chrome/120 Mobile Safari/537.36
→ 200  audio/webm  71,040
```

**同一响应**，无 UA 差异（说明服务端不按 UA 分流）。
但这**不等于真机验收** —— 只是证明"服务端对移动 UA 没有额外拦截"。

---

## 4. 对主报告结论的影响

**Case D 的判定不变**：两个 action 存在且工作，缺的只是 nginx 两条映射。

新增/补齐的事实：

| 项 | 状态 |
|---|---|
| `:media` 响应头 | ✅ 已记录（`private, no-store` / `nosniff` / inline） |
| Range / 206 | ⚠️ **声明支持、实际未实现**（全量 200） |
| Android UA 行为 | ✅ 无差异（非真机验收） |
| Referrer 策略 | ⚠️ `/api/` 与 `/h5/` 不一致（前者 `strict-origin-when-cross-origin`） |

---

## 5. 仍未取得（PENDING，不因本轮补证而消失）

| 项 | 原因 |
|---|---|
| 真机（Android Chrome / iOS Safari）实操 | 无设备 |
| files / submit 真实 POST | 不向生产写 |
| 照片删除的真实成功路径 | 需隔离实例 + 合成照片 |
| 他单媒体 / 撤销 Visit 的越权拒绝 | 需隔离师傅单 |
| 320/390px 页面真实播放与删除 | 需在上面的映射就位后、真机上做 |

---

## 6. 生产纪律（本轮）

| 项 | 状态 |
|---|---|
| 工单 / 媒体上传 / 照片删除 / 提交 | **0 / 0 / 0 / 0** |
| 短信 / 数据库 | 0 / 0 |
| Nginx 修改 | **无**（仍只是上一轮那 4 条） |
| 插件重建 / 重启 | **无** |
| Token | `<T>` 脱敏 |
| Git | **未 commit / 未 push** |

P6：LIVE / CONDITIONAL；Release：HOLD。
