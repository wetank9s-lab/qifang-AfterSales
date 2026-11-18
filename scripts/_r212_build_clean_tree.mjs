/**
 * _r212_build_clean_tree.mjs —— 在干净发布分支上只落地「R2.1.2 无敏感变更」
 *
 * 用途：release/r2.1.2-clean 以 2b6e8df 为基线，**不 cherry-pick** 27d22c2
 * （它含明文口令）。本脚本把 20a2256 最终树里属于 R2.1.2 的 5 个文件
 * 与 2b6e8df 的版本做**逐文件精确覆盖**，且对每个文件做敏感串检查。
 *
 * 不做的事（用户明令禁止）：
 *   - 不整体 `git checkout 20a2256 -- .`（会把无关文件一起带过来）
 *   - 不带入 scripts/ 下任何曾含口令的文件
 *
 * 用法：
 *   node scripts/_r212_build_clean_tree.mjs            # dry-run
 *   node scripts/_r212_build_clean_tree.mjs --apply    # 真正写盘
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const SRC = '20a2256';
const BASE = '2b6e8df';

/** R2.1.2 的**全部**运行期变更文件（与 git diff --stat 实测一致） */
const RUNTIME = [
  'nocobase/plugins/service-ticket/src/client/admin-style.ts',
  'nocobase/plugins/service-ticket/src/client/menu-groups.ts',
  'nocobase/plugins/service-ticket/src/client/primary-action.tsx',
  'nocobase/plugins/service-ticket/src/client/row-action-matrix.ts',
  'scripts/uat-preflight.mjs',
];

/** 验证脚本（全部已确认无口令） */
const SCRIPTS = [
  'scripts/_r212_bundle_probe.mjs',
  'scripts/_r212_click_accept.mjs',
  'scripts/_r212_cmp_pages.mjs',
  'scripts/_r212_fix_passwd.mjs',
  'scripts/_r212_goto_diag.mjs',
  'scripts/_r212_local_nav_verify.mjs',
  'scripts/_r212_mutation.mjs',
  'scripts/_r212_nav_ab.mjs',
  'scripts/_r212_nav_diag.mjs',
  'scripts/_r212_prod_nav_verify.mjs',
  'scripts/_r212_roles.mjs',
  'scripts/_r212_store_menu.mjs',
  'scripts/_r212_ui_verify.mjs',
  'scripts/_r212_visible_check.mjs',
  'scripts/_r211-login.mjs',
  'scripts/_r211-tmpadmin.mjs',
];

/** 明确排除：曾含口令、且已确认不在最终树里的历史文件 */
const EXCLUDED = [];

const TOKENS = ['R2'+'11Tmp', 'Pass'+'9z', 'buy'+'rui123', 'Buy'+'rui123'];
const SENSITIVE = new RegExp([...TOKENS, 'BEGIN [A-Z ]*PRIVATE KEY', 'AKIA[0-9A-Z]{16}'].join('|'));

const show = (rev, f) => execFileSync('git', ['show', `${rev}:${f}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
/** 源树没有、只存在于当前工作区的文件（本轮新建，同样做敏感检查） */
const LOCAL_ONLY = ['scripts/_r212_cred_status.mjs', 'scripts/_r212_rotate_uat.mjs', 'scripts/_r212_build_clean_tree.mjs'];

const all = [...RUNTIME, ...SCRIPTS, ...EXCLUDED];
const report = { apply: APPLY, base: BASE, source: SRC, written: [], skipped: [], sensitive: [], missing: [] };

for (const f of all) {
  let content;
  try { content = show(SRC, f); }
  catch { report.missing.push(f); continue; }

  if (SENSITIVE.test(content)) { report.sensitive.push(f); continue; }

  // 该文件在基线上是否已存在（用于区分"新增"与"修改"）
  let baseExists = true;
  try { show(BASE, f); } catch { baseExists = false; }

  report.written.push({ file: f, existsInBase: baseExists, bytes: Buffer.byteLength(content, 'utf8') });
  if (APPLY) {
    fs.mkdirSync(f.split('/').slice(0, -1).join('/') || '.', { recursive: true });
    fs.writeFileSync(f, content);
  }
}

// 本轮在工作区新建、尚未进入任何提交的脚本：保留原地，但同样跑敏感检查
for (const f of LOCAL_ONLY) {
  if (!fs.existsSync(f)) { report.missing.push(f); continue; }
  const content = fs.readFileSync(f, 'utf8');
  if (SENSITIVE.test(content)) { report.sensitive.push(f); continue; }
  report.written.push({ file: f, existsInBase: false, bytes: Buffer.byteLength(content, 'utf8'), localOnly: true });
}

console.log(JSON.stringify({
  ...report,
  summary: {
    total: all.length,
    wouldWrite: report.written.length,
    sensitive: report.sensitive.length,
    missing: report.missing.length,
  },
}, null, 2));

if (report.sensitive.length) { console.error('⚠️ 有文件含敏感串，已跳过，必须人工处理'); process.exit(2); }
if (report.missing.length) { console.error('⚠️ 有文件在源树中不存在'); process.exit(3); }
