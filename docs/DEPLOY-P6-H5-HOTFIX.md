# P6 上线后紧急收口 · 任务一：门店报修页面 404 修复

> 执行时间：2026-10-22 12:41–12:52（UTC+8）
> 目标站点：`https://sh.scqfls.cn`（腾讯云 `162.14.121.180`，OpenCloudOS 9.4，宝塔 11.8.0）
> 判定：**FIXED — PASS**（门店报修页真实渲染闭环已打通）
> 影响面：仅新增 `/h5/` 静态层与本站日志；**未改动任何 API 反代、证书、其他站点**

---

## 一、现象与最终根因（一句话）

> **不是路由写错，也不是 404 —— 是 H5 前端构建产物从未部署到云端。**

`/h5/*` 全部落到 `location /` 被反代给 NocoBase 应用，应用里没有 H5 产物，
于是返回自己的 SPA 加载壳（HTTP **200**、`<title>Loading...</title>`、2508 字节）。
浏览器把这个 HTML 当模块脚本执行 → 报错/白屏 → 用户看到的就是"报修页打不开/404"。

---

## 二、取证过程（含一次**判据被推翻**的经过）

### 2.1 第一轮判据是错的：`200` 不等于成功

最初从公网探到的结果是：

| 路径 | code | type | size |
|---|---|---|---|
| `/h5/report?k=…` | 200 | text/html | 2508 |
| `/h5` | 200 | text/html | 2508 |
| `/h5/` | 200 | text/html | 2508 |
| `/` | 200 | text/html | 2508 |

**所有路径大小完全相同**——这本身就是可疑信号。真去核对产物才定性：

- 本机 `h5/dist/index.html` = **987 字节**
- 云端返回 = **2508 字节**，`<title>Loading...</title>`，引用 `/assets/runtime-*.js`
- 该页面含 10 处 NocoBase 特征串

⇒ 2508 字节是 **NocoBase 后台自己的加载壳**，与 H5 无关。

**教训（同 `verification-false-green-hunting`）**：把 `HTTP 200` 当作"页面可用"是假绿。
真正能区分身份的是 **Content-Type + 字节数 + 标题**，三者要一起看。

### 2.2 决定性证据：JS 被 HTML 顶替

| 请求 | 部署前 | 部署后 |
|---|---|---|
| `/h5/assets/index-DvlJmwHL.js` | 200 / **`text/html`** / 2508 | 200 / `application/javascript` / **160843** |
| `/h5/assets/index-C6-hgx5J.css` | 200 / `text/html` / 2508 | 200 / `text/css` / **26765** |
| `/assets/runtime-9670bed7.js`（NocoBase 自己的） | 200 / `application/javascript` / 4719 | 不变 |

浏览器请求 `<script type="module">` 却收到 `text/html` → **模块加载失败**（MIME 类型不符）。

### 2.3 三处缺口逐一定位

| # | 事实 | 证据 |
|---|---|---|
| 1 | 云端**没有 H5 产物** | `/opt/scqf-aftersales/h5`、`/www/wwwroot/sh.scqfls.cn/h5` 均 MISS；`find` 全盘无 `assets/index-*.js`；容器内无 `h5` 目录 |
| 2 | vhost **没有任何 `/h5` 规则** | `grep -n h5 sh.scqfls.cn.conf` → 零命中；location 清单只有 acme / 301 / media.upload / reviews / `^~ /api/public/` / `/` |
| 3 | 本站**没有 access_log** | nginx master `fd` 里无本站日志；`/www/wwwlogs/sh.scqfls.cn.log` 不存在 ⇒ 线上 404 无从回溯 |

> 第 3 条是**运维盲区**而不是本次故障原因，但它让"用户报 404"这件事在服务端**完全没有留痕**，
> 属于必须一并修掉的同类缺陷。

### 2.4 日志侧的诚实说明

按要求检查了 Nginx access/error log。结论：**本次 404 在服务端没有日志可查**——
因为该 vhost 未配置 `access_log`，请求只可能落到 http 块默认日志，
而默认日志按**其他站点**的格式写入、不含本域名字段（`grep sh.scqfls.cn` = 0 命中）。

⇒ 无法给出"历史上哪个 URL 返回了 404"，**不编造**。改为从**入口契约**反推：
插件源码 `actions/svc/store-entry.ts:50` 明确写死 `H5_REPORT_PATH = '/h5/report'`，
门店二维码指向的就是它 —— 与用户描述一致。

---

## 三、修复内容（最小改动，只增不删）

唯一改动文件：`/www/server/panel/vhost/nginx/sh.scqfls.cn.conf`（100 → 152 行）

备份：`/opt/scqf-aftersales/backup/vhost-pre-h5-20261022.conf`（3705 B，600）

### 3.1 新增 `/h5/` 静态层

```nginx
location = /h5 {
    return 301 /h5/$is_args$args;
}

location ^~ /h5/ {
    root /www/wwwroot/sh.scqfls.cn;
    index index.html;
    try_files $uri $uri/ /h5/index.html;

    add_header Cache-Control "no-store, must-revalidate" always;
    add_header X-Robots-Tag  "noindex, nofollow"         always;
    add_header X-Content-Type-Options   "nosniff"                        always;
    add_header X-Frame-Options          "SAMEORIGIN"                     always;
    add_header Referrer-Policy          "strict-origin-when-cross-origin" always;

    location ~* ^/h5/assets/ {
        root /www/wwwroot/sh.scqfls.cn;
        add_header Cache-Control "public, max-age=2592000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        access_log off;
    }
}
```

三个必须注意的点（都踩过）：

1. **用 `root` 不用 `alias`**（同本机 DEV-29）：磁盘布局 `<root>/h5/xxx` 与 URI `/h5/xxx` 同构；
   `alias` + 正则 location 会退化成目录重定向（301 补尾斜杠、还丢端口）。
2. **`add_header` 不叠加**：子块一旦出现 `add_header`，父级全部失效 ⇒ 这里重新声明了
   server 级的三条安全头，否则 H5 页面会**静默丢掉** `nosniff` / `SAMEORIGIN`。
3. **不用 `expires 30d`**：它会自己再发一条 `Cache-Control: max-age=...`，
   与 `add_header` 叠成**两个** Cache-Control 头（实测确认）。改用单一 `add_header`。

### 3.2 新增本站日志

```nginx
access_log /www/wwwlogs/sh.scqfls.cn.log;
error_log  /www/wwwlogs/sh.scqfls.cn.error.log;
```

### 3.3 产物部署

| 项 | 值 |
|---|---|
| 来源 | 仓库 `9a57997` 的 `h5/dist`（`git status h5/` 干净，HEAD 与部署 commit 一致） |
| 构建 | 本地 `vite build`，**重建结果与既有 dist 逐文件 SHA-256 完全一致**（可复现） |
| 落地 | `/www/wwwroot/sh.scqfls.cn/h5/`，目录 755、文件 644 |
| 校验 | 云端 `sha256sum` 与本地**逐文件 MATCH** |

```
index.html                      e97d61ea93b6437a…   987 B
assets/index-C6-hgx5J.css       940c10d5c7317f6f…   26765 B
assets/index-DvlJmwHL.js        f08caadb64605981…   160843 B
```

> SHA-256 先把关再动 nginx：哈希不一致就**不切换**（脚本内置硬闸门）。

---

## 四、验证（公网真实链路，非本地回环）

### 4.1 HTTP 层

| 路径 | code | Content-Type | 字节 |
|---|---|---|---|
| `/h5/report` | 200 | text/html | **987** |
| `/h5/index.html` | 200 | text/html | 987 |
| `/h5/` | 200 | text/html | 987 |
| `/h5` | 301 | — | → `/h5/` |
| `/h5/assets/index-DvlJmwHL.js` | 200 | **application/javascript** | 160843 |
| `/h5/assets/index-C6-hgx5J.css` | 200 | **text/css** | 26765 |

响应头：
- `index.html` → `cache-control: no-store, must-revalidate` + `x-robots-tag: noindex, nofollow` + `nosniff` + `SAMEORIGIN` + `referrer-policy`
- `assets` → **单条** `cache-control: public, max-age=2592000, immutable`

### 4.2 浏览器层（系统 Edge 无头渲染，`--dump-dom` 取真实 DOM）

`/h5/report`（无 `k`）：
- `<div id="app" data-v-app="">` ← **Vue 已挂载**
- 正确显示：`缺少门店入口信息：请扫描门店提供的二维码进入本页。`（这是**预期**行为，不是故障）

`/h5/report?k=S01`（legacy 入口，服务端支持且无需密钥）：
- 门店信息解析正确：**新都圣大家电 / 028-83992299 / 新都区新城市广场和信中心1-3楼**
- 完整表单渲染：我要报修 / 我要投诉、联系人、手机号码、故障描述（0/500）、
  拍照·相册·录音·拍视频、家电类别 / 品牌型号 / 服务地址、提交报修、隐私说明
- 页面标题由 JS 改写为 `四川七方连锁售后服务平台 · 服务报修`（说明 `publicUiTheme:get` 已成功调用）
- 截图：`.tmp-verify/h5-entry-final.png`（52923 B）

### 4.3 回归（确认没碰坏别的）

| 项 | 结果 |
|---|---|
| `/`、`/admin` | 200 / 2508（NocoBase 后台照旧） |
| `/api/public/stores` | 200 |
| `/api/public/store-entry`（无 k / 坏 k） | 404 / 404 |
| `/api/public/media/files/999999` | 401 |
| `/api/public/progress/<43>` | 401 |
| `/api/public/reviews/<43>` | 404 |
| 开发端点 4/4 | 404（production profile 生效） |
| 四站点基线 | hd **200** / cloud **403** / sd **000** / kanma **000**（与上线时完全一致） |
| `nginx -t` | successful（仅既有 `conflicting server name "_"` 警告） |
| 容器 | `scqf-as-app` healthy / `scqf-as-postgres` healthy |
| **业务数据** | tickets **489** / events **1827** / medias **551** / sms_logs **783** / sessions **725** —— **零新增** |
| 私有媒体泄露检查 | vhost 中 `scqf-as-media` / `uploads-private` 引用数 = **0** |

### 4.4 日志已生效

`/www/wwwlogs/sh.scqfls.cn.log` 开始记录，`/h5` 请求 **10×200 + 1×301**，
可见 `GET /h5/report 200 987`、`GET /api/public/store-entry 200`、`GET /api/publicUiTheme:get 200`。

---

## 五、回滚方式（一条命令级）

```bash
cp -p /opt/scqf-aftersales/backup/vhost-pre-h5-20261022.conf \
      /www/server/panel/vhost/nginx/sh.scqfls.cn.conf
/usr/bin/nginx -t && /usr/bin/nginx -s reload
```

回滚后 `/h5/*` 会退回"NocoBase 加载壳"状态（即故障态）。
H5 静态产物留在 `/www/wwwroot/sh.scqfls.cn/h5/`，不影响回滚，也不被任何反代引用。

> 部署脚本已内置自动回滚：`nginx -t` 不通过即用备份覆盖并复测。

---

## 六、同类缺口（**已发现，未擅自修**，按分诊规则另立令）

部署时的 vhost 只做了 `api/public` 一族映射，**漏掉了整条"非 API 路由层"**。本次只修了门店报修（A 类），
以下属于同一根因但影响**其他**链路，按项目纪律**不扩大本任务范围**：

| # | 缺失项 | 影响 | 严重度 |
|---|---|---|---|
| 1 | `/t/<43>` → 302 `/h5/technician/visit/<t>` | 师傅短信短链全 404（当前 `SMS_ENABLED=false`，暂未暴露） | A（启用短信即致命） |
| 2 | `/f/<43>` → 302 `/h5/customer/review/<t>` | 客户评价链接 404 | A |
| 3 | `/p/<43>` → 302 `/h5/customer/progress/<t>` | 进度查询链接 404 | A |
| 4 | `/api/technician/` 6–7 条 rewrite | 师傅端读工单/上传/提交/看客户媒体全部失效（落到 `location /` → NocoBase 解析失败 404） | **A（最高）** |
| 5 | `/api/svc/*` 若干 rewrite | 后台自定义页面调用的 action 路径 | 待核 |

> 本机 `nginx/conf.d/service.conf` 是这些规则的**唯一权威副本**（生产验证过），
> 云端照搬即可，但**必须逐条比对**而不是整段复制（本机有 `limit_req`、`proxy-headers.inc`
> 等云端没有的依赖）。

---

## 七、PENDING（本轮不做）

- **P6-H5-01**：门店二维码存量核验 —— 墙上的码若由**旧实例**（localhost/旧域名）生成，
  即使页面修好也扫不开。需逐店核对码内域名（不涉及签名泄露，只看 host）。
- **P6-H5-02**：真实建单闭环（提交一单）—— 需授权写入，本轮**未写任何数据**。
- **P6-H5-03**：`/api/technician/` 与短链补部署（见第六节）。

---

## 八、本轮结论

- 门店报修页 **真的能打开了**：产物、路由、渲染三层都有独立证据（哈希 / Content-Type / 真实 DOM）。
- 全程**零业务写入**（489/1827/551/783/725 完全不变），未触真实员工密码，未删任何数据。
- 未 commit / 未 push（`/www` 与 `/www/server` 均不在 Git 工作区）。
- ⚠️ 短信仍禁用（`SMS_ENABLED=false`），**不得对外宣称短信已验收**。
