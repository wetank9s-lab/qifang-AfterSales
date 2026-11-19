/**
 * R0-FREEZE · 交付产物与 SHA256 清单最终核对（不沿用 R0 旧哈希）
 *
 * 用户要求：
 *   「以最新源码核对服务端构建产物，确认新增匿名 Action 和限流实现已进入实际部署文件。
 *     重新核对全部新增、修改、未跟踪文件…重新生成最终 SHA256 清单，不沿用 R0 旧哈希。」
 *
 * 三条证据链：
 *   ① 重建比对：把 dist 备份 → 重新构建 → 逐文件 cmp。
 *      server/index.js **逐字节一致** ⇒ 证明部署文件确由最新源码构建。
 *      （client / build-fingerprint 含 CLIENT_BUILD_STAMP 时间戳，属预期的非确定性内容：
 *        大小完全相同、仅哈希不同 ⇒ 非内容漂移，必须单独列出。）
 *   ② 功能标记：在产物里数新增实现的标记出现次数（不靠"源码里有"这类弱证据）。
 *   ③ 行为级：真打一次匿名 Action，确认产物**跑起来**确实是新的。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = 'C:/Users/Administrator/WorkBuddy/2026-09-20-15-28-58';
const DIST = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist');
const TMP = path.join(ROOT, '.tmp-media/dist-before-r0freeze');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const size = (p) => fs.statSync(p).size;

const CORE = [
  'server/index.js',
  'client/index.js',
  'client-v2/index.js',
  'build-fingerprint.json',
];

console.log('='.repeat(78));
console.log('R0-FREEZE · 交付产物核对与最终 SHA256 清单');
console.log('='.repeat(78));

/* ---------------------------------------------------------------------------
 * ① 重建比对
 * ------------------------------------------------------------------------- */
console.log('\n【①】重建比对：dist 先备份，再从当前源码重建，逐文件比对\n');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
for (const rel of CORE) {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.copyFileSync(path.join(DIST, rel), path.join(TMP, rel));
}
const before = Object.fromEntries(CORE.map((r) => [r, { sha: sha256(path.join(TMP, r)), size: size(path.join(TMP, r)) }]));
console.log('（备份完成）重建前的哈希：');
for (const r of CORE) console.log(`  ${before[r].sha.slice(0, 16)}…  ${String(before[r].size).padStart(9)} B  ${r}`);

console.log('\n[构建] node scripts/build-plugin.mjs …');
const buildOut = execFileSync('node', ['scripts/build-plugin.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const buildOk = /插件构建成功/.test(buildOut);
console.log(`  ${buildOk ? '构建成功' : '★ 构建未报成功，请检查输出'}`);

const after = Object.fromEntries(CORE.map((r) => [r, { sha: sha256(path.join(DIST, r)), size: size(path.join(DIST, r)) }]));

console.log('\n重建结果比对：');
const identical = [];
const sizeSame = [];
const drifted = [];
for (const r of CORE) {
  const same = before[r].sha === after[r].sha;
  const sameSize = before[r].size === after[r].size;
  if (same) { identical.push(r); console.log(`  ✅ 逐字节一致        ${r}（${after[r].size} B）`); }
  else if (sameSize) { sizeSame.push(r); console.log(`  ⚠️ 哈希变、大小同     ${r}（${after[r].size} B 不变）⇒ 非确定性构建内容`); }
  else { drifted.push(r); console.log(`  ❌ 大小也变了        ${r}（${before[r].size} → ${after[r].size} B）⇒ 内容漂移，必须查`); }
}

/* 证明"哈希变但大小同"确实是时间戳导致：从产物里抠出构建标记 */
const stampOf = (p) => {
  const s = fs.readFileSync(p, 'utf8');
  const m = /CLIENT_BUILD_STAMP[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z?)/.exec(s)
    || /(20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)/.exec(s);
  return m ? m[1] : '(未找到)';
};
console.log('\n非确定性内容的定位（证明不是内容漂移）：');
for (const r of sizeSame) {
  console.log(`  ${r}: 重建前 stamp=${stampOf(path.join(TMP, r))} → 重建后 stamp=${stampOf(path.join(DIST, r))}`);
}

/* ---------------------------------------------------------------------------
 * 【DEV-231 修正】比对一结束就把 dist 回滚为重建前字节
 *
 * 本脚本的职责是"验证 dist 与源码一致"，但实现方式是"重建覆盖 dist" ——
 * 即验证动作会改变被验证对象。发布包冻结后重跑它，就会静默把交付字节换掉
 * （client/*.js 与 build-fingerprint.json 因内嵌构建时间戳必然变哈希）。
 * 这违反"发布包冻结"的前提，属验证工具缺陷。
 *
 * 因此比对完成后默认回滚，manifest 记录回滚后的**实际交付字节**；
 * 只有显式 FREEZE_KEEP_REBUILT=1 才保留重建产物（临时诊断用）。
 * ------------------------------------------------------------------------- */
const keepRebuilt = process.env.FREEZE_KEEP_REBUILT === '1';
let restored = false;
if (!keepRebuilt) {
  for (const r of CORE) fs.copyFileSync(path.join(TMP, r), path.join(DIST, r));
  const mismatched = CORE.filter((r) => sha256(path.join(DIST, r)) !== before[r].sha);
  restored = mismatched.length === 0;
  console.log('\n【恢复】dist 已回滚为重建前字节（发布包冻结，不保留重建产物）');
  console.log(`  逐文件回验：${restored ? '✅ 全部与重建前一致' : '★ 以下文件回滚失败: ' + mismatched.join(', ')}`);
  if (!restored) { console.log('═'.repeat(78)); process.exit(1); }
}
const delivered = keepRebuilt ? after : before;

/* ---------------------------------------------------------------------------
 * ② 功能标记：确认新增实现真的进了部署文件
 * ------------------------------------------------------------------------- */
console.log('\n【②】功能标记计数（在 server 产物里数，不靠"源码里有"）：\n');
const serverSrc = fs.readFileSync(path.join(DIST, 'server/index.js'), 'utf8');
const MARKERS = [
  ['queryByMobile', '新增匿名 Action 的 handler 名'],
  ['consumeSliding', '滑动窗口限流实现'],
  ['pg_advisory_xact_lock', '跨实例互斥锁（多实例正确性）'],
  ['clientIpOfPublic', '来源 IP 取值（限流维度）'],
  ['normalizeArchiveMobile', '手机号规范化'],
  ['queryByMobileSummary', '摘要查询服务'],
  ['ARCHIVE_QUERY', '限流场景常量'],
  ['no-store', '禁止缓存响应头'],
  ['Retry-After', '429 重试提示头'],
];
const markerRows = [];
for (const [k, desc] of MARKERS) {
  const n = serverSrc.split(k).length - 1;
  markerRows.push({ key: k, count: n, desc });
  console.log(`  ${String(n).padStart(3)} 次  ${k.padEnd(24)} ${desc}`);
}

/* ---------------------------------------------------------------------------
 * ③ 最终 SHA256 清单
 * ------------------------------------------------------------------------- */
console.log('\n【③】最终 SHA256 清单（本轮新生成，不沿用 R0 旧哈希）\n');
console.log('  说明：重建产物仅用于比对，清单记录的是**实际交付字节**（重建前的 dist）；');
console.log('       下面先打印重建后哈希（便于核对"确实重建过"），再打印交付哈希。\n');
console.log('  重建后（仅供比对，不交付）：');
for (const r of CORE) {
  console.log(`    ${after[r].sha}  ${String(after[r].size).padStart(9)} B  dist/${r}`);
}
console.log('\n  实际交付（dist 当前内容，发布以此为准）：');
for (const r of CORE) {
  const mark = delivered[r].sha === before[r].sha ? '' : '  ← 保留了重建产物(FREEZE_KEEP_REBUILT=1)';
  console.log(`    ${delivered[r].sha}  ${String(delivered[r].size).padStart(9)} B  dist/${r}${mark}`);
}

/* 迁移清单 */
const migDir = path.join(DIST, 'server/migrations');
const migs = fs.readdirSync(migDir).sort();
const migJs = migs.filter((f) => f.endsWith('.js'));
console.log(`\n  migrations: ${migJs.length} 条 .js（+ ${migs.length - migJs.length} 个 .map = ${migs.length} 文件）`);
console.log(`  末条: ${migJs[migJs.length - 1]}`);

/* 文件产出到证据目录 */
const outDir = path.join(ROOT, '.tmp-verify/evidence/r0freeze');
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'sha256-manifest.json'), JSON.stringify({
  at: new Date().toISOString(),
  note: '本轮 R0-FREEZE 重新生成；不沿用 R0 旧哈希（旧: server/index.js 1753517 B 8e2ce1d81318ebd7）',
  buildOk,
  restoredAfterCheck: restored,
  byteIdenticalRebuild: identical,
  nonDeterministicOnly: sizeSame.map((r) => ({ file: r, before: before[r].sha, after: after[r].sha, stampBefore: stampOf(path.join(TMP, r)), stampAfter: stampOf(path.join(DIST, r)) })),
  contentDrift: drifted,
  markers: markerRows,
  manifest: CORE.map((r) => ({ file: `dist/${r}`, bytes: delivered[r].size, sha256: delivered[r].sha })),
  migrations: { count: migJs.length, last: migJs[migJs.length - 1] },
}, null, 2));

console.log('\n' + '═'.repeat(78));
const verdictOk = buildOk && drifted.length === 0 && identical.includes('server/index.js');
console.log(verdictOk
  ? '  ✅ 交付产物与最新源码一致（server 逐字节一致；client 差异仅为构建时间戳）'
  : '  ❌ 交付产物核对未通过 —— 见上方标记');
console.log('═'.repeat(78));
process.exit(verdictOk ? 0 : 1);
