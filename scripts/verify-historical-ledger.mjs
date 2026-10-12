#!/usr/bin/env node
/**
 * verify-historical-ledger.mjs —— P11-3 第 3 项 · **统计口径台账**门禁
 *
 * ===========================================================================
 * 它为什么存在（用户 2026-10-12 第 1 条，原话照抄在下面）
 * ===========================================================================
 *  「报告中五份 xlsx 的数据行逐项相加为 3172，而文字写 3196，相差 24 行；
 *    排除东山 849 行后的 2323 是一致的。请逐文件、逐工作表明确区分：
 *    Excel 原始物理行 / 标题或重复表头 / 空行 / 已分类的售后行 /
 *    销售配送等排除行 / 业务类型待判断行。以上按统一规则求和，
 *    说明 24 行差异来自哪里。**不得通过直接修改期望值制造一致。**」
 *
 * ⇒ 本脚本**不**接受任何"期望总数"参数。它对账的方式是：
 *      ① 每一张工作表断言 `物理行 == 表头 + 重复表头 + 空行 + 售后 + 排除 + 待判`；
 *      ② 断言两个口径的差额**恰好等于**东山 Sheet1 的（表头 + 重复表头）；
 *      ③ 把两套口径**都**打印出来，让差异自己说话。
 *
 *  ---------------------------------------------------------------------------
 *  24 行的来历（已由本脚本断言，不是推算）
 *  ---------------------------------------------------------------------------
 *    东山 Sheet1：物理行 873 = 表头 1 + 重复表头 23 + 空行 0 + **数据行 849**
 *
 *    物理行口径：873 + 831 + 569 + 341 + 582 = **3196**
 *    数据行口径：849 + 831 + 569 + 341 + 582 = **3172**   差 = 24 = 1 + 23
 *
 *  而报告中「合计 3953」「扣东山 849 后 2323」用的都是**数据行**口径 ——
 *  于是同一段文字里两套口径并存，且都自称已对账。
 *  ⇒ 结论：**3196 是把东山 Sheet1 的物理行当成数据行加进去的结果**；
 *     正确的数据行合计是 **3172**。文档按此更正，不修改任何期望值。
 *
 * ===========================================================================
 * 另一条：字段质量异常必须**单独**统计
 * ===========================================================================
 *  「「业务类型待确认 0」不代表字段质量异常 0。多手机号、模糊日期、
 *    缺手机号、异常服务结果等必须另外统计。」
 *
 *  ⇒ 台账（互斥、可求和）与质量（一行可命中多项）**分开断言**，
 *     并断言"待判 0 行"的同时"质量异常 > 0 行" —— 这两件事同时成立才是真的。
 *
 * ===========================================================================
 * 设计要点（沿用 P11-3 第 2 项的纪律）
 * ===========================================================================
 *  · 在**容器内**跑，require 的是**真实构建产物**；
 *  · 样本从 `storage/tmp/historical-samples/` 读（gitignored，仓库里无客户数据）；
 *  · 退出码：0 全过 / 1 断言失败（产品问题）/ 2 环境未就绪或**本脚本自身**有问题。
 *
 * 用法：node scripts/verify-historical-ledger.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIST = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
const TMP = path.join(ROOT, 'storage/tmp');
const SAMPLES = path.join(TMP, 'historical-samples');
const RUNNER_DIR = path.join(TMP, 'historical-ledger');
const CONTAINER = 'svc-app';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 3 项 · 历史 Excel 统计台账（逐文件逐工作表对账）');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(PLUGIN_DIST)) {
  console.error(`  ⛔ 找不到插件产物 ${path.relative(ROOT, PLUGIN_DIST)} —— 先跑 node scripts/build-plugin.mjs`);
  process.exit(2);
}
const dc = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
if (!String(dc.stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行 —— 环境未就绪，不计为通过`);
  process.exit(2);
}
if (!fs.existsSync(SAMPLES) || fs.readdirSync(SAMPLES).length === 0) {
  console.error(`  ⛔ 样本目录为空：${SAMPLES} —— 先跑 verify-historical-parse.mjs 拷样本`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 容器内 runner
// ---------------------------------------------------------------------------
fs.mkdirSync(RUNNER_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RUNNER_DIR, 'run.js'),
  `const fs = require('fs');
const path = require('path');
const svc = require('/app/nocobase/node_modules/@local/service-ticket');
const hi = svc.historicalImport;
const dir = '/app/nocobase/storage/tmp/historical-samples';
const out = [];
for (const f of fs.readdirSync(dir).filter((x) => /\\.(xlsx|xls)$/i.test(x))) {
  const buf = fs.readFileSync(path.join(dir, f));
  const r = hi.parseWorkbook(f, buf);
  out.push({
    file: f,
    isXlsx: /\\.xlsx$/i.test(f),
    ledger: r.ledger,
    quality: r.quality,
    totals: r.totals,
    sheets: r.sheets.map((s) => ({
      sheet: s.sheet,
      classification: s.classification,
      headerRow: s.headerRow,
      mergedRangeCount: s.mergedRangeCount,
      ledger: s.ledger,
      quality: s.quality,
      header: s.header,
      fields: s.mapping.fields,
      ambiguous: s.mapping.ambiguous,
      // 每一列的非空计数 —— 用来证明"某个异常数字来自映射选错列，而不是数据缺失"
      nonEmptyPerCol: s.header.map((_h, c) =>
        s.rows.reduce((n, row) => n + (row.raw['c' + c] != null && String(row.raw['c' + c]).trim() !== '' ? 1 : 0), 0),
      ),
    })),
  });
}
console.log(JSON.stringify(out));
`,
);

const run = spawnSync(
  'docker',
  ['exec', CONTAINER, 'node', '/app/nocobase/storage/tmp/historical-ledger/run.js'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (run.error || run.status !== 0) {
  console.error(`  ⛔ 容器内 runner 失败（status=${run.status}）：${String(run.stderr ?? run.error).slice(0, 800)}`);
  process.exit(2);
}
let data;
try {
  data = JSON.parse(String(run.stdout ?? ''));
} catch (e) {
  console.error(`  ⛔ runner 输出不是合法 JSON：${String(e)}`);
  process.exit(2);
}
if (!Array.isArray(data) || data.length === 0) {
  console.error('  ⛔ runner 没有产出任何文件结果');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// ① 台账打印
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 逐文件逐工作表台账 ──────────────────────────────────────');
console.log(
  '文件/工作表'.padEnd(30) +
    '物理行'.padStart(7) +
    '表头'.padStart(6) +
    '重复表头'.padStart(9) +
    '空行'.padStart(6) +
    '售后'.padStart(6) +
    '排除'.padStart(6) +
    '待判'.padStart(6) +
    '平衡'.padStart(6),
);
console.log('─'.repeat(76));
let allBalanced = true;
for (const f of data) {
  for (const s of f.sheets) {
    const L = s.ledger;
    if (L.balance !== 0) allBalanced = false;
    const label = (s.sheet === f.file ? '' : f.file.replace(/9月原始数据\.(xlsx|xls)$/, '') + '/') + s.sheet;
    console.log(
      label.padEnd(30) +
        String(L.excelRows).padStart(7) +
        String(L.headerRows).padStart(6) +
        String(L.repeatedHeaderRows).padStart(9) +
        String(L.blankRows).padStart(6) +
        String(L.afterSalesRows).padStart(6) +
        String(L.excludedRows).padStart(6) +
        String(L.undeterminedRows).padStart(6) +
        String(L.balance).padStart(6),
    );
  }
}
console.log('─'.repeat(76));
const grand = data.reduce(
  (acc, f) => {
    for (const k of Object.keys(acc)) acc[k] += f.ledger[k];
    return acc;
  },
  { excelRows: 0, headerRows: 0, repeatedHeaderRows: 0, blankRows: 0, afterSalesRows: 0, excludedRows: 0, undeterminedRows: 0, balance: 0 },
);
grand.balance =
  grand.excelRows -
  (grand.headerRows + grand.repeatedHeaderRows + grand.blankRows + grand.afterSalesRows + grand.excludedRows + grand.undeterminedRows);
console.log(
  '合计'.padEnd(30) +
    String(grand.excelRows).padStart(7) +
    String(grand.headerRows).padStart(6) +
    String(grand.repeatedHeaderRows).padStart(9) +
    String(grand.blankRows).padStart(6) +
    String(grand.afterSalesRows).padStart(6) +
    String(grand.excludedRows).padStart(6) +
    String(grand.undeterminedRows).padStart(6) +
    String(grand.balance).padStart(6),
);

check(
  '每一张工作表：物理行 == 表头 + 重复表头 + 空行 + 售后 + 排除 + 待判',
  allBalanced && grand.balance === 0,
  `总平衡差 ${grand.balance}`,
);

// ---------------------------------------------------------------------------
// ② 两个口径的差额 == 东山的（表头 + 重复表头）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② 3172 / 3196 的 24 行差异 ────────────────────────────────');
const xlsxFiles = data.filter((f) => f.isXlsx);
const xlsFiles = data.filter((f) => !f.isXlsx);
const dataRowSum = (list) => list.reduce((n, f) => n + f.totals.dataRows, 0);

const xlsxData = dataRowSum(xlsxFiles);

const dongshanSheet = data
  .find((f) => f.file.startsWith('东山'))
  ?.sheets?.find((s) => s.sheet === 'Sheet1');
const dongshanRows = dongshanSheet?.ledger.excludedRows ?? null;
const dongshanNonData = dongshanSheet
  ? dongshanSheet.ledger.headerRows + dongshanSheet.ledger.repeatedHeaderRows
  : null;

/**
 * 三个数字，三种口径 —— 全部打印，让差异自己说话。
 *
 *   ① 数据行（正确）  ：东山 849 + 其余 2318 = **3172**
 *   ② 报告里的 3196   ：东山 **873**（= 849 + 1 表头 + 23 重复表头）+ 其余 2318
 *                        ⇒ 把东山的**物理行**当成数据行加进去了
 *   ③ 全物理行        ：五份文件的物理行合计 = 3345（含各文件的表头与空行）
 *                        ⇒ 这个数字**没人报过**，列在这里是为了说明
 *                          "3196 不是全物理行口径"，别再找错方向
 */
const restXlsx = xlsxFiles.filter((f) => !f.file.startsWith('东山'));
const restXlsxData = dataRowSum(restXlsx);
const historicalXlsx = (dongshanSheet?.ledger.excelRows ?? 0) + restXlsxData;
const allPhysicalXlsx = xlsxFiles.reduce((n, f) => n + f.ledger.excelRows, 0);

console.log(`  ① 数据行口径（正确）    = 东山 ${dongshanRows} + 其余 ${restXlsxData} = ${xlsxData}`);
console.log(`  ② 报告里的 3196         = 东山 ${dongshanSheet?.ledger.excelRows}（物理行）+ 其余 ${restXlsxData} = ${historicalXlsx}`);
console.log(`  ③ 五份全物理行口径      = ${allPhysicalXlsx}（此数字此前无人报出，列出以免误认）`);
console.log(`  ② − ① = ${historicalXlsx - xlsxData}  = 东山 Sheet1 表头 ${dongshanSheet?.ledger.headerRows} + 重复表头 ${dongshanSheet?.ledger.repeatedHeaderRows} = ${dongshanNonData}`);

check('报告中的 3196 **确实**等于 数据行合计 3172 + 东山非数据行 24', historicalXlsx - xlsxData === dongshanNonData && historicalXlsx === 3196, `${historicalXlsx} - ${xlsxData} = ${historicalXlsx - xlsxData} vs ${dongshanNonData}`);
check('24 行的构成：1 个表头行 + 23 个重复表头行', dongshanSheet?.ledger.headerRows === 1 && dongshanSheet?.ledger.repeatedHeaderRows === 23, `${dongshanSheet?.ledger.headerRows} + ${dongshanSheet?.ledger.repeatedHeaderRows}`);
check('3196 不是全物理行口径（排除第三种误判）', allPhysicalXlsx !== 3196, `全物理行 ${allPhysicalXlsx}`);

const sevenData = dataRowSum(data);
console.log(
  `  7 份文件 · 数据行合计    = ${data.map((f) => f.totals.dataRows).join(' + ')} = ${sevenData}`,
);
check('七份文件数据行合计 == 售后 + 排除 + 待判', sevenData === grand.afterSalesRows + grand.excludedRows + grand.undeterminedRows, `${sevenData}`);
check(
  '五份 xlsx 扣掉东山 == 2323（用户给的参照值，注意它是 **xlsx 子集**不是七份）',
  xlsxData - dongshanRows === 2323,
  `${xlsxData} - ${dongshanRows} = ${xlsxData - dongshanRows}`,
);
check('2 份 xls 数据行合计 == 781（160 + 621）', dataRowSum(xlsFiles) === 781, String(dataRowSum(xlsFiles)));
check('五份 xlsx 数据行 + 两份 xls 数据行 == 七份合计', xlsxData + dataRowSum(xlsFiles) === sevenData, `${xlsxData} + ${dataRowSum(xlsFiles)} = ${sevenData}`);

// ---------------------------------------------------------------------------
// ③ 字段质量异常（与台账分开）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ 字段质量异常（一行可命中多项，不互斥）──────────────────');
console.log(
  '文件/工作表'.padEnd(30) +
    '多手机号'.padStart(8) +
    '含糊日期'.padStart(9) +
    '缺手机号'.padStart(9) +
    '异常结果'.padStart(9),
);
console.log('─'.repeat(76));
for (const f of data) {
  for (const s of f.sheets) {
    const label = f.file.replace(/9月原始数据\.(xlsx|xls)$/, '') + '/' + s.sheet;
    console.log(
      label.padEnd(30) +
        String(s.quality.multiPhoneRows).padStart(8) +
        String(s.quality.ambiguousDateRows).padStart(9) +
        String(s.quality.missingPhoneRows).padStart(9) +
        String(s.quality.abnormalReviewRows).padStart(9),
    );
  }
}
const qTotal = data.reduce(
  (acc, f) => {
    acc.multiPhoneRows += f.quality.multiPhoneRows;
    acc.ambiguousDateRows += f.quality.ambiguousDateRows;
    acc.missingPhoneRows += f.quality.missingPhoneRows;
    acc.abnormalReviewRows += f.quality.abnormalReviewRows;
    return acc;
  },
  { multiPhoneRows: 0, ambiguousDateRows: 0, missingPhoneRows: 0, abnormalReviewRows: 0 },
);
console.log('─'.repeat(76));
console.log(
  '合计'.padEnd(30) +
    String(qTotal.multiPhoneRows).padStart(8) +
    String(qTotal.ambiguousDateRows).padStart(9) +
    String(qTotal.missingPhoneRows).padStart(9) +
    String(qTotal.abnormalReviewRows).padStart(9),
);

check('业务类型待判断 = 0（分类层面）', grand.undeterminedRows === 0, String(grand.undeterminedRows));
check(
  '但字段质量异常**不是** 0（"待判 0"≠"干净"）',
  qTotal.multiPhoneRows + qTotal.ambiguousDateRows + qTotal.missingPhoneRows + qTotal.abnormalReviewRows > 0,
  `合计 ${qTotal.multiPhoneRows + qTotal.ambiguousDateRows + qTotal.missingPhoneRows + qTotal.abnormalReviewRows}`,
);
check('四项质量计数均来自 sheet.quality（与 totals 逐项相等）', data.every((f) => f.totals.multiPhoneRows === f.quality.multiPhoneRows && f.totals.ambiguousDateRows === f.quality.ambiguousDateRows && f.totals.missingPhoneRows === f.quality.missingPhoneRows && f.totals.abnormalReviewRows === f.quality.abnormalReviewRows), '单一来源');
check('质量异常不得超过数据行总数（异常是"行"的计数）', Object.values(qTotal).every((n) => n <= sevenData), `最大 ${Math.max(...Object.values(qTotal))} ≤ ${sevenData}`);

// ---------------------------------------------------------------------------
// ③b 异常数字的**来源**必须说得清（否则"104 行缺手机号"会被读成"数据没电话"）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③b 最大那个异常数字的来源 ─────────────────────────────────');
const kangle2 = data.find((f) => f.file.startsWith('康乐'))?.sheets?.find((s) => s.sheet === 'Sheet2');
if (!kangle2) {
  check('找得到康乐 Sheet2（用于核对异常来源）', false, '未找到');
} else {
  const phoneIdx = kangle2.fields.customerPhone;
  const ambiguousPhone = (kangle2.ambiguous ?? []).find((a) => a.field === 'customerPhone');
  console.log(
    `  自动映射把 customerPhone 定在第 ${phoneIdx} 列「${kangle2.header[phoneIdx]}」，` +
      `该列非空 ${kangle2.nonEmptyPerCol[phoneIdx]}/${kangle2.ledger.afterSalesRows} 行`,
  );
  if (ambiguousPhone) {
    for (const idx of ambiguousPhone.indexes) {
      console.log(
        `    · 候选列 ${idx}「${kangle2.header[idx]}」非空 ${kangle2.nonEmptyPerCol[idx]}/${kangle2.ledger.afterSalesRows} 行`,
      );
    }
  }
  check(
    '康乐 Sheet2 的电话列存在**多个候选**，已登记为 ambiguous（界面必须允许改映射）',
    !!ambiguousPhone && ambiguousPhone.indexes.length >= 2,
    ambiguousPhone ? ambiguousPhone.headers.join(' / ') : '未登记',
  );
  check(
    '自动映射取的是**第一个**候选列，而它几乎全空 ⇒ 104 行"缺手机号"来自映射而非数据',
    phoneIdx === ambiguousPhone?.indexes?.[0] &&
      kangle2.nonEmptyPerCol[phoneIdx] < kangle2.ledger.afterSalesRows / 2 &&
      ambiguousPhone.indexes.some((i) => kangle2.nonEmptyPerCol[i] === kangle2.ledger.afterSalesRows),
    `选中列非空 ${kangle2.nonEmptyPerCol[phoneIdx]}，另一候选列非空 ${Math.max(...ambiguousPhone.indexes.map((i) => kangle2.nonEmptyPerCol[i]))}`,
  );
  const reviewAmb = (kangle2.ambiguous ?? []).find((a) => a.field === 'reviewResult');
  check(
    '康乐 Sheet2 的「服务评价 / 回访结果」同理登记为 ambiguous（取值"来电表扬"不在已知结果集合）',
    !!reviewAmb && reviewAmb.indexes.length >= 2,
    reviewAmb ? reviewAmb.headers.join(' / ') : '未登记',
  );
}

// ---------------------------------------------------------------------------
// ④ 隐私自检
// ---------------------------------------------------------------------------
console.log('');
console.log('── ④ 隐私自检 ────────────────────────────────────────────────');
const raw = String(run.stdout ?? '');
const phoneHits = raw.match(/1[3-9]\d{9}/g);
check('runner 输出里没有任何 11 位手机号', !phoneHits, phoneHits ? `命中 ${phoneHits.length} 处` : '0 处');

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  台账门禁：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
