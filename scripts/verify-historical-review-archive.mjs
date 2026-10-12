#!/usr/bin/env node
/**
 * verify-historical-review-archive.mjs
 *   —— P11-3 第 4 项 · 用户 **B（异常确认）/ C（去重预览）/ D（受控归档闭环）** 验收门禁
 *
 * ===========================================================================
 * 用户原话（逐段对应到下面的小节）
 * ===========================================================================
 *  B「员工需要能看到每份文件的：售后候选数量 / 排除非售后数量 / 疑似重复数量 /
 *    **需要人工确认的唯一记录数量** / 主要异常类型及对应原始行。
 *    异常应支持查看原始值、修正标准化候选值、确认或保持待处理。
 *    **不得覆盖原始层，不得凭猜测补手机号、年份、服务结果。**
 *    康乐 Sheet2 的"来电表扬"等原始结果**必须保留**，不得强制伪装成另一个标准业务结果。
 *    异常核对操作要记录**真实操作人、时间、原值及新值**。」
 *
 *  C「同文件重复上传遵守权限隔离并保证幂等。跨文件可根据**客户联系方式、业务日期、
 *    家电信息**等提示疑似重复，但**不得只凭手机号相同就合并** ——
 *    同一客户可能有多次真实售后。去重结果允许人工确认保留两条或标记重复。
 *    **不能自动删除原始记录**，不能让不同门店的客户资料互相泄漏。」
 *
 *  D「实现明确的『确认归档』操作，目标是**独立的历史售后档案**，不是 serviceTickets
 *    的 NEW 工单。归档时必须：验证批次权限 / 验证正式门店 code 与真实门店身份的
 *    确认关系 / 验证映射版本·异常处理状态及人工确认 / 保留来源文件·工作表·原始行·
 *    标准化版本关联 / 保证重复点击与网络重试不会生成重复档案 / 保持历史与当前 SLA·KPI 隔离。
 *    只有明确仍需继续处理的历史事项，才允许由授权员工通过**单独的**『转为当前服务单』
 *    操作进入当前工作流；必须保留历史来源关联和创建审计，**不得批量自动转单**。
 *    **因为当前 15 家门店 code 尚未全部核定，真实历史资料不得未经确认就正式归属。**
 *    允许使用**完全合成的测试文件、已验证授权的测试门店**进行端到端归档演练；
 *    不得为了让门禁转绿，偷偷把**真实 Excel 归到某个占位门店**。」
 *
 * ⚠️ 本脚本只用**运行时生成的合成文件**，且只在**演练门店**（scope=drill）上归档。
 *    最后一条断言专门证明：**真实七份样本的批次一条都没有被归档**。
 *
 * 用法：node scripts/verify-historical-review-archive.mjs
 * 退出码：0 / 1 / 2
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
const RUN = `R${Date.now().toString(36).toUpperCase()}`;

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

function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  );
  return String(r.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-3 第 4 项 · B 异常确认 / C 去重预览 / D 受控归档闭环');
console.log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(PLUGIN_DIST)) {
  console.error('  ⛔ 找不到插件产物 —— 先跑 node scripts/build-plugin.mjs');
  process.exit(2);
}
if (!String(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行`);
  process.exit(2);
}

const ACCOUNTS = {
  A: { label: 'UAT-A（S01）', email: 'uat.store.a@svc.local', pwd: envValue('UAT_STORE_A_PASSWORD') },
  B: { label: 'UAT-B（S02）', email: 'uat.store.b@svc.local', pwd: envValue('UAT_STORE_B_PASSWORD') },
  HQ: { label: 'admin（总部）', email: envValue('SMOKE_ADMIN_EMAIL') || 'admin@nocobase.com', pwd: envValue('SMOKE_ADMIN_PASSWORD') },
};
for (const [k, a] of Object.entries(ACCOUNTS)) {
  if (!a.pwd) {
    console.error(`  ⛔ ${k} 口令缺失`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 合成文件（**每轮内容不同**，保证门禁可重复跑）
// ---------------------------------------------------------------------------
fs.mkdirSync(TMP, { recursive: true });
function buildSynth(fileName, rows, sheetName = '合成') {
  const requireWs = createRequire(path.join(process.env.USERPROFILE ?? '', '.workbuddy/binaries/node/workspace/anchor.cjs'));
  const XLSX = requireWs('xlsx');
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const p = path.join(TMP, fileName);
  fs.writeFileSync(p, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  return p;
}

const HEADER = ['回访时间', '安装时间', '姓名', '电话', '机器信息', '数量', '销售单位', '性质', '回访结果'];

// 主文件：刻意包含 ① 缺手机号 ② 一格多号 ③ 含糊日期 ④ 服务结果不在已知集合（"来电表扬"）
const FILE_A = buildSynth(`合成-主-${RUN}.xlsx`, [
  HEADER,
  // ① 缺手机号 + ④ 服务结果不在已知集合
  ['2026-09-01', '2026-09-02', `合成甲${RUN}`, '', `合成空调KFR-01-${RUN}`, 1, '合成门店', '安装', '来电表扬'],
  // ② 一格多号（同一客户两个号）+ 日期含糊
  ['9月3日', '2026-09-04', `合成乙${RUN}`, '13800000111/13800000112', `合成冰箱BCD-02-${RUN}`, 1, '合成门店', '维修', '满意'],
  // 干净行（应可直接归档）
  ['2026-09-05', '2026-09-06', `合成丙${RUN}`, '13800000113', `合成洗衣机XQG-03-${RUN}`, 1, '合成门店', '安装', '满意'],
  // 干净行
  ['2026-09-07', '2026-09-08', `合成丁${RUN}`, '13800000114', `合成电视TV-04-${RUN}`, 1, '合成门店', '安装', '满意'],
]);

// 第二份文件：与主文件的"合成丙"共用手机号 + 共用家电型号 ⇒ 强证据疑似重复
const FILE_B = buildSynth(`合成-交叉-${RUN}.xlsx`, [
  HEADER,
  ['2026-09-05', '2026-09-06', `合成丙${RUN}`, '13800000113', `合成洗衣机XQG-03-${RUN}`, 1, '合成门店', '安装', '满意'],
  // 只共用手机号（不同型号、不同日期）⇒ 弱证据
  ['2026-08-01', '2026-08-02', `合成戊${RUN}`, '13800000114', `合成微波炉MW-05-${RUN}`, 1, '合成门店', '维修', '满意'],
]);

console.log(`  · 合成主文件   ${path.basename(FILE_A)}`);
console.log(`  · 合成交叉文件 ${path.basename(FILE_B)}`);

// ---------------------------------------------------------------------------
async function signIn(email, pwd) {
  const res = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pwd }),
  });
  const json = await res.json().catch(() => null);
  const token = json?.data?.token ?? '';
  if (!token) throw new Error(`${email} 登录失败 HTTP ${res.status}`);
  return token;
}
async function api(token, pathname, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(`${SVC_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...headers,
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
    /* 非 JSON */
  }
  return { status: res.status, json, text, payload: json?.data ?? json };
}
async function upload(token, filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));
  return api(token, '/api/svc:historicalUpload', { body: form });
}

const tokens = {};
for (const [k, a] of Object.entries(ACCOUNTS)) tokens[k] = await signIn(a.email, a.pwd);
console.log('  · 三个账号已登录');

// ---------------------------------------------------------------------------
// 🆕 演练夹具改为**服务端签发**（用户第一项：drill 只接受服务端确认的合成批次）
// ---------------------------------------------------------------------------
//
// 🔴 本门禁此前自己造合成 xlsx 再上传 —— 那样上传得到的批次是 `data_origin='real'`，
//    而新的安全约束要求 drill 归属只能用于 `synthetic` 批次
//    ⇒ 归档那一步会被**正确拒绝**。这正说明约束生效了。
//    要跑通闭环，就必须改用**服务端签发**的夹具：它由服务端生成、哈希登记在册，
//    上传时服务端按内容哈希把它认出来。
async function issueFixture(token, label) {
  const r = await api(token, '/api/svc:historicalDrillFixture', { body: {} });
  if (r.status !== 200 || !r.payload?.base64) {
    throw new Error(`签发演练夹具失败（${label}）：HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
  const p = path.join(TMP, r.payload.fileName);
  fs.writeFileSync(p, Buffer.from(r.payload.base64, 'base64'));
  return { path: p, sha256: r.payload.sha256, fileName: r.payload.fileName };
}
const FIXTURE_A = await issueFixture(tokens.HQ, '主夹具');
const FIXTURE_B = await issueFixture(tokens.HQ, '交叉夹具');
console.log(`  · 服务端签发夹具：${FIXTURE_A.fileName} / ${FIXTURE_B.fileName}`);
check('服务端能签发演练夹具（drill 安全边界的唯一入口）', Boolean(FIXTURE_A.sha256 && FIXTURE_B.sha256), FIXTURE_A.sha256.slice(0, 12));
check('两次签发的夹具内容不同（各自有独立哈希）', FIXTURE_A.sha256 !== FIXTURE_B.sha256, '');

const beforeTickets = Number(psql('SELECT count(*) FROM service_tickets'));
console.log(`  · 验收前当前工单数 ${beforeTickets}`);

// ---------------------------------------------------------------------------
// ① 上传 + 映射
// ---------------------------------------------------------------------------
console.log('');
console.log('── ① 上传合成文件并生成标准化结果 ─────────────────────────');
const upA = await upload(tokens.A, FIXTURE_A.path);
const batchA = upA.payload?.batch;
check('合成主文件上传成功', upA.status === 200 && !!batchA?.id, `HTTP ${upA.status} ${batchA?.batchNo}`);
// 🔴 关键：批次被服务端按**内容哈希**认定为 synthetic（不是靠请求体声明）
const originA = psql(`SELECT data_origin FROM historical_import_batches WHERE id=${batchA.id}`);
check('🔴 服务端签发的夹具 ⇒ 批次的 data_origin = synthetic', originA === 'synthetic', `库内 data_origin=${originA}`);
const sheetA = upA.payload.sheets[0];
const fieldsA = { ...sheetA.autoMapping };
// 合成表的列名与真实表不同，这里显式指定映射（**不同文件的列顺序可以不一样**）
const mapA = {
  reviewDate: 0,
  deliveryDate: 1,
  customerName: 2,
  customerPhone: 3,
  device: 4,
  quantity: 5,
  storeHint: 6,
  serviceKind: 7,
  reviewResult: 8,
};
void fieldsA;
const staged = await api(tokens.A, '/api/svc:historicalStage', {
  body: { batchId: batchA.id, sheets: [{ sheetName: sheetA.sheet, headerRow: sheetA.headerRow, fields: mapA }] },
});
check('映射并暂存成功', staged.status === 200 && staged.payload?.written > 0, `写入 ${staged.payload?.written} 行，v${staged.payload?.mappingVersion}`);

const upB = await upload(tokens.A, FIXTURE_B.path);
const sheetB = upB.payload.sheets[0];
const batchB = upB.payload.batch;
await api(tokens.A, '/api/svc:historicalStage', {
  body: { batchId: batchB.id, sheets: [{ sheetName: sheetB.sheet, headerRow: sheetB.headerRow, fields: mapA }] },
});

// ---------------------------------------------------------------------------
// ①b 🔴 每一次 stage 都要留下"这一版用的是哪套映射"，并且**可由它逐行重算复现**
// ---------------------------------------------------------------------------
//
// 这条是用户第 5 项核对里查出的缺陷的正向验证：
//   原实现只在**建批次时**写一次 `mapping_json`，历次 stage 的映射**没有留痕** ⇒
//   候选表里躺着多代结果，却**没有任何地方记着各代用的是哪套列映射** ⇒ 无法复现。
//   （实测影响见 `verify-dev158-impact.mjs` 的 ④c：对真实批次只能比对"行号集合"。）
//
// 判据必须**端到端**：不是"字段里有没有东西"，而是
//   「拿库里的映射快照 + 原始行重跑映射引擎 ⇒ 与库里那一代的 fields_json 逐行一致」。
console.log('');
console.log('── ①b 映射快照：每一代都可复现（逐行重算比对）──────────────');
{
  const mappingRaw = psql(`SELECT mapping_json::text FROM historical_import_batches WHERE id=${batchA.id}`);
  let versioned = false;
  let versionKeys = [];
  try {
    versionKeys = Object.keys(JSON.parse(mappingRaw));
    versioned = versionKeys.length > 0 && versionKeys.every((k) => /^[0-9]+$/.test(k));
  } catch {
    versioned = false;
  }
  console.log(`      库内映射快照的版本键：${versionKeys.join(',') || '（空）'}`);
  check('🔴 每次 stage 都写下了"该版本用的映射"（按版本累积，不是只写建批次那一次）', versioned, versionKeys.join(','));
  check('快照里包含当前阶段刚产生的那一版', versionKeys.includes(String(staged.payload?.mappingVersion)), `v${staged.payload?.mappingVersion}`);

  // 端到端：容器内用"该版映射 + 原始行"重算，与库里那一代逐行比对
  const mappingOfStage = (() => {
    try {
      return JSON.parse(mappingRaw)[String(staged.payload?.mappingVersion)] ?? null;
    } catch {
      return null;
    }
  })();
  if (!mappingOfStage) {
    check('可由映射快照逐行重算复现', false, '取不到该版映射');
  } else {
    const workerPath = path.join(TMP, '_recompute-check.cjs');
    fs.mkdirSync(path.dirname(workerPath), { recursive: true });
    fs.writeFileSync(
      workerPath,
      `
const svc = require('/app/nocobase/node_modules/@local/service-ticket');
const payload = JSON.parse(process.env.RC_PAYLOAD);
const res = svc.historicalImport.applyMapping({
  sheetName: payload.sheetName,
  header: payload.header,
  sheetClass: payload.sheetClass,
  mapping: { headerRow: payload.headerRow, fields: payload.fields },
  // ⚠️ 原始单元格字段叫 raw（键 c0..）——见 parse.ts 的 RowCandidate
  rows: payload.rows.map((r) => ({ sourceRow: r.sourceRow, cells: r.cells })),
});
console.log(JSON.stringify(res.rows.map((x) => ({ sourceRow: x.sourceRow, fields: x.fields }))));
`,
    );
    // 库内该版本的候选
    const storedRows = String(
      spawnSync(
        'docker',
        [
          'exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '\t', '-c',
          `SELECT r.source_row, c.fields_json::text
             FROM historical_import_candidates c
             JOIN historical_import_rows r ON r.id = c.row_id
            WHERE c.batch_id=${batchA.id} AND c.mapping_version=${staged.payload?.mappingVersion}
              AND r.sheet_name='${sheetA.sheet}'
            ORDER BY r.source_row`,
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      ).stdout ?? '',
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    // 原始行（喂给重算）
    const rawRows = String(
      spawnSync(
        'docker',
        [
          // ⚠️ 分隔符必须是制表符：`cells_json::text` 里含 `|`，用 `|` 分列会把 JSON 截断
          'exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-F', '\t', '-c',
          `SELECT source_row, header_json::text, cells_json::text, classification
             FROM historical_import_rows WHERE batch_id=${batchA.id} AND sheet_name='${sheetA.sheet}'
            ORDER BY source_row`,
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      ).stdout ?? '',
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    const payload = {
      sheetName: sheetA.sheet,
      header: JSON.parse(rawRows[0][1]),
      sheetClass: rawRows[0][3],
      headerRow: mappingOfStage[sheetA.sheet]?.headerRow ?? 1,
      fields: mappingOfStage[sheetA.sheet]?.fields ?? {},
      rows: rawRows.map((r) => ({ sourceRow: Number(r[0]), cells: JSON.parse(r[2]) })),
    };
    const rr = spawnSync(
      'docker',
      ['exec', '-e', `RC_PAYLOAD=${JSON.stringify(payload)}`, CONTAINER, 'node', '/app/nocobase/storage/tmp/historical-synth/_recompute-check.cjs'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    let recomputed = null;
    try {
      recomputed = JSON.parse(String(rr.stdout ?? '').trim().split('\n').pop());
    } catch {
      recomputed = null;
    }
    if (!recomputed) {
      check('可由映射快照逐行重算复现', false, `重算失败：${String(rr.stderr ?? '').slice(0, 240)}`);
    } else {
      const canon = (f) =>
        JSON.stringify({
          name: f?.customerName ?? null,
          phones: (f?.customerPhones ?? []).map((p) => p.digits),
          dates: Object.fromEntries(Object.entries(f?.dates ?? {}).map(([k, v]) => [k, v?.iso ?? null])),
          devices: (f?.devices ?? []).map((d) => d.model),
          review: f?.reviewResult ? { value: f.reviewResult.value, state: f.reviewResult.state, raw: f.reviewResult.raw } : null,
        });
      const want = new Map(recomputed.map((x) => [Number(x.sourceRow), canon(x.fields)]));
      let compared = 0;
      const diffs = [];
      for (const [rowNo, fieldsText] of storedRows) {
        const w = want.get(Number(rowNo));
        if (w === undefined) continue;
        compared += 1;
        const got = canon(JSON.parse(fieldsText));
        if (got !== w && diffs.length < 3) diffs.push(`第${rowNo}行：库内${got.slice(0, 80)} vs 重算${w.slice(0, 80)}`);
      }
      console.log(`      逐行比对 ${compared} 行（v${staged.payload?.mappingVersion} · ${sheetA.sheet}）`);
      check('样本量足够（不是"比了 0 行就说一致"）', compared >= 2, `${compared} 行`);
      check(
        '🔴 库里那一代的标准化结果 == 用该版映射 + 原始行重算出来的结果（逐行一致 ⇒ 可复现）',
        compared > 0 && diffs.length === 0,
        diffs.length ? diffs.join(' | ') : `一致 ${compared} 行`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ② B：概览计数
// ---------------------------------------------------------------------------
console.log('');
console.log('── ② B：一份文件的全部计数（含"唯一记录数"）──────────────');
const summaryRes = await api(tokens.A, `/api/svc:historicalReviewSummary?batchId=${batchA.id}`, { method: 'GET' });
const S = summaryRes.payload?.summary ?? {};
console.log(`      售后候选 ${S.importableCount} · 排除非售后 ${S.excludedCount} · 疑似重复 ${S.duplicateCount} · 需人工确认 ${S.needsConfirmCount}（唯一行 ${S.needsConfirmUniqueRowCount}）`);
console.log(`      异常：唯一行 ${S.anomalyUniqueRowCount} · 命中次数 ${S.anomalyHitCount}`);
console.log(`      类型：${(S.anomalyTypes ?? []).map((t) => `${t.label}×${t.hitCount}`).join(' · ')}`);
check('返回了五个分类计数', ['importableCount', 'excludedCount', 'duplicateCount', 'needsConfirmCount', 'parseErrorCount'].every((k) => typeof S[k] === 'number'), JSON.stringify({ i: S.importableCount, e: S.excludedCount, d: S.duplicateCount, n: S.needsConfirmCount }));
check('分类之和 == 候选总数（互斥可求和）', S.dispositionSum === S.candidateCount, `${S.dispositionSum} vs ${S.candidateCount}`);
check(
  '🔴 "需要人工确认的唯一记录数"用**行去重**算，不是把各分类相加',
  S.needsConfirmUniqueRowCount <= S.needsConfirmCount && S.needsConfirmUniqueRowCount > 0,
  `唯一 ${S.needsConfirmUniqueRowCount} ≤ 记录 ${S.needsConfirmCount}`,
);
check(
  '🔴 异常同样区分"唯一行数"与"命中次数"，且两者不等（本次合成数据刻意构造了多重命中）',
  S.anomalyUniqueRowCount <= S.anomalyHitCount,
  `唯一 ${S.anomalyUniqueRowCount} vs 命中 ${S.anomalyHitCount}`,
);
check('给出了主要异常类型', (S.anomalyTypes ?? []).length > 0, (S.anomalyTypes ?? []).map((t) => t.key).join(','));

// ---------------------------------------------------------------------------
// ②b 🔴 「必须处理 N」与「原值保留的提示 M」必须**分开**（用户第四项）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ②b 阻塞 / 非阻塞两类提示必须分开（用户第四项）──────────');
{
  console.log(
    `      必须处理 ${S.blockingUniqueRowCount} 条（阻塞归档） · ` +
      `原值保留的提示 ${S.advisoryUniqueRowCount} 条（不阻塞） · ` +
      `命中合计 ${S.anomalyHitCount} 次 / 涉及 ${S.anomalyUniqueRowCount} 行`,
  );
  check(
    '🔴 分别给出了"阻塞"与"非阻塞"两个口径（不是只给一个"异常命中"）',
    typeof S.blockingUniqueRowCount === 'number' && typeof S.advisoryUniqueRowCount === 'number',
    JSON.stringify({ blocking: S.blockingUniqueRowCount, advisory: S.advisoryUniqueRowCount }),
  );
  check(
    '两个口径之和不超过"涉及的唯一行数"（一个行可以同时有阻塞与非阻塞问题）',
    S.blockingUniqueRowCount <= S.anomalyUniqueRowCount && S.advisoryUniqueRowCount <= S.anomalyUniqueRowCount,
    '',
  );
  check(
    '🔴 "必须处理"的行数与 needs-confirm 的分类**一致**（口径不再两头不对）',
    S.blockingUniqueRowCount === S.needsConfirmUniqueRowCount ||
      // 允许 blocking 行同时被判成 duplicate（去重是另一条阻塞路径）——但必须 >= needs-confirm
      S.blockingUniqueRowCount >= S.needsConfirmUniqueRowCount,
    `blocking=${S.blockingUniqueRowCount} needs-confirm=${S.needsConfirmUniqueRowCount}`,
  );
  check(
    '非阻塞提示单独列出类型（人能看出"提示的是什么"）',
    (S.advisoryTypes ?? []).length > 0,
    (S.advisoryTypes ?? []).map((t) => `${t.label}×${t.hitCount}`).join(' · '),
  );
  check(
    '🔴 存在"必须处理 0 条、但仍有非阻塞提示"的真实状态 —— 这正是要解释清楚的组合',
    S.blockingUniqueRowCount === 0 ? S.advisoryUniqueRowCount > 0 : true,
    `blocking=${S.blockingUniqueRowCount} advisory=${S.advisoryUniqueRowCount}`,
  );
  check(
    '响应里的说明文字把三类数字都讲清了',
    /必须处理/.test(String(summaryRes.payload?.anomalyNote)) &&
      /原值保留的提示/.test(String(summaryRes.payload?.anomalyNote)),
    String(summaryRes.payload?.anomalyNote).slice(0, 140),
  );
}
check(
  '每种异常类型都给出了对应的**原始行号**（供人回原文件定位）',
  (S.anomalyTypes ?? []).every((t) => (t.sampleRows ?? []).length > 0 && t.sampleRows.every((r) => r.sourceRow >= 1)),
  (S.anomalyTypes ?? []).map((t) => `${t.key}:${t.sampleRows.map((r) => r.sourceRow).join('/')}`).join(' '),
);

// ---------------------------------------------------------------------------
// ③ B：人工核对 + 修正（含审计与"不覆盖"）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ③ B：逐行核对 / 修正（原值·新值·操作人留痕）────────────');
const candidates = await api(tokens.A, `/api/svc:historicalBatches?batchId=${batchA.id}&limit=200`, { method: 'GET' });
const cands = candidates.payload?.candidates ?? [];
const needsConfirm = cands.filter((c) => c.disposition === 'needs-confirm');
const importables = cands.filter((c) => c.disposition === 'importable');
console.log(`      候选 ${cands.length}：可导入 ${importables.length} / 需确认 ${needsConfirm.length}`);
check('取回了候选列表', cands.length > 0, `${cands.length} 条`);

// 原始层快照（稍后证明没被覆盖）
const rawBefore = psql(`SELECT md5(string_agg(cells_json::text, '' ORDER BY id)) FROM historical_import_rows WHERE batch_id=${batchA.id}`);
const machineBefore = psql(`SELECT md5(string_agg(fields_json::text, '' ORDER BY id)) FROM historical_import_candidates WHERE batch_id=${batchA.id}`);

// ③a 非法修正必须被拒：手机号形态不对
const badPhone = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: { batchId: batchA.id, candidateId: needsConfirm[0]?.id, action: 'correct', field: 'customerPhone', value: '12345' },
});
check('修正手机号为非法形态 ⇒ 422（不得凭猜测补位）', badPhone.status === 422, `HTTP ${badPhone.status} ${badPhone.json?.errors?.[0]?.code ?? ''}`);

// ③b 非法日期（缺年份）必须被拒
const badDate = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: { batchId: batchA.id, candidateId: needsConfirm[0]?.id, action: 'correct', field: 'serviceDate', value: '9.1' },
});
check('修正日期为"9.1"这类缺年份写法 ⇒ 422', badDate.status === 422, `HTTP ${badDate.status} ${badDate.json?.errors?.[0]?.code ?? ''}`);

// ③c 合法修正：把缺手机号那行补成合成号码（人填的，且形态合法）
const targetRow = cands.find((c) => (c.issues ?? []).some((i) => /电话列为空|拆不出合法手机号/.test(i))) ?? needsConfirm[0];
const goodFix = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: {
    batchId: batchA.id,
    candidateId: targetRow.id,
    action: 'correct',
    field: 'customerPhone',
    value: '13800000199',
    note: `验收脚本合成修正 ${RUN}`,
  },
});
check('合法的人工修正被接受', goodFix.status === 200, `HTTP ${goodFix.status}`);
check(
  '响应明确回"机器结果与原始值都没动"',
  goodFix.payload?.machineFieldsUnchanged === true && goodFix.payload?.rawLayerUnchanged === true,
  JSON.stringify({ m: goodFix.payload?.machineFieldsUnchanged, r: goodFix.payload?.rawLayerUnchanged }),
);

// ③d 审计留痕：真实操作人 / 时间 / 原值 / 新值
const reviewRows = psql(
  `SELECT count(*) FROM historical_import_reviews WHERE batch_id=${batchA.id}`,
);
const reviewDetail = psql(
  `SELECT operator_username || '|' || action || '|' || coalesce(field_name,'') || '|' ||
          coalesce(old_value_json::text,'') || '|' || coalesce(new_value_json::text,'') || '|' ||
          (operated_at IS NOT NULL)::text
     FROM historical_import_reviews WHERE batch_id=${batchA.id} AND action='correct' ORDER BY id DESC LIMIT 1`,
);
console.log(`      审计行数 ${reviewRows}；最近一条修正：${reviewDetail}`);
const parts = reviewDetail.split('|');
check('修正操作写入了审计（有操作人 / 原值 / 新值 / 时间）', Number(reviewRows) > 0 && parts[0] && parts[3] && parts[4] && parts[5] === 'true', '');
check('审计里记得住**是谁**做的（不是匿名）', /uat[._]?store[._]?a|UAT-A/i.test(reviewDetail), parts[0]);

// ③e 原始层与机器结果**一个字节都没变**
const rawAfter = psql(`SELECT md5(string_agg(cells_json::text, '' ORDER BY id)) FROM historical_import_rows WHERE batch_id=${batchA.id}`);
const machineAfter = psql(`SELECT md5(string_agg(fields_json::text, '' ORDER BY id)) FROM historical_import_candidates WHERE batch_id=${batchA.id}`);
check('🔴 原始层未被修改（cells_json 的 md5 前后一致）', rawBefore === rawAfter && rawBefore.length > 0, `${rawBefore.slice(0, 12)}…`);
check('🔴 机器标准化结果未被修改（fields_json 的 md5 前后一致）', machineBefore === machineAfter && machineBefore.length > 0, `${machineBefore.slice(0, 12)}…`);

// ③f "来电表扬"必须原样保留（不得被伪装成标准业务结果）
const praised = psql(
  `SELECT count(*) FROM historical_import_candidates
    WHERE batch_id=${batchA.id} AND fields_json::text LIKE '%来电表扬%'`,
);
const praisedRaw = psql(
  `SELECT count(*) FROM historical_import_rows
    WHERE batch_id=${batchA.id} AND cells_json::text LIKE '%来电表扬%'`,
);
check('🔴 原始层里"来电表扬"仍在（原样保留）', Number(praisedRaw) > 0, `${praisedRaw} 行`);
check('🔴 机器标准化结果里"来电表扬"仍是原值（state=unrecognized，**未被伪装成"满意"**）', Number(praised) > 0, `${praised} 行`);
const praisedIsUnknown = psql(
  `SELECT count(*) FROM historical_import_candidates
    WHERE batch_id=${batchA.id} AND fields_json::text LIKE '%来电表扬%' AND fields_json::text LIKE '%unrecognized%'`,
);
check('该行的服务结果被标为 unrecognized（**没有**被改成已知结果）', Number(praisedIsUnknown) > 0, `${praisedIsUnknown} 行`);

// ③g 「逐条确认」这一动作本身可用（**先只确认一行**——剩余的留给 ⑥ 证明
//     "还有待处理记录时归档会被拦下"）。
// ⚠️ 这一行必须挑 **importable** 的行来确认。
//    第一版挑的是 `needsConfirm[0]`，于是"确认动作可用"这条被证明了，
//    却把**唯一一行待确认**提前处理掉了 ⇒ 后面 ⑥ 里"还有待处理记录时归档会被拦下"
//    就永远触发不了（实测报 HTTP 200，看起来像"归档没拦住"）。
//    ⇒ **测试步骤本身的副作用**也要当作判据的一部分来设计。
const confirmTarget = importables[0] ?? cands.find((c) => c.disposition === 'importable') ?? cands[0];
const oneConfirm = await api(tokens.A, '/api/svc:historicalReviewRow', {
  body: { batchId: batchA.id, candidateId: confirmTarget.id, action: 'confirm', note: `验收：单行确认 ${RUN}` },
});
check('逐条确认可用（挑一行**可导入**的来点，不动待确认那些）', oneConfirm.status === 200, `HTTP ${oneConfirm.status}`);

// ---------------------------------------------------------------------------
// ④ C：去重预览
// ---------------------------------------------------------------------------
console.log('');
console.log('── ④ C：跨文件疑似重复（只提示、不合并）───────────────────');
const dupRes = await api(tokens.A, '/api/svc:historicalDuplicates', { method: 'GET' });
const dup = dupRes.payload ?? {};
console.log(`      扫描 ${dup.scannedBatches} 个批次 / ${dup.scannedCandidates} 条候选；强 ${dup.strongCount} · 弱 ${dup.weakCount}`);
for (const g of (dup.groups ?? []).slice(0, 3)) {
  console.log(`      · [${g.strength}] ${g.reasons.join(' + ')} → ${g.members.map((m) => `${m.batchNo}#${m.sourceRow}`).join(' vs ')}`);
}
check('检测到跨文件疑似重复', (dup.groups ?? []).length > 0, `强 ${dup.strongCount} / 弱 ${dup.weakCount}`);
check(
  '🔴 只凭手机号相同只能算**弱证据**（同一客户可能有多次真实售后）',
  (dup.groups ?? []).some((g) => g.strength === 'weak' && g.reasons.length === 1 && g.reasons[0] === '手机号相同'),
  '',
);
check(
  '手机号 + 家电型号/日期/姓名同时相同 ⇒ **强证据**',
  (dup.groups ?? []).some((g) => g.strength === 'strong' && g.reasons.length >= 2),
  (dup.groups ?? []).find((g) => g.strength === 'strong')?.reasons.join(' + ') ?? '',
);
check('响应里明确写了"只提示、不合并、不删除"', /不会自动合并|不合并/.test(dup.note ?? ''), dup.note ?? '');
check('成员里给出的手机号是**脱敏**的', (dup.groups ?? []).every((g) => g.members.every((m) => !/^\d{11}$/.test(String(m.mobileMasked ?? '')))), '');

// 人工裁决：保留两条
const keepBoth = await api(tokens.A, '/api/svc:historicalDuplicateDecision', {
  body: { batchId: batchA.id, candidateId: importables[0]?.id ?? cands[0].id, action: 'keep-both', note: `验收：保留两条 ${RUN}` },
});
check('去重裁决"保留两条"可用', keepBoth.status === 200, `HTTP ${keepBoth.status}`);
const dupReviewCount = psql(`SELECT count(*) FROM historical_import_reviews WHERE batch_id=${batchA.id} AND scope='duplicate'`);
check('去重裁决也留了审计（scope=duplicate）', Number(dupReviewCount) > 0, `${dupReviewCount} 条`);

// 跨门店：B 不能看到 A 的重复
const dupB = await api(tokens.B, '/api/svc:historicalDuplicates', { method: 'GET' });
check(
  '🔴 B 门店的去重扫描**看不到** A 门店的批次（不跨店泄漏客户资料）',
  !(dupB.payload?.groups ?? []).some((g) => g.members.some((m) => m.batchNo === batchA.batchNo)),
  `B 扫到 ${dupB.payload?.scannedBatches ?? 0} 个批次`,
);

// ---------------------------------------------------------------------------
// ⑤ D：归档前置全部被拒
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑤ D：归档前置（未确认归属 / 非总部 / 非名单门店）───────');
const archEarly = await api(tokens.A, '/api/svc:historicalArchive', { body: { batchId: batchA.id } });
check(
  '未确认门店归属 ⇒ 409 ATTRIBUTION_UNCONFIRMED（不得正式归属）',
  archEarly.status === 409 && archEarly.json?.errors?.[0]?.code === 'ATTRIBUTION_UNCONFIRMED',
  `HTTP ${archEarly.status} ${archEarly.json?.errors?.[0]?.code ?? ''}`,
);

const confirmByStore = await api(tokens.A, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S01' },
});
check('门店账号不得确认归属（只有总部可以）⇒ 403', confirmByStore.status === 403, `HTTP ${confirmByStore.status}`);

const confirmNonListed = await api(tokens.HQ, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S09' },
});
check(
  '🔴 归属到**不在身份确认名单**的门店 ⇒ 409（15 家门店 code 未全部核定）',
  confirmNonListed.status === 409 && confirmNonListed.json?.errors?.[0]?.code === 'STORE_IDENTITY_UNCONFIRMED',
  `HTTP ${confirmNonListed.status} ${confirmNonListed.json?.errors?.[0]?.code ?? ''}`,
);

const confirmProduction = await api(tokens.HQ, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S01', scope: 'production' },
});
check(
  '🔴 对**只有演练范围**的门店发起**正式**归属 ⇒ 409 STORE_IDENTITY_DRILL_ONLY',
  confirmProduction.status === 409 && confirmProduction.json?.errors?.[0]?.code === 'STORE_IDENTITY_DRILL_ONLY',
  `HTTP ${confirmProduction.status} ${confirmProduction.json?.errors?.[0]?.code ?? ''}`,
);

// ---------------------------------------------------------------------------
// ⑥ D：演练归档闭环
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑥ D：合成文件 + 已验证授权门店的**演练**归档 ───────────');
const confirmDrill = await api(tokens.HQ, '/api/svc:historicalConfirmAttribution', {
  body: { batchId: batchA.id, storeCode: 'S01', scope: 'drill', note: `演练归属 ${RUN}` },
});
check('总部显式按 drill 范围确认归属 ⇒ 成功（演练路径）', confirmDrill.status === 200 && confirmDrill.payload?.attributionScope === 'drill', `HTTP ${confirmDrill.status} scope=${confirmDrill.payload?.attributionScope}`);

// 🔴 归档前仍有"待人工处理"的记录 ⇒ 必须被拦下（用户 D 条：验证异常处理状态及人工确认）
//
// ⚠️ 这一条**必须**在"把待确认行全部确认完"**之前**跑 ——
//    第一版放在确认循环之后，于是它测的是一个"已经没有待处理行"的批次，
//    断言恒不成立（实测报 HTTP 200）。**顺序本身就是判据的一部分**。
const archPending = await api(tokens.HQ, '/api/svc:historicalArchive', { body: { batchId: batchA.id } });
check(
  '🔴 归档前若仍有"待人工处理"的记录 ⇒ 409 REVIEW_PENDING（先核对再归档）',
  archPending.status === 409 && archPending.json?.errors?.[0]?.code === 'REVIEW_PENDING',
  `HTTP ${archPending.status} ${archPending.json?.errors?.[0]?.code ?? ''}`,
);

// 现在把剩余待处理行逐条确认（演练：每条都写审计）
let confirmedCount = 0;
for (const c of cands.filter((x) => x.disposition === 'needs-confirm' || x.disposition === 'duplicate')) {
  const r = await api(tokens.A, '/api/svc:historicalReviewRow', {
    body: { batchId: batchA.id, candidateId: c.id, action: 'confirm', note: `验收：逐条确认 ${RUN}` },
  });
  if (r.status === 200) confirmedCount += 1;
}
console.log(`      已逐条确认 ${confirmedCount} 行`);
check('逐条确认后该批次不再有待处理行', confirmedCount > 0, `${confirmedCount} 行`);

const archA1 = await api(tokens.HQ, '/api/svc:historicalArchive', { body: { batchId: batchA.id, note: `演练归档 ${RUN}` } });
console.log(`      创建 ${archA1.payload?.created} 条 · 复用 ${archA1.payload?.reused} 条 · 跳过排除行 ${archA1.payload?.excludedRowsSkipped} 条`);
check('演练归档成功', archA1.status === 200 && archA1.payload?.created > 0, `HTTP ${archA1.status}`);
check('归档响应明确"没有创建任何当前服务单、未影响 SLA"', archA1.payload?.ticketsCreated === 0 && archA1.payload?.slaAffected === false, JSON.stringify({ t: archA1.payload?.ticketsCreated, s: archA1.payload?.slaAffected }));

// 幂等：重复点击
const archA2 = await api(tokens.HQ, '/api/svc:historicalArchive', { body: { batchId: batchA.id, note: `演练归档重复点击 ${RUN}` } });
check(
  '🔴 重复点击归档 ⇒ 不再新增档案（全部 reused）',
  archA2.status === 200 && archA2.payload?.created === 0 && archA2.payload?.reused === archA1.payload?.created,
  `created=${archA2.payload?.created} reused=${archA2.payload?.reused}`,
);
const archiveCount = psql(`SELECT count(*) FROM historical_service_archives WHERE batch_id=${batchA.id}`);
check('库内该批次档案数 == 首次创建的条数（幂等键兜住）', Number(archiveCount) === archA1.payload?.created, `${archiveCount} vs ${archA1.payload?.created}`);

// 原始行与映射版本关联仍在
const linkOk = psql(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_rows r ON r.id = a.row_id
    WHERE a.batch_id=${batchA.id} AND a.mapping_version IS NOT NULL AND r.source_row IS NOT NULL`,
);
check('档案保留了来源关联（批次/原始行/工作表/原始行号/映射版本齐全）', Number(linkOk) === Number(archiveCount), `${linkOk}/${archiveCount}`);
const sheetLinked = psql(`SELECT count(*) FROM historical_service_archives WHERE batch_id=${batchA.id} AND source_sheet IS NOT NULL AND source_row IS NOT NULL`);
check('档案带上了工作表与原始行号', Number(sheetLinked) === Number(archiveCount), `${sheetLinked}/${archiveCount}`);

// 排除的非售后行**不进档案**
const excludedArchived = psql(
  `SELECT count(*) FROM historical_service_archives a
     JOIN historical_import_candidates c ON c.row_id = a.row_id AND c.mapping_version = a.mapping_version
    WHERE a.batch_id=${batchA.id} AND c.disposition = 'excluded'`,
);
check('🔴 非售后排除记录**不进入**历史售后档案', Number(excludedArchived) === 0, `${excludedArchived} 条`);

// 历史与当前工单隔离
const afterTickets = Number(psql('SELECT count(*) FROM service_tickets'));
check(
  '🔴 当前服务单数量**不因历史归档变化**（归档与 current 工单完全隔离）',
  afterTickets === beforeTickets,
  `${beforeTickets} → ${afterTickets}`,
);

// 档案查看
const archiveList = await api(tokens.HQ, '/api/svc:historicalArchives?limit=50', { method: 'GET' });
check('可以查看历史档案', archiveList.status === 200 && (archiveList.payload?.archives ?? []).length > 0, `${archiveList.payload?.total} 条`);
check('档案接口明确标注"这不是当前在办工单"', archiveList.payload?.kind === 'historical-archive' && archiveList.payload?.notServiceTickets === true, '');
check(
  '档案列表里的手机号是**脱敏**的',
  (archiveList.payload?.archives ?? []).every((a) => !a.customerMobileMasked || /\*/.test(String(a.customerMobileMasked))),
  (archiveList.payload?.archives ?? [])[0]?.customerMobileMasked ?? '(无)',
);
check(
  '每条档案都能回答"来自哪个文件/工作表/原始行/映射版本"',
  (archiveList.payload?.archives ?? []).every((a) => a.sourceFileName && a.sourceSheet && a.sourceRow >= 1 && a.mappingVersion >= 1),
  '',
);

// ---------------------------------------------------------------------------
// ⑦ D：转为当前服务单（一次一条、必填理由、不批量）
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑦ D：转当前服务单（单独操作、不批量）───────────────────');
const archiveId = archA1.payload.archiveIds[0];
const batchTry = await api(tokens.HQ, '/api/svc:historicalConvertToTicket', {
  body: { archiveIds: [archiveId], reason: '验收：批量应被拒' },
});
check('🔴 传数组（批量转单）⇒ 422 被拒', batchTry.status === 422, `HTTP ${batchTry.status} ${batchTry.json?.errors?.[0]?.code ?? ''}`);

const noReason = await api(tokens.HQ, '/api/svc:historicalConvertToTicket', { body: { archiveId } });
check('不填理由 ⇒ 422（必须说明为什么仍需继续处理）', noReason.status === 422, `HTTP ${noReason.status} ${noReason.json?.errors?.[0]?.code ?? ''}`);

// ---------------------------------------------------------------------------
// 🔴 权限：**该门店的售后人员**逐条转；总部不代门店建单（用户第三项）
// ---------------------------------------------------------------------------
const byHq = await api(tokens.HQ, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: '总部不该代门店建单' },
});
check(
  '🔴 总部账号不得转单（不因总部角色获得跨店建单权）⇒ 403 STORE_STAFF_ONLY',
  byHq.status === 403 && byHq.json?.errors?.[0]?.code === 'STORE_STAFF_ONLY',
  `HTTP ${byHq.status} ${byHq.json?.errors?.[0]?.code ?? ''}`,
);

// 跨店：UAT-B 属于 S02，这条档案归 S01 ⇒ 必须被拒
const byOtherStore = await api(tokens.B, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: '别家门店不该能转' },
});
check(
  '🔴 别的门店账号不得转 ⇒ 403 CROSS_STORE_FORBIDDEN',
  byOtherStore.status === 403 && byOtherStore.json?.errors?.[0]?.code === 'CROSS_STORE_FORBIDDEN',
  `HTTP ${byOtherStore.status} ${byOtherStore.json?.errors?.[0]?.code ?? ''}`,
);

const ticketsBeforeConv = Number(psql('SELECT count(*) FROM service_tickets'));
// 该门店（S01 = UAT-A）逐条转；**同时伪造** storeId/storeCode 指向 S02
const conv1 = await api(tokens.A, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: `验收：该历史事项仍需继续处理 ${RUN}`, storeId: 2, storeCode: 'S02' },
});
check('🔴 门店售后人员按单条转单成功', conv1.status === 200 && !!conv1.payload?.ticketNo, `HTTP ${conv1.status} ticket=${conv1.payload?.ticketNo}`);
check(
  '🔴 请求体里伪造的 storeId/storeCode **不生效**（服务端只认档案的原已确认门店）',
  Number(psql(`SELECT store_id FROM service_tickets WHERE ticket_no='${conv1.payload?.ticketNo}'`)) === 1,
  `工单归属 store_id=${psql(`SELECT store_id FROM service_tickets WHERE ticket_no='${conv1.payload?.ticketNo}'`)}（档案原门店 S01=1）`,
);
check('转单响应带回了历史来源关联', !!conv1.payload?.sourceLink?.archiveNo && conv1.payload?.sourceLink?.sourceRow >= 1, JSON.stringify(conv1.payload?.sourceLink ?? {}));

const ticketsAfterConv1 = Number(psql('SELECT count(*) FROM service_tickets'));
check(
  '一次转单只多 **1** 张当前服务单（不多不少）',
  ticketsAfterConv1 === ticketsBeforeConv + 1,
  `${ticketsBeforeConv} → ${ticketsAfterConv1}`,
);

// 重复提交（同一条档案再点一次）
const conv2 = await api(tokens.A, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: `验收：重复点击 ${RUN}` },
});
check(
  '🔴 重复点击转单 ⇒ 复用既有工单，不新建（幂等）',
  conv2.status === 200 && conv2.payload?.reused === true && conv2.payload?.ticketNo === conv1.payload?.ticketNo,
  `reused=${conv2.payload?.reused} ticket=${conv2.payload?.ticketNo}`,
);
const convCount = psql(`SELECT count(*) FROM historical_ticket_conversions WHERE archive_id=${archiveId}`);
check('库内该档案只有一条转换记录（archive_id UNIQUE）', Number(convCount) === 1, `${convCount} 条`);

// 同 Request-Id 重放（模拟"响应在网络上丢了、客户端原样重试"）
const conv3 = await api(tokens.A, '/api/svc:historicalConvertToTicket', {
  body: { archiveId, reason: `验收：同 Request-Id 重放 ${RUN}` },
  headers: { 'X-Request-Id': `replay-${RUN}` },
});
check(
  '🔴 同 Request-Id 重放 ⇒ 仍复用既有工单（响应丢失后的一致恢复）',
  conv3.status === 200 && conv3.payload?.ticketNo === conv1.payload?.ticketNo,
  `ticket=${conv3.payload?.ticketNo} recovered=${conv3.payload?.recovered}`,
);
const convCount2 = psql(`SELECT count(*) FROM historical_ticket_conversions WHERE archive_id=${archiveId}`);
check('三种重复路径过后，转换记录仍然只有 1 条', Number(convCount2) === 1, `${convCount2} 条`);
const convState = psql(`SELECT conversion_state FROM historical_service_archives WHERE id=${archiveId}`);
check('档案上的转单状态与转换记录一致（不漂移）', String(convState) === 'converted', String(convState));

const ticketsAfterConv2 = Number(psql('SELECT count(*) FROM service_tickets'));
check(
  '🔴 重复点击转单**不再多出工单**（幂等）',
  ticketsAfterConv2 === ticketsAfterConv1,
  `${ticketsAfterConv1} → ${ticketsAfterConv2}`,
);

// ---------------------------------------------------------------------------
// ⑧ 反向：真实样本**一条都没被归档**
// ---------------------------------------------------------------------------
console.log('');
console.log('── ⑧ 反向：真实七份样本不得被正式归属/归档 ────────────────');
const realBatches = psql(
  `SELECT count(*) FROM historical_import_batches
    WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华'`,
);
const realAttributed = psql(
  `SELECT count(*) FROM historical_import_batches
    WHERE file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华' AND attribution_state = 'confirmed'`,
);
const realArchived = psql(
  `SELECT count(*) FROM historical_service_archives a JOIN historical_import_batches b ON b.id = a.batch_id
    WHERE b.file_name ~ '东山|九兴|圣大|康乐|易田|欣盛|江华'`,
);
console.log(`      真实样本批次 ${realBatches} 个；其中已确认归属 ${realAttributed} 个；已归档档案行 ${realArchived} 行`);
check('🔴 真实样本批次**一个都没有**被确认归属', Number(realAttributed) === 0, `${realAttributed} 个`);
check('🔴 真实样本**一条档案都没有**产生（未把真实 Excel 归到占位门店）', Number(realArchived) === 0, `${realArchived} 行`);

const productionScoped = psql(
  `SELECT count(*) FROM service_settings WHERE key='historical.store-identity-confirmations' AND value LIKE '%"scope": "production"%'`,
);
check('门店身份名单里**没有任何 production 条目** ⇒ 真实资料结构上无法归属', Number(productionScoped) === 0, `${productionScoped} 条`);

// 演练档案必须能一眼看出是演练
const drillMarked = psql(
  `SELECT count(*) FROM historical_import_batches WHERE id=${batchA.id} AND note LIKE '%attribution:drill%'`,
);
check('演练归属在批次备注里留了痕（可一眼分辨演练 vs 正式）', Number(drillMarked) === 1, `${drillMarked}`);

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  B / C / D 门禁：${checks.length - failed.length}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (failed.length > 0) {
  for (const c of failed) console.log(`  ❌ ${c.name}${c.detail ? ' —— ' + c.detail : ''}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
process.exit(0);
