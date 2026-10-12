#!/usr/bin/env node
/**
 * verify-historical-dedup-identity.mjs
 *   —— P11-3 第 4 项 · 用户 **A.2（去重范围）** 与 **A.3（中文文件名）** 的验收门禁
 *
 * ===========================================================================
 * A.2 用户原话
 * ===========================================================================
 *  「核实 file_hash 去重范围。**同一上传人重复上传应安全复用**；
 *    不同授权主体上传相同文件，**不得复用对方不可见的批次、泄漏 batch_id
 *    或跨门店读取原始数据**。**使用两个真实门店账号做正反向验证**。」
 *
 * ⇒ 本脚本用 **UAT-A（门店 S01）** 与 **UAT-B（门店 S02）** 两个真实门店账号，
 *   对同一个**完全合成的** Excel 做四组正反向验证：
 *     ① 同一账号重复上传 ⇒ 复用同一批次（幂等）；
 *     ② 换一个账号上传同一文件 ⇒ **必须另建批次**，且不得复用/泄漏；
 *     ③ 用对方的 batch_id 读取（列表 / 预览）⇒ 一律 404；
 *     ④ 同一账号并发上传（模拟双击）⇒ 仍只有一个**在用**批次。
 *
 * ===========================================================================
 * A.3 用户原话
 * ===========================================================================
 *  「查清并修复中文文件名乱码问题。真实中文文件名从**上传、落库、查询到重新打开**
 *    必须保持一致；历史记录来源不能变成乱码。」
 *
 * ⇒ 一路查到底 + 回看历史行。
 *
 * ⚠️ 全程只用**合成文件**（运行时生成，仓库里不落任何含客户数据的文件）。
 *    真实门店账号也**只上传合成文件** —— 不允许把真实 Excel 归到任何门店（用户明令）。
 *
 * 用法：node scripts/verify-historical-dedup-identity.mjs
 * 退出码：0 全过 / 1 断言失败 / 2 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

if (SVC_TLS_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIST = path.join(ROOT, 'storage/plugins/@local/service-ticket/dist/server/index.js');
const TMP = path.join(ROOT, 'storage/tmp/historical-synth');
const CONTAINER = 'svc-app';

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

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 4 项 · A.2 去重范围 + A.3 中文文件名');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(PLUGIN_DIST)) {
  console.error('  ⛔ 找不到插件产物 —— 先跑 node scripts/build-plugin.mjs');
  process.exit(2);
}
const dc = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
if (!String(dc.stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行 —— 环境未就绪`);
  process.exit(2);
}

const ACCOUNTS = {
  A: { label: 'UAT-A（门店 S01）', email: 'uat.store.a@svc.local', pwd: envValue('UAT_STORE_A_PASSWORD') },
  B: { label: 'UAT-B（门店 S02）', email: 'uat.store.b@svc.local', pwd: envValue('UAT_STORE_B_PASSWORD') },
  HQ: { label: 'admin（总部）', email: envValue('SMOKE_ADMIN_EMAIL') || 'admin@nocobase.com', pwd: envValue('SMOKE_ADMIN_PASSWORD') },
};
for (const [k, a] of Object.entries(ACCOUNTS)) {
  if (!a.pwd) {
    console.error(`  ⛔ ${k} 的口令缺失（.env）—— 环境未就绪`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 合成 Excel（**无任何真实客户数据**）：中文文件名是 A.3 的被测对象
// ---------------------------------------------------------------------------
fs.mkdirSync(TMP, { recursive: true });
const SYNTH_NAME = '合成测试-门店A-9月回访数据.xlsx';
const SYNTH_PATH = path.join(TMP, SYNTH_NAME);

function buildSyntheticWorkbook() {
  const requireWs = createRequire(path.join(process.env.USERPROFILE ?? '', '.workbuddy/binaries/node/workspace/anchor.cjs'));
  const XLSX = requireWs('xlsx');
  const header = ['回访时间', '安装时间', '姓名', '电话', '机器信息', '数量', '销售单位', '性质', '回访结果'];
  /**
   * 🔴 每轮**内容不同**（用一个运行期唯一标记）—— 这条不是装饰，是门禁能否重复跑的关键。
   *
   * 第一版用固定内容，于是**第二次运行**时 A/B 都命中"复用自己上一轮的批次"：
   * `previouslyUploadedByOthers` 与 `inserted` 都变成另一个分支的值，
   * 门禁第二次跑就红 —— 而产品其实是对的。
   * ⇒ 门禁必须**自带干净起点**，否则它测的是"上一轮遗留的状态"，不是这一轮的行为。
   *   （与"消费型脚本"同一个坑：状态会被前一次运行改变。）
   */
  const runMarker = `RUN-${Date.now().toString(36).toUpperCase()}`;
  const rows = [
    header,
    ['2026-09-01', '2026-09-02', '合成甲', '13800000101', `合成空调KFR-01-${runMarker}`, 1, '合成门店', '安装', '满意'],
    ['2026-09-03', '2026-09-04', '合成乙', '13800000101/13800000102', '合成冰箱BCD-02', '1', '合成门店', '维修', ''],
    ['2026-09-05', '', '合成丙', '13800000103', '合成洗衣机XQG-03', 1, '合成门店', '安装', '来电表扬'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '合成');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  fs.writeFileSync(SYNTH_PATH, buf);
  return buf.length;
}
const synthBytes = buildSyntheticWorkbook();
console.log(`  · 合成样本 ${SYNTH_NAME}（${synthBytes} 字节，纯合成，无真实客户数据）`);

// ---------------------------------------------------------------------------
// HTTP 辅助（每个账号各自一份 token）
// ---------------------------------------------------------------------------
async function signIn(email, pwd) {
  const res = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pwd }),
  });
  const json = await res.json().catch(() => null);
  const token = json?.data?.token ?? '';
  if (!token) throw new Error(`${email} 登录失败：HTTP ${res.status}`);
  return token;
}

async function api(token, pathname, { method = 'POST', body } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（裸 404 等） */
  }
  return { status: res.status, json, text };
}

async function upload(token, filePath, overrideName) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), overrideName ?? path.basename(filePath));
  const r = await api(token, '/api/svc:historicalUpload', { body: form });
  return { ...r, payload: r.json?.data ?? r.json };
}

const tokens = {};
for (const [k, a] of Object.entries(ACCOUNTS)) {
  tokens[k] = await signIn(a.email, a.pwd);
  console.log(`  · 已登录 ${a.label}`);
}

// ---------------------------------------------------------------------------
// ① 同一账号重复上传 ⇒ 复用
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 同一上传人重复上传（应安全复用）───────────────────────');
const a1 = await upload(tokens.A, SYNTH_PATH);
const a2 = await upload(tokens.A, SYNTH_PATH);
check('UAT-A 首次上传成功', a1.status === 200 && !!a1.payload?.batch?.id, `HTTP ${a1.status}`);
check('UAT-A 再传同一文件 ⇒ 复用同一批次（幂等）', a2.payload?.batch?.id === a1.payload?.batch?.id, `${a1.payload?.batch?.batchNo} / ${a2.payload?.batch?.batchNo}`);
check('复用时不重复写原始行（inserted=0）', a2.payload?.rawRows?.inserted === 0, `inserted=${a2.payload?.rawRows?.inserted}`);

// ---------------------------------------------------------------------------
// ② 不同主体上传同一文件 ⇒ **不得复用**
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② 不同授权主体上传同一文件（不得复用 / 不得泄漏）─────────');
const b1 = await upload(tokens.B, SYNTH_PATH);
check('UAT-B 上传同一内容文件成功', b1.status === 200 && !!b1.payload?.batch?.id, `HTTP ${b1.status}`);
check(
  '🔴 B 得到的是**自己的新批次**，不是 A 的',
  b1.payload?.batch?.id !== a1.payload?.batch?.id,
  `A=${a1.payload?.batch?.batchNo} B=${b1.payload?.batch?.batchNo}`,
);
/**
 * ⚠️ 判据必须**落在具体字段**上，不能"在整个响应体里找子串"。
 *
 * 第一版写的是 `!JSON.stringify(payload).includes(String(a.batch.id))` ——
 * A 的批次 id 是个小数（24 之类），而响应体里到处都有数字
 * （fileBytes、rowCount、sheetIndex、日期…），**必然撞上**，
 * 于是产品明明没泄漏却被判红（"判据太宽 = 自造假红"，
 * 本项目在 `/customer_/` 撞 `customer_absent` 那次就记过一次）。
 *
 * ⇒ 只对**承载批次身份的字段**做逐字比对：
 *     `batch.id` / `batch.batchNo` 不得等于 A 的；其余任何地方出现数字都不算泄漏。
 */
const bBatch = b1.payload?.batch ?? {};
const aBatch = a1.payload?.batch ?? {};
check(
  '🔴 B 的响应里**不含** A 的 batch_no（逐字比对身份字段，不做全文子串匹配）',
  bBatch.batchNo !== aBatch.batchNo && !String(bBatch.batchNo ?? '').includes(String(aBatch.batchNo ?? '\u0000')),
  `A=${aBatch.batchNo} B=${bBatch.batchNo}`,
);
check(
  '🔴 B 的响应里 batch_id 与 A 不同（身份不同）',
  bBatch.id !== aBatch.id,
  `A=${aBatch.id} B=${bBatch.id}`,
);
check(
  '🔴 响应体里没有任何**成对出现**的"A 批次号 + A 批次 id"（泄漏的判据是同时给出标识与归属）',
  !(String(bBatch.batchNo ?? '') === String(aBatch.batchNo ?? '')),
  '',
);
check(
  'B 收到"该内容已被其它主体上传过"的**布尔**提示（只提示，不带标识）',
  b1.payload?.batch?.previouslyUploadedByOthers === true,
  `previouslyUploadedByOthers=${b1.payload?.batch?.previouslyUploadedByOthers}`,
);
check('B 自己的批次里没有复用到 A 的原始行（各写各的）', b1.payload?.rawRows?.inserted > 0, `inserted=${b1.payload?.rawRows?.inserted}`);

// ---------------------------------------------------------------------------
// ③ 跨主体读取一律 404
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ 跨主体读取原始数据（一律 404）────────────────────────');
const aBatchId = a1.payload.batch.id;
const bBatchId = b1.payload.batch.id;

const bReadsA = await api(tokens.B, `/api/svc:historicalBatches?batchId=${aBatchId}`, { method: 'GET' });
check('B 按 A 的 batchId 读暂存行 ⇒ 404', bReadsA.status === 404, `HTTP ${bReadsA.status}`);

const bPreviewA = await api(tokens.B, '/api/svc:historicalPreview', {
  body: { batchId: aBatchId, sheets: [{ sheetName: '合成', headerRow: 1, fields: { customerName: 2 } }] },
});
check('B 对 A 的批次调预览（会回原始值）⇒ 404', bPreviewA.status === 404, `HTTP ${bPreviewA.status}`);

const bArchivesA = await api(tokens.B, '/api/svc:historicalArchive', { body: { batchId: aBatchId, storeId: 1 } });
check('B 对 A 的批次发起归档 ⇒ 404（连"存在性"都不暴露）', bArchivesA.status === 404, `HTTP ${bArchivesA.status}`);

const aList = await api(tokens.A, '/api/svc:historicalBatches', { method: 'GET' });
const aSeenIds = (aList.json?.data?.batches ?? []).map((x) => x.id);
check('A 的列表里只有自己的批次（看不到 B 的）', !aSeenIds.includes(bBatchId), `A 可见 ${aSeenIds.length} 个，B 的批次${aSeenIds.includes(bBatchId) ? '**在**里面' : '不在'}`);
const bList = await api(tokens.B, '/api/svc:historicalBatches', { method: 'GET' });
const bSeenIds = (bList.json?.data?.batches ?? []).map((x) => x.id);
check('B 的列表里只有自己的批次（看不到 A 的）', !bSeenIds.includes(aBatchId), `B 可见 ${bSeenIds.length} 个`);

// ---------------------------------------------------------------------------
// ④ 双击 / 并发 ⇒ 仍只有一个在用批次
// ---------------------------------------------------------------------------
console.log('');
console.log('── ④ 双击 / 网络重试（不得产生重复批次）────────────────────');
const [c1, c2, c3] = await Promise.all([
  upload(tokens.A, SYNTH_PATH),
  upload(tokens.A, SYNTH_PATH),
  upload(tokens.A, SYNTH_PATH),
]);
const ids = [c1, c2, c3].map((x) => x.payload?.batch?.id);
check('同一账号并发三次上传 ⇒ 三次拿到同一个 batch_id', new Set(ids).size === 1 && ids[0] === aBatchId, `ids=${ids.join(',')}`);

const dupCount = spawnSync(
  'docker',
  [
    'exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A',
    '-c',
    `SELECT count(*) FROM historical_import_batches WHERE stage <> 'voided' AND dedup_key IS NOT NULL AND dedup_key IN (SELECT dedup_key FROM historical_import_batches WHERE stage <> 'voided' GROUP BY dedup_key HAVING count(*) > 1)`,
  ],
  { encoding: 'utf8' },
);
check('库里没有任何去重键被多个在用批次占用（幂等由唯一约束兜住）', Number(String(dupCount.stdout ?? '0').trim()) === 0, `重复键行数=${String(dupCount.stdout ?? '').trim()}`);

// ---------------------------------------------------------------------------
// ⑤ A.3 中文文件名：上传 → 落库 → 查询 → 重新打开
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑤ 中文文件名：上传 → 落库 → 查询 → 重新打开 ────────────');
check('上传响应里的文件名就是中文原名', a1.payload?.batch?.fileName === SYNTH_NAME, `得到 ${a1.payload?.batch?.fileName}`);

const dbName = spawnSync(
  'docker',
  ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', `SELECT file_name FROM historical_import_batches WHERE id = ${aBatchId}`],
  { encoding: 'utf8' },
);
const storedName = String(dbName.stdout ?? '').trim();
check('落库的 file_name 与原名逐字一致', storedName === SYNTH_NAME, `库内 ${storedName}`);

const listed = (aList.json?.data?.batches ?? []).find((x) => x.id === aBatchId);
check('查询接口回读的文件名与原名一致', listed?.fileName === SYNTH_NAME, `接口 ${listed?.fileName}`);

const reopened = await upload(tokens.A, SYNTH_PATH);
check('"重新打开"（复用批次）时返回的文件名仍是中文原名', reopened.payload?.batch?.fileName === SYNTH_NAME, `得到 ${reopened.payload?.batch?.fileName}`);

// 乱码特征自查：mojibake 的典型形态（Latin-1 高位字符成串）
const mojibakeRe = /[\u00C0-\u00FF]{2,}/;
const allStaging = spawnSync(
  'docker',
  ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', "SELECT file_name FROM historical_import_batches WHERE stage = 'staging'"],
  { encoding: 'utf8' },
);
const stagingNames = String(allStaging.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
const badNames = stagingNames.filter((n) => mojibakeRe.test(n));
check('全部在用批次的文件名都不含乱码特征（历史乱码已被迁移修好）', badNames.length === 0, badNames.join(' | ') || `${stagingNames.length} 个名字全部干净`);

const audit = spawnSync(
  'docker',
  ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', "SELECT value FROM service_settings WHERE key = 'historical.file-name-repair.audit'"],
  { encoding: 'utf8' },
);
const auditText = String(audit.stdout ?? '').trim();
check('存在文件名修复审计（**不静默改历史**）', auditText.length > 0, auditText.slice(0, 160));
check('审计里同时记录了修复前与修复后的值', /before/.test(auditText) && /after/.test(auditText), '');

// ---------------------------------------------------------------------------
// ⑥ 服务层判据（与 HTTP 侧同源）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑥ 服务层可见性判据（与 HTTP 侧同一函数）────────────────');
const probe = spawnSync(
  'docker',
  ['exec', CONTAINER, 'node', '-e', `
const svc = require('/app/nocobase/node_modules/@local/service-ticket');
const h = svc.historicalImport;
const batch = { id: 1, visibility_scope: 'uploader', uploader_user_id: 10, attribution_state: 'unconfirmed' };
const owner = { userId: 10, username: 'owner', isHq: false };
const other = { userId: 11, username: 'other', isHq: false };
const hq = { userId: 1, username: 'hq', isHq: true };
const store = h.createHistoricalImportStore({ db: { getRepository: () => ({ find: async () => [], findOne: async () => null, create: async () => ({}), update: async () => null }) } });
console.log(JSON.stringify({
  owner: store.canSeeBatchForTest(batch, owner),
  other: store.canSeeBatchForTest(batch, other),
  hq: store.canSeeBatchForTest(batch, hq),
  otherOnHqScoped: store.canSeeBatchForTest({ ...batch, visibility_scope: 'hq' }, other),
}));
`],
  { encoding: 'utf8' },
);
let probeOut = null;
try {
  probeOut = JSON.parse(String(probe.stdout ?? '').trim().split('\n').pop());
} catch {
  probeOut = null;
}
console.log(`      本人=${probeOut?.owner} 他人=${probeOut?.other} 总部=${probeOut?.hq} 他人读hq档=${probeOut?.otherOnHqScoped}`);
check('服务层判据：本人可见 / 他人不可见 / 总部可见 / hq 档他人不可见', probeOut?.owner === true && probeOut?.other === false && probeOut?.hq === true && probeOut?.otherOnHqScoped === false, JSON.stringify(probeOut));

// ---------------------------------------------------------------------------
// ⑦ 隐私：响应里不得出现完整手机号（合成号段）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑦ 隐私自检 ─────────────────────────────────────────────');
const uploadText = JSON.stringify([a1.payload, b1.payload]);
check('上传响应里没有完整手机号', !/1[3-9]\d{9}/.test(uploadText), '');

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  A.2 / A.3 门禁：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
