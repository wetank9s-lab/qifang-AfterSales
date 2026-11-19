# Git 提交专项报告：多阶段变更审计与分组提交

> 日期：2026-10-22 · **已提交 5 个 commit，未 push**
> 全程未执行 `push` / `reset --hard` / `clean -fd` / `checkout -- .`

---

## 1. 提交数量

**5 个提交**（`main` 分支）。

---

## 2. 提交清单

| # | Hash | 提交信息 | 文件 | 变更 |
|---|---|---|---|---|
| 1 | **`6c08dcb`** | `fix(ux-01b): refine H5 repair form layout and unify media icons` | 7 | +937 / −117 |
| 2 | **`f060305`** | `feat(phase-11): historical archive lifecycle, workbench, and multi-stage UI` | 67 | +16523 / −175 |
| 3 | **`a6f6496`** | `feat(phase-11): remaining server/client wiring and doc updates` | 35 | +3207 / −109 |
| 4 | **`6297af6`** | `docs(phase-11): record acceptance reports and known limitations` | 93 | +14179 |
| 5 | **`9a57997`** | `feat(phase-11): add new modules referenced by preceding commits` | 27 | +5316 |

---

## 3. 各提交内容摘要

### ① `6c08dcb` — UX-01B 视觉（唯一能按阶段独立提交的一组）

```
h5/src/pages/Report/index.vue        +509
h5/src/styles/base.css               +422
h5/src/components/MediaUploader.vue  +107/−
h5/src/assets/media-icons/*.svg (4)  +4 each（新）
```
门店卡「店名+轻量拨号」同行、地址完整显示、折叠栏 flex 化、媒体图标 48 实心→24 描边。

### ② `f060305` — 插件主体 + 脚本（集成）

`client/`（含新 `historical-archives-block` 之外的既有模型）+ `server/` + `scripts/`。
覆盖 BE-02A S1/S2/S3、BE-02B Gate 2、UX-01A/C/D、BE-01/BE-04、SEC-STORE-01。

### ③ `a6f6496` — 补齐第二批

第一批 `git add` 有一处失败（被 `2>/dev/null` 吞掉），导致 `client/index.ts` 等 35 个文件未进 ②。
本批补上：`historical-review-archive.ts`、`plugin.ts`、`ticket-service.ts`、`h5/*`、`docs/*.md` 修改。

### ④ `6297af6` — 验收报告（93 份 docs + `docker-compose.uat.yml`）

BE-01 / BE-02A（各闸门）/ BE-02B（G1/G2）/ BE-04 / UX-01A~D / SEC-* / 审计收口。

### ⑤ `9a57997` — 前两批 import 但未入库的新模块

`git add -u` 只处理**已跟踪**文件，新增源文件被漏掉 → **干净检出会编译失败**。
本批补 27 个：`historical-archives-block.tsx`、5 个 collection、3 个 middleware、4 个 service、`ui-theme` 等。

**这一条是我自己发现并修正的**：如果只跑 `git add -u`，仓库 HEAD 会是"引用不存在模块"的状态。

---

## 4. 构建与测试

```
node scripts/build-plugin.mjs → ✓ 插件构建成功
（输出尾部是「重启提示」，即成功标志）
```

**唯一报错**：`date-range-item-model.tsx` 的 `TS2347` ×4 —— **提交前就存在**，非本次引入（此前多次构建都出现同样 4 行）。

**未运行**：工单相关 smoke（会写库）、历史转单（已销毁隔离环境）。按 §六 要求"不得为 Git 提交重新建单/转单"，故不跑。

---

## 5. 暂缓提交的文件

| 文件 | 原因 |
|---|---|
| **`docs/docs.zip`**（1.1 MB，2026-10-20） | **临时归档二进制**，属 §四.5「无关构建产物/临时文件」；已从暂存区撤下 |

**这是唯一剩余未提交项**（`git status` 只剩它）。

---

## 6. Git 剩余状态

```
$ git status --short
?? docs/docs.zip
```

`git diff --check` → **clean**。

---

## 7. 安全审计结果

| 检查 | 结果 |
|---|---|
| `.env` / 密码 / Token / 私钥 | **未包含**（`.env` 从未出现在 status） |
| 数据库凭据 | **未包含** |
| **真实客户姓名/手机号/地址** | **未包含**（详见下方） |
| DB dump / 媒体文件 / 私有上传目录 | **未包含** |
| 临时 UAT 数据库文件 | 无（环境已销毁） |
| 构建产物 / 临时截图（`.tmp-verify/`） | 无（在 ignore 内） |
| 生产配置修改 | 无 |

### 手机号核查（重点）

3 份报告含 11 位手机号，逐条看上下文：

```
docs/BE-02A-S2-2-REPORT.md → 手机号 `13800000109`
```

**`13800000xxx` 是本项目的合成号段**（与本次转单用的 `13800000201/202` 同段），**不是真实客户**。

### 密钥串扫描

对 `git diff --cached`（提交前）与全部新增文件扫过 `AKID` / `LTAI` / `BEGIN RSA PRIVATE` / `sk-` 长串 —— **零命中**。

命中的 3 处"敏感字样"都是**文档里的变量名说明**（`ALIYUN_SMS_ACCESS_KEY_ID`、`SIGN_SECRET`），不是值。

### `docker-compose.uat.yml`

内容只是容器编排（端口 13001、库名 `service_ticket_verify`、`env_file: .env` 引用），**不含任何凭据**。

---

## 8. 无法按阶段拆分的原因（如实说明）

多个文件的 diff **同时包含多阶段改动**，逐行交织：

| 文件 | 混入的阶段 |
|---|---|
| `client/index.ts` | UX-01A + UX-01C + UX-01D + SEC-STORE-01 + BE-02A |
| `server/plugin.ts` | 同上 + BE-02B 依赖的 action 注册 |
| `historical-review-archive.ts` | P11-3 + BE-02A + BE-02B（转单逻辑本体） |
| `docs/API.md` | 多个阶段的接口更新 |

按 §五.3「**不能丢弃任何变更；报告原因，并采用合适的集成提交**」执行：合并为集成提交，在提交信息里写明。

**没有**为了凑"按阶段提交"而丢弃任何一行。

---

## 9. 声明

- **本轮未 push**（`git log origin/main..HEAD` = **5** 个本地提交，远端未变）。
- 未执行 `git reset --hard`、`git clean -fd`、`git checkout -- .`、`git restore .`。
- 未改写任何提交历史。
- 未修改数据库。
- 未改变任何已签收的业务结论（BE-02A PASS/FROZEN、BE-02B Gate 2 PASS/FROZEN、UX-01B 视觉 PASS/FROZEN、整体 DEFERRED 均原样保留在文档中）。

---

## 10. 需要你决定的事

1. **是否 push**（5 个 commit 待推）。
2. **`docs/docs.zip`** 怎么处理：删除 / 加进 `.gitignore` / 另存别处？我**没有**擅自删它。
3. 如果你希望"按阶段拆得更细"，那需要**逐文件逐 hunk 手工拆分**（`git add -p`）—— 这在当前 16523 行规模下风险高于收益，且容易把手动拆错的半成品提交进去。**我建议保持集成提交**。
