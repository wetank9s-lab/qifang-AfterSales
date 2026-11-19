/**
 * 交付清单自证：文档里登记的每个 SHA256 必须与磁盘实物相符
 *
 * 为什么需要：这份文档已经出现过两次"登记值过期"（第七节 dist 值、8.3 迁移聚合）。
 * 只靠人工抄录必然漂移 ⇒ 用脚本把「文档 ↔ 实物」对齐成一条可执行的判据。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const DOC = path.join(ROOT, 'docs/ARC-V1-DELIVERY-FILES.md');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 只校验第十节（本轮补丁包）—— 前面几节是历史记录，明确声明过作废
// ⚠️ 刻意**不**校验本文件自身的哈希：改它就改哈希，登记值永远追不上，
//    那是自我引用的死循环（第一次尝试立刻踩到）。本文件的完整性靠 git 保证。
const text = fs.readFileSync(DOC, 'utf8');
const sec10 = text.slice(text.indexOf('## 十、PROD-HOTFIX-01'));

const files = [
  'nocobase/plugins/service-ticket/src/server/middleware/public-archive-gate.ts',
  'nocobase/plugins/service-ticket/src/server/plugin.ts',
  'storage/plugins/@local/service-ticket/dist/server/index.js',
  'storage/plugins/@local/service-ticket/dist/client/index.js',
  'storage/plugins/@local/service-ticket/dist/client-v2/index.js',
  'storage/plugins/@local/service-ticket/dist/build-fingerprint.json',
  'docs/arc/arc-v1-page-payload.json',
  'scripts/arc/arc-v1-rebuild-mobile-page.mjs',
  'scripts/lib/arc-uid-ownership.mjs',
  'scripts/verify-arc-uid-ownership-selftest.mjs',
  'scripts/lib/migrations-agg.mjs',
  'scripts/verify-public-archive-gate.mjs',
  'scripts/arc/build-prod-like-baseline.mjs',
  'scripts/arc/verify-arc-replay-prodlike.mjs',
];

let pass = 0;
let total = 0;
const problems = [];

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { problems.push(`${rel} : 文件不存在`); total++; continue; }
  total++;
  const h = sha(abs);
  const bytes = fs.statSync(abs).size;

  if (!sec10.includes(h)) {
    // 允许"该文件未被登记"（说明清单漏了），但要指出
    const inDoc = text.includes(h);
    problems.push(`${rel} : 第十节未登记该哈希${inDoc ? '（但文档别处出现）' : '（文档任何地方都没有）'}`);
    continue;
  }
  // 字节数也要对得上（防"哈希对了但抄错字节数"）
  const idx = sec10.indexOf(h);
  const near = sec10.slice(Math.max(0, idx - 120), idx + 120);
  const byteOk = near.includes(String(bytes));
  if (!byteOk) problems.push(`${rel} : 哈希对但字节数不符（实物 ${bytes}B）`);

  console.log(`PASS  ${h.slice(0, 16)}…  ${bytes}B  ${rel}`);
  pass++;
}

// 反向：迁移聚合
const { migrationsAgg } = await import(
  new URL(`file:///${path.join(ROOT, 'scripts/lib/migrations-agg.mjs').replace(/\\/g, '/')}`).href
);
const mig = migrationsAgg(path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/migrations'));
total++;
if (sec10.includes(mig.aggregate)) {
  console.log(`PASS  ${mig.aggregate.slice(0, 16)}…  MIGRATIONS_AGG_V1（${mig.files} 文件）`);
  pass++;
} else {
  problems.push(`MIGRATIONS_AGG_V1 未登记或已变：${mig.aggregate}`);
}
total++;
if (sec10.includes(mig.jsOnly)) {
  console.log(`PASS  ${mig.jsOnly.slice(0, 16)}…  JS_ONLY_AGG_V1（${mig.jsFiles} 个 .js）`);
  pass++;
} else {
  problems.push(`JS_ONLY_AGG_V1 未登记或已变：${mig.jsOnly}`);
}

console.log(`\n汇总：PASS ${pass} / ${total}`);
if (problems.length) {
  console.log('\n问题：');
  for (const p of problems) console.log('  - ' + p);
}
process.exit(problems.length === 0 ? 0 : 1);
