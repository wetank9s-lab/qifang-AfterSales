# BUILD-TS-GATE-01 · 发布前 TypeScript 门禁缺口（OPEN）

> 登记：2026-10-29　状态：**方案已落地、门禁已生效、负向验证通过**；缺陷单本身保持 OPEN
> （"流程上是否还会再漏"要在下一次真实发版中观察，按用户要求独立管理，不重开已通过的 UX 验收）

---

## 1. 事实（不粉饰）

2026-10-29 BE-03/05 两页 UI 上线，**第一次部署后**才发现本次改动新引入 **9 条 TypeScript 诊断**：

| 代码 | 条数 | 例子 |
|---|---|---|
| TS2694 | 6 | `Namespace 'react' has no exported member 'CSSProperties' / 'ReactNode'` |
| TS2347 | 1 | `React.useState<any>(...)` —— untyped function call 不接受类型实参 |
| TS2322 | 2 | JSX 的 `key` 被当作普通 prop 传给组件 props |

**为什么三层门禁全绿**：

| 门禁 | 判据 | 对这 9 条 |
|---|---|---|
| `build-plugin.mjs`（esbuild） | 只转译 | ❌ 不管类型 |
| `verify-types.mjs` | 只红 **TS2304 / TS2552** + 宿主包白名单 | ❌ 不在判据内 |
| `verify-ts2741-baseline.mjs` | 只红 **TS2741** | ❌ 不在判据内 |

⇒ 这不是"某条判据写松了"，是**判据集合本身有洞**：挑错误码判红，就永远只覆盖挑中的那几个。

## 2. 门禁方案（已落地）

### 2.1 判据：不看错误码，只看"有没有新增"

| 项 | 规则 |
|---|---|
| 采集 | `tsc --project nocobase/plugins/service-ticket/tsconfig.check.json` 的全部诊断（error + warning） |
| 归一化键 | `文件 \| 代码 \| 消息（压缩空白）` —— **不含行号/列号** |
| 基线 | `scripts/expected-ts-baseline.json`：当前 **219 条 / 101 键**（历史积压） |
| 判红 | 出现新键，或同键次数变多 ⇒ **exit 1，构建中止** |
| 变少 | 只提示"可收紧基线"，**不判红**（修好了不该被罚） |
| 工具坏 | tsc 缺失 / 无输出 / 基线缺失 ⇒ **exit 2**，且不给产品结论（工具坏了 ≠ 产品坏了） |

### 2.2 为什么键里不含行号
行号会因无关改动整体漂移。含行号的基线需要每天手改，而每天手改的基线等于没有基线。
（同一取舍已写在 `verify-ts2741-baseline.mjs` 头部。）

### 2.3 为什么"新增即红"而不是"再补几个错误码"
事故的教训就是"按错误码挑"必然留缝。改成"任何新增"之后，**下一次出现没预料到的错误码也会被拦住**。
代价是：无关重构造成的诊断位移也可能判红 —— 这是有意的，要求改动者面对它，而不是让门禁自己消化。

### 2.4 不允许的变绿方式
**不得**把新错误码加进忽略名单。要放宽只能改基线文件 `--update`，且基线 diff 会被复核看到；
`--update` 的语义是"我确认这些是历史债"，不是"我不想修"。

### 2.5 接线位置
`build-plugin.mjs` 预检顺序（两份构建脚本均已接）：

```
preflight()            # 目录/入口/package.json
preflightMigrations()  # 迁移产物外部依赖
preflightTypes()       # TS2304/TS2552 + 宿主包白名单（原有）
preflightTsBaseline()  # ← BUILD-TS-GATE-01：全量诊断基线（TS2741 已含其中）
```

`prebuild-guard.mjs`（唯一构建源对比）仍在构建最前面，由 `build-plugin.mjs` 调用。

## 3. 负向验证（用一条故意引入的新类型错误）

在**两侧源**（工作区 + admin-base）同时加入：

```ts
// negative-probe: deliberate TS2322
export const __gate_probe4: number = 'x';
```

| 观察点 | 结果 |
|---|---|
| `node scripts/verify-ts-baseline.mjs` | **exit 1**：`[新键] 1× TS2322 …page-logic.ts Type 'string' is not assignable to type 'number'.` |
| `node scripts/build-plugin.mjs` | **exit 1**：`⛔ 有**新增** TypeScript 诊断 —— 不构建（BUILD-TS-GATE-01）` |
| 构建产物 | `dist/client/index.js` 哈希**未变**（`3e3e1f951a31`）⇒ 确实没编译 |
| 还原后 | 文件哈希逐字节一致；`verify-ts-baseline` **exit 0**（219→219）；`prebuild-guard` 10 项 **SAME** |

> 补充：若只在**工作区**注入，构建会先被 `prebuild-guard` 拦下（源漂移），
> 那样测不到 TS 门禁本身 —— 所以负向验证必须**两侧同时**注入。这个细节本身也是个坑，记在这里。

## 4. 基线维护

```bash
node scripts/verify-ts-baseline.mjs            # 日常检查（新增 ⇒ exit 1）
node scripts/verify-ts-baseline.mjs --list     # 看当前 219 条明细
node scripts/verify-ts-baseline.mjs --update   # 重写基线（必须人工看 diff 并说明理由）
```

历史上 `verify-ts2741-baseline.mjs` 仍保留（定向排查用），但**构建不再调用它**，避免两次 tsc 与两套判据漂移。

## 5. 仍未解决（保持 OPEN 的理由）

1. 这 219 条历史积压本身没有收敛计划 —— 门禁只保证"不再变多"。
2. 门禁依赖本机隔离环境里的 `tsc`；构建机若没有 tsc 会 exit 2（**不会**静默放过），但需要运维保证环境。
3. "发布前检查充分执行"还包含**部署前**的人工步骤（对比唯一构建源、记录 SHA）。
   本轮把它们写进了流程文档，但仍是**流程约束**，没有强制力 —— 这是 OPEN 的另一半。
