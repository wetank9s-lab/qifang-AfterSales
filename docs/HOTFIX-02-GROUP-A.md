# P6-HOTFIX-02 第二阶段 · A 组修复与部署验收报告

> 时间：2026-10-22 16:19–16:24 CST
> 本轮范围：**A 组（问题 2 / 3 / 4）**。B / C / D / E 组**未开始**（见 §6）。
> 快照（部署前 16:20:30）：`tickets 501` / `medias 566` / `sms_logs 799`
> 判定：**A 组 PASS**（问题 2 的"页面目视"仍 PENDING，理由见 §3）

---

## 1. 修改文件与 diff

### 1.1 服务端 · `services/progress-service.ts`

```diff
+ import { signStoreEntry, signingSecretOf } from './store-entry';

  view: {
    store_name: String(t.store?.name ?? ''),
+   /** 问题③：门店售后服务电话。只取**工单真实归属门店**（t.store），
+    *  不接受客户端传的 storeCode/storeId；空值回 null */
+   store_phone: ((): string | null => {
+     const v = (t as any).store?.contact_phone;
+     const s = v == null ? '' : String(v).trim();
+     return s ? s : null;
+   })(),
+   /** 问题④：该门店的合法报修入口凭据（k）。
+    *  能看进度的人本来就有权再提交 ⇒ 不扩大权限；**不下发签名主密钥** */
+   entry_k: ((): string | null => {
+     const code = String((t as any).store?.code ?? '').trim();
+     if (!code) return null;
+     try { return signStoreEntry(code, signingSecretOf(process.env)); }
+     catch { return null; }
+   })(),
```

### 1.2 前端 · `h5/src/pages/Customer/Progress.vue`

```diff
+ import { APPLIANCE_CATEGORY_OPTIONS } from '../../utils/appliance-options';

  <dt>服务门店</dt><dd>{{ view.store_name }}</dd>
+ <template v-if="storePhone">
+   <dt>服务电话</dt>
+   <dd><a class="svc-store-phone" :href="'tel:' + storePhone" data-testid="progress-store-phone">{{ storePhone }}</a></dd>
+ </template>

- {{ [view.submitted.appliance_category, view.submitted.brand_model].filter(Boolean).join(' · ') }}
+ {{ [applianceLabel, view.submitted.brand_model].filter(Boolean).join(' · ') }}

+ <a v-if="newTicketHref" class="svc-new-ticket" :href="newTicketHref" data-testid="progress-new-ticket">提交新工单</a>

+ const applianceLabel = computed(() => { ... 查 APPLIANCE_CATEGORY_OPTIONS，未知值回退原值 ... });
+ const storePhone    = computed(() => view.store_phone || '');
+ const newTicketHref = computed(() => k ? `/h5/report?k=${encodeURIComponent(k)}` : '');
```

**未改**：数据库枚举、API 既有字段、门店 ACL、Token 生命周期、媒体权限、短信配置。

---

## 2. 构建

| 产物 | 大小 |
|---|---|
| 插件 bundle | **1,483,343 B**（源码指纹 `2d4e06e3…`） |
| H5 JS | `index-ClCQXjtu.js` 161.60 kB |
| H5 CSS | `index-CRALoWuH.css` 27.02 kB |

---

## 3. 公网验证结果

### 3.1 服务端字段（真实工单，`/api/public/progress/<22位token>`）

```
"store_name":"新都圣大家电"
"store_phone":"028-83992299"      ← 问题③ 生效
"entry_k":"S01.mmKeroMjfmt-1dSPV5iUPw"  ← 问题④ 生效（签名入口）
```

### 3.2 浏览器渲染（Edge 无头，390×932，真实 token）

| 检查 | 结果 |
|---|---|
| `data-testid=progress-store-phone` | **存在** |
| 号码 `028-83992299` | **存在** |
| `tel:` 链接 | **存在** |
| 「服务电话」文字 | **存在** |
| `data-testid=progress-new-ticket` | **存在** |
| 按钮 href | `/h5/report?k=S01.mmKeroMjfmt-1dSPV5iUPw`（**只带 k，不带上一单任何信息**）✅ |

### 3.3 新工单入口可用性

| 用例 | 结果 |
|---|---|
| `/h5/report?k=<entry_k>` | **200 / 987 B** ✅ |
| `/api/public/store-entry?k=<entry_k>` | **200** ✅ |

> ⚠️ 顺带发现（**不是本轮引入**）：`?k=S09`（裸门店码）也返回 200 —— 这是既有的
> **legacy 入口兼容**（旧二维码仍可用，provenance=legacy）。属既定契约，未改动。

### 3.4 问题② 家电标签：**逻辑已改，页面目视 PENDING**

- 映射已接入 `APPLIANCE_CATEGORY_OPTIONS`（`kitchen_bath → 厨卫电器`），未知值回退原值。
- 库中确实有 **2 张** `appliance_category='kitchen_bath'` 的工单，但**其进度 token 明文不在库里**
  （只存哈希）⇒ 我**无法**打开那两张单的页面目视验证。
- 所以这一项只能给：**代码级通过 + 待真实工单出现时目视**。不写成 PASS。

---

## 4. 生产数据与权限回归

| 项 | 结果 |
|---|---|
| 部署前快照 | tickets 501 / medias 566 / sms_logs 799（16:20:30） |
| 容器 | `scqf-as-app` healthy |
| `/h5/report` / `/api/public/stores` / `/api/svc:health` | 200 / 200 / 200 |
| 其它四站点 | hd **200** / cloud **403** / sd **000** / kanma **000**（与基线一致） |
| 门店 ACL | 未改 |
| 媒体 `readBound` / 私有目录 | 未改、未映射为静态 |
| Token 生命周期（22/43 兼容） | 未改 |
| 短信配置 | 未改，未发送 |

**私有权限反例**：`entry_k` 只是**门店级公开入口**（等同墙上的二维码），不含任何客户资料；
`store_phone` 只回该工单归属门店的**公开售后电话**，不读 URL 参数 ⇒ 改参数拿不到别家电话（服务端按 `t.store_id` 取）。

---

## 5. 回滚依据

| 备份 | 位置 |
|---|---|
| H5 整目录 | `/opt/scqf-aftersales/backup/hotfix02-A-1620/h5.tgz`（61,324 B） |
| 插件 | `/opt/scqf-aftersales/backup/hotfix02-A-1620/plugin.tgz`（2,293,875 B） |
| 线上旧 H5 目录 | `/www/wwwroot/sh.scqfls.cn/h5.old.<时间戳>`（原子替换时保留） |

回滚：还原 tgz → 替换目录 → `docker restart scqf-as-app`。**不涉及数据库，不会覆盖新工单。**

---

## 6. 本轮未做（明确 PENDING）

| 组 | 内容 | 状态 |
|---|---|---|
| **B** | 问题① 默认记住上一单 + 7 天 TTL + 清除入口 + 防循环 | **未开始** |
| **C** | 问题⑥ Android 时长 + 50MB 四层限制；问题⑦ 录音布局 | **未开始** |
| **D** | 问题⑧ 登录页 Logo 403 | **未开始** |
| **E** | 问题⑤ 进度页内嵌评价 | **未开始**（且存在授权架构问题，见下） |

### E 组的架构前置（需你决策后才能动）

现有 Review Token 与 Progress Token 是**两套**（生命周期、撤销语义不同）。
执行令明确"不得把 Progress Token 原样提交给 Review API"。
要内嵌评价，必须新增一种**短期、工单绑定、服务端校验**的评价授权。
这会新增一条鉴权路径 —— **属契约扩展，需要你批准设计与风险后再做**，我不擅自接。

---

## 7. 判定

- **A 组（问题 2/3/4）：PASS**（问题 2 的页面目视单独标 PENDING，不混入 PASS）。
- **B / C / D / E：未开始**，不计入本轮通过。
- Android 真机三项（视频拍摄 / 相册视频 / 录音布局）：**PENDING**，等真机。
- 未 commit / 未 push；未改短信；未删数据。

P6：LIVE / CONDITIONAL；Release：HOLD。
