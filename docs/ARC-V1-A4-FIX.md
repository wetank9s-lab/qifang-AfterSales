# ARC-V1 · A4-FIX 客户查询页 XSS 收尾

> 2026-11-09　仅开发环境　未部署、未 commit
> 服务端契约、token 设计、验证码/会话/照片可见性规则**均未改动**。

---

## 一、修改文件

| 文件 | 变更 |
|---|---|
| `h5/public/archive-render.js` | **新增**。纯渲染函数（text/el/kv/arcCard/stageRow/photoBlock/archiveHeadCard…），全部 `textContent` |
| `h5/public/archive.html` | 渲染层重写：删除全部 `innerHTML` 拼接，改为调用共享渲染函数；加网络异常兜底、blob 释放 |
| `h5/public/xss-test.html` | **新增**。XSS 验证页，引用同一份 `archive-render.js` |

> 为什么抽 `archive-render.js`：测试页必须跑**同一份代码**。若测试页自己抄一份渲染逻辑，
> 它只能证明"抄的那份是安全的"，真实页面里漏转义照样存在。

---

## 二、差异要点

### 2.1 渲染层（核心）

| 旧 | 新 |
|---|---|
| `body.innerHTML = html` （拼字符串） | `body.textContent=''` + `appendChild(R.xxx(...))` |
| `sel.innerHTML = list.map(...)` | `document.createElement('option')` + `option.textContent` |
| `${a.customer_name}` 直接进模板 | `R.kv('客户', a.customer_name)` → `textContent` |
| 阶段备注 `${st.note}` | `R.stageRow` 内 `textContent` |
| 错误信息 `el.textContent = ...`（原本已安全） | 保持，并统一走 `showMsg` |

### 2.2 动态属性与照片 ID

- 档案编号进 `dataset.no` 前必须过 `/^[A-Za-z0-9_-]{1,40}$/`；
  `openDetail()` 入口**再校验一次**（防手工调用）。
- 照片 id 必须 `Number.isSafeInteger(id) && id > 0`，否则**不渲染该图**（不是显示破图）。
- 属性一律 `dataset` / `setAttribute`，不参与 HTML 解析。

### 2.3 Blob URL 生命周期

- 每张图把 objectURL 记在 `dataset.blobUrl`；
- 同一元素重复赋值前 `releaseBlobFor()` 先 revoke；
- 切视图（`switchView`）、会话失效、`pagehide` 时 `releaseAllBlobs()` 统一释放。

### 2.4 网络异常与按钮恢复

- `api()` **永不抛异常**，网络失败折叠成 `{ status:0, networkError:true }`；
- 发码 / 验证两个按钮都包 `try/finally`；
- 失败分支显式恢复 `disabled=false` 与原文案（不是只靠 finally，双保险）。

### 2.5 未改动（用户明确要求）

- token 仍只存模块作用域变量，刷新即丢，不写 localStorage/URL；
- 五个 `publicArchive` Action 的请求/响应字段完全一致；
- 验证码规则、30 分钟会话、照片可见性判定仍在服务端，前端不参与判定。

---

## 三、测试结果

### 3.1 XSS 验证：**42 条断言全部通过**

验证方式：`xss-test.html` 在真实浏览器（Edge headless）中执行，
引用**与生产页面同一份** `archive-render.js`，6 组攻击载荷各跑一遍。

| 载荷 | 覆盖字段 | 结果 |
|---|---|---|
| `<script>window.__xss=1</script>` | 客户姓名 / 地址 / 公开说明 / 产品描述 / 阶段备注 | ✅ 以字面文本显示 |
| `<img src=x onerror="window.__xss=1">` | 同上 + 门店名称 + 档案卡片 | ✅ |
| `"><svg onload=window.__xss=1>` | 同上 | ✅ |
| `'><iframe src=javascript:window.__xss=1>` | 同上 | ✅ |
| `<a href="javascript:window.__xss=1">click</a>` | 同上 | ✅ |
| `&lt;script&gt;already-escaped&lt;/script&gt;` | 同上（验证不二次转义） | ✅ |

判定项（每条载荷 5 条 × 6 = 30 条）+ 12 条结构项：

| 编号 | 断言 | 结果 |
|---|---|---|
| A | 载荷原样出现在 `textContent`（证明被当字符） | ✅ ×6 |
| B | 渲染节点内无 `script/img/iframe/svg` | ✅ ×6 |
| C | 阶段备注原样保留 | ✅ ×6 |
| D | 阶段行无可执行元素 | ✅ ×6 |
| E | 客户姓名/地址/公开说明 5 个 kv 值原样 | ✅ ×6 |
| F | 档案卡片无可执行元素 | ✅ |
| G | 非法档案编号未写入 `dataset` | ✅ |
| H | 合法档案编号正常写入 | ✅ |
| I | 门店名称以 `option.textContent` 渲染 | ✅ |
| J | 门店下拉无可执行元素 | ✅ |
| K | 服务端错误信息原样显示 | ✅ |
| L | 错误消息无可执行元素 | ✅ |
| M | 照片只渲染合法正整数 id（`12`/`"13"` 通过，`0`/`-1`/`abc`/`1.5`/`<img src=x>`/超大数 拒绝） | ✅ 2/8 |
| N | `window.__xss` 未被设置 | ✅ |

### 3.2 中文/换行/特殊字符

`张师傅 说：\n"今天下雨"，管路已包好。& <测试> 100%` —— 原样保留，未被二次转义（`textContent` 不解释实体）。

### 3.3 静态复查

```
grep -c "innerHTML|outerHTML|insertAdjacentHTML|document.write"
  archive.html: 2   ← 均在注释里（说明"不用它"的历史）
  archive-render.js: 1 ← 注释
业务代码命中：0
```

### 3.4 未完成的验证

- **真实页面端到端**（登录→列表→详情）未在 headless 中跑通：
  headless 的 `--dump-dom` 不等异步 `fetch`，页面停在"加载中…"。
  这是抓取工具限制，不是页面缺陷。需要在真机/普通浏览器中验收。
- **blob 释放**只做了代码审查 + 生命周期设计，未做内存观测。

---

## 四、最终指纹

| 文件 | SHA-256 |
|---|---|
| `h5/public/archive.html` | `7db1717dbac0de08036626138a23bd984dfda1c2f678ae179ae3b96d0d1438e7` |
| `h5/public/archive-render.js` | `3210f81be9f6c5054c3af84a28b794668e9c405eb893b9f6def377d212a9dd2c` |
| `h5/public/xss-test.html` | `e714236e4489934d2a3536ec2bf0c59e27c88a4f4d9be9d88d7d889527b337b3` |

`h5/dist/archive.html` 与 `h5/dist/archive-render.js` 指纹与源文件**一致**（public 目录原样复制）。

---

## 五、遗留

1. **`xss-test.html` 应在上线前移除**（或加访问限制）。它不含敏感数据，但属于测试工件。
2. 真实页面端到端验收仍需真机。
3. 员工端 7 个 NocoBase 页面仍待 admin 会话。
