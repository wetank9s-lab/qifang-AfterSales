#!/usr/bin/env node
/**
 * verify-types.mjs —— TypeScript **静态检查门禁**（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 它挡的是什么（用户 2026-10-09 明确要求）
 * ===========================================================================
 * 「新增有效的 TypeScript 静态检查，避免 esbuild 构建成功但真机运行 ReferenceError。」
 *
 * 背景：`build-plugin.mjs` 用 **esbuild**，而 esbuild **只转译、不做类型检查**。
 * 于是"漏 import 一个常量"这种错误：
 *   · `node scripts/build-plugin.mjs` → ✅ 构建成功
 *   · 真机走到那条业务路径 → `ReferenceError: X is not defined` → 500
 * 本轮已经真实踩到两次（`SERVICE_MODE`、`ACL_FIELDS_AUTOFIX_ENV`），
 * 都是**只在真实业务路径上**才暴露的。
 *
 * ===========================================================================
 * 判据只锁定**一类**诊断：未声明标识符（TS2304 / TS2552）
 * ===========================================================================
 * 为什么不"tsc 全绿才算过"：本插件的宿主包（`@nocobase/*`、`react`、`antd`…）
 * 构建时被标为 **external**、插件**不声明依赖也不带 node_modules**
 * ⇒ 直接跑 tsc 会得到大量**与本仓库代码质量无关**的噪音
 *   （stub 出来的 any 会引发 TS2339，模块解析差异会引发 TS2307 …）。
 * 把噪音也当红灯 ⇒ 这条门禁一天就会被 `|| true` 掉，等于没有。
 *
 * ⇒ 因此：
 *   · **TS2304 / TS2552（Cannot find name / did you mean）⇒ 红灯**：
 *     这类**必然**在运行时变成 ReferenceError，正是要挡的东西；
 *   · 其它诊断 ⇒ **如实打印数量与前几条**（不隐藏、不假装没有），
 *     但**不判红** —— 它们是已知积压，需要单独排期，不该挡住本次工作。
 *
 * ⚠️ 能力边界（如实写明）：stub 掉的宿主包**内部类型看不到** ⇒
 *    与 NocoBase 类型相关的错误检查不到。本门禁负责"标识符层面的低级错误"。
 *
 * 用法：node scripts/verify-types.mjs
 * 退出码：0 通过 / 1 发现未声明标识符 / 2 环境未就绪（找不到 tsc 或配置）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'nocobase/plugins/service-ticket/tsconfig.check.json');

/** 本地隔离安装的 typescript（见 binary_context：所有包必须留在隔离目录内） */
const TSC_CANDIDATES = [
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc'),
];

/** 必须判红的一类：未声明标识符 */
const FATAL_CODES = ['TS2304', 'TS2552'];

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  TypeScript 静态检查（目标：esbuild 绿但真机 ReferenceError 的那一类）');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(PROJECT)) {
  console.log(`  ⛔ 找不到检查配置：${PROJECT}（环境未就绪）`);
  process.exit(2);
}
const tscPath = TSC_CANDIDATES.find((p) => fs.existsSync(p));
if (!tscPath) {
  console.log('  ⛔ 找不到 tsc（预期在隔离工作区：~/.workbuddy/binaries/node/workspace）。');
  console.log('     安装：cd ~/.workbuddy/binaries/node/workspace && npm i typescript --no-audit --no-fund');
  console.log('     —— 环境未就绪，**不**把"跑不了"当成"通过"（那正是本项目最忌的假绿）');
  process.exit(2);
}

const r = spawnSync(process.execPath, [tscPath, '--project', PROJECT], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const lines = out.split('\n').filter((l) => /error TS\d+/.test(l));

const byCode = new Map();
for (const l of lines) {
  const code = /error (TS\d+)/.exec(l)?.[1] ?? 'UNKNOWN';
  if (!byCode.has(code)) byCode.set(code, []);
  byCode.get(code).push(l);
}

const fatal = [];
for (const code of FATAL_CODES) {
  for (const l of byCode.get(code) ?? []) fatal.push({ code, line: l });
}

console.log(`  · 诊断总数：${lines.length}`);
const sorted = [...byCode.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [code, list] of sorted) {
  const tag = FATAL_CODES.includes(code) ? '🔴 判红' : '（已知积压，不判红）';
  console.log(`     ${code.padEnd(8)} ×${String(list.length).padEnd(4)} ${tag}`);
}

console.log('');
if (fatal.length === 0) {
  console.log('  ✅ 未声明标识符：0 条 —— 不存在"构建绿、真机 ReferenceError"这一类错误');
  if (lines.length) {
    console.log('');
    console.log(`  ℹ️ 另有 ${lines.length} 条**其它类别**诊断（已知积压，本次不判红）。前 5 条供参考：`);
    for (const l of lines.slice(0, 5)) console.log(`     ${l.replace(/^.*service-ticket[\\/]/, '')}`);
    console.log('     ⇒ 它们不隐藏、也不假装没有；需要单独排期收敛。');
    console.log('       为什么不一起判红：宿主包是 external、插件不带依赖 ⇒ stub 出来的 any');
    console.log('       会产生大量与本仓库代码质量无关的噪音（TS2339/TS2307…），');
    console.log('       全判红的话这条门禁一天就会被 || true 掉，等于没有。');
  }
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ✅ 通过');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}

console.log(`  ❌ 发现 ${fatal.length} 条**未声明标识符**（运行时必然 ReferenceError）：`);
for (const f of fatal.slice(0, 12)) {
  console.log(`     ${f.line.replace(/^.*service-ticket[\\/]/, '')}`);
}
console.log('');
console.log('  ⇒ 修法通常是补 import（本轮两次真实案例：漏 import 的 SERVICE_MODE、ACL_FIELDS_AUTOFIX_ENV）');
console.log('══════════════════════════════════════════════════════════════');
console.log('');
process.exit(1);
