/**
 * R2.1.2 变异测试 —— 证明「产物复核」本身会红
 *
 * 铁律：断言不会变红 = 没有断言。
 * 本轮已经踩过一次"探测器坏了却报了产品坏了"，所以先证伪探测器再信它。
 *
 * 做法：把真实产物复制到临时文件，对副本做**一处**结构性破坏，
 *      把 probe 指向副本跑一次，期望它 exit 1；
 *      真实产物**一个字节不动**。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRC = 'storage/plugins/@local/service-ticket/dist/client/index.js';
const real = fs.readFileSync(SRC, 'utf8');
const BS = String.fromCharCode(92);
const esc = (zh) => [...zh].map((c) => BS + 'u' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');

const MUTANTS = [
  {
    name: 'M1 把「审核」退回旧文案「审核回执」',
    from: 'label: "' + esc('审核') + '"',
    to: 'label: "' + esc('审核回执') + '"',
  },
  {
    name: 'M2 删掉 64px 等宽（退回按文字撑开）',
    from: 'width: 64px !important;',
    to: '',
  },
  {
    name: 'M3 把「派工记录」挪回日常业务（daily 变 5、admin 变 9）',
    from: 'key: "daily"',
    // 不改 key，而是移除 admin 数组里的派工记录，让 admin = 9
    to: 'key: "daily"',
    mutate: (s) => s.replace('"' + esc('派工记录') + '",', ''),
  },
  {
    name: 'M4 打回 DEV-270 的旧写法 nth-child(2)',
    from: 'td [data-primary-action]',
    to: 'td [data-primary-action] /* nth-child(2) */',
  },
];

let allRed = true;
const rows = [];

for (const m of MUTANTS) {
  let mutated = real;
  if (m.mutate) mutated = m.mutate(mutated);
  else if (m.from && m.to !== undefined) mutated = mutated.split(m.from).join(m.to);

  if (mutated === real) {
    rows.push({ name: m.name, verdict: 'MUTANT INVALID（没改动任何内容）', ok: false });
    allRed = false;
    continue;
  }

  const tmp = 'storage/tmp/_r212_mutant.js';
  fs.mkdirSync('storage/tmp', { recursive: true });
  fs.writeFileSync(tmp, mutated, 'utf8');

  let red = false;
  try {
    execFileSync(process.execPath, ['scripts/_r212_bundle_probe.mjs', tmp], { stdio: 'pipe' });
  } catch {
    red = true;
  }
  fs.unlinkSync(tmp);

  rows.push({ name: m.name, verdict: red ? 'RED ✅（探测器抓到了）' : 'GREEN ❌（漏检！）', ok: red });
  if (!red) allRed = false;
}

console.log('\n=== 变异测试 ===');
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name}  → ${r.verdict}`);
console.log(`\n${allRed ? '✅ 全部变异体都被抓到：探测器可信' : '❌ 有变异体漏检：探测器不可信，不得据此下产品结论'}`);
console.log('（真实产物未被修改：' + (fs.readFileSync(SRC, 'utf8') === real ? '已验证一致' : '⚠️ 竟然变了！') + '）');
process.exit(allRed ? 0 : 2);
