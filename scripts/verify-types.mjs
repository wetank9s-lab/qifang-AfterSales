#!/usr/bin/env node
/**
 * verify-types.mjs —— TypeScript **静态检查门禁**（Phase 11 / P11-0，P11-3 第 1 项扩项）
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
 * 判据锁定**两类**（P11-3 第 1 项：第二类是本轮补上的盲区）
 * ===========================================================================
 *
 * 【第一类】未声明标识符（TS2304 / TS2552）—— "用了但没声明"
 *   这一类**本来就没有盲区**：P11-3 第 1 项要求"注入缺失标识符证明门禁能判红"，
 *   实测把 `Button` 从 `ticket-drawer.tsx` 的 antd 导入里拿掉 ⇒
 *   立刻报 2 条 TS2304 + 指名两行 + exit=1，恢复后复绿。
 *   ⇒ DEV-145/146 之所以漏到真机，**不是这一层的盲区，是流程盲区**：
 *     改完源码直接 build + restart，**根本没跑过这条门禁**。
 *     ⇒ 修法是把门禁**焊进构建流程**（见 build-plugin.mjs 的 preflightTypes()），
 *       让"改了源码不跑类型门禁"在流程上不可能，而不是再写一遍同样的检查。
 *
 * 【第二类】从宿主包导入了**不存在的成员**（DEV-147）—— "声明了但那个东西不存在"
 *   `types/ambient-stubs.d.ts` 把宿主包声明成**无体环境模块**
 *   （`declare module '@nocobase/client';`）⇒ 该模块的**任何**成员都解析为 `any`，
 *   包括根本不存在的成员 ⇒ 这一类**结构上不可见**（tsc 一声不响）。
 *   真实事故：DEV-147 —— 详情抽屉 `import { message } from '@nocobase/client'`，
 *   运行期 `undefined` ⇒ `message.success` 抛错 ⇒ 表现为"抽屉点不开"，
 *   而构建全绿、接口全绿、tsc 全绿。
 *   ⇒ 补法：显式白名单 `scripts/expected-types-surface.mjs`（只有核实过的成员能进来）。
 *     为什么不用 TS2305（"模块没有导出成员"）：那需要给宿主包写**完整真实**的类型声明，
 *     而我们对宿主包的导出面没有权威来源（镜像里不装 `@nocobase/client`，也没有它的
 *     `.d.ts`），写不全就是大量假红 —— 假红的下场一向是 `|| true`。
 *     详见 expected-types-surface.mjs 头部。
 *
 * ===========================================================================
 * 为什么其余诊断不判红（不是"懒得修"，是刻意的）
 * ===========================================================================
 * 本插件的宿主包（`@nocobase/*`、`react`、`antd`…）构建时被标为 **external**、
 * 插件**不声明依赖也不带 node_modules** ⇒ 直接跑 tsc 会得到大量**与本仓库代码质量
 * 无关**的噪音（stub 出来的 any 会引发 TS2339，模块解析差异会引发 TS2307 …）。
 * 把噪音也当红灯 ⇒ 这条门禁一天就会被 `|| true` 掉，等于没有。
 *
 * ⇒ 因此：
 *   · **TS2304 / TS2552 + 白名单违例 ⇒ 红灯**（前者必然在运行期 ReferenceError，
 *     后者必然在运行期拿到 undefined）；
 *   · 其它诊断 ⇒ **如实打印数量与前几条**（不隐藏、不假装没有），但**不判红**。
 *   ⚠️ 这不是"扩大忽略范围"：本轮反而**减少了**噪音 —— 把缺失的宿主模块声明补齐
 *     （`node:fs`/`node:path`/`node:buffer`/`multer`/`qrcode`）、把 5 处写错路径的
 *     type-only 导入修正后，TS2307 从 13 条降到 0 条。改的是**输入**，不是判据。
 *
 * ⚠️ 能力边界（如实写明）：stub 掉的宿主包**内部类型看不到** ⇒
 *    与 NocoBase 类型相关的错误检查不到。本门禁负责"标识符层面的低级错误"。
 *
 * ===========================================================================
 * 用法
 * ===========================================================================
 *   node scripts/verify-types.mjs              # 判红/通过
 *   node scripts/verify-types.mjs --list       # 列出受管宿主包在代码里实际用到的成员
 *                                              # （新增成员时的登记入口）
 *   node scripts/verify-types.mjs --selftest   # 自证：注入 ⇒ 判红 ⇒ 恢复 ⇒ 复绿
 *
 * 退出码：0 通过 / 1 发现必判红的问题 / 2 环境未就绪或**自证失败（工具坏了）**
 *         —— 「工具坏了」与「产品坏了」必须分开报（本项目铁律）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARDED_MODULE_SURFACE } from './expected-types-surface.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'nocobase/plugins/service-ticket');
const PROJECT = path.join(PLUGIN_DIR, 'tsconfig.check.json');
const SRC_DIR = path.join(PLUGIN_DIR, 'src');

/** 本地隔离安装的 typescript（见 binary_context：所有包必须留在隔离目录内） */
const TSC_CANDIDATES = [
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc'),
];

/** 必须判红的一类：未声明标识符 */
const FATAL_CODES = ['TS2304', 'TS2552'];

const ARGV = process.argv.slice(2);
const LIST_MODE = ARGV.includes('--list');
const SELFTEST = ARGV.includes('--selftest');

/**
 * 自证探针文件路径。
 *
 * 放在 `src/client/` 下是**故意的**：`tsconfig.check.json` 的 include 是
 * `src/**\/*.ts(x)`，所以探针走的正是**真实文件包含范围** ——
 * 而不是"另开一个配置去测一下"（那测的是另一个程序）。
 */
const PROBE_REL = 'nocobase/plugins/service-ticket/src/client/__types_gate_selftest_probe.tsx';
const PROBE_ABS = path.join(ROOT, PROBE_REL);

// ---------------------------------------------------------------------------
// 源码扫描：把"具名导入"抽出来（第二类判据的输入）
// ---------------------------------------------------------------------------

/**
 * 去掉注释，但**保留字符串字面量**。
 *
 * ⚠️ 为什么不能简单 replace：本仓库大量注释里写着示例代码
 *   （例如 `import { Plugin } from '@nocobase/client';` 就出现在注释里）。
 *   用原始文本去扫，会把注释里的示例当成真实导入 ⇒ 假红。
 *   所以按字符状态机走一遍：注释整块丢掉，字符串/模板串原样保留。
 */
function stripComments(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i++; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } continue; }
    if (state === 'block') {
      // ⚠️ 块注释里的换行必须**保留**：否则把注释整块抹掉后行号会整体前移，
      //    本仓库文件头部动辄几十行注释 ⇒ 报出来的行号会指向**完全无关**的代码。
      //    （首版就是这么错的：index.ts 的导入在 37 行，却报成第 2 行。）
      if (c === '\n') out += '\n';
      if (c === '*' && c2 === '/') { state = 'code'; i++; }
      continue;
    }
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      if (c === '\\') { out += c + (c2 ?? ''); i++; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = 'code';
      }
      out += c;
      continue;
    }
  }
  return out;
}

/** 递归收集 .ts/.tsx（与 tsconfig.check.json 的 include 对齐） */
function collectSourceFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const IMPORT_START_RE = /\bimport\b/g;
const EXPORT_FROM_RE = /\bexport\b\s*(?:type\s+)?\{([\s\S]*?)\}\s*from\s*(['"])([^'"]+)\2/g;
const IMPORT_STMT_RE = /^\bimport\b\s*(?:(type)\s+)?([\s\S]*?)\s+from\s+(['"])([^'"]+)\3/;

/** 从一个 import 子句里取出**被导入的名字**（别名取原名；默认/命名空间导入返回 []） */
function namesFromClause(clause) {
  if (clause.includes('*')) return []; // `import * as ns` —— 无具名成员可校验
  const open = clause.indexOf('{');
  if (open < 0) return []; // 默认导入 / 副作用导入
  const close = clause.lastIndexOf('}');
  if (close < open) return [];
  const inner = clause.slice(open + 1, close);
  const names = [];
  for (const raw of inner.split(',')) {
    let nm = raw.trim();
    if (!nm) continue;
    nm = nm.replace(/^type\s+/, '').trim();
    const original = nm.split(/\s+as\s+/)[0].trim();
    if (original) names.push(original);
  }
  return names;
}

/**
 * 抽出所有 `import ... from 'mod'` 与 `export ... from 'mod'`。
 *
 * 关键防误配：子句里出现 `;` / `import` / 引号 ⇒ 说明这条路匹配穿过了语句边界
 * （典型是 `import './side-effect';` 后面紧跟另一条 import），直接丢弃这一条，
 * 由下一轮 `\bimport\b` 命中真正的语句。
 */
function collectModuleReferences(code) {
  const refs = [];
  IMPORT_START_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_START_RE.exec(code))) {
    const window = code.slice(m.index, m.index + 4000);
    const stmt = IMPORT_STMT_RE.exec(window);
    if (!stmt) continue;
    const [, typeKeyword, clause, , spec] = stmt;
    if (/[;'"]|(^|\W)import\b/.test(clause) || clause.includes('import')) continue;
    for (const name of namesFromClause(clause)) {
      refs.push({ spec, name, typeOnly: Boolean(typeKeyword), index: m.index });
    }
  }
  EXPORT_FROM_RE.lastIndex = 0;
  while ((m = EXPORT_FROM_RE.exec(code))) {
    for (const name of namesFromClause(`{${m[1]}}`)) {
      refs.push({ spec: m[3], name, typeOnly: false, index: m.index, reExport: true });
    }
  }
  return refs;
}

/** 行号（1-based），用于把违例指到具体位置 */
function lineOf(code, index) {
  return code.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// 检查 1：具名导入白名单（第二类）
// ---------------------------------------------------------------------------
function checkImportSurface() {
  const guarded = new Set(Object.keys(GUARDED_MODULE_SURFACE));
  const violations = [];
  const discovered = new Map();
  for (const mod of guarded) discovered.set(mod, new Map());

  for (const file of collectSourceFiles(SRC_DIR)) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = stripComments(raw);
    for (const ref of collectModuleReferences(code)) {
      if (!guarded.has(ref.spec)) continue;
      const bucket = discovered.get(ref.spec);
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const where = `${rel}:${lineOf(code, ref.index)}`;
      if (!bucket.has(ref.name)) bucket.set(ref.name, []);
      bucket.get(ref.name).push(where);
      const allow = GUARDED_MODULE_SURFACE[ref.spec];
      if (!allow.includes(ref.name)) {
        violations.push({
          file: rel,
          line: lineOf(code, ref.index),
          spec: ref.spec,
          name: ref.name,
          typeOnly: ref.typeOnly,
          reExport: Boolean(ref.reExport),
          message:
            `从 '${ref.spec}' ${ref.reExport ? 're-export' : '导入'}的成员 '${ref.name}' ` +
            `**不在已核实的导出名单内**`,
        });
      }
    }
  }
  return { violations, discovered };
}

// ---------------------------------------------------------------------------
// 检查 2：tsc 诊断
// ---------------------------------------------------------------------------
function findTsc() {
  return TSC_CANDIDATES.find((p) => fs.existsSync(p));
}

function runTsc(tscPath) {
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
  return { lines, byCode, fatal, exitCode: r.status };
}

/** 汇总一次完整检查（两种模式与自证都走这一条路径 —— 保证"测的就是跑的那条"） */
function runChecks(tscPath) {
  const surface = checkImportSurface();
  const tsc = runTsc(tscPath);
  return { surface, tsc, failed: surface.violations.length > 0 || tsc.fatal.length > 0 };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const tscPath = findTsc();

/** 环境与**判据自身**的自检：判据为空 = 没有断言（本项目铁律 1） */
function assertJudgeIntact() {
  const problems = [];
  for (const [mod, members] of Object.entries(GUARDED_MODULE_SURFACE)) {
    if (!Array.isArray(members) || members.length === 0) {
      problems.push(`受管模块 '${mod}' 的名单为空 —— 该模块的判据等于没有断言`);
    }
  }
  if (!Object.keys(GUARDED_MODULE_SURFACE).includes('@nocobase/client')) {
    problems.push("受管模块名单里没有 '@nocobase/client' —— DEV-147 那类盲区又敞开了");
  }
  if (!fs.existsSync(PROJECT)) problems.push(`找不到检查配置：${PROJECT}`);
  if (!tscPath) problems.push('找不到 tsc（预期在隔离工作区：~/.workbuddy/binaries/node/workspace）');
  if (problems.length) {
    console.log('  ⛔ **门禁自身**未就绪（注意：这与"产品有问题"是两回事）：');
    for (const p of problems) console.log(`     ${p}`);
    console.log('     —— 环境/判据未就绪时**不**把"跑不了"当成"通过"（那正是本项目最忌的假绿）');
    process.exit(2);
  }
}
assertJudgeIntact();

// ---- --list：登记入口 ------------------------------------------------------
if (LIST_MODE) {
  const { discovered } = checkImportSurface();
  console.log('');
  console.log('══ 受管宿主包实际用到的具名成员（代码实地枚举，非凭记忆） ══');
  for (const [mod, bucket] of discovered) {
    const allow = GUARDED_MODULE_SURFACE[mod];
    const names = [...bucket.keys()].sort();
    console.log('');
    console.log(`  ${mod}  —— 已登记 ${allow.length} 个 / 代码用到 ${names.length} 个`);
    for (const name of names) {
      const ok = allow.includes(name);
      console.log(`     ${ok ? '✅' : '🔴 未登记'}  ${name.padEnd(16)} ${bucket.get(name).join('  ')}`);
    }
  }
  console.log('');
  console.log('  ⚠️ 「未登记」**不等于**"这个成员不存在"。登记前必须先核实它确实是该包的导出，');
  console.log('     再写进 scripts/expected-types-surface.mjs（核不实就别加 —— 那等于把断言改成谎话）。');
  console.log('');
  process.exit(0);
}

// ---- --selftest：注入 ⇒ 判红 ⇒ 恢复 ⇒ 复绿 --------------------------------
if (SELFTEST) {
  console.log('');
  console.log('══ 自证：这条门禁会不会真的判红（本项目铁律 1：断言不会变红 = 没有断言） ══');

  const probeCases = [
    {
      key: '第二类 · 白名单',
      expect: 'surface',
      body:
        "import { Plugin, message } from '@nocobase/client';\n" +
        'export const probe = { Plugin, message };\n',
      // 期望恰好命中 1 条，且必须指名 message（Plugin 已登记 ⇒ 不许红）
      assert: (r) => {
        const v = r.surface.violations;
        if (v.length !== 1) return `期望恰好 1 条白名单违例，实际 ${v.length} 条`;
        if (v[0].name !== 'message') return `期望指名 'message'，实际指名 '${v[0].name}'`;
        if (v[0].spec !== '@nocobase/client') return `期望来源 '@nocobase/client'，实际 '${v[0].spec}'`;
        return null;
      },
    },
    {
      key: '第一类 · 未声明标识符',
      expect: 'tsc',
      body:
        'export const probe = __svc_types_gate_selftest_definitely_undeclared__;\n',
      assert: (r) => {
        const hit = r.tsc.fatal.filter((f) => f.line.includes('__svc_types_gate_selftest_definitely_undeclared__'));
        if (hit.length === 0) return '注入未声明标识符后 TS2304/TS2552 没有命中该探针';
        if (hit[0].code !== 'TS2304') return `期望 TS2304，实际 ${hit[0].code}`;
        return null;
      },
    },
  ];

  const failures = [];
  try {
    for (const c of probeCases) {
      fs.writeFileSync(PROBE_ABS, `/* 由 verify-types.mjs --selftest 生成，勿手工保留 */\n${c.body}`, 'utf8');
      const r = runChecks(tscPath);
      if (!r.failed) {
        failures.push(`${c.key}：注入后**没有判红** —— 这条判据是假的`);
      } else {
        const bad = c.assert(r);
        if (bad) failures.push(`${c.key}：${bad}`);
        else console.log(`  ✅ ${c.key}：注入后判红，且指名的正是注入的那一项`);
      }
    }
  } finally {
    fs.rmSync(PROBE_ABS, { force: true });
  }

  // 恢复后必须复绿（不绿 ⇒ 说明刚才那次"红"根本不是探针造成的，整场自证作废）
  const after = runChecks(tscPath);
  if (after.failed) {
    const bits = [];
    if (after.surface.violations.length) bits.push(`白名单违例 ${after.surface.violations.length} 条`);
    if (after.tsc.fatal.length) bits.push(`未声明标识符 ${after.tsc.fatal.length} 条`);
    failures.push(`移除探针后仍未复绿（${bits.join(' / ')}）—— 说明上面的"红"不(只)来自探针`);
  } else {
    console.log('  ✅ 移除探针后复绿');
  }

  if (fs.existsSync(PROBE_ABS)) failures.push(`探针文件未清理干净：${PROBE_REL}`);

  console.log('');
  if (failures.length) {
    console.log('  ⛔ **自证失败** —— 这是"工具坏了"，不是"产品坏了"：');
    for (const f of failures) console.log(`     ${f}`);
    console.log('  ⇒ 请修**产生断言的方法**，不要调整产品的期望。');
    console.log('');
    process.exit(2);
  }
  console.log('  ✅ 自证通过：两类判据都真的会红，且恢复后复绿');
  console.log('');
  process.exit(0);
}

// ---- 正常模式 --------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  TypeScript 静态检查（目标：esbuild 绿但真机 ReferenceError / undefined）');
console.log('══════════════════════════════════════════════════════════════');

const { surface, tsc } = runChecks(tscPath);

console.log(`  · 源码扫描：${collectSourceFiles(SRC_DIR).length} 个文件`);
console.log(`  · 受管宿主包：${Object.keys(GUARDED_MODULE_SURFACE).join(', ')}`);
console.log(`  · tsc 诊断总数：${tsc.lines.length}（tsc 自己的退出码 ${tsc.exitCode}）`);
const sorted = [...tsc.byCode.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [code, list] of sorted) {
  const tag = FATAL_CODES.includes(code) ? '🔴 判红' : '（已知积压，不判红）';
  console.log(`     ${code.padEnd(8)} ×${String(list.length).padEnd(4)} ${tag}`);
}

console.log('');
console.log('  ── 判据明细 ──────────────────────────────────────────────');
console.log(`     ① 未声明标识符（TS2304/TS2552）           ：${tsc.fatal.length} 条`);
console.log(`     ② 宿主包具名导入白名单违例（DEV-147 类）  ：${surface.violations.length} 条`);

if (!surface.violations.length && !tsc.fatal.length) {
  console.log('');
  console.log('  ✅ 两类判据均为 0 条');
  if (tsc.lines.length) {
    console.log('');
    console.log(`  ℹ️ 另有 ${tsc.lines.length} 条**其它类别**诊断（已知积压，本次不判红）。前 5 条供参考：`);
    for (const l of tsc.lines.slice(0, 5)) console.log(`     ${l.replace(/^.*service-ticket[\\/]/, '')}`);
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

if (surface.violations.length) {
  console.log('');
  console.log(`  ❌ ${surface.violations.length} 条**宿主包具名导入**不在已核实名单内（运行期必然拿到 undefined）：`);
  for (const v of surface.violations.slice(0, 12)) {
    console.log(`     ${v.file}:${v.line}  ${v.message}`);
  }
  console.log('');
  console.log('  ⇒ 两种修法，**不要**选第三种：');
  console.log("     ① 换到真正的来源（DEV-147 就是这么修的：message 本属于 antd，不从 @nocobase/client 取）；");
  console.log('     ② 核实该成员**确实存在**后，登记进 scripts/expected-types-surface.mjs；');
  console.log('     ③ ❌ 把成员直接塞进名单、不核实 —— 那等于把一条真断言改成一句谎话。');
}

if (tsc.fatal.length) {
  console.log('');
  console.log(`  ❌ ${tsc.fatal.length} 条**未声明标识符**（运行时必然 ReferenceError）：`);
  for (const f of tsc.fatal.slice(0, 12)) {
    console.log(`     ${f.line.replace(/^.*service-ticket[\\/]/, '')}`);
  }
  console.log('');
  console.log('  ⇒ 修法通常是补 import（真实案例：漏 import 的 SERVICE_MODE、ACL_FIELDS_AUTOFIX_ENV、Button）。');
  console.log('     ⚠️ 若报的是 TS2552 且指向 URL/File/FormData 之类**运行时确实存在**的全局，');
  console.log('        那是"门禁缺一个全局声明"，补 types/ambient-stubs.d.ts，**不要**去改产品代码。');
}

console.log('══════════════════════════════════════════════════════════════');
console.log('');
process.exit(1);
