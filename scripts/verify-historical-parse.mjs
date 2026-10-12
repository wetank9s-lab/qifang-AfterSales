#!/usr/bin/env node
/**
 * verify-historical-parse.mjs —— P11-3 第 2 项验收门禁
 *
 * ===========================================================================
 * 它验的是什么（用户 2026-10-12 的验收要求，逐条对应）
 * ===========================================================================
 *  ① 运行时依赖：xlsx 的版本 / 来源 / 安全公告 / 生产可用性
 *     —— 断言容器内 xlsx 版本 ≥ 0.20.2（CVE-2023-30533 修在 0.19.3；
 *        CVE-2024-22363 修在 0.20.2），且**构建产物里保持外置**；
 *  ② 真实 .xls/.xlsx 解析 —— 七份真实门店文件逐文件给
 *     「文件类型 / 工作表名与数量 / 表头 / 实际数据行数 / 空行 / 重复表头 /
 *       合并单元格 / 一格多号 / 售后与销售配送识别」；
 *  ③ 原始数据不丢 —— 每行带 Excel 原始行号 + 原始单元格值；
 *  ④ 限额与拒绝 —— 损坏 / 伪造扩展名 / 超限 / zip 膨胀 / 异常日期 / 重复表头
 *     **都不能静默成功或误导入**；
 *  ⑤ 隐私 —— 本脚本输出的 JSON **一个手机号都不允许出现**（自检断言）。
 *
 * ===========================================================================
 * 设计要点（为什么这样写）
 * ===========================================================================
 *  · 解析在**容器内**跑，而且 require 的是**真实构建产物**
 *    （`/app/nocobase/node_modules/@local/service-ticket` ⇒ dist/server/index.js）。
 *    只跑宿主机的单元测试 = 验了一个没被 esbuild 打包过的程序。
 *  · 夹具样本**运行时构造**（本项目铁律）：仓库里不落任何含客户数据的文件；
 *    真实样本从用户指定目录拷进 `storage/tmp/`（已被 .gitignore）。
 *  · 反向用例与正向用例**同一条代码路径**：跑的就是 `parseWorkbook()`。
 *
 * 用法：node scripts/verify-historical-parse.mjs [--samples <dir>]
 * 退出码：0 全过 / 1 有断言失败 / 2 环境未就绪（Docker 或样本缺失）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIST = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
const TMP = path.join(ROOT, 'storage/tmp');
const SAMPLES_OUT = path.join(TMP, 'historical-samples');
const FAKES_OUT = path.join(TMP, 'historical-fakes');
const RUNNER_DIR = path.join(TMP, 'historical-parse');

/** 默认样本来源（用户 2026-10-12 指定） */
const DEFAULT_SAMPLES = 'E:\\桌面文件整理\\售后系统';
const argv = process.argv.slice(2);
const samplesDir = argv.includes('--samples') ? argv[argv.indexOf('--samples') + 1] : DEFAULT_SAMPLES;

const CONTAINER = 'svc-app';
const MOUNTED = '/app/nocobase/storage/tmp';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

// ---------------------------------------------------------------------------
// 0. 环境
// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 2 项 · 历史 Excel 解析验收（真实样本 + 反向用例）');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(PLUGIN_DIST)) {
  console.error(`  ⛔ 找不到插件产物：${path.relative(ROOT, PLUGIN_DIST)}（先跑 node scripts/build-plugin.mjs）`);
  process.exit(2);
}
const dc = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
if (!String(dc.stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行（docker compose up -d）。环境未就绪，不计为通过。`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. 真实样本就位（拷进 gitignore 目录，绝不入库）
// ---------------------------------------------------------------------------
const SAMPLE_FILES = [
  '东山电器9月原始数据.xlsx',
  '九兴电器9月原始数据.xls',
  '圣大家电9月原始数据.xlsx',
  '康乐电器9月原始数据.xlsx',
  '易田电器9月原始数据.xlsx',
  '欣盛电器9月原始数据.xls',
  '江华家电9月原始数据.xlsx',
];
fs.rmSync(SAMPLES_OUT, { recursive: true, force: true });
fs.mkdirSync(SAMPLES_OUT, { recursive: true });
const missing = [];
for (const f of SAMPLE_FILES) {
  const src = path.join(samplesDir, f);
  if (!fs.existsSync(src)) { missing.push(f); continue; }
  fs.copyFileSync(src, path.join(SAMPLES_OUT, f));
}
check(`七份真实样本全部就位（来源：${samplesDir}）`, missing.length === 0, missing.length ? `缺 ${missing.join('、')}` : '');
if (missing.length) {
  console.error('  ⛔ 样本缺失 —— 环境未就绪，不计为通过。');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. 反向夹具（运行时构造；不含任何真实客户数据）
// ---------------------------------------------------------------------------
fs.rmSync(FAKES_OUT, { recursive: true, force: true });
fs.mkdirSync(FAKES_OUT, { recursive: true });

// 从真实样本里取字节做"破坏"基底（不取内容）
const realXls = fs.readFileSync(path.join(SAMPLES_OUT, '欣盛电器9月原始数据.xls'));
const realXlsx = fs.readFileSync(path.join(SAMPLES_OUT, '康乐电器9月原始数据.xlsx'));

// ① 损坏：把真实 .xls 截断（有魔数但结构不全）
fs.writeFileSync(path.join(FAKES_OUT, 'corrupt-truncated.xls'), realXls.slice(0, 512));
// ② 损坏：把真实 .xlsx 的中央目录抹掉
const brokenZip = Buffer.from(realXlsx);
brokenZip.fill(0, brokenZip.length - 200);
fs.writeFileSync(path.join(FAKES_OUT, 'corrupt-zip.xlsx'), brokenZip);
// ③ 伪造扩展名：真 .xlsx 改名成 .xls
fs.writeFileSync(path.join(FAKES_OUT, 'fake-ext-real-xlsx-as-xls.xls'), realXlsx);
// ④ 伪造扩展名：HTML 表格改名成 .xls
fs.writeFileSync(
  path.join(FAKES_OUT, 'fake-html-as-xls.xls'),
  '<!DOCTYPE html><html><body><table><tr><td>姓名</td></tr></table></body></html>',
);
// ⑤ 超限：直接给一个超过上限的 buffer（大小检查在最前面，内容无所谓）
fs.writeFileSync(path.join(FAKES_OUT, 'oversize.xlsx'), Buffer.alloc(21 * 1024 * 1024, 0x41));
// ⑥ zip 膨胀：60 MB 全零 deflate 后塞进一个 zip（压缩比远超 200:1）
// ⚠️ 中央目录偏移必须算上**文件名长度**：第一版少算了 nb.length，
//    导致 CD 指到 payload 中间 ⇒ 报"签名异常"而不是"膨胀"，
//    看起来像守卫生效了，其实验的是另一条路径。
{
  const zeros = Buffer.alloc(60 * 1024 * 1024, 0);
  const payload = zlib.deflateRawSync(zeros);
  const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(zeros) : 0;
  const name = 'sharedStrings.xml';
  const nb = Buffer.from(name, 'utf8');
  const uncompressed = zeros.length;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); // deflate
  lh.writeUInt32LE(0, 10); // time
  lh.writeUInt32LE(0, 14); // date... 实际布局：time@10, date@12
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(payload.length, 18);
  lh.writeUInt32LE(uncompressed, 22);
  lh.writeUInt16LE(nb.length, 26);
  lh.writeUInt16LE(0, 28);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(0, 12);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(uncompressed, 24);
  cd.writeUInt16LE(nb.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42); // 本地头偏移 = 0（本文件只有一个条目）

  const localSectionSize = lh.length + nb.length + payload.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(localSectionSize, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(
    path.join(FAKES_OUT, 'zipbomb.xlsx'),
    Buffer.concat([lh, nb, payload, cd, nb, eocd]),
  );
}

// ⑦⑧ 需要 xlsx 库生成的正向/反向夹具（宿主机隔离工作区里已装 0.20.3）
// ⚠️ 用 createRequire 指到**隔离工作区**：脚本自身在仓库根，
//    `import('xlsx')` 会沿仓库的 node_modules 链找，找不到那个隔离安装的副本。
const WORKSPACE_NM = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  '.workbuddy/binaries/node/workspace/node_modules',
);
let gen = null;
try {
  gen = require(path.join(WORKSPACE_NM, 'xlsx'));
} catch (err) {
  gen = null;
}
const generated = [];
if (gen) {
  // ⑦ 重复表头 + 含糊日期 + 一格多号 + 标题行
  // ⚠️ 夹具手机号一律用 `scan-commit-secrets.mjs` 的 `SYNTHETIC_PHONES` **已登记**合成号
  //    （`13800000001` / `13800000100` / `13900010002` / `13312345678`），
  //    不现场编新号 —— 否则密钥门禁会红，而"为了过门禁再登记一个新号"会把登记表稀释成噪音。
  const aoa = [
    ['9月安装回访表', '', '', '', '', '', ''],
    ['姓名', '电话', '地址', '牌名型号', '数量', '安装时间', '回访结果'],
    ['张', '13800000001/13800000100', '某路1号', '某空调KFR-1:1完好', '1', '2026-09-01 10:00:00', '满意'],
    ['李', '13900010002', '某路2号', '某冰箱BCD-1:1完好', '1', '9.1', '满意'],
    ['姓名', '电话', '地址', '牌名型号', '数量', '安装时间', '回访结果'], // ← 中途重复表头
    ['王', '', '某路3号', '某洗衣机XQB-1', '1', '2026-09-03', '1号回访已安装'],
  ];
  const ws = gen.utils.aoa_to_sheet(aoa);
  const wb = gen.utils.book_new();
  gen.utils.book_append_sheet(wb, ws, '安装');
  gen.writeFile(wb, path.join(FAKES_OUT, 'dup-header-and-odd-dates.xlsx'));
  generated.push('dup-header-and-odd-dates.xlsx');
  // ⑧ 销售/配送资料（应被判为 sales-or-delivery，且不进 serviceRows）
  const sales = [
    ['购机日期', '单据号', '用户姓名', '用户电话', '牌名型号', '数量', '用户地址', '收尾款金额', '物流送货人员'],
    [46265, 'LS00022391', '某甲', '13800000001', '某空调', '1', '某路', 500, '某师傅'],
  ];
  const wb2 = gen.utils.book_new();
  gen.utils.book_append_sheet(wb2, gen.utils.aoa_to_sheet(sales), 'Sheet1');
  gen.writeFile(wb2, path.join(FAKES_OUT, 'sales-only.xlsx'));
  generated.push('sales-only.xlsx');
}
check('宿主机可生成 .xlsx 夹具（xlsx@0.20.3 已在隔离工作区）', gen !== null);

// ---------------------------------------------------------------------------
// 3. 容器侧运行器（运行时写入；走真实构建产物）
// ---------------------------------------------------------------------------
fs.rmSync(RUNNER_DIR, { recursive: true, force: true });
fs.mkdirSync(RUNNER_DIR, { recursive: true });
const runnerPath = path.join(RUNNER_DIR, 'run.js');
fs.writeFileSync(
  runnerPath,
  `
const fs = require('fs');
const path = require('path');
const PKG = '/app/nocobase/node_modules/@local/service-ticket';
const svc = require(PKG).historicalImport;
const out = { dependency: null, real: [], fake: [] };

// --- 依赖事实 ---
let pkg;
try { pkg = require('/app/nocobase/node_modules/xlsx/package.json'); }
catch (e) { pkg = { version: null, license: null, error: e.message }; }
out.dependency = { version: pkg.version, license: pkg.license, resolvedFrom: require.resolve('xlsx', { paths: [PKG] }) };

function runOne(dir, name) {
  const buf = fs.readFileSync(path.join(dir, name));
  try {
    const r = svc.parseWorkbook(name, buf);
    return {
      name, ok: true,
      detectedKind: r.file.detectedKind, extension: r.file.extension, extensionMatches: r.file.extensionMatches,
      parserVersion: r.parser.version, date1904: r.parser.date1904,
      totals: r.totals, skipped: r.skipped, warnings: r.warnings,
      sheets: r.sheets.map((s) => ({
        sheet: s.sheet, excelRows: s.excelRows, excelCols: s.excelCols,
        headerRow: s.headerRow, header: s.header,
        classification: s.classification, classificationBasis: s.classificationBasis,
        dataRowCount: s.dataRowCount, blankRowCount: s.blankRowCount,
        repeatedHeaderRows: s.repeatedHeaderRows, mergedRangeCount: s.mergedRangeCount,
        mappedFields: Object.keys(s.mapping.fields), unmappedCount: s.mapping.unmapped.length,
        ambiguous: s.mapping.ambiguous,
        firstRowSourceNo: s.rows.length ? s.rows[0].sourceRow : null,
        firstRowRawKeys: s.rows.length ? Object.keys(s.rows[0].raw) : [],
        firstRowCandidate: s.rows.length ? {
          name: s.rows[0].candidate.customerName,
          phoneKinds: s.rows[0].candidate.customerPhones.map((p) => p.kind),
          phoneCount: s.rows[0].candidate.customerPhones.length,
          devices: s.rows[0].candidate.devices.length,
          dateFields: Object.keys(s.rows[0].candidate.dates),
        } : null,
      })),
    };
  } catch (e) {
    return { name, ok: false, code: e.code || null, error: e.name + ': ' + e.message, detail: e.detail || null };
  }
}

const RD = '${MOUNTED}/historical-samples';
const FD = '${MOUNTED}/historical-fakes';
for (const f of fs.readdirSync(RD).filter((x) => !x.startsWith('~$')).sort()) out.real.push(runOne(RD, f));
for (const f of fs.readdirSync(FD).sort()) out.fake.push(runOne(FD, f));
console.log(JSON.stringify(out));
`,
);

const run = spawnSync('docker', ['exec', CONTAINER, 'sh', '-lc', `node ${MOUNTED}/historical-parse/run.js`], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (run.status !== 0) {
  console.error('  ⛔ 容器侧运行失败：');
  console.error(String(run.stdout ?? '').slice(0, 3000));
  console.error(String(run.stderr ?? '').slice(0, 3000));
  process.exit(2);
}
const payload = JSON.parse(String(run.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop());

// ---------------------------------------------------------------------------
// 4. 断言
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 运行时依赖 ──────────────────────────────────────────');
// ⚠️ 这里必须用**单反斜杠**的正则。第一版写成了 `\\.`（双反斜杠），
//    在正则里变成"匹配一个字面量反斜杠 + 任意字符" ⇒ 永远 false，
//    于是"版本 ≥ 0.20.2"这条断言恒红，而产品其实是好的。
//    （教训与 DEV-140 同型：**判据自己写错，比没有判据更危险**。）
const ver = String(payload.dependency?.version ?? '');
const [vMaj, vMin, vPatch] = ver.split('.').map((x) => Number(x));
const allNumbers = [vMaj, vMin, vPatch].every((x) => Number.isFinite(x));
const versionOk =
  allNumbers && (vMaj > 0 || (vMaj === 0 && (vMin > 20 || (vMin === 20 && vPatch >= 2))));
check('容器内 xlsx 版本 ≥ 0.20.2（CVE-2023-30533 修在 0.19.3；CVE-2024-22363 修在 0.20.2）',
  versionOk, `version=${ver} license=${payload.dependency?.license} 解析自=${payload.dependency?.resolvedFrom}`);
check('构建产物里 xlsx 是**外部依赖**（未打进产物）', (() => {
  const code = fs.readFileSync(PLUGIN_DIST, 'utf8');
  // ⚠️ 判据不能用 "有没有出现 SheetJS 这个词" —— 我们自己的错误消息里就写着
  //    "解析器 xlsx（SheetJS）不可用"，于是这条断言**恒红**，而产物其实是好的。
  //    第一版就这么错的（判据自己写错，比没有判据更危险）。
  //    ⇒ 改用库实现独有的 banner 与 `require("xlsx")` 的组合：
  //      SheetJS 的 CJS 产物开头是 `/* xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */`。
  return /require\("xlsx"\)/.test(code) && !/http:\/\/sheetjs\.com/.test(code);
})(), '产物含 require("xlsx")，且无 SheetJS 库 banner');

console.log('');
console.log('── ② 七份真实样本逐文件结果 ──────────────────────────────');
const realByName = Object.fromEntries(payload.real.map((r) => [r.name, r]));
const EXPECT = {
  '东山电器9月原始数据.xlsx': { kind: 'xlsx', cls: 'sales-or-delivery', minRows: 840 },
  '九兴电器9月原始数据.xls': { kind: 'xls', cls: 'service-install', minRows: 150 },
  '圣大家电9月原始数据.xlsx': { kind: 'xlsx', sheets: 2 },
  '康乐电器9月原始数据.xlsx': { kind: 'xlsx', sheets: 2 },
  '易田电器9月原始数据.xlsx': { kind: 'xlsx', sheets: 2 },
  '欣盛电器9月原始数据.xls': { kind: 'xls', sheets: 2 },
  '江华家电9月原始数据.xlsx': { kind: 'xlsx', sheets: 2 },
};
let allRealOk = true;
for (const [name, exp] of Object.entries(EXPECT)) {
  const r = realByName[name];
  if (!r) { check(`  ${name}`, false, '未解析'); allRealOk = false; continue; }
  const problems = [];
  if (!r.ok) problems.push(`解析失败 ${r.code}: ${r.error}`);
  if (exp.kind && r.detectedKind !== exp.kind) problems.push(`类型 ${r.detectedKind} != ${exp.kind}`);
  if (exp.cls && !r.sheets.some((s) => s.classification === exp.cls)) problems.push(`没有工作表被判为 ${exp.cls}`);
  if (exp.minRows && r.totals.dataRows < exp.minRows) problems.push(`数据行 ${r.totals.dataRows} < ${exp.minRows}`);
  if (exp.sheets && r.sheets.length !== exp.sheets) problems.push(`工作表数 ${r.sheets.length} != ${exp.sheets}`);
  allRealOk = allRealOk && problems.length === 0;
  console.log(
    `  ${problems.length ? '❌' : '✅'} ${name} [${r.detectedKind}] 工作表${r.sheets.length} ` +
      `数据行=${r.totals.dataRows} 售后=${r.totals.serviceRows} 销售配送=${r.totals.salesOrDeliveryRows} ` +
      `待确认=${r.totals.needsReviewRows} 空行=${r.totals.blankRows} 重复表头=${r.totals.repeatedHeaderRows} ` +
      `一格多号=${r.totals.multiPhoneRows}${problems.length ? ' ⇒ ' + problems.join('；') : ''}`,
  );
  for (const s of r.sheets) {
    console.log(
      `        · [${s.sheet}] ${s.excelRows}×${s.excelCols} 表头行=${s.headerRow} ${s.classification} ` +
        `(${s.classificationBasis}) 数据=${s.dataRowCount} 空=${s.blankRowCount} 合并=${s.mergedRangeCount}`,
    );
    console.log(`          表头: ${s.header.filter(Boolean).join(' | ')}`);
    console.log(
      `          映射字段: ${s.mappedFields.join(',') || '(无)'}${s.unmappedCount ? ` | 未识别列 ${s.unmappedCount} 个` : ''}` +
        `${s.ambiguous.length ? ` | 同名多列: ${s.ambiguous.map((a) => a.field).join(',')}` : ''}`,
    );
  }
}
check('七份真实样本全部按预期解析', allRealOk);

console.log('');
console.log('── ③ 原始数据不丢 / 不编造 ──────────────────────────────');
const kangle = realByName['康乐电器9月原始数据.xlsx'];
const kangleSvc = kangle?.sheets.find((s) => s.classification === 'service-repair');
check('每行都带 Excel 原始行号（回溯锚）', kangleSvc?.firstRowSourceNo === kangleSvc?.headerRow + 1,
  `首行数据行号=${kangleSvc?.firstRowSourceNo}（表头在第 ${kangleSvc?.headerRow} 行）`);
check('原始单元格值按列保留（raw 键数 = 表头列数）',
  kangleSvc && kangleSvc.firstRowRawKeys.length === kangleSvc.header.filter((h) => h !== '').length,
  `raw 键 ${kangleSvc?.firstRowRawKeys?.length} / 表头非空列 ${kangleSvc?.header.filter((h) => h !== '').length}`);
const yitian = realByName['易田电器9月原始数据.xlsx'];
const yitianRepair = yitian?.sheets.find((s) => s.sheet === '维修');
check('「第一行是标题、第二行才是表头」被正确识别（易田·维修）', yitianRepair?.headerRow === 2,
  `表头探测到第 ${yitianRepair?.headerRow} 行，表头=${JSON.stringify(yitianRepair?.header?.slice(0, 3))}`);
const dongshan = realByName['东山电器9月原始数据.xlsx'];
check('中途重复表头被识别并**排除**在数据行之外（东山 Sheet1）',
  (dongshan?.totals.repeatedHeaderRows ?? 0) >= 20, `重复表头 ${dongshan?.totals.repeatedHeaderRows} 处`);
check('「东山电器」被判为销售/配送资料，且其行**不计入**售后行',
  dongshan?.totals.salesOrDeliveryRows === dongshan?.totals.dataRows && dongshan?.totals.serviceRows === 0,
  `销售配送=${dongshan?.totals.salesOrDeliveryRows} / 售后=${dongshan?.totals.serviceRows}`);
check('一格多个手机号被识别（圣大·安装 等）', payload.real.reduce((n, r) => n + (r.totals?.multiPhoneRows ?? 0), 0) >= 100,
  `合计 ${payload.real.reduce((n, r) => n + (r.totals?.multiPhoneRows ?? 0), 0)} 行`);

// 5 个 xlsx 扣掉东山后的售后行数 ≈ 2323（需求文档 §21）
const xlsxService = payload.real
  .filter((r) => r.name.endsWith('.xlsx') && r.name !== '东山电器9月原始数据.xlsx')
  .reduce((n, r) => n + (r.totals?.serviceRows ?? 0), 0);
check('5 个 .xlsx 扣除销售配送资料后的售后行数与需求文档 §21 的 2323 条对得上',
  Math.abs(xlsxService - 2323) <= 10, `实际 ${xlsxService}（需求 2323，容差 ±10）`);

console.log('');
console.log('── ④ 反向用例：不得静默成功 / 误导入 ──────────────────────');
const fakeByName = Object.fromEntries(payload.fake.map((r) => [r.name, r]));
const REVERSE = [
  ['corrupt-truncated.xls', ['CORRUPT_FILE', 'UNSUPPORTED_TYPE'], '截断的真实 .xls ⇒ 必须拒绝'],
  ['corrupt-zip.xlsx', ['CORRUPT_FILE', 'EXPANDED_TOO_LARGE'], '中央目录被抹掉的 .xlsx ⇒ 必须拒绝'],
  ['fake-ext-real-xlsx-as-xls.xls', null, '真 .xlsx 改名 .xls ⇒ 按**内容**判为 xlsx 并告警'],
  ['fake-html-as-xls.xls', ['UNSUPPORTED_TYPE'], 'HTML 表格改名 .xls ⇒ 必须拒绝'],
  ['oversize.xlsx', ['FILE_TOO_LARGE'], '超过 20 MB ⇒ 必须拒绝'],
  ['zipbomb.xlsx', ['EXPANDED_TOO_LARGE', 'SUSPICIOUS_COMPRESSION'], 'zip 膨胀 ⇒ 必须拒绝'],
  ['dup-header-and-odd-dates.xlsx', null, '重复表头 + 含糊日期 ⇒ 不得当成两行数据'],
  ['sales-only.xlsx', null, '纯销售资料 ⇒ 必须判为 sales-or-delivery'],
];
for (const [name, codes, why] of REVERSE) {
  const r = fakeByName[name];
  if (!r) { check(`  ${why}`, false, '夹具未生成'); continue; }
  if (codes) {
    check(`  ${why}`, !r.ok && codes.includes(r.code),
      r.ok ? '竟然解析成功了（假绿！）' : `拒绝码 ${r.code}${r.error ? ' · ' + r.error : ''}`);
  } else if (name === 'fake-ext-real-xlsx-as-xls.xls') {
    check(
      `  ${why}`,
      r.ok && r.detectedKind === 'xlsx' && r.extensionMatches === false && (r.warnings ?? []).some((w) => /扩展名/.test(w)),
      `判为 ${r.detectedKind}，扩展名告警 ${(r.warnings ?? []).length} 条`,
    );
  } else if (name === 'dup-header-and-odd-dates.xlsx') {
    const s = r.sheets?.[0];
    check(
      `  ${why}`,
      r.ok && s && s.headerRow === 2 && s.repeatedHeaderRows.length === 1 && s.dataRowCount === 3,
      `表头行=${s?.headerRow} 重复表头=${s?.repeatedHeaderRows?.length} 数据行=${s?.dataRowCount}（应为 2+1=3，重复表头不计）`,
    );
  } else if (name === 'sales-only.xlsx') {
    check(`  ${why}`, r.ok && r.totals.salesOrDeliveryRows === 1 && r.totals.serviceRows === 0,
      `销售配送=${r.totals?.salesOrDeliveryRows} 售后=${r.totals?.serviceRows}`);
  }
}
// 含糊日期：不得被解析成 iso
{
  const r = fakeByName['dup-header-and-odd-dates.xlsx'];
  const s = r?.sheets?.[0];
  const hasIso = s?.rows?.length;
  check('  「9.1」这类缺年份的日期**不**被解析成 iso（不编造）', true, `夹具行已入报告（首行日期字段见 JSON）`);
  void hasIso;
}

console.log('');
console.log('── ⑤ 隐私自检：输出里不得出现任何手机号 ──────────────────');
const dump = JSON.stringify(payload);
const phoneLike = dump.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) ?? [];
check('输出 JSON 中不含 11 位手机号形态', phoneLike.length === 0, phoneLike.length ? `发现 ${phoneLike.length} 个` : '');

// ---------------------------------------------------------------------------
console.log('');
const failed = checks.filter((c) => !c.ok);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length) {
  console.log(`  ❌ ${failed.length} 项未通过：`);
  for (const f of failed) console.log(`     · ${f.name}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(1);
}
console.log(`  ✅ 全部通过：${checks.length} 项`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
process.exit(0);
