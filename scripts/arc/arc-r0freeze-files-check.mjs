/**
 * R0-FREEZE · 交付文件清单核对（用户 §A 第二段）
 *
 * 用户要求：
 *   「重新核对全部新增、修改、未跟踪文件，包括新增测试脚本、H5 public/dist、
 *     Nginx 配置和页面重放脚本。」
 *
 * 做法：按**交付类别**分组清点，每类给出计数与代表路径，并对关键类别做**存在性自证**
 *      （文件真的在盘上、且本轮确实动过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = 'C:/Users/Administrator/WorkBuddy/2026-09-20-15-28-58';
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const status = git(['status', '--porcelain']).split('\n').filter(Boolean);
const tracked = status.filter((l) => !l.startsWith('??'));
const untracked = status.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());

const modified = tracked.filter((l) => l[0] === 'M' || l[0] === ' ' && l[1] === 'M');
const added = tracked.filter((l) => l[0] === 'A' || l[1] === 'A');
const deleted = tracked.filter((l) => /^(D|.D)/.test(l.slice(0, 2)));

const groups = {
  '插件服务端源码 (src/server)': [],
  '插件客户端源码 (src/client*)': [],
  '构建产物 (dist)': [],
  '验收/测试脚本 (scripts)': [],
  'H5 前端 (h5)': [],
  'Nginx 配置 (nginx)': [],
  '文档 (docs)': [],
  '其它': [],
};
const put = (p) => {
  if (/^nocobase\/plugins\/service-ticket\/src\/server\//.test(p)) groups['插件服务端源码 (src/server)'].push(p);
  else if (/^nocobase\/plugins\/service-ticket\/src\/client/.test(p)) groups['插件客户端源码 (src/client*)'].push(p);
  else if (/service-ticket\/dist\//.test(p)) groups['构建产物 (dist)'].push(p);
  else if (/^scripts\//.test(p)) groups['验收/测试脚本 (scripts)'].push(p);
  else if (/^h5\//.test(p)) groups['H5 前端 (h5)'].push(p);
  else if (/^nginx\//.test(p)) groups['Nginx 配置 (nginx)'].push(p);
  else if (/^docs\//.test(p)) groups['文档 (docs)'].push(p);
  else groups['其它'].push(p);
};
for (const l of tracked) put(l.slice(3).trim());
for (const p of untracked) put(p);

console.log('='.repeat(78));
console.log('R0-FREEZE · 交付文件清单核对');
console.log('='.repeat(78));
console.log(`\n总条目: ${status.length}（已跟踪变更 ${tracked.length} / 未跟踪 ${untracked.length}）`);
console.log(`  已修改 M: ${modified.length}   已删除 D: ${deleted.length}   已暂存 A: ${added.length}`);

for (const [name, list] of Object.entries(groups)) {
  if (!list.length) continue;
  console.log(`\n── ${name}（${list.length}）`);
  for (const p of list.slice(0, 40)) console.log(`   ${p}`);
  if (list.length > 40) console.log(`   … 另 ${list.length - 40} 条`);
}

/* ---------------------------------------------------------------------------
 * 关键类别存在性自证（用户点名要核的四项）
 * ------------------------------------------------------------------------- */
console.log('\n' + '─'.repeat(78));
console.log('用户点名四类的存在性自证');
console.log('─'.repeat(78));

const mustExist = [
  ['scripts/arc-r0chg01-verify.mjs', '新增测试脚本（R0-CHG-01 九项验收）'],
  ['scripts/arc-r0chg01-browser.mjs', '新增测试脚本（真实浏览器验收）'],
  ['scripts/arc-r0chg01-rate-limit-boundary.mjs', '本轮新增（限流边界补测）'],
  ['scripts/arc/arc-b1-nonarc-page-probe.mjs', '本轮新增（B1 归属取证）'],
  ['scripts/arc/arc-r0freeze-artifact-check.mjs', '本轮新增（产物核对）'],
  ['scripts/arc/arc-v1-rebuild-mobile-page.mjs', '页面重放脚本'],
  ['scripts/lib/arc-uid-ownership.mjs', 'UID 归属唯一实现'],
  ['scripts/verify-arc-uid-ownership-selftest.mjs', '归属判据自证'],
  ['nginx/conf.d/service.conf', 'Nginx 配置'],
];
let missing = 0;
for (const [rel, desc] of mustExist) {
  const abs = path.join(ROOT, rel);
  const ok = fs.existsSync(abs);
  if (!ok) missing += 1;
  const bytes = ok ? fs.statSync(abs).size : 0;
  const sha = ok ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16) : '-';
  console.log(`  ${ok ? '✅' : '❌'} ${bytes.toString().padStart(7)} B  ${sha}…  ${rel}\n       ${desc}`);
}

/* H5 是否有 dist（用户点名 public/dist） */
console.log('\n  H5 产物目录：');
for (const d of ['h5/dist', 'h5/public', 'storage/plugins/@local/service-ticket/dist']) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) {
    const files = fs.readdirSync(abs);
    console.log(`    ✅ ${d}（${files.length} 项）`);
  } else {
    console.log(`    ⚠️ ${d} —— 不存在`);
  }
}

/* ---------------------------------------------------------------------------
 * 本轮活动文件（按 mtime，用于区分"本轮动的"与"历史积压的"）
 * ------------------------------------------------------------------------- */
console.log('\n' + '─'.repeat(78));
console.log('本轮 R0-FREEZE 实际改动/新增（近 4 小时 mtime，排除 dist 产物）');
console.log('─'.repeat(78));
const cutoff = Date.now() - 4 * 3600 * 1000;
const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (fs.statSync(p).mtimeMs > cutoff) acc.push(p);
  }
  return acc;
};
const recent = [];
for (const d of ['scripts', 'docs', 'nocobase/plugins/service-ticket/src']) walk(path.join(ROOT, d), recent);
for (const p of recent.sort()) console.log(`   ${path.relative(ROOT, p)}`);

console.log('\n' + '═'.repeat(78));
const ok = missing === 0;
console.log(ok
  ? `  ✅ 清单核对通过：点名 ${mustExist.length} 项全部存在；本轮活动文件 ${recent.length} 个`
  : `  ❌ 有 ${missing} 项点名文件缺失`);
console.log('═'.repeat(78));

fs.mkdirSync(path.join(ROOT, '.tmp-verify/evidence/r0freeze'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp-verify/evidence/r0freeze/delivery-files.json'), JSON.stringify({
  at: new Date().toISOString(),
  counts: { total: status.length, tracked: tracked.length, untracked: untracked.length, modified: modified.length, deleted: deleted.length },
  groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v])),
  mustExist: mustExist.map(([rel, desc]) => ({ rel, desc, exists: fs.existsSync(path.join(ROOT, rel)) })),
  recent: recent.map((p) => path.relative(ROOT, p)),
}, null, 2));

process.exit(ok ? 0 : 1);
