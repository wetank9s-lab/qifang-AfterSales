/**
 * 一次性：把 _r2xx 诊断脚本里硬编码的 UAT 口令改成走环境变量。
 *
 * 背景：仓库是 public，`const PW = 'R2xxTmp!Pass0z'` 这种写法不能入库。
 * 用法：node scripts/_r212_fix_passwd.mjs [--apply]
 *       不带 --apply 只打印将要改什么（默认 dry-run）。
 */
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const FILES = [
  '_r212_roles', '_r212_ui_verify', '_r212_cmp_pages', '_r212_goto_diag',
  '_r212_nav_diag', '_r212_store_menu', '_r212_visible_check', '_r211-login',
];

const NEEDLE = 'if (!$2)';
const REPLACEMENT = (v) =>
  `const ${v} = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;\n` +
  `if (!${v}) { console.error('缺少口令：export R212_PASS=<本地 UAT 口令>'); process.exit(1); }`;

let changed = 0;
for (const f of FILES) {
  const p = `scripts/${f}.mjs`;
  if (!fs.existsSync(p)) { console.log('SKIP    (不存在)', p); continue; }
  const src = fs.readFileSync(p, 'utf8');
  const lines = src.split(/\r?\n/);
  const v = src.match(/const\s+(PASS|PW|PWD)\s*=\s*process\.env\.R212_PASS/);
  if (!v) { console.log('SKIP    (无需修)', p); continue; }
  const varName = v[1];
  const idx = lines.findIndex((l) => l.includes(NEEDLE));
  if (idx < 0) { console.log('SKIP    (已正确)', p); continue; }
  // 把「声明行 + 错误的守卫行」合并成「声明行 + 正确守卫行」
  const declIdx = lines.findIndex((l) => new RegExp(`const\\s+${varName}\\s*=`).test(l));
  lines.splice(declIdx, idx - declIdx + 1, ...REPLACEMENT(varName).split('\n'));
  console.log(`${APPLY ? 'FIXED  ' : 'WOULD  '} ${p}  (var=${varName})`);
  if (APPLY) fs.writeFileSync(p, lines.join('\n'));
  changed += 1;
}
console.log(`\n${APPLY ? '已修改' : '待修改'} ${changed} 个文件`);
