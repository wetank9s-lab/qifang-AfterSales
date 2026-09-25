#!/usr/bin/env node
/**
 * verify-technician-h5-mutation.mjs —— **变异测试**：证明 fixture 层真的会变红
 * =============================================================================
 *
 * 铁律 8：「断言不会变红 = 没有断言」。
 * 这条铁律对**验证器自己**同样成立 —— `verify-technician-h5-selftest.mjs` 里的
 * fixture 如果只是"写上去很好看"，那它和没有一样。
 *
 * 本脚本的做法：把 P5-1 里真实踩过的坑（DEV-76 / 76b / 76c / 77 / 78 / 79）
 * **逐个塞回去**，每塞一个就跑一次 fixture 层，要求它
 * ① 必须变红，且 ② 必须是因为**预期的那条** fixture 变红。
 * 塞完立刻还原；最后再跑一次，要求回到全绿。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 它会**临时改写**源码文件（`scripts/lib/h5-contracts.mjs` 与
 *    `h5/src/api/technician.ts`），改过的行带注释标记 `—— MUTATION(...)`：
 *    · 备份在进程内存里，`finally` 里无条件还原；
 *    · 还原之后再跑一次 fixture，红了就报"没还原干净"（退出码 2）；
 *    · 万一被强杀（SIGKILL）留下脏文件：`git checkout -- <file>` 即可。
 *    因此它**不进日常流水线**，定位是"改过 checker / fixture 之后手动跑一次"的工具。
 *
 * 用法 / 退出码：
 *   0 全部变异都被抓住且已还原 / 1 有变异逃逸（= fixture 层有洞） / 2 工具自身失效
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'h5-contracts.mjs');
const CLIENT = path.join(ROOT, 'h5', 'src', 'api', 'technician.ts');
const VISIT = path.join(ROOT, 'h5', 'src', 'pages', 'Technician', 'Visit.vue');
const SELFTEST = path.join(ROOT, 'scripts', 'verify-technician-h5-selftest.mjs');

const LINE = '═'.repeat(66);

/**
 * 每个变异：`from` 是**修复后**的真实代码，`to` 是**修复前**的实现。
 * `expectIds` 是"必须变红"的 fixture id 片段 —— 用来区分
 * "被抓住了" 与 "被**别的**原因连带搞红了"。
 */
const MUTATIONS = [
  {
    name: 'DEV-76 · 回到「整份文件撒 /* */ 正则」（长度/行结构被破坏）',
    file: LIB,
    from: "export function stripJsComments(source) {\n  let out = '';",
    to:
      "export function stripJsComments(source) {\n" +
      "  // —— MUTATION(DEV-76) ——\n" +
      '  return source\n' +
      "    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')\n" +
      "    .split('\\n')\n" +
      "    .map((line) => (line.trimStart().startsWith('//') ? '' : line))\n" +
      "    .join('\\n');\n" +
      "  let out = '';",
    expectIds: ['DEV-76'],
  },
  {
    name: 'DEV-76b · 根模板用正则配平（被嵌套 <template> 截断）',
    file: LIB,
    from:
      "  if (tag === 'template') {\n" +
      "    const boundary = [raw.indexOf('<script'), raw.indexOf('<style')]\n" +
      '      .filter((v) => v > open)\n' +
      '      .sort((a, b) => a - b)[0];\n' +
      '    const end = boundary === undefined ? raw.length : boundary;\n' +
      '    return { open, bodyStart: gt + 1, bodyEnd: end, end };\n' +
      '  }',
    to:
      "  if (tag === 'template') {\n" +
      '    // —— MUTATION(DEV-76b) ——\n' +
      "    const close = raw.indexOf('</template>', gt);\n" +
      '    const end = close === -1 ? raw.length : close;\n' +
      '    return { open, bodyStart: gt + 1, bodyEnd: end, end };\n' +
      '  }',
    expectIds: ['DEV-76b', 'REAL-PASS'],
  },
  {
    name: 'DEV-76c · 退回「整份文件撒正则」→ accept="image/*" 被跨区吞掉',
    file: LIB,
    from: "export function stripSourceComments(raw, kind) {\n  if (kind !== 'vue') return stripJsComments(raw);",
    to:
      "export function stripSourceComments(raw, kind) {\n" +
      '  // —— MUTATION(DEV-76c)：修复前的实现，原样 ——\n' +
      "  if (kind === 'vue') {\n" +
      '    return raw\n' +
      "      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')\n" +
      "      .split('\\n')\n" +
      "      .map((line) => (line.trimStart().startsWith('//') ? '' : line))\n" +
      "      .join('\\n');\n" +
      '  }\n' +
      "  if (kind !== 'vue') return stripJsComments(raw);",
    expectIds: ['accept="image/*"'],
  },
  {
    name: 'DEV-77 · eqJson 退回引用比较（!==）—— 断言永不可能通过',
    file: LIB,
    from: 'export function eqJson(actual, expected, what) {\n  if (!structuralEqual(actual, expected)) {',
    to: 'export function eqJson(actual, expected, what) {\n  if (actual !== expected) {',
    expectIds: ['DEV-77'],
  },
  {
    name: 'DEV-78 · 可见文案只扫 JS 字面量（漏掉模板文本与属性值）',
    file: LIB,
    from:
      "  if (kind === 'vue') {\n" +
      '    const s = splitSfc(raw);\n' +
      '    return [\n' +
      '      ...extractTemplateText(s.template),\n' +
      "      ...extractJsStringLiterals(s.script).map((text) => ({ kind: 'js', text })),\n" +
      '    ];\n' +
      '  }',
    to:
      "  if (kind === 'vue') {\n" +
      '    // —— MUTATION(DEV-78) ——\n' +
      '    const s = splitSfc(raw);\n' +
      "    return [...extractJsStringLiterals(s.script).map((text) => ({ kind: 'js', text }))];\n" +
      '  }',
    expectIds: ['TERMINAL-COPY', 'MUT-'],
  },
  {
    name: 'DEV-79 · 渲染路径 helper 里做形态校验并 throw（白屏）',
    file: CLIENT,
    from:
      'export function photoUrl(token: string, ref: string): string {\n' +
      '  return `${BASE_PATH}/${encodePathSegment(token)}/photos/${encodePathSegment(ref)}`;\n' +
      '}',
    to:
      'export function photoUrl(token: string, ref: string): string {\n' +
      '  // —— MUTATION(DEV-79) ——\n' +
      '  return `${BASE_PATH}/${encodePathSegment(assertTokenShape(token))}/photos/${encodePathSegment(ref)}`;\n' +
      '}',
    expectIds: ['DEV-79'],
  },
  {
    name: 'DEV-80 · 金额字段退回直接 .trim()（已收费时提交静默死亡）',
    file: VISIT,
    from: '    const raw = amountText(form.reported_charge_amount);',
    to: '    // —— MUTATION(DEV-80) ——\n    const raw = form.reported_charge_amount.trim();',
    expectIds: ['DEV-80'],
  },
];

const backups = new Map();

/**
 * ⚠️ 仓库里的文件是 **CRLF**，而本脚本里的锚点按 `\n` 写。
 *    直接把锚点丢进 `includes()` 会**永远匹配不上** —— 于是每个变异都报
 *    "锚点没找到"，脚本看着在跑、其实一个变异都没施放（另一种假绿）。
 *    所以这里按文件实际的行尾把锚点对齐后再比。
 */
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function alignEol(text, eol) {
  return text.replace(/\r\n/g, '\n').split('\n').join(eol);
}

function backup(file) {
  if (!backups.has(file)) backups.set(file, fs.readFileSync(file, 'utf8'));
  return backups.get(file);
}

function restoreAll() {
  for (const [file, text] of backups) fs.writeFileSync(file, text, 'utf8');
}

function runSelftest() {
  const proc = spawnSync(process.execPath, [SELFTEST], { cwd: ROOT, encoding: 'utf8' });
  return { code: proc.status, output: `${proc.stdout ?? ''}${proc.stderr ?? ''}` };
}

function main() {
  console.log('');
  console.log(LINE);
  console.log('  变异测试：把历史的坑塞回去，fixture 层必须变红');
  console.log(LINE);

  // ---- 基线：未变异时必须全绿 ----
  const base = runSelftest();
  if (base.code !== 0) {
    console.log(`\n[工具失效] 基线就红了（exit=${base.code}）—— fixture 层自己有问题，先修它`);
    console.log(base.output.slice(-1500));
    return 2;
  }
  console.log('\n[基线] 未变异 → exit=0  ✅ 全绿');

  let escaped = 0;
  let broken = 0;

  for (const mutation of MUTATIONS) {
    const original = backup(mutation.file);
    const eol = eolOf(original);
    const from = alignEol(mutation.from, eol);
    const to = alignEol(mutation.to, eol);

    if (!original.includes(from)) {
      console.log(`\n[工具失效] ${mutation.name}`);
      console.log('    锚点没找到 —— 被测实现已改动，本变异脚本需要同步更新');
      broken += 1;
      continue;
    }
    const mutated = original.replace(from, to);
    // 变异必须真的落到文件上（否则后面"变红"就无从谈起）
    if (mutated === original) {
      console.log(`\n[工具失效] ${mutation.name} —— replace 没有产生变化`);
      broken += 1;
      continue;
    }
    fs.writeFileSync(mutation.file, mutated, 'utf8');

    const result = runSelftest();
    const hits = result.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('·') && mutation.expectIds.some((id) => line.includes(id)));

    const caught = result.code !== 0 && hits.length > 0;
    console.log(`\n[${caught ? '✅ 被抓住' : '❌ 逃逸'}] ${mutation.name}`);
    console.log(`    exit=${result.code}（期望非 0）；命中 ${hits.length} 条`);
    for (const hit of hits.slice(0, 3)) console.log(`    → ${hit}`);
    if (!caught) {
      escaped += 1;
      console.log('    ⚠️ 预期的那条 fixture 没有变红 —— 这个坑可以从检查里溜过去');
      if (result.code === 0) console.log('    （整体还是绿的：fixture 层完全没反应）');
    }
    restoreAll();
  }

  // ---- 还原校验 ----
  restoreAll();
  const after = runSelftest();
  const clean = after.code === 0;
  console.log(`\n[还原后] exit=${after.code} ${clean ? '✅ 回到全绿' : '❌ 没还原干净！'}`);
  if (!clean) console.log(after.output.slice(-1200));

  console.log('');
  console.log(LINE);
  if (escaped === 0 && broken === 0 && clean) {
    console.log(`  ✅ ${MUTATIONS.length} 个历史坑全部被 fixture 层抓住，且已还原`);
    console.log(LINE);
    console.log('');
    return 0;
  }
  console.log(
    `  ❌ 逃逸 ${escaped} 个 / 工具锚点失效 ${broken} 个 / 还原${clean ? '正常' : '失败'}`,
  );
  console.log(LINE);
  console.log('');
  return escaped === 0 && broken === 0 ? 2 : 1;
}

let code = 2;
try {
  code = main();
} finally {
  restoreAll();
}
process.exit(code);
