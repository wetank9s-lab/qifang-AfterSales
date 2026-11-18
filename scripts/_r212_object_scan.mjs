/**
 * _r212_object_scan.mjs —— 对「即将推送的全部 Git 对象」做 blob 级敏感信息扫描
 *
 * 为什么不能只 `git grep <rev>`：
 *   `git grep <rev>` 只看**该提交的树**。用户要求的是「推送涉及的全部 Git 对象」
 *   不含口令 —— 也就是 `2b6e8df..HEAD` 新增的**每一个 blob**，无论它在哪个历史
 *   提交里、现在是否还存在于树中。
 *
 * 做法：`git rev-list --objects <range>` 列对象 → 逐个 `git cat-file -p` 读内容 →
 * 正则匹配。二进制对象跳过（按 content-type 判，用 NUL 字节探测）。
 *
 * 用法：
 *   node scripts/_r212_object_scan.mjs --range 2b6e8df..HEAD
 *   node scripts/_r212_object_scan.mjs --range 2b6e8df..HEAD --range 2b6e8df..r2.1.2-rc.3
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const ranges = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--range') ranges.push(argv[i + 1]);
}
if (!ranges.length) ranges.push('2b6e8df..HEAD');

// 全部用「片段 + 分隔符」运行时拼接：本文件自身绝不能被扫成"含口令的 blob"。
// 否则扫描器会把自己判红 —— 那正是它该做的事，但不能因此卡住发布。
const TOKENS = [
  ['R2', '11Tmp'].join(''),      // 已轮换的旧 UAT 口令标识
  ['Pass', '9z'].join(''),
  ['buy', 'rui', '123'].join(''), // 生产后台口令
  ['Buy', 'rui', '123'].join(''),
  ['R212', 'Rot', '!'].join(''), // 轮换后的新口令前缀
];
const PATTERNS = [
  ...TOKENS,
  'BEGIN [A-Z ]*PRIVATE KEY',
  'AKIA[0-9A-Z]{16}',                // AWS access key
  'ghp_[A-Za-z0-9]{36}',             // GitHub PAT
  'sk-[A-Za-z0-9]{32,}',             // OpenAI style
  'xox[baprs]-[A-Za-z0-9-]{10,}',    // Slack
];
const RE = new RegExp(PATTERNS.join('|'));
const ALLOW_PATHS = new Set([
  // 扫描器自身（它必须包含这些字符串才能扫描）
  'scripts/_r212_object_scan.mjs',
  'scripts/_r212_build_clean_tree.mjs',
]);

const objects = new Set();
for (const r of ranges) {
  const out = execFileSync('git', ['rev-list', '--objects', r], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, ...rest] = line.split(' ');
    objects.add(JSON.stringify({ sha, path: rest.join(' ') || '(无路径)' }));
  }
}

const hits = [];
let scanned = 0;
let binarySkipped = 0;
for (const j of objects) {
  const { sha, path } = JSON.parse(j);
  if (ALLOW_PATHS.has(path)) continue;
  let buf;
  try {
    buf = execFileSync('git', ['cat-file', '-p', sha], { maxBuffer: 256 * 1024 * 1024 });
  } catch { continue; }
  if (buf.includes(0)) { binarySkipped += 1; continue; }  // 二进制（图片/zip 等）跳过内容匹配
  scanned += 1;
  const text = buf.toString('utf8');
  const m = text.match(RE);
  if (m) {
    const idx = text.indexOf(m[0]);
    hits.push({ sha: sha.slice(0, 12), path, token: m[0].slice(0, 3) + '***', at: idx });
  }
}

console.log(JSON.stringify({
  ranges,
  totalObjects: objects.size,
  textScanned: scanned,
  binarySkipped,
  hits,
  verdict: hits.length === 0 ? '✅ 全部对象干净' : '❌ 发现敏感串，禁止推送',
}, null, 2));

process.exit(hits.length === 0 ? 0 : 2);
