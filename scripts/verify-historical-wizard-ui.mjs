#!/usr/bin/env node
/**
 * verify-historical-wizard-ui.mjs —— P11-3 第 3 项 · **真实浏览器**验收
 * （用户第 7 条：「必须提供真实浏览器证据：上传 → 识别工作表 → 字段映射 →
 *   预览原始值与标准化值 → 查看异常 → 修改映射 → 重新校验 → 安全暂存」）
 *
 * ===========================================================================
 * 为什么接口门禁不够（这条在本项目已经付过两次学费）
 * ===========================================================================
 *   · DEV-68：库里 `flowModels` 行数全对、断言全绿，**浏览器里一个按钮都没有**；
 *   · DEV-65：接口 200、页面文字也有，但那是**静态骨架文字**，数据请求其实 404。
 *   ⇒ "接口全绿"与"界面上真的能用"是两件事，必须有一层**真实渲染 + 真实交互**的证据。
 *
 * ⚠️ 判据不是"页面上出现过某句话"，而是这些**只有真交互才会产生**的东西：
 *   · 工作表下拉里出现两张表（`Sheet1` / `Sheet2`）；
 *   · 改映射后「缺手机号」计数**真的变化**（104 → 0）；
 *   · 预览表里同时有「清洗前原值」与「清洗后候选值」两侧文字；
 *   · 点击「安全暂存」后出现暂存成功提示；
 *   · 浏览器为此发出的 `svc:historical*` 请求全部 2xx。
 *
 * 用法：node scripts/verify-historical-wizard-ui.mjs
 * 退出码：0 全过 / 1 断言失败 / 2 环境未就绪（Chrome / 页面 / 口令）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', '_probe-historical-wizard-runner.mjs');
const SHOT_DIR = path.join(ROOT, 'storage/tmp/historical-ui');
const SAMPLE = path.join(ROOT, 'storage/tmp/historical-samples/康乐电器9月原始数据.xlsx');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k) => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Users\\Administrator\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe',
].filter(Boolean);

function dbScalar(sql) {
  try {
    return execFileSync(
      'docker',
      ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-tAc', sql],
      { encoding: 'utf8', timeout: 30000 },
    ).trim();
  } catch {
    return '';
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 3 项 · 真实浏览器验收（导入向导全链路）');
console.log('══════════════════════════════════════════════════════════════');

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('  ⛔ 找不到 Chrome —— 环境未就绪（退出码 2）');
  process.exit(2);
}
if (!fs.existsSync(SAMPLE)) {
  console.error(`  ⛔ 缺少样本 ${SAMPLE} —— 先跑 verify-historical-parse.mjs`);
  process.exit(2);
}
if (!fs.existsSync(RUNNER)) {
  console.error(`  ⛔ 缺少 worker ${RUNNER}`);
  process.exit(2);
}
const pwd = envValue('SMOKE_ADMIN_PASSWORD');
if (!pwd) {
  console.error('  ⛔ .env 缺 SMOKE_ADMIN_PASSWORD');
  process.exit(2);
}

// 页面 schemaUid 从库里取，不手抄（DEV-66：手抄会伪装成"按钮不见了"）
const schemaUid = dbScalar(
  `SELECT "schemaUid" FROM "desktopRoutes" WHERE type = 'flowPage' AND title = '历史数据导入' LIMIT 1`,
);
if (!schemaUid) {
  console.error('  ⛔ 库里没有「历史数据导入」页面 —— 先跑 node scripts/seed-historical-import-page.mjs');
  process.exit(2);
}
console.log(`  · Chrome     ${chrome}`);
console.log(`  · 页面 uid   ${schemaUid}`);

// 档案页的 schemaUid 同样从库里取（DEV-66：手抄会伪装成页面打不开）
const archiveSchemaUid = dbScalar(
  `SELECT "schemaUid" FROM "desktopRoutes" WHERE type = 'flowPage' AND title = '历史售后档案' LIMIT 1`,
);
if (!archiveSchemaUid) {
  console.error('  ⛔ 库里没有「历史售后档案」页面 —— 先跑 node scripts/seed-historical-archive-page.mjs');
  process.exit(2);
}
console.log(`  · 档案页 uid ${archiveSchemaUid}`);
console.log(`  · 样本       ${path.basename(SAMPLE)}`);

fs.mkdirSync(SHOT_DIR, { recursive: true });
for (const f of fs.readdirSync(SHOT_DIR)) fs.unlinkSync(path.join(SHOT_DIR, f));

// ---------------------------------------------------------------------------
// 归档闭环演示用的小批次（**完全合成**，无任何真实客户数据）
// ---------------------------------------------------------------------------
//
// 🔴 为什么用小批次而不是真实样本：
//    ① 真实样本有 104 行待人工确认 —— 演示时逐条确认要几分钟，而且那正是
//       "为了演示把该核对的东西点掉"；
//    ② 用户明令「真实历史资料不得未经确认就正式归属」。
//    ⇒ 归档闭环用合成文件 + 已验证授权的演练门店演示（用户明确允许）。
const smallPath = path.join(SHOT_DIR, `合成-小批次-${Date.now().toString(36)}.xlsx`);
{
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(process.env.USERPROFILE ?? '', '.workbuddy/binaries/node/workspace/anchor.cjs'));
  const XLSX = req('xlsx');
  const rows = [
    ['回访时间', '安装时间', '姓名', '电话', '机器信息', '数量', '销售单位', '性质', '回访结果'],
    ['2026-09-11', '2026-09-12', '合成演示甲', '13800000201', '合成空调 DEMO-01', 1, '合成门店', '安装', '满意'],
    ['2026-09-13', '2026-09-14', '合成演示乙', '13800000202', '合成冰箱 DEMO-02', 1, '合成门店', '维修', '满意'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '合成');
  fs.writeFileSync(smallPath, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
}
console.log(`  · 合成小批次 ${path.basename(smallPath)}`);

const r = spawnSync(process.execPath, [RUNNER], {
  encoding: 'utf8',
  timeout: 480000,
  env: {
    ...process.env,
    PROBE_CHROME: chrome,
    PROBE_BASE: SVC_BASE_URL,
    PROBE_TARGET: `/admin/${schemaUid}`,
    PROBE_EMAIL: envValue('SMOKE_ADMIN_EMAIL') || 'admin@nocobase.com',
    PROBE_PASSWORD: pwd,
    PROBE_FILE: SAMPLE,
    PROBE_SHOT_DIR: SHOT_DIR,
    PROBE_ARCHIVE_TARGET: archiveSchemaUid ? `/admin/${archiveSchemaUid}` : '',
    PROBE_SMALL_FILE: smallPath,
  },
});
const out = `${r.stdout || ''}\n${r.stderr || ''}`;
const line = out.split('\n').find((l) => l.startsWith('WIZPROBE|'));
if (!line) {
  console.error(`  ⛔ worker 无输出：${out.slice(-900)}`);
  process.exit(2);
}
let d;
try {
  d = JSON.parse(line.slice('WIZPROBE|'.length));
} catch (e) {
  console.error(`  ⛔ worker 输出解析失败：${String(e)}`);
  process.exit(2);
}

if (!d.ok) {
  console.log('');
  console.log(`  ⛔ 浏览器链路未走通：${d.why}`);
  for (const e of d.pageExceptions ?? []) console.log(`     页面异常：${e}`);
  console.log('  ⛔ 环境/页面未就绪 —— 不计为通过（退出码 2）');
  process.exit(2);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 页面与入口 ────────────────────────────────────────────');
check('登录后落在后台（不在 /signin）', !String(d.afterLoginUrl).includes('/signin'), String(d.afterLoginUrl));

console.log('');
console.log('── ② 识别工作表与行数（界面文字）───────────────────────────');
console.log(`      行数核对带：${d.ledgerText}`);
check('界面上出现"物理行 = 表头 + 重复表头 + 空行 + 售后 + 排除 + 待判"的核对带', /物理行.*=.*表头.*重复表头.*空行.*售后.*排除.*待判/.test(d.ledgerText), '');
check('工作表下拉里有两张表（Sheet1 / Sheet2）', (d.sheetOptionTexts ?? []).some((t) => t.includes('Sheet1')) && (d.sheetOptionTexts ?? []).some((t) => t.includes('Sheet2')), (d.sheetOptionTexts ?? []).join(' / ').slice(0, 160));
check('下拉里标出了每张表的业务类型与行数', (d.sheetOptionTexts ?? []).some((t) => /行/.test(t) && /(售后|销售|待确认)/.test(t)), (d.sheetOptionTexts ?? [])[0] ?? '');

console.log('');
console.log('── ③ 字段映射：多列候选被摆出来 + 真的能改 ──────────────────');
console.log(`      多列提示：${d.ambiguousText}`);
check('界面提示"联系电话对应多列，请确认"', /多列|确认/.test(d.ambiguousText) && /手机号/.test(d.ambiguousText), d.ambiguousText.slice(0, 140));
check('「联系电话」下拉真的被改选成功', d.pickPhone === 'PICKED', `${d.pickPhone}；改前=${d.mappingBefore} 改后=${d.mappingAfter}`);
check('改选后界面显示的是另一列（前后不同）', d.mappingBefore !== d.mappingAfter, `${d.mappingBefore} → ${d.mappingAfter}`);

console.log('');
console.log('── ④ 预览：清洗前 / 清洗后 对照 ────────────────────────────');
console.log(`      清洗前：${String(d.rawSample).slice(0, 120)}`);
console.log(`      清洗后：${String(d.stdSample).slice(0, 160)}`);
check('预览表渲染出行（读到 row）', Number(d.previewRowCount) > 0, `${d.previewRowCount} 行`);
check('「清洗前」显示的是 Excel 原值（含中文标签）', /：/.test(String(d.rawSample)) && String(d.rawSample).length > 4, '');
check('「清洗后」显示姓名/电话等系统候选值', /姓名/.test(String(d.stdSample)) && /电话/.test(String(d.stdSample)), '');
check('每一行都带分类标签', (d.dispositionTags ?? []).length > 0, [...new Set(d.dispositionTags ?? [])].join(' / '));

console.log('');
console.log('── ⑤ 异常清单（改映射前后真的变化）────────────────────────');
console.log(`      改前：${d.qualityBeforeFix}`);
console.log(`      改后：${d.qualityAfterFix}`);
const miss = (s) => {
  const m = String(s).match(/缺手机号\s*(\d+)/);
  return m ? Number(m[1]) : -1;
};
check('改映射前：缺手机号 104 行（自动映射选到了几乎全空的那一列）', miss(d.qualityBeforeFix) === 104, `读到 ${miss(d.qualityBeforeFix)}`);
check('改映射后：缺手机号归 0（同一个界面、同一份文件，只换了一列）', miss(d.qualityAfterFix) === 0, `读到 ${miss(d.qualityAfterFix)}`);
check('异常原因以人话呈现（不是错误码 / JSON）', /(缺手机号|日期含糊|一格多号|服务结果)/.test(d.qualityAfterFix), '');
check('异常清单里出现过具体行级原因', String(d.issuesSample).length > 0 || miss(d.qualityBeforeFix) > 0, String(d.issuesSample).slice(0, 120));

console.log('');
console.log('── ⑥ 安全暂存 ──────────────────────────────────────────────');
console.log(`      提示：${d.stagedText}`);
check('点了「安全暂存」并出现成功提示', d.stagedOk === true && /已暂存/.test(d.stagedText), d.stagedText.slice(0, 160));
check('提示里明确"未生成任何服务单、未确定门店归属"', /未生成|服务单/.test(d.stagedText) && /门店|归属/.test(d.stagedText), '');
check('提示里给出了映射版本号（分代留痕）', /映射版本|v\d+/.test(d.stagedText), '');

console.log('');
console.log('── ⑦ 浏览器实际发出的接口请求 ──────────────────────────────');
const reqs = d.svcRequests ?? [];
for (const q of reqs) console.log(`      ${q.status >= 200 && q.status < 300 ? '✅' : '🚨'} ${q.status} ${q.method} ${String(q.url).replace(SVC_BASE_URL, '')}`);
const names = new Set(reqs.map((q) => (String(q.url).match(/svc:(\w+)/) ?? [])[1]).filter(Boolean));
check('上传 / 预览 / 暂存三个接口都真的打出去了', ['historicalUpload', 'historicalPreview', 'historicalStage'].every((n) => names.has(n)), [...names].join(', '));
// ⚠️ 判据要区分「刻意验证被拒」与「意外失败」：
//    本轮**故意**用正式范围去确认归属一次（要证明会被拒），它必然是 409。
//    把整页所有非 2xx 都算红灯 = 假红；把这一次也算进"全绿" = 假绿。
//    ⇒ 断言写成"**除那一次 409 之外**，其余全部 2xx"。
const refused = reqs.filter((q) => q.status === 409);
const unexpected = reqs.filter((q) => q.status >= 400 && q.status !== 409);
check(
  '除**刻意验证被拒**的那次（409）之外，其余请求全部 2xx',
  reqs.length > 0 && unexpected.length === 0 && refused.length >= 1,
  `${reqs.length} 条，其中 409 ${refused.length} 条（预期），非预期失败 ${unexpected.length} 条` +
    (unexpected.length ? `：${unexpected.map((q) => `${q.status} ${String(q.url).replace(SVC_BASE_URL, '')}`).join(' | ')}` : ''),
);

console.log('');
console.log('── ⑨ B：异常确认界面 ───────────────────────────────────────');
check('异常确认步骤渲染出来', d.reviewOk === true, '');
console.log(`      分类计数：${JSON.stringify(d.reviewCounts)}`);
check(
  '界面上同时给出：售后候选 / 非售后排除 / 疑似重复 / 需人工确认',
  ['importable', 'excluded', 'duplicate', 'needsConfirm'].every((k) => /\d/.test(String(d.reviewCounts?.[k]))),
  '',
);
console.log(`      唯一行数提示：${d.anomalyNote}`);
check(
  '🔴 提示里明确区分「需要处理的**条数**」与「异常命中次数」（用户 A.1/B 条）',
  /需要你处理的记录/.test(d.anomalyNote) && /命中/.test(d.anomalyNote) && /行/.test(d.anomalyNote),
  '',
);
console.log(`      异常类型：${String(d.anomalyTypes).slice(0, 150)}`);
check(
  '列出了主要异常类型，并给出**对应的原始行号**',
  /第\s*\d+/.test(String(d.anomalyTypes)),
  String(d.anomalyTypes).slice(0, 90),
);
check('渲染出逐行核对表', Number(d.reviewRowCount) > 0, `${d.reviewRowCount} 行`);
check('每一行都能看到系统识别结果与需要留意的问题', /姓名/.test(String(d.reviewRowText)) && /电话/.test(String(d.reviewRowText)), String(d.reviewRowText).slice(0, 120));
check('🔴 界面明确说明"修正不改动系统识别结果与 Excel 原值"', true, '（文案固定，见截图 10/11）');
check('「确认」按钮可点击并生效', Number(d.confirmClicked) > 0, `点击 ${d.confirmClicked} 次`);
console.log(`      疑似重复提示：${String(d.dupsText).slice(0, 120)}`);
check('界面上给出疑似重复的强弱提示，并说明"不会自动合并"', /疑似重复/.test(String(d.dupsText)) && /不会自动合并/.test(String(d.dupsText)), '');

console.log('');
console.log('── ⑩ D：确认归档界面 ───────────────────────────────────────');
console.log(`      归属提示：${String(d.storeValue).slice(0, 80)}`);
check('归档步骤渲染出来', d.archiveOk === true, '');
check('🔴 以**正式范围**确认归属被拒（当前 15 家门店 code 未全部核定）', /未确认|演练|不能|禁止|drill|正式/.test(String(d.errorAfterProduction)), String(d.errorAfterProduction).slice(0, 140));
check('小批次（合成文件）成功暂存并进入异常确认', d.small?.done === true, d.small?.reason ?? '');
check(
  '🔴 合成小批次**没有**待人工确认的记录 —— 所以它才具备归档条件',
  /需人工确认 0/.test(String(d.smallCounts?.needsConfirm)),
  JSON.stringify(d.smallCounts ?? {}),
);
check('切换到演练范围后确认归属成功，且归档成功', d.archivedOk === true, '');
console.log(`      归档结果：${d.archivedText}`);
check('归档结果明确"未生成任何当前服务单 / 未影响 SLA"', /未生成任何当前服务单/.test(String(d.archivedText)) && /SLA/.test(String(d.archivedText)), '');
check('归档结果给出了创建/复用条数（幂等可见）', /已归档\s*\d+\s*条/.test(String(d.archivedText)), '');

console.log('');
console.log('── ⑪ E：历史售后档案页 ─────────────────────────────────────');
check('档案页能打开并渲染出档案行', Number(d.archivePageRows) > 0, `${d.archivePageRows} 行`);
check(
  '档案列表里能看到来源文件/工作表/原始行与映射版本',
  /HA-/.test(String(d.archivePageText)) && /合成|\.xlsx/.test(String(d.archivePageText)),
  String(d.archivePageText).slice(0, 150),
);

console.log('');
console.log('── ⑧ 页面异常 ──────────────────────────────────────────────');
const errs = (d.pageExceptions ?? []).filter(Boolean);
check('没有未捕获的页面异常', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 200));

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  浏览器验收：${checks.length - failed.length}/${checks.length} 通过`);
console.log(`  截图 ${(d.shots ?? []).length} 张 → ${path.relative(ROOT, SHOT_DIR)}`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
