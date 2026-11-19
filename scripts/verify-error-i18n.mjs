#!/usr/bin/env node
/**
 * verify-error-i18n.mjs —— R2.2.1 第 13 条「统一中文文案」的静态门禁。
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * 「界面不出现英文报错」这件事**没有任何运行期信号** —— 它只在断网、
 * 无权限、版本冲突这些**低频路径**上才暴露，而开发时天天走的是成功路径。
 * 换句话说：这类缺陷只能靠**人偶然撞见**才会被发现，除非把它变成静态判据。
 *
 * ===========================================================================
 * 判据
 * ===========================================================================
 *   E1  八个点名错误码**全部**在 `ERROR_CODE_TEXT` 表里（少一个就红）
 *   E2  每条的 `title` / `message` 是中文：含 CJK 字符，且**不含 ASCII 英文单词**
 *       （允许 `11 位` / `6 张` 这种数字；不允许 `Network` / `permission`）
 *   E3  每条 `message` 不以英文句号结尾、不含 `undefined` / `null` 字样
 *   E4  `describeQFError` 里**第一条**分支是错误码表查询（否则业务码会被
 *       状态码分支抢走，例如 `ARCHIVE_STAGE_PHOTO_REQUIRED` 是 400）
 *   E5  客户 H5 侧 `archive-summary.ts` 不得把 `error.message` 原样返回
 *       （那是英文泄漏的最短路径）
 *   E6  两端点名码**覆盖一致**：h5 的 `archiveSummaryErrorText` 里出现的
 *       `ARCHIVE_QUERY_*` 码集合，必须等于员工端表里的同前缀集合
 *
 * ===========================================================================
 * 反向验证（这是本文件存在的意义）
 * ===========================================================================
 * 判据不会变红 = 没有断言。变异测试：从表里删掉任意一个码、把某条 message
 * 改成英文 → 必须红。做法见 `--mutate` 参数（不会修改源文件，只在内存里改）。
 *
 * 用法：
 *   node scripts/verify-error-i18n.mjs            # 正常校验
 *   node scripts/verify-error-i18n.mjs --mutate   # 自检：注入变异必须变红
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATES = path.join(ROOT, 'src-mobile/src/components/qf/states.tsx');
const H5_SUMMARY = path.join(ROOT, 'h5/src/api/archive-summary.ts');

/** 用户第 13 条点名、本轮必须在表里的八个码 */
const REQUIRED_CODES = [
  'ARCHIVE_STAGE_ORDER',
  'ARCHIVE_STAGE_PHOTO_REQUIRED',
  'ARCHIVE_STAGE_PHOTO_LIMIT',
  'ARCHIVE_STALE',
  'ARCHIVE_QUERY_BAD_MOBILE',
  'ARCHIVE_QUERY_RATE_LIMITED',
  'ARCHIVE_QUERY_UNAVAILABLE',
  'STORE_USER_NOT_LINKED',
];

const hasCJK = (s) => /[\u4e00-\u9fa5]/.test(s);
/** 英文单词：连续 3 个以上 ASCII 字母。允许 `KB` 这类缩写不出现在文案里，故阈值取 3 */
const hasAsciiWord = (s) => /[A-Za-z]{3,}/.test(s);

function results() {
  const out = [];
  const rec = (id, ok, detail) => out.push({ id, ok: !!ok, detail });
  return { out, rec };
}

/**
 * 从 `states.tsx` 源码里解析 `ERROR_CODE_TEXT` 字面量的键值。
 * ⚠️ 不 `import` 它 —— 那是 `.tsx`，node 直接跑不了，需要先构建。
 *    这里只做**文本解析**，代价是解析逻辑本身可能错，所以 E1 有一条
 *    「解析到的键数必须 ≥ 8」的自检兜底：解析失败会表现成 0 键，不会静默通过。
 */
function parseCodeTable(src) {
  const start = src.indexOf('export const ERROR_CODE_TEXT');
  if (start < 0) return null;
  // 取到下一个顶层 `export` 之前的片段
  const after = src.indexOf('\nexport ', start + 10);
  const block = src.slice(start, after < 0 ? src.length : after);
  const entries = {};
  // 逐条：`CODE: { title: '…', message: '…', … }`
  const re = /([A-Z][A-Z0-9_]{3,})\s*:\s*\{([\s\S]*?)\n  \}/g;
  let m;
  while ((m = re.exec(block))) {
    const [, code, body] = m;
    const pick = (k) => (body.match(new RegExp(`${k}:\\s*'([^']*)'`)) ?? [])[1] ?? '';
    entries[code] = { title: pick('title'), message: pick('message') };
  }
  return entries;
}

function run(override) {
  const { out, rec } = results();
  let statesSrc = fs.readFileSync(STATES, 'utf8');
  let h5Src = fs.readFileSync(H5_SUMMARY, 'utf8');

  if (override?.dropCode) {
    // 内存里删掉某条（模拟"有人新增码但只加在 if 链里"）
    statesSrc = statesSrc.replace(
      new RegExp(`\\n  ${override.dropCode}: \\{[\\s\\S]*?\\n  \\},`),
      '\n',
    );
  }
  if (override?.englishMessage) {
    statesSrc = statesSrc.replace(
      `title: '这一步必须拍照'`,
      `title: 'Photo required'`,
    );
  }
  if (override?.h5RawMessage) {
    h5Src = h5Src.replace(
      `if (msg && !/^[\\x00-\\x7F]*$/.test(msg)) return msg;`,
      `return String(error.message || '查询失败');`,
    );
  }

  const table = parseCodeTable(statesSrc);

  // ── E1 ──────────────────────────────────────────────────────────────────
  if (!table) {
    rec('E1-table-exists', false, '没有找到 `export const ERROR_CODE_TEXT`');
  } else {
    const keys = Object.keys(table);
    const missing = REQUIRED_CODES.filter((c) => !keys.includes(c));
    rec(
      'E1-eight-codes',
      keys.length >= 8 && missing.length === 0,
      `解析到 ${keys.length} 个码${missing.length ? `，缺 ${JSON.stringify(missing)}` : '，八个点名码齐全'}`,
    );

    // ── E2 / E3 ────────────────────────────────────────────────────────────
    const bad = [];
    for (const [code, v] of Object.entries(table)) {
      for (const field of ['title', 'message']) {
        const s = v[field];
        if (!s) bad.push(`${code}.${field} 为空`);
        else if (!hasCJK(s)) bad.push(`${code}.${field} 无中文`);
        else if (hasAsciiWord(s)) bad.push(`${code}.${field} 含英文单词：${s.slice(0, 40)}`);
        else if (/undefined|null/i.test(s)) bad.push(`${code}.${field} 含 undefined/null`);
        else if (/[a-zA-Z]$/.test(s) || /\.$/.test(s) && !/[\u4e00-\u9fa5]/.test(s)) bad.push(`${code}.${field} 以英文句号结尾`);
      }
    }
    rec('E2-chinese-only', bad.length === 0, bad.length ? bad.join(' | ') : `${Object.keys(table).length} 条全部为中文、无英文单词`);
    rec('E3-no-placeholder', Object.values(table).every((v) => v.title && v.message), '每条都有 title 与 message');
  }

  // ── E4 错误码表必须是第一条分支 ──────────────────────────────────────────
  const fnStart = statesSrc.indexOf('export function describeQFError');
  const fnBody = fnStart >= 0 ? statesSrc.slice(fnStart, fnStart + 3000) : '';
  // 第一条 `if (…)` 必须是表查询
  const firstIf = (fnBody.match(/\n  if \(([^\n]*)\)/) ?? [])[1] ?? '';
  rec(
    'E4-code-table-first',
    /ERROR_CODE_TEXT\[code\]/.test(firstIf),
    `第一条 if 是 ${JSON.stringify(firstIf.slice(0, 60))}（须包含 ERROR_CODE_TEXT[code]）`,
  );

  // ── E5 h5 不得原样返回 message ──────────────────────────────────────────
  const rawReturn = /return\s+String\(error\.message[^;]*;/.test(h5Src);
  const guardsEnglish = /\/\^\[\\x00-\\x7F\]\*\$\/\.test\(msg\)/.test(h5Src);
  rec(
    'E5-h5-no-raw-message',
    !rawReturn && guardsEnglish,
    `原样返回=${rawReturn} 有英文守卫=${guardsEnglish}`,
  );

  // ── E6 两端查询码覆盖一致 ────────────────────────────────────────────────
  const mobileCodes = Object.keys(table ?? {}).filter((c) => c.startsWith('ARCHIVE_QUERY_'));
  const h5Codes = [...new Set((h5Src.match(/ARCHIVE_QUERY_[A-Z_]+/g) ?? []))];
  const same =
    mobileCodes.length > 0 &&
    mobileCodes.length === h5Codes.length &&
    mobileCodes.every((c) => h5Codes.includes(c));
  rec(
    'E6-two-sided-parity',
    same,
    `员工端=${JSON.stringify(mobileCodes)} 客户 H5=${JSON.stringify(h5Codes)}`,
  );

  return out;
}

function report(list, title) {
  console.log('');
  console.log('─'.repeat(78));
  console.log(title);
  console.log('─'.repeat(78));
  for (const r of list) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.detail}`);
  const fail = list.filter((r) => !r.ok);
  console.log('');
  console.log(`  共 ${list.length} 条判据，通过 ${list.length - fail.length}，失败 ${fail.length}`);
  console.log('');
  return fail.length;
}

const mutate = process.argv.includes('--mutate');

if (!mutate) {
  const fail = report(run(), 'R2.2.1 第 13 条 · 中文文案门禁');
  process.exit(fail === 0 ? 0 : 1);
}

// ── 变异测试：每个变异都必须让门禁变红，否则说明判据是摆设 ─────────────────
console.log('');
console.log('═'.repeat(78));
console.log('变异测试：每个变异都必须让门禁变红（红不了 = 判据无效）');
console.log('═'.repeat(78));

const mutants = [
  ['dropCode', { dropCode: 'ARCHIVE_STAGE_PHOTO_REQUIRED' }, 'E1-eight-codes', '删掉点名的错误码'],
  ['dropCode2', { dropCode: 'STORE_USER_NOT_LINKED' }, 'E1-eight-codes', '删掉账号未绑定码'],
  ['english', { englishMessage: true }, 'E2-chinese-only', '把某条 title 改成英文'],
  ['h5raw', { h5RawMessage: true }, 'E5-h5-no-raw-message', 'h5 原样返回 error.message'],
];

let bad = 0;
for (const [, override, expectRed, label] of mutants) {
  const list = run(override);
  const target = list.find((r) => r.id === expectRed);
  const wentRed = target ? !target.ok : true;
  console.log(`  ${wentRed ? '✓' : '✗'} 变异「${label}」→ ${expectRed} ${wentRed ? '变红（正确）' : '仍是绿的 —— 判据无效！'}`);
  if (!wentRed) bad += 1;
}
console.log('');
console.log(`  变异 ${mutants.length} 个，失效 ${bad} 个`);
// ⚠️ 变异测试自身失败走 exit 2：与「产品红（exit 1）」区分开。
//    混在一起会让人误判成"改坏了"，从而去修不该修的东西。
process.exit(bad === 0 ? 0 : 2);
