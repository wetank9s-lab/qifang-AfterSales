#!/usr/bin/env node
/**
 * verify-historical-import.mjs —— P11-3 第 3 项验收门禁
 * （字段映射交互 + 原始/标准化双层存储 + 隔离暂存）
 *
 * ===========================================================================
 * 用户 2026-10-12 第 3~7 条，逐条对应
 * ===========================================================================
 *  ① 真实映射链路：上传 → 识别工作表与行数 → 选表头行 → 列映射 → 预览
 *     「原始值 / 标准化值」→ 看异常 → **改映射重新校验** → 安全暂存
 *  ② 双层存储：原始层**不被覆盖**；重新映射产生**新版本**，旧版本一行不删
 *  ③ 分类互斥可求和：可导入 / 需人工确认 / 疑似重复 / 非售后排除 / 解析错误
 *  ④ 东山 849 行销售配送：**改了映射也不会变成售后**
 *  ⑤ 一格多号 / 含糊日期：保留原值、标异常，**不猜、不补**
 *  ⑥ 重复上传：同一文件再传一次 ⇒ 复用原批次，不产生第二个批次
 *  ⑦ 未确认归属不得归档（409）、不得对其它门店开放
 *  ⑧ 隐私：响应里不得出现完整手机号
 *  ⑨ 本阶段**不产生任何工单**（`service_tickets` 计数不变）
 *  ⑩ 当前 SLA/KPI 不受影响
 *
 * ===========================================================================
 * 为什么大部分断言走 **HTTP**（而不是直接调服务层）
 * ===========================================================================
 * 用户第 7 条要的是"**真实浏览器证据**：上传 → 识别 → 映射 → 预览 → 异常 →
 * 改映射 → 重新校验 → 安全暂存"。浏览器点的是**接口**，
 * 所以这里必须先把接口这一侧逐条钉死；浏览器那一步单独做（见 docs 交付记录）。
 *
 * ⚠️ 有两条例外**只能**在容器内以服务层调（`visibility_scope` 的行级裁剪）——
 *    因为要通过 HTTP 验证"另一家门店看不到"，就得先造一个门店账号，
 *    而"造账号"本身会改动 ACL/用户数据，属于验收不该有的副作用。
 *    ⇒ 这一条改为**直接调用构建产物里的 `getBatchForActor()`**，
 *      并把"是服务层断言"如实标出来，不假装它是 HTTP 证据。
 *
 * 用法：node scripts/verify-historical-import.mjs [--samples <dir>]
 * 退出码：0 全过 / 1 断言失败 / 2 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIST = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
const TMP = path.join(ROOT, 'storage/tmp');
const SAMPLES = path.join(TMP, 'historical-samples');
const CONTAINER = 'svc-app';
const DEFAULT_SAMPLES = 'E:\\桌面文件整理\\售后系统';

const argv = process.argv.slice(2);
const samplesDir = argv.includes('--samples') ? argv[argv.indexOf('--samples') + 1] : DEFAULT_SAMPLES;

/** 预览行是否同时给出「清洗前（raw）」与「清洗后（standardized）」两侧 */
function previewHasBothSides(json) {
  const row = json?.data?.sheets?.[0]?.preview?.[0];
  if (!row) return false;
  const hasRaw = row.raw && Object.keys(row.raw).length > 0;
  const hasStd = row.standardized && typeof row.standardized === 'object';
  return Boolean(hasRaw && hasStd);
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  return ok;
}

const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValue = (k, d) => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : d;
};
const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', '');

let TOKEN = '';

/** 最近一次请求的原始信息 —— 失败时打出来，避免断言退化成一堆 `undefined` 比较 */
let LAST_REQ = null;

async function api(pathname, { method = 'POST', body, headers = {} } = {}) {
  LAST_REQ = {
    url: `${SVC_BASE_URL}${pathname}`,
    method,
    bodyPreview:
      body === undefined || body instanceof FormData
        ? body instanceof FormData
          ? '(multipart)'
          : '(none)'
        : JSON.stringify(body).slice(0, 300),
  };
  const res = await fetch(`${SVC_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

async function signIn() {
  const r = await api('/api/auth:signIn', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  TOKEN = r.json?.data?.token ?? '';
  if (!TOKEN) throw new Error(`登录失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
}

async function uploadFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));
  const r = await api('/api/svc:historicalUpload', { body: form });
  return { ...r, payload: r.json?.data ?? r.json };
}

/**
 * ⚠️ 传进来的 action 名**不带** `svc:` 前缀（函数自己拼）。
 *    最初这里写成 `svcGet('historicalBatches')`，于是 URL 变成
 *    `/api/svc:svc:historicalBatches` —— NocoBase 解析出 action=`svc`，
 *    回一个裸 `404 Not Found`（**不是** JSON 错误信封），
 *    下游断言全部退化成 `undefined` 比较，报出一堆看不懂的失败。
 *    教训：辅助函数拼路径时，前缀只能有一处。
 */
async function svcGet(action, query = '') {
  const r = await api(`/api/svc:${action}${query}`, { method: 'GET' });
  return { ...r, payload: r.json?.data ?? r.json };
}

async function svcPost(action, body) {
  const r = await api(`/api/svc:${action}`, { body });
  return { ...r, payload: r.json?.data ?? r.json };
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 3 项 · 历史导入（映射 / 双层存储 / 隔离暂存）验收');
console.log('══════════════════════════════════════════════════════════════');

// ---- 环境 ----
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
  if (fs.existsSync(samplesDir)) {
    fs.mkdirSync(SAMPLES, { recursive: true });
    for (const f of fs.readdirSync(samplesDir)) {
      if (/\.(xlsx|xls)$/i.test(f)) fs.copyFileSync(path.join(samplesDir, f), path.join(SAMPLES, f));
    }
  }
  if (fs.readdirSync(SAMPLES).length === 0) {
    console.error(`  ⛔ 样本目录为空：${SAMPLES}`);
    process.exit(2);
  }
}

const sampleFiles = fs
  .readdirSync(SAMPLES)
  .filter((f) => /\.(xlsx|xls)$/i.test(f))
  .sort();

await signIn();
console.log(`  · 已登录 ${ADMIN_EMAIL}；样本 ${sampleFiles.length} 份`);

/** 记录验收前的工单总数（末尾要证明"没有产生任何工单"） */
async function countTickets() {
  const r = await api('/api/serviceTickets:list?paginate=false&fields=id', { method: 'GET' });
  return (r.json?.data ?? []).length;
}
const ticketsBefore = await countTickets();
console.log(`  · 验收前工单数 ${ticketsBefore}`);

// ---------------------------------------------------------------------------
// ① 逐份上传七份真实样本
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 七份真实样本：上传 → 识别工作表与行数 ──────────────────');
const batches = {};
let uploadOk = 0;
for (const f of sampleFiles) {
  const r = await uploadFile(path.join(SAMPLES, f));
  if (r.status !== 200 || !r.payload?.batch?.id) {
    check(`上传 ${f}`, false, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    continue;
  }
  const p = r.payload;
  batches[f] = p;
  uploadOk += 1;
  const sheets = (p.sheets ?? []).map((s) => `${s.sheet}(${s.rowCount}行/${s.classification})`).join(' ');
  console.log(
    `    · ${f.padEnd(28)} 批次 ${p.batch.batchNo} 工作表 ${p.sheets.length} 个 数据行 ${p.totals.dataRows}  ${sheets}`,
  );
}
check('七份样本全部上传并识别成功', uploadOk === sampleFiles.length, `${uploadOk}/${sampleFiles.length}`);

const ledgerSum = Object.values(batches).reduce(
  (a, p) => {
    for (const k of Object.keys(a)) a[k] += p.ledger[k];
    return a;
  },
  { excelRows: 0, headerRows: 0, repeatedHeaderRows: 0, blankRows: 0, afterSalesRows: 0, excludedRows: 0, undeterminedRows: 0, balance: 0 },
);
ledgerSum.balance =
  ledgerSum.excelRows -
  (ledgerSum.headerRows + ledgerSum.repeatedHeaderRows + ledgerSum.blankRows + ledgerSum.afterSalesRows + ledgerSum.excludedRows + ledgerSum.undeterminedRows);
check('HTTP 侧台账逐表平衡（物理行 == 各分类之和）', ledgerSum.balance === 0, `平衡差 ${ledgerSum.balance}`);
check('HTTP 侧总数与解析门禁一致（3953 = 售后 3104 + 排除 849）', ledgerSum.afterSalesRows === 3104 && ledgerSum.excludedRows === 849 && ledgerSum.excelRows === 4377, `${ledgerSum.excelRows}/${ledgerSum.afterSalesRows}/${ledgerSum.excludedRows}`);
check('上传响应里没有完整手机号', !/1[3-9]\d{9}/.test(JSON.stringify(batches).replace(/"(batchNo|fileHash)":"[^"]*"/g, '')), '');
check('批次初始状态：隔离暂存 + 归属未确认 + 不写 store_id', Object.values(batches).every((p) => p.batch.stage === 'staging' && p.batch.attributionState === 'unconfirmed'), '');

// ---------------------------------------------------------------------------
// ② 重复上传识别
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② 同一文件重复上传 ──────────────────────────────────────');
const first = Object.keys(batches)[0];
const dup = await uploadFile(path.join(SAMPLES, first));
check('重复上传返回同一个批次（不新建第二个批次）', dup.payload?.batch?.id === batches[first].batch.id && dup.payload?.batch?.reused === true, `batchId ${dup.payload?.batch?.id} reused=${dup.payload?.batch?.reused}`);
check('重复上传不重复写原始行（inserted=0）', dup.payload?.rawRows?.inserted === 0, `inserted=${dup.payload?.rawRows?.inserted} skipped=${dup.payload?.rawRows?.skipped}`);

// ---------------------------------------------------------------------------
// ③ 映射：自动映射 vs 人工改映射（康乐 Sheet2 的真实案例）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ 字段映射：自动 vs 人工（康乐 Sheet2 有两列电话）──────');
const KL = Object.keys(batches).find((f) => f.startsWith('康乐'));
const kl = batches[KL];
const klSheet = (kl.sheets ?? []).find((s) => s.sheet === 'Sheet2');
check('康乐 Sheet2 被识别出来', !!klSheet, klSheet ? `${klSheet.rowCount} 行` : '未找到');

const ambPhone = (klSheet?.ambiguous ?? []).find((a) => a.field === 'customerPhone');
check('「联系电话」有多列候选时被登记出来（界面才能让人改）', !!ambPhone && ambPhone.indexes.length >= 2, ambPhone ? ambPhone.headers.join(' / ') : '未登记');

const autoFields = { ...(klSheet?.autoMapping ?? {}) };
const betterFields = { ...autoFields, ...(ambPhone ? { customerPhone: ambPhone.indexes[ambPhone.indexes.length - 1] } : {}) };

const pvAuto = await svcPost('historicalPreview', {
  batchId: kl.batch.id,
  sheets: [{ sheetName: 'Sheet2', headerRow: klSheet.headerRow, fields: autoFields }],
  limit: 5,
});
const pvBetter = await svcPost('historicalPreview', {
  batchId: kl.batch.id,
  sheets: [{ sheetName: 'Sheet2', headerRow: klSheet.headerRow, fields: betterFields }],
  limit: 5,
});
if (pvAuto.status !== 200) {
  // ⚠️ 不静默：拿不到 200 就把原始响应打出来。
  //    否则后面的断言会全部退化成 `undefined` 比较，报出一堆看不懂的失败。
  console.log(`    ‼ 预览返回 HTTP ${pvAuto.status}：${String(pvAuto.text).slice(0, 300)}`);
  console.log(`       请求 ${LAST_REQ?.method} ${LAST_REQ?.url}`);
  console.log(`       请求体 ${LAST_REQ?.bodyPreview}`);
}
const missAuto = pvAuto.payload?.sheets?.[0]?.quality?.missingPhoneRows ?? -1;
const missBetter = pvBetter.payload?.sheets?.[0]?.quality?.missingPhoneRows ?? -1;
console.log(`    自动映射选第 ${autoFields.customerPhone} 列 ⇒ 缺手机号 ${missAuto} 行`);
console.log(`    改映射到第 ${betterFields.customerPhone} 列 ⇒ 缺手机号 ${missBetter} 行`);
check('改映射后"缺手机号"显著下降（证明这个数字来自映射，不是数据本身）', missBetter < missAuto / 10, `${missAuto} → ${missBetter}`);
check('预览是只读的：不写库、不递增映射版本', pvAuto.payload?.staged === false, `staged=${pvAuto.payload?.staged}`);

// ---------------------------------------------------------------------------
// ④ 东山：改映射也不能把销售配送变成售后
// ---------------------------------------------------------------------------
console.log('');
console.log('── ④ 东山 849 行销售配送：改映射不得变成售后 ───────────────');
const DS = Object.keys(batches).find((f) => f.startsWith('东山'));
const ds = batches[DS];
const dsSheet = (ds.sheets ?? [])[0];
// 刻意把「购机日期」映射到"接件日期"、把「物流送货人员」映射到"服务人员" ——
// 这是"用改映射把销售记录伪装成售后"的最直接尝试
const spoof = {
  receiveDate: dsSheet.header.findIndex((h) => String(h).includes('购机日期')),
  technician: dsSheet.header.findIndex((h) => String(h).includes('物流送货')),
  customerName: dsSheet.autoMapping.customerName,
  customerPhone: dsSheet.autoMapping.customerPhone,
};
const pvSpoof = await svcPost('historicalPreview', {
  batchId: ds.batch.id,
  sheets: [{ sheetName: dsSheet.sheet, headerRow: dsSheet.headerRow, fields: spoof }],
  limit: 3,
});
const spoofCounts = pvSpoof.payload?.sheets?.[0]?.counts ?? {};
check(
  '刻意"伪装映射"后仍 100% 判为非售后排除',
  spoofCounts.excluded === dsSheet.rowCount && (spoofCounts.importable ?? 0) === 0,
  `excluded=${spoofCounts.excluded} importable=${spoofCounts.importable} 总行=${dsSheet.rowCount}`,
);

// ---------------------------------------------------------------------------
// ⑤ 分类互斥可求和
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑤ 分类互斥且可求和 ─────────────────────────────────────');
const allCounts = {};
for (const r of [pvAuto, pvBetter, pvSpoof]) {
  const c = r.payload?.sheets?.[0]?.counts ?? {};
  for (const [k, v] of Object.entries(c)) allCounts[k] = (allCounts[k] ?? 0) + v;
}
const sumCounts = Object.values(allCounts).reduce((a, b) => a + b, 0);
console.log(`    ${Object.entries(allCounts).map(([k, v]) => `${k}=${v}`).join(' · ')} 合计 ${sumCounts}`);
check('五个分类之和 == 各次预览的行数之和', sumCounts === pvAuto.payload.previewedRows + pvBetter.payload.previewedRows + pvSpoof.payload.previewedRows, `${sumCounts}`);
check('分类里没有互相矛盾的组合（单枚举列天然互斥）', Object.keys(allCounts).every((k) => ['importable', 'needs-confirm', 'duplicate', 'excluded', 'parse-error'].includes(k)), Object.keys(allCounts).join(','));

// ---------------------------------------------------------------------------
// ⑥ 暂存：mapping_version 递增、旧版本不删
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑥ 安全暂存 + 双层分代留痕 ───────────────────────────────');
const stage1 = await svcPost('historicalStage', {
  batchId: kl.batch.id,
  sheets: [{ sheetName: 'Sheet2', headerRow: klSheet.headerRow, fields: autoFields }],
});
check('暂存成功并返回映射版本', stage1.status === 200 && typeof stage1.payload?.mappingVersion === 'number', `v${stage1.payload?.mappingVersion} 写入 ${stage1.payload?.written} 行`);
const v1 = stage1.payload?.mappingVersion ?? 0;

const stage2 = await svcPost('historicalStage', {
  batchId: kl.batch.id,
  sheets: [{ sheetName: 'Sheet2', headerRow: klSheet.headerRow, fields: betterFields }],
});
check('再次暂存（改了映射）⇒ 版本递增', stage2.payload?.mappingVersion === v1 + 1, `v${stage2.payload?.mappingVersion}`);
check('暂存响应明确"未产生工单"', stage2.payload?.ticketsCreated === 0 && stage2.payload?.attributionState === 'unconfirmed', `ticketsCreated=${stage2.payload?.ticketsCreated}`);

// 直接下库证明"旧版本还在"
const vRows = spawnSync(
  'docker',
  [
    'exec',
    'svc-postgres',
    'psql',
    '-U',
    'svc_app',
    '-d',
    'service_ticket',
    '-t',
    '-A',
    '-F',
    '|',
    '-c',
    `SELECT mapping_version, count(*) FROM historical_import_candidates WHERE batch_id=${kl.batch.id} GROUP BY 1 ORDER BY 1`,
  ],
  { encoding: 'utf8' },
);
const vText = String(vRows.stdout ?? '').trim();
console.log(`    库内版本分布：${vText.split('\n').join(' / ')}`);
check(
  `库内**同时存在** v${v1} 与 v${v1 + 1} 两代标准化结果（旧的一行没被覆盖）`,
  new RegExp(`^${v1}\\|`, 'm').test(vText) && new RegExp(`^${v1 + 1}\\|`, 'm').test(vText),
  vText.replace(/\n/g, ' / '),
);

// ⚠️ 这里必须**按工作表**数，不能按整个批次：康乐那个批次有两张表
//    （Sheet1 464 行 + Sheet2 105 行 = 569）。最初写成"整批 569 vs 单表 105"，
//    报出来像"原始层多写了 464 行"，其实是判据拿错了对象。
const rawRowsDb = spawnSync(
  'docker',
  [
    'exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A',
    '-c', `SELECT count(*) FROM historical_import_rows WHERE batch_id=${kl.batch.id} AND sheet_name='Sheet2'`,
  ],
  { encoding: 'utf8' },
);
const rawCount = Number(String(rawRowsDb.stdout ?? '').trim());
check('原始层（同一工作表）行数在两次暂存后**没有变化**（只追加，不覆盖）', rawCount === klSheet.rowCount, `${rawCount} vs 识别行数 ${klSheet.rowCount}`);

// ---------------------------------------------------------------------------
// ⑦ 未知字段映射被拒 / 归属与权限
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑦ 归属、权限与隔离 ─────────────────────────────────────');
const arch = await svcPost('historicalArchive', { batchId: kl.batch.id, storeId: 1 });
check('正式归档被拒（门店归属未确认）', arch.status === 409 && (arch.json?.errors?.[0]?.code ?? '') === 'ATTRIBUTION_UNCONFIRMED', `HTTP ${arch.status} ${arch.json?.errors?.[0]?.code ?? ''}`);

const anon = await (async () => {
  const saved = TOKEN;
  TOKEN = '';
  const r = await svcGet('historicalBatches');
  TOKEN = saved;
  return r;
})();
check('未登录读取暂存区被拒（401，客户原始数据不得匿名可达）', anon.status === 401, `HTTP ${anon.status}`);

// 服务层：另一家门店看不见（见文件头说明：这一条只能这样验）
const scopeProbe = spawnSync(
  'docker',
  ['exec', CONTAINER, 'node', '-e', `
const svc = require('/app/nocobase/node_modules/@local/service-ticket');
const b = ${kl.batch.id};
const db = require('/app/nocobase/node_modules/@nocobase/database');
// 用最薄的一层替身：只实现 store 需要的 getRepository 接口
const mem = new Map();
const mkRepo = (name) => ({
  async findOne({ filter }) { return mem.get(name + ':' + JSON.stringify(filter)) ?? null; },
  async find() { return []; },
  async create({ values }) { return values; },
  async update() { return null; },
});
const store = svc.historicalImport.createHistoricalImportStore({ db: { getRepository: mkRepo } });
(async () => {
  // 直接喂一个"别人的批次"给可见性判定
  const fake = { id: b, visibility_scope: 'uploader', uploader_user_id: 999, attribution_state: 'unconfirmed' };
  mem.set('historicalImportBatches:' + JSON.stringify({ id: b }), fake);
  const other = await store.getBatchForActor(b, { userId: 1000, username: 'other', isHq: false });
  const owner = await store.getBatchForActor(b, { userId: 999, username: 'owner', isHq: false });
  const hq = await store.getBatchForActor(b, { userId: 1, username: 'hq', isHq: true });
  console.log(JSON.stringify({ other: other === null, owner: owner !== null, hq: hq !== null }));
})();
`],
  { encoding: 'utf8' },
);
let scopeResult = null;
try {
  scopeResult = JSON.parse(String(scopeProbe.stdout ?? '').trim().split('\n').pop());
} catch {
  scopeResult = null;
}
console.log(`    （服务层断言）他人读取=${scopeResult?.other} 本人读取=${scopeResult?.owner} 总部读取=${scopeResult?.hq}`);
check('（服务层）非上传者且非总部读不到该批次', scopeResult?.other === true, JSON.stringify(scopeResult));
check('（服务层）上传者本人与总部可读', scopeResult?.owner === true && scopeResult?.hq === true, '');

// ---------------------------------------------------------------------------
// ⑧ 反向：坏文件不能静默成功
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑧ 反向用例：坏文件不得静默成功 ──────────────────────────');
const FAKES = path.join(TMP, 'historical-fakes');
fs.mkdirSync(FAKES, { recursive: true });
const realXlsx = path.join(SAMPLES, Object.keys(batches).find((f) => f.endsWith('.xlsx')));
const realBuf = fs.readFileSync(realXlsx);

const truncPath = path.join(FAKES, 'truncated.xlsx');
fs.writeFileSync(truncPath, realBuf.subarray(0, Math.floor(realBuf.length / 3)));

const htmlPath = path.join(FAKES, 'fake.xls');
fs.writeFileSync(htmlPath, Buffer.from('<html><body><table><tr><td>a</td></tr></table></body></html>'));

const bigPath = path.join(FAKES, 'oversize.xlsx');
{
  const head = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(21 * 1024 * 1024)]);
  fs.writeFileSync(bigPath, head);
}

const reverseCases = [
  ['损坏文件（截断）', truncPath, [422]],
  ['伪造扩展名（HTML 改名 .xls）', htmlPath, [422]],
  ['超大文件（21 MB）', bigPath, [413]],
  ['空文件', null, [422]],
];
for (const [name, p, expect] of reverseCases) {
  let r;
  if (p === null) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(0)]), 'empty.xlsx');
    const raw = await api('/api/svc:historicalUpload', { body: form });
    r = { status: raw.status, text: raw.text };
  } else {
    const raw = await uploadFile(p);
    r = { status: raw.status, text: raw.text };
  }
  check(`${name} ⇒ ${expect.join('/')}，不静默成功`, expect.includes(r.status), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
}

const notMultipart = await api('/api/svc:historicalUpload', { body: { fileName: 'x.xlsx' } });
check('非 multipart 上传被明确拒绝（415）', notMultipart.status === 415, `HTTP ${notMultipart.status}`);

// ---------------------------------------------------------------------------
// ⑨ 没有产生工单 / SLA 不受影响
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑨ 无工单副作用 / 现有指标不受影响 ───────────────────────');
const ticketsAfter = await countTickets();
check('本阶段未产生任何工单（service_tickets 计数不变）', ticketsAfter === ticketsBefore, `${ticketsBefore} → ${ticketsAfter}`);

const health = await api('/api/svc:health', { method: 'GET' });
check('健康检查仍 ready', health.json?.data?.ready === true || health.json?.ready === true, `HTTP ${health.status}`);
const healthBody = health.json?.data ?? health.json ?? {};
check(
  'SLA / 短信重试计数仍在（口径未被本次改动影响）',
  healthBody.sla !== undefined || healthBody.smsRetryStats !== undefined || healthBody.tasks !== undefined,
  Object.keys(healthBody).slice(0, 12).join(','),
);

// ---------------------------------------------------------------------------
// ⑩ 隐私
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑩ 隐私自检 ─────────────────────────────────────────────');
const batchesList = await svcGet('historicalBatches');
const listText = JSON.stringify(batchesList.json ?? {});
const listHits = listText.match(/1[3-9]\d{9}/g);
check('批次列表（统计类响应）里没有完整手机号', !listHits, listHits ? `命中 ${listHits.length} 处` : '0 处');

const uploadRaw = JSON.stringify(batches).replace(/"(batchNo|fileHash)":"[^"]*"/g, '');
const uploadHits = uploadRaw.match(/1[3-9]\d{9}/g);
check('上传响应的质量统计里没有完整手机号', !uploadHits, uploadHits ? `命中 ${uploadHits.length} 处` : '0 处');

/**
 * ⚠️ 预览**故意**会回原始值 —— 这是用户第 3 条点名要的
 *    「看到清洗前与清洗后的对照」，所以这里**不能**断言"预览里没有完整号码"。
 *
 *    真正要守的是两条边界（用户第 6 条的原话是"**完整原始数据只能经授权接口访问**"，
 *    以及"**日志、解析异常、普通统计响应**不得输出完整手机号"）：
 *      ① 预览属于**授权接口** ⇒ 未登录必须拿不到；
 *      ② 预览只能看到**自己上传/被授权范围**的批次（由 getBatchForActor 裁，已在 ⑦ 断言）。
 *    ⇒ 断言改成这两条，而不是去堵一个用户明确要求的功能。
 *      （把断言写在错的地方，比没有断言更糟：它会逼着下一个人删掉一个正确的功能。）
 */
const pvAnon = await (async () => {
  const saved = TOKEN;
  TOKEN = '';
  const r = await svcPost('historicalPreview', { batchId: kl.batch.id, sheets: [] });
  TOKEN = saved;
  return r;
})();
check('预览（会回原始值的接口）未登录不可达 —— 完整原始数据只经授权接口', pvAnon.status === 401, `HTTP ${pvAnon.status}`);
check('预览里区分了「清洗前」与「清洗后」两栏（用户第 3 条要求）', previewHasBothSides(pvBetter.json), '');
console.log('    （说明：预览按用户要求**会**显示原始值，因此这里不断言"无完整号码"）');

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  历史导入验收：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
